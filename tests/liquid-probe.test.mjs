import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTerrainProbe } from "../dist/code/browser/input/Movement.js";
import { LIQUID_UNKNOWN, newCharacterMotion, stepCharacter } from "../dist/code/browser/game/Physics.js";
import { CollisionSource } from "../dist/code/browser/game/CollisionSource.js";
import { TerrainTile } from "../dist/code/browser/Terrain.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { parseVMapModelGroups } from "../dist/code/gateway/VMapModel.js";
import { parseVMapTile } from "../dist/code/gateway/VMapProtocol.js";

/** The terrain client's half, with a lake of `surface` over flat ground at `ground`. */
function terrain({ ground = 0, surface, ready = true } = {}) {
  return {
    heightAt: () => (ready ? ground : undefined),
    liquidAt: () => (ready && surface !== undefined ? { height: surface, type: 1, entry: 1, cells: true } : undefined),
    isHole: () => false,
    isReady: () => ready,
  };
}

/** A collision source stand-in: one room floor at `floorZ`, or the state it is asked to answer. */
function collision({ state, floorZ = 0, groupFlags = 0x2000, liquid, calls = [] } = {}) {
  const placement = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, modelName: "Room.wmo" };
  const floor = { revision: 1, placement, floorZ, triangle: 0, groupIndex: 0, groupId: 904, groupFlags };
  const group = { bounds: { minX: -10, minY: -10, minZ: -10, maxX: 10, maxY: 10, maxZ: 30 }, groupId: 904, liquid };
  const hit = { z: floorZ, flags: groupFlags, instanceId: 7, triangle: 0, groupIndex: 0, groupId: 904 };
  return {
    revision: 1,
    world: { size: 1, floorHitUnder: () => hit, pushOut: (x, y) => ({ x, y }) },
    models: { model: () => ({ groups: [group] }) },
    staticWmoFloorState: (_map, x, y, fromZ, minZ, known) => {
      calls.push({ x, y, fromZ, minZ, known });
      return state !== undefined ? state() : floor;
    },
  };
}

/** One flat liquid cell over the room's middle, `height` in the room's own space. */
function roomWater(height) {
  return {
    tilesX: 1, tilesY: 1, cornerX: -2, cornerY: -2, cornerZ: height, type: 13,
    heights: Float32Array.of(height, height, height, height), flags: Uint8Array.of(0),
  };
}

test("the probe answers not-yet while the collision or the map tile under the feet is not here", () => {
  // Not the same as dry: the physics holds its last answer through these rather than dropping a
  // swimmer onto the bed of the pool for the frames a tile takes.
  const pending = createTerrainProbe(terrain({ surface: 5 }), collision({ state: () => undefined }), 604);
  assert.equal(pending.liquid(0, 0, 1), LIQUID_UNKNOWN);
  const loading = createTerrainProbe(terrain({ ready: false }), undefined, 0);
  assert.equal(loading.liquid(0, 0, 1), LIQUID_UNKNOWN);
  // A map tile that answered and holds no ground at all is a real answer, not a wait.
  const missing = { ...terrain(), heightAt: () => undefined, isReady: () => true };
  assert.equal(createTerrainProbe(missing, undefined, 0).liquid(0, 0, 1), undefined);
  // Without any collision client the map's water is the whole answer, as it always was.
  assert.equal(createTerrainProbe(terrain({ surface: 5 }), undefined, 0).liquid(0, 0, 1)?.height, 5);
});

test("the probe reads the room's own water in world space and keeps the map's water out of an interior", () => {
  const wet = createTerrainProbe(terrain(), collision({ floorZ: 2, liquid: roomWater(6) }), 604);
  assert.equal(wet.liquid(0, 0, 3)?.height, 6, "the room's MLIQ, placed");
  assert.equal(wet.liquid(0, 0, 9)?.height, 6, "and still there for a body over the surface");
  // The same room holding no water, standing in a lake whose surface is over its floor.
  const dome = createTerrainProbe(terrain({ surface: 20 }), collision({ floorZ: 2 }), 604);
  assert.equal(dome.liquid(0, 0, 3), undefined, "an interior room is dry under the lake");
  const deck = createTerrainProbe(terrain({ surface: 20 }), collision({ floorZ: 2, groupFlags: 0x8 }), 604);
  assert.equal(deck.liquid(0, 0, 3)?.height, 20, "open air is not");
  // No room under the feet at all: the map's water.
  const field = createTerrainProbe(terrain({ surface: 20 }), collision({ state: () => null }), 604);
  assert.equal(field.liquid(0, 0, 3)?.height, 20);
});

test("the liquid query reads the room from the column the floor query just walked at the same feet", () => {
  const calls = [];
  const probe = createTerrainProbe(terrain(), collision({ floorZ: 2, liquid: roomWater(6), calls }), 604);
  probe.floor(1, 2, 4.6, -397);
  probe.liquid(1, 2, 3);
  assert.equal(calls.at(-1).fromZ, 3.1, "the server's location ray starts a tenth over the feet");
  assert.equal(calls.at(-1).minZ, -397);
  assert.deepEqual(
    { fromZ: calls.at(-1).known?.fromZ, minZ: calls.at(-1).known?.minZ, z: calls.at(-1).known?.hit?.z },
    { fromZ: 4.6, minZ: -397, z: 2 });
  probe.liquid(1.5, 2, 3);
  assert.equal(calls.at(-1).known, undefined, "a column walked somewhere else says nothing here");
});

