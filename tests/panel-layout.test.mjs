import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/panelLayout.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const {
  CONTENT_MIN_WIDTH, DEFAULT_PANEL_WIDTHS, PANEL_DIVIDER_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH,
  fitPanelWidths, panelMaxWidth, readPanelWidths, resizePanel,
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

test("missing, partial and damaged saves recover independently for each panel", () => {
  for (const raw of [null, undefined, false, "328", {}, []]) {
    assert.deepEqual(readPanelWidths(raw), DEFAULT_PANEL_WIDTHS);
  }
  assert.deepEqual(readPanelWidths({ library: 400 }), { library: 400, nowPlaying: 328 });
  assert.deepEqual(readPanelWidths({ library: NaN, nowPlaying: Infinity }), DEFAULT_PANEL_WIDTHS);
  assert.deepEqual(readPanelWidths({ library: "400", nowPlaying: 350.6 }), { library: 328, nowPlaying: 351 });
  assert.deepEqual(readPanelWidths({ library: -50, nowPlaying: 2000 }), { library: 240, nowPlaying: 480 });
});

test("the default window keeps the existing widths, and a smaller window keeps content usable", () => {
  assert.deepEqual(fitPanelWidths(DEFAULT_PANEL_WIDTHS, 1280 - 16), DEFAULT_PANEL_WIDTHS);
  const narrow = fitPanelWidths(DEFAULT_PANEL_WIDTHS, 1000 - 16);
  assert.deepEqual(narrow, { library: 244, nowPlaying: 244 });
  assert.equal(984 - narrow.library - narrow.nowPlaying - 2 * PANEL_DIVIDER_WIDTH, CONTENT_MIN_WIDTH);
  assert.deepEqual(DEFAULT_PANEL_WIDTHS, { library: 328, nowPlaying: 328 }, "fitting doesn't overwrite preferences");
});

test("window fitting respects both panel limits and the content minimum across supported sizes", () => {
  for (const width of [984, 1000, 1100, 1264, 1440, 1920]) {
    for (const library of [240, 328, 400, 480]) {
      for (const nowPlaying of [240, 328, 400, 480]) {
        const fitted = fitPanelWidths({ library, nowPlaying }, width);
        for (const value of Object.values(fitted)) {
          assert.ok(Number.isInteger(value) && value >= PANEL_MIN_WIDTH && value <= PANEL_MAX_WIDTH);
        }
        assert.ok(width - fitted.library - fitted.nowPlaying - 2 * PANEL_DIVIDER_WIDTH >= CONTENT_MIN_WIDTH);
        assert.ok(fitted.library <= library && fitted.nowPlaying <= nowPlaying, "a resize never grows a panel beyond its preference");
      }
    }
  }
});

test("dragging either divider stops at its limits without moving the opposite panel", () => {
  const start = { library: 328, nowPlaying: 400 };
  for (const panel of ["library", "nowPlaying"]) {
    const other = panel === "library" ? "nowPlaying" : "library";
    const largest = resizePanel(start, panel, 5000, 1264);
    assert.equal(largest[panel], panelMaxWidth(panel, start, 1264));
    assert.equal(largest[other], start[other]);
    assert.equal(1264 - largest.library - largest.nowPlaying - 16, CONTENT_MIN_WIDTH);
    const smallest = resizePanel(start, panel, -500, 1264);
    assert.equal(smallest[panel], PANEL_MIN_WIDTH);
    assert.equal(smallest[other], start[other]);
    assert.equal(resizePanel(start, panel, 5000, 1920)[panel], PANEL_MAX_WIDTH);
  }
});

test("a drag after the window shrinks starts from the fitted layout and cannot restore oversized panels", () => {
  const saved = { library: 480, nowPlaying: 480 };
  assert.deepEqual(resizePanel(saved, "library", 400, 984), { library: 244, nowPlaying: 244 });
  assert.deepEqual(fitPanelWidths(saved, 1920), saved, "growing the window can recover saved preferences");
  for (const width of [0, 300, NaN]) {
    assert.deepEqual(fitPanelWidths(saved, width), { library: 240, nowPlaying: 240 }, "unmeasurable containers stay finite");
  }
});
