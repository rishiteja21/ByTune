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

test("production stats timer stays cleared after the real five-second deadline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-stats-real-timer-"));
  let stats;
  try {
    const { outputFiles } = await build({
      entryPoints: [fileURLToPath(new URL("../electron/stats.ts", import.meta.url))],
      bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
    });
    const module = { exports: {} };
    vm.runInNewContext(outputFiles[0].text, {
      module, exports: module.exports, console, setTimeout, clearTimeout,
      require: (name) => name === "electron" ? { app: { getPath: () => dir } } : require(name),
    });
    stats = module.exports;
    stats.initStats();
    stats.recordListening({ id: "old", title: "Old", artist: "Artist", duration: 60, thumb: "" }, 30_000);
    stats.resetStats();
    fs.rmSync(path.join(dir, "data", "listening-history.json"), { force: true });
    await new Promise((resolve) => setTimeout(resolve, 5_150));
    assert.equal(fs.existsSync(path.join(dir, "data", "listening-history.json")), false);
    assert.equal(stats.summary("month").totalMs, 0);
    stats.flushSync();
    assert.equal(fs.existsSync(path.join(dir, "data", "listening-history.json")), false);
  } finally {
    stats?.resetStats();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset cancels stats flush and clears cached buckets and play-credit state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-stats-reset-"));
  try {
    const { outputFiles } = await build({
      entryPoints: [fileURLToPath(new URL("../electron/stats.ts", import.meta.url))],
      bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
    });
    const timers = new Set();
    const module = { exports: {} };
    vm.runInNewContext(outputFiles[0].text, {
      module, exports: module.exports, console,
      setTimeout(fn) { timers.add(fn); return fn; },
      clearTimeout(fn) { timers.delete(fn); },
      require: (name) => name === "electron" ? { app: { getPath: () => dir } } : require(name),
    });
    const stats = module.exports;
    const track = { id: "played", title: "Played", artist: "Artist", duration: 60, thumb: "" };
    stats.initStats();
    stats.recordListening(track, 30_000);
    assert.equal(timers.size, 1);
    const staleCallback = [...timers][0];
    stats.resetStats();
    fs.rmSync(path.join(dir, "data", "listening-history.json"), { force: true });
    assert.equal(timers.size, 0);
    staleCallback();
    stats.flushSync();
    assert.equal(fs.existsSync(path.join(dir, "data", "listening-history.json")), false);
    assert.equal(stats.summary("month").totalMs, 0);
    stats.recordListening(track, 30_000);
    stats.flushSync();
    assert.equal(stats.summary("month").totalMs, 30_000);
    assert.equal(stats.summary("month").plays, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
