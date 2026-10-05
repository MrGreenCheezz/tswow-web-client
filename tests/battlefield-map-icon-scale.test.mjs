import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.14 (05.10-L17t): `GetBattlefieldMapIconScale` (Wow.exe 12340 0x0054c740, read-only Ghidra
// .runtime/re-2026-10-04/l17/g1.c) answers the Map.dbc row of the battlefield map (0x00bea564), its
// MinimapIconScale (in-memory record +0x28 = column 58 of the file, tools/dbd/Map.dbd 3.3.5.12340;
// TrinityCore DBCStructure.h:1089 leaves it unread), and 1.0 with no row. The column rides `/dbc/areas`
// version 9 (`MapInfo.minimapIconScale`); a gateway not yet restarted answers the version-8 shape, and
// the stock call then answers 1.0 as before.
let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };
const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
const { FrameXmlMap, FRAMEXML_MAP_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { frameXmlBattlefieldMapSource } = await import("../dist/code/browser/framexml/FrameXmlBattlefieldMapSource.js");

const data = dbcDirectory ? await loadAreaData(dbcDirectory) : undefined;
const WSG = 489;
const ARATHI = 529;
const SELF = 0x10n;

function battleground(mapId) {
  return {
    mapId,
    state: { selfGuid: SELF, objects: new Map(), revision: 1 },
    battlefieldQueues: new Map([[0, { status: 3, mapId, cleared: false }]]),
    flagCarriers: [],
    names: new Map(),
    creatureTemplates: new Map(),
    group: undefined,
    partyStats: new Map(),
  };
}

function iconScale(world, metadata) {
  const map = new FrameXmlMap({
    metadata: () => metadata, location: () => undefined,
    ...frameXmlBattlefieldMapSource({ world: () => world, metadata: () => metadata, vehicles: () => undefined }),
  });
  return FRAMEXML_MAP_BINDINGS.GetBattlefieldMapIconScale({ map }, []);
}

test("the area metadata carries Map.dbc MinimapIconScale on every map row", withDataset, () => {
  const scales = new Map(data.maps.map((row) => [row.id, row.minimapIconScale]));
  assert.equal(scales.size, data.maps.length);
  for (const [id, scale] of scales) assert.equal(typeof scale, "number", `map ${id}`);
  assert.equal(Math.fround(scales.get(ARATHI)), Math.fround(1.25), "Arathi Basin");
  assert.equal(scales.get(WSG), 1, "Warsong Gulch");
  const battlegrounds = data.maps.filter((row) => row.instanceType === 3 || row.instanceType === 4);
  assert.deepEqual(battlegrounds.filter((row) => row.minimapIconScale !== 1).map((row) => row.id), [ARATHI]);
});

test("GetBattlefieldMapIconScale answers the battlefield map's column", withDataset, () => {
  assert.deepEqual(iconScale(battleground(ARATHI), data), [1.25]);
  assert.deepEqual(iconScale(battleground(WSG), data), [1]);
  const outside = battleground(ARATHI);
  outside.battlefieldQueues.clear();
  assert.deepEqual(iconScale(outside, data), [1], "no battlefield in progress: 1");
});

test("a version-8 reply without the column answers 1.0", withDataset, () => {
  const old = { ...data, maps: data.maps.map(({ minimapIconScale: _dropped, ...row }) => row) };
  assert.deepEqual(iconScale(battleground(ARATHI), old), [1]);
});
