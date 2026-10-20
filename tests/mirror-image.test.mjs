import assert from "node:assert/strict";
import test from "node:test";
import { mirrorImageModelFor } from "../dist/code/browser/MirrorImageModel.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { MIRROR_IMAGE_RETRY_MS, MirrorImages, UNIT_FLAG2_MIRROR_IMAGE, buildGetMirrorImageData, mirrorImageEquipment } from "../dist/code/world/MirrorImages.js";
import { parseMirrorImageData } from "../dist/code/world/SpellLogProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── mirror-image.test.mjs
{
// 6.11б (line A7a, slice H, 05.10): SMSG_MIRRORIMAGE_DATA. TrinityCore SpellHandler.cpp:607-800 answers
// CMSG_GET_MIRRORIMAGE_DATA (0x401, a u64 guid) with guid, displayId, race, gender, class, skin, face,
// hair, hair colour, facial hair, guild id and eleven ItemDisplayInfo ids in the order HEAD, SHOULDERS,
// BODY, CHEST, WAIST, LEGS, FEET, WRISTS, HANDS, BACK, TABARD (CreatureOutfit.h, the player branch and
// the NPCBot branch alike). UNIT_FLAG2_MIRROR_IMAGE 0x10 (UNIT_FIELD_FLAGS_2) says a unit has one.

function reply({ guid = 0xf130000000000042n, displayId = 49, race = 1, gender = 1, classId = 8,
  skin = 2, face = 3, hair = 4, hairColour = 5, facialHair = 6, guild = 0, items = [] } = {}) {
  const bytes = new Uint8Array(68);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, guid, true);
  view.setUint32(8, displayId, true);
  bytes.set([race, gender, classId, skin, face, hair, hairColour, facialHair], 12);
  view.setUint32(20, guild, true);
  for (let slot = 0; slot < 11; slot++) view.setUint32(24 + slot * 4, items[slot] ?? 0, true);
  return bytes;
}

