/**
 * Home feed orchestration — one hook the Home view simply renders.
 *
 * Waves, cheapest first (each wave paints as soon as it lands):
 *   0. sections buildable from local data + cached bundles — instant
 *   1. artist identity for top names (persisted cache, then one search each)
 *   2. artist-page bundles for the top seeds
 *   3. related-artist bundles (fuel for discovery pools) + YouTube's feed
 *      as cold-start/filler
 *
 * Rebuilds are gated by the profile signature — plays, likes, skips and
 * searches each nudge it, so the feed evolves with behavior while never
 * recalculating on unrelated renders. All network work is cached (12h for
 * artist pages, 1h for YouTube's feed), so a signature bump rebuilds
 * sections from cache in milliseconds.
 */
import { useEffect, useRef, useState } from "react";
import { peekArtistMeta, resolveArtistMeta } from "../../stores/artistMeta";
import { requireBridge } from "../../lib/bridge";
import { useUI } from "../../stores/ui";
import type { HomeShelf } from "../../types";
import { FALLBACK_MOODS } from "../../../electron/moods";
import { getArtistBundle, peekBundle, pruneBundles, type ArtistBundle } from "./candidates";
import { useTasteProfile, type TasteProfile } from "./profile";
import { buildHomeSections, type HomeSection } from "./sections";

/* ------------------------------------------------------- youtube feed cache */
/* Stale-while-revalidate: a manual refresh marks the caches stale and the
   next rebuild refetches — but wave 0 keeps painting the LAST KNOWN shelves
   and chips, so a refresh never flashes fallback content or an empty page.
   The stale copy is also the failure fallback if the refetch fails. */

const YT_TTL_MS = 3_600_000;
let ytShelvesCache: { shelves: HomeShelf[]; at: number } | null = null;
let ytShelvesStale = false;
let chartsCache: { shelves: HomeShelf[]; at: number } | null = null;
let chartsStale = false;

function shelvesUsable(cache: { at: number } | null, stale: boolean): boolean {
  return cache != null && (stale || Date.now() - cache.at < YT_TTL_MS);
}

async function loadYtShelves(): Promise<HomeShelf[] | null> {
  if (shelvesUsable(ytShelvesCache, ytShelvesStale)) return ytShelvesCache!.shelves;
  try {
    const shelves = await requireBridge().getHome();
    if (shelves && shelves.length > 0) {
      ytShelvesCache = { shelves, at: Date.now() };
      ytShelvesStale = false;
      return shelves;
    }
  } catch {
    /* offline / no bridge — fall back to whatever we kept */
  }
  return ytShelvesCache?.shelves ?? null;
}

/**
 * YTM Charts for the device market — the provider's own regional popularity
 * ranking. The region lives in the InnerTube session's `gl`, resolved from
 * the device (OS region → timezone → global default), never from the auth
 * method; the personalized orchestration around it is unchanged.
 */
async function loadCharts(): Promise<HomeShelf[] | null> {
  if (shelvesUsable(chartsCache, chartsStale)) return chartsCache!.shelves;
  try {
    const shelves = await requireBridge().getCharts();
    if (shelves && shelves.length > 0) {
      chartsCache = { shelves, at: Date.now() };
      chartsStale = false;
      return shelves;
    }
  } catch {
    /* charts unavailable — the home feed composes without them */
  }
  return chartsCache?.shelves ?? null;
}

/**
 * The market-aware cold-start/filler shelf set: regional charts first (the
 * provider's own popularity ranking for this device's market), then
 * YouTube's regional home feed (editorial mixes + discovery, which also
 * carries the global content every market keeps). Either half may be
 * missing — charts can fail, home can come back empty — but never both
 * unless the provider itself is unreachable, in which case callers fall
 * back to the personalized sections alone.
 */
async function loadMarketShelves(): Promise<HomeShelf[] | null> {
  const [charts, home] = await Promise.all([loadCharts(), loadYtShelves()]);
  if (!charts && !home) return null;
  return [...(charts ?? []), ...(home ?? [])];
}

/** Last-known shelves for the instant wave-0 paint, stale or fresh. */
function cachedMarketShelves(): HomeShelf[] | null {
  const charts = chartsCache?.shelves ?? [];
  const home = ytShelvesCache?.shelves ?? [];
  if (!charts.length && !home.length) return null;
  return [...charts, ...home];
}

/* -------------------------------------------------- moods & genres cache */

const MOODS_TTL_MS = 24 * 3_600_000;
let moodsCache: { titles: string[]; at: number } | null = null;

/**
 * The provider's per-market moods & genres (Explore page) — the cold-start
 * Browse chips. The list follows the session's `gl` (the resolved device
 * market), so each market gets its own suggestions. Cached for a day; a
 * failure returns null and the section falls back to a neutral global set.
 */
async function loadMoodTitles(): Promise<string[] | null> {
  if (moodsCache && Date.now() - moodsCache.at < MOODS_TTL_MS) return moodsCache.titles;
  try {
    const moods = (await requireBridge().getMoods()) as Array<{ title: string; browseId: string }>;
    const titles = moods
      .filter((m) => m.browseId.includes("moods_and_genres_category"))
      .map((m) => m.title);
    if (titles.length >= 6) {
      moodsCache = { titles, at: Date.now() };
      return titles;
    }
  } catch {
    /* offline — the Browse section falls back to neutral global chips */
  }
  return moodsCache?.titles ?? null;
}

