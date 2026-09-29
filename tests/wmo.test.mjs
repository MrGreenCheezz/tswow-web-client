import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { parseAdtPlacements } from "../tools/adt-placements.mjs";
import {
  WMO_LIGHT_EXTERIOR, WMO_LIGHT_INTERIOR, WMO_LIGHT_TRANSITION,
  parseWmoVisual, wmoDependencies, wmoGroupMeshes,
} from "../tools/wmo-visual.mjs";
import { WWM_TRIANGLE_BUDGET, encodeWwm, encodeWwmGroup } from "../tools/wwm.mjs";
import {
  WMO_FOG_UNBOUNDED, decodeWwm, decodeWwmGroup, wmoFogAt, wmoLandFogActive, wmoLandFogAt,
  wmoRunIsInterior, wmoVertexLight,
} from "../dist/code/browser/WmoModel.js";
import {
  placeEnvironmentNode, wmoGroupBoxes, wmoGroupsInRange, wmoShellRange,
} from "../dist/code/browser/WorldRenderer3D.js";
import { selectWmoPortalGroups } from "../dist/code/browser/WmoOcclusion.js";

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** The metadata slice the WME1-only decoder shipped before portal support. */
function decodeOldWme1Envelope(data) {
  const metadataOffset = data.readUInt32LE(20);
  assert.equal(data.subarray(metadataOffset, metadataOffset + 4).toString("ascii"), "WME1");
  const groupCount = data.readUInt32LE(metadataOffset + 4);
  assert.equal(groupCount, data.readUInt32LE(4));
  assert.ok(metadataOffset + 8 + groupCount <= data.length);
  return [...data.subarray(metadataOffset + 8, metadataOffset + 8 + groupCount)].map((value) => value !== 0);
}

const align4 = (value) => Math.ceil(value / 4) * 4;
const VMAP_TO_THREE = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

/** A root with two materials and no lamps unless one is asked for. */
function houseRoot(lights = [], groupCount = 1, fogs = []) {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(groupCount, 4);
  const names = Buffer.from("World\\Textures\\Wall.blp\0World\\Textures\\Roof.blp\0");
  const materials = Buffer.alloc(128);
  materials.writeUInt32LE(names.indexOf("World\\Textures\\Roof.blp"), 64 + 12);
  const molt = Buffer.alloc(lights.length * 48);
  for (const [index, light] of lights.entries()) {
    const at = index * 48;
    molt.writeUInt8(0, at);
    molt.writeUInt8(1, at + 1);
    molt.writeUInt8(light.colour[2], at + 4);
    molt.writeUInt8(light.colour[1], at + 5);
    molt.writeUInt8(light.colour[0], at + 6);
    molt.writeUInt8(255, at + 7);
    for (let axis = 0; axis < 3; axis++) molt.writeFloatLE(light.position[axis], at + 8 + axis * 4);
    molt.writeFloatLE(light.intensity, at + 20);
    molt.writeFloatLE(light.start, at + 40);
    molt.writeFloatLE(light.end, at + 44);
  }
  // MFOG, 48 bytes each: flags, position, the two radii, then end/scale/BGRA twice — once for a
  // camera in air and once for one in water.
  const mfog = Buffer.alloc(fogs.length * 48);
  for (const [index, fog] of fogs.entries()) {
    const at = index * 48;
    mfog.writeUInt32LE(fog.flags ?? 0, at);
    for (let axis = 0; axis < 3; axis++) mfog.writeFloatLE(fog.position[axis], at + 4 + axis * 4);
    mfog.writeFloatLE(fog.innerRadius ?? 0, at + 16);
    mfog.writeFloatLE(fog.outerRadius ?? 0, at + 20);
    for (const [offset, half] of [[24, fog.land], [36, fog.water ?? fog.land]]) {
      mfog.writeFloatLE(half.end, at + offset);
      mfog.writeFloatLE(half.scale, at + offset + 4);
      mfog.writeUInt8(half.colour[2], at + offset + 8);
      mfog.writeUInt8(half.colour[1], at + offset + 9);
      mfog.writeUInt8(half.colour[0], at + offset + 10);
      mfog.writeUInt8(255, at + offset + 11);
    }
  }
  return Buffer.concat([
    chunk("MOHD", header), chunk("MOTX", names), chunk("MOMT", materials),
    ...(lights.length > 0 ? [chunk("MOLT", molt)] : []),
    ...(fogs.length > 0 ? [chunk("MFOG", mfog)] : []),
  ]);
}

/**
 * One group of a square room: four vertices, two triangles per batch.
 *
 * `batches` is a list of `[firstTriangle, triangleCount, material]`, and the three counts that
 * follow decide which light each of them is drawn in.
 */
function houseGroup({ flags = 0, batches = [], counts = [0, 0, 0], colours, lightRefs, fogIds,
  box = [-1, -2, -3, 4, 5, 6] } = {}) {
  const vertices = Buffer.alloc(48);
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0].forEach((value, index) => vertices.writeFloatLE(value, index * 4));
  const uvs = Buffer.alloc(32);
  const indices = Buffer.alloc(6 * 6);
  [0, 1, 2, 1, 3, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3, 0, 3, 1].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  box.forEach((value, index) => header.writeFloatLE(value, 12 + index * 4));
  header.writeUInt16LE(counts[0], 0x28);
  header.writeUInt16LE(counts[1], 0x2a);
  header.writeUInt16LE(counts[2], 0x2c);
  // fogIds: four one-byte indices at 0x30, the way the reference client reads them
  // (`wowee/src/pipeline/wmo_loader.cpp:474-478`).
  for (const [slot, id] of (fogIds ?? []).entries()) header.writeUInt8(id, 0x30 + slot);
  const batchData = Buffer.alloc(batches.length * 24);
  for (const [index, [first, count, material]] of batches.entries()) {
    batchData.writeUInt32LE(first * 3, index * 24 + 12);
    batchData.writeUInt16LE(count * 3, index * 24 + 16);
    batchData.writeUInt8(material, index * 24 + 23);
  }
  const parts = [header, chunk("MOVT", vertices), chunk("MOTV", uvs), chunk("MOVI", indices)];
  if (colours) parts.push(chunk("MOCV", Buffer.from(colours)));
  if (batches.length > 0) parts.push(chunk("MOBA", batchData));
  else parts.push(chunk("MOPY", Buffer.alloc(12)));
  if (lightRefs) {
    const molr = Buffer.alloc(lightRefs.length * 2);
    lightRefs.forEach((value, index) => molr.writeUInt16LE(value, index * 2));
    parts.push(chunk("MOLR", molr));
  }
  return chunk("MOGP", Buffer.concat(parts));
}

test("the order of a group's batches says which light each run is drawn in", () => {
  // MOBA is one list and the three words at 0x28 partition it: transition batches first, then the
  // ones lit by what the artist baked, then the ones lit by the sun. Nothing else on the wire says
  // this — and the group's own indoor flag does not, which is the point.
  const root = houseRoot();
  const group = houseGroup({
    flags: 0x2000,
    batches: [[0, 1, 0], [1, 1, 1], [2, 1, 0]],
    counts: [1, 1, 1],
  });
  const meshes = wmoGroupMeshes(parseWmoVisual(root, [group], "World\\Buildings\\House.wmo"));
  assert.deepEqual(meshes.groups[0].runs.map((run) => [run.material, run.lighting]), [
    [0, WMO_LIGHT_TRANSITION],
    [1, WMO_LIGHT_INTERIOR],
    [0, WMO_LIGHT_EXTERIOR],
  ], "the same material twice is two runs when the light differs");

  // A group with no batches at all has only its flag to go on.
  const unbatched = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ flags: 0x2000 })], "World\\Buildings\\House.wmo"));
  assert.deepEqual(unbatched.groups[0].runs.map((run) => run.lighting), [WMO_LIGHT_INTERIOR]);
  const outdoors = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ flags: 0 })], "World\\Buildings\\House.wmo"));
  assert.deepEqual(outdoors.groups[0].runs.map((run) => run.lighting), [WMO_LIGHT_EXTERIOR]);
});

