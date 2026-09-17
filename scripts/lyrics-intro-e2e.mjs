/* E2E: in the non-fullscreen lyrics panel, lyrics must sit at the TOP of the
 * area during the instrumental intro (before line 0 activates) instead of
 * pre-centred; once a line activates the anchor/scroll behavior applies; the
 * fullscreen (hero) panel keeps pre-centring in every state.
 *
 *   node scripts/lyrics-intro-e2e.mjs
 *
 * Drives the real built app over CDP with real key events on a scratch
 * profile. The seeded track is a real YouTube id so live synced lyrics
 * resolve; playback never starts, so the store position only moves via the
 * seek shortcut (ArrowRight), which is enough to activate lines.
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

const DEBUG_PORT = 9341;
const profile = mkdtempSync(path.join(os.tmpdir(), "bytune-lyrics-e2e-"));
mkdirSync(path.join(profile, "userdata", "data"), { recursive: true });
writeFileSync(path.join(profile, ".bytune-install"), new Date().toISOString());
writeFileSync(
  path.join(profile, "userdata", "data", "profile.json"),
  JSON.stringify({ deviceId: "dev_e2e", createdAt: Date.now(), mode: "guest" })
);
writeFileSync(
  path.join(profile, "userdata", "data", "player.json"),
  JSON.stringify({
    state: {
      queue: [{ id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", artist: "Rick Astley", duration: 213, thumb: "" }],
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
      /* not up yet */
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
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error
          ? reject(new Error(`${method}: ${msg.error.message} ${JSON.stringify(msg.error.data ?? "")}`))
          : resolve(msg.result);
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
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async key(code, vk) {
    const keyName = code.startsWith("Key") ? code.slice(3).toLowerCase() : code;
    const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await sleep(50);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(120);
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
};

