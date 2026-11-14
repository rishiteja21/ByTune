/** Preload — exposes a minimal, typed API to the renderer via contextBridge. */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  DownloadProgress, ImportedPlaylist, ImportSong, MoodPage, PodcastPage, PodcastShelf, RadioPage, RoomChange, RoomView, SearchSuggestion,
  SpotifyPlaylistInfo, SpotifyStatus, Track,
} from "../src/types";
import type { LocalTrack } from "./local-library";
import type { UpdateState } from "./updater";
import { version as appVersion } from "../package.json";
import type { WindowActivity } from "../src/lib/windowActivity";

// The PiP window loads this same preload but its scope requests are rejected
// by design (main-window-only handler) — an eager invoke there would leave an
// unhandled rejection on every PiP open. The scope is captured lazily on the
// first read/write instead, and reads resolve to null if it can't be had.
let documentScopePromise: Promise<string> | null = null;
const documentScope = (): Promise<string> => {
  if (documentScopePromise === null) {
    documentScopePromise = ipcRenderer.invoke("data:scope") as Promise<string>;
    documentScopePromise.catch(() => {
      // Leave the cached promise rejected-free: retry on the next call (a
      // transient failure shouldn't poison the scope for the page lifetime).
      documentScopePromise = null;
    });
  }
  return documentScopePromise;
};

