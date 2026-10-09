// Plan item 1.10, the DropItemOnUnit half (lane L1, 03.10). Wow.exe 12340 0x0051bdd0
// (`.runtime/re-2026-09-30/m3/d2.c`, `d5.c`; `.runtime/re-2026-10-03/l1-item-cursor/`): with a bag item
// on the cursor, the player himself wears it (0x006dfc40(0), AutoEquipCursorItem's route); another
// player the player may trade with (0x00729b30: neither charmed, same FactionGroup, not attackable)
// gets it in his open trade window (0x00586b50: a bound item into the seventh slot, any other into the
// first free 1..6) or a trade proposal (0x00703cf0: once a second, ERR_ALREADY_TRADING while the own
// proposal waits); the player's pet (PetInfo's guid) is fed (0x0080dcf0: pet number, created by the
// player, a known feeding spell — 0x006e7b00 keeps the last learned spell whose first effect is
// FEED_PET (101) and that is no trade spell) with CMSG_CAST_SPELL TARGET_FLAG_ITEM, and the hand lets go.
import assert from "node:assert/strict";
import test from "node:test";

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const cursor = await import("../dist/code/browser/game/SpellCursor.js");
const drop = await import("../dist/code/browser/framexml/FrameXmlDropItemOnUnit.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const FRIEND = 0x11n;
const PET = 0xf140_0000_0000_0021n;
const FOOD = 0x4000_0000_0000_0701n;
const RING = 0x4000_0000_0000_0702n;
const FEED_PET = 6991;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

function unitObject(guid, typeId, entries = []) {
  return { guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries) };
}

// ---- the rules ------------------------------------------------------------------------------------

test("0x006e7b00: the feeding spell is the last known one whose first effect is FEED_PET, not a trade spell", () => {
  const rows = { 1: { effects: [101, 0, 0] }, 2: { effects: [0, 101, 0] }, 3: { effects: [101, 0, 0], attributes: [0x20, 0, 0, 0, 0, 0, 0, 0] },
    4: { effects: [101, 0, 0], attributes: [0x10, 0, 0, 0, 0, 0, 0, 0] } };
  const of = (id) => rows[id];
  assert.equal(drop.frameXmlFeedPetSpell([{ id: 1 }, { id: 2 }], of), 1, "only Effect[0]");
  assert.equal(drop.frameXmlFeedPetSpell([{ id: 1 }, { id: 3 }], of), 1, "a trade spell is skipped");
  assert.equal(drop.frameXmlFeedPetSpell([{ id: 1 }, { id: 4 }], of), 4, "the last one wins");
  assert.equal(drop.frameXmlFeedPetSpell([{ id: 2 }], of), undefined);
  assert.equal(drop.frameXmlFeedPetSpell(undefined, of), undefined);
});

test("0x00729b30: not oneself, nobody charmed, one FactionGroup when both are known, not attackable", () => {
  const charmed = offset("UNIT_FIELD_CHARMEDBY");
  const template = offset("UNIT_FIELD_FACTIONTEMPLATE");
  const self = unitObject(PLAYER, 4, [[template, 1]]);
  const friend = unitObject(FRIEND, 4, [[template, 2]]);
  const groups = { 1: 3, 2: 3, 5: 5 };
  const groupOf = (id) => groups[id];
  const never = () => false;
  assert.equal(drop.frameXmlCanTradeWith(self, friend, groupOf, never), true);
  assert.equal(drop.frameXmlCanTradeWith(self, self, groupOf, never), false, "oneself");
  assert.equal(drop.frameXmlCanTradeWith(self, friend, groupOf, () => true), false, "attackable");
  const horde = unitObject(FRIEND, 4, [[template, 5]]);
  assert.equal(drop.frameXmlCanTradeWith(self, horde, groupOf, never), false, "another FactionGroup");
  assert.equal(drop.frameXmlCanTradeWith(self, unitObject(FRIEND, 4, [[template, 9]]), groupOf, never), true, "a row not known: no compare");
  const mindControlled = unitObject(FRIEND, 4, [[template, 2]]);
  setGuid(mindControlled.fields, charmed, 0x99n);
  assert.equal(drop.frameXmlCanTradeWith(self, mindControlled, groupOf, never), false, "he is charmed");
  const charmedSelf = unitObject(PLAYER, 4, [[template, 1]]);
  setGuid(charmedSelf.fields, charmed, 0x99n);
  assert.equal(drop.frameXmlCanTradeWith(charmedSelf, friend, groupOf, never), false, "the player is charmed");
});

