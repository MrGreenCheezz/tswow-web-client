import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  effectiveDoodadIndices, parseWmoDoodadSets, validParsedWmoDoodadSets, wmoDependencies,
  wmoDoodadRoomTables, wmoRootId,
} from "../tools/wmo-visual.mjs";

// 05.10-A7b-1 — slice 1 of line A7b: the effective doodad set (7.02), the owner class of a WMO
// doodad (7.03 slice 1) and `MOHD.wmoID` (7.13), over a synthetic root and the client's own files.

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const NAMES = ["World\\A.mdx", "World\\B.m2", "World\\C.m2", "World\\D.m2", "World\\E.m2"];

/**
 * Five MODD records: set 0 = records 0–1, set 1 = records 1–4 (record 1 in both, record 4 with a
 * zero scale that every list skips), set 2 = past the table. MOHD.wmoID = 4711.
 */
function root({ set2 = false } = {}) {
  const mohd = Buffer.alloc(64);
  mohd.writeUInt32LE(4711, 32);
  const sets = Buffer.alloc(set2 ? 96 : 64);
  sets.writeUInt32LE(0, 20); sets.writeUInt32LE(2, 24);
  sets.writeUInt32LE(1, 32 + 20); sets.writeUInt32LE(4, 32 + 24);
  if (set2) { sets.writeUInt32LE(3, 64 + 20); sets.writeUInt32LE(9, 64 + 24); }
  const names = Buffer.from(NAMES.map((name) => `${name}\0`).join(""), "latin1");
  const placements = Buffer.alloc(40 * NAMES.length);
  let nameOffset = 0;
  for (let index = 0; index < NAMES.length; index++) {
    const at = index * 40;
    placements.writeUInt32LE(nameOffset, at);
    nameOffset += NAMES[index].length + 1;
    placements.writeFloatLE(index * 10, at + 4);
    placements.writeFloatLE(1, at + 28);
    placements.writeFloatLE(index === 4 ? 0 : 1, at + 32);
  }
  return Buffer.concat([chunk("MOHD", mohd), chunk("MODS", sets), chunk("MODN", names), chunk("MODD", placements)]);
}

function group(flags, references) {
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  const refs = Buffer.alloc(references.length * 2);
  references.forEach((reference, index) => refs.writeUInt16LE(reference, index * 2));
  return chunk("MOGP", Buffer.concat([header, chunk("MODR", refs)]));
}

// Record 0: only an outdoor group (0x8) names it. Record 2: an outdoor and an indoor (0x2000) group.
// Record 3: only the indoor one. Record 1: no group at all.
const groups = [group(0x8, [0, 2]), group(0x2000, [2, 3])];

test("a placement's set is set 0 plus its own records, each record once and set 0 first (7.02)", () => {
  const data = root();
  const legacy = parseWmoDoodadSets(data, groups);
  assert.deepEqual(legacy.map((set) => set.map((doodad) => doodad.name)),
    [["World\\A.m2", "World\\B.m2"], ["World\\B.m2", "World\\C.m2", "World\\D.m2"]],
    "the old form is untouched: set 1 alone, no index, no owner class");
  assert.ok(legacy.flat().every((doodad) => !("index" in doodad) && !("outdoor" in doodad)));

  const effective = parseWmoDoodadSets(data, groups, { effective: true });
  assert.deepEqual(effective[0].map((doodad) => doodad.index), [0, 1], "set 0 is itself");
  assert.deepEqual(effective[1].map((doodad) => doodad.index), [0, 1, 2, 3],
    "set 1 = set 0 (0, 1), then its own records not in set 0 (2, 3); record 4 is skipped as before");
  assert.equal(validParsedWmoDoodadSets(effective), true, "the v2 cache form validates");
  assert.equal(validParsedWmoDoodadSets([[{ ...effective[1][0], index: -1 }]]), false);
  assert.equal(validParsedWmoDoodadSets([[{ ...effective[1][0], outdoor: false }]]), false);
});

test("the effective index list: set 0 alone, a disjoint set, an overlap and a range past the table", () => {
  const sets = Buffer.alloc(96);
  sets.writeUInt32LE(0, 20); sets.writeUInt32LE(3, 24);
  sets.writeUInt32LE(3, 52); sets.writeUInt32LE(2, 56);
  sets.writeUInt32LE(2, 84); sets.writeUInt32LE(3, 88);
  assert.deepEqual(effectiveDoodadIndices(sets, 10, 0), [0, 1, 2]);
  assert.deepEqual(effectiveDoodadIndices(sets, 10, 1), [0, 1, 2, 3, 4]);
  assert.deepEqual(effectiveDoodadIndices(sets, 10, 2), [0, 1, 2, 3, 4], "record 2 is drawn once");
  assert.equal(effectiveDoodadIndices(sets, 4, 1), undefined, "a set past MODD is not a set");
  assert.equal(effectiveDoodadIndices(sets, 2, 1), undefined, "nor is one whose set 0 is past MODD");
});

