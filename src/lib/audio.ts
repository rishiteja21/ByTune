/**
 * Audio engine — two HTMLAudioElements wired to the player store.
 *
 * The store holds pure state; this module owns all playback side effects:
 * stream resolution (via the main process), play/pause/seek application,
 * error recovery with client rotation, history logging, MediaSession
 * integration (Windows media keys / SMTC), and transitions.
 *
 * Transitions (crossfade controller):
 *   - "standard" crossfade: when a setting duration is configured, the next
 *     track is resolved and started on the standby element a beat before the
 *     current one ends, and the two are blended with an equal-power curve
 *     (out·cosθ + in·sinθ) — no dip in the middle, the standard crossfade law.
 *   - "smart" (automix-lite): when enabled, the next track's opening seconds
 *     are decoded and analysed for tempo (onset-energy BPM) in a worker; the
 *     fade is armed so it *starts* on a beat multiple inside the configured
 *     window. Analysis failing ⇒ honest fallback to the standard fade.
 *   - manual next/prev/seek aborts any fade in flight.
 *
 * Transition states, and the invariant they exist to protect:
 *
 *   idle     — one live deck; the session player is the only one playing.
 *   armed    — the next track is resolved and sits on the standby deck.
 *   blending — the standby deck is PLAYING and audible while the session
 *              player fades out. Two decks are live, and the standby's media
 *              clock is authoritative for the track it is playing.
 *   settled  — the standby deck was promoted to session player.
 *
 *   IF A TRACK IS ALREADY PLAYING DURING A BLEND, THE TRANSITION'S COMPLETION
 *   MUST PROMOTE THAT DECK. Re-running the fresh-track path would reload the
 *   same track from 0:00 and replay the seconds the listener just heard.
 *
 * Two independent signals mean "the transition is over": the blend timer
 * reaching the end of its curve, and the outgoing element's `ended`. They race
 * by a few milliseconds — the fade timeline starts after an async resolve and a
 * play(), so `ended` usually lands first — so both funnel through one
 * idempotent completion, and the deck that is already playing wins either way.
 */
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { isEarlyExit, useListening } from "../stores/listening";
import type { Track } from "../types";
import { requireBridge } from "./bridge";
import { emitPlayEvent } from "./playEvents";
import { analyseTrackHead, detectEdgeSilence } from "./analysis";
import { upgradeArtwork } from "./artwork";

let elements: [HTMLAudioElement, HTMLAudioElement] | null = null;
/** which element is the session player right now */
let mainIdx: 0 | 1 = 0;
let loadedId: string | null = null;
let pendingSeek = 0;
/** retries (with client rotation) for the current track */
let retryCount = 0;
/** consecutive tracks that failed to play — stops auto-skipping eventually */
let consecutiveFailures = 0;
/** the unlinked-local-folder explainer fires once per failing streak, not per skip */
let localMissingToasted = false;
let historyForId: string | null = null;
/** track id the engine itself is advancing to via crossfade — suppresses reload */
let advancingToId: string | null = null;

const MAX_SKIPS = 5;

interface FadeState {
  /** ids, to detect the fade's own completion vs an interrupting change */
  fromId: string;
  toId: string;
  startTs: number;
  durMs: number;
  /** main element's currentTime when the fade began */
  anchorSec: number;
  smart: boolean;
  reason: string;
  /** performance.now() when playback paused mid-fade; null while playing.
      The blend freezes with playback — see the pause branch and driveFade. */
  pausedAt: number | null;
}
let fade: FadeState | null = null;
let fadeTimer: number | null = null;
/** arming window: resolve/start the next track this long before the fade point */
const ARM_LEAD_MS = 4000;
let armed: { toId: string } | null = null;
/**
 * Bumped whenever something invalidates an in-flight arming (a track change, a
 * completed or aborted transition). `beginFade` awaits several times before it
 * starts the standby deck; without this its continuation could wake up after
 * the world moved on and start a track the user already skipped past.
 */
let transitionToken = 0;
/** True while a completion is promoting a deck — makes completion idempotent. */
let settling = false;

/** Derived phase, for callers that must not fight an in-flight transition. */
function transitioning(): boolean {
  return fade !== null || armed !== null;
}
/** silence trims per track id — seconds to skip at the start / before the end */
const silenceTrims = new Map<string, { head: number; tail: number }>();
const MAX_TRIMS = 400;
function setTrim(trackId: string, trims: { head: number; tail: number }): void {
  silenceTrims.delete(trackId);
  silenceTrims.set(trackId, trims);
  while (silenceTrims.size > MAX_TRIMS) {
    const first = silenceTrims.keys().next().value;
    if (first === undefined) break;
    silenceTrims.delete(first);
  }
}
let silenceAnalysing = new Set<string>();

function el(): HTMLAudioElement {
  return elements![mainIdx];
}

/** Live element clock for consumers needing sub-`timeupdate` resolution (lyrics sweep). */
export function getPlaybackPosition(): number {
  return elements ? el().currentTime : 0;
}
function standbyEl(): HTMLAudioElement {
  return elements![mainIdx === 0 ? 1 : 0];
}

/**
 * play() promises reject with "AbortError" when pause() or a src change wins
 * the race — that is a normal interruption, not a playback failure. Treating
 * it as one made handleFailure force-rotate the stream and restart audio the
 * user had just stopped.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

/* ============================ loudness normalisation ============================ */

/**
 * Spotify-parity loudness normalisation.
 *
 * Spotify adjusts every stream to roughly -14 LUFS before it reaches the OS
 * mixer; raw YouTube streams are mastered hotter (measured: -7.7 LUFS for
 * "Shape of You", -10.7 for "All of Me"), which is why ByTune blasted past
 * Spotify at identical volume settings. YouTube reports each track's true
 * integrated loudness in the player response — the stream proxy exposes it
 * at `?meta=1` — so we compute the exact per-track gain that lands the
 * stream on the same -14 LUFS target. The gain is attenuation-only (see
 * gainForLufs): loud masters scale down, quiet ones play untouched, and no
 * sample is ever pushed past full scale. Local library files are exempt —
 * they play at their original level.
 */
