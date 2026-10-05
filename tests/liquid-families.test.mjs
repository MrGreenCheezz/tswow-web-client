// 05.10-A7b-8 — slice 8 of line A7b, «Жидкости» (7.09 slice A): each LiquidType row draws with its
// own texture family's strip (`fast_a` 16 frames, `lavagreen`, `lavaorange`) while the shading keeps
// following the class; the class strips, their route and their generator bytes stay as they were.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";

import {
  LiquidTextureClient, buildLiquidMaterial, buildLiquidSurfaces, liquidSurfaceClass, liquidSurfaceFamily,
  liquidSurfaceOf, parseLiquidTypes, updateLiquidMaterial,
} from "../dist/code/browser/Water.js";
import {
  liquidFamilyOf, liquidFamilyPattern, liquidFrameInputs, liquidTexturePattern,
} from "../tools/generate-liquid-texture.mjs";
import { SourceMissing } from "../tools/source-missing.mjs";

/** The rows of this client's `LiquidType.dbc` that decide the surfaces (probe-rows.out.txt). */
const ROWS = {
  1: { soundBank: 0, family: "lake_a", textures: ["XTextures\\river\\lake_a.%d.blp", "proceduralRiverDepthTex"] },
  2: { soundBank: 1, family: "ocean_h", textures: ["XTextures\\ocean\\ocean_h.%d.blp"] },
  3: { soundBank: 2, family: "lava", textures: ["XTextures\\lava\\lava.%d.blp"] },
  4: { soundBank: 3, family: "slime", textures: ["XTextures\\slime\\slime.%d.blp"] },
  5: { soundBank: 0, family: "lake_a", textures: ["XTextures\\river\\lake_a.%d.blp"] },
  9: { soundBank: 0, family: "fast_a", textures: ["XTextures\\river\\fast_a.%d.blp"] },
  15: { soundBank: 2, family: "lavagreen", textures: ["XTextures\\LavaGreen\\lavagreen.%d.blp"] },
  100: { soundBank: 1, family: "basicreflectionmap", textures: ["XTextures\\procWater\\basicReflectionMap.blp"] },
  181: { soundBank: 0, family: "lavaorange", textures: ["XTEXTURES\\LavaOrange\\LavaOrange.%d.blp"] },
};
const CLASSES = { 1: "water", 2: "ocean", 3: "magma", 4: "slime", 5: "water", 9: "water", 15: "magma", 100: "ocean", 181: "magma" };

test("surfaces: a row keeps its class strip unless its family is another one", () => {
  const surfaces = buildLiquidSurfaces(new Map(Object.entries(CLASSES).map(([id, c]) => [Number(id), c])), ROWS);
  assert.deepEqual(Object.fromEntries(surfaces), {
    1: "water", 2: "ocean", 3: "magma", 4: "slime", 5: "water",
    9: "water|fast_a", 15: "magma|lavagreen", 100: "ocean", 181: "magma|lavaorange",
  });
});

test("surfaces: the v2 body parses to classes and surfaces; the v1 record keeps classes only", () => {
  const v2 = parseLiquidTypes({ version: 2, classes: CLASSES, rows: ROWS });
  assert.equal(v2.classes.get(181), "magma");
  assert.equal(v2.surfaces?.get(15), "magma|lavagreen");
  const v1 = parseLiquidTypes(CLASSES);
  assert.equal(v1.classes.get(15), "magma");
  assert.equal(v1.classes.size, 9);
  assert.equal(v1.surfaces, undefined, "an older gateway's body leaves every surface its class");
  // Malformed rows are skipped, not trusted.
  const odd = parseLiquidTypes({ version: 2, classes: CLASSES, rows: { 9: { family: 3 } } });
  assert.equal(odd.surfaces?.get(9), "water");
});

