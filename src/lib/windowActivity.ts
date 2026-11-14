/** Native state belongs to one BrowserWindow, never to the app as a whole. */
export interface WindowActivity {
  windowId: number;
  revision: number;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  state: "focused" | "unfocused" | "minimized" | "hidden";
}

export function activityState(flags: Pick<WindowActivity, "visible" | "focused" | "minimized">): WindowActivity["state"] {
  // Electron may report a minimized window as invisible too.
  return flags.minimized ? "minimized" : !flags.visible ? "hidden" : flags.focused ? "focused" : "unfocused";
}

export interface WindowActivityBridge {
  getWindowActivity(): Promise<WindowActivity>;
  onWindowActivity(cb: (state: WindowActivity) => void): () => void;
}

/** Subscribe before requesting the snapshot; a late reply cannot undo a newer event. */
export function observeWindowActivity(bridge: WindowActivityBridge, receive: (state: WindowActivity) => void): () => void {
  let disposed = false;
  let revision = -1;
  const accept = (state: WindowActivity): void => {
    if (disposed || state.revision <= revision) return;
    revision = state.revision;
    receive(state);
  };
  const off = bridge.onWindowActivity(accept);
  void bridge.getWindowActivity().then(accept).catch((error) => {
    // Stay visually inactive until a native event arrives. Never affect playback.
    if (!disposed) console.warn("[bytune] window activity unavailable:", error);
  });
  return () => { disposed = true; off(); };
}