test("0x00586b50: a bound item takes the empty seventh slot only; any other the first free of 1..6", () => {
  const takenOf = (...wires) => (wire) => wires.includes(wire);
  assert.equal(drop.frameXmlTradeSlotForDrop(true, false, takenOf(0, 1)), 6);
  assert.equal(drop.frameXmlTradeSlotForDrop(true, false, takenOf(6)), undefined, "the seventh slot is full");
  assert.equal(drop.frameXmlTradeSlotForDrop(false, false, takenOf(0, 1)), 2);
  assert.equal(drop.frameXmlTradeSlotForDrop(false, false, takenOf(0, 1, 2, 3, 4, 5)), undefined, "no free slot");
  assert.equal(drop.frameXmlTradeSlotForDrop(false, true, takenOf()), undefined, "offered already");
});

test("0x0080dcf0: a pet number, created by the player, and a feeding spell", () => {
  const pet = unitObject(PET, 3, [[offset("UNIT_FIELD_PETNUMBER"), 7]]);
  setGuid(pet.fields, offset("UNIT_FIELD_CREATEDBY"), PLAYER);
  assert.equal(drop.frameXmlCanFeedPet(pet, PLAYER, FEED_PET), true);
  assert.equal(drop.frameXmlCanFeedPet(pet, PLAYER, undefined), false, "no feeding spell");
  assert.equal(drop.frameXmlCanFeedPet(pet, FRIEND, FEED_PET), false, "someone else's");
  const numberless = unitObject(PET, 3);
  setGuid(numberless.fields, offset("UNIT_FIELD_CREATEDBY"), PLAYER);
  assert.equal(drop.frameXmlCanFeedPet(numberless, PLAYER, FEED_PET), false, "a guardian without a pet number");
});

/** A recording host for frameXmlDropItemOnUnit. */
function host(overrides = {}) {
  const log = [];
  const units = new Map([
    ["player", unitObject(PLAYER, 4)], ["target", unitObject(FRIEND, 4)], ["pet", unitObject(PET, 3)],
    ["npc", unitObject(0xf130_0000_0000_0001n, 3)], ["chest", unitObject(0xf110_0000_0000_0001n, 5)],
  ]);
  const state = { open: false, partner: 0n, incoming: false, taken: [], offered: false, now: 0 };
  const value = {
    log, units, state,
    cursorItem: () => ({ guid: RING, item: unitObject(RING, 1) }),
    unit: (token) => units.get(token),
    self: () => units.get("player"),
    autoEquip: () => log.push("autoEquip"),
    canTradeWith: () => true,
    bound: () => false,
    trade: {
      open: () => state.open, partner: () => state.partner, incoming: () => state.incoming,
      offered: () => state.offered, taken: (wire) => state.taken.includes(wire),
      place: (wire) => log.push(["place", wire]),
      propose: (guid) => { log.push(["propose", guid]); state.partner = guid; },
    },
    petGuid: () => PET,
    feedPetSpell: () => FEED_PET,
    feed: (spell, item, guid) => { log.push(["feed", spell, guid]); return true; },
    clearCursor: () => log.push("clear"),
    error: (name) => log.push(["error", name]),
    now: () => state.now,
    ...overrides,
  };
  return value;
}

test("the player himself wears it; nothing without a bag item on the cursor or a unit", () => {
  drop.resetFrameXmlDropItemThrottle();
  const h = host();
  drop.frameXmlDropItemOnUnit("player", h);
  assert.deepEqual(h.log, ["autoEquip"]);
  const empty = host({ cursorItem: () => undefined });
  drop.frameXmlDropItemOnUnit("player", empty);
  drop.frameXmlDropItemOnUnit("target", empty);
  assert.deepEqual(empty.log, []);
  const h2 = host();
  drop.frameXmlDropItemOnUnit("nobody", h2);
  drop.frameXmlDropItemOnUnit("chest", h2);
  drop.frameXmlDropItemOnUnit("npc", h2);
  assert.deepEqual(h2.log, [], "no unit, a game object, an NPC that is not the pet");
});

