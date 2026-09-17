/**
 * Record-level merge for synced stores — pure functions, unit-testable.
 *
 * Philosophy: the store-level "newest wins" rule is safe for whole-store
 * replacement, but when BOTH sides changed since the last sync we merge
 * records where semantics allow it (likes, playlists, history, searches,
 * skip tallies) so independent edits on two devices survive. Device-owned
 * fields (download registry, machine paths) never travel to the cloud at
 * all — merge re-attaches the local copy untouched.
 *
 * All functions operate on the zustand-persist envelope: { state, version }.
 * Inputs may be arbitrary JSON (never trusted) — every function defensively
 * falls back to the local copy when a payload has the wrong shape.
 */

import { readDeletionSync, joinDeletionSync, compactDeletionSync, mergeDeletionRecords,
  membershipSurvives, searchKey } from "../src/lib/deletion-sync";

type Envelope = { state?: Record<string, unknown>; version?: number } | null | unknown;

function stateOf(payload: Envelope): Record<string, unknown> {
  if (payload && typeof payload === "object" && (payload as any).state && typeof (payload as any).state === "object") {
    return (payload as any).state as Record<string, unknown>;
  }
  return {};
}

function envelope(state: Record<string, unknown>, version = 0): { state: Record<string, unknown>; version: number } {
  return { state, version };
}

/** Never downgrade a zustand envelope (library's existing schema is v1). */
function mergedVersion(a: Envelope, b: Envelope, minimum = 0): number {
  const valid = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  return Math.max(minimum, valid((a as any)?.version), valid((b as any)?.version));
}

const trackId = (t: any): string => (t && typeof t === "object" && typeof t.id === "string" ? t.id : "");

/* ------------------------------------------------------------------ */
/* Library — liked, playlists, folders, follows, history               */
/* ------------------------------------------------------------------ */

/**
 * Merge two library states using explicit membership timestamps. Absence is
 * not deletion; legacy records union. Adds order newest-first, stable id ties;
 * metadata edits resolve by timestamp then canonical JSON. `downloads` and
 * other device-owned fields come only from `localDevice` — the cloud copy
 * can never overwrite or inject them.
 */
export function mergeLibrary(
  localPayload: Envelope,
  remotePayload: Envelope,
  localDevice: Record<string, unknown>
): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);

  const am = readDeletionSync(local.deletionSync), bm = readDeletionSync(remote.deletionSync);
  const joined = joinDeletionSync(am, bm);
  const liked = mergeDeletionRecords(local.liked, remote.liked, am, bm, joined, "liked", trackId);
  const history = mergeDeletionRecords(local.history, remote.history, am, bm, joined, "history", trackId, undefined, 200);
  const folders = mergeDeletionRecords(local.folders, remote.folders, am, bm, joined, "folders", trackId);
  const followedArtists = mergeDeletionRecords(local.followedArtists, remote.followedArtists, am, bm, joined, "followedArtists", trackId);
  const localPlaylists = Array.isArray(local.playlists) ? local.playlists : [];
  const remotePlaylists = Array.isArray(remote.playlists) ? remote.playlists : [];
  // Track contents are merged independently, not part of the metadata tie
  // breaker (otherwise unioning children could change the next merge winner).
  const metadata = (items: any[]) => items.filter((item) => trackId(item)).map(({ tracks: _tracks, ...item }) => item);
  const playlists = mergeDeletionRecords<any>(metadata(localPlaylists), metadata(remotePlaylists), am, bm, joined, "playlists", trackId)
    .map((p) => {
      // A deleted/rejected parent cannot supply old children on recreation.
      const tracks = (items: any[], meta: typeof am) => membershipSurvives(meta, joined, "playlists", p.id)
        ? items.filter((item) => trackId(item) === p.id).flatMap((item) => Array.isArray(item.tracks) ? item.tracks : []) : [];
      const next = { ...p, tracks: mergeDeletionRecords(tracks(localPlaylists, am), tracks(remotePlaylists, bm),
        am, bm, joined, "tracks", trackId, p.id) };
      // Deleted folders unfile, never delete their playlists.
      if (next.folderId && !folders.some((f) => f.id === next.folderId)) delete next.folderId;
      return next;
    });

  // Shortcut flags retain the existing local-preference policy.
  const pinnedSingles = {
    liked: true,
    downloads: true,
    local: true,
    ...((remote.pinnedSingles as object) ?? {}),
    ...((local.pinnedSingles as object) ?? {}),
  };

  const state = {
    ...remote, ...local, liked, history, playlists, folders, followedArtists, pinnedSingles,
    // Device-owned: always the local copy, never the cloud's.
    downloads: localDevice.downloads ?? local.downloads ?? {},
  };
  return envelope({ ...state, deletionSync: compactDeletionSync(joined, state) }, mergedVersion(localPayload, remotePayload, 1));
}

