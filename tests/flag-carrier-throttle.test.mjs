import assert from "node:assert/strict";
import test from "node:test";

import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { STATUS_IN_PROGRESS, STATUS_WAIT_QUEUE } from "../dist/code/world/PvpProtocol.js";

// Stock UIParent's OnUpdate calls RequestBattlefieldPositions(elapsed) on every rendered frame
// (UIParent.xml:25). On 2026-09-28 each call was a MSG_BATTLEGROUND_PLAYER_POSITIONS: 99,217 of them
// in 33 minutes outside any battleground, 143 in the busiest second, past the core's AntiDOS limit
// of 100 an opcode a second. The core answers only a player in a battleground
// (BattleGroundHandler.cpp:267-269), so the poll belongs there, once a second.

function connection() {
  const packets = [];
  const sent = [];
  let wake;
  return {
    sent,
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const resolve = wake; wake = undefined; resolve(packet); }
      else packets.push(packet);
    },
    read() { return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    close() {},
  };
}

async function settle() { for (let index = 0; index < 6; index++) await new Promise(setImmediate); }

async function worldFixture() {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  await world.loginCharacter(1n);
  await settle();
  const polls = () => transport.sent.filter(({ opcode }) => opcode === OPCODES.MSG_BATTLEGROUND_PLAYER_POSITIONS).length;
  return { world, transport, polls };
}

// BattlegroundMgr::BuildBattlegroundStatusPacket, as bg-match-lifecycle.test.mjs builds it.
function status(slot, state, { bgTypeId = 2, instance = 17, mapId = 489, arena = false } = {}) {
  const writer = new PacketWriter().u32(slot)
    .u8(arena ? 3 : 0).u8(arena ? 0x0e : 0).u32(bgTypeId).u16(0x1f90)
    .u8(10).u8(80).u32(instance).u8(0).u32(state);
  if (state === STATUS_IN_PROGRESS) writer.u32(mapId).u64(0n).u32(0).u32(10_000).u8(1);
  else if (state === STATUS_WAIT_QUEUE) writer.u32(1_000).u32(500);
  return writer.toUint8Array();
}

const cleared = (slot) => new PacketWriter().u32(slot).u64(0n).toUint8Array();

/** A minute of UIParent frames at 144 Hz, each asking once, from `start` milliseconds. */
function everyFrame(world, start, seconds = 60) {
  for (let frame = 0; frame < 144 * seconds; frame++) world.requestFlagCarriers(start + frame * 1000 / 144);
}

test("outside a battleground match the flag-carrier poll never reaches the wire", async () => {
  const { world, transport, polls } = await worldFixture();
  try {
    everyFrame(world, 0);
    assert.equal(polls(), 0, "no queue at all: the core would drop every one unanswered");
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(0, STATUS_WAIT_QUEUE));
    await settle();
    everyFrame(world, 60_000);
    assert.equal(polls(), 0, "queued is not playing");
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(1, STATUS_IN_PROGRESS, { bgTypeId: 6, arena: true, mapId: 559 }));
    await settle();
    everyFrame(world, 120_000);
    assert.equal(polls(), 0, "an arena has no flags");
  } finally { world.close(); }
});

test("inside a battleground it goes out once a second, at once in a new match, and stops when it ends", async () => {
  const { world, transport, polls } = await worldFixture();
  try {
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(0, STATUS_IN_PROGRESS));
    await settle();
    everyFrame(world, 10_000, 3);
    assert.equal(polls(), 3, "432 frames over three seconds: one request a second");
    // Frame 431 asked at 12,993 ms; the last request went at 12,000. A different instance is a new
    // match, whose carriers are asked for on the next call rather than a second later.
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(0, STATUS_IN_PROGRESS, { instance: 18 }));
    await settle();
    world.requestFlagCarriers(12_995);
    assert.equal(polls(), 4);
    world.requestFlagCarriers(13_000);
    assert.equal(polls(), 4, "and then once a second again");
    const [request] = transport.sent.filter(({ opcode }) => opcode === OPCODES.MSG_BATTLEGROUND_PLAYER_POSITIONS);
    assert.equal(request.payload.length, 0, "HandleBattlegroundPlayerPositionsOpcode reads nothing");
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, cleared(0));
    await settle();
    everyFrame(world, 20_000, 2);
    assert.equal(polls(), 4, "the match is over");
  } finally { world.close(); }
});
