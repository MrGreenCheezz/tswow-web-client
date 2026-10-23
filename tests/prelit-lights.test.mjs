// 24.10 (7.50): lamps light before their models are built. Owner, 24.10: «Крайне сильно заметно, как
// источники света загораются при подгрузке; можем их заранее подгружать вокруг персонажа?»
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import {
  fixtureFlicker, fixtureNameCandidate, modelFixtureLights, sampleFixtureLight,
} from "../dist/code/browser/LocalLighting.js";
import { deriveLightTemplates, sampleLightTemplate } from "../dist/code/browser/LightTemplates.js";
import { LightTemplateCatalog } from "../dist/code/browser/LightTemplateCatalog.js";
import { PrelitLights } from "../dist/code/browser/PrelitLights.js";
import { farLightSources } from "../dist/code/browser/FarLightGlows.js";
import { ADT_MODEL_TO_SCENE, placeEnvironmentNode } from "../dist/code/browser/WorldRenderer3D.js";
import { MemoryAssetBackend, PersistentAssetStore } from "../dist/code/browser/PersistentAssetStore.js";
import { wmoLanterns } from "../dist/code/browser/WmoOpenAirLamps.js";
import { noteGatewayAssetGenerations, resetGatewayGeneration } from "../dist/code/browser/GatewayGeneration.js";

const cache = new URL("../bench/cache/", import.meta.url);
const noCache = existsSync(new URL("index.json", cache))
  ? false : "bench/cache/index.json is absent: run the benchmark once to populate the asset cache";

/** The cached lamp models (`/visual/model`), decoded: the heuristic's real inputs. */
function cachedLamps() {
  const index = JSON.parse(readFileSync(new URL("index.json", cache), "utf8"));
  const seen = new Set();
  const lamps = [];
  for (const [url, entry] of Object.entries(index)) {
    const match = /^\/visual\/model\?path=([^&]+\.m2)&/i.exec(decodeURIComponent(url));
    if (!match || entry.status !== 200 || !fixtureNameCandidate(match[1])) continue;
    const key = match[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const data = readFileSync(new URL(entry.sha256, cache));
    lamps.push({ name: match[1], model: decodeWvm9(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
  }
  return lamps;
}

/** A lamp placement as the tiles give it (world x north, y west, z up), in Stormwind's yards. */
const placementAt = (id, name, x, y, z, extra = {}) => ({
  id, kind: "m2", name, x, y, z, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1.3,
  quaternionX: 0.1, quaternionY: 0.7, quaternionZ: -0.05, quaternionW: 0.7, ...extra,
});

/** What the renderer builds for a doodad (`#wvmNode`): the placed node, the mesh turned by ADT_MODEL_TO_SCENE. */
function built(object, wvm) {
  const node = placeEnvironmentNode(new THREE.Group(), object);
  const visual = new THREE.Object3D();
  visual.quaternion.copy(ADT_MODEL_TO_SCENE);
  node.add(visual);
  node.updateMatrixWorld(true);
  return { source: object, node, visual, wvm };
}

/** The renderer's prelit host (`#prelitHost`): the node's matrix times the mesh's turn. */
const frame = new THREE.Object3D();
const host = (built = () => false, openAir = () => undefined) => ({
  place: (object, target) => {
    placeEnvironmentNode(frame, object).updateMatrix();
    return target.makeRotationFromQuaternion(ADT_MODEL_TO_SCENE).premultiply(frame.matrix);
  },
  openAir,
  built,
});

const sample = () => ({ position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 });
const near = (prelit, focus, worldMs, h) => {
  const out = [];
  prelit.forEachNear(focus, worldMs, h, (value) => out.push({
    position: value.position.clone(), colour: value.colour.clone(), radius: value.radius, intensity: value.intensity,
    client: value.client, halo: value.halo,
  }), sample());
  return out;
};
const close = (a, b, epsilon, label) => assert.ok(Math.abs(a - b) <= epsilon, `${label}: ${a} != ${b}`);

/** A lamp the heuristic reads: an unlit additive glow card 4 yards up, colour track at 0.8. */
const glowLamp = () => ({
  positions: new Float32Array([0, 0, 0, 0, 0, 4, 1, 0, 4, 0, 1, 4]),
  indices: new Uint16Array([0, 1, 2, 1, 2, 3]),
  submeshes: [{ indexStart: 0, indexCount: 3 }, { indexStart: 3, indexCount: 3 }],
  batches: [
    { submesh: 0, materialFlags: 0, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 },
    { submesh: 1, materialFlags: 1, blendMode: 4, textures: [1], colorIndex: 65535, textureWeight: 0 },
  ],
  textures: [{ path: "World\\Lamp.blp" }, { path: "World\\LampGlow.blp" }],
  particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(), lights: [],
});
const GLOW_LAMP = "World\\Generic\\Human\\Passive Doodads\\Lamps\\TestLamp01.m2";
const constant = (components, ...values) => ({ interpolation: 0, globalSequence: -1, components,
  tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array(values) }] });
const none = (components) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });
/** A model past no name gate that declares an M2 point light 3 yards up (`humanguardtower.m2`'s kind). */
const towerModel = () => ({
  ...glowLamp(),
  textures: [{ path: "World\\Tower.blp" }, { path: "World\\Tower2.blp" }],
  lights: [{
    type: 1, bone: -1, position: [0.5, 0, 3], ambientColor: none(3), ambientIntensity: none(1),
    diffuseColor: constant(3, 1, 0.86, 0.5), diffuseIntensity: constant(1, 1.2),
    attenuationStart: constant(1, 0.5), attenuationEnd: constant(1, 1.89), visibility: constant(1, 1),
  }],
});
const TOWER = "World\\Generic\\Human\\Passive Doodads\\Towers\\TestGuardTower.m2";

