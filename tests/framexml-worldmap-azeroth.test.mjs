// Plan item 3.58 tail (25.10): the Azeroth world map (SetMapZoom(0), Wow.exe's m_currentContinent −1) had no projection
// in FrameXmlMap.ts — GetPlayerMapPosition answered (0, 0) there (no player arrow) and GetNumMapLandmarks 0 (no capital
// icons). Wow.exe places a world position by its continent's WorldMapContinent row after WorldMapTransforms
// (CGWorldMap::GetWorldPosition 0x00544140 over 0x00543920 and 0x00544090), unclamped, Outland (map 530) off for the
// player and the landmarks; landmarks are the rows with 0x10 and 0x8 (0x005445f0), every map's, with their icons
// (0x00545a30). The continent highlight rectangles of that map use the same placement (0x00547EB0).
import assert from "node:assert/strict";
import test, { after } from "node:test";

let clientDirectory;
let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
  dbcDirectory = paths.dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };
const withClient = { skip: clientDirectory && dbcDirectory ? false : "no 3.3.5a client and DBC dataset on this machine" };

const { FrameXmlMap } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { worldMapPoint, worldMapContinentRect, worldMapTransform } = await import("../dist/code/browser/framexml/FrameXmlWorldProjection.js");
const { WorldMapHierarchy } = await import("../dist/code/browser/ui/WorldMapHierarchy.js");
const data = dbcDirectory ? await (await import("../dist/code/gateway/AreaMetadata.js")).loadAreaData(dbcDirectory) : undefined;
const poi = (id) => data.areaPois.find((row) => row.id === id);
const continent = (mapId) => data.continents.find((row) => row.mapId === mapId);
/**
 * The rows the Azeroth map lists with no world state set: 0x10 and 0x8, no 0x400, no WorldStateID, and not in Outland
 * after WorldMapTransforms (Silvermoon and the Exodar stand on map 530 but are drawn on their continents).
 */
const capitalRows = () => data.areaPois.filter((row) => (row.flags & 0x18) === 0x18 && !(row.flags & 0x400)
  && !row.worldStateId && worldMapPoint(data, row.mapId, row.x, row.y)?.outland === false);

