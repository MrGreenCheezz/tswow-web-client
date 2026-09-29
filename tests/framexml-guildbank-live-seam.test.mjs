import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's guild bank wiring over a real item projection (FrameXmlGuildBankLive.ts): a vault
// stack on the stock cursor is dropped into the exact bag slot clicked (its wire position), a bag
// item on the shared cursor is deposited into the vault slot clicked, CursorHasItem/GetCursorInfo/
// ClearCursor see the vault stack, and a right-clicked bag item goes into the shown tab.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const field = (name) => UPDATE_FIELDS[name].offset;

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function item(guid, entry, count) {
  return { guid, fields: new Map([[field("OBJECT_FIELD_ENTRY"), entry], [field("ITEM_FIELD_STACK_COUNT"), count]]) };
}

const template = (name, quality = 1) => ({ found: true, name, quality, requiredLevel: 0, sellPrice: 13, stackable: 20, flags: 0 });

function vaultItem(slot, itemId, count) {
  return { slot, itemId, flags: 0, randomPropertyId: 0, suffixFactor: 0, count, enchantId: 0, charges: 0, sockets: [] };
}

function fixture() {
  const player = { guid: 1n, fields: new Map([[field("UNIT_FIELD_LEVEL"), 60]]) };
  // Backpack slots 1 and 2 (wire 255/23 and 255/24) hold linen and a tigerseye; slot 3 is empty.
  const bag = [item(2n, 2589, 20), item(3n, 818, 3)];
  bag.forEach((object, index) => place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + index * 2, object.guid));
  const sent = [];
  const events = new EventBus();
  const world = {
    events,
    state: { selfGuid: player.guid, objects: new Map([[player.guid, player], ...bag.map((object) => [object.guid, object])]) },
    names: new Map(),
    itemTemplates: new Map([[2589, template("Льняной материал")], [818, template("Тигровый глаз", 2)]]),
    itemTemplate: (entry) => world.itemTemplates.get(entry),
    casts: new Map(), channels: new Map(), actionButtons: [], creatureTemplates: new Map(), questTemplates: new Map(),
    cooldownRemaining: () => 0,
    mailboxGuid: 0n, tradeOpen: false, tradePartnerGuid: 0n, auctioneerGuid: 0n,
    ownTradeOffer: () => ({ money: 0, spellId: 0, items: [] }),
    guildBankerGuid: 0n, guildBank: undefined, guildBankLog: undefined, guildBankWithdrawRemaining: -1,
    guildPermissions: { rankId: 0, rights: -1, goldPerDay: -1, purchasedTabs: 2,
      tabs: Array.from({ length: 6 }, () => ({ rights: -1, slotsRemaining: -1 })) },
    guildBankTabText: new Map(),
    displayName: (guid) => `0x${guid.toString(16)}`,
    queryGuildBankTab: (tab) => sent.push(["queryTab", tab]),
    requestGuildBankText: (tab) => sent.push(["text", tab]),
    requestGuildBankLog: (tab) => sent.push(["log", tab]),
    setGuildBankText: (...args) => sent.push(["setText", ...args]),
    closeGuildBank: () => { sent.push(["close"]); world.guildBankerGuid = 0n; },
    buyGuildBankTab: (tab) => sent.push(["buy", tab]),
    renameGuildBankTab: (...args) => sent.push(["rename", ...args]),
    depositGuildBankMoney: (copper) => sent.push(["deposit", copper]),
    withdrawGuildBankMoney: (copper) => sent.push(["withdraw", copper]),
    withdrawGuildBankItem: (...args) => sent.push(["autoStore", ...args]),
    withdrawGuildBankItemTo: (...args) => sent.push(["withdrawTo", ...args]),
    depositGuildBankItem: (...args) => sent.push(["depositItem", ...args]),
    moveGuildBankItem: (...args) => sent.push(["move", ...args]),
    useItem: (...args) => sent.push(["use", ...args]),
    moveItem: (...args) => sent.push(["moveBagItem", ...args]),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemInfo: (entry) => world.itemTemplates.has(entry) ? { name: world.itemTemplates.get(entry).name, quality: 1 } : undefined,
    itemTexture: (entry) => (entry === 2589 ? "Interface\\Icons\\INV_Fabric_Linen_01" : undefined),
  });
  const fired = [];
  seam.guildBank.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  return { world, seam, sent, fired, events };
}

