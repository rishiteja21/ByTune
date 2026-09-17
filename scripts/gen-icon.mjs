/**
 * Generates the ByTune app icon: rasterizes src/assets/brand/bytune-logo.svg
 * (white on transparent) to 1024x1024, then writes build/icon.png (512)
 * and build/icon.ico (256, PNG-compressed).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
mkdirSync(buildDir, { recursive: true });

const W = 1024;
const H = 1024;

const svg = readFileSync(join(root, "src", "assets", "brand", "bytune-logo.svg"), "utf8");

// The source SVG is 4096x4803 (~0.85:1). Fit it to the full height and
// center it horizontally so the mark fills the square icon canvas.
const resvg = new Resvg(svg, {
  fitTo: { mode: "height", value: H },
  background: "rgba(0,0,0,0)",
});
const rendered = resvg.render();
const srcW = rendered.width;
const srcH = rendered.height;
const srcPixels = rendered.pixels; // RGBA, width*height*4
if (srcH !== H) throw new Error(`expected height ${H}, got ${srcH}`);

/* ---------- compose onto a square transparent canvas ---------- */

const rgba = Buffer.alloc(W * H * 4);
const xOff = Math.floor((W - srcW) / 2);
for (let y = 0; y < srcH; y++) {
  const srcRow = y * srcW * 4;
  const dstRow = y * W * 4;
  for (let x = 0; x < srcW; x++) {
    const si = srcRow + x * 4;
    const di = dstRow + (x + xOff) * 4;
    rgba[di] = srcPixels[si];
    rgba[di + 1] = srcPixels[si + 1];
    rgba[di + 2] = srcPixels[si + 2];
    rgba[di + 3] = srcPixels[si + 3];
  }
}

/* ---------- PNG encoding ---------- */

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
      // Alpha-weighted average: divide the accumulated color*alpha sums by
      // the accumulated alpha itself (not a sample count) so straight-alpha
      // colors survive — dividing by a count here yields 255*color and
      // wraps white down to near-black.
      out[oi] = aSum > 0 ? Math.round(r / aSum) : 0;
      out[oi + 1] = aSum > 0 ? Math.round(g / aSum) : 0;
      out[oi + 2] = aSum > 0 ? Math.round(b / aSum) : 0;
      out[oi + 3] = Math.round(aSum / n);
    }
  }
  return out;
}

/* ---------- outputs ---------- */

const png512 = encodePNG(512, 512, downsample(rgba, W, 512));
writeFileSync(join(buildDir, "icon.png"), png512);

const png256 = encodePNG(256, 256, downsample(rgba, W, 256));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count

const entry = Buffer.alloc(16);
entry[0] = 0; // width 256
entry[1] = 0; // height 256
entry[2] = 0; // palette
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(22, 12); // data offset

writeFileSync(join(buildDir, "icon.ico"), Buffer.concat([header, entry, png256]));

console.log("Wrote build/icon.png (512x512) and build/icon.ico (256x256)");
