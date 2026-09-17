/**
 * Listening statistics.
 *
 * The renderer reports listened seconds per track on a play-event bus
 * (see src/lib/playEvents.ts); this module folds them into monthly JSON
 * buckets next to the other persisted stores:
 *
 *   stats/<YYYY-MM>.json = {
 *     month, tracks: {id → {title, artist, thumb, ms, plays, lastAt}},
 *     artists: {lowercased name → {name, ms, plays}},
 *     albums: {album key → {name, artist, ms, plays}},
 *     hours: number[24] (listening ms per hour of day),
 *     days: {"YYYY-MM-DD": ms}
 *   }
 *
 * A "play" is credited once per listen, when listened time crosses
 * min(max(duration/2, 30s), 4min) — the mobile ListeningRecorder rule, so a
 * looped track earns hours but a single play. Nothing here is inferred
 * beyond what was actually reported — no fake numbers.
 *
 * Retention mirrors mobile: 36 monthly files, 600 tracks / 400 artists+albums
 * per bucket, lowest-listened entries pruned first.
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { Track } from "../src/types";

export interface TrackEntry {
  title: string;
  artist: string;
  thumb: string;
  ms: number;
  plays: number;
  lastAt: number;
}
export interface NameEntry {
  name: string;
  artist?: string;
  ms: number;
  plays: number;
}
export interface MonthBucket {
  month: string;
  tracks: Record<string, TrackEntry>;
  artists: Record<string, NameEntry>;
  albums: Record<string, NameEntry>;
  hours: number[];
  days: Record<string, number>;
}

export type ReplayPeriod = "month" | "lastMonth" | "year" | "all";

export interface ReplaySummary {
  totalMs: number;
  plays: number;
  tracks: (TrackEntry & { id: string })[];
  artists: NameEntry[];
  albums: NameEntry[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: ReplayPeriod;
  months: string[];
}

const PLAY_FLOOR_MS = 30_000;
const PLAY_CEILING_MS = 4 * 60 * 1000;
/** Retention mirrors mobile (ListeningStats prune): 36 months on disk. */
const KEEP_MONTHS = 36;
const MAX_TRACKS = 600;
const MAX_NAMES = 400;
const FLUSH_EVERY_MS = 5000;

let ready = false;
let dir = "";
const open = new Map<string, MonthBucket>();
const pendingIds = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
/**
 * Play-count rule state, per mobile's ListeningRecorder: one play per track
 * once `playedMs >= min(max(duration/2, 30s), 4min)`. `ruleMs` accumulates
 * this listen; `ruleCounted` marks it credited. Both reset on track start
 * (see noteTrackStart) so replays count again but loops don't inflate.
 */
const ruleMs = new Map<string, number>();
const ruleCounted = new Set<string>();

/** A new listen of this track began — re-arm the one-play rule. */
export function noteTrackStart(trackId: string): void {
  if (!trackId) return;
  ruleMs.delete(trackId);
  ruleCounted.delete(trackId);
}

function dataDir(): string {
  return path.join(app.getPath("userData"), "data", "stats");
}

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lastMonthKey(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return monthKey(d);
}

function newBucket(month: string): MonthBucket {
  return { month, tracks: {}, artists: {}, albums: {}, hours: new Array(24).fill(0), days: {} };
}

