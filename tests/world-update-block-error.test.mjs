// 5.26: a parse error inside SMSG_UPDATE_OBJECT must not leave half an object behind
// (docs/implementation/line-A4.ru.md, 5.26 and М-A4-5).
//
// Every block below is written by hand in the order the core writes it — never by the reader under
// test. Paths are relative to tswow/cores/TrinityCore/src/server/game:
//   UpdateData::BuildPacket — u32 block count, then the blocks, OUT_OF_RANGE first (Entities/Object/Updates/UpdateData.cpp)
//   Object::BuildCreateUpdateBlockForPlayer — u8 type, packed guid, u8 typeId, movement, values (Entities/Object/Object.cpp)
//   Object::BuildMovementUpdate — u16 update flags, LIVING: MovementInfo + nine speeds + WriteCreate (Object.cpp:315-343)
//   Movement::PacketBuilder::WriteCreate — the create spline (Movement/Spline/MovementPacketBuilder.cpp:147-186)
import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UpdateBlockError, WorldState } from "../dist/code/world/WorldState.js";
import { settle, travelClient } from "./fixtures/world-packets.mjs";

const UPDATETYPE_VALUES = 0;
const UPDATETYPE_CREATE_OBJECT = 2;
const UPDATETYPE_OUT_OF_RANGE_OBJECTS = 4;
const UPDATEFLAG_LIVING = 0x0020;
const UPDATEFLAG_STATIONARY_POSITION = 0x0040;
const MOVEMENTFLAG_SPLINE_ENABLED = 0x08000000;

const A = 0xf130000000000a01n;
const B = 0xf130000000000b02n;
const C = 0xf130000000000c03n;

/** A stationary create with two field slots, 0 and 6 (OBJECT_FIELD_GUID low, UNIT_FIELD_CHARM low). */
function writeStationaryCreate(writer, guid, x) {
  writer.u8(UPDATETYPE_CREATE_OBJECT).packedGuid(guid).u8(3)
    .u16(UPDATEFLAG_STATIONARY_POSITION)
    .f32(x).f32(2).f32(3).f32(0.5);
  writer.u8(1).u32(0b1000001).u32(0x1111).u32(0x6666);
}

/** A LIVING create whose spline claims `nodes` path nodes, as `WriteCreate` lays it out. */
function writeLivingSplineCreate(writer, guid, nodes) {
  writer.u8(UPDATETYPE_CREATE_OBJECT).packedGuid(guid).u8(3).u16(UPDATEFLAG_LIVING);
  // MovementInfo: flags, flags2, time, position, fall time (Unit::BuildMovementPacket).
  writer.u32(MOVEMENTFLAG_SPLINE_ENABLED).u16(0).u32(0).f32(7).f32(8).f32(9).f32(0).u32(0);
  for (let speed = 0; speed < 9; speed++) writer.f32(speed + 1);
  // WriteCreate: flags, timePassed, duration, id, two duration mods, vertical acceleration,
  // effect start, then the node count — which the reader must refuse above 4096.
  writer.u32(0).u32(0).u32(1000).u32(9).f32(1).f32(1).f32(0).u32(0).u32(nodes);
}

function brokenPacket() {
  const writer = new PacketWriter().u32(3);
  writer.u8(UPDATETYPE_OUT_OF_RANGE_OBJECTS).u32(1).packedGuid(A);
  writeStationaryCreate(writer, B, 1);
  writeLivingSplineCreate(writer, C, 5000);
  return writer.toUint8Array();
}

function spy() {
  const events = [];
  return {
    events,
    fieldsChanged(guid, indices) { events.push(["fields", guid, [...indices]]); },
    objectCreated(guid) { events.push(["created", guid]); },
    objectDestroyed(guid) { events.push(["destroyed", guid]); },
    objectMoved(guid) { events.push(["moved", guid]); },
    selfChanged() {},
  };
}

