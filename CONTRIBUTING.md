# Contributing to ByTune

Thanks for helping improve ByTune! This document covers what you need to get a development environment running and what to expect when you open an issue or pull request.

## Getting set up

Prerequisites:

- **Windows 10/11** (the packaged app targets Windows; other platforms are not supported yet)
- **Node.js** — an up-to-date LTS version
- **Git**

```bash
git clone https://github.com/rishiteja21/ByTune.git
cd ByTune
npm install
npm run dev
```

`npm run dev` starts Vite (renderer) and Electron together with hot reload. The app opens with its onboarding screen — **Continue as guest** is fine for development; your data is stored locally.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development with hot reload |
| `npm test` | Run the unit tests (`node --test`) |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`) |
| `npm run build` | Typecheck + build renderer and main process |
| `npm run dist` | Full build + NSIS installer into `release/` |

Before opening a pull request, please make sure `npm run typecheck` and `npm test` pass.

## Reporting bugs

Open a [GitHub issue](https://github.com/rishiteja21/ByTune/issues) and include:

- What you did and what happened
- The ByTune version (Settings → About, or the release tag)
- Your Windows version

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
