import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReputationMetadata } from "../dist/code/gateway/ReputationMetadata.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

async function writeFactions(directory, rows) {
  // Independent build-12340 fixture: ID, ReputationIndex, 4 race masks, 4 class masks,
  // 4 signed bases, 4 flags, parent fields and two 17-word localized strings.
  const data = Buffer.alloc(20 + rows.length * 228 + 1);
  data.write("WDBC"); data.writeUInt32LE(rows.length, 4); data.writeUInt32LE(57, 8);
  data.writeUInt32LE(228, 12); data.writeUInt32LE(1, 16);
  rows.forEach((fields, row) => {
    for (const [field, value] of Object.entries(fields))
      data.writeUInt32LE(value >>> 0, 20 + row * 228 + Number(field) * 4);
  });
  await writeFile(join(directory, "Faction.dbc"), data);
}

test("reputation uses list indexes, keeps signed bases and unsigned race/class masks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reputation-dbc-"));
  try {
    await writeFactions(directory, [
      { 0: 72, 1: 19, 2: 1, 3: 0x80000000, 4: 4, 6: 8, 7: 0xffffffff,
        10: 4000, 11: -42000, 12: -6000, 13: 0, 14: 17, 15: 2 },
      { 0: 99, 1: -1 },
    ]);
    assert.deepEqual(await loadReputationMetadata(directory), {
      version: 1, factions: { 19: { factionId: 72, raceMasks: [1, 0x80000000, 4, 0],
        classMasks: [8, 0xffffffff, 0, 0], bases: [4000, -42000, -6000, 0], flags: [17, 2, 0, 0] } },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reputation rejects ambiguous or unrepresentable list indexes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reputation-invalid-"));
  try {
    for (const rows of [[{ 0: 1, 1: 128 }], [{ 0: 1, 1: 0 }, { 0: 2, 1: 0 }]]) {
      await writeFactions(directory, rows);
      await assert.rejects(loadReputationMetadata(directory), /invalid or duplicate reputation list index/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reputation endpoint enforces origin/version and reads the active Faction table", async () => {
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({ host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin], dbcDirectory: dbcDirectory(), datasetPollMs: 0 });
  const base = `http://127.0.0.1:${gateway.port}/dbc/reputation`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const response = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const body = await response.json();
    assert.equal(body.version, 1);
    assert.ok(Object.keys(body.factions).length > 0 && Object.keys(body.factions).length <= 128);
    assert.deepEqual(body, await loadReputationMetadata(dbcDirectory()));
    assert.deepEqual(await (await fetch(`${base}?v=1`, { headers: { origin } })).json(), body);
  } finally { await gateway.close(); }
});
