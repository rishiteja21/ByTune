import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createVisualActivity } from "../.test-build/visual-activity.mjs";
import { observeWindowActivity, activityState } from "../.test-build/window-activity-client.mjs";
import { trackWindowActivity, getWindowActivity, hideWindow } from "../.test-build/window-activity-native.mjs";

function frames() {
  let id = 0;
  const pending = new Map();
  return {
    request(cb) { pending.set(++id, cb); return id; },
    cancel(id) { pending.delete(id); },
    advance(now) { const callbacks = [...pending.values()]; pending.clear(); for (const cb of callbacks) cb(now); },
    get size() { return pending.size; },
  };
}

test("visual frames stop, preserve elapsed time and never multiply over rapid switches", () => {
  const activity = createVisualActivity(true);
  const clock = frames();
  const elapsed = [];
  const stop = activity.runFrames((_, delta) => { elapsed.push(delta); }, clock);
  clock.advance(10);
  clock.advance(26);
  assert.deepEqual(elapsed, [0, 16]);
  activity.setActive(false);
  assert.equal(clock.size, 0);
  clock.advance(5000);
  for (let i = 0; i < 50; i++) { activity.setActive(true); activity.setActive(false); }
  activity.setActive(true);
  activity.setActive(true);
  assert.equal(clock.size, 1);
  clock.advance(10000);
  assert.deepEqual(elapsed, [0, 16, 0], "background time is not replayed");
  assert.equal(clock.size, 1);
  stop(); stop();
  activity.setActive(false); activity.setActive(true);
  assert.equal(clock.size, 0, "unmounted loop cannot resume");
});

test("frames registered inactive wait; finite work and disposal inside a callback stay stopped", () => {
  const activity = createVisualActivity();
  const clock = frames();
  let count = 0;
  activity.runFrames(() => { count++; return false; }, clock);
  assert.equal(clock.size, 0);
  activity.setActive(true);
  clock.advance(1);
  activity.setActive(false); activity.setActive(true);
  assert.equal(count, 1);
  assert.equal(clock.size, 0);
  const stop = activity.runFrames(() => { stop(); }, clock);
  clock.advance(2);
  assert.equal(clock.size, 0);
});

function animation(playState = "running") {
  return {
    playState, currentTime: 1234, plays: 0, pauses: 0,
    pause() { this.playState = "paused"; this.pauses++; },
    play() { this.playState = "running"; this.plays++; },
  };
}

test("only registered running WAAPI effects pause and resume without restarting", () => {
  const activity = createVisualActivity(true);
  const decorative = animation();
  const interaction = animation();
  const alreadyPaused = animation("paused");
  activity.registerAnimation(decorative);
  activity.registerAnimation(alreadyPaused);
  activity.setActive(false);
  assert.equal(decorative.playState, "paused");
  assert.equal(interaction.playState, "running");
  activity.setActive(true);
  assert.equal(decorative.plays, 1);
  assert.equal(decorative.currentTime, 1234);
  assert.equal(alreadyPaused.plays, 0);
  activity.setActive(false);
  decorative.playState = "idle"; // cancelled on text/track replacement
  activity.setActive(true);
  assert.equal(decorative.playState, "idle");
});

test("new inactive effects pause immediately and unregistered effects stay untouched", () => {
  const activity = createVisualActivity();
  const effect = animation();
  const off = activity.registerAnimation(effect);
  assert.equal(effect.playState, "paused");
  off();
  activity.setActive(true);
  assert.equal(effect.plays, 0);
});

