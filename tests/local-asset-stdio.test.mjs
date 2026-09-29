import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { Server } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayAssetHandler } from '../dist/code/gateway/Gateway.js';
import { serveLocalAssets, LOCAL_ASSET_ORIGIN } from '../dist/code/gateway/LocalAssetStdio.js';

function session(assets, readyMetadata) {
  const input = new PassThrough(); const output = new PassThrough();
  const frames = []; const waiters = [];
  let pending = Buffer.alloc(0); let header;
  output.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (!header) {
        const newline = pending.indexOf(10); if (newline < 0) break;
        header = JSON.parse(pending.subarray(0, newline).toString()); pending = pending.subarray(newline + 1);
      }
      const length = header.length ?? 0;
      if (pending.length < length) break;
      const frame = { ...header, bytes: Buffer.from(pending.subarray(0, length)) };
      pending = pending.subarray(length); header = undefined;
      const waiter = waiters.shift(); if (waiter) waiter(frame); else frames.push(frame);
    }
  });
  const done = serveLocalAssets(input, output, assets, readyMetadata);
  // Rejections can occur synchronously from input.write, before assert.rejects is installed.
  done.catch(() => {});
  return { input, done, next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => waiters.push(resolve)),
    send: value => input.write(JSON.stringify(value) + '\n') };
}

test('local dispatcher serves dynamic batches, add-ons and errors without a listening socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-assets-'));
  const originalListen = Server.prototype.listen;
  Server.prototype.listen = function() { throw new Error('Local provider must not listen'); };
  try {
    const items = join(root, 'items.json');
    await writeFile(items, JSON.stringify([[7,'Seven',70,1,2,3,4], [9,'Nine',90,1,2,3,4]]));
    const assets = await createGatewayAssetHandler({ host: '127.0.0.1', port: 0,
      auth: { host: '127.0.0.1', port: 1 }, world: { host: '127.0.0.1', port: 1 },
      allowedOrigins: [LOCAL_ASSET_ORIGIN], itemMetadataFile: items,
      clientAddons: [{ name: 'Example', loadOnDemand: true }] });
    const pipe = session(assets);
    assert.equal((await pipe.next()).ready, true);
    pipe.send({ id: 1, route: 'data/items?entries=9,7,9,123', byteLimit: 4096 });
    assert.deepEqual(JSON.parse((await pipe.next()).bytes).map(row => row.entry), [9, 7]);
    pipe.send({ id: 2, route: 'data/items?entries=7', byteLimit: 1 });
    assert.equal((await pipe.next()).status, 413);
    pipe.send({ id: 3, route: 'client/addons', byteLimit: 4096 });
    assert.match((await pipe.next()).bytes.toString(), /Example/);
    pipe.send({ id: 4, route: 'data/items?entries=', byteLimit: 4096 });
    assert.equal((await pipe.next()).status, 400);
    pipe.send({ id: 5, route: 'unknown', byteLimit: 4096 });
    assert.equal((await pipe.next()).status, 404);
    pipe.input.end(); await pipe.done;
  } finally { Server.prototype.listen = originalListen; await rm(root, { recursive: true, force: true }); }
});

test('local dispatcher reports the DBC directory selected after patch preparation', async () => {
  const pipe = session({ handle() {}, close() {} }, { activeDbcDirectory: 'C:\\runtime\\state\\patches\\abc\\dbc' });
  const ready = await pipe.next();
  assert.equal(ready.ready, true);
  assert.equal(ready.protocol, 1);
  assert.equal(ready.activeDbcDirectory, 'C:\\runtime\\state\\patches\\abc\\dbc');
  pipe.input.end(); await pipe.done;
});

test('binary frames remain separate and cancelled requests do not deliver late bytes', async () => {
  const responses = new Map(); let closed = false;
  const pipe = session({ handle: (request, response) => responses.set(request.url, response), close: () => { closed = true; } });
  await pipe.next();
  pipe.send({ id: 1, route: 'one', byteLimit: 256 * 1024 * 1024 });
  pipe.send({ id: 2, route: 'two', byteLimit: 100 });
  pipe.send({ id: 3, route: 'three', byteLimit: 100 });
  assert.equal(responses.size, 2);
  pipe.send({ cancel: 1 });
  responses.get('/one').end(Buffer.from([10,0,255,123]));
  responses.get('/two').end(Buffer.from([255,10,0,123]));
  const second = await pipe.next(); assert.equal(second.id, 2);
  assert.deepEqual([...second.bytes], [255,10,0,123]);
  await new Promise(resolve => setImmediate(resolve));
  responses.get('/three').end(Buffer.from([0,10]));
  assert.equal((await pipe.next()).id, 3);
  pipe.input.end(); await pipe.done; assert.equal(closed, true);
});

test('malformed and excessive requests close the owned session', async () => {
  for (const value of ['x\n', JSON.stringify({ id: 1, route: 'one', byteLimit: 268435457 })+'\n', 'x'.repeat(16385)]) {
    let closed = false;
    const pipe = session({ handle() { throw new Error('must not dispatch'); }, close() { closed = true; } });
    await pipe.next(); pipe.input.write(value);
    await assert.rejects(pipe.done); assert.equal(closed, true);
  }
});
