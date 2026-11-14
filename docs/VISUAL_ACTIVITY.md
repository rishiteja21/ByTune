# Window visual activity

Audio and visual activity have separate lifecycles. The audio engine, player
store, room synchronization, media integration, sleep timer and PiP snapshot
transport do not subscribe to visual activity.

## Native state and initialization

`electron/window-activity.ts` registers each main/PiP BrowserWindow before its
page loads. It observes focus, blur, minimize, restore, show and hide. State is
sent only to that window's webContents, with a window ID and increasing revision.
The read-only snapshot handler resolves the sender; callers cannot choose a
window ID. The existing sender/frame/URL checks in `electron/pip.ts` apply.

Native flags are reconciled on snapshot reads and once on the next event-loop
turn after a lifecycle event. Negative events suspend immediately; positive
events use current native flags so a delayed notification cannot revive an
already hidden window. Pending callbacks are coalesced and cancelled on close.

On macOS, `hide`/`show` also describe Cocoa occlusion changes. Blur can emit
`hide` while `isVisible()` remains true; subsequently ordering that window out
may emit no further event. Application-owned hides therefore use `hideWindow()`
(the close-to-hide handler is the only production caller). It suspends visuals
before `BrowserWindow.hide()`, guards reentrant notifications/snapshot reads,
and reconciles native flags after the synchronous call returns. This supplies
the missing completion signal without a guessed delay or polling. Future
programmatic hide callers must use the same helper. Main and PiP ownership,
revisions and cleanup remain independent.

`src/lib/windowActivity.ts` subscribes before requesting the initial snapshot.
A response with an older/equal revision cannot overwrite a newer event. Disposal
ignores responses still in flight. The current state is also available after a
renderer reload without waiting for another native event.

`initializeVisualActivity()` runs before either React tree mounts. The document
gets `data-window-activity="focused|unfocused|minimized|hidden"` and
`data-visual-active="true|false"`. Minimized takes precedence over invisible.
Visuals are active only when the native window is visible, focused and not
minimized, and the document is not hidden. Page Visibility supplies an additional
veto, not native focus detection. Plain-browser development falls back to page
focus/visibility. Before the native handshake, decorative work is inactive.

PiP has its own state: hiding the main window does not suspend a focused PiP.
An unfocused PiP pauses its decorative motion while continuing to receive and
render playback position, track metadata and transport state.

## Explicitly managed work

| Work | Suspension and resumption |
| --- | --- |
| `FitText` automatic title marquees and edge-mask WAAPI effects | Register individual Animation objects; pause/play preserves currentTime. Cancel/unregister on text replacement or unmount. |
| `CoverDrum` onboarding rotation, inertia and pointer tilt | One managed rAF callback; cancel when inactive. Retain angles and velocity, reset frame delta on resume. |
| `ReplayView` number count-up | Bounded managed rAF; retains elapsed foreground time. New values replace the previous sequence. |
| `SyncedLyrics` word sweep | Managed rAF reads the live audio clock after resume. No audio clock changes. |
| `SyncedLyrics` line presentation and scrolling | Hold the visual position snapshot while inactive; cancel glides. On resume read current position and align immediately rather than replaying missed glides. Track/lyrics loading remains live. |
| `NowPlaying` muted video artwork | Pause the video while inactive; resume only if playback still requests it. Guard asynchronous play and fragmented-video loop restart. New tracks still resolve their current clip. |
| CSS mesh drift, collection/settings cover-wall rows, playing-row glow | Explicit selector allowlist pauses animation-play-state; original timeline and design remain. |
| CSS equalizer, spinning records, fullscreen artwork breathing and decorative bars | Same allowlist; existing playing and reduced-motion conditions remain authoritative after resume. No fullscreen choreography changes. |
| Streak flame lighting | Its bounded Priority 1 sequence can pause/resume; no infinite animation reintroduced. |
| Skeleton shimmer, busy spinners/pulses and backup-status pulse | Pause motion only; loading/progress/status data still updates. |

CSS registration lives beside the animation helpers in `src/index.css`.
New CSS effects can opt in with `data-visual-animation="decorative"` on the
animated element; pseudo-elements require explicit selectors.
`visualActivity.registerAnimation()`, `runFrames()` and `registerVideo()` are
explicit opt-ins. No production code scans and pauses `document.getAnimations()`.
A frame registration owns at most one callback, and unregistering prevents it
from restarting. Finite work returns `false` to release its subscription.

## Intentionally unchanged

- Audio elements, audio timers, crossfade/Automix, track advancement, seeking,
  sleep timers, room synchronization, media keys and system Now Playing.
- PiP playback snapshots and native cursor watch (transport and usable controls).
- Launch intro: bounded handoff/visibility choreography; awaiting its animation
  completion must not block application initialization in the background.
- Menu/modal/fullscreen entrance and exit, toast countdown/expiry, drag, swipe,
  scroll and hover transitions: interaction or state-transition work, already
  bounded/event-driven. They are not in the decorative allowlist.
- `useSortable`, `SwipeArrow`, `PanelScrollbar`, `useSongMatches`, Settings'
  one-frame lighting switch, and FitText's batched resize/font measurements:
  gesture/layout/data correctness work rather than permanent decorative loops.
- One-time palette/ambient extraction canvases and Replay image export: finite
  data preparation/export; keeping current artwork available prevents stale
  colors after background track changes. There is no continuous canvas drawing
  visualizer here; fullscreen bars are CSS and “Canvas” artwork is video.
- Playback-time React updates outside the lyrics presentation snapshot. The
  player store continues publishing normally; no global React rendering freeze.
- `backgroundThrottling`, hardware acceleration and fullscreen behavior.

## Verification

`npm test` includes native-state, initialization-race, animation ownership,
video-play race and frame cancellation/duplication regression tests.
`npm run build` includes TypeScript checking and production bundling.

For actual BrowserWindows and the production renderer:

```sh
npm run build
npx electron scripts/visual-lifecycle-e2e.cjs
```

The test uses a disposable profile, synthetic muted audio/video, deterministic
lyrics and stubbed catalogue responses. It exercises native window states,
repeated switching/minimize/restore, fullscreen remounts, background playback,
media commands, ended-event advancement and PiP independence. It records native
and renderer state alongside CPU-time deltas and Chromium layout/style counters.
`BYTUNE_VISUAL_RESULTS` selects the report directory. `--baseline` and
`BYTUNE_GUI_MAIN` support comparing an unchanged build using the same fixture.
`--measure-only` compares paused Home in all four states; `--onboarding` checks
the actual cover drum. `--window-activity-only` exercises close-to-hide after
occlusion, rapid hide/show, minimize/restore and independent PiP state without
snapshot requests that could mask a missed notification. These fixtures are
not part of the packaged application.