test("the same interior batch is a room's wall or a city street depending on the group's flag", () => {
  // Which of the two materials a run gets is the batch order *and* the MOGP flag, not either one.
  // Dalaran is why the flag has to be asked: the artist left its streets on interior batches, and
  // the batch order alone hands the whole city to the unlit material.
  const root = houseRoot();
  const interiorBatch = { batches: [[0, 1, 0]], counts: [0, 1, 0] };
  const decodeOf = (flags) => {
    const model = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ flags, ...interiorBatch })], "World\\Buildings\\House.wmo"));
    const encoded = encodeWwm(model, model.textures.map(() => "/wall.png"));
    return decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  };

  const street = decodeOf(0);
  assert.deepEqual(street.groups[0].mesh.runs.map((run) => run.lighting), [WMO_LIGHT_INTERIOR]);
  assert.equal(street.groups[0].indoor, false);
  assert.equal(wmoRunIsInterior(street.groups[0], street.groups[0].mesh.runs[0]), false,
    "an interior batch in a group that is not a room is lit by the scene");

  const room = decodeOf(0x2000);
  assert.deepEqual(room.groups[0].mesh.runs.map((run) => run.lighting), [WMO_LIGHT_INTERIOR]);
  assert.equal(room.groups[0].indoor, true);
  assert.equal(wmoRunIsInterior(room.groups[0], room.groups[0].mesh.runs[0]), true,
    "the same batch in a room is unlit and multiplied by what the artist baked");

  // And the half the flag must not swallow: Stormwind's rooms carry outward faces on exterior
  // batches, and those stay in the sun however the group is flagged.
  assert.equal(wmoRunIsInterior(room.groups[0], { ...room.groups[0].mesh.runs[0], lighting: WMO_LIGHT_EXTERIOR }), false,
    "an exterior batch inside a room is the wall facing the street");
});

test("and the renderer picks the material by that rule, not by the batch on its own", async () => {
  // The rule above is a pure function and well covered; its one call site was not covered at all.
  // `#wmoRunMaterial` is private, is called from one line and needs a WebGL context, so no test in
  // this directory builds a `WorldRenderer3D`. Measured before this test existed: putting
  // `run.lighting !== WMO_LIGHT_EXTERIOR` back on that line brings the whole Dalaran defect back
  // and all 1,512 tests that ran still passed. Asserting on the source text is how this file is
  // pinned elsewhere for the same reason (`light.test.mjs`, `wmo-occlusion.test.mjs`,
  // `portraits.test.mjs`, `tone-mapping.test.mjs`).
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const method = source.indexOf("  #wmoRunMaterial(");
  assert.ok(method > 0, "the material for one run is still chosen in one named place");
  const body = source.slice(method, source.indexOf("\n  }", method));
  assert.match(body, /const interior = wmoRunIsInterior\(group, run\)/,
    "the group and the batch together decide which material a run gets");
  assert.doesNotMatch(body, /run\.lighting !== WMO_LIGHT_EXTERIOR/,
    "and the batch order alone must not decide it again behind the rule's back");
  assert.match(source.slice(0, method), /this\.#wmoRunMaterial\(model, group, run\)/,
    "the group reaches it: dropping the argument is the same defect one call up");
});

test("a model over the budget travels as its boxes, and its rooms arrive one at a time", () => {
  const root = houseRoot([], 2);
  const model = wmoGroupMeshes(parseWmoVisual(root, [
    houseGroup({ flags: 0x2000, box: [-1, -2, -3, 4, 5, 6] }),
    houseGroup({ flags: 0, box: [10, 11, 12, 20, 21, 22] }),
  ], "World\\Buildings\\House.wmo"));

  const urls = model.textures.map((_texture, index) => `/texture-${index}.png`);
  const whole = encodeWwm(model, urls);
  const arrived = decodeWwm(whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength), "http://gateway");
  assert.equal(arrived.complete, true);
  assert.equal(arrived.groups.length, 2);
  assert.ok(arrived.groups.every((group) => group.mesh), "a small model brings everything on the first request");

  const held = encodeWwm(model, urls, new Set());
  const boxes = decodeWwm(held.buffer.slice(held.byteOffset, held.byteOffset + held.byteLength), "http://gateway");
  assert.equal(boxes.complete, false);
  assert.ok(boxes.groups.every((group) => group.mesh === undefined), "held back means held back");
  // What the header always carries is enough to choose with: where each room is, whether it is one,
  // and how big it is.
  assert.deepEqual(boxes.groups[0].bounds, { minX: -1, minY: -2, minZ: -3, maxX: 4, maxY: 5, maxZ: 6 });
  assert.equal(boxes.groups[0].indoor, true);
  assert.equal(boxes.groups[0].exterior, false);
  assert.equal(boxes.groups[1].indoor, false);
  assert.equal(boxes.groups[1].exterior, true);
  assert.deepEqual(boxes.groups.map((group) => [group.vertexCount, group.triangleCount]), [[4, 6], [4, 6]]);
  assert.ok(held.length < whole.length, "and it is smaller than the model it describes");

  const block = encodeWwmGroup(model.groups[1], 1);
  const room = decodeWwmGroup(block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength));
  assert.equal(room.index, 1, "a block says which room it is, so a stale cache cannot pass one off as another");
  assert.deepEqual([...room.mesh.indices], [...model.groups[1].indices]);
  assert.deepEqual(room.mesh.runs, arrived.groups[1].mesh.runs, "the same bytes either way");
  assert.deepEqual([...room.mesh.positions], [...arrived.groups[1].mesh.positions]);
});

test("an indoor street-boundary run keeps the long range without changing its authored light", () => {
  for (const [name, counts, boundaryLight] of [
    ["exterior", [0, 1, 1], WMO_LIGHT_EXTERIOR],
    ["transition", [1, 1, 0], WMO_LIGHT_TRANSITION],
  ]) {
    const root = houseRoot();
    const model = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({
      flags: 0x2000,
      batches: [[0, 1, 0], [1, 1, 0]],
      counts,
      box: [100, 200, 300, 110, 210, 310],
    })], "World\\Buildings\\House.wmo"));
    const encoded = encodeWwm(model, model.textures.map(() => "/wall.png"), new Set([0]));
    const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
    const group = decoded.groups[0];
    assert.equal(group.flags, 0x2000, `${name}: artifact bit is not exposed as an MOGP flag`);
    assert.equal(group.indoor, true);
    assert.equal(group.exterior, true, `${name}: header carries the boundary-demand property`);
    const boundaryRun = group.mesh.runs.find((run) => run.lighting === boundaryLight);
    assert.ok(boundaryRun, `${name}: authored run survives the artifact`);
    assert.equal(wmoRunIsInterior(group, boundaryRun), name === "transition",
      `${name}: demand metadata must not rewrite the run's lighting semantics`);

    const placement = { id: 1, kind: "wmo", name: "House.wmo", x: 0, y: 0, z: 0,
      rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
    const boxes = wmoGroupBoxes(decoded, placement);
    const farOutside = wmoGroupsInRange(decoded, boxes, { x: 200, y: -205, z: 0, orientation: 0 });
    assert.deepEqual(farOutside, [], `${name}: group AABB still bounds selection`);
    const outsideButClose = wmoGroupsInRange(decoded, boxes, { x: 0, y: -205, z: 0, orientation: 0 });
    assert.deepEqual(outsideButClose, [0], `${name}: boundary gets 250 yd, not the 60 yd room leash`);
  }
});

test("artifact metadata preserves every MOGP flag bit and old WWM1 headers", () => {
  const root = houseRoot();
  const source = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ flags: 0x2000 })], "World\\Buildings\\House.wmo"));
  // These are real 3.3.5 Stormwind flag words. Neither group has an exterior-lit run, so the
  // metadata must not manufacture one from the source high bit.
  source.groups[0].flags = 0x8020180d;
  source.groups[0].runs[0].lighting = WMO_LIGHT_INTERIOR;
  const modern = encodeWwm(source, source.textures.map(() => "/wall.png"));
  const decoded = decodeWwm(modern.buffer.slice(modern.byteOffset, modern.byteOffset + modern.byteLength), "");
  assert.equal(decoded.groups[0].flags >>> 0, 0x8020180d);
  assert.equal(decoded.groups[0].exterior, false);

  // Simulate a pre-metadata WWM1 artifact by removing the trailing section and restoring its
  // reserved word. It must decode with the same flags and the old non-indoor range fallback.
  const metadataOffset = modern.readUInt32LE(20);
  const legacy = Buffer.from(modern.subarray(0, metadataOffset));
  legacy.writeUInt32LE(0, 20);
  legacy.writeUInt32LE(legacy.length, 16);
  const old = decodeWwm(legacy.buffer.slice(legacy.byteOffset, legacy.byteOffset + legacy.byteLength), "");
  assert.equal(old.groups[0].flags >>> 0, 0x8020180d);
  assert.equal(old.groups[0].exterior, false);
});