try {
  const cdp = new Cdp(await findPageTarget());
  await cdp.ready();

  // Shell ready: player bar with the seeded track is on screen.
  const deadline = Date.now() + 30000;
  while (!(await cdp.eval(`!!document.querySelector('button[aria-label="Play"], button[aria-label="Pause"]')`))) {
    if (Date.now() > deadline) throw new Error("shell never became ready");
    await sleep(400);
  }

  // Open the centre lyrics panel (KeyL) and wait for live synced lyrics.
  // The synced scroller is the child of the `.-mx-6` halo wrapper (unique to
  // LyricsView — `.scroll-host` also matches the App shell's view scroller).
  await cdp.key("KeyL", 76);
  const linesReady = Date.now() + 25000;
  while (
    !(await cdp.eval(
      `!!document.querySelector('.-mx-6 > .scroll-host') && document.querySelectorAll('.-mx-6 > .scroll-host button').length >= 2`
    ))
  ) {
    if (Date.now() > linesReady) {
      const diag = await cdp.eval(
        `JSON.stringify({
          closeLyrics: !!document.querySelector('[aria-label="Close lyrics"]'),
          scrollers: document.querySelectorAll('.scroll-host').length,
          lyricsWrappers: document.querySelectorAll('.-mx-6').length,
          buttons: document.querySelectorAll('.scroll-host button').length,
          body: document.body.innerText.slice(0, 220),
        })`
      );
      throw new Error(`lyrics lines never rendered — ${diag}`);
    }
    await sleep(500);
  }
  await sleep(600);

  // First line's top offset as a fraction of its container's height, plus
  // which line is active (the active line is the only one at opacity ~1) and
  // the head spacer's inline height — the list position's source of truth.
  const lineRatio = `(container, line) => (line.getBoundingClientRect().top - container.getBoundingClientRect().top) / container.clientHeight`;
  const centreState = () =>
    cdp.eval(`(() => {
      const c = document.querySelector('.-mx-6 > .scroll-host');
      if (!c) return null;
      const btns = [...c.querySelectorAll('button')];
      const l = btns[0];
      if (!l) return null;
      const activeIdx = btns.findIndex((b) => Number(getComputedStyle(b).opacity) > 0.95);
      return {
        activeIdx,
        ratio: (${lineRatio})(c, l),
        activeRatio: activeIdx >= 0 ? (${lineRatio})(c, btns[activeIdx]) : null,
        spacer: c.firstElementChild?.style?.height ?? null,
      };
    })()`);
  const heroMeasure = () =>
    cdp.eval(`(() => {
      const hero = [...document.querySelectorAll('.-mx-6 > .scroll-host')]
        .find((c) => [...c.querySelectorAll('span')].some((s) => s.className.includes("clamp(28px")));
      if (!hero) return null;
      const l = hero.querySelector('button');
      return l ? (${lineRatio})(hero, l) : null;
    })()`);
  const fmt = (v) => (v === null ? "null" : v.toFixed(3));

  const intro = await centreState();
  check(
    "centre panel: intro sits high with no large gap above",
    intro !== null && intro.ratio < 0.2,
    `first-line ratio=${fmt(intro?.ratio ?? null)} (expected ≈0.10)`
  );

  // Seek forward (plain ArrowRight, +5s each) until the first line activates.
  // At that instant the list must NOT move: same ratio, same spacer — no
  // downward jump to the middle.
  let cur = intro;
  const presses = [];
  for (let i = 0; i < 16 && (cur === null || cur.activeIdx < 0); i++) {
    await cdp.key("ArrowRight", 39);
    await sleep(250);
    cur = await centreState();
    presses.push(cur);
  }
  const atFirstActive = cur;
  check(
    "centre panel: first activation causes no jump",
    atFirstActive !== null &&
      atFirstActive.activeIdx >= 0 &&
      Math.abs(atFirstActive.ratio - intro.ratio) < 0.02 &&
      atFirstActive.spacer === intro.spacer,
    `intro ratio=${fmt(intro.ratio)} → active ratio=${fmt(atFirstActive?.ratio ?? null)}, spacer "${intro.spacer}" → "${atFirstActive?.spacer}"`
  );

  // Keep seeking through several lines: normal anchor scrolling engages (the
  // active line glides toward the middle) but the spacer — the list's resting
  // geometry — never changes.
  for (let i = 0; i < 10 && !(cur !== null && cur.activeIdx >= 3 && cur.ratio >= 0.3); i++) {
    await cdp.key("ArrowRight", 39);
    await sleep(250);
    cur = await centreState();
    presses.push(cur);
  }
  const spacerConstant = presses.every((s) => s !== null && s.spacer === intro.spacer);
  check(
    "centre panel: later lines scroll to the anchor, spacer never moves",
    cur !== null && cur.activeRatio !== null && cur.activeRatio >= 0.3 && spacerConstant,
    `active-line ratio=${fmt(cur?.activeRatio ?? null)} after ${presses.length} seeks, spacer constant=${spacerConstant}`
  );

  // Fullscreen (KeyN → the Now Playing overlay, lyrics mode): the hero panel
  // must keep its own anchor spacer in every state — its formula is
  // `max(12px, calc(N% - 36px))` with N measured from the album art (the
  // seeded track has no artwork, so N is whatever the measurement clamps to;
  // 0.3-ish is NOT guaranteed). If the intro-collapse leaked into fullscreen,
  // the spacer would read `calc(14% + 8px)` instead. The first-line ratio is
  // printed for information.
  const heroSpacer = () =>
    cdp.eval(`(() => {
      const hero = [...document.querySelectorAll('.-mx-6 > .scroll-host')]
        .find((c) => [...c.querySelectorAll('span')].some((s) => s.className.includes("clamp(28px")));
      if (!hero) return null;
      const l = hero.querySelector('button');
      const ratio = l ? (${lineRatio})(hero, l) : null;
      return { spacer: hero.firstElementChild?.style?.height ?? null, ratio };
    })()`);

  await cdp.key("KeyN", 78);
  await sleep(900);
  const heroActive = await heroSpacer();
  const heroActiveOk =
    heroActive !== null &&
    heroActive.spacer.includes("max(12px") &&
    heroActive.spacer.includes("- 36px");
  check(
    "fullscreen: active line keeps its anchor spacer (unchanged)",
    heroActiveOk,
    `spacer="${heroActive?.spacer}" ratio=${fmt(heroActive?.ratio ?? null)}`
  );

  for (let i = 0; i < 22; i++) await cdp.key("ArrowLeft", 37);
  await sleep(600);
  const heroIntro = await heroSpacer();
  const heroIntroOk =
    heroIntro !== null &&
    heroIntro.spacer.includes("max(12px") &&
    heroIntro.spacer.includes("- 36px") &&
    !heroIntro.spacer.includes("14%");
  check(
    "fullscreen: intro still pre-centres (unchanged)",
    heroIntroOk,
    `intro spacer="${heroIntro?.spacer}" ratio=${fmt(heroIntro?.ratio ?? null)}`
  );
} catch (err) {
  console.log(`FAIL — ${err.message}`);
  results.push(false);
} finally {
  if (isWin) spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill();
}

await sleep(500);
process.exit(results.every(Boolean) ? 0 : 1);
