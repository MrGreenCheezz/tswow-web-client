import assert from "node:assert/strict";
import test from "node:test";

// The binding C API over input/Bindings.ts (FrameXmlBinding.ts): key names, the Bindings.xml-ordered
// command list, SetBinding's key1/key2 semantics, the Save/Cancel snapshot, CLICK bindings, RunBinding
// and UPDATE_BINDINGS. The table is the real one, on an in-memory store.
const bindings = await import("../dist/code/browser/input/Bindings.js");
const {
  FrameXmlBindingModel, FRAMEXML_BINDING_BINDINGS, FRAMEXML_STOCK_BINDING_SECTIONS, FRAMEXML_WEBCLIENT_BINDING_ROWS,
  frameXmlKeyName, frameXmlKeyToChord, frameXmlChordToKey, frameXmlBindingCommand,
} = await import("../dist/code/browser/framexml/FrameXmlBinding.js");

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

function pump() {
  const events = [];
  return { events, now: () => 0, fire(event, ...args) { events.push([event, ...args]); return 1; } };
}

const settle = async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); };

function fresh() {
  const storage = memoryStorage();
  bindings.useBindingStorage(storage);
  const runs = [];
  const model = new FrameXmlBindingModel({ runAction: (action) => { runs.push(action); return true; } });
  const events = pump();
  model.attach(events);
  return { storage, model, events, runs };
}

test("key names translate both ways in the client's ALT-CTRL-SHIFT order; what the table cannot hold is refused", () => {
  assert.equal(frameXmlKeyName("KeyW"), "W");
  assert.equal(frameXmlKeyName("Digit1"), "1");
  assert.equal(frameXmlKeyName("Numpad7"), "NUMPAD7");
  assert.equal(frameXmlKeyName("NumpadDivide"), "NUMPADDIVIDE");
  assert.equal(frameXmlKeyName("ArrowUp"), "UP");
  assert.equal(frameXmlKeyName("Minus"), "-");
  assert.equal(frameXmlKeyName("ShiftLeft"), "LSHIFT");
  assert.equal(frameXmlKeyName("F12"), "F12");
  assert.equal(frameXmlKeyName("MetaLeft"), "UNKNOWN");

  assert.equal(frameXmlChordToKey("Shift+Digit1"), "SHIFT-1");
  assert.equal(frameXmlChordToKey("Ctrl+Shift+KeyF"), "CTRL-SHIFT-F");
  assert.equal(frameXmlChordToKey("Ctrl+Alt+Shift+KeyX"), "ALT-CTRL-SHIFT-X");
  assert.equal(frameXmlChordToKey("Shift+Tab"), "SHIFT-TAB");
  assert.equal(frameXmlChordToKey("NumpadEnter"), "NUMPADENTER");
  assert.equal(frameXmlChordToKey(""), undefined);

  assert.equal(frameXmlKeyToChord("ALT-CTRL-SHIFT-X"), "Ctrl+Alt+Shift+KeyX");
  assert.equal(frameXmlKeyToChord("shift-ctrl-f"), "Ctrl+Shift+KeyF", "prefixes in any order, any case");
  assert.equal(frameXmlKeyToChord("SHIFT--"), "Shift+Minus", "the minus key after a modifier");
  assert.equal(frameXmlKeyToChord("-"), "Minus");
  assert.equal(frameXmlKeyToChord("NUMPADDIVIDE"), "NumpadDivide");
  for (const refused of ["BUTTON3", "MOUSEWHEELUP", "ESCAPE", "SHIFT-ESCAPE", "LSHIFT", "SHIFT-", "", undefined, "BOGUS"]) {
    assert.equal(frameXmlKeyToChord(refused), undefined, `${String(refused)} is refused`);
  }
  // Every compiled-in default survives the round trip, so every default key is expressible.
  for (const [action, pair] of Object.entries(bindings.DEFAULT_BINDINGS)) {
    for (const chord of pair) {
      if (!chord) continue;
      assert.equal(frameXmlKeyToChord(frameXmlChordToKey(chord)), chord, `${action}: ${chord}`);
    }
  }
});