test("WME2 round-trips the portal graph and damaged portal metadata falls back", () => {
  const source = wmoGroupMeshes(parseWmoVisual(houseRoot([], 2), [
    houseGroup({ flags: 0x2000, box: [-1, -1, -1, 1, 1, 1] }),
    houseGroup({ flags: 0x2000, box: [2, -1, -1, 4, 1, 1] }),
  ], "World\\Buildings\\TwoRooms.wmo"));
  source.portals = {
    vertices: [-0.2, -0.5, 0, 0.2, -0.5, 0, 0.2, 0.5, 0, -0.2, 0.5, 0],
    definitions: [{ startVertex: 0, vertexCount: 4 }],
    references: [{ portal: 0, group: 1, side: 1 }, { portal: 0, group: 0, side: -1 }],
  };
  Object.assign(source.groups[0], { portalStart: 0, portalCount: 1 });
  Object.assign(source.groups[1], { portalStart: 1, portalCount: 1, exterior: true });
  const encoded = encodeWwm(source, source.textures.map(() => "/wall.png"), new Set());
  assert.deepEqual(decodeOldWme1Envelope(encoded), [false, true],
    "the exact old reader accepts the new artifact and ignores what follows its WME1 table");
  const metadata = encoded.readUInt32LE(20);
  const extension = align4(metadata + 8 + source.groups.length);
  assert.equal(encoded.subarray(extension, extension + 4).toString("ascii"), "WME2");
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.deepEqual([...decoded.portals.vertices], [...new Float32Array(source.portals.vertices)]);
  assert.deepEqual(decoded.portals.definitions, source.portals.definitions);
  assert.deepEqual(decoded.portals.references, source.portals.references);
  assert.deepEqual(decoded.groups.map((entry) => [entry.portalStart, entry.portalCount]), [[0, 1], [1, 1]]);

  const legacyOnly = Buffer.from(encoded.subarray(0, extension));
  legacyOnly.writeUInt32LE(legacyOnly.length, 16);
  const legacyDecoded = decodeWwm(
    legacyOnly.buffer.slice(legacyOnly.byteOffset, legacyOnly.byteOffset + legacyOnly.byteLength), "");
  assert.equal(legacyDecoded.portals, undefined);
  assert.deepEqual(legacyDecoded.groups.map((entry) => entry.exterior), [false, true]);

  // The exterior table remains useful, but a bad target must disable the whole graph rather than
  // letting one malformed edge hide a valid room or reject otherwise drawable geometry.
  const damaged = Buffer.from(encoded);
  const firstReference = extension + 24 + source.groups.length * 8 + source.portals.vertices.length * 4
    + source.portals.definitions.length * 4;
  damaged.writeUInt16LE(99, firstReference + 2);
  const fallback = decodeWwm(damaged.buffer.slice(damaged.byteOffset, damaged.byteOffset + damaged.byteLength), "");
  assert.equal(fallback.portals, undefined);
  assert.deepEqual(fallback.groups.map((entry) => entry.portalCount), [0, 0]);

  const malformed = {
    ...source,
    portals: {
      ...source.portals,
      references: [{ portal: 0, group: 0xffff, side: 1 }, source.portals.references[1]],
    },
  };
  const safe = encodeWwm(malformed, source.textures.map(() => "/wall.png"));
  const drawable = decodeWwm(safe.buffer.slice(safe.byteOffset, safe.byteOffset + safe.byteLength), "");
  assert.ok(drawable.groups.every((entry) => entry.mesh),
    "a malformed optional graph cannot prevent the core WMO geometry from being published");
  assert.equal(drawable.portals, undefined);
  assert.deepEqual(drawable.groups.map((entry) => entry.portalCount), [0, 0]);
});

test("a truncated WMO artifact is refused rather than half-read", () => {
  const root = houseRoot();
  const model = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ flags: 0x2000 })], "World\\Buildings\\House.wmo"));
  const whole = encodeWwm(model, model.textures.map(() => "/wall.png"));
  const buffer = whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength);
  assert.throws(() => decodeWwm(buffer.slice(0, buffer.byteLength - 4), ""), /length does not match/);
  assert.throws(() => decodeWwm(buffer.slice(0, 8), ""), /truncated/);
  const block = encodeWwmGroup(model.groups[0], 0);
  const blockBuffer = block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength);
  assert.throws(() => decodeWwmGroup(blockBuffer.slice(0, blockBuffer.byteLength - 8)), /truncated/);
});

test("WWM roots enforce their normal envelope and embedded group counts", () => {
  const source = wmoGroupMeshes(parseWmoVisual(houseRoot([], 2), [
    houseGroup({ box: [-1, -1, -1, 1, 1, 1] }),
    houseGroup({ box: [2, -1, -1, 4, 1, 1] }),
  ], "World\\Buildings\\TwoRooms.wmo"));
  source.groups[0].normals = new Float32Array(source.groups[0].positions.length);
  source.groups[0].normals.fill(1);
  const encoded = encodeWwm(source, source.textures.map(() => "/wall.png"));
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.equal(encoded.subarray(0, 4).toString("ascii"), "WWM2");
  assert.ok(decoded.groups[0].mesh?.normals);
  assert.equal(decoded.groups[1].mesh?.normals, undefined, "WWM2 permits mixed normal-bearing groups");

  const oldRoot = Buffer.from(encoded);
  oldRoot.write("WWM1", 0, "ascii");
  assert.throws(
    () => decodeWwm(oldRoot.buffer.slice(oldRoot.byteOffset, oldRoot.byteOffset + oldRoot.byteLength), ""),
    /WWM1 group block carries authored normals/,
  );

  const wrongCounts = Buffer.from(encoded);
  wrongCounts.writeUInt32LE(99, 24 + 28);
  assert.throws(
    () => decodeWwm(wrongCounts.buffer.slice(wrongCounts.byteOffset, wrongCounts.byteOffset + wrongCounts.byteLength), ""),
    /counts disagree with its root table/,
  );
});

test("normal streams require Float32 representability", () => {
  const model = wmoGroupMeshes(parseWmoVisual(houseRoot(), [houseGroup()], "World\\Buildings\\House.wmo"));
  const group = { ...model.groups[0], normals: new Array(model.groups[0].positions.length).fill(Number.MAX_VALUE) };
  assert.throws(() => encodeWwmGroup(group, 0), /Float32-representable/);
});

test("malformed MOGP bounds fail open without losing a valid group", () => {
  const model = wmoGroupMeshes(parseWmoVisual(houseRoot(), [houseGroup({ box: [Number.NaN, -2, -3, 4, 5, 6] })], "World\\Buildings\\House.wmo"));
  assert.equal(model.groups[0].boundsValid, false);
  const encoded = encodeWwm(model, model.textures.map(() => "/wall.png"));
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.equal(decoded.groups[0].boundsValid, false);
  const placement = { id: 1, kind: "wmo", name: "House.wmo", x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const boxes = wmoGroupBoxes(decoded, placement);
  assert.equal(boxes[0], undefined);
  assert.deepEqual(wmoGroupsInRange(decoded, boxes, { x: 999, y: 999, z: 0, orientation: 0 }), [0]);
});

test("invalid MOLT records stay inert without shifting MOLR ordinals", () => {
  const root = houseRoot([
    { colour: [255, 0, 0], position: [Infinity, 0, 0], intensity: 1, start: 1, end: 2 },
    { colour: [255, 255, 255], position: [0, 0, 1], intensity: 1, start: 1, end: 2 },
  ]);
  const model = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ lightRefs: [1] })], "World\\Buildings\\House.wmo"));
  const encoded = encodeWwm(model, model.textures.map(() => "/wall.png"));
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.equal(decoded.lights.length, 2);
  assert.equal(decoded.lights[0].intensity, 0);
  assert.equal(decoded.lights[1].intensity, 1);
  assert.deepEqual([...decoded.groups[0].mesh.lightRefs], [1]);
  const normals = new Float32Array(decoded.groups[0].mesh.positions.length);
  for (let at = 2; at < normals.length; at += 3) normals[at] = 1;
  const light = wmoVertexLight(decoded.groups[0].mesh, normals, [0, 0, 0], decoded.lights);
  assert.ok(light.every(Number.isFinite));
});

