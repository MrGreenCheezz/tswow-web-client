import assert from "node:assert/strict";
import test from "node:test";

const { FactionClient } = await import("../dist/code/browser/FactionClient.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam, CANNED_REPUTATION } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const lookup = (seam, id) => [...FRAMEXML_SEAM_BINDINGS.GetFactionInfoByID(seam, [id])];

test("FactionClient preloads the versioned reputation catalog once, outside C API reads", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  const catalog = { version: 1, factions: { 1: { factionId: 72 } } };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return { ok: true, json: async () => catalog };
  };
  try {
    const client = new FactionClient("ws://127.0.0.1:8090");
    assert.equal(client.reputationCatalog, undefined);
    client.loadReputation();
    client.loadReputation();
    await new Promise(setImmediate);
    assert.deepEqual(requested, ["http://127.0.0.1:8090/dbc/reputation?v=1"]);
    assert.equal(client.reputationCatalog, catalog);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GetFactionInfoByID returns the live 13-field row for a mapped DBC ID", () => {
  const world = { state: { selfGuid: 1n, objects: new Map() } };
  const catalog = { version: 1, factions: { 0: { factionId: 469 }, 1: { factionId: 72 } } };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    reputation: () => CANNED_REPUTATION, reputationCatalog: () => catalog,
  });
  assert.deepEqual(lookup(new CannedWorldSeam(), 72), [],
    "canned visible rows alone do not establish DBC identities");
  assert.deepEqual(lookup(seam, 72),
    [...FRAMEXML_SEAM_BINDINGS.GetFactionInfo(seam, [2])]);
  assert.equal(lookup(seam, 72).length, 13);
  const childInfo = lookup(seam, 72);
  assert.deepEqual(lookup(seam, 9999), []);
  assert.deepEqual(lookup(seam, "72"), [], "native ID is numeric");
  FRAMEXML_SEAM_BINDINGS.CollapseFactionHeader(seam, [1]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetFactionInfo(seam, [2]), [],
    "index-based API hides a collapsed child");
  assert.deepEqual(lookup(seam, 72), childInfo,
    "ID-based API still resolves a collapsed child for QuestInfo rewards");
});
