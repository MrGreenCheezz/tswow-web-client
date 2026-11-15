// 15.11 (7.16, terrain7): the ground's environment reflection — Wow.exe's `_env` terrain permutations.
// The direction is checked against the constants Wow.exe set for a reflecting chunk on the stand
// (`F:\WowOracle\runs\fog6-n-stormpeaks.tsv`, draw 619), the face order against the client's own cube
// strips (every shared cube edge must agree), the rest against what the generator and the shader read.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PNG } from "pngjs";
import * as THREE from "three";

import {
  TERRAIN_CUBE_LIMIT, terrainEnvironmentDirection, terrainEnvironmentPlan,
} from "../dist/code/browser/TerrainEnvironment.js";
import { applyTerrainSplat } from "../dist/code/browser/TerrainSplat.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import {
  CUBE_FACE_COLUMNS, MCLY_ENVIRONMENT, PREVIOUS_TERRAIN_SPLAT_GENERATION, TERRAIN_SPLAT_GENERATION, cubeFacesPng, isCubeStrip,
  publishTerrainSplat,
} from "../tools/generate-terrain-splat.mjs";
import { dbcDirectory } from "../tools/paths.mjs";
import { assertDeclaredBeforeUse, preprocess, resolveIncludes } from "./glsl-static-check.mjs";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
after(() => archives?.close());
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

// Draw 619 of the recording: vs `terrain.bls` (env permutation), ps `terrain3_pcf.bls` (env), the cube on
// stage 0. c0–c3 the view matrix (rows of world axes), c8–c10 the inverse view rotation; the camera (K line)
// at (6127, −1027, 481.864), the chunk origin c23 (6400, −800, 406.784).
const C = {
  c0: [0, 0.173648, 0.984808], c1: [-1, 0, 0], c2: [0, 0.984808, -0.173648], c3: [-1027, -1538.49, -5950.24],
  c8: [0, -1, 0], c9: [0.173648, 0, 0.984808], c10: [0.984808, 0, -0.173648],
};
const CAMERA = [6127, -1027, 481.864];

/** The client's vertex program on these constants: texcoord 0 for a world vertex and normal (WoW axes). */
function clientTexcoord(position, normal) {
  const view = (v, w) => [0, 1, 2].map((i) => v[0] * C.c0[i] + v[1] * C.c1[i] + v[2] * C.c2[i] + (w ? C.c3[i] : 0));
  const p = view(position, true);
  const n = view(normal, false);
  const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  const r = p.map((value, i) => value - 2 * d * n[i]);
  const world = [0, 1, 2].map((i) => r[0] * C.c8[i] + r[1] * C.c9[i] + r[2] * C.c10[i]);
  return [world[0], world[2], world[1]]; // `ADD result.texcoord[0].xyz, R3.xzyw, …`
}

const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const three = (wow) => new THREE.Vector3(wow[0], wow[2], -wow[1]);

test("7.16: the reflection direction is the client's texcoord 0 on the recorded constants", () => {
  // The recorded view matrix puts the K line's camera at the origin, so the constants and the camera agree.
  const eye = [0, 1, 2].map((i) => CAMERA[0] * C.c0[i] + CAMERA[1] * C.c1[i] + CAMERA[2] * C.c2[i] + C.c3[i]);
  assert.ok(Math.hypot(...eye) < 0.05, `camera at ${eye}`);
  const cases = [
    { position: [6400, -800, 406.784], normal: [0, 0, 1] },
    { position: [6366.7, -766.7, 410.2], normal: unit([0.3, -0.2, 0.93]) },
    { position: [6420, -830, 401], normal: unit([-0.5, 0.4, 0.77]) },
  ];
  for (const { position, normal } of cases) {
    const expected = unit(clientTexcoord(position, normal));
    const ours = terrainEnvironmentDirection(three(position), three(CAMERA), three(normal)).normalize();
    const dot = ours.x * expected[0] + ours.y * expected[1] + ours.z * expected[2];
    assert.ok(dot > 0.99999, `${JSON.stringify(position)}: ${ours.toArray()} vs ${expected} (cos ${dot})`);
  }
  // The flat-ground case by hand: a downward view mirrors upward, and the cube's y is the world's up.
  const flat = terrainEnvironmentDirection(three([6400, -800, 406.784]), three(CAMERA), new THREE.Vector3(0, 1, 0));
  assert.ok(flat.y > 0, "looking down at flat ground reflects the sky (cube +Y)");
});

