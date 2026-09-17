import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";

// React DOM detects input-event support when the module is first loaded.
const environment = new JSDOM("<div></div>", { url: "http://localhost" });
globalThis.window = environment.window;
globalThis.document = environment.window.document;
const { createRoot } = await import("react-dom/client");

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/views/OnboardingView.tsx", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false,
  external: ["react", "react/jsx-runtime", "lucide-react"],
  loader: { ".svg": "text" },
  plugins: [{ name: "onboarding-seams", setup(b) {
    b.onResolve({ filter: /components\/TopBar$|lib\/session$/ }, a => ({ path: a.path, namespace: "seam" }));
    b.onLoad({ filter: /.*/, namespace: "seam" }, a => ({
      contents: a.path.endsWith("TopBar")
        ? "exports.CaptionButtons = () => null;"
        : "exports.useSession = { getState: () => ({ refresh: () => globalThis.__refresh() }) };",
      loader: "js",
    }));
  }}],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { Onboarding } = module.exports;

async function mount(initial, api) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = api;
  let refreshes = 0;
  globalThis.__refresh = async () => { refreshes++; };
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(Onboarding, { initial })));
  return {
    button: text => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text),
    refreshes: () => refreshes,
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
}

for (const [initial, label, method] of [
  ["resume", "Continue as guest", "authContinueGuest"],
  ["pickusername", "Skip for now", "authSkipUsername"],
]) {
  test(`${initial}: rejected request shows an error and permits a successful retry`, async () => {
    let calls = 0;
    const events = [];
    const h = await mount(initial, {
      [method]: async () => {
        events.push(`${method}:${++calls}`);
        if (calls === 1) throw new Error("network error");
      },
      syncNow: async () => { events.push("sync"); },
    });
    const refresh = globalThis.__refresh;
    globalThis.__refresh = async () => { events.push("refresh"); await refresh(); };
    try {
      await act(async () => { h.button(label).click(); await new Promise(r => setTimeout(r, 10)); });
      assert.equal(h.button(label).disabled, false, "failure must release the loading state");
      assert.match(document.querySelector("[role=alert]")?.textContent ?? "", /connect|try again/i);
      await act(async () => { h.button(label).click(); });
      assert.equal(calls, 2);
      assert.equal(h.refreshes(), 1);
      assert.deepEqual(events, [
        `${method}:1`, `${method}:2`,
        ...(initial === "pickusername" ? ["sync"] : []), "refresh",
      ]);
    } finally { await h.close(); }
  });
}
