# ByTune — Design Spec

An Apple-Music-style visual language on a black canvas, arranged in
Spotify's desktop shell. Built from Apple Music-style design references and
Spotify's desktop layout.

Rule of thumb: **the look** (black canvas, heavy tight type,
artwork-derived colour, glass), **Spotify supplies the desktop arrangement**
(three panes, top bar, bottom player bar).

---

## 1. Global tokens

### Colour

| Token | Value | Use |
|---|---|---|
| base | `#000000` | app background |
| surface | `#0D0D0F` | content surface |
| panel | `#1C1C1E` | sidebar, settings cards, panels |
| elevated | `#2C2C2E` | menus, toasts, modals |
| ink.hi | `#FFFFFF` | headlines, active row titles |
| ink | `rgba(255,255,255,0.92)` | body |
| ink.dim | `#8E8E93` | secondary text, subtitles |
| ink.faint | `white @ 55%` | metadata, timestamps |
| ink.ghost | `white @ 34%` | disabled, decorative |
| accent | ByTune violet `rgb(139 92 246)` | progress, focus, active tints only |

- White is the primary control colour (play FABs, selected pills, switches):
  white fill, black glyph. No violet buttons.
- Artwork is the only source of saturated colour. Ambient washes are derived
  from the cover and never exceed ~0.10 alpha on the black canvas.
- Accent red `#FA2D48` reserved (Replay rank badge).

### Typography

Segoe UI Variable (SF Pro stand-in), heavy + tight:

| Role | Weight | Size | Tracking |
|---|---|---|---|
| Page title | 800 | 34px | -0.03em |
| Section header | 800 | 21-22px | -0.02em |
| Card title | 600 | 15px | normal |
| Row title | 600 | 14px | normal |
| Subtitle / secondary | 400 | 12.5-13px | normal |
| Micro label | 600 | 11px | uppercase, +0.14em |

### Shape, spacing, motion

- Radii: rows 8 · artwork/cards 12 · hero 18 · panels 20 · modals 24 · pills 999
- Artwork hairline: `inset 0 0 0 1px rgba(255,255,255,0.15)` on every cover
- Spacing rhythm: 4/8/12/16/24; page gutter 24-32 on desktop
- Motion: 150-220ms `cubic-bezier(0.2,0.8,0.3,1)`; mesh drift 8s ease-in-out;
  skeleton shimmer 1.4s linear

### Glass morphism (exact recipe)

```css
.glass {
  background: linear-gradient(165deg, rgba(255,255,255,0.045),
              rgba(255,255,255,0.015) 55%), rgba(18,18,18,0.40);
  border: 0.5px solid rgba(255,255,255,0.10);
  backdrop-filter: blur(20px) saturate(150%);   /* colourControls 1.5 */
  box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.5),  /* Highlight.Default */
              0 4px 24px rgba(0,0,0,0.10);          /* Shadow.Default */
}
```

Applied to: top bar, sidebar, player bar, floating panels, sheets, dialogs.
`reduce-blur` → drop backdrop-filter, fill solid `#121212`; `reduce-motion` →
kill transitions/animations globally.

---

## 2. Shell layout (from Spotify desktop)

Three columns over a black canvas, fixed bottom player bar.

```
┌──────────────────────────────────────────────────────────────────┐
│  top bar 56px: ‹ ›  ·  [home pill] [search field, flex] ·  bell ⚙ avatar │
├────────────┬──────────────────────────────────────┬──────────────┤
│ sidebar    │  content (scrolls)                   │ right panel  │
│ 280px      │  rounded-[8px] bg-surface            │ 360-400px    │
│ bg-panel   │                                      │ (queue/      │
│ rounded-lg │  page title 34/800                   │  lyrics)     │
│            │  shelves → grid of cards             │              │
├────────────┴──────────────────────────────────────┴──────────────┤
│ player bar 88px: track │ transport+seek │ extras+volume           │
└──────────────────────────────────────────────────────────────────┘
```

