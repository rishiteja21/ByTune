/**
 * Lyrics providers for the desktop player.
 *
 * Providers are raced in parallel but their answers are taken in priority
 * order; a word-synced answer beats a line-synced one from a source ahead of
 * it when prioritizeWordSync is on (it is, by default). The sweep is
 * deadline-bounded so a slow provider chain can never hold the lyrics view
 * past a couple of seconds. The plain YT Music text stays as the final
 * fallback.
 *
 * Word-timed chain: LyricsPlus (syllable mirrors) → PaxSenix (Apple Music
 * TTML via a public proxy) → BetterLyrics (Apple TTML). Line-synced: KuGou
 * (strong outside the English catalogue) → LRCLIB. All timings are SECONDS
 * end-to-end — providers that serve milliseconds convert at the parse
 * boundary, which is exactly where the classic "lyrics don't match" bug
 * hides.
 */
import type { SyncedLyricLine, SyncedLyricWord } from "../src/types";

export interface LyricQuery {
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** seconds, 0 = unknown */
  duration: number;
}

export interface ProviderResult {
  source: string;
  wordSynced: boolean;
  lines: SyncedLyricLine[];
  /** set when the provider only answered with untimed text */
  plainText?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LYRICS_AGENT = "ByTune (https://github.com/bytune-music)";

async function getText(url: string, timeoutMs = 6000, headers: Record<string, string> = {}): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": LYRICS_AGENT, Accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.log(`[bytune][lyrics-net] HTTP ${res.status} ${url.slice(0, 90)}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.log(`[bytune][lyrics-net] FAIL ${url.slice(0, 90)} :: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- shared parsing ---------------------------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** [mm:ss.xx] or [mm:ss.xxx] → seconds. Hundredths get ×10 to ms first. */
function stampMs(min: string, sec: string, frac: string): number {
  const m = parseInt(min, 10);
  const s = parseInt(sec, 10);
  const f = parseInt(frac.padEnd(3, frac.length === 2 ? "0" : ""), 10);
  return (m * 60 + s) * 1000 + f;
}

/** Placeholders the mixed search page prints when a row carries no credit
 * links ("Unknown artist", same as BitChord mobile) — never a real credit,
 * so the lyric databases must not be asked with it: they key on artist +
 * title and miss every such track. An empty artist degrades each provider
 * to title-based matching instead. */
const PLACEHOLDER_ARTISTS = new Set(["", "unknown artist", "unknown", "various artists", "artist"]);

function primaryArtist(artist: string): string {
  const lead = artist
    .split(/,|;| & | feat\. | ft\. | featuring /i)[0]
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim();
  return PLACEHOLDER_ARTISTS.has(lead.toLowerCase()) ? "" : lead;
}

/** Rendition markers that change the timing itself — a match to the normal
 * studio cut can never stay in sync with these, no matter the offset. */
const EDITION_MARKERS = /(sped[ -]?up|slowed(?:\s*(?:\+|and|&)?\s*(?:down|reverb))?|reverb|nightcore|daycore|super\s*(?:sped|slowed)|remix|bootleg|live)/i;

/** The edition word on the upload's own title, when it names one. */
function editionOf(title: string): string | null {
  return EDITION_MARKERS.exec(title)?.[0]?.toLowerCase() ?? null;
}

/** How far a matched rendition's own runtime may sit from the playing track
 * before the two are different edits: offset alignment repairs a constant
 * intro, never a different tempo. Generous on purpose — an upload that runs
 * a few seconds long still lines up. */
function withinTolerance(recordSec: number | null | undefined, playingSec: number): boolean {
  if (!recordSec || !playingSec) return true;
  return Math.abs(recordSec - playingSec) <= Math.max(12, playingSec * 0.08);
}

/**
 * Title for provider QUERIES: strips any parenthetical/bracket too — YT Music
 * titles carry credit noise like "WILDFLOWER (BILLIE BY FINNEAS)", and every
 * catalogue 401s or mismatches on it. The display title stays untouched.
 */
function queryTitle(title: string): string {
  const base = cleanTitle(title)
    .replace(/\([^)]*\)|\[[^\]]*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return base || cleanTitle(title);
}

/** Strip the noise YouTube titles carry: "(Official Video)", "[HD]" … */
function cleanTitle(title: string): string {
  return title
    .replace(/\((official\s+)?(music\s+)?(lyric[s]?\s+)?(video|audio|visualizer?|mv)\)/gi, "")
    .replace(/\[(official\s+)?(music\s+)?(lyric[s]?\s+)?(video|audio|hd|4k)\]/gi, "")
    .replace(/\s*-\s*(official|lyric|audio|video).*$/i, "")
    .replace(/\|.*$/, "")
    .trim();
}

/** Insert gap markers where ≥5s of nobody sings — instrumental sections. */
function withInstrumentalGaps(lines: SyncedLyricLine[]): SyncedLyricLine[] {
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const next = lines[i + 1];
    if (!next) break;
    const lineEnd = lineEndSec(line, next.time);
    if (next.time - lineEnd >= 5) {
      out.push({ time: lineEnd, text: "", gap: true });
    }
  }
  return out;
}

