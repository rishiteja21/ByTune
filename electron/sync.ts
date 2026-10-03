/**
 * Cloud backup — replicates the synced renderer stores to Supabase for
 * signed-in users. The local copy is always the working source of truth:
 * writes push out (debounced), sign-in merges/pulls in. Cloud request
 * failure is never treated as "empty account" — local data is kept, the
 * failure is surfaced in sync status, and pushes retry. Any pull that
 * overwrites local data writes a backup of the losing version to
 * userData/data/backups first, so sync can never silently destroy data.
 *
 * Device-owned data (download registry, machine paths) is stripped before
 * upload and re-attached from the local copy on pull — it never travels.
 *
 * Account switching: sync-meta records the last account that synced here.
 * Signing in as a DIFFERENT account wipes local account-owned stores first
 * (they're safe in the previous account's cloud space) so data can never
 * leak from account A into account B. Guest → first account keeps local
 * data and migrates it up.
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as persist from "./persist";
import { serializeData } from "./data-transition";
import { validateCloudRows } from "./cloud-payload";
import { authenticatedUserId, readProfile, sessionInfo } from "./supabase";
import * as stats from "./stats";
import { SYNCED_STORES } from "../src/lib/config";
import { mergeArtistMeta, mergeLibrary, mergeListening, mergeListeningHistory, mergeRecentSearches, mergeSettings, mergeSyncMeta, stripDeviceSettings } from "./sync-merge";
import type { SupabaseClient } from "@supabase/supabase-js";

type SbClient = SupabaseClient<any, "public", any>;

const PUSH_DEBOUNCE_MS = 10_000;
const RETRY_MS = 30_000;

let clientRef: (() => SbClient | null) | null = null;
let notifyRestored: ((stores: string[], seq: number) => void) | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncAt: number | null = null;
let lastError: string | null = null;
let syncing = false;
let restoreSeq = 0;
let restoredStores: string[] = [];

interface StoreMeta {
  syncedAt: number;
  changedAt: number;
}
interface SyncMeta {
  stores: Record<string, StoreMeta>;
  lastUserId?: string;
}

/** In-memory mirror of sync-meta — updated on every local write. */
let meta: SyncMeta = { stores: {} };

export function bindClient(get: () => SbClient | null): void {
  clientRef = get;
}

export function bindRestoredNotifier(fn: (stores: string[], seq: number) => void): void {
  notifyRestored = fn;
}

function noteRestored(stores: string[]): void {
  if (stores.length === 0) return;
  restoredStores = stores;
  restoreSeq += 1;
  try {
    notifyRestored?.(stores, restoreSeq);
  } catch {
    /* window gone */
  }
}

function loadMeta(): SyncMeta {
  const raw = persist.readData("sync-meta") as unknown;
  if (!raw || typeof raw !== "object") return { stores: {} };
  const obj = raw as Record<string, unknown>;
  // Legacy shape: { [storeName]: number } — migrate it.
  const stores: Record<string, StoreMeta> = {};
  if (obj.stores && typeof obj.stores === "object") {
    for (const [k, v] of Object.entries(obj.stores as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const m = v as Record<string, unknown>;
        stores[k] = { syncedAt: Number(m.syncedAt) || 0, changedAt: Number(m.changedAt) || 0 };
      }
    }
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "lastUserId") continue;
      if (typeof v === "number") stores[k] = { syncedAt: v, changedAt: 0 };
    }
  }
  return { stores, lastUserId: typeof obj.lastUserId === "string" ? obj.lastUserId : undefined };
}

/**
 * Meta reaches disk immediately. `changedAt` is what tells the next boot
 * "this store has local edits the cloud has not seen" — a debounced (or
 * lost-at-quit) save is precisely how a stale cloud copy could overwrite
 * newer local data on the next start. The file is tiny and store writes are
 * user-frequency (never per-timeupdate), so there is nothing to debounce.
 */
function saveMeta(): void {
  persist.writeDataSync("sync-meta", meta);
}

/** Called inside the transition queue after outgoing work has completed. */
export function resetSyncState(userId?: string): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  meta = { stores: {}, lastUserId: userId };
  lastSyncAt = null;
  lastError = null;
  restoredStores = [];
  saveMeta();
}

/**
 * Synchronous meta flush for app quit. The async save above usually lands,
 * but quit can beat it — and `before-quit` cannot await async work. This
 * guarantees every local edit made this session is recorded as unsynced
 * (changedAt > syncedAt) before the process exits, so the next boot PUSHES
 * the change instead of letting the pull comparison overwrite it. Never
 * throws; the worst case (meta file lost) degrades to "push everything",
 * never to "cloud wins over newer local data".
 */
