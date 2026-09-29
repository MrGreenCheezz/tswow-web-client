import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeWvaAnimations } from '../tools/wvm.mjs';
import { decodeWvaAnimations } from '../dist/code/browser/Wvm.js';
import { EnvironmentClient, decodedResidencyCost } from '../dist/code/browser/Terrain.js';
import { decodeWvaAnimationRequest, unpackWvaAnimations } from '../dist/code/browser/WvaAnimationDecode.js';
import { WvaAnimationDecodeClient, WVA_ANIMATION_DECODE_LIMIT } from '../dist/code/browser/WvaAnimationDecodeClient.js';

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
};
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
/** `firstId` makes otherwise equal blocks distinct: identical sidecars share one decoded set. */
function animations(firstId = 7) {
  const channels = [
    { bone: 0, kind: 0, times: Uint32Array.of(0, 250), values: Float32Array.of(1, -2, 3, 4, 5, -6) },
    { bone: 1, kind: 1, times: Uint32Array.of(500), values: Int16Array.of(-32768, -1, 0, 32767) },
    { bone: 1, kind: 2, times: Uint32Array.of(750), values: Float32Array.of(0.25, 0.5, 2) },
    { bone: 0, kind: 0, times: new Uint32Array(), values: new Float32Array() },
  ];
  return arrayBuffer(encodeWvaAnimations(2, [
    { animationId: firstId, duration: 1000, blendTime: 150, movingSpeed: -2.5,
      variationIndex: 0, variationNext: 1, channels },
    { animationId: 8, duration: 1000, channels },
    { animationId: 9, duration: 1000, channels: [] },
  ]));
}

/** Uses real structured-clone/transfer and decoder protocol; only worker scheduling is controlled. */
class ControlledWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  requests = [];
  terminated = false;
  postMessage(request, transfer) {
    this.requests.push(structuredClone(request, { transfer }));
  }
  finish() {
    const request = this.requests.shift();
    assert.ok(request);
    const { response, transfer } = decodeWvaAnimationRequest(request);
    const received = structuredClone(response, { transfer });
    assert.ok(transfer.every(buffer => buffer.byteLength === 0));
    this.onmessage?.({ data: received });
    return received;
  }
  terminate() { this.terminated = true; }
}
function controlledClient() {
  const workers = [];
  const client = new WvaAnimationDecodeClient(() => {
    const worker = new ControlledWorker();
    workers.push(worker);
    return worker;
  });
  return { client, workers };
}
function browserWorker(t) {
  const workers = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class extends ControlledWorker {
    constructor(url, options) {
      super();
      assert.match(url.pathname, /WvaAnimationDecode\.worker\.ts$/);
      assert.equal(options.type, 'module');
      workers.push(this);
    }
  };
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else delete globalThis.Worker;
  });
  return workers;
}
function stubFetch(t, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = callback;
  t.after(() => { globalThis.fetch = original; });
}
const response = data => ({ ok: true, status: 200, arrayBuffer: async () => data });

test('worker payload preserves metadata, channel types, one shared backing and exact residency after transfer', () => {
  const input = animations();
  const expected = decodeWvaAnimations(input.slice(0), 2);
  const request = structuredClone({ id: 13, data: input, bones: 2 }, { transfer: [input] });
  assert.equal(input.byteLength, 0, 'request buffer is transferred, not copied');
  const { response: message, transfer } = decodeWvaAnimationRequest(request);
  assert.equal(message.id, 13);
  assert.deepEqual(message.packed.cost, decodedResidencyCost(expected),
    'one flat backing costs exactly what the per-clip backings did');
  assert.equal(message.packed.span, 2);
  assert.deepEqual(transfer, [message.packed.clipTable.buffer, message.packed.channelTable.buffer,
    message.packed.keys.buffer], 'clip table, channel table and keys: three transfers whatever the clip count');
  const received = structuredClone(message, { transfer });
  assert.ok(transfer.every(buffer => buffer.byteLength === 0));
  const clips = unpackWvaAnimations(received.packed);
  assert.deepEqual(clips, expected);
  assert.deepEqual(decodedResidencyCost(clips), received.packed.cost);
  const [first, second] = clips;
  assert.ok(first.channels.every(channel => channel.times instanceof Float32Array && channel.values instanceof Float32Array));
  assert.equal(first.channels[0].times.buffer, first.channels[1].values.buffer);
  assert.equal(first.channels[0].times.buffer, second.channels[0].times.buffer, 'one transferred backing');
  first.channels[0].values[0] = 111;
  assert.equal(second.channels[0].values[0], 1, 'independent clips remain independently writable');
});

