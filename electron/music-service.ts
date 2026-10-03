/**
 * ByTune music service — runs in the Electron main process on Node.
 *
 * Uses youtubei.js (InnerTube) for YouTube Music: search, albums, playlists,
 * home feed, lyrics and audio stream URLs.
 *
 * YouTube gates stream URLs behind BotGuard PO tokens for anonymous sessions,
 * so the InnerTube session is bootstrapped in two phases: get visitor data,
 * mint a PO token for it in a hidden Chromium window (see po-token.ts), then
 * create the real session with both attached. If stream resolution still
 * fails, we rotate InnerTube clients, then rebuild the session with a fresh
 * token, and finally fall back to public Piped mirrors.
 */
import { Innertube } from "youtubei.js";
import { app } from "electron";
import { pickAudio } from "./audio-format";
import { fetchLyrics } from "./lyrics";
import { largestThumbUrl, upgradeThumb } from "./artwork";
import { getPoToken, invalidatePoToken } from "./po-token";
import { resolveMarket, type ResolvedMarket } from "./market";
import {
  SEARCH_FILTER_PARAMS,
  callBrowse,
  callSearch,
  callSearchContinuation,
  parseArtistPage,
  parseChartsShelves,
  parseMoods,
  parseQueueCredits,
  parseRemotePlaylistPage,
  parseReleasePage,
  parseSearchPage,
} from "./ytm";
import type { MoodEntry } from "./moods";
import type {
  Album,
  Artist,
  ArtistPageData,
  HomeItem,
  HomeShelf,
  LyricsResult,
  PlaylistCard,
  RemotePlaylistPage,
  SearchFilter,
  SearchPageResult,
  SearchResults,
  SearchRow,
  SearchSuggestion,
  SyncedLyricLine,
  TopResult,
  Track,
} from "../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type { Album, Artist, ArtistPageData, RemotePlaylistPage, SearchFilter, SearchPageResult, SearchRow, SearchResults, TopResult, Track };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// VISIONOS serves plain, fully-streamable URLs without SABR gating;
// the others are fallbacks of varying usefulness.
const STREAM_CLIENTS = ["VISIONOS", "IOS", "ANDROID_VR", "WEB", "YTMUSIC", "ANDROID", "TV"] as const;
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
];

let preferredClientIdx = 0;
let ytPromise: Promise<any> | null = null;

/* ------------------------------------------------------------------ */
/* Market — the device's YTM region (InnerTube `gl`).                  */
/* Resolved once per boot from OS signals, never from the auth method: */
/* guest / password / OAuth sessions all get the same treatment.       */
/* ------------------------------------------------------------------ */

let marketValue: ResolvedMarket | null = null;

function resolveDeviceMarket(): ResolvedMarket {
  if (!marketValue) {
    marketValue = resolveMarket({
      osRegion: app.getLocaleCountryCode() || null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      override: process.env.BYTUNE_MARKET ?? null,
      isDev: !app.isPackaged,
    });
    console.log(`[bytune] market: ${marketValue.country} (${marketValue.source})`);
  }
  return marketValue;
}

/** The resolved device market — for diagnostics and feed debugging. */
export function currentMarket(): ResolvedMarket {
  return resolveDeviceMarket();
}

