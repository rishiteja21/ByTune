/**
 * Text that never ends in "…".
 *
 * One line (the default) runs to its edge and, when it doesn't fit, fades
 * there and slides to show the rest: on its own for what's playing (`auto`:
 * a pause, across, a pause, back) or while its row or card is hovered
 * (`hover`; that element carries `fit-host`). Two lines (`lines={2}`) wrap,
 * balanced, and fade the end of the second line instead of cutting it.
 * Text that fits sits still. Reduce animation stills every slide, and
 * whenever any of the text is hidden — or the title was shortened (`full`) —
 * the whole of it is the hover tooltip.
 */
import { useContext, useLayoutEffect, useRef } from "react";
import { visualActivity } from "../lib/visualActivity";
import { createVisualActivity } from "../lib/visualActivityCore";
import { VisualScopeContext } from "../lib/visualScope";

/** Reading pace for a slide, in px per second. */
const SPEED = 40;
/** Width of the fade at the far edge (matches .fit-text's mask). */
const FADE = 24;

const stilled = (): boolean =>
  document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// Every FitText measures in two steps — read its sizes, then write — and they
// run together, so a list of hundreds measures in one layout pass, not one each.
type Measure = () => () => void;
const runAll = (list: Iterable<Measure | undefined>): void => {
  const writes = [...list].map((m) => m?.());
  for (const w of writes) w?.();
};
const measures = new Map<Element, Measure>();
let observer: ResizeObserver | null = null;
function watch(els: Element[], measure: Measure): () => void {
  observer ??= new ResizeObserver((entries) => runAll(new Set(entries.map((e) => measures.get(e.target)))));
  for (const el of els) {
    measures.set(el, measure);
    observer.observe(el);
  }
  return () => {
    for (const el of els) {
      measures.delete(el);
      observer?.unobserve(el);
    }
  };
}
// New text whose box keeps its size (two clamped lines) gets no resize call.
const pending = new Set<Measure>();
let frame = 0;
function schedule(measure: Measure): void {
  pending.add(measure);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const list = [...pending];
    pending.clear();
    runAll(list);
  });
}
// Web fonts can land after the first measure and change every width.
if (typeof document !== "undefined") {
  document.fonts?.addEventListener?.("loadingdone", () => runAll(new Set(measures.values())));
}

export function FitText({
  text,
  full,
  className = "",
  lines = 1,
  mode = "hover",
  autoActive = true,
}: {
  text: string;
  /** The title before shortening; when it differs, it's the hover tooltip. */
  full?: string;
  className?: string;
  lines?: 1 | 2;
  mode?: "hover" | "auto";
  /** Playback eligibility for automatic motion; deliberate reading still works. */
  autoActive?: boolean;
}) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const scope = useContext(VisualScopeContext);
  const playback = useRef(autoActive);
  const refreshActivity = useRef(() => {});
  useLayoutEffect(() => {
    playback.current = autoActive;
    refreshActivity.current();
  }, [autoActive]);

  useLayoutEffect(() => {
    const el = outer.current;
    const body = inner.current;
    if (!el || !body) return;
    // One owner combines all vetoes. Playback/focus/coverage changes update
    // this owner without recreating animations or scheduling a React render.
    const activity = createVisualActivity();
    const host = el.parentElement?.closest<HTMLElement>("button, a[href], [tabindex], .fit-host");
    const update = (): void => {
      const reading = el.matches(":hover, :focus-visible") || !!host?.matches(":hover, :focus-visible");
      activity.setActive(visualActivity.getSnapshot() && (scope?.getSnapshot() ?? true) &&
        (playback.current || reading));
    };
    const offActivity = mode === "auto" ? [
      visualActivity.subscribe(update),
      scope?.subscribe(update),
    ] : [];
    refreshActivity.current = update;
    const interactionTargets = mode === "auto" ? [el, ...(host ? [host] : [])] : [];
    const events = ["mouseenter", "mouseleave", "focusin", "focusout"];
    for (const target of interactionTargets) for (const event of events) target.addEventListener(event, update);
    update();
    let running: Animation[] = [];
    let unregister: Array<() => void> = [];
    let slidingBy = 0;
    const stop = (): void => {
      for (const off of unregister) off();
      unregister = [];
      for (const a of running) a.cancel();
      running = [];
      slidingBy = 0;
    };
    const measure: Measure = () => {
      const over = lines === 1 ? body.offsetWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
      return () => {
        const hidden = over > 1;
        el.toggleAttribute("data-over", hidden);
        const tip = hidden ? (full ?? text) : full && full !== text ? full : "";
        if (tip) el.setAttribute("title", tip);
        else el.removeAttribute("title");
        if (mode === "auto") {
          // Overflowing automatic titles also offer deliberate keyboard reading
          // while paused, including the original title when it was shortened.
          if (tip) {
            if (!host?.matches("button, a[href], [tabindex]")) el.tabIndex = 0;
            el.setAttribute("aria-label", tip);
          }
          else { el.removeAttribute("tabindex"); el.removeAttribute("aria-label"); }
        }
        if (lines !== 1) return;
        const shift = hidden ? Math.round(over + FADE) : 0;
        el.style.setProperty("--fit-shift", `${-shift}px`);
        el.style.setProperty("--fit-time", `${Math.max(1, shift / SPEED).toFixed(2)}s`);
        const auto = mode === "auto" && hidden && !stilled();
        if (auto && slidingBy === shift) return;
        stop();
        if (!auto) return;
        // What's playing: rest, slide to the end, rest, slide back — and again.
        const slide = Math.max(1.2, shift / SPEED);
        const rest = 2.4;
        const total = 2 * (rest + slide);
        const at = (t: number): number => t / total;
        slidingBy = shift;
        running = [
          body.animate(
            [
              { transform: "translateX(0)", offset: 0 },
              { transform: "translateX(0)", offset: at(rest), easing: "ease-in-out" },
              { transform: `translateX(${-shift}px)`, offset: at(rest + slide) },
              { transform: `translateX(${-shift}px)`, offset: at(2 * rest + slide), easing: "ease-in-out" },
              { transform: "translateX(0)", offset: 1 },
            ],
            { duration: total * 1000, iterations: Infinity }
          ),
          // The near edge fades only while the start of the line is out of view.
          el.animate(
            [
              { "--fit-fade": "0px", offset: 0 },
              { "--fit-fade": "0px", offset: at(rest) },
              { "--fit-fade": "14px", offset: at(rest + 0.4) },
              { "--fit-fade": "14px", offset: at(2 * rest + 2 * slide - 0.4) },
              { "--fit-fade": "0px", offset: 1 },
            ],
            { duration: total * 1000, iterations: Infinity }
          ),
        ];
        unregister = running.map(activity.registerAnimation);
      };
    };
    const unwatch = watch(lines === 1 ? [el, body] : [el], measure);
    schedule(measure);
    return () => {
      unwatch();
      pending.delete(measure);
      stop();
      el.removeAttribute("tabindex");
      el.removeAttribute("aria-label");
      refreshActivity.current = () => {};
      for (const off of offActivity) off?.();
      for (const target of interactionTargets) for (const event of events) target.removeEventListener(event, update);
    };
  }, [text, full, lines, mode, scope]);

  if (lines === 2) {
    return (
      <span ref={outer} className={`fit-lines ${className}`}>
        <span ref={inner}>{text}</span>
      </span>
    );
  }
  return (
    <span ref={outer} className={`fit-text ${className}`} data-mode={mode}>
      <span ref={inner} className="fit-in">
        {text}
      </span>
    </span>
  );
}
