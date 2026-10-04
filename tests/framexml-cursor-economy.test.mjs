// Review of lane L1 (03.10; items 3.23, 1.10, 5.24): which ordinary stock-UI gestures may now sell, buy,
// trade, feed or wrap. Each row is a gesture as the stock Lua makes it (MerchantFrame.lua:380-410,
// MerchantFrame.xml:794-805 OnMouseUp/OnReceiveDrag, ContainerFrame.lua:693-736, PaperDollFrame.lua:1232-1247,
// SecureTemplates.lua:402-415) and the economic packets it may send. Wow.exe 12340: 0x005853a0
// (PickupMerchantItem), 0x005d7ff0 / 0x005e85d0 (PickupContainerItem / PickupInventoryItem with a
// merchant row held), 0x0051bdd0 (DropItemOnUnit), 0x0080dcf0 (feeding).
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
const drop = await import("../dist/code/browser/framexml/FrameXmlDropItemOnUnit.js");

const ECONOMIC = Object.freeze({
  SELL: OPCODES.CMSG_SELL_ITEM, BUY: OPCODES.CMSG_BUY_ITEM, BUY_IN_SLOT: OPCODES.CMSG_BUY_ITEM_IN_SLOT,
  BUYBACK: OPCODES.CMSG_BUYBACK_ITEM, INITIATE_TRADE: OPCODES.CMSG_INITIATE_TRADE, TRADE_ITEM: OPCODES.CMSG_SET_TRADE_ITEM,
  CAST: OPCODES.CMSG_CAST_SPELL, USE: OPCODES.CMSG_USE_ITEM, WRAP: OPCODES.CMSG_WRAP_ITEM, DESTROY: OPCODES.CMSG_DESTROYITEM,
});
const NAME_OF = new Map(Object.entries(ECONOMIC).map(([name, opcode]) => [opcode, name]));

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const FRIEND = 0x11n;
const NPC = 0xf130_0000_0000_0077n;
const PET = 0xf140_0000_0000_0021n;
const STRANGER_PET = 0xf140_0000_0000_0022n;
const VENDOR = 0xf130_0000_0000_0042n;
const OTHER_VENDOR = 0xf130_0000_0000_0043n;
const BREAD = 0x4000_0000_0000_0801n;
const RING = 0x4000_0000_0000_0802n;
const BAG = 0x4000_0000_0000_0803n;
const FEED_PET = 6991;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

const object = (guid, typeId, entries = []) => ({
  guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries),
});

const row = (slot, itemId) => ({ slot, itemId, displayId: 0, leftInStock: -1, price: 10, maxDurability: 0, buyCount: 1, extendedCost: 0 });

function fixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8)]]);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), BREAD);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 2, RING);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 19 * 2, BAG);
  state.objects.set(PLAYER, { ...object(PLAYER, 4), fields });
  state.objects.set(FRIEND, object(FRIEND, 4));
  state.objects.set(NPC, object(NPC, 3));
  const pet = object(PET, 3, [[offset("UNIT_FIELD_PETNUMBER"), 7]]);
  setGuid(pet.fields, offset("UNIT_FIELD_CREATEDBY"), PLAYER);
  state.objects.set(PET, pet);
  const strangerPet = object(STRANGER_PET, 3, [[offset("UNIT_FIELD_PETNUMBER"), 8]]);
  setGuid(strangerPet.fields, offset("UNIT_FIELD_CREATEDBY"), FRIEND);
  state.objects.set(STRANGER_PET, strangerPet);
  state.objects.set(BREAD, object(BREAD, 1, [[offset("OBJECT_FIELD_ENTRY"), 4540], [offset("ITEM_FIELD_STACK_COUNT"), 5]]));
  state.objects.set(RING, object(RING, 1, [[offset("OBJECT_FIELD_ENTRY"), 1076]]));
  state.objects.set(BAG, object(BAG, 2, [[offset("OBJECT_FIELD_ENTRY"), 4496], [offset("CONTAINER_FIELD_NUM_SLOTS"), 4]]));
  state.selfGuid = PLAYER;
  const template = (entry, name, inventoryType) => ({
    entry, found: true, name, quality: 1, itemClass: 0, subClass: 0, flags: 0, inventoryType, bonding: 0,
    stackable: 20, bagFamily: 0, spells: [], itemLevel: 5, requiredLevel: 1, containerSlots: 0, maxDurability: 0,
    pageText: 0, startQuest: 0,
  });
  world.itemTemplates.set(4540, template(4540, "Твердый хлеб", 0));
  world.itemTemplates.set(1076, template(1076, "Кольцо", 11));
  world.knownSpells = [{ id: FEED_PET }];
  world.petSpells = { guid: PET, closed: false, creatureFamily: 1, duration: 0, reactState: 1, commandState: 1, flags: 0, bar: [], spells: [], cooldowns: [] };
  world.vendor = { guid: VENDOR, items: [row(1, 159), row(2, 4540)] };
  world.targetGuid = FRIEND;
  /** The economic packets sent so far, by name. */
  const economic = () => sent.filter((packet) => NAME_OF.has(packet.opcode)).map((packet) => NAME_OF.get(packet.opcode));
  return { world, sent, economic };
}

