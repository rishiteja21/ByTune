import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeArtistMeta,
  mergeLibrary,
  mergeListening,
  mergeRecentSearches,
  mergeSettings,
  mergeSyncMeta,
  stripDeviceSettings,
} from "../.test-build/sync-merge.mjs";

const env = (state) => ({ state, version: 0 });
const track = (id, extra = {}) => ({ id, title: `t-${id}`, artist: "A", ...extra });

test("library merge unions liked songs from both sides", () => {
  const local = env({ liked: [track("a")], playlists: [], history: [], downloads: {} });
  const remote = env({ liked: [track("b")], playlists: [], history: [] });
  const merged = mergeLibrary(local, remote, {});
  const ids = merged.state.liked.map((t) => t.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

test("library merge dedupes same song liked on both sides", () => {
  const local = env({ liked: [track("a", { title: "local title" })], playlists: [], history: [] });
  const remote = env({ liked: [track("a")], playlists: [], history: [] });
  const merged = mergeLibrary(local, remote, {});
  assert.equal(merged.state.liked.length, 1);
  assert.equal(merged.state.liked[0].title, "local title"); // stable canonical tie-break
  assert.deepEqual(mergeLibrary(remote, local, {}).state.liked, merged.state.liked);
});

test("library merge keeps playlists from both sides and unions same-id tracks", () => {
  const local = env({
    liked: [],
    history: [],
    downloads: {},
    playlists: [
      { id: "p1", name: "Mine", tracks: [track("a")], createdAt: 1 },
      { id: "p2", name: "Only local", tracks: [], createdAt: 2 },
    ],
  });
  const remote = env({
    liked: [],
    history: [],
    playlists: [
      { id: "p1", name: "Cloud name", tracks: [track("b")], createdAt: 1 },
      { id: "p3", name: "Only cloud", tracks: [], createdAt: 3 },
    ],
  });
  const merged = mergeLibrary(local, remote, {});
  const byId = new Map(merged.state.playlists.map((p) => [p.id, p]));
  assert.equal(byId.size, 3);
  // Legacy metadata has no edit timestamp: stable canonical tie-break.
  assert.equal(byId.get("p1").name, "Cloud name");
  assert.deepEqual(mergeLibrary(remote, local, {}).state.playlists, merged.state.playlists);
  assert.deepEqual(
    byId.get("p1").tracks.map((t) => t.id).sort(),
    ["a", "b"]
  );
  assert.ok(byId.get("p2") && byId.get("p3"));
});

test("library merge never takes downloads from the cloud", () => {
  const local = env({ liked: [], playlists: [], history: [], downloads: { x: { status: "done" } } });
  const remote = env({ liked: [], playlists: [], history: [], downloads: { y: { status: "done" } } });
  const merged = mergeLibrary(local, remote, {});
  assert.deepEqual(Object.keys(merged.state.downloads), ["x"]);
});

test("library history union is capped", () => {
  const local = env({ liked: [], playlists: [], downloads: {}, history: Array.from({ length: 150 }, (_, i) => track(`l${i}`)) });
  const remote = env({ liked: [], playlists: [], history: Array.from({ length: 150 }, (_, i) => track(`r${i}`)) });
  const merged = mergeLibrary(local, remote, {});
  assert.ok(merged.state.history.length <= 200);
  assert.equal(merged.state.history[0].id, "l0"); // legacy stable-id ordering
});

test("listening merge takes the max skip count per artist", () => {
  const local = env({ skips: { a: { count: 2, updatedAt: 5 } }, version: 3 });
  const remote = env({ skips: { a: { count: 7, updatedAt: 9 }, b: { count: 1, updatedAt: 2 } }, version: 8 });
  const merged = mergeListening(local, remote, {});
  assert.equal(merged.state.skips.a.count, 7);
  assert.equal(merged.state.skips.a.updatedAt, 9);
  assert.equal(merged.state.skips.b.count, 1);
  assert.equal(merged.state.version, 8);
});

test("recent searches union, deterministic legacy order, case-insensitive dedupe, capped at 8", () => {
  const local = env({ searches: ["bad", "we on go"] });
  const remote = env({ searches: ["Bad", "other", "x1", "x2", "x3", "x4", "x5", "x6", "x7"] });
  const merged = mergeRecentSearches(local, remote);
  assert.equal(merged.state.searches[0], "Bad");
  assert.equal(merged.state.searches.length, 8);
  assert.ok(!merged.state.searches.includes("bad"));
  assert.deepEqual(mergeRecentSearches(remote, local), merged);
});

test("settings merge strips device fields from cloud and keeps local paths", () => {
  const local = env({ downloadDir: "C:\\mine", localMusicFolder: "C:\\music", autoplay: true });
  const remote = env({ downloadDir: "D:\\other", autoplay: false, crossfadeSeconds: 6 });
  const merged = mergeSettings(local, remote, { downloadDir: "C:\\mine", localMusicFolder: "C:\\music" });
  assert.equal(merged.state.downloadDir, "C:\\mine");
  assert.equal(merged.state.localMusicFolder, "C:\\music");
  // cloud value for a non-device field survives when local has none
  assert.equal(merged.state.crossfadeSeconds, 6);
  // local wins for conflicting non-device fields (local is the working copy)
  assert.equal(merged.state.autoplay, true);
});

test("stripDeviceSettings removes machine paths before upload", () => {
  const clean = stripDeviceSettings(env({ downloadDir: "C:\\x", localMusicFolder: "C:\\y", autoplay: true }));
  assert.equal(clean.state.downloadDir, undefined);
  assert.equal(clean.state.localMusicFolder, undefined);
  assert.equal(clean.state.autoplay, true);
});

test("malformed cloud payloads fall back to local content", () => {
  const local = env({ liked: [track("a")], playlists: [], history: [], downloads: {} });
  const merged = mergeLibrary(local, "not-an-object", {});
  assert.deepEqual(merged.state.liked.map((t) => t.id), ["a"]);
});

test("merge helpers preserve envelope versions without confusing listening's state version", () => {
  const local = { state: { version: 99 }, version: 4 }, remote = { state: {}, version: 2 };
  assert.equal(mergeLibrary(local, remote, {}).version, 4);
  assert.equal(mergeLibrary(env({}), env({}), {}).version, 1);
  assert.equal(mergeListening(local, remote).version, 4);
  assert.equal(mergeListening(local, remote).state.version, 99);
  assert.equal(mergeRecentSearches(local, remote).version, 4);
  assert.equal(mergeSettings(local, remote, {}).version, 4);
  assert.equal(mergeLibrary({ version: -2 }, { version: "bad" }, {}).version, 1);
});

/* ------------------------- mergeSyncMeta (H2) ------------------------- */

const meta = (stores, lastUserId) => ({ stores, lastUserId });

test("sync-meta merge keeps the freshest changedAt — a stale disk copy must not hide local edits", () => {
  const disk = meta({ library: { syncedAt: 1000, changedAt: 1000 } });
  const memory = meta({ library: { syncedAt: 1000, changedAt: 5000 } }); // edited since last save
  const merged = mergeSyncMeta(disk, memory);
  assert.equal(merged.stores.library.changedAt, 5000);
  assert.equal(merged.stores.library.syncedAt, 1000);
  // The whole point: changedAt > syncedAt ⇒ the next boot sees local changes.
  assert.ok(merged.stores.library.changedAt > merged.stores.library.syncedAt);
});

test("sync-meta merge keeps the freshest syncedAt — a completed push must not be repeated or forgotten", () => {
  const disk = meta({ library: { syncedAt: 900, changedAt: 900 } });
  const memory = meta({ library: { syncedAt: 2000, changedAt: 2000 } }); // push landed after last save
  const merged = mergeSyncMeta(disk, memory);
  assert.equal(merged.stores.library.syncedAt, 2000);
  assert.equal(merged.stores.library.changedAt, 2000);
});

test("sync-meta merge unions stores from both sides", () => {
  const disk = meta({ library: { syncedAt: 1, changedAt: 2 } });
  const memory = meta({ "listening-signals": { syncedAt: 3, changedAt: 1 } });
  const merged = mergeSyncMeta(disk, memory);
  assert.equal(merged.stores.library.changedAt, 2);
  assert.equal(merged.stores["listening-signals"].syncedAt, 3);
});

test("sync-meta merge prefers memory's lastUserId (runtime account switch)", () => {
  const merged = mergeSyncMeta(meta({}, "user-a"), meta({}, "user-b"));
  assert.equal(merged.lastUserId, "user-b");
  // Memory that never knew a user (fresh boot) falls back to disk.
  assert.equal(mergeSyncMeta(meta({}, "user-a"), meta({})).lastUserId, "user-a");
});

test("sync-meta merge tolerates missing stores maps", () => {
  const merged = mergeSyncMeta({ stores: null }, { stores: undefined, lastUserId: "u" });
  assert.deepEqual(merged.stores, {});
  assert.equal(merged.lastUserId, "u");
});

test("artist identity merge unions by name with the freshest resolution winning", () => {
  const local = env({ byName: { "arijit singh": { id: "local-id", thumb: "local.jpg", resolvedAt: 100 } } });
  const remote = env({ byName: { "arijit singh": { id: "cloud-id", thumb: "cloud.jpg", resolvedAt: 300 }, "the weeknd": { id: "w", thumb: null, resolvedAt: 50 } } });
  const merged = mergeArtistMeta(local, remote);
  assert.equal(merged.state.byName["arijit singh"].id, "cloud-id");
  assert.equal(merged.state.byName["the weeknd"].id, "w");
  const reversed = mergeArtistMeta(remote, local);
  assert.equal(reversed.state.byName["arijit singh"].id, "cloud-id", "newest resolution wins regardless of side");
});
