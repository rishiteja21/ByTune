/**
 * The launch intro:
 * - public/intro.js turns it on before anything paints, never in the miniplayer's window, and lights the mark
 *   in a worker (public/intro-light.js) so the app starting up can't stall it;
 * - the light show keeps the brand kit's own clock and tracks, in white light;
 * - the page draws the rest from its own markup (index.html) and stylesheet (src/intro.css): the tile, the
 *   mark as it ends, then the wordmark letter by letter (the B with its holes), every class there;
 * - src/intro.ts ends it once it has played and the app is ready (never held: each has a time limit): the
 *   window's glass goes and the app is drawn under it, then the logo lands on the app's own once that has
 *   reached the screen, or the intro fades out with reduced motion or nowhere to land; then the light stops.
 * Run in jsdom on the page's own markup, with the browser's animation calls stubbed and a mocked clock.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const script = read("public/intro.js");
const worker = read("public/intro-light.js");
const page = read("index.html");
const css = read("src/intro.css");

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/intro.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { endIntro, flight } = module.exports;

const MARK_SPAN = (0.231542 * 1994) / 600;
const flush = () => new Promise((r) => setImmediate(r));

/** The page as the app meets it, with the top bar's logo as the landing spot (unless `target` is false). */
function boot({ search = "", target = true, visible = true, reduce = false } = {}) {
  const dom = new JSDOM(page, { url: `http://localhost/${search}`, runScripts: "outside-only" });
  const w = dom.window;
  w.eval(script);
  const doc = w.document;
  if (target) {
    doc.getElementById("root").innerHTML =
      '<div data-intro-target><img class="to-mark" alt="" /><img class="to-word" alt="ByTune" /></div>';
  }
  // Where things sit (jsdom does no layout): the intro centred, the top bar's logo top left.
  const rects = new Map([
    [".intro-tile", { left: 500, top: 400, width: 96, height: 96 }],
    [".intro-word svg", { left: 633, top: 413, width: 268.5, height: 70 }],
    [".to-mark", { left: 20, top: 14, width: 23.87, height: 28 }],
    [".to-word", { left: 51.87, top: 18.5, width: 72.88, height: 19 }],
  ]);
  w.Element.prototype.getBoundingClientRect = function () {
    for (const [sel, r] of rects) if (this.matches(sel)) return { ...r, right: r.left + r.width, bottom: r.top + r.height };
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  };
  w.Element.prototype.checkVisibility = () => visible;
  // The intro's animations: one that plays out (the test finishes it) and the breathing, which never ends.
  let finishPlayed;
  const playedOut = new Promise((r) => (finishPlayed = r));
  const breathe = { effect: { getTiming: () => ({ iterations: Infinity }) }, finished: new Promise(() => {}), cancelled: false };
  breathe.cancel = () => (breathe.cancelled = true);
  w.Element.prototype.getAnimations = () => [{ effect: { getTiming: () => ({ iterations: 1 }) }, finished: playedOut }, breathe];
  const animations = [];
  w.Element.prototype.animate = function (keyframes, options) {
    const html = doc.documentElement;
    animations.push({ el: this, keyframes, options, targetHidden: doc.querySelector("[data-intro-target]")?.style.visibility === "hidden", warm: html.classList.contains("intro-warm") });
    return { finished: Promise.resolve() };
  };
  Object.assign(globalThis, {
    window: w,
    document: doc,
    getComputedStyle: w.getComputedStyle,
    matchMedia: (q) => ({ matches: reduce && q.includes("reduce"), media: q }),
  });
  // The preload's bridge: the window's glass goes when the intro is done. And public/intro.js's light, stopped then.
  const glass = { calls: [], lightStopped: 0 };
  w.bytune = { introDone: () => glass.calls.push(doc.documentElement.classList.contains("intro-wait") ? "while the app waits" : "at the end") };
  w.bytuneIntroLight = Object.assign(() => {}, { stop: () => glass.lightStopped++ });
  const html = doc.documentElement;
  return {
    html,
    doc,
    glass,
    breathe,
    animations,
    finishPlayed,
    intro: () => doc.getElementById("intro"),
    ready: (detail = {}) => w.dispatchEvent(new w.CustomEvent("bytune-startup-ready", { detail })),
    close: () => w.close(),
  };
}

