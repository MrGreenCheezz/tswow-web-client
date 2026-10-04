// 1.17: a teleport within the map (MSG_MOVE_TELEPORT_ACK) is not a map change. The world layer
// applies it in place and replies at once; the browser decides, by distance and by whether the
// destination has streamed in, whether it costs a curtain.
import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { MOVEMENT_FLAGS, readMovementInfo, writeMovementInfoBody } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { classifyTeleport, NEAR_TELEPORT_YARDS } from "../dist/code/browser/game/TeleportKind.js";
import { applySameMapTeleport, handleSameMapTeleport } from "../dist/code/browser/game/TeleportEffects.js";

const SELF = 0x1234n;
const TRANSPORT = 0x1fc0_0000_0000_0042n;

async function client(packets = []) {
  const login = new PacketWriter().u32(0).f32(10).f32(20).f32(30).f32(0).toUint8Array();
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }, ...packets],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    push(opcode, payload) {
      this.packets.push({ opcode, payload });
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting?.(this.packets.shift());
    },
    read() {
      return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise((resolve) => { this.waiting = resolve; });
    },
    close() {},
  };
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  await world.loginCharacter(SELF);
  await settle();
  return { world, connection };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function teleportAck(guid, counter, info) {
  const writer = new PacketWriter().packedGuid(guid).u32(counter);
  writeMovementInfoBody(writer, { flags: 0, flags2: 0, time: 7, fallTime: 0, ...info });
  return writer.toUint8Array();
}

const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

test("an own teleport ACK moves the player in place, reports a same-map teleport and answers once", async () => {
  const { world, connection } = await client();
  const calls = [];
  const changed = [];
  world.onSameMapTeleport = (mapId, destination, origin) => calls.push({
    mapId, destination, origin, acked: sentOf(connection, OPCODES.MSG_MOVE_TELEPORT_ACK).length,
  });
  world.onWorldChanged = (...args) => changed.push(args);
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK,
    teleportAck(SELF, 42, { position: { x: 30, y: 20, z: 31, orientation: 1.5 } }));
  await settle();

  assert.equal(changed.length, 0, "a blink is not a map change");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mapId, 0);
  assert.deepEqual(calls[0].origin, { x: 10, y: 20, z: 30, orientation: 0 });
  assert.deepEqual(calls[0].destination, { x: 30, y: 20, z: 31, orientation: 1.5 });
  assert.equal(calls[0].acked, 1, "the reply is already out when the browser reacts (keys re-issued after it)");
  const self = world.state.objects.get(SELF);
  assert.deepEqual(self.position, { x: 30, y: 20, z: 31, orientation: 1.5 }, "at the destination at once");
  assert.equal(self.glide, undefined, "never glided");

  const acks = sentOf(connection, OPCODES.MSG_MOVE_TELEPORT_ACK);
  assert.equal(acks.length, 1);
  const reader = new PacketReader(acks[0].payload);
  assert.equal(reader.packedGuid(), SELF);
  assert.equal(reader.u32(), 42, "the counter the server sent");
  reader.u32();
  reader.assertFinished();
});

test("without a same-map handler the arrival still reaches onWorldChanged", async () => {
  const { world, connection } = await client();
  const changed = [];
  world.onWorldChanged = (mapId, position) => changed.push({ mapId, position });
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK, teleportAck(SELF, 1, { position: { x: 1, y: 2, z: 3, orientation: 0 } }));
  await settle();
  assert.deepEqual(changed, [{ mapId: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } }]);
});

