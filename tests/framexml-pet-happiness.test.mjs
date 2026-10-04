import assert from "node:assert/strict";
import test, { after } from "node:test";

// 3.36 (L14): `GetPetHappiness()` as Wow.exe answers it (0x005d3b00) and the UNIT_HAPPINESS edge the
// stock PetFrame listens to (PetFrame.lua:23, :91). The happiness is the pet's UNIT_FIELD_POWER5; the
// levels and damage come from PetPersonality.dbc row 1 (0x0071f390, 0x0071f400). Only primitives are
// compared.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };

const {
  FRAMEXML_PET_HAPPINESS_EVENT,
  FRAMEXML_PET_HAPPINESS_NONE,
  FrameXmlPetHappinessWatch,
  frameXmlPetHappiness,
  frameXmlPetHappinessLevel,
} = await import("../dist/code/browser/framexml/FrameXmlPetHappiness.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const SELF = 0x10n;
const PET = 0xf140_0000_0000_0020n;
const HUNTER = 3;
const MAGE = 8;
const FOCUS = 2;
const POWER5 = offset("UNIT_FIELD_POWER1") + 4;

function object(guid, typeId, entries = []) {
  return {
    guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0,
    targetGuid: undefined, runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined,
    transport: undefined, speeds: undefined, transportTime: undefined, fields: new Map(entries),
  };
}

function setGuid(target, at, guid) {
  target.fields.set(at, Number(guid & 0xffff_ffffn));
  target.fields.set(at + 1, Number(guid >> 32n));
}

/** A hunter (class 3) and a tamed pet: pet number, creator, focus as display power, happiness. */
function hunterAndPet({ selfClass = HUNTER, happiness = 500_000, petNumber = 7, creator = SELF } = {}) {
  const self = object(SELF, 4, [
    [offset("UNIT_FIELD_BYTES_0"), 1 | (selfClass << 8)], [offset("UNIT_FIELD_LEVEL"), 80],
    [offset("UNIT_FIELD_HEALTH"), 4000], [offset("UNIT_FIELD_MAXHEALTH"), 4000],
  ]);
  setGuid(self, offset("UNIT_FIELD_SUMMON"), PET);
  const pet = object(PET, 3, [
    [offset("OBJECT_FIELD_ENTRY"), 9002], [offset("UNIT_FIELD_LEVEL"), 80],
    [offset("UNIT_FIELD_HEALTH"), 700], [offset("UNIT_FIELD_MAXHEALTH"), 1000],
    [offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8) | (FOCUS << 24)],
    // UNIT_PET_FLAG_CAN_BE_ABANDONED in byte 2: the existing HasPetUI isHunterPet (FrameXmlStable.ts).
    [offset("UNIT_FIELD_BYTES_2"), 0x02 << 16],
    [offset("UNIT_FIELD_POWER1") + FOCUS, 80], [offset("UNIT_FIELD_MAXPOWER1") + FOCUS, 100],
    [POWER5, happiness], [offset("UNIT_FIELD_MAXPOWER1") + 4, 1_050_000],
    [offset("UNIT_FIELD_PETNUMBER"), petNumber],
  ]);
  setGuid(pet, offset("UNIT_FIELD_CREATEDBY"), creator);
  setGuid(pet, offset("UNIT_FIELD_SUMMONEDBY"), SELF);
  return { self, pet };
}