test("GetBinding lists Bindings.xml's sections in order, then every WebClient-only action under its own header", () => {
  const { model } = fresh();
  const rows = Array.from({ length: model.count() }, (_, index) => model.binding(index + 1));
  const commands = rows.map((row) => row[0]);
  assert.deepEqual(commands.filter((command) => command.startsWith("HEADER_")), [
    "HEADER_MOVEMENT", "HEADER_CHAT", "HEADER_ACTIONBAR", "HEADER_TARGETING", "HEADER_INTERFACE", "HEADER_MISC",
    "HEADER_MULTIACTIONBAR", "HEADER_BLANK4", "HEADER_BLANK5", "HEADER_BLANK6", "HEADER_WEBCLIENT",
  ]);
  assert.deepEqual(rows[0], ["HEADER_MOVEMENT"], "a header row has no keys");
  assert.deepEqual(rows[1], ["MOVEFORWARD", "W", "UP"]);
  assert.deepEqual(model.binding(commands.indexOf("ACTIONPAGE1") + 1), ["ACTIONPAGE1", "SHIFT-1"]);
  assert.deepEqual(model.binding(commands.indexOf("TOGGLERUN") + 1), ["TOGGLERUN", "NUMPADDIVIDE"]);
  assert.deepEqual(model.binding(commands.indexOf("MULTIACTIONBAR1BUTTON1") + 1), ["MULTIACTIONBAR1BUTTON1"],
    "the extra bars ship unbound, as in the client");
  // Every compiled-in action is reachable exactly once, WebClient-only ones included.
  const listed = rows.filter((row) => !row[0].startsWith("HEADER_")).map((row) => row[0]);
  assert.equal(new Set(listed).size, listed.length);
  assert.equal(listed.length, bindings.INPUT_ACTIONS.length);
  for (const entry of bindings.INPUT_ACTIONS) assert.ok(listed.includes(frameXmlBindingCommand(entry.action)), entry.action);
  assert.deepEqual(FRAMEXML_WEBCLIENT_BINDING_ROWS.map(([command]) => command),
    ["WEBCLIENT_TOGGLEDIAGNOSTICS", "WEBCLIENT_TOGGLEKEYBINDINGS"]);
  assert.equal(model.label("WEBCLIENT_TOGGLEKEYBINDINGS"), "Привязки клавиш");
  assert.equal(model.binding(0).length, 0);
  assert.equal(model.binding(model.count() + 1).length, 0);
  // Stock order inside a section: the rows keep Bindings.xml's order (TARGETNEARESTENEMY:84 … FOCUSTARGET:115).
  assert.deepEqual(FRAMEXML_STOCK_BINDING_SECTIONS.find((section) => section.header === "TARGETING").rows.map(([command]) => command),
    ["TARGETNEARESTENEMY", "TARGETPREVIOUSENEMY", "TARGETSELF", "NAMEPLATES", "INTERACTTARGET", "ATTACKTARGET", "PETATTACK", "FOCUSTARGET"]);
});

test("GetBindingKey and GetBindingAction read the live table; Escape is the fixed game menu", () => {
  const { model } = fresh();
  assert.deepEqual(model.bindingKey("ACTIONBUTTON1"), ["1"]);
  assert.deepEqual(model.bindingKey("TOGGLECHARACTER0"), ["C"]);
  assert.deepEqual(model.bindingKey("OPENCHAT"), ["ENTER", "NUMPADENTER"]);
  assert.deepEqual(model.bindingKey("TOGGLEGAMEMENU"), ["ESCAPE"]);
  assert.deepEqual(model.bindingKey("TOGGLESHEATH"), [], "a command this client has no verb for has no key");
  assert.deepEqual(model.bindingKey("CLICK ActionButton1:LeftButton"), []);
  assert.equal(model.bindingAction("SHIFT-1"), "ACTIONPAGE1");
  assert.equal(model.bindingAction("W"), "MOVEFORWARD");
  assert.equal(model.bindingAction("ESCAPE"), "TOGGLEGAMEMENU");
  assert.equal(model.bindingAction("F11"), undefined);
  assert.equal(model.bindingAction("MOUSEWHEELUP"), undefined);
  // A rebinding in the native window (bindKey) is read on the next call.
  bindings.bindKey("action1", 0, "KeyZ");
  assert.deepEqual(model.bindingKey("ACTIONBUTTON1"), ["Z"]);
  assert.equal(model.bindingAction("1"), undefined);
});

