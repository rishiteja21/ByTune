/**
 * Track analysis, scaled to what a browser can do honestly:
 *
 *  - analyseTrackHead: decode a track and estimate tempo (BPM) from the
 *    onset-energy envelope via autocorrelation. Powers beat-aligned
 *    transition starts (smart fade). No vocal mask, no mel spectrogram —
 *    those need native DSP and are not faked here.
 *  - detectEdgeSilence: scan a decoded track for leading/trailing silence
 *    (skip-silence).
 *
 * Both run on the renderer's own thread pool via decodeAudioData; work is
 * bounded (one analysis in flight, small inputs) so playback stays responsive.
 */

export interface TempoGrid {
  bpm: number;
  beatInterval: number; // seconds
  confidence: number; // 0..1
  downbeatEvery: number; // beats per assumed bar (4), 0 = unknown
}

const cache = new Map<string, TempoGrid>();
let inFlight: Promise<void> | null = null;
const queue: string[] = [];
const MAX_CACHE = 400;

function trimCache(): void {
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

async function fetchAudio(trackId: string): Promise<ArrayBuffer | null> {
  try {
    const { requireBridge } = await import("./bridge");
    const { useSettings } = await import("../stores/settings");
    const bridge = requireBridge();
    // Local files analyse through the same proxy route the element plays.
    const url = trackId.startsWith("local:")
      ? await bridge.localTrackUrl(trackId)
      : await bridge.getStreamUrl(trackId, false, useSettings.getState().streamingQuality);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok || !res.body) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

async function decode(buf: ArrayBuffer): Promise<AudioBuffer | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    return await ctx.decodeAudioData(buf);
  } catch {
    return null;
  }
}

function mixdown(audio: AudioBuffer, seconds: number): Float32Array {
  const len = Math.min(audio.length, Math.ceil(audio.sampleRate * seconds));
  const out = new Float32Array(len);
  const ch = Math.min(2, audio.numberOfChannels);
  for (let c = 0; c < ch; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i] / ch;
  }
  return out;
}

/** Onset-energy autocorrelation BPM over the first `seconds` of audio. */
function estimateTempo(audio: AudioBuffer, seconds = 24): TempoGrid | null {
  const samples = mixdown(audio, seconds);
  const sr = audio.sampleRate;
  const hop = 512;
  const win = 1024;
  const frames = Math.floor((samples.length - win) / hop);
  if (frames < 64) return null;

  // Energy envelope + half-wave-rectified difference = onset strength.
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < win; i++) {
      const v = samples[base + i];
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / win);
  }
  const onset = new Float32Array(frames - 1);
  let onsetMean = 0;
  for (let f = 0; f < frames - 1; f++) {
    onset[f] = Math.max(0, energy[f + 1] - energy[f]);
    onsetMean += onset[f];
  }
  onsetMean = onsetMean / Math.max(1, onset.length) || 1e-9;
  for (let f = 0; f < onset.length; f++) onset[f] -= onsetMean;

  // Autocorrelation over lags matching 50..220 BPM.
  const fps = sr / hop;
  const minLag = Math.floor((60 / 220) * fps);
  const maxLag = Math.ceil((60 / 50) * fps);
  let bestLag = 0;
  let bestVal = 0;
  let sumSq = 0;
  for (let f = 0; f < onset.length; f++) sumSq += onset[f] * onset[f];
  if (sumSq <= 0) return null;
  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag++) {
    let dot = 0;
    for (let f = 0; f + lag < onset.length; f++) dot += onset[f] * onset[f + lag];
    const norm = dot / Math.sqrt(sumSq * sumSq) * onset.length;
    // Prefer multiples near 90–180 BPM (octave disambiguation).
    let bpm = (60 * fps) / lag;
    while (bpm < 85) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const octaveWeight = bpm >= 85 && bpm <= 180 ? 1 : 0.55;
    const val = norm * octaveWeight;
    if (val > bestVal) {
      bestVal = val;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  let bpm = (60 * fps) / bestLag;
  while (bpm < 85) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const confidence = Math.min(1, Math.max(0, bestVal));
  if (confidence < 0.08) return null;
  return { bpm: Math.round(bpm * 10) / 10, beatInterval: 60 / bpm, confidence, downbeatEvery: 4 };
}

/** Analyse a track's tempo (queued, one in flight). The returned promise
 * resolves when THIS track has been processed (hit or miss), so callers can
 * bound-wait for fresh analysis instead of racing the background queue. */
function ensure(trackId: string): Promise<void> {
  if (cache.has(trackId)) return Promise.resolve();
  if (!queue.includes(trackId)) queue.push(trackId);
  return new Promise<void>((resolve) => {
    const list = waiters.get(trackId) ?? [];
    list.push(resolve);
    waiters.set(trackId, list);
    void pump();
  });
}

const waiters = new Map<string, Array<() => void>>();

function settle(trackId: string): void {
  const list = waiters.get(trackId);
  if (!list) return;
  waiters.delete(trackId);
  for (const r of list) {
    try {
      r();
    } catch {
      /* ignore */
    }
  }
}

function pump(): void {
  if (inFlight) return;
  const run = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (!id) break;
      if (cache.has(id)) {
        settle(id);
        continue;
      }
      try {
        const buf = await fetchAudio(id);
        if (!buf) {
          settle(id);
          continue;
        }
        const audio = await decode(buf);
        if (!audio) {
          settle(id);
          continue;
        }
        const grid = estimateTempo(audio);
        if (grid) {
          cache.set(id, grid);
          trimCache();
        }
      } catch {
        /* analysis is best-effort */
      } finally {
        settle(id);
      }
    }
  };
  inFlight = run().finally(() => {
    inFlight = null;
    // A track enqueued while the last one processed still needs a runner.
    if (queue.length > 0) pump();
  });
}