/* ------------------------------------------------------------------ */
/* Listening signals — skip tallies, take the max per artist           */
/* ------------------------------------------------------------------ */

export function mergeListening(localPayload: Envelope, remotePayload: Envelope): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);
  const a = (local.skips ?? {}) as Record<string, { count?: number; updatedAt?: number }>;
  const b = (remote.skips ?? {}) as Record<string, { count?: number; updatedAt?: number }>;
  const skips: Record<string, { count: number; updatedAt: number }> = {};
  for (const [artist, entry] of Object.entries({ ...a, ...b })) {
    const la = a[artist];
    const rb = b[artist];
    const count = Math.max(la?.count ?? 0, rb?.count ?? 0);
    if (count <= 0) continue;
    skips[artist] = { count, updatedAt: Math.max(la?.updatedAt ?? 0, rb?.updatedAt ?? 0) };
  }
  return envelope({
    ...remote,
    ...local,
    skips,
    version: Math.max(Number(local.version) || 0, Number(remote.version) || 0),
  }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* Recent searches — versioned membership, newest addition first       */
/* ------------------------------------------------------------------ */

export function mergeRecentSearches(localPayload: Envelope, remotePayload: Envelope): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);
  const am = readDeletionSync(local.deletionSync), bm = readDeletionSync(remote.deletionSync);
  const joined = joinDeletionSync(am, bm);
  const searches = mergeDeletionRecords<string>(local.searches, remote.searches, am, bm, joined, "searches",
    (q) => typeof q === "string" ? searchKey(q) : "", undefined, 8);
  const state = { ...remote, ...local, searches };
  return envelope({ ...state, deletionSync: compactDeletionSync(joined, state) }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* Settings — newest wins for account fields, device fields preserved  */
/* ------------------------------------------------------------------ */

/** Fields that describe THIS machine — stripped before upload, never pulled. */
export const DEVICE_SETTINGS_FIELDS = ["downloadDir", "localMusicFolder"] as const;

export function stripDeviceSettings(payload: Envelope): { state: Record<string, unknown>; version: number } {
  const state = stateOf(payload);
  const clean = { ...state };
  for (const f of DEVICE_SETTINGS_FIELDS) delete clean[f];
  return envelope(clean, Number((payload as any)?.version) || 0);
}

export function mergeSettings(
  localPayload: Envelope,
  remotePayload: Envelope,
  localDevice: Record<string, unknown>
): { state: Record<string, unknown>; version: number } {
  const remote = stripDeviceSettings(remotePayload);
  const local = stateOf(localPayload);
  return envelope({ ...remote.state, ...local, ...localDevice }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* sync-meta — merge the running session's mirror with the disk copy   */
/* ------------------------------------------------------------------ */

export interface SyncMetaEntry {
  syncedAt: number;
  changedAt: number;
}

export interface SyncMetaSnapshot {
  stores: Record<string, SyncMetaEntry>;
  lastUserId?: string;
}

/**
 * mergeSyncMeta(disk, memory) → the meta a sync run should use. Per store the
 * FRESHEST timestamps win: `changedAt` records "this store has local edits the
 * cloud has not seen", so letting a stale on-disk copy roll it backwards is
 * exactly how a store edited moments before a concurrent sync stops looking
 * modified — and a stale cloud copy then wins the next pull comparison.
 * `lastUserId` comes from memory, which reflects any runtime account switch.
 */
export function mergeSyncMeta(disk: SyncMetaSnapshot, memory: SyncMetaSnapshot): SyncMetaSnapshot {
  const stores: Record<string, SyncMetaEntry> = {};
  const names = new Set([...Object.keys(disk.stores ?? {}), ...Object.keys(memory.stores ?? {})]);
  for (const name of names) {
    const a = disk.stores?.[name];
    const b = memory.stores?.[name];
    stores[name] = {
      syncedAt: Math.max(a?.syncedAt ?? 0, b?.syncedAt ?? 0),
      changedAt: Math.max(a?.changedAt ?? 0, b?.changedAt ?? 0),
    };
  }
  return { stores, lastUserId: memory.lastUserId ?? disk.lastUserId };
}
