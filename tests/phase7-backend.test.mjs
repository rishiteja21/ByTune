import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const plain = value => JSON.parse(JSON.stringify(value));
const track = id => ({ id, title: id, artist: "Test", thumb: "", duration: 60 });
const library = id => ({ state: { liked: [track(id)], playlists: [], downloads: {} }, version: 1 });
const envelope = state => ({ state, version: 0 });
const row = (store_name, payload) => ({ store_name, payload, updated_at: "2026-01-01T00:00:00Z" });

// Actual main IPC handlers, auth, transition, persistence, validation and sync.
// Only Electron, the SDK transport, and unrelated main-process services are replaced.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-phase7-"));
  const handlers = new Map(), modules = new Map(), events = [], calls = [], uploads = [];
  let rows = [], user = "A", expired = false, authChanged, failUpload, failWrite, statsNotify = () => {};
  const sdk = {
    auth: {
      onAuthStateChange(fn) { authChanged = fn; },
      async signInWithPassword(_args) {
        if (String(arguments[0]?.password ?? "") === "wrong-password") return { data: { user: null, session: null }, error: { message: "Invalid login credentials" } };
        return authenticate();
      },
      async signUp() { return authenticate(); },
      async signOut() { authChanged?.("SIGNED_OUT", null); return { error: null }; },
    },
    from(table) {
      calls.push(table);
      return {
        select: () => ({ eq: (_field, id) => {
          if (table === "profiles") return { maybeSingle: async () => ({ data: null, error: null }) };
          calls.push({ readUser: id });
          return Promise.resolve({ data: rows, error: null });
        } }),
        insert: async () => ({ error: null }),
        async upsert(value) {
          if (value.store_name === failUpload) return { error: { message: "upload failed" } };
          uploads.push(plain(value));
          return { error: null };
        },
      };
    },
  };
  function authenticate() {
    const session = { access_token: "test", refresh_token: "test", user: { id: user },
      expires_at: expired ? 1 : 4_000_000_000 };
    authChanged?.("SIGNED_IN", session);
    return { data: { session, user: session.user }, error: null };
  }
  const electron = {
    app: { getPath: () => dir, requestSingleInstanceLock: () => false, quit() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle(name, fn) { handlers.set(name, fn); }, on() {} },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const fakeFs = { ...fs, promises: { ...fs.promises, async writeFile(file, ...args) {
    if (failWrite && path.basename(file).startsWith(`${failWrite}.json.`)) throw new Error("disk failed");
    return fs.promises.writeFile(file, ...args);
  } } };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const isMain = file === path.join(root, "electron", "main.ts");
    const source = fs.readFileSync(file, "utf8") + (isMain ? "\nexport { registerIpc };\n" : "");
    const { code } = transformSync(source, { loader: "ts", format: "cjs" });
    vm.runInNewContext(code, {
      module, exports: module.exports, console, Buffer, URL, setTimeout, clearTimeout,
      process: { env: {}, on() {} },
      require(name) {
        if (name === "electron") return electron;
        if (name === "fs") return fakeFs;
        if (name === "@supabase/supabase-js") return { createClient: () => sdk };
        if (isMain && name.startsWith("./") && !["./persist", "./supabase", "./sync", "./data-transition"].includes(name)) {
          if (name === "./downloads") return { addDownloadListener() {}, resetDownloads: async () => {}, defaultDownloadDir: async () => path.join(dir, "downloads"), exportDownloadDir: () => path.join(dir, "exports") };
          if (name === "./local-library") return { resetLocalLibrary: async () => {}, readLocalLibrary: () => ({ folders: [] }) };
          if (name === "./stats") return { resetStats() {}, initStats() {}, flushSync() {}, reloadStore() {}, recordListening() {}, summary: () => ({ totalMs: 0 }), HISTORY_STORE: "listening-history", onStoreWrite(fn) { statsNotify = fn; } };
          if (name === "./pip") return { registerPipIpc() {}, isTrustedSender: () => true };
          return {};
        }
        if (name.startsWith(".")) return load(path.resolve(path.dirname(file), `${name}.ts`));
        return require(name);
      },
    }, { filename: file });
    return module.exports;
  }
  const disk = load(path.join(root, "electron", "persist.ts"));
  const auth = load(path.join(root, "electron", "supabase.ts"));
  const transition = load(path.join(root, "electron", "data-transition.ts"));
  const sync = load(path.join(root, "electron", "sync.ts"));
  transition.initializeOwner();
  sync.bindClient(() => sdk);
  sync.bindRestoredNotifier((stores, seq) => events.push({ stores: [...stores], seq }));
  load(path.join(root, "electron", "main.ts")).registerIpc();
  return {
    dir, disk, auth, sync, transition, events, calls, uploads,
    invoke: (name, ...args) => handlers.get(name)({}, ...args),
    statsNotify: () => statsNotify?.(),
    rows(value) { rows = value; },
    user(value) { user = value; },
    expired(value) { expired = value; },
    failUpload(name) { failUpload = name; },
    failWrite(name) { failWrite = name; },
    async close() { failWrite = undefined; sync.resetSyncState(); await disk.drainWrites(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("guest data migrates into an account CREATED by sign-up", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:continueGuest");
    const doc = await h.invoke("data:scope");
    const guest = library("guest");
    guest.state.playlists = [{ id: "p", name: "Guest playlist", createdAt: 1, tracks: [track("guest")] }];
    await h.invoke("data:write", "library", guest, doc);
    await h.invoke("data:write", "recent-searches", envelope({ searches: ["guest query"] }), doc);
    assert.equal(h.calls.length, 0, "guest writes are local-only");
    h.rows([row("library", library("remote"))]);
    await h.invoke("auth:signUp", "alice", "valid-password-123");
    assert.equal(h.transition.currentOwner(), "A");
    assert.deepEqual(new Set(h.disk.readData("library").state.liked.map(t => t.id)), new Set(["guest", "remote"]));
    assert.equal(h.disk.readData("library").state.playlists[0].id, "p");
    assert.deepEqual(plain(h.disk.readData("recent-searches").state.searches), ["guest query"]);
    const uploaded = h.uploads.find(v => v.store_name === "library");
    assert.deepEqual(new Set(uploaded.payload.state.liked.map(t => t.id)), new Set(["guest", "remote"]));
    assert.equal(uploaded.user_id, "A");
    assert.ok(h.uploads.some(v => v.store_name === "recent-searches"));
  } finally { await h.close(); }
});

test("signing into an EXISTING account restores that account's data, never the guest's", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:continueGuest");
    const doc = await h.invoke("data:scope");
    const guest = library("guest");
    guest.state.playlists = [{ id: "p", name: "Guest playlist", createdAt: 1, tracks: [track("guest")] }];
    await h.invoke("data:write", "library", guest, doc);
    await h.invoke("data:write", "recent-searches", envelope({ searches: ["guest query"] }), doc);
    h.rows([row("library", library("remote"))]);
    await h.invoke("auth:signIn", "alice", "valid-password-123");
    assert.equal(h.transition.currentOwner(), "A");
    // The account's own cloud copy is what shows up — nothing of the guest's.
    assert.deepEqual(new Set(h.disk.readData("library").state.liked.map(t => t.id)), new Set(["remote"]));
    assert.deepEqual(plain(h.disk.readData("library").state.playlists.map(p => p.id)), []);
    assert.equal(h.disk.readData("recent-searches"), null);
    // And nothing of the guest's was ever uploaded under the account.
    assert.ok(h.uploads.filter(v => v.user_id === "A").every(v => !JSON.stringify(v.payload).includes("guest")));
    // Returning to guest still finds the guest's own data.
    await h.invoke("auth:continueGuest");
    assert.equal(h.transition.currentOwner(), "guest");
    assert.deepEqual(new Set(h.disk.readData("library").state.liked.map(t => t.id)), new Set(["guest"]));
    assert.equal(h.disk.readData("library").state.playlists[0].id, "p");
    assert.deepEqual(plain(h.disk.readData("recent-searches").state.searches), ["guest query"]);
  } finally { await h.close(); }
});

