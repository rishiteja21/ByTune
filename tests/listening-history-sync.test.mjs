import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

/** Load the real stats module against a real persist layer. Reuses `dir` when given. */
async function loadStats(dir) {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bytune-history-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/stats.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, Buffer, setTimeout, clearTimeout,
    require: (name) => name === "electron" ? { app: { getPath: () => root } } : require(name),
  });
  const storeFile = () => path.join(root, "data", "listening-history.json");
  return {
    api: module.exports, dir: root, storeFile,
    // resetStats first: it clears the debounced flush timer, so a later test
    // never sees a write land in a directory this test already removed.
    close: () => { module.exports.resetStats(); if (!dir) fs.rmSync(root, { recursive: true, force: true }); },
  };
}
const track = (id, extra = {}) => ({ id, title: `t-${id}`, artist: "Artist", duration: 60, thumb: "", ...extra });
const bucket = (month, ms, extra = {}) => ({
  month,
  tracks: { a: { title: "t-a", artist: "Artist", thumb: "", ms, plays: 1, lastAt: 1 } },
  artists: { artist: { name: "Artist", ms, plays: 1 } },
  albums: {},
  hours: new Array(24).fill(0),
  days: { [`${month}-01`]: ms },
  ...extra,
});

test("listening lands in the listening-history store, not loose stats files", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("x"), 30_000);
    h.api.flushSync();
    assert.equal(fs.existsSync(path.join(h.dir, "data", "stats")), false);
    const raw = JSON.parse(fs.readFileSync(h.storeFile(), "utf-8"));
    assert.equal(raw.state.buckets.length, 1);
    assert.equal(raw.state.buckets[0].tracks.x.ms, 30_000);
  } finally { h.close(); }
});

test("Replay survives a reload and follows the account-scoped store", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("x"), 45_000);
    h.api.flushSync();
    // A fresh module instance over the same userData — what an account switch
    // or app restart sees.
    const again = await loadStats(h.dir);
    try {
      again.api.initStats();
      assert.equal(again.api.summary("month").totalMs, 45_000);
      assert.equal(again.api.summary("month").plays, 1);
    } finally { again.close(); }
  } finally { h.close(); }
});

test("reloadStore drops the in-memory copy so a restore can never be overwritten", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("local"), 10_000);
    h.api.flushSync();
    // A restore replaces the file behind the module's back…
    fs.writeFileSync(h.storeFile(), JSON.stringify({ state: { buckets: [bucket("2099-01", 5_000)] }, version: 1 }));
    h.api.reloadStore();
    assert.equal(h.api.summary("all").totalMs, 5_000);
    h.api.flushSync();
    // …and the next flush must not write the stale copy back over it.
    const raw = JSON.parse(fs.readFileSync(h.storeFile(), "utf-8"));
    assert.deepEqual(raw.state.buckets.map((b) => b.month), ["2099-01"]);
  } finally { h.close(); }
});

test("importAll (cloud restore / backup import) replaces every bucket", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("old"), 10_000);
    h.api.importAll([bucket("2098-12", 7_000)]);
    assert.deepEqual([...h.api.summary("all").months].map(String), ["2098-12"]);
    h.api.flushSync();
    const writtenMonths = JSON.parse(fs.readFileSync(h.storeFile(), "utf-8")).state.buckets.map((b) => String(b.month));
    assert.deepEqual(writtenMonths, ["2098-12"]);
  } finally { h.close(); }
});
test("fitForSync drops the oldest months until the payload fits the cloud cap", async () => {
  const big = (month) => ({ ...bucket(month, 1), tracks: Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [`t${i}`, { title: "x".repeat(2000), artist: "Artist", thumb: "", ms: 1, plays: 1, lastAt: 1 }])) });
  const months = Array.from({ length: 36 }, (_, i) => `20${String(60 + i).padStart(2, "0")}-01`);
  const payload = { state: { buckets: months.map(big) }, version: 1 };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 6 * 1024 * 1024, "fixture must exceed the budget");
  // fitForSync is pure — build it with persist stubbed out so no store is touched.
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/stats.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "stub-persist", setup(b) {
      b.onResolve({ filter: /^\.\/persist$/ }, () => ({ path: "persist", namespace: "stub" }));
      // fitForSync is pure; keep the electron import from resolving for real.
      b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
        contents: a.path === "electron"
          ? 'export const app = { getPath: () => { throw new Error("no filesystem"); } };'
          : 'export const readData = () => null; export const writeData = async () => {}; export const writeDataSync = () => {};',
        loader: "js" }));
    }}],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, Buffer, setTimeout, clearTimeout, require,
    process: { env: {}, version: "v0" }, __dirname: "/", __filename: "/stats.cjs", global: {},
  });
  const out = module.exports.fitForSync(payload);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 6 * 1024 * 1024);
  const kept = out.state.buckets.map((b) => String(b.month));
  assert.ok(kept.length < months.length, "something had to go");
  // What remains is always the NEWEST suffix — the oldest months go first.
  assert.deepEqual(kept, months.slice(-kept.length));
});

