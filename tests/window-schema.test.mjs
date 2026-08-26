import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ANCHOR_POINTS,
  BACKDROP_PRESETS,
  CONDITION_EFFECTS,
  CONDITION_NAMES,
  FONT_FILES,
  FONT_OBJECTS,
  LAYERS,
  STRATAS,
  STUDIO_BUTTON_ACTIONS,
  WIDGET_TYPES,
  WINDOW_BINDINGS,
  WINDOW_COMMANDS,
  MODEL_UNITS,
  WINDOW_CONDITIONS,
  WINDOW_EVENTS,
  WINDOW_FONT_NAMES,
  WINDOW_MAX_CSS,
  WINDOW_MAX_REPEAT,
  WINDOW_STATE_ROOTS,
  parseWindowDefinition,
  walkWindowWidgets,
} from "../dist/code/browser/ui/WindowSchema.js";
import { evaluate, expressionRoots, parseExpression } from "../dist/code/browser/ui/WindowExpression.js";
import { CUSTOM_MAX_SEND_BODY } from "../dist/code/world/CustomPacket.js";
import * as paths from "../tools/paths.mjs";

/**
 * The owner's live screen, byte for byte as the studio saved it on 18 August.
 *
 * Inline rather than only read from disk: this is the acceptance fixture the plan names, and the
 * assertion has to mean something on a machine that has no tswow install. The copy on disk is
 * checked as well, below, so the two cannot drift apart silently.
 */
const PROVEROCHNYY_EKRAN = {
  kind: "addon",
  id: "proverochnyy-ekran",
  name: { ru: "Проверочный экран", en: "" },
  params: {
    screen: {
      id: "root",
      type: "Frame",
      name: "ProverochnyyEkran",
      width: 384,
      height: 288,
      anchor: { point: "CENTER", relativeTo: "parent", relativePoint: "CENTER", x: -76, y: 9 },
      backdrop: "dialog",
      backdropColor: [1, 1, 1, 1],
      borderColor: [1, 1, 1, 1],
      strata: "DIALOG",
      movable: true,
      mouse: true,
      hidden: true,
      closeButton: true,
      escClose: true,
      title: { ru: "Моё окно", en: "" },
      titleTexture: true,
      children: [
        {
          id: "texture-1",
          type: "Texture",
          name: "",
          width: 64,
          height: 64,
          texture: "Interface\\CharacterFrame\\TemporaryPortrait",
          texCoords: [0, 1, 0, 1],
          color: [1, 1, 1, 1],
          layer: "ARTWORK",
          solid: false,
          anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 16, y: -24 },
          conditions: [],
        },
        {
          id: "model-1",
          type: "Model",
          name: "",
          width: 200,
          height: 220,
          unit: "player",
          creature: 0,
          rotation: 0,
          anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 89, y: -40 },
          conditions: [],
        },
      ],
      events: [],
    },
    slash: "testUI",
    packets: { enabled: false, opcodeIn: 0, opcodeOut: 0 },
  },
  enabled: true,
  updated: "2026-08-18T11:36:13.844Z",
};

const parse = (definition, module = "test") => parseWindowDefinition(definition, { module });

/** A minimal well-formed window, so a test only has to write down the part it is about. */
const window = (screen, params = {}) => ({
  kind: "addon",
  id: "probe",
  name: { ru: "Проба", en: "" },
  enabled: true,
  params: { screen: { id: "root", type: "Frame", width: 100, height: 100, ...screen }, ...params },
});

const widgetById = (parsed, id) => walkWindowWidgets(parsed.screen).find((widget) => widget.id === id);

const studioDirectory = process.env.CONTENT_STUDIO_DIR ?? "";
const withStudio = { skip: existsSync(studioDirectory) ? false : "no content studio on this machine" };

let modulesRoot;
try {
  modulesRoot = paths.moduleDirectories().map((entry) => entry.root).find((root) => existsSync(root));
} catch {
  modulesRoot = undefined;
}
const liveScreen = modulesRoot ? join(modulesRoot, "test/content/ui/proverochnyy-ekran.json") : undefined;
const withLiveScreen = { skip: liveScreen && existsSync(liveScreen) ? false : "no studio screen on this machine" };

/* ---------------------------------------------------------------------------------------------
 * The acceptance fixture
 * ------------------------------------------------------------------------------------------- */

test("the studio's own screen parses with no problems at all", () => {
  const result = parse(PROVEROCHNYY_EKRAN);
  assert.deepEqual(result.problems, [], "the format is the studio's, so its own file must be silent");
  assert.ok(result.window);

  const { window: parsed } = result;
  assert.equal(parsed.id, "proverochnyy-ekran");
  assert.equal(parsed.module, "test");
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.slash, "testui", "the slash loses its case and any character a route could not carry");
  assert.deepEqual(parsed.packets, { enabled: false, opcodeIn: 0, opcodeOut: 0 });

  assert.deepEqual(walkWindowWidgets(parsed.screen).map((widget) => `${widget.id}:${widget.type}`),
    ["root:Frame", "texture-1:Texture", "model-1:Model"]);
  assert.equal(evaluate(parsed.screen.title, {}), "Моё окно");
  assert.equal(evaluate(parsed.name, {}), "Проверочный экран");
  assert.equal(parsed.screen.strata, "DIALOG");
  assert.equal(parsed.screen.closeButton, true);
  assert.equal(parsed.screen.escClose, true);
  assert.equal(parsed.screen.movable, true);
  assert.equal(parsed.screen.hidden, true);
  assert.equal(parsed.screen.titleTexture, true);
  // The backdrop is resolved to the client's own files here, so М5 has nothing left to look up.
  assert.equal(parsed.screen.backdrop.bgFile, "Interface\\DialogFrame\\UI-DialogBox-Background");
  assert.equal(parsed.screen.backdrop.edgeSize, 32);
  assert.deepEqual(parsed.screen.backdrop.insets, { left: 11, right: 12, top: 12, bottom: 11 });

  const texture = widgetById(parsed, "texture-1");
  assert.equal(evaluate(texture.texture, {}), "Interface\\CharacterFrame\\TemporaryPortrait");
  assert.deepEqual(texture.anchor, { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 16, y: -24 });
  assert.equal(texture.layer, "ARTWORK");
  const model = widgetById(parsed, "model-1");
  assert.equal(model.unit, "player");
  assert.equal(evaluate(model.creature, {}), 0);
});

