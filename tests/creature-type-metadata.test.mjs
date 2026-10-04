import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// Plan item 3.23A: `/dbc/creature-types?v=1` (gateway/CreatureTypeMetadata.ts) and the answers of
// UnitCreatureType/UnitCreatureFamily over it (FrameXmlCreatureType.ts), as Wow.exe 0x611780/0x71f300
// and 0x611820/0x7153e0 pick them. Nothing here talks to the running gateway.
const { CREATURE_TYPES_VERSION, loadCreatureTypes } = await import("../dist/code/gateway/CreatureTypeMetadata.js");
const { serveCatalogRoute, CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { CREATURE_TYPES_ROUTE_PATH, CREATURE_TYPES_ROUTE_VERSION, creatureTypeTableFrom } =
  await import("../dist/code/browser/CreatureTypeClient.js");
const { FRAMEXML_CREATURE_TYPE_BINDINGS, frameXmlUnitCreatureFamily } = await import("../dist/code/browser/framexml/FrameXmlCreatureType.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

let dbcDirectory;
try { dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory(); } catch { dbcDirectory = undefined; }
const withDataset = {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/CreatureType.dbc`) ? false : "no dataset DBCs on this machine",
};

const SAMPLE = {
  version: 1,
  types: [[1, "Животное"], [7, "Гуманоид"], [8, "Существо"]],
  families: [[1, "Волк"], [2, "Кошка"]],
  races: [[1, 7], [2, 7]],
  forms: [[1, 1], [5, 1]],
};

test("the route and the client agree on the version and the path", () => {
  assert.equal(CREATURE_TYPES_ROUTE_VERSION, CREATURE_TYPES_VERSION);
  assert.equal(CREATURE_TYPES_ROUTE_PATH, `/dbc/creature-types?v=${CREATURE_TYPES_VERSION}`);
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/creature-types" && route.version === CREATURE_TYPES_VERSION));
  assert.ok(creatureTypeTableFrom(SAMPLE));
  assert.equal(creatureTypeTableFrom({ ...SAMPLE, version: 2 }), undefined);
  assert.equal(creatureTypeTableFrom({ ...SAMPLE, types: [[1]] }), undefined);
  assert.equal(creatureTypeTableFrom({ ...SAMPLE, races: [[1, "x"]] }), undefined);
});

test("this dataset's tables: the ruRU names, Human is a humanoid, bear and cat forms are beasts", withDataset, async () => {
  const catalog = await loadCreatureTypes(dbcDirectory);
  const table = creatureTypeTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table);
  assert.equal(table.typeName(1), "Животное");
  assert.equal(table.typeName(7), "Гуманоид");
  assert.equal(table.typeName(8), "Существо");
  assert.equal(table.typeName(13), "Облако газа");
  assert.equal(table.raceType(1), 7);
  assert.equal(table.raceType(2), 7, "an orc too (its BaseLanguage, the field before, is 1)");
  assert.equal(table.formType(1), 1, "cat form");
  assert.equal(table.formType(5), 1, "bear form");
  assert.equal(table.formType(6), undefined, "a form whose CreatureType is 0 keeps the race's type");
  assert.equal(table.formType(9), undefined, "and so does one at -1");
  assert.ok(table.familyName(1), "CreatureFamily 1 is named");
});

test("the route answers through the catalog table with the Origin and version checks", withDataset, async () => {
  const run = async (path, origin) => {
    const url = new URL(path, "http://127.0.0.1");
    const response = { status: 0, body: "", writeHead(status) { this.status = status; return this; }, end(body = "") { this.body = body; return this; } };
    const handled = await serveCatalogRoute({ method: "GET", headers: { origin } }, response, url, new Map(),
      { dbcDirectory, allowedOrigins: ["http://127.0.0.1:5173"] });
    return { handled, ...response };
  };
  const ok = await run(CREATURE_TYPES_ROUTE_PATH, "http://127.0.0.1:5173");
  assert.equal(ok.status, 200);
  assert.ok(creatureTypeTableFrom(JSON.parse(ok.body)));
  assert.equal((await run("/dbc/creature-types?v=9", "http://127.0.0.1:5173")).status, 400);
  assert.equal((await run(CREATURE_TYPES_ROUTE_PATH, "http://evil.test")).status, 403);
});

function seamFixture(table) {
  const offset = (name) => UPDATE_FIELDS[name].offset;
  const selfGuid = 0x10n;
  const wolfGuid = 0xf130000000000100n;
  const self = { guid: selfGuid, typeId: 4, fields: new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (11 << 8)]]) };
  const wolf = { guid: wolfGuid, typeId: 3, fields: new Map([[offset("OBJECT_FIELD_ENTRY"), 299]]) };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [wolfGuid, wolf]]) }, targetGuid: wolfGuid,
    creatureTemplates: new Map([[299, { found: true, name: "Волк", creatureType: 1, creatureFamily: 1 }]]),
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0, partyStats: new Map(),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1,
    globalCooldownUntil: () => 0, castSpell: () => {}, creatureTypes: { table: () => table },
  });
  const call = (name, unit) => [...FRAMEXML_SEAM_BINDINGS[name](seam, [unit])];
  return { self, wolf, world, call, offset };
}

test("UnitCreatureType: the creature's type, the player's race type, a druid form's own type", () => {
  const table = creatureTypeTableFrom(SAMPLE);
  const { call, self, offset } = seamFixture(table);
  assert.equal(FRAMEXML_SEAM_BINDINGS.UnitCreatureType, FRAMEXML_CREATURE_TYPE_BINDINGS.UnitCreatureType);
  assert.deepEqual(call("UnitCreatureType", "target"), ["Животное"]);
  assert.deepEqual(call("UnitCreatureType", "player"), ["Гуманоид"], "ChrRaces.CreatureType of a human");
  self.fields.set(offset("UNIT_FIELD_BYTES_2"), 5 << 24);
  assert.deepEqual(call("UnitCreatureType", "player"), ["Животное"], "bear form's SpellShapeshiftForm type");
  self.fields.set(offset("UNIT_FIELD_BYTES_2"), 3 << 24);
  assert.deepEqual(call("UnitCreatureType", "player"), ["Гуманоид"], "a form without a type keeps the race's");
  assert.deepEqual(call("UnitCreatureType", "focus"), []);
});

test("UnitCreatureFamily: a creature's family by name; a player none; without the table the pet stays the stable's", () => {
  const { call } = seamFixture(creatureTypeTableFrom(SAMPLE));
  assert.deepEqual(call("UnitCreatureFamily", "target"), ["Волк"]);
  assert.deepEqual(call("UnitCreatureFamily", "player"), []);
  assert.equal(frameXmlUnitCreatureFamily({ typeId: 4, fields: new Map() }, { found: true, creatureType: 7, creatureFamily: 1 },
    creatureTypeTableFrom(SAMPLE)), undefined, "a player has no creature cache, whatever template is handed in");
  const host = { creatureTypes: { type: () => undefined, family: () => undefined }, stable: { petFamilyName: () => "Кошка" } };
  assert.deepEqual([...FRAMEXML_CREATURE_TYPE_BINDINGS.UnitCreatureFamily(host, ["pet"])], ["Кошка"]);
  assert.deepEqual([...FRAMEXML_CREATURE_TYPE_BINDINGS.UnitCreatureFamily(host, ["target"])], []);
  const noTable = seamFixture(undefined);
  assert.deepEqual(noTable.call("UnitCreatureType", "target"), [], "no table yet: nil, never a guessed name");
});