test("6.11б the 68-byte reply: every field where TrinityCore writes it", () => {
  const data = parseMirrorImageData(reply({ items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], guild: 77 }));
  assert.equal(data.guid, 0xf130000000000042n);
  assert.deepEqual([data.displayId, data.race, data.gender, data.classId, data.skin, data.face, data.hair,
    data.hairColour, data.facialHair, data.guildId], [49, 1, 1, 8, 2, 3, 4, 5, 6, 77]);
  assert.deepEqual(data.equipmentDisplayIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("6.11б the request is the bare guid", () => {
  assert.deepEqual([...buildGetMirrorImageData(0x0102030405060708n)], [8, 7, 6, 5, 4, 3, 2, 1]);
});

test("6.11б the eleven words become worn items; BACK is word 9 and TABARD word 10, empty words drop", () => {
  const worn = mirrorImageEquipment([100, 0, 0, 104, 0, 0, 0, 0, 0, 109, 110]);
  assert.deepEqual(worn.map((item) => [item.slot, item.inventoryType, item.displayId]), [
    [0, 1, 100], [4, 5, 104], [14, 16, 109], [18, 19, 110],
  ]);
});

// 13.10 6.11: Wow.exe asks once (0x00730100 → 0x00716f10, bit 0x20000 at CGUnit_C +0xa30) and never again
// until answered — no timed retries; this was three tries five seconds apart.
test("6.11б asked once per guid and display, and not again however long the answer takes", () => {
  const sent = [];
  let now = 0;
  const images = new MirrorImages((guid) => sent.push(guid), () => now);
  const guid = 0x42n;
  assert.equal(images.get(guid, 49, 0), undefined);
  assert.deepEqual(sent, [], "no flag, no question");
  assert.equal(images.get(guid, 49, UNIT_FLAG2_MIRROR_IMAGE), undefined);
  images.get(guid, 49, UNIT_FLAG2_MIRROR_IMAGE);
  assert.deepEqual(sent, [guid], "one question while it is outstanding");
  now += MIRROR_IMAGE_RETRY_MS;
  images.get(guid, 49, UNIT_FLAG2_MIRROR_IMAGE);
  now += MIRROR_IMAGE_RETRY_MS;
  images.get(guid, 49, UNIT_FLAG2_MIRROR_IMAGE);
  now += MIRROR_IMAGE_RETRY_MS;
  images.get(guid, 49, UNIT_FLAG2_MIRROR_IMAGE);
  assert.equal(sent.length, 1, "one question, then silence");
  assert.equal(images.awaiting(guid, 49), false, "and after the wait the plain display is shown");
  const generation = images.generation;
  images.receive(parseMirrorImageData(reply({ guid, displayId: 49 })));
  assert.ok(images.generation > generation);
  assert.equal(images.get(guid, 49, UNIT_FLAG2_MIRROR_IMAGE)?.displayId, 49);
  assert.equal(images.get(guid, 49, 0), undefined, "the flag gone, the look is not applied");
});

test("6.11б a reply for another display is not worn, and the new display is asked about", () => {
  const sent = [];
  const images = new MirrorImages((guid) => sent.push(guid), () => 0);
  images.receive(parseMirrorImageData(reply({ guid: 7n, displayId: 49 })));
  // CreatureOutfit swaps through the invisible model 11686 (Creature.cpp:376), then the outfit's own.
  assert.equal(images.get(7n, 11686, UNIT_FLAG2_MIRROR_IMAGE), undefined);
  assert.deepEqual(sent, [7n]);
  assert.equal(images.get(7n, 49, UNIT_FLAG2_MIRROR_IMAGE)?.displayId, 49);
  images.clear();
  assert.equal(images.get(7n, 49, 0), undefined);
});

test("6.11б the look: race, gender (not class), the five bytes, the worn list and the class", () => {
  const calls = [];
  const appearance = { body: [], geosets: [0], attached: [], hair: "", cloak: "" };
  const creatureModels = {
    generation: 1,
    playerAppearance: (...args) => { calls.push(args); return appearance; },
  };
  // The gateway bakes a look into every `Character\` display (CreatureModelMetadata.ts, `forModel`);
  // review H (05.10): only such a display is dressed (mirror-image.test.mjs).
  const metadata = { id: 49, model: "Character\\Human\\Female\\HumanFemale.m2", scale: 1, textures: "",
    appearance: { body: [], geosets: [0], attached: [], hair: "", cloak: "" } };
  const data = parseMirrorImageData(reply({ race: 1, gender: 1, classId: 8, items: [0, 0, 0, 104, 0, 0, 0, 0, 0, 109, 110] }));
  const object = {};
  const model = mirrorImageModelFor(object, metadata, data, creatureModels);
  assert.equal(model.appearance, appearance);
  assert.equal(model.id, 49);
  const [race, sex, skin, face, hair, hairColour, facialHair, worn, classId] = calls[0];
  assert.deepEqual([race, sex, skin, face, hair, hairColour, facialHair, classId], [1, 1, 2, 3, 4, 5, 6, 8]);
  assert.deepEqual(worn.map((item) => item.slot), [4, 14, 18]);
  assert.equal(mirrorImageModelFor(object, metadata, data, creatureModels), model, "the same answer is the same model");
  const waiting = mirrorImageModelFor({}, metadata, data, { generation: 1, playerAppearance: () => undefined });
  assert.equal(waiting.appearancePending, true, "until the look arrives the unit keeps what it wears");
  assert.equal(mirrorImageModelFor({}, metadata, undefined, creatureModels), metadata, "no reply: the display as it is");
  const asked = mirrorImageModelFor({}, metadata, undefined, creatureModels, true);
  assert.equal(asked.appearancePending, true, "a question still out: wait for it");
  assert.equal(asked.id, 49);
});
}

// ── mirror-image-review.test.mjs
{
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
}
