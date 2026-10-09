import assert from "node:assert/strict";
import test from "node:test";

// Plan item 2.02 in the retail 3.3.5a MerchantFrame from the MPQ, over LiveWorldSeam and a real
// WorldClient: a merchant who repairs shows the repair buttons (MerchantFrame_UpdateRepairButtons),
// the item button enters the repair cursor, a bag click repairs rather than lifts, «repair all»
// sends CMSG_REPAIR_ITEM(merchant, 0, 0), and once nothing is worn UPDATE_INVENTORY_DURABILITY
// disables the button (its OnEvent). Only primitives read back from Lua are compared.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { buildRepairItem } = await import("../dist/code/world/RepairProtocol.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { repair } = await import("../dist/code/browser/Repair.js");
const { clientDirectory } = await import("../tools/paths.mjs");
const { openClientArchives } = await import("../tools/mpq.mjs");

let clientDir;
try {
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

const PLAYER = 0x10n;
const VENDOR = 0xf130_0000_1a54_0001n;
const HEAD = 0x201n;
const SWORD = 0x202n;
const offset = (name) => UPDATE_FIELDS[name].offset;

function worldFixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push([opcode, [...payload]]); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const object = (guid, typeId, entries) => ({
    guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields: new Map(entries),
  });
  state.objects.set(PLAYER, object(PLAYER, 4, [
    [offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8)],
    [offset("UNIT_FIELD_LEVEL"), 20],
    [offset("UNIT_FIELD_HEALTH"), 400],
    [offset("UNIT_FIELD_MAXHEALTH"), 500],
    [offset("PLAYER_FIELD_COINAGE"), 1_000_000],
    [offset("PLAYER_FIELD_INV_SLOT_HEAD"), Number(HEAD)], [offset("PLAYER_FIELD_INV_SLOT_HEAD") + 1, 0],
    [offset("PLAYER_FIELD_PACK_SLOT_1"), Number(SWORD)], [offset("PLAYER_FIELD_PACK_SLOT_1") + 1, 0],
  ]));
  for (const [guid, entry, lost] of [[HEAD, 1001, 10], [SWORD, 1002, 5]]) {
    state.objects.set(guid, object(guid, 1, [
      [offset("OBJECT_FIELD_ENTRY"), entry], [offset("ITEM_FIELD_DURABILITY"), 100 - lost],
      [offset("ITEM_FIELD_MAXDURABILITY"), 100],
    ]));
  }
  state.objects.set(VENDOR, object(VENDOR, 3, [[offset("UNIT_NPC_FLAGS"), 0x1080]]));
  state.selfGuid = PLAYER;
  const store = new WorldStore(state);
  const template = (entry, itemClass, subClass, name) => ({
    entry, found: true, name, quality: 1, itemClass, subClass, flags: 0, inventoryType: 1, bonding: 0,
    stackable: 1, bagFamily: 0, spells: [], itemLevel: 10, requiredLevel: 1, containerSlots: 0,
    maxDurability: 100, pageText: 0, startQuest: 0,
    // What the stock item tooltip reads (ItemTooltip.ts), as tests/framexml-tooltip-content.test.mjs spells it.
    maxCount: 0, block: 0, damage: [{ min: 0, max: 0, type: 0 }], delay: 0, resistances: [0, 0, 0, 0, 0, 0, 0],
    stats: [], requiredSkill: 0, requiredSkillRank: 0, requiredReputationFaction: 0, requiredReputationRank: 0,
    allowableClass: 0, allowableRace: 0, sockets: [], socketBonus: 0, gemProperties: 0, description: "", sellPrice: 0,
  });
  world.itemTemplates.set(1001, template(1001, 4, 4, "Шлем"));
  world.itemTemplates.set(1002, template(1002, 2, 7, "Меч"));
  world.mapId = 0;
  world.selfName = "Флик";
  world.knownSpells = [{ id: 1, slot: 0 }];
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  return { world, store, sent };
}

