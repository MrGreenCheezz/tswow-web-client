import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { hmacSha1, sha1 } from "../dist/code/auth/Sha1.js";
import { computeSrpProof } from "../dist/code/auth/Srp6.js";
import { WorldCrypt } from "../dist/code/world/WorldCrypt.js";

function nodeSha1(bytes) {
  return new Uint8Array(createHash("sha1").update(bytes).digest());
}

function nodeHmacSha1(key, data) {
  return new Uint8Array(createHmac("sha1", key).update(data).digest());
}

/** Runs `run` with what an insecure context (`http://<public address>/`) offers: getRandomValues, no subtle. */
async function inInsecureContext(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const nativeCrypto = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: (array) => nativeCrypto.getRandomValues(array) }, configurable: true });
    assert.equal(globalThis.crypto.subtle, undefined);
    return await run();
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
}

// The world session's header keys, as TrinityCore's WorldSocket derives them (HMAC-SHA1 of the
// session key): the server encrypts with the first, the client with the second.
const SERVER_ENCRYPTION_KEY = Uint8Array.of(
  0xcc, 0x98, 0xae, 0x04, 0xe8, 0x97, 0xea, 0xca, 0x12, 0xdd, 0xc0, 0x93, 0x42, 0x91, 0x53, 0x57,
);
const SERVER_DECRYPTION_KEY = Uint8Array.of(
  0xc2, 0xb3, 0x72, 0x3c, 0xc6, 0xae, 0xd9, 0xb5, 0x34, 0x3c, 0x53, 0xee, 0x2f, 0x43, 0x67, 0xce,
);

/** RC4 with the first 1024 bytes of keystream dropped, over one continuous stream. */
function rc4Drop1024(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  const stream = (bytes) => Uint8Array.from(bytes, (byte) => {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) & 0xff];
  });
  stream(new Uint8Array(1024));
  return stream(input);
}

