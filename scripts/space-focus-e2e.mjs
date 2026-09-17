/* E2E: after adjusting the volume / seek sliders with the mouse, Space must
 * toggle play/pause immediately — no extra click. Drives the REAL built app
 * (dist-electron + dist) over CDP with genuine input events.
 *
 *   node scripts/space-focus-e2e.mjs
 *
 * Uses a scratch profile; a seeded guest session + one queued track make the
 * player bar render with the play button ("Play"/"Pause" aria-label) as the
 * observable.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";
const electronBin = isWin
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");
if (!existsSync(electronBin)) {
  console.error("[e2e] electron binary not found");
  process.exit(1);
}

const DEBUG_PORT = 9333;

/* ---- scratch profile: guest session, no onboarding, one queued track ---- */
const profile = mkdtempSync(path.join(os.tmpdir(), "bytune-space-e2e-"));
mkdirSync(path.join(profile, "userdata", "data"), { recursive: true });
// Install marker present ⇒ freshInstall=false ⇒ no "resume" onboarding gate.
writeFileSync(path.join(profile, ".bytune-install"), new Date().toISOString());
writeFileSync(
  path.join(profile, "userdata", "data", "profile.json"),
  JSON.stringify({ deviceId: "dev_e2e", createdAt: Date.now(), mode: "guest" })
);
// Player store seed (zustand persist): a queued track, paused, volume 0.8.
writeFileSync(
  path.join(profile, "userdata", "data", "player.json"),
  JSON.stringify({
    state: {
      queue: [{ id: "dQw4w9WgXcQ", title: "E2E Track", artist: "E2E Artist", duration: 200, thumb: "" }],
      index: 0,
      position: 0,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: "off",
    },
    version: 0,
  })
);

const child = spawn(electronBin, ["scripts/gui-launcher.cjs", `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: root,
  env: { ...process.env, BYTUNE_GUI_PROFILE: profile, BYTUNE_ALLOW_MULTI: "1" },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* app not up yet */
    }
    await sleep(300);
  }
  throw new Error("no CDP page target — app did not start");
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async mouse(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(60);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(60);
  }
  async space() {
    const base = { key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await sleep(40);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(120);
  }
  async arrow(code, vk) {
    const base = { key: code, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await sleep(40);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(80);
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
};

try {
  const wsUrl = await findPageTarget();
  const cdp = new Cdp(wsUrl);
  await cdp.ready();

  // Wait for the shell: sliders + the play/pause button must be on screen.
  const readyExpr = `(() => {
    const vol = document.querySelector('input[aria-label="Volume"]');
    const seek = document.querySelector('input[aria-label="Seek"]');
    const btn = document.querySelector('button[aria-label="Play"], button[aria-label="Pause"]');
    return !!(vol && seek && btn);
  })()`;
  const deadline = Date.now() + 30000;
  while (!(await cdp.eval(readyExpr))) {
    if (Date.now() > deadline) throw new Error("player bar never became ready");
    await sleep(400);
  }
  await sleep(800); // let first paint/hydration settle

  // Race-free witness for "the shortcut handler processed this Space": the
  // handler is the only thing that preventDefaults Space on a non-typing
  // target. Read after propagation (setTimeout) — the seeded track's async
  // load/failure path can flip the aria-label back mid-read, making the
  // label alone a flaky witness.
  await cdp.eval(
    `window.__spacePrevented = null;
     window.addEventListener("keydown", (e) => {
       if (e.code === "Space") setTimeout(() => { window.__spacePrevented = e.defaultPrevented; }, 0);
     }, true);`
  );

  const playLabel = () => cdp.eval(`document.querySelector('button[aria-label="Play"], button[aria-label="Pause"]')?.getAttribute("aria-label")`);
  const focusInfo = (sel) =>
    cdp.eval(`(() => {
      const a = document.activeElement;
      return a.tagName + ":" + (a.getAttribute?.("aria-label") ?? "none");
    })()`);
  const spaceHandled = () => cdp.eval(`window.__spacePrevented`);

  const centerOf = async (sel) =>
    cdp.eval(`(() => {
      const r = document.querySelector('${sel}').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);

  /* ---- flow 1: adjust VOLUME with the mouse → Space toggles ---- */
  {
    const p = await centerOf('input[aria-label="Volume"]');
    const before = await playLabel();
    await cdp.mouse(p.x, p.y);
    const focus = await focusInfo();
    await cdp.space();
    const after = await playLabel();
    check(
      "volume: focus released after adjustment",
      focus.startsWith("BODY"),
      `activeElement=${focus}`
    );
    check("volume: Space toggled play/pause", before !== after || (await spaceHandled()) === true, `label ${before} → ${after}, handled=${await spaceHandled()}`);
    // leave paused for the next flow
    if (before !== after) await cdp.space();
  }

  /* ---- flow 2: adjust the SEEK bar with the mouse → Space toggles ---- */
  {
    const p = await centerOf('input[aria-label="Seek"]');
    const before = await playLabel();
    await cdp.mouse(p.x, p.y);
    const focus = await focusInfo();
    await cdp.space();
    const after = await playLabel();
    check("seek: focus released after adjustment", focus.startsWith("BODY"), `activeElement=${focus}`);
    check("seek: Space toggled play/pause", before !== after || (await spaceHandled()) === true, `label ${before} → ${after}, handled=${await spaceHandled()}`);
    if (before !== after) await cdp.space();
  }

  /* ---- flow 3: window refocus semantics — nothing may hold focus after a
     slider adjustment, so OS focus restoration (Alt+Tab back) lands on the
     shell and Space reaches the shortcut. Simulated here by a focus cycle:
     the renderer keeps whatever element was focused; assert it is the body.
     The shortcut handler is the only thing that preventDefaults Space on a
     non-typing target, so `defaultPrevented` is a race-free observable (the
     seeded track's async load/failure path can flip the label back mid-read,
     so the aria-label alone is a flaky witness here). ---- */
  {
    const p = await centerOf('input[aria-label="Volume"]');
    await cdp.mouse(p.x, p.y);
    await cdp.eval(`window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus"));`);
    const focus = await focusInfo();
    await cdp.space();
    const handled = await spaceHandled();
    check(
      "alt-tab back: Space reaches the shortcut without a click",
      handled === true && focus.startsWith("BODY"),
      `activeElement=${focus}, spacePrevented=${handled}`
    );
  }

  /* ---- regression: keyboard slider interaction is untouched ---- */
  {
    const v0 = await cdp.eval(`Number(document.querySelector('input[aria-label="Volume"]').value)`);
    await cdp.eval(`document.querySelector('input[aria-label="Volume"]').focus()`);
    await cdp.arrow("ArrowRight", 39);
    const v1 = await cdp.eval(`Number(document.querySelector('input[aria-label="Volume"]').value)`);
    const focus = await focusInfo();
    check(
      "keyboard: arrows still adjust the focused slider, focus kept",
      v1 > v0 && focus.startsWith("INPUT"),
      `volume ${v0} → ${v1}, activeElement=${focus}`
    );
    await cdp.eval(`document.activeElement.blur()`);
  }
} catch (err) {
  console.log(`FAIL — ${err.message}`);
  results.push(false);
} finally {
  if (isWin) spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill();
}

await sleep(500);
process.exit(results.every(Boolean) ? 0 : 1);
