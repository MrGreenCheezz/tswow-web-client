import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";
import { isolatedModule, isolatedUi } from "./fixtures/isolated-ui.mjs";

// 11.02-IF-review: keys 1–= and the native main row under possession, in both interface modes.
// Wow.exe 3.3.5a: with the main-bar bit set (0x005d4ad0) slots 121–130 hold `0x10000000 | i` (0x005ab800 /
// 0x005d3240), GetBonusBarOffset is 5 and GetActionBarPage 1, so ActionButtonDown(n) (ActionButton.lua:15-27)
// presses BonusActionButton n, action 120 + n (ActionButton_CalculateAction :131-153); UseAction there
// (0x005abbc0) is the pet bar press 0x005d4210 with an empty guid, then ACTIONBAR_UPDATE_STATE; PickupAction
// (0x005abe70) never lifts 0x78–0x83 and a held action is never dropped there. The keys run through the native
// bar in both modes (input/Actions.ts -> ui/ActionBar.ts `useSlot`), so that is where the page is answered.

installFakeUiDocument();

const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const spellMetadata = await import("../dist/code/browser/SpellMetadata.js");
const context = await import("../dist/code/browser/game/Context.js");
const bonusBar = await import("../dist/code/browser/game/BonusBar.js");
const possessBar = await import("../dist/code/world/PossessBar.js");
const petProtocol = await import("../dist/code/world/PetProtocol.js");
const possessModel = await import("../dist/code/browser/framexml/FrameXmlPossess.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { ACTION_BUTTON_SPELL } = protocol;
const { ACT_COMMAND, ACT_PASSIVE, ACT_REACTION, COMMAND_ATTACK, COMMAND_FOLLOW, REACT_AGGRESSIVE, REACT_DEFENSIVE, packPetAction } = petProtocol;
const { game } = context;

const SELF = 0x10n;
const MOB = 0xf130_0000_0004_d2a0n;
const MOB_ENTRY = 1234;
const MIND_CONTROL = 605;
const FIREBALL = 20793;
const OWN_FIRST = 100;
const OWN_SECOND = 101;
const OWN_PAGE_ELEVEN = 585;
const F = (name) => UPDATE_FIELDS[name].offset;

/** The core's possess bar (CharmInfo::InitPossessCreateSpells): attack, the creature's spells, a stance. */
const POSSESS_BAR = [
  packPetAction(COMMAND_ATTACK, ACT_COMMAND), packPetAction(FIREBALL, ACT_PASSIVE), packPetAction(0, ACT_PASSIVE),
  packPetAction(0, ACT_PASSIVE), packPetAction(0, ACT_PASSIVE), packPetAction(0, ACT_PASSIVE),
  packPetAction(0, ACT_PASSIVE), packPetAction(0, ACT_PASSIVE), packPetAction(REACT_AGGRESSIVE, ACT_REACTION),
  packPetAction(0, ACT_PASSIVE),
];

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let set = this.#listeners.get(name);
    if (!set) { set = new Set(); this.#listeners.set(name, set); }
    set.add(listener);
    return () => { set.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

function setGuid(object, offset, guid) {
  object.fields.set(offset, Number(guid & 0xffff_ffffn));
  object.fields.set(offset + 1, Number(guid >> 32n));
}

function object(guid, typeId, fields) {
  return { guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0, fields: new Map(fields), transport: undefined };
}

/** A priest beside an ogre, a WorldClient-shaped fake both the native bar and the possess model read. */
function worldFixture() {
  const player = object(SELF, 4, [[F("UNIT_FIELD_FLAGS"), 0x08], [F("UNIT_FIELD_HEALTH"), 100], [F("UNIT_FIELD_BYTES_0"), 5 << 8]]);
  const mob = object(MOB, 3, [[F("OBJECT_FIELD_ENTRY"), MOB_ENTRY], [F("UNIT_FIELD_HEALTH"), 500]]);
  const auras = new Map();
  const writes = [];
  const used = [];
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [MOB, mob]]), revision: 1 },
    events: new FakeEvents(),
    knownSpells: [],
    actionButtons: [
      { slot: 0, action: OWN_FIRST, type: ACTION_BUTTON_SPELL },
      { slot: 1, action: OWN_SECOND, type: ACTION_BUTTON_SPELL },
      { slot: 4, action: OWN_FIRST, type: ACTION_BUTTON_SPELL },
      // The character's own page 11 (slots 121-122): the possess page must never read or write it.
      { slot: 120, action: OWN_PAGE_ELEVEN, type: ACTION_BUTTON_SPELL },
      { slot: 121, action: OWN_PAGE_ELEVEN, type: ACTION_BUTTON_SPELL },
    ],
    petSpells: undefined,
    controlledGuid: SELF,
    targetGuid: undefined,
    creatureTemplates: new Map([[MOB_ENTRY, { entry: MOB_ENTRY, flags: 0 }]]),
    aurasFor: (guid) => [...(auras.get(guid) ?? [])],
    cooldownRemaining: () => 0,
    cooldownState: () => undefined,
    petCooldownRemaining: () => 0,
    isActiveMountSpell: () => false,
    setActionButton: (slot, action, type) => writes.push([slot, action, type]),
    usePetSlot(slot, target) { used.push([slot, target]); },
    casts: new Map(),
    names: new Map(),
    partyStats: new Map(),
    totems: new Map(),
    petCooldowns: new Map(),
  };
  const bump = () => { world.state.revision += 1; };
  return {
    world, player, mob, writes, used, auras, bump,
    /** Unit::SetCharmedBy(POSSESS): the bar, the caster's aura, then the fields (far sight last). */
    possess() {
      world.controlledGuid = MOB;
      world.petSpells = {
        guid: MOB, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
        flags: 0, spells: [], cooldowns: [],
        bar: POSSESS_BAR.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
      };
      world.events.emit("PET_BAR_CHANGED", { guid: MOB });
      auras.set(SELF, [{ slot: 0, spellId: MIND_CONTROL, flags: 0x18, casterLevel: 80, applications: 0 }]);
      mob.fields.set(F("UNIT_FIELD_FLAGS"), 0x0100_0000);
      setGuid(mob, F("UNIT_FIELD_CHARMEDBY"), SELF);
      setGuid(player, F("UNIT_FIELD_CHARM"), MOB);
      setGuid(player, F("PLAYER_FARSIGHT"), MOB);
      bump();
    },
    /** Unit::RemoveCharmedBy: the bar closed, then the fields cleared. */
    release() {
      world.controlledGuid = SELF;
      world.petSpells = undefined;
      world.events.emit("PET_BAR_CHANGED", { guid: 0n });
      auras.delete(SELF);
      mob.fields.set(F("UNIT_FIELD_FLAGS"), 0);
      setGuid(mob, F("UNIT_FIELD_CHARMEDBY"), 0n);
      setGuid(player, F("UNIT_FIELD_CHARM"), 0n);
      setGuid(player, F("PLAYER_FARSIGHT"), 0n);
      bump();
    },
  };
}

