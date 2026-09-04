import assert from "node:assert/strict";
import test from "node:test";

import {
  WorldMapHierarchy,
  worldMapNavigate,
} from "../dist/code/browser/ui/WorldMapHierarchy.js";

function mapArea(id, mapId, areaId, name, bounds, extra = {}) {
  return {
    id, mapId, areaId, name,
    left: bounds[0], right: bounds[1], top: bounds[2], bottom: bounds[3],
    displayMapId: -1, defaultDungeonFloor: 0, parentWorldMapId: 0,
    ...extra,
  };
}

function hierarchyFixture() {
  return new WorldMapHierarchy({
    areas: [
      { id: 12, parentId: 0, mapId: 0, name: "Элвиннский лес" },
      { id: 3430, parentId: 0, mapId: 530, name: "Леса Вечной Песни" },
      { id: 3524, parentId: 0, mapId: 530, name: "Остров Лазурной Дымки" },
      { id: 9000, parentId: 0, mapId: 900, name: "Подземелье" },
    ],
    maps: [
      { id: 0, name: "Восточные королевства" },
      { id: 1, name: "Калимдор" },
      { id: 530, name: "Запределье" },
      { id: 571, name: "Нордскол" },
      { id: 900, name: "Подземелье" },
    ],
    mapAreas: [
      mapArea(13, 1, 0, "Kalimdor", [17066, -19733, 12799, -11733]),
      mapArea(14, 0, 0, "Azeroth", [18171, -22569, 11176, -15973]),
      mapArea(466, 530, 0, "Expansion01", [12996, -4468, 5821, -5821]),
      mapArea(485, 571, 0, "Northrend", [9217, -8534, 10593, -1240]),
      mapArea(30, 0, 12, "Elwynn", [1535, -1935, -7939, -10254]),
      // Physically on map 530, but authored to appear under the Eastern Kingdoms display map.
      mapArea(462, 530, 3430, "EversongWoods", [-4487, -9412, 11041, 7758], {
        displayMapId: 0,
      }),
      // Also physically map 530, but authored on the other display continent.
      mapArea(464, 530, 3524, "AzuremystIsle", [-10500, -14570.833, -2793.75, -5508.333], {
        displayMapId: 1,
      }),
      // A local map explicitly names another WorldMapArea row as its parent.
      mapArea(600, 900, 9000, "Dungeon", [-100, -200, -8000, -8100], {
        parentWorldMapId: 30,
      }),
      // Client data contains standalone dungeon/BG maps without a truthful visual parent.
      mapArea(601, 901, 9001, "Standalone", [500, -500, 500, -500]),
    ],
    continents: [
      { id: 1, mapId: 0, left: 26, right: 44, top: 8, bottom: 60, offsetX: 16.875, offsetY: -1.5, scale: 0.7, worldMapId: 1 },
      { id: 2, mapId: 1, left: 16, right: 46, top: 9, bottom: 52, offsetX: -20.1875, offsetY: 3.3125, scale: 0.7, worldMapId: 1 },
      { id: 3, mapId: 530, left: 23, right: 47, top: 15, bottom: 61, offsetX: 14.5, offsetY: -7, scale: 0.75, worldMapId: 0 },
      { id: 4, mapId: 571, left: 16, right: 45, top: 12, bottom: 33, offsetX: 1.8125, offsetY: -6.375, scale: 0.7, worldMapId: 1 },
    ],
    transforms: [
      {
        id: 2, mapId: 530,
        regionBottom: 4800, regionRight: -10133.333, regionTop: 16000, regionLeft: -2666.666,
        newMapId: 0, offsetX: -2400, offsetY: 2400, newDungeonMapId: 0,
      },
      {
        id: 3, mapId: 530,
        regionBottom: -6933.333, regionRight: -16000, regionTop: 533.333, regionLeft: -8000,
        newMapId: 1, offsetX: 10133.333, offsetY: 17600, newDungeonMapId: 0,
      },
    ],
  });
}

test("world-map hierarchy is derived from WorldMapID, DisplayMapID and ParentWorldMapID", () => {
  const hierarchy = hierarchyFixture();
  const cosmic = hierarchy.root;
  const azerothWorld = hierarchy.node("world:1");
  const outland = hierarchy.node("area:466");
  const eastern = hierarchy.node("area:14");
  const elwynn = hierarchy.node("area:30");
  const eversong = hierarchy.node("area:462");
  const azuremyst = hierarchy.node("area:464");
  const dungeon = hierarchy.node("area:600");
  const standalone = hierarchy.node("area:601");

  assert.equal(cosmic.kind, "cosmic");
  assert.equal(azerothWorld.name, "Азерот", "the stock World overview is the Azeroth planet");
  assert.deepEqual(new Set(hierarchy.children(cosmic).map((node) => node.key)),
    new Set(["area:466", "world:1"]), "a single-continent world opens directly from cosmic");
  assert.deepEqual(new Set(hierarchy.children(azerothWorld).map((node) => node.key)),
    new Set(["area:13", "area:14", "area:485"]));
  assert.equal(hierarchy.parent(outland)?.key, "cosmic");
  assert.equal(hierarchy.parent(eastern)?.key, "world:1");
  assert.equal(hierarchy.parent(elwynn)?.key, "area:14");
  assert.equal(hierarchy.parent(eversong)?.key, "area:14",
    "DisplayMapID wins over the physical map when choosing the visual continent");
  assert.equal(hierarchy.parent(azuremyst)?.key, "area:13");
  assert.equal(hierarchy.parent(dungeon)?.key, "area:30",
    "an explicit ParentWorldMapID wins over the display-map fallback");
  assert.equal(hierarchy.parent(standalone), undefined,
    "a standalone local map must not become a fabricated Cosmic child");
  assert.deepEqual(new Set(hierarchy.children(cosmic).map((node) => node.key)),
    new Set(["area:466", "world:1"]));
});

