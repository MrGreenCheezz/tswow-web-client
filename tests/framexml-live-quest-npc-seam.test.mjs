import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function creature(guid, entry, displayId) {
  return {
    guid,
    typeId: 3,
    fields: new Map([
      [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
      [UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId],
    ]),
  };
}

test("stock questnpc unit follows the active quest giver, not the selected target", () => {
  const questGiverGuid = 0x701n;
  const targetGuid = 0x702n;
  const world = {
    targetGuid,
    state: {
      selfGuid: 0x100n,
      objects: new Map([
        [questGiverGuid, creature(questGiverGuid, 9001, 2101)],
        [targetGuid, creature(targetGuid, 9002, 2102)],
      ]),
    },
    names: new Map([[targetGuid, "Другой выбранный NPC"]]),
    creatureTemplates: new Map([
      [9001, { found: true, name: "Квестодатель" }],
      [9002, { found: true, name: "Другой выбранный NPC" }],
    ]),
    questList: undefined,
    questDialog: undefined,
  };
  const seam = new LiveWorldSeam({ world: () => world, store: () => undefined });
  const unitExists = (unit) => FRAMEXML_SEAM_BINDINGS.UnitExists(seam, [unit]);
  const unitName = (unit) => FRAMEXML_SEAM_BINDINGS.UnitName(seam, [unit]);

  assert.deepEqual(unitExists("questnpc"), [false]);
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);

  world.questList = { guid: questGiverGuid, quests: [] };
  assert.deepEqual(unitExists("questnpc"), [true]);
  assert.deepEqual(unitName("questnpc"), ["Квестодатель"]);
  assert.deepEqual(unitName("target"), ["Другой выбранный NPC"]);
  assert.equal(seam.questNpcPortraitGuid(), questGiverGuid,
    "portrait follows the active quest page, not the selected target's display");

  // The list is replaced by a detail packet for the same giver.
  world.questList = undefined;
  world.questDialog = { kind: "details", guid: questGiverGuid, questId: 123 };
  assert.deepEqual(unitExists("questnpc"), [true]);
  assert.deepEqual(unitName("questnpc"), ["Квестодатель"]);

  // A cached name cannot prove whether a streamed-out GUID was a creature or a gameobject.
  world.state.objects.delete(questGiverGuid);
  world.names.set(questGiverGuid, "Квестодатель из кэша имён");
  assert.deepEqual(unitExists("questnpc"), [false]);
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);

  world.state.objects.set(questGiverGuid, creature(questGiverGuid, 9001, 2101));
  assert.deepEqual(unitExists("questnpc"), [true]);
  assert.deepEqual(unitName("questnpc"), ["Квестодатель из кэша имён"]);
  assert.equal(seam.questNpcPortraitGuid(), questGiverGuid);

  world.state.objects.get(questGiverGuid).fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 0);
  assert.equal(seam.questNpcPortraitGuid(), undefined, "zero display has no model portrait");

  world.state.objects.set(questGiverGuid, { guid: questGiverGuid, typeId: 5, fields: new Map() });
  assert.deepEqual(unitExists("questnpc"), [false], "a gameobject giver is not a Unit");
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);

  world.questDialog = undefined;
  assert.deepEqual(unitExists("questnpc"), [false]);
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);
});