test("SetBinding fills key1 then key2, steals the key from its holder and refuses what the table cannot hold", async () => {
  const { model, storage, events } = fresh();
  // KeyBindingFrame_OnKeyDown for key1 of MOVEFORWARD: unbind both, unbind the pressed key, bind it, re-add key2.
  assert.equal(model.setBinding("W", undefined), true);
  assert.equal(model.setBinding("UP", undefined), true);
  assert.equal(model.setBinding("SHIFT-Z", undefined), true);
  assert.equal(model.setBinding("SHIFT-Z", "MOVEFORWARD"), true);
  assert.equal(model.setBinding("UP", "MOVEFORWARD"), true);
  assert.deepEqual(bindings.keysOf("moveForward"), ["Shift+KeyZ", "ArrowUp"]);
  assert.deepEqual(model.bindingKey("MOVEFORWARD"), ["SHIFT-Z", "UP"]);
  // Stealing: T was ATTACKTARGET's.
  assert.equal(model.setBinding("T", "JUMP"), true);
  assert.deepEqual(bindings.keysOf("attackTarget"), ["", ""]);
  assert.deepEqual(bindings.keysOf("jump"), ["Space", "KeyT"]);
  // A third key replaces the second: the table holds two.
  assert.equal(model.setBinding("F7", "JUMP"), true);
  assert.deepEqual(bindings.keysOf("jump"), ["Space", "F7"]);
  // Refusals: the wheel, a mouse button, Escape, an unknown or unimplemented command.
  assert.equal(model.setBinding("MOUSEWHEELUP", "JUMP"), false);
  assert.equal(model.setBinding("BUTTON3", "JUMP"), false);
  assert.equal(model.setBinding("ESCAPE", "JUMP"), false);
  assert.equal(model.setBinding("F8", "TOGGLESHEATH"), false);
  assert.equal(model.setBinding("F8", "TOGGLEGAMEMENU"), false);
  assert.deepEqual(bindings.keysOf("jump"), ["Space", "F7"]);
  // The change is in the table's own saved blob, the one the native window reads.
  assert.deepEqual(JSON.parse(storage.values.get("webclient.keybindings.v1")).moveForward, ["Shift+KeyZ", "ArrowUp"]);
  await settle();
  assert.deepEqual(events.events.filter(([event]) => event === "UPDATE_BINDINGS").length, 1,
    "one UPDATE_BINDINGS after the chain of SetBinding calls");
});

test("LoadBindings(ACCOUNT) takes back every change since the last Save; DEFAULT resets; Save commits", () => {
  const { model, storage } = fresh();
  bindings.bindKey("toggleBags", 0, "KeyY");
  const saved = storage.values.get("webclient.keybindings.v1");
  // The native change is already saved; the stock window's edits start after it.
  model.setBinding("C", "TOGGLEWORLDMAP");
  model.setBinding("Y", "TOGGLECHARACTER0");
  assert.deepEqual(bindings.keysOf("toggleWorldMap"), ["KeyM", "KeyC"]);
  assert.deepEqual(bindings.keysOf("toggleBags"), ["", ""]);
  model.load(1);
  assert.deepEqual(bindings.keysOf("toggleWorldMap"), ["KeyM", ""]);
  assert.deepEqual(bindings.keysOf("toggleCharacter"), ["KeyC", ""]);
  assert.deepEqual(bindings.keysOf("toggleBags"), ["KeyY", ""], "the native change made before the edit stays");
  assert.equal(storage.values.get("webclient.keybindings.v1"), saved, "Cancel leaves the saved blob as it was");
  // Default then Cancel: back again. Default then Save: defaults stay.
  model.load(0);
  assert.deepEqual(bindings.keysOf("toggleBags"), ["KeyB", ""]);
  model.load(1);
  assert.deepEqual(bindings.keysOf("toggleBags"), ["KeyY", ""]);
  model.setBinding("F9", "TOGGLEQUESTLOG");
  model.save();
  model.load(1);
  assert.deepEqual(bindings.keysOf("toggleQuestLog"), ["KeyL", "F9"], "a saved change survives a later Cancel");
  assert.equal(model.currentSet(), 1);
});