/** GL/D3D cube addressing: a face's texel (u, v ∈ [0, 1], v = 0 the first row) as a direction, and back. */
const FACE_DIRECTION = [
  (s, t) => [1, -t, -s], (s, t) => [-1, -t, s], (s, t) => [s, 1, t],
  (s, t) => [s, -1, -t], (s, t) => [s, -t, 1], (s, t) => [-s, -t, -1],
];
function faceOf([x, y, z]) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
  if (ay >= az) return y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
  return z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
}

/** Mean colour difference across every shared cube edge of a faces picture (six squares in face order). */
function edgeMismatch(png) {
  const side = png.height;
  const texel = (face, u, v) => {
    const x = Math.min(side - 1, Math.max(0, Math.floor(u * side)));
    const y = Math.min(side - 1, Math.max(0, Math.floor(v * side)));
    const at = (y * png.width + face * side + x) * 4;
    return [png.data[at], png.data[at + 1], png.data[at + 2]];
  };
  let total = 0;
  let count = 0;
  for (let face = 0; face < 6; face++) {
    for (let i = 0; i < side; i++) {
      const along = (i + 0.5) / side;
      for (const [u, v, du, dv] of [[along, 0, 0, -1], [along, 1, 0, 1], [0, along, -1, 0], [1, along, 1, 0]]) {
        const inside = texel(face, u - du * 0.5 / side, v - dv * 0.5 / side);
        const s = 2 * (u + du * 0.5 / side) - 1;
        const t = 2 * (v + dv * 0.5 / side) - 1;
        const [other, os, ot] = faceOf(FACE_DIRECTION[face](s, t));
        const across = texel(other, (os + 1) / 2, (ot + 1) / 2);
        total += Math.abs(inside[0] - across[0]) + Math.abs(inside[1] - across[1]) + Math.abs(inside[2] - across[2]);
        count++;
      }
    }
  }
  return total / count / 3;
}

test("7.16: a cube strip is six squares; the faces come from columns 0 2 4 5 3 1 (Wow.exe 0x004b7aa0)", () => {
  assert.deepEqual([...CUBE_FACE_COLUMNS], [0, 2, 4, 5, 3, 1]);
  assert.equal(MCLY_ENVIRONMENT, 0x400);
  assert.ok(isCubeStrip({ width: 768, height: 128 }));
  assert.ok(!isCubeStrip({ width: 256, height: 256 }) && !isCubeStrip({ width: 128, height: 768 }) && !isCubeStrip(undefined));
  const side = 4;
  const strip = { width: side * 6, height: side, data: new Uint8Array(side * 6 * side * 4) };
  for (let y = 0; y < side; y++) for (let x = 0; x < side * 6; x++) {
    const at = (y * strip.width + x) * 4;
    strip.data.set([Math.floor(x / side) * 40, y, x % side, 255], at);
  }
  const faces = cubeFacesPng(strip);
  assert.equal(faces.width, side * 6);
  assert.equal(faces.height, side);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const at = (y * faces.width + face * side + x) * 4;
      assert.deepEqual([...faces.data.subarray(at, at + 4)], [CUBE_FACE_COLUMNS[face] * 40, y, x, 255], `face ${face} (${x}, ${y})`);
    }
  }
});

/** The strip's columns in the given face order, as a faces picture. */
function reordered(decoded, columns) {
  const side = decoded.height;
  const png = new PNG({ width: side * 6, height: side });
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < side; y++) {
      const from = (y * decoded.width + columns[face] * side) * 4;
      png.data.set(decoded.data.subarray(from, from + side * 4), (y * png.width + face * side) * 4);
    }
  }
  return png;
}

