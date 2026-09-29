import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSlotPrices } from "../dist/code/gateway/SlotPrices.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

async function writePrices(directory, file, rows) {
  const data = Buffer.alloc(20 + rows.length * 8 + 1);
  data.write("WDBC");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(2, 8);
  data.writeUInt32LE(8, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach(([id, cost], row) => {
    data.writeUInt32LE(id, 20 + row * 8);
    data.writeUInt32LE(cost, 20 + row * 8 + 4);
  });
  await writeFile(join(directory, file), data);
}

async function writeBoth(directory, bank, stable) {
  await writePrices(directory, "BankBagSlotPrices.dbc", bank);
  await writePrices(directory, "StableSlotPrices.dbc", stable);
}

test("slot prices read id-to-cost rows for both tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slot-prices-dbc-"));
  try {
    await writeBoth(directory, [[1, 1000], [2, 10000]], [[1, 500], [3, 500000]]);
    assert.deepEqual(await loadSlotPrices(directory), {
      bank: { 1: 1000, 2: 10000 },
      stable: { 1: 500, 3: 500000 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("slot prices reject a wrong layout and duplicate ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slot-prices-bad-"));
  try {
    await writeBoth(directory, [[1, 1000]], [[1, 500]]);
    const { readFile } = await import("node:fs/promises");
    const path = join(directory, "BankBagSlotPrices.dbc");
    const data = await readFile(path);
    data.writeUInt32LE(12, 12);
    await writeFile(path, data);
    await assert.rejects(loadSlotPrices(directory), /2 fields of 8 bytes/);

    await writeBoth(directory, [[1, 1000], [1, 2000]], [[1, 500]]);
    await assert.rejects(loadSlotPrices(directory), /duplicate price id 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the dataset's slot prices match the core's lookup rows", async () => {
  let directory;
  try {
    directory = dbcDirectory();
  } catch {
    return;
  }
  const prices = await loadSlotPrices(directory);
  // BankHandler.cpp looks up `GetBankBagSlotCount()+1`; the first bank slot costs 10 silver.
  assert.equal(prices.bank[1], 1000);
  // NPCHandler.cpp looks up `MaxStabledPets+1`; the first stable slot costs 5 silver.
  assert.equal(prices.stable[1], 500);
  assert.ok(Object.keys(prices.bank).length >= 7, "seven buyable bank slots and more");
  assert.ok(Object.keys(prices.stable).length >= 4, "four stable slots");
});

test("slot prices are origin-protected, versioned and served from the active dataset", async () => {
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
  const base = `http://127.0.0.1:${gateway.port}/dbc/slot-prices`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const first = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.bank["1"], 1000);
    assert.equal(body.stable["1"], 500);
    assert.deepEqual(await (await fetch(`${base}?v=1`, { headers: { origin } })).json(), body);
  } finally {
    await gateway.close();
  }
});