const TARGET_LUFS = -14;
/**
 * Gain assumed for a track whose loudness hasn't landed yet. Typical YouTube
 * masters sit around -9 LUFS, whose normalisation gain is ≈0.56; the
 * measurement usually arrives with the first audio chunk, so this only
 * shapes the very start of a stream.
 */
const FALLBACK_GAIN = 0.56;

/** track id → normalisation gain, insertion-ordered as an LRU. */
const loudnessGains = new Map<string, number>();
const GAINS_MAX = 600;

/** Normalisation gain that moves a track measured at `lufs` to the target.
 * Attenuation-only: scaling a signal down is lossless, boosting would clip
 * peaks on masters that sit near full scale — quality comes first. */
function gainForLufs(lufs: number): number {
  return Math.min(1, Math.max(0.05, Math.pow(10, (TARGET_LUFS - lufs) / 20)));
}

function rememberGain(trackId: string, gain: number): void {
  loudnessGains.delete(trackId);
  loudnessGains.set(trackId, gain);
  while (loudnessGains.size > GAINS_MAX) {
    const first = loudnessGains.keys().next().value;
    if (first === undefined) break;
    loudnessGains.delete(first);
  }
}

function gainForTrack(trackId: string | null): number {
  if (!trackId) return FALLBACK_GAIN * MASTER_TRIM;
  return loudnessGains.get(trackId) ?? FALLBACK_GAIN * MASTER_TRIM;
}

/**
 * Fetch a stream's loudness metadata from the proxy and cache its gain.
 * Best-effort: on failure the track keeps the fallback gain.
 */
