// A6 / 1.02 probe (read-only, no network): the HMAC-SHA1 proposed for src/auth/Sha1.ts checked against
// RFC 2202 and node:crypto, and the present WorldCrypt shown failing without Web Crypto.
// Run from F:\tswowRoot\WebClient:
//   .runtime/node/node.exe --import ./tools/register-test-sources.mjs <this file>
import { createHmac, randomBytes } from "node:crypto";
import { sha1 } from "file:///F:/tswowRoot/WebClient/dist/code/auth/Sha1.js";
import { WorldCrypt } from "file:///F:/tswowRoot/WebClient/dist/code/world/WorldCrypt.js";

// ---- the candidate (this is the body the spec puts into src/auth/Sha1.ts) ----
const HMAC_BLOCK = 64;
function hmacSha1Plain(key, data) {
  const block = new Uint8Array(HMAC_BLOCK);
  block.set(key.byteLength > HMAC_BLOCK ? sha1(key) : key);
  const inner = new Uint8Array(HMAC_BLOCK + data.byteLength);
  const outer = new Uint8Array(HMAC_BLOCK + 20);
  for (let index = 0; index < HMAC_BLOCK; index++) {
    inner[index] = block[index] ^ 0x36;
    outer[index] = block[index] ^ 0x5c;
  }
  inner.set(data, HMAC_BLOCK);
  outer.set(sha1(inner), HMAC_BLOCK);
  return sha1(outer);
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const fill = (value, length) => new Uint8Array(length).fill(value);
const ascii = (text) => new TextEncoder().encode(text);

// RFC 2202, section 3 (HMAC-SHA-1): test_case, key, data, digest.
const vectors = [
  [1, fill(0x0b, 20), ascii("Hi There"), "b617318655057264e28bc0b6fb378c8ef146be00"],
  [2, ascii("Jefe"), ascii("what do ya want for nothing?"), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"],
  [3, fill(0xaa, 20), fill(0xdd, 50), "125d7342b9ac11cd91a39af48aa17b4f63f175d3"],
  [4, Uint8Array.from({ length: 25 }, (_, i) => i + 1), fill(0xcd, 50), "4c9007f4026250c6bc8414f9bf50c86c2d7235da"],
  [5, fill(0x0c, 20), ascii("Test With Truncation"), "4c1a03424b55e07fe7f27be1d58bb9324a9a5a04"],
  [6, fill(0xaa, 80), ascii("Test Using Larger Than Block-Size Key - Hash Key First"), "aa4ae5e15272d00e95705637ce8a3b55ed402112"],
  [7, fill(0xaa, 80), ascii("Test Using Larger Than Block-Size Key and Larger Than One Block-Size Data"), "e8e99d0f45237d786d6bbaa7965c7808bbff1a91"],
];
let bad = 0;
for (const [id, key, data, expected] of vectors) {
  const got = hex(hmacSha1Plain(key, data));
  const node = createHmac("sha1", key).update(data).digest("hex");
  const ok = got === expected && node === expected;
  if (!ok) bad++;
  console.log(`RFC2202 #${id}: ${ok ? "ok" : "MISMATCH"} ${ok ? "" : `got ${got} node ${node} expected ${expected}`}`);
}
// Every key length around the block (0..130) and data lengths around the SHA-1 padding edges.
let random = 0;
for (let keyLength = 0; keyLength <= 130; keyLength++) {
  for (const dataLength of [0, 1, 40, 55, 56, 63, 64, 65, 119, 120, 200]) {
    const key = new Uint8Array(randomBytes(keyLength));
    const data = new Uint8Array(randomBytes(dataLength));
    if (hex(hmacSha1Plain(key, data)) !== createHmac("sha1", key).update(data).digest("hex")) bad++;
    random++;
  }
}
console.log(`random comparisons against node:crypto: ${random}, mismatches so far: ${bad}`);

// The world header keys as WorldCrypt derives them: 16-byte constant key, 40-byte session key.
const SERVER_ENCRYPTION_KEY = Uint8Array.of(0xcc, 0x98, 0xae, 0x04, 0xe8, 0x97, 0xea, 0xca, 0x12, 0xdd, 0xc0, 0x93, 0x42, 0x91, 0x53, 0x57);
const sessionKey = Uint8Array.from({ length: 40 }, (_, i) => i + 1);
console.log("world key parity:", hex(hmacSha1Plain(SERVER_ENCRYPTION_KEY, sessionKey)) === createHmac("sha1", SERVER_ENCRYPTION_KEY).update(sessionKey).digest("hex"));

// The present defect: WorldCrypt.create without crypto.subtle (a page opened as http://<public address>/).
const nativeCrypto = globalThis.crypto;
Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a) => nativeCrypto.getRandomValues(a) }, configurable: true });
try {
  await WorldCrypt.create(sessionKey);
  console.log("WorldCrypt.create without subtle: NO ERROR (already fixed)");
} catch (error) {
  console.log(`WorldCrypt.create without subtle: ${error.constructor.name}: ${error.message}`);
} finally {
  Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true });
}
console.log(bad === 0 ? "HMAC candidate: all good" : `HMAC candidate: ${bad} FAILURES`);
