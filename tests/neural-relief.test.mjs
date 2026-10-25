// 25.10 (7.47, neural maps): «Нейросетевой объём» — the ground's relief from the heights tools/neural-relief.mjs
// computes with DeepBump, served as `/terrain-relief/<id>.bin`, preferred over the brightness relief while the
// setting is on, with the brightness relief wherever a map is missing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";

import {
  NEURAL_RELIEF_GAIN, neuralReliefWanted, neuralTerrainRelief, parseNeuralHeight, setNeuralReliefWanted,
  terrainReliefSourceRevision,
} from "../dist/code/browser/TerrainReliefNeural.js";
import { TERRAIN_RELIEF_DEPTH, deriveTerrainRelief } from "../dist/code/browser/TerrainReliefDerive.js";
import { setTerrainReliefWanted, terrainReliefWanted } from "../dist/code/browser/TerrainReliefShader.js";
import { TerrainSplatClient } from "../dist/code/browser/TerrainSplat.js";
import { NEURAL_RELIEF_ROUTE, parseNeuralReliefEnv, serveNeuralReliefRoute } from "../dist/code/gateway/NeuralReliefRoute.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

/** An `NRH1` file of `width`×`height` from a height function of (x, y) in layer texels. */
function heightFile(width, height, value) {
  const bytes = new Uint8Array(8 + width * height * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4e, 0x52, 0x48, 0x31]); // "NRH1"
  view.setUint16(4, width, true);
  view.setUint16(6, height, true);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) view.setInt16(8 + (y * width + x) * 2, Math.round(value(x, y) * 256), true);
  }
  return bytes;
}

/** A hill of `peak` texels, `radius` texels wide, centred on (cx, cy) of a `side`-wide repeating layer. */
const hill = (side, cx, cy, radius, peak) => (x, y) => {
  const dx = Math.min(Math.abs(x - cx), side - Math.abs(x - cx));
  const dy = Math.min(Math.abs(y - cy), side - Math.abs(y - cy));
  return peak * Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius));
};

// ---- the file and the map ----------------------------------------------------------------------

test("neural height: the file is read exactly; anything else is not a map", () => {
  const file = heightFile(4, 2, (x, y) => x - y * 0.5);
  const parsed = parseNeuralHeight(file.buffer);
  assert.equal(parsed?.width, 4);
  assert.equal(parsed?.height, 2);
  assert.deepEqual([...parsed.values], [0, 1, 2, 3, -0.5, 0.5, 1.5, 2.5]);
  const wrongMagic = file.slice();
  wrongMagic[0] = 0;
  assert.equal(parseNeuralHeight(wrongMagic.buffer), undefined);
  assert.equal(parseNeuralHeight(file.slice(0, file.byteLength - 2).buffer), undefined, "a truncated file");
  assert.equal(parseNeuralHeight(new ArrayBuffer(4)), undefined);
});

test("neural relief: flat is flat; a hill stands up in the middle and leans away from it, as the brightness relief draws one", () => {
  const flat = neuralTerrainRelief(parseNeuralHeight(heightFile(256, 256, () => 0).buffer), 256);
  assert.equal(flat.length, 128 * 128 * 4);
  for (let offset = 0; offset < flat.length; offset += 4) {
    assert.deepEqual([flat[offset], flat[offset + 1], flat[offset + 2], flat[offset + 3]], [128, 128, 128, 255]);
  }
  const map = neuralTerrainRelief(parseNeuralHeight(heightFile(256, 256, hill(256, 128, 128, 16, 2)).buffer), 256);
  const at = (x, y) => (y * 128 + x) * 4;
  assert.ok(map[at(64, 64) + 2] > 140, "the top is high");
  assert.ok(map[at(64, 64) + 2] > map[at(64 + 12, 64) + 2], "and higher than its flank");
  assert.ok(map[at(64 + 8, 64)] > 128, "the right flank's normal leans right (+u)");
  assert.ok(map[at(64 - 8, 64)] < 128, "the left flank's leans left");
  assert.ok(map[at(64, 64 + 8) + 1] > 128, "the lower flank's leans down the rows (+v)");
  // The brightness relief of a bright spot in the same place leans the same ways.
  const pixels = new Uint8ClampedArray(256 * 256 * 4);
  const bright = hill(256, 128, 128, 16, 1);
  for (let index = 0; index < 256 * 256; index++) {
    const value = 60 + 150 * bright(index % 256, Math.floor(index / 256));
    pixels.set([value, value, value, 255], index * 4);
  }
  const derived = deriveTerrainRelief({ pixels, size: 256 });
  // (Summed over the flank: the brightness relief normalises the lone spot so far that its top clips flat.)
  const flank = (relief, channel, dx, dy) => {
    let sum = 0;
    for (let step = 1; step <= 20; step++) sum += relief[at(64 + dx * step, 64 + dy * step) + channel] - 128;
    return Math.sign(sum);
  };
  assert.equal(flank(derived, 0, 1, 0), flank(map, 0, 1, 0));
  assert.equal(flank(derived, 1, 0, 1), flank(map, 1, 0, 1));
  assert.equal(flank(map, 0, 1, 0), 1);
});