test('worker protocol retains decoder preflight errors and never returns a partial result', () => {
  for (const request of [
    { id: 1, data: new ArrayBuffer(4), bones: 2 },
    { id: 2, data: animations(), bones: 1 },
  ]) {
    const { response: message, transfer } = decodeWvaAnimationRequest(request);
    assert.equal(message.id, request.id);
    assert.equal(typeof message.error, 'string');
    assert.equal('result' in message, false);
    assert.deepEqual(transfer, []);
  }
});

test('decode worker is lazy, serial, bounded by both network lanes, and reused across completions', async () => {
  assert.equal(WVA_ANIMATION_DECODE_LIMIT, 2);
  const { client, workers } = controlledClient();
  assert.equal(workers.length, 0);
  const a = animations(), b = animations(), c = animations();
  const first = client.decode(a, 2);
  const second = client.decode(b, 2);
  await assert.rejects(client.decode(c, 2), /queue is full/);
  assert.equal(a.byteLength, 0);
  assert.ok(b.byteLength > 0, 'waiting input is retained outside the worker mailbox');
  assert.ok(c.byteLength > 0, 'rejected work never transfers ownership');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests.length, 1);
  workers[0].finish();
  assert.equal(b.byteLength, 0);
  assert.equal(workers[0].requests.length, 1);
  workers[0].finish();
  assert.deepEqual((await first).clips, (await second).clips);
  assert.equal(workers.length, 1);
  client.dispose();
  assert.equal(workers[0].terminated, true);
  await assert.rejects(client.decode(animations(), 2), { name: 'AbortError' });
});

test('queued cancellation releases its slot without transferring or interrupting active work', async () => {
  const { client, workers } = controlledClient();
  const first = client.decode(animations(), 2);
  const cancel = new AbortController(), input = animations();
  const second = client.decode(input, 2, cancel.signal);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  cancel.abort();
  await rejected;
  assert.ok(input.byteLength > 0);
  assert.equal(workers[0].terminated, false);
  const replacement = client.decode(animations(), 2);
  workers[0].finish();
  workers[0].finish();
  await Promise.all([first, replacement]);
  client.dispose();
});

test('active cancellation terminates its worker and late replies cannot settle a replacement job', async () => {
  const { client, workers } = controlledClient();
  const cancel = new AbortController();
  const first = client.decode(animations(), 2, cancel.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const oldHandler = workers[0].onmessage;
  const next = client.decode(animations(), 2);
  let nextSettled = false;
  void next.then(() => { nextSettled = true; });
  cancel.abort();
  await rejected;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  const late = decodeWvaAnimationRequest(workers[0].requests[0]).response;
  oldHandler({ data: late });
  await Promise.resolve();
  assert.equal(nextSettled, false);
  workers[1].finish();
  await next;
  client.dispose();
});

test('dispose cancels active and queued decode, removes listeners, and never starts another worker', async () => {
  const { client, workers } = controlledClient();
  const signals = [new AbortController(), new AbortController()];
  const first = client.decode(animations(), 2, signals[0].signal);
  const input = animations();
  const second = client.decode(input, 2, signals[1].signal);
  const rejected = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })];
  client.dispose();
  client.dispose();
  for (const controller of signals) controller.abort();
  await Promise.all(rejected);
  assert.ok(input.byteLength > 0);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].onmessage, null);
  assert.equal(workers[0].onerror, null);
  assert.equal(workers[0].onmessageerror, null);
});