test("right click climbs every authored level and left click opens the highlighted child", () => {
  const hierarchy = hierarchyFixture();
  const dungeon = hierarchy.node("area:600");

  const up = [];
  let current = dungeon;
  while (current) {
    up.push(current.key);
    current = worldMapNavigate(hierarchy, current, 2, 0.5, 0.5);
  }
  assert.deepEqual(up, ["area:600", "area:30", "area:14", "world:1", "cosmic"]);

  const cosmic = hierarchy.root;
  assert.equal(worldMapNavigate(hierarchy, cosmic, 0, 0.2, 0.35)?.key, "area:466");
  const world = worldMapNavigate(hierarchy, cosmic, 0, 0.8, 0.65);
  assert.equal(world?.key, "world:1");

  const kalimdor = worldMapNavigate(hierarchy, world, 0, 0.15, 0.5);
  assert.equal(kalimdor?.key, "area:13");

  const eastern = hierarchy.node("area:14");
  assert.equal(hierarchy.targets(hierarchy.node("area:30"))
    .some((target) => target.node.key === "area:600"), false,
    "a cross-map ParentWorldMapID edge has navigation but no fabricated coordinate hitbox");
  const elwynnTarget = hierarchy.targets(eastern).find((target) => target.node.key === "area:30");
  assert.ok(elwynnTarget);
  const u = elwynnTarget.rect.left + elwynnTarget.rect.width / 2;
  const v = elwynnTarget.rect.top + elwynnTarget.rect.height / 2;
  assert.equal(worldMapNavigate(hierarchy, eastern, 0, u, v)?.key, "area:30");

  const eversongTarget = hierarchy.targets(eastern).find((target) => target.node.key === "area:462");
  assert.ok(eversongTarget, "a DisplayMapID zone is placed through WorldMapTransforms");
  assert.ok(Math.abs(eversongTarget.rect.left - 0.49728) < 0.001,
    "the transformed rectangle, not raw map-530 coordinates, lands on the display continent");
  assert.deepEqual(hierarchy.projectPoint(530, 0, 9000, -6000), { x: 6600, y: -3600 });
  const kalimdorNode = hierarchy.node("area:13");
  const azuremystTarget = hierarchy.targets(kalimdorNode)
    .find((target) => target.node.key === "area:464");
  assert.ok(azuremystTarget, "Azuremyst is projected onto Kalimdor through its authored transform");
  const projectedAzuremystPoint = hierarchy.projectPoint(530, 1, -3000, -10000);
  assert.ok(projectedAzuremystPoint);
  assert.ok(Math.abs(projectedAzuremystPoint.x - 7133.333) < 1e-6);
  assert.equal(projectedAzuremystPoint.y, 7600);
  const azuremystPoint = hierarchy.displayPoint(kalimdorNode.mapArea, 530, -3000, -10000);
  assert.ok(azuremystPoint);
  assert.ok(Math.abs(azuremystPoint.u - 0.25718) < 0.001);
  assert.ok(Math.abs(azuremystPoint.v - 0.23095) < 0.001);
  assert.equal(hierarchy.projectPoint(530, 0, 0, 0), undefined,
    "a transform applies only inside its authored region");
});

test("continent hit rectangles use the stock WorldMapContinent transform", () => {
  const hierarchy = hierarchyFixture();
  const targets = new Map(hierarchy.targets(hierarchy.node("world:1"))
    .map((target) => [target.node.key, target.rect]));

  const eastern = targets.get("area:14");
  assert.ok(eastern);
  assert.ok(Math.abs(eastern.left - 0.698046875) < 1e-6);
  assert.ok(Math.abs(eastern.top - 0.2140625) < 1e-6);
  assert.ok(Math.abs(eastern.width - 0.196875) < 1e-6);
  assert.ok(Math.abs(eastern.height - 0.56875) < 1e-6);

  const kalimdor = targets.get("area:13");
  assert.ok(kalimdor.left < eastern.left && kalimdor.top > eastern.top);
  const northrend = targets.get("area:485");
  assert.ok(northrend.left > kalimdor.left && northrend.left < eastern.left);
  assert.ok(northrend.top < kalimdor.top);
});
