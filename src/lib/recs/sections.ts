/**
 * Section builder — turns the taste profile + candidate bundles into an
 * ordered Home feed. This is the only place that decides WHAT appears on
 * Home, in WHICH order, under WHICH title.
 *
 * Pipeline (per the engine's contract):
 *   descriptors (priority from real signals) → sort → build sequentially
 *   against shared dedup pools → diversity pass (no same-anchor neighbours,
 *   per-artist caps) → cap → Home feed.
 *
 * Determinism: priorities and item picks are pure functions of the profile;
 * the only seed is the day bucket, so equal-scored items rotate daily and
 * never per-render. Inclusion is honest — a section only exists when the
 * data behind its title exists (no "More like X" without X).
 */
import type { Album, Artist, HomeShelf, Track } from "../../types";
import type { ArtistBundle } from "./candidates";
import type { ArtistSignal, TasteProfile } from "./profile";
import type { PlaySource } from "./playback";
import { hash32, seededShuffle } from "./seeded";

/* ------------------------------------------------------------------ types */

export type SectionLayout = "tiles" | "row" | "circles" | "mixes" | "radios" | "yt-shelf" | "moods";

export type SectionItem =
  | { style: "track"; track: Track }
  | { style: "album"; album: Album }
  | { style: "artist"; artist: Artist }
  | { style: "mix"; id: string; name: string; thumb: string | null; caption: string; source: PlaySource }
  | { style: "radio"; id: string; name: string; thumb: string | null; caption: string; source: PlaySource };

export interface HomeSection {
  /** stable identity — "more-like-<artistId>", "stations", … */
  id: string;
  title: string;
  subtitle?: string;
  /** eyebrow header card ("More like / The Weeknd") for artist-anchored rows */
  eyebrow?: { label: string; name: string; thumb: string | null; artistId: string };
  /** the artist this section leans on — diversity pass keeps these apart */
  anchorKey?: string;
  layout: SectionLayout;
  priority: number;
  items: SectionItem[];
  /** layout "yt-shelf" passthrough */
  shelf?: HomeShelf;
  /** layout "moods" chip labels */
  moods?: string[];
}

interface BuildCtx {
  profile: TasteProfile;
  bundles: Map<string, ArtistBundle>;
  usedTracks: Set<string>;
  usedAlbums: Set<string>;
}

/* ---------------------------------------------------------------- helpers */

function takeTracks(
  ctx: BuildCtx,
  pool: Track[],
  opts: { count: number; maxPerArtist?: number; unplayedOnly?: boolean }
): Track[] {
  const maxPerArtist = opts.maxPerArtist ?? 3;
  const perArtist = new Map<string, number>();
  const out: Track[] = [];
  for (const t of pool) {
    if (out.length >= opts.count) break;
    if (ctx.usedTracks.has(t.id)) continue;
    if (opts.unplayedOnly && ctx.profile.playedTrackIds.has(t.id)) continue;
    const key = t.artist.trim().toLowerCase();
    const n = perArtist.get(key) ?? 0;
    if (n >= maxPerArtist) continue;
    perArtist.set(key, n + 1);
    ctx.usedTracks.add(t.id);
    out.push(t);
  }
  return out;
}

/** Shuffle a pool deterministically per day so equal-scored picks rotate. */
function dailyRotation<T>(items: readonly T[], seedKey: string, daySeed: number): T[] {
  return seededShuffle(items, hash32(seedKey) ^ daySeed);
}

function artistsWithIds(profile: TasteProfile): ArtistSignal[] {
  return profile.artists.filter((a) => a.artistId);
}

function bundleFor(ctx: BuildCtx, artist: ArtistSignal): ArtistBundle | null {
  return (artist.artistId ? ctx.bundles.get(artist.artistId) : undefined) ?? null;
}

function captionWith(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `With ${names[0]}`;
  if (names.length === 2) return `With ${names[0]} and ${names[1]}`;
  return `With ${names[0]}, ${names[1]} and ${names[2]}`;
}

function hourAwareTodayTitle(now: number): string {
  const h = new Date(now).getHours();
  if (h < 5) return "Late night picks";
  if (h < 12) return "Picks for your morning";
  if (h < 17) return "Recommended for today";
  if (h < 22) return "Recommended for tonight";
  return "Late night picks";
}

/** Unplayed songs surfaced by an artist's related-artists shelf. */
function relatedSongPool(ctx: BuildCtx, bundle: ArtistBundle): Track[] {
  const pool: Track[] = [];
  for (const rel of bundle.related) {
    const relBundle = ctx.bundles.get(rel.id);
    if (relBundle) pool.push(...relBundle.topSongs);
  }
  return pool;
}

/* -------------------------------------------------------------- descriptors */

