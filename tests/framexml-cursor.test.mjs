import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-cursor.test.mjs
{
// The one FrameXML cursor (FrameXmlCursor.ts): spells from the book, actions lifted off a bar, bag
// items and items by id placed on a bar through CMSG_SET_ACTION_BUTTON, the stock swap, the grid
// events ActionButton.lua counts, and GetActionInfo. Canned and live seams, no client data.
const { CannedWorldSeam, CANNED_ACTION_BAR } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { createFrameXmlMemoryMacroStore } = await import("../dist/code/browser/framexml/FrameXmlMacro.js");
const { ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function pump() {
  const events = [];
  return { events, now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 0; } };
}

function canned() {
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  const events = pump();
  seam.attach(events);
  events.events.length = 0;
  return { seam, events: events.events };
}

const names = (events) => events.map(([event]) => event)
  .filter((event) => event === "CURSOR_UPDATE" || event.startsWith("ACTIONBAR_SHOWGRID")
    || event.startsWith("ACTIONBAR_HIDEGRID") || event === "ACTIONBAR_SLOT_CHANGED");

test("a spell from the book goes on a bar slot; what was there comes up on the cursor", async () => {
  const { seam, events } = canned();
  call(seam, "PickupSpell", 3, "spell");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 3, "spell"], "stock shape: slot and book type");
  assert.deepEqual(call(seam, "CursorHasSpell"), [true]);
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);
  await settle();
  assert.deepEqual(names(events), ["CURSOR_UPDATE", "ACTIONBAR_SHOWGRID"]);
  events.length = 0;

  call(seam, "PlaceAction", 12);
  assert.deepEqual(call(seam, "GetActionInfo", 12), ["spell", 3, "spell", 7384], "slot 12 holds the book's third spell");
  assert.deepEqual(call(seam, "GetActionTexture", 12), ["Interface\\Icons\\Ability_MeleeDamage"]);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 11, "spell"], "Глухая оборона came up: the swap");
  await settle();
  assert.deepEqual(events.filter(([event]) => event === "ACTIONBAR_SLOT_CHANGED"), [["ACTIONBAR_SLOT_CHANGED", 12]]);
  assert.equal(events.some(([event]) => event.includes("GRID")), false, "still holding: the grid stays up");
  events.length = 0;

  call(seam, "ClearCursor");
  assert.deepEqual(call(seam, "GetCursorInfo"), []);
  await settle();
  assert.deepEqual(names(events), ["CURSOR_UPDATE", "ACTIONBAR_HIDEGRID"]);
  // The book did not lose the spell that left the bar, and a cast from it still works.
  assert.deepEqual(call(seam, "GetSpellName", 11, "spell"), ["Глухая оборона", ""]);
  call(seam, "CastSpell", 11, "spell");
  assert.deepEqual(seam.castSpellIds, [871]);
});

test("PickupAction lifts and empties the slot; dropping it back, or a press with it held, places it", async () => {
  const { seam } = canned();
  call(seam, "PickupAction", 1);
  assert.deepEqual(call(seam, "HasAction", 1), [false], "the slot was emptied");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 1, "spell"]);
  // UseAction is what a click on an action button reaches (SECURE_ACTIONS.action): it places.
  call(seam, "UseAction", 2, "", "LeftButton");
  assert.deepEqual(call(seam, "GetActionInfo", 2), ["spell", 1, "spell", 78]);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 2, "spell"], "Кровопускание came up");
  assert.deepEqual(seam.castSpellIds, [], "nothing was cast by the press");
  call(seam, "PlaceAction", 1);
  assert.deepEqual(call(seam, "GetActionInfo", 1), ["spell", 2, "spell", 772]);
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "an empty slot gives nothing back");
  // Dropping an action onto the slot that already holds it: nothing moves, the hand is empty.
  call(seam, "PickupSpell", 2, "spell");
  call(seam, "PlaceAction", 1);
  assert.deepEqual(call(seam, "GetActionInfo", 1), ["spell", 2, "spell", 772]);
  assert.deepEqual(call(seam, "GetCursorInfo"), []);
  // With nothing held the press is the button's own.
  call(seam, "UseAction", 1);
  assert.deepEqual(seam.castSpellIds, []);
  assert.equal(call(seam, "GetActionCooldown", 1)[2], 1, "the canned press started its cooldown");
});

