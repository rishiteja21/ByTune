/**
 * macOS application menu ⇄ renderer bridge.
 *
 * Menu items arrive as `menu:command` strings (electron/mac-menu.ts is the
 * producing side); playback state is pushed back so the menu's
 * Shuffle/Repeat/Play-Pause items always show the truth. Every part is a
 * no-op outside the desktop shell.
 *
 * The repeat modes are direct-set commands — the menu items are radios and
 * must always do exactly what their checkmark says, unlike the renderer's
 * plain-key `R` shortcut which cycles.
 */
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { RepeatMode } from "../stores/player";

function runCommand(command: string): void {
  const ui = useUI.getState();
  const player = usePlayer.getState();
  switch (command) {
    case "play-pause":
      player.toggle();
      break;
    case "next":
      player.next(true);
      break;
    case "previous":
      player.prev();
      break;
    case "shuffle":
      player.toggleShuffle();
      break;
    case "repeat-off":
    case "repeat-all":
    case "repeat-one":
      usePlayer.setState({ repeat: command.slice("repeat-".length) as RepeatMode });
      break;
    case "queue":
      ui.toggleQueue();
      break;
    case "lyrics":
      ui.toggleLyrics();
      break;
    case "now-playing":
      ui.toggleNowPlaying();
      break;
    case "miniplayer":
      void window.bytune?.pipToggle();
      break;
    case "settings":
      ui.navigate({ name: "settings" });
      break;
    case "focus-search": {
      const el = document.getElementById("global-search") as HTMLInputElement | null;
      el?.focus();
      el?.select();
      break;
    }
    default:
      break;
  }
}

/**
 * Install the menu bridge. Returns an unsubscribe (React effect friendly).
 */
export function watchMenuCommands(): () => void {
  if (typeof window === "undefined" || !window.bytune?.onMenuCommand) return () => undefined;

  const off = window.bytune.onMenuCommand(runCommand);

  // Checkmark truth: push once now, then on every relevant player change.
  const push = (): void => {
    const s = usePlayer.getState();
    window.bytune?.menuPushState({ playing: s.playing, shuffle: s.shuffle, repeat: s.repeat });
  };
  push();
  const unsub = usePlayer.subscribe((s, prev) => {
    if (s.playing !== prev.playing || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat) push();
  });

  return () => {
    off();
    unsub();
  };
}
