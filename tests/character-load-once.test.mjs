// 22.10 (6.26): a character is loaded once, not once per session. The browser half: the gateway's restart-stable
// generations reach every URL that can be kept (`vg=`, `mg=`), display records and composed bodies are kept between
// sessions under them, a body is painted while its model is still on its way, and a unit's model, look and body
// start loading when it arrives rather than when it is first drawn.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as THREE from "three";
import {
  applyGatewayGenerationPush, gatewayGenerationPush, gatewayMetadataGeneration, gatewayVisualGeneration,
  noteGatewayAssetGenerations, noteGatewayCacheGeneration, resetGatewayGeneration, withMetadataGeneration,
  withVisualGeneration,
} from "../dist/code/browser/GatewayGeneration.js";
import { readPatchStatus } from "../dist/code/browser/PatchChainChanged.js";
import { textureUrl, visualAnimationsUrl, visualModelUrl } from "../dist/code/browser/Wvm.js";
import { MemoryAssetBackend, PersistentAssetStore } from "../dist/code/browser/PersistentAssetStore.js";
import {
  ATLAS_PERSIST_KIND, atlasPersistId, createCharacterAtlasPersistence,
} from "../dist/code/browser/CharacterAtlasPersistence.js";
import { createDisplayRowPersistence } from "../dist/code/browser/CreatureDisplayPersistence.js";
import { CharacterAtlasClient } from "../dist/code/browser/CharacterAtlas.js";
import { CreatureModelClient } from "../dist/code/browser/CreatureModelClient.js";
import {
  UNIT_LOOK_PREFETCH_INTERVAL_MS, UNIT_PREFETCH_EVERY, UnitLookPrefetch, nearestUnitsForLook, selectUnitPrefetch,
} from "../dist/code/browser/UnitPrefetch.js";

const GATEWAY = "http://127.0.0.1:8090";
const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

// ── generations on the wire ─────────────────────────────────────────────────────────────────────────────────

test("visual and metadata URLs carry the published generations, and only the gateway's", () => {
  resetGatewayGeneration();
  try {
    assert.equal(withVisualGeneration(`${GATEWAY}/texture?path=a`), `${GATEWAY}/texture?path=a`, "none published");
    noteGatewayCacheGeneration(GATEWAY, "abc123");
    assert.equal(noteGatewayAssetGenerations(GATEWAY, "v0123456789abcdef012", "m0123456789abcdef012"), true);
    assert.equal(noteGatewayAssetGenerations(GATEWAY, "v0123456789abcdef012", "m0123456789abcdef012"), false, "no change");
    assert.equal(gatewayVisualGeneration(), "v0123456789abcdef012");
    assert.equal(gatewayMetadataGeneration(), "m0123456789abcdef012");
    assert.equal(withVisualGeneration(`${GATEWAY}/texture?path=a`), `${GATEWAY}/texture?path=a&vg=v0123456789abcdef012`);
    assert.equal(withMetadataGeneration(`${GATEWAY}/dbc/creature-models?v=14&ids=1`),
      `${GATEWAY}/dbc/creature-models?v=14&ids=1&mg=m0123456789abcdef012`);
    assert.equal(withVisualGeneration("http://127.0.0.1:5173/texture?path=a"), "http://127.0.0.1:5173/texture?path=a");
    assert.equal(withVisualGeneration("http://127.0.0.1:80901/x?y"), "http://127.0.0.1:80901/x?y", "a longer port");
    assert.match(textureUrl(GATEWAY, "Character\\Human\\Male\\Skin.blp"), /&vg=v0123456789abcdef012$/);
    assert.match(visualModelUrl(GATEWAY, "Character\\Human\\Male\\HumanMale.m2"), /&v=3&vg=v0123456789abcdef012$/);
    assert.match(visualAnimationsUrl(GATEWAY, "Character\\Human\\Male\\HumanMale.m2"), /&vg=v0123456789abcdef012$/);
    // The render worker's realm takes them through the push, like the tile generation.
    const push = gatewayGenerationPush();
    assert.equal(push.visual, "v0123456789abcdef012");
    assert.equal(push.metadata, "m0123456789abcdef012");
    resetGatewayGeneration();
    applyGatewayGenerationPush(push);
    assert.equal(gatewayVisualGeneration(), "v0123456789abcdef012");
    // A malformed value (or an older gateway) clears it, and another gateway's are not this one's.
    noteGatewayAssetGenerations(GATEWAY, "bad value/..", undefined);
    assert.equal(gatewayVisualGeneration(), undefined);
    assert.equal(withVisualGeneration(`${GATEWAY}/texture?path=a`), `${GATEWAY}/texture?path=a`);
    noteGatewayAssetGenerations(GATEWAY, "v1", "m1");
    noteGatewayCacheGeneration("http://127.0.0.1:8099", "abc");
    assert.equal(gatewayVisualGeneration(), undefined, "a new gateway origin forgets the old one's generations");
  } finally {
    resetGatewayGeneration();
  }
});

