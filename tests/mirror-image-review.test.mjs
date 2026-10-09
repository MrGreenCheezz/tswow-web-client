import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { MirrorImages, UNIT_FLAG2_MIRROR_IMAGE } from "../dist/code/world/MirrorImages.js";
import { parseMirrorImageData } from "../dist/code/world/SpellLogProtocol.js";
import { mirrorImageModelFor } from "../dist/code/browser/MirrorImageModel.js";

/*
 * 05.10 review H of 6.11б (SMSG_MIRRORIMAGE_DATA). NPCBots carry UNIT_FLAG2_MIRROR_IMAGE from their
 * template (bot_ai.cpp:445-451) and keep it in every form: a druid bot's bear form, a hexed or
 * polymorphed bot and the bot's "update visual" trick (spell 24753, SPELL_AURA_TRANSFORM to creature
 * 15219 for 500 ms, bot_ai.cpp:8710-8718) all move UNIT_FIELD_DISPLAYID off the character display,
 * and the core's reply then names that display (`bot->GetDisplayId()`, SpellHandler.cpp:661-663).
 */

function reply({ guid, displayId = 49, race = 1, gender = 0, classId = 1 } = {}) {
  const bytes = new Uint8Array(68);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, guid, true);
  view.setUint32(8, displayId, true);
  bytes.set([race, gender, classId, 1, 1, 1, 1, 1], 12);
  return bytes;
}

test("review H: a reply naming a non-character display (a druid bot in bear form) does not dress it", () => {
  const appearance = { body: [], geosets: [0], attached: [], hair: "", cloak: "" };
  const calls = [];
  const creatureModels = { generation: 1, playerAppearance: (...args) => { calls.push(args); return appearance; } };
  // A bear display: the gateway gives a non-`Character\` model no baked appearance.
  const bear = { id: 2281, model: "Creature\\DruidBear\\DruidBear.m2", scale: 1, textures: "" };
  const data = parseMirrorImageData(reply({ guid: 9n, displayId: 2281, race: 4 }));
  assert.equal(mirrorImageModelFor({}, bear, data, creatureModels), bear, "the bear stays the bear");
  assert.equal(mirrorImageModelFor({}, bear, undefined, creatureModels, true), bear, "nothing to wait for either");
  assert.equal(calls.length, 0, "no character look is composed for it");
});

test("review H: a unit that leaves view forgets its reply, and is asked again when it comes back", () => {
  const sent = [];
  const images = new MirrorImages((guid) => sent.push(guid), () => 0);
  images.receive(parseMirrorImageData(reply({ guid: 5n })));
  assert.equal(images.get(5n, 49, UNIT_FLAG2_MIRROR_IMAGE)?.displayId, 49);
  images.forget(5n);
  assert.equal(images.get(5n, 49, UNIT_FLAG2_MIRROR_IMAGE), undefined);
  assert.deepEqual(sent, [5n], "re-created, it is asked about anew (its gear may have changed meanwhile)");
});

function fakeConnection() {
  const sent = [];
  const queue = [];
  let wake;
  return {
    sent,
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

test("review H: WorldClient drops the reply with the object, and ignores a reply for a unit already gone", async () => {
  const SELF = 0x1234n;
  const BOT = 0xf130000000000042n;
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(BOT, { flags: 0, position: { x: 1, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(BOT).typeId = 3;
  connection.push(OPCODES.SMSG_MIRRORIMAGE_DATA, reply({ guid: BOT }));
  await settle();
  assert.equal(client.mirrorImages.get(BOT, 49, UNIT_FLAG2_MIRROR_IMAGE)?.displayId, 49);
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, new PacketWriter().u64(BOT).u8(0).toUint8Array());
  await settle();
  const asks = () => connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_GET_MIRRORIMAGE_DATA).length;
  assert.equal(client.mirrorImages.get(BOT, 49, UNIT_FLAG2_MIRROR_IMAGE), undefined, "the reply went with the object");
  assert.equal(asks(), 1);
  client.mirrorImages.forget(BOT);
  // A reply that lands after its unit left (a Dungeon Finder teleport, a despawn) is not kept.
  connection.push(OPCODES.SMSG_MIRRORIMAGE_DATA, reply({ guid: BOT }));
  await settle();
  client.mirrorImages.get(BOT, 49, UNIT_FLAG2_MIRROR_IMAGE);
  assert.equal(asks(), 2, "nothing was stored for the departed unit, so it is asked about again");
  client.close?.();
});
