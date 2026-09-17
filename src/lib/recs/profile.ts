/**
 * Taste profile — the signals layer of the Home recommendation engine.
 *
 * Everything here is computed from REAL user data only:
 *   - listening stats from the main process (per-artist/per-track play
 *     counts, listening time, last-played timestamps, hour-of-day totals)
 *   - liked tracks, listening history and user playlists (renderer store)
 *   - recent search terms
 *   - skip tallies (stores/listening, fed by the audio engine)
 *
 * The output is a ranked artist-affinity list plus a maturity tier, with a
 * cheap `signature` the feed uses to decide when a rebuild is warranted.
 * Nothing is random: scores are deterministic functions of the data, and
 * the only seed is the day bucket (so the feed rotates daily, not per view).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReplaySummary } from "../../../electron/stats";
import { peekArtistMeta } from "../../stores/artistMeta";
import { useLibrary, type Playlist } from "../../stores/library";
import { useListening, type SkipEntry } from "../../stores/listening";
import { usePlayer } from "../../stores/player";
import { useRecents } from "../../stores/recents";
import { useUI } from "../../stores/ui";
import type { Track } from "../../types";
import { dayBucket } from "./seeded";

/* ------------------------------------------------------------- stats i/o */

export type { ReplaySummary };

const STATS_TTL_MS = 60_000;
const STATS_REFRESH_MS = 120_000;

function emptySummary(period: ReplaySummary["period"]): ReplaySummary {
  return {
    totalMs: 0,
    plays: 0,
    tracks: [],
    artists: [],
    albums: [],
    hours: new Array(24).fill(0),
    days: [],
    period,
    months: [],
  };
}

interface StatsPair {
  all: ReplaySummary;
  month: ReplaySummary;
  at: number;
}

let statsCache: StatsPair | null = null;
let statsInflight: Promise<StatsPair> | null = null;

