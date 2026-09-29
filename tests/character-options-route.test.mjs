import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

let dbc;
try { dbc = dbcDirectory(); } catch { dbc = undefined; }
const withDataset = { skip: dbc && existsSync(join(dbc, "CharSections.dbc"))
  ? false : "no selected CharSections dataset on this machine" };

test("character-options route gives ordinary classes only looks accepted by the selected core", withDataset, async () => {
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin], dbcDirectory: dbc, datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/character-options?v=6&race=1&sex=0`;
  try {
    const warriorResponse = await fetch(`${base}&class=1`, { headers: { origin } });
    const knightResponse = await fetch(`${base}&class=6`, { headers: { origin } });
    assert.equal(warriorResponse.status, 200);
    assert.equal(knightResponse.status, 200);
    const warrior = await warriorResponse.json();
    const knight = await knightResponse.json();
    assert.ok([12, 13, 14].every((skin) => !warrior.skins.includes(skin)));
    assert.ok([12, 13, 14].every((skin) => knight.skins.includes(skin)));
    assert.deepEqual(warrior.facesBySkin[12], undefined);
    assert.deepEqual(knight.facesBySkin[12], [0, 2, 11]);
    assert.equal((await fetch(`${base}&class=0`, { headers: { origin } })).status, 400);
  } finally {
    await gateway.close();
  }
});