test("a failed create leaves no half object, keeps what came before, and names what it lost", () => {
  const state = new WorldState();
  const first = new PacketWriter().u32(1);
  writeStationaryCreate(first, A, 5);
  state.applyUpdate(first.toUint8Array());
  const observer = spy();
  state.observer = observer;
  const revision = state.revision;

  let caught;
  try {
    state.applyUpdate(brokenPacket());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof UpdateBlockError, "the error says which block failed");
  assert.deepEqual([...caught.retired], [A], "A left in the same packet and must still be retired");
  assert.equal(caught.blockIndex, 2);
  assert.equal(caught.blocksLost, 1);
  assert.equal(caught.guid, C);
  assert.equal(caught.updateType, UPDATETYPE_CREATE_OBJECT);
  assert.ok(caught.cause instanceof RangeError);
  assert.match(caught.message, /1 block/);

  assert.equal(state.objects.has(A), false);
  const b = state.objects.get(B);
  assert.ok(b, "B was read whole before the failure");
  assert.deepEqual(b.position, { x: 1, y: 2, z: 3, orientation: 0.5 });
  assert.equal(b.fields.get(0), 0x1111);
  assert.equal(b.fields.get(6), 0x6666);
  assert.equal(state.objects.has(C), false, "no object without a position");
  assert.ok(state.failedCreates.has(C));
  assert.ok(state.revision > revision, "what was applied is announced");
  assert.equal(state.updateBlockFailures, 1);
  assert.equal(state.updateBlocksLost, 1);

  // B's events in the order the store relies on, and nothing at all for C.
  const bEvents = observer.events.filter((event) => event[1] === B).map((event) => event[0]);
  assert.deepEqual(bEvents, ["created", "moved", "fields"]);
  assert.equal(observer.events.some((event) => event[1] === C), false);

  // A VALUES block for the quarantined guid is read past and creates no stub.
  const values = new PacketWriter().u32(1)
    .u8(UPDATETYPE_VALUES).packedGuid(C).u8(1).u32(1).u32(0x42).toUint8Array();
  state.applyUpdate(values);
  assert.equal(state.objects.has(C), false);

  // A fresh create lifts the quarantine.
  const again = new PacketWriter().u32(1);
  writeStationaryCreate(again, C, 4);
  state.applyUpdate(again.toUint8Array());
  assert.equal(state.objects.get(C)?.position?.x, 4);
  assert.equal(state.failedCreates.has(C), false);
});

test("a failed create's fields are never written before the block is whole", () => {
  // The values come after the spline in the block, so the spline failing must leave the object
  // and its fields untouched; the fields of a failed VALUES block must not land either.
  const state = new WorldState();
  const first = new PacketWriter().u32(1);
  writeStationaryCreate(first, B, 1);
  state.applyUpdate(first.toUint8Array());
  const truncated = new PacketWriter().u32(1)
    .u8(UPDATETYPE_VALUES).packedGuid(B).u8(1).u32(0b11).u32(0x77).toUint8Array(); // second value missing
  assert.throws(() => state.applyUpdate(truncated), UpdateBlockError);
  assert.equal(state.objects.get(B).fields.get(0), 0x1111, "slot 0 is not half-written");
  assert.equal(state.failedCreates.size, 0, "only a failed create is quarantined");
});

test("a failed create for a guid still held keeps that object live, not frozen", () => {
  // The player kept through a far teleport (`clearExcept`) is the one guid whose CREATE can meet an
  // existing object; quarantining it would drop every later VALUES block for the character.
  const state = new WorldState();
  const first = new PacketWriter().u32(1);
  writeStationaryCreate(first, B, 1);
  state.applyUpdate(first.toUint8Array());
  const broken = new PacketWriter().u32(1);
  writeLivingSplineCreate(broken, B, 5000);
  assert.throws(() => state.applyUpdate(broken.toUint8Array()), UpdateBlockError);
  assert.equal(state.failedCreates.has(B), false);
  const values = new PacketWriter().u32(1)
    .u8(UPDATETYPE_VALUES).packedGuid(B).u8(1).u32(1).u32(0x42).toUint8Array();
  state.applyUpdate(values);
  assert.equal(state.objects.get(B).fields.get(0), 0x42);
});

test("destroying or leaving range clears the quarantine", () => {
  const state = new WorldState();
  assert.throws(() => state.applyUpdate(brokenPacket()), UpdateBlockError);
  assert.ok(state.failedCreates.has(C));
  state.destroy(C);
  assert.equal(state.failedCreates.has(C), false);

  assert.throws(() => state.applyUpdate(brokenPacket()), UpdateBlockError);
  const gone = new PacketWriter().u32(1).u8(UPDATETYPE_OUT_OF_RANGE_OBJECTS).u32(1).packedGuid(C).toUint8Array();
  state.applyUpdate(gone);
  assert.equal(state.failedCreates.has(C), false);
});

test("WorldClient retires what the broken packet removed and records the loss", async () => {
  const self = 0x1n;
  const { client, connection } = await travelClient([], self);
  client.state.move(A, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.auras.set(A, new Map([[0, { spellId: 1 }]]));
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, brokenPacket());
  await settle();
  assert.equal(client.auras.has(A), false, "A's auras went with it");
  const entry = client.packetErrors.summary().find((error) => error.name === "SMSG_UPDATE_OBJECT");
  assert.ok(entry, "the failure is recorded");
  assert.match(entry.message, /1 block/);
  assert.ok(client.state.objects.has(B));
  assert.equal(client.state.objects.has(C), false);
  client.close?.();
});
