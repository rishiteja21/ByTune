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
const payload = (id) => ({ state: { liked: [{ id }], playlists: [], downloads: {} }, version: 1 });
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-account-switch-"));
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL("../electron/data-transition.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, console, setTimeout, Promise,
    require: (name) => name === "electron" ? { app: { getPath: () => dir } } : require(name) });
  const api = module.exports;
  api.initializeOwner();
  return { api, close() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("account A late write is preserved for A, never persisted into fresh B interface", async () => {
  const h = await fixture(), a = h.api;
  try {
    await a.serializeData(() => a.changeOwner("A", true));
    const docA = a.documentScope();
    await a.serializeData(() => a.writeForDocument("library", payload("A-song"), docA));
    let release;
    const gate = new Promise((r) => { release = r; });
    const switching = a.serializeData(async () => { await a.changeOwner("B", false); await gate; });
    const lateWrite = a.serializeData(() => a.writeForDocument("library", payload("A-late-action"), docA));
    release();
    await switching;
    await lateWrite;
    const docB = a.documentScope();
    assert.deepEqual(JSON.parse(JSON.stringify(a.readForDocument("library", docB).state.liked ?? [])), []);
    await a.serializeData(() => a.writeForDocument("library", payload("B-song"), docB));
    assert.equal(a.readForDocument("library", docA).state.liked[0].id, "A-late-action");
    assert.equal(a.readForDocument("library", docB).state.liked[0].id, "B-song");
    await a.serializeData(() => a.changeOwner("A", false));
    const freshA = a.documentScope();
    assert.equal(a.readForDocument("library", freshA).state.liked[0].id, "A-late-action");
    assert.equal(a.readForDocument("library", docB).state.liked[0].id, "B-song");
  } finally { h.close(); }
});

test("guest migration adopts existing documents and reset rejects obsolete document writes", async () => {
  const h = await fixture(), a = h.api;
  try {
    const guest = a.documentScope();
    await a.writeForDocument("library", payload("guest-song"), guest);
    await a.changeOwner("A", true);
    assert.equal(a.readForDocument("library", guest).state.liked[0].id, "guest-song");
    assert.equal(await a.writeForDocument("library", payload("guest-late"), guest), true);
    a.invalidateResetDocuments();
    await assert.rejects(a.writeForDocument("library", payload("obsolete"), guest), /reset/);
  } finally { h.close(); }
});
