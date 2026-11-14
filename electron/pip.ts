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
 * Sizing follows Spotify's desktop MiniPlayer, measured via CDP: a 330×342
 * logical-px viewport with a 26px top bar, 48px metadata bar, 4px artwork
 * inset and 8px gaps. Outer window adjusted for the frame (see constants).
 * A button in the miniplayer switches it to the compact bar (PR #10's design,
 * by bevinkatti), a fixed 320×110 window, and back (setPipCompact).
 *
 * Closing the PiP only destroys this window — the main window keeps playing.
 */
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { pathToFileURL } from "url";
import * as path from "path";
import * as persist from "./persist";
import { trackWindowActivity } from "./window-activity";

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

/** Spotify MiniPlayer-measured defaults (logical px). Spotify's viewport is
 * 330×342; ByTune's frameless window carries ~22px of horizontal and ~11px
 * of vertical invisible resize frame, so the outer window is sized to land
 * that viewport. Min/max mirror Spotify's own clamps (253×228 / 569×569
 * outer) converted through the same frame. */
export const PIP_DEFAULT_W = 352;
export const PIP_DEFAULT_H = 353;
const PIP_MIN_W = 262;
const PIP_MIN_H = 233;
const PIP_MAX_W = 578;
const PIP_MAX_H = 574;
/** The compact bar: a fixed size, only ever reached with its button. */
const PIP_BAR_W = 320;
const PIP_BAR_H = 110;
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
/** last known bounds, for saving when the window is already gone. While the
    bar shows, still the square window's rect: the bar sits at its
    bottom-right corner, so the square comes back where the bar was. */
let lastRect: PipRect | null = null;
/** showing the compact bar (saved with the rect, so it reopens that way) */
let compact = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let getMainWindow: () => BrowserWindow | null = () => null;
let showMainWindow: () => void = () => undefined;

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

/**
 * Called from main.ts so this module can reach the main window without a
 * circular import, and bring it back the one way main.ts does (from the tray too).
 */
export function bindMainWindowGetter(get: () => BrowserWindow | null, show: () => void): void {
  getMainWindow = get;
  showMainWindow = show;
}

function notifyMain(channel: string, payload?: unknown): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function defaultRect(w = PIP_DEFAULT_W, h = PIP_DEFAULT_H): PipRect {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - w - REST_MARGIN,
    y: wa.y + wa.height - h - REST_MARGIN,
    w,
    h,
  };
}

function readSaved(): { rect: PipRect; compact: boolean } | null {
  const r = persist.readData("pip-rect") as (Partial<PipRect> & { compact?: unknown }) | null;
  if (!r || typeof r.x !== "number" || typeof r.y !== "number") return null;
  const w = clamp(Number(r.w) || PIP_DEFAULT_W, PIP_MIN_W, PIP_MAX_W);
  const h = clamp(Number(r.h) || PIP_DEFAULT_H, PIP_MIN_H, PIP_MAX_H);
  return { rect: { x: Math.round(r.x), y: Math.round(r.y), w, h }, compact: r.compact === true };
}

/** The bar's box: the square's bottom-right corner, so switching keeps that corner put. */
function barBox(r: PipRect): PipRect {
  return { x: r.x + r.w - PIP_BAR_W, y: r.y + r.h - PIP_BAR_H, w: PIP_BAR_W, h: PIP_BAR_H };
}

/** The square rect for a bar at `bar`: the bar's bottom-right corner, the square's size. */
function squareAt(bar: PipRect, square: PipRect): PipRect {
  return { x: bar.x + bar.w - square.w, y: bar.y + bar.h - square.h, w: square.w, h: square.h };
}

/** The window's live bounds as the square rect (lastRect), the bar included.
 *  The bar counts by its own size: Windows reports a frameless window held to
 *  110px as 111px tall, and carrying that back would creep it down a pixel a switch. */
function liveRect(win: BrowserWindow): PipRect {
  const b = win.getBounds();
  if (compact) return squareAt({ x: b.x, y: b.y, w: PIP_BAR_W, h: PIP_BAR_H }, lastRect ?? defaultRect());
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** A remembered position is only used while it is reachable on some display. */
function visibleRect(r: PipRect): PipRect {
  const reachable = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return r.x + r.w > a.x + 56 && r.x < a.x + a.width - 56 && r.y + r.h > a.y + 56 && r.y < a.y + a.height - 56;
  });
  if (!reachable) return defaultRect(r.w, r.h);
  // Final safety net: keep the box inside the work area of the display it is
  // on (never under the taskbar, never off-screen) — a second monitor's spot
  // must not be dragged back onto the primary one.
  const wa = screen.getDisplayMatching({ x: r.x, y: r.y, width: r.w, height: r.h }).workArea;
  return {
    w: r.w,
    h: r.h,
    x: clamp(r.x, wa.x, Math.max(wa.x, wa.x + wa.width - r.w)),
    y: clamp(r.y, wa.y, Math.max(wa.y, wa.y + wa.height - r.h)),
  };
}

function loadInto(win: BrowserWindow): void {
  const fail = (err: unknown): void => {
    console.warn("[bytune] miniplayer failed to load:", err instanceof Error ? err.message : err);
    // A blank always-on-top window is worse than none; only close it if it is
    // still the current PiP (a rapid open/close race must not close the
    // replacement window).
    if (pipWindow === win) closePip();
  };
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    const base = process.env.VITE_DEV_SERVER_URL;
    win.loadURL(`${base.endsWith("/") ? base : `${base}/`}?window=pip`).catch(fail);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"), { query: { window: "pip" } }).catch(fail);
  }
}

