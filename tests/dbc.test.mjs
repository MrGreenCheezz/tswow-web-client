import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES, LOCSTRING_FIELDS, layoutForBuild, loadDbdLayout, parseDbd, vendoredTables } from "../tools/dbd.mjs";
import { openDbc, openDbcFile, WOTLK_BUILD } from "../tools/dbc.mjs";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const SAMPLE = `COLUMNS
int ID
int<Map::ID> ContinentID
string Name
locstring Title_lang
float Scale
int Flags?

BUILD 1.12.1.5875
$id$ID<32>
Name

BUILD 3.0.1.8303-3.3.5.12340
$id$ID<32>
ContinentID<32>
Name
Title_lang
Scale
Flags<u8>

LAYOUT DEADBEEF
BUILD 4.0.0.11927
$noninline,id$ID<32>
Name
`;

test("a definition parses into columns and version blocks", () => {
  const definition = parseDbd(SAMPLE);
  assert.equal(definition.columns.get("ContinentID").type, "int");
  assert.equal(definition.columns.get("ContinentID").foreignKey, "Map::ID");
  assert.equal(definition.columns.get("Title_lang").type, "locstring");
  assert.equal(definition.columns.get("Flags").nullable, true);
  assert.equal(definition.versions.length, 3);
  assert.deepEqual(definition.versions[2].layouts, ["DEADBEEF"]);
});

test("the block covering a build decides the layout", () => {
  const definition = parseDbd(SAMPLE);
  const wotlk = layoutForBuild(definition, WOTLK_BUILD);
  // 1 id + 1 continent + 1 string + 17 locstring + 1 float + 1 byte-wide flag.
  assert.equal(wotlk.fieldCount, 1 + 1 + 1 + LOCSTRING_FIELDS + 1 + 1);
  assert.equal(wotlk.recordSize, 4 + 4 + 4 + LOCSTRING_FIELDS * 4 + 4 + 1);
  assert.deepEqual(wotlk.fields.map((field) => [field.name, field.index]), [
    ["ID", 0], ["ContinentID", 1], ["Name", 2], ["Title_lang", 3], ["Scale", 20], ["Flags", 21],
  ]);
  assert.equal(wotlk.fields[0].isId, true);

  // Vanilla is a different block entirely, and Cataclysm moves the id out of the record.
  assert.equal(layoutForBuild(definition, [1, 12, 1, 5875]).fieldCount, 2);
  assert.equal(layoutForBuild(definition, [4, 0, 0, 11927]).fieldCount, 1);
  assert.equal(layoutForBuild(definition, [2, 4, 3, 8606]), undefined);
});

test("a locstring is sixteen slots plus a mask", () => {
  // Getting this wrong shifts every field after the first localised string and yields
  // plausible-looking garbage instead of an error, so it is pinned.
  assert.equal(LOCSTRING_FIELDS, 17);
  assert.equal(LOCALES.length, 16);
  assert.equal(LOCALES.indexOf("enUS"), 0);
  assert.equal(LOCALES.indexOf("ruRU"), 8);
});

test("COMMENT lines inside a block are not fields", () => {
  const definition = parseDbd(`COLUMNS\nint ID\n\nBUILD 3.3.5.12340\nCOMMENT table is sparse\n$id$ID<32>\n`);
  assert.equal(layoutForBuild(definition, WOTLK_BUILD).fieldCount, 1);
});

test("every vendored definition matches the real table's header", withDataset, async () => {
  // The strongest check available: 3.3.5 is fixed, so a definition either agrees with the bytes
  // on disk or it is wrong. This is what makes the generated offsets trustworthy.
  const checked = [];
  const failures = [];
  for (const table of await vendoredTables()) {
    let dbc;
    try {
      dbc = await openDbcFile(dbcDirectory, table);
    } catch (error) {
      // A table the dataset does not ship is not a definition problem.
      if (error.message.includes("could not be read")) continue;
      failures.push(error.message);
      continue;
    }
    checked.push(table);
    const layout = await loadDbdLayout(table, WOTLK_BUILD);
    assert.equal(dbc.fields, layout.fieldCount, `${table} field count`);
    assert.equal(dbc.recordSize, layout.recordSize, `${table} record size`);
  }
  assert.deepEqual(failures, []);
  assert.ok(checked.length >= 50, `expected most tables present, checked ${checked.length}`);
  // Named rather than counted, for the six written in this repository: the loop above passes if
  // one of them is deleted, because a table with no `.dbd` is simply never checked.
  for (const table of ["SoundAmbience", "WeaponImpactSounds", "WeaponSwingSounds2", "ItemSubClass",
    "Item", "UISoundLookups"]) {
    assert.ok(checked.includes(table), `${table} should be vendored and checked`);
  }
});

