import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-live-skill-seam.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}

function packedPlayer({ rank = 412, temporary = -5, permanent = 10 } = {}) {
  const guid = 0x10n;
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  const fields = new Map([
    [base, 164 | (3 << 16)],
    [base + 1, rank | (450 << 16)],
    [base + 2, (temporary & 0xffff) | ((permanent & 0xffff) << 16)],
  ]);
  return {
    guid,
    typeId: 4,
    position: undefined,
    movementFlags: 0,
    updateFlags: 0,
    targetGuid: undefined,
    runSpeed: undefined,
    turnRate: undefined,
    motion: undefined,
    glide: undefined,
    transport: undefined,
    speeds: undefined,
    transportTime: undefined,
    fields,
  };
}

function skillMetadata(ready = true, revision = 1) {
  const lines = new Map([
    [164, { id: 164, name: "Кузнечное дело", categoryId: 11 }],
  ]);
  const categories = [{ id: 11, name: "Профессии", orderIndex: 3 }];
  return {
    ready,
    revision,
    skillLine: (id) => lines.get(id),
    skillCategory: (id) => categories.find((category) => category.id === id),
    skillCategories: () => categories,
  };
}

function fixture({ ready = true } = {}) {
  const player = packedPlayer();
  const worldEvents = new FakeEvents();
  const selfGuid = player.guid;
  const world = {
    mapId: 0,
    worldStateContext: undefined,
    state: { selfGuid, objects: new Map([[selfGuid, player]]) },
    actionButtons: [],
    casts: new Map(),
    channels: new Map(),
    cooldownSnapshots: new Map(),
    partyStats: new Map(),
    questPoi: new Map(),
    chatLog: [],
    events: worldEvents,
    cooldownRemaining: () => 0,
    aurasFor: () => [],
  };
  const storeListeners = [];
  const store = {
    fieldRange(subject, name, listener) {
      // Other seam models (FrameXmlWorldEvents: rating words, 3.22) subscribe ranges of their own;
      // this test watches the skill range alone.
      if (name !== "PLAYER_SKILL_INFO_1_1") return () => {};
      assert.equal(subject, "self");
      storeListeners.push(listener);
      return () => {
        const index = storeListeners.indexOf(listener);
        if (index >= 0) storeListeners.splice(index, 1);
      };
    },
    field() { return () => {}; },
  };
  let metadata = skillMetadata(ready);
  const fired = [];
  const pump = {
    now: () => 100,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    skillMetadata: () => metadata,
    monotonic: () => 100000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return {
    seam, world, player, fired, pump, storeListeners,
    setMetadata: (next) => { metadata = next; },
  };
}

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("live SkillFrame stays empty until metadata is ready, then emits one poll edge", () => {
  const fixtureState = fixture({ ready: false });
  const { seam, fired, pump, setMetadata } = fixtureState;
  seam.attach(pump);
  fired.length = 0;
  assert.deepEqual(call("GetNumSkillLines", seam), [0]);

  setMetadata(skillMetadata(true, 1));
  seam.tick(0.061);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.skillLinesChanged), [
    [FRAMEXML_SEAM_EVENTS.skillLinesChanged],
  ]);
  assert.deepEqual(call("GetNumSkillLines", seam), [2]);
  // The eighth value, `isAbandonable`, is true for a profession row since AbandonSkill reached
  // the seam (FrameXmlSkillResolver.ts): the stock SkillFrame draws its unlearn button from it.
  assert.deepEqual(call("GetSkillLineInfo", seam, 2), [
    "Кузнечное дело", false, true, 412, -5, 10, 450, true,
    undefined, undefined, 0, 0, "",
  ]);

  fired.length = 0;
  seam.tick(0.062);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.skillLinesChanged), [],
    "steady metadata does not duplicate SKILL_LINES_CHANGED");
  seam.detach();
});

test("live skill range subscription refreshes changed words precisely and never writes packets", () => {
  const fixtureState = fixture();
  const { seam, player, fired, pump, storeListeners } = fixtureState;
  seam.attach(pump);
  fired.length = 0;
  assert.equal(storeListeners.length, 1, "the complete private array is subscribed once");
  assert.equal(call("GetSkillLineInfo", seam, 2)[3], 412);

  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  player.fields.set(base + 1, 420 | (450 << 16));
  storeListeners[0]();
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.skillLinesChanged), [
    [FRAMEXML_SEAM_EVENTS.skillLinesChanged],
  ]);
  assert.equal(call("GetSkillLineInfo", seam, 2)[3], 420);

  fired.length = 0;
  for (const name of ["AddSkillUp", "RemoveSkillUp", "BuySkillTier", "CancelSkillUps"]) {
    call(name, seam, 2);
  }
  assert.deepEqual(fired, [], "unsupported training methods remain silent");
  seam.detach();
});

