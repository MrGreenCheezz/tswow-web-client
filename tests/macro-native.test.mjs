import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// The native macro path (3.10): MacroModel's checks, CombatCommands' /cast and /use, and Macros'
// runMacro — each transpiled from its source with its page-bound imports replaced, as
// macro-targeting.test.mjs loads CombatCommands — over the real evaluator, context and runner.
const UI = new URL("../src/browser/ui/", import.meta.url);
const options = await import("../dist/code/browser/macro/MacroOptions.js");
const context = await import("../dist/code/browser/macro/MacroContext.js");
const runner = await import("../dist/code/browser/macro/MacroRunner.js");
const { pageModifiers } = await import("../dist/code/browser/input/Modifiers.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const fields = await import("../dist/code/world/Fields.js");
const { hoveredUnitGuid } = await import("../dist/code/browser/game/HoverTarget.js");

async function load(file, modules) {
  const source = await readFile(new URL(file, UI), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", js)((name) => modules[name] ?? {}, exports);
  return exports;
}

const macroModel = await load("MacroModel.ts", {
  "../macro/MacroOptions.js": options, "../macro/MacroContext.js": context,
});

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;

function scene() {
  const self = { guid: 1n, typeId: 4, movementFlags: 0, fields: new Map([[HEALTH, 100]]) };
  const wolf = { guid: 2n, typeId: 3, movementFlags: 0, fields: new Map([[HEALTH, 100]]) };
  const priest = { guid: 3n, typeId: 4, movementFlags: 0, fields: new Map([[HEALTH, 100]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self], [2n, wolf], [3n, priest]]) },
    targetGuid: 2n,
    group: { groupType: 0, members: [{ guid: 3n, name: "Жрец" }] },
    knownSpells: [], casts: new Map(), aurasFor: () => [], names: new Map([[3n, "Жрец"]]),
    selectTarget() { throw new Error("a macro never retargets the world"); },
  };
  const spell = (name) => ({ name, unitTargetContractVersion: 1, supportsExplicitUnitTarget: true });
  const game = {
    world, focusGuid: 3n, factions: undefined,
    spells: new Map([[133, spell("Огненный шар")], [116, spell("Ледяная стрела")], [2061, spell("Быстрое исцеление")]]),
  };
  return { game, world, self, wolf, priest };
}

async function combatCommands(game, casts, lines, bonusBar = () => 0) {
  return load("CombatCommands.ts", {
    "../game/Context.js": { game },
    "../Inventory.js": { playerInventory: () => undefined },
    "../../world/Fields.js": fields,
    "./Spellbook.js": { castSpell: (...args) => { casts.push(args); return true; } },
    "../game/GroundTarget.js": { requestInventoryItemUse() {} },
    "./MacroModel.js": macroModel,
    "./Chat.js": { systemLine: (line) => lines.push(line) },
    "../game/HoverTarget.js": { hoveredUnitGuid },
    // The wolf is hostile, everyone else friendly.
    "../game/Targeting.js": { reactionBetween: (_self, other) => (other.guid === 2n ? -1 : 1) },
    "../game/BonusBar.js": { currentBonusBarOffset: bonusBar },
  });
}

function withShift(action) {
  pageModifiers().key({ code: "ShiftLeft", type: "keydown", shiftKey: true });
  try {
    return action();
  } finally {
    pageModifiers().key({ code: "ShiftLeft", type: "keyup", shiftKey: false });
  }
}

test("macroProblems checks what cannot be read and no longer refuses conditions", () => {
  const problems = (body) => macroModel.macroProblems("Макрос", body);
  assert.deepEqual(problems("/cast [mod:shift] A; B"), []);
  assert.deepEqual(problems("#showtooltip\n/cast [@mouseover,help,nodead][help,nodead] Лечение"), []);
  assert.deepEqual(problems("/stopmacro [combat]\n/cast [nomod] 133\n/dance"), []);
  assert.deepEqual(problems("/cast [@party2,help][@raid7target][@targettarget] 2061"), [], "party, raid and …target units");
  assert.deepEqual(problems("/use [mod:shift] 13; 14"), []);
  assert.deepEqual(problems("/say [нужен танк]"), [], "a chat line's closed brackets are its text");
  assert.ok(problems("/cast [mod:shift A").some((line) => line.includes("не закрыта скобка")));
  assert.ok(problems("/stopmacro [combat").some((line) => line.includes("не закрыта скобка")), "every secure command's options");
  assert.deepEqual(problems("/cast [@] 133"), [], "an empty target is no target, as the client reads it");
  assert.deepEqual(problems("/cast [target=,harm] 133"), []);
  assert.ok(problems("/cast [@arena1] 133").some((line) => line.includes("Цель [@…]")), "a unit /cast cannot resolve");
  assert.ok(problems("/use [@focus] 13").some((line) => line.includes("/use")), "an addressed /use");
  assert.ok(problems("/cast [combat]").some((line) => line.includes("Формат")), "no action at all");
  // Every line runs, as in the client; the cast guard decides what a press may send (below).
  assert.deepEqual(problems("/cast 133\n/cast 116"), []);
  assert.deepEqual(problems("/cast [mod:shift] 133\n/cast [nomod] 116\n/use 6948"), []);
});

