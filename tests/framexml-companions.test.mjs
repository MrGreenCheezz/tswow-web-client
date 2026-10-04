import assert from "node:assert/strict";
import test from "node:test";

// The stock pet page's companion C API over a fake world through LiveWorldSeam
// (FrameXmlCompanions.ts): the classifier, the name order, the summon state, the events, the
// cursor, the cooldown and the pet page's five calls. No client data.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  FrameXmlCompanionModel, frameXmlCompanionKind, frameXmlCompanionCreature, frameXmlUnitMounted,
} = await import("../dist/code/browser/framexml/FrameXmlCompanions.js");
const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
const companionEvents = (fired) => fired.filter(([event]) => event.startsWith("COMPANION_"));

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) this.#listeners.set(name, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

const SELF = 0x10n;
const PET = 0x20n;
const CRITTER = 0xF130000000000C01n;
const STRANGER = 0x99n;

// Measured rows (FrameXmlCompanionsCanned.ts): 458 and 580 on skill line 777, 4055 on 778. 999 is a
// custom spell with only the mounted aura; 1234 is neither.
const SPELLS = new Map([
  [458, { name: "Гнедой конь", iconPath: "Interface\\Icons\\Ability_Mount_RidingHorse", effects: [6, 6, 0], effectAura: [78, 32, 0], effectMiscValue: [284, 0, 0] }],
  [580, { name: "Большой лесной волк", iconPath: "Interface\\Icons\\Ability_Mount_BlackDireWolf", effects: [6, 6, 0], effectAura: [0, 32, 0], effectMiscValue: [358, 0, 0] }],
  [999, { name: "Ковёр", iconPath: "Interface\\Icons\\Ability_Mount_Carpet", effects: [6, 0, 0], effectAura: [78, 0, 0], effectMiscValue: [777, 0, 0] }],
  [4055, { name: "Механическая белка", iconPath: "Interface\\Icons\\INV_Crate_01", effects: [28, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [2671, 0, 0] }],
  [1234, { name: "Ничто", iconPath: "Interface\\Icons\\Temp", effects: [0, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0] }],
]);
const ABILITIES = new Map([
  [458, [{ skillLine: 777 }]], [580, [{ skillLine: 777 }]], [4055, [{ skillLine: 778 }]], [1234, [{ skillLine: 26 }]],
]);

const guidWords = (guid) => [Number(guid & 0xffffffffn), Number(guid >> 32n)];

function unitFields(entries) {
  const fields = new Map();
  for (const [name, value] of entries) {
    const offset = UPDATE_FIELDS[name].offset;
    if (typeof value === "bigint") {
      const [low, high] = guidWords(value);
      fields.set(offset, low);
      fields.set(offset + 1, high);
    } else fields.set(offset, value);
  }
  return fields;
}

function fixture({ ready = true, known = [] } = {}) {
  const events = new FakeEvents();
  const self = { guid: SELF, typeId: 4, fields: new Map() };
  const casts = [];
  const dismissed = [];
  const sent = [];
  const renames = [];
  const state = { ready, abandons: 0 };
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, self]]) },
    knownSpells: known.map((id, slot) => ({ id, slot })),
    auras: new Map(),
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    actionButtons: [],
    aurasFor: (guid) => [...(world.auras.get(guid)?.values() ?? [])],
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    setActionButton(slot, action, type) {
      sent.push([slot, action, type]);
      world.actionButtons = [...world.actionButtons.filter((button) => button.slot !== slot),
        ...(action === 0 ? [] : [{ slot, action, type }])];
    },
    dismissCritter: (guid) => dismissed.push(guid),
    // WorldClient's own guards: both opcodes name the pet bar's guid and go nowhere without one.
    abandonPet: () => { if (world.petSpells) state.abandons += 1; },
    renamePet: (name) => { if (world.petSpells) renames.push(name); },
    petSpells: undefined,
    events, targetGuid: undefined, chatLog: [], channels: new Map(), names: new Map(), creatureTemplates: new Map(),
    displayName: () => "",
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id),
    spellAbilities: (id) => ABILITIES.get(id),
    skillMetadata: () => ({ ready: state.ready, revision: 1, skillLine: () => undefined, skillCategory: () => undefined, skillCategories: () => [] }),
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
    spellTabs: () => [["Общий", "", 0, world.knownSpells.length, 0, world.knownSpells.length]],
    spellTabFor: (id) => (world.knownSpells.some((spell) => spell.id === id) ? 1 : undefined),
  });
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 };
  let clock = 100;
  const tick = () => { clock += 1; seam.tick(clock); };
  return { seam, world, self, events, fired, pump, casts, dismissed, sent, renames, state, tick };
}