test("the copy of that screen on this machine is the same file", withLiveScreen, () => {
  // The inline fixture above is what the assertions are written against; this is the check that it
  // still matches what the studio actually writes.
  const onDisk = JSON.parse(readFileSync(liveScreen, "utf8"));
  assert.deepEqual(onDisk, PROVEROCHNYY_EKRAN);
  assert.deepEqual(parse(onDisk).problems, []);
});

/* ---------------------------------------------------------------------------------------------
 * The vocabulary is the studio's, not a paraphrase of it
 * ------------------------------------------------------------------------------------------- */

test("every table here is the one in shared/ui-model.mjs", withStudio, async () => {
  const model = await import(pathToFileURL(join(studioDirectory, "shared/ui-model.mjs")).href);

  assert.deepEqual([...ANCHOR_POINTS], model.ANCHOR_POINTS, "ui-model.mjs:9");
  assert.deepEqual([...STRATAS], model.STRATA, ":15");
  assert.deepEqual([...LAYERS], model.LAYERS, ":16");
  assert.deepEqual([...WIDGET_TYPES], Object.keys(model.WIDGET_TYPES), ":221-270");
  assert.deepEqual([...WINDOW_EVENTS], model.COMMON_EVENTS.map(([name]) => name), ":196-218");
  assert.deepEqual([...STUDIO_BUTTON_ACTIONS], model.BUTTON_ACTIONS.map((action) => action.value), ":139-149");
  assert.deepEqual([...CONDITION_EFFECTS], model.CONDITION_THEN.map((effect) => effect.value), ":188-193");
  assert.deepEqual(Object.fromEntries(Object.entries(FONT_FILES).map(([key, value]) => [key, [...value]])), model.FONT_FILES, ":41-46");

  assert.deepEqual(
    FONT_OBJECTS.map((font) => ({ name: font.name, size: font.size, color: [...font.color], font: font.font })),
    model.FONT_OBJECTS.map((font) => ({ name: font.name, size: font.size, color: font.color, font: font.font })),
    ":19-38",
  );

  // `none` carries only the two file names in the studio; the rest carry the whole SetBackdrop.
  assert.deepEqual(BACKDROP_PRESETS.map((preset) => preset.name), Object.keys(model.BACKDROP_PRESETS), ":49-94");
  for (const preset of BACKDROP_PRESETS) {
    const theirs = model.BACKDROP_PRESETS[preset.name];
    assert.equal(preset.bgFile, theirs.bgFile, preset.name);
    assert.equal(preset.edgeFile, theirs.edgeFile, preset.name);
    if (theirs.tile === undefined) continue;
    assert.equal(preset.tile, theirs.tile, preset.name);
    assert.equal(preset.tileSize, theirs.tileSize, preset.name);
    assert.equal(preset.edgeSize, theirs.edgeSize, preset.name);
    if (theirs.insets) assert.deepEqual(preset.insets, theirs.insets, preset.name);
  }

  assert.deepEqual(
    WINDOW_BINDINGS.map((binding) => ({ value: binding.name, label: binding.label, bar: binding.forBar, text: binding.forText })),
    model.BINDING_OPTIONS,
    ":152-165",
  );

  assert.deepEqual(
    WINDOW_CONDITIONS.map((option) => ({
      value: option.name,
      label: option.label,
      ...(option.number === undefined ? {} : { number: true }),
      ...(option.text ? { text: true } : {}),
    })),
    model.CONDITION_WHEN,
    ":168-187",
  );
});

test("the counts the plan measured are the counts these tables have", () => {
  // These counts are part of the studio/client contract, so an unreviewed table change fails here.
  assert.equal(WIDGET_TYPES.length, 12);
  assert.equal(ANCHOR_POINTS.length, 9);
  assert.equal(STRATAS.length, 8);
  assert.equal(LAYERS.length, 5);
  assert.equal(FONT_OBJECTS.length, 18);
  assert.equal(BACKDROP_PRESETS.length, 9);
  assert.equal(WINDOW_BINDINGS.length, 12);
  assert.equal(WINDOW_CONDITIONS.length, 18);
  assert.equal(CONDITION_EFFECTS.length, 4);
  assert.equal(WINDOW_EVENTS.length, 21);
  assert.equal(STUDIO_BUTTON_ACTIONS.length, 9);
});

/* ---------------------------------------------------------------------------------------------
 * Every studio construct maps or is refused by name
 * ------------------------------------------------------------------------------------------- */

test("all twelve widget types parse, and one this client has not got is dropped by name", () => {
  const children = WIDGET_TYPES.map((type, index) => ({
    id: `w-${type}`,
    type,
    width: 10,
    height: 10,
    anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: index * 10 },
  }));
  const result = parse(window({ children }));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(walkWindowWidgets(result.window.screen).slice(1).map((widget) => widget.type), [...WIDGET_TYPES]);

  const withStranger = parse(window({
    children: [...children, { id: "odd", type: "Cooldown", width: 10, height: 10 }],
  }));
  // Dropped, not fatal: the rest of the window still reaches the player.
  assert.ok(withStranger.window, "one unknown widget does not take the window down");
  assert.equal(widgetById(withStranger.window, "odd"), undefined);
  assert.equal(withStranger.problems.length, 1);
  assert.ok(withStranger.problems[0].includes("Cooldown"), withStranger.problems[0]);
  assert.ok(withStranger.problems[0].includes("test/probe.odd"), withStranger.problems[0]);
});