test("legacy monthly stats files are recovered into the store once, then consumed", async () => {
  const h = await loadStats();
  try {
    const legacyDir = path.join(h.dir, "data", "stats");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "2026-09.json"), JSON.stringify(bucket("2026-09", 12_345)));
    fs.writeFileSync(path.join(legacyDir, "2026-08.json"), JSON.stringify(bucket("2026-08", 6_789)));
    fs.writeFileSync(path.join(legacyDir, "broken.json"), "{not json");
    h.api.initStats();
    assert.equal(h.api.summary("all").totalMs, 12_345 + 6_789);
    assert.deepEqual([...h.api.summary("all").months].map(String), ["2026-08", "2026-09"]);
    h.api.flushSync();
    // Consumed: a later reset that empties the store must not resurrect them.
    assert.equal(fs.existsSync(legacyDir), false);
    h.api.reloadStore();
    assert.equal(h.api.summary("all").totalMs, 12_345 + 6_789, "the store holds the recovered months");
  } finally { h.close(); }
});

test("live months win over an older legacy snapshot", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("fresh"), 1_000);
    h.api.flushSync();
    // A legacy file for an older month, with a much larger total. A fresh
    // module over the same userData is what the next launch sees.
    const legacyDir = path.join(h.dir, "data", "stats");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "2026-09.json"), JSON.stringify(bucket("2026-09", 999_999)));
    const again = await loadStats(h.dir);
    try {
      again.api.initStats();
      assert.equal(again.api.summary("month").totalMs, 1_000, "the live month is not regressed");
      assert.equal(again.api.summary("all").totalMs, 1_000 + 999_999, "the older month is still recovered");
      assert.equal(fs.existsSync(legacyDir), false, "consumed once imported");
    } finally { again.close(); }
  } finally { h.close(); }
});

test("a nested legacy snapshot from an older userData layout is recovered too", async () => {
  const h = await loadStats();
  try {
    const nested = path.join(h.dir, "data", "data", "stats");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "2026-07.json"), JSON.stringify(bucket("2026-07", 4_000)));
    h.api.initStats();
    assert.equal(h.api.summary("all").totalMs, 4_000);
    assert.equal(fs.existsSync(nested), false);
  } finally { h.close(); }
});

test("recovered months survive a reload racing in right after migration", async () => {
  const h = await loadStats();
  try {
    const legacyDir = path.join(h.dir, "data", "stats");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "2026-09.json"), JSON.stringify(bucket("2026-09", 88_000)));
    // initStats migrates; immediately afterwards the boot sync may restore a
    // cloud row, which re-reads the store from disk.
    h.api.initStats();
    h.api.reloadStore();
    assert.equal(h.api.summary("all").totalMs, 88_000, "the recovery landed on disk before any reload");
    // And a later flush of new listening must not wipe the recovered month.
    h.api.recordListening(track("fresh"), 5_000);
    h.api.flushSync();
    h.api.reloadStore();
    assert.equal(h.api.summary("all").totalMs, 93_000);
    assert.deepEqual([...h.api.summary("all").months].map(String), ["2026-09", "2026-10"]);
  } finally { h.close(); }
});

test("recovered months are announced to the sync engine so they upload", async () => {
  const h = await loadStats();
  try {
    const announced = [];
    h.api.onStoreWrite(() => announced.push("write"));
    const legacyDir = path.join(h.dir, "data", "stats");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "2026-09.json"), JSON.stringify(bucket("2026-09", 12_000)));
    // The write hook is registered BEFORE initStats, exactly as main.ts does.
    h.api.initStats();
    assert.ok(announced.length > 0, "recovery must mark the store as changed");
    // No announcement when there is nothing to recover.
    const again = await loadStats(h.dir);
    try {
      const quiet = [];
      again.api.onStoreWrite(() => quiet.push("write"));
      again.api.initStats();
      assert.equal(quiet.length, 0, "nothing to recover means nothing announced");
    } finally { again.close(); }
  } finally { h.close(); }
});

test("listening records cover art for albums and artist photos for artists", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(
      { id: "s1", title: "S", artist: "Adele", album: "30", duration: 60, thumb: "https://x/song.jpg", artistImage: "https://x/adele.jpg" },
      40_000
    );
    h.api.recordListening({ id: "s2", title: "S2", artist: "Adele", album: "30", duration: 60, thumb: "https://x/song2.jpg" }, 40_000);
    const all = h.api.summary("all");
    assert.equal(all.albums[0].thumb, "https://x/song.jpg", "first seen cover wins");
    assert.equal(all.artists.find((a) => a.name === "Adele")?.thumb, "https://x/adele.jpg", "artist photo recorded");
    // Round-trips through the store (what the cloud copy is built from).
    h.api.flushSync();
    const again = await loadStats(h.dir);
    try {
      again.api.initStats();
      assert.equal(again.api.summary("all").albums[0].thumb, "https://x/song.jpg");
    } finally { again.close(); }
  } finally { h.close(); }
});
