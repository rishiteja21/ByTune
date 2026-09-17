/**
 * Audio rendition selection — the pure half of stream resolution, kept free
 * of Electron/Innertube imports so it can be unit-tested directly (see
 * tests/format-pick.test.mjs).
 */

export async function formatUrl(format: any, yt: any): Promise<string | null> {
  if (typeof format?.url === "string" && format.url) return format.url;
  try {
    if (typeof format?.decipher === "function" && yt?.session?.player) {
      const out = await format.decipher(yt.session.player);
      if (typeof out === "string" && out) return out;
      if (typeof format?.url === "string" && format.url) return format.url;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Audio rendition ranking — YouTube's music ladder:
 *   141: 256k AAC-LC · 251: ~160k Opus · 140: 128k AAC-LC · 250: ~95k Opus
 *   249: ~50k Opus · 139: 48k HE-AAC.
 * Opus 251 beats AAC 140 on both bitrate and codec efficiency; the old rule
 * that preferred the mp4 container silently downgraded every stream from
 * Opus to 128k AAC — the audible quality gap vs Spotify. Known itags rank
 * first; unknown formats fall back to raw bitrate order.
 */
const AUDIO_ITAG_RANK: Record<number, number> = {
  141: 6,
  251: 5,
  140: 4,
  250: 3,
  249: 2,
  139: 1,
};

export function audioScore(f: any): number {
  const rank = AUDIO_ITAG_RANK[f?.itag] ?? 0;
  return rank * 1e9 + (f?.bitrate ?? 0);
}

/**
 * Integrated loudness of a format in LUFS. Prefer the absolute LKFS YouTube
 * reports; the relative `loudnessDb` is the attenuation YouTube's own player
 * applies to reach its -14 LUFS target, so `loudnessDb - 14` recovers the
 * same number. Verified against live responses: every format of a track
 * carries the identical value, so any candidate answers the question.
 */
export function formatLufs(f: any): number | null {
  const abs = f?.track_absolute_loudness_lkfs;
  if (typeof abs === "number" && Number.isFinite(abs)) return abs;
  const db = f?.loudness_db;
  if (typeof db === "number" && Number.isFinite(db)) return db - 14;
  return null;
}

export interface PickedAudio {
  url: string;
  mime: string;
  lufs: number | null;
}

export async function pickAudio(
  info: any,
  yt: any,
  maxKbps?: number,
  mp4Only = false
): Promise<PickedAudio | null> {
  const sd = info?.streaming_data;
  if (!sd) return null;
  const audioOnly: any[] = (sd.adaptive_formats ?? []).filter(
    (f: any) => f?.has_audio && !f?.has_video
  );
  let candidates = audioOnly;
  if (!candidates.length) {
    const progressive: any[] = (sd.formats ?? []).filter((f: any) => f?.has_audio && !f?.has_video);
    candidates = progressive;
  }
  if (!candidates.length && typeof sd.url === "string")
    return { url: sd.url, mime: String(sd.mime_type ?? "audio/mp4"), lufs: null };
  if (!candidates.length) return null;
  candidates.sort((a, b) => audioScore(b) - audioScore(a));
  // Quality ceiling: best rendition at/below the cap; if only higher ones
  // exist, take the best rather than refusing — a capped track beats silence.
  if (maxKbps && maxKbps > 0) {
    const capped = candidates.filter((f) => (f.bitrate ?? 0) / 1000 <= maxKbps);
    if (capped.length) candidates = capped;
  }
  // Downloads ask for mp4Only: an AAC `.m4a` is the most portable file across
  // devices and players. If a track somehow has no mp4 rendition, we still
  // download the best available rather than failing — the caller names the
  // file from the returned mime.
  if (mp4Only) {
    const mp4s = candidates.filter((f) => String(f.mime_type ?? "").includes("mp4"));
    if (mp4s.length) candidates = mp4s;
  }
  const preferred = candidates[0];
  const url = await formatUrl(preferred, yt);
  if (!url) return null;
  return { url, mime: String(preferred.mime_type ?? "audio/mp4"), lufs: formatLufs(preferred) };
}
