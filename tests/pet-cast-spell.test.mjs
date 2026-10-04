import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { readMovementInfo } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_PASSIVE, ACT_REACTION, COMMAND_ATTACK, COMMAND_FOLLOW, REACT_DEFENSIVE,
  buildPetAction, packPetAction,
} from "../dist/code/world/PetProtocol.js";
import { buildPetCastSpell, petSlotCastsSpell } from "../dist/code/world/PetCastSpell.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// 11.02-D: `CMSG_PET_CAST_SPELL` = u64 caster | u8 castCount | u32 spell | u8 castFlags | targets |
// [castFlags & 2: f32 elevation, f32 speed, u8 hasMovement (+ u32 opcode + MSG_MOVE body)]
// (PetHandler.cpp:744-778, SpellHandler.cpp:52-73; Wow.exe writes the same at 0x0080b315 in 0x0080ac90).
// Wow.exe's pet bar (CastPetAction 0x005d67b0 → 0x005d4210) casts a spell slot — state & 0x3F of 1
// (ACT_PASSIVE / DISABLED / ENABLED) or 8…0x11 — through its own cast path (0x0080cce0, the packet
// above) when the bar's unit is the unit the character controls (0x006dd060: a vehicle or a possessed
// unit), and through CMSG_PET_ACTION otherwise; commands and reactions are always CMSG_PET_ACTION.

const SELF = 0x1234n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const PET = 0xf140_0000_0000_0011n;
const ENEMY = 0xf130_0000_0000_0077n;
const CANNON = 62345;
const FLAME = 62346;
const BITE = 17253;

test("11.02-D: the packet — caster in full, count, spell, flags, the targets block", () => {
  const plain = new PacketReader(buildPetCastSpell(VEHICLE, 7, CANNON, 0, { unit: ENEMY }));
  assert.equal(plain.u64(), VEHICLE);
  assert.equal(plain.u8(), 7);
  assert.equal(plain.u32(), CANNON);
  assert.equal(plain.u8(), 0);
  assert.equal(plain.u32(), 0x2, "TARGET_FLAG_UNIT");
  assert.equal(plain.packedGuid(), ENEMY);
  plain.assertFinished();

  const bare = new PacketReader(buildPetCastSpell(VEHICLE, 8, CANNON, 0, {}));
  bare.u64(); bare.u8(); bare.u32(); bare.u8();
  assert.equal(bare.u32(), 0, "no target: a bare mask, the core picks (Spell::InitExplicitTargets)");
  bare.assertFinished();

  const aimed = new PacketReader(buildPetCastSpell(VEHICLE, 9, CANNON, 2, { destination: { x: 1, y: 2, z: 3 } },
    { elevation: 0.5, speed: 30 }));
  aimed.u64(); aimed.u8(); aimed.u32();
  assert.equal(aimed.u8(), 2);
  assert.equal(aimed.u32(), 0x40, "TARGET_FLAG_DEST_LOCATION");
  assert.equal(aimed.packedGuid(), 0n);
  assert.deepEqual([aimed.f32(), aimed.f32(), aimed.f32()], [1, 2, 3]);
  assert.equal(aimed.f32(), 0.5);
  assert.equal(aimed.f32(), 30);
  assert.equal(aimed.u8(), 0, "no movement block");
  aimed.assertFinished();

  const moving = new PacketReader(buildPetCastSpell(VEHICLE, 10, CANNON, 2, {}, {
    elevation: 0.25, speed: 20,
    movement: { opcode: OPCODES.MSG_MOVE_STOP, guid: VEHICLE,
      info: { flags: 0, flags2: 0, time: 5, position: { x: 4, y: 5, z: 6, orientation: 0 } } },
  }));
  moving.u64(); moving.u8(); moving.u32(); moving.u8(); moving.u32();
  moving.f32(); moving.f32();
  assert.equal(moving.u8(), 1);
  assert.equal(moving.u32(), OPCODES.MSG_MOVE_STOP, "SpellHandler.cpp:67-71 reads the opcode, then the move");
  assert.equal(moving.packedGuid(), VEHICLE);
  assert.equal(readMovementInfo(moving).position.x, 4);
  moving.assertFinished();

  assert.equal(buildPetCastSpell(VEHICLE, 1, CANNON, 0, { unit: ENEMY, gameObject: 5n }), undefined,
    "a targets block that cannot be written is not sent");
});

