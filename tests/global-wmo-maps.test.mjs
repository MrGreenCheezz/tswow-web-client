import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { environmentObjectInGrid, parseVMapGlobalSpawn } from "../dist/code/gateway/VMapProtocol.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { globalMapObjects, placementReachesCell } from "../tools/adt-placements.mjs";

// Thirty-nine maps of this client are one WMO named in the WDT, with no ADT: Wailing Caverns (43),
// Blackrock Depths (230), Molten Core (409), the Nexus (576), the Hellfire, Coilfang and Tempest
// Keep wings. The vmap extractor writes them no `.vmtile`, only a `.vmtree` holding the one spawn,
// and the visual-tile generator read only ADTs, so every cell of such a map failed: the dungeon
// drew nothing and had nothing to stand on (measured 2026-09-28: `/environment/43|576/…` 404,
// `/visual/environment/…` 500).

const encoder = new TextEncoder();
const WORLD_MID = 0.5 * 64 * 533.33333333;
const ORIGIN = "http://127.0.0.1:5173";

/** A `.vmtree` in TrinityCore's `VMAP_4.8` layout, with the global spawn when `tiled` is false. */
function vmtree({ tiled, name = "Nexus_70.wmo", low = [-100, -200, -50], high = [300, 400, 60] }) {
  const writer = new PacketWriter().bytes(encoder.encode("VMAP_4.8")).u8(tiled ? 1 : 0).bytes(encoder.encode("NODE"));
  for (let index = 0; index < 6; index++) writer.f32(0);
  writer.u32(2).u32(7).u32(9).u32(1).u32(0).bytes(encoder.encode("GOBJ"));
  if (tiled) return writer.toUint8Array();
  const bytes = encoder.encode(name);
  // Stored in the extractor's internal space: position at the middle of the map, the box around it.
  return writer
    .u32(1 << 2).u16(65).u32(4_294_967_295)
    .f32(WORLD_MID).f32(WORLD_MID).f32(0)
    .f32(0).f32(0).f32(0).f32(1)
    .f32(WORLD_MID - high[0]).f32(WORLD_MID - high[1]).f32(low[2])
    .f32(WORLD_MID - low[0]).f32(WORLD_MID - low[1]).f32(high[2])
    .u32(bytes.byteLength).bytes(bytes)
    .toUint8Array();
}

/** A WDT whose MPHD says "global map object", with one MODF at raw (0, y, 0) as the client ships them. */
function wdt({ global = true, height = 12 } = {}) {
  const chunk = (tag, payload) => {
    const header = Buffer.alloc(8);
    Buffer.from([...tag].reverse().join(""), "latin1").copy(header, 0);
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  const mphd = Buffer.alloc(32);
  mphd.writeUInt32LE(global ? 0x1 : 0x0, 0);
  const name = Buffer.from("World\\wmo\\Dungeon\\Test\\Test_Instance.wmo\0", "latin1");
  const modf = Buffer.alloc(64);
  modf.writeUInt32LE(0, 0);
  modf.writeUInt32LE(4_294_967_295, 4);
  modf.writeFloatLE(0, 8);
  modf.writeFloatLE(height, 12);
  modf.writeFloatLE(0, 16);
  // Box in raw MODF space (x, y=up, z): low (-100, -50, -200), high (300, 60, 400).
  for (const [index, value] of [-100, -50, -200, 300, 60, 400].entries()) modf.writeFloatLE(value, 32 + index * 4);
  return Buffer.concat([
    chunk("MVER", Buffer.from([18, 0, 0, 0])),
    chunk("MPHD", mphd),
    chunk("MAIN", Buffer.alloc(64 * 64 * 8)),
    chunk("MWMO", name),
    chunk("MODF", modf),
  ]);
}

test("the one spawn of a non-tiled map is read out of its tree, and a tiled tree has none", () => {
  assert.equal(parseVMapGlobalSpawn(vmtree({ tiled: true })), undefined);
  const spawn = parseVMapGlobalSpawn(vmtree({ tiled: false }));
  assert.ok(spawn);
  assert.equal(spawn.kind, "wmo");
  assert.equal(spawn.name, "Nexus_70.wmo");
  // The file holds float32s, so the middle of the map comes back within a thousandth of a yard.
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.01, `${label}: ${actual} vs ${expected}`);
  near(spawn.x, 0, "x, the middle of the map");
  near(spawn.y, 0, "y");
  near(spawn.z, 0, "z");
  for (const [key, value] of Object.entries({ minX: -100, minY: -200, minZ: -50, maxX: 300, maxY: 400, maxZ: 60 })) {
    near(spawn.bounds[key], value, `bounds.${key}`);
  }
  // Cells 31 and 32 meet at the origin, so a box around it reaches four of them and nothing far away.
  assert.equal(environmentObjectInGrid(spawn, 31, 31), true);
  assert.equal(environmentObjectInGrid(spawn, 32, 32), true);
  assert.equal(environmentObjectInGrid(spawn, 0, 0), false);
  assert.equal(environmentObjectInGrid(spawn, 30, 32), false, "300 yd east does not reach the next cell over");
});

