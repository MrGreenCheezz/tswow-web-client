import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import {
  SPLINE_MOVE_STATES, isSplineMoveState, isSplineSpeed, parseFlightSplineSync,
  parseSplineMoveState, parseSplineSpeed,
} from "../dist/code/world/SplineStateProtocol.js";
import {
  parseClientControlUpdate, parseKnockBack, parseMultipleMoves, parseTransferAborted,
} from "../dist/code/world/MovementAckProtocol.js";
import {
  parseActivateTaxiReply, parseShowTaxiNodes, parseTaxiNodeStatus,
} from "../dist/code/world/TaxiProtocol.js";
import {
  ENCOUNTER_FRAME_ENGAGE, ENCOUNTER_FRAME_PHASE_SHIFT_CHANGED, ENCOUNTER_FRAME_UPDATE_OBJECTIVE,
  parseDungeonDifficulty, parseEncounterFrame, parseInstanceResetFailed, parseRaidInstanceInfo,
} from "../dist/code/world/InstanceProtocol.js";
import {
  LIGHT_SLOT_CLEAR, LIGHT_SLOT_STORM,
  parseAreaTriggerMessage, parseBuildingDamage, parseSummonRequest, parseWeather,
  WEATHER_MEDIUM_RAIN,
} from "../dist/code/world/WorldMessageProtocol.js";
import { parseAreaSpiritHealerTime, parseCorpseMapPosition } from "../dist/code/world/DeathProtocol.js";
import { composePassengerPosition, passengerOffset } from "../dist/code/world/TransportMath.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import { WorldState } from "../dist/code/world/WorldState.js";

const CREATURE = 0xf130_0058_0000_1234n;

test("every spline state packet is one packed guid, and the opcode is the change", () => {
  // `Creature.cpp:3266` and its neighbours: `data << GetPackGUID()` and nothing after it. The
  // FORCE family the player's own mover uses appends a counter — copying that layout here reads
  // four bytes that are not there.
  assert.equal(SPLINE_MOVE_STATES.length, 16);
  const payload = new PacketWriter().packedGuid(CREATURE).toUint8Array();
  const swimming = parseSplineMoveState(OPCODES.SMSG_SPLINE_MOVE_START_SWIM, payload);
  assert.equal(swimming.guid, CREATURE);
  assert.equal(swimming.flag, MOVEMENT_FLAGS.swimming);
  assert.equal(swimming.set, true);
  assert.equal(parseSplineMoveState(OPCODES.SMSG_SPLINE_MOVE_STOP_SWIM, payload).set, false);

  // Every one of the sixteen is a bit and a direction, and each pair undoes the other.
  const pairs = new Map();
  for (const state of SPLINE_MOVE_STATES) {
    const seen = pairs.get(state.flag) ?? [];
    seen.push(state.set);
    pairs.set(state.flag, seen);
  }
  for (const [flag, sets] of pairs) {
    assert.deepEqual(sets.slice().sort(), [false, true], `flag 0x${flag.toString(16)} needs both directions`);
  }
  assert.equal(isSplineMoveState(OPCODES.SMSG_SPLINE_MOVE_ROOT), true);
  assert.equal(isSplineMoveState(OPCODES.SMSG_FORCE_MOVE_ROOT), false, "the player's own root is a different packet");
});

test("a spline speed is the guid and one float, with no counter between them", () => {
  const payload = new PacketWriter().packedGuid(CREATURE).f32(11.5).toUint8Array();
  const speed = parseSplineSpeed(OPCODES.SMSG_SPLINE_SET_RUN_SPEED, payload);
  assert.equal(speed.guid, CREATURE);
  assert.equal(speed.name, "run");
  assert.ok(Math.abs(speed.value - 11.5) < 1e-4);
  // Nine rates share one builder, and two of them are angles rather than distances.
  assert.equal(parseSplineSpeed(OPCODES.SMSG_SPLINE_SET_TURN_RATE, payload).name, "turnRate");
  assert.equal(parseSplineSpeed(OPCODES.SMSG_SPLINE_SET_PITCH_RATE, payload).name, "pitchRate");
  assert.equal(isSplineSpeed(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE), false);
});

