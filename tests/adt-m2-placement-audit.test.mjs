import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseAdtPlacements } from "../tools/adt-placements.mjs";

// R4.1 placement-audit contract. The implementation is intentionally injected with an already
// open archive so this test never opens F:\\Circle or closes a shared archive:
//
//   auditAdtM2Placements({ archives }) -> {
//     placements: [{ modelPath, tilePath, kind: "m2", exterior: true, staticModel: true }],
//     models: [{ modelPath, placementCount, tileCount, failReasons }], digest,
//   }
const auditImport = await import("../tools/audit-adt-m2-placements.mjs")
  .catch((error) => ({ __error: error }));

const MAP_PREFIX = "World\\Maps";
const TILE_A = "World/Maps/Azeroth_0_0.adt";
const TILE_B = "world\\maps\\Azeroth_1_0.adt";
const OUTSIDE_TILE = "World\\Other\\not-a-map.adt";
const MODEL_TREE = "world\\creature\\tree.m2";
const MODEL_ROCK = "world\\creature\\rock.m2";
const MODEL_BROKEN = "world\\creature\\broken.m2";
const SKIN_TREE = "world\\creature\\tree00.skin";
const SKIN_BROKEN = "world\\creature\\broken00.skin";

function auditApi() {
  if (auditImport.__error) throw auditImport.__error;
  const audit = auditImport.scanAdtM2Placements
    ?? auditImport.auditAdtM2Placements ?? auditImport.auditAdtPlacements;
  assert.equal(typeof audit, "function", "ADT M2 placement audit export is required");
  return audit;
}

// ADT chunk tags are stored reversed on disk.
function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  for (let index = 0; index < 4; index++) header[index] = tag.charCodeAt(3 - index);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function nameChunks(names) {
  const offsets = [];
  let size = 0;
  for (const name of names) {
    offsets.push(size);
    size += Buffer.byteLength(name) + 1;
  }
  const strings = Buffer.alloc(size);
  let offset = 0;
  for (const name of names) {
    offset += strings.write(name, offset, "utf8");
    offset++;
  }
  const indices = Buffer.alloc(offsets.length * 4);
  offsets.forEach((value, index) => indices.writeUInt32LE(value, index * 4));
  return { strings, indices };
}

function mddfRecord(nameId, uniqueId, x, y, z) {
  const record = Buffer.alloc(36);
  record.writeUInt32LE(nameId, 0);
  record.writeUInt32LE(uniqueId, 4);
  record.writeFloatLE(x, 8);
  record.writeFloatLE(y, 12);
  record.writeFloatLE(z, 16);
  record.writeFloatLE(0, 20);
  record.writeFloatLE(0, 24);
  record.writeFloatLE(0, 28);
  record.writeUInt16LE(1024, 32);
  return record;
}

function modfRecord(nameId, uniqueId, x, y, z) {
  const record = Buffer.alloc(64);
  record.writeUInt32LE(nameId, 0);
  record.writeUInt32LE(uniqueId, 4);
  record.writeFloatLE(x, 8);
  record.writeFloatLE(y, 12);
  record.writeFloatLE(z, 16);
  record.writeFloatLE(0, 20);
  record.writeFloatLE(0, 24);
  record.writeFloatLE(0, 28);
  for (let axis = 0; axis < 6; axis++) record.writeFloatLE(axis < 3 ? -1 : 1, 32 + axis * 4);
  record.writeUInt16LE(7, 58);
  return record;
}

function adt({ m2 = [], wmo = [] } = {}) {
  const m2Names = nameChunks([
    "World/Creature/Tree.mdx",
    "World/Creature/Rock.m2",
    "World/Creature/Broken.m2",
  ]);
  const wmoNames = nameChunks(["World/Generic/House.wmo"]);
  return Buffer.concat([
    chunk("MMDX", m2Names.strings),
    chunk("MMID", m2Names.indices),
    chunk("MDDF", Buffer.concat(m2)),
    chunk("MWMO", wmoNames.strings),
    chunk("MWID", wmoNames.indices),
    chunk("MODF", Buffer.concat(wmo)),
  ]);
}

