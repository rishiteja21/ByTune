import test from "node:test";
import assert from "node:assert/strict";
import { TOMBSTONE_LIMIT, compactDeletionSync, joinDeletionSync, membershipSurvives,
  mergeDeletionRecords, readDeletionSync, recordDeletionChanges, deletionKey as key } from "../.test-build/deletion-sync.mjs";
const empty = () => readDeletionSync(null);
const track = (id) => ({ id });
const meta = (field, group, id, at, parent) => readDeletionSync({ ...empty(), [field]: { [key(group, id, parent)]: at } });
function at(now, fn) { const original = Date.now; Date.now = () => now; try { return fn(); } finally { Date.now = original; } }

test("explicit live additions use strictly increasing clocks within one tick and after clock rollback", () => {
  let state = { liked: [track("a")] };
  state.deletionSync = at(1000, () => recordDeletionChanges({}, state, [{ kind: "add", group: "liked", id: "a" }]));
  assert.equal(state.deletionSync.adds[key("liked", "a")], 1000);
  const next = { liked: [track("a"), track("b")] };
  next.deletionSync = at(1000, () => recordDeletionChanges(state, next, [{ kind: "add", group: "liked", id: "b" }]));
  assert.equal(next.deletionSync.adds[key("liked", "b")], 1001);
  const deleted = at(500, () => recordDeletionChanges(next, { liked: [track("a")] }, [{ kind: "delete", group: "liked", id: "b" }]));
  assert.equal(deleted.deletes[key("liked", "b")], 1002);
  assert.equal(deleted.adds[key("liked", "b")], undefined);
});

for (const group of ["liked", "playlists", "tracks", "folders", "followedArtists", "history", "searches"]) {
  test(`${group}: deletion beats unchanged, tie deletes, later explicit add wins`, () => {
    const parent = group === "tracks" ? "p" : undefined;
    const deleted = meta("deletes", group, "x", 100, parent);
    for (const added of [0, 99, 100, 101]) {
      const source = added ? meta("adds", group, "x", added, parent) : empty();
      const joined = joinDeletionSync(source, deleted);
      assert.equal(membershipSurvives(source, joined, group, "x", parent), added > 100);
      assert.ok(membershipSurvives(source, joined, group, "unrelated", parent));
    }
  });
}

test("edits never count as membership adds", () => {
  const edited = meta("edits", "playlists", "p", 200);
  const deleted = meta("deletes", "playlists", "p", 100);
  assert.equal(membershipSurvives(edited, joinDeletionSync(edited, deleted), "playlists", "p"), false);
});

test("legacy absence is not deletion and real additions union deterministically", () => {
  const am = meta("adds", "liked", "a", 100), bm = meta("adds", "liked", "b", 100);
  const joined = joinDeletionSync(am, bm);
  const merge = (a, b, x, y) => mergeDeletionRecords(a, b, x, y, joined, "liked", (t) => t?.id);
  const first = merge([track("a"), track("legacy")], [track("b")], am, bm);
  assert.deepEqual(first, [track("a"), track("b"), track("legacy")]);
  assert.deepEqual(merge([track("b")], [track("legacy"), track("a")], bm, am), first);
  assert.deepEqual(merge(first, first, joined, joined), first);
});

test("track keys are scoped and delimiter-safe", () => {
  assert.notEqual(key("tracks", "b:c", "a"), key("tracks", "c", "a:b"));
  const deleted = meta("deletes", "tracks", "s", 100, "p1");
  assert.ok(membershipSurvives(empty(), deleted, "tracks", "s", "p2"));
  assert.ok(membershipSurvives(empty(), deleted, "liked", "s"));
});

for (const group of ["history", "searches"]) test(`${group}: clear suppresses even unseen old ids but permits newer adds`, () => {
  const cleared = readDeletionSync({ ...empty(), clears: { [group]: 100 } });
  assert.equal(membershipSurvives(empty(), cleared, group, "unseen"), false);
  const newer = meta("adds", group, "new", 101);
  assert.ok(membershipSurvives(newer, joinDeletionSync(cleared, newer), group, "new"));
});

test("compaction bounds tombstones; persistent floor prevents stale resurrection without aging away", () => {
  let state = { liked: [track("survivor")] };
  for (let i = 1; i <= TOMBSTONE_LIMIT + 50; i++) {
    state.deletionSync = at(i, () => recordDeletionChanges(state, {}, [{ kind: "delete", group: "liked", id: `gone-${i}` }]));
  }
  const full = state.deletionSync;
  assert.equal(Object.keys(full.deletes).length, TOMBSTONE_LIMIT);
  assert.equal(full.floor, 50);
  assert.equal(full.deletes[key("liked", "gone-1")], undefined);
  assert.equal(membershipSurvives(empty(), full, "liked", "gone-1"), false);
  assert.equal(membershipSurvives(meta("adds", "liked", "gone-1", 50), full, "liked", "gone-1"), false);
  assert.ok(membershipSurvives(meta("adds", "liked", "fresh", 51), full, "liked", "fresh"));
  assert.ok(membershipSurvives(full, full, "liked", "survivor"));
  const killer = meta("deletes", "liked", "survivor", 60);
  assert.equal(membershipSurvives(full, joinDeletionSync(full, killer), "liked", "survivor"), false);
  assert.deepEqual(compactDeletionSync(full, state), full);
});

test("metadata growth follows live records plus bounded deletes, not historical additions", () => {
  let state = { history: [] };
  for (let i = 1; i <= 1000; i++) {
    const next = { history: [track(`h${i}`)] };
    state = { ...next, deletionSync: at(i, () => recordDeletionChanges(state, next, [{ kind: "add", group: "history", id: `h${i}` }])) };
  }
  assert.equal(Object.keys(state.deletionSync.adds).length, 1);
  assert.equal(Object.keys(state.deletionSync.deletes).length, 0);
  assert.equal(state.deletionSync.clock, 1000);
});

test("malformed metadata is ignored without poisoning clocks/prototypes", () => {
  for (const value of [null, "bad", [], { schema: 2 }]) assert.deepEqual(readDeletionSync(value), empty());
  const bad = { ...empty(), clock: Infinity, floor: -1, adds: { junk: 100, [key("liked", "x")]: "99" },
    deletes: { [key("liked", "x")]: NaN }, clears: { liked: 99 } };
  assert.deepEqual(readDeletionSync(bad), empty());
  assert.deepEqual(mergeDeletionRecords(null, "bad", empty(), empty(), empty(), "liked", (t) => t?.id), []);
});
