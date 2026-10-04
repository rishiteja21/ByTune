import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PipApp } from "./pip/PipApp";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./lib/platform";
import "./index.css";

/**
 * One bundle, two windows: the main app shell, and — when this renderer was
 * loaded with ?window=pip — the compact native miniplayer. The PiP window
 * renders no app shell and boots no audio engine; it is a pure view onto the
 * main window's playback state (see src/pip/).
 */
const isPipWindow = new URLSearchParams(window.location.search).get("window") === "pip";

ReactDOM.createRoot(document.getElementById("root")!).render(
  isPipWindow ? (
    <ErrorBoundary>
      <PipApp />
    </ErrorBoundary>
  ) : (
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
);
