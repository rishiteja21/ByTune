# ByTune macOS — RELEASE CHECKLIST

Status at 2026-09-30 (this machine, Apple Silicon, macOS 26.5):

## Verified — done, do not redo
- [x] Windows feature parity audited on the real Mac (2026-09-30 — 34 MATCH / 0 FAIL)
- [x] UI parity audited (shell/typography/layout/hover/menus/animations)
- [x] Mac-native UI verified (hiddenInset chrome, 84 px reserve, no fake buttons, drag region)
- [x] Playback verified (play/pause/seek/volume/mute/speed/shuffle/queue)
- [x] **Auto Mix verified with deck-clock proof** (incoming track at 11.09 s at the outgoing
      track's natural end — never 0:00, media clock authoritative)
- [x] Lyrics verified (word-synced, provider fallback, honest empty state)
- [x] Search verified (type-ahead, results, tabs, recents)
- [x] Queue verified · [x] Playlists verified (create flow; store logic unit-tested)
- [x] Local music verified (approval gate live-rejected an unapproved path; scan→metadata→playback)
- [x] Downloads verified (real file written to the approved folder, sanitised name)
- [x] Settings verified (toggles persist immediately)
- [x] Themes verified (dark glass palette; appearance toggles persist)
- [x] Context menus verified (7 actions enumerated live)
- [x] Keyboard battery verified via real Chromium input (typing-safe)
- [x] PiP verified (separate window, cross-window transport, no state conflict)
- [x] Fullscreen verified (IPC round-trip + geometry proof)
- [x] Persistence verified incl. **hard-kill (SIGKILL) restore** of queue+position
- [x] Single-instance verified (second launch exits pre-boot)
- [x] Deep links: malformed input ignored; LaunchServices routes `bytune://` to the installed bundle
- [x] Security audited: 194/194 suites, IPC trust boundary, filesystem gate live-proven
- [x] Dependency audit: **0 vulnerabilities** (after build-tool refresh; was 16 with 1 critical)
- [x] Production build created: `ByTune-1.0.1-arm64.dmg/.zip` + `ByTune-1.0.1-x64.dmg/.zip`
- [x] arm64 build verified (`lipo`: arm64) · [x] x64 build verified (`lipo`: x86_64)
- [x] DMG installed into /Applications; installed app launched and tested (streaming, quit, data)

## Human pass required (automation lacks the macOS Accessibility/Screen Recording TCC grant)
- [ ] Traffic lights look right (position/spacing/hover) — 30 seconds of looking at the window
- [ ] Native menu bar: click through ByTune/File/Edit/View/Playback/Window; Playback checkmarks
      track state; ⌘, opens Settings; ⌘O/⌘S open dialogs; ⌘W hides (music continues); ⌘Q quits
- [ ] Green traffic-light button enters/exits fullscreen
- [ ] Media keys (F7–F9) and the Control-Centre Now Playing widget show title/artist/artwork
- [ ] Bluetooth/AirPods: switch output mid-track; audio follows the device
- [ ] Sleep the Mac mid-playback; wake; playback recovers with no stuck fade or duplicate audio
- [ ] Drag & drop gesture feel (row→playlist, reorder, drop a folder onto Local Music)

## Credential-gated (cannot be done on this machine)
- [ ] Developer ID signing + notarization + stapling (MAC_BUILD_AND_SIGNING.md §2)
- [ ] Gatekeeper-clean first launch on a *stranger's* Mac (needs the signature above)
- [ ] Google OAuth sign-in round-trip (needs live Supabase + Google credentials)
- [ ] Live cloud sync against a real account (restore/deletion-merge on device)

## Before tagging a release
- [ ] Bump `version` in package.json (currently 1.0.1)
- [ ] `npm ci && npm test && npm run dist` on the release machine
- [ ] If credentials exist: sign + notarize + `spctl`/`stapler` verify (MAC_BUILD_AND_SIGNING.md)
- [ ] Attach the four artifacts (2 DMG + 2 ZIP) to the release