function landmarks(map) {
  const rows = [];
  for (let i = 1; i <= map.getNumMapLandmarks(); i++) {
    const [name, description, icon, x, y, link, battle] = map.getMapLandmarkInfo(i);
    rows.push({ name, description, icon, x, y, link, battle });
  }
  return rows;
}
const near = (actual, expected, epsilon, label) => assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} vs ${expected}`);

test("0x00544140's placement on synthetic rows: offsets, scale, transforms, Outland", () => {
  const rows = {
    continents: [
      { id: 1, mapId: 0, left: 26, right: 44, top: 8, bottom: 60, offsetX: 16.875, offsetY: -1.5, scale: 0.7, worldMapId: 1 },
      { id: 3, mapId: 530, left: 23, right: 47, top: 15, bottom: 61, offsetX: 14.5, offsetY: -7, scale: 0.75, worldMapId: 0 },
    ],
    transforms: [{ id: 2, mapId: 609, regionBottom: 0, regionRight: -1000, regionTop: 1000, regionLeft: 0,
      newMapId: 0, offsetX: -100, offsetY: 200, newDungeonMapId: 0 }],
  };
  // u = 16.875 / 62.625 + 0.5 − y · 0.7 / 33,400; v = −1.5 / 41.75 + 0.5 − x · 0.7 / 22,266.7.
  const point = worldMapPoint(rows, 0, -9_460, 60);
  near(point.u, 16.875 * 0.015968064 + 0.5 - 60 * 0.00002994012 * 0.7, 1e-9, "u");
  near(point.v, -1.5 * 0.023952097 + 0.5 + 9_460 * 0.000044910183 * 0.7, 1e-9, "v");
  assert.equal(point.outland, false);
  // A map drawn on its continent moves by its row's offset first; outside the row's region it has no continent.
  const moved = worldMapPoint(rows, 609, 500, -500);
  const there = worldMapPoint(rows, 0, 400, -300);
  near(moved.u, there.u, 1e-12, "transformed u");
  near(moved.v, there.v, 1e-12, "transformed v");
  assert.equal(worldMapTransform(rows.transforms, 609, 2_000, -500), undefined);
  assert.equal(worldMapPoint(rows, 609, 2_000, -500), undefined, "no row places it: (0, 0)");
  assert.equal(worldMapPoint(rows, 530, 0, 0).outland, true);
  // The highlight rectangle is the same placement over the ADT boundaries (tile b at its north-west corner).
  const [left, top, right, bottom] = worldMapContinentRect(rows.continents[0]);
  const corner = (tileX, tileY) => worldMapPoint(rows, 0, (32 - tileY) * 1600 / 3, (32 - tileX) * 1600 / 3);
  near(left, corner(26, 8).u, 1e-6, "left edge = tile 26's west side");
  near(top, corner(26, 8).v, 1e-6, "top edge = tile 8's north side");
  near(right, corner(45, 61).u, 1e-6, "right edge = tile 44's east side");
  near(bottom, corner(45, 61).v, 1e-6, "bottom edge = tile 60's south side");
});

test("the Azeroth map: the player arrow over Elwynn and the capitals' icons where their continents lie", withDataset, () => {
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  let location = { mapId: 0, areaId: elwynn.areaId, x: -9_460, y: 60 };
  const map = new FrameXmlMap({ metadata: () => data, location: () => location, isExploredArea: () => true,
    worldState: () => undefined, corpseLocation: () => null, deathReleaseLocation: () => null });
  map.setMapZoom(0);
  assert.equal(map.getCurrentMapContinent(), 0, "the Azeroth world map");
  const [u, v] = map.getPlayerMapPosition("player");
  const eastern = continent(0);
  near(u, eastern.offsetX * 0.015968064 + 0.5 - 60 * 0.00002994012 * eastern.scale, 1e-6, "arrow u");
  near(v, eastern.offsetY * 0.023952097 + 0.5 + 9_460 * 0.000044910183 * eastern.scale, 1e-6, "arrow v");
  const hierarchy = new WorldMapHierarchy(data);
  const rect = (mapId) => hierarchy.targets(hierarchy.node("world:1"))
    .find((target) => target.node.kind === "area" && target.node.mapArea.mapId === mapId)?.rect;
  const inside = (point, box, label) => assert.ok(point.x >= box.left && point.x <= box.left + box.width
    && point.y >= box.top && point.y <= box.top + box.height, `${label} (${point.x}, ${point.y}) in its continent's rectangle`);
  inside({ x: u, y: v }, rect(0), "the arrow over Goldshire");

  // The capitals: every row with 0x10 and 0x8 off Outland, each with Icon[0] (the city cell 6), each inside its
  // continent's highlight rectangle; Goldshire's arrow beside Stormwind's icon.
  const all = landmarks(map);
  const capitals = capitalRows();
  assert.equal(capitals.length, 9, "Stormwind, Ironforge, Undercity, Silvermoon; Orgrimmar, Thunder Bluff, Darnassus, the Exodar; Dalaran");
  assert.deepEqual(all.map((row) => row.name), capitals.map((row) => row.name));
  for (const [index, row] of capitals.entries()) {
    assert.equal(all[index].icon, row.icons[0], `${row.name}: Icon[0] on the Azeroth map (0x00545a30)`);
    assert.equal(all[index].icon, 6, `${row.name}: the city cell`);
    const placed = worldMapPoint(data, row.mapId, row.x, row.y);
    near(all[index].x, placed.u, 1e-6, `${row.name} u`);
    near(all[index].y, placed.v, 1e-6, `${row.name} v`);
    inside({ x: placed.u, y: placed.v }, rect(worldMapTransform(data.transforms, row.mapId, row.x, row.y)?.newMapId ?? row.mapId), row.name);
  }
  const stormwind = all.find((row) => row.name === poi(16).name);
  assert.ok(stormwind, "Stormwind (AreaPOI 16, 0x21d) is on the Azeroth map");
  assert.ok(all.some((row) => row !== stormwind && Math.abs(row.x - stormwind.x) < 0.05 && row.y < stormwind.y),
    "a capital just north of Stormwind on its continent (Ironforge)");
  near(u, stormwind.x, 0.02, "Goldshire's arrow beside Stormwind's icon (u)");
  near(v, stormwind.y, 0.02, "Goldshire's arrow beside Stormwind's icon (v)");
  assert.ok(data.areaPois.some((row) => row.mapId === 530 && (row.flags & 0x18) === 0x18), "Outland has such rows (Shattrath)");

  // Outland: the arrow is off (0x005444F0's `outland`).
  location = { mapId: 530, areaId: 3703, x: -1_838, y: 5_301 };
  assert.deepEqual([...map.getPlayerMapPosition("player")], [0, 0]);
  // A map no WorldMapContinent row places (an instance without a transform): (0, 0).
  location = { mapId: 36, areaId: 1581, x: -16, y: -383 };
  assert.deepEqual([...map.getPlayerMapPosition("player")], [0, 0]);
  // Kalimdor: inside Kalimdor's rectangle.
  location = { mapId: 1, areaId: 1637, x: 1_630, y: -4_400 };
  const [ku, kv] = map.getPlayerMapPosition("player");
  inside({ x: ku, y: kv }, rect(1), "the arrow in Orgrimmar");
  // The cosmic map places nothing (0x00544140: no orphan zone there).
  map.setMapZoom(-1);
  assert.deepEqual([...map.getPlayerMapPosition("player")], [0, 0]);
  assert.equal(map.getNumMapLandmarks(), 0);
});

