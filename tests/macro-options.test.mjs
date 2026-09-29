import assert from "node:assert/strict";
import test from "node:test";

// The macro-condition evaluator shared by the stock `SecureCmdOptionParse` and the native `/cast`
// (src/browser/macro/MacroOptions.ts), against contexts built here: no world, no Lua, no DOM.
const {
  parseMacroOptions, macroOptions, evaluateMacroOptions, installMacroOptionErrorSink,
} = await import("../dist/code/browser/macro/MacroOptions.js");
const { createMacroContext, macroFormMemo, shapeshiftStance } = await import("../dist/code/browser/macro/MacroContext.js");
const { frameXmlSecureCmdOptionParse } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

/** A context whose answers come from one plain object; anything left out answers «no». */
function context(state = {}) {
  const unit = (name) => state.units?.[name];
  return {
    modifier: (key) => {
      const held = state.mods ?? [];
      return key === undefined ? held.length > 0 : held.includes(key);
    },
    button: () => state.button,
    combat: () => Boolean(state.combat),
    exists: (name) => unit(name) !== undefined,
    dead: (name) => Boolean(unit(name)?.dead),
    harm: (name) => unit(name)?.reaction === "hostile",
    help: (name) => unit(name)?.reaction === "friendly",
    inParty: (name) => Boolean(unit(name)?.party),
    inRaid: (name) => Boolean(unit(name)?.raid),
    group: () => state.group,
    stance: () => state.stance ?? 0,
    bonusBar: () => state.bonusBar ?? 0,
    actionBar: () => state.actionBar ?? 1,
    spec: () => state.spec ?? 1,
    channeling: () => state.channeling,
    pet: () => state.pet,
    mounted: () => Boolean(state.mounted),
    swimming: () => Boolean(state.swimming),
    flying: () => Boolean(state.flying),
    stealth: () => Boolean(state.stealth),
  };
}

const run = (source, state, defaultTarget) => evaluateMacroOptions(macroOptions(source), context(state), defaultTarget);

test("clauses are tried in order and the first that holds answers; a clause without brackets always holds", () => {
  assert.deepEqual(run("[mod:shift] A; B", { mods: ["shift"] }), { text: "A" });
  assert.deepEqual(run("[mod:shift] A; B", {}), { text: "B" }, "the second clause decides when the first fails");
  assert.deepEqual(run("[mod:shift] A; [mod:ctrl] B", {}), undefined, "no clause holds: nothing, as the client answers nil");
  assert.deepEqual(run("A; B", {}), { text: "A" });
  assert.deepEqual(run("", {}), { text: "" }, "an empty option string still goes");
  assert.deepEqual(run("[combat]", { combat: true }), { text: "" }, "`/stopmacro [combat]` answers the empty action");
  assert.deepEqual(run("[combat]", {}), undefined);
});

test("groups are alternatives, each with its own target; conditions inside a group are a conjunction", () => {
  const focusFriend = { units: { focus: { reaction: "friendly" }, target: { reaction: "hostile" } } };
  assert.deepEqual(run("[@focus,help][@target,harm] X", focusFriend), { text: "X", target: "focus" });
  const focusFoe = { units: { focus: { reaction: "hostile" }, target: { reaction: "hostile" } } };
  assert.deepEqual(run("[@focus,help][@target,harm] X", focusFoe), { text: "X", target: "target" });
  assert.deepEqual(run("[@focus,help][@target,harm] X", {}), undefined);
  // The conditions ask about the group's own target, wherever in the group it is written.
  assert.deepEqual(run("[harm,@focus] X; Y", focusFoe), { text: "X", target: "focus" });
  assert.deepEqual(run("[target=party1,dead] Воскрешение; Y", { units: { party1: { dead: true } } }),
    { text: "Воскрешение", target: "party1" });
  // Without a target option a unit condition asks about `target` (or the caller's default).
  assert.deepEqual(run("[harm] X; Y", { units: { target: { reaction: "hostile" } } }), { text: "X" });
  assert.deepEqual(run("[exists] X; Y", { units: { focus: {} } }, "focus"), { text: "X" });
  // A conjunction, not a choice: both must hold.
  assert.deepEqual(run("[nomod,combat] A; [mod:ctrl/alt] B; C", {}), { text: "C" });
  assert.deepEqual(run("[nomod,combat] A; [mod:ctrl/alt] B; C", { combat: true }), { text: "A" });
  assert.deepEqual(run("[nomod,combat] A; [mod:ctrl/alt] B; C", { combat: true, mods: ["alt"] }), { text: "B" });
  assert.deepEqual(run("[nomod,combat] A; [mod:ctrl/alt] B; C", { mods: ["shift"] }), { text: "C" });
});