test("an item by id or link goes on a bar as an item action; a pet action never does", async () => {
  const { seam } = canned();
  call(seam, "PickupItem", "|cffffffff|Hitem:13446:0:0:0:0:0:0:0:0|h[Зелье]|h|r");
  assert.deepEqual(call(seam, "GetCursorInfo").slice(0, 2), ["item", 13446]);
  assert.deepEqual(call(seam, "CursorHasItem"), [true]);
  call(seam, "PlaceAction", 20);
  assert.deepEqual(call(seam, "GetActionInfo", 20), ["item", 13446]);
  assert.deepEqual(call(seam, "GetActionTexture", 20), ["Interface\\Icons\\INV_Potion_54"]);
  assert.deepEqual(call(seam, "GetCursorInfo"), []);
  call(seam, "PickupPetAction", 3);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["petaction", 3]);
  call(seam, "PlaceAction", 21);
  assert.deepEqual(call(seam, "HasAction", 21), [false], "the main bars refuse a pet action");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["petaction", 3], "and it stays held");
  call(seam, "PickupPetAction", 3);
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "the pet bar's second pickup is the drop");
});

test("the cursor picture follows what is held, across holders", () => {
  const { seam } = canned();
  const pictures = [];
  seam.cursor.onPicture((texture) => pictures.push(texture));
  call(seam, "PickupSpell", 1, "spell");
  call(seam, "PickupMacro", 1);
  call(seam, "ClearCursor");
  assert.deepEqual(pictures, ["Interface\\Icons\\Ability_Rogue_Ambush", "Interface\\Icons\\Ability_Warrior_Charge", undefined]);
});

function live({ spells = new Map() } = {}) {
  const sent = [];
  const handlers = new Map();
  const casts = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    knownSpells: [...spells.keys()].map((id, slot) => ({ id, slot })),
    actionButtons: [{ slot: 0, action: 133, type: ACTION_BUTTON_SPELL }],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    setActionButton(slot, action, type) {
      sent.push([slot, action, type]);
      world.actionButtons = [...world.actionButtons.filter((button) => button.slot !== slot),
        ...(action === 0 ? [] : [{ slot, action, type }])];
    },
    events: { on(name, handler) { handlers.set(name, handler); return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spells.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
    macroStore: createFrameXmlMemoryMacroStore([{ index: 2, name: "Танец", body: "/dance" }]),
    itemTexture: (entry) => entry === 13446 ? "Interface\\Icons\\INV_Potion_54" : undefined,
    spellTabs: () => [["Общий", "", 0, spells.size, 0, spells.size]],
    spellTabFor: (id) => spells.has(id) ? 1 : undefined,
  });
  return { seam, world, sent, handlers, casts };
}

const spell = (id, name, extra = {}) => [id, {
  id, name, rank: "", iconPath: `Interface\\Icons\\S${id}`, passive: false, hidden: false, ...extra,
}];