const SPELL_ROWS = new Map([
  [OWN_FIRST, { id: OWN_FIRST, name: "Своё 1", iconId: OWN_FIRST }],
  [OWN_SECOND, { id: OWN_SECOND, name: "Своё 2", iconId: OWN_SECOND }],
  [OWN_PAGE_ELEVEN, { id: OWN_PAGE_ELEVEN, name: "Кара", iconId: OWN_PAGE_ELEVEN }],
  [FIREBALL, { id: FIREBALL, name: "Огненный шар", rank: "", iconId: 185, iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", effectAura: [0, 0, 0] }],
  [MIND_CONTROL, { id: MIND_CONTROL, name: "Контроль над разумом", rank: "", iconId: 136, iconPath: "Interface\\Icons\\Spell_Shadow_ShadowWordDominate", effectAura: [2, 4, 138] }],
]);

/**
 * The native bar and the key verbs, each transpiled on its own, over the real possess model and rules.
 * `options.possessUi` replaces ui/PossessActionBar.ts (the review's "before the hooks" stand-in).
 */
async function nativeBar(fixture, options = {}) {
  const casts = [];
  const tooltips = new Map();
  const byRoot = new Map();
  const counts = { draws: 0 };
  const actionBar = document.createElement("div");
  class IconButton {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.root = document.createElement("button");
      this.root.addEventListener = (name, listener) => { this.listeners[name] = listener; };
      byRoot.set(this.root, this);
    }
    setContent(content) { this.content = content; counts.draws += 1; }
    setCooldown(fraction) { this.cooldown = fraction; }
    setUsable(usable) { this.usable = usable; }
  }
  game.world = fixture.world;
  game.spells.clear();
  for (const [id, row] of SPELL_ROWS) {
    game.spells.set(id, { passive: false, startRecoveryTime: 0, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], ...row });
  }
  const possessUi = options.possessUi ?? await isolatedUi("PossessActionBar", {
    "../../world/PetProtocol.js": petProtocol,
    "../../world/PossessBar.js": possessBar,
    "../framexml/FrameXmlPossess.js": possessModel,
    "../game/Context.js": context,
    "./Format.js": { unknownLabel: (kind, id) => `${kind} ${id}` },
    "./IconImage.js": { spellIconUrl: (iconId) => `icon ${iconId}` },
    "./SpellNames.js": { ensureSpellNames: () => {} },
  });
  const bar = await isolatedUi("ActionBar", {
    "../../world/ActionBarProtocol.js": protocol,
    "./ActionDrag.js": await import("../dist/code/browser/ui/ActionDrag.js"),
    "../input/Bindings.js": bindings,
    "../game/Context.js": context,
    "../game/BonusBar.js": bonusBar,
    "./PossessActionBar.js": possessUi,
    "../SpellMetadata.js": spellMetadata,
    "../SpellCastGuard.js": { spellPowerAvailable: () => true },
    "../../world/WorldClient.js": { MELEE_AUTO_ATTACK_SPELL_ID: 6603 },
    "./Spellbook.js": {
      castSpell: (id) => { casts.push(id); return true; },
      highestKnownRank: (id) => id,
      spellTooltip: (id) => ({ title: `spell ${id}` }),
    },
    "./Dom.js": { actionBar },
    "./Widgets.js": {
      IconButton,
      attachTooltip: (root, provider) => tooltips.set(root, provider),
      cooldownDuration: () => 0,
      cooldownLabel: () => "",
      cooldownView: () => ({ fraction: 0, remaining: 0 }),
    },
    "./IconImage.js": { spellIconUrl: (iconId) => `icon ${iconId}` },
    "./SpellNames.js": { ensureSpellNames: () => {} },
  });
  const actions = await isolatedModule("browser/input/Actions", {
    "../ui/ActionBar.js": bar,
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": protocol,
    "../game/Context.js": context,
  });
  return {
    bar, casts, tooltips, actions, counts,
    /** One key: what the character cast and which pet bar slots were pressed. */
    press(action) {
      casts.length = 0;
      fixture.used.length = 0;
      assert.equal(actions.runAction(action), true, `${action} is handled`);
      return { casts: casts.slice(), pet: fixture.used.map(([slot]) => slot) };
    },
    row: () => actionBar.children.map((root) => byRoot.get(root)),
    dispose() {
      game.world = undefined;
      game.spells.clear();
    },
  };
}

