import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-pet-action-bar.test.mjs
{
// The stock pet bar's C API over the pet packet: the token/spell answers of GetPetActionInfo
// (FrameXmlPetActionBar.ts), WorldClient keeping the command/react/autocast state the realm never
// echoes and the pet's swing, the live model over a fake world (FrameXmlPetActionBarLive.ts), and
// the cursor's pet-bar swap and grid events (FrameXmlCursor.ts).
const {
  FRAMEXML_PET_ACTION_BINDINGS, FRAMEXML_PET_ACTION_EVENTS, frameXmlPetActionInfo, frameXmlWithPetBook,
} = await import("../dist/code/browser/framexml/FrameXmlPetActionBar.js");
const { FrameXmlPetActionBarLive } = await import("../dist/code/browser/framexml/FrameXmlPetActionBarLive.js");
const { FrameXmlCursorModel } = await import("../dist/code/browser/framexml/FrameXmlCursor.js");
const {
  ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_PASSIVE, ACT_REACTION,
  COMMAND_ABANDON, COMMAND_ATTACK, COMMAND_FOLLOW, COMMAND_STAY,
  REACT_AGGRESSIVE, REACT_DEFENSIVE, REACT_PASSIVE, packPetAction, petBarKind,
} = await import("../dist/code/world/PetProtocol.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const BITE = 17253;
const GROWL = 2649;
const HOWL = 24604;
const SPELLS = new Map([
  [BITE, { id: BITE, name: "Укус", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Druid_FerociousBite",
    powerType: 2, powerCost: 25, powerCostPercent: 0, schoolMask: 1, passive: false }],
  [GROWL, { id: GROWL, name: "Рык", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Physical_Taunt",
    powerType: 2, powerCost: 15, powerCostPercent: 0, schoolMask: 1, passive: false }],
]);

/** `CharmInfo::InitPetActionBar` with bite and growl on autocast, the howl off and one empty slot. */
const DEFAULT_BAR = [
  packPetAction(COMMAND_ATTACK, ACT_COMMAND),
  packPetAction(COMMAND_FOLLOW, ACT_COMMAND),
  packPetAction(COMMAND_STAY, ACT_COMMAND),
  packPetAction(BITE, ACT_ENABLED),
  packPetAction(GROWL, ACT_ENABLED),
  packPetAction(HOWL, ACT_DISABLED),
  packPetAction(0, ACT_PASSIVE),
  packPetAction(REACT_AGGRESSIVE, ACT_REACTION),
  packPetAction(REACT_DEFENSIVE, ACT_REACTION),
  packPetAction(REACT_PASSIVE, ACT_REACTION),
];

test("GetPetActionInfo answers commands and reactions as the tokens PetActionBar_Update resolves through _G", () => {
  const state = { commandState: COMMAND_FOLLOW, reactState: REACT_DEFENSIVE, attacking: false };
  const spell = (id) => SPELLS.get(id);
  const info = DEFAULT_BAR.map((word) => frameXmlPetActionInfo(word, state, spell));
  assert.deepEqual(info[0], ["PET_ACTION_ATTACK", undefined, "PET_ATTACK_TEXTURE", true, false, false, false]);
  assert.deepEqual(info[1], ["PET_ACTION_FOLLOW", undefined, "PET_FOLLOW_TEXTURE", true, true, false, false],
    "follow is the command state: checked");
  assert.deepEqual(info[2], ["PET_ACTION_WAIT", undefined, "PET_WAIT_TEXTURE", true, false, false, false]);
  assert.deepEqual(info[3], ["Укус", "Уровень 1", "Interface\\Icons\\Ability_Druid_FerociousBite", false, false, true, true],
    "ACT_ENABLED: autocast allowed and on");
  assert.equal(info[5], undefined, "a spell whose row is not cached answers nothing, not a made-up name");
  assert.equal(info[6], undefined, "(0, ACT_PASSIVE) is the empty spell slot");
  assert.deepEqual(info[7], ["PET_MODE_AGGRESSIVE", undefined, "PET_AGGRESSIVE_TEXTURE", true, false, false, false]);
  assert.deepEqual(info[8], ["PET_MODE_DEFENSIVE", undefined, "PET_DEFENSIVE_TEXTURE", true, true, false, false]);
  assert.deepEqual(info[9], ["PET_MODE_PASSIVE", undefined, "PET_PASSIVE_TEXTURE", true, false, false, false]);
  const howl = frameXmlPetActionInfo(packPetAction(HOWL, ACT_DISABLED), state,
    () => ({ name: "Неистовый вой", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Hunter_Pet_Wolf" }));
  assert.deepEqual(howl.slice(5), [true, false], "ACT_DISABLED: allowed, off");
  const cower = frameXmlPetActionInfo(packPetAction(1742, ACT_PASSIVE), state, () => ({ name: "Попятиться", rank: "" }));
  assert.deepEqual(cower, ["Попятиться", undefined, undefined, false, false, false, false],
    "ACT_PASSIVE: castable, never autocast; an empty rank is nil");
  const attacking = frameXmlPetActionInfo(DEFAULT_BAR[0], { ...state, attacking: true }, spell);
  assert.equal(attacking[4], true, "attack is active while the pet swings");
  assert.equal(frameXmlPetActionInfo(packPetAction(9, ACT_COMMAND), state, spell), undefined, "an unknown command code");
});

test("petBarKind: a pet's bar, a vehicle's slot-index bar, and a possessed unit's", () => {
  const self = 0x10n;
  const pet = 0xf140000000000104n;
  const bar = DEFAULT_BAR.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 }));
  assert.equal(petBarKind({ guid: pet, closed: false, bar }, self, self), "pet");
  assert.equal(petBarKind({ guid: pet, closed: false, bar }, undefined, self), "pet");
  assert.equal(petBarKind({ guid: pet, closed: false, bar }, pet, self), "possess");
  const vehicle = [{ slot: 0, packed: packPetAction(62345, 8), action: 62345, type: 8 }];
  assert.equal(petBarKind({ guid: pet, closed: false, bar: vehicle }, pet, self), "vehicle");
  assert.equal(petBarKind({ guid: 0n, closed: true, bar: [] }, self, self), undefined);
  assert.equal(petBarKind(undefined, self, self), undefined);
});

// ---- WorldClient: what the realm never echoes ---------------------------------------------------

function petSpellsPacket(guid, { react = REACT_DEFENSIVE, command = COMMAND_FOLLOW, bar = DEFAULT_BAR, spells = [] } = {}) {
  const writer = new PacketWriter().u64(guid).u16(0).u32(0).u8(react).u8(command).u16(0);
  for (const word of bar) writer.u32(word);
  writer.u8(spells.length);
  for (const word of spells) writer.u32(word);
  writer.u8(0);
  return writer.toUint8Array();
}

async function loggedInClient() {
  let wake;
  const connection = {
    sent: [],
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array() }],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    enqueue(packet) {
      if (wake) {
        const resolve = wake;
        wake = undefined;
        resolve(packet);
      } else this.packets.push(packet);
    },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(0x10n);
  client.state.selfGuid = 0x10n;
  return { client, connection };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("WorldClient keeps the pressed command, reaction and autocast, since HandlePetActionHelper answers none", async () => {
  const pet = 0xf140000000000104n;
  const { client, connection } = await loggedInClient();
  const changes = [];
  client.events.on("PET_BAR_CHANGED", (event) => changes.push(event.guid));
  connection.enqueue({
    opcode: OPCODES.SMSG_PET_SPELLS,
    payload: petSpellsPacket(pet, { spells: [packPetAction(BITE, ACT_ENABLED), packPetAction(HOWL, ACT_DISABLED)] }),
  });
  await settle();
  assert.equal(client.petSpells?.commandState, COMMAND_FOLLOW);
  changes.length = 0;

  client.usePetSlot(2);
  const stay = connection.sent.at(-1);
  assert.equal(stay.opcode, OPCODES.CMSG_PET_ACTION);
  const reader = new PacketReader(stay.payload);
  assert.equal(reader.u64(), pet);
  assert.equal(reader.u32(), packPetAction(COMMAND_STAY, ACT_COMMAND), "the slot's own word goes out");
  assert.equal(client.petSpells.commandState, COMMAND_STAY, "stay is now the held command state");
  assert.deepEqual(changes, [pet], "one PET_BAR_CHANGED for the new state");

  client.usePetSlot(2);
  assert.deepEqual(changes, [pet], "pressing the command already in force changes nothing");

  client.setPetReaction(REACT_PASSIVE);
  assert.equal(client.petSpells.reactState, REACT_PASSIVE);
  client.commandPet(COMMAND_ATTACK);
  assert.equal(client.petSpells.commandState, COMMAND_STAY, "attack sets no command state in the core");
  assert.equal(changes.length, 2);

  client.togglePetAutocast(BITE, false);
  const toggle = connection.sent.at(-1);
  assert.equal(toggle.opcode, OPCODES.CMSG_PET_SPELL_AUTOCAST);
  assert.equal(toggle.payload.at(-1), 0, "the off byte");
  assert.equal(client.petSpells.bar[3].type, ACT_DISABLED, "SetSpellAutocast's first matching slot flips");
  assert.equal(client.petSpells.bar[3].packed, packPetAction(BITE, ACT_DISABLED));
  assert.equal(client.petSpells.spells.find((entry) => entry.spellId === BITE)?.active, ACT_DISABLED,
    "and the pet's own book entry, as Pet::ToggleAutocast");
  assert.equal(changes.length, 3);

  // A fresh bar is the realm's word again.
  connection.enqueue({ opcode: OPCODES.SMSG_PET_SPELLS, payload: petSpellsPacket(pet) });
  await settle();
  assert.equal(client.petSpells.commandState, COMMAND_FOLLOW);
  assert.equal(client.petSpells.reactState, REACT_DEFENSIVE);
  client.close();
});

test("WorldClient follows the pet's swing from SMSG_ATTACK_START to its stop or a new bar", async () => {
  const pet = 0xf140000000000104n;
  const victim = 0xf130000000000999n;
  const { client, connection } = await loggedInClient();
  const swings = [];
  client.events.on("PET_ATTACK_CHANGED", (event) => swings.push(event.victim));
  const start = (attacker) => connection.enqueue({
    opcode: OPCODES.SMSG_ATTACK_START, payload: new PacketWriter().u64(attacker).u64(victim).toUint8Array(),
  });
  start(pet);
  await settle();
  assert.equal(client.petAttackVictim, undefined, "no pet bar: nobody's pet");
  connection.enqueue({ opcode: OPCODES.SMSG_PET_SPELLS, payload: petSpellsPacket(pet) });
  start(pet);
  await settle();
  assert.equal(client.petAttackVictim, victim);
  start(0x77n);
  await settle();
  assert.deepEqual(swings, [victim], "another unit's swing is not the pet's");
  connection.enqueue({
    opcode: OPCODES.SMSG_ATTACK_STOP, payload: new PacketWriter().packedGuid(pet).packedGuid(victim).u32(0).toUint8Array(),
  });
  await settle();
  assert.equal(client.petAttackVictim, undefined);
  start(pet);
  connection.enqueue({ opcode: OPCODES.SMSG_PET_SPELLS, payload: new PacketWriter().u64(0n).toUint8Array() });
  await settle();
  assert.equal(client.petAttackVictim, undefined, "the bar taken down takes the swing along");
  assert.deepEqual(swings, [victim, undefined, victim, undefined]);
  client.close();
});

// ---- the live model over a fake world ------------------------------------------------------------

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    this.#listeners.set(name, set);
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
  count() {
    let total = 0;
    for (const set of this.#listeners.values()) total += set.size;
    return total;
  }
}

const POWER2 = UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 2;
const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;

function liveFixture({ hunter = true, controlled } = {}) {
  const selfGuid = 0x10n;
  const petGuid = 0xf140000000000104n;
  const focusGuid = 0xf130000000000555n;
  const events = new FakeEvents();
  const pet = {
    guid: petGuid, typeId: 3,
    fields: new Map([[HEALTH, 1000], [POWER2, 100], [BYTES_2, hunter ? 0x02 << 16 : 0]]),
  };
  const calls = [];
  const world = {
    events,
    state: { selfGuid, objects: new Map([[petGuid, pet]]) },
    controlledGuid: controlled ?? selfGuid,
    petSpells: {
      guid: petGuid, closed: false, creatureFamily: 1, duration: 0,
      reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW, flags: 0,
      bar: DEFAULT_BAR.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
      spells: [], cooldowns: [],
    },
    petCooldowns: new Map(),
    petAttackVictim: undefined,
    usePetSlot: (slot, target) => calls.push(["use", slot, target]),
    commandPet: (command, target) => calls.push(["command", command, target]),
    setPetReaction: (react) => calls.push(["react", react]),
    togglePetAutocast: (spellId, enabled) => calls.push(["autocast", spellId, enabled]),
    swapPetActionSlots: (first, second) => calls.push(["swap", first, second]),
    stopPetAttack: () => calls.push(["stop"]),
  };
  let monotonic = 50_000;
  let pumpNow = 300;
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => pumpNow };
  const prefetched = [];
  const spells = new Map(SPELLS);
  const model = new FrameXmlPetActionBarLive({
    world: () => world,
    monotonic: () => monotonic,
    spell: (id) => spells.get(id),
    unitGuid: (unit) => (unit === "focus" ? focusGuid : undefined),
    prefetchSpells: (ids, onLoaded) => prefetched.push({ ids: [...ids], onLoaded }),
  });
  return {
    model, world, pet, calls, fired, pump, prefetched, spells, focusGuid, petGuid,
    advance(ms) { monotonic += ms; pumpNow += ms / 1000; },
    get monotonic() { return monotonic; },
  };
}

test("the live model answers the bar, and only a pet's bar", () => {
  const fixture = liveFixture();
  const { model, world, pump } = fixture;
  model.attach(pump);
  const seam = { petActions: model };
  const call = (name, ...args) => FRAMEXML_PET_ACTION_BINDINGS[name](seam, args);
  assert.deepEqual(call("PetHasActionBar"), [true]);
  assert.deepEqual(call("GetPetActionInfo", 2), ["PET_ACTION_FOLLOW", undefined, "PET_FOLLOW_TEXTURE", true, true, false, false]);
  assert.deepEqual(call("GetPetActionInfo", 4).slice(0, 3), ["Укус", "Уровень 1", "Interface\\Icons\\Ability_Druid_FerociousBite"]);
  assert.deepEqual(call("GetPetActionInfo", 7), [], "the empty slot answers nothing");
  assert.deepEqual(call("GetPetActionInfo", 11), []);
  assert.deepEqual(call("IsPetAttackAction", 1), [true]);
  assert.deepEqual(call("IsPetAttackAction", 2), [false]);
  assert.equal(fixture.prefetched.length, 1, "the howl's row is fetched outside a C-API read");
  assert.deepEqual(fixture.prefetched[0].ids, [HOWL]);
  fixture.spells.set(HOWL, { id: HOWL, name: "Неистовый вой", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Hunter_Pet_Wolf" });
  fixture.prefetched[0].onLoaded();
  assert.deepEqual(fixture.fired.at(-1), [FRAMEXML_PET_ACTION_EVENTS.update], "its arrival repaints the bar");
  assert.equal(call("GetPetActionInfo", 6)[0], "Неистовый вой");

  world.controlledGuid = world.petSpells.guid;
  assert.deepEqual(call("PetHasActionBar"), [false], "a possessed unit's bar is the possess layout's");
  fixture.fired.length = 0;
  model.tick();
  assert.deepEqual(fixture.fired, [[FRAMEXML_PET_ACTION_EVENTS.update]], "the kind change is announced on the poll");
  world.controlledGuid = world.state.selfGuid;
  world.petSpells.bar[3] = { slot: 3, packed: packPetAction(62345, 8), action: 62345, type: 8 };
  assert.deepEqual(call("PetHasActionBar"), [false], "a vehicle's slot-index bar is not this bar");
  model.detach();
  assert.equal(world.events.count(), 0, "detach drops every subscription");
});

test("presses reach the realm as the slot's word; a hunter's pet is never abandoned from the bar", () => {
  const fixture = liveFixture();
  const { model, world, calls, pump, focusGuid } = fixture;
  model.attach(pump);
  model.castAction(3);
  model.castAction(1, "focus");
  model.castAction(7);
  assert.deepEqual(calls, [["use", 2, undefined], ["use", 0, focusGuid]], "stay, then attack at the focus; the empty slot sends nothing");
  calls.length = 0;
  model.toggleAutocast(4);
  model.toggleAutocast(6);
  model.toggleAutocast(2);
  assert.deepEqual(calls, [["autocast", BITE, false], ["autocast", HOWL, true]], "a command has no autocast");
  calls.length = 0;
  model.moveAction(4, 6);
  model.moveAction(4, 4);
  assert.deepEqual(calls, [["swap", 3, 5]]);
  calls.length = 0;
  model.command("attack", "focus");
  model.command("wait");
  model.command("follow");
  model.command("passive");
  model.command("aggressive");
  model.command("stopattack");
  model.command("dismiss");
  assert.deepEqual(calls, [
    ["command", COMMAND_ATTACK, focusGuid], ["command", COMMAND_STAY, undefined], ["command", COMMAND_FOLLOW, undefined],
    ["react", REACT_PASSIVE], ["react", REACT_AGGRESSIVE], ["stop"],
  ], "a hunter's pet is not dismissed (COMMAND_ABANDON would delete it)");
  assert.equal(model.canBeDismissed(), false);
  calls.length = 0;
  world.petSpells.bar[2] = { slot: 2, packed: packPetAction(COMMAND_ABANDON, ACT_COMMAND), action: COMMAND_ABANDON, type: ACT_COMMAND };
  model.castAction(3);
  assert.deepEqual(calls, [], "COMMAND_ABANDON on a hunter's pet stays in the client");

  const demon = liveFixture({ hunter: false });
  demon.model.attach(demon.pump);
  assert.equal(demon.model.canBeDismissed(), true, "a summoned pet is dismissed");
  demon.model.command("dismiss");
  assert.deepEqual(demon.calls, [["command", COMMAND_ABANDON, undefined]]);
});

test("cooldowns sweep from the stamp their end arrived at; usability follows the pet's power and life", () => {
  const fixture = liveFixture();
  const { model, world, pet, pump } = fixture;
  model.attach(pump);
  assert.deepEqual(model.cooldown(5), [0, 0, 0], "idle");
  world.petCooldowns.set(GROWL, fixture.monotonic + 5000);
  fixture.fired.length = 0;
  world.events.emit("PET_COOLDOWNS_CHANGED", {});
  assert.deepEqual(fixture.fired, [[FRAMEXML_PET_ACTION_EVENTS.cooldown], [FRAMEXML_PET_ACTION_EVENTS.spellCooldown]],
    "the bar's own edge, and SPELL_UPDATE_COOLDOWN for the pet book's buttons");
  assert.deepEqual(model.cooldown(5), [300, 5, 1]);
  fixture.advance(2000);
  assert.deepEqual(model.cooldown(5), [300, 5, 1], "the start stays where the timer began");
  world.events.emit("PET_COOLDOWNS_CHANGED", {});
  assert.deepEqual(model.cooldown(5), [300, 5, 1], "an unchanged end is not re-stamped");
  fixture.advance(3001);
  assert.deepEqual(model.cooldown(5), [0, 0, 0], "run out");
  assert.deepEqual(model.cooldown(2), [0, 0, 0], "a command never has one");

  assert.equal(model.slotUsable(4), true, "100 focus against bite's 25");
  pet.fields.set(POWER2, 20);
  assert.equal(model.slotUsable(4), false, "20 focus cannot pay 25");
  assert.equal(model.slotUsable(5), true, "…but can pay growl's 15");
  assert.equal(model.slotUsable(1), true, "a command is always pressable");
  fixture.fired.length = 0;
  model.tick();
  assert.deepEqual(fixture.fired, [[FRAMEXML_PET_ACTION_EVENTS.usable]], "PET_BAR_UPDATE_USABLE on the poll");
  model.tick();
  assert.equal(fixture.fired.length, 1, "no edge without a change");
  pet.fields.set(HEALTH, 0);
  assert.equal(model.slotUsable(5), false, "a dead pet casts nothing");

  world.petAttackVictim = 0x99n;
  fixture.fired.length = 0;
  world.events.emit("PET_ATTACK_CHANGED", { victim: 0x99n });
  assert.deepEqual(fixture.fired, [[FRAMEXML_PET_ACTION_EVENTS.update]]);
  assert.equal(model.actionInfo(1)?.[4], true, "the attack button flashes while the pet swings");
});

test("the cursor swaps two pet slots and raises the pet grid only while a pet action is held", async () => {
  const moves = [];
  const host = {
    cursorInfo: () => [], cursorHasItem: () => false, clearCursor: () => {}, spellIsPassive: () => false,
    itemInfo: () => undefined, actionButton: () => undefined, setActionButton: () => {},
    spellBookSpellId: () => undefined, spellInfo: () => undefined, spellTexture: () => undefined,
    petActions: { moveAction: (from, to) => moves.push([from, to]) },
  };
  const cursor = new FrameXmlCursorModel(host);
  const fired = [];
  cursor.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 0 });
  cursor.pickupPetAction(4);
  await Promise.resolve();
  assert.deepEqual(cursor.held(), { kind: "petaction", index: 4 });
  assert.ok(fired.includes(FRAMEXML_PET_ACTION_EVENTS.showGrid), `PET_BAR_SHOWGRID in ${JSON.stringify(fired)}`);
  assert.ok(!fired.includes("ACTIONBAR_SHOWGRID"), "the main bars keep their grid down");
  cursor.pickupPetAction(6);
  await Promise.resolve();
  assert.deepEqual(moves, [[4, 6]], "a drop on another slot swaps the two");
  assert.equal(cursor.held(), undefined);
  assert.ok(fired.includes(FRAMEXML_PET_ACTION_EVENTS.hideGrid));
  cursor.pickupPetAction(2);
  cursor.pickupPetAction(2);
  assert.deepEqual(moves, [[4, 6]], "a drop back on its own slot only lets go");
});

// ---- the pet's spellbook -------------------------------------------------------------------------

const COWER = 1742;
const COBRA_REFLEXES = 61682;
const BOOK_ROWS = new Map([
  ...SPELLS,
  [HOWL, { id: HOWL, name: "Неистовый вой", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Hunter_Pet_Wolf", passive: false }],
  [COBRA_REFLEXES, { id: COBRA_REFLEXES, name: "Рефлексы кобры", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Nature_GuardianWard", passive: true }],
]);

function bookFixture({ creatureType } = {}) {
  const fixture = liveFixture();
  const { world, spells, calls } = fixture;
  for (const [id, row] of BOOK_ROWS) spells.set(id, row);
  world.petSpells.spells = [
    { spellId: BITE, active: ACT_ENABLED }, { spellId: HOWL, active: ACT_DISABLED },
    { spellId: COBRA_REFLEXES, active: ACT_PASSIVE }, { spellId: COWER, active: ACT_PASSIVE },
  ];
  const pet = world.state.objects.get(world.petSpells.guid);
  pet.fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 1234);
  world.creatureTemplates = new Map(creatureType === undefined ? [] : [[1234, { entry: 1234, creatureType }]]);
  world.castPetSpell = (spellId, state, target) => calls.push(["cast", spellId, state, target]);
  world.setPetActionSlot = (slot, packed) => calls.push(["set", slot, packed]);
  return fixture;
}

test("the live pet book: SMSG_PET_SPELLS' spell list in order, its tab token, casts, autocast and a drop on the bar", () => {
  const fixture = bookFixture();
  const { model, world, calls, pump } = fixture;
  model.attach(pump);
  assert.deepEqual(model.book(), { count: 4, token: "PET" }, "no template yet: «Питомец»");
  assert.deepEqual(bookFixture({ creatureType: 3 }).model.book(), { count: 4, token: "DEMON" }, "CREATURE_TYPE_DEMON: «Демон»");
  assert.deepEqual(bookFixture({ creatureType: 1 }).model.book(), { count: 4, token: "PET" });
  assert.deepEqual(model.bookSpell(1), {
    spellId: BITE, state: ACT_ENABLED, name: "Укус", rank: "Уровень 1",
    iconPath: "Interface\\Icons\\Ability_Druid_FerociousBite", passive: false,
  });
  assert.equal(model.bookSpell(3)?.passive, true, "the row's own passive bit");
  assert.equal(model.bookSpell(4), undefined, "a row not cached answers nothing");
  assert.ok(fixture.prefetched.at(-1)?.ids.includes(COWER), "…and is fetched outside the C-API read");
  assert.deepEqual(model.bookCooldown(1), [0, 0, 1], "ready: enabled, so the stock book draws it undimmed");
  world.petCooldowns.set(HOWL, fixture.monotonic + 40_000);
  world.events.emit("PET_COOLDOWNS_CHANGED", {});
  assert.deepEqual(model.bookCooldown(2), [300, 40, 1]);

  model.castBookSpell(1);
  model.castBookSpell(3);
  model.toggleBookAutocast(2);
  model.toggleBookAutocast(3);
  assert.deepEqual(calls, [["cast", BITE, ACT_ENABLED, undefined], ["autocast", HOWL, true]],
    "a passive neither casts nor autocasts");
  calls.length = 0;
  model.placeSpell(7, HOWL);
  model.placeSpell(2, HOWL);
  model.placeSpell(7, COBRA_REFLEXES);
  model.placeSpell(7, 99999);
  assert.deepEqual(calls, [["set", 6, packPetAction(HOWL, ACT_DISABLED)]],
    "into the empty spell slot with its book state; never over a command, never a passive or an unknown spell");

  world.petSpells.spells = [];
  assert.equal(model.book(), undefined, "a temporary pet has no book");
});

test("the spellbook bindings answer the \"pet\" book from the pet model and every other book from the seam", () => {
  const base = {
    GetSpellName: () => ["seam"], GetSpellTexture: () => ["seam.blp"], GetSpellCooldown: () => [0, 0, 0],
    GetSpellAutocast: () => [false, false], IsPassiveSpell: () => [false], IsSelectedSpell: () => [true],
    GetSpellLink: () => ["seam-link"], CastSpell: () => [], HasPetSpells: () => [false],
  };
  const wrapped = frameXmlWithPetBook(base);
  const casts = [];
  const toggles = [];
  const petActions = {
    book: () => ({ count: 2, token: "PET" }),
    bookSpell: (index) => index === 1
      ? { spellId: HOWL, state: ACT_DISABLED, name: "Неистовый вой", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Hunter_Pet_Wolf", passive: false }
      : undefined,
    bookCooldown: () => [0, 0, 1],
    castBookSpell: (index) => casts.push(index),
    toggleBookAutocast: (index) => toggles.push(index),
  };
  const seam = { petActions };
  const call = (name, ...args) => wrapped[name](seam, args);
  assert.deepEqual(call("HasPetSpells"), [2, "PET"]);
  assert.deepEqual(call("GetSpellName", 1, "pet"), ["Неистовый вой", "Уровень 1"]);
  assert.deepEqual(call("GetSpellName", 1, "spell"), ["seam"], "the player's book stays the seam's");
  assert.deepEqual(call("GetSpellName", 2, "pet"), [], "an unresolved pet row is nil");
  assert.deepEqual(call("GetSpellTexture", 1, "PET"), ["Interface\\Icons\\Ability_Hunter_Pet_Wolf"], "book types are case-insensitive");
  assert.deepEqual(call("GetSpellCooldown", 1, "pet"), [0, 0, 1]);
  assert.deepEqual(call("GetSpellAutocast", 1, "pet"), [true, false]);
  assert.deepEqual(call("IsPassiveSpell", 1, "pet"), [false]);
  assert.deepEqual(call("IsSelectedSpell", 1, "pet"), [false]);
  assert.match(String(call("GetSpellLink", 1, "pet")[0]), /\|Hspell:24604\|h\[Неистовый вой\]/);
  assert.deepEqual(call("GetSpellLink", 1), ["seam-link"], "a bare id is the seam's");
  call("CastSpell", 1, "pet");
  call("CastSpell", 1, "spell");
  call("ToggleSpellAutocast", 1, "pet");
  call("ToggleSpellAutocast", 1, "spell");
  assert.deepEqual(casts, [1]);
  assert.deepEqual(toggles, [1], "the player's book has no autocast");
  assert.deepEqual(wrapped.HasPetSpells({}, []), [false], "a seam without the pet model keeps its own answer");
});

test("the cursor takes a pet book spell to the pet bar only", async () => {
  const placed = [];
  const host = {
    cursorInfo: () => [], cursorHasItem: () => false, clearCursor: () => {}, spellIsPassive: () => false,
    itemInfo: () => undefined, actionButton: () => undefined, setActionButton: () => {},
    spellBookSpellId: () => undefined, spellInfo: () => undefined, spellTexture: () => undefined,
    petActions: {
      book: () => ({ count: 2, token: "PET" }),
      bookSpell: (slot) => (slot === 1 ? { spellId: HOWL, state: ACT_DISABLED, passive: false }
        : slot === 2 ? { spellId: COBRA_REFLEXES, state: ACT_PASSIVE, passive: true } : undefined),
      placeSpell: (index, spellId) => placed.push([index, spellId]),
    },
  };
  const cursor = new FrameXmlCursorModel(host);
  const fired = [];
  cursor.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 0 });
  cursor.pickupSpell(2, "pet");
  assert.equal(cursor.held(), undefined, "a passive stays in the book");
  cursor.pickupSpell(1, "pet");
  await Promise.resolve();
  assert.deepEqual(cursor.held(), { kind: "spell", spellId: HOWL, bookType: "pet" });
  assert.deepEqual(cursor.info(), ["spell", 1, "pet"], "GetCursorInfo names the pet book slot");
  assert.ok(fired.includes(FRAMEXML_PET_ACTION_EVENTS.showGrid) && !fired.includes("ACTIONBAR_SHOWGRID"),
    `the pet bar's grid, not the main bars': ${JSON.stringify(fired)}`);
  cursor.pickupPetAction(7);
  await Promise.resolve();
  assert.deepEqual(placed, [[7, HOWL]]);
  assert.equal(cursor.held(), undefined);
});
}

// ── framexml-pet-declension.test.mjs
{
// Plan item 3.09 (L17, 04.10): the ruRU pet name declension as Wow.exe 3.3.5a 12340 answers it (read-only
// Ghidra, .runtime/re-2026-10-04/l17/g1.c, g2.c): GetNumDeclensionSets 0x00511dd0 → 0x0076dd40, DeclineName
// 0x00511e80 → 0x0076dd60 (only locale index 8 reaches the rule engine), PetRename 0x005d5670 (ERR_NO_PET,
// ERR_NOTYOURPET, ERR_PET_NOT_RENAMEABLE, ERR_NAME_NO_NAME; 0x0076dd20 decides the declension step; five
// forms send 0x005d4a00, fewer fire event 0x252), SMSG_PET_NAME_INVALID (case 0x178): the declined block
// fires the event again with the server's forms.
const { FrameXmlPetDeclensionModel, FRAMEXML_PET_DECLENSION_BINDINGS, FRAMEXML_PET_FORCE_NAME_DECLENSION,
  frameXmlPetDeclensionsApply } = await import("../dist/code/browser/framexml/FrameXmlPetDeclension.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { globalString } = await import("../dist/code/generated/globalStrings.js");

const SELF = 0x10n;
const PET = 0xf1400000000000aan;
const FORMS = ["Тузика", "Тузику", "Тузика", "Тузиком", "Тузике"];

function petObject({ owner = SELF, renameable = true, typeId = 3 } = {}) {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset, Number(owner & 0xffffffffn));
  fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset + 1, Number(owner >> 32n));
  // UNIT_FIELD_BYTES_2: byte 2 is the pet flags, 0x01 UNIT_CAN_BE_RENAMED.
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, renameable ? 0x01 << 16 : 0);
  return { guid: PET, typeId, fields };
}

function stage({ locale = "ruRU", pet = petObject(), petGuid = PET } = {}) {
  const fired = [];
  const sent = [];
  const objects = new Map([[SELF, { guid: SELF, typeId: 4, fields: new Map() }]]);
  if (pet) objects.set(pet.guid, pet);
  const world = {
    state: { selfGuid: SELF, objects },
    petSpells: petGuid === null ? undefined : { guid: petGuid },
    renamePet: (name, declined) => { sent.push(declined === undefined ? [name] : [name, ...declined]); },
    onPetNameInvalid: undefined,
  };
  const model = new FrameXmlPetDeclensionModel({ world: () => world, locale: () => locale });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  const seam = { locale, petDeclension: model, petRename: () => { throw new Error("the companion send is not used"); } };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return { world, model, fired, sent, call };
}

const uiError = (key) => ["UI_ERROR_MESSAGE", globalString(key) ?? key];

test("the three names are the declension bindings in the seam table", () => {
  for (const name of ["GetNumDeclensionSets", "DeclineName", "PetRename"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_PET_DECLENSION_BINDINGS[name], name);
  }
});

test("GetNumDeclensionSets and DeclineName answer on a ruRU client only (0x0076dd40/0x0076dd60)", () => {
  const ru = stage();
  assert.equal(ru.call("GetNumDeclensionSets", "Тузик", 2)[0] >= 1, true);
  assert.deepEqual(ru.call("DeclineName", "Тузик", 2, 1), FORMS);
  const en = stage({ locale: "enUS" });
  assert.deepEqual(en.call("GetNumDeclensionSets", "Тузик", 2), [0]);
  assert.deepEqual(en.call("DeclineName", "Тузик", 2, 1), [undefined, undefined, undefined, undefined, undefined]);
});

test("PetRename refuses in Wow.exe's order with the UI errors, and sends nothing", () => {
  const cases = [
    [{ petGuid: null }, "ERR_NO_PET"],
    [{ pet: null }, "ERR_NO_PET"],
    [{ pet: petObject({ owner: 0x99n }) }, "ERR_NOTYOURPET"],
    [{ pet: petObject({ renameable: false }) }, "ERR_PET_NOT_RENAMEABLE"],
  ];
  for (const [options, key] of cases) {
    const { call, fired, sent } = stage(options);
    assert.deepEqual(call("PetRename", "Тузик"), []);
    assert.deepEqual(fired, [uiError(key)], key);
    assert.deepEqual(sent, [], key);
  }
  // Not your pet comes before not renameable; an empty name only after both.
  const both = stage({ pet: petObject({ owner: 0x99n, renameable: false }) });
  both.call("PetRename", "");
  assert.deepEqual(both.fired, [uiError("ERR_NOTYOURPET")]);
  for (const name of ["", undefined]) {
    const empty = stage();
    empty.call("PetRename", name);
    assert.deepEqual(empty.fired, [uiError("ERR_NAME_NO_NAME")]);
    assert.deepEqual(empty.sent, []);
  }
});

test("the client's own name check (0x007e1f00) refuses before any declension or send, with 0x005218c0's error", () => {
  const cases = [
    ["Тууузик", "ERR_NAME_THREE_CONSECUTIVE"],
    ["Ъузик", "ERR_NAME_RUSSIAN_SILENT_CHARACTER_AT_BEGINNING_OR_END"],
    ["Тузъьик", "ERR_NAME_RUSSIAN_CONSECUTIVE_SILENT_CHARACTERS"],
    ["Rex Two", "ERR_NAME_INVALID"],
    ["   ", "ERR_NAME_INVALID"],
    ["Rexа", "ERR_NAME_INVALID"],
    ["Т", "ERR_NAME_TOO_SHORT"],
    ["Абвгдежзийклм", "ERR_NAME_TOO_LONG"],
  ];
  for (const [name, key] of cases) {
    const { call, fired, sent } = stage();
    call("PetRename", name, ...FORMS);
    assert.deepEqual(fired, [uiError(key)], name);
    assert.deepEqual(sent, [], name);
  }
  // Twelve letters pass; the CJK limit is 8 here (the character check's is 6).
  const twelve = stage();
  twelve.call("PetRename", "Абвгдежзийкл", ...FORMS);
  assert.deepEqual(twelve.sent, [["Абвгдежзийкл", ...FORMS]]);
  const cjk = stage({ locale: "zhCN" });
  cjk.call("PetRename", "一二三四五六七");
  assert.deepEqual(cjk.sent, [["一二三四五六七"]]);
});

test("a Cyrillic name on ruRU opens the declension frame until all five forms come with it", () => {
  const { call, fired, sent } = stage();
  call("PetRename", "Тузик");
  assert.deepEqual(fired, [[FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик"]]);
  assert.deepEqual(sent, []);
  fired.length = 0;
  // A missing or empty form stops the reading: the frame again, nothing sent.
  call("PetRename", "Тузик", ...FORMS.slice(0, 4));
  call("PetRename", "Тузик", FORMS[0], "", ...FORMS.slice(2));
  assert.deepEqual(fired, [[FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик"], [FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик"]]);
  assert.deepEqual(sent, []);
  fired.length = 0;
  call("PetRename", "Тузик", ...FORMS);
  assert.deepEqual(fired, []);
  assert.deepEqual(sent, [["Тузик", ...FORMS]]);
});

test("a Latin name on ruRU, and any name on another locale, is sent without declensions", () => {
  const ru = stage();
  ru.call("PetRename", "Rex", ...FORMS);
  assert.deepEqual(ru.sent, [["Rex"]]);
  assert.deepEqual(ru.fired, []);
  assert.equal(frameXmlPetDeclensionsApply("ruRU", "Rex"), false);
  assert.equal(frameXmlPetDeclensionsApply("ruRU", "Тузик"), true);
  const en = stage({ locale: "enUS" });
  en.call("PetRename", "Тузик");
  assert.deepEqual(en.sent, [["Тузик"]]);
  assert.deepEqual(en.fired, []);
});

test("SMSG_PET_NAME_INVALID with a declined block reopens the frame with the server's forms", () => {
  const { world, fired } = stage();
  const earlier = [];
  // A listener that held the hook before attach keeps hearing the packet.
  world.onPetNameInvalid({ error: 16, name: "Тузик", declined: FORMS });
  assert.deepEqual(fired, [[FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик", ...FORMS]]);
  fired.length = 0;
  world.onPetNameInvalid({ error: 11, name: "Тууузик", declined: [] });
  assert.deepEqual(fired, [], "an error without the block opens nothing (its text is the native notice)");
  const chained = stage();
  chained.model.detach();
  chained.world.onPetNameInvalid = (rejected) => earlier.push(rejected.error);
  chained.model.attach({ fire: (event, ...args) => { chained.fired.push([event, ...args]); return 1; }, now: () => 0 });
  chained.world.onPetNameInvalid({ error: 16, name: "Тузик", declined: FORMS });
  assert.deepEqual(earlier, [16]);
  assert.equal(chained.fired.length, 1);
  chained.model.detach();
  assert.equal(typeof chained.world.onPetNameInvalid, "function", "detach gives the earlier listener back");
  chained.world.onPetNameInvalid({ error: 16, name: "Тузик", declined: FORMS });
  assert.deepEqual(earlier, [16, 16]);
  assert.equal(chained.fired.length, 1);
});

test("a seam without the model keeps the companion binding's plain send", () => {
  const names = [];
  const seam = { locale: "ruRU", petRename: (name) => names.push(name) };
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.PetRename(seam, ["Тузик"]), []);
  assert.deepEqual(names, ["Тузик"]);
});
}

// ── framexml-pet-food-types.test.mjs
{
// 05.10-petfood: `GetPetFoodTypes()` as Wow.exe 3.3.5a 12340 answers it (0x005d3bd0, registered beside its
// name at .data 0x00ad0d00; notes .runtime/re-2026-10-05/l-petfood/g1.c): the PetInfo pet, a hunter's only
// (0x0071b630), its creature cache family (0x007153e0), CreatureFamily.PetFoodMask (record +0x1c), and the
// ItemPetFood names whose bit `1 << (ID - 1)` is set, in table order. The stock diet tooltip
// (PetPaperDollFrame.xml:298) formats `BuildListString(GetPetFoodTypes())` with `%s`, which raises on nil
// since string.format became the client's own (3.27, 05.10). Nothing here talks to the running gateway.
const { PET_FOODS_VERSION, loadPetFoods, petFoodCatalog } = await import("../dist/code/gateway/PetFoodMetadata.js");
const { serveCatalogRoute, CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { PET_FOODS_ROUTE_PATH, PET_FOODS_ROUTE_VERSION, petFoodTableFrom } = await import("../dist/code/browser/PetFoodClient.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

let dbcDirectory;
try { dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory(); } catch { dbcDirectory = undefined; }
const withDataset = {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/ItemPetFood.dbc`) ? false : "no dataset DBCs on this machine",
};
const uiParent = dbcDirectory ? `${dbcDirectory}/../luaxml/Interface/FrameXML/UIParent.lua` : undefined;
const withStockUi = { skip: uiParent && existsSync(uiParent) ? false : "no stock FrameXML on this machine" };

// Wolf (family 1): meat 1, fish 2, bread 4 → bits 0, 1, 3; a family 2 that eats only fish.
const SAMPLE = {
  version: 1,
  families: [[1, 0b1011], [2, 0b10]],
  foods: [[1, "Мясо"], [2, "Рыба"], [3, "Сыр"], [4, "Хлеб"]],
};

test("the route and the client agree on the version and the path; the table is validated", () => {
  assert.equal(PET_FOODS_ROUTE_VERSION, PET_FOODS_VERSION);
  assert.equal(PET_FOODS_ROUTE_PATH, `/dbc/pet-foods?v=${PET_FOODS_VERSION}`);
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/pet-foods" && route.version === PET_FOODS_VERSION));
  assert.ok(petFoodTableFrom(SAMPLE));
  assert.equal(petFoodTableFrom({ ...SAMPLE, version: 2 }), undefined);
  assert.equal(petFoodTableFrom({ ...SAMPLE, foods: [[1]] }), undefined);
  assert.equal(petFoodTableFrom({ ...SAMPLE, families: [[1, "x"]] }), undefined);
  const table = petFoodTableFrom(SAMPLE);
  assert.deepEqual([...table.foodNames(table.familyMask(1))], ["Мясо", "Рыба", "Хлеб"], "table order, bit ID - 1");
  assert.deepEqual([...table.foodNames(table.familyMask(2))], ["Рыба"]);
  assert.equal(table.familyMask(9), 0);
  assert.equal(table.foodNames(0b1011), table.foodNames(0b1011), "one frozen answer per mask, no allocation per hover");
});

test("the catalog reads ID and the ruRU Name_lang slot of ItemPetFood, PetFoodMask (field 7) of CreatureFamily", () => {
  // Synthetic rows: field 1 is enUS, 2 koKR, 9 ruRU (slot 8); CreatureFamily field 7 the mask, 8 PetTalentType.
  const foods = { records: 1, int: (_row, field) => (field === 0 ? 1 : 0), float: () => 0,
    string: (_row, field) => ({ 1: "Meat", 2: "고기", 9: "Мясо" })[field] ?? "" };
  const families = { records: 2, int: (row, field) => [[1, 0, 0, 0, 0, 0, 0, 0b1011, 5], [2, 0, 0, 0, 0, 0, 0, 0, 1]][row][field] ?? 0,
    float: () => 0, string: () => "" };
  const catalog = petFoodCatalog(families, foods, "ruRU");
  assert.deepEqual(catalog.foods, [[1, "Мясо"]]);
  assert.deepEqual(catalog.families, [[1, 0b1011]], "a family with mask 0 is left out");
});

test("this dataset's tables: eight ruRU food names in file order, every hunter family has a diet", withDataset, async () => {
  const catalog = await loadPetFoods(dbcDirectory);
  const table = petFoodTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table);
  assert.deepEqual(catalog.foods.map(([id]) => id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...table.foodNames(0xff)],
    ["Мясо", "Рыба", "Сыр", "Хлеб", "Грибы", "Фрукты", "Сырое мясо", "Сырая рыба"]);
  assert.ok(table.familyMask(1) !== 0, "the wolf (CreatureFamily 1) eats something");
  assert.ok(catalog.families.every(([, mask]) => mask > 0 && mask <= 0xffffffff));
});

test("the route answers through the catalog table with the Origin and version checks", withDataset, async () => {
  const run = async (path, origin) => {
    const url = new URL(path, "http://127.0.0.1");
    const response = { status: 0, body: "", writeHead(status) { this.status = status; return this; }, end(body = "") { this.body = body; return this; } };
    await serveCatalogRoute({ method: "GET", headers: { origin } }, response, url, new Map(),
      { dbcDirectory, allowedOrigins: ["http://127.0.0.1:5173"] });
    return response;
  };
  const ok = await run(PET_FOODS_ROUTE_PATH, "http://127.0.0.1:5173");
  assert.equal(ok.status, 200);
  assert.ok(petFoodTableFrom(JSON.parse(ok.body)));
  assert.equal((await run("/dbc/pet-foods?v=9", "http://127.0.0.1:5173")).status, 400);
  assert.equal((await run(PET_FOODS_ROUTE_PATH, "http://evil.test")).status, 403);
});

function fixture(table) {
  const offset = (name) => UPDATE_FIELDS[name].offset;
  const selfGuid = 0x10n;
  const petGuid = 0xf140000000000200n;
  // A hunter (class 3) and the pet the pet bar names: a pet number, created by that hunter.
  const self = { guid: selfGuid, typeId: 4, fields: new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8)]]) };
  const pet = {
    guid: petGuid, typeId: 3,
    fields: new Map([[offset("OBJECT_FIELD_ENTRY"), 299], [offset("UNIT_FIELD_PETNUMBER"), 7]]),
  };
  pet.fields.set(offset("UNIT_FIELD_CREATEDBY"), Number(selfGuid));
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [petGuid, pet]]) },
    petSpells: { guid: petGuid },
    creatureTemplates: new Map([[299, { entry: 299, found: true, name: "Волк", creatureType: 1, creatureFamily: 1 }]]),
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0, partyStats: new Map(),
  };
  const holder = { table };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1,
    globalCooldownUntil: () => 0, castSpell: () => {}, petFoods: { table: () => holder.table },
  });
  const call = () => [...FRAMEXML_SEAM_BINDINGS.GetPetFoodTypes(seam, [])];
  return { self, pet, world, holder, call, offset, seam };
}

test("GetPetFoodTypes: the hunter pet's diet; nothing without a pet, a hunter, a cached family or a diet", () => {
  const { call, self, pet, world, offset, holder } = fixture(petFoodTableFrom(SAMPLE));
  assert.deepEqual(call(), ["Мясо", "Рыба", "Хлеб"]);
  world.creatureTemplates.get(299).creatureFamily = 2;
  assert.deepEqual(call(), ["Рыба"]);
  world.creatureTemplates.get(299).creatureFamily = 9;
  assert.deepEqual(call(), [], "a family with no diet row: no values (Wow.exe 0x005d3bd0)");
  world.creatureTemplates.get(299).creatureFamily = 1;
  world.creatureTemplates.get(299).found = false;
  assert.deepEqual(call(), [], "nothing in the creature cache: family 0 (0x007153e0)");
  world.creatureTemplates.get(299).found = true;
  self.fields.set(offset("UNIT_FIELD_BYTES_0"), 1 | (9 << 8));
  assert.deepEqual(call(), [], "a warlock's demon is no hunter's pet (0x0071b630)");
  self.fields.set(offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8));
  pet.fields.set(offset("UNIT_FIELD_PETNUMBER"), 0);
  assert.deepEqual(call(), [], "a charmed creature has no pet number");
  pet.fields.set(offset("UNIT_FIELD_PETNUMBER"), 7);
  world.petSpells = undefined;
  assert.deepEqual(call(), [], "no pet");
  world.petSpells = { guid: pet.guid };
  holder.table = undefined;
  assert.deepEqual(call(), [""], "a gateway older than the route: an empty list, never a guessed food");
});

/** The stock tooltip line, with the stock BuildListString read from the dataset's UIParent.lua. */
function stockDietTooltip(seam) {
  const source = readFileSync(uiParent, "utf8");
  const start = source.indexOf("function BuildListString(...)");
  const end = source.indexOf("\nend", start);
  assert.ok(start >= 0 && end > start, "UIParent.lua defines BuildListString");
  const vm = new GlueLuaVm();
  try {
    vm.registerGlobal("GetPetFoodTypes", (args) => FRAMEXML_SEAM_BINDINGS.GetPetFoodTypes(seam, args));
    assert.equal(vm.execute(source.slice(start, end + 4), "@UIParent.lua").ok, true);
    vm.setGlobal("PET_DIET_TEMPLATE", "Рацион: %s");
    // PetPaperDollFrame.xml:298, the diet icon's OnEnter.
    const result = vm.execute("__r = format(PET_DIET_TEMPLATE, BuildListString(GetPetFoodTypes()))", "@PetPaperDollFrame.xml");
    return result.ok ? vm.getGlobal("__r") : { error: String(result.error) };
  } finally {
    vm.close();
  }
}

test("the stock diet tooltip formats without a format error, with and before the route's table", withStockUi, () => {
  const { seam, holder } = fixture(petFoodTableFrom(SAMPLE));
  assert.equal(stockDietTooltip(seam), "Рацион: Мясо, Рыба, Хлеб");
  holder.table = undefined;
  assert.equal(stockDietTooltip(seam), "Рацион: ", "stale gateway: an empty list, not «bad argument #2 to 'format'»");
});

// PetStable.lua:101 formats `BuildListString(GetStablePetFoodTypes(i))` for the selected stabled pet with no
// guard; Wow.exe 0x005a16a0 reads the slot pet's creature cache family (no hunter check) over the same tables.
test("GetStablePetFoodTypes: the slot pet's family diet, 0 the pet that is out; nothing for an empty slot", async () => {
  const { FrameXmlStableModel, FRAMEXML_STABLE_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlStable.js");
  const { FrameXmlCannedStableWorld } = await import("../dist/code/browser/framexml/FrameXmlStableCanned.js");
  const world = new FrameXmlCannedStableWorld();
  const holder = { table: petFoodTableFrom(SAMPLE) };
  // The canned list: slot 0 a wolf (69), 1 a tiger (681), 2 a spider (30, family 3: no diet row here).
  const families = new Map([[69, 1], [681, 2], [30, 3]]);
  const model = new FrameXmlStableModel({
    world: () => world,
    creatureFamily: (entry) => world.uncached.has(entry) ? undefined : families.get(entry),
    familyIcon: () => undefined, familyName: () => undefined, talentTree: () => undefined,
    petFoods: () => holder.table,
  });
  model.attach({ fire: () => 1 });
  model.owned = true;
  const host = { stable: model };
  const call = (...args) => [...FRAMEXML_STABLE_BINDINGS.GetStablePetFoodTypes(host, args)];
  assert.deepEqual(call(1), [], "no stable open");
  world.open();
  assert.deepEqual(call(0), ["Мясо", "Рыба", "Хлеб"]);
  assert.deepEqual(call(1), ["Рыба"]);
  assert.deepEqual(call(2), [], "a family without a diet row");
  assert.deepEqual(call(3), [], "a bought, empty slot");
  world.uncached.add(681);
  assert.deepEqual(call(1), [], "the template has not answered: family unknown");
  world.uncached.delete(681);
  holder.table = undefined;
  assert.deepEqual(call(1), [""], "a gateway older than the route: an empty list");
  // 3.27 (13.10): 0x005a16a0 reads its index with FISTP — to nearest, ties to even — and raises the client's own
  // text (it names GetStablePetInfo) for anything `lua_isnumber` refuses, stable or no stable.
  holder.table = petFoodTableFrom(SAMPLE);
  assert.deepEqual(call(0.5), ["Мясо", "Рыба", "Хлеб"], "0.5 → 0: the pet that is out");
  assert.deepEqual(call(1.5), [], "1.5 → 2, the spider");
  assert.deepEqual(call(1.4), ["Рыба"]);
  assert.deepEqual(call(2.5), [], "2.5 → 2");
  assert.deepEqual(call(0.6), ["Рыба"], "0.6 → 1");
  assert.deepEqual(call("1"), ["Рыба"], "a numeric string is a number");
  for (const bad of [undefined, "x", {}]) {
    assert.throws(() => call(bad), /^Error: Usage: GetStablePetInfo\(index\)$/);
    assert.throws(() => [...FRAMEXML_STABLE_BINDINGS.GetStablePetFoodTypes({}, [bad])], /Usage: GetStablePetInfo/);
  }
});
}
