import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { Dialog } from "./components/primitives";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { prefetchLyrics, LyricsCenter } from "./components/LyricsCenter";
import { NowPlaying } from "./components/NowPlaying";
import { Onboarding } from "./views/OnboardingView";
import { PlayerBar } from "./components/PlayerBar";
import { RightRail } from "./components/RightRail";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { engineBoot } from "./lib/audio";
import { setAmbientFromArtwork } from "./lib/ambient";
import { listenForDownloadProgress } from "./lib/downloads";
import { watchMenuCommands } from "./lib/menuCommands";
import { usePanelDrop } from "./lib/panelDrop";
import { useArtworkPalette } from "./lib/palette";
import { watchSession, useSession } from "./lib/session";
import { watchSyncRestores } from "./lib/syncRestore";
import { takeOnboardingIntent } from "./lib/onboardingIntent";
import { startPipSync } from "./pip/pipSync";
import { usePlayer } from "./stores/player";
import { useLibrary } from "./stores/library";
import { useSettings } from "./stores/settings";
import { useUI } from "./stores/ui";
import { AlbumView } from "./views/AlbumView";
import { ArtistView } from "./views/ArtistView";
import { DownloadsView } from "./views/DownloadsView";
import { ExploreView } from "./views/ExploreView";
import { HomeView } from "./views/HomeView";
import { RemotePlaylistView } from "./views/RemotePlaylistView";
import { LibraryView } from "./views/LibraryView";import { LocalMusicView } from "./views/LocalMusicView";
import { PlaylistView } from "./views/PlaylistView";
import { ReplayView } from "./views/ReplayView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";

/**
 * The middle panel's artwork wash — the morphing gradient at the top of the
 * content pane, on every view except the artist page (its hero carries its
 * own full-bleed artwork treatment). At rest it wears the playing track's
 * colour; hovering any song / album / artist / playlist card borrows that
 * artwork's colour instead (cards feed `tintThumb` via tintHoverHandlers).
 * The colour itself is the ArtworkPalette background, crossfaded by the
 * registered `--home-tint` custom property.
 */
function TintWash() {
  const viewName = useUI((s) => s.view.name);
  const tintThumb = useUI((s) => s.tintThumb);
  const playingThumb = usePlayer((s) => s.queue[s.index]?.thumb ?? null);
  const palette = useArtworkPalette(tintThumb ?? playingThumb);
  const washRef = useRef<HTMLDivElement | null>(null);

  // The colour lives on <main> (not the wash div) so the search filter bar's
  // stuck backdrop reads the same morphing value — see `main` in index.css.
  useEffect(() => {
    washRef.current?.closest("main")?.style.setProperty("--home-tint", `rgb(${palette.elevated})`);
  }, [palette]);

  if (viewName === "artist" || viewName === "settings") return null;
  return <div aria-hidden ref={washRef} className="home-tint pointer-events-none absolute inset-x-0 top-0 h-[332px]" />;
}

