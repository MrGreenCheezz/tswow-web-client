// Plan item 2.05 (mechanism M3) through the stock seam: a poison from the bag raises the item-target
// cursor, the paper doll's click sends one targeted CMSG_USE_ITEM, and the C functions around it
// (SpellCanTargetItem, SpellTargetItem, ClickTargetTradeButton, PickupContainerItem) act in the
// client's order (Wow.exe 0x005d8650, 0x005d7ff0, 0x005e85d0, 0x008007e0, 0x00586c80).
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
const ground = await import("../dist/code/browser/game/GroundTarget.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const POISON = 0x4000_0000_0000_0301n;
const LINEN = 0x4000_0000_0000_0302n;
const BLADE = 0x4000_0000_0000_0303n;
const POISON_ENTRY = 2892;
const LINEN_ENTRY = 2589;
const BLADE_ENTRY = 2489;
const POISON_SPELL = 2823;
const DISENCHANT = 13262;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

function template(entry, name, extra = {}) {
  return {
    entry, found: true, name, quality: 1, itemClass: 0, subClass: 0, flags: 0, inventoryType: 0,
    bonding: 0, stackable: 20, bagFamily: 0, spells: [], itemLevel: 10, requiredLevel: 1, containerSlots: 0,
    maxDurability: 0, pageText: 0, startQuest: 0, ...extra,
  };
}

/** A rogue with a poison in backpack slot 1, linen in slot 2 and a blade in the main hand (paper doll 16). */
function fixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (4 << 8)]]);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), POISON);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 2, LINEN);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 15 * 2, BLADE);
  const object = (guid, typeId, entries) => ({
    guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries),
  });
  state.objects.set(PLAYER, { ...object(PLAYER, 4, []), fields });
  state.objects.set(POISON, object(POISON, 1, [[offset("OBJECT_FIELD_ENTRY"), POISON_ENTRY], [offset("ITEM_FIELD_STACK_COUNT"), 5]]));
  state.objects.set(LINEN, object(LINEN, 1, [[offset("OBJECT_FIELD_ENTRY"), LINEN_ENTRY], [offset("ITEM_FIELD_STACK_COUNT"), 3]]));
  state.objects.set(BLADE, object(BLADE, 1, [[offset("OBJECT_FIELD_ENTRY"), BLADE_ENTRY]]));
  state.selfGuid = PLAYER;
  world.itemTemplates.set(POISON_ENTRY, template(POISON_ENTRY, "Быстродействующий яд", {
    spells: [{ spellId: POISON_SPELL, trigger: 0, charges: -1, cooldown: -1, category: 0, categoryCooldown: -1 }],
  }));
  world.itemTemplates.set(LINEN_ENTRY, template(LINEN_ENTRY, "Льняная ткань"));
  world.itemTemplates.set(BLADE_ENTRY, template(BLADE_ENTRY, "Клинок", { inventoryType: 13, itemClass: 2 }));
  world.knownSpells = [{ id: DISENCHANT }];
  const packets = (opcode) => sent.filter((packet) => packet.opcode === opcode);
  return { world, state, sent, packets };
}

function pumpAt() {
  const events = [];
  return { events, now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 1; } };
}

