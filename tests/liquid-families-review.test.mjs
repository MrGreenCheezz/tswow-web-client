// 05.10: review of A7b-8 (7.09 slice A). The running gateway is older than R1: its
// `/dbc/liquid-types` route matches the bare path and ignores the query, so `?v=2` gets the v1
// record of classes. These tests take that body from the route itself (the bare branch is the
// HEAD code, unchanged) and prove the client then draws every row with its class strip only —
// the look before the slice — while the v2 body of the same route gives the three family surfaces.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";

import { LiquidTextureClient, liquidClassOf, liquidSurfaceOf } from "../dist/code/browser/Water.js";

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

/** The rows of this client that decide surfaces (`.runtime/re-2026-10-05/A7b-8-review/rows.out.txt`). */
async function tables(t) {
  const directory = await mkdtemp(join(tmpdir(), "webclient-liquid-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const row = (id, bank, material, texture) => {
    const cells = new Array(45).fill(0);
    cells[0] = id;
    cells[1] = { s: `row ${id}` };
    cells[3] = bank;
    cells[14] = material;
    cells[15] = { s: texture };
    return cells;
  };
  await writeFile(join(directory, "LiquidType.dbc"), dbc(45, [
    row(1, 0, 1, "XTextures\\river\\lake_a.%d.blp"),
    row(2, 1, 1, "XTextures\\ocean\\ocean_h.%d.blp"),
    row(3, 2, 2, "XTextures\\lava\\lava.%d.blp"),
    row(4, 3, 2, "XTextures\\slime\\slime.%d.blp"),
    row(9, 0, 1, "XTextures\\river\\fast_a.%d.blp"),
    row(13, 0, 1, "XTextures\\river\\lake_a.%d.blp"),
    row(15, 2, 2, "XTextures\\LavaGreen\\lavagreen.%d.blp"),
    row(19, 2, 2, "XTextures\\lava\\lava.%d.blp"),
    row(100, 1, 3, "XTextures\\procWater\\basicReflectionMap.blp"),
    row(181, 0, 1, "XTEXTURES\\LavaOrange\\LavaOrange.%d.blp"),
  ]));
  await writeFile(join(directory, "LiquidMaterial.dbc"), dbc(3, [[1, 0, 1], [2, 1, 0], [3, 0, 1]]));
  return directory;
}

async function routeBodies(t) {
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    dbcDirectory: await tables(t),
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  try {
    const base = `http://127.0.0.1:${gateway.port}/dbc/liquid-types`;
    return {
      v1: await (await fetch(base, { headers })).json(),
      v2: await (await fetch(`${base}?v=2`, { headers })).json(),
    };
  } finally {
    await gateway.close();
  }
}

const settle = async (turns = 8) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/** Runs a client against one fixed table body; answers which strip URLs the rows asked for. */
async function stripsAsked(tableBody) {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).includes("/dbc/liquid-types")) return { ok: true, status: 200, json: async () => tableBody };
    if (String(url).includes("/liquid/family/")) return { ok: false, status: 404, json: async () => undefined };
    return { ok: true, status: 200, json: async () => ({ frames: 30 }) };
  };
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const texture = new THREE.Texture();
    setImmediate(() => onLoad(texture));
    return texture;
  };
  try {
    const client = new LiquidTextureClient("ws://water.test/world", () => 1_000);
    void client.classes;
    await settle();
    const ids = [1, 2, 3, 4, 9, 13, 15, 19, 100, 181];
    const surfaces = {};
    for (const id of ids) {
      // The renderer's own two steps (`#waterGeometry`): the class, then the surface by the row.
      const liquidClass = liquidClassOf(0, id, client.classes);
      surfaces[id] = liquidSurfaceOf(liquidClass, id, client.surfaces);
      client.get(surfaces[id]);
    }
    await settle();
    const hadSurfaces = client.surfaces !== undefined;
    client.dispose();
    return { surfaces, hadSurfaces, strips: [...new Set(fetched.filter((url) => url.includes("/liquid/")))].sort() };
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
  }
}

test("old gateway: the v1 record `?v=2` gets from it draws every row with its class strip only", async (t) => {
  const { v1, v2 } = await routeBodies(t);
  assert.equal(v1.version, undefined, "the bare branch is the HEAD record, not the v2 body");
  assert.equal(v1.rows, undefined);
  assert.deepEqual(v2.classes, v1, "v2 carries the v1 record unchanged");
  const old = await stripsAsked(v1);
  assert.equal(old.hadSurfaces, false);
  assert.deepEqual(old.surfaces, {
    1: "water", 2: "ocean", 3: "magma", 4: "slime", 9: "water", 13: "water",
    15: "magma", 19: "magma", 100: "ocean", 181: "magma",
  });
  assert.deepEqual(old.strips, [
    "http://water.test/liquid/magma", "http://water.test/liquid/ocean",
    "http://water.test/liquid/slime", "http://water.test/liquid/water",
  ], "no family route is ever asked of an older gateway");
});

test("new gateway: the v2 body of the same route names the three family surfaces, the rest stay classes", async (t) => {
  const { v2 } = await routeBodies(t);
  const fresh = await stripsAsked(v2);
  assert.equal(fresh.hadSurfaces, true);
  assert.deepEqual(fresh.surfaces, {
    1: "water", 2: "ocean", 3: "magma", 4: "slime", 9: "water|fast_a", 13: "water",
    15: "magma|lavagreen", 19: "magma", 100: "ocean", 181: "magma|lavaorange",
  });
  // A 404 on a family is final at once and its class strip stands in: one request each.
  assert.deepEqual(fresh.strips, [
    "http://water.test/liquid/family/fast_a", "http://water.test/liquid/family/lavagreen",
    "http://water.test/liquid/family/lavaorange",
    "http://water.test/liquid/magma", "http://water.test/liquid/ocean",
    "http://water.test/liquid/slime", "http://water.test/liquid/water",
  ]);
  // 7.09 open point (recorded, not changed): 181 is authored as the water material (MaterialID 1,
  // LVF 0 height+depth — the same LVF its 49 MH2O chunks use), unlike the magma rows (LVF 1).
  assert.equal(v2.rows[181].materialId, 1);
  assert.equal(v2.rows[181].vertexFormat, 0);
  assert.equal(v2.rows[15].vertexFormat, 1);
});
