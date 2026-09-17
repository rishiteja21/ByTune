/**
 * Phase-21 QA harness for the Home recommendation engine — NOT shipped.
 *
 * Bundles the pure engine (profile + section builder) with esbuild and runs
 * five simulated user states through it, printing each resulting Home feed.
 * Run:  node scripts/recs-qa.mjs
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** project root (…/bitchord-desktop) */
const root = fileURLToPath(new URL("..", import.meta.url));

const entry = `
import { computeTasteProfile } from "../src/lib/recs/profile";
import { buildHomeSections, sectionPriorities } from "../src/lib/recs/sections";
import type { ArtistBundle } from "../src/lib/recs/candidates";
import type { ReplaySummary } from "../electron/stats";
import type { Track } from "../src/types";

const now = Date.now();
const HOUR = 3600e3, DAY = 86400e3;

function track(id, title, artist, artistId, album) {
  return { id, title, artist, artistId, album, duration: 200, thumb: "" };
}

function summary(period, artists, tracks, plays, hours = new Array(24).fill(0)) {
  return {
    totalMs: tracks.reduce((m, t) => m + t.ms, 0),
    plays,
    tracks,
    artists,
    albums: [],
    hours,
    days: [],
    period,
    months: [],
  };
}

// ---- simulated catalogs --------------------------------------------------/
const CATALOG = {
  weeknd: { id: "yt_weeknd", name: "The Weeknd" },
  mj: { id: "yt_mj", name: "Michael Jackson" },
  lana: { id: "yt_lana", name: "Lana Del Rey" },
  anirudh: { id: "yt_anirudh", name: "Anirudh Ravichander" },
  drake: { id: "yt_drake", name: "Drake" },
  billy: { id: "yt_billy", name: "Billy Joel" },
};

function topSongs(who, n) {
  return Array.from({ length: n }, (_, i) => track(\`\${who}_song_\${i}\`, \`\${CATALOG[who].name} Song \${i}\`, CATALOG[who].name, CATALOG[who].id, \`\${CATALOG[who].name} Album\`));
}

function bundle(who, relatedWhos) {
  const b = {
    artistId: CATALOG[who].id,
    name: CATALOG[who].name,
    thumb: \`photo://\${who}\`,
    topSongs: topSongs(who, 10),
    albums: [
      { id: \`\${who}_album_1\`, title: \`\${CATALOG[who].name} Album One\`, artist: CATALOG[who].name, thumb: \`art://\${who}1\` },
      { id: \`\${who}_album_2\`, title: \`\${CATALOG[who].name} Album Two\`, artist: CATALOG[who].name, thumb: \`art://\${who}2\` },
      { id: \`\${who}_album_3\`, title: \`\${CATALOG[who].name} Album Three\`, artist: CATALOG[who].name, thumb: \`art://\${who}3\` },
    ],
    related: relatedWhos.map((r) => ({ id: CATALOG[r].id, name: CATALOG[r].name, thumb: \`photo://\${r}\` })),
    fetchedAt: now,
  };
  return b;
}

// statsSummary-shaped inputs: artists[] {name, ms, plays}, tracks[] {id, title, artist, thumb, ms, plays, lastAt}
function artistStat(name, ms, plays) { return { name, ms, plays }; }
function trackStat(t, ms, plays, lastAt) { return { id: t.id, title: t.title, artist: t.artist, thumb: "", ms, plays, lastAt }; }

function bundlesFor(...whos) {
  const map = new Map();
  const rel = {
    weeknd: ["drake", "mj", "lana"],
    mj: ["drake", "weeknd", "billy"],
    lana: ["weeknd", "billy", "drake"],
    anirudh: ["drake", "weeknd", "lana"],
    drake: ["weeknd", "mj", "lana"],
    billy: ["mj", "lana", "drake"],
  };
  for (const w of whos) map.set(CATALOG[w].id, bundle(w, rel[w]));
  return map;
}

function show(label, profile, bundleMap) {
  const sections = buildHomeSections({ profile, bundles: bundleMap, ytShelves: null, now });
  console.log("\\n=== " + label + " ===");
  console.log("maturity:", profile.maturity, "| totalPlays:", profile.totalPlays);
  console.log("top artists:", profile.artists.slice(0, 4).map((a) => \`\${a.name}(\${a.score.toFixed(1)})\`).join(", ") || "(none)");
  console.log("priorities:", sectionPriorities(profile, null, now).map((p) => \`\${p.id}:\${p.priority}\`).join(" "));
  for (const s of sections) {
    const anchor = s.eyebrow ? \` [eyebrow: \${s.eyebrow.label} \${s.eyebrow.name}]\` : "";
    console.log(\`  \${s.title}\${anchor} <\${s.layout}> (\${s.items.length} items, prio \${s.priority === 0 ? "-" : "?"})\`);
    console.log(\`     items: \${s.items.slice(0, 4).map((it) => it.style === "track" ? it.track.title : it.style === "album" ? it.album.title : it.style === "artist" ? it.artist.name : (it.style === "mix" ? it.name : it.name)).join(" | ")}\`);
  }
  if (sections.length === 0) console.log("  (no sections)");
}

// ---- TEST USER A: heavy The Weeknd listener ------------------------------
{
  const wk = CATALOG.weeknd.name;
  const monthTracks = topSongs("weeknd", 6).map((t, i) => trackStat(t, 60 * 60e3 - i, 12 - i, now - 2 * HOUR));
  const allTracks = [...monthTracks, ...topSongs("drake", 2).map((t) => trackStat(t, 10 * 60e3, 3, now - 9 * DAY))];
  const profile = computeTasteProfile({
    all: summary("all", [artistStat(wk, 500 * 60e3, 90), artistStat(CATALOG.drake.name, 10 * 60e3, 3)], allTracks, 120),
    month: summary("month", [artistStat(wk, 360 * 60e3, 60)], monthTracks, 70),
    history: [...topSongs("weeknd", 2), ...topSongs("drake", 1)],
    liked: topSongs("weeknd", 3),
    playlists: [],
    searches: ["the weeknd"],
    skips: {},
    now,
  });
  show("USER A — heavy The Weeknd", profile, bundlesFor("weeknd", "drake", "mj", "lana", "anirudh", "billy"));
}

// ---- TEST USER B: Michael Jackson + Lana Del Rey -------------------------
{
  const hist = [...topSongs("mj", 2), ...topSongs("lana", 2)];
  const monthTracks = [...topSongs("mj", 4).map((t, i) => trackStat(t, 40 * 60e3 - i, 9 - i, now - 5 * HOUR)), ...topSongs("lana", 4).map((t, i) => trackStat(t, 35 * 60e3 - i, 8 - i, now - DAY))];
  const profile = computeTasteProfile({
    all: summary("all", [artistStat(CATALOG.mj.name, 300 * 60e3, 55), artistStat(CATALOG.lana.name, 280 * 60e3, 50), artistStat(CATALOG.billy.name, 20 * 60e3, 5)], [...monthTracks, ...topSongs("billy", 2).map((t) => trackStat(t, 8 * 60e3, 2, now - 20 * DAY))], 130),
    month: summary("month", [artistStat(CATALOG.mj.name, 160 * 60e3, 35), artistStat(CATALOG.lana.name, 140 * 60e3, 32)], monthTracks, 70),
    history: hist,
    liked: topSongs("mj", 1).concat(topSongs("lana", 2)),
    playlists: [],
    searches: ["lana del rey", "michael jackson"],
    skips: {},
    now,
  });
  show("USER B — MJ + Lana Del Rey", profile, bundlesFor("mj", "lana", "weeknd", "drake", "billy", "anirudh"));
}

// ---- TEST USER C: cold start --------------------------------------------
{
  const profile = computeTasteProfile({
    all: summary("all", [], [], 0),
    month: summary("month", [], [], 0),
    history: [],
    liked: [],
    playlists: [],
    searches: [],
    skips: {},
    now,
  });
  const ytShelves = [
    { title: "Popular albums", items: [{ kind: "album", album: { id: "yt_pop1", title: "Everybody's Album", artist: "Someone Popular", thumb: "art://pop1" } }] },
    { title: "Trending songs", items: [{ kind: "track", track: { id: "yt_tr1", title: "Trending Hit", artist: "Trending Star", duration: 200, thumb: "art://tr1" } }] },
  ];
  show("USER C — cold start (with YouTube fallback feed)", profile, new Map());
  const sections = buildHomeSections({ profile, bundles: new Map(), ytShelves, now });
  console.log("  with ytShelves:");
  for (const s of sections) console.log(\`    \${s.title} <\${s.layout}> (\${s.moods ? s.moods.length + " moods" : s.items.length} items)\`);
}

// ---- TEST USER D: suddenly heavy on ONE new artist ----------------------
{
  const hist = [...topSongs("weeknd", 1), ...topSongs("anirudh", 3)];
  const monthTracks = [
    ...topSongs("anirudh", 5).map((t, i) => trackStat(t, 50 * 60e3 - i, 14 - i, now - 1 * HOUR)),
    ...topSongs("weeknd", 2).map((t, i) => trackStat(t, 12 * 60e3 - i, 4 - i, now - 6 * DAY)),
  ];
  const profile = computeTasteProfile({
    all: summary("all", [artistStat(CATALOG.anirudh.name, 50 * 60e3, 14), artistStat(CATALOG.weeknd.name, 300 * 60e3, 80)], [...monthTracks, ...topSongs("weeknd", 3).map((t) => trackStat(t, 40 * 60e3, 20, now - 6 * DAY))], 100),
    month: summary("month", [artistStat(CATALOG.anirudh.name, 50 * 60e3, 14), artistStat(CATALOG.weeknd.name, 12 * 60e3, 4)], monthTracks, 20),
    history: hist,
    liked: topSongs("anirudh", 1),
    playlists: [],
    searches: ["anirudh"],
    skips: {},
    now,
  });
  show("USER D — suddenly heavy on a NEW artist (Anirudh)", profile, bundlesFor("anirudh", "weeknd", "drake", "mj", "lana", "billy"));
}

// ---- TEST USER E: has not listened for days + skipper -------------------
{
  const old = now - 12 * DAY;
  const hist = [...topSongs("drake", 3)];
  const monthTracks = topSongs("drake", 4).map((t, i) => trackStat(t, 30 * 60e3 - i, 8 - i, old - i * 3600e3));
  const skips = { drake: { count: 5, updatedAt: old } };
  const profile = computeTasteProfile({
    all: summary("all", [artistStat(CATALOG.drake.name, 120 * 60e3, 40)], monthTracks, 60),
    month: summary("month", [artistStat(CATALOG.drake.name, 30 * 60e3, 8)], monthTracks, 10),
    history: hist,
    liked: [],
    playlists: [],
    searches: [],
    skips,
    now,
  });
  show("USER E — absent 12 days, has been skipping Drake", profile, bundlesFor("drake", "weeknd", "mj", "lana", "billy", "anirudh"));
}

// ---- determinism check: same inputs twice → identical feed --------------
{
  const mk = () => computeTasteProfile({
    all: summary("all", [artistStat("A", 100, 10)], [], 10),
    month: summary("month", [artistStat("A", 100, 10)], [], 10),
    history: [],
    liked: [],
    playlists: [],
    searches: [],
    skips: {},
    now,
  });
  const p1 = mk(), p2 = mk();
  console.log("\\n=== determinism ===");
  console.log("signature stable:", p1.signature === p2.signature, "| daySeed stable:", p1.daySeed === p2.daySeed);
}
`;

const outDir = mkdtempSync(join(tmpdir(), "recs-qa-"));
const entryPath = join(root, "scripts", "recs-qa.entry.ts");
writeFileSync(entryPath, entry);

try {
  await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(outDir, "entry.mjs"),
    external: ["electron"],
  });

  await import(pathToFileURL(join(outDir, "entry.mjs")).href);
} finally {
  rmSync(entryPath, { force: true });
}
