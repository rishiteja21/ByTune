/** GUI-qa fixture: a small organized tree with real (tone) WAVs to import by hand. */
const fs = require("fs");
const path = require("path");

function writeWav(file, seconds = 36) {
  const rate = 8000;
  const frames = rate * seconds;
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

const base = process.argv[2];
writeWav(path.join(base, "Music", "English", "Song1.wav"));
writeWav(path.join(base, "Music", "English", "Song2.wav"));
writeWav(path.join(base, "Music", "English", "Pop", "PopSong.wav"));
writeWav(path.join(base, "Music", "Hindi", "Song3.wav"));
writeWav(path.join(base, "Music", "Recordings", "voice-recording.wav"));
writeWav(path.join(base, "Workout Music", "Alpha.wav"));
console.log("fixture ready at", base);