async function fetchLoudness(proxyUrl: string, trackId: string): Promise<void> {
  try {
    const res = await fetch(`${proxyUrl}&meta=1`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const data = (await res.json()) as { lufs?: unknown };
    const lufs = typeof data?.lufs === "number" && Number.isFinite(data.lufs) ? data.lufs : null;
    if (lufs === null) return;
    rememberGain(trackId, gainForLufs(lufs) * MASTER_TRIM);
    // The track already playing (or being faded into) picks the gain up now.
    const state = usePlayer.getState();
    if (state.queue[state.index]?.id === trackId || fade?.toId === trackId || fade?.fromId === trackId) {
      refreshVolumes();
    }
  } catch {
    /* metadata is best-effort */
  }
}

/**
 * Pre-warm the next queue track: its loudness must be known before a
 * crossfade starts, and the proxy-side resolution cache warms up too, so the
 * transition itself never waits on a getBasicInfo roundtrip.
 */
function prefetchLoudness(track: Track | null): void {
  if (!track || track.localPath || track.id.startsWith("local:")) return;
  if (loudnessGains.has(track.id)) return;
  void (async () => {
    const url = await requireBridge().getStreamUrl(track.id, false, useSettings.getState().streamingQuality);
    if (url) await fetchLoudness(url, track.id);
  })().catch(() => undefined);
}

/**
 * Master trim — folded into every STREAM track's gain. 1.0 = neutral: streams
 * play at the standard -14 LUFS loudness, same as Spotify/YouTube Music.
 * Lower it (e.g. 0.7) if you want streams quieter than the standard, or
 * nudge it up if you want them hotter — above 1.0 a loud master can clip,
 * so treat anything >1.0 with care.
 * Local library files deliberately skip it — they play at their original
 * level (gain 1.0), untrimmed and unnormalised.
 */
const MASTER_TRIM = 1.0;

function userVolume(): number {
  const s = usePlayer.getState();
  return s.muted ? 0 : s.volume;
}

/* ------------------- play/pause volume ramp ------------------- */

/**
 * Spotify-style pause/resume: the volume glides to silence over ~150ms before
 * the element actually pauses, and glides back up on resume, so play/pause
 * never clicks. Deliberately separate from the crossfade controller — it only
 * shapes the main element around a play/pause flip and stands down the moment
 * anything else (a crossfade, a track change, a fresh load) touches volumes.
 */
const PP_RAMP_MS = 150;

/** Active ramp: dir 0 = gliding down to a pause, 1 = gliding up on resume.
 * `from` lets a reversed ramp continue from its current level instead of
 * snapping (pause pressed mid fade-in, play pressed mid fade-out). */
let ppRamp: { dir: 0 | 1; from: number; startTs: number; timer: number } | null = null;

function stopPpRamp(): void {
  if (ppRamp) {
    window.clearInterval(ppRamp.timer);
    ppRamp = null;
  }
}

/** Ramp multiplier for the main element — 1 (neutral) when no ramp runs. */
function ppRampGain(): number {
  if (!ppRamp) return 1;
  const p = Math.min(1, Math.max(0, (performance.now() - ppRamp.startTs) / PP_RAMP_MS));
  const eased = (1 - Math.cos(Math.PI * p)) / 2;
  return ppRamp.dir === 0 ? ppRamp.from * (1 - eased) : ppRamp.from + (1 - ppRamp.from) * eased;
}

function startPpRamp(dir: 0 | 1): void {
  const from = ppRamp ? ppRampGain() : dir === 1 ? 0 : 1;
  stopPpRamp();
  if (!elements) return;
  ppRamp = { dir, from, startTs: performance.now(), timer: 0 };
  ppRamp.timer = window.setInterval(() => {
    if (!ppRamp || !elements) {
      stopPpRamp();
      return;
    }
    // A crossfade owns the volume curve while it runs — stand down.
    if (fade) {
      stopPpRamp();
      return;
    }
    const d = ppRamp.dir;
    if ((d === 0 && ppRampGain() <= 0) || (d === 1 && ppRampGain() >= 1)) {
      stopPpRamp();
      // The fade-out's whole point: pause only once silence is reached —
      // and never if a resume already won the race.
      if (d === 0 && !usePlayer.getState().playing) el().pause();
      refreshVolumes();
      return;
    }
    refreshVolumes();
  }, 25);
}

/** Re-apply element volumes for the current state (fade curve, ramp or steady). */
function refreshVolumes(): void {
  if (fade) {
    // Same clock driveFade uses: while paused the blend holds its frozen
    // point instead of drifting to the end of the curve.
    const clock = fade.pausedAt ?? performance.now();
    const p = Math.min(1, Math.max(0, (clock - fade.startTs) / fade.durMs));
    const theta = p * (Math.PI / 2);
    applyElementVolumes(Math.cos(theta), Math.sin(theta));
  } else {
    applyElementVolumes(ppRampGain(), 0);
  }
}

/**
 * Set both elements' volumes from the user volume, the crossfade curve and
 * each element's own track loudness gain (main = current track, standby =
 * the track being faded in).
 */
function applyElementVolumes(mainGain: number, standbyGain: number): void {
  if (!elements) return;
  const v = userVolume();
  const state = usePlayer.getState();
  const mainId = state.queue[state.index]?.id ?? null;
  const standbyId = fade?.toId ?? null;
  const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
  elements[mainIdx].volume = clamp01(v * mainGain * gainForTrack(mainId));
  elements[mainIdx === 0 ? 1 : 0].volume = clamp01(v * standbyGain * gainForTrack(standbyId));
}

function applySpeed(): void {
  if (!elements) return;
  const rate = useSettings.getState().playbackSpeed || 1;
  for (const e of elements) {
    try {
      e.playbackRate = rate;
      // Chromium honours pitch preservation separately; keep speech/music natural.
      (e as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    } catch {
      /* ignore */
    }
  }
}

function updateBuffered(): void {
  const a = el();
  if (!a) return;
  try {
    if (a.buffered.length > 0 && Number.isFinite(a.duration) && a.duration > 0) {
      usePlayer.getState()._setBuffered(a.buffered.end(a.buffered.length - 1) / a.duration);
    }
  } catch {
    /* ignore */
  }
}

function onTimeUpdate(): void {
  const a = el();
  if (!a) return;
  usePlayer.getState()._setTime(a.currentTime, a.duration);
  updateBuffered();
  const cur = usePlayer.getState().queue[usePlayer.getState().index];
  if (cur) accumulate(cur.id, a.currentTime);
  maybeArmTransition();
}

/* ============================ transitions ============================ */

function fadeMsForNext(): number {
  const s = useSettings.getState();
  // Automix owns transitions, so it works out of the box: no crossfade
  // duration set means a sensible 6s blend rather than no transition at all.
  const fallback = s.smartFade ? 6 : 0;
  return Math.max(0, Math.round((s.crossfadeSeconds || fallback) * 1000));
}

/**
 * Transition planner, desktop scale: when smart mode is on and the
 * next track's tempo is known, slide the fade start so it lands on a beat
 * (or a bar) inside the arming window — a transition that begins on the grid
 * instead of an arbitrary sample. Everything else is a standard fade.
 */
function planFadeStart(nextId: string, fadeMs: number): { delayMs: number; smart: boolean; reason: string } {
  const smartOn = useSettings.getState().smartFade;
  const a = el();
  const duration = Number.isFinite(a.duration) ? a.duration : 0;
  const remainingMs = Math.max(0, (duration - a.currentTime) * 1000);
  if (!smartOn || remainingMs <= fadeMs) return { delayMs: Math.max(0, remainingMs - fadeMs), smart: false, reason: "standard" };

  const grid = analyseTrackHead.getCached(nextId);
  if (!grid || !grid.bpm || grid.bpm < 50 || grid.bpm > 220) {
    return { delayMs: Math.max(0, remainingMs - fadeMs), smart: false, reason: "no tempo — standard fade" };
  }
  const beatMs = 60000 / grid.bpm;
  const beatDist = (ms: number): number => {
    const m = Math.abs(ms % beatMs);
    return Math.min(m, beatMs - m);
  };
  // Slide the fade start so both its start and its end sit close to beats —
  // the blend then opens and lands on the grid instead of between them.
  const idealStart = Math.max(0, remainingMs - fadeMs);
  const earliest = Math.max(0, idealStart - beatMs * 2);
  let best = idealStart;
  let bestErr = Infinity;
  for (let t = earliest; t <= remainingMs; t += beatMs) {
    const err = beatDist(t) + beatDist(t + fadeMs);
    if (err < bestErr) {
      bestErr = err;
      best = t;
    }
  }
  return { delayMs: Math.max(0, best), smart: true, reason: `beat-aligned @ ${grid.bpm} BPM` };
}

function maybeArmTransition(): void {
  if (fade || armed) return;
  const fadeMs = fadeMsForNext();
  if (fadeMs < 500) return;
  const state = usePlayer.getState();
  if (state.shuffle) return; // random next can't be pre-picked
  if (state.repeat === "one") return;
  if (!state.queue.length || state.index >= state.queue.length - 1) return;
  const a = el();
  const duration = Number.isFinite(a.duration) ? a.duration : 0;
  if (!duration || !state.playing) return;
  const remainingMs = (duration - a.currentTime) * 1000;
  if (remainingMs > fadeMs + ARM_LEAD_MS || remainingMs <= 250) return;

  const nextTrack = state.queue[state.index + 1];
  if (!nextTrack) return;
  armed = { toId: nextTrack.id };
  void beginFade(nextTrack, fadeMs);
}

async function beginFade(nextTrack: Track, fadeMs: number): Promise<void> {
  const stand = standbyEl();
  const token = ++transitionToken;
  /** The arming this continuation belongs to is still the live one. */
  const stale = (): boolean => token !== transitionToken;
  try {
    const url = await requireBridge().getStreamUrl(nextTrack.id, false, useSettings.getState().streamingQuality);
    // The fade's standby element carries the incoming track's own loudness
    // gain; the load-time prefetch usually already did this — cheap retry.
    void fetchLoudness(url, nextTrack.id);
    // The world may have moved on while we resolved.
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (stale() || !armed || armed.toId !== nextTrack.id || fade || cur?.id === nextTrack.id) {
      armed = null;
      return;
    }
    // Smart mode needs the next track's tempo; if it isn't analysed yet this
    // is the moment it gets fetched and decoded (bounded by the arm window).
    if (useSettings.getState().smartFade) {
      await Promise.race([
        analyseTrackHead.ensure(nextTrack.id),
        new Promise<void>((r) => window.setTimeout(r, 2200)),
      ]);
    }
    if (stale() || !armed || armed.toId !== nextTrack.id || fade) {
      armed = null;
      return;
    }
    const plan = planFadeStart(nextTrack.id, fadeMs);
    const startAt = performance.now() + plan.delayMs;
    stand.src = url;
    stand.currentTime = 0;
    applySpeed();
    const state = usePlayer.getState();
    armed = null;
    const waitMs = startAt - performance.now();
    if (waitMs > 30) await new Promise<void>((r) => window.setTimeout(r, waitMs));
    if (stale() || fade) return;
    // If the user interacted meanwhile, re-check.
    const s2 = usePlayer.getState();
    if (s2.index >= s2.queue.length - 1 || s2.queue[s2.index + 1]?.id !== nextTrack.id) return;
    const main = el();
    if (!s2.playing) {
      try {
        stand.pause();
      } catch {
        /* ignore */
      }
      return;
    }
    const anchorSec = main.currentTime;
    fade = {
      fromId: s2.queue[s2.index].id,
      toId: nextTrack.id,
      startTs: performance.now(),
      durMs: fadeMs,
      anchorSec,
      smart: plan.smart,
      reason: plan.reason,
      pausedAt: null,
    };
    if (plan.smart) {
      useUI.getState().toast(`Automix: ${plan.reason}`, "info");
    }
    try {
      void stand.play();
    } catch {
      /* fade falls back below if the standby refuses */
    }
    stopPpRamp();
    applyElementVolumes(1, 0);
    driveFade();
  } catch {
    // Resolution failed — the natural end path handles playback.
    armed = null;
  }
}

/** One 25ms tick of the equal-power ramp; finalizes the transition at the end. */
function driveFade(): void {
  if (fadeTimer != null) return;
  fadeTimer = window.setInterval(() => {
    if (!fade || !elements) {
      stopFadeTimer();
      return;
    }
    const state = usePlayer.getState();
    const cur = state.queue[state.index];
    // Interrupted by anything that changed the current track identity.
    if (!cur || cur.id !== fade.fromId) {
      abortFade(false);
      return;
    }
    // A track shorter than the blend runs out mid-transition. Promoting it
    // there is the only outcome that isn't a silent gap: the blend would
    // otherwise keep fading a deck with nothing left to fade in.
    if (standbyEl().ended) {
      completeTransition("incoming-ended");
      return;
    }
    // The blend freezes while paused (see the pause branch): hold the curve
    // and never finalize — finalize swaps roles and sets playing: true, which
    // force-resumed the next track after the user had paused.
    const clock = fade.pausedAt ?? performance.now();
    const p = Math.min(1, Math.max(0, (clock - fade.startTs) / fade.durMs));
    const theta = p * (Math.PI / 2);
    applyElementVolumes(Math.cos(theta), Math.sin(theta));
    if (p >= 1) {
      if (!state.playing) return;
      completeTransition("blend-complete");
    }
  }, 25);
}

function stopFadeTimer(): void {
  if (fadeTimer != null) {
    window.clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

/**
 * The single, idempotent end of a transition.
 *
 * Both completion signals — the blend timer and the outgoing element's
 * `ended` — land here, so whichever wins, the deck that is already playing
 * the incoming track is the one that becomes the session player. Its media
 * element is kept as-is: same src, same playback position, still running.
 * Nothing is reloaded and `currentTime` is never rewritten.
 */
function completeTransition(reason: "blend-complete" | "outgoing-ended" | "incoming-ended"): void {
  if (settling) return;
  const f = fade;
  if (!f) return;
  settling = true;
  fade = null;
  armed = null;
  stopFadeTimer();
  try {
    const state = usePlayer.getState();
    const ni = state.queue.findIndex((t) => t.id === f.toId);
    if (ni < 0) {
      // The incoming track left the queue mid-blend (it was removed, or the
      // queue was truncated). Nothing owns that deck any more, so stop it —
      // leaving it playing would put a track in the air that the UI has no
      // record of — and hand the volume back to the outgoing one.
      const orphan = standbyEl();
      try {
        orphan.pause();
        orphan.removeAttribute("src");
        orphan.load();
      } catch {
        /* ignore */
      }
      applyElementVolumes(1, 0);
      return;
    }
    // Role swap FIRST: the standby element IS the session player now, and the
    // outgoing main gets cleaned up only after it has been demoted.
    const oldMain = el();
    mainIdx = mainIdx === 0 ? 1 : 0;
    loadedId = f.toId;
    historyForId = f.toId;
    try {
      oldMain.pause();
      oldMain.removeAttribute("src");
      oldMain.load();
    } catch {
      /* ignore */
    }
    // The promoted deck's own clock is the authority for where this track is.
    // Read it before touching the store, and clamp: a deck that ran out early
    // can report a position at or past its duration, and a store position
    // beyond the media duration is what makes a later seek jump.
    const stand = el();
    const raw = stand.currentTime;
    const dur = Number.isFinite(stand.duration) ? stand.duration : Infinity;
    const pos = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), Number.isFinite(dur) ? dur : Math.max(raw, 0)) : 0;
    flushAccum("stop");
    accum = { id: f.toId, playedMs: 0, pendingMs: 0, lastPos: pos };
    emitPlayEvent("start", state.queue[ni], pos, 0, 0);
    useLibrary.getState().pushHistory(state.queue[ni]);
    advancingToId = f.toId;
    usePlayer.setState({ index: ni, position: pos, playing: true, error: null });
    advancingToId = null;
    // Volumes after the index update: the loudness gain is keyed by the current
    // track, and the engine-driven advance short-circuits the store subscription,
    // so this is the one place the new main's gain gets applied. The last fade
    // tick already left the elements at these levels — no jump.
    applyElementVolumes(1, 0);
    silenceAnalysing.delete(f.toId);
    const t = silenceTrims.get(f.toId);
    if (t && t.tail > 0) armSilenceTail(t.tail);
  } finally {
    settling = false;
    transitionToken += 1;
  }
  // A deck promoted after it already ran out would stall the queue: its
  // `ended` fired while it was still the standby and nothing re-arms it. Hand
  // straight to the normal end path so playback keeps moving.
  if (reason === "incoming-ended") onTrackEnded();
}

function abortFade(keepRoles: boolean): void {
  const f = fade;
  fade = null;
  armed = null;
  stopFadeTimer();
  // Invalidate any arming still awaiting its start — its continuation must
  // not wake up and start a deck for a track the user already moved past.
  transitionToken += 1;
  if (!f || !elements) return;
  const oldStandby = standbyEl();
  try {
    oldStandby.pause();
    oldStandby.removeAttribute("src");
    oldStandby.load();
  } catch {
    /* ignore */
  }
  if (!keepRoles) applyElementVolumes(1, 0);
}

/* ============================ skip silence ============================ */

let silenceTailTimer: number | null = null;

/* -------- listening telemetry (feeds stats, scrobblers, Discord) -------- */
const PROGRESS_EVERY_MS = 5000;
interface Accum {
  id: string;
  /** total listening time on this track (drives scrobble thresholds) */
  playedMs: number;
  /** listening time not yet reported (never double-counted on pause) */
  pendingMs: number;
  lastPos: number;
}
let accum: Accum | null = null;

/** Fold a span of element time into the accumulator; emit on 5s boundaries. */
function accumulate(trackId: string, nowPos: number): void {
  const state = usePlayer.getState();
  if (!state.playing) return;
  const track = state.queue[state.index];
  if (!track || track.id !== trackId) return;
  if (!accum || accum.id !== trackId) accum = { id: trackId, playedMs: 0, pendingMs: 0, lastPos: nowPos };
  const delta = nowPos - accum.lastPos;
  // Seeks backwards / element resets must not register as listening time.
  if (delta > 0 && delta < 2.5) {
    accum.playedMs += delta * 1000;
    accum.pendingMs += delta * 1000;
  }
  accum.lastPos = nowPos;
  if (accum.pendingMs >= PROGRESS_EVERY_MS) {
    emitPlayEvent("progress", track, nowPos, accum.playedMs / 1000, Math.round(accum.pendingMs));
    accum.pendingMs = 0;
  }
}

/** The current track stopped being heard — flush what it earned. */
function flushAccum(type: "stop" | "pause"): void {
  if (!accum) return;
  const track = usePlayer.getState().queue.find((t) => t.id === accum!.id) ?? null;
  if (track && accum.pendingMs >= 500) {
    emitPlayEvent(type, track, accum.lastPos, accum.playedMs / 1000, Math.round(accum.pendingMs));
    accum.pendingMs = 0;
  }
  if (type === "stop") {
    // Every flush("stop") is a track switch — the one moment a skip is
    // knowable. "stop" is only ever sent here and at the crossfade swap.
    if (track && isEarlyExit(accum.playedMs / 1000, track.duration)) {
      useListening.getState().recordSkip(track);
    }
    accum = null;
  }
}

function armSilenceTail(tailSec: number): void {
  disarmSilenceTail();
  const check = (): void => {
    // A paused element holds its position inside the tail zone — advancing
    // then would start the next track while the user asked for silence.
    if (!usePlayer.getState().playing) return;
    // A blend in flight owns the transition. Advancing here would land on the
    // track already fading in, tear the standby deck down and restart it from
    // zero — the same double-play the blend exists to prevent. The promoted
    // track re-arms its own tail when the blend completes.
    if (transitioning()) return;
    const cur = el();
    if (!Number.isFinite(cur.duration)) return;
    if (cur.currentTime >= cur.duration - tailSec - 0.05) {
      usePlayer.getState().next(false);
    }
  };
  silenceTailTimer = window.setInterval(check, 500);
  void check();
}

function disarmSilenceTail(): void {
  if (silenceTailTimer != null) {
    window.clearInterval(silenceTailTimer);
    silenceTailTimer = null;
  }
}

/** Head silence trim applied for this track, if any (lyric offset math). */
export function getHeadTrim(trackId: string): number {
  return silenceTrims.get(trackId)?.head ?? 0;
}

/** Request edge-silence analysis for the track that just started loading. */
function requestSilenceAnalysis(track: Track): void {
  const s = useSettings.getState();
  if (!s.skipSilence) return;
  if (silenceTrims.has(track.id) || silenceAnalysing.has(track.id)) return;
  if (!track.duration || track.duration < 10) return;
  const isLocal = !!track.localPath || track.id.startsWith("local:");
  silenceAnalysing.add(track.id);
  void (async () => {
    try {
      const bridge = requireBridge();
      // Local files decode through the same proxy route the element plays.
      const url = isLocal
        ? await bridge.localTrackUrl(track.id)
        : await bridge.getStreamUrl(track.id, false, useSettings.getState().streamingQuality);
      if (!url) return;
      const res = await fetch(url);
      if (!res.ok || !res.body) return;
      const buf = await res.arrayBuffer();
      const trims = await detectEdgeSilence(buf);
      if (trims && (trims.head > 0.05 || trims.tail > 0.05)) {
        setTrim(track.id, trims);
        const state = usePlayer.getState();
        const cur = state.queue[state.index];
        const a = el();
        // Apply the head trim if this track is still the one playing and just started.
        if (cur?.id === track.id && loadedId === track.id && a.currentTime < Math.max(0.6, trims.head)) {
          try {
            a.currentTime = trims.head;
          } catch {
            /* ignore */
          }
        }
        if (cur?.id === track.id && state.playing && trims.tail > 0) armSilenceTail(trims.tail);
      }
    } catch {
      /* analysis is best-effort */
    } finally {
      silenceAnalysing.delete(track.id);
    }
  })();
}

/* ============================ engine boot ============================ */

export function initAudioEngine(): void {
  if (elements) return;
  const mk = (): HTMLAudioElement => {
    const a = new Audio();
    a.preload = "auto";
    return a;
  };
  elements = [mk(), mk()];
  applyElementVolumes(1, 0);
  applySpeed();

  for (let i = 0; i < 2; i++) {
    const e = elements[i];
    // Only the session player's clock drives the tick: onTimeUpdate and
    // updateBuffered read the main element, so standby events would run them
    // against the wrong element twice per update.
    e.addEventListener("timeupdate", () => {
      if (i === mainIdx) onTimeUpdate();
    });
    e.addEventListener("progress", () => {
      if (i === mainIdx) updateBuffered();
    });
    e.addEventListener("waiting", () => {
      if (i === mainIdx) usePlayer.getState()._setBuffering(true);
    });
    e.addEventListener("canplay", () => {
      if (i === mainIdx) usePlayer.getState()._setBuffering(false);
    });
    e.addEventListener("playing", () => {
      if (i !== mainIdx) return;
      usePlayer.getState()._setBuffering(false);
      consecutiveFailures = 0;
      localMissingToasted = false;
      const cur = usePlayer.getState().queue[usePlayer.getState().index];
      if (cur && historyForId !== cur.id) {
        historyForId = cur.id;
        useLibrary.getState().pushHistory(cur);
        accum = { id: cur.id, playedMs: 0, pendingMs: 0, lastPos: el().currentTime };
        emitPlayEvent("start", cur, el().currentTime, 0, 0);
      } else if (cur) {
        emitPlayEvent("resume", cur, el().currentTime, (accum?.playedMs ?? 0) / 1000, 0);
      }
    });
    // Errors and natural ends must be caught on BOTH elements: after a
    // crossfade the other element becomes the session player.
    e.addEventListener("error", () => {
      if (i !== mainIdx) return;
      const cur = usePlayer.getState().queue[usePlayer.getState().index];
      if (!cur || loadedId !== cur.id) return;
      handleFailure(cur);
    });
    e.addEventListener("ended", () => {
      if (i !== mainIdx) return;
      onTrackEnded();
    });
  }



  usePlayer.subscribe((state, prev) => {
    if (!elements) return;
    const cur = state.queue[state.index] ?? null;
    const prevCur = prev.queue[prev.index] ?? null;

    if (cur?.id !== prevCur?.id) {
      if (advancingToId && cur && advancingToId === cur.id) {
        // Engine-driven advance: roles already swapped; nothing to load.
        return;
      }
      // A jump to the track that is already fading in is not a new track — it
      // is the transition being called early. `next()` from the outgoing
      // track resolves to exactly that track, so the skip would otherwise
      // tear down a deck the listener is already hearing and replay it from
      // the top. Promote it instead: it becomes active once, where it is.
      if (fade && cur && cur.id === fade.toId) {
        completeTransition("outgoing-ended");
        return;
      }
      // Anything else is the user (or a settings/queue change) steering to a
      // different track. That is a deliberate cancellation, not a completion:
      // tear the standby deck down so its half-heard track cannot go on
      // playing alongside the new one.
      abortFade(false);
      stopPpRamp();
      flushAccum("stop");
      void loadTrack(cur, state.playing);
      return;
    }

    if (fade) {
      // Manual interference during a fade: anything other than pure play-state
      // changes on the same track aborts the blend.
      if (state.seekNonce !== prev.seekNonce) abortFade(false);
    }

    if (state.queue !== prev.queue && cur && cur.id === prevCur?.id && state.position === 0 && prev.position > 3) {
      try {
        el().currentTime = 0;
      } catch {
        /* ignore */
      }
    }

    if (state.playing !== prev.playing) {
      if (state.playing) {
        // Resuming mid-crossfade: shift the frozen fade timeline by the
        // paused span and bring the standby element back, so the blend
        // continues from where it froze instead of jumping to its end.
        const f = fade;
        if (f && f.pausedAt != null) {
          fade = { ...f, startTs: f.startTs + (performance.now() - f.pausedAt), pausedAt: null };
          const stand = standbyEl();
          if (stand.src) void stand.play().catch(() => undefined);
        }
        if (loadedId === cur?.id && el().src) {
          el().play().catch((err: unknown) => {
            // An aborted play() is a pause() or src change winning the race —
            // not a failure (see isAbortError).
            if (isAbortError(err)) return;
            handleFailure(cur, err);
          });
          // Spotify-style resume: the sound glides back in. Mid-crossfade the
          // blend owns the volumes — leave it alone.
          if (!fade) startPpRamp(1);
        } else if (cur) {
          stopPpRamp();
          void loadTrack(cur, true);
        }
      } else {
        flushAccum("pause");
        const f = fade;
        if (f) {
          stopPpRamp();
          el().pause();
          // Pausing holds both elements and freezes the blend: the fade
          // timeline stops with playback (pausedAt) and completes after
          // resume. Left running, the timer reached its end while paused and
          // finalizeFade force-resumed the next track over the pause.
          f.pausedAt = performance.now();
          standbyEl().pause();
          const t = Math.min(1, Math.max(0, (f.pausedAt - f.startTs) / f.durMs));
          const theta = t * (Math.PI / 2);
          applyElementVolumes(Math.cos(theta), Math.sin(theta));
        } else {
          // Spotify-style pause: glide to silence first; the ramp tick pauses
          // the element once it bottoms out (~PP_RAMP_MS later).
          startPpRamp(0);
        }
        if (state.position === 0 && state.duration === 0) disarmSilenceTail();
      }
    }

    refreshVolumes();

    if (state.seekNonce !== prev.seekNonce) {
      disarmSilenceTail();
      try {
        el().currentTime = state.position;
      } catch {
        /* ignore */
      }
      const t = cur ? silenceTrims.get(cur.id) : null;
      if (t && t.tail > 0 && state.playing) armSilenceTail(t.tail);
    }
  });

  // Playback speed lives in settings — re-apply whenever they change.
  useSettings.subscribe(() => applySpeed());

  setupMediaSession();
}

function onTrackEnded(): void {
  const state = usePlayer.getState();
  const current = state.queue[state.index] ?? null;
  // The user (or a fade) already chose the next track while this element was
  // finishing - its natural end must not advance the queue again.
  if (!current || loadedId !== current.id) return;
  // A blend owns this transition: the next track is already PLAYING on the
  // standby deck and its media clock is authoritative. This element reaching
  // its natural end IS the transition completing, so promote that deck.
  //
  // Advancing the queue here instead re-entered the fresh-track path — it
  // reloaded the very track the listener is already hearing, on the deck that
  // had just been demoted, and restarted it at 0:00. That is the audible
  // "Auto Mix plays the first seconds of the next song twice" bug.
  if (fade && fade.fromId === current.id) {
    completeTransition("outgoing-ended");
    return;
  }
  if (state.repeat === "one") {
    const a = el();
    a.currentTime = 0;
    void a.play().catch(() => undefined);
    return;
  }
  // Queue exhausted with repeat off: keep the music going if the user has
  // AutoPlay on by pulling one more suggestion into the queue.
  const atEnd = state.index >= state.queue.length - 1;
  if (atEnd && state.repeat === "off" && useSettings.getState().autoplay) {
    void autoplayNext();
    return;
  }
  state.next(false);
}

/** Guards against overlapping AutoPlay fetches when tracks end back-to-back. */
let autoplaying = false;

/**
 * AutoPlay: the queue ran out, so fetch the home feed and append one track the
 * listener hasn't heard this session, then jump straight to it.
 */
async function autoplayNext(): Promise<void> {
  if (autoplaying) return;
  autoplaying = true;
  try {
    const shelves = await requireBridge().getHome();
    const pool: Track[] = [];
    for (const shelf of shelves ?? []) {
      for (const item of shelf.items ?? []) {
        if (item.kind === "track" && item.track) pool.push(item.track);
      }
    }
    const state = usePlayer.getState();
    // Never append a track the queue already holds — the old unconditional
    // pool[0] pick repeated one song forever once the queue drained.
    // "Don't repeat suggestions" additionally keeps everything from recent
    // history out of the pick.
    const heard = new Set(state.queue.map((t) => t.id));
    if (useSettings.getState().dontRepeatSuggestions) {
      for (const t of useLibrary.getState().history) heard.add(t.id);
    }
    const pick = pool.find((t) => !heard.has(t.id)) ?? pool[0];
    if (!pick) {
      usePlayer.setState({ playing: false });
      return;
    }
    state.addToQueue(pick);
    usePlayer.setState({
      index: usePlayer.getState().queue.length - 1,
      playing: true,
      position: 0,
      error: null,
    });
  } catch {
    usePlayer.setState({ playing: false });
  } finally {
    autoplaying = false;
  }
}

/** Called once after persisted state has been rehydrated. */
export function engineBoot(): void {
  initAudioEngine();
  const state = usePlayer.getState();
  const cur = state.queue[state.index] ?? null;
  if (cur) void loadTrack(cur, false);
}

async function loadTrack(track: Track | null, autoplay: boolean): Promise<void> {
  if (!elements) return;
  disarmSilenceTail();
  // A fresh load is a new playback session: any arming still waiting on a
  // start belongs to the previous track and must not fire.
  transitionToken += 1;
  if (!track) {
    loadedId = null;
    historyForId = null;
    el().pause();
    el().removeAttribute("src");
    el().load();
    usePlayer.setState({ position: 0, duration: 0, buffered: 0, buffering: false, error: null });
    updateMediaSession(null);
    return;
  }
  loadedId = null;
  historyForId = null;
  retryCount = 0;
  pendingSeek = usePlayer.getState().position;
  usePlayer.setState({
    buffering: true,
    position: 0,
    error: null,
    duration: track.duration || 0,
  });
  requestSilenceAnalysis(track);
  // When a transition is armed, pre-warm the next track's loudness: its gain
  // must be known the moment a crossfade starts, and the proxy-side stream
  // resolution warms up with it.
  if (fadeMsForNext() >= 500) {
    const st = usePlayer.getState();
    prefetchLoudness(st.queue[st.index + 1] ?? null);
  }
  await loadUrl(track, autoplay, false);
}

async function loadUrl(track: Track, autoplay: boolean, forceRotate: boolean): Promise<void> {
  if (!elements) return;
  try {
    if (track.localPath || track.id.startsWith("local:")) {
      const a = el();
      // Local files stream through the main-process proxy (a file:// src is
      // blocked from the http renderer origin). Always resolve fresh — the
      // proxy port changes between launches, so cached URLs would go stale,
      // and the IPC lookup is a local roundtrip.
      const src = await requireBridge().localTrackUrl(track.id);
      if (!src) throw new Error("Local file is missing on disk");
      // Local files play at their original level — no normalisation, no trim.
      rememberGain(track.id, 1);
      // Apply immediately: without this the element keeps the PREVIOUS
      // track's gain (streams land their own via fetchLoudness, locals
      // would otherwise never get a volume write).
      refreshVolumes();
      a.src = src;
      loadedId = track.id;
      if (pendingSeek > 0) {
        try {
          a.currentTime = pendingSeek;
        } catch {
          /* ignore */
        }
        pendingSeek = 0;
      }
      applySpeed();
      updateMediaSession(track);
      if (autoplay || usePlayer.getState().playing) {
        await a.play();
      } else {
        usePlayer.setState({ buffering: false });
      }
      return;
    }
    const url = await requireBridge().getStreamUrl(track.id, forceRotate, useSettings.getState().streamingQuality);
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (cur?.id !== track.id) return; // user moved on while we were resolving
    // Loudness metadata races the element's own first request: both share the
    // proxy's single in-flight resolution, so the measured gain lands with the
    // first audio chunk while the fallback gain covers the moment before.
    void fetchLoudness(url, track.id);
    const a = el();
    a.src = url;
    // Start at this track's own gain (cached or fallback) instead of the
    // previous track's — fetchLoudness refines it once metadata lands.
    refreshVolumes();
    loadedId = track.id;
    const trim = silenceTrims.get(track.id);
    if (pendingSeek > 0) {
      try {
        a.currentTime = pendingSeek;
      } catch {
        /* ignore */
      }
      pendingSeek = 0;
    } else if (trim && trim.head > 0.05) {
      try {
        a.currentTime = trim.head;
      } catch {
        /* ignore */
      }
    }
    applySpeed();
    updateMediaSession(track);
    if (autoplay || usePlayer.getState().playing) {
      await a.play();
    } else {
      usePlayer.setState({ buffering: false });
    }
    const t = silenceTrims.get(track.id);
    if (t && t.tail > 0 && usePlayer.getState().playing) armSilenceTail(t.tail);
  } catch (err) {
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (cur?.id !== track.id) return;
    handleFailure(track, err);
  }
}

function handleFailure(track: Track, err?: unknown): void {
  const state = usePlayer.getState();
  if (state.queue[state.index]?.id !== track.id) return;
  usePlayer.setState({ buffering: false });
  // A failure while paused must never force playback: the retry used to load
  // with autoplay=true and start audio the user had stopped (also the landing
  // spot for play() promises aborted by an immediate pause). The next play
  // re-attempts the load from the top.
  if (!state.playing) return;
  if (retryCount < 1) {
    retryCount += 1;
    void loadUrl(track, true, true);
    return;
  }
  consecutiveFailures += 1;
  // A local: track that resolves to nothing means ByTune lost the file's
  // folder — a data reset, a fresh sign-in on this device, or the drive is
  // away. The entries survive in synced playlists, and re-importing the
  // folder relinks them (ids are hashes of the file's absolute path).
  const isLocal = !!track.localPath || track.id.startsWith("local:");
  const localGoneMsg = `Couldn't play "${track.title}" — its local file can't be reached on this device. Re-add the folder in Local Music to relink your songs.`;
  if (state.playing && consecutiveFailures <= MAX_SKIPS) {
    console.warn(`[bytune] playback failed for ${track.id}`, err);
    if (isLocal) {
      // One explainer per failing streak — a whole playlist of unlinked
      // locals must not stack five identical toasts.
      if (!localMissingToasted) {
        localMissingToasted = true;
        useUI.getState().toast(localGoneMsg, "warning", 7000);
      }
    } else {
      useUI.getState().toast(`Couldn't play "${track.title}" — skipping`, "error");
    }
    state.next(false);
  } else {
    usePlayer.setState({ playing: false, error: "Playback failed" });
    if (isLocal) {
      localMissingToasted = false;
      useUI.getState().toast(localGoneMsg, "warning", 7000);
    } else {
      useUI.getState().toast(`Couldn't play "${track.title}"`, "error");
    }
  }
}

/* ------------------------- MediaSession ------------------------- */

let lastPositionState = 0;

function updateMediaSession(track: Track | null): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || "ByTune",
      artwork: [96, 192, 512].map((size) => ({
        src: upgradeArtwork(track.thumb),
        sizes: `${size}x${size}`,
        type: "image/jpeg",
      })),
    });
  } catch {
    /* ignore */
  }
}