test("a custom backdrop keeps the insets the studio lets its author edit", () => {
  // The studio seeds `backdropCustom.insets` (`web/designer.mjs:739`), offers «Отступ слева/справа»
  // and «Отступ сверху/снизу» (`:743`), and merges the whole object into `SetBackdrop`
  // (`addon.mjs:139`). Dropped here, the same file drew an 8-pixel border where the Lua addon drew
  // 20, with nothing recorded — the divergence a forward anchor is refused for, arriving quietly.
  const backdropCustom = {
    bgFile: "Interface\\Buttons\\WHITE8X8", edgeFile: "Interface\\Tooltips\\UI-Tooltip-Border",
    tile: false, tileSize: 4, edgeSize: 5, insets: { left: 20, right: 21, top: 22, bottom: 23 },
  };
  const result = parse(window({ backdrop: "custom", backdropCustom }));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.window.screen.backdrop.insets, { left: 20, right: 21, top: 22, bottom: 23 });
  assert.equal(result.window.screen.backdrop.edgeSize, 5);

  // A file that edits two of the four keeps the preset's own for the rest, and a file with no
  // insets at all is the studio's default eight.
  const half = parse(window({ backdrop: "custom", backdropCustom: { insets: { left: 2, top: 3 } } }));
  assert.deepEqual(half.window.screen.backdrop.insets, { left: 2, right: 8, top: 3, bottom: 8 });
  const none = parse(window({ backdrop: "custom", backdropCustom: { bgFile: "x" } }));
  assert.deepEqual(none.window.screen.backdrop.insets, { left: 8, right: 8, top: 8, bottom: 8 });
});

test("a font, a model's unit and an opcode are all checked against what this client has", () => {
  const result = parse(window({
    children: [
      { id: "t", type: "Text", width: 1, height: 1, font: "GameFontNromal" },
      { id: "m", type: "Model", width: 1, height: 1, unit: "nonsense" },
      { id: "b", type: "Button", width: 1, height: 1, action: { type: "sendPacket", opcode: -5, value: 1 } },
    ],
  }, { packets: { enabled: true, opcodeIn: 0, opcodeOut: 4001 } }));
  assert.ok(result.window, "each of the three falls back rather than taking the window down");
  assert.equal(widgetById(result.window, "t").font, "GameFontNormal");
  assert.equal(widgetById(result.window, "m").unit, "player");
  assert.equal(evaluate(widgetById(result.window, "b").actions[0].opcode, {}), 4001);
  assert.equal(result.problems.length, 3, result.problems.join("; "));
  assert.ok(result.problems[0].includes("GameFontNromal"), result.problems[0]);
  assert.ok(result.problems[1].includes("nonsense"), result.problems[1]);
  assert.ok(result.problems[2].includes("-5") && result.problems[2].includes("65535"), result.problems[2]);
  assert.deepEqual([...MODEL_UNITS], ["player", "target", "focus", "pet", "none"]);

  // The nineteenth font name is real. `ui-model.mjs:245` gives every EditBox `ChatFontNormal`, and
  // the studio's own font table (`:19-38`) does not list it, so refusing it would refuse every
  // input box the studio has ever saved; `addon.mjs:342` hands the name to the client unchanged.
  assert.ok(!FONT_OBJECTS.some((font) => font.name === "ChatFontNormal"));
  assert.ok(WINDOW_FONT_NAMES.includes("ChatFontNormal"));
  assert.equal(WINDOW_FONT_NAMES.length, FONT_OBJECTS.length + 1);
  const boxes = parse(window({
    children: [
      { id: "in", type: "EditBox", width: 1, height: 1 },
      { id: "chk", type: "CheckButton", width: 1, height: 1, font: "GameFontNormalSmall" },
      { id: "bar", type: "StatusBar", width: 1, height: 1, font: "NumberFontNormal" },
    ],
  }));
  assert.deepEqual(boxes.problems, []);
  assert.equal(widgetById(boxes.window, "in").font, "ChatFontNormal");
  assert.equal(widgetById(boxes.window, "bar").font, "NumberFontNormal");

  // Out of range the other way, and in the `do` spelling too; 0 is "not set" in both.
  const high = parse(window({
    children: [{ id: "b", type: "Button", width: 1, height: 1, actions: [{ do: "sendCustomRaw", opcode: 70_000, fields: [{ type: "u32", value: 1 }] }] }],
  }, { packets: { enabled: true, opcodeIn: 0, opcodeOut: 4002 } }));
  assert.equal(evaluate(widgetById(high.window, "b").actions[0].opcode, {}), 4002);
  assert.ok(high.problems[0].includes("70000"), high.problems[0]);

  const nowhere = parse(window({
    children: [{ id: "b", type: "Button", width: 1, height: 1, actions: [{ do: "sendCustomRaw", fields: [{ type: "u32", value: 1 }] }] }],
  }));
  assert.deepEqual(widgetById(nowhere.window, "b").actions, [], "an action with no opcode anywhere is dropped");
  assert.ok(nowhere.problems[0].includes("opcode 0"), nowhere.problems[0]);
});