function seamFixture(options) {
  const state = new WorldState();
  const store = new WorldStore(state);
  const { self, pet } = hunterAndPet(options);
  state.objects.set(SELF, self);
  state.objects.set(PET, pet);
  state.selfGuid = SELF;
  store.flush();
  const world = {
    state, targetGuid: undefined, petSpells: { guid: PET }, names: new Map(), creatureTemplates: new Map(),
    casts: new Map(), aurasFor: () => [], events: new EventBus(), actionButtons: [],
    cooldownState: () => undefined, cooldownRemaining: () => 0, isActiveMountSpell: () => false,
    selectTarget() {},
  };
  const fired = [];
  const pump = { now: () => 1, fire: (event, ...args) => { fired.push([event, ...args]); return 1; } };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store,
    spell: (id) => ({ id, name: `Spell ${id}`, rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    monotonic: () => 1_000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = () => FRAMEXML_SEAM_BINDINGS.GetPetHappiness(seam, []);
  return { state, store, world, seam, fired, pump, pet, self, call };
}

test("3.36: PetPersonality row 1 — below 333000 unhappy, below 666000 content, else happy", () => {
  const cases = [
    [0, 1], [1, 1], [332_999, 1], [333_000, 2], [665_999, 2], [666_000, 3], [1_050_000, 3],
    // 0x0071f400 compares the word as a signed int: a top-bit word is negative, so unhappy.
    [0x8000_0000, 1], [0xffff_ffff, 1],
  ];
  assert.deepEqual(cases.map(([power]) => frameXmlPetHappinessLevel(power)), cases.map(([, level]) => level));
});

test("3.36: GetPetHappiness answers level and damage percentage for a hunter's pet", () => {
  const answers = [100_000, 333_000, 500_000, 666_000, 1_050_000].map((happiness) => {
    const { call } = seamFixture({ happiness });
    return call();
  });
  assert.deepEqual(answers, [[1, 75], [2, 100], [2, 100], [3, 125], [3, 125]]);
});

test("3.36: GetPetHappiness answers nil, 100 without a hunter's pet (Wow.exe 0x005d3b00)", () => {
  assert.deepEqual([...FRAMEXML_PET_HAPPINESS_NONE], [undefined, 100]);
  const noPet = seamFixture();
  noPet.world.petSpells = undefined;
  const noPetNumber = seamFixture({ petNumber: 0 });
  const mageOwner = seamFixture({ selfClass: MAGE });
  const unknownCreator = seamFixture({ creator: 0x99n });
  const noCreator = seamFixture({ creator: 0n });
  // The creator must be a player object (0x0071f390 looks it up with the player type mask).
  const creatureCreator = seamFixture({ creator: 0x77n });
  creatureCreator.state.objects.set(0x77n, object(0x77n, 3, [[offset("UNIT_FIELD_BYTES_0"), HUNTER << 8]]));
  for (const [label, fixture] of Object.entries({
    noPet, noPetNumber, mageOwner, unknownCreator, noCreator, creatureCreator,
  })) assert.deepEqual(fixture.call(), [undefined, 100], label);
});

test("3.36: frameXmlPetHappiness reads only the pet, its creator and PetPersonality row 1", () => {
  const { self, pet } = hunterAndPet({ happiness: 700_000 });
  const lookups = [];
  const answer = frameXmlPetHappiness(pet, (guid) => { lookups.push(guid); return guid === SELF ? self : undefined; });
  assert.deepEqual([...answer], [3, 125]);
  assert.deepEqual(lookups, [SELF]);
  assert.deepEqual([...frameXmlPetHappiness(undefined, () => self)], [undefined, 100]);
});

test("3.36: a change of the pet's POWER5 fires UNIT_HAPPINESS for 'pet'; focus regen and other units do not", () => {
  const { state, store, seam, fired, pump } = seamFixture();
  seam.attach(pump);
  const happinessEdges = () => fired.filter(([event]) => event === FRAMEXML_PET_HAPPINESS_EVENT);
  assert.equal(FRAMEXML_PET_HAPPINESS_EVENT, "UNIT_HAPPINESS");

  fired.length = 0;
  state.setField(PET, POWER5, 400_000);
  store.flush();
  assert.deepEqual(happinessEdges(), [["UNIT_HAPPINESS", "pet"]]);

  fired.length = 0;
  state.setField(PET, offset("UNIT_FIELD_POWER1") + FOCUS, 85);
  store.flush();
  assert.deepEqual(happinessEdges(), [], "the focus tick leaves happiness alone");
  assert.ok(fired.some(([event, unit]) => event === "UNIT_FOCUS" && unit === "pet"), "the focus edge stays");

  fired.length = 0;
  state.setField(SELF, POWER5, 12);
  store.flush();
  assert.deepEqual(happinessEdges(), [], "the player's own slot 5 is not the pet's happiness");

  fired.length = 0;
  state.setField(PET, POWER5, 900_000);
  store.flush();
  assert.deepEqual(happinessEdges(), [["UNIT_HAPPINESS", "pet"]]);
  seam.detach();
});

test("3.36: the watch remembers one pet and one word, and a new pet is a new edge", () => {
  const watch = new FrameXmlPetHappinessWatch();
  const { pet } = hunterAndPet({ happiness: 10 });
  assert.equal(watch.changed(pet), true, "first sight of a pet");
  assert.equal(watch.changed(pet), false);
  pet.fields.set(POWER5, 11);
  assert.equal(watch.changed(pet), true);
  assert.equal(watch.changed(pet), false);
  const other = object(0x21n, 3, [[POWER5, 11]]);
  assert.equal(watch.changed(other), true, "same word, another pet");
  watch.reset();
  assert.equal(watch.changed(other), true, "after reset");
});

// ---- MPQ: the stock PetFrame over LiveWorldSeam and a real WorldClient. ----------------------------
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

test("3.36: stock PetFrame_SetHappiness shows the face and the damage line, and follows UNIT_HAPPINESS", withClient, async () => {
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const { ACT_COMMAND, COMMAND_FOLLOW, REACT_DEFENSIVE, packPetAction } =
    await import("../dist/code/world/PetProtocol.js");
  const { game } = await import("../dist/code/browser/game/Context.js");
  const decoder = new TextDecoder("utf-8");
  const provider = { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } };
  const lua = (boot, code, results = 1) => {
    const fn = boot.vm.compileFunction(code, "pet-happiness-test", []);
    assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
    try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
  };

  const world = new WorldClient({ send() {}, close() {} });
  const state = new WorldState();
  world.state = state;
  const { self, pet } = hunterAndPet({ happiness: 500_000 });
  state.objects.set(SELF, self);
  state.selfGuid = SELF;
  const store = new WorldStore(state);
  world.creatureTemplates.set(9002, { entry: 9002, name: "Волк", subName: "", flags: 0, creatureType: 1 });
  world.mapId = 0;
  world.selfName = "Охотник";
  const realmTime = { minuteOfDay: 9 * 60, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  const previousWorld = game.world;
  game.world = world;
  let now = 1;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store,
    spell: (id) => ({ id, name: `Заклинание ${id}`, rank: "", description: "", iconPath: "Interface\\Icons\\Spell_Test", effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], passive: false }),
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const boot = new FrameXmlBoot({ provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1365, height: 768 }) });
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`)
    .concat(boot.vm.errors.map(String));
  const poll = () => { now += 0.1; seam.tick(now); };
  const frames = (count = 10) => { for (let index = 0; index < count; index += 1) boot.bridge.tick(0.02); };
  const view = () => {
    const values = lua(boot, `
      return PetFrame:IsShown() and 1 or 0, PetFrameHappiness:IsShown() and 1 or 0,
        PetFrameHappiness.tooltip or "", PetFrameHappiness.tooltipDamage or ""`, 4);
    return { petFrame: values[0], face: values[1], tooltip: values[2], damage: values[3] };
  };
  const expected = (level, percent) => {
    const values = lua(boot, `return PET_HAPPINESS${level}, format(PET_DAMAGE_PERCENTAGE, ${percent})`, 2);
    return { petFrame: 1, face: 1, tooltip: values[0], damage: values[1] };
  };
  try {
    await boot.load();
    const errorsAtBoot = failures();
    assert.deepEqual(lua(boot, "local h, d = GetPetHappiness() return h == nil and 1 or 0, d", 2), [1, 100],
      "no pet: nil, 100");

    // The pet arrives: its object, then the pet bar that names it (SMSG_PET_SPELLS).
    state.objects.set(PET, pet);
    world.petSpells = {
      guid: PET, closed: false, creatureFamily: 1, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
      flags: 0, spells: [], cooldowns: [],
      bar: Array.from({ length: 10 }, (_, slot) => ({ slot, packed: packPetAction(0, ACT_COMMAND), action: 0, type: ACT_COMMAND })),
    };
    world.events.emit("PET_BAR_CHANGED", { guid: PET });
    poll();
    frames();
    assert.deepEqual(view(), expected(2, 100), "content: 500000");

    state.setField(PET, POWER5, 700_000);
    store.flush();
    frames();
    assert.deepEqual(view(), expected(3, 125), "happy after UNIT_HAPPINESS");

    state.setField(PET, POWER5, 100_000);
    store.flush();
    frames();
    assert.deepEqual(view(), expected(1, 75), "unhappy after UNIT_HAPPINESS");
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error");
  } finally {
    boot.close();
    game.world = previousWorld;
  }
});
