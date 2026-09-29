# README Redesign Report

**Date:** 2026-09-29
**Scope:** GitHub repository presentation only. No application code was modified.

## Files changed

| File | Change |
|---|---|
| `README.md` | Completely rewritten around real screenshots and verified features |
| `CONTRIBUTING.md` | New — dev setup, verified commands, bug-report and PR guidance |
| `docs/screenshots/*.png` | New — 10 screenshots captured from the running app |
| GitHub repo description | Updated via `gh` |
| GitHub topics | Set: `music-player`, `desktop-app`, `electron`, `react`, `typescript`, `windows`, `youtube-music`, `lyrics`, `playlist`, `open-source` |

Nothing in `electron/`, `src/`, `package.json`, or build configuration was touched (`git status` confirms).

## Screenshots (all from the real application)

Captured interactively from the live ByTune app (Electron instance running this repository's source — the same code as the v1.0.1 release; UI identical to the packaged build):

| File | Shows |
|---|---|
| `home.png` | Hero — home feed, library sidebar, now-playing panel, player bar, artwork ambience |
| `fullscreen.png` | Fullscreen Now Playing: artwork, visualizer, word-synced lyrics |
| `lyrics.png` | Word-level lyric highlight (captured mid-word), ambient background |
| `miniplayer.png` | Real picture-in-picture mini player window |
| `search.png` | Search results with All/Songs/Videos/Albums/Artists/Playlists tabs |
| `queue.png` | Queue panel: Now Playing + Next up, Recently played tab |
| `library.png` | Your Library: Playlists / Liked / Downloaded filters, Play all / Shuffle |
| `local-music.png` | Local library: 204 imported songs, albums/artists counts, file search |
| `downloads.png` | Downloads view: saved track, status, Open folder |
| `settings.png` | Settings: lyrics, local music, appearance, Replay sections |

**Privacy handling:** screenshots were inspected during capture. A first local-music capture showed personal folder paths (`D:\Music\...`) and was discarded and re-taken via the "All songs" view. No emails, account IDs, tokens, or private paths appear in any shipped screenshot (session was in guest mode).

**Known minor artifact:** a small mouse cursor rests in the empty sidebar area of most captures; it covers no content.

## Features verified live (in the app) before writing

Streaming playback with auto-advance through the queue · search with live suggestions and filter tabs · like/unlike with Liked Songs count · context menu (Play now / Play next / Add to queue / New playlist / Download / Copy link) · queue panel · word-synced lyrics with click-to-jump · fullscreen Now Playing with visualizer and Lyrics/Queue toggle · mini player PiP as a separate always-on-top window · library collections · real download of a track (.m4a, "Download finished" toast, Open folder) · local music import with albums/artists · Replay stats · settings for streaming quality, lossless downloads, crossfade / Auto Mix / skip silence / autoplay / playback speed, appearance (liquid glass, reduce motion/blur), synced-lyrics toggles, local-music management · guest vs. account modes.

Verified in code: keyboard shortcuts (`Space`, `←/→` seek 5s, `Shift+←/→` prev/next, `↑/↓` volume, `M`, `S`, `R`, `Q`, `L`, `N`, `Esc`, `/`) — `src/App.tsx:119-163`. Canvas clips setting exists (`src/lib/canvas.ts`, SettingsView "Play canvas clips in place of the still cover").

## Claims corrected vs. the previous README

- **Removed `Ctrl+F` as a search shortcut** — only `/` is implemented (no `KeyF` handler in `src/App.tsx`).
- **Themes:** previous wording implied custom theming; `src/stores/settings.ts` states "Dark theme only — no theme switching." The feature table now marks light theme ❌ and describes artwork-driven ambient dark theming as the actual behavior.
- **No invented stats/users/roadmap** — no numbers, testimonials, or roadmap items anywhere; the Roadmap section was deliberately omitted (no repository roadmap exists).
- Platform claim narrowed to Windows 10/11, with "macOS — coming soon" stated explicitly.

## Links verified (all HTTP 200)

- `https://bytune.vercel.app/`
- `https://github.com/rishiteja21/ByTune/releases/latest/download/ByTune-Setup.exe` (dynamic latest-release URL; resolves to the current v1.0.1 asset — keep the `ByTune-Setup.exe` asset name stable in future releases for this link to keep working)
- `https://github.com/rishiteja21/ByTune/releases`
- `https://github.com/rishiteja21/ByTune/issues`
- `https://lrclib.net`, `https://github.com/Brainicism/bgutil-ytdlp-pot-provider`
- All 10 relative screenshot paths exist in `docs/screenshots/`.

No localhost URLs, no stale GitHub Pages URLs, no old website domains remain in README/CONTRIBUTING.

## SEO / discoverability

- Repo description: "ByTune — an open-source desktop music player for Windows: YouTube Music streaming, word-synced lyrics, fullscreen & mini players, local library, downloads and listening stats."
- First paragraph targets "open-source desktop music player for Windows" naturally; headings read as product sections (no keyword stuffing, no repeated "Spotify alternative").
- Descriptive alt text on every screenshot; badge row limited to release / license / platform / website.

## Side effects on the local machine (disclosed)

During capture the running app was used as a real user: one track (Counting Stars — OneRepublic) was **liked**, one track was **downloaded** (a real `.m4a` now exists in the configured downloads folder), listening stats and the home feed updated, and the app was left in guest mode with playback **paused**. The app instance that was already running (dev-mode `electron.exe`) was left running and untouched otherwise. To restore: unlike the track and remove it from Downloads in-app.

## Still needs manual action

1. **Commit & push** `README.md`, `CONTRIBUTING.md`, and `docs/screenshots/` — GitHub cannot render the new page until this lands on `main` (intentionally left uncommitted).
2. Optional: set the repository social preview image (GitHub Settings → Social preview) — `docs/screenshots/home.png` is a good candidate.
