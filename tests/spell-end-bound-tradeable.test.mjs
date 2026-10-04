// Plan items 2.05 and 3.22 (lane L1, 03.10): END_BOUND_TRADEABLE / EndBoundTradeable, the pending
// spell's CURRENT_SPELL_CAST_CHANGED, and the currency-token slots of SpellTargetItem's walk.
// Wow.exe 12340 (`.runtime/re-2026-10-03/l1-item-cursor/`): 0x005210d0 raises event 0x28d with
// "itemenchant" for an enchanting spell over a soulbound item still in its two-hour trade window
// (0x00708520 && !0x00709550; ENCHANT_ITEM_TEMPORARY only with a binding enchantment row);
// EndBoundTradeable (0x005233d0) compares the kind with _strnicmp (0x0076e780): "itemenchant" re-runs
// 0x005210d0 answered, "gem" → 0x005c4ff0 (AcceptSockets). 0x0053b480 (ACTIONBAR_UPDATE_STATE then
// CURRENT_SPELL_CAST_CHANGED) runs as the pending spell is armed (0x0080cce0), sent (0x0080ac90 →
// 0x00805330) and dropped (0x00809e30 → 0x00806200 → 0x008054f0). The walk 0x007546f0 (flags 0x247,
// order table 0x00a37b14) visits the currency tokens 118–149 after the keyring, before the worn items.
import assert from "node:assert/strict";
import test from "node:test";

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const cursor = await import("../dist/code/browser/game/SpellCursor.js");
const bound = await import("../dist/code/browser/game/BoundTradeable.js");
const { currencyTokenSlots: frameXmlCurrencyTokenSlots } = await import("../dist/code/browser/CarriedItems.js");
const { findSpellTargetItem } = await import("../dist/code/browser/framexml/FrameXmlItemTargeting.js");
const { playerInventory } = await import("../dist/code/browser/Inventory.js");
const { frameXmlEndBoundTradeable, frameXmlObservePendingSpells } = await import("../dist/code/browser/framexml/FrameXmlBoundTradeable.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const OTHER_PLAYER = 0x11n;
const SCROLL = 0x4000_0000_0000_0501n;
const SWORD = 0x4000_0000_0000_0502n;
const TOKEN = 0x4000_0000_0000_0503n;
const KEY = 0x4000_0000_0000_0504n;
const TRINKET = 0x4000_0000_0000_0505n;
const SCROLL_ENTRY = 38925;
const SWORD_ENTRY = 50050;
const TOKEN_ENTRY = 40752;
const KEY_ENTRY = 6893;
const TRINKET_ENTRY = 50051;
const SCROLL_SPELL = 27984;
const PLAYED = 10_000;
const SOULBOUND = 0x1;
const BOP_TRADEABLE = 0x100;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

function object(guid, typeId, entries) {
  return { guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries) };
}

/** A soulbound, BoP-tradeable item owned by `owner`, created `age` played seconds ago. */
function tradeableItem(guid, entry, { flags = SOULBOUND | BOP_TRADEABLE, owner = PLAYER, age = 600, enchants = {} } = {}) {
  const item = object(guid, 1, [[offset("OBJECT_FIELD_ENTRY"), entry], [offset("ITEM_FIELD_FLAGS"), flags],
    [offset("ITEM_FIELD_CREATE_PLAYED_TIME"), PLAYED - age]]);
  setGuid(item.fields, offset("ITEM_FIELD_OWNER"), owner);
  for (const [slot, id] of Object.entries(enchants)) item.fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1") + Number(slot) * 3, id);
  return item;
}

function template(entry, name, extra = {}) {
  return {
    entry, found: true, name, quality: 1, itemClass: 0, subClass: 0, flags: 0, inventoryType: 0,
    bonding: 0, stackable: 1, bagFamily: 0, spells: [], itemLevel: 10, requiredLevel: 1, containerSlots: 0,
    maxDurability: 0, pageText: 0, startQuest: 0, ...extra,
  };
}

