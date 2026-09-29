import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENVIRONMENT_TILE_MESSAGE_OBJECTS, EnvironmentTileDecodeClient,
  decodeEnvironmentTile, environmentTileChunks,
} from '../dist/code/browser/EnvironmentTileDecode.js';

const cityObjects = Array.from({ length: 7940 }, (_, id) => ({
  id, kind: id % 3 === 0 ? 'wmo' : 'm2', name: `World\\Test\\Scenery${id % 83}.m2`,
  x: id * 1.25, y: -id * 0.5, z: id % 17,
  rotationX: id % 360, rotationY: 0, rotationZ: 0, scale: 1,
  ...(id % 4 === 0 ? { interior: true,
    quaternionX: 0, quaternionY: 0, quaternionZ: 0, quaternionW: 1 } : {}),
  ...(id % 5 === 0 ? { localLight: [255, 180, 90, 255] } : {}),
}));
const cityBytes = new TextEncoder().encode(JSON.stringify(cityObjects));
const cityData = () => cityBytes.buffer.slice(cityBytes.byteOffset, cityBytes.byteOffset + cityBytes.byteLength);

function fakeWorker() {
  const worker = {
    onmessage: null, onerror: null, onmessageerror: null, terminated: false,
    postMessage(message, transfer) {
      assert.deepEqual(transfer, [message.data]);
      const received = structuredClone(message, { transfer });
      queueMicrotask(() => {
        if (worker.terminated) return;
        try {
          const objects = decodeEnvironmentTile(received.data);
          let offset = 0;
          for (const chunk of environmentTileChunks(objects)) {
            const packet = structuredClone({ id: received.id, offset, objects: chunk });
            queueMicrotask(() => worker.onmessage?.({ data: packet }));
            offset += chunk.length;
          }
          queueMicrotask(() => worker.onmessage?.({ data: { id: received.id, done: true, total: offset } }));
        } catch (error) {
          queueMicrotask(() => worker.onmessage?.({ data: { id: received.id, error: error.message } }));
        }
      });
    },
    terminate() { worker.terminated = true; },
  };
  return worker;
}

test('a dense 7940-object tile validates and is returned in bounded chunks without losing order', async () => {
  const expected = decodeEnvironmentTile(cityData());
  assert.equal(expected.length, 7940);
  const chunks = [...environmentTileChunks(expected)];
  assert.equal(chunks.length, Math.ceil(expected.length / ENVIRONMENT_TILE_MESSAGE_OBJECTS));
  assert.ok(chunks.every(chunk => chunk.length <= 256));
  const worker = fakeWorker();
  const client = new EnvironmentTileDecodeClient(() => worker);
  const actual = await client.decode(cityData());
  assert.deepEqual(actual, expected);
  client.dispose();
  assert.equal(worker.terminated, true);
});

test('an invalid tile is rejected before any partial decoded objects are published', async () => {
  const worker = fakeWorker();
  const client = new EnvironmentTileDecodeClient(() => worker);
  await assert.rejects(client.decode(new TextEncoder().encode('[{"id":1}]').buffer), /invalid objects/);
  client.dispose();
});

test('the tile decoder rejects an out-of-range local light byte', () => {
  const invalid = { ...cityObjects[0], localLight: [256, 180, 90, 255] };
  const data = new TextEncoder().encode(JSON.stringify([invalid]));
  assert.throws(() => decodeEnvironmentTile(data.buffer), /invalid objects/);
});

test('the tile decoder accepts finite static M2 radii and rejects unsafe values', () => {
  const encode = (object) => new TextEncoder().encode(JSON.stringify([object])).buffer;
  const sample = { ...cityObjects[1], admissionRadius: 12.5 };
  assert.equal(decodeEnvironmentTile(encode(sample))[0].admissionRadius, 12.5);
  for (const radius of [-1, "12.5", null]) {
    assert.throws(() => decodeEnvironmentTile(encode({ ...sample, admissionRadius: radius })), /invalid objects/);
  }
  assert.throws(() => decodeEnvironmentTile(encode({ ...cityObjects[0], admissionRadius: 12.5 })), /invalid objects/,
    'a WMO extent cannot be replaced with an M2 radius');
});

test('aborting or disposing a decode rejects pending work and ignores later worker chunks', async () => {
  const worker = fakeWorker();
  const client = new EnvironmentTileDecodeClient(() => worker);
  const controller = new AbortController();
  const cancelled = client.decode(cityData(), controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const disposed = client.decode(cityData());
  client.dispose();
  await assert.rejects(disposed, { name: 'AbortError' });
});

test('Node fallback keeps Response.json and the same validation contract', async () => {
  const client = new EnvironmentTileDecodeClient();
  const item = { id: 1, kind: 'm2', name: 'a.m2', x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  assert.deepEqual(await client.decodeResponse({ json: async () => [item] }), [item]);
  await assert.rejects(client.decodeResponse({ json: async () => [null] }), /invalid objects/);
  client.dispose();
});
