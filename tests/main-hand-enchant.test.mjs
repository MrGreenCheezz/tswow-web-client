// 05.10-2.05: the SPELL_ATTR0_TARGET_MAINHAND_ITEM weapon pick (game/MainHandEnchant.ts, Wow.exe
// 0x0080c790): which worn weapon a shaman imbue or a fishing lure goes on without the item cursor,
// and the END_BOUND_TRADEABLE("spellenchant") question.
import assert from "node:assert/strict";
import test from "node:test";

const pick = await import("../dist/code/browser/game/MainHandEnchant.js");
const cursor = await import("../dist/code/browser/game/SpellCursor.js");
const ground = await import("../dist/code/browser/game/GroundTarget.js");
const bound = await import("../dist/code/browser/framexml/FrameXmlBoundTradeable.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const globalStrings = await import("../dist/code/generated/globalStrings.js");

const F = (name) => UPDATE_FIELDS[name].offset;
const SELF = 0x10n;
const MH = 0x4001n;
const OH = 0x4002n;
const FLAMETONGUE = 8024; // effect 54, misc 5, class 2, mask 173555
const MISC = 5;
const WEAPON_MASK = 173555; // axes, maces, swords, staves, fist, daggers … (Spell.dbc 8024)

function item(guid, { entry = 1, temp = 0, left = 0, flags = 0, created = 0 } = {}) {
  return {
    guid, typeId: 1,
    fields: new Map([
      [F("OBJECT_FIELD_ENTRY"), entry],
      [F("ITEM_FIELD_OWNER"), Number(SELF)], [F("ITEM_FIELD_OWNER") + 1, 0],
      [F("ITEM_FIELD_FLAGS"), flags],
      [F("ITEM_FIELD_CREATE_PLAYED_TIME"), created],
      [F("ITEM_FIELD_ENCHANTMENT_1_1") + 3, temp],
      [F("ITEM_FIELD_ENCHANTMENT_1_1") + 4, left],
    ]),
  };
}

/** A world with the player wearing `main` in slot 15 and `off` in slot 16. */
function world(main, off, extra = {}) {
  const calls = [];
  const head = F("PLAYER_FIELD_INV_SLOT_HEAD");
  const player = { guid: SELF, typeId: 4, fields: new Map() };
  const objects = new Map([[SELF, player]]);
  for (const [slot, worn] of [[15, main], [16, off]]) {
    if (!worn) continue;
    player.fields.set(head + slot * 2, Number(worn.guid));
    player.fields.set(head + slot * 2 + 1, 0);
    objects.set(worn.guid, worn);
  }
  return {
    calls, mapId: 0,
    state: { selfGuid: SELF, objects },
    itemTemplates: new Map([
      [1, { itemClass: 2, subClass: 7 }], // a one-handed sword
      [2, { itemClass: 4, subClass: 6 }], // a shield
      [3, { itemClass: 2, subClass: 20 }], // a fishing pole
    ]),
    playedSecondsNow: () => 1000,
    // What the cast guard (SpellCastGuard.ts) reads before the cursor or the pick.
    knownSpells: [{ id: 8024 }],
    cooldownRemaining: () => 0,
    onSpellStatus() {},
    castSpellOnItem(...args) { calls.push(["castSpellOnItem", ...args]); },
    useItemOnItem(...args) { calls.push(["useItemOnItem", ...args]); return true; },
    ...extra,
  };
}

const imbue = (overrides = {}) => ({
  attributes: [0x200, 0, 0, 0, 0, 0, 0, 0], effects: [54, 0, 0], effectMiscValue: [MISC, 0, 0],
  equippedItemClass: 2, equippedItemSubclass: WEAPON_MASK, requiredTargetMode: cursor.ITEM_TARGET_MODE,
  recoveryTime: 0, categoryRecoveryTime: 0, ...overrides,
});

function reset() {
  cursor.cancelItemTarget();
  ground.cancelGroundTarget();
  pick.answerSpellEnchant(undefined);
  game.world = undefined;
  game.spells.clear();
}

const target = (main, off, spell = imbue()) => pick.mainHandEnchantTarget(world(main, off), spell)?.guid;

test("the ladder: main hand alone or bare, else a bare off hand, else the one carrying this enchant", () => {
  assert.equal(target(item(MH), undefined), MH);
  assert.equal(target(undefined, item(OH)), OH);
  assert.equal(target(item(MH, { temp: 99 }), undefined), MH, "a lone main hand is picked whatever it carries");
  assert.equal(target(item(MH), item(OH, { temp: 99 })), MH);
  assert.equal(target(item(MH, { temp: 99 }), item(OH)), OH);
  assert.equal(target(item(MH, { temp: MISC }), item(OH, { temp: 99 })), MH);
  assert.equal(target(item(MH, { temp: 99 }), item(OH, { temp: MISC })), OH);
  assert.equal(target(item(MH, { temp: 99 }), item(OH, { temp: 98 })), undefined, "both imbued with something else: the cursor");
  assert.equal(target(undefined, undefined), undefined);
});

test("both carrying this enchant: the one with less time left, the main hand on a tie (0x0080ca6d: off hand read first)", () => {
  assert.equal(target(item(MH, { temp: MISC, left: 500 }), item(OH, { temp: MISC, left: 900 })), MH);
  assert.equal(target(item(MH, { temp: MISC, left: 900 }), item(OH, { temp: MISC, left: 500 })), OH);
  assert.equal(target(item(MH, { temp: MISC, left: 700 }), item(OH, { temp: MISC, left: 700 })), MH);
});

test("the class and subclass mask drops a shield; mask 0 keeps anything; no attribute, no pick", () => {
  assert.equal(target(item(MH, { temp: 99 }), item(OH, { entry: 2 })), MH, "the shield is not a candidate");
  assert.equal(target(item(MH, { entry: 2 }), item(OH, { entry: 2 })), undefined);
  assert.equal(target(item(MH, { entry: 3 }), undefined), undefined, "a weapon whose subclass bit is not in the mask (a pole for an imbue)");
  assert.equal(target(item(MH, { entry: 3 }), undefined, imbue({ equippedItemSubclass: 1 << 20 })), MH, "the same pole for a lure");
  assert.equal(target(item(MH, { entry: 2 }), undefined, imbue({ equippedItemSubclass: 0 })), MH);
  assert.equal(target(item(MH, { entry: 77 }), undefined), undefined, "an unknown template with the mask set: no pick");
  assert.equal(target(item(MH), undefined, imbue({ attributes: [0, 0, 0, 0, 0, 0, 0, 0] })), undefined);
  assert.equal(target(item(MH), undefined, imbue({ attributes: undefined })), undefined, "an old gateway: the cursor as before");
  assert.equal(target(item(MH), undefined, imbue({ effects: [53, 0, 0] })), undefined);
  // 8017: the enchant is the second effect, its own misc value counts.
  assert.equal(target(item(MH, { temp: 7 }), item(OH, { temp: 99 }),
    imbue({ effects: [0, 54, 0], effectMiscValue: [MISC, 7, 0] })), MH);
});

test("a book imbue goes on the picked weapon with no cursor; no pick raises the cursor", () => {
  reset();
  const live = world(item(MH, { temp: 99 }), item(OH));
  game.world = live;
  game.spells.set(FLAMETONGUE, { ...imbue(), id: FLAMETONGUE, passive: false, hidden: false, startRecoveryTime: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0 });
  let sent = 0;
  ground.requestSpellCast(FLAMETONGUE, () => { sent++; });
  assert.deepEqual(live.calls, [["castSpellOnItem", FLAMETONGUE, OH, 0, false]]);
  assert.equal(sent, 0);
  assert.equal(cursor.pendingItemTarget(), undefined, "no cursor");
  const none = world(item(MH, { temp: 99 }), item(OH, { temp: 98 }));
  game.world = none;
  ground.requestSpellCast(FLAMETONGUE, () => { sent++; });
  assert.deepEqual(none.calls, []);
  assert.equal(cursor.pendingItemTarget()?.spellId, FLAMETONGUE, "both imbued otherwise: the cursor");
  reset();
});

// 05.10 review: 0x0080cce0 after 0x0080c790 answers no pick — an 0x200 spell with nothing in slot 15
// fails with SPELL_FAILED_MAINHAND_EMPTY (0x32) instead of raising the cursor (bytes 0x0080d6xx, d3.c:1102).
test("no pick and an empty main hand: SPELL_FAILED_MAINHAND_EMPTY, no cursor; a worn main hand keeps the cursor", () => {
  reset();
  const said = [];
  const status = { onSpellStatus: (text, error) => { said.push([text, error]); } };
  const { globalString } = globalStrings;
  const empty = world(undefined, undefined, status);
  game.world = empty;
  game.spells.set(FLAMETONGUE, { ...imbue(), id: FLAMETONGUE, passive: false, hidden: false, startRecoveryTime: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0 });
  let sent = 0;
  ground.requestSpellCast(FLAMETONGUE, () => { sent++; });
  assert.equal(sent, 0);
  assert.equal(cursor.pendingItemTarget(), undefined, "no cursor");
  assert.deepEqual(said, [[globalString("SPELL_FAILED_MAINHAND_EMPTY"), true]]);
  assert.deepEqual(empty.calls, []);
  // The off hand alone, but a shield the mask drops: no pick, slot 15 empty — the same refusal.
  said.length = 0;
  assert.equal(pick.castOnMainHandWeapon(world(undefined, item(OH, { entry: 2 }), status), FLAMETONGUE, undefined, imbue()), true);
  assert.equal(said.length, 1);
  // A worn main hand with no pick (both imbued otherwise): the cursor's turn, nothing said.
  said.length = 0;
  assert.equal(pick.castOnMainHandWeapon(world(item(MH, { temp: 99 }), item(OH, { temp: 98 }), status), FLAMETONGUE, undefined, imbue()), false);
  // No 0x200 (a poison) or an old gateway without attributes: the cursor as before.
  assert.equal(pick.castOnMainHandWeapon(world(undefined, undefined, status), 2823, undefined, imbue({ attributes: [0x10010, 0, 0, 0, 0, 0, 0, 0] })), false);
  assert.equal(pick.castOnMainHandWeapon(world(undefined, undefined, status), FLAMETONGUE, undefined, imbue({ attributes: undefined })), false);
  assert.equal(said.length, 0);
  reset();
});

test("a lure item goes out as CMSG_USE_ITEM on the fishing pole", () => {
  reset();
  const live = world(item(MH, { entry: 3 }), undefined);
  game.world = live;
  const templates = new Map([[6529, { spells: [{ spellId: 8087, trigger: 0 }] }]]);
  const spells = new Map([[8087, imbue({ equippedItemSubclass: 1 << 20 })]]);
  game.spells.set(8087, spells.get(8087));
  ground.requestItemUse({ bag: 255, slot: 24, guid: 0x777n, entry: 6529 }, () => assert.fail("no targetless use"), templates, spells);
  assert.deepEqual(live.calls, [["useItemOnItem", 255, 24, 0x777n, 8087, MH]]);
  assert.equal(cursor.pendingItemTarget(), undefined);
  reset();
});

test("a weapon still in its trade window asks «spellenchant»; EndBoundTradeable answers it", () => {
  reset();
  const fresh = item(MH, { flags: 0x101, created: 0 }); // soulbound + BOP_TRADEABLE, 1000 s played
  const live = world(fresh, undefined);
  game.world = live;
  game.spells.set(FLAMETONGUE, imbue());
  let asked = 0;
  const stop = pick.observeSpellEnchantQuestion(() => { asked++; });
  try {
    assert.equal(pick.castOnMainHandWeapon(live, FLAMETONGUE), true);
    assert.equal(asked, 1);
    assert.deepEqual(live.calls, [], "nothing sent before the answer");
    bound.frameXmlEndBoundTradeable({}, "SpellEnchant");
    assert.deepEqual(live.calls, [["castSpellOnItem", FLAMETONGUE, MH, 0, false]]);
    assert.equal(asked, 1, "the answered re-run does not ask again");
    bound.frameXmlEndBoundTradeable({}, "spellenchant");
    assert.equal(live.calls.length, 1, "nothing stored: nothing");
    // An answer whose re-run finds no weapon (it was taken off) forgets the question all the same.
    pick.castOnMainHandWeapon(live, FLAMETONGUE);
    assert.equal(asked, 2);
    live.state.objects.delete(MH);
    bound.frameXmlEndBoundTradeable({}, "spellenchant");
    live.state.objects.set(MH, fresh);
    bound.frameXmlEndBoundTradeable({}, "spellenchant");
    assert.equal(live.calls.length, 1, "nothing sent by a later answer");
    // Past the window (created − played ≤ −7200) it is bound for good: no question.
    const old = world(item(MH, { flags: 0x101, created: -7000 }), undefined, { playedSecondsNow: () => 200 });
    pick.castOnMainHandWeapon(old, FLAMETONGUE, undefined, imbue());
    assert.equal(asked, 2);
    assert.equal(old.calls.length, 1);
  } finally {
    stop();
  }
  // Nobody to show the question (the native interface): the spell goes out.
  const native = world(item(MH, { flags: 0x101, created: 0 }), undefined);
  pick.castOnMainHandWeapon(native, FLAMETONGUE, undefined, imbue());
  assert.equal(native.calls.length, 1);
  reset();
});
