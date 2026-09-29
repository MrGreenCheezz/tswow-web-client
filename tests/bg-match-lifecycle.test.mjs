import assert from "node:assert/strict";
import test from "node:test";

import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { STATUS_IN_PROGRESS, STATUS_WAIT_QUEUE } from "../dist/code/world/PvpProtocol.js";

function connection() {
  const packets = [];
  let wake;
  return {
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const resolve = wake; wake = undefined; resolve(packet); }
      else packets.push(packet);
    },
    read() { return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send() {}, close() {},
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
  return { world, transport };
}

function status(slot, state, { bgTypeId = 2, instance = 17, mapId = 489, arena = false } = {}) {
  const writer = new PacketWriter().u32(slot)
    .u8(arena ? 3 : 0).u8(arena ? 0x0e : 0).u32(bgTypeId).u16(0x1f90)
    .u8(10).u8(80).u32(instance).u8(0).u32(state);
  if (state === STATUS_IN_PROGRESS) writer.u32(mapId).u64(0n).u32(0).u32(10_000).u8(1);
  else if (state === STATUS_WAIT_QUEUE) writer.u32(1_000).u32(500);
  return writer.toUint8Array();
}

const cleared = (slot) => new PacketWriter().u32(slot).u64(0n).toUint8Array();
const emptyScore = () => new PacketWriter().u8(0).u8(0).u32(0).toUint8Array();
const carrier = () => new PacketWriter().u32(0).u32(1).u64(99n).f32(1).f32(2).toUint8Array();

test("authoritative match departure clears scoreboard, carriers and roster but not another queue", async () => {
  const { world, transport } = await worldFixture();
  try {
    const updates = [];
    world.events.on("PVP_SCOREBOARD_CHANGED", (event) => updates.push(event));
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(0, STATUS_IN_PROGRESS));
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(1, STATUS_WAIT_QUEUE, { bgTypeId: 3 }));
    transport.push(OPCODES.MSG_PVP_LOG_DATA, emptyScore());
    transport.push(OPCODES.MSG_BATTLEGROUND_PLAYER_POSITIONS, carrier());
    transport.push(OPCODES.SMSG_BATTLEGROUND_PLAYER_JOINED, new PacketWriter().u64(77n).toUint8Array());
    await settle();
    assert.ok(world.pvpScores);
    assert.equal(world.flagCarriers.length, 1);
    assert.equal(world.battlegroundPlayers.has(77n), true);

    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(0, STATUS_IN_PROGRESS));
    await settle();
    assert.ok(world.pvpScores, "an in-progress status refresh is still the same match");

    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, cleared(1));
    await settle();
    assert.ok(world.pvpScores, "clearing a different queue must preserve the active match");
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, cleared(0));
    await settle();
    assert.equal(world.pvpScores, undefined);
    assert.deepEqual(world.flagCarriers, []);
    assert.equal(world.battlegroundPlayers.size, 0);
    assert.ok(updates.length >= 2, "a visible scoreboard must be notified when its match ends");
  } finally { world.close(); }
});

test("a newly entered arena cannot inherit the previous battleground scoreboard", async () => {
  const { world, transport } = await worldFixture();
  try {
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, status(0, STATUS_IN_PROGRESS));
    transport.push(OPCODES.MSG_PVP_LOG_DATA, emptyScore());
    transport.push(OPCODES.MSG_BATTLEGROUND_PLAYER_POSITIONS, carrier());
    await settle();
    assert.ok(world.pvpScores);
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS,
      status(1, STATUS_IN_PROGRESS, { bgTypeId: 6, arena: true, mapId: 559 }));
    await settle();
    assert.equal(world.pvpScores, undefined,
      "the core refuses score queries inside an arena until the match ends");
    assert.deepEqual(world.flagCarriers, []);
  } finally { world.close(); }
});
