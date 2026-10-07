import assert from "node:assert/strict";
import test from "node:test";

// 11.02-IF: possession in the stock UI (world/PossessBar.ts, framexml/FrameXmlPossess.ts) — Wow.exe
// 3.3.5a: the possess spell among the character's own auras (0x005d62a0), the main-bar bit (0x005d4ad0),
// GetBonusBarOffset 5 (0x005a83c0), GetActionBarPage 1 (0x005a7fd0), PetHasActionBar nil (0x005d3720),
// slots 121-130 mirroring the pet bar (0x005ab800/0x005d3240), IsPossessBarVisible (0x005a8820),
// GetPossessInfo (0x005d5820), UseAction on the page (0x005abbc0 -> 0x005d4210), CancelUnitBuff by
// name (0x00804220), PLAYER_FARSIGHT_FOCUS_CHANGED (0x006e4fd0, event 0xA1), PLAYER_CONTROL_LOST/GAINED
// only for the character's own guid (0x0071c930 -> 0x00520fe0).

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_POSSESS_CANCEL_TEXTURE } = await import("../dist/code/browser/framexml/FrameXmlPossess.js");
const {
  possessSpellOf, possessMirrorIndex, possessBarOnMainBar, possessBarUnitUsable, isHunterPet, drivesCharm,
  POSSESS_BONUS_BAR_OFFSET, CREATURE_TYPE_FLAG_NO_PET_BAR,
} = await import("../dist/code/world/PossessBar.js");
const {
  ACT_COMMAND, ACT_PASSIVE, ACT_REACTION, COMMAND_ATTACK, COMMAND_FOLLOW, REACT_DEFENSIVE, REACT_AGGRESSIVE, packPetAction,
} = await import("../dist/code/world/PetProtocol.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader, PacketWriter } = await import("../dist/code/protocol/index.js");

const SELF = 0x10n;
const MOB = 0xf130_0000_0004_d2a0n;
const OTHER_MOB = 0xf130_0000_0004_d2b0n;
const EYE = 0xf110_0000_0000_0300n;
const ENEMY = 0xf130_0000_0000_0077n;
const MOB_ENTRY = 1234;
const MIND_CONTROL = 605;
const FIREBALL = 20793;
const FROST_NOVA = 11831;
const SWING = 6603;
const FAR_SIGHT = 6196;

const F = (name) => UPDATE_FIELDS[name].offset;
const FARSIGHT = F("PLAYER_FARSIGHT");
const FLAGS = F("UNIT_FIELD_FLAGS");
const CHARM = F("UNIT_FIELD_CHARM");
const CHARMED_BY = F("UNIT_FIELD_CHARMEDBY");
const CREATED_BY = F("UNIT_FIELD_CREATEDBY");
const HEALTH = F("UNIT_FIELD_HEALTH");
const ENTRY = F("OBJECT_FIELD_ENTRY");
const BYTES_0 = F("UNIT_FIELD_BYTES_0");
const PET_NUMBER = F("UNIT_FIELD_PETNUMBER");
const POSSESSED = 0x0100_0000;
const PLAYER_CONTROLLED = 0x08;
const AFLAG_CASTER = 0x08;
const AFLAG_POSITIVE = 0x10;
const AFLAG_NEGATIVE = 0x80;

const SPELLS = new Map([
  [MIND_CONTROL, {
    id: MIND_CONTROL, name: "Контроль над разумом", rank: "", iconPath: "Interface\\Icons\\Spell_Shadow_ShadowWordDominate",
    effectAura: [2, 4, 138], effects: [6, 6, 6], attributes: [0x40140000, 0x4022005, 0, 0, 0, 0, 0, 0],
    channeled: true, passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0,
  }],
  [FIREBALL, {
    id: FIREBALL, name: "Огненный шар", rank: "", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt",
    effectAura: [0, 0, 0], effects: [2, 0, 0], passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0,
  }],
  [FROST_NOVA, {
    id: FROST_NOVA, name: "Кольцо льда", rank: "", iconPath: "Interface\\Icons\\Spell_Frost_FrostNova",
    effectAura: [26, 0, 0], effects: [6, 0, 0], passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0,
  }],
  [SWING, {
    id: SWING, name: "Атака", rank: "", iconPath: "Interface\\Icons\\INV_Sword_04",
    effectAura: [0, 0, 0], effects: [78, 0, 0], passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0,
  }],
  [FAR_SIGHT, {
    id: FAR_SIGHT, name: "Дальнее зрение", rank: "", iconPath: "Interface\\Icons\\Spell_Nature_FarSight",
    effectAura: [0, 4, 0], effects: [72, 6, 0], attributes: [0x8000, 0x22004, 0, 0, 0, 0, 0, 0],
    channeled: true, passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0,
  }],
]);

/** `CharmInfo::InitPossessCreateSpells`: the attack command, then the creature's spells as ACT_PASSIVE. */
const POSSESS_BAR = [
  packPetAction(COMMAND_ATTACK, ACT_COMMAND), packPetAction(FIREBALL, ACT_PASSIVE), packPetAction(FROST_NOVA, ACT_PASSIVE),
  packPetAction(0, ACT_PASSIVE), packPetAction(SWING, ACT_PASSIVE), packPetAction(0, ACT_PASSIVE),
  packPetAction(0, ACT_PASSIVE), packPetAction(0, ACT_PASSIVE), packPetAction(REACT_AGGRESSIVE, ACT_REACTION),
  packPetAction(0, ACT_PASSIVE),
];

function petSpells(guid, words = POSSESS_BAR) {
  return {
    guid, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW, flags: 0,
    spells: [], cooldowns: [],
    bar: words.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
  };
}

function setGuid(object, offset, guid) {
  object.fields.set(offset, Number(guid & 0xffff_ffffn));
  object.fields.set(offset + 1, Number(guid >> 32n));
}

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) { listeners = new Set(); this.#listeners.set(name, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
  count(name) { return this.#listeners.get(name)?.size ?? 0; }
}

function object(guid, typeId, fields = []) {
  return { guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0, fields: new Map(fields), transport: undefined };
}

/** The live seam over a fake WorldClient: a priest beside a creature it can Mind Control. */
function fixture() {
  const player = object(SELF, 4, [[FLAGS, PLAYER_CONTROLLED], [HEALTH, 100], [BYTES_0, 5 << 8]]);
  const mob = object(MOB, 3, [[ENTRY, MOB_ENTRY], [HEALTH, 500], [FLAGS, 0]]);
  const auras = new Map();
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [MOB, mob]]) },
    events: new FakeEvents(),
    movementReady: true,
    controlledGuid: undefined,
    controlRefusedGuid: undefined,
    attacking: false,
    targetGuid: ENEMY,
    petSpells: undefined,
    petCooldowns: new Map(),
    partyStats: new Map(),
    auras,
    aurasFor: (guid) => [...(auras.get(guid) ?? [])],
    // The character's own button on page 11 (slot 121): the possess page must not read it.
    actionButtons: [{ slot: 0, type: 0, action: 585 }, { slot: 120, type: 0, action: 585 }],
    casts: new Map(),
    cooldownRemaining: () => 0,
    cooldownState: () => undefined,
    names: new Map(),
    creatureTemplates: new Map([[MOB_ENTRY, { entry: MOB_ENTRY, flags: 0, creatureType: 7 }]]),
    totems: new Map(),
    used: [],
    usePetSlot(slot, target) { this.used.push([slot, target]); },
    cancelled: [],
    cancelAura(spellId) { this.cancelled.push(spellId); },
    // 11.02-IF-review: CMSG_SET_ACTION_BUTTON for the cursor's pickups and drops.
    writes: [],
    setActionButton(slot, action, type) { this.writes.push([slot, action, type]); },
  };
  const fired = [];
  let now = 0;
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now };
  const listeners = new Map();
  const store = {
    field: (subject, name, listener) => {
      if (subject !== "self") return () => {};
      let set = listeners.get(name);
      if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: (id) => SPELLS.get(id),
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const fieldEdge = (name) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(player, SELF); };
  return {
    seam, world, player, mob, fired, pump, call, fieldEdge,
    frame() { now += 0.1; seam.tick(now); },
    /** The core's order (Unit::SetCharmedBy POSSESS, Unit.cpp:12526-12536): control, bar, caster aura, then the fields. */
    mindControl() {
      world.controlledGuid = MOB;
      world.petSpells = petSpells(MOB);
      world.events.emit("PET_BAR_CHANGED", { guid: MOB });
      auras.set(SELF, [{ slot: 0, spellId: MIND_CONTROL, flags: AFLAG_CASTER | AFLAG_POSITIVE, casterLevel: 80, applications: 0, casterGuid: SELF }]);
      mob.fields.set(FLAGS, POSSESSED);
      setGuid(mob, CHARMED_BY, SELF);
      setGuid(player, CHARM, MOB);
      setGuid(player, FARSIGHT, MOB);
      fieldEdge("PLAYER_FARSIGHT");
    },
    /** Unit::RemoveCharmedBy: (unit, 0), (character, 1), the bar closed, then the fields cleared. */
    release() {
      world.controlledGuid = SELF;
      world.petSpells = undefined;
      world.events.emit("PET_BAR_CHANGED", { guid: 0n });
      auras.delete(SELF);
      mob.fields.set(FLAGS, 0);
      setGuid(mob, CHARMED_BY, 0n);
      setGuid(player, CHARM, 0n);
      setGuid(player, FARSIGHT, 0n);
      fieldEdge("PLAYER_FARSIGHT");
    },
  };
}