/** Where a flight() transform (origin: the box's top-left) carries the box's point p. */
function land(transform, box, p) {
  const [, tx, ty, k] = /translate\((\S+)px, (\S+)px\) scale\((\S+)\)/.exec(transform).map(Number);
  return { x: box.left + tx + k * (p.x - box.left), y: box.top + ty + k * (p.y - box.top), k };
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
test.afterEach(() => mock.timers.reset());

test("public/intro.js turns it on before anything paints, never in the miniplayer's window", () => {
  const main = boot();
  const pip = boot({ search: "?window=pip" });
  try {
    assert.deepEqual([...main.html.classList], ["intro", "intro-wait", "intro-glass"], "it shows over the glass, and the app waits under it");
    assert.equal(pip.html.className, "", "no class, so none of the intro's CSS applies there");
  } finally {
    main.close();
    pip.close();
  }
});

test("the page loads it before the app, styled from <head>, still with no inline scripts allowed", () => {
  const intro = page.indexOf('<script src="./intro.js"></script>');
  const sheet = page.indexOf('<link rel="stylesheet" href="/src/intro.css" />');
  const app = page.indexOf('<script type="module" src="/src/main.tsx"></script>');
  assert.ok(intro > 0 && intro < app && sheet > 0 && sheet < page.indexOf("</head>"), "decided and styled before anything paints");
  const csp = /content="(default-src[^"]+)"/.exec(page)[1];
  assert.ok(!/script-src [^;]*unsafe-inline/.test(csp), "scripts still only from files");
  assert.match(page, /<body style="background:#0a0a0a">/, "on the window's own ground");
});

test("its markup: the tile with the light's canvas and the mark, then the wordmark letter by letter in reading order", () => {
  const { doc, close } = boot();
  try {
    assert.ok(doc.querySelector("#intro .intro-lockup > .intro-tile > canvas.intro-light[data-size]"));
    assert.ok(doc.querySelector("#intro .intro-lockup > .intro-tile > svg.intro-mark"));
    const letters = [...doc.querySelectorAll("#intro .intro-lockup > .intro-word svg path.intro-l")];
    assert.equal(letters.length, 6, "B y T u n e");
    const order = letters.map((l) => Number(/--i:\s*(\d+)/.exec(l.getAttribute("style"))[1]));
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
    const starts = letters.map((l) => Number(/^M(\d+)/.exec(l.getAttribute("d"))[1]));
    assert.deepEqual([...starts].sort((a, b) => a - b), starts, "each letter starts right of the one before");
    // A letter drawn with holes (the B's two counters) fills even-odd, as in the app's wordmark; otherwise the holes fill in.
    const holed = letters.filter((l) => l.getAttribute("d").match(/M/g).length > 1);
    assert.ok(holed.length >= 1);
    for (const l of holed) assert.equal(l.getAttribute("fill-rule"), "evenodd", `--i ${l.style.getPropertyValue("--i")} keeps its holes`);
  } finally {
    close();
  }
});

test("the mark draws itself in white light: no colour in the light show or the mark", () => {
  const { doc, close } = boot();
  try {
    assert.deepEqual([...new Set([...worker.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))], ["#ffffff"]);
    assert.ok(!/rgb|hsl/i.test(worker.replace(/^\s*(\*|\/\/).*$/gm, "")), "no other colours");
    assert.equal(doc.querySelector("#intro .intro-mark [fill]").getAttribute("fill").toUpperCase(), "#FFFFFF");
  } finally {
    close();
  }
});

// The brand kit's trace_state at these moments (generate_assets.py, printed from it).
const BRAND = {
  0.06: { p: 0, fill: 0, scale: 0.948557, fade: 1, spark: 2.858314, ring: null, flash: 0 },
  0.3: { p: 0.046667, fill: 0, scale: 0.974687, fade: 1, spark: 1.111174, ring: null, flash: 0 },
  0.6: { p: 0.600624, fill: 0, scale: 0.9925, fade: 1, spark: 1.003966, ring: null, flash: 0 },
  1.1: { p: 1, fill: 0.766955, scale: 0.999965, fade: 1, spark: 1.000015, ring: null, flash: 0.7875 },
  1.25: { p: 1, fill: 0.999943, scale: 1.028636, fade: 1, spark: 1.000003, ring: 0.281827, flash: 0.741577 },
  1.7: { p: 1, fill: 1, scale: 1.003342, fade: 0.006011, spark: 1, ring: 0.988779, flash: 0.047461 },
};

