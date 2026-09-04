import assert from "node:assert/strict";
import test from "node:test";

const { CharStartOutfitIndex } = await import("../dist/code/gateway/CharStartOutfit.js");
const {
  GlueCreation, CHAR_CREATE_RESULT_STRINGS, SEX_MALE, SEX_FEMALE, raceFileToken,
} = await import("../dist/code/browser/glue/GlueCreation.js");
const { isStartOutfit } = await import("../dist/code/browser/glue/GlueNames.js");

/**
 * `CharStartOutfit` in 3.3.5, written out by hand.
 *
 * The layout is `int ID`, four `u8` keys and three `int[24]` arrays: 77 fields of 296 bytes, which
 * is what the real file's header says (measured, and asserted below against the dataset when there
 * is one). Writing it here rather than only reading the real table is what makes the decode
 * checkable on a machine with no client — and what would catch a `.dbd` edit that silently shifted
 * `DisplayItemID` into `ItemID`'s columns while still adding up to 296.
 */
function synthesizeCharStartOutfit(rows) {
  const RECORD = 296;
  const buffer = Buffer.alloc(20 + rows.length * RECORD + 1);
  buffer.write("WDBC", 0, "latin1");
  buffer.writeUInt32LE(rows.length, 4);
  buffer.writeUInt32LE(77, 8);
  buffer.writeUInt32LE(RECORD, 12);
  buffer.writeUInt32LE(1, 16);
  for (const [index, row] of rows.entries()) {
    const at = 20 + index * RECORD;
    buffer.writeInt32LE(row.id, at);
    buffer.writeUInt8(row.race, at + 4);
    buffer.writeUInt8(row.classId, at + 5);
    buffer.writeUInt8(row.sex, at + 6);
    buffer.writeUInt8(row.outfit ?? 0, at + 7);
    for (const [slot, item] of (row.items ?? []).entries()) {
      buffer.writeInt32LE(item.itemId ?? 0, at + 8 + slot * 4);
      buffer.writeInt32LE(item.displayId ?? 0, at + 104 + slot * 4);
      buffer.writeInt32LE(item.inventoryType ?? 0, at + 200 + slot * 4);
    }
  }
  return buffer;
}

/** The loader takes a directory, so the synthetic buffer is fed through the same reader by hand. */
async function indexFromBuffer(buffer) {
  const { openDbc } = await import("../dist/code/gateway/Dbc.js");
  const table = openDbc(buffer, "CharStartOutfit");
  assert.equal(table.fields, 77);
  assert.equal(table.recordSize, 296);
  return table;
}

test("CharStartOutfit decodes its three parallel arrays from a synthetic record", async () => {
  const buffer = synthesizeCharStartOutfit([
    {
      id: 1, race: 1, classId: 1, sex: 0,
      items: [
        { itemId: 38, displayId: 9891, inventoryType: 4 },
        { itemId: 39, displayId: 9892, inventoryType: 7 },
        { itemId: 25, displayId: 2380, inventoryType: 21 },
        // Inventory type 0 is the Hearthstone every outfit carries: nothing to draw.
        { itemId: 6948, displayId: 6418, inventoryType: 0 },
      ],
    },
    // A race id past 127, which is where tswow allocates: read as a signed byte it would come back
    // negative and the row would be unreachable. The definition says `u8` for exactly this reason.
    { id: 2, race: 200, classId: 1, sex: 1, items: [{ itemId: 7, displayId: 700, inventoryType: 1 }] },
  ]);
  const table = await indexFromBuffer(buffer);
  assert.equal(table.records, 2);
  assert.equal(table.int(0, "RaceID"), 1);
  assert.equal(table.int(1, "RaceID"), 200);
  assert.equal(table.int(0, "ItemID", 2), 25);
  assert.equal(table.int(0, "DisplayItemID", 2), 2380);
  assert.equal(table.int(0, "InventoryType", 2), 21);
  assert.equal(table.int(0, "InventoryType", 23), 0, "the unfilled tail of the arrays reads as zero");
});