test("stock MerchantFrame repair over the live seam: buttons, the repair cursor, repair all, the durability edge", {
  skip: clientDir ? false : "no 3.3.5a client on this machine",
}, async () => {
  const chain = await openClientArchives(clientDir);
  const decoder = new TextDecoder("utf-8");
  const { world, store, sent } = worldFixture();
  const previousWorld = game.world;
  const previousOrigin = game.gatewayOrigin;
  const previousFetch = globalThis.fetch;
  game.world = world;
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: (id) => ({ id, name: "Проверочное заклинание", rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const bytes = await chain.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const repairs = () => sent.filter(([opcode]) => opcode === OPCODES.CMSG_REPAIR_ITEM).map(([, bytes]) => bytes.join(","));
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`);
  const lua = (source, name) => {
    const result = boot.vm.execute(source, `@repair:${name}`);
    assert.equal(result.ok, true, result.error);
  };
  const buttons = () => {
    lua(`
      __allShown = MerchantRepairAllButton:IsShown() and true or false
      -- This host's IsEnabled answers 1 or 0, and 0 is true in Lua.
      __allEnabled = MerchantRepairAllButton:IsEnabled() == 1
      __itemShown = MerchantRepairItemButton:IsShown() and true or false
      __guildShown = MerchantGuildBankRepairButton:IsShown() and true or false
      __textShown = MerchantRepairText:IsShown() and true or false
      __mode = InRepairMode() and true or false
    `, "probe");
    return Object.fromEntries(["allShown", "allEnabled", "itemShown", "guildShown", "textShown", "mode"]
      .map((name) => [name, boot.vm.getGlobal(`__${name}`)]));
  };
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors, [], "vertical inventory has no handled Lua failures");
    // The list arrives after the interface is up (loading hides MerchantFrame, whose OnHide closes it).
    world.vendor = { guid: VENDOR, items: [] };
    seam.merchantChanged("show");
    lua(`__visible = MerchantFrame:IsShown() and true or false`, "visible");
    assert.equal(boot.vm.getGlobal("__visible"), true);
    assert.deepEqual(buttons(), {
      allShown: true, allEnabled: true, itemShown: true, guildShown: false, textShown: true, mode: false,
    }, "CanMerchantRepair: the two buttons; no guild: no third");
    assert.deepEqual(failures(), [], "MERCHANT_SHOW");

    // MerchantRepairItemButton's OnClick: ShowRepairCursor, then a bag click repairs the sword.
    lua(`MerchantRepairItemButton:GetScript("OnClick")(MerchantRepairItemButton, "LeftButton")`, "item-button");
    assert.equal(buttons().mode, true);

    // The repair cursor's tooltips: SetInventoryItem's third value and SetBagItem's second are the
    // price, which PaperDollItemSlotButton_OnEnter (PaperDollFrame.lua:1346) and
    // ContainerFrameItemButton_OnEnter (ContainerFrame.lua:775) add as REPAIR_COST.
    const { durabilityClient } = await import("../dist/code/browser/DurabilityClient.js");
    const catalog = { version: 1, costs: [[10, ...Array.from({ length: 21 }, (_, index) => 100 + index), ...Array.from({ length: 8 }, (_, index) => 200 + index)]],
      quality: [[1, 1], [2, 0.6], [3, 1], [4, 0.8], [5, 1], [6, 1], [7, 1.2], [8, 1.25], [9, 1.44], [10, 2.5], [11, 1.728], [12, 3], [13, 0], [14, 0], [15, 1.2], [16, 1.25]] };
    globalThis.fetch = async () => new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
    game.gatewayOrigin = "http://repair-vertical.test";
    durabilityClient(game.gatewayOrigin).load();
    for (let tries = 0; tries < 50 && !durabilityClient(game.gatewayOrigin).tables; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    lua(`
      GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
      local _, _, inventoryCost = GameTooltip:SetInventoryItem("player", 1)
      GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
      local _, bagCost = GameTooltip:SetBagItem(0, 1)
      __costs = inventoryCost .. "," .. bagCost
      PaperDollItemSlotButton_OnEnter(CharacterHeadSlot)
      __line = false
      for index = 1, GameTooltip:NumLines() do
        local line = _G["GameTooltipTextLeft" .. index]
        if line and line:GetText() == REPAIR_COST then __line = true end
      end
      GameTooltip:Hide()
    `, "tooltips");
    assert.equal(boot.vm.getGlobal("__costs"), "1632,428", "10·0.8·204 for the helm, 5·0.8·107 for the sword");
    assert.equal(boot.vm.getGlobal("__line"), true, "the paper doll's tooltip carries «Стоимость ремонта»");
    assert.deepEqual(failures(), [], "the tooltips");

    lua(`PickupContainerItem(0, 1); __held = CursorHasItem() and true or false`, "bag-click");
    assert.equal(boot.vm.getGlobal("__held"), false, "repaired, not lifted");
    assert.deepEqual(repairs(), [[...buildRepairItem(VENDOR, SWORD, false)].join(",")]);
    lua(`MerchantRepairItemButton:GetScript("OnClick")(MerchantRepairItemButton, "LeftButton")`, "item-button-off");
    assert.equal(buttons().mode, false);

    // MerchantRepairAllButton's OnClick: RepairAllItems() with the player's own money.
    lua(`MerchantRepairAllButton:GetScript("OnClick")(MerchantRepairAllButton, "LeftButton")`, "repair-all");
    assert.deepEqual(repairs().at(-1), [...buildRepairItem(VENDOR, 0n, false)].join(","));
    assert.deepEqual(failures(), [], "the clicks");

    // The realm's answer: both whole. The next poll raises UPDATE_INVENTORY_DURABILITY and the
    // button's OnEvent disables it (GetRepairAllCost's second value is nil).
    for (const guid of [HEAD, SWORD]) world.state.objects.get(guid).fields.set(offset("ITEM_FIELD_DURABILITY"), 100);
    seam.tick(5);
    assert.equal(buttons().allEnabled, false);
    assert.deepEqual(failures(), [], "UPDATE_INVENTORY_DURABILITY");

    // Closing the merchant ends the repair cursor (CloseMerchant 0x00584600).
    lua(`MerchantRepairItemButton:GetScript("OnClick")(MerchantRepairItemButton, "LeftButton")`, "item-button-again");
    assert.equal(buttons().mode, true);
    lua(`HideUIPanel(MerchantFrame)`, "close");
    assert.equal(world.vendor, undefined, "MerchantFrame_OnHide → CloseMerchant");
    lua(`__mode = InRepairMode() and true or false`, "after-close");
    assert.equal(boot.vm.getGlobal("__mode"), false);
    assert.deepEqual(failures(), [], "the close");
  } finally {
    boot.close();
    await chain.close();
    game.world = previousWorld;
    game.gatewayOrigin = previousOrigin;
    globalThis.fetch = previousFetch;
    repair.sync();
  }
});
