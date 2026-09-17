/**
 * Candidate generation — the raw material the section builder ranks.
 *
 * For each artist the taste profile cares about we resolve their YouTube
 * page once and keep it: top songs (mix/radio/station queues), album cards
 * ("Albums featuring songs you like") and the related-artists shelf
 * ("Fans might also like" — the seed of every "More like X" section).
 *
 * Bundles live in a module cache with a 12h TTL and in-flight dedupe, so a
 * burst of Home rebuilds never re-fetches the same artist, and sections can
 * rebuild instantly from cache whenever the underlying signals move.
 */
import { requireBridge } from "../../lib/bridge";
import type { Album, Artist, ArtistPageData, HomeItem, Track } from "../../types";

export interface ArtistBundle {
  artistId: string;
  name: string;
  thumb: string | null;
  topSongs: Track[];
  albums: Album[];
  related: Artist[];
  fetchedAt: number;
}

const TTL_MS = 12 * 3_600_000;

const cache = new Map<string, { bundle: ArtistBundle; at: number }>();
const inflight = new Map<string, Promise<ArtistBundle | null>>();

function harvest(page: ArtistPageData, artistId: string): ArtistBundle {
  const items: HomeItem[] = page.shelves.flatMap((s) => s.items);

  const albums: Album[] = [];
  const seenAlbums = new Set<string>();
  for (const item of items) {
    const album = item.kind === "album" ? item.album : undefined;
    if (!album || seenAlbums.has(album.id)) continue;
    seenAlbums.add(album.id);
    albums.push(album);
  }

  const related: Artist[] = [];
  const seenRelated = new Set<string>([artistId]);
  for (const item of items) {
    const artist = item.kind === "artist" ? item.artist : undefined;
    if (!artist || seenRelated.has(artist.id)) continue;
    seenRelated.add(artist.id);
    related.push(artist);
  }

  return {
    artistId,
    name: page.artist.name,
    thumb: page.artist.thumb ?? null,
    topSongs: page.songs ?? [],
    albums: albums.slice(0, 14),
    related: related.slice(0, 12),
    fetchedAt: Date.now(),
  };
}

export async function getArtistBundle(artistId: string): Promise<ArtistBundle | null> {
  if (!artistId) return null;
  const hit = cache.get(artistId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bundle;

  const pending = inflight.get(artistId);
  if (pending) return pending;

  const task = (async () => {
    try {
      const page = await requireBridge().getArtist(artistId);
      if (!page?.artist) return null;
      const bundle = harvest(page, artistId);
      cache.set(artistId, { bundle, at: Date.now() });
      return bundle;
    } catch {
      return null;
    } finally {
      inflight.delete(artistId);
    }
  })();
  inflight.set(artistId, task);
  return task;
}

/** Synchronous read of whatever is cached — lets the feed paint stale-first. */
export function peekBundle(artistId: string | null | undefined): ArtistBundle | null {
  if (!artistId) return null;
  return cache.get(artistId)?.bundle ?? null;
}

/** Evict entries past their TTL so long sessions don't grow the map forever. */
export function pruneBundles(): void {
  const now = Date.now();
  for (const [id, hit] of cache) {
    if (now - hit.at > TTL_MS) cache.delete(id);
  }
}