/** An enchanting scroll in backpack slot 1, a BoP-tradeable sword in slot 2, a token, a key, a trinket. */
function fixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8)]]);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), SCROLL);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 2, SWORD);
  setGuid(fields, offset("PLAYER_FIELD_CURRENCYTOKEN_SLOT_1") + 2 * 2, TOKEN); // the third token slot, 120
  setGuid(fields, offset("PLAYER_FIELD_KEYRING_SLOT_1"), KEY);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 12 * 2, TRINKET);
  state.objects.set(PLAYER, { ...object(PLAYER, 4, []), fields });
  state.objects.set(SCROLL, object(SCROLL, 1, [[offset("OBJECT_FIELD_ENTRY"), SCROLL_ENTRY]]));
  state.objects.set(SWORD, tradeableItem(SWORD, SWORD_ENTRY));
  state.objects.set(TOKEN, object(TOKEN, 1, [[offset("OBJECT_FIELD_ENTRY"), TOKEN_ENTRY], [offset("ITEM_FIELD_STACK_COUNT"), 7]]));
  state.objects.set(KEY, object(KEY, 1, [[offset("OBJECT_FIELD_ENTRY"), KEY_ENTRY]]));
  state.objects.set(TRINKET, object(TRINKET, 1, [[offset("OBJECT_FIELD_ENTRY"), TRINKET_ENTRY]]));
  state.selfGuid = PLAYER;
  world.itemTemplates.set(SCROLL_ENTRY, template(SCROLL_ENTRY, "Свиток чар", {
    spells: [{ spellId: SCROLL_SPELL, trigger: 0, charges: -1, cooldown: -1, category: 0, categoryCooldown: -1 }],
  }));
  world.itemTemplates.set(SWORD_ENTRY, template(SWORD_ENTRY, "Меч", { inventoryType: 13, itemClass: 2 }));
  world.itemTemplates.set(TOKEN_ENTRY, template(TOKEN_ENTRY, "Эмблема героизма"));
  world.itemTemplates.set(KEY_ENTRY, template(KEY_ENTRY, "Ключ стража"));
  world.itemTemplates.set(TRINKET_ENTRY, template(TRINKET_ENTRY, "Эмблема мастера", { inventoryType: 12 }));
  world.playedTime = { total: PLAYED, atLevel: 0 };
  world.playedTimeReceivedAt = performance.now();
  const packets = (opcode) => sent.filter((packet) => packet.opcode === opcode);
  return { world, state, sent, packets };
}

function withSeam(run) {
  const setup = fixture();
  const previous = game.world;
  game.world = setup.world;
  game.spells.set(SCROLL_SPELL, { id: SCROLL_SPELL, requiredTargetMode: 2, effects: [53, 0, 0], effectMiscValue: [1000, 0, 0] });
  const seam = new LiveWorldSeam({
    world: () => setup.world, store: () => new WorldStore(setup.world.state), spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const events = [];
  const pump = { events, now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 1; } };
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    seam.attach(pump);
    run({ ...setup, seam, events, call });
    seam.detach();
  } finally {
    cursor.cancelItemTarget();
    game.spells.delete(SCROLL_SPELL);
    game.world = previous;
  }
}

/** The target guid of a CMSG_USE_ITEM payload. */
function useTarget(payload) {
  const reader = new PacketReader(Uint8Array.from(payload));
  reader.u8(); reader.u8(); reader.u8(); reader.u32(); reader.u64(); reader.u32(); reader.u8();
  const mask = reader.u32();
  return { mask, guid: reader.packedGuid() };
}

const named = (events, name) => events.filter(([event]) => event === name);

test("the trade window: soulbound + BOP_TRADEABLE, owned by the player, created under 7200 played seconds ago (!0x00708b40)", () => {
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1), PLAYED, PLAYER), true);
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1, { age: 7199 }), PLAYED, PLAYER), true, "one second left");
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1, { age: 7200 }), PLAYED, PLAYER), false, "≤ −7200: bound for good");
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1, { flags: SOULBOUND }), PLAYED, PLAYER), false, "no 0x100");
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1, { flags: BOP_TRADEABLE }), PLAYED, PLAYER), false, "not soulbound");
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1, { owner: OTHER_PLAYER }), PLAYED, PLAYER), false, "another owner");
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1), undefined, PLAYER), false, "played time unknown");
  assert.equal(bound.itemStillBopTradeable(tradeableItem(1n, 1), PLAYED, undefined), false, "player unknown");
});