test('worker failure rejects valid input without a synchronous fallback and a new request can recover', async () => {
  for (const fail of [
    worker => worker.onerror({ message: 'worker load failed' }),
    worker => worker.onmessageerror({}),
    worker => worker.onmessage({ data: { id: 1, result: { clips: [], cost: { typedBackingBytes: -1, numericArrayElements: 0 } } } }),
    worker => worker.onmessage({ data: { id: 99, error: 'stale id' } }),
  ]) {
    const { client, workers } = controlledClient();
    const request = client.decode(animations(), 2);
    const rejected = assert.rejects(request);
    fail(workers[0]);
    await rejected;
    assert.equal(workers[0].terminated, true);
    const recovered = client.decode(animations(), 2);
    assert.equal(workers.length, 2);
    workers[1].finish();
    assert.equal((await recovered).clips.length, 3);
    client.dispose();
  }
});

test('worker creation and postMessage failures reject without decoding on the caller thread', async () => {
  for (const factory of [
    () => { throw new Error('blocked worker'); },
    () => Object.assign(new ControlledWorker(), { postMessage() { throw new Error('transfer failed'); } }),
  ]) {
    const client = new WvaAnimationDecodeClient(factory);
    await assert.rejects(client.decode(animations(), 2), /blocked worker|transfer failed/);
    client.dispose();
  }
});

test('Node fallback preserves sync decoder data and reports malformed payload errors', async () => {
  const client = new WvaAnimationDecodeClient(() => undefined);
  const input = animations();
  const expected = decodeWvaAnimations(input, 2);
  const decoded = await client.decode(input, 2);
  assert.deepEqual(decoded.clips, expected);
  assert.deepEqual(decoded.cost, decodedResidencyCost(expected));
  assert.ok(input.byteLength > 0);
  await assert.rejects(client.decode(new ArrayBuffer(4), 2), /Not a WVA1/);
  client.dispose();
});

test('EnvironmentClient holds network lanes until worker completion and publishes exact worker cost', async t => {
  const workers = browserWorker(t), fetched = [];
  const ids = { 'First.m2': 7, 'Second.m2': 17, 'Third.m2': 27 };
  stubFetch(t, async url => {
    fetched.push(String(url));
    return response(animations(ids[new URL(url).searchParams.get('path')]));
  });
  const client = new EnvironmentClient('ws://example.test/world');
  t.after(() => client.dispose());
  client.animations('First.m2', 2);
  client.animations('Second.m2', 2);
  client.animations('Third.m2', 2);
  await settle();
  assert.equal(fetched.length, 2);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests.length, 1);
  assert.equal(client.stats.activeAnimations, 2);
  assert.equal(client.stats.queuedAnimations, 1);
  assert.equal(client.stats.residentAnimations, 0);
  const first = workers[0].finish().packed;
  await settle();
  assert.deepEqual(client.animations('First.m2', 2), decodeWvaAnimations(animations(7), 2));
  assert.equal(client.stats.animationDecodedTypedBackingBytes, first.cost.typedBackingBytes);
  assert.equal(fetched.length, 3);
  workers[0].finish();
  await settle();
  workers[0].finish();
  await settle();
  assert.equal(client.stats.residentAnimations, 3);
  assert.equal(client.stats.activeAnimations, 0);
  assert.equal(client.stats.animationDecodedTypedBackingBytes, first.cost.typedBackingBytes * 3);
});

test('EnvironmentClient retains malformed reload, response/rig guards, and decoded hard limits with a worker', async t => {
  const workers = browserWorker(t), requests = [];
  let now = 0;
  stubFetch(t, async (url, init) => {
    const name = new URL(url).searchParams.get('path');
    requests.push({ name, cache: init.cache });
    if (name === 'Oversized.m2') return { ...response(animations()), headers: new Headers({ 'content-length': '99999999' }) };
    if (name === 'Malformed.m2' && now === 0) return response(new ArrayBuffer(4));
    return response(animations());
  });
  const client = new EnvironmentClient('ws://example.test/world', () => now, 64, 256, 128, {
    animationEntryTypedBackingBytes: 1,
  });
  t.after(() => client.dispose());
  client.animations('Oversized.m2', 2);
  client.animations('WrongRig.m2', 1);
  await settle();
  assert.equal(workers.length, 0, 'response and rig guards run before worker allocation or transfer');
  assert.equal(client.stats.failedAnimations, 2);
  client.animations('Malformed.m2', 2);
  await settle();
  const error = workers[0].finish();
  assert.match(error.error, /Not a WVA1/);
  await settle();
  assert.equal(client.stats.deferredAnimations, 1);
  assert.equal(client.stats.failedAnimations, 2);
  now = 2000;
  client.animations('Malformed.m2', 2);
  await settle();
  assert.equal(requests.at(-1).cache, 'reload');
  workers[0].finish();
  await settle();
  assert.equal(client.stats.deferredAnimations, 0);
  assert.equal(client.stats.failedAnimations, 3, 'decoded hard limit remains terminal rather than retried');
  const count = requests.length;
  client.animations('Malformed.m2', 2);
  await settle();
  assert.equal(requests.length, count);
});

