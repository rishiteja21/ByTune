/** ByTune desktop — Electron main process. */
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, powerMonitor, protocol, screen, session, shell, Tray } from "electron";
import type { NativeImage } from "electron";
import { pathToFileURL } from "url";
import * as fs from "fs";
import * as path from "path";
import * as downloads from "./downloads";
import * as downloaded from "./downloaded-files";
import { isKnownAudio, isPlayableAudio } from "./audio-types";
import * as canvas from "./canvas";
import * as music from "./music-service";
import { backupExport, backupImport } from "./backup";
import * as locallib from "./local-library";
import { remoteArtBytes } from "./remote-art";
import * as mediaControls from "./media-controls";
import * as persist from "./persist";
import * as pip from "./pip";
import * as rooms from "./rooms";
import * as spotify from "./spotify";
import { roomCodeIn } from "../src/lib/roomSync";
import { displayNameProblem, normalizeDisplayName } from "../src/lib/account-validators";
import * as stats from "./stats";
import { naturalScrolling } from "./scroll-direction";
import { proxyUrlFor, proxyUrlForLocalTrack, setDownloadedFileLookup, startStreamProxy } from "./stream-proxy";
import * as auth from "./supabase";
import * as sync from "./sync";
import * as updates from "./updater";
import * as transition from "./data-transition";
import { buildAppMenu, type MenuCommand, type MenuPlaybackState, type MenuWiring } from "./mac-menu";
import { buildTrayMenu, closeAction } from "./close-to-tray";
import { placeOnScreen, readWindowState } from "./window-state";
import { getWindowActivity, hideWindow, trackWindowActivity } from "./window-activity";
import type { Track } from "../src/types";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const isMac = process.platform === "darwin";

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
/**
 * Closing the main window hides it and keeps the app running: always on
 * macOS (still playing), and on Windows with "Close to tray" on (music
 * paused; close-to-tray.ts). The close button is not a quit. This flag marks
 * a REAL quit so the hide-on-close guard stands down.
 */
let quitting = false;
/** before-quit can fire twice (window close → quit); the drain must run once. */
let drainStarted = false;
/**
 * Set for the whole app:resetData span. The renderer keeps playing until its
 * reload lands, so listening events arriving in that window belong to the
 * pre-reset session — recording them would re-arm stats flushes that
 * re-create the buckets the reset just deleted (and quit would persist them).
 */
let dataResetActive = false;
/** A room invite link opened before the page took it (bytune://room/CODE). */
let pendingRoomInvite: string | null = null;

/**
 * Every way back to the main window (the tray, the Dock, a second launch, the
 * macOS menu, the miniplayer): the same window, its page still loaded, so the
 * launch intro doesn't play again. A new one only if it's gone, and never
 * while quitting or before the app is ready.
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady() && !quitting) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Settings' "Close to tray" (Windows; on unless turned off). Read
 * from the store's file when a close needs it: the renderer writes settings
 * through at once, so the file is current.
 */
function closeToTrayOn(): boolean {
  const saved = persist.readData("settings") as { state?: { closeToTray?: unknown } } | null;
  return saved?.state?.closeToTray !== false;
}

/**
 * The part of quitting that can't wait, in this order (before-quit, below).
 * It's also all there's time for when Windows ends the session (sign-out,
 * restart, shutdown): before-quit never comes then, and ByTune is often still
 * running in the tray. Runs once.
 */
function startExit(): void {
  if (quitting) return;
  // Mark the real quit BEFORE the drain: the hide-on-close guard must
  // stand down for any close events that fire during shutdown.
  quitting = true;
  // Out of the tray at once: app.exit() would leave the icon there until hovered.
  tray?.destroy();
  tray = null;
  mediaControls.stop();
  stats.flushSync();
  pip.savePipRect();
  // A download cut off by the quit leaves no partial file behind; it restarts from the Downloads list.
  downloads.abandonDownloads();
  // Say "left" to a room while the drain below holds the quit; if it doesn't arrive, the next start does.
  void rooms.leaveRoom().catch(() => undefined);
  // Kick off a final push, then persist sync-meta synchronously: quit
  // cannot await the push, but the meta must record any un-synced local
  // edits (changedAt > syncedAt) so the next boot pushes them instead of
  // letting the pull comparison overwrite them with a stale cloud copy.
  void sync.flushPending();
  sync.flushMetaSync();
}

function iconPath(): string | undefined {
  // Windows: give the window the multi-size .ico so the shell can pick
  // exact-size bitmaps for the taskbar button and preview thumbnails instead
  // of scaling a single raster. macOS keeps the .png (Dock setIcon).
  // Next to the bundled main process (dist-electron/../build, packaged too: the
  // build files ship), as the thumbbar icons are, rather than under
  // app.getAppPath(), which a test launch through scripts/ moves.
  const name = process.platform === "win32" ? "icon.ico" : "icon.png";
  const p = path.join(__dirname, "..", "build", name);
  return fs.existsSync(p) ? p : undefined;
}

/* ------------------------- macOS application menu ------------------------- */

/** Last playback state the renderer pushed; drives the menu checkmarks. */
let menuState: MenuPlaybackState = { playing: false, shuffle: false, repeat: "off" };

function menuWiring(): MenuWiring {
  return {
    sendCommand: (command): void => {
      // The main window may be hidden (macOS close-to-hide) but its renderer
      // stays alive — hidden-window commands keep working, which is the point.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("menu:command", command);
      }
    },
    backupExport: (): void => {
      void backupExport(mainWindow).catch((err) =>
        console.warn("[bytune] menu backup export failed:", err instanceof Error ? err.message : err)
      );
    },
    backupImport: (): void => {
      void backupImport(mainWindow).catch((err) =>
        console.warn("[bytune] menu backup import failed:", err instanceof Error ? err.message : err)
      );
    },
    showMainWindow,
    checkForUpdates: (): void => showUpdates(true),
  };
}