/** The InnerTube display language (hl) — UI wording, never the region. */
function displayLanguage(): string {
  const locale = app.getLocale() || "en";
  const base = locale.split("-")[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : "en";
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 600): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

async function createSession(): Promise<any> {
  // The market rides into the session's client context (`gl`), which is what
  // makes the home feed, charts and search results regional. Resolved before
  // the bootstrap so visitor data and content context agree on the region.
  const market = resolveDeviceMarket();
  // Phase 1: bootstrap session just to obtain visitor data.
  const bootstrap = await Innertube.create({
    retrieve_player: false,
    enable_session_cache: false,
    location: market.country,
    lang: displayLanguage(),
  });
  const visitorData: string | undefined = bootstrap?.session?.context?.client?.visitorData;

  // Phase 2: mint a PO token bound to that visitor data.
  let poToken: string | undefined;
  if (visitorData) {
    try {
      poToken = await getPoToken(visitorData);
      console.log("[bytune] PO token ready");
    } catch (err) {
      console.warn(
        "[bytune] PO token minting failed, continuing without:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // Phase 3: the real session, with visitor data + PO token attached.
  const yt = await Innertube.create({
    retrieve_player: true,
    enable_session_cache: false,
    visitor_data: visitorData,
    po_token: poToken,
    location: market.country,
    lang: displayLanguage(),
  });
  (yt as any).__visitorData = visitorData;
  (yt as any).__poToken = poToken;
  (yt as any).__market = market.country;
  console.log(
    `[bytune] innertube session: gl=${yt.session?.context?.client?.gl ?? "?"} hl=${yt.session?.context?.client?.hl ?? "?"}`
  );
  return yt;
}

export function getYT(): Promise<any> {
  if (!ytPromise) {
    ytPromise = createSession().catch((err) => {
      ytPromise = null;
      throw err;
    });
  }
  return ytPromise;
}

async function resetSession(): Promise<any> {
  invalidatePoToken();
  ytPromise = null;
  return getYT();
}

/* ------------------------------------------------------------------ */
/* Parsing helpers (defensive — InnerTube shapes change often)         */
/* ------------------------------------------------------------------ */

function text(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v.text === "string") return v.text;
  if (Array.isArray(v.runs)) return v.runs.map((r: any) => r?.text ?? "").join("");
  return "";
}

export function parseDuration(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v.seconds === "number") return Math.round(v.seconds);
  const t = text(v);
  const parts = t.split(":").map((p) => parseInt(p, 10));
  if (parts.length >= 2 && parts.every((p) => Number.isFinite(p))) {
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  return 0;
}

/**
 * Largest offered rendition, at original quality — the rows only carry small
 * placeholders (`=w60-h60`, `=s60`, …) while the same photo serves up to
 * 1200px, so the URL is upgraded rather than taken verbatim.
 */
function pickThumb(th: any): string {
  if (typeof th === "string") return upgradeThumb(th);
  if (Array.isArray(th)) return upgradeThumb(largestThumbUrl(th));
  if (Array.isArray(th?.contents)) return upgradeThumb(largestThumbUrl(th.contents));
  if (Array.isArray(th?.thumbnails)) return upgradeThumb(largestThumbUrl(th.thumbnails));
  if (typeof th?.url === "string") return upgradeThumb(th.url);
  return "";
}

/** Swap low-res placeholder sizes for the original (both URL formats). */
function biggerThumb(url: string): string {
  return upgradeThumb(url);
}

function itemKind(item: any): string {
  return String(item?.item_type ?? item?.type ?? "").toLowerCase();
}

/**
 * A video upload hiding among songs — BitChord mobile's rule: the row's kind
 * word ("Video") is the clean signal when the surface provides one, and a
 * widescreen (non-square) thumbnail gives a video upload away where a
 * catalogue track always carries square cover art.
 */
function isVideoItem(item: any): boolean {
  if (itemKind(item) === "video") return true;
  const thumbs = item?.thumbnail?.contents ?? item?.thumbnail?.thumbnails ?? item?.thumbnails ?? [];
  for (const t of thumbs) {
    const w = Number(t?.width);
    const h = Number(t?.height);
    if (w > 0 && h > 0 && w !== h) return true;
  }
  return false;
}

function authorNames(item: any): string {
  const listed = item?.authors ?? item?.artists;
  if (Array.isArray(listed) && listed.length) {
    const names = listed.map((a: any) => a?.name ?? text(a)).filter(Boolean);
    if (names.length) return names.join(", ");
  }
  // Fall back to the "Artist • Album • Year" subtitle column.
  const runs = item?.flex_columns?.[1]?.title?.runs;
  const joined = Array.isArray(runs) ? runs.map((r: any) => r?.text ?? "").join("") : text(item?.subtitle);
  return (joined.split(" • ")[0] ?? "").trim();
}

function parseTrackItem(item: any, kinds: string[] = ["song", "video"]): Track | null {
  try {
    // Mislabeled uploads (a video tagged "song", or a non-square thumbnail on
    // a songs-filter row) resolve to their true kind before the check — a
    // caller asking for songs therefore never receives a YouTube video.
    const kind = isVideoItem(item) ? "video" : itemKind(item);
    if (!kinds.includes(kind)) return null;
    const id = item?.id;
    if (!id) return null;
    const title = text(item?.title) || text(item?.flex_columns?.[0]?.title) || "";
    if (!title || /video unavailable/i.test(title)) return null;
    const duration = parseDuration(item?.duration) || parseDuration(item?.fixed_columns?.[0]?.title);
    return {
      id,
      title,
      artist: authorNames(item) || "Unknown artist",
      artistId: item?.authors?.[0]?.channel_id ?? item?.artists?.[0]?.channel_id ?? undefined,
      album: item?.album?.name ?? (text(item?.album) || undefined),
      albumId: item?.album?.id ?? undefined,
      duration,
      thumb: pickThumb(item?.thumbnail ?? item?.thumbnails),
    };
  } catch {
    return null;
  }
}

function parseAlbumItem(item: any): Album | null {
  try {
    if (itemKind(item) !== "album") return null;
    const id = item?.id;
    if (!id) return null;
    const title = text(item?.title) || text(item?.flex_columns?.[0]?.title) || "Unknown album";
    return {
      id,
      title,
      artist: authorNames(item) || "Unknown artist",
      year: item?.year ? String(item.year) : undefined,
      thumb: pickThumb(item?.thumbnail ?? item?.thumbnails),
    };
  } catch {
    return null;
  }
}

function parseArtistItem(item: any): Artist | null {
  try {
    if (itemKind(item) !== "artist") return null;
    const id = item?.id;
    if (!id) return null;
    return {
      id,
      name: text(item?.title) || text(item?.flex_columns?.[0]?.title) || "Unknown artist",
      thumb: pickThumb(item?.thumbnail ?? item?.thumbnails),
      subtitle: text(item?.subtitle) || undefined,
    };
  } catch {
    return null;
  }
}

function parsePlaylistItem(item: any): PlaylistCard | null {
  try {
    if (itemKind(item) !== "playlist") return null;
    const id = item?.id;
    if (!id) return null;
    return {
      id,
      title: text(item?.title) || "Playlist",
      thumb: pickThumb(item?.thumbnail ?? item?.thumbnails),
      count: undefined,
    };
  } catch {
    return null;
  }
}

/** Walk any InnerTube payload and collect list items in encounter order. */
function collectItems(root: any): any[] {
  const items: any[] = [];
  const seen = new Set<any>();
  const visit = (node: any) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const type = String(node.type ?? "");
    if (type === "MusicResponsiveListItem" || type === "MusicTwoRowItem") {
      items.push(node);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return items;
}

/**
 * Locate YouTube's "Top result" card (MusicCardShelf) in a raw response.
 * collectItems deliberately skips it — it isn't a list item — so the card
 * needs its own walk.
 */
function findCardShelf(root: any): any {
  const seen = new Set<any>();
  const visit = (node: any): any => {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = visit(n);
        if (hit) return hit;
      }
      return null;
    }
    if (String(node.type ?? "") === "MusicCardShelf") return node;
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        const hit = visit(value);
        if (hit) return hit;
      }
    }
    return null;
  };
  return visit(root);
}