test("live: a bag item placed on a bar sends its entry as an item action and stays in its bag", async () => {
  const { seam, world, sent } = live();
  const events = pump();
  seam.attach(events);
  const player = world.state.objects.get(1n);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 2);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, 0);
  world.state.objects.set(2n, { guid: 2n, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446]]) });
  events.events.length = 0;
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "GetCursorInfo").slice(0, 2), ["item", 13446]);
  assert.equal(seam.cursor.picture(), "Interface\\Icons\\INV_Potion_54");
  await settle();
  assert.ok(events.events.some(([event]) => event === "ACTIONBAR_SHOWGRID"), "a held item shows the empty slots");
  events.events.length = 0;
  call(seam, "PlaceAction", 5);
  assert.deepEqual(sent, [[4, 13446, ACTION_BUTTON_ITEM]], "CMSG_SET_ACTION_BUTTON: wire slot 4, item 0x80");
  assert.deepEqual(call(seam, "CursorHasItem"), [false], "the item left the cursor, not the bag");
  assert.equal(world.state.objects.has(2n), true);
  await settle();
  assert.ok(events.events.some(([event]) => event === "ACTIONBAR_HIDEGRID"));
  assert.deepEqual(call(seam, "GetActionInfo", 5), ["item", 13446]);
  seam.detach();
});

test("live: a macro placed over a spell swaps, a passive spell is never picked up, a press with a spell places it", () => {
  const spells = new Map([spell(133, "Огненный шар"), spell(6117, "Доспех", { passive: true })]);
  const { seam, sent, casts } = live({ spells });
  call(seam, "PickupMacro", 1);
  call(seam, "UseAction", 1);
  assert.deepEqual(sent, [[0, 2, ACTION_BUTTON_MACRO]]);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 1, "spell"], "the fireball the macro displaced");
  assert.deepEqual(casts, []);
  call(seam, "UseAction", 3);
  assert.deepEqual(sent.at(-1), [2, 133, ACTION_BUTTON_SPELL]);
  call(seam, "PickupSpell", 2, "spell");
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "the passive stays in the book");
  call(seam, "PickupAction", 3);
  assert.deepEqual(sent.at(-1), [2, 0, 0], "the lifted slot is emptied on the server");
  call(seam, "ClearCursor");
  assert.deepEqual(call(seam, "HasAction", 3), [false], "an action let go of is gone, as in the client");
});

test("live: LEARNED_SPELL_IN_TAB names the tab stock concatenates", () => {
  const spells = new Map([spell(133, "Огненный шар")]);
  const { seam, handlers } = live({ spells });
  const events = pump();
  seam.attach(events);
  events.events.length = 0;
  handlers.get("SPELL_LEARNED")({ spellId: 133 });
  assert.deepEqual(events.events.filter(([event]) => event === "LEARNED_SPELL_IN_TAB"), [["LEARNED_SPELL_IN_TAB", 1]]);
  seam.detach();
});
}

// ── framexml-cursor-economy.test.mjs
{
// Review of lane L1 (03.10; items 3.23, 1.10, 5.24): which ordinary stock-UI gestures may now sell, buy,
// trade, feed or wrap. Each row is a gesture as the stock Lua makes it (MerchantFrame.lua:380-410,
// MerchantFrame.xml:794-805 OnMouseUp/OnReceiveDrag, ContainerFrame.lua:693-736, PaperDollFrame.lua:1232-1247,
// SecureTemplates.lua:402-415) and the economic packets it may send. Wow.exe 12340: 0x005853a0
// (PickupMerchantItem), 0x005d7ff0 / 0x005e85d0 (PickupContainerItem / PickupInventoryItem with a
// merchant row held), 0x0051bdd0 (DropItemOnUnit), 0x0080dcf0 (feeding).

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
}

