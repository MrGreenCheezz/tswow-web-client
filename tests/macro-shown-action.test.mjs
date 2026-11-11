// 1.14: what a macro on an action button stands for, a spell or an item (Wow.exe 0x00565c40, 0x005650c0, read 04.11
// and 11.11: .runtime/re-2026-11-04/m2.txt, .runtime/re-2026-11-11/fxapi/d1.c-d5.c).
import assert from "node:assert/strict";
import test from "node:test";
import { macroShown, parseMacroShown } from "../dist/code/browser/macro/MacroShownAction.js";
import { macroShownCommands } from "../dist/code/browser/framexml/FrameXmlMacroCommands.js";

const COMMANDS = new Map([
  ["/cast", "cast"], ["/use", "cast"], ["/castsequence", "sequence"], ["/castrandom", "random"], ["/equip", "equip"],
  ["/equipslot", "equipslot"],
]);
// The real option evaluator over a context with nothing true in it but what the case needs.
const context = (over = {}) => new Proxy({ modifier: () => false, ...over }, { get: (t, k) => (k in t ? t[k] : () => false) });
const ITEMS = new Map([["камень возвращения", 6948], ["огненный шар", 9999]]);
const host = (over = {}) => ({
  options: context(),
  itemNamed: (text) => ITEMS.get(text.toLowerCase()),
  inventoryItem: (slot) => ({ 12: 11111, 23: 22222, 25: 33333 })[slot],
  bagItem: (bag, slot) => (bag === 1 && slot === 4 ? 44444 : undefined),
  ...over,
});
const shown = (body, over) => macroShown(body, COMMANDS, host(over));

test("the first command with an argument, #show and #showtooltip counting as one", () => {
  assert.deepEqual(shown("/cast Атака"), { spell: "Атака" });
  assert.deepEqual(shown("/say hi\n/cast Атака\n/cast Выстрел"), { spell: "Атака" }, "a command not on the list is passed over");
  assert.deepEqual(shown("#showtooltip Выстрел\n/cast Атака"), { spell: "Выстрел" });
  assert.deepEqual(shown("#show Выстрел\n/cast Атака"), { spell: "Выстрел" });
  assert.deepEqual(shown("#showtooltip\n/cast Атака"), { spell: "Атака" }, "a bare #showtooltip names nothing");
  assert.deepEqual(shown("/CAST Атака"), { spell: "Атака" }, "in any case");
  assert.deepEqual(shown("/cast\n/cast Атака"), { spell: "Атака" }, "a command with nothing after it is passed over");
});

test("«none» ends it with nothing, and so does a body with no command", () => {
  assert.equal(shown("#showtooltip none\n/cast Атака"), undefined);
  assert.equal(shown("/say hi"), undefined);
  assert.equal(shown(""), undefined);
});

test("#showtooltip marks the macro once the walk reads it (+0x570)", () => {
  assert.equal(parseMacroShown("#showtooltip\n/cast Атака", COMMANDS).showTooltip, true);
  assert.equal(parseMacroShown("#show\n/cast Атака", COMMANDS).showTooltip, false);
  assert.equal(parseMacroShown("/cast Атака\n#showtooltip", COMMANDS).showTooltip, false, "the walk stopped before it");
});

test("the name: the options choose, then the first entry without a bang or a rank", () => {
  assert.deepEqual(shown("/cast !Автоматическая стрельба"), { spell: "Автоматическая стрельба" });
  assert.deepEqual(shown("/cast Огненный шар(Уровень 3)"), { spell: "Огненный шар" });
  assert.deepEqual(shown("/castsequence reset=5 Первое, Второе"), { spell: "Первое" }, "a sequence's first");
  assert.deepEqual(shown("/castrandom Первое, Второе"), { spell: "Первое" }, "a random list's first");
  assert.deepEqual(shown("/cast [mod:shift] Первое; Второе"), { spell: "Второе" }, "the clause that holds");
  assert.equal(shown("/cast [mod:shift] Первое"), undefined, "no clause holds");
  assert.deepEqual(shown("/cast [@focus] Первое"), { spell: "Первое", target: "focus" }, "the group's target is kept");
});

