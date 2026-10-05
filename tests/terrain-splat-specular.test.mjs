// 05.10-A7b-7Г (7.16 Г): terrain specular. The client keeps a `<name>_s.blp` beside most ground
// textures — RGB the base texture's, alpha the specular mask its fragment programs multiply the
// per-vertex `pow(max(N·H, 0), c[27].w) · c[27].rgb` with (Shaders/Vertex/arbvp1/terrain.bls). The
// `terrain-splat-v2` generation publishes that alpha as a separate grey mask per layer (the layer
// pictures stay as they were: a canvas decode of a layer whose alpha is mostly near 0 would lose
// its colour to premultiplication), `splat.json` names the masks, and the browser — only while the
// `terrainSpecular` render switch is on (off by default: c[27] is not settled by Wow.exe) — writes
// each mask into its layer's alpha and adds the term on the classic path.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import * as THREE from "three";

import { specularMaskPng, specularTexturePath } from "../tools/generate-terrain-splat.mjs";
import { dbcDirectory } from "../tools/paths.mjs";
import {
  TerrainSplatClient, applyTerrainSplat, setTerrainSpecularStrength, terrainSpecularStrength,
  terrainSpecularStrengthValue, terrainSplatSpecularMasks,
} from "../dist/code/browser/TerrainSplat.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { renderSwitches, resetRenderSwitches, setRenderSwitches } from "../dist/code/browser/RenderSwitches.js";
import {
  assertDeclaredBeforeUse, declarations, preprocess, resolveIncludes, typeCheck, typeOf,
} from "./glsl-static-check.mjs";

// ---------------------------------------------------------------- generator

test("specularTexturePath: <name>.blp → <name>_s.blp, any case; not a BLP → none", () => {
  assert.equal(specularTexturePath("Tileset\\Elwynn\\ElwynnGrassBase.blp"), "Tileset\\Elwynn\\ElwynnGrassBase_s.blp");
  assert.equal(specularTexturePath("TILESET\\X\\Y.BLP"), "TILESET\\X\\Y_s.blp");
  assert.equal(specularTexturePath("Tileset\\X\\Y.png"), undefined);
});

/** A decoded image whose alpha is `alpha(x, y)` (RGB noise that must not reach the mask). */
function decoded(width, height, alpha) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([x & 255, 77, y & 255, alpha(x, y)], (y * width + x) * 4);
  }
  return { width, height, data };
}

test("specularMaskPng: the alpha, as an opaque grey picture of the layer's side", () => {
  const same = specularMaskPng(decoded(256, 256, (x, y) => (x + y) & 255), 256);
  assert.equal(same.width, 256);
  assert.equal(same.height, 256);
  for (const [x, y] of [[0, 0], [17, 3], [255, 255], [100, 200]]) {
    const at = (y * 256 + x) * 4;
    assert.equal(same.data[at], (x + y) & 255, `${x},${y}`);
    assert.equal(same.data[at + 1], same.data[at]);
    assert.equal(same.data[at + 2], same.data[at]);
    assert.equal(same.data[at + 3], 255, "opaque: a canvas decode keeps every value");
  }
  // Another size is resampled like a layer: 512² of 2x2 blocks [0, 200; 100, 60] → their mean, 90.
  const down = specularMaskPng(decoded(512, 512, (x, y) => [[0, 200], [100, 60]][y & 1][x & 1]), 256);
  assert.equal(down.width, 256);
  for (const pixel of [0, 1, 255, 256 * 100 + 9]) assert.equal(down.data[pixel * 4], 90);
  // A missing or undecodable source gives no mask.
  assert.equal(specularMaskPng(undefined, 256), undefined);
});

/** A chunk of an ADT, `tag` as it reads, stored reversed. */
function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function mapChunk(index, texture) {
  const header = Buffer.alloc(128);
  const layers = Buffer.alloc(16);
  layers.writeUInt32LE(texture, 0);
  header.writeUInt32LE(0x8000, 0x00);
  header.writeUInt32LE(index % 16, 0x04);
  header.writeUInt32LE(Math.floor(index / 16), 0x08);
  header.writeUInt32LE(1, 0x0c);
  header.writeUInt32LE(128, 0x1c);
  return Buffer.concat([header, layers]);
}

