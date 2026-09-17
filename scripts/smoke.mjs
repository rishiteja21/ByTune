/**
 * Electron startup smoke test — builds nothing, just boots the packaged-dev
 * app from dist-electron + dist and watches the main process come up:
 *   - PASS: the stream proxy marker prints and the process survives a few
 *     more seconds with no main-process exception.
 *   - FAIL: a main-process error/module-resolution failure, or no marker
 *     within the timeout.
 * BYTUNE_ALLOW_MULTI=1 so a running ByTune instance never blocks the run.
 * The process tree is killed afterwards (taskkill /T on Windows).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";
const electronBin = isWin
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

if (!existsSync(electronBin)) {
  console.error("[smoke] electron binary not found — run `npm install` first");
  process.exit(1);
}

// Run against a throwaway profile — the smoke test must never touch the
// developer's or user's real ByTune data (same isolation as gui-launcher).
const profile = mkdtempSync(path.join(os.tmpdir(), "bytune-smoke-"));
const child = spawn(electronBin, [path.join("scripts", "gui-launcher.cjs")], {
  cwd: root,
  env: {
    ...process.env,
    BYTUNE_ALLOW_MULTI: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    BYTUNE_GUI_PROFILE: profile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let exited = null;
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (out += d.toString()));
child.on("exit", (code) => (exited = code ?? -1));

const MARKER = "[bytune] stream proxy on 127.0.0.1:";
const FAILURE_MARKERS = [
  "Cannot find module",
  "A JavaScript error occurred in the main process",
  "[bytune] uncaught exception",
  "[bytune] unhandled rejection",
];

const tail = (lines) => out.split(/\r?\n/).slice(-lines).join("\n");

const finish = (ok, why) => {
  console.log(`[smoke] ${ok ? "PASS" : "FAIL"} — ${why}`);
  console.log("[smoke] last output:");
  console.log(tail(30));
  try {
    if (isWin) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* best effort */
  }
  setTimeout(() => process.exit(ok ? 0 : 1), isWin ? 1500 : 300);
};

const bootTimeout = setTimeout(() => finish(false, `startup marker not seen within 30s (exit=${exited})`), 30_000);
let steadyTimer = null;

const poll = setInterval(() => {
  if (exited !== null && exited !== 0) {
    clearInterval(poll);
    clearTimeout(bootTimeout);
    finish(false, `app exited early with code ${exited}`);
    return;
  }
  const failure = FAILURE_MARKERS.find((m) => out.includes(m));
  if (failure) {
    clearInterval(poll);
    clearTimeout(bootTimeout);
    finish(false, `main-process failure marker: "${failure}"`);
    return;
  }
  if (!out.includes(MARKER)) return;
  // Marker seen — give the renderer a few seconds of steady state to surface
  // late throws (preload failures, renderer crashes land in the console log).
  if (steadyTimer === null) {
    console.log("[smoke] main process booted; stream proxy is up — settling…");
    steadyTimer = setTimeout(() => {
      clearInterval(poll);
      clearTimeout(bootTimeout);
      finish(true, "boot markers seen, no main-process errors, survived steady state");
    }, 5000);
  }
}, 250);