test("a dynamic first entry lets the walk go on: the first entry whose options hold (0x00565c40, 0x005650c0)", () => {
  assert.deepEqual(shown("/cast [mod:shift] Первое\n/cast Второе"), { spell: "Второе" });
  assert.deepEqual(shown("/cast Первое\n/cast Второе"), { spell: "Первое" }, "a static first entry ends the walk");
  assert.deepEqual(shown("#show [mod:shift] Первое\n/cast Второе"), undefined, "#show ends the walk even when dynamic");
});

test("an item by name before a spell, by an item link, by inventory slot and by bag and slot", () => {
  assert.deepEqual(shown("/use Камень возвращения"), { item: 6948 });
  assert.deepEqual(shown("/cast Огненный шар"), { item: 9999 }, "0x005650c0 asks the item cache first");
  assert.deepEqual(shown("/use 13"), { item: 11111 }, "inventory slot 13 is slot 12 from 0");
  assert.deepEqual(shown("/use 0 1"), { item: 22222 }, "the backpack's first slot is inventory slot 23");
  assert.deepEqual(shown("/use 0 3"), { item: 33333 });
  assert.deepEqual(shown("/use 2 5"), { item: 44444 }, "bag 2 is the second worn bag");
  assert.equal(shown("/use 24"), undefined, "past the bag slots");
  assert.equal(shown("/use 5 1"), undefined, "no fifth bag");
  assert.deepEqual(shown("/equip Камень возвращения"), { item: 6948 });
  assert.equal(shown("/equip Атака"), undefined, "an equip command never names a spell");
  assert.deepEqual(shown("/equipslot 14 Камень возвращения"), { item: 6948 }, "the slot number is passed over");
  assert.deepEqual(shown("#showtooltip Камень возвращения\n/use 13"), { item: 6948 });
});

test("the commands come from the client's strings, in their English and local spellings, with their kinds", () => {
  const words = macroShownCommands();
  assert.equal(words.get("/cast"), "cast");
  assert.equal(words.get("/use"), "cast");
  assert.equal(words.get("/castsequence"), "sequence");
  assert.equal(words.get("/equipslot"), "equipslot");
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
  // 5.37 (11.11): positions are alphabetical (Wow.exe 0x00564a80): attack, ball, none, shot, unknown.
  assert.deepEqual(api("GetMacroSpell", 2), ["Огненный шар", "Уровень 2"]);
  assert.deepEqual(api("GetMacroSpell", "attack"), ["Атака", ""]);
  assert.deepEqual(api("GetMacroSpell", "none"), []);
});

test("a macro that stands for nothing keeps the old answers", () => {
  const { seam, api } = macroButtons();
  assert.deepEqual(api("IsActionInRange", 4), []);
  assert.equal(seam.isCurrentAction(5), false);
});

// 1.14 (11.11): a macro that stands for an item answers for it on its button (0x005a8070 and its readers).
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const SELF = 0x10n;
const STONE = 0x4000_0000_0000_0101n;
const STONE_ENTRY = 6948;