function readBucket(month: string): MonthBucket {
  const file = path.join(dir, `${month}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as MonthBucket;
    if (raw && typeof raw === "object" && Array.isArray(raw.hours) && raw.hours.length === 24) {
      raw.tracks ??= {};
      raw.artists ??= {};
      raw.albums ??= {};
      raw.days ??= {};
      return raw;
    }
  } catch {
    /* absent or corrupt → fresh */
  }
  return newBucket(month);
}

function bucketFor(month: string): MonthBucket {
  let b = open.get(month);
  if (!b) {
    b = readBucket(month);
    open.set(month, b);
  }
  return b;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_EVERY_MS);
}

function writeBucket(month: string): void {
  const b = open.get(month);
  if (!b) return;
  pruneBucket(b);
  const file = path.join(dir, `${month}.json`);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(b));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn("[bytune] stats flush failed:", err instanceof Error ? err.message : err);
  }
}

async function flush(): Promise<void> {
  if (!ready) return;
  const ids = [...pendingIds];
  pendingIds.clear();
  for (const month of ids) writeBucket(month);
  pruneOldFiles();
}

/** Discard cached history before deleting its files; never flush the old session again. */
export function resetStats(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingIds.clear();
  open.clear();
  ruleMs.clear();
  ruleCounted.clear();
}

export function initStats(): void {
  if (ready) return;
  dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  ready = true;
}

/** Fold one span of listening into the buckets. */
export function recordListening(track: Track, listenedMs: number, at = new Date()): void {
  if (!ready || !track?.id || listenedMs <= 0) return;
  const month = monthKey(at);
  const b = bucketFor(month);
  const day = `${month}-${String(at.getDate()).padStart(2, "0")}`;

  const t = (b.tracks[track.id] ??= {
    title: track.title,
    artist: track.artist,
    thumb: track.thumb,
    ms: 0,
    plays: 0,
    lastAt: 0,
  });
  t.title = track.title;
  t.artist = track.artist;
  if (track.thumb) t.thumb = track.thumb;
  t.ms += listenedMs;
  t.lastAt = at.getTime();

  const key = (track.artist || "Unknown artist").toLowerCase();
  const a = (b.artists[key] ??= { name: track.artist || "Unknown artist", ms: 0, plays: 0 });
  a.name = track.artist || "Unknown artist";
  a.ms += listenedMs;

  if (track.album) {
    const ak = `${track.album.toLowerCase()}|${key}`;
    const al = (b.albums[ak] ??= { name: track.album, artist: track.artist, ms: 0, plays: 0 });
    al.ms += listenedMs;
  }

  b.hours[at.getHours()] += listenedMs;
  b.days[day] = (b.days[day] ?? 0) + listenedMs;

  // Play credit (mobile rule): a single play once this listen crosses
  // min(max(duration/2, floor), ceiling). ms always accrues; plays don't
  // inflate on loops — a 1-hour loop is 1 play, not 120.
  if (!ruleCounted.has(track.id)) {
    const listened = (ruleMs.get(track.id) ?? 0) + listenedMs;
    ruleMs.set(track.id, listened);
    const durMs = track.duration > 0 ? track.duration * 1000 : PLAY_FLOOR_MS;
    const threshold = Math.min(Math.max(durMs / 2, PLAY_FLOOR_MS), PLAY_CEILING_MS);
    if (listened >= threshold) {
      ruleCounted.add(track.id);
      t.plays += 1;
      a.plays += 1;
      if (track.album) b.albums[`${track.album.toLowerCase()}|${key}`].plays += 1;
    }
  }

  pendingIds.add(month);
  scheduleFlush();
}

function mergedBuckets(months: string[]): MonthBucket[] {
  return months.map((m) => bucketFor(m));
}

function monthsForPeriod(period: ReplayPeriod): string[] {
  const now = new Date();
  if (period === "month") return [monthKey(now)];
  if (period === "lastMonth") return [lastMonthKey()];
  if (period === "year") {
    const out: string[] = [];
    for (let m = 0; m <= now.getMonth(); m++) out.push(`${now.getFullYear()}-${String(m + 1).padStart(2, "0")}`);
    return out;
  }
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 7))
      .sort();
  } catch {
    return [monthKey(now)];
  }
}

export function summary(period: ReplayPeriod): ReplaySummary {
  if (!ready) initStats();
  const months = monthsForPeriod(period);
  const buckets = mergedBuckets(months);

  const tracks = new Map<string, TrackEntry & { id: string }>();
  const artists = new Map<string, NameEntry>();
  const albums = new Map<string, NameEntry>();
  const hours = new Array(24).fill(0);
  const days = new Map<string, number>();
  let totalMs = 0;
  let plays = 0;

  for (const b of buckets) {
    for (const [id, t] of Object.entries(b.tracks)) {
      const cur = tracks.get(id) ?? { ...t, id, ms: 0, plays: 0 };
      cur.ms += t.ms;
      cur.plays += t.plays;
      if (t.lastAt > cur.lastAt) {
        cur.title = t.title;
        cur.artist = t.artist;
        cur.thumb = t.thumb || cur.thumb;
        cur.lastAt = t.lastAt;
      }
      tracks.set(id, cur);
      plays += t.plays;
      totalMs += t.ms;
    }
    for (const [k, a] of Object.entries(b.artists)) {
      const cur = artists.get(k) ?? { ...a, ms: 0, plays: 0 };
      cur.ms += a.ms;
      cur.plays += a.plays;
      artists.set(k, cur);
    }
    for (const [k, al] of Object.entries(b.albums)) {
      const cur = albums.get(k) ?? { ...al, ms: 0, plays: 0 };
      cur.ms += al.ms;
      cur.plays += al.plays;
      albums.set(k, cur);
    }
    for (let h = 0; h < 24; h++) hours[h] += b.hours[h] ?? 0;
    for (const [d, ms] of Object.entries(b.days)) days.set(d, (days.get(d) ?? 0) + ms);
  }

  return {
    totalMs,
    plays,
    tracks: [...tracks.values()].sort((x, y) => y.ms - x.ms).slice(0, 50),
    artists: [...artists.values()].sort((x, y) => y.ms - x.ms).slice(0, 50),
    albums: [...albums.values()].sort((x, y) => y.ms - x.ms).slice(0, 50),
    hours,
    days: [...days.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, ms]) => ({ date, ms })),
    period,
    months,
  };
}

export function flushSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  void flush();
}

/** Trim one bucket to the retention caps (lowest-listened entries go first). */
function pruneBucket(b: MonthBucket): void {
  const trim = <T>(rec: Record<string, T>, max: number, msOf: (v: T) => number): void => {
    const keys = Object.keys(rec);
    if (keys.length <= max) return;
    keys
      .sort((x, y) => msOf(rec[x]) - msOf(rec[y]))
      .slice(0, keys.length - max)
      .forEach((k) => delete rec[k]);
  };
  trim(b.tracks, MAX_TRACKS, (t) => t.ms);
  trim(b.artists, MAX_NAMES, (a) => a.ms);
  trim(b.albums, MAX_NAMES, (a) => a.ms);
}

/** Drop monthly files older than KEEP_MONTHS (called on flush, throttled). */
let lastPruneFiles = 0;
function pruneOldFiles(): void {
  const now = Date.now();
  if (now - lastPruneFiles < 60 * 60 * 1000) return;
  lastPruneFiles = now;
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);
    const cutoffKey = monthKey(cutoff);
    for (const f of fs.readdirSync(dir)) {
      if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
      const key = f.slice(0, 7);
      if (key < cutoffKey) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
        open.delete(key);
      }
    }
  } catch {
    /* stats dir may not exist yet */
  }
}

/** Read every monthly bucket (for backup export). */
export function exportAll(): MonthBucket[] {
  if (!ready) initStats();
  // Flush first: the last seconds of listening may still sit in memory.
  for (const m of [...pendingIds]) writeBucket(m);
  pendingIds.clear();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
      .sort()
      .map((f) => readBucket(f.slice(0, 7)));
  } catch {
    return [];
  }
}

/** Replace all monthly buckets (backup import — validated by the caller). */
export function importAll(buckets: MonthBucket[]): void {
  if (!ready) initStats();
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (/^\d{4}-\d{2}\.json$/.test(f)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  open.clear();
  pendingIds.clear();
  ruleMs.clear();
  ruleCounted.clear();
  for (const b of buckets) {
    if (!b || !/^\d{4}-\d{2}$/.test(b.month)) continue;
    const clean: MonthBucket = {
      month: b.month,
      tracks: b.tracks && typeof b.tracks === "object" ? b.tracks : {},
      artists: b.artists && typeof b.artists === "object" ? b.artists : {},
      albums: b.albums && typeof b.albums === "object" ? b.albums : {},
      hours: Array.isArray(b.hours) && b.hours.length === 24 ? b.hours : new Array(24).fill(0),
      days: b.days && typeof b.days === "object" ? b.days : {},
    };
    pruneBucket(clean);
    open.set(clean.month, clean);
    pendingIds.add(clean.month);
  }
  scheduleFlush();
}