/** A raw BGRA BLP2; `alpha` given → 8-bit alpha depth. */
function blp(width, height, colour, alpha) {
  const header = Buffer.alloc(148);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 3;
  header[9] = alpha ? 8 : 0;
  header.writeUInt32LE(width, 12);
  header.writeUInt32LE(height, 16);
  header.writeUInt32LE(148, 20);
  header.writeUInt32LE(width * height * 4, 84);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      pixels.set([b, g, r, alpha ? alpha(x, y) : 255], (y * width + x) * 4);
    }
  }
  return Buffer.concat([header, pixels]);
}

const realDbc = (() => {
  try {
    const directory = dbcDirectory();
    return existsSync(join(directory, "Map.dbc")) ? directory : undefined;
  } catch {
    return undefined;
  }
})();

/** Gundrak 28/29 with three ground textures: Big (with Big_s, 256²), Plain (none), Odd (Odd_s 64²). */
async function fixture() {
  const box = await mkdtemp(join(tmpdir(), "webclient-splat-spec-"));
  const client = join(box, "client");
  const dbc = join(box, "dbc");
  const data = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
  const maps = join(data, "World", "Maps", "GunDrak");
  const tileset = join(data, "Tileset", "Test");
  await mkdir(maps, { recursive: true });
  await mkdir(tileset, { recursive: true });
  await mkdir(dbc, { recursive: true });
  await copyFile(join(realDbc, "Map.dbc"), join(dbc, "Map.dbc"));
  await writeFile(join(tileset, "Big.blp"), blp(256, 256, (x, y) => [x, y, 9]));
  await writeFile(join(tileset, "Big_s.blp"), blp(256, 256, (x, y) => [x, y, 9], (x) => x));
  await writeFile(join(tileset, "Plain.blp"), blp(256, 256, () => [10, 20, 30]));
  await writeFile(join(tileset, "Odd.blp"), blp(256, 256, () => [50, 60, 70]));
  await writeFile(join(tileset, "Odd_s.blp"), blp(64, 64, () => [50, 60, 70], (x) => x * 4));
  const parts = [chunk("MTEX", Buffer.from("Tileset\\Test\\Big.blp\0Tileset\\Test\\Plain.blp\0Tileset\\Test\\Odd.blp\0", "latin1"))];
  for (let index = 0; index < 256; index++) parts.push(chunk("MCNK", mapChunk(index, index % 3)));
  await writeFile(join(maps, "GunDrak_29_28.adt"), Buffer.concat(parts));
  return { box, client, dbc };
}

