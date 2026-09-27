/**
 * Auto Mix: interrupting a blend must cancel it cleanly.
 *
 * A pause, skip, seek, queue edit or settings change while a blend is running
 * tears the standby deck down — that is a deliberate cancellation, and the
 * only thing that must never happen is the old transition's callback firing
 * later and starting a track the user has moved past.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { boot, decksOf, firstSoundAt, flushMicrotasks, play, read, restartedFrom, sounding, startsOf, track } from "./automix-harness.mjs";

/** A: 3s, and its stream outlasts the 0.6s blend so nothing ends mid-test. */
function stage(h, extra = []) {
  h.setDuration("A", 3.0);
  h.setStreamEnd("A", 3.2);
  for (const id of extra) h.setDuration(id, 4.0);
  return [track("A", 3.0), ...extra.map((id) => track(id, 4.0))];
}

test("pause during a blend freezes it; resume still promotes the same deck", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  await play(h, stage(h, ["B"]));

  await h.advance(2700); // mid-blend
  assert.equal(decksOf(h, "B").length, 1, "song B should be on the standby deck");
  const blendEl = decksOf(h, "B")[0].el;
  usePlayer.getState().setPlaying(false);
  await flushMicrotasks();

  const frozen = decksOf(h, "B")[0].currentTime;
  await h.advance(2000);
  assert.equal(read(h).id, "A", "a paused blend must not complete on its own");
  assert.ok(Math.abs(decksOf(h, "B")[0].currentTime - frozen) < 0.05, "song B must be frozen while paused");
  assert.equal(sounding(h).length, 0, "nothing may sound while paused");

  usePlayer.getState().setPlaying(true);
  await flushMicrotasks();
  await h.advance(1500);
  const s = read(h);
  assert.equal(s.id, "B", "the blend must complete on resume");
  assert.equal(restartedFrom(h, "B"), false, "resuming must not restart song B");
  assert.equal(decksOf(h, "B")[0].el, blendEl, "the same deck must be promoted after resume");
  assert.ok(s.position > frozen, `song B must continue from ~${frozen}s, got ${s.position}s`);
  assert.equal(startsOf(h, "B").length, 1);
});

test("manual next during a blend promotes the fading-in track instead of replaying it", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  await play(h, stage(h, ["B", "C"]));

  await h.advance(2700);
  const deck = decksOf(h, "B")[0];
  assert.ok(deck, "song B should be mid-blend before the skip");
  assert.ok(deck.currentTime > 0.1, "song B should be audible before the skip");
  usePlayer.getState().next(true); // from A this resolves to B, the fading-in track
  await flushMicrotasks();
  await h.advance(300);

  assert.equal(read(h).id, "B", "the skip must land on the track that was fading in");
  assert.equal(restartedFrom(h, "B"), false, "the skip must not replay song B from the top");
  const live = sounding(h);
  assert.equal(live.length, 1, `exactly one deck may sound, saw ${live.map((d) => d.src).join(" + ")}`);
  assert.equal(live[0].src, "fake:B");
  assert.equal(live[0].el, deck.el, "the same deck must be promoted");
  assert.ok(live[0].currentTime > deck.currentTime, "the promoted deck must keep advancing");
  assert.equal(startsOf(h, "B").length, 1, "song B must be initialised exactly once");

  // A second skip from the now-active track behaves normally.
  usePlayer.getState().next(true);
  await flushMicrotasks();
  await h.advance(300);
  assert.equal(read(h).id, "C");
  const after = sounding(h);
  assert.equal(after.length, 1, "still only one deck");
  assert.equal(after[0].src, "fake:C");
  assert.ok(after[0].currentTime < 0.35, "the next track past the blend starts at the top");
});

test("manual previous during a blend cancels it cleanly", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  h.setDuration("Z", 4.0);
  await play(h, [track("Z", 4.0), ...stage(h, ["B"])], 1);

  await h.advance(2700);
  assert.equal(decksOf(h, "B").length, 1, "song B should be mid-blend before the skip");
  usePlayer.getState().prev();
  await flushMicrotasks();
  await h.advance(300);

  assert.equal(read(h).id, "Z", "previous must land on the track before the current one");
  const live = sounding(h);
  assert.equal(live.length, 1, `exactly one deck may sound, saw ${live.map((d) => d.src).join(" + ")}`);
  assert.equal(live[0].src, "fake:Z");
  assert.ok(live[0].currentTime < 0.35, "the skipped-to track must start at the top");
  assert.equal(sounding(h).filter((d) => d.src === "fake:B").length, 0, "the cancelled track must not keep sounding");
});

test("seek during a blend cancels it and leaves no stale callback behind", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  await play(h, stage(h, ["B"]));

  await h.advance(2700);
  assert.equal(decksOf(h, "B").length, 1, "song B should be mid-blend before the seek");
  usePlayer.getState().seek(1.0);
  await flushMicrotasks();
  await h.advance(500);

  assert.equal(sounding(h).filter((d) => d.src === "fake:B").length, 0, "the blend must be cancelled by the seek");
  const s = read(h);
  assert.equal(s.id, "A");
  // 500ms of playback have passed since the seek, so the position is the
  // seek target plus that — the point is that it is nowhere near the old one.
  assert.ok(s.position >= 1.0 && s.position < 1.7, `song A must resume from the seek target, got ${s.position}s`);

  // The engine re-arms a fresh transition to B from the new position, and
  // that one completes by promotion — the cancelled blend's callback never
  // comes back to restart the track.
  await h.advance(3000);
  const after = read(h);
  assert.equal(after.id, "B", "playback must reach the next track");
  const live = sounding(h);
  assert.equal(live.length, 1, `exactly one deck may sound, saw ${live.map((d) => d.src).join(" + ")}`);
  assert.equal(live[0].src, "fake:B");
  assert.equal(startsOf(h, "B").length, 1, "song B must be initialised exactly once after the seek");
  assert.ok(Math.abs(after.position - live[0].currentTime) < 0.3, "the store must follow the promoted deck");
  assert.ok(Number.isFinite(after.position) && after.position >= 0, `position must be real, got ${after.position}`);
});