// ---------------------------------------------------------------------------------------------
// Gundrak (map 604), 2026-09-28: the dungeon is 25 flat, dry map tiles and one WMO whose water is
// all MLIQ. Reading the map file alone, a drop into its channel fell 1.3 s to the bed; the owner's
// priest bot casts Levitate on a master falling for more than a second.

let dataset;
try {
  dataset = (await import("../tools/paths.mjs")).datasetDirectory();
} catch {
  dataset = undefined;
}
const GUNDRAK_FILES = dataset === undefined ? [] : [
  join(dataset, "vmaps", "Gundrakinterior.wmo.vmo"),
  join(dataset, "vmaps", "604_30_28.vmtile"),
  join(dataset, "maps", "6042830.map"),
];
const withGundrak = {
  skip: GUNDRAK_FILES.length > 0 && GUNDRAK_FILES.every((file) => existsSync(file))
    ? false : "the tswow dataset with Gundrak (map 604) is not on this machine",
};

test("Gundrak: a drop into the channel swims, the pool is waded, the entrance stays dry", withGundrak, async () => {
  const [vmo, vmtile, map] = await Promise.all(GUNDRAK_FILES.map((file) => readFile(file)));
  const model = decodeCollisionModel(encodeCollisionModel(parseVMapModelGroups(vmo)).buffer);
  const objects = parseVMapTile(vmtile);
  assert.ok(objects.some((object) => object.name === "Gundrakinterior.wmo"));
  const tile = new TerrainTile(map.buffer.slice(map.byteOffset, map.byteOffset + map.byteLength));
  const ground = {
    heightAt: (_map, x, y) => tile.heightAt(x, y),
    liquidAt: (_map, x, y) => tile.liquidAt(x, y),
    isHole: () => false,
    isReady: () => true,
  };
  assert.equal(tile.liquidAt(1813.03, 739.09), undefined, "the map file has no water here at all");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => (String(input).includes("/environment/604/")
    ? new Response(JSON.stringify(objects), { status: 200 })
    : new Response(null, { status: 404 }));
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    source.models.model = (name) => (name === "Gundrakinterior.wmo" ? model : undefined);
    source.models.isResolved = () => true;
    source.models.requestGroups = () => {};
    const walk = source.world.floorHitUnder.bind(source.world);
    let roomWalks = 0;
    source.world.floorHitUnder = (x, y, fromZ, minZ, accept) => {
      if (accept) roomWalks++;
      return walk(x, y, fromZ, minZ, accept);
    };
    const human = {
      forward: 0, strafe: 0, ascend: false, descend: false, pitch: 0, runSpeed: 7, swimSpeed: 4.722222,
      flightSpeed: 7, collisionHeight: 2.031, radius: 0.3055, rooted: false, waterWalking: false,
      featherFall: false, hovering: false, hoverHeight: 1, canFly: false, gravityDisabled: false,
    };
    const run = async (start, seconds) => {
      for (let attempt = 0; attempt < 50 && !source.isReady(604, start.x, start.y); attempt++) {
        source.refresh(604, start.x, start.y);
        await new Promise((resolve) => setImmediate(resolve));
      }
      source.refresh(604, start.x, start.y);
      const probe = createTerrainProbe(ground, source, 604);
      const position = { ...start, orientation: 0 };
      const motion = newCharacterMotion();
      const events = [];
      let longestFall = 0;
      for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) {
        source.refresh(604, position.x, position.y);
        events.push(...stepCharacter(position, motion, human, probe, 1 / 60));
        longestFall = Math.max(longestFall, motion.fallTime);
      }
      return { position, motion, events, longestFall };
    };

    // Entrance south (`areatrigger_teleport` 5205): a dry floor 176.7 yards up.
    const entrance = await run({ x: 1880.74, y: 853.76, z: 176.696 }, 2);
    assert.deepEqual(entrance.events, []);
    assert.ok(Math.abs(entrance.position.z - 176.696) < 0.01);

    // Channel of group 1: surface 110.01, bed 94.35 — dropped from a yard over the water.
    const channel = await run({ x: 1813.03, y: 739.09, z: 111.01 }, 4);
    assert.deepEqual(channel.events.filter((event) => event !== "startAscend" && event !== "stopAscend"),
      ["startFall", "startSwim"], "into the water, and never onto the bed");
    assert.equal(channel.motion.mode, "swim");
    assert.ok(channel.longestFall < 1000, `a ${channel.longestFall} ms fall is under Levitate's second`);
    assert.ok(channel.position.z > 105 && channel.position.z <= 110.01, `swimming at ${channel.position.z}`);

    // Chest-deep in the same channel (bed 108.48): 1.53 yards is over half a 2.031-yard body.
    const chest = await run({ x: 1733.86, y: 818.26, z: 108.48 }, 1);
    assert.deepEqual(chest.events, ["startSwim"]);

    // The shallow pool of group 8: surface 135.50 over a bed at 135.12 is waded.
    const pool = await run({ x: 1938.03, y: 780.76, z: 135.12 }, 1);
    assert.deepEqual(pool.events, []);
    assert.equal(pool.motion.mode, "ground");

    assert.equal(roomWalks, 0, "every liquid query read its room from the floor query's own column");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
