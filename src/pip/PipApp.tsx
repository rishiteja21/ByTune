/**
 * PipApp — ByTune's native desktop miniplayer (PiP), rendered in its own
 * always-on-top BrowserWindow (`?window=pip`).
 *
 * Visual + behavioural reference: Spotify's desktop miniplayer: a compact
 * square — black outer shell with one hairline edge, artwork up top, a ~58px
 * metadata bar below, a hover-revealed resize grip (bottom right of the
 * whole window), plus ByTune's transport: on hover the artwork gains a
 * Spotify-style black vignette fade while shuffle / prev / play / next /
 * repeat + volume + share surface, with a seek hairline along the
 * artwork's bottom edge.
 *
 * TOP BAR: a minimal control layer that floats over the artwork's top edge —
 * six-dot drag handle centered, X close at the right. Invisible when idle;
 * drops in smoothly (200ms ease-out, exit 250ms ease-in) while the artwork
 * slides beneath it (transform only — the image never resizes), retracting
 * when the cursor leaves the upper region. Drag region is scoped to the
 * six-dot pad; the native cursor watch ("pip:cursor-inside") arbitrates the
 * window boundary since renderer pointer events stop over app-regions.
 *
 * Playback is NOT here. This window holds no audio: it renders snapshots
 * pushed from the main window (pip:state) and sends transport commands back
 * (pip:command). Closing it never touches playback.
 *
 * Window mechanics are native: dragging uses -webkit-app-region scoped to
 * the six-dot pad (the close button opts out with no-drag), resizing uses
 * the frameless window's real resize edges, always-on-top is set in the
 * main process at the "floating" level.
 *
 * Hover zones: the UPPER player zone (top bar + artwork + controls + seek)
 * is ONE continuous hover region driving the top bar and transport —
 * crossings inside it never flicker or retract. The LOWER details zone
 * (title/artist/like) is deliberately outside it, so moving down into the
 * metadata retracts them. The drag pad is a native app-region (invisible to
 * hit-testing): its boundary leave is ignored by pad-band position, and the
 * main process watches the OS cursor ("pip:cursor-inside") to
 * authoritatively hide the bar on real window exits.
 */
import { useEffect, useRef, useState, type ReactNode, type FocusEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  SpCheck,
  SpCoverNote,
  SpNext,
  SpPause,
  SpPlay,
  SpPlus,
  SpPrev,
  SpRepeat,
  SpRepeatOne,
  SpShare,
  SpShuffle,
  SpVolumeHigh,
  SpVolumeOff,
} from "../components/SpotifyIcons";
import { fmtTime } from "../lib/format";
import { upgradeArtwork } from "../lib/artwork";
import type { PipCommand, PipSnapshot } from "./types";

const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragRegion = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** Spotify-scale geometry (logical px). */
const BAR_H = 58; // metadata bar (68px reduced by 15%)
const ART_INSET = 6; // frame gap around the artwork card
const TOP_BAR_H = 26; // dropdown top bar (32px reduced by 20%)

/** like-burst confetti — flight target (--tx/--ty), spin (--rot), size and
    shade of each square in the Spotify-style "added" celebration */
const LIKE_CONFETTI = [
  { size: 4, color: "#1ed760", tx: -3, ty: -17, rot: 95, delay: 0 },
  { size: 3, color: "#9af0b4", tx: 7, ty: -15, rot: -60, delay: 20 },
  { size: 3, color: "#169c46", tx: 15, ty: -7, rot: 140, delay: 10 },
  { size: 4, color: "#1ed760", tx: 18, ty: 3, rot: -110, delay: 30 },
  { size: 3, color: "#b7f5c4", tx: 13, ty: 12, rot: 70, delay: 0 },
  { size: 3, color: "#169c46", tx: 2, ty: 17, rot: -150, delay: 25 },
  { size: 4, color: "#1ed760", tx: -10, ty: 14, rot: 120, delay: 15 },
  { size: 3, color: "#9af0b4", tx: -17, ty: 5, rot: -90, delay: 35 },
  { size: 3, color: "#1ed760", tx: -18, ty: -6, rot: 60, delay: 20 },
  { size: 3, color: "#169c46", tx: -11, ty: -14, rot: -45, delay: 0 },
];
/** How long the volume popover lingers after the pointer leaves its region. */
const VOL_CLOSE_MS = 180;