test("11.02-IF-review: keys 1–= press the possessed unit's bar while it is on the main bar (native interface)", async () => {
  const fixture = worldFixture();
  const native = await nativeBar(fixture);
  try {
    assert.equal(possessModel.frameXmlPossessLive(), undefined, "no stock seam attached");
    assert.deepEqual(native.press("action2"), { casts: [OWN_SECOND], pet: [] }, "no possession: the character's slot 2");
    fixture.possess();
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] }, "BonusActionButton2: slot 122 -> the unit's Fireball slot");
    assert.deepEqual(native.press("action1"), { casts: [], pet: [0] }, "slot 121: the attack command, not the character's own slot 121");
    assert.deepEqual(native.press("action9"), { casts: [], pet: [8] }, "slot 129: the stance");
    assert.deepEqual(native.press("action3"), { casts: [], pet: [2] }, "an empty spell slot's word is not zero: 0x005d4210 runs, the core gets nothing");
    assert.deepEqual(native.press("action11"), { casts: [], pet: [] }, "131: on the page, empty — nothing at all");
    assert.deepEqual(native.press("action12"), { casts: [], pet: [] }, "132 likewise");
    native.casts.length = 0;
    native.bar.useSlot(1, 0);
    assert.deepEqual(native.casts, [OWN_SECOND], "UseAction(2) names page 1: the character's own slot, possessed or not");
    assert.equal(possessBar.POSSESS_ACTION_PAGE, protocol.bonusActionPage(0, 5), "page 11 is NUM_ACTIONBAR_PAGES + offset 5");
    fixture.used.length = 0;
    native.bar.useSlot(1, possessBar.POSSESS_ACTION_PAGE);
    assert.deepEqual([native.casts, fixture.used.map(([slot]) => slot)], [[OWN_SECOND], [1]],
      "UseAction(122) by its page (the stock host's route): the unit's slot, not the character's slot 122");
    native.bar.turnActionPage(2);
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] }, "GetActionBarPage is 1 under the bit (0x005a7fd0): a paged bar changes nothing");
    assert.equal(native.bar.getActionBarPage(), 3, "the paging keys' own page is kept for afterwards");
    native.bar.turnActionPage(0);
    fixture.release();
    assert.deepEqual(native.press("action2"), { casts: [OWN_SECOND], pet: [] }, "home: the character's slot 2 again");
    assert.deepEqual(fixture.writes, [], "nothing written to the character's bar");
  } finally {
    native.dispose();
  }
});

