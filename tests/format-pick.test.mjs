import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAudio, formatLufs } from "../.test-build/audio-format.mjs";

/* Format fixtures mirror the live youtubei.js v18 responses captured by
 * .lufs-probe.cjs for "Shape of You" (VISIONOS client): every format carries
 * loudnessDb=6.35 / track_absolute_loudness_lkfs=-7.65. */
const mk = (itag, mime, bitrate, extra = {}) => ({
  itag,
  mime_type: mime,
  bitrate,
  has_audio: true,
  has_video: false,
  url: `https://example/${itag}`,
  loudness_db: 6.35,
  track_absolute_loudness_lkfs: -7.65,
  ...extra,
});

const VISIONOS_SET = {
  streaming_data: {
    adaptive_formats: [
      mk(139, 'audio/mp4; codecs="mp4a.40.5"', 50213),
      mk(140, 'audio/mp4; codecs="mp4a.40.2"', 130613),
      mk(249, 'audio/webm; codecs="opus"', 60224),
      mk(250, 'audio/webm; codecs="opus"', 78320),
      mk(251, 'audio/webm; codecs="opus"', 151105),
    ],
  },
};

test("streaming picks Opus 251, not the mp4/AAC downgrade", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, undefined, false);
  assert.equal(picked.url, "https://example/251");
  assert.match(picked.mime, /webm/);
  assert.equal(picked.lufs, -7.65);
});

test("downloads keep mp4/AAC for portability", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, undefined, true);
  assert.equal(picked.url, "https://example/140");
  assert.match(picked.mime, /mp4/);
});

test("256k AAC (141) outranks Opus 251 when present", async () => {
  const info = {
    streaming_data: {
      adaptive_formats: [...VISIONOS_SET.streaming_data.adaptive_formats, mk(141, 'audio/mp4; codecs="mp4a.40.2"', 256000)],
    },
  };
  const stream = await pickAudio(info, {}, undefined, false);
  assert.equal(stream.url, "https://example/141");
  const download = await pickAudio(info, {}, undefined, true);
  assert.equal(download.url, "https://example/141");
});

test("low-quality ceiling picks Opus 249 over HE-AAC 139", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, 64, false);
  assert.equal(picked.url, "https://example/249");
});

test("ceiling with no under-cap format still streams the best", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, 10, false);
  assert.equal(picked.url, "https://example/251");
});

test("mp4Only falls back to best overall when no mp4 exists", async () => {
  const info = {
    streaming_data: {
      adaptive_formats: [mk(249, 'audio/webm; codecs="opus"', 60224), mk(251, 'audio/webm; codecs="opus"', 151105)],
    },
  };
  const picked = await pickAudio(info, {}, undefined, true);
  assert.equal(picked.url, "https://example/251");
});

test("unknown itags order by raw bitrate", async () => {
  const info = {
    streaming_data: {
      adaptive_formats: [
        mk(998, 'audio/webm; codecs="opus"', 90000),
        mk(999, 'audio/webm; codecs="opus"', 200000),
      ],
    },
  };
  const picked = await pickAudio(info, {}, undefined, false);
  assert.equal(picked.url, "https://example/999");
});

test("formatLufs prefers absolute LKFS, derives it from loudnessDb, else null", () => {
  assert.equal(formatLufs({ track_absolute_loudness_lkfs: -10.66, loudness_db: 3.34 }), -10.66);
  assert.equal(formatLufs({ loudness_db: 3.34 }), 3.34 - 14);
  assert.equal(formatLufs({}), null);
  assert.equal(formatLufs({ track_absolute_loudness_lkfs: "x", loudness_db: null }), null);
});

test("progressive-only streams still resolve", async () => {
  const info = { streaming_data: { formats: [mk(140, 'audio/mp4; codecs="mp4a.40.2"', 130613)] } };
  const picked = await pickAudio(info, {}, undefined, false);
  assert.equal(picked.url, "https://example/140");
});
