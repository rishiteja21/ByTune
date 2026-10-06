/**
 * Generates the ByTune app icons from src/assets/brand/bytune-logo.svg
 * (white on transparent):
 *   build/icon.png  — 512x512 master used for the runtime window/Dock icon
 *   build/icon.ico  — Windows size ladder 16-256: BMP entries up to 128,
 *                     PNG-compressed 256 (the only size the ICO spec allows
 *                     as PNG)
 *   build/icon.icns — macOS size ladder 16-1024 incl. Retina @2x variants,
 *                     PNG-based (what iconutil itself emits)
 * Windows surfaces (Start menu previews, taskbar, UAC, the NSIS installer)
 * each request one specific size; the ico must carry that size natively or
 * the requester scales whatever closest entry it finds, which is what blurs
 * large previews when only a single 256px image is present.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
mkdirSync(buildDir, { recursive: true });

const svg = readFileSync(join(root, "src", "assets", "brand", "bytune-logo.svg"), "utf8");

/* ---------- render the mark centered on a square transparent canvas ---------- */

const squareCache = new Map();
function renderSquare(size) {
  const cached = squareCache.get(size);
  if (cached) return cached;

  // The source SVG is ~0.85:1. Fit it to the full canvas height and center it
  // horizontally so the mark fills the square icon canvas.
  const resvg = new Resvg(svg, {
    fitTo: { mode: "height", value: size },
    background: "rgba(0,0,0,0)",
    // Pure-path artwork, no <text>: skipping the system font scan keeps a
    // dozen per-size renders from each paying for a full font database.
    font: { loadSystemFonts: false },
  });
  const rendered = resvg.render();
  const srcW = rendered.width;
  const srcH = rendered.height;
  if (srcH !== size) throw new Error(`expected height ${size}, got ${srcH}`);

  // Read the pixel buffer once: `rendered.pixels` is a copying getter, so
  // touching it per-pixel in the loop below re-copies the whole image and
  // exhausts memory.
  const srcPixels = rendered.pixels; // RGBA, width*height*4
  const rgba = Buffer.alloc(size * size * 4);
  const xOff = Math.floor((size - srcW) / 2);
  for (let y = 0; y < srcH; y++) {
    const srcRow = y * srcW * 4;
    const dstRow = y * size * 4;
    for (let x = 0; x < srcW; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + (x + xOff) * 4;
      rgba[di] = srcPixels[si];
      rgba[di + 1] = srcPixels[si + 1];
      rgba[di + 2] = srcPixels[si + 2];
      rgba[di + 3] = srcPixels[si + 3];
    }
  }
  squareCache.set(size, rgba);
  return rgba;
}

/* ---------- PNG encoding ---------- */

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 8;
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

/* ---------- ICO: BMP entries (bottom-up BGRA + AND mask) ---------- */

function bmpEntry(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4; // 1bpp rows padded to 32 bits
  const xorSize = size * size * 4;
  const maskSize = maskRow * size;

  const header = Buffer.alloc(40); // BITMAPINFOHEADER
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND stacked
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xorSize + maskSize, 20);

  const body = Buffer.alloc(xorSize + maskSize);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      body[di] = rgba[si + 2]; // B
      body[di + 1] = rgba[si + 1]; // G
      body[di + 2] = rgba[si]; // R
      body[di + 3] = rgba[si + 3]; // A
    }
  }
  // The AND mask stays all-zero: with 32bpp the alpha channel governs, and a
  // zero mask means "opaque" so alpha is never overridden.
  return Buffer.concat([header, body]);
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256];

function buildICO() {
  const images = ICO_SIZES.map((size) => {
    const rgba = renderSquare(size);
    // PNG compression is only spec-sanctioned for the 256 entry; smaller ones
    // must be BMP so every legacy consumer can decode them.
    return size === 256 ? encodePNG(size, size, rgba) : bmpEntry(size, rgba);
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(ICO_SIZES.length, 4);

  const entries = [];
  let offset = 6 + ICO_SIZES.length * 16;
  ICO_SIZES.forEach((size, i) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // 0 encodes 256
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(images[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[i].length;
    entries.push(entry);
  });

  return Buffer.concat([header, ...entries, ...images]);
}

/* ---------- ICNS: PNG chunks, incl. Retina @2x variants ---------- */

const ICNS_TYPES = [
  ["icp4", 16], // 16x16
  ["icp5", 32], // 32x32
  ["ic07", 128], // 128x128
  ["ic08", 256], // 256x256
  ["ic09", 512], // 512x512
  ["ic10", 1024], // 512x512@2x
  ["ic11", 32], // 16x16@2x
  ["ic12", 64], // 32x32@2x
  ["ic13", 256], // 128x128@2x
  ["ic14", 512], // 256x256@2x
];

function buildICNS() {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const data = encodePNG(size, size, renderSquare(size));
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

/* ---------- outputs ---------- */

writeFileSync(join(buildDir, "icon.png"), encodePNG(512, 512, renderSquare(512)));
writeFileSync(join(buildDir, "icon.ico"), buildICO());
writeFileSync(join(buildDir, "icon.icns"), buildICNS());

console.log(
  "Wrote build/icon.png (512), build/icon.ico (sizes " + ICO_SIZES.join(", ") + ") and build/icon.icns (16-1024)"
);
