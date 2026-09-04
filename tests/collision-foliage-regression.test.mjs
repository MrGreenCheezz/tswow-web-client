import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function sourceModule(path, replacements = []) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const wvmUrl = new URL("../dist/code/browser/Wvm.js", import.meta.url).href;
const collisionFormatUrl = new URL("../dist/code/world/CollisionFormat.js", import.meta.url).href;
const collisionClientUrl = new URL("../dist/code/browser/CollisionClient.js", import.meta.url).href;
const terrainUrl = new URL("../dist/code/browser/Terrain.js", import.meta.url).href;
const collisionUrl = new URL("../dist/code/browser/game/Collision.js", import.meta.url).href;
const physics = await sourceModule("../src/browser/game/Physics.ts");
const wind = await sourceModule("../src/browser/VegetationWind.ts", [
  ['"./Wvm.js"', JSON.stringify(wvmUrl)],
]);
const collisionClient = await sourceModule("../src/browser/CollisionClient.ts", [
  ['"../world/CollisionFormat.js"', JSON.stringify(collisionFormatUrl)],
]);
const collisionSource = await sourceModule("../src/browser/game/CollisionSource.ts", [
  ['"../CollisionClient.js"', JSON.stringify(collisionClientUrl)],
  ['"../Terrain.js"', JSON.stringify(terrainUrl)],
  ['"./Collision.js"', JSON.stringify(collisionUrl)],
]);
const collisionFormat = await import(collisionFormatUrl);
const {
  BLEND_ALPHA_KEY, MATERIAL_NO_DEPTH_TEST, MATERIAL_TWO_SIDED, MATERIAL_UNLIT,
} = await import(wvmUrl);

function input(overrides = {}) {
  return {
    forward: 0, strafe: 0, ascend: false, descend: false, pitch: 0,
    runSpeed: 7, swimSpeed: 4.7, flightSpeed: 7,
    collisionHeight: 2.03128, radius: 0.389,
    rooted: false, waterWalking: false, featherFall: false, hovering: false,
    hoverHeight: 0, canFly: false, gravityDisabled: false,
    ...overrides,
  };
}

test("a VMAP floor still holds the player where the terrain deliberately has a hole", () => {
  const position = { x: 0, y: 0, z: 4, orientation: 0 };
  const motion = physics.newCharacterMotion();
  const events = physics.stepCharacter(position, motion, input(), {
    ground: () => undefined,
    liquid: () => undefined,
    hole: () => true,
    floor: () => 4,
  }, 1 / 60);
  assert.deepEqual(events, []);
  assert.equal(motion.mode, "ground");
  assert.equal(position.z, 4);
});

test("authored NoDXT ground-cover grass receives wind outside the Elwynn-only exception", () => {
  const model = {
    batches: [{
      submesh: 0, blendMode: BLEND_ALPHA_KEY, materialFlags: MATERIAL_TWO_SIDED,
      priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0], shaderId: 0,
      colorIndex: 0xffff, textureWeight: -1, textureTransform: -1,
    }],
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
  };
  assert.equal(wind.isVegetationWindBatch(
    model,
    0,
    "World\\NoDXT\\Detail\\DuskwoodDetails.blp",
    "World\\NoDXT\\Detail\\DskGra03.m2",
  ), true);
});

test("authored foliage may be unlit, while depthless effects and rigid bark stay still", () => {
  const model = (materialFlags) => ({
    batches: [{
      submesh: 0, blendMode: BLEND_ALPHA_KEY, materialFlags,
      priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0], shaderId: 0,
      colorIndex: 0xffff, textureWeight: -1, textureTransform: -1,
    }],
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
  });
  const cattail = "World\\Expansion02\\Doodads\\Scholazar\\Bushes\\Sholazar_CattailB.m2";
  assert.equal(wind.isVegetationWindBatch(
    model(MATERIAL_UNLIT | MATERIAL_TWO_SIDED), 0, "World\\Plants\\CattailLeaves.blp", cattail,
  ), true, "lighting mode does not make a plant rigid");
  assert.equal(wind.isVegetationWindBatch(
    model(MATERIAL_NO_DEPTH_TEST | MATERIAL_TWO_SIDED), 0, "World\\Plants\\CattailLeaves.blp", cattail,
  ), false, "a depthless effect card is not world foliage");
  assert.equal(wind.isVegetationWindBatch(
    model(MATERIAL_TWO_SIDED), 0, "World\\Trees\\OakBark.blp", "World\\Trees\\OakTree01.m2",
  ), false, "rigid bark stays anchored");
});

