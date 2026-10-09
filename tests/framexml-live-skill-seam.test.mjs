import assert from "node:assert/strict";
import test from "node:test";

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
