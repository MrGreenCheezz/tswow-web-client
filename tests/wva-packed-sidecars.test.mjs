import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import v8 from 'node:v8';
import * as THREE from 'three';
import { encodeWvaAnimations } from '../tools/wvm.mjs';
import { decodeWvaAnimations, decodeWvm9 } from '../dist/code/browser/Wvm.js';
import { addSkinnedClips, buildSkinnedTemplateFrom, skinnedClipsBoneSpan } from '../dist/code/browser/AnimatedModel.js';
import { decodedResidencyCost } from '../dist/code/browser/Terrain.js';
import {
  decodeWvaAnimationRequest, decodedAnimationResidencyCost, unpackWvaAnimations,
} from '../dist/code/browser/WvaAnimationDecode.js';
import { WvaAnimationDecodeClient } from '../dist/code/browser/WvaAnimationDecodeClient.js';

// Real sidecars from the benchmark's content-addressed cache, decoded both ways: the synchronous
// decoder the Node tools use, and the worker protocol the browser uses (flat transferred buffers,
// clips built on first read). Every consumer must see the same bits, and compile the same clips.

const cache = new URL('../bench/cache/', import.meta.url);
const skip = existsSync(new URL('index.json', cache))
  ? false : 'bench/cache/index.json is absent: run the benchmark once to populate the asset cache';

function cachedRigs() {
  const index = JSON.parse(readFileSync(new URL('index.json', cache), 'utf8'));
  const byPath = new Map();
  for (const [url, entry] of Object.entries(index)) {
    const match = /^\/visual\/(model|animations)\?path=([^&]+)&/.exec(decodeURIComponent(url));
    if (!match || entry.status !== 200) continue;
    byPath.set(match[2], { ...byPath.get(match[2]), [match[1]]: entry.sha256 });
  }
  const bytes = sha => {
    const data = readFileSync(new URL(sha, cache));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  };
  return [...byPath].filter(([, item]) => item.model && item.animations).map(([path, item]) => {
    const skeleton = decodeWvm9(bytes(item.model)).skeleton;
    return { path, skeleton, sidecar: bytes(item.animations) };
  }).filter(rig => rig.skeleton);
}
const rigs = skip ? [] : cachedRigs();

/** The browser path: request and response through structured clone with their transfer lists. */
function viaWorker(sidecar, bones) {
  const data = sidecar.slice(0);
  const request = structuredClone({ id: 1, data, bones, known: [] }, { transfer: [data] });
  const { response, transfer } = decodeWvaAnimationRequest(request);
  assert.ok(response.packed, response.error);
  const serializer = new v8.Serializer();
  transfer.forEach((buffer, id) => serializer.transferArrayBuffer(id, buffer));
  serializer.writeHeader();
  serializer.writeValue(response);
  const messageBytes = serializer.releaseBuffer().byteLength;
  const received = structuredClone(response, { transfer });
  return { packed: received.packed, transfers: transfer.length, messageBytes };
}

const bitsEqual = (left, right) => left.constructor === right.constructor && left.length === right.length
  && Buffer.from(left.buffer, left.byteOffset, left.byteLength)
    .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
const lazy = clip => typeof Object.getOwnPropertyDescriptor(clip, 'channels')?.get === 'function';

/** Keeps a failure readable: the first differences and how many there were. */
function summarized(differences) {
  return differences.length <= 12 ? differences : [...differences.slice(0, 12), `... ${differences.length} in all`];
}