test("neural relief: the height is physical — twice the texels is twice the depth, and a 512 layer keeps its scale", () => {
  const depthOf = (file, layerSize) => {
    const map = neuralTerrainRelief(parseNeuralHeight(file.buffer), layerSize);
    const side = layerSize / 2;
    return map[((side / 2) * side + side / 2) * 4 + 2] - 128;
  };
  const one = depthOf(heightFile(256, 256, hill(256, 128, 128, 16, 1)), 256);
  const two = depthOf(heightFile(256, 256, hill(256, 128, 128, 16, 2)), 256);
  assert.ok(Math.abs(two - 2 * one) <= 1, `${one} → ${two}`);
  // One texel of a 256 layer is 1/256 of a repeat: (1 / 256) / depth of the relief's 0–1, of 255.
  assert.ok(Math.abs(one - (NEURAL_RELIEF_GAIN * 255) / (256 * TERRAIN_RELIEF_DEPTH)) <= 2, String(one));
  // The same hill on a 512 layer (twice the texels for the same ground) is the same depth in yards.
  const wide = depthOf(heightFile(512, 512, hill(512, 256, 256, 32, 2)), 512);
  assert.ok(Math.abs(wide - one) <= 1, `${one} vs ${wide}`);
  // A 512 map on a 256 layer slot is boxed down to the slot's 128 side.
  assert.equal(neuralTerrainRelief(parseNeuralHeight(heightFile(512, 512, () => 0).buffer), 256).length, 128 * 128 * 4);
});

test("neural relief: the wanted flag moves the source revision only when it changes", () => {
  const before = neuralReliefWanted();
  try {
    setNeuralReliefWanted(false);
    const revision = terrainReliefSourceRevision();
    assert.equal(setNeuralReliefWanted(false), false);
    assert.equal(terrainReliefSourceRevision(), revision);
    assert.equal(setNeuralReliefWanted(true), true);
    assert.equal(terrainReliefSourceRevision(), revision + 1);
  } finally {
    setNeuralReliefWanted(before);
  }
});

// ---- the splat client --------------------------------------------------------------------------

const layerId = (value) => value.repeat(40);
const wait = async (turns = 40) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function installMocks(splats, reliefs, asked) {
  const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  const load = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const loaded = new THREE.Texture();
    queueMicrotask(() => onLoad?.(loaded));
    return loaded;
  };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const match = /^\/terrain-splat\/\d+\/(\d+)\/(\d+)$/.exec(path);
    if (match) return new Response(JSON.stringify(splats[`${match[1]}-${match[2]}`]), { status: 200 });
    const relief = /^\/terrain-relief\/([0-9a-f]{40})\.bin$/.exec(path);
    if (relief) {
      asked.push(relief[1]);
      const file = reliefs[relief[1]];
      return file ? new Response(file, { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width) { this.width = width; }
    getContext() {
      const side = this.width;
      return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(side * side * 4).fill(100) }) };
    }
  };
  return () => {
    Object.assign(globalThis, saved);
    THREE.TextureLoader.prototype.load = load;
  };
}