function syncPositionState(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const a = el();
  if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
  // Throttle: SMTC only needs coarse updates.
  if (Math.abs(a.currentTime - lastPositionState) < 0.75) return;
  lastPositionState = a.currentTime;
  try {
    navigator.mediaSession.setPositionState({
      duration: a.duration,
      playbackRate: a.playbackRate || 1,
      position: Math.min(a.currentTime, a.duration),
    });
  } catch {
    /* ignore */
  }
}

function setupMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (name: MediaSessionAction, fn: MediaSessionActionHandler): void => {
    try {
      ms.setActionHandler(name, fn);
    } catch {
      /* unsupported action */
    }
  };
  set("play", () => usePlayer.getState().setPlaying(true));
  set("pause", () => usePlayer.getState().setPlaying(false));
  set("previoustrack", () => usePlayer.getState().prev());
  set("nexttrack", () => usePlayer.getState().next(true));
  set("seekbackward", () => {
    const s = usePlayer.getState();
    s.seek(Math.max(0, s.position - 10));
  });
  set("seekforward", () => {
    const s = usePlayer.getState();
    s.seek(s.position + 10);
  });
  set("seekto", (details) => {
    if (details.seekTime != null) usePlayer.getState().seek(details.seekTime);
  });
  window.setInterval(syncPositionState, 1000);
}