test("a room is lit by the ambient, the colours baked into it and the lamps hung in it", () => {
  // The lamp hangs a yard above the first vertex, holds full strength to a yard and reaches two.
  const root = houseRoot([{ colour: [255, 255, 255], position: [0, 0, 1], intensity: 1, start: 1, end: 2 }]);
  const model = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({
    flags: 0x2000 | 0x04 | 0x200,
    colours: [40, 40, 40, 255, 40, 40, 40, 255, 40, 40, 40, 255, 40, 40, 40, 255],
    lightRefs: [0],
  })], "World\\Buildings\\House.wmo"));
  const encoded = encodeWwm(model, model.textures.map(() => "/wall.png"));
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.deepEqual(decoded.lights, [{
    position: [0, 0, 1], colour: [255, 255, 255], intensity: 1,
    attenuationStart: 1, attenuationEnd: 2, attenuates: true,
  }]);
  assert.deepEqual([...decoded.groups[0].mesh.lightRefs], [0]);

  const mesh = decoded.groups[0].mesh;
  const [lamp] = decoded.lights;
  const normals = new Float32Array(mesh.positions.length);
  // Every vertex turned towards the lamp, so what is left in the difference is distance alone.
  for (let vertex = 0; vertex * 3 < normals.length; vertex++) {
    const towards = [0, 1, 2].map((axis) => lamp.position[axis] - mesh.positions[vertex * 3 + axis]);
    const length = Math.hypot(...towards) || 1;
    for (let axis = 0; axis < 3; axis++) normals[vertex * 3 + axis] = towards[axis] / length;
  }

  const unlit = wmoVertexLight({ ...mesh, lightRefs: new Uint16Array() }, normals, [20, 20, 20], []);
  const lit = wmoVertexLight(mesh, normals, [20, 20, 20], decoded.lights);
  // Baked 40 plus ambient 20 is 60 of 255, in linear terms: the artifact states both, and the
  // renderer adds them rather than choosing between them.
  const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  assert.ok(Math.abs(unlit[0] - linear(60 / 255)) < 1e-6, "ambient and baked colour, converted for a linear pipeline");
  assert.ok(lit[0] > unlit[0], "the lamp on top of them");
  assert.equal(lit[0], 1, "a white lamp a yard from a wall saturates it");
  // The far corner is 1.73 yards away, inside the two-yard reach and past where the falloff starts.
  assert.ok(lit[9] > unlit[9] && lit[9] < 1, "and falls off with distance rather than switching off");

  const far = wmoVertexLight(mesh, normals, [20, 20, 20], [{ ...lamp, attenuationStart: 0.1, attenuationEnd: 0.2 }]);
  assert.equal(far[9], unlit[9], "past its reach a lamp adds nothing at all");
});

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const ORGRIMMAR_HASH = "865d3940372f87744c04e83ea4d32ca0255c860d";
const withOrgrimmar = { skip: existsSync(new URL(`../data/visual-models/${ORGRIMMAR_HASH}.bin`, import.meta.url))
  ? false : "no published Orgrimmar corpus on this machine" };
const clientPath = (name) => name.split("/").join(String.fromCharCode(92));

async function readBuilding(name) {
  const path = clientPath(name);
  const root = await archives.read(path);
  assert.ok(root, `${name} is in the client`);
  const dependencies = wmoDependencies(root, path);
  const groups = [];
  for (const group of dependencies.groups) groups.push(await archives.read(group));
  return wmoGroupMeshes(parseWmoVisual(root, groups, path));
}

/** The payload of one top-level chunk. Tags are stored back to front on disk. */
function topChunk(data, tag) {
  const wanted = [...tag].reverse().join("");
  for (let at = 0; at + 8 <= data.length;) {
    const size = data.readUInt32LE(at + 4);
    if (data.subarray(at, at + 4).toString("ascii") === wanted) return data.subarray(at + 8, at + 8 + size);
    at += 8 + size;
  }
  throw new Error(`${tag} is missing`);
}

/**
 * Every group's name, read where the reference reads it: MOGP opens with a byte offset into the
 * root's MOGN (`wowee/src/pipeline/wmo_loader.cpp:456`, "MOGP starts with groupName(4) +
 * descriptiveName(4) offsets into MOGN").
 *
 * MOGI carries a name offset per group as well and it cannot be used instead. On `ND_Dalaran.wmo`
 * that table is not aligned with the group files: groups 0 and 1 hold −1 in it, the rest are
 * shifted, and it disagrees about the flags too (group 0 is 0x2100 there and 0x2905 in its MOGP).
 * Measured, MOGI names none of the 91 groups the same as MOGP does — it calls `island`
 * `L_hallway_right` and `Vargoth_retreat` `floatingrock_02` — which is how a review of this slice
 * came to describe the ground the city stands on as a rock floating over it.
 */
async function groupNames(name) {
  const path = clientPath(name);
  const root = await archives.read(path);
  const mogn = topChunk(root, "MOGN");
  const names = [];
  for (const groupPath of wmoDependencies(root, path).groups) {
    const at = topChunk(await archives.read(groupPath), "MOGP").readInt32LE(0);
    names.push(mogn.subarray(at, mogn.indexOf(0, at)).toString("ascii"));
  }
  return names;
}

/**
 * The model-space z of the group's topmost vertex. Yards, and up is +z in the WMO's own frame.
 *
 * Walked rather than spread: a group of this model holds more vertices than the engine takes as
 * call arguments, which is why `wmo-visual.mjs` appends its indices one at a time as well.
 */
function highestVertex(positions) {
  let top = -Infinity;
  for (let at = 2; at < positions.length; at += 3) top = Math.max(top, positions[at]);
  return top;
}

