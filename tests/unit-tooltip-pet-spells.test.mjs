import assert from "node:assert/strict";
import test from "node:test";

// Plan item 4.04 (11.11): beast lore's PET_SPELLS_TEMPLATE (Wow.exe 0x00620950): `/dbc/pet-spells` (gateway
// PetSpellMetadata.ts) lists, per creature family, the SkillLineAbility spells of its two skill lines with
// AcquireMethod 2 and SupercededBySpell 0 whose Spell row is neither passive nor hidden; the line comes after
// TAMEABLE / TAMEABLE_EXOTIC, names joined by ", ", only for a tameable creature.
const { petSpellCatalog, loadPetSpells, PET_SPELLS_VERSION } = await import("../dist/code/gateway/PetSpellMetadata.js");
const { petSpellTableFrom, PET_SPELLS_ROUTE_VERSION } = await import("../dist/code/browser/PetSpellClient.js");
const { frameXmlBeastLoreRows } = await import("../dist/code/browser/framexml/FrameXmlUnitTooltipFacts.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("the catalog: both skill lines in order, table order inside, the four filters", () => {
  const families = [{ id: 1, skillLines: [208, 270] }, { id: 2, skillLines: [0, 0] }];
  const abilities = [
    { skillLine: 270, spell: 10, supercededBy: 0, acquireMethod: 2 },
    { skillLine: 208, spell: 11, supercededBy: 0, acquireMethod: 2 },
    { skillLine: 208, spell: 12, supercededBy: 99, acquireMethod: 2 }, // a lower rank
    { skillLine: 208, spell: 13, supercededBy: 0, acquireMethod: 1 }, // not learned with the skill
    { skillLine: 208, spell: 14, supercededBy: 0, acquireMethod: 2 }, // passive
    { skillLine: 208, spell: 15, supercededBy: 0, acquireMethod: 2 }, // no Spell row
    { skillLine: 208, spell: 16, supercededBy: 0, acquireMethod: 2 },
  ];
  const spells = new Map([[10, { attributes: 0, name: "Рык" }], [11, { attributes: 0, name: "Укус" }],
    [12, { attributes: 0, name: "Старый укус" }], [13, { attributes: 0, name: "Рывок" }],
    [14, { attributes: 0x40, name: "Пассивное" }], [16, { attributes: 0x10000, name: "Когти" }]]);
  assert.deepEqual(petSpellCatalog(families, abilities, (id) => spells.get(id)),
    { version: 1, families: [[1, ["Укус", "Когти", "Рык"]]] });
  assert.equal(PET_SPELLS_VERSION, PET_SPELLS_ROUTE_VERSION, "route and client agree on ?v=");
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/pet-spells"));
});

test("the client table and the beast lore line", () => {
  const table = petSpellTableFrom({ version: 1, families: [[1, ["Укус", "Когти"]]] });
  assert.deepEqual(table.familySpells(1), ["Укус", "Когти"]);
  assert.deepEqual(table.familySpells(5), []);
  assert.equal(petSpellTableFrom({ version: 2, families: [] }), undefined);
  assert.equal(petSpellTableFrom({ version: 1, families: [[1, "Укус"]] }), undefined);
  const fields = new Map([[UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 0x10], [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100]]);
  const beast = { guid: 0xf13n, typeId: 3, fields };
  const record = (flags) => ({ found: true, flags, classification: 0, creatureFamily: 1 });
  const rows = frameXmlBeastLoreRows(beast, record(1), undefined, table);
  assert.deepEqual(rows.slice(-2), [{ key: "TAMEABLE", args: [] }, { key: "PET_SPELLS_TEMPLATE", args: ["Укус, Когти"] }]);
  assert.equal(frameXmlBeastLoreRows(beast, record(0), undefined, table).at(-1).key, "NOT_TAMEABLE", "not tameable: no line");
  assert.equal(frameXmlBeastLoreRows(beast, record(1), undefined, undefined).at(-1).key, "TAMEABLE", "no table: no line");
});

test("on the dataset: the wolf family (1) lists its own spells, every name non-empty", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async (t) => {
  const catalog = await loadPetSpells(dbcDirectory);
  const wolf = catalog.families.find(([id]) => id === 1);
  assert.ok(wolf, "family 1 has pet spells");
  t.diagnostic(wolf[1].join(", "));
  assert.ok(wolf[1].length > 0 && wolf[1].every((name) => name.length > 0), JSON.stringify(wolf));
});