function lineEndSec(line: SyncedLyricLine, nextStart: number): number {
  if (line.end != null) return line.end;
  const lastWord = line.words?.[line.words.length - 1];
  if (lastWord) return lastWord.end;
  return line.time + Math.min(8, Math.max(2, nextStart - line.time));
}

function toResult(source: string, lines: SyncedLyricLine[]): ProviderResult | null {
  if (!lines.length) return null;
  return { source, wordSynced: lines.some((l) => (l.words?.length ?? 0) > 0), lines: withInstrumentalGaps(lines) };
}

/* ------------------------------ LRC parsing ----------------------------- */

/** Plain LRC → line-synced lines (seconds). Word stamps `<…>` are ignored. */
function parseLrc(lrc: string): SyncedLyricLine[] {
  const rows: { time: number; text: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = /^\[(\d{1,3}):(\d{2})[.:](\d{2,3})](.*)$/.exec(raw.trim());
    if (!m) continue;
    const text = decodeEntities(m[4].replace(/<\d{1,3}:\d{2}[.:]\d{2,3}>/g, "").trim());
    rows.push({ time: stampMs(m[1], m[2], m[3]) / 1000, text });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

/** Word-timed rich LRC: `[mm:ss.xx]<mm:ss.xx>word …` → seconds. */
function parseEnhancedLrc(lrc: string): SyncedLyricLine[] {
  const rows: { time: number; words: { start: number; text: string }[]; plain: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = /^\[(\d{1,3}):(\d{2})[.:](\d{2,3})](.*)$/.exec(raw.trim());
    if (!m) continue;
    const time = stampMs(m[1], m[2], m[3]) / 1000;
    const rest = decodeEntities(m[4]);
    const words = [...rest.matchAll(/<(\d{1,3}):(\d{2})[.:](\d{2,3})>([^<]*)/g)].map((w) => ({
      start: stampMs(w[1], w[2], w[3]) / 1000,
      text: w[4].trim(),
    }));
    rows.push({ time, words, plain: rest.replace(/<\d{1,3}:\d{2}[.:]\d{2,3}>/g, "").trim() });
  }
  rows.sort((a, b) => a.time - b.time);
  if (!rows.some((r) => r.words.length > 0)) return []; // ordinary LRC, not rich
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.words.length === 0) {
      if (row.plain) out.push({ time: row.time, text: row.plain });
      continue;
    }
    const lineEnd = rows[i + 1]?.time ?? row.words[row.words.length - 1].start + 4;
    const words: SyncedLyricWord[] = row.words
      .filter((w) => w.text)
      .map((w, wi) => ({
        start: w.start,
        end: row.words[wi + 1]?.start ?? lineEnd,
        text: w.text,
      }));
    if (!words.length) continue;
    for (const w of words) if (w.end < w.start) w.end = w.start;
    out.push({
      time: Math.min(row.time, words[0].start),
      text: words.map((w) => w.text).join(" "),
      words,
      end: words[words.length - 1].end,
    });
  }
  return out;
}

/* --------------------------------- TTML --------------------------------- */

/** TTML time → SECONDS ("27.395", "H:MM:SS.mmm", "M:SS.mmm"). */
function attrTimeSeconds(attrs: string, name: string): number | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(attrs);
  if (!m) return null;
  const v = m[1];
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  const clock = /^(\d+):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(v);
  if (clock) {
    return (
      parseInt(clock[1], 10) * 3600 +
      parseInt(clock[2], 10) * 60 +
      parseInt(clock[3], 10) +
      parseInt(clock[4].padEnd(3, "0"), 10) / 1000
    );
  }
  const short = /^(\d+):(\d{2})\.(\d{1,3})$/.exec(v);
  if (short) {
    return parseInt(short[1], 10) * 60 + parseInt(short[2], 10) + parseInt(short[3].padEnd(3, "0"), 10) / 1000;
  }
  return null;
}

/**
 * Apple Music TTML, word-timed. A <p> per line, a timed <span> per syllable;
 * syllables of one word are adjacent spans with no whitespace between them,
 * so whitespace — not the span boundary — separates words. All times come
 * out in SECONDS.
 */