/** Home feed / shelf items → playable cards. */
function parseHomeItem(item: any): HomeItem | null {
  const kind = itemKind(item);
  // Home shelves stay music-only — video uploads are the version-mismatch
  // (intro before the vocals) that breaks sync, exactly as on BitChord mobile.
  if (kind === "song") {
    const track = parseTrackItem(item, ["song"]);
    if (track) return { kind: "track", track };
  } else if (kind === "album") {
    const album = parseAlbumItem(item);
    if (album) return { kind: "album", album };
  } else if (kind === "artist") {
    const artist = parseArtistItem(item);
    if (artist) return { kind: "artist", artist };
  } else if (kind === "playlist") {
    const playlist = parsePlaylistItem(item);
    if (playlist) return { kind: "playlist", playlist };
  }
  return null;
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function dedupeById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/* ------------------------------------------------------------------ */
/* Search — BitChord mobile's pipeline, exactly                        */
/* ------------------------------------------------------------------ */

/**
 * One page of search results: YouTube Music's own endpoint with the mobile
 * app's filter params, parsed by the ported InnertubeParser. The rows come
 * back in YouTube's own order and count — no re-ranking, no source mixing,
 * nothing added and nothing taken away.
 */
export async function searchPage(query: string, filter: SearchFilter): Promise<SearchPageResult> {
  const q = query.trim();
  if (!q) return { rows: [], continuation: null };
  const yt = await getYT();
  const response = await withRetry(() => callSearch(yt, q, SEARCH_FILTER_PARAMS[filter] ?? null));
  return parseSearchPage(response, filter === "videos");
}

/** The next page of the same search, via its continuation token. */
export async function searchMore(token: string, filter: SearchFilter): Promise<SearchPageResult> {
  const yt = await getYT();
  const response = await withRetry(() => callSearchContinuation(yt, token));
  return parseSearchPage(response, filter === "videos");
}

function emptySearch(): SearchResults {
  return { songs: [], videos: [], albums: [], artists: [], playlists: [], top: null, related: [] };
}

/**
 * Legacy combined search — still served to the few callers that want a flat
 * `SearchResults` (artist-album backfill), built on the same faithful parse.
 * Search is YouTube's alone: the catalogue has no other source.
 */
export async function searchAll(query: string, light = false): Promise<SearchResults> {
  const q = query.trim();
  if (!q) return emptySearch();
  const page = await searchPage(q, "all").catch(() => null);
  if (!page) return emptySearch();

  const topRow = page.rows.find((row): row is Extract<SearchRow, { kind: "top" }> => row.kind === "top") ?? null;
  const songs: Track[] = [
    ...(topRow ? [topRow.song] : []),
    ...page.rows.filter((r): r is Extract<SearchRow, { kind: "track" }> => r.kind === "track").map((r) => r.song),
  ];
  const browseOf = <K extends "album" | "artist" | "playlist">(type: K) =>
    page.rows.filter((r): r is Extract<SearchRow, { kind: "browse" }> => r.kind === "browse" && r.item.type === type);

  const result: SearchResults = {
    songs,
    videos: [],
    albums: browseOf("album").map((r) => ({
      id: r.item.browseId,
      title: r.item.title,
      artist: r.item.subtitle,
      thumb: r.item.thumb,
    })),
    artists: browseOf("artist").map((r) => ({
      id: r.item.browseId,
      name: r.item.title,
      thumb: r.item.thumb,
      subtitle: r.item.subtitle,
    })),
    playlists: browseOf("playlist").map((r) => ({
      id: r.item.browseId,
      title: r.item.title,
      thumb: r.item.thumb,
    })),
    top: topRow ? { kind: "track", track: topRow.song } : null,
    related: [],
  };
  // The shelves (per-filter pages) belong to the search page itself now; the
  // `light` flag is kept for signature compatibility and changes nothing.
  void light;
  return result;
}

export interface SuggestionsResult {
  items: SearchSuggestion[];
}

/**
 * Type-ahead suggestions — YouTube Music's own autocomplete, the same list
 * Spotify's search dropdown shows while you type. Rich hits (with artwork and
 * the artist name) are preferred over plain text when YouTube supplies them.
 */
export async function getSuggestions(query: string): Promise<SuggestionsResult> {
  const q = query.trim();
  if (!q) return { items: [] };
  const yt = await getYT();
  try {
    const sections: any[] = await withRetry(() => (yt.music as any).getSearchSuggestions(q));
    const nodes: any[] = [];
    for (const section of Array.isArray(sections) ? sections : []) {
      if (Array.isArray(section?.contents)) nodes.push(...section.contents);
    }
    const items: SearchSuggestion[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      // Plain text completions only — BitChord mobile's typeahead model. Rich
      // hits (thumbnails, playable rows) belong on the results page the user
      // lands on after Enter, not in the dropdown while they're still typing.
      if (String(node?.type ?? "") === "SearchSuggestion") {
        const t = text(node?.suggestion);
        if (t && !seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase());
          items.push({ text: t });
        }
      }
      if (items.length >= 10) break;
    }
    return { items };
  } catch {
    return { items: [] };
  }
}