test("the six local sound definitions read the columns they claim to", withDataset, async () => {
  // `tools/dbd/README.md` says why these six were written here rather than fetched. The header
  // check above proves the shape; these are the values, because a definition can have the right
  // field count and still have two of its columns the wrong way round.
  const impacts = await openDbcFile(dbcDirectory, "WeaponImpactSounds");
  assert.equal(impacts.fields, 23);
  assert.equal(impacts.recordSize, 92);
  const axe = impacts.rowOf(1);
  assert.equal(impacts.int(axe, "WeaponSubClassID"), 0, "row 1 is the one-handed axe");
  assert.equal(impacts.int(axe, "ParrySoundType"), 1, "made of metal");
  // Flesh, chain, plate, metal shield, wood shield, metal weapon, wood weapon — the slot order,
  // readable in the names these resolve to: Axe1H_ArmorFlesh, _ArmorChain, _ArmorPlate,
  // «Shield Metal Impact», ShieldWoodImpact, 1hParryMetalHitMetal, 1hParryMetalHitWood.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((slot) => impacts.int(axe, "ImpactSoundID", slot)),
    [171, 173, 175, 3263, 3262, 1002, 1001]);
  assert.deepEqual([0, 1, 2].map((slot) => impacts.int(axe, "CritImpactSoundID", slot)),
    [172, 174, 176], "and the second array is the same three blows landed harder");

  const swings = await openDbcFile(dbcDirectory, "WeaponSwingSounds2");
  assert.equal(swings.fields, 4);
  assert.equal(swings.recordSize, 16);
  const medium = swings.rowOf(3);
  assert.equal(swings.int(medium, "SwingType"), 1);
  assert.equal(swings.int(medium, "Crit"), 0);
  assert.equal(swings.int(medium, "SoundID"), 235, "MediumWeaponNormal");

  const ambience = await openDbcFile(dbcDirectory, "SoundAmbience");
  assert.equal(ambience.fields, 3);
  assert.equal(ambience.recordSize, 12);
  assert.equal(ambience.records, 206);
  const beach = ambience.rowOf(24);
  assert.equal(ambience.int(beach, "AmbienceID", 0), 4164);
  assert.equal(ambience.int(beach, "AmbienceID", 1), 4165, "the second slot is the night one");

  const subClasses = await openDbcFile(dbcDirectory, "ItemSubClass");
  assert.equal(subClasses.fields, 44);
  assert.equal(subClasses.recordSize, 176);
  // No `$id$`: the key is the pair of columns, so this is read by walking rather than by `rowOf`.
  const swingSize = new Map();
  for (const row of subClasses.rows()) {
    if (subClasses.int(row, "ClassID") !== 2) continue;
    swingSize.set(subClasses.int(row, "SubClassID"), subClasses.int(row, "WeaponSwingSize"));
  }
  assert.equal(swingSize.get(15), 0, "a dagger is a light swing");
  assert.equal(swingSize.get(0), 1, "a one-handed axe is a medium one");
  assert.equal(swingSize.get(1), 2, "and a two-handed axe is a heavy one");
  assert.equal(swingSize.size, 21);

  const items = await openDbcFile(dbcDirectory, "Item");
  assert.equal(items.fields, 8);
  assert.equal(items.recordSize, 32);
  assert.equal(items.records, 46098);
  const sword = items.rowOf(25);
  assert.equal(items.int(sword, "ClassID"), 2);
  assert.equal(items.int(sword, "SubclassID"), 7, "a one-handed sword");
  assert.equal(items.int(sword, "Sound_Override_Subclassid"), -1);
  assert.equal(items.int(sword, "Material"), 1, "made of metal, which is what picks the metal row");
  assert.equal(items.int(sword, "SheatheType"), 3);

  const uiSounds = await openDbcFile(dbcDirectory, "UISoundLookups");
  assert.equal(uiSounds.fields, 3);
  assert.equal(uiSounds.recordSize, 12);
  const byName = new Map();
  for (const row of uiSounds.rows()) byName.set(uiSounds.string(row, "Name"), uiSounds.int(row, "SoundID"));
  assert.equal(byName.size, 129);
  assert.equal(byName.get("LEVELUP"), 888);
  assert.equal(byName.get("CURSORGRABOBJECT"), 902, "what `GameSounds.ts` looked for as PickUpGold");
});

