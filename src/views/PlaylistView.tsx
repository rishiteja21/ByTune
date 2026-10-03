/**
 * A local playlist page — BitChord mobile's DetailScreen, same construction
 * as the album and remote-playlist pages: full-bleed cover hero with the
 * "PLAYLIST • N TRACKS • ABOUT 3:2X" metadata line, circular glass controls,
 * then the playlist's own numbered track rows.
 */
import { Heart, ListMusic, ListPlus, MoreHorizontal, Play, Shuffle } from "lucide-react";
import { DownloadBadge } from "../components/TrackList";
import { Artwork, EmptyState, EqBars, ExplicitBadge } from "../components/primitives";
import { playlistHeaderItems, playlistMenuItems } from "../lib/trackActions";
import { useDrag } from "../lib/dnd";
import { fmtTime, plural } from "../lib/format";
import { useArtworkPalette } from "../lib/palette";
import { upgradeArtwork } from "../lib/artwork";
import { useLibrary, type Playlist } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

export function PlaylistView({ playlistId }: { playlistId: string }) {
  const playlist = useLibrary((s) => s.playlists.find((p) => p.id === playlistId) ?? null);
  const playQueue = usePlayer((s) => s.playQueue);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const toast = useUI((s) => s.toast);

  // Artist-imported playlists wear the artist's photo, not a song cover —
  // the page tint and the hero read from that same artwork.
  const coverThumb = playlist?.artistThumb ?? playlist?.tracks[0]?.thumb ?? null;
  useArtworkPalette(coverThumb);

  // Dropping songs onto this page is handled panel-wide in App (usePanelDrop).

  if (!playlist) {
    return (
      <EmptyState
        icon={ListMusic}
        title="This playlist no longer exists"
        body="It may have been deleted. Head back to your playlists to find the rest."
        className="pt-10"
      />
    );
  }

  const tracks = playlist.tracks;
  const totalSec = tracks.reduce((acc, t) => acc + t.duration, 0);
  // Spotify's model: a fresh playlist reads "PLAYLIST" — the "0 tracks"
  // count only appears once there's something to count.
  const meta = [
    "Playlist",
    tracks.length ? plural(tracks.length, "track", "tracks") : "",
    totalSec > 0 ? `about ${fmtTime(totalSec)}` : "",
  ]
    .filter(Boolean)
    .join(" • ")
    .toUpperCase();

  const play = (shuffle: boolean): void => {
    if (!tracks.length) return;
    if (shuffle) {
      usePlayer.setState({ shuffle: true });
      playQueue(tracks, Math.floor(Math.random() * tracks.length));
    } else {
      playQueue(tracks, 0);
    }
  };

  const openHeaderMenu = (x: number, y: number): void => {
    const [renameItem, deleteItem] = playlistHeaderItems(playlist);
    openContextMenu(x, y, [
      {
        label: "Add all to queue",
        icon: ListPlus,
        action: () => {
          usePlayer.getState().addToQueue(tracks);
          toast("Playlist added to queue");
        },
      },
      { ...renameItem, separatorBefore: true },
      deleteItem,
    ]);
  };

  return (
    <div className="page-tint -mt-5">
      {/* Hero — the playlist cover full-bleed, name + metadata over its lower edge. */}
      <div className="relative -mx-10 overflow-hidden">
        <div className="absolute inset-0">
          {coverThumb ? (
            <img src={upgradeArtwork(coverThumb, 1200)} alt="" className="w-full h-full object-cover" />
          ) : (
            /* Default cover — ByTune violet gradient with a big soft note
               watermark, Spotify's default-playlist-cover model. The bottom
               fade below still melts it into the page background. */
            <div
              className="relative w-full h-full overflow-hidden"
              style={{
                background:
                  "linear-gradient(140deg, rgb(109 40 217 / 0.85) 0%, rgb(59 7 100 / 0.9) 42%, rgb(30 27 75 / 0.92) 70%, rgb(var(--page-bg)) 100%)",
              }}
            >
              {/* sheen — keeps the violet from reading flat */}
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "radial-gradient(ellipse 55% 45% at 18% 12%, rgb(255 255 255 / 0.14), transparent 70%)",
                }}
              />
              <ListMusic
                className="absolute -right-8 -bottom-10 w-[280px] h-[280px] text-white/[0.08] rotate-[-10deg]"
                aria-hidden
              />
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
          {/* leading-[1.35]: Segoe UI's ascent+descent needs ~1.33em — any
              tighter and line-clamp's overflow:hidden slices the descenders. */}
          <h1 className="font-display text-[34px] leading-[1.35] font-extrabold tracking-[-0.03em] text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] break-words max-w-3xl line-clamp-2">
            {playlist.name}
          </h1>
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/70 mt-1.5 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">
            {meta}
          </div>

          <div className="flex items-center justify-center gap-2.5 mt-4">
            {/* No `disabled` dimming when empty — play() no-ops on an empty
                list, and grayed-out buttons made fresh playlists look broken. */}
            <button
              onClick={() => play(true)}
              title="Shuffle"
              aria-label="Shuffle"
              className="w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98]"
            >
              <Shuffle className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => play(false)}
              className="inline-flex items-center gap-2 h-11 px-6 rounded-full bg-black/45 border border-white/10 text-[14.5px] font-semibold text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98]"
            >
              <Play className="w-[18px] h-[18px] fill-current" />
              Play
            </button>
            <button
              onClick={(e) => openHeaderMenu(e.clientX, e.clientY)}
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
            {tracks.map((track, i) => (
              <div key={`${track.id}-${i}`}>
                <PlaylistTrackRow track={track} index={i} queue={tracks} playlist={playlist} />
                {i < tracks.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[112px] mr-3" />}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={ListMusic}
            title="Let's find something for your playlist"
            body="Search for songs you love, or browse Explore to discover something new — then right-click any track to add it here."
            action={
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => {
                    useUI.getState().navigate({ name: "home" });
                    // The search field lives in the top bar; focus it once
                    // home has painted so typing starts immediately.
                    window.setTimeout(() => document.getElementById("global-search")?.focus(), 80);
                  }}
                  className="h-10 px-5 rounded-full bg-primary text-on-primary text-[13.5px] font-semibold hover:brightness-110 hover:shadow-[0_10px_36px_-10px_rgb(var(--primary)/0.55)] transition-all active:scale-[0.98]"
                >
                  Search for songs
                </button>
                <button
                  onClick={() => useUI.getState().navigate({ name: "explore" })}
                  className="h-10 px-5 rounded-full bg-panel border border-ink-hi/[0.09] text-[13.5px] font-semibold text-ink-hi hover:bg-ink-hi/[0.05] hover:border-ink-hi/[0.2] transition-all active:scale-[0.98]"
                >
                  Browse Explore
                </button>
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}

function PlaylistTrackRow({
  track,
  index,
  queue,
  playlist,
}: {
  track: Track;
  index: number;
  queue: Track[];
  playlist: Playlist;
}) {
  const playQueue = usePlayer((s) => s.playQueue);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const playing = usePlayer((s) => s.playing);
  const liked = useLibrary((s) => s.liked.some((t) => t.id === track.id));
  const toggleLike = useLibrary((s) => s.toggleLike);
  const drag = useDrag({ track });
  const isCurrent = currentId === track.id;

  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, playlistMenuItems(playlist, track));
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
        isCurrent ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      {/* The playlist's own running order — numbered rows, play on hover. */}
      <div className="w-7 shrink-0 grid place-items-center text-[13px] text-ink-faint tabular-nums">
        {isCurrent && playing ? (
          <EqBars />
        ) : (
          <>
            <span className={`group-hover:hidden ${isCurrent ? "text-ink-hi font-medium" : ""}`}>{index + 1}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isCurrent) usePlayer.getState().toggle();
                else playQueue(queue, index);
              }}
              className="hidden group-hover:block text-ink-hi hover:text-ink-hi transition-colors"
              title="Play"
              aria-label={`Play ${track.title}`}
            >
              <Play className="w-3.5 h-3.5 fill-current" />
            </button>
          </>
        )}
      </div>
      <Artwork src={track.thumb} className="w-[52px] h-[52px] rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.2px] text-ink-hi">
          {track.explicit && <ExplicitBadge />}
          <span className="truncate">{track.title}</span>
        </div>
        <div className="text-[14px] truncate text-ink-dim mt-0.5">{track.artist}</div>
      </div>
      <div className="w-[88px] shrink-0 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleLike(track);
          }}
          title={liked ? "Remove from Liked" : "Add to Liked"}
          aria-label={liked ? "Remove from Liked" : "Add to Liked"}
          className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
        >
          <Heart key={liked ? "liked" : "unliked"} className={`w-4 h-4 animate-icon-pop ${liked ? "fill-ink-hi text-ink-hi" : ""}`} />
        </button>
        <span className="opacity-80">
          <DownloadBadge id={track.id} />
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            openMenu(e.clientX, e.clientY);
          }}
          title="More options"
          aria-label={`More options for ${track.title}`}
          className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>
      <div className="w-11 shrink-0 text-right text-xs text-ink-faint tabular-nums">
        {track.duration > 0 ? fmtTime(track.duration) : "—"}
      </div>
    </div>
  );
}
