import { useCallback, useRef, useSyncExternalStore } from "react";
import { createVisualActivity } from "./visualActivityCore";
import { activityState, observeWindowActivity, type WindowActivity } from "./windowActivity";

/** Decorative motion needs focus; functional presentation only needs visibility.
 * Each renderer owns these stores for its own native BrowserWindow. */
export const visualActivity = createVisualActivity();
export const visibleActivity = createVisualActivity();

export function useWindowVisible(): boolean {
  return useSyncExternalStore(visibleActivity.subscribe, visibleActivity.getSnapshot);
}

/** Hold a presentation snapshot while hidden; read the current source on
 * resume. The source keeps updating (in particular, the audio clock does). */
export function useVisualSnapshot<T>(subscribe: (notify: () => void) => () => void, read: () => T): T {
  const held = useRef(read());
  const getSnapshot = useCallback(() => {
    if (visibleActivity.getSnapshot()) held.current = read();
    return held.current;
  }, [read]);
  const watch = useCallback((notify: () => void) => {
    const offSource = subscribe(() => { if (visibleActivity.getSnapshot()) notify(); });
    const offActivity = visibleActivity.subscribe(notify);
    return () => { offSource(); offActivity(); };
  }, [subscribe]);
  return useSyncExternalStore(watch, getSnapshot);
}

/** Called before rendering either app. Native visibility/focus is authoritative
 * in Electron. Page visibility still vetoes decoration, but Cocoa occlusion must
 * not freeze functional content in a natively visible window. */
export function initializeVisualActivity(): () => void {
  const bridge = window.bytune;
  let native: WindowActivity | null = null;
  const update = (): void => {
    const visible = document.visibilityState !== "hidden";
    const state = native?.state ?? (bridge ? "hidden" : activityState({ visible, minimized: false, focused: document.hasFocus() }));
    const windowVisible = native ? native.visible && !native.minimized : !bridge && visible;
    const active = windowVisible && visible && state === "focused";
    document.documentElement.dataset.windowActivity = state;
    document.documentElement.dataset.visualActive = String(active);
    document.documentElement.dataset.visualVisible = String(windowVisible);
    visualActivity.setActive(active);
    visibleActivity.setActive(windowVisible);
  };
  update();
  const off = bridge ? observeWindowActivity(bridge, (state) => { native = state; update(); }) : () => {};
  document.addEventListener("visibilitychange", update);
  // Browser-only development has no native window lifecycle.
  if (!bridge) {
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
  }
  const dispose = (): void => {
    off();
    document.removeEventListener("visibilitychange", update);
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    window.removeEventListener("pagehide", dispose);
    visualActivity.setActive(false);
    visibleActivity.setActive(false);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
