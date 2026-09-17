/**
 * A remote (YouTube) playlist page — BitChord mobile's DetailScreen for a
 * playlist browse: full-bleed cover hero with the curator/views credit line
 * and the "PLAYLIST • N TRACKS" metadata line, shuffle + play controls, then
 * the playlist's own numbered track rows.
 */
import { useEffect, useState } from "react";
import { ListMusic, MoreHorizontal, Play, Shuffle } from "lucide-react";
import { Artwork, ErrorState, ExplicitBadge, HeroSkeleton, ListSkeleton } from "../components/primitives";
import { trackMenuItems } from "../lib/trackActions";
import { useDrag } from "../lib/dnd";
import { fmtTime } from "../lib/format";
import { useArtworkPalette } from "../lib/palette";
import { upgradeArtwork } from "../lib/artwork";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { RemotePlaylistPage, Track } from "../types";

function PlaylistTrackRow({
  song,
  index,
  numbered,
  queue,
}: {
  song: Track;
  index: number;
  numbered: boolean;
  queue: Track[];
}) {
  const playQueue = usePlayer((s) => s.playQueue);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const drag = useDrag({ track: song });
  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, trackMenuItems(song));
  };
  return (
    <div
      {...drag.props}
      onClick={() => playQueue(queue, index)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      className={`group flex items-center gap-3.5 h-[64px] px-3 rounded-lg cursor-pointer select-none ${
        currentId === song.id ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      {numbered ? (
        <div className="w-7 shrink-0 grid place-items-center text-[13px] text-ink-faint tabular-nums">
          {currentId === song.id ? (
            <span className="text-accent">▸</span>
          ) : (
            <span className="group-hover:hidden">{index + 1}</span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              playQueue(queue, index);
            }}
            className="hidden group-hover:block text-ink-hi hover:text-ink-hi transition-colors"
            title={`Play ${song.title}`}
            aria-label={`Play ${song.title}`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
          </button>
        </div>
      ) : null}
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
        <MoreHorizontal className="w-4 h-4" />
      </button>
    </div>
  );
}

export function RemotePlaylistView({ playlistId }: { playlistId: string }) {
  const [page, setPage] = useState<RemotePlaylistPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const playQueue = usePlayer((s) => s.playQueue);
  const toast = useUI((s) => s.toast);

  useArtworkPalette(page?.thumb ?? null);

  useEffect(() => {
    let cancelled = false;
    setPage(null);
    setError(null);
    window.bytune
      ?.getPlaylistPage(playlistId)
      .then((res) => {
        if (!cancelled) setPage(res as RemotePlaylistPage);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [playlistId, nonce]);

  if (error) {
    return (
      <ErrorState
        title="Couldn't load this playlist"
        body="This is usually a connection hiccup. Give it another try."
        onRetry={() => setNonce((n) => n + 1)}
        className="pt-10"
      />
    );
  }
  if (!page) {
    return (
      <div className="px-8 pt-6">
        <HeroSkeleton />
        <ListSkeleton rows={7} />
      </div>
    );
  }

  const tracks = page.tracks;
  const play = (shuffle: boolean): void => {
    if (!tracks.length) return;
    if (shuffle) {
      usePlayer.setState({ shuffle: true });
      playQueue(tracks, Math.floor(Math.random() * tracks.length));
    } else {
      playQueue(tracks, 0);
    }
  };

  return (
    <div className="page-tint -mt-5">
      {/* Hero — the playlist cover full-bleed, credit + metadata lines over it. */}
      <div className="relative -mx-10 overflow-hidden">
        <div className="absolute inset-0">
          {page.thumb ? (
            <img src={upgradeArtwork(page.thumb)} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-ink-hi/[0.04] grid place-items-center">
              <ListMusic className="w-12 h-12 text-ink-hi/30" />
            </div>
          )}
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(to bottom,
                rgb(var(--page-bg) / 0.20) 0%,
                rgb(var(--page-bg) / 0.45) 50%,
                rgb(var(--page-bg) / 0.90) 80%,
                rgb(var(--page-bg)) 100%)`,
            }}
          />
        </div>

        <div className="relative flex flex-col items-center text-center px-8 pt-[244px] pb-5">
          <h1 className="font-display text-[34px] leading-[1.35] font-extrabold tracking-[-0.03em] text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] break-words max-w-3xl line-clamp-2">
            {page.title}
          </h1>
          {page.credit && (
            <div className="text-[15px] font-medium text-accent mt-2 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)] line-clamp-1">
              {page.credit}
            </div>
          )}
          {page.meta && (
            <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/70 mt-1.5 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">
              {page.meta}
            </div>
          )}

          <div className="flex items-center justify-center gap-2.5 mt-4">
            <button
              onClick={() => play(true)}
              disabled={!tracks.length}
              title="Shuffle"
              aria-label="Shuffle"
              className="w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40"
            >
              <Shuffle className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => play(false)}
              disabled={!tracks.length}
              className="inline-flex items-center gap-2 h-11 px-6 rounded-full bg-black/45 border border-white/10 text-[14.5px] font-semibold text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40"
            >
              <Play className="w-[18px] h-[18px] fill-current" />
              Play
            </button>
            <button
              onClick={(e) =>
                useUI.getState().openContextMenu(e.clientX, e.clientY, [
                  {
                    label: "Add all to queue",
                    action: () => {
                      usePlayer.getState().addToQueue(tracks);
                      toast("Playlist added to queue");
                    },
                  },
                ])
              }
              title="More options"
              aria-label="More options"
              className="w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98]"
            >
              <MoreHorizontal className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>

      <div className="px-8 pb-12 pt-2">
        {tracks.length ? (
          <div>
            {tracks.map((song, i) => (
              <div key={`${song.id}-${i}`}>
                <PlaylistTrackRow song={song} index={i} numbered queue={tracks} />
                {i < tracks.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[112px] mr-3" />}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[13px] text-ink-dim py-10 text-center">This playlist is empty.</div>
        )}
      </div>
    </div>
  );
}