test("7.16: on the client's own cube strips that order closes the cube's edges best of all 720 orders", withClient, async () => {
  const { decodeBlp } = await import("../tools/blp.mjs");
  // The two strips whose art is seamless and not symmetric enough to fit several orders (TCB_SkyBlue_A
  // is a plain gradient that four orders close equally; TCB_CrystalSong_A's ground face is not seamless).
  for (const path of ["Tileset\\Generic\\tgatest.blp", "Tileset\\Terrain Cube Maps\\TCB_CrystalSong_B.blp"]) {
    const blp = await archives.read(path);
    assert.ok(blp, `${path} in the client`);
    const decoded = decodeBlp(Buffer.from(blp));
    assert.ok(isCubeStrip(decoded), `${path} is ${decoded.width}x${decoded.height}`);
    const ours = edgeMismatch(cubeFacesPng(decoded));
    assert.ok(ours < 4, `${path}: cube edges differ by ${ours.toFixed(2)} levels`);
    const orders = [];
    const permute = (rest, acc) => { if (rest.length === 0) orders.push(acc); for (const r of rest) permute(rest.filter((x) => x !== r), [...acc, r]); };
    permute([0, 1, 2, 3, 4, 5], []);
    for (const order of orders) {
      if (order.join() === CUBE_FACE_COLUMNS.join()) continue;
      const other = edgeMismatch(reordered(decoded, order));
      assert.ok(other > ours, `${path}: order ${order.join("")} closes at ${other.toFixed(2)}, the client's at ${ours.toFixed(2)}`);
    }
  }
});

const realDbc = (() => {
  try {
    const directory = dbcDirectory();
    return existsSync(join(directory, "Map.dbc")) ? directory : undefined;
  } catch {
    return undefined;
  }
})();

/** An ADT chunk, `tag` as it reads, stored reversed. */
function adtChunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** One MCNK payload with `layers` ([texture, MCLY flags]) and no alpha. */
function mapChunk(index, layers) {
  const header = Buffer.alloc(128);
  const records = Buffer.alloc(layers.length * 16);
  layers.forEach(([texture, flags], at) => {
    records.writeUInt32LE(texture, at * 16);
    records.writeUInt32LE(flags, at * 16 + 4);
  });
  header.writeUInt32LE(0x8000, 0x00);
  header.writeUInt32LE(index % 16, 0x04);
  header.writeUInt32LE(Math.floor(index / 16), 0x08);
  header.writeUInt32LE(layers.length, 0x0c);
  header.writeUInt32LE(128, 0x1c);
  return Buffer.concat([header, records]);
}

/** A raw BGRA BLP2, `colour(x, y)` → [r, g, b]. */
function rawBlp(width, height, colour) {
  const header = Buffer.alloc(148);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 3;
  header.writeUInt32LE(width, 12);
  header.writeUInt32LE(height, 16);
  header.writeUInt32LE(148, 20);
  header.writeUInt32LE(width * height * 4, 84);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = colour(x, y);
    pixels.set([b, g, r, 255], (y * width + x) * 4);
  }
  return Buffer.concat([header, pixels]);
}

