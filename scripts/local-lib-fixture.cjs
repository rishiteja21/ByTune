/**
 * Local-library integration fixture — runs INSIDE electron (main process) so
 * the real local-library.ts module executes against real files:
 *
 *   phase 1: legacy-store migration → imports (standalone, parent, second
 *            location) → dedup (re-import, parent/child overlap) → rename
 *            metadata-only → playback path resolution → folder statuses.
 *   phase 2: a fresh electron process over the SAME userData (a real app
 *            restart) → folders/renames persisted → remove folder leaves
 *            disk untouched → moved folder degrades gracefully.
 *
 * Prints PASS/FAIL per check; exits non-zero when any check failed.
 * The LQA_* env vars and the fixture tree layout are set by
 * scripts/local-lib-qa.mjs.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const locallib = require("./local-library.cjs");

let failures = 0;
function check(name, cond, extra) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`${tag} — ${name}${cond ? "" : ` [${extra ?? ""}]`}`);
  if (!cond) failures++;
}

/** Minimal valid WAV (8 kHz 16-bit mono sine), long enough to pass the 30 s gate. */
function writeWav(file, seconds = 36) {
  const rate = 8000;
  const frames = rate * seconds;
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

// Local mirror of the shared scoping rule — the fixture must not trust the
// module under test for its own assertions.
const isUnder = (child, root) => {
  const c = String(child).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = String(root).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return c === r || c.startsWith(r + "/");
};
const countUnder = (lib, folderPath) => lib.tracks.filter((t) => isUnder(t.path, folderPath)).length;
const sortedNames = (lib) => lib.folders.map((f) => f.name).sort().join(",");

function buildTree(base) {
  const root = path.join(base, "Music");
  writeWav(path.join(root, "English", "Song1.wav"));
  writeWav(path.join(root, "English", "Song2.wav"));
  writeWav(path.join(root, "English", "Pop", "PopSong.wav"));
  writeWav(path.join(root, "Hindi", "Song3.wav"));
  writeWav(path.join(root, "Telugu", "Song4.wav"));
  // A recordings folder: audio present, but never a music collection.
  writeWav(path.join(root, "Recordings", "voice-recording-20240101.wav"));
  const standalone = path.join(base, "Workout Music");
  writeWav(path.join(standalone, "Alpha.wav"));
  const other = path.join(base, "Downloads");
  writeWav(path.join(other, "Country", "Beta.wav"));
  return { root, standalone, other };
}

async function phase1() {
  const base = process.env.LQA_BASE;
  const { root, standalone, other } = buildTree(base);

  // --- Existing-user data: a legacy single-folder store written straight to
  // disk, in the pre-multi-folder shape (folders: string[]).
  const legacyTrack = {
    id: "local:legacy0000000000",
    path: path.join(root, "English", "Song1.wav"),
    title: "Song1",
    artist: "Unknown artist",
    album: "Unknown album",
    duration: 40,
    size: 1,
    mtime: 0,
  };
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "local-library.json"),
    JSON.stringify({ folders: [root], scannedAt: 1700000000000, tracks: [legacyTrack] })
  );

  let lib = locallib.readLocalLibrary();
  check("legacy string folder migrates to an entry with the folder's own name", lib.folders.length === 1 && lib.folders[0].path === root && lib.folders[0].name === path.basename(root), JSON.stringify(lib.folders));
  check("legacy track survives the migration", lib.tracks.length === 1 && lib.tracks[0].path === legacyTrack.path);

  await locallib.renameLibraryFolder(root, "Legacy name");
  check("rename stores a ByTune-only display name", locallib.readLocalLibrary().folders[0].displayName === "Legacy name");
  await locallib.renameLibraryFolder(root, "");
  check("blank rename clears back to the folder's own name", locallib.readLocalLibrary().folders[0].displayName === undefined);

  // --- Import a standalone folder (test 1).
  const r1 = await locallib.addLibraryFolders([standalone]);
  check("standalone import adds exactly its own entry", r1.added.length === 1 && r1.added[0].path === standalone && r1.added[0].name === "Workout Music", JSON.stringify(r1.added));
  lib = await locallib.scanLibrary(true);
  check("scan finds the legacy folder's songs + the standalone song", lib.tracks.length === 6, `got ${lib.tracks.length}: ${lib.tracks.map((t) => path.basename(t.path)).join(",")}`);
  check("recordings folder contributes no tracks", !lib.tracks.some((t) => t.path.includes("Recordings")));
  check("nested folder (English/Pop) is discovered recursively", lib.tracks.some((t) => t.path.includes("Pop") && path.basename(t.path) === "PopSong.wav"));
  check("tags fall back to filename parsing (no crash on untagged audio)", lib.tracks.every((t) => t.title && t.artist));

  // --- Import a parent with several music subfolders (test 2). The parent is
  // already imported (the legacy store), so only its subfolders get pinned.
  const r2 = await locallib.addLibraryFolders([root]);
  check("parent import pins its immediate music subfolders", JSON.stringify(r2.added.map((f) => f.name).sort()) === JSON.stringify(["English", "Hindi", "Telugu"]), JSON.stringify(r2.added.map((f) => f.name)));
  check("no non-music subfolder entries (Recordings skipped)", !r2.added.some((f) => f.name === "Recordings"));
  check("deeply nested Pop is not pinned as an entry", !r2.added.some((f) => f.name === "Pop"));
  lib = await locallib.scanLibrary(true);
  check("no duplicate tracks after parent import", lib.tracks.length === 6, `got ${lib.tracks.length}`);
  check("unique physical files only", new Set(lib.tracks.map((t) => t.path.toLowerCase())).size === lib.tracks.length);

  // --- Import a folder from another location, with only nested music (test 3).
  const r3 = await locallib.addLibraryFolders([other]);
  check("second location imports with its music-bearing subfolder", r3.added.map((f) => f.name).sort().join(",") === "Country,Downloads", JSON.stringify(r3.added.map((f) => f.name)));
  lib = await locallib.scanLibrary(true);
  check("second location's nested track is in the index", lib.tracks.length === 7, `got ${lib.tracks.length}`);

  // --- Re-import / overlap dedup (tests 7, 8).
  const r4 = await locallib.addLibraryFolders([standalone]);
  check("re-importing the same folder adds nothing", r4.added.length === 0, JSON.stringify(r4.added));
  const r5 = await locallib.addLibraryFolders([path.join(root, "English")]);
  check("importing a child of an imported parent pins only its own subfolder", r5.added.length === 1 && r5.added[0].name === "Pop", JSON.stringify(r5.added.map((f) => f.name)));
  lib = await locallib.scanLibrary(true);
  check("no duplicates after re-import and overlap", lib.tracks.length === 7 && new Set(lib.tracks.map((t) => t.path.toLowerCase())).size === 7, `got ${lib.tracks.length}`);

  // --- Rename is metadata-only (test 5).
  const english = lib.folders.find((f) => f.name === "English");
  await locallib.renameLibraryFolder(english.path, "My English");
  check("custom display name stored", locallib.readLocalLibrary().folders.find((f) => f.path === english.path)?.displayName === "My English");
  check("physical folder name untouched by rename", fs.readdirSync(root).includes("English"));

  // --- Playback path resolution (test 9).
  lib = locallib.readLocalLibrary();
  check("index holds the expected 7 tracks before playback checks", lib.tracks.length === 7, `got ${lib.tracks.length}`);
  const unresolvable = lib.tracks.filter((t) => {
    const p = locallib.localStreamPath(t.id);
    return !p || !fs.existsSync(p);
  });
  check("every track resolves to an existing playback path", unresolvable.length === 0, JSON.stringify(unresolvable.map((t) => t.title)));
  check("unknown ids resolve to nothing", locallib.localStreamPath("local:does-not-exist") === null);

  // --- Folder statuses (test 10 — available state).
  const statuses = locallib.folderStatuses();
  check("statuses cover every folder and report them available", statuses.length === lib.folders.length && statuses.every((s) => s.exists));

  // --- Per-collection scoping (the view's prefix rule against real data).
  check("English collection scopes 3 songs (incl. Pop)", countUnder(lib, path.join(root, "English")) === 3, `got ${countUnder(lib, path.join(root, "English"))}`);
  check("parent collection scopes everything under it", countUnder(lib, root) === 5, `got ${countUnder(lib, root)}`);
  check("standalone collection scopes its own song", countUnder(lib, standalone) === 1, `got ${countUnder(lib, standalone)}`);
}