test("native /cast casts the clause the conditions pick, silently nothing when none holds", async () => {
  const { game, self, wolf } = scene();
  const casts = [];
  const lines = [];
  const commands = await combatCommands(game, casts, lines);
  commands.runCastCommand("[mod:shift] Огненный шар; Ледяная стрела");
  withShift(() => commands.runCastCommand("/cast [mod:shift] Огненный шар; Ледяная стрела"));
  assert.deepEqual(casts, [[116, undefined], [133, undefined]]);
  casts.length = 0;
  commands.runCastCommand("[harm] Огненный шар; Быстрое исцеление");
  commands.runCastCommand("[@focus,help][@target] Быстрое исцеление");
  commands.runCastCommand("[@party1,nodead] Быстрое исцеление");
  assert.deepEqual(casts, [[133, undefined], [2061, 3n], [2061, 3n]], "a group's target is cast at, the selection kept");
  casts.length = 0;
  wolf.fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, 3);
  commands.runCastCommand("[@targettarget,help] Быстрое исцеление");
  assert.deepEqual(casts, [[2061, 3n]], "the target's own target");
  casts.length = 0;
  commands.runCastCommand("[combat] 133; 116");
  self.fields.set(FLAGS, 0x80000);
  commands.runCastCommand("[combat] 133; 116");
  commands.runCastCommand("[nocombat] 133");
  assert.deepEqual(casts, [[116, undefined], [133, undefined]]);
  assert.deepEqual(lines, [], "a macro whose conditions all fail does nothing and says nothing");
  commands.runCastCommand("[mod:shift Огненный шар");
  assert.match(lines.at(-1), /не закрыта скобка/);
  commands.runCastCommand("[@focus] Огненный шар");
  assert.deepEqual(casts.at(-1), [133, 3n]);
  // The native window's old form, a [@unit] after the name, still names the target.
  casts.length = 0;
  commands.runCastCommand("Огненный шар [@focus]");
  assert.deepEqual(casts, [[133, 3n]]);
  // An empty last clause is «nothing this press», not a usage error every press.
  const linesBefore = lines.length;
  const castsBefore = casts.length;
  commands.runCastCommand("[mod:shift] Огненный шар;");
  assert.equal(lines.length, linesBefore);
  assert.equal(casts.length, castsBefore);
  commands.runUseCommand("[mod:shift] 6948; [@focus] 6948");
  assert.match(lines.at(-1), /\/use пока не поддерживается/, "/use evaluates its own options first");
});

test("the native context reads stances, the bonus bar, stealth and the pet from the world", async () => {
  const { game, world, self } = scene();
  const casts = [];
  let bonusBar = 0;
  const commands = await combatCommands(game, casts, [], () => bonusBar);
  game.spells.set(2457, {
    name: "Боевая стойка", iconPath: "Interface\\Icons\\Ability_Warrior_OffensiveStance", passive: false,
    stanceBarOrder: 0, effectAura: [36, 0, 0], effectMiscValue: [17, 0, 0], spellLevel: 1,
  });
  world.knownSpells = [{ id: 2457, slot: 0 }];
  commands.runCastCommand("[stance:1] 133; 116");
  self.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 17 << 24);
  commands.runCastCommand("[stance:1] 133; 116");
  commands.runCastCommand("[bonusbar:1] 133; 116");
  bonusBar = 1;
  commands.runCastCommand("[bonusbar:1] 133; 116");
  commands.runCastCommand("[stealth] 133; 116");
  self.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, 0x02 << 16);
  commands.runCastCommand("[stealth] 133; 116");
  commands.runCastCommand("[pet] 133; 116");
  world.petSpells = { guid: 3n, creatureFamily: 1 };
  commands.runCastCommand("[pet:жрец] 133; 116");
  game.talentData = { petFamilyName: (family) => (family === 1 ? "Волк" : undefined), spellAbilitiesOf: () => undefined };
  commands.runCastCommand("[pet:волк] 133; 116");
  assert.deepEqual(casts.map(([id]) => id), [116, 133, 116, 133, 116, 133, 116, 133, 133]);
  // A paladin aura or a DK presence on the stance bar is no form: GetShapeshiftForm(true) is 0.
  casts.length = 0;
  game.spells.set(465, {
    name: "Аура благочестия", iconPath: "Interface\\Icons\\Spell_Holy_DevotionAura", passive: false,
    stanceBarOrder: 0, displayInStanceBar: true, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 1,
  });
  world.knownSpells = [{ id: 465, slot: 0 }];
  world.aurasFor = () => [{ spellId: 465, casterGuid: 1n }];
  self.fields.delete(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset);
  commands.runCastCommand("[stance:1] 133; [stance:0] 116");
  assert.deepEqual(casts.map(([id]) => id), [116]);
});

