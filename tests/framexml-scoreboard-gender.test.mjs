// Plan item 3.14 (L3): GetBattlefieldScore's race and class in the row's own sex, as Wow.exe 3.3.5a
// answers them. 0x54be90 takes the name-cache entry of the row and asks 0x72aa70/0x72aab0 with no
// unit, which read the entry's race (+0x140), sex (+0x144) and class (+0x148) and pick the name with
// 0x715970 (ChrRaces) / 0x7159e0 (ChrClasses): the sex's own column, else the other's, else Name_lang
// (the gateway applies that fallback, CharacterCreation.ts `genderedNames`).
import assert from "node:assert/strict";
import test, { after } from "node:test";

const { FrameXmlBattlefieldScoreModel, FRAMEXML_SCOREBOARD_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlScoreboard.js");
const { STATUS_IN_PROGRESS } = await import("../dist/code/world/PvpProtocol.js");
const { learnCreationNames, forgetCreationNames, raceName, className } = await import("../dist/code/browser/ui/UnitSnapshot.js");

after(() => forgetCreationNames());

class Events {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, payload = {}) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

function board(entries) {
  const names = new Map(entries.map(([guid, name, race, classId, gender]) => [guid, { name, details: { race, gender, classId } }]));
  const world = {
    events: new Events(),
    pvpScores: undefined,
    battlefieldQueues: new Map([[0, { status: STATUS_IN_PROGRESS, isArena: false, mapId: 489 }]]),
    names: { get: (guid) => names.get(guid)?.name, details: (guid) => names.get(guid)?.details },
    requestName() {},
    requestPvpScores() {},
  };
  const model = new FrameXmlBattlefieldScoreModel({ world: () => world, now: () => 0, worldStateUi: () => [] });
  model.attach({ fire() { return 1; } });
  world.pvpScores = {
    arena: false, teams: [], ended: false, winner: 2,
    scores: entries.map(([guid], index) => ({
      guid, killingBlows: 10 - index, honorableKills: 0, deaths: 0, bonusHonor: 0, teamId: 2,
      damageDone: 0, healingDone: 0, objectives: [],
    })),
  };
  world.events.emit("PVP_SCOREBOARD_CHANGED", { ended: false });
  return (index) => [...FRAMEXML_SCOREBOARD_BINDINGS.GetBattlefieldScore({ scoreboard: model }, [index])];
}

const RACES = [
  { id: 4, name: "Ночной эльф", nameMale: "Ночной эльф", nameFemale: "Ночная эльфийка", clientFileString: "NightElf" },
  { id: 2, name: "Орк", nameMale: "Орк", nameFemale: "Орчиха", clientFileString: "Orc" },
];
const CLASSES = [
  { id: 5, name: "Жрец", nameMale: "Жрец", nameFemale: "Жрица", fileName: "PRIEST" },
  { id: 1, name: "Воин", nameMale: "Воин", nameFemale: "Воин", fileName: "WARRIOR" },
];

test("race and class follow the row's sex from the name answer", () => {
  learnCreationNames(RACES, CLASSES);
  const score = board([[1n, "Тиранда", 4, 5, 1], [2n, "Малфурион", 4, 5, 0], [3n, "Гарона", 2, 1, 1]]);
  assert.deepEqual(score(1).slice(7, 10), ["Ночная эльфийка", "Жрица", "PRIEST"]);
  assert.deepEqual(score(2).slice(7, 10), ["Ночной эльф", "Жрец", "PRIEST"]);
  assert.deepEqual(score(3).slice(7, 10), ["Орчиха", "Воин", "WARRIOR"], "a column the same for both sexes stays");
  forgetCreationNames();
});

test("without the gateway's sexed columns the base names answer, as before", () => {
  learnCreationNames(RACES.map(({ nameMale, nameFemale, ...race }) => race), CLASSES.map(({ nameMale, nameFemale, ...entry }) => entry));
  const score = board([[1n, "Тиранда", 4, 5, 1]]);
  assert.deepEqual(score(1).slice(7, 10), ["Ночной эльф", "Жрец", "PRIEST"]);
  forgetCreationNames();
  assert.equal(raceName(4, true), "Ночной эльф", "the compiled table has no female forms");
  assert.equal(className(5, true), "Жрец");
});

test("raceName: the sex's learned column, the base name without a sex, nothing after forgetting", () => {
  learnCreationNames(RACES, CLASSES);
  assert.equal(raceName(4, true), "Ночная эльфийка");
  assert.equal(raceName(4, false), "Ночной эльф");
  assert.equal(raceName(4), "Ночной эльф");
  assert.equal(raceName(undefined, true), "");
  forgetCreationNames();
  assert.equal(raceName(2, true), "Орк", "forgotten with the rest of the gateway's names");
});