/** Square yards of drawn surface in one group: model-space positions are already in yards. */
function drawnArea(group) {
  let total = 0;
  for (let at = 0; at + 3 <= group.indices.length; at += 3) {
    const [a, b, c] = [0, 1, 2].map((corner) => group.indices[at + corner] * 3);
    const u = [0, 1, 2].map((axis) => group.positions[b + axis] - group.positions[a + axis]);
    const v = [0, 1, 2].map((axis) => group.positions[c + axis] - group.positions[a + axis]);
    total += Math.hypot(
      u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return total;
}

async function readPublishedOrgrimmar() {
  const headerData = await readFile(new URL(`../data/visual-models/${ORGRIMMAR_HASH}.bin`, import.meta.url));
  const header = decodeWwm(headerData.buffer.slice(headerData.byteOffset, headerData.byteOffset + headerData.byteLength), "");
  const groups = [];
  for (const [index, group] of header.groups.entries()) {
    const path = new URL(`../data/visual-models/${ORGRIMMAR_HASH}.g${String(index).padStart(3, "0")}.bin`, import.meta.url);
    const data = await readFile(path);
    const block = decodeWwmGroup(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    groups.push({
      flags: group.flags,
      min: [group.bounds.minX, group.bounds.minY, group.bounds.minZ],
      max: [group.bounds.maxX, group.bounds.maxY, group.bounds.maxZ],
      ...block.mesh,
    });
  }
  return { groups, textures: header.textureUrls, ambient: header.ambient, lights: header.lights };
}

test("the three batch counts partition a real building's render list exactly", withClient, async () => {
  // Everything the light depends on rests on this. If the counts did not add up to the batches, the
  // split between them would be a guess, and a quarter of a city would be lit by the wrong rule.
  for (const name of [
    "World/wmo/Azeroth/Buildings/GoldshireInn/GoldshireInn.wmo",
    "World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo",
  ]) {
    const model = await readBuilding(name);
    for (const group of model.groups) {
      const triangles = group.runs.reduce((total, run) => total + run.count / 3, 0);
      assert.equal(triangles, group.indices.length / 3, `${name}: every triangle belongs to exactly one run`);
    }
  }
});

test("the light a wall is drawn in is not the flag on the room it belongs to", withClient, async () => {
  const model = await readBuilding("World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo");
  let indoorGroupsWithExteriorRuns = 0;
  let indoorTrianglesLitOutside = 0;
  let exteriorVertices = 0;
  let whiteExteriorVertices = 0;
  for (const group of model.groups) {
    let exterior = 0;
    for (const run of group.runs) {
      if (run.lighting !== WMO_LIGHT_EXTERIOR) continue;
      exterior += run.count / 3;
      const seen = new Set();
      for (let at = run.start; at < run.start + run.count; at++) {
        const vertex = group.indices[at];
        if (seen.has(vertex)) continue;
        seen.add(vertex);
        exteriorVertices++;
        if (group.colours[vertex * 4] === 255 && group.colours[vertex * 4 + 1] === 255 && group.colours[vertex * 4 + 2] === 255) whiteExteriorVertices++;
      }
    }
    if (group.indoor && exterior > 0) {
      indoorGroupsWithExteriorRuns++;
      indoorTrianglesLitOutside += exterior;
    }
  }
  // A quarter of the city: the outward faces of rooms, which the group flag would light as if they
  // were inside one.
  assert.equal(indoorGroupsWithExteriorRuns, 118);
  assert.equal(indoorTrianglesLitOutside, 175_137);
  // And the baked colours on those runs say nothing, which is why the sun may have them.
  assert.ok(whiteExteriorVertices / exteriorVertices > 0.98, `exterior runs are painted white: ${whiteExteriorVertices} of ${exteriorVertices}`);
});

test("Dalaran marks no exterior batches, so its streets are known only by the group flag", withClient, async () => {
  // The mirror of the test above, and the reason the rule needs both halves. Stormwind's artist
  // put outward faces on exterior batches; Dalaran's put none worth the name, so reading the batch
  // order alone hands the shell of the city and the streets under it to the unlit material.
  const model = await readBuilding("World/wmo/Northrend/Dalaran/ND_Dalaran.wmo");
  let exteriorTriangles = 0;
  let outdoorGroups = 0;
  let outdoorTrianglesLitInside = 0;
  let outdoorVertices = 0;
  let blackOutdoorVertices = 0;
  let area = 0;
  let outdoorArea = 0;
  for (const group of model.groups) {
    const groupArea = drawnArea(group);
    area += groupArea;
    for (const run of group.runs) if (run.lighting === WMO_LIGHT_EXTERIOR) exteriorTriangles += run.count / 3;
    if (group.indoor) continue;
    outdoorGroups++;
    outdoorArea += groupArea;
    const seen = new Set();
    for (const run of group.runs) {
      if (run.lighting === WMO_LIGHT_EXTERIOR) continue;
      outdoorTrianglesLitInside += run.count / 3;
      for (let at = run.start; at < run.start + run.count; at++) {
        const vertex = group.indices[at];
        if (seen.has(vertex)) continue;
        seen.add(vertex);
        outdoorVertices++;
        if (group.colours[vertex * 4] === 0 && group.colours[vertex * 4 + 1] === 0 && group.colours[vertex * 4 + 2] === 0) blackOutdoorVertices++;
      }
    }
  }
  // 336 of 419,562: the whole of what this city's batches offer the sun, and none of it is in the
  // sewers, whose halls are indoor groups carrying no exterior batch at all. It is one pipe and
  // three rocks — `extpipe` at 192 and `floatingrock_01/02/03` at 48 each — named by the test
  // below, which reads the names where the reference does. The 21 groups the flag calls open air
  // carry 161,626 triangles on interior batches, all of them in the 17 that hold any, and that is
  // what the fix moves into the light.
  assert.equal(exteriorTriangles, 336);
  assert.equal(outdoorGroups, 21);
  assert.equal(outdoorTrianglesLitInside, 161_626);
  // And unlike Stormwind's exterior batches, these are not painted white — two thirds are pure
  // black, so drawing them unlit is not "the baked colour is white anyway", it is a black city.
  assert.ok(blackOutdoorVertices / outdoorVertices > 0.66,
    `the streets are painted black: ${blackOutdoorVertices} of ${outdoorVertices}`);
  // Triangles undersell it: the shell is a sparse mesh of huge triangles and the rooms a dense one
  // of small ones. By drawn surface the groups without the flag are four fifths of the model.
  assert.equal(Math.round(outdoorArea), 1_834_426);
  assert.equal(Math.round(area), 2_321_769);
});

test("what stays dark in Dalaran is its rooms, and what moves is the ground under the player", withClient, async () => {
  // The README paragraph for this slice named three groups as flagged indoor and modelled
  // outdoors, and two of them carry no indoor flag at all — one being `island`, the largest thing
  // the change moves into the sun. The names had come from MOGI, which is shifted here. Read from
  // MOGP, they say the opposite, and nothing in the prose about this model may outlive this test.
  const name = "World/wmo/Northrend/Dalaran/ND_Dalaran.wmo";
  const [model, names] = await Promise.all([readBuilding(name), groupNames(name)]);
  assert.equal(names.length, model.groups.length, "one name per group file");

  const groups = model.groups.map((group, index) => ({
    name: names[index],
    indoor: group.indoor,
    area: drawnArea(group),
    exterior: group.runs.filter((run) => run.lighting === WMO_LIGHT_EXTERIOR).reduce((total, run) => total + run.count / 3, 0),
    interior: group.runs.filter((run) => run.lighting !== WMO_LIGHT_EXTERIOR).reduce((total, run) => total + run.count / 3, 0),
    top: highestVertex(group.positions),
  }));

  // Seventy of the ninety-one keep the unlit material, and every one is a room: shops, inns, the
  // sewer halls, and the two chambers at the top of the model. No street and no shell among them.
  const indoors = groups.filter((group) => group.indoor).map((group) => group.name);
  assert.equal(indoors.length, 70);
  for (const room of ["Vargoth_retreat", "Purple_parlor", "fake_pipe", "exitPipe", "shadeyDealer", "bankinterior"]) {
    assert.ok(indoors.includes(room), `${room} is a room and keeps the light the artist baked`);
  }
  assert.equal(indoors.filter((room) => room.startsWith("shop")).length, 18);
  assert.ok(!indoors.includes("island"), "the ground the city stands on carries no indoor flag");
  assert.equal(indoors.filter((room) => room.startsWith("floatingrock")).length, 0,
    "and neither do the rocks, which hang under the city rather than over it");
  for (const rock of groups.filter((group) => group.name.startsWith("floatingrock"))) {
    assert.ok(rock.top < 0, `${rock.name} tops out at z ${rock.top.toFixed(1)}`);
  }
  // The 4,257 triangles "at z 223 to 260" that the prose hung on a floating rock are this room.
  assert.equal(Math.round(groups.find((group) => group.name === "Vargoth_retreat").top), 260);

  // The 336 triangles the batches offer the sun are one pipe and three rocks. Naming the sewers
  // sends the next reader looking for them in groups that hold no exterior batch whatever.
  assert.deepEqual(groups.filter((group) => group.exterior > 0).map((group) => `${group.name}:${group.exterior}`).sort(),
    ["extpipe:192", "floatingrock_01:48", "floatingrock_02:48", "floatingrock_03:48"]);

  // And what the change actually moves is the city by name, `island` first and largest: half of
  // it. The four above are the difference between this and the 1,834,426 of all 21 groups — they
  // hold no interior batch, so they were drawn by the scene before this slice as well as after.
  const moved = groups.filter((group) => !group.indoor && group.interior > 0);
  assert.equal(moved.length, 17);
  assert.equal(Math.round(moved.reduce((total, group) => total + group.area, 0)), 1_765_218);
  const largest = moved.reduce((best, group) => (group.area > best.area ? group : best));
  assert.equal(largest.name, "island");
  assert.equal(Math.round(largest.area), 906_780);
});

test("a tavern publishes whole and a city publishes its rooms", withClient, async () => {
  const inn = await readBuilding("World/wmo/Azeroth/Buildings/GoldshireInn/GoldshireInn.wmo");
  const innTriangles = inn.groups.reduce((total, group) => total + group.indices.length / 3, 0);
  assert.ok(innTriangles < WWM_TRIANGLE_BUDGET, `the inn is ${innTriangles} triangles and travels whole`);

  const city = await readBuilding("World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo");
  const cityTriangles = city.groups.reduce((total, group) => total + group.indices.length / 3, 0);
  assert.ok(cityTriangles > WWM_TRIANGLE_BUDGET * 10, `the city is ${cityTriangles} triangles and cannot`);

  const urls = city.textures.map((_texture, index) => `/visual/texture/x-${index}.png`);
  const header = encodeWwm(city, urls, new Set());
  // 286 boxes, 157 texture names, 606 lamps and the complete 319-polygon portal graph: what a
  // browser is asked to take on faith before it knows which rooms it wants. The model is 26 MB.
  assert.ok(header.length < 60_000, `the header alone is ${header.length} bytes`);
  const decoded = decodeWwm(header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength), "");
  assert.equal(decoded.groups.length, 286);
  assert.equal(decoded.lights.length, 606);
  assert.deepEqual(decoded.ambient, [33, 33, 33]);
  assert.equal(decoded.portals.definitions.length, 319);
  assert.equal(decoded.portals.references.length, 627);
  assert.equal(decoded.groups.filter((group) => group.portalCount === 0).length, 14,
    "rooms with no portal evidence stay identifiable for the conservative fallback");

  // Every room can be asked for on its own, and what arrives is what the table promised.
  for (const index of [0, 42, 171, 285]) {
    const block = encodeWwmGroup(city.groups[index], index);
    const room = decodeWwmGroup(block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength));
    assert.equal(room.index, index);
    assert.equal(room.mesh.positions.length / 3, decoded.groups[index].vertexCount);
    assert.equal(room.mesh.indices.length / 3, decoded.groups[index].triangleCount);
  }
});

test("standing in a district of Stormwind, the rule asks for the rooms around the player", withClient, async () => {
  const adt = await archives.read(clientPath("World/Maps/Azeroth/Azeroth_31_48.adt"));
  const placement = parseAdtPlacements(adt).find((object) => object.kind === "wmo" && /Stormwind[.]wmo$/i.test(object.name));
  assert.ok(placement, "the city is placed by the tile that names it");

  const city = await readBuilding("World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo");
  const header = encodeWwm(city, city.textures.map(() => ""), new Set());
  const model = decodeWwm(header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength), "");
  const boxes = wmoGroupBoxes(model, placement);
  const placed = placeEnvironmentNode(new THREE.Group(), placement);
  placed.updateMatrixWorld(true);
  const worldToModel = placed.matrixWorld.clone().multiply(VMAP_TO_THREE).invert();
  const triangles = (chosen) => chosen.reduce((total, index) => total + model.groups[index].triangleCount, 0);
  const whole = model.groups.reduce((total, group) => total + group.triangleCount, 0);

  // Measured, not chosen: exterior- or transition-lit runs inside an indoor group use the city's
  // 250 yd leash too, while groups remain bounded by their own AABB. Before the boundary marker,
  // only the outdoor shell used that leash and the rooms below were the smaller 60 yd set. Shell
  // groups wide enough to read as skyline (120 yd diagonal) hold a second 750 yd leash on top,
  // so the districts below also carry the far roofs — still below two thirds of this city's
  // triangles in every measured district, and never approaching the full 286-group city.
  for (const [name, x, y, groups, wanted] of [
    ["Trade District", -8831, 619, 116, 349_391],
    ["Old Town", -8721, 386, 86, 317_675],
    ["Mage Quarter", -8995, 864, 79, 343_146],
    ["Cathedral Square", -8603, 789, 106, 339_936],
    ["Dwarven District", -8427, 599, 82, 344_721],
  ]) {
    const chosen = wmoGroupsInRange(model, boxes, { x, y, z: 100, orientation: 0 });
    assert.equal(chosen.length, groups, `${name}: rooms drawn`);
    assert.equal(triangles(chosen), wanted, `${name}: triangles`);
    assert.ok(triangles(chosen) / whole < 0.65, `${name}: the group-AABB budget is bounded`);
    const cameraModel = new THREE.Vector3(x, 100, -y).applyMatrix4(worldToModel);
    const portal = selectWmoPortalGroups(
      model.groups, model.portals, chosen, cameraModel, new THREE.Matrix4().identity().elements);
    assert.equal(portal.used, false, `${name}: a known open-air point cannot seed portal culling`);
    assert.strictEqual(portal.groups, chosen, `${name}: open air keeps the exact distance candidate set`);
  }

  // And from outside it is the shell and nothing else: the skyline without any of its rooms.
  // The far leash puts 25 wide outdoor shells on the ridge instead of one — that is the LOD
  // working, measured at 248,547 triangles against the 20,639 of the single 250 yd shell.
  const ridge = wmoGroupsInRange(model, boxes, { x: -9250, y: 200, z: 100, orientation: 0 });
  assert.equal(ridge.length, 25);
  assert.equal(triangles(ridge), 248_547);
  assert.ok(ridge.every((index) => model.groups[index].exterior || !model.groups[index].indoor),
    "and what is left is the outside of the city");
});