async function publishInto(paths, out, generation) {
  const saved = {};
  const env = {
    CLIENT_DIR: paths.client, CLIENT_PACK_DIR: "", DBC_DIR: paths.dbc,
    TERRAIN_TEXTURE_DIR: join(out, "textures"), TERRAIN_LAYER_DIR: join(out, "layers"),
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  const [{ publishTerrainSplat }, { openClientArchives }] = await Promise.all([
    import("../tools/generate-terrain-splat.mjs"), import("../tools/mpq.mjs"),
  ]);
  const archives = await openClientArchives(paths.client);
  try {
    await publishTerrainSplat(604, 28, 29, archives, generation === undefined ? undefined : { generation });
  } finally {
    archives.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const tile = (part) => join(out, "textures", "604", `28-29.${part}`);
  return {
    splat: JSON.parse(await readFile(tile("splat.json"), "utf8")),
    stamp: await readFile(`${tile("splat.json")}.src`, "utf8"),
    layer: async (id) => readFile(join(out, "layers", `${id}.png`)),
    layerFiles: async () => (await readdir(join(out, "layers"))).filter((name) => name.endsWith(".png")).sort(),
  };
}

test("generator: v2 publishes each _s alpha as a grey mask named in splat.json; layers and legacy unchanged", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const paths = await fixture();
  try {
    const legacy = await publishInto(paths, join(paths.box, "legacy"));
    const v2 = await publishInto(paths, join(paths.box, "v2"), "terrain-splat-v2");
    assert.equal(legacy.splat.specular, undefined, "legacy splat.json names no masks");
    assert.equal((await legacy.layerFiles()).length, 3, "legacy writes the three layers only");

    const [big, plain, odd] = v2.splat.specular ?? [];
    assert.equal(v2.splat.specular?.length, 3);
    assert.match(big, /^[0-9a-f]{40}$/);
    assert.equal(plain, null, "no Plain_s.blp: no mask");
    assert.match(odd, /^[0-9a-f]{40}$/);
    assert.ok(!v2.splat.layers.includes(big) && big !== odd, "masks have ids of their own");
    // The layer pictures are the very files legacy wrote (v1 ids, alpha 255).
    assert.deepEqual(v2.splat.layers, legacy.splat.layers);
    for (const id of v2.splat.layers) assert.deepEqual(await v2.layer(id), await legacy.layer(id));
    assert.equal((await v2.layerFiles()).length, 5);

    const bigBytes = await v2.layer(big);
    assert.equal(bigBytes[25], 0, "a greyscale PNG");
    const bigMask = PNG.sync.read(bigBytes);
    assert.equal(bigMask.width, 256);
    for (const x of [0, 1, 128, 255]) assert.equal(bigMask.data[(40 * 256 + x) * 4], x, `Big_s alpha at x=${x}`);
    const oddMask = PNG.sync.read(await v2.layer(odd));
    assert.equal(oddMask.width, 256, "the 64² mask is brought to its layer's side");
    assert.ok(oddMask.data[(5 * 256 + 128) * 4] > 100 && oddMask.data[(5 * 256 + 128) * 4] < 160);
    // The tile's stamp follows the _s files too: a module adding or removing one rebuilds the tile.
    assert.match(v2.stamp.toLowerCase(), /big_s\.blp/);
    assert.match(v2.stamp.toLowerCase(), /plain_s\.blp/, "an absent _s is remembered as an absence");
    assert.doesNotMatch(legacy.stamp.toLowerCase(), /_s\.blp/);

    // A second v2 run leaves the masks alone (their stamps are current) and names the same ids.
    const again = await publishInto(paths, join(paths.box, "v2"), "terrain-splat-v2");
    assert.deepEqual(again.splat.specular, v2.splat.specular);
    assert.deepEqual(await again.layer(big), bigBytes);
  } finally {
    await rm(paths.box, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- browser

const layerId = (value) => value.repeat(40);
const settle = async (turns = 10) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test("terrainSplatSpecularMasks: one id or null per layer, at least one id; anything else is none", () => {
  const ids = [layerId("a"), layerId("b")];
  assert.deepEqual(terrainSplatSpecularMasks({ layers: ids, specular: [layerId("c"), null] }, 2), [layerId("c"), null]);
  assert.equal(terrainSplatSpecularMasks({ layers: ids, specular: [null, null] }, 2), undefined);
  assert.equal(terrainSplatSpecularMasks({ layers: ids, specular: [layerId("c")] }, 2), undefined, "wrong length");
  assert.equal(terrainSplatSpecularMasks({ layers: ids, specular: ["nope", null] }, 2), undefined);
  assert.equal(terrainSplatSpecularMasks({ layers: ids }, 2), undefined, "an older gateway names none");
  assert.equal(terrainSplatSpecularMasks(null, 2), undefined);
});

test("terrainSpecularStrength: the classic path only; the presets keep their look", () => {
  assert.equal(terrainSpecularStrength(0), 1);
  assert.equal(terrainSpecularStrength(1), 0);
  assert.equal(terrainSpecularStrength(2), 0);
  setTerrainSpecularStrength(0.5);
  assert.equal(terrainSpecularStrengthValue(), 0.5);
  setTerrainSpecularStrength(Number.NaN);
  assert.equal(terrainSpecularStrengthValue(), 0);
  setTerrainSpecularStrength(1);
});

/**
 * Fetch/bitmap/canvas mocks: every PNG body is one byte naming its fill value, and a decoded canvas
 * is that value in every channel — so a mask's grey lands in a known place of the layer array.
 */
function installMocks(splat, fills) {
  const saved = {
    fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas, load: THREE.TextureLoader.prototype.load,
  };
  const urls = [];
  // alpha.png and index.png go through the <img> loader where Node has no ImageBitmap.
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    urls.push(String(url));
    const texture = new THREE.Texture();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  };
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const path = new URL(String(url)).pathname;
    if (/^\/terrain-splat\/\d+\/\d+\/\d+$/.test(path)) return new Response(JSON.stringify(splat), { status: 200 });
    const layer = /^\/terrain-layer\/([0-9a-f]{40})\.png$/.exec(path);
    return new Response(new Blob([new Uint8Array([layer ? fills[layer[1]] ?? 0 : 0])]), { status: 200 });
  };
  globalThis.createImageBitmap = async (blob) => ({ fill: new Uint8Array(await blob.arrayBuffer())[0], close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width) { this.width = width; }
    getContext() {
      let fill = 0;
      const side = this.width;
      return {
        drawImage(bitmap) { fill = bitmap.fill; },
        getImageData: () => ({ data: new Uint8ClampedArray(side * side * 4).fill(fill) }),
      };
    }
  };
  return {
    urls,
    restore() {
      globalThis.fetch = saved.fetch;
      globalThis.createImageBitmap = saved.createImageBitmap;
      globalThis.OffscreenCanvas = saved.OffscreenCanvas;
      THREE.TextureLoader.prototype.load = saved.load;
    },
  };
}

async function loadTile(switchOn) {
  const splatJson = { layers: [layerId("a"), layerId("b")], specular: [layerId("c"), null] };
  const mocks = installMocks(splatJson, { [layerId("a")]: 40, [layerId("b")]: 90, [layerId("c")]: 200 });
  setRenderSwitches({ terrainSpecular: switchOn });
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 30, y: 30 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await settle();
    const splat = client.get(1, grid);
    const result = {
      asked: mocks.urls.map((url) => new URL(url).pathname),
      specular: splat?.specular,
      data: splat?.layers.image.data,
      entries: client.stats.layerRequestEntries,
    };
    client.dispose();
    return result;
  } finally {
    resetRenderSwitches();
    mocks.restore();
  }
}

test("TerrainSplatClient: switch off (default) asks for no mask and the layers keep alpha as published", async () => {
  assert.equal(renderSwitches.terrainSpecular, false, "off by default");
  const off = await loadTile(false);
  assert.ok(!off.asked.includes(`/terrain-layer/${layerId("c")}.png`));
  assert.equal(off.specular, undefined);
  assert.equal(off.entries, 2);
  assert.equal(off.data[3], 40, "layer a's own bytes");
});

test("TerrainSplatClient: switch on writes each mask into its layer's alpha, no mask → 255", async () => {
  const on = await loadTile(true);
  assert.ok(on.asked.includes(`/terrain-layer/${layerId("c")}.png`));
  assert.equal(on.specular, true);
  assert.equal(on.entries, 3);
  const side = 256 * 256 * 4;
  assert.equal(on.data[0], 40, "colour untouched");
  assert.equal(on.data[3], 200, "layer a: mask c");
  assert.equal(on.data[side - 1], 200);
  assert.equal(on.data[side + 3], 255, "layer b has no mask: full, as the client's textures without one");
  assert.equal(on.data[side], 90);
});

// ---------------------------------------------------------------- program

const FRAGMENT_PREFIX = "uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; uniform bool receiveShadow;\n";
const VERTEX_PREFIX = "uniform mat4 modelMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform mat4 viewMatrix; uniform mat3 normalMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; attribute vec3 position; attribute vec3 normal; attribute vec2 uv;\n";

function compiled(specular, worldLight = true) {
  const material = new THREE.MeshLambertMaterial({ color: 0x426b45 });
  if (worldLight) applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, {
    layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1),
    alpha: new THREE.Texture(), index: new THREE.Texture(),
    ...(specular ? { specular: true } : {}),
  });
  const lib = THREE.ShaderLib.lambert;
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return { material, shader };
}