interface Descriptor {
  id: string;
  priority: number;
  anchorKey?: string;
  /** sections with fewer live items than this are dropped (default 3) */
  minItems?: number;
  build: (ctx: BuildCtx) => HomeSection | null;
}

function describeFeed(profile: TasteProfile, ytShelves: HomeShelf[] | null, now: number, moods?: string[]): Descriptor[] {
  const list: Descriptor[] = [];
  const top = artistsWithIds(profile).slice(0, 6);
  const maxScore = top[0]?.score ?? 1;

  /* ---- jump back in — the tiles, straight from history ---- */
  if (profile.recentlyPlayed.length >= 4) {
    const lastAt = profile.artists.reduce((m, a) => Math.max(m, a.lastPlayedAt ?? 0), 0);
    const hoursSince = lastAt ? (now - lastAt) / 3_600_000 : Infinity;
    list.push({
      id: "jump-back-in",
      priority: 95 + (hoursSince < 8 ? 5 : 0),
      build: (ctx) => ({
        id: "jump-back-in",
        title: "Jump back in",
        layout: "tiles",
        priority: 0,
        items: ctx.profile.recentlyPlayed.slice(0, 6).map((track) => ({ style: "track", track })),
      }),
    });
  }

  /* ---- cold start: browse chips + YouTube's own feed ---- */
  // The chips are the provider's own per-market moods & genres (passed in by
  // the feed once known). No moods yet → no chips yet: they arrive with the
  // next paint rather than flashing a hardcoded/fallback list.
  if (profile.maturity === "cold" && moods && moods.length > 0) {
    list.push({
      id: "browse",
      priority: 90,
      minItems: 0, // content rides the `moods` field, not `items`
      build: () => ({
        id: "browse",
        title: "Browse",
        subtitle: "Common searches to get you started",
        layout: "moods",
        priority: 0,
        items: [],
        moods: moods.slice(0, 8),
      }),
    });
  }

  /* ---- your favorite artists — ranked purely by behavior ---- */
  if (top.length >= 3) {
    list.push({
      id: "favorite-artists",
      priority: 64 + (profile.maturity === "strong" ? 6 : 0),
      build: (ctx) => {
        const items = top.slice(0, 8).map((a) => ({
          style: "artist" as const,
          artist: {
            id: a.artistId as string,
            name: a.name,
            thumb: bundleFor(ctx, a)?.thumb ?? a.thumb ?? "",
          },
        }));
        return {
          id: "favorite-artists",
          title: "Your favorite artists",
          layout: "circles",
          priority: 0,
          items,
        };
      },
    });
  }

  /* ---- more like [artist] — one per top seed, affinity-ranked ---- */
  top.slice(0, 2).forEach((anchor, i) => {
    list.push({
      id: `more-like-${anchor.key}`,
      anchorKey: anchor.key,
      priority: 56 + 24 * (anchor.score / maxScore) - i * 4,
      build: (ctx) => {
        const b = bundleFor(ctx, anchor);
        if (!b) return null;
        const items: SectionItem[] = [];
        const relNames = b.related.slice(0, 3).map((r) => r.name);
        items.push({
          style: "radio",
          id: `${b.artistId}-radio`,
          name: anchor.name,
          thumb: b.thumb ?? anchor.thumb,
          caption: relNames.length ? captionWith(relNames) : "Radio",
          source: { type: "artist-radio", artistId: b.artistId as string, name: `${anchor.name} Radio` },
        });
        for (const rel of b.related.slice(0, 3)) {
          items.push({ style: "artist", artist: rel });
        }
        const album = b.albums.find((al) => !ctx.usedAlbums.has(al.id));
        if (album) {
          ctx.usedAlbums.add(album.id);
          items.push({ style: "album", album });
        }
        if (items.length < 3) return null;
        return {
          id: `more-like-${anchor.key}`,
          title: anchor.name,
          eyebrow: { label: "More like", name: anchor.name, thumb: b.thumb ?? anchor.thumb, artistId: b.artistId as string },
          anchorKey: anchor.key,
          layout: "row",
          priority: 0,
          items,
        };
      },
    });
  });

  /* ---- your top mixes — artist mixes + a discovery mix ---- */
  if (top.length >= 2) {
    list.push({
      id: "top-mixes",
      priority: profile.maturity === "light" ? 60 : 70,
      minItems: 2,
      build: (ctx) => {
        const items: SectionItem[] = [];
        for (const a of top.slice(0, 4)) {
          const b = bundleFor(ctx, a);
          const relNames = b?.related.slice(0, 3).map((r) => r.name) ?? [];
          items.push({
            style: "mix",
            id: `${a.artistId}-mix`,
            name: `${a.name} Mix`,
            thumb: b?.thumb ?? a.thumb,
            caption: relNames.length ? captionWith(relNames) : a.name,
            source: { type: "artist-mix", artistId: a.artistId as string, name: `${a.name} Mix` },
          });
        }
        // Discovery mix — unplayed songs from the seeds' related artists.
        const pool = dailyRotation(
          top.flatMap((a) => (bundleFor(ctx, a) ? relatedSongPool(ctx, bundleFor(ctx, a) as ArtistBundle) : [])),
          "discovery-mix",
          ctx.profile.daySeed
        );
        const discovery = takeTracks(ctx, pool, { count: 20, maxPerArtist: 4, unplayedOnly: true });
        if (discovery.length >= 8) {
          const cover = bundleFor(ctx, top[0]);
          items.push({
            style: "mix",
            id: "discovery-mix",
            name: "Discovery Mix",
            thumb: cover?.related[0]?.thumb ?? cover?.thumb ?? top[0].thumb,
            caption: "New songs near your taste",
            source: { type: "tracks", tracks: discovery, label: "Discovery Mix" },
          });
        }
        return items.length >= 2
          ? { id: "top-mixes", title: "Your top mixes", layout: "mixes", priority: 0, items }
          : null;
      },
    });
  }

  /* ---- recommended [morning/today/tonight/late-night] ---- */
  if (top.length >= 1) {
    list.push({
      id: "recommended-today",
      priority: 62 + Math.round(8 * profile.hourEnergy),
      build: (ctx) => {
        const pools = top
          .map((a) => bundleFor(ctx, a))
          .filter((b): b is ArtistBundle => !!b)
          .map((b, i) => dailyRotation(relatedSongPool(ctx, b), `today-${b.artistId}`, ctx.profile.daySeed + i));
        const picked = takeTracks(ctx, pools.flat(), { count: 12, maxPerArtist: 2, unplayedOnly: true });
        if (picked.length < 4) return null;
        return {
          id: "recommended-today",
          title: hourAwareTodayTitle(now),
          subtitle: "Inspired by your recent activity",
          layout: "row",
          priority: 0,
          items: picked.map((track) => ({ style: "track", track })),
        };
      },
    });
  }

  /* ---- recommended stations ---- */
  if (top.length >= 2 && profile.maturity !== "light") {
    list.push({
      id: "stations",
      priority: 50,
      minItems: 2,
      build: (ctx) => {
        const items: SectionItem[] = top.slice(0, 4).map((a) => {
          const b = bundleFor(ctx, a);
          const relNames = b?.related.slice(0, 3).map((r) => r.name) ?? [];
          return {
            style: "radio" as const,
            id: `${a.artistId}-station`,
            name: a.name,
            thumb: b?.thumb ?? a.thumb,
            caption: relNames.length ? captionWith(relNames) : "Radio",
            source: { type: "artist-radio", artistId: a.artistId as string, name: `${a.name} Radio` },
          };
        });
        return {
          id: "stations",
          title: "Recommended stations",
          subtitle: "Non-stop music based on your favorite songs and artists.",
          layout: "radios",
          priority: 0,
          items,
        };
      },
    });
  }

  /* ---- albums featuring songs you like ---- */
  if (top.length >= 2) {
    list.push({
      id: "albums-for-you",
      priority: 46,
      build: (ctx) => {
        const items: SectionItem[] = [];
        const seen = new Set<string>();
        for (const a of top) {
          const b = bundleFor(ctx, a);
          if (!b) continue;
          for (const album of b.albums) {
            if (seen.has(album.id) || ctx.usedAlbums.has(album.id) || items.length >= 8) continue;
            seen.add(album.id);
            ctx.usedAlbums.add(album.id);
            items.push({ style: "album", album });
          }
          if (items.length >= 8) break;
        }
        return items.length >= 4
          ? { id: "albums-for-you", title: "Albums featuring songs you like", layout: "row", priority: 0, items }
          : null;
      },
    });
  }

  /* ---- because you listened to [3rd seed] ---- */
  const becauseAnchor = top[2] ?? top[1];
  if (becauseAnchor && top.length >= 3) {
    list.push({
      id: `because-${becauseAnchor.key}`,
      anchorKey: becauseAnchor.key,
      priority: 42,
      build: (ctx) => {
        const b = bundleFor(ctx, becauseAnchor);
        if (!b) return null;
        const pool = dailyRotation(relatedSongPool(ctx, b), `because-${b.artistId}`, ctx.profile.daySeed);
        const picked = takeTracks(ctx, pool, { count: 8, maxPerArtist: 2, unplayedOnly: true });
        if (picked.length < 4) return null;
        return {
          id: `because-${becauseAnchor.key}`,
          title: `Because you listened to ${becauseAnchor.name}`,
          eyebrow: {
            label: "Because you listened to",
            name: becauseAnchor.name,
            thumb: b.thumb ?? becauseAnchor.thumb,
            artistId: b.artistId as string,
          },
          anchorKey: becauseAnchor.key,
          layout: "row",
          priority: 0,
          items: picked.map((track) => ({ style: "track", track })),
        };
      },
    });
  }

  /* ---- discover something new — the leftover unplayed pool ---- */
  if (top.length >= 2) {
    list.push({
      id: "discover-new",
      priority: 34,
      build: (ctx) => {
        const pool = dailyRotation(
          top.flatMap((a) => (bundleFor(ctx, a) ? relatedSongPool(ctx, bundleFor(ctx, a) as ArtistBundle) : [])),
          "discover",
          ctx.profile.daySeed
        );
        const picked = takeTracks(ctx, pool, { count: 10, maxPerArtist: 2, unplayedOnly: true });
        if (picked.length < 4) return null;
        return {
          id: "discover-new",
          title: "Discover something new",
          subtitle: "From artists close to the ones you play",
          layout: "row",
          priority: 0,
          items: picked.map((track) => ({ style: "track", track })),
        };
      },
    });
  }

  /* ---- recently played row (square cards, complements the tiles) ---- */
  if (profile.recentlyPlayed.length >= 8) {
    list.push({
      id: "recently-played",
      priority: 44,
      build: (ctx) => ({
        id: "recently-played",
        title: "Recently played",
        layout: "row",
        priority: 0,
        items: ctx.profile.recentlyPlayed.slice(0, 12).map((track) => ({ style: "track", track })),
      }),
    });
  }

  /* ---- Market shelves (regional charts + YTM's regional feed) — the
          cold-start mixture and the long-tail filler for thin feeds. Cold
          and light users get an extra slot: with little personal data yet,
          market popularity is the honest content they have. ---- */
  if (ytShelves) {
    const slots = profile.maturity === "cold" || profile.maturity === "light" ? 3 : 2;
    ytShelves.slice(0, slots).forEach((shelf, i) => {
      list.push({
        id: `yt-${i}-${shelf.title}`,
        priority: profile.maturity === "cold" ? 60 - i : 24 - i,
        minItems: 0, // content rides the `shelf` field, not `items`
        build: () => ({
          id: `yt-${i}-${shelf.title}`,
          title: shelf.title,
          layout: "yt-shelf",
          priority: 0,
          items: [],
          shelf,
        }),
      });
    });
  }

  return list;
}