function seamOf(world) {
  return new LiveWorldSeam({
    world: () => world,
    store: () => new WorldStore(world.state),
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
}

/** The targets tail of a CMSG_USE_ITEM payload: [mask, guid]. */
function useTarget(payload) {
  const reader = new PacketReader(Uint8Array.from(payload));
  const header = [reader.u8(), reader.u8(), reader.u8(), reader.u32(), reader.u64(), reader.u32(), reader.u8()];
  const mask = reader.u32();
  const guid = reader.packedGuid();
  reader.assertFinished();
  return { bag: header[0], slot: header[1], item: header[4], mask, guid };
}

function withSeam(run) {
  const setup = fixture();
  const previous = game.world;
  game.world = setup.world;
  game.spells.set(POISON_SPELL, { id: POISON_SPELL, requiredTargetMode: 2 });
  game.spells.set(DISENCHANT, {
    id: DISENCHANT, requiredTargetMode: 2, effects: [99, 0, 0], passive: false, hidden: false,
    startRecoveryTime: 0, powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
  });
  const seam = seamOf(setup.world);
  const pump = pumpAt();
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    seam.attach(pump);
    run({ ...setup, seam, pump, call });
    seam.detach();
  } finally {
    cursor.cancelItemTarget();
    ground.cancelGroundTarget();
    game.spells.delete(POISON_SPELL);
    game.spells.delete(DISENCHANT);
    game.world = previous;
  }
}

test("a poison from the bag waits for its item; the paper doll's click sends one targeted use", () => {
  withSeam(({ call, packets }) => {
    assert.deepEqual(call("SpellCanTargetItem"), [false], "nothing waits yet");
    call("UseContainerItem", 0, 1);
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 0, "no targetless use of a poison");
    assert.deepEqual(call("SpellCanTargetItem"), [1]);
    call("PickupInventoryItem", 16);
    const uses = packets(OPCODES.CMSG_USE_ITEM);
    assert.equal(uses.length, 1);
    assert.deepEqual(useTarget(uses[0].payload), { bag: 255, slot: 23, item: POISON, mask: 0x10, guid: BLADE });
    assert.deepEqual(call("SpellCanTargetItem"), [false], "the cursor went with the send");
    call("PickupInventoryItem", 16);
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 1, "the next click is an ordinary one");
    call("ClearCursor");
  });
});

test("a bag click with the cursor up targets that item before any other route", () => {
  withSeam(({ call, packets, seam }) => {
    call("UseContainerItem", 0, 1);
    call("UseContainerItem", 0, 2);
    const uses = packets(OPCODES.CMSG_USE_ITEM);
    assert.equal(uses.length, 1);
    assert.equal(useTarget(uses[0].payload).guid, LINEN, "the realm judges linen, not the client");
    assert.equal(seam.cursorHasItem(), false);
  });
});

test("UseInventoryItem on the paper doll targets the worn item too (0x005e8a60)", () => {
  withSeam(({ call, packets }) => {
    call("UseContainerItem", 0, 1);
    call("UseInventoryItem", 16);
    const uses = packets(OPCODES.CMSG_USE_ITEM);
    assert.equal(uses.length, 1);
    assert.equal(useTarget(uses[0].payload).guid, BLADE);
  });
});

test("PickupContainerItem with an empty hand drops the cursor and lifts the item, sending nothing", () => {
  withSeam(({ call, packets, seam }) => {
    call("UseContainerItem", 0, 1);
    call("PickupContainerItem", 0, 2);
    assert.deepEqual(call("SpellCanTargetItem"), [false]);
    assert.equal(seam.cursorHasItem(), true);
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 0);
    call("ClearCursor");
  });
});

test("SpellTargetItem names a carried item by link, id or name; nothing without the cursor", () => {
  withSeam(({ call, packets }) => {
    call("SpellTargetItem", `|cffffffff|Hitem:${BLADE_ENTRY}:0:0:0:0:0:0:0:80|h[Клинок]|h|r`);
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 0, "no cursor: nothing");
    call("UseContainerItem", 0, 1);
    call("SpellTargetItem", `|cffffffff|Hitem:${BLADE_ENTRY}:0:0:0:0:0:0:0:80|h[Клинок]|h|r`);
    call("UseContainerItem", 0, 1);
    call("SpellTargetItem", "льняная ткань");
    call("UseContainerItem", 0, 1);
    call("SpellTargetItem", BLADE_ENTRY);
    call("UseContainerItem", 0, 1);
    call("SpellTargetItem", "нет такого");
    const targets = packets(OPCODES.CMSG_USE_ITEM).map((packet) => useTarget(packet.payload).guid);
    assert.deepEqual(targets, [BLADE, LINEN, BLADE]);
    assert.deepEqual(call("SpellCanTargetItem"), [1], "an unknown name leaves the cursor up");
    assert.deepEqual(call("SpellTargetUnit", "target"), [], "a unit is not an item: nothing");
    assert.deepEqual(call("SpellCanTargetUnit", "target"), []);
    assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 0);
  });
});