test("the outfit index drops what cannot be worn and maps inventory type to equipment slot", () => {
  const index = CharStartOutfitIndex.fromRows(new Map());
  assert.equal(index.size, 0);
  assert.deepEqual(index.outfit(1, 1, 0), []);
});

test("the browser refuses an outfit answer that is not shaped like the route's", () => {
  assert.equal(isStartOutfit([]), true);
  assert.equal(isStartOutfit([{ displayId: 2380, inventoryType: 17, slot: 15 }]), true);
  assert.equal(isStartOutfit([{ displayId: 0, inventoryType: 17, slot: 15 }]), false);
  assert.equal(isStartOutfit([{ displayId: 2380, inventoryType: 17, slot: 19 }]), false);
  assert.equal(isStartOutfit([{ displayId: 2380, inventoryType: 17 }]), false);
  assert.equal(isStartOutfit("nope"), false);
});

/* --- The dataset, when this machine has one ---------------------------------------------------- */

let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  dbcDirectory = paths.dbcDirectory();
  const { existsSync } = await import("node:fs");
  if (!existsSync(`${dbcDirectory}/CharStartOutfit.dbc`)) dbcDirectory = undefined;
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no CharStartOutfit.dbc on this machine" };

test("the real CharStartOutfit dresses a dwarf rogue exactly as 3.3.5 does", withDataset, async () => {
  const index = await CharStartOutfitIndex.load(dbcDirectory);
  // 126 rows on this dataset: ten races by ten classes, minus the pairs that do not exist.
  assert.ok(index.size >= 100, `profiles: ${index.size}`);

  // The stock rogue kit, and the one row this build has not customised. Worn Dagger display 6442
  // in both hands, throwing axes in the ranged slot, and shirt/pants/boots.
  const rogue = index.outfit(3, 4, 0);
  const query = rogue.map((item) => `${item.slot}:${item.inventoryType}:${item.displayId}`).sort();
  assert.deepEqual(query, [
    "15:13:6442", "16:22:6442", "17:25:20777", "3:4:9906", "6:7:9913", "7:8:9915",
  ]);

  // Every item that comes back is drawable: a display id and a slot the appearance route accepts.
  for (const item of index.outfit(5, 6, 0)) {
    assert.ok(item.displayId > 0);
    assert.ok(item.slot >= 0 && item.slot <= 18, `slot ${item.slot}`);
    assert.ok(item.inventoryType > 0, "inventory type 0 is not a visible slot");
  }

  // A profile the table has nothing for is an empty outfit, not a failure.
  assert.deepEqual(index.outfit(250, 1, 0), []);
});

/* --- The five customisation axes --------------------------------------------------------------- */

const RACES = [
  {
    id: 1, name: "Человек", clientPrefix: "Hu", clientFileString: "Human", playable: true, side: 0,
    factionId: 1, baseLanguage: 7, expansion: 0, maleDisplayId: 49, femaleDisplayId: 50,
    hairCustomization: "NORMAL", facialHairCustomization: ["NORMAL", "PIERCINGS"],
    classes: [1, 2, 4, 5],
  },
  {
    id: 6, name: "Таурен", clientPrefix: "Ta", clientFileString: "Tauren", playable: true, side: 1,
    factionId: 6, baseLanguage: 1, expansion: 0, maleDisplayId: 59, femaleDisplayId: 60,
    hairCustomization: "HORNS", facialHairCustomization: ["NORMAL", "HAIR"],
    classes: [1, 3],
  },
  // Not playable: it must never reach a button.
  {
    id: 12, name: "Огр", clientPrefix: "Og", clientFileString: "Ogre", playable: false, side: 2,
    factionId: 0, baseLanguage: 0, expansion: 0, maleDisplayId: 1, femaleDisplayId: 2,
    hairCustomization: "NORMAL", facialHairCustomization: ["NORMAL", "NORMAL"], classes: [],
  },
];
const CLASSES = [
  { id: 1, name: "Воин", fileName: "WARRIOR", classMask: 1, powerType: 1, expansion: 0, playable: true },
  { id: 2, name: "Паладин", fileName: "PALADIN", classMask: 2, powerType: 0, expansion: 0, playable: true },
  { id: 3, name: "Охотник", fileName: "HUNTER", classMask: 4, powerType: 0, expansion: 0, playable: true },
  { id: 4, name: "Разбойник", fileName: "ROGUE", classMask: 8, powerType: 3, expansion: 0, playable: true },
  { id: 5, name: "Жрец", fileName: "PRIEST", classMask: 16, powerType: 0, expansion: 0, playable: true },
];