/**
 * Artist page — the mobile app's parseArtistPage: profile (photo, subscribers,
 * monthly listeners), the "About the artist" blurb, the "Top songs" shelf and
 * the section carousels (Albums, Singles & EPs, Featured on, …) in YouTube's
 * own order.
 */
export async function getArtistPage(artistId: string): Promise<ArtistPageData> {
  const yt = await getYT();
  const response = await withRetry(() => callBrowse(yt, artistId));
  const parsed = parseArtistPage(response);
  const info: Artist = {
    id: artistId,
    name: parsed.name || "Unknown artist",
    thumb: parsed.thumb,
  };
  const songs: Track[] = parsed.songs.map((t) => ({
    ...t,
    // Rows on the artist's own shelf can ship without a credit — the page's
    // own header is the missing one, as on mobile.
    artist: t.artist && t.artist !== "Unknown artist" ? t.artist : info.name,
    artistId: t.artistId || artistId,
  }));
  return {
    artist: info,
    description: parsed.description,
    subscriberCount: parsed.subscriberCount,
    monthlyListeners: parsed.monthlyListeners,
    songs,
    shelves: parsed.shelves,
  };
}

/**
 * Album page — the mobile app's pageOf: the page's own header (title, credit
 * line, cover, artist link), its track list and the "About the album" blurb.
 */
export async function getAlbum(albumId: string): Promise<{ album: Album; tracks: Track[] }> {
  const yt = await getYT();
  const response = await withRetry(() => callBrowse(yt, albumId));
  const parsed = parseReleasePage(response, albumId);
  // The header line reads "Album • Artist • 2014" (older shape) or the strapline
  // carries the artist while the subtitle keeps "Album • 2014". Split like the
  // mobile DetailScreen does.
  const lines = (parsed.header?.subtitle ?? "")
    .split("•")
    .map((p) => p.trim())
    .filter(Boolean);
  const releaseType = lines.find((l) => ["album", "single", "ep"].includes(l.toLowerCase()));
  const year = [...lines].reverse().find((l) => /^\d{4}$/.test(l));
  const artist = lines.find((l) => l !== releaseType && l !== year) || parsed.tracks[0]?.artist || "Unknown artist";
  const albumInfo: Album = {
    id: albumId,
    title: parsed.header?.title || parsed.tracks[0]?.album || "Unknown album",
    artist,
    year,
    thumb: parsed.header?.thumb || parsed.tracks[0]?.thumb || "",
    releaseType: releaseType ? releaseType[0].toUpperCase() + releaseType.slice(1).toLowerCase() : undefined,
    description: parsed.description,
    artistId: parsed.header?.artistId,
  };
  return { album: albumInfo, tracks: parsed.tracks };
}