/** Every template of `model` placed by the prelit list equals the built placement's own sample. */
function assertPrelitMatchesBuilt(name, model) {
  const catalog = new LightTemplateCatalog(null);
  const templates = catalog.learn(name, model);
  const fixtures = modelFixtureLights(model, name, true);
  assert.equal(templates.length, fixtures.length, `${name}: one template per fixture lit at rest`);
  if (fixtures.length === 0) return 0;
  const object = placementAt(7, name, -8840, 626, 94);
  const resident = built(object, model);
  const prelit = new PrelitLights();
  prelit.update([object], catalog, host(), new THREE.Vector3());
  const focus = new THREE.Vector3().setFromMatrixPosition(resident.visual.matrixWorld);
  for (const worldMs of [0, 1234, 98_765]) {
    const expected = [];
    const value = sample();
    for (const fixture of fixtures) {
      if (sampleFixtureLight(fixture, model, resident.visual.matrixWorld, 0, worldMs, value)) {
        expected.push({ position: value.position.clone(), colour: value.colour.clone(), radius: value.radius,
          intensity: value.intensity, client: value.client, halo: value.halo });
      }
    }
    const got = near(prelit, focus, worldMs, host());
    assert.equal(got.length, expected.length, `${name} @${worldMs}: count`);
    got.forEach((light, index) => {
      const want = expected[index];
      assert.ok(light.position.distanceTo(want.position) < 1e-3, `${name}: position ${light.position.toArray()} != ${want.position.toArray()}`);
      assert.ok(light.colour.distanceTo(want.colour) < 1e-5, `${name}: colour`);
      close(light.radius, want.radius, 1e-5, `${name}: radius`);
      close(light.intensity, want.intensity, 2e-4, `${name} @${worldMs}: intensity`);
      assert.equal(light.client, want.client, `${name}: client falloff`);
      assert.equal(light.halo, want.halo, `${name}: halo`);
    });
  }
  // The far glow: what `farLightSources` gives the built placement, from the unbuilt one.
  const farBuilt = farLightSources(resident);
  const farPrelit = [];
  prelit.appendFarSources(host(), farPrelit);
  assert.equal(farPrelit.length, farBuilt.length, `${name}: far glow sources`);
  farPrelit.forEach((value, index) => close(value, farBuilt[index], 2e-3, `${name}: far glow float ${index}`));
  return fixtures.length;
}

test("24.10 (7.50): a cached lamp model's templates light every placement as its built model does", { skip: noCache }, () => {
  const lamps = cachedLamps();
  assert.ok(lamps.length >= 10, `cached lamps: ${lamps.length}`);
  let lit = 0;
  let models = 0;
  for (const { name, model } of lamps) {
    const count = assertPrelitMatchesBuilt(name, model);
    lit += count;
    if (count > 0) models++;
  }
  assert.ok(models >= 8, `lamp models that light: ${models}`);
  assert.ok(lit >= models, `lights: ${lit}`);
});

