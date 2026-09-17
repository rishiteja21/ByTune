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

/** Load the REAL data-transition + persist pair against a scratch profile. */
async function loadTransition() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-shutdown-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/data-transition.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, setTimeout, console,
    require: (name) => (name === "electron" ? { app: { getPath: () => dir } } : require(name)),
  });
  return { mod: module.exports, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("drainData waits for writes accepted during the drain before returning", async () => {
  const h = await loadTransition();
  try {
    let releaseSecond;
    const gate = new Promise((resolve) => { releaseSecond = resolve; });
    let secondFinished = false;
    // An already-running job, then a queued one whose write only lands after
    // the drain has started — shutdown must not cut it off.
    const first = h.mod.serializeData(async () => undefined);
    const second = h.mod.serializeData(async () => {
      await gate;
      await h.mod.writeForDocument("player", { position: 42 }, h.mod.documentScope());
      secondFinished = true;
    });
    const drain = h.mod.drainData();
    await first;
    releaseSecond();
    await drain;
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, "data", "player.json"), "utf8"));
    assert.equal(onDisk.position, 42, "the write accepted during the drain must be durable when drainData resolves");
    assert.ok(secondFinished, "drainData resolved only after the late job finished");
  } finally { h.cleanup(); }
});

test("drainData resolves despite a rejected queued job", async () => {
  const h = await loadTransition();
  try {
    h.mod.serializeData(async () => { throw new Error("queued job failed"); });
    await h.mod.drainData();
    assert.ok(true, "no hang, no throw");
  } finally { h.cleanup(); }
});