function m2Bytes() {
  const model = Buffer.alloc(0x300);
  model.write("MD20", 0, "ascii");
  model.writeUInt32LE(3, 0x3c);
  model.writeUInt32LE(0x150, 0x40);
  model.writeUInt32LE(1, 0x50);
  model.writeUInt32LE(0x210, 0x54);
  model.writeUInt32LE(1, 0x70);
  model.writeUInt32LE(0x220, 0x74);
  const zeroTables = [0x14, 0x1c, 0x2c, 0x48, 0x58, 0x60, 0x80, 0x88, 0x90, 0x98,
    0xf0, 0x100, 0x110, 0x120, 0x128];
  for (const offset of zeroTables) {
    model.writeUInt32LE(0, offset);
    model.writeUInt32LE(0, offset + 4);
  }
  const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  for (let index = 0; index < vertices.length; index++) {
    const at = 0x150 + index * 48;
    for (let axis = 0; axis < 3; axis++) model.writeFloatLE(vertices[index][axis], at + axis * 4);
    model.writeFloatLE(0, at + 20);
    model.writeFloatLE(0, at + 24);
    model.writeFloatLE(1, at + 28);
    model.writeFloatLE(vertices[index][0], at + 32);
    model.writeFloatLE(vertices[index][1], at + 36);
    model.writeFloatLE(vertices[index][0], at + 40);
    model.writeFloatLE(vertices[index][1], at + 44);
  }
  model.writeUInt32LE(0, 0x210);
  model.writeUInt32LE(0, 0x214);
  model.writeUInt32LE(0, 0x218);
  model.writeUInt32LE(0, 0x21c);
  model.writeUInt32LE(0, 0x220);
  model.writeUInt32LE(0, 0x224);
  for (const [offset, value] of [[0xa0, 0], [0xa4, 0], [0xa8, 0], [0xac, 1], [0xb0, 1],
    [0xb4, 0], [0xb8, 2]]) model.writeFloatLE(value, offset);
  return model;
}

function skinBytes() {
  const skin = Buffer.alloc(160);
  skin.write("SKIN", 0, "ascii");
  skin.writeUInt32LE(3, 4);
  skin.writeUInt32LE(48, 8);
  skin.writeUInt32LE(3, 12);
  skin.writeUInt32LE(54, 16);
  skin.writeUInt32LE(1, 28);
  skin.writeUInt32LE(64, 32);
  skin.writeUInt32LE(1, 36);
  skin.writeUInt32LE(112, 40);
  for (let index = 0; index < 3; index++) {
    skin.writeUInt16LE(index, 48 + index * 2);
    skin.writeUInt16LE(index, 54 + index * 2);
  }
  skin.writeUInt16LE(0, 64);
  skin.writeUInt16LE(0, 66);
  skin.writeUInt16LE(0, 68);
  skin.writeUInt16LE(3, 70);
  skin.writeUInt16LE(0, 72);
  skin.writeUInt16LE(3, 74);
  skin.writeFloatLE(1 / 3, 84);
  skin.writeFloatLE(1 / 3, 88);
  skin.writeFloatLE(0, 92);
  skin.writeFloatLE(1, 108);
  skin.writeUInt16LE(0, 122);
  skin.writeUInt16LE(1, 126);
  skin.writeUInt16LE(0xffff, 128);
  skin.writeUInt16LE(0, 130);
  skin.writeUInt16LE(0xffff, 132);
  skin.writeUInt16LE(0xffff, 134);
  return skin;
}

function listing(reverse = false) {
  const paths = [
    TILE_A,
    TILE_B,
    OUTSIDE_TILE,
    MODEL_TREE,
    SKIN_TREE,
    MODEL_ROCK,
    MODEL_BROKEN,
    SKIN_BROKEN,
    "World\\Maps\\readme.txt",
  ];
  return reverse ? paths.reverse() : paths;
}

function makeArchives(reverse = false) {
  const files = new Map([
    [TILE_A.toLowerCase().replaceAll("/", "\\"), adt({
      m2: [mddfRecord(0, 100, 1, 2, 3), mddfRecord(0, 101, 4, 5, 6),
        mddfRecord(1, 102, 7, 8, 9), mddfRecord(2, 103, 10, 11, 12)],
      wmo: [modfRecord(0, 900, 20, 21, 22)],
    })],
    [TILE_B.toLowerCase().replaceAll("/", "\\"), adt({
      m2: [mddfRecord(0, 104, 13, 14, 15)],
      wmo: [modfRecord(0, 901, 30, 31, 32)],
    })],
    [MODEL_TREE, m2Bytes()],
    [SKIN_TREE, skinBytes()],
    [MODEL_ROCK, m2Bytes()],
    [MODEL_BROKEN, Buffer.from("not-an-md20")],
    [SKIN_BROKEN, Buffer.from("not-a-skin")],
  ]);
  let closed = false;
  const calls = [];
  const key = (path) => String(path).replaceAll("/", "\\").toLowerCase();
  return {
    calls,
    get closed() { return closed; },
    async list(prefix) {
      calls.push(["list", prefix]);
      // Return the complete index regardless of the requested prefix so the audit itself must
      // enumerate with list("") and perform the canonical World\\Maps filter locally.
      return listing(reverse);
    },
    async read(path) {
      calls.push(["read", path]);
      return files.get(key(path));
    },
    async sourceOf(path) {
      calls.push(["sourceOf", path]);
      return { path: key(path), size: String(path).length, mtimeMs: 1 };
    },
    chainDigest() {
      calls.push(["chainDigest"]);
      return "adt-chain-v1";
    },
    close() {
      closed = true;
    },
  };
}

