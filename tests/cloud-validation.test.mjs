import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

async function fixture(rows) {
  const writes = [];
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/sync.ts", import.meta.url))], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["electron"],
    plugins: [{ name: "isolated-cloud-boundary", setup(b) {
      b.onResolve({ filter: /^\.\/(persist|supabase|data-transition)$/ }, a => ({ path: a.path, namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: a.path === "./persist"
        ? 'export const readData = () => null; export const writeData = async (...args) => globalThis.writes.push(args); export const writeDataSync = (...args) => globalThis.writes.push(args);'
        : a.path === "./supabase" ? 'export const sessionInfo = () => ({ mode: "account", userId: "test-owner" }); export const readProfile = () => null; export const authenticatedUserId = () => "test-owner";'
        : 'export const serializeData = (fn) => Promise.resolve().then(fn);', loader: "js" }));
    }}],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, writes, Buffer, console, setTimeout, clearTimeout,
    require: n => n === "electron" ? { app: { getPath: () => { throw new Error("Unexpected filesystem access"); } } } : require(n) });
  module.exports.bindClient(() => ({ from: () => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }));
  return { api: module.exports, writes };
}
const row = (payload, store_name = "library") => ({ store_name, payload, updated_at: "2026-01-01T00:00:00Z" });
const track = (id, extra = {}) => ({ id, title: "Song", artist: "Artist", thumb: "", duration: 180, ...extra });
const written = (writes, name) => writes.find(([n]) => n === name);
// Values written by the bundled module are cross-realm objects: compare by
// structure through JSON, never by identity.
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A payload that must never be persisted: the ROW is dropped, siblings survive. */
const unusableRows = [
  ["array state", { state: [] }],
  ["oversized string", { state: { extra: "x".repeat(8 * 1024 * 1024 + 1) } }],
  ["prototype key", JSON.parse('{"state":{"__proto__":{"polluted":true}}}')],
  ["invalid envelope", null],
];
for (const method of ["syncNow", "restoreNow"]) {
  for (const [name, payload] of unusableRows) test(`${method} drops a row with ${name} and persists nothing from it`, async () => {
    const h = await fixture([row({ state: {} }, "settings"), row(payload)]);
    await h.api[method]();
    assert.equal(written(h.writes, "library"), undefined);
    assert.equal({}.polluted, undefined);
  });

  test(`${method} drops a row with an unknown store name and restores the known ones`, async () => {
    const h = await fixture([row({ state: {} }, "settings"), row({ state: {} }, "player")]);
    await h.api[method]();
    assert.equal(written(h.writes, "player"), undefined);
    assert.ok(written(h.writes, "settings"), "known store must still restore");
  });

  test(`${method} sanitizes a library row instead of rejecting the account`, async () => {
    // Shapes the app itself has been able to write (a NaN duration serializes
    // to null; an older build could omit fields) — one bad record must not
    // brick the whole account, so bad records are dropped and good ones land.
    const payload = {
      state: {
        liked: [
          { id: "good", title: "Song", artist: "Artist", thumb: "", duration: 180 },
          { id: "nan-duration", title: "Song", artist: "Artist", thumb: "", duration: null },
          { id: "no-thumb", title: "Song", artist: "Artist", duration: 180 },
        ],
        history: [track("dup"), track("dup"), null],
        playlists: [{ id: "ok", name: "P", createdAt: 1, tracks: [{ id: "t", title: "S", artist: "A", thumb: "", duration: 1 }] }],
        downloads: { planted: { path: "C:\\evil" } },
        pinnedSingles: { liked: true, local: "yes" },
      },
      version: 1,
    };
    const h = await fixture([row(payload)]);
    await h.api[method]();
    const write = written(h.writes, "library");
    assert.ok(write, "the row must still be restored");
    assert.deepEqual(plain(write[1].state.liked.map(t => t.id)), ["good"]);
    assert.deepEqual(plain(write[1].state.history.map(t => t.id)), ["dup"]);
    assert.equal(plain(write[1].state.playlists).length, 1);
    assert.equal(plain(write[1].state.playlists[0].tracks).length, 1);
    // restoreNow re-attaches the (empty) local device registry; syncNow leaves
    // the field absent. Either way nothing of the planted copy may survive.
    assert.equal(Object.keys(write[1].state.downloads ?? {}).length, 0, "device-owned registry must never arrive");
    assert.equal(plain(write[1].state.pinnedSingles).liked, true);
    assert.equal(plain(write[1].state.pinnedSingles).local, undefined);
    assert.equal({}.polluted, undefined);
  });

  test(`${method} sanitizes settings and listening rows instead of rejecting them`, async () => {
    const h = await fixture([
      row({ state: { downloadDir: "C:\\evil", autoplay: true, crossfadeSeconds: 999, hideVolumeBar: false } }, "settings"),
      row({ state: { skips: { a: { count: 1, updatedAt: 5 }, bad: "x" }, version: "nope" } }, "listening-signals"),
    ]);
    await h.api[method]();
    assert.deepEqual(written(h.writes, "settings")[1].state, { autoplay: true, hideVolumeBar: false });
    assert.deepEqual(written(h.writes, "listening-signals")[1].state.skips, { a: { count: 1, updatedAt: 5 } });
  });

  test(`syncNow drops a row whose timestamp cannot be ordered`, async () => {
    const stale = row({ state: {} }, "library");
    delete stale.updated_at;
    const h = await fixture([stale, row({ state: {} }, "settings")]);
    await h.api.syncNow();
    assert.equal(written(h.writes, "library"), undefined);
    assert.ok(written(h.writes, "settings"));
  });
  // restoreNow replaces unconditionally, so it never needs an ordering stamp.
  test(`restoreNow restores a row even without an updated_at stamp`, async () => {
    const stale = row({ state: {} }, "library");
    delete stale.updated_at;
    const h = await fixture([stale]);
    await h.api.restoreNow();
    assert.ok(written(h.writes, "library"));
  });
}

