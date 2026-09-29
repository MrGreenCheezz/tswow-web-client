import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVendorCostMetadata } from "../dist/code/gateway/VendorCostMetadata.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

const FIELDS = 16;
const RECORD_SIZE = FIELDS * 4;

async function writeCosts(directory, rows, fields = FIELDS, recordSize = RECORD_SIZE) {
  const strings = Buffer.from([0]);
  const data = Buffer.alloc(20 + rows.length * recordSize + strings.length);
  data.write("WDBC");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(strings.length, 16);
  for (let row = 0; row < rows.length; row++) {
    for (const [field, value] of Object.entries(rows[row])) {
      data.writeUInt32LE(value, 20 + row * recordSize + Number(field) * 4);
    }
  }
  await writeFile(join(directory, "ItemExtendedCost.dbc"), data);
}

test("vendor costs use the exact 16-field ItemExtendedCost layout and pair turn-ins by slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vendor-cost-dbc-"));
  try {
    await writeCosts(directory, [{
      0: 17, 1: 12_500, 2: 650, 3: 1,
      4: 1001, 5: 0, 6: 1003, 7: 1004, 8: 1005,
      9: 2, 10: 99, 11: 3, 12: 0, 13: 4,
      14: 1850, 15: 424_242,
    }, { 0: 18 }]);

    assert.deepEqual(await loadVendorCostMetadata(directory), {
      costs: {
        17: {
          honor: 12_500,
          arena: 650,
          arenaBracket: 1,
          rating: 1850,
          items: [{ entry: 1001, count: 2 }, { entry: 1003, count: 3 }, { entry: 1005, count: 4 }],
        },
        18: { honor: 0, arena: 0, arenaBracket: 0, rating: 0, items: [] },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("vendor costs reject a non-3.3.5 ItemExtendedCost header before reading any row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vendor-cost-bad-dbc-"));
  try {
    await writeCosts(directory, [{ 0: 1 }], 15, 60);
    await assert.rejects(loadVendorCostMetadata(directory), /16 fields of 64 bytes/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("vendor cost catalog is origin-protected, versioned and fresh from the active dataset", async () => {
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin],
    dbcDirectory: dbcDirectory(),
    datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/vendor-costs`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const first = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("access-control-allow-origin"), origin);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = await first.json();
    assert.ok(Object.keys(body.costs).length > 0);
    for (const cost of Object.values(body.costs)) {
      assert.ok(Number.isInteger(cost.honor) && cost.honor >= 0);
      assert.ok(Number.isInteger(cost.arena) && cost.arena >= 0);
      assert.ok(Number.isInteger(cost.arenaBracket) && cost.arenaBracket >= 0);
      assert.ok(Number.isInteger(cost.rating) && cost.rating >= 0);
      assert.ok(cost.items.length <= 5);
      for (const item of cost.items) assert.ok(item.entry > 0 && item.count > 0);
    }
    assert.deepEqual(await (await fetch(`${base}?v=1`, { headers: { origin } })).json(), body);
  } finally {
    await gateway.close();
  }
});
