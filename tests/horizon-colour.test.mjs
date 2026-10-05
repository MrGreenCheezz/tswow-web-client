// 05.10-A7b-7 (7.08 slice A): the far horizon lit by the world and coloured by the map's own
// minimap — the generator (`tools/generate-horizon-colour.mjs`), its route, the geometry's normals
// and UVs, the browser's colour client and the material choice per lighting preset, and a static
// check of the lit program (a compile error is a white horizon on reload).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import { PNG } from "pngjs";

import {
  HORIZON_COLOUR_SIDE, HorizonClient, buildHorizonGeometry, horizonColourWanted, horizonTileAt,
} from "../dist/code/browser/Horizon.js";
import { HorizonMaterialSelector } from "../dist/code/browser/HorizonMaterial.js";
import { createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  HORIZON_FALLBACK_RGB, averageBlocks, composeHorizonColour,
} from "../tools/generate-horizon-colour.mjs";
import { SourceMissing } from "../tools/source-missing.mjs";
import { dbcDirectory } from "../tools/paths.mjs";
import {
  assertDeclaredBeforeUse, declarations, preprocess, resolveIncludes, typeCheck,
} from "./glsl-static-check.mjs";

const ORIGIN = "http://127.0.0.1:5173";

function image(width, height, colour) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([...colour(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test("averageBlocks: one texel per 16x16 block, averaged in linear light", () => {
  // Black and white checker → linear 0.5 → sRGB 188, not the 128 of a gamma-space mean.
  const out = averageBlocks(image(256, 256, (x, y) => ((x + y) & 1 ? [255, 255, 255] : [0, 0, 0])));
  assert.equal(out.length, 16 * 16 * 3);
  assert.equal(out[0], 188);
  // Left half red, right half blue: texel 7 is red, texel 8 blue, row 3 the same.
  const halves = averageBlocks(image(256, 256, (x) => (x < 128 ? [200, 0, 0] : [0, 0, 200])));
  assert.deepEqual([...halves.subarray((3 * 16 + 7) * 3, (3 * 16 + 7) * 3 + 3)], [200, 0, 0]);
  assert.deepEqual([...halves.subarray((3 * 16 + 8) * 3, (3 * 16 + 8) * 3 + 3)], [0, 0, 200]);
});

test("composeHorizonColour: tile gridX-gridY lands at row gridX*16, column gridY*16; gaps keep the old green", async () => {
  const loads = [];
  const { png, used, painted } = await composeHorizonColour(
    { "3-5": "aa", "3-6": "aa", "40-2": "bb", "9-9": "missing" },
    async (hash) => {
      loads.push(hash);
      if (hash === "aa") return image(256, 256, (x, y) => (y < 128 ? [250, 0, 0] : [0, 250, 0]));
      if (hash === "bb") return image(256, 256, () => [0, 0, 250]);
      return undefined;
    },
  );
  assert.deepEqual(loads.sort(), ["aa", "bb", "missing"], "each bake decoded once, however many cells share it");
  assert.deepEqual(used.sort(), ["aa", "bb"]);
  assert.equal(painted, 3);
  assert.equal(png.width, HORIZON_COLOUR_SIDE);
  const at = (row, column) => [...png.data.subarray((row * HORIZON_COLOUR_SIDE + column) * 4, (row * HORIZON_COLOUR_SIDE + column) * 4 + 3)];
  // Tile 3-5: rows 48..63, columns 80..95; the bake's top half (north) is red.
  assert.deepEqual(at(48, 80), [250, 0, 0]);
  assert.deepEqual(at(63, 95), [0, 250, 0]);
  assert.deepEqual(at(48, 96), [250, 0, 0], "tile 3-6 beside it, to the east");
  assert.deepEqual(at(40 * 16 + 4, 2 * 16 + 4), [0, 0, 250]);
  // Not transposed: row 80, column 48 is not tile 3-5.
  assert.deepEqual(at(80, 48), [...HORIZON_FALLBACK_RGB]);
  assert.deepEqual(at(9 * 16, 9 * 16), [...HORIZON_FALLBACK_RGB], "a bake the archives lack keeps the green");
  assert.deepEqual(at(0, 0), [...HORIZON_FALLBACK_RGB]);
});

const realDbc = (() => {
  try {
    const directory = dbcDirectory();
    return existsSync(join(directory, "Map.dbc")) ? directory : undefined;
  } catch {
    return undefined;
  }
})();

/** A raw BGRA BLP2. */
function blp(width, height, colour) {
  const header = Buffer.alloc(148);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 3;
  header.writeUInt32LE(width, 12);
  header.writeUInt32LE(height, 16);
  header.writeUInt32LE(148, 20);
  header.writeUInt32LE(width * height * 4, 84);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      pixels.set([b, g, r, 255], (y * width + x) * 4);
    }
  }
  return Buffer.concat([header, pixels]);
}

test("publishHorizonColour: md5translate → bakes → PNG and stamp; a map without bakes is SourceMissing", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-horizon-colour-"));
  const client = join(box, "client");
  const dbc = join(box, "dbc");
  const minimap = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "textures", "Minimap");
  await mkdir(minimap, { recursive: true });
  await mkdir(dbc, { recursive: true });
  await copyFile(join(realDbc, "Map.dbc"), join(dbc, "Map.dbc"));
  // Gundrak (604), ADT name 29_28 → gridY 29, gridX 28; its bake: west half red, east half blue.
  await writeFile(join(minimap, "md5translate.trs"), "dir: GunDrak\r\nGunDrak\\map29_28.blp\tabcdef0123456789abcdef0123456789.blp\r\n");
  await writeFile(join(minimap, "abcdef0123456789abcdef0123456789.blp"), blp(256, 256, (x) => (x < 128 ? [220, 10, 10] : [10, 10, 220])));
  const saved = { CLIENT_DIR: process.env.CLIENT_DIR, CLIENT_PACK_DIR: process.env.CLIENT_PACK_DIR, DBC_DIR: process.env.DBC_DIR, HORIZON_DIR: process.env.HORIZON_DIR };
  Object.assign(process.env, { CLIENT_DIR: client, CLIENT_PACK_DIR: "", DBC_DIR: dbc, HORIZON_DIR: join(box, "horizon") });
  const [{ publishHorizonColour }, { openClientArchives }] = await Promise.all([
    import("../tools/generate-horizon-colour.mjs"), import("../tools/mpq.mjs"),
  ]);
  const archives = await openClientArchives(client);
  try {
    const result = await publishHorizonColour(604, archives);
    assert.equal(result.painted, 1);
    const png = PNG.sync.read(await readFile(join(box, "horizon", "604.colour.png")));
    const at = (row, column) => [...png.data.subarray((row * 1024 + column) * 4, (row * 1024 + column) * 4 + 3)];
    assert.deepEqual(at(28 * 16, 29 * 16), [220, 10, 10], "the bake's west edge at the tile's west column");
    assert.deepEqual(at(28 * 16 + 15, 29 * 16 + 15), [10, 10, 220]);
    const stamp = JSON.parse(await readFile(join(box, "horizon", "604.colour.png.src"), "utf8"));
    assert.ok(stamp.sources.some((source) => /md5translate\.trs$/i.test(source.path)), "stamped with the index");
    assert.ok(stamp.sources.some((source) => /abcdef0123456789abcdef0123456789\.blp$/i.test(source.path)), "and the bake");
    await assert.rejects(publishHorizonColour(0, archives), (error) => error instanceof SourceMissing);
  } finally {
    archives.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(box, { recursive: true, force: true });
  }
});

