import assert from "node:assert/strict";
import test from "node:test";

// 6.18 / 3.21 (11.11): the PlayerModel's unit copy, its turn step, the shared stage and the
// UNIT_MODEL_CHANGED source, without a client: the rules of Wow.exe's CharacterModelBase
// (0x005977e0, 0x00597870, 0x00597210, 0x005970f0, 0x005971b0) and 0x00618110's callers.
const {
  FrameXmlUnitModels, FrameXmlModelTurns,
  FRAMEXML_MODEL_ANIM_STAND, FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT, FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT,
} = await import("../dist/code/browser/framexml/FrameXmlUnitModel.js");
const { frameXmlUnitSnapshot, frameXmlUnitModelSource } = await import("../dist/code/browser/framexml/FrameXmlUnitModelLive.js");
const { watchFrameXmlUnitModelChanges } = await import("../dist/code/browser/framexml/FrameXmlUnitModelEvents.js");
const { FrameXmlDressUpModels } = await import("../dist/code/browser/framexml/FrameXmlDressUp.js");
const { FrameXmlDressUpStage } = await import("../dist/code/browser/framexml/FrameXmlDressUpStage.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

/** A world of guid text → a mutable look; `snapshot` copies the look as it is now. */
function world() {
  const units = new Map();
  let copies = 0;
  return {
    units,
    get copies() { return copies; },
    snapshot(guid) {
      const unit = units.get(guid);
      if (!unit) return undefined;
      copies += 1;
      return { ...unit };
    },
    source: (snapshot) => ({ key: `look:${snapshot.look}`, file: snapshot.file, fitBody: true }),
  };
}

test("SetUnit keeps the GUID and copies the unit only while shown; show copies anew, hide drops the copy", () => {
  const host = world();
  host.units.set("0x1", { file: "HumanMale.m2", look: "plate" });
  const units = new FrameXmlUnitModels(host);
  const frame = { name: "CharacterModelFrame", type: "PlayerModel" };

  units.setUnit(frame, "0x1", false);
  assert.equal(units.guid(frame), "0x1");
  assert.equal(units.shows(frame), false, "hidden: the GUID is kept, no model is built (0x005977e0 tests +0xe0)");
  assert.equal(units.resolve(frame), undefined);
  assert.equal(host.copies, 0);

  units.shown(frame);
  assert.equal(units.resolve(frame).key, "look:plate", "shown: the kept GUID's unit is copied (0x00597870)");
  host.units.get("0x1").look = "cloth";
  assert.equal(units.resolve(frame).key, "look:plate", "a copy, not a live view: the equip change is not seen yet");
  units.refresh(frame, true);
  assert.equal(units.resolve(frame).key, "look:cloth", "RefreshUnit copies again (0x00597b00)");

  units.hidden(frame);
  assert.equal(units.shows(frame), false, "hiding drops the model (0x00597210)");
  units.refresh(frame, false);
  assert.equal(units.shows(frame), false, "RefreshUnit of a hidden frame builds nothing");
  host.units.get("0x1").look = "robe";
  units.shown(frame);
  assert.equal(units.resolve(frame).key, "look:robe", "reopening shows the unit as it is now");

  units.setUnit(frame, "0x2", true);
  assert.equal(units.guid(frame), "0x2");
  assert.equal(units.resolve(frame).key, "look:robe", "a GUID not in view keeps the frame's last model");
  host.units.set("0x2", { file: "Wolf.m2", look: "wolf" });
  units.refresh(frame, true);
  assert.equal(units.resolve(frame).key, "look:wolf");

  units.clear(frame);
  assert.equal(units.has(frame), false, "SetCreature/SetModel/ClearModel forget the unit");
  units.shown(frame);
  assert.equal(units.resolve(frame), undefined);
});

test("SetRotation steps with ShuffleRight/ShuffleLeft and Stand returns after a turn-free update past 100 ms", () => {
  const frame = { name: "CharacterModelFrame", type: "PlayerModel" };
  let now = 1000;
  let playing = FRAMEXML_MODEL_ANIM_STAND;
  const played = [];
  const clips = new Set([FRAMEXML_MODEL_ANIM_STAND, FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT, FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT]);
  const turns = new FrameXmlModelTurns({
    hasAnimation: (_frame, id) => clips.has(id),
    playing: () => playing,
    play: (_frame, id) => { playing = id; played.push(id); },
    now: () => now,
  });

  turns.rotate(frame, 0.61, false);
  assert.deepEqual(played, [], "Model_OnLoad's first SetRotation has no model to step (+0x2a0 is empty)");
  turns.rotate(frame, 0.64, true);
  assert.deepEqual(played, [FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT], "a larger angle: ShuffleRight (12)");
  turns.rotate(frame, 0.67, true);
  assert.deepEqual(played, [FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT], "already playing it: not struck again");
  turns.update(frame);
  now += 50;
  turns.update(frame);
  assert.equal(playing, FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT, "within 100 ms of the last turn the step goes on");
  now += 51;
  turns.update(frame);
  assert.equal(playing, FRAMEXML_MODEL_ANIM_STAND, "past the deadline with no turn this update: Stand");

  turns.rotate(frame, 0.60, true);
  assert.equal(playing, FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT, "a smaller angle: ShuffleLeft (11)");
  now += 500;
  turns.update(frame);
  assert.equal(playing, FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT, "the update right after a turn only clears the mark");
  turns.update(frame);
  assert.equal(playing, FRAMEXML_MODEL_ANIM_STAND);

  turns.rotate(frame, 0.60, true);
  assert.equal(playing, FRAMEXML_MODEL_ANIM_STAND, "the same angle asks for Stand, already playing");
  clips.delete(FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT);
  turns.rotate(frame, 1.0, true);
  assert.equal(playing, FRAMEXML_MODEL_ANIM_STAND, "a model without the shuffle clip does not step");
});

test("the live copy freezes the fields, keeps units only, and keys the picture by its look", () => {
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 49]]);
  const objects = new Map([
    [1n, { guid: 1n, typeId: 4, fields }],
    [2n, { guid: 2n, typeId: 5, fields: new Map() }],
  ]);
  const copy = frameXmlUnitSnapshot(objects, "0x0000000000000001");
  assert.equal(copy.guid, 1n);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 50);
  assert.equal(copy.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset), 49, "the copy keeps the fields of its moment");
  assert.equal(frameXmlUnitSnapshot(objects, "0x0000000000000002"), undefined, "a game object is no unit (TYPEMASK_UNIT)");
  assert.equal(frameXmlUnitSnapshot(objects, "0x3"), undefined);
  assert.equal(frameXmlUnitSnapshot(objects, "player"), undefined);

  const appearance = { body: [] };
  const a = frameXmlUnitModelSource({ model: "HumanMale.m2", textures: "", scale: 1, appearance });
  const b = frameXmlUnitModelSource({ model: "HumanMale.m2", textures: "", scale: 1, appearance });
  assert.equal(a.key, b.key, "a fresh UnitModel around the same cached look is the same picture");
  const c = frameXmlUnitModelSource({ model: "HumanMale.m2", textures: "", scale: 1, appearance: { body: [] } });
  assert.notEqual(a.key, c.key, "another look is another picture");
  assert.equal(a.fitBody, true);
  assert.equal(frameXmlUnitModelSource(undefined), undefined);
});