test("11.02-IF-review: the native main row shows the unit's bar; that page is never dragged, cleared or written", async () => {
  const fixture = worldFixture();
  const native = await nativeBar(fixture);
  try {
    native.bar.showActionBar();
    const at = (column) => native.row()[column];
    assert.equal(at(1).content?.icon, `icon ${OWN_SECOND}`);
    const keyOfTwo = at(1).content?.key;
    assert.ok(keyOfTwo, "key 2 wears its binding");
    fixture.possess();
    native.bar.updateActionBar(1_000);
    assert.equal(at(0).content?.label, "Атаковать", "the attack command");
    assert.equal(at(1).content?.icon, "icon 185", "Fireball's icon on key 2");
    assert.equal(at(8).content?.label, "Агрессия");
    assert.equal(at(2).root.dataset.empty, "", "an empty slot of the unit's bar");
    assert.equal(at(4).root.dataset.empty, "", "column 5 held the character's spell; the unit's slot 5 is empty");
    assert.equal(at(4).content?.icon, undefined);
    assert.equal(at(10).root.dataset.empty, "", "131: empty");
    assert.equal(at(1).content?.key, keyOfTwo, "the key label stays on the mirrored button");
    assert.equal(native.tooltips.get(at(1).root)()?.title, "Огненный шар");
    assert.equal(native.tooltips.get(at(0).root)()?.title, "Атаковать");
    fixture.used.length = 0;
    at(1).options.onClick();
    assert.deepEqual(fixture.used.map(([slot]) => slot), [1], "a click presses the unit's slot");
    let prevented = false;
    let dragged;
    at(1).listeners.dragstart({ preventDefault() { prevented = true; }, dataTransfer: { setData: (_f, value) => { dragged = value; } } });
    assert.deepEqual([prevented, dragged], [true, undefined], "0x005abe70 never lifts 0x78-0x83");
    at(0).listeners.contextmenu({ preventDefault() {} });
    at(1).listeners.drop({ preventDefault() {}, dataTransfer: { getData: () => JSON.stringify({ action: 555, type: ACTION_BUTTON_SPELL }) } });
    assert.deepEqual(fixture.writes, [], "no CMSG_SET_ACTION_BUTTON for the possess page");
    // A bar packet that changes a word redraws that column on the next frame.
    fixture.world.petSpells = { ...fixture.world.petSpells, bar: fixture.world.petSpells.bar.map((button) => (button.slot === 2
      ? { slot: 2, packed: packPetAction(MIND_CONTROL, ACT_PASSIVE), action: MIND_CONTROL, type: ACT_PASSIVE } : button)) };
    fixture.world.events.emit("PET_BAR_CHANGED", { guid: MOB });
    native.bar.updateActionBar(1_016);
    assert.equal(at(2).content?.icon, "icon 136", "the new word is drawn");
    // A word whose spell row has not landed yet is drawn as loading, and again once the row is there.
    const LATE = 12345;
    fixture.world.petSpells = { ...fixture.world.petSpells, bar: fixture.world.petSpells.bar.map((button) => (button.slot === 3
      ? { slot: 3, packed: packPetAction(LATE, ACT_PASSIVE), action: LATE, type: ACT_PASSIVE } : button)) };
    fixture.world.events.emit("PET_BAR_CHANGED", { guid: MOB });
    native.bar.updateActionBar(1_024);
    assert.equal(at(3).content?.title, "Данные заклинания загружаются");
    game.spells.set(LATE, { id: LATE, name: "Поздняя", iconId: 77, passive: false, effectAura: [0, 0, 0] });
    native.bar.updateActionBar(1_028);
    assert.equal(at(3).content?.icon, "icon 77", "redrawn once its row landed");
    // The unit's cooldown sweeps its button (on or off: the client is never told the length).
    fixture.world.petCooldownRemaining = (spellId) => (spellId === FIREBALL ? 3_000 : 0);
    native.bar.updateActionBar(1_030);
    assert.deepEqual([at(1).cooldown, at(0).cooldown], [1, 0]);
    assert.deepEqual([at(1).usable, at(4).usable], [true, true], "an empty slot is not greyed, as on the native row");
    fixture.release();
    native.bar.updateActionBar(1_032);
    assert.equal(at(1).content?.icon, `icon ${OWN_SECOND}`, "home: the character's own row");
  } finally {
    native.dispose();
  }
});

test("11.02-IF-review: the stock interface's seam model drives the keys, and a press raises ACTIONBAR_UPDATE_STATE", async () => {
  const fixture = worldFixture();
  const native = await nativeBar(fixture);
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => fixture.world, store: () => undefined, spell: (id) => SPELL_ROWS.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  try {
    seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
    assert.equal(possessModel.frameXmlPossessLive(), seam.possess, "the attached seam's model is the one keys follow");
    fixture.possess();
    seam.possess.tick();
    fired.length = 0;
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] });
    assert.deepEqual(fired.filter(([event]) => event === "ACTIONBAR_UPDATE_STATE").length, 1, "0x005abbc0 -> 0x005a7cb0");
    seam.detach();
    assert.equal(possessModel.frameXmlPossessLive(), undefined, "detached: the native model takes over");
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] }, "still possessed, still the unit's");
    fixture.release();
    assert.deepEqual(native.press("action2"), { casts: [OWN_SECOND], pet: [] });
  } finally {
    seam.detach();
    native.dispose();
  }
});

test("11.02-IF-review: under the stock main bar and pet bar the native #pet-bar steps aside for a possessed unit's bar too", async () => {
  const { FRAMEXML_NATIVE_POSSESS_BAR_HIDE_SELECTOR: selector } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
  assert.equal(selector,
    'body.framexml-world-replaces-native.framexml-world-replaces-pet-bar #pet-bar[data-kind="possess"]:not(.is-vehicle)',
    "only while the stock MainMenuBar (BonusActionBarFrame) and PetActionBarFrame own their lanes; a vehicle's row stays native");
});

// ---- 11.02-IF-keys-review ------------------------------------------------------------------------

