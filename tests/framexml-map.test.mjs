import assert from "node:assert/strict";
import test from "node:test";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };
const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
const { openDbcFile } = await import("../dist/code/gateway/Dbc.js");
const { FrameXmlMap, FRAMEXML_MAP_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlMap.js");

test("stock DungeonMap rows select Dalaran floors and drive the map tile suffix", withDataset, async () => {
  const data = await loadAreaData(dbcDirectory);
  const dungeon = await openDbcFile(dbcDirectory, "DungeonMap");
  assert.equal(dungeon.fields, 8);
  assert.equal(dungeon.recordSize, 32);
  assert.equal(data.dungeonMaps.length, dungeon.records);
  const dalaran = data.mapAreas.find((area) => area.name === "Dalaran");
  assert.ok(dalaran);
  assert.equal(dalaran.defaultDungeonFloor, 27, "WorldMapArea points to a DungeonMap row ID");
  assert.equal(data.dungeonMaps.find((floor) => floor.id === 27)?.floorIndex, 1);
  assert.equal(data.dungeonMaps.find((floor) => floor.id === 26)?.floorIndex, 2);

  // The point is in the first Dalaran sheet only. DungeonMap axes differ from the map UI axes.
  const location = { mapId: 571, areaId: 4395, x: 5_800, y: 300 };
  const map = new FrameXmlMap({ metadata: () => data, location: () => location });
  assert.deepEqual(map.getMapInfo(), ["Dalaran"]);
  assert.equal(map.getCurrentMapAreaId(), dalaran.id + 1);
  assert.equal(map.getCurrentMapContinent(), 4);
  assert.ok(map.getCurrentMapZone() > 0);
  assert.equal(map.getNumDungeonMapLevels(), 2);
  assert.equal(map.getCurrentMapDungeonLevel(), 1);
  assert.equal(map.dungeonUsesTerrainMap(), false);
  const player = map.getPlayerMapPosition("player");
  assert.ok(player[0] > 0 && player[0] < 1 && player[1] > 0 && player[1] < 1);
  map.setDungeonMapLevel(2);
  assert.equal(map.getCurrentMapDungeonLevel(), 2);
  assert.deepEqual(map.getPlayerMapPosition("player"), [0, 0], "first-floor player is off the selected second floor");
  map.setDungeonMapLevel(3);
  assert.equal(map.getCurrentMapDungeonLevel(), 2, "unknown floor cannot select imaginary art");

  map.setMapById(529);
  assert.deepEqual(map.getMapInfo(), ["Ulduar"]);
  assert.equal(map.dungeonUsesTerrainMap(), true, "its WorldMapArea -1 selects an authored terrain sheet");
  assert.equal(map.getNumDungeonMapLevels(), 6, "terrain sheet plus the five DungeonMap rows");
  assert.equal(map.getCurrentMapDungeonLevel(), 1);
});

test("stock continent/zone selection, map overlays and update edges use DBC identities", withDataset, async () => {
  const data = await loadAreaData(dbcDirectory);
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  assert.ok(elwynn);
  const events = [];
  const map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_000, y: -400 }),
    isExploredArea: () => true,
    corpseLocation: () => null,
    deathReleaseLocation: () => null,
  });
  map.attach({ fire: (event) => { events.push(event); return 1; } });
  map.tick();
  assert.deepEqual(events, ["WORLD_MAP_UPDATE"]);
  assert.deepEqual(map.getMapInfo(), ["Elwynn"]);
  assert.equal(map.getCurrentMapContinent(), 1);
  const overlays = data.overlays.filter((overlay) => overlay.mapAreaId === elwynn.id);
  assert.equal(map.getNumMapOverlays(), overlays.length);
  const first = overlays[0];
  assert.deepEqual(map.getMapOverlayInfo(1), [
    `Interface\\WorldMap\\Elwynn\\${first.textureName}`,
    first.width, first.height, first.offsetX, first.offsetY, first.mapPointX, first.mapPointY,
  ]);
  assert.deepEqual(map.getMapOverlayInfo(overlays.length + 1), []);

  const continents = map.getMapContinents();
  assert.deepEqual(continents, data.continents
    .toSorted((a, b) => a.id - b.id)
    .map((continent) => data.maps.find((row) => row.id === continent.mapId).name));
  const zones = map.getMapZones(1);
  assert.ok(zones.includes(data.areas.find((area) => area.id === elwynn.areaId).name));
  map.setMapZoom(1);
  assert.deepEqual(map.getMapInfo(), ["Azeroth"]);
  assert.equal(map.getCurrentMapZone(), 0);
  map.tick();
  assert.equal(events.length, 2);
  map.setMapZoom(-1);
  assert.deepEqual(map.getMapInfo(), [], "stock Lua chooses Cosmic when GetMapInfo is nil");
  assert.equal(map.getCurrentMapContinent(), -1);
  assert.equal(map.getCurrentMapDungeonLevel(), 0, "cosmic is a real non-dungeon state");
  assert.equal(map.isZoomOutAvailable(), false);
  // These are the Azeroth/Cosmic hit-frame rectangles authored in WorldMapFrame.xml.
  map.processMapClick(0.77, 0.65);
  assert.equal(map.getCurrentMapContinent(), 0);
  assert.equal(map.isZoomOutAvailable(), true);
  map.zoomOut();
  assert.equal(map.getCurrentMapContinent(), -1);
  map.tick();
  assert.equal(events.length, 3, "multiple C API selections coalesce to one map-update edge");
  map.detach();
  map.setMapById(elwynn.id);
  map.tick();
  assert.equal(events.length, 3, "detached map no longer emits into the prior boot");
});

