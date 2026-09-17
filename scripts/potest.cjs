/* End-to-end PO token + stream test, run with: npx electron scripts/potest.cjs */
const { app, BrowserWindow } = require("electron");
const path = require("path");

/* eslint-disable no-console */

app.whenReady().then(async () => {
  try {
    const { Innertube } = await import("youtubei.js");
    const { getChallenge } = await import("bgutils-js/botguard");
    const { buildURL, GOOG_API_KEY } = await import("bgutils-js/utils");

    console.log("[t] bootstrap session…");
    const bootstrap = await Innertube.create({ retrieve_player: false, enable_session_cache: false });
    const visitorData = bootstrap?.session?.context?.client?.visitorData;
    console.log("[t] visitorData:", visitorData ? visitorData.slice(0, 16) + "…" : "MISSING");

    console.log("[t] fetching BotGuard challenge…");
    const challenge = await getChallenge({
      requestKey: "O43z0dpjhgX20SCx4KAOFmK23sKtA0c9",
      fetchFunction: fetch,
      useYouTubeAPI: true,
    });
    console.log(
      "[t] challenge: globalName=",
      challenge.globalName,
      "| program len:",
      challenge.program?.length,
      "| interpreter:",
      challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue ? "inline" : "url"
    );

    const itRes = await fetch(buildURL("GenerateIntegrityToken"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json+protobuf",
        "x-goog-api-key": GOOG_API_KEY,
        "x-user-agent": "grpc-web-javascript/0.1",
      },
      body: "[]",
    });
    const itData = await itRes.json();
    console.log("[t] integrity token:", itData?.integrityToken ? `ok (${itData.integrityToken.length} chars)` : JSON.stringify(itData).slice(0, 120));

    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadFile(path.join(__dirname, "..", "dist-electron", "po.html"));
    const args = JSON.stringify({ challenge, integrityTokenData: itData, visitorData });
    const result = await win.webContents.executeJavaScript(
      `(async () => { const { challenge, integrityTokenData, visitorData } = ${args}; return window.__bytuneMint(challenge, integrityTokenData, visitorData); })()`
    );
    console.log("[t] minted PO token:", result?.poToken ? `${result.poToken.slice(0, 20)}… (len ${result.poToken.length})` : "FAILED");

    console.log("[t] creating InnerTube session with PO token…");
    const yt = await Innertube.create({ enable_session_cache: false, visitor_data: visitorData, po_token: result.poToken });

    for (const client of ["WEB", "MUSIC", "IOS"]) {
      const info = await yt.getBasicInfo("1-V7b70sCzQ", { client });
      const audio = (info?.streaming_data?.adaptive_formats ?? []).filter((f) => f?.has_audio && !f?.has_video);
      const withUrl = audio.filter((f) => typeof f.url === "string" && f.url);
      let probe = "no url";
      if (withUrl.length) {
        const f = withUrl.find((x) => String(x.mime_type ?? "").includes("mp4")) ?? withUrl[0];
        const res = await fetch(f.url, { headers: { Range: "bytes=0-1" } });
        try { await res.arrayBuffer(); } catch {}
        probe = `HTTP ${res.status} ${String(f.mime_type ?? "").slice(0, 12)} ${Math.round((f.bitrate ?? 0) / 1000)}kbps`;
      }
      console.log(`[t] stream ${client.padEnd(6)} audio:${audio.length} withUrl:${withUrl.length} | ${probe}`);
    }
    console.log("TEST DONE");
  } catch (err) {
    console.error("[t] FATAL:", err?.message ?? err);
  } finally {
    app.exit(0);
  }
});
