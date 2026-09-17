/**
 * Search results — BitChord mobile's SearchScreen, on the desktop.
 *
 * The rows come straight from YouTube Music (the same endpoint, filter params
 * and parser the phone uses), so the list is YouTube's own: its order, its
 * count, its "Top result" card and its mixed "All" page split into Songs /
 * Artists / Albums / Playlists / More sections. No source mixing, no
 * re-ranking. Scrolling near the end of the list fetches the next page via
 * YouTube's continuation token, exactly like the phone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Disc3, LayoutGrid, ListMusic, ListPlus, MoreVertical, Music2, Play, SearchX, User, X, type LucideIcon } from "lucide-react";
import { Artwork, ErrorState, ExplicitBadge, ListSkeleton, Pills } from "../components/primitives";
import { trackMenuItems } from "../lib/trackActions";
import { useDrag } from "../lib/dnd";
import { fmtTime } from "../lib/format";
import { usePlayer } from "../stores/player";
import { useRecents } from "../stores/recents";
import { tintHoverHandlers, useUI } from "../stores/ui";
import type { BrowseItem, SearchFilter, SearchPageResult, SearchRow, Track } from "../types";

const FILTERS: { key: SearchFilter; label: string; icon: LucideIcon }[] = [
  { key: "all", label: "All", icon: LayoutGrid },
  { key: "songs", label: "Songs", icon: Music2 },
  { key: "videos", label: "Videos", icon: Play },
  { key: "albums", label: "Albums", icon: Disc3 },
  { key: "artists", label: "Artists", icon: User },
  { key: "playlists", label: "Playlists", icon: ListMusic },
];

/** The All tab's mixed page, grouped the way the mobile app groups it. */
interface SearchSection {
  title: string;
  rows: SearchRow[];
}

