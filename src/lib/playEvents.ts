/**
 * Playback event bus (renderer → main). One channel feeds the listening
 * statistics. Events carry `deltaMs` — listening time since the previous
 * event — so the main process never has to infer anything about what was
 * actually heard.
 */
import type { Track } from "../types";

export type PlayEventType = "start" | "pause" | "resume" | "stop" | "progress";

export interface PlayEvent {
  type: PlayEventType;
  track?: Track;
  /** position in the track, seconds */
  positionSec: number;
  /** total listening time accumulated on this track, seconds */
  playedSec: number;
  /** listening time since the previous event, milliseconds */
  deltaMs: number;
}

export function emitPlayEvent(
  type: PlayEventType,
  track: Track | null | undefined,
  positionSec: number,
  playedSec: number,
  deltaMs = 0
): void {
  try {
    window.bytune?.playbackEvent?.({
      type,
      track: track ?? undefined,
      positionSec,
      playedSec,
      deltaMs,
    });
  } catch {
    /* never let telemetry break playback */
  }
}
