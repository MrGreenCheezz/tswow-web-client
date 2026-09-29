import assert from "node:assert/strict";
import test from "node:test";

import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  buildQuestLogView,
} from "../dist/code/world/QuestProtocol.js";
import {
  questMapObjectiveMarkers,
  questMarkerProgress,
  questWorldObjectiveMarkers,
} from "../dist/code/browser/ui/QuestObjectiveMarkers.js";

function questEntries() {
  const template = {
    questId: 77,
    title: "Волки у ворот",
    objectives: [
      { entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "" },
      { entry: 1617, count: 1, gameObject: true, itemDrop: 0, text: "" },
      { entry: 448, count: 1, gameObject: false, itemDrop: 0, text: "Особая цель" },
    ],
    itemObjectives: [{ itemId: 769, count: 8 }],
  };
  return buildQuestLogView(
    [{ slot: 0, questId: 77, state: 0, counters: [3, 0, 1, 0], timer: 0 }],
    new Map([[77, template]]),
    new Map([[769, 5]]),
  );
}

function blob(objectiveIndex, points = [{ x: 10, y: 20 }, { x: 30, y: 40 }]) {
  return {
    index: objectiveIndex + 10,
    objectiveIndex,
    map: 1,
    worldMapAreaId: 12,
    floor: 0,
    points,
  };
}

function object(guid, typeId, entry, { x = 10, y = 0, health = 100, position = true } = {}) {
  const fields = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
  ]);
  return {
    guid,
    typeId,
    position: position ? { x, y, z: 0, orientation: 0 } : undefined,
    fields,
  };
}

test("server POIs keep creature, game-object and item identity with progress and readiness", () => {
  const entries = questEntries();
  assert.deepEqual(entries[0].objectives.map((objective) => objective.poiIndex), [0, 1, 2, 4],
    "the wire reserves POI slots 0..3 for NPC/GO and 4..9 for required items");
  const poi = new Map([[77, [blob(0), blob(1), blob(2), blob(4), blob(-1)]]]);
  const names = new Map([
    ["creature:299", "Лесной волк"],
    ["gameObject:1617", "Сундук Братства"],
    ["creature:448", "Снежный волк"],
    ["item:769", "Кусок мяса вепря"],
  ]);

  const markers = questMapObjectiveMarkers(entries, poi, (kind, id) => names.get(`${kind}:${id}`));
  assert.deepEqual(markers.map(({ kind, id, label, state }) => [kind, id, label, state]), [
    ["creature", 299, "Лесной волк", "active"],
    ["gameObject", 1617, "Сундук Братства", "active"],
    ["creature", 448, "Снежный волк", "complete"],
    ["item", 769, "Кусок мяса вепря", "active"],
    ["quest", undefined, "Волки у ворот", "active"],
  ]);
  assert.deepEqual(markers.map(questMarkerProgress), ["3 / 10", "0 / 1", "1 / 1", "5 / 8", undefined]);
  assert.deepEqual(markers[0].centroid, { x: 20, y: 30 });

  const completedObjective = { ...entries[0], objectives: entries[0].objectives.map((objective, index) => (
    index === 1 ? { ...objective, have: 1, done: true } : objective
  )) };
  assert.equal(questMapObjectiveMarkers([completedObjective], poi)[1].state, "complete");
  const readyQuest = { ...entries[0], complete: true };
  assert.equal(questMapObjectiveMarkers([readyQuest], poi).at(-1).state, "ready");
});

test("3D markers use only loaded live creature and game-object positions", () => {
  const entries = questEntries();
  const objects = new Map([
    [1n, object(1n, 4, 0)],
    [2n, object(2n, 3, 299)],
    [3n, object(3n, 3, 299, { health: 0 })],
    [4n, object(4n, 5, 1617)],
    [5n, object(5n, 3, 769)],
    [6n, object(6n, 5, 1617, { position: false })],
  ]);
  const names = (kind, id) => kind === "creature" && id === 299 ? "Лесной волк"
    : kind === "gameObject" && id === 1617 ? "Сундук Братства" : undefined;

  const markers = questWorldObjectiveMarkers(entries, objects.values(), names);
  assert.deepEqual(markers.map(({ guid, kind, id, label }) => [guid, kind, id, label]), [
    [2n, "creature", 299, "Лесной волк"],
    [4n, "gameObject", 1617, "Сундук Братства"],
  ]);
  assert.equal(markers.some((marker) => marker.id === 769), false,
    "an item objective has no honest live-world object anchor");

  const done = { ...entries[0], objectives: entries[0].objectives.map((objective) => ({ ...objective, done: true })) };
  assert.deepEqual(questWorldObjectiveMarkers([done], objects.values()), []);
  assert.deepEqual(questWorldObjectiveMarkers([{ ...entries[0], complete: true }], objects.values()), []);
});

test("missing points and cleared metadata degrade to explicit fallbacks without invented positions", () => {
  const entries = questEntries();
  const names = new Map([["creature:299", "Лесной волк"]]);
  const resolve = (kind, id) => names.get(`${kind}:${id}`);
  const poi = new Map([[77, [blob(0, []), blob(99, [])]]]);

  const resolved = questMapObjectiveMarkers(entries, poi, resolve);
  assert.equal(resolved[0].label, "Лесной волк");
  assert.equal(resolved[0].centroid, undefined);
  assert.deepEqual(resolved[0].points, []);
  assert.deepEqual(
    { kind: resolved[1].kind, id: resolved[1].id, label: resolved[1].label, centroid: resolved[1].centroid },
    { kind: "quest", id: undefined, label: "Волки у ворот", centroid: undefined },
    "an unknown POI objective index remains quest-level instead of borrowing a neighbouring target",
  );

  names.clear();
  assert.equal(questMapObjectiveMarkers(entries, poi, resolve)[0].label, "Существо #299");
  names.set("creature:299", "Седой волк");
  assert.equal(questMapObjectiveMarkers(entries, poi, resolve)[0].label, "Седой волк",
    "the resolver owns no stale metadata cache after QUERY_CACHE_CHANGED:cleared");
  assert.deepEqual(questMapObjectiveMarkers(entries, new Map(), resolve), []);
});