test("an empty group holds, and a target-only group always holds with its target", () => {
  assert.deepEqual(run("[] X", {}), { text: "X" });
  assert.deepEqual(run("[][@focus] X", {}), { text: "X" });
  assert.deepEqual(run("[@focus][@target] X", {}), { text: "X", target: "focus" }, "whether or not focus exists");
  assert.deepEqual(run("[@mouseover,exists][] X", {}), { text: "X" }, "the fallback group names no target");
});

test("mod, btn, stance/form, bonusbar, actionbar, spec, group, channeling and pet read their arguments", () => {
  assert.deepEqual(run("[mod] A; B", { mods: ["ctrl"] }), { text: "A" }, "mod without an argument is any modifier");
  assert.deepEqual(run("[mod] A; B", {}), { text: "B" });
  assert.deepEqual(run("[modifier:alt] A; B", { mods: ["alt"] }), { text: "A" });
  assert.deepEqual(run("[mod:shift/ctrl] A; B", { mods: ["ctrl"] }), { text: "A" }, "a slash is «any of»");
  assert.deepEqual(run("[btn:2] A; B", { button: "RightButton" }), { text: "A" });
  assert.deepEqual(run("[btn:2] A; B", { button: "LeftButton" }), { text: "B" });
  assert.deepEqual(run("[button:1/3] A; B", { button: "MiddleButton" }), { text: "A" });
  // With no button the client reads «LeftButton» (Wow.exe 0x5ef0d0): a key or a chat line is button 1.
  assert.deepEqual(run("[btn:1] A; B", {}), { text: "A" });
  assert.deepEqual(run("[btn:LeftButton] A; B", {}), { text: "A" });
  assert.deepEqual(run("[btn] A; B", { button: "RightButton" }), { text: "B" }, "bare [btn] never holds");
  assert.deepEqual(run("[stance:0] A; B", {}), { text: "A" });
  assert.deepEqual(run("[stance:0] A; B", { stance: 2 }), { text: "B" });
  assert.deepEqual(run("[form:1/3] A; B", { stance: 3 }), { text: "A" });
  assert.deepEqual(run("[form:1/3] A; B", { stance: 2 }), { text: "B" });
  assert.deepEqual(run("[stance] A; B", { stance: 1 }), { text: "A" }, "no argument: any form");
  assert.deepEqual(run("[stance] A; B", {}), { text: "B" });
  // bonusbar, actionbar and spec compare their arguments only: bare, they never hold (0x5ef200-0x5ef2e0).
  assert.deepEqual(run("[bonusbar] A; B", {}), { text: "B" });
  assert.deepEqual(run("[bonusbar] A; B", { bonusBar: 1 }), { text: "B" });
  assert.deepEqual(run("[bonusbar:5] A; B", { bonusBar: 5 }), { text: "A" });
  assert.deepEqual(run("[bonusbar:5] A; B", { bonusBar: 1 }), { text: "B" });
  assert.deepEqual(run("[actionbar:2] A; [bar:1] B", { actionBar: 1 }), { text: "B" });
  assert.deepEqual(run("[actionbar] A; B", { actionBar: 1 }), { text: "B" });
  assert.deepEqual(run("[spec:2] A; B", { spec: 2 }), { text: "A" });
  assert.deepEqual(run("[spec] A; B", { spec: 2 }), { text: "B" });
  assert.deepEqual(run("[group] A; B", { group: "party" }), { text: "A" });
  assert.deepEqual(run("[group:raid] A; B", { group: "party" }), { text: "B" });
  assert.deepEqual(run("[group:party] A; B", { group: "raid" }), { text: "A" }, "a raid is a group of the party kind too");
  assert.deepEqual(run("[channeling] A; B", { channeling: "Буран" }), { text: "A" });
  assert.deepEqual(run("[channeling:Чародейские стрелы/буран] A; B", { channeling: "Буран" }), { text: "A" });
  assert.deepEqual(run("[nochanneling:Буран] A; B", { channeling: "Буран" }), { text: "B" });
  assert.deepEqual(run("[pet] A; B", { pet: { name: "Волк" } }), { text: "A" });
  assert.deepEqual(run("[pet:волк] A; B", { pet: { name: "Волк" } }), { text: "A" });
  assert.deepEqual(run("[pet:Бес] A; B", { pet: { name: "Волк" } }), { text: "B" });
  assert.deepEqual(run("[nopet] A; B", {}), { text: "A" });
});