test("one stage draws the dressing room and the unit models, and stops when none is shown", () => {
  const host = world();
  host.units.set("0x1", { file: "HumanMale.m2", look: "plate" });
  const units = new FrameXmlUnitModels(host);
  const dress = new FrameXmlDressUpModels({ look: () => undefined, item: () => undefined });
  const character = { name: "CharacterModelFrame", type: "PlayerModel" };
  const visible = new Set();
  const updated = [];
  const scheduled = [];
  const stage = new FrameXmlDressUpStage({
    gatewayOrigin: "http://127.0.0.1:8090",
    models: dress,
    units,
    turns: { update: (frame) => updated.push(frame.name) },
    elementFor: () => undefined,
    isVisible: (frame) => visible.has(frame),
    creatureModels: { get: () => undefined, request() {}, playerAppearance: () => undefined },
    requestFrame: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancelFrame() {},
  });
  units.setUnit(character, "0x1", true);
  assert.equal(stage.resolve(character).key, "look:plate", "a PlayerModel resolves through the unit models");

  stage.wake();
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(stage.running, false, "hidden: one pass, then the loop sleeps");
  assert.deepEqual(updated, [], "no update for a hidden model");

  visible.add(character);
  stage.wake();
  scheduled.shift()();
  assert.equal(stage.running, true, "a shown unit model keeps the loop going");
  assert.deepEqual(updated, ["CharacterModelFrame"], "each step updates the shown model once (0x005971b0)");
  visible.clear();
  scheduled.shift()();
  assert.equal(stage.running, false, "closed: the loop stops, nothing runs per frame");
  stage.dispose();
});

test("UNIT_MODEL_CHANGED and UNIT_PORTRAIT_UPDATE ride a visible item or helm/cloak change, not a target swap", () => {
  const VISIBLE = (slot) => UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset
    + slot * (UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset);
  const self = { guid: 1n, typeId: 4, fields: new Map([[VISIBLE(4), 100]]) };
  const other = { guid: 2n, typeId: 4, fields: new Map([[VISIBLE(4), 200]]) };
  const npc = { guid: 3n, typeId: 3, fields: new Map() };
  const tokens = { player: self, target: other };
  let listener;
  const fired = [];
  const stop = watchFrameXmlUnitModelChanges({
    any: (callback) => { listener = callback; return () => { listener = undefined; }; },
    unit: (token) => tokens[token],
    fire: (event, unit) => fired.push(`${event}:${unit}`),
  });
  listener();
  assert.deepEqual(fired, [], "nothing moved");
  self.fields.set(VISIBLE(4), 101);
  listener();
  assert.deepEqual(fired, ["UNIT_PORTRAIT_UPDATE:player", "UNIT_MODEL_CHANGED:player"], "a new chest (0x006e1e10)");
  fired.length = 0;
  self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x20);
  listener();
  assert.deepEqual(fired, [], "a flag outside 0xc00 rebuilds nothing");
  self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x420);
  listener();
  assert.deepEqual(fired, ["UNIT_PORTRAIT_UPDATE:player", "UNIT_MODEL_CHANGED:player"], "the helm hidden (0x006e0fd0)");
  fired.length = 0;
  tokens.target = { guid: 4n, typeId: 4, fields: new Map([[VISIBLE(4), 300]]) };
  listener();
  assert.deepEqual(fired, [], "another target is a target change, not a model change");
  tokens.target.fields.set(VISIBLE(15), 500);
  listener();
  assert.deepEqual(fired, ["UNIT_PORTRAIT_UPDATE:target", "UNIT_MODEL_CHANGED:target"], "another player's weapon");
  fired.length = 0;
  tokens.target = npc;
  listener();
  assert.deepEqual(fired, [], "a creature has no visible items");
  stop();
  assert.equal(listener, undefined);
});