function searchSections(rows: SearchRow[], filter: SearchFilter): SearchSection[] {
  if (filter !== "all") return [{ title: "", rows }];
  const sections: SearchSection[] = [
    { title: "Songs", rows: rows.filter((r) => r.kind === "track") },
    { title: "Artists", rows: rows.filter((r) => r.kind === "browse" && r.item.type === "artist") },
    { title: "Albums", rows: rows.filter((r) => r.kind === "browse" && r.item.type === "album") },
    { title: "Playlists", rows: rows.filter((r) => r.kind === "browse" && r.item.type === "playlist") },
    { title: "More", rows: rows.filter((r) => r.kind === "browse" && r.item.type === "other") },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

function rowKey(row: SearchRow, i: number): string {
  if (row.kind === "browse") return `b:${row.item.browseId}`;
  return `v:${row.song.id}-${i}`;
}

/* ---------------------------------------------------------------- */
/* Rows                                                             */
/* ---------------------------------------------------------------- */

function SongSearchRow({ song, onPlay }: { song: Track; onPlay: () => void }) {
  const openContextMenu = useUI((s) => s.openContextMenu);
  const drag = useDrag({ track: song });
  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, trackMenuItems(song));
  };
  return (
    <div
      {...tintHoverHandlers(song.thumb)}
      {...drag.props}
      onClick={onPlay}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      className={`group flex items-center gap-3.5 h-[64px] px-3 rounded-lg cursor-pointer select-none hover:bg-ink-hi/[0.05] ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork src={song.thumb} className="w-[52px] h-[52px] rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.2px] text-ink-hi">
          {song.explicit && <ExplicitBadge />}
          <span className="truncate">{song.title}</span>
        </div>
        <div className="text-[14px] truncate text-ink-dim mt-0.5">{song.artist}</div>
      </div>
      <div className="shrink-0 text-[13px] text-ink-faint tabular-nums">
        {song.duration > 0 ? fmtTime(song.duration) : ""}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          openMenu(e.clientX, e.clientY);
        }}
        title="More options"
        aria-label={`More options for ${song.title}`}
        className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  album: "Album",
  artist: "Artist",
  playlist: "Playlist",
  other: "More",
};

function BrowseSearchRow({ item }: { item: BrowseItem }) {
  const navigate = useUI((s) => s.navigate);
  const toast = useUI((s) => s.toast);
  const isArtist = item.type === "artist";
  const isPlaylist = item.type === "playlist";
  const isAlbum = item.type === "album";
  // Artists, albums and playlists drag into Your Library; the hook must be
  // called unconditionally, so build the payload up front for every kind.
  const drag = useDrag(
    isPlaylist
      ? { playlist: { id: item.browseId, title: item.title, thumb: item.thumb || undefined } }
      : isAlbum
        ? { album: { id: item.browseId, title: item.title, thumb: item.thumb || undefined } }
        : { artist: { id: item.browseId, name: item.title, thumb: item.thumb || undefined } }
  );
  const draggableItem = isPlaylist || isArtist || isAlbum;

  const onOpen = (): void => {
    if (isArtist || item.browseId.startsWith("UC")) {
      navigate({ name: "artist", param: item.browseId });
    } else if (item.type === "album") {
      navigate({ name: "album", param: item.browseId });
    } else if (item.type === "playlist") {
      navigate({ name: "ytplaylist", param: item.browseId });
    } else {
      // Profiles and podcasts open their page on the phone; the desktop only
      // browses music pages, so say so rather than dead-click.
      toast("This result isn't browsable on ByTune desktop", "info");
    }
  };

  return (
    <div
      {...tintHoverHandlers(item.thumb)}
      onClick={onOpen}
      {...(draggableItem ? drag.props : {})}
      title={isPlaylist ? "Drag into Your Library to import this playlist" : isArtist ? "Drag into Your Library to import this artist's top songs" : isAlbum ? "Drag into Your Library to import this album" : undefined}
      className={`flex items-center gap-3.5 h-[68px] px-3 rounded-lg cursor-pointer select-none hover:bg-ink-hi/[0.05] ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork
        src={item.thumb}
        className={isArtist ? "w-[52px] h-[52px] rounded-full shrink-0" : "w-[52px] h-[52px] rounded-lg shrink-0"}
        iconClassName="w-4 h-4"
        alt=""
      />
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-semibold tracking-[-0.2px] text-ink-hi truncate">{item.title}</div>
        <div className="text-[14px] truncate text-ink-dim mt-0.5">
          {item.subtitle || TYPE_LABEL[item.type]}
        </div>
      </div>
    </div>
  );
}

/** The All tab's promoted card — mobile TopResultCard. */
function TopResultCard({ song, onPlay }: { song: Track; onPlay: () => void }) {
  const openContextMenu = useUI((s) => s.openContextMenu);
  const navigate = useUI((s) => s.navigate);
  const drag = useDrag({ track: song });
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[21px] mb-4">Top result</h2>
      <div
        {...tintHoverHandlers(song.thumb)}
        {...drag.props}
        onClick={onPlay}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, trackMenuItems(song));
        }}
        className={`group flex items-center gap-4 p-4 rounded-xl bg-ink-hi/[0.04] hover:bg-ink-hi/[0.07] transition-colors cursor-pointer select-none ${
          drag.dragging ? "opacity-40" : ""
        }`}
      >
        <Artwork src={song.thumb} className="w-[72px] h-[72px] rounded-[10px] shrink-0" iconClassName="w-6 h-6" alt="" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-display text-[20px] font-bold tracking-[-0.02em] text-ink-hi line-clamp-2">
            {song.explicit && <ExplicitBadge />}
            {song.title}
          </div>
          <div className="text-[13.5px] text-ink-dim truncate mt-1">{song.artist}</div>
        </div>
        <button
          title="More options"
          aria-label="More options"
          onClick={(e) => {
            e.stopPropagation();
            openContextMenu(e.clientX, e.clientY, trackMenuItems(song));
          }}
          className="p-2 rounded-full text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
        >
          <MoreVertical className="w-5 h-5" />
        </button>
      </div>
      <div className="flex items-center gap-2.5 mt-3">
        <button
          onClick={onPlay}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-full border border-ink-hi/25 text-[13.5px] font-semibold text-ink-hi hover:border-ink-hi/50 hover:bg-ink-hi/[0.06] transition-all active:scale-[0.98]"
        >
          <Play className="w-4 h-4 fill-current" />
          Play
        </button>
        <button
          onClick={() => navigate({ name: "playlists" })}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-full border border-ink-hi/25 text-[13.5px] font-semibold text-ink-hi hover:border-ink-hi/50 hover:bg-ink-hi/[0.06] transition-all active:scale-[0.98]"
        >
          <ListPlus className="w-4 h-4" />
          Playlist
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* Page                                                             */
/* ---------------------------------------------------------------- */

