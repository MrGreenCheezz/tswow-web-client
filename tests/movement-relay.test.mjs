import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import {
  RELAY_SPEEDS, RELAY_STATE_OPCODES, isMovementRelaySpeed, parseMovementRelayKnockBack,
  parseMovementRelaySpeed, parseMovementTimeSkipped,
} from "../dist/code/world/MovementRelayProtocol.js";
import { parseMovementPacket } from "../dist/code/world/MovementProtocol.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { INBOUND_OPCODES } from "../dist/code/generated/opcodeCoverage.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u16 = (value) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, true);
  return out;
};
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const f32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
};
const packed = (value) => {
  const body = [];
  let mask = 0;
  for (let index = 0; index < 8; index++) {
    const byte = Number((value >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      body.push(byte);
    }
  }
  return bytes(u8(mask), Uint8Array.from(body));
};

const NEIGHBOUR = 0x0000_0000_0000_2a05n;

/**
 * A bare MovementInfo: no flags set, so none of the optional blocks follow it — but the fall time
 * is not optional and closes every one of them.
 */
function movementInfo({ x = 100, y = 200, z = 50, orientation = 1 } = {}) {
  return bytes(u32(0), u16(0), u32(1_000), f32(x), f32(y), f32(z), f32(orientation), u32(0));
}

test("a speed relay carries a whole movement info where its two twins carry none", () => {
  // SMSG_FORCE_RUN_SPEED_CHANGE is guid, counter, spare byte, float; SMSG_SPLINE_SET_RUN_SPEED is
  // guid and float. This one puts thirty bytes of movement info in between, and all three end in a
  // float — so the wrong layout still finds a plausible-looking speed.
  const payload = bytes(packed(NEIGHBOUR), movementInfo(), f32(14));
  const relay = parseMovementRelaySpeed(OPCODES.MSG_MOVE_SET_RUN_SPEED, payload);
  assert.equal(relay.guid, NEIGHBOUR);
  assert.equal(relay.name, "run");
  assert.equal(relay.value, 14, "absolute yards a second, never a multiplier");
  assert.equal(relay.movement.position.x, 100);

  const pitch = parseMovementRelaySpeed(OPCODES.MSG_MOVE_SET_PITCH_RATE, bytes(packed(NEIGHBOUR), movementInfo(), f32(3.14)));
  assert.equal(pitch.name, "pitchRate", "two of the nine are radians a second");

  assert.equal(isMovementRelaySpeed(OPCODES.MSG_MOVE_SET_WALK_SPEED), true);
  assert.equal(isMovementRelaySpeed(OPCODES.MSG_MOVE_HEARTBEAT), false);
  assert.throws(() => parseMovementRelaySpeed(OPCODES.MSG_MOVE_HEARTBEAT, payload), /not a movement speed relay/);
});

test("all nine speeds relay, and they name the same speeds the spline family does", () => {
  assert.equal(RELAY_SPEEDS.length, 9);
  const names = RELAY_SPEEDS.map((entry) => entry.name);
  assert.deepEqual(names, [
    "walk", "run", "runBack", "swim", "swimBack", "turnRate", "flight", "flightBack", "pitchRate",
  ]);
  // A speed set through the relay has to land in the same store slot as one set through a spline,
  // or a unit that changes hands between server and player control would keep two speeds.
  //
  // `setSpeed` drops a speed for a unit the store has never seen, which is why the relay applies
  // its movement info first: the packet carries one, and it is what puts the unit in the store.
  const state = new WorldState();
  for (const { name } of RELAY_SPEEDS) state.setSpeed(NEIGHBOUR, name, 7);
  assert.equal(state.objects.get(NEIGHBOUR), undefined, "nothing to attach a speed to yet");

  const relay = parseMovementRelaySpeed(OPCODES.MSG_MOVE_SET_FLIGHT_BACK_SPEED, bytes(packed(NEIGHBOUR), movementInfo(), f32(7)));
  state.move(relay.guid, relay.movement);
  state.setSpeed(relay.guid, relay.name, relay.value);
  assert.equal(state.objects.get(NEIGHBOUR).speeds.get("flightBack"), 7);
});

test("the knock-back relay writes sine first, and the packet to the victim writes cosine first", () => {
  const payload = bytes(packed(NEIGHBOUR), movementInfo(), f32(0.5), f32(0.75), f32(20), f32(9));
  const relay = parseMovementRelayKnockBack(payload);
  assert.equal(relay.directionSin, 0.5, "HandleMoveKnockBackAck writes jump.sinAngle first");
  assert.equal(relay.directionCos, 0.75);
  assert.equal(relay.speedXY, 20);
  assert.equal(relay.speedZ, 9, "echoed from the victim's own acknowledgement, not negated here");
});

test("a time skip moves nobody", () => {
  const skipped = parseMovementTimeSkipped(bytes(packed(NEIGHBOUR), u32(2_500)));
  assert.deepEqual(skipped, { guid: NEIGHBOUR, skipped: 2_500 });
});

test("a teleport snaps where an ordinary move glides", () => {
  // GLIDE_SNAP_DISTANCE is 25 yards, and a blink is about 20 — so a teleport routed through `move`
  // would be smoothed, and the mage would slide across the ground instead of vanishing.
  const state = new WorldState();
  const start = parseMovementPacket(bytes(packed(NEIGHBOUR), movementInfo({ x: 100, y: 200 })));
  state.move(NEIGHBOUR, start);
  const near = parseMovementPacket(bytes(packed(NEIGHBOUR), movementInfo({ x: 118, y: 200 })));

  state.move(NEIGHBOUR, near);
  assert.notEqual(state.objects.get(NEIGHBOUR).glide, undefined, "a short step is smoothed");
  assert.equal(state.objects.get(NEIGHBOUR).position.x, 100, "and the position has not moved yet");

  state.teleport(NEIGHBOUR, near);
  assert.equal(state.objects.get(NEIGHBOUR).glide, undefined);
  assert.equal(state.objects.get(NEIGHBOUR).position.x, 118, "a teleport is there at once");
});

test("the four relays with no sender are named and not parsed", () => {
  // Each appears exactly once outside the opcode tables, inside the commented-out `//!` mapping
  // table at the top of MovementPacketSender.h. The reference scan cannot tell a comment from
  // code, which is the only reason the coverage report calls them live.
  for (const name of [
    "MSG_MOVE_ROOT", "MSG_MOVE_UNROOT", "MSG_MOVE_SET_COLLISION_HGT",
    "MSG_MOVE_UPDATE_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY",
  ]) {
    assert.equal(INBOUND_OPCODES.get(name), "live", `${name} is what the report believes`);
  }
});

test("the three state relays joined the ordinary movement set", () => {
  assert.deepEqual([...RELAY_STATE_OPCODES], [
    OPCODES.MSG_MOVE_FEATHER_FALL, OPCODES.MSG_MOVE_WATER_WALK, OPCODES.MSG_MOVE_UPDATE_CAN_FLY,
  ]);
  // Same shape as MSG_MOVE_HOVER, which was already handled: packed guid then a movement info.
  const parsed = parseMovementPacket(bytes(packed(NEIGHBOUR), movementInfo({ z: 77 })));
  assert.equal(parsed.guid, NEIGHBOUR);
  assert.equal(parsed.position.z, 77);
});

test("the dead-opcode list covers every dead opcode and nothing else", async () => {
  const document = await readFile(
    join(projectRoot, "src", "generated", "protocol-data", "dead-opcodes.md"),
    "utf8",
  );
  const listed = new Set([...document.matchAll(/^\* `([A-Z_0-9]+)`$/gm)].map((match) => match[1]));
  const dead = [...INBOUND_OPCODES].filter(([, kind]) => kind === "dead").map(([name]) => name);

  assert.deepEqual(
    dead.filter((name) => !listed.has(name)),
    [],
    "the ignored protocol-data/dead-opcodes.md report is stale; run npm run deadopcodes:generate",
  );
  assert.deepEqual([...listed].filter((name) => INBOUND_OPCODES.get(name) !== "dead"), []);
  assert.equal(listed.size, dead.length, "and every opcode is listed exactly once");
});
