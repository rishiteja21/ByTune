/**
 * Native desktop-level miniplayer (PiP) window.
 *
 * A separate frameless, always-on-top BrowserWindow that floats above other
 * applications (Chrome, VS Code, Explorer…) at the OS level. It loads the
 * same renderer bundle with `?window=pip`; the compact Spotify-scale player
 * UI lives in src/pip/PipApp.tsx, and playback stays owned by the main
 * window's audio engine — the two windows talk through the pip:state /
 * pip:command IPC relay.
 *
 * Sizing follows Spotify's desktop miniplayer measured on a 200%-scale
 * display: a ~300×300 logical-px square with a ~58px metadata bar under the
 * artwork, ~6px art inset, hover-revealed transport and resize grip.
 *
 * Closing the PiP only destroys this window — the main window keeps playing.
 */
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { pathToFileURL } from "url";
import * as path from "path";
import * as persist from "./persist";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

type SenderEvent = IpcMainEvent | IpcMainInvokeEvent;
export function rendererUrl(isPip = false): string {
  const url = new URL(isDev && process.env.VITE_DEV_SERVER_URL
    ? process.env.VITE_DEV_SERVER_URL
    : pathToFileURL(path.join(__dirname, "../dist/index.html")).href);
  if (isPip) {
    if (isDev && !url.pathname.endsWith("/")) url.pathname += "/";
    url.search = "?window=pip";
  }
  return url.href;
}

export function isRendererUrl(candidate: string, isPip = false): boolean {
  try {
    const url = new URL(candidate);
    const expected = new URL(rendererUrl(isPip));
    url.hash = "";
    expected.hash = "";
    return url.href === expected.href;
  } catch { return false; }
}

export function isTrustedSender(event: SenderEvent, win: BrowserWindow | null, isPip = false): boolean {
  return !!event && !!win && !win.isDestroyed() && event.sender === win.webContents
    && !!event.senderFrame && event.senderFrame === win.webContents.mainFrame
    && isRendererUrl(event.senderFrame.url, isPip);
}

/** Installed before load; never let a privileged document become a remote page. */
export function restrictNavigation(win: BrowserWindow, isPip = false): void {
  win.webContents.on("will-navigate", (event, url) => {
    if (!isRendererUrl(url, isPip)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isRendererUrl(url, isPip)) event.preventDefault();
  });
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isRendererUrl(event.url, isPip)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Spotify-measured compact default (logical px). */
export const PIP_DEFAULT_W = 300;
export const PIP_DEFAULT_H = 300;
const PIP_MIN_W = 260;
const PIP_MIN_H = 260;
const PIP_MAX_W = 560;
const PIP_MAX_H = 560;
/** default resting spot: bottom-right of the work area */
const REST_MARGIN = 16;

/** How often the native cursor watch samples the pointer (ms). The renderer's
    pointer events stop over the PiP's app-region drag pad, so the
    inside/outside boundary is arbitrated here where the OS cursor is always
    visible. Hover transitions INSIDE the window stay instant (renderer
    events); this only pushes a boolean on change. */
const CURSOR_WATCH_MS = 100;

interface PipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let pipWindow: BrowserWindow | null = null;
/** last known bounds, for saving when the window is already gone */
let lastRect: PipRect | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let getMainWindow: () => BrowserWindow | null = () => null;

/** native cursor watch */
let cursorWatch: ReturnType<typeof setInterval> | null = null;
let cursorInsideLast: boolean | null = null;

function stopCursorWatch(): void {
  if (cursorWatch) {
    clearInterval(cursorWatch);
    cursorWatch = null;
  }
  cursorInsideLast = null;
}

function startCursorWatch(): void {
  stopCursorWatch();
  cursorWatch = setInterval(() => {
    if (!pipWindow || pipWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = pipWindow.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== cursorInsideLast) {
      cursorInsideLast = inside;
      pipWindow.webContents.send("pip:cursor-inside", inside);
    }
  }, CURSOR_WATCH_MS);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Called from main.ts so this module can reach the main window without a circular import. */
export function bindMainWindowGetter(get: () => BrowserWindow | null): void {
  getMainWindow = get;
}

function notifyMain(channel: string, payload?: unknown): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function defaultRect(): PipRect {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - PIP_DEFAULT_W - REST_MARGIN,
    y: wa.y + wa.height - PIP_DEFAULT_H - REST_MARGIN,
    w: PIP_DEFAULT_W,
    h: PIP_DEFAULT_H,
  };
}

function readSavedRect(): PipRect | null {
  const r = persist.readData("pip-rect") as Partial<PipRect> | null;
  if (!r || typeof r.x !== "number" || typeof r.y !== "number") return null;
  const w = clamp(Number(r.w) || PIP_DEFAULT_W, PIP_MIN_W, PIP_MAX_W);
  const h = clamp(Number(r.h) || PIP_DEFAULT_H, PIP_MIN_H, PIP_MAX_H);
  return { x: Math.round(r.x), y: Math.round(r.y), w, h };
}

/** A remembered position is only used while it is reachable on some display. */
function visibleRect(r: PipRect): PipRect {
  const reachable = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return r.x + r.w > a.x + 56 && r.x < a.x + a.width - 56 && r.y + r.h > a.y + 56 && r.y < a.y + a.height - 56;
  });
  if (!reachable) return defaultRect();
  // Final safety net: keep the box inside the primary work area (never under
  // the taskbar, never off-screen).
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    w: r.w,
    h: r.h,
    x: clamp(r.x, wa.x, Math.max(wa.x, wa.x + wa.width - r.w)),
    y: clamp(r.y, wa.y, Math.max(wa.y, wa.y + wa.height - r.h)),
  };
}

