// 22.10 ARC-2 S2b — the lookups the world renderer made into main-thread clients while drawing (the game-object
// display rows, the creature display rows for a mount and the stand-in ledger, the collision models a building's
// water is built from) and the sampler the ground reticle's rings were laid with are plain data now: a pushed
// RenderLookups record (src/browser/RenderLookups.ts, src/browser/game/RenderLookupsBuilder.ts) and the rings'
// sampled heights (src/browser/SelectionRingHeights.ts). The data must cross `structuredClone`, answer exactly
// what the functions answered, and start no download the renderer did not ask for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { unit } from "../dist/code/world/Fields.js";
import { CollisionClient } from "../dist/code/browser/CollisionClient.js";
import { GameObjectMetadataClient } from "../dist/code/browser/GameObjectMetadata.js";
import { encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import {
  NO_RENDER_LOOKUPS, creatureDisplayAnswered, mountDisplayModel,
} from "../dist/code/browser/RenderLookups.js";
import { RenderLookupsBuilder, collisionModelName } from "../dist/code/browser/game/RenderLookupsBuilder.js";
import {
  GROUND_TARGET_POINT_RING, SELECTION_RING_SEGMENTS, sampleGroundTargetRings, sampleSelectionRingHeights,
} from "../dist/code/browser/SelectionRingHeights.js";
import { buildSelectionRingGeometry, updateSelectionRing } from "../dist/code/browser/WorldRenderer3D.js";
import { groundRingHeights } from "../dist/code/browser/game/GroundTargetPreview.js";

const F = UPDATE_FIELDS;
const source = (path) => readFileSync(new URL(`../src/browser/${path}`, import.meta.url), "utf8");

function rider(guid, displayId, mountDisplayId) {
  const fields = new Map([[F.UNIT_FIELD_DISPLAYID.offset, displayId]]);
  if (mountDisplayId !== undefined) fields.set(F.UNIT_FIELD_MOUNTDISPLAYID.offset, mountDisplayId);
  return { guid, typeId: 4, fields, position: { x: 0, y: 0, z: 0, orientation: 0 } };
}

/** A client whose only legal reads are the cache and its revision: any other call is a request. */
function readOnly(displays, revision) {
  return new Proxy({ displays, revision }, {
    get(target, key) {
      if (key in target) return target[key];
      throw new Error(`the lookups touched ${String(key)}`);
    },
  });
}

function collisionModelBytes() {
  const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return encodeCollisionModel([{
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 0 },
    flags: 0, groupId: 1, vertices, indices: new Uint32Array([0, 1, 2]),
  }]);
}

/** ui/Frames.ts `mountModelFor` before this slice, verbatim (Frames needs a DOM to import). */
function mountModelFor(object, creatureModels) {
  const displayId = unit.mountDisplayId(object) ?? 0;
  if (displayId <= 0 || !creatureModels) return undefined;
  return creatureModels.get(displayId);
}

async function settle() { for (let i = 0; i < 6; i++) await new Promise(setImmediate); }

test("the lookups record and the ring heights cross structuredClone unchanged", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(collisionModelBytes(), { status: 200 });
  try {
    const collision = new CollisionClient("ws://gateway.test/world");
    const builder = new RenderLookupsBuilder();
    const environment = [{ id: 1, kind: "wmo", name: "WORLD\\WMO\\CITY\\CITY.WMO", x: 0, y: 0, z: 0 }];
    const creatures = new Map([[7, { id: 7, model: "Horse.m2", scale: 1, textures: [] }]]);
    const objects = new Map([[9, { id: 9, model: "Chest.m2" }]]);
    builder.requestCollisionModels(collision, ["WORLD\\WMO\\CITY\\CITY.WMO"]);
    await settle();
    const lookups = builder.build({
      gameObjectMetadata: readOnly(objects, 4), creatureModels: readOnly(creatures, 2), collision, environment,
    });
    assert.equal(lookups.collisionModels.size, 1, "the landed model is in the record");
    const copy = structuredClone(lookups);
    assert.deepEqual(copy, { ...lookups }, "every field survives a clone");
    assert.deepEqual(structuredClone(NO_RENDER_LOOKUPS), { ...NO_RENDER_LOOKUPS });
    const rings = sampleGroundTargetRings({ x: 3, y: 4 }, 8, (x, y) => (x + y > 6 ? x * 0.5 : undefined));
    assert.deepEqual(structuredClone(rings), rings, "undefined samples survive as undefined");
  } finally {
    globalThis.fetch = original;
  }
});

