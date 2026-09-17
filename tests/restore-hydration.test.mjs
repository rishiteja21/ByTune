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
const compile = async (entry) => (await build({
  entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true,
  platform: "node", format: "cjs", external: ["electron", "react"], write: false,
})).outputFiles[0].text;
const track = (id) => ({ id, title: id, artist: "Audit", duration: 60 });
const plain = (value) => JSON.parse(JSON.stringify(value));

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-hydration-"));
  const mainModule = { exports: {} };
  vm.runInNewContext(await compile("../electron/persist.ts"), {
    module: mainModule, exports: mainModule.exports, console, setTimeout,
    require: (name) => name === "electron" ? { app: { getPath: () => dir } } : require(name),
  });
  const disk = mainModule.exports;
  const rendererCode = await compile("../src/stores/library.ts");
  const pending = [];
  let holdRead = null;
  const bridge = {
    async readData(name) {
      const snapshot = disk.readData(name);
      if (holdRead) await holdRead();
      return snapshot;
    },
    writeData(name, value) {
      const job = disk.writeData(name, value);
      pending.push(job);
      return job;
    },
  };
  const freshStore = async () => {
    const module = { exports: {} };
    vm.runInNewContext(rendererCode, {
      module, exports: module.exports, require, console, setTimeout, clearTimeout,
      // Capture the storage adapter's flush hooks: since Phase 9 the library
      // store persists through coalescedStorage, and durability at a reload
      // boundary is delivered by the pagehide/beforeunload flush.
      window: { bytune: bridge, addEventListener(type, fn) { (pagehideListeners[type] ??= []).push(fn); } },
    });
    const store = module.exports.useLibrary;
    if (!store.persist.hasHydrated()) {
      await new Promise((resolve) => {
        const off = store.persist.onFinishHydration(() => { off(); resolve(); });
      });
    }
    return store;
  };
  const pagehideListeners = {};
  return {
    disk, freshStore,
    holdRead(fn) { holdRead = fn; },
    async flush() {
      // Model a reload boundary: the pagehide flush pushes pending coalesced
      // writes into the bridge before we wait for the disk jobs.
      for (const fns of Object.values(pagehideListeners)) for (const fn of fns) fn();
      await Promise.all(pending);
    },
    async close() { await Promise.allSettled(pending); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("library likes, playlist tracks and history hydrate from disk in a fresh store", async () => {
  const h = await harness();
  try {
    const initial = await h.freshStore();
    initial.getState().toggleLike(track("liked"));
    const playlist = initial.getState().createPlaylist("Restart audit");
    initial.getState().addToPlaylist(playlist.id, track("first"));
    initial.getState().addToPlaylist(playlist.id, track("second"));
    initial.getState().pushHistory(track("played"));
    await h.flush();
    const restarted = await h.freshStore();
    assert.deepEqual(plain(restarted.getState().liked.map((t) => t.id)), ["liked"]);
    assert.deepEqual(plain(restarted.getState().playlists[0].tracks.map((t) => t.id)), ["first", "second"]);
    assert.equal(restarted.getState().history[0].id, "played");
  } finally { await h.close(); }
});

test("a user like during restore hydration survives in the live store and on disk", async () => {
  const h = await harness();
  let release;
  try {
    const store = await h.freshStore();
    await h.disk.writeData("library", { state: { liked: [track("cloud")], playlists: [], folders: [], followedArtists: [], history: [], downloads: {} }, version: 1 });
    let readStarted;
    const started = new Promise((resolve) => { readStarted = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    h.holdRead(async () => { readStarted(); await gate; });
    const hydration = store.persist.rehydrate();
    await started;
    store.getState().toggleLike(track("during-restore"));
    release();
    await hydration;
    await h.flush();
    assert.deepEqual(new Set(store.getState().liked.map((t) => t.id)), new Set(["cloud", "during-restore"]));
    assert.deepEqual(new Set(h.disk.readData("library").state.liked.map((t) => t.id)), new Set(["cloud", "during-restore"]));
  } finally { release?.(); await h.close(); }
});
