// 05.10-A7a-F2 (6.22, 6.16е, 6.16б, 6.17): the shader id a batch is drawn with, resolved the way
// Wow.exe resolves it at load (va 0x836980), the sphere-map stage the coord combo −1 marks, the
// second unit's own texture transform and the M2 lights — read from a synthetic M2, carried by the
// extended WVM9 (WVE1) and decoded by the browser. No client archives: everything here is built.

import assert from "node:assert/strict";
import test from "node:test";
import { parseM2, readLights } from "../tools/m2.mjs";
import { COMBINER_OPS, resolveShaderId, SHADER_LAST_UNIT_UV2 } from "../tools/m2-combiners.mjs";
import { encodeWvm9, WVM9_EXTENDED } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";

const OP = Object.fromEntries(COMBINER_OPS.map((name, index) => [name, index]));

/** A little bump allocator over one growing buffer: header first, then every block appended. */
class Writer {
  constructor(headerSize) {
    this.buffer = Buffer.alloc(headerSize);
  }
  append(bytes) {
    // Keep blocks 4-aligned, as the client's own files are.
    const at = (this.buffer.length + 3) & ~3;
    this.buffer = Buffer.concat([this.buffer, Buffer.alloc(at - this.buffer.length), bytes]);
    return at;
  }
  array(header, count, bytes) {
    // `append` replaces the buffer, so the offset is taken before anything is written.
    const offset = count === 0 ? 0 : this.append(bytes);
    this.buffer.writeUInt32LE(count, header);
    this.buffer.writeUInt32LE(offset, header + 4);
  }
}

function u16s(values) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

/**
 * One triangle, two textures, the given batches and materials, optionally header flag 0x08 with a
 * `texture_combiner_combos` array, a transform-combo table and one light.
 */
function syntheticModel({ flags = 0, combiners = [], materials, coordCombos, transformCombos = [], batches, light = false }) {
  const m2 = new Writer(0x138);
  m2.buffer.write("MD20", 0, "ascii");
  m2.buffer.writeUInt32LE(264, 4);
  m2.buffer.writeUInt32LE(flags, 0x10);
  const vertices = Buffer.alloc(3 * 48);
  for (let vertex = 0; vertex < 3; vertex++) {
    vertices.writeFloatLE(vertex === 1 ? 1 : 0, vertex * 48);
    vertices.writeFloatLE(vertex === 2 ? 1 : 0, vertex * 48 + 4);
    vertices.writeFloatLE(1, vertex * 48 + 28); // normal +Z
    vertices.writeFloatLE(vertex === 1 ? 1 : 0, vertex * 48 + 40); // a second UV set that is there
    vertices.writeFloatLE(vertex === 2 ? 1 : 0, vertex * 48 + 44);
  }
  m2.array(0x3c, 3, vertices);
  const names = ["Item\\Layer0.blp", "Item\\ArmorReflect4.blp"];
  const textures = Buffer.alloc(names.length * 16);
  names.forEach((name, index) => {
    const at = m2.append(Buffer.from(`${name}\0`, "utf8"));
    textures.writeUInt32LE(0, index * 16);
    textures.writeUInt32LE(0, index * 16 + 4);
    textures.writeUInt32LE(name.length + 1, index * 16 + 8);
    textures.writeUInt32LE(at, index * 16 + 12);
  });
  m2.array(0x50, names.length, textures);
  const materialBytes = Buffer.alloc(materials.length * 4);
  materials.forEach((blendMode, index) => materialBytes.writeUInt16LE(blendMode, index * 4 + 2));
  m2.array(0x70, materials.length, materialBytes);
  m2.array(0x80, 2, u16s([0, 1]));
  m2.array(0x88, coordCombos.length, u16s(coordCombos));
  m2.array(0x98, transformCombos.length, u16s(transformCombos));
  m2.array(0x130, combiners.length, u16s(combiners));
  if (light) {
    const record = Buffer.alloc(156);
    record.writeUInt16LE(1, 0); // point
    record.writeInt16LE(-1, 2);
    record.writeFloatLE(0.5, 4);
    record.writeFloatLE(-0.25, 8);
    record.writeFloatLE(2, 12);
    // attenuationEnd (slot 5): one sub-track, one key, 7.5 yards, linear, no global loop.
    const track = 16 + 5 * 20;
    record.writeUInt16LE(1, track);
    record.writeInt16LE(-1, track + 2);
    m2.array(0x108, 1, record);
    const lightAt = m2.buffer.readUInt32LE(0x10c);
    const time = m2.append(u16s([0, 0])); // u32 0
    const timesOuter = Buffer.alloc(8);
    timesOuter.writeUInt32LE(1, 0);
    timesOuter.writeUInt32LE(time, 4);
    const value = Buffer.alloc(4);
    value.writeFloatLE(7.5, 0);
    const valueAt = m2.append(value);
    const valuesOuter = Buffer.alloc(8);
    valuesOuter.writeUInt32LE(1, 0);
    valuesOuter.writeUInt32LE(valueAt, 4);
    const timesAt = m2.append(timesOuter);
    const valuesAt = m2.append(valuesOuter);
    m2.buffer.writeUInt32LE(1, lightAt + track + 4);
    m2.buffer.writeUInt32LE(timesAt, lightAt + track + 8);
    m2.buffer.writeUInt32LE(1, lightAt + track + 12);
    m2.buffer.writeUInt32LE(valuesAt, lightAt + track + 16);
  }

  const skin = new Writer(0x30);
  skin.buffer.write("SKIN", 0, "ascii");
  skin.array(0x04, 3, u16s([0, 1, 2]));
  skin.array(0x0c, 3, u16s([0, 1, 2]));
  const submesh = Buffer.alloc(48);
  submesh.writeUInt16LE(3, 6);
  submesh.writeUInt16LE(3, 10);
  skin.array(0x1c, 1, submesh);
  const batchBytes = Buffer.alloc(batches.length * 24);
  batches.forEach((batch, index) => {
    const at = index * 24;
    batchBytes.writeUInt16LE(batch.shaderId, at + 2);
    batchBytes.writeUInt16LE(0, at + 4);
    batchBytes.writeUInt16LE(0xffff, at + 8);
    batchBytes.writeUInt16LE(batch.material ?? 0, at + 10);
    batchBytes.writeUInt16LE(batch.textureCount, at + 14);
    batchBytes.writeUInt16LE(0, at + 16);
    batchBytes.writeUInt16LE(batch.coordCombo ?? 0, at + 18);
    batchBytes.writeUInt16LE(0xffff, at + 20);
    batchBytes.writeUInt16LE(batch.transformCombo ?? 0xffff, at + 22);
  });
  skin.array(0x24, batches.length, batchBytes);
  return { m2: m2.buffer, skin: skin.buffer };
}

