// WORK_PLAN 4.16a: under the stock HUD a key bound to a stock multi-bar button presses what that
// stock button shows.
//
// Stock Bindings.xml runs MULTIACTIONBAR1..4BUTTONn as MultiActionButtonDown on MultiBarBottomLeft,
// MultiBarBottomRight, MultiBarRight and MultiBarLeft (:875-877, :959-961, :1043-1045, :1127-1129),
// and those bars show action pages 6, 5, 3 and 4 (ActionButton.lua:6-9; MultiActionBars.xml:41, 159,
// 277, 395, inherited at :508-535): 0-based slots 60, 48, 24 and 36. This client binds the four
// commands to its own extra-bar actions (FrameXmlBinding.ts), whose native rows stand on the same
// pages since L7 4.16b (they were on pages 7-10, slots 72, 84, 96, 108, before).
import assert from "node:assert/strict";
import test from "node:test";
import { isolatedModule } from "./fixtures/isolated-ui.mjs";

const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const hud = await import("../dist/code/browser/ui/NativeHudReplacement.js");
const { FrameXmlBindingModel } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");

// The one signal the world mount publishes when stock MainMenuBar and MultiBars own the bars.
const bodyClasses = new Set();
globalThis.document = { body: { classList: { contains: (name) => bodyClasses.has(name) } } };
const stockHud = (on) => (on ? bodyClasses.add(hud.NATIVE_LANES_REPLACED) : bodyClasses.delete(hud.NATIVE_LANES_REPLACED));

/** The key verbs over a bar that records the slot each press reaches, and the stock binding model. */
async function keyVerbs() {
  const pressed = [];
  const actions = await isolatedModule("browser/input/Actions", {
    "../ui/ActionBar.js": { useSlot: (column, page) => pressed.push(protocol.actionSlot(page, column)) },
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": protocol,
    "../ui/NativeHudReplacement.js": hud,
    "../game/Context.js": { game: { world: {} } },
  });
  const model = new FrameXmlBindingModel({ runAction: actions.runAction });
  const slotsOf = (press) => {
    pressed.length = 0;
    press();
    return pressed.slice();
  };
  return {
    model,
    /** The slot `RunBinding(command)` reaches. */
    runBinding: (command) => slotsOf(() => model.run(command, "down")),
    /** The slot a key press reaches: the chord's action, run as `Controls` runs it. */
    pressChord: (chord) => slotsOf(() => actions.runAction(bindings.actionFor(chord))),
  };
}

test("under the stock HUD a multi-bar key presses the slot its stock button shows", async () => {
  const keys = await keyVerbs();
  stockHud(true);
  try {
    assert.deepEqual(keys.runBinding("MULTIACTIONBAR1BUTTON1"), [60], "MultiBarBottomLeft, page 6");
    assert.deepEqual(keys.runBinding("MULTIACTIONBAR1BUTTON12"), [71]);
    assert.deepEqual(keys.runBinding("MULTIACTIONBAR2BUTTON1"), [48], "MultiBarBottomRight, page 5");
    assert.deepEqual(keys.runBinding("MULTIACTIONBAR3BUTTON1"), [24], "MultiBarRight, page 3");
    assert.deepEqual(keys.runBinding("MULTIACTIONBAR4BUTTON1"), [36], "MultiBarLeft, page 4");
  } finally {
    stockHud(false);
  }
});

test("L7 4.16b: the native HUD's extra rows press the same stock slots", async () => {
  const keys = await keyVerbs();
  assert.deepEqual(keys.runBinding("MULTIACTIONBAR1BUTTON1"), [60]);
  assert.deepEqual(keys.runBinding("MULTIACTIONBAR2BUTTON1"), [48]);
  assert.deepEqual(keys.runBinding("MULTIACTIONBAR3BUTTON1"), [24]);
  assert.deepEqual(keys.runBinding("MULTIACTIONBAR4BUTTON12"), [47]);
});

test("a key bound in the stock window to a multi-bar button takes the same route", async () => {
  bindings.useBindingStorage(undefined);
  const keys = await keyVerbs();
  assert.equal(keys.model.setBinding("ALT-F9", "MULTIACTIONBAR1BUTTON3"), true);
  assert.equal(bindings.actionFor("Alt+F9"), "bottomLeftAction3");
  stockHud(true);
  try {
    assert.deepEqual(keys.pressChord("Alt+F9"), [62], "the stock bottom-left bar's third button");
  } finally {
    stockHud(false);
  }
  assert.deepEqual(keys.pressChord("Alt+F9"), [62], "the native bottom-left row's third button: the same slot (L7 4.16b)");
});