test("a WDT's global object lands where the server's collision puts it", () => {
  const [placement, ...rest] = globalMapObjects(wdt());
  assert.equal(rest.length, 0);
  assert.equal(placement.kind, "wmo");
  assert.equal(placement.name, "World\\wmo\\Dungeon\\Test\\Test_Instance.wmo");
  assert.deepEqual([placement.x, placement.y, placement.z], [0, 0, 12],
    "raw x = z = 0 is the middle of the map, as the vmap extractor reads it");
  assert.deepEqual(placement.bounds, { minX: -400, maxX: 200, minY: -300, maxY: 100, minZ: -50, maxZ: 60 });
  assert.equal(placementReachesCell(placement, 32, 32), true);
  assert.equal(placementReachesCell(placement, 31, 31), true);
  assert.equal(placementReachesCell(placement, 5, 60), false);
  assert.equal(globalMapObjects(wdt({ global: false })), undefined, "an ordinary WDT has no global object");
});

test("the environment route answers a non-tiled map's cells from its tree: the spawn where it reaches, empty elsewhere", async () => {
  const vmapsDirectory = await mkdtemp(join(tmpdir(), "webclient-global-vmaps-"));
  await writeFile(join(vmapsDirectory, "576.vmtree"), vmtree({ tiled: false }));
  await writeFile(join(vmapsDirectory, "604.vmtree"), vmtree({ tiled: true }));
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], vmapsDirectory, datasetPollMs: 0,
  });
  const ask = async (path) => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers: { origin: ORIGIN } });
    return { status: response.status, body: response.ok ? await response.json() : await response.text() };
  };
  try {
    const inside = await ask("/environment/576/32/31");
    assert.equal(inside.status, 200);
    assert.equal(inside.body.length, 1);
    assert.equal(inside.body[0].name, "Nexus_70.wmo");
    const outside = await ask("/environment/576/3/3");
    assert.deepEqual(outside, { status: 200, body: [] }, "an empty cell of the dungeon's map, not a missing one");
    assert.equal((await ask("/environment/604/3/3")).status, 404, "a tiled map's absent tile is still absent");
    assert.equal((await ask("/environment/999/3/3")).status, 404, "and so is a map with no tree at all");
  } finally {
    await gateway.close();
    await rm(vmapsDirectory, { recursive: true, force: true });
  }
});

test("on this machine's client and dataset, every global WDT object matches its vmap spawn", { skip: !existsSync("F:/Circle/Data") }, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory, dbcDirectory, vmapsDirectory } = await import("../tools/paths.mjs");
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const maps = await openDbcFile(dbcDirectory(), "Map");
  const chain = await clientArchives(clientDirectory());
  try {
    let compared = 0;
    for (const mapId of [43, 230, 409, 576]) {
      const tree = join(vmapsDirectory(), `${String(mapId).padStart(3, "0")}.vmtree`);
      if (!existsSync(tree)) continue;
      const spawn = parseVMapGlobalSpawn(await readFile(tree));
      const directory = maps.string(maps.rowOf(mapId), "Directory");
      const [placement] = globalMapObjects(await chain.read(`World\\Maps\\${directory}\\${directory}.wdt`)) ?? [];
      assert.ok(spawn && placement, `map ${mapId} has both`);
      for (const key of ["x", "y", "z", "rotationX", "rotationY", "rotationZ"]) {
        assert.ok(Math.abs(spawn[key] - placement[key]) < 1e-3, `map ${mapId} ${key}: ${spawn[key]} vs ${placement[key]}`);
      }
      for (const key of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"]) {
        assert.ok(Math.abs(spawn.bounds[key] - placement.bounds[key]) < 0.5, `map ${mapId} bounds.${key}`);
      }
      compared++;
    }
    assert.ok(compared > 0, "the dataset has global maps to compare");
  } finally {
    chain.close();
  }
});
