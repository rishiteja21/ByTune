import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { srcModule } from "./helpers/src-module.mjs";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../electron/", import.meta.url));

async function harness({ legacyStores = false } = {}) {
  let source = fs.readFileSync(path.join(root, "main.ts"), "utf8");
  // Negative control: remove only the exact-name gate, keeping sender protection intact.
  if (legacyStores) source = source.replaceAll("    assertRendererStore(name);", "");
  const { code } = await transform(source + "\nexport { registerIpc };", { loader: "ts", format: "cjs" });
  const handles = new Map(), calls = [];
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, URL, __dirname: root,
    process: { env: {}, on() {} },
    require(name) {
      if (name === "electron") return {
        app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => path.join(root, "userdata") },
        protocol: { registerSchemesAsPrivileged() {} },
        ipcMain: { handle: (n, fn) => handles.set(n, fn), on() {} },
      };
      if (name === "./pip") return { registerPipIpc() {}, isTrustedSender: e => e?.trusted === true };
      if (name === "./downloads") return { addDownloadListener() {}, defaultDownloadDir: async () => path.join(root, "downloads"), exportDownloadDir: () => path.join(root, "exports") };
      if (name === "./sync") return { noteLocalWrite() {} };
      if (name === "./stats") return { onStoreWrite() {}, HISTORY_STORE: "listening-history" };
      if (name === "./local-library") return {
        addLibraryFolders: (paths) => { calls.push(["addFolders", ...paths]); return Promise.resolve({ added: [], lib: { folders: [] } }); },
      };
      if (name === "./data-transition") return {
        serializeData: fn => Promise.resolve().then(fn),
        readForDocument: name => { calls.push(["read", name]); return null; },
        writeForDocument: async name => { calls.push(["write", name]); return true; },
      };
      if (name === "./music-service") return {
        localGainDb: (id) => { calls.push(["gain", id]); return -6.5; },
        retryStream: (id) => { calls.push(["retry", id]); },
        getPodcasts: (...args) => { calls.push(["podcasts", ...args]); return [{ title: "Popular shows", shows: [], episodes: [] }]; },
        getMoodCovers: (...args) => { calls.push(["moodCovers", ...args]); return ["https://cover"]; },
        getMoodPage: (...args) => { calls.push(["moodPage", ...args]); return { title: "Telugu", shelves: [] }; },
      };
      if (name === "./stream-proxy") return {
        startStreamProxy: async () => { calls.push(["proxy"]); return 4321; },
        proxyUrlFor: (id, retry, kbps) => { calls.push(["url", id, retry, kbps]); return `proxy:${id}`; },
        proxyUrlForLocalTrack: () => null,
        setDownloadedFileLookup() {},
      };
      if (name === "./downloaded-files") return { noteLibrary() {}, noteDownloaded() {}, downloadedFilePath: () => null };
      if (name === "./spotify") return {
        LIKED_ID: "liked",
        spotifyPlaylist: (id) => { calls.push(["spotifyPlaylist", id]); return { name: "x", songs: [], total: 0 }; },
        publicPlaylist: (link) => { calls.push(["publicPlaylist", link]); return { name: "x", songs: [], total: 0 }; },
        matchSong: (song, prefer) => { calls.push(["match", JSON.parse(JSON.stringify(song)), prefer]); return null; },
      };
      if (name === "./rooms") return {
        onRoomChange() {},
        joinRoom: (code) => { calls.push(["join", code]); return {}; },
        updateRoom: (change) => { calls.push(["update", JSON.parse(JSON.stringify(change))]); return {}; },
        setHostOnly: (on) => { calls.push(["hostOnly", on]); return {}; },
        makeHost: (id) => { calls.push(["makeHost", id]); return {}; },
        removeMember: (id) => { calls.push(["remove", id]); return {}; },
        stash: (s) => { calls.push(["stash", JSON.parse(JSON.stringify(s)).queue.length]); },
      };
      if (name.startsWith("../src/")) return srcModule(name);
      if (name.startsWith("./")) return {};
      return require(name);
    },
  });
  module.exports.registerIpc();
  return {
    calls,
    invoke: (channel, name, trusted = true) => Promise.resolve().then(() => handles.get(channel)({ trusted }, name, {}, "scope")),
    call: (channel, ...args) => Promise.resolve().then(() => handles.get(channel)({ trusted: true }, ...args)),
  };
}