test("11.02-D: which slots are spells, by Wow.exe 0x005d4210's switch on state & 0x3F", () => {
  for (const type of [ACT_PASSIVE, ACT_DISABLED, ACT_ENABLED, 8, 9, 15, 0x10, 0x11]) {
    assert.equal(petSlotCastsSpell(type), true, `0x${type.toString(16)}`);
  }
  for (const type of [0, ACT_COMMAND, ACT_REACTION, 0x12, 0x07 | 0x40]) {
    assert.equal(petSlotCastsSpell(type), false, `0x${type.toString(16)}`);
  }
});

/** A WorldClient over a fake connection, logged in as SELF, with a bar for `barGuid`. */
async function barClient(barGuid, bar) {
  const login = new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array();
  const waiters = [];
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.move(barGuid, { flags: 0, position: { x: 3, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(barGuid).typeId = 3;
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  const words = bar.concat(Array(10 - bar.length).fill(0));
  client.petSpells = {
    guid: barGuid, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
    flags: 0, spells: [], cooldowns: [],
    bar: words.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
  };
  client.targetGuid = ENEMY;
  connection.sent.length = 0;
  /** Hands the client one server packet through its read loop. */
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { client, connection, deliver };
}

/** VehicleSpellInitialize (Player.cpp:21452): slot i holds the creature's i-th spell with state i + 8. */
const vehicleBar = [packPetAction(CANNON, 8), packPetAction(FLAME, 9), packPetAction(0, 10)];

test("11.02-D: a vehicle's buttons cast through CMSG_PET_CAST_SPELL from the vehicle", async () => {
  const { client, connection } = await barClient(VEHICLE, vehicleBar);
  client.controlledGuid = VEHICLE;
  client.usePetSlot(0);
  client.usePetSlot(1, 0xf130_0000_0000_0088n);
  client.usePetSlot(2);
  assert.deepEqual(connection.sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_PET_CAST_SPELL],
    "an empty vehicle slot sends nothing (0x004cfd20 finds no spell 0)");
  const casts = connection.sent.map(({ payload }) => {
    const reader = new PacketReader(payload);
    const cast = { caster: reader.u64(), count: reader.u8(), spell: reader.u32(), flags: reader.u8(), mask: reader.u32() };
    cast.unit = reader.packedGuid();
    reader.assertFinished();
    return cast;
  });
  assert.deepEqual(casts.map(({ caster, spell, flags, mask, unit }) => ({ caster, spell, flags, mask, unit })), [
    { caster: VEHICLE, spell: CANNON, flags: 0, mask: 0x2, unit: ENEMY },
    { caster: VEHICLE, spell: FLAME, flags: 0, mask: 0x2, unit: 0xf130_0000_0000_0088n },
  ], "the selection, or the unit the press names");
  assert.notEqual(casts[0].count, casts[1].count, "each cast its own count");
  client.close();
});

test("11.02-D: a possessed unit's spells cast from it; its commands stay CMSG_PET_ACTION", async () => {
  const possessed = 0xf130_0000_0000_0055n;
  const attack = packPetAction(COMMAND_ATTACK, ACT_COMMAND);
  const { client, connection } = await barClient(possessed, [attack, 0, 0, packPetAction(BITE, ACT_PASSIVE)]);
  client.controlledGuid = possessed;
  client.usePetSlot(3);
  client.usePetSlot(0);
  assert.deepEqual(connection.sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_PET_ACTION]);
  const cast = new PacketReader(connection.sent[0].payload);
  assert.equal(cast.u64(), possessed);
  cast.u8();
  assert.equal(cast.u32(), BITE);
  assert.deepEqual([...connection.sent[1].payload], [...buildPetAction(possessed, attack, ENEMY)], "byte for byte as before");

  connection.sent.length = 0;
  client.castPetSpell(BITE, ACT_PASSIVE);
  assert.deepEqual(connection.sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL], "a book spell the same way");
  client.close();
});

test("11.02-D: a pet the character does not control keeps CMSG_PET_ACTION, byte for byte", async () => {
  const bite = packPetAction(BITE, ACT_ENABLED);
  const follow = packPetAction(COMMAND_FOLLOW, ACT_COMMAND);
  const { client, connection } = await barClient(PET, [packPetAction(COMMAND_ATTACK, ACT_COMMAND), follow, 0, bite]);
  for (const controlled of [undefined, SELF, VEHICLE]) {
    connection.sent.length = 0;
    client.controlledGuid = controlled;
    client.usePetSlot(3);
    client.usePetSlot(1);
    client.castPetSpell(BITE, ACT_ENABLED);
    assert.deepEqual(connection.sent.map((packet) => packet.opcode), Array(3).fill(OPCODES.CMSG_PET_ACTION));
    assert.deepEqual([...connection.sent[0].payload], [...buildPetAction(PET, bite, ENEMY)]);
    assert.deepEqual([...connection.sent[1].payload], [...buildPetAction(PET, follow, ENEMY)]);
    assert.deepEqual([...connection.sent[2].payload], [...buildPetAction(PET, bite, ENEMY)]);
  }
  client.close();
});

