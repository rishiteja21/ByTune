# ByTune PC — Feature Parity Matrix (final)

Every feature below was verified against the running ByTune PC app after implementation.
Statuses: **IMPLEMENTED** (works end-to-end) · **PARTIAL** (some of the surface, honestly labeled) · **N/A** (no meaningful desktop equivalent — intentionally excluded) · **BLOCKED** (needs a dependency or product decision; not faked).

## Playback
| Feature | Status | Notes |
|---|---|---|
| YT Music playback | IMPLEMENTED | pre-existing; youtubei.js + PO token + local stream proxy |
| Crossfade | IMPLEMENTED | dual-element equal-power blend (`src/lib/audio.ts`), 0–12s setting, armed 4s early |
| Automix (smart fade) | PARTIAL | real: next track decoded + onset-autocorrelation BPM (`src/lib/analysis.ts`); fade start/end aligned to beats; honest fallback w/ reason toast. No vocal mask / bass-filter FX / WSOLA — BLOCKED (needs native DSP), never faked |
| Playback speed | IMPLEMENTED | 0.5–2×, pitch-preserving, persisted, wired to both elements |
| Skip silence | IMPLEMENTED | opt-in; decoded edge scan (−42dBFS), head seek + tail skip |
| Shuffle / Repeat / persistence | IMPLEMENTED | pre-existing |
| Queue mgmt (next/add/reorder/remove/clear/history) | IMPLEMENTED | pre-existing |
| AutoPlay | IMPLEMENTED | pre-existing (home-feed seeding); repeat-all interplay preserved |
| Radio | PARTIAL | artist-related rows + autoplay; no dedicated station endpoint |
| Gapless | PARTIAL | natural end only; crossfade covers transitions when enabled |
| Read-ahead | N/A | Chromium range-buffers; no separate read-ahead cache is needed |
| Mid-track quality upgrade | BLOCKED | single-catalogue resolver; revisit with more sources |
| Media session / background playback | IMPLEMENTED | SMTC + media keys + timeline (setPositionState added) |
| Stats for nerds | IMPLEMENTED | real engine numbers in the Now Playing overlay |

## Audio / quality
| Feature | Status | Notes |
|---|---|---|
| Quality setting | IMPLEMENTED | low/medium/high/lossless enforced as format ceiling in `resolveStreamUrl`; mapped per-source for addons/JioSaavn |
| StreamFormat model | PARTIAL | codec/kbps surfaced where a source states it (addons, JioSaavn); YT publishes no bit-depth/rate — never invented |
| Lossless / Hi-Res | BLOCKED on sources | honest: YT tops out ≈171 kbps Opus; lossless arrives via addon sources (protocol implemented) |
| Dolby Atmos badge | N/A | no E-AC-3 JOC on the YT Music stream path |
| Output PCM / USB DAC / system EQ | N/A | desktop OS mixer owns this |
| Spatial audio toggle | REMOVED | was a fake toggle |

## Automix analysis
| Feature | Status |
|---|---|
| Tempo detection (BPM + beat grid) | IMPLEMENTED (lightweight, browser-side) |
| Vocal analysis / phrase detection | BLOCKED — open-unmix-class DSP; explicitly excluded rather than faked |
| Tempo stretching / beat matching | BLOCKED — same |
| Efficient/Balanced/Performance modes | N/A (single-threaded worker-equivalent; nothing to tune yet) |

## Lyrics
| Feature | Status | Notes |
|---|---|---|
| Provider chain | IMPLEMENTED | LyricsPlus (mirror race) + PaxSenix (Apple TTML word-timed, the mobile workhorse) + BetterLyrics (TTML) + SimpMusic (video-id-keyed) + KuGou (Asian catalogue) + LRCLIB — raced in parallel, taken in priority, word-synced first, with YT plain text as last resort (`electron/lyrics.ts`) |
| Word/syllable sync | IMPLEMENTED | TTML + rich-LRC parsers; karaoke sweep via rAF (`src/components/SyncedLyrics.tsx`) |
| Instrumental gaps | IMPLEMENTED | ≥5s silence between lines renders a pulse marker |
| Background vocals split | N/A (deferred) | TTML x-bg collected inline for now |
| Provider order + syllable-priority | IMPLEMENTED | word-sync-first selection with a completeness guard (an answer must cover ≥60% of the track or it yields to a complete one from a lower-priority source); "Lyrics by {source}" credit rendered in the lyrics panel |
| LyricsPlus / PaxSenix / KuGou | IMPLEMENTED — full ports (mirror race, Apple token scrape, hash-chain search) |
| Musixmatch / Genius | BLOCKED — signed-token/scraper flows; provider interface takes them without caller changes |
| Seek / highlight / blur / loading / unavailable states | IMPLEMENTED | pre-existing |

## Canvas
| Feature | Status |
|---|---|
| Canvas providers | IMPLEMENTED: community index + Tidal (embed token), match-verified, negative-cached LRU-64 (`electron/canvas.ts`) |
| Apple Music canvas | BLOCKED — token scraping from the web player; provider shape accepts it later |
| Renderer | IMPLEMENTED: looping muted video over still art in Now Playing, `animatedCanvas` setting now real |
| Spotify canvas (needs your session cookie) | N/A — not carried over |