const POSSESS_EVENTS = new Set([
  "UPDATE_BONUS_ACTIONBAR", "ACTIONBAR_PAGE_CHANGED", "ACTIONBAR_SLOT_CHANGED", "PET_BAR_UPDATE",
  "PLAYER_FARSIGHT_FOCUS_CHANGED", "PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED", "ACTIONBAR_UPDATE_STATE",
]);
const possessEvents = (fired) => fired.filter(([name]) => POSSESS_EVENTS.has(name))
  .map(([name, arg]) => (name === "ACTIONBAR_SLOT_CHANGED" ? `${name}:${arg}` : name));
const SLOT_EDGES = Array.from({ length: 12 }, (_, index) => `ACTIONBAR_SLOT_CHANGED:${121 + index}`);

// ---- the rules ------------------------------------------------------------------------------------

test("11.02-IF: the possess spell is the character's own aura with a possess, possess-pet or charm effect (0x005d62a0)", () => {
  const row = (id) => SPELLS.get(id) ?? (id === 1002 ? { effectAura: [128, 4, 79] } : id === 46598 ? { effectAura: [236, 0, 0] } : undefined);
  const aura = (spellId, flags = AFLAG_POSITIVE) => ({ slot: 0, spellId, flags, casterLevel: 80, applications: 0 });
  assert.deepEqual(possessSpellOf([aura(FIREBALL), aura(MIND_CONTROL)], row, false), { spellId: MIND_CONTROL, pending: false });
  assert.deepEqual(possessSpellOf([aura(1002)], row, false), { spellId: 1002, pending: false }, "Eyes of the Beast: MOD_POSSESS_PET");
  assert.deepEqual(possessSpellOf([aura(MIND_CONTROL, AFLAG_NEGATIVE)], row, false), { spellId: 0, pending: false },
    "an aura flagged negative is skipped (byte +0xc bit 7)");
  assert.deepEqual(possessSpellOf([aura(46598)], row, false), { spellId: 0, pending: false }, "CONTROL_VEHICLE only while driving");
  assert.deepEqual(possessSpellOf([aura(46598)], row, true), { spellId: 46598, pending: false });
  assert.deepEqual(possessSpellOf([aura(FAR_SIGHT)], row, false), { spellId: 0, pending: false }, "Far Sight is no possession");
  assert.deepEqual(possessSpellOf([aura(99999), aura(FIREBALL)], row, false), { spellId: 0, pending: true },
    "a row not cached yet: look again");
  const player = object(SELF, 4);
  setGuid(player, CHARM, MOB);
  assert.equal(drivesCharm(player), false);
  player.transport = { guid: 0x1fc0_0000_0000_0007n, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
  assert.equal(drivesCharm(player), false, "on a boat, not on the charm");
  player.transport = { guid: MOB, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
  assert.equal(drivesCharm(player), true, "riding the charm (vfunc +0x40 = the transport)");
});

test("11.02-IF: the page's slots, the main-bar condition and the unit's bar gate (0x005d3240, 0x005d4ad0, 0x005d35b0)", () => {
  assert.equal(possessMirrorIndex(120), undefined);
  assert.equal(possessMirrorIndex(121), 0);
  assert.equal(possessMirrorIndex(130), 9);
  assert.equal(possessMirrorIndex(131), -1, "131-132: on the page, empty");
  assert.equal(possessMirrorIndex(132), -1);
  assert.equal(possessMirrorIndex(133), undefined);
  const bar = petSpells(MOB);
  assert.equal(possessBarOnMainBar(MOB, bar, true), true);
  assert.equal(possessBarOnMainBar(undefined, bar, true), false, "no far sight");
  assert.equal(possessBarOnMainBar(OTHER_MOB, bar, true), false, "the far sight is another unit");
  assert.equal(possessBarOnMainBar(MOB, bar, false), false);
  assert.equal(possessBarOnMainBar(MOB, petSpells(MOB, [packPetAction(62345, 8)]), true), false, "a vehicle's bar is slice F2's");
  assert.equal(possessBarOnMainBar(MOB, { ...bar, closed: true }, true), false);
  const mob = object(MOB, 3, [[HEALTH, 10]]);
  assert.equal(possessBarUnitUsable(mob, 0, false, false), true);
  assert.equal(possessBarUnitUsable(mob, CREATURE_TYPE_FLAG_NO_PET_BAR, false, false), false, "CREATURE_TYPE_FLAG_NO_PET_BAR");
  assert.equal(possessBarUnitUsable(object(MOB, 3, [[HEALTH, 0]]), 0, false, false), false, "dead");
  assert.equal(possessBarUnitUsable(mob, 0, true, false), false, "a possess spell seen and gone");
  assert.equal(possessBarUnitUsable(mob, 0, true, true), true, "... unless a hunter's pet");
  const hunter = object(0x20n, 4, [[BYTES_0, 3 << 8]]);
  const pet = object(0xf140_0000_0000_0001n, 3, [[PET_NUMBER, 7]]);
  setGuid(pet, CREATED_BY, 0x20n);
  assert.equal(isHunterPet(pet, (guid) => (guid === 0x20n ? hunter : undefined)), true);
  hunter.fields.set(BYTES_0, 9 << 8);
  assert.equal(isHunterPet(pet, (guid) => (guid === 0x20n ? hunter : undefined)), false, "a warlock's demon");
  assert.equal(POSSESS_BONUS_BAR_OFFSET, 5);
});

// ---- the stock C API over the live seam ---------------------------------------------------------

test("11.02-IF: no possession -> nothing changes (offset, page, slot 121, pet bar, possess bar, events)", () => {
  const { seam, call, pump, fired, frame, world, fieldEdge } = fixture();
  seam.attach(pump);
  frame();
  assert.deepEqual(call("GetBonusBarOffset"), [0]);
  assert.deepEqual(call("GetActionBarPage"), [1]);
  assert.deepEqual(call("HasAction", 121), [true], "the character's own button on page 11");
  assert.deepEqual(call("IsPossessBarVisible"), [false]);
  assert.deepEqual(call("GetPossessInfo", 1), [undefined, undefined, undefined], "0x005d5820: three nils");
  assert.deepEqual(call("PetHasActionBar"), [false], "no bar: the pet bar model's answer, as before");
  // A pet's bar with no far sight stays the stock pet bar's.
  world.petSpells = petSpells(MOB, [packPetAction(COMMAND_ATTACK, ACT_COMMAND), packPetAction(FIREBALL, 0xc1)]);
  world.events.emit("PET_BAR_CHANGED", { guid: MOB });
  frame();
  fieldEdge("PLAYER_FARSIGHT");
  assert.deepEqual(call("PetHasActionBar"), [true]);
  assert.deepEqual(call("GetBonusBarOffset"), [0]);
  assert.deepEqual(call("HasAction", 122), [false], "page 11 is still the character's (empty there)");
  const ownEdges = possessEvents(fired).filter((name) => /^(UPDATE_BONUS_ACTIONBAR|PLAYER_FARSIGHT_FOCUS_CHANGED|ACTIONBAR_PAGE_CHANGED)$/.test(name)
    || /^ACTIONBAR_SLOT_CHANGED:1(2[1-9]|3[0-2])$/.test(name));
  assert.deepEqual(ownEdges, [], "no possess edge (the pet bar's PET_BAR_UPDATE and slot 1's edge are the seam's own)");
  seam.detach();
});

test("11.02-IF: Mind Control — the bar arrives, then PLAYER_FARSIGHT: possess buttons, bonus bar 5, events in Wow.exe's order", () => {
  const { seam, call, pump, fired, frame, mindControl } = fixture();
  seam.attach(pump);
  frame();
  fired.length = 0;
  mindControl();
  assert.deepEqual(possessEvents(fired), [
    "PET_BAR_UPDATE", // the pet bar model's own edge on SMSG_PET_SPELLS
    "UPDATE_BONUS_ACTIONBAR", // 0x005d62a0 found the possess spell
    ...SLOT_EDGES, // 0x005ab800: the page written again
    "UPDATE_BONUS_ACTIONBAR", // 0x005a83c0: the offset moved 0 -> 5
    "PET_BAR_UPDATE", // 0x005d4ad0
    "PLAYER_FARSIGHT_FOCUS_CHANGED", // 0x006e4fd0, event 0xA1
  ]);
  assert.deepEqual(call("GetBonusBarOffset"), [5]);
  assert.deepEqual(call("GetActionBarPage"), [1], "0x005a7fd0: page 1 while the bit is set");
  assert.deepEqual(call("PetHasActionBar"), [], "0x005d3720: the bar is on the main bar");
  assert.deepEqual(call("IsPossessBarVisible"), [true]);
  assert.deepEqual(call("GetPossessInfo", 1), ["Interface\\Icons\\Spell_Shadow_ShadowWordDominate", "Контроль над разумом", true]);
  assert.deepEqual(call("GetPossessInfo", 2), [FRAMEXML_POSSESS_CANCEL_TEXTURE, "Контроль над разумом", true],
    "slot 2: SpellIcon 693, enabled unless SPELL_ATTR0_CANT_CANCEL");
  assert.deepEqual(call("GetPossessInfo", 3), [undefined, undefined, undefined]);
  const before = fired.length;
  frame();
  frame();
  assert.equal(possessEvents(fired.slice(before)).length, 0, "the polls after say nothing more");
  seam.detach();
});

test("11.02-IF: the bonus page answers from the possessed unit's bar (0x005a8160, 0x005a97f0, 0x005a8f10, 0x005aa240)", () => {
  const { seam, call, pump, frame, mindControl, world } = fixture();
  seam.attach(pump);
  call("ChangeActionBarPage", 3);
  assert.deepEqual(call("GetActionBarPage"), [3]);
  mindControl();
  frame();
  assert.deepEqual(call("GetActionBarPage"), [1], "0x005a7fd0: page 1 whatever page the player chose");
  assert.deepEqual([121, 122, 123, 124, 125, 129, 130, 131, 132].map((slot) => call("HasAction", slot)[0]),
    [true, true, true, false, true, true, false, false, false]);
  assert.deepEqual(call("GetActionTexture", 121), ["Interface\\Icons\\Ability_GhoulFrenzy"], "PET_ATTACK_TEXTURE");
  assert.deepEqual(call("GetActionTexture", 122), ["Interface\\Icons\\Spell_Fire_FlameBolt"]);
  assert.deepEqual(call("GetActionTexture", 129), ["Interface\\Icons\\Ability_Racial_BloodRage"], "PET_AGGRESSIVE_TEXTURE");
  assert.deepEqual(call("GetActionTexture", 124), []);
  assert.deepEqual(call("GetActionInfo", 122), ["spell", 0, "pet", FIREBALL], "off the pet book: index 0");
  assert.deepEqual(call("GetActionInfo", 121), ["spell", 0, "pet", 0], "a command's word is still a pet slot");
  assert.deepEqual(call("GetActionInfo", 131), []);
  assert.deepEqual(call("IsCurrentAction", 121), [undefined], "attack: not swinging");
  world.petAttackVictim = ENEMY;
  assert.deepEqual(call("IsCurrentAction", 121), [1]);
  assert.deepEqual(call("IsCurrentAction", 129), [undefined], "aggressive is not the bar's defensive state");
  assert.deepEqual(call("IsCurrentAction", 122), [undefined], "a pet spell (state 1) is never current");
  assert.deepEqual(call("IsAttackAction", 125), [1], "SPELL_EFFECT_ATTACK first");
  assert.deepEqual(call("IsAttackAction", 122), [undefined]);
  assert.deepEqual(call("GetActionCooldown", 122), [0, 0, 0]);
  assert.deepEqual(call("IsUsableAction", 122), [true, false]);
  assert.deepEqual(call("IsUsableAction", 124), [false, false]);
  assert.deepEqual(call("GetActionCount", 122), [0]);
  assert.deepEqual(call("GetActionText", 122), []);
  assert.deepEqual(call("GetActionTooltip", 122), ["spell", FIREBALL, "Огненный шар", ""]);
  assert.deepEqual(call("IsActionInRange", 122), [], "the range from the unit is not modelled: nil");
  assert.equal(seam.actionTooltip(122)?.id, FIREBALL, "the GameTooltip adapter's path");
  call("PickupAction", 122);
  call("UseAction", 122);
  call("UseAction", 121, "target");
  call("UseAction", 124);
  assert.deepEqual(world.used, [[1, undefined], [0, undefined], [3, undefined]],
    "0x005abbc0 -> 0x005d4210 with an empty guid: the current target, whatever unit the call named");
  assert.deepEqual(call("HasAction", 1), [true], "page 1 is untouched");
  seam.detach();
});

test("11.02-IF: a possessed unit's bonus button casts CMSG_PET_CAST_SPELL from the unit; its command CMSG_PET_ACTION", async () => {
  const login = new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array();
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }], sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.move(MOB, { flags: 0, position: { x: 3, y: 0, z: 0, orientation: 0 } });
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  const player = client.state.objects.get(SELF);
  const mob = client.state.objects.get(MOB);
  mob.typeId = 3;
  mob.fields.set(HEALTH, 500);
  let now = 0;
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell: (id) => SPELLS.get(id),
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  seam.attach({ fire: () => 1, now: () => now });
  try {
    client.controlledGuid = MOB;
    client.petSpells = petSpells(MOB);
    client.auras.set(SELF, new Map([[0, { slot: 0, spellId: MIND_CONTROL, flags: AFLAG_CASTER | AFLAG_POSITIVE, casterLevel: 80, applications: 0 }]]));
    mob.fields.set(FLAGS, POSSESSED);
    setGuid(mob, CHARMED_BY, SELF);
    setGuid(player, CHARM, MOB);
    setGuid(player, FARSIGHT, MOB);
    client.targetGuid = ENEMY;
    now += 0.1;
    seam.tick(now);
    assert.deepEqual(call("GetBonusBarOffset"), [5]);
    connection.sent.length = 0;
    call("UseAction", 122);
    call("UseAction", 121);
    assert.deepEqual(connection.sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_PET_ACTION]);
    const cast = new PacketReader(connection.sent[0].payload);
    assert.equal(cast.u64(), MOB, "the caster is the possessed unit");
    cast.u8();
    assert.equal(cast.u32(), FIREBALL);
    assert.equal(cast.u8(), 0);
    assert.equal(cast.u32(), 0x2);
    assert.equal(cast.packedGuid(), ENEMY);
    const action = new PacketReader(connection.sent[1].payload);
    assert.equal(action.u64(), MOB);
    assert.equal(action.u32(), packPetAction(COMMAND_ATTACK, ACT_COMMAND));
    // The cancel button: CancelUnitBuff("player", name) -> CMSG_CANCEL_AURA (SpellHandler.cpp ends the channel).
    connection.sent.length = 0;
    call("CancelUnitBuff", "player", "Контроль над разумом");
    assert.deepEqual(connection.sent.map((packet) => [packet.opcode, ...packet.payload]),
      [[OPCODES.CMSG_CANCEL_AURA, ...new PacketWriter().u32(MIND_CONTROL).toUint8Array()]]);
  } finally {
    seam.detach();
    client.close();
  }
});

