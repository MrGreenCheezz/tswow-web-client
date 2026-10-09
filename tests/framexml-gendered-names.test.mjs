// L3-review (plan items 3.14/3.12): race and class names in the character's own sex, as Wow.exe 3.3.5a
// answers them. Every API below ends in 0x715970 (ChrRaces) / 0x7159e0 (ChrClasses): sex 0 takes
// Name_male_lang, 1 Name_female_lang (each falling back to the other), any other value Name_lang
// (the gateway applies the column fallback, CharacterCreation.ts `genderedNames`). Where the sex comes from:
// * UnitRace 0x60fd40 / UnitClass 0x60fec0: a unit in view → 0x72aa70/0x72aab0 → 0x71a4b0/0x71a590
//   read UNIT_FIELD_BYTES_0 byte 2; only the localized name changes, the token (ClientFileString,
//   Filename) does not. GameTooltip:SetUnit's level line (0x621070) asks the same two functions.
// * GetRaidRosterInfo 0x573690, GetFriendInfo 0x6b4130: the name-cache entry's sex (+0x144);
//   GetFriendInfo without an entry answers ChrClasses.Name_lang.
// * GetWhoInfo 0x6b4a80 (and its sort, 0x6b5016) and GetGuildRosterInfo 0x5cc9c0: the packet row's sex.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { learnCreationNames, forgetCreationNames, femaleOf } = await import("../dist/code/browser/ui/UnitSnapshot.js");
const tooltip = await import("../dist/code/browser/ui/UnitTooltip.js");

after(() => forgetCreationNames());

/** The dataset's rows (ChrRaces/ChrClasses ruRU) as `/dbc/character-creation` serves them, plus one
 * made-up class whose three columns all differ, so the "neither sex" branch is visible. */
const RACES = [
  { id: 1, name: "Человек", nameMale: "Человек", nameFemale: "Человек", clientFileString: "Human" },
  { id: 4, name: "Ночной эльф", nameMale: "Ночной эльф", nameFemale: "Ночная эльфийка", clientFileString: "NightElf" },
  { id: 10, name: "Эльф крови", nameMale: "Эльф крови", nameFemale: "Эльфийка крови", clientFileString: "BloodElf" },
];
const CLASSES = [
  { id: 1, name: "Воин", nameMale: "Воин", nameFemale: "Воин", fileName: "WARRIOR" },
  { id: 5, name: "Жрец", nameMale: "Жрец", nameFemale: "Жрица", fileName: "PRIEST" },
  { id: 9, name: "Чернокнижник", nameMale: "Чернокнижник", nameFemale: "Чернокнижница", fileName: "WARLOCK" },
  { id: 30, name: "Тест", nameMale: "Тест-м", nameFemale: "Тест-ж", fileName: "TESTCLASS" },
];

const SELF = 0x10n;
const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
const bytes0 = (race, classId, gender) => race | (classId << 8) | (gender << 16);

function events() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, payload) { for (const listener of [...(listeners.get(name) ?? [])]) listener(payload); },
  };
}

function playerObject(guid, race, classId, gender, extra = []) {
  return {
    guid, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, bytes0(race, classId, gender)],
      [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80], [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
      [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100], ...extra]),
  };
}

/** A live seam over a recording world; `names` is a name cache with the answers' race/sex/class. */
function liveSeam({ self = playerObject(SELF, 4, 5, 1), objects = [], names = [], extra = {} } = {}) {
  const cache = new Map([[SELF, "Тиранда"], ...names.map(([guid, name]) => [guid, name])]);
  const details = new Map(names.filter(([, , detail]) => detail).map(([guid, , detail]) => [guid, detail]));
  const nameCache = Object.assign(new Map(cache), { details: (guid) => details.get(guid) });
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, self], ...objects.map((object) => [object.guid, object])]) },
    targetGuid: undefined, chatLog: [], channels: new Map(), events: events(), casts: new Map(),
    actionButtons: [], knownSpells: [], aurasFor: () => [], cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }),
    names: nameCache, creatureTemplates: new Map(), partyStats: new Map(), group: undefined,
    worldStateContext: undefined, mapId: undefined, selfName: "Тиранда",
    displayName: (guid) => cache.get(guid) ?? `0x${guid.toString(16)}`,
    selectTarget() {}, requestContacts() {}, requestGuildRoster() {}, requestGuildEventLog() {},
    setGuildMemberNote() {}, setGuildInfoText() {}, setGuildRank() {}, addGuildRank() {}, removeLowestGuildRank() {},
    ...extra,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    spells: () => [][Symbol.iterator](), monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.friends.attach({ fire: () => 1, now: () => 0 });
  return { seam, world };
}