test("11.02-D: nothing after close", async () => {
  const { client, connection } = await barClient(VEHICLE, vehicleBar);
  client.controlledGuid = VEHICLE;
  client.close();
  client.usePetSlot(0);
  assert.deepEqual(connection.sent, []);
});

// 11.02-BCD review. Wow.exe's "unit the character controls" (0x006dd060) is not the active mover: it
// is the PLAYER_FARSIGHT unit when it carries UNIT_FLAG_POSSESSED (0x01000000) and its CHARMEDBY — or,
// with none, its CREATEDBY — is the character (0x004f7250). A fear or confusion on the driven unit
// takes the steering away (`SetFeared` / `SetConfused` → `SetClientControl(unit, 0)`, Unit.cpp:12343-12401)
// but leaves the flag, the charmer and the far sight alone, so the bar still casts as the unit; a
// CMSG_PET_ACTION for a vehicle is dropped by the core (no CharmInfo, PetHandler.cpp:138-144).
const control = (guid, allowed) => new PacketWriter().packedGuid(guid).u8(allowed ? 1 : 0).toUint8Array();
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const CHARMEDBY = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
const CREATEDBY = UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset;
const UNIT_FLAG_POSSESSED = 0x01000000;
const setGuid = (object, offset, guid) => {
  object.fields.set(offset, Number(guid & 0xffffffffn));
  object.fields.set(offset + 1, Number(guid >> 32n));
};

test("11.02-BCD review: a feared vehicle still casts from its bar — it is possessed by the character", async () => {
  const { client, connection, deliver } = await barClient(VEHICLE, vehicleBar);
  const vehicle = client.state.objects.get(VEHICLE);
  vehicle.fields.set(FLAGS, UNIT_FLAG_POSSESSED);
  setGuid(vehicle, CHARMEDBY, SELF);
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, true));
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, false));
  assert.equal(client.controlledGuid, undefined, "the refusal took the steering (M7-0)");
  connection.sent.length = 0;
  client.usePetSlot(0);
  assert.deepEqual(connection.sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL]);
  const cast = new PacketReader(connection.sent[0].payload);
  assert.equal(cast.u64(), VEHICLE);
  cast.u8();
  assert.equal(cast.u32(), CANNON);
  client.close();
});

test("11.02-BCD review: a possessed unit by its creator casts too; a charmed or someone else's unit keeps PET_ACTION", async () => {
  const unit = 0xf130_0000_0000_0066n;
  const bite = packPetAction(BITE, ACT_ENABLED);
  const { client, connection } = await barClient(unit, [bite]);
  const object = client.state.objects.get(unit);
  const press = () => {
    connection.sent.length = 0;
    client.usePetSlot(0);
    return connection.sent.map((packet) => packet.opcode);
  };
  object.fields.set(FLAGS, UNIT_FLAG_POSSESSED);
  setGuid(object, CREATEDBY, SELF);
  assert.deepEqual(press(), [OPCODES.CMSG_PET_CAST_SPELL], "no charmer: the creator (0x004f7250 falls back to CREATEDBY)");
  setGuid(object, CHARMEDBY, 0x9999n);
  assert.deepEqual(press(), [OPCODES.CMSG_PET_ACTION], "a charmer other than the character");
  setGuid(object, CHARMEDBY, 0xf130_0000_0000_0000n | SELF);
  assert.deepEqual(press(), [OPCODES.CMSG_PET_ACTION], "the whole guid, not its low half");
  setGuid(object, CHARMEDBY, SELF);
  object.fields.set(FLAGS, 0);
  assert.deepEqual(press(), [OPCODES.CMSG_PET_ACTION], "charmed, not possessed (Enslave Demon: CHARM_TYPE_CHARM)");
  assert.deepEqual([...connection.sent[0].payload], [...buildPetAction(unit, bite, ENEMY)], "byte for byte as before");
  client.close();
});

