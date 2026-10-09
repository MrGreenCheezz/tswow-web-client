import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  MAX_ACCOUNT_DATA_SIZE, deflate, inflate, inflateAccountData,
} from "../dist/code/world/SessionProtocol.js";

// P1-21a: `SMSG_UPDATE_ACCOUNT_DATA` (0x20C) used to inflate through `DecompressionStream`, which
// settles only after several task turns while every later packet waits behind it. The blob now
// inflates synchronously, as `SMSG_COMPRESSED_UPDATE_OBJECT` does (`object-update-inflate.test.mjs`).
// The streams are real zlib from `node:zlib`, which is what TrinityCore's `compress()` writes.

function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 0x1_0000_0000;
}

/** An account blob's text: `SET` lines, macro bodies — mostly repeated, partly random. */
function body(size, random) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = i % 5 === 0 ? Math.floor(random() * 256) : 0x41 + ((i >> 4) % 26);
  return out;
}

test("an account blob inflates in the same call, byte for byte, at every level and window", () => {
  const random = lcg(0x20c);
  for (const size of [1, 100, 0xffff, 0x10000, MAX_ACCOUNT_DATA_SIZE]) {
    const plain = body(size, random);
    for (const level of [0, 1, 6, 9]) {
      const result = inflateAccountData(deflateSync(plain, { level }), size);
      assert.ok(result instanceof Uint8Array, `size ${size} level ${level} returns bytes, not a promise`);
      assert.deepEqual(result, plain, `size ${size} level ${level}`);
    }
  }
  const plain = body(5000, random);
  for (let windowBits = 9; windowBits <= 15; windowBits++) {
    assert.deepEqual(inflateAccountData(deflateSync(plain, { windowBits }), plain.byteLength), plain, `window ${windowBits}`);
  }
});

test("a stream from this client's own deflate inflates back", async () => {
  const plain = new TextEncoder().encode("SET macro1 \"/dance\"\n".repeat(40));
  assert.deepEqual(inflateAccountData(await deflate(plain), plain.byteLength), plain);
});

test("a size that does not match is refused with the old message", () => {
  const plain = body(512, lcg(1));
  const compressed = deflateSync(plain);
  assert.throws(() => inflateAccountData(compressed, 511), { name: "RangeError", message: "Account data expanded to 512 bytes, expected 511" });
  assert.throws(() => inflateAccountData(compressed, 513), { name: "RangeError", message: "Account data expanded to 512 bytes, expected 513" });
});

test("a size over the limit is refused before anything is inflated", () => {
  // Garbage bytes: had they been inflated, the error would say "does not inflate".
  const garbage = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  for (const size of [MAX_ACCOUNT_DATA_SIZE + 1, 0xffff_ffff, 1.5, -1]) {
    assert.throws(() => inflateAccountData(garbage, size), (error) => error instanceof RangeError && /too large/.test(error.message)
      && !/does not inflate/.test(error.message), `size ${size}`);
  }
});

test("a broken header or a truncated stream is a RangeError", () => {
  const plain = body(4096, lcg(2));
  const broken = deflateSync(plain);
  broken[0] = 0x00; // not a zlib header
  assert.throws(() => inflateAccountData(broken, plain.byteLength), { name: "RangeError", message: /^Account data does not inflate: / });
  const whole = deflateSync(plain, { level: 0 });
  const truncated = whole.subarray(0, whole.byteLength >> 1);
  assert.throws(() => inflateAccountData(truncated, plain.byteLength), RangeError);
});

test("the asynchronous inflate answers the same, and rejects the same", async () => {
  const plain = body(3000, lcg(3));
  const compressed = deflateSync(plain);
  assert.deepEqual(await inflate(compressed, plain.byteLength), plain);
  await assert.rejects(() => inflate(compressed, plain.byteLength + 1), { name: "RangeError", message: /expanded to 3000 bytes, expected 3001/ });
  await assert.rejects(() => inflate(compressed, MAX_ACCOUNT_DATA_SIZE + 1), { name: "RangeError", message: /too large/ });
});

/** The fake connection of `packet-pump.test.mjs`: a parked read is woken by the next push. */
function fakeConnection() {
  const queue = [];
  let wake;
  return {
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send() {},
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
  return { connection, client };
}

test("the world loop handles an account blob and the packet behind it within one microtask turn", async () => {
  const { connection, client } = await loggedIn();
  const text = "SET uiScale \"0.9\"\nSET cameraDistanceMax \"50\"\n";
  // HandleRequestAccountData: guid, type, time, the decompressed size, then compress() output.
  const plain = new TextEncoder().encode(text);
  const payload = new PacketWriter().u64(0x1234n).u32(4).u32(1_755_000_000).u32(plain.byteLength)
    .bytes(deflateSync(plain)).toUint8Array();
  const changed = [];
  const messages = [];
  client.events.on("ACCOUNT_DATA_CHANGED", ({ type }) => changed.push(type));
  client.events.on("SESSION_MESSAGE", ({ text: message }) => messages.push(message));
  // Warm both paths first: a cold first dispatch can spend the 4 ms slice and pause for a
  // macrotask (`PacketSlice`), which is the pump's rule and not what this test is about.
  connection.push(OPCODES.SMSG_UPDATE_ACCOUNT_DATA, new PacketWriter().u64(0x1234n).u32(1).u32(1).u32(4)
    .bytes(deflateSync(Uint8Array.of(1, 2, 3, 0))).toUint8Array());
  connection.push(OPCODES.SMSG_NOTIFICATION, new PacketWriter().cString("warm").toUint8Array());
  for (let round = 0; round < 400 && messages.length === 0; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(messages, ["warm"]);
  changed.length = 0;
  messages.length = 0;

  connection.push(OPCODES.SMSG_UPDATE_ACCOUNT_DATA, payload);
  connection.push(OPCODES.SMSG_NOTIFICATION, new PacketWriter().cString("behind the blob").toUint8Array());
  // Microtasks only: a stream-based inflate needs task turns and would leave all three unset.
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();

  assert.deepEqual(client.accountData.get(4), { time: 1_755_000_000, text });
  assert.deepEqual(changed, [4]);
  assert.deepEqual(messages, ["behind the blob"]);
  client.close();
});

// P1-21 review: the output is bounded, so a blob that inflates far past its size stops once past its size
// instead of inflating the whole bomb on the main thread first (64 MiB took 155 ms unbounded).
test("a compression bomb is refused with bounded output", () => {
  const bomb = new Uint8Array(deflateSync(Buffer.alloc(64 * 1024 * 1024)));
  const started = performance.now();
  assert.throws(() => inflateAccountData(bomb, 100), /expanded to more than 100 bytes, expected 100/);
  assert.ok(performance.now() - started < 50, "stops at the declared size");
});