test("game-object display rows answer every display id exactly as loopGameObjectDisplay did", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{ id: 10, model: "Door.m2" }, { id: 11, model: "Ship.wmo" }]));
  try {
    const client = new GameObjectMetadataClient("ws://gateway.test/world");
    await client.load([10, 11, 12]);
    const lookups = new RenderLookupsBuilder().build({
      gameObjectMetadata: client, creatureModels: undefined, collision: undefined, environment: [],
    });
    for (const displayId of [0, 10, 11, 12, -1]) {
      // Loop.ts `loopGameObjectDisplay` was `game.gameObjectMetadata?.get(displayId)`.
      assert.strictEqual(lookups.gameObjectDisplays.get(displayId), client.get(displayId), `display ${displayId}`);
    }
    assert.equal(lookups.gameObjectDisplayRevision, client.revision, "the revision draw was handed rides beside the rows");
    const none = new RenderLookupsBuilder().build({ gameObjectMetadata: undefined, creatureModels: undefined, collision: undefined, environment: [] });
    assert.equal(none.gameObjectDisplays?.get(10), undefined, "no client answers nothing, as the bound function did");
    assert.equal(none.gameObjectDisplayRevision, undefined, "and fails open on the revision");
  } finally {
    globalThis.fetch = original;
  }
});

