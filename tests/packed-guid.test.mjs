import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { guidFromWords } from "../dist/code/protocol/Guid.js";
import { readField, readGuidAt } from "../dist/code/world/Fields.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// P1-21c: packed GUIDs and two-word fields without a bigint per byte. The implementations they
// replaced stay here as the oracle, verbatim apart from taking the reader as an argument.

function oldReadPackedGuid(reader) {
  const mask = reader.u8();
  let guid = 0n;
  for (let index = 0; index < 8; index++) {
    if (mask & (1 << index)) guid |= BigInt(reader.u8()) << BigInt(index * 8);
  }
  return guid;
}

const MAX_GUID = 0xffff_ffff_ffff_ffffn;
function oldWritePackedGuid(value) {
  if (value < 0n || value > MAX_GUID) throw new RangeError("GUID is outside the unsigned 64-bit range");
  let mask = 0;
  const packed = [];
  for (let index = 0; index < 8; index++) {
    const byte = Number((value >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      packed.push(byte);
    }
  }
  return Uint8Array.from([mask, ...packed]);
}

const oldWords = (low, high) => (BigInt(high) << 32n) | BigInt(low);

function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = Math.imul(state, 1664525) + 1013904223 >>> 0);
}

const popcount = (mask) => { let n = 0; for (let m = mask; m; m &= m - 1) n++; return n; };

/** Both readers on the same bytes: value, offset after, or the error message. */
function compareRead(bytes, label) {
  const run = (read) => {
    const reader = new PacketReader(bytes);
    try {
      return { value: read(reader), offset: reader.offset };
    } catch (error) {
      return { error: `${error.name}: ${error.message}`, offset: reader.offset };
    }
  };
  const expected = run(oldReadPackedGuid);
  const actual = run((reader) => reader.packedGuid());
  assert.deepEqual(actual, expected, label);
  if (actual.value !== undefined) assert.ok(actual.value === expected.value, `${label}: bigint ===`);
}

test("the packed reader matches the old one on every mask and byte pattern", () => {
  const random = lcg(0x9);
  const patterns = [() => 0, () => 0xff, () => 0x80, () => 0x7f, () => 0x01, () => random() & 0xff];
  for (let mask = 0; mask < 256; mask++) {
    for (const pattern of patterns) {
      const body = Array.from({ length: popcount(mask) }, pattern);
      // A trailing byte: the reader must stop exactly where the GUID ends.
      compareRead(Uint8Array.from([mask, ...body, 0xab]), `mask ${mask}`);
      // Short by k bytes: the same underflow, at the same place.
      for (let k = 1; k <= body.length; k++) compareRead(Uint8Array.from([mask, ...body.slice(0, body.length - k)]), `mask ${mask} short ${k}`);
    }
  }
  compareRead(new Uint8Array(0), "no mask byte");
});

test("the packed reader matches the old one on 100 000 random GUIDs", () => {
  const random = lcg(0x1f6);
  for (let i = 0; i < 100_000; i++) {
    const mask = random() & 0xff;
    const bytes = Uint8Array.from({ length: 1 + popcount(mask) }, (_, at) => (at === 0 ? mask : random() & 0xff));
    compareRead(bytes, `random ${i}`);
  }
});

test("a packed reader in the middle of a packet reads through the packet's own view", () => {
  const writer = new PacketWriter().u32(7).packedGuid(0xf130_0000_1234_5678n).u8(9);
  const reader = new PacketReader(writer.toUint8Array());
  assert.equal(reader.u32(), 7);
  assert.equal(reader.packedGuid(), 0xf130_0000_1234_5678n);
  assert.equal(reader.u8(), 9);
});

function compareWrite(value, label) {
  let expected;
  try {
    expected = { bytes: oldWritePackedGuid(value) };
  } catch (error) {
    expected = { error: `${error.name}: ${error.message}` };
  }
  let actual;
  try {
    actual = { bytes: new PacketWriter().packedGuid(value).toUint8Array() };
  } catch (error) {
    actual = { error: `${error.name}: ${error.message}` };
  }
  assert.deepEqual(actual, expected, label);
}

