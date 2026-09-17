import test from "node:test";
import assert from "node:assert/strict";
import { mergeLibrary, mergeRecentSearches } from "../.test-build/sync-merge.mjs";
import { TOMBSTONE_LIMIT, readDeletionSync, recordDeletionChanges } from "../.test-build/deletion-sync.mjs";

const env = (state, version = 1) => ({ state, version });
const track = (id, extra = {}) => ({ id, title: `t-${id}`, artist: "A", ...extra });
const lib = (state) => ({ liked: [], playlists: [], folders: [], followedArtists: [], history: [], downloads: {}, ...state });
const key = (group, id, parent) => JSON.stringify(group === "tracks" ? [group, parent, id] : [group, id]);

test("library merge version never drops below the existing v1 store schema", () => {
  const legacy = { state: lib({}), version: 0 }; // pre-fix cloud copy
  const merged = mergeLibrary(env(lib({ liked: [track("a")] })), legacy, {});
  assert.equal(merged.version, 1);
});

test("delete on one device removes the record a never-touched cloud copy still has", () => {
  // A deleted "b" after the last sync; the cloud is an unchanged older copy.
  const deletionSync = { schema: 1, clock: 1000, floor: 0, adds: {}, deletes: { [key("liked", "b")]: 1000 }, edits: {}, clears: {} };
  const merged = mergeLibrary(
    env(lib({ liked: [track("a")], deletionSync })),
    env(lib({ liked: [track("a"), track("b")] })),
    {}
  );
  assert.deepEqual(merged.state.liked.map((t) => t.id), ["a"]);
});

test("real additions from both sides survive a deletion merge", () => {
  const am = { schema: 1, clock: 1000, floor: 0, adds: { [key("liked", "a")]: 1000 }, deletes: {}, edits: {}, clears: {} };
  const bm = { schema: 1, clock: 1000, floor: 0, adds: { [key("liked", "b")]: 1000 }, deletes: {}, edits: {}, clears: {} };
  const merged = mergeLibrary(env(lib({ liked: [track("a")], deletionSync: am })), env(lib({ liked: [track("b")], deletionSync: bm })), {});
  assert.deepEqual(merged.state.liked.map((t) => t.id).sort(), ["a", "b"]);
  // Metadata travels in the merged envelope for the next round trip.
  assert.equal(merged.state.deletionSync.schema, 1);
  assert.equal(merged.state.deletionSync.clock, 1000);
});

test("unchanged local copy does not resurrect a remotely deleted record", () => {
  // The cloud deleted "a"; this device's local copy is an unchanged snapshot.
  const deletionSync = { schema: 1, clock: 1000, floor: 0, adds: {}, deletes: { [key("liked", "a")]: 1000 }, edits: {}, clears: {} };
  const merged = mergeLibrary(
    env(lib({ liked: [track("a"), track("keep")] })),
    env(lib({ liked: [track("keep")], deletionSync })),
    {}
  );
  assert.deepEqual(merged.state.liked.map((t) => t.id), ["keep"]);
});

test("later explicit add beats an earlier delete across devices", () => {
  const am = { schema: 1, clock: 3000, floor: 0, adds: { [key("liked", "x")]: 3000 }, deletes: { [key("liked", "x")]: 2000 }, edits: {}, clears: {} };
  const bm = { schema: 1, clock: 2000, floor: 0, adds: {}, deletes: { [key("liked", "x")]: 2000 }, edits: {}, clears: {} };
  const merged = mergeLibrary(env(lib({ liked: [track("x")], deletionSync: am })), env(lib({ deletionSync: bm }), 0), {});
  assert.deepEqual(merged.state.liked.map((t) => t.id), ["x"]);
});

test("playlist delete suppresses a stale cloud copy of the same playlist and its tracks", () => {
  const deletionSync = {
    schema: 1, clock: 1000, floor: 0,
    adds: {}, edits: {}, clears: {},
    deletes: { [key("playlists", "p1")]: 900, [key("tracks", "s", "p1")]: 900 },
  };
  const merged = mergeLibrary(
    env(lib({ deletionSync })),
    env(lib({ playlists: [{ id: "p1", name: "Cloud copy", tracks: [track("s")], createdAt: 1 }] })),
    {}
  );
  assert.deepEqual(merged.state.playlists, []);
});

test("deleting a folder unfiles its playlists instead of dropping them", () => {
  const deletionSync = { schema: 1, clock: 900, floor: 0, adds: {}, deletes: { [key("folders", "f1")]: 900 }, edits: {}, clears: {} };
  const merged = mergeLibrary(
    env(lib({ deletionSync })),
    env(lib({ folders: [{ id: "f1", name: "Workout", createdAt: 1 }], playlists: [{ id: "p1", name: "Run", tracks: [], createdAt: 1, folderId: "f1" }] })),
    {}
  );
  assert.deepEqual(merged.state.folders, []);
  assert.equal(merged.state.playlists.length, 1);
  assert.equal(merged.state.playlists[0].folderId, undefined);
});

test("clear-history tombstone keeps a stale cloud history from flowing back", () => {
  const deletionSync = { schema: 1, clock: 900, floor: 0, adds: {}, deletes: {}, edits: {}, clears: { history: 900 } };
  const merged = mergeLibrary(
    env(lib({ history: [], deletionSync })),
    env(lib({ history: [track("old")] })),
    {}
  );
  assert.deepEqual(merged.state.history, []);
});