test("0x005210d0's END_BOUND_TRADEABLE test: permanent enchantments ask, a temporary one only when it binds", () => {
  const flagsOf = (id) => ({ 1: 1, 2: 0 })[id];
  const ask = (effects, misc, item, played = PLAYED, flags = flagsOf) =>
    bound.enchantEndsBoundTrade(effects, misc, item, played, PLAYER, flags);
  const item = tradeableItem(1n, 1);
  assert.equal(ask([53, 0, 0], [2, 0, 0], item), true, "ENCHANT_ITEM");
  assert.equal(ask([156, 0, 0], [2, 0, 0], item), true, "ENCHANT_ITEM_PRISMATIC");
  assert.equal(ask([0, 53, 0], [0, 2, 0], item), true, "the first enchanting effect, wherever it is");
  assert.equal(ask([54, 0, 0], [1, 0, 0], item), true, "a temporary enchantment that binds");
  assert.equal(ask([54, 0, 0], [2, 0, 0], item), false, "a temporary enchantment that does not bind");
  assert.equal(ask([54, 0, 0], [7, 0, 0], item), false, "a temporary enchantment with an unknown row");
  assert.equal(ask([99, 0, 0], [0, 0, 0], item), false, "no enchanting effect");
  assert.equal(ask([53, 0, 0], [2, 0, 0], tradeableItem(1n, 1, { enchants: { 1: 1 } })), false, "bound by an enchantment (0x007073e0)");
  assert.equal(ask([53, 0, 0], [2, 0, 0], tradeableItem(1n, 1, { enchants: { 0: 2 } })), true, "a plain enchantment on it");
  assert.equal(ask([53, 0, 0], [2, 0, 0], tradeableItem(1n, 1, { enchants: { 0: 9 } })), false, "an enchantment whose flags are unknown");
  assert.equal(ask([53, 0, 0], [2, 0, 0], tradeableItem(1n, 1, { age: 8000 })), false, "the window is over");
  assert.equal(bound.enchantEndsBoundTrade([53, 0, 0], [2, 0, 0], item, undefined, PLAYER, flagsOf), false, "played time unknown");
  assert.equal(ask([53, 0, 0], [2, 0, 0], undefined), false, "no item");
});

test("the cursor asks END_BOUND_TRADEABLE after END_REFUND, sends nothing, and BindEnchant's re-run sends", () => {
  cursor.cancelItemTarget();
  const sword = tradeableItem(SWORD, SWORD_ENTRY);
  const calls = [];
  const live = {
    mapId: 0, state: { objects: new Map([[SWORD, sword]]), selfGuid: PLAYER },
    itemTemplates: new Map([[SWORD_ENTRY, { flags: 0, inventoryType: 13 }]]),
    playedSecondsNow: () => PLAYED,
    castSpellOnItem(...args) { calls.push(args); },
  };
  const spells = () => ({ effects: [53, 0, 0], effectMiscValue: [2, 0, 0] });
  const names = () => undefined;
  const flags = (id) => ({ 2: 0 })[id];
  cursor.armItemTarget(live, 7418);
  assert.deepEqual(cursor.targetItemWithCursor(sword, SWORD, live, spells, names, flags),
    { kind: "confirm", event: "END_BOUND_TRADEABLE", oldName: "", newName: "" });
  assert.deepEqual(calls, [], "nothing before the answer");
  assert.equal(cursor.pendingItemTarget(live)?.spellId, 7418, "the spell still waits");
  assert.equal(cursor.bindEnchantWithCursor(live, spells, names, flags).kind, "sent", "EndBoundTradeable(\"itemenchant\")");
  assert.deepEqual(calls, [[7418, SWORD, 0, false]]);
  // A refundable purchase asks END_REFUND first; its answer skips this question too (param 3 = 1).
  cursor.armItemTarget(live, 7418);
  live.itemRefunds = { info: new Map([[SWORD, { purchasedAtPlayed: PLAYED - 60 }]]) };
  assert.equal(cursor.targetItemWithCursor(sword, SWORD, live, spells, names, flags).event, "END_REFUND");
  assert.equal(cursor.bindEnchantWithCursor(live, spells, names, flags).kind, "sent");
  assert.equal(calls.length, 2);
  cursor.cancelItemTarget();
});

test("through the stock seam: END_BOUND_TRADEABLE(\"itemenchant\"), then EndBoundTradeable sends the scroll on the sword", () => {
  withSeam(({ call, events, packets }) => {
    call("UseContainerItem", 0, 1);
    assert.deepEqual(call("SpellCanTargetItem"), [1]);
    events.length = 0;
    call("UseContainerItem", 0, 2);
    assert.deepEqual(named(events, "END_BOUND_TRADEABLE"), [["END_BOUND_TRADEABLE", "itemenchant"]]);
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 0, "nothing before the answer");
    call("EndBoundTradeable", "gem");
    call("EndBoundTradeable", "spellenchant");
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 0, "the other kinds do not answer this question");
    call("EndBoundTradeable", "ItemEnchant");
    const uses = packets(OPCODES.CMSG_USE_ITEM);
    assert.equal(uses.length, 1, "case-blind (0x0076e780 → _strnicmp)");
    assert.deepEqual(useTarget(uses[0].payload), { mask: 0x10, guid: SWORD });
    assert.deepEqual(call("SpellCanTargetItem"), [false]);
  });
});

test("EndBoundTradeable(\"gem\") is AcceptSockets (0x005c4ff0); anything else answers nothing", () => {
  const log = [];
  const seam = { bindEnchant: () => log.push("bind"), socket: { accept: () => log.push("sockets") } };
  frameXmlEndBoundTradeable(seam, "GEM");
  frameXmlEndBoundTradeable(seam, "itemenchant");
  frameXmlEndBoundTradeable(seam, "spellenchant");
  frameXmlEndBoundTradeable(seam, "itemenchants");
  frameXmlEndBoundTradeable(seam, 3);
  frameXmlEndBoundTradeable(seam, undefined);
  assert.deepEqual(log, ["sockets", "bind"]);
});