test("24.10 (7.50): a glow-card lamp and a model's own M2 light, placed, scaled and turned", () => {
  assert.equal(assertPrelitMatchesBuilt(GLOW_LAMP, glowLamp()), 1);
  assert.equal(assertPrelitMatchesBuilt(TOWER, towerModel()), 1);
  const [template] = deriveLightTemplates(towerModel(), TOWER);
  assert.equal(template.client, true, "the model's own light keeps the client's falloff");
  const value = sample();
  assert.ok(sampleLightTemplate(template, new THREE.Matrix4().makeScale(2, 2, 2), 5000, value));
  assert.equal(value.radius, 24, "twice the 20-yard reach, capped at 24 as the built light is");
});

test("24.10 (7.50): the flicker is the one the built lamp had", () => {
  // 22.10's inline form in `sampleFixtureLight`, kept here as the reference.
  const old = (x, y, z, ms) => {
    const phase = x * 0.71 + y * 0.37 + z * 0.53;
    return 0.94 + 0.04 * Math.sin(ms / 1000 * 4.1 + phase) + 0.02 * Math.sin(ms / 1000 * 7.7 + phase * 1.7);
  };
  for (const [x, y, z, ms] of [[0, 0, 0, 0], [-8840, 94, -626, 1234], [12.5, -3, 7, 98_765]]) {
    assert.equal(fixtureFlicker(x, y, z, ms), old(x, y, z, ms));
  }
});

test("24.10 (7.50): a placement lights without a built model, and only until it is built", () => {
  const catalog = new LightTemplateCatalog(null);
  catalog.learn(GLOW_LAMP, glowLamp());
  const objects = [placementAt(1, GLOW_LAMP, 0, 0, 0), placementAt(2, GLOW_LAMP, 0, -20, 0), placementAt(3, "World\\Tree.m2", 0, -5, 0)];
  const prelit = new PrelitLights();
  prelit.update(objects, catalog, host(), new THREE.Vector3());
  assert.equal(prelit.count, 2, "both lamps, not the tree");
  assert.equal(near(prelit, new THREE.Vector3(0, 0, 10), 0, host()).length, 2);
  const builtIds = new Set([1]);
  const h = host((id) => builtIds.has(id));
  assert.equal(near(prelit, new THREE.Vector3(0, 0, 10), 0, h).length, 1, "a built lamp lights itself");
  const far = [];
  prelit.appendFarSources(h, far);
  assert.equal(far.length, 6, "and its far glow is the built one's");
  assert.equal(near(prelit, new THREE.Vector3(500, 0, 500), 0, host()).length, 0, "nothing past the selection's range");
});

test("24.10 (7.50): the room and open-air filters of a built lamp hold for an unbuilt one", () => {
  const catalog = new LightTemplateCatalog(null);
  catalog.learn(GLOW_LAMP, glowLamp());
  // A building's doodad: id -(placement · 1e6 + ordinal + 1).
  const street = placementAt(-(5 * 1_000_000 + 3 + 1), GLOW_LAMP, 0, 0, 0, { interior: true });
  const room = placementAt(-(5 * 1_000_000 + 4 + 1), GLOW_LAMP, 0, -2, 0, { interior: true });
  const roomLit = placementAt(-(5 * 1_000_000 + 5 + 1), GLOW_LAMP, 0, -4, 0, { interior: false, localLight: [1, 1, 1, 1] });
  const facade = placementAt(-(5 * 1_000_000 + 6 + 1), GLOW_LAMP, 0, -6, 0, { interior: false });
  const objects = [street, room, roomLit, facade];
  let known = false;
  const answer = (object) => !known ? undefined : object === street;
  const prelit = new PrelitLights();
  const h = host(() => false, answer);
  prelit.update(objects, catalog, h, new THREE.Vector3());
  assert.equal(prelit.count, 1, "before its building is known only the façade lamp lights");
  known = true;
  for (let frame = 0; frame < 12; frame++) prelit.update(objects, catalog, h, new THREE.Vector3());
  assert.equal(prelit.count, 2, "the street lamp of an open-air group joins once the building is known");
  const lit = near(prelit, new THREE.Vector3(0, 0, 0), 0, h).map((value) => Math.round(value.position.z));
  assert.ok(!lit.includes(2) && !lit.includes(4), `never the room's lamps: ${lit}`);
});

