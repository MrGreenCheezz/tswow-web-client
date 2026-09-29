import assert from 'node:assert/strict';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import * as THREE from 'three';
import { encodeWvaAnimations } from '../tools/wvm.mjs';
import { decodeWvaAnimations } from '../dist/code/browser/Wvm.js';
import {
  addSkinnedClips, buildSkinnedTemplateFrom, mergeSkinnedClips, skinnedClipsBoneSpan,
} from '../dist/code/browser/AnimatedModel.js';
import { EnvironmentClient, decodedResidencyCost } from '../dist/code/browser/Terrain.js';
import {
  decodeWvaAnimationRequest, decodedAnimationResidencyCost, unpackWvaAnimations,
} from '../dist/code/browser/WvaAnimationDecode.js';
import { WvaAnimationDecodeClient, WvaAnimationPayloadError } from '../dist/code/browser/WvaAnimationDecodeClient.js';

// Worker-decoded sidecars (the packed protocol), the environment cache that keeps them, and the
// compiled-clip cache behind it: nothing is built on arrival, a set a template compiled from is not
// fetched again after eviction, and byte-identical sidecars decode and compile once.

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
};
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Two bones, three clips; `firstId` makes otherwise equal blocks distinct. */
function sidecar(firstId = 10, bones = 2) {
  const channels = [
    { bone: 1, kind: 0, times: Uint32Array.of(0, 500), values: Float32Array.of(0.5, 0, 0, 1, 0, 0) },
    { bone: 1, kind: 1, times: Uint32Array.of(0, 500), values: Int16Array.of(0, 0, 0, 32767, 100, -200, 300, 32000) },
    { bone: 0, kind: 2, times: Uint32Array.of(250), values: Float32Array.of(1, 1.5, 2) },
  ];
  return arrayBuffer(encodeWvaAnimations(bones, [
    { animationId: firstId, duration: 1000, blendTime: 150, movingSpeed: 3.5,
      variationIndex: 0, variationNext: 2, channels },
    { animationId: firstId + 1, duration: 750, channels: channels.slice(1) },
    { animationId: firstId + 2, duration: 500, channels: [channels[0]] },
  ]));
}

function rig(pivot = 2) {
  return {
    parents: Int16Array.from([-1, 0]),
    flags: Uint16Array.from([0, 0]),
    pivots: Float32Array.from([0, 0, 0, pivot, 0, 0]),
    clips: [],
    animations: [10, 11, 12, 20, 21, 22],
    globalChannels: [],
  };
}

function template(skeleton = rig()) {
  const built = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), skeleton, 2);
  assert.ok(built);
  return built;
}

const lazy = clip => typeof Object.getOwnPropertyDescriptor(clip, 'channels')?.get === 'function';

/** Every `animations()` request by path; each answers with `bytesFor(path)`. */
function stubFetch(t, bytesFor) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    const path = new URL(String(url)).searchParams.get('path');
    requests.push(path);
    return { ok: true, status: 200, arrayBuffer: async () => bytesFor(path) };
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

async function frame(client, ...names) {
  client.beginResourceFrame();
  const answers = names.map(name => client.animations(name, 2, 'critical'));
  client.endResourceFrame();
  await settle();
  return answers;
}

test('a worker-decoded set arrives with no channel list built and builds each on first read', async () => {
  const bytes = sidecar();
  const expected = decodeWvaAnimations(bytes.slice(0), 2);
  const client = new WvaAnimationDecodeClient(() => undefined);
  const { clips, cost } = await client.decode(bytes, 2);
  client.dispose();
  assert.equal(clips.length, 3);
  assert.ok(clips.every(lazy), 'arrival builds no channel list');
  assert.deepEqual(cost, decodedAnimationResidencyCost(expected), 'the same bytes the per-clip backings held');
  assert.equal(decodedAnimationResidencyCost(clips), cost, 'residency answers from the worker number');
  assert.equal(skinnedClipsBoneSpan(clips), skinnedClipsBoneSpan(expected));
  assert.ok(clips.every(lazy), 'neither accounting nor rig validation builds a channel list');
  assert.deepEqual(Object.keys(clips[0]), Object.keys(expected[0]), 'the decoder\'s fields, in its order');
  assert.deepEqual(clips[1].channels, expected[1].channels);
  assert.deepEqual(clips.map(lazy), [true, false, true], 'one read builds exactly that clip');
  const built = clips[1].channels;
  assert.equal(clips[1].channels, built, 'built once, then an ordinary data property');
  assert.deepEqual(Object.getOwnPropertyDescriptor(clips[1], 'channels'),
    { value: built, writable: true, enumerable: true, configurable: true });
  assert.deepEqual(clips, expected);
  assert.deepEqual(decodedResidencyCost(clips), cost, 'a full walk agrees with the worker number');
});

