import assert from "node:assert/strict";
import test from "node:test";

// 5.37 (15.11): key bindings in account-data slots 2/3 as Wow.exe's bindings cache text (reader 0x005641c0,
// writer 0x0055f1b0). A synthetic sample in Wow.exe's grammar: CRLF lines, BINDINGMODE headers, `bind KEY
// COMMAND`, `bind KEY NONE` taking a default key away, a second mode, modified clicks and a mouse key.

const text = await import("../dist/code/browser/input/BindingsCacheText.js");
const table = await import("../dist/code/browser/input/BindingsCacheTable.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");

const CRLF = "\r\n";
const lines = (...rows) => rows.map((row) => row + CRLF).join("");

const SAMPLE = lines(
  "BINDINGMODE 0",
  "bind SPACE NONE",
  "bind Z JUMP",
  "bind SHIFT-5 MULTIACTIONBAR1BUTTON5",
  "bind BUTTON4 MOVEFORWARD",
  "bind F RAIDTARGET1",
  "bind CTRL-SHIFT-K SPELL Огненный шар",
  "BINDINGMODE 1",
  "bind W CAMERAZOOMIN",
  "modifiedclick ALT SELFCAST",
  "modifiedclick SHIFT AUTOLOOTTOGGLE",
);

const rowOf = (tables, action) => tables.core[action];

test("the reader's grammar: modes, the rest of the line is the command, an empty command is NONE, unknown lines kept", () => {
  const read = text.parseBindingsCacheText(lines("  BINDINGMODE 0", "bind A", "bind B   STRAFELEFT", "garbage line", "BINDINGMODE 7", "bind C JUMP", "BINDINGMODE 2", "bind D JUMP"));
  assert.deepEqual(read.map((line) => [line.kind, line.mode ?? "-", line.key ?? "", line.command ?? ""]), [
    ["bind", 0, "A", "NONE"],
    ["bind", 0, "B", "  STRAFELEFT"],
    ["other", 0, "", ""],
    ["other", 0, "", ""],
    ["bind", 0, "C", "JUMP"],
    ["bind", 2, "D", "JUMP"],
  ]);
});

test("reading over the defaults: NONE takes a default key away, a moved key leaves its default, foreign lines reserve their key", () => {
  const { tables, reserved } = table.tablesFromCacheText(text.parseBindingsCacheText(SAMPLE));
  assert.deepEqual(rowOf(tables, "jump"), ["KeyZ", "Numpad0"], "SPACE gone, Z on JUMP");
  assert.deepEqual(rowOf(tables, "toggleSheath"), ["", ""], "Z left TOGGLESHEATH");
  assert.deepEqual(rowOf(tables, "bottomLeftAction5"), ["Shift+Digit5", ""]);
  assert.deepEqual(rowOf(tables, "assistTarget"), ["", ""], "F is the raid mark's in Wow.exe, so not ASSISTTARGET's here");
  assert.ok(reserved.has("KeyF"), "F is held by a command this client has no row for");
  assert.deepEqual(tables.modules["SPELL Огненный шар"], ["Ctrl+Shift+KeyK", ""], "a direct spell binding is a module row");
  assert.deepEqual(rowOf(tables, "moveForward"), bindings.DEFAULT_BINDINGS.moveForward, "a mouse key changes nothing here");
});

test("the text round-trips unchanged when nothing changed here: every line this client does not hold survives", () => {
  const read = text.parseBindingsCacheText(SAMPLE);
  const { tables, reserved } = table.tablesFromCacheText(read);
  assert.equal(table.cacheTextFromTables(read, tables, reserved), SAMPLE);
});

test("a change here rewrites only its own keys; unknown lines, other modes and modified clicks stay as read", () => {
  const read = text.parseBindingsCacheText(SAMPLE);
  const { tables, reserved } = table.tablesFromCacheText(read);
  tables.core.jump = ["Space", "Numpad0"];
  tables.core.sitOrStand = ["KeyX", "KeyZ"];
  const written = table.cacheTextFromTables(read, tables, reserved);
  // A key the text names is written out as the table has it, in its place (Wow.exe writes such a key too).
  assert.equal(written, lines(
    "BINDINGMODE 0",
    "bind SPACE JUMP",
    "bind Z SITORSTAND",
    "bind SHIFT-5 MULTIACTIONBAR1BUTTON5",
    "bind BUTTON4 MOVEFORWARD",
    "bind F RAIDTARGET1",
    "bind CTRL-SHIFT-K SPELL Огненный шар",
    "BINDINGMODE 1",
    "bind W CAMERAZOOMIN",
    "modifiedclick ALT SELFCAST",
    "modifiedclick SHIFT AUTOLOOTTOGGLE",
  ));
});

test("a key the player binds here takes over a reserved key; unbinding a default key writes NONE", () => {
  const read = text.parseBindingsCacheText(SAMPLE);
  const { tables, reserved } = table.tablesFromCacheText(read);
  tables.core.targetLastHostile = ["KeyF", ""];
  tables.core.toggleAutoRun = ["", ""];
  const written = text.parseBindingsCacheText(table.cacheTextFromTables(read, tables, reserved));
  const mode0 = written.filter((line) => line.kind === "bind" && line.mode === 0).map((line) => `${line.key} ${line.command}`);
  assert.ok(mode0.includes("F TARGETLASTHOSTILE"), "the reserved line is replaced by the player's choice");
  assert.ok(!mode0.includes("F RAIDTARGET1"));
  assert.ok(mode0.includes("G NONE"), "G, TARGETLASTHOSTILE's default key, is no longer on it");
  assert.ok(mode0.includes("NUMLOCK NONE"), "a default key taken away is written as NONE");
});

test("the defaults are the empty text, and the empty text is the defaults", () => {
  const { tables, reserved } = table.tablesFromCacheText([]);
  for (const { action } of bindings.INPUT_ACTIONS) assert.deepEqual(tables.core[action], bindings.DEFAULT_BINDINGS[action], action);
  assert.equal(table.cacheTextFromTables([], tables, reserved), "");
});

test("a punctuation name is read for the whole key only (0x00562ed0)", () => {
  assert.equal(text.canonicalBindingKey("LEFTBRACKET"), "[");
  assert.equal(text.canonicalBindingKey("SHIFT-LEFTBRACKET"), "SHIFT-LEFTBRACKET");
  assert.equal(table.bindingChordOfKey("PLUS"), "Equal");
});