// L13 (04.10), 11.02-D: Wow.exe 0x005d4210 takes its own cast path (0x0080cce0 → CMSG_PET_CAST_SPELL) also for a
// spell whose AttributesEx4 has 0x20 (record +0x20; SPELL_ATTR4_UNK5, SharedDefines.h:560), whatever the bar's
// unit. 76 rows of the dataset's Spell.dbc carry it — Холод 33395 (the water elemental), Огненный ливень 19474,
// Движение 30012… — mostly area spells, which the realm never casts from CMSG_PET_ACTION (an area-enemy target
// returns early, PetHandler.cpp:290-294) and does cast from CMSG_PET_CAST_SPELL (InitExplicitTargets sets the
// destination at the unit target, Spell.cpp:709-719). The rows come from `/dbc/spells` (`attributes`, v=14).
test("L13 11.02-D: a pet's AttributesEx4 0x20 spell goes out as CMSG_PET_CAST_SPELL; the rest keep CMSG_PET_ACTION", async () => {
  const { setPetSpellAttributesSource, petSpellCastsAsUnit } = await import("../dist/code/world/PetCastSpell.js");
  const { setPetSpellPlacementSource } = await import("../dist/code/world/PetCastSpell.js"); // L13-review 11.02-D
  const FREEZE = 33395;
  const freeze = packPetAction(FREEZE, ACT_ENABLED);
  const bite = packPetAction(BITE, ACT_ENABLED);
  const attack = packPetAction(COMMAND_ATTACK, ACT_COMMAND);
  const { client, connection } = await barClient(PET, [attack, 0, 0, bite, freeze]);
  const attributes = new Map([[FREEZE, [0, 0, 0, 0, 0xa0, 0, 0, 0]], [BITE, [0, 0, 0, 0, 0, 0, 0, 0]]]);
  setPetSpellAttributesSource((id) => attributes.get(id));
  // L13-review 11.02-D: Холод lands on a point (Targets 0x40); the selection is an enemy the player may attack.
  setPetSpellPlacementSource({ targets: (id) => (id === FREEZE ? 0x40 : 0), attackable: (guid) => guid === ENEMY });
  try {
    client.usePetSlot(4);
    client.usePetSlot(3);
    client.usePetSlot(0);
    client.castPetSpell(FREEZE, ACT_ENABLED);
    assert.deepEqual(connection.sent.map((packet) => packet.opcode),
      [OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_PET_ACTION, OPCODES.CMSG_PET_ACTION, OPCODES.CMSG_PET_CAST_SPELL],
      "Холод from the bar and from the book; Укус and the order as before");
    const cast = new PacketReader(connection.sent[0].payload);
    assert.deepEqual([cast.u64(), cast.u8() >= 0, cast.u32(), cast.u8(), cast.u32(), cast.packedGuid()],
      [PET, true, FREEZE, 0, 0x2, ENEMY], "from the pet, at the selection (the realm puts the destination there)");
    cast.assertFinished();
    assert.deepEqual([...connection.sent[1].payload], [...buildPetAction(PET, bite, ENEMY)], "byte for byte as before");
    // No row yet (or a gateway without attributes): CMSG_PET_ACTION, as before.
    attributes.delete(FREEZE);
    connection.sent.length = 0;
    client.usePetSlot(4);
    assert.deepEqual(connection.sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_ACTION]);
    assert.deepEqual([...connection.sent[0].payload], [...buildPetAction(PET, freeze, ENEMY)]);
    // The bit itself: AttributesEx4 (the fifth word), 0x20 only.
    assert.equal(petSpellCastsAsUnit(FREEZE, [0, 0, 0, 0, 0x20, 0, 0, 0]), true);
    assert.equal(petSpellCastsAsUnit(FREEZE, [0x20, 0x20, 0x20, 0x20, 0x80, 0x20, 0x20, 0x20]), false);
    assert.equal(petSpellCastsAsUnit(FREEZE, undefined), false);
    assert.equal(petSpellCastsAsUnit(0, [0, 0, 0, 0, 0x20]), false, "an empty slot is no spell");
  } finally {
    setPetSpellAttributesSource(undefined);
    setPetSpellPlacementSource(undefined); // L13-review 11.02-D
    client.close();
  }
});

