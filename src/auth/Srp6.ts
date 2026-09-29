import { sha1 } from "./Sha1.js";

const encoder = new TextEncoder();
const WOW_N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const WOW_G = 7n;

export interface SrpChallenge {
  B: Uint8Array;
  g: Uint8Array;
  N: Uint8Array;
  salt: Uint8Array;
}

export interface SrpProof {
  A: Uint8Array;
  M1: Uint8Array;
  M2: Uint8Array;
  sessionKey: Uint8Array;
}

export function uppercaseBasicLatin(value: string): string {
  return value.replace(/[a-z]/g, (character) => character.toUpperCase());
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export async function sha1Bytes(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const bytes = concatBytes(...parts);
  // No Web Crypto outside a secure context, e.g. a page opened as http://<public address>/.
  if (!globalThis.crypto?.subtle) return sha1(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", bytes.buffer as ArrayBuffer));
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.byteLength - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index] ?? 0);
  return value;
}

function bigIntToLittleEndian(value: bigint, length: number): Uint8Array {
  if (value < 0n) throw new RangeError("Cannot encode a negative bigint");
  const output = new Uint8Array(length);
  let remaining = value;
  for (let index = 0; index < length; index++) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new RangeError(`Bigint does not fit in ${length} bytes`);
  return output;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n || exponent < 0n) throw new RangeError("Invalid modular exponentiation");
  let result = 1n;
  let factor = ((base % modulus) + modulus) % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    power >>= 1n;
  }
  return result;
}

async function sha1Interleave(secret: Uint8Array): Promise<Uint8Array> {
  if (secret.byteLength !== 32) throw new RangeError("WoW SRP secret must be 32 bytes");
  const even = new Uint8Array(16);
  const odd = new Uint8Array(16);
  for (let index = 0; index < 16; index++) {
    even[index] = secret[index * 2] ?? 0;
    odd[index] = secret[index * 2 + 1] ?? 0;
  }

  let first = 0;
  while (first < secret.byteLength && secret[first] === 0) first++;
  if (first & 1) first++;
  const halfOffset = first / 2;
  const [evenHash, oddHash] = await Promise.all([
    sha1Bytes(even.subarray(halfOffset)),
    sha1Bytes(odd.subarray(halfOffset)),
  ]);

  const key = new Uint8Array(40);
  for (let index = 0; index < 20; index++) {
    key[index * 2] = evenHash[index] ?? 0;
    key[index * 2 + 1] = oddHash[index] ?? 0;
  }
  return key;
}

export async function computeSrpProof(
  usernameInput: string,
  passwordInput: string,
  challenge: SrpChallenge,
  privateKey?: Uint8Array,
): Promise<SrpProof> {
  const username = uppercaseBasicLatin(usernameInput);
  const password = uppercaseBasicLatin(passwordInput);
  const N = littleEndianToBigInt(challenge.N);
  const g = littleEndianToBigInt(challenge.g);
  const B = littleEndianToBigInt(challenge.B);

  if (challenge.N.byteLength !== 32 || N !== WOW_N || challenge.g.byteLength !== 1 || g !== WOW_G) {
    throw new Error("Authserver supplied unsupported SRP6 parameters");
  }
  if (challenge.B.byteLength !== 32 || B % N === 0n || challenge.salt.byteLength !== 32) {
    throw new Error("Authserver supplied an invalid SRP6 challenge");
  }

  const aBytes = privateKey ?? globalThis.crypto.getRandomValues(new Uint8Array(19));
  const a = littleEndianToBigInt(aBytes);
  if (a === 0n) throw new Error("SRP6 private key cannot be zero");

  const identityHash = await sha1Bytes(encoder.encode(`${username}:${password}`));
  const x = littleEndianToBigInt(await sha1Bytes(challenge.salt, identityHash));
  const A = bigIntToLittleEndian(modPow(g, a, N), 32);
  const u = littleEndianToBigInt(await sha1Bytes(A, challenge.B));
  if (u === 0n) throw new Error("SRP6 scrambling parameter cannot be zero");

  const verifier = modPow(g, x, N);
  const base = ((B - 3n * verifier) % N + N) % N;
  const secret = bigIntToLittleEndian(modPow(base, a + u * x, N), 32);
  const sessionKey = await sha1Interleave(secret);

  const [nHash, gHash, usernameHash] = await Promise.all([
    sha1Bytes(challenge.N),
    sha1Bytes(challenge.g),
    sha1Bytes(encoder.encode(username)),
  ]);
  const ngHash = nHash.map((value, index) => value ^ (gHash[index] ?? 0));
  const M1 = await sha1Bytes(ngHash, usernameHash, challenge.salt, A, challenge.B, sessionKey);
  const M2 = await sha1Bytes(A, M1, sessionKey);

  return { A, M1, M2, sessionKey };
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
