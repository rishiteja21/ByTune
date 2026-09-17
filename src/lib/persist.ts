/** Zustand storage adapter: JSON files via the desktop bridge, localStorage fallback. */
import type { StateStorage } from "zustand/middleware";

export const storage: StateStorage = {
  getItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        const v = await b.readData(name);
        return v == null ? null : JSON.stringify(v);
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, JSON.parse(value));
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      localStorage.setItem(name, value);
    } catch {
      /* ignore */
    }
  },
  removeItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, null);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Write-coalescing storage for high-frequency stores (player, library). The
 * audio engine updates `position` on every `timeupdate` (~4Hz) and download
 * progress patches the library several times a second — zustand persist
 * writes on every state change, and unthrottled that serializes the whole
 * store to disk (and over IPC) several times a second. A change lands
 * immediately when the last write was ≥2s ago; otherwise 2s after the FIRST
 * deferred change, so pending state never waits longer than the interval and
 * bursty user actions (play/queue edits after an idle stretch) still persist
 * at once. The pending value is flushed on pagehide/beforeunload — the last
 * reliable hooks before the window or the app goes away. Worst case is that
 * the resume position loses the final ≤2s, which is imperceptible.
 */
const COALESCED_WRITE_MS = 2_000;

export const coalescedStorage: StateStorage = (() => {
  const pending = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastWriteAt = 0;

  const flush = (name: string): void => {
    const t = timers.get(name);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(name);
    }
    const value = pending.get(name);
    if (value === undefined) return;
    pending.delete(name);
    lastWriteAt = Date.now();
    void storage.setItem(name, value);
  };

  if (typeof window !== "undefined") {
    const flushAll = (): void => {
      for (const name of [...pending.keys()]) flush(name);
    };
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("beforeunload", flushAll);
  }

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      pending.set(name, value);
      if (Date.now() - lastWriteAt >= COALESCED_WRITE_MS) {
        flush(name);
      } else if (!timers.has(name)) {
        timers.set(
          name,
          setTimeout(() => flush(name), COALESCED_WRITE_MS)
        );
      }
      return Promise.resolve();
    },
    removeItem: (name) => {
      // A removal must not be resurrected by a pending write.
      pending.delete(name);
      const t = timers.get(name);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(name);
      }
      return storage.removeItem(name);
    },
  };
})();