async function run(reverse = false) {
  const archives = makeArchives(reverse);
  const result = await auditApi()({ archives });
  return { result, archives };
}

test("synthetic ADT fixtures exercise direct M2 versus MODF/WMO semantics", () => {
  const parsed = parseAdtPlacements(adt({
    m2: [mddfRecord(0, 1, 1, 2, 3)],
    wmo: [modfRecord(0, 2, 4, 5, 6)],
  }));
  assert.equal(parsed.filter((entry) => entry.kind === "m2").length, 1);
  assert.equal(parsed.filter((entry) => entry.kind === "wmo").length, 1);
});

test("audit aggregates distinct direct M2 paths and excludes MODF WMOs", async () => {
  const { result } = await run();
  assert.equal(result.placements.length, 3, "five direct MDDF instances aggregate to three model paths");
  assert.equal(result.counts.directM2Placements, 5);
  assert.ok(result.placements.every((placement) => placement.kind === "m2"));
  assert.ok(result.placements.every((placement) => placement.exterior === true
    && placement.staticModel === true));
  assert.equal(result.placements.some((placement) => placement.kind === "wmo"), false);

  assert.deepEqual(result.models.map((model) => ({
    modelPath: model.modelPath,
    placementCount: model.directPlacementCount ?? model.placementCount,
    tileCount: model.tileCount,
  })), [
    { modelPath: MODEL_BROKEN, placementCount: 1, tileCount: 1 },
    { modelPath: MODEL_ROCK, placementCount: 1, tileCount: 1 },
    { modelPath: MODEL_TREE, placementCount: 3, tileCount: 2 },
  ]);
});

test("listed M2 and 00.skin preflight diagnostics are retained per aggregated model", async () => {
  const { result } = await run();
  const tree = result.models.find((model) => model.modelPath === MODEL_TREE);
  const rock = result.models.find((model) => model.modelPath === MODEL_ROCK);
  const broken = result.models.find((model) => model.modelPath === MODEL_BROKEN);
  assert.ok(tree && rock && broken);
  assert.equal(tree.listedM2, true);
  assert.equal(tree.listed00Skin, true);
  assert.equal(rock.listedM2, true);
  assert.equal(rock.listed00Skin, false);
  assert.equal(broken.listedM2, true);
  assert.equal(broken.listed00Skin, true);
  assert.ok(!tree.failReasons.includes("missing00Skin"));
  assert.ok(rock.failReasons.includes("missing00Skin"));
  assert.ok(!broken.failReasons.includes("missingM2"));
  assert.ok(!broken.failReasons.includes("missing00Skin"));
});

test("ADT model aggregation and digest are independent of archive listing order", async () => {
  const forward = await run(false);
  const reverse = await run(true);
  assert.deepEqual(reverse.result.models, forward.result.models);
  assert.deepEqual(reverse.result.placements, forward.result.placements);
  assert.equal(reverse.result.populationDigest ?? reverse.result.digest,
    forward.result.populationDigest ?? forward.result.digest);
});

test("scanner lists the archive once with an empty prefix, filters canonical World\\Maps locally, and borrows archives", async () => {
  const { result, archives } = await run();
  assert.deepEqual(archives.calls[0], ["list", ""]);
  assert.equal(result.models.some((model) => model.modelPath === "world\\other\\not-a-map.m2"), false);
  const outsideKey = OUTSIDE_TILE.toLowerCase().replaceAll("/", "\\");
  assert.equal(archives.calls.some(([kind, path]) => kind === "read"
    && String(path).replaceAll("/", "\\").toLowerCase() === outsideKey), false,
  "non-World\\Maps ADTs must be filtered before archive reads");
  assert.equal(archives.closed, false, "audit must never close a borrowed archive");
});

test("audit source stays independent of runtime renderer/cache and never closes archives", async () => {
  const source = await readFile(new URL("../tools/audit-adt-m2-placements.mjs", import.meta.url), "utf8");
  assert.match(source, /parseAdtPlacements/);
  assert.doesNotMatch(source, /from ["'][^"']*(WorldRenderer3D|RenderAdmission|EnvironmentClient|BuiltModelCache|ResourceCache)/,
    "ADT audit must not depend on runtime renderer/admission/cache");
  assert.doesNotMatch(source, /archives\s*\.\s*close\s*\(/,
    "ADT audit must leave its injected/shared archive open");
});