test("reserved/noncanonical persistence names are rejected before storage on both channels", async () => {
  const h = await harness();
  for (const name of ["auth", "account", "profile", "approved-dirs", "local-library", "data-owner", "sync-meta", "owner-archive", "set.tings", "", null, {}]) {
    for (const channel of ["data:read", "data:write"]) await assert.rejects(h.invoke(channel, name), /Store not allowed/);
  }
  assert.equal(h.calls.length, 0);
  for (const name of ["settings", "panel-layout", "library", "player", "recent-searches", "listening-signals", "artist-meta-cache"]) {
    await h.invoke("data:read", name);
    await h.invoke("data:write", name);
  }
  assert.equal(h.calls.length, 14);
  await assert.rejects(h.invoke("data:read", "settings", false), /Untrusted IPC sender/);
});

test("negative control detects the original missing persistence gate", async () => {
  const h = await harness({ legacyStores: true });
  await h.invoke("data:write", "approved-dirs");
  assert.deepEqual(h.calls, [["write", "approved-dirs"]]);
});

test("library:addFolders cannot mint filesystem approvals from renderer input", async () => {
  const h = await harness();
  // A renderer-supplied path that never went through the native picker is
  // rejected before reaching the local library — approvals are only minted
  // by app:pickFolder / default download locations.
  await assert.rejects(h.invoke("library:addFolders", ["C:\\Users\\victim\\Documents"]), /Folder not approved/);
  await assert.rejects(h.invoke("library:addFolders", ["C:\\approved\\..\\..\\escape"]), /Folder not approved/);
  await assert.rejects(h.invoke("library:addFolders", new Array(12).fill("C:\\x")), /Invalid folder list|Folder not approved/);
  assert.equal(h.calls.filter((c) => c[0] === "addFolders").length, 0);
  // An approved path (userData subtree) still flows through to the library.
  await h.invoke("library:addFolders", [path.join(root, "userdata", "music")]);
  assert.deepEqual(h.calls.at(-1), ["addFolders", path.resolve(path.join(root, "userdata", "music"))]);
});

const VIDEO = "dQw4w9WgXcQ";

test("music:stream takes only a bare 11-character YouTube id", async () => {
  const h = await harness();
  const refused = ["local:abc", "dQw4w9WgXc", "dQw4w9WgXcQQ", "dQw4w9WgXc!", "dQw4w9Wg&c=", "../../etc/x", " dQw4w9WgXc", "", null, 42, {}, [VIDEO]];
  for (const id of refused) await assert.rejects(h.call("music:stream", id), /Invalid track id/, JSON.stringify(id));
  assert.deepEqual(h.calls, [], "a refused id starts nothing and resolves nothing");
  assert.equal(await h.call("music:stream", VIDEO), `proxy:${VIDEO}`);
  assert.deepEqual(h.calls.filter((c) => c[0] !== "proxy"), [["url", VIDEO, false, undefined]]);
  await assert.rejects(h.invoke("music:stream", VIDEO, false), /Untrusted IPC sender/);
});

test("music:stream retry drops the song's cache before handing out the fresh URL", async () => {
  const h = await harness();
  await h.call("music:stream", VIDEO, true, "low");
  assert.deepEqual(h.calls.filter((c) => c[0] !== "proxy"), [["retry", VIDEO], ["url", VIDEO, true, 64]]);
  h.calls.length = 0;
  await h.call("music:stream", VIDEO, "true", "high"); // only a real `true` is a retry
  assert.deepEqual(h.calls.filter((c) => c[0] !== "proxy"), [["url", VIDEO, false, undefined]]);
});