test("24.10 (7.50): lamps known from an earlier session light on the first frame, at full strength", async () => {
  const backend = new MemoryAssetBackend();
  const origin = "http://127.0.0.1:8090";
  resetGatewayGeneration();
  noteGatewayAssetGenerations(origin, "vgen1", "mgen1");
  try {
    const store = new PersistentAssetStore(backend);
    const first = new LightTemplateCatalog(store);
    await first.loaded();
    first.learn(GLOW_LAMP, glowLamp());
    first.learn(TOWER, towerModel());
    first.save();
    await store.flush();

    const later = new LightTemplateCatalog(new PersistentAssetStore(backend));
    await later.loaded();
    assert.equal(later.templates(GLOW_LAMP)?.length, 1, "the lamp's template came back");
    assert.equal(later.candidate(TOWER), true, "and a model past no name gate is known to light");
    const object = placementAt(9, TOWER, 0, 0, 0);
    const prelit = new PrelitLights();
    prelit.update([object], later, host(), new THREE.Vector3());
    const [light] = near(prelit, new THREE.Vector3(0, 0, 0), 0, host());
    assert.ok(light, "a light on the very first frame, no model fetched");
    close(light.intensity, 1.2, 1e-6, "its full strength: no fade-in over time");

    resetGatewayGeneration();
    noteGatewayAssetGenerations(origin, "vgen2", "mgen1");
    const other = new LightTemplateCatalog(new PersistentAssetStore(backend));
    await other.loaded();
    assert.equal(other.templates(GLOW_LAMP), undefined, "another visual generation reads nothing");
  } finally {
    resetGatewayGeneration();
  }
});

test("24.10 (7.50): the catalog asks for lamp models nearest first and learns what arrives", () => {
  const catalog = new LightTemplateCatalog(null);
  const asked = [];
  const arrived = new Map([[GLOW_LAMP, { wvm: glowLamp() }]]);
  const models = {
    model(name, priority) { asked.push([name, priority]); return arrived.get(name); },
    modelState(name) { return name.includes("Missing") ? "missing" : "pending"; },
  };
  const prelit = new PrelitLights();
  const objects = [
    placementAt(1, "World\\Far\\FarTorch01.m2", 900, 0, 0),
    placementAt(2, GLOW_LAMP, 10, 0, 0),
    placementAt(3, "World\\Missing\\MissingLantern.m2", 50, 0, 0),
    placementAt(4, TOWER, 20, 0, 0),
  ];
  prelit.update(objects, catalog, host(), new THREE.Vector3());
  assert.equal(catalog.pendingCount, 3, "the three lamp names; the tower's name passes no gate");
  // The loading curtain's question (`lightsReadyAround`): lamps within 100 yards still unknown.
  assert.equal(prelit.pendingNear(catalog, host(), 0, 0, 100), 2);
  catalog.pump(models);
  assert.equal(prelit.pendingNear(catalog, host(), 0, 0, 100), 0, "known now; the far torch's wait does not count");
  assert.deepEqual(asked.map(([name]) => name), [GLOW_LAMP, "World\\Missing\\MissingLantern.m2", "World\\Far\\FarTorch01.m2"]);
  assert.deepEqual(asked.map(([, priority]) => priority), ["normal", "normal", "background"]);
  assert.equal(catalog.pendingCount, 1, "the far torch is still on its way");
  assert.equal(catalog.templates("World\\Missing\\MissingLantern.m2")?.length, 0, "an absent model lights nothing");
  for (let frame = 0; frame < 12; frame++) prelit.update(objects, catalog, host(), new THREE.Vector3());
  assert.equal(prelit.count, 1, "the lamp that arrived lights");
  // The tower is learned when its first placement is built, and every placement of it then lights.
  catalog.noteLit(TOWER, towerModel());
  prelit.update(objects, catalog, host(), new THREE.Vector3());
  assert.equal(prelit.count, 2);
});