test("the classifier is the native collections page's: aura 78 or skill line 777 is a mount, 778 a critter", () => {
  assert.equal(frameXmlCompanionKind(SPELLS.get(458), [777]), "MOUNT");
  assert.equal(frameXmlCompanionKind(SPELLS.get(580), [777]), "MOUNT", "skill line alone");
  assert.equal(frameXmlCompanionKind(SPELLS.get(999), []), "MOUNT", "the mounted aura alone");
  assert.equal(frameXmlCompanionKind(SPELLS.get(999), undefined), "MOUNT", "and before the catalog");
  assert.equal(frameXmlCompanionKind(SPELLS.get(4055), [778]), "CRITTER");
  assert.equal(frameXmlCompanionKind(SPELLS.get(4055), undefined), undefined, "a critter needs its row");
  assert.equal(frameXmlCompanionKind(SPELLS.get(1234), [26]), undefined);
  assert.equal(frameXmlCompanionKind(undefined, undefined), undefined);
  assert.equal(frameXmlCompanionCreature("MOUNT", SPELLS.get(458)), 284, "the mounted aura's misc value");
  assert.equal(frameXmlCompanionCreature("CRITTER", SPELLS.get(4055)), 2671, "the summon effect's misc value");
  assert.equal(frameXmlCompanionCreature("MOUNT", SPELLS.get(580)), 0, "no mounted aura on the row: none");
  assert.equal(frameXmlCompanionCreature("CRITTER", undefined), 0);
  const mounted = { guid: SELF, typeId: 4, fields: unitFields([["UNIT_FIELD_MOUNTDISPLAYID", 14337]]) };
  const flagged = { guid: SELF, typeId: 4, fields: unitFields([["UNIT_FIELD_FLAGS", 0x08000000]]) };
  assert.equal(frameXmlUnitMounted(mounted), true);
  assert.equal(frameXmlUnitMounted(flagged), true);
  assert.equal(frameXmlUnitMounted({ guid: SELF, typeId: 4, fields: new Map() }), false);
  assert.equal(frameXmlUnitMounted(undefined), false);
  for (const name of ["GetNumCompanions", "GetCompanionInfo", "CallCompanion", "DismissCompanion", "PickupCompanion",
    "GetCompanionCooldown", "GetPetFoodTypes", "PetCanBeAbandoned", "PetCanBeRenamed", "PetAbandon", "PetRename"]) {
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} is a seam name`);
  }
});

test("the lists are the known spells' companions in the locale's name order, and the catalog's readiness gates the skill-line ones", () => {
  const { seam, pump, fired, state, tick } = fixture({ ready: false, known: [458, 580, 4055, 1234, 999] });
  seam.attach(pump);
  // Before the catalog only the mounted aura classifies: 458 and 999, by name.
  assert.deepEqual(call(seam, "GetNumCompanions", "MOUNT"), [2]);
  assert.deepEqual(call(seam, "GetNumCompanions", "CRITTER"), [0]);
  assert.deepEqual(call(seam, "GetNumCompanions", "critter"), [0], "the kind in any case");
  assert.deepEqual(call(seam, "GetNumCompanions", "PET"), [0]);
  assert.deepEqual(call(seam, "GetCompanionInfo", "MOUNT", 1), [284, "Гнедой конь", 458, "Interface\\Icons\\Ability_Mount_RidingHorse", false]);
  assert.deepEqual(call(seam, "GetCompanionInfo", "MOUNT", 2), [777, "Ковёр", 999, "Interface\\Icons\\Ability_Mount_Carpet", false]);
  assert.deepEqual(call(seam, "GetCompanionInfo", "MOUNT", 3), [], "nothing past the list");
  assert.deepEqual(companionEvents(fired), [["COMPANION_UPDATE", "MOUNT"]],
    "the first reconcile fills the stock frame's idMount/idCritter through COMPANION_UPDATE");
  fired.length = 0;
  state.ready = true;
  tick();
  assert.deepEqual(call(seam, "GetNumCompanions", "MOUNT"), [3]);
  assert.deepEqual(call(seam, "GetNumCompanions", "CRITTER"), [1]);
  assert.deepEqual([1, 2, 3].map((index) => call(seam, "GetCompanionInfo", "MOUNT", index)[1]),
    ["Большой лесной волк", "Гнедой конь", "Ковёр"], "by name, not by id");
  assert.deepEqual(call(seam, "GetCompanionInfo", "CRITTER", 1), [2671, "Механическая белка", 4055, "Interface\\Icons\\INV_Crate_01", false]);
  assert.deepEqual(companionEvents(fired), [["COMPANION_UPDATE", "CRITTER"], ["COMPANION_UPDATE", "MOUNT"]],
    "a catalog arriving late is an update of the same list, not a learning");
});

test("a replaced spell list is a learning or an unlearning; the initial list is neither", () => {
  const { seam, world, pump, fired, tick } = fixture();
  seam.attach(pump);
  assert.deepEqual(companionEvents(fired), [], "no companions, no event");
  world.knownSpells = [{ id: 458, slot: 0 }, { id: 4055, slot: 1 }];
  tick();
  assert.deepEqual(companionEvents(fired), [["COMPANION_UPDATE", "CRITTER"], ["COMPANION_UPDATE", "MOUNT"]],
    "SMSG_INITIAL_SPELLS over an empty list is not a learning");
  fired.length = 0;
  world.knownSpells = [...world.knownSpells, { id: 580, slot: 2 }];
  tick();
  assert.deepEqual(companionEvents(fired), [["COMPANION_LEARNED"]]);
  assert.deepEqual(call(seam, "GetCompanionInfo", "MOUNT", 1)[2], 580, "the wolf sorts first");
  fired.length = 0;
  tick();
  assert.deepEqual(companionEvents(fired), [], "an unchanged world is quiet");
  world.knownSpells = world.knownSpells.filter((spell) => spell.id !== 458);
  tick();
  assert.deepEqual(companionEvents(fired), [["COMPANION_UNLEARNED"]]);
  assert.deepEqual(call(seam, "GetNumCompanions", "MOUNT"), [1]);
  fired.length = 0;
  world.knownSpells = [{ id: 1234, slot: 0 }, ...world.knownSpells];
  tick();
  assert.deepEqual(companionEvents(fired), [], "a spell that is no companion changes nothing");
});

test("isSummoned is the mount worn and the critter in view; dismissing is the dismount cast and CMSG_DISMISS_CRITTER", () => {
  const { seam, world, self, pump, fired, casts, dismissed, tick } = fixture({ known: [458, 580, 4055] });
  seam.attach(pump);
  fired.length = 0;
  const info = (type, index) => call(seam, "GetCompanionInfo", type, index);
  // The aura alone is not a mount: the unit must be mounted too (isActiveMountSpell's rule).
  world.auras.set(SELF, new Map([[3, { slot: 3, spellId: 458, flags: 0, casterLevel: 80, applications: 1 }]]));
  tick();
  assert.equal(info("MOUNT", 2)[4], false, "an aura on an unmounted player");
  assert.deepEqual(companionEvents(fired), []);
  self.fields = unitFields([["UNIT_FIELD_MOUNTDISPLAYID", 14337]]);
  tick();
  assert.equal(info("MOUNT", 2)[4], true, "the horse is worn");
  assert.equal(info("MOUNT", 1)[4], false, "the wolf is not");
  assert.deepEqual(companionEvents(fired), [["COMPANION_UPDATE", "MOUNT"]]);
  fired.length = 0;
  call(seam, "DismissCompanion", "MOUNT");
  assert.deepEqual(casts, [458], "the worn mount's spell again: the client's dismount toggle");
  call(seam, "DismissCompanion", "CRITTER");
  assert.deepEqual(dismissed, [], "no critter is out");

  // A creature the player summoned, created by the critter's spell.
  world.state.objects.set(STRANGER, { guid: STRANGER, typeId: 3, fields: unitFields([["UNIT_FIELD_SUMMONEDBY", STRANGER], ["UNIT_CREATED_BY_SPELL", 4055]]) });
  tick();
  assert.equal(info("CRITTER", 1)[4], false, "another player's squirrel");
  world.state.objects.set(CRITTER, { guid: CRITTER, typeId: 3, fields: unitFields([["UNIT_FIELD_SUMMONEDBY", SELF], ["UNIT_CREATED_BY_SPELL", 4055]]) });
  tick();
  assert.equal(info("CRITTER", 1)[4], true);
  assert.deepEqual(companionEvents(fired), [["COMPANION_UPDATE", "CRITTER"]]);
  call(seam, "DismissCompanion", "CRITTER");
  assert.deepEqual(dismissed, [CRITTER]);
  fired.length = 0;
  world.state.objects.delete(CRITTER);
  world.auras.delete(SELF);
  self.fields = new Map();
  tick();
  assert.deepEqual(companionEvents(fired), [["COMPANION_UPDATE", "CRITTER"], ["COMPANION_UPDATE", "MOUNT"]]);
  assert.equal(info("MOUNT", 2)[4], false);
  assert.equal(info("CRITTER", 1)[4], false);

  call(seam, "CallCompanion", "CRITTER", 1);
  call(seam, "CallCompanion", "MOUNT", 1);
  call(seam, "CallCompanion", "MOUNT", 9);
  assert.deepEqual(casts, [458, 4055, 580], "CallCompanion casts the entry's spell; nothing past the list");
});

test("the cooldown, the cursor and the pet page's own calls", async () => {
  const { seam, world, pump, casts, sent, renames, state } = fixture({ known: [458, 4055] });
  seam.attach(pump);
  world.cooldownSnapshots.set(458, { startedAt: 500, duration: 3000, endsAt: 3500 });
  assert.deepEqual(call(seam, "GetCompanionCooldown", "MOUNT", 1), [99.5, 3, 1], "GetSpellCooldown's shape on GetTime's axis");
  assert.deepEqual(call(seam, "GetCompanionCooldown", "CRITTER", 1), [0, 0, 0]);
  assert.deepEqual(call(seam, "GetCompanionCooldown", "CRITTER", 2), [], "nothing past the list");

  call(seam, "PickupCompanion", "MOUNT", 1);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["companion", 1, "MOUNT"]);
  assert.deepEqual(call(seam, "CursorHasSpell"), [false], "a companion is its own cursor shape");
  call(seam, "PickupCompanion", "MOUNT", 1);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["companion", 1, "MOUNT"], "dropped back where it came from: still held");
  await new Promise((resolve) => setTimeout(resolve, 0));
  call(seam, "PlaceAction", 5);
  // The world's slot is the server's 0-based one (CMSG_SET_ACTION_BUTTON); Lua's 5 is its 4.
  assert.deepEqual(sent, [[4, 458, ACTION_BUTTON_SPELL]], "on a bar it is the spell action the client's bar holds");
  assert.deepEqual(call(seam, "GetActionInfo", 5), ["spell", 1, "spell", 458]);
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "an empty slot gives nothing back");
  assert.deepEqual(casts, [], "nothing was cast by the drag");
  call(seam, "PickupCompanion", "CRITTER", 7);
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "nothing past the list");

  assert.deepEqual(call(seam, "PetCanBeAbandoned"), [false], "no pet");
  assert.deepEqual(call(seam, "PetCanBeRenamed"), [false]);
  call(seam, "PetAbandon");
  call(seam, "PetRename", "Шарик");
  assert.equal(state.abandons, 0, "no pet: nothing is sent");
  assert.deepEqual(renames, []);
  // UNIT_FIELD_BYTES_2's pet-flags byte (2): UNIT_CAN_BE_RENAMED 0x01 | UNIT_CAN_BE_ABANDONED 0x02.
  world.petSpells = { guid: PET, closed: false, creatureFamily: 1, duration: 0, reactState: 0, commandState: 0, flags: 0, bar: [], spells: [], cooldowns: [] };
  // L17 3.09: PetRename is Wow.exe's 0x005d5670 now (FrameXmlPetDeclension.ts): the pet must be the
  // player's (UNIT_FIELD_SUMMONEDBY) and renameable, the name must pass the client's check, and a Cyrillic
  // name on ruRU first opens the declension frame — so a Latin name is the plain send here.
  world.state.objects.set(PET, { guid: PET, typeId: 3, fields: unitFields([["UNIT_FIELD_BYTES_2", 0x03 << 16], ["UNIT_FIELD_SUMMONEDBY", SELF]]) });
  assert.deepEqual(call(seam, "PetCanBeAbandoned"), [true]);
  assert.deepEqual(call(seam, "PetCanBeRenamed"), [true]);
  call(seam, "PetRename", "Rex");
  call(seam, "PetRename", "   ");
  assert.deepEqual(renames, ["Rex"], "a renameable pet takes a good name; spaces fail the client's check");
  world.state.objects.get(PET).fields = unitFields([["UNIT_FIELD_BYTES_2", 0x02 << 16], ["UNIT_FIELD_SUMMONEDBY", SELF]]);
  assert.deepEqual(call(seam, "PetCanBeRenamed"), [false], "named once: the flag is gone");
  call(seam, "PetAbandon");
  call(seam, "PetRename", "Шарик");
  assert.equal(state.abandons, 1);
  assert.deepEqual(renames, ["Rex"], "not renameable: nothing more is sent");
  assert.deepEqual(call(seam, "GetPetFoodTypes"), [], "no diet table on this client: nothing, never a guess");
});

test("the model alone: attach seeds silently and a host without a world answers nothing", () => {
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 };
  let known;
  const model = new FrameXmlCompanionModel({
    knownSpells: () => known, spell: (id) => SPELLS.get(id), skillLines: (id) => ABILITIES.get(id)?.map((row) => row.skillLine) ?? [],
    mounted: () => false, hasAura: () => false, forEachSummon: () => {}, cast: () => {}, dismissCritter: () => {},
    cooldown: () => [0, 0, 0], pickup: () => {}, locale: () => "ruRU",
  });
  model.attach(pump);
  assert.equal(model.count("MOUNT"), 0);
  assert.deepEqual(model.info("MOUNT", 1), []);
  known = [{ id: 580 }, { id: 458 }];
  model.tick();
  assert.deepEqual(model.entries("MOUNT").map((entry) => entry.spellId), [580, 458]);
  assert.deepEqual(fired, [["COMPANION_UPDATE", "MOUNT"]]);
  model.detach();
  fired.length = 0;
  known = [{ id: 580 }];
  model.tick();
  assert.deepEqual(fired, [], "detached: no pump, no event");
  assert.equal(model.count("MOUNT"), 1, "but the list is the world's");
});
