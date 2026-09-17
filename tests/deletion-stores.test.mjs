import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mergeLibrary, mergeRecentSearches } from "../.test-build/sync-merge.mjs";
const require = createRequire(import.meta.url);
const plain = (v) => JSON.parse(JSON.stringify(v));
const track = (id) => ({ id, title: id, artist: "Test", duration: 60 });
const key = (group, id, parent) => JSON.stringify(group === "tracks" ? [group, parent, id] : [group, id]);
const codes = new Map();
async function harness(name, initial = null) {
  if (!codes.has(name)) codes.set(name, (await build({
    entryPoints: [fileURLToPath(new URL(`../src/stores/${name}.ts`, import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false, external: ["react"],
    plugins: [{ name: "isolated-storage", setup(build) {
      build.onLoad({ filter: /[\\/]lib[\\/]persist\.ts$/ }, () => ({ contents: "export const storage = globalThis.testStorage; export const coalescedStorage = globalThis.testStorage;", loader: "ts" }));
    } }],
  })).outputFiles[0].text);
  let disk = initial, gate = null;
  const writes = [];
  const storage = {
    async getItem() { const snapshot = disk; if (gate) await gate; return snapshot == null ? null : JSON.stringify(snapshot); },
    async setItem(_name, value) { disk = JSON.parse(value); writes.push(disk); },
    async removeItem() { disk = null; },
  };
  const module = { exports: {} };
  vm.runInNewContext(codes.get(name), { module, exports: module.exports, require, console, Promise, testStorage: storage });
  const store = module.exports[name === "library" ? "useLibrary" : "useRecents"];
  if (!store.persist.hasHydrated()) await new Promise((resolve) => {
    const off = store.persist.onFinishHydration(() => { off(); resolve(); });
  });
  return { store, writes, snapshot: () => plain(disk),
    restore(snapshot) {
      disk = snapshot;
      let release;
      gate = new Promise((r) => { release = r; });
      const done = store.persist.rehydrate();
      return async () => { gate = null; release(); await done; };
    },
  };
}

test("library public mutations persist adds/deletes atomically and later explicit re-adds survive", async () => {
  const h = await harness("library"), s = h.store.getState;
  s().toggleLike(track("liked"));
  const liked = h.snapshot();
  s().toggleLike(track("liked"));
  assert.deepEqual(mergeLibrary(h.snapshot(), liked, {}).state.liked, []);
  assert.equal(h.writes.at(-1).state.liked.length, 0);
  assert.ok(h.writes.at(-1).state.deletionSync.deletes[key("liked", "liked")]);
  const deleted = h.snapshot();
  s().toggleLike(track("liked"));
  assert.equal(mergeLibrary(h.snapshot(), deleted, {}).state.liked.length, 1);
  const p = s().createPlaylist("P"), other = s().createPlaylist("Other");
  assert.equal(s().addToPlaylist("missing", track("x")), false);
  s().addToPlaylist(p.id, track("x"));
  s().addToPlaylist(other.id, track("x"));
  const beforeTrack = h.snapshot();
  const writesBefore = h.writes.length;
  s().removeFromPlaylist(p.id, "x");
  assert.equal(h.writes.length, writesBefore + 1);
  const tracksMerged = mergeLibrary(h.snapshot(), beforeTrack, {}).state.playlists;
  assert.equal(tracksMerged.find((x) => x.id === p.id).tracks.length, 0);
  assert.equal(tracksMerged.find((x) => x.id === other.id).tracks.length, 1);
  s().addToPlaylist(p.id, track("x"));
  assert.equal(mergeLibrary(h.snapshot(), beforeTrack, {}).state.playlists.find((x) => x.id === p.id).tracks.length, 1);
  const beforePlaylist = h.snapshot();
  s().deletePlaylist(p.id);
  assert.ok(!mergeLibrary(h.snapshot(), beforePlaylist, {}).state.playlists.some((x) => x.id === p.id));
  const f = s().createFolder("Folder");
  s().setPlaylistFolder(other.id, f.id);
  const beforeFolder = h.snapshot();
  s().deleteFolder(f.id);
  const afterFolder = mergeLibrary(h.snapshot(), beforeFolder, {});
  assert.equal(afterFolder.state.folders.length, 0);
  assert.equal(afterFolder.state.playlists.find((x) => x.id === other.id).folderId, undefined);
  s().followArtist({ id: "artist", name: "A" });
  const followed = h.snapshot();
  s().unfollowArtist("artist");
  assert.equal(mergeLibrary(h.snapshot(), followed, {}).state.followedArtists.length, 0);
  s().followArtist({ id: "artist", name: "A" });
  assert.equal(mergeLibrary(h.snapshot(), followed, {}).state.followedArtists.length, 1);
  s().pushHistory(track("old"));
  const history = h.snapshot();
  s().clearHistory();
  assert.equal(mergeLibrary(h.snapshot(), history, {}).state.history.length, 0);
  s().pushHistory(track("new"));
  assert.deepEqual(mergeLibrary(h.snapshot(), history, {}).state.history.map((t) => t.id), ["new"]);
});

test("metadata edits are versioned independently from membership and duplicate adds are no-ops", async () => {
  const h = await harness("library"), s = h.store.getState;
  const p = s().createPlaylist("Before"), f = s().createFolder("Before");
  const before = h.snapshot();
  const added = before.state.deletionSync.adds[key("playlists", p.id)];
  s().renamePlaylist(p.id, "After"); s().togglePinPlaylist(p.id); s().setPlaylistFolder(p.id, f.id);
  s().renameFolder(f.id, "After");
  const after = h.snapshot();
  assert.equal(after.state.deletionSync.adds[key("playlists", p.id)], added);
  assert.ok(after.state.deletionSync.edits[key("playlists", p.id)] > added);
  const merged = mergeLibrary(before, after, {});
  assert.equal(merged.state.playlists[0].name, "After");
  assert.equal(merged.state.playlists[0].pinned, true);
  assert.equal(merged.state.folders[0].name, "After");
  s().addToPlaylist(p.id, track("x"));
  const count = h.writes.length;
  assert.equal(s().addToPlaylist(p.id, track("x")), false);
  assert.equal(h.writes.length, count);
  const deleted = structuredClone(after);
  deleted.state.playlists = [];
  deleted.state.deletionSync.deletes[key("playlists", p.id)] = added + 1;
  assert.equal(mergeLibrary(after, deleted, {}).state.playlists.length, 0);
});

test("likes and ordered clear/history intents survive restore hydration with their metadata", async () => {
  const h = await harness("library"), s = h.store.getState;
  s().toggleLike(track("remove")); s().pushHistory(track("old"));
  const cloud = h.snapshot();
  cloud.state.liked.push(track("cloud-only"));
  const finish = h.restore(cloud);
  s().toggleLike(track("remove")); s().toggleLike(track("during"));
  s().pushHistory(track("before-clear")); s().clearHistory(); s().pushHistory(track("after-clear"));
  await finish();
  const restored = h.snapshot();
  assert.deepEqual(new Set(restored.state.liked.map((t) => t.id)), new Set(["cloud-only", "during"]));
  assert.deepEqual(restored.state.history.map((t) => t.id), ["after-clear"]);
  const merged = mergeLibrary(restored, cloud, {});
  assert.deepEqual(merged.state.history.map((t) => t.id), ["after-clear"]);
  assert.ok(!merged.state.liked.some((t) => t.id === "remove"));
  assert.ok(restored.state.deletionSync.adds[key("history", "after-clear")] > restored.state.deletionSync.clears.history);
});

test("offline delete → drain → reset → reload durable backup → merge does not resurrect a like", async () => {
  const original = await harness("library");
  original.store.getState().toggleLike(track("removed"));
  const staleCloud = original.snapshot();
  original.store.getState().toggleLike(track("removed"));
  // This harness commits storage writes synchronously; settle promise callbacks
  // before capturing the durable backup that survives a local-data reset.
  await Promise.resolve();
  const durableBackup = original.snapshot();
  assert.equal(durableBackup.state.liked.length, 0);
  assert.ok(durableBackup.state.deletionSync.deletes[key("liked", "removed")]);

  const reset = await harness("library", null);
  assert.equal(reset.store.getState().liked.length, 0);
  const reload = await harness("library", durableBackup);
  assert.equal(reload.writes.length, 0, "hydration must not invent a new add");
  const restored = plain({ state: reload.store.getState(), version: 1 });
  const merged = mergeLibrary(restored, staleCloud, {});
  assert.deepEqual(merged.state.liked, [], "unchanged cloud record must not undo the durable deletion");
  const retried = mergeLibrary(merged, staleCloud, {});
  assert.deepEqual(retried, merged, "retry must be idempotent");
  const restarted = await harness("library", retried);
  assert.equal(restarted.store.getState().liked.length, 0);
});

test("ordinary hydration preserves versions without inventing fresh additions", async () => {
  const h = await harness("library"); h.store.getState().toggleLike(track("x"));
  const snapshot = h.snapshot(), restarted = await harness("library", snapshot);
  assert.deepEqual(plain(restarted.store.getState().deletionSync), snapshot.state.deletionSync);
  assert.equal(restarted.writes.length, 0);
});

test("search remove/clear is case-insensitive, versioned and later search wins", async () => {
  const h = await harness("recents"), s = h.store.getState;
  s().pushSearch("  Hello  "); const before = h.snapshot();
  s().removeSearch("hELLo");
  assert.deepEqual(mergeRecentSearches(h.snapshot(), before).state.searches, []);
  const deleted = h.snapshot(); s().pushSearch("HELLO");
  assert.deepEqual(mergeRecentSearches(h.snapshot(), deleted).state.searches, ["HELLO"]);
  s().clearSearches();
  assert.deepEqual(mergeRecentSearches(h.snapshot(), before).state.searches, []);
  for (let i = 0; i < 20; i++) s().pushSearch(`q${i}`);
  assert.equal(s().searches.length, 8);
  assert.equal(Object.keys(s().deletionSync.adds).length, 8);
});

test("search hydration replays removes and clear/add order, not accidental additions", async () => {
  const h = await harness("recents"), s = h.store.getState;
  s().pushSearch("remove"); const before = h.snapshot();
  let finish = h.restore(before);
  s().removeSearch("REMOVE"); await finish();
  assert.deepEqual(mergeRecentSearches(h.snapshot(), before).state.searches, []);
  finish = h.restore(before);
  s().pushSearch("before"); s().clearSearches(); s().pushSearch("after"); await finish();
  assert.deepEqual(mergeRecentSearches(h.snapshot(), before).state.searches, ["after"]);
});