test("24.10 (7.50): the renderer's wiring — cinematic only, the built mesh's frame, built lamps skipped", () => {
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  // The faithful profile never reaches the prelit list, the catalog or its model requests.
  assert.match(renderer, /if \(cinematic\) \{\n\s+this\.#lightModels = client;\n\s+this\.#lightCatalog\.pump\(client\);\n\s+this\.#prelitLights\.update\(/);
  assert.match(renderer, /if \(cinematic\) this\.#lightCatalog\.noteLit\(name, model\);/);
  // Placed as `#wvmNode` places the mesh, and a placement with a built model is left to itself.
  assert.match(renderer, /target\.makeRotationFromQuaternion\(ADT_MODEL_TO_SCENE\)\.premultiply\(frame\.matrix\)/);
  assert.match(renderer, /built: \(id\) => this\.#environment\.get\(id\)\?\.wvm !== undefined/);
  assert.match(renderer, /this\.#zoneFogFar, this\.#prelitFar, this\.#openAirDoodad\)/);
  // The curtain: off the cinematic profile nothing waits, and no lamp holds it past the cap.
  assert.match(renderer, /lightsReadyAround\(map: number, x: number, y: number\): boolean \{\n\s+if \(this\.#lightingProfile\.cinematicLights <= 0\) return true;/);
  assert.match(renderer, /if \(now - this\.#lightsWait\.since > LIGHTS_READY_WAIT_MS\) return true;/);
  const curtain = readFileSync(new URL("../src/browser/ui/LoadingScreen.ts", import.meta.url), "utf8");
  assert.match(curtain, /\} else if \(!pageLightsReady\(world\.mapId, position\.x, position\.y\)\) \{/);
  const worker = readFileSync(new URL("../src/browser/RenderWorkerSession.ts", import.meta.url), "utf8");
  assert.match(worker, /clients\.terrain\.isReady\(map, at\[0\], at\[1\]\) && this\.#renderer\.lightsReadyAround\(map, at\[0\], at\[1\]\)/);
});

test("24.10 (7.50): a city's lamp posts read in an earlier session light before their groups arrive", async () => {
  // Four SIDN panes facing out from (1, 2, 3): one lantern (WmoOpenAirLamps.ts).
  const positions = [];
  const indices = [];
  for (const degrees of [0, 90, 180, 270]) {
    const nx = Math.cos(degrees * Math.PI / 180), ny = Math.sin(degrees * Math.PI / 180);
    const base = positions.length / 3;
    for (const [s, u] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(1 + nx * 0.3 - ny * 0.2 * s, 2 + ny * 0.3 + nx * 0.2 * s, 3 + 0.3 * u);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const glass = { positions: new Float32Array(positions), indices: new Uint16Array(indices),
    runs: [{ start: 0, count: indices.length, material: 0, blendMode: 0, materialFlags: 0xd0, lighting: 0 }] };
  const city = (meshed) => ({ groups: [
    { flags: 0x2a41, triangleCount: 8, mesh: meshed ? glass : undefined }, // a street, flagged indoor
    { flags: 0x2a05, triangleCount: 8, mesh: undefined }, // a shop
  ] });
  const backend = new MemoryAssetBackend();
  const origin = "http://127.0.0.1:8090";
  resetGatewayGeneration();
  noteGatewayAssetGenerations(origin, "vgen1", "mgen1");
  try {
    const store = new PersistentAssetStore(backend);
    const first = new LightTemplateCatalog(store);
    await first.loaded();
    const visited = city(true);
    assert.equal(wmoLanterns(visited).positions.length, 3, "this session read the street's lantern");
    first.syncWmo("World\wmo\Azeroth\Buildings\Stormwind\Stormwind.wmo", visited);
    assert.deepEqual([...first.lanternGroups("WORLD\WMO\AZEROTH\BUILDINGS\STORMWIND\STORMWIND.WMO").keys()], [0]);
    first.save();
    await store.flush();

    const later = new LightTemplateCatalog(new PersistentAssetStore(backend));
    await later.loaded();
    const arriving = city(false);
    assert.equal(wmoLanterns(arriving).positions.length, 0, "no group mesh yet: nothing found");
    later.syncWmo("World\wmo\Azeroth\Buildings\Stormwind\Stormwind.wmo", arriving);
    const lanterns = wmoLanterns(arriving);
    assert.deepEqual([...lanterns.positions].map((value) => Math.round(value * 100) / 100), [1, 2, 3],
      "the street's lantern stands before its group arrives");
    // When the group does arrive it is not read again: the lantern is not doubled.
    arriving.groups[0].mesh = glass;
    assert.equal(wmoLanterns(arriving).positions.length, 3);
  } finally {
    resetGatewayGeneration();
  }
});