function parseTtml(ttml: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];
  const pBlocks = ttml.match(/<p\b[^>]*>[\s\S]*?<\/p>|<p\b[^>]*\/>/g) ?? [];
  for (const block of pBlocks) {
    const open = /<p\b([^>]*)>/.exec(block);
    if (!open) continue;
    const attrs = open[1];
    if (/(?:ttm:role|x-role)\s*=\s*"(x-translation|x-roman)"/.test(attrs)) continue;
    const begin = attrTimeSeconds(attrs, "begin");
    if (begin == null) continue;
    const end = attrTimeSeconds(attrs, "end");

    // Walk the paragraph as a sequence: each span plus the gap text BEFORE it.
    // The gap is where the word boundary usually lives ("</span> <span>") -
    // dropping it glued whole lines into single mega-words.
    const spans = [...block.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)];
    const timed: { begin: number | null; end: number | null; text: string; boundary: boolean }[] = [];
    let prevEnd = 0;
    for (const m of spans) {
      const gap = block.slice(prevEnd, m.index ?? 0);
      timed.push({
        begin: attrTimeSeconds(m[1], "begin"),
        end: attrTimeSeconds(m[1], "end"),
        text: decodeEntities(m[2].replace(/<[^>]+>/g, "")),
        boundary: /\s/.test(gap),
      });
      prevEnd = (m.index ?? 0) + m[0].length;
    }

    if (timed.length === 0) {
      // Line-synced TTML: bare text, no spans.
      const text = decodeEntities(block.replace(/<[^>]+>/g, "")).trim();
      if (!text) continue;
      lines.push({ time: begin, text, end: end != null && end > begin ? end : undefined });
      continue;
    }

    // Merge syllable spans into words: a boundary is whitespace in the gap
    // before a span or whitespace inside the span text (Apple writes it
    // inside, Lyrically-generated TTML writes it between).
    const words: SyncedLyricWord[] = [];
    let cur: { start: number; end: number; text: string } | null = null;
    const closeWord = (): void => {
      if (cur) words.push({ start: cur.start, end: cur.end, text: cur.text.trim() });
      cur = null;
    };
    for (const sp of timed) {
      const text = sp.text;
      if (!text) continue;
      if (!cur || sp.boundary || /^\s/.test(text)) {
        closeWord();
        cur = { start: sp.begin as number, end: sp.end ?? sp.begin ?? 0, text };
      } else {
        cur.text += text;
        cur.end = sp.end ?? cur.end;
      }
      if (/\s$/.test(cur.text)) closeWord();
    }
    closeWord();

    // A producer that emits no whitespace at all: each span is a word.
    if (words.length <= 1 && timed.length > 1) {
      words.length = 0;
      for (const sp of timed) {
        if (sp.begin == null || !sp.text.trim()) continue;
        const st = sp.begin;
        words.push({ start: st, end: Math.max(sp.end ?? st, st), text: sp.text.trim() });
      }
    }
    const clean = words.filter((w) => w.text.length > 0);
    if (clean.length === 0) continue;
    for (const w of clean) if (w.end < w.start) w.end = w.start;
    lines.push({
      time: Math.min(begin, clean[0].start),
      text: clean.map((w) => w.text).join(" "),
      words: clean,
      end: end != null && end > begin ? end : clean[clean.length - 1].end,
    });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/* ------------------------------ LyricsPlus ------------------------------ */

/**
 * Syllable-level lyrics from the YouLy+ backend, on community mirrors that
 * come and go — so all of them are asked in turn and the first usable answer
 * wins; the winner is remembered for the next track.
 */
const LYRICSPLUS_MIRRORS = [
  "https://lyricsplus.prjktla.my.id",
  "https://lyricsplus.atomix.one",
  "https://lyricsplus.binimum.org",
  "https://lyricsplus.prjktla.workers.dev",
  "https://lyricsplus-seven.vercel.app",
  "https://lyrics-plus-backend.vercel.app",
];
let lyricsPlusLastGood: string | null = null;

interface PlusSyllable {
  time?: number; // ms
  duration?: number; // ms
  text?: string;
}
interface PlusLine {
  time?: number; // ms
  duration?: number; // ms
  text?: string;
  syllabus?: PlusSyllable[];
}

/** Glue syllables back into words — a trailing space marks the boundary.
 *  If a source emits no whitespace boundaries at all, each syllable is a word. */
function mergePlusSyllables(syllables: PlusSyllable[]): SyncedLyricWord[] {
  const words: SyncedLyricWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  let boundary = false;
  for (const syl of syllables) {
    if (!syl.text?.trim() || syl.time == null) continue;
    if (!text) start = syl.time / 1000;
    text += syl.text.trim();
    end = syl.time / 1000 + (syl.duration ?? 0) / 1000;
    if (/\s$/.test(syl.text)) {
      words.push({ start, end: Math.max(end, start), text });
      text = "";
      boundary = true;
    }
  }
  if (text) {
    if (boundary) {
      words.push({ start, end: Math.max(end, start), text });
    } else {
      // Whole words with no spacing convention: keep them separate.
      for (const syl of syllables) {
        if (!syl.text?.trim() || syl.time == null) continue;
        const st = syl.time / 1000;
        words.push({ start: st, end: Math.max(st + (syl.duration ?? 0) / 1000, st), text: syl.text.trim() });
      }
    }
  }
  return words;
}

