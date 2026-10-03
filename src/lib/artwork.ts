/**
 * Cover quality with a size budget — mirrors `electron/artwork.ts`.
 *
 * Cover URLs carry dynamic resize parameters, so the same photo ID serves any
 * square size. `upgradeArtwork` normalizes every URL to `target` square
 * (default 544 — 2-3× the largest card/circle size, plenty for retina) so
 * lists never pull megabyte-sized originals; surfaces that display big (full-
 * bleed heroes, the Now Playing cover) pass a larger target. Libraries,
 * histories and queues persisted earlier still hold small placeholder URLs
 * (`=w60-h60`, `=s60`, cropped `hqdefault.jpg?sqp=…`) — those heal on sight.
 */

/**
 * Scheme gate for artwork URLs. Thumb strings come from cloud rows and
 * backups (hostile data in a compromised-account / shared-backup scenario);
 * only web image, data, blob and the app's own localart schemes may reach an
 * <img src>. file:/UNC and other schemes collapse to "" — the UI's fallback
 * art takes over. Exported via upgradeArtwork's module for regression tests.
 */
export function artworkUrlOk(url: string): boolean {
  return /^(https?:\/\/|data:image\/|blob:|localart:)/i.test(url);
}

export function upgradeArtwork(url: string | null | undefined, target = 544): string {
  if (!url || typeof url !== "string") return "";
  let out = url.trim();
  if (!out || !artworkUrlOk(out)) return "";

  // Sparse 150px/50px sizes → full 500px art (the largest such rendition).
  out = out.replace(/150x150|50x50/g, "500x500");

  out = out.replace(
    /^(https?:\/\/i\.ytimg\.com\/vi\/[^/?#]+\/)(default|mqdefault|hqdefault|sddefault|hq720)(?:\.jpg)?(?:\?.*)?$/i,
    (_m, pre: string, name: string) =>
      `${pre}${/^(default|mqdefault)$/i.test(name) ? "hqdefault" : name.toLowerCase()}.jpg`
  );

  out = out.replace(/=s\d+/g, `=s${target}`);

  out = out.replace(/=w\d+(-c)?-h\d+/g, `=w${target}$1-h${target}`);

  out = out.replace(/\/w\d+(-c)?-h\d+((?:-[a-z0-9]+)*)\//gi, `/w${target}$1-h${target}$2/`);

  out = out.replace(/\/default\.jpg(?:\?.*)?$/i, "/hqdefault.jpg");

  return out;
}

/**
 * Full-frame rendition for artist-photo headers (the About card).
 *
 * Google-hosted artist photos arrive square-cropped (`=w544-h544-p-l90-rj`),
 * which beheads the wide promotional shot behind it; `=w1200` with no height
 * or smart-crop options is the original upload scaled to width, so the header
 * can show the whole frame and crop with CSS like Spotify does. Anything not
 * Google-hosted just passes through `upgradeArtwork`.
 */
export function wideArtwork(url: string | null | undefined): string {
  const out = upgradeArtwork(url);
  return /^https?:\/\/[^/?#]*googleusercontent\.com\//.test(out) && out.includes("=")
    ? out.replace(/=.*$/, "=w1200")
    : out;
}
