import assert from "node:assert/strict";
import test from "node:test";
import {
  frameXmlMultiCastActionSlot, frameXmlMultiCastLists, frameXmlTotemItemServes,
} from "../dist/code/browser/framexml/FrameXmlMultiCast.js";
import { FrameXmlMultiCastLive } from "../dist/code/browser/framexml/FrameXmlMultiCastLive.js";

// 3.07 against Wow.exe 3.3.5a 12340: the lists (0x00542030 over 0x005a7b50), the action → slot map
// (0x005a7ae0), SetMultiCastSpell (0x005ab8a0), the auto-fill (0x005ab9d0), the totem item test
// (0x0051d330 → 0x007548f0), IsSpellKnown/CastSpellByID/IsCurrentSpell.

const ROWS = new Map([
  [3599, { id: 3599, name: "Опаляющий тотем", spellLevel: 10, totemSlotMask: 0x1 }],
  [6363, { id: 6363, name: "Опаляющий тотем", spellLevel: 20, totemSlotMask: 0x1 }],
  [8071, { id: 8071, name: "Тотем каменной кожи", spellLevel: 4, totemSlotMask: 0x2 }],
  [8512, { id: 8512, name: "Тотем неистовства ветра", spellLevel: 32, totemSlotMask: 0x8 }],
  [2484, { id: 2484, name: "Тотем оков земли", spellLevel: 6, totemSlotMask: 0x2 }],
  [133, { id: 133, name: "Огненный шар", spellLevel: 1, totemSlotMask: 0 }],
]);

test("lists: per slot in learning order, one per name, a higher rank in the lower one's place", () => {
  const lists = frameXmlMultiCastLists([ROWS.get(3599), ROWS.get(8071), ROWS.get(133), undefined, ROWS.get(2484),
    ROWS.get(6363), ROWS.get(8512)]);
  assert.deepEqual(lists, [[6363], [8071, 2484], [], [8512]]);
});

test("action → slot (133.. fire, earth, water, air ×3) and the totem items (21 serves every element)", () => {
  assert.deepEqual([132, 133, 134, 135, 136, 137, 141, 144, 145].map(frameXmlMultiCastActionSlot), [0, 1, 2, 3, 4, 1, 1, 4, 0]);
  assert.equal(frameXmlTotemItemServes(4, 1), true, "Тотем огня → fire");
  assert.equal(frameXmlTotemItemServes(4, 2), false);
  assert.equal(frameXmlTotemItemServes(2, 2), true, "Тотем земли → earth");
  assert.equal(frameXmlTotemItemServes(5, 3), true);
  assert.equal(frameXmlTotemItemServes(3, 4), true);
  for (let slot = 1; slot <= 4; slot++) assert.equal(frameXmlTotemItemServes(21, slot), true, "Тотем власти");
  assert.equal(frameXmlTotemItemServes(1, 1), false, "a skinning knife");
});

function world({ book = [3599, 8071, 8512], buttons = [] } = {}) {
  const sent = [];
  const learned = [];
  return {
    sent,
    knownSpells: book.map((id) => ({ id, slot: 0 })),
    actionButtons: buttons.map(([slot, action]) => ({ slot, action, type: 0 })),
    petSpells: { spells: [{ spellId: 17253, active: 0 }] },
    casts: new Map([[0x10n, { spellId: 133, channel: false }]]),
    autoRepeatSpellId: 75,
    attacking: false,
    attackRequested: false,
    state: { selfGuid: 0x10n, objects: new Map() },
    itemTemplates: new Map(),
    events: { on: (name, listener) => { learned.push(listener); return () => {}; } },
    learn(id) { this.knownSpells = [...this.knownSpells, { id, slot: 0 }]; for (const listener of learned) listener({ spellId: id }); },
    setActionButton(slot, action, type) {
      sent.push([slot, action, type]);
      this.actionButtons = this.actionButtons.filter((button) => button.slot !== slot);
      if (action !== 0) this.actionButtons.push({ slot, action, type });
    },
  };
}

function live(options = {}) {
  const fake = world(options);
  const cvars = new Map();
  const casts = [];
  const rows = new Map(ROWS);
  const model = new FrameXmlMultiCastLive({
    world: () => fake, spell: (id) => rows.get(id), castSpell: (id) => casts.push(id),
    cvar: options.cvar === false ? undefined : { get: (name) => cvars.get(name), set: (name, value) => cvars.set(name, value) },
  });
  const fired = [];
  model.attach({ fire: (name) => { fired.push(name); return 1; } });
  return { model, fake, cvars, casts, fired, rows };
}

