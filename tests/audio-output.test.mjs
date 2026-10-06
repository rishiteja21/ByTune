import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotOutputs, outputChangeAction, deviceChoices } from "../.test-build/audio-output.mjs";

const out = (deviceId, groupId) => ({ kind: "audiooutput", deviceId, groupId });
const mic = (deviceId, groupId) => ({ kind: "audioinput", deviceId, groupId });

// Fixtures shaped like real Chromium enumerations: a virtual `default` and
// `communications` entry whose groupId matches the backing physical device.
const SPEAKERS = "g-speakers";
const BT = "g-bt";
const USB = "g-usb";

const speakersOnly = [
  out("default", SPEAKERS),
  out("communications", SPEAKERS),
  out("phys-speakers", SPEAKERS),
];
const btActive = [
  out("default", BT),
  out("communications", BT),
  out("phys-bt-a2dp", BT),
  out("phys-bt-hfp", BT),
  out("phys-speakers", SPEAKERS),
];
const btAndSpeakers = [
  out("default", SPEAKERS),
  out("communications", SPEAKERS),
  out("phys-bt-a2dp", BT),
  out("phys-bt-hfp", BT),
  out("phys-speakers", SPEAKERS),
];

const snap = (devices) => snapshotOutputs(devices);

test("snapshot picks the default group from the virtual default entry", () => {
  const s = snap(btActive);
  assert.equal(s.defaultGroup, BT);
  assert.deepEqual(s.physicalGroups.sort(), [BT, SPEAKERS].sort());
});

test("snapshot excludes the virtual communications entry and dedupes groups", () => {
  const s = snap(speakersOnly);
  assert.equal(s.defaultGroup, SPEAKERS);
  assert.deepEqual(s.physicalGroups, [SPEAKERS], "one physical group despite two virtual entries + A2DP/HFP style pairs");
});

test("snapshot ignores input devices", () => {
  const s = snap([...speakersOnly, mic("phys-mic", "g-mic")]);
  assert.equal(s.defaultGroup, SPEAKERS);
  assert.deepEqual(s.physicalGroups, [SPEAKERS]);
});

test("snapshot handles a default entry with no group (invisible) conservatively", () => {
  const s = snap([out("default", ""), out("phys-speakers", SPEAKERS)]);
  assert.equal(s.defaultGroup, null);
});

test("active output vanished while playing → pause", () => {
  assert.equal(outputChangeAction(snap(btActive), snap(speakersOnly), true), "pause");
});

test("active output vanished while paused → no action (just a snapshot refresh)", () => {
  assert.equal(outputChangeAction(snap(btActive), snap(speakersOnly), false), "none");
});

test("intentional switch to another alive device → play on", () => {
  // Windows default moved speakers→BT, but both devices are still connected.
  assert.equal(outputChangeAction(snap(speakersOnly), snap(btAndSpeakers), true), "none");
});

test("new device connect stealing the default → play on", () => {
  // BT connected mid-song; Windows hands it the default. The old default is
  // still enumerated, so this is routing, not a disappearance.
  assert.equal(outputChangeAction(snap(speakersOnly), snap(btActive), true), "none");
});

test("unrelated device removed while default stays → play on", () => {
  // A second headset or a mic disappears; sound was never going through it.
  const fewer = [
    out("default", SPEAKERS),
    out("communications", SPEAKERS),
    out("phys-speakers", SPEAKERS),
  ];
  const more = [...fewer, out("phys-bt-a2dp", BT), out("phys-bt-hfp", BT)];
  assert.equal(outputChangeAction(snap(more), snap(fewer), true), "none");
});

test("no previous snapshot (startup) → never pauses", () => {
  assert.equal(outputChangeAction(null, snap(btActive), true), "none");
});

test("invisible previous default group → never pauses", () => {
  const invisible = { defaultGroup: null, physicalGroups: [BT] };
  assert.equal(outputChangeAction(invisible, snap(speakersOnly), true), "none");
});

test("the full disconnect-while-playing scenario, end to end", () => {
  // 1. Playing through BT headphones (Windows default = BT).
  let prev = snap(btActive);
  let playing = true;
  // 2. Headphones disconnect mid-song: enumeration loses the BT group.
  const next = snap(speakersOnly);
  if (outputChangeAction(prev, next, playing) === "pause") {
    playing = false;
  }
  assert.equal(playing, false, "paused instead of falling back to speakers");
  // 3. Snapshot refreshes; reconnect later while paused changes nothing.
  prev = next;
  assert.equal(outputChangeAction(prev, snap(btActive), false), "none");
  // 4. User resumes; the same device list change cannot re-pause them.
  playing = true;
  assert.equal(outputChangeAction(prev, snap(btActive), playing), "none");
});