test("removing the incoming track mid-blend stops its deck instead of orphaning it", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  await play(h, stage(h, ["B"]));

  await h.advance(2700);
  assert.equal(decksOf(h, "B").length, 1);
  usePlayer.getState().clearUpcoming(); // drops B while it is fading in
  await flushMicrotasks();
  await h.advance(2000);

  assert.equal(sounding(h).filter((d) => d.src === "fake:B").length, 0, "the removed track must not keep sounding");
  assert.equal(decksOf(h, "B").length, 0, "its deck must be released");
});

test("an incoming track shorter than the blend is promoted and the queue keeps moving", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  h.setStreamEnd("A", 3.2);
  h.setDuration("B", 0.3); // shorter than the 0.6s blend
  h.setDuration("C", 4.0);
  await play(h, [track("A", 3.0), track("B", 0.3), track("C", 4.0)]);

  await h.advance(4000);
  const s = read(h);
  assert.equal(s.id, "C", "playback must continue past the short track");
  assert.ok(Number.isFinite(s.position) && s.position >= 0, `position must be a real number, got ${s.position}`);
  assert.ok(Number.isFinite(s.duration) && s.duration >= 0, `duration must be a real number, got ${s.duration}`);
  const live = sounding(h);
  assert.equal(live.length, 1, `exactly one deck may sound, saw ${live.map((d) => d.src).join(" + ")}`);
  assert.equal(live[0].src, "fake:C");
  assert.ok(live[0].currentTime < 1.5, `playback must resume promptly, got ${live[0].currentTime}s`);
});

test("shuffle and repeat-one suppress pre-arming entirely", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  h.setDuration("A", 3.0);
  usePlayer.getState().toggleShuffle();
  await play(h, [track("A", 3.0), track("B", 4.0), track("C", 4.0)]);

  await h.advance(1200);
  assert.equal(firstSoundAt(h, "B"), Infinity, "shuffle must not pre-arm a transition");
  assert.equal(firstSoundAt(h, "C"), Infinity, "shuffle must not pre-arm a transition");

  usePlayer.getState().toggleShuffle();
  usePlayer.getState().cycleRepeat(); // off -> all
  usePlayer.getState().cycleRepeat(); // all -> one
  assert.equal(usePlayer.getState().repeat, "one");
  h.trace.length = 0;
  (h.elements.emits ?? []).length = 0;
  h.record();
  await h.advance(2500);
  assert.equal(firstSoundAt(h, "B"), Infinity, "repeat-one must not pre-arm a transition");
  const live = sounding(h);
  assert.equal(live.length, 1);
  assert.equal(live[0].src, "fake:A", "repeat-one must replay the same track");
  assert.ok(live[0].currentTime < 0.8, "repeat-one must restart the track from the top");
});

test("a playback-rate change mid-blend applies to both decks and restarts nothing", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { useSettings } = h.engine;
  await play(h, stage(h, ["B"]));

  await h.advance(2700);
  useSettings.getState().setPlaybackSpeed(1.5);
  await flushMicrotasks();
  assert.equal(h.elements.every((e) => e.playbackRate === 1.5), true, "both decks must take the new rate");
  await h.advance(1500);

  assert.equal(read(h).id, "B");
  assert.equal(restartedFrom(h, "B"), false, "a rate change must not restart the incoming track");
  assert.equal(sounding(h).length, 1);
});

test("rapid next clicks during a blend never leave two decks sounding", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  h.setDuration("D", 4.0);
  await play(h, stage(h, ["B", "C", "D"]));

  await h.advance(2700);
  usePlayer.getState().next(true);
  usePlayer.getState().next(true);
  usePlayer.getState().next(true);
  await flushMicrotasks();
  await h.advance(400);

  assert.equal(read(h).id, "D");
  const live = sounding(h);
  assert.equal(live.length, 1, `exactly one deck may sound, saw ${live.map((d) => d.src).join(" + ")}`);
  assert.equal(live[0].src, "fake:D");
  assert.equal(startsOf(h, "D").length, 1, "the landing track must be initialised exactly once");
});

test("turning the crossfade off mid-blend still cancels it cleanly", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { useSettings } = h.engine;
  await play(h, stage(h, ["B", "C"]));

  await h.advance(2700);
  assert.equal(decksOf(h, "B").length, 1, "song B should be mid-blend");
  useSettings.getState().setCrossfadeSeconds(0);
  useSettings.getState().setSmartFade(false);
  await flushMicrotasks();
  // Nothing re-reads the setting mid-blend, so the run in progress finishes —
  // but it must finish by promoting, never by restarting.
  await h.advance(1500);
  assert.equal(read(h).id, "B");
  assert.equal(restartedFrom(h, "B"), false, "changing the setting must not restart the incoming track");
  assert.equal(sounding(h).length, 1);
});