test("a teleport out of a fall leaves no fall clock or jump in the next acknowledgement", async () => {
  const { world, connection } = await client();
  world.onSameMapTeleport = () => {};
  world.movementReady = true;
  world.sendMovement(OPCODES.MSG_MOVE_JUMP, MOVEMENT_FLAGS.falling, { x: 10, y: 20, z: 32, orientation: 0 },
    { fallTime: 400, jump: { velocity: 7.9, sinAngle: 0, cosAngle: 1, speed: 7 } });
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK, teleportAck(SELF, 3, { position: { x: 40, y: 20, z: 30, orientation: 0 } }));
  await settle();
  connection.push(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, new PacketWriter().packedGuid(SELF).u32(4).u8(0).f32(14).toUint8Array());
  await settle();
  const [ack] = sentOf(connection, OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK);
  assert.ok(ack, "the speed change is acknowledged");
  const reader = new PacketReader(ack.payload);
  reader.packedGuid();
  reader.u32();
  const echoed = readMovementInfo(reader);
  assert.equal(echoed.fallTime ?? 0, 0, "SetFallInformation(0, z) already ran on the server");
  assert.equal(echoed.jump, undefined);
  assert.deepEqual([echoed.position.x, echoed.position.y], [40, 20]);
});

test("a teleport drops the player's running spline without a SPLINE_DONE", async () => {
  const spline = new PacketWriter().packedGuid(SELF).u8(0)
    .f32(10).f32(20).f32(30).u32(77).u8(0)
    .u32(0).u32(1000).u32(1).f32(60).f32(20).f32(30).toUint8Array();
  const { world, connection } = await client([{ opcode: OPCODES.SMSG_MONSTER_MOVE, payload: spline }]);
  world.onSameMapTeleport = () => {};
  assert.ok(world.state.objects.get(SELF).motion, "the charge is running");
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK, teleportAck(SELF, 5, { position: { x: 100, y: 20, z: 30, orientation: 0 } }));
  await settle();
  assert.equal(world.state.objects.get(SELF).motion, undefined);
  world.state.updateMotions(performance.now() + 5_000);
  assert.equal(sentOf(connection, OPCODES.CMSG_MOVE_SPLINE_DONE).length, 0, "Unit::NearTeleportTo disabled it");
  assert.deepEqual([world.state.objects.get(SELF).position.x], [100]);
});

test("a teleport releases an open loot window, as Wow.exe does", async () => {
  const { world, connection } = await client();
  world.onSameMapTeleport = () => {};
  world.loot = { guid: 0xf130_0000_0000_0abcn, lootType: 1, gold: 0, slots: [] };
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK, teleportAck(SELF, 6, { position: { x: 11, y: 20, z: 30, orientation: 0 } }));
  await settle();
  assert.equal(world.loot, undefined);
  const released = sentOf(connection, OPCODES.CMSG_LOOT_RELEASE);
  assert.equal(released.length, 1);
  assert.equal(new PacketReader(released[0].payload).u64(), 0xf130_0000_0000_0abcn);
  // Order on the wire: the reply to the teleport is not held back by the loot release.
  assert.equal(sentOf(connection, OPCODES.MSG_MOVE_TELEPORT_ACK).length, 1);
});

test("a teleport within a transport keeps the new seat offset and the world position", async () => {
  const { world, connection } = await client();
  world.onSameMapTeleport = () => {};
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK, teleportAck(SELF, 8, {
    flags: MOVEMENT_FLAGS.onTransport,
    position: { x: 500, y: 600, z: 10, orientation: 0 },
    transport: { guid: TRANSPORT, x: 1, y: 2, z: 3, orientation: 0.5, time: 9, seat: -1 },
  }));
  await settle();
  const self = world.state.objects.get(SELF);
  assert.deepEqual(self.position, { x: 500, y: 600, z: 10, orientation: 0 });
  assert.equal(self.transport?.guid, TRANSPORT);
  assert.deepEqual([self.transport.x, self.transport.y, self.transport.z], [1, 2, 3]);
});

test("somebody else's ACK is answered but never moves the player or reports a teleport", async () => {
  const { world, connection } = await client();
  const calls = [];
  world.onSameMapTeleport = (...args) => calls.push(args);
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK, teleportAck(0x9999n, 9, { position: { x: 1, y: 1, z: 1, orientation: 0 } }));
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(world.state.objects.get(SELF).position, { x: 10, y: 20, z: 30, orientation: 0 });
  assert.equal(sentOf(connection, OPCODES.MSG_MOVE_TELEPORT_ACK).length, 1);
});