test("all eighteen studio conditions compile to an expression over the published view", () => {
  const children = WINDOW_CONDITIONS.map((option, index) => ({
    id: `c-${option.name}`,
    type: "Frame",
    width: 10,
    height: 10,
    anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: index },
    conditions: [{ when: option.name, then: "hide", value: option.number ?? 0, text: "Благословение королей" }],
  }));
  const result = parse(window({ children }));
  assert.deepEqual(result.problems, []);

  for (const option of WINDOW_CONDITIONS) {
    const widget = widgetById(result.window, `c-${option.name}`);
    assert.equal(widget.conditions.length, 1, option.name);
    const condition = widget.conditions[0];
    assert.equal(condition.when, option.name);
    assert.equal(condition.then, "hide");
    // Inert, like every other tree here, and reading only roots М6 has promised to publish.
    assert.deepEqual(JSON.parse(JSON.stringify(condition.test)), condition.test, option.name);
    for (const root of expressionRoots(condition.test)) {
      assert.ok(WINDOW_STATE_ROOTS.includes(root), `${option.name} reads "${root}", which nothing publishes`);
    }
  }

  // The client's own addition: any expression at all.
  const custom = parse(window({
    children: [{ id: "e", type: "Frame", width: 1, height: 1, conditions: [{ when: "expr", value: "{player.level > 60}", then: "alpha", alpha: 0.4 }] }],
  }));
  assert.deepEqual(custom.problems, []);
  const condition = widgetById(custom.window, "e").conditions[0];
  assert.equal(condition.alpha, 0.4);
  assert.equal(evaluate(condition.test, { player: { level: 70 } }), true);

  // And a name from nowhere is noted, with the whole list, and the widget survives without it.
  const unknown = parse(window({ children: [{ id: "e", type: "Frame", width: 1, height: 1, conditions: [{ when: "onFriday", then: "hide" }] }] }));
  assert.ok(unknown.window);
  assert.equal(widgetById(unknown.window, "e").conditions.length, 0);
  assert.ok(unknown.problems[0].includes("onFriday") && unknown.problems[0].includes("inCombat"), unknown.problems[0]);
  assert.deepEqual([...CONDITION_NAMES], WINDOW_CONDITIONS.map((option) => option.name));
});

test("the parametrised conditions use the studio generator's own defaults", () => {
  // `addon.mjs:1063-1069` falls back to 30/70/30/20 when the number is left blank, so a condition
  // saved without one has to mean the same thing in both tools.
  const blank = parse(window({
    children: [{ id: "h", type: "Frame", width: 1, height: 1, conditions: [{ when: "healthBelow", then: "show" }] }],
  }));
  const test30 = widgetById(blank.window, "h").conditions[0].test;
  assert.equal(evaluate(test30, { player: { health: 29, maxHealth: 100 } }), true);
  assert.equal(evaluate(test30, { player: { health: 31, maxHealth: 100 } }), false);
  // The maximum has not arrived yet: nothing known, so the condition does not fire.
  assert.equal(evaluate(test30, { player: { health: 29, maxHealth: 0 } }), undefined);
});

test("all nine studio button actions map, and `custom` is refused with a sentence", () => {
  const button = (id, action) => ({ id, type: "Button", width: 10, height: 10, action });
  const result = parse(window({
    children: [
      button("b-close", { type: "close" }),
      button("b-toggle", { type: "toggleWidget", target: "b-close" }),
      button("b-screen", { type: "showScreen", screen: "other-window" }),
      button("b-chat", { type: "chat", text: { ru: "привет", en: "" } }),
      button("b-cast", { type: "castSpell", spell: "Молния" }),
      button("b-item", { type: "useItem", item: "Хлеб" }),
      button("b-macro", { type: "macro", macro: "/say привет" }),
      button("b-packet", { type: "sendPacket", opcode: 4001, value: 7 }),
    ],
  }));
  assert.deepEqual(result.problems, []);
  const actionOf = (id) => widgetById(result.window, id).actions[0];
  assert.deepEqual(actionOf("b-close"), { do: "close", window: "" });
  assert.deepEqual(actionOf("b-toggle"), { do: "toggleWidget", widget: "b-close" });
  assert.deepEqual(actionOf("b-screen"), { do: "toggle", window: "other-window" });
  assert.equal(actionOf("b-chat").do, "chat");
  assert.equal(evaluate(actionOf("b-chat").text, {}), "привет");
  assert.equal(actionOf("b-cast").name, "castSpellByName");
  assert.equal(evaluate(actionOf("b-cast").args[0], {}), "Молния");
  assert.equal(actionOf("b-item").name, "useItemByName");
  assert.equal(actionOf("b-macro").do, "macro");
  assert.equal(evaluate(actionOf("b-macro").body, {}), "/say привет");
  // One WriteDouble and nothing else, which is exactly what the generated Lua sends.
  assert.deepEqual(actionOf("b-packet"), {
    do: "sendCustomRaw",
    opcode: { node: "number", value: 4001 },
    fields: [{ type: { kind: "f64" }, value: { node: "number", value: 7 } }],
  });

  // The ninth. The honest answer, said out loud, is the only one that does not waste the author's
  // afternoon looking for a bug in a handler this client would never call.
  const lua = parse(window({ children: [button("b-custom", { type: "custom" })] }));
  assert.ok(lua.window, "the button is still drawn");
  assert.deepEqual(widgetById(lua.window, "b-custom").actions, []);
  assert.equal(lua.problems.length, 1);
  assert.ok(lua.problems[0].includes("Lua"), lua.problems[0]);
  assert.ok(lua.problems[0].includes("b-custom"), lua.problems[0]);
});