test("a failed sign-in leaves guest ownership and data untouched", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:continueGuest");
    const doc = await h.invoke("data:scope");
    await h.invoke("data:write", "library", library("guest"), doc);
    await h.invoke("auth:clearGuestProfile");
    h.rows([row("library", library("remote"))]);
    await assert.rejects(h.invoke("auth:signIn", "alice", "wrong-password"), /Wrong username or password|Sign in failed/);
    assert.equal(h.transition.currentOwner(), "guest");
    assert.deepEqual(new Set(h.disk.readData("library").state.liked.map(t => t.id)), new Set(["guest"]));
    // A retry that succeeds against the same (existing) account restores the
    // account's copy; the guest's session is not mixed in.
    await h.invoke("auth:signIn", "alice", "valid-password-123");
    assert.deepEqual(new Set(plain(h.disk.readData("library").state.liked).map(t => t.id)), new Set(["remote"]));
  } finally { await h.close(); }
});

test("logout and another login never migrate the previous account into the new one", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:signIn", "alice", "password");
    await h.disk.writeData("library", library("A-only"));
    await h.invoke("auth:signOut");
    h.user("B");
    await h.invoke("auth:signIn", "bob", "password");
    assert.equal(h.disk.readData("library").state.liked?.length ?? 0, 0);
    assert.ok(h.uploads.filter(v => v.user_id === "B").every(v => !JSON.stringify(v.payload).includes("A-only")));
    await h.invoke("auth:signOut");
    h.user("A");
    await h.invoke("auth:signIn", "alice", "password");
    assert.equal(h.disk.readData("library").state.liked[0].id, "A-only");
  } finally { await h.close(); }
});

