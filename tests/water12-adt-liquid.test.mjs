import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAdtLiquid } from "../tools/adt-liquid.mjs";
import {
  AUTHORED_LIQUID_UV_SCALE, AuthoredLiquidClient, parseAuthoredLiquidTile, pushAuthoredLiquidCellUvs,
} from "../dist/code/browser/WaterAuthored.js";
import { liquidMotionOfRow, pushTerrainLiquidCellUvs, pushLiquidCellUvs, pushWmoLiquidVertexUv } from "../dist/code/browser/Water.js";
import { adtLiquidRequest, adtLiquidFile } from "../dist/code/gateway/AdtLiquidRoute.js";

// 15.11 water12 (7.09 slice B, 7.31): the authored liquid layers of a client ADT — the reader
// (`tools/adt-liquid.mjs`, Wow.exe 0x007c5690 / 0x008a31b0 / 0x008a3250), the route, and the browser's
// use of a format-1 layer's (s, t) for magma and slime (Wow.exe 0x007ce390).

function chunk(tag, body) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** An MH2O body: chunk 17 a 2 x 1 magma layer at (x 3, y 5) with (s, t), chunk 0 an ocean of depth only. */
function mh2o() {
  const headers = Buffer.alloc(256 * 12);
  const parts = [];
  let offset = headers.length;
  const add = (buffer) => {
    const at = offset;
    parts.push(buffer);
    offset += buffer.length;
    return at;
  };
  // Chunk 17: type 7 "Slow Magma", format 1, x 3 y 5 w 2 h 1; mask: cell (0,0) set, (1,0) clear.
  const instance = Buffer.alloc(24);
  const instanceAt = add(instance);
  const mask = Buffer.from([0b01]);
  const maskAt = add(mask);
  const vertices = Buffer.alloc(6 * 4 + 6 * 4);
  for (let i = 0; i < 6; i++) {
    vertices.writeFloatLE(-10 + i, i * 4);
    vertices.writeUInt16LE(100 + i * 10, 24 + i * 4);
    vertices.writeUInt16LE(200 + i, 24 + i * 4 + 2);
  }
  const vertexAt = add(vertices);
  instance.writeUInt16LE(7, 0);
  instance.writeUInt16LE(1, 2);
  instance.writeFloatLE(-10, 4);
  instance.writeFloatLE(-5, 8);
  instance.writeUInt8(3, 12);
  instance.writeUInt8(5, 13);
  instance.writeUInt8(2, 14);
  instance.writeUInt8(1, 15);
  instance.writeUInt32LE(maskAt, 16);
  instance.writeUInt32LE(vertexAt, 20);
  const attributes = Buffer.alloc(16);
  attributes.writeUInt32LE(0xff, 0);
  attributes.writeUInt32LE(0x1, 12);
  const attributesAt = add(attributes);
  headers.writeUInt32LE(instanceAt, 17 * 12);
  headers.writeUInt32LE(1, 17 * 12 + 4);
  headers.writeUInt32LE(attributesAt, 17 * 12 + 8);
  // Chunk 0: type 2 "Ocean", format 2, the whole chunk, no vertex block (depth reads 255).
  const ocean = Buffer.alloc(24);
  ocean.writeUInt16LE(2, 0);
  ocean.writeUInt16LE(2, 2);
  ocean.writeUInt8(8, 14);
  ocean.writeUInt8(8, 15);
  const oceanAt = add(ocean);
  headers.writeUInt32LE(oceanAt, 0);
  headers.writeUInt32LE(1, 4);
  return Buffer.concat([headers, ...parts]);
}