test("7.16 Г program: a splat without masks compiles exactly as before", () => {
  const plain = compiled(false);
  assert.doesNotMatch(plain.shader.fragmentShader, /splatSpec/);
  assert.doesNotMatch(plain.shader.vertexShader, /vSplatSpecular/);
  assert.doesNotMatch(plain.material.customProgramCacheKey(), /spec/);
  const spec = compiled(true);
  assert.match(spec.material.customProgramCacheKey(), /terrain-splat-spec-v1/);
  assert.notEqual(spec.material.customProgramCacheKey(), plain.material.customProgramCacheKey());
  // Without the world light there is no sun to reflect: no specular code at all.
  assert.doesNotMatch(compiled(true, false).shader.fragmentShader, /splatSpec/);
  assert.equal(spec.shader.uniforms.splatSpecularStrength === compiled(true).shader.uniforms.splatSpecularStrength, true,
    "one shared strength object");
});

test("7.16 Г program: per-vertex pow(N·H, 20), mask blended like the colour, added in display space", () => {
  for (const shadows of [false, true]) {
    const { shader } = compiled(true);
    const defines = { USE_FOG: "", NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: shadows ? "3" : "0" };
    if (shadows) defines.USE_SHADOWMAP = "";
    // Vertex: the term after the position and normal are known.
    const vertex = preprocess(resolveIncludes(VERTEX_PREFIX + shader.vertexShader), defines);
    const vStart = vertex.findIndex((line) => line.includes("vec3 splatSpecN ="));
    const vEnd = vertex.findIndex((line) => line.includes("vSplatSpecular = pow("));
    assert.ok(vStart > 0 && vEnd > vStart, "vertex block");
    const vBefore = vertex.slice(0, vStart).join("\n");
    assert.ok(vBefore.includes("vec4 mvPosition") && vBefore.includes("vec3 transformedNormal"), "after project/normal");
    const vBody = vertex.slice(vStart, vEnd + 1);
    assertDeclaredBeforeUse(vBefore, vBody, "splatSpec", "vertex");
    const vVars = declarations(vBefore);
    vVars.set("vSplatSpecular", "float");
    const vertexTyped = typeCheck(vBody, vVars);
    assert.deepEqual(vertexTyped.problems, []);
    assert.equal(vertexTyped.checked, 4, "the four vertex statements are typed");
    assert.match(vBody.join("\n"), /pow\( max\( dot\( splatSpecN, splatSpecH \), 0\.0 \), 20\.0 \)/);

    // Fragment: the mask next to the colour, the term after the world light.
    const fragment = preprocess(resolveIncludes(FRAGMENT_PREFIX + shader.fragmentShader), defines);
    const fStart = fragment.findIndex((line) => line.includes("vec4 splatSlots ="));
    const fEnd = fragment.findIndex((line) => line.includes("reflectedLight.directDiffuse = pow( pow( reflectedLight.directDiffuse"));
    assert.ok(fStart > 0 && fEnd > fStart, "fragment block");
    const fBefore = fragment.slice(0, fStart).join("\n");
    const fBody = fragment.slice(fStart, fEnd + 1);
    assertDeclaredBeforeUse(fBefore, fBody, "splatSpec", "fragment");
    const fVars = declarations(fBefore);
    fVars.set("diffuseColor", "vec4");
    fVars.set("reflectedLight", "ReflectedLight");
    // Every name the block declares (the splat's own, the world light's) is known to the typer; the
    // lines typed are the specular ones.
    for (const [name, type] of declarations(fBody.join("\n"))) if (!/^splatSpec/.test(name)) fVars.set(name, type);
    const fragmentTyped = typeCheck(fBody.filter((line) => /splatSpec|vSplatSpecular/.test(line)), fVars,
      (expression) => /[?<>[&|!]|==|\bint\b|splatLayer\(|getShadow|reflectedLight/.test(expression));
    assert.deepEqual(fragmentTyped.problems, []);
    assert.equal(fragmentTyped.checked, 1, "splatSpecWeight");
    // The statements the typer skips (ternary, `if` bodies, the struct member) by hand.
    fVars.set("splatSpecMask", "float");
    fVars.set("splatSpecWeight", "float");
    fVars.set("splatLayers", "sampler2DArray");
    assert.equal(typeOf("texture(splatLayers, vec3(splatDetail, splatSlots.r)).a", fVars), "float");
    assert.equal(typeOf("mix( splatSpecMask, texture(splatLayers, vec3(splatDetail, splatSlots.b)).a, splatBlend.g )", fVars), "float");
    fVars.set("directDiffuse", "vec3");
    assert.equal(typeOf("pow( pow( directDiffuse, vec3( 1.0 / 2.2 ) ) + wowDiffuse * splatSpecWeight, vec3( 2.2 ) )", fVars), "vec3");
    const text = fBody.join("\n");
    assert.match(text, /float splatSpecMask = /);
    assert.match(text, /splatSpecMask = mix\( splatSpecMask, texture\(splatLayers, vec3\(splatDetail, splatSlots\.g\)\)\.a, splatBlend\.r \)/);
    assert.match(text, /float splatSpecWeight = vSplatSpecular \* splatSpecMask \* splatBakedLit \* wowShadow \* splatSpecularStrength;/);
    assert.ok(text.indexOf("float splatSpecWeight") > text.indexOf("vec3 wowAuthoredLight"), "after the world light");
    assert.equal(fBefore.split("uniform float splatSpecularStrength;").length - 1, 1);
    assert.equal(fBefore.split("varying float vSplatSpecular;").length - 1, 1);
  }
});

test("the renderer sets the specular strength with the baked shadow's, once per lighting change", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  setLightingQuality(quality: number): void {"));
  assert.match(body.slice(0, body.indexOf("\n  }\n")), /setTerrainSpecularStrength\(terrainSpecularStrength\(next\.quality\)\)/);
  assert.equal(source.split("setTerrainSpecularStrength(").length - 1, 1, "and nowhere per frame");
});

// ---------------------------------------------------------------- 05.10 review (7.16 Б/Г)

test("05.10 review: the specular program with MCCV, micro-normals and shadows — every combination", async () => {
  const { setTerrainSplatMicroNormals } = await import("../dist/code/browser/TerrainSplat.js");
  for (const painted of [false, true]) for (const micro of [false, true]) for (const shadows of [false, true]) {
    const label = JSON.stringify({ painted, micro, shadows });
    const material = new THREE.MeshLambertMaterial({ color: 0x426b45 });
    applyWorldLight(material, createWorldLightUniforms(), "terrain");
    applyTerrainSplat(material, {
      layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1),
      alpha: new THREE.Texture(), index: new THREE.Texture(), specular: true,
      ...(painted ? { colours: new THREE.Texture() } : {}),
    });
    if (micro) setTerrainSplatMicroNormals(material, true);
    const lib = THREE.ShaderLib.lambert;
    const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    material.onBeforeCompile(shader, {}); // the micro-normal hook throws on a doubled marker
    const key = material.customProgramCacheKey();
    assert.match(key, /terrain-splat-spec-v1/, label);
    assert.equal(/terrain-splat-mccv-v2/.test(key), painted, label);
    assert.equal(/terrain-micro-normal-v1/.test(key), micro, label);
    const defines = { USE_FOG: "", NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: shadows ? "3" : "0" };
    if (shadows) defines.USE_SHADOWMAP = "";
    const fragment = preprocess(resolveIncludes(FRAGMENT_PREFIX + shader.fragmentShader), defines);
    const start = fragment.findIndex((line) => line.includes("vec4 splatSlots ="));
    const end = fragment.findIndex((line) => line.includes("reflectedLight.directDiffuse = pow( pow( reflectedLight.directDiffuse"));
    assert.ok(start > 0 && end > start, `${label}: fragment block`);
    const before = fragment.slice(0, start).join("\n");
    const seen = assertDeclaredBeforeUse(before, fragment.slice(start, end + 1), "splat", label);
    for (const name of ["splatSpecMask", "splatSpecWeight", "splatBakedLit", "splatBlend"]) assert.ok(seen.has(name), `${label}: ${name}`);
    assert.equal(before.split("uniform float splatSpecularStrength;").length - 1, 1, label);
    const text = fragment.join("\n");
    // The mask follows the blended colour; MCCV (when painted) and the micro normal stay in place.
    assert.ok(text.indexOf("diffuseColor.rgb *= splatColour;") < text.indexOf("float splatSpecMask"), label);
    if (painted) assert.ok(text.indexOf("float splatSpecMask") < text.indexOf("texture2D(splatColours"), label);
    if (micro) assert.equal(text.split("terrain-micro-normal-v1").length - 1, 1, label);
    const vertex = preprocess(resolveIncludes(VERTEX_PREFIX + shader.vertexShader), defines).join("\n");
    assert.equal(vertex.split("uniform vec3 wowSunDirection;").length - 1, 1, `${label}: one vertex sun uniform`);
    assert.equal(vertex.split("varying float vSplatSpecular;").length - 1, 1, label);
  }
});

test("05.10 review: Wow.exe's terrain constants — c[18] repeat and c[27].w exponent", async () => {
  const { SPLAT_REPEAT, TERRAIN_SPECULAR_EXPONENT } = await import("../dist/code/browser/TerrainSplat.js");
  // c[18] = (-K, -K, 0, 0), K = -1 / -4.166667 (0x00A3FDD4 → 0x00D254A8 → 0x00D25488 in 0x007C3D90;
  // uploaded by 0x007D0050): one texture per 4.1667 yards, eight per 33.33-yard chunk, 16 chunks a tile.
  assert.equal(SPLAT_REPEAT, Math.round((533.3333 / 16 / 4.166667) * 16));
  assert.equal(SPLAT_REPEAT, 128);
  // c[27].w = the float at 0x00A3FFF0 (20.0), stored at 0x007CFE5C.
  assert.equal(TERRAIN_SPECULAR_EXPONENT, 20);
});
