import { SYNCED_STORES } from "../src/lib/config";
import { artworkUrlOk } from "../src/lib/artwork";

export const MAX_CLOUD_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const invalid = (): never => { throw new Error("Invalid cloud backup data."); };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 16_384;
const id = (v: unknown): v is string => text(v) && v.length > 0 && v.length <= 1024 && !forbidden.has(v);
const timestamp = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function boundedJson(value: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 24) invalid();
    if (v === null || typeof v === "boolean") bytes += 5;
    else if (typeof v === "number") { if (!Number.isFinite(v)) invalid(); bytes += 24; }
    else if (typeof v === "string") {
      if (v.length > MAX_CLOUD_PAYLOAD_BYTES) invalid();
      bytes += Buffer.byteLength(JSON.stringify(v), "utf8");
    } else if (Array.isArray(v)) {
      if (v.length > 50_000) invalid();
      bytes += v.length + 2;
      for (const item of v) visit(item, depth + 1);
    } else if (object(v)) {
      bytes += 2;
      for (const [key, item] of Object.entries(v)) {
        if (forbidden.has(key) || key.length > 1024) invalid();
        bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        visit(item, depth + 1);
      }
    } else invalid();
    if (bytes > MAX_CLOUD_PAYLOAD_BYTES) invalid();
  };
  visit(value, 0);
}

function records(value: unknown, check: (record: Record<string, any>) => boolean): void {
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  for (const entry of value as any[]) {
    if (!object(entry) || !id(entry.id) || seen.has(entry.id) || !check(entry)) invalid();
    seen.add(entry.id);
  }
}

/** Validate the complete response before any store is replaced. */
export function validateCloudRows(value: unknown, dated: boolean): Array<{ store_name: string; payload: any; updated_at?: string }> {
  if (!Array.isArray(value) || value.length > SYNCED_STORES.length) invalid();
  const seen = new Set<string>();
  for (const row of value as any[]) {
    if (!object(row) || !(SYNCED_STORES as readonly string[]).includes(row.store_name) || seen.has(row.store_name)) invalid();
    seen.add(row.store_name);
    if (dated && (typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at)))) invalid();
    validateCloudPayload(row.store_name, row.payload);
  }
  return value as Array<{ store_name: string; payload: any; updated_at?: string }>;
}

export function validateCloudPayload(name: string, payload: unknown): void {
  boundedJson(payload);
  if (!object(payload) || !object(payload.state) || (payload.version !== undefined && !timestamp(payload.version))) invalid();
  const state = (payload as Record<string, any>).state;
  const track = (t: Record<string, any>): boolean => text(t.title) && text(t.artist) && text(t.thumb)
    && typeof t.duration === "number" && Number.isFinite(t.duration) && t.duration >= 0;
  // Thumbs come from a hostile-able source (a compromised other session or a
  // shared backup). Scheme-unsafe URLs are stripped in place rather than
  // rejecting the row — the pull self-heals instead of losing the whole sync,
  // and a non-web URL can never reach <img src>.
  const stripUnsafeThumbs = (records: unknown): void => {
    for (const record of Array.isArray(records) ? records : []) {
      if (object(record) && typeof record.thumb === "string" && record.thumb !== "" && !artworkUrlOk(record.thumb)) {
        record.thumb = "";
      }
    }
  };
  if (name === "library") {
    // The download registry is device-owned (local file paths + per-machine
    // state, stripped before upload) and must never arrive from the cloud:
    // a planted copy would hydrate into the renderer's download view and be
    // pushed back up on the next local write. Same policy as the device
    // settings fields below.
    delete state.downloads;
    for (const key of ["liked", "history"]) {
      stripUnsafeThumbs(state[key]);
      if (state[key] !== undefined) records(state[key], track);
    }
    if (state.playlists !== undefined) {
      for (const p of Array.isArray(state.playlists) ? state.playlists : []) {
        if (object(p)) stripUnsafeThumbs(p.tracks);
      }
      records(state.playlists, (p) => {
        if (!text(p.name) || !timestamp(p.createdAt) || !Array.isArray(p.tracks)) return false;
        records(p.tracks, track);
        return (p.folderId === undefined || id(p.folderId)) && (p.pinned === undefined || typeof p.pinned === "boolean");
      });
    }
    if (state.folders !== undefined) records(state.folders, (f) => text(f.name) && timestamp(f.createdAt));
    if (state.followedArtists !== undefined) records(state.followedArtists, (a) => text(a.name) && timestamp(a.followedAt));
    if (state.pinnedSingles !== undefined && (!object(state.pinnedSingles) || Object.values(state.pinnedSingles).some((v) => typeof v !== "boolean"))) invalid();
  } else if (name === "recent-searches") {
    if (state.searches !== undefined && (!Array.isArray(state.searches) || state.searches.some((q: unknown) => !text(q)))) invalid();
  } else if (name === "listening-signals") {
    if (state.skips !== undefined && (!object(state.skips) || Object.values(state.skips).some((v) => !object(v) || !timestamp(v.count) || !timestamp(v.updatedAt)))) invalid();
    if (state.version !== undefined && !timestamp(state.version)) invalid();
  } else if (name === "settings") {
    for (const [key, v] of Object.entries(state)) {
      // Device-owned fields must never arrive from the cloud: strip them so a
      // hostile row cannot plant a path on a fresh machine (local values are
      // re-attached by the device merge, and consumption re-gates anyway).
      if (["downloadDir", "localMusicFolder"].includes(key)) {
        delete state[key];
        continue;
      }
      if (["downloadQuality", "streamingQuality"].includes(key)) {
        const allowed = key === "downloadQuality" ? ["standard", "high", "lossless"] : ["low", "medium", "high", "lossless"];
        if (typeof v !== "string" || !allowed.includes(v)) invalid();
      } else if (key === "crossfadeSeconds" || key === "playbackSpeed") {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > (key === "playbackSpeed" ? 2 : 30)) invalid();
      } else if (typeof v !== "boolean") invalid();
    }
  } else invalid();
}
