// 25.10 (7.50): the models that give light by themselves (`/visual/lit-models`, src/world/LitModelIndex.ts). On the
// Goldshire -> Stormwind night run `StormwindGypsyWagon01.m2` — a lantern on a wagon, its own M2 point light, no
// lamp-like name — switched on 112 yards from the player when its first placement was built. The gateway now names
// every such model (tools/generate-lit-model-index.mjs), the browser asks for them as it asks for lamps
// (LitModelIndexClient.ts, LightTemplateCatalog.ts), and an older gateway's 404 leaves everything as before.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { IMMUTABLE, REVALIDATE } from "../dist/code/gateway/CachePolicy.js";
import { LightTemplateCatalog } from "../dist/code/browser/LightTemplateCatalog.js";
import { PrelitLights } from "../dist/code/browser/PrelitLights.js";
import {
  LIT_INDEX_NONE, LIT_INDEX_PENDING, LitModelIndexClient, litModelIndexUrl,
} from "../dist/code/browser/LitModelIndexClient.js";
import {
  LIT_MODEL_INDEX_FILE, LIT_MODEL_INDEX_VERSION, parseLitModelIndex,
} from "../dist/code/world/LitModelIndex.js";
import * as generator from "../tools/generate-lit-model-index.mjs";

const ORIGIN = "http://127.0.0.1:5173";
const BASE = "http://127.0.0.1:8090";
const WAGON = "World\\Generic\\Human\\Passive Doodads\\GypsyWagons\\StormwindGypsyWagon01.m2";
const CRATE = "World\\Generic\\Human\\Passive Doodads\\Crates\\Crate01.m2";

// ---- the M2 records, as the generator reads them ----

/** An MD20 header with one light record (156 bytes) at 0x200; tracks empty, as `readLights` reads them. */
function m2WithLight(type, position = [3.9, -0.3, 4.1]) {
  const bytes = Buffer.alloc(0x200 + 156);
  bytes.write("MD20", 0, "latin1");
  bytes.writeUInt32LE(264, 4);
  bytes.writeUInt32LE(1, 0x108);
  bytes.writeUInt32LE(0x200, 0x10c);
  bytes.writeUInt16LE(type, 0x200);
  bytes.writeInt16LE(-1, 0x202);
  position.forEach((value, axis) => bytes.writeFloatLE(value, 0x204 + axis * 4));
  return bytes;
}

test("the generator keeps a model by the browser's test: a point light (type 1) at a finite place", () => {
  assert.equal(generator.LIT_MODEL_INDEX_VERSION, LIT_MODEL_INDEX_VERSION, "one shape on both sides");
  assert.equal(generator.LIT_MODEL_INDEX_FILE, LIT_MODEL_INDEX_FILE);
  assert.equal(generator.declaresPointLight(m2WithLight(1)), true, "the wagon's lantern");
  assert.equal(generator.declaresPointLight(m2WithLight(0)), false, "a directional light lights nothing in the world");
  assert.equal(generator.declaresPointLight(m2WithLight(1, [Number.NaN, 0, 0])), false);
  const none = m2WithLight(1);
  none.writeUInt32LE(0, 0x108);
  assert.equal(generator.declaresPointLight(none), false, "no light table");
  assert.equal(generator.declaresPointLight(Buffer.from("MD21....")), false, "not an MD20");
});