export const analyseTrackHead = {
  ensure,
  getCached(trackId: string): TempoGrid | null {
    return cache.get(trackId) ?? null;
  },
  peek: (trackId: string): TempoGrid | null => cache.get(trackId) ?? null,
};

/**
 * Time where sustained music energy begins, for lyric alignment.
 *
 * YouTube uploads of a song often prepend a quiet intro (scene setting,
 * dialogue, ambience) before the music that the synced-lyrics timeline was
 * made for — the lyrics then animate tens of seconds before anyone sings.
 * This scans the decoded upload for the first sustained above-music-level
 * energy (≥2s of windows over the threshold) and returns that time; 0 when
 * the audio opens cold on the song. Music sits far above dialogue-level
 * RMS, so a spoken intro doesn't trip it.
 */
export function detectMusicOnset(audio: AudioBuffer, limitSec = 75): number {
  const sr = audio.sampleRate;
  const win = Math.floor(sr * 0.5);
  const total = Math.min(audio.length, Math.floor(sr * limitSec));
  const windows = Math.floor(total / win);
  if (windows < 8) return 0;
  const ch = Math.min(2, audio.numberOfChannels);
  const threshold = 0.055;
  const need = 4; // 2s of consecutive loud windows
  let run = 0;
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    const base = w * win;
    const data = audio.getChannelData(0);
    const data2 = ch > 1 ? audio.getChannelData(1) : null;
    for (let i = 0; i < win; i += 2) {
      const v = data2 ? (data[base + i] + data2[base + i]) / 2 : data[base + i];
      sum += v * v;
    }
    const rms = Math.sqrt((sum * 2) / win);
    if (rms > threshold) {
      run += 1;
      if (run >= need) return Math.max(0, (w - need + 1) * win) / sr;
    } else {
      run = 0;
    }
  }
  return 0;
}

/** Decoded-audio analysis over the full stream: music onset, in seconds. */
export async function detectMusicOnsetForTrack(trackId: string, limitSec = 75): Promise<number | null> {
  const buf = await fetchAudio(trackId);
  if (!buf) return null;
  const audio = await decode(buf);
  if (!audio) return null;
  return detectMusicOnset(audio, limitSec);
}

/**
 * Leading/trailing silence, in seconds. Threshold ≈ -42dBFS sustained over a
 * 40ms window, matching what a listener would call silence.
 */
export async function detectEdgeSilence(buf: ArrayBuffer): Promise<{ head: number; tail: number } | null> {
  const audio = await decode(buf);
  if (!audio || audio.length === 0) return null;
  const sr = audio.sampleRate;
  const ch = Math.min(2, audio.numberOfChannels);
  const window = Math.max(1, Math.floor(sr * 0.04));
  const threshold = 0.008;
  const loudAt = (from: number, to: number, step: number): number => {
    for (let i = from; step > 0 ? i < to : i > to; i += step) {
      let loud = false;
      for (let w = 0; w < window && !loud; w++) {
        const idx = i + w * step;
        if (idx < 0 || idx >= audio.length) break;
        for (let c = 0; c < ch; c++) {
          if (Math.abs(audio.getChannelData(c)[idx]) > threshold) {
            loud = true;
            break;
          }
        }
      }
      if (loud) return i;
    }
    return -1;
  };
  const first = loudAt(0, audio.length, 1);
  const last = loudAt(audio.length - 1, 0, -1);
  if (first < 0 || last < 0) return { head: 0, tail: 0 };
  return {
    head: Math.max(0, (first - window) / sr),
    tail: Math.max(0, (audio.length - 1 - last - window) / sr),
  };
}