export function flushMetaSync(): void {
  try {
    persist.writeDataSync("sync-meta", meta);
  } catch (err) {
    console.warn("[bytune] sync-meta flush failed:", err instanceof Error ? err.message : err);
  }
}

function storeMeta(name: string): StoreMeta {
  return meta.stores[name] ?? { syncedAt: 0, changedAt: 0 };
}

export function isSyncedStore(name: string): boolean {
  return (SYNCED_STORES as readonly string[]).includes(name);
}

export type SyncState = "idle" | "syncing" | "pending" | "error";

export function syncStatus(): {
  mode: string | null;
  lastSyncAt: number | null;
  restoreSeq: number;
  restoredStores: string[];
  state: SyncState;
  lastError: string | null;
  pending: number;
} {
  const state: SyncState = syncing
    ? "syncing"
    : lastError
      ? "error"
      : timers.size > 0
        ? "pending"
        : "idle";
  return {
    mode: sessionInfo().mode,
    lastSyncAt,
    restoreSeq,
    restoredStores,
    state,
    lastError,
    pending: timers.size,
  };
}

/** Called by main.ts on every renderer store write. */
export function noteLocalWrite(name: string): void {
  if (!isSyncedStore(name)) return;
  if (sessionInfo().mode !== "account") return;
  const m = storeMeta(name);
  meta.stores[name] = { ...m, changedAt: Date.now() };
  saveMeta();
  schedulePush(name);
}

function schedulePush(name: string, delayMs = PUSH_DEBOUNCE_MS): void {
  const prev = timers.get(name);
  if (prev) clearTimeout(prev);
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      void serializeData(() => pushStore(name)).catch((err) => onSyncFailure(err, name));
    }, delayMs)
  );
}

/** A failed push never drops the change — surface it and retry later. */
function onSyncFailure(err: unknown, name?: string): void {
  lastError = err instanceof Error ? err.message : String(err);
  console.warn(`[bytune] sync${name ? ` ${name}` : ""} failed (will retry):`, lastError);
  if (!retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushPending();
    }, RETRY_MS);
  }
}

/**
 * Record a sync failure that happened outside the push path (a sign-in or
 * sign-out backup), so the account card reports an error instead of silently
 * claiming "Synced" over data that never reached the cloud.
 */
export function noteSyncFailure(err: unknown): void {
  lastError = err instanceof Error ? err.message : String(err);
}

/** Device-owned fields never leave the machine. */
function stripForUpload(name: string, data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const envelope = data as { state?: Record<string, unknown>; version?: number };
  if (!envelope.state) return data;
  if (name === "library") {
    const { downloads: _drop, ...keep } = envelope.state;
    return { ...envelope, state: keep };
  }
  if (name === "settings") return stripDeviceSettings(data);
  if (name === "listening-history") return stats.fitForSync(data as { state?: { buckets?: unknown } });
  return data;
}

/** Local device-owned fields, re-attached after any pull. */
function localDeviceState(name: string): Record<string, unknown> {
  const local = persist.readData(name) as { state?: Record<string, unknown> } | null;
  const state = local?.state ?? {};
  if (name === "library") return { downloads: state.downloads ?? {} };
  if (name === "settings") {
    const out: Record<string, unknown> = {};
    for (const f of ["downloadDir", "localMusicFolder"]) {
      if (state[f] !== undefined) out[f] = state[f];
    }
    return out;
  }
  return {};
}

/** Merge a fresh cloud payload into the local store when both sides changed. */
function mergeStore(name: string, local: unknown, remote: unknown): { state: Record<string, unknown>; version: number } | null {
  const localDevice = localDeviceState(name);
  switch (name) {
    case "library":
      return mergeLibrary(local, remote, localDevice);
    case "listening-signals":
      return mergeListening(local, remote);
    case "listening-history":
      return mergeListeningHistory(local, remote);
    case "artist-meta-cache":
      return mergeArtistMeta(local, remote);
    case "recent-searches":
      return mergeRecentSearches(local, remote);
    case "settings":
      return mergeSettings(local, remote, localDevice);
    default:
      return null;
  }
}

