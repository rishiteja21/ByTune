/** ByTune desktop — Electron main process. */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from "electron";
import { pathToFileURL } from "url";
import * as fs from "fs";
import * as path from "path";
import * as downloads from "./downloads";
import * as canvas from "./canvas";
import * as music from "./music-service";
import { backupExport, backupImport } from "./backup";
import * as locallib from "./local-library";
import * as persist from "./persist";
import * as pip from "./pip";
import * as stats from "./stats";
import { proxyUrlFor, proxyUrlForLocalTrack, startStreamProxy } from "./stream-proxy";
import * as auth from "./supabase";
import * as sync from "./sync";
import * as transition from "./data-transition";
import type { Track } from "../src/types";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Covers extracted from local files are served to the renderer over this
// scheme; registered privileged so <img> can use it everywhere.
protocol.registerSchemesAsPrivileged([
  { scheme: "localart", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Library internals (BotGuard VM, parser JIT) can throw asynchronously;
// log and keep the app alive instead of dying.
process.on("uncaughtException", (err) => {
  console.error("[bytune] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[bytune] unhandled rejection:", reason);
});

let mainWindow: BrowserWindow | null = null;
/** before-quit can fire twice (window close → quit); the drain must run once. */
let drainStarted = false;

function iconPath(): string | undefined {
  const p = path.join(app.getAppPath(), "build", "icon.png");
  return fs.existsSync(p) ? p : undefined;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#0a0a0a",
    title: "ByTune",
    show: false,
    autoHideMenuBar: true,
    // Frameless look, native behaviour: the renderer's top bar is a drag
    // surface (move + double-click-maximize), while Windows draws its own
    // caption buttons top-right — so the snap-layout flyout still works.
    titleBarStyle: "hidden",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    // Open maximized by default.
    if (!mainWindow?.isMaximized()) mainWindow?.maximize();
    mainWindow?.show();
  });

  // Keep the renderer's maximize/restore button icon in sync.
  const sendMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
    }
  };
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);

  // Keyboard shortcuts live in the renderer (a window keydown listener). A
  // focused WINDOW alone isn't enough: after alt-tabbing back the webContents
  // itself can hold no keyboard focus — the last click inside may have been on
  // the drag-region title bar — and shortcuts then do nothing until a click
  // refocuses the page. Re-focus the page whenever the window becomes active:
  // Space works immediately (Spotify-style), and never fires for another app
  // because the renderer only receives keys while this window is focused.
  // In-page focus (search field, inputs) is unaffected by webContents.focus().
  mainWindow.on("focus", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
  });

  // Mirror native fullscreen to the renderer: F11 is handled here, while the
  // cinematic view (NowPlaying) drives it over IPC — the renderer tracks the
  // state either way (Escape leaves it; NowPlaying closes if it goes away).
  // NB: the value comes from the event itself, never from isFullScreen():
  // on Windows the flag is still stale while these fire, so reading it here
  // reports the state being left, not the one being entered.
  const sendFullScreen = (fs: boolean): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:fullscreen", fs);
    }
  };
  mainWindow.on("enter-full-screen", () => sendFullScreen(true));
  mainWindow.on("leave-full-screen", () => sendFullScreen(false));

  pip.restrictNavigation(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Keep explicit web links in the system browser, never in a privileged window.
    try {
      const target = new URL(url);
      if (target.protocol === "http:" || target.protocol === "https:") {
        void shell.openExternal(target.href).catch((err) => console.warn("[bytune] external browser unavailable:", err.message));
      }
    } catch { /* malformed URL */ }
    return { action: "deny" };
  });
  void mainWindow.loadURL(pip.rendererUrl());

  mainWindow.webContents.on("before-input-event", (event, input) => {
    // DevTools are a development convenience, not a shipping feature.
    if (isDev && input.type === "keyDown" && input.key === "F12") {
      mainWindow?.webContents.toggleDevTools();
    }
    // Chrome-style F11: toggle plain OS fullscreen (window covers the screen,
    // taskbar hidden). Swallowed before it reaches the page — it must work
    // with a text field focused, and the renderer follows via the
    // enter/leave-full-screen events above, not the key itself.
    if (input.type === "keyDown" && input.key === "F11") {
      event.preventDefault();
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // The miniplayer floats above other apps but is not a stand-alone app:
    // closing the main window takes the native PiP with it (and quits).
    pip.closePip();
  });
}

