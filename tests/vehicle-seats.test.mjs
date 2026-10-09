import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { MOVEMENT_FLAGS, readMovementInfo } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  buildChangeSeatsOnControlledVehicle, buildDismissControlledVehicle, drivenVehicle,
} from "../dist/code/world/VehicleProtocol.js";

// 11.02-C: seats and the way out. The core reads `CMSG_DISMISS_CONTROLLED_VEHICLE` as the vehicle's
// packed guid and MovementInfo (VehicleHandler.cpp:27-50) and `CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE`
// as packed guid, MovementInfo, packed accessory guid and a signed seat byte (:80-108). Wow.exe sends
// both from the driven vehicle's movement queue (events 0x34 and 0x37 of 0x006ef860, queued by
// 0x006ef540 and 0x006ef5a0): `VehicleExit` (0x005fb660 → 0x0074c7f0 → 0x005d46f0) when the
// character sits in the unit it moves, `CMSG_REQUEST_VEHICLE_EXIT` otherwise; `VehiclePrevSeat` /
// `VehicleNextSeat` (0x0074c8b0 / 0x0074c9a0) as seat −1 / +1 with no accessory while driving, the
// empty prev/next opcodes otherwise; `UnitSwitchToVehicleSeat` (0x0074ca90) with the seat's vehicle
// as the accessory while driving, `CMSG_REQUEST_VEHICLE_SWITCH_SEAT` otherwise.

const SELF = 0x1234n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const TURRET = 0xf150_7d9b_0000_0043n;
const OTHER = 0xf130_0000_0000_0099n;

const movement = {
  flags: MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.onTransport,
  flags2: 0,
  time: 4321,
  position: { x: 500, y: 600, z: 70, orientation: 1 },
  transport: { guid: 0x1fc0_0000_0000_0007n, x: 1, y: 2, z: 3, orientation: 0.5, time: 77, seat: 0 },
  fallTime: 12,
};

test("11.02-C: DISMISS_CONTROLLED_VEHICLE is the vehicle's packed guid and its MovementInfo", () => {
  const body = new PacketReader(buildDismissControlledVehicle(VEHICLE, movement));
  assert.equal(body.packedGuid(), VEHICLE);
  const info = readMovementInfo(body);
  body.assertFinished();
  assert.equal(info.flags, movement.flags);
  assert.equal(info.time, 4321);
  assert.deepEqual([info.position.x, info.position.y, info.position.z], [500, 600, 70]);
  assert.equal(info.transport?.guid, movement.transport.guid);
  assert.equal(info.transport?.seat, 0);
  assert.equal(info.fallTime, 12);
});

test("11.02-C: CHANGE_SEATS_ON_CONTROLLED_VEHICLE adds the packed accessory and a signed seat", () => {
  const next = new PacketReader(buildChangeSeatsOnControlledVehicle(VEHICLE, movement, 0n, 1));
  assert.equal(next.packedGuid(), VEHICLE);
  readMovementInfo(next);
  assert.equal(next.packedGuid(), 0n, "no accessory: prev/next by the seat's sign (:99-100)");
  assert.equal(next.u8(), 1);
  next.assertFinished();

  const previous = new PacketReader(buildChangeSeatsOnControlledVehicle(VEHICLE, movement, 0n, -1));
  previous.packedGuid();
  readMovementInfo(previous);
  previous.packedGuid();
  assert.equal(previous.u8(), 0xff, "−1 as the byte 0xFF (Wow.exe 0x0074c8b0 queues 0xff)");
  previous.assertFinished();

  const named = new PacketReader(buildChangeSeatsOnControlledVehicle(VEHICLE, movement, TURRET, 3));
  named.packedGuid();
  readMovementInfo(named);
  assert.equal(named.packedGuid(), TURRET);
  assert.equal(named.u8(), 3);
  named.assertFinished();
  assert.throws(() => buildChangeSeatsOnControlledVehicle(VEHICLE, movement, 0n, 128), RangeError);
});

/** A WorldClient over a fake connection, logged in as SELF, with a vehicle in view. */
async function seatClient() {
  const login = new PacketWriter().u32(0).f32(10).f32(20).f32(30).f32(0).toUint8Array();
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  client.state.move(VEHICLE, { flags: 0, position: { x: 500, y: 600, z: 70, orientation: 1 } });
  client.state.objects.get(VEHICLE).typeId = 3;
  client.state.move(OTHER, { flags: 0, position: { x: 50, y: 60, z: 7, orientation: 0 } });
  client.state.objects.get(OTHER).typeId = 3;
  client.state.move(SELF, { flags: 0, position: { x: 501.5, y: 600, z: 72.25, orientation: 1 },
    transport: { guid: VEHICLE, x: 1.5, y: 0, z: 2.25, orientation: 0, seat: 0 } });
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  connection.sent.length = 0;
  return { client, connection };
}
const opcodes = (connection) => connection.sent.map((packet) => packet.opcode);