test("Defaults then Cancel gives back the keys of modules that are not loaded; Defaults then Okay clears them, as the native reset does", () => {
  const storage = memoryStorage();
  storage.values.set("webclient.keybindings.modules.v1", JSON.stringify({ "module:away:thing": ["KeyZ", ""] }));
  bindings.useBindingStorage(storage);
  const model = new FrameXmlBindingModel({});
  model.attach(pump());
  const saved = storage.values.get("webclient.keybindings.modules.v1");
  // KeyBindingFrameDefaultButton: LoadBindings(DEFAULT_BINDINGS) clears the module blob whole.
  model.load(0);
  assert.deepEqual(bindings.keysOf("module:away:thing"), ["", ""]);
  // KeyBindingFrameCancelButton: LoadBindings(GetCurrentBindingSet()).
  model.load(1);
  assert.deepEqual(bindings.keysOf("module:away:thing"), ["KeyZ", ""], "the unloaded module's key is back");
  assert.equal(storage.values.get("webclient.keybindings.modules.v1"), saved, "and saved as it was");
  // A module row that got its first key after the Cancel point had none before it.
  model.setBinding("F4", "TOGGLEWORLDMAP");
  model.setBindingClick("F6", "MultiBarRightButton2");
  assert.deepEqual(bindings.keysOf("CLICK MultiBarRightButton2:LeftButton"), ["F6", ""]);
  model.load(1);
  assert.deepEqual(bindings.keysOf("CLICK MultiBarRightButton2:LeftButton"), ["", ""]);
  assert.deepEqual(bindings.keysOf("toggleWorldMap"), ["KeyM", ""]);
  model.detach();
  // Defaults then Okay: every key is the default, and modules ship unbound.
  model.load(0);
  model.save();
  model.load(1);
  assert.deepEqual(bindings.keysOf("module:away:thing"), ["", ""]);
});

test("a key the client has no KEY_ name for is named by its code: GetBindingKey shows it and the stock flow rebinds around it", () => {
  const { model } = fresh();
  assert.equal(frameXmlKeyToChord("LAUNCHMAIL"), undefined, "a name no code has produced is not a key");
  assert.equal(frameXmlKeyName("IntlBackslash"), "INTLBACKSLASH");
  assert.equal(frameXmlKeyName("ContextMenu"), "CONTEXTMENU");
  assert.equal(frameXmlKeyName("NumpadEqual"), "NUMPADEQUAL");
  assert.equal(frameXmlKeyName("MetaRight"), "UNKNOWN", "Meta is a modifier the table never stores");
  assert.equal(frameXmlKeyName(""), "UNKNOWN");
  assert.equal(frameXmlKeyToChord("SHIFT-INTLBACKSLASH"), "Shift+IntlBackslash");
  assert.equal(frameXmlChordToKey("Ctrl+ContextMenu"), "CTRL-CONTEXTMENU");
  assert.equal(frameXmlKeyToChord(frameXmlChordToKey("Alt+NumpadComma")), "Alt+NumpadComma", "a stored chord round-trips");
  // The native window put the ISO key on JUMP's first slot: both keys show, in their slots.
  bindings.bindKey("jump", 0, "IntlBackslash");
  bindings.bindKey("jump", 1, "Space");
  assert.deepEqual(model.bindingKey("JUMP"), ["INTLBACKSLASH", "SPACE"]);
  assert.equal(model.bindingAction("INTLBACKSLASH"), "JUMP");
  // KeyBindingFrame_OnKeyDown with keyID 1 and a press of F: key1 is replaced, key2 stays.
  const [key1, key2] = model.bindingKey("JUMP");
  model.setBinding(key1, null);
  model.setBinding(key2, null);
  model.setBinding("F", null);
  model.setBinding("F", "JUMP");
  model.setBinding(key2, "JUMP");
  assert.deepEqual(bindings.keysOf("jump"), ["KeyF", "Space"]);
  // And the stock window binds the key itself.
  assert.equal(model.setBinding("INTLBACKSLASH", "TOGGLEAUTORUN"), true);
  assert.equal(bindings.keysOf("toggleAutoRun").includes("IntlBackslash"), true);
});