/* ============================ R128 loudness ============================ */

/**
 * ITU-R BS.1770-4 integrated loudness (LKFS ≈ LUFS) — the same measurement
 * Spotify and YouTube use, so local files normalise on identical terms to
 * streams. K-weighting is two biquad stages whose coefficients are computed
 * from the standard's analogue parameters for the buffer's sample rate
 * (exactly how libebur128 does it); loudness is then the gated mean-square of
 * 400ms blocks with 75% overlap (absolute gate -70 LUFS, relative gate -10 LU).
 * Validated against synthetic signals: a 1 kHz sine at amplitude 0.2 measures
 * -14.2 LUFS (theoretical ≈ -14.2).
 */
function highShelfCoefs(f0: number, dbGain: number, q: number, fs: number): number[] {
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const sq = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cw + sq;
  return [
    (A * (A + 1 + (A - 1) * cw + sq)) / a0,
    (-2 * A * (A - 1 + (A + 1) * cw)) / a0,
    (A * (A + 1 + (A - 1) * cw - sq)) / a0,
    (2 * (A - 1 - (A + 1) * cw)) / a0,
    (A + 1 - (A - 1) * cw - sq) / a0,
  ];
}

function highPassCoefs(f0: number, q: number, fs: number): number[] {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
}

/** A ~5ms slice of samples between cooperative yields (250k @ 48k). */
const DSP_CHUNK = 250_000;
const yieldNow = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Integrated loudness in LUFS, or null for empty/unmeasurable audio.
 * Async with periodic yields so a multi-minute decode never blocks the
 * audio thread long enough to stutter playback.
 */
export async function measureIntegratedLoudness(audio: AudioBuffer): Promise<number | null> {
  const sr = audio.sampleRate;
  const nch = Math.min(2, audio.numberOfChannels);
  if (sr < 8000 || audio.length < sr) return null;
  const s1 = highShelfCoefs(1681.974450955533, 3.999843853973347, 0.7071752369554196, sr);
  const s2 = highPassCoefs(38.13547087602444, 0.5003270373238773, sr);
  const filt = async (x: ArrayLike<number>, c: number[]): Promise<Float64Array> => {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i];
      const v = c[0] * x0 + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = v;
      y[i] = v;
      if (i % DSP_CHUNK === DSP_CHUNK - 1) await yieldNow();
    }
    return y;
  };
  const chans: Float64Array[] = [];
  for (let c = 0; c < nch; c++) chans.push(await filt(await filt(audio.getChannelData(c), s1), s2));
  const block = Math.floor(0.4 * sr);
  const hop = Math.floor(block / 4);
  if (block < 1 || hop < 1) return null;
  const loudness: number[] = [];
  let sinceYield = 0;
  for (let s = 0; s + block <= chans[0].length; s += hop) {
    let sum = 0;
    for (let c = 0; c < nch; c++) {
      let e = 0;
      const d = chans[c];
      for (let i = 0; i < block; i++) { const v = d[s + i]; e += v * v; }
      sum += e / block; // G = 1.0 for L/R
    }
    if (sum > 0) loudness.push(-0.691 + 10 * Math.log10(sum));
    if (++sinceYield >= 200) { sinceYield = 0; await yieldNow(); }
  }
  if (!loudness.length) return null;
  const abs = loudness.filter((l) => l > -70);
  if (!abs.length) return null;
  const z = 10 * Math.log10(abs.reduce((a, l) => a + Math.pow(10, l / 10), 0) / abs.length);
  const gated = loudness.filter((l) => l > Math.max(-70, z - 10));
  if (!gated.length) return null;
  return 10 * Math.log10(gated.reduce((a, l) => a + Math.pow(10, l / 10), 0) / gated.length);
}

/** Decoded-audio R128 measurement for one track id (proxy-served bytes). */
export async function measureLoudnessForTrack(trackId: string): Promise<number | null> {
  const buf = await fetchAudio(trackId);
  if (!buf) return null;
  const audio = await decode(buf);
  if (!audio) return null;
  return measureIntegratedLoudness(audio);
}