function itemMacroButtons() {
  const macros = [
    { index: 1, name: "камень", body: "/use Камень возвращения" },
    { index: 2, name: "подсказка", body: "#showtooltip\n/use Камень возвращения" },
    { index: 3, name: "шар", body: "#showtooltip\n/cast Огненный шар" },
    { index: 4, name: "слот", body: "/use 0 1" },
    { index: 5, name: "свой значок", icon: "Interface\\Icons\\Spell_Fire_Fireball", body: "/use Камень возвращения" },
    { index: 6, name: "ссылка", body: "/use |cffffffff|Hitem:6948:0:0:0|h[x]|h|r" },
  ];
  const self = { guid: SELF, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(STONE & 0xffff_ffffn)],
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, Number(STONE >> 32n)],
  ]) };
  const stone = { guid: STONE, typeId: 1, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, STONE_ENTRY], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 3],
  ]) };
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, self], [STONE, stone]]) },
    casts: new Map(),
    knownSpells: [...SPELLS.keys()].map((id, slot) => ({ id, slot })),
    itemTemplates: new Map([[STONE_ENTRY, {
      found: true, name: "Камень возвращения", quality: 1, flags: 0, stackable: 1, itemClass: 15, subClass: 0,
      spells: [{ spellId: 8690, trigger: 0, charges: 0, cooldown: -1, category: 0, categoryCooldown: -1 }],
    }]]),
    actionButtons: macros.map((macro, index) => ({ slot: index, action: macro.index, type: MACRO })),
    cooldownRemaining: () => 0,
    autoRepeatSpellId: undefined,
    autoRanged: { wantedSpellId: undefined },
    attacking: false,
    attackRequested: false,
    isActiveMountSpell: () => false,
    aurasFor: () => [],
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id), monotonic: () => 1000, globalCooldownUntil: () => 0,
    castSpell: () => {}, macroStore: createFrameXmlMemoryMacroStore(macros),
    itemTexture: (entry) => (entry === STONE_ENTRY ? "Interface\\Icons\\INV_Misc_Rune_01" : undefined),
  });
  return { world, seam, api: (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)] };
}

test("GetMacroItem names the item and links it; GetMacroSpell then answers nothing (0x00567200, 0x00567450)", () => {
  const { api } = itemMacroButtons();
  const [name, link] = api("GetMacroItem", 1);
  assert.equal(name, "Камень возвращения");
  assert.match(link, /\|Hitem:6948:/);
  assert.deepEqual(api("GetMacroItem", 4).slice(0, 1), ["Камень возвращения"], "by the backpack's slot");
  assert.deepEqual(api("GetMacroSpell", 1), []);
  // 5.37 (11.11): positions are alphabetical (Wow.exe 0x00564a80): камень, подсказка, свой значок, слот, ссылка, шар.
  assert.deepEqual(api("GetMacroItem", 6), [], "a spell macro has no item");
  assert.equal(api("GetMacroItem", 5)[0], "Камень возвращения", "an item link names its id (0x00709de0)");
});

test("a macro's item counts, stacks and is consumable as an item button (0x005aa5c0, 0x005a8470, 0x005a9360)", () => {
  const { api } = itemMacroButtons();
  assert.deepEqual(api("GetActionCount", 1), [3]);
  assert.deepEqual(api("IsConsumableAction", 1), [true]);
  assert.deepEqual(api("IsStackableAction", 1), [false], "its record does not stack past one");
  assert.deepEqual(api("IsEquippedAction", 1), [false]);
});

test("a question-mark macro shows its item's icon; a chosen icon stays (0x00566ac0)", () => {
  const { api } = itemMacroButtons();
  assert.deepEqual(api("GetActionTexture", 1), ["Interface\\Icons\\INV_Misc_Rune_01"]);
  assert.deepEqual(api("GetActionTexture", 5), ["Interface\\Icons\\Spell_Fire_Fireball"]);
  assert.equal(api("GetMacroInfo", 1)[1], "Interface\\Icons\\INV_Misc_Rune_01");
});

test("the action tooltip: the item or the spell with #showtooltip, the macro's name without (0x00630d20)", () => {
  const { api } = itemMacroButtons();
  assert.deepEqual(api("GetActionTooltip", 1), ["macro", 1, "камень", ""]);
  assert.deepEqual(api("GetActionTooltip", 2), ["item", STONE_ENTRY, "Камень возвращения", ""]);
  assert.deepEqual(api("GetActionTooltip", 3), ["spell", 143, "Огненный шар", "Уровень 2"]);
});
