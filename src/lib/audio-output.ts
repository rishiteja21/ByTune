/**
 * "The active output disappeared" detection — pure snapshot + decision.
 *
 * Chromium re-routes a playing <audio> to the new Windows default endpoint
 * all by itself, which is why unplugging a headset (or a Bluetooth link
 * dropping) made playback fall back to the PC speakers instead of pausing.
 * The OS pushes no "device removed" event into the page; what it does give
 * us is `devicechange` plus enumeration, and Chromium models the Windows
 * default output as a virtual `default` entry whose `groupId` is shared
 * with the physical device backing it. That yields a name-free, vendor-free
 * definition of "the output the listener was hearing":
 *
 *   snapshot — the `default` entry's groupId is the device sound is actually
 *              going to; every physical output entry's groupId is a device
 *              that is still connected.
 *   decision — pause only if the previous default's groupId is gone from the
 *              physical list while playing. Exactly the right line between
 *              the two worlds that must not be confused:
 *                · active headset removed / BT dropped     → gone → pause
 *                · intentional switch A→B (both alive)     → A still there → play on
 *                · new device connect steals the default   → old one alive → play on
 *                · unrelated second headset / mic removed  → default alive → play on
 *
 * The wiring in audio.ts listens to `devicechange` and re-enumerates —
 * event-driven, no polling, no timers. If groups are invisible (permissions
 * stripped in an exotic embed), the decision degrades to "never pause": a
 * silent no-op, never a false pause.
 */

export interface OutputSnapshot {
  /** groupId backing the Windows default output (null when invisible). */
  defaultGroup: string | null;
  /** groupIds of all physical output endpoints currently enumerated. */
  physicalGroups: string[];
}

/** Structural slice of MediaDeviceInfo, so tests need no DOM. */
interface DeviceInfoLike {
  kind: string;
  deviceId: string;
  groupId: string;
}

export function snapshotOutputs(devices: readonly DeviceInfoLike[]): OutputSnapshot {
  let defaultGroup: string | null = null;
  const physicalGroups: string[] = [];
  for (const d of devices) {
    if (d.kind !== "audiooutput") continue;
    // `default` and `communications` are virtual entries pointing at a
    // physical device; the physical endpoint itself is what marks "alive".
    if (d.deviceId === "default") {
      defaultGroup = d.groupId || null;
    } else if (d.deviceId !== "communications" && d.groupId && !physicalGroups.includes(d.groupId)) {
      physicalGroups.push(d.groupId);
    }
  }
  return { defaultGroup, physicalGroups };
}

export type OutputChangeAction = "pause" | "none";

/**
 * Whether an enumeration change means the output the listener was hearing
 * vanished. `playing` gates it: a vanished default while paused is just a
 * snapshot refresh, and pausing an already-paused player is meaningless.
 */
export function outputChangeAction(
  prev: OutputSnapshot | null,
  next: OutputSnapshot,
  playing: boolean,
): OutputChangeAction {
  if (!playing || !prev || !prev.defaultGroup) return "none";
  return next.physicalGroups.includes(prev.defaultGroup) ? "none" : "pause";
}
