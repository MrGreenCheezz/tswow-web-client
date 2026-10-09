import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { ByteQueue } from "../dist/code/transport/ByteQueue.js";
import { WorldConnection } from "../dist/code/world/WorldConnection.js";
import { WorldCrypt } from "../dist/code/world/WorldCrypt.js";

// P1-21b1: `WorldConnection.tryRead()` — a whole buffered packet synchronously, or undefined having
// consumed nothing and left the RC4 header cipher where it was. Checked against `read()` on twin
// connections over the real `WebSocketByteStream`, fed by a fake socket.

const SERVER_ENCRYPTION_KEY = Uint8Array.of(
  0xcc, 0x98, 0xae, 0x04, 0xe8, 0x97, 0xea, 0xca, 0x12, 0xdd, 0xc0, 0x93, 0x42, 0x91, 0x53, 0x57,
);
const hmac = (key, data) => new Uint8Array(createHmac("sha1", key).update(data).digest());

/** `rc4` of `world.test.mjs`, with the state kept between calls, as the server's cipher is. */
function rc4Stream(key) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  const process = (bytes) => Uint8Array.from(bytes, (byte) => {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) & 0xff];
  });
  process(new Uint8Array(1024));
  return process;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = Math.imul(state, 1664525) + 1013904223 >>> 0);
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  binaryType = "blob";
  #listeners = new Map();
  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, []);
    this.#listeners.get(type).push(listener);
  }
  dispatch(type, event = {}) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
  deliver(bytes) {
    this.dispatch("message", { data: bytes.slice().buffer });
  }
  send() {}
  close() { this.readyState = FakeWebSocket.CLOSED; }
}

async function openStream() {
  const saved = globalThis.WebSocket;
  let socket;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor() {
      super();
      socket = this;
    }
  };
  try {
    const { WebSocketByteStream } = await import("../dist/code/transport/WebSocketByteStream.js");
    const opening = WebSocketByteStream.connect("ws://gateway.test/world");
    socket.dispatch("open");
    return { stream: await opening, socket };
  } finally {
    globalThis.WebSocket = saved;
  }
}

const SESSION_KEY = Uint8Array.from({ length: 40 }, (_, index) => index * 7 + 3);

