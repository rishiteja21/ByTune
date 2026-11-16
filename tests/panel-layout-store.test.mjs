/** The actual store and coalescing adapter, with a fake desktop JSON bridge. */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/stores/panelLayout.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["zustand", "zustand/middleware"],
});

async function load(initial) {
  let saved = initial;
  const writes = [];
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (event, fn) => listeners.set(event, fn),
    bytune: {
      readData: async (name) => { assert.equal(name, "panel-layout"); return saved; },
      writeData: async (name, value) => {
        assert.equal(name, "panel-layout");
        saved = structuredClone(value);
        writes.push(saved);
      },
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
  const store = module.exports.usePanelLayout;
  await store.persist.rehydrate();
  return { store, writes, saved: () => saved, flush: () => listeners.get("pagehide")() };
}

test("drag updates are coalesced and the latest widths flush on close and restore on launch", async () => {
  const h = await load({ state: { widths: { library: 400, nowPlaying: 360 } }, version: 0 });
  try {
    assert.deepEqual(h.store.getState().widths, { library: 400, nowPlaying: 360 });
    for (let library = 401; library <= 450; library++) h.store.getState().setWidths({ library, nowPlaying: 360 });
    assert.equal(h.writes.length, 0, "pointer moves do not write every frame");
    h.flush();
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.saved(), { state: { widths: { library: 450, nowPlaying: 360 } }, version: 0 });
    const reopened = await load(h.saved());
    assert.deepEqual(reopened.store.getState().widths, { library: 450, nowPlaying: 360 });
  } finally { h.flush(); }
});

test("partial and damaged saved data cannot replace actions or introduce unusable widths", async () => {
  const h = await load({ state: { widths: { library: 900, nowPlaying: "wide" }, resetWidths: null }, version: 0 });
  try {
    assert.deepEqual(h.store.getState().widths, { library: 480, nowPlaying: 328 });
    assert.equal(typeof h.store.getState().resetWidths, "function");
    h.store.getState().setWidths({ library: -20, nowPlaying: 350.4 });
    assert.deepEqual(h.store.getState().widths, { library: 240, nowPlaying: 350 });
  } finally { h.flush(); }
});

test("reset persists both defaults, and unchanged widths cause no extra writes", async () => {
  const h = await load({ state: { widths: { library: 400, nowPlaying: 450 } }, version: 0 });
  try {
    h.store.getState().resetWidths();
    h.flush();
    assert.deepEqual(h.saved().state.widths, { library: 328, nowPlaying: 328 });
    h.store.getState().resetWidths();
    h.store.getState().setWidths({ library: 328, nowPlaying: 328 });
    h.flush();
    assert.equal(h.writes.length, 1);
  } finally { h.flush(); }
});