test("readPatchStatus files the asset generations an answer carries, and clears them for an older gateway", async () => {
  resetGatewayGeneration();
  try {
    const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
    await readPatchStatus(GATEWAY, { summary: true, fetch: answer({ generation: "x", stale: false, cacheGeneration: "c1",
      visualGeneration: "v1", metadataGeneration: "m1" }) });
    assert.equal(gatewayVisualGeneration(), "v1");
    assert.equal(gatewayMetadataGeneration(), "m1");
    await readPatchStatus(GATEWAY, { summary: true, fetch: answer({ generation: "x", stale: false, cacheGeneration: "c1" }) });
    assert.equal(gatewayVisualGeneration(), undefined, "a gateway built before 6.26 publishes none");
    await readPatchStatus(GATEWAY, { summary: true, fetch: answer({ generation: "x", stale: false, visualGeneration: "v1" }) });
    await readPatchStatus(GATEWAY, { summary: true, fetch: answer({}, 404) });
    assert.equal(gatewayVisualGeneration(), undefined);
  } finally {
    resetGatewayGeneration();
  }
});

// ── composed bodies ───────────────────────────────────────────────────────────────────────────────────────────

const LAYERS = [{ path: "Character\\Human\\Male\\HumanMaleSkin00_00.blp" },
  { path: "Item\\TextureComponents\\TorsoUpperTexture\\Plate_A_01_TU_U.blp", section: "torsoUpper",
    candidates: ["Item\\TextureComponents\\TorsoUpperTexture\\Plate_A_01_TU_M.blp", "Item\\TextureComponents\\TorsoUpperTexture\\Plate_A_01_TU_U.blp"] }];

test("a body's stored name follows what is painted: every spelling, its order and its section", () => {
  const id = atlasPersistId(LAYERS);
  assert.equal(atlasPersistId(LAYERS.map((layer) => ({ ...layer }))), id);
  assert.notEqual(atlasPersistId([LAYERS[0]]), id, "a piece less");
  assert.notEqual(atlasPersistId([...LAYERS].reverse()), id, "another order");
  assert.notEqual(atlasPersistId([LAYERS[0], { ...LAYERS[1], section: "torsoLower" }]), id, "another section");
  assert.notEqual(atlasPersistId([LAYERS[0], { ...LAYERS[1], candidates: [LAYERS[1].candidates[1]] }]), id, "another spelling");
});