test("femaleOf: 0 male, 1 female, anything else neither (0x715970's three branches)", () => {
  assert.equal(femaleOf(0), false);
  assert.equal(femaleOf(1), true);
  assert.equal(femaleOf(2), undefined);
  assert.equal(femaleOf(undefined), undefined);
});

test("UnitRace and UnitClass name a unit in its sex (UNIT_FIELD_BYTES_0 byte 2); the tokens stay", () => {
  learnCreationNames(RACES, CLASSES);
  try {
    const her = liveSeam({ self: playerObject(SELF, 4, 5, 1) }).seam;
    assert.deepEqual(call(her, "UnitRace", "player"), ["Ночная эльфийка", "NightElf"]);
    assert.deepEqual(call(her, "UnitClass", "player"), ["Жрица", "PRIEST"]);
    const him = liveSeam({ self: playerObject(SELF, 10, 9, 0) }).seam;
    assert.deepEqual(call(him, "UnitRace", "player"), ["Эльф крови", "BloodElf"]);
    assert.deepEqual(call(him, "UnitClass", "player"), ["Чернокнижник", "WARLOCK"]);
    const neither = liveSeam({ self: playerObject(SELF, 1, 30, 2) }).seam;
    assert.deepEqual(call(neither, "UnitClass", "player"), ["Тест", "TESTCLASS"], "a sex byte of 2 takes Name_lang");
    const male = liveSeam({ self: playerObject(SELF, 1, 30, 0) }).seam;
    assert.deepEqual(call(male, "UnitClass", "player"), ["Тест-м", "TESTCLASS"]);
  } finally {
    forgetCreationNames();
  }
});

test("GetFriendInfo: the name cache's sex; without an entry, Name_lang", () => {
  learnCreationNames(RACES, CLASSES);
  try {
    const contacts = {
      flags: 7,
      contacts: [
        { guid: 0x21n, flags: 1, note: "", status: 1, areaId: 0, level: 80, classId: 5 },
        { guid: 0x22n, flags: 1, note: "", status: 1, areaId: 0, level: 80, classId: 30 },
        { guid: 0x23n, flags: 1, note: "", status: 1, areaId: 0, level: 80, classId: 30 },
      ],
    };
    const { seam } = liveSeam({
      names: [[0x21n, "Аня", { race: 4, gender: 1, classId: 5 }], [0x22n, "Боря", { race: 1, gender: 0, classId: 30 }],
        [0x23n, "Вика"]],
      extra: { contacts },
    });
    const classOf = (name) => call(seam, "WebClientFriendInfo", name)[2]; // GetFriendInfo's flat half
    assert.equal(classOf("Аня"), "Жрица");
    assert.equal(classOf("Боря"), "Тест-м");
    assert.equal(classOf("Вика"), "Тест", "no name-cache entry: ChrClasses.Name_lang (0x6b4130)");
  } finally {
    forgetCreationNames();
  }
});

test("GetWhoInfo and SortWho: the row's own sex byte", () => {
  learnCreationNames(RACES, CLASSES);
  try {
    const entry = (name, race, classId, gender) => ({ name, guild: "", level: 80, classId, race, gender, zoneId: 0 });
    const whoResult = { displayed: 2, matched: 2, entries: [entry("Аня", 4, 5, 1), entry("Борис", 4, 5, 0)] };
    const { seam } = liveSeam({ extra: { whoResult } });
    assert.deepEqual(call(seam, "GetWhoInfo", 1).slice(0, 5), ["Аня", "", 80, "Ночная эльфийка", "Жрица"]);
    assert.deepEqual(call(seam, "GetWhoInfo", 2).slice(3, 5), ["Ночной эльф", "Жрец"]);
    call(seam, "SortWho", "class");
    assert.deepEqual([call(seam, "GetWhoInfo", 1)[0], call(seam, "GetWhoInfo", 2)[0]], ["Борис", "Аня"],
      "«Жрец» before «Жрица» (0x6b5016 sorts by the sexed names; equal names would fall back to the name)");
  } finally {
    forgetCreationNames();
  }
});

