# ByTune

A premium desktop music client for YouTube Music, redesigned from the ground up for Windows with Electron, React and TypeScript.

ByTune began as a desktop port of the excellent GPL-licensed BitChord Android player — rebuilt for Windows, and extended far beyond what the mobile app ever did.

![ByTune](build/icon.png)

## Features

- **YouTube Music, desktop style** — home feed, search (songs / videos / albums / artists), album pages, playlist playback, and **Spotify-style synced lyrics** (current line highlighted, auto-scroll, click any line to jump — YouTube Music + [LRCLIB](https://lrclib.net) fallback, so almost every song has them)
- **Real player** — play/pause/seek (with buffered indicator), shuffle, repeat (off / all / one), volume, queue with reorder and "play next", and a cinematic full-screen **Now Playing** view (big artwork, queue, lyrics) — click the artwork in the player bar or hit `N`
- **Dynamic artwork ambience** — the dominant colors of the current track's artwork subtly tint the app's background, player bar and full-screen player
- **Windows media keys** — play/pause/next/previous and the SMTC media overlay via the MediaSession API
- **Library** — liked songs, listening history and your own playlists (persisted on disk, restored on launch)
- **Downloads** — save any track as a `.m4a` file (configurable folder, live progress, "show in folder")
- **Premium desktop design** — Spotify-inspired dark aesthetic with a fixed ByTune brand palette, glass surfaces, artwork-driven ambience, skeleton loading, designed empty/error states, right-click context menus and custom dialogs
- **Keyboard shortcuts** — `Space` play/pause · `←/→` seek 5s · `Shift+←/→` prev/next · `↑/↓` volume · `M` mute · `S` shuffle · `R` repeat · `Q` queue · `L` lyrics · `N` now playing · `Esc` close panels · `Ctrl+F` or `/` search

## What ByTune adds

The desktop-original work that goes beyond the Android upstream:

- **Native Windows desktop shell** (Electron) — the upstream is Android-only; everything below builds on that foundation
- **Windows media keys + SMTC media overlay** via the MediaSession API
- **Canvas** — looping video artwork behind the full-screen player
- **Real download queue** with live progress and library persistence
- **Local music library** — folder scanning with a non-music filter (short recordings, voice notes)
- **Replay-style listening statistics** — monthly buckets, per-artist/album totals, hourly and daily breakdowns
- **Beat-aware crossfade** — fades that land on the next track's tempo grid in smart mode
- **Rewritten synced-lyrics pipeline** — multiple word-synced sources raced in priority order, with a YT Music text fallback
- **Packaged Windows installer** (NSIS) with settings that migrate across app renames

## How streaming works

YouTube now gates stream URLs behind BotGuard "PO tokens" for anonymous sessions. ByTune handles this end-to-end, with no login required:

1. A BotGuard challenge is taken from the YouTube homepage (with an `/att/get` fallback) and the interpreter runs inside a sandboxed JSDOM environment presented as youtube.com (same approach as the [bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) provider).
2. The resulting WebPO token is bound to the session's visitor data and attached to InnerTube requests.
3. Stream URLs are resolved by rotating InnerTube clients (VISIONOS / IOS / ANDROID_VR / WEB / MUSIC / ANDROID / TV), each validated with a real open-range request to dodge SABR-gated URLs.
4. All googlevideo traffic flows through a small local proxy (`127.0.0.1`) in the main process — the media element plays from localhost, which sidesteps the renderer being rejected by googlevideo entirely.

If every InnerTube route fails, public Piped mirrors are tried as a last resort. Note that YouTube actively changes this plumbing; if playback ever breaks, updating `youtubei.js` (`npm i youtubei.js@latest`) usually fixes it.

## Development

```bash
npm install
npm run dev        # vite + electron with hot reload
```

## Build an installer

```bash
npm run dist       # typecheck + build + NSIS installer into release/
```

## Project layout

```
electron/            main process
  main.ts            app lifecycle, window, IPC
  music-service.ts   YouTube Music: search/albums/playlists/home/lyrics + stream resolution
  po-token.ts        BotGuard PO token minting (JSDOM + bgutils-js)
  stream-proxy.ts    local 127.0.0.1 streaming proxy (Range-aware)
  downloads.ts       track downloader with progress events
  persist.ts         JSON persistence for renderer stores (+ legacy data migration)
  preload.ts         contextBridge API exposed to the renderer
src/                 renderer (React + Tailwind + Zustand)
  index.css          ByTune design tokens: glass surfaces, ambient atmosphere, skeletons
  lib/ambient.ts     artwork color extraction → app-wide ambience
  lib/audio.ts       audio engine: store ⇄ <audio>, error recovery, MediaSession
  stores/            player / library / settings / ui / recents state
  components/        design-system primitives, sidebar, player bar, track list, queue, lyrics, menus, toasts
  views/             home, search, library, playlists, album, downloads, settings
scripts/             icon generator + streaming diagnostics tools
```

## License

ByTune is licensed under the **GNU GPL v3** (see `LICENSE`). It is a free, open-source music client intended for personal use — please use it responsibly and in accordance with the terms of the services it accesses. It began as a fork of the BitChord Android player, which shares this license — thank you to its author for building in the open.

Not affiliated with or endorsed by YouTube/Google, JioSaavn, Tidal or Apple Music.
