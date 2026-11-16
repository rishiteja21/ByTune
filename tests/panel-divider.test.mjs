/** Real pointer/keyboard handlers in jsdom; only native pointer capture is simulated. */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";

const environment = new JSDOM("<div></div>", { url: "http://localhost" });
globalThis.window = environment.window;
globalThis.document = environment.window.document;
const { createRoot } = await import("react-dom/client");
const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/components/PanelDivider.tsx", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { PanelDivider } = module.exports;

async function mount(side = "left") {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const captures = new Set();
  dom.window.HTMLElement.prototype.setPointerCapture = (id) => captures.add(id);
  dom.window.HTMLElement.prototype.hasPointerCapture = (id) => captures.has(id);
  dom.window.HTMLElement.prototype.releasePointerCapture = (id) => captures.delete(id);
  let updates = 0;
  let changeProps;
  function Harness() {
    const [value, setValue] = useState(328);
    const [options, setOptions] = useState({ max: 480, disabled: false });
    changeProps = setOptions;
    return React.createElement(PanelDivider, {
      side, value, min: 240, ...options, label: "Library panel", controls: "library-panel",
      onResize: (next) => { updates++; setValue(next); }, onReset: () => setValue(328),
    });
  }
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(Harness)));
  const divider = document.querySelector("[role='separator']");
  const pointer = (type, x, options = {}) => act(async () => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, buttons: 1, ...options });
    Object.defineProperties(event, {
      pointerId: { value: options.pointerId ?? 1 }, isPrimary: { value: options.isPrimary ?? true },
    });
    divider.dispatchEvent(event);
  });
  return {
    divider, captures, pointer,
    value: () => Number(divider.getAttribute("aria-valuenow")),
    updates: () => updates,
    props: (options) => act(async () => changeProps((prev) => ({ ...prev, ...options }))),
    key: (key, options = {}) => act(async () => divider.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }))),
    unmount: () => act(async () => root.unmount()),
    close: () => dom.window.close(),
  };
}

test("each divider follows the pointer in the correct direction and stops at its limits", async () => {
  for (const side of ["left", "right"]) {
    const h = await mount(side);
    try {
      const sign = side === "left" ? 1 : -1;
      await h.pointer("pointerdown", 500);
      assert.equal(document.activeElement, h.divider);
      assert.ok(h.captures.has(1));
      assert.ok(document.documentElement.classList.contains("panel-resizing"));
      await h.pointer("pointermove", 500 + 40 * sign);
      assert.equal(h.value(), 368);
      await h.pointer("pointermove", 500 + 1000 * sign);
      assert.equal(h.value(), 480);
      await h.pointer("pointermove", 500 - 1000 * sign);
      assert.equal(h.value(), 240);
      await h.pointer("pointerup", 500);
      const updates = h.updates();
      await h.pointer("pointermove", 500);
      assert.equal(h.updates(), updates, "letting go stops resizing");
      assert.equal(h.captures.size, 0);
      assert.equal(document.documentElement.classList.contains("panel-resizing"), false);
    } finally { await h.unmount(); h.close(); }
  }
});

test("only the primary left-button pointer can start and control a drag", async () => {
  const h = await mount();
  try {
    for (const options of [{ button: 2 }, { isPrimary: false }]) {
      await h.pointer("pointerdown", 0, options);
      await h.pointer("pointermove", 100);
      assert.equal(h.value(), 328);
    }
    await h.pointer("pointerdown", 0);
    await h.pointer("pointermove", 100, { pointerId: 2 });
    await h.pointer("pointerup", 100, { pointerId: 2 });
    assert.equal(h.value(), 328);
    await h.pointer("pointermove", 30);
    assert.equal(h.value(), 358, "another pointer cannot end the captured gesture");
  } finally { await h.unmount(); h.close(); }
});

test("keyboard resizing is accessible, bounded, and does not reach playback shortcuts", async () => {
  for (const side of ["left", "right"]) {
    const h = await mount(side);
    let bubbled = 0;
    window.addEventListener("keydown", () => bubbled++);
    try {
      assert.equal(h.divider.tabIndex, 0);
      assert.equal(h.divider.getAttribute("aria-controls"), "library-panel");
      assert.equal(h.divider.getAttribute("aria-orientation"), "vertical");
      await h.key(side === "left" ? "ArrowRight" : "ArrowLeft");
      assert.equal(h.value(), 336);
      await h.key(side === "left" ? "ArrowLeft" : "ArrowRight", { shiftKey: true });
      assert.equal(h.value(), 296);
      await h.key("End");
      assert.equal(h.value(), 480);
      await h.key("Home");
      assert.equal(h.value(), 240);
      await h.key("Enter");
      assert.equal(h.value(), 328);
      assert.equal(bubbled, 0, "resize keys must not also seek or skip tracks");
      await h.key("ArrowLeft", { altKey: true });
      assert.equal(h.value(), 328);
      assert.equal(bubbled, 1, "modified app navigation still works");
      await h.key("End");
      await act(async () => h.divider.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })));
      assert.equal(h.value(), 328);
    } finally { await h.unmount(); h.close(); }
  }
});

test("a changed window limit applies during an ongoing drag, and Escape restores the starting width", async () => {
  const h = await mount();
  try {
    await h.pointer("pointerdown", 0);
    await h.pointer("pointermove", 100);
    await h.props({ max: 360 });
    await h.pointer("pointermove", 120);
    assert.equal(h.value(), 360);
    assert.equal(h.divider.getAttribute("aria-valuemax"), "360");
    await h.key("Escape");
    assert.equal(h.value(), 328);
    assert.equal(h.captures.size, 0);
  } finally { await h.unmount(); h.close(); }
});

test("cancellation, capture loss, window blur, disabling and unmount all clean up a drag", async () => {
  for (const end of ["pointercancel", "lostpointercapture", "blur", "disable", "unmount"]) {
    const h = await mount();
    try {
      await h.pointer("pointerdown", 0);
      if (end === "blur") await act(async () => window.dispatchEvent(new window.Event("blur")));
      else if (end === "disable") await h.props({ disabled: true });
      else if (end === "unmount") await h.unmount();
      else await h.pointer(end, 0);
      assert.equal(h.captures.size, 0, end);
      assert.equal(document.documentElement.classList.contains("panel-resizing"), false, end);
      await h.pointer("pointermove", 100);
      assert.equal(h.updates(), 0, `${end} stops later moves`);
    } finally { if (end !== "unmount") await h.unmount(); h.close(); }
  }
});