test("splat client: with «Нейросетевой объём» a layer with a map uses it, one without keeps the brightness relief; off again re-derives", async () => {
  const asked = [];
  const a = layerId("a");
  const b = layerId("b");
  const restore = installMocks({ "32-32": { layers: [a, b] } },
    { [a]: heightFile(256, 256, hill(256, 128, 128, 16, 2)) }, asked);
  const relief = terrainReliefWanted();
  const neural = neuralReliefWanted();
  try {
    setTerrainReliefWanted(true);
    setNeuralReliefWanted(true);
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await wait();
    const loaded = client.get(1, grid)?.relief;
    assert.ok(loaded instanceof THREE.DataArrayTexture);
    assert.deepEqual(asked.sort(), [a, b], "both layers asked the gateway");
    const slot = 128 * 128 * 4;
    const centre = (64 * 128 + 64) * 4 + 2;
    assert.ok(loaded.image.data[centre] > 140, "slot 0 is the network's hill");
    assert.equal(loaded.image.data[slot + centre], 128, "slot 1 (no map, a flat grey layer) is the brightness relief");
    assert.equal(client.reliefBytes, 2 * slot);

    let disposed = false;
    loaded.addEventListener("dispose", () => { disposed = true; });
    setNeuralReliefWanted(false);
    assert.equal(client.get(1, grid)?.relief, undefined, "the source changed: the map goes at once");
    assert.equal(disposed, true);
    await wait();
    const derived = client.get(1, grid)?.relief;
    assert.ok(derived instanceof THREE.DataArrayTexture);
    assert.equal(derived.image.data[centre], 128, "slot 0 derived from the layer's brightness now");
    assert.equal(asked.length, 2, "nothing asked of the gateway while off");
    assert.equal(client.reliefBytes, 2 * slot, "the replaced maps are no longer counted");
    client.dispose();
    assert.equal(client.reliefBytes, 0);
  } finally {
    setTerrainReliefWanted(relief);
    setNeuralReliefWanted(neural);
    restore();
  }
});

// ---- the gateway route -------------------------------------------------------------------------

test("route: only `/terrain-relief/<40 hex>.bin`; NEURAL_RELIEF=0 and its spellings switch it off", () => {
  assert.ok(NEURAL_RELIEF_ROUTE.test(`/terrain-relief/${"a".repeat(40)}.bin`));
  assert.ok(!NEURAL_RELIEF_ROUTE.test(`/terrain-relief/${"a".repeat(39)}.bin`));
  assert.ok(!NEURAL_RELIEF_ROUTE.test(`/terrain-relief/../${"a".repeat(37)}.bin`));
  assert.equal(parseNeuralReliefEnv({}), true);
  for (const off of ["0", "false", "OFF", " no "]) assert.equal(parseNeuralReliefEnv({ NEURAL_RELIEF: off }), false, off);
});