// Every condition word the 3.3.5 client knows (UIMacroOptions.cpp's cluster plus combat, group,
// party, raid and pet), with the argument each needs to be true under ALL.
const WORDS = [
  "mod", "modifier", "btn:2", "button:2", "stance:1", "form:1", "bonusbar:1", "actionbar:1", "bar:1", "spec:1",
  "group:raid", "channeling", "pet", "equipped:Щиты", "worn:Щиты", "vehicleui", "unithasvehicleui", "combat", "dead",
  "exists", "harm", "help", "party", "raid", "stealth", "mounted", "swimming", "flying", "flyable", "indoors",
  "outdoors", "cursor",
];
const ALL = {
  modifier: () => true, button: () => "RightButton", combat: () => true, exists: () => true, dead: () => true,
  harm: () => true, help: () => true, inParty: () => true, inRaid: () => true, group: () => "raid", stance: () => 1,
  bonusBar: () => 1, actionBar: () => 1, spec: () => 1, channeling: () => "Буран", pet: () => ({ name: "Волк" }),
  mounted: () => true, swimming: () => true, flying: () => true, stealth: () => true, flyable: () => true,
  indoors: () => true, outdoors: () => true, equipped: () => true, vehicleUi: () => true, unitHasVehicleUi: () => true,
  cursor: () => true,
};
const NONE = {};

test("every condition word holds under a context that says yes, and its `no` form under one that says nothing", () => {
  for (const word of WORDS) {
    const [name, argument] = word.split(":");
    const negated = argument === undefined ? `no${name}` : `no${name}:${argument}`;
    assert.deepEqual(evaluateMacroOptions(macroOptions(`[${word}] A; B`), ALL), { text: "A" }, word);
    assert.deepEqual(evaluateMacroOptions(macroOptions(`[${negated}] A; B`), ALL), { text: "B" }, negated);
    assert.deepEqual(evaluateMacroOptions(macroOptions(`[${word}] A; B`), NONE), { text: "B" }, `${word}, no data`);
    assert.deepEqual(evaluateMacroOptions(macroOptions(`[${negated}] A; B`), NONE), { text: "A" }, `${negated}, no data`);
  }
});

