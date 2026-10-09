import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeWvaAnimations } from '../tools/wvm.mjs';
import { decodeWvaAnimations } from '../dist/code/browser/Wvm.js';
import { decodedAnimationResidencyCost, decodedResidencyCost } from '../dist/code/browser/Terrain.js';

const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
// 05.10 suite-fix: linear (M2Track.interpolation 1) like nearly every real clip track; since
// 05.10-A7a-F2 an omitted byte encodes as 0, which decodes stepped (tests/wva-step-keys.test.mjs).
const channel = (bone, kind, times, values) => ({
  bone, kind, interpolation: 1, times: Uint32Array.from(times),
  values: kind === 1 ? Int16Array.from(values) : Float32Array.from(values),
});

test('animation key storage preserves all channel types, metadata and independent writable ranges', () => {
  const channels = [
    channel(0, 0, [0, 250], [1, -2, 3, 4, 5, -6]),
    channel(1, 1, [500], [-32768, -1, 0, 32767]),
    channel(1, 2, [750], [0.25, 0.5, 2]),
    channel(0, 0, [], []),
  ];
  const encoded = encodeWvaAnimations(2, [
    { animationId: 7, duration: 1000, blendTime: 150, movingSpeed: -2.5,
      variationIndex: 0, variationNext: 1, channels },
    { animationId: 8, duration: 1000, channels },
    { animationId: 9, duration: 1000, channels: [] },
  ]);
  const input = arrayBuffer(encoded), original = new Uint8Array(input).slice();
  const clips = decodeWvaAnimations(input, 2), [first, second, empty] = clips;
  assert.deepEqual(first.channels.map(c => [...c.times]), [[0, 0.25], [0.5], [0.75], []]);
  assert.deepEqual(first.channels.map(c => [...c.values]), [
    [1, -2, 3, 4, 5, -6], [0, 1, -1, 0], [0.25, 0.5, 2], [],
  ]);
  assert.deepEqual([first.animationId, first.duration, first.blendTime, first.movingSpeed,
    first.variationIndex, first.variationNext], [7, 1, 0.15, -2.5, 0, 1]);
  assert.deepEqual(empty.channels, []);
  const arrays = first.channels.flatMap(c => [c.times, c.values]);
  assert.equal(new Set(arrays.map(a => a.buffer)).size, 1,
    'one clip must not allocate thousands of separate key buffers');
  assert.equal(arrays[0].buffer.byteLength, arrays.reduce((sum, a) => sum + a.byteLength, 0),
    'packed storage has no unused capacity and retains none of the response');
  assert.notEqual(arrays[0].buffer, second.channels[0].times.buffer,
    'retaining one clip must not retain every other animation');
  first.channels[0].values[0] = 123;
  assert.equal(first.channels[0].times[0], 0);
  assert.equal(first.channels[0].values[1], -2);
  assert.equal(first.channels[1].values[0], 0);
  assert.equal(second.channels[0].values[0], 1);
  assert.deepEqual(new Uint8Array(input), original);
  assert.deepEqual(decodedAnimationResidencyCost(clips), decodedResidencyCost(clips));
});

test('animation residency counts full shared backings once, including views shared across clips', () => {
  const backing = new ArrayBuffer(256), separate = new Float32Array(3);
  const shared = { bone: 0, kind: 0,
    times: new Float32Array(backing, 16, 2), values: new Float32Array(backing, 64, 6) };
  const clips = [
    { animationId: 1, duration: 1, channels: [shared, shared] },
    { animationId: 2, duration: 1, channels: [{ ...shared, values: separate }] },
  ];
  assert.deepEqual(decodedAnimationResidencyCost(clips), { typedBackingBytes: 268, numericArrayElements: 0 });
  assert.deepEqual(decodedAnimationResidencyCost(clips), decodedResidencyCost(clips));
  assert.deepEqual(decodedAnimationResidencyCost([]), { typedBackingBytes: 0, numericArrayElements: 0 });
});
