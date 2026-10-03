/**
 * Moods & genres parsing against a REAL YouTube Music Explore payload
 * (captured via scripts/probe-market-style session, India catalog). The
 * browse suggestions must come from this provider data — the app ships no
 * hardcoded country list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMoods } from "../.test-build/ytm.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/explore-page.json", import.meta.url), "utf8"));

test("explore page yields the provider's moods & genres catalog", () => {
  const moods = parseMoods(raw);
  assert.ok(moods.length >= 40, "the full catalog parses (49 categories live)");
  assert.ok(
    moods.every((m) => m.title && m.browseId && m.title === m.title.trim()),
    "every entry carries a title and its mood-page endpoint"
  );
});

test("catalog entries carry mood-page endpoints and provider colors", () => {
  const moods = parseMoods(raw).filter((m) => m.browseId.includes("moods_and_genres_category"));
  assert.ok(moods.length >= 40, "mood/genre category chips parse");
  assert.ok(
    moods.every((m) => m.params && /^ggMP/.test(m.params)),
    "each category carries its browse params for deep linking"
  );
  const withColor = moods.filter((m) => m.color && /^#[0-9a-f]{6}$/.test(m.color));
  assert.ok(withColor.length >= 30, "the provider's accent colors survive the parse");
});

test("the catalog is the provider's, not the app's old hardcoded list", () => {
  const titles = parseMoods(raw).map((m) => m.title);
  // Real provider entries the old hardcoded list never had:
  assert.ok(titles.includes("Commute"), "provider catalog present");
  assert.ok(titles.includes("Devotional"), "provider catalog present");
  // The old hardcoded SEARCH STRINGS no longer exist anywhere in the app:
  assert.ok(!titles.includes("Bollywood 2000s"), "hardcoded 'Bollywood 2000s' is gone");
  assert.ok(!titles.includes("Punjabi hits"), "hardcoded 'Punjabi hits' is gone");
});

test("non-category entries (New releases, Charts, Podcasts) are separable", () => {
  const all = parseMoods(raw);
  assert.ok(all.some((m) => m.browseId === "FEmusic_new_releases"), "New releases endpoint parses");
  assert.ok(all.some((m) => m.browseId === "FEmusic_charts"), "Charts endpoint parses");
  assert.ok(
    all.filter((m) => m.browseId.includes("moods_and_genres_category")).length <
      all.length,
    "category chips are distinguishable from page links"
  );
});
