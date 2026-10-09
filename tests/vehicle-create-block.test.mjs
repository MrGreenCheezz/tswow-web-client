import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// 11.02-F1: which Vehicle.dbc row a unit uses, kept on the object. The create block's
// UPDATEFLAG_VEHICLE (0x0080) carries `u32 Vehicle.ID, f32 orientation` — the transport offset's when
// the unit rides a transport, its own otherwise (Object.cpp:456-467) — after the transport clock and
// before the rotation; SMSG_PLAYER_VEHICLE_DATA (`packed guid, u32 id`, 0 = no longer a vehicle;
// Unit.cpp:8684-8705, 8769-8783, SpellAuraEffects.cpp:5051-5054) gives and takes a player's kit (and an
// NPCBot's) later. Everything else in a create block reads exactly as before.

const UPDATEFLAG_LIVING = 0x0020;
const UPDATEFLAG_HAS_TARGET = 0x0004;
const UPDATEFLAG_VEHICLE = 0x0080;
const ENGINE = 0xf150_0074_9800_0101n;
const GUARD = 0xf130_0000_0000_0202n;
const SELF = 0x1234n;
const RIDER = 0x55n;

/** One CREATE_OBJECT block of a living unit; `vehicle` adds UPDATEFLAG_VEHICLE's eight bytes. */
function writeCreate(writer, guid, { typeId = 3, x = 1, orientation = 0.5, vehicle, target } = {}) {
  let flags = UPDATEFLAG_LIVING;
  if (vehicle) flags |= UPDATEFLAG_VEHICLE;
  if (target !== undefined) flags |= UPDATEFLAG_HAS_TARGET;
  writer.u8(2).packedGuid(guid).u8(typeId).u16(flags)
    .u32(0).u16(0).u32(77)
    .f32(x).f32(2).f32(3).f32(orientation)
    .u32(0);
  for (let speed = 0; speed < 9; speed++) writer.f32(speed + 1);
  if (target !== undefined) writer.packedGuid(target);
  if (vehicle) writer.u32(vehicle.id).f32(vehicle.orientation);
  return writer.u8(0); // no update-field blocks
}

function update(...blocks) {
  const writer = new PacketWriter().u32(blocks.length);
  for (const [guid, options] of blocks) writeCreate(writer, guid, options);
  return writer.toUint8Array();
}

/** The object as a plain record, the vehicle fields and the update flags left out. */
function shape(object) {
  const { vehicleId: _id, vehicleOrientation: _o, updateFlags: _flags, speeds, fields, ...rest } = object;
  return { ...rest, speeds: [...speeds ?? []], fields: [...fields] };
}

test("CREATE with UPDATEFLAG_VEHICLE keeps the Vehicle.dbc id and the orientation, and reads exactly its eight bytes", () => {
  const state = new WorldState();
  // The vehicle first and a plain creature right behind it in the same packet: one byte too many or
  // too few in the vehicle block and the second block is garbage or the packet does not finish.
  state.applyUpdate(update(
    [ENGINE, { vehicle: { id: 117, orientation: 2.75 }, target: SELF }],
    [GUARD, { x: 40, orientation: 1.25 }],
  ), 0);
  const engine = state.objects.get(ENGINE);
  assert.equal(engine.vehicleId, 117);
  assert.equal(engine.vehicleOrientation, 2.75);
  assert.equal(engine.targetGuid, SELF);
  const guard = state.objects.get(GUARD);
  assert.equal(guard.position.x, 40);
  assert.equal(guard.position.orientation, 1.25);
  assert.equal(guard.vehicleId, undefined);
  assert.equal(guard.vehicleOrientation, undefined);
  assert.ok("vehicleOrientation" in guard, "a created object has the field in its shape from the start");
  assert.equal(guard.speeds.get("run"), 2);
});

test("without the flag the object is what it was; with it, the same object plus the two vehicle fields", () => {
  const plain = new WorldState();
  plain.applyUpdate(update([ENGINE, { target: SELF }]), 0);
  const vehicle = new WorldState();
  vehicle.applyUpdate(update([ENGINE, { target: SELF, vehicle: { id: 117, orientation: 2.75 } }]), 0);
  assert.deepEqual(shape(vehicle.objects.get(ENGINE)), shape(plain.objects.get(ENGINE)));
  assert.equal(plain.objects.get(ENGINE).vehicleId, undefined);
  assert.equal(plain.objects.get(ENGINE).updateFlags, UPDATEFLAG_LIVING | UPDATEFLAG_HAS_TARGET);
  // Every create starts a fresh object: a unit that came back without its kit is no vehicle.
  vehicle.applyUpdate(update([ENGINE, { target: SELF }]), 1);
  assert.equal(vehicle.objects.get(ENGINE).vehicleId, undefined);
  assert.equal(vehicle.objects.get(ENGINE).vehicleOrientation, undefined);
});

test("objects start with the vehicle fields in their shape", () => {
  const state = new WorldState();
  state.move(RIDER, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  const object = state.objects.get(RIDER);
  assert.ok("vehicleId" in object && "vehicleOrientation" in object);
});

/** A WorldClient over a fake connection, logged in as SELF (the harness of mover-control). */
async function client() {
  const login = new PacketWriter().u32(0).f32(10).f32(20).f32(30).f32(0).toUint8Array();
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
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  world.state.move(RIDER, { flags: 0, position: { x: 12, y: 20, z: 30, orientation: 0 } });
  await world.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { world, deliver };
}

const vehicleData = (guid, id) => new PacketWriter().packedGuid(guid).u32(id).toUint8Array();

test("SMSG_PLAYER_VEHICLE_DATA gives a player in view its kit, and 0 takes it away", async () => {
  const { world, deliver } = await client();
  const events = [];
  world.events.on("VEHICLE_CHANGED", (data) => events.push(data.vehicleId));
  await deliver(OPCODES.SMSG_PLAYER_VEHICLE_DATA, vehicleData(RIDER, 312));
  assert.equal(world.state.objects.get(RIDER).vehicleId, 312);
  assert.equal(world.vehicleKits.get(RIDER), 312, "the kit table as before");
  await deliver(OPCODES.SMSG_PLAYER_VEHICLE_DATA, vehicleData(RIDER, 0));
  assert.equal(world.state.objects.get(RIDER).vehicleId, undefined);
  assert.equal(world.vehicleKits.has(RIDER), false);
  assert.deepEqual(events, [312, 0]);
  // A unit out of view gets no stub object: its create block will carry UPDATEFLAG_VEHICLE itself.
  const away = 0x99n;
  await deliver(OPCODES.SMSG_PLAYER_VEHICLE_DATA, vehicleData(away, 312));
  assert.equal(world.state.objects.has(away), false);
  assert.equal(world.vehicleKits.get(away), 312);
});