test("the light show keeps the brand kit's own clock and tracks", () => {
  const sandbox = { self: {}, module: { exports: {} }, Float64Array, Math };
  vm.runInNewContext(worker, sandbox);
  const { state, TRACKS } = sandbox.module.exports;
  for (const [t, want] of Object.entries(BRAND)) {
    const got = state(Number(t));
    for (const [key, v] of Object.entries(want)) {
      if (v === null) assert.equal(got[key], null, `${key} at ${t}s`);
      else assert.ok(Math.abs(got[key] - v) < 1e-5, `${key} at ${t}s: ${got[key]} for the brand's ${v}`);
    }
  }
  // Each head's track (Upper, Lower, Left): its length, and where its piece's outline begins.
  assert.deepEqual(Array.from(TRACKS, (tr) => [Math.round(tr.length), Math.round(tr.l0)]), [[3554, 235], [3064, 270], [2711, 244]]);
});

test("public/intro.js lights the mark in a worker on the intro's canvas, at the screen's pixels", () => {
  const dom = new JSDOM(page, { url: "http://localhost/", runScripts: "outside-only" });
  const w = dom.window;
  const made = [];
  w.Worker = class {
    constructor(url) {
      this.url = url;
      this.posted = [];
      made.push(this);
    }
    postMessage(message, transfer) {
      this.posted.push({ message, transfer });
    }
    terminate() {
      this.terminated = true;
    }
  };
  w.HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
    return { offscreen: true, width: this.width };
  };
  w.devicePixelRatio = 2;
  w.requestAnimationFrame = () => 0;
  try {
    w.matchMedia = () => ({ matches: true });
    w.eval(script);
    const html = w.document.documentElement;
    const canvas = w.document.querySelector("#intro .intro-light");
    w.bytuneIntroLight(canvas);
    assert.equal(made.length, 0, "not with reduced motion: the SVG mark shows the finished logo");
    w.matchMedia = () => ({ matches: false });
    w.bytuneIntroLight(canvas);
    assert.equal(made.length, 1);
    assert.equal(made[0].url, "./intro-light.js");
    assert.equal(canvas.width, 480, "240 CSS px at 2x");
    const { message, transfer } = made[0].posted[0];
    assert.ok(message.canvas.offscreen && transfer[0] === message.canvas && message.ratio === 2);
    assert.ok(html.classList.contains("intro-lit"), "the SVG mark stands back");
    made[0].onerror();
    assert.ok(!html.classList.contains("intro-lit"), "if the light fails to start, the SVG mark comes back");
    w.bytuneIntroLight.stop();
    assert.ok(made[0].terminated);
  } finally {
    w.close();
  }
});

test("every class, keyframes and reference the intro uses is there", () => {
  const { doc, close } = boot();
  try {
    const intro = doc.getElementById("intro");
    const classes = new Set([...intro.querySelectorAll("[class]")].flatMap((el) => [...el.classList]));
    for (const c of classes) assert.ok(css.includes(`.${c} `) || css.includes(`.${c}{`) || css.includes(`.${c},`), `.${c} is styled`);
    const keyframes = new Set([...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]));
    for (let [, list] of css.matchAll(/animation:\s*([^;]+);/g)) {
      // Drop the brackets (cubic-bezier(), calc(), var()) so only the list's own commas split it.
      while (/\([^()]*\)/.test(list)) list = list.replace(/\([^()]*\)/g, "");
      for (const part of list.split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name !== "none") assert.ok(keyframes.has(name), `@keyframes ${name} is there`);
      }
    }
    const refs = [...intro.innerHTML.matchAll(/(?:url\(#|href="#)([\w-]+)/g)].map((m) => m[1]);
    for (const id of refs) assert.ok(doc.getElementById(id), `#${id} is defined`);
  } finally {
    close();
  }
});

test("the shell and the mark never move by a transform animation, which Chromium draws pixelated while it runs", () => {
  // Every rule naming them (the shell's ::before pops on a layer of its own, which stays sharp).
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:^|\n)([^{}\n@][^{}]*)\{([^}]*)\}/g)];
  for (const sel of [".intro-tile", ".intro-light", ".intro-mark"]) {
    const lists = rules
      .filter(([, selectors]) => selectors.split(",").map((s) => s.trim()).includes(sel))
      .map(([, , body]) => /animation:\s*([^;]+);/.exec(body)?.[1])
      .filter(Boolean);
    assert.ok(lists.length, `${sel} is animated`);
    for (let list of lists) {
      while (/\([^()]*\)/.test(list)) list = list.replace(/\([^()]*\)/g, "");
      for (const name of list.split(",").map((part) => part.trim().split(/\s+/)[0])) {
        const body = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css)[1];
        assert.ok(!/\b(transform|translate|scale|rotate)\s*:/.test(body), `${sel}: ${name} moves it as a picture`);
      }
    }
  }
});