/* ---------------- selected sink (output picker) ---------------- */

test("snapshot with a selected sink reports that device's group", () => {
  // User routed playback to the USB DAC while the Windows default is BT.
  const s = snapshotOutputs([...btActive, out("phys-usb", USB)], "phys-usb");
  assert.equal(s.selectedGroup, USB, "selected wins over default");
  assert.equal(s.defaultGroup, BT, "default is still reported");
});

test("snapshot with no selected sink aliases selectedGroup to the default", () => {
  const s = snap(btActive);
  assert.equal(s.selectedGroup, BT);
  assert.equal(s.selectedGroup, s.defaultGroup);
});

test("selected (non-default) sink vanished while playing → pause", () => {
  const withUsb = [...btActive, out("phys-usb", USB)];
  const afterUsbGone = btActive;
  assert.equal(outputChangeAction(snapshotOutputs(withUsb, "phys-usb"), snapshotOutputs(afterUsbGone, "phys-usb"), true, "phys-usb"), "pause");
});

test("selected sink alive while the default drifts → play on", () => {
  const withUsb = [...btAndSpeakers, out("phys-usb", USB)];
  const defaultMoved = [...btActive, out("phys-usb", USB)];
  assert.equal(
    outputChangeAction(snapshotOutputs(withUsb, "phys-usb"), snapshotOutputs(defaultMoved, "phys-usb"), true, "phys-usb"),
    "none",
    "routing the OS default around is not a disappearance of the chosen device"
  );
});

test("selected sink vanished while paused → no action", () => {
  const withUsb = [...btActive, out("phys-usb", USB)];
  assert.equal(outputChangeAction(snapshotOutputs(withUsb, "phys-usb"), snapshotOutputs(btActive, "phys-usb"), false, "phys-usb"), "none");
});

/* ---------------- device choices (settings menu) ---------------- */

test("choices: system default first, then physical outputs, virtuals skipped", () => {
  const choices = deviceChoices([
    out("default", SPEAKERS),
    out("communications", SPEAKERS),
    out("phys-speakers", SPEAKERS),
    out("phys-bt-a2dp", BT),
    ...btActive.map((d) => d), // duplicate default/communications again
  ]);
  assert.equal(choices[0].deviceId, "", "system default is the empty sink id");
  assert.equal(choices[0].label, "System default");
  const ids = choices.slice(1).map((c) => c.deviceId);
  assert.deepEqual(ids, ["phys-speakers", "phys-bt-a2dp"]);
});

test("choices: unlabeled devices degrade to Speaker N instead of empty labels", () => {
  const choices = deviceChoices([
    out("default", SPEAKERS),
    out("phys-a", SPEAKERS),
    out("phys-b", BT),
  ].map((d) => ({ ...d, label: "" })));
  assert.deepEqual(choices.map((c) => c.label), ["System default", "Speaker 1", "Speaker 2"]);
});

test("choices: real labels are kept and trimmed", () => {
  const choices = deviceChoices([
    out("default", SPEAKERS),
    { kind: "audiooutput", deviceId: "phys-1", groupId: "g1", label: "  Sennheiser HD 4.40BT  " },
  ]);
  assert.deepEqual(choices.map((c) => c.label), ["System default", "Sennheiser HD 4.40BT"]);
});

test("choices: devices sharing a group (endpoint pairs) appear once", () => {
  const choices = deviceChoices([
    out("default", BT),
    out("phys-bt-a2dp", BT),
    out("phys-bt-hfp", BT),
  ]);
  assert.equal(choices.length, 2, "default + one BT entry");
});

test("choices: the endpoint the OS default points at is flagged activeDefault", () => {
  const choices = deviceChoices(btActive); // Windows default = BT
  assert.equal(choices.find((c) => c.deviceId === "").activeDefault, true, "following the default");
  assert.equal(choices.find((c) => c.deviceId === "phys-bt-a2dp").activeDefault, true, "BT backs the default");
  assert.equal(choices.find((c) => c.deviceId === "phys-speakers").activeDefault, false);
});

test("choices: activeDefault moves with the OS default", () => {
  const onSpeakers = deviceChoices(btAndSpeakers); // default = speakers, BT connected
  assert.equal(onSpeakers.find((c) => c.deviceId === "phys-speakers").activeDefault, true);
  assert.equal(onSpeakers.find((c) => c.deviceId === "phys-bt-a2dp").activeDefault, false);
});
