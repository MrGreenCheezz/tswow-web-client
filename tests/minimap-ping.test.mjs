import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { fakeWorldConnection, loginVerifyWorldPacket, settle } from "./fixtures/world-packets.mjs";

/*
 * 7.57 (11.11): Minimap:PingLocation as Wow.exe 0x0057ed70 sends and raises it — MSG_MINIMAP_PING only in a party
 * or raid, then MINIMAP_PING for the player's own guid in any case (0x0057eb80), because TrinityCore's relay
 * (GroupHandler.cpp HandleMinimapPingOpcode, BroadcastPacket with the pinger ignored) never returns it.
 * Notes: .runtime/re-2026-11-11/minimap/ping.c, ping2.c.
 */

const SELF = 0x1234n;
const MATE = 0x5678n;

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  await world.loginCharacter(SELF);
  await settle();
  const pings = [];
  world.events.on("MINIMAP_PING", (ping) => pings.push(ping));
  return { world, connection, pings };
}

function f32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return bytes;
}

test("3.13: SMSG_DEATH_RELEASE_LOC on this map sets the spirit healer mark; map −1 at the origin clears it", async () => {
  const { world, connection } = await client();
  const release = (mapId, x, y) => {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setInt32(0, mapId, true);
    view.setFloat32(4, x, true);
    view.setFloat32(8, y, true);
    connection.push(OPCODES.SMSG_DEATH_RELEASE_LOC, payload);
  };
  release(0, -9000.5, 400.25);
  await settle();
  assert.deepEqual(world.spiritHealerMark, { x: -9000.5, y: 400.25 });
  release(1, 5, 5);
  await settle();
  assert.deepEqual(world.spiritHealerMark, { x: -9000.5, y: 400.25 }, "another map leaves it");
  release(-1, 0, 0);
  await settle();
  assert.equal(world.spiritHealerMark, undefined);
});

test("alone, a ping sends nothing and is still raised for the player", async () => {
  const { world, connection, pings } = await client();
  world.pingMinimap(-8913.5, 554.25);
  assert.equal(connection.sentOf(OPCODES.MSG_MINIMAP_PING).length, 0, "no packet outside a group");
  assert.deepEqual(pings, [{ guid: SELF, x: -8913.5, y: 554.25 }]);
});

test("in a group the packet goes out with the two floats, and the event follows it", async () => {
  const { world, connection, pings } = await client();
  world.group = { groupType: 0, members: [{ guid: MATE }] };
  world.pingMinimap(-8913.5, 554.1);
  const sent = connection.sentOf(OPCODES.MSG_MINIMAP_PING);
  assert.equal(sent.length, 1);
  assert.deepEqual([...sent[0].payload], [...f32(-8913.5), ...f32(554.1)]);
  assert.equal(pings.length, 1);
  assert.equal(pings[0].guid, SELF);
  assert.equal(pings[0].y, Math.fround(554.1), "the event carries the floats the packet carries");

  // A party member's ping comes back from the server with their guid in front.
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, MATE, true);
  view.setFloat32(8, 1.5, true);
  view.setFloat32(12, -2.5, true);
  connection.push(OPCODES.MSG_MINIMAP_PING, payload);
  await settle();
  assert.deepEqual(pings.at(-1), { guid: MATE, x: 1.5, y: -2.5 });
});