test("names, `no` and `target=` are case-sensitive; an unknown word holds and is reported once per option string", () => {
  const reported = [];
  const uninstall = installMacroOptionErrorSink((word) => reported.push(word));
  try {
    // A word the client does not know holds (its handler answers true) and `no` turns it false.
    assert.deepEqual(evaluateMacroOptions(macroOptions("[known:Рывок] A; B"), ALL), { text: "A" });
    assert.deepEqual(evaluateMacroOptions(macroOptions("[noknown:Рывок] A; B"), ALL), { text: "B" });
    assert.deepEqual(reported, ["known", "known"], "ERR_UNKNOWN_MACRO_OPTION_S names the word without `no` or arguments");
    // Reported the first time the string is evaluated, not on every evaluation (the state driver's rate).
    for (let index = 0; index < 5; index += 1) evaluateMacroOptions(macroOptions("[known:Рывок] A; B"), ALL);
    assert.equal(reported.length, 2);
    assert.deepEqual(run("[Combat] A; B", {}), { text: "A" }, "Combat is not combat: unknown, so it holds");
    assert.deepEqual(run("[NOcombat] A; B", { combat: true }), { text: "A" }, "only a lower-case `no` negates");
    assert.deepEqual(run("[TARGET=focus,harm] A; B", {}), { text: "B" }, "an upper-case target= is no target");
    assert.deepEqual(reported.slice(2), ["Combat", "NOcombat", "TARGET=focus"]);
    // Whitespace around every part is ignored, and argument values stay case-insensitive.
    assert.deepEqual(run("  [ combat , mod : shift ]  A  ;  B ", { combat: true, mods: ["shift"] }), { text: "A" });
    assert.deepEqual(run("[ @focus , exists ] [ target=target ] X", {}), { text: "X", target: "target" });
    assert.deepEqual(run("[@ focus ] X", {}), { text: "X", target: "focus" });
    // Parsing alone reports nothing: the native window checks bodies as they are typed.
    parseMacroOptions("[bogus] X");
    assert.equal(reported.includes("bogus"), false);
  } finally {
    uninstall();
  }
});

test("an empty target is no target: the conditions ask about `target` and no unit is answered", () => {
  assert.deepEqual(run("[@] X", {}), { text: "X" });
  assert.deepEqual(run("[@,harm] X; Y", { units: { target: { reaction: "hostile" } } }), { text: "X" });
  assert.deepEqual(run("[target=,harm] X; Y", {}), { text: "Y" });
  assert.equal(parseMacroOptions("[@] X").error, undefined);
});

test("broken syntax is an error the evaluator answers with nothing, never an exception", () => {
  const unclosed = parseMacroOptions("[mod:shift A; B");
  assert.equal(typeof unclosed.error, "string");
  assert.equal(evaluateMacroOptions(unclosed, context({ mods: ["shift"] })), undefined);
  assert.equal(evaluateMacroOptions(macroOptions("[mod:shift"), context({})), undefined);
  // Clauses are read in order: a broken later clause does not stop an earlier one that holds.
  assert.deepEqual(run("A; [bad", {}), { text: "A" });
  assert.equal(run("[nomod] A; [bad", { mods: ["shift"] }), undefined);
  assert.equal(parseMacroOptions("[mod:shift] A; B").error, undefined);
});

test("one parse per option string: the state driver's five evaluations a second reuse it", () => {
  assert.equal(macroOptions("[combat] show; hide"), macroOptions("[combat] show; hide"));
  const parsed = macroOptions("[stance:1] 1; [stance:2] 2; 0");
  assert.deepEqual(evaluateMacroOptions(parsed, context({ stance: 2 })), { text: "2" });
  assert.deepEqual(evaluateMacroOptions(parsed, context({ stance: 1 })), { text: "1" });
  assert.deepEqual(evaluateMacroOptions(parsed, context({})), { text: "0" });
});