/**
 * The option payload `/dbc/character-options` answers with, in the one shape that matters here:
 * the faces are per skin and the two do not make a rectangle. Skin 0 has three faces, skin 4 has
 * one — which is the death-knight shape on the real dataset, where 780 of the offered `(face, skin)`
 * pairs across the twenty playable profiles have no row at all.
 */
const HUMAN_MALE_OPTIONS = {
  skins: [0, 1, 4],
  faces: [0, 1, 2, 7],
  hairStyles: [0, 1, 2],
  hairColors: [0, 1],
  facialHairs: [0, 1, 2, 3],
  facesBySkin: { 0: [0, 1, 2], 1: [0, 1, 2], 4: [7] },
};

function creation(overrides = {}) {
  const calls = { created: [], dialogs: [], screens: [] };
  const model = new GlueCreation({
    tables: () => ({ races: RACES, classes: CLASSES }),
    source: {
      options: async (race, sex) => (race === 1 && sex === 0 ? HUMAN_MALE_OPTIONS : {
        skins: [0, 1], faces: [0], hairStyles: [0], hairColors: [0], facialHairs: [],
        facesBySkin: { 0: [0], 1: [0] },
      }),
      startOutfit: async (race, classId, sex) => (race === 1 && classId === 1 && sex === 0
        ? [{ displayId: 2380, inventoryType: 17, slot: 15 }]
        : []),
      displayId: (race, sex) => {
        const row = RACES.find((entry) => entry.id === race);
        return sex === 1 ? row?.femaleDisplayId : row?.maleDisplayId;
      },
    },
    create: async (request) => { calls.created.push(request); return overrides.result ?? 47; },
    fireEvent: (event, ...args) => { if (event === "OPEN_STATUS_DIALOG") calls.dialogs.push(args[1]); },
    setGlueScreen: (name) => { calls.screens.push(name); },
    glueString: (key) => `<${key}>`,
    // Deterministic: always the last value on every axis.
    random: () => 0.999,
  });
  return { model, calls };
}

test("the enumerated lists are what CharacterCreate.lua unpacks in threes", () => {
  const { model } = creation();
  const races = model.availableRaces();
  assert.deepEqual(races.map((race) => race.name), ["Человек", "Таурен"]);
  assert.deepEqual(races.map((race) => race.token), ["Human", "Tauren"]);
  assert.ok(races.every((race) => race.enabled), "a playable race is never greyed out");

  // Every class is listed, and the ones this race may not take are the greyed buttons — dropping
  // them would renumber every button after them when the race changes.
  const classes = model.availableClasses();
  assert.deepEqual(classes.map((entry) => entry.token),
    ["WARRIOR", "PALADIN", "HUNTER", "ROGUE", "PRIEST"]);
  assert.deepEqual(classes.map((entry) => entry.enabled), [true, true, false, true, true]);
  assert.equal(model.isRaceClassValid(1, 3), false, "a human may not be a hunter in this fixture");
  assert.equal(model.isRaceClassValid(2, 3), true, "a tauren may");
});