function concat(parts) {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

test("the plain SHA-1 matches Node's at every length around the block and padding boundaries", () => {
  for (let length = 0; length <= 300; length++) {
    const bytes = new Uint8Array(randomBytes(length));
    assert.deepEqual(sha1(bytes), nodeSha1(bytes), `length ${length}`);
  }
  const large = new Uint8Array(randomBytes(1_000_003));
  assert.deepEqual(sha1(large), nodeSha1(large));
  assert.equal(Buffer.from(sha1(new TextEncoder().encode("abc"))).toString("hex"),
    "a9993e364706816aba3e25717850c26c9cd0d89d");
});

test("SRP6 gives the same proof without Web Crypto, as on a page served over plain http", async () => {
  const challenge = {
    B: new Uint8Array(randomBytes(32)),
    g: Uint8Array.of(7),
    N: Uint8Array.from(Buffer.from("894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7", "hex").reverse()),
    salt: new Uint8Array(randomBytes(32)),
  };
  const privateKey = new Uint8Array(randomBytes(19));
  const withWebCrypto = await computeSrpProof("PLAYER", "secret", challenge, privateKey);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const nativeCrypto = globalThis.crypto;
  try {
    // What an insecure context offers: getRandomValues, no subtle.
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: (array) => nativeCrypto.getRandomValues(array) }, configurable: true });
    assert.equal(globalThis.crypto.subtle, undefined);
    const withoutWebCrypto = await computeSrpProof("PLAYER", "secret", challenge, privateKey);
    assert.deepEqual(withoutWebCrypto, withWebCrypto);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const filled = (value, length) => new Uint8Array(length).fill(value);
const ascii = (text) => new TextEncoder().encode(text);

test("hmacSha1 matches RFC 2202 test cases 1-7", () => {
  // RFC 2202 §3 (HMAC-SHA-1): test case, key, data, digest. 6 and 7 hash a key longer than the block.
  const cases = [
    [1, filled(0x0b, 20), ascii("Hi There"), "b617318655057264e28bc0b6fb378c8ef146be00"],
    [2, ascii("Jefe"), ascii("what do ya want for nothing?"), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"],
    [3, filled(0xaa, 20), filled(0xdd, 50), "125d7342b9ac11cd91a39af48aa17b4f63f175d3"],
    [4, Uint8Array.from({ length: 25 }, (_, index) => index + 1), filled(0xcd, 50), "4c9007f4026250c6bc8414f9bf50c86c2d7235da"],
    [5, filled(0x0c, 20), ascii("Test With Truncation"), "4c1a03424b55e07fe7f27be1d58bb9324a9a5a04"],
    [6, filled(0xaa, 80), ascii("Test Using Larger Than Block-Size Key - Hash Key First"),
      "aa4ae5e15272d00e95705637ce8a3b55ed402112"],
    [7, filled(0xaa, 80), ascii("Test Using Larger Than Block-Size Key and Larger Than One Block-Size Data"),
      "e8e99d0f45237d786d6bbaa7965c7808bbff1a91"],
  ];
  for (const [id, key, data, digest] of cases) assert.equal(hex(hmacSha1(key, data)), digest, `RFC 2202 case ${id}`);
});

test("hmacSha1 matches Node's for keys of 0-130 bytes and data around the SHA-1 block boundaries", () => {
  for (let keyLength = 0; keyLength <= 130; keyLength++) {
    for (const dataLength of [0, 1, 40, 55, 56, 63, 64, 65, 119, 120, 200]) {
      const key = new Uint8Array(randomBytes(keyLength));
      const data = new Uint8Array(randomBytes(dataLength));
      assert.deepEqual(hmacSha1(key, data), nodeHmacSha1(key, data), `key ${keyLength}, data ${dataLength}`);
    }
  }
  // Views into larger buffers sign their own bytes, not the buffer under them.
  const buffer = new Uint8Array(randomBytes(256));
  const key = buffer.subarray(3, 19);
  const data = buffer.subarray(100, 140);
  assert.deepEqual(hmacSha1(key, data), nodeHmacSha1(key, data));
});

test("WorldCrypt keys the world headers as the server does, without Web Crypto, as on a page served over plain http", async () => {
  // The session key tests/world.test.mjs uses; three headers each way, because RC4 is a stream and
  // a key that is right only for the first bytes would still pass on one. The expected streams are
  // the server's side of it — node:crypto's HMAC and a reference RC4 — computed without WorldCrypt.
  const sessionKey = Uint8Array.from({ length: 40 }, (_, index) => index + 1);
  const clientHeaders = [Uint8Array.of(0, 4, 0x37, 0, 0, 0), Uint8Array.of(0, 8, 0xed, 1, 0, 0), Uint8Array.of(0, 4, 0xdc, 1, 0, 0)];
  const serverHeaders = [Uint8Array.of(0, 3, 0xee, 1), Uint8Array.of(0, 10, 0x3b, 0), Uint8Array.of(0, 2, 0xdd, 1)];
  const crypt = await inInsecureContext(() => WorldCrypt.create(sessionKey));
  const clientStream = rc4Drop1024(nodeHmacSha1(SERVER_DECRYPTION_KEY, sessionKey), concat(clientHeaders));
  const serverStream = rc4Drop1024(nodeHmacSha1(SERVER_ENCRYPTION_KEY, sessionKey), concat(serverHeaders));
  let clientOffset = 0;
  let serverOffset = 0;
  for (let index = 0; index < 3; index++) {
    const clientHeader = clientHeaders[index];
    const encrypted = clientStream.slice(clientOffset, clientOffset + clientHeader.byteLength);
    clientOffset += clientHeader.byteLength;
    assert.deepEqual(crypt.encryptClientHeader(clientHeader), encrypted, `client header ${index}: as the server decrypts it`);
    const serverHeader = serverHeaders[index];
    const received = serverStream.slice(serverOffset, serverOffset + serverHeader.byteLength);
    serverOffset += serverHeader.byteLength;
    assert.deepEqual(crypt.decryptServerHeader(received), serverHeader, `server header ${index}: as the server encrypted it`);
  }
});