test("route: serves a current map with CORS and an ETag; refuses foreign origins; a missing or stale map is a 404", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neural-relief-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layers = join(root, "layers");
  const directory = join(root, "set");
  await mkdir(layers);
  await mkdir(join(directory, "terrain"), { recursive: true });
  const id = "c".repeat(40);
  const stale = "d".repeat(40);
  const map = heightFile(2, 2, () => 1);
  await writeFile(join(layers, `${id}.png`), "png");
  await writeFile(join(directory, "terrain", `${id}.bin`), map);
  await writeFile(join(layers, `${stale}.png`), "png");
  await writeFile(join(directory, "terrain", `${stale}.bin`), map);
  const old = new Date(Date.now() - 60_000);
  await utimes(join(directory, "terrain", `${stale}.bin`), old, old); // older than its layer
  await utimes(join(layers, `${id}.png`), old, old);

  const origin = "http://127.0.0.1:5173";
  const server = createServer(async (request, response) => {
    const handled = await serveNeuralReliefRoute(request, response, new URL(request.url, "http://x").pathname,
      { directory, layersDirectory: layers, allowedOrigins: [origin] });
    if (!handled) response.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const hit = await fetch(`${base}/terrain-relief/${id}.bin`, { headers: { origin } });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("access-control-allow-origin"), origin);
  assert.equal(hit.headers.get("cache-control"), "no-cache");
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), map);
  const etag = hit.headers.get("etag");
  assert.ok(etag);
  const again = await fetch(`${base}/terrain-relief/${id}.bin`, { headers: { origin, "if-none-match": etag } });
  assert.equal(again.status, 304);

  assert.equal((await fetch(`${base}/terrain-relief/${id}.bin`, { headers: { origin: "http://evil.test" } })).status, 403);
  assert.equal((await fetch(`${base}/terrain-relief/${id}.bin`)).status, 403, "no Origin");
  const missing = await fetch(`${base}/terrain-relief/${"e".repeat(40)}.bin`, { headers: { origin } });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/terrain-relief/${stale}.bin`, { headers: { origin } })).status, 404, "older than its layer");
  assert.equal((await fetch(`${base}/terrain-layer/${id}.png`, { headers: { origin } })).status, 418, "not this route's");
});

// ---- the setting -------------------------------------------------------------------------------

test("setting: «Нейросетевой объём», off by default and in the comparison profile, after the three «Объёмы», pushed by both appliers", async () => {
  const definition = settingDefinition("experimentalNeuralRelief");
  assert.equal(definition?.label, "Нейросетевой объём");
  assert.equal(definition?.kind, "boolean");
  assert.equal(definition?.fallback, false);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalNeuralRelief, undefined, "not part of the preset (yet)");
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalNeuralRelief, false);
  const section = SETTING_SECTIONS["Эффекты"]?.find((entry) => entry.title === "Тени и рельеф");
  assert.equal(section?.ids[section.ids.indexOf("experimentalModelRelief") + 1], "experimentalNeuralRelief", "after the three it chooses the maps of");
  assert.equal(RENDER_WORKER_COMMANDS.setNeuralRelief, "setting");
  for (const file of ["browser/ui/Settings.ts", "browser/RendererGraphicsSettings.ts"]) {
    assert.match(await source(file), /setNeuralRelief\?\.\(settingBoolean\(values, "experimentalNeuralRelief"\)\)/, file);
  }
  assert.match(await source("browser/FormalRenderBenchmarkConsole.ts"), /base\.experimentalNeuralRelief = false;/);
  assert.match(await source("gateway/GatewayConfiguration.ts"), /parseNeuralReliefEnv\(process\.env\)/);
  assert.match(await readFile(new URL("../tools/start-server.mjs", import.meta.url), "utf8"),
    /process\.env\.NEURAL_RELIEF = process\.env\.PUBLIC_NEURAL_RELIEF\?\.trim\(\) === "1" \? "1" : "0";/,
    "players get the maps only when the owner says so");
});

// ---- buildings and doodads (by texture content) ------------------------------------------------

test("content keys: the source mark is outermost and comes off whole; the setting decides it", async () => {
  const { NEURAL_RELIEF_KEY_SUFFIX, reliefSourceOf, withReliefSource, contentDigest } = await import("../dist/code/browser/WmoReliefNeural.js");
  const before = neuralReliefWanted();
  try {
    setNeuralReliefWanted(false);
    assert.equal(withReliefSource("http://x/t.png#clamp"), "http://x/t.png#clamp");
    setNeuralReliefWanted(true);
    const marked = withReliefSource("http://x/t.png#clamp");
    assert.equal(marked, `http://x/t.png#clamp${NEURAL_RELIEF_KEY_SUFFIX}`);
    assert.deepEqual(reliefSourceOf(marked), { key: "http://x/t.png#clamp", neural: true });
    assert.deepEqual(reliefSourceOf("http://x/t.png"), { key: "http://x/t.png", neural: false });
  } finally {
    setNeuralReliefWanted(before);
  }
  const { createHash } = await import("node:crypto");
  const bytes = new Uint8Array([1, 2, 3, 250]);
  assert.equal(await contentDigest(bytes), createHash("sha1").update(bytes).digest("hex"));
});

