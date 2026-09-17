import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

async function fixture(rows) {
  const writes = [];
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/sync.ts", import.meta.url))], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["electron"],
    plugins: [{ name: "isolated-cloud-boundary", setup(b) {
      b.onResolve({ filter: /^\.\/(persist|supabase|data-transition)$/ }, a => ({ path: a.path, namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: a.path === "./persist"
        ? 'export const readData = () => null; export const writeData = async (...args) => globalThis.writes.push(args); export const writeDataSync = (...args) => globalThis.writes.push(args);'
        : a.path === "./supabase" ? 'export const sessionInfo = () => ({ mode: "account", userId: "test-owner" }); export const readProfile = () => null; export const authenticatedUserId = () => "test-owner";'
        : 'export const serializeData = (fn) => Promise.resolve().then(fn);', loader: "js" }));
    }}],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, writes, Buffer, console, setTimeout, clearTimeout,
    require: n => n === "electron" ? { app: { getPath: () => { throw new Error("Unexpected filesystem access"); } } } : require(n) });
  module.exports.bindClient(() => ({ from: () => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }));
  return { api: module.exports, writes };
}
const row = (payload, store_name = "library") => ({ store_name, payload, updated_at: "2026-01-01T00:00:00Z" });
for (const method of ["syncNow", "restoreNow"]) {
  for (const [name, payload] of [
    ["array state", { state: [] }],
    ["malformed playlist", { state: { playlists: [{ id: "p", name: "p", createdAt: 1, tracks: null }] } }],
    ["oversized string", { state: { extra: "x".repeat(8 * 1024 * 1024 + 1) } }],
    ["prototype key", JSON.parse('{"state":{"__proto__":{"polluted":true}}}')],
    ["invalid envelope", null],
  ]) test(`${method} rejects ${name} before any persistence writes`, async () => {
    const h = await fixture([row({ state: {} }, "settings"), row(payload)]);
    await assert.rejects(h.api[method](), /Invalid cloud backup data/);
    assert.equal(h.writes.length, 0);
    assert.equal({}.polluted, undefined);
  });
}
test("valid fresh-account cloud payload restores through actual sync module", async () => {
  const payload = { state: { liked: [], playlists: [], folders: [], history: [] }, version: 1 };
  const h = await fixture([row(payload)]);
  assert.deepEqual(Array.from((await h.api.syncNow()).pulled), ["library"]);
  assert.ok(h.writes.some(([name, data]) => name === "library" && data === payload));
});