async function loadStats(force = false): Promise<StatsPair> {
  if (!force && statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache;
  if (!statsInflight) {
    statsInflight = (async () => {
      try {
        const [all, month] = await Promise.all([
          window.bytune?.statsSummary("all"),
          window.bytune?.statsSummary("month"),
        ]);
        statsCache = {
          all: all ?? emptySummary("all"),
          month: month ?? emptySummary("month"),
          at: Date.now(),
        };
      } catch {
        /* keep whatever we had; a fresh app gets empties */
      } finally {
        statsInflight = null;
      }
      return statsCache ?? { all: emptySummary("all"), month: emptySummary("month"), at: Date.now() };
    })();
  }
  return statsInflight;
}

/** Subscribes to listening stats; refreshes on listening activity + a slow clock. */
export function useStats(): StatsPair | null {
  const listenVersion = useListening((s) => s.version);
  const reloadNonce = useUI((s) => s.homeReloadNonce);
  // Track changes double as a "a play may just have been credited" signal —
  // the previous track's play was counted at its midpoint, so by the time the
  // next one starts the main process already holds it.
  const playingId = usePlayer((s) => s.queue[s.index]?.id ?? "");
  const [stats, setStats] = useState<StatsPair | null>(statsCache);
  const prevPlayingId = useRef(playingId);
  const prevNonce = useRef(reloadNonce);

  useEffect(() => {
    let alive = true;
    const trackChanged = playingId !== prevPlayingId.current;
    prevPlayingId.current = playingId;
    const manualReload = reloadNonce !== prevNonce.current;
    prevNonce.current = reloadNonce;

    // Manual refreshes and track changes may carry plays the 60s cache would
    // hide — read straight through it. Track changes wait out the main
    // process's debounced 5s flush first; a refresh click, the very first
    // call ever, and a Home revisit past the cache's TTL answer instantly;
    // everything else keeps the 15s grace.
    const forced = manualReload || trackChanged;
    const cacheAge = statsCache === null ? Infinity : Date.now() - statsCache.at;
    const delay = manualReload
      ? 0
      : trackChanged
        ? 5_000
        : cacheAge >= STATS_TTL_MS
          ? 0
          : 15_000;
    const timer = window.setTimeout(() => {
      void loadStats(forced).then((s) => {
        if (alive) setStats(s);
      });
    }, delay);
    const clock = window.setInterval(() => {
      void loadStats().then((s) => {
        if (alive) setStats(s);
      });
    }, STATS_REFRESH_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenVersion, playingId, reloadNonce]);

  return stats;
}

/* ---------------------------------------------------------------- profile */

export type Maturity = "cold" | "light" | "warmed" | "strong";

export interface ArtistSignal {
  /** lowercased name — the stats' join key */
  key: string;
  name: string;
  /** youtube artist page when known (local tags / meta cache / search) */
  artistId: string | null;
  thumb: string | null;
  msMonth: number;
  playsMonth: number;
  msAll: number;
  playsAll: number;
  lastPlayedAt: number | null;
  likedTracks: number;
  skips: number;
  searchHits: number;
  /** final affinity score — deterministic, higher = more present on Home */
  score: number;
}

export interface TasteProfile {
  /** cheap change signal — feed rebuilds only when this moves */
  signature: string;
  generatedAt: number;
  /** stable per-day seed for the feed's rotation */
  daySeed: number;
  totalPlays: number;
  maturity: Maturity;
  /** ranked best-signal-first */
  artists: ArtistSignal[];
  /** most-played tracks this month, best first */
  topTracks: ReplaySummary["tracks"];
  /** ids already in heavy rotation — candidates filter against these */
  playedTrackIds: Set<string>;
  recentlyPlayed: Track[];
  liked: Track[];
  searches: string[];
  /** listening minutes per hour of day (this month) — for gentle time context */
  hours: number[];
  /** 0..1 — how much the user listens at the current hour vs their peak */
  hourEnergy: number;
}

const DAY_MS = 86_400_000;

export function maturityOf(totalPlays: number): Maturity {
  // Cold means "no listening signal at all" — a handful of plays is already
  // enough to personalize against, so the first session gets real recs.
  if (totalPlays < 1) return "cold";
  if (totalPlays < 25) return "light";
  if (totalPlays < 100) return "warmed";
  return "strong";
}

interface ComputeInput {
  all: ReplaySummary;
  month: ReplaySummary;
  history: Track[];
  liked: Track[];
  playlists: Playlist[];
  searches: string[];
  skips: Record<string, SkipEntry>;
  now: number;
}

export function computeTasteProfile(input: ComputeInput): TasteProfile {
  const { all, month, history, liked, playlists, searches, skips, now } = input;

  const lower = (s: string): string => s.trim().toLowerCase();

  // ---- aggregate per artist (month for trend, all for long-term) ----------
  interface Agg {
    name: string;
    msMonth: number;
    playsMonth: number;
    msAll: number;
    playsAll: number;
    lastAt: number | null;
  }
  const aggs = new Map<string, Agg>();
  const aggFor = (name: string): Agg => {
    const key = lower(name) || "unknown artist";
    let a = aggs.get(key);
    if (!a) {
      a = { name: name.trim() || "Unknown artist", msMonth: 0, playsMonth: 0, msAll: 0, playsAll: 0, lastAt: null };
      aggs.set(key, a);
    }
    return a;
  };

  for (const a of month.artists) {
    const agg = aggFor(a.name);
    agg.msMonth = a.ms;
    agg.playsMonth = a.plays;
  }
  for (const a of all.artists) {
    const agg = aggFor(a.name);
    agg.msAll = a.ms;
    agg.playsAll = a.plays;
  }
  // Artist recency: stats buckets don't timestamp artists, but their tracks
  // do — the freshest track counts as the artist's last visit.
  for (const t of [...month.tracks, ...all.tracks]) {
    const agg = aggFor(t.artist);
    if (!agg.lastAt || t.lastAt > agg.lastAt) agg.lastAt = t.lastAt;
  }

  // ---- identity resolution: real tracks first, then the persisted
  // artist-meta cache (search results from earlier runs) -------------------
  const idByKey = new Map<string, { artistId?: string; thumb?: string }>();
  for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
    const key = lower(t.artist);
    if (!key || key === "unknown artist") continue;
    const cur = idByKey.get(key) ?? {};
    if (!cur.artistId && t.artistId) cur.artistId = t.artistId;
    if (!cur.thumb && t.artistImage) cur.thumb = t.artistImage;
    idByKey.set(key, cur);
  }
  for (const name of [...aggs.values()].map((a) => a.name)) {
    const key = lower(name);
    if (idByKey.has(key)) continue;
    const meta = peekArtistMeta(name);
    if (meta) idByKey.set(key, { artistId: meta.id, thumb: meta.thumb ?? undefined });
  }

  // ---- side signals --------------------------------------------------------
  const likedByKey = new Map<string, number>();
  for (const t of liked) {
    const key = lower(t.artist);
    likedByKey.set(key, (likedByKey.get(key) ?? 0) + 1);
  }
  const searchByKey = new Map<string, number>();
  for (const q of searches) {
    const key = lower(q);
    for (const [artistKey2] of aggs) {
      if (artistKey2.includes(key) || key.includes(artistKey2)) {
        searchByKey.set(artistKey2, (searchByKey.get(artistKey2) ?? 0) + 1);
      }
    }
  }

  // ---- score ---------------------------------------------------------------
  const maxMsMonth = Math.max(1, ...month.artists.map((a) => a.ms));
  const maxMsAll = Math.max(1, ...all.artists.map((a) => a.ms));

  const artists: ArtistSignal[] = [];
  for (const [key, agg] of aggs) {
    const engagement = agg.playsMonth + agg.playsAll + (likedByKey.get(key) ?? 0);
    if (engagement === 0) continue;

    // Recency decay: a half-life of ~5 days. Artists the user stepped away
    // from fade out; a return to them bounces straight back.
    const ageDays = agg.lastAt ? (now - agg.lastAt) / DAY_MS : null;
    const recency = ageDays === null ? 0.4 : Math.exp((-ageDays / 5) * Math.LN2);

    const trend = (agg.msMonth / maxMsMonth) * (0.35 + 0.65 * recency);
    const longterm = agg.msAll / maxMsAll;
    const likedBoost = Math.min(12, (likedByKey.get(key) ?? 0) * 6);
    const searchBoost = Math.min(8, (searchByKey.get(key) ?? 0) * 4);
    const skipPenalty = Math.min(35, (skips[key]?.count ?? 0) * 9);

    const score = 60 * trend + 30 * longterm + likedBoost + searchBoost - skipPenalty;
    if (score <= 0.5) continue;

    const identity = idByKey.get(key);
    artists.push({
      key,
      name: agg.name,
      artistId: identity?.artistId ?? null,
      thumb: identity?.thumb ?? null,
      msMonth: agg.msMonth,
      playsMonth: agg.playsMonth,
      msAll: agg.msAll,
      playsAll: agg.playsAll,
      lastPlayedAt: agg.lastAt,
      likedTracks: likedByKey.get(key) ?? 0,
      skips: skips[key]?.count ?? 0,
      searchHits: searchByKey.get(key) ?? 0,
      score,
    });
  }
  artists.sort((a, b) => b.score - a.score);

  const playedTrackIds = new Set<string>();
  for (const t of month.tracks) playedTrackIds.add(t.id);
  for (const t of history) playedTrackIds.add(t.id);
  for (const t of liked) playedTrackIds.add(t.id);

  const hours = month.hours.length === 24 ? month.hours : new Array(24).fill(0);
  const peakHour = Math.max(1, ...hours);
  const hourEnergy = hours[new Date().getHours()] / peakHour;

  const totalPlays = all.plays;
  const signature = [
    totalPlays,
    month.plays,
    all.tracks[0]?.id ?? "",
    history.length,
    history[0]?.id ?? "",
    liked.length,
    liked[0]?.id ?? "",
    playlists.length,
    searches[0] ?? "",
    Object.keys(skips).length,
    skips[artists[0]?.key ?? ""]?.count ?? 0,
    dayBucket(now),
  ].join("|");

  return {
    signature,
    generatedAt: now,
    daySeed: dayBucket(now) * 2654435761,
    totalPlays,
    maturity: maturityOf(totalPlays),
    artists,
    topTracks: month.tracks,
    playedTrackIds,
    recentlyPlayed: history,
    liked,
    searches,
    hours,
    hourEnergy,
  };
}

/** React binding: the profile for the current stores, or null until stats land. */
export function useTasteProfile(): TasteProfile | null {
  const stats = useStats();
  const history = useLibrary((s) => s.history);
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const searches = useRecents((s) => s.searches);
  const skips = useListening((s) => s.skips);
  const listenVersion = useListening((s) => s.version);

  return useMemo(() => {
    if (!stats) return null;
    return computeTasteProfile({
      all: stats.all,
      month: stats.month,
      history,
      liked,
      playlists,
      searches,
      skips,
      now: Date.now(),
    });
    // listenVersion participates so a freshly recorded skip re-scores the
    // profile even when the skips object was recycled by the persistence layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, history, liked, playlists, searches, skips, listenVersion]);
}