function parsePlusResponse(response: { lyrics?: PlusLine[] | null }): SyncedLyricLine[] {
  const out: SyncedLyricLine[] = [];
  for (const line of response.lyrics ?? []) {
    const startSec = line.time != null ? line.time / 1000 : null;
    if (startSec == null) continue;
    const words = mergePlusSyllables(line.syllabus ?? []);
    if (words.length > 0) {
      out.push({
        time: Math.min(startSec, words[0].start),
        text: words.map((w) => w.text).join(" "),
        words,
        end: words[words.length - 1].end,
      });
    } else if (line.text && line.text.trim()) {
      out.push({
        time: startSec,
        text: line.text.trim(),
        end: line.duration && line.duration > 0 ? startSec + line.duration / 1000 : undefined,
      });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function fetchLyricsPlusOne(host: string, q: LyricQuery): Promise<SyncedLyricLine[] | null> {
  const parse = (body: string | null): SyncedLyricLine[] | null => {
    if (!body) return null;
    try {
      const lines = parsePlusResponse(JSON.parse(body));
      return lines.length ? lines : null;
    } catch {
      return null;
    }
  };
  // The rendition the upload names is asked for first — Apple-backed backends
  // index the actual "(Sped Up)" releases — then the stripped title.
  const stripped = queryTitle(q.title);
  const full = cleanTitle(q.title).trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];
  const attempt = (title: string, withDuration: boolean): string => {
    const params = new URLSearchParams({ title, artist: primaryArtist(q.artist || "") });
    if (withDuration && q.duration > 0) params.set("duration", String(Math.round(q.duration)));
    if (q.album) params.set("album", cleanTitle(q.album));
    return `${host}/v2/lyrics/get?${params.toString()}`;
  };

  // Strict first: the duration disambiguates remixes. But when the YouTube
  // upload runs longer or shorter than every catalogue version (music videos
  // with intros, extended cuts), a hard duration filter rejects the REAL
  // song and a keyword fallback answers with someone else's lyrics — so a
  // strict miss retries once on title+artist alone.
  for (const title of titles) {
    const lines = parse(await getText(attempt(title, true), 7000));
    if (lines) return lines;
    if (q.duration > 0) {
      const loose = parse(await getText(attempt(title, false), 7000));
      if (loose) return loose;
    }
  }
  return null;
}

async function fetchLyricsPlus(q: LyricQuery): Promise<ProviderResult | null> {
  const hosts = lyricsPlusLastGood
    ? [lyricsPlusLastGood, ...LYRICSPLUS_MIRRORS.filter((m) => m !== lyricsPlusLastGood)]
    : LYRICSPLUS_MIRRORS;
  // All mirrors are asked at once; the first to answer with something usable
  // wins the moment it lands — completion order, not mirror order. A slow
  // mirror that will come back empty must not hold up one that already has
  // the track. The winner is remembered for the next track.
  return new Promise((resolve) => {
    let remaining = hosts.length;
    let settled = false;
    const done = (r: ProviderResult | null): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    for (const host of hosts) {
      void fetchLyricsPlusOne(host, q).then(
        (lines) => {
          remaining -= 1;
          if (lines) {
            lyricsPlusLastGood = host;
            done(toResult("LyricsPlus", lines));
          } else if (remaining === 0) done(null);
        },
        () => {
          remaining -= 1;
          if (remaining === 0) done(null);
        }
      );
    }
  });
}

/* ------------------------------ PaxSenix -------------------------------- */

/**
 * Word-timed lyrics via lyrics.paxsenix.org — a public proxy in front of
 * Apple Music's catalogue and lyrics. Apple's own search needs a bearer
 * token, which its web player carries inside one of its JS bundles; scrape
 * it the same way the player does and keep it until Apple says no.
 */
const PAXSENIX_PROXY = "https://lyrics.paxsenix.org";
const APPLE_SEARCH = "https://amp-api.music.apple.com/v1/catalog/us/search";
let appleToken: string | null = null;

function appleClean(s: string): string {
  return s
    .replace(
      /\s*[(\[](official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster\w*|live|version|feat\.?|ft\.?)[^)\]]*[)\]]/gi,
      ""
    )
    .trim();
}

function appleScore(track: { name: string; artist: string }, title: string, artist: string): number {
  const name = track.name.trim().toLowerCase();
  const wantTitle = title.trim().toLowerCase();
  const haveArtist = track.artist.trim().toLowerCase();
  const wantArtist = artist.trim().toLowerCase();
  let score = 0;
  if (name === wantTitle) score += 80;
  else if (name.includes(wantTitle) || wantTitle.includes(name)) score += 40;
  if (haveArtist.includes(wantArtist) || wantArtist.includes(haveArtist)) score += 40;
  return score;
}