test("11.02-IF: CancelUnitBuff by name — the cancel button's path, and what it leaves alone", () => {
  const { seam, call, pump, mindControl, world, player } = fixture();
  seam.attach(pump);
  mindControl();
  call("CancelUnitBuff", "player", "КОНТРОЛЬ НАД РАЗУМОМ");
  assert.deepEqual(world.cancelled, [MIND_CONTROL], "the name compares case-insensitively");
  call("CancelUnitBuff", "player", "Контроль над разумом", "Уровень 3");
  call("CancelUnitBuff", "player", "Контроль над разумом", undefined, "HARMFUL");
  call("CancelUnitBuff", "player", "Кольцо льда");
  call("CancelUnitBuff", "target", "Контроль над разумом");
  // Neither flagged positive nor channeled (0x00804220: aura flags & 0x10 or AttributesEx & 4).
  world.auras.get(SELF).push({ slot: 1, spellId: FIREBALL, flags: AFLAG_CASTER, casterLevel: 80, applications: 0 });
  call("CancelUnitBuff", "player", "Огненный шар");
  assert.deepEqual(world.cancelled, [MIND_CONTROL],
    "a wrong rank, a harmful filter, no such aura, another unit, an aura neither positive nor channeled: nothing");
  setGuid(player, CHARMED_BY, ENEMY);
  call("CancelUnitBuff", "player", "Контроль над разумом");
  assert.deepEqual(world.cancelled, [MIND_CONTROL], "0x00802f80: a charmed character cancels nothing");
  setGuid(player, CHARMED_BY, 0n);
  // SPELL_ATTR0_CANT_CANCEL: the cancel slot is disabled and the press sends nothing.
  const row = SPELLS.get(MIND_CONTROL);
  const saved = row.attributes;
  row.attributes = [0x80000000, 0x4022005, 0, 0, 0, 0, 0, 0];
  try {
    assert.deepEqual(call("GetPossessInfo", 2), [FRAMEXML_POSSESS_CANCEL_TEXTURE, "Контроль над разумом", false]);
    call("CancelUnitBuff", "player", "Контроль над разумом");
    assert.deepEqual(world.cancelled, [MIND_CONTROL]);
  } finally {
    row.attributes = saved;
  }
  seam.detach();
});

