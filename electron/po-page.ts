/**
 * BotGuard page script — runs inside a hidden Electron window (real Chromium).
 *
 * The main process fetches the challenge/interpreter/integrity-token data
 * (no CORS there) and hands it over; this page evaluates the BotGuard
 * interpreter in a genuine browser environment, which is what BotGuard's
 * checks expect. Flow: __bgSnapshot() → main calls GenerateIT → __bgMint().
 */
import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";

/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    __bgSnapshot?: (args: {
      program: string;
      globalName: string;
      interpreterJS: string;
      ytcfg?: Record<string, any> | null;
    }) => Promise<string>;
    __bgMint?: (integrityTokenData: any, contentBinding: string) => Promise<string>;
  }
}

let active: { botguard: BotGuardClient; webPoSignalOutput: any[] } | null = null;

window.__bgSnapshot = async ({ program, globalName, interpreterJS, ytcfg }) => {
  if (ytcfg) {
    // BotGuard reads yt.config_ (EVENT_ID etc.) for homepage challenges.
    (window as any).yt = { config_: ytcfg };
  }
  if (!(window as any)[globalName]) {
    new Function(interpreterJS)();
  }
  if (!(window as any)[globalName]) {
    throw new Error(`Interpreter did not define global '${globalName}'`);
  }

  // A stale VM from a previous run can't be reused safely.
  if (active) {
    void active.botguard.shutdown().catch(() => undefined);
    active = null;
  }

  const botguard = await BotGuardClient.create({
    globalObject: window as unknown as Record<string, any>,
    globalName,
    program,
  });

  const webPoSignalOutput: any[] = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput } as any, 20000);
  active = { botguard, webPoSignalOutput };
  return botguardResponse;
};

window.__bgMint = async (integrityTokenData, contentBinding) => {
  if (!active) throw new Error("No active BotGuard session");
  const minter = await WebPoMinter.create(integrityTokenData, active.webPoSignalOutput);
  const poToken = await minter.mintAsWebsafeString(contentBinding);
  if (!poToken || typeof poToken !== "string") throw new Error("Minted PO token is empty");
  return poToken;
};
