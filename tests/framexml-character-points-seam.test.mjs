// Plan item 3.30: UnitCharacterPoints answers both of the player's words — free talent points and
// free primary profession slots (PLAYER_CHARACTER_POINTS1/2) — as Wow.exe 0x610fb0 does: the active
// player's two descriptor words, 0 and 0 for anyone else.
import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function fixture() {
  const selfGuid = 0x10n;
  const otherGuid = 0x20n;
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 8) | (1 << 24)]]);
  const self = { guid: selfGuid, fields };
  const other = { guid: otherGuid, fields: new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 8) | (1 << 24)],
    [UPDATE_FIELDS.PLAYER_CHARACTER_POINTS1.offset, 9],
    [UPDATE_FIELDS.PLAYER_CHARACTER_POINTS2.offset, 9],
  ]) };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [otherGuid, other]]) },
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    targetGuid: otherGuid,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    targetGuid: () => world.targetGuid,
  });
  const call = (...args) => [...FRAMEXML_SEAM_BINDINGS.UnitCharacterPoints(seam, args)];
  return { fields, world, call };
}

test("UnitCharacterPoints('player') answers the talent word, then the profession word", () => {
  const { fields, call } = fixture();
  assert.deepEqual(call("player"), [0, 0], "absent words read as 0");
  fields.set(UPDATE_FIELDS.PLAYER_CHARACTER_POINTS1.offset, 3);
  fields.set(UPDATE_FIELDS.PLAYER_CHARACTER_POINTS2.offset, 1);
  assert.deepEqual(call("player"), [3, 1]);
  fields.set(UPDATE_FIELDS.PLAYER_CHARACTER_POINTS2.offset, 2);
  assert.deepEqual(call("player"), [3, 2]);
});

test("another unit, or none, answers 0 and 0", () => {
  const { fields, call } = fixture();
  fields.set(UPDATE_FIELDS.PLAYER_CHARACTER_POINTS1.offset, 3);
  fields.set(UPDATE_FIELDS.PLAYER_CHARACTER_POINTS2.offset, 1);
  assert.deepEqual(call("target"), [0, 0], "another player's words are not the client's to read");
  assert.deepEqual(call("party1"), [0, 0]);
  assert.deepEqual(call(undefined), [0, 0]);
});
