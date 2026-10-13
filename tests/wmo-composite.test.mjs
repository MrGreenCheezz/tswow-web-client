// 13.10 (7.11): Composite (MOMT shader 6) — the tools' second MOTV / second-MOCV-alpha streams
// (`tools/wmo-composite.mjs`), their place in a `visual-wmo-v26` group block (`tools/wwm.mjs` stream bit
// 1), the browser's decode (`WmoModel.ts`), the geometry attributes and the run's look.
// What this does NOT prove: the Icecrown floors against the original (14.25), a driver link (14.24).

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { WMO_SHADER_COMPOSITE, wmoCompositeRecords, wmoCompositeStreams } from "../tools/wmo-composite.mjs";
import { WWM_COMPOSITE_STREAMS, encodeWwmGroup } from "../tools/wwm.mjs";
import { decodeWwmGroup } from "../dist/code/browser/WmoModel.js";
import { buildWmoGroupGeometry } from "../dist/code/browser/WmoGeometry.js";
import {
  WMO_COMPOSITE_BLEND_ATTRIBUTE, WMO_COMPOSITE_UV_ATTRIBUTE, wmoRunLook, wmoRunLookKey,
} from "../dist/code/browser/WmoRunLook.js";

const chunk = (tag, body) => {
  const head = Buffer.alloc(8);
  head.write([...tag].reverse().join(""), 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const floats = (values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const batch = (record) => { const b = Buffer.alloc(24); b[23] = record; return b; };
const momt = (shaders) => {
  const b = Buffer.alloc(shaders.length * 64);
  shaders.forEach((shader, i) => b.writeUInt32LE(shader, i * 64 + 4));
  return b;
};

test("the Composite records are MOMT shader 6", () => {
  assert.equal(WMO_SHADER_COMPOSITE, 6);
  assert.deepEqual([...wmoCompositeRecords(momt([0, 6, 5, 6, 3]))], [1, 3]);
  assert.equal(wmoCompositeRecords(undefined).size, 0);
  assert.equal(wmoCompositeRecords(Buffer.alloc(65)).size, 0, "a torn table names none");
});

test("a group drawing one carries its second MOTV and the second MOCV's alpha; otherwise nothing", () => {
  const body = Buffer.concat([
    chunk("MOTV", floats([0, 0, 1, 0, 1, 1])),
    chunk("MOTV", floats([5, 6, 7, 8, 9, 10])),
    chunk("MOCV", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])),
    chunk("MOCV", Buffer.from([0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255])),
  ]);
  const records = new Set([1]);
  const streams = wmoCompositeStreams(body, 3, batch(1), records);
  assert.deepEqual([...streams.uvs], [5, 6, 7, 8, 9, 10], "the second MOTV, not the first");
  assert.deepEqual([...streams.blend], [0, 128, 255], "the second MOCV's alpha, not the first's");
  assert.equal(wmoCompositeStreams(body, 3, batch(0), records), undefined, "no batch draws a Composite record");
  assert.equal(wmoCompositeStreams(body, 3, batch(1), new Set()), undefined);
  assert.equal(wmoCompositeStreams(body, 4, batch(1), records), undefined, "a stream of the wrong length");
  const oneMotv = Buffer.concat([chunk("MOTV", floats([0, 0, 1, 0, 1, 1])), chunk("MOCV", Buffer.alloc(12)), chunk("MOCV", Buffer.alloc(12))]);
  assert.equal(wmoCompositeStreams(oneMotv, 3, batch(1), records), undefined, "no second MOTV");
  const shortMotv = Buffer.concat([chunk("MOTV", floats([0, 0, 1, 0, 1, 1])), chunk("MOTV", floats([1, 2, 3, 4])),
    chunk("MOCV", Buffer.alloc(12)), chunk("MOCV", Buffer.alloc(12))]);
  assert.equal(wmoCompositeStreams(shortMotv, 3, batch(1), records), undefined, "a second MOTV short of the vertices");
});

function group(extra = {}) {
  return {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], uvs: [0, 0, 1, 0, 1, 1],
    colours: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]),
    indices: [0, 1, 2], runs: [{ start: 0, count: 3, material: 0, blendMode: 0, materialFlags: 0, lighting: 0, materialIndex: 2 }],
    lightRefs: [], ...extra,
  };
}