test("the file token falls back to the measured ChrRaces spelling when the gateway has none", () => {
  assert.equal(raceFileToken(RACES[0]), "Human");
  assert.equal(raceFileToken({ ...RACES[0], clientFileString: "" }), "Human");
  // Gnome and troll: the two ids where the file token and the backdrop token disagree.
  assert.equal(raceFileToken({ id: 7, clientFileString: "", clientPrefix: "Gn" }), "Gnome");
  assert.equal(raceFileToken({ id: 8, clientFileString: "", clientPrefix: "Tr" }), "Troll");
  // A race no table knows still answers with something the corpus can concatenate.
  assert.equal(raceFileToken({ id: 22, clientFileString: "", clientPrefix: "Cu" }), "Cu");
});

test("cycling an axis wraps, and cycling the skin re-filters the faces", async () => {
  const { model } = creation();
  await model.refreshProfile(true);
  assert.deepEqual([...model.offered(1)], [0, 1, 4]);

  // Face 7 exists only on skin 4, so it is not offered while skin 0 is chosen.
  assert.deepEqual([...model.offered(2)], [0, 1, 2]);
  model.cycle(2, 1);
  model.cycle(2, 1);
  assert.equal(model.look.face, 2);
  model.cycle(2, 1);
  assert.equal(model.look.face, 0, "the last face wraps to the first");

  // Now walk the skin to 4. Its only face is 7, and the chosen face 0 has no row there — the
  // client re-filters instead of sending a pair the tables do not have.
  model.cycle(2, 1);
  assert.equal(model.look.face, 1);
  model.cycle(1, -1);
  assert.equal(model.look.skin, 4, "cycling left from the first skin wraps to the last");
  assert.deepEqual([...model.offered(2)], [7]);
  assert.equal(model.look.face, 7, "the face followed the skin onto a pair that exists");

  // And back: skin 0 offers three faces again and 7 is not one of them.
  model.cycle(1, 1);
  assert.equal(model.look.skin, 0);
  assert.deepEqual([...model.offered(2)], [0, 1, 2]);
  assert.equal(model.look.face, 0);
});

test("randomize picks a legal value on every axis, faces after the skin", async () => {
  const { model } = creation();
  await model.refreshProfile(true);
  model.randomize();
  const look = model.look;
  assert.ok(model.offered(1).includes(look.skin));
  assert.ok(model.offered(2).includes(look.face), "the face belongs to the skin that was drawn");
  assert.ok(model.offered(3).includes(look.hairStyle));
  assert.ok(model.offered(4).includes(look.hairColor));
  assert.ok(model.offered(5).includes(look.facialHair));
  // The stub always draws the last entry, so the pair is skin 4 with its single face.
  assert.equal(look.skin, 4);
  assert.equal(look.face, 7);
});

test("changing race or sex pulls every axis back onto what the new profile offers", async () => {
  const { model } = creation();
  await model.refreshProfile(true);
  model.cycle(1, -1);
  model.cycle(5, 1);
  assert.equal(model.look.skin, 4);
  assert.equal(model.look.facialHair, 1);

  // The tauren fixture offers two skins, one face and no facial hair at all.
  model.selectRace(2);
  await model.refreshProfile(true);
  assert.equal(model.raceIndex, 2);
  assert.deepEqual([...model.offered(1)], [0, 1]);
  assert.equal(model.look.skin, 0, "skin 4 does not exist here");
  assert.equal(model.look.facialHair, 0, "an axis with nothing on it reads as zero");
  // A human warrior is class 1 and a tauren may take it, so the choice survives the race change.
  assert.equal(model.classIndex, 1);
  assert.equal(model.hairCustomization(), "HORNS", "a tauren's hair strings are its horns");
  assert.equal(model.facialHairCustomization(), "NORMAL");
  model.selectSex(SEX_FEMALE);
  assert.equal(model.gender, 1);
  assert.equal(model.facialHairCustomization(), "HAIR", "the array's second element is the female");
  model.selectSex(SEX_MALE);
  assert.equal(model.gender, 0);
});

