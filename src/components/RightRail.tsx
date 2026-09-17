/**
 * Right rail — the always-on song-details panel, Spotify-style.
 *
 * Default mode ("details"): a sharp artwork tile over the track title and an
 * About-the-artist card in Spotify's shape — photo header, verified name,
 * monthly listeners beside a View profile pill, and the editorial blurb — clicking
 * it opens that artist's page. The queue button in the player bar swaps the
 * body to the queue sheet ("Queue" / "Recently played" text tabs with the
 * underline treatment, X returns to details). Lyrics live in the centre pane
 * (see LyricsCenter.tsx), not here.
 */
import { useEffect, useState } from "react";
import { BadgeCheck, Music2, X } from "lucide-react";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { Artwork, EqBars, IconBtn } from "./primitives";
import { upgradeArtwork, wideArtwork } from "../lib/artwork";
import { useDrag } from "../lib/dnd";
import { fmtTime } from "../lib/format";
import { useArtistImage } from "../lib/artistImage";
import { monthlyListenersLabel, useArtistAbout } from "../lib/artistAbout";
import { useLibrary } from "../stores/library";
import type { Track } from "../types";

/** The queue's "Now playing" row — draggable like every other song row. */
function QueueCurrentRow({ track, playing }: { track: Track; playing: boolean }) {
  const drag = useDrag({ track });
  return (
    <div
      {...drag.props}
      className={`flex items-center gap-3 h-14 px-2 rounded-lg bg-ink-hi/[0.14] ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork src={track.thumb} className="w-11 h-11 rounded-md shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold truncate text-ink-hi flex items-center gap-2">
          <span className="truncate">{track.title}</span>
          {playing && <EqBars />}
        </div>
        <div className="text-[12px] truncate text-ink-hi/55 mt-0.5">{track.artist}</div>
      </div>
    </div>
  );
}

function TrackRow({
  track,
  isCurrent,
  isPlaying,
  onPlay,
  onRemove,
}: {
  track: Track;
  isCurrent?: boolean;
  isPlaying?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
}) {
  const drag = useDrag({ track });
  return (
    <div
      {...drag.props}
      onClick={onPlay}
      className={`group flex items-center gap-3 h-12 px-2 rounded-lg cursor-pointer select-none transition-colors ${
        isCurrent ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      <Artwork src={track.thumb} className="w-9 h-9 rounded-md shrink-0" iconClassName="w-3.5 h-3.5" alt="" />
      <div className="flex-1 min-w-0">
        <div className={`text-[13px] truncate font-semibold ${isCurrent ? "text-ink-hi" : "text-ink-hi"}`}>
          {track.title}
        </div>
        <div className="text-[11.5px] truncate text-ink-hi/55 mt-0.5">{track.artist}</div>
      </div>
      {isCurrent && isPlaying && <EqBars />}
      {track.duration > 0 && (
        <div className="w-9 text-right text-[11px] text-ink-hi/45 tabular-nums shrink-0">{fmtTime(track.duration)}</div>
      )}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove from queue"
          aria-label="Remove from queue"
          className="p-1 rounded-md text-ink-hi/45 hover:text-red-400 hover:bg-ink-hi/[0.06] opacity-0 group-hover:opacity-100 transition-all shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ queue sheet */

/** Exported for the fullscreen player's Queue view — the same sheet, data
    and behavior as the right-rail queue; only the mount point differs. */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"queue" | "recent">("queue");
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const playing = usePlayer((s) => s.playing);
  const playAt = usePlayer((s) => s.playQueue);
  const removeAt = usePlayer((s) => s.removeAt);
  const history = useLibrary((s) => s.history);
  const playTrack = usePlayer((s) => s.playTrack);

  const current = queue[index] ?? null;
  const upcoming = queue.slice(index + 1);
  // Row keys must not depend on the current queue index: embedding `index`
  // shifted every key on each track advance, remounting the whole upcoming
  // list (new drag state, new <img> decode) per track. Key by id plus its
  // occurrence number within the queue — stable across playback.
  const occurrence = new Map<string, number>();
  const stableKey = (id: string): string => {
    const n = occurrence.get(id) ?? 0;
    occurrence.set(id, n + 1);
    return `${id}#${n}`;
  };

  const TabBtn = ({
    id,
    label,
  }: {
    id: "queue" | "recent";
    label: string;
  }) => (
    <button
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={`relative h-full px-1 text-[14px] font-bold tracking-[-0.2px] transition-colors ${
        tab === id ? "text-ink-hi" : "text-ink-hi/55 hover:text-ink-hi/85"
      }`}
    >
      {label}
      {/* Spotify's underline treatment — ours is white on the black canvas. */}
      <span
        className={`absolute left-0 right-0 bottom-0 h-[3px] rounded-full transition-opacity ${
          tab === id ? "bg-ink-hi opacity-100" : "opacity-0"
        }`}
      />
    </button>
  );

  return (
    <>
      {/* Header — Queue / Recently played tabs + close back to details. */}
      <div className="h-14 shrink-0 flex items-center gap-5 px-5 border-b border-ink-hi/[0.08]">
        <TabBtn id="queue" label="Queue" />
        <TabBtn id="recent" label="Recently played" />
        <div className="ml-auto">
          <IconBtn
            icon={X}
            title="Close queue"
            onClick={onClose}
            className="rounded-full text-ink-hi/55 hover:text-ink-hi"
          />
        </div>
      </div>

      {tab === "queue" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <span className="micro-label text-ink-hi/55">Now playing</span>
            {upcoming.length > 0 && (
              <button
                onClick={() => usePlayer.getState().clearUpcoming()}
                className="text-[13px] font-semibold text-ink-hi/75 hover:text-ink-hi transition-colors"
                title="Clear upcoming"
              >
                Clear
              </button>
            )}
          </div>
          <div className="px-2 pb-2">
            {current ? (
              <QueueCurrentRow track={current} playing={playing} />
            ) : (
              <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">
                Nothing playing — start a track to see your queue here.
              </div>
            )}
          </div>

          <div className="px-4 pt-2 pb-1">
            <h2 className="text-[20px] font-extrabold tracking-[-0.4px] text-ink-hi">Next up</h2>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3 space-y-0.5">
            {upcoming.length === 0 ? (
              <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">Your queue is empty.</div>
            ) : (
              upcoming.map((t, i) => (
                <TrackRow
                  key={stableKey(t.id)}
                  track={t}
                  onPlay={() => playAt(queue, index + 1 + i)}
                  onRemove={() => {
                    // Removing a row shifts the list up under a stationary
                    // pointer — the row now under it never fires mouseenter,
                    // so clear the hover wash here (navigate() does the same
                    // for view changes).
                    useUI.getState().setTintThumb(null);
                    removeAt(index + 1 + i);
                  }}
                />
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-0.5">
          {history.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">
              Nothing here yet — tracks you play land in Recently played.
            </div>
          ) : (
            history.slice(0, 50).map((t, i) => (
              <TrackRow key={`${t.id}-${i}`} track={t} onPlay={() => playTrack(t)} />
            ))
          )}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- song details */

function DetailsBody() {
  const track = usePlayer((s) => s.queue[s.index] ?? null);
  const { artistImage } = useArtistImage(track);
  const detailsDrag = useDrag({ track: track ?? { id: "", title: "", artist: "", duration: 0, thumb: "" } });

  if (!track) {
    return (
      <div className="flex-1 grid place-items-center px-6">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-ink-hi/[0.05] grid place-items-center mx-auto mb-4">
            <Music2 className="w-5 h-5 text-ink-hi/35" />
          </div>
          <p className="text-[14px] font-semibold text-ink-hi">Nothing playing</p>
          <p className="text-[12.5px] text-ink-hi/55 mt-1">Song details will show up here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
      {/* Full-width square artwork, Spotify-panel style — everything scrolls.
          The cover + title block is a drag source: drop it on a sidebar
          playlist. The whole header (art, title, artist) shares one drag
          origin so every pixel behaves the same. */}
      <div {...detailsDrag.props} className={detailsDrag.dragging ? "opacity-40" : ""}>
        <Artwork
          key={track.id}
          src={track.thumb}
          className="w-full aspect-square rounded-xl shadow-elev animate-art-in"
          iconClassName="w-10 h-10"
          alt=""
        />

        {/* Title + artist directly under the art. */}
        <div className="px-0.5 mt-2.5 animate-meta-in" key={`rrmeta-${track.id}`}>
          <div className="text-[24px] font-extrabold tracking-[-0.5px] text-ink-hi leading-tight" title={track.title}>
            {track.title}
          </div>
          <div className="text-[14px] text-ink-hi/70 mt-1">{track.artist}</div>
        </div>
      </div>

      <AboutArtistCard track={track} fallbackImage={artistImage ?? track.thumb ?? null} />
    </div>
  );
}

/**
 * About the artist, Spotify-panel style: photo header with the section label
 * over its top edge, the artist's name with their verified seal, monthly
 * listeners beside a View profile pill, and the editorial blurb — the same
 * "About the artist" writing the artist page shows. The whole card opens
 * that artist page.
 */
function AboutArtistCard({
  track,
  fallbackImage,
}: {
  track: Track;
  fallbackImage: string | null;
}) {
  const about = useArtistAbout(track);
  const navigate = useUI((s) => s.navigate);
  const listeners = monthlyListenersLabel(about);
  const photo = about?.thumb ?? fallbackImage;

  if (!about) return null;

  return (
    <button
      onClick={() => navigate({ name: "artist", param: about.artistId })}
      title={`Open ${about.name}`}
      aria-label={`About the artist — open ${about.name}`}
      className="group rounded-xl bg-ink-hi/[0.04] overflow-hidden text-left cursor-pointer hover:bg-ink-hi/[0.06] transition-colors animate-fade-in"
    >
      {/* Photo header with the label over its top edge, Spotify-style — a tall
          3:2 frame showing the whole artist shot, not a cropped strip. */}
      <div className="relative aspect-[3/2] bg-ink-hi/[0.06]">
        {photo ? (
          <img src={wideArtwork(photo)} alt="" className="w-full h-full object-cover object-top art-hairline" />
        ) : (
          <div className="w-full h-full art-hairline" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/10 to-transparent" />
        <div className="absolute top-2.5 left-3.5 text-[15px] font-bold text-ink-hi">About the artist</div>
      </div>

      <div className="p-3.5 pt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[15px] font-bold text-ink-hi truncate">{about.name}</span>
          <BadgeCheck className="w-[18px] h-[18px] shrink-0 text-[#4cb3ff]" fill="#4cb3ff" stroke="#0a0a0a" />
        </div>

        <div className="flex items-center justify-between gap-3 mt-2.5">
          <span className="text-[13px] text-ink-hi/70 truncate">
            {listeners ?? about.subscriberCount ?? "Artist"}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate({ name: "artist", param: about.artistId });
            }}
            className="shrink-0 h-8 px-4 rounded-full border border-ink-hi/30 text-[13px] font-bold text-ink-hi hover:border-ink-hi/60 hover:bg-ink-hi/[0.06] transition-all active:scale-[0.98]"
          >
            View profile
          </button>
        </div>

        {about.description && (
          <p
            className="mt-2.5 text-[13px] leading-relaxed text-ink-hi/70"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {about.description}
          </p>
        )}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ root */

export function RightRail() {
  const mode = useUI((s) => s.rightPanel);
  const closeQueue = () => useUI.setState({ rightPanel: "details" });

  return (
    <aside
      className="w-[328px] shrink-0 flex flex-col glass-pill rounded-2xl overflow-hidden"
      aria-label="Now playing panel"
    >
      {mode === "queue" ? <QueuePanel onClose={closeQueue} /> : <DetailsBody />}
    </aside>
  );
}