test("11.02-IF: possession ends — the bar closes first, then the far sight: the page and the offset go home", () => {
  const { seam, call, pump, fired, frame, mindControl, release } = fixture();
  seam.attach(pump);
  mindControl();
  frame();
  fired.length = 0;
  release();
  assert.deepEqual(possessEvents(fired), [
    // SMSG_PET_SPELLS(0): 0x005d6900 -> 0x005d4ad0 clears the bit — 0x005a83c0 leaving offset 5 — then
    // PET_BAR_UPDATE (the pet bar model's own edge on the packet).
    "ACTIONBAR_PAGE_CHANGED", "UPDATE_BONUS_ACTIONBAR", "PET_BAR_UPDATE",
    "UPDATE_BONUS_ACTIONBAR", // 0x005d30e0(0): the possess spell cleared
    "PET_BAR_UPDATE", "PLAYER_FARSIGHT_FOCUS_CHANGED",
  ]);
  assert.deepEqual(call("GetBonusBarOffset"), [0]);
  assert.deepEqual(call("IsPossessBarVisible"), [false]);
  assert.deepEqual(call("GetPossessInfo", 1), [undefined, undefined, undefined]);
  assert.deepEqual(call("HasAction", 121), [true], "slot 121 is the character's own again");
  frame();
  seam.detach();
});

