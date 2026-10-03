/**
 * Charts parsing against a REAL YouTube Music payload. The fixture is a
 * trimmed FEmusic_charts response captured from the live provider (scripts/
 * probe-market.mjs) — the parser must extract the provider's own market
 * ranking without inventing or dropping content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseChartsShelves } from "../.test-build/ytm.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/charts-page.json", import.meta.url), "utf8"));

test("charts page yields the provider's ranking shelves", () => {
  const shelves = parseChartsShelves(raw);
  assert.ok(shelves.length >= 1, "at least one chart shelf parses");
  const artists = shelves.find((s) => s.title.toLowerCase().includes("artist"));
  assert.ok(artists, "the Top artists chart parses");
  assert.ok(artists.items.length >= 3, "artist chart carries a real ranking");
  assert.ok(
    artists.items.every((i) => i.kind === "artist" && i.artist.id && i.artist.name && i.artist.thumb),
    "every chart card is a fully-formed artist item"
  );
});

test("chart rows carry real names from the provider, in rank order", () => {
  const shelves = parseChartsShelves(raw);
  const artists = shelves.find((s) => s.title.toLowerCase().includes("artist"));
  const names = artists.items.map((i) => i.artist.name);
  assert.ok(names.includes("Alka Yagnik"), "chart leader present (fixture captured from IN market)");
  assert.equal(names[0], "Alka Yagnik", "rank 1 stays rank 1 — no reordering");
});

test("video-only chart shelves are excluded, not broken", () => {
  // The fixture's video charts rows are widescreen uploads — they must not
  // appear as music tracks in the feed (playback-sync rule).
  const shelves = parseChartsShelves(raw);
  for (const shelf of shelves) {
    for (const item of shelf.items) {
      if (item.kind === "track") {
        assert.ok(item.track.id, "track items keep their playable id");
        assert.ok(!/video/i.test(item.track.title) || !item.track.title.match(/trending|top 100/i), "no raw video-chart rows leak in as tracks");
      }
    }
  }
});