test("another player: into his open trade, else a proposal once a second, ERR_ALREADY_TRADING while it waits", () => {
  drop.resetFrameXmlDropItemThrottle();
  const h = host();
  h.state.open = true;
  h.state.partner = FRIEND;
  h.state.taken = [0];
  drop.frameXmlDropItemOnUnit("target", h);
  assert.deepEqual(h.log, [["place", 1]], "the first free slot");
  h.log.length = 0;
  h.bound = () => true;
  drop.frameXmlDropItemOnUnit("target", h);
  assert.deepEqual(h.log, [["place", 6]], "a bound item: the seventh slot");
  h.log.length = 0;
  h.state.partner = 0x55n;
  drop.frameXmlDropItemOnUnit("target", h);
  assert.deepEqual(h.log, [], "a trade with someone else: nothing");

  const p = host();
  drop.frameXmlDropItemOnUnit("target", p);
  assert.deepEqual(p.log, [["propose", FRIEND]]);
  p.log.length = 0;
  p.state.partner = 0n;
  p.state.now = 999;
  drop.frameXmlDropItemOnUnit("target", p);
  assert.deepEqual(p.log, [], "within the second: nothing sent (0x00703cf0)");
  p.state.now = 1000;
  drop.frameXmlDropItemOnUnit("target", p);
  assert.deepEqual(p.log, [["propose", FRIEND]]);
  p.log.length = 0;
  p.state.now = 5000;
  drop.frameXmlDropItemOnUnit("target", p);
  assert.deepEqual(p.log, [["error", "ERR_ALREADY_TRADING"]], "the own proposal still waits");
  p.log.length = 0;
  p.state.incoming = true;
  drop.frameXmlDropItemOnUnit("target", p);
  assert.deepEqual(p.log, [], "someone else's proposal waits: nothing (not established)");

  const refused = host({ canTradeWith: () => false });
  drop.frameXmlDropItemOnUnit("target", refused);
  assert.deepEqual(refused.log, [], "0x00729b30 says no: nothing, no message");
});

test("the pet is fed and the hand lets go; a failed cast keeps the item; someone else's pet is not", () => {
  drop.resetFrameXmlDropItemThrottle();
  const h = host();
  h.units.get("pet").fields.set(offset("UNIT_FIELD_PETNUMBER"), 7);
  setGuid(h.units.get("pet").fields, offset("UNIT_FIELD_CREATEDBY"), PLAYER);
  drop.frameXmlDropItemOnUnit("pet", h);
  assert.deepEqual(h.log, [["feed", FEED_PET, RING], "clear"]);
  const failed = host({ feed: () => false });
  failed.units.set("pet", h.units.get("pet"));
  drop.frameXmlDropItemOnUnit("pet", failed);
  assert.deepEqual(failed.log, [], "nothing went out: the item stays held");
  const other = host({ petGuid: () => 0x77n });
  other.units.set("pet", h.units.get("pet"));
  drop.frameXmlDropItemOnUnit("pet", other);
  assert.deepEqual(other.log, [], "not PetInfo's pet");
  const unknown = host({ feedPetSpell: () => undefined });
  unknown.units.set("pet", h.units.get("pet"));
  drop.frameXmlDropItemOnUnit("pet", unknown);
  assert.deepEqual(unknown.log, [], "no feeding spell known");
});

// ---- through the stock seam -------------------------------------------------------------------------

function fixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8)]]);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), FOOD);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 2, RING);
  state.objects.set(PLAYER, { ...unitObject(PLAYER, 4), fields });
  state.objects.set(FRIEND, unitObject(FRIEND, 4));
  const pet = unitObject(PET, 3, [[offset("UNIT_FIELD_PETNUMBER"), 7]]);
  setGuid(pet.fields, offset("UNIT_FIELD_CREATEDBY"), PLAYER);
  state.objects.set(PET, pet);
  state.objects.set(FOOD, unitObject(FOOD, 1, [[offset("OBJECT_FIELD_ENTRY"), 4540], [offset("ITEM_FIELD_STACK_COUNT"), 1]]));
  state.objects.set(RING, unitObject(RING, 1, [[offset("OBJECT_FIELD_ENTRY"), 1076]]));
  state.selfGuid = PLAYER;
  const template = (entry, name, inventoryType) => ({
    entry, found: true, name, quality: 1, itemClass: 0, subClass: 0, flags: 0, inventoryType, bonding: 0,
    stackable: 20, bagFamily: 0, spells: [], itemLevel: 5, requiredLevel: 1, containerSlots: 0, maxDurability: 0,
    pageText: 0, startQuest: 0,
  });
  world.itemTemplates.set(4540, template(4540, "Твердый хлеб", 0));
  world.itemTemplates.set(1076, template(1076, "Кольцо", 11));
  world.knownSpells = [{ id: FEED_PET }];
  world.petSpells = { guid: PET, closed: false, creatureFamily: 1, duration: 0, reactState: 1, commandState: 1, flags: 0, bar: [], spells: [], cooldowns: [] };
  world.targetGuid = FRIEND;
  const packets = (opcode) => sent.filter((packet) => packet.opcode === opcode);
  return { world, sent, packets };
}