function fakeTexels(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

test("a stored body round-trips under its generation, and under no other", async () => {
  let generation = "v1";
  const backend = new MemoryAssetBackend();
  const store = new PersistentAssetStore(backend, { rows: 10, blobs: 10 });
  const painted = fakeTexels(4, 4);
  painted.data[0] = 200;
  const drawn = [];
  const persistence = createCharacterAtlasPersistence(4, {
    store, generation: () => generation, gateway: () => GATEWAY,
    imageData: (pixels, width, height) => ({ width, height, data: pixels }),
    // The CPU-side canvas a body is painted into for keeping (never the GPU atlas itself: reading that back stalls).
    saveContext: () => ({ drawImage: (...args) => drawn.push(args), getImageData: () => painted }),
  });
  persistence.save(LAYERS, (context) => context.drawImage("layer"), "v1");
  assert.deepEqual(drawn, [["layer"]], "the body is painted into the keeping canvas");
  await store.flush();
  const restored = await persistence.load(LAYERS, "v1");
  assert.equal(restored.width, 4);
  assert.equal(restored.data[0], 200);
  assert.equal(await persistence.load([LAYERS[0]], "v1"), undefined, "another look is a miss");
  assert.equal(await persistence.load(LAYERS, undefined), undefined, "no generation, nothing read");
  persistence.save([LAYERS[0]], (context) => context.drawImage("layer"), undefined);
  await store.flush();
  assert.equal([...backend.spaces.blobs.keys()].filter((key) => key.includes(ATLAS_PERSIST_KIND)).length, 1,
    "no generation, nothing written");
  // A stored value of another size is not this body.
  store.put("blobs", GATEWAY, ATLAS_PERSIST_KIND, "v1", [[atlasPersistId([LAYERS[0]]), { width: 2, height: 2, rgba: new Blob([new Uint8Array(16)]) }]]);
  await store.flush();
  assert.equal(await persistence.load([LAYERS[0]], "v1"), undefined);
  // A new patch chain: a miss, and its first use drops the old chain's bodies.
  assert.equal(await persistence.load(LAYERS, "v2"), undefined);
  await store.flush();
  assert.equal([...backend.spaces.blobs.keys()].filter((key) => key.includes(ATLAS_PERSIST_KIND)).length, 0);
  generation = "v2";
  assert.equal(persistence.generation(), "v2", "the generation is read when a composition starts");
});

function stubCanvas() {
  const original = { fetch: globalThis.fetch, document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
  const asked = [];
  const canvases = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url), "http://gateway").searchParams.get("path") ?? "";
    asked.push(path);
    return path.includes("Missing") ? { ok: false, status: 404 } : { ok: true, status: 200, blob: async () => ({}) };
  };
  globalThis.createImageBitmap = async () => ({ width: 256, height: 128, close() {} });
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, drawn: [], put: [] };
      canvas.getContext = () => ({
        drawImage: (...args) => canvas.drawn.push(args),
        putImageData: (...args) => canvas.put.push(args),
        getImageData: () => fakeTexels(512, 512),
      });
      canvases.push(canvas);
      return canvas;
    },
  };
  return { asked, canvases, restore() { Object.assign(globalThis, original); } };
}

test("a look painted in an earlier session comes back as one picture, with no layer fetched", async () => {
  const page = stubCanvas();
  try {
    const loads = [];
    const persistence = {
      generation: () => "v1",
      load: async (layers, generation) => { loads.push(generation); return fakeTexels(512, 512); },
      save() { assert.fail("a restored body is not stored again"); },
    };
    const atlas = new CharacterAtlasClient(GATEWAY, Date.now, { persistence });
    const texture = await atlas.compose("look", LAYERS);
    assert.ok(texture instanceof THREE.Texture);
    assert.equal(atlas.get("look"), texture);
    assert.deepEqual(page.asked, [], "no layer was asked for");
    assert.deepEqual(loads, ["v1"]);
    assert.equal(atlas.restored, 1);
    assert.equal(page.canvases.at(-1).put.length, 1, "the stored texels were put");
  } finally {
    page.restore();
  }
});

test("a body painted from every layer is stored under the generation its composition began in; a partial one is not", async () => {
  const page = stubCanvas();
  try {
    let generation = "v1";
    const saved = [];
    const persistence = {
      generation: () => generation,
      load: async () => undefined,
      save: (layers, paint, at) => {
        const drawn = [];
        paint({ drawImage: (...args) => drawn.push(args) });
        saved.push({ layers, at, drawn: drawn.length });
      },
    };
    const atlas = new CharacterAtlasClient(GATEWAY, Date.now, { persistence });
    const pending = atlas.compose("full", LAYERS);
    generation = "v2"; // a new patch chain published while the layers were on their way
    assert.ok(await pending);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].at, "v1", "never filed under a later generation than its layers");
    assert.equal(saved[0].drawn, LAYERS.length, "the keeping canvas gets every layer, painted from the same pictures");
    assert.ok(page.asked.length >= 2, "the layers were fetched");
    await atlas.compose("partial", [LAYERS[0], { path: "Item\\Missing.blp", section: "legUpper" }]);
    assert.equal(saved.length, 1, "a body short a layer is not stored");
  } finally {
    page.restore();
  }
});

