# Contributing to ByTune

Thanks for helping improve ByTune! This document covers what you need to get a development environment running and what to expect when you open an issue or pull request.

## Getting set up

Prerequisites:

- **Windows 10/11** to run and package the Windows edition (NSIS installer)
- **macOS 13+** to run and package the macOS edition — `.dmg` artifacts can only be produced on macOS, and the Xcode Command Line Tools are needed for native build steps (`xcode-select --install`)
- **Node.js** — an up-to-date LTS version
- **Git**

```bash
git clone https://github.com/rishiteja21/ByTune.git
cd ByTune
npm install
npm run dev
```

`npm run dev` starts Vite (renderer) and Electron together with hot reload. The app opens with its onboarding screen — **Continue as guest** is fine for development; your data is stored locally.

Accounts, sync and Rooms need a Supabase project, which the source doesn't include. To work on them, copy `.env.example` to `.env` and fill in your own project's URL and publishable key. Without it, ByTune runs guest-only.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development with hot reload |
| `npm test` | Run the unit tests (`node --test`) |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`) |
| `npm run build` | Typecheck + build renderer and main process |
| `npm run dist` | Full build + package for the current platform |
| `npm run dist:win` | NSIS installer into `release/` (Windows) |
| `npm run dist:mac` | DMG + ZIP, arm64 and x64, into `release/` (needs macOS) |

Before opening a pull request, please make sure `npm run typecheck` and `npm test` pass.

The Windows and macOS editions share one codebase: platform-specific behavior lives behind `process.platform` guards in `electron/main.ts`, `electron/mac-menu.ts`, `src/lib/platform.ts` and `src/lib/menuCommands.ts` — keep it that way, and check that changes work on both platforms (or are explicitly guarded).

## Releasing

The installed app checks GitHub's latest release for a newer version (`electron/updater.ts`). Windows installs it in the app; a Mac sends people to bytune.space, because macOS only installs updates to apps signed with an Apple Developer ID.

1. Set `version` in `package.json`. The app, its About page and the update check all read it from there.
   Official builds need ByTune's Supabase project in `.env` (`BYTUNE_SUPABASE_URL`, `BYTUNE_SUPABASE_KEY`); the macOS workflow reads the same two from the repository's secrets. `npm run dist*` stops if they're missing, so no release ships without accounts.
2. `npm run dist:win` writes three files to `release/`: `ByTune-Setup.exe`, `latest.yml` and `ByTune-Setup.exe.blockmap`.
3. Create the GitHub release with the tag `v<version>` and upload all three. Without `latest.yml`, Windows users are still told about the update, but have to download it themselves.
4. Pushing the tag starts the macOS workflow, which attaches the Mac ZIPs and DMGs to that release.
5. Bump the Mac download links in the website's `src/lib/site.ts`. They include the version number.

## Reporting bugs

Open a [GitHub issue](https://github.com/rishiteja21/ByTune/issues) and include:

- What you did and what happened
- The ByTune version (Settings → About, or the release tag)
- Your OS and version (Windows 10/11, or macOS 13+ on Apple Silicon/Intel)

Playback issues are often upstream changes on YouTube's side — mention whether playback fails for everything or just some tracks.

## Proposing features

Open an issue describing the problem you want solved before writing large changes. Small, focused pull requests are easier to review and more likely to land.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep changes focused; unrelated refactors make review harder.
3. Verify the app still behaves correctly — run it, play something, check the views you touched.
4. Describe what changed and why in the PR description.

## License

By contributing, you agree that your contributions are licensed under the [GNU GPL v3](LICENSE).
