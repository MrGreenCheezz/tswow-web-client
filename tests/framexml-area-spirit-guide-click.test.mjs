// Plan item 5.25 (11.11): the spirit guide's two remaining Wow.exe rules (FrameXmlAreaSpiritHealer.ts).
// * 0x006ddbb0 → 0x006db180: a ghost's right click on a guide calls 0x523eb0 with 0 (dropping the guide; a running
//   clock means AREA_SPIRIT_HEALER_OUT_OF_RANGE and CMSG_CANCEL_AURA 2584) and then with the clicked guide, which is
//   asked again — the same guide too (.runtime/re-2026-11-11/moves/m2.c, worldtails/w1.c).
// * 0x524010 → 0x523f80 returns 1 after a match, so with two guides in reach each one is taken and asked in the order
//   of the object walk, the last kept (this client's `state.objects` order; Wow.exe's list order is not established).
import assert from "node:assert/strict";
import test from "node:test";

const {
  FrameXmlAreaSpiritHealerModel, frameXmlAreaSpiritGuideClicked, frameXmlAreaSpiritHealerLiveContext,
  FRAMEXML_WAITING_TO_RESURRECT_SPELL,
} = await import("../dist/code/browser/framexml/FrameXmlAreaSpiritHealer.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { REACTION_FRIENDLY } = await import("../dist/code/world/FactionRules.js");

const GUIDE = 0xf1300033bc000101n;
const OTHER = 0xf1300033bc000202n;

function fakeWorld() {
  return {
    spiritHealerTimers: new Map(),
    sent: [],
    queryAreaSpiritHealer(guid) { this.sent.push(["query", guid]); },
    queueAreaSpiritHealer(guid) { this.sent.push(["queue", guid]); },
    cancelAura(spellId) { this.sent.push(["cancelAura", spellId]); },
  };
}

function fixture({ guides = [[GUIDE, 10]], withAll = true } = {}) {
  const world = fakeWorld();
  const clock = { now: 50_000 };
  const state = { ghost: true, owned: true, distances: new Map(guides) };
  const inReach = (limitSquared) => [...state.distances].filter(([, yards]) => yards * yards <= limitSquared).map(([guid]) => guid);
  const model = new FrameXmlAreaSpiritHealerModel({
    world: () => world,
    now: () => clock.now,
    ghost: () => state.ghost,
    owned: () => state.owned,
    distanceSquared: (guid) => {
      const yards = state.distances.get(guid);
      return yards === undefined ? undefined : yards * yards;
    },
    findGuide: (limitSquared) => inReach(limitSquared)[0],
    ...(withAll ? { findGuides: inReach } : {}),
  });
  const events = [];
  model.attach({ fire(event) { events.push(event); return 1; } });
  const answer = (guid, milliseconds) => world.spiritHealerTimers.set(guid, { milliseconds, receivedAt: clock.now });
  return { world, clock, state, model, events, answer };
}

test("0x523f80 takes every guide in reach in walk order, each with its own query; the last one is kept", () => {
  const { world, model, events, answer } = fixture({ guides: [[GUIDE, 10], [OTHER, 12]] });
  assert.deepEqual(world.sent, [["query", GUIDE], ["query", OTHER]], "both asked, in the walk's order");
  answer(GUIDE, 20_000);
  model.tick();
  assert.deepEqual(events, [], "the first one's answer is not the kept guide's");
  answer(OTHER, 18_000);
  model.tick();
  assert.deepEqual(events, ["AREA_SPIRIT_HEALER_IN_RANGE"], "the last one is the guide in range");
  model.tick();
  assert.equal(world.sent.length, 2, "held while it stays within 22 yards: no new walk");
  // Without the list the model keeps its first-match path.
  const single = fixture({ guides: [[GUIDE, 10], [OTHER, 12]], withAll: false });
  assert.deepEqual(single.world.sent, [["query", GUIDE]]);
});

test("0x006db180: a ghost's click on the guide it holds asks it again", () => {
  const { world, model, events } = fixture();
  assert.deepEqual(world.sent, [["query", GUIDE]]);
  frameXmlAreaSpiritGuideClicked(GUIDE);
  assert.deepEqual(world.sent, [["query", GUIDE], ["query", GUIDE]], "dropped and taken again: a new query");
  assert.deepEqual(events, [], "no clock was running: nothing to cancel");
  model.detach();
});

test("0x006db180: a click while the clock runs leaves the queue, then takes the clicked guide", () => {
  const { world, model, events, answer } = fixture({ guides: [[GUIDE, 10], [OTHER, 30]] });
  answer(GUIDE, 25_000);
  model.tick();
  assert.deepEqual(events, ["AREA_SPIRIT_HEALER_IN_RANGE"]);
  frameXmlAreaSpiritGuideClicked(OTHER);
  assert.deepEqual(events, ["AREA_SPIRIT_HEALER_IN_RANGE", "AREA_SPIRIT_HEALER_OUT_OF_RANGE"], "0x51f710 for the old clock");
  assert.deepEqual(world.sent, [["query", GUIDE], ["cancelAura", FRAMEXML_WAITING_TO_RESURRECT_SPELL], ["query", OTHER]]);
  model.detach();
});

test("0x006db180 does nothing for a living player, and nothing reaches a detached model", () => {
  const { world, state, model } = fixture();
  state.ghost = false;
  model.tick(); // a living player drops the guide (0x524010)
  frameXmlAreaSpiritGuideClicked(GUIDE);
  assert.deepEqual(world.sent, [["query", GUIDE]]);
  state.ghost = true;
  model.detach();
  frameXmlAreaSpiritGuideClicked(GUIDE);
  assert.deepEqual(world.sent, [["query", GUIDE]], "detached: the click finds no model");
});

test("the live context lists every friendly guide within reach in `state.objects` order", () => {
  const NPC_FLAGS = UPDATE_FIELDS.UNIT_NPC_FLAGS.offset;
  const guide = (guid, x) => ({ guid, typeId: 3, position: { x, y: 0, z: 0, orientation: 0 }, fields: new Map([[NPC_FLAGS, 0x8000]]) });
  const self = { guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const objects = new Map([[1n, self], [OTHER, guide(OTHER, 15)], [GUIDE, guide(GUIDE, 5)], [7n, guide(7n, 25)]]);
  const context = frameXmlAreaSpiritHealerLiveContext({
    world: () => ({ state: { objects } }),
    self: () => self,
    reaction: () => REACTION_FRIENDLY,
    owned: () => true,
    monotonic: () => 0,
  });
  assert.deepEqual(context.findGuides(400), [OTHER, GUIDE], "the object order, not the nearest first; 25 yd is out");
  assert.equal(context.findGuide(400), OTHER);
});
