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
import { getArtistBundle, peekBundle, pruneBundles, type ArtistBundle } from "./candidates";
import { useTasteProfile, type TasteProfile } from "./profile";
import { buildHomeSections, type HomeSection } from "./sections";

/* ------------------------------------------------------- youtube feed cache */

const YT_TTL_MS = 3_600_000;
let ytShelvesCache: { shelves: HomeShelf[]; at: number } | null = null;

async function loadYtShelves(): Promise<HomeShelf[] | null> {
  if (ytShelvesCache && Date.now() - ytShelvesCache.at < YT_TTL_MS) return ytShelvesCache.shelves;
  try {
    const shelves = await requireBridge().getHome();
    if (shelves && shelves.length > 0) {
      ytShelvesCache = { shelves, at: Date.now() };
      return shelves;
    }
  } catch {
    /* offline / no bridge — fall back to whatever we kept */
  }
  return ytShelvesCache?.shelves ?? null;
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
  const ytShelves = wantYt ? await loadYtShelves() : null;
  apply(
    buildHomeSections({
      profile,
      bundles: collectBundles(profile, [...seedIds, ...relatedIds]),
      ytShelves,
    })
  );
}

/* --------------------------------------------------------------------- hook */

/** Manual refresh (TopBar button): drop the YouTube feed cache so it refetches,
 *  then bump the nonce — Home re-orchestrates, and profile.ts forces a stats
 *  reload through the same signal so plays recorded since the last poll land
 *  before the rebuild. */
export function reloadHomeFeed(): void {
  ytShelvesCache = null;
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

    // Wave 0 — instant paint from stores + bundle cache. Never a blank Home.
    apply(buildHomeSections({ profile, bundles: collectBundles(profile, null), ytShelves: null }));

    // No listening signal at all — YouTube's own feed is the honest cold
    // start. The moment any artist signal exists (a single play counts),
    // the personalized orchestration below takes over.
    if (profile.artists.length === 0) {
      void loadYtShelves().then((shelves) => {
        apply(buildHomeSections({ profile, bundles: collectBundles(profile, null), ytShelves: shelves }));
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
