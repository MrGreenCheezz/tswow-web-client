// 19.10: IsUsableAction / IsUsableSpell as Wow.exe 3.3.5a answers them (FrameXmlActionUsable.ts): the slot's spell
// passes Spell_C_IsUsableAction (0x0080b5d0) and is then short of power or not (0x008017e0); a cooldown is no gate;
// ACTIONBAR_UPDATE_USABLE is raised when a pair moves (CGActionBar::UpdateUsable 0x005aa470). The spell rows carry
// this dataset's own Spell.dbc words (1784 Stealth, 8676 Ambush, 2098 Eviscerate, 7384 Overpower, 2457 Battle Stance).
import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");

const SELF = 1n;
const TARGET = 50n;
const DAGGER = 7n;
const POWDER = 8n;

const row = (id, name, extra) => ({
  id, name, rank: "", iconPath: "", passive: false, spellLevel: 1, spellClassSet: 0, spellClassMask: [0, 0, 0],
  schoolMask: 1, powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
  effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], equippedItemClass: -1, equippedItemSubclass: 0, reagents: [],
  shapeshiftMask: [0, 0], shapeshiftExclude: [0, 0], ...extra,
});
const SPELLS = new Map([
  [133, row(133, "Огненный шар", { powerCost: 100, schoolMask: 4, attributes: [0x10000, 0, 0, 0, 0, 0, 0, 0] })],
  [1784, row(1784, "Незаметность", {
    attributes: [0x1a150010, 0x10, 0x200000, 0x4000000, 0, 0, 0, 0], effects: [6, 6, 6], effectAura: [36, 16, 33],
    effectMiscValue: [30, 0, 0], shapeshiftFormFlags: 1,
  })],
  [8676, row(8676, "Внезапный удар", {
    powerType: 3, powerCost: 60, attributes: [0x270010, 0x8000200, 0x100000, 0x400, 0, 0, 0, 0],
    equippedItemClass: 2, equippedItemSubclass: 0x8000, shapeshiftMask: [0x20000000, 0], implicitTargetA: [6, 6, 6],
  })],
  [2098, row(2098, "Потрошение", {
    powerType: 3, powerCost: 35, attributes: [0x50010, 0x100200, 0, 0x400, 0x8, 0, 0, 0],
    equippedItemClass: 2, equippedItemSubclass: 173555, implicitTargetA: [6, 1, 0],
  })],
  [7384, row(7384, "Превосходство", {
    powerType: 1, powerCost: 50, attributes: [0x250010, 0x58100200, 0, 0x400, 0x200, 0, 0x400, 0],
    shapeshiftMask: [65536, 0], implicitTargetA: [6, 6, 0],
  })],
  [2457, row(2457, "Боевая стойка", {
    effects: [6, 6, 0], effectAura: [36, 280, 0], effectMiscValue: [17, 0, 0], shapeshiftFormFlags: 7,
  })],
  [2094, row(2094, "Ослепление", { powerType: 3, powerCost: 30, reagents: [{ itemId: 5530, count: 1 }] })],
]);

function fixture() {
  const fired = [];
  const clock = { monotonic: 100_000, lua: 500 };
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1000],
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 50], // mana
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 1, 0], // rage
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 100], // energy
  ]);
  const player = { guid: SELF, typeId: 4, movementFlags: 0, fields };
  const target = { guid: TARGET, typeId: 3, movementFlags: 0, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 500]]) };
  const item = (guid, entry, count = 1) => ({ guid, typeId: 1, movementFlags: 0, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, count],
  ]) });
  const auras = new Map();
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [TARGET, target]]) },
    targetGuid: TARGET,
    knownSpells: [...SPELLS.keys()].map((id, slot) => ({ id, slot })),
    actionButtons: [133, 1784, 8676, 2098, 7384, 2094].map((action, slot) => ({ slot, action, type: ACTION_BUTTON_SPELL })),
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    itemTemplates: new Map([
      [3000, { found: true, entry: 3000, name: "Кинжал", itemClass: 2, subClass: 15, ammoType: 0, stackable: 1, spells: [] }],
      [5530, { found: true, entry: 5530, name: "Ослепляющий порошок", itemClass: 7, subClass: 0, stackable: 20, spells: [] }],
    ]),
    comboPoints: undefined,
    names: new Map(), creatureTemplates: new Map(),
    spellModifiers: new Map(),
    cooldownRemaining: (id, now) => Math.max(0, (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now),
    cooldownState: (id) => world.cooldownSnapshots.get(id),
    isActiveMountSpell: () => false,
    aurasFor: (guid) => auras.get(guid) ?? [],
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id),
    monotonic: () => clock.monotonic, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const pump = { now: () => clock.lua, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } };
  const usableEvents = () => fired.filter(([name]) => name === FRAMEXML_SEAM_EVENTS.actionUsable).length;
  const step = (ms = 120) => { clock.monotonic += ms; clock.lua += ms / 1000; seam.tick(clock.lua); };
  const setBytes = (name, byte, value) => {
    const offset = UPDATE_FIELDS[name].offset;
    const word = fields.get(offset) ?? 0;
    fields.set(offset, ((word & ~(0xff << (byte * 8))) | (value << (byte * 8))) >>> 0);
  };
  const wield = () => {
    world.state.objects.set(DAGGER, item(DAGGER, 3000));
    fields.set(UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 15 * 2, Number(DAGGER));
  };
  const carry = (count) => {
    world.state.objects.set(POWDER, item(POWDER, 5530, count));
    fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(POWDER));
  };
  return { seam, world, player, fields, auras, fired, clock, pump, usableEvents, step, setBytes, wield, carry };
}

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("19.10: short of power is notEnoughMana (blue), enough is usable, and only the change raises the event", () => {
  const f = fixture();
  f.seam.attach(f.pump);
  f.step();
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [false, true], "50 mana for a 100 mana spell: blue");
  f.fired.length = 0;
  f.step();
  assert.equal(f.usableEvents(), 0, "the same pairs are no news");
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 400);
  f.step();
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [true, false]);
  assert.equal(f.usableEvents(), 1, "ACTIONBAR_UPDATE_USABLE once on the crossing (0x005a8d30)");
  f.fired.length = 0;
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 380);
  f.step();
  assert.equal(f.usableEvents(), 0, "a power change that crosses nothing");
  // A recovering spell keeps its colour: UpdateUsableAction (0x005a9e20) has no cooldown gate.
  f.world.cooldownSnapshots.set(133, { startedAt: 100_000, duration: 60_000, endsAt: 200_000 });
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [true, false]);
  f.seam.detach();
});

