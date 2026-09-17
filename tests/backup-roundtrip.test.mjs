import { test } from "node:test";
import assert from "node:assert/strict";
import {
  envelope,
  searchesFromBackup,
  searchesToBackup,
  settingsFromBackup,
  settingsToBackup,
} from "../.test-build/backup-transfer.mjs";

// The exact bug being guarded against: stores persist as zustand envelopes
// { state, version }; backup transforms must unwrap on export and re-wrap on
// import, or settings and recent searches silently vanish from every backup.

test("settings and recent searches survive export → wipe → import", () => {
  // 1. A live store, in the envelope shape persist writes to disk.
  const settingsEnvelope = envelope({
    downloadDir: "C:\\Music\\ByTune", // device-local: never travels
    downloadQuality: "high",
    streamingQuality: "low",
    crossfadeSeconds: 4,
    smartFade: true,
    liquidGlass: false,
  });
  const recentsEnvelope = envelope({ searches: ["radiohead", "Aphex Twin", "burial"] });

  // 2. Export.
  const doc = {
    settings: settingsToBackup(settingsEnvelope),
    recentSearches: searchesToBackup(recentsEnvelope),
  };
  assert.equal(doc.settings.downloadDir, undefined);
  assert.equal(doc.settings.streamingQuality, "low");
  assert.equal(doc.settings.downloadQuality, "high");
  assert.deepEqual(doc.recentSearches, ["radiohead", "Aphex Twin", "burial"]);

  // 3. Wipe (reset app data): stores go back to empty defaults.
  const wipedSettings = envelope({});
  const wipedSearches = envelope({ searches: [] });

  // 4. Import: rebuild the store states the renderer will hydrate.
  const restoredSettings = settingsFromBackup(doc.settings, wipedSettings);
  const restoredSearches = searchesFromBackup(doc.recentSearches);

  assert.equal(restoredSettings.downloadQuality, "high");
  assert.equal(restoredSettings.streamingQuality, "low");
  assert.equal(restoredSettings.crossfadeSeconds, 4);
  assert.equal(restoredSettings.smartFade, true);
  assert.equal(restoredSettings.liquidGlass, false);
  // Device-local: absent from the backup AND from the wiped store → absent.
  assert.equal("downloadDir" in restoredSettings, false);
  assert.deepEqual(restoredSearches, ["radiohead", "Aphex Twin", "burial"]);

  // 5. The import result must be written as the envelope the store hydrates.
  assert.deepEqual(envelope(restoredSettings), { state: restoredSettings, version: 0 });
  assert.deepEqual(envelope({ searches: restoredSearches }), {
    state: { searches: restoredSearches },
    version: 0,
  });
});

test("import keeps this machine's device-local settings", () => {
  const current = envelope({
    downloadDir: "D:\\Current",
    localMusicFolder: "D:\\Lib",
    streamingQuality: "high",
  });
  const restored = settingsFromBackup(
    envelope({ streamingQuality: "low", downloadDir: "C:\\Old" }),
    current
  );
  assert.equal(restored.downloadDir, "D:\\Current");
  assert.equal(restored.localMusicFolder, "D:\\Lib");
  assert.equal(restored.streamingQuality, "low");
});

test("legacy backup shapes still import", () => {
  // Older exports stored the raw zustand envelope for recent searches (the
  // import used to skip it silently) — it must unwrap now.
  const legacy = envelope({ searches: ["a", "b"] });
  assert.deepEqual(searchesFromBackup(legacy), ["a", "b"]);
  // Old settings were always exported empty — must import as defaults, not crash.
  assert.deepEqual(settingsFromBackup({}, envelope({})), {});
  // A bare non-envelope searches map (defensive) also reads.
  assert.deepEqual(searchesFromBackup({ searches: ["x"] }), ["x"]);
});

test("unknown settings keys never enter the backup or the import", () => {
  const exported = settingsToBackup(envelope({ evilKey: 1, streamingQuality: "high" }));
  assert.deepEqual(exported, { streamingQuality: "high" });
  const imported = settingsFromBackup({ evilKey: 2, autoplay: true }, envelope({}));
  assert.deepEqual(imported, { autoplay: true });
});

test("malformed payloads degrade to empty, never throw", () => {
  assert.deepEqual(settingsToBackup(null), {});
  assert.deepEqual(settingsToBackup("nope"), {});
  assert.deepEqual(searchesToBackup(null), []);
  assert.deepEqual(searchesToBackup(envelope({ searches: "not-an-array" })), []);
  assert.deepEqual(searchesFromBackup(42), []);
  assert.deepEqual(searchesFromBackup({ searches: [1, "ok", null] }), ["ok"]);
  assert.deepEqual(settingsFromBackup(null, null), {});
});
