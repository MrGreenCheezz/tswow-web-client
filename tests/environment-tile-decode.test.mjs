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

// 05.10-A7b-1 (7.19): a tile is checked object by object. One object this client cannot read used to
// fail the whole tile (and every building and tree on it); now it is left out and counted.
const reportApi = await import('../dist/code/browser/EnvironmentTileDecode.js');

test('one unreadable object out of five is left out and counted; the other four are kept in order', () => {
  const good = cityObjects.slice(1, 5);
  const tile = [good[0], { ...good[1], localLight: [256, 0, 0, 255] }, good[1], good[2], good[3]];
  const report = reportApi.decodeEnvironmentTileReport(new TextEncoder().encode(JSON.stringify(tile)).buffer);
  assert.deepEqual(report.objects.map(object => object.id), good.map(object => object.id));
  assert.equal(report.rejected, 1);
  assert.equal(report.truncated, 0);
  assert.equal(decodeEnvironmentTile(new TextEncoder().encode(JSON.stringify(tile)).buffer).length, 4,
    'the array form keeps its contract and returns the readable objects');
});

test('a tile past 10,000 objects is cut and counted, not thrown away', () => {
  const objects = Array.from({ length: 10_001 }, (_, id) => ({ ...cityObjects[1], id }));
  const report = reportApi.decodeEnvironmentTileReport(new TextEncoder().encode(JSON.stringify(objects)).buffer);
  assert.equal(report.objects.length, 10_000);
  assert.equal(report.truncated, 1);
  assert.equal(report.objects.at(-1).id, 9_999);
});

test('a tile none of whose objects can be read is still an error; a valid tile is not copied', () => {
  assert.throws(() => reportApi.validateEnvironmentTileReport([null, { id: 1 }]), /invalid objects/);
  assert.throws(() => reportApi.validateEnvironmentTileReport({}), /invalid objects/);
  const value = [{ ...cityObjects[1] }];
  assert.equal(reportApi.validateEnvironmentTileReport(value).objects, value, 'the common case allocates nothing');
  assert.deepEqual(reportApi.validateEnvironmentTileReport([]).objects, []);
});

test('v5 WMO placements carry wmoId and nameSet; only WMOs, only unsigned integers (7.13)', () => {
  const wmo = { ...cityObjects[0], wmoId: 4711, nameSet: 3 };
  const check = (object) => reportApi.validateEnvironmentTileReport([cityObjects[1], object]).rejected;
  assert.equal(check(wmo), 0);
  assert.equal(check({ ...cityObjects[1], interior: false }), 0, 'an outdoor-owned WMO doodad is interior: false');
  for (const bad of [{ wmoId: -1 }, { wmoId: 1.5 }, { nameSet: 65_536 }, { nameSet: '3' }, { wmoId: 2 ** 32 }]) {
    assert.equal(check({ ...wmo, ...bad }), 1, JSON.stringify(bad));
  }
  assert.equal(check({ ...cityObjects[1], wmoId: 4711 }), 1, 'an M2 is not a WMOAreaTable key');
});

test('the worker and the synchronous path report the same objects and counts', async () => {
  const tile = [cityObjects[0], { id: 'x' }, ...cityObjects.slice(1, 600)];
  const bytes = new TextEncoder().encode(JSON.stringify(tile));
  const data = () => bytes.buffer.slice(0);
  const expected = reportApi.decodeEnvironmentTileReport(data());
  const worker = {
    onmessage: null, onerror: null, onmessageerror: null, terminated: false,
    postMessage(message, transfer) {
      const received = structuredClone(message, { transfer });
      queueMicrotask(() => {
        for (const packet of reportApi.environmentTileDecodeMessages(received)) {
          const copy = structuredClone(packet);
          queueMicrotask(() => worker.onmessage?.({ data: copy }));
        }
      });
    },
    terminate() { worker.terminated = true; },
  };
  const client = new EnvironmentTileDecodeClient(() => worker);
  const report = await client.decodeReport(data());
  assert.deepEqual(report, expected);
  assert.equal(report.rejected, 1);
  assert.equal(report.objects.length, 600);
  assert.deepEqual(await client.decode(data()), expected.objects, 'decode keeps resolving to the array');
  client.dispose();
  const fallback = new EnvironmentTileDecodeClient();
  const viaJson = await fallback.decodeResponseReport({ json: async () => JSON.parse(new TextDecoder().decode(bytes)) });
  assert.deepEqual(viaJson, expected);
  fallback.dispose();
});
