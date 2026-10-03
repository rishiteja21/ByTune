/**
 * One-off live probe (dev tooling, not shipped): verifies against the REAL
 * InnerTube provider that (a) the session `gl` changes what the YTM home feed
 * returns, and (b) the FEmusic_charts browse carries the carousel shape the
 * feed's chart parser expects. Writes a trimmed charts fixture for unit tests.
 *
 * Run: node scripts/probe-market.mjs IN US
 */
import { Innertube } from "youtubei.js";
import * as fs from "node:fs";

const collect = (root, name, out = []) => {
  const visit = (node) => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach(visit);
    if (node[name] && typeof node[name] === "object") out.push(node[name]);
    for (const v of Object.values(node)) if (v && typeof v === "object") visit(v);
  };
  visit(root);
  return out;
};
const runs = (v) =>
  typeof v === "string" ? v : Array.isArray(v?.runs) ? v.runs.map((r) => r?.text ?? "").join("") : "";

async function probe(location) {
  const yt = await Innertube.create({
    retrieve_player: false,
    enable_session_cache: false,
    location,
    lang: "en",
  });
  const gl = yt.session.context.client.gl;
  const hl = yt.session.context.client.hl;
  const feed = await yt.music.getHomeFeed();
  const shelves = (feed.sections ?? []).slice(0, 6).map((s) => {
    const title = runs(s?.header?.title) || runs(s?.title) || "?";
    const items = (s?.contents ?? []).slice(0, 3).map((i) => runs(i?.title) || runs(i?.header?.title) || "?");
    return `${title}: ${items.join(" | ")}`;
  });
  const res = await yt.actions.execute("browse", { browseId: "FEmusic_charts", client: "YTMUSIC" });
  const data = res?.data ?? null;
  const carousels = collect(data, "musicCarouselShelfRenderer");
  const chartShelves = carousels.map((c) => {
    const title = runs(c?.header?.musicCarouselShelfBasicHeaderRenderer?.title) || "?";
    const rows = (c?.contents ?? []).slice(0, 3).map((n) => {
      const r = n?.musicResponsiveListItemRenderer ?? n?.musicTwoRowItemRenderer;
      if (!r) return null;
      const col = (i) => runs(r?.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text);
      return col(0) || runs(r?.title) || "?";
    });
    return `${title}: ${rows.filter(Boolean).join(" | ")}`;
  });
  return { location, gl, hl, shelves, chartShelves, rawCharts: data };
}

const [a, b] = process.argv.slice(2);
for (const market of [a, b].filter(Boolean)) {
  const p = await probe(market);
  console.log(`\n=== ${p.location} → gl=${p.gl} hl=${p.hl} ===`);
  console.log("HOME FEED:");
  for (const s of p.shelves) console.log("  " + s);
  console.log("CHARTS:");
  for (const s of p.chartShelves) console.log("  " + s);
  if (market === (a ?? b)) {
    fs.mkdirSync(".test-fixtures", { recursive: true });
    fs.writeFileSync(
      `.test-fixtures/charts-${p.location}.json`,
      JSON.stringify(p.rawCharts).slice(0, 400_000)
    );
    console.log(`(fixture saved: .test-fixtures/charts-${p.location}.json)`);
  }
}