test("the studio's `valueFrom` reads the named input's published state", () => {
  // The generated Lua is `Number(ui.<widget>.GetText())`; here an input with no state key of its
  // own publishes under `state.<its id>`, so the path is the widget id — hyphen and all, which no
  // dotted path could spell.
  const result = parse(window({
    children: [
      { id: "input-1", type: "EditBox", width: 10, height: 10, numeric: true },
      { id: "send", type: "Button", width: 10, height: 10, action: { type: "sendPacket", valueFrom: "input-1" } },
    ],
  }, { packets: { enabled: true, opcodeIn: 4002, opcodeOut: 4001 } }));
  assert.deepEqual(result.problems, []);
  assert.equal(widgetById(result.window, "input-1").state, "input-1");
  const action = widgetById(result.window, "send").actions[0];
  assert.equal(evaluate(action.opcode, {}), 4001, "the screen's own outbound opcode is the default");
  assert.equal(evaluate(action.fields[0].value, { state: { "input-1": 17 } }), 17);

  // What that path holds is a contract with two strict readers, so the parse says which it is: a
  // box marked «только числа» publishes a number, any other publishes its text. `encodeField`
  // refuses anything but a number for an `f64` (`CustomCodec.ts:270`) and `compare` refuses to
  // order "17" against 10, so a packet reading a text box is a throw when the button is pressed.
  // The studio settles it with `Number(ui.X.GetText()) || 0` (`addon.mjs:191`); this grammar has no
  // `num()` to write that with, so the coercion belongs where the value is published — and the one
  // place the mismatch is knowable at load time says so.
  assert.equal(widgetById(result.window, "input-1").stateKind, "number");
  const text = parse(window({
    children: [
      { id: "input-1", type: "EditBox", width: 10, height: 10 },
      { id: "send", type: "Button", width: 10, height: 10, action: { type: "sendPacket", valueFrom: "input-1" } },
    ],
  }, { packets: { enabled: true, opcodeIn: 4002, opcodeOut: 4001 } }));
  assert.ok(text.window, "the window still loads: the author is told, not shut out");
  assert.equal(widgetById(text.window, "input-1").stateKind, "text");
  assert.equal(text.problems.length, 1, text.problems.join("; "));
  assert.ok(text.problems[0].includes("только числа"), text.problems[0]);
  assert.ok(text.problems[0].includes("input-1"), text.problems[0]);

  // The check reaches every list a widget can carry and both branches of an `if`, not only a
  // button's own actions — a checkbox that sends a packet is the same trap.
  const nested = parse(window({
    children: [
      { id: "qty", type: "EditBox", width: 1, height: 1 },
      {
        id: "chk", type: "CheckButton", width: 1, height: 1,
        actions: [{
          do: "if", when: "{player.combat}",
          else: [{ do: "sendCustomRaw", opcode: 4001, fields: [{ type: "f64", value: "{state.qty}" }] }],
        }],
      },
    ],
  }));
  assert.equal(nested.problems.length, 1, nested.problems.join("; "));
  assert.ok(nested.problems[0].includes("test/probe.chk"), nested.problems[0]);
  assert.ok(nested.problems[0].includes("только числа"), nested.problems[0]);

  // A `state` key that is not an input at all is nobody's business here: `params.state` holds
  // numbers as often as text, and М6 is what fills it.
  const plain = parse(window({
    children: [{ id: "send", type: "Button", width: 10, height: 10, action: { type: "sendPacket", valueFrom: "page" } }],
  }, { packets: { enabled: true, opcodeIn: 0, opcodeOut: 4001 }, state: { page: 1 } }));
  assert.deepEqual(plain.problems, []);

  // With no opcode anywhere, the action is refused rather than sent to opcode zero — the same
  // complaint the studio's generator makes (`addon.mjs:194`).
  const noOpcode = parse(window({ children: [{ id: "send", type: "Button", width: 1, height: 1, action: { type: "sendPacket", value: 1 } }] }));
  assert.ok(noOpcode.window);
  assert.deepEqual(widgetById(noOpcode.window, "send").actions, []);
  assert.ok(noOpcode.problems[0].includes("opcode 0"), noOpcode.problems[0]);
});

test("the twelve named bindings are expressions over the published view, and a bar refuses a wordless one", () => {
  for (const binding of WINDOW_BINDINGS) {
    for (const source of [binding.value, binding.max, binding.caption]) {
      if (!source) continue;
      const parsed = parseExpression(source);
      assert.ok(parsed.ast, `${binding.name}: «${source}» — ${parsed.problems.join("; ")}`);
      for (const root of expressionRoots(parsed.ast)) {
        assert.ok(WINDOW_STATE_ROOTS.includes(root), `${binding.name} reads "${root}", which nothing publishes`);
      }
    }
  }

  const bars = parse(window({
    children: [
      { id: "hp", type: "StatusBar", width: 10, height: 10, bind: "playerHealth", value: 65, max: 100 },
      { id: "name", type: "Text", width: 10, height: 10, bind: "playerName", text: { ru: "заглушка", en: "" } },
    ],
  }));
  assert.deepEqual(bars.problems, []);
  const bar = widgetById(bars.window, "hp");
  const scope = { player: { health: 3140, maxHealth: 4200, name: "Тестер" } };
  // The binding wins over the design-time preview the studio also saves.
  assert.equal(evaluate(bar.value, scope), 3140);
  assert.equal(evaluate(bar.max, scope), 4200);
  assert.equal(evaluate(bar.caption, scope), "3140 / 4200");
  assert.equal(bar.bind, "playerHealth");
  assert.equal(evaluate(widgetById(bars.window, "name").text, scope), "Тестер");

  // `playerName` has `bar: false` in the studio's own table: there is no number behind it.
  const wrong = parse(window({ children: [{ id: "hp", type: "StatusBar", width: 1, height: 1, bind: "playerName", value: 5 }] }));
  assert.ok(wrong.window);
  assert.equal(evaluate(widgetById(wrong.window, "hp").value, scope), 5, "the literal stands");
  assert.ok(wrong.problems[0].includes("playerName"), wrong.problems[0]);

  const stranger = parse(window({ children: [{ id: "hp", type: "StatusBar", width: 1, height: 1, bind: "playerFatigue" }] }));
  assert.ok(stranger.problems[0].includes("playerFatigue") && stranger.problems[0].includes("playerHealth"), stranger.problems[0]);
});

/* ---------------------------------------------------------------------------------------------
 * Refusals
 * ------------------------------------------------------------------------------------------- */

test("two widgets with one id refuse the window, and the problem names the id", () => {
  const result = parse(window({
    children: [
      { id: "gold", type: "Text", width: 10, height: 10 },
      { id: "gold", type: "Text", width: 10, height: 10 },
    ],
  }));
  assert.equal(result.window, undefined, "there is no half-built window");
  assert.ok(result.problems.some((problem) => problem.includes('"gold"')), result.problems.join("; "));
});

