/** Shell integration: hydration, window fitting, resets and stable page contents. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act, useEffect } from "react";

const dom = new JSDOM("<div></div>", { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

let containerWidth = 1264;
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => containerWidth });
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { observers.add(this); }
  disconnect() { observers.delete(this); }
};
window.bytune = { readData: async () => null, writeData: async () => {} };

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: `export { ResizablePanels } from "./src/components/ResizablePanels"; export { usePanelLayout } from "./src/stores/panelLayout";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime", "react-dom"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { ResizablePanels, usePanelLayout } = module.exports;
await usePanelLayout.persist.rehydrate();

async function mount({ widths = { library: 400, nowPlaying: 400 }, width = 1904, delayed = false } = {}) {
  containerWidth = width;
  let mounts = 0;
  let writes = 0;
  let finishRead;
  const ready = new Promise((resolve) => { finishRead = resolve; });
  if (!delayed) finishRead();
  window.bytune = {
    readData: async () => { await ready; return { state: { widths }, version: 0 }; },
    writeData: async () => { writes++; },
  };
  const hydration = usePanelLayout.persist.rehydrate();
  if (!delayed) await hydration;
  function Page() {
    useEffect(() => { mounts++; }, []);
    return React.createElement("main", { id: "content-scroll" }, "Playlist contents");
  }
  const target = document.createElement("div");
  document.body.append(target);
  const root = createRoot(target);
  await act(async () => root.render(React.createElement(ResizablePanels, {
    library: React.createElement("aside", { id: "library-panel" }, "Library"),
    nowPlaying: React.createElement("aside", { id: "now-playing-panel" }, "Now Playing"),
  }, React.createElement(Page))));
  const dividers = [...target.querySelectorAll("[role='separator']")];
  return {
    dividers,
    page: () => target.querySelector("main"),
    mounts: () => mounts,
    writes: () => writes,
    values: () => dividers.map((el) => Number(el.getAttribute("aria-valuenow"))),
    key: (index, key) => act(async () => dividers[index].dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }))),
    resizeWindow: (width) => act(async () => { containerWidth = width; for (const o of observers) o.callback(); }),
    hydrate: () => act(async () => { finishRead(); await hydration; }),
    close: async () => {
      await act(async () => root.unmount());
      window.dispatchEvent(new window.Event("pagehide"));
      target.remove();
    },
  };
}

test("saved widths fit a smaller window and recover on expansion without rewriting preferences", async () => {
  const h = await mount();
  try {
    assert.deepEqual(h.values(), [400, 400]);
    for (const divider of h.dividers) assert.ok(document.getElementById(divider.getAttribute("aria-controls")));
    await h.resizeWindow(984);
    assert.deepEqual(h.values(), [244, 244]);
    assert.deepEqual(usePanelLayout.getState().widths, { library: 400, nowPlaying: 400 });
    await h.resizeWindow(1904);
    assert.deepEqual(h.values(), [400, 400]);
    assert.equal(h.writes(), 0, "window resizing doesn't churn storage");
  } finally { await h.close(); }
  assert.equal(observers.size, 0, "unmount disconnects the size observer");
});

for (const [index, panel] of ["library", "nowPlaying"].entries()) {
  test(`resizing ${panel} in a narrow window preserves the other panel's saved width`, async () => {
    const h = await mount();
    try {
      await h.resizeWindow(984);
      assert.deepEqual(h.values(), [244, 244]);
      await h.key(index, "Home");
      const expected = { library: 400, nowPlaying: 400, [panel]: 240 };
      assert.deepEqual(usePanelLayout.getState().widths, expected);
      assert.deepEqual(h.values(), index === 0 ? [240, 244] : [244, 240], "the opposite divider stays put");
      await h.resizeWindow(1904);
      assert.deepEqual(h.values(), [expected.library, expected.nowPlaying]);
      await h.resizeWindow(984);
      assert.deepEqual(h.values(), index === 0 ? [240, 248] : [248, 240], "window changes discard the old resize fit");
    } finally { await h.close(); }
  });
}

test("resizing and resetting keep the playlist mounted and its scroll position intact", async () => {
  const h = await mount();
  try {
    const page = h.page();
    page.scrollTop = 250;
    await h.key(0, "End");
    await h.key(1, "Home");
    assert.deepEqual(h.values(), [480, 240]);
    assert.deepEqual(usePanelLayout.getState().widths, { library: 480, nowPlaying: 240 });
    await h.key(0, "Enter");
    assert.deepEqual(h.values(), [328, 240], "one divider resets only its own panel");
    await act(async () => usePanelLayout.getState().resetWidths());
    assert.deepEqual(h.values(), [328, 328]);
    assert.equal(h.page(), page);
    assert.equal(page.scrollTop, 250);
    assert.equal(h.mounts(), 1);
  } finally { await h.close(); }
});

test("resetting in a narrow window and resizing afterward both respect the content minimum", async () => {
  const h = await mount({ width: 984 });
  try {
    await act(async () => usePanelLayout.getState().resetWidths());
    assert.deepEqual(h.values(), [244, 244]);
    await h.key(0, "Home");
    assert.deepEqual(h.values(), [240, 244]);
    await h.key(1, "End");
    assert.deepEqual(h.values(), [240, 248]);
    assert.equal(h.dividers[1].getAttribute("aria-valuemax"), "248");
    assert.equal(984 - h.values().reduce((sum, n) => sum + n, 0) - 16, 480);
    await act(async () => usePanelLayout.getState().resetWidths());
    assert.deepEqual(h.values(), [244, 244], "reset discards the current resize fit");
  } finally { await h.close(); }
});

test("a single-panel reset in a narrow window restores its preference without forgetting the other panel", async () => {
  const h = await mount({ width: 984 });
  try {
    await h.key(0, "End");
    assert.deepEqual(usePanelLayout.getState().widths, { library: 400, nowPlaying: 400 }, "input at the current limit is a no-op");
    await h.key(0, "Enter");
    assert.deepEqual(usePanelLayout.getState().widths, { library: 328, nowPlaying: 400 });
    assert.ok(h.values().every((width) => width >= 240));
    assert.equal(984 - h.values().reduce((sum, n) => sum + n, 0) - 16, 480);
    await h.resizeWindow(1904);
    assert.deepEqual(h.values(), [328, 400]);
  } finally { await h.close(); }
});

test("a delayed preference read cannot be overwritten by resize input before hydration", async () => {
  const h = await mount({ delayed: true, widths: { library: 420, nowPlaying: 380 } });
  try {
    assert.equal(h.dividers[0].getAttribute("aria-disabled"), "true");
    await h.key(0, "Home");
    assert.equal(h.writes(), 0);
    await h.hydrate();
    assert.deepEqual(h.values(), [420, 380]);
    assert.equal(h.dividers[0].getAttribute("aria-disabled"), null);
    await h.key(0, "ArrowRight");
    assert.deepEqual(h.values(), [428, 380]);
  } finally { await h.close(); }
});
