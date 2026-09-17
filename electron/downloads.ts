/**
 * Download manager — a real queue:
 *
 *   - enqueue(): one door into the queue; a track already saved, queued or
 *     running is left alone rather than duplicated
 *   - concurrency capped at 2 so the stream proxy and the network stay healthy
 *   - cancel() aborts an in-flight transfer (partial file removed) or dequeues
 *   - progress + lifecycle events stream to the renderer over download:event
 *
 * Metadata/cover embedding is deliberately not attempted — it needs a tagger
 * dependency; see FEATURE_PARITY.md (marked BLOCKED rather than faked).
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { resolveStream } from "./music-service";
import type { Track } from "../src/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_CONCURRENT = 2;

type QueueState =
  | { phase: "queued" }
  | { phase: "running"; downloaded: number; total: number }
  | { phase: "failed"; reason: string };

const queue: { track: Track; dir?: string; maxKbps?: number; exportCompat?: boolean }[] = [];
const state = new Map<string, QueueState>();
const controllers = new Map<string, AbortController>();
let active = 0;
const workers = new Set<Promise<void>>();
let resetTask: Promise<void> | null = null;

/** Stop the queue and await partial-file cleanup; completed audio is retained. */
export function resetDownloads(): Promise<void> {
  if (resetTask) return resetTask;
  resetTask = Promise.resolve().then(async () => {
    await Promise.allSettled([...workers]);
    state.clear();
  }).finally(() => { resetTask = null; });
  // Stop producers synchronously at invocation, before any awaited cleanup.
  const queued = queue.splice(0);
  for (const ctrl of controllers.values()) ctrl.abort();
  for (const item of queued) emit({ type: "cancelled", id: item.track.id });
  return resetTask;
}

// Stream resolution has no AbortSignal API. Stop waiting immediately on reset;
// its eventual resolution/rejection is consumed, with no download side effects.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export interface DownloadEvent {
  type: "queued" | "start" | "progress" | "done" | "failed" | "cancelled";
  id: string;
  downloaded?: number;
  total?: number;
  path?: string;
  reason?: string;
}

type Listener = (e: DownloadEvent) => void;
const listeners = new Set<Listener>();

function emit(e: DownloadEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* listener errors never break the queue */
    }
  }
}

export function isDownloading(id: string): boolean {
  return queue.some((q) => q.track.id === id) || state.has(id);
}

export function queueSnapshot(): { id: string; phase: string; downloaded?: number; total?: number; reason?: string }[] {
  const out: { id: string; phase: string; downloaded?: number; total?: number; reason?: string }[] = [];
  for (const q of queue) out.push({ id: q.track.id, phase: "queued" });
  for (const [id, st] of state) {
    if (st.phase === "queued") out.push({ id, phase: "queued" });
    else if (st.phase === "running") out.push({ id, phase: "running", downloaded: st.downloaded, total: st.total });
    else out.push({ id, phase: "failed", reason: st.reason });
  }
  return out;
}

export async function defaultDownloadDir(): Promise<string> {
  return path.join(app.getPath("downloads"), "ByTune");
}

/**
 * Export-compatible location: the OS music library, so other players and
 * the user can reach the files — the desktop equivalent of mobile's shared
 * `Music/BitChord` (vs the app download folder above).
 */
export function exportDownloadDir(): string {
  return path.join(app.getPath("music"), "ByTune");
}

