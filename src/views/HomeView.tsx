/**
 * Home — a personalized feed, not a fixed page.
 *
 * This view holds no recommendation logic of its own: sections come from
 * lib/recs (profile → candidates → section builder → feed hook), and each
 * section self-describes its title, subtitle, layout and items. The view's
 * whole job is to render whatever the engine chose — new section types and
 * reorderings appear without touching this file.
 *
 * Visual language follows the reference layouts: quick-resume tiles, square
 * album/track cards, circular artist cards, mix cards with name bands, and
 * pastel radio tiles with contextual "reason" subtitles.
 */
import { Play } from "lucide-react";
import { AlbumCard, ArtistCard, HomeShelfView, TrackCard } from "../components/Cards";
import { EyebrowHeader, MixCard, RadioCard } from "../components/recCards";
import { Artwork, Shelf, ShelfScroller, ShelfSkeleton } from "../components/primitives";
import { useHomeFeed } from "../lib/recs/feed";
import { useDrag } from "../lib/dnd";
import type { HomeSection } from "../lib/recs/sections";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI } from "../stores/ui";
import type { Track } from "../types";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late?";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Good night";
}

/** Quick-resume tiles — the compact 2×3 grid straight from history. Hovering
    a tile borrows its artwork colour for the panel wash (TintWash in App),
    and every tile is a drag source for the library. */
function QuickTile({ track }: { track: Track }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const drag = useDrag({ track });
  const open = (): void => playQueue([track], 0);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      {...tintHoverHandlers(track.thumb)}
      {...drag.props}
      className={`group flex items-center gap-3 h-16 pr-3 rounded-lg bg-ink-hi/[0.03] text-left hover:bg-ink-hi/[0.08] transition-all overflow-hidden cursor-pointer select-none ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork src={track.thumb} className="h-16 w-16 rounded-none shrink-0" iconClassName="w-5 h-5" alt="" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink truncate group-hover:text-ink-hi transition-colors">
          {track.title}
        </div>
        <div className="text-xs text-ink-faint truncate mt-0.5">{track.artist}</div>
      </div>
      <span className="w-9 h-9 rounded-full bg-primary text-on-primary grid place-items-center shadow-elev opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <Play className="w-4 h-4 fill-current ml-0.5" />
      </span>
    </div>
  );
}

/** Cold-start browse chips — the honest fallback while taste is unknown. */
function MoodChips({ moods }: { moods: string[] }) {
  const setQuery = useUI((s) => s.setSearchQuery);
  const navigate = useUI((s) => s.navigate);
  return (
    <div className="flex flex-wrap gap-2">
      {moods.map((mood) => (
        <button
          key={mood}
          onClick={() => {
            setQuery(mood);
            navigate({ name: "search" });
          }}
          className="px-4 py-2 rounded-full bg-ink-hi/[0.05] text-[13px] font-medium text-ink hover:bg-ink-hi/[0.09] hover:text-ink-hi transition-colors duration-150"
        >
          {mood}
        </button>
      ))}
    </div>
  );
}

/**
 * Renders one section however it asks to be rendered. Adding a new section
 * type = a new entry in the builder + (only if genuinely new) a new case here.
 */
function SectionView({ section }: { section: HomeSection }) {
  const navigate = useUI((s) => s.navigate);

  const eyebrow = section.eyebrow;
  const openArtist = eyebrow ? () => navigate({ name: "artist", param: eyebrow.artistId }) : undefined;

  if (section.layout === "yt-shelf" && section.shelf) {
    return <HomeShelfView shelf={section.shelf} />;
  }

  const body = (() => {
    if (section.layout === "tiles") {
      const tileTracks = section.items.flatMap((it) => (it.style === "track" ? [it.track] : []));
      return (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
          {tileTracks.map((t) => (
            <QuickTile key={t.id} track={t} />
          ))}
        </div>
      );
    }
    if (section.layout === "moods") {
      return <MoodChips moods={section.moods ?? []} />;
    }
    return (
      <ShelfScroller>
        {section.items.map((item, i) => {
          const key = `${section.id}-${item.style}-${i}`;
          switch (item.style) {
            case "track":
              return <TrackCard key={key} track={item.track} />;
            case "album":
              return <AlbumCard key={key} album={item.album} />;
            case "artist":
              return <ArtistCard key={key} artist={item.artist} />;
            case "mix":
              return <MixCard key={key} item={item} />;
            case "radio":
              return <RadioCard key={key} item={item} />;
            default:
              return null;
          }
        })}
      </ShelfScroller>
    );
  })();

  return (
    <section className="animate-slide-up">
      {eyebrow ? (
        <>
          <EyebrowHeader eyebrow={eyebrow} onOpen={openArtist as () => void} />
          {body}
        </>
      ) : (
        <Shelf title={section.title} subtitle={section.subtitle}>
          {body}
        </Shelf>
      )}
    </section>
  );
}

export function HomeView() {
  const { sections, profile } = useHomeFeed();
  // The wash at the top of the pane is global now (TintWash in App.tsx): at
  // rest it wears the playing track's colour, and hovering any card on any
  // view borrows that card's artwork colour.

  return (
    <div className="relative">
      <div className="relative space-y-10">
        <div className="animate-slide-up pt-2">
          <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi leading-tight">
            {greeting()}
          </h1>
          <p className="text-[14px] text-ink-dim mt-1">What do you feel like listening to?</p>
        </div>

        {sections.map((section) => (
          <SectionView key={section.id} section={section} />
        ))}

        {/* Stats still loading on a cold app launch — hold the layout. */}
        {!profile && (
          <div className="space-y-10">
            <ShelfSkeleton />
            <ShelfSkeleton />
          </div>
        )}
      </div>
    </div>
  );
}
