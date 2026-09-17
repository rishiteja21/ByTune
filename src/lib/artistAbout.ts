/**
 * About-the-artist data for the playing track — the Spotify-panel card.
 *
 * Resolves the artist page the same way the app resolves artist imagery:
 * by the track's artist id when it has one, otherwise by an artist search on
 * the name (never for placeholder credits — "Unknown artist" has no one
 * behind it). The editorial blurb, photo and listener counts come from the
 * same artist page the artist screen shows.
 */
import { useEffect, useState } from "react";
import type { Track } from "../types";

export interface ArtistAbout {
  artistId: string;
  name: string;
  thumb: string | null;
  /** The "About the artist" editorial blurb, when YouTube wrote one. */
  description: string | null;
  /** "332M monthly audience" off the page header — re-worded for display. */
  monthlyListeners: string | null;
  subscriberCount: string | null;
}

const JUNK_ARTIST = "unknown artist";

const cache = new Map<string, ArtistAbout | null>();

async function resolveAbout(track: Track): Promise<ArtistAbout | null> {
  try {
    let id = track.artistId ?? null;
    let name = track.artist;
    if (!id) {
      if (!track.artist || track.artist.trim().toLowerCase() === JUNK_ARTIST) return null;
      const res = (await window.bytune?.search(track.artist)) as {
        artists?: Array<{ id?: string; name?: string }>;
      } | null;
      const top = res?.artists?.[0];
      if (!top?.id) return null;
      id = top.id;
      name = top.name || track.artist;
    }
    if (!window.bytune?.getArtist || !id) return null;
    const page = (await window.bytune.getArtist(id)) as {
      artist?: { name?: string; thumb?: string };
      description?: string | null;
      monthlyListeners?: string | null;
      subscriberCount?: string | null;
    } | null;
    if (!page?.artist) return null;
    return {
      artistId: id,
      name: page.artist.name || name,
      thumb: page.artist.thumb ?? null,
      description: page.description ?? null,
      monthlyListeners: page.monthlyListeners ?? null,
      subscriberCount: page.subscriberCount ?? null,
    };
  } catch {
    return null;
  }
}

/** The playing track's artist about-card data, cached per artist. */
export function useArtistAbout(track: Track | null): ArtistAbout | null {
  const key = track ? track.artistId ?? `name:${track.artist}` : "";
  const [data, setData] = useState<ArtistAbout | null>(() =>
    key && cache.has(key) ? cache.get(key)! : null
  );

  useEffect(() => {
    if (!track || !key) return;
    const cached = cache.get(key);
    if (cached !== undefined) {
      setData(cached);
      return;
    }
    let cancelled = false;
    setData(null);
    void resolveAbout(track).then((res) => {
      cache.set(key, res);
      if (!cancelled) setData(res);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return data;
}

/** "332M monthly audience" → the chip text the app shows everywhere else. */
export function monthlyListenersLabel(about: ArtistAbout | null): string | null {
  const count = about?.monthlyListeners?.split(" ")[0];
  return count ? `${count} monthly listeners` : null;
}