/** Settings › About in front, where an update shows (the Mac menu's Check for Updates, the update notification). */
function showUpdates(check: boolean): void {
  showMainWindow();
  menuWiring().sendCommand("updates");
  if (check) void updates.checkForUpdates(false);
}

/** (Re)build the macOS app menu from the current playback state. */
function applyMenu(): void {
  if (!isMac) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenu(menuState, menuWiring(), isDev)));
}

/* ------------------------ Windows taskbar thumbbar ------------------------ */

/**
 * Transport buttons on the taskbar preview (hover the taskbar icon):
 * previous · play/pause · next — the surface Spotify shows. Windows only
 * (setThumbarButtons wraps win32 ITaskbarList3; macOS has no taskbar). The
 * play/pause glyph follows the renderer's pushed playback state — the same
 * menu:push-state signal that drives the macOS menu checkmarks — so one
 * renderer push keeps both native surfaces truthful.
 */
const thumbarIcons = new Map<string, NativeImage>();

function thumbarIcon(name: "previous" | "play" | "pause" | "next"): NativeImage {
  let img = thumbarIcons.get(name);
  if (!img) {
    // 1x (16px) + 2x (32px) representations: high-DPI taskbars pick the
    // sharp copy instead of upscaling a blurry 16px bitmap.
    img = nativeImage.createEmpty();
    for (const [scale, file] of [
      [1, `${name}-16.png`],
      [2, `${name}-32.png`],
    ] as const) {
      const p = path.join(__dirname, "assets", "thumbar", file);
      if (fs.existsSync(p)) img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(p) });
    }
    thumbarIcons.set(name, img);
  }
  return img;
}

/** Returns true when the taskbar accepted the buttons (false = too early). */
function applyThumbar(): boolean {
  if (process.platform !== "win32") return true;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const command = (c: MenuCommand) => (): void => menuWiring().sendCommand(c);
  return mainWindow.setThumbarButtons([
    { icon: thumbarIcon("previous"), tooltip: "Previous", click: command("previous") },
    {
      icon: thumbarIcon(menuState.playing ? "pause" : "play"),
      tooltip: menuState.playing ? "Pause" : "Play",
      click: command("play-pause"),
    },
    { icon: thumbarIcon("next"), tooltip: "Next", click: command("next") },
  ]);
}

/* ------------------------------ Windows tray ------------------------------ */

/**
 * Windows: with "Close to tray" on, closing the main window hides it here
 * with the music paused, ByTune still running. A click brings back the same
 * window; the right-click menu (close-to-tray.ts) has the transport and Quit
 * ByTune, its Play or Pause following the same menu:push-state as the
 * thumbbar. Windows only, as in ZCode: macOS has the Dock.
 */
let tray: Tray | null = null;

function trayMenu(): Menu {
  return Menu.buildFromTemplate(
    buildTrayMenu(menuState, { sendCommand: menuWiring().sendCommand, showMainWindow, quit: () => app.quit() })
  );
}

function createTray(): void {
  if (process.platform !== "win32" || tray) return;
  const icon = iconPath();
  if (!icon) return;
  try {
    tray = new Tray(icon);
  } catch (err) {
    // No icon, nothing to hide into: closing the window quits instead (closeAction).
    console.warn("[bytune] tray icon unavailable:", err instanceof Error ? err.message : err);
    return;
  }
  tray.setToolTip("ByTune");
  tray.setContextMenu(trayMenu());
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function applyTray(): void {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(trayMenu());
}

// The window's own ground: what the page paints, and what shows before it does.
const WINDOW_BG = "#0a0a0a";

// Windows 11 glass under the launch intro, as in ZCode: the intro (index.html) opens over the blurred
// desktop, then darkens into the app. Only while it plays: once it has (window:introDone, as the app is
// drawn under it) the window is solid again, so the hand-over composites as an opaque window and the opaque
// app never shows the material at its edges while it resizes. A reload replays the intro, so it brings the
// glass back. Older Windows has no acrylic and opens dark.
function setGlass(on: boolean): void {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (on) {
      mainWindow.setBackgroundColor("#00000000");
      mainWindow.setBackgroundMaterial("acrylic");
    } else {
      mainWindow.setBackgroundMaterial("none");
      mainWindow.setBackgroundColor(WINDOW_BG);
    }
  } catch (err) {
    console.warn("[bytune] window glass:", err);
  }
}

/*
 * The main window reopens the way it was closed (#11, electron/window-state.ts): saved 400 ms after a move,
 * resize or (un)maximize, and at once on close, a hide to the tray or the Dock included.
 */
let windowStateTimer: ReturnType<typeof setTimeout> | null = null;

function saveWindowState(): void {
  if (windowStateTimer) {
    clearTimeout(windowStateTimer);
    windowStateTimer = null;
  }
  const win = mainWindow;
  // Minimized or fullscreen isn't how it should reopen, and Windows reports a minimized window as not
  // maximized: keep the state saved before.
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    persist.writeDataSync("window-state", { ...win.getNormalBounds(), maximized: win.isMaximized() });
  } catch (err) {
    console.warn("[bytune] window-state save failed:", err);
  }
}

function saveWindowStateSoon(): void {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(saveWindowState, 400);
}

