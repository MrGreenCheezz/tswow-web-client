// 04.11 (7.62): the refined copies end to end: the name both sides compute, the route, what the page asks for, and what
// a job publishes when it is asked for a refined name.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway, visualModelCacheNamespace, visualModelHash as gatewayModelHash } from "../dist/code/gateway/Gateway.js";
import { parseRefinedModelsEnv, refinedModelFileHash } from "../dist/code/gateway/RefinedModelRoute.js";
import { isRefinedModelPath as worldPathRule, REFINED_MODEL_VERSION as WORLD_VERSION } from "../dist/code/world/RefinedModels.js";
import { noteGatewayAssetGenerations, resetGatewayGeneration } from "../dist/code/browser/GatewayGeneration.js";
import { setRefinedModelsEnabled } from "../dist/code/browser/RefinedModels.js";
import { visualAnimationsUrl, visualModelUrl } from "../dist/code/browser/Wvm.js";
import {
  isRefinedModelPath, REFINED_MODEL_VERSION, refinedModelHash, visualModelHash,
} from "../tools/visual-model-key.mjs";
import { isStoneModelPath, SMOOTH_TRIANGLE_LIMIT, refineModel } from "../tools/model-refine.mjs";

const ORIGIN = "http://127.0.0.1:5173";
const BASE = "http://127.0.0.1:8090";
const BARREL = "World\\Generic\\PassiveDoodads\\Barrel\\Barrel01.m2";
const WOLF = "Creature\\Wolf\\Wolf.m2";
const HUMAN = "Character\\Human\\Male\\HumanMale.m2";

test("the page, the gateway and the tools agree on which models and what name", () => {
  assert.equal(WORLD_VERSION, REFINED_MODEL_VERSION);
  for (const path of [BARREL, WOLF, "world/azeroth/x.m2", "creature/x/y.M2"]) {
    assert.equal(isRefinedModelPath(path), true, path);
    assert.equal(worldPathRule(path), true, path);
    assert.equal(refinedModelFileHash(visualModelCacheNamespace(path), path), refinedModelHash(path), path);
    assert.notEqual(refinedModelHash(path), visualModelHash(path), "never the plain model's file");
  }
  for (const path of [HUMAN, "Item\\ObjectComponents\\Weapon\\Sword.m2", "Spells\\Fire.m2", "World\\wmo\\x.wmo", "Interface\\Glues\\x.m2"]) {
    assert.equal(isRefinedModelPath(path), false, path);
    assert.equal(worldPathRule(path), false, path);
  }
  assert.equal(parseRefinedModelsEnv({}), true);
  assert.equal(parseRefinedModelsEnv({ REFINED_MODELS: "0" }), false);
  assert.equal(parseRefinedModelsEnv({ REFINED_MODELS: "off" }), false);
});

test("relief is for stone alone, by the path", () => {
  for (const path of ["World\\Azeroth\\Elwynn\\PassiveDoodads\\CliffRocks\\ElwynnCliffRock01.m2", "world\\kalimdor\\boulder03.m2", "world\\x\\rock02.m2"]) {
    assert.equal(isStoneModelPath(path), true, path);
  }
  for (const path of ["World\\Goblin\\Rocket01.m2", "World\\Generic\\Crock.m2", "World\\Lordaeron\\Brockton.m2", "Creature\\RockElemental\\Rock.m2", BARREL]) {
    assert.equal(isStoneModelPath(path), false, path);
  }
});