test("outdoor shell leash follows group width, rooms stay short", () => {
  const box = (size) => new THREE.Box3(
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(size, size, size));
  // Diagonal 103.9 yd: below the skyline width, the near leash.
  assert.equal(wmoShellRange(box(60)), 250);
  // Diagonal 207.8 yd: skyline, the far leash.
  assert.equal(wmoShellRange(box(120)), 750);
  const malformed = new THREE.Box3(new THREE.Vector3(5, 0, 0), new THREE.Vector3(0, 1, 1));
  assert.equal(wmoShellRange(malformed), 250, "an inverted box fails closed to the near leash");
  const nan = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Number.NaN, 1, 1));
  assert.equal(wmoShellRange(nan), 250, "a NaN box fails closed to the near leash");
});

test("Stormwind high MOGP flags survive WWM1 metadata", withClient, async () => {
  const city = await readBuilding("World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo");
  assert.equal(city.groups[283].flags >>> 0, 0x8020180d);
  assert.equal(city.groups[285].flags >>> 0, 0x8020080d);
  assert.ok(city.groups[283].runs.every((run) => run.lighting !== WMO_LIGHT_EXTERIOR));
  assert.ok(city.groups[285].runs.every((run) => run.lighting !== WMO_LIGHT_EXTERIOR));
  const header = encodeWwm(city, city.textures.map(() => ""), new Set());
  const model = decodeWwm(header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength), "");
  assert.equal(model.groups[283].flags >>> 0, 0x8020180d);
  assert.equal(model.groups[285].flags >>> 0, 0x8020080d);
  assert.equal(model.groups[283].exterior, false);
  assert.equal(model.groups[285].exterior, false);
});

test("Orgrimmar keeps its exterior-lit shell in the WWM header", withOrgrimmar, async () => {
  const source = await readPublishedOrgrimmar();
  const encoded = encodeWwm(source, source.textures.map(() => ""), new Set());
  const model = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.equal(model.groups.length, 144);
  assert.equal(model.groups.filter((group) => group.indoor).length, 142);
  const exterior = model.groups.filter((group) => group.exterior);
  const indoorExterior = exterior.filter((group) => group.indoor);
  assert.equal(exterior.length, 57, "the real city has a per-group boundary marker");
  assert.equal(indoorExterior.length, 55, "indoor exterior/transition shell groups are not discarded");
  assert.ok(exterior.length < model.groups.length, "the flag is per-group, not whole-WMO");
  assert.equal(source.groups.reduce((total, group) => total + group.indices.length / 3, 0), 338_444);
  assert.equal(model.groups.reduce((total, group) => total + group.triangleCount, 0), 338_444);
});

/** One MFOG record, spelled the way `houseRoot` writes it. */
function fogRecord({ flags = 0, position = [0, 0, 0], innerRadius = 0, outerRadius = 0,
  end = 100, scale = 0.25, colour = [10, 20, 30], water } = {}) {
  return {
    flags, position, innerRadius, outerRadius,
    land: { end, scale, colour },
    water: water ?? { end: 222.2222, scale: -1, colour: [0, 0, 255] },
  };
}

/** Publish a parsed model and hand back what `decodeWwm` takes, which is how the browser gets it. */
function roundTrip(model) {
  const encoded = encodeWwm(model, model.textures.map(() => ""), new Set());
  return [encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), ""];
}

test("a building's own fog travels in the artifact, and its groups say which record they stand in", () => {
  // MFOG was read by nothing in this repository, so a tavern was drawn in whatever fog the sky
  // outside says the zone has. Two records here: one a small sphere, one unbounded.
  const local = fogRecord({ position: [10, 0, 0], innerRadius: 2, outerRadius: 5, end: 100, colour: [250, 216, 144] });
  const whole = fogRecord({ flags: WMO_FOG_UNBOUNDED, end: 83.5, colour: [253, 207, 158] });
  const root = houseRoot([], 2, [local, whole]);
  const model = wmoGroupMeshes(parseWmoVisual(root, [
    houseGroup({ flags: 0x2000, fogIds: [0] }),
    houseGroup({ flags: 0x2000, fogIds: [1] }),
  ], "World\\Buildings\\House.wmo"));
  assert.equal(model.fogs.length, 2);
  assert.equal(model.fogs[0].outerRadius, 5);
  assert.deepEqual(model.fogs[0].land.colour, [250, 216, 144]);
  assert.equal(model.fogs[1].flags & WMO_FOG_UNBOUNDED, WMO_FOG_UNBOUNDED);
  assert.deepEqual(model.groups.map((group) => group.fogIds), [[0, 0, 0, 0], [1, 0, 0, 0]]);

  const encoded = encodeWwm(model, model.textures.map(() => ""), new Set());
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.deepEqual(decoded.fogs, model.fogs, "every field of every record survives the round trip");
  // The second group's three empty bytes are padding and not three more references to record 0 —
  // the corpus rule the decoder cites, and the reason the next test can tell the two apart.
  assert.deepEqual(decoded.groups.map((group) => group.fogIds), [[0], [1]]);

  // The sphere holds a camera inside it and nothing outside it — the reason the flag exists.
  assert.equal(wmoFogAt(decoded, decoded.groups[0], 10, 0, 0)?.land.end, 100);
  assert.equal(wmoFogAt(decoded, decoded.groups[0], 20, 0, 0), undefined);
  assert.equal(wmoFogAt(decoded, decoded.groups[1], 900, 900, 900)?.land.end, 83.5);
  assert.equal(wmoFogAt(decoded, undefined, 0, 0, 0), undefined);
});