function arrayBufferOf(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test("6.22 header flag 0x08: each stage's operation comes out of texture_combiner_combos", () => {
  // Batch 0: raw id 2 indexes combos [2, 3] = Mod, Mod2x; the opaque material forces stage 0 Opaque.
  // Batch 1: same combos on an alpha material keeps Mod. Batch 2: unit 1 has coord −1 — a sphere map.
  const { m2, skin } = syntheticModel({
    flags: 0x08,
    combiners: [OP.Opaque, OP.Add, OP.Mod, OP.Mod2x],
    materials: [0, 2],
    coordCombos: [0, 1, 0, 0xffff],
    batches: [
      { shaderId: 2, textureCount: 2, material: 0, coordCombo: 0 },
      { shaderId: 2, textureCount: 2, material: 1, coordCombo: 0 },
      { shaderId: 0, textureCount: 2, material: 0, coordCombo: 2 },
    ],
  });
  const model = parseM2(m2, skin);
  const [opaque, alpha, env] = model.batches;
  assert.equal(opaque.resolvedShaderId, SHADER_LAST_UNIT_UV2 | (OP.Opaque << 4) | OP.Mod2x, "Opaque_Mod2x, unit 1 on UV2");
  assert.equal(alpha.resolvedShaderId, SHADER_LAST_UNIT_UV2 | (OP.Mod << 4) | OP.Mod2x, "Mod_Mod2x on a blended material");
  assert.equal(env.resolvedShaderId, (OP.Opaque << 4) | (OP.Add | 0x8), "Opaque_Add, stage 1 sphere-mapped, no UV2");
  assert.deepEqual(env.textureCoords, [0, -1], "the −1 is kept, not folded into UV set 0");
  assert.deepEqual(env.uvSets, [0, 0], "while the legacy UV mask still reads as it always did");
  assert.equal(opaque.shaderId, 2, "and the raw id survives for the legacy artifact");
});

test("6.22 without flag 0x08 the raw id is replaced: Opaque/Mod by material, unit 0 only", () => {
  // va 0x836980: stage 0 = Opaque on an opaque material, Mod otherwise; sphere when unit 0's coord
  // is above 2; 0x4000 when it is exactly 1; stage 1 stays 0 whatever the batch has.
  const resolved = (opaque, coords, raw = 5) =>
    resolveShaderId({ rawShaderId: raw, textureCount: coords.length, coords, opaque, combiners: undefined });
  assert.equal(resolved(true, [0]), 0x00);
  assert.equal(resolved(false, [0]), 0x10);
  assert.equal(resolved(false, [1]), 0x4010);
  assert.equal(resolved(true, [0xffff, 1]), 0x80, "sphere-mapped Opaque, unit 1 not consulted");
  assert.equal(resolved(false, [0], 0x8001), 0x8001, "a special 0x8000 id is left as stored");
});

test("6.22 the flagged path: 0x4000 only for the last unit, and an out-of-range index reads Opaque", () => {
  const combiners = [OP.Mod, OP.Add];
  const resolved = (coords, raw = 0) =>
    resolveShaderId({ rawShaderId: raw, textureCount: coords.length, coords, opaque: false, combiners });
  assert.equal(resolved([1, 0]), (OP.Mod << 4) | OP.Add, "UV2 on unit 0 of two is not the last unit");
  assert.equal(resolved([0, 1]), 0x4000 | (OP.Mod << 4) | OP.Add);
  assert.equal(resolved([0xffff]), (OP.Mod | 8) << 4, "a one-stage sphere map");
  assert.equal(resolved([0, 0], 1), (OP.Add << 4) | OP.Opaque, "combos[2] does not exist");
});

test("6.16б the second unit's transform is resolved through the combo table", () => {
  const { m2, skin } = syntheticModel({
    materials: [0], coordCombos: [0, 1], transformCombos: [0xffff, 3],
    batches: [{ shaderId: 0, textureCount: 2, coordCombo: 0, transformCombo: 0 }],
  });
  const [batch] = parseM2(m2, skin).batches;
  assert.equal(batch.textureTransform, -1);
  assert.equal(batch.textureTransform2, 3);
});

test("6.17 M2Light: header 0x108, one point light with its attenuation track", () => {
  const { m2, skin } = syntheticModel({
    materials: [0], coordCombos: [0], light: true, batches: [{ shaderId: 0, textureCount: 1 }],
  });
  const [light] = readLights(m2);
  assert.equal(light.type, 1);
  assert.equal(light.bone, -1);
  assert.deepEqual(light.position, [0.5, -0.25, 2]);
  assert.deepEqual(light.attenuationEnd.tracks.map((sub) => [...sub.values]), [[7.5]]);
  assert.equal(parseM2(m2, skin).lights.length, 1);
});

test("WVM9 extended: resolved ids, the second-unit transform and the lights reach the browser", () => {
  const { m2, skin } = syntheticModel({
    flags: 0x08, combiners: [OP.Opaque, OP.Mod2x], materials: [0], coordCombos: [0, 1],
    transformCombos: [0xffff, 2], light: true,
    batches: [{ shaderId: 0, textureCount: 2, coordCombo: 0, transformCombo: 0 }],
  });
  const model = parseM2(m2, skin);
  const encoded = encodeWvm9(model, undefined, undefined, undefined, { extensions: true });
  assert.equal(encoded.readUInt8(13) & WVM9_EXTENDED, WVM9_EXTENDED);
  const decoded = decodeWvm9(arrayBufferOf(encoded));
  assert.equal(decoded.shaderIdsResolved, true);
  assert.equal(decoded.batches[0].shaderId, 0x4000 | OP.Mod2x, "the resolved id, not the raw 0");
  assert.equal(decoded.batches[0].textureTransform2, 2);
  assert.equal(decoded.lights.length, 1);
  assert.equal(decoded.lights[0].type, 1);
  assert.deepEqual(decoded.lights[0].position, [0.5, -0.25, 2]);
  assert.deepEqual([...decoded.lights[0].attenuationEnd.tracks[0].values], [7.5]);
  // A truncated block is refused rather than read short.
  const cut = Buffer.from(encoded.subarray(0, encoded.length - 4));
  cut.writeUInt32LE(cut.length, 24);
  assert.throws(() => decodeWvm9(arrayBufferOf(cut)), /runs past|WVM9/);
});

test("WVM9 legacy: no WVE1, the raw shader id, nothing a v21 reader has not seen", () => {
  const { m2, skin } = syntheticModel({
    flags: 0x08, combiners: [OP.Opaque, OP.Mod2x], materials: [0], coordCombos: [0, 1], light: true,
    batches: [{ shaderId: 0, textureCount: 2, coordCombo: 0 }],
  });
  const model = parseM2(m2, skin);
  const legacy = encodeWvm9(model, undefined);
  assert.equal(legacy.readUInt8(13) & WVM9_EXTENDED, 0);
  assert.equal(legacy.indexOf("WVE1"), -1);
  const decoded = decodeWvm9(arrayBufferOf(legacy));
  assert.equal(decoded.shaderIdsResolved, undefined);
  assert.equal(decoded.batches[0].shaderId, 0);
  assert.equal(decoded.batches[0].textureTransform2, undefined);
  assert.equal(decoded.lights, undefined);
});