/** A track is sharable when its id is a YouTube video id (`local:…` file ids have no song link). */
function sharableId(id: string | null | undefined): boolean {
  return !!id && !id.includes(":") && !id.includes("/") && !id.includes("\\");
}

function send(command: PipCommand): void {
  window.bytune?.pipSendCommand(command);
}

function IconBtn({
  onClick,
  active,
  title,
  disabled,
  children,
}: {
  onClick?: () => void;
  active?: boolean;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      style={noDragRegion}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`grid h-8 w-8 cursor-pointer place-items-center rounded-full transition-all duration-150 hover:bg-white/10 active:scale-90 disabled:pointer-events-none disabled:opacity-40 ${
        active ? "text-[#1ed760] hover:text-[#3be477]" : "text-white/90 hover:text-white"
      } focus-visible:text-white`}
    >
      {children}
    </button>
  );
}

/* ================================= TopBar ================================= */
/**
 * The PiP's ONE top panel: a black bar that drops down above the artwork's
 * top edge on hover (the card slides beneath it — transform only, never
 * resized) and retracts when the cursor leaves the upper region. Invisible
 * otherwise — no permanent band, no header, no separation line.
 *
 * ARCHITECTURE — drag correctness: Chromium computes native draggable
 * regions from layout boxes and gets them WRONG inside transformed
 * subtrees (offset/skipped), so NO element in the animated shell carries
 * any `app-region` style — the shell is purely decorative. Instead:
 *   strip    — separate UNtransformed sibling with `app-region: drag` +
 *              grab cursor; it stops short of the buttons, so it can never
 *              overlap them and no carve-outs are needed anywhere
 *   buttons  — minimize + close in an UNtransformed container OUTSIDE the
 *              drag region, so OS clicks always land on the buttons
 *
 * (This is why the buttons were previously unclickable: their `no-drag`
 * carve-outs lived inside the transformed shell and never made it into the
 * native drag bitmap, leaving the button area part of the drag region.)
 *
 * Timings per spec: enter 200ms ease-out, exit 250ms ease-in — transform +
 * opacity only (60fps, no layout shift).
 */
function TopBar({
  visible,
  onClose,
  onMinimize,
}: {
  visible: boolean;
  onClose: () => void;
  onMinimize: () => void;
}): JSX.Element {
  return (
    <div className="group absolute inset-x-0 top-0 z-20" style={{ height: TOP_BAR_H }}>
      {/* animated black bar — the dropdown panel. Dots + minimize + close all
          live INSIDE it and drop as one unit. It carries NO app-region styles
          (Chromium computes native drag regions wrongly inside transformed
          subtrees) — the native drag strip is the separate untransformed
          sibling below, which stops short of the buttons, so the buttons stay
          fully clickable while riding the panel. */}
      <div
        className={`relative flex h-full w-full items-center justify-center bg-black transition-[transform,opacity] ${
          visible
            ? "translate-y-0 opacity-100 duration-200 ease-out"
            : "pointer-events-none -translate-y-full opacity-0 duration-[250ms] ease-in"
        }`}
      >
        {/* 2×3 grip dots — brighten while the top bar is hovered */}
        <div aria-hidden className="grid grid-cols-3 gap-[3px]">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className="h-[2px] w-[2px] rounded-full bg-white/60 transition-colors duration-150 group-hover:bg-white/90"
            />
          ))}
        </div>
        {/* minimize + close — inside the dropdown panel; no drag region
            overlaps them (the strip ends before them), so OS clicks always
            land on the buttons. Minimize minimizes ONLY this window
            (playback + main window untouched); close destroys ONLY this
            window (playback continues). */}
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <button
            type="button"
            onClick={onMinimize}
            title="Minimize miniplayer"
            aria-label="Minimize miniplayer"
            className="grid h-6 w-6 cursor-pointer place-items-center rounded-full text-white transition-colors duration-150 hover:bg-white/10 active:scale-95"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 8h8" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close miniplayer"
            aria-label="Close miniplayer"
            className="grid h-6 w-6 cursor-pointer place-items-center rounded-full text-white transition-colors duration-150 hover:bg-white/10 active:scale-95"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
      {/* native drag strip — UNtransformed sibling; `app-region: drag` +
          grab cursor sit on exactly this box, which ends before the buttons
          so the buttons can never be swallowed by the drag region. Inert
          while hidden so artwork clicks pass through. */}
      <div
        style={dragRegion}
        title="Drag to move"
        className={`absolute left-0 top-0 h-full cursor-grab active:cursor-grabbing ${
          visible ? "right-[64px]" : "pointer-events-none right-0"
        }`}
      />
    </div>
  );
}