test("a book spell on an item is CMSG_CAST_SPELL; on the trade's seventh slot it is TRADE_ITEM 6", () => {
  withSeam(({ call, packets, world }) => {
    cursor.armItemTarget(world, DISENCHANT);
    call("PickupInventoryItem", 16);
    const casts = packets(OPCODES.CMSG_CAST_SPELL);
    assert.equal(casts.length, 1);
    const reader = new PacketReader(Uint8Array.from(casts[0].payload));
    reader.u8();
    assert.equal(reader.u32(), DISENCHANT);
    reader.u8();
    assert.equal(reader.u32(), 0x10);
    assert.equal(reader.packedGuid(), BLADE);
    // The trade's seventh slot, with a trade open.
    cursor.armItemTarget(world, DISENCHANT);
    call("ClickTargetTradeButton", 7);
    assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 1, "no trade: nothing");
    world.tradeOpen = true;
    call("ClickTargetTradeButton", 3);
    assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 1, "only the seventh slot");
    call("ClickTargetTradeButton", 7);
    const trade = packets(OPCODES.CMSG_CAST_SPELL)[1];
    assert.deepEqual(trade.payload.slice(5), [0, 0x00, 0x10, 0x00, 0x00, 0x01, 0x06]);
    world.tradeOpen = false;
  });
});

test("an item's own spell is refused on the trade slot with the core's message and no packet", () => {
  withSeam(({ call, packets, world, pump }) => {
    world.tradeOpen = true;
    call("UseContainerItem", 0, 1);
    call("ClickTargetTradeButton", 7);
    assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length + packets(OPCODES.CMSG_USE_ITEM).length, 0);
    assert.equal(pump.events.filter(([event]) => event === "UI_ERROR_MESSAGE").length, 1);
    world.tradeOpen = false;
  });
});

test("ShowRepairCursor waits while a spell or item waits for an item (0x00584a60 asks 0x007fd620)", () => {
  const live = { mapId: 0 };
  const previous = game.world;
  game.world = live;
  let shown = 0;
  const seam = { repair: { showRepairCursor() { shown += 1; return true; } }, cursor: { clear() {} } };
  try {
    cursor.armItemTarget(live, DISENCHANT);
    FRAMEXML_SEAM_BINDINGS.ShowRepairCursor(seam, []);
    assert.equal(shown, 0, "not while the item cursor is up");
    cursor.cancelItemTarget();
    FRAMEXML_SEAM_BINDINGS.ShowRepairCursor(seam, []);
    assert.equal(shown, 1);
  } finally {
    cursor.cancelItemTarget();
    game.world = previous;
  }
});

// ---- review of 2.05 (30.09): the client's click order and questions -----------------------------

const { itemEnchantments } = await import("../dist/code/browser/ItemEnchantments.js");

test("a locked bag item is nobody's target: the lock is asked before the stock enchant (0x005d8650)", () => {
  withSeam(({ call, seam }) => {
    const targeted = [];
    seam.tradeSkill.targetItem = (guid) => { targeted.push(guid); return true; };
    seam.trade.offered = (guid) => guid === LINEN;
    call("UseContainerItem", 0, 2);
    assert.deepEqual(targeted, [], "the trade holds the linen: no enchant goes on it");
    call("UseContainerItem", 0, 1);
    assert.deepEqual(targeted, [POISON], "an unlocked item is the enchant's");
  });
});