test("SoundEntries reads by name, arrays and all", withDataset, async () => {
  // The audio work depends on this table, and its File[10]/Freq[10] arrays plus its era-specific
  // field order are exactly what a wrong build-range selection gets wrong.
  const dbc = await openDbcFile(dbcDirectory, "SoundEntries");
  assert.equal(dbc.fields, 30);
  assert.deepEqual(dbc.fieldNames.slice(0, 4), ["ID", "SoundType", "Name", "File"]);

  let resolvable = 0;
  let sampled = 0;
  for (const row of dbc.rows()) {
    const file = dbc.string(row, "File", 0);
    if (!file) continue;
    sampled++;
    if (sampled > 200) break;
    // DirectoryBase already carries the "Sound\" prefix; joining adds another separator only.
    const directory = dbc.string(row, "DirectoryBase");
    if (directory.toLowerCase().startsWith("sound") && /\.(wav|mp3|ogg)$/i.test(file)) resolvable++;
  }
  assert.ok(resolvable > 150, `expected most sampled entries to look like sound paths, got ${resolvable}`);

  const row = dbc.rowOf(dbc.id(0));
  assert.equal(row, 0);
});

test("Spell resolves the localised name the old code reached by literal offset", withDataset, async () => {
  const dbc = await openDbcFile(dbcDirectory, "Spell");
  assert.equal(dbc.fields, 234);
  // SpellMetadata.ts read slot 133 for the icon and 136/144 for the enUS/ruRU name. Those
  // numbers were correct; the point is that they now come from somewhere. `fieldNames` lists
  // entries, so the slot index has to come from the layout — an array or a locstring is one
  // entry occupying many slots, which is precisely the arithmetic the literals encoded.
  const layout = await loadDbdLayout("Spell", WOTLK_BUILD);
  const slotOf = (name) => layout.fields.find((field) => field.name === name).index;
  assert.equal(slotOf("SpellIconID"), 133);
  assert.equal(slotOf("Name_lang"), 136);
  // ruRU is locale 8, so the old literal 144 was Name_lang + 8.
  assert.equal(slotOf("Name_lang") + LOCALES.indexOf("ruRU"), 144);
  assert.equal(slotOf("NameSubtext_lang"), 153);

  const row = dbc.rowOf(133);
  assert.ok(row !== undefined, "spell 133 should exist");
  assert.ok(dbc.locstring(row, "Name_lang").length > 0);

  // Measured on this dataset: tswow writes one string offset into all sixteen locale slots, so
  // asking for enUS on a ruRU build returns the Russian text. The locale parameter is therefore
  // a no-op here and only earns its keep against a genuinely multi-locale table — worth knowing
  // before anyone builds a language switcher on top of it.
  const slots = LOCALES.map((locale) => dbc.locstring(row, "Name_lang", locale));
  assert.equal(new Set(slots).size, 1, "every locale slot should carry the same string");
});

test("a table whose shape does not match the definition fails loudly", async () => {
  // Twenty-byte header, one record of one field, but claiming two fields.
  const data = Buffer.alloc(24);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(1, 4);
  data.writeUInt32LE(2, 8);
  data.writeUInt32LE(4, 12);
  data.writeUInt32LE(0, 16);
  await assert.rejects(() => openDbc(data, "SpellIcon"), /describes 2 of 8|has \d+ fields/);
});

