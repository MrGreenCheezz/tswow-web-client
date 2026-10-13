import assert from "node:assert/strict";
import test from "node:test";

// Plan item 2.05 (13.10): ACTIONBAR_UPDATE_STATE + CURRENT_SPELL_CAST_CHANGED (Wow.exe 0x0053b480) on the player's own
// cast — the request (0x0080ac90 → 0x00805330), a non-pending SMSG_SPELL_START (0x00806700 → 0x00805330) and the end
// (0x008054f0 from the GO, the refusals and the failures), each for a cast with a count whose caster is the player or
// 0x007fe8d0's charm-else-summon — and on the reticle's and the glyph cursor's arming and drop (0x0080cce0,
// 0x00806200), as the item cursor already had (FrameXmlBoundTradeable.ts). Before, a cast raised neither: the stock
// action button's checked state (IsCurrentAction) and SpellBookFrame's selection never followed a cast.
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { frameXmlObserveOwnCastChanges, frameXmlOwnCaster } = await import("../dist/code/browser/framexml/FrameXmlOwnCastChanges.js");
const { frameXmlObservePendingSpells } = await import("../dist/code/browser/framexml/FrameXmlBoundTradeable.js");
const { FrameXmlGlyphModel, frameXmlGlyphCatalog } = await import("../dist/code/browser/framexml/FrameXmlGlyph.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { beginGroundTarget, cancelGroundTarget, observeGroundTarget } = await import("../dist/code/browser/game/GroundTarget.js");

const SELF = 0x10n;
const PET = 0xf140_0000_0000_0042n;
const VEHICLE = 0xf150_0000_0000_0043n;
const MOB = 0xf130_0000_0000_0077n;
const CHARM = UPDATE_FIELDS.UNIT_FIELD_CHARM.offset;
const SUMMON = UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffffffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

function harness() {
  const fields = new Map();
  setGuid(fields, SUMMON, PET);
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, { guid: SELF, typeId: 4, fields }]]) },
    events: new EventBus(),
  };
  const fired = [];
  const pump = { fire: (event) => { fired.push(event); return 1; } };
  const stop = frameXmlObserveOwnCastChanges(world, () => pump);
  const pairs = () => {
    const count = fired.filter((event) => event === "CURRENT_SPELL_CAST_CHANGED").length;
    fired.length = 0;
    return count;
  };
  return { world, fields, fired, pairs, stop };
}

const start = (casterUnit, castId, castFlags = 0) => ({
  casterGuid: casterUnit, casterUnit, castId, spellId: 133, castFlags, castTime: 2500, schoolImmunityMask: 0, mechanicImmunityMask: 0,
});

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

test("the request, the start and the end of the player's cast each raise the pair, in 0x0053b480's order", async () => {
  const { world, fired, pairs } = harness();
  world.events.emit("SPELL_CAST_SENT", { spellId: 133, castCount: 3 });
  assert.deepEqual(fired, ["ACTIONBAR_UPDATE_STATE", "CURRENT_SPELL_CAST_CHANGED"]);
  fired.length = 0;
  world.events.emit("SPELL_START", start(SELF, 3));
  assert.equal(pairs(), 1, "a non-pending start of the player's");
  world.events.emit("SPELL_CAST_RESULT", { casterGuid: SELF, spellId: 133, castCount: 3, result: 187 });
  world.events.emit("SPELL_CAST_STOP", { casterGuid: SELF, spellId: 133, interrupted: false });
  assert.equal(pairs(), 0, "not before the rest of the packet (0x008054f0 follows the outcome and its STOP)");
  await settle();
  assert.equal(pairs(), 1, "the GO");
  world.events.emit("SPELL_CAST_RESULT", { casterGuid: SELF, spellId: 133, castCount: 4, result: 40, refusal: true });
  world.events.emit("SPELL_CAST_REFUSED_LOCAL", { spellId: 133, result: 97, casterGuid: SELF, castCount: 5 });
  await settle();
  assert.equal(pairs(), 2, "the realm's refusal and the client's own");
});

test("a triggered spell, a cast without a count and another unit's cast raise nothing", async () => {
  const { world, pairs } = harness();
  world.events.emit("SPELL_CAST_SENT", { spellId: 133, castCount: 0 });
  world.events.emit("SPELL_START", start(SELF, 3, 0x1));
  world.events.emit("SPELL_START", start(SELF, 0));
  world.events.emit("SPELL_START", start(MOB, 3));
  world.events.emit("SPELL_CAST_RESULT", { casterGuid: SELF, spellId: 133, castCount: 0, result: 187 });
  world.events.emit("SPELL_CAST_RESULT", { casterGuid: MOB, spellId: 133, castCount: 3, result: 187 });
  world.events.emit("SPELL_CAST_REFUSED_LOCAL", { spellId: 133, result: 97 });
  await settle();
  assert.equal(pairs(), 0);
});