test("the generator lists every lit model of the chain, lower case, sorted, and stamps one source per archive", async () => {
  const files = new Map([
    ["world\\b\\wagon.m2", m2WithLight(1)],
    ["world\\a\\brazier.m2", m2WithLight(1)],
    ["world\\a\\crate.m2", m2WithLight(0)],
    ["world\\a\\crate.blp", Buffer.alloc(4)],
  ]);
  const archives = {
    list: async () => new Set(files.keys()),
    read: async (path) => files.get(path),
    chainDigest: () => "chain",
    sourceOf: async (path) => ({ path, name: "patch.MPQ", kind: "archive", file: "C:\\Client\\Data\\patch.MPQ",
      size: 10, mtimeMs: 1, above: [], aboveArchives: [{ file: "C:\\Client\\Data\\patch-Z.MPQ", size: 20, mtimeMs: 2 }] }),
  };
  const root = await mkdtemp(join(tmpdir(), "webclient-lit-"));
  try {
    const destination = join(root, LIT_MODEL_INDEX_FILE);
    const result = await generator.publishLitModelIndex(archives, destination);
    assert.equal(result.models, 2);
    assert.equal(result.scanned, 3);
    const index = JSON.parse(await readFile(destination, "utf8"));
    assert.deepEqual(index, { version: 1, models: ["world\\a\\brazier.m2", "world\\b\\wagon.m2"] });
    assert.deepEqual([...parseLitModelIndex(index)], index.models);
    const stamp = JSON.parse(await readFile(`${destination}.src`, "utf8"));
    assert.equal(stamp.sources.length, 1, "one source per archive, not one per model");
    assert.deepEqual(stamp.files.map((file) => file.file).sort(), ["C:\\Client\\Data\\patch-Z.MPQ", "C:\\Client\\Data\\patch.MPQ"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an index body that is not one is refused", () => {
  assert.equal(parseLitModelIndex({ version: 2, models: [] }), undefined);
  assert.equal(parseLitModelIndex({ version: 1, models: [3] }), undefined);
  assert.equal(parseLitModelIndex({ version: 1 }), undefined);
  assert.equal(parseLitModelIndex(null), undefined);
  assert.deepEqual([...parseLitModelIndex({ version: 1, models: ["World/X/Lit.M2"] })], ["world\\x\\lit.m2"]);
});

// ---- the gateway route ----

async function withGateway(options, run) {
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], datasetPollMs: 0, ...options,
  });
  try {
    return await run(`http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
  }
}
const get = (base, path, origin = ORIGIN) => fetch(`${base}${path}`, { headers: origin ? { origin } : {} });
const BODY = JSON.stringify({ version: 1, models: [WAGON.toLowerCase()] });

test("the route serves the index, immutable under vg, published once on the first request", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-lit-"));
  const client = join(root, "client");
  const visual = join(root, "visual");
  await mkdir(join(client, "Data"), { recursive: true });
  await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
  await mkdir(visual);
  let runs = 0;
  try {
    await withGateway({
      clientDirectory: client, visualModelsDirectory: visual,
      generateLitModelIndex: async () => {
        runs++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await writeFile(join(visual, LIT_MODEL_INDEX_FILE), BODY);
      },
    }, async (base) => {
      const vg = (await (await get(base, "/client/patch-status?summary=1")).json()).visualGeneration;
      assert.ok(vg);
      const answers = await Promise.all([0, 1, 2].map(() => get(base, `/visual/lit-models?v=1&vg=${vg}`)));
      assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200]);
      assert.equal(runs, 1, "concurrent first requests share one publication");
      assert.equal(answers[0].headers.get("cache-control"), IMMUTABLE);
      assert.equal(answers[0].headers.get("access-control-allow-origin"), ORIGIN);
      assert.deepEqual(await answers[0].json(), JSON.parse(BODY));
      assert.equal((await get(base, "/visual/lit-models?v=1")).headers.get("cache-control"), REVALIDATE, "no vg: revalidated");
      assert.equal(runs, 1, "kept");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refusals: origin 403, version 400 (readable), no file and no generator 404, a failed publication 500", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-lit-"));
  const visual = join(root, "visual");
  await mkdir(visual);
  try {
    await withGateway({ visualModelsDirectory: visual }, async (base) => {
      assert.equal((await get(base, "/visual/lit-models?v=1", "http://evil.example")).status, 403);
      for (const bad of ["/visual/lit-models?v=2", "/visual/lit-models"]) {
        const answer = await get(base, bad);
        assert.equal(answer.status, 400, bad);
        assert.equal(answer.headers.get("access-control-allow-origin"), ORIGIN);
      }
      assert.equal((await get(base, "/visual/lit-models?v=1")).status, 404, "no generator: nothing will make it");
    });
    await withGateway({ visualModelsDirectory: visual, generateLitModelIndex: async () => { throw new Error("broken chain"); } },
      async (base) => assert.equal((await get(base, "/visual/lit-models?v=1")).status, 500, "the page retries"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const source = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
  assert.match(source, /\|\| pathname === "\/visual\/lit-models"/, "the client-media latch covers it like its siblings");
});

// ---- the browser ----

function scriptedFetch() {
  const calls = [];
  const fetchImpl = (url) => new Promise((resolve, reject) => calls.push({ url, resolve, reject }));
  return { calls, fetchImpl };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = () => new Promise((resolve) => setImmediate(resolve));

const constant = (components, ...values) => ({ interpolation: 0, globalSequence: -1, components,
  tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array(values) }] });
const none = (components) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });
/** The wagon as WVM9 carries it: a body and one M2 point light 4 yards up, no glow card. */
const wagonModel = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint16Array([0, 1, 2]),
  submeshes: [{ indexStart: 0, indexCount: 3 }],
  batches: [{ submesh: 0, materialFlags: 0, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 }],
  textures: [{ path: "World\\Wagon.blp" }], particleEmitters: [], colours: [], textureWeights: [],
  globalSequences: new Uint32Array(),
  lights: [{
    type: 1, bone: -1, position: [3.9, -0.3, 4.1], ambientColor: none(3), ambientIntensity: none(1),
    diffuseColor: constant(3, 1, 0.8, 0.5), diffuseIntensity: constant(1, 1), attenuationStart: constant(1, 0.5),
    attenuationEnd: constant(1, 2), visibility: constant(1, 1),
  }],
});
const placement = (id, name, x) => ({ id, kind: "m2", name, x, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0,
  scale: 1, quaternionX: 0, quaternionY: 0, quaternionZ: 0, quaternionW: 1 });
const host = { place: (object, target) => target.makeTranslation(object.x, object.z, -object.y), openAir: () => undefined,
  built: () => false };

/** The frame loop's light half: the catalog's pump, then the prelit list (WorldRenderer3D `#updateLocalLights`). */
function frame(catalog, prelit, objects, models, index) {
  catalog.pump(models, undefined, index);
  prelit.update(objects, catalog, host, new THREE.Vector3());
}

test("with the index a wagon's own light stands before the wagon is built; the curtain waits for the index", async () => {
  const { calls, fetchImpl } = scriptedFetch();
  const index = new LitModelIndexClient(BASE, fetchImpl);
  const catalog = new LightTemplateCatalog(null);
  const prelit = new PrelitLights();
  const asked = [];
  const models = {
    model(name, priority) { asked.push([name, priority]); return name === WAGON ? { wvm: wagonModel() } : undefined; },
    modelState: () => "pending",
  };
  const objects = [placement(1, WAGON, 112), placement(2, CRATE, 20)];
  frame(catalog, prelit, objects, models, index);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, litModelIndexUrl(BASE));
  assert.match(calls[0].url, /\/visual\/lit-models\?v=1$/);
  assert.equal(catalog.candidate(WAGON), false, "its name passes no gate");
  assert.equal(prelit.pendingNear(catalog, host, 0, 0, 150), 1, "the index on its way: the curtain waits");
  assert.equal(index.lookup(), LIT_INDEX_PENDING);
  calls[0].resolve(json(200, { version: 1, models: [WAGON.toLowerCase().replaceAll("\\", "/")] }));
  await settle();
  frame(catalog, prelit, objects, models, index);
  assert.equal(catalog.candidate(WAGON), true, "named by the index");
  assert.equal(catalog.candidate(CRATE), false);
  assert.equal(catalog.stats.litModels, 1);
  for (let step = 0; step < 40; step++) frame(catalog, prelit, objects, models, index);
  assert.deepEqual(asked, [[WAGON, "normal"]], "the wagon is asked for at 112 yards, nothing else is");
  assert.equal(catalog.templates(WAGON)?.length, 1, "its template, from the model data");
  assert.equal(prelit.count, 1, "the lantern stands at the unbuilt wagon");
  assert.equal(prelit.pendingNear(catalog, host, 0, 0, 150), 0);
  assert.equal(calls.length, 1, "one request per gateway");
});

test("an older gateway (404) or a body that is not an index: no index, nothing waits, the wagon lights when built", async () => {
  for (const answer of [json(404, undefined), json(200, { version: 9 })]) {
    let now = 0;
    const { calls, fetchImpl } = scriptedFetch();
    const index = new LitModelIndexClient(BASE, fetchImpl, () => now);
    const catalog = new LightTemplateCatalog(null);
    const prelit = new PrelitLights();
    const objects = [placement(1, WAGON, 112)];
    frame(catalog, prelit, objects, undefined, index);
    calls[0].resolve(answer);
    await settle();
    frame(catalog, prelit, objects, undefined, index);
    assert.equal(index.lookup(), LIT_INDEX_NONE);
    assert.equal(catalog.candidate(WAGON), false);
    assert.equal(prelit.pendingNear(catalog, host, 0, 0, 150), 0, "the curtain does not wait");
    now += 100_000;
    frame(catalog, prelit, objects, undefined, index);
    assert.equal(calls.length, 1, "final: never asked again, not even past the retry ladder");
    catalog.noteLit(WAGON, wagonModel()); // its first build, as before
    for (let step = 0; step < 40; step++) frame(catalog, prelit, objects, undefined, index);
    assert.equal(prelit.count, 1);
  }
});

test("a failed request does not hold the curtain and is retried on the 2 / 8 / 30 s ladder, then given up", async () => {
  let now = 0;
  const { calls, fetchImpl } = scriptedFetch();
  const index = new LitModelIndexClient(BASE, fetchImpl, () => now);
  assert.equal(index.lookup(), LIT_INDEX_PENDING);
  for (const [attempt, wait] of [[1, 2_000], [2, 8_000], [3, 30_000]]) {
    calls[attempt - 1].resolve(json(503, undefined));
    await settle();
    assert.equal(index.lookup(), LIT_INDEX_NONE, "retrying: no wait");
    assert.equal(calls.length, attempt);
    now += wait;
    assert.equal(index.lookup(), LIT_INDEX_NONE);
    assert.equal(calls.length, attempt + 1, `retried after ${wait} ms`);
  }
  calls[3].reject(new Error("offline"));
  await settle();
  now += 100_000;
  assert.equal(index.lookup(), LIT_INDEX_NONE);
  assert.equal(calls.length, 4, "given up");
});

test("the renderer's wiring: the index rides the catalog's pump, one client per gateway", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /this\.#lightCatalog\.pump\(client, client \? this\.#lampTableSource\(client\.baseUrl\) : undefined,.*\n\s+client \? this\.#litModelSource\(client\.baseUrl\) : undefined\);/);
  assert.match(renderer, /if \(index\?\.baseUrl !== baseUrl\) this\.#litModels = index = new LitModelIndexClient\(baseUrl\);/);
});
