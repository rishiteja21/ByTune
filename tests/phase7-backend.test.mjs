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
  const handlers = new Map(), modules = new Map(), events = [], calls = [], uploads = [], spotifyCalls = [], roomCalls = [], names = new Map();
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
      // Display names (supabase/migrations/0003) sit in their own table, apart from the store rows.
      if (table === "display_names") return {
        select: () => ({ eq: (_field, id) => ({ maybeSingle: async () => ({ data: names.has(id) ? { name: names.get(id) } : null, error: null }) }) }),
        async upsert(value) { names.set(value.user_id, value.name); return { error: null }; },
      };
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
      // A stand-in Supabase project (config.ts reads it from the build): the SDK is stubbed above.
      process: { env: { BYTUNE_SUPABASE_URL: "https://bytune-test.invalid", BYTUNE_SUPABASE_KEY: "sb_publishable_test" }, on() {} },
      require(name) {
        if (name === "electron") return electron;
        if (name === "fs") return fakeFs;
        if (name === "@supabase/supabase-js") return { createClient: () => sdk };
        if (isMain && name.startsWith("./") && !["./persist", "./supabase", "./sync", "./data-transition"].includes(name)) {
          if (name === "./downloads") return { addDownloadListener() {}, resetDownloads: async () => {}, defaultDownloadDir: async () => path.join(dir, "downloads"), exportDownloadDir: () => path.join(dir, "exports") };
          if (name === "./local-library") return { resetLocalLibrary: async () => {}, readLocalLibrary: () => ({ folders: [] }) };
          if (name === "./stats") return { resetStats() {}, initStats() {}, flushSync() {}, reloadStore() {}, recordListening() {}, summary: () => ({ totalMs: 0 }), HISTORY_STORE: "listening-history", onStoreWrite(fn) { statsNotify = fn; } };
          if (name === "./pip") return { registerPipIpc() {}, isTrustedSender: () => true };
          if (name === "./stream-proxy") return { setDownloadedFileLookup() {} };
          if (name === "./downloaded-files") return { noteLibrary() {}, noteDownloaded() {}, downloadedFilePath: () => null };
          if (name === "./spotify") return {
            forgetSpotify: async () => { spotifyCalls.push("forget"); },
            moveGuestSpotify: async (owner) => { spotifyCalls.push(`moveGuest:${owner}`); },
          };
          if (name === "./rooms") return { onRoomChange() {}, leaveRoom: async () => { roomCalls.push("leave"); return {}; }, roomView: () => ({ state: null }) };
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
    dir, disk, auth, sync, transition, events, calls, uploads, spotifyCalls, roomCalls, names,
    invoke: (name, ...args) => handlers.get(name)({}, ...args),
    statsNotify: () => statsNotify?.(),
    /** The real Replay module sync.ts uses (main.ts gets a stand-in). */
    stats: load(path.join(root, "electron", "stats.ts")),
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
    await h.invoke("auth:signUp", "alice", "valid-password-123", "Alice");
    assert.equal(h.transition.currentOwner(), "A");
    assert.equal(h.names.get("A"), "Alice", "the display name reaches the account");
    assert.equal(h.auth.sessionInfo().displayName, "Alice");
    assert.deepEqual(new Set(h.disk.readData("library").state.liked.map(t => t.id)), new Set(["guest", "remote"]));
    assert.equal(h.disk.readData("library").state.playlists[0].id, "p");
    assert.deepEqual(plain(h.disk.readData("recent-searches").state.searches), ["guest query"]);
    const uploaded = h.uploads.find(v => v.store_name === "library");
    assert.deepEqual(new Set(uploaded.payload.state.liked.map(t => t.id)), new Set(["guest", "remote"]));
    assert.equal(uploaded.user_id, "A");
    assert.ok(h.uploads.some(v => v.store_name === "recent-searches"));
  } finally { await h.close(); }
});

test("a fresh install's first settings sync keeps the account's AutoPlay choice", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:signIn", "alice", "password");
    // An install whose settings have never synced: the app writes them (with
    // the new default, AutoPlay on) before the first settings sync runs…
    h.sync.resetSyncState("A");
    const doc = await h.invoke("data:scope");
    await h.invoke("data:write", "settings", envelope({ autoplay: true, crossfadeSeconds: 6 }), doc);
    // …while the account already says AutoPlay off.
    h.rows([row("settings", { state: { autoplay: false, crossfadeSeconds: 0 }, version: 0 })]);
    await h.sync.syncNow();
    const settings = h.disk.readData("settings").state;
    assert.equal(settings.autoplay, false, "the account's AutoPlay choice is not overwritten by a default");
    assert.equal(settings.crossfadeSeconds, 6, "other local settings still win, as before");
  } finally { await h.close(); }
});

test("local songs never upload their absolute file path", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:continueGuest");
    const doc = await h.invoke("data:scope");
    // Library data saved by older builds carried the file path on local tracks.
    const local = { ...track("local:abc"), localPath: "C:\\Users\\someone\\Music\\song.mp3" };
    const lib = library("guest");
    lib.state.liked.push(local);
    lib.state.history = [local];
    lib.state.playlists = [{ id: "p", name: "Mixed", createdAt: 1, tracks: [local, track("yt")] }];
    await h.invoke("data:write", "library", lib, doc);
    h.rows([]);
    await h.invoke("auth:signUp", "alice", "valid-password-123", "Alice");
    const uploaded = h.uploads.find((v) => v.store_name === "library");
    assert.ok(uploaded, "the library was uploaded");
    assert.ok(!JSON.stringify(uploaded.payload).includes("localPath"), "no localPath anywhere in the upload");
    assert.ok(!JSON.stringify(uploaded.payload).includes("song.mp3"));
    assert.ok(uploaded.payload.state.liked.some((t) => t.id === "local:abc"), "the song itself still syncs");
    assert.equal(h.disk.readData("library").state.liked.find((t) => t.id === "local:abc").localPath, local.localPath,
      "the copy on this device is untouched");
  } finally { await h.close(); }
});

test("songs from this computer never upload; their playlists sync without them and get them back on a restore", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:continueGuest");
    const doc = await h.invoke("data:scope");
    const lib = library("guest");
    lib.state.playlists = [
      { id: "mixed", name: "chills", createdAt: 3, device: true, tracks: [track("yt1"), track("local:a"), track("yt2")] },
      { id: "here", name: "On this PC", createdAt: 2, tracks: [track("local:b")] },
      { id: "plain", name: "Everywhere", createdAt: 1, tracks: [track("yt3")] },
    ];
    await h.invoke("data:write", "library", lib, doc);
    h.rows([]);
    await h.invoke("auth:signUp", "alice", "valid-password-123", "Alice");
    const uploaded = h.uploads.find((v) => v.store_name === "library").payload.state.playlists;
    assert.deepEqual(uploaded.map((p) => p.id), ["mixed", "plain"], "a playlist of only local songs stays here");
    assert.deepEqual(uploaded[0].tracks.map((t) => t.id), ["yt1", "yt2"], "the rest of its songs sync, the local one doesn't");
    assert.equal("device" in uploaded[0], false, "an earlier build's flag never reaches the account");

    // The account's copy replaces the library (a restore; another device added yt9).
    const remote = library("remote");
    remote.state.playlists = [
      { id: "mixed", name: "chills", createdAt: 3, tracks: [track("yt1"), track("yt2"), track("yt9")] },
      { id: "cloud", name: "Cloud", createdAt: 4, tracks: [track("yt5")] },
    ];
    h.rows([row("library", remote)]);
    await h.sync.restoreNow();
    const restored = h.disk.readData("library").state.playlists;
    assert.deepEqual(plain(restored.map((p) => p.id)), ["here", "mixed", "cloud"], "the local-only playlist comes back whole");
    assert.deepEqual(plain(restored.find((p) => p.id === "mixed").tracks.map((t) => t.id)), ["yt1", "local:a", "yt2", "yt9"],
      "the local song is back where it was");
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

test("Spotify stays with the account through sign-out and back in; a guest who signs up brings theirs; only a reset forgets", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:continueGuest");
    await h.invoke("auth:signUp", "alice", "valid-password-123", "Alice");
    assert.deepEqual(h.spotifyCalls, ["moveGuest:A"], "the new account takes the guest's Spotify");
    await h.invoke("auth:signOut");
    await h.invoke("auth:signIn", "alice", "password");
    h.user("B");
    await h.invoke("auth:signOut");
    await h.invoke("auth:signIn", "bob", "password");
    assert.deepEqual(h.spotifyCalls, ["moveGuest:A"], "signing out, back in, or into an existing account forgets and moves nothing");
    await h.invoke("app:resetData");
    assert.deepEqual(h.spotifyCalls, ["moveGuest:A", "forget"]);
  } finally { await h.close(); }
});

test("a room is left before every sign-in, sign-out and data reset, while its account can still say so", async () => {
  const h = fixture();
  try {
    await h.invoke("auth:signIn", "alice", "password");
    assert.equal(h.roomCalls.length, 1, "sign-in");
    await h.invoke("auth:signOut");
    assert.equal(h.roomCalls.length, 2, "sign-out");
    await h.invoke("app:resetData");
    assert.equal(h.roomCalls.length, 3, "reset");
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

test("a sync merge includes the last seconds of Replay listening still held in memory", async () => {
  const h = fixture();
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const replay = (tracks) => ({
      state: { buckets: [{ month, tracks, artists: {}, albums: {}, hours: new Array(24).fill(0), days: {} }] },
      version: 1,
    });
    const rec = (ms) => ({ title: "T", artist: "A", thumb: "", ms, plays: 1, lastAt: 1 });
    h.rows([row("listening-history", replay({ fromCloud: rec(90_000) }))]);
    await h.invoke("auth:signIn", "alice", "password");
    // The app wires Replay writes into sync exactly like this (main.ts).
    h.stats.onStoreWrite(() => h.sync.noteLocalWrite(h.stats.HISTORY_STORE));
    h.stats.initStats();
    // A few seconds of listening, still only in memory (Replay flushes every 5 s)…
    h.stats.recordListening({ id: "heardHere", title: "Here", artist: "A", duration: 200, thumb: "" }, 20_000);
    // …while another device moves the cloud copy on.
    h.rows([{ ...row("listening-history", replay({ fromCloud: rec(120_000) })), updated_at: new Date(Date.now() + 60_000).toISOString() }]);
    await h.sync.syncNow();
    const tracks = h.disk.readData("listening-history").state.buckets.find((b) => b.month === month).tracks;
    assert.equal(tracks.heardHere?.ms, 20_000, "this device's unflushed listening survives the sync");
    assert.equal(tracks.fromCloud.ms, 120_000, "and the other device's newer listening arrives");
  } finally {
    h.stats.resetStats();
    await h.close();
  }
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

test("signed in, only a store's first unsynced write saves sync meta to disk at once", async () => {
  const h = fixture();
  try {
    await signedIn(h);
    await h.disk.writeData("library", library("local"));
    await h.sync.syncNow();
    const clean = plain(h.disk.readData("sync-meta")).stores.library;
    assert.ok(clean.changedAt <= clean.syncedAt, "pushed: clean");
    await new Promise((r) => setTimeout(r, 5));
    h.sync.noteLocalWrite("library");
    const dirty = plain(h.disk.readData("sync-meta")).stores.library;
    assert.ok(dirty.changedAt > dirty.syncedAt, "the clean-to-dirty edge is on disk at once");
    await new Promise((r) => setTimeout(r, 5));
    h.sync.noteLocalWrite("library");
    assert.equal(plain(h.disk.readData("sync-meta")).stores.library.changedAt, dirty.changedAt, "later writes stay in memory");
    assert.ok(h.sync.syncStatus().pending > 0, "a push is still on its way");
  } finally { await h.close(); }
});
