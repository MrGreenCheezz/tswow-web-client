import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { WorldConnection } from "../dist/code/world/WorldConnection.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { FRAMEXML_SEAM_BINDINGS } from "../dist/code/browser/framexml/FrameXmlWorldSeam.js";

// 1.30. GetNetStats() is `bandwidthIn, bandwidthOut, latency` (MainMenuBar.lua:498 reads the
// third; add-ons read the first two, in KB/s). The rates are counted at the socket, headers
// included: a client header is `u16 size (big-endian), u32 opcode` — six bytes — and a server
// header `u16 size, u16 opcode`, or five bytes when the size needs its high bit (WorldSocket).

/** A byte stream whose far end is the test: `feed` is the server writing, `written` the client. */
function byteStream() {
  let buffered = new Uint8Array(0);
  const waiters = [];
  const flush = () => {
    while (waiters.length > 0 && buffered.length >= waiters[0].length) {
      const { length, resolve } = waiters.shift();
      resolve(buffered.slice(0, length));
      buffered = buffered.slice(length);
    }
  };
  return {
    written: [],
    send(bytes) { this.written.push(bytes); },
    readExactly(length) {
      return new Promise((resolve) => { waiters.push({ length, resolve }); flush(); });
    },
    feed(bytes) {
      const next = new Uint8Array(buffered.length + bytes.length);
      next.set(buffered);
      next.set(bytes, buffered.length);
      buffered = next;
      flush();
    },
    close() {},
  };
}

/** A server packet as the worldserver frames it, unencrypted: size counts the two opcode bytes. */
function serverPacket(opcode, payloadLength) {
  const size = payloadLength + 2;
  const header = size >= 0x8000
    ? [0x80 | (size >>> 16), (size >>> 8) & 0xff, size & 0xff, opcode & 0xff, opcode >>> 8]
    : [size >>> 8, size & 0xff, opcode & 0xff, opcode >>> 8];
  const bytes = new Uint8Array(header.length + payloadLength);
  bytes.set(header);
  return bytes;
}

test("the socket counts wire bytes, headers included", async () => {
  const stream = byteStream();
  const connection = new WorldConnection(stream);
  assert.equal(connection.bytesSent, 0);
  assert.equal(connection.bytesReceived, 0);
  connection.send(0x1dc, new Uint8Array(100));
  assert.equal(connection.bytesSent, 6 + 100);
  assert.equal(stream.written[0].length, 106, "what the counter says is what went out");
  connection.send(0x1dc);
  assert.equal(connection.bytesSent, 106 + 6, "an empty packet is still its header");

  stream.feed(serverPacket(0x1dd, 300));
  const small = await connection.read();
  assert.equal(small.payload.length, 300);
  assert.equal(connection.bytesReceived, 4 + 300);
  stream.feed(serverPacket(0xa9, 0x8000));
  const large = await connection.read();
  assert.equal(large.payload.length, 0x8000);
  assert.equal(connection.bytesReceived, 304 + 5 + 0x8000, "the long header is five bytes");
});

test("bandwidth is KB/s over at least half a second, and zeros before a window exists", async () => {
  let clock = 10_000;
  mock.method(performance, "now", () => clock);
  const stream = byteStream();
  const connection = new WorldConnection(stream);
  const client = new WorldClient(connection);
  try {
    assert.deepEqual(client.netBandwidth(), { inKBps: 0, outKBps: 0 }, "the first call only opens the window");
    connection.send(0x1dc, new Uint8Array(100));
    stream.feed(serverPacket(0x1dd, 300));
    await connection.read();
    clock += 1_000;
    const first = client.netBandwidth();
    assert.ok(Math.abs(first.inKBps - 304 / 1024) < 1e-9, `in ${first.inKBps}`);
    assert.ok(Math.abs(first.outKBps - 106 / 1024) < 1e-9, `out ${first.outKBps}`);

    // Under half a second later the last rate stands, whatever moved meanwhile.
    connection.send(0x1dc, new Uint8Array(1_018));
    clock += 200;
    assert.deepEqual(client.netBandwidth(), first);
    clock += 300;
    const second = client.netBandwidth();
    assert.ok(Math.abs(second.outKBps - 1_024 / 1_024 / 0.5) < 1e-9, `out ${second.outKBps}`);
    assert.equal(second.inKBps, 0);
  } finally {
    client.close();
    mock.restoreAll();
  }
});

test("GetNetStats answers the seam's rates beside the latency, and zeros for nonsense", () => {
  const stats = (seam) => FRAMEXML_SEAM_BINDINGS.GetNetStats(seam, []);
  assert.deepEqual(stats({ netLatency: () => 42, netBandwidth: () => ({ inKBps: 0.25, outKBps: 1.5 }) }), [0.25, 1.5, 42]);
  assert.deepEqual(stats({ netLatency: () => 42 }), [0, 0, 42], "a seam without rates, like the canned world");
  assert.deepEqual(stats({ netLatency: () => 42, netBandwidth: () => undefined }), [0, 0, 42]);
  assert.deepEqual(stats({ netBandwidth: () => ({ inKBps: Number.NaN, outKBps: -3 }) }), [0, 0, 0]);
  assert.deepEqual(stats({ netBandwidth: () => ({ inKBps: Number.POSITIVE_INFINITY, outKBps: 0 }) }), [0, 0, 0]);
  assert.deepEqual(stats({}), [0, 0, 0]);
});

test("the live seam hands the world's own socket rates and round trip to GetNetStats", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  let clock = 50_000;
  mock.method(performance, "now", () => clock);
  const stream = byteStream();
  const connection = new WorldConnection(stream);
  const world = new WorldClient(connection);
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => clock,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const stats = () => FRAMEXML_SEAM_BINDINGS.GetNetStats(seam, []);
  try {
    world.latencyMs = 87;
    assert.deepEqual(stats(), [0, 0, 87], "the first read opens the window");
    connection.send(0x1dc, new Uint8Array(2_042));
    stream.feed(serverPacket(0x1dd, 1_020));
    await connection.read();
    clock += 2_000;
    assert.deepEqual(stats(), [1_024 / 1_024 / 2, 2_048 / 1_024 / 2, 87], "KB/s in and out, then the latency");
    const detached = new LiveWorldSeam({
      world: () => undefined, store: () => undefined, spell: () => undefined, monotonic: () => clock,
      globalCooldownUntil: () => 0, castSpell: () => {},
    });
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNetStats(detached, []), [0, 0, 0], "no world: the neutral zeros");
  } finally {
    world.close();
    mock.restoreAll();
  }
});