function withSeam(run) {
  const setup = fixture();
  const previous = game.world;
  game.world = setup.world;
  game.spells.set(FEED_PET, { id: FEED_PET, requiredTargetMode: 2, effects: [101, 0, 0], effectMiscValue: [0, 0, 0] });
  const seam = new LiveWorldSeam({
    world: () => setup.world, store: () => new WorldStore(setup.world.state), spell: () => undefined,
    monotonic: () => 1_000_000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    seam.attach({ now: () => 100, fire() { return 1; } });
    setup.sent.length = 0;
    drop.resetFrameXmlDropItemThrottle();
    return run({ ...setup, seam, call });
  } finally {
    seam.detach();
    cursor.cancelItemTarget();
    game.spells.delete(FEED_PET);
    game.world = previous;
  }
}

/** Each gesture, as the stock Lua calls the C API, and the economic packets it may send. */
const GESTURES = [
  // ---- a merchant row ----------------------------------------------------------------------------
  ["a plain left click on a merchant row picks it up (MerchantItemButton_OnClick → PickupMerchantItem)",
    ({ call }) => { call("PickupMerchantItem", 1); }, []],
  ["the same row clicked again puts it back", ({ call }) => { call("PickupMerchantItem", 1); call("PickupMerchantItem", 1); }, []],
  ["a held row released over the merchant frame (OnMouseUp → PickupMerchantItem(0))",
    ({ call }) => { call("PickupMerchantItem", 1); call("PickupMerchantItem", 0); }, []],
  ["a held row let go by Escape or a world click (ClearCursor)",
    ({ call }) => { call("PickupMerchantItem", 2); call("ClearCursor"); }, []],
  ["a held row dropped on an action button (PlaceAction, PickupAction)",
    ({ call }) => { call("PickupMerchantItem", 2); call("PlaceAction", 1); call("PickupAction", 2); call("ClearCursor"); }, []],
  ["a held row over a unit button (DropItemOnUnit: only a bag item counts)",
    ({ call }) => { call("PickupMerchantItem", 2); for (const unit of ["player", "target", "pet"]) call("DropItemOnUnit", unit); call("ClearCursor"); }, []],
  ["a held row, the merchant closes, a bag slot is clicked: the row stays, nothing is bought",
    ({ call, world }) => { call("PickupMerchantItem", 1); world.vendor = undefined; call("PickupContainerItem", 0, 3); call("PickupInventoryItem", 11); }, []],
  ["a row held from one merchant is not bought at another whose row at that index is another item",
    ({ call, world }) => {
      call("PickupMerchantItem", 1);
      world.vendor = { guid: OTHER_VENDOR, items: [row(1, 999), row(2, 4540)] };
      call("PickupContainerItem", 0, 3);
      call("PickupMerchantItem", 1);
      world.vendor = { guid: VENDOR, items: [row(1, 31337), row(2, 4540)] };
      call("PickupInventoryItem", 11);
    }, []],
  // ---- a bag item ---------------------------------------------------------------------------------
  ["a bag item picked up and put back", ({ call }) => { call("PickupContainerItem", 0, 1); call("PickupContainerItem", 0, 1); }, []],
  ["a bag item moved to an empty bag slot", ({ call }) => { call("PickupContainerItem", 0, 1); call("PickupContainerItem", 0, 3); }, []],
  ["a bag item held and let go (ClearCursor)", ({ call }) => { call("PickupContainerItem", 0, 1); call("ClearCursor"); }, []],
  ["a bag item held over the merchant frame with no merchant open",
    ({ call, world }) => { world.vendor = undefined; call("PickupContainerItem", 0, 1); call("PickupMerchantItem", 0); }, []],
  ["a split part held over the merchant frame stays held",
    ({ call }) => { call("SplitContainerItem", 0, 1, 2); call("PickupMerchantItem", 0); call("PickupMerchantItem", 1); call("ClearCursor"); }, []],
  ["a bag item clicked onto an NPC's or someone else's pet's unit button",
    ({ call, world }) => {
      call("PickupContainerItem", 0, 1);
      world.targetGuid = NPC;
      call("DropItemOnUnit", "target");
      world.targetGuid = STRANGER_PET;
      call("DropItemOnUnit", "target");
      call("ClearCursor");
    }, []],
  ["nothing held, a unit button clicked", ({ call }) => { for (const unit of ["player", "target", "pet"]) call("DropItemOnUnit", unit); }, []],
  ["the buyback tab's OnReceiveDrag (BuybackItem(0)) with nothing bought back", ({ call }) => { call("BuybackItem", 0); }, []],
  // ---- the deliberate ones, unchanged or as Wow.exe ---------------------------------------------------
  ["a right click on a merchant row buys it (BuyMerchantItem)", ({ call }) => { call("BuyMerchantItem", 1); }, ["BUY"]],
  ["a right click on a bag item at the merchant sells it (UseContainerItem)", ({ call }) => { call("UseContainerItem", 0, 1); }, ["SELL"]],
  ["a held row dropped on an empty bag slot buys it there (0x005d7ff0)",
    ({ call }) => { call("PickupMerchantItem", 2); call("PickupContainerItem", 0, 3); }, ["BUY_IN_SLOT"]],
  ["a bag item dropped on the merchant frame is sold (0x005853a0)",
    ({ call }) => { call("PickupContainerItem", 0, 1); call("PickupMerchantItem", 0); }, ["SELL"]],
  ["food clicked onto the own pet's portrait feeds it (0x0051bdd0 → 0x0080dcf0)",
    ({ call }) => { call("PickupContainerItem", 0, 1); call("DropItemOnUnit", "pet"); }, ["CAST"]],
];

for (const [name, gesture, expected] of GESTURES) {
  test(`economy: ${name}`, () => {
    withSeam((setup) => {
      gesture(setup);
      assert.deepEqual(setup.economic(), expected);
    });
  });
}

// L1 lifted WorldClient's refusal of a carried bag as an item target (CarriedItems.ts): Wow.exe's walk
// lets the bag slots 19..22 through for SpellTargetItem (0x00753a50, flag 0x2 of 0x247) and the realm
// finds them (Player::GetItemByGuid, Player.cpp:10095-10124); the realm's own checks decide the spell.
test("SpellTargetItem naming a carried bag sends the waiting spell at the bag itself", () => {
  const DISENCHANT = 13262;
  withSeam(({ call, world, sent }) => {
    world.knownSpells = [{ id: DISENCHANT }];
    world.itemTemplates.set(4496, {
      entry: 4496, found: true, name: "Маленькая сумка", quality: 1, itemClass: 1, subClass: 0, flags: 0, inventoryType: 18,
      bonding: 0, stackable: 1, bagFamily: 0, spells: [], itemLevel: 5, requiredLevel: 1, containerSlots: 4, maxDurability: 0,
      pageText: 0, startQuest: 0,
    });
    game.spells.set(DISENCHANT, { id: DISENCHANT, requiredTargetMode: 2, effects: [99, 0, 0], effectMiscValue: [0, 0, 0] });
    try {
      cursor.armItemTarget(world, DISENCHANT);
      call("SpellTargetItem", "маленькая");
      const casts = sent.filter((packet) => packet.opcode === OPCODES.CMSG_CAST_SPELL);
      assert.equal(casts.length, 1, "the bag is a target the realm judges");
      const reader = new PacketReader(Uint8Array.from(casts[0].payload));
      reader.u8();
      assert.equal(reader.u32(), DISENCHANT);
      reader.u8();
      assert.equal(reader.u32(), 0x10, "TARGET_FLAG_ITEM");
      assert.equal(reader.packedGuid(), BAG, "the bag itself");
      assert.equal(cursor.pendingItemTarget(), undefined, "the cursor went with the send");
    } finally {
      game.spells.delete(DISENCHANT);
    }
  });
});

// A question (BIND_ENCHANT, END_REFUND, END_BOUND_TRADEABLE, REPLACE_ENCHANT) is about the spell pending
// when it was asked. Wow.exe raises ACTIONBAR_UPDATE_STATE + CURRENT_SPELL_CAST_CHANGED (0x0053b480) on
// every arm of a pending spell (0x0080cce0), and UIParent hides those popups on it (UIParent.lua:773-779),
// so another spell armed meanwhile can never take the answer. Here a second arm while one was up raised
// nothing and kept the asked item: the popup's OK then sent the new spell — a Disenchant — at it.
test("a question asked for one pending spell is not answered with another spell armed since", () => {
  const SCROLL = 27_000;
  const DISENCHANT = 13262;
  const SWORD = 0x4000_0000_0000_0a01n;
  const sword = object(SWORD, 1, [[offset("OBJECT_FIELD_ENTRY"), 2000], [offset("ITEM_FIELD_ENCHANTMENT_1_1"), 900]]);
  const casts = [];
  const world = {
    mapId: 0, state: { selfGuid: PLAYER, objects: new Map([[SWORD, sword]]) }, itemTemplates: new Map(),
    castSpellOnItem(spellId, guid) { casts.push([spellId, guid]); },
  };
  const spells = (id) => ({
    [SCROLL]: { effects: [53, 0, 0], effectMiscValue: [1000, 0, 0] },
    [DISENCHANT]: { effects: [99, 0, 0], effectMiscValue: [0, 0, 0] },
  })[id];
  const names = (id) => ({ 900: "Старые чары", 1000: "Новые чары" })[id];
  const edges = [];
  const stop = cursor.observeItemTarget((armed) => edges.push(armed));
  try {
    cursor.armItemTarget(world, SCROLL);
    const asked = cursor.targetItemWithCursor(sword, SWORD, world, spells, names, () => undefined);
    assert.equal(asked.kind, "confirm");
    assert.equal(asked.event, "REPLACE_ENCHANT");
    cursor.armItemTarget(world, DISENCHANT);
    assert.deepEqual(edges, [true, true], "the second arm is an edge too: the stock popup is hidden");
    assert.equal(cursor.replaceEnchantWithCursor(world, spells).kind, "none", "the old question's OK does nothing");
    assert.equal(cursor.bindEnchantWithCursor(world, spells, names, () => undefined).kind, "none");
    assert.deepEqual(casts, [], "the sword is not disenchanted");
    assert.equal(cursor.pendingItemTarget(world)?.spellId, DISENCHANT, "the new spell keeps waiting for its item");
  } finally {
    stop();
    cursor.cancelItemTarget();
  }
});
