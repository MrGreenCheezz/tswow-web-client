import assert from "node:assert/strict";
import test from "node:test";
import { parseAdtPlacements } from "../tools/adt-placements.mjs";
import { encodeVisualModel, parseM2Visual } from "../tools/m2-visual.mjs";
import {
  WMO_LIGHT_EXTERIOR, WMO_LIGHT_INTERIOR, WMO_LIGHT_TRANSITION,
  parseWmoDoodads, parseWmoVisual, wmoDependencies, wmoGroupMeshes,
} from "../tools/wmo-visual.mjs";
import { encodeWwm, encodeWwmGroup, WWM_TRIANGLE_BUDGET } from "../tools/wwm.mjs";
import { decodeVisualModel } from "../dist/code/browser/Terrain.js";
import { decodeWwm, decodeWwmGroup } from "../dist/code/browser/WmoModel.js";

test("ADT visual placements retain full paths and convert client coordinates", () => {
  const worldMid = 0.5 * 64 * 533.33333333;
  const mddf = Buffer.alloc(36);
  mddf.writeUInt32LE(0, 0);
  mddf.writeUInt32LE(99, 4);
  mddf.writeFloatLE(worldMid - 20, 8);
  mddf.writeFloatLE(5, 12);
  mddf.writeFloatLE(worldMid - 10, 16);
  mddf.writeFloatLE(15, 20);
  mddf.writeUInt16LE(1024, 32);
  const adt = Buffer.concat([
    chunk("MMDX", Buffer.from("World\\Doodads\\Tree.m2\0")),
    chunk("MMID", Buffer.alloc(4)),
    chunk("MDDF", mddf),
  ]);
  const [placement] = parseAdtPlacements(adt);
  assert.ok(Math.abs(placement.x - 10) < 0.001);
  assert.ok(Math.abs(placement.y - 20) < 0.001);
  assert.deepEqual({ ...placement, x: 10, y: 20 }, {
    id: 99,
    kind: "m2",
    name: "World\\Doodads\\Tree.m2",
    x: 10,
    y: 20,
    z: 5,
    rotationX: 15,
    rotationY: 0,
    rotationZ: 0,
    scale: 1,
  });
});

test("ADT WMO placements retain the selected doodad set", () => {
  const modf = Buffer.alloc(64);
  modf.writeUInt32LE(0, 0);
  modf.writeUInt32LE(100, 4);
  modf.writeUInt16LE(3, 58);
  const [placement] = parseAdtPlacements(Buffer.concat([
    chunk("MWMO", Buffer.from("World\\House.wmo\0")),
    chunk("MWID", Buffer.alloc(4)),
    chunk("MODF", modf),
  ]));
  assert.equal(placement.kind, "wmo");
  assert.equal(placement.doodadSet, 3);
});

test("M2 visual parser resolves skin indices, UVs and external texture", () => {
  const model = Buffer.alloc(700);
  model.write("MD20", 0, "ascii");
  model.writeUInt32LE(3, 60);
  model.writeUInt32LE(400, 64);
  model.writeUInt32LE(1, 80);
  model.writeUInt32LE(96, 84);
  model.writeUInt32LE(0, 96);
  model.writeUInt32LE(20, 104);
  model.writeUInt32LE(600, 108);
  model.writeUInt32LE(1, 128);
  model.writeUInt32LE(640, 132);
  model.writeUInt16LE(0, 640);
  model.write("World\\Texture.blp\0", 600, "ascii");
  for (let index = 0; index < 3; index++) {
    const offset = 400 + index * 48;
    model.writeFloatLE(index, offset);
    model.writeFloatLE(index + 1, offset + 4);
    model.writeFloatLE(index + 2, offset + 8);
    model.writeFloatLE(index / 2, offset + 32);
    model.writeFloatLE(1 - index / 2, offset + 36);
  }
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
  skin.writeUInt16LE(0, 64 + 8);
  skin.writeUInt16LE(3, 64 + 10);
  skin.writeUInt16LE(0, 112 + 4);
  skin.writeUInt16LE(0, 112 + 16);
  for (let index = 0; index < 3; index++) skin.writeUInt16LE(index, 48 + index * 2), skin.writeUInt16LE(2 - index, 54 + index * 2);
  const parsed = parseM2Visual(model, skin);
  assert.deepEqual(parsed.indices, [2, 1, 0]);
  assert.equal(parsed.texture, "World\\Texture.blp");
  assert.deepEqual(parsed.groups, [{ start: 0, count: 3, material: 0 }]);
  assert.deepEqual(parsed.textures, ["World\\Texture.blp"]);
  assert.equal(encodeVisualModel(parsed, ["/visual/texture/test.png"]).subarray(0, 4).toString(), "WVM2");
});