test("ActionBar.useSlot hands the macro the button that pressed it", async () => {
  const { isolatedUi } = await import("./fixtures/isolated-ui.mjs");
  const { ACTION_BUTTON_MACRO } = await import("../dist/code/world/ActionBarProtocol.js");
  const runs = [];
  const world = { actionButtons: [{ slot: 0, action: 37, type: ACTION_BUTTON_MACRO }], knownSpells: [] };
  const bar = await isolatedUi("ActionBar", {
    "../game/Context.js": { game: { world, spells: new Map() } },
    "./Macros.js": {
      macroAt: (index) => ({ index, name: "Огонь", body: "/dance" }),
      runMacro: (index, button) => runs.push([index, button ?? null]),
    },
    "./MacroModel.js": macroModel,
    "../../world/ActionBarProtocol.js": await import("../dist/code/world/ActionBarProtocol.js"),
  });
  bar.useSlot(0, 0, "RightButton");
  bar.useSlot(0, 0);
  assert.deepEqual(runs, [[37, "RightButton"], [37, null]]);
});

async function nativeMacros(commands, chat, notices) {
  const stores = [];
  class AccountStore {
    constructor(config) { this.value = config.fallback(); stores.push(this); }
    set(value) { this.value = value; }
    flush() {}
  }
  const macros = await load("Macros.ts", {
    "../AccountStore.js": { AccountStore },
    "../../world/SessionProtocol.js": { GLOBAL_MACROS_CACHE: 5, PER_CHARACTER_MACROS_CACHE: 6 },
    "../framexml/FrameXmlMacroController.js": {
      closeFrameXmlMacro() {}, frameXmlMacroOpen: () => false, openFrameXmlMacro: () => false, toggleFrameXmlMacro: () => false,
    },
    "../macro/MacroRunner.js": runner,
    "./Chat.js": { submitChat: chat },
    "./CombatCommands.js": commands,
    "./Notices.js": { notice: (text) => notices.push(text) },
    "./MacroModel.js": macroModel,
    "./Widgets.js": { Panel: class {}, Tabs: class {}, confirmPanel() {} },
  });
  return { macros, stores };
}

test("runMacro runs the slash lines through the one runner: conditions choose, /stopmacro stops, the stock chat takes over", async () => {
  const { game } = scene();
  const casts = [];
  const commands = await combatCommands(game, casts, []);
  const chat = [];
  const notices = [];
  // What the native chat does with a line: /cast goes to the combat commands.
  const submitChat = (line) => {
    if (line.startsWith("/cast ")) commands.runCastCommand(line.slice("/cast ".length));
    else chat.push(line);
  };
  const { macros, stores } = await nativeMacros(commands, submitChat, notices);
  stores[0].value = [{
    index: 1, name: "Огонь", body: "#showtooltip\n/cast [mod:shift] Огненный шар; Ледяная стрела\n/stopmacro [nomod]\n/dance\nпривет",
  }, { index: 2, name: "Сломан", body: "/cast [mod:shift Огненный шар" }];

  macros.runMacro(1);
  assert.deepEqual(casts, [[116, undefined]]);
  assert.deepEqual(chat, [], "/stopmacro [nomod] held, so neither /dance nor «привет» ran");
  withShift(() => macros.runMacro(1));
  assert.deepEqual(casts, [[116, undefined], [133, undefined]]);
  assert.deepEqual(chat, ["/dance", "привет"], "a line without / goes to the chat as before: the client says it");
  assert.deepEqual(notices, []);

  macros.runMacro(2);
  assert.equal(casts.length, 2, "a macro that cannot be read runs nothing");
  assert.match(notices.at(-1), /не закрыта скобка/);

  // A stock chat able to evaluate conditions takes the lines, with the button that started the run.
  const stock = [];
  const uninstall = runner.installMacroLineExecutor((line) => stock.push([line, runner.macroRunButton() ?? null]));
  try {
    macros.runMacro(1, "RightButton");
  } finally {
    uninstall();
  }
  assert.deepEqual(stock, [
    ["/cast [mod:shift] Огненный шар; Ледяная стрела", "RightButton"], ["/stopmacro [nomod]", "RightButton"],
    ["/dance", "RightButton"], ["привет", "RightButton"],
  ]);
  assert.equal(casts.length, 2, "the native chat got none of them");

  // A word the client does not know holds, and is said once (ERR_UNKNOWN_MACRO_OPTION_S).
  stores[0].value = [{ index: 1, name: "Опечатка", body: "/cast [bogus] Огненный шар" }];
  macros.runMacro(1);
  macros.runMacro(1);
  assert.deepEqual(casts.slice(2), [[133, undefined], [133, undefined]]);
  assert.deepEqual(notices.filter((line) => line.includes("bogus")), ["Неизвестный параметр макроса: bogus"]);
});

