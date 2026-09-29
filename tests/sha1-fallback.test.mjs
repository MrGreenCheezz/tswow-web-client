import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { sha1 } from "../dist/code/auth/Sha1.js";
import { computeSrpProof } from "../dist/code/auth/Srp6.js";

function nodeSha1(bytes) {
  return new Uint8Array(createHash("sha1").update(bytes).digest());
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