/** googlevideo rejects media requests that carry a foreign Referer/Origin. */
function stripMediaReferer(): void {
  const cleanUA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["*://*.googlevideo.com/*", "*://*/*videoplayback*"] },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      delete requestHeaders["Referer"];
      delete requestHeaders["Origin"];
      // A clean browser UA — Electron's own UA can get flagged.
      requestHeaders["User-Agent"] = cleanUA;
      callback({ requestHeaders });
    }
  );
  session.defaultSession.webRequest.onCompleted(
    { urls: ["*://*.googlevideo.com/*", "*://*/*videoplayback*"] },
    (details) => {
      if (details.statusCode >= 400) {
        console.warn(
          `[bytune] media request failed: HTTP ${details.statusCode} ${details.error ?? ""} ${details.url.slice(0, 110)}`
        );
      }
    }
  );
}

// Exact names used by renderer persistence; internal stores are main-only.
const RENDERER_STORES = new Set(["settings", "library", "player", "recent-searches", "listening-signals", "artist-meta-cache"]);
function assertRendererStore(name: unknown): asserts name is string {
  if (typeof name !== "string" || !RENDERER_STORES.has(name)) throw new Error("Store not allowed");
}

function registerIpc(): void {
  // Every main-window channel goes through this boundary, including fire-and-forget events.
  const ipc = {
    handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
      ipcMain.handle(channel, (event, ...args) => {
        if (!pip.isTrustedSender(event, mainWindow)) throw new Error("Untrusted IPC sender");
        return listener(event, ...args);
      });
    },
    on(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void {
      ipcMain.on(channel, (event, ...args) => {
        if (pip.isTrustedSender(event, mainWindow)) listener(event, ...args);
      });
    },
  };
  pip.registerPipIpc();
  ipc.handle("music:search", (_e, query: string, light?: boolean) => music.searchAll(query, light === true));
  ipc.handle("music:searchPage", (_e, query: string, filter: music.SearchFilter) =>
    music.searchPage(String(query ?? ""), filter as music.SearchFilter)
  );
  ipc.handle("music:searchMore", (_e, token: string, filter: music.SearchFilter) =>
    music.searchMore(String(token ?? ""), filter as music.SearchFilter)
  );
  ipc.handle("music:suggestions", (_e, query: string) => music.getSuggestions(query));
  ipc.handle("music:artist", (_e, id: string) => music.getArtistPage(id));
  ipc.handle("music:album", (_e, id: string) => music.getAlbum(id));
  ipc.handle("music:playlist", (_e, id: string) => music.getPlaylist(id));
  ipc.handle("music:playlistPage", (_e, id: string) => music.getPlaylistPage(String(id ?? "")));
  ipc.handle("music:home", () => music.getHome());
  ipc.handle("music:lyrics", (_e, meta: music.LyricsMeta) => music.getLyrics(meta));
  ipc.handle("music:enrich", (_e, ids: string[]) => music.enrichDurations(Array.isArray(ids) ? ids : []));
  ipc.handle("music:stream", async (_e, id: string, forceRotate?: boolean, quality?: string) => {
    // Hand the renderer a localhost proxy URL — the main process does the
    // actual upstream traffic (see stream-proxy.ts). YouTube Music is the
    // only catalogue: every id here is a bare YouTube video id.
    //
    // Quality mapping mirrors mobile's YouTube path (StreamResolver.rankByQuality):
    // only LOW carries a real bitrate ceiling (64 kbps); medium/high/lossless
    // differ on mobile by which *sources* may answer, which is meaningless
    // with a single source — they all resolve the best available rendition.
    await startStreamProxy();
    const maxKbps = quality === "low" ? 64 : undefined;
    return proxyUrlFor(String(id ?? ""), forceRotate === true, maxKbps);
  });

  ipc.handle("library:get", () => locallib.readLocalLibrary());
  ipc.handle("library:scan", async (_e, filterNonMusic?: boolean) => locallib.scanLibrary(filterNonMusic !== false));
  ipc.handle("library:setFolders", async (_e, folders: string[]) => {
    const clean = approvedFolderInputs(folders, 8);
    return locallib.setLibraryFolders(clean);
  });
  ipc.handle("library:addFolders", async (_e, paths: string[]) => {
    // Same gate as setFolders: only directories already approved through the
    // native picker (app:pickFolder approves before returning) may enter the
    // local library. The renderer must not be able to mint approvals itself.
    const clean = approvedFolderInputs(Array.isArray(paths) ? paths.slice(0, 8) : [], 8);
    const res = await locallib.addLibraryFolders(clean);
    for (const f of res.added) approveDir(f.path);
    return res;
  });
  ipc.handle("library:renameFolder", (_e, folderPath: string, displayName: string) =>
    locallib.renameLibraryFolder(String(folderPath ?? ""), displayName)
  );
  ipc.handle("library:removeFolder", (_e, folderPath: string) =>
    locallib.removeLibraryFolder(String(folderPath ?? ""))
  );
  ipc.handle("library:folderStatuses", () => locallib.folderStatuses());
  ipc.handle("library:trackurl", (_e, id: string) => {
    const p = locallib.localStreamPath(String(id ?? ""));
    if (!p) return null;
    // Serve over the stream proxy — Chromium blocks file:// media when the
    // renderer runs on an http origin (dev server / packaged build).
    return proxyUrlForLocalTrack(String(id)) ?? pathToFileURL(p).toString();
  });
  ipc.handle("library:artbytes", (_e, thumb: string) => {
    // Raw cover bytes for the palette extractors: Chromium blocks CORS-mode
    // loads (and fetch) to the custom localart:// scheme at the scheme level,
    // so canvas pixel reads can never go through the URL. The renderer turns
    // these bytes into a same-origin blob URL instead — no CORS involved.
    const art = locallib.readLocalArtThumb(String(thumb ?? ""));
    return art ? art.data : null;
  });

  ipc.handle("canvas:get", (_e, q: { title?: string; artist?: string; album?: string }) =>
    canvas.canvasFor(String(q?.title ?? ""), String(q?.artist ?? ""), q?.album ? String(q.album) : undefined)
  );

  // Listening telemetry: one fire-and-forget channel feeding stats.
  ipc.on(
    "playback:event",
    (_e, ev: { type: string; track?: Track; positionSec?: number; playedSec?: number; deltaMs?: number }) => {
      // A new listen re-arms the one-play rule (replays count, loops don't).
      if (ev.type === "start" && ev.track?.id) stats.noteTrackStart(ev.track.id);
      if ((ev.type === "progress" || ev.type === "stop" || ev.type === "pause") && ev.track && (ev.deltaMs ?? 0) > 0) {
        stats.recordListening(ev.track, ev.deltaMs as number);
      }
    }
  );
  ipc.handle("stats:summary", (_e, period: string) => {
    const p = (["month", "lastMonth", "year", "all"] as const).find((x) => x === period) ?? "month";
    return stats.summary(p);
  });

  // Window controls — the renderer draws the frameless window's chrome.
  ipc.on("window:minimize", () => mainWindow?.minimize());
  ipc.on("window:maximizeToggle", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipc.on("window:close", () => mainWindow?.close());
  ipc.handle("window:isMaximized", () => !!mainWindow?.isMaximized());
  // Windows-only: hide/restore the native caption-button strip while the
  // immersive Now Playing view is open (Spotify hides its chrome there too).
  // There is no supported visibility toggle, so we try to wash the overlay out
  // (transparent colours, zero height); if the OS clamps that, the renderer
  // falls back to real OS fullscreen, where Windows drops the buttons itself.
  ipc.handle("window:setOverlayChrome", (_e, visible: boolean) => {
    if (!mainWindow || process.platform !== "win32") return "unsupported";
    try {
      mainWindow.setTitleBarOverlay(
        visible
          ? { color: "#000000", symbolColor: "#ffffff", height: 56 }
          : { color: "#00000000", symbolColor: "#00000000", height: 0 }
      );
      return "ok";
    } catch (err) {
      console.warn("[bytune] setTitleBarOverlay failed:", err);
      return "failed";
    }
  });
  ipc.handle("window:setFullScreen", (_e, fs: boolean) => {
    mainWindow?.setFullScreen(fs === true);
    return true;
  });

  ipc.handle("data:scope", () => transition.serializeData(async () => transition.documentScope()));
  ipc.handle("data:read", (_e, name: string, scope: string) => {
    assertRendererStore(name);
    return transition.serializeData(async () => transition.readForDocument(name, scope));
  });
  ipc.handle("data:write", (_e, name: string, data: unknown, scope: string) => transition.serializeData(async () => {
    assertRendererStore(name);
    if (await transition.writeForDocument(name, data, scope)) sync.noteLocalWrite(String(name ?? ""));
  }));
  ipc.handle("app:resetData", () => transition.serializeData(async () => {
    guestUpgradeIntent = false;
    transition.invalidateResetDocuments();
    sync.resetSyncState();
    await auth.signOut();
    stats.resetStats();
    await Promise.all([downloads.resetDownloads(), locallib.resetLocalLibrary()]);
    await persist.resetAppData();
    // Approvals live in memory too — drop them and re-approve the default
    // download location, or post-reset downloads would be rejected.
    approvedDirs.clear();
    try {
      approveDir(await downloads.defaultDownloadDir());
    } catch {
      /* approved lazily on next download */
    }
  }));

  ipc.handle("app:defaultDownloadDir", () => downloads.defaultDownloadDir());
  ipc.handle("app:pickFolder", async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Choose download folder",
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    if (dir) approveDir(dir);
    return dir;
  });
  ipc.handle("app:revealPath", (_e, p: string) => {
    if (p && isApprovedPath(p)) shell.showItemInFolder(p);
  });
  ipc.handle("app:openPath", (_e, p: string) => {
    if (p && isApprovedPath(p)) return shell.openPath(p);
    return "Not allowed";
  });

  ipc.handle("download:start", async (_e, track: Track, dir?: string, quality?: string, exportCompat?: boolean) => {
    if (dir && !isApprovedPath(dir)) throw new Error("Download folder not approved");
    if (exportCompat === true) approveDir(downloads.exportDownloadDir());
    const caps: Record<string, number | undefined> = { standard: 128, high: 192, lossless: undefined };
    return downloads.enqueueDownload(track, dir, quality ? caps[quality] : undefined, exportCompat === true);
  });
  ipc.handle("download:cancel", (_e, id: string) => downloads.cancelDownload(String(id ?? "")));
  ipc.handle("download:queue", () => downloads.queueSnapshot());
  downloads.addDownloadListener((e) => {
    try {
      mainWindow?.webContents.send("download:event", e);
    } catch {
      /* window gone */
    }
  });

  ipc.handle("backup:export", () => backupExport(mainWindow));
  ipc.handle("backup:import", () => backupImport(mainWindow));

  // ---- Accounts (Supabase) + cloud backup ----
  const emitAuthChanged = (): void => {
    try {
      mainWindow?.webContents.send("auth:changed", auth.sessionInfo());
    } catch {
      /* window gone */
    }
  };
  ipc.handle("auth:getSession", () => auth.sessionInfo());
  // ---- Accounts (Supabase) + cloud backup ----
  // One-shot in-memory "guest wants to upgrade" flag: set only by the
  // clearGuestProfile handler when a real guest marker existed, consumed by
  // the next sign-in's migration decision, cleared on reset/sign-out/guest
  // continuation, and retained across a failed sign-in so a retry migrates.
  let guestUpgradeIntent = false;
  const signIn = (authenticate: () => Promise<auth.SessionInfo>) => transition.serializeData(async () => {
    await persist.drainWrites();
    const previous = transition.currentOwner();
    const migrateGuest = previous === "guest" && (guestUpgradeIntent || auth.readProfile()?.mode === "guest");
    const info = await authenticate().catch((err) => {
      // A failed sign-in must keep the intent so an immediate retry migrates.
      return Promise.reject(err);
    });
    guestUpgradeIntent = false;
    await transition.changeOwner(info.userId ?? "guest", migrateGuest);
    if (previous !== info.userId) sync.resetSyncState(info.userId ?? undefined);
    await sync.syncNowExclusive().catch((err) => console.warn("[bytune] login restore pending:", err));
    mainWindow?.webContents.reload();
    return info;
  });
  ipc.handle("auth:signUp", (_e, username: string, password: string) => signIn(() => auth.signUp(username, password)));
  ipc.handle("auth:signIn", (_e, username: string, password: string) => signIn(() => auth.signIn(username, password)));
  ipc.handle("auth:signInGoogle", () => signIn(() => auth.signInGoogle()));
  ipc.handle("auth:continueGuest", () => transition.serializeData(async () => {
    guestUpgradeIntent = false;
    await transition.changeOwner("guest", false);
    sync.resetSyncState();
    const info = await auth.continueAsGuest();
    mainWindow?.webContents.reload();
    return info;
  }));
  ipc.handle("auth:clearGuestProfile", async () => {
    // Real guest marker only — never a post-logout marker with no guest data.
    if (auth.readProfile()?.mode === "guest") guestUpgradeIntent = true;
    await auth.clearGuestProfile();
  });
  ipc.handle("auth:usernameAvailable", async (_e, username: string) => {
    const problem = auth.validateUsername(String(username ?? ""));
    if (problem) return { available: false, reason: problem };
    try {
      // Rename-aware: a signed-in user's own current name counts as free.
      return { available: await auth.usernameAvailableToUser(String(username), auth.sessionInfo().userId) };
    } catch (err) {
      // Lookup failure is NOT "taken" — offline must not brick the form.
      // `available: null` reads as "unknown" in the renderer: no Taken label,
      // still submittable; the database UNIQUE constraint stays the authority
      // and signUp surfaces a taken name as a normal, retryable error.
      return { available: null, reason: err instanceof Error ? err.message : "Network error" };
    }
  });
  ipc.handle("auth:setUsername", (_e, username: string) => auth.setUsername(username));
  ipc.handle("auth:skipUsername", () => auth.skipUsernameClaim());
  ipc.handle("auth:signOut", () => transition.serializeData(async () => {
    guestUpgradeIntent = false;
    await persist.drainWrites();
    await sync.syncNowExclusive().catch((err) => console.warn("[bytune] logout backup pending:", err));
    const info = await auth.signOut();
    await transition.changeOwner("guest", false);
    sync.resetSyncState();
    mainWindow?.webContents.reload();
    return info;
  }));
  ipc.handle("sync:status", () => sync.syncStatus());
  ipc.handle("sync:now", () => sync.syncNow());
  ipc.handle("sync:backupNow", () => sync.backupNow());
  ipc.handle("sync:restoreNow", () => sync.restoreNow());
}