test("11.02-IF: PLAYER_CONTROL_LOST/GAINED — none for possessing another unit; the character's own refusal only", () => {
  const { seam, pump, fired, frame, mindControl, release, world } = fixture();
  seam.attach(pump);
  frame();
  mindControl();
  frame();
  // A fear on the possessed unit refuses it (Unit::SetFeared -> SetClientControl(unit, 0)): still no edge.
  world.controlledGuid = undefined;
  world.controlRefusedGuid = MOB;
  frame();
  world.controlledGuid = MOB;
  world.controlRefusedGuid = undefined;
  release();
  frame();
  assert.deepEqual(possessEvents(fired).filter((name) => name.startsWith("PLAYER_CONTROL")), []);
  // The character itself refused (an enemy's Mind Control, a fear): 0x0071c930 -> 0x00520fe0.
  world.controlledGuid = undefined;
  world.controlRefusedGuid = SELF;
  frame();
  world.controlledGuid = SELF;
  world.controlRefusedGuid = undefined;
  frame();
  assert.deepEqual(possessEvents(fired).filter((name) => name.startsWith("PLAYER_CONTROL")),
    ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"]);
  seam.detach();
});

test("11.02-IF: a fear on the possessed unit keeps its bar on the main bar — the far sight did not move", () => {
  const { seam, call, pump, frame, mindControl, world } = fixture();
  seam.attach(pump);
  mindControl();
  world.controlledGuid = undefined;
  world.controlRefusedGuid = MOB;
  frame();
  assert.deepEqual(call("GetBonusBarOffset"), [5]);
  assert.deepEqual(call("PetHasActionBar"), [], "not the stock pet bar, though petBarKind now says pet");
  call("UseAction", 122);
  assert.deepEqual(world.used, [[1, undefined]]);
  seam.detach();
});

test("11.02-IF: PLAYER_FARSIGHT_FOCUS_CHANGED on a far sight that is no possession (Far Sight's DynamicObject)", () => {
  const { seam, call, pump, fired, frame, world, player, fieldEdge } = fixture();
  seam.attach(pump);
  frame();
  fired.length = 0;
  world.state.objects.set(EYE, object(EYE, 6));
  world.auras.set(SELF, [{ slot: 0, spellId: FAR_SIGHT, flags: AFLAG_CASTER | AFLAG_POSITIVE, casterLevel: 80, applications: 0 }]);
  setGuid(player, FARSIGHT, EYE);
  fieldEdge("PLAYER_FARSIGHT");
  assert.deepEqual(possessEvents(fired), ["PET_BAR_UPDATE", "PLAYER_FARSIGHT_FOCUS_CHANGED"]);
  assert.deepEqual(call("GetBonusBarOffset"), [0]);
  assert.deepEqual(call("IsPossessBarVisible"), [false]);
  fired.length = 0;
  setGuid(player, FARSIGHT, 0n);
  frame();
  assert.deepEqual(possessEvents(fired), ["PET_BAR_UPDATE", "PLAYER_FARSIGHT_FOCUS_CHANGED"], "the poll catches a field without a store edge");
  seam.detach();
});

test("11.02-IF: UnitIsPossessed and UnitIsCharmed read UNIT_FLAG_POSSESSED and UNIT_FIELD_CHARMEDBY", () => {
  const { seam, call, pump, mindControl, frame } = fixture();
  seam.attach(pump);
  frame();
  assert.deepEqual(call("UnitIsPossessed", "pet"), [false]);
  assert.deepEqual(call("UnitIsCharmed", "player"), []);
  mindControl();
  frame();
  assert.deepEqual(call("UnitIsPossessed", "pet"), [true], "PetCastingBarFrame shows the possessed unit's casts");
  assert.deepEqual(call("UnitIsPossessed", "player"), [false]);
  assert.deepEqual(call("UnitIsCharmed", "pet"), [1]);
  assert.deepEqual(call("UnitIsCharmed", "player"), []);
  seam.detach();
});

test("11.02-IF: a creature without a pet bar, or the unit's late spell rows", () => {
  const first = fixture();
  first.world.creatureTemplates.get(MOB_ENTRY).flags = CREATURE_TYPE_FLAG_NO_PET_BAR;
  first.seam.attach(first.pump);
  first.mindControl();
  assert.deepEqual(first.call("GetBonusBarOffset"), [0], "CREATURE_TYPE_FLAG_NO_PET_BAR (0x007226b0)");
  assert.deepEqual(first.call("IsPossessBarVisible"), [true], "the possess buttons do not depend on it");
  first.seam.detach();

  const late = fixture();
  const row = SPELLS.get(MIND_CONTROL);
  SPELLS.delete(MIND_CONTROL);
  try {
    late.seam.attach(late.pump);
    late.mindControl();
    assert.deepEqual(late.call("IsPossessBarVisible"), [false], "the row is not cached yet");
    SPELLS.set(MIND_CONTROL, row);
    late.frame();
    assert.deepEqual(late.call("IsPossessBarVisible"), [true], "found once the row arrives");
    assert.deepEqual(late.call("GetBonusBarOffset"), [5]);
  } finally {
    SPELLS.set(MIND_CONTROL, row);
    late.seam.detach();
  }
});

test("11.02-IF: a held possess spell outlives a miss; a new bar forgets it was seen (0x005d62a0, 0x005d6900)", () => {
  const { seam, call, pump, frame, mindControl, release, world, player, fieldEdge } = fixture();
  seam.attach(pump);
  mindControl();
  // The character's summon moves (0x006d1970 looks again) while the aura is already gone: a miss keeps it.
  world.auras.delete(SELF);
  setGuid(player, F("UNIT_FIELD_SUMMON"), 0xf140_0000_0000_0042n);
  frame();
  assert.deepEqual(call("IsPossessBarVisible"), [true], "only a hit replaces the spell");
  release();
  frame();
  // Eye of Kilrogg: a puppet's bar and far sight with no possess aura found (the summon branch needs
  // SummonProperties, which no route serves). Its bar is a new unit's, so «seen» is clear: on the main bar.
  const eye = object(EYE, 3, [[ENTRY, MOB_ENTRY], [HEALTH, 50]]);
  world.state.objects.set(EYE, eye);
  world.petSpells = petSpells(EYE, [packPetAction(FIREBALL, ACT_PASSIVE), ...Array(9).fill(packPetAction(0, ACT_PASSIVE))]);
  world.events.emit("PET_BAR_CHANGED", { guid: EYE });
  setGuid(player, FARSIGHT, EYE);
  fieldEdge("PLAYER_FARSIGHT");
  assert.deepEqual(call("GetBonusBarOffset"), [5]);
  assert.deepEqual(call("IsPossessBarVisible"), [false], "no possess buttons without the spell");
  seam.detach();
});

test("11.02-IF: a vehicle's control aura is no possess bar; a vehicle's bar stays off the main bar (F2)", () => {
  const { seam, call, pump, world, player, mob, fieldEdge } = fixture();
  SPELLS.set(46598, { id: 46598, name: "Езда на транспорте", rank: "", iconPath: "Interface\\Icons\\Ability_Vehicle", effectAura: [236, 0, 0], passive: false });
  try {
    seam.attach(pump);
    world.controlledGuid = MOB;
    world.petSpells = petSpells(MOB, [packPetAction(62345, 8), ...Array(9).fill(0)]);
    world.events.emit("PET_BAR_CHANGED", { guid: MOB });
    world.auras.set(SELF, [{ slot: 0, spellId: 46598, flags: AFLAG_POSITIVE, casterLevel: 80, applications: 0 }]);
    mob.fields.set(FLAGS, POSSESSED);
    player.transport = { guid: MOB, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
    setGuid(player, CHARM, MOB);
    setGuid(player, FARSIGHT, MOB);
    fieldEdge("PLAYER_FARSIGHT");
    assert.deepEqual(call("IsPossessBarVisible"), [false], "0x005a8820: a CONTROL_VEHICLE spell");
    assert.deepEqual(call("GetPossessInfo", 1), ["Interface\\Icons\\Ability_Vehicle", "Езда на транспорте", true],
      "GetPossessInfo still answers it (PossessButton_OnClick's VehicleExit branch)");
    assert.deepEqual(call("GetBonusBarOffset"), [0], "a vehicle's bar: slice F2 (VehicleSeat.VehicleAbilityDisplay)");
  } finally {
    SPELLS.delete(46598);
    seam.detach();
  }
});

test("11.02-IF: a macro's [bonusbar:5] and [actionbar:1] hold under possession", () => {
  const { seam, pump, mindControl, release, frame } = fixture();
  seam.attach(pump);
  frame();
  assert.equal(seam.macroContext().bonusBar(), 0);
  mindControl();
  frame();
  assert.equal(seam.macroContext().bonusBar(), 5);
  assert.equal(seam.macroContext().actionBar(), 1);
  release();
  frame();
  assert.equal(seam.macroContext().bonusBar(), 0, "the form memo did not keep the 5");
  seam.detach();
});

// ---- 11.02-IF-review: the rules the first set did not pin -----------------------------------------

const MC_AURA = Object.freeze({ slot: 0, spellId: MIND_CONTROL, flags: AFLAG_CASTER | AFLAG_POSITIVE, casterLevel: 80, applications: 0 });

test("11.02-IF-review: a charm aura counts; the summon stands in for an empty charm; a hunter's pet has a pet number", () => {
  const CHARM_SPELL = 90001;
  const row = (id) => (id === CHARM_SPELL ? { effectAura: [6, 4, 0] } : undefined);
  assert.deepEqual(possessSpellOf([{ slot: 0, spellId: CHARM_SPELL, flags: AFLAG_POSITIVE, casterLevel: 80, applications: 0 }], row, false),
    { spellId: CHARM_SPELL, pending: false }, "SPELL_AURA_MOD_CHARM 6 (0x005d62a0's third aura type)");
  const player = object(SELF, 4);
  setGuid(player, F("UNIT_FIELD_SUMMON"), MOB);
  player.transport = { guid: MOB, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
  assert.equal(drivesCharm(player), true, "CHARM empty: the summon is the one compared");
  setGuid(player, CHARM, OTHER_MOB);
  assert.equal(drivesCharm(player), false, "a charm present hides the summon");
  const hunter = object(0x20n, 4, [[BYTES_0, 3 << 8]]);
  const guardian = object(0xf130_0000_0000_0001n, 3);
  setGuid(guardian, CREATED_BY, 0x20n);
  assert.equal(isHunterPet(guardian, (guid) => (guid === 0x20n ? hunter : undefined)), false,
    "0x0071b630: no UNIT_FIELD_PETNUMBER, no hunter's pet");
});

test("11.02-IF-review: the far sight before the aura — a CHARM or SUMMON change looks again (0x006d1970)", () => {
  const { seam, call, pump, fired, frame, world, player, fieldEdge } = fixture();
  setGuid(player, F("UNIT_FIELD_SUMMON"), 0xf140_0000_0000_0042n);
  seam.attach(pump);
  frame();
  world.controlledGuid = MOB;
  world.petSpells = petSpells(MOB);
  world.events.emit("PET_BAR_CHANGED", { guid: MOB });
  setGuid(player, FARSIGHT, MOB);
  fieldEdge("PLAYER_FARSIGHT");
  assert.deepEqual(call("IsPossessBarVisible"), [false], "no possess aura yet");
  assert.deepEqual(call("GetBonusBarOffset"), [5], "the bar is on the main bar all the same: 0x005d4ad0 needs no spell");
  fired.length = 0;
  world.auras.set(SELF, [MC_AURA]);
  frame();
  assert.deepEqual(call("IsPossessBarVisible"), [false], "an aura alone is no look: nothing 0x005d62a0 waits on moved");
  setGuid(player, F("UNIT_FIELD_SUMMON"), 0xf140_0000_0000_0043n);
  frame();
  assert.deepEqual(call("IsPossessBarVisible"), [true], "the summon's low word moved: Mind Control is found");
  assert.deepEqual(possessEvents(fired), ["UPDATE_BONUS_ACTIONBAR"], "the spell's edge only: no slot writes, no far sight edge");
  seam.detach();
});

test("11.02-IF-review: a far sight whose object is out of view — no possess spell, the bar still on the main bar (0x006e4fd0, 0x005d35b0)", () => {
  const { seam, call, pump, world, player, fieldEdge } = fixture();
  seam.attach(pump);
  world.state.objects.delete(MOB);
  world.controlledGuid = MOB;
  world.petSpells = petSpells(MOB);
  world.events.emit("PET_BAR_CHANGED", { guid: MOB });
  world.auras.set(SELF, [MC_AURA]);
  setGuid(player, FARSIGHT, MOB);
  fieldEdge("PLAYER_FARSIGHT");
  assert.deepEqual(call("IsPossessBarVisible"), [false], "0x005d30e0(0): the field names nothing in view");
  assert.deepEqual(call("GetBonusBarOffset"), [5], "0x005d35b0: a unit out of view may carry the bar");
  assert.deepEqual(call("HasAction", 122), [true]);
  seam.detach();
});

test("11.02-IF-review: a press on the page raises ACTIONBAR_UPDATE_STATE once (0x005abbc0 -> 0x005a7cb0); 131 is no press", () => {
  const { seam, call, pump, fired, frame, mindControl } = fixture();
  seam.attach(pump);
  mindControl();
  frame();
  fired.length = 0;
  call("UseAction", 122);
  call("UseAction", 131);
  assert.deepEqual(possessEvents(fired), ["ACTIONBAR_UPDATE_STATE"]);
  seam.detach();
});

test("11.02-IF-review: a UI reload under possession reads the client's state and announces nothing", () => {
  const { seam, call, pump, fired, mindControl } = fixture();
  mindControl();
  seam.attach(pump);
  const possessEdges = possessEvents(fired).filter((name) => /^(UPDATE_BONUS_ACTIONBAR|PLAYER_FARSIGHT_FOCUS_CHANGED|ACTIONBAR_PAGE_CHANGED)$/.test(name)
    || /^ACTIONBAR_SLOT_CHANGED:1(2[1-9]|3[0-2])$/.test(name));
  assert.deepEqual(possessEdges, [], "no possess edge at attach (the seam's own slot-0 refresh aside)");
  assert.deepEqual(call("GetBonusBarOffset"), [5]);
  assert.deepEqual(call("IsPossessBarVisible"), [true]);
  assert.deepEqual(call("HasAction", 122), [true]);
  seam.detach();
});

test("11.02-IF-review: detach lets go of the pet bar packet's event", () => {
  const { seam, pump, world } = fixture();
  const before = world.events.count("PET_BAR_CHANGED");
  seam.attach(pump);
  assert.ok(world.events.count("PET_BAR_CHANGED") > before);
  seam.detach();
  assert.equal(world.events.count("PET_BAR_CHANGED"), before, "every listener the attach added is gone");
});

test("11.02-IF-review: GetActionInfo gives the spell's place in the pet book plus one (0x005a8f10 -> 0x0053b4e0)", () => {
  const { seam, call, pump, frame, mindControl, world } = fixture();
  seam.attach(pump);
  mindControl();
  frame();
  world.petSpells.spells = [{ spellId: FROST_NOVA, state: 0xc1 }, { spellId: FIREBALL, state: 0xc1 }];
  assert.deepEqual(call("GetActionInfo", 122), ["spell", 2, "pet", FIREBALL]);
  seam.detach();
});

test("11.02-IF-review: the page is never lifted from or dropped on (0x005abe70, 0x005abbc0)", () => {
  const { seam, call, pump, frame, mindControl, world } = fixture();
  seam.attach(pump);
  mindControl();
  frame();
  call("PickupAction", 121);
  assert.deepEqual(call("GetCursorInfo"), [], "nothing lifted from slot 121 (the character's own Smite is there)");
  assert.deepEqual(world.writes, []);
  call("PickupAction", 1);
  assert.deepEqual(world.writes, [[0, 0, 0]], "slot 1 is the character's as ever");
  const held = call("GetCursorInfo");
  call("PlaceAction", 121);
  assert.deepEqual(world.writes, [[0, 0, 0]], "the held action is not dropped on the page");
  assert.deepEqual(call("GetCursorInfo"), held, "and stays held");
  seam.detach();
});

test("11.02-IF-review: a possess spell seen and gone keeps a bar off the main bar unless it is a hunter's pet's (0x005d35b0)", () => {
  const PET = 0xf140_0000_0000_0051n;
  const EYES_OF_THE_BEAST = 1002;
  SPELLS.set(EYES_OF_THE_BEAST, { id: EYES_OF_THE_BEAST, name: "Звериный глаз", rank: "", iconPath: "", effectAura: [128, 4, 79], passive: false });
  try {
    for (const [creatorClass, expected] of [[3, [5]], [9, [0]]]) {
      const { seam, call, pump, world, player, fieldEdge } = fixture();
      player.fields.set(BYTES_0, creatorClass << 8);
      const pet = object(PET, 3, [[ENTRY, MOB_ENTRY], [HEALTH, 300], [PET_NUMBER, 7]]);
      setGuid(pet, CREATED_BY, SELF);
      world.state.objects.set(PET, pet);
      seam.attach(pump);
      world.petSpells = petSpells(PET);
      world.events.emit("PET_BAR_CHANGED", { guid: PET });
      world.auras.set(SELF, [{ slot: 0, spellId: EYES_OF_THE_BEAST, flags: AFLAG_CASTER | AFLAG_POSITIVE, casterLevel: 80, applications: 0 }]);
      setGuid(player, FARSIGHT, PET);
      fieldEdge("PLAYER_FARSIGHT");
      assert.deepEqual(call("GetBonusBarOffset"), [5], `class ${creatorClass}: the pet's bar on the main bar`);
      // It ends: the aura goes and the far sight comes home; the bar stays the same unit's.
      world.auras.delete(SELF);
      setGuid(player, FARSIGHT, 0n);
      fieldEdge("PLAYER_FARSIGHT");
      assert.deepEqual(call("GetBonusBarOffset"), [0]);
      // The far sight names the pet again and no possess aura is found: «seen and gone».
      setGuid(player, FARSIGHT, PET);
      fieldEdge("PLAYER_FARSIGHT");
      assert.deepEqual(call("GetBonusBarOffset"), expected, creatorClass === 3 ? "a hunter's pet keeps it (0x0071b630)" : "anyone else's does not");
      seam.detach();
    }
  } finally {
    SPELLS.delete(EYES_OF_THE_BEAST);
  }
});

test("11.02-IF-review: the page's cooldown and usability are the unit's, not the character's slot 121", () => {
  const { seam, call, pump, frame, mindControl, world } = fixture();
  world.cooldownState = (id) => (id === 585 ? { startedAt: 0, duration: 8_000 } : undefined);
  seam.attach(pump);
  frame();
  assert.notDeepEqual(call("GetActionCooldown", 121), [0, 0, 0], "the character's Smite is cooling down");
  mindControl();
  frame();
  assert.deepEqual(call("GetActionCooldown", 121), [0, 0, 0], "the attack command has none");
  assert.deepEqual(call("IsUsableAction", 121), [true, false]);
  seam.detach();
});

test("P1-16 review: the possess page hears ACTIONBAR_UPDATE_COOLDOWN/_USABLE for the pet bar's timers and usability", () => {
  const { seam, call, pump, frame, mindControl, release, world, mob, fired } = fixture();
  const CD = "ACTIONBAR_UPDATE_COOLDOWN";
  const US = "ACTIONBAR_UPDATE_USABLE";
  const count = (name) => fired.filter(([event]) => event === name).length;
  seam.attach(pump);
  // No possession: a pet timer is the pet bar's alone (PET_BAR_UPDATE_COOLDOWN), not the action bar's.
  frame();
  fired.length = 0;
  world.petCooldowns.set(FIREBALL, pump.now() * 1000 + 3_000);
  world.events.emit("PET_COOLDOWNS_CHANGED", {});
  frame();
  assert.equal(count(CD) + count(US), 0, "no mirrored page, no action-bar event");
  world.petCooldowns.clear();
  world.events.emit("PET_COOLDOWNS_CHANGED", {});
  mindControl();
  frame();
  frame();
  fired.length = 0;
  // SMSG_SPELL_COOLDOWN for the possessed unit's Fireball (slot 122).
  world.petCooldowns.set(FIREBALL, pump.now() * 1000 + 8_000);
  world.events.emit("PET_COOLDOWNS_CHANGED", {});
  assert.equal(count(CD), 1, "the sweep starts");
  assert.equal(count(US), 1);
  const [, duration, enable] = call("GetActionCooldown", 122);
  assert.deepEqual([duration, enable], [8, 1]);
  fired.length = 0;
  for (let index = 0; index < 20; index++) frame();
  assert.equal(count(CD) + count(US), 0, "two seconds of countdown are reads");
  for (let index = 0; index < 70; index++) frame();
  assert.deepEqual(call("GetActionCooldown", 122), [0, 0, 0]);
  assert.equal(count(CD), 1, "the timer's end redraws the sweep");
  assert.equal(count(US), 1);
  fired.length = 0;
  // The possessed unit dies: its spells grey out (the pet bar's usable signature), no timer moved.
  mob.fields.set(HEALTH, 0);
  frame();
  assert.deepEqual(call("IsUsableAction", 122), [false, false]);
  assert.equal(count(US), 1, "USABLE for the greying");
  assert.equal(count(CD), 0, "no COOLDOWN without a timer change");
  fired.length = 0;
  frame();
  assert.equal(count(CD) + count(US), 0);
  release();
  frame();
  seam.detach();
});