test("the flight sync puts its float first, which is the reverse of everything else", () => {
  // `Unit.cpp:557`: WriteSplineSync writes the fraction, and only then is the guid appended.
  const payload = new PacketWriter().f32(0.25).packedGuid(CREATURE).toUint8Array();
  const sync = parseFlightSplineSync(payload);
  assert.equal(sync.guid, CREATURE);
  assert.ok(Math.abs(sync.progress - 0.25) < 1e-6);
  // Reading the guid first would consume the float's bytes as a mask and yield nonsense.
  const wrongWayRound = new PacketWriter().packedGuid(CREATURE).f32(0.25).toUint8Array();
  assert.notEqual(parseFlightSplineSync(wrongWayRound).guid, CREATURE);
});

test("a knock back keeps the cosine first and the vertical speed already negated", () => {
  // `Unit.cpp:13232`: TaggedPosition<Position::XY>(vcos, vsin) writes x then y — cosine, sine —
  // while the echo the server mirrors to everyone else writes sine first. And the last float is
  // built as float(-speedZ), so negating it again sends the character into the floor.
  const payload = new PacketWriter()
    .packedGuid(CREATURE).u32(0).f32(0.6).f32(0.8).f32(12).f32(-7.5)
    .toUint8Array();
  const knockBack = parseKnockBack(payload);
  assert.equal(knockBack.guid, CREATURE);
  assert.ok(Math.abs(knockBack.directionCos - 0.6) < 1e-6);
  assert.ok(Math.abs(knockBack.directionSin - 0.8) < 1e-6);
  assert.ok(Math.abs(knockBack.speedXY - 12) < 1e-6);
  assert.ok(Math.abs(knockBack.speedZ + 7.5) < 1e-6);
});

test("the batched moves a character logs in holding are unpacked one by one", () => {
  // `Player.cpp:23300`: a byte count, then blocks of size, opcode, packed guid, counter — and the
  // size counts the two-byte opcode that follows it, so skipping `size` bytes overruns each block.
  const guid = 0x0000_0000_0000_0042n;
  const block = (opcode) => {
    const body = new PacketWriter().packedGuid(guid).u32(0).toUint8Array();
    return new PacketWriter().u8(2 + body.length).u16(opcode).bytes(body).toUint8Array();
  };
  const first = block(OPCODES.SMSG_FORCE_MOVE_ROOT);
  const second = block(OPCODES.SMSG_MOVE_WATER_WALK);
  const payload = new PacketWriter().u32(first.length + second.length).bytes(first).bytes(second).toUint8Array();
  const moves = parseMultipleMoves(payload);
  assert.equal(moves.length, 2);
  assert.equal(moves[0].opcode, OPCODES.SMSG_FORCE_MOVE_ROOT);
  assert.equal(moves[1].opcode, OPCODES.SMSG_MOVE_WATER_WALK);
  assert.equal(moves[1].guid, guid);
});

test("a refused transfer carries a third field only for three of its reasons", () => {
  // `Player.cpp:23388`: the argument byte is conditional, so a fixed six-byte read throws on
  // every other refusal — and refusals are the packets a player actually sees.
  const full = parseTransferAborted(new PacketWriter().u32(571).u8(8).u8(1).toUint8Array());
  assert.equal(full.mapId, 571);
  assert.equal(full.argument, 1);
  assert.match(full.text, /сложност/i);
  const short = parseTransferAborted(new PacketWriter().u32(30).u8(2).toUint8Array());
  assert.equal(short.argument, undefined);
  assert.match(short.text, /заполнен/i);
});

test("who the client may move arrives packed and is answered full", () => {
  const control = parseClientControlUpdate(new PacketWriter().packedGuid(CREATURE).u8(1).toUint8Array());
  assert.equal(control.guid, CREATURE);
  assert.equal(control.allowed, true);
  assert.equal(parseClientControlUpdate(new PacketWriter().packedGuid(CREATURE).u8(0).toUint8Array()).allowed, false);
});

test("the flight map is a full guid and a mask of one-based node ids", () => {
  // `TaxiHandler.cpp:109`: window, uint64 guid, current node, then a mask whose length is not in
  // the packet at all — it is sized from the row count of TaxiNodes.dbc and read to the end.
  const master = 0xf130_0000_0000_00aan;
  const mask = new PacketWriter().u32(0b1011).u32(1 << 4).toUint8Array();
  const payload = new PacketWriter().u32(1).u64(master).u32(2).bytes(mask).toUint8Array();
  const menu = parseShowTaxiNodes(payload);
  assert.equal(menu.guid, master);
  assert.equal(menu.currentNode, 2);
  // Bit n is node n + 1: nodes are numbered from one, and off by one lights up the wrong towns.
  assert.deepEqual(menu.knownNodes, [1, 2, 4, 37]);

  const status = parseTaxiNodeStatus(new PacketWriter().u64(master).u8(1).toUint8Array());
  assert.equal(status.guid, master);
  assert.equal(status.known, true);
  assert.equal(parseActivateTaxiReply(new PacketWriter().u32(0).toUint8Array()), 0);
});

