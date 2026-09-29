import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  FRAMEXML_CREATION_NAMES_PATH, ensureFrameXmlCreationNames, loadFrameXmlCharacterStats,
} = await import("../dist/code/browser/framexml/FrameXmlCharacterStats.js");
const { forgetCreationNames, learnCreationNames } = await import("../dist/code/browser/ui/UnitSnapshot.js");
const {
  HOVER_SETTLE_MS, hoveredUnitGuid, onSettledHoverChanged, setHoveredTarget, settledHoveredUnitGuid,
} = await import("../dist/code/browser/game/HoverTarget.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

/** What `/dbc/character-creation?v=3` answers on this dataset for the rows these tests use. */
const CREATION = Object.freeze({
  races: [
    { id: 1, name: "Человек", clientFileString: "Human", baseLanguage: 7 },
    { id: 2, name: "Орк", clientFileString: "Orc", baseLanguage: 1 },
    { id: 12, name: "Орк Скверны", clientFileString: "FelOrc", baseLanguage: 7 },
  ],
  classes: [
    { id: 2, name: "Паладин", fileName: "PALADIN" },
    { id: 12, name: "Археолог", fileName: "ARCHAEOLOGIST" },
    { id: 13, name: "Герой", fileName: "HERO" },
  ],
});

function unitObject(guid, typeId, { race = 1, classId = 2, level = 80 } = {}) {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, race | (classId << 8)],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, level],
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 200],
  ]);
  return { guid, typeId, fields };
}

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

function liveFixture({ classId = 13, race = 1 } = {}) {
  const selfGuid = 0x10n;
  const player = unitObject(selfGuid, 4, { classId, race });
  const objects = new Map([[selfGuid, player]]);
  const world = {
    state: { selfGuid, objects },
    targetGuid: undefined,
    chatLog: [],
    channels: new Map(),
    events: events(),
    casts: new Map(),
    actionButtons: [],
    knownSpells: [],
    aurasFor: () => [],
    cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }),
    names: new Map([[selfGuid, "Тестовый"]]),
    creatureTemplates: new Map(),
    partyStats: new Map(),
    group: undefined,
    petSpells: undefined,
    worldStateContext: undefined,
    mapId: undefined,
    selfName: "Тестовый",
    displayName: (guid) => `0x${guid.toString(16)}`,
  };
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  return { seam, world, objects, player, fired, pump };
}

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("UnitClass answers the dataset's ChrClasses token for a TSWoW class, never an invented one", () => {
  forgetCreationNames();
  try {
    const { seam } = liveFixture({ classId: 13 });
    assert.deepEqual(call(seam, "UnitClass", "player"), [],
      "before the dataset list is learned a custom class has no token to answer");
    learnCreationNames(CREATION.races, CREATION.classes);
    assert.deepEqual(call(seam, "UnitClass", "player"), ["Герой", "HERO"],
      "class 13 is HERO on this dataset (ids.txt ChrClasses|gem-abilities:hero|13)");
    const archaeologist = liveFixture({ classId: 12 });
    assert.deepEqual(call(archaeologist.seam, "UnitClass", "player"), ["Археолог", "ARCHAEOLOGIST"]);
    const paladin = liveFixture({ classId: 2 });
    assert.deepEqual(call(paladin.seam, "UnitClass", "player"), ["Паладин", "PALADIN"]);
  } finally {
    forgetCreationNames();
  }
});

test("UnitRace answers a custom race's ClientFileString once learned", () => {
  forgetCreationNames();
  try {
    const { seam } = liveFixture({ race: 12 });
    assert.deepEqual(call(seam, "UnitRace", "player"), [], "no compiled token for race 12");
    learnCreationNames(CREATION.races, CREATION.classes);
    assert.deepEqual(call(seam, "UnitRace", "player"), ["Орк Скверны", "FelOrc"]);
  } finally {
    forgetCreationNames();
  }
});

