/**
 * Generates the Windows taskbar thumbbar glyphs (previous / play / pause /
 * next): white on transparent, Spotify-style, rasterized from small SVGs and
 * written to electron/assets/thumbar/<name>-{16,32}.png. The 32px copies ride
 * along as 2x representations so the glyphs stay crisp on high-DPI taskbars.
 *
 * Run manually: node scripts/gen-thumbar-icons.mjs
 * (The generated PNGs are committed; this script only needs re-running when
 * the glyph geometry changes.)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "electron", "assets", "thumbar");
mkdirSync(outDir, { recursive: true });

// Shapes on a 256 viewBox: solid white fills with round joins so corners
// read smoothly at 16px. Spans are chosen so each glyph sits centered.
const GLYPHS = {
  previous: `
    <rect x="36" y="44" width="30" height="168" rx="10"/>
    <path d="M208 52 L208 204 L96 128 Z"/>`,
  play: `
    <path d="M66 46 L66 210 L200 128 Z"/>`,
  pause: `
    <rect x="62" y="44" width="46" height="168" rx="12"/>
    <rect x="148" y="44" width="46" height="168" rx="12"/>`,
  next: `
    <rect x="190" y="44" width="30" height="168" rx="10"/>
    <path d="M48 52 L48 204 L160 128 Z"/>`,
};

const RENDER = 512; // supersample canvas before downsampling to 32 / 16
const STROKE = 18; // round joins soften every corner of the filled shapes

function svgFor(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <g fill="#ffffff" stroke="#ffffff" stroke-width="${STROKE}"
       stroke-linejoin="round" stroke-linecap="round">${shape}</g>
  </svg>`;
}

/* ---------- PNG encoding (same minimal encoder as gen-icon.mjs) ---------- */

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function downsample(src, srcW, dstW) {
  const factor = srcW / dstW;
  const out = Buffer.alloc(dstW * dstW * 4);
  for (let dy = 0; dy < dstW; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let aSum = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const si = ((dy * factor + sy) * srcW + (dx * factor + sx)) * 4;
          const sa = src[si + 3];
          r += src[si] * sa;
          g += src[si + 1] * sa;
          b += src[si + 2] * sa;
          aSum += sa;
        }
      }
      const n = factor * factor;
      const oi = (dy * dstW + dx) * 4;
      // Alpha-weighted average (see gen-icon.mjs): dividing by accumulated
      // alpha, not sample count, keeps straight-alpha white from darkening.
      out[oi] = aSum > 0 ? Math.round(r / aSum) : 0;
      out[oi + 1] = aSum > 0 ? Math.round(g / aSum) : 0;
      out[oi + 2] = aSum > 0 ? Math.round(b / aSum) : 0;
      out[oi + 3] = Math.round(aSum / n);
    }
  }
  return out;
}

/* ---------- render + write ---------- */

for (const [name, shape] of Object.entries(GLYPHS)) {
  const resvg = new Resvg(svgFor(shape), {
    fitTo: { mode: "width", value: RENDER },
    background: "rgba(0,0,0,0)",
  });
  const rendered = resvg.render();
  if (rendered.width !== RENDER) throw new Error(`${name}: rendered ${rendered.width}px`);
  const big = Buffer.from(rendered.pixels);
  writeFileSync(join(outDir, `${name}-32.png`), encodePNG(32, 32, downsample(big, RENDER, 32)));
  writeFileSync(join(outDir, `${name}-16.png`), encodePNG(16, 16, downsample(big, RENDER, 16)));
  console.log(`Wrote ${name}-16.png and ${name}-32.png`);
}
console.log(`Thumbar glyphs written to ${outDir}`);
