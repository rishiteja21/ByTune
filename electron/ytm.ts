/**
 * Raw InnerTube (YouTube Music) calls + a faithful port of BitChord mobile's
 * InnertubeParser (app/src/main/java/com/music/bitchord/data/innertube/InnertubeParser.kt).
 *
 * The mobile app reads the raw `musicResponsiveListItemRenderer` /
 * `musicCardShelfRenderer` JSON rather than youtubei.js's parsed classes, and
 * classifies every row on the way out — that is what makes its search results
 * (order, count, sections, subtitles) YouTube's own. This module reproduces
 * that exactly, so the desktop's search page is the same list the phone shows.
 *
 * Search filters use YouTube Music's own params, the same byte strings the
 * mobile app pins in `SearchFilter` (Models.kt).
 */
import type { Album, Artist, BrowseItem, HomeItem, HomeShelf, RemotePlaylistPage, SearchPageResult, SearchRow, Track } from "../src/types";
import { bestThumbUrl } from "./artwork";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** YouTube Music search filter chips — BitChord mobile's SearchFilter.params (Models.kt). */
export const SEARCH_FILTER_PARAMS: Record<string, string | null> = {
  all: null,
  songs: "EgWKAQIIAWoKEAkQChAFEAMQBA==",
  videos: "EgWKAQIQAWoKEAkQChAFEAMQBA==",
  albums: "EgWKAQIYAWoKEAkQChAFEAMQBA==",
  artists: "EgWKAQIgAWoKEAkQChAFEAMQBA==",
  playlists: "EgWKAQIoAWoKEAkQChAFEAMQBA==",
};

/* ---------------- raw endpoint calls ---------------- */

