import { useCallback, useRef, useSyncExternalStore } from "react";
import { createVisualActivity } from "./visualActivityCore";
import { activityState, observeWindowActivity, type WindowActivity } from "./windowActivity";

export const visualActivity = createVisualActivity();

export function useVisualActivity(): boolean {
  return useSyncExternalStore(visualActivity.subscribe, visualActivity.getSnapshot);
}

/** Hold a presentation snapshot while inactive; read the current source on
 * resume. The source keeps updating (in particular, the audio clock does). */
export function useVisualSnapshot<T>(subscribe: (notify: () => void) => () => void, read: () => T): T {
  const held = useRef(read());
  const getSnapshot = useCallback(() => {
    if (visualActivity.getSnapshot()) held.current = read();
    return held.current;
  }, [read]);
  const watch = useCallback((notify: () => void) => {
    const offSource = subscribe(() => { if (visualActivity.getSnapshot()) notify(); });
    const offActivity = visualActivity.subscribe(notify);
    return () => { offSource(); offActivity(); };
  }, [subscribe]);
  return useSyncExternalStore(watch, getSnapshot);
}

/** Called before rendering either app. Native focus, not document.hasFocus(),
 * is authoritative in Electron; page visibility is an additional veto. */
export function initializeVisualActivity(): () => void {
  const bridge = window.bytune;
  let native: WindowActivity | null = null;
  const update = (): void => {
    const visible = document.visibilityState !== "hidden";
    const state = native?.state ?? (bridge ? "hidden" : activityState({ visible, minimized: false, focused: document.hasFocus() }));
    const active = visible && state === "focused";
    document.documentElement.dataset.windowActivity = state;
    document.documentElement.dataset.visualActive = String(active);
    visualActivity.setActive(active);
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
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