test("19.10: a rogue's Ambush wants stealth and a dagger; Eviscerate wants combo points on the target", () => {
  const f = fixture();
  f.seam.attach(f.pump);
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [false, false], "not stealthed (ShapeshiftMask form 30)");
  f.setBytes("UNIT_FIELD_BYTES_2", 3, 30);
  f.setBytes("UNIT_FIELD_BYTES_1", 2, 0x02);
  f.auras.set(SELF, [{ spellId: 1784, flags: 0x7 }]);
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [false, false], "no dagger in the main hand");
  f.wield();
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [true, false]);
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 40);
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [false, true], "40 energy of 60: blue");
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 100);
  assert.deepEqual(call(f.seam, "IsUsableAction", 4), [false, false], "no combo points");
  f.world.comboPoints = { guid: 999n, points: 3 };
  assert.deepEqual(call(f.seam, "IsUsableAction", 4), [false, false], "points on another unit");
  f.world.comboPoints = { guid: TARGET, points: 3 };
  assert.deepEqual(call(f.seam, "IsUsableAction", 4), [true, false]);
  // Stealth itself: SPELL_ATTR0_CANT_USED_IN_COMBAT.
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000);
  assert.deepEqual(call(f.seam, "IsUsableAction", 2), [false, false], "in combat");
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0);
  assert.deepEqual(call(f.seam, "IsUsableAction", 2), [true, false]);
  f.seam.detach();
});

test("19.10: a stance spell wants its stance; a reagent spell its reagent, which it counts", () => {
  const f = fixture();
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 1, 1000);
  assert.deepEqual(call(f.seam, "IsUsableAction", 5), [false, false], "Overpower outside Battle Stance");
  f.setBytes("UNIT_FIELD_BYTES_2", 3, 17);
  f.auras.set(SELF, [{ spellId: 2457, flags: 0x3 }]);
  assert.deepEqual(call(f.seam, "IsUsableAction", 5), [false, false], "in stance, but the target has not dodged");
  // AttributesEx 0x100000 (REQ_COMBO_POINTS1): the realm's point for a dodge is what lights Overpower up.
  f.world.comboPoints = { guid: TARGET, points: 1 };
  assert.deepEqual(call(f.seam, "IsUsableAction", 5), [true, false]);
  assert.deepEqual(call(f.seam, "IsConsumableAction", 6), [true], "a spell with a reagent (0x005a9360)");
  assert.deepEqual(call(f.seam, "GetActionCount", 6), [0]);
  assert.deepEqual(call(f.seam, "IsUsableAction", 6), [false, false], "no Blinding Powder");
  f.carry(3);
  assert.deepEqual(call(f.seam, "GetActionCount", 6), [3], "casts the bags hold (0x007ffa30)");
  assert.deepEqual(call(f.seam, "IsUsableAction", 6), [true, false]);
  assert.deepEqual(call(f.seam, "IsConsumableAction", 1), [false]);
});

test("19.10: the dead cast nothing, and IsUsableSpell answers a book name with 1 / nil", () => {
  const f = fixture();
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 400);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Огненный шар"), [1, undefined]);
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 10);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Огненный шар"), [undefined, 1]);
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [false, false]);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Огненный шар"), [undefined, undefined]);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Нет такого"), [undefined, undefined]);
});
