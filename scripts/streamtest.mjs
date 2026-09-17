/**
 * Standalone stream URL diagnostics (plain Node, no Electron).
 * Mints a PO token (jsdom env), then tests which client/URL/pot combination
 * actually streams: run with `node scripts/streamtest.mjs`.
 */
import { JSDOM } from "jsdom";
import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { buildURL, parseLooseJSON } from "bgutils-js/utils";
import { Innertube } from "youtubei.js";

/* eslint-disable no-console */

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const GOOG_API_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function ensureDom() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "https://www.youtube.com/",
    referrer: "https://www.youtube.com/",
    userAgent: UA,
  });
  const g = globalThis;
  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  g.origin = dom.window.origin;
  if (!Reflect.has(g, "navigator")) Object.defineProperty(g, "navigator", { value: dom.window.navigator });
  g.addEventListener = dom.window.addEventListener.bind(dom.window);
  g.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  g.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
  if (typeof g.self === "undefined") g.self = dom.window;
  if (typeof g.btoa !== "function") g.btoa = dom.window.btoa.bind(dom.window);
  if (typeof g.atob !== "function") g.atob = dom.window.atob.bind(dom.window);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChallenge() {
  const pageHtml = await (await fetch("https://www.youtube.com", { headers: { "user-agent": UA, accept: "*/*" } })).text();
  const ytcfgMatch = pageHtml.match(/ytcfg\.set\(({.+?})\);/s);
  const ytcfg = ytcfgMatch ? JSON.parse(ytcfgMatch[1]) : null;
  const attMatch = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attMatch) throw new Error("no ytAtN in homepage");
  const bg = parseLooseJSON(attMatch[1])?.R?.bgChallenge;
  const interpreterUrlWrapped = bg?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  let interpreterJS = bg?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJS) interpreterJS = await (await fetch(`https:${interpreterUrlWrapped}`, { headers: { "user-agent": UA } })).text();
  return { program: bg.program, globalName: bg.globalName, interpreterJS, ytcfg };
}

async function mintWebPo(contentBinding) {
  ensureDom();
  const challenge = await fetchChallenge();
  if (challenge.ytcfg) globalThis.yt = { config_: challenge.ytcfg };
  if (!globalThis[challenge.globalName]) new Function(challenge.interpreterJS)();
  const botguard = await BotGuardClient.create({ globalObject: globalThis, globalName: challenge.globalName, program: challenge.program });
  const webPoSignalOutput = [];
  const snapshot = await botguard.snapshot({ webPoSignalOutput }, 20000);
  console.log("snapshot len:", snapshot.length);
  const itRes = await fetch(buildURL("GenerateIT"), { method: "POST", headers: { "content-type": "application/json+protobuf", "x-goog-api-key": GOOG_API_KEY, "x-user-agent": "grpc-web-javascript/0.1", "user-agent": UA }, body: JSON.stringify([REQUEST_KEY, snapshot]) });
  const arr = await itRes.json();
  const integrityToken = (Array.isArray(arr) ? arr : []).find((v) => typeof v === "string" && v.length >= 40);
  if (!integrityToken) throw new Error("no integrity token: " + JSON.stringify(arr).slice(0, 100));
  const minter = await WebPoMinter.create({ integrityToken, estimatedTtlSecs: 43200 }, webPoSignalOutput);
  return minter.mintAsWebsafeString(contentBinding);
}

async function probe(url, label) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, Range: "bytes=0-" } });
    let got = 0;
    try {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      got = value?.length ?? 0;
      await reader.cancel();
    } catch {}
    console.log(label.padEnd(44), "→", res.status, `firstChunk=${got}`);
    return res.status === 206 || res.status === 200;
  } catch (e) {
    console.log(label.padEnd(44), "→ ERR", e.message.slice(0, 50));
    return false;
  }
}

const VIDEO_ID = "1-V7b70sCzQ";
ensureDom();
const bootstrap = await Innertube.create({ retrieve_player: false, enable_session_cache: false });
const visitorData = bootstrap?.session?.context?.client?.visitorData;
console.log("visitorData:", visitorData?.slice(0, 14) + "…");

console.log("minting visitor-bound token…");
const visitorPot = await mintWebPo(visitorData);
console.log("visitor POT len:", visitorPot.length);
console.log("minting video-bound token…");
const videoPot = await mintWebPo(VIDEO_ID);
console.log("video POT len:", videoPot.length);

const yt = await Innertube.create({ enable_session_cache: false, visitor_data: visitorData, po_token: visitorPot });

for (const client of ["IOS", "ANDROID_VR", "ANDROID_MUSIC", "MWEB", "VISIONOS", "TV_SIMPLY", "TV_EMBEDDED", "WEB_EMBEDDED", "TV", "ANDROID"]) {
  try {
    const info = await yt.getBasicInfo(VIDEO_ID, { client, po_token: visitorPot });
    const sd = info?.streaming_data;
    const audio = (sd?.adaptive_formats ?? []).filter((f) => f?.has_audio && !f?.has_video);
    const withUrl = audio.filter((f) => typeof f.url === "string" && f.url);
    console.log(`client ${client}: playability=${info?.playability_status?.status} audio=${audio.length} plainUrl=${withUrl.length}`);
    if (!withUrl.length) continue;
    withUrl.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const best = withUrl.find((f) => String(f.mime_type ?? "").includes("mp4")) ?? withUrl[0];
    const base = best.url;
    await probe(base, `${client} as-is (${Math.round((best.bitrate ?? 0) / 1000)}kbps)`);
    await probe(base + `&pot=${visitorPot}`, `${client} + visitor pot`);
    await probe(base + `&pot=${videoPot}`, `${client} + video pot`);
  } catch (err) {
    console.log(`client ${client}: FAIL`, err.message.slice(0, 80));
  }
}
console.log("STREAMTEST DONE");
process.exit(0);
