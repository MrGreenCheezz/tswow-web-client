import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { decompressObjectUpdate } from "../dist/code/world/WorldState.js";

/** `SMSG_COMPRESSED_UPDATE_OBJECT` as TrinityCore sends it: inflated size, then a zlib stream. */
function envelope(body, declaredSize = body.byteLength, options = {}) {
  const compressed = deflateSync(body, options);
  const payload = new Uint8Array(4 + compressed.byteLength);
  new DataView(payload.buffer).setUint32(0, declaredSize, true);
  payload.set(compressed, 4);
  return payload;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 0x1_0000_0000;
}

test("a compressed object update inflates in the same call, byte for byte", () => {
  const random = lcg(0x1f6);
  // From a lone field change to a crowd's worth of create blocks; stored, fixed and dynamic blocks.
  for (const size of [0, 1, 7, 64, 300, 4096, 70_000, 300_000]) {
    for (const level of [0, 1, 6, 9]) {
      const body = new Uint8Array(size);
      // Half random, half repeated: real update blocks are GUIDs and field runs, mostly zeros.
      for (let i = 0; i < size; i++) body[i] = i % 3 === 0 ? Math.floor(random() * 256) : (i >> 5) & 7;
      const payload = envelope(body, size, { level });
      const result = decompressObjectUpdate(payload);
      assert.ok(result instanceof Uint8Array, `size ${size} level ${level} returns bytes, not a promise`);
      assert.deepEqual(result, body, `size ${size} level ${level}`);
    }
  }
});

test("the compressed bytes are read through the packet's own view", () => {
  const body = new TextEncoder().encode("update block ".repeat(40));
  const inner = envelope(body);
  // The packet payload is a window into a larger receive buffer.
  const buffer = new Uint8Array(inner.byteLength + 16).fill(0xee);
  buffer.set(inner, 8);
  assert.deepEqual(decompressObjectUpdate(buffer.subarray(8, 8 + inner.byteLength)), body);
});

test("a compressed object update that does not match its envelope is refused", () => {
  const body = new Uint8Array(512).map((_, i) => i * 7);
  assert.throws(() => decompressObjectUpdate(envelope(body, 511)), /expanded to 512 bytes, expected 511/);
  assert.throws(() => decompressObjectUpdate(envelope(body, 513)), /expanded to 512 bytes, expected 513/);
  assert.throws(() => decompressObjectUpdate(new Uint8Array([1, 0, 0])), /has no size/);
  assert.throws(() => decompressObjectUpdate(envelope(body, 16 * 1024 * 1024 + 1)), /too large/);
  const broken = envelope(body);
  broken[4] = 0x00; // not a zlib header
  assert.throws(() => decompressObjectUpdate(broken), RangeError);
});