test("WorldStore fieldRange reaches the last PLAYER_SKILL_INFO word and unsubscribes", () => {
  const state = new WorldState();
  const player = packedPlayer();
  state.objects.set(player.guid, player);
  state.selfGuid = player.guid;
  const store = new WorldStore(state);
  let calls = 0;
  const unsubscribe = store.fieldRange("self", "PLAYER_SKILL_INFO_1_1", () => { calls += 1; });
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  player.fields.set(base + UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.size - 1, 7);
  store.fieldsChanged(player.guid, [base + UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.size - 1]);
  store.flush();
  assert.equal(calls, 1, "a late word in the 384-word array still refreshes the seam");
  unsubscribe();
  player.fields.set(base + UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.size - 1, 8);
  store.fieldsChanged(player.guid, [base + UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.size - 1]);
  store.flush();
  assert.equal(calls, 1, "detached range listener does not retain the world");
  store.detach();
});
}

// ── framexml-skill-resolver.test.mjs
{
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { resolveFrameXmlSkillRows, createFrameXmlSkillResolvers } = await import(
  "../dist/code/browser/framexml/FrameXmlSkillResolver.js",
);

const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;

function playerWithSkills(entries) {
  const fields = new Map();
  for (const [slot, entry] of entries.entries()) {
    const at = base + slot * 3;
    fields.set(at, (entry.id & 0xffff) | ((entry.step & 0xffff) << 16));
    fields.set(at + 1, (entry.value & 0xffff) | ((entry.max & 0xffff) << 16));
    fields.set(at + 2, (entry.temporaryBonus & 0xffff) | ((entry.permanentBonus & 0xffff) << 16));
  }
  return { guid: 1n, typeId: 4, fields };
}

function talent(overrides = {}) {
  const lines = new Map([
    [164, { id: 164, name: "Кузнечное дело", categoryId: 11, iconId: 0 }],
    [186, { id: 186, name: "Горное дело", categoryId: 11, iconId: 0 }],
    [43, { id: 43, name: "Мечи", categoryId: 6, iconId: 0 }],
    [98, { id: 98, name: "Общий", categoryId: 10, iconId: 0 }],
    [999, { id: 999, name: "Не отображается", categoryId: 12, iconId: 0 }],
  ]);
  const categories = [
    { id: 6, name: "Оружие", orderIndex: 5 },
    { id: 12, name: "Не отображается", orderIndex: 8 },
    { id: 11, name: "Профессии", orderIndex: 3 },
    { id: 10, name: "Языки", orderIndex: 7 },
  ];
  return {
    ready: true,
    revision: 1,
    skillLine: (id) => lines.get(id),
    skillCategory: (id) => categories.find((category) => category.id === id),
    // Deliberately not in order: the resolver must use SortIndex, not transport/native order.
    skillCategories: () => categories,
    ...overrides,
  };
}

function world(player, revision = 1) {
  return { player, revision };
}

test("packed skill rows preserve base rank, signed bonuses and exact max rank", () => {
  const rows = resolveFrameXmlSkillRows(playerWithSkills(new Map([
    [0, { id: 164, step: 3, value: 412, max: 450, temporaryBonus: -5, permanentBonus: 10 }],
  ])), talent());

  assert.deepEqual(rows, [{
    kind: "header", id: 11, categoryId: 11, name: "Профессии",
  }, {
    kind: "skill", id: 164, skillId: 164, categoryId: 11, name: "Кузнечное дело",
    step: 3, skillRank: 412, numTempPoints: -5, skillModifier: 10, skillMaxRank: 450,
  }]);
  assert.equal(Object.isFrozen(rows), true);
  assert.equal(Object.isFrozen(rows[1]), true);
});

test("categories follow DBC SortIndex and skills use localized name then id", () => {
  const rows = resolveFrameXmlSkillRows(playerWithSkills(new Map([
    [0, { id: 186, step: 1, value: 100, max: 150, temporaryBonus: 0, permanentBonus: 0 }],
    [1, { id: 164, step: 1, value: 200, max: 300, temporaryBonus: 0, permanentBonus: 0 }],
    [2, { id: 43, step: 1, value: 50, max: 100, temporaryBonus: 0, permanentBonus: 0 }],
  ])), talent());

  assert.deepEqual(rows.map((row) => row.kind === "header" ? [row.kind, row.id] : [row.kind, row.id]), [
    ["header", 11], ["skill", 186], ["skill", 164], ["header", 6], ["skill", 43],
  ]);
});

test("unready or missing metadata is authoritative empty, and hidden/unknown rows are omitted", () => {
  const player = playerWithSkills(new Map([
    [0, { id: 164, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
    [1, { id: 999, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
    [2, { id: 12345, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
  ]));
  assert.deepEqual(resolveFrameXmlSkillRows(player, { ...talent(), ready: false }), []);
  assert.deepEqual(resolveFrameXmlSkillRows(player, talent({
    skillCategory: () => undefined,
  })), []);
  assert.deepEqual(resolveFrameXmlSkillRows(player, talent()), [{
    kind: "header", id: 11, categoryId: 11, name: "Профессии",
  }, {
    kind: "skill", id: 164, skillId: 164, categoryId: 11, name: "Кузнечное дело",
    step: 1, skillRank: 1, numTempPoints: 0, skillModifier: 0, skillMaxRank: 10,
  }]);
});

test("cached snapshots refresh only when the player/world revision changes", () => {
  const player = playerWithSkills(new Map([
    [0, { id: 164, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
  ]));
  let source = { world: world(player, 1), talent: talent() };
  const resolver = createFrameXmlSkillResolvers(() => ({
    player: source.world.player,
    playerRevision: source.world.revision,
    talent: source.talent,
  }));
  const first = resolver.skillRows();
  assert.equal(resolver.skillRows(), first);
  player.fields.set(base + 1, 2 | (10 << 16));
  assert.equal(resolver.skillRows(), first, "the caller must advance its world revision after a mutation");
  source = { ...source, world: world(player, 2) };
  const second = resolver.skillRows();
  assert.notEqual(second, first);
  assert.equal(second.find((row) => row.kind === "skill").skillRank, 2);
  source = { ...source, world: world(undefined, 3) };
  assert.deepEqual(resolver.skillRows(), []);
});
}

// ── framexml-skill-seam.test.mjs
{
const {
  CannedWorldSeam,
  CANNED_SKILL_ROWS,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("Canned SkillFrame answers exact rows, signed bonuses, selection and collapse", () => {
  for (const name of [
    "GetNumSkillLines", "GetSkillLineInfo", "GetAdjustedSkillPoints", "GetSelectedSkill",
    "SetSelectedSkill", "ExpandSkillHeader", "CollapseSkillHeader", "AddSkillUp",
    "RemoveSkillUp", "BuySkillTier", "CancelSkillUps",
  ]) assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
  assert.equal(FRAMEXML_SEAM_EVENTS.skillLinesChanged, "SKILL_LINES_CHANGED");

  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ now: () => 1, fire: (event, ...args) => {
    fired.push([event, ...args]);
    return 1;
  } });
  fired.length = 0;

  assert.deepEqual(call("GetNumSkillLines", seam), [CANNED_SKILL_ROWS.length]);
  assert.deepEqual(call("GetSkillLineInfo", seam, 1), [
    "Профессии", true, true, 0, 0, 0, 0, false, undefined, undefined, 0, 0, "",
  ]);
  // `isAbandonable` (the eighth value) is true for a profession since AbandonSkill reached the
  // seam: the stock SkillFrame shows its unlearn button from this flag, as the client does.
  assert.deepEqual(call("GetSkillLineInfo", seam, 2), [
    "Кузнечное дело", false, true, 412, -5, 10, 450, true,
    undefined, undefined, 0, 0, "",
  ]);
  assert.deepEqual(call("GetAdjustedSkillPoints", seam), [0]);
  assert.deepEqual(call("GetSelectedSkill", seam), [0]);

  call("SetSelectedSkill", seam, 2);
  assert.deepEqual(call("GetSelectedSkill", seam), [2]);
  call("SetSelectedSkill", seam, 2);
  assert.deepEqual(fired, [], "selection is immediate UI state, not a world mutation event");

  call("CollapseSkillHeader", seam, 1);
  assert.deepEqual(call("GetNumSkillLines", seam), [3]);
  assert.deepEqual(call("GetSkillLineInfo", seam, 2), [
    "Второстепенные", true, true, 0, 0, 0, 0, false, undefined, undefined, 0, 0, "",
  ]);
  assert.deepEqual(call("GetSelectedSkill", seam), [0],
    "hidden selected skill is retained internally and becomes visible again on expand");
  assert.deepEqual(fired, [["SKILL_LINES_CHANGED"]]);
  fired.length = 0;

  call("CollapseSkillHeader", seam, 1);
  assert.deepEqual(fired, [], "repeating collapse is silent");
  call("ExpandSkillHeader", seam, 1);
  assert.deepEqual(call("GetNumSkillLines", seam), [5]);
  assert.deepEqual(call("GetSelectedSkill", seam), [2]);
  assert.deepEqual(fired, [["SKILL_LINES_CHANGED"]]);
  fired.length = 0;

  // The current protocol has no skill-training request. All four stock entry points are inert.
  call("AddSkillUp", seam, 2);
  call("RemoveSkillUp", seam, 2);
  call("BuySkillTier", seam, 2);
  call("CancelSkillUps", seam);
  assert.deepEqual(fired, [], "unsupported training operations do not fabricate events");
  seam.detach();
});
}
