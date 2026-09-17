import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * Integration-style regression tests for the auth/session boundary.
 * The REAL electron/supabase.ts module is bundled and imported in this
 * process; only two seams are replaced:
 *   - "electron" (safeStorage/shell/app) — plain stubs, no Electron runtime.
 *   - "./persist" — in-memory store map.
 * All Supabase traffic is intercepted with a global fetch stub; no network
 * call leaves the process. Auto-refresh timers are unref'd so the runner exits.
 */

// Keep the Supabase client's internal refresh ticker from holding the event loop.
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const t = origSetInterval(...args);
  t.unref?.();
  return t;
};

async function loadSupabase({ profile = { mode: "account", userId: "A", username: "a" }, expired = false, offline = false, browserFails = false } = {}) {
  const sessionUserId = { value: "A" };
  const state = { offline };
  const sessionJson = () => ({
    access_token: "access-token", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600),
    refresh_token: "refresh-token",
    user: { id: sessionUserId.value, email: `${sessionUserId.value}@users.bytune.local`, user_metadata: {} },
  });
  const fetchStub = async (url, init) => {
    if (state.offline) throw new Error("offline");
    const u = String(url);
    if (u.includes("/auth/v1/token")) return new Response(JSON.stringify(sessionJson()), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    if (u.includes("/rest/v1/")) return new Response("[]", { status: init?.method === "POST" ? 201 : 200, headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected network call in test: ${u}`);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  const files = new Map([["profile", JSON.stringify(profile)]]);
  const persistMock = {
    readData: (n) => (files.has(n) ? JSON.parse(files.get(n)) : null),
    writeData: async (n, v) => { files.set(n, JSON.stringify(v)); },
    writeDataSync: (n, v) => { files.set(n, JSON.stringify(v)); },
  };
  const electronStub = {
    app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
    shell: { openExternal: browserFails
      ? async () => { throw new Error("External URLs disabled in test"); }
      : async () => {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (b) => b },
  };
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/supabase.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{
      name: "stub-electron-persist",
      setup(b) {
        b.onResolve({ filter: /^electron$|^\.\/persist$/ }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          contents: a.path === "electron"
            ? "module.exports = globalThis.__electronStub;"
            : "module.exports = globalThis.__persistStub;",
          loader: "js",
        }));
      },
    }],
  });
  globalThis.__electronStub = electronStub;
  globalThis.__persistStub = persistMock;
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bytune-auth-bundle-")), "supabase.cjs");
  fs.writeFileSync(outfile, outputFiles[0].text);
  const api = require(outfile);
  return {
    api, files,
    setSessionUser: (id) => { sessionUserId.value = id; },
    setOffline: (v) => { state.offline = v; },
    setProfile: (p) => { files.set("profile", JSON.stringify(p)); },
    setBrowserFails: (v) => { state.browserFails = v; electronStub.shell.openExternal = v
      ? async () => { throw new Error("External URLs disabled in test"); }
      : async () => {}; },
    cleanup: () => { globalThis.fetch = realFetch; fs.rmSync(path.dirname(outfile), { recursive: true, force: true }); },
  };
}

test("authenticatedUserId requires a live, unexpired session matching the account profile", async () => {
  const ok = await loadSupabase();
  try {
    await ok.api.signIn("a", "test-password");
    assert.equal(ok.api.authenticatedUserId(), "A");
    // A profile tampered after sign-in must not re-point cloud authority.
    ok.setProfile({ mode: "account", userId: "B", username: "a" });
    assert.equal(ok.api.authenticatedUserId(), null, "session user A ≠ profile B must not authorize");
  } finally { ok.cleanup(); }

  const guest = await loadSupabase({ profile: { mode: "guest" } });
  try {
    // A stale sealed session (previous account) must not authorize while the
    // local profile is a guest marker.
    guest.files.set("auth", JSON.stringify({ sealed: "enc:" + Buffer.from(JSON.stringify({
      access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "A" },
    })).toString("base64") }));
    await guest.api.initAuth();
    assert.equal(guest.api.authenticatedUserId(), null, "guest profile with restored session must not authorize cloud writes");
  } finally { guest.cleanup(); }

  const stale = await loadSupabase({ expired: true });
  try {
    await stale.api.signIn("a", "test-password");
    assert.equal(stale.api.authenticatedUserId(), null, "expired session must not authorize");
  } finally { stale.cleanup(); }
});

test("signOut clears the sealed session even when the network call fails; continueAsGuest drops an account session", async () => {
  const h = await loadSupabase();
  try {
    await h.api.signIn("a", "test-password");
    assert.equal(h.api.authenticatedUserId(), "A");
    h.setOffline(true); // server unreachable — local cleanup must still happen
    await h.api.signOut();
    assert.equal(h.api.authenticatedUserId(), null);
    assert.equal(h.files.get("auth"), "null", "sealed session must be wiped on offline sign-out");
    assert.equal(h.files.get("profile"), "null");
  } finally { h.cleanup(); }

  const g = await loadSupabase();
  try {
    await g.api.signIn("a", "test-password");
    await g.api.continueAsGuest();
    assert.equal(g.api.authenticatedUserId(), null, "guest continuation must drop the account session");
    assert.equal(g.api.sessionInfo().mode, "guest");
    assert.equal(g.files.get("auth"), "null");
  } finally { g.cleanup(); }
});

test("OAuth callback only completes for the exact registered redirect with a bounded code", async () => {
  const h = await loadSupabase();
  try {
    const pending = h.api.signInGoogle();
    for (const bad of [
      "bytune://oauth/callbackX?code=good",
      "bytune://oauth/other?code=good",
      "evil://oauth/callback?code=good",
      "bytune://oauth/callback?code=good#code=nope",
      "bytune://attacker@oauth/callback?code=good",
      `bytune://oauth/callback?code=${"x".repeat(600)}`,
      "not a url",
    ]) {
      await h.api.handleOAuthCallback(bad).catch(() => {});
      let resolved = false;
      await Promise.race([pending.then(() => { resolved = true; }), new Promise((r) => setTimeout(r, 25))]);
      assert.equal(resolved, false, `foreign callback must not resolve sign-in: ${bad}`);
    }
    // A repeated callback after the pending flow already resolved must be
    // ignored — never complete a second sign-in or throw out of the handler.
    await h.api.handleOAuthCallback("bytune://oauth/callback?code=good");
    const info = await pending;
    assert.equal(info.mode, "account");
    assert.equal(info.userId, "A");
    await h.api.handleOAuthCallback("bytune://oauth/callback?code=good");
  } finally { h.cleanup(); }
});

test("a failed browser launch rejects the pending Google sign-in instead of hanging", async () => {
  const h = await loadSupabase({ browserFails: true });
  try {
    await assert.rejects(h.api.signInGoogle(), /External URLs disabled/);
    // The failed flow must release the slot so an immediate retry works.
    h.setBrowserFails(false);
    const retry = h.api.signInGoogle();
    await h.api.handleOAuthCallback("bytune://oauth/callback?code=good");
    const info = await retry;
    assert.equal(info.mode, "account");
  } finally { h.cleanup(); }
});