const api = {
  platform: process.platform,
  versions: {
    app: appVersion,
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },

  // Music (main process runs youtubei.js)
  search: (query: string, light = false) => ipcRenderer.invoke("music:search", query, light),
  searchPage: (query: string, filter: string) => ipcRenderer.invoke("music:searchPage", query, filter),
  searchMore: (token: string, filter: string) => ipcRenderer.invoke("music:searchMore", token, filter),
  suggestions: (query: string): Promise<{ items: SearchSuggestion[] }> => ipcRenderer.invoke("music:suggestions", query),
  getAlbum: (id: string) => ipcRenderer.invoke("music:album", id),
  getArtist: (id: string) => ipcRenderer.invoke("music:artist", id),
  getPlaylist: (id: string) => ipcRenderer.invoke("music:playlist", id),
  getPlaylistPage: (id: string) => ipcRenderer.invoke("music:playlistPage", id),
  getHome: () => ipcRenderer.invoke("music:home"),
  getRadio: (id: string, token?: string): Promise<RadioPage> => ipcRenderer.invoke("music:radio", id, token),
/** YTM Charts for the device market (regional popularity — cold-start feed). */
  getCharts: () => ipcRenderer.invoke("music:charts"),
  /** Per-market moods & genres from the provider's Explore page. */
  getMoods: () => ipcRenderer.invoke("music:moods"),
  /** A mood or genre page's first playlist covers, for its Explore card. */
  getMoodCovers: (browseId: string, params: string): Promise<string[]> => ipcRenderer.invoke("music:moodCovers", browseId, params),
  /** A mood or genre page's title and shelves, for the category's own page. */
  getMoodPage: (browseId: string, params: string): Promise<MoodPage> => ipcRenderer.invoke("music:moodPage", browseId, params),
  /** The resolved device market + the signal it came from (diagnostics). */
  marketInfo: () => ipcRenderer.invoke("market:current"),
  getLyrics: (track: { id: string; title: string; artist: string; album?: string; duration?: number }) =>
    ipcRenderer.invoke("music:lyrics", track),
  enrichDurations: (ids: string[]) => ipcRenderer.invoke("music:enrich", ids),
  playbackEvent: (event: { type: string; track?: unknown; positionSec: number; playedSec: number; deltaMs: number }) =>
    ipcRenderer.send("playback:event", event),
  statsSummary: (period: string) => ipcRenderer.invoke("stats:summary", period),
  getStreamUrl: (id: string, forceRotate = false, quality?: string) =>
    ipcRenderer.invoke("music:stream", id, forceRotate, quality),
  localLibrary: () => ipcRenderer.invoke("library:get"),
  scanLibrary: (filterNonMusic = true) => ipcRenderer.invoke("library:scan", filterNonMusic),
  setLibraryFolders: (folders: string[]) => ipcRenderer.invoke("library:setFolders", folders),
  /** Import folders: a parent expands into itself + its music-bearing subfolders. */
  addLibraryFolders: (paths: string[]) => ipcRenderer.invoke("library:addFolders", paths),
  renameLibraryFolder: (folderPath: string, displayName: string) =>
    ipcRenderer.invoke("library:renameFolder", folderPath, displayName),
  removeLibraryFolder: (folderPath: string) => ipcRenderer.invoke("library:removeFolder", folderPath),
  libraryFolderStatuses: () => ipcRenderer.invoke("library:folderStatuses"),
  localTrackUrl: (id: string) => ipcRenderer.invoke("library:trackurl", id),
  localArtBytes: (thumb: string) => ipcRenderer.invoke("library:artbytes", thumb),
  remoteArtBytes: (url: string) => ipcRenderer.invoke("art:remoteBytes", url),
  getCanvas: (q: { title: string; artist: string; album?: string }) =>
    ipcRenderer.invoke("canvas:get", q),

  // Updates (electron/updater.ts): where things stand, and what can be done about it.
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke("updates:state"),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke("updates:check"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("updates:install"),
  restartToUpdate: (): Promise<void> => ipcRenderer.invoke("updates:restart"),
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_e: unknown, state: UpdateState): void => cb(state);
    ipcRenderer.on("updates:changed", listener as never);
    return () => ipcRenderer.removeListener("updates:changed", listener as never);
  },

  // Window controls (frameless window — chrome drawn by the renderer)
  getWindowActivity: (): Promise<WindowActivity> => ipcRenderer.invoke("window:activity:get"),
  onWindowActivity: (cb: (state: WindowActivity) => void): (() => void) => {
    const listener = (_e: unknown, state: WindowActivity): void => cb(state);
    ipcRenderer.on("window:activity", listener);
    return () => ipcRenderer.removeListener("window:activity", listener);
  },
  windowMinimize: () => ipcRenderer.send("window:minimize"),
  windowMaximizeToggle: () => ipcRenderer.send("window:maximizeToggle"),
  windowClose: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  /** The launch intro has played (or ended): the window's glass (main.ts setGlass) can go. */
  introDone: () => ipcRenderer.send("window:introDone"),
  /** Whether the trackpad moves content along with the fingers (null: can't tell). */
  naturalScrolling: (): Promise<boolean | null> => ipcRenderer.invoke("input:naturalScrolling"),
  setOverlayChrome: (visible: boolean) => ipcRenderer.invoke("window:setOverlayChrome", visible),
  setFullScreen: (fs: boolean) => ipcRenderer.invoke("window:setFullScreen", fs),
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized);
    ipcRenderer.on("window:maximized", listener as never);
    return () => ipcRenderer.removeListener("window:maximized", listener as never);
  },
  onFullScreenChange: (cb: (fullscreen: boolean) => void): (() => void) => {
    const listener = (_e: unknown, fullscreen: boolean): void => cb(fullscreen);
    ipcRenderer.on("window:fullscreen", listener as never);
    return () => ipcRenderer.removeListener("window:fullscreen", listener as never);
  },

  // Native miniplayer (PiP) window — a separate always-on-top BrowserWindow.
  // The main window broadcasts playback snapshots and executes transport
  // commands; the PiP window renders them. Closing the PiP never touches
  // playback.
  pipToggle: () => ipcRenderer.invoke("pip:toggle"),
  pipIsOpen: () => ipcRenderer.invoke("pip:isOpen"),
  pipClose: () => ipcRenderer.send("pip:close"),
  // Real native minimize (the window stays alive and restorable from the
  // Windows taskbar) — playback and the main window are untouched.
  pipMinimize: () => ipcRenderer.send("pip:minimize"),
  /** the miniplayer's bar button: the compact bar, or back to the square */
  pipSetCompact: (on: boolean) => ipcRenderer.send("pip:compact", on === true),
  pipShowMain: () => ipcRenderer.send("pip:show-main"),
  pipSendState: (snapshot: unknown) => ipcRenderer.send("pip:state", snapshot),
  pipSendCommand: (command: unknown) => ipcRenderer.send("pip:command", command),
  onPipState: (cb: (snapshot: unknown) => void): (() => void) => {
    const listener = (_e: unknown, snapshot: unknown): void => cb(snapshot);
    ipcRenderer.on("pip:state", listener as never);
    return () => ipcRenderer.removeListener("pip:state", listener as never);
  },
  onPipCommand: (cb: (command: unknown) => void): (() => void) => {
    const listener = (_e: unknown, command: unknown): void => cb(command);
    ipcRenderer.on("pip:command", listener as never);
    return () => ipcRenderer.removeListener("pip:command", listener as never);
  },
  onPipOpenChange: (cb: (open: boolean) => void): (() => void) => {
    const listener = (_e: unknown, open: boolean): void => cb(open);
    ipcRenderer.on("pip:open-changed", listener as never);
    return () => ipcRenderer.removeListener("pip:open-changed", listener as never);
  },
  onPipNeedState: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("pip:need-state", listener as never);
    return () => ipcRenderer.removeListener("pip:need-state", listener as never);
  },
  // Native cursor watch: the main process polls the OS pointer against the
  // PiP bounds — the one reliable inside/outside signal, because renderer
  // pointer events stop over the window's app-region drag pad.
  onPipCursorInside: (cb: (inside: boolean) => void): (() => void) => {
    const listener = (_e: unknown, inside: boolean): void => cb(inside);
    ipcRenderer.on("pip:cursor-inside", listener as never);
    return () => ipcRenderer.removeListener("pip:cursor-inside", listener as never);
  },

  // Persistence (JSON files in userData)
  readData: async (name: string) => {
    try {
      return await ipcRenderer.invoke("data:read", name, await documentScope());
    } catch {
      return null;
    }
  },
  writeData: async (name: string, data: unknown) => {
    const scope = await documentScope();
    return ipcRenderer.invoke("data:write", name, data, scope);
  },
  resetData: () => ipcRenderer.invoke("app:resetData"),

  // Backup export / import (native save/open pickers in main)
  backupExport: () => ipcRenderer.invoke("backup:export"),
  playlistExport: (name: string, m3u8: string, json: string): Promise<{ path?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke("playlist:export", name, m3u8, json),
  playlistImport: (): Promise<{ name: string; ext: string; text: string } | null> => ipcRenderer.invoke("playlist:import"),
  /** Spotify: a public playlist link (no sign-in), and Connect Spotify with the listener's own session. */
  spotifyPublicPlaylist: (link: string): Promise<ImportedPlaylist> => ipcRenderer.invoke("spotify:publicPlaylist", link),
  spotifyStatus: (): Promise<SpotifyStatus> => ipcRenderer.invoke("spotify:status"),
  spotifyConnect: (): Promise<SpotifyStatus> => ipcRenderer.invoke("spotify:connect"),
  spotifyDisconnect: (): Promise<SpotifyStatus> => ipcRenderer.invoke("spotify:disconnect"),
  spotifyPlaylists: (): Promise<SpotifyPlaylistInfo[]> => ipcRenderer.invoke("spotify:playlists"),
  spotifyPlaylist: (id: string): Promise<ImportedPlaylist> => ipcRenderer.invoke("spotify:playlist", id),
  /** The YouTube Music song a song from elsewhere is, or null. */
  matchSong: (song: ImportSong, prefer: string): Promise<Track | null> => ipcRenderer.invoke("match:song", song, prefer),
  /** Rooms (electron/rooms.ts): listen together, signed in. */
  roomCurrent: (): Promise<RoomView> => ipcRenderer.invoke("room:current"),
  roomCreate: (): Promise<RoomView> => ipcRenderer.invoke("room:create"),
  roomJoin: (code: string): Promise<RoomView> => ipcRenderer.invoke("room:join", code),
  roomLeave: (): Promise<RoomView> => ipcRenderer.invoke("room:leave"),
  roomUpdate: (change: RoomChange): Promise<RoomView> => ipcRenderer.invoke("room:update", change),
  roomHostOnly: (on: boolean): Promise<RoomView> => ipcRenderer.invoke("room:hostOnly", on),
  roomMakeHost: (userId: string): Promise<RoomView> => ipcRenderer.invoke("room:makeHost", userId),
  roomRemove: (userId: string): Promise<RoomView> => ipcRenderer.invoke("room:remove", userId),
  /** The listener's own queue, set aside while in a room, and taken back (once). */
  roomStash: (snapshot: unknown): Promise<void> => ipcRenderer.invoke("room:stash", snapshot),
  roomUnstash: (): Promise<unknown> => ipcRenderer.invoke("room:unstash"),
  /** An invite link opened (bytune://room/CODE), once. */
  roomTakeInvite: (): Promise<string | null> => ipcRenderer.invoke("room:takeInvite"),
  onRoomState: (cb: (view: RoomView) => void): (() => void) => {
    const listener = (_e: unknown, view: RoomView): void => cb(view);
    ipcRenderer.on("room:state", listener as never);
    return () => ipcRenderer.removeListener("room:state", listener as never);
  },
  onRoomInvite: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("room:invite", listener);
    return () => ipcRenderer.removeListener("room:invite", listener);
  },
  /** Replay's share card: save the PNG through the native dialog, or copy it as an image. */
  saveReplayImage: (png: Uint8Array, name: string): Promise<{ path?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke("replay:saveImage", png, name),
  copyReplayImage: (png: Uint8Array): Promise<boolean> => ipcRenderer.invoke("replay:copyImage", png),
  /** A local file's ReplayGain track gain (dB), for volume leveling. */
  localGainDb: (id: string): Promise<number | null> => ipcRenderer.invoke("local:gainDb", id),
  getPodcast: (id: string): Promise<PodcastPage> => ipcRenderer.invoke("music:podcast", id),
  /** YouTube Music's podcasts page for the device market (Explore). */
  getPodcasts: (): Promise<PodcastShelf[]> => ipcRenderer.invoke("music:podcasts"),
  backupImport: () => ipcRenderer.invoke("backup:import"),

  // Accounts (Supabase) + cloud backup
  authGetSession: () => ipcRenderer.invoke("auth:getSession"),
  authSignUp: (username: string, password: string, displayName: string) =>
    ipcRenderer.invoke("auth:signUp", username, password, displayName),
  authSignIn: (username: string, password: string) => ipcRenderer.invoke("auth:signIn", username, password),
  authSignInGoogle: () => ipcRenderer.invoke("auth:signInGoogle"),
  authContinueGuest: (displayName?: string) => ipcRenderer.invoke("auth:continueGuest", displayName),
  authClearGuestProfile: () => ipcRenderer.invoke("auth:clearGuestProfile"),
  authUsernameAvailable: (username: string) => ipcRenderer.invoke("auth:usernameAvailable", username),
  authSetUsername: (username: string, displayName?: string) => ipcRenderer.invoke("auth:setUsername", username, displayName),
  authSkipUsername: (displayName?: string) => ipcRenderer.invoke("auth:skipUsername", displayName),
  authSetDisplayName: (name: string) => ipcRenderer.invoke("auth:setDisplayName", name),
  authSignOut: () => ipcRenderer.invoke("auth:signOut"),
  onAuthChanged: (cb: (info: { mode: string | null; userId: string | null; username: string | null; freshInstall?: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, info: { mode: string | null; userId: string | null; username: string | null; freshInstall?: boolean }): void => cb(info);
    ipcRenderer.on("auth:changed", listener as never);
    return () => ipcRenderer.removeListener("auth:changed", listener as never);
  },
  syncStatus: () => ipcRenderer.invoke("sync:status"),
  syncNow: () => ipcRenderer.invoke("sync:now"),
  syncBackupNow: () => ipcRenderer.invoke("sync:backupNow"),
  syncRestoreNow: () => ipcRenderer.invoke("sync:restoreNow"),
  onSyncRestored: (cb: (info: { stores: string[]; seq: number }) => void): (() => void) => {
    const listener = (_e: unknown, info: { stores: string[]; seq: number }): void => cb(info);
    ipcRenderer.on("sync:restored", listener as never);
    return () => ipcRenderer.removeListener("sync:restored", listener as never);
  },

  // macOS application menu: commands flow menu → renderer, playback state
  // flows renderer → menu (checkmarks). No-ops on other platforms.
  onMenuCommand: (cb: (command: string) => void): (() => void) => {
    const listener = (_e: unknown, command: string): void => cb(command);
    ipcRenderer.on("menu:command", listener as never);
    return () => ipcRenderer.removeListener("menu:command", listener as never);
  },
  menuPushState: (state: { playing: boolean; shuffle: boolean; repeat: "off" | "all" | "one" }) =>
    ipcRenderer.send("menu:push-state", state),

  // Windows media flyout (media-controls.ts): what's playing goes out, flyout
  // buttons and media keys come back as media-session actions. No-ops elsewhere.
  mediaSetMetadata: (track: { title: string; artist: string; album: string; thumb: string } | null) =>
    ipcRenderer.send("media:metadata", track),
  mediaSetPosition: (position: number, duration: number) => ipcRenderer.send("media:position", position, duration),
  onMediaAction: (cb: (a: { action: string; seekTime?: number }) => void): (() => void) => {
    const listener = (_e: unknown, a: { action: string; seekTime?: number }): void => cb(a);
    ipcRenderer.on("media:action", listener as never);
    return () => ipcRenderer.removeListener("media:action", listener as never);
  },

  // Audio files opened with ByTune (Open with, a double-click, dropped on the window)
  takeOpenedFiles: (): Promise<{ tracks: LocalTrack[]; unplayable: string[] }[]> => ipcRenderer.invoke("files:take"),
  onFilesOpened: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("files:opened", listener);
    return () => ipcRenderer.removeListener("files:opened", listener);
  },
  openedFiles: (): Promise<LocalTrack[]> => ipcRenderer.invoke("library:opened"),
  forgetOpenedFile: (id: string): Promise<LocalTrack[]> => ipcRenderer.invoke("library:forgetOpened", id),

  // Filesystem helpers
  defaultDownloadDir: () => ipcRenderer.invoke("app:defaultDownloadDir"),
  pickFolder: () => ipcRenderer.invoke("app:pickFolder"),
  revealPath: (p: string) => ipcRenderer.invoke("app:revealPath", p),
  openPath: (p: string) => ipcRenderer.invoke("app:openPath", p),

  // Downloads
  startDownload: (track: Track, dir?: string, quality?: string, exportCompat?: boolean) => ipcRenderer.invoke("download:start", track, dir, quality, exportCompat),
  cancelDownload: (id: string) => ipcRenderer.invoke("download:cancel", id),
  downloadQueue: () => ipcRenderer.invoke("download:queue"),
  onDownloadEvent: (cb: (e: { type: string; id: string; downloaded?: number; total?: number; path?: string; reason?: string }) => void): (() => void) => {
    const listener = (_e: unknown, ev: { type: string; id: string }): void => cb(ev);
    ipcRenderer.on("download:event", listener as never);
    return () => ipcRenderer.removeListener("download:event", listener as never);
  },
  onDownloadProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: DownloadProgress): void => cb(p);
    ipcRenderer.on("download:progress", listener as never);
    return () => ipcRenderer.removeListener("download:progress", listener as never);
  },
};

contextBridge.exposeInMainWorld("bytune", api);

// Audio files dragged in from Explorer/Finder play at once. Their real paths
// come from Electron here, in the preload's own world: a File the page builds
// itself has no path, so the page can't hand over files the user never dropped.
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  const paths = files.map((f) => webUtils.getPathForFile(f)).filter(Boolean);
  if (paths.length) void ipcRenderer.invoke("files:dropped", paths).catch(() => undefined);
});

export type ByTuneApi = typeof api;