function withSeam(run) {
  const setup = fixture();
  const previous = game.world;
  game.world = setup.world;
  game.spells.set(FEED_PET, { id: FEED_PET, requiredTargetMode: 2, effects: [101, 0, 0], effectMiscValue: [0, 0, 0] });
  const seam = new LiveWorldSeam({
    world: () => setup.world, store: () => new WorldStore(setup.world.state), spell: () => undefined,
    monotonic: () => 1_000_000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const events = [];
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    seam.attach({ now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 1; } });
    setup.sent.length = 0;
    drop.resetFrameXmlDropItemThrottle();
    run({ ...setup, seam, events, call });
    seam.detach();
  } finally {
    cursor.cancelItemTarget();
    game.spells.delete(FEED_PET);
    game.world = previous;
  }
}

test("through the stock seam: food on the pet is CMSG_CAST_SPELL Feed Pet with TARGET_FLAG_ITEM, and the hand lets go", () => {
  withSeam(({ call, packets, seam }) => {
    assert.equal(typeof FRAMEXML_SEAM_BINDINGS.DropItemOnUnit, "function");
    call("DropItemOnUnit", "pet");
    assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 0, "nothing held: nothing");
    call("PickupContainerItem", 0, 1);
    assert.equal(seam.cursorHasItem(), true);
    call("DropItemOnUnit", "Pet");
    const casts = packets(OPCODES.CMSG_CAST_SPELL);
    assert.equal(casts.length, 1);
    const reader = new PacketReader(Uint8Array.from(casts[0].payload));
    reader.u8();
    assert.equal(reader.u32(), FEED_PET);
    reader.u8();
    assert.equal(reader.u32(), 0x10, "TARGET_FLAG_ITEM");
    assert.equal(reader.packedGuid(), FOOD);
    assert.equal(seam.cursorHasItem(), false, "ClearCursor(1, 1)");
    assert.equal(cursor.pendingItemTarget(), undefined, "the spell went with the send");
  });
});

test("through the stock seam: on the target player a trade is proposed; on the player himself the ring is worn", () => {
  withSeam(({ call, packets, seam }) => {
    call("PickupContainerItem", 0, 2);
    call("DropItemOnUnit", "target");
    assert.equal(packets(OPCODES.CMSG_INITIATE_TRADE).length, 1);
    assert.equal(seam.cursorHasItem(), true, "a proposal keeps the item held");
    call("DropItemOnUnit", "player");
    assert.equal(packets(OPCODES.CMSG_AUTOEQUIP_ITEM).length, 1, "AutoEquipCursorItem's route");
    assert.equal(seam.cursorHasItem(), false);
  });
});

test("through the stock seam: with his trade window open the item goes into its first free slot", () => {
  withSeam(({ call, packets, seam, world }) => {
    world.tradeOpen = true;
    world.tradePartnerGuid = FRIEND;
    call("PickupContainerItem", 0, 2);
    call("DropItemOnUnit", "target");
    const offers = packets(OPCODES.CMSG_SET_TRADE_ITEM);
    assert.equal(offers.length, 1);
    assert.deepEqual(offers[0].payload, [0, 255, 24], "wire slot 0 ← backpack slot 2");
    assert.equal(packets(OPCODES.CMSG_INITIATE_TRADE).length, 0);
    assert.equal(seam.cursorHasItem(), false, "the hand lets go (0x00519280(0, 1))");
  });
});