test("route /horizon/<map>/colour.png: Origin, publish on a miss, 404 for SourceMissing, 500 for a crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-horizon-route-"));
  const calls = [];
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
    allowedOrigins: [ORIGIN], horizonDirectory: directory,
    generateHorizonColour: async (map) => {
      calls.push(map);
      if (map === 1) {
        await writeFile(join(directory, "1.colour.png"), PNG.sync.write(new PNG({ width: 4, height: 4 }), { colorType: 2 }));
        return;
      }
      throw Object.assign(new Error("no"), { exitCode: map === 2 ? 3 : 1 });
    },
  });
  try {
    const get = async (path, origin = ORIGIN) => {
      const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers: { origin } });
      return { status: response.status, type: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength };
    };
    assert.equal((await get("/horizon/1/colour.png", "http://evil.test")).status, 403);
    const first = await get("/horizon/1/colour.png");
    assert.equal(first.status, 200);
    assert.equal(first.type, "image/png");
    assert.ok(first.bytes > 0);
    assert.equal((await get("/horizon/1/colour.png")).status, 200);
    assert.deepEqual(calls, [1], "published once, then read from disk");
    assert.equal((await get("/horizon/2/colour.png")).status, 404, "no minimap: final 404");
    assert.equal((await get("/horizon/3/colour.png")).status, 500);
    assert.equal((await get("/horizon/1/colour.jpg")).status, 404, "nothing else under the map");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** A tile of constant slope: height = base + south·row + east·column on the outer grid. */
