/**
 * GUI-qa launcher: boots the REAL built app (dist-electron/main.js) with
 * appData/userData redirected into a scratch profile, so GUI testing never
 * touches the developer's or user's actual ByTune data.
 *
 *   BYTUNE_GUI_PROFILE=<dir> electron scripts/gui-launcher.cjs
 */
const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const profile = process.env.BYTUNE_GUI_PROFILE;
if (!profile) {
  console.error("[gui-launcher] BYTUNE_GUI_PROFILE not set");
  app.exit(1);
} else {
  // Redirect every writable OS location used by the app before loading it.
  for (const [name, subdir] of Object.entries({
    appData: "", userData: "userdata", sessionData: "session",
    downloads: "downloads", music: "music",
  })) {
    const dir = path.resolve(profile, subdir);
    fs.mkdirSync(dir, { recursive: true });
    app.setPath(name, dir);
  }
  // A scratch profile does not isolate the Windows protocol association.
  // Keep getAppPath unchanged: production assets still belong to the real app.
  app.setAsDefaultProtocolClient = () => false;
  require(path.resolve(process.env.BYTUNE_GUI_MAIN || path.join(__dirname, "..", "dist-electron", "main.js")));
}