// L13-review (04.10), 11.02-D: the realm takes CMSG_PET_CAST_SPELL from an ordinary pet — a Pet is a Guardian
// (Pet.h:39; Guardian's constructor sets UNIT_MASK_GUARDIAN, TemporarySummon.cpp:438; IsGuardianPet() is true for
// a Pet, :420-423, so SetMinion makes it the owner's GetGuardianPet(), Unit.cpp:6311-6323, 6355-6373; the water
// elemental's SummonProperties 1561 has Control 2 = SUMMON_CATEGORY_PET) — and puts the point of a ground spell
// (Targets & TARGET_FLAG_DEST_LOCATION) on whatever unit the packet names, or on the pet when it names none
// (Spell::InitExplicitTargets, Spell.cpp:709-719). Wow.exe arms a reticle for such a spell (0x0080cce0); this client
// has none for pet spells, so a press that names no unit the player may attack keeps CMSG_PET_ACTION — the realm drops
// that one for an area-enemy spell (PetHandler.cpp:290-294), exactly as before L13 — rather than dropping Холод at a
// friend's feet or on the pet (a neutral pull, a broken polymorph, a PvP flag nobody aimed).
test("L13-review 11.02-D: an ordinary pet's ground spell goes out only at a unit the player may attack", async () => {
  const { setPetSpellAttributesSource, setPetSpellPlacementSource, petSpellCastsAsUnitAt } =
    await import("../dist/code/world/PetCastSpell.js");
  const FREEZE = 33395; // Холод: Targets 0x40, ImplicitTargetA 16/16 (TARGET_UNIT_DEST_AREA_ENEMY)
  const SELF_SPELL = 45322; // «Призыв питомца»: the bit, Targets 0, TARGET_UNIT_CASTER — no point to place
  const FRIEND = 0xf130_0000_0000_0099n;
  const freeze = packPetAction(FREEZE, ACT_ENABLED);
  const selfSpell = packPetAction(SELF_SPELL, ACT_ENABLED);
  const { client, connection } = await barClient(PET, [freeze, selfSpell]);
  const bit = [0, 0, 0, 0, 0x20, 0, 0, 0];
  setPetSpellAttributesSource((id) => (id === FREEZE || id === SELF_SPELL || id === 99_999 ? bit : undefined));
  const press = (slot, target) => {
    connection.sent.length = 0;
    client.usePetSlot(slot, target);
    return connection.sent;
  };
  const unitOf = (payload) => {
    const reader = new PacketReader(payload);
    reader.u64(); reader.u8(); reader.u32(); reader.u8();
    return reader.u32() === 0x2 ? reader.packedGuid() : 0n;
  };
  try {
    // No placement source (the page has not registered one): unknown — the press keeps CMSG_PET_ACTION.
    assert.deepEqual(press(0).map((packet) => packet.opcode), [OPCODES.CMSG_PET_ACTION], "unknown Targets: as before");
    setPetSpellPlacementSource({ targets: (id) => (id === FREEZE ? 0x40 : id === SELF_SPELL ? 0 : undefined),
      attackable: (guid) => guid === ENEMY });
    let sent = press(0);
    assert.deepEqual(sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL], "an enemy selected: at it");
    assert.equal(unitOf(sent[0].payload), ENEMY);
    client.targetGuid = FRIEND;
    sent = press(0);
    assert.deepEqual(sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_ACTION], "a friend selected: not at the friend");
    assert.deepEqual([...sent[0].payload], [...buildPetAction(PET, freeze, FRIEND)], "byte for byte as before L13");
    sent = press(0, ENEMY);
    assert.deepEqual(sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL], "the press names the enemy");
    assert.equal(unitOf(sent[0].payload), ENEMY);
    client.targetGuid = undefined;
    sent = press(0);
    assert.deepEqual(sent.map((packet) => packet.opcode), [OPCODES.CMSG_PET_ACTION], "nothing selected: not on the pet");
    assert.deepEqual([...sent[0].payload], [...buildPetAction(PET, freeze, 0n)]);
    // A spell that places no point keeps the pet's own cast whatever the selection (the realm drops the unit).
    client.targetGuid = FRIEND;
    assert.deepEqual(press(1).map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL]);
    client.castPetSpell(FREEZE, ACT_ENABLED);
    assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_PET_ACTION, "the book's press: the same rule");
    // The rule itself.
    assert.equal(petSpellCastsAsUnitAt(FREEZE, ENEMY), true);
    assert.deepEqual([FRIEND, 0n].map((unit) => petSpellCastsAsUnitAt(FREEZE, unit)), [false, false]);
    assert.equal(petSpellCastsAsUnitAt(SELF_SPELL, 0n), true);
    assert.equal(petSpellCastsAsUnitAt(BITE, ENEMY), false, "no bit: never");
    assert.equal(petSpellCastsAsUnitAt(99_999, ENEMY), false, "the bit, but no Targets word known: as before");
    // The bar of a unit the character steers is not this rule's: its ground spells still go out (11.02-D).
    client.controlledGuid = PET;
    assert.deepEqual(press(0).map((packet) => packet.opcode), [OPCODES.CMSG_PET_CAST_SPELL], "a driven unit: as before");
  } finally {
    setPetSpellAttributesSource(undefined);
    setPetSpellPlacementSource(undefined);
    client.close();
  }
});
