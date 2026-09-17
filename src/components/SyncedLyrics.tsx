/**
 * Time-synced lyrics — the premium pass.
 *
 * Only a handful of lines are readable at once: the active line is large,
 * bright and softly glowing, and every line away from it loses size, opacity
 * and focus progressively, so the panel reads as depth rather than a list.
 * Word-synced providers get the karaoke sweep; silence gaps render as
 * breathing dots. Click a line to seek there.
 *
 * The store's position updates on `timeupdate` (~4Hz) — too coarse for a
 * word sweep, so the active word-synced line advances off its own rAF loop
 * reading the live element clock.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getPlaybackPosition } from "../lib/audio";
import { LYRICS_LOADING_LINES, pickLyricsLine } from "../lib/lyricsPhrases";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import type { LyricsResult, SyncedLyricWord } from "../types";

interface LyricsViewProps {
  lyrics: LyricsResult | null;
  loading: boolean;
  large?: boolean;
  /** Fullscreen scale — the same treatments as `large`, sized for the
      fullscreen panel's height. Container, spacing and type only. */
  hero?: boolean;
  /** Where the live line's centre rests, as a fraction of the container's
      height (0.5 = dead centre). The fullscreen player measures the album
      cover's centre and passes that fraction, so the live line sits exactly
      beside it; everything else keeps the centred anchor. */
  anchor?: number;
  /** The playing track's id — pins the loading copy to one line per track. */
  trackKey?: string;
}

type LyricsVariant = "compact" | "large" | "hero";

/** Line type scale — `hero` is the fullscreen variant of `large`. */
function lineSizeClass(variant: LyricsVariant): string {
  switch (variant) {
    case "hero":
      return "font-display text-[clamp(28px,3.4vw,54px)] leading-[1.22] tracking-[-0.03em] font-extrabold";
    case "large":
      return "font-display text-[40px] leading-[1.25] tracking-[-0.03em] font-extrabold";
    default:
      return "font-display text-[24px] leading-[1.4] tracking-[-0.02em] font-extrabold";
  }
}

/**
 * Word sweep spans, sanitised into the line's own time window.
 *
 * Providers emit backing-vocal words that start *before* the line activates
 * (they'd light the moment the line does and stay lit for its whole duration)
 * and degenerate zero-length spans (they'd pop fully lit at their start).
 * Both are repaired here: spans that are sane get clamped into the line
 * window, anything else falls back to an even distribution across it.
 */
function resolveWordSpans(
  words: SyncedLyricWord[],
  t0: number,
  t1: number,
): Array<{ start: number; end: number }> {
  const n = words.length || 1;
  const sane =
    words.length > 0 &&
    words.every((w) => w.end > w.start && w.start >= t0 - 0.25 && w.end <= t1 + 0.5);
  if (sane) {
    return words.map((w) => ({
      start: Math.max(t0, w.start),
      end: Math.min(t1, Math.max(w.start + 0.04, w.end)),
    }));
  }
  return words.map((_, i) => ({
    start: t0 + ((t1 - t0) * i) / n,
    end: t0 + ((t1 - t0) * (i + 1)) / n,
  }));
}