test("GetGuildRosterInfo: the roster row's sex byte", () => {
  learnCreationNames(RACES, CLASSES);
  try {
    const member = (guid, name, classId, gender) => ({
      guid, name, rankId: 0, level: 80, classId, gender, areaId: 0, online: true, status: 0,
      note: "", officerNote: "", lastSaveDays: 0,
    });
    const guildRoster = {
      welcomeText: "", infoText: "", ranks: [{ flags: 0xffffffff, withdrawGoldLimit: 0, tabs: [] }],
      members: [member(SELF, "Тиранда", 9, 1), member(0x21n, "Борис", 9, 0)],
    };
    const self = playerObject(SELF, 4, 9, 1, [[UPDATE_FIELDS.PLAYER_GUILDID.offset, 9], [UPDATE_FIELDS.PLAYER_GUILDRANK.offset, 0]]);
    const { seam } = liveSeam({
      self, extra: { guildRoster, guildQuery: { guildId: 9, name: "Щит", rankNames: ["ГМ"], rankCount: 1 } },
    });
    seam.friends.tick();
    const rows = [1, 2].map((index) => call(seam, "WebClientGuildRosterInfo", index)); // GetGuildRosterInfo's flat half
    const byName = new Map(rows.map((row) => [row[0], row]));
    assert.equal(byName.get("Тиранда")?.[4], "Чернокнижница");
    assert.equal(byName.get("Борис")?.[4], "Чернокнижник");
    assert.equal(byName.get("Тиранда")?.[10], "WARLOCK");
  } finally {
    forgetCreationNames();
  }
});

test("GetRaidRosterInfo: the name cache's sex, else the member's own object", () => {
  learnCreationNames(RACES, CLASSES);
  try {
    const group = {
      groupType: 0x02, leaderGuid: SELF, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 1n, counter: 1,
      lootMethod: 0, masterLooterGuid: 0n, lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0,
      members: [
        { guid: 0x21n, name: "Аня", online: true, status: 1, subGroup: 0, flags: 0, roles: 0 },
        { guid: 0x22n, name: "Вика", online: true, status: 1, subGroup: 0, flags: 0, roles: 0 },
      ],
    };
    const { seam } = liveSeam({
      // Аня's object says male, her name answer says female: the cache is what 0x573690 reads.
      objects: [playerObject(0x21n, 4, 5, 0), playerObject(0x22n, 4, 5, 1)],
      names: [[0x21n, "Аня", { race: 4, gender: 1, classId: 5 }], [0x22n, "Вика"]],
      extra: { group },
    });
    assert.deepEqual(call(seam, "GetRaidRosterInfo", 1).slice(4, 6), ["Жрица", "PRIEST"]);
    assert.deepEqual(call(seam, "GetRaidRosterInfo", 2).slice(4, 6), ["Жрица", "PRIEST"],
      "no name answer yet: the visible object's sex byte");
    assert.deepEqual(call(seam, "GetRaidRosterInfo", 3).slice(4, 6), ["Жрица", "PRIEST"], "the player");
  } finally {
    forgetCreationNames();
  }
});

test("the unit tooltip's level line names a player in its sex (0x621070 → 0x72aa70/0x72aab0)", () => {
  learnCreationNames(RACES, CLASSES);
  try {
    const self = playerObject(SELF, 1, 1, 0);
    const her = playerObject(0x21n, 10, 9, 1);
    const world = {
      state: { selfGuid: SELF, objects: new Map([[SELF, self], [her.guid, her]]) },
      names: new Map([[her.guid, "Аня"]]), selfName: "Боря", creatureTemplate: () => undefined,
    };
    const sources = { reaction: () => 1, canAttack: () => false, spellRow: () => undefined };
    const facts = tooltip.unitTooltipFacts(world, her, sources);
    assert.equal(facts?.raceName, "Эльфийка крови");
    assert.equal(facts?.className, "Чернокнижница");
    assert.equal(tooltip.unitTooltipFacts(world, self, sources)?.className, "Воин");
  } finally {
    forgetCreationNames();
  }
});
