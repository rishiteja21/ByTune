/* Live timing check: uncached fetch vs the main-process lyric cache.
 * Run: node scripts/lyrics-latency-live.mjs */
import { getLyrics } from "../.test-build/music-service-test.mjs";

const track = {
  id: "JGwWNGJdvx8",
  title: "Shape of You",
  artist: "Ed Sheeran",
  album: "÷ (Divide)",
  duration: 234,
};

const t0 = performance.now();
const first = await getLyrics(track);
const uncachedMs = performance.now() - t0;
console.log(
  `UNCACHED: ${uncachedMs.toFixed(0)}ms — source=${first?.source} wordSynced=${first?.wordSynced} lines=${first?.synced?.length} plain=${!!first?.plain}`
);

const t1 = performance.now();
const second = await getLyrics(track);
const cachedMs = performance.now() - t1;
console.log(
  `CACHED:   ${cachedMs.toFixed(0)}ms — source=${second?.source} lines=${second?.synced?.length}`
);

const ok = uncachedMs < 2500 && cachedMs < 50;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