test("artwork video follows activity and current playback intent, including late play events", () => {
  const activity = createVisualActivity(true);
  const events = new EventTarget();
  const video = Object.assign(events, {
    paused: true, plays: 0,
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  let playing = true;
  const off = activity.registerVideo(video, () => playing);
  assert.equal(video.paused, false);
  activity.setActive(false);
  assert.equal(video.paused, true);
  video.paused = false;
  video.dispatchEvent(new Event("play"));
  assert.equal(video.paused, true, "asynchronous autoplay cannot escape inactivity");
  playing = false;
  activity.setActive(true);
  assert.equal(video.paused, true, "resuming visuals must not resume paused music artwork");
  playing = true;
  activity.setActive(false); activity.setActive(true);
  assert.equal(video.plays, 2);
  off();
  activity.setActive(false); activity.setActive(true);
  assert.equal(video.paused, true);
  assert.equal(video.plays, 2);
});

test("initial native snapshot cannot overwrite an event received during initialization", async () => {
  let receive, reply;
  let unsubscribed = false;
  const states = [];
  const off = observeWindowActivity({
    onWindowActivity(cb) { receive = cb; return () => { unsubscribed = true; }; },
    getWindowActivity() { assert.equal(typeof receive, "function"); return new Promise(resolve => { reply = resolve; }); },
  }, state => states.push(state));
  receive({ revision: 2, state: "hidden" });
  reply({ revision: 1, state: "focused" });
  await Promise.resolve();
  receive({ revision: 2, state: "hidden" });
  assert.deepEqual(states, [{ revision: 2, state: "hidden" }]);
  off(); receive({ revision: 3, state: "focused" });
  assert.equal(unsubscribed, true);
  assert.equal(states.length, 1);
});

test("disposal also ignores an initial snapshot still in flight", async () => {
  let reply;
  let count = 0;
  const off = observeWindowActivity({
    onWindowActivity() { return () => {}; },
    getWindowActivity() { return new Promise(resolve => { reply = resolve; }); },
  }, () => count++);
  off(); reply({ revision: 0 }); await Promise.resolve();
  assert.equal(count, 0);
});

class Window extends EventEmitter {
  constructor(id) {
    super(); this.id = id; this.visible = false; this.focused = false; this.minimized = false;
    this.sent = [];
    this.webContents = { id, isDestroyed: () => false, send: (channel, state) => this.sent.push({ channel, state }) };
  }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  isDestroyed() { return false; }
  hide() { this.visible = false; this.focused = false; }
}

test("native states use event flags, survive reload snapshots and stay isolated per window", () => {
  const main = new Window(1), pip = new Window(2);
  for (const win of [main, pip]) trackWindowActivity(win, e => e.sender === win.webContents && e.trusted);
  const read = win => getWindowActivity({ sender: win.webContents, trusted: true });
  assert.equal(read(main).state, "hidden");
  main.visible = true; main.focused = true; main.emit("show"); main.emit("focus");
  assert.equal(main.sent.at(-1).state.state, "focused");
  main.focused = false;
  main.emit("blur"); assert.equal(read(main).state, "unfocused");
  main.emit("minimize"); main.minimized = true; assert.equal(read(main).state, "minimized");
  main.visible = true; main.minimized = false; main.emit("restore"); assert.equal(read(main).state, "unfocused");
  main.emit("focus"); main.visible = false; main.emit("hide");
  pip.visible = true; pip.focused = true;
  pip.emit("show"); pip.emit("focus");
  assert.equal(read(main).state, "hidden");
  assert.equal(read(pip).state, "focused");
  assert.equal(read(pip).windowId, 2);
  const current = read(main);
  assert.deepEqual(read(main), current, "a renderer reload receives current state without another native event");
  assert.throws(() => getWindowActivity({ sender: pip.webContents, trusted: false }), /Untrusted/);
  assert.throws(() => getWindowActivity({}), /Untrusted/);
  assert.throws(() => getWindowActivity(null), /Untrusted/);
  main.emit("closed"); pip.emit("closed");
  assert.equal(main.listenerCount("focus"), 0);
  assert.throws(() => read(main), /Untrusted/);
});

test("macOS implicit show and a fresh snapshot reconcile native flags without a show event", () => {
  const win = new Window(3);
  trackWindowActivity(win, () => true);
  win.visible = true; win.focused = true; win.emit("focus");
  assert.equal(win.sent.at(-1).state.state, "focused");
  win.focused = false; win.emit("blur");
  assert.equal(win.sent.at(-1).state.state, "unfocused");
  win.visible = false;
  assert.equal(getWindowActivity({ sender: win.webContents }).state, "hidden");
  win.emit("closed");
});

test("Space-transition hide events reconcile to native visibility on the next turn", async () => {
  const win = new Window(4);
  win.visible = true; win.focused = true;
  trackWindowActivity(win, () => true);
  win.emit("hide");
  assert.equal(win.sent.at(-1).state.state, "hidden");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.sent.at(-1).state.state, "focused");
  win.emit("closed");
});

function immediates(t) {
  let id = 0;
  const pending = new Map();
  t.mock.method(globalThis, "setImmediate", (cb) => { pending.set(++id, cb); return id; });
  t.mock.method(globalThis, "clearImmediate", (key) => { pending.delete(key); });
  return {
    flush() { const callbacks = [...pending.values()]; pending.clear(); for (const cb of callbacks) cb(); },
    get size() { return pending.size; },
  };
}

test("an already occluded window reports hidden when native hide emits no new event", (t) => {
  const clock = immediates(t);
  const win = new Window(10);
  win.visible = true;
  trackWindowActivity(win, () => true);
  win.emit("hide"); // Cocoa occlusion notification during blur, still ordered in.
  clock.flush();
  assert.equal(win.sent.at(-1).state.state, "unfocused");
  hideWindow(win); // Actual orderOut, with no additional native notification.
  assert.equal(win.visible, false);
  assert.equal(win.sent.at(-1).state.state, "hidden", "no snapshot request needed to repair state");
  assert.equal(clock.size, 0, "operation completion cancels the earlier reconciliation");
  win.emit("closed");
});

test("reentrant events and snapshots cannot resume visuals inside native hide", (t) => {
  const clock = immediates(t);
  const win = new Window(11);
  win.visible = true; win.focused = true;
  trackWindowActivity(win, () => true);
  win.hide = () => {
    for (const event of ["show", "focus", "blur", "restore"]) win.emit(event);
    clock.flush();
    assert.equal(getWindowActivity({ sender: win.webContents }).state, "hidden");
    assert.ok(win.sent.every(({ state }) => state.state !== "focused"));
    // The getters settle before the native call returns, after its callbacks.
    win.visible = false; win.focused = false;
  };
  hideWindow(win);
  assert.equal(win.sent.at(-1).state.state, "hidden");
  assert.equal(clock.size, 0);
  win.emit("closed");
});

test("rapid hide/show uses the latest native state, including delayed positive events", (t) => {
  const clock = immediates(t);
  const win = new Window(12);
  trackWindowActivity(win, () => true);
  for (let i = 0; i < 50; i++) {
    win.visible = true; win.focused = true; win.emit("show"); win.emit("focus");
    hideWindow(win);
    // Queued notifications from the show must not resurrect this hidden window.
    win.emit("focus"); win.emit("show"); win.emit("restore");
    assert.equal(win.sent.at(-1).state.state, "hidden");
    assert.equal(clock.size, 1);
    clock.flush();
    assert.equal(win.sent.at(-1).state.state, "hidden");
    win.visible = true; win.focused = true; win.emit("show"); win.emit("focus");
    clock.flush();
    assert.equal(win.sent.at(-1).state.state, "focused");
  }
  assert.ok(win.sent.every(({ state }, i) => i === 0 || state.revision > win.sent[i - 1].state.revision));
  win.emit("closed");
  assert.equal(clock.size, 0);
});

test("minimize/restore and blur/focus stay correct after explicit hiding", (t) => {
  const clock = immediates(t);
  const win = new Window(13);
  trackWindowActivity(win, () => true);
  hideWindow(win);
  win.visible = true; win.focused = true; win.emit("focus");
  win.emit("minimize");
  assert.equal(win.sent.at(-1).state.state, "minimized", "suspend before native flags settle");
  win.minimized = true; win.visible = false; win.focused = false;
  clock.flush();
  assert.equal(win.sent.at(-1).state.state, "minimized");
  win.minimized = false; win.visible = true; win.emit("restore"); clock.flush();
  assert.equal(win.sent.at(-1).state.state, "unfocused");
  win.focused = true; win.emit("focus"); clock.flush();
  assert.equal(win.sent.at(-1).state.state, "focused");
  win.emit("blur");
  assert.equal(win.sent.at(-1).state.state, "unfocused");
  win.focused = false; clock.flush();
  assert.equal(win.sent.at(-1).state.state, "unfocused");
  win.emit("closed");
});

test("window registrations coalesce callbacks, stay isolated and clean up exactly once", (t) => {
  const clock = immediates(t);
  const main = new Window(14), pip = new Window(15);
  for (const win of [main, pip]) {
    win.visible = true; win.focused = true;
    trackWindowActivity(win, () => true);
    trackWindowActivity(win, () => true);
    assert.equal(win.listenerCount("focus"), 1);
    assert.equal(win.listenerCount("closed"), 1);
    for (let i = 0; i < 20; i++) win.emit("show");
  }
  assert.equal(clock.size, 2, "one task per window");
  hideWindow(main);
  assert.equal(clock.size, 1, "only the main window's pending task was cancelled");
  assert.equal(getWindowActivity({ sender: pip.webContents }).state, "focused");
  assert.equal(main.sent.at(-1).state.state, "hidden");
  pip.emit("closed"); main.emit("closed");
  assert.equal(clock.size, 0);
  for (const win of [main, pip]) {
    assert.equal(win.listenerCount("show"), 0);
    assert.equal(win.listenerCount("focus"), 0);
    assert.throws(() => hideWindow(win), /not registered/);
    assert.throws(() => getWindowActivity({ sender: win.webContents }), /Untrusted/);
  }
});

test("failed native hide restores real state and releases the suspension guard", (t) => {
  const clock = immediates(t);
  const win = new Window(16);
  win.visible = true; win.focused = true;
  trackWindowActivity(win, () => true);
  win.hide = () => { throw new Error("native hide failed"); };
  assert.throws(() => hideWindow(win), /native hide failed/);
  assert.equal(win.sent.at(-1).state.state, "focused");
  assert.equal(clock.size, 0);
  win.emit("closed");
});

test("minimized takes precedence over Electron's sometimes-invisible minimized flag", () => {
  assert.equal(activityState({ visible: false, focused: false, minimized: true }), "minimized");
});