/** Blizzard_GuildBankUI loaded and gated, then the vault's activation answer: tab 0 in full. */
function openVault({ world, seam, events }) {
  seam.guildBank.owned = true;
  world.guildBankerGuid = 0xf110n;
  const list = { money: 5000n, tabId: 0, withdrawalsRemaining: -1, fullUpdate: true,
    tabs: [{ name: "Общее", icon: "INV_Misc_Bag_10" }, { name: "Рейд", icon: "" }],
    items: [vaultItem(0, 2589, 20), vaultItem(4, 818, 2)] };
  world.guildBank = list;
  events.emit("GUILD_BANK_CHANGED", { list });
}

test("a held vault stack drops into the bag slot clicked, by its wire position", () => {
  const context = fixture();
  const { seam, sent, fired } = context;
  openVault(context);
  assert.ok(fired.some(([event]) => event === "GUILDBANKFRAME_OPENED"));
  call("PickupGuildBankItem", seam, 1, 1);
  assert.deepEqual(call("CursorHasItem", seam), [true]);
  assert.deepEqual(call("GetCursorInfo", seam), ["item", 2589, "|cffffffff|Hitem:2589:0:0:0:0:0:0:0:60|h[Льняной материал]|h|r"]);
  assert.deepEqual(call("GetGuildBankItemInfo", seam, 1, 1), ["Interface\\Icons\\INV_Fabric_Linen_01", 20, 1]);
  call("PickupContainerItem", seam, 0, 3);
  assert.deepEqual(sent, [["withdrawTo", 0, 0, 2589, 255, 25, 0]], "backpack slot 3 is bag 255, slot 25 on the wire");
  assert.deepEqual(call("CursorHasItem", seam), [false]);
  call("SplitGuildBankItem", seam, 1, 5, 1);
  call("PickupContainerItem", seam, 0, 1);
  assert.deepEqual(sent.at(-1), ["withdrawTo", 0, 4, 818, 255, 23, 1],
    "onto an occupied slot too: the core swaps or stacks; the bag cursor is not involved");
  assert.deepEqual(call("CursorHasItem", seam), [false]);
  assert.equal(sent.some(([kind]) => kind === "moveBagItem"), false);
});

test("a bag item on the shared cursor is deposited into the vault slot clicked; ClearCursor lets a vault stack go", () => {
  const context = fixture();
  const { seam, sent } = context;
  openVault(context);
  call("PickupContainerItem", seam, 0, 2);
  assert.deepEqual(call("GetCursorInfo", seam).slice(0, 2), ["item", 818], "the bag cursor holds the tigerseye");
  call("PickupGuildBankItem", seam, 2, 10);
  assert.deepEqual(sent, [["depositItem", 1, 9, 818, 255, 24, 0]]);
  assert.deepEqual(call("CursorHasItem", seam), [false], "the bag cursor was cleared");
  call("PickupGuildBankItem", seam, 1, 1);
  call("ClearCursor", seam);
  assert.deepEqual(call("CursorHasItem", seam), [false]);
  assert.deepEqual(call("GetGuildBankItemInfo", seam, 1, 1)[2], undefined, "unlocked");
  call("PickupContainerItem", seam, 0, 2);
  assert.deepEqual(call("GetCursorInfo", seam).slice(0, 2), ["item", 818], "nothing vault-side intercepts an ordinary pickup");
  call("ClearCursor", seam);
});

test("a right-clicked bag item goes into the tab stock shows, and is used as usual otherwise", () => {
  const context = fixture();
  const { seam, sent } = context;
  seam.guildBank.owned = false;
  call("UseContainerItem", seam, 0, 2);
  assert.equal(sent.at(-1)?.[0], "use", "no stock guild bank: the item is used");
  openVault(context);
  call("SetCurrentGuildBankTab", seam, 2);
  call("UseContainerItem", seam, 0, 2);
  assert.deepEqual(sent.at(-1), ["depositItem", 1, 255, 818, 255, 24, 0], "NULL_SLOT into tab 2");
  call("CloseGuildBankFrame", seam);
  assert.deepEqual(sent.at(-1), ["close"]);
  call("UseContainerItem", seam, 0, 2);
  assert.equal(sent.at(-1)?.[0], "use", "the bank closed: the item is used again");
});
