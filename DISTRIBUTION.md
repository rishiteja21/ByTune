# Distributing ByTune for macOS

This document covers exactly what is needed to turn this repo into a signed,
notarized, Gatekeeper-clean macOS app — and what remains for the developer to do
(credentials only the Apple Developer account holder has).

## What is already configured

- **Targets**: `dmg` + `zip` for **arm64 and x64** (`npm run dist`), artifact names
  `ByTune-<version>-<arch>.dmg|.zip` in `release/`.
- **Bundle**: `com.bytune.music`, category `public.app-category.music`,
  dark mode supported, Retina (`NSHighResolutionCapable`), minimum macOS 11,
  `bytune://` URL scheme declared in Info.plist.
- **Icon**: `build/icon.png` (512×512) — electron-builder converts it to `.icns`
  automatically at build time.
- **Hardened Runtime** is enabled (`hardenedRuntime: true`) with a minimal
  entitlements file (`build/entitlements.mac.plist`):
  - `com.apple.security.cs.allow-jit` — required by V8 under Hardened Runtime
  - `com.apple.security.cs.allow-unsigned-executable-memory` — V8 on Intel
  - library validation deliberately **left enabled**; no camera/mic/AppleEvents
    entitlements — ByTune needs none. User-selected folders (Downloads, Music,
    Desktop, Documents) are granted by macOS TCC at pick time via the native
    open panel; no static entitlement is wanted or needed.
- **Deep links**: `bytune://` registered at runtime (`app.setAsDefaultProtocolClient`)
  and via Info.plist; cold launch is handled by the `open-url` event.

## What requires Apple credentials (not fabricatable)

1. **Developer ID Application certificate** (to sign). Exported as a `.p12`.
2. **Notarization credentials** — an App Store Connect API key
   (`App Store Connect API key ID` + issuer), or an Apple ID with app-specific
   password.

## Build & sign on a Mac

```bash
# 1. Sign-time environment (do NOT commit these)
export CSC_LINK=/absolute/path/to/DeveloperIDApplication.p12
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
export CSC_KEYCHAIN=login            # if the cert is already in the login keychain
export APPLE_API_KEY_ID=XXXXXXXXXX   # App Store Connect API key
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export APPLE_API_KEY_PATH=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
# (electron-builder picks these up automatically; notarization/staple runs
#  as part of `npm run dist` when they are present)

# 2. Build
npm ci
npm run dist         # arm64 + x64 DMG + ZIP, signed + notarized + stapled

# 3. Verify
spctl -a -t exec -vv release/mac-arm64/ByTune.app
xcrun stapler validate release/ByTune-<version>-arm64.dmg
codesign -dv --verbose=4 release/mac-arm64/ByTune.app
```

Without the credentials the same command still produces **unsigned** DMG/ZIP
artefacts — nothing is fabricated; users must bypass Gatekeeper manually
(right-click → Open) and notarization is skipped with a warning.

## Universal binary (optional)

```bash
npx electron-builder --mac --universal
```

All dependencies here are pure-JS (electron, youtubei.js, jsdom, supabase) — no
architecture-pinned native modules — so a universal build is safe if wanted at
the cost of download size.

## Testing the artefact on a clean machine (checklist)

1. Copy `ByTune-<version>-arm64.dmg` to a Mac, open, drag ByTune → Applications.
2. Launch from Finder: first-run Gatekeeper prompt (unsigned) or none (signed).
3. Onboarding → Continue as guest → search → play → verify audio output.
4. Media keys: play/pause/next from the keyboard; check the Now Playing widget
   in Control Centre shows title/artist/artwork.
5. Close the window (red button): music must keep playing; click the Dock icon
   to bring the window back. ⌘Q must actually quit.
6. Menu bar: every item works (Playback checkmarks reflect state; Settings… ⌘,
   opens settings; Import/Export Backup… open native dialogs).
7. Traffic lights: positioned in the top bar's left reserve; dragging works
   everywhere on the top bar; double-click zooms per System Settings.
8. Downloads: default `~/Downloads/ByTune`; pick a custom folder; reveal in
   Finder. Export-compatible downloads land in `~/Music/ByTune` (macOS TCC may
   prompt for Music access — allow or pick another folder; denial must not crash).
9. Retina: artwork and text crisp at 2×; lyrics sweep smooth.
10. Sleep the Mac mid-playback; wake; playback resumes without a stuck fade.
11. Connect/disconnect AirPods mid-track; audio follows the output device.
12. `bytune://` link handling (cold and warm launch).
13. Restart the app: queue, position, settings, theme and local library restore.

## What was verified without a Mac (this port's QA)

- Full production build + boot + streaming playback + search + lyrics + queue +
  PiP + settings + menu command IPC + close-to-hide lifecycle, exercised on the
  real built app (see scripts/qa-*.mjs).
- Menu template contract, all shared-logic suites, security suites: `npm test`.
- `npm audit`: 0 vulnerabilities.

What still needs the hardware: the items in the checklist above that are
macOS-shell-specific (traffic lights, native menu bar behaviour, Dock, media
keys/Now Playing, DMG flow, sleep/wake, device handover).