async function scrapeAppleToken(): Promise<string | null> {
  const home = await getText("https://music.apple.com/us/new", 8000, {
    "User-Agent": UA,
    Accept: "text/html",
  });
  if (!home) return null;
  const scriptPath = /\/assets\/index~[^"]+\.js/.exec(home)?.[0];
  if (!scriptPath) return null;
  const script = await getText(`https://music.apple.com${scriptPath}`, 8000, {
    "User-Agent": UA,
    Accept: "*/*",
  });
  if (!script) return null;
  return /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(script)?.[0] ?? null;
}

async function getAppleToken(): Promise<string | null> {
  if (appleToken) return appleToken;
  appleToken = await scrapeAppleToken();
  return appleToken;
}

interface AppleCandidate {
  id: string;
  name: string;
  artist: string;
  durationSec: number | null;
}

async function appleSearch(query: string, token: string): Promise<AppleCandidate[] | null> {
  const url = `${APPLE_SEARCH}?term=${encodeURIComponent(query)}&types=songs&limit=10&l=en-US`;
  const body = await getText(url, 7000, {
    Authorization: `Bearer ${token}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    "User-Agent": UA,
  });
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const data = json?.results?.songs?.data;
    if (!Array.isArray(data)) return null;
    return data.map((t) => ({
      id: String(t?.id ?? ""),
      name: String(t?.attributes?.name ?? ""),
      artist: String(t?.attributes?.artistName ?? ""),
      durationSec: t?.attributes?.durationInMillis
        ? Math.round(t.attributes.durationInMillis / 1000)
        : null,
    }));
  } catch {
    return null;
  }
}

interface PaxLyricsResponse {
  ttmlContent?: string | null;
  elrc?: string | null;
  elrcMultiPerson?: string | null;
}

async function fetchPaxSenix(q: LyricQuery): Promise<ProviderResult | null> {
  const stripped = queryTitle(q.title);
  const artist = appleClean(primaryArtist(q.artist || ""));
  if (!stripped) return null;
  const edition = editionOf(q.title || "");
  // Apple indexes the actual edits — "Song (Sped Up)" is a real release — so
  // the rendition the upload names is queried before the stripped title.
  const full = cleanTitle(q.title).trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  let token = await getAppleToken();
  if (!token) return null;

  const searchOnce = async (title: string): Promise<AppleCandidate[] | null> => {
    const query = [title, artist].filter(Boolean).join(" ");
    let results = await appleSearch(query, token!);
    if (!results) {
      // Apple said no — the token went stale. Mint a fresh one, once.
      appleToken = null;
      token = await getAppleToken();
      if (!token) return null;
      results = await appleSearch(query, token);
    }
    return results;
  };

  // The YouTube upload's length must never veto the real song — music videos
  // with intros run longer than the catalogue track, and a hard ±10s filter
  // rejects Despacito-style songs wholesale. Title/artist score decides;
  // duration proximity only breaks ties. One exception: an upload that names
  // an edition ("Sped Up", "Slowed + Reverb") can only take a candidate whose
  // runtime is near its own — the studio cut would sing at the wrong tempo,
  // and no offset repairs that.
  const durDelta = (t: AppleCandidate): number =>
    q.duration <= 0 || t.durationSec == null ? 99999 : Math.abs(t.durationSec - q.duration);

  let best: AppleCandidate | undefined;
  let firstResults: AppleCandidate[] | null = null;
  for (const title of titles) {
    let results = await searchOnce(title);
    if (!results?.length) continue;
    firstResults = firstResults ?? results;
    if (edition && q.duration > 0) {
      const near = results.filter((t) => withinTolerance(t.durationSec, q.duration));
      if (!near.length) continue; // this query only found the wrong edition
      results = near;
    }
    best = [...results].sort(
      (a, b) => appleScore(b, title, artist) - appleScore(a, title, artist) || durDelta(a) - durDelta(b),
    )[0];
    if (best?.id) break;
  }
  if (!best?.id) {
    // Nothing edition-compatible anywhere: fall through to the plain best
    // match only for non-edition titles.
    if (edition || !firstResults?.length) return null;
    best = [...firstResults].sort(
      (a, b) =>
        appleScore(b, stripped, artist) - appleScore(a, stripped, artist) || durDelta(a) - durDelta(b),
    )[0];
  }
  if (!best?.id) return null;

  const body = await getText(`${PAXSENIX_PROXY}/apple-music/lyrics?id=${encodeURIComponent(best.id)}`, 8000);
  if (!body) return null;
  try {
    const json: PaxLyricsResponse = JSON.parse(body);
    if (json.ttmlContent?.trim()) {
      const lines = parseTtml(json.ttmlContent);
      if (lines.length) return toResult("PaxSenix", lines);
    }
    for (const elrc of [json.elrcMultiPerson, json.elrc]) {
      if (elrc?.trim()) {
        const lines = parseEnhancedLrc(elrc);
        if (lines.length) return toResult("PaxSenix", lines);
      }
    }
    console.log(
      `[bytune][lyrics-net] paxsenix no synced content for ${best.id}: keys=${Object.keys(json).join(",")} ttmlLen=${(json.ttmlContent ?? "").length}`
    );
    return null;
  } catch {
    console.log(`[bytune][lyrics-net] paxsenix unparseable body: ${body.slice(0, 120)}`);
    return null;
  }
}

/* ---------------------------- BetterLyrics ------------------------------ */

async function fetchBetterLyrics(q: LyricQuery): Promise<ProviderResult | null> {
  const enc = encodeURIComponent;
  // Edition-titled uploads are asked under their own name first — the backend
  // indexes Apple's actual "(Sped Up)" releases — then the stripped title.
  const blStripped = queryTitle(q.title);
  const blFull = cleanTitle(q.title).trim();
  const titles =
    blFull && blFull.toLowerCase() !== blStripped.toLowerCase() ? [blFull, blStripped] : [blStripped];
  const attempt = (title: string, withDuration: boolean): string => {
    const params = new URLSearchParams({ s: title, a: primaryArtist(q.artist || "") });
    if (withDuration && q.duration > 0) params.set("d", String(Math.round(q.duration)));
    if (q.album) params.set("al", cleanTitle(q.album));
    return `https://lyrics-api.boidu.dev/getLyrics?${params.toString()}`;
  };
  // Same rule as the other word-synced sources: a strict duration miss
  // (YouTube video ≠ catalogue runtime) retries on title+artist alone.
  let body: string | null = null;
  for (const title of titles) {
    body = await getText(attempt(title, true));
    if (!body && q.duration > 0) body = await getText(attempt(title, false));
    if (body) break;
  }
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const ttml = typeof json?.ttml === "string" ? json.ttml : null;
    if (!ttml) return null;
    return toResult("BetterLyrics", parseTtml(ttml));
  } catch {
    return null;
  }
}

/* ------------------------------ SimpMusic ------------------------------- */

async function fetchSimpMusic(q: LyricQuery): Promise<ProviderResult | null> {
  if (!q.id || q.id.includes(":")) return null; // keyed on YouTube video ids only
  const body = await getText(`https://api-lyrics.simpmusic.org/v1/${encodeURIComponent(q.id)}`);
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    if (!json?.success || !Array.isArray(json?.data)) return null;
    const tolerance = 10;
    const track = (json.data as any[])
      .filter((t) => q.duration <= 0 || Math.abs((t.duration ?? 0) - q.duration) <= tolerance)
      .sort((a, b) => Math.abs((a.duration ?? 0) - q.duration) - Math.abs((b.duration ?? 0) - q.duration))[0];
    if (!track) return null;
    const rich = typeof track.richSyncLyrics === "string" && track.richSyncLyrics.trim() ? parseEnhancedLrc(track.richSyncLyrics) : [];
    if (rich.length) return toResult("SimpMusic", rich);
    const synced = typeof track.syncedLyrics === "string" && track.syncedLyrics.trim() ? parseLrc(track.syncedLyrics) : [];
    if (synced.length) return toResult("SimpMusic", synced);
    return null;
  } catch {
    return null;
  }
}