## Downloads / offline
| Feature | Status |
|---|---|
| Queue, concurrency (2), cancel, retry | IMPLEMENTED (`electron/downloads.ts`) |
| Progress + lifecycle events | IMPLEMENTED (`download:event` channel) |
| Metadata + cover embedding | BLOCKED — needs a tagger dependency (mp4/flac writers); not faked |
| Download quality | IMPLEMENTED (ceiling passed to the resolver) |
| Offline playback of saved files | PARTIAL — files land in your download folder; the app doesn't play them back from disk yet |
| Cache management | N/A — ByTune streams via browser buffering; the fake "cache limit" slider was removed |

## Local music library
| Feature | Status |
|---|---|
| Folder scan/rescan, tags, cover art, durations | IMPLEMENTED (`electron/local-library.ts`, music-metadata; art via localart:// protocol) |
| Non-music filter (≥30s + recordings/voice-notes paths) | IMPLEMENTED (desktop-path heuristics) |
| Songs/albums/artists + search + sort | IMPLEMENTED (`src/views/LocalMusicView.tsx`, sidebar entry) |
| Genres view | PARTIAL — genre captured in tags, no dedicated view yet |

## Sources
| Feature | Status |
|---|---|
| MusicSource abstraction (health/search/stream, StreamRequest) | IMPLEMENTED (`electron/sources.ts`) |
| JioSaavn (api.php, DES-ECB URL decrypt, conditional 320 rewrite, 96kbps floor) | IMPLEMENTED — direct port |
| Addon HTTP sources (manifest/search/stream, quality negotiation) | IMPLEMENTED + Sources settings UI with health checks |
| Search fan-out merge (badge + play routing) | IMPLEMENTED |
| QuickJS module sources | BLOCKED — sandbox dependency; the HTTP addon protocol covers the same need |
| TrackMatcher scoring | PARTIAL — full 661-line scorer not ported; providers self-match via strict title/artist checks |

## Search / discovery
| Feature | Status |
|---|---|
| Songs/artists/albums/videos + suggestions + recents | IMPLEMENTED (pre-existing) |
| Playlists in results | IMPLEMENTED |
| Dropdown-only typing (home stays) + rich dropdown | IMPLEMENTED (earlier in this track of work) |
| Multi-source search | IMPLEMENTED (JioSaavn/addons merged, tagged) |
| Progressive results | PARTIAL — top result still waits on the YT call |

## Playlists
Create/rename/delete/add/remove/queue/play next: IMPLEMENTED (pre-existing). Pin to top: IMPLEMENTED.

## Accounts
| Feature | Status |
|---|---|
| YT Music sign-in | IMPLEMENTED — cookie paste (desktop-appropriate equivalent of Android's webview login); session rebuilt on change; personalized home when signed in |
| Multi-account / brand selection | N/A (v1: one session) — the store format takes more later |

## Integrations
| Feature | Status |
|---|---|
| ListenBrainz (playing_now + single listens) | IMPLEMENTED (`electron/integrations.ts`) |
| Last.fm (token→session auth w/ md5 signing, now-playing, 50%/4min scrobble rule) | IMPLEMENTED — you supply your own API key/secret |
| Discord Rich Presence | IMPLEMENTED — local Discord IPC pipe (no user token, desktop-native vs Android's gateway), track/artist/timestamps/buttons, reconnect backoff |

## Replay / statistics
| Feature | Status |
|---|---|
| Listen recording (5s progress bus, ≥30s play floor) | IMPLEMENTED (`electron/stats.ts`, monthly JSON buckets) |
| Top songs/artists/albums, listening time, plays | IMPLEMENTED |
| Activity (28-day) + hour-of-day charts | IMPLEMENTED |
| Periods: this/last month, year, all time | IMPLEMENTED |
| Replay view (sidebar) | IMPLEMENTED — only real recorded data; empty periods say so |
| Share-image recap | N/A (v1) |

## Desktop-native
Keyboard shortcuts, media keys, SMTC, right-click menus, drag-reorder: IMPLEMENTED (pre-existing). Tray/mini-player: N/A (v1). Android Auto / widgets / haptics / overscroll: N/A — no desktop equivalent needed.

## Security hardening (this pass)
CSP meta (script/style/img/media/connect allowlists), `sandbox: true` on the BrowserWindow, DevTools gated to dev builds, filesystem allowlist for open/reveal/download paths (only user-picked or default download dirs + app data), proxy token map (no raw-URL relay), addon URLs validated to http(s), npm audit: 0 vulnerabilities.

## Known limitations (honest)
- Lossless/Hi-Res: requires an addon source serving FLAC/ALAC; YouTube Music itself cannot provide it.
- Automix does beat-aligned crossfades; it does not do vocal analysis, bass/filter transitions or tempo stretch (marked BLOCKED, not faked).
- Download metadata embedding awaits a tagger dependency.
- Lyrics provider order is fixed (BetterLyrics → SimpMusic → LRCLIB) in v1; the provider list is data-driven for later settings.
- Last.fm requires your own API account (key + secret) — deliberate, so ByTune doesn't ship someone else's credentials.