const PET = 0xf140_0000_0000_0042n;
const PET_ENTRY = 4321;
/** One spell row per slot of the server's 144 (slot s holds spell SLOT_SPELL + s). */
const SLOT_SPELL = 1000;
const MOD_SHAPESHIFT = 36;
/**
 * [form, the spell that gives it, its BonusActionBar column] — SpellShapeshiftForm.dbc 3.3.5
 * (docs/implementation/probes/A5/probe-stances.out.txt): battle/defensive/berserker stance, cat,
 * bear, moonkin, stealth, shadowform. No stock form has column 5; form 99 does here, because its
 * page 11 is the possess page's slots 121-132 and must stay the character's own without possession.
 */
const STANCE_FORMS = [
  [0, 0, 0], [17, 2457, 1], [18, 71, 2], [19, 2458, 3], [1, 768, 1], [5, 5487, 3], [31, 24858, 4],
  [30, 1784, 1], [28, 15473, 1], [99, 99001, 5],
];

/** The action bar before the 11.02-IF-review hooks: every hook declines, as the code read without them. */
const BEFORE_HOOKS = Object.freeze({
  possessKeyPage: () => undefined,
  possessMirrors: () => false,
  pressPossessSlot: () => false,
  drawPossessSlot: () => false,
  updatePossessSlot: () => false,
  possessSlotTooltip: () => undefined,
});

/** All 144 slots filled (a spell each, plus an item, a macro and an equipment set), every form learned. */
function stanceWorld(fixture) {
  const { world, player } = fixture;
  world.actionButtons = Array.from({ length: 144 }, (_, slot) => ({ slot, action: SLOT_SPELL + slot, type: ACTION_BUTTON_SPELL }));
  world.actionButtons[3] = { slot: 3, action: 6948, type: protocol.ACTION_BUTTON_ITEM };
  world.actionButtons[7] = { slot: 7, action: 1, type: protocol.ACTION_BUTTON_MACRO };
  world.actionButtons[125] = { slot: 125, action: 0, type: protocol.ACTION_BUTTON_EQUIPMENT_SET };
  world.equipmentSets = [];
  world.itemTemplate = () => undefined;
  world.itemCooldownRemaining = () => 0;
  world.knownSpells = STANCE_FORMS.filter(([form]) => form !== 0).map(([, id]) => ({ id }));
  for (let slot = 0; slot < 144; slot++) {
    const id = SLOT_SPELL + slot;
    game.spells.set(id, { id, name: `spell ${id}`, iconId: id, passive: false, startRecoveryTime: 0, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0] });
  }
  for (const [form, id, offset] of STANCE_FORMS) {
    if (form === 0) continue;
    game.spells.set(id, { id, name: `form ${form}`, iconId: id, passive: false, effectAura: [MOD_SHAPESHIFT, 0, 0], effectMiscValue: [form, 0, 0], bonusActionBarOffset: offset });
  }
  const pet = object(PET, 3, [[F("OBJECT_FIELD_ENTRY"), PET_ENTRY], [F("UNIT_FIELD_HEALTH"), 300], [F("UNIT_FIELD_PETNUMBER"), 7]]);
  setGuid(pet, F("UNIT_FIELD_CREATEDBY"), SELF);
  world.state.objects.set(PET, pet);
  world.creatureTemplates.set(PET_ENTRY, { entry: PET_ENTRY, flags: 0 });
  const huntersBar = (guid) => ({
    guid, closed: false, creatureFamily: 1, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
    flags: 0, spells: [], cooldowns: [],
    bar: POSSESS_BAR.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
  });
  const clear = () => {
    world.petSpells = undefined;
    world.controlledGuid = SELF;
    fixture.auras.delete(SELF);
    for (const field of ["UNIT_FIELD_CHARM", "UNIT_FIELD_SUMMON", "PLAYER_FARSIGHT"]) setGuid(player, F(field), 0n);
  };
  /** World states with no possession: what each must leave exactly as it was. */
  const states = [
    ["nothing", () => {}],
    ["a hunter's pet out (its bar open, SUMMON set)", () => {
      player.fields.set(F("UNIT_FIELD_BYTES_0"), 3 << 8);
      world.petSpells = huntersBar(PET);
      setGuid(player, F("UNIT_FIELD_SUMMON"), PET);
    }],
    ["a charmed creature's bar (CHARM set, no far sight)", () => {
      world.petSpells = huntersBar(MOB);
      setGuid(player, F("UNIT_FIELD_CHARM"), MOB);
    }],
    ["Mind Vision: the far sight on a unit in view with no bar", () => {
      setGuid(player, F("PLAYER_FARSIGHT"), MOB);
    }],
    ["Far Sight: the far sight on an object out of view", () => {
      setGuid(player, F("PLAYER_FARSIGHT"), 0xf110_0000_0000_0099n);
    }],
    ["an own aura whose row is missing, and the pet coming out (a pending scan)", () => {
      fixture.auras.set(SELF, [{ slot: 0, spellId: 77777, flags: 0x18, casterLevel: 80, applications: 0 }]);
      world.petSpells = huntersBar(PET);
      setGuid(player, F("UNIT_FIELD_SUMMON"), PET);
    }],
  ];
  return {
    states: states.map(([name, apply]) => [name, () => {
      clear();
      apply();
      world.events.emit("PET_BAR_CHANGED", { guid: world.petSpells?.guid ?? 0n });
      fixture.bump();
    }]),
    setForm: (form) => player.fields.set(F("UNIT_FIELD_BYTES_2"), form * 2 ** 24),
  };
}

