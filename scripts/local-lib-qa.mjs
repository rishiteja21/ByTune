/**
 * Local-library integration QA — drives the real local-library.ts module in
 * electron over a real fixture tree, in two phases (phase 2 boots a fresh
 * electron process over the same userData, i.e. a real app restart):
 *
 *   node scripts/local-lib-qa.mjs
 *
 * Covers the multi-folder acceptance checks: standalone import, parent
 * import with subfolder expansion, second locations, restart persistence,
 * metadata-only rename, index-only removal, re-import & parent/child dedup,
 * recursive scan, moved-folder handling and legacy-store migration.
 */
import { execSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";
const electronBin = isWin
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

if (!existsSync(electronBin)) {
  console.error("[lqa] electron binary not found — run `npm install` first");
  process.exit(1);
}

// Same bundle flags as build:electron — local-library must run exactly as it
// does in the app (music-metadata stays external and loads at runtime).
execSync(
  "npx esbuild electron/local-library.ts --bundle --platform=node --format=cjs --external:electron --external:music-metadata --outfile=.test-build/local-library.cjs",
  { cwd: root, stdio: "inherit" }
);
// The fixture sits next to the bundle so its require("./local-library.cjs")
// resolves, and electron is spawned on that copy.
copyFileSync(path.join(root, "scripts", "local-lib-fixture.cjs"), path.join(root, ".test-build", "local-lib-fixture.cjs"));

const tmp = path.join(root, ".test-build", "lqa-tmp");
rmSync(tmp, { recursive: true, force: true });

const runPhase = (phase) =>
  new Promise((resolve) => {
    const child = spawn(
      electronBin,
      [path.join(root, ".test-build", "local-lib-fixture.cjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          LQA_PHASE: phase,
          LQA_BASE: path.join(tmp, "music"),
          LQA_USERDATA: path.join(tmp, "userdata"),
          ELECTRON_ENABLE_LOGGING: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("exit", (code) => resolve({ code: code ?? -1, out }));
    setTimeout(() => {
      try {
        if (isWin) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    }, 120000).unref();
  });

let failed = false;
for (const phase of ["1", "2"]) {
  const { code, out } = await runPhase(phase);
  console.log(out.trimEnd());
  console.log(`[lqa] phase ${phase} exit=${code}`);
  if (code !== 0) failed = true;
}
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "[lqa] RESULT: FAIL" : "[lqa] RESULT: PASS");
process.exit(failed ? 1 : 0);
