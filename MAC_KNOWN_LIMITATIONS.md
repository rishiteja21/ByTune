# ByTune macOS — KNOWN LIMITATIONS

Everything below is a deliberate, documented limitation — nothing is faked or hidden.
(Carried over from the Windows-host audit where noted, extended after the real-Mac QA of
2026-09-30.)

## Product parity (same on Windows)
1. **Lossless/Hi-Res requires an addon source.** YouTube Music tops out at ≈171 kbps Opus;
   medium/high/lossless quality settings all resolve the best available rendition, `low` caps
   at 64 kbps. (Windows parity.)
2. **Auto Mix is beat-aligned crossfade, not DJ stretching.** It plans transitions onto the
   tempo grid of the next track; it does not tempo-match or do vocal analysis. (Windows parity.)
3. **Downloaded files carry no embedded metadata/cover art.** Filenames are properly sanitised
   (`Artist - Title.ext`) but tagging needs a native tagger dependency. (Windows parity.)
4. **No auto-updates.** Architecture is ready (`electron-builder` publish + electron-updater)
   but neither platform ships it. (Windows parity.)
5. **No Last.fm / ListenBrainz / Discord RPC** — these do not exist in the Windows reference
   codebase either. (Windows parity.)

## macOS-specific, observed on the real Mac
6. **Unsigned build (credential-gated).** No Apple Developer identity exists on the build
   machine: electron-builder skipped signing, the binary is adhoc/linker-signed, and
   `spctl -a -t exec` rejects the bundle. Users must right-click → Open on first launch.
   Keychain-sealed session tokens still work; nothing about playback is affected.
7. **Unexplained single pause (did not reproduce).** During the first Auto Mix deck-clock run,
   playback paused once at 31.7 s into the promoted track — no error, data fully buffered, no
   renderer/main-process pause path plausibly involved. It never recurred (60 s idle watch +
   all later sessions clean) and is attributed to external interaction with the visible app
   window (the automation ran on the user's desktop). Logged for honesty; no code change made.
8. **Lyrics providers rate-limit.** The provider race occasionally logs 429/402/403 from
   mirrors; the chain falls through by design and a later track usually gets lyrics. Observed
   live; behaviour matches Windows.
9. **The app data folder follows the product name.** Data lives in
   `~/Library/Application Support/ByTune` (not `bytune-macos` as previously documented — docs
   corrected on 2026-09-30). Uninstalling the app (drag to Trash) intentionally keeps this data.

## Verification gaps (environment, not product)
10. **Hardware media keys / Control-Centre Now Playing widget** — MediaSession metadata,
    position state and all action handlers were verified live in the packaged app, but pressing
    physical media keys and *seeing the widget* requires a human (automation lacks the
    Accessibility/Screen Recording TCC grant on this machine).
11. **Native menu-bar interaction** — the full menu (ByTune/File/Edit/View/Playback/Window) is
    built at boot and its template/contract is unit-tested; clicking its items and exercising
    ⌘W/⌘Q as real global keystrokes needs the same TCC grant. The equivalent code paths
    (close-to-hide via the real close handler, quit drain) were verified directly.
12. **Sleep/wake and Bluetooth/AirPods handover** — OS-level by design (no app code involved);
    not exercisable by automation here and deliberately not "verified" on paper.
13. **Google OAuth end-to-end and live cloud sync** — need real Supabase/Google credentials;
    the callback validation, parking rules and LaunchServices routing were verified locally.
14. **Signing/notarization** — see MAC_BUILD_AND_SIGNING.md; requires an Apple Developer account.