/** Everything a player can see or do with the main row: drawn buttons, keys 1–=, clicks, tooltips, drags, drops, right-clicks. */
function observeMainRow(native, fixture) {
  const row = native.row();
  const drawn = row.map((button) => JSON.stringify({
    content: button.content, empty: button.root.dataset.empty, count: button.root.dataset.count,
    cooldown: button.cooldown, usable: button.usable,
  }));
  const keys = bindings.ACTION_BAR_SLOTS.map((action) => native.press(action));
  const clicks = row.map((button) => {
    native.casts.length = 0;
    fixture.used.length = 0;
    button.options.onClick();
    return [native.casts.slice(), fixture.used.length];
  });
  const tooltips = row.map((button) => JSON.stringify(native.tooltips.get(button.root)()));
  const drags = row.map((button) => {
    let prevented = false;
    let dragged;
    button.listeners.dragstart({ preventDefault() { prevented = true; }, dataTransfer: { setData: (...payload) => { dragged = payload; } } });
    return JSON.stringify([prevented, dragged]);
  });
  const writes = row.map((button, column) => {
    fixture.writes.length = 0;
    const payload = column === 0 ? JSON.stringify({ action: 555, type: ACTION_BUTTON_SPELL })
      : JSON.stringify({ action: 556, type: ACTION_BUTTON_SPELL, from: 30 });
    button.listeners.drop({ preventDefault() {}, dataTransfer: { getData: () => payload } });
    button.listeners.contextmenu({ preventDefault() {} });
    return JSON.stringify(fixture.writes);
  });
  return { drawn, keys, clicks, tooltips, drags, writes, page: native.bar.getActionBarPage() };
}

test("11.02-IF-keys-review: without possession the main row and keys 1–= are exactly as before the hooks — every stance page, paged bar and pet state", async () => {
  const fixture = worldFixture();
  const real = await nativeBar(fixture);
  const before = await nativeBar(fixture, { possessUi: BEFORE_HOOKS });
  const world = stanceWorld(fixture);
  try {
    for (const native of [real, before]) native.bar.showActionBar();
    let now = 1_000;
    let compared = 0;
    for (const [state, apply] of world.states) {
      apply();
      for (const [form, , offset] of STANCE_FORMS) {
        world.setForm(form);
        for (const page of [0, 1, 5]) {
          for (const native of [real, before]) native.bar.turnActionPage(page);
          now += 16;
          for (const native of [real, before]) native.bar.updateActionBar(now);
          const label = `${state}; form ${form} (bonus bar ${offset}); page ${page + 1}`;
          const expected = observeMainRow(before, fixture);
          assert.deepEqual(observeMainRow(real, fixture), expected, label);
          assert.deepEqual(fixture.used, [], `${label}: no pet bar press`);
          compared += 1;
          if (form === 99 && page === 0) {
            assert.deepEqual(expected.keys[0], { casts: [SLOT_SPELL + 120], pet: [] },
              `${label}: the colliding page 11 is the character's slot 121`);
          }
        }
      }
    }
    assert.equal(compared, world.states.length * STANCE_FORMS.length * 3);
    // The same harness with the real module is live: possession does reach it, and only it.
    world.setForm(0);
    for (const native of [real, before]) native.bar.turnActionPage(0);
    world.states[0][1]();
    fixture.possess();
    assert.deepEqual(real.press("action2"), { casts: [], pet: [1] }, "the real hooks follow the bit");
    assert.deepEqual(before.press("action2"), { casts: [SLOT_SPELL + 1], pet: [] }, "the stand-in never did");
    fixture.release();
    // No world: the keys are not taken, and nothing throws.
    game.world = undefined;
    for (const native of [real, before]) {
      assert.equal(native.actions.runAction("action1"), false);
      native.bar.useSlot(0);
      native.bar.showActionBar();
      native.bar.updateActionBar(now + 16);
    }
  } finally {
    real.dispose();
  }
});

