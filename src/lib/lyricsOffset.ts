/**
 * Lyric alignment offsets — audio-anchored sync for version-mismatched tracks.
 *
 * Synced lyrics are timed to a catalogue recording, but the audio actually
 * playing is a YouTube upload that may prepend (or append to) it — music
 * videos with a scene-setting intro are the classic case. No lyrics provider
 * carries the upload's own timing, so we measure it from the audio itself:
 * when the lyrics' implied song is much shorter than the upload, the track's
 * stream is decoded once and the first sustained music-level energy is taken
 * as the offset between the two timelines. Every lyric lookup then runs on
 * (element position − offset).
 */
import { create } from "zustand";
import { detectMusicOnsetForTrack } from "./analysis";

interface LyricsAlignState {
  /** track id → seconds to subtract from the element position for lyrics */
  offsets: Record<string, number>;
  setOffset(id: string, offset: number): void;
}

export const useLyricsAlign = create<LyricsAlignState>((set) => ({
  offsets: {},
  setOffset: (id, offset) =>
    set((s) => (s.offsets[id] === offset ? s : { offsets: { ...s.offsets, [id]: offset } })),
}));

/** Live offset for a track — 0 until (and unless) a mismatch is measured. */
export function getLyricsOffset(id: string | null | undefined): number {
  if (!id) return 0;
  return useLyricsAlign.getState().offsets[id] ?? 0;
}

/** Suspect a version mismatch when the upload runs this far past the lyrics. */
const MISMATCH_THRESHOLD_SEC = 10;
/** Offsets below this are indistinguishable from "song starts immediately". */
const MIN_APPLIED_OFFSET = 2.5;

const pending = new Set<string>();

/**
 * Best-effort: when the played upload is much longer than the synced lyrics'
 * song, decode the stream and anchor the lyrics to where the music actually
 * starts. Skips local files and tracks with no usable duration.
 */
export function requestLyricsAlignment(trackId: string, videoDuration: number, lyricsEnd: number): void {
  if (!trackId || trackId.startsWith("local:")) return;
  if (useLyricsAlign.getState().offsets[trackId] != null) return;
  if (pending.has(trackId)) return;
  if (!(videoDuration > 0 && lyricsEnd > 0) || videoDuration - lyricsEnd < MISMATCH_THRESHOLD_SEC) return;
  pending.add(trackId);
  void (async () => {
    try {
      const onset = await detectMusicOnsetForTrack(trackId);
      if (onset == null) return;
      // Skip-silence may already seek the element past leading silence; the
      // offset lives in element time, so that trim is subtracted out.
      const { getHeadTrim } = await import("./audio");
      const offset = Math.max(0, onset - getHeadTrim(trackId));
      useLyricsAlign.getState().setOffset(trackId, offset >= MIN_APPLIED_OFFSET ? offset : 0);
    } catch {
      /* alignment is best-effort */
    } finally {
      pending.delete(trackId);
    }
  })();
}
