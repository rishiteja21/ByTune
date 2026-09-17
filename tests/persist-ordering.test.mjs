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

test("reset removes listening signals and artist cache but preserves downloaded audio", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-"));
  try {
    const { outputFiles } = await build({
      entryPoints: [fileURLToPath(new URL("../electron/persist.ts", import.meta.url))],
      bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
    });
    const module = { exports: {} };
    vm.runInNewContext(outputFiles[0].text, {
      module, exports: module.exports, setTimeout, console,
      require: (name) => name === "electron" ? { app: { getPath: () => dir } } : require(name),
    });
    const { writeData, resetAppData } = module.exports;
    await writeData("listening-signals", { state: { skips: { artist: { count: 2 } } } });
    await writeData("artist-meta-cache", { state: { entries: { artist: { id: "artist" } } } });
    const audio = path.join(dir, "downloaded.mp3");
    fs.writeFileSync(audio, "user audio");
    await resetAppData();
    for (const name of ["listening-signals", "artist-meta-cache"]) {
      assert.equal(fs.existsSync(path.join(dir, "data", `${name}.json`)), false);
    }
    assert.equal(fs.readFileSync(audio, "utf8"), "user audio");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same-file writes commit in invocation order and snapshot mutable input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-write-order-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/persist.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
  });
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const writes = [];
  const fakeFs = {
    ...fs,
    promises: {
      ...fs.promises,
      async writeFile(file, json, ...args) {
        writes.push(JSON.parse(json).revision);
        if (writes.length === 1) {
          firstStarted();
          await gate;
        }
        return fs.promises.writeFile(file, json, ...args);
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, setTimeout, console,
    require(name) {
      if (name === "electron") return { app: { getPath: () => dir } };
      if (name === "fs") return fakeFs;
      return require(name);
    },
  });
  const { writeData, readData } = module.exports;
  let older;
  let newer;
  try {
    older = writeData("library", { revision: 1 });
    await started;
    const mutable = { revision: 2 };
    // Both names resolve to the same file and must share one queue.
    newer = writeData("lib/rary", mutable);
    mutable.revision = 3;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [1], "newer write must wait for the older write to finish");
    releaseFirst();
    await Promise.all([older, newer]);
    assert.deepEqual(writes, [1, 2]);
    assert.equal(readData("library").revision, 2);
  } finally {
    releaseFirst();
    await Promise.allSettled([older, newer].filter(Boolean));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