test("surfaces: class and family of a surface, and the cell's surface by its row", () => {
  assert.equal(liquidSurfaceClass("magma|lavagreen"), "magma");
  assert.equal(liquidSurfaceClass("water"), "water");
  assert.equal(liquidSurfaceClass("slime"), "slime");
  assert.equal(liquidSurfaceFamily("water|fast_a"), "fast_a");
  assert.equal(liquidSurfaceFamily("ocean"), undefined);
  const surfaces = new Map([[9, "water|fast_a"], [15, "magma|lavagreen"]]);
  assert.equal(liquidSurfaceOf("water", 9, surfaces), "water|fast_a");
  assert.equal(liquidSurfaceOf("water", 9, undefined), "water");
  assert.equal(liquidSurfaceOf("water", 0, surfaces), "water");
  assert.equal(liquidSurfaceOf("ocean", 15, surfaces), "ocean", "a class the row does not have is kept");
});

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function mockStrips(handler) {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const fetched = [];
  const loaded = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return handler(String(url));
  };
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    loaded.push(String(url));
    const texture = new THREE.Texture();
    setImmediate(() => onLoad(texture));
    return texture;
  };
  return {
    fetched, loaded,
    restore: () => { globalThis.fetch = originalFetch; THREE.TextureLoader.prototype.load = originalLoad; },
  };
}

const json = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });

test("client: the v2 table yields surfaces and a family strip comes from /liquid/family/<slug>", async () => {
  const mock = mockStrips((url) => url.includes("/dbc/liquid-types")
    ? json({ version: 2, classes: CLASSES, rows: ROWS })
    : json({ frames: url.includes("fast_a") ? 16 : 30 }));
  try {
    const client = new LiquidTextureClient("ws://water.test/world");
    assert.equal(client.surfaces, undefined);
    await settle();
    assert.equal(mock.fetched[0], "http://water.test/dbc/liquid-types?v=2");
    assert.equal(client.surfaces?.get(9), "water|fast_a");
    assert.equal(client.get("water|fast_a"), undefined);
    await settle();
    assert.equal(mock.fetched[1], "http://water.test/liquid/family/fast_a");
    assert.equal(mock.loaded[0], "http://water.test/liquid/family/fast_a.png");
    assert.equal(client.get("water|fast_a")?.frames, 16);
    // The class strip is a separate request and a separate texture.
    client.get("water");
    await settle();
    assert.equal(mock.fetched[2], "http://water.test/liquid/water");
    client.dispose();
  } finally {
    mock.restore();
  }
});

test("client: an older gateway (v1 body, no family route) keeps today's class strips", async () => {
  const mock = mockStrips((url) => {
    if (url.includes("/dbc/liquid-types")) return json(CLASSES);
    if (url.includes("/liquid/family/")) return json(undefined, 404);
    return json({ frames: 30 });
  });
  try {
    const client = new LiquidTextureClient("ws://water.test/world", () => 1_000);
    void client.classes;
    await settle();
    assert.equal(client.classes?.get(181), "magma");
    assert.equal(client.surfaces, undefined);
    // A family surface asked anyway falls back to its class strip on the 404, with no retry ladder.
    assert.equal(client.get("magma|lavaorange"), undefined);
    await settle();
    assert.equal(client.get("magma|lavaorange"), undefined, "the class strip is being fetched");
    await settle();
    const strip = client.get("magma|lavaorange");
    assert.equal(strip?.frames, 30);
    assert.equal(strip === client.get("magma"), true, "the class strip itself, not a copy");
    assert.deepEqual(mock.fetched.filter((url) => url.includes("/liquid/")), [
      "http://water.test/liquid/family/lavaorange",
      "http://water.test/liquid/magma",
    ]);
    client.dispose();
  } finally {
    mock.restore();
  }
});

