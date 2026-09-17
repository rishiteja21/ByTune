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

/** Load the REAL coalescing storage adapter with a counting backing store. */
async function loadCoalescedStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-coalesce-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../src/lib/persist.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["zustand/middleware"],
  });
  const writes = [];
  const windowStub = {
    bytune: {
      readData: async () => null,
      writeData: async (name, data) => { writes.push({ name, data, at: Date.now() }); },
    },
    addEventListener(type, fn) { (windowStub[type] = windowStub[type] || []).push(fn); },
    removeEventListener() {},
  };
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    window: windowStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    require: (name) => require(name),
  });
  const { coalescedStorage, storage } = module.exports;
  return {
    coalescedStorage, plainStorage: storage, writes,
    firePagehide: () => { for (const fn of windowStub.pagehide ?? []) fn(); },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("coalesced storage: a 4Hz burst writes to disk at most once per 2s window, last value wins", async () => {
  const h = await loadCoalescedStorage();
  try {
    // Simulate 8 seconds of 4Hz library updates (download progress storm).
    for (let i = 0; i < 32; i++) {
      await h.coalescedStorage.setItem("library", JSON.stringify({ rev: i }));
      await new Promise((r) => setTimeout(r, 250));
    }
    // The uncoalesced adapter would have written 32 times; coalesced must be
    // far fewer (≤ once per 2s window + drain timing slack).
    assert.ok(h.writes.length <= 6, `expected ≤6 writes for a 32-event storm, got ${h.writes.length}`);
    // The last value must land once the window closes.
    await new Promise((r) => setTimeout(r, 2100));
    const last = h.writes.at(-1);
    assert.equal(last.data.rev, 31, "the newest value must be the one persisted");
  } finally { h.cleanup(); }
});

test("coalesced storage: pending writes flush on pagehide and removals are immediate", async () => {
  const h = await loadCoalescedStorage();
  try {
    await h.coalescedStorage.setItem("player", JSON.stringify({ position: 42 }));
    assert.equal(h.writes.length, 1, "first write lands immediately (idle before it)");
    await h.coalescedStorage.setItem("player", JSON.stringify({ position: 99 }));
    await h.coalescedStorage.setItem("library", JSON.stringify({ downloads: 1 }));
    assert.equal(h.writes.length, 1, "burst inside the window must NOT hit disk yet");
    h.firePagehide();
    assert.equal(h.writes.length, 3, "pagehide must flush every pending store");
    assert.equal(
      JSON.stringify(h.writes.slice(1).map((w) => w.data)),
      JSON.stringify([{ position: 99 }, { downloads: 1 }]),
      "pagehide must flush the newest pending values"
    );
    await h.coalescedStorage.removeItem("library");
    assert.ok(h.writes.at(-1).data == null, "removal must write null immediately, not be coalesced");
  } finally { h.cleanup(); }
});