test("re-adding a track to a playlist after removal wins over the stale copy", () => {
  // A removed "s" from p1 at 900, then re-added it at 1000; the cloud still
  // has the pre-removal membership — the re-add (and the membership) survive.
  const deletionSync = {
    schema: 1, clock: 1000, floor: 0,
    adds: { [key("tracks", "s", "p1")]: 1000 },
    deletes: { [key("tracks", "s", "p1")]: 900 },
    edits: {}, clears: {},
  };
  const merged = mergeLibrary(
    env(lib({ playlists: [{ id: "p1", name: "P", tracks: [track("s")], createdAt: 1 }], deletionSync })),
    env(lib({ playlists: [{ id: "p1", name: "P", tracks: [track("s")], createdAt: 1 }] })),
    {}
  );
  assert.deepEqual(merged.state.playlists[0].tracks.map((t) => t.id), ["s"]);
});

test("merged library keeps device downloads and existing union behavior", () => {
  const local = env(lib({ downloads: { x: { status: "done" } }, liked: [track("a")] }));
  const remote = env(lib({ downloads: { y: { status: "done" } }, liked: [track("b")] }));
  const merged = mergeLibrary(local, remote, {});
  assert.deepEqual(Object.keys(merged.state.downloads), ["x"]);
  assert.deepEqual(merged.state.liked.map((t) => t.id).sort(), ["a", "b"]);
  assert.equal(merged.version, 1);
});

test("recent searches merge keeps a deleted query deleted and preserves version", () => {
  const deletionSync = { schema: 1, clock: 900, floor: 0, adds: {}, deletes: { [key("searches", "bad")]: 900 }, edits: {}, clears: {} };
  const local = env({ searches: ["keep"], deletionSync });
  const remote = env({ searches: ["keep", "bad"] }, 0);
  const merged = mergeRecentSearches(local, remote);
  assert.deepEqual(merged.state.searches, ["keep"]);
  assert.ok(merged.version >= 0);
});

test("device B restoring device A's metadata does not delete B's own records", () => {
  // A's snapshot deleted its own "a"; B has unrelated "b" with no markers.
  const deletionSync = { schema: 1, clock: 500, floor: 0, adds: {}, deletes: { [key("liked", "a")]: 500 }, edits: {}, clears: {} };
  const merged = mergeLibrary(
    env(lib({ liked: [track("b")] })),
    env(lib({ liked: [track("a")], deletionSync })),
    {}
  );
  assert.deepEqual(merged.state.liked.map((t) => t.id), ["b"]);
});

test("library membership merge converges and repeated stale merges are idempotent", () => {
  const am = readDeletionSync({ schema: 1, adds: { [key("liked", "a")]: 10 }, deletes: { [key("tracks", "gone", "p")]: 20 } });
  const bm = readDeletionSync({ schema: 1, adds: { [key("liked", "b")]: 11 } });
  const a = env(lib({ liked: [track("a")], playlists: [{ id: "p", name: "A", tracks: [track("x")], createdAt: 1 }], deletionSync: am }));
  const b = env(lib({ liked: [track("b")], playlists: [{ id: "p", name: "B", tracks: [track("gone"), track("y")], createdAt: 1 }], deletionSync: bm }));
  const merged = mergeLibrary(a, b, {});
  assert.deepEqual(merged, mergeLibrary(b, a, {}));
  assert.deepEqual(merged, mergeLibrary(merged, a, {}));
  assert.deepEqual(merged, mergeLibrary(merged, b, {}));
  assert.deepEqual(merged, mergeLibrary(merged, merged, {}));
});

test("compacted floor survives serialized stale-cloud round trips and keeps known survivors", () => {
  let state = lib({ liked: [track("kept")] });
  for (let i = 0; i <= TOMBSTONE_LIMIT; i++) {
    state.deletionSync = recordDeletionChanges(state, {}, [{ kind: "delete", group: "liked", id: `gone${i}` }]);
  }
  assert.ok(state.deletionSync.floor > 0);
  const stale = env(lib({ liked: [track("gone0"), track("kept"), track("unsynced-old")] }));
  const merged = mergeLibrary(env(state), stale, {});
  assert.deepEqual(merged.state.liked.map((t) => t.id), ["kept"]);
  assert.deepEqual(mergeLibrary(stale, JSON.parse(JSON.stringify(merged)), {}), merged);
  const newer = env(lib({ liked: [track("new")], deletionSync: readDeletionSync({ schema: 1,
    adds: { [key("liked", "new")]: state.deletionSync.clock + 1 } }) }));
  assert.deepEqual(mergeLibrary(merged, newer, {}).state.liked.map((t) => t.id), ["new", "kept"]);
});

test("recreated playlist cannot inherit children from its deleted generation", () => {
  const fresh = env(lib({ playlists: [{ id: "p", name: "New", tracks: [track("new")], createdAt: 30 }],
    deletionSync: readDeletionSync({ schema: 1, adds: { [key("playlists", "p")]: 30, [key("tracks", "new", "p")]: 31 },
      deletes: { [key("playlists", "p")]: 20 } }) }));
  const old = env(lib({ playlists: [{ id: "p", name: "Old", tracks: [track("old")], createdAt: 1 }] }));
  assert.deepEqual(mergeLibrary(fresh, old, {}).state.playlists[0].tracks.map((t) => t.id), ["new"]);
});