test("the Azeroth map's corpse is placed, Outland included (0x00545950 passes no Outland flag)", withDataset, () => {
  const corpse = { mapId: 530, areaId: 3703, x: -1_838, y: 5_301 };
  const map = new FrameXmlMap({ metadata: () => data, location: () => ({ mapId: 0, areaId: 12, x: -9_460, y: 60 }),
    corpseLocation: () => corpse, deathReleaseLocation: () => null });
  map.setMapZoom(0);
  const [u, v] = map.getCorpseMapPosition();
  const placed = worldMapPoint(data, 530, corpse.x, corpse.y);
  assert.ok(placed.outland);
  near(u, placed.u, 1e-6, "corpse u");
  near(v, placed.v, 1e-6, "corpse v");
  assert.deepEqual([...map.getDeathReleasePosition()], [0, 0], "none: (0, 0)");
});

// ---- The stock WorldMapFrame on the Azeroth map: the player arrow and the capitals' icons. ----

const chain = clientDirectory ? await (await import("../tools/mpq.mjs")).clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

test("stock WorldMapFrame on the Azeroth map: WorldMapPlayer at Goldshire and the capitals' POI icons", withClient, async () => {
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const { WorldState } = await import("../dist/code/world/WorldState.js");
  const { WorldStore } = await import("../dist/code/world/WorldStore.js");

  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  const PLAYER = 0x10n;
  const offset = (name) => UPDATE_FIELDS[name].offset;
  const world = new WorldClient({ send() {}, close() {} });
  const state = new WorldState();
  world.state = state;
  state.objects.set(PLAYER, {
    guid: PLAYER, typeId: 4, position: { x: -9_460, y: 60, z: 57, orientation: 0 }, movementFlags: 0, updateFlags: 0,
    fields: new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (2 << 8)], [offset("UNIT_FIELD_LEVEL"), 10],
      [offset("UNIT_FIELD_HEALTH"), 400], [offset("UNIT_FIELD_MAXHEALTH"), 400]]),
  });
  state.selfGuid = PLAYER;
  world.mapId = 0;
  world.selfName = "Флик";
  world.currentGameTime = () => ({ minuteOfDay: 600, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } });
  world.calendarPending = 0;
  const store = new WorldStore(state);
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store,
    spell: (id) => ({ id, name: "Проверка", rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    mapSource: {
      metadata: () => data,
      location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_460, y: 60, orientation: 0 }),
      corpseLocation: () => null, deathReleaseLocation: () => null, isExploredArea: () => true,
    },
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const decoder = new TextDecoder();
  const boot = new FrameXmlBoot({
    provider: { async read(path) {
      const bytes = await chain.read(path.replaceAll("/", "\\"));
      return bytes ? decoder.decode(bytes) : undefined;
    } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1280, height: 768 }),
  });
  const lua = (code, results = 0) => {
    const fn = boot.vm.compileFunction(code, "@worldmap-azeroth", []);
    assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
    try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
  };
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`);
  try {
    await boot.load();
    boot.bridge.Show(boot.bridge.getFrame("UIParent"));
    seam.tick(5);
    const baseline = failures().length;
    lua("ToggleFrame(WorldMapFrame)");
    lua("SetMapZoom(0)");
    seam.map.tick();
    seam.tick(1);
    // The icon cell each landmark asks for, as WorldMapFrame_Update hands it to WorldMap_GetPOITextureCoords.
    lua(`AZEROTH_TEST_ICONS = {}
      local original = WorldMap_GetPOITextureCoords
      WorldMap_GetPOITextureCoords = function(index) AZEROTH_TEST_ICONS[#AZEROTH_TEST_ICONS + 1] = index; return original(index) end
      WorldMapFrame_Update()
      WorldMap_GetPOITextureCoords = original
      WorldMapButton_OnUpdate(WorldMapButton, 0.1)`);
    assert.deepEqual(failures().slice(baseline).filter((failure) => /worldmap/i.test(failure)), [], "no world-map Lua error");
    const [continentIndex, shown, px, py, width, height] = lua(`local _, _, _, x, y = WorldMapPlayer:GetPoint(1)
      return GetCurrentMapContinent(), WorldMapPlayer:IsShown() and 1 or 0, x or 0, y or 0,
        WorldMapDetailFrame:GetWidth(), WorldMapDetailFrame:GetHeight()`, 6);
    assert.equal(continentIndex, 0, "the Azeroth map");
    assert.equal(shown, 1, "the player arrow is shown");
    const placed = worldMapPoint(data, 0, -9_460, 60);
    near(px / width, placed.u, 1e-4, "arrow x on the detail frame");
    near(-py / height, placed.v, 1e-4, "arrow y on the detail frame");

    const [list] = lua(`local out = {}
      for i = 1, NUM_WORLDMAP_POIS do
        local frame = _G["WorldMapFramePOI"..i]
        if frame:IsShown() then
          local _, _, _, x, y = frame:GetPoint(1)
          out[#out + 1] = tostring(frame.name) .. "|" .. string.format("%.5f|%.5f", x / WorldMapButton:GetWidth(),
            -y / WorldMapButton:GetHeight()) .. "|" .. tostring(AZEROTH_TEST_ICONS[i])
        end
      end
      return table.concat(out, ";")`, 1);
    const pois = String(list).split(";").map((entry) => entry.split("|"));
    const capitals = capitalRows();
    assert.deepEqual(pois.map(([name]) => name), capitals.map((row) => row.name), "one POI frame per capital");
    for (const [index, row] of capitals.entries()) {
      const at = worldMapPoint(data, row.mapId, row.x, row.y);
      near(Number(pois[index][1]), at.u, 1e-3, `${row.name} x`);
      near(Number(pois[index][2]), at.v, 1e-3, `${row.name} y`);
      assert.equal(pois[index][3], "6", `${row.name}: the city icon cell`);
    }
  } finally {
    boot.close();
  }
});
