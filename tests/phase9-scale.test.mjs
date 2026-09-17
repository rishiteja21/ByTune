/**
 * Phase 9 library-scale measurement: real fs walk + real JSON parse/read at
 * 100 / 1000 / 5000 tracks against the REAL local-library module (metadata
 * parsing stubbed — we measure OUR code, not music-metadata). Scratch dirs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

async function loadLocalLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-phase9-scale-"));
  const store = new Map();
  let readCount = 0;
  const persistMock = {
    readData: (n) => { readCount++; return store.has(n) ? JSON.parse(JSON.stringify(store.get(n))) : null; },
    writeData: async (n, v) => { store.set(n, JSON.parse(JSON.stringify(v))); },
    writeDataSync: (n, v) => { store.set(n, JSON.parse(JSON.stringify(v))); },
  };
  const electronStub = { app: { getPath: () => path.join(dir, "userdata") } };
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/local-library.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{
      name: "stub",
      setup(b) {
        b.onResolve({ filter: /^electron$|^\.\/persist$|^music-metadata$/ }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          contents: a.path === "electron" ? "module.exports = globalThis.__es;"
            : a.path === "./persist" ? "module.exports = globalThis.__ps;"
            : "module.exports = globalThis.__parse;",
          loader: "js",
        }));
      },
    }],
  });
  globalThis.__es = electronStub;
  globalThis.__ps = persistMock;
  globalThis.__parse = { parseFile: async () => ({ common: {}, format: { duration: 120 } }) };
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bytune-phase9-scale-b-")), "local-library.cjs");
  fs.writeFileSync(outfile, outputFiles[0].text);
  return { api: require(outfile), store, readCount: () => readCount, dir, cleanup: () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(outfile), { recursive: true, force: true });
  } };
}

test("library scale: scan + read + trackurl at 100/1000/5000 tracks", async () => {
  const h = await loadLocalLibrary();
  try {
    for (const n of [100, 1000, 5000]) {
      const rootDir = path.join(h.dir, `lib-${n}`);
      fs.mkdirSync(rootDir, { recursive: true });
      const perFolder = 100;
      const folders = Math.ceil(n / perFolder);
      for (let f = 0; f < folders; f++) {
        const fd = path.join(rootDir, `folder-${f}`);
        fs.mkdirSync(fd, { recursive: true });
        for (let i = 0; i < perFolder && f * perFolder + i < n; i++) {
          fs.writeFileSync(path.join(fd, `track-${f}-${i}.mp3`), "x");
        }
      }
      const folderPaths = Array.from({ length: folders }, (_, f) => path.join(rootDir, `folder-${f}`));
      await h.api.setLibraryFolders(folderPaths.slice(0, 1)); // add one; scan walks the parent? no — walk is per folder
      // add all folders through addLibraryFolders
      await h.api.addLibraryFolders(folderPaths);
      const t0 = performance.now();
      const scanned = await h.api.scanLibrary(false);
      const scanMs = performance.now() - t0;
      assert.equal(scanned.tracks.length, n, `${n} tracks scanned`);

      // cold read (fresh process equivalent: clear the module cache by resetting generation? instead measure a real re-read)
      const coldReadStart = performance.now();
      h.api.__invalidateForTest ? h.api.__invalidateForTest() : null;
      const lib = h.api.readLocalLibrary();
      const readMs = performance.now() - coldReadStart;
      assert.equal(lib.tracks.length, n);

      // trackurl lookups (the per-range-request hot path)
      const id = lib.tracks[Math.floor(n / 2)].id;
      const lookups = 1000;
      const t1 = performance.now();
      for (let i = 0; i < lookups; i++) h.api.localStreamPath(id);
      const lookupMs = (performance.now() - t1) / lookups;

      console.log(`[scale] tracks=${n} scanMs=${scanMs.toFixed(0)} readMs=${readMs.toFixed(2)} localStreamPathAvgUs=${(lookupMs * 1000).toFixed(1)} storeKB=${(JSON.stringify(h.store.get("local-library")).length / 1024).toFixed(0)}`);
    }
  } finally { h.cleanup(); }
});
