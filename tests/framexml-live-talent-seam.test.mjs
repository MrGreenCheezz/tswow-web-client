import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

test("LiveWorldSeam emits separate stock talent updates for player and pet packets", () => {
  const events = new FakeEvents();
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    events,
    casts: new Map(),
    actionButtons: [],
    cooldownRemaining: () => 0,
  };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 };
  seam.attach(pump);
  fired.length = 0;

  events.emit("TALENTS_CHANGED", { pet: true });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.petTalentsChanged]],
    "pet talent packets produce the stock pet edge, not a player update");
  events.emit("TALENTS_CHANGED", { pet: false });
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.petTalentsChanged],
    [FRAMEXML_SEAM_EVENTS.talentsChanged],
    [FRAMEXML_SEAM_EVENTS.talentsChanged],
  ], "each authoritative player packet produces exactly one transition");

  seam.detach();
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.equal(fired.length, 3, "detached worlds no longer publish stale talent transitions");
});

test("stock pet LearnTalent sends one core pet preview rank and waits for packet state", () => {
  const sent = [];
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    petSpells: { guid: 0x42n, creatureFamily: 1 },
    petTalents: { pet: true, unspentPoints: 1, activeSpec: 0,
      specs: [{ talents: [{ talentId: 30, rank: 3 }], glyphs: [] }] },
    learnPetTalents: (guid, talents) => sent.push([guid, talents]),
  };
  const metadata = {
    ready: true,
    revision: 1,
    tabsForClass: () => [],
    petTalentMask: (family) => family === 1 ? 1 : 0,
    petTabs: (mask) => mask === 1 ? [{ id: 200, name: "Ferocity", orderIndex: 0,
      classMask: 0, petTalentMask: 1 }] : [],
    talentsIn: (tabId) => tabId === 200 ? [
      { id: 30, tabId, tier: 0, column: 0, ranks: [3001, 3002, 3003], prerequisites: [] },
      { id: 31, tabId, tier: 1, column: 1, ranks: [3101], prerequisites: [] },
    ] : [],
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    talentMetadata: () => metadata,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  assert.equal(seam.talentSnapshot(true).groups[0].tabs[0].talents[1].meetsPrereq, true);
  seam.learnTalent(1, 2, true, 1);
  assert.deepEqual(sent, [[0x42n, [{ talentId: 31, rank: 1 }]]]);
  assert.equal(seam.talentSnapshot(true).groups[0].tabs[0].talents[1].rank, 0,
    "a click cannot spend a point until SMSG_TALENTS_INFO arrives");
  seam.learnTalent(1, 2, true, 2);
  seam.learnTalent(1, 1, true, 1);
  assert.equal(sent.length, 1, "wrong group and maxed rank are refused before transport");

  world.petSpells = { guid: 0x43n, creatureFamily: 1 };
  assert.equal(seam.talentSnapshot(true), undefined,
    "a replacement pet cannot inherit the previous pet's untagged rank packet");
  seam.learnTalent(1, 2, true, 1);
  assert.equal(sent.length, 1, "stale ranks cannot train a new pet");
  world.petTalents = { pet: true, unspentPoints: 2, activeSpec: 0,
    specs: [{ talents: [{ talentId: 30, rank: 1 }], glyphs: [] }] };
  assert.equal(seam.talentSnapshot(true).groups[0].tabs[0].talents[0].rank, 1);
});