test("WME4 room tables walk the same effective list the tile numbers (7.02, M-A7b-1 ordinals)", () => {
  const data = root();
  const owners = new Map([[0, [0]], [2, [0, 1]], [3, [1]]]);
  const effective = parseWmoDoodadSets(data, groups, { effective: true });
  const tables = wmoDoodadRoomTables(data, owners, true);
  assert.equal(tables.length, effective.length);
  for (const [set, table] of tables.entries()) {
    assert.equal(table.offsets.length - 1, effective[set].length, `set ${set}: one ordinal per tile doodad`);
  }
  // Ordinal k of set 1 is MODD record effective[1][k].index; its rooms are owners of that record.
  const roomsOf = (table, ordinal) => table.groups.slice(table.offsets[ordinal], table.offsets[ordinal + 1]);
  assert.deepEqual(effective[1].map((_, ordinal) => roomsOf(tables[1], ordinal)), [[0], [], [0, 1], [1]]);
  const legacy = wmoDoodadRoomTables(data, owners, false);
  assert.deepEqual(legacy[1].offsets, [0, 0, 2, 3], "the v22 table of set 1 is set 1 alone, as before");
});

test("a doodad only outdoor groups own is outdoor; shared, indoor and unowned ones stay interior (7.03 slice 1)", () => {
  const [set0, set1] = parseWmoDoodadSets(root(), groups, { effective: true });
  assert.deepEqual(set1.map((doodad) => doodad.outdoor === true), [true, false, false, false]);
  assert.equal(set0[0].outdoor, true);
  assert.deepEqual(parseWmoDoodadSets(root(), [], { effective: true })[1].map((doodad) => doodad.outdoor), [undefined, undefined, undefined, undefined],
    "without groups nothing is proven outdoor");
});

test("a MODS entry past MODD stays an error in both forms; MOHD.wmoID is read at offset 32 (7.13)", () => {
  assert.throws(() => parseWmoDoodadSets(root({ set2: true }), groups, { effective: true }), /doodad set is invalid/,
    "a MODS entry past MODD stays an error, as in the old form");
  assert.throws(() => parseWmoDoodadSets(root({ set2: true }), groups), /doodad set is invalid/);
  assert.equal(wmoRootId(root()), 4711);
  assert.equal(wmoRootId(Buffer.alloc(0)), undefined);
  assert.equal(wmoRootId(chunk("MOHD", Buffer.alloc(20))), undefined, "a short header has no id");
});

test("on this machine's client: the Duskwood inn placed with set 2 gets set 0's 80 records back", { skip: !existsSync("F:/Circle/Data") }, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  const chain = await clientArchives(clientDirectory());
  try {
    const path = "WORLD\\WMO\\AZEROTH\\BUILDINGS\\DUSKWOOD_INN\\DUSKWOOD_INN.WMO";
    const data = await chain.read(path);
    assert.ok(data, "the client ships the inn");
    const roomFiles = [];
    for (const groupPath of wmoDependencies(data, path).groups) roomFiles.push(await chain.read(groupPath));
    const legacy = parseWmoDoodadSets(data, roomFiles);
    const effective = parseWmoDoodadSets(data, roomFiles, { effective: true });
    assert.equal(legacy[2].length, 335, "probe-doodad-sets: 335 drawn with set 2 alone");
    assert.equal(legacy[0].length, 80, "set 0 holds 80");
    assert.equal(effective[2].length, 415, "335 + 80");
    // In the client's files a set's range never overlaps set 0's, so the old length is a sum.
    for (const [set, list] of effective.entries()) {
      assert.equal(list.length, set === 0 ? legacy[0].length : legacy[0].length + legacy[set].length, `set ${set}`);
    }
    assert.ok(Number.isInteger(wmoRootId(data)) && wmoRootId(data) > 0, "the inn has a WMOAreaTable id");
    // The client names set 0 itself: the set every placement carries.
    const mods = data.indexOf(Buffer.from("SDOM", "latin1"));
    assert.ok(mods > 0);
    assert.equal(data.subarray(mods + 8, mods + 28).toString("latin1").split(String.fromCharCode(0))[0], "Set_$DefaultGlobal");
  } finally {
    chain.close();
  }
});