test("the packed writer matches the old one, edges and 100 000 random values", () => {
  const edges = [0n, 1n, 0xffn, 0xff00n, 0xffff_ffffn, 0x1_0000_0000n, 0x8000_0000_0000_0000n, MAX_GUID,
    0xf130_0000_0000_0001n, 0x0700_0000_0000_0000n, -1n, MAX_GUID + 1n, -(2n ** 70n), 2n ** 70n];
  for (const value of edges) compareWrite(value, `edge ${value}`);
  const random = lcg(0x20c);
  for (let i = 0; i < 100_000; i++) {
    // Sparse bytes, so every mask shows up rather than almost always 0xFF.
    let value = 0n;
    const mask = random() & 0xff;
    for (let index = 0; index < 8; index++) if (mask & (1 << index)) value |= BigInt(random() & 0xff) << BigInt(index * 8);
    compareWrite(value, `random ${value}`);
  }
  // After other fields, and the mask lands at the GUID's start.
  assert.deepEqual(new PacketWriter().u8(0xee).packedGuid(0x0100_0000_0000_00ffn).u8(0xdd).toUint8Array(),
    Uint8Array.from([0xee, 0x81, 0xff, 0x01, 0xdd]));
});

test("two words become the same bigint as the old shift-and-or", () => {
  const edges = [0, 1, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0xf130_0000];
  for (const low of edges) for (const high of edges) assert.ok(guidFromWords(low, high) === oldWords(low, high), `${low} ${high}`);
  const random = lcg(3);
  for (let i = 0; i < 100_000; i++) {
    const low = random();
    const high = i % 4 === 0 ? 0 : random();
    assert.ok(guidFromWords(low, high) === oldWords(low, high), `${low} ${high}`);
  }
});

test("readField on a LONG and readGuidAt read the two slots as before", () => {
  const offset = UPDATE_FIELDS.OBJECT_FIELD_GUID.offset;
  assert.equal(UPDATE_FIELDS.OBJECT_FIELD_GUID.type, "LONG");
  const random = lcg(4);
  for (let i = 0; i < 20_000; i++) {
    const low = random();
    const high = i % 3 === 0 ? 0 : random();
    const object = { fields: new Map([[offset, low], [offset + 1, high]]) };
    assert.ok(readField(object, "OBJECT_FIELD_GUID") === oldWords(low, high));
    assert.ok(readGuidAt(object, offset) === oldWords(low, high));
  }
  // A missing high slot reads as zero; a missing low slot is no GUID at all.
  assert.equal(readGuidAt({ fields: new Map([[10, 5]]) }, 10), 5n);
  assert.equal(readGuidAt({ fields: new Map([[11, 5]]) }, 10), undefined);
  assert.equal(readField({ fields: new Map([[offset, 0xffff_ffff]]) }, "OBJECT_FIELD_GUID"), 0xffff_ffffn);
});

test("a slot holding something other than a u32 word reads exactly as the old expression did", () => {
  // Fixtures put bigints straight into a GUID slot; nothing on the wire does, but the answer stays.
  const offset = UPDATE_FIELDS.OBJECT_FIELD_GUID.offset;
  const outcome = (run) => { try { return { value: run() }; } catch (error) { return { error: error.name }; } };
  for (const [low, high] of [[0x77n, undefined], [0x77n, 0], [5, 0x1n], [-1, 0], [0, -1], [-2, -3], [1.5, 0], [0, 2.5], [2 ** 32, 0], [Number.NaN, 0]]) {
    const fields = new Map([[offset, low]]);
    if (high !== undefined) fields.set(offset + 1, high);
    const object = { fields };
    const expected = outcome(() => oldWords(low, high ?? 0));
    assert.deepEqual(outcome(() => readField(object, "OBJECT_FIELD_GUID")), expected, `readField ${low} ${high}`);
    assert.deepEqual(outcome(() => readGuidAt(object, offset)), expected, `readGuidAt ${low} ${high}`);
  }
});

test("no BigInt() call per byte: the reader, the writer and the fields", () => {
  const original = globalThis.BigInt;
  let calls = 0;
  globalThis.BigInt = new Proxy(original, { apply(target, self, args) { calls++; return Reflect.apply(target, self, args); } });
  try {
    const full = Uint8Array.from([0xff, 1, 2, 3, 0x84, 5, 6, 7, 0x88]);
    calls = 0;
    const read = new PacketReader(full).packedGuid();
    const readCalls = calls;
    calls = 0;
    new PacketWriter().packedGuid(0x8807_0605_8403_0201n);
    const writeCalls = calls;
    const offset = UPDATE_FIELDS.OBJECT_FIELD_GUID.offset;
    const object = { fields: new Map([[offset, 0x8403_0201], [offset + 1, 0x8807_0605]]) };
    calls = 0;
    readField(object, "OBJECT_FIELD_GUID");
    readGuidAt(object, offset);
    const fieldCalls = calls;
    globalThis.BigInt = original;
    assert.equal(read, 0x8807_0605_8403_0201n);
    assert.ok(readCalls <= 2, `reader made ${readCalls} BigInt() calls on mask 0xFF`);
    assert.equal(writeCalls, 0, "writer");
    assert.equal(fieldCalls, 0, "fields");
  } finally {
    globalThis.BigInt = original;
  }
});