test("a mount and the display-answered test read the pushed creature rows as the old functions read the client", () => {
  const horse = { id: 14, model: "Horse.m2", scale: 1, textures: [] };
  const elf = { id: 55, model: "NightElfMale.m2", scale: 1, textures: [] };
  const rows = new Map([[horse.id, horse], [elf.id, elf]]);
  const client = { get: (displayId) => rows.get(displayId) };
  const lookups = new RenderLookupsBuilder().build({
    gameObjectMetadata: undefined, creatureModels: readOnly(rows, 3), collision: undefined, environment: [],
  });
  const riders = [rider(1n, 55, 14), rider(2n, 55, 0), rider(3n, 55), rider(4n, 55, 999), rider(5n, 55, -3)];
  for (const subject of riders) {
    assert.strictEqual(mountDisplayModel(subject, lookups.creatureDisplays), mountModelFor(subject, client), `rider ${subject.guid}`);
  }
  assert.strictEqual(mountDisplayModel(riders[0], lookups.creatureDisplays), horse);
  assert.equal(mountDisplayModel(riders[0], undefined), undefined, "no client, no mount (bench harness)");
  for (const displayId of [0, 14, 55, 999]) {
    // Loop.ts `loopCreatureDisplayAnswered` was `game.creatureModels?.get(displayId) !== undefined`.
    assert.equal(creatureDisplayAnswered(displayId, lookups.creatureDisplays), client.get(displayId) !== undefined);
  }
  assert.match(source("CreatureModelClient.ts"), /get displays\(\): ReadonlyMap<number, CreatureModelMetadata> \{\s*return this\.#cache;/,
    "the pushed rows are the very cache `get` reads");
  assert.match(source("ui/Frames.ts"), /return mountDisplayModel\(object, creatureModels\);/,
    "the UI's mount lookup and the renderer's are one function");
  assert.match(source("GameObjectMetadata.ts"), /get displays\(\): ReadonlyMap<number, GameObjectDisplayMetadata> \{\s*return this\.#cache;/);
});

test("collision models: peeked for the environment's WMOs, downloaded only for what the renderer missed", async () => {
  const original = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input) => {
    const name = decodeURIComponent(new URL(String(input)).pathname.split("/").pop());
    fetched.push(name);
    return name === "Keep.wmo" ? new Response(null, { status: 204 }) : new Response(collisionModelBytes(), { status: 200 });
  };
  try {
    const collision = new CollisionClient("ws://gateway.test/world");
    const builder = new RenderLookupsBuilder();
    const city = "WORLD\\WMO\\AZEROTH\\CITY.WMO";
    const tower = "World/wmo/Tower.wmo";
    const keep = "WORLD\\WMO\\Keep.wmo";
    const environment = [
      { id: 1, kind: "wmo", name: city }, { id: 2, kind: "wmo", name: city }, { id: 3, kind: "wmo", name: tower },
      { id: 4, kind: "m2", name: "WORLD\\TREE.M2" }, { id: 5, kind: "wmo", name: keep },
    ];
    const sources = { gameObjectMetadata: undefined, creatureModels: undefined, collision, environment };
    let lookups = builder.build(sources);
    assert.equal(lookups.collisionModels.size, 0);
    assert.deepEqual(fetched, [], "building the record asks the gateway for nothing");

    // The renderer admitted the city and the keep and missed both; the tower was never admitted.
    builder.requestCollisionModels(collision, [city, keep]);
    assert.deepEqual(fetched, ["CITY.WMO", "Keep.wmo"], "exactly the misses, by the collision route's name, in order");
    await settle();
    const revision = lookups.collisionRevision;
    lookups = builder.build(sources);
    for (const name of [city, tower, keep]) {
      // EnterWorld's old function: `collision.models.model(collisionModelName(name))`, asked after the fact.
      assert.strictEqual(lookups.collisionModels.get(name), collision.peek(collisionModelName(name)), name);
    }
    assert.ok(lookups.collisionModels.get(city), "the landed city is there the first frame after it lands");
    assert.equal(lookups.collisionModels.has(tower), false, "the tower was never asked for and is not fetched");
    assert.equal(lookups.collisionModels.has(keep), false, "a model with no collision is a miss, as `model` answered");
    assert.ok(lookups.collisionRevision > revision, "a worker slice can post the map by this revision");
    assert.strictEqual(lookups.collisionModels.get(city), collision.model(collisionModelName(city)),
      "the record answers what the old function answered");
    assert.deepEqual(fetched, ["CITY.WMO", "Keep.wmo"], "and nothing more was downloaded");

    // A vmap tile naming the file differently folds the spelling without a revision; the next build still finds it.
    collision.preferSpelling("City.wmo");
    lookups = builder.build(sources);
    assert.strictEqual(lookups.collisionModels.get(city), collision.peek("CITY.WMO"));

    // Another world's client (or none) empties the map at once.
    lookups = builder.build({ ...sources, collision: undefined });
    assert.equal(lookups.collisionModels, undefined, "no collision, no lookups and no asks");
  } finally {
    globalThis.fetch = original;
  }
});

test("the reticle's ring heights lay the rings exactly where the sampler laid them, sampled in the same order", () => {
  const centre = { x: 100, y: 200, z: 50 };
  const ground = (x, y) => (Math.hypot(x - 100, y - 200) > 7 ? undefined : 50 + (x - 100) * 0.3 - (y - 200) * 0.05);
  for (const radius of [0, 0.5, 1, 8]) {
    // The old path: the renderer called the sampler while laying each ring.
    const before = [];
    const recordBefore = (x, y) => { before.push([x, y]); return ground(x, y); };
    const after = [];
    const recordAfter = (x, y) => { after.push([x, y]); return ground(x, y); };
    const heights = sampleGroundTargetRings(centre, radius, recordAfter);
    const rings = [["point", GROUND_TARGET_POINT_RING]];
    if (radius >= 1) rings.push(["radius", radius]);
    assert.equal(heights.radius === undefined, radius < 1, "the area ring only from a yard, as the renderer draws it");
    for (const [kind, ringRadius] of rings) {
      const old = buildSelectionRingGeometry();
      updateSelectionRing(old, centre, ringRadius, recordBefore);
      const pushed = buildSelectionRingGeometry();
      updateSelectionRing(pushed, centre, ringRadius, heights[kind]);
      assert.deepEqual([...pushed.getAttribute("position").array], [...old.getAttribute("position").array],
        `${kind} ring at radius ${radius}`);
    }
    assert.deepEqual(after, before, "the same points, in the same order");
  }
  // No height at the centre: no other sample, a flat ring, as before.
  const flat = sampleSelectionRingHeights(centre, 2, () => undefined);
  assert.deepEqual(flat, { middle: undefined, around: [] });
  assert.equal(sampleSelectionRingHeights(centre, 2, () => 1).around.length, 3 * (SELECTION_RING_SEGMENTS + 1));
  // The live entry point samples through the sampler it is given (the reticle's surfaces).
  const live = groundRingHeights({ x: 0, y: 0, z: 0, orientation: 0 }, { x: 100, y: 200, z: 50 }, 8, ground);
  assert.deepEqual(live, sampleGroundTargetRings(centre, 8, ground));
});

test("draw no longer takes the lookup functions, and nothing sets a collision function", () => {
  const renderer = source("WorldRenderer3D.ts");
  const drawAt = renderer.indexOf("  draw(\n");
  const signature = renderer.slice(drawAt, renderer.indexOf("): WorldSubmissionReceipt | undefined {", drawAt));
  assert.ok(drawAt >= 0 && signature.length > 0, "the draw signature is found");
  for (const gone of ["gameObjectMetadata:", "displayAnswered", "mountModel", "gameObjectMetadataRevision"]) {
    assert.equal(signature.includes(gone), false, `draw no longer takes ${gone}`);
  }
  // 22.10 ARC-2 S2c: the unit model is pushed too (render-unit-models.test.mjs); only the terrain sampler is left.
  assert.equal(signature.match(/\w+\??: \([^)]*\) =>/g), null);
  assert.doesNotMatch(renderer, /setCollisionModels\(|#collisionModels\b/, "the collision function is gone");
  assert.match(renderer, /ground\?: GroundTargetRingHeights \| undefined;/, "the reticle carries heights, not a sampler");

  const loop = source("game/Loop.ts");
  const call = loop.slice(loop.indexOf("renderer.draw("), loop.indexOf("renderer.renderPortraits(now)"));
  for (const gone of ["loopGameObjectDisplay", "loopCreatureDisplayAnswered", "mountModel", "gameObjectMetadata?.revision"]) {
    assert.equal(call.includes(gone), false, `the loop no longer hands draw ${gone}`);
  }
  assert.match(call, /renderLookups\.requestCollisionModels\(game\.collision\?\.models, renderer\.collisionModelWants\(\)\)/,
    "the misses are asked for right after draw, even when draw throws");
  assert.doesNotMatch(source("app/EnterWorld.ts"), /setCollisionModels\(/);
  assert.doesNotMatch(source("game/Context.ts"), /setCollisionModels\(/);
  assert.doesNotMatch(source("game/GroundTargetPreview.ts"), /ground: groundRingSampler/);
});