- **Top bar** (56px, `chrome-glass`, no border): back/forward circles 32px;
  centred floating search field max-w-[560px], h-10, rounded-full,
  `bg-white/[0.07]`, search glyph left, clear/capture right; notification bell,
  settings gear, avatar 32px circle right.
- **Sidebar** (280px, `bg-panel`, rounded-lg, 8px inset from edges):
  "Your Library" header + ⊕ and expand icons; filter pills (Playlists…);
  search row + "Recents ⇅"; playlist rows: 48px square art, title 14/600,
  subtitle 12.5 dim.
- **Content**: bg-surface rounded-lg with 8px gap from sidebar; page title
  34px/800 tracking -0.03em; shelves as horizontal card rows with hover-
  revealed scrollbar.
- **Player bar** (88px, `player-glass`, top hairline): 64px cover + title/
  artist + heart left; centre shuffle/prev/PLAY(48px white)/next/repeat over
  seek with time labels; right lyrics, queue, canvas toggle, volume, miniplayer,
  fullscreen.
- **Right panel** (queue or lyrics), `glass-side`, 20px radius, header with
  tabs + close.

---

## 3. Screens

### Home (mobile anatomy, desktop grid)
1. Page title — time-of-day greeting, 34/800.
2. "Jump back in" — **2-col (lg:3-col) tile grid**, h-16, rounded-lg,
   `bg-white/[0.03]` → hover `0.08`; 64px square art left (square corners),
   title 13/600 + artist 12 dim, play FAB 36px appears on hover.
3. Mood chips — rounded-full `bg-white/[0.05]`, 13px, hover 0.09.
4. Shelves — section header 21/800; card row: 168px square cover rounded-xl,
   title 15/600, subtitle 13 dim; play FAB bottom-right on hover.

### Explore
- Page title "Explore" 34/800.
- **Moods & moments / Genres**: 2-col grid of 16:10 tiles, rounded-xl, each a
  diagonal duotone gradient (colour from a fixed per-category palette — orange,
  purple, magenta, indigo) with bold white title top-left and a **rotated
  (~12°) cover thumbnail** overlapping the right edge, cropped by the tile.
  Hover: tile brightens slightly, thumbnail straightens.

### Search
- Field sits in the top bar (see shell).
- Filter pills row: All (active = white pill, black text) · Songs · Videos ·
  Albums · Artists — h-8 rounded-full `bg-white/[0.06]`.
- **Top result**: 96px cover rounded-lg, title 22/700, subtitle 14 dim,
  kebab menu right; below it **Play** (white pill) + **Playlist** (outline pill)
  buttons h-10.
- **Songs**: rows — 56px cover rounded-lg, title 14/600 + artist 12.5 dim,
  kebab right; hairline divider between rows.

### Now Playing (full-screen)
- **Backdrop**: artwork mesh — blurred over-scaled cover (blur ~90px, scale
  1.6) + two drifting radial palette blobs + black scrim 0.25→0.80 bottom.
  Whole surface is tinted by the cover (the red "BATIDAO FUNK" case).
- Top: drag handle capsule 38×5 white/32; close chevron left.
- **Full-bleed cover art** (setting): cover runs to the top edges, dissolving
  into the mesh at ~42% height. Square-sleeve mode: centred rounded-lg cover,
  `min(42vh, 460px)`, shadow-art.
- Title row: **E explicit badge** (11px, 1px border, radius 2) + title 26/800
  white; artist 14 @ 55% white; kebab in a 36px translucent circle right.
- Lyric strip: current line 15/600, "Lining up the lyrics" while syncing.
- Seek: full-width thin bar; elapsed left, `-remaining` right, 13px @ 55%.
- Transport: prev / **play 64px white circle** / next, white glyphs, evenly
  spread, max-w 560.
- Volume row: speaker icons 20px @ 50% + slider (white fill, 26% rest).
- Bottom toggle row: shuffle · repeat · **autoplay ∞ in a 48px translucent
  circle** · queue — 44px circles, white @ 75% → 100% when active.