function tile(gridX, gridY, { base = 100, south = 0, east = 0 } = {}) {
  const outer = new Int16Array(17 * 17);
  const inner = new Int16Array(16 * 16);
  for (let row = 0; row < 17; row++) {
    for (let column = 0; column < 17; column++) {
      outer[row * 17 + column] = base + south * (row + gridX * 16) + east * (column + gridY * 16);
    }
  }
  for (let row = 0; row < 16; row++) {
    for (let column = 0; column < 16; column++) {
      inner[row * 16 + column] = Math.round(base + south * (row + 0.5 + gridX * 16) + east * (column + 0.5 + gridY * 16));
    }
  }
  return { gridX, gridY, outer, inner };
}

test("buildHorizonGeometry: flat ground faces up; a slope tilts its normal downhill; UVs follow the picture", () => {
  const flat = buildHorizonGeometry([tile(30, 30)]);
  const normals = flat.getAttribute("normal");
  assert.equal(normals.count, 17 * 17 + 16 * 16);
  for (let index = 0; index < normals.count; index += 37) {
    assert.equal(normals.getY(index), 1);
    assert.equal(normals.getX(index), 0);
    assert.equal(normals.getZ(index), 0);
  }
  // Rising 3 yards per row southward (−x): the normal leans north (+x); rising eastward (+z): leans −z.
  const southSlope = buildHorizonGeometry([tile(30, 30, { south: 3 })]).getAttribute("normal");
  const step = 533.3333 / 16;
  for (const index of [0, 8 * 17 + 8, 17 * 17 + 5]) {
    assert.ok(Math.abs(southSlope.getX(index) - (3 / step) / Math.hypot(3 / step, 1)) < 1e-4, `vertex ${index}`);
    assert.ok(Math.abs(southSlope.getZ(index)) < 1e-6);
  }
  const eastSlope = buildHorizonGeometry([tile(30, 30, { east: 2 })]).getAttribute("normal");
  assert.ok(eastSlope.getZ(8 * 17 + 8) < -0.05);
  // A lit face: the normal agrees with the triangle's own winding (up-facing, as the mesh is wound).
  const position = flat.getAttribute("position");
  const index = flat.getIndex();
  const a = new THREE.Vector3().fromBufferAttribute(position, index.getX(0));
  const b = new THREE.Vector3().fromBufferAttribute(position, index.getX(1));
  const c = new THREE.Vector3().fromBufferAttribute(position, index.getX(2));
  const faceUp = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).y;
  assert.ok(faceUp > 0, "the winding faces up, the same way as the normal");

  const uv = buildHorizonGeometry([tile(30, 20)]).getAttribute("uv");
  assert.equal(uv.getX(0), (20 * 16) / 1024, "column 0 of tile gridY 20");
  assert.equal(uv.getY(0), (30 * 16) / 1024, "row 0 of tile gridX 30, v = 0 at the top of the picture");
  assert.equal(uv.getX(16), (20 * 16 + 16) / 1024);
  assert.equal(uv.getY(16 * 17), (30 * 16 + 16) / 1024, "rows run with gridX");
  assert.equal(uv.getX(17 * 17), (20 * 16 + 0.5) / 1024, "an inner vertex sits mid-cell");
  assert.equal(uv.getY(17 * 17), (30 * 16 + 0.5) / 1024);
});