test("valid fresh-account cloud payload restores through actual sync module", async () => {
  const payload = { state: { liked: [], playlists: [], folders: [], history: [] }, version: 1 };
  const h = await fixture([row(payload)]);
  assert.deepEqual(Array.from((await h.api.syncNow()).pulled), ["library"]);
  assert.ok(h.writes.some(([name, data]) => name === "library" && data === payload));
});
test("device-owned download registry is stripped before a restored row is written", async () => {
  const payload = {
    state: { liked: [], playlists: [], folders: [], history: [], downloads: { "t1": { status: "done", path: "C:\\Users\\x\\y.mp3" } } },
    version: 1,
  };
  const h = await fixture([row(payload)]);
  assert.deepEqual(Array.from((await h.api.syncNow()).pulled), ["library"]);
  const write = h.writes.find(([name]) => name === "library");
  assert.ok(write, "library row must be written");
  assert.equal(write[1].state.downloads, undefined);
});
test("library row validation strips downloads even on the restoreNow path", async () => {
  const payload = { state: { liked: [], playlists: [], folders: [], history: [], downloads: { "t1": {} } }, version: 1 };
  const h = await fixture([row(payload)]);
  await h.api.restoreNow();
  const write = h.writes.find(([name]) => name === "library");
  assert.ok(write, "library row must be written");
  // The planted registry is gone; what remains (an empty object) is the local
  // device registry re-attached by the restore itself, with no local store.
  // (Cross-realm object from the bundled module — compare keys, not identity.)
  assert.equal(Object.keys(write[1].state.downloads ?? {}).length, 0);
});

test("listening-history buckets keep their track rows through validation", async () => {
  // Track rows carry title/artist/thumb (not `name`) — a validator that keyed
  // every row off `name` silently deleted every song from a restored Replay.
  const payload = {
    state: {
      buckets: [{
        month: "2026-09",
        tracks: { t1: { title: "S", artist: "A", thumb: "https://x/y.jpg", ms: 1000, plays: 2, lastAt: 9 } },
        artists: { a1: { name: "A", ms: 1000, plays: 2 } },
        albums: { al: { name: "Album", artist: "A", ms: 1000, plays: 2 } },
        hours: new Array(24).fill(0),
        days: {},
      }],
    },
    version: 1,
  };
  const h = await fixture([row(payload, "listening-history")]);
  await h.api.restoreNow();
  const write = written(h.writes, "listening-history");
  assert.ok(write, "the row must restore");
  const bucket = plain(write[1].state.buckets[0]);
  assert.deepEqual(Object.keys(bucket.tracks), ["t1"], "track rows must survive");
  assert.deepEqual(Object.keys(bucket.artists), ["a1"]);
  assert.deepEqual(Object.keys(bucket.albums), ["al"]);
});

test("non-web artwork urls are stripped from Replay rows, not dropped with them", async () => {
  const payload = {
    state: {
      buckets: [{
        month: "2026-09",
        tracks: { t1: { title: "S", artist: "A", thumb: "javascript:alert(1)", ms: 1, plays: 1, lastAt: 1 } },
        artists: { a1: { name: "A", thumb: "file:///C:/evil.png", ms: 1, plays: 1 } },
        albums: { al: { name: "Album", artist: "A", thumb: "javascript:alert(1)", ms: 1, plays: 1 } },
        hours: new Array(24).fill(0),
        days: {},
      }],
    },
    version: 1,
  };
  const h = await fixture([row(payload, "listening-history")]);
  await h.api.restoreNow();
  const bucket = plain(written(h.writes, "listening-history")[1].state.buckets[0]);
  assert.equal(bucket.tracks.t1.thumb, "", "unsafe track thumb neutralized");
  assert.equal(bucket.artists.a1.thumb, "", "unsafe artist photo neutralized");
  assert.equal(bucket.albums.al.thumb, "", "unsafe album cover neutralized");
  assert.equal(bucket.tracks.t1.title, "S", "the row itself survives");
});
