import assert from "node:assert/strict";
import test from "node:test";

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