### Queue sheet (over Now Playing)
- Glass sheet, 20px top radius, over the dimmed player.
- Header: 44px cover + title 15/600 + artists 12.5 @ 55%, kebab circle right.
- "Queue" 20/700 + "Clear" text-button right.
- Rows: 44px art radius 6, **E badge** + title 14/600, artists 12.5 @ 55%;
  eq-bars on the playing row; ✕ remove right; drag handle appears on hover.
- **AutoPlay section**: ∞ glyph + "AutoPlay" 15/700 + subtitle 12.5 @ 55%,
  then suggested rows with a drag-handle glyph on the left.

### Song actions sheet (bottom sheet)
- Glass sheet, 24px top radius, drag capsule centred.
- Header: 56px cover rounded-lg + title 15/600 + artist 12.5 dim.
- Menu rows h-12: icon 22px + label 14px — Start radio · Play next ·
  Add to queue · Sleep timer · Copy log. Divider under header only.

### Settings
- Page title "Settings" 34/800.
- Inset cards (`bg-panel`, radius 14, mx-16) per group; uppercase 11px header
  above; optional 12.5px footer below.
- Row: 22px glyph + title 14px + subtitle 12.5 dim (max 2 lines) | value 14px
  dim + chevron, or **switch** (white track / black knob when on,
  `white/16` track / white knob when off, 42×26).
- Sub-row: no glyph, sits tight under its parent (Download over Wi-Fi only,
  Export compatible downloads).
- Segmented control: `bg-elevated` track radius 10, 2px inset, active pill
  white with black 12px/600 label (Output precision, Theme, Refresh rate).
- Slider row: glyph + title + current value right, track below inset to text
  column (Crossfade 0-12s, Song cache limit).
- Badges: 10px/600 uppercase, radius 5, `white/16` fill — "IN USE", "BETA".
- Groups, in order: Account & integrations · Audio quality (Sources, On Wi-Fi,
  On mobile data, Dolby Atmos) · Downloads · Playback (Output precision,
  Prefer USB DAC, Crossfade, Automix β, Skip silence, Spatial audio,
  Equalizer) · Appearance (Theme, Reduce animation, Reduce dynamic blur,
  Liquid Glass, Full-screen cover art, Legacy mesh gradient, Animated cover
  art, Synced lyrics, Blur unfocused lyrics, Lyrics sources) · Performance
  (High performance mode β, Refresh rate) · Local music · Storage · Your data
  (Replay, Work out genres, Export data, Import data) · Miscellaneous ·
  Language · Advanced options (Nerd stats, Lyrics debug logs) · version footer.

---

## 4. Component anatomy quick-reference

| Component | Spec |
|---|---|
| Explicit badge "E" | 11px, 1px white/40 border, radius 2, 3px h-padding |
| Play FAB | white circle, black glyph, shadow-elev, hover scale 1.05 |
| Selected pill | white bg, black text |
| Unselected pill | `white/6` bg, ink text |
| Switch | 42×26; on: white track + black knob; off: `white/16` + white knob |
| Slider | 4px track; fill white; rest `white/26`; buffered `white/14`; thumb 13px on hover |
| Row (list) | h-14, px-3, radius 8; active `accent/14`; hover `white/5` |
| Card | cover rounded-xl + title 15/600 + sub 13 dim |
| Skeleton | radius 10, `white/4.5→8.5` shimmer 1.4s |
| Toast/menu | `glass-strong`, radius 16-24, shadow-float |

---

## 5. Implementation status

Already done in `src/`: tokens (`tailwind.config.js`, `index.css`), glass
recipe, NowPlaying mesh backdrop (`MeshBackdrop.tsx`), player bar, shelf cards,
track rows, full settings page + store, reduce-motion/blur wiring.

Remaining to build: three-pane shell (sidebar 280 + content + right panel),
top bar with floating search, Explore moods/genres grid, Search top-result
layout, full-bleed now-playing mode, queue & actions sheets, mini-player pill.