test("a zero in a slot past the first is padding, and never a reference to record 0", () => {
  // The shape 1,230 groups of the corpus arrive in — one index, then three zero bytes — and the
  // two ways reading those zeros as references went wrong on real buildings.
  //
  // Ironforge: 65 of its 104 groups carry 1,0,0,0, and its record 0 is a 305.56-yard sphere while
  // record 1 is a 164.97-yard one inside it. On the 29 groups the wider sphere covers and the
  // named one does not, the phantom reference put fog in a hall whose file asks for none.
  const wide = fogRecord({ position: [-299, 0.63, 0], innerRadius: 263.89, outerRadius: 305.56,
    end: 805.5556, colour: [0x61, 0x8d, 0xcf] });
  const inner = fogRecord({ position: [-320.28, 0.63, 0], innerRadius: 108.61, outerRadius: 164.97,
    end: 805.5556, colour: [0xe7, 0x85, 0x43] });
  const hall = wmoGroupMeshes(parseWmoVisual(houseRoot([], 1, [wide, inner]),
    [houseGroup({ fogIds: [1] })], "World\\Buildings\\House.wmo"));
  assert.deepEqual(hall.groups[0].fogIds, [1, 0, 0, 0], "the group file's four bytes, as they stand");
  const ironforge = decodeWwm(...roundTrip(hall));
  assert.deepEqual(ironforge.groups[0].fogIds, [1], "and the artifact names only what the file named");
  // 199.0 yards from record 0's centre and 220.3 from record 1's: inside the wider, outside the
  // named one — which is where 29 of the 65 sit.
  assert.equal(wmoFogAt(ironforge, ironforge.groups[0], -100, 0.63, 0), undefined,
    "record 1 does not reach the point, and record 0 was never named");

  // Stratholme: groups 62 and 63 carry 5,0,0,0, and record 0 is the tighter of the two spheres
  // over them — so the phantom did not merely add a fog, it outranked the one the file names.
  const named = fogRecord({ position: [0, 0, 0], outerRadius: 277.7778, end: 194.4444, colour: [0x68, 0x37, 0x28] });
  const tighter = fogRecord({ position: [0, 0, 0], outerRadius: 83.3333, end: 333.3333, colour: [0x4a, 0x38, 0x5d] });
  const raid = wmoGroupMeshes(parseWmoVisual(houseRoot([], 1, [tighter, named]),
    [houseGroup({ fogIds: [1] })], "World\\Buildings\\House.wmo"));
  const stratholme = decodeWwm(...roundTrip(raid));
  assert.deepEqual(stratholme.groups[0].fogIds, [1]);
  const fog = wmoFogAt(stratholme, stratholme.groups[0], 0, 0, 0);
  assert.ok(Math.abs(fog.land.end - 194.4444) < 1e-3, `the record the file names, got ${fog?.land.end}`);
  assert.deepEqual(fog.land.colour, [0x68, 0x37, 0x28]);

  // Slot 0 still means what it says: a group that stands in record 0 names it there, and that is
  // the only place a zero is a reference — no group of the 9,346 leaves slot 0 empty and fills a
  // later one, so there is no shape in which this rule loses a reference.
  const first = wmoGroupMeshes(parseWmoVisual(houseRoot([], 1, [wide, inner]),
    [houseGroup({ fogIds: [0] })], "World\\Buildings\\House.wmo"));
  const kept = decodeWwm(...roundTrip(first));
  assert.deepEqual(kept.groups[0].fogIds, [0]);
  const held = wmoFogAt(kept, kept.groups[0], -299, 0.63, 0);
  assert.ok(Math.abs(held.land.end - 805.5556) < 1e-3, `expected 805.56 yards, got ${held?.land.end}`);
});

test("a group in two fogs takes the tighter one, and the unbounded one beats both", () => {
  // Stormwind is the real case: `magic05`, `ThroneRoom05` and `TreeFacades02` each name records 1
  // and 2, two 40.14/51.19-yard spheres 32.91 yards apart, and only their radii say which.
  const wide = fogRecord({ position: [0, 0, 0], outerRadius: 60, end: 300 });
  const tight = fogRecord({ position: [0, 0, 0], outerRadius: 20, end: 120 });
  const everywhere = fogRecord({ flags: WMO_FOG_UNBOUNDED, end: 44 });
  const root = houseRoot([], 1, [wide, tight, everywhere]);
  const model = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ fogIds: [0, 1] })], "World\\Buildings\\House.wmo"));
  const encoded = encodeWwm(model, model.textures.map(() => ""), new Set());
  const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  assert.deepEqual(decoded.groups[0].fogIds, [0, 1], "and the two empty slots are not a third reference to 0");
  assert.equal(wmoFogAt(decoded, decoded.groups[0], 0, 0, 0)?.land.end, 120, "both reach it, the tighter wins");
  assert.equal(wmoFogAt(decoded, decoded.groups[0], 30, 0, 0)?.land.end, 300, "past the tighter one, the wider");
  assert.equal(wmoFogAt(decoded, decoded.groups[0], 90, 0, 0), undefined, "past both, the sky outside");

  const unbounded = wmoGroupMeshes(parseWmoVisual(
    houseRoot([], 1, [wide, tight, everywhere]),
    [houseGroup({ fogIds: [0, 1, 2] })], "World\\Buildings\\House.wmo"));
  const flat = encodeWwm(unbounded, unbounded.textures.map(() => ""), new Set());
  const read = decodeWwm(flat.buffer.slice(flat.byteOffset, flat.byteOffset + flat.byteLength), "");
  assert.equal(wmoFogAt(read, read.groups[0], 0, 0, 0)?.land.end, 44, "no radius means it holds regardless");
});

test("renderable MFOG ignores the white land sentinel and never falls through to its water half", () => {
  const record = (land, water = { end: 40, scale: -1, colour: [2, 3, 4] }) => ({
    flags: WMO_FOG_UNBOUNDED,
    position: [0, 0, 0],
    innerRadius: 0,
    outerRadius: 0,
    land,
    water,
  });
  assert.equal(wmoLandFogActive(record({ end: 444, scale: 0.25, colour: [255, 255, 255] })), false,
    "pure white is MFOG's neutral/no-override sentinel");
  assert.equal(wmoLandFogActive(record({ end: 83.3333, scale: 0.25, colour: [0xfd, 0xcf, 0x9e] })), true);
  assert.equal(wmoLandFogActive(record({ end: 83.3333, scale: -0.25, colour: [0xfd, 0xcf, 0x9e] })), false);

  const model = {
    fogs: [
      record({ end: 444, scale: 0.25, colour: [255, 255, 255] }),
      record({ end: 83.3333, scale: 0.25, colour: [0xfd, 0xcf, 0x9e] }),
    ],
  };
  assert.deepEqual(wmoLandFogAt(model, { fogIds: [0, 1] }, 0, 0, 0)?.land.colour, [0xfd, 0xcf, 0x9e],
    "a white unbounded record must not mask the group's authored land fog");
});

test("an artifact from before the fog section decodes with no fog rather than a wrong one", () => {
  // The same rule the portal graph gets: optional metadata never makes valid geometry unusable.
  // A v14 artifact is a v15 artifact with the WME3 section absent, and it has to keep its portals.
  const root = houseRoot([], 1, [fogRecord({ flags: WMO_FOG_UNBOUNDED, end: 70 })]);
  const model = wmoGroupMeshes(parseWmoVisual(root, [houseGroup({ fogIds: [0] })], "World\\Buildings\\House.wmo"));
  const encoded = encodeWwm(model, model.textures.map(() => ""), new Set());
  const legacy = Buffer.from(encoded);
  const at = legacy.indexOf(Buffer.from("WME3", "ascii"));
  assert.ok(at > 0, "the section is there to be blanked");
  legacy.write("WMEX", at, "ascii");
  const decoded = decodeWwm(legacy.buffer.slice(legacy.byteOffset, legacy.byteOffset + legacy.byteLength), "");
  assert.deepEqual(decoded.fogs, []);
  assert.deepEqual(decoded.groups[0].fogIds, []);
  assert.equal(wmoFogAt(decoded, decoded.groups[0], 0, 0, 0), undefined);
  assert.equal(decoded.groups[0].triangleCount, model.groups[0].indices.length / 3, "and the geometry is untouched");

  // A model whose MFOG is missing entirely publishes an empty table, not a broken one.
  const bare = wmoGroupMeshes(parseWmoVisual(houseRoot(), [houseGroup()], "World\\Buildings\\House.wmo"));
  assert.deepEqual(bare.fogs, []);
  const plain = encodeWwm(bare, bare.textures.map(() => ""), new Set());
  const read = decodeWwm(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength), "");
  assert.deepEqual(read.fogs, []);
  assert.deepEqual(read.groups[0].fogIds, []);
});