/**
 * A remote (YouTube) playlist page — title, curator/views credit line,
 * "PLAYLIST • N TRACKS" metadata and its own track list, scoped so YouTube's
 * "Suggestions" shelf stays out (the mobile app's parsePlaylistShelf).
 */
export async function getPlaylistPage(playlistId: string): Promise<RemotePlaylistPage> {
  const yt = await getYT();
  const id = /^VL|^PL|^OLAK5uy/.test(playlistId) ? playlistId : `VL${playlistId}`;
  const response = await withRetry(() => callBrowse(yt, id));
  return parseRemotePlaylistPage(response, id);
}

export async function getPlaylist(
  playlistId: string
): Promise<{ title: string; tracks: Track[] }> {
  const yt = await getYT();
  const pl: any = await withRetry(() => (yt.music as any).getPlaylist(playlistId));
  const tracks = dedupeById(
    collectItems(pl)
      .map((i) => parseTrackItem(i, ["song", "video"]))
      .filter(Boolean) as Track[]
  );
  const title = text(pl?.header?.title) || text(pl?.title) || "Playlist";
  return { title, tracks };
}

export async function getHome(): Promise<HomeShelf[]> {
  const yt = await getYT();
  const feed: any = await withRetry(() => (yt.music as any).getHomeFeed());
  const sections: any[] = Array.isArray(feed?.sections) ? feed.sections : [];
  const shelves: HomeShelf[] = [];
  for (const section of sections) {
    const title = text(section?.header?.title) || text(section?.title) || "For you";
    const items: HomeItem[] = [];
    for (const item of collectItems(section)) {
      const parsed = parseHomeItem(item);
      if (parsed) items.push(parsed);
      if (items.length >= 24) break;
    }
    if (items.length >= 3) shelves.push({ title, items });
  }
  return shelves.slice(0, 8);
}

/**
 * YouTube Music's Charts page — the provider's own per-region popularity
 * ranking. The region comes from the session's `gl` (the resolved device
 * market), so this is REAL market data, not a hand-built list. Any failure
 * throws — the feed composes without the shelf.
 */
export async function getCharts(): Promise<HomeShelf[]> {
  const yt = await getYT();
  const res = await withRetry(() => callBrowse(yt, "FEmusic_charts"));
  return parseChartsShelves(res) as HomeShelf[];
}

/**
 * The provider's per-region moods & genres catalog (Explore page). The list
 * follows the session's `gl` — the resolved device market — so each market
 * gets its own browse suggestions. Any failure throws; callers fall back.
 */
export async function getMoods(): Promise<MoodEntry[]> {
  const yt = await getYT();
  const res = await withRetry(() => callBrowse(yt, "FEmusic_explore"));
  return parseMoods(res);
}

/* ------------------------------------------------------------------ */
/* Lyrics: BitChord mobile's provider sweep — word-synced Apple TTML   */
/* (BiniLyrics/BetterLyrics/PaxSenix/LyricsPlus), QQ karaoke, Musix-   */
/* match richsync, then line-synced KuGou/LRCLIB/Megalobiz, captions   */
/* and plain text last. Returns time-synced lines when any source has  */
/* them.                                                               */
/* ------------------------------------------------------------------ */