/**
 * Filesystem allowlist: the renderer may only open/reveal/download inside
 * directories the user explicitly chose (native dialog or default downloads
 * location), plus the app's own data. A compromised renderer can't use these
 * IPC channels to launch arbitrary files.
 */
const approvedDirs = new Set<string>();
function approvedFolderInputs(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid folder list");
  return value.map((dir) => {
    if (typeof dir !== "string" || !dir.trim() || !isApprovedPath(dir)) throw new Error("Folder not approved");
    return path.resolve(dir);
  });
}
function approveDir(dir: string): void {
  const resolved = path.resolve(dir);
  if (approvedDirs.has(resolved)) return;
  approvedDirs.add(resolved);
  // Persist so a folder the user once picked survives restarts - otherwise a
  // custom download location would be silently rejected after a restart.
  const stored = (persist.readData("approved-dirs") as string[] | null) ?? [];
  if (!stored.includes(resolved)) void persist.writeData("approved-dirs", [...stored, resolved]);
}
function isApprovedPath(p: string): boolean {
  const resolved = path.resolve(String(p ?? ""));
  // Separator guard: `...\ByTune` must not approve a sibling such as
  // `...\ByTuneX` that merely shares the prefix.
  const userData = app.getPath("userData");
  if (resolved === userData || resolved.startsWith(userData + path.sep)) return true;
  for (const dir of approvedDirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

const gotLock =
  process.env.BYTUNE_ALLOW_MULTI === "1" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let oauthReady = false;
  let pendingOAuthUrl: string | undefined;
  const oauthFromUrl = (url: string): void => {
    if (!oauthReady) {
      pendingOAuthUrl = url;
      return;
    }
    void auth.handleOAuthCallback(url).catch((err) => console.warn("[bytune] oauth callback:", err.message));
  };
  const bootUrl = process.argv.find((a) => a.startsWith("bytune://"));
  if (bootUrl) oauthFromUrl(bootUrl);
  app.on("open-url", (event, url) => {
    event.preventDefault();
    oauthFromUrl(url);
  });
  app.on("second-instance", (_event, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const url = argv.find((a) => a.startsWith("bytune://"));
    if (url) oauthFromUrl(url);
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    persist.migrateLegacyData();
    transition.initializeOwner();
    stats.initStats();
    pip.bindMainWindowGetter(() => mainWindow);
    auth.registerProtocol();
    auth.initInstallMarker();
    sync.bindClient(auth.getClient);
    sync.bindRestoredNotifier((stores, seq) => {
      try {
        mainWindow?.webContents.send("sync:restored", { stores, seq });
      } catch {
        /* window gone */
      }
    });
    void auth.initAuth().then(() => {
      // Signed-in session restored from the sealed token — back up now and
      // pull anything newer (covers offline edits made while signed out of
      // the network, not the guest flow, which never syncs).
      if (auth.sessionInfo().mode === "account") void sync.syncNow().catch(() => undefined);
    });
    void downloads.defaultDownloadDir().then(approveDir);
    try {
      approveDir(downloads.exportDownloadDir());
    } catch {
      /* music library path may be unavailable; approved lazily on download */
    }
    const lib = locallib.readLocalLibrary();
    for (const f of lib.folders) approveDir(f.path);
    for (const d of (persist.readData("approved-dirs") as string[] | null) ?? []) {
      if (typeof d === "string") approvedDirs.add(path.resolve(d));
    }

    protocol.handle("localart", (req) => {
      // For localart://<hash>.<ext> the filename lands in `hostname` and
      // `pathname` is "/" — stitch them and trim the dangling separator or
      // the art-name regex below rejects every request. A malformed percent
      // sequence must 404, not throw out of the handler.
      let name: string;
      try {
        const u = new URL(req.url);
        name = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+|\/+$/g, "");
      } catch {
        return new Response("not found", { status: 404 });
      }
      const art = locallib.readArtFile(name);
      if (!art) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(art.data), { headers: { "Content-Type": art.mime } });
    });
    app.on("before-quit", (event) => {
      stats.flushSync();
      pip.savePipRect();
      // Kick off a final push, then persist sync-meta synchronously: quit
      // cannot await the push, but the meta must record any un-synced local
      // edits (changedAt > syncedAt) so the next boot pushes them instead of
      // letting the pull comparison overwrite them with a stale cloud copy.
      void sync.flushPending();
      sync.flushMetaSync();
      // Close-time durability: the renderer's last coalesced writes and any
      // queued ownership work may still be in flight when the window dies.
      // Hold quit for a bounded drain — the final player write lands unless
      // something is genuinely stuck, in which case we quit anyway.
      if (!drainStarted) {
        drainStarted = true;
        event.preventDefault();
        const timeout = setTimeout(() => {
          console.warn("[bytune] shutdown drain timed out; quitting");
          app.exit(0);
        }, 3000).unref();
        transition
          .drainData()
          .then(() => persist.drainWrites())
          .catch((err) => console.warn("[bytune] shutdown drain failed:", err))
          .finally(() => {
            clearTimeout(timeout);
            app.exit(0);
          });
      }
    });
    oauthReady = true;
    if (pendingOAuthUrl) oauthFromUrl(pendingOAuthUrl);
    pendingOAuthUrl = undefined;
    stripMediaReferer();
    registerIpc();
    void startStreamProxy().catch((err) => console.warn("[bytune] stream proxy failed:", err));
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