function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          const el = document.getElementById("global-search") as HTMLInputElement | null;
          el?.focus();
          el?.select();
        }
        return;
      }
      // Chrome: in plain fullscreen, Escape leaves it — even while a field is
      // focused. (NowPlaying's own Escape path below closes the cinematic
      // view, which takes the fullscreen with it.)
      // A modal dialog is the topmost layer and owns the keyboard (Escape /
      // Enter via its own capture listener); without this guard Space toggled
      // playback behind a confirm dialog, and preventDefault kept the
      // focused Confirm button dead.
      if (useUI.getState().dialog) return;
      if (e.key === "Escape") {
        const ui = useUI.getState();
        // A context menu is the topmost layer and owns Escape: its own
        // listener folds the submenu first, then dismisses the menu. Without
        // this guard the same keystroke also closed the queue/lyrics panels
        // underneath it.
        if (ui.contextMenu) return;
        if (ui.osFullscreen && !ui.nowPlayingOpen) {
          void window.bytune?.setFullScreen(false);
          return;
        }
      }
      if (typing) return;

      const ui = useUI.getState();
      if (e.key === "Escape") {
        if (ui.nowPlayingOpen) ui.toggleNowPlaying();
        else if (ui.rightPanel === "queue" || ui.lyricsCenter) ui.closePanels();
        return;
      }

      // Held keys: only the plain arrow ramps (seek/volume) may repeat.
      // Every other shortcut machine-guns on key repeat — Space strobes
      // play/pause, KeyN strobes the fullscreen view, Shift+arrows skip a
      // whole track per repeat event.
      const isPlainArrow =
        !e.shiftKey &&
        (e.code === "ArrowRight" || e.code === "ArrowLeft" || e.code === "ArrowUp" || e.code === "ArrowDown");
      if (e.repeat && !isPlainArrow) return;

      const player = usePlayer.getState();
      switch (e.code) {
        case "Space":
          e.preventDefault();
          player.toggle();
          break;
        case "ArrowRight":
          if (e.shiftKey) player.next(true);
          else player.seek(player.position + 5);
          break;
        case "ArrowLeft":
          if (e.shiftKey) player.prev();
          else player.seek(player.position - 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          player.setVolume(player.volume + 0.05);
          break;
        case "ArrowDown":
          e.preventDefault();
          player.setVolume(player.volume - 0.05);
          break;
        case "KeyM":
          player.toggleMute();
          break;
        case "KeyS":
          player.toggleShuffle();
          break;
        case "KeyR":
          player.cycleRepeat();
          break;
        case "KeyQ":
          ui.toggleQueue();
          break;
        case "KeyL":
          ui.toggleLyrics();
          break;
        case "KeyN":
          ui.toggleNowPlaying();
          break;
        case "Slash":
          e.preventDefault();
          document.getElementById("global-search")?.focus();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Artwork-driven ambience: recolors the app atmosphere per track. */
function useAmbient(): void {
  const current = usePlayer((s) => s.queue[s.index] ?? null);

  useEffect(() => {
    void setAmbientFromArtwork(current?.thumb ?? null);
  }, [current?.thumb]);

  // Warm the lyrics cache the moment a track starts, so the lyrics view
  // opens (or flips to the next song) with words already on screen.
  useEffect(() => {
    prefetchLyrics(current);
  }, [current?.id]);
}

/**
 * Applies the appearance settings that act on the whole shell: theme,
 * reduced motion / blur and the liquid-glass recipe land as classes on
 * <html>, so every surface honours them without each component reading the
 * setting itself.
 */
function useAppearance(): void {
  const reduceAnimation = useSettings((s) => s.reduceAnimation);
  const reduceDynamicBlur = useSettings((s) => s.reduceDynamicBlur);
  const liquidGlass = useSettings((s) => s.liquidGlass);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("reduce-motion", reduceAnimation);
    root.classList.toggle("reduce-blur", reduceDynamicBlur);
    root.classList.toggle("noglass", !liquidGlass);
  }, [reduceAnimation, reduceDynamicBlur, liquidGlass]);
}

function CurrentView(): ReactNode {
  const view = useUI((s) => s.view);
  switch (view.name) {
    case "home":
      return <HomeView />;
    case "explore":
      return <ExploreView />;
    case "search":
      return <SearchView />;
    case "library":
    case "playlists":
      return <LibraryView />;
    case "playlist":
      return <PlaylistView playlistId={view.param ?? ""} />;
    case "ytplaylist":
      return <RemotePlaylistView playlistId={view.param ?? ""} />;
    case "album":
      return <AlbumView albumId={view.param ?? ""} />;
    case "artist":
      return <ArtistView artistId={view.param ?? ""} />;
    case "downloads":
      return <DownloadsView />;
    case "local":
      return <LocalMusicView />;
    case "replay":
      return <ReplayView />;
    case "settings":
      return <SettingsView />;
    default:
      return <HomeView />;
  }
}