async function backupsDir(): Promise<string> {
  const dir = path.join(app.getPath("userData"), "data", "backups");
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Every local store write goes through here so the Replay module can drop its
 * in-memory bucket cache when the file it mirrors was just replaced by a
 * restore or an account switch — otherwise its next flush would write the
 * stale copy back over freshly restored data.
 */
async function writeLocalStore(name: string, data: unknown): Promise<void> {
  await persist.writeData(name, data);
  if (name === "listening-history") stats.reloadStore();
}

async function backupStore(name: string, data: unknown): Promise<void> {
  try {
    const dir = await backupsDir();
    const file = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await fs.promises.writeFile(file, JSON.stringify(data), "utf-8");
    // Bound the snapshot directory: every merged store writes a file per sync,
    // so an adversarial account that flips values on each pull would otherwise
    // grow it indefinitely. Keep the newest few per store.
    const prefix = `${name}-`;
    const siblings = (await fs.promises.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
    for (const stale of siblings.slice(0, Math.max(0, siblings.length - 5))) {
      try {
        await fs.promises.unlink(path.join(dir, stale));
      } catch {
        /* best effort */
      }
    }
  } catch (err) {
    console.warn("[bytune] pre-merge backup failed:", err);
  }
}

async function pushStore(name: string, sb?: SbClient, userId?: string): Promise<void> {
  const sbc = sb ?? clientRef?.();
  // Cloud writes must act as a live, verified identity — never the stale
  // profile fallback (which can outlive a failed sign-in or an expiry).
  const uid = userId ?? authenticatedUserId();
  if (!sbc || !uid) return;
  const data = persist.readData(name);
  if (data == null) return;
  const { error } = await sbc.from("user_data").upsert(
    { user_id: uid, store_name: name, payload: stripForUpload(name, data), updated_at: new Date().toISOString() },
    { onConflict: "user_id,store_name" }
  );
  if (error) throw new Error(error.message);
  const m = storeMeta(name);
  meta.stores[name] = { syncedAt: Date.now(), changedAt: Date.now() };
  saveMeta();
  lastSyncAt = Date.now();
  lastError = null;
}

/**
 * Full two-way merge, run after sign-in / at boot. Per store:
 *  - only local → push up (guest migration, fresh edits)
 *  - only cloud  → pull down (new device, reset)
 *  - both        → record-level merge where semantics allow, else newest wins
 * Every overwrite of local data is backed up first.
 */
export function syncNow(): Promise<{ pushed: string[]; pulled: string[]; merged: string[] }> {
  return serializeData(syncNowExclusive);
}

export async function syncNowExclusive(): Promise<{ pushed: string[]; pulled: string[]; merged: string[] }> {
  const sbc = clientRef?.();
  const userId = authenticatedUserId();
  if (!sbc || !userId || syncing) return { pushed: [], pulled: [], merged: [] };
  syncing = true;
  // Track committed local changes separately from successful cloud uploads.
  const restored = new Set<string>();
  try {
    // Merge, never clobber: the in-memory mirror is authoritative for this
    // session, and reloading it from disk verbatim would roll changedAt back
    // for stores edited since the last meta save.
    const { data: rows, error } = await sbc
      .from("user_data")
      .select("store_name,payload,updated_at")
      .eq("user_id", userId);
    if (error) throw new Error("Cloud backup could not be read.");
    const validatedRows = validateCloudRows(rows, true);
    meta = mergeSyncMeta(loadMeta(), meta);
    if (meta.lastUserId && meta.lastUserId !== userId) {
      // Account switch — wipe local account-owned stores so A's data can
      // never leak into B. Everything is already backed up under A.
      for (const name of SYNCED_STORES) {
        const local = persist.readData(name);
        if (local != null) {
          await backupStore(name, local);
          await writeLocalStore(name, null);
        }
        // Already-empty stores must also reset the outgoing renderer state.
        restored.add(name);
        delete meta.stores[name];
      }
    }
    meta.lastUserId = userId;
    saveMeta();

    const cloud = new Map<string, { payload: unknown; updatedAt: number; sanitized: boolean }>();
    for (const row of validatedRows) {
      cloud.set(String(row.store_name), {
        payload: row.payload,
        updatedAt: new Date(String(row.updated_at)).getTime(),
        sanitized: row.sanitized === true,
      });
    }

    const pushed: string[] = [];
    const pulled: string[] = [];
    const merged: string[] = [];
    for (const name of SYNCED_STORES) {
      const local = persist.readData(name);
      const m = storeMeta(name);
      const remoteRow = cloud.get(name);
      const remote = remoteRow ? { payload: remoteRow.payload, updatedAt: remoteRow.updatedAt } : undefined;
      const cloudHealed = remoteRow?.sanitized === true;
      // A store that has never been synced but has local data counts as
      // locally changed — that's the guest→account migration case (its
      // local content must survive into the account, via merge).
      const localChanged = local != null && (m.changedAt > m.syncedAt || m.syncedAt === 0);
      const remoteChanged = remote != null && remote.updatedAt > m.syncedAt;

      if (local == null && remote) {
        // Nothing local — restore from the cloud.
        await writeLocalStore(name, remote.payload);
        restored.add(name);
        meta.stores[name] = { syncedAt: remote.updatedAt, changedAt: remote.updatedAt };
        pulled.push(name);
        // Validation dropped something from the cloud copy — push the healed
        // version back so the account stops carrying the damage.
        if (cloudHealed) await pushStore(name, sbc, userId);
        continue;
      }
      if (local == null || !remote) {
        if (local != null) {
          await pushStore(name, sbc, userId);
          pushed.push(name);
        }
        continue;
      }
      if (remoteChanged && localChanged) {
        // Both sides moved — merge records, back up both inputs first.
        await backupStore(name, local);
        await backupStore(name, remote.payload);
        const mergedEnvelope = mergeStore(name, local, remote.payload);
        const next = mergedEnvelope ?? (remote.updatedAt > m.syncedAt ? remote.payload : local);
        await writeLocalStore(name, next);
        restored.add(name);
        await pushStore(name, sbc, userId);
        meta.stores[name] = { syncedAt: Date.now(), changedAt: Date.now() };
        merged.push(name);
        continue;
      }
      if (remoteChanged) {
        // Cloud is newer: keep a local backup, take the cloud copy, re-attach
        // device fields.
        await backupStore(name, local);
        const device = localDeviceState(name);
        const remoteState = (remote.payload as { state?: Record<string, unknown> })?.state;
        let payload = remote.payload;
        if (remoteState && Object.keys(device).length > 0) {
          payload = { ...(remote.payload as object), state: { ...remoteState, ...device } };
        }
        await writeLocalStore(name, payload);
        restored.add(name);
        meta.stores[name] = { syncedAt: remote.updatedAt, changedAt: remote.updatedAt };
        pulled.push(name);
        if (cloudHealed) await pushStore(name, sbc, userId);
        continue;
      }
      if (localChanged) {
        await backupStore(name, remote.payload);
        await pushStore(name, sbc, userId);
        pushed.push(name);
      }
    }
    lastSyncAt = Date.now();
    lastError = null;
    return { pushed, pulled, merged };
  } finally {
    syncing = false;
    // A later write/upload failure must not hide earlier committed restores.
    noteRestored([...restored]);
  }
}

/** Manual "Back up now" — push every synced store immediately. */
export function backupNow(): Promise<void> { return serializeData(backupNowExclusive); }

async function backupNowExclusive(): Promise<void> {
  const sbc = clientRef?.();
  const userId = authenticatedUserId();
  if (!sbc || !userId) throw new Error("Sign in first.");
  for (const name of SYNCED_STORES) {
    await pushStore(name, sbc, userId);
  }
  lastSyncAt = Date.now();
  lastError = null;
}

/**
 * Manual "Restore from cloud" — cloud always wins (except device-owned
 * fields); every replaced local store is backed up first.
 */
export function restoreNow(): Promise<string[]> { return serializeData(restoreNowExclusive); }

async function restoreNowExclusive(): Promise<string[]> {
  const sbc = clientRef?.();
  const userId = authenticatedUserId();
  if (!sbc || !userId) throw new Error("Sign in first.");
  const { data: rows, error } = await sbc
    .from("user_data")
    .select("store_name,payload")
    .eq("user_id", userId);
  if (error) throw new Error("Cloud backup could not be read.");
  const validatedRows = validateCloudRows(rows, false);
  const pulled: string[] = [];
  try {
    for (const row of validatedRows) {
      const name = String(row.store_name);
      if (!isSyncedStore(name)) continue;
      const local = persist.readData(name);
      await backupStore(name, local);
      const device = localDeviceState(name);
      const remoteState = (row.payload as { state?: Record<string, unknown> })?.state;
      let payload = row.payload;
      if (remoteState && Object.keys(device).length > 0) {
        payload = { ...(row.payload as object), state: { ...remoteState, ...device } };
      }
      await writeLocalStore(name, payload);
      pulled.push(name);
      meta.stores[name] = { syncedAt: Date.now(), changedAt: Date.now() };
      // Heal the cloud copy too: a manual restore that had to drop records
      // leaves the sanitized version behind for every future sync.
      if (row.sanitized) await pushStore(name, sbc, userId);
    }
    saveMeta();
    lastSyncAt = Date.now();
    return pulled;
  } finally {
    noteRestored(pulled);
  }
}

/** Flush pending pushes right away (sign-out, quit, retry timer). */
export async function flushPending(): Promise<void> {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  for (const [, t] of timers) clearTimeout(t);
  timers.clear();
  try {
    if (sessionInfo().userId) await syncNow();
  } catch (err) {
    onSyncFailure(err);
  }
}
