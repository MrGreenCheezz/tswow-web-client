import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-faction-by-id-seam.test.mjs
{
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
}

// ── framexml-faction-by-id.test.mjs
{
const { frameXmlFactionIndexById, frameXmlFactionInfoById } = await import(
  "../dist/code/browser/framexml/FrameXmlFactionById.js"
);

const catalog = {
  version: 1,
  factions: {
    0: { factionId: 72 },
    19: { factionId: 47 },
    52: { factionId: 1097 },
  },
};
const snapshot = [{ listId: 52 }, { listId: 0 }, { listId: 19 }];

test("Faction.dbc IDs resolve through reputation list slots, then current one-based row indexes", () => {
  assert.equal(frameXmlFactionIndexById(72, catalog, snapshot), 2);
  assert.equal(frameXmlFactionIndexById(47, catalog, snapshot), 3);
  assert.equal(frameXmlFactionIndexById(1097, catalog, snapshot), 1);
  assert.equal(frameXmlFactionIndexById(19, catalog, snapshot), undefined,
    "a list slot must never be interpreted as a faction ID");
});

test("stock faction-by-ID returns the existing thirteen-value reputation tuple", () => {
  const tuple = ["Штормград", "", 5, 3000, 9000, 4000, false, true,
    false, false, true, true, false];
  const calls = [];
  assert.deepEqual(frameXmlFactionInfoById(72, catalog, snapshot, (index) => {
    calls.push(index);
    return index === 2 ? tuple : undefined;
  }), tuple);
  assert.deepEqual(calls, [2]);
  assert.equal(tuple.length, 13);
  assert.deepEqual([tuple[0], tuple[8], tuple[10]], ["Штормград", false, true]);
});

test("missing, invalid or ambiguous catalog and snapshot identities fail closed", () => {
  const noInfo = () => { throw new Error("unresolved faction must not ask for a row"); };
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "72", 999]) {
    assert.equal(frameXmlFactionInfoById(id, catalog, snapshot, noInfo), undefined);
  }
  assert.equal(frameXmlFactionIndexById(72, undefined, snapshot), undefined);
  assert.equal(frameXmlFactionIndexById(72, { ...catalog, version: 2 }, snapshot), undefined);
  assert.equal(frameXmlFactionIndexById(72, catalog, [{ listId: 52 }]), undefined);
  assert.equal(frameXmlFactionIndexById(72, catalog, [...snapshot, { listId: 0 }]), undefined);
  assert.equal(frameXmlFactionIndexById(72,
    { version: 1, factions: { 0: { factionId: 72 }, 1: { factionId: 72 } } }, snapshot), undefined);
  assert.equal(frameXmlFactionIndexById(72,
    { version: 1, factions: { 128: { factionId: 72 } } }, snapshot), undefined);
  assert.equal(frameXmlFactionIndexById(72,
    { version: 1, factions: { "00": { factionId: 72 } } }, snapshot), undefined);
});
}
