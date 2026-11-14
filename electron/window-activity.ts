import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { activityState, type WindowActivity } from "../src/lib/windowActivity";

const windows = new Map<number, {
  snapshot: () => WindowActivity;
  hide: () => void;
  trusted: (event: IpcMainInvokeEvent) => boolean;
}>();

/** Install before loadURL/loadFile, including on the independent PiP window. */
export function trackWindowActivity(win: BrowserWindow, trusted: (event: IpcMainInvokeEvent) => boolean): void {
  const id = win.webContents.id;
  if (windows.has(id)) return;
  const readFlags = () => ({ visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() });
  const flags = readFlags();
  let current: WindowActivity = { windowId: win.id, revision: 0, ...flags, state: activityState(flags) };
  let reconcile: ReturnType<typeof setImmediate> | null = null;
  let hiding = 0;
  const cancelReconcile = (): void => {
    if (reconcile !== null) clearImmediate(reconcile);
    reconcile = null;
  };
  const update = (patch: Partial<typeof flags>): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const next = { ...current, ...readFlags(), ...patch,
      // Cocoa may deliver callbacks (or a snapshot request) inside hide().
      // None may resume visuals before the native operation returns.
      ...(hiding ? { visible: false, focused: false } : {}),
    };
    if (next.visible === current.visible && next.focused === current.focused && next.minimized === current.minimized) return;
    current = { ...next, revision: current.revision + 1, state: activityState(next) };
    win.webContents.send("window:activity", current);
  };
  const changed = (patch: Partial<typeof flags>): void => {
    update(patch);
    // These include Cocoa occlusion notifications, not just explicit window
    // ordering. Read fresh flags after the event; never retain an old patch.
    cancelReconcile();
    reconcile = setImmediate(() => { reconcile = null; update({}); });
  };
  // Negative events suspend immediately. Positive notifications may belong
  // to an earlier show/restore: only current native flags can resume visuals.
  const handlers = {
    focus: () => changed({}),
    blur: () => changed({ focused: false }),
    show: () => changed({}),
    hide: () => changed({ visible: false, focused: false }),
    minimize: () => changed({ minimized: true, focused: false }),
    restore: () => changed({}),
  };
  windows.set(id, {
    snapshot: () => { update({}); return current; },
    hide: () => {
      hiding++;
      cancelReconcile();
      update({});
      try {
        win.hide();
      } finally {
        hiding--;
        cancelReconcile();
        // On macOS an already occluded window can be ordered out without
        // another `hide` event. The native call's return is the completion
        // boundary: read its result here, rather than guessing a delay.
        update({});
      }
    },
    trusted,
  });
  win.on("focus", handlers.focus);
  win.on("blur", handlers.blur);
  win.on("show", handlers.show);
  win.on("hide", handlers.hide);
  win.on("minimize", handlers.minimize);
  win.on("restore", handlers.restore);
  win.once("closed", () => {
    cancelReconcile();
    windows.delete(id);
    win.removeListener("focus", handlers.focus);
    win.removeListener("blur", handlers.blur);
    win.removeListener("show", handlers.show);
    win.removeListener("hide", handlers.hide);
    win.removeListener("minimize", handlers.minimize);
    win.removeListener("restore", handlers.restore);
  });
}

/** Use for application-owned hides: Cocoa need not emit a new hide event. */
export function hideWindow(win: BrowserWindow): void {
  const entry = windows.get(win.webContents.id);
  if (!entry) throw new Error("Window activity is not registered");
  entry.hide();
}

/** No renderer-supplied ID: resolve and authenticate the requesting window. */
export function getWindowActivity(event: IpcMainInvokeEvent): WindowActivity {
  const entry = windows.get(event?.sender?.id);
  if (!entry || !entry.trusted(event)) throw new Error("Untrusted window activity sender");
  return entry.snapshot();
}
