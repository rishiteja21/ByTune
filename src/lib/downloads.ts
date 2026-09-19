/** Download orchestration on the renderer side. */
import { useLibrary, type DownloadItem } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { requireBridge } from "./bridge";
import { staleDownloadIds } from "./download-reconcile";

export function getDownload(id: string): DownloadItem | undefined {
  return useLibrary.getState().downloads[id];
}

export function isDownloaded(id: string): boolean {
  return useLibrary.getState().downloads[id]?.status === "done";
}

export async function startDownload(track: Track, dirOverride?: string): Promise<void> {
  const lib = useLibrary.getState();
  const existing = lib.downloads[track.id];
  if (existing?.status === "downloading" || existing?.status === "queued") return;
  if (existing?.status === "done") {
    useUI.getState().toast("Already downloaded — see the Downloads view", "info");
    return;
  }

  lib.setDownload(track.id, {
    track,
    path: existing?.path ?? null,
    status: "queued",
    progress: 0,
    downloaded: 0,
    total: 0,
  });

  try {
    const s = useSettings.getState();
    const dir = dirOverride ?? s.downloadDir ?? undefined;
    // The main process queues it; lifecycle arrives over download:event.
    await requireBridge().startDownload(track, dir, s.downloadQuality, s.exportDownloads);
  } catch (err) {
    useLibrary.getState().patchDownload(track.id, { status: "failed", progress: 0 });
    useUI.getState().toast(
      `Download failed: ${err instanceof Error ? err.message : "unknown error"}`,
      "error"
    );
  }
}

export function cancelDownload(id: string): void {
  void window.bytune?.cancelDownload(id);
  useLibrary.getState().patchDownload(id, { status: "failed", progress: 0 });
}

/**
 * Per-id progress coalescer: keep the latest payload per id and apply it at
 * most once per tick. Main already throttles file progress to 250ms, but
 * every event used to patch the library store directly — re-rendering rows
 * and (before persist coalescing) rewriting the whole library at ~4Hz per
 * download. 500ms is still smooth for progress UI. Terminal events must
 * bypass the buffer (flush(id)) so state is never stale at completion.
 */
export function createProgressBuffer(
  apply: (id: string, downloaded: number, total: number) => void,
  tickMs: number
): { push: (id: string, downloaded: number, total: number) => void; flush: (id: string) => void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const args = new Map<string, { downloaded: number; total: number }>();
  return {
    push(id, downloaded, total) {
      args.set(id, { downloaded, total });
      if (timers.has(id)) return;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          const a = args.get(id);
          args.delete(id);
          if (a) apply(id, a.downloaded, a.total);
        }, tickMs)
      );
    },
    flush(id) {
      const t = timers.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(id);
      }
      args.delete(id);
    },
  };
}

/**
 * Boot reconciliation: the main process queue is memory-only, so registry
 * rows persisted as "queued"/"downloading" describe work that died with the
 * previous session — no event will ever update them, and startDownload
 * refuses to retry while a row claims to be active. Fail the stale rows
 * (failed stays retryable); rows still present in the live queue snapshot
 * are left alone.
 */
async function reconcileStaleDownloads(): Promise<void> {
  const bridge = window.bytune;
  if (!bridge?.downloadQueue) return;
  try {
    const snapshot = (await bridge.downloadQueue()) as { id?: unknown }[];
    const live = (Array.isArray(snapshot) ? snapshot : [])
      .map((row) => (typeof row?.id === "string" ? row.id : ""))
      .filter(Boolean);
    const lib = useLibrary.getState();
    for (const id of staleDownloadIds(lib.downloads, live)) {
      lib.patchDownload(id, { status: "failed", progress: 0 });
    }
  } catch {
    /* bridge unavailable — stale rows keep their status; cancel still works */
  }
}

/** Subscribe to queue lifecycle events from the main process. */
export function listenForDownloadProgress(): () => void {
  if (!window.bytune) return () => undefined;
  void reconcileStaleDownloads();
  const applyProgress = (id: string, downloaded: number, total: number): void => {
    useLibrary.getState().patchDownload(id, {
      status: "downloading",
      progress: total > 0 ? Math.min(1, downloaded / total) : 0,
      downloaded,
      total,
    });
  };
  const buffer = createProgressBuffer(applyProgress, 500);
  const offEvent = window.bytune.onDownloadEvent?.((e) => {
    const lib = useLibrary.getState();
    if (e.type === "start") {
      applyProgress(e.id, 0, 0);
    } else if (e.type === "progress") {
      buffer.push(e.id, e.downloaded ?? 0, e.total ?? 0);
    } else if (e.type === "done" && e.path) {
      buffer.flush(e.id);
      const item = lib.downloads[e.id];
      lib.setDownload(e.id, {
        track: item?.track ?? { id: e.id, title: e.id, artist: "", duration: 0, thumb: "" },
        path: e.path,
        status: "done",
        progress: 1,
        downloaded: 0,
        total: 0,
      });
      useUI.getState().toast("Download finished", "success");
    } else if (e.type === "failed") {
      buffer.flush(e.id);
      lib.patchDownload(e.id, { status: "failed", progress: 0 });
      useUI.getState().toast(`Download failed: ${e.reason ?? "unknown error"}`, "error");
    } else if (e.type === "cancelled") {
      buffer.flush(e.id);
      lib.patchDownload(e.id, { status: "failed", progress: 0 });
    }
  });
  // Legacy channel (kept for older event payloads).
  const offProgress = window.bytune.onDownloadProgress(({ id, downloaded, total }) => {
    buffer.push(id, downloaded, total);
  });
  return () => {
    offEvent?.();
    offProgress();
  };
}