test("the world FrameXML boot learns the class list with the stat catalog, from the glue's URL", async () => {
  // One cache entry with the glue screens: the version must be GlueNames' own.
  const glue = readFileSync(new URL("../src/browser/glue/GlueNames.ts", import.meta.url), "utf8");
  const version = /export const GLUE_CREATION_VERSION = (\d+);/.exec(glue)?.[1];
  assert.equal(FRAMEXML_CREATION_NAMES_PATH, `/dbc/character-creation?v=${version}`);

  forgetCreationNames();
  const requested = [];
  const fetchStub = async (url) => {
    requested.push(new URL(url).pathname + new URL(url).search);
    if (url.includes("character-creation")) return new Response(JSON.stringify(CREATION));
    return new Response("{}", { status: 503 });
  };
  try {
    await assert.rejects(loadFrameXmlCharacterStats("http://gateway.test", fetchStub),
      /Character stat gateway returned 503/, "a stat catalog failure is still reported");
    assert.deepEqual(requested.sort(), ["/dbc/character-creation?v=3", "/dbc/character-stats?version=2"]);
    const { seam } = liveFixture({ classId: 13 });
    assert.deepEqual(call(seam, "UnitClass", "player"), ["Герой", "HERO"],
      "the class list landed even though the catalog beside it failed");
    requested.length = 0;
    assert.equal(await ensureFrameXmlCreationNames("http://gateway.test", fetchStub), true);
    assert.deepEqual(requested, [], "a learned list is not fetched again");
  } finally {
    forgetCreationNames();
  }
  assert.equal(await ensureFrameXmlCreationNames("http://gateway.test", async () => {
    throw new Error("offline");
  }), false, "an unreachable gateway reports false instead of throwing");
});

test("UnitGUID answers every token the seam resolves, in chat arg12's text form", () => {
  const { seam, world, objects } = liveFixture();
  const target = unitObject(0xf130000000000abcn, 3);
  const pet = unitObject(0xf140000000000defn, 3);
  objects.set(target.guid, target);
  objects.set(pet.guid, pet);
  world.targetGuid = target.guid;
  world.petSpells = { guid: pet.guid, bar: [] };
  world.group = {
    groupType: 0, leaderGuid: 0x10n,
    members: [{ guid: 0x21n, name: "Альфа", online: true, status: 1, subGroup: 0, flags: 0, roles: 0 }],
  };
  world.partyStats.set(0x21n, { petGuid: 0xf140000000000777n });

  assert.deepEqual(call(seam, "UnitGUID", "player"), ["0x0000000000000010"]);
  assert.deepEqual(call(seam, "UnitGUID", "target"), ["0xf130000000000abc"]);
  assert.deepEqual(call(seam, "UnitGUID", "pet"), ["0xf140000000000def"]);
  assert.deepEqual(call(seam, "UnitGUID", "party1"), ["0x0000000000000021"],
    "a party member out of range still has its roster GUID");
  assert.deepEqual(call(seam, "UnitGUID", "partypet1"), ["0xf140000000000777"],
    "MSBT keys petMap by the party pet GUID from SMSG_PARTY_MEMBER_STATS");
  assert.deepEqual(call(seam, "UnitGUID", "focus"), [], "no focus is nil, as the client answers");
  assert.deepEqual(call(seam, "UnitGUID", "vehicle"), [], "an ordinary pet bar is not a vehicle");
  assert.deepEqual(call(seam, "UnitGUID", "raid1"), [], "no raid, no raid unit");

  world.petSpells = { guid: 0xf150000000000999n, bar: [{ packed: 1, type: 8 }] };
  assert.deepEqual(call(seam, "UnitGUID", "vehicle"), ["0xf150000000000999"],
    "VehicleSpellInitialize's bar carries the vehicle GUID");
  world.group = { ...world.group, groupType: 0x02 };
  assert.deepEqual(call(seam, "UnitGUID", "raid1"), ["0x0000000000000021"]);
  assert.deepEqual(call(seam, "UnitIsUnit", "raid1", "party1"), [false], "a raid has no party slots");
});

test("UnitLevel answers 0 for a token with no unit, as stock TargetFrame_CheckLevel needs", () => {
  const { seam } = liveFixture();
  assert.deepEqual(call(seam, "UnitLevel", "player"), [80]);
  for (const unit of ["target", "focus", "boss1", "mouseover"]) {
    assert.deepEqual(call(seam, "UnitLevel", unit), [0], `${unit} without a unit is 0, not nil`);
  }
  assert.deepEqual(call(new CannedWorldSeam(), "UnitLevel", "boss4"), [0]);
});