test("the fog three real buildings carry is the fog their artifacts publish", withClient, async () => {
  // The numbers are the files'. Goldshire's second record is the one with the "no radius" flag,
  // which is why walking into the inn changes the fog at all; its first is a 3.36-yard sphere
  // standing at (23.17, 8.37, 2.83), which is inside none of the building's twelve group boxes.
  const inn = await readBuilding("World/wmo/Azeroth/Buildings/GoldshireInn/GoldshireInn.wmo");
  assert.equal(inn.fogs.length, 2);
  assert.ok(Math.abs(inn.fogs[0].land.end - 194.4444) < 1e-3, `expected 194.44 yards, got ${inn.fogs[0].land.end}`);
  assert.deepEqual(inn.fogs[0].land.colour, [0xfa, 0xd8, 0x90]);
  assert.equal(inn.fogs[0].flags & WMO_FOG_UNBOUNDED, 0);
  assert.ok(Math.abs(inn.fogs[1].land.end - 83.3333) < 1e-3, `expected 83.33 yards, got ${inn.fogs[1].land.end}`);
  assert.deepEqual(inn.fogs[1].land.colour, [0xfd, 0xcf, 0x9e]);
  assert.equal(inn.fogs[1].flags & WMO_FOG_UNBOUNDED, WMO_FOG_UNBOUNDED);
  assert.equal(inn.groups.filter((group) => group.fogIds[0] === 1).length, 6, "half the inn's twelve groups");

  const city = await readBuilding("World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo");
  assert.equal(city.fogs.length, 3);
  assert.ok(Math.abs(city.fogs[0].land.end - 444.4445) < 1e-3);
  assert.deepEqual(city.fogs[0].land.colour, [0xff, 0xff, 0xff], "white, which changes nothing");
  for (const index of [1, 2]) {
    assert.ok(Math.abs(city.fogs[index].land.end - 333.3333) < 1e-3);
    assert.deepEqual(city.fogs[index].land.colour, [0x70, 0xca, 0xf4], "and the two local ones are teal");
    assert.ok(Math.abs(city.fogs[index].innerRadius - 40.14) < 0.01);
    assert.ok(Math.abs(city.fogs[index].outerRadius - 51.19) < 0.01);
  }
  // Three groups name both spheres — `magic05`, `ThroneRoom05` and `TreeFacades02`, read out of
  // their own MOGN names. Which of the two a player is in is a question of radius and nothing else.
  assert.equal(city.groups.filter((group) => group.fogIds[1] !== 0).length, 3);

  const dalaran = await readBuilding("World/wmo/Northrend/Dalaran/ND_Dalaran.wmo");
  assert.equal(dalaran.fogs.length, 2);
  assert.ok(Math.abs(dalaran.fogs[0].land.end - 222.2222) < 1e-3);
  assert.deepEqual(dalaran.fogs[0].land.colour, [0x75, 0x93, 0xa8]);
  assert.ok(Math.abs(dalaran.fogs[1].land.end - 444.4445) < 1e-3);
  assert.deepEqual(dalaran.fogs[1].land.colour, [0xff, 0xff, 0xff]);

  // What the whole section costs, which is what the reader pays: a 16-byte header, four bytes a
  // group, 48 a record. `header` is the artifact with the section written; `before` is the header
  // it would have without it. The records alone are the smaller half — 96 bytes and 144.
  const priced = [[inn, { header: 1_812, before: 1_652 }], [city, { header: 54_264, before: 52_960 }],
    [dalaran, undefined]];
  for (const [model, price] of priced) {
    const encoded = encodeWwm(model, model.textures.map(() => ""), new Set());
    const decoded = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
    assert.deepEqual(decoded.fogs, model.fogs, "the round trip keeps every record");
    assert.deepEqual(
      decoded.groups.map((group) => group.fogIds),
      model.groups.map((group) => [...new Set(group.fogIds
        .filter((id, slot) => (slot === 0 || id !== 0) && id < model.fogs.length))]),
      "and keeps every group's reference to them, and no reference the file did not make");
    const without = encodeWwm({ ...model, fogs: [] }, model.textures.map(() => ""), new Set());
    assert.equal(encoded.length - without.length, model.fogs.length * 48, "the records themselves");
    if (!price) continue;
    const section = 16 + model.groups.length * 4 + model.fogs.length * 48;
    assert.equal(encoded.length, price.header);
    assert.equal(encoded.length - section, price.before, "and the header this slice started from");
  }
});

test("standing inside the Goldshire Inn is the record with no radius, and outside it is nothing", withClient, async () => {
  // The point of the whole chunk, on the one building the plan named. Six of the inn's twelve
  // groups name the unbounded record — `hall`, `entry`, `exterior02`, `commonroom`, `room02` and
  // `exterior`, read out of MOGN where the reference reads it (`wowee/src/pipeline/
  // wmo_loader.cpp:456`) — and at the centre of each of their own boxes that is what the camera is
  // in. The other six — `upstairs`, `kitchen`, `room01`, `room03`, `room04` and `cellar` — name
  // record 0, a 3.36-yard sphere at (23.17, 8.37, 2.83), and every one of them is outside it.
  const inn = await readBuilding("World/wmo/Azeroth/Buildings/GoldshireInn/GoldshireInn.wmo");
  const encoded = encodeWwm(inn, inn.textures.map(() => ""), new Set());
  const model = decodeWwm(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), "");
  let indoors = 0;
  let outdoors = 0;
  for (const group of model.groups) {
    const fog = wmoFogAt(model, group,
      (group.bounds.minX + group.bounds.maxX) / 2,
      (group.bounds.minY + group.bounds.maxY) / 2,
      (group.bounds.minZ + group.bounds.maxZ) / 2);
    if (fog === undefined) outdoors++;
    else {
      indoors++;
      assert.ok(Math.abs(fog.land.end - 83.3333) < 1e-3);
      assert.deepEqual(fog.land.colour, [0xfd, 0xcf, 0x9e]);
    }
  }
  assert.equal(indoors, 6);
  assert.equal(outdoors, 6);

  // Why those six are outside: record 0's centre lies in none of the twelve boxes, so no group
  // that names it can stand in it — the sphere is 3.36 yards wide and the nearest box in x,
  // `exterior`, runs from −6.80 to 1.57 in y while the record sits at 8.37. Asking at the record's
  // own centre instead would say "in it" for any group at all and prove nothing, so the question
  // is put where a player can be: inside the box of a group that names the record.
  const centre = model.fogs[0].position;
  const boxes = model.groups.map((group) => group.bounds);
  assert.equal(boxes.filter((box) => centre[0] >= box.minX && centre[0] <= box.maxX
    && centre[1] >= box.minY && centre[1] <= box.maxY
    && centre[2] >= box.minZ && centre[2] <= box.maxZ).length, 0);
  const named = model.groups.filter((group) => group.fogIds.includes(0));
  assert.equal(named.length, 6, "the six that name it");
  for (const group of named) {
    for (const [x, y, z] of [
      [(group.bounds.minX + group.bounds.maxX) / 2, (group.bounds.minY + group.bounds.maxY) / 2,
        (group.bounds.minZ + group.bounds.maxZ) / 2],
      [group.bounds.minX, group.bounds.minY, group.bounds.minZ],
      [group.bounds.maxX, group.bounds.maxY, group.bounds.maxZ],
    ]) {
      assert.equal(wmoFogAt(model, group, x, y, z), undefined,
        `record 0 does not reach (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
  // And it is not that the record is unreachable in principle: put the camera in it and it holds.
  assert.equal(wmoFogAt(model, named[0], centre[0], centre[1], centre[2])?.land.end, model.fogs[0].land.end);
});