test("SetBindingClick registers a CLICK action the keyboard dispatches, never listed, saved in the module blob", () => {
  const { model, storage } = fresh();
  const clicks = [];
  model.setClicker((button, mouse) => clicks.push([button, mouse]));
  const before = model.count();
  assert.equal(model.setBindingClick("F6", "MultiBarBottomLeftButton3"), true);
  assert.deepEqual(model.bindingKey("CLICK MultiBarBottomLeftButton3:LeftButton"), ["F6"]);
  assert.equal(model.bindingAction("F6"), "CLICK MultiBarBottomLeftButton3:LeftButton");
  assert.equal(model.count(), before, "CLICK bindings are not rows of the binding window");
  bindings.moduleActionFor("F6").run();
  assert.deepEqual(clicks, [["MultiBarBottomLeftButton3", "LeftButton"]]);
  assert.deepEqual(JSON.parse(storage.values.get("webclient.keybindings.modules.v1"))["CLICK MultiBarBottomLeftButton3:LeftButton"], ["F6", ""]);
  assert.equal(model.setBindingClick("F6", "bad name!"), false);
  // A VM teardown drops the action (its run would press a dead button) and keeps the key.
  model.detach();
  assert.equal(bindings.moduleActionFor("F6"), undefined);
  assert.deepEqual(model.bindingKey("CLICK MultiBarBottomLeftButton3:LeftButton"), ["F6"]);
});

test("RunBinding runs the action's verb once on the way down; module actions list under the WebClient modules header", () => {
  const { model, runs } = fresh();
  model.run("TOGGLEWORLDMAP");
  model.run("TOGGLEWORLDMAP", "up");
  model.run("WEBCLIENT_TOGGLEDIAGNOSTICS", "down");
  model.run("TOGGLESHEATH");
  assert.deepEqual(runs, ["toggleWorldMap", "toggleDiagnostics"]);
  let ran = 0;
  bindings.addModuleAction({ action: "module:minimap-hub:toggle", module: "test", group: "Модули", label: "Пинг", run: () => { ran += 1; } });
  bindings.addModuleAction({ action: "module:minimap_hub:toggle", module: "test", group: "Модули", label: "Второй", run() {} });
  try {
    const rows = Array.from({ length: model.count() }, (_, index) => model.binding(index + 1));
    // Stock GetBindingText cuts a command at its last «-», so a module id travels as a dash-free alias.
    assert.deepEqual(rows.slice(-3), [["HEADER_WEBCLIENT_MODULES"], ["WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE"],
      ["WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE_2"]]);
    assert.equal(model.label("WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE"), "Пинг");
    assert.equal(model.label("WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE_2"), "Второй");
    assert.equal(model.setBinding("CTRL-P", "WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE"), true);
    assert.deepEqual(bindings.keysOf("module:minimap-hub:toggle"), ["Ctrl+KeyP", ""], "stored under the module's own id");
    assert.equal(model.bindingAction("CTRL-P"), "WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE");
    assert.deepEqual(model.bindingKey("WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE"), ["CTRL-P"]);
    model.run("WEBCLIENT_MODULE_MINIMAP_HUB_TOGGLE");
    assert.equal(ran, 1);
    assert.equal(model.setBinding("CTRL-O", "module:minimap-hub:toggle"), false, "the raw id is not a command");
  } finally {
    bindings.removeModuleActions("test");
  }
});

test("a change made outside the API reaches UPDATE_BINDINGS on the next throttled tick", () => {
  const { model, events } = fresh();
  model.tick(0);
  assert.equal(events.events.length, 0, "nothing changed");
  bindings.bindKey("toggleFps", 1, "F3");
  model.tick(0.1);
  assert.equal(events.events.length, 0, "the check waits for its interval");
  model.tick(0.3);
  assert.deepEqual(events.events, [["UPDATE_BINDINGS"]]);
  model.tick(0.6);
  assert.equal(events.events.length, 1, "one event per change");
  bindings.resetBindings();
  model.tick(0.9);
  assert.equal(events.events.length, 2);
});

test("the seam bindings answer the neutral empty table without a model, and the model's answers with one", () => {
  const empty = {};
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetNumBindings(empty, []), [0]);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetBindingKey(empty, ["JUMP"]), []);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetBindingAction(empty, ["W"]), [""]);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.SetBinding(empty, ["W", "JUMP"]), [false]);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetCurrentBindingSet(empty, []), [1]);
  const { model } = fresh();
  const seam = { keyBindings: model };
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetBindingKey(seam, ["JUMP"]), ["SPACE"]);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetBindingByKey(seam, ["SPACE"]), ["JUMP"]);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetBindingByKey(seam, ["F11"]), []);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.WebClientBindingLabel(seam, ["WEBCLIENT_TOGGLEDIAGNOSTICS"]), ["Диагностика"]);
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.WebClientBindingLabel(seam, ["JUMP"]), []);
});