test("auto-fill: each slot once, its first spell onto the empty buttons of the three pages; the CVar remembers", () => {
  const { fake, cvars, fired } = live({ buttons: [[136, 9999]] });
  assert.deepEqual(fired, ["UPDATE_MULTI_CAST_ACTIONBAR"]);
  assert.deepEqual(fake.sent.sort((a, b) => a[0] - b[0]), [
    [132, 3599, 0], [133, 8071, 0], [135, 8512, 0],
    [137, 8071, 0], [139, 8512, 0], [140, 3599, 0], [141, 8071, 0], [143, 8512, 0],
  ], "action 137 (slot 136, page 2 fire) was taken and stays");
  assert.equal(cvars.get("autoFilledMultiCastSlots"), String(0x1 | 0x2 | 0x8));
  fake.sent.length = 0;
  fake.learn(2484);
  assert.deepEqual(fake.sent, [], "a filled slot is not filled again");
  assert.deepEqual(fired, ["UPDATE_MULTI_CAST_ACTIONBAR", "UPDATE_MULTI_CAST_ACTIONBAR"]);
});

test("SetMultiCastSpell: the bar's actions only, the slot's spells only, 0 clears", () => {
  const { model, fake } = live({ cvar: false });
  fake.sent.length = 0;
  model.setMultiCastSpell(134, 8071);
  model.setMultiCastSpell(134, 3599);
  model.setMultiCastSpell(132, 3599);
  model.setMultiCastSpell(141, 0);
  assert.deepEqual(fake.sent, [[133, 8071, 0], [140, 0, 0]]);
});

test("a book row's metadata arriving later rebuilds the lists on the next tick and raises the event once", () => {
  const { model, rows, fired } = live({ book: [3599, 5394] });
  assert.deepEqual(model.totemSpells(3), []);
  rows.set(5394, { id: 5394, name: "Тотем исцеляющего потока", spellLevel: 20, totemSlotMask: 0x4 });
  model.tick();
  model.tick();
  assert.deepEqual(model.totemSpells(3), [5394]);
  assert.deepEqual(model.totemSpells(7), [5394], "7 folds onto water");
  assert.equal(fired.length, 2);
});

test("IsSpellKnown (book, pet), CastSpellByID (known only), IsCurrentSpell (cast, repeat, attack)", () => {
  const { model, casts, fake } = live();
  assert.equal(model.isSpellKnown(3599, false), true);
  assert.equal(model.isSpellKnown(66842, false), false);
  assert.equal(model.isSpellKnown(17253, true), true);
  model.castSpellById(3599);
  model.castSpellById(66842);
  assert.deepEqual(casts, [3599]);
  assert.equal(model.isCurrentSpell(133), true);
  assert.equal(model.isCurrentSpell(75), true);
  assert.equal(model.isCurrentSpell(6603), false);
  fake.attacking = true;
  assert.equal(model.isCurrentSpell(6603), true);
});

test("tick: a book row that never resolves does not rebuild the lists every frame (02.10 review)", () => {
  // A spell the gateway has no row for (a TSWoW id outside the table, a removed recipe) left
  // `resolved < book.length` for good, and every frame then re-mapped the book, rebuilt the four
  // lists and their signature string. Reads of `totemSlotMask` are the lists being rebuilt.
  let reads = 0;
  const counted = (row) => ({ ...row, get totemSlotMask() { reads += 1; return row.totemSlotMask; } });
  const target = world({ book: [3599, 8071, 8512, 999999] });
  const live = new FrameXmlMultiCastLive({
    world: () => target,
    spell: (id) => (ROWS.has(id) ? counted(ROWS.get(id)) : undefined),
    castSpell: () => true,
  });
  live.attach({ fire: () => 1 });
  live.tick();
  reads = 0;
  for (let frame = 0; frame < 10; frame++) live.tick();
  assert.equal(reads, 0, "nothing changed: no rebuild");
  // A row that arrives later still rebuilds once.
  ROWS.set(999999, { id: 999999, name: "Тотем", spellLevel: 1, totemSlotMask: 0x4 });
  try {
    live.tick();
    assert.ok(reads > 0, "the newly resolved row rebuilds");
    assert.deepEqual(live.totemSpells(3), [999999]);
    reads = 0;
    live.tick();
    assert.equal(reads, 0);
  } finally {
    ROWS.delete(999999);
  }
});
