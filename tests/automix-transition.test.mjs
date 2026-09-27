/**
 * Auto Mix: the deck that starts during a blend must BECOME the session player,
 * not be rebuilt and restarted.
 *
 * These run the shipped audio engine (src/lib/audio.ts) against fake media
 * elements on a virtual clock, so the whole transition — arming, the equal
 * power blend, the outgoing track's natural `ended` and the promotion of the
 * incoming deck — is exercised as real code, deterministically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FADE_SEC,
  boot,
  decksOf,
  endedAt,
  firstAudible,
  firstSoundAt,
  mediaEvents,
  play,
  read,
  restartedFrom,
  sounding,
  startsOf,
  track,
} from "./automix-harness.mjs";

test("automix: the track that starts during the blend becomes active and keeps its position", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  // The stream runs out slightly before the duration it reports, so the
  // outgoing element's `ended` lands *before* the blend timer observes
  // completion. That ordering is what the shipping app hits, because the fade
  // timeline starts after an async resolve and a play().
  h.setStreamEnd("A", 2.95);
  h.setDuration("B", 4.0);
  h.setDuration("C", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0), track("C", 4.0)]);

  await h.advance(4000);

  // Song B really was audible during the blend, on a deck of its own.
  const audible = firstAudible(h, "B");
  assert.equal(audible.size, 1, `song B must reach the standby deck exactly once, saw ${audible.size}`);
  const [blendEl, blendStart] = [...audible][0];

  const s = read(h);
  assert.equal(s.id, "B", "song B must be the active track once the transition completes");
  assert.equal(restartedFrom(h, "B"), false, "song B's playback position must never jump back to zero");

  const decks = decksOf(h, "B");
  assert.equal(decks.length, 1, "song B must exist on exactly one element (no duplicate decks)");
  assert.equal(decks[0].el, blendEl, "the blended deck must be promoted, not recreated");
  assert.ok(
    decks[0].currentTime >= blendStart.currentTime + 0.2,
    `song B must continue from its blended position (~${(blendStart.currentTime + FADE_SEC).toFixed(2)}s), found ${decks[0].currentTime.toFixed(2)}s`
  );
  assert.ok(s.position > 0.2, `store position must track the media clock, found ${s.position}s`);
  assert.ok(Math.abs(s.position - decks[0].currentTime) < 0.25, "store position must follow the element clock");
  assert.equal(startsOf(h, "B").length, 1, "song B must be initialised exactly once");
});

test("automix: holds the incoming position when the blend completes before the outgoing track ends", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  // Outgoing track outlives the blend: the fade timer observes completion first.
  h.setDuration("A", 3.05);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.05), track("B", 4.0)]);

  await h.advance(4000);
  const s = read(h);
  assert.equal(s.id, "B");
  assert.ok(s.position > 0.2, `song B should already be seconds in, got ${s.position}s`);
  assert.equal(restartedFrom(h, "B"), false);
  assert.equal(startsOf(h, "B").length, 1);
});

test("automix: the blended deck is promoted, never reloaded", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  h.setStreamEnd("A", 2.95);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0)]);

  await h.advance(4000);
  const bPlays = mediaEvents(h, "B", "playing");
  assert.equal(bPlays.length, 1, `song B must be started exactly once, saw ${bPlays.length}`);
  assert.equal(bPlays[0].currentTime, 0, "song B must start at 0:00 on its own deck");
  assert.ok(endedAt(h, "A") < endedAt(h, "B"), "song A must end before song B");
  assert.equal(sounding(h).length, 1, "only the promoted deck may sound");
});

test("automix off: the next track starts at 0:00 and nothing plays early", async (t) => {
  const h = await boot({ fadeSeconds: 0 });
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0)]);

  await h.advance(4000);
  assert.ok(firstSoundAt(h, "B") >= endedAt(h, "A"), `song B must not start before song A ends (${firstSoundAt(h, "B")} vs ${endedAt(h, "A")})`);
  const started = startsOf(h, "B");
  assert.equal(started.length, 1);
  assert.ok(started[0].position < 0.2, `song B must start from the top, started at ${started[0].position}s`);
  const s = read(h);
  assert.equal(s.id, "B");
  assert.ok(s.position > 0.2, "song B should be playing after the switch");
  assert.equal(sounding(h).length, 1, "only one deck may sound");
});