/** The server's side: TrinityCore's ServerPktHeader, the header (and only it) through RC4. */
function serverWire(packets, encrypt) {
  const parts = [];
  for (const { opcode, payload } of packets) {
    const size = payload.byteLength + 2;
    const header = size > 0x7fff
      ? Uint8Array.of(0x80 | (size >> 16), (size >> 8) & 0xff, size & 0xff, opcode & 0xff, opcode >> 8)
      : Uint8Array.of(size >> 8, size & 0xff, opcode & 0xff, opcode >> 8);
    parts.push(encrypt ? encrypt(header) : header, payload);
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

function makePackets(random, sizes) {
  return sizes.map((size, index) => ({
    opcode: (0x100 + index * 37 + (random() & 0x3ff)) & 0xffff,
    payload: Uint8Array.from({ length: size }, () => random() & 0xff),
  }));
}

/** Random cuts of `wire`, from single bytes to whole runs of packets. */
function chunks(wire, random) {
  const out = [];
  for (let at = 0; at < wire.byteLength;) {
    const kind = random() % 4;
    const length = kind === 0 ? 1 : kind === 1 ? 1 + (random() % 8) : kind === 2 ? 1 + (random() % 300) : 1 + (random() % 70_000);
    out.push(wire.subarray(at, Math.min(wire.byteLength, at + length)));
    at += length;
  }
  return out;
}

async function twins(encrypted) {
  const a = await openStream();
  const b = await openStream();
  const readSide = new WorldConnection(a.stream);
  const trySide = new WorldConnection(b.stream);
  if (encrypted) {
    await readSide.enableEncryption(SESSION_KEY);
    await trySide.enableEncryption(SESSION_KEY);
  }
  return { a, b, readSide, trySide };
}

for (const encrypted of [false, true]) {
  test(`tryRead frames exactly as read() does (${encrypted ? "RC4" : "clear"} headers, random cuts)`, async () => {
    const random = lcg(encrypted ? 0x21b : 0x21a);
    const sizes = [0, 1, 100, 0x7ffd, 0x7ffe, 0x10000];
    for (let i = 0; i < 300; i++) sizes.push(random() % 200);
    sizes.push(0x7ffd, 0, 0x7ffe, 5);
    const packets = makePackets(random, sizes);
    const wire = serverWire(packets, encrypted ? rc4Stream(hmac(SERVER_ENCRYPTION_KEY, SESSION_KEY)) : undefined);
    const { a, b, readSide, trySide } = await twins(encrypted);

    const viaTry = [];
    for (const chunk of chunks(wire, random)) {
      a.socket.deliver(chunk);
      b.socket.deliver(chunk);
      // Everything whole is taken now; a partial packet is left for the next chunk.
      for (let packet = trySide.tryRead(); packet; packet = trySide.tryRead()) viaTry.push(packet);
    }
    assert.equal(trySide.tryRead(), undefined);
    assert.equal(b.stream.buffered, 0, "nothing is left behind");
    const viaRead = [];
    for (let i = 0; i < packets.length; i++) viaRead.push(await readSide.read());
    assert.equal(viaTry.length, packets.length);
    assert.deepEqual(viaTry, viaRead);
    assert.deepEqual(viaTry, packets);
    assert.equal(trySide.bytesReceived, readSide.bytesReceived, "the byte counters agree");
    assert.equal(trySide.bytesReceived, wire.byteLength);
  });
}

test("on every prefix of a packet tryRead consumes nothing and leaves the cipher alone", async () => {
  const random = lcg(0x5eed);
  const packets = makePackets(random, [3, 0x7ffe, 0, 40]);
  const encrypt = rc4Stream(hmac(SERVER_ENCRYPTION_KEY, SESSION_KEY));
  const wires = packets.map((packet) => serverWire([packet], encrypt));
  const { b, trySide } = await twins(true);
  for (const [index, wire] of wires.entries()) {
    // Every prefix up to the header and a spread of payload prefixes, one byte at a time at first.
    const cuts = [];
    for (let cut = 1; cut < Math.min(wire.byteLength, 12); cut++) cuts.push(cut);
    for (let cut = 12; cut < wire.byteLength; cut += 1 + (random() % 4000)) cuts.push(cut);
    let fed = 0;
    for (const cut of cuts) {
      b.socket.deliver(wire.subarray(fed, cut));
      fed = cut;
      assert.equal(trySide.tryRead(), undefined, `packet ${index} prefix ${cut}`);
      assert.equal(b.stream.buffered, cut, `packet ${index} prefix ${cut}: nothing consumed`);
    }
    if (index % 2 === 0) {
      b.socket.deliver(wire.subarray(fed));
      assert.deepEqual(trySide.tryRead(), packets[index], `packet ${index} whole`);
    } else {
      // The fallback: read() after a refused tryRead still decrypts the header right.
      const pending = trySide.read();
      b.socket.deliver(wire.subarray(fed));
      assert.deepEqual(await pending, packets[index], `packet ${index} through read()`);
    }
  }
});

test("while a read() waits, tryRead stays out of its way", async () => {
  const random = lcg(9);
  const packets = makePackets(random, [10, 20]);
  const wire = serverWire(packets);
  const { b, trySide } = await twins(false);
  b.socket.deliver(wire.subarray(0, 1));
  const pending = trySide.read();
  // The first byte is taken at once; the read then waits for the other three of the header.
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  b.socket.deliver(wire.subarray(1, 3));
  assert.equal(b.stream.buffered, 0, "a waiting reader owns the buffer");
  assert.equal(b.stream.peek(new Uint8Array(5), 2), false);
  assert.equal(b.stream.readBuffered(1), undefined);
  assert.equal(trySide.tryRead(), undefined);
  b.socket.deliver(wire.subarray(3));
  assert.deepEqual(await pending, packets[0]);
  assert.deepEqual(trySide.tryRead(), packets[1]);
});

test("peeking the header cipher never moves it, on random keys", async () => {
  const random = lcg(0xc0de);
  for (let round = 0; round < 40; round++) {
    const key = Uint8Array.from({ length: 40 }, () => random() & 0xff);
    const peeked = await WorldCrypt.create(key);
    const plain = await WorldCrypt.create(key);
    for (let step = 0; step < 30; step++) {
      const length = 1 + (random() % 5);
      const raw = Uint8Array.from({ length }, () => random() & 0xff);
      const out = new Uint8Array(5);
      for (let peeks = random() % 4; peeks > 0; peeks--) peeked.peekServerHeader(raw, length, out);
      peeked.peekServerHeader(raw, length, out);
      const expected = plain.decryptServerHeader(raw);
      assert.deepEqual(out.subarray(0, length), expected, `round ${round} step ${step}: the peek is the decryption`);
      assert.deepEqual(peeked.decryptServerHeader(raw), expected, `round ${round} step ${step}: and the cipher did not move`);
    }
  }
});

test("an impossible size is read()'s RangeError, and the bytes stay where they were", async () => {
  // size 1 leaves no room for the opcode: payload −1.
  const bad = Uint8Array.of(0, 1, 0xee, 0x01, 0xaa, 0xbb);
  const { a, b, readSide, trySide } = await twins(false);
  b.socket.deliver(bad);
  a.socket.deliver(bad);
  assert.throws(() => trySide.tryRead(), { name: "RangeError", message: "Invalid world payload size -1" });
  assert.equal(b.stream.buffered, bad.byteLength, "nothing consumed");
  await assert.rejects(() => readSide.read(), { name: "RangeError", message: "Invalid world payload size -1" });
});

test("a stream with only readExactly never answers tryRead", async () => {
  const queue = new ByteQueue();
  queue.push(serverWire(makePackets(lcg(1), [4])));
  const connection = new WorldConnection({
    send() {}, close() {},
    readExactly: (length) => Promise.resolve(queue.read(length)),
  });
  assert.equal(connection.tryRead(), undefined);
  assert.equal((await connection.read()).payload.byteLength, 4);
});

test("ByteQueue.peek copies across chunks without consuming", () => {
  const queue = new ByteQueue();
  for (const part of [[1], [2, 3], [], [4], [5, 6, 7]]) queue.push(Uint8Array.from(part));
  queue.read(1);
  const target = new Uint8Array(5);
  assert.equal(queue.peek(target, 5), true);
  assert.deepEqual([...target], [2, 3, 4, 5, 6]);
  assert.equal(queue.length, 6);
  assert.equal(queue.peek(target, 7), false, "more than is held");
  assert.deepEqual([...queue.read(6)], [2, 3, 4, 5, 6, 7]);
});
