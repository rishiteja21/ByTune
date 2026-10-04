/**
 * macOS application menu template — structural contract tests.
 *
 * The template is the product's macOS menu; these tests lock the rules the
 * implementation depends on:
 *   - every application item is wired (no dead menu items),
 *   - transport items carry no accelerators (accelerators are app-global on
 *     macOS and would hijack typing — e.g. Space in the search field),
 *   - the repeat radios direct-set the mode their checkmark shows,
 *   - dev-only items never leak into a production menu.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppMenu } from "../.test-build/mac-menu.mjs";

const NOOP_WIRING = {
  sendCommand: () => undefined,
  backupExport: () => undefined,
  backupImport: () => undefined,
  showMainWindow: () => undefined,
};

function labels(submenu) {
  return submenu.filter((i) => i && i.label).map((i) => i.label);
}

function findByLabel(items, label) {
  return items.find((i) => i && i.label === label);
}

const STATE = { playing: true, shuffle: true, repeat: "all" };

test("menu has the six macOS menus in order", () => {
  const menu = buildAppMenu(STATE, NOOP_WIRING, false);
  assert.deepEqual(
    menu.map((m) => m.label),
    ["ByTune", "File", "Edit", "View", "Playback", "Window"]
  );
});

test("every application item is wired — no dead menu items", () => {
  const walk = (items, path) => {
    for (const item of items ?? []) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "separator") continue;
      if (item.role) continue; // native roles are implemented by Electron
      // A selected radio with no click is the intentional no-op (the
      // checkmark already says "this is the mode"); anything else unwired
      // would be a dead menu item.
      const selectedRadioNoop = item.type === "radio" && item.checked === true;
      assert.ok(selectedRadioNoop || item.click || item.submenu, `unwired item at ${path} → ${item.label ?? "?"}`);
      walk(item.submenu, `${path}/${item.label ?? "?"}`);
    }
  };
  walk(buildAppMenu(STATE, NOOP_WIRING, false), "menu");
});

test("transport items never take accelerators (typing must stay safe)", () => {
  const playing = findByLabel(buildAppMenu(STATE, NOOP_WIRING, false), "Playback").submenu;
  const paused = findByLabel(
    buildAppMenu({ ...STATE, playing: false }, NOOP_WIRING, false),
    "Playback"
  ).submenu;
  const transport = [
    ["Pause", playing],
    ["Play", paused],
    ["Next", playing],
    ["Previous", playing],
    ["Shuffle", playing],
    ["Show Queue", playing],
    ["Show Lyrics", playing],
    ["Now Playing View", playing],
  ];
  for (const [label, submenu] of transport) {
    const item = findByLabel(submenu, label);
    assert.ok(item, `${label} exists`);
    assert.equal(item.accelerator, undefined, `${label} must not register a global accelerator`);
  }
});

test("play label mirrors playing state; settings and find are reachable", () => {
  const playing = buildAppMenu(STATE, NOOP_WIRING, false);
  const paused = buildAppMenu({ ...STATE, playing: false }, NOOP_WIRING, false);
  assert.equal(findByLabel(findByLabel(playing, "Playback").submenu, "Pause").label, "Pause");
  assert.equal(findByLabel(findByLabel(paused, "Playback").submenu, "Play").label, "Play");

  const app = findByLabel(playing, "ByTune").submenu;
  const settings = findByLabel(app, "Settings…");
  assert.equal(settings.accelerator, "Cmd+,");
  assert.doesNotThrow(() => settings.click());

  const find = findByLabel(findByLabel(playing, "Edit").submenu, "Find");
  assert.equal(find.accelerator, "Cmd+F");
});

test("shuffle checkbox and repeat radios reflect pushed state", () => {
  const playback = findByLabel(buildAppMenu(STATE, NOOP_WIRING, false), "Playback").submenu;
  const shuffle = findByLabel(playback, "Shuffle");
  assert.equal(shuffle.type, "checkbox");
  assert.equal(shuffle.checked, true);
  const repeat = findByLabel(playback, "Repeat");
  assert.deepEqual(
    repeat.submenu.map((i) => [i.type, i.checked, i.label]),
    [
      ["radio", false, "Repeat Off"],
      ["radio", true, "Repeat All"],
      ["radio", false, "Repeat One"],
    ]
  );
});

test("clicking a repeat radio sets exactly the mode it shows; selected mode is a no-op", () => {
  const sent = [];
  const wiring = { ...NOOP_WIRING, sendCommand: (c) => sent.push(c) };
  for (const state of [
    { playing: false, shuffle: false, repeat: "off" },
    { playing: false, shuffle: false, repeat: "all" },
    { playing: false, shuffle: false, repeat: "one" },
  ]) {
    const repeat = findByLabel(findByLabel(buildAppMenu(state, wiring, false), "Playback").submenu, "Repeat");
    for (const item of repeat.submenu) {
      sent.length = 0;
      item.click?.();
      if (item.checked) assert.equal(sent.length, 0, "selected mode must not re-send");
      else assert.deepEqual(sent, [`repeat-${item.label.split(" ")[1].toLowerCase()}`]);
    }
  }
});

test("file menu items route to the native backup flows; window menu raises the main window", () => {
  let calls = 0;
  let raised = 0;
  const wiring = {
    ...NOOP_WIRING,
    backupExport: () => calls++,
    backupImport: () => calls++,
    showMainWindow: () => raised++,
  };
  const menu = buildAppMenu(STATE, wiring, false);
  findByLabel(findByLabel(menu, "File").submenu, "Export Backup…").click();
  findByLabel(findByLabel(menu, "File").submenu, "Import Backup…").click();
  assert.equal(calls, 2);
  findByLabel(findByLabel(menu, "Window").submenu, "Main Window").click();
  assert.equal(raised, 1);
});

test("developer items exist only in dev builds", () => {
  const prod = findByLabel(buildAppMenu(STATE, NOOP_WIRING, false), "View").submenu;
  const dev = findByLabel(buildAppMenu(STATE, NOOP_WIRING, true), "View").submenu;
  assert.equal(prod.find((i) => i?.role === "toggleDevTools"), undefined);
  assert.ok(dev.find((i) => i?.role === "toggleDevTools"));
  assert.ok(prod.find((i) => i?.role === "togglefullscreen"));
});

test("standard edit roles are present (mac text editing must work)", () => {
  const edit = findByLabel(buildAppMenu(STATE, NOOP_WIRING, false), "Edit").submenu;
  for (const role of ["undo", "redo", "cut", "copy", "paste", "delete", "selectAll"]) {
    assert.ok(edit.find((i) => i?.role === role), `missing Edit role: ${role}`);
  }
});