test("11.02-C: the driver is the character seated in the unit it moves", async () => {
  const { client } = await seatClient();
  const view = () => drivenVehicle(client.state.objects, client.state.selfGuid, client.controlledGuid);
  assert.equal(view(), undefined, "no unit handed over: a passenger");
  client.controlledGuid = SELF;
  assert.equal(view(), undefined, "moving itself: a passenger");
  client.controlledGuid = OTHER;
  assert.equal(view(), undefined, "a possessed unit it does not sit in");
  client.controlledGuid = VEHICLE;
  assert.equal(view(), VEHICLE);
  client.close();
});

test("11.02-C: leaving — DISMISS with the vehicle's movement while driving, REQUEST_VEHICLE_EXIT otherwise", async () => {
  const { client, connection } = await seatClient();
  client.leaveVehicle();
  assert.deepEqual(opcodes(connection), [OPCODES.CMSG_REQUEST_VEHICLE_EXIT]);
  assert.equal(connection.sent[0].payload.length, 0);

  connection.sent.length = 0;
  client.controlledGuid = OTHER;
  client.leaveVehicle();
  assert.deepEqual(opcodes(connection), [OPCODES.CMSG_REQUEST_VEHICLE_EXIT], "possessing is not driving");

  connection.sent.length = 0;
  client.controlledGuid = VEHICLE;
  client.leaveVehicle();
  assert.deepEqual(opcodes(connection), [OPCODES.CMSG_DISMISS_CONTROLLED_VEHICLE]);
  const body = new PacketReader(connection.sent[0].payload);
  assert.equal(body.packedGuid(), VEHICLE);
  const info = readMovementInfo(body);
  body.assertFinished();
  assert.deepEqual([info.position.x, info.position.y, info.position.z], [500, 600, 70],
    "the vehicle's place, not the character's");

  // The movement layer's live state of the vehicle wins over the last packet, as for every ACK.
  connection.sent.length = 0;
  client.movementSnapshot = (guid) => guid === VEHICLE
    ? { flags: MOVEMENT_FLAGS.forward, flags2: 0, time: 9, position: { x: 510, y: 605, z: 71, orientation: 1.5 } }
    : undefined;
  client.leaveVehicle();
  const live = new PacketReader(connection.sent[0].payload);
  assert.equal(live.packedGuid(), VEHICLE);
  const moving = readMovementInfo(live);
  assert.deepEqual([moving.position.x, moving.flags], [510, MOVEMENT_FLAGS.forward]);
  client.close();
});

test("11.02-C: seats — CHANGE_SEATS while driving, the request opcodes as a passenger", async () => {
  const { client, connection } = await seatClient();
  client.changeVehicleSeat(true);
  client.changeVehicleSeat(false);
  client.takeVehicleSeat(VEHICLE, 2);
  assert.deepEqual(opcodes(connection), [OPCODES.CMSG_REQUEST_VEHICLE_NEXT_SEAT, OPCODES.CMSG_REQUEST_VEHICLE_PREV_SEAT,
    OPCODES.CMSG_REQUEST_VEHICLE_SWITCH_SEAT]);
  const request = new PacketReader(connection.sent[2].payload);
  assert.equal(request.packedGuid(), VEHICLE);
  assert.equal(request.u8(), 2);
  request.assertFinished();

  connection.sent.length = 0;
  client.controlledGuid = VEHICLE;
  client.changeVehicleSeat(true);
  client.changeVehicleSeat(false);
  client.takeVehicleSeat(TURRET, 1);
  assert.deepEqual(opcodes(connection), Array(3).fill(OPCODES.CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE));
  const tails = connection.sent.map(({ payload }) => {
    const reader = new PacketReader(payload);
    const guid = reader.packedGuid();
    const info = readMovementInfo(reader);
    const accessory = reader.packedGuid();
    const seat = reader.u8();
    reader.assertFinished();
    return { guid, x: info.position.x, accessory, seat };
  });
  assert.deepEqual(tails, [
    { guid: VEHICLE, x: 500, accessory: 0n, seat: 1 },
    { guid: VEHICLE, x: 500, accessory: 0n, seat: 0xff },
    { guid: VEHICLE, x: 500, accessory: TURRET, seat: 1 },
  ]);
  client.close();
});
