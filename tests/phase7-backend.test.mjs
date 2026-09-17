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
  let rows = [], user = "A", expired = false, authChanged, failUpload, failWrite;
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
          if (name === "./stats") return { resetStats() {}, initStats() {}, flushSync() {}, recordListening() {}, summary: () => ({ totalMs: 0 }) };
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
    rows(value) { rows = value; },
    user(value) { user = value; },
    expired(value) { expired = value; },
    failUpload(name) { failUpload = name; },
    failWrite(name) { failWrite = name; },
    async close() { failWrite = undefined; sync.resetSyncState(); await disk.drainWrites(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

for (const method of ["auth:signIn", "auth:signUp"]) {
  test(`guest upgrade via clearGuestProfile preserves and uploads data through ${method}`, async () => {
    const h = fixture();
    try {
      await h.invoke("auth:continueGuest");
      const doc = await h.invoke("data:scope");
      const guest = library("guest");
      guest.state.playlists = [{ id: "p", name: "Guest playlist", createdAt: 1, tracks: [track("guest")] }];
      await h.invoke("data:write", "library", guest, doc);
      await h.invoke("data:write", "recent-searches", envelope({ searches: ["guest query"] }), doc);
      assert.equal(h.calls.length, 0, "guest writes are local-only");
      await h.invoke("auth:clearGuestProfile");
      assert.equal(h.auth.readProfile(), null);
      h.rows([row("library", library("remote"))]);
      await h.invoke(method, "alice", "valid-password-123");
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
}

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

test("failed sign-in retains the guest upgrade intent for a retry", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:continueGuest");
    const doc = await h.invoke("data:scope");
    await h.invoke("data:write", "library", library("guest"), doc);
    await h.invoke("auth:clearGuestProfile");
    h.rows([]);
    await assert.rejects(h.invoke("auth:signIn", "alice", "wrong-password"), /Wrong username or password|Sign in failed/);
    assert.equal(h.transition.currentOwner(), "guest");
    h.rows([row("library", library("remote"))]);
    await h.invoke("auth:signIn", "alice", "valid-password-123");
    assert.deepEqual(new Set(plain(h.disk.readData("library").state.liked).map(t => t.id)), new Set(["guest", "remote"]));
  } finally { await h.close(); }
});

for (const clear of ["continueGuest", "signOut", "reset"]) {
  test(`guest upgrade intent never leaks after ${clear}`, async () => {
    const h = fixture();
    try {
      await h.invoke("auth:continueGuest");
      await h.invoke("auth:clearGuestProfile");
      if (clear === "continueGuest") await h.invoke("auth:continueGuest");
      if (clear === "signOut") await h.invoke("auth:signOut");
      if (clear === "reset") await h.invoke("app:resetData");
      await h.invoke("auth:signIn", "alice", "password");
      assert.equal(h.disk.readData("library")?.state?.liked?.length ?? 0, 0);
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
  test(`${method} rejects invalid rows without notification or store changes`, async () => {
    const h = fixture();
    try {
      await signedIn(h);
      h.rows([row("library", null)]);
      await assert.rejects(h.sync[method](), /Invalid cloud backup data/);
      assert.deepEqual(h.events, []);
      assert.equal(h.disk.readData("library"), null);
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
    assert.deepEqual(h.events, [{ stores: ["library", "settings", "recent-searches", "listening-signals"], seq: 1 }]);
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