test("an anchor may name its parent or an earlier sibling, and nothing else", () => {
  const child = (id, relativeTo) => ({
    id, type: "Text", width: 10, height: 10,
    anchor: { point: "LEFT", relativeTo, relativePoint: "RIGHT", x: 0, y: 0 },
  });

  const backwards = parse(window({ children: [child("a", "parent"), child("b", "a")] }));
  assert.deepEqual(backwards.problems, []);
  assert.equal(widgetById(backwards.window, "b").anchor.relativeTo, "a");

  // Forwards: the studio's generator would sort the children so this resolves (`addon.mjs:57-81`),
  // but sibling order is draw order inside a layer, and reordering to satisfy an anchor would make
  // the WebClient and the Lua addon disagree about the same file.
  const forwards = parse(window({ children: [child("a", "b"), child("b", "parent")] }));
  assert.equal(forwards.window, undefined);
  assert.ok(forwards.problems[0].includes("declared later"), forwards.problems[0]);
  assert.ok(forwards.problems[0].includes('"b"') && forwards.problems[0].includes("test/probe.a"), forwards.problems[0]);

  // A widget from another frame is not a sibling, whichever order it comes in.
  const foreign = parse(window({
    children: [
      { id: "box", type: "Frame", width: 10, height: 10, children: [child("inner", "parent")] },
      child("outer", "inner"),
    ],
  }));
  assert.equal(foreign.window, undefined);
  assert.ok(foreign.problems[0].includes("not one of its siblings"), foreign.problems[0]);

  // Itself is not an earlier sibling either.
  assert.equal(parse(window({ children: [child("a", "a")] })).window, undefined);
});

test("a file this client cannot read is refused, and the reason names the field", () => {
  const cases = [
    [{ ...window({}), format: 2 }, '"format" is 2'],
    [{ ...window({}), kind: "patch" }, '"kind" is "patch"'],
    [{ ...window({}), id: "не имя" }, '"id" is "не имя"'],
    [{ ...window({}), params: {} }, '"params.screen" is missing'],
    [{ ...window({}), params: { screen: { id: "root", type: "Texture", width: 1, height: 1 } } }, 'root of a window has to be a Frame'],
    ["not an object", "must be a JSON object"],
  ];
  for (const [definition, needle] of cases) {
    const result = parse(definition);
    assert.equal(result.window, undefined, needle);
    assert.ok(result.problems.some((problem) => problem.includes(needle)), `${needle}: ${result.problems.join("; ")}`);
  }
  // `format: 1` is the one this client reads, and absent means 1.
  assert.ok(parse({ ...window({}), format: 1 }).window);
});

test("the studio's other kind of file is refused by what it is, not by what it lacks", () => {
  // The studio saves both a screen and a set of edits to the client's own frames under
  // `kind: "addon"`, told apart by `params.mode` (`server/addon.mjs:38`). Saying "screen is
  // missing" about the second would send its author looking for a screen that was never there.
  const tweaks = { kind: "addon", id: "pravki", name: { ru: "Правки", en: "" }, params: { mode: "blizzard", tweaks: [{ name: "PlayerFrame", hide: true }] } };
  const result = parse(tweaks);
  assert.equal(result.window, undefined);
  assert.ok(result.problems[0].includes("blizzard"), result.problems[0]);
  assert.ok(result.problems[0].includes("slots"), result.problems[0]);
});

test("`inherits` is refused out loud, because there is no FrameXML here", () => {
  // The studio offers any client template by name and then reaches its parts through `_G`
  // (`web/designer.mjs:681-683`). Dropping the field silently would leave a portrait frame that
  // came for free in the Lua addon simply missing, with nothing said.
  const result = parse(window({ children: [{ id: "box", type: "Frame", width: 10, height: 10, inherits: "PortraitFrameTemplate" }] }));
  assert.ok(result.window, "the frame is still drawn, just plain");
  assert.ok(widgetById(result.window, "box"));
  assert.equal(result.problems.length, 1);
  assert.ok(result.problems[0].includes("PortraitFrameTemplate"), result.problems[0]);
  assert.ok(result.problems[0].includes("FrameXML"), result.problems[0]);
  assert.deepEqual(parse(window({ children: [{ id: "box", type: "Frame", width: 10, height: 10 }] })).problems, []);
});

test("a message that could never be sent refuses the window, naming the field it outgrows at", () => {
  // Reuses М2's own rule: a fixed outbound message over CUSTOM_MAX_SEND_BODY can only ever close
  // the socket, so the complaint belongs at load time.
  const fields = Array.from({ length: 11 }, (_value, index) => ({
    name: `pad${index}`, type: "array", capacity: 255, of: { type: "u32" },
  }));
  const result = parse(window({}, {
    messages: [{ name: "probe.Huge", opcode: 4001, direction: "out", fields }],
  }));
  assert.equal(CUSTOM_MAX_SEND_BODY, 10_229);
  assert.equal(result.window, undefined);
  assert.ok(result.problems[0].includes("pad10"), result.problems[0]);
  assert.ok(result.problems[0].includes("10229"), result.problems[0]);

  // A message that fits loads, and comes back on the window for М6 to register.
  const fine = parse(window({}, {
    messages: { messages: [{ name: "probe.State", opcode: 4002, direction: "in", fields: [{ name: "gold", type: "u32" }] }] },
  }));
  assert.deepEqual(fine.problems, []);
  assert.equal(fine.window.messages.length, 1);
  assert.equal(fine.window.messages[0].name, "probe.State");
});

/* ---------------------------------------------------------------------------------------------
 * The optional additions
 * ------------------------------------------------------------------------------------------- */