test('merging a worker-decoded set builds channel lists only for the clips it compiles', async () => {
  const bytes = sidecar();
  const expected = decodeWvaAnimations(bytes.slice(0), 2);
  const client = new WvaAnimationDecodeClient(() => undefined);
  const { clips } = await client.decode(bytes, 2);
  client.dispose();
  const packedTemplate = template();
  assert.deepEqual(mergeSkinnedClips(packedTemplate, clips, { wanted: [12], maxClips: 1, milliseconds: Infinity }),
    { added: 1, complete: false }, 'no validation walk stands before the first compiled clip');
  assert.deepEqual(clips.map(lazy), [true, true, false]);
  assert.equal(addSkinnedClips(packedTemplate, clips), 2);
  assert.ok(!clips.some(lazy));
  const syncTemplate = template();
  addSkinnedClips(syncTemplate, expected);
  for (const id of [10, 11, 12]) {
    const [a, b] = [packedTemplate.clips.get(id), syncTemplate.clips.get(id)];
    assert.notEqual(a, b);
    assert.deepEqual(a.tracks.map(track => [track.name, [...track.times], [...track.values]]),
      b.tracks.map(track => [track.name, [...track.times], [...track.values]]));
    assert.deepEqual(a.userData, b.userData);
  }
});

test('an evicted set a template compiled from comes back as the same objects, unfetched and uncompiled', async t => {
  const requests = stubFetch(t, path => sidecar(path === 'A.m2' ? 10 : 20));
  const client = new EnvironmentClient('ws://example.test/world', Date.now, 64, 256, 1);
  t.after(() => client.dispose());
  await frame(client, 'A.m2');
  // Only the template holds the set from here on; the test keeps a weak handle to check identity.
  const { first, compiled, handle } = await (async () => {
    const [clips] = await frame(client, 'A.m2');
    assert.ok(clips);
    const built = template();
    assert.equal(addSkinnedClips(built, clips), 3);
    return { first: built, compiled: built.clips.get(10), handle: new WeakRef(clips) };
  })();

  // The merged template no longer asks; another rig takes the only slot.
  await frame(client, 'B.m2');
  const [other] = await frame(client, 'B.m2');
  assert.equal(client.stats.residentAnimations, 1);
  assert.equal(client.stats.animationDecodedTypedBackingBytes, decodedAnimationResidencyCost(other).typedBackingBytes,
    'the evicted set is the template\'s now, not charged to the cache');
  await settle();
  gc();
  await settle();

  const [again] = await frame(client, 'A.m2');
  assert.ok(again);
  assert.equal(again, handle.deref(), 'the same clip objects, kept alive by the template alone');
  assert.deepEqual(requests.filter(path => path === 'A.m2'), ['A.m2'], 'no second request');
  const second = template();
  assert.equal(addSkinnedClips(second, again), 3);
  assert.equal(second.clips.get(10), compiled, 'every compiled clip is a cache hit');
  assert.equal(client.stats.residentAnimations, 1);
  assert.equal(first.clips.get(10), compiled);
});

test('an evicted set nothing holds is released and fetched again', async t => {
  const requests = stubFetch(t, path => sidecar(path === 'A.m2' ? 10 : path === 'B.m2' ? 20 : 30));
  const client = new EnvironmentClient('ws://example.test/world', Date.now, 64, 256, 1);
  t.after(() => client.dispose());

  // Never compiled: eviction keeps no handle at all.
  await frame(client, 'A.m2');
  await frame(client, 'B.m2');
  await frame(client, 'B.m2');
  await frame(client, 'A.m2');
  assert.deepEqual(requests.filter(path => path === 'A.m2'), ['A.m2', 'A.m2']);
  await settle();

  // Compiled by a template that is then dropped: the weak handle does not keep it alive.
  await (async () => {
    const [clips] = await frame(client, 'A.m2');
    assert.ok(clips);
    addSkinnedClips(template(), clips);
  })();
  await frame(client, 'C.m2');
  await frame(client, 'C.m2');
  await settle();
  gc();
  await settle();
  await frame(client, 'A.m2');
  assert.deepEqual(requests.filter(path => path === 'A.m2'), ['A.m2', 'A.m2', 'A.m2']);
});

/** Uses the real worker protocol and structured clone; only scheduling is controlled. */
class ControlledWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  requests = [];
  responses = [];
  constructor(forget = false) { this.forget = forget; }
  postMessage(request, transfer) {
    const received = structuredClone(request, { transfer });
    this.requests.push(this.forget ? { ...received, known: [] } : received);
  }
  finish() {
    const { response, transfer } = decodeWvaAnimationRequest(this.requests.shift());
    const received = structuredClone(response, { transfer });
    this.responses.push(received);
    this.onmessage?.({ data: received });
  }
  terminate() {}
}