test("without a store the atlas composes exactly as before", async () => {
  const page = stubCanvas();
  try {
    const atlas = new CharacterAtlasClient(GATEWAY, Date.now, { persistence: null });
    assert.ok(await atlas.compose("look", LAYERS));
    assert.equal(atlas.restored, 0);
    assert.ok(page.asked.length >= 2);
  } finally {
    page.restore();
  }
});

// ── display records ───────────────────────────────────────────────────────────────────────────────────────────

const ROW = (id) => ({ id, model: "Creature\\Wolf\\Wolf.m2", scale: 1, collisionHeight: 1, mountHeight: 0, textures: "" });

test("display records an earlier session got are answered from the store; only the rest go to the gateway", async () => {
  const original = globalThis.fetch;
  resetGatewayGeneration();
  noteGatewayCacheGeneration(GATEWAY, "c1");
  noteGatewayAssetGenerations(GATEWAY, "v1", "m1");
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const ids = new URL(String(url)).searchParams.get("ids").split(",").map(Number);
    return new Response(JSON.stringify(ids.filter((id) => id !== 404).map(ROW)), { status: 200 });
  };
  try {
    const backend = new MemoryAssetBackend();
    const store = new PersistentAssetStore(backend, { rows: 100, blobs: 10 });
    const first = new CreatureModelClient(`ws://127.0.0.1:8090`, Date.now, createDisplayRowPersistence(14, { store }));
    const fetched = () => urls.flatMap((url) => new URL(url).searchParams.get("ids").split(",").map(Number)).sort((a, b) => a - b);
    for (const id of [10, 11, 404]) first.request(id);
    await settle();
    assert.deepEqual(fetched(), [10, 11, 404]);
    for (const url of urls) assert.match(url, /&mg=m1$/, "the request names the metadata generation");
    await store.flush();

    // The next session, same generation: 10 and 11 are known, 404 (omitted, a negative answer) and 12 are asked.
    urls.length = 0;
    const second = new CreatureModelClient(`ws://127.0.0.1:8090`, Date.now, createDisplayRowPersistence(14, { store }));
    for (const id of [10, 11, 12, 404]) second.request(id);
    await settle();
    assert.equal(second.get(10)?.model, "Creature\\Wolf\\Wolf.m2");
    assert.equal(second.get(11)?.id, 11);
    assert.equal(second.storedAnswers, 2);
    assert.deepEqual(fetched(), [12, 404], "only what the store does not hold");
    assert.equal(second.stats.pending, 0, "every id settled");

    // A new metadata generation (a DBC rebuild): nothing old answers.
    urls.length = 0;
    noteGatewayAssetGenerations(GATEWAY, "v1", "m2");
    const third = new CreatureModelClient(`ws://127.0.0.1:8090`, Date.now, createDisplayRowPersistence(14, { store }));
    third.request(10);
    await settle();
    assert.equal(third.storedAnswers, 0);
    assert.match(urls[0] ?? "", /ids=10&mg=m2$/);
  } finally {
    globalThis.fetch = original;
    resetGatewayGeneration();
  }
});

test("a stored display record that does not validate is asked for again", async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify([ROW(7)]), { status: 200 });
  };
  try {
    const persistence = { generation: () => "m1", load: async () => new Map([[7, { id: 7, model: 5 }]]), save() {} };
    const client = new CreatureModelClient(`ws://127.0.0.1:8090`, Date.now, persistence);
    client.request(7);
    await settle();
    assert.equal(urls.length, 1);
    assert.equal(client.get(7)?.model, "Creature\\Wolf\\Wolf.m2");
  } finally {
    globalThis.fetch = original;
  }
});

// ── loading on arrival ────────────────────────────────────────────────────────────────────────────────────────

test("the renderer prefetches for the nearest undrawn units, nearest first", () => {
  const candidates = [5, 1, 9, 3, 7].map((distance) => ({ value: { guid: BigInt(distance) }, distance, pinned: false, visible: false }));
  assert.deepEqual(selectUnitPrefetch(candidates, new Set([1n]), 3).map((object) => object.guid), [3n, 5n, 7n]);
  assert.deepEqual(selectUnitPrefetch(candidates, new Set(), 0), []);
});

