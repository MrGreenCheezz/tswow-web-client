import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  parseWmoVisual,
  wmoGroupMeshes,
} from "../tools/wmo-visual.mjs";
import { encodeWwm, encodeWwmGroup } from "../tools/wwm.mjs";
import { buildWmoGroupGeometry } from "../dist/code/browser/WmoGeometry.js";
import {
  decodeWwm,
  decodeWwmGroup,
  wmoVertexLight,
} from "../dist/code/browser/WmoModel.js";
import {
  ADT_MODEL_TO_SCENE,
} from "../dist/code/browser/WorldRenderer3D.js";
import { decodeVisualModel } from "../dist/code/browser/Terrain.js";
import { visualModelCacheNamespace } from "../dist/code/gateway/Gateway.js";

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function floatBuffer(values) {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeFloatLE(value, index * 4));
  return data;
}

const MODEL_PATH = "World\\Wmo\\HardEdge.wmo";
const POSITIONS = [
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  0, 0, 0, 1, 0, 0, 0, 1, 0,
];
const AUTHORED_NORMALS = [
  0, 0, 1, 0, 0, 1, 0, 0, 1,
  0, 0, -1, 0, 0, -1, 0, 0, -1,
];

function rootWmo() {
  const mohd = Buffer.alloc(64);
  mohd.writeUInt32LE(1, 4);
  const names = Buffer.from("World\\Textures\\HardEdge.blp\0");
  const materials = Buffer.alloc(64);
  materials.writeUInt32LE(0, 12);
  return Buffer.concat([
    chunk("MOHD", mohd),
    chunk("MOTX", names),
    chunk("MOMT", materials),
  ]);
}

function groupWmo({ normals = "valid" } = {}) {
  const header = Buffer.alloc(68);
  header.writeUInt32LE(0, 8);
  [-1, -1, -1, 2, 2, 2].forEach((value, index) => header.writeFloatLE(value, 12 + index * 4));
  header.writeUInt16LE(1, 0x2c);

  const vertices = floatBuffer(POSITIONS);
  const uvs = floatBuffer([
    0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 0, 1,
  ]);
  const indices = Buffer.alloc(12);
  [0, 1, 2, 3, 4, 5].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const batches = Buffer.alloc(24);
  batches.writeUInt32LE(0, 12);
  batches.writeUInt16LE(6, 16);
  batches.writeUInt8(0, 23);
  const lightRefs = Buffer.alloc(2);
  lightRefs.writeUInt16LE(0, 0);
  const colours = Buffer.alloc((POSITIONS.length / 3) * 4);
  for (let i = 3; i < colours.length; i += 4) colours[i] = 255;

  const parts = [header, chunk("MOVT", vertices)];
  if (normals === "valid") parts.push(chunk("MONR", floatBuffer(AUTHORED_NORMALS)));
  else if (normals instanceof Buffer) parts.push(chunk("MONR", normals));
  parts.push(
    chunk("MOCV", colours),
    chunk("MOTV", uvs),
    chunk("MOVI", indices),
    chunk("MOBA", batches),
    chunk("MOLR", lightRefs),
  );
  return chunk("MOGP", Buffer.concat(parts));
}

function parseFixture(options = {}) {
  return parseWmoVisual(rootWmo(), [groupWmo(options)], MODEL_PATH);
}