test("SecureCmdOptionParse answers (text) or (text, target), and nothing when no clause holds", () => {
  const shift = context({ mods: ["shift"] });
  assert.deepEqual(frameXmlSecureCmdOptionParse("[mod:shift] Огненный шар; Ледяная стрела", shift), ["Огненный шар"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[mod:shift] Огненный шар; Ледяная стрела", context({})), ["Ледяная стрела"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[@focus,exists][] Превращение", context({ units: { focus: {} } })),
    ["Превращение", "focus"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[combat] show", context({})), []);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[combat] show; hide", context({ combat: true })), ["show"]);
  // Without a context the answer is the old one: only what needs no state is decided.
  assert.deepEqual(frameXmlSecureCmdOptionParse("[combat] show; hide"), []);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[@focus] Превращение"), ["Превращение", "focus"]);
});

// ---- the world context (macro/MacroContext.ts) --------------------------------------------------

const keys = (...held) => ({
  state: () => ({
    LSHIFT: held.includes("LSHIFT"), RSHIFT: held.includes("RSHIFT"), LCTRL: held.includes("LCTRL"),
    RCTRL: held.includes("RCTRL"), LALT: held.includes("LALT"), RALT: held.includes("RALT"), button: 0,
  }),
});
const holds = (source, options) => evaluateMacroOptions(macroOptions(`${options} A; B`), createMacroContext(source)).text === "A";

test("[mod:X] is IsModifiedClick(X): keys joined with - must all be held, else a modified-click action's keys", () => {
  assert.equal(holds({ modifiers: keys("LSHIFT") }, "[mod:shift]"), true);
  assert.equal(holds({ modifiers: keys("RSHIFT") }, "[mod:SHIFT]"), true, "key names are case-insensitive");
  assert.equal(holds({ modifiers: keys("RSHIFT") }, "[mod:lshift]"), false);
  assert.equal(holds({ modifiers: keys("LSHIFT", "LCTRL") }, "[mod:shift]"), true, "other keys may be held too");
  assert.equal(holds({ modifiers: keys("LSHIFT") }, "[mod:ctrl-shift]"), false);
  assert.equal(holds({ modifiers: keys("LSHIFT", "RCTRL") }, "[mod:CTRL-SHIFT]"), true);
  assert.equal(holds({ modifiers: keys("RALT") }, "[mod:SELFCAST]"), true, "SELFCAST is ALT by default");
  assert.equal(holds({ modifiers: keys("LSHIFT") }, "[mod:SELFCAST]"), false);
  assert.equal(holds({ modifiers: keys("LSHIFT", "LCTRL", "LALT") }, "[mod:FOCUSCAST]"), false, "FOCUSCAST is NONE");
  assert.equal(holds({ modifiers: keys("LCTRL") }, "[mod]"), true, "bare [mod]: any key");
  assert.equal(holds({ modifiers: keys() }, "[mod]"), false);
  assert.equal(holds({ modifiers: keys("LALT") }, "[mod:bogus/alt]"), true);
});

/** A player object with its fields, in a world the context reads. */
function worldWith(fields = [], extra = {}) {
  const player = { guid: 1n, typeId: 4, movementFlags: 0, fields: new Map(fields) };
  const pet = { guid: 5n, typeId: 3, movementFlags: 0, fields: new Map() };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [5n, pet]]) },
    knownSpells: [], petSpells: { guid: 5n, creatureFamily: 1 }, names: new Map([[5n, "Клык"]]),
    itemTemplates: new Map(), ...extra,
  };
  return { world, player, pet };
}

test("[combat] holds while the player or the pet fights; [pet:X] is the pet's name or its family", () => {
  const { world, player, pet } = worldWith();
  const source = { world: () => world, unitGuid: (unit) => (unit === "pet" ? 5n : unit === "player" ? 1n : undefined),
    familyName: (family) => (family === 1 ? "Волк" : undefined) };
  assert.equal(holds(source, "[combat]"), false);
  pet.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000);
  assert.equal(holds(source, "[combat]"), true, "the pet's UNIT_FLAG_IN_COMBAT");
  pet.fields.delete(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000);
  assert.equal(holds(source, "[combat]"), true);
  assert.equal(holds(source, "[pet:клык]"), true, "the pet's name");
  assert.equal(holds(source, "[pet:Волк]"), true, "CreatureFamily's name");
  assert.equal(holds(source, "[pet:Кошка]"), false);
});