/* ------------------------------------------------------------------- build */

const MAX_SECTIONS = 9;

export function buildHomeSections(args: {
  profile: TasteProfile;
  bundles: Map<string, ArtistBundle>;
  ytShelves: HomeShelf[] | null;
  /** provider's per-market mood titles for the cold-start Browse chips */
  moods?: string[];
  now?: number;
}): HomeSection[] {
  const { profile, bundles, ytShelves, moods, now = Date.now() } = args;
  const ctx: BuildCtx = { profile, bundles, usedTracks: new Set(), usedAlbums: new Set() };

  const descriptors = describeFeed(profile, ytShelves, now, moods).sort((a, b) => b.priority - a.priority);

  const sections: HomeSection[] = [];
  for (const d of descriptors) {
    if (sections.length >= MAX_SECTIONS) break;
    const section = d.build(ctx);
    if (section && section.items.length >= (d.minItems ?? 3)) sections.push(section);
  }

  // Diversity pass: never two sections leaning on the same artist back to back.
  for (let i = 1; i < sections.length; i++) {
    const anchor = sections[i].anchorKey;
    if (!anchor || anchor !== sections[i - 1].anchorKey) continue;
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].anchorKey !== anchor) {
        const [moved] = sections.splice(i, 1);
        sections.splice(j, 0, moved);
        break;
      }
    }
  }

  return sections;
}

/** Cards' pastel treatments (mix bands / radio tiles) — picked by stable id hash. */
export const CARD_PASTELS = [
  ["#a7baf5", "#8ea7ef"],
  ["#c99bf2", "#b57fee"],
  ["#f2a98e", "#ec9377"],
  ["#a9e3c3", "#8fd7ae"],
  ["#d8e07c", "#cbd45f"],
  ["#f3b8cf", "#eda0bd"],
  ["#f0cf8e", "#e9bd6e"],
  ["#9fd8f0", "#7fc7e8"],
] as const;

export function pastelFor(id: string): (typeof CARD_PASTELS)[number] {
  return CARD_PASTELS[hash32(id) % CARD_PASTELS.length];
}

/** Rank helper exposed for tests/QA: how strongly a section deserves its slot. */
export function sectionPriorities(profile: TasteProfile, ytShelves: HomeShelf[] | null, now?: number): Array<{ id: string; priority: number }> {
  return describeFeed(profile, ytShelves, now ?? Date.now())
    .sort((a, b) => b.priority - a.priority)
    .map((d) => ({ id: d.id, priority: Math.round(d.priority) }));
}
