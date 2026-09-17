/* Deterministic deadline/mirror-order checks with a mocked fetch.
 * Run: node scripts/lyrics-latency-mocked.mjs
 *
 * A — one fast provider, the rest hang: fetchLyrics must return at the ~1.5s
 *     deadline with the fast answer (the old all-settled wait hung forever).
 * B — nothing answers before the deadline (every host replies at 2.5s or
 *     later): the sweep must KEEP WAITING instead of truncating to an empty
 *     pick that would be cached as a ten-minute miss, and the real answer
 *     must arrive intact once the field settles.
 * C — LyricsPlus mirror 0 answers null slowly, mirror 1 answers valid lines
 *     fast: LyricsPlus must land inside the deadline (the old code awaited
 *     mirror 0 first and missed the fast winner).
 */
const lrc = Array.from({ length: 40 }, (_, i) => {
  const t = 5 + i * 4.5;
  const mm = String(Math.floor(t / 60)).padStart(2, "0");
  const ss = (t % 60).toFixed(2).padStart(5, "0");
  return `[${mm}:${ss}]line ${i + 1}`;
}).join("\n");

const lrclibRecord = {
  id: 1,
  trackName: "Test Song",
  artistName: "Test Artist",
  albumName: "Test Album",
  duration: 200,
  instrumental: false,
  plainLyrics: "line 1\nline 2",
  syncedLyrics: lrc,
};

const JSON_OK = () => ({ status: 200, ok: true, text: async () => JSON.stringify(lrclibRecord) });
const hang = () => new Promise(() => {});
const slow = (ms, ok, body) => () =>
  new Promise((r) => setTimeout(() => r({ status: ok ? 200 : 404, ok, text: async () => body }), ms));

const plusBody = JSON.stringify({
  lyrics: Array.from({ length: 40 }, (_, i) => ({
    time: (5 + i * 4.5) * 1000,
    duration: 4000,
    text: `line ${i + 1}`,
    syllabus: [{ time: (5 + i * 4.5) * 1000, duration: 1000, text: "line" }],
  })),
});

/* Scenario config (ms; null = hang forever):
 *   lrclib — delay for lrclib.net (valid record)
 *   plus0 / plus1 — delays for the first / second LyricsPlus mirror seen
 *                   (plus0 answers 404, plus1 answers valid lines)
 *   others — delay for every other provider host (404) */
async function runScenario(name, { lrclib, plus0, plus1, others }, expect) {
  const plusSeen = new Map();
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.startsWith("https://lrclib.net")) {
      return lrclib == null ? hang() : new Promise((r) => setTimeout(() => r(JSON_OK()), lrclib));
    }
    if (u.includes("lyricsplus")) {
      const host = new URL(u).host;
      if (!plusSeen.has(host)) plusSeen.set(host, plusSeen.size);
      const idx = plusSeen.get(host);
      const delay = idx === 0 ? plus0 : idx === 1 ? plus1 : null;
      if (delay == null) return hang();
      return new Promise((r) =>
        setTimeout(() => r(idx === 1 ? { status: 200, ok: true, text: async () => plusBody } : { status: 404, ok: false, text: async () => "" }), delay)
      );
    }
    return others == null ? hang() : slow(others, false, "")(u);
  };
  const { fetchLyrics } = await import("../.test-build/lyrics-test.mjs");
  const t0 = performance.now();
  const r = await fetchLyrics(
    { id: "abc123XYZ_-", title: "Test Song", artist: "Test Artist", album: "Test Album", duration: 200 },
    { prioritizeWordSync: true },
    async () => null
  );
  const ms = performance.now() - t0;
  const ok = ms >= expect.minMs && ms <= expect.maxMs && r?.source === expect.source && (r?.synced?.length ?? 0) > 0;
  console.log(
    `${name}: ${ms.toFixed(0)}ms source=${r?.source} lines=${r?.synced?.length} — ${ok ? "PASS" : `FAIL (expected ${expect.minMs}-${expect.maxMs}ms from ${expect.source})`}`
  );
  return ok;
}

const a = await runScenario(
  "A fast-provider-at-deadline",
  { lrclib: 200, plus0: null, plus1: null, others: null },
  { minMs: 1400, maxMs: 2100, source: "LRCLIB" }
);
const b = await runScenario(
  "B all-slow-keeps-waiting",
  { lrclib: 2500, plus0: 2500, plus1: 2500, others: 2500 },
  // Nothing lands by the 1.5s deadline, so the old all-settled wait applies;
  // the last chains settle ~5s (two sequential 2.5s calls). The point: the
  // answer arrives intact, never truncated to a cached miss.
  { minMs: 2400, maxMs: 6000, source: "LyricsPlus" }
);
const c = await runScenario(
  "C mirror-completion-order",
  { lrclib: null, plus0: 4000, plus1: 200, others: null },
  { minMs: 1400, maxMs: 2100, source: "LyricsPlus" }
);

process.exit(a && b && c ? 0 : 1);