function scheduleRectSave(): void {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  lastRect = liveRect(pipWindow);
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
  if (pipWindow && !pipWindow.isDestroyed()) lastRect = liveRect(pipWindow);
  if (!lastRect) return;
  // Synchronous on purpose: this also runs from before-quit/close, where an
  // async write could still be in flight when the process exits — the saved
  // rect would be lost and the miniplayer would reopen at its default spot.
  try {
    persist.writeDataSync("pip-rect", { ...lastRect, compact });
  } catch (err) {
    console.warn("[bytune] pip-rect save failed:", err);
  }
}

export function isPipOpen(): boolean {
  return !!pipWindow && !pipWindow.isDestroyed();
}

/** Open and on screen. A minimized miniplayer reads as closed to the main
 *  window: its button offers to bring it back, and no snapshots are pushed. */
function isPipShown(): boolean {
  return isPipOpen() && !pipWindow?.isMinimized();
}

export function openPip(): void {
  if (isPipOpen()) {
    // Restore first if the PiP is minimized, so the taskbar/main-window
    // toggle always brings the actual miniplayer back on screen.
    if (pipWindow?.isMinimized()) pipWindow.restore();
    pipWindow?.show();
    return;
  }
  const saved = readSaved();
  compact = saved?.compact ?? false;
  const square = saved?.rect ?? defaultRect();
  const rect = visibleRect(compact ? barBox(square) : square);
  lastRect = compact ? squareAt(rect, square) : rect;
  pipWindow = new BrowserWindow({
    width: rect.w,
    height: rect.h,
    x: rect.x,
    y: rect.y,
    minWidth: compact ? PIP_BAR_W : PIP_MIN_W,
    minHeight: compact ? PIP_BAR_H : PIP_MIN_H,
    maxWidth: compact ? PIP_BAR_W : PIP_MAX_W,
    maxHeight: compact ? PIP_BAR_H : PIP_MAX_H,
    frame: false,
    show: false,
    // Always resizable: the bar is held to its size by min = max. Turning
    // resizing off on a frameless Windows window grows it 1-3px every time.
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
  const activityWindow = pipWindow;
  trackWindowActivity(activityWindow, (event) => isTrustedSender(event, activityWindow, true));
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
    // The PiP registers its snapshot listener in a post-paint effect; a
    // snapshot pushed before that is dropped, and while paused nothing else
    // would ever refresh the window. One bounded re-request covers the race.
    setTimeout(() => {
      if (pipWindow && !pipWindow.isDestroyed()) notifyMain("pip:need-state");
    }, 500);
  });

  pipWindow.on("moved", scheduleRectSave);
  pipWindow.on("resized", scheduleRectSave);
  pipWindow.on("close", savePipRect);
  // The page's own <title> ("ByTune") would rename this window, leaving two
  // "ByTune" entries in the taskbar and Alt-Tab.
  pipWindow.on("page-title-updated", (event) => event.preventDefault());
  pipWindow.on("minimize", () => notifyMain("pip:open-changed", false));
  pipWindow.on("restore", () => notifyMain("pip:open-changed", true));
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

/**
 * The miniplayer's bar button: the compact bar or the square miniplayer. The
 * window's bottom-right corner stays put (then the box is kept on screen);
 * the bar is held to its size (min = max), the square resizable as always.
 */
export function setPipCompact(on: boolean): void {
  const win = pipWindow;
  if (!win || win.isDestroyed() || on === compact) return;
  const square = liveRect(win);
  compact = on;
  const target = visibleRect(on ? barBox(square) : square);
  lastRect = on ? squareAt(target, square) : target;
  // Loosen the limits for the switch itself, then set the new mode's own.
  win.setMinimumSize(Math.min(PIP_BAR_W, PIP_MIN_W), Math.min(PIP_BAR_H, PIP_MIN_H));
  win.setMaximumSize(Math.max(PIP_BAR_W, PIP_MAX_W), Math.max(PIP_BAR_H, PIP_MAX_H));
  win.setBounds({ x: target.x, y: target.y, width: target.w, height: target.h });
  win.setMinimumSize(on ? PIP_BAR_W : PIP_MIN_W, on ? PIP_BAR_H : PIP_MIN_H);
  win.setMaximumSize(on ? PIP_BAR_W : PIP_MAX_W, on ? PIP_BAR_H : PIP_MAX_H);
  savePipRect();
}

export function togglePip(): boolean {
  // A minimized miniplayer comes back (openPip restores it) rather than closing.
  if (isPipShown()) closePip();
  else openPip();
  return isPipShown();
}

export function registerPipIpc(): void {
  // PiP channels must come from the PiP window itself; pip:toggle/isOpen may
  // also come from the main window's Now Playing controls.
  const fromPip = (event: SenderEvent): boolean => isTrustedSender(event, pipWindow, true);
  const fromEither = (event: SenderEvent): boolean => fromPip(event) || isTrustedSender(event, getMainWindow());
  ipcMain.handle("pip:toggle", (event) => { if (fromEither(event)) return togglePip(); });
  ipcMain.handle("pip:isOpen", (event) => (fromEither(event) ? isPipShown() : false));
  ipcMain.on("pip:close", (event) => { if (fromPip(event)) closePip(); });
  // Real native minimize — the window stays alive (playback continues) and
  // is restorable from the Windows taskbar.
  ipcMain.on("pip:minimize", (event) => {
    if (!fromPip(event)) return;
    if (pipWindow && !pipWindow.isDestroyed()) pipWindow.minimize();
  });
  ipcMain.on("pip:show-main", (event) => {
    if (fromPip(event)) showMainWindow();
  });
  // The bar button: the compact bar (true) or the square miniplayer (false).
  ipcMain.on("pip:compact", (event, on: unknown) => {
    if (fromPip(event)) setPipCompact(on === true);
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
