/**
 * Recommendation card treatments — the visual vocabulary of the personalized
 * Home feed, matching the reference layouts:
 *   - mixes: square artwork with a colored name band across the lower third
 *   - stations/radio: pastel tile, "RADIO" tag, centered circular photo seal
 *   - artist-anchored sections: the eyebrow header ("More like / The Weeknd")
 * Colors are picked by a stable hash of the card id — same card, same color,
 * every visit (no lottery between renders).
 */
import { Radio } from "lucide-react";
import { playSource } from "../lib/recs/playback";
import { pastelFor, type HomeSection } from "../lib/recs/sections";
import { tintHoverHandlers } from "../stores/ui";
import { Artwork, PlayOverlay } from "./primitives";

const CARD = "group w-[168px] shrink-0 text-left cursor-pointer active:scale-[0.98]";
const CARD_TITLE = "text-[15px] font-semibold text-ink-hi truncate leading-snug";
const CARD_SUB = "text-[13px] text-ink-dim truncate mt-0.5";

type MixItem = Extract<HomeSection["items"][number], { style: "mix" }>;
type RadioItem = Extract<HomeSection["items"][number], { style: "radio" }>;

export function MixCard({ item }: { item: MixItem }) {
  const [c1, c2] = pastelFor(item.id);
  return (
    <button
      onClick={() => void playSource(item.source)}
      {...tintHoverHandlers(item.thumb ?? null)}
      className={CARD}
      aria-label={`Play ${item.name}`}
    >
      <div className="relative overflow-hidden rounded-xl">
        <Artwork
          src={item.thumb ?? undefined}
          className="w-full aspect-square rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.04]"
          iconClassName="w-7 h-7"
        />
        {/* The mix-name band — full width, low on the art, dark text on pastel. */}
        <div
          className="absolute left-0 right-0 bottom-[13%] flex h-[21%] items-center px-2.5"
          style={{ background: `linear-gradient(90deg, ${c1}, ${c2})` }}
        >
          <span className="truncate text-[14px] font-extrabold tracking-[-0.01em] text-black/[0.82]">{item.name}</span>
        </div>
        <PlayOverlay onClick={() => void playSource(item.source)} title={`Play ${item.name}`} />
      </div>
      <div className="mt-2.5">
        <div className={CARD_TITLE}>{item.name}</div>
        <div className={CARD_SUB}>{item.caption}</div>
      </div>
    </button>
  );
}

export function RadioCard({ item }: { item: RadioItem }) {
  const [c1, c2] = pastelFor(item.id);
  return (
    <button
      onClick={() => void playSource(item.source)}
      {...tintHoverHandlers(item.thumb ?? null)}
      className={CARD}
      aria-label={`Play the ${item.name} radio`}
    >
      <div
        className="relative aspect-square overflow-hidden rounded-xl"
        style={{ background: `linear-gradient(155deg, ${c1} 20%, ${c2})` }}
      >
        <Radio className="absolute left-3 top-3 w-4 h-4 text-black/65" aria-hidden />
        <span className="absolute right-3 top-3 text-[10.5px] font-extrabold tracking-[0.2em] text-black/70">RADIO</span>
        <Artwork
          src={item.thumb ?? undefined}
          className="absolute left-1/2 top-[45%] w-[56%] aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full shadow-float transition-transform duration-300 ease-out group-hover:scale-[1.04]"
          rounded="rounded-full"
          iconClassName="w-8 h-8"
        />
        <div className="absolute bottom-0 left-0 right-0 px-3 pb-2.5">
          <span className="block truncate text-[15.5px] font-extrabold tracking-[-0.01em] text-black/[0.82]">{item.name}</span>
        </div>
        <PlayOverlay onClick={() => void playSource(item.source)} title={`Play the ${item.name} radio`} />
      </div>
      <div className="mt-2.5">
        <div className={CARD_SUB}>{item.caption}</div>
      </div>
    </button>
  );
}

/** "More like / The Weeknd" — avatar beside the eyebrow + big artist name. */
export function EyebrowHeader({
  eyebrow,
  onOpen,
}: {
  eyebrow: NonNullable<HomeSection["eyebrow"]>;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div className="flex min-w-0 items-center gap-3.5">
        <button onClick={onOpen} title={`Open ${eyebrow.name}`} className="shrink-0 cursor-pointer">
          <Artwork src={eyebrow.thumb ?? undefined} className="w-14 h-14" rounded="rounded-full" iconClassName="w-5 h-5" alt="" />
        </button>
        <div className="min-w-0">
          <div className="text-[13px] text-ink-faint leading-tight">{eyebrow.label}</div>
          <button
            onClick={onOpen}
            className="block max-w-full cursor-pointer truncate font-display text-[24px] font-extrabold tracking-[-0.02em] text-ink-hi leading-tight hover:text-ink-hi/85 transition-colors"
          >
            {eyebrow.name}
          </button>
        </div>
      </div>
      <button
        onClick={onOpen}
        className="shrink-0 text-[13px] font-bold text-ink-faint hover:text-ink-hi transition-colors cursor-pointer"
      >
        Show all
      </button>
    </div>
  );
}