test("WMO visual parser resolves groups, render triangles, UVs and texture", () => {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(1, 4);
  const textureNames = Buffer.from("World\\Textures\\Wall.blp\0World\\Textures\\Roof.blp\0");
  const materials = Buffer.alloc(128);
  // MOMT: flags at 0, blend mode at 8, the diffuse texture's MOTX offset at 12. The roof is an
  // alpha-keyed, two-sided material and the wall an opaque one-sided one, which is the whole
  // point of carrying this through: they must not be drawn the same way.
  materials.writeUInt32LE(0x04, 64);
  materials.writeUInt32LE(1, 64 + 8);
  materials.writeUInt32LE("World\\Textures\\Wall.blp\0".length, 64 + 12);
  const doodadSet = Buffer.alloc(32);
  doodadSet.writeUInt32LE(0, 20);
  doodadSet.writeUInt32LE(1, 24);
  const doodad = Buffer.alloc(40);
  doodad.writeUInt32LE(0, 0);
  doodad.writeFloatLE(1, 4);
  doodad.writeFloatLE(2, 8);
  doodad.writeFloatLE(3, 12);
  doodad.writeFloatLE(1, 28);
  doodad.writeFloatLE(0.75, 32);
  const root = Buffer.concat([
    chunk("MOHD", header),
    chunk("MOTX", textureNames),
    chunk("MOMT", materials),
    chunk("MODS", doodadSet),
    chunk("MODN", Buffer.from("World\\Furniture\\Chair.mdx\0")),
    chunk("MODD", doodad),
  ]);
  const vertices = Buffer.alloc(48);
  const coordinates = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
  coordinates.forEach((value, index) => vertices.writeFloatLE(value, index * 4));
  const uvs = Buffer.alloc(32);
  [0, 0, 1, 0, 0, 1, 1, 1].forEach((value, index) => uvs.writeFloatLE(value, index * 4));
  // Three triangles: two drawn, and one the collision hull owns outright.
  const indices = Buffer.alloc(18);
  [0, 1, 2, 1, 3, 2, 0, 2, 3].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  // 0x24 is F_RENDER together with F_DETAIL, which is what most of a real building carries:
  // F_DETAIL means "outside the collision hull", not "do not draw". 0x48 with material 0xFF is
  // the collision-only triangle. Selecting on `F_RENDER && !F_DETAIL` kept 3,166 of the Goldshire
  // Inn's 24,274 drawn triangles, so seven eighths of it was simply absent.
  const batch = Buffer.alloc(48);
  batch.writeUInt32LE(0, 12);
  batch.writeUInt16LE(3, 16);
  batch.writeUInt16LE(0, 18);
  batch.writeUInt16LE(2, 20);
  batch.writeUInt8(0, 23);
  batch.writeUInt32LE(3, 24 + 12);
  batch.writeUInt16LE(3, 24 + 16);
  batch.writeUInt16LE(1, 24 + 18);
  batch.writeUInt16LE(3, 24 + 20);
  batch.writeUInt8(1, 24 + 23);
  const group = chunk("MOGP", Buffer.concat([
    Buffer.alloc(68),
    chunk("MOVT", vertices),
    chunk("MOTV", uvs),
    chunk("MOVI", indices),
    chunk("MOPY", Buffer.from([0x24, 0, 0x24, 1, 0x48, 0xff])),
    chunk("MOBA", batch),
  ]));
  assert.deepEqual(wmoDependencies(root, "World\\Buildings\\House.wmo"), {
    groups: ["World\\Buildings\\House_000.wmo"],
    texture: "World\\Textures\\Wall.blp",
    materialTextures: ["World\\Textures\\Wall.blp", "World\\Textures\\Roof.blp"],
    materials: [
      { flags: 0, blendMode: 0, texture: "World\\Textures\\Wall.blp" },
      { flags: 0x04, blendMode: 1, texture: "World\\Textures\\Roof.blp" },
    ],
  });
  const parsed = parseWmoVisual(root, [group], "World\\Buildings\\House.wmo");
  assert.deepEqual(parsed.vertices, coordinates);
  assert.deepEqual(parsed.uvs, [0, 0, 1, 0, 0, 1, 1, 1]);
  assert.deepEqual(parsed.indices, [0, 1, 2, 1, 3, 2], "the batches decide, and they leave the collision triangle out");
  assert.deepEqual(parsed.triangleMaterials, [0, 1]);
  const meshes = wmoGroupMeshes(parsed);
  assert.equal(meshes.groups.length, 1);
  const [only] = meshes.groups;
  assert.deepEqual([...only.indices], [0, 1, 2, 1, 3, 2]);
  assert.deepEqual(only.runs, [
    { start: 0, count: 3, material: 0, blendMode: 0, materialFlags: 0, lighting: WMO_LIGHT_EXTERIOR },
    { start: 3, count: 3, material: 1, blendMode: 1, materialFlags: 0x04, lighting: WMO_LIGHT_EXTERIOR },
  ]);
  assert.deepEqual(meshes.textures, ["World\\Textures\\Wall.blp", "World\\Textures\\Roof.blp"]);
  const encoded = encodeWwm(meshes, ["/wall.png", "/roof.png"]);
  assert.equal(encoded.subarray(0, 4).toString(), "WWM1");
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "http://gateway");
  assert.deepEqual(decoded.groups[0].mesh.runs, only.runs, "blend mode, material flags and light have to survive the artifact");
  assert.deepEqual(decoded.textureUrls, ["http://gateway/wall.png", "http://gateway/roof.png"]);

  // A group with no MOBA at all still draws everything the collision hull does not own.
  const unbatched = chunk("MOGP", Buffer.concat([
    Buffer.alloc(68),
    chunk("MOVT", vertices),
    chunk("MOTV", uvs),
    chunk("MOVI", indices),
    chunk("MOPY", Buffer.from([0x24, 0, 0x24, 1, 0x48, 0xff])),
  ]));
  assert.deepEqual(parseWmoVisual(root, [unbatched], "World\\Buildings\\House.wmo").indices, [0, 1, 2, 1, 3, 2]);
  assert.deepEqual(parseWmoDoodads(root, 0), [{
    name: "World\\Furniture\\Chair.m2",
    x: 1, y: 2, z: 3,
    quaternionX: 0, quaternionY: 0, quaternionZ: 0, quaternionW: 1,
    scale: 0.75,
  }]);
});

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// Stormwind (761,902 vertices / 777,675 indices) used to die here with
// "Maximum call stack size exceeded": the grouping step flattened each bucket with
// `indices.push(...bucket)`, which passes every element as a call argument. The measured limit
// on this engine sits between 87,774 and 200,000, so the fixture is sized above it.
test("wmoGroupMeshes flattens a group larger than the argument limit", () => {
  const triangles = 120_000;
  const vertexCount = 65_536;
  const indices = new Array(triangles * 3);
  for (let index = 0; index < indices.length; index++) indices[index] = index % vertexCount;
  const triangleMaterials = new Array(triangles);
  for (let triangle = 0; triangle < triangles; triangle++) triangleMaterials[triangle] = triangle % 2;

  const meshes = wmoGroupMeshes({
    vertices: new Array(vertexCount * 3).fill(0), uvs: new Array(vertexCount * 2).fill(0),
    colours: new Array(vertexCount * 4).fill(255), indices, triangleMaterials,
    materialTextures: ["Wall.blp", "Roof.blp"],
    wmoGroups: [{ flags: 0, indoor: false, min: [0, 0, 0], max: [1, 1, 1], vertexStart: 0, vertexCount, indexStart: 0, indexCount: indices.length }],
  });

  const [only] = meshes.groups;
  assert.equal(only.indices.length, indices.length);
  assert.deepEqual(only.runs.map((run) => [run.start, run.count, run.material]), [
    [0, triangles / 2 * 3, 0],
    [triangles / 2 * 3, triangles / 2 * 3, 1],
  ]);
  // Every triangle kept its own vertices, just reordered into per-material runs.
  assert.deepEqual([...only.indices.slice(0, 3)], indices.slice(0, 3));
  assert.deepEqual([...only.indices.slice(triangles / 2 * 3, triangles / 2 * 3 + 3)], indices.slice(3, 6));
});