/* -------------------------------- KuGou --------------------------------- */

/**
 * Line-synced lyrics from KuGou's public endpoints — a Chinese catalogue
 * that also carries a great many English and Hindi tracks the western
 * sources don't. Three unauthenticated calls: search the song for its
 * fingerprint hash, search lyrics candidates for that hash, download the
 * winner; a keyword search is the fallback.
 */
const KUGOU_TOLERANCE = 8;

function kugouStripCredits(lrc: string): string {
  const STAMPED = /^\[\d{2}:\d{2}\.\d{2,3}].*/;
  const CREDIT = /.+][^\[]+[:：].+/;
  const lines = lrc.split(/\r?\n/).filter((l) => STAMPED.test(l));
  if (!lines.length) return "";
  const headLimit = Math.min(30, lines.length - 1);
  let headCut = 0;
  for (let i = headLimit; i >= 0; i--) {
    if (CREDIT.test(lines[i])) {
      headCut = i + 1;
      break;
    }
  }
  const body = lines.slice(headCut);
  let tailCut = 0;
  for (let i = 0; i <= Math.min(30, body.length - 1); i++) {
    if (CREDIT.test(body[body.length - 1 - i])) {
      tailCut = i + 1;
      break;
    }
  }
  return body.slice(0, body.length - tailCut).join("\n");
}

async function fetchKuGou(q: LyricQuery): Promise<ProviderResult | null> {
  const stripParen = (s: string): string => s.replace(/[(（].*?[)）]/g, "").trim() || s;
  // "Title - Artist", or just the title when the row carried no real credit.
  const keyword = [stripParen(cleanTitle(q.title)), stripParen(primaryArtist(q.artist || ""))]
    .filter(Boolean)
    .join(" - ");
  const seconds = Math.round(q.duration);

  const download = async (id: string, accessKey: string): Promise<string | null> => {
    const params = new URLSearchParams({
      fmt: "lrc",
      charset: "utf8",
      client: "pc",
      ver: "1",
      id,
      accesskey: accessKey,
    });
    const body = await getText(`https://lyrics.kugou.com/download?${params.toString()}`);
    if (!body) return null;
    try {
      const json = JSON.parse(body);
      if (typeof json?.content !== "string") return null;
      return Buffer.from(json.content, "base64").toString("utf-8");
    } catch {
      return null;
    }
  };

  const searchLyrics = async (opts: { hash?: string; keyword?: string; seconds?: number }) => {
    const params = new URLSearchParams({ ver: "1", man: "yes", client: "pc" });
    if (opts.hash) params.set("hash", opts.hash);
    else {
      if (!opts.keyword) return [];
      params.set("keyword", opts.keyword);
      if (opts.seconds && opts.seconds > 0) params.set("duration", String(opts.seconds * 1000));
    }
    const body = await getText(`https://lyrics.kugou.com/search?${params.toString()}`);
    if (!body) return [];
    try {
      const json = JSON.parse(body);
      const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
      return (candidates as any[])
        .map((c: any) => ({
          id: String(c?.id ?? ""),
          accesskey: String(c?.accesskey ?? ""),
          duration: Number(c?.duration) || 0,
        }))
        .filter((c) => c.id && c.accesskey);
    } catch {
      return [];
    }
  };

  // Path 1: hash chain, restricted to cuts within tolerance.
  if (seconds > 0) {
    const songBody = await getText(
      `https://mobileservice.kugou.com/api/v3/search/song?${new URLSearchParams({
        version: "9108",
        plat: "0",
        pagesize: "8",
        showtype: "0",
        keyword,
      }).toString()}`
    );
    if (songBody) {
      try {
        const json = JSON.parse(songBody);
        const info: { hash?: string; duration?: number }[] = json?.data?.info ?? [];
        const hashes = info
          .filter((i) => i.hash && Math.abs((i.duration ?? -1) - seconds) <= KUGOU_TOLERANCE)
          .sort((a, b) => Math.abs((a.duration ?? 0) - seconds) - Math.abs((b.duration ?? 0) - seconds))
          .map((i) => i.hash as string);
        for (const hash of hashes) {
          const candidates = await searchLyrics({ hash });
          if (candidates.length) {
            const lrc = await download(candidates[0].id, candidates[0].accesskey);
            if (lrc) {
              const lines = parseLrc(kugouStripCredits(lrc));
              if (lines.length) return toResult("KuGou", lines);
            }
          }
        }
      } catch {
        /* fall through to the keyword path */
      }
    }
  }

  // Path 2: keyword search fallback, scored by runtime proximity so the
  // studio cut doesn't outrank the sped-up edit that shares its name. An
  // upload that names an edition only accepts cuts within tolerance — a
  // different tempo never syncs, no matter the offset.
  const candidates = await searchLyrics({ keyword, seconds });
  if (candidates.length) {
    let pool = candidates;
    if (seconds > 0) {
      const near = pool.filter((c) => withinTolerance(c.duration, seconds));
      if (editionOf(q.title || "")) {
        if (!near.length) return null; // only the wrong edition answered
        pool = near;
      } else if (near.length) {
        pool = near;
      }
    }
    pool = [...pool].sort(
      (a, b) =>
        Math.abs((a.duration || 1e9) - seconds) - Math.abs((b.duration || 1e9) - seconds)
    );
    for (const candidate of pool.slice(0, 3)) {
      const lrc = await download(candidate.id, candidate.accesskey);
      if (lrc) {
        const lines = parseLrc(kugouStripCredits(lrc));
        if (lines.length) return toResult("KuGou", lines);
      }
    }
  }
  return null;
}