test("a teleport ACK for a controlled vehicle snaps that unit in place and is answered", async () => {
  // Unit::NearTeleportTo on a client-moved creature (a vehicle, a mind-controlled mob) sends the ACK
  // to the controller and relocates the unit server-side at once (Unit.cpp:14046-14058); the core's
  // HandleMoveTeleportAck then returns for a non-player mover. Left where it was, the vehicle's next
  // movement packet would carry the old position back.
  const VEHICLE = 0xf150_0000_0000_0777n;
  const { world, connection } = await client();
  const calls = [];
  world.onSameMapTeleport = (...args) => calls.push(args);
  world.state.move(VEHICLE, { flags: 0, position: { x: 1, y: 1, z: 1, orientation: 0 } });
  connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK,
    teleportAck(VEHICLE, 4, { position: { x: 90, y: 80, z: 7, orientation: 2 } }));
  await settle();
  assert.deepEqual(world.state.objects.get(VEHICLE).position, { x: 90, y: 80, z: 7, orientation: 2 });
  assert.equal(world.state.objects.get(VEHICLE).glide, undefined, "never glided");
  assert.equal(calls.length, 0, "the player did not move");
  assert.equal(sentOf(connection, OPCODES.MSG_MOVE_TELEPORT_ACK).length, 1);
});

test("MSG_MOVE_TELEPORT naming the player takes the same path, without a reply", async () => {
  const { world, connection } = await client();
  const calls = [];
  world.onSameMapTeleport = (mapId, destination, origin) => calls.push({ destination, origin });
  const relay = new PacketWriter().packedGuid(SELF);
  writeMovementInfoBody(relay, { flags: 0, flags2: 0, time: 1, position: { x: 12, y: 20, z: 30, orientation: 0 }, fallTime: 0 });
  connection.push(OPCODES.MSG_MOVE_TELEPORT, relay.toUint8Array());
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin.x, 10);
  assert.equal(sentOf(connection, OPCODES.MSG_MOVE_TELEPORT_ACK).length, 0);
});

const at = (x, y = 0, z = 0) => ({ x, y, z, orientation: 0 });

test("near is at most 150 yards, in three dimensions, from a known origin onto ready ground", () => {
  assert.equal(NEAR_TELEPORT_YARDS, 150);
  assert.equal(classifyTeleport({ origin: at(0), destination: at(20), destinationReady: true }), "near");
  assert.equal(classifyTeleport({ origin: at(0), destination: at(20), destinationReady: false }), "far");
  assert.equal(classifyTeleport({ origin: at(0), destination: at(400), destinationReady: true }), "far");
  assert.equal(classifyTeleport({ origin: undefined, destination: at(1), destinationReady: true }), "far");
  assert.equal(classifyTeleport({ origin: at(0), destination: at(150), destinationReady: true }), "near");
  assert.equal(classifyTeleport({ origin: at(0), destination: at(150.1), destinationReady: true }), "far");
  assert.equal(classifyTeleport({ origin: at(0), destination: at(0, 0, 150.1), destinationReady: true }), "far",
    "Wow.exe measures the height too");
});

function spies() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const effects = Object.fromEntries([
    "resetCharacterMotion", "refreshCollision", "spellVisualsWorldChanged", "showLoadingScreen", "clearHeldKeys",
    "invalidateGroundCover", "clearPortraitTargets", "refreshUnitFrames", "refreshMinimapZone", "reissueHeldMovement",
  ].map((name) => [name, record(name)]));
  return { calls, effects, names: () => calls.map(([name]) => name) };
}

test("a near teleport drops the arc, asks for collision and re-issues held keys; curtain and frames stay", () => {
  const { effects, calls, names } = spies();
  applySameMapTeleport(effects, "near", 1, at(5, 6, 7));
  // Wow.exe re-sends whatever is held once the ACK is out (0x007413F0 case 199 → 0x005FBBC0):
  // Player::TeleportTo cleared the server's movement flags, so W held through a blink is a START again.
  assert.deepEqual(names(), ["resetCharacterMotion", "refreshCollision", "reissueHeldMovement"]);
  assert.deepEqual(calls[1], ["refreshCollision", 1, 5, 6]);
});

