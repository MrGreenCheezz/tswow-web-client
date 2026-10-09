// Plan item 2.05: BIND_ENCHANT and TRADE_POTENTIAL_BIND_ENCHANT, now that `/dbc/item-enchantments?v=2`
// carries SpellItemEnchantment.Flags (record offset 0x40, ENCHANTMENT_CAN_SOULBOUND 0x01).
// Wow.exe 12340: 0x005210d0 raises BIND_ENCHANT (event 0x189) for an enchanting effect whose row has
// the flag, on an item that is neither soulbound nor bound by an enchantment (0x00708520) and has an
// InventoryType (0x00707280); `BindEnchant` (0x00522f70) re-runs it confirmed. 0x005869a0 raises
// TRADE_POTENTIAL_BIND_ENCHANT (0x18c) as the player's own «will not be traded» slot changes.
import assert from "node:assert/strict";
import test from "node:test";

const cursor = await import("../dist/code/browser/game/SpellCursor.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { tradePotentialBindEnchant } = await import("../dist/code/browser/framexml/FrameXmlTrade.js");

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const FLAGS = UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset;
const ENCHANT_1 = UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset;
const item = (entry, flags = 0, enchants = {}) => {
  const fields = new Map([[ENTRY, entry], [FLAGS, flags]]);
  for (const [slot, id] of Object.entries(enchants)) fields.set(ENCHANT_1 + Number(slot) * 3, id);
  return { typeId: 1, guid: 0x202n, fields };
};

/** Enchantment rows: 1 binds (Flags 1), 2 does not, 3 binds. */
const FLAGS_OF = (id) => ({ 1: 1, 2: 0, 3: 1 })[id];
const NAME_OF = (id) => ({ 1: "Связующие чары", 2: "Простые чары", 3: "Старые чары" })[id];
const ENCHANT_SPELL = { effects: [53, 0, 0], effectMiscValue: [1, 0, 0] };
const PLAIN_SPELL = { effects: [53, 0, 0], effectMiscValue: [2, 0, 0] };

function world(objects = new Map()) {
  const calls = [];
  return {
    calls,
    mapId: 0,
    state: { objects },
    itemTemplates: new Map([[25, { flags: 0, inventoryType: 13 }], [4540, { flags: 0, inventoryType: 0 }]]),
    castSpellOnItem(...args) { calls.push(["castSpellOnItem", ...args]); },
    useItemOnItem(...args) { calls.push(["useItemOnItem", ...args]); return true; },
  };
}

test("a binding enchantment on an unbound equippable item asks BIND_ENCHANT and keeps the cursor", () => {
  cursor.cancelItemTarget();
  const target = item(25);
  const live = world(new Map([[0x202n, target]]));
  cursor.armItemTarget(live, 7418);
  const spells = () => ENCHANT_SPELL;
  const outcome = cursor.targetItemWithCursor(target, 0x202n, live, spells, NAME_OF, FLAGS_OF);
  assert.deepEqual(outcome, { kind: "confirm", event: "BIND_ENCHANT", oldName: "", newName: "" });
  assert.deepEqual(live.calls, [], "nothing sent before the answer");
  assert.equal(cursor.pendingItemTarget(live)?.spellId, 7418);
  // BindEnchant(): the named item takes the spell, the bind question not asked again.
  assert.equal(cursor.bindEnchantWithCursor(live, spells, NAME_OF, FLAGS_OF).kind, "sent");
  assert.deepEqual(live.calls, [["castSpellOnItem", 7418, 0x202n, 0, false]]);
  cursor.cancelItemTarget();
});

test("BindEnchant still asks REPLACE_ENCHANT when a permanent enchantment is there (0x005210d0 confirmed)", () => {
  cursor.cancelItemTarget();
  const target = item(25, 0, { 0: 2 });
  const live = world(new Map([[0x202n, target]]));
  cursor.armItemTarget(live, 7418);
  const spells = () => ENCHANT_SPELL;
  assert.equal(cursor.targetItemWithCursor(target, 0x202n, live, spells, NAME_OF, FLAGS_OF).event, "BIND_ENCHANT");
  const replace = cursor.bindEnchantWithCursor(live, spells, NAME_OF, FLAGS_OF);
  assert.deepEqual(replace, { kind: "confirm", event: "REPLACE_ENCHANT", oldName: "Простые чары", newName: "Связующие чары" });
  assert.equal(cursor.replaceEnchantWithCursor(live, spells).kind, "sent");
  assert.equal(live.calls.length, 1);
  cursor.cancelItemTarget();
});

test("no BIND_ENCHANT: soulbound, bound by an enchantment, no InventoryType, a plain enchantment, an old gateway", () => {
  const spells = () => ENCHANT_SPELL;
  const cases = [
    ["soulbound", item(25, 0x1), FLAGS_OF],
    ["an enchantment on it already binds", item(25, 0, { 1: 3 }), FLAGS_OF],
    ["not equippable", item(4540), FLAGS_OF],
    ["an old gateway: no Flags", item(25), () => undefined],
  ];
  for (const [label, target, flagsOf] of cases) {
    cursor.cancelItemTarget();
    const live = world(new Map([[0x202n, target]]));
    cursor.armItemTarget(live, 7418);
    assert.equal(cursor.targetItemWithCursor(target, 0x202n, live, spells, NAME_OF, flagsOf).kind, "sent", label);
  }
  cursor.cancelItemTarget();
  const live = world();
  cursor.armItemTarget(live, 7418);
  assert.equal(cursor.targetItemWithCursor(item(25), 0x202n, live, () => PLAIN_SPELL, NAME_OF, FLAGS_OF).kind, "sent", "plain");
  cursor.cancelItemTarget();
  assert.equal(cursor.bindEnchantWithCursor(live, spells, NAME_OF, FLAGS_OF).kind, "none", "no cursor: nothing");
  game.world = undefined;
});

test("TRADE_POTENTIAL_BIND_ENCHANT: the own seventh slot holds a bound item that is still tradeable (0x005869a0)", () => {
  const BOP_TRADEABLE = 0x100;
  const now = { total: 10_000 };
  // Soulbound, BoP-tradeable, created 30 minutes of played time ago: enchanting it would end the trade window.
  const fresh = item(25, 0x1 | BOP_TRADEABLE);
  fresh.fields.set(UPDATE_FIELDS.ITEM_FIELD_CREATE_PLAYED_TIME.offset, 10_000 - 1800);
  assert.equal(tradePotentialBindEnchant(fresh, now.total, FLAGS_OF), true);
  // The two hours are over: bound for good (0x00708b40), nothing to warn about.
  const old = item(25, 0x1 | BOP_TRADEABLE);
  old.fields.set(UPDATE_FIELDS.ITEM_FIELD_CREATE_PLAYED_TIME.offset, 10_000 - 7200);
  assert.equal(tradePotentialBindEnchant(old, now.total, FLAGS_OF), false);
  assert.equal(tradePotentialBindEnchant(item(25, 0x1), now.total, FLAGS_OF), false, "soulbound, not tradeable");
  assert.equal(tradePotentialBindEnchant(item(25, 0), now.total, FLAGS_OF), false, "not bound at all");
  assert.equal(tradePotentialBindEnchant(undefined, now.total, FLAGS_OF), false, "an empty slot");
  const enchanted = item(25, 0x1 | BOP_TRADEABLE, { 0: 3 });
  enchanted.fields.set(UPDATE_FIELDS.ITEM_FIELD_CREATE_PLAYED_TIME.offset, 10_000 - 60);
  assert.equal(tradePotentialBindEnchant(enchanted, now.total, FLAGS_OF), false, "a binding enchantment already there");
  assert.equal(tradePotentialBindEnchant(fresh, undefined, FLAGS_OF), false, "played time unknown: no warning");
});

test("the trade model raises TRADE_POTENTIAL_BIND_ENCHANT before TRADE_PLAYER_ITEM_CHANGED(7), true or false", async () => {
  const { createCannedFrameXmlTrade } = await import("../dist/code/browser/framexml/FrameXmlTradeCanned.js");
  const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  const asked = [];
  const { model, world } = createCannedFrameXmlTrade({ potentialBindEnchant: (guid) => { asked.push(guid); return true; } });
  const events = [];
  model.attach({ fire: (event, ...args) => { events.push([event, ...args]); return 1; }, now: () => 0 });
  model.owned = true;
  world.open();
  world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
  events.length = 0;
  FRAMEXML_SEAM_BINDINGS.ClickTradeButton({ trade: model }, [7]);
  assert.deepEqual(events, [["TRADE_POTENTIAL_BIND_ENCHANT", true], ["TRADE_PLAYER_ITEM_CHANGED", 7]]);
  assert.deepEqual(asked, [0x4000_0001n]);
  events.length = 0;
  FRAMEXML_SEAM_BINDINGS.ClickTradeButton({ trade: model }, [7, true]);
  assert.deepEqual(events, [["TRADE_POTENTIAL_BIND_ENCHANT", false], ["TRADE_PLAYER_ITEM_CHANGED", 7]], "cleared: false");
  events.length = 0;
  world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
  FRAMEXML_SEAM_BINDINGS.ClickTradeButton({ trade: model }, [1]);
  assert.deepEqual(events, [["TRADE_PLAYER_ITEM_CHANGED", 1]], "another slot raises nothing");
});
