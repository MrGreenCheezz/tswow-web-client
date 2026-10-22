import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_RANGE,
  EnvironmentClient,
  TERRAIN_GRID_SIZE,
  terrainGridFootprint,
} from "../dist/code/browser/Terrain.js";
import { sameEnvironmentPlacement } from "../dist/code/browser/EnvironmentPlacementIdentity.js";

// 22.10 (7.34): Stormwind's city WMO is listed in 16 environment tiles under one id with equal fields. A tile landing
// or leaving must not hand the renderer another copy: it rebuilds a placement whose object changed, and the city
// vanished for a moment at a fixed line in the streets.

const tileCentre = (grid) => (31.5 - grid) * TERRAIN_GRID_SIZE;
const city = {
  id: 10047,
  kind: "wmo",
  name: "World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo",
  x: tileCentre(32) + 10,
  y: tileCentre(32) - 20,
  z: 95,
  rotationX: 0,
  rotationY: 128,
  rotationZ: 0,
  scale: 1,
  doodadSet: 0,
  nameSet: 0,
  bounds: { minX: -1000, minY: -900, minZ: 0, maxX: 1000, maxY: 900, maxZ: 300 },
};

/** Tiles named in `bodies` answer only when released; every other tile answers at once with nothing. */
function gatedFetch(bodies) {
  const gates = new Map();
  const fetch = async (url) => {
    const key = new URL(String(url)).pathname.split("/").slice(-2).join("/");
    if (bodies.has(key)) await new Promise((resolve) => gates.set(key, resolve));
    return new Response(JSON.stringify(bodies.get(key) ?? []), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, release: (key) => gates.get(key)?.() };
}

async function placementAfterLoad(client, x, y, id, accept) {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
    const object = client.objectsAround(7, x, y).find((entry) => entry.id === id);
    if (object && accept(object)) return object;
  }
  assert.fail(`placement ${id} did not settle`);
}

const keysOf = (x, y) => terrainGridFootprint(x, y, ENVIRONMENT_RANGE).map(({ x: gx, y: gy }) => `${gx}/${gy}`);

test("a placement spanning tiles keeps its object while tiles land and leave", async () => {
  const originalFetch = globalThis.fetch;
  // 33/32 follows 31/32 in footprint order, so its copy used to win the merge once it landed.
  const gate = gatedFetch(new Map([["31/32", [city]], ["33/32", [{ ...city, bounds: { ...city.bounds } }]]]));
  globalThis.fetch = gate.fetch;
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world");
    const x = tileCentre(32);
    const y = tileCentre(32);
    assert.ok(keysOf(x, y).includes("31/32") && keysOf(x, y).includes("33/32"));
    client.objectsAround(7, x, y);

    gate.release("31/32");
    const first = await placementAfterLoad(client, x, y, city.id, () => true);
    gate.release("33/32");
    await placementAfterLoad(client, x, y, city.id, () => client.stats.residentTiles === 9);
    assert.strictEqual(client.objectsAround(7, x, y).find((entry) => entry.id === city.id), first,
      "an equal copy landing in a later tile does not replace the object");

    // Walk east until the first tile leaves the footprint while the second stays.
    const eastX = tileCentre(34);
    assert.ok(!keysOf(eastX, y).includes("31/32") && keysOf(eastX, y).includes("33/32"));
    const after = await placementAfterLoad(client, eastX, y, city.id, () => client.stats.activeTiles === 0);
    assert.strictEqual(after, first, "the object outlives the tile it came from while an equal copy is in range");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a reused id with different fields still hands over the new placement", async () => {
  const originalFetch = globalThis.fetch;
  const moved = { ...city, x: city.x + 50 };
  const gate = gatedFetch(new Map([["31/32", [city]], ["33/32", [moved]]]));
  globalThis.fetch = gate.fetch;
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world");
    const x = tileCentre(32);
    const y = tileCentre(32);
    client.objectsAround(7, x, y);
    gate.release("31/32");
    const first = await placementAfterLoad(client, x, y, city.id, () => true);
    gate.release("33/32");
    const second = await placementAfterLoad(client, x, y, city.id, (object) => object.x === moved.x);
    assert.notStrictEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sameEnvironmentPlacement compares every field, one level into records", () => {
  const copy = { ...city, bounds: { ...city.bounds } };
  assert.equal(sameEnvironmentPlacement(city, copy), true);
  assert.equal(sameEnvironmentPlacement(city, { ...copy, bounds: { ...city.bounds, maxZ: 301 } }), false);
  assert.equal(sameEnvironmentPlacement(city, { ...copy, doodadSet: 1 }), false);
  const { nameSet: _nameSet, ...withoutNameSet } = copy;
  assert.equal(sameEnvironmentPlacement(city, withoutNameSet), false);
  const tinted = { ...copy, tint: [1, 1, 1, 1] };
  assert.equal(sameEnvironmentPlacement(tinted, { ...copy, tint: [1, 1, 1, 1] }), true);
  assert.equal(sameEnvironmentPlacement(tinted, { ...copy, tint: [1, 0.5, 1, 1] }), false);
});