function RecentSearches() {
  const recents = useRecents((s) => s.searches);
  const removeSearch = useRecents((s) => s.removeSearch);
  const clearSearches = useRecents((s) => s.clearSearches);
  const setQuery = useUI((s) => s.setSearchQuery);

  if (recents.length === 0) return null;

  return (
    <section className="animate-slide-up">
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-title text-[21px]">Recent searches</h2>
        <button onClick={clearSearches} className="text-xs text-ink-faint hover:text-ink transition-colors">
          Clear all
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {recents.map((q) => (
          <span key={q} className="group flex items-center gap-1 pl-3.5 pr-1.5 py-1.5 rounded-full glass text-[13px] text-ink">
            <button className="hover:text-ink-hi transition-colors" onClick={() => setQuery(q)} title={`Search "${q}"`}>
              {q}
            </button>
            <button
              onClick={() => removeSearch(q)}
              title="Remove"
              aria-label={`Remove "${q}" from recent searches`}
              className="p-1 rounded-full text-ink-ghost hover:text-ink-hi hover:bg-ink-hi/10 opacity-60 group-hover:opacity-100 transition-all"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
    </section>
  );
}

export function SearchView() {
  const query = useUI((s) => s.searchQuery);
  const filter = useUI((s) => s.searchFilter);
  const setFilter = useUI((s) => s.setSearchFilter);
  const pushSearch = useRecents((s) => s.pushSearch);
  const playQueue = usePlayer((s) => s.playQueue);

  // BitChord mobile keeps an LRU of full result sets per (filter, query); a
  // repeated search answers from it instantly, and a filter tab flip re-runs
  // rather than re-filtering (the tabs are different requests upstream).
  const cache = useRef(new Map<string, SearchPageResult>());
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const trimmed = useMemo(() => query.trim(), [query]);
  const sessionKey = `${filter}:${trimmed.toLowerCase()}`;

  useEffect(() => {
    if (!trimmed) {
      setRows([]);
      setContinuation(null);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = cache.current.get(sessionKey);
    if (cached) {
      setRows(cached.rows);
      setContinuation(cached.continuation);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setRows([]);
    setContinuation(null);
    window.bytune
      ?.searchPage(trimmed, filter)
      .then((page) => {
        if (cancelled) return;
        cache.current.set(sessionKey, page);
        // Keep the cache bounded, newest-first-ish (Map preserves insertion
        // order; the oldest key is evicted).
        if (cache.current.size > 60) {
          const oldest = cache.current.keys().next().value;
          if (oldest) cache.current.delete(oldest);
        }
        setRows(page.rows);
        setContinuation(page.continuation);
        setLoading(false);
        pushSearch(trimmed);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, filter, retryNonce]);

  // BitChord mobile's paging rule: fetch the next page when the list nears its
  // end (a sentinel 4 rows before the bottom), merging without duplicates.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !continuation || loading || loadingMore || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const token = continuation;
        setContinuation(null);
        setLoadingMore(true);
        window.bytune
          ?.searchMore(token, filter)
          .then((page) => {
            setRows((prev) => {
              const seen = new Set(
                prev.map((r) => (r.kind === "browse" ? `b:${r.item.browseId}` : `v:${r.song.id}`))
              );
              const merged = [...prev];
              for (const row of page.rows) {
                const key = row.kind === "browse" ? `b:${row.item.browseId}` : `v:${row.song.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(row);
              }
              return merged;
            });
            setContinuation(page.continuation);
            setLoadingMore(false);
          })
          .catch(() => setLoadingMore(false));
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rows, continuation, loading, loadingMore, error, filter]);

  if (!trimmed) {
    return (
      <div className="space-y-10">
        <RecentSearches />
        <div className="flex flex-col items-center text-center py-16">
          <SearchX className="w-10 h-10 text-ink-ghost mb-4" />
          <div className="text-[15px] font-semibold text-ink-hi">Search ByTune</div>
          <p className="text-[13px] text-ink-dim mt-1.5 max-w-sm leading-relaxed">
            Find songs, albums, artists and playlists from YouTube Music. Press Ctrl+F anywhere to jump into search.
          </p>
        </div>
      </div>
    );
  }

  // Every playable song on the page, in page order — what a row click queues
  // through (the mobile app's `tracks` list, top result's song included).
  const tracks: Track[] = rows
    .filter((r) => r.kind === "top" || r.kind === "track")
    .map((r) => (r as { song: Track }).song);
  const topSong = rows.find((r): r is Extract<SearchRow, { kind: "top" }> => r.kind === "top")?.song ?? null;
  const sections = searchSections(rows, filter);

  return (
    <div className="space-y-4">
      {/* pointer-events-none: rows scrolling under this strip keep their
          hover — only the pills themselves take the pointer. The frosted
          blur band behind them is NOT painted here: it lives at panel level
          (see .search-band in index.css and App.tsx) so it can reach the
          panel's true right edge past the scrollbar gutter. This row just
          sticks to the top and sits above that band (z-10). Pills are
          full-size but narrow-padded so all six fit the content column at
          the default window size; flex-wrap is the safety valve below
          that — filters wrap to a second line rather than ever getting
          cut. */}
      <div className="pointer-events-none sticky top-0 z-10 -mx-10 px-10 -mt-5 pt-4 pb-4 animate-slide-up">
        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 gap-y-1">
          <Pills size="sm" options={FILTERS} value={filter} onChange={setFilter} />
          {loading && (
            <span
              className="ml-1 w-4 h-4 shrink-0 rounded-full border-2 border-ink-hi/15 border-t-accent animate-spin"
              aria-label="Loading"
            />
          )}
        </div>
      </div>

      {error && (
        <ErrorState
          title="Search didn't go through"
          body="This is usually a connection hiccup. Give it another try."
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      )}

      {!error && loading && <ListSkeleton rows={9} />}

      {!error && !loading && rows.length === 0 && (
        <div className="flex flex-col items-center text-center py-16 animate-fade-in">
          <SearchX className="w-10 h-10 text-ink-ghost mb-4" />
          <div className="text-[15px] font-semibold text-ink-hi">No results for “{trimmed}”</div>
          <p className="text-[13px] text-ink-dim mt-1.5">Check the spelling, or try a different keyword.</p>
        </div>
      )}

      {!error && !loading && rows.length > 0 && (
        <div className="animate-fade-in">
          {filter === "all" && topSong && (
            <TopResultCard song={topSong} onPlay={() => playQueue([topSong], 0)} />
          )}

          {sections.map((section) => (
            <section key={section.title || "results"} className="mt-4">
              {section.title && <h2 className="section-title text-[17px] mb-1.5">{section.title}</h2>}
              <div>
                {section.rows.map((row, i) => (
                  <div key={rowKey(row, i)}>
                    {row.kind === "top" ? null : row.kind === "track" ? (
                      <SongSearchRow
                        song={row.song}
                        onPlay={() => playQueue(tracks, Math.max(0, tracks.findIndex((t) => t.id === row.song.id)))}
                      />
                    ) : (
                      <BrowseSearchRow item={row.item} />
                    )}
                    {i < section.rows.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[80px] mr-3" />}
                  </div>
                ))}
              </div>
            </section>
          ))}

          {loadingMore && (
            <div className="mt-2">
              <ListSkeleton rows={3} />
            </div>
          )}
          <div ref={sentinelRef} className="h-2" aria-hidden />
        </div>
      )}
    </div>
  );
}