/** Karaoke sweep across one line's words; re-renders at rAF rate. */
function WordLine({
  words,
  spans,
  variant,
  glow,
  offset,
}: {
  words: SyncedLyricWord[];
  spans: Array<{ start: number; end: number }>;
  variant: LyricsVariant;
  glow: boolean;
  offset: number;
}) {
  const playing = usePlayer((st) => st.playing);
  const [, force] = useState(0);
  useEffect(() => {
    // The sweep only moves while audio is playing; parked at pause, the line
    // holds its last state instead of burning frames re-rendering.
    if (!playing) return;
    let raf = 0;
    const tick = (): void => {
      force((n) => (n + 1) % 1000000);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playing]);
  const pos = getPlaybackPosition() - offset;
  return (
    <span className={lineSizeClass(variant)}
      style={glow ? { filter: "drop-shadow(0 0 22px rgba(255,255,255,0.28))" } : undefined}
    >
      {words.map((w, i) => {
        const span = spans[i] ?? { start: w.start, end: w.end };
        const p =
          span.end > span.start
            ? Math.min(1, Math.max(0, (pos - span.start) / (span.end - span.start)))
            : pos >= span.start
              ? 1
              : 0;
        const pct = Math.round(p * 100);
        return (
          <span
            key={i}
              style={{
                backgroundImage: `linear-gradient(90deg, rgb(var(--ink-hi)) ${pct}%, rgb(var(--ink-hi) / 0.28) ${pct}%)`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {i > 0 ? " " : ""}
            {w.text}
          </span>
        );
      })}
    </span>
  );
}

/** Distance-from-active → the depth treatment: opacity, blur, scale.
 * Blur follows the "Blur unfocused lyrics" switch (and yields to the global
 * reduced-blur setting); the opacity/scale falloff always stays so the
 * active line still reads first. */
function depthStyle(
  dist: number,
  past: boolean,
  blur: boolean,
): { className: string; style: React.CSSProperties } {
  const d = Math.min(Math.abs(dist), 4);
  // Sung lines sink away a touch harder than upcoming ones.
  const opacity = [1, 0.5, 0.3, 0.18, 0.1][d] * (past && d > 0 ? 0.7 : 1);
  const blurPx = blur ? [0, 1.2, 2.2, 3.2, 4][d] : 0;
  const scale = [1, 0.975, 0.955, 0.94, 0.93][d];
  return {
    className: "text-ink-hi transition-all duration-500 ease-out",
    style: {
      opacity,
      filter: d === 0 || blurPx === 0 ? undefined : `blur(${blurPx}px)`,
      transform: `scale(${scale})`,
      transformOrigin: "left center",
    },
  };
}

export function LyricsView({
  lyrics,
  loading,
  large = false,
  hero = false,
  anchor = 0.5,
  offset = 0,
  trackKey,
}: LyricsViewProps & { offset?: number }) {
  const variant: LyricsVariant = hero ? "hero" : large ? "large" : "compact";
  const position = usePlayer((s) => s.position);
  const seek = usePlayer((s) => s.seek);
  // Appearance switches with defined mobile behavior: synced lyrics gates
  // the whole synced treatment, blur de-emphasis is separately toggled,
  // and the glow yields to reduced motion / reduced blur.
  const syncedOn = useSettings((s) => s.syncedLyrics);
  const blurOn = useSettings((s) => s.blurUnfocusedLyrics);
  const reduceMotion = useSettings((s) => s.reduceAnimation);
  const reduceBlur = useSettings((s) => s.reduceDynamicBlur);
  const blurLines = blurOn && !reduceBlur;
  const glowLines = blurOn && !reduceMotion && !reduceBlur;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // BitChord mobile's LyricsLoadingLine: the lookup's stand-in is one of the
  // loading phrases — no spinner — picked once per track and held there.
  const loadingPhrase = useMemo(() => pickLyricsLine(LYRICS_LOADING_LINES), [trackKey]);

  const synced = lyrics?.synced ?? null;

  // Providers attach backing-vocal / credit lines wrapped in parentheses at
  // the head of the song — they render as phantom lyrics before the first
  // real line, so they're dropped here (gap lines stay).
  const lines = useMemo(
    () => synced?.filter((l) => l.gap || (!!l.text && !/^[[(]/.test(l.text.trim()) && l.time > 0)) ?? null,
    [synced],
  );

  // Static text for the plain (unsynced) treatment: the provider's plain
  // lyrics when they exist, otherwise the synced lines' own words joined in
  // order — so switching synced lyrics OFF never blanks the panel on tracks
  // that only shipped synced lines. Gap/instrumental markers carry no words.
  const staticText = useMemo(() => {
    if (lyrics?.plain && lyrics.plain.trim()) return lyrics.plain;
    const fromSynced = (lines ?? [])
      .map((l) => l.text.trim())
      .filter((t) => t.length > 0)
      .join("\n")
      .trim();
    return fromSynced || null;
  }, [lyrics, lines]);

  // Lyric times live on the matched recording's timeline; the playing upload
  // may prepend an intro (music videos). offset converts element position →
  // lyric timeline.
  const lyricPos = position - offset;

  const activeIndex = useMemo(() => {
    if (!lines) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= lyricPos + 0.35) idx = i;
      else break;
    }
    return idx;
  }, [lines, lyricPos]);

  // Keep the active line on its anchor. Runs on lyrics load too — at mount
  // the layout isn't measured yet, so the first attempt needs a frame first.
  // `anchor` is the fraction of the container height where the live line's
  // centre comes to rest: 0.5 = centred (default), the fullscreen player
  // passes the album cover's measured centre so the line sits beside it.
  useEffect(() => {
    if (activeIndex < 0) return;
    const raf = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const el = activeRef.current;
      if (!container || !el) return;
      const target =
        el.offsetTop + el.clientHeight / 2 - container.clientHeight * anchor;
      container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeIndex, synced, anchor]);

  if (loading) {
    // Words, not a spinner — mobile's LyricsLoadingLine, dimmed like an
    // unsung line.
    return (
      <div className="flex justify-center py-12">
        <span
          className={`font-display font-extrabold text-ink-hi/55 animate-pulse ${
            hero
              ? "text-[30px] tracking-[-0.02em]"
              : large
                ? "text-[28px] tracking-[-0.02em]"
                : "text-[18px]"
          }`}
        >
          {loadingPhrase}
        </span>
      </div>
    );
  }

  if (!lyrics || !staticText) {
    return (
      <p
        className={`text-center text-ink-faint ${
          hero ? "py-16 text-lg" : large ? "py-16 text-base" : "py-10 text-sm"
        }`}
      >
        No lyrics available for this track.
      </p>
    );
  }

  if (synced && syncedOn) {
    // Anchor spacers: the scroll target puts the active line's centre at
    // `anchor` × container height. Without head room the first lines can't
    // reach the anchor — scrollTop clamps at 0, so line 0 sticks to the very
    // top where the vertical melt mask (transparent → black over the top
    // 14%) dims it. That is why the opening line always looked grey next to
    // the later, centred (fully bright) lines. Matching top/bottom spacers
    // let every line — first through last — rest exactly on the anchor, in
    // the mask's solid middle band.
    // % heights resolve against the scroller's own (definite, absolute-
    // positioned) height; the −fudge is ~half a line so the line *centre*
    // lands on the anchor. `max(...,12px)` keeps a sane gap if the anchor
    // ever measures near an edge.
    const headFudge = hero ? 36 : large ? 28 : 20;
    // The non-fullscreen panel parks the lyric list at the top of the area:
    // a small fixed head spacer (just under the top melt mask's full-opacity
    // line) instead of the anchor pre-centre, and it never changes size — the
    // intro view and the first active line sit at exactly the same height, so
    // singing starting cannot reposition the list. Later lines still glide to
    // the anchor through the normal auto-scroll once their offset outgrows
    // the scroll clamp. The fullscreen panel keeps its measured-anchor
    // spacer, which must never move.
    const topSpacer = hero ? `max(12px, calc(${anchor * 100}% - ${headFudge}px))` : "calc(10% + 4px)";
    const bottomSpacer = `max(12px, calc(${(1 - anchor) * 100}% - ${headFudge}px))`;
    return (
      <div
        className="relative flex-1 min-h-0 -mx-6"
        style={{
          // Horizontal twin of the vertical melt below: the active line's glow
          // halo fades out toward the panel edges instead of stopping on a hard
          // vertical line at the clip boundary. The -mx-6 above gives the halo
          // 24px of room to fade in (px-6 on the scroller keeps text in place).
          maskImage:
            "linear-gradient(to right, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%)",
        }}
      >
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-y-auto scroll-host px-6 py-0"
          style={{
            // Lines melt into the dark at the panel edges instead of stopping hard.
            maskImage: "linear-gradient(to bottom, transparent 0%, black 14%, black 86%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 14%, black 86%, transparent 100%)",
          }}
        >
        <div aria-hidden="true" style={{ height: topSpacer, flexShrink: 0 }} />
        <div className={hero ? "space-y-7" : large ? "space-y-5" : "space-y-4"}>
          {(lines ?? []).map((line, i) => {
            const active = i === activeIndex;
            const dist = i - activeIndex;
            const depth = depthStyle(dist, i < activeIndex, blurLines);

            if (line.gap) {
              return (
                <div
                  key={`${line.time}-${i}`}
                  className="flex items-center gap-2 py-2 px-1"
                  title="Instrumental"
                  style={{ opacity: Math.max(0.15, depth.style.opacity as number) }}
                >
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      className={`w-1.5 h-1.5 rounded-full bg-ink-hi/80 ${active ? "animate-pulse" : ""}`}
                      style={{
                        animationDelay: `${d * 0.22}s`,
                        boxShadow: active ? "0 0 12px rgba(255,255,255,0.5)" : undefined,
                      }}
                    />
                  ))}
                </div>
              );
            }

            const wordSynced = active && (line.words?.length ?? 0) > 0;

            // The sweep window is the line's own slice of the song: from its
            // start to the next line (or the last word's end, whichever is
            // sooner). Word spans are sanitised against it before rendering.
            let spans: Array<{ start: number; end: number }> = [];
            if (wordSynced && line.words) {
              const ws = line.words;
              const nextTime = lines?.[i + 1]?.time;
              let t1 = nextTime ?? line.time + 4;
              const lastEnd = ws[ws.length - 1].end;
              if (lastEnd > line.time) t1 = Math.min(t1, Math.max(lastEnd, line.time + 1));
              if (t1 <= line.time) t1 = line.time + 3;
              spans = resolveWordSpans(ws, line.time, t1);
            }

            return (
              <button
                key={`${line.time}-${i}`}
                ref={i === activeIndex ? activeRef : undefined}
                onClick={() => seek(Math.max(0, line.time + offset - 0.15))}
                title="Jump here"
                className={`block w-full text-left origin-left ${depth.className}`}
                style={depth.style}
              >
                {wordSynced ? (
                  <WordLine words={line.words!} spans={spans} variant={variant} glow={glowLines} offset={offset} />
                ) : (
                  <span
                    className={lineSizeClass(variant)}
                    style={active && glowLines ? { filter: "drop-shadow(0 0 22px rgba(255,255,255,0.28))" } : undefined}
                  >
                    {line.text}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div aria-hidden="true" style={{ height: bottomSpacer, flexShrink: 0 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <pre
        className={`relative flex-1 min-h-0 overflow-y-auto whitespace-pre-wrap font-sans text-ink-dim ${
          hero ? "h-full text-[17px] leading-8 py-2" : large ? "h-full text-[15px] leading-7 py-2" : "text-[13px] leading-6 py-2"
        }`}
      >
        {staticText}
      </pre>
    </div>
  );
}