export interface LyricsMeta {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

const lyricCache = new Map<string, LyricsResult | null>();
const LYRIC_CACHE_MAX = 400;
const QUEUE_CREDITS_CACHE_MAX = 600;
const DURATION_CACHE_MAX = 2000;
const RESOLVE_CACHE_MAX = 500;

/** Keep session Maps bounded: FIFO-evict the oldest entry past max. */
export function evictOldest<T>(map: Map<string, T>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/** Credit placeholders a bare search row can carry — never a real artist. */
const PLACEHOLDER_ARTISTS = new Set(["unknown artist", "unknown", "various artists", "artist"]);

const queueCreditsCache = new Map<string, { artist: string; album?: string; durationSec: number } | null>();

/**
 * The track's real artist/album/duration off its own watch-queue row — one
 * `next` call, cached for the session. This is what makes lyrics resolve for
 * tracks the search page could only credit "Unknown artist".
 */
async function resolveQueueCredits(
  videoId: string
): Promise<{ artist: string; album?: string; durationSec: number } | undefined> {
  if (!videoId) return undefined;
  if (queueCreditsCache.has(videoId)) return queueCreditsCache.get(videoId) ?? undefined;
  try {
    const yt = await getYT();
    const res = await yt.actions.execute("next", {
      videoId,
      playlistId: `RDAMVM${videoId}`,
      client: "YTMUSIC",
    });
    const credits = parseQueueCredits(res?.data ?? null, videoId);
    queueCreditsCache.set(videoId, credits ?? null);
    evictOldest(queueCreditsCache, QUEUE_CREDITS_CACHE_MAX);
    return credits ?? undefined;
  } catch {
    return undefined;
  }
}
const lyricCacheAt = new Map<string, number>();
const LRCLIB_UA = "ByTune/1.0.0";

function primaryArtist(artist: string): string {
  return artist.split(/,|&|feat\.|ft\./i)[0].trim();
}

/** Strip parenthetical/bracket extras ("(From ...)", "(feat. X)", "[2012 Mix]") for better matching. */
function cleanTitle(title: string): string {
  return title
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/["“”']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSyncedTimestamps(synced: string): string {
  return synced
    .replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain lyrics from YT Music's own Lyrics tab — ranked source and final fallback. */
async function ytMusicPlain(videoId: string): Promise<string | null> {
  try {
    const yt = await getYT();
    const ytl: any = await withRetry(() => (yt.music as any).getLyrics(videoId));
    return ytl?.text && ytl.text.trim() ? ytl.text : null;
  } catch {
    return null;
  }
}

function collectByName(node: unknown, key: string, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectByName(item, key, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  const value = obj[key];
  if (value && typeof value === "object" && !Array.isArray(value)) out.push(value);
  for (const item of Object.values(obj)) collectByName(item, key, out);
  return out;
}

function runsText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => (typeof r?.text === "string" ? r.text : "")).join("");
  return "";
}

function msToSeconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n / 1000 : null;
}

/** Caption lines that say nothing about the song. */
const CAPTION_NOISE = /^(\[(music|applause|laughter|cheering|instrumental)\]|[♪♫\s]*)$/i;

/**
 * Timed captions for the exact playing video — innertube's get_transcript,
 * keyed on the engagement-panel continuation the video's own `next` response
 * carries. YouTube has been hardening this endpoint (it now demands a
 * session-bound precondition innertube clients are still catching up with),
 * so the first refusal parks the source for the session rather than paying
 * two dead requests per track; a session where YouTube answers again picks it
 * back up on its own.
 */
let transcriptRefused = false;

async function fetchYouTubeTranscriptCues(videoId: string): Promise<SyncedLyricLine[] | null> {
  if (transcriptRefused || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  try {
    const yt = await getYT();
    const next: any = await withRetry(() => yt.actions.execute("next", { videoId }));
    const data = next?.data ?? next;
    if (!data) return null;
    let params: string | null = null;
    const walk = (node: unknown): void => {
      if (params || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const obj = node as Record<string, any>;
      const endpointParams = obj?.getTranscriptEndpoint?.params;
      if (typeof endpointParams === "string" && endpointParams) {
        params = endpointParams;
        return;
      }
      for (const value of Object.values(obj)) walk(value);
    };
    walk(data);
    if (!params) return null; // video carries no transcript panel at all
    const res: any = await yt.actions.execute("/get_transcript", { params });
    const body = res?.data ?? res;
    if (!body) {
      transcriptRefused = true;
      return null;
    }
    let lines: SyncedLyricLine[] = [];
    const segments = collectByName(body, "transcriptSegmentRenderer");
    if (segments.length) {
      for (const seg of segments) {
        const time = msToSeconds(seg.startMs);
        if (time == null) continue;
        const text = runsText(seg.snippet).replace(/[♪♫]/g, "").trim();
        if (!text || CAPTION_NOISE.test(text)) continue;
        const end = msToSeconds(seg.endMs);
        lines.push({ time, text, end: end != null && end > time ? end : undefined });
      }
    } else {
      for (const cue of collectByName(body, "transcriptCueRenderer")) {
        const time = msToSeconds(cue.startOffsetMs);
        if (time == null) continue;
        const text = runsText(cue.cue).replace(/[♪♫]/g, "").trim();
        if (!text || CAPTION_NOISE.test(text)) continue;
        lines.push({ time, text });
      }
    }
    if (!lines.length) {
      // A 200 that names neither renderer shape means the endpoint moved on —
      // same refusal, park it.
      transcriptRefused = true;
      return null;
    }
    lines = lines.filter((l) => Number.isFinite(l.time)).sort((a, b) => a.time - b.time);
    return lines.length ? lines : null;
  } catch {
    transcriptRefused = true;
    return null;
  }
}

/** Parse LRC-format synced lyrics into (time, text) lines. */
export async function getLyrics(meta: LyricsMeta): Promise<LyricsResult | null> {
  if (!meta?.id) return null;

  // A cached answer that only LINE-synced is retried after 10 minutes: the
  // word-synced providers are rate-limited flakier than KuGou/LRCLIB, and a
  // mediocre answer should never stick for the whole session.
  const cachedAt = lyricCacheAt.get(meta.id) ?? 0;
  if (lyricCache.has(meta.id)) {
    const cached = lyricCache.get(meta.id) ?? null;
    // A cached answer that only LINE-synced is retried after 10 minutes: the
    // word-synced providers are rate-limited flakier than KuGou/LRCLIB, and a
    // mediocre answer should never stick for the whole session. A MISS is
    // cached the same way — a track with no lyrics must not re-run the full
    // provider sweep every single play, but it stays retryable.
    if (cached && cached.synced && cached.wordSynced) return cached;
    if (Date.now() - cachedAt < 10 * 60 * 1000) return cached;
  }

  // The mixed "All" search page credits rows it has no links for "Unknown
  // artist" (BitChord mobile prints the same). The lyric databases key on
  // artist + title, so recover the track's real credits from its own
  // watch-queue row before the lookup — the same fully-credited line the
  // mobile player is served for the same track.
  let artist = (meta.artist ?? "").trim();
  let album = meta.album;
  // A NaN duration serializes to JSON `null`, which the cloud validator (and
  // any consumer) reads back as a broken track — never let one through.
  let duration = typeof meta.duration === "number" && Number.isFinite(meta.duration) ? Math.round(meta.duration) : 0;
  if (!artist || PLACEHOLDER_ARTISTS.has(artist.toLowerCase())) {
    const credits = await resolveQueueCredits(meta.id);
    if (credits) {
      if (credits.artist) artist = credits.artist;
      album = album || credits.album;
      duration = duration || credits.durationSec;
    }
  }

  const found = await fetchLyrics(
    {
      id: meta.id,
      title: meta.title || "",
      artist,
      album,
      duration,
    },
    { prioritizeWordSync: true },
    { ytMusicPlain, ytTranscript: fetchYouTubeTranscriptCues }
  );
  const result: LyricsResult | null = found
    ? { synced: found.synced, plain: found.plain, source: found.source, wordSynced: found.wordSynced }
    : null;
  // Misses included — see the read path above.
  lyricCache.set(meta.id, result);
  lyricCacheAt.set(meta.id, Date.now());
  evictOldest(lyricCache, LYRIC_CACHE_MAX);
  evictOldest(lyricCacheAt, LYRIC_CACHE_MAX);
  return result;
}

/* ------------------------------------------------------------------ */
/* Duration enrichment                                                 */
/* ------------------------------------------------------------------ */

const durationCache = new Map<string, number>();

/**
 * YT Music search results for songs no longer include durations, so we look
 * them up via /player in small concurrent batches and cache the result.
 */
export async function enrichDurations(ids: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const pending = [...new Set(ids.filter((id) => id && !durationCache.has(id)))].slice(0, 60);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const id = pending[cursor++];
      try {
        const yt = await getYT();
        const info = await yt.getBasicInfo(id, { client: "VISIONOS" });
        const secs = Math.round(info?.basic_info?.duration ?? 0);
        if (secs > 0) {
          durationCache.set(id, secs);
          evictOldest(durationCache, DURATION_CACHE_MAX);
          result[id] = secs;
        }
      } catch {
        /* leave this one unknown */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  for (const id of ids) {
    const cached = durationCache.get(id);
    if (cached) result[id] = cached;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Stream URL resolution                                               */
/* ------------------------------------------------------------------ */

/* Rendition ranking, loudness extraction and url deciphering live in
   audio-format.ts — pure logic, unit-tested in tests/format-pick.test.mjs. */

/**
 * Validate that a URL actually streams: request an open range and read the
 * first chunk. SABR-gated URLs answer tiny ranges with 206 but 403 real
 * streaming requests, so this catches them.
 */
async function probeUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Range: "bytes=0-" } });
    if (res.status !== 206 && res.status !== 200) {
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      return false;
    }
    let got = 0;
    try {
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      got = value?.length ?? 0;
      await reader.cancel().catch(() => undefined);
    } catch {
      /* treat as failure below */
    }
    return got > 0;
  } catch {
    return false;
  }
}

/** Last-resort stream source: public Piped mirrors. */
async function resolveViaPiped(videoId: string): Promise<string> {
  // The id lands in a URL path segment — a renderer- or cloud-supplied value
  // with separators or query syntax must never reshape the request.
  if (!/^[\w-]{6,20}$/.test(videoId)) throw new Error("Invalid video id");
  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${base}/streams/${videoId}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      const audio: any[] = (data?.audioStreams ?? []).filter((s: any) => typeof s?.url === "string");
      if (!audio.length) continue;
      audio.sort((a, b) => (b?.bitrate ?? 0) - (a?.bitrate ?? 0));
      const pick = audio.find((s) => /mp4|aac/i.test(String(s?.mimeType ?? ""))) ?? audio[0];
      if (await probeUrl(pick.url)) return pick.url;
    } catch {
      /* try next instance */
    }
  }
  throw new Error("No Piped mirror had a playable stream");
}