for (const clear of ["continueGuest", "signOut", "reset"]) {
  test(`after ${clear}, an existing-account sign-in shows only the account's data`, async () => {
    const h = fixture();
    try {
      await h.invoke("auth:continueGuest");
      const doc = await h.invoke("data:scope");
      await h.invoke("data:write", "library", library("guest"), doc);
      await h.invoke("auth:clearGuestProfile");
      if (clear === "continueGuest") await h.invoke("auth:continueGuest");
      if (clear === "signOut") await h.invoke("auth:signOut");
      if (clear === "reset") await h.invoke("app:resetData");
      h.rows([row("library", library("remote"))]);
      await h.invoke("auth:signIn", "alice", "password");
      assert.deepEqual(new Set(h.disk.readData("library").state.liked.map(t => t.id)), new Set(["remote"]));
    } finally { await h.close(); }
  });
}

async function signedIn(h) {
  await h.auth.signIn("alice", "password");
  h.calls.length = 0;
}

test("sync notifies the union of merged and pulled stores once", async () => {
  const h = fixture();
  try {
    await signedIn(h);
    await h.disk.writeData("library", library("local"));
    h.rows([row("library", library("remote")), row("settings", envelope({ crossfadeSeconds: 4 }))]);
    const result = plain(await h.sync.syncNow());
    assert.deepEqual(result.merged, ["library"]);
    assert.deepEqual(result.pulled, ["settings"]);
    assert.equal(h.events.length, 1);
    assert.deepEqual(new Set(h.events[0].stores), new Set(["library", "settings"]));
    assert.deepEqual(new Set(h.sync.syncStatus().restoredStores), new Set(["library", "settings"]));
    assert.equal(h.sync.syncStatus().restoreSeq, 1);
  } finally { await h.close(); }
});

test("sync reports both committed pull and merge even when merged upload fails", async () => {
  const h = fixture();
  try {
    await signedIn(h);
    await h.disk.writeData("settings", envelope({ crossfadeSeconds: 2 }));
    h.rows([row("library", library("remote")), row("settings", envelope({ crossfadeSeconds: 4 }))]);
    h.failUpload("settings");
    await assert.rejects(h.sync.syncNow(), /upload failed/);
    assert.equal(h.disk.readData("library").state.liked[0].id, "remote");
    assert.equal(h.disk.readData("settings").state.crossfadeSeconds, 2);
    assert.equal(h.events.length, 1);
    assert.deepEqual(new Set(h.events[0].stores), new Set(["library", "settings"]));
    assert.notEqual(h.sync.syncStatus().state, "syncing");
  } finally { await h.close(); }
});

for (const method of ["syncNow", "restoreNow"]) {
  test(`${method} partial disk failure reports only successfully committed stores`, async () => {
    const h = fixture();
    try {
      await signedIn(h);
      h.rows([row("library", library("remote")), row("settings", envelope({ crossfadeSeconds: 4 }))]);
      h.failWrite("settings");
      await assert.rejects(h.sync[method](), /disk failed/);
      assert.equal(h.disk.readData("library").state.liked[0].id, "remote");
      assert.equal(h.disk.readData("settings"), null);
      assert.deepEqual(h.events, [{ stores: ["library"], seq: 1 }]);
    } finally { await h.close(); }
  });
  test(`${method} skips an unusable row without notification or store changes`, async () => {
    const h = fixture();
    try {
      await signedIn(h);
      h.rows([row("library", null)]);
      await h.sync[method]();
      // The row was dropped, so nothing was written and nothing was announced.
      assert.deepEqual(h.events, []);
      assert.equal(h.disk.readData("library"), null);
    } finally { await h.close(); }
  });
  test(`${method} still restores the sibling rows of a response holding an unusable one`, async () => {
    const h = fixture();
    try {
      await signedIn(h);
      h.rows([row("library", null), row("settings", envelope({ crossfadeSeconds: 4 }))]);
      await h.sync[method]();
      assert.deepEqual(h.events, [{ stores: ["settings"], seq: 1 }]);
      assert.equal(h.disk.readData("library"), null);
      assert.equal(h.disk.readData("settings").state.crossfadeSeconds, 4);
    } finally { await h.close(); }
  });
  test(`${method} rejects a non-array cloud response outright`, async () => {
    const h = fixture();
    try {
      await signedIn(h);
      h.rows({ library: library("remote") });
      await assert.rejects(h.sync[method](), /Invalid cloud backup data/);
      assert.deepEqual(h.events, []);
    } finally { await h.close(); }
  });
}