test('EnvironmentClient dispose cancels decode and a late worker completion never republishes a world', async t => {
  const workers = browserWorker(t), statuses = [];
  stubFetch(t, async () => response(animations()));
  const client = new EnvironmentClient('ws://example.test/world');
  client.onStatus = (...args) => statuses.push(args);
  client.animations('OldWorld.m2', 2);
  client.animations('QueuedOldWorld.m2', 2);
  await settle();
  const worker = workers[0], oldHandler = worker.onmessage, request = worker.requests[0];
  client.dispose();
  oldHandler({ data: decodeWvaAnimationRequest(request).response });
  await settle();
  assert.equal(worker.terminated, true);
  assert.equal(workers.length, 1);
  assert.equal(client.stats.activeAnimations, 0);
  assert.equal(client.stats.residentAnimations, 0);
  assert.equal(client.stats.animationDecodedTypedBackingBytes, 0);
  assert.deepEqual(statuses, []);
});

test('worker infrastructure failure follows demand backoff without marking a valid cached payload corrupt', async t => {
  const workers = browserWorker(t), cacheModes = [];
  let now = 0;
  stubFetch(t, async (_url, init) => {
    cacheModes.push(init.cache);
    return response(animations());
  });
  const client = new EnvironmentClient('ws://example.test/world', () => now);
  t.after(() => client.dispose());
  client.animations('WorkerFailed.m2', 2);
  await settle();
  workers[0].onerror({ message: 'worker unavailable' });
  await settle();
  assert.equal(client.stats.deferredAnimations, 1);
  now = 1999;
  client.animations('WorkerFailed.m2', 2);
  await settle();
  assert.equal(cacheModes.length, 1);
  now = 2000;
  client.animations('WorkerFailed.m2', 2);
  await settle();
  assert.deepEqual(cacheModes, [undefined, undefined]);
  assert.equal(workers.length, 2);
  workers[1].finish();
  await settle();
  assert.equal(client.stats.residentAnimations, 1);
  assert.equal(client.stats.deferredAnimations, 0);
});

test('a late inactive worker result cannot displace the current frame animation cache pin', async t => {
  const workers = browserWorker(t), requests = [];
  stubFetch(t, url => new Promise(resolve => requests.push({
    name: new URL(url).searchParams.get('path'), resolve,
  })));
  const client = new EnvironmentClient('ws://example.test/world', Date.now, 64, 256, 1);
  t.after(() => client.dispose());
  client.beginResourceFrame();
  client.animations('Old.m2', 2);
  client.endResourceFrame();
  await settle();
  client.beginResourceFrame();
  client.animations('Current.m2', 2);
  client.endResourceFrame();
  await settle();
  requests.find(request => request.name === 'Current.m2').resolve(response(animations()));
  await settle();
  workers[0].finish();
  await settle();
  const current = client.animations('Current.m2', 2);
  requests.find(request => request.name === 'Old.m2').resolve(response(animations()));
  await settle();
  workers[0].finish();
  await settle();
  assert.equal(client.stats.residentAnimations, 1);
  assert.equal(client.animations('Current.m2', 2), current);
  client.beginResourceFrame();
  client.animations('Old.m2', 2);
  client.endResourceFrame();
  await settle();
  assert.equal(requests.filter(request => request.name === 'Old.m2').length, 2);
});