test("flight() scales a box by k and carries its point onto the target", () => {
  const box = { left: 500, top: 400 };
  const to = land(flight(box, { x: 548, y: 448 }, { x: 32, y: 28 }, 0.4), box, { x: 548, y: 448 });
  assert.ok(Math.abs(to.x - 32) < 1e-9 && Math.abs(to.y - 28) < 1e-9 && to.k === 0.4);
});

test("the miniplayer's window: endIntro takes the intro out at once", () => {
  const p = boot({ search: "?window=pip" });
  try {
    endIntro();
    assert.equal(p.intro(), null);
    assert.equal(p.glass.calls.length, 0, "its window has no glass to hand back");
  } finally {
    p.close();
  }
});

test("it ends only when it has played and the app is ready; then the logo lands on the app's own", async () => {
  const p = boot();
  // Element Timing, holding the probe's report until the test says its frame has reached the screen.
  const observers = [];
  const real = globalThis.PerformanceObserver;
  globalThis.PerformanceObserver = Object.assign(
    class {
      constructor(report) {
        this.report = report;
        observers.push(this);
      }
      observe(options) {
        this.type = options.type;
      }
      disconnect() {
        this.off = true;
      }
    },
    { supportedEntryTypes: ["element"] },
  );
  try {
    endIntro();
    p.ready();
    await flush();
    assert.ok(p.html.classList.contains("intro-wait"), "the app is ready, but the logo is still playing");
    assert.ok(p.html.classList.contains("intro-glass") && p.glass.calls.length === 0, "the glass stays while the light plays");
    p.finishPlayed();
    await flush();
    assert.ok(p.breathe.cancelled, "the breathing stops before the app is drawn under the intro");
    assert.deepEqual(p.glass.calls, ["while the app waits"], "the glass goes once the intro has played, while nothing moves");
    assert.ok(!p.html.classList.contains("intro-glass") && p.html.classList.contains("intro-warm"), "the app is drawn under the intro, on the body's own ground");
    const probe = p.doc.querySelector('#intro .intro-probe[elementtiming="intro-probe"]');
    assert.ok(probe && probe.getAttribute("aria-hidden") === "true", "with a probe in the same frame, which no screen reader hears");
    assert.ok(observers.length === 1 && observers[0].type === "element");
    assert.ok(!p.animations.some((a) => a.keyframes.transform), "no glide until that frame has reached the screen");
    observers[0].report({ getEntries: () => [{ identifier: "intro-probe" }] });
    await flush();
    assert.ok(observers[0].off && !probe.parentNode, "then the probe goes");
    const tile = p.animations.find((a) => a.el.matches(".intro-tile") && a.keyframes.transform);
    const word = p.animations.find((a) => a.el.matches(".intro-word svg"));
    assert.ok(tile && word, "the mark and the wordmark fly");
    assert.ok(tile.targetHidden, "only the flying logo shows until it lands");
    assert.ok(tile.warm, "the app was drawn under the intro before the glide began");
    const mark = land(tile.keyframes.transform[1], { left: 500, top: 400 }, { x: 548, y: 448 });
    assert.ok(Math.abs(mark.x - (20 + 23.87 / 2)) < 1e-6 && Math.abs(mark.y - 28) < 1e-6, "the mark's centre on the top bar's");
    assert.ok(Math.abs(mark.k - 28 / (96 * MARK_SPAN)) < 1e-9, "at the top bar's size");
    const text = land(word.keyframes.transform[1], { left: 633, top: 413 }, { x: 633, y: 448 });
    assert.ok(Math.abs(text.x - 51.87) < 1e-6 && Math.abs(text.y - 28) < 1e-6 && Math.abs(text.k - 19 / 70) < 1e-9, "the word on the top bar's");
    assert.ok(p.animations.some((a) => a.el.matches(".intro-tile") && a.options.pseudoElement === "::before"), "the tile itself fades");
    assert.ok(p.animations.some((a) => a.el.id === "intro" && a.options.pseudoElement === "::before" && a.keyframes.opacity), "the dark ground fades by opacity, on its own layer");
    assert.ok(!p.animations.some((a) => "backgroundColor" in a.keyframes), "nothing repaints a background under the glide");
    assert.equal(p.intro(), null, "then the intro is gone");
    assert.equal(p.html.className, "", "and its classes with it");
    assert.equal(p.doc.querySelector("[data-intro-target]").style.visibility, "", "the app's own logo shows");
    assert.deepEqual(p.glass.calls, ["while the app waits", "at the end"], "the glass was gone before the glide (again at the end, which changes nothing)");
    assert.equal(p.glass.lightStopped, 1, "and the light's worker with it");
  } finally {
    globalThis.PerformanceObserver = real;
    p.close();
  }
});