test("UseContainerItem drops a waiting glyph before the item goes on (0x00809a60)", () => {
  withSeam(({ call, seam }) => {
    let dropped = 0;
    seam.glyphs.cancelTargeting = () => { dropped += 1; return true; };
    call("UseContainerItem", 0, 2);
    assert.equal(dropped, 1);
  });
});

test("UseInventoryItem: the stock enchant takes a worn item, the repair cursor repairs, a merchant buys nothing", () => {
  withSeam(({ call, seam, world, packets }) => {
    const targeted = [];
    seam.tradeSkill.targetItem = (guid) => { targeted.push(guid); return targeted.length === 1; };
    call("UseInventoryItem", 16);
    assert.deepEqual(targeted, [BLADE], "the waiting enchant goes on the blade (0x005e8a60 → 0x005210d0)");
    let repaired = 0;
    seam.repair.clickItem = () => { repaired += 1; return true; };
    call("UseInventoryItem", 16);
    assert.equal(repaired, 1, "the repair cursor repairs the worn item");
    seam.repair.clickItem = () => false;
    world.vendor = { guid: 0x600n, items: [] };
    call("UseInventoryItem", 16);
    assert.equal(packets(OPCODES.CMSG_SELL_ITEM).length, 0, "Item::Use (0x00708c20) has no sell branch");
    world.vendor = undefined;
  });
});

test("SpellTargetItem walks the bags before the paper doll, matches a name prefix and passes broken items over", () => {
  withSeam(({ call, packets, world, state }) => {
    // The linen stack becomes a second «Клинок» in the backpack.
    state.objects.get(LINEN).fields.set(offset("OBJECT_FIELD_ENTRY"), BLADE_ENTRY);
    const casts = () => packets(OPCODES.CMSG_CAST_SPELL).map((packet) => {
      const reader = new PacketReader(Uint8Array.from(packet.payload));
      reader.u8(); reader.u32(); reader.u8(); reader.u32();
      return reader.packedGuid();
    });
    cursor.armItemTarget(world, DISENCHANT);
    call("SpellTargetItem", BLADE_ENTRY);
    cursor.armItemTarget(world, DISENCHANT);
    call("SpellTargetItem", "клин");
    cursor.armItemTarget(world, DISENCHANT);
    call("SpellTargetItem", String(BLADE_ENTRY));
    state.objects.get(LINEN).fields.set(offset("ITEM_FIELD_MAXDURABILITY"), 50);
    state.objects.get(LINEN).fields.set(offset("ITEM_FIELD_DURABILITY"), 0);
    cursor.armItemTarget(world, DISENCHANT);
    call("SpellTargetItem", "Клин");
    assert.deepEqual(casts(), [LINEN, LINEN, LINEN, BLADE]);
  });
});

function withEnchantNames(run) {
  const previous = game.gatewayOrigin;
  game.gatewayOrigin = "http://enchant-names.test";
  const table = itemEnchantments(game.gatewayOrigin);
  table.enchantments.set(22, { id: 22, name: "Старый яд", gemItemId: 0, conditionId: 0, visual: 0 });
  table.enchantments.set(7, { id: 7, name: "Новый яд", gemItemId: 0, conditionId: 0, visual: 0 });
  table.ready = true;
  try { run(); } finally { game.gatewayOrigin = previous; }
}