function loadInto(win: BrowserWindow): void {
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    const base = process.env.VITE_DEV_SERVER_URL;
    void win.loadURL(`${base.endsWith("/") ? base : `${base}/`}?window=pip`);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"), { query: { window: "pip" } });
  }
}

function scheduleRectSave(): void {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  const b = pipWindow.getBounds();
  lastRect = { x: b.x, y: b.y, w: b.width, h: b.height };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(savePipRect, 400);
}

/** Persist the current (or last known) rect — called debounced and on close/quit. */
export function savePipRect(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // A bounds change that landed between the last moved/resized event and a
  // quit would otherwise save a stale snapshot; prefer the live window.
  if (pipWindow && !pipWindow.isDestroyed()) {
    const b = pipWindow.getBounds();
    lastRect = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  if (!lastRect) return;
  // Synchronous on purpose: this also runs from before-quit/close, where an
  // async write could still be in flight when the process exits — the saved
  // rect would be lost and the miniplayer would reopen at its default spot.
  try {
    persist.writeDataSync("pip-rect", lastRect);
  } catch (err) {
    console.warn("[bytune] pip-rect save failed:", err);
  }
}

export function isPipOpen(): boolean {
  return !!pipWindow && !pipWindow.isDestroyed();
}

export function openPip(): void {
  if (isPipOpen()) {
    // Restore first if the PiP is minimized, so the taskbar/main-window
    // toggle always brings the actual miniplayer back on screen.
    if (pipWindow?.isMinimized()) pipWindow.restore();
    pipWindow?.show();
    return;
  }
  const rect = visibleRect(readSavedRect() ?? defaultRect());
  lastRect = rect;
  pipWindow = new BrowserWindow({
    width: rect.w,
    height: rect.h,
    x: rect.x,
    y: rect.y,
    minWidth: PIP_MIN_W,
    minHeight: PIP_MIN_H,
    maxWidth: PIP_MAX_W,
    maxHeight: PIP_MAX_H,
    frame: false,
    show: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: "#000000",
    title: "ByTune Miniplayer",
    // Unthrottled: the always-on-top window must keep animating and receiving
    // state pushes even while fully covered by another always-on-top window.
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  // "floating" = standard always-on-top: above normal windows, below system
  // dialogs and other topmost windows (Spotify's level).
  pipWindow.setAlwaysOnTop(true, "floating");
  restrictNavigation(pipWindow, true);
  loadInto(pipWindow);

  pipWindow.once("ready-to-show", () => {
    if (!pipWindow || pipWindow.isDestroyed()) return;
    pipWindow.show();
    startCursorWatch();
    notifyMain("pip:open-changed", true);
    // Ask the main window for a fresh playback snapshot right away.
    notifyMain("pip:need-state");
  });

  pipWindow.on("moved", scheduleRectSave);
  pipWindow.on("resized", scheduleRectSave);
  pipWindow.on("close", savePipRect);
  // Same webContents-focus rule as the main window: when the PiP window
  // becomes active its page must hold keyboard focus right away, so Space
  // toggles playback without a click first.
  pipWindow.on("focus", () => {
    if (pipWindow && !pipWindow.isDestroyed()) pipWindow.webContents.focus();
  });
  pipWindow.on("closed", () => {
    stopCursorWatch();
    savePipRect();
    pipWindow = null;
    notifyMain("pip:open-changed", false);
  });
}

/**
 * Close ONLY the PiP window. Playback lives in the main window's audio
 * engine and is untouched — music keeps playing.
 */
export function closePip(): void {
  savePipRect();
  if (!isPipOpen()) return;
  const win = pipWindow;
  pipWindow = null;
  stopCursorWatch();
  win?.destroy();
  notifyMain("pip:open-changed", false);
}

export function togglePip(): boolean {
  if (isPipOpen()) closePip();
  else openPip();
  return isPipOpen();
}

export function registerPipIpc(): void {
  // PiP channels must come from the PiP window itself; pip:toggle/isOpen may
  // also come from the main window's Now Playing controls.
  const fromPip = (event: SenderEvent): boolean => isTrustedSender(event, pipWindow, true);
  const fromEither = (event: SenderEvent): boolean => fromPip(event) || isTrustedSender(event, getMainWindow());
  ipcMain.handle("pip:toggle", (event) => { if (fromEither(event)) return togglePip(); });
  ipcMain.handle("pip:isOpen", (event) => (fromEither(event) ? isPipOpen() : false));
  ipcMain.on("pip:close", (event) => { if (fromPip(event)) closePip(); });
  // Real native minimize — the window stays alive (playback continues) and
  // is restorable from the Windows taskbar.
  ipcMain.on("pip:minimize", (event) => {
    if (!fromPip(event)) return;
    if (pipWindow && !pipWindow.isDestroyed()) pipWindow.minimize();
  });
  ipcMain.on("pip:show-main", (event) => {
    if (!fromPip(event)) return;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  // Playback snapshots flow main window → PiP.
  ipcMain.on("pip:state", (event, snapshot: unknown) => {
    if (!isTrustedSender(event, getMainWindow())) return;
    if (pipWindow && !pipWindow.isDestroyed()) pipWindow.webContents.send("pip:state", snapshot);
  });
  // Transport commands flow PiP → main window (the audio engine's host).
  ipcMain.on("pip:command", (event, command: unknown) => {
    if (!fromPip(event)) return;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send("pip:command", command);
  });
}