test("stream bit 1 carries them between the normals and the indices, and decodes back", () => {
  const plain = encodeWwmGroup(group(), 7);
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const withNormals = encodeWwmGroup(group({ normals }), 7);
  const composite = encodeWwmGroup(group({ normals, secondUvs: [2, 3, 4, 5, 6, 7], blendAlpha: new Uint8Array([0, 128, 255]) }), 7);
  assert.equal(plain[11], 0);
  assert.equal(composite[11], 0x01 | WWM_COMPOSITE_STREAMS);
  assert.equal(composite.length, withNormals.length + 3 * 8 + 4, "float2 per vertex + one byte per vertex, padded");
  const decoded = decodeWwmGroup(composite.buffer.slice(composite.byteOffset, composite.byteOffset + composite.length));
  assert.equal(decoded.index, 7);
  assert.deepEqual([...decoded.mesh.secondUvs], [2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...decoded.mesh.blendAlpha], [0, 128, 255]);
  assert.deepEqual([...decoded.mesh.normals], normals);
  assert.deepEqual([...decoded.mesh.indices], [0, 1, 2], "the index list after the streams");
  assert.equal(decoded.mesh.runs[0].materialIndex, 2);
  const old = decodeWwmGroup(withNormals.buffer.slice(withNormals.byteOffset, withNormals.byteOffset + withNormals.length));
  assert.equal(old.mesh.secondUvs, undefined);
  assert.equal(old.mesh.blendAlpha, undefined);
  // Without normals the streams follow the colours.
  const bare = encodeWwmGroup(group({ secondUvs: [1, 1, 1, 1, 1, 1], blendAlpha: new Uint8Array([9, 9, 9]) }), 0);
  assert.equal(bare[11], WWM_COMPOSITE_STREAMS);
  assert.deepEqual([...decodeWwmGroup(bare.buffer.slice(bare.byteOffset, bare.byteOffset + bare.length)).mesh.blendAlpha], [9, 9, 9]);
  assert.throws(() => encodeWwmGroup(group({ secondUvs: [1, 1], blendAlpha: new Uint8Array(3) }), 0), /composite streams disagree/);
});

test("the geometry exposes them as the look's attributes; a group without them gets none", () => {
  const mesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), uvs: new Float32Array(6),
    colours: new Uint8Array(12).fill(255), indices: new Uint16Array([0, 1, 2]),
    runs: [{ start: 0, count: 3, material: 0, blendMode: 0, materialFlags: 0, lighting: 0 }], lightRefs: new Uint16Array(0),
  };
  const model = (extra) => ({ ambient: [0, 0, 0], lights: [], groups: [{ flags: 0x8, indoor: false, mesh: { ...mesh, ...extra } }] });
  const geometry = buildWmoGroupGeometry(model({ secondUvs: new Float32Array([1, 2, 3, 4, 5, 6]), blendAlpha: new Uint8Array([0, 51, 255]) }), 0);
  const uv2 = geometry.getAttribute(WMO_COMPOSITE_UV_ATTRIBUTE);
  const blend = geometry.getAttribute(WMO_COMPOSITE_BLEND_ATTRIBUTE);
  assert.equal(uv2.itemSize, 2);
  assert.deepEqual([...uv2.array], [1, 2, 3, 4, 5, 6]);
  assert.equal(blend.itemSize, 1);
  assert.equal(blend.normalized, true, "a byte read as 0–1");
  assert.ok(Math.abs(blend.getX(1) - 0.2) < 1e-6);
  const plain = buildWmoGroupGeometry(model({}), 0);
  assert.equal(plain.getAttribute(WMO_COMPOSITE_UV_ATTRIBUTE), undefined);
  assert.equal(plain.getAttribute(WMO_COMPOSITE_BLEND_ATTRIBUTE), undefined);
});

test("a Composite record's look needs the streams and its second texture", () => {
  const record = { flags: 0, shader: 6, blendMode: 0, groundType: 0, sidnColour: [0, 0, 0, 0], diffColour: [0, 0, 0, 0], colour2: [0, 0, 0, 0], texture2: "layer.blp" };
  assert.equal(wmoRunLook(record, false, "http://g/texture?path=layer.blp"), undefined, "an artifact before v26: Diffuse");
  assert.equal(wmoRunLook(record, false, undefined, true), undefined, "no second texture");
  const look = wmoRunLook(record, true, "http://g/texture?path=layer.blp", true);
  assert.deepEqual(look, { primaryAlpha: false, composite: { url: "http://g/texture?path=layer.blp" } },
    "the blended alpha is the texture's, as Diffuse (ps_3_0 `mul oC0.w, r2.w, v0.w`)");
  assert.equal(wmoRunLookKey(look), "wmo-look-v1:c");
  const env = wmoRunLook({ ...record, shader: 3 }, false, "u", true);
  assert.equal(env.composite, undefined, "only shader 6 blends");
});

test("the client's Specular and Metal look like Opaque: no highlight term", () => {
  const record = (shader) => ({ flags: 0, shader, blendMode: 0, groundType: 0, sidnColour: [0, 0, 0, 0], diffColour: [0, 0, 0, 0], colour2: [0, 0, 0, 0], texture2: "" });
  for (const shader of [1, 2]) assert.deepEqual(wmoRunLook(record(shader), false, undefined), wmoRunLook(record(4), false, undefined));
});

test("THREE reads a normalized Uint8 attribute as a float (the blend varying)", () => {
  const attribute = new THREE.BufferAttribute(new Uint8Array([255]), 1, true);
  assert.equal(attribute.getX(0), 1);
});
