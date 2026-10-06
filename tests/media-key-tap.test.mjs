import { test } from "node:test";
import assert from "node:assert/strict";
import { createMediaKeyTap, MEDIA_KEY_DOUBLE_TAP_MS } from "../.test-build/media-key-tap.mjs";

/**
 * Fake one-shot scheduler: each scheduled window is recorded so tests can
 * cancel-check it and fire it (settle) deterministically — no real clocks.
 */
function harness() {
  const timers = [];
  const fired = { single: [], multi: 0 };
  const tap = createMediaKeyTap(
    {
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false, done: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
    },
    { single: (kind) => fired.single.push(kind), multi: () => (fired.multi += 1) },
  );
  return {
    tap,
    fired,
    liveCount: () => timers.filter((t) => !t.cancelled && !t.done).length,
    lastMs: () => timers[timers.length - 1].ms,
    /** fire the one live recognition window */
    settle() {
      const live = timers.filter((t) => !t.cancelled && !t.done);
      assert.equal(live.length, 1, "expected exactly one live recognition window");
      live[0].done = true;
      live[0].fn();
    },
  };
}

test("single press applies the pressed command once, after the window", () => {
  const h = harness();
  h.tap.press("pause");
  h.settle();
  assert.deepEqual(h.fired.single, ["pause"]);
  assert.equal(h.fired.multi, 0);
});

test("single press of play applies play", () => {
  const h = harness();
  h.tap.press("play");
  h.settle();
  assert.deepEqual(h.fired.single, ["play"]);
  assert.equal(h.fired.multi, 0);
});

test("double press cancels the pending single and advances exactly once", () => {
  const h = harness();
  h.tap.press("pause");
  h.tap.press("pause");
  // The first window was replaced, not stacked.
  assert.equal(h.liveCount(), 1);
  h.settle();
  assert.equal(h.fired.multi, 1, "next track exactly once");
  assert.deepEqual(h.fired.single, [], "no play/pause leaked");
});

test("double press works across play/pause kinds (state-conditional events)", () => {
  // Chromium picks the action kind from player state, so a physical double
  // press can arrive as play→pause or pause→play. Both are two presses.
  for (const [a, b] of [["play", "pause"], ["pause", "play"], ["play", "play"], ["pause", "pause"]]) {
    const h = harness();
    h.tap.press(a);
    h.tap.press(b);
    h.settle();
    assert.equal(h.fired.multi, 1, `${a}+${b} → next once`);
    assert.deepEqual(h.fired.single, []);
  }
});

test("two presses outside the window are two independent play/pause actions", () => {
  const h = harness();
  h.tap.press("pause");
  h.settle();
  h.tap.press("play");
  h.settle();
  assert.deepEqual(h.fired.single, ["pause", "play"]);
  assert.equal(h.fired.multi, 0);
});

test("triple press advances exactly once — no double skip", () => {
  const h = harness();
  h.tap.press("pause");
  h.tap.press("play");
  h.tap.press("pause");
  h.settle();
  assert.equal(h.fired.multi, 1);
  assert.deepEqual(h.fired.single, []);
});

test("held button collapses into one action — repeats cannot machine-gun", () => {
  const h = harness();
  for (let i = 0; i < 6; i++) h.tap.press(i % 2 ? "play" : "pause");
  assert.equal(h.liveCount(), 1, "one window, continuously pushed out");
  h.settle();
  assert.equal(h.fired.multi, 1, "exactly one action when the hold ends");
});

test("state resets after a multi: the next press is a fresh single", () => {
  const h = harness();
  h.tap.press("pause");
  h.tap.press("pause");
  h.settle();
  h.tap.press("play");
  h.settle();
  assert.deepEqual(h.fired.single, ["play"]);
  assert.equal(h.fired.multi, 1);
});

test("cancelPending drops a pending single press entirely", () => {
  const h = harness();
  h.tap.press("pause");
  h.tap.cancelPending();
  assert.equal(h.liveCount(), 0, "the recognition window is gone");
  assert.deepEqual(h.fired.single, [], "nothing fired");
  assert.equal(h.fired.multi, 0);
});

test("cancelPending is safe when nothing is pending, and does not poison the next press", () => {
  const h = harness();
  h.tap.cancelPending();
  assert.equal(h.liveCount(), 0);
  h.tap.press("play");
  h.settle();
  assert.deepEqual(h.fired.single, ["play"]);
});

test("a cancelled press does not swallow the next press", () => {
  const h = harness();
  h.tap.press("pause");
  h.tap.cancelPending();
  h.tap.press("play");
  h.settle();
  assert.deepEqual(h.fired.single, ["play"]);
  assert.equal(h.fired.multi, 0);
});

test("recognition window is the Windows double-click default (500ms)", () => {
  assert.equal(MEDIA_KEY_DOUBLE_TAP_MS, 500);
  const h = harness();
  h.tap.press("pause");
  assert.equal(h.lastMs(), MEDIA_KEY_DOUBLE_TAP_MS);
  h.tap.press("pause");
  assert.equal(h.lastMs(), MEDIA_KEY_DOUBLE_TAP_MS, "window measured press-to-press");
});