test("LightParams reads its glow and water alphas, not its neighbour's", withDataset, async () => {
  // Upstream's definition for this build omits CloudTypeID and ends with a Flags that 3.3.5 does
  // not have. Both are the same error: every float in the row is read one word early, so Glow
  // comes back as whatever CloudTypeID holds - zero on every row - and each water alpha takes its
  // neighbour's value. tools/dbd/LightParams.dbd carries a local correction, and `dbd:fetch` will
  // put the upstream version back without saying so. These five numbers are why this test exists.
  const dbc = await openDbcFile(dbcDirectory, "LightParams");
  const row = dbc.rowOf(12);
  assert.notEqual(row, undefined, "LightParams 12 should exist");
  assert.equal(dbc.int(row, "ID"), 12);
  assert.equal(dbc.int(row, "HighlightSky"), 1);
  assert.equal(dbc.int(row, "CloudTypeID"), 0);
  for (const [field, expected] of [
    ["Glow", 0.65], ["WaterShallowAlpha", 0.5], ["WaterDeepAlpha", 1],
    ["OceanShallowAlpha", 0.75], ["OceanDeepAlpha", 1],
  ]) {
    assert.ok(Math.abs(dbc.float(row, field) - expected) < 1e-6,
      `${field} should be ${expected}, got ${dbc.float(row, field)}`);
  }

  // A glow of zero on every row in the table is the shape the bug takes, so pin the negation too.
  let glowing = 0;
  for (const each of dbc.rows()) if (dbc.float(each, "Glow") > 0) glowing++;
  assert.ok(glowing > 800, `almost every light should glow, only ${glowing} of ${dbc.records} do`);
});

test("the creation form offers every playable race and class the dataset holds", withDataset, async () => {
  // Д3's acceptance, and the reason the form stopped being built from ten names compiled into it:
  // `ChrRaces` on this dataset holds 21 rows and `ChrClasses` 10, a module may add more, and a
  // race nobody can pick is a race nobody can play. The lists are read straight out of the route's
  // own loader and the browser's own list model, so adding a race to the dataset fails here unless
  // the client would actually put it on the screen.
  const { loadCharacterCreation } = await import("../dist/code/gateway/CharacterCreation.js");
  const { creationClasses, creationRaces } = await import("../dist/code/browser/ui/CharacterCreation.js");
  const { CLASS_NAMES, RACE_NAMES } = await import("../dist/code/browser/ui/UnitSnapshot.js");

  const data = await loadCharacterCreation(dbcDirectory);
  const offeredRaces = new Set(creationRaces(data).map((race) => race.id));
  const missingRaces = data.races.filter((race) => race.playable && !offeredRaces.has(race.id));
  assert.deepEqual(missingRaces.map((race) => `${race.id} ${race.name}`), []);

  const offeredClasses = new Set(creationClasses(data, undefined).map((entry) => entry.id));
  const missingClasses = data.classes.filter((entry) => entry.playable && !offeredClasses.has(entry.id));
  assert.deepEqual(missingClasses.map((entry) => `${entry.id} ${entry.name}`), []);
  assert.ok(offeredRaces.size >= 10 && offeredClasses.size >= 10,
    `expected at least the stock ten of each, got ${offeredRaces.size} races and ${offeredClasses.size} classes`);

  // The two assertions above are true of this dataset for two different reasons and cannot tell
  // them apart: the ten rows it marks playable are *exactly* the ten the old hardcoded records
  // carried, so a client that had quietly gone back to those records passes them. What the plan
  // actually asks — that adding a race to the dataset needs no change here — is only visible on a
  // dataset that holds one, so the loaded answer is given a row this build was never compiled
  // with and the same question is asked again.
  const withNewcomers = {
    races: [...data.races, { id: 22, name: "Ворген", playable: true, classes: [1, 14] }],
    classes: [...data.classes, { id: 14, name: "Монах", playable: true }],
  };
  assert.ok(creationRaces(withNewcomers).some((race) => race.id === 22),
    "a playable race the dataset holds and this build does not is not on the form");
  assert.ok(creationClasses(withNewcomers, 22).some((entry) => entry.id === 14),
    "nor is its class, which is what the compiled ten can never grow to include");
  assert.deepEqual(creationClasses(withNewcomers, 22).map((entry) => entry.id), [1, 14],
    "and `CharBaseInfo` still decides what that race may be");

  // And the other direction, for the compiled fallback the form falls back on when the gateway is
  // unreachable: it must not name a race or a class this dataset says cannot be created, or that
  // form offers a character the server will refuse.
  const raceById = new Map(data.races.map((race) => [race.id, race]));
  for (const id of Object.keys(RACE_NAMES).map(Number)) {
    assert.equal(raceById.get(id)?.playable, true, `the offline fallback names race ${id}`);
  }
  const classById = new Map(data.classes.map((entry) => [entry.id, entry]));
  for (const id of Object.keys(CLASS_NAMES).map(Number)) {
    assert.equal(classById.get(id)?.playable, true, `the offline fallback names class ${id}`);
  }
});
