// 1.14: which spell a macro on an action button stands for (Wow.exe 0x00565c40, 0x005650c0, read 04.11).
import assert from "node:assert/strict";
import test from "node:test";
import { macroShownArgument, macroShownName } from "../dist/code/browser/macro/MacroShownAction.js";
import { macroShownCommands } from "../dist/code/browser/framexml/FrameXmlMacroCommands.js";

const COMMANDS = new Set(["/cast", "/use", "/castsequence", "/castrandom", "/equip"]);

test("the first command with an argument, #show and #showtooltip counting as one", () => {
  assert.equal(macroShownArgument("/cast Атака", COMMANDS), "Атака");
  assert.equal(macroShownArgument("/say hi\n/cast Атака\n/cast Выстрел", COMMANDS), "Атака", "a command not on the list is passed over");
  assert.equal(macroShownArgument("#showtooltip Выстрел\n/cast Атака", COMMANDS), "Выстрел");
  assert.equal(macroShownArgument("#show Выстрел\n/cast Атака", COMMANDS), "Выстрел");
  assert.equal(macroShownArgument("#showtooltip\n/cast Атака", COMMANDS), "Атака", "a bare #showtooltip names nothing");
  assert.equal(macroShownArgument("/CAST Атака", COMMANDS), "Атака", "in any case");
  assert.equal(macroShownArgument("/cast\n/use Камень", COMMANDS), "Камень", "a command with nothing after it is passed over");
});

test("«none» ends it with nothing, and so does a body with no command", () => {
  assert.equal(macroShownArgument("#showtooltip none\n/cast Атака", COMMANDS), undefined);
  assert.equal(macroShownArgument("/say hi", COMMANDS), undefined);
  assert.equal(macroShownArgument("", COMMANDS), undefined);
});

// The real option evaluator over a context with nothing true in it but what the case needs.
const context = (over = {}) => new Proxy({ modifier: () => false, ...over }, { get: (t, k) => (k in t ? t[k] : () => false) });

test("the name: the options choose, then the first entry without a bang or a rank", () => {
  assert.equal(macroShownName("Атака", context()), "Атака");
  assert.equal(macroShownName("!Автоматическая стрельба", context()), "Автоматическая стрельба");
  assert.equal(macroShownName("Огненный шар(Уровень 3)", context()), "Огненный шар");
  assert.equal(macroShownName("reset=5 Первое, Второе", context()), "Первое", "a sequence's first");
  assert.equal(macroShownName("Первое, Второе", context()), "Первое", "a random list's first");
  assert.equal(macroShownName("[mod:shift] Первое; Второе", context()), "Второе", "the clause that holds");
  assert.equal(macroShownName("[mod:shift] Первое", context()), undefined, "no clause holds");
});

test("the commands come from the client's strings, in their English and local spellings", () => {
  const words = macroShownCommands();
  assert.ok(words.has("/cast") && words.has("/use") && words.has("/castsequence"), [...words].join(" "));
  assert.equal(macroShownCommands(), words, "built once");
});

// The seam: a macro button answers for the spell it stands for, as 0x005a8c30 reads a slot.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { createFrameXmlMemoryMacroStore } = await import("../dist/code/browser/framexml/FrameXmlMacro.js");
const MACRO = 0x40;
const SPELLS = new Map([
  [6603, { id: 6603, name: "Атака", rank: "", spellLevel: 1, effects: [78, 0, 0], autoRepeat: false }],
  [75, { id: 75, name: "Автоматическая стрельба", rank: "", spellLevel: 1, effects: [2, 0, 0], autoRepeat: true }],
  [133, { id: 133, name: "Огненный шар", rank: "Уровень 1", spellLevel: 1, effects: [2, 6, 0], autoRepeat: false }],
  [143, { id: 143, name: "Огненный шар", rank: "Уровень 2", spellLevel: 6, effects: [2, 6, 0], autoRepeat: false }],
]);

function macroButtons() {
  const macros = [
    { index: 1, name: "attack", icon: "", body: "#showtooltip\n/cast Атака\n/cast Огненный шар" },
    { index: 2, name: "shot", icon: "", body: "/cast !Автоматическая стрельба" },
    { index: 3, name: "ball", icon: "", body: "#show Огненный шар" },
    { index: 4, name: "none", icon: "", body: "#showtooltip none\n/cast Атака" },
    { index: 5, name: "unknown", icon: "", body: "/cast Неизвестное" },
  ];
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    casts: new Map(),
    knownSpells: [...SPELLS.keys()].map((id, slot) => ({ id, slot })),
    actionButtons: macros.map((macro, index) => ({ slot: index, action: macro.index, type: MACRO })),
    cooldownRemaining: () => 0,
    autoRepeatSpellId: undefined,
    autoRanged: { wantedSpellId: undefined },
    attacking: false,
    attackRequested: false,
    isActiveMountSpell: () => false,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id), monotonic: () => 1000, globalCooldownUntil: () => 0,
    castSpell: () => {}, macroStore: createFrameXmlMemoryMacroStore(macros),
  });
  return { world, seam, api: (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)] };
}

test("a macro with Attack in it is an attack button, lit while the character attacks", () => {
  const { world, api } = macroButtons();
  assert.deepEqual(api("IsAttackAction", 1), [1]);
  assert.deepEqual(api("IsAttackAction", 3), [undefined]);
  assert.deepEqual(api("IsAttackAction", 4), [undefined], "«none» stands for nothing");
  assert.deepEqual(api("IsAttackAction", 5), [undefined], "a spell not known stands for nothing");
  assert.deepEqual(api("IsCurrentAction", 1), [undefined]);
  world.attacking = true;
  assert.deepEqual(api("IsCurrentAction", 1), [1]);
});

test("a macro with a repeating spell flashes while it repeats", () => {
  const { world, api } = macroButtons();
  assert.deepEqual(api("IsAutoRepeatAction", 2), [undefined]);
  world.autoRepeatSpellId = 75;
  assert.deepEqual(api("IsAutoRepeatAction", 2), [1]);
  assert.deepEqual(api("IsAutoRepeatAction", 1), [undefined]);
});

test("GetMacroSpell: the name and the rank, the highest known", () => {
  const { api } = macroButtons();
  assert.deepEqual(api("GetMacroSpell", 3), ["Огненный шар", "Уровень 2"]);
  assert.deepEqual(api("GetMacroSpell", "attack"), ["Атака", ""]);
  assert.deepEqual(api("GetMacroSpell", "none"), []);
});

test("a macro that stands for nothing keeps the old answers", () => {
  const { seam, api } = macroButtons();
  assert.deepEqual(api("IsActionInRange", 4), []);
  assert.equal(seam.isCurrentAction(5), false);
});