test("buildHorizonGeometry: with the map's neighbours the shared edge gets one normal on both tiles", () => {
  // A ridge along the shared edge: the north tile climbs 2 a row southward to it, the south tile
  // falls 2 a row away from it. Seen across the join the crest is level (normal straight up) on both
  // tiles; each tile alone would tilt it its own way.
  const north = tile(30, 30, { south: 2 });
  const crest = north.outer[16 * 17];
  const south = { gridX: 31, gridY: 30, outer: new Int16Array(17 * 17), inner: new Int16Array(16 * 16) };
  for (let row = 0; row < 17; row++) for (let column = 0; column < 17; column++) south.outer[row * 17 + column] = crest - 2 * row;
  const map = { tiles: new Map([[30 * 64 + 30, north], [31 * 64 + 30, south]]) };
  const lookup = (x, y) => horizonTileAt(map, x, y);
  const normals = buildHorizonGeometry([north, south], lookup).getAttribute("normal");
  const perTile = 17 * 17 + 16 * 16;
  const a = 16 * 17 + 4; // north tile, last row
  const b = perTile + 4; // south tile, first row: the same world vertex
  assert.equal(normals.getX(a), normals.getX(b));
  assert.equal(normals.getY(a), 1, "level at the crest");
  const alone = buildHorizonGeometry([north, south]).getAttribute("normal");
  assert.ok(alone.getX(a) > 0.05 && alone.getX(b) < -0.05, "without the map each side tilts its own way");
  assert.equal(horizonTileAt(map, 5, 5), undefined);
});

test("horizonColourWanted / HorizonMaterialSelector: lit and coloured on the classic path only", () => {
  assert.equal(horizonColourWanted(0, true), true);
  assert.equal(horizonColourWanted(0, false), false);
  assert.equal(horizonColourWanted(1, true), false);
  assert.equal(horizonColourWanted(2, true), false);
  const basic = new THREE.MeshBasicMaterial({ color: 0x4a6b4f });
  const selector = new HorizonMaterialSelector(basic, createWorldLightUniforms());
  const texture = new THREE.Texture();
  let asked = 0;
  const colour = () => { asked++; return texture; };
  assert.equal(selector.select(1, colour) === basic, true, "enhanced: flat");
  assert.equal(selector.select(2, colour) === basic, true, "cinematic: flat");
  assert.equal(asked, 0, "the presets never ask for the picture");
  assert.equal(selector.select(0, () => undefined) === basic, true, "classic before the picture: flat");
  const lit = selector.select(0, colour);
  assert.equal(lit === basic, false);
  assert.equal(lit.type, "MeshLambertMaterial");
  assert.equal(lit.map === texture, true);
  assert.match(lit.customProgramCacheKey(), /world-light-r185-v6:terrain/);
  const other = new THREE.Texture();
  assert.equal(selector.select(0, () => other) === lit, true, "one lit material for every map");
  assert.equal(lit.map === other, true);
  selector.dispose();
  assert.equal(selector.lit, undefined);
});