test("the additions are all optional and all parse", () => {
  const result = parse(window({
    children: [
      {
        id: "row", type: "Frame", width: 10, height: 10, className: "shop-row",
        repeat: { over: "{party}", as: "member", limit: 5 },
        children: [{ id: "who", type: "Text", width: 10, height: 10, text: "{member.name}" }],
      },
      { id: "hp", type: "StatusBar", width: 10, height: 10, bind: "{player.health}", max: 200 },
      { id: "go", type: "Button", width: 10, height: 10, enabled: "{player.level > 10}", slot: "target-frame/actions" },
    ],
  }, {
    binding: "KeyU",
    state: { page: 1, filter: "{player.name}" },
    css: ".shop-row { color: gold; }",
    messages: [{ name: "probe.Buy", opcode: 4003, direction: "out", fields: [{ name: "entry", type: "u32" }] }],
  }));
  assert.deepEqual(result.problems, []);
  const { window: parsed } = result;

  assert.equal(parsed.binding, "KeyU");
  assert.equal(parsed.css, ".shop-row { color: gold; }");
  assert.equal(evaluate(parsed.state.page, {}), 1);
  assert.equal(evaluate(parsed.state.filter, { player: { name: "Тестер" } }), "Тестер");

  const row = widgetById(parsed, "row");
  assert.equal(row.className, "shop-row");
  assert.equal(row.repeat.as, "member");
  assert.equal(row.repeat.limit, 5);
  assert.deepEqual(evaluate(row.repeat.over, { party: [1, 2] }), [1, 2]);
  assert.equal(evaluate(widgetById(parsed, "who").text, { member: { name: "Второй" } }), "Второй");

  const bar = widgetById(parsed, "hp");
  assert.equal(evaluate(bar.value, { player: { health: 40 } }), 40, "an expression bind fills the value");
  assert.equal(evaluate(bar.max, {}), 200, "and leaves the maximum alone");
  assert.equal(bar.bind, undefined);

  const button = widgetById(parsed, "go");
  assert.equal(evaluate(button.enabled, { player: { level: 20 } }), true);
  assert.equal(evaluate(button.enabled, { player: { level: 5 } }), false);
  assert.equal(button.slot, "target-frame/actions");
});

test("a repeat is bounded, whatever the file asks for", () => {
  // A list from the game is bounded by the game; a list from an expression is not, and a runaway
  // one is a frozen frame rather than a long window.
  const result = parse(window({
    children: [{ id: "row", type: "Frame", width: 1, height: 1, repeat: { over: "party", as: "m", limit: 10_000 } }],
  }));
  assert.ok(result.window);
  assert.equal(widgetById(result.window, "row").repeat.limit, WINDOW_MAX_REPEAT);
  assert.ok(result.problems[0].includes(String(WINDOW_MAX_REPEAT)), result.problems[0]);

  // Both spellings of `over` are read, because there is nothing else it could be.
  const bare = parse(window({ children: [{ id: "r", type: "Frame", width: 1, height: 1, repeat: { over: "raid", as: "m" } }] }));
  assert.deepEqual(bare.problems, []);
  assert.deepEqual(expressionRoots(widgetById(bare.window, "r").repeat.over), ["raid"]);

  // A repeat with nothing to repeat over is a fault, and it takes its own widget with it.
  const empty = parse(window({ children: [{ id: "r", type: "Frame", width: 1, height: 1, repeat: { as: "m" } }] }));
  assert.equal(widgetById(empty.window ?? { screen: { children: [] } }, "r"), undefined);
});

test("an action list in the new spelling parses, and an unknown command is refused by name", () => {
  const result = parse(window({
    children: [{
      id: "go", type: "Button", width: 1, height: 1,
      actions: [
        { do: "setState", key: "page", value: "{state.page + 1}" },
        { do: "if", when: "{player.combat}", then: [{ do: "close", window: "" }], else: [{ do: "sound", kit: "igMainMenuOpen" }] },
        { do: "command", name: "selectTarget", args: ["{target.guid}"] },
        { do: "sendCustom", message: "probe.Buy", value: { entry: "{state.page}" } },
      ],
    }],
  }));
  assert.deepEqual(result.problems, []);
  const actions = widgetById(result.window, "go").actions;
  assert.deepEqual(actions.map((action) => action.do), ["setState", "if", "command", "sendCustom"]);
  assert.equal(evaluate(actions[0].value, { state: { page: 2 } }), 3);
  assert.equal(actions[1].then[0].do, "close");
  assert.equal(actions[1].otherwise[0].kit, "igMainMenuOpen");
  assert.equal(actions[2].name, "selectTarget");
  assert.equal(actions[3].message, "probe.Buy");
  assert.equal(evaluate(actions[3].value.entry, { state: { page: 4 } }), 4);
  // Every action list is inert data, like every expression in it.
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), actions);

  const forbidden = parse(window({
    children: [{ id: "go", type: "Button", width: 1, height: 1, actions: [{ do: "command", name: "deleteCharacter" }] }],
  }));
  assert.ok(forbidden.window);
  assert.deepEqual(widgetById(forbidden.window, "go").actions, []);
  assert.ok(forbidden.problems[0].includes("deleteCharacter"), forbidden.problems[0]);
  assert.ok(WINDOW_COMMANDS.includes("selectTarget") && !WINDOW_COMMANDS.includes("deleteCharacter"));
});

test("the screen's events are read in both spellings", () => {
  const result = parse(window({
    events: ["PLAYER_ENTERING_WORLD", { event: "PLAYER_TARGET_CHANGED", do: [{ do: "close", window: "" }] }, "не событие"],
  }));
  assert.ok(result.window);
  assert.deepEqual(result.window.screen.events.map((entry) => entry.event), ["PLAYER_ENTERING_WORLD", "PLAYER_TARGET_CHANGED"]);
  assert.deepEqual(result.window.screen.events[1].actions, [{ do: "close", window: "" }]);
  assert.equal(result.problems.length, 1);
  assert.ok(result.problems[0].includes("events[2]"), result.problems[0]);
});