test("11.02-IF-keys-review: a scan left pending does not tick the native model on every call — only when a row lands or the world moves", async () => {
  const fixture = worldFixture();
  const { world } = fixture;
  let barReads = 0;
  let petSpells;
  Object.defineProperty(world, "petSpells", {
    configurable: true, enumerable: true,
    get() { barReads += 1; return petSpells; },
    set(value) { petSpells = value; },
  });
  let scans = 0;
  const aurasFor = world.aurasFor;
  world.aurasFor = (guid) => { scans += 1; return aurasFor(guid); };
  const native = await nativeBar(fixture);
  const MISSING = 77777;
  try {
    native.bar.showActionBar();
    // Login of a hunter: the pet comes out (0x006d1970 scans on the SUMMON change) while one of the
    // character's own auras has no row yet.
    fixture.auras.set(SELF, [{ slot: 0, spellId: MISSING, flags: 0x18, casterLevel: 80, applications: 0 }]);
    setGuid(fixture.player, F("UNIT_FIELD_SUMMON"), PET);
    fixture.bump();
    scans = 0;
    native.bar.updateActionBar(1_000);
    assert.equal(scans, 1, "the SUMMON change scans the character's auras once");
    barReads = 0;
    scans = 0;
    for (let frame = 1; frame <= 10; frame++) native.bar.updateActionBar(1_000 + frame * 16);
    assert.deepEqual(native.press("action2"), { casts: [OWN_SECOND], pet: [] });
    assert.deepEqual([barReads, scans], [0, 0], "ten frames and a key with nothing moved: no tick at all");
    game.spells.set(MISSING, { id: MISSING, name: "Аура", iconId: 1, passive: false, effectAura: [0, 0, 0] });
    native.bar.updateActionBar(2_000);
    const landed = barReads;
    assert.ok(landed > 0 && landed <= 2, `one tick when the row lands (${landed} bar reads)`);
    for (let frame = 1; frame <= 5; frame++) native.bar.updateActionBar(2_000 + frame * 16);
    assert.equal(barReads, landed, "and none after it");

    // Possessed while the possess spell's row is missing: the scan is retried once that row lands —
    // not on every call of every frame before it.
    fixture.auras.delete(SELF);
    game.spells.delete(MIND_CONTROL);
    fixture.possess();
    native.bar.updateActionBar(3_000);
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] }, "the bit does not wait for the spell row");
    scans = 0;
    for (let frame = 1; frame <= 10; frame++) native.bar.updateActionBar(3_000 + frame * 16);
    assert.equal(scans, 0, "no rescan while no row has landed and the world stands still");
    game.spells.set(MIND_CONTROL, { passive: false, startRecoveryTime: 0, effectMiscValue: [0, 0, 0], ...SPELL_ROWS.get(MIND_CONTROL) });
    native.bar.updateActionBar(4_000);
    assert.equal(scans, 1, "the row landed: one rescan finds the possess spell");
    for (let frame = 1; frame <= 5; frame++) native.bar.updateActionBar(4_000 + frame * 16);
    assert.equal(scans, 1, "found: nothing pending any more");
    fixture.release();
  } finally {
    native.dispose();
  }
});

test("11.02-IF-keys-review: the next world is attached afresh — the last world's possession never carries over, even at an equal revision count", async () => {
  const first = worldFixture();
  const native = await nativeBar(first);
  const pressIn = (fixture, action) => {
    native.casts.length = 0;
    fixture.used.length = 0;
    assert.equal(native.actions.runAction(action), true, `${action} is handled`);
    return { casts: native.casts.slice(), pet: fixture.used.map(([slot]) => slot) };
  };
  try {
    native.bar.showActionBar();
    first.possess();
    native.bar.updateActionBar(1_000);
    assert.deepEqual(pressIn(first, "action2"), { casts: [], pet: [1] });
    first.used.length = 0;
    // Logout under possession, then the next login: clearWorldContext drops game.world, the character
    // list asks the bar nothing, and the next WorldClient's counter starts over — it can read what the
    // last one read when it went.
    const second = worldFixture();
    second.world.state.revision = first.world.state.revision;
    game.world = second.world;
    assert.deepEqual(pressIn(second, "action2"), { casts: [OWN_SECOND], pet: [] }, "the new world's own slot 2");
    assert.deepEqual(first.used, [], "nothing pressed on the old world's unit");
    first.world.events.emit("PET_BAR_CHANGED", { guid: MOB });
    assert.deepEqual(pressIn(second, "action2"), { casts: [OWN_SECOND], pet: [] }, "the old world's late event changes nothing");
    second.possess();
    assert.deepEqual(pressIn(second, "action2"), { casts: [], pet: [1] }, "possession in the new world is followed");
  } finally {
    native.dispose();
  }
});

test("11.02-IF-keys-review: under possession a frame with nothing moved draws nothing; a word changed in place redraws its column only", async () => {
  const fixture = worldFixture();
  const native = await nativeBar(fixture);
  try {
    native.bar.showActionBar();
    fixture.possess();
    native.bar.updateActionBar(1_000);
    const at = (column) => native.row()[column];
    assert.equal(at(1).content?.icon, "icon 185");
    native.counts.draws = 0;
    for (let frame = 1; frame <= 5; frame++) native.bar.updateActionBar(1_000 + frame * 16);
    assert.equal(native.counts.draws, 0, "five frames, nothing moved: no button drawn");
    // WorldClient moves words in place (CMSG_PET_SET_ACTION, an autocast toggle): no new bar object.
    const moved = fixture.world.petSpells.bar[4];
    moved.packed = packPetAction(FIREBALL, ACT_PASSIVE);
    moved.action = FIREBALL;
    moved.type = ACT_PASSIVE;
    native.bar.updateActionBar(1_200);
    assert.deepEqual([native.counts.draws, at(4).content?.icon], [1, "icon 185"], "column 5 alone is drawn again");
    fixture.release();
  } finally {
    native.dispose();
  }
});