test("a transient collision-model failure stays unresolved and can be retried", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return requests === 1
      ? new Response(null, { status: 503 })
      : new Response(null, { status: 204 });
  };
  try {
    const client = new collisionClient.CollisionClient("ws://localhost:1234/world");
    assert.equal(client.model("Tree.m2"), undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.isResolved("Tree.m2"), false, "a transport failure is not an authored no-collision answer");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(client.model("Tree.m2"), undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    assert.equal(client.isResolved("Tree.m2"), true, "the retry's 204 is a real resolved empty answer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a transient collision-tile failure stays behind the readiness barrier and retries", async () => {
  const originalFetch = globalThis.fetch;
  const requests = new Map();
  let failedUrl;
  globalThis.fetch = async (input) => {
    const address = String(input);
    if (!address.includes("/environment/")) throw new Error(`unexpected model request ${input}`);
    const count = (requests.get(address) ?? 0) + 1;
    requests.set(address, count);
    failedUrl ??= address;
    return address === failedUrl && count === 1
      ? new Response(null, { status: 503 })
      : new Response(null, { status: 204 });
  };
  try {
    const source = new collisionSource.CollisionSource("ws://localhost:1234/world");
    source.refresh(1, 0, 0);
    assert.equal(source.isReady(1, 0, 0), false);
    await new Promise((resolve) => setImmediate(resolve));
    source.refresh(1, 0, 0);
    assert.equal(source.isReady(1, 0, 0), false,
      "a transport failure is not an authored empty VMAP tile");
    await new Promise((resolve) => setTimeout(resolve, 120));
    source.refresh(1, 0, 0);
    await new Promise((resolve) => setImmediate(resolve));
    source.refresh(1, 0, 0);
    assert.equal(requests.get(failedUrl), 2,
      "the cooldown wakes one retry for the failed tile rather than requesting every frame");
    assert.ok([...requests.values()].every((count) => count <= 2));
    assert.equal(source.isReady(1, 0, 0), true, "the retry's 204 is a resolved empty tile");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a transient streamed WMO-group failure can be retried", async () => {
  const originalFetch = globalThis.fetch;
  const group = {
    bounds: { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 3 },
    flags: 0x2000,
    groupId: 904,
    vertices: Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0),
    indices: Uint32Array.of(0, 1, 2),
  };
  const header = collisionFormat.encodeCollisionModel([group], new Set());
  const complete = collisionFormat.encodeCollisionModel([group], new Set([0]));
  let groupRequests = 0;
  globalThis.fetch = async (input) => {
    if (!String(input).includes("groups=")) return new Response(header, { status: 200 });
    groupRequests++;
    return groupRequests === 1
      ? new Response(null, { status: 503 })
      : new Response(complete, { status: 200 });
  };
  try {
    const client = new collisionClient.CollisionClient("ws://localhost:1234/world");
    client.model("Inn.wmo");
    await new Promise((resolve) => setImmediate(resolve));
    const model = client.model("Inn.wmo");
    assert.ok(model);
    assert.equal(model.groups[0].vertices, undefined);

    client.requestGroups("Inn.wmo", [0]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(model.groups[0].vertices, undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    client.requestGroups("Inn.wmo", [0]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(groupRequests, 2);
    assert.deepEqual([...model.groups[0].vertices], [...group.vertices]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
