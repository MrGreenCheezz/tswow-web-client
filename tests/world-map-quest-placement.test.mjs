import assert from "node:assert/strict";
import test from "node:test";

import {
  questMarkerBelongsToNode,
  questMarkerMatchesFloor,
  questMarkerPlacement,
  worldMapDescendantPlacement,
} from "../dist/code/browser/ui/WorldMapQuestPlacement.js";
import { WorldMapHierarchy } from "../dist/code/browser/ui/WorldMapHierarchy.js";

function area(id, mapId, areaId, name, bounds, extra = {}) {
  return {
    id, mapId, areaId, name,
    left: bounds[0], right: bounds[1], top: bounds[2], bottom: bounds[3],
    displayMapId: -1, defaultDungeonFloor: 0, parentWorldMapId: 0,
    ...extra,
  };
}

function fixture() {
  return new WorldMapHierarchy({
    areas: [
      { id: 12, name: "Элвиннский лес" },
      { id: 3430, name: "Леса Вечной Песни" },
    ],
    maps: [
      { id: 0, name: "Восточные королевства" },
      { id: 1, name: "Калимдор" },
      { id: 530, name: "Запределье" },
    ],
    mapAreas: [
      area(13, 1, 0, "Kalimdor", [17066, -19733, 12799, -11733]),
      area(14, 0, 0, "Azeroth", [18171, -22569, 11176, -15973]),
      area(466, 530, 0, "Expansion01", [12996, -4468, 5821, -5821]),
      area(30, 0, 12, "Elwynn", [1535, -1935, -7939, -10254]),
      area(462, 530, 3430, "EversongWoods", [-4487, -9412, 11041, 7758], {
        displayMapId: 0,
      }),
    ],
    continents: [
      { id: 1, mapId: 0, left: 26, right: 44, top: 8, bottom: 60, offsetX: 16.875, offsetY: -1.5, scale: 0.7, worldMapId: 1 },
      { id: 2, mapId: 1, left: 16, right: 46, top: 9, bottom: 52, offsetX: -20.1875, offsetY: 3.3125, scale: 0.7, worldMapId: 1 },
      { id: 3, mapId: 530, left: 23, right: 47, top: 15, bottom: 61, offsetX: 14.5, offsetY: -7, scale: 0.75, worldMapId: 0 },
    ],
    transforms: [{
      id: 2, mapId: 530,
      regionBottom: 4800, regionRight: -10133.333, regionTop: 16000, regionLeft: -2666.666,
      newMapId: 0, offsetX: -2400, offsetY: 2400, newDungeonMapId: 0,
    }],
  });
}

function marker(worldMapAreaId, map, centroid) {
  return {
    questId: 77, title: "Волки у ворот", ordinal: 1, poiIndex: 10, objectiveIndex: 0,
    kind: "creature", id: 299, label: "Лесной волк", have: 3, need: 10,
    done: false, state: "active", blob: {}, worldMapAreaId, map, floor: 0,
    points: centroid ? [centroid] : [], centroid,
  };
}

test("quest positions remain exact on area maps and collapse to authored branches globally", () => {
  const hierarchy = fixture();
  const elwynn = hierarchy.node("area:30");
  const eastern = hierarchy.node("area:14");
  const world = hierarchy.node("world:1");
  const cosmic = hierarchy.root;
  const objective = marker(30, 0, { x: -9000, y: 0 });

  assert.deepEqual(questMarkerPlacement(hierarchy, elwynn, objective), {
    point: { u: 1535 / (1535 + 1935), v: (-7939 + 9000) / (-7939 + 10254) },
    precision: "point",
  });
  assert.equal(questMarkerPlacement(hierarchy, eastern, objective)?.precision, "point");
  assert.equal(questMarkerPlacement(hierarchy, world, objective)?.precision, "area");
  assert.equal(questMarkerPlacement(hierarchy, cosmic, objective)?.precision, "area");
  assert.equal(questMarkerBelongsToNode(hierarchy, hierarchy.node("area:466"), objective), false);
});

test("virtual-map points use the DBC transform and missing points never become local (0,0)", () => {
  const hierarchy = fixture();
  const eastern = hierarchy.node("area:14");
  const eversong = hierarchy.node("area:462");
  const transformed = questMarkerPlacement(
    hierarchy, eastern, marker(462, 530, { x: 9000, y: -6000 }),
  );
  assert.equal(transformed?.precision, "point");
  assert.ok(Math.abs(transformed.point.u - ((18171 + 3600) / (18171 + 22569))) < 1e-9);
  assert.ok(Math.abs(transformed.point.v - ((11176 - 6600) / (11176 + 15973))) < 1e-9);

  assert.equal(questMarkerPlacement(hierarchy, eversong, marker(462, 530, undefined)), undefined,
    "the exact map has no honest point without server coordinates");
  assert.equal(questMarkerPlacement(hierarchy, eastern, marker(462, 530, undefined))?.precision, "area",
    "an ancestor may still point to the server-authored region");
  assert.equal(worldMapDescendantPlacement(hierarchy, eastern, eversong, 530, { x: 0, y: 0 })?.precision,
    "area", "an out-of-region transform falls back to the authored region, not a fake exact point");
});

test("a positive POI floor is hidden from a different authored dungeon floor", () => {
  const hierarchy = fixture();
  const node = hierarchy.node("area:30");
  node.mapArea.defaultDungeonFloor = 2;
  const objective = marker(30, 0, { x: -9000, y: 0 });
  assert.equal(questMarkerMatchesFloor(node, { ...objective, floor: 2 }), true);
  assert.equal(questMarkerMatchesFloor(node, { ...objective, floor: 3 }), false);
  assert.equal(questMarkerMatchesFloor(node, { ...objective, floor: 0 }), true,
    "floor zero is the server's unspecified/outdoor fallback");
});
