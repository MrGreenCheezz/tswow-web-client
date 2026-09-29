import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentClient, ENVIRONMENT_MODEL_QUEUE_LIMIT } from '../dist/code/browser/Terrain.js';
import { IMAGE_RETRY_BACKOFF_MS } from '../dist/code/browser/CharacterAtlas.js';

const settle = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
};
const modelResponse = (vertices = 0) => {
  const data = new ArrayBuffer(16 + vertices * 20);
  new Uint8Array(data).set([0x57, 0x56, 0x4d, 0x31]);
  new DataView(data).setUint32(4, vertices, true);
  return { ok: true, status: 200, arrayBuffer: async () => data };
};
function setup(t, fetch, ...options) {
  t.mock.method(globalThis, 'fetch', fetch);
  const client = new EnvironmentClient('ws://example.test/world', ...options);
  t.after(() => client.dispose());
  return client;
}
function frame(client, names, scan = false) {
  client.beginResourceFrame();
  if (names !== undefined) client.retainModelPrefetch(names);
  if (scan) for (const name of names) client.prefetchModel(name);
  client.endResourceFrame();
}
function stalled(t, ...options) {
  const requests = [];
  const client = setup(t, url => new Promise(resolve => {
    requests.push({ name: new URL(String(url)).searchParams.get('path'), resolve });
  }), ...options);
  t.after(async () => {
    client.dispose();
    for (const request of requests) request.resolve(modelResponse());
    await settle();
  });
  return { client, requests };
}

test('a background scan survives three skipped frames and completes without another scan', async t => {
  const { client, requests } = stalled(t);
  const names = Array.from({ length: 16 }, (_, id) => `Scenery${id}.m2`);
  frame(client, names, true);
  await settle();
  assert.equal(client.stats.activeModels, 3);
  assert.equal(client.stats.queuedModels, 13);
  for (let skipped = 0; skipped < 3; skipped++) frame(client, names);
  assert.equal(client.stats.queuedModels, 13, 'ordinary frame cleanup must not cancel the prefetch scan');
  let completed = 0;
  for (let round = 0; round < 16 && completed < names.length; round++) {
    const batch = requests.slice(completed);
    completed += batch.length;
    for (const request of batch) request.resolve(modelResponse());
    await settle();
  }
  assert.equal(completed, names.length);
  assert.equal(new Set(requests.map(request => request.name)).size, names.length);
  assert.equal(client.stats.residentModels, names.length);
  assert.equal(client.stats.queuedModels, 0);
});

test('moving out of the prefetch footprint cancels only obsolete queued work', async t => {
  const { client, requests } = stalled(t);
  const names = Array.from({ length: 16 }, (_, id) => `Scenery${id}.m2`);
  frame(client, names, true);
  await settle();
  frame(client, ['Scenery15.m2']);
  assert.equal(client.stats.queuedModels, 1);
  assert.equal(client.stats.activeModels, 3, 'active I/O keeps its existing ownership');
  const active = [...requests];
  for (const request of active) request.resolve(modelResponse());
  await settle();
  assert.deepEqual(requests.slice(3).map(request => request.name), ['Scenery15.m2']);
  frame(client, undefined);
  client.prefetchModel('Scenery14.m2');
  assert.equal(client.stats.queuedModels, 0, 'an undrawn frame releases all speculative interest');
});

test('empty frames and disposal release speculative queues', async t => {
  const { client } = stalled(t);
  const names = Array.from({ length: 16 }, (_, id) => `Scenery${id}.m2`);
  frame(client, names, true);
  await settle();
  frame(client, undefined);
  assert.equal(client.stats.queuedModels, 0);
  frame(client, names, true);
  assert.equal(client.stats.queuedModels, 13, 'cancelled paths can be queued again on re-entry');
  client.dispose();
  frame(client, names, true);
  assert.equal(client.stats.queuedModels, 0);
});

test('visible scenery and critical units promote ahead of speculative scenery', async t => {
  const { client, requests } = stalled(t);
  client.beginResourceFrame();
  client.retainModelPrefetch(['Background.m2', 'Visible.m2', 'Player.m2']);
  for (const name of ['Background.m2', 'Visible.m2', 'Player.m2']) client.prefetchModel(name);
  client.model('Visible.m2', 'normal');
  client.model('Player.m2', 'critical');
  client.endResourceFrame();
  await settle();
  assert.deepEqual(requests.map(request => request.name), ['Player.m2', 'Visible.m2', 'Background.m2']);
  assert.equal(client.stats.activeModels, 3, 'promoted names do not create duplicate requests');
});

test('prefetch never bypasses decoded entry or byte budgets', async t => {
  const names = Array.from({ length: 8 }, (_, id) => `Scenery${id}.m2`);
  const client = setup(t, async () => modelResponse(), Date.now, 64, 2, 1);
  frame(client, names, true);
  await settle();
  assert.equal(client.stats.residentModels, 2, 'prefetch interest is not an active-frame pin');

  const byteLimited = new EnvironmentClient('ws://example.test/world', Date.now, 64, 16, 1,
    { modelTypedBackingBytes: 1, modelNumericArrayElements: 1 });
  t.after(() => byteLimited.dispose());
  t.mock.method(globalThis, 'fetch', async () => modelResponse(1));
  frame(byteLimited, names, true);
  await settle();
  assert.ok(byteLimited.stats.modelDecodedTypedBackingBytes <= 1);
  assert.ok(byteLimited.stats.modelDecodedNumericArrayElements <= 1);
  assert.equal(byteLimited.stats.residentModels, 0, 'speculative results cannot overflow byte budgets');
});

test('prefetch pressure cannot evict a visible model or exceed the request queue cap', async t => {
  const client = setup(t, async () => modelResponse(), Date.now, 64, 1, 1);
  const names = Array.from({ length: ENVIRONMENT_MODEL_QUEUE_LIMIT + 20 }, (_, id) => `Scenery${id}.m2`);
  client.beginResourceFrame();
  client.model('Visible.m2', 'critical');
  client.retainModelPrefetch(names);
  for (const name of names) client.prefetchModel(name);
  assert.equal(client.stats.queuedModels, ENVIRONMENT_MODEL_QUEUE_LIMIT);
  client.endResourceFrame();
  await settle();
  assert.equal(client.stats.residentModels, 1);
  assert.ok(client.model('Visible.m2'), 'the exact live pin survives all background completions');
});

test('retry backoff survives skipped scans and resets after leaving the footprint', async t => {
  let now = 0;
  let requests = 0;
  const client = setup(t, async () => {
    requests++;
    return new Response(null, { status: 503 });
  }, () => now);
  const names = ['Busy.m2'];
  frame(client, names, true);
  await settle();
  assert.equal(requests, 1);
  for (let skipped = 0; skipped < 3; skipped++) frame(client, names);
  frame(client, names, true);
  await settle();
  assert.equal(requests, 1, 'a retained retry ledger prevents one request per scan');
  now = IMAGE_RETRY_BACKOFF_MS[0] + 1;
  frame(client, names, true);
  await settle();
  assert.equal(requests, 2, 'a still-wanted model retries at its deadline');
  frame(client, []);
  frame(client, names, true);
  await settle();
  assert.equal(requests, 3, 'leaving and re-entering releases stale retry state');
});