export interface ResolvedStream {
  url: string;
  /** Container/codec of the picked rendition, e.g. `audio/mp4; codecs=...`. */
  mime: string;
  /** Integrated loudness in LUFS when YouTube reports it (null = unknown). */
  lufs: number | null;
}

/**
 * Resolved-stream cache. The media element re-requests the proxy for every
 * seek and buffer refill, and each request used to run the full client
 * rotation again; a rendition is valid for hours, so a short-TTL cache makes
 * repeat requests instant and lets the renderer's `?meta=1` loudness lookup
 * share a single resolution with the playback request. forceRotate (the 403
 * self-heal path) bypasses and refreshes it.
 */
const RESOLVE_TTL_MS = 10 * 60 * 1000;
const resolveCache = new Map<string, { value: ResolvedStream; ts: number }>();
const resolving = new Map<string, Promise<ResolvedStream>>();

export function resolveStream(
  videoId: string,
  forceRotate = false,
  maxKbps?: number,
  mp4Only = false
): Promise<ResolvedStream> {
  const key = `${videoId}|${maxKbps ?? ""}|${mp4Only ? "mp4" : ""}`;
  if (!forceRotate) {
    const hit = resolveCache.get(key);
    if (hit && Date.now() - hit.ts < RESOLVE_TTL_MS) return Promise.resolve(hit.value);
    const pending = resolving.get(key);
    if (pending) return pending;
  }
  const run = (async (): Promise<ResolvedStream> => {
    if (forceRotate) preferredClientIdx = (preferredClientIdx + 1) % STREAM_CLIENTS.length;
    let lastErr: unknown = null;

    // Two rounds: the second one runs on a freshly built session (new PO token).
    for (let round = 0; round < 2; round++) {
      const yt = await getYT();
      const poToken: string | undefined = (yt as any).__poToken;
      for (let i = 0; i < STREAM_CLIENTS.length; i++) {
        const idx = (preferredClientIdx + i) % STREAM_CLIENTS.length;
        const client = STREAM_CLIENTS[idx];
        try {
          const info = await yt.getBasicInfo(videoId, { client, po_token: poToken });
          const sd: any = info?.streaming_data;
          const audioOnly: any[] = (sd?.adaptive_formats ?? []).filter(
            (f: any) => f?.has_audio && !f?.has_video
          );
          console.log(
            `[bytune] stream ${client}: playability=${String((info as any)?.playability_status?.status ?? "?")} audio=${audioOnly.length} plainUrl=${audioOnly.filter((f: any) => typeof f.url === "string").length} sig=${audioOnly.filter((f: any) => typeof f.signature_cipher === "string" || typeof f.cipher === "string").length} hls=${sd?.hls_manifest_url ? "y" : "n"}`
          );
          const picked = await pickAudio(info, yt, maxKbps, mp4Only);
          if (!picked) throw new Error(`no audio format for client ${client}`);
          // Validate from the same network path the proxy will use; a bad URL
          // (e.g. SABR-gated) moves us to the next client instead of failing
          // at the media element.
          if (!(await probeUrl(picked.url))) throw new Error(`stream rejected for client ${client}`);
          preferredClientIdx = idx;
          const value: ResolvedStream = { url: picked.url, mime: picked.mime, lufs: picked.lufs };
          resolveCache.set(key, { value, ts: Date.now() });
          evictOldest(resolveCache, RESOLVE_CACHE_MAX);
          return value;
        } catch (err) {
          lastErr = err;
        }
      }
      if (round === 0) {
        console.warn(
          "[bytune] all clients failed, rebuilding session with a fresh PO token:",
          lastErr instanceof Error ? lastErr.message : lastErr
        );
        await resetSession();
      }
    }

    try {
      const url = await resolveViaPiped(videoId);
      // Piped mirrors don't report loudness; the renderer keeps its fallback.
      const value: ResolvedStream = { url, mime: "audio/mp4", lufs: null };
      resolveCache.set(key, { value, ts: Date.now() });
      evictOldest(resolveCache, RESOLVE_CACHE_MAX);
      return value;
    } catch (err) {
      lastErr = err;
    }

    throw lastErr instanceof Error ? lastErr : new Error("Could not resolve a playable audio stream");
  })();
  resolving.set(key, run);
  // Drop the in-flight entry once settled; the side chain swallows the
  // rejection so the bookkeeping itself never goes unhandled — callers
  // awaiting `run` still see the error.
  void run
    .catch(() => undefined)
    .finally(() => {
      if (resolving.get(key) === run) resolving.delete(key);
    });
  return run;
}

/** URL-only view of resolveStream — for analysers and other url-shape callers. */
export async function resolveStreamUrl(
  videoId: string,
  forceRotate = false,
  maxKbps?: number,
  mp4Only = false
): Promise<string> {
  return (await resolveStream(videoId, forceRotate, maxKbps, mp4Only)).url;
}