test("PacketWriter.bytes accepts a payload larger than the argument limit", async () => {
  const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
  const payload = new Uint8Array(200_000);
  for (let index = 0; index < payload.length; index++) payload[index] = index & 0xff;
  const written = new PacketWriter().bytes(payload).toUint8Array();
  assert.equal(written.length, payload.length);
  assert.equal(written[0], 0);
  assert.equal(written[199_999], 199_999 & 0xff);
});

let wmoArchives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  wmoArchives = await clientArchives(clientDirectory());
} catch {
  wmoArchives = undefined;
}
const withWmoClient = { skip: wmoArchives ? false : "no 3.3.5a client on this machine" };
const clientPath = (name) => name.split("/").join(String.fromCharCode(92));

test("a WMO group says whether it is indoors, where it is, and what light was baked into it", () => {
  // The flags word is at 0x08 of MOGP, not 0x0C. Read at 0x0C it lands on the first float of the
  // bounding box, and every bit then appears set on about half a building's groups — which is what
  // a float looks like to a bit test, and is how the mistake announces itself.
  const vertices = Buffer.alloc(48);
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0].forEach((value, index) => vertices.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(12);
  [0, 1, 2, 1, 3, 2].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  // Stored BGRA: a dim warm light on the first vertex, black on the rest.
  const colours = Buffer.from([10, 20, 30, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const header = Buffer.alloc(68);
  header.writeUInt32LE(0x2000 | 0x04, 8);
  [-1, -2, -3, 4, 5, 6].forEach((value, index) => header.writeFloatLE(value, 12 + index * 4));
  header.writeUInt16LE(7, 0x24);
  header.writeUInt16LE(2, 0x26);
  const group = chunk("MOGP", Buffer.concat([
    header,
    chunk("MOVT", vertices),
    chunk("MOVI", indices),
    chunk("MOCV", colours),
    chunk("MOPY", Buffer.from([0x24, 0, 0x24, 0])),
  ]));
  const root = chunk("MVER", Buffer.alloc(4));
  const mohd = Buffer.alloc(64);
  mohd.writeUInt32LE(1, 4);
  // MOHD.ambColor, BGRA: the light an interior sits in before anything is baked on top.
  mohd.writeUInt32LE(0xff0a1420, 28);
  const full = Buffer.concat([
    root, chunk("MOHD", mohd),
    chunk("MOTX", Buffer.from("World\Textures\Wall.blp\0", "latin1")),
    chunk("MOMT", Buffer.alloc(64)),
  ]);
  const parsed = parseWmoVisual(full, [group], "World\Buildings\House.wmo");

  assert.equal(parsed.wmoGroups.length, 1);
  const [record] = parsed.wmoGroups;
  assert.equal(record.indoor, true, "0x2000 at offset 8 is the indoor bit");
  assert.deepEqual(record.min, [-1, -2, -3]);
  assert.deepEqual(record.max, [4, 5, 6]);
  assert.equal(record.vertexStart, 0);
  assert.equal(record.vertexCount, 4);
  assert.equal(record.indexStart, 0);
  assert.equal(record.indexCount, 6);
  assert.equal(record.portalStart, 7);
  assert.equal(record.portalCount, 2);
  // BGRA on disk, RGBA in hand.
  assert.deepEqual([...parsed.colours.slice(0, 4)], [30, 20, 10, 255]);
  assert.deepEqual(parsed.ambient, [10, 20, 32], "the model's own ambient, unpacked from BGRA");
});

function bareHeader() {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(1, 4);
  return header;
}

test("a group without baked colours is white rather than black", () => {
  // White multiplies to nothing; a missing MOCV must not put the room in the dark.
  const vertices = Buffer.alloc(36);
  const indices = Buffer.alloc(6);
  [0, 1, 2].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const group = chunk("MOGP", Buffer.concat([
    Buffer.alloc(68), chunk("MOVT", vertices), chunk("MOVI", indices),
    chunk("MOPY", Buffer.from([0x24, 0])),
  ]));
  const full = Buffer.concat([
    chunk("MVER", Buffer.alloc(4)), chunk("MOHD", bareHeader()),
    chunk("MOTX", Buffer.from("World\Textures\Wall.blp\0", "latin1")),
    chunk("MOMT", Buffer.alloc(64)),
  ]);
  const parsed = parseWmoVisual(full, [group], "World\Buildings\House.wmo");
  assert.deepEqual([...parsed.colours], [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  assert.equal(parsed.wmoGroups[0].indoor, false);
});

test("a real building partitions into groups exactly, and a city is mostly indoors", withWmoClient, async () => {
  // The partition has to be exact or a group's geometry is drawn with another group's visibility.
  // Stormwind is the case that matters: 286 groups, 278 of them interior, and 22.2 MB of merged
  // artifact today with every room visible through every wall.
  for (const [name, expected] of [
    ["World/wmo/Azeroth/Buildings/GoldshireInn/GoldshireInn.wmo", { groups: 12, indoor: 10 }],
    ["World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo", { groups: 286, indoor: 278 }],
  ]) {
    const rootPath = clientPath(name);
    const root = await wmoArchives.read(rootPath);
    assert.ok(root, `${name} is in the client`);
    const dependencies = wmoDependencies(root, rootPath);
    const groups = [];
    for (const path of dependencies.groups) groups.push(await wmoArchives.read(path));
    const parsed = parseWmoVisual(root, groups, rootPath);

    assert.equal(parsed.wmoGroups.length, expected.groups, `${name}: group count`);
    assert.equal(parsed.wmoGroups.filter((group) => group.indoor).length, expected.indoor, `${name}: indoor groups`);
    assert.equal(parsed.colours.length, parsed.vertices.length / 3 * 4, `${name}: one colour a vertex`);
    const vertexTotal = parsed.wmoGroups.reduce((total, group) => total + group.vertexCount, 0);
    const indexTotal = parsed.wmoGroups.reduce((total, group) => total + group.indexCount, 0);
    assert.equal(vertexTotal, parsed.vertices.length / 3, `${name}: the vertex ranges cover the mesh`);
    assert.equal(indexTotal, parsed.indices.length, `${name}: the index ranges cover the mesh`);
    assert.ok(parsed.portals.definitions.length > 0, `${name}: it has portals`);
    assert.ok(parsed.ambient.some((channel) => channel > 0), `${name}: and an ambient of its own`);
  }
});

test("the vertex colour flag and the MOCV chunk agree, on every group of a city", withWmoClient, async () => {
  // Verified rather than assumed: bit 2 of the group flags is set on exactly the groups that carry
  // a MOCV chunk. On Stormwind that is 192 of 286, with one colour per vertex on all 192 and not a
  // single disagreement either way.
  const rootPath = clientPath("World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo");
  const root = await wmoArchives.read(rootPath);
  const dependencies = wmoDependencies(root, rootPath);
  const groups = [];
  for (const path of dependencies.groups) groups.push(await wmoArchives.read(path));
  const parsed = parseWmoVisual(root, groups, rootPath);

  let flagged = 0;
  for (const group of parsed.wmoGroups) {
    const coloured = (group.flags & 0x04) !== 0;
    if (coloured) flagged++;
    let white = true;
    for (let index = group.vertexStart; index < group.vertexStart + group.vertexCount && white; index++) {
      const at = index * 4;
      if (parsed.colours[at] !== 255 || parsed.colours[at + 1] !== 255 || parsed.colours[at + 2] !== 255) white = false;
    }
    if (!coloured) assert.ok(white, "a group without the flag carries no baked light");
  }
  assert.equal(flagged, 192, "192 of Stormwind's 286 groups are lit by baked colour");
});