/* -------------------------------- LRCLIB -------------------------------- */

async function lrclibGet(path: string): Promise<any | null> {
  const body = await getText(`https://lrclib.net/api${path}`, 7000);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function lyricsFromLrclibRecord(rec: any): ProviderResult | null {
  const synced = typeof rec?.syncedLyrics === "string" && rec.syncedLyrics.trim() ? parseLrc(rec.syncedLyrics) : null;
  if (synced && synced.length >= 3) return toResult("LRCLIB", synced);
  const plain = typeof rec?.plainLyrics === "string" && rec.plainLyrics.trim() ? rec.plainLyrics : null;
  if (plain) return { source: "LRCLIB", wordSynced: false, lines: [], plainText: plain };
  if (synced && synced.length) return toResult("LRCLIB", synced);
  return null;
}

async function fetchLrclib(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = primaryArtist(q.artist || "");
  const stripped = queryTitle(q.title || "");
  if (!stripped) return null;
  const enc = encodeURIComponent;
  const edition = editionOf(q.title || "");
  // The rendition the upload names is queried first: "(Sped Up)" is a real
  // catalogue entry often enough, and the stripped title can only ever
  // answer with the normal cut.
  const full = cleanTitle(q.title || "").trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  for (const title of titles) {
    if (artist && q.duration > 0) {
      const album = q.album ? `&album_name=${enc(cleanTitle(q.album))}` : "";
      const rec = await lrclibGet(
        `/get?artist_name=${enc(artist)}&track_name=${enc(title)}${album}&duration=${Math.round(q.duration)}`
      );
      const exact = lyricsFromLrclibRecord(rec);
      if (exact) return exact;
    }
    if (artist) {
      const results = await lrclibGet(`/search?track_name=${enc(title)}&artist_name=${enc(artist)}`);
      const hit = pickLrclibSearchHit(results, q, edition);
      if (hit) return hit;
    }
  }
  const qResults = await lrclibGet(`/search?q=${enc(`${artist} ${stripped}`.trim())}`);
  return pickLrclibSearchHit(qResults, q, edition);
}

/**
 * Of the search records carrying synced lyrics, take the one whose own
 * runtime sits closest to the playing track — BitChord mobile's rule, and
 * the difference between the studio cut and the sped-up edit that shares
 * its name. When the upload itself names an edition, "closest" tightens to
 * "within tolerance": the studio cut is rejected outright, because no
 * offset can repair a different tempo.
 */
function pickLrclibSearchHit(results: any, q: LyricQuery, edition: string | null): ProviderResult | null {
  if (!Array.isArray(results)) return null;
  const synced = results.filter(
    (rec: any) => typeof rec?.syncedLyrics === "string" && rec.syncedLyrics.trim()
  );
  if (!synced.length) return null;
  const seconds = Math.round(q.duration);
  if (seconds <= 0) return lyricsFromLrclibRecord(synced[0]);
  const near = synced.filter((rec: any) => withinTolerance(rec?.duration, seconds));
  if (edition && !near.length) return null; // only the wrong edition answered
  const pool = near.length ? near : synced;
  const best = pool.reduce((a: any, b: any) =>
    Math.abs((b?.duration ?? 1e9) - seconds) < Math.abs((a?.duration ?? 1e9) - seconds) ? b : a
  );
  return lyricsFromLrclibRecord(best);
}

/* ------------------------------ repository ------------------------------ */

export interface FetchedLyrics {
  source: string;
  wordSynced: boolean;
  synced: SyncedLyricLine[] | null;
  plain: string | null;
}

/**
 * Collect the provider sweep's answers as they land, but stop waiting at the
 * deadline: healthy sources answer in a few hundred milliseconds, while the
 * slow chains (a cold Apple token scrape, KuGou hash walks) can run for tens
 * of seconds — and an all-settled wait made every track's lyrics late by the
 * slowest provider. At the deadline the pick runs on whatever has landed,
 * while the stragglers keep running in the background where they still warm
 * their session caches (Apple token, last-good LyricsPlus mirror) for the
 * next track. If NOTHING has landed yet, the old all-settled wait applies —
 * a dead network must resolve as an honest miss, not a deadline-truncated
 * one that gets cached for ten minutes.
 */
const SWEEP_DEADLINE_MS = 1500;

async function settledWithin(
  jobs: Promise<ProviderResult | null>[]
): Promise<{ results: (ProviderResult | null)[]; arrived: boolean[] }> {
  const results: (ProviderResult | null)[] = new Array(jobs.length).fill(null);
  const arrived: boolean[] = new Array(jobs.length).fill(false);
  return new Promise((resolve) => {
    let pending = jobs.length;
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        resolve({ results, arrived });
      }
    };
    const timer = setTimeout(() => {
      if (arrived.some(Boolean)) finish();
    }, SWEEP_DEADLINE_MS);
    // Each job already swallows its own rejections (.catch → null).
    jobs.forEach((job, i) => {
      void job.then((v) => {
        results[i] = v;
        arrived[i] = true;
        if (--pending === 0) {
          clearTimeout(timer);
          finish();
        }
      });
    });
  });
}