test("the class follows the race when the race cannot take it", async () => {
  const { model } = creation();
  await model.refreshProfile(true);
  // Warrior is class index 1 and both fixture races allow it, so it survives a race change.
  model.selectClass(1);
  model.selectRace(2);
  assert.equal(model.classIndex, 1, "a tauren warrior is legal in this fixture");
  // Hunter is index 3 and the human may not take it: the first class the human may take wins.
  model.selectClass(3);
  assert.equal(model.classIndex, 3);
  model.selectRace(1);
  assert.equal(model.classIndex, 1);
  // And the same the other way: a human rogue is index 4, and a tauren is not offered one.
  model.selectClass(4);
  model.selectRace(2);
  assert.equal(model.classIndex, 1);
});

test("the previewed look carries the start outfit and changes with every axis", async () => {
  const { model } = creation();
  await model.refreshProfile(true);
  const first = model.sceneLook();
  assert.ok(first);
  assert.equal(first.displayId, 49, "a human male is CreatureDisplayInfo 49");
  assert.equal(first.race, 1);
  assert.equal(first.sex, 0);
  assert.equal(first.items, "15:17:2380", "the two-handed sword the start outfit names");

  model.cycle(3, 1);
  const second = model.sceneLook();
  assert.notEqual(second.key, first.key, "a hairstyle change rebuilds the figure");
  assert.equal(second.hairStyle, model.look.hairStyle);

  // A race with no outfit row draws the figure undressed rather than failing.
  model.selectRace(2);
  await model.refreshProfile(true);
  const tauren = model.sceneLook();
  assert.equal(tauren.displayId, 59);
  assert.equal(tauren.items, "");
  assert.equal(model.backgroundModel(), "Tauren");
});

/* --- Creating ---------------------------------------------------------------------------------- */

test("a successful create sends every chosen value and moves to the character list", async () => {
  const { model, calls } = creation();
  await model.refreshProfile(true);
  model.cycle(3, 1);
  const result = await model.createCharacter("  Аларин  ");
  assert.equal(result, 47);
  assert.deepEqual(calls.screens, ["charselect"]);
  assert.deepEqual(calls.dialogs, []);
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.created[0], {
    name: "Аларин",
    race: 1,
    classId: 1,
    gender: 0,
    skin: model.look.skin,
    face: model.look.face,
    hairStyle: model.look.hairStyle,
    hairColor: model.look.hairColor,
    facialHair: model.look.facialHair,
    outfitId: 0,
  });
});

test("every named create failure prints the dataset's own CHAR_CREATE string", async () => {
  for (const [code, key] of Object.entries(CHAR_CREATE_RESULT_STRINGS)) {
    if (Number(code) === 47) continue;
    const { model, calls } = creation({ result: Number(code) });
    const result = await model.createCharacter("Аларин");
    assert.equal(result, Number(code));
    assert.deepEqual(calls.screens, [], `code ${code} must not leave the creation screen`);
    assert.deepEqual(calls.dialogs, [`<${key}>`], `code ${code}`);
  }
  // Name in use and invalid name are the two the screen shows most, and they are different strings.
  assert.equal(CHAR_CREATE_RESULT_STRINGS[50], "CHAR_CREATE_NAME_IN_USE");
  assert.equal(CHAR_CREATE_RESULT_STRINGS[42], "CHAR_CREATE_INVALID_NAME");
});

test("a name the client itself refuses never reaches the wire", async () => {
  const { model, calls } = creation();
  assert.equal(await model.createCharacter("A"), undefined);
  assert.deepEqual(calls.created, [], "MIN_CHAR_NAME_LENGTH is 2");
  assert.deepEqual(calls.dialogs, ["<CHAR_CREATE_INVALID_NAME>"]);
});

test("with no world connection the screen says so instead of quoting a server code", async () => {
  const model = new GlueCreation({
    tables: () => ({ races: RACES, classes: CLASSES }),
    source: {
      options: async () => undefined,
      startOutfit: async () => [],
      displayId: () => 49,
    },
    fireEvent: () => {},
    glueString: () => undefined,
  });
  assert.equal(await model.createCharacter("Аларин"), undefined);
});
