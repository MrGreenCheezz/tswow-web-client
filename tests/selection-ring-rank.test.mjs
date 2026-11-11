// 5.05 (11.11): the selection circle's colour as Wow.exe draws it (SelectionRingRank.ts): 0x00725980 → 0x00718ac0 →
// 0x00521bf0(unit, out, 1) — for a unit the player does not control, grey when dead and else the rank's row, with
// Unfriendly (rank 2) orange, where the ring used to fold it into the yellow neutral.
import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  SELECTION_RING_DEAD, SELECTION_RING_GREEN, SELECTION_RING_ORANGE, SELECTION_RING_RED, SELECTION_RING_YELLOW,
  selectionRingColourOfRank, selectionRingRankColour,
} from "../dist/code/browser/ui/SelectionRingRank.js";

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const DYNAMIC = UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset;

function unit(guid, { typeId = 3, health = 100, flags = 0, dynamic = 0 } = {}) {
  const fields = new Map([[HEALTH, health], [FLAGS, flags], [DYNAMIC, dynamic]]);
  return { guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields };
}

test("0x00bd0c94's rows for the ring: 0–1 red, 2 orange, 3 yellow, 4–7 green", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7].map(selectionRingColourOfRank),
    [SELECTION_RING_RED, SELECTION_RING_RED, SELECTION_RING_ORANGE, SELECTION_RING_YELLOW, SELECTION_RING_GREEN, SELECTION_RING_GREEN]);
});

test("0x00521bf0(…, 1): dead is grey, a player-controlled unit and the player take the other branches", () => {
  const rank = () => 2;
  assert.equal(selectionRingRankColour(unit(2n), 1n, rank), SELECTION_RING_ORANGE);
  assert.equal(selectionRingRankColour(unit(2n, { health: 0 }), 1n, rank), SELECTION_RING_DEAD);
  assert.equal(selectionRingRankColour(unit(2n, { dynamic: 0x20 }), 1n, rank), SELECTION_RING_DEAD, "UNIT_DYNFLAG_DEAD");
  assert.equal(selectionRingRankColour(unit(2n, { flags: 0x8 }), 1n, rank), undefined, "PLAYER_CONTROLLED");
  assert.equal(selectionRingRankColour(unit(1n), 1n, rank), undefined, "the player");
  assert.equal(selectionRingRankColour(unit(2n), 1n, () => undefined), undefined, "no rank yet");
});

// The live ring (NamePlates.ts `selectionRingColour`) is checked in nameplate.test.mjs, which has the page stubs.
