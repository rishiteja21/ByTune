/* Verify Electron's Node can require jsdom 29 and check versions. */
const { app } = require("electron");
app.whenReady().then(() => {
  try {
    console.log("[v] electron:", process.versions.electron, "| node:", process.versions.node);
    require("jsdom");
    console.log("[v] jsdom require OK");
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM("<html></html>", { url: "https://www.youtube.com/" });
    console.log("[v] JSDOM constructed:", !!dom.window.document);
    console.log("VERSIONS DONE");
  } catch (err) {
    console.log("[v] FAIL:", err.message);
  } finally {
    app.exit(0);
  }
});