test('byte-identical sidecars decode once, share one set, are charged once and compile once', async t => {
  const workers = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class extends ControlledWorker {
    constructor() { super(); workers.push(this); }
  };
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else delete globalThis.Worker;
  });
  const requests = stubFetch(t, () => sidecar());
  const client = new EnvironmentClient('ws://example.test/world');
  t.after(() => client.dispose());
  client.animations('HumanMalGuard.m2', 2);
  client.animations('HumanMalGuard_withHelm.m2', 2);
  await settle();
  workers[0].finish();
  await settle();
  workers[0].finish();
  await settle();
  assert.deepEqual(requests, ['HumanMalGuard.m2', 'HumanMalGuard_withHelm.m2']);
  const [decoded, duplicate] = workers[0].responses;
  assert.ok(decoded.packed);
  assert.deepEqual(duplicate, { id: 2, duplicate: decoded.packed.digest }, 'the second copy is not decoded');
  const guard = client.animations('HumanMalGuard.m2', 2);
  const helm = client.animations('HumanMalGuard_withHelm.m2', 2);
  assert.ok(guard);
  assert.equal(helm, guard, 'one set for both rigs');
  assert.equal(client.stats.residentAnimations, 2);
  assert.equal(client.stats.animationDecodedTypedBackingBytes, decoded.packed.cost.typedBackingBytes, 'charged once');

  // Two models, two decoded skeletons, one rig shape: the clips compile once.
  const guardRig = rig();
  const helmRig = { ...rig(), parents: guardRig.parents.slice(), pivots: guardRig.pivots.slice() };
  const [guardTemplate, helmTemplate] = [template(guardRig), template(helmRig)];
  addSkinnedClips(guardTemplate, guard);
  addSkinnedClips(helmTemplate, helm);
  for (const id of [10, 11, 12]) {
    assert.equal(helmTemplate.clips.get(id), guardTemplate.clips.get(id));
    assert.equal(helmTemplate.overlayClips.get(id), guardTemplate.overlayClips.get(id));
  }
  const otherShape = template(rig(5));
  addSkinnedClips(otherShape, guard);
  assert.notEqual(otherShape.clips.get(10), guardTemplate.clips.get(10), 'another rig shape compiles its own');
  assert.equal(otherShape.clips.get(10).tracks[0].values[0], 5.5);
  assert.equal(guardTemplate.clips.get(10).tracks[0].values[0], 2.5);
});

test('the shared charge survives until the last key holding the set is evicted', async t => {
  stubFetch(t, path => sidecar(path === 'Other.m2' ? 50 : path === 'Third.m2' ? 70 : 10));
  const client = new EnvironmentClient('ws://example.test/world', Date.now, 64, 256, 2);
  t.after(() => client.dispose());
  await frame(client, 'Guard.m2', 'Helm.m2');
  const [guard, helm] = await frame(client, 'Guard.m2', 'Helm.m2');
  assert.equal(guard, helm);
  const cost = decodedAnimationResidencyCost(guard).typedBackingBytes;
  assert.equal(client.stats.animationDecodedTypedBackingBytes, cost);
  await frame(client, 'Helm.m2', 'Other.m2');
  await frame(client, 'Helm.m2', 'Other.m2');
  assert.equal(client.stats.residentAnimations, 2);
  assert.equal(client.stats.animationDecodedTypedBackingBytes, cost * 2, 'Helm still holds the shared set');
  await frame(client, 'Other.m2', 'Third.m2');
  await frame(client, 'Other.m2', 'Third.m2');
  assert.equal(client.stats.residentAnimations, 2);
  assert.equal(client.stats.animationDecodedTypedBackingBytes, cost * 2, 'Other plus Third, the guard set is gone');
});

test('a worker that decodes a held block anyway still yields the one set', async () => {
  const workers = [];
  const client = new WvaAnimationDecodeClient(() => {
    const worker = new ControlledWorker(true);
    workers.push(worker);
    return worker;
  });
  const first = client.decode(sidecar(), 2);
  workers[0].finish();
  const { clips } = await first;
  const second = client.decode(sidecar(), 2);
  workers[0].finish();
  assert.ok(workers[0].responses[1].packed, 'decoded a second time');
  assert.equal((await second).clips, clips);
  client.dispose();
});

test('identical bytes asked for another rig are decoded for that rig, never taken from the registry', async () => {
  const client = new WvaAnimationDecodeClient(() => undefined);
  const { clips } = await client.decode(sidecar(), 2);
  await assert.rejects(client.decode(sidecar(), 3), error =>
    error instanceof WvaAnimationPayloadError && /rigged for 2 bones/.test(error.message));
  assert.equal((await client.decode(sidecar(), 2)).clips, clips);
  client.dispose();
});

test('retained-resource accounting reports the one backing without building a clip', async t => {
  stubFetch(t, () => sidecar());
  const client = new EnvironmentClient('ws://example.test/world');
  t.after(() => client.dispose());
  await frame(client, 'Guard.m2', 'Helm.m2');
  const [clips] = await frame(client, 'Guard.m2', 'Helm.m2');
  const seen = [];
  client.visitRetainedResources({
    referenceCpu: (owner, view) => seen.push([owner, view.buffer.byteLength]),
    referenceGpuBuffer() {}, referenceGpuTexture() {}, referenceGpuRenderTarget() {}, referenceUnsupported() {},
  });
  assert.deepEqual(seen, [[clips, client.stats.animationDecodedTypedBackingBytes]]);
  assert.ok(clips.every(lazy));
});