test("a widget whose expression will not parse is dropped, named, and takes nobody with it", () => {
  const result = parse(window({
    children: [
      { id: "good", type: "Text", width: 1, height: 1, text: "{player.name}" },
      { id: "bad", type: "Text", width: 1, height: 1, text: "{player.name +}" },
    ],
  }));
  assert.ok(result.window, "one bad label does not hide the window");
  assert.ok(widgetById(result.window, "good"));
  assert.equal(widgetById(result.window, "bad"), undefined);
  assert.ok(result.problems[0].includes("test/probe.bad"), result.problems[0]);

  // The same rule reaches inside an action. A button that is drawn and can never do anything is
  // harder to notice than a button that is not there.
  const inAction = parse(window({
    children: [{ id: "go", type: "Button", width: 1, height: 1, actions: [{ do: "chat", text: "{player.name +}" }] }],
  }));
  assert.ok(inAction.window);
  assert.equal(widgetById(inAction.window, "go"), undefined);
  assert.ok(inAction.problems[0].includes("go"), inAction.problems[0]);
});

test("the root frame plays by that rule too, and dropping the root is refusing the window", () => {
  // Every one of these left the window standing before. The third is what the rule is for: the
  // action survived with an empty text and posted a blank chat line on every PLAYER_LOGIN.
  const cases = [
    [window({ title: "{player.name +}" }), '"title"'],
    [window({}, { state: { page: "{1 +}" } }), '"page"'],
    [window({ events: [{ event: "PLAYER_LOGIN", do: [{ do: "chat", text: "{player.name +}" }] }] }), '"text"'],
    [{ ...window({}), name: "{player.name +}" }, '"name"'],
  ];
  for (const [definition, needle] of cases) {
    const result = parse(definition);
    assert.equal(result.window, undefined, needle);
    assert.ok(result.problems.some((problem) => problem.includes(needle)), `${needle}: ${result.problems.join("; ")}`);
    assert.ok(result.problems.some((problem) => problem.includes("refused")), `${needle}: ${result.problems.join("; ")}`);
  }

  // And the same fields with expressions that do parse are silent.
  const fine = parse(window({
    title: "{player.name}",
    events: [{ event: "PLAYER_LOGIN", do: [{ do: "chat", text: "{player.name}" }] }],
  }, { state: { page: "{1 + 1}" } }));
  assert.deepEqual(fine.problems, []);
  assert.equal(evaluate(fine.window.state.page, {}), 2);
});

test("a widget anchored to one that was dropped is named too, and falls back to its parent", () => {
  // The second half of dropping a widget. The anchor was checked against the ids the *file*
  // declares, so the drop was recorded and its consequence was not — leaving М5 to place an orphan
  // somewhere without being told why.
  const result = parse(window({
    children: [
      { id: "ghost", type: "Cooldown", width: 1, height: 1 },
      { id: "after", type: "Text", width: 1, height: 1, anchor: { point: "TOP", relativeTo: "ghost", relativePoint: "BOTTOM", x: 0, y: 0 } },
    ],
  }));
  assert.ok(result.window);
  assert.equal(widgetById(result.window, "after").anchor.relativeTo, "parent");
  assert.equal(widgetById(result.window, "after").anchor.point, "TOP", "only the target changes");
  assert.equal(result.problems.length, 2, result.problems.join("; "));
  assert.ok(result.problems[0].includes("Cooldown"), result.problems[0]);
  assert.ok(result.problems[1].includes("test/probe.after") && result.problems[1].includes('"ghost"'), result.problems[1]);

  // An anchor onto a sibling that survived is left exactly where it was.
  const kept = parse(window({
    children: [
      { id: "first", type: "Text", width: 1, height: 1 },
      { id: "after", type: "Text", width: 1, height: 1, anchor: { point: "TOP", relativeTo: "first", relativePoint: "BOTTOM", x: 0, y: 0 } },
    ],
  }));
  assert.deepEqual(kept.problems, []);
  assert.equal(widgetById(kept.window, "after").anchor.relativeTo, "first");
});

test("a slash command may be written in the alphabet the realm speaks", () => {
  // The studio is a Russian tool for a Russian realm, and `/магазин` is the first thing a real file
  // will ask for. Nothing downstream objects: `submitChat` takes whatever follows the slash,
  // lowercases it and looks it up (`Chat.ts:363-390`). An ASCII-only filter turned «магазин» into
  // the empty string and «shop-магазин» into a different, working-looking `/shop-`, both in silence.
  const shop = parse(window({}, { slash: "/Магазин", binding: "КлавишаЖ" }));
  assert.deepEqual(shop.problems, []);
  assert.equal(shop.window.slash, "магазин", "the leading slash goes, the case goes, the letters stay");
  assert.equal(shop.window.binding, "КлавишаЖ", "a binding keeps its case: it is a key name, not a command");

  // What is still dropped is named, so that the author and М9's `modules:check` both see it.
  const spaced = parse(window({}, { slash: "открыть лавку!" }));
  assert.equal(spaced.window.slash, "открытьлавку");
  assert.equal(spaced.problems.length, 1);
  assert.ok(spaced.problems[0].includes("открыть лавку!"), spaced.problems[0]);
  assert.ok(spaced.problems[0].includes("открытьлавку"), spaced.problems[0]);
});

test("the CSS ceiling is counted in the bytes the gateway counts", () => {
  // `String.length` counts UTF-16 code units; the route that serves the file counts its real size
  // (`ModuleIndex.ts:90`). A Cyrillic stylesheet is two bytes a character, so the old check passed
  // a file at twice the limit and printed a number that was never bytes.
  const cyrillic = "я".repeat(WINDOW_MAX_CSS / 2 + 1);
  assert.ok(cyrillic.length < WINDOW_MAX_CSS, "under the limit in code units");
  assert.ok(new TextEncoder().encode(cyrillic).length > WINDOW_MAX_CSS, "over it in bytes");
  const result = parse(window({}, { css: cyrillic }));
  assert.equal(result.window, undefined);
  assert.ok(result.problems[0].includes(String(new TextEncoder().encode(cyrillic).length)), result.problems[0]);

  // A stylesheet that fits comes through whole, Cyrillic and all.
  const fine = parse(window({}, { css: ".shop { content: 'лавка'; }" }));
  assert.deepEqual(fine.problems, []);
  assert.equal(fine.window.css, ".shop { content: 'лавка'; }");
});