test("7.16 generator: the current generation names the cube faces and the flagged chunks; legacy does not", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-terrain-env-"));
  try {
    const client = join(box, "client");
    const dbc = join(box, "dbc");
    const data = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
    await mkdir(join(data, "World", "Maps", "GunDrak"), { recursive: true });
    await mkdir(join(data, "Tileset", "Test"), { recursive: true });
    await mkdir(dbc, { recursive: true });
    await copyFile(join(realDbc, "Map.dbc"), join(dbc, "Map.dbc"));
    await writeFile(join(data, "Tileset", "Test", "Ground.blp"), rawBlp(256, 256, (x, y) => [x, y, 9]));
    // Six 8x8 squares, column k painted k · 40.
    await writeFile(join(data, "Tileset", "Test", "Cube.blp"), rawBlp(48, 8, (x, y) => [Math.floor(x / 8) * 40, y, x % 8]));
    const parts = [adtChunk("MTEX", Buffer.from("Tileset\\Test\\Ground.blp\0Tileset\\Test\\Cube.blp\0", "latin1"))];
    for (let index = 0; index < 256; index++) {
      const layers = index === 0 ? [[1, MCLY_ENVIRONMENT], [0, 0]]
        : index === 17 ? [[1, MCLY_ENVIRONMENT]]
          : index === 40 ? [[0, 0], [1, 0]] // the cube texture without the flag: no reflection
            : [[0, 0]];
      parts.push(adtChunk("MCNK", mapChunk(index, layers)));
    }
    await writeFile(join(data, "World", "Maps", "GunDrak", "GunDrak_29_28.adt"), Buffer.concat(parts));
    const publish = async (out, generation) => {
      const saved = {};
      const env = {
        CLIENT_DIR: client, CLIENT_PACK_DIR: "", DBC_DIR: dbc,
        TERRAIN_TEXTURE_DIR: join(out, "textures"), TERRAIN_LAYER_DIR: join(out, "layers"),
      };
      for (const [name, value] of Object.entries(env)) {
        saved[name] = process.env[name];
        process.env[name] = value;
      }
      const { openClientArchives } = await import("../tools/mpq.mjs");
      const local = await openClientArchives(client);
      try {
        await publishTerrainSplat(604, 28, 29, local, generation === undefined ? undefined : { generation });
      } finally {
        local.close();
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      return JSON.parse(await readFile(join(out, "textures", "604", "28-29.splat.json"), "utf8"));
    };
    const legacy = await publish(join(box, "legacy"));
    assert.equal(legacy.cubes, undefined);
    assert.equal(legacy.env, undefined);
    // A gateway built before v3 names v2 and loads the generator fresh: it still gets its v2 files.
    const previous = await publish(join(box, "previous"), PREVIOUS_TERRAIN_SPLAT_GENERATION);
    assert.equal(previous.layerSize, 256, "v2 still writes v2");
    assert.equal(previous.cubes, undefined);
    assert.equal(previous.env, undefined);
    const previousStamp = JSON.parse(await readFile(join(box, "previous", "textures", "604", "28-29.splat.json.src"), "utf8"));
    assert.equal(previousStamp.generation, PREVIOUS_TERRAIN_SPLAT_GENERATION);
    const current = await publish(join(box, "current"), TERRAIN_SPLAT_GENERATION);
    assert.equal(current.cubes.length, 2);
    assert.equal(current.cubes[0], null, "the ground texture is no cube");
    assert.match(current.cubes[1], /^[0-9a-f]{40}$/);
    assert.deepEqual(current.env, [0, 17], "the chunks with an 0x400 layer (row · 16 + column)");
    const faces = PNG.sync.read(await readFile(join(box, "current", "layers", `${current.cubes[1]}.png`)));
    assert.equal(faces.width, 48);
    assert.equal(faces.height, 8);
    for (let face = 0; face < 6; face++) assert.equal(faces.data[(3 * 48 + face * 8 + 2) * 4], CUBE_FACE_COLUMNS[face] * 40, `face ${face}`);
    const plan = terrainEnvironmentPlan(current, current.layers.length);
    assert.deepEqual(plan.cubes, [{ layer: 1, id: current.cubes[1] }]);
    assert.equal(plan.chunkRows[0], 1);
    assert.equal(plan.chunkRows[1], 1 << 1);
  } finally {
    await rm(box, { recursive: true, force: true });
  }
});

test("7.16: splat.json's cubes and env become cube ids and per-row chunk bits", () => {
  const id = (n) => n.toString(16).padStart(40, "0");
  const plan = terrainEnvironmentPlan({ cubes: [id(1), null, null], env: [0, 17, 255, 18] }, 3);
  assert.deepEqual(plan.cubes, [{ layer: 0, id: id(1) }]);
  assert.equal(plan.chunkRows[0], 1);
  assert.equal(plan.chunkRows[1], (1 << 1) | (1 << 2));
  assert.equal(plan.chunkRows[15], 1 << 15);
  assert.equal(plan.chunkRows.length, 16);
  // An older gateway, an ordinary tile, a malformed list: no reflection.
  assert.equal(terrainEnvironmentPlan({ layers: [] }, 3), undefined);
  assert.equal(terrainEnvironmentPlan({ cubes: [id(1), null, null] }, 3), undefined, "no env chunks");
  assert.equal(terrainEnvironmentPlan({ cubes: [null, null, null], env: [3] }, 3), undefined, "no cube");
  assert.equal(terrainEnvironmentPlan({ cubes: [id(1), null], env: [3] }, 3), undefined, "length differs from the layers");
  assert.equal(terrainEnvironmentPlan({ cubes: [id(1), null, null], env: [256] }, 3), undefined, "chunk out of range");
  assert.equal(terrainEnvironmentPlan({ cubes: ["x", null, null], env: [3] }, 3), undefined, "bad id");
  const three = terrainEnvironmentPlan({ cubes: [id(1), id(2), id(3)], env: [3] }, 3);
  assert.equal(three.cubes.length, TERRAIN_CUBE_LIMIT, "at most the program's cubes");
});

