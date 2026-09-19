/** Boot-time download reconciliation (quit during download must stay retryable). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { staleDownloadIds } from "../.test-build/download-reconcile.mjs";

test("stale queued/downloading rows absent from the live queue are failed", () => {
  const registry = {
    "track-1": { status: "downloading", progress: 0.4 },
    "track-2": { status: "queued" },
    "track-3": { status: "done" },
    "track-4": { status: "failed" },
  };
  const live = []; // main queue is memory-only: empty after a restart
  assert.deepEqual(staleDownloadIds(registry, live), ["track-1", "track-2"]);
});

test("rows still present in the live snapshot are left alone", () => {
  const registry = {
    "track-1": { status: "downloading" },
    "track-2": { status: "queued" },
  };
  assert.deepEqual(staleDownloadIds(registry, ["track-1"]), ["track-2"]);
});

test("done/failed rows are never touched, and junk entries are ignored", () => {
  const registry = {
    "a": { status: "done" },
    "b": { status: "failed" },
    "c": {},
    "d": null,
  };
  assert.deepEqual(staleDownloadIds(registry, []), []);
});

test("an absent or malformed registry yields nothing", () => {
  assert.deepEqual(staleDownloadIds(undefined, []), []);
  assert.deepEqual(staleDownloadIds(null, ["x"]), []);
});