test("a lockout list widens its instance id to eight bytes", () => {
  // `Player.cpp:19491` writes uint64(save->GetInstanceId()) although the id is a uint32
  // everywhere else. Reading it as a word shifts every following lockout by four bytes.
  const payload = new PacketWriter()
    .u32(2)
    .u32(571).u32(1).u64(4242n).u8(1).u8(0).u32(3600)
    .u32(603).u32(3).u64(77n).u8(1).u8(1).u32(7200)
    .toUint8Array();
  const lockouts = parseRaidInstanceInfo(payload);
  assert.equal(lockouts.length, 2);
  assert.deepEqual(lockouts[0], { mapId: 571, difficulty: 1, instanceId: 4242n, active: true, extended: false, secondsUntilReset: 3600 });
  assert.equal(lockouts[1].mapId, 603, "the second entry only lands here if the first was 22 bytes");
  assert.equal(lockouts[1].extended, true);
});

test("an encounter frame changes shape with its first word", () => {
  // `InstanceScript.cpp:898`: four tails over eight types, and only the first three carry a unit.
  const engage = parseEncounterFrame(new PacketWriter().u32(ENCOUNTER_FRAME_ENGAGE).packedGuid(CREATURE).u8(2).toUint8Array());
  assert.equal(engage.guid, CREATURE);
  assert.equal(engage.param1, 2);
  const objective = parseEncounterFrame(new PacketWriter().u32(ENCOUNTER_FRAME_UPDATE_OBJECTIVE).u8(1).u8(9).toUint8Array());
  assert.equal(objective.guid, undefined);
  assert.equal(objective.param2, 9);
  const phase = parseEncounterFrame(new PacketWriter().u32(ENCOUNTER_FRAME_PHASE_SHIFT_CHANGED).toUint8Array());
  assert.equal(phase.type, ENCOUNTER_FRAME_PHASE_SHIFT_CHANGED);

  // The difficulty pair, whose middle word is a literal one nothing reads.
  const difficulty = parseDungeonDifficulty(new PacketWriter().u32(1).u32(1).u32(1).toUint8Array());
  assert.deepEqual(difficulty, { difficulty: 1, inGroup: true });
  // And the reset failure, whose size hint claims four bytes and whose body is eight.
  assert.deepEqual(parseInstanceResetFailed(new PacketWriter().u32(1).u32(230).toUint8Array()),
    { reason: 1, mapId: 230 });
});

test("the world's own messages decode, weather included", () => {
  const weather = parseWeather(new PacketWriter().u32(WEATHER_MEDIUM_RAIN).f32(0.7).u8(1).toUint8Array());
  assert.equal(weather.state, WEATHER_MEDIUM_RAIN);
  assert.ok(Math.abs(weather.intensity - 0.7) < 1e-6);
  assert.equal(weather.abrupt, true);
  // There is one storm slot of the eight and not one per precipitation type: slot 0 is clear above
  // water, slot 2 is the same place under a storm, and slots 1 and 3 are their underwater pair.
  // A function used to choose one by state and sent rain to slot 1, which is the underwater sky.
  assert.equal(LIGHT_SLOT_CLEAR, 0);
  assert.equal(LIGHT_SLOT_STORM, 2);

  // The banner: a length that counts the string's own bytes, then the string.
  const text = "Вы обнаружили Златолесье";
  const encoded = new TextEncoder().encode(text);
  assert.equal(parseAreaTriggerMessage(new PacketWriter().u32(encoded.length + 1).cString(text).toUint8Array()), text);

  // Three packed guids in a row, so nothing after them sits at a fixed offset.
  const damage = parseBuildingDamage(new PacketWriter()
    .packedGuid(0x0000_0000_0000_0007n).packedGuid(CREATURE).packedGuid(0x0000_0000_0000_0009n)
    .u32(1500).u32(42).toUint8Array());
  assert.equal(damage.attacker, CREATURE);
  assert.equal(damage.damage, 1500);
  assert.equal(damage.spellId, 42);

  const summon = parseSummonRequest(new PacketWriter().u64(CREATURE).u32(12).u32(120_000).toUint8Array());
  assert.deepEqual(summon, { summoner: CREATURE, zoneId: 12, timeoutMilliseconds: 120_000 });
});