function toArrayBuffer(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function noNormalsModel(model) {
  return {
    ...model,
    groups: model.groups.map(({ normals: _normals, ...group }) => group),
  };
}

function directLightingMesh() {
  return {
    positions: new Float32Array([0, 0, 0]),
    colours: new Uint8Array([0, 0, 0, 255]),
    lightRefs: new Uint16Array([0, 1]),
  };
}

function directLightingNormal() {
  return new Float32Array([0, 0, 1]);
}

function directLightingLamp() {
  return {
    position: [0, 0, 1], colour: [255, 255, 255], intensity: 1,
    attenuationStart: 0, attenuationEnd: 10, attenuates: false,
  };
}

function encodeModel(model) {
  return encodeWwm(model, model.textures.map(() => "/hard-edge.blp"));
}

function decodeModel(bytes) {
  return decodeWwm(toArrayBuffer(bytes), "http://gateway");
}

test("MOGP MONR parses exact hard-edge normals and feeds authored lighting", () => {
  const parsed = parseFixture();
  assert.deepEqual([...parsed.normals], AUTHORED_NORMALS);
  const model = wmoGroupMeshes(parsed);
  const mesh = model.groups[0].mesh ?? model.groups[0];
  assert.deepEqual([...mesh.normals], AUTHORED_NORMALS);
  assert.deepEqual([...mesh.positions.slice(0, 3)], [...mesh.positions.slice(9, 12)],
    "the fixture deliberately duplicates positions at a hard edge");
  assert.notDeepEqual([...mesh.normals.slice(0, 3)], [...mesh.normals.slice(9, 12)]);

  const light = wmoVertexLight(mesh, mesh.normals, [0, 0, 0], [{
    position: [0, 0, 10],
    colour: [255, 255, 255],
    intensity: 1,
    attenuationStart: 0,
    attenuationEnd: 100,
    attenuates: false,
  }]);
  assert.ok(light[0] > light[9], "opposite authored normals must produce different diffuse light");
});

test("missing, malformed, and nonfinite MONR remain absent with a valid fallback", () => {
  const variants = [
    ["missing", { normals: "missing" }],
    ["wrong length", { normals: Buffer.alloc(AUTHORED_NORMALS.length * 4 - 4) }],
    ["nonfinite", { normals: (() => {
      const data = floatBuffer(AUTHORED_NORMALS);
      data.writeFloatLE(Number.NaN, 0);
      return data;
    })() }],
  ];
  for (const [label, options] of variants) {
    const parsed = parseFixture(options);
    assert.equal(parsed.normals, undefined, `${label} MONR must not publish partial normals`);
    const model = wmoGroupMeshes(parsed);
    const mesh = model.groups[0].mesh ?? model.groups[0];
    assert.equal(mesh.normals, undefined, `${label} group must use the normal fallback`);
    const decoded = decodeModel(encodeModel(model));
    assert.equal(decoded.groups[0].mesh?.normals, undefined,
      `${label} fallback must stay compatible with the old WWM1 wire`);
  }
});

test("WWM2 whole and standalone blocks preserve normals while old WWM1 stays normal-less", () => {
  const model = wmoGroupMeshes(parseFixture());
  const encoded = encodeModel(model);
  assert.equal(encoded.subarray(0, 4).toString("ascii"), "WWM2");
  const block = encodeWwmGroup(model.groups[0], 0);
  assert.equal(block[11] & 1, 1, "WWM2 block flag bit 0 announces authored normals");

  const whole = decodeModel(encoded);
  assert.deepEqual([...whole.groups[0].mesh.normals], AUTHORED_NORMALS);
  const standalone = decodeWwmGroup(toArrayBuffer(block));
  assert.deepEqual([...standalone.mesh.normals], AUTHORED_NORMALS);

  const legacy = noNormalsModel(model);
  assert.equal(legacy.groups[0].normals, undefined);
  const oldBytes = encodeModel(legacy);
  assert.equal(oldBytes.subarray(0, 4).toString("ascii"), "WWM1");
  const oldWhole = decodeModel(oldBytes);
  assert.equal(oldWhole.groups[0].mesh?.normals, undefined);
  const oldBlock = encodeWwmGroup(legacy.groups[0], 0);
  assert.equal(oldBlock[11], 0, "legacy WWM1 block keeps its reserved byte zero");
  assert.equal(decodeWwmGroup(toArrayBuffer(oldBlock)).mesh.normals, undefined);
});

test("WWM2 rejects unknown flags, truncation, overflow, and wrong-length streams", () => {
  const model = wmoGroupMeshes(parseFixture());
  const whole = encodeModel(model);
  const block = encodeWwmGroup(model.groups[0], 0);

  const unknownFlags = Buffer.from(block);
  unknownFlags[11] |= 0x80;
  assert.throws(() => decodeWwmGroup(toArrayBuffer(unknownFlags)));

  assert.throws(() => decodeWwmGroup(toArrayBuffer(block.subarray(0, block.length - 1))));

  const overflow = Buffer.from(block);
  overflow.writeUInt32LE(0xffff_ffff, 0);
  assert.throws(() => decodeWwmGroup(toArrayBuffer(overflow)));

  const wrongIndexLength = Buffer.from(block);
  wrongIndexLength.writeUInt32LE(wrongIndexLength.readUInt32LE(4) + 3, 4);
  assert.throws(() => decodeWwmGroup(toArrayBuffer(wrongIndexLength)));

  assert.throws(() => decodeWwm(toArrayBuffer(whole.subarray(0, whole.length - 1)), ""));
  const wrongWholeLength = Buffer.from(whole);
  wrongWholeLength.writeUInt32LE(wrongWholeLength.length + 4, 16);
  assert.throws(() => decodeWwm(toArrayBuffer(wrongWholeLength), ""));
});

test("WWM group encoder rejects nonfinite and Float32-overflow positions and UVs", () => {
  const source = wmoGroupMeshes(parseFixture()).groups[0];
  const variants = [
    ["NaN position", "positions", Number.NaN],
    ["Infinity position", "positions", Number.POSITIVE_INFINITY],
    ["Float32-overflow position", "positions", 1e39],
    ["NaN UV", "uvs", Number.NaN],
    ["Infinity UV", "uvs", Number.POSITIVE_INFINITY],
    ["Float32-overflow UV", "uvs", 1e39],
  ];
  for (const [label, field, value] of variants) {
    const bad = { ...source, [field]: Array.from(source[field]) };
    bad[field][0] = value;
    assert.throws(() => encodeWwmGroup(bad, 0), /finite|representable/i, label);
  }
});

test("WWM group decoder rejects nonfinite position and UV streams", () => {
  const source = wmoGroupMeshes(parseFixture()).groups[0];
  const encoded = encodeWwmGroup(source, 0);
  const uvOffset = 16 + source.positions.length * 4;
  for (const [label, offset] of [["position", 16], ["UV", uvOffset]]) {
    const bad = Buffer.from(encoded);
    bad.writeFloatLE(Number.NaN, offset);
    assert.throws(
      () => decodeWwmGroup(toArrayBuffer(bad)),
      /finite|position|UV|stream/i,
      `${label} NaN must be rejected`,
    );
  }
});

test("direct lighting fails open on malformed light position and keeps a later ordinal", () => {
  const malformed = { ...directLightingLamp(), position: undefined };
  const mesh = directLightingMesh();
  let output;
  assert.doesNotThrow(() => {
    output = wmoVertexLight(mesh, directLightingNormal(), [0, 0, 0], [malformed, directLightingLamp()]);
  });
  assert.ok(output.every(Number.isFinite), "malformed lamp must not poison the color buffer");
  assert.ok(output[0] > 0, "the valid later ordinal must still light the vertex");
});

test("direct lighting fails open on nonfinite lamp colour and keeps a later ordinal", () => {
  const malformed = { ...directLightingLamp(), colour: [Number.NaN, 255, 255] };
  const mesh = directLightingMesh();
  let output;
  assert.doesNotThrow(() => {
    output = wmoVertexLight(mesh, directLightingNormal(), [0, 0, 0], [malformed, directLightingLamp()]);
  });
  assert.ok(output.every(Number.isFinite), "malformed colour must not poison the color buffer");
  assert.ok(output[0] > 0, "the valid later ordinal must still light the vertex");
});

test("direct lighting bounds an out-of-range lamp colour and keeps a later ordinal", () => {
  const malformed = { ...directLightingLamp(), colour: [-1000, 255, 255] };
  const mesh = directLightingMesh();
  let output;
  assert.doesNotThrow(() => {
    output = wmoVertexLight(mesh, directLightingNormal(), [0, 0, 0], [malformed, directLightingLamp()]);
  });
  assert.ok(output.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
    "out-of-range colour must not escape the finite linear colour range");
  assert.ok(output[0] > 0, "the valid later ordinal must still light the vertex");
});

test("WMO model-to-scene mapping, gateway namespaces, Terrain compatibility, and renderer fallback", async () => {
  const mapped = new THREE.Vector3(1, 2, 3).applyQuaternion(ADT_MODEL_TO_SCENE);
  assert.ok(mapped.distanceTo(new THREE.Vector3(-1, 3, 2)) < 1e-6,
    "WMO model coordinates map as (-x,z,y)");

  assert.equal(visualModelCacheNamespace("World\\Wmo\\HardEdge.wmo"), "visual-wmo-v25"); // 05.10-A7b-1
  assert.equal(visualModelCacheNamespace("World\\Creature\\Wolf.m2"), "visual-v23"); // 05.10-A7a-F2

  const modern = encodeModel(wmoGroupMeshes(parseFixture()));
  const legacy = encodeModel(noNormalsModel(wmoGroupMeshes(parseFixture({ normals: "missing" }))));
  const modernTerrain = decodeVisualModel(toArrayBuffer(modern), "http://gateway");
  const legacyTerrain = decodeVisualModel(toArrayBuffer(legacy), "http://gateway");
  assert.ok(modernTerrain.wmo, "Terrain accepts WWM2");
  assert.ok(legacyTerrain.wmo, "Terrain keeps accepting WWM1");
  assert.deepEqual([...modernTerrain.wmo.groups[0].mesh.normals], AUTHORED_NORMALS);
  assert.equal(legacyTerrain.wmo.groups[0].mesh?.normals, undefined);

  // Geometry construction now has a real seam: verify authored and legacy normals on the
  // decoded wire payload, then pin the renderer's call into the incremental geometry scheduler.
  const authoredGeometry = buildWmoGroupGeometry(modernTerrain.wmo, 0);
  const fallbackGeometry = buildWmoGroupGeometry(legacyTerrain.wmo, 0);
  assert.ok(authoredGeometry && fallbackGeometry);
  const authoredSceneNormals = authoredGeometry.getAttribute("normal").array;
  for (let at = 0; at < AUTHORED_NORMALS.length; at += 3) {
    assert.equal(authoredSceneNormals[at], -AUTHORED_NORMALS[at]);
    assert.equal(authoredSceneNormals[at + 1], AUTHORED_NORMALS[at + 2]);
    assert.equal(authoredSceneNormals[at + 2], AUTHORED_NORMALS[at + 1]);
  }
  const recomputed = fallbackGeometry.clone();
  recomputed.deleteAttribute("normal");
  recomputed.computeVertexNormals();
  assert.deepEqual(fallbackGeometry.getAttribute("normal").array, recomputed.getAttribute("normal").array);
  authoredGeometry.dispose();
  fallbackGeometry.dispose();
  recomputed.dispose();
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = renderer.indexOf("  #wmoGroupMesh(");
  const end = renderer.indexOf("\n  /**", start + 1);
  assert.ok(start >= 0 && end > start);
  const body = renderer.slice(start, end);
  assert.match(body, /#wmoGeometryBuild\.request\(cacheKey, model, index, this\.#submissionSerial\)/);
});
