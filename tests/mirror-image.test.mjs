import assert from "node:assert/strict";
import test from "node:test";
import { parseMirrorImageData } from "../dist/code/world/SpellLogProtocol.js";
import {
  MIRROR_IMAGE_RETRY_MS, MirrorImages, UNIT_FLAG2_MIRROR_IMAGE, buildGetMirrorImageData, mirrorImageEquipment,
} from "../dist/code/world/MirrorImages.js";
import { mirrorImageModelFor } from "../dist/code/browser/MirrorImageModel.js";

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

test("6.11б asked once per guid and display, again after the wait, at most three times", () => {
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
  assert.equal(sent.length, 3, "three tries, then silence");
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
  // review H (05.10): only such a display is dressed (mirror-image-review.test.mjs).
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
