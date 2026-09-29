import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBarberCosts, parseBarberCosts } from "../dist/code/gateway/BarberCostMetadata.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

// gtBarberShopCostBase.dbc, the table Player::GetBarberShopCost prices a haircut from, and the
// /dbc/barber-cost route the stock BarberShopFrame's price reads.

function costFile(values, { fields = 1, recordSize = 4, trailing = 0 } = {}) {
  const data = Buffer.alloc(20 + values.length * recordSize + 1 + trailing);
  data.write("WDBC");
  data.writeUInt32LE(values.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(1, 16);
  values.forEach((value, row) => data.writeFloatLE(value, 20 + row * recordSize));
  return data;
}

test("the base price per level is read as the core's float", () => {
  assert.deepEqual(parseBarberCosts(costFile([0, 3, 4.5, 111173])), { costs: [0, 3, 4.5, 111173] });
  assert.deepEqual(parseBarberCosts(costFile([Number.NaN, -1])), { costs: [0, 0] }, "no NaN or negative price is served");
  assert.throws(() => parseBarberCosts(costFile([1], { fields: 2, recordSize: 8 })), /1 field of 4 bytes/);
  assert.throws(() => parseBarberCosts(costFile([1], { trailing: 1 })), /truncated or trailing/);
  assert.throws(() => parseBarberCosts(Buffer.from("WDBX")), /not a WDBC file/);
});

test("the dataset's table has the hundred levels GT_MAX_LEVEL indexes", async () => {
  let directory;
  try {
    directory = dbcDirectory();
  } catch {
    return;
  }
  const { costs } = await loadBarberCosts(directory);
  assert.equal(costs.length, 100);
  // Measured on this dataset: level 60 44,678 copper, level 80 111,173, level 100 223,468.
  assert.deepEqual([costs[59], costs[79], costs[99]], [44_678, 111_173, 223_468]);
});

test("the route is origin-protected, versioned and served from the active dataset", async () => {
  const origin = "http://127.0.0.1:5173";
  const directory = await mkdtemp(join(tmpdir(), "barber-cost-dbc-"));
  await writeFile(join(directory, "gtBarberShopCostBase.dbc"), costFile([0, 3, 4, 111173]));
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin],
    dbcDirectory: directory,
    datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/barber-cost`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const answer = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("access-control-allow-origin"), origin);
    assert.deepEqual(await answer.json(), { costs: [0, 3, 4, 111173] });
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