function createWindow(): void {
  const saved = readWindowState(persist.readData("window-state"));
  const place = saved && placeOnScreen(saved, screen.getAllDisplays().map((d) => d.workArea));
  mainWindow = new BrowserWindow({
    ...(place ?? { width: 1280, height: 820 }),
    minWidth: 1000,
    minHeight: 640,
    ...(process.platform === "win32"
      ? { backgroundColor: "#00000000", backgroundMaterial: "acrylic" as const }
      : { backgroundColor: WINDOW_BG }),
    title: "ByTune",
    show: false,
    autoHideMenuBar: true,
    // Frameless look, native behaviour. Windows: the renderer's top bar is a
    // drag surface (move + double-click-maximize) while Windows draws its own
    // caption buttons top-right — so the snap-layout flyout still works.
    // macOS: hiddenInset keeps the native traffic lights (top-left, inset
    // below the app menu bar) and the renderer leaves room for them instead
    // of drawing its own buttons.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac ? { trafficLightPosition: { x: 20, y: 28 }, zoomToPageWidth: true } : {}),
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Closed, the window is hidden (always on macOS, in the tray on
      // Windows) and can stay hidden for hours while music plays: on macOS
      // it plays on, and from the Windows tray the menu, the media keys or
      // the miniplayer can start it. Chromium throttles hidden-window timers
      // (fade curves, stats accumulation, lyric sync all run on JS timers),
      // so the main window must keep full timer resolution.
      backgroundThrottling: false,
    },
  });

  const activityWindow = mainWindow;
  trackWindowActivity(activityWindow, (event) => pip.isTrustedSender(event, activityWindow));

  mainWindow.once("ready-to-show", () => {
    // The first launch opens maximized on Windows and at a normal size on
    // macOS (Spotify's convention); after that, the way it was closed.
    if ((saved ? saved.maximized : !isMac) && !mainWindow?.isMaximized()) mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) setGlass(true);
  });

  // Windows taskbar thumbbar: the toolbar can only attach once the window
  // owns a taskbar button, i.e. once it's shown, and again each time it comes
  // back from the tray (hidden, it has no button, and its play/pause may have
  // gone stale meanwhile). If Windows still refuses (shell timing), retry
  // once — every later play/pause re-applies the bar anyway via
  // menu:push-state. Back from the tray it's also repainted twice, as ZCode
  // does (desktopWindowChrome.ts): a window made with acrylic can come back blank.
  if (process.platform === "win32") {
    const win = mainWindow;
    let shownBefore = false;
    win.on("show", () => {
      const ok = applyThumbar();
      if (isDev) console.log("[bytune] taskbar thumbbar:", ok ? "attached" : "deferred");
      if (!ok) setTimeout(applyThumbar, 1500);
      if (shownBefore) {
        for (const delay of [0, 32]) {
          setTimeout(() => {
            if (!win.isDestroyed()) win.webContents.invalidate();
          }, delay);
        }
      }
      shownBefore = true;
    });
  }

  // Keep the renderer's maximize/restore button icon in sync.
  const sendMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
    }
  };
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);
  mainWindow.on("resize", saveWindowStateSoon);
  mainWindow.on("move", saveWindowStateSoon);
  mainWindow.on("maximize", saveWindowStateSoon);
  mainWindow.on("unmaximize", saveWindowStateSoon);

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
  void mainWindow.loadURL(pip.rendererUrl()).catch((err) => {
    console.warn("[bytune] main window load failed:", err instanceof Error ? err.message : err);
  });

  // A crashed renderer left a blank window with the music stopped. Reload it,
  // but give up after a few crashes in a row (a crash on load would loop).
  let crashes = 0;
  let crashReset: NodeJS.Timeout | null = null;
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.warn(`[bytune] renderer gone (${details.reason}, exit ${details.exitCode})`);
    if (details.reason === "clean-exit" || !mainWindow || mainWindow.isDestroyed()) return;
    crashes += 1;
    if (crashReset) clearTimeout(crashReset);
    crashReset = setTimeout(() => (crashes = 0), 60_000);
    if (crashes > 3) return;
    void mainWindow.loadURL(pip.rendererUrl()).catch(() => undefined);
  });

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

  // Closing hides the window instead (close-to-tray.ts). macOS: the red close
  // button and Cmd+W, and the music plays on (Apple Music / Spotify
  // behaviour); the Dock brings it back via the activate handler. Windows,
  // with "Close to tray" on: the close button, Alt+F4 and the taskbar's Close
  // window put it in the tray with the music paused; the tray icon brings it
  // back. Only a real quit (Cmd+Q, Dock → Quit, the tray's Quit ByTune)
  // destroys it.
  mainWindow.on("close", (event) => {
    const win = mainWindow;
    if (!win) return;
    saveWindowState();
    const action = closeAction({
      platform: process.platform,
      quitting,
      fullScreen: win.isFullScreen(),
      closeToTray: process.platform === "win32" && closeToTrayOn(),
      trayShown: !!tray && !tray.isDestroyed(),
    });
    if (action === "close") return;
    event.preventDefault();
    if (action === "leave-fullscreen") {
      win.setFullScreen(false);
      return;
    }
    // The same pause as the player's own button (an absolute pause: never starts anything).
    if (action === "tray") menuWiring().sendCommand("pause");
    hideWindow(win);
  });

  // Windows sign-out, restart or shutdown: before-quit never comes, so save
  // what can be saved at once (startExit).
  mainWindow.on("session-end", startExit);

  mainWindow.on("closed", () => {
    mainWindow = null;
    // The miniplayer floats above other apps but is not a stand-alone app:
    // closing the main window for real (not hiding it) takes the native PiP
    // with it (and quits).
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
const RENDERER_STORES = new Set([
  "settings",
  "library",
  "player",
  "recent-searches",
  "listening-signals",
  "artist-meta-cache",
  "artist-bundle-cache",
  "artist-about-cache",
  "home-market-cache",
  "lyrics-nudges",
  "recent-items",
  "explore-covers",
  "listen-journal",
  "home-engagement",
]);
function assertRendererStore(name: unknown): asserts name is string {
  if (typeof name !== "string" || !RENDERER_STORES.has(name)) throw new Error("Store not allowed");
}

function registerIpc(): void {
  // This read-only channel is scoped to either registered window's own main frame.
  ipcMain.handle("window:activity:get", getWindowActivity);
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
  // The search field holds at most 200 characters; anything longer didn't come from it.
  ipc.handle("music:suggestions", (_e, query: unknown) =>
    typeof query === "string" && query.length <= 200 ? music.getSuggestions(query) : { items: [] }
  );
  ipc.handle("music:artist", (_e, id: string) => music.getArtistPage(id));
  ipc.handle("music:album", (_e, id: string) => music.getAlbum(id));
  ipc.handle("music:playlist", (_e, id: string) => music.getPlaylist(id));
  ipc.handle("music:playlistPage", (_e, id: string) => music.getPlaylistPage(String(id ?? "")));
  ipc.handle("music:home", () => music.getHome());
  ipc.handle("music:radio", (_e, id: unknown, token?: unknown) => {
    // Only a bare YouTube video id has a radio; local:/other ids are refused.
    const videoId = typeof id === "string" ? id : "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("No radio for this track");
    const next = typeof token === "string" && token.length > 0 && token.length <= 4096 ? token : undefined;
    return music.getRadio(videoId, next);
  });
  ipc.handle("music:charts", () => music.getCharts());
  ipc.handle("music:moods", () => music.getMoods());
  // Explore's categories (a card's covers, its page): only a moods page's own category browse.
  const moodArgs = (browseId: unknown, params: unknown): [string, string] => {
    if (browseId !== "FEmusic_moods_and_genres_category" || typeof params !== "string" || !/^[A-Za-z0-9_%=-]{1,300}$/.test(params)) {
      throw new Error("Not a mood page");
    }
    return [browseId, params];
  };
  ipc.handle("music:moodCovers", (_e, browseId: unknown, params: unknown) => music.getMoodCovers(...moodArgs(browseId, params)));
  ipc.handle("music:moodPage", (_e, browseId: unknown, params: unknown) => music.getMoodPage(...moodArgs(browseId, params)));
  ipc.handle("market:current", () => music.currentMarket());
  ipc.handle("music:lyrics", (_e, meta: music.LyricsMeta) => music.getLyrics(meta));
  ipc.handle("music:podcast", (_e, id: unknown) => {
    if (typeof id !== "string" || !/^MPSP[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("Not a podcast");
    return music.getPodcast(id);
  });
  ipc.handle("music:podcasts", () => music.getPodcasts());
  // Read-only: a local file's ReplayGain from its tags (volume leveling).
  ipc.handle("local:gainDb", (_e, id: unknown) =>
    typeof id === "string" && id.startsWith("local:") && id.length <= 200 ? music.localGainDb(id) : null
  );
  ipc.handle("music:enrich", (_e, ids: string[]) => music.enrichDurations(Array.isArray(ids) ? ids : []));
  ipc.handle("music:stream", async (_e, id: unknown, retry?: boolean, quality?: string) => {
    // Hand the renderer a localhost proxy URL — the main process does the
    // actual upstream traffic (see stream-proxy.ts). YouTube Music is the
    // only catalogue: every id here is a bare YouTube video id.
    //
    // Quality mapping mirrors mobile's YouTube path (StreamResolver.rankByQuality):
    // only LOW carries a real bitrate ceiling (64 kbps); medium/high/lossless
    // differ on mobile by which *sources* may answer, which is meaningless
    // with a single source — they all resolve the best available rendition.
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Invalid track id");
    await startStreamProxy();
    const maxKbps = quality === "low" ? 64 : undefined;
    // A retry after a playback error: a fresh resolution, from the next client.
    if (retry === true) music.retryStream(id);
    return proxyUrlFor(id, retry === true, maxKbps);
  });

  ipc.handle("library:get", () => locallib.readLocalLibrary());
  // Files dropped on the window. The preload reads their real paths (webUtils) itself, out of
  // the page's reach — a file the page makes up has no path — and only it calls this.
  ipc.handle("files:dropped", (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return;
    queueOpen(paths.filter((p): p is string => typeof p === "string" && p.length < 4096 && path.isAbsolute(p)).slice(0, 100));
  });
  ipc.handle("files:take", () => openedBatches.splice(0));
  ipc.handle("library:opened", () => locallib.openedFiles());
  ipc.handle("library:forgetOpened", (_e, id: unknown) =>
    typeof id === "string" && id.startsWith("local:") ? locallib.forgetOpenedFile(id) : locallib.openedFiles()
  );
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
  // The same for YouTube's thumbnail host (playlist covers, video thumbnails), which sends no CORS
  // header: shown fine, but their colours can't be read. That host only (electron/remote-art).
  ipc.handle("art:remoteBytes", (_e, url: unknown) => remoteArtBytes(typeof url === "string" ? url : ""));

  // Spotify (electron/spotify.ts): the session stays in main; the page only gets playlists and songs.
  // Rooms (electron/rooms.ts): Supabase stays here; the page gets the room's state.
  rooms.onRoomChange((view) => {
    try {
      mainWindow?.webContents.send("room:state", view);
    } catch {
      /* window gone */
    }
  });
  const uuid = (v: unknown): string => {
    if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error("Not a member");
    return v;
  };
  ipc.handle("room:current", () => rooms.roomView());
  ipc.handle("room:create", () => rooms.createRoom());
  ipc.handle("room:join", (_e, code: unknown) => {
    const c = typeof code === "string" && code.length <= 100 ? roomCodeIn(code) : null;
    if (!c) throw new Error("That isn't a room code.");
    return rooms.joinRoom(c);
  });
  ipc.handle("room:leave", () => rooms.leaveRoom());
  ipc.handle("room:update", (_e, change: unknown) => {
    const c = change as Record<string, unknown> | null;
    const ok =
      !!c && typeof c === "object" &&
      typeof c.baseSeq === "number" && Number.isSafeInteger(c.baseSeq) && c.baseSeq >= 0 &&
      (c.track === null || (typeof c.track === "object" && !Array.isArray(c.track))) &&
      typeof c.positionMs === "number" && Number.isFinite(c.positionMs) && c.positionMs >= 0 && c.positionMs <= 86_400_000 &&
      typeof c.playing === "boolean" && typeof c.lead === "boolean" &&
      Array.isArray(c.queue) && c.queue.length <= 200 &&
      typeof c.note === "string" && c.note.length <= 200;
    if (!ok) throw new Error("Not a room change");
    return rooms.updateRoom(c as unknown as Parameters<typeof rooms.updateRoom>[0]);
  });
  ipc.handle("room:hostOnly", (_e, on: unknown) => {
    if (typeof on !== "boolean") throw new Error("Not a setting");
    return rooms.setHostOnly(on);
  });
  ipc.handle("room:makeHost", (_e, userId: unknown) => rooms.makeHost(uuid(userId)));
  ipc.handle("room:remove", (_e, userId: unknown) => rooms.removeMember(uuid(userId)));
  // The listener's own queue, set aside while in a room: theirs, up to YouTube's playlist size.
  ipc.handle("room:stash", (_e, snapshot: unknown) => {
    const s = snapshot as { queue?: unknown } | null;
    if (!s || typeof s !== "object" || !Array.isArray(s.queue) || s.queue.length > 5000 || JSON.stringify(s).length > 5_000_000) {
      throw new Error("Not a queue");
    }
    return rooms.stash(s);
  });
  ipc.handle("room:unstash", () => rooms.unstash());
  ipc.handle("room:takeInvite", () => {
    const code = pendingRoomInvite;
    pendingRoomInvite = null;
    return code;
  });

  ipc.handle("spotify:status", () => spotify.spotifyStatus());
  ipc.handle("spotify:connect", () => spotify.connectSpotify(mainWindow));
  ipc.handle("spotify:disconnect", async () => {
    await spotify.disconnectSpotify();
    return spotify.spotifyStatus();
  });
  ipc.handle("spotify:playlists", () => spotify.spotifyPlaylists());
  ipc.handle("spotify:playlist", (_e, id: unknown) => {
    if (typeof id !== "string" || (id !== spotify.LIKED_ID && !/^[A-Za-z0-9]{22}$/.test(id))) throw new Error("Not a Spotify playlist");
    return spotify.spotifyPlaylist(id);
  });
  ipc.handle("spotify:publicPlaylist", (_e, link: unknown) => {
    if (typeof link !== "string" || link.length > 500) throw new Error("That isn't a link to a Spotify playlist.");
    return spotify.publicPlaylist(link);
  });
  ipc.handle("match:song", (_e, song: unknown, prefer: unknown) => {
    const s = song as Record<string, unknown> | null;
    const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
    if (!s || typeof s !== "object" || !text(s.title, 300) || !s.title.trim() || !text(s.artist, 300)) throw new Error("Not a song");
    const duration = typeof s.duration === "number" && Number.isFinite(s.duration) && s.duration > 0 && s.duration < 86_400 ? Math.round(s.duration) : 0;
    return spotify.matchSong(
      {
        title: s.title,
        artist: s.artist,
        duration,
        ...(text(s.album, 300) ? { album: s.album } : {}),
        ...(typeof s.spotifyId === "string" && /^[A-Za-z0-9]{22}$/.test(s.spotifyId) ? { spotifyId: s.spotifyId } : {}),
      },
      typeof prefer === "string" ? prefer : ""
    );
  });

  ipc.handle("canvas:get", (_e, q: { title?: string; artist?: string; album?: string }) =>
    canvas.canvasFor(String(q?.title ?? ""), String(q?.artist ?? ""), q?.album ? String(q.album) : undefined)
  );

  ipc.handle("updates:state", () => updates.updateState());
  ipc.handle("updates:check", () => updates.checkForUpdates(false));
  ipc.handle("updates:install", () => updates.installUpdate());
  ipc.handle("updates:restart", () => updates.restartToUpdate());

  // Listening telemetry: one fire-and-forget channel feeding stats.
  ipc.on(
    "playback:event",
    (_e, ev: { type: string; track?: Track; positionSec?: number; playedSec?: number; deltaMs?: number }) => {
      if (dataResetActive) return;
      // A new listen re-arms the one-play rule (replays count, loops don't).
      if (ev.type === "start" && ev.track?.id) stats.noteTrackStart(ev.track.id);
      // Podcast episodes never count in Replay.
      if ((ev.type === "progress" || ev.type === "stop" || ev.type === "pause") && ev.track && !ev.track.episode && (ev.deltaMs ?? 0) > 0) {
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
  ipc.on("window:introDone", (e) => {
    if (e.sender === mainWindow?.webContents) setGlass(false);
  });
  ipc.handle("window:isMaximized", () => !!mainWindow?.isMaximized());
  // Which way the trackpad scrolls, so the onboarding's drum keeps a two-finger roll under the fingers.
  ipc.handle("input:naturalScrolling", () => naturalScrolling());
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
    if (await transition.writeForDocument(name, data, scope)) {
      sync.noteLocalWrite(String(name ?? ""));
      if (name === "library") downloaded.noteLibrary(data);
    }
  }));
  ipc.handle("app:resetData", () => transition.serializeData(async () => {
    dataResetActive = true;
    try {
      await rooms.leaveRoom().catch(() => undefined);
      transition.invalidateResetDocuments();
      sync.resetSyncState();
      await auth.signOut();
      stats.resetStats();
      await Promise.all([downloads.resetDownloads(), locallib.resetLocalLibrary(), spotify.forgetSpotify()]);
      await persist.resetAppData();
      downloaded.noteLibrary(null);
      // Approvals live in memory too — drop them and re-approve the default
      // download location, or post-reset downloads would be rejected.
      approvedDirs.clear();
      try {
        approveDir(await downloads.defaultDownloadDir());
      } catch {
        /* approved lazily on next download */
      }
    } finally {
      dataResetActive = false;
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
    if (e.type === "done" && e.path) downloaded.noteDownloaded(e.id, e.path);
    try {
      mainWindow?.webContents.send("download:event", e);
    } catch {
      /* window gone */
    }
  });
  // Downloaded songs play from their files — only from approved folders, and only formats that play.
  setDownloadedFileLookup((id) => {
    const file = downloaded.downloadedFilePath(id);
    return file && isApprovedPath(file) && isPlayableAudio(file) ? file : null;
  });

  ipc.handle("backup:export", () => backupExport(mainWindow));
  // Playlist files: export writes whichever format the picked name asks for;
  // import reads one small text file. Both only through the native dialogs.
  const PLAYLIST_FILE_MAX = 5 * 1024 * 1024;
  ipc.handle("playlist:export", async (_e, name: unknown, m3u8: unknown, json: unknown) => {
    if (typeof name !== "string" || typeof m3u8 !== "string" || typeof json !== "string") {
      throw new Error("Invalid playlist export");
    }
    if (m3u8.length > PLAYLIST_FILE_MAX || json.length > PLAYLIST_FILE_MAX) throw new Error("Playlist too large to export");
    const safeName = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 100) || "playlist";
    const opts = {
      title: "Export playlist",
      defaultPath: `${safeName}.m3u8`,
      filters: [
        { name: "Playlist (M3U8)", extensions: ["m3u8"] },
        { name: "ByTune playlist (JSON)", extensions: ["json"] },
      ],
    };
    const res = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { cancelled: true };
    await fs.promises.writeFile(res.filePath, res.filePath.toLowerCase().endsWith(".json") ? json : m3u8, "utf-8");
    return { path: res.filePath };
  });
  ipc.handle("playlist:import", async () => {
    const opts = {
      title: "Import playlist",
      properties: ["openFile" as const],
      filters: [{ name: "Playlists and song lists", extensions: ["m3u8", "m3u", "json", "csv", "txt"] }],
    };
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
    const file = res.canceled ? undefined : res.filePaths[0];
    if (!file) return null;
    if ((await fs.promises.stat(file)).size > PLAYLIST_FILE_MAX) throw new Error("That file is too large for a playlist");
    return {
      name: path.basename(file).replace(/\.(m3u8?|json|csv|txt)$/i, ""),
      ext: path.extname(file).slice(1).toLowerCase(),
      text: await fs.promises.readFile(file, "utf-8"),
    };
  });
  ipc.handle("backup:import", () => backupImport(mainWindow));

  // Replay's share card: a PNG the renderer drew, saved through the native
  // dialog or copied to the clipboard as an image. Only real PNG bytes pass.
  const REPLAY_IMAGE_MAX = 20 * 1024 * 1024;
  const replayPng = (bytes: unknown): Buffer => {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > REPLAY_IMAGE_MAX) throw new Error("Invalid image");
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("Not a PNG image");
    return png;
  };
  ipc.handle("replay:saveImage", async (_e, bytes: unknown, name: unknown) => {
    const png = replayPng(bytes);
    const safeName = (typeof name === "string" ? name : "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 100) || "ByTune Replay";
    const opts = { title: "Save your Replay", defaultPath: `${safeName}.png`, filters: [{ name: "PNG image", extensions: ["png"] }] };
    const res = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { cancelled: true };
    const file = /\.png$/i.test(res.filePath) ? res.filePath : `${res.filePath}.png`;
    await fs.promises.writeFile(file, png);
    return { path: file };
  });
  ipc.handle("replay:copyImage", async (_e, bytes: unknown) => {
    const png = replayPng(bytes);
    if (nativeImage.createFromBuffer(png).isEmpty()) throw new Error("Not a PNG image");
    // A plain copy: a Buffer may sit on a shared pool, which Blob won't take.
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
    return true;
  });

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
  /**
   * Sign in / sign up / Google sign-in share this path. Guest data migrates
   * ONLY into an account being created here (`isNewAccount`) — signing into an
   * account that already exists must bring that account's own cloud copy
   * forward, never mix the previous guest session's listens, likes and feed
   * into it. `changeOwner` archives whatever the guest did under the guest
   * slot, so a later "continue as guest" finds it again.
   */
  const signIn = (authenticate: () => Promise<auth.SessionInfo>) => transition.serializeData(async () => {
    await persist.drainWrites();
    // A room belongs to the account in it: leave while that account can still say so.
    await rooms.leaveRoom().catch(() => undefined);
    const previous = transition.currentOwner();
    const info = await authenticate();
    const migrateGuest = previous === "guest" && info.isNewAccount === true;
    await transition.changeOwner(info.userId ?? "guest", migrateGuest);
    if (previous !== info.userId) {
      sync.resetSyncState(info.userId ?? undefined);
      stats.reloadStore();
    }
    // Spotify is kept per owner (electron/spotify.ts); a guest's goes along with their library.
    if (migrateGuest && info.userId) await spotify.moveGuestSpotify(info.userId);
    // The account's display name comes from the server (or one saved here while it couldn't take it goes up).
    await auth.syncDisplayName();
    await sync.syncNowExclusive().catch((err) => {
      console.error("[bytune] login sync failed (account data not pulled):", err instanceof Error ? err.message : err);
      sync.noteSyncFailure(err);
    });
    mainWindow?.webContents.reload();
    return info;
  });
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  ipc.handle("auth:signUp", (_e, username: string, password: string, displayName: unknown) =>
    signIn(() => auth.signUp(username, password, text(displayName) ?? "")));
  ipc.handle("auth:signIn", (_e, username: string, password: string) => signIn(() => auth.signIn(username, password)));
  ipc.handle("auth:signInGoogle", () => signIn(() => auth.signInGoogle()));
  ipc.handle("auth:continueGuest", (_e, displayName: unknown) => transition.serializeData(async () => {
    // Checked before anything switches: a name that can't be kept stops the whole step.
    const name = normalizeDisplayName(text(displayName) ?? "");
    const problem = name ? displayNameProblem(name) : null;
    if (problem) throw new Error(problem);
    await transition.changeOwner("guest", false);
    sync.resetSyncState();
    stats.reloadStore();
    const info = await auth.continueAsGuest(name || undefined);
    mainWindow?.webContents.reload();
    return info;
  }));
  ipc.handle("auth:clearGuestProfile", () => auth.clearGuestProfile());
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
  ipc.handle("auth:setUsername", (_e, username: string, displayName: unknown) => auth.setUsername(username, text(displayName)));
  ipc.handle("auth:skipUsername", (_e, displayName: unknown) => auth.skipUsernameClaim(text(displayName)));
  ipc.handle("auth:setDisplayName", (_e, name: unknown) => auth.setDisplayName(text(name) ?? ""));
  ipc.handle("auth:signOut", () => transition.serializeData(async () => {
    await persist.drainWrites();
    await sync.syncNowExclusive().catch((err) => {
      console.error("[bytune] logout backup failed:", err instanceof Error ? err.message : err);
      sync.noteSyncFailure(err);
    });
    await rooms.leaveRoom().catch(() => undefined);
    const info = await auth.signOut();
    await transition.changeOwner("guest", false);
    sync.resetSyncState();
    stats.reloadStore();
    mainWindow?.webContents.reload();
    return info;
  }));
  ipc.handle("sync:status", () => sync.syncStatus());
  // Replay is a main-process store: its writes never pass through the
  // renderer's data:write handler above, so the sync engine must be told
  // here or Replay would upload once on sign-in and never again.
  stats.onStoreWrite(() => sync.noteLocalWrite(stats.HISTORY_STORE));
  ipc.handle("sync:now", () => sync.syncNow());
  ipc.handle("sync:backupNow", () => sync.backupNow());
  ipc.handle("sync:restoreNow", () => sync.restoreNow());

  // macOS menu checkmarks + the Windows taskbar thumbbar glyph and media
  // session: the renderer pushes playback state; the menu is rebuilt so
  // Shuffle/Repeat/Play-Pause always show the truth, and the thumbbar swaps
  // its play/pause icon.
  ipc.on("menu:push-state", (_e, s: unknown) => {
    if (!s || typeof s !== "object") return;
    const r = (s as { repeat?: unknown }).repeat;
    menuState = {
      playing: (s as { playing?: unknown }).playing === true,
      shuffle: (s as { shuffle?: unknown }).shuffle === true,
      repeat: r === "all" || r === "one" ? r : "off",
    };
    applyMenu();
    applyThumbar();
    applyTray();
    mediaControls.setPlaying(menuState.playing);
  });

  // Windows media flyout (media-controls.ts): what's playing and where.
  ipc.on("media:metadata", (_e, track: unknown) => mediaControls.setTrack(track));
  ipc.on("media:position", (_e, position: unknown, duration: unknown) => mediaControls.setPosition(position, duration));
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

/* --------------------- audio files opened with ByTune --------------------- */

/** Paths from the OS (Open with, a double-click, a second launch, macOS open-file) or dropped on the
 *  window, gathered for a moment so ten files opened together in Explorer play as one batch, in order. */
const openPaths: string[] = [];
let openTimer: ReturnType<typeof setTimeout> | null = null;
/** Read batches waiting for the renderer, which takes them at startup or when pinged. */
const openedBatches: { tracks: locallib.LocalTrack[]; unplayable: string[] }[] = [];

function queueOpen(paths: string[]): void {
  if (!paths.length) return;
  openPaths.push(...paths);
  openTimer ??= setTimeout(() => {
    openTimer = null;
    const batch = openPaths.splice(0);
    void app
      .whenReady()
      .then(() => locallib.openFiles(batch))
      .then((opened) => {
        if (!opened.tracks.length && !opened.unplayable.length) return;
        openedBatches.push(opened);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("files:opened");
      })
      .catch((err) => console.warn("[bytune] opening files failed:", err instanceof Error ? err.message : err));
  }, 300);
}

/** Audio files among launch arguments: Windows hands "Open with" files over this way. */
const audioArgs = (argv: string[]): string[] =>
  argv.slice(1).filter((a) => !a.startsWith("-") && !a.startsWith("bytune://") && isKnownAudio(a));

const gotLock =
  process.env.BYTUNE_ALLOW_MULTI === "1" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Windows shows an app's notifications (a new version) under its Start menu shortcut's ID, which the
  // installer sets to the appId; the media helper (media-helper.cs) speaks for the same one.
  if (process.platform === "win32") app.setAppUserModelId("com.bytune.music");
  // Windows: ByTune's own media session replaces Chromium's (full-size cover
  // in the media flyout); the switch it sets only works before app ready.
  mediaControls.init();
  let oauthReady = false;
  let pendingOAuthUrl: string | undefined;
  const oauthFromUrl = (url: string): void => {
    // A room invite (bytune://room/CODE) goes to the page, which asks before joining.
    if (/^bytune:\/\/room\//i.test(url)) {
      const code = roomCodeIn(url);
      if (!code) return;
      pendingRoomInvite = code;
      try {
        mainWindow?.webContents.send("room:invite");
      } catch {
        /* the page takes it when it starts (room:takeInvite) */
      }
      return;
    }
    if (!oauthReady) {
      pendingOAuthUrl = url;
      return;
    }
    void auth.handleOAuthCallback(url).catch((err) => console.warn("[bytune] oauth callback:", err.message));
  };
  const bootUrl = process.argv.find((a) => a.startsWith("bytune://"));
  if (bootUrl) oauthFromUrl(bootUrl);
  queueOpen(audioArgs(process.argv));
  app.on("open-url", (event, url) => {
    event.preventDefault();
    oauthFromUrl(url);
  });
  // macOS: Finder's Open With / a double-click on a file ByTune is set up to open.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    queueOpen([file]);
  });
  app.on("second-instance", (_event, argv) => {
    // Opening ByTune again (Start, a shortcut, an audio file, a link) brings
    // back the running window, from the tray too.
    showMainWindow();
    const url = argv.find((a) => a.startsWith("bytune://"));
    if (url) oauthFromUrl(url);
    queueOpen(audioArgs(argv));
  });

  void app.whenReady().then(() => {
    if (isMac) {
      applyMenu();
      app.setAboutPanelOptions({
        applicationName: "ByTune",
        applicationVersion: app.getVersion(),
        copyright: "Licensed under GPL-3.0",
      });
      if (isDev) {
        // The packaged bundle gets its Dock icon from the .icns in the app
        // bundle; dev runs would otherwise show the stock Electron icon.
        const icon = iconPath();
        if (icon) {
          try {
            app.dock?.setIcon(icon);
          } catch {
            /* cosmetic only */
          }
        }
      }
    } else {
      Menu.setApplicationMenu(null);
    }
    persist.migrateLegacyData();
    transition.initializeOwner();
    pip.bindMainWindowGetter(() => mainWindow, showMainWindow);
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
      // The account's display name: another device may have changed it, or one saved here goes up now.
      void auth.syncDisplayName().then((changed) => {
        try {
          if (changed) mainWindow?.webContents.send("auth:changed", auth.sessionInfo());
        } catch {
          /* window gone */
        }
      });
      // A room ByTune quit or crashed in is left; the page puts the listener's queue back.
      void rooms.recover().catch(() => undefined);
    });
    // Back from sleep in a room: measure the clock again and catch up.
    powerMonitor.on("resume", () => rooms.resync());
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
      // A draining quit ends with app.exit(), which skips this event. Any other
      // quit meanwhile (window-all-closed sends one when the drain closes the
      // window) waits for it instead of cutting the drain short.
      if (drainStarted) {
        event.preventDefault();
        return;
      }
      // The real-quit flag first, then what has to be saved at once.
      startExit();
      // Close-time durability: the renderer's last coalesced writes and any
      // queued ownership work may still be in flight when the window dies.
      // Hold quit for a bounded drain — the final player write lands unless
      // something is genuinely stuck, in which case we quit anyway.
      drainStarted = true;
      event.preventDefault();
      const timeout = setTimeout(() => {
        console.warn("[bytune] shutdown drain timed out; quitting");
        app.exit(0);
      }, 3000).unref();
      // Close the window first: its pagehide sends the renderer's pending
      // writes. app.exit() alone destroys it without unload events, so a quit
      // through app.quit() (Cmd+Q, Dock → Quit, the Quit menu item) lost them.
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const closed = win
        ? new Promise<void>((resolve) => {
            win.once("closed", () => resolve());
            win.close();
          })
        : Promise.resolve();
      closed
        .then(() => transition.drainData())
        .then(() => persist.drainWrites())
        .catch((err) => console.warn("[bytune] shutdown drain failed:", err))
        .finally(() => {
          clearTimeout(timeout);
          app.exit(0);
        });
    });
    oauthReady = true;
    if (pendingOAuthUrl) oauthFromUrl(pendingOAuthUrl);
    pendingOAuthUrl = undefined;
    stripMediaReferer();
    // Output-device picker: Chromium hides device labels/ids behind a capture
    // permission, and the renderer's one-time getUserMedia unlock is only
    // deterministic if the session approves it — Electron's implicit default
    // made that depend on build flags. Keep Electron's approve-all behavior
    // but pinned explicitly, so the picker works the same everywhere.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler(() => true);
    registerIpc();
    // Replay lives behind registerIpc's write hook: initStats runs the
    // one-time legacy recovery, and any months it recovers must be announced
    // to the sync engine — which is only possible once that hook is wired.
    stats.initStats();
    void startStreamProxy().catch((err) => console.warn("[bytune] stream proxy failed:", err));
    createWindow();
    createTray();
    updates.startUpdates(
      (s) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("updates:changed", s);
      },
      () => showUpdates(false)
    );
    mediaControls.start({
      onAction: (action) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("media:action", action);
      },
      readLocalArt: (thumb) => locallib.readLocalArtThumb(thumb)?.data ?? null,
    });
    // macOS Dock re-open: bring the hidden main window back, recreate it
    // only if it was actually destroyed (real quit never reaches here).
    app.on("activate", showMainWindow);
  });

  app.on("window-all-closed", () => {
    // macOS: the app keeps running when its windows close (close-to-hide
    // above means the main window is hidden, not destroyed) — quit comes
    // from Cmd+Q / Dock → Quit, which goes through before-quit. Windows hides
    // into the tray the same way, so this only comes when the window really
    // closes there: "Close to tray" off, or no tray icon.
    if (!isMac) app.quit();
  });
}