test("material: a family surface shares its class program and walks its own frame count", () => {
  const strip = { texture: new THREE.Texture(), frames: 16 };
  const fast = buildLiquidMaterial("water|fast_a", strip);
  const lake = buildLiquidMaterial("water", { texture: new THREE.Texture(), frames: 30 });
  assert.equal(fast.material.customProgramCacheKey(), lake.material.customProgramCacheKey());
  const green = buildLiquidMaterial("magma|lavagreen", strip);
  assert.equal(green.material.customProgramCacheKey(), "liquid-magma");
  assert.equal(green.material.transparent, false, "lava stays opaque");
  // 30 frames a second; frame 17 of a 16-frame strip is frame 1 again.
  updateLiquidMaterial(fast, "water|fast_a", undefined, 17 / 30);
  assert.equal(fast.uniforms.liquidFrame.value, 1);
  updateLiquidMaterial(lake, "water", undefined, 17 / 30);
  assert.equal(lake.uniforms.liquidFrame.value, 17);
  // Water colours reach the family surface (class shading), never the lava ones.
  const sample = {
    oceanShallowAlpha: 0.3, oceanDeepAlpha: 0.9, waterShallowAlpha: 0.7, waterDeepAlpha: 0.95,
    colours: {
      oceanClose: { r: 0, g: 0, b: 1 }, oceanFar: { r: 0, g: 0, b: 0.5 },
      riverClose: { r: 0.2, g: 0.4, b: 0.6 }, riverFar: { r: 0.1, g: 0.2, b: 0.3 },
    },
  };
  updateLiquidMaterial(fast, "water|fast_a", sample, 0);
  assert.equal(fast.uniforms.liquidShallowAlpha.value, 0.7);
  updateLiquidMaterial(green, "magma|lavagreen", sample, 0);
  assert.equal(green.uniforms.liquidShallowAlpha.value, 1);
  for (const liquid of [fast, lake, green]) liquid.material.dispose();
});

/** A WDBC file; a number is an int and `{ s }` a string. */
function dbc(fields, rows) {
  const strings = [0];
  const offsets = new Map();
  const stringOffset = (text) => {
    if (!offsets.has(text)) {
      offsets.set(text, strings.length);
      strings.push(...new TextEncoder().encode(text), 0);
    }
    return offsets.get(text);
  };
  const body = 20 + rows.length * fields * 4;
  const result = new Uint8Array(body + 4096);
  const view = new DataView(result.buffer);
  rows.forEach((row, index) => {
    for (let field = 0; field < fields; field++) {
      const value = row[field] ?? 0;
      view.setInt32(20 + (index * fields + field) * 4, typeof value === "object" ? stringOffset(value.s) : value, true);
    }
  });
  result.set(new TextEncoder().encode("WDBC"));
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.length, true);
  result.set(strings, body);
  return result.subarray(0, body + strings.length);
}