test("a poison over another asks REPLACE_ENCHANT first; ReplaceEnchant sends it (0x005210d0, 0x005167a0)", () => {
  withEnchantNames(() => withSeam(({ call, packets, pump, state }) => {
    game.spells.set(POISON_SPELL, { id: POISON_SPELL, requiredTargetMode: 2, effects: [54, 0, 0], effectMiscValue: [7, 0, 0] });
    state.objects.get(BLADE).fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1") + 3, 22);
    call("UseContainerItem", 0, 1);
    pump.events.length = 0;
    call("PickupInventoryItem", 16);
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 0, "nothing before the answer");
    assert.deepEqual(pump.events.filter(([event]) => event === "REPLACE_ENCHANT"), [["REPLACE_ENCHANT", "Старый яд", "Новый яд"]]);
    assert.deepEqual(call("SpellCanTargetItem"), [1], "the poison still waits");
    call("ReplaceEnchant");
    const uses = packets(OPCODES.CMSG_USE_ITEM);
    assert.equal(uses.length, 1);
    assert.equal(useTarget(uses[0].payload).guid, BLADE);
    // Without an enchantment in the temporary slot nothing is asked.
    state.objects.get(BLADE).fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1") + 3, 0);
    call("UseContainerItem", 0, 1);
    call("PickupInventoryItem", 16);
    assert.equal(packets(OPCODES.CMSG_USE_ITEM).length, 2);
  }));
});

test("the trade slot asks TRADE_REPLACE_ENCHANT over an enchanted item; the stock enchant takes slot 7 first", () => {
  withEnchantNames(() => withSeam(({ call, packets, pump, world, seam }) => {
    const ENCHANT = 7418;
    game.spells.set(ENCHANT, { id: ENCHANT, requiredTargetMode: 2, effects: [53, 0, 0], effectMiscValue: [7, 0, 0],
      recoveryTime: 0, categoryRecoveryTime: 0 });
    world.knownSpells = [{ id: ENCHANT }];
    world.tradeOpen = true;
    world.theirOffer = { traderData: true, money: 0, spellId: 0, items: [{ slot: 6, enchantId: 22 }] };
    try {
      cursor.armItemTarget(world, ENCHANT);
      call("ClickTargetTradeButton", 7);
      assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 0);
      assert.deepEqual(pump.events.filter(([event]) => event === "TRADE_REPLACE_ENCHANT"),
        [["TRADE_REPLACE_ENCHANT", "Старый яд", "Новый яд"]]);
      call("ReplaceTradeEnchant");
      assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 1, "the answer sends it (0x00510b80 → 0x0080c5f0)");
      // A waiting stock enchant is the pending spell slot 7 takes.
      let traded = 0;
      seam.tradeSkill.targetTradeSlot = () => { traded += 1; return true; };
      cursor.armItemTarget(world, ENCHANT);
      call("ClickTargetTradeButton", 7);
      assert.equal(traded, 1);
      assert.equal(packets(OPCODES.CMSG_CAST_SPELL).length, 1);
    } finally {
      game.spells.delete(ENCHANT);
      world.tradeOpen = false;
    }
  }));
});

test("one pending spell: the item-target cursor going up drops a waiting enchant and glyph", () => {
  withSeam(({ seam, world }) => {
    const dropped = [];
    seam.tradeSkill.cancelTargeting = () => { dropped.push("enchant"); return true; };
    seam.glyphs.cancelTargeting = () => { dropped.push("glyph"); return true; };
    cursor.armItemTarget(world, DISENCHANT);
    assert.deepEqual(dropped, ["enchant", "glyph"]);
  });
});

test("the native repair session also waits while the item-target cursor is up (browser/Repair.ts)", async () => {
  const { repair } = await import("../dist/code/browser/Repair.js");
  const VENDOR = 0x600n;
  const live = {
    mapId: 0, vendor: { guid: VENDOR, items: [] },
    state: { selfGuid: undefined, objects: new Map([[VENDOR, { guid: VENDOR, typeId: 3, fields: new Map([[offset("UNIT_NPC_FLAGS"), 0x1000]]) }]]) },
  };
  const previous = game.world;
  game.world = live;
  try {
    cursor.armItemTarget(live, DISENCHANT);
    assert.equal(repair.show(), false, "ShowRepairCursor does nothing while a spell is pending (0x00584a60)");
    cursor.cancelItemTarget();
    assert.equal(repair.show(), true);
  } finally {
    repair.hide();
    cursor.cancelItemTarget();
    game.world = previous;
  }
});