export function PipApp() {
  const [snap, setSnap] = useState<PipSnapshot | null>(null);
  /** pointer inside the UPPER player zone (top bar + artwork + controls +
      seek) — ONE continuous region that drives the top bar and transport */
  const [artHover, setArtHover] = useState(false);
  /** native cursor watch (main process): true while the OS pointer is over
      the PiP window. Renderer pointer events stop over the app-region drag
      pad, so the main process arbitrates the inside/outside boundary. */
  const [cursorInside, setCursorInside] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const [volOpen, setVolOpen] = useState(false);
  const volTimer = useRef<number | null>(null);
  const [shareHover, setShareHover] = useState(false);
  /** copy feedback shown in the share tooltip */
  const [shareMsg, setShareMsg] = useState<"copied" | "failed" | null>(null);
  const shareTimer = useRef<number | null>(null);
  /** Spotify-style like-burst overlay (set when adding, self-clears) */
  const [likeBurst, setLikeBurst] = useState(false);
  const likeBurstTimer = useRef<number | null>(null);
  /** While the seek thumb is held down, the drag is purely visual: snapshots
      pushed from the main window must not fight the thumb mid-drag (the main
      window's own SeekBar works the same way). The seek command is sent once,
      on release. */
  const [seekValue, setSeekValue] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const off = window.bytune?.onPipState((s) => setSnap(s as PipSnapshot));
    return off;
  }, []);

  /* Space toggles playback while the PiP window is focused — main-window
     parity. The engine lives in the main window, so this routes over the
     command channel; text fields keep their normal Space, and keys only ever
     arrive here while the PiP window itself is focused. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      send({ type: "toggle" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* The OS window is square but the shell is rounded — outside the 12px
     radius sit the window's four corner squares and the Win11-rounded window
     edge. The body's theme background (`bg-base`, a dark grey) would show
     there as a grey arc around the corners, so the PiP route pins the
     document background to pure black: corner squares, shell and window
     edge all read as one solid black rounded panel. */
  useEffect(() => {
    document.documentElement.style.background = "#000";
    document.body.style.background = "#000";
  }, []);

  useEffect(() => {
    const off = window.bytune?.onPipCursorInside((inside) => setCursorInside(inside));
    return off;
  }, []);

  // A new track resets any in-progress visual drag.
  const seekTrackId = snap?.track?.id ?? null;
  useEffect(() => setSeekValue(null), [seekTrackId]);

  /* The pointer can leave the window without the renderer ever seeing it
     (exits over the app-region drag pad fire no events), which would leave
     artHover stuck true. The native watch is authoritative for "outside". */
  useEffect(() => {
    if (!cursorInside) setArtHover(false);
  }, [cursorInside]);

  /* Scale the transport buttons with the native window size: 1.0 at the
     300px default, shrinking toward the 260px minimum so the row keeps its
     edge padding instead of crowding the artwork, growing (capped) on large
     windows. Written straight to the DOM — no re-render churn mid-resize. */
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = (): void => {
      const w = el.getBoundingClientRect().width || 300;
      const s = Math.min(1.3, Math.max(0.8, w / 300));
      el.style.setProperty("--pip-s", s.toFixed(3));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (volTimer.current !== null) window.clearTimeout(volTimer.current);
      if (shareTimer.current !== null) window.clearTimeout(shareTimer.current);
      if (likeBurstTimer.current !== null) window.clearTimeout(likeBurstTimer.current);
    },
    []
  );

  /** upper-region hover (top bar + artwork + controls + seek = ONE region),
      gated by the native cursor watch so it always drops when the pointer
      leaves the PiP; keyboard focus keeps it reachable regardless */
  const expanded = (artHover && cursorInside) || focusWithin;
  const track = snap?.track ?? null;
  const trackId = track?.id ?? null;
  const playing = snap?.playing ?? false;
  const buffering = snap?.buffering ?? false;
  const duration = snap?.duration ?? 0;
  const position = Math.min(snap?.position ?? 0, duration > 0 ? duration : Infinity);
  const max = duration > 0 ? duration : 1;
  const shownSeek = Math.min(seekValue ?? position, max);
  const commitSeek = (): void => {
    if (seekValue === null) return;
    send({ type: "seek", sec: Math.min(seekValue, max) });
    setSeekValue(null);
  };
  const thumb = track?.thumb ? upgradeArtwork(track.thumb) : "";
  const canShare = sharableId(trackId);

  const onCardFocus = (e: FocusEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(true);
  };
  const onCardBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
  };

  /* ------------------------- volume popover ------------------------- */
  /** The button + slider are ONE hover region: the popover bridges to the
      button with padding (never margin), so crossing from one to the other
      never crosses dead space that would fire mouseleave. A short linger on
      exit keeps fast crossings reliable without ever pinning it open. */
  const openVol = (): void => {
    if (volTimer.current !== null) {
      window.clearTimeout(volTimer.current);
      volTimer.current = null;
    }
    setVolOpen(true);
  };
  const scheduleVolClose = (): void => {
    if (volTimer.current !== null) window.clearTimeout(volTimer.current);
    volTimer.current = window.setTimeout(() => {
      volTimer.current = null;
      setVolOpen(false);
    }, VOL_CLOSE_MS);
  };

  /* ------------------------------ share ------------------------------ */
  /** Copies the current song's real link (the same `music.youtube.com`
      scheme the main app's "Copy link" uses) with a clipboard-API fallback
      for contexts where it is unavailable. */
  const copyShareLink = async (): Promise<void> => {
    if (!track || !canShare) return;
    const url = `https://music.youtube.com/watch?v=${track.id}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    setShareMsg(ok ? "copied" : "failed");
    if (shareTimer.current !== null) window.clearTimeout(shareTimer.current);
    shareTimer.current = window.setTimeout(() => {
      shareTimer.current = null;
      setShareMsg(null);
    }, 1600);
  };
  const shareTip = shareMsg === "copied" ? "Copied!" : shareMsg === "failed" ? "Couldn't copy" : "Copy link to Song";

  const reveal = (extra = ""): string =>
    `${extra} transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
      expanded ? "opacity-100" : "pointer-events-none opacity-0"
    }`;

  return (
    <div
      ref={rootRef}
      onFocus={onCardFocus}
      onBlur={onCardBlur}
      onContextMenu={(e) => e.preventDefault()}
      className="animate-pip-in fixed inset-0 flex select-none flex-col overflow-hidden rounded-[12px] bg-black text-white"
    >
      {/* ONE subtle outer edge — the window's single visual boundary, clipped
          to the same radius as the shell so no second line ever shows. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-50 rounded-[12px] border border-white/[0.07]" />

      {/* ------------------------- upper player zone ------------------------- */}
      {/* ONE continuous hover region: the top bar, artwork, controls and seek
          all live in here, so crossing between them never retracts the bar.
          The metadata bar below stays outside — sliding into the song details
          retracts the bar instead of pinning it open. overflow-hidden clips
          the artwork card when it slides beneath the dropped bar (the card
          itself never resizes — transform only). pointerleave from the drag
          pad (a native app-region, invisible to hit-testing) fires with a
          null native relatedTarget at the pad band and is IGNORED — the
          native cursor watch is the backstop for real window exits. */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ padding: `${ART_INSET}px ${ART_INSET}px 0` }}
        onPointerEnter={() => {
          // A zone enter proves the OS pointer is over the window — mark the
          // native watch true immediately so re-entry never waits a tick.
          setCursorInside(true);
          setArtHover(true);
        }}
        onPointerLeave={(e) => {
          // React rewrites `relatedTarget` on its synthetic enter/leave
          // events (it becomes a node even when the native one is null), so
          // the drag-pad check MUST read the native event: crossing into the
          // app-region pad arrives as a boundary leave with a null native
          // relatedTarget at the pad band — that is NOT a real exit, so it
          // is ignored (the native cursor watch still hides the bar if the
          // pointer truly leaves the window through the pad).
          const native = e.nativeEvent as PointerEvent;
          if (native.relatedTarget === null && native.clientY <= TOP_BAR_H + 2) return;
          setArtHover(false);
        }}
      >
        {/* the artwork card — slides down beneath the dropped bar (transform
            only: the image keeps its exact rendered size, never re-crops),
            landing flush below it with its rounded top corners visible; the
            tucked-under bottom clips at the zone edge. Enter/exit timings
            mirror the bar's so they move as one piece. */}
        <div
          className={`relative h-full w-full overflow-hidden rounded-[10px] bg-black transition-transform ${
            expanded ? "translate-y-[20px] duration-200 ease-out" : "translate-y-0 duration-[250ms] ease-in"
          }`}
          style={{ transform: expanded ? `translateY(${TOP_BAR_H - ART_INSET}px)` : "translateY(0px)" }}
        >
          {thumb ? (
            <img
              key={trackId ?? "none"}
              src={thumb}
              alt=""
              draggable={false}
              className="animate-art-in absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div key={trackId ?? "none"} className="animate-art-in absolute inset-0 grid place-items-center">
              <SpCoverNote className="h-12 w-12 text-white/25" />
            </div>
          )}

          {/* Spotify-style black fade over the art on hover — a radial
              vignette darkening the edges plus a bottom-up linear fade,
              pointer-transparent so it can never swallow drags, hovers or
              clicks; controls sit above it */}
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-0 z-[5] transition-opacity duration-300 ease-out ${
              expanded ? "opacity-100" : "opacity-0"
            }`}
            style={{
              backgroundImage:
                "radial-gradient(120% 90% at 50% 45%, rgba(0,0,0,0) 35%, rgba(0,0,0,0.55) 100%), linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.28) 45%, rgba(0,0,0,0.35) 100%)",
            }}
          />

          {/* hover transport */}
          <div
            className={`absolute inset-0 z-10 flex items-center justify-center ${reveal()}`}
            onClick={() => send({ type: "toggle" })}
            aria-hidden={!expanded}
          >
            <div className="pip-controls flex items-center justify-center gap-[2px] px-1" onClick={(e) => e.stopPropagation()}>
              {/* volume + popover — one hover region, padding-bridged */}
              <div
                className="relative"
                onMouseEnter={openVol}
                onMouseLeave={scheduleVolClose}
                onFocus={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) openVol();
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleVolClose();
                }}
              >
                <IconBtn onClick={() => send({ type: "mute" })} active={snap?.muted} title={snap?.muted ? "Unmute" : "Mute"}>
                  <span key={snap?.muted ? "off" : "on"} className="icon-swap">
                    {snap?.muted ? <SpVolumeOff /> : <SpVolumeHigh />}
                  </span>
                </IconBtn>
                {/* bridge: pb-2 keeps the pointer inside this wrapper while
                    crossing from button to slider — no margin gap to fall
                    through and no mouseleave mid-crossing. Left-anchored so
                    the popover never clips the card's left edge. */}
                <div
                  className={`absolute bottom-full left-0 pb-2 transition-all duration-150 ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
                    volOpen && expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
                  }`}
                >
                  <div className="w-[96px] rounded-xl bg-[#282828] px-2.5 py-2 shadow-elev">
                    <input
                      type="range"
                      aria-label="Volume"
                      min={0}
                      max={1}
                      step={0.01}
                      value={snap?.muted ? 0 : snap?.volume ?? 0.8}
                      onChange={(e) => send({ type: "volume", v: Number(e.target.value) })}
                      className="slider mp-slider w-full"
                      style={{ "--fill": `${Math.round((snap?.muted ? 0 : (snap?.volume ?? 0.8)) * 100)}%` } as React.CSSProperties}
                    />
                  </div>
                </div>
              </div>
              <IconBtn onClick={() => send({ type: "shuffle" })} active={snap?.shuffle} title="Shuffle" disabled={!track}>
                <SpShuffle />
              </IconBtn>
              <IconBtn onClick={() => send({ type: "prev" })} title="Previous" disabled={!track}>
                <SpPrev />
              </IconBtn>
              <button
                type="button"
                style={noDragRegion}
                onClick={() => send({ type: "toggle" })}
                disabled={!track}
                title={playing ? "Pause" : "Play"}
                aria-label={playing ? "Pause" : "Play"}
                className="mx-1.5 grid h-12 w-12 cursor-pointer shrink-0 place-items-center rounded-full bg-white text-black shadow-[0_4px_16px_rgba(0,0,0,0.45)] transition-transform duration-150 hover:scale-[1.06] active:scale-95 focus-visible:scale-[1.06] disabled:pointer-events-none disabled:opacity-40"
              >
                {buffering ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <span key={playing ? "pause" : "play"} className="icon-swap">
                    {playing ? <SpPause className="h-5 w-5" /> : <SpPlay className="ml-0.5 h-5 w-5" />}
                  </span>
                )}
              </button>
              <IconBtn onClick={() => send({ type: "next" })} title="Next" disabled={!track}>
                <SpNext />
              </IconBtn>
              <IconBtn
                onClick={() => send({ type: "repeat" })}
                active={snap?.repeat !== "off"}
                title={snap?.repeat === "one" ? "Repeat one" : "Repeat"}
                disabled={!track}
              >
                {snap?.repeat === "one" ? <SpRepeatOne /> : <SpRepeat />}
              </IconBtn>

              {/* share — rightmost, Spotify-style; tooltip bridges like volume */}
              <div
                className="relative"
                onMouseEnter={() => setShareHover(true)}
                onMouseLeave={() => setShareHover(false)}
              >
                <button
                  type="button"
                  style={noDragRegion}
                  onClick={() => void copyShareLink()}
                  disabled={!canShare}
                  aria-label="Share — copy link to song"
                  className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-white/90 transition-all duration-150 hover:bg-white/10 hover:text-white active:scale-90 disabled:pointer-events-none disabled:opacity-40 focus-visible:text-white"
                >
                  <SpShare />
                </button>
                <div
                  aria-hidden={!(shareHover || shareMsg)}
                  className={`absolute bottom-full right-0 pb-2 transition-all duration-150 ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
                    (shareHover || shareMsg) && expanded
                      ? "translate-y-0 opacity-100"
                      : "pointer-events-none translate-y-1 opacity-0"
                  }`}
                >
                  <div className="whitespace-nowrap rounded-lg bg-[#282828] px-3 py-2 text-[13px] font-medium text-white shadow-elev">
                    {shareTip}
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* seek hairline — pinned to the zone's bottom edge (NOT inside the
            sliding card) so it stays right above the metadata bar in both
            states; hover only */}
        <div
          className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-5 ${reveal()}`}
          onClick={(e) => e.stopPropagation()}
          aria-hidden={!expanded}
        >
          <div className="flex items-center gap-2">
            <span className="w-7 shrink-0 text-right text-[10px] tabular-nums leading-none text-white/70">
              {fmtTime(shownSeek)}
            </span>
            <input
              type="range"
              aria-label="Seek"
              className="slider mp-slider min-w-0 flex-1"
              min={0}
              max={max}
              step={0.5}
              value={shownSeek}
              disabled={!track}
              onChange={(e) => setSeekValue(Number(e.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onBlur={() => {
                if (seekValue !== null) commitSeek();
              }}
              style={{ "--fill": `${Math.min(100, (shownSeek / max) * 100)}%` } as React.CSSProperties}
            />
            <span className="w-7 shrink-0 text-[10px] tabular-nums leading-none text-white/70">
              {fmtTime(duration)}
            </span>
          </div>
        </div>

        {/* THE top bar — the one and only top panel (see TopBar above).
            Drops over the artwork's top edge on upper-region hover while the
            card slides beneath it; retracts on leave; the cover never
            resizes. */}
        <TopBar
          visible={expanded}
          onClose={() => window.bytune?.pipClose()}
          onMinimize={() => window.bytune?.pipMinimize()}
        />
      </div>

      {/* ------------------------- metadata bar ------------------------- */}
      {/* LOWER details zone — deliberately NOT part of the upper hover
          region: moving into it retracts the top bar. Opaque + stacked above
          the zone so the artwork tucks beneath it while the bar is dropped. */}
      <div className="relative z-10 flex shrink-0 items-center gap-1 bg-black pl-4 pr-2" style={{ height: BAR_H }}>
        <button
          type="button"
          style={noDragRegion}
          onClick={() => window.bytune?.pipShowMain()}
          title="Open ByTune"
          aria-label="Open ByTune"
          className="min-w-0 flex-1 text-left"
        >
          <div key={trackId ?? "t"} className="animate-meta-in truncate text-[15px] font-semibold leading-[1.35] text-white">
            {track ? track.title : "Nothing playing"}
          </div>
          <div key={trackId ? `${trackId}-a` : "a"} className="animate-meta-in truncate text-[12px] leading-[1.4] text-white/60">
            {track ? track.artist : ""}
          </div>
        </button>

        {track && (
          <button
            type="button"
            style={noDragRegion}
            onClick={() => {
              // Spotify-style "added" burst when liking (unliked -> liked);
              // tapping the green check (unlike) just swaps back quietly.
              if (!snap?.liked && !likeBurst) {
                setLikeBurst(true);
                if (likeBurstTimer.current !== null) window.clearTimeout(likeBurstTimer.current);
                likeBurstTimer.current = window.setTimeout(() => setLikeBurst(false), 900);
              }
              send({ type: "like" });
            }}
            title={snap?.liked ? "Edit Liked Songs" : "Save to your library"}
            aria-label={snap?.liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
            aria-pressed={snap?.liked}
            className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-transform duration-150 hover:scale-105 active:scale-90"
          >
            <span key={snap?.liked ? "liked" : "unliked"} className="icon-swap">
              {snap?.liked ? (
                <SpCheck className="h-[18px] w-[18px] text-[#1ed760]" />
              ) : (
                <SpPlus className="h-[18px] w-[18px] text-white/70 hover:text-white" />
              )}
            </span>
            {/* like-burst overlay — green check disc + expanding ring + green
                confetti squares; purely visual (pointer-transparent) */}
            {likeBurst && (
              <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-0 w-0">
                {LIKE_CONFETTI.map((p, i) => (
                  <span
                    key={i}
                    className="absolute block"
                    style={
                      {
                        width: p.size,
                        height: p.size,
                        left: -p.size / 2,
                        top: -p.size / 2,
                        background: p.color,
                        animation: `pip-like-confetti 700ms ease-out ${p.delay}ms both`,
                        "--tx": `${p.tx}px`,
                        "--ty": `${p.ty}px`,
                        "--rot": `${p.rot}deg`,
                      } as React.CSSProperties
                    }
                  />
                ))}
                <span
                  className="absolute block rounded-full border-2 border-[#1d7a3c]"
                  style={{ width: 28, height: 28, left: -14, top: -14, animation: "pip-like-ring 800ms ease-out both" }}
                />
                <span
                  className="absolute grid place-items-center rounded-full bg-[#1ed760]"
                  style={{ width: 27, height: 27, left: -13.5, top: -13.5, animation: "pip-like-pop 850ms ease-out both" }}
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="#000" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5.5 12.5l4.4 4.4L18.5 8.3" />
                  </svg>
                </span>
              </span>
            )}
          </button>
        )}
      </div>

      {/* resize hint — owned by the OUTER window corner (never the artwork).
          Purely visual: frameless resizing is the window's native edges, so
          this stays pointer-transparent and can never block real controls. */}
      <div aria-hidden className="pointer-events-none absolute bottom-[3px] right-[3px] z-40">
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 opacity-70">
          <path d="M10 0 0 10 M10 4 4 10 M10 8 8 10" stroke="white" strokeWidth={1} strokeLinecap="round" fill="none" />
        </svg>
      </div>
    </div>
  );
}