/** Exported for security regression tests — the production path is internal. */
export function sanitizeFilename(name: string): string {
  // Bidi/format controls (U+202A–U+202E etc.) would let a hostile title
  // visually masquerade the file extension in Explorer.
  const s = name.replace(/[\\/:*?"<>|\x00-\x1f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "_").replace(/\s+/g, " ").trim();
  const bounded = (s || "track").slice(0, 120);
  // A stem that is exactly a reserved Windows device name fails or misbehaves
  // on write — pad it so it becomes an ordinary file name.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(bounded) ? `_${bounded}` : bounded;
}

function uniquePath(dir: string, base: string): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let candidate = path.join(dir, base);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

/** Register a listener for lifecycle events (the renderer bridge forwards). */
export function addDownloadListener(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Queue a track. Throws when it is already saved, queued or running — the
 * caller decides what that means for its own UI.
 */
export function enqueueDownload(track: Track, dirOverride?: string, maxKbps?: number, exportCompat?: boolean): "queued" {
  if (resetTask) throw new Error("Downloads reset in progress");
  if (isDownloading(track.id)) throw new Error("Already downloading this track");
  queue.push({ track, dir: dirOverride, maxKbps, exportCompat: exportCompat === true });
  state.set(track.id, { phase: "queued" });
  emit({ type: "queued", id: track.id });
  void drain();
  return "queued";
}

export function cancelDownload(id: string): boolean {
  const qi = queue.findIndex((q) => q.track.id === id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    state.delete(id);
    emit({ type: "cancelled", id });
    return true;
  }
  const ctrl = controllers.get(id);
  if (ctrl) {
    ctrl.abort(); // the transfer's catch handles cleanup + event
    return true;
  }
  return false;
}

async function drain(): Promise<void> {
  // Workers pull from the shared queue up to the concurrency cap.
  while (!resetTask && active < MAX_CONCURRENT) {
    const next = queue.shift();
    if (!next) break;
    active++;
    const worker = runDownload(next.track, next.dir, next.maxKbps, next.exportCompat)
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (reason !== "cancelled") {
          // The failure is terminal for this attempt: drop the queue's own
          // bookkeeping entry so isDownloading() goes false and the track can
          // be queued again immediately. (The renderer's download registry
          // keeps the failed state for the UI; leaving the entry here made
          // every retry throw "Already downloading this track" until restart.)
          state.delete(next.track.id);
          emit({ type: "failed", id: next.track.id, reason });
        }
      })
      .finally(() => {
        active--;
        workers.delete(worker);
        if (queue.length > 0) void drain();
      });
    workers.add(worker);
  }
}

async function runDownload(track: Track, dirOverride?: string, maxKbps?: number, exportCompat?: boolean): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(track.id, ctrl);
  let dest = "";
  let ownsPartial = false;
  const checkCancelled = (): void => { if (ctrl.signal.aborted) throw new Error("cancelled"); };
  try {
    const dir = exportCompat ? exportDownloadDir() : dirOverride && dirOverride.trim() ? dirOverride : await defaultDownloadDir();
    checkCancelled();
    await fs.promises.mkdir(dir, { recursive: true });
    checkCancelled();

    // Downloads ask for an mp4/AAC rendition (the most portable container);
    // the resolver still falls back to the best available if a track has none,
    // so name the file from the mime it actually returned.
    const stream = await abortable(resolveStream(track.id, false, maxKbps, true), ctrl.signal);
    checkCancelled();
    const ext = /webm|opus/i.test(stream.mime) ? ".webm" : ".m4a";
    dest = uniquePath(dir, `${sanitizeFilename(`${track.artist} - ${track.title}`)}${ext}`);

    const res = await fetch(stream.url, {
      headers: { "User-Agent": UA, Range: "bytes=0-" },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    checkCancelled();
    // Exclusive creation prevents a competing download/user file from being
    // overwritten or later deleted by cancellation cleanup.
    const fd = fs.openSync(dest, "wx");
    ownsPartial = true;
    const out = fs.createWriteStream(dest, { fd });
    const src = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
    emit({ type: "start", id: track.id });
    state.set(track.id, { phase: "running", downloaded: 0, total });

    let downloaded = 0;
    let lastEmit = 0;
    src.on("data", (chunk: Buffer) => {
      if (ctrl.signal.aborted) return;
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        state.set(track.id, { phase: "running", downloaded, total });
        emit({ type: "progress", id: track.id, downloaded, total });
      }
    });

    await pipeline(src, out, { signal: ctrl.signal });
    ownsPartial = false; // A completed audio file belongs to the user now.
    checkCancelled();
    state.delete(track.id);
    emit({ type: "done", id: track.id, path: dest });
  } catch (err) {
    // Remove a partial file so we don't leave broken audio behind. Completed
    // files from before this transfer are never touched.
    if (dest && ownsPartial) {
      try {
        await fs.promises.unlink(dest);
      } catch {
        /* ignore */
      }
    }
    if (ctrl.signal.aborted) {
      state.delete(track.id);
      emit({ type: "cancelled", id: track.id });
      throw new Error("cancelled");
    }
    throw err;
  } finally {
    controllers.delete(track.id);
  }
}