test("map update waits for metadata and live marker caches, then closes on a pending corpse query", withDataset, async () => {
  const data = await loadAreaData(dbcDirectory);
  const events = [];
  let metadata;
  let corpse;
  const map = new FrameXmlMap({
    metadata: () => metadata,
    location: () => ({ mapId: 0, areaId: 12, x: -9_000, y: -400 }),
    corpseLocation: () => corpse,
    deathReleaseLocation: () => null,
  });
  map.attach({ fire: (event) => { events.push(event); return 1; } });
  map.tick();
  assert.deepEqual(events, [], "no WORLD_MAP_UPDATE leaks into unrelated boot listeners");
  metadata = data;
  map.tick();
  assert.deepEqual(events, [], "a pending corpse answer cannot run stock nil-unsafe map updates");
  corpse = null;
  map.tick();
  assert.equal(map.ready, true);
  assert.deepEqual(events, ["WORLD_MAP_UPDATE"]);
  corpse = undefined;
  map.tick();
  assert.equal(map.ready, false);
  assert.deepEqual(events, ["WORLD_MAP_UPDATE", "CLOSE_WORLD_MAP"]);
  map.tick();
  assert.equal(events.length, 2, "the close edge does not repeat every frame");
  map.detach();
});

test("the WorldMap C API binding exposes selection and typed nil/number results", withDataset, async () => {
  const data = await loadAreaData(dbcDirectory);
  const map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: 571, areaId: 4395, x: 5_800, y: 300 }),
  });
  const host = { map };
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetMapInfo(host, []), ["Dalaran"]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetCurrentMapDungeonLevel(host, []), [1]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetNumDungeonMapLevels(host, []), [2]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetCurrentMapAreaID(host, []), [505]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetMapInfo({}, []), [], "unattached host has no fabricated map answer");
  FRAMEXML_MAP_BINDINGS.SetDungeonMapLevel(host, [2]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetCurrentMapDungeonLevel(host, []), [2]);
  FRAMEXML_MAP_BINDINGS.SetMapByID(host, [485]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetMapInfo(host, []), ["Northrend"]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetCurrentMapAreaID(host, []), [486]);
});

test("authored continent ZMP cells govern WorldMap clicks and hover without rectangle guesses", withDataset, async () => {
  const data = await loadAreaData(dbcDirectory);
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  assert.ok(elwynn);
  let hit = { status: "loading" };
  const map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_000, y: -400 }),
    areaAt: () => hit,
  });
  map.setMapZoom(1);
  const continent = map.selection.key;
  map.processMapClick(0.5, 0.5);
  assert.equal(map.selection.key, continent, "a pending ZMP cannot fall back to overlapping boxes");
  hit = { status: "ready" };
  assert.deepEqual(map.updateMapHighlight(0.5, 0.5), [], "authored ocean stays empty");
  map.processMapClick(0.5, 0.5);
  assert.equal(map.selection.key, continent);
  hit = { status: "ready", mapArea: elwynn };
  assert.deepEqual(map.updateMapHighlight(0.5, 0.5), [data.areas.find((area) => area.id === elwynn.areaId).name]);
  map.processMapClick(0.5, 0.5);
  assert.equal(map.selection.key, `area:${elwynn.id}`);
});

test("battleground maps wait for actual roster/flag/vehicle providers", withDataset, async () => {
  const data = await loadAreaData(dbcDirectory);
  const warsong = data.mapAreas.find((area) => area.name === "WarsongGulch");
  assert.ok(warsong);
  assert.equal(data.maps.find((row) => row.id === warsong.mapId)?.instanceType, 3);
  const map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: 489, areaId: 3277, x: 1450, y: 1200 }),
    corpseLocation: () => null,
    deathReleaseLocation: () => null,
  });
  assert.deepEqual(map.getMapInfo(), ["WarsongGulch"]);
  assert.equal(map.ready, false);
  assert.equal(map.getNumBattlefieldPositions(), undefined);
  assert.equal(map.getNumBattlefieldFlagPositions(), undefined);
  assert.equal(map.getNumBattlefieldVehicles(), undefined);
  assert.deepEqual(map.getBattlefieldPosition(1), [],
    "missing battleground data is not reported as an empty real team");
});