// ── framexml-cursor-money.test.mjs
{
// Plan item 3.09 (L5c, 04.10): money on the cursor, as Wow.exe 3.3.5a 12340 keeps it (read-only
// Ghidra, .runtime/re-2026-10-04/l5c/): PickupPlayerMoney 0x00522980 → 0x00520880, DropCursorMoney
// 0x00522950, GetCursorMoney 0x00515a50, CursorHasMoney 0x005151c0, GetCursorInfo 0x00515200 (type 2
// "money"), PickupTradeMoney 0x00586810 → 0x00704320, AddTradeMoney 0x00586d90 → 0x00704220, ClearCursor
// 0x0051a3b0 → 0x00519280. Only the trade's own CMSG_SET_TRADE_GOLD ever carries the money anywhere.
const { FrameXmlCursorModel } = await import("../dist/code/browser/framexml/FrameXmlCursor.js");
const { FRAMEXML_CURSOR_MONEY_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlCursorMoney.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function seam({ coinage = 10_000, tradeOpen = false } = {}) {
  const fired = [];
  const cleared = [];
  const host = {
    cursorInfo: () => [], cursorHasItem: () => false, clearCursor: () => { cleared.push(true); },
    spellIsPassive: () => false, itemInfo: () => undefined, spellTexture: () => undefined,
  };
  const cursor = new FrameXmlCursorModel(host);
  cursor.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  const offers = [];
  let offered = 0;
  const trade = {
    playerMoney: () => (tradeOpen ? offered : 0),
    setMoney: (value) => { if (!tradeOpen || value === offered) return; offered = value; offers.push(value); },
  };
  const target = { cursor, trade, money: () => coinage, cursorInfo: () => [], cursorHasItem: () => false, clearCursor: () => {} };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](target, args);
  const events = async () => { await Promise.resolve(); return fired.splice(0).map(([name]) => name); };
  return { target, cursor, call, events, offers, cleared, setOffered: (value) => { offered = value; } };
}

test("the money bindings answer for the seam table, over the trade's inert pair and the neutral 0", () => {
  for (const name of ["PickupPlayerMoney", "DropCursorMoney", "GetCursorMoney", "CursorHasMoney", "PickupTradeMoney", "AddTradeMoney"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_CURSOR_MONEY_BINDINGS[name], name);
  }
});

test("PickupPlayerMoney holds up to the coinage; the money is answered, and DropCursorMoney gives it back", async () => {
  const { call, events } = seam({ coinage: 5000 });
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual([...call("CursorHasMoney")], [undefined]);
  call("PickupPlayerMoney", 6000);
  call("PickupPlayerMoney", 0);
  call("PickupPlayerMoney", "x");
  assert.deepEqual([...call("GetCursorMoney")], [0], "more than the purse, zero or no number: nothing held");
  assert.deepEqual(await events(), []);
  call("PickupPlayerMoney", 1234.4);
  assert.deepEqual([...call("GetCursorMoney")], [1234]);
  assert.deepEqual([...call("CursorHasMoney")], [1]);
  assert.deepEqual([...call("GetCursorInfo")], ["money", 1234]);
  assert.deepEqual(await events(), ["CURSOR_UPDATE", "PLAYER_MONEY"], "the backpack's money frame redraws without it");
  call("DropCursorMoney");
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual([...call("GetCursorInfo")], []);
  assert.deepEqual(await events(), ["PLAYER_MONEY", "CURSOR_UPDATE"]);
  call("DropCursorMoney");
  assert.deepEqual(await events(), [], "nothing held: nothing happens");
});

test("ClearCursor and a new pickup let the money go with PLAYER_MONEY; no action-bar grid for money", async () => {
  const { call, cursor, events } = seam();
  call("PickupPlayerMoney", 100);
  await events();
  call("ClearCursor");
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual(await events(), ["PLAYER_MONEY", "CURSOR_UPDATE"]);
  call("PickupPlayerMoney", 100);
  await events();
  cursor.pickupItem(6948);
  assert.deepEqual([...call("GetCursorMoney")], [0], "one thing on the cursor");
  const after = await events();
  assert.ok(after.includes("PLAYER_MONEY"), `the money went back: ${after}`);
  call("ClearCursor");
  await events();
  call("PickupPlayerMoney", 100);
  const grid = await events();
  assert.ok(!grid.includes("ACTIONBAR_SHOWGRID"), `no grid for money: ${grid}`);
});

test("PickupTradeMoney takes from the offer through CMSG_SET_TRADE_GOLD; AddTradeMoney puts it back quietly", async () => {
  const { call, events, offers, setOffered } = seam({ coinage: 10_000, tradeOpen: true });
  setOffered(3000);
  call("PickupTradeMoney", 5000);
  call("PickupTradeMoney", 0);
  call("PickupTradeMoney", -1);
  assert.deepEqual(offers, [], "more than offered, zero or negative: the offer stays");
  call("PickupTradeMoney", 1000);
  assert.deepEqual(offers, [2000], "the new total goes to the realm");
  assert.deepEqual([...call("GetCursorMoney")], [1000]);
  assert.deepEqual(await events(), ["CURSOR_UPDATE", "PLAYER_MONEY"]);
  call("AddTradeMoney");
  assert.deepEqual(offers, [2000, 3000]);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual(await events(), ["CURSOR_UPDATE"], "0x00519280(1, 0): no PLAYER_MONEY");
  // From the purse into the trade: the sum may not pass the coinage.
  call("PickupPlayerMoney", 8000);
  await events();
  call("AddTradeMoney");
  assert.deepEqual(offers, [2000, 3000], "3000 + 8000 > 10000: refused, the money stays held");
  assert.deepEqual([...call("GetCursorMoney")], [8000]);
  call("DropCursorMoney");
  call("PickupPlayerMoney", 7000);
  call("AddTradeMoney");
  assert.deepEqual(offers, [2000, 3000, 10_000]);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
});

test("with no open trade nothing moves and the hand keeps its money", () => {
  const { call, offers } = seam({ tradeOpen: false });
  call("PickupTradeMoney", 10);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  call("PickupPlayerMoney", 50);
  call("AddTradeMoney");
  assert.deepEqual(offers, []);
  assert.deepEqual([...call("GetCursorMoney")], [50], "the trade did not take it");
});

// L5c-review (04.10): the hand's coin picture by amount, Wow.exe 0x00616510 → 0x007e7cc0 (signed
// compares against 10, 100, 1000, 10000, 100000; the icon directory of 0x00634910 row 3).
test("the hand shows the client's coins for the amount held, and nothing once they are let go", async () => {
  const { frameXmlCoinCursorTexture } = await import("../dist/code/browser/framexml/FrameXmlCursorMoney.js");
  const COIN = "Interface\\Icons\\INV_Misc_Coin_";
  const coin = (amount) => {
    const texture = frameXmlCoinCursorTexture(amount);
    assert.ok(texture.startsWith(COIN), texture);
    return texture.slice(COIN.length);
  };
  assert.deepEqual([1, 9, 10, 99, 100, 999, 1000, 9999, 10_000, 99_999, 100_000, 5_000_000].map(coin),
    ["05", "05", "06", "06", "03", "03", "04", "04", "01", "01", "02", "02"]);
  const { call, cursor, events } = seam({ coinage: 50_000 });
  const pictures = [];
  cursor.onPicture((texture) => pictures.push(texture));
  call("PickupPlayerMoney", 1234);
  assert.equal(cursor.picture(), `${COIN}04`);
  call("DropCursorMoney");
  assert.equal(cursor.picture(), undefined);
  call("PickupPlayerMoney", 20_000);
  call("ClearCursor");
  assert.deepEqual(pictures, [`${COIN}04`, undefined, `${COIN}01`, undefined]);
  await events();
});

// L5c-review (04.10): the documented deviation — money goes only into a trade the stock TradeFrame shows.
test("a trade stock does not show (the native window's) takes no stock money drop", () => {
  const { target, call, offers, setOffered } = seam({ coinage: 10_000, tradeOpen: true });
  setOffered(1000);
  target.trade.showing = false;
  call("PickupPlayerMoney", 500);
  call("AddTradeMoney");
  call("PickupTradeMoney", 200);
  assert.deepEqual(offers, [], "no CMSG_SET_TRADE_GOLD");
  assert.deepEqual([...call("GetCursorMoney")], [500], "the hand keeps its money");
  target.trade.showing = true;
  call("AddTradeMoney");
  assert.deepEqual(offers, [1500]);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
});
}