test("a hover clear inside the pick throttle does not settle; a lasting one does", async () => {
  const { world, objects } = liveFixture();
  const creature = unitObject(0xf130000000000055n, 3);
  objects.set(creature.guid, creature);
  const seen = [];
  const off = onSettledHoverChanged((_world, guid) => seen.push(guid));
  try {
    setHoveredTarget(world, creature);
    assert.deepEqual(seen, [creature.guid], "a real pick settles at once");
    // Controls.ts clears the raw hover on every throttled pointermove and re-picks from a tail.
    setHoveredTarget(undefined, undefined);
    assert.equal(hoveredUnitGuid(world), undefined, "mouseover macros see the raw clear");
    assert.equal(settledHoveredUnitGuid(world), creature.guid, "the settled pick does not flicker");
    await new Promise((resolve) => setTimeout(resolve, 5));
    setHoveredTarget(world, creature);
    await new Promise((resolve) => setTimeout(resolve, HOVER_SETTLE_MS + 20));
    assert.deepEqual(seen, [creature.guid], "the transient clear was never published");
    setHoveredTarget(undefined, undefined);
    await new Promise((resolve) => setTimeout(resolve, HOVER_SETTLE_MS + 20));
    assert.deepEqual(seen, [creature.guid, undefined], "leaving the unit settles after the window");
    assert.equal(settledHoveredUnitGuid(world), undefined);
  } finally {
    off();
    setHoveredTarget(undefined, undefined);
  }
});

test("the live seam resolves the mouseover token and fires UPDATE_MOUSEOVER_UNIT on a settled pick", () => {
  const { seam, world, objects, fired, pump } = liveFixture();
  const creature = unitObject(0xf130000000000066n, 3, { level: 12 });
  objects.set(creature.guid, creature);
  seam.attach(pump);
  try {
    fired.length = 0;
    setHoveredTarget(world, creature);
    seam.tick(1);
    assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.mouseover),
      [["UPDATE_MOUSEOVER_UNIT"]]);
    assert.deepEqual(call(seam, "UnitExists", "mouseover"), [true]);
    assert.deepEqual(call(seam, "UnitLevel", "mouseover"), [12]);
    assert.deepEqual(call(seam, "UnitGUID", "mouseover"), ["0xf130000000000066"]);
    assert.deepEqual(call(seam, "UnitHealth", "mouseover"), [100]);
    world.targetGuid = creature.guid;
    assert.deepEqual(call(seam, "UnitIsUnit", "mouseover", "target"), [true]);
    fired.length = 0;
    seam.tick(2);
    assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.mouseover).length, 0,
      "an unchanged pick is not announced again");
    objects.delete(creature.guid);
    assert.deepEqual(call(seam, "UnitExists", "mouseover"), [false], "a despawned pick is gone at once");
  } finally {
    seam.detach();
    setHoveredTarget(undefined, undefined);
  }
});

test("the canned seam answers UnitGUID and an optional mouseover unit for offline checks", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 0 });
  assert.deepEqual(call(seam, "UnitGUID", "player"), ["0x0000000000000001"],
    "the canned SAY line's sender GUID");
  assert.deepEqual(call(seam, "UnitGUID", "pet"), ["0xf140000000000104"]);
  assert.deepEqual(call(seam, "UnitGUID", "mouseover"), []);
  fired.length = 0;
  seam.setMouseover("party1");
  assert.deepEqual(fired, ["UPDATE_MOUSEOVER_UNIT"]);
  assert.deepEqual(call(seam, "UnitName", "mouseover"), ["Альфа"]);
  assert.deepEqual(call(seam, "UnitIsUnit", "mouseover", "party1"), [true]);
  assert.deepEqual(call(seam, "UnitGUID", "mouseover"), call(seam, "UnitGUID", "party1"));
  seam.setPlayerClass("Герой", "HERO");
  assert.deepEqual(call(seam, "UnitClass", "player"), ["Герой", "HERO"]);
  seam.detach();
});