test("the page asks for a copy only when it is wanted, the gateway serves them, and the path has one", () => {
  try {
    const plain = visualModelUrl(BASE, BARREL);
    assert.ok(!plain.includes("refined="));
    setRefinedModelsEnabled(true);
    assert.equal(visualModelUrl(BASE, BARREL), plain, "no gateway said it serves them");
    noteGatewayAssetGenerations(BASE, undefined, undefined, undefined, REFINED_MODEL_VERSION);
    assert.match(visualModelUrl(BASE, BARREL), /[?&]refined=1(?:&|$)/);
    assert.match(visualModelUrl(BASE, WOLF), /[?&]refined=1(?:&|$)/);
    assert.ok(!visualModelUrl(BASE, HUMAN).includes("refined="), "a character has none");
    assert.ok(!visualModelUrl(BASE, "World\\wmo\\x.wmo", 3).includes("refined="), "a WMO group has none");
    assert.ok(!visualAnimationsUrl(BASE, WOLF).includes("refined="), "the clips stay on the plain name");
    setRefinedModelsEnabled(false);
    assert.equal(visualModelUrl(BASE, BARREL), plain, "off is the plain URL");
    setRefinedModelsEnabled(true);
    noteGatewayAssetGenerations(BASE, undefined, undefined, undefined, undefined);
    assert.equal(visualModelUrl(BASE, BARREL), plain, "a gateway that stops serving them is not asked");
  } finally {
    setRefinedModelsEnabled(false);
    resetGatewayGeneration();
  }
});