/** One MCNK at index (x 2, y 1) with an MCLQ: a water layer (0x04) then a magma layer (0x10). */
function mcnk() {
  const header = Buffer.alloc(0x80);
  header.writeUInt32LE(0x04 | 0x10, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(1, 8);
  const layer = (kind) => {
    const bytes = Buffer.alloc(0xc9 * 4);
    bytes.writeFloatLE(1, 0);
    bytes.writeFloatLE(2, 4);
    for (let v = 0; v < 81; v++) {
      const at = 8 + v * 8;
      if (kind === "water") bytes.writeUInt8(v, at);
      else {
        bytes.writeUInt16LE(1000 + v, at);
        bytes.writeUInt16LE(2000 + v, at + 2);
      }
      bytes.writeFloatLE(v / 10, at + 4);
    }
    for (let cell = 0; cell < 64; cell++) bytes.writeUInt8(cell === 9 ? 0x0f : 0x40 | (kind === "water" ? 0 : 2), 8 + 81 * 8 + cell);
    return bytes;
  };
  // This client's MCLQ size word does not cover its layers: 0, as found on Shadowmoon Valley's tiles.
  const mclq = Buffer.concat([chunk("QLCM", Buffer.alloc(0)), layer("water"), layer("magma")]);
  return chunk("KNCM", Buffer.concat([header, chunk("TVCM", Buffer.alloc(145 * 4)), mclq]));
}

const ADT = Buffer.concat([chunk("REVM", Buffer.from([18, 0, 0, 0])), chunk("O2HM", mh2o()), mcnk()]);

test("reader: MH2O layers carry their format, their cells, heights, (s, t) and depth as Wow.exe reads them", () => {
  const parsed = readAdtLiquid(ADT, 0);
  const magma = parsed.layers.find((layer) => layer.chunk === 17);
  assert.deepEqual([magma.source, magma.type, magma.format, magma.x, magma.y, magma.w, magma.h], ["mh2o", 7, 1, 3, 5, 2, 1]);
  assert.deepEqual(magma.exists, [1, 0], "the mask, low bit first");
  assert.deepEqual(magma.heights, [-10, -9, -8, -7, -6, -5]);
  assert.deepEqual(magma.uv.slice(0, 4), [100, 200, 110, 201], "(s, t) after the heights (0x008a31b0)");
  assert.equal(magma.depths, undefined);
  const ocean = parsed.layers.find((layer) => layer.chunk === 0);
  assert.equal(ocean.format, 2);
  assert.equal(ocean.depths.length, 81);
  assert.ok(ocean.depths.every((depth) => depth === 255), "an absent depth block reads 255 (0x008a3160)");
  assert.equal(ocean.heights, undefined);
  assert.deepEqual(parsed.attributes[17], { fishable: "00000000000000ff", deep: "0000000100000000" });
});

test("reader: MCLQ layers by flag; map 530's magma is Green Lava (0x007c5690)", () => {
  const azeroth = readAdtLiquid(ADT, 0).layers.filter((layer) => layer.source === "mclq");
  assert.deepEqual(azeroth.map((layer) => [layer.chunk, layer.type, layer.format]), [[18, 1, 0], [18, 3, 1]],
    "chunk index y * 16 + x; water then magma, in flag order");
  const [water, magma] = azeroth;
  assert.equal(water.depths[5], 5, "a water vertex's first byte");
  assert.equal(water.uv, undefined);
  assert.equal(magma.uv[2 * 7], 1007);
  assert.equal(magma.uv[2 * 7 + 1], 2007, "a magma vertex's u16 s, t");
  assert.equal(magma.heights[80], 8);
  assert.equal(magma.exists[9], 0, "a 0x0f cell is no liquid");
  assert.equal(magma.cells[0], 0x42);
  const outland = readAdtLiquid(ADT, 530).layers.filter((layer) => layer.source === "mclq");
  assert.deepEqual(outland.map((layer) => layer.type), [1, 15]);
});

test("browser: magma and slime take the layer's own (s, t); water and uncovered cells the position rule", () => {
  const tile = parseAuthoredLiquidTile(JSON.parse(JSON.stringify({ version: 1, ...readAdtLiquid(ADT, 0) })));
  // Chunk 17 = row block 1, column block 1; its layer covers row 8 + 5, columns 8 + 3 (set) and 8 + 4 (not).
  const out = [];
  assert.equal(pushAuthoredLiquidCellUvs(out, tile, 13, 11), true);
  const s = (i) => (100 + i * 10) * AUTHORED_LIQUID_UV_SCALE, t = (i) => (200 + i) * AUTHORED_LIQUID_UV_SCALE;
  // Corners (r, c), (r + 1, c), (r, c + 1), (r + 1, c + 1) of a w 2 grid: vertices 0, 3, 1, 4.
  assert.deepEqual(out, [s(0), t(0), s(3), t(3), s(1), t(1), s(4), t(4)]);
  assert.equal(pushAuthoredLiquidCellUvs([], tile, 13, 12), false, "a cell the mask leaves out");
  const authored = [];
  pushTerrainLiquidCellUvs(authored, 10, 6, 20, 16, 1, "magma", tile, 13, 11);
  assert.deepEqual(authored, out);
  const position = [];
  pushLiquidCellUvs(position, 10, 6, 20, 16, 1);
  for (const [liquidClass, row, column, answer] of [["water", 13, 11, tile], ["magma", 13, 12, tile], ["magma", 13, 11, null], ["magma", 13, 11, undefined]]) {
    const placed = [];
    pushTerrainLiquidCellUvs(placed, 10, 6, 20, 16, 1, liquidClass, answer, row, column);
    assert.deepEqual(placed, position, `${liquidClass} ${row},${column} ${String(answer && "tile")}`);
  }
  // The MCLQ magma of chunk 18 (row block 1, column block 2), cell (0, 0): vertices 0, 9, 1, 10.
  const old = [];
  assert.equal(pushAuthoredLiquidCellUvs(old, tile, 8, 16), true);
  assert.equal(old[2], 1009 * AUTHORED_LIQUID_UV_SCALE, "the second corner is the next row's vertex");
  assert.equal(parseAuthoredLiquidTile({ version: 2, layers: [] }), undefined, "another version is not read");
});

test("browser: a tile is asked once; its revision turns 1 when answered, a 404 is none for good", async () => {
  const asked = [];
  const body = { version: 1, ...readAdtLiquid(ADT, 0) };
  const client = new AuthoredLiquidClient("http://gw", async (url) => {
    asked.push(String(url));
    if (String(url).includes("/1/2/3")) return new Response("", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  assert.equal(client.tile(0, 46, 33), undefined);
  assert.equal(client.revision(0, 46, 33), 0);
  assert.equal(client.tile(0, 46, 33), undefined, "no second request while one is out");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.revision(0, 46, 33), 1);
  assert.ok(client.tile(0, 46, 33).uvLayers.get(17));
  client.tile(1, 2, 3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.tile(1, 2, 3), null);
  assert.equal(client.revision(1, 2, 3), 1);
  assert.deepEqual(asked, ["http://gw/liquid/adt/0/46/33?v=1", "http://gw/liquid/adt/1/2/3?v=1"]);
});

test("WMO: a building liquid's vertex UV is its column and row from the grid's corner, u along X (0x007a7b00)", () => {
  const out = [];
  pushWmoLiquidVertexUv(out, 3, 0);
  pushWmoLiquidVertexUv(out, 0, 2);
  assert.ok(Math.abs(out[0] - 3) < 1e-5 && out[1] === 0, "u follows the model's X");
  assert.ok(out[2] === 0 && Math.abs(out[3] - 2) < 1e-5);
  // Row 14 "WMO Ocean" (material 1, Float 0.25 and 180): the water material's matrix on top (0x008a5590).
  const ocean = liquidMotionOfRow(1, [0.25, 180]);
  assert.equal(ocean.rotation, 180);
  const turned = [];
  pushWmoLiquidVertexUv(turned, 3, 1, ocean);
  assert.ok(Math.abs(turned[0] + 0.75) < 1e-5 && Math.abs(turned[1] + 0.25) < 1e-5, `${turned}`);
  // Row 19 "WMO Magma" (material 2, Float 0 and 0.1): no matrix, a scroll along v once per 10 s.
  const magma = liquidMotionOfRow(2, [0, 0.1]);
  assert.deepEqual([magma.scrollU, magma.scrollV], [0, 0.1]);
  const still = [];
  pushWmoLiquidVertexUv(still, 3, 1, magma);
  assert.ok(Math.abs(still[0] - 3) < 1e-5 && Math.abs(still[1] - 1) < 1e-5);
  // A terrain water row keeps no turn (only row 14 has one).
  assert.equal(liquidMotionOfRow(1, [1, 0]).rotation, undefined);
});

test("route: /liquid/adt/<map>/<gridX>/<gridY>?v=1 names a tile; anything else on the path is a 400", () => {
  assert.deepEqual(adtLiquidRequest("/liquid/adt/0/46/33", "1"), { map: 0, gridX: 46, gridY: 33 });
  assert.equal(adtLiquidRequest("/liquid/adt/0/46/33", "2"), null);
  assert.equal(adtLiquidRequest("/liquid/adt/0/64/33", "1"), null);
  assert.equal(adtLiquidRequest("/liquid/adt/x", "1"), null);
  assert.equal(adtLiquidRequest("/liquid/lava", "1"), undefined);
  assert.equal(adtLiquidFile("D", { map: 530, gridX: 40, gridY: 29 }), join("D", "adt", "v1", "530", "40-29.json"));
});

test("route: publishes on a miss, 404s a tile with no ADT, refuses foreign origins", async (t) => {
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const directory = await mkdtemp(join(tmpdir(), "webclient-adt-liquid-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const asked = [];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    liquidDirectory: directory,
    generateAdtLiquid: async (map, gridX, gridY) => {
      asked.push(`${map}/${gridX}/${gridY}`);
      if (map !== 0) throw Object.assign(new Error("absent"), { exitCode: 3 });
      const file = adtLiquidFile(directory, { map, gridX, gridY });
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, JSON.stringify({ version: 1, layers: [], attributes: {} }));
    },
  });
  const headers = { origin: "http://localhost:5173" };
  const base = `http://127.0.0.1:${gateway.port}/liquid/adt`;
  try {
    const hit = await fetch(`${base}/0/46/33?v=1`, { headers });
    assert.equal(hit.status, 200);
    assert.deepEqual(await hit.json(), { version: 1, layers: [], attributes: {} });
    const missing = await fetch(`${base}/13/1/1?v=1`, { headers });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
    const wrong = await fetch(`${base}/0/46/33?v=7`, { headers });
    assert.equal(wrong.status, 400);
    await wrong.arrayBuffer();
    const foreign = await fetch(`${base}/0/46/33?v=1`, { headers: { origin: "http://evil.test" } });
    assert.equal(foreign.status, 403);
    await foreign.arrayBuffer();
    assert.deepEqual(asked, ["0/46/33", "13/1/1"]);
  } finally {
    await gateway.close();
  }
});