async function phase2() {
  const base = process.env.LQA_BASE;
  const root = path.join(base, "Music");
  const standalone = path.join(base, "Workout Music");

  // --- Persistence across a real app restart (test 4).
  let lib = locallib.readLocalLibrary();
  check("all imported folders survive the restart", sortedNames(lib) === "Country,Downloads,English,Hindi,Music,Pop,Telugu,Workout Music", sortedNames(lib));
  check("rename metadata survives the restart", lib.folders.find((f) => f.name === "English")?.displayName === "My English");
  check("track index survives the restart", lib.tracks.length === 7, `got ${lib.tracks.length}`);

  // --- Remove: ByTune's index only, disk untouched (test 6).
  lib = await locallib.removeLibraryFolder(standalone);
  check("removed folder no longer listed", !lib.folders.some((f) => f.path === standalone));
  check("its tracks left the index", lib.tracks.length === 6 && !lib.tracks.some((t) => isUnder(t.path, standalone)), `got ${lib.tracks.length}`);
  check("its files still exist on disk", fs.existsSync(path.join(standalone, "Alpha.wav")));

  // --- Moved/deleted folder degrades gracefully (test 10). The move target
  // sits OUTSIDE every imported root — a move within the tree is still
  // covered by the parent and must keep its tracks.
  const telugu = lib.folders.find((f) => f.name === "Telugu");
  const movedTo = path.join(base, "Telugu-moved-away");
  fs.renameSync(telugu.path, movedTo);
  const statuses = locallib.folderStatuses();
  check("moved folder is reported missing, others available", statuses.find((s) => s.path === telugu.path)?.exists === false && statuses.filter((s) => s.path !== telugu.path).every((s) => s.exists));
  lib = await locallib.scanLibrary(true);
  check("rescan with a moved folder survives and drops its now-unreachable tracks", lib.tracks.length === 5 && !lib.tracks.some((t) => isUnder(t.path, telugu.path)), `got ${lib.tracks.length}`);
  fs.renameSync(movedTo, telugu.path);
  lib = await locallib.removeLibraryFolder(telugu.path);
  check("a missing folder can still be removed from ByTune", !lib.folders.some((f) => f.name === "Telugu"));

  // --- Removing a parent keeps songs covered by remaining roots (test 8 contd).
  const rootEntry = lib.folders.find((f) => f.name === "Music");
  lib = await locallib.removeLibraryFolder(rootEntry.path);
  const english = lib.folders.find((f) => f.name === "English");
  const hindi = lib.folders.find((f) => f.name === "Hindi");
  const pop = lib.folders.find((f) => f.name === "Pop");
  check("parent removal keeps child collections + their tracks", !!hindi && !!english && !!pop && countUnder(lib, english.path) === 3 && countUnder(lib, hindi.path) === 1, `folders=${sortedNames(lib)} tracks=${lib.tracks.length}`);
  check("parent removal drops nothing the children still cover", lib.tracks.length === 5, `got ${lib.tracks.length}`);
  check("disk tree untouched by removals", fs.existsSync(path.join(root, "English", "Pop", "PopSong.wav")));
  lib = await locallib.removeLibraryFolder(english.path);
  check("removing a collection drops exactly its uncovered tracks (Pop keeps PopSong)", lib.tracks.length === 3 && lib.tracks.some((t) => t.path.endsWith("PopSong.wav")) && !lib.tracks.some((t) => t.path.endsWith("Song1.wav")), `got ${lib.tracks.length}`);
  check("disk files still exist after every removal", fs.existsSync(path.join(root, "English", "Song1.wav")) && fs.readdirSync(root).includes("English"));
}

app.setPath("userData", process.env.LQA_USERDATA);
app.whenReady().then(async () => {
  try {
    if (process.env.LQA_PHASE === "1") await phase1();
    else await phase2();
  } catch (err) {
    failures++;
    console.log(`FAIL — harness error: ${err && err.stack ? err.stack : err}`);
  }
  console.log(failures === 0 ? "[lqa] ALL PASS" : `[lqa] ${failures} FAILURE(S)`);
  app.exit(failures === 0 ? 0 : 1);
});