test("the page asks the nearest units' looks every few frames, players and creatures within range", () => {
  const at = (guid, typeId, x) => ({ guid: BigInt(guid), typeId, position: { x, y: 0, z: 0 } });
  const objects = [at(1, 4, 30), at(2, 3, 10), at(3, 5, 5), at(4, 4, 500), at(5, 3, 20)];
  assert.deepEqual(nearestUnitsForLook(objects, { x: 0, y: 0 }, 2).map((object) => object.guid), [2n, 5n]);
  assert.deepEqual(nearestUnitsForLook(objects, undefined), []);
  let now = 0;
  const prefetch = new UnitLookPrefetch(() => now);
  const asked = [];
  prefetch.tick(objects, { x: 0, y: 0 }, (object) => asked.push(object.guid));
  assert.deepEqual(asked, [2n, 5n, 1n], "game objects and far units are not asked");
  now += UNIT_LOOK_PREFETCH_INTERVAL_MS - 1;
  prefetch.tick(objects, { x: 0, y: 0 }, (object) => asked.push(object.guid));
  assert.equal(asked.length, 3, "not before the interval");
  now += 1;
  prefetch.tick(objects, { x: 0, y: 0 }, (object) => asked.push(object.guid));
  assert.equal(asked.length, 6);
});

const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
function methods(names, dependencies = {}) {
  const parsed = ts.createSourceFile("renderer.ts", source, ts.ScriptTarget.ES2022, true);
  const renderer = parsed.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === "WorldRenderer3D");
  const members = names.map((name) => {
    const member = renderer.members.find((m) => m.name?.getText(parsed) === name);
    assert.ok(member, name);
    return member.getText(parsed).replaceAll("#", "");
  });
  const body = ts.transpileModule(`class Harness { ${members.join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(...Object.keys(dependencies), `${body}; return Harness;`)(...Object.values(dependencies));
}

test("a waiting model's body is painted ahead, and the chosen undrawn units are asked for on every frame", () => {
  const composed = [];
  const Harness = methods(["#prefetchUnits", "#composeBodyAhead"], {
    selectUnitPrefetch, UNIT_PREFETCH_EVERY,
    CharacterAtlasClient: class { get() { return undefined; } compose(key) { composed.push(key); } },
  });
  const h = new Harness();
  const player = { model: "Character\\Human\\Male\\HumanMale.m2", appearance: { body: LAYERS, attached: [{ model: "Helm.m2" }] } };
  const wolf = { model: "Creature\\Wolf\\Wolf.m2" };
  Object.assign(h, {
    unitPrefetchFrame: 0, unitPrefetchGuids: [], atlasFrameDemands: new Set(), baseUrl: GATEWAY,
    lookups: { unitModels: new Map([[1n, player], [2n, wolf], [3n, wolf]]) },
    unitKey: (metadata) => `key:${metadata.model}`,
  });
  const asked = [];
  const client = { model: (path, priority) => { asked.push(`${path}@${priority}`); } };
  const candidates = [1, 2, 3].map((guid) => ({ value: { guid: BigInt(guid) }, distance: guid, pinned: false, visible: false }));
  const drawn = new Set([3n]);
  for (let frame = 1; frame < UNIT_PREFETCH_EVERY; frame++) h.prefetchUnits(candidates, drawn, client);
  assert.deepEqual(asked, [], "nothing chosen before the first pass");
  h.prefetchUnits(candidates, drawn, client);
  assert.deepEqual(asked, ["Character\\Human\\Male\\HumanMale.m2@normal", "Helm.m2@background", "Creature\\Wolf\\Wolf.m2@normal"]);
  assert.deepEqual(composed, ["key:Character\\Human\\Male\\HumanMale.m2"], "the player's body, not the wolf's");
  assert.ok(h.atlasFrameDemands.has("key:Character\\Human\\Male\\HumanMale.m2"), "kept alive this frame");
  asked.length = 0;
  h.atlasFrameDemands.clear();
  h.prefetchUnits(candidates, new Set([2n, 3n]), client);
  assert.deepEqual(asked, ["Character\\Human\\Male\\HumanMale.m2@normal", "Helm.m2@background"],
    "re-asked on the next frame (a queued model nobody asked for is dropped), minus what is drawn now");
  assert.ok(h.atlasFrameDemands.has("key:Character\\Human\\Male\\HumanMale.m2"));
});