test("the spirit healer and the corpse answer with what they carry", () => {
  const timer = parseAreaSpiritHealerTime(new PacketWriter().u64(CREATURE).u32(24_000).toUint8Array());
  assert.deepEqual(timer, { guid: CREATURE, milliseconds: 24_000 });
  const corpse = parseCorpseMapPosition(new PacketWriter().f32(1).f32(2).f32(3).f32(0).toUint8Array());
  assert.deepEqual(corpse, { x: 1, y: 2, z: 3 });
});

test("a passenger is rotated onto the deck, not added to it", () => {
  // `VehicleDefines.h:140`: rotate the offset by the transport's yaw, then translate. The server's
  // own coordinate sanity check adds the two componentwise, and reading that as the transform is
  // right only while the ship faces zero — the error grows with every degree it turns.
  const transport = { x: 100, y: 200, z: 30, orientation: Math.PI / 2 };
  const seat = { guid: 1n, x: 10, y: 0, z: 2, orientation: 0, seat: 0 };
  const world = composePassengerPosition(transport, seat);
  assert.ok(Math.abs(world.x - 100) < 1e-6, "a quarter turn puts a bow offset onto the y axis");
  assert.ok(Math.abs(world.y - 210) < 1e-6);
  assert.ok(Math.abs(world.z - 32) < 1e-6, "height is a plain addition: a boat does not tilt its passengers");
  assert.ok(Math.abs(world.orientation - Math.PI / 2) < 1e-6);

  // And back again, which the core writes with tangents that blow up at due north.
  const north = { x: 0, y: 0, z: 0, orientation: Math.PI / 2 };
  const back = passengerOffset(north, composePassengerPosition(north, seat));
  assert.ok(Math.abs(back.x - 10) < 1e-6 && Math.abs(back.y) < 1e-6 && Math.abs(back.z - 2) < 1e-6);
});

test("a boat carries its passengers between packets, because nothing else will", () => {
  // `Transport::UpdatePassengerPositions` relocates everyone with no network output at all, so a
  // client that only reacts to packets leaves them over the water where the ship used to be.
  const state = new WorldState();
  const boat = 0x0000_0000_0000_0001n;
  const rider = 0x0000_0000_0000_0002n;
  state.move(boat, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  state.move(rider, {
    flags: MOVEMENT_FLAGS.onTransport,
    position: { x: 5, y: 0, z: 1, orientation: 0 },
    transport: { guid: boat, x: 5, y: 0, z: 1, orientation: 0, time: 0, seat: 0 },
  });
  state.updateMotions(performance.now());
  assert.ok(Math.abs(state.objects.get(rider).position.x - 5) < 1e-6);

  // The ship sails and turns; nobody sends a packet about the rider.
  state.move(boat, { flags: 0, position: { x: 300, y: 40, z: 10, orientation: Math.PI } });
  state.updateMotions(performance.now());
  const carried = state.objects.get(rider).position;
  assert.ok(Math.abs(carried.x - 295) < 1e-4, "half a turn puts a bow offset behind the ship");
  assert.ok(Math.abs(carried.y - 40) < 1e-4);
  assert.ok(Math.abs(carried.z - 11) < 1e-4);
});

test("a spline state changes what a unit is doing, which is what the renderer reads", () => {
  const state = new WorldState();
  state.move(CREATURE, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  state.applyMovementFlag(CREATURE, MOVEMENT_FLAGS.swimming, true);
  assert.equal(state.objects.get(CREATURE).movementFlags & MOVEMENT_FLAGS.swimming, MOVEMENT_FLAGS.swimming);
  state.applyMovementFlag(CREATURE, MOVEMENT_FLAGS.swimming, false);
  assert.equal(state.objects.get(CREATURE).movementFlags & MOVEMENT_FLAGS.swimming, 0);
  // A unit nobody has heard of yet is not invented on the strength of a state change.
  state.applyMovementFlag(0xdeadn, MOVEMENT_FLAGS.root, true);
  assert.equal(state.objects.has(0xdeadn), false);

  state.setSpeed(CREATURE, "run", 8.5);
  assert.equal(state.objects.get(CREATURE).runSpeed, 8.5);
  assert.equal(state.objects.get(CREATURE).speeds.get("run"), 8.5);
});