const FRAGMENT_PREFIX = "uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; uniform bool receiveShadow;\n";

function compiled(environment, specular = false) {
  const material = new THREE.MeshLambertMaterial({ color: 0x426b45 });
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  const splat = {
    layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1), alpha: new THREE.Texture(), index: new THREE.Texture(),
    ...(specular ? { specular: true } : {}),
    ...(environment ? { environment } : {}),
  };
  applyTerrainSplat(material, splat);
  const lib = THREE.ShaderLib.lambert;
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return { material, shader };
}

test("7.16: a reflecting tile's program samples its cubes for layer 0 in flagged chunks; others are untouched", () => {
  const plain = compiled(undefined);
  assert.ok(!plain.shader.fragmentShader.includes("samplerCube"));
  assert.ok(!plain.material.customProgramCacheKey().includes("terrain-splat-env"));
  for (const count of [1, 2]) {
    const cubes = Array.from({ length: count }, () => new THREE.CubeTexture());
    const environment = { cubes, cubeLayers: count === 1 ? [0] : [0, 4], chunkRows: new Int32Array(16) };
    for (const specular of [false, true]) {
      const { material, shader } = compiled(environment, specular);
      assert.ok(material.customProgramCacheKey().endsWith(`|terrain-splat-env-v1-${count}`));
      for (let cube = 0; cube < count; cube++) {
        assert.equal(shader.uniforms[`splatCube${cube}`].value, cubes[cube]);
        assert.equal(shader.uniforms[`splatCubeLayer${cube}`].value, environment.cubeLayers[cube]);
      }
      assert.equal(shader.uniforms.splatEnvRows.value, environment.chunkRows);
      assert.equal(shader.vertexShader.split("varying vec3 vSplatEnvDir;").length - 1, 1);
      assert.ok(shader.vertexShader.indexOf("vSplatEnvDir = ") < shader.vertexShader.indexOf("#include <project_vertex>"));
      // The same arithmetic as terrainEnvironmentDirection (checked above on the recorded constants).
      assert.match(shader.vertexShader, /reflect\( splatEnvWorld\.xyz - cameraPosition, splatEnvNormal \)/);
      assert.match(shader.vertexShader, /vSplatEnvDir = vec3\( splatEnvReflected\.x, splatEnvReflected\.y, -splatEnvReflected\.z \)/);
      const lines = preprocess(resolveIncludes(FRAGMENT_PREFIX + shader.fragmentShader), { NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: "0" });
      const start = lines.findIndex((line) => line.includes("vec4 splatSlots ="));
      const end = lines.findIndex((line) => line.includes("diffuseColor.rgb *= 0.7 + 0.3 * splatBakedLit"));
      assert.ok(start > 0 && end > start);
      const seen = assertDeclaredBeforeUse(lines.slice(0, start).join("\n"), lines.slice(start, end + 1), "splat", `env ${count}`);
      for (const name of ["splatEnvCell", "splatEnvChunk", "splatEnvTexel", "splatEnvOn"]) assert.ok(seen.has(name), name);
      const body = lines.slice(start, end + 1).join("\n");
      // The cube replaces layer 0's colour after it is read and before layers 1–3 blend over it.
      assert.ok(body.indexOf("splatColour = splatEnvTexel.rgb") > body.indexOf("vec3 splatColour = splatLayer(splatSlots.r"));
      assert.ok(body.indexOf("splatColour = splatEnvTexel.rgb") < body.indexOf("splatSlots.g >= 0.0"));
      // Row 0 of index.png is the top of the tile (v = 1), so a cell's row is 15 − its y.
      assert.match(body, /splatEnvRows\[ 15 - splatEnvCell\.y \]/);
      if (specular) assert.match(body, /splatEnvOn \? splatEnvTexel\.a : texture\(splatLayers/, "the cube's alpha is layer 0's mask");
    }
  }
});
