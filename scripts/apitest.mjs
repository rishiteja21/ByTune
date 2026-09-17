/**
 * Quick API validation for youtubei.js v18 — mirrors what electron/music-service.ts
 * expects: search shapes, stream URL resolution per client, home feed, lyrics.
 */
import { Innertube } from "youtubei.js";

/* eslint-disable no-console */

function text(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v.text === "string") return v.text;
  if (Array.isArray(v.runs)) return v.runs.map((r) => r?.text ?? "").join("");
  return "";
}

function collectItems(root) {
  const items = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const type = String(node.type ?? "");
    if (type === "MusicResponsiveListItem" || type === "MusicTwoRowItem") {
      items.push(node);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return items;
}

function pickThumb(th) {
  let url = "";
  if (typeof th === "string") url = th;
  else if (Array.isArray(th)) url = th[th.length - 1]?.url ?? "";
  else if (Array.isArray(th?.thumbnails)) url = th.thumbnails[th.thumbnails.length - 1]?.url ?? "";
  else url = th?.url ?? "";
  return url.replace(/\/w\d+-h\d+(-[pjl]?|[-a-z]*)\//, "/w544-h544/");
}

const yt = await Innertube.create();
console.log("[ok] Innertube.create()");

// ---- search ----
const res = await yt.music.search("daft punk one more time", { filters: "songs" });
const items = collectItems(res).filter((i) => i.type === "SONG" || i.type === "VIDEO");
console.log(`[ok] music.search(songs) → ${items.length} song items`);
const first = items[0];
if (!first) throw new Error("no song items parsed");
console.log("first item:", JSON.stringify({
  type: first.type,
  id: first.id,
  title: text(first.title),
  artist: Array.isArray(first.authors) ? first.authors.map((a) => text(a)).join(", ") : null,
  album: first.album?.name ?? null,
  duration: first.duration,
  thumb: pickThumb(first.thumbnail ?? first.thumbnails).slice(0, 60),
}, null, 1));

// also confirm albums + artists filters
for (const filter of ["albums", "artists", "videos"]) {
  const r = await yt.music.search("daft punk", { filters: filter });
  const kinds = collectItems(r).map((i) => i.type);
  console.log(`[ok] music.search(${filter}) → ${kinds.length} items:`, [...new Set(kinds)].join(","));
}

// ---- album ----
const albumRes = await yt.music.search("discovery daft punk", { filters: "albums" });
const albumItem = collectItems(albumRes).find((i) => i.type === "ALBUM");
if (albumItem) {
  const info = await yt.music.getInfo(albumItem.id);
  const tracks = collectItems(info).filter((i) => i.type === "SONG" || i.type === "VIDEO");
  console.log(`[ok] music.getInfo(album ${albumItem.id}) → "${text(info?.title)}" with ${tracks.length} tracks`);
} else {
  console.log("[warn] no album item found for album test");
}

// ---- stream resolution across clients ----
const CLIENTS = ["MUSIC", "WEB", "IOS", "ANDROID", "TV"];
const videoId = first.id;
for (const client of CLIENTS) {
  try {
    const info = await yt.getBasicInfo(videoId, client);
    const sd = info?.streaming_data;
    const audio = (sd?.adaptive_formats ?? []).filter((f) => f?.has_audio && !f?.has_video);
    let url = null;
    if (audio.length) {
      audio.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      const f = audio.find((x) => String(x.mime_type ?? "").includes("mp4")) ?? audio[0];
      url = f.url ?? null;
      if (!url && typeof f.decipher === "function") {
        try {
          f.decipher(yt.session.player);
          url = f.url ?? null;
        } catch (e) {
          console.log(`    decipher threw for ${client}:`, e.message);
        }
      }
    }
    if (!url) {
      console.log(`[..] client ${client}: no audio url (formats: ${audio.length}, sd: ${!!sd})`);
      continue;
    }
    const probe = await fetch(url, { headers: { Range: "bytes=0-1" } });
    try { await probe.arrayBuffer(); } catch {}
    console.log(`[ok] client ${client}: audio url probe → HTTP ${probe.status} (mime ${String(audio[0]?.mime_type ?? "?")}, kbps ${Math.round((audio[0]?.bitrate ?? 0) / 1000)})`);
  } catch (err) {
    console.log(`[fail] client ${client}: ${err.message}`);
  }
}

// ---- home + lyrics ----
try {
  const feed = await yt.music.getHomeFeed();
  const sections = Array.isArray(feed?.sections) ? feed.sections : [];
  console.log(`[ok] music.getHomeFeed() → ${sections.length} sections`);
} catch (err) {
  console.log(`[warn] getHomeFeed: ${err.message}`);
}

try {
  const lyrics = await yt.music.getLyrics(videoId);
  console.log(`[ok] music.getLyrics() → ${lyrics?.text ? `${lyrics.text.length} chars` : "null"}`);
} catch (err) {
  console.log(`[warn] getLyrics: ${err.message}`);
}

console.log("ALL DONE");