test("[party] is a party member other than the player; [raid] a party or raid member, the player too in a raid", () => {
  const { world } = worldWith();
  world.state.objects.set(3n, { guid: 3n, typeId: 4, movementFlags: 0, fields: new Map() });
  const guids = { player: 1n, party1: 3n, raid1: 3n, raid2: 1n };
  const source = { world: () => world, unitGuid: (unit) => guids[unit] };
  world.group = { groupType: 0, members: [{ guid: 3n }] };
  assert.equal(holds(source, "[@party1,party]"), true);
  assert.equal(holds(source, "[@player,party]"), false, "the player is not a member of their own party (0x5eede0)");
  assert.equal(holds(source, "[@party1,raid]"), true, "a party member answers [raid] too (0x5eee20)");
  assert.equal(holds(source, "[@player,raid]"), false);
  world.group = { groupType: 2, members: [{ guid: 3n }] };
  assert.equal(holds(source, "[@raid2,raid]"), true, "in a raid the player is a member");
  assert.equal(holds(source, "[@player,party]"), false);
  world.group = undefined;
  assert.equal(holds(source, "[@party1,party]"), false);
});

test("[outdoors] and [indoors] are opposites; without area data the player is outdoors", () => {
  assert.equal(holds({}, "[outdoors]"), true);
  assert.equal(holds({}, "[indoors]"), false);
  assert.equal(holds({ indoors: () => true }, "[outdoors]"), false);
});

test("[equipped:X] names an equipped item's class or subclass (AuctionUI's names)", () => {
  const visible = (slot) => UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset + (slot - 1) * 2;
  const { world } = worldWith([[visible(17), 2129], [visible(16), 1976]], {
    itemTemplates: new Map([
      [2129, { entry: 2129, found: true, itemClass: 4, subClass: 6 }],
      [1976, { entry: 1976, found: true, itemClass: 2, subClass: 7 }],
    ]),
  });
  const source = { world: () => world };
  assert.equal(holds(source, "[equipped:Щиты]"), true, "Armor/Shields in the off hand");
  assert.equal(holds(source, "[worn:щиты]"), true);
  assert.equal(holds(source, "[equipped:Одноручные мечи]"), true);
  assert.equal(holds(source, "[equipped:Оружие]"), true, "the class name");
  assert.equal(holds(source, "[equipped:Посохи]"), false);
  assert.equal(holds(source, "[equipped]"), false);
});

test("[stance] is GetShapeshiftForm(true): 0 without a form byte, else the stance bar slot of that form", () => {
  const forms = [{ spellId: 465, formId: undefined }, { spellId: 5487, formId: 5 }, { spellId: 768, formId: 1 }];
  const form = (byte) => ({ fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, byte << 24]]) });
  assert.equal(shapeshiftStance(form(0), forms), 0, "an aura or a presence on the bar is no form");
  assert.equal(shapeshiftStance(form(5), forms), 2);
  assert.equal(shapeshiftStance(form(1), forms), 3);
  assert.equal(shapeshiftStance(form(27), forms), 4, "a form the bar does not show is one past the last");
  assert.equal(shapeshiftStance(undefined, forms), 0);
});

test("the form lookups are remembered until the learned spells, the form byte or the spell rows change", () => {
  const { world, player } = worldWith();
  let revision = 1;
  let computed = 0;
  const memo = macroFormMemo(() => world, () => revision);
  const stance = memo(() => { computed += 1; return 7; });
  assert.equal(stance(), 7);
  assert.equal(stance(), 7);
  assert.equal(computed, 1);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 1 << 24);
  stance();
  world.knownSpells = [{ id: 768, slot: 0 }];
  stance();
  revision += 1;
  stance();
  stance();
  assert.equal(computed, 4);
});
