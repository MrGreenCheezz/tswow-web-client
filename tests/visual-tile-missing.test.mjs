// 25.10: a cell outside the map (the Deadmines' row 29: no ADT, no global WMO) is a final 404 from
// `/visual/environment`, as from `/terrain-splat` — not a 500 the browser asks for again and again.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startGateway } from "../dist/code/gateway/Gateway.js";

const ORIGIN = "http://127.0.0.1:5173";

async function status(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { origin: ORIGIN } });
  await response.arrayBuffer();
  return response.status;
}

test("the route answers a missing source with 404 and a crashed generator with 500", async () => {
  const tiles = await mkdtemp(join(tmpdir(), "webclient-visual-missing-"));
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
    allowedOrigins: [ORIGIN], visualTilesDirectory: tiles, datasetPollMs: 0,
    generateVisualTile: async (map, gridX) => {
      throw Object.assign(new Error(`${map}/${gridX}`), { exitCode: gridX === 29 ? 3 : 1 });
    },
  });
  try {
    assert.equal(await status(gateway.port, "/visual/environment/36/29/32?v=7"), 404, "no ADT here");
    assert.equal(await status(gateway.port, "/visual/environment/36/30/32?v=7"), 500, "a crash stays a 500");
  } finally {
    await gateway.close();
    await rm(tiles, { recursive: true, force: true });
  }
});