export default function App() {
  const viewName = useUI((s) => s.view.name);
  const viewReloadNonce = useUI((s) => s.viewReloadNonce);
  const pendingScroll = useUI((s) => s.pendingScroll);
  const lyricsCenter = useUI((s) => s.lyricsCenter);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const session = useSession();
  const panelDrop = usePanelDrop();

  // Back/forward land the user at the scroll they left the view at. Runs as a
  // layout effect so the offset applies before the first paint of the restored
  // view — no jump. Static pages (Settings) restore exactly; pages that refetch
  // restore as far as their skeleton allows.
  useLayoutEffect(() => {
    if (pendingScroll === null) return;
    const el = document.getElementById("view-scroll");
    if (el) el.scrollTop = pendingScroll;
    useUI.getState().clearPendingScroll();
  }, [pendingScroll, viewName, viewReloadNonce]);

  // Session gate: onboarding until the user picks a mode (or straight in for
  // an existing guest/account). watchSession refreshes on auth:changed.
  useEffect(() => watchSession(), []);

  // Cloud restores land on disk from the main process — rehydrate the
  // zustand stores so the UI picks them up live.
  useEffect(() => watchSyncRestores(), []);

  useEffect(() => {
    const unsubscribe = listenForDownloadProgress();
    return unsubscribe;
  }, []);

  // Native miniplayer bridge: push playback snapshots to the PiP window and
  // execute transport commands coming back from it.
  useEffect(() => startPipSync(), []);

  // macOS application menu: commands in (play/pause, navigation…), playback
  // state out (menu checkmarks). No-op off macOS.
  useEffect(() => watchMenuCommands(), []);

  // Maximize / restore settle: the OS zooms the window while the layout snaps
  // underneath, and the seam reads as a jarring reflow. A short settle on the
  // shell — replayed on every flip of the maximized state, however it was
  // asked for (title-bar double-click, caption button, snap) — masks the snap.
  // The class removes itself on animationend so no transform lingers over the
  // fixed overlays.
  useEffect(() => {
    const off = window.bytune?.onMaximizeChange(() => {
      const el = shellRef.current;
      if (!el || document.documentElement.classList.contains("reduce-motion")) return;
      el.classList.remove("win-settle");
      void el.offsetWidth; // restart the animation on rapid toggles
      el.classList.add("win-settle");
    });
    return off;
  }, []);

  // Plain OS fullscreen (F11, handled in main): mirror the window state so
  // Escape can leave it and the shell knows it is in fullscreen. If fullscreen
  // leaves while the cinematic view is up, close that view too — it only
  // lives inside fullscreen. (A self-driven NowPlaying exit flips the store
  // first, so the guard never re-triggers.)
  useEffect(() => {
    const off = window.bytune?.onFullScreenChange((fs) => {
      const ui = useUI.getState();
      ui.setOsFullscreen(fs);
      if (!fs && ui.nowPlayingOpen) ui.toggleNowPlaying();
    });
    return off;
  }, []);

  useEffect(() => {
    // Boot the audio engine only after persisted state has been rehydrated —
    // player (queue), settings (quality/speed/fades) and library (history)
    // alike, so the first load never reads a default over a saved value.
    const stores = [usePlayer.persist, useSettings.persist, useLibrary.persist];
    if (stores.every((p) => p.hasHydrated())) {
      engineBoot();
      return;
    }
    const unsubs = stores.map((p) =>
      p.onFinishHydration(() => {
        if (stores.every((x) => x.hasHydrated())) engineBoot();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  useKeyboardShortcuts();
  useAmbient();
  useAppearance();

  // First run / reinstall gate — no shell is rendered until a mode is chosen.
  if (!session.loaded) return <div className="h-screen bg-canvas" />;
  if (session.mode === null) return <Onboarding initial={takeOnboardingIntent() ?? "choose"} />;
  if (session.mode === "guest" && session.freshInstall) return <Onboarding initial="resume" />;
  // A fresh Google user must choose their username before entering.
  if (session.mode === "account" && session.needsUsername) return <Onboarding initial="pickusername" />;

  return (
    <div
      ref={shellRef}
      onAnimationEnd={(e) => {
        if (e.animationName === "win-settle") e.currentTarget.classList.remove("win-settle");
      }}
      className="h-screen flex flex-col ambient-root text-ink overflow-hidden select-none origin-center"
    >
      <TopBar />
      {/* Three-pane shell: sidebar · content · right rail, over a black canvas.
          8px gaps and side padding; 4px strip above the play bar (Spotify). */}
      <div className="flex flex-1 min-h-0 gap-2 px-2 pb-1">
        <Sidebar />
        <main
          className="flex-1 min-w-0 flex flex-col bg-surface rounded-2xl overflow-hidden relative"
          {...panelDrop.props}
        >
          {/* Full-panel drop highlight — same design as the sidebar rows'
              hover, drawn over the whole surface while a song is over a
              page that accepts it (open playlist / liked / local folder). */}
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-0 z-30 rounded-2xl ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.08] transition-opacity duration-150 ${
              panelDrop.hovering ? "opacity-100" : "opacity-0"
            }`}
          />
          <TintWash />
          {lyricsCenter ? (
            <LyricsCenter />
          ) : (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto scroll-host relative" id="view-scroll">
                {/* The reload nonce rides in the key: a bump remounts the current
                    view so its data effects re-run — that is the Refresh button's
                    mechanism everywhere except Home (which re-orchestrates its
                    feed without a remount). */}
                <div key={`${viewReloadNonce}:${viewName}`} className="animate-rise-in px-10 pt-5 pb-6">
                  <ErrorBoundary>
                    <CurrentView />
                  </ErrorBoundary>
                </div>
              </div>
              {/* Frosted band behind the search filter row. It lives OUTSIDE
                  the scroller on purpose: in-flow content is clipped before
                  the 14px scrollbar gutter, so a band inside the list can
                  never touch the panel's right edge. From here it spans the
                  full panel width (clipped by main's rounded corners) and
                  reads the list's scroll through the shared timeline hoisted
                  by timeline-scope on <main>. Tree order puts it above the
                  scrolling rows; the sticky pills (z-10 inside the scroller)
                  paint above it, so they stay sharp while the rows behind
                  them blur. */}
              {viewName === "search" && (
                <div aria-hidden className="search-band pointer-events-none absolute inset-x-0 top-0 h-16" />
              )}
            </>
          )}
        </main>
        <RightRail />
      </div>
      <PlayerBar />
      <NowPlaying />
      <Dialog />
      <ContextMenu />
      <Toasts />
    </div>
  );
}