/**
 * PO token minting (main process).
 *
 * YouTube gates stream URLs behind BotGuard-issued PO tokens for anonymous
 * sessions. This replicates the working recipe used by the bgutil provider
 * (as of 2026-08):
 *   1. fetch the YouTube homepage and extract the self-consistent
 *      (ytcfg, ytAtN challenge) pair it embeds (fall back to /att/get),
 *   2. run the BotGuard interpreter inside a JSDOM environment that presents
 *      itself as https://www.youtube.com/ — snapshots from non-YouTube
 *      origins (e.g. a file:// Electron page) are scored as invalid and
 *      Google answers GenerateIT with an empty integrity token,
 *   3. POST the snapshot to GenerateIT with YouTube's (shortened) request key,
 *   4. mint a WebPO token bound to the session's visitor data.
 * Tokens are IP-bound and cached for a few hours.
 */
import { JSDOM } from "jsdom";
import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { buildURL, parseLooseJSON } from "bgutils-js/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const GOOG_API_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

interface MintedToken {
  poToken: string;
  visitorData: string;
  mintedAt: number;
}

interface ChallengeData {
  program: string;
  globalName: string;
  interpreterHash?: string;
  interpreterJS: string;
  ytcfg?: Record<string, any> | null;
}

let domReady = false;
let domWindow: any = null;
let cached: MintedToken | null = null;
let minting: Promise<MintedToken> | null = null;

/** Present the Node process as a YouTube page, as bgutil does. */
function ensureDom(): void {
  if (domReady) return;
  const dom = new JSDOM("<!DOCTYPE html><html lang=\"en\"><head><title></title></head><body></body></html>", {
    url: "https://www.youtube.com/",
    referrer: "https://www.youtube.com/",
    userAgent: UA,
  } as any);
  const globalAny = globalThis as any;
  globalAny.window = dom.window;
  globalAny.document = dom.window.document;
  globalAny.location = dom.window.location;
  globalAny.origin = dom.window.origin;
  if (!Reflect.has(globalThis, "navigator")) {
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
  }
  // The BotGuard VM expects a browser-like global: give it the DOM window's
  // event APIs and the `self` alias that browsers provide.
  globalAny.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalAny.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  globalAny.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
  if (typeof globalAny.self === "undefined") globalAny.self = dom.window;
  if (typeof globalAny.btoa !== "function") globalAny.btoa = dom.window.btoa.bind(dom.window);
  if (typeof globalAny.atob !== "function") globalAny.atob = dom.window.atob.bind(dom.window);
  domWindow = dom.window;
  domReady = true;
}

function waaHeaders(): Record<string, string> {
  return {
    "content-type": "application/json+protobuf",
    "x-goog-api-key": GOOG_API_KEY,
    "x-user-agent": "grpc-web-javascript/0.1",
    "user-agent": UA,
  };
}

async function fetchChallengeFromHomepage(): Promise<ChallengeData | undefined> {
  try {
    const pageRes = await fetch("https://www.youtube.com", {
      headers: { accept: "*/*", "accept-language": "en-US,en;q=0.7", "user-agent": UA },
    });
    const pageHtml = await pageRes.text();

    let ytcfg: Record<string, any> | null = null;
    const ytcfgMatch = pageHtml.match(/ytcfg\.set\(({.+?})\);/s);
    if (ytcfgMatch) {
      try {
        ytcfg = JSON.parse(ytcfgMatch[1]);
      } catch {
        ytcfg = null;
      }
    }

    const attMatch = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
    if (!attMatch) {
      console.warn("[bytune] homepage challenge: no ytAtN payload");
      return undefined;
    }
    const attData: any = (parseLooseJSON as any)(attMatch[1]);
    const bgChallenge = attData?.R?.bgChallenge;
    if (!bgChallenge?.program || !bgChallenge?.globalName) {
      console.warn("[bytune] homepage challenge: missing program/globalName");
      return undefined;
    }

    const interpreterUrlWrapped =
      bgChallenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    let interpreterJS: string | undefined =
      bgChallenge?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreterJS) {
      if (!interpreterUrlWrapped) {
        console.warn("[bytune] homepage challenge: no interpreter available");
        return undefined;
      }
      const jsRes = await fetch(`https:${interpreterUrlWrapped}`, { headers: { "user-agent": UA } });
      interpreterJS = await jsRes.text();
    }
    return {
      program: bgChallenge.program,
      globalName: bgChallenge.globalName,
      interpreterHash: bgChallenge.interpreterHash,
      interpreterJS,
      ytcfg,
    };
  } catch (err) {
    console.warn("[bytune] homepage challenge fetch failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function fetchChallengeFromAttGet(): Promise<ChallengeData | undefined> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false", {
      method: "POST",
      headers: waaHeaders(),
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20260817.01.00" } },
        engagementType: "ENGAGEMENT_TYPE_UNBOUND",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const attestation: any = await res.json();
    const bgChallenge = attestation?.bgChallenge;
    if (!bgChallenge?.program || !bgChallenge?.globalName) throw new Error("no bgChallenge");

    const interpreterUrlWrapped =
      bgChallenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    let interpreterJS: string | undefined =
      bgChallenge?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreterJS) {
      if (!interpreterUrlWrapped) throw new Error("no interpreter available");
      const jsRes = await fetch(`https:${interpreterUrlWrapped}`, { headers: { "user-agent": UA } });
      interpreterJS = await jsRes.text();
    }
    return {
      program: bgChallenge.program,
      globalName: bgChallenge.globalName,
      interpreterHash: bgChallenge.interpreterHash,
      interpreterJS,
      ytcfg: null,
    };
  } catch (err) {
    console.warn("[bytune] att/get challenge failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function mintWithChallenge(challenge: ChallengeData, visitorData: string): Promise<MintedToken> {
  ensureDom();
  const globalAny = globalThis as any;

  if (challenge.ytcfg) {
    // BotGuard reads yt.config_ (EVENT_ID etc.) for homepage challenges.
    globalAny.yt = { config_: challenge.ytcfg };
    if (globalAny.window) globalAny.window.yt = { config_: challenge.ytcfg };
  }
  if (!(globalAny as any)[challenge.globalName]) {
    new Function(challenge.interpreterJS)();
  }
  if (!globalAny[challenge.globalName]) {
    throw new Error(`Interpreter did not define global '${challenge.globalName}'`);
  }

  const botguard = await BotGuardClient.create({
    globalObject: globalAny,
    globalName: challenge.globalName,
    program: challenge.program,
  });

  const webPoSignalOutput: any[] = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput } as any, 20000);
  console.log(
    `[bytune] BotGuard snapshot: len=${String(botguardResponse ?? "").length} head=${String(botguardResponse ?? "").slice(0, 200)}`
  );
  if (!botguardResponse) throw new Error("BotGuard snapshot returned nothing");

  const itRes = await fetch(buildURL("GenerateIT"), {
    method: "POST",
    headers: waaHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  const itRaw = await itRes.text();
  let parsed: any;
  try {
    parsed = JSON.parse(itRaw);
  } catch {
    throw new Error(`GenerateIT returned non-JSON (HTTP ${itRes.status}): ${itRaw.slice(0, 120)}`);
  }
  let integrityToken: string | undefined;
  let estimatedTtlSecs: number | undefined;
  if (Array.isArray(parsed)) {
    // Slot layout has shifted over time — take the long websafe string
    // wherever it appears (slot 1 historically, slot 4 in some responses).
    integrityToken = parsed.find((v: unknown) => typeof v === "string" && v.length >= 40) as
      | string
      | undefined;
    estimatedTtlSecs = parsed.find((v: unknown) => typeof v === "number") as number | undefined;
  } else if (parsed && typeof parsed === "object") {
    integrityToken = parsed.integrityToken ?? parsed.token;
    estimatedTtlSecs = parsed.estimatedTtlSecs;
    if (!integrityToken && !estimatedTtlSecs) {
      throw new Error(`GenerateIT unexpected object (HTTP ${itRes.status}): ${itRaw.slice(0, 160)}`);
    }
  } else {
    throw new Error(`GenerateIT unexpected response (HTTP ${itRes.status}): ${itRaw.slice(0, 160)}`);
  }
  if (!integrityToken) {
    throw new Error(`GenerateIT returned no integrity token (HTTP ${itRes.status}): ${itRaw.slice(0, 200)}`);
  }
  const integrityTokenData = {
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold: Array.isArray(parsed) ? null : parsed?.mintRefreshThreshold,
    websafeFallbackToken: integrityToken,
  };

  const minter = await WebPoMinter.create(integrityTokenData, webPoSignalOutput);
  const poToken = await minter.mintAsWebsafeString(visitorData);
  if (!poToken) throw new Error("Minting returned no token");

  void botguard.shutdown().catch(() => undefined);
  return { poToken, visitorData, mintedAt: Date.now() };
}

async function mint(visitorData: string): Promise<MintedToken> {
  const challenge = (await fetchChallengeFromHomepage()) ?? (await fetchChallengeFromAttGet());
  if (!challenge) throw new Error("Could not obtain a BotGuard challenge");
  try {
    return await mintWithChallenge(challenge, visitorData);
  } catch (err) {
    if (challenge.ytcfg) {
      // Homepage challenge failed — retry with the /att/get challenge.
      console.warn(
        "[bytune] homepage-challenge mint failed, retrying with att/get:",
        err instanceof Error ? err.message : err
      );
      const fallback = await fetchChallengeFromAttGet();
      if (fallback) return mintWithChallenge(fallback, visitorData);
    }
    throw err;
  }
}

/** Returns a cached PO token for `visitorData`, minting one if needed. */
export async function getPoToken(visitorData: string): Promise<string> {
  if (cached && cached.visitorData === visitorData && Date.now() - cached.mintedAt < TOKEN_TTL_MS) {
    return cached.poToken;
  }
  if (!minting) {
    minting = mint(visitorData)
      .then((result) => {
        cached = result;
        return result;
      })
      .finally(() => {
        minting = null;
      });
  }
  return (await minting).poToken;
}

/** Drop the cached token so the next attempt mints a fresh one. */
export function invalidatePoToken(): void {
  cached = null;
}