/* ------------------------------------------------------------- bundle scope */

function collectBundles(profile: TasteProfile, ids: string[] | null): Map<string, ArtistBundle> {
  const map = new Map<string, ArtistBundle>();
  const scope =
    ids ??
    profile.artists
      .filter((a) => a.artistId)
      .slice(0, 6)
      .map((a) => a.artistId as string);
  for (const id of scope) {
    const bundle = peekBundle(id);
    if (bundle) map.set(id, bundle);
  }
  return map;
}

/* -------------------------------------------------------------- orchestration */

async function orchestrate(profile: TasteProfile, apply: (sections: HomeSection[]) => void): Promise<void> {
  pruneBundles();

  // Wave 1 — identity. Names the meta cache knows resolve for free.
  const topNames = profile.artists.slice(0, 6);
  await Promise.all(
    topNames.map(async (a) => {
      if (a.artistId) return;
      const meta = await resolveArtistMeta(a.name);
      if (meta) {
        a.artistId = meta.id;
        a.thumb = a.thumb ?? meta.thumb;
      }
    })
  );

  // Wave 2 — seed artist pages (top songs / albums / related shelf). Six
  // seeds so favorites/mixes/stations get real photos and captions for the
  // whole visible affinity range, not just the podium.
  const seeds = profile.artists.filter((a) => a.artistId).slice(0, 6);
  await Promise.all(seeds.map((a) => getArtistBundle(a.artistId as string)));

  const seedIds = seeds.map((a) => a.artistId as string);
  apply(buildHomeSections({ profile, bundles: collectBundles(profile, seedIds), ytShelves: null }));

  // Wave 3 — related artists' pages feed the discovery pools; YouTube's own
  // feed covers cold start and pads a thin feed.
  const relatedIds = new Set<string>();
  for (const seedId of seedIds) {
    const bundle = peekBundle(seedId);
    for (const rel of bundle?.related.slice(0, 2) ?? []) relatedIds.add(rel.id);
  }
  await Promise.all([...relatedIds].slice(0, 6).map((id) => getArtistBundle(id)));

  const feedThin = collectBundles(profile, [...seedIds, ...relatedIds]).size < 2;
  const wantYt = feedThin || profile.maturity === "cold" || profile.maturity === "light";
  const marketShelves = wantYt ? await loadMarketShelves() : null;
  apply(
    buildHomeSections({
      profile,
      bundles: collectBundles(profile, [...seedIds, ...relatedIds]),
      ytShelves: marketShelves,
    })
  );
}

/* --------------------------------------------------------------------- hook */

/** Manual refresh (TopBar button): mark the market shelves stale so the next
 *  rebuild refetches charts and the regional feed, then bump the nonce —
 *  profile.ts forces a stats reload through the same signal so plays recorded
 *  since the last poll land before the rebuild. The stale copies still paint
 *  instantly (stale-while-revalidate), so a refresh never flashes fallback
 *  content or an empty page, and the resolved market is never reset: it is a
 *  device property, not feed state. The moods catalog is static — it is not
 *  part of a refresh at all. */
export function reloadHomeFeed(): void {
  ytShelvesStale = true;
  chartsStale = true;
  useUI.getState().bumpHomeReload();
}

export function useHomeFeed(): { sections: HomeSection[]; profile: TasteProfile | null } {
  const profile = useTasteProfile();
  const reloadNonce = useUI((s) => s.homeReloadNonce);
  const [sections, setSections] = useState<HomeSection[]>([]);
  const runSeq = useRef(0);
  const signature = profile?.signature ?? "";

  useEffect(() => {
    if (!profile) {
      setSections([]);
      return;
    }
    const seq = ++runSeq.current;
    const apply = (next: HomeSection[]): void => {
      if (runSeq.current === seq) setSections(next);
    };

    // Wave 0 — instant paint from stores + bundle cache + the last-known
    // market shelves/chips (stale-while-revalidate: a refresh repaints THIS,
    // then swaps in fresh data when the refetch lands). Never a blank Home,
    // never a fallback flash.
    apply(
      buildHomeSections({
        profile,
        bundles: collectBundles(profile, null),
        ytShelves: cachedMarketShelves(),
        moods: moodsCache?.titles ?? undefined,
      })
    );

    // No listening signal at all — the market-aware cold start: regional
    // charts + YouTube's regional feed + the market's own browse chips,
    // composed with the (still empty) personalized sections. The moment any
    // artist signal exists (a single play counts), the personalized
    // orchestration below takes over and the market shelves become filler.
    if (profile.artists.length === 0) {
      void Promise.all([loadMarketShelves(), loadMoodTitles()]).then(([shelves, moodTitles]) => {
        apply(
          buildHomeSections({
            profile,
            bundles: collectBundles(profile, null),
            ytShelves: shelves,
            // Fetch failed → the neutral global chips; never a hardcoded
            // country list, and only after the provider had its chance.
            moods: (moodTitles ?? FALLBACK_MOODS.map((m) => m.title)) as string[],
          })
        );
      });
      return;
    }

    const timer = window.setTimeout(() => {
      void orchestrate(profile, apply);
    }, 250);
    return () => window.clearTimeout(timer);
    // Re-run only when the underlying signals actually move — or when the
    // user asks for a manual refresh from the TopBar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, reloadNonce]);

  return { sections, profile };
}
