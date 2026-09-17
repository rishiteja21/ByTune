/** Renderer-side session state — mirrors the main process's local profile. */
import { create } from "zustand";
import { hasBridge } from "./bridge";

export interface SessionInfo {
  mode: "guest" | "account" | null;
  userId: string | null;
  username: string | null;
  freshInstall: boolean;
  /** Fresh Google sign-in still using the auto-generated username. */
  needsUsername?: boolean;
}

interface SessionState extends SessionInfo {
  loaded: boolean;
  refresh(): Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  mode: null,
  userId: null,
  username: null,
  freshInstall: false,
  needsUsername: false,
  loaded: false,
  refresh: async () => {
    try {
      const info = (await window.bytune?.authGetSession()) as SessionInfo | undefined;
      set({
        mode: info?.mode ?? null,
        userId: info?.userId ?? null,
        username: info?.username ?? null,
        freshInstall: info?.freshInstall === true,
        needsUsername: info?.needsUsername === true,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },
}));

/** Subscribe once (App mount) so auth changes anywhere re-render the gate. */
export function watchSession(): () => void {
  if (!hasBridge()) return () => undefined;
  const off = window.bytune!.onAuthChanged(() => void useSession.getState().refresh());
  void useSession.getState().refresh();
  return off;
}