/** Every difference a consumer could observe, described; empty when the two decodes agree. */
function clipDifferences(expected, actual) {
  const differences = [];
  if (actual.length !== expected.length) return [`clip count ${actual.length} != ${expected.length}`];
  for (let at = 0; at < expected.length; at++) {
    const [want, got] = [expected[at], actual[at]];
    const keys = Object.keys(want);
    if (Object.keys(got).join() !== keys.join()) differences.push(`clip ${at} fields ${Object.keys(got)} != ${keys}`);
    if (Object.getPrototypeOf(got) !== Object.getPrototypeOf(want)) differences.push(`clip ${at} prototype`);
    for (const key of keys) {
      if (key !== 'channels' && !Object.is(got[key], want[key])) differences.push(`clip ${at} ${key} ${got[key]} != ${want[key]}`);
    }
    if (got.channels.length !== want.channels.length) {
      differences.push(`clip ${at} channel count ${got.channels.length} != ${want.channels.length}`);
      continue;
    }
    want.channels.forEach((channel, index) => {
      const other = got.channels[index];
      if (Object.keys(other).join() !== Object.keys(channel).join() || other.bone !== channel.bone
        || other.kind !== channel.kind || !bitsEqual(other.times, channel.times)
        || !bitsEqual(other.values, channel.values)) differences.push(`clip ${at} channel ${index}`);
    });
  }
  return differences;
}

function trackSignature(clip) {
  return {
    name: clip.name, duration: clip.duration, userData: clip.userData, blendMode: clip.blendMode,
    tracks: clip.tracks.map(track => ({
      name: track.name, type: track.constructor.name, valueType: track.ValueTypeName,
      interpolation: track.getInterpolation(), times: track.times.constructor.name, values: track.values.constructor.name,
    })),
  };
}

/** Compiled clips must agree in structure and in every keyframe bit. */
function compiledDifferences(expected, actual) {
  const differences = [];
  const ids = [...expected.keys()].sort((a, b) => a - b);
  if ([...actual.keys()].sort((a, b) => a - b).join() !== ids.join()) return ['compiled animation ids differ'];
  for (const id of ids) {
    const [want, got] = [expected.get(id), actual.get(id)];
    try {
      assert.deepEqual(trackSignature(got), trackSignature(want));
    } catch {
      differences.push(`animation ${id} structure`);
      continue;
    }
    want.tracks.forEach((track, index) => {
      const other = got.tracks[index];
      if (!bitsEqual(other.times, track.times) || !bitsEqual(other.values, track.values)) {
        differences.push(`animation ${id} track ${track.name}`);
      }
    });
  }
  return differences;
}

test('optional clip fields and key encodings agree at every edge, with or without an extras table', () => {
  const arrayBufferOf = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const channels = [
    { bone: 0, kind: 0, times: Uint32Array.of(0, 1, 3, 7, 999, 1001, 4_294_967_295),
      values: Float32Array.from({ length: 21 }, (_, at) => [-0, 1e-45, -3.4e38, Infinity, -Infinity, 0.1, 1 / 3][at % 7]) },
    { bone: 2, kind: 1, times: Uint32Array.of(16, 33),
      values: Int16Array.of(-32768, -32767, -1, 0, 1, 16384, 32766, 32767) },
    { bone: 1, kind: 2, times: Uint32Array.of(250), values: Float32Array.of(1, 0.5, 2) },
    { bone: 2, kind: 0, times: new Uint32Array(), values: new Float32Array() },
  ];
  const extras = [
    { animationId: 0, duration: 0, blendTime: 1, movingSpeed: -2.5, variationIndex: 0, variationNext: 0, channels },
    { animationId: 65535, duration: 4_294_967_295, blendTime: 65535, movingSpeed: 0,
      variationIndex: 65535, variationNext: -1, channels: channels.slice(1) },
    { animationId: 7, duration: 1234, movingSpeed: Number.NaN, variationIndex: 3, variationNext: 32767, channels: [] },
    { animationId: 8, duration: 1001, movingSpeed: 1e-3, channels: [channels[1]] },
  ];
  const plain = extras.map(({ animationId, duration, channels: clipChannels }) => ({ animationId, duration, channels: clipChannels }));
  for (const clips of [extras, plain]) {
    const block = arrayBufferOf(encodeWvaAnimations(3, clips));
    const expected = decodeWvaAnimations(block.slice(0), 3);
    const { packed } = viaWorker(block, 3);
    const unpacked = unpackWvaAnimations(packed);
    assert.equal(packed.span, 3);
    assert.deepEqual(summarized(clipDifferences(expected, unpacked)), []);
    assert.deepEqual(unpacked, expected);
  }
});