test("building texture: with the neural mark the map comes from `/neural-relief/<sha1 of the PNG>.bin`; flat or missing as before", async () => {
  const { createRequire } = await import("node:module");
  const { createHash } = await import("node:crypto");
  const { PNG } = createRequire(import.meta.url)("pngjs");
  const { loadWmoRelief } = await import("../dist/code/browser/WmoReliefLoad.js");
  const png = new PNG({ width: 128, height: 64 });
  for (let index = 0; index < 128 * 64; index++) {
    const value = 90 + 60 * Math.sin(index / 7) * Math.cos(Math.floor(index / 128) / 5);
    png.data.set([value, value, value, 255], index * 4);
  }
  const bytes = PNG.sync.write(png);
  const digest = createHash("sha1").update(bytes).digest("hex");
  const asked = [];
  let answer = heightFile(128, 64, hill(128, 64, 32, 8, 3));
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/visual/texture/a.png") return new Response(bytes, { status: 200 });
    asked.push(path);
    return answer ? new Response(answer, { status: 200 }) : new Response(null, { status: 404 });
  };
  try {
    const url = "http://gateway.test:8090/visual/texture/a.png";
    const neural = await loadWmoRelief(url, true);
    assert.deepEqual(asked, [`/neural-relief/${digest}.bin`]);
    assert.equal(neural.side, 64, "the brightness relief's side: half the 128 square");
    assert.ok(neural.relief[(32 * 64 + 32) * 4 + 2] > 140, "the network's bump, at its place");
    const brightness = await loadWmoRelief(url);
    assert.equal(asked.length, 1, "without the mark nothing is asked");
    assert.notDeepEqual(brightness.relief, neural.relief);
    answer = heightFile(128, 64, () => 0);
    assert.equal((await loadWmoRelief(url, true)).relief, undefined, "a texture the network found flat gets no map");
    answer = heightFile(64, 64, () => 1);
    assert.deepEqual((await loadWmoRelief(url, true)).relief, brightness.relief, "a map of another size is not this texture's");
    answer = undefined;
    assert.deepEqual((await loadWmoRelief(url, true)).relief, brightness.relief, "no map: the brightness relief");
  } finally {
    globalThis.fetch = saved;
  }
});

test("doodads and buildings: maps are asked for under source-marked keys; the doodads' build key carries the source", async () => {
  const m2 = await source("browser/M2Relief.ts");
  assert.match(m2, /m2ReliefMaps\(\)\.acquire\(withReliefSource\(m2ReliefMapKey\(url, slotFlags\)\)/);
  assert.match(await source("browser/WmoReliefShader.ts"), /wmoReliefMaps\(\)\.acquire\(withReliefSource\(absoluteUrl\(tracked\.url\)\)/);
  const renderer = await source("browser/WorldRenderer3D.ts");
  assert.match(renderer, /\$\{M2_RELIEF_BUILD_PREFIX\}\$\{neuralReliefWanted\(\) \? "neural\|" : ""\}\$\{key\}/);
  assert.match(renderer, /setWmoReliefActive\(false\);\n\s+setWmoReliefActive\(true\);/);
});

test("route: `/neural-relief/<sha1>.bin` from the content directory, never checked against a layer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neural-relief-content-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "set", "content"), { recursive: true });
  const id = "f".repeat(40);
  const map = heightFile(2, 2, () => 0.5);
  await writeFile(join(root, "set", "content", `${id}.bin`), map);
  const origin = "http://127.0.0.1:5173";
  const server = createServer(async (request, response) => {
    const handled = await serveNeuralReliefRoute(request, response, new URL(request.url, "http://x").pathname,
      { directory: join(root, "set"), layersDirectory: join(root, "none"), allowedOrigins: [origin] });
    if (!handled) response.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const hit = await fetch(`${base}/neural-relief/${id}.bin`, { headers: { origin } });
  assert.equal(hit.status, 200);
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), map);
  assert.equal((await fetch(`${base}/neural-relief/${"a".repeat(40)}.bin`, { headers: { origin } })).status, 404);
  assert.equal((await fetch(`${base}/neural-relief/${id}.bin`, { headers: { origin: "http://evil.test" } })).status, 403);
});
