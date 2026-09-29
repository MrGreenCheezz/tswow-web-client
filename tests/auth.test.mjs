import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildLogonChallenge,
  canSelectRealm,
  parseRealmList,
} from "../dist/code/auth/AuthProtocol.js";
import { computeSrpProof } from "../dist/code/auth/Srp6.js";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";

const N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const G = 7n;

test("realm availability follows the authserver's lock byte and offline flag", () => {
  assert.equal(canSelectRealm({ locked: false, flags: 0 }), true);
  assert.equal(canSelectRealm({ locked: false, flags: 0x20 }), true, "recommended is still selectable");
  assert.equal(canSelectRealm({ locked: true, flags: 0 }), false);
  assert.equal(canSelectRealm({ locked: false, flags: 0x02 }), false);
  assert.equal(canSelectRealm({ locked: false, flags: 0x06 }), false, "incompatible build is marked offline + specify build");
});

function sha1(...parts) {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function fromLe(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

function toLe(value, length) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

function interleave(secret) {
  const even = new Uint8Array(16);
  const odd = new Uint8Array(16);
  for (let index = 0; index < 16; index++) {
    even[index] = secret[index * 2];
    odd[index] = secret[index * 2 + 1];
  }
  let first = 0;
  while (first < 32 && secret[first] === 0) first++;
  if (first & 1) first++;
  const left = sha1(even.subarray(first / 2));
  const right = sha1(odd.subarray(first / 2));
  const key = new Uint8Array(40);
  for (let index = 0; index < 20; index++) {
    key[index * 2] = left[index];
    key[index * 2 + 1] = right[index];
  }
  return key;
}

test("SRP6 client proof is accepted by the TrinityCore server equation", async () => {
  const username = "TEST";
  const password = "PASSWORD";
  const salt = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const privateA = Uint8Array.from({ length: 19 }, (_, index) => 0x21 + index);
  const privateB = fromLe(Uint8Array.from({ length: 32 }, (_, index) => 0x51 + index));
  const identityHash = sha1(new TextEncoder().encode(`${username}:${password}`));
  const x = fromLe(sha1(salt, identityHash));
  const verifier = modPow(G, x, N);
  const BValue = (modPow(G, privateB, N) + 3n * verifier) % N;
  const B = toLe(BValue, 32);
  const challenge = { B, g: Uint8Array.of(7), N: toLe(N, 32), salt };

  const proof = await computeSrpProof(username, password, challenge, privateA);
  const AValue = fromLe(proof.A);
  const u = fromLe(sha1(proof.A, B));
  const serverSecret = modPow((AValue * modPow(verifier, u, N)) % N, privateB, N);
  const serverKey = interleave(toLe(serverSecret, 32));

  const nHash = sha1(challenge.N);
  const gHash = sha1(challenge.g);
  const ngHash = nHash.map((value, index) => value ^ gHash[index]);
  const expectedM1 = sha1(ngHash, sha1(new TextEncoder().encode(username)), salt, proof.A, B, serverKey);
  const expectedM2 = sha1(proof.A, expectedM1, serverKey);

  assert.deepEqual(proof.sessionKey, serverKey);
  assert.deepEqual(proof.M1, expectedM1);
  assert.deepEqual(proof.M2, expectedM2);
});

test("logon challenge matches the packed 3.3.5a client structure", () => {
  const reader = new PacketReader(buildLogonChallenge("test", "ruRU"));
  assert.equal(reader.u8(), 0);
  assert.equal(reader.u8(), 0);
  assert.equal(reader.u16(), 34);
  assert.deepEqual([...reader.bytes(4)], [0x57, 0x6f, 0x57, 0]);
  assert.deepEqual([reader.u8(), reader.u8(), reader.u8(), reader.u16()], [3, 3, 5, 12340]);
  assert.equal(new TextDecoder().decode(reader.bytes(4)), "68x\0");
  assert.equal(new TextDecoder().decode(reader.bytes(4)), "niW\0");
  assert.equal(new TextDecoder().decode(reader.bytes(4)), "URur");
  reader.bytes(8);
  assert.equal(reader.u8(), 4);
  assert.equal(new TextDecoder().decode(reader.bytes(4)), "TEST");
  reader.assertFinished();
});

test("realm list parser decodes build-aware realm entries", () => {
  const payload = new PacketWriter()
    .u32(0)
    .u16(1)
    .u8(1)
    .u8(0)
    .u8(0x04)
    .cString("Local Realm")
    .cString("127.0.0.1:8085")
    .f32(0.5)
    .u8(2)
    .u8(1)
    .u8(1)
    .u8(3)
    .u8(3)
    .u8(5)
    .u16(12340)
    .u8(0x10)
    .u8(0)
    .toUint8Array();
  const packet = new PacketWriter().u8(0x10).u16(payload.length).bytes(payload).toUint8Array();

  assert.deepEqual(parseRealmList(packet), [
    {
      type: 1,
      locked: false,
      flags: 4,
      name: "Local Realm",
      address: "127.0.0.1:8085",
      population: 0.5,
      characters: 2,
      timezone: 1,
      id: 1,
      build: 12340,
    },
  ]);
});
