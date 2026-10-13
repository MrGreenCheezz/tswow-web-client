import assert from "node:assert/strict";
import test from "node:test";

// Plan item 1.08 (13.10): the client flag 0x00beb608 that GetDungeonDifficulty (0x00515790) and GetRaidDifficulty
// (0x00515810) read is the raid roster's member count (RaidInfo.cpp: filled by 0x00574f10, zeroed by 0x00572f90 on
// leaving the raid; .runtime/re-2026-10-11/glue-1110/a108-1…4.txt). With it non-zero — in a raid group — the dungeon
// difficulty in force is the player's own and the raid difficulty is the group's; in a party the dungeon one is the
// group's and the raid one the player's own; alone, both the player's own. Before, the flag was taken as clear.
const { FrameXmlDifficultyModel, FRAMEXML_DIFFICULTY_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlDifficulty.js");

const SELF = 0x10n;

function model(group) {
  const world = { dungeonDifficulty: 0, raidDifficulty: 1, state: { selfGuid: SELF }, group };
  return { world, host: { difficulty: new FrameXmlDifficultyModel({ world: () => world }) } };
}

const party = { leaderGuid: SELF, dungeonDifficulty: 1, raidDifficulty: 3, groupType: 0 };
const raid = { ...party, groupType: 0x02 };

test("alone: the player's own words, twice", () => {
  const { host } = model(undefined);
  assert.deepEqual(FRAMEXML_DIFFICULTY_BINDINGS.GetDungeonDifficulty(host, []), [1, 1]);
  assert.deepEqual(FRAMEXML_DIFFICULTY_BINDINGS.GetRaidDifficulty(host, []), [2, 2]);
});

test("in a party: the group's dungeon word, the player's own raid word", () => {
  const { host } = model(party);
  assert.deepEqual(FRAMEXML_DIFFICULTY_BINDINGS.GetDungeonDifficulty(host, []), [2, 1], "0x00bd1978 then 0x00bd0898");
  assert.deepEqual(FRAMEXML_DIFFICULTY_BINDINGS.GetRaidDifficulty(host, []), [2, 2], "0x00beb608 = 0: 0x00bd089c");
});

test("in a raid (0x00beb608 ≠ 0): the player's own dungeon word, the group's raid word", () => {
  const { host } = model(raid);
  assert.deepEqual(FRAMEXML_DIFFICULTY_BINDINGS.GetDungeonDifficulty(host, []), [1, 1], "a raid: 0x00bd0898");
  assert.deepEqual(FRAMEXML_DIFFICULTY_BINDINGS.GetRaidDifficulty(host, []), [4, 2], "0x00bd197c then 0x00bd089c");
});