test("push-only sync produces no restore notification", async () => {
  const h = fixture();
  try {
    await signedIn(h);
    await h.disk.writeData("library", library("local"));
    assert.deepEqual(plain(await h.sync.syncNow()), { pushed: ["library"], pulled: [], merged: [] });
    assert.deepEqual(h.events, []);
    assert.equal(h.sync.syncStatus().restoreSeq, 0);
  } finally { await h.close(); }
});

test("account-switch sync reports all cleared stores once, even after a later restore failure", async () => {
  const h = fixture();
  try {
    await signedIn(h);
    await h.disk.writeData("sync-meta", { stores: {}, lastUserId: "previous" });
    await h.disk.writeData("library", library("previous"));
    h.rows([row("library", library("remote")), row("settings", envelope({ crossfadeSeconds: 4 }))]);
    h.failWrite("settings");
    await assert.rejects(h.sync.syncNow(), /disk failed/);
    assert.deepEqual(h.events, [{ stores: ["library", "settings", "recent-searches", "listening-signals", "listening-history", "artist-meta-cache"], seq: 1 }]);
    assert.equal(h.disk.readData("library").state.liked[0].id, "remote");
  } finally { await h.close(); }
});

for (const state of ["display-only", "expired", "mismatched", "guest"]) {
  test(`manual restore refuses ${state} identity before cloud or persistence calls`, async () => {
    const h = fixture();
    try {
      if (state !== "display-only") {
        h.expired(state === "expired");
        await signedIn(h);
      }
      if (state === "display-only" || state === "mismatched") await h.disk.writeData("profile", { mode: "account", userId: "B" });
      if (state === "guest") await h.auth.continueAsGuest();
      await h.disk.drainWrites();
      assert.equal(h.auth.authenticatedUserId(), null);
      const before = fs.readdirSync(path.join(h.dir, "data"));
      h.rows([row("library", library("remote"))]);
      await assert.rejects(h.sync.restoreNow(), /Sign in first/);
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.events, []);
      assert.equal(h.disk.readData("library"), null);
      assert.deepEqual(fs.readdirSync(path.join(h.dir, "data")), before);
    } finally { await h.close(); }
  });
}

test("manual restore with verified identity restores and retains device fields", async () => {
  const h = fixture();
  try {
    await signedIn(h);
    await h.disk.writeData("library", { ...library("local"), state: { ...library("local").state, downloads: { local: "audio.mp3" } } });
    h.rows([row("library", library("remote"))]);
    assert.deepEqual(Array.from(await h.sync.restoreNow()), ["library"]);
    assert.ok(h.calls.some(v => v.readUser === "A"));
    assert.equal(h.disk.readData("library").state.liked[0].id, "remote");
    assert.deepEqual(plain(h.disk.readData("library").state.downloads), { local: "audio.mp3" });
    assert.deepEqual(h.events, [{ stores: ["library"], seq: 1 }]);
  } finally { await h.close(); }
});

test("Replay keeps uploading as listening accumulates, not just once", async () => {
  const h = fixture();
  try {
    // A stale cloud row must exist, otherwise "local with no remote copy"
    // would push unconditionally and the test could not tell a real change
    // notification from an accident of emptiness.
    h.rows([row("listening-history", { state: { buckets: [] }, version: 1 })]);
    await h.invoke("auth:signIn", "alice", "password");
    const replayStore = (ms) => ({
      state: { buckets: [{ month: "2026-10", tracks: { t: { title: "T", artist: "A", thumb: "", ms, plays: 1, lastAt: 1 } }, artists: {}, albums: {}, hours: new Array(24).fill(0), days: {} }] },
      version: 1,
    });
    const uploadsOf = () => h.uploads.filter((v) => v.store_name === "listening-history");
    const freshUploads = () => uploadsOf().filter((v) => v.payload.state.buckets[0]?.tracks.t?.ms >= 60_000);

    // The user listens; the stats module flushes the store and reports it.
    await h.disk.writeData("listening-history", replayStore(60_000));
    h.statsNotify();
    await h.sync.syncNow();
    assert.equal(freshUploads().length, 1, "first listening session uploads");

    // More listening later: a second flush must reach the cloud too — this is
    // the property that was missing when Replay lived outside the write path.
    await h.disk.writeData("listening-history", replayStore(120_000));
    h.statsNotify();
    await h.sync.syncNow();
    assert.equal(freshUploads().length, 2, "later listening uploads again");
    const last = uploadsOf().at(-1).payload.state.buckets[0].tracks.t.ms;
    assert.equal(last, 120_000, "the uploaded copy is the fresh one");

    // A guest's Replay never uploads.
    await h.invoke("auth:signOut");
    const before = uploadsOf().length;
    await h.disk.writeData("listening-history", replayStore(240_000));
    h.statsNotify();
    await h.sync.syncNow();
    assert.equal(uploadsOf().length, before, "guest Replay stays local");
  } finally { await h.close(); }
});
