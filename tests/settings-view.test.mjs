/**
 * Settings (src/views/SettingsView.tsx) with the real stores, in jsdom, after its redesign into
 * categories: it opens on Account with every category in the rail; a category swaps the page in place
 * (no history step) and the arrow keys walk the rail; a choice, a switch row and a picker each change
 * their setting; the lyrics options under Synced lyrics stay on view but locked while it's off; the
 * search finds every setting by its name across all categories (none was lost in the redesign), shows a
 * whole category when you type its name, says so when nothing matches, and Escape clears it; Reset asks
 * first, and a guest gets the guest's own warning instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";

// React DOM reads the environment when first loaded.
const environment = new JSDOM("<div></div>", { url: "http://localhost" });
globalThis.window = environment.window;
globalThis.document = environment.window.document;
globalThis.bytune = { readData: async () => null, writeData: async () => undefined };
const { createRoot } = await import("react-dom/client");

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: [
      `export { SettingsView } from "./src/views/SettingsView";`,
      `export { useSettings } from "./src/stores/settings";`,
      `export { usePanelLayout } from "./src/stores/panelLayout";`,
      `export { useUI } from "./src/stores/ui";`,
      `export { useSession } from "./src/lib/session";`,
    ].join("\n"),
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  loader: { ".svg": "text" },
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { SettingsView, useSettings, usePanelLayout, useUI, useSession } = module.exports;

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ACCOUNT = { mode: "account", username: "rishi", displayName: "Rishi", loaded: true };

async function mount(session = ACCOUNT, view = { name: "settings" }, panelRead) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = {
    ...globalThis.bytune,
    readData: (name) => name === "panel-layout" && panelRead ? panelRead : globalThis.bytune.readData(name),
    syncStatus: async () => ({ lastSyncAt: Date.UTC(2026, 10, 4, 18, 7), state: "idle", lastError: null }),
    localLibrary: async () => ({ folders: [] }),
    versions: { app: "1.0.1", electron: "", chrome: "" },
  };
  const hydration = usePanelLayout.persist.rehydrate();
  if (!panelRead) await hydration;
  useSession.setState(session);
  useUI.setState({ view, navPast: [{ view: { name: "home" }, scroll: 0 }], navFuture: [], dialog: null, contextMenu: null });
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(SettingsView)));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20)); // the bridge's answers land
  });
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  /** shown: neither it nor anything above it is display: none */
  const shown = (el) => {
    for (let e = el; e; e = e.parentElement) if (e.style?.display === "none") return false;
    return true;
  };
  const press = (el) => act(async () => el.click());
  return {
    hydration,
    $,
    $$,
    shown,
    press,
    title: () => $(".st-pane-title")?.textContent,
    nav: (label) => $$(".st-nav-item").find((b) => b.textContent === label),
    row: (title) => $$("[data-setting-row]").find((r) => r.querySelector(".st-row-title")?.textContent.startsWith(title)),
    search: async (text) => {
      const input = $("#settings-filter");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      await act(async () => {
        setter.call(input, text);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    key: (el, key) => act(async () => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }))),
    /** Moves a slider to `value`, the way a drag reports it. */
    slide: async (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      await act(async () => {
        setter.call(input, String(value));
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("a fresh install starts with the settings everyone gets", () => {
  const s = useSettings.getInitialState();
  const fresh = {
    crossfade: s.crossfadeSeconds, automix: s.smartFade, skipSilence: s.skipSilence,
    autoplay: s.autoplay, dontRepeatSuggestions: s.dontRepeatSuggestions,
    speed: s.playbackSpeed, closeToTray: s.closeToTray,
    streaming: s.streamingQuality, leveling: s.loudnessLevel,
    eq: s.eqEnabled, eqFlat: s.eqGains.every((g) => g === 0), preventClipping: s.eqAutoHeadroom,
    syncedLyrics: s.syncedLyrics, blurLyrics: s.blurUnfocusedLyrics, romanized: s.romanizeLyrics, lyricsTiming: s.lyricsOffset,
    reduceAnimation: s.reduceAnimation, reduceBlur: s.reduceDynamicBlur, liquidGlass: s.liquidGlass,
    fullScreenCover: s.fullBleedArtwork, animatedCover: s.animatedCanvas, legacyMesh: s.legacyMeshGradient,
    hideVolumeBar: s.hideVolumeBar, filterNonMusic: s.filterNonMusicAudio,
  };
  assert.deepEqual(fresh, {
    crossfade: 0, automix: false, skipSilence: false,
    autoplay: true, dontRepeatSuggestions: false,
    speed: 1, closeToTray: true,
    streaming: "high", leveling: "loud",
    eq: false, eqFlat: true, preventClipping: true,
    syncedLyrics: true, blurLyrics: true, romanized: false, lyricsTiming: 0,
    reduceAnimation: false, reduceBlur: false, liquidGlass: true,
    fullScreenCover: true, animatedCover: false, legacyMesh: false,
    hideVolumeBar: false, filterNonMusic: true,
  });
});

test("Settings opens on Account, with every category in the rail and you at the top of it", async () => {
  const h = await mount();
  try {
    assert.deepEqual(
      h.$$(".st-nav-item").map((b) => b.textContent),
      ["Account", "Playback", "Sound", "Lyrics", "Display", "Library", "Your data", "About"]
    );
    assert.equal(h.$(".st-nav-item[aria-current='page']")?.textContent, "Account");
    assert.equal(h.title(), "Account");
    const card = h.$(".st-id");
    assert.match(card.textContent, /Rishi/);
    assert.match(card.textContent, /@rishi/);
    assert.match(card.textContent, /Synced/);
    assert.ok(h.$$(".st-btn").some((b) => b.textContent === "Back up now"));
  } finally {
    await h.close();
  }
});

test("a category swaps the page in place, with no history step, and the arrow keys walk the rail", async () => {
  const h = await mount();
  try {
    const depth = useUI.getState().navPast.length;
    await h.press(h.nav("Sound"));
    assert.equal(useUI.getState().view.param, "sound");
    assert.equal(useUI.getState().navPast.length, depth, "no history step");
    assert.equal(h.title(), "Sound");
    assert.equal(h.$(".st-nav-item[aria-current='page']")?.textContent, "Sound");
    await h.key(h.nav("Sound"), "ArrowDown");
    assert.equal(useUI.getState().view.param, "lyrics");
    await h.key(h.nav("Lyrics"), "ArrowUp");
    assert.equal(useUI.getState().view.param, "sound");
    await h.key(h.nav("Account"), "ArrowUp");
    assert.equal(useUI.getState().view.param, "about", "and round from the top to the bottom");
  } finally {
    await h.close();
  }
});

test("Display resets both panel widths, and searching finds the layout setting", async () => {
  const h = await mount(ACCOUNT, { name: "settings", param: "display" });
  try {
    await act(async () => usePanelLayout.getState().setWidths({ library: 440, nowPlaying: 380 }));
    const row = h.row("Panel widths");
    assert.ok(row);
    await h.press(row.querySelector("button"));
    assert.deepEqual(usePanelLayout.getState().widths, { library: 328, nowPlaying: 328 });
    await h.press(h.nav("Account"));
    await h.search("panel widths");
    assert.ok(h.shown(h.row("Panel widths")));
  } finally {
    environment.window.dispatchEvent(new environment.window.Event("pagehide"));
    await h.close();
  }
});

test("Display waits for saved panel widths before allowing a reset", async () => {
  let finishRead;
  const panelRead = new Promise((resolve) => { finishRead = resolve; });
  const h = await mount(ACCOUNT, { name: "settings", param: "display" }, panelRead);
  try {
    const reset = h.row("Panel widths").querySelector("button");
    assert.equal(usePanelLayout.persist.hasHydrated(), false);
    assert.equal(reset.disabled, true);
    const widths = usePanelLayout.getState().widths;
    const toasts = useUI.getState().toasts;
    await h.press(reset);
    assert.equal(usePanelLayout.getState().widths, widths);
    assert.equal(useUI.getState().toasts, toasts, "a blocked reset reports no success");
    await act(async () => {
      finishRead({ state: { widths: { library: 420, nowPlaying: 380 } }, version: 0 });
      await h.hydration;
    });
    assert.deepEqual(usePanelLayout.getState().widths, { library: 420, nowPlaying: 380 });
    assert.equal(reset.disabled, false);
    await h.press(reset);
    assert.deepEqual(usePanelLayout.getState().widths, { library: 328, nowPlaying: 328 });
  } finally {
    await act(async () => { finishRead(null); await h.hydration; });
    environment.window.dispatchEvent(new environment.window.Event("pagehide"));
    await h.close();
  }
});

test("a choice, a switch row and a picker each change their setting", async () => {
  useSettings.setState({ streamingQuality: "medium", reduceAnimation: false });
  const h = await mount(ACCOUNT, { name: "settings", param: "sound" });
  try {
    const high = h.$$("[role='radiogroup'][aria-label='Streaming quality'] [role='radio']").find((b) => b.textContent === "High");
    await h.press(high);
    assert.equal(useSettings.getState().streamingQuality, "high");
    assert.equal(high.getAttribute("aria-checked"), "true");
    await h.key(high, "ArrowRight");
    assert.equal(useSettings.getState().streamingQuality, "lossless", "arrow keys move along the choice");

    await h.press(h.row("Output device"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10)); // the device list resolves
    });
    assert.ok(useUI.getState().contextMenu, "the picker opens its list");
    await h.press(h.row("Output device"));
    assert.equal(useUI.getState().contextMenu, null, "and the same row closes it");

    await h.press(h.nav("Display"));
    await h.press(h.row("Reduce animation"));
    assert.equal(useSettings.getState().reduceAnimation, true, "the whole row flips its switch");
    await h.press(h.row("Reduce animation").querySelector("[role='switch']"));
    assert.equal(useSettings.getState().reduceAnimation, false, "and so does the switch, once");
  } finally {
    useSettings.setState({ reduceAnimation: false });
    await h.close();
  }
});

test("the options under Synced lyrics stay on view while it's off, but locked", async () => {
  useSettings.setState({ syncedLyrics: false, romanizeLyrics: false });
  const h = await mount(ACCOUNT, { name: "settings", param: "lyrics" });
  try {
    const romanized = h.row("Romanized lyrics");
    assert.ok(romanized, "still on view");
    assert.equal(romanized.querySelector("[role='switch']").disabled, true);
    await h.press(romanized);
    assert.equal(useSettings.getState().romanizeLyrics, false, "a click on the row doesn't change it either");
    assert.equal(h.row("Lyrics timing").querySelector("input[type='range']").disabled, true);
    assert.match(h.$(".st-note").textContent, /while synced lyrics are on/);
    await h.press(h.row("Synced lyrics"));
    assert.equal(useSettings.getState().syncedLyrics, true);
    assert.equal(h.row("Romanized lyrics").querySelector("[role='switch']").disabled, false, "unlocked with it on");
  } finally {
    await h.close();
  }
});

test("the equalizer keeps its shape while a band moves, so a drag never shifts it under the pointer", async () => {
  useSettings.setState({ eqEnabled: true, eqGains: Array(10).fill(0), eqPresets: [] });
  const h = await mount(ACCOUNT, { name: "settings", param: "sound" });
  try {
    const chips = () =>
      h.$$(".st-eq-presets button").map((b) => b.textContent + (b.getAttribute("aria-pressed") === "true" ? " (on)" : "") + (b.disabled ? " (off)" : ""));
    const shape = () => [h.$$(".st-eq *").length, h.row("Equalizer").querySelector(".st-row-note")?.textContent];
    const onFlat = ["Flat (on)", "Bass", "Treble", "Vocal", "Loudness", "Save as preset (off)"];
    assert.deepEqual(chips(), onFlat, "Save as preset is there on a preset too, just off");
    const flat = shape();
    const band = h.$$(".st-eq-band input")[5];

    await h.slide(band, 1);
    assert.equal(useSettings.getState().eqGains[5], 1);
    assert.deepEqual(chips(), ["Flat", "Bass", "Treble", "Vocal", "Loudness", "Save as preset"], "off Flat: the same chips, Save on");
    assert.deepEqual(shape(), flat, "not one element more or less, and the same note");
    assert.equal(h.$$(".st-eq-gain")[5].textContent, "+1");
    await h.slide(band, -1);
    assert.equal(h.$$(".st-eq-gain")[5].textContent, "−1", "a cut reads with a real minus");
    await h.slide(band, 0);
    assert.deepEqual(chips(), onFlat, "back on Flat");
    assert.deepEqual(shape(), flat);
  } finally {
    useSettings.setState({ eqEnabled: false, eqGains: Array(10).fill(0) });
    await h.close();
  }
});

test("each slider rests on stops ruled under its bar; lyrics timing moves a quarter second at a time", async () => {
  useSettings.setState({ syncedLyrics: true, lyricsOffset: 0 });
  const h = await mount(ACCOUNT, { name: "settings", param: "lyrics" });
  try {
    const row = h.row("Lyrics timing");
    const input = row.querySelector("input[type='range']");
    const marks = [...row.querySelectorAll(".st-range-marks i")];
    const lit = () => marks.findIndex((m) => m.classList.contains("is-on"));
    assert.equal(input.step, "0.25");
    assert.equal(marks.length, 25, "3 s earlier to 3 s later, a stop every quarter second");
    assert.equal(marks.findIndex((m) => m.classList.contains("is-origin")), 12, "In sync, in the middle, stands tallest");
    assert.deepEqual(marks.flatMap((m, i) => (m.classList.contains("is-major") ? [i] : [])), [0, 4, 8, 16, 20, 24], "then the whole seconds");
    assert.equal(lit(), 12);
    await h.slide(input, 0.75);
    assert.equal(useSettings.getState().lyricsOffset, 0.75);
    assert.equal(row.querySelector(".st-value:not(.st-reading-size)").textContent, "0.75 s later");
    assert.equal(row.querySelector(".st-reading-size").textContent, "2.75 s earlier", "the reading keeps the width of its widest value");
    assert.equal(lit(), 15, "the stop it rests on lights up");
  } finally {
    useSettings.setState({ lyricsOffset: 0 });
    await h.close();
  }
  useSettings.setState({ crossfadeSeconds: 0, playbackSpeed: 1 });
  const p = await mount(ACCOUNT, { name: "settings", param: "playback" });
  try {
    const marks = (name) => [...p.row(name).querySelectorAll(".st-range-marks i")];
    assert.equal(marks("Crossfade").length, 13, "a stop a second, 0 to 12");
    assert.equal(marks("Playback speed").length, 31, "a stop every 0.05x, 0.5x to 2x");
    assert.equal(marks("Playback speed").findIndex((m) => m.classList.contains("is-origin")), 10, "with normal speed, 1x, marked");
  } finally {
    await p.close();
  }
});

/** Every setting there was before the redesign, by what it's called now. */
const EVERY_SETTING = [
  "Edit name", "Change username", "Back up now", "Restore from the cloud", "Sign out", "Spotify", "Song versions",
  "Crossfade", "Automix", "Skip silence", "Autoplay", "Don't repeat suggestions", "Playback speed",
  "Streaming quality", "Volume leveling", "Output device", "Equalizer", "Prevent clipping",
  "Synced lyrics", "Blur unfocused lyrics", "Romanized lyrics", "Lyrics timing",
  "Reduce animation", "Reduce dynamic blur", "Liquid glass", "Full-screen cover art", "Animated cover art", "Legacy mesh gradient", "Hide volume bar",
  "Local music folders", "Add a folder", "Rescan library", "Filter non-music audio", "Download folder", "Download quality", "Export compatible downloads",
  "Replay", "Export data", "Import data", "Reset app data", "ByTune website",
];

test("the search finds every setting by its name, in whichever category it lives", async () => {
  useSettings.setState({ syncedLyrics: true, eqEnabled: true });
  const h = await mount();
  try {
    for (const name of EVERY_SETTING) {
      await h.search(name);
      const found = h.$$("[data-setting-row]").filter((r) => h.shown(r) && r.textContent.includes(name));
      assert.ok(found.length > 0, `"${name}" is found`);
      assert.ok(!h.shown(h.$("[data-settings-empty]")), `no "nothing matches" for "${name}"`);
    }
  } finally {
    await h.close();
  }
});

test("typing a category's name shows all of it; nothing matching says so; Escape clears", async () => {
  const h = await mount();
  try {
    await h.search("sound");
    const shownRows = h.$$("[data-setting-row]").filter((r) => h.shown(r)).map((r) => r.querySelector(".st-row-title")?.textContent);
    for (const name of ["Streaming quality", "Volume leveling", "Output device", "Equalizer"]) {
      assert.ok(shownRows.includes(name), `${name} shows with its category`);
    }
    assert.ok(!h.$(".st-nav-item[aria-current]"), "while searching, no category is current");

    await h.search("zzzz");
    assert.ok(h.shown(h.$("[data-settings-empty]")));
    assert.match(h.$("[data-settings-empty]").textContent, /No settings match “zzzz”/);

    await h.key(h.$("#settings-filter"), "Escape");
    assert.equal(h.$("#settings-filter").value, "");
    assert.equal(h.title(), "Account", "back on the category you were in");
  } finally {
    await h.close();
  }
});

test("Reset asks first; a guest, who has no backup, gets the guest's own warning instead", async () => {
  const h = await mount(ACCOUNT, { name: "settings", param: "data" });
  try {
    await h.press(h.$$(".st-btn").find((b) => b.textContent === "Reset"));
    assert.equal(useUI.getState().dialog?.title, "Reset local data?");
  } finally {
    useUI.setState({ dialog: null });
    await h.close();
  }
  const g = await mount({ mode: "guest", username: null, displayName: "Guesty", loaded: true }, { name: "settings", param: "data" });
  try {
    await g.press(g.$$(".st-btn").find((b) => b.textContent === "Reset"));
    assert.equal(useUI.getState().dialog, null);
    assert.ok(g.$("[role='dialog']"), "the guest's own warning opens");
  } finally {
    await g.close();
  }
});

test("no button anywhere in Settings trails off in dots; About shows the brand, the version and the licence", async () => {
  useSettings.setState({ eqEnabled: true, syncedLyrics: true });
  const h = await mount();
  try {
    for (const label of h.$$(".st-nav-item").map((b) => b.textContent)) {
      await h.press(h.nav(label));
      for (const b of h.$$(".st-btn, .st-chip")) assert.ok(!/(…|\.\.\.)$/.test(b.textContent.trim()), `${label}: "${b.textContent}"`);
    }
    const about = h.$(".st-about");
    assert.ok(about.querySelector("img[alt='ByTune']"), "the wordmark");
    assert.equal(about.querySelector(".st-about-version").textContent, "Version 1.0.1");
    assert.match(about.querySelector(".st-about-meta").textContent, /Free and open source under GPL-3\.0/);
  } finally {
    await h.close();
  }
});

test("a guest's account card says it's local, and offers an account", async () => {
  const h = await mount({ mode: "guest", username: null, displayName: null, loaded: true });
  try {
    const card = h.$(".st-id");
    assert.match(card.textContent, /Guest/);
    assert.match(card.textContent, /stored only on this device/);
    assert.ok(h.$$(".st-btn").some((b) => b.textContent === "Add name"));
    assert.ok(h.$$(".st-btn").some((b) => b.textContent === "Create account or sign in"));
    assert.ok(!h.$$(".st-btn").some((b) => b.textContent === "Sign out"));
  } finally {
    await h.close();
  }
});