async function withGateway(options, run) {
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], datasetPollMs: 0, ...options,
  });
  try {
    return await run(`http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
  }
}

test("the route: the copy for the current version, the plain model for anything else, nothing when switched off", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-refined-"));
  try {
    const client = join(root, "client");
    const visual = join(root, "visual");
    await mkdir(join(client, "Data"), { recursive: true });
    await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
    await mkdir(visual);
    await writeFile(join(visual, `${gatewayModelHash(BARREL)}.bin`), "PLAIN");
    await writeFile(join(visual, `${refinedModelHash(BARREL)}.bin`), "REFINED");
    await writeFile(join(visual, `${gatewayModelHash(HUMAN)}.bin`), "HUMAN");
    const body = async (base, query) => {
      const response = await fetch(`${base}/visual/model?path=${encodeURIComponent(query.path)}&v=3${query.refined ? `&refined=${query.refined}` : ""}`,
        { headers: { origin: ORIGIN } });
      return response.ok ? response.text() : response.status;
    };
    const status = async (base) => (await fetch(`${base}/client/patch-status?summary=1`, { headers: { origin: ORIGIN } })).json();
    await withGateway({ clientDirectory: client, visualModelsDirectory: visual, refinedModels: true }, async (base) => {
      assert.equal((await status(base)).refinedModelGeneration, REFINED_MODEL_VERSION);
      assert.equal(await body(base, { path: BARREL }), "PLAIN");
      assert.equal(await body(base, { path: BARREL, refined: REFINED_MODEL_VERSION }), "REFINED");
      assert.equal(await body(base, { path: BARREL, refined: "0" }), "PLAIN", "an old URL still draws");
      assert.equal(await body(base, { path: HUMAN, refined: REFINED_MODEL_VERSION }), "HUMAN", "a character has no copy");
    });
    await withGateway({ clientDirectory: client, visualModelsDirectory: visual }, async (base) => {
      assert.equal("refinedModelGeneration" in await status(base), false);
      assert.equal(await body(base, { path: BARREL, refined: REFINED_MODEL_VERSION }), "PLAIN");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dense model is not smoothed further, and an empty one comes back as it was", () => {
  assert.equal(SMOOTH_TRIANGLE_LIMIT, 8000);
  const empty = { positions: new Float32Array(0), normals: new Float32Array(0), uv0: new Float32Array(0), uv1: new Float32Array(0),
    boneIndices: new Uint8Array(0), boneWeights: new Uint8Array(0), indices: new Uint32Array(0), submeshes: [], batches: [], textures: [] };
  assert.equal(refineModel(empty, BARREL), empty);
  // Soft edges on a dome of 8,001 triangles: every face a copy of one curved fan.
  const count = 8001;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  for (let face = 0; face < count; face++) {
    const x = face * 3;
    positions.set([x, 0, 0, x + 1, 0, 0, x + 0.5, 1, 0], face * 9);
    const a = Math.hypot(0.3, 1);
    normals.set([-0.3 / a, 0, 1 / a, 0.3 / a, 0, 1 / a, 0, 0.3 / a, 1 / a], face * 9);
    indices.set([face * 3, face * 3 + 1, face * 3 + 2], face * 3);
  }
  const dense = { positions, normals, uv0: new Float32Array(count * 6), uv1: new Float32Array(count * 6),
    boneIndices: new Uint8Array(count * 12), boneWeights: new Uint8Array(count * 12), indices,
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: indices.length }],
    batches: [{ submesh: 0, blendMode: 0, materialFlags: 0, textures: [0], uvSets: [0], textureTransform: -1 }],
    textures: [{ type: 0, flags: 0, filename: "t.blp" }], bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 } };
  const refined = refineModel(dense, BARREL);
  assert.equal(refined.indices.length, indices.length, "the triangles are what they were");
  assert.equal(refined.normalsCarryAo, true, "but it is baked");
});

const client = process.env.CLIENT_DIR ?? "F:/Circle";

test("a job asked for a refined name publishes the copy, with no sidecar, and the plain name stays plain", {
  skip: existsSync(join(client, "Data")) ? false : `no client at ${client}`,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-refined-publish-"));
  const before = process.env.VISUAL_MODEL_DIR;
  process.env.VISUAL_MODEL_DIR = root;
  try {
    const { publishVisualModel } = await import("../tools/generate-visual-model.mjs");
    const { clientArchives } = await import("../tools/mpq.mjs");
    const { decodeWvm9 } = await import("../dist/code/browser/Wvm.js");
    const archives = await clientArchives(client);
    const decode = async (hash) => {
      const bytes = await readFile(join(root, `${hash}.bin`));
      return decodeWvm9(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    };
    for (const path of [BARREL, WOLF]) {
      await publishVisualModel(path, refinedModelHash(path), archives);
      await publishVisualModel(path, visualModelHash(path), archives);
      const refined = await decode(refinedModelHash(path));
      const plain = await decode(visualModelHash(path));
      assert.equal(refined.normalsCarryAo, true, path);
      assert.equal(plain.normalsCarryAo, undefined, path);
      assert.ok(refined.indices.length > plain.indices.length, `${path}: ${plain.indices.length} -> ${refined.indices.length}`);
      assert.equal(refined.batches.length, plain.batches.length, `${path}: the same batches`);
      assert.equal(refined.submeshes.length, plain.submeshes.length, `${path}: the same geosets`);
      assert.equal(refined.skeleton?.clips?.length, plain.skeleton?.clips?.length, `${path}: the same clips`);
      assert.deepEqual(refined.animations, plain.animations, `${path}: the same animation list`);
      // Written as the current namespace, not as the older gateway's: the shaders the client resolves, the key bones,
      // and a unit's clips with their variations as Wow.exe chooses them.
      assert.equal(refined.shaderIdsResolved, plain.shaderIdsResolved, `${path}: resolved shader ids`);
      assert.deepEqual(refined.batches.map((batch) => batch.shaderId), plain.batches.map((batch) => batch.shaderId), `${path}: shader ids`);
      assert.deepEqual([...(refined.keyBones ?? [])], [...(plain.keyBones ?? [])], `${path}: key bones`);
      assert.deepEqual(refined.skeleton?.clips?.map((clip) => clip.variationNext), plain.skeleton?.clips?.map((clip) => clip.variationNext), `${path}: clip variations`);
      assert.ok(existsSync(join(root, `${refinedModelHash(path)}.bin.src`)), "stamped, so the gateway can tell a stale one");
      assert.equal(existsSync(join(root, `${refinedModelHash(path)}.anim.bin`)), false, "the clips stay on the plain name");
    }
  } finally {
    if (before === undefined) delete process.env.VISUAL_MODEL_DIR;
    else process.env.VISUAL_MODEL_DIR = before;
    await rm(root, { recursive: true, force: true });
  }
});