test("11.02-IF-keys-review: under possession a full redraw keeps the unit's bar, and possessing the same unit again draws it again", async () => {
  const fixture = worldFixture();
  const native = await nativeBar(fixture);
  const drawn = () => native.row().slice(0, 3).map((button) => button.content?.label ?? button.content?.icon ?? "empty");
  const UNIT_ROW = ["Атаковать", "icon 185", "empty"];
  try {
    native.bar.showActionBar();
    fixture.possess();
    native.bar.updateActionBar(1_000);
    assert.deepEqual(drawn(), UNIT_ROW);
    // ACTION_BUTTONS_CHANGED, a spell row landing, a setting: showActionBar redraws every row at once.
    native.bar.showActionBar();
    assert.deepEqual(drawn(), UNIT_ROW, "a full redraw draws the unit's bar, not the hidden character's page 11");
    native.bar.updateActionBar(1_016);
    assert.deepEqual(drawn(), UNIT_ROW, "and the next frame keeps it");
    fixture.release();
    native.bar.updateActionBar(1_032);
    assert.deepEqual(drawn(), [`icon ${OWN_FIRST}`, `icon ${OWN_SECOND}`, "empty"]);
    fixture.possess();
    native.bar.updateActionBar(1_048);
    assert.deepEqual(drawn(), UNIT_ROW, "the same words as last time are drawn again");
    fixture.release();
  } finally {
    native.dispose();
  }
});

test("11.02-IF-keys-review: a UI reload under possession — the re-attached seam's model is live again; a stale seam's detach or a native model never touches the registry", async () => {
  const fixture = worldFixture();
  const native = await nativeBar(fixture);
  const seamOf = () => new LiveWorldSeam({
    world: () => fixture.world, store: () => undefined, spell: (id) => SPELL_ROWS.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 };
  const seam = seamOf();
  const newer = seamOf();
  try {
    // The stock UI is still loading: the native model runs, and stays out of the registry.
    native.bar.showActionBar();
    fixture.possess();
    native.bar.updateActionBar(1_000);
    assert.equal(possessModel.frameXmlPossessLive(), undefined, "a native model never registers");
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] });
    seam.attach(pump);
    assert.equal(possessModel.frameXmlPossessLive(), seam.possess);
    // /reload: the seam lets go and attaches again under possession.
    seam.detach();
    assert.equal(possessModel.frameXmlPossessLive(), undefined);
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] }, "between the two, the native model");
    seam.attach(pump);
    assert.equal(possessModel.frameXmlPossessLive(), seam.possess, "the re-attached model");
    fired.length = 0;
    assert.deepEqual(native.press("action2"), { casts: [], pet: [1] }, "attach reads the possession it finds");
    assert.equal(fired.filter(([event]) => event === "ACTIONBAR_UPDATE_STATE").length, 1, "and the press reaches the stock UI");
    // A second seam attaches before the first lets go: the first's late detach leaves the second registered.
    newer.attach(pump);
    seam.detach();
    assert.equal(possessModel.frameXmlPossessLive(), newer.possess, "the stale seam's detach unregisters nothing");
    fixture.release();
    newer.possess.tick();
    assert.deepEqual(native.press("action2"), { casts: [OWN_SECOND], pet: [] }, "released: the character's slot 2");
  } finally {
    seam.detach();
    newer.detach();
    native.dispose();
  }
});

test("11.02-IF-keys-review: the hidden kind is the one the native #pet-bar publishes for possession only — a hunter's pet, a charmed creature and a vehicle keep theirs", async () => {
  const { FRAMEXML_NATIVE_POSSESS_BAR_HIDE_SELECTOR: selector } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
  const bar = (guid, words) => ({ guid, closed: false, bar: words.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })) });
  // VehicleSpellInitialize: (spell, slot + 8) words.
  const vehicleWords = [packPetAction(FIREBALL, 8), packPetAction(0, 9), packPetAction(0, 10)];
  const kinds = {
    huntersPet: petProtocol.petBarKind(bar(PET, POSSESS_BAR), SELF, SELF),
    eyesOfTheBeast: petProtocol.petBarKind(bar(PET, POSSESS_BAR), PET, SELF),
    mindControl: petProtocol.petBarKind(bar(MOB, POSSESS_BAR), MOB, SELF),
    charmed: petProtocol.petBarKind(bar(MOB, POSSESS_BAR), SELF, SELF),
    vehicle: petProtocol.petBarKind(bar(MOB, vehicleWords), MOB, SELF),
  };
  assert.deepEqual(kinds, { huntersPet: "pet", eyesOfTheBeast: "possess", mindControl: "possess", charmed: "pet", vehicle: "vehicle" });
  assert.deepEqual(Object.values(kinds).map((kind) => selector.includes(`#pet-bar[data-kind="${kind}"]`)),
    [false, true, true, false, false], "only the possess kind is named");
  assert.ok(selector.endsWith(':not(.is-vehicle)'), "and a seat or vehicle row (.is-vehicle) is never hidden by it");
});