test("a far teleport brings the curtain and releases keys but keeps the map's collision, bosses and music", () => {
  const { effects, names } = spies();
  applySameMapTeleport(effects, "far", 1, at(5, 6, 7));
  assert.ok(names().includes("showLoadingScreen"));
  assert.ok(names().includes("clearHeldKeys"));
  assert.ok(names().includes("refreshUnitFrames"));
  assert.ok(names().includes("refreshMinimapZone"));
  assert.equal(names().filter((name) => name === "resetCharacterMotion").length, 1);
  assert.ok(!names().includes("reissueHeldMovement"), "the keys are released behind the curtain instead");
});

test("the handler classifies with the destination's readiness and returns the kind", () => {
  const { effects, names } = spies();
  const asked = [];
  const handler = { ...effects, destinationReady: (mapId, x, y) => { asked.push([mapId, x, y]); return true; } };
  assert.equal(handleSameMapTeleport(handler, 530, at(20, 0, 0), at(0)), "near");
  assert.deepEqual(asked, [[530, 20, 0]]);
  assert.deepEqual(names(), ["resetCharacterMotion", "refreshCollision", "reissueHeldMovement"]);
  const far = spies();
  assert.equal(handleSameMapTeleport({ ...far.effects, destinationReady: () => false }, 530, at(20), at(0)), "far");
  assert.ok(far.names().includes("showLoadingScreen"));
});

// ---- the browser's wiring (EnterWorld.ts, Minimap.ts) -------------------------------------------

test("EnterWorld answers onSameMapTeleport through handleSameMapTeleport with the loading screen's readiness", async () => {
  const { readFile } = await import("node:fs/promises");
  const enter = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  const start = enter.indexOf("world.onSameMapTeleport = (mapId, destination, origin) => {");
  assert.ok(start > 0, "the handler is assigned");
  const block = enter.slice(start, enter.indexOf("\n  };", start));
  assert.match(block, /if \(game\.world !== world\) return;/, "a retired world's teleport does nothing");
  assert.match(block, /handleSameMapTeleport\(\{/);
  assert.match(block, /game\.terrain\?\.isReady\(map, x, y\) === true\s*&& game\.collision\?\.isReady\(map, x, y\) === true/,
    "near only onto terrain and collision that have both answered");
  for (const effect of ["resetCharacterMotion", "refreshCollision", "reissueHeldMovement", "spellVisualsWorldChanged",
    "showLoadingScreen", "clearHeldKeys", "invalidateGroundCover", "clearPortraitTargets"]) {
    assert.match(block, new RegExp(`\\b${effect}\\b`), effect);
  }
  assert.match(block, /refreshUnitFrames: \(\) => showUnitFrames\(\)/, "redraw, not forget, the encounter");
  assert.match(block, /refreshMinimapZone: forgetMinimapZone/);
  for (const never of ["collision?.reset(", "forgetUnitFrames(", "stopMusic(", "forgetZoneSound(", "forgetMinimap("]) {
    assert.ok(!block.includes(never), `a same-map teleport never calls ${never}`);
  }

  const names = enter.slice(enter.indexOf("world.worldNames = worldNameSources({"));
  const call = names.slice(0, names.indexOf("\n    });"));
  assert.match(call, /spell: \(id\) => \{/, "spells are named from the session's rows");
  assert.match(call, /ensureSpellNames\(\[id\]\)/, "and a missing row is asked for");
  assert.match(call, /map: \(id\) => areas\.map\(id\)\?\.name/, "maps from Map.dbc");

  const minimap = await readFile(new URL("../src/browser/ui/Minimap.ts", import.meta.url), "utf8");
  const forget = minimap.slice(minimap.indexOf("export function forgetMinimapZone(): void {"));
  const body = forget.slice(0, forget.indexOf("\n}"));
  assert.match(body, /zoneAreaId = 0;/);
  assert.match(body, /zoneCheckedAt = 0;/, "the next frame re-reads the zone");
  assert.ok(!body.includes("hidden") && !body.includes("pings"), "the frame and its pings stay");
});