test("0x007fe8d0: the player's charm, else the summon (the pet), counts as the player", async () => {
  const { world, fields, pairs, stop } = harness();
  assert.equal(frameXmlOwnCaster(world, PET), true, "no charm: the summon");
  world.events.emit("SPELL_START", start(PET, 7));
  assert.equal(pairs(), 1);
  setGuid(fields, CHARM, VEHICLE);
  assert.equal(frameXmlOwnCaster(world, VEHICLE), true, "a charm (a vehicle, a possessed unit)");
  assert.equal(frameXmlOwnCaster(world, PET), false, "the charm stands for the summon");
  world.events.emit("SPELL_CAST_RESULT", { casterGuid: VEHICLE, spellId: 133, castCount: 7, result: 187 });
  await settle();
  assert.equal(pairs(), 1);
  world.events.emit("SPELL_CAST_RESULT", { casterGuid: VEHICLE, spellId: 133, castCount: 8, result: 187 });
  stop();
  world.events.emit("SPELL_CAST_SENT", { spellId: 133, castCount: 3 });
  await settle();
  assert.equal(pairs(), 0, "detached: nothing, a deferred pair included");
});

test("the reticle raises the pair on every arming and on its drop, not on a drop of nothing", () => {
  const fired = [];
  const pump = { fire: (event) => { fired.push(event); return 1; } };
  const stop = frameXmlObservePendingSpells(() => pump, [observeGroundTarget]);
  const previous = game.world;
  game.world = { state: { selfGuid: SELF, objects: new Map() } };
  try {
    const count = () => { const n = fired.filter((e) => e === "CURRENT_SPELL_CAST_CHANGED").length; fired.length = 0; return n; };
    assert.equal(beginGroundTarget(190356), true);
    assert.equal(count(), 1, "armed (0x0080cce0)");
    beginGroundTarget(190356);
    assert.equal(count(), 1, "re-armed: an edge again");
    cancelGroundTarget();
    assert.equal(count(), 1, "dropped (0x00806200 → 0x008054f0)");
    cancelGroundTarget();
    assert.equal(count(), 0, "nothing up: nothing raised");
  } finally {
    stop();
    cancelGroundTarget();
    game.world = previous;
  }
});

test("the glyph cursor raises the pair on its arming and its drop; a placement that goes out is the request's", () => {
  const CATALOG = {
    version: 1, glyphs: [{ id: 319, spellId: 56370, slotFlags: 0, icon: "" }],
    slots: [{ id: 21, type: 0, order: 1 }], itemSpells: [[56590, 319]],
  };
  const state = { holds: true };
  const placed = [];
  const model = new FrameXmlGlyphModel({
    catalog: () => frameXmlGlyphCatalog(CATALOG, 1), enabledMask: () => 1, slotId: () => 21, activeGroup: () => 1,
    glyph: () => 0, spellName: () => "x", holds: () => state.holds, place: (item, index) => placed.push(index),
    remove() {}, session: () => ({}),
  });
  model.attach({ fire: () => 1 });
  model.owned = true;
  const fired = [];
  const stop = frameXmlObservePendingSpells(() => ({ fire: (event) => { fired.push(event); return 1; } }),
    [(observer) => model.observeTargeting(observer)]);
  const count = () => { const n = fired.filter((e) => e === "CURRENT_SPELL_CAST_CHANGED").length; fired.length = 0; return n; };
  const item = { guid: 0x4000_0000_0000_0001n, bag: 255, slot: 23, spellId: 56590 };
  try {
    assert.equal(model.useItem(item), true);
    assert.equal(count(), 1, "armed");
    assert.equal(model.cancelTargeting(), true);
    assert.equal(count(), 1, "SpellStopTargeting");
    model.useItem(item);
    count();
    model.place(1);
    assert.deepEqual(placed, [0]);
    assert.equal(count(), 0, "placed: CMSG_USE_ITEM's own SENT raises the pair (0x0080ac90 → 0x00805330)");
    model.useItem(item);
    count();
    state.holds = false;
    model.tick();
    assert.equal(count(), 1, "the item left the bags: dropped");
    model.useItem(item);
    count();
    model.place(1);
    assert.equal(count(), 1, "a placement that sends nothing is a drop");
    model.detach();
    assert.equal(count(), 0, "detached with nothing up: no drop");
  } finally { stop(); model.detach(); }
});

test("a cursor's drop and the request it sent raise one pair between them, in either order (0x0080ac90)", async () => {
  const { world, pairs, stop } = harness();
  const fired = [];
  let listener;
  const stopCursor = frameXmlObservePendingSpells(() => ({ fire: (event) => { fired.push(event); return 1; } }),
    [(observer) => { listener = observer; return () => {}; }]);
  const cursorPairs = () => { const n = fired.filter((e) => e === "CURRENT_SPELL_CAST_CHANGED").length; fired.length = 0; return n; };
  try {
    await settle();
    // The item cursor: the request, then the drop.
    world.events.emit("SPELL_CAST_SENT", { spellId: 13262, castCount: 4 });
    listener(false);
    assert.equal(pairs() + cursorPairs(), 1, "sent, then down");
    await settle();
    // The reticle: the drop, then the request.
    listener(false);
    world.events.emit("SPELL_CAST_SENT", { spellId: 190356, castCount: 5 });
    assert.equal(pairs() + cursorPairs(), 1, "down, then sent");
    await settle();
    // Apart: two edges, two pairs.
    listener(false);
    await settle();
    world.events.emit("SPELL_CAST_SENT", { spellId: 133, castCount: 6 });
    assert.equal(pairs() + cursorPairs(), 2, "a drop and a later request");
    await settle();
    listener(true);
    world.events.emit("SPELL_CAST_SENT", { spellId: 133, castCount: 7 });
    assert.equal(pairs() + cursorPairs(), 2, "an arming is always its own edge");
  } finally { stopCursor(); stop(); }
});
