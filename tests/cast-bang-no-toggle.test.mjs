import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/*
 * L18-review (04.10, 5.05): `/cast !Auto Shot` — the hunter's macro line. The stock SLASH_CAST hands the
 * action to CastSpellByName with its "!" (ChatFrame.lua SecureCmdList.CAST), and a leading "!" asks the
 * client not to toggle off a spell that already runs: an Auto Shot that repeats keeps repeating instead of
 * being cancelled by every press of a macro that also casts something else. This client's /cast
 * (ui/CombatCommands.ts, the native path and the stock CastSpellByName both) looked the name up with the
 * "!" in it — «заклинание не найдено» — so the macro did nothing at all. The autoRangedCombat controller,
 * on by default since L18, wants the same shot: with "!" a press never cancels it.
 *
 * CombatCommands is transpiled from its source with its page-bound imports replaced, as
 * tests/macro-native.test.mjs loads it.
 */

const UI = new URL("../src/browser/ui/", import.meta.url);
const options = await import("../dist/code/browser/macro/MacroOptions.js");
const context = await import("../dist/code/browser/macro/MacroContext.js");
const fields = await import("../dist/code/world/Fields.js");
const { hoveredUnitGuid } = await import("../dist/code/browser/game/HoverTarget.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

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

const AUTO_SHOT = 75;
const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;

async function hunter() {
  const self = { guid: 1n, typeId: 4, movementFlags: 0, fields: new Map([[HEALTH, 100]]) };
  const wolf = { guid: 2n, typeId: 3, movementFlags: 0, fields: new Map([[HEALTH, 100]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self], [2n, wolf]]) },
    targetGuid: 2n, group: undefined, knownSpells: [{ id: AUTO_SHOT, slot: 0 }], casts: new Map(),
    aurasFor: () => [], names: new Map(), autoRepeatSpellId: undefined,
  };
  const spell = (name) => ({ name, unitTargetContractVersion: 1, supportsExplicitUnitTarget: true });
  const game = {
    world, focusGuid: undefined, factions: undefined,
    spells: new Map([[AUTO_SHOT, spell("Автоматическая стрельба")], [56641, spell("Верный выстрел")]]),
  };
  const casts = [];
  const lines = [];
  const commands = await load("CombatCommands.ts", {
    "../game/Context.js": { game },
    "../Inventory.js": { playerInventory: () => undefined },
    "../../world/Fields.js": fields,
    "./Spellbook.js": { castSpell: (...args) => { casts.push(args[0]); return true; } },
    "../game/GroundTarget.js": { requestInventoryItemUse() {} },
    "./MacroModel.js": macroModel,
    "./Chat.js": { systemLine: (line) => lines.push(line) },
    "../game/HoverTarget.js": { hoveredUnitGuid },
    "../game/Targeting.js": { reactionBetween: (_self, other) => (other.guid === 2n ? -1 : 1) },
    "../game/BonusBar.js": { currentBonusBarOffset: () => 0 },
  });
  return { world, commands, casts, lines };
}

test("L18-review: `/cast !Автоматическая стрельба` starts the shot and never cancels a running one", async () => {
  const { world, commands, casts, lines } = await hunter();
  commands.runCastCommand("/cast !Автоматическая стрельба");
  assert.deepEqual(casts, [AUTO_SHOT], "the name is found without its '!'");
  assert.deepEqual(lines, []);
  world.autoRepeatSpellId = AUTO_SHOT; // it repeats now
  commands.runCastCommand("/cast !Автоматическая стрельба");
  commands.runCastCommand("!75");
  assert.deepEqual(casts, [AUTO_SHOT], "a running repeat is left alone: no toggle-off cast");
  assert.deepEqual(lines, []);
  // Without the '!' the press is the toggle it always was.
  commands.runCastCommand("/cast Автоматическая стрельба");
  assert.deepEqual(casts, [AUTO_SHOT, AUTO_SHOT]);
});

test("L18-review: the '!' goes with the clause the options pick, and other spells cast as usual", async () => {
  const { world, commands, casts } = await hunter();
  world.autoRepeatSpellId = AUTO_SHOT;
  commands.runCastCommand("/cast [harm] !Автоматическая стрельба; Верный выстрел");
  commands.runCastCommand("/cast !Верный выстрел");
  assert.deepEqual(casts, [56641], "the repeat untouched; Steady Shot cast, its '!' dropped");
});
