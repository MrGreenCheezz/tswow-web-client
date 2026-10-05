// 6.16г (05.10-A7a-F2): a bone channel the file marks as stepped (interpolation 0) holds its value
// until the next key. The byte has been in every artifact since the first WVM; the decoder now
// expands such a channel into keys a linear track plays as a step, in both decoders.

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { encodeWvaAnimations } from "../tools/wvm.mjs";
import { decodeWvaAnimations, decodeWvaAnimationsPacked } from "../dist/code/browser/Wvm.js";
import { unpackWvaAnimations } from "../dist/code/browser/WvaAnimationDecode.js";

function arrayBufferOf(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** One clip, two translation channels on bone 0 and 1: one stepped, one linear; one stepped rotation. */
function block() {
  return arrayBufferOf(encodeWvaAnimations(2, [{
    animationId: 4, duration: 1000, channels: [
      { bone: 0, kind: 0, interpolation: 0, times: Uint32Array.from([0, 400, 1000]),
        values: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]) },
      { bone: 1, kind: 0, interpolation: 1, times: Uint32Array.from([0, 1000]),
        values: Float32Array.from([0, 0, 0, 1, 0, 0]) },
      { bone: 1, kind: 1, interpolation: 0, times: Uint32Array.from([0, 500]),
        values: Int16Array.from([-1, -1, -1, 0, -1, -1, 32767, 0]) },
    ],
  }]));
}

/** Samples a channel the way three's linear interpolant would. */
function sample(channel, seconds) {
  const track = new THREE.VectorKeyframeTrack("x.position", channel.times, channel.values);
  const result = track.createInterpolant().evaluate(seconds);
  return result[0];
}

for (const [label, decode] of [
  ["object decoder", (data) => decodeWvaAnimations(data, 2)],
  ["packed decoder", (data) => unpackWvaAnimations({ ...decodeWvaAnimationsPacked(data, 2), digest: "x", cost: {} })],
]) {
  test(`6.16г a stepped channel holds its value until the next key (${label})`, () => {
    const [clip] = decode(block());
    const [stepped, linear, rotation] = clip.channels;
    assert.equal(stepped.times.length, 5, "three keys become five: two held copies");
    assert.equal(sample(stepped, 0.2), 0, "held at the first key, not half way to the second");
    assert.equal(sample(stepped, 0.39), 0, "still held just before the second key");
    assert.equal(sample(stepped, Math.fround(0.4)), 1, "and the second key's value from its own time");
    assert.equal(sample(stepped, 0.7), 1);
    assert.equal(sample(stepped, 1), 2);
    assert.ok(stepped.times[1] < 0.4 && stepped.times[1] > 0.399, `the held copy sits just before 0.4, got ${stepped.times[1]}`);
    assert.equal(linear.times.length, 2, "a linear channel is left as it was");
    assert.ok(Math.abs(sample(linear, 0.5) - 0.5) < 1e-6);
    assert.equal(rotation.times.length, 3, "a stepped rotation too");
    assert.deepEqual([...rotation.values.slice(4, 8)], [...rotation.values.slice(0, 4)], "holding the first quaternion");
  });
}