export async function callSearch(yt: any, query: string, params: string | null): Promise<any> {
  const res = await yt.actions.execute("search", {
    query,
    ...(params ? { params } : {}),
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

export async function callSearchContinuation(yt: any, token: string): Promise<any> {
  const res = await yt.actions.execute("search", {
    continuation: token,
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

export async function callBrowse(yt: any, browseId: string, params?: string | null): Promise<any> {
  const res = await yt.actions.execute("browse", {
    browseId,
    ...(params ? { params } : {}),
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

/* ---------------- tiny JSON navigation (null-safe, never throws) ---------------- */

function o(node: any, key: string): any {
  const v = node && typeof node === "object" && !Array.isArray(node) ? node[key] : null;
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function a(node: any, key: string): any[] | null {
  return node && typeof node === "object" && Array.isArray(node[key]) ? node[key] : null;
}

function s(node: any, key: string): string | null {
  const v = node && typeof node === "object" ? node[key] : null;
  // Width/height and counts arrive as JSON numbers — primitives, like strings.
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

/** {runs:[{text}]} | {simpleText} | string — joined, the Kotlin `runs()` helper. */
function text(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v.simpleText === "string") return v.simpleText;
  if (Array.isArray(v.runs)) return v.runs.map((r: any) => s(r, "text") ?? "").join("");
  return "";
}

function firstRunText(node: any): string | null {
  const runs = a(node, "runs");
  return runs && runs.length ? (s(runs[0], "text") ?? null) : null;
}

/** Depth-first collection of a named renderer, preserving document order. */
function collectRenderers(root: any, name: string): any[] {
  const out: any[] = [];
  const visit = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node[name] && typeof node[name] === "object") out.push(node[name]);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return out;
}

/** Token for the next page, or null — both continuation shapes YouTube ships. */
export function continuationToken(root: any): string | null {
  const item = collectRenderers(root, "continuationItemRenderer")[0];
  const token = s(o(o(item, "continuationEndpoint"), "continuationCommand"), "token");
  if (token) return token;
  const legacy = collectRenderers(root, "nextContinuationData")[0];
  return s(legacy, "continuation");
}

/** The music pageType a browse endpoint opens — "MUSIC_PAGE_TYPE_ALBUM", etc. */
function pageTypeOf(endpoint: any): string {
  return (
    s(
      o(o(endpoint, "browseEndpointContextSupportedConfigs"), "browseEndpointContextMusicConfig"),
      "pageType"
    ) ?? ""
  );
}

function seenAdd(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/* ---------------- shared parse vocabulary (mobile constants) ---------------- */

const DURATION = /^\d+:\d{2}$/;
const YEAR = /^\d{4}$/;
/** A counted quantity rather than a name — "12.4M plays", "13 songs". Narrow
 * enough to leave "21 Savage" and "50 Cent" alone, as in the mobile app. */
const TALLY = /[\d.,]+\s*[KMB]?\s+(plays|views|likes|songs|tracks|subscribers|hours?|minutes?|seconds?)\b.*/i;
const TYPE_WORDS = new Set(["song", "video", "album", "single", "ep", "artist", "playlist", "podcast", "episode"]);
const RELEASE_WORDS = new Set(["album", "single", "ep"]);
const HEADER_RENDERERS = ["musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer"];
const HEADER_CREDIT_LINES = ["straplineTextOne", "subtitle"];
/** Flags a browse card as video content — "50 videos", "Daily Top Music Videos". */
const VIDEO_WORD = /\bvideos?\b/i;

function hasExplicitBadge(node: any): boolean {
  if (node == null) return false;
  if (typeof node === "string") return node === "MUSIC_EXPLICIT_BADGE";
  if (typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasExplicitBadge);
  return Object.values(node).some(hasExplicitBadge);
}

/**
 * The largest offered rendition, at original quality.
 *
 * Rows only carry small placeholders (usually `=w60-h60` / `=w120-h120`); the
 * size parameters are dynamic resize instructions, so the same photo serves
 * up to 1200px — taking the URL verbatim upscales a 60px image into every
 * hero and card.
 */
function bestThumb(thumbnails: any): string {
  return bestThumbUrl(thumbnails);
}

function rowThumbnails(renderer: any): any {
  return o(o(o(renderer, "thumbnail"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null;
}

/** Catalogue art is square; a music-video upload's thumbnail is widescreen. */
function isNotSquare(thumbnails: any): boolean {
  const last = Array.isArray(thumbnails) ? thumbnails[thumbnails.length - 1] : null;
  const width = Number(s(last, "width"));
  const height = Number(s(last, "height"));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return !(width / height >= 0.85 && width / height <= 1.15);
}

/* ---------------- credits ---------------- */

interface Credits {
  artistId?: string;
  artistName?: string;
  albumId?: string;
  albumName?: string;
}

/** The artist / album pages a run list links out to, and their names. */
function creditsOf(runs: any[]): Credits {
  const credits: Credits = {};
  for (const run of runs ?? []) {
    const browse = o(o(run, "navigationEndpoint"), "browseEndpoint");
    const id = s(browse, "browseId");
    if (!id) continue;
    const pageType = pageTypeOf(browse);
    if (pageType.includes("ARTIST") && !credits.artistId) {
      credits.artistId = id;
      credits.artistName = s(run, "text") ?? undefined;
    } else if (pageType.includes("ALBUM") && !credits.albumId) {
      credits.albumId = id;
      credits.albumName = s(run, "text") ?? undefined;
    }
  }
  return credits;
}

/* ---------------- row parsers (mobile parseResponsiveListItem) ---------------- */

function parseDurationText(v: string | null | undefined): number {
  if (!v || !DURATION.test(v.trim())) return 0;
  const parts = v.trim().split(":").map((p) => parseInt(p, 10));
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export interface ParsedSong extends Track {
  /** row's own kind word / widescreen-art verdict — mobile Song.isVideo */
  isVideo: boolean;
}

/**
 * One track row. `fallback` is what the page it came from is billed to — used
 * only where the row itself says nothing.
 */
export function parseResponsiveListItem(renderer: any, fallback: Credits = {}): ParsedSong | null {
  if (!renderer || typeof renderer !== "object") return null;
  // playlistItemData carries the id on playlist/library rows; on search and
  // album rows it hides in the overlay's play endpoint instead.
  const playOverlay = o(
    o(o(o(renderer, "overlay"), "musicItemThumbnailOverlayRenderer"), "content"),
    "musicPlayButtonRenderer"
  );
  const videoId =
    s(o(renderer, "playlistItemData"), "videoId") ??
    s(o(o(playOverlay, "playNavigationEndpoint"), "watchEndpoint"), "videoId");
  if (!videoId) return null;

  const columns = a(renderer, "flexColumns") ?? [];
  const title = text(o(o(columns[0], "musicResponsiveListItemFlexColumnRenderer"), "text"));
  if (!title.trim()) return null;

  const subtitle = text(o(o(columns[1], "musicResponsiveListItemFlexColumnRenderer"), "text"));
  const parts = subtitle
    .split(" • ")
    .map((p) => p.trim())
    .filter(Boolean);
  // A search row states its runtime in the subtitle; an album's own rows do
  // not — there the duration sits in a fixedColumns entry off to the right.
  let duration = parts.find((p) => DURATION.test(p)) ?? "";
  if (!duration) {
    for (const column of a(renderer, "fixedColumns") ?? []) {
      const t = text(o(o(column, "musicResponsiveListItemFixedColumnRenderer"), "text")).trim();
      if (DURATION.test(t)) {
        duration = t;
        break;
      }
    }
  }
  // On the "All" tab the first segment is the row type ("Song", "Video"), not
  // the artist; a tally segment is a play count, not a credit either.
  const rowType = parts.find((p) => TYPE_WORDS.has(p.toLowerCase()));
  const artist = parts.find((p) => !DURATION.test(p) && !TYPE_WORDS.has(p.toLowerCase()) && !TALLY.test(p)) ?? "";

  // The artist/album names in the subtitle carry browse endpoints; pull them
  // out so rows can link to those pages.
  const credits = creditsOf(
    (columns ?? []).flatMap((column: any) => a(o(column, "musicResponsiveListItemFlexColumnRenderer"), "runs") ?? [])
  );

  const thumbnails = rowThumbnails(renderer);

  return {
    id: videoId,
    title,
    artist: credits.artistName || artist || fallback.artistName || "Unknown artist",
    artistId: credits.artistId ?? fallback.artistId,
    albumId: credits.albumId ?? fallback.albumId,
    album: credits.albumName ?? fallback.albumName,
    duration: parseDurationText(duration),
    thumb: bestThumb(thumbnails),
    explicit: hasExplicitBadge(renderer.subtitleBadges) || undefined,
    // The row-type word is the clean signal ("All" tab); otherwise widescreen
    // art gives a music-video upload away where catalogue art is square.
    isVideo: rowType === "video" || isNotSquare(thumbnails),
  };
}

/**
 * A search/browse row that opens a page rather than playing: album/artist/
 * playlist/other (mobile parseBrowseItem).
 */
export function parseBrowseItem(renderer: any): BrowseItem | null {
  const endpoint = o(o(renderer, "navigationEndpoint"), "browseEndpoint");
  const browseId = s(endpoint, "browseId");
  if (!browseId) return null;
  const pageType = pageTypeOf(endpoint);

  const columns = a(renderer, "flexColumns") ?? [];
  const title = text(o(o(columns[0], "musicResponsiveListItemFlexColumnRenderer"), "text"));
  if (!title.trim()) return null;
  const subtitle = text(o(o(columns[1], "musicResponsiveListItemFlexColumnRenderer"), "text"));
  // A release billed as a video compilation would drop every row downstream —
  // skip the dead-end card rather than link to an empty page (mobile's rule).
  if (VIDEO_WORD.test(title) || VIDEO_WORD.test(subtitle)) return null;

  return {
    browseId,
    title,
    subtitle,
    thumb: bestThumb(rowThumbnails(renderer)),
    type: pageType.includes("ALBUM")
      ? "album"
      : pageType.includes("ARTIST")
        ? "artist"
        : pageType.includes("PLAYLIST")
          ? "playlist"
          : "other",
  };
}

/* ---------------- search (mobile parseSearchPage) ---------------- */

/** The promoted result at the head of an unfiltered search — a MusicCardShelf. */
function parseCardShelfSong(renderer: any): ParsedSong | null {
  const videoId = s(o(o(renderer, "onTap"), "watchEndpoint"), "videoId");
  if (!videoId) return null;
  const title = text(o(renderer, "title"));
  if (!title.trim()) return null;

  const subtitleRuns = a(o(renderer, "subtitle"), "runs") ?? [];
  const subtitle = subtitleRuns.map((run) => s(run, "text") ?? "").join("");
  const parts = subtitle
    .split(" • ")
    .map((p) => p.trim())
    .filter(Boolean);
  const duration = parts.find((p) => DURATION.test(p)) ?? "";
  const rowType = parts.find((p) => TYPE_WORDS.has(p.toLowerCase()));
  const credits = creditsOf(subtitleRuns);
  const artist = parts.find((p) => !DURATION.test(p) && !TYPE_WORDS.has(p.toLowerCase()) && !TALLY.test(p)) ?? "";
  const thumbnails =
    o(o(o(renderer, "thumbnail"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null;

  return {
    id: videoId,
    title,
    artist: credits.artistName || artist || "Unknown artist",
    artistId: credits.artistId,
    albumId: credits.albumId,
    album: credits.albumName,
    duration: parseDurationText(duration),
    thumb: bestThumb(thumbnails),
    explicit: hasExplicitBadge(renderer.subtitleBadges) || undefined,
    isVideo: rowType === "video" || isNotSquare(thumbnails),
  };
}

/** Artist, album and playlist cards use the same promoted container as a song. */
function parseCardShelfBrowse(renderer: any): BrowseItem | null {
  const endpoint = o(o(renderer, "onTap"), "browseEndpoint");
  const browseId = s(endpoint, "browseId");
  if (!browseId) return null;
  const pageType = pageTypeOf(endpoint);
  const title = text(o(renderer, "title"));
  if (!title.trim()) return null;
  const subtitle = text(o(renderer, "subtitle"));
  if (VIDEO_WORD.test(title) || VIDEO_WORD.test(subtitle)) return null;

  return {
    browseId,
    title,
    subtitle,
    thumb:
      bestThumb(
        o(o(o(renderer, "thumbnail"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null
      ),
    type: pageType.includes("ALBUM")
      ? "album"
      : pageType.includes("ARTIST")
        ? "artist"
        : pageType.includes("PLAYLIST")
          ? "playlist"
          : "other",
  };
}

/**
 * One page of search rows, plus the token for the next page — the mobile app's
 * parseSearchPage, line for line. The "All" tab's promoted card lives on the
 * card shelf (not in a responsive row), so it is read first; then every
 * ordinary row is classified, browse rows before track rows (an album row also
 * carries a "play album" videoId in its overlay, so the track check would
 * misread every album as a song). `includeVideos` is true only for the Videos
 * filter — the mixed page stays music-only.
 */
export function parseSearchPage(response: any, includeVideos: boolean): SearchPageResult {
  const topResults: SearchRow[] = includeVideos
    ? []
    : collectRenderers(response, "musicCardShelfRenderer").flatMap((card): SearchRow[] => {
        const song = parseCardShelfSong(card);
        // The mixed All page stays music-only; music-video uploads belong
        // exclusively to the dedicated Videos tab.
        if (song) return song.isVideo ? [] : [{ kind: "top", song }];
        const browse = parseCardShelfBrowse(card);
        return browse ? [{ kind: "browse", item: browse }] : [];
      });

  const rows = collectRenderers(response, "musicResponsiveListItemRenderer");
  const seen = new Set<string>();
  const parsed: SearchRow[] = [];

  for (const result of topResults) {
    if (result.kind === "top") {
      if (seenAdd(seen, `v:${result.song.id}`)) parsed.push(result);
    } else if (result.kind === "browse" && seenAdd(seen, `b:${result.item.browseId}`)) {
      parsed.push(result);
    }
  }
  for (const renderer of rows) {
    // Browse rows are tested first — see the doc comment above.
    const browse = parseBrowseItem(renderer);
    if (browse) {
      if (seenAdd(seen, `b:${browse.browseId}`)) parsed.push({ kind: "browse", item: browse });
    } else {
      const song = parseResponsiveListItem(renderer);
      if (song && song.isVideo === includeVideos && seenAdd(seen, `v:${song.id}`)) {
        parsed.push({ kind: "track", song });
      }
    }
  }
  return { rows: parsed, continuation: continuationToken(response) };
}

/* ---------------- browse pages (mobile pageOf) ---------------- */

function firstHeader(root: any): any {
  return HEADER_RENDERERS.map((name) => collectRenderers(root, name)[0]).find(Boolean) ?? null;
}

/** What a release or playlist page calls itself (mobile parseBrowseHeader). */
export function parseBrowseHeader(root: any): { title: string; subtitle: string; thumb: string; artistId?: string } | null {
  const header = firstHeader(root);
  if (!header) return null;
  const title = text(o(header, "title"));
  if (!title.trim()) return null;
  // Current headers split artist ("strapline") and release details ("subtitle")
  // across two lines; older ones pack everything into one of the two.
  const lines = HEADER_CREDIT_LINES.map((key) => text(o(header, key))).filter((t) => t.trim());
  const subtitle = [...new Set(lines)].join(" • ");
  // The artist link lives on the runs of those lines.
  let artistId: string | undefined;
  for (const key of HEADER_CREDIT_LINES) {
    for (const run of a(o(header, key), "runs") ?? []) {
      const browse = o(o(run, "navigationEndpoint"), "browseEndpoint");
      const id = s(browse, "browseId");
      const pageType = pageTypeOf(browse);
      if (id && pageType.includes("ARTIST")) {
        artistId = id;
        break;
      }
    }
    if (artistId) break;
  }
  return {
    title,
    subtitle,
    thumb: bestThumb(o(collectRenderers(header, "musicThumbnailRenderer")[0], "thumbnail")?.thumbnails),
    artistId,
  };
}

/** Who a release page is billed to, off its own header (mobile pageCredit). */
function pageCredit(root: any): Credits {
  const header = firstHeader(root);
  if (!header) return {};
  const lines = HEADER_CREDIT_LINES.map((key) => a(o(header, key), "runs") ?? []);
  const parts = lines.flatMap((line) =>
    line
      .map((run) => s(run, "text") ?? "")
      .join("")
      .split(" • ")
      .map((p) => p.trim())
  );
  if (!parts.some((p) => RELEASE_WORDS.has(p.toLowerCase()))) return {};
  const credits = creditsOf(lines.flat());
  if (credits.artistName) return credits;
  const name = parts.find(
    (p) => p && !TYPE_WORDS.has(p.toLowerCase()) && !TALLY.test(p) && !YEAR.test(p) && !DURATION.test(p)
  );
  return { ...credits, artistName: name };
}

/** Layout-agnostic walk for every row that carries a videoId (mobile collectSongsDeep). */
export function collectSongsDeep(root: any): ParsedSong[] {
  const out = new Map<string, ParsedSong>();
  const credit = pageCredit(root);
  const visit = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.musicResponsiveListItemRenderer) {
      const song = parseResponsiveListItem(node.musicResponsiveListItemRenderer, credit);
      if (song && !out.has(song.id)) out.set(song.id, song);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return [...out.values()];
}

/**
 * A playlist page's own tracks, scoped to the playlist shelf so YouTube's
 * "Suggestions" shelf never reads as songs the user added (mobile
 * parsePlaylistShelf). Null off a page with nothing playlist-shaped in scope.
 */
export function parsePlaylistShelf(root: any): { songs: ParsedSong[]; continuation: string | null } | null {
  const scope =
    o(root, "continuationContents") ??
    o(o(o(root, "contents"), "twoColumnBrowseResultsRenderer"), "secondaryContents");
  if (!scope) return null;
  const playlistScope =
    o(scope, "musicPlaylistShelfContinuation") ?? collectRenderers(scope, "musicPlaylistShelfRenderer")[0];
  if (!playlistScope) return null;
  const credit = pageCredit(root);
  const songs = collectRenderers(playlistScope, "musicResponsiveListItemRenderer")
    .map((r) => parseResponsiveListItem(r, credit))
    .filter((t): t is ParsedSong => !!t)
    .filter((t, i, list) => list.findIndex((x) => x.id === t.id) === i);
  return { songs, continuation: continuationToken(playlistScope) };
}

/** The editorial blurb — "About the artist" / "About the album" (mobile parseDescription). */
export function parseDescription(root: any): string | null {
  const shelf = text(o(collectRenderers(root, "musicDescriptionShelfRenderer")[0], "description"));
  if (shelf.trim()) return shelf;
  for (const name of [...HEADER_RENDERERS, "musicImmersiveHeaderRenderer"]) {
    const onHeader = text(o(collectRenderers(root, name)[0], "description"));
    if (onHeader.trim()) return onHeader;
  }
  return null;
}

/**
 * One browse page of an album or playlist: header + tracks + description, the
 * mobile app's pageOf. Playlist pages are scoped to their own shelf; anything
 * else falls back to the layout-agnostic walk.
 */
export function parseReleasePage(
  response: any,
  browseId: string
): {
  kind: "album" | "playlist" | "other";
  header: { title: string; subtitle: string; thumb: string; artistId?: string } | null;
  tracks: ParsedSong[];
  continuation: string | null;
  description: string | null;
} {
  const header = parseBrowseHeader(response);
  const shelf = parsePlaylistShelf(response);
  const playlist = Boolean(shelf) || browseId.startsWith("VL") || browseId.startsWith("PL");
  const tracks = (shelf ? shelf.songs : collectSongsDeep(response)).map((t) => ({
    ...t,
    // Rows on a release page carry no art of their own — the sleeve hangs on
    // the page header once (album rows are numbered and artless, exactly as on
    // mobile). Anything the player sees for these tracks — the bar, the full
    // screen, ambient — wears the page's cover, so backfill it here.
    thumb: t.thumb || header?.thumb || "",
  }));
  return {
    kind: playlist ? "playlist" : header ? "album" : "other",
    header,
    tracks,
    continuation: shelf ? shelf.continuation : continuationToken(response),
    // YouTube writes blurbs for its own catalogue releases, not user playlists.
    description: playlist ? null : parseDescription(response),
  };
}

/* ---------------- artist page (mobile parseArtistPage) ---------------- */

function artistHeaderPiece(header: any): any {
  return o(header, "musicImmersiveHeaderRenderer") ?? o(header, "musicVisualHeaderRenderer") ?? null;
}

function artistThumbnail(header: any): string {
  if (!header) return "";
  const immersive = o(header, "musicImmersiveHeaderRenderer");
  const visual = o(header, "musicVisualHeaderRenderer");
  const renderer =
    o(o(immersive, "thumbnail"), "musicThumbnailRenderer") ??
    o(o(visual, "foregroundThumbnail"), "musicThumbnailRenderer") ??
    o(o(visual, "thumbnail"), "musicThumbnailRenderer") ??
    collectRenderers(header, "musicThumbnailRenderer")[0];
  return bestThumb(o(renderer, "thumbnail")?.thumbnails);
}

function artistNameOf(header: any): string | null {
  const name = text(o(artistHeaderPiece(header), "title"));
  return name.trim() ? name : null;
}

/** "3.4M monthly listeners", off the header. */
function monthlyListeners(header: any): string | null {
  return firstRunText(o(o(header, "musicImmersiveHeaderRenderer"), "monthlyListenerCount"));
}

/** "1.2M subscribers" — off the header's subscribe button, across both shapes. */
function subscriberCount(header: any): string | null {
  const immersive = o(header, "musicImmersiveHeaderRenderer");
  if (!immersive) return null;
  const button2 = o(o(immersive, "subscriptionButton2"), "subscribeButtonRenderer");
  const button1 = o(o(immersive, "subscriptionButton"), "subscribeButtonRenderer");
  return (
    text(o(button2, "subscriberCountWithSubscribeText")).trim() ||
    text(o(button1, "longSubscriberCountText")).trim() ||
    text(o(button1, "shortSubscriberCountText")).trim() ||
    null
  );
}

/** Home/carousel cards — mobile parseTwoRowItem. */
function parseTwoRowItem(renderer: any): { item: HomeItem; browseId: string | null } | null {
  if (!renderer) return null;
  const title = text(o(renderer, "title"));
  if (!title.trim()) return null;
  const endpoint = o(renderer, "navigationEndpoint");
  const rawBrowseId = s(o(endpoint, "browseEndpoint"), "browseId");
  // History-style cards for uncatalogued uploads carry MPED<videoId> as their
  // "browse" id — that's the actual video id, not a real browsable page.
  const videoId =
    s(o(endpoint, "watchEndpoint"), "videoId") ??
    (rawBrowseId && rawBrowseId.startsWith("MPED") ? rawBrowseId.slice("MPED".length) : null);
  const browseId = rawBrowseId && !rawBrowseId.startsWith("MPED") ? rawBrowseId : null;
  const thumbnails =
    o(o(o(renderer, "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null;
  const subtitle = text(o(renderer, "subtitle"));
  // A playable card with widescreen art is a music video, not an album — drop
  // it; a browsable card with "videos" in its billing is a dead end — drop it.
  if (!browseId && videoId && isNotSquare(thumbnails)) return null;
  if (browseId && (VIDEO_WORD.test(title) || VIDEO_WORD.test(subtitle))) return null;

  const thumb = bestThumb(thumbnails);
  let item: HomeItem;
  if (browseId?.startsWith("UC")) {
    item = { kind: "artist", artist: { id: browseId, name: title, thumb, subtitle } };
  } else if (browseId?.startsWith("MPREb")) {
    item = { kind: "album", album: { id: browseId, title, artist: subtitle, thumb } };
  } else if (browseId) {
    item = { kind: "playlist", playlist: { id: browseId, title, thumb, subtitle } };
  } else if (videoId) {
    item = { kind: "track", track: { id: videoId, title, artist: subtitle || "Unknown artist", duration: 0, thumb } };
  } else {
    return null;
  }
  return { item, browseId };
}

/** Artist landing page: "Top songs" shelf plus section carousels, in order. */
export function parseArtistPage(response: any): {
  name: string | null;
  thumb: string;
  description: string | null;
  subscriberCount: string | null;
  monthlyListeners: string | null;
  songs: ParsedSong[];
  shelves: HomeShelf[];
} {
  const tabs = a(o(o(response, "contents"), "singleColumnBrowseResultsRenderer"), "tabs");
  const sections =
    a(o(o(o(tabs?.[0], "tabRenderer"), "content"), "sectionListRenderer"), "contents") ?? [];

  const header = response?.header ?? null;
  // "Top songs" rows are billed by the page they sit on: the header is the credit.
  const credit: Credits = { artistName: artistNameOf(header) ?? undefined };

  const songs: ParsedSong[] = [];
  const shelves: HomeShelf[] = [];
  for (const section of sections) {
    const shelf = o(section, "musicShelfRenderer");
    if (shelf) {
      for (const row of a(shelf, "contents") ?? []) {
        const song = parseResponsiveListItem(o(row, "musicResponsiveListItemRenderer"), credit);
        if (song && !songs.some((x) => x.id === song.id)) songs.push(song);
      }
    }
    const carousel = o(section, "musicCarouselShelfRenderer");
    if (carousel) {
      const carouselHeader = o(o(carousel, "header"), "musicCarouselShelfBasicHeaderRenderer");
      const title = text(o(carouselHeader, "title"));
      if (VIDEO_WORD.test(title)) continue;
      const items: HomeItem[] = [];
      for (const card of a(carousel, "contents") ?? []) {
        const parsed = parseTwoRowItem(o(card, "musicTwoRowItemRenderer"));
        // The artist page's shelves are pages to open, not tracks to play —
        // the songs live in the shelf above.
        if (parsed && parsed.browseId) items.push(parsed.item);
      }
      if (title.trim() && items.length) shelves.push({ title, items });
    }
  }
  return {
    name: artistNameOf(header),
    thumb: artistThumbnail(header),
    description: parseDescription(response),
    subscriberCount: subscriberCount(header),
    monthlyListeners: monthlyListeners(header),
    songs,
    shelves,
  };
}

/* ---------------- remote playlist header (mobile DetailScreen header lines) ---------------- */

/** The curator's name off the header's avatar stack, when the page ships one. */
function facepileName(header: any): string | null {
  const name = o(o(header, "facepile"), "avatarStackViewModel")?.text?.content;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** A remote (YouTube) playlist page's header + track list. */
export function parseRemotePlaylistPage(response: any, playlistId: string): RemotePlaylistPage {
  void playlistId;
  const header = firstHeader(response);
  const shelf = parsePlaylistShelf(response);
  const pageThumb = bestThumb(o(collectRenderers(header, "musicThumbnailRenderer")[0], "thumbnail")?.thumbnails);
  const tracks = (shelf?.songs ?? collectSongsDeep(response)).map((t) => ({
    ...t,
    thumb: t.thumb || pageThumb,
  }));
  // The mobile DetailScreen splits the header's billing into two lines: the
  // credit ("Marie Liesegang, 105 views") and the uppercase metadata line
  // ("PLAYLIST • 7 TRACKS"). headerLines: year and the kind word drop out of
  // the credit; the meta is kind, year, track count.
  const parts = HEADER_CREDIT_LINES.flatMap((key) => text(o(header, key)).split("•"))
    .map((p) => p.trim())
    .filter(Boolean);
  const year = [...parts].reverse().find((p) => YEAR.test(p));
  const kind = parts.find((p) => p.toLowerCase() === "playlist") ?? "Playlist";
  let credit = parts.filter((p) => p !== year && p.toLowerCase() !== "playlist").join(", ");
  // Newer headers move the curator to the avatar stack and the counts to a
  // second subtitle ("105 views • 7 tracks • 28 minutes"); both say what the
  // old subtitle said, so they join the credit the same way.
  const curator = facepileName(header);
  if (curator && !credit.toLowerCase().includes(curator.toLowerCase())) {
    credit = credit ? `${curator}, ${credit}` : curator;
  }
  const views = text(o(header, "secondSubtitle"))
    .split("•")
    .map((p) => p.trim())
    .find((p) => /view/i.test(p));
  if (views && !credit.toLowerCase().includes(views.toLowerCase())) {
    credit = credit ? `${credit}, ${views}` : views;
  }
  const meta = [
    kind,
    year,
    tracks.length ? `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}` : "",
  ]
    .filter(Boolean)
    .join(" • ")
    .toUpperCase();
  return {
    title: text(o(header, "title")) || "Playlist",
    credit,
    meta,
    thumb: pageThumb,
    tracks,
  };
}

/* ---------------- track credits off the watch queue ---------------- */

/**
 * One track's full credits, read off its own row in the watch queue (`next`)
 * response — "Lana Del Rey • Born To Die • 2011 • 3:43", the line the player
 * is served regardless of how bare the row that queued it was. This is what
 * the lyrics lookup needs when a search row shipped no credit ("Unknown
 * artist", as the mixed All page prints), and what BitChord mobile's
 * parseWatchQueue reads from the same renderer.
 */
export function parseQueueCredits(
  response: any,
  videoId: string
): { artist: string; album?: string; durationSec: number } | null {
  const row = collectRenderers(response, "playlistPanelVideoRenderer").find((r) => s(r, "videoId") === videoId);
  if (!row) return null;
  const bylineRuns = a(o(row, "longBylineText"), "runs") ?? [];
  const byline = bylineRuns.map((run) => s(run, "text") ?? "");
  // The credit is everything before the first bullet; album and year follow.
  const firstBullet = byline.findIndex((t) => t.includes("•"));
  const artist = (
    firstBullet === -1 ? byline.join("") : byline.slice(0, firstBullet).join("")
  ).trim();
  const credits = creditsOf(bylineRuns);
  const album =
    credits.albumName ??
    (firstBullet !== -1
      ? byline
          .slice(firstBullet + 1)
          .join("")
          .split("•")
          .map((p) => p.trim())
          .find((p) => p && !YEAR.test(p) && !TALLY.test(p))
      : undefined);
  // "3:43" or "1:02:33".
  const lengthParts = text(o(row, "lengthText"))
    .trim()
    .split(":")
    .map((p) => parseInt(p, 10));
  const durationSec = lengthParts.length >= 2 && lengthParts.every(Number.isFinite)
    ? lengthParts.reduce((acc, p) => acc * 60 + p, 0)
    : 0;
  return {
    artist,
    album: album || undefined,
    durationSec,
  };
}

/* ---------------- cards from browse rows ---------------- */

/** "Single • Lana Del Rey • 2023" → an album card, the way the row shows it. */
export function browseToAlbum(item: BrowseItem): Album {
  const parts = item.subtitle.split("•").map((p) => p.trim());
  const year = parts.find((p) => YEAR.test(p));
  const credit = parts.filter((p) => p !== year && !RELEASE_WORDS.has(p.toLowerCase()) && p.toLowerCase() !== "playlist");
  return { id: item.browseId, title: item.title, artist: credit.join(", ") || "Unknown artist", year, thumb: item.thumb };
}

export function browseToArtist(item: BrowseItem): Artist {
  return { id: item.browseId, name: item.title, thumb: item.thumb, subtitle: item.subtitle };
}