test("the pending spell raises ACTIONBAR_UPDATE_STATE then CURRENT_SPELL_CAST_CHANGED when armed, sent and dropped", () => {
  withSeam(({ call, events }) => {
    const pair = ["ACTIONBAR_UPDATE_STATE", "CURRENT_SPELL_CAST_CHANGED"];
    const castChanges = () => events.filter(([event]) => pair.includes(event)).map(([event]) => event);
    events.length = 0;
    call("UseContainerItem", 0, 1);
    assert.deepEqual(castChanges(), pair, "armed (0x0080cce0)");
    events.length = 0;
    cursor.cancelItemTarget();
    assert.deepEqual(castChanges(), pair, "dropped (0x008054f0)");
    events.length = 0;
    cursor.cancelItemTarget();
    assert.deepEqual(castChanges(), [], "nothing up: no edge");
    call("UseContainerItem", 0, 1);
    events.length = 0;
    call("PickupInventoryItem", 13);
    assert.deepEqual(castChanges(), pair, "sent (0x0080ac90 → 0x00805330)");
  });
});

test("the observer: each source edge raises the pair once; detached, nothing", () => {
  const fired = [];
  const listeners = [];
  const source = (observer) => { listeners.push(observer); return () => listeners.splice(listeners.indexOf(observer), 1); };
  let pump = { fire: (event) => { fired.push(event); return 1; } };
  const stop = frameXmlObservePendingSpells(() => pump, [source, source]);
  listeners[0](true);
  listeners[1](false);
  assert.deepEqual(fired, ["ACTIONBAR_UPDATE_STATE", "CURRENT_SPELL_CAST_CHANGED", "ACTIONBAR_UPDATE_STATE", "CURRENT_SPELL_CAST_CHANGED"]);
  pump = undefined;
  listeners[0](true);
  assert.equal(fired.length, 4);
  stop();
  assert.equal(listeners.length, 0);
});

test("SpellTargetItem's walk: the keyring, then the currency tokens 118–149, then the worn items", () => {
  const { state, world } = fixture();
  const slots = frameXmlCurrencyTokenSlots(state);
  assert.equal(slots.length, 32);
  assert.deepEqual([slots[0].bag, slots[0].slot, slots[0].guid], [255, 118, 0n]);
  assert.deepEqual([slots[2].bag, slots[2].slot, slots[2].guid, slots[2].item?.guid], [255, 120, TOKEN, TOKEN]);
  assert.deepEqual([slots[31].slot, slots[31].guid, slots[31].item], [149, 0n, undefined]);
  const nameOf = (entry) => world.itemTemplates.get(entry)?.name;
  const inventory = playerInventory(state);
  assert.equal(findSpellTargetItem(inventory, "эмблема", nameOf, slots)?.guid, TOKEN, "the token before the worn trinket");
  assert.equal(findSpellTargetItem(inventory, "эмблема", nameOf)?.guid, TRINKET, "without the tokens: the trinket");
  assert.equal(findSpellTargetItem(inventory, TOKEN_ENTRY, nameOf, slots)?.guid, TOKEN, "by entry");
  world.itemTemplates.set(KEY_ENTRY, template(KEY_ENTRY, "Эмблема-ключ"));
  assert.equal(findSpellTargetItem(inventory, "эмблема", nameOf, slots)?.guid, KEY, "the keyring before the tokens");
  assert.deepEqual(frameXmlCurrencyTokenSlots(undefined), []);
});

test("through the stock seam SpellTargetItem reaches a currency token and a key; the realm takes both (GetItemByGuid)", () => {
  withSeam(({ call, packets, world }) => {
    call("UseContainerItem", 0, 1);
    call("SpellTargetItem", "Эмблема героизма");
    const uses = packets(OPCODES.CMSG_USE_ITEM);
    assert.equal(uses.length, 1);
    assert.equal(useTarget(uses[0].payload).guid, TOKEN);
    call("UseContainerItem", 0, 1);
    call("SpellTargetItem", "ключ стража");
    assert.equal(useTarget(packets(OPCODES.CMSG_USE_ITEM)[1].payload).guid, KEY, "the keyring");
    // A book spell (CMSG_CAST_SPELL) on a token too.
    world.knownSpells = [{ id: 13262 }];
    cursor.armItemTarget(world, 13262);
    call("SpellTargetItem", TOKEN_ENTRY);
    assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 1);
  });
});
