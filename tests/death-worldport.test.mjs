import assert from "node:assert/strict";
import test from "node:test";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

function connection(corpseReply) {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload) {
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume({ opcode, payload });
      } else queue.push({ opcode, payload });
    },
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload = new Uint8Array()) {
      this.sent.push({ opcode, payload });
      // The selected core handles WORLDPORT_ACK synchronously before the next packet in this
      // session. QueryHandler then answers from the new map; model that order, not a forced reply.
      if (opcode === OPCODES.MSG_CORPSE_QUERY) this.push(OPCODES.MSG_CORPSE_QUERY, corpseReply);
    },
    close() {},
  };
}

async function settle() {
  for (let index = 0; index < 6; index++) await new Promise(setImmediate);
}

test("a ghost worldport refreshes an entrance-projected corpse after ACK", async () => {
  const guid = 0x1234n;
  const newMap = 571;
  // On a dungeon entry the selected core resurrects the ghost and removes its corpse in
  // HandleMoveWorldportAck; querying after ACK therefore reports no corpse.
  const transport = connection(new PacketWriter().u8(0).toUint8Array());
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  world.state.selfGuid = guid;
  world.state.move(guid, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  world.state.setField(guid, UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x10);
  world.corpse = { found: true, mapId: 0, x: 10, y: 20, z: 30, corpseMapId: newMap };
  try {
    await world.loginCharacter(guid);
    transport.push(OPCODES.SMSG_NEW_WORLD,
      new PacketWriter().u32(newMap).f32(80).f32(90).f32(100).f32(0).toUint8Array());
    await settle();

    const worldportPackets = transport.sent.map((packet) => packet.opcode)
      .filter((opcode) => opcode === OPCODES.MSG_MOVE_WORLDPORT_ACK || opcode === OPCODES.MSG_CORPSE_QUERY);
    assert.deepEqual(worldportPackets, [OPCODES.MSG_MOVE_WORLDPORT_ACK, OPCODES.MSG_CORPSE_QUERY],
      "the corpse query must run after the server has switched the player's map");
    assert.equal(world.corpse?.found, false, "old entrance coordinates cannot survive the map transition");
  } finally { world.close(); }
});

test("a ghost changing non-instance maps receives corpse coordinates for the destination map", async () => {
  const guid = 0x1234n;
  const corpseReply = new PacketWriter().u8(1).i32(1).f32(80).f32(90).f32(100).i32(1).u32(0)
    .toUint8Array();
  const transport = connection(corpseReply);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  world.state.selfGuid = guid;
  world.state.move(guid, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  world.state.setField(guid, UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x10);
  world.corpse = { found: true, mapId: 0, x: 10, y: 20, z: 30, corpseMapId: 1 };
  try {
    await world.loginCharacter(guid);
    transport.push(OPCODES.SMSG_NEW_WORLD,
      new PacketWriter().u32(1).f32(5).f32(6).f32(7).f32(0).toUint8Array());
    await settle();
    assert.deepEqual(world.corpse, { found: true, mapId: 1, x: 80, y: 90, z: 100, corpseMapId: 1 });
  } finally { world.close(); }
});

test("a player resurrection offer queries its unnamed caster once", async () => {
  const guid = 0x1234n;
  const casterGuid = 0x5678n;
  const transport = connection(new PacketWriter().u8(0).toUint8Array());
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  try {
    await world.loginCharacter(guid);
    const offer = new PacketWriter().u64(casterGuid).u32(1).cString("").u8(0).u8(1).toUint8Array();
    transport.push(OPCODES.SMSG_RESURRECT_REQUEST, offer);
    await settle();

    const queries = transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_NAME_QUERY);
    assert.equal(queries.length, 1);
    assert.equal(new DataView(queries[0].payload.buffer, queries[0].payload.byteOffset).getBigUint64(0, true), casterGuid);
    assert.equal(world.resurrectRequest?.casterName, "", "the UI must resolve the name from the GUID");
  } finally { world.close(); }
});