async function liquidTypes(t) {
  const directory = await mkdtemp(join(tmpdir(), "webclient-liquid-families-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const row = (id, bank, texture) => {
    const cells = new Array(45).fill(0);
    cells[0] = id;
    cells[1] = { s: `row ${id}` };
    cells[3] = bank;
    cells[15] = { s: texture };
    return cells;
  };
  await writeFile(join(directory, "LiquidType.dbc"), dbc(45, [
    row(1, 0, "XTextures\\river\\lake_a.%d.blp"),
    row(9, 0, "XTextures\\river\\fast_a.%d.blp"),
    row(3, 2, "XTextures\\lava\\lava.%d.blp"),
    row(15, 2, "XTextures\\LavaGreen\\lavagreen.%d.blp"),
    row(181, 0, "XTEXTURES\\LavaOrange\\LavaOrange.%d.blp"),
    row(190, 0, "XTEXTURES\\LavaOrange\\LavaOrange.%d.blp"),
    row(100, 1, "XTextures\\procWater\\basicReflectionMap.blp"),
  ]));
  return directory;
}

test("generator: a family resolves to the lowest row naming it, case-blind; others are SourceMissing", async (t) => {
  const directory = await liquidTypes(t);
  assert.equal(liquidFamilyOf("XTEXTURES\\LavaOrange\\LavaOrange.%d.blp"), "lavaorange");
  assert.equal(await liquidFamilyPattern(directory, "lavaorange"), "XTEXTURES\\LavaOrange\\LavaOrange.%d.blp");
  assert.equal(await liquidFamilyPattern(directory, "fast_a"), "XTextures\\river\\fast_a.%d.blp");
  assert.equal(await liquidFamilyPattern(directory, "lavagreen"), "XTextures\\LavaGreen\\lavagreen.%d.blp");
  // Row 100 names a single texture, not an animated family.
  await assert.rejects(liquidFamilyPattern(directory, "basicreflectionmap"), SourceMissing);
  await assert.rejects(liquidFamilyPattern(directory, "nothing"), SourceMissing);
  await assert.rejects(liquidFamilyPattern(directory, "../water"), SourceMissing);
  // The class strips still come from the lowest row of their bank (unchanged).
  assert.equal(await liquidTexturePattern(directory, "water"), "XTextures\\river\\lake_a.%d.blp");
  assert.equal(await liquidTexturePattern(directory, "magma"), "XTextures\\lava\\lava.%d.blp");
});

test("generator: a sixteen-frame family yields sixteen frames and the first absence", async () => {
  const pattern = "XTextures\\river\\fast_a.%d.blp";
  const archives = { has: async (path) => Number(/\.(\d+)\.blp$/.exec(path)[1]) <= 16 };
  const { paths, stampPaths } = await liquidFrameInputs(archives, pattern);
  assert.equal(paths.length, 16);
  assert.equal(paths[15], "XTextures\\river\\fast_a.16.blp");
  assert.equal(stampPaths.length, 17);
  assert.equal(stampPaths[16], "XTextures\\river\\fast_a.17.blp");
});

test("route: /liquid/family/<slug> publishes on a miss, refuses foreign origins, 404s a missing family", async (t) => {
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const directory = await mkdtemp(join(tmpdir(), "webclient-liquid-family-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const asked = [];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    liquidDirectory: directory,
    generateLiquidTexture: async () => { throw new Error("the class route must not be asked"); },
    generateLiquidFamily: async (family) => {
      asked.push(family);
      if (family !== "lavagreen") throw Object.assign(new Error("absent"), { exitCode: 3 });
      await mkdir(join(directory, "family"), { recursive: true });
      await writeFile(join(directory, "family", "lavagreen.json"), JSON.stringify({ frames: 30 }));
      await writeFile(join(directory, "family", "lavagreen.png"), Buffer.from("PNG-green"));
    },
  });
  const headers = { origin: "http://localhost:5173" };
  const base = `http://127.0.0.1:${gateway.port}/liquid/family`;
  try {
    const metadata = await fetch(`${base}/lavagreen`, { headers });
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { frames: 30 });
    const image = await fetch(`${base}/lavagreen.png`, { headers });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString(), "PNG-green");
    assert.equal((await fetch(`${base}/lavagreen`, { headers: { origin: "http://evil.test" } })).status, 403);
    const missing = await fetch(`${base}/nothing`, { headers });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
    const bad = await fetch(`${base}/Lava-Green`, { headers });
    assert.notEqual(bad.status, 200);
    await bad.arrayBuffer();
    assert.deepEqual(asked, ["lavagreen", "nothing"]);
    assert.equal(await readFile(join(directory, "family", "lavagreen.json"), "utf8"), "{\"frames\":30}");
  } finally {
    await gateway.close();
  }
});

test("renderer hook: terrain and WMO liquids are grouped and drawn by surface", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /liquidSurfaceOf\(liquidClass, liquid\.entry, this\.#liquidTextures\?\.surfaces\)/);
  assert.match(source, /liquidSurfaceOf\(liquidClass, liquid\.type, this\.#liquidTextures\?\.surfaces\)/);
  assert.match(source, /#liquidMaterials = new Map<LiquidSurface, LiquidMaterial>/);
});