test('every cached sidecar decodes to the same bits through the worker protocol', { skip }, () => {
  assert.ok(rigs.length > 0);
  let channels = 0;
  for (const { path, skeleton, sidecar } of rigs) {
    const bones = skeleton.parents.length;
    const expected = decodeWvaAnimations(sidecar.slice(0), bones);
    const { packed, transfers, messageBytes } = viaWorker(sidecar, bones);
    assert.equal(transfers, 3, path);
    assert.ok(messageBytes < 1024, `${path}: the message is numbers and three transferred buffers (${messageBytes} B)`);
    assert.deepEqual(packed.cost, decodedAnimationResidencyCost(expected), `${path}: residency`);
    const clips = unpackWvaAnimations(packed);
    assert.ok(clips.every(lazy), `${path}: arrival builds no channel list`);
    assert.equal(skinnedClipsBoneSpan(clips), skinnedClipsBoneSpan(expected), `${path}: bone span`);
    assert.equal(decodedAnimationResidencyCost(clips), packed.cost);
    assert.ok(clips.every(lazy), `${path}: span and residency build no channel list`);
    assert.deepEqual(summarized(clipDifferences(expected, clips)), [], path);
    assert.deepEqual(decodedResidencyCost(clips), packed.cost, `${path}: a full walk agrees`);
    channels += expected.reduce((sum, clip) => sum + clip.channels.length, 0);
  }
  assert.ok(channels > 100_000, 'the cache holds the city\'s character rigs');
});

test('clips compiled from worker-decoded sidecars are identical to the synchronous decoder\'s', { skip }, () => {
  let compared = 0;
  for (const { path, skeleton, sidecar } of rigs) {
    const bones = skeleton.parents.length;
    const expected = decodeWvaAnimations(sidecar.slice(0), bones);
    if (expected.length === 0) continue;
    const clips = unpackWvaAnimations(viaWorker(sidecar, bones).packed);
    const sync = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), skeleton, 2);
    const worker = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), skeleton, 2);
    if (!sync || !worker) continue;
    assert.equal(addSkinnedClips(worker, clips), addSkinnedClips(sync, expected), path);
    assert.deepEqual(summarized(compiledDifferences(sync.clips, worker.clips)), [], `${path}: clips`);
    assert.deepEqual(summarized(compiledDifferences(sync.overlayClips, worker.overlayClips)), [], `${path}: overlays`);
    compared += worker.clips.size;
  }
  assert.ok(compared > 1000, `compiled ${compared} clips`);
});

test('HumanMale arrives through the decode client in constant work and builds clips only on demand', { skip }, async t => {
  const rig = rigs.find(({ path }) => path === 'Character\\Human\\Male\\HumanMale.m2');
  assert.ok(rig, 'HumanMale is in the benchmark cache');
  const bones = rig.skeleton.parents.length;
  let handler;
  let posted;
  const client = new WvaAnimationDecodeClient(() => ({
    set onmessage(value) { handler = value; }, get onmessage() { return handler; },
    onerror: null, onmessageerror: null,
    postMessage(request, transfer) { posted = structuredClone(request, { transfer }); },
    terminate() {},
  }));
  const pending = client.decode(rig.sidecar.slice(0), bones);
  const { response, transfer } = decodeWvaAnimationRequest(posted);
  const message = structuredClone(response, { transfer });
  const started = performance.now();
  handler({ data: message });
  const handled = performance.now() - started;
  const { clips, cost } = await pending;
  client.dispose();
  t.diagnostic(`message handler: ${handled.toFixed(3)} ms for ${clips.length} clips`);
  assert.ok(clips.length > 150);
  assert.ok(clips.every(lazy), 'the handler built no channel list');
  assert.equal(cost, message.packed.cost);
  const expected = decodeWvaAnimations(rig.sidecar.slice(0), bones);
  const one = clips.length >> 1;
  assert.deepEqual(summarized(clipDifferences([expected[one]], [clips[one]])), []);
  assert.equal(clips.filter(clip => !lazy(clip)).length, 1, 'reading one clip builds one clip');
});
