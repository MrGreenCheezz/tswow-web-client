import assert from "node:assert/strict";
import test from "node:test";

import { startGateway } from "../dist/code/gateway/Gateway.js";

const nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function health(options = {}) {
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [],
    ...options,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    await gateway.close();
  }
}

test("local asset health nonce is opt-in and exact", async () => {
  // Existing gateways keep their exact, token-free liveness response.
  assert.equal(await health(), '{"status":"ok"}');

  assert.deepEqual(JSON.parse(await health({ localAssetNonce: nonce })), {
    status: "ok",
    localAssetNonce: nonce,
  });

  await assert.rejects(
    startGateway({
      host: "127.0.0.1",
      port: 0,
      auth: { host: "127.0.0.1", port: 1 },
      world: { host: "127.0.0.1", port: 1 },
      allowedOrigins: [],
      localAssetNonce: nonce.toUpperCase(),
    }),
    /localAssetNonce must be 64 lowercase hexadecimal characters/,
  );
});