test("the lit horizon program: world light declares and types cleanly with a colour map", () => {
  const selector = new HorizonMaterialSelector(new THREE.MeshBasicMaterial(), createWorldLightUniforms());
  const lit = selector.select(0, () => new THREE.Texture());
  const lib = THREE.ShaderLib.lambert;
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  lit.onBeforeCompile(shader, {});
  const prefix = "uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; uniform bool receiveShadow;\n";
  const lines = preprocess(resolveIncludes(prefix + shader.fragmentShader),
    { USE_FOG: "", USE_MAP: "", MAP_UV: "vMapUv", NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: "0" });
  const start = lines.findIndex((line) => line.includes("vec3 wowViewSunDirection ="));
  const end = lines.findIndex((line) => line.includes("reflectedLight.directDiffuse = diffuseColor.rgb * pow( wowLight"));
  assert.ok(start > 0 && end > start, "world-light body present");
  const before = lines.slice(0, start).join("\n");
  assert.match(before, /texture2D\( map, vMapUv \)/, "the colour map is sampled before the light");
  const body = lines.slice(start, end + 1);
  assertDeclaredBeforeUse(before, body, "wow", "horizon");
  const variables = declarations(before);
  variables.set("normal", "vec3");
  variables.set("vViewPosition", "vec3");
  variables.set("diffuseColor", "vec4");
  const { problems, checked } = typeCheck(body, variables);
  assert.deepEqual(problems, []);
  assert.ok(checked > 20, `typed ${checked}`);
  // Vertex: normals and UVs reach the program (USE_UV via the map), and aerial fog is wired.
  assert.match(shader.vertexShader, /wowAtmosphereView/);
  assert.match(shader.fragmentShader, /#define WOW_LIGHT_TERRAIN/);
  selector.dispose();
});

test("HorizonClient.colour: after the .wdl only, 404 is final, the previous map's texture is released", async () => {
  const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap };
  const requested = [];
  // A minimal valid .wdl: a MAOF table with no tiles.
  const wdl = Buffer.alloc(8 + 4096 * 4);
  wdl.write("FOAM", 0, "latin1");
  wdl.writeUInt32LE(4096 * 4, 4);
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    requested.push(path);
    if (/^\/horizon\/\d+$/.test(path)) return new Response(wdl, { status: 200 });
    if (path === "/horizon/0/colour.png") return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
    if (path === "/horizon/1/colour.png") return new Response(null, { status: 404 });
    return new Response(null, { status: 500 });
  };
  globalThis.createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
  const settle = async () => { for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve)); };
  try {
    let clock = 0;
    const client = new HorizonClient("ws://example.test:1234/world", () => clock);
    assert.equal(client.colour(0), undefined);
    assert.ok(!requested.includes("/horizon/0/colour.png"), "nothing before the .wdl");
    client.get(0);
    await settle();
    assert.equal(client.colour(0), undefined, "first ask starts the download");
    await settle();
    const texture = client.colour(0);
    assert.ok(texture instanceof THREE.Texture);
    assert.equal(texture.flipY, false);
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    let disposed = 0;
    texture.addEventListener("dispose", () => { disposed++; });
    client.get(1);
    await settle();
    client.colour(1);
    await settle();
    assert.equal(client.colour(1), undefined, "404: flat green for good");
    assert.equal(disposed, 1, "map 0's texture released on the switch");
    const before = requested.filter((path) => path === "/horizon/1/colour.png").length;
    clock += 120_000; // past every step of the retry ladder
    client.colour(1);
    await settle();
    assert.equal(requested.filter((path) => path === "/horizon/1/colour.png").length, before, "no second request");
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.createImageBitmap = saved.createImageBitmap;
  }
});

test("the renderer picks the horizon material per frame from the preset and builds with the map's neighbours", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  #updateHorizon(player: WorldPosition"));
  const method = body.slice(0, body.indexOf("\n  }\n"));
  assert.match(method, /this\.#horizonMaterials\.select\(this\.#lightingProfile\.quality, \(\) => horizonClient\?\.colour\(map\)\)/);
  assert.ok(method.indexOf("#horizonMaterials.select(") < method.indexOf("if (this.#horizon?.key === key) return;"),
    "chosen before the unchanged-ring early return, so a preset change or a late picture applies at once");
  assert.match(method, /buildHorizonGeometry\(tiles, \(x, y\) => horizonTileAt\(world, x, y\)\), horizonMaterial\)/);
  assert.match(source, /this\.#horizonMaterials\?\.dispose\(\);/);
});
