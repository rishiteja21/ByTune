import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Local-library Windows-path and concurrency regressions run against the REAL
 * module (bundled with esbuild) in this process. Only "./persist" is replaced
 * — with the real atomic-write semantics on a scratch directory — and the
 * "music-metadata" dynamic import is intercepted. No Electron runtime needed:
 * the module only uses app.getPath().
 */
const require = createRequire(import.meta.url);

async function loadLocalLibrary({ parseFile, countReads = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-lib-"));
  const store = new Map();
  let reads = 0;
  const persistMock = {
    readData: (n) => {
      if (countReads) reads++;
      return store.has(n) ? JSON.parse(JSON.stringify(store.get(n))) : null;
    },
    writeData: async (n, v) => { store.set(n, JSON.parse(JSON.stringify(v))); },
    writeDataSync: (n, v) => { store.set(n, JSON.parse(JSON.stringify(v))); },
  };
  const electronStub = { app: { getPath: () => path.join(dir, "userdata") } };
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/local-library.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{
      name: "stub-electron-persist",
      setup(b) {
        b.onResolve({ filter: /^electron$|^\.\/persist$|^music-metadata$/ }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          contents: a.path === "electron"
            ? "module.exports = globalThis.__electronStub;"
            : a.path === "./persist"
              ? "module.exports = globalThis.__persistStub;"
              : "module.exports = globalThis.__parseStub;",
          loader: "js",
        }));
      },
    }],
  });
  globalThis.__electronStub = electronStub;
  globalThis.__persistStub = persistMock;
  globalThis.__parseStub = { parseFile: parseFile ?? (async () => ({ common: {}, format: { duration: 120 } })) };
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bytune-lib-bundle-")), "local-library.cjs");
  fs.writeFileSync(outfile, outputFiles[0].text);
  const api = require(outfile);
  return {
    api, store, dir, reads: () => reads,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.dirname(outfile), { recursive: true, force: true });
    },
  };
}

const mkMusicDir = (dir, name = "music", n = 3) => {
  const music = path.join(dir, name);
  fs.mkdirSync(music, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(music, `song${i}.mp3`), "audio");
  return music;
};

test("drive roots normalize to C:\\ — never a drive-relative C:", async () => {
  const h = await loadLocalLibrary();
  try {
    const driveRoot = path.parse(h.dir).root;
    await h.api.setLibraryFolders([driveRoot]);
    const saved = h.api.readLocalLibrary();
    assert.equal(saved.folders.length, 1);
    assert.equal(saved.folders[0].path, driveRoot, "a drive root must keep its trailing separator");
  } finally { h.cleanup(); }
});

test("a rename that lands during a scan is not clobbered by the scan save", async () => {
  const h = await loadLocalLibrary();
  try {
    const music = mkMusicDir(h.dir);
    await h.api.addLibraryFolders([music]);
    // The scan parses real files; the rename is queued behind the same
    // serialization, then the scan's commit must re-read the folders.
    const scan = h.api.scanLibrary(false);
    await h.api.renameLibraryFolder(music, "My songs");
    await scan;
    const saved = h.api.readLocalLibrary();
    assert.equal(saved.folders[0].displayName, "My songs", "the scan must not resurrect the pre-rename folder snapshot");
    assert.equal(saved.tracks.length, 3);
  } finally { h.cleanup(); }
});

test("a remove that lands during a scan is not resurrected by the scan save", async () => {
  const h = await loadLocalLibrary();
  try {
    const a = mkMusicDir(h.dir, "music-a", 3);
    const b = mkMusicDir(h.dir, "music-b", 2);
    await h.api.setLibraryFolders([a, b]);
    const scan = h.api.scanLibrary(false);
    await h.api.removeLibraryFolder(b);
    await scan;
    const saved = h.api.readLocalLibrary();
    assert.equal(saved.folders.length, 1, "the scan must not resurrect the removed folder entry");
    assert.equal(path.basename(saved.folders[0].path), "music-a");
  } finally { h.cleanup(); }
});

test("the parsed store is cached across reads and invalidated by reset", async () => {
  const h = await loadLocalLibrary({ countReads: true });
  try {
    const music = mkMusicDir(h.dir, "music", 2);
    await h.api.addLibraryFolders([music]);
    await h.api.scanLibrary(false);
    const readsAfterSetup = h.reads();
    // Hot path: every local-media range request resolves through the store —
    // repeated reads must not re-parse the file from disk.
    for (let i = 0; i < 50; i++) h.api.localTrackById(h.api.readLocalLibrary().tracks[0].id);
    assert.equal(h.reads(), readsAfterSetup, "repeated reads must be served from the cache");
    // A save updates the cache in place (no re-parse), and a reset invalidates.
    await h.api.renameLibraryFolder(music, "Renamed");
    assert.equal(h.reads(), readsAfterSetup, "a save must refresh the cache without a disk re-read");
    assert.equal(h.api.readLocalLibrary().folders[0].displayName, "Renamed");
    await h.api.resetLocalLibrary();
    h.api.readLocalLibrary();
    assert.ok(h.reads() > readsAfterSetup, "a reset must invalidate the cache");
  } finally { h.cleanup(); }
});

test("mutating saves commit in call order — the last mutation wins", async () => {
  const h = await loadLocalLibrary();
  try {
    const a = mkMusicDir(h.dir, "music-a", 3);
    const b = mkMusicDir(h.dir, "music-b", 2);
    await h.api.setLibraryFolders([a]);
    await h.api.renameLibraryFolder(a, "First");
    await h.api.setLibraryFolders([a, b]);
    const saved = h.api.readLocalLibrary();
    assert.equal(saved.folders.length, 2);
    assert.equal(saved.folders[0].displayName, "First");
  } finally { h.cleanup(); }
});