/**
 * A macro whose /cast lines reach the real cast guard (SpellCastGuard.ts) and a real WorldClient:
 * Spellbook.castSpell's order — the shared guard, then the one wire request — with the packets sent.
 */
async function guardedMacros() {
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const { OPCODES } = await import("../dist/code/generated/opcodes.js");
  const { spellCastBlockReason } = await import("../dist/code/browser/SpellCastGuard.js");
  const { game } = await import("../dist/code/browser/game/Context.js");
  const packets = [];
  const connection = {
    send(opcode, payload) { if (opcode === OPCODES.CMSG_CAST_SPELL) packets.push(new DataView(payload.buffer, payload.byteOffset).getUint32(1, true)); },
    read() { return new Promise(() => {}); }, close() {},
  };
  const world = new WorldClient(connection);
  world.state.selfGuid = 1n;
  world.state.move(1n, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  world.state.objects.get(1n).typeId = 4;
  // Two spells on the global cooldown and one off it (Icy Veins, StartRecoveryTime 0).
  world.knownSpells = [{ id: 133, slot: 0 }, { id: 116, slot: 1 }, { id: 12472, slot: 2 }];
  const row = (name, gcd) => ({ name, passive: false, startRecoveryTime: gcd, recoveryTime: 0, categoryRecoveryTime: 0 });
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil };
  game.world = world;
  game.spells = new Map([[133, row("Огненный шар", 1500)], [116, row("Ледяная стрела", 1500)], [12472, row("Стылая кровь", 0)]]);
  game.globalCooldownUntil = 0;
  const castSpell = (id, unit) => {
    if (spellCastBlockReason(world, id) !== undefined) return false;
    world.castSpell(id, 0, false, unit);
    return true;
  };
  const commands = await load("CombatCommands.ts", {
    "../game/Context.js": { game }, "../../world/Fields.js": fields, "./Spellbook.js": { castSpell },
    "./MacroModel.js": macroModel, "./Chat.js": { systemLine() {} }, "../game/HoverTarget.js": { hoveredUnitGuid },
  });
  const submitChat = (line) => { if (line.startsWith("/cast ")) commands.runCastCommand(line.slice("/cast ".length)); };
  const { macros, stores } = await nativeMacros(commands, submitChat, []);
  stores[0].value = [
    { index: 1, name: "Выбор", body: "/cast [mod:shift] Огненный шар\n/cast [nomod] Ледяная стрела" },
    { index: 2, name: "Всё", body: "/cast Стылая кровь\n/cast Огненный шар\n/cast Ледяная стрела" },
  ];
  const restore = () => {
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    world.close();
  };
  return { macros, packets, game, restore };
}

test("every /cast line reaches the cast guard: exclusive lines cast one spell, a running GCD stops the rest", async () => {
  const { macros, packets, game, restore } = await guardedMacros();
  try {
    // Mutually exclusive conditions: one spell per press, whichever the keys choose.
    macros.runMacro(1);
    withShift(() => macros.runMacro(1));
    assert.deepEqual(packets, [116, 133]);
    // Unconditional lines each ask the guard. With the global cooldown running — as after an accepted
    // cast — only the spell off it is sent.
    packets.length = 0;
    game.globalCooldownUntil = performance.now() + 60_000;
    macros.runMacro(2);
    assert.deepEqual(packets, [12472], "the global cooldown stopped both spells on it");
  } finally {
    restore();
  }
});

// The client starts its global cooldown when a cast is sent, so a second spell on it in the same press
// is stopped locally. Here the cooldown starts only when the realm accepts the cast
// (SPELL_CAST_ACCEPTED, app/EnterWorld.ts), so both go out and the realm refuses the second: 5.30.
test("two unconditional /cast lines on the global cooldown send only the first", {
  todo: "5.30: a predicted local global cooldown from the moment a cast is sent",
}, async () => {
  const { macros, packets, restore } = await guardedMacros();
  try {
    macros.runMacro(2);
    assert.deepEqual(packets, [12472, 133]);
  } finally {
    restore();
  }
});