/**
 * Default priority order: word-synced sources lead (LyricsPlus, PaxSenix,
 * BetterLyrics, SimpMusic), then the line-synced workhorses (KuGou, LRCLIB).
 * Every provider is asked at once; answers are taken in priority order, and
 * a word-synced answer beats a line-synced one from a source ahead of it.
 * The sweep is deadline-bounded (settledWithin) so the lyrics land within
 * ~1.5s of the track change even when a provider chain crawls.
 */
export async function fetchLyrics(
  q: LyricQuery,
  opts: { prioritizeWordSync: boolean },
  ytPlainFallback: () => Promise<string | null>
): Promise<FetchedLyrics | null> {
  const jobs: Promise<ProviderResult | null>[] = [
    fetchLyricsPlus(q),
    fetchPaxSenix(q),
    fetchBetterLyrics(q),
    fetchSimpMusic(q),
    fetchKuGou(q),
    fetchLrclib(q),
  ].map((p) => p.catch((): ProviderResult | null => null));
  const { results, arrived } = await settledWithin(jobs);
  // Temporary diagnostics: which providers answered, and what won.
  results.forEach((r, i) => {
    const name = ["LyricsPlus", "PaxSenix", "BetterLyrics", "SimpMusic", "KuGou", "LRCLIB"][i];
    if (!arrived[i]) {
      console.log(`[bytune][lyrics] ${name}: still running at the deadline`);
    } else if (r) {
      const last = r.lines.length ? r.lines[r.lines.length - 1].time : null;
      console.log(`[bytune][lyrics] ${name}: ${r.lines.length} lines last=${last?.toFixed(1)} plain=${!!r.plainText} word=${r.wordSynced}`);
    } else {
      console.log(`[bytune][lyrics] ${name}: rejected/failed`);
    }
  });

  // A lyrics answer must COVER the track: crowd mirrors sometimes answer with
  // the first section only, and a complete line-synced set from a lower-priority
  // source beats a third of a word-synced one. "Complete" means the last line
  // lands past 60% of the runtime (when the runtime is known). And an upload
  // that names an edition must never take a cut that keeps singing long after
  // it ends — that is the studio cut of a sped-up upload, and every second of
  // it would drift worse than the last.
  const edition = editionOf(q.title || "");
  const covers = (r: ProviderResult): boolean => {
    if (!r.lines.length || q.duration <= 0) return true;
    const last = r.lines[r.lines.length - 1].time;
    if (last < q.duration * 0.6) return false;
    if (edition && last > q.duration + Math.max(20, q.duration * 0.15)) return false;
    return true;
  };
  const byKind = (pred: (r: ProviderResult) => boolean): ProviderResult | null =>
    results.find((r) => r && pred(r)) ?? null;

  const wordComplete = byKind((r) => r.wordSynced && r.lines.length > 0 && covers(r));
  const anyComplete = byKind((r) => ((r.lines.length > 0 && covers(r)) || !!r.plainText));
  const wordPartial = byKind((r) => r.wordSynced && r.lines.length > 0);
  const anyPartial = byKind((r) => r.lines.length > 0);

  const pick =
    (opts.prioritizeWordSync ? wordComplete : null) ??
    anyComplete ??
    wordPartial ??
    anyPartial;
  console.log(`[bytune][lyrics] WINNER: ${pick?.source ?? "none"} lines=${pick?.lines.length ?? 0} plain=${!!pick?.plainText}`);

  if (pick) {
    if (pick.plainText) {
      return { source: pick.source, wordSynced: false, synced: null, plain: pick.plainText };
    }
    return { source: pick.source, wordSynced: pick.wordSynced, synced: pick.lines, plain: null };
  }

  const plain = await ytPlainFallback();
  if (plain) return { source: "YouTube Music", wordSynced: false, synced: null, plain };
  return null;
}
