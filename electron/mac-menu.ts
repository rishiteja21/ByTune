/**
 * macOS application menu — pure template.
 *
 * This module builds the menu structure only: every application-specific
 * action is expressed as a command string or an explicit callback, so the
 * template can be unit-tested without Electron. main.ts owns the wiring
 * (sending commands to the renderer, invoking the backup dialogs).
 *
 * Rules encoded here:
 *   - No dead items: every entry maps to a role, a native panel, or a real
 *     renderer command (the renderer's menuCommands module is the contract).
 *   - No transport accelerators that hijack typing: menu accelerators are
 *     app-global on macOS, so Play/Pause, Next and Previous deliberately
 *     carry NO accelerator. Space is handled by the renderer's window
 *     keydown (text-field aware) and unfocused transport by the system
 *     media keys via MediaSession — neither can hijack normal typing.
 *   - Standard roles where macOS provides the behavior (Edit text actions,
 *     Minimize/Zoom, Full Screen, Hide/Quit).
 */

/** Commands the renderer understands (src/lib/menuCommands.ts mirrors this). */
export type MenuCommand =
  | "play-pause"
  | "next"
  | "previous"
  | "shuffle"
  | "repeat-off"
  | "repeat-all"
  | "repeat-one"
  | "queue"
  | "lyrics"
  | "now-playing"
  | "miniplayer"
  | "settings"
  | "focus-search";

export interface MenuPlaybackState {
  playing: boolean;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
}

export interface MenuWiring {
  /** Forward a command to the main window's renderer. */
  sendCommand(command: MenuCommand): void;
  /** Native backup flows owned by the main process. */
  backupExport(): void;
  backupImport(): void;
  /** Raise (unhide + focus) the main window. */
  showMainWindow(): void;
}

export type MenuTemplate = import("electron").MenuItemConstructorOptions[];

const REPEAT_LABEL: Record<MenuPlaybackState["repeat"], string> = {
  off: "Repeat Off",
  all: "Repeat All",
  one: "Repeat One",
};

/** The full macOS menu: ByTune · File · Edit · View · Playback · Window. */
export function buildAppMenu(state: MenuPlaybackState, wiring: MenuWiring, isDev: boolean): MenuTemplate {
  const cmd = (command: MenuCommand) => (): void => wiring.sendCommand(command);

  const playbackSubmenu: MenuTemplate = [
    { label: state.playing ? "Pause" : "Play", click: cmd("play-pause") },
    { label: "Next", click: cmd("next") },
    { label: "Previous", click: cmd("previous") },
    { type: "separator" },
    {
      label: "Shuffle",
      type: "checkbox",
      checked: state.shuffle,
      click: cmd("shuffle"),
    },
    {
      label: "Repeat",
      submenu: (Object.keys(REPEAT_LABEL) as MenuPlaybackState["repeat"][]).map((mode) => ({
        label: REPEAT_LABEL[mode],
        type: "radio" as const,
        checked: state.repeat === mode,
        // Direct-set, not cycle: the radio item must always do exactly what
        // its checkmark says. Clicking the already-selected mode is a no-op.
        click: mode === state.repeat ? undefined : cmd(`repeat-${mode}`),
      })),
    },
    { type: "separator" },
    { label: "Show Queue", click: cmd("queue") },
    { label: "Show Lyrics", click: cmd("lyrics") },
    { label: "Now Playing View", click: cmd("now-playing") },
  ];

  return [
    {
      label: "ByTune",
      submenu: [
        { role: "about", label: "About ByTune" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Cmd+,",
          click: cmd("settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "Hide ByTune" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: "Quit ByTune" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Import Backup…",
          accelerator: "Cmd+O",
          click: (): void => wiring.backupImport(),
        },
        {
          label: "Export Backup…",
          accelerator: "Cmd+S",
          click: (): void => wiring.backupExport(),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find",
          accelerator: "Cmd+F",
          click: cmd("focus-search"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "togglefullscreen" },
        ...(isDev
          ? ([
              { type: "separator" as const },
              { role: "reload" as const },
              { role: "forceReload" as const },
              { role: "toggleDevTools" as const },
            ] satisfies MenuTemplate)
          : []),
      ],
    },
    {
      label: "Playback",
      submenu: playbackSubmenu,
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Main Window", click: (): void => wiring.showMainWindow() },
        { label: "ByTune Miniplayer", click: cmd("miniplayer") },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
}