test("local:gainDb answers only for a local file's id", async () => {
  const h = await harness();
  const longest = "local:" + "x".repeat(194); // 200 characters
  assert.equal(await h.call("local:gainDb", "local:abc"), -6.5);
  assert.equal(await h.call("local:gainDb", longest), -6.5);
  for (const id of [VIDEO, "LOCAL:abc", " local:abc", longest + "x", null, 42, {}, ["local:abc"]]) {
    assert.equal(await h.call("local:gainDb", id), null, JSON.stringify(id));
  }
  assert.deepEqual(h.calls, [["gain", "local:abc"], ["gain", longest]], "nothing else reached the library");
  await assert.rejects(h.invoke("local:gainDb", "local:abc", false), /Untrusted IPC sender/);
});

test("music:podcasts browses its one fixed page, whatever the renderer sends", async () => {
  const h = await harness();
  assert.deepEqual(await h.call("music:podcasts"), [{ title: "Popular shows", shows: [], episodes: [] }]);
  await h.call("music:podcasts", "FEmusic_library_landing", { browseId: "VLLM" }, "../x");
  assert.deepEqual(h.calls, [["podcasts"], ["podcasts"]], "no renderer argument reaches the service");
  await assert.rejects(h.invoke("music:podcasts", undefined, false), /Untrusted IPC sender/);
  assert.equal(h.calls.length, 2, "an untrusted sender reaches nothing");
});

test("music:moodCovers browses only a moods page's own category, with its params as sent", async () => {
  const h = await harness();
  const params = "ggMPOg1uX1JOQWZFeDByc2Jm";
  assert.deepEqual(await h.call("music:moodCovers", "FEmusic_moods_and_genres_category", params), ["https://cover"]);
  for (const [browseId, p] of [["VLLM", params], ["FEmusic_library_landing", params], ["FEmusic_moods_and_genres_category", "../x"], ["FEmusic_moods_and_genres_category", 7], ["FEmusic_moods_and_genres_category", "a".repeat(301)], ["FEmusic_moods_and_genres_category", ""]]) {
    await assert.rejects(h.call("music:moodCovers", browseId, p), /Not a mood page/);
  }
  assert.deepEqual(h.calls, [["moodCovers", "FEmusic_moods_and_genres_category", params]], "only the valid call reaches the service");
  await assert.rejects(h.invoke("music:moodCovers", undefined, false), /Untrusted IPC sender/);
});

test("music:moodPage takes the same checks: only a moods page's own category", async () => {
  const h = await harness();
  const params = "ggMPOg1uX1JOQWZFeDByc2Jm";
  assert.deepEqual(await h.call("music:moodPage", "FEmusic_moods_and_genres_category", params), { title: "Telugu", shelves: [] });
  for (const [browseId, p] of [["VLLM", params], ["FEmusic_moods_and_genres_category", "../x"], ["FEmusic_moods_and_genres_category", null]]) {
    await assert.rejects(h.call("music:moodPage", browseId, p), /Not a mood page/);
  }
  assert.deepEqual(h.calls, [["moodPage", "FEmusic_moods_and_genres_category", params]]);
  await assert.rejects(h.invoke("music:moodPage", undefined, false), /Untrusted IPC sender/);
});

test("spotify:playlist takes only Liked Songs or a 22-character Spotify id", async () => {
  const h = await harness();
  const ID = "37i9dQZF1DXcBWIGoYBM5M";
  for (const id of ["", "x", ID + "x", ID.slice(1), "../../x", "liked ", "LIKED", null, 42, {}, [ID]]) {
    await assert.rejects(h.call("spotify:playlist", id), /Not a Spotify playlist/, JSON.stringify(id));
  }
  await h.call("spotify:playlist", ID);
  await h.call("spotify:playlist", "liked");
  assert.deepEqual(h.calls, [["spotifyPlaylist", ID], ["spotifyPlaylist", "liked"]]);
  await assert.rejects(h.invoke("spotify:playlist", ID, false), /Untrusted IPC sender/);
});

test("spotify:publicPlaylist takes one short string; main checks it's a Spotify link", async () => {
  const h = await harness();
  for (const link of [null, 42, {}, ["https://open.spotify.com/playlist/x"], "h".repeat(501)]) {
    await assert.rejects(h.call("spotify:publicPlaylist", link), /isn't a link/);
  }
  await h.call("spotify:publicPlaylist", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.invoke("spotify:publicPlaylist", "x", false), /Untrusted IPC sender/);
});

test("match:song passes on only a clean song: known fields, bounded text, a real length and Spotify id", async () => {
  const h = await harness();
  for (const song of [null, 42, "Yellow", {}, { title: "" }, { title: "  ", artist: "" }, { title: "Yellow" }, { title: "x".repeat(301), artist: "" }, { title: "Yellow", artist: 5 }]) {
    await assert.rejects(h.call("match:song", song, ""), /Not a song/, JSON.stringify(song));
  }
  assert.equal(h.calls.length, 0);
  await h.call("match:song", JSON.parse('{"title":"Yellow","artist":"Coldplay","album":"Parachutes","duration":266.4,"spotifyId":"3AJwUDP919kvQ9QcozQPxg","thumb":"file:///x","__proto__":{"polluted":1},"extra":"x"}'), "telugu");
  await h.call("match:song", { title: "Yellow", artist: "", duration: -5, spotifyId: "../x", album: 7 }, 42);
  await h.call("match:song", { title: "Yellow", artist: "", duration: 1e9 }, "telugu");
  assert.deepEqual(h.calls, [
    ["match", { title: "Yellow", artist: "Coldplay", duration: 266, album: "Parachutes", spotifyId: "3AJwUDP919kvQ9QcozQPxg" }, "telugu"],
    ["match", { title: "Yellow", artist: "", duration: 0 }, ""],
    ["match", { title: "Yellow", artist: "", duration: 0 }, "telugu"],
  ]);
  assert.equal(({}).polluted, undefined);
  await assert.rejects(h.invoke("match:song", { title: "Yellow", artist: "" }, false), /Untrusted IPC sender/);
});

test("room channels: codes, changes, member ids and the set-aside queue are checked before the room sees them", async () => {
  const h = await harness();
  for (const code of [null, 42, {}, "", "ABC", "ABCDE0", "x".repeat(101), "https://evil.example/ABC234"]) {
    await assert.rejects(h.call("room:join", code), /isn't a room code/, JSON.stringify(code));
  }
  await h.call("room:join", " abc-234 ");
  await h.call("room:join", "bytune://room/HJK789");
  const good = { baseSeq: 3, track: { id: "dQw4w9WgXcQ" }, positionMs: 1000, playing: true, queue: [], lead: true, note: "played x" };
  for (const bad of [
    null, "x", { ...good, baseSeq: -1 }, { ...good, baseSeq: 1.5 }, { ...good, positionMs: -1 }, { ...good, positionMs: 1e12 },
    { ...good, playing: "yes" }, { ...good, lead: 1 }, { ...good, queue: "x" }, { ...good, queue: Array(201).fill({}) },
    { ...good, track: [good.track] }, { ...good, note: "n".repeat(201) },
  ]) {
    await assert.rejects(h.call("room:update", bad), /Not a room change/, JSON.stringify(bad)?.slice(0, 60));
  }
  await h.call("room:update", good);
  await h.call("room:update", { ...good, track: null });
  await assert.rejects(h.call("room:hostOnly", "true"), /Not a setting/);
  await h.call("room:hostOnly", true);
  for (const id of [null, "", "u1", "../x", "8d2f2a44-0000-4000-8000-00000000000"]) {
    await assert.rejects(h.call("room:makeHost", id), /Not a member/);
    await assert.rejects(h.call("room:remove", id), /Not a member/);
  }
  const member = "8d2f2a44-0000-4000-8000-000000000001";
  await h.call("room:makeHost", member);
  await h.call("room:remove", member);
  for (const s of [null, [], { queue: "x" }, { queue: Array(5001).fill({ id: "a" }) }]) {
    await assert.rejects(h.call("room:stash", s), /Not a queue/);
  }
  await h.call("room:stash", { queue: [{ id: "local:abc" }, { id: "dQw4w9WgXcQ" }], index: 0 });
  assert.deepEqual(h.calls, [
    ["join", "ABC234"], ["join", "HJK789"], ["update", good], ["update", { ...good, track: null }], ["hostOnly", true],
    ["makeHost", member], ["remove", member], ["stash", 2],
  ]);
  await assert.rejects(h.invoke("room:join", "ABC234", false), /Untrusted IPC sender/);
});
