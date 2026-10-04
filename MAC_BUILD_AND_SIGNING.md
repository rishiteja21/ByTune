# ByTune macOS — BUILD & SIGNING (verified on a real Mac)

**Verified 2026-09-30** on Apple Silicon / macOS 26.5 with node 25, npm 11, electron 44.3,
electron-builder 26.17 (esbuild 0.28, vite 8.3). Everything below is what actually happened.

## 1. What was actually built (no credentials — unsigned)

```bash
npm ci                 # fresh install (also: npm audit → 0 vulnerabilities)
npm test               # 194/194
npm run dist           # builds renderer + main, then electron-builder for BOTH arch targets
```

Artifacts produced and verified (`release/`):

| File | Size | Contents |
|---|---|---|
| `ByTune-1.0.1-arm64.dmg` | 135 MB | arm64 app (verified: `lipo -archs release/mac-arm64/ByTune.app/Contents/MacOS/ByTune` → `arm64`) |
| `ByTune-1.0.1-arm64.zip` | 131 MB | same, zipped |
| `ByTune-1.0.1-x64.dmg` | 140 MB | Intel app (`lipo` → `x86_64`) |
| `ByTune-1.0.1-x64.zip` | 135 MB | same, zipped |

Bundle facts checked on the installed copy: `CFBundleIdentifier com.bytune.music`,
`CFBundleShortVersionString 1.0.1`, `LSMinimumSystemVersion 11.0.0`,
`NSHighResolutionCapable true`, `CFBundleURLSchemes ["bytune"]`, category
`public.app-category.music`, `Resources/icon.icns` present.

## 2. Signing/notarization — honest status

- electron-builder: *"skipped macOS application code signing — cannot find valid Developer ID
  Application identity … 0 valid identities found."*
- `codesign -dv /Applications/ByTune.app` → `flags=0x20002(adhoc,linker-signed)` — i.e. **NOT
  signed** with any developer identity.
- `spctl -a -t exec /Applications/ByTune.app` → rejected ("code has no resources but signature
  indicates they must be present").
- **Not notarized.** Nothing was fabricated; the artifacts work locally because files created
  locally carry no quarantine attribute.

To produce a signed, notarized release (from DISTRIBUTION.md, unchanged):

```bash
export CSC_LINK=/path/to/DeveloperIDApplication.p12
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export APPLE_API_KEY_PATH=/path/to/AuthKey_XXXXXXXXXX.p8

npm run dist    # signs, notarizes, staples when the env vars are present

# then verify:
spctl -a -t exec -vv release/mac-arm64/ByTune.app
xcrun stapler validate release/ByTune-1.0.1-arm64.dmg
codesign --verify --deep --strict release/mac-arm64/ByTune.app
```

Hardened Runtime is already configured (`hardenedRuntime: true`) with the minimal entitlements
in `build/entitlements.mac.plist` (JIT + unsigned executable memory for V8; nothing else).

## 3. Install & first launch (verified)

```bash
hdiutil attach release/ByTune-1.0.1-arm64.dmg -nobrowse
ditto "/Volumes/ByTune 1.0.1/ByTune.app" /Applications/ByTune.app
hdiutil detach "/Volumes/ByTune 1.0.1"
open /Applications/ByTune.app
```

Observed: app boots to onboarding/shell; creates `~/Library/Application Support/ByTune/data/`
with the expected stores; streams real audio; quits cleanly; player state survives.

⚠️ On a machine where the DMG arrived via the internet (quarantine attribute present) the
unsigned build triggers Gatekeeper — right-click → Open (or remove quarantine) is required.
This disappears once §2 is done.

## 4. Deep-link registration (verified)

LaunchServices shows `bytune:` claimed by `com.bytune.music`; `open location "bytune://…"`
routes to the installed bundle (multiple copies of the same bundle id are reconciled by
LaunchServices automatically). Handler validation: malformed URLs are ignored, valid-shaped
callbacks without a pending OAuth flow are parked (max 3) — never executed blindly.

## 5. Toolchain refresh note (this audit)

Fresh `npm install` surfaced new advisories in the build toolchain (all dev-time; none ship in
the bundle). Fixed by upgrading: `electron-builder@^26.17.0`, `esbuild@^0.28.2`,
`vite@^8.3.1`, `@vitejs/plugin-react@^6.1.1` → `npm audit`: **0 vulnerabilities**; typecheck,
194/194 tests, build and smoke all re-run green afterwards.