test("the glide never waits on the screen past its time: 1.5 s, if the probe's frame never shows", async () => {
  const p = boot();
  const real = globalThis.PerformanceObserver;
  globalThis.PerformanceObserver = Object.assign(class { observe() {} disconnect() {} }, { supportedEntryTypes: ["element"] });
  try {
    endIntro();
    p.ready();
    p.finishPlayed();
    await flush();
    assert.ok(p.html.classList.contains("intro-warm") && !p.animations.some((a) => a.keyframes.transform));
    mock.timers.tick(1499);
    await flush();
    assert.ok(!p.animations.some((a) => a.keyframes.transform), "still drawing");
    mock.timers.tick(1);
    await flush();
    assert.ok(p.animations.some((a) => a.el.matches(".intro-tile") && a.keyframes.transform), "it glides anyway");
    assert.equal(p.doc.querySelector(".intro-probe"), null);
  } finally {
    globalThis.PerformanceObserver = real;
    p.close();
  }
});

test("it's never held: the app shows after 3 s, ready or not, and the logo's time is up at 4 s", async () => {
  const p = boot();
  try {
    endIntro();
    mock.timers.tick(2999);
    await flush();
    assert.ok(p.html.classList.contains("intro-wait"));
    // The 3 s timeout fires, then async cleanup (settle + warmUp) needs more ticks.
    mock.timers.tick(6000);
    await flush();
    assert.ok(!p.html.classList.contains("intro-wait"), "no ready signal, no finished animation: the app shows anyway");
    assert.equal(p.intro(), null);
  } finally {
    p.close();
  }
});

test("with ByTune's own Reduce animation the app shows as soon as it's ready, and the intro fades", async () => {
  const p = boot();
  try {
    endIntro();
    p.ready({ reduceMotion: true });
    await flush();
    assert.equal(p.intro(), null, "not waiting for the logo to finish");
    assert.ok(!p.animations.some((a) => a.keyframes.transform), "no flight");
    assert.ok(p.animations.some((a) => a.el.id === "intro" && a.keyframes.opacity), "a fade");
    assert.deepEqual(p.glass.calls, ["at the end"], "the glass goes as it ends");
  } finally {
    p.close();
  }
});

test("with the system's reduced motion, or nowhere to land, the intro fades instead", async () => {
  for (const options of [{ reduce: true }, { target: false }, { visible: false }]) {
    const p = boot(options);
    try {
      endIntro();
      p.ready();
      p.finishPlayed();
      await flush();
      assert.equal(p.intro(), null, JSON.stringify(options));
      assert.ok(!p.animations.some((a) => a.keyframes.transform), `no flight: ${JSON.stringify(options)}`);
    } finally {
      p.close();
    }
  }
});
