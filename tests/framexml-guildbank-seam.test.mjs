import assert from "node:assert/strict";
import test from "node:test";

// The stock GuildBankFrame's C API (FrameXmlGuildBank.ts) over the canned vault
// (FrameXmlGuildBankCanned.ts), in TrinityCore's packet shapes: the visit edges UIParent opens and
// closes the window on, the per-tab cache that survives WorldClient's one held tab, permissions,
// money, logs, tab text, buying a tab and the vault item on the cursor.

const { createCannedFrameXmlGuildBank, FRAMEXML_CANNED_GUILD_BANK_MONEY } = await import("../dist/code/browser/framexml/FrameXmlGuildBankCanned.js");
const { FRAMEXML_GUILDBANK_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlGuildBank.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_FRIENDS_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlFriends.js");
const {
  GE_BANK_MONEY_SET, GE_BANK_TAB_UPDATED, GE_BANK_TEXT_CHANGED, GE_BANK_TAB_PURCHASED,
} = await import("../dist/code/world/GuildBankProtocol.js");

function bank(context = {}) {
  const canned = createCannedFrameXmlGuildBank(context);
  const fired = [];
  let now = 0;
  canned.model.attach({ fire: (event, ...args) => { fired.push(args.length ? [event, ...args] : event); return 1; }, now: () => now });
  const host = { guildBank: canned.model };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](host, args);
  return { ...canned, fired, call, advance: (seconds) => { now += seconds; } };
}

/** Blizzard_GuildBankUI loaded and gated, the vault activated and answered. */
function opened(context) {
  const fixture = bank(context);
  fixture.model.owned = true;
  fixture.world.open();
  fixture.world.answerOpen();
  fixture.fired.length = 0;
  return fixture;
}

test("the vault opens the stock window only once gated and answered, and closes it on every exit", () => {
  const { model, world, fired } = bank();
  let requests = 0;
  model.onOpenRequest = () => { requests += 1; };
  world.open();
  model.tick();
  assert.equal(requests, 1, "the activation starts the add-on load (the native window keeps the visit)");
  world.answerOpen();
  assert.deepEqual(fired, ["GUILDBANKBAGSLOTS_CHANGED", "GUILDBANK_UPDATE_TABS", "GUILDBANK_UPDATE_MONEY",
    "GUILDBANK_UPDATE_TABS", "GUILDBANK_UPDATE_WITHDRAWMONEY"],
  "the caches stay warm before stock owns it, but nothing opens it: tab 0 with the tab list, permissions, allowance");
  fired.length = 0;
  model.owned = true;
  assert.deepEqual(fired, ["GUILDBANKFRAME_OPENED"], "the gate's edge hands the answered bank to stock");
  model.owned = true;
  assert.deepEqual(fired, ["GUILDBANKFRAME_OPENED"], "once per visit");
  fired.length = 0;
  world.closeGuildBank(); // the native window, a relog or anything else with no packet of its own
  model.tick();
  assert.deepEqual(fired, ["GUILDBANKFRAME_CLOSED"]);
  assert.equal(requests, 1, "owned: a later visit starts no load");
  fired.length = 0;
  world.open();
  model.tick();
  assert.deepEqual(fired, [], "activated but unanswered (outside any guild TrinityCore sends only an error): no window");
  world.answerOpen();
  assert.equal(fired.filter((event) => event === "GUILDBANKFRAME_OPENED").length, 1, "the first list opens it");
  fired.length = 0;
  model.close(); // GuildBankFrame's OnHide → CloseGuildBankFrame
  assert.equal(world.guildBankerGuid, 0n, "there is no close opcode: the world lets the banker go");
  assert.deepEqual(fired, ["GUILDBANKFRAME_CLOSED"]);
  assert.deepEqual(world.calls.at(-1), { kind: "close" });
});

test("the gate passing while the activation is unanswered opens nothing until the first list", () => {
  const { model, world, fired } = bank();
  world.open();
  model.tick();
  model.owned = true;
  assert.deepEqual(fired, [], "a loaded add-on over a vault that has not answered: no window yet");
  world.answerOpen();
  assert.equal(fired.filter((event) => event === "GUILDBANKFRAME_OPENED").length, 1);
});

test("muted probes send nothing and keep the bank open; a lost owner hands the visit back", () => {
  const { model, world, call, fired } = opened();
  model.muted(() => {
    call("QueryGuildBankTab", 1);
    call("QueryGuildBankLog", 7);
    call("QueryGuildBankText", 1);
    call("CloseGuildBankFrame");
    call("DepositGuildBankMoney", 100);
  });
  assert.deepEqual(world.calls, [], "the gate's tab visits and OnHide are silent");
  assert.notEqual(world.guildBankerGuid, 0n);
  model.owned = false;
  model.owned = true;
  assert.deepEqual(fired, ["GUILDBANKFRAME_OPENED"], "retaking ownership reopens the bank still open");
});

test("each tab is cached as its lists arrived, whatever tab WorldClient holds now", () => {
  const { world, call, fired } = opened();
  world.deliverTab(1);
  assert.deepEqual(call("GetGuildBankItemInfo", 2, 1), ["Interface\\Icons\\INV_Potion_54", 5, undefined]);
  // Another member empties tab 1's slot 4 and fills slot 6: TrinityCore's partial list (item 0 empties).
  world.contents[0] = world.contents[0].filter((item) => item.slot !== 3);
  world.contents[0].push({ ...world.contents[0][0], slot: 5, itemId: 818, count: 2 });
  world.deliverSlots(0, [3, 5]);
  assert.equal(world.guildBank.tabId, 0, "the world now holds only that partial list");
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 4), [], "the emptied slot");
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 6), ["Interface\\Icons\\INV_Misc_Gem_Opal_03", 2, undefined]);
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 1), ["Interface\\Icons\\INV_Fabric_Linen_01", 20, undefined],
    "slots the partial list did not name keep what the full list said");
  assert.deepEqual(call("GetGuildBankItemInfo", 2, 1), ["Interface\\Icons\\INV_Potion_54", 5, undefined], "and so does the other tab");
  assert.equal(fired.filter((event) => event === "GUILDBANKBAGSLOTS_CHANGED").length, 2);
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 99), [], "slots are 1-98");
  assert.deepEqual(call("GetGuildBankItemLink", 1, 29), ["|cffffffff|Hitem:2488:1900:0:0:0:0:0:0:60|h[Гладий]|h|r"],
    "the stack's own link: its permanent enchant and the player's level");
});

test("an item not cached yet shows the client's question mark and repaints once its facts land", () => {
  const facts = new Map();
  let prefetched;
  const { world, call, fired } = opened({
    item: (entry) => facts.get(entry),
    prefetchItems: (entries, onChanged) => { prefetched = { entries, onChanged }; },
  });
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 1), ["Interface\\Icons\\INV_Misc_QuestionMark", 20, undefined]);
  assert.deepEqual(call("GetGuildBankItemLink", 1, 1), [], "no name, no link");
  assert.ok(prefetched.entries.includes(2589), "the list asked for its items outside any read");
  facts.set(2589, { name: "Льняной материал", texture: "Interface\\Icons\\INV_Fabric_Linen_01", quality: 1 });
  prefetched.onChanged();
  assert.deepEqual(fired, ["GUILDBANKBAGSLOTS_CHANGED"]);
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 1), ["Interface\\Icons\\INV_Fabric_Linen_01", 20, undefined]);
  void world;
});

test("a list broadcast while no bank is open asks for no item; the stock window's open asks for what was cached", () => {
  const asked = [];
  const { model, world, call } = bank({
    item: () => undefined,
    prefetchItems: (entries) => { asked.push([...entries]); },
  });
  model.owned = true;
  // TrinityCore's partial list to every member who may view the tab, whoever moved the item and wherever.
  world.deliverSlots(1, [0]);
  assert.deepEqual(asked, [], "no CMSG_ITEM_QUERY_SINGLE for a vault the player is not at");
  assert.deepEqual(call("GetGuildBankItemInfo", 2, 1), ["Interface\\Icons\\INV_Misc_QuestionMark", 5, undefined], "cached all the same");
  world.open();
  world.answerOpen();
  assert.deepEqual(asked, [[2589, 4306, 14047, 818, 12360, 7078, 2488, 15014], [13446]],
    "the activation answer's tab 0, then tab 2 as the broadcast cached it (GUILDBANKFRAME_OPENED)");
});

test("tab info: names and icons, the rank's rights byte sign extended, WithdrawItemLimit and what is left", () => {
  const { world, call, fired } = opened();
  assert.deepEqual(call("WebClientGuildBankNumTabs"), [2]);
  assert.deepEqual(call("WebClientGuildBankTabInfo", 1), ["Общее", "Interface\\Icons\\INV_Misc_Bag_10", true, true, -1, -1],
    "the guild master: full rights arrive as -1, unlimited withdrawals as -1");
  assert.deepEqual(call("WebClientGuildBankTabInfo", 3), [], "a tab the guild has not bought");
  assert.deepEqual(call("CanEditGuildTabInfo", 1), [1]);
  // A member: view and deposit on tab 1, view only on tab 2, five stacks a day, four left on tab 1.
  world.rankId = 3;
  world.deliverPermissions();
  world.guildPermissions.tabs[0] = { rights: 0x03, slotsRemaining: 5 };
  world.guildPermissions.tabs[1] = { rights: 0x01, slotsRemaining: 0 };
  world.deliverSlots(0, []);
  assert.deepEqual(call("WebClientGuildBankTabInfo", 1), ["Общее", "Interface\\Icons\\INV_Misc_Bag_10", true, true, 5, 4],
    "the tab's latest list says how many stacks are left");
  assert.deepEqual(call("WebClientGuildBankTabInfo", 2), ["Рейд", "Interface\\Icons\\INV_Potion_54", true, false, 0, 0]);
  assert.deepEqual(call("CanEditGuildTabInfo", 1), [undefined], "no update-text right");
  world.guildPermissions.tabs[0] = { rights: 0x07, slotsRemaining: 5 };
  assert.deepEqual(call("CanEditGuildTabInfo", 1), [1]);
  fired.length = 0;
  world.guildEvent(GE_BANK_TAB_UPDATED, ["1", "Эликсиры", "INV_Potion_32"]);
  assert.deepEqual(fired, ["GUILDBANK_UPDATE_TABS"]);
  assert.deepEqual(call("WebClientGuildBankTabInfo", 2).slice(0, 2), ["Эликсиры", "Interface\\Icons\\INV_Potion_32"]);
  fired.length = 0;
  world.guildEvent(GE_BANK_TAB_PURCHASED);
  assert.deepEqual(fired, ["GUILDBANK_UPDATE_TABS"]);
});

test("the vault's names sit beside the guild frame's: GetGuildBankTabInfo stays FrameXmlGuild.ts's seam name", () => {
  const { call } = opened();
  for (const name of ["GetGuildBankTabInfo", "GetNumGuildBankTabs"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_FRIENDS_BINDINGS[name], `${name} is not shadowed`);
    assert.equal(FRAMEXML_GUILDBANK_BINDINGS[name], undefined);
  }
  assert.equal(call("WebClientGuildBankTabInfo", 1)[0], "Общее", "the six-value answer starts with the name the rank editor reads");
  for (const name of Object.keys(FRAMEXML_GUILDBANK_BINDINGS)) {
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), name);
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_GUILDBANK_BINDINGS[name], `${name} is the vault's own binding`);
  }
  const empty = {};
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.WebClientGuildBankNumTabs(empty, []), [0]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetGuildBankMoney(empty, []), [0]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetGuildBankWithdrawMoney(empty, []), [0],
    "never nil: GuildBankFrame_UpdateWithdrawMoney compares it with 0 (blizzard_guildbankui.lua:658)");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetCurrentGuildBankTab(empty, []), [1]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetGuildBankItemInfo(empty, [1, 1]), []);
});

test("money: the lists' total, GE_BANK_MONEY_SET's hex, the allowance and the gold right", () => {
  const { world, call, fired, model } = opened();
  assert.deepEqual(call("GetGuildBankMoney"), [FRAMEXML_CANNED_GUILD_BANK_MONEY]);
  assert.deepEqual(call("GetGuildBankWithdrawMoney"), [-1], "the guild master's unlimited allowance");
  assert.deepEqual(call("CanWithdrawGuildBankMoney"), [1]);
  world.guildEvent(GE_BANK_MONEY_SET, ["00000000000F4240"]);
  assert.deepEqual(call("GetGuildBankMoney"), [1_000_000]);
  assert.deepEqual(fired, ["GUILDBANK_UPDATE_MONEY"]);
  assert.deepEqual(world.calls.at(-1), { kind: "withdrawn" }, "the open bank asks its allowance again");
  world.deliverWithdrawn(250_000);
  assert.deepEqual(fired.at(-1), "GUILDBANK_UPDATE_WITHDRAWMONEY");
  assert.deepEqual(call("GetGuildBankWithdrawMoney"), [250_000]);
  call("DepositGuildBankMoney", 12_345.9);
  call("WithdrawGuildBankMoney", 0);
  call("WithdrawGuildBankMoney", "x");
  call("WithdrawGuildBankMoney", 1e12);
  assert.deepEqual(world.calls.slice(-2), [{ kind: "deposit", copper: 12_345 }, { kind: "withdraw", copper: 0xffffffff }],
    "whole copper, at least one, at most the u32 the packet carries");
  world.rankId = 3;
  world.deliverPermissions();
  assert.deepEqual(call("CanWithdrawGuildBankMoney"), [1], "the canned member's rank holds GR_RIGHT_WITHDRAW_GOLD (0x80000)");
  world.guildPermissions.rights = 0x000000c3;
  assert.deepEqual(call("CanWithdrawGuildBankMoney"), [undefined]);
  model.owned = false;
  const sent = world.calls.length;
  world.guildEvent(GE_BANK_MONEY_SET, ["0000000000000001"]);
  assert.equal(world.calls.length, sent, "while the native window owns the visit, the model asks the world nothing");
  assert.deepEqual(call("GetGuildBankMoney"), [1], "though its caches stay current");
});

test("the next tab's price is TrinityCore's and buying names the next tab", () => {
  const { world, call } = opened();
  assert.deepEqual(call("GetGuildBankTabCost"), [500 * 10000], "the third tab: 500 gold");
  call("BuyGuildBankTab");
  assert.deepEqual(world.calls.at(-1), { kind: "buy", tab: 2 });
  world.guildPermissions.purchasedTabs = 6;
  assert.deepEqual(call("GetGuildBankTabCost"), [], "all six bought");
  call("BuyGuildBankTab");
  assert.deepEqual(world.calls.at(-1), { kind: "buy", tab: 2 }, "nothing more to buy");
});

test("logs by tab: stock's type words, the move's tabs, the money log, the time since and late names", () => {
  const names = new Map([[0x42n, "Игрок"]]);
  const { world, call, fired, model, advance } = opened();
  world.displayName = (guid) => names.get(guid) ?? `0x${guid.toString(16)}`;
  const asked = [];
  world.requestName = (guid) => asked.push(guid);
  call("QueryGuildBankLog", 1);
  call("QueryGuildBankLog", 7);
  assert.deepEqual(world.calls.slice(-2), [{ kind: "log", tab: 0 }, { kind: "log", tab: 6 }],
    "stock's MAX_GUILDBANK_TABS + 1 is TrinityCore's money log tab 6");
  // A type stock does not format is not counted: GuildBankFrame_UpdateMoneyLog concatenates its message.
  world.logs.get(6).push({ type: 11, playerGuid: 0x42n, itemId: 0, itemCount: 0, destinationTab: 0, money: 5, secondsAgo: 1 });
  world.deliverLog(0);
  world.deliverLog(6);
  assert.deepEqual(fired, ["GUILDBANKLOG_UPDATE", "GUILDBANKLOG_UPDATE"]);
  assert.deepEqual(call("GetNumGuildBankTransactions", 1), [5]);
  assert.deepEqual(call("GetGuildBankTransaction", 1, 4), ["move", "Игрок",
    "|cffffffff|Hitem:13446:0:0:0:0:0:0:0:60|h[Огромный флакон с лечебным зельем]|h|r", 5, 1, 2, 0, 0, 0, 5]);
  assert.deepEqual(call("GetGuildBankTransaction", 1, 1).slice(0, 6), ["deposit", undefined,
    "|cffffffff|Hitem:2589:0:0:0:0:0:0:0:60|h[Льняной материал]|h|r", 20, undefined, undefined]);
  assert.deepEqual(call("GetGuildBankTransaction", 1, 1).slice(6), [0, 0, 3, 0], "three days ago");
  assert.deepEqual(asked, [0x101n], "the unknown name is asked for once");
  assert.deepEqual(call("GetNumGuildBankMoneyTransactions"), [5]);
  assert.deepEqual(call("GetGuildBankMoneyTransaction", 2), ["buyTab", "Игрок", 1_000_000, 0, 0, 3, 0]);
  assert.deepEqual(call("GetGuildBankMoneyTransaction", 3).slice(0, 3), ["repair", undefined, 12_345]);
  assert.deepEqual(call("GetGuildBankMoneyTransaction", 6), [], "the sixth entry is the unknown type 11");
  fired.length = 0;
  model.tick();
  assert.deepEqual(fired, [], "the names are still unknown");
  names.set(0x101n, "Аэлинда");
  names.set(0x303n, "Хельга");
  advance(0.1);
  model.tick();
  assert.deepEqual(fired, [], "looked again at most every quarter second");
  advance(0.2);
  model.tick();
  assert.deepEqual(fired, ["GUILDBANKLOG_UPDATE"], "the names landed: the log repaints once");
  model.tick();
  advance(1);
  model.tick();
  assert.deepEqual(fired, ["GUILDBANKLOG_UPDATE"]);
});

test("tab text: asked by 0-based tab, announced by 1-based, capped at TrinityCore's 500 characters", () => {
  const { world, call, fired } = opened();
  call("SetCurrentGuildBankTab", 2); // GuildBankTab_OnClick selects the tab before it asks
  call("QueryGuildBankText", 2);
  assert.deepEqual(world.calls.at(-1), { kind: "text", tab: 1 });
  world.deliverText(1);
  assert.deepEqual(fired, [["GUILDBANK_UPDATE_TEXT", 2]]);
  assert.deepEqual(call("GetGuildBankText", 2), ["Зелья для рейда в пятницу."]);
  assert.deepEqual(call("GetGuildBankText", 3), []);
  call("SetGuildBankText", 1, "я".repeat(600));
  assert.equal(world.calls.at(-1).text.length, 500);
  call("SetGuildBankText", 5, "no tab");
  assert.equal(world.calls.at(-1).tab, 0, "a tab the guild has not bought is not written");
  fired.length = 0;
  world.guildEvent(GE_BANK_TEXT_CHANGED, ["0"]);
  assert.deepEqual(fired, [["GUILDBANK_TEXT_CHANGED", 1]]);
});

test("tab text: another tab's broadcast is cached, not announced into the Info box shown", () => {
  const { world, call, fired } = opened();
  assert.deepEqual(call("GetCurrentGuildBankTab"), [1]);
  // TrinityCore answers a guildmate's save of tab 2 with a guild-wide MSG_QUERY_GUILD_BANK_TEXT; a late
  // answer after a quick tab switch looks the same. Stock would fill tab 1's box with it and save it there.
  world.deliverText(1);
  assert.deepEqual(fired, [], "stock's GuildBankFrame_UpdateTabInfo does not compare tabs: nothing fires");
  assert.deepEqual(call("GetGuildBankText", 2), ["Зелья для рейда в пятницу."], "the cache holds it for tab 2's click");
  world.deliverText(0);
  assert.deepEqual(fired, [["GUILDBANK_UPDATE_TEXT", 1]], "the shown tab's text is announced");
});

test("tab text: only the update-text right writes, and an unchanged or never-answered empty text sends nothing", () => {
  const { world, call } = opened();
  // TrinityCore checks no right on CMSG_SET_GUILD_BANK_TEXT, and stock's Info OnHide clicks the hidden Save.
  world.rankId = 3;
  world.rights = 0x03; // view and deposit
  world.deliverPermissions();
  assert.deepEqual(call("CanEditGuildTabInfo", 1), [undefined]);
  call("SetGuildBankText", 1, "чужой текст");
  assert.deepEqual(world.calls, [], "a member without GUILD_BANK_RIGHT_UPDATE_TEXT overwrites nothing");
  world.rights = 0x07;
  world.deliverPermissions();
  assert.deepEqual(call("CanEditGuildTabInfo", 1), [1]);
  // Info left before MSG_QUERY_GUILD_BANK_TEXT answered: stock's `"" ~= nil` saves an empty text.
  call("SetGuildBankText", 1, "");
  assert.deepEqual(world.calls, [], "an empty text over an unanswered tab would wipe it for the guild");
  world.deliverText(0);
  call("SetGuildBankText", 1, "Общие материалы гильдии.\nБерите для профессий, возвращайте излишки.");
  assert.deepEqual(world.calls, [], "the text the server last said is not sent again");
  call("SetGuildBankText", 1, "Правка");
  assert.deepEqual(world.calls.at(-1), { kind: "setText", tab: 0, text: "Правка" });
  call("SetGuildBankText", 1, "");
  assert.deepEqual(world.calls.at(-1), { kind: "setText", tab: 0, text: "" }, "clearing an answered text is an edit");
});

test("the vault cursor: pick up (locked), move, split, drop into a bag slot, deposit what the bags hold", () => {
  let bagCursor = { entry: 818, bag: 255, slot: 24 };
  let cleared = 0;
  const { world, call, fired } = opened({
    cursorItem: () => bagCursor,
    clearCursor: () => { cleared += 1; bagCursor = undefined; },
  });
  call("PickupGuildBankItem", 2, 7);
  assert.deepEqual(world.calls.at(-1), { kind: "depositItem", tab: 1, slot: 6, itemId: 818, bag: 255, bagSlot: 24, split: 0 },
    "a bag item on the shared cursor goes into exactly that vault slot");
  assert.equal(bagCursor, undefined);
  fired.length = 0;
  call("PickupGuildBankItem", 1, 1);
  assert.deepEqual(fired, ["GUILDBANK_ITEM_LOCK_CHANGED", "CURSOR_UPDATE"]);
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 1)[2], 1, "the held stack's slot is locked");
  assert.equal(cleared, 2, "picking a vault stack up drops whatever else the shared cursor held");
  call("PickupGuildBankItem", 1, 2);
  assert.deepEqual(world.calls.at(-1), { kind: "move", fromTab: 0, fromSlot: 0, fromItemId: 2589, toTab: 0, toSlot: 1, toItemId: 2589, split: 0 },
    "BankOnly: the destination's own item is named, the core swaps or stacks");
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 1)[2], undefined, "let go");
  call("PickupGuildBankItem", 1, 5);
  call("PickupGuildBankItem", 1, 5);
  assert.equal(world.calls.at(-1).kind, "move", "putting a stack back on its own slot sends nothing");
  call("SplitGuildBankItem", 1, 4, 5);
  call("PickupGuildBankItem", 2, 10);
  assert.deepEqual(world.calls.at(-1), { kind: "move", fromTab: 0, fromSlot: 3, fromItemId: 4306, toTab: 1, toSlot: 9, toItemId: 0, split: 5 },
    "StackSplitFrame's amount, across tabs");
  const sent = world.calls.length;
  call("PickupGuildBankItem", 1, 50);
  call("SplitGuildBankItem", 1, 50, 3);
  assert.equal(world.calls.length, sent, "an empty slot picks nothing up");
  assert.deepEqual(call("GetGuildBankItemInfo", 1, 50), []);
});

test("a held stack is dropped into a bag slot, released by ClearCursor, a close or another member's move", () => {
  const { world, call, model } = opened();
  call("SplitGuildBankItem", 1, 3, 4);
  assert.deepEqual(model.cursorInfo(), ["item", 2589, "|cffffffff|Hitem:2589:0:0:0:0:0:0:0:60|h[Льняной материал]|h|r"]);
  assert.equal(model.dropOnBagSlot({ bag: 255, slot: 25 }), true);
  assert.deepEqual(world.calls.at(-1), { kind: "withdrawTo", tab: 0, slot: 2, itemId: 2589, bag: 255, bagSlot: 25, split: 4 });
  assert.equal(model.cursorHasItem(), false);
  assert.equal(model.dropOnBagSlot({ bag: 255, slot: 25 }), false, "nothing held: the bag cursor handles the click");
  call("SplitGuildBankItem", 1, 3, 7);
  assert.equal(model.cursorInfo()[0], "item");
  call("SplitGuildBankItem", 1, 3, 99);
  model.dropOnBagSlot({ bag: 19, slot: 0 });
  assert.equal(world.calls.at(-1).split, 0, "a split of the whole stack (or more) moves the stack");
  call("PickupGuildBankItem", 1, 1);
  model.clearCursor();
  assert.equal(model.cursorHasItem(), false);
  call("PickupGuildBankItem", 1, 1);
  world.contents[0] = world.contents[0].filter((item) => item.slot !== 0);
  world.deliverSlots(0, [0]);
  assert.equal(model.cursorHasItem(), false, "another member took the stack: the cursor lets it go");
  call("PickupGuildBankItem", 1, 2);
  call("AutoStoreGuildBankItem", 1, 2);
  assert.equal(model.cursorHasItem(), false, "right-clicking the held stack stores it");
  assert.deepEqual(world.calls.at(-1), { kind: "autoStore", tab: 0, slot: 1, itemId: 2589 });
  call("PickupGuildBankItem", 1, 5);
  call("CloseGuildBankFrame");
  assert.equal(model.cursorHasItem(), false, "closing the bank lets go");
});

test("a right-clicked bag item goes into the tab shown only while stock shows the bank", () => {
  const { world, call, model } = bank();
  world.open();
  world.answerOpen();
  assert.equal(model.useItem({ entry: 818, bag: 255, slot: 23 }), false, "the native window owns the visit");
  model.owned = true;
  call("SetCurrentGuildBankTab", 2);
  assert.equal(model.useItem({ entry: 818, bag: 255, slot: 23 }), true);
  assert.deepEqual(world.calls.at(-1), { kind: "depositItem", tab: 1, slot: 255, itemId: 818, bag: 255, bagSlot: 23, split: 0 },
    "NULL_SLOT: BankMoveItemData::CanStore merges it into a stack or the first free slot");
  call("SetCurrentGuildBankTab", 3);
  assert.equal(model.useItem({ entry: 818, bag: 255, slot: 23 }), false, "the buy tab takes nothing");
  model.close();
  assert.equal(model.useItem({ entry: 818, bag: 255, slot: 23 }), false);
});

test("SetGuildBankTabInfo sends the picked macro item icon by its name, and never an empty name or icon", () => {
  const { world, call } = opened({ macroItemIcon: (index) => (index === 3 ? "Interface\\Icons\\INV_Misc_Gem_01" : undefined) });
  call("SetGuildBankTabInfo", 1, " Материалы ", 3);
  assert.deepEqual(world.calls.at(-1), { kind: "rename", tab: 0, name: "Материалы", icon: "INV_Misc_Gem_01" });
  call("SetGuildBankTabInfo", 2, "Зелья", undefined);
  assert.deepEqual(world.calls.at(-1), { kind: "rename", tab: 1, name: "Зелья", icon: "INV_Potion_54" }, "no pick: the tab keeps its icon");
  const before = world.calls.length;
  call("SetGuildBankTabInfo", 1, "  ", 3);
  call("SetGuildBankTabInfo", 3, "Новая", 3);
  assert.equal(world.calls.length, before, "HandleGuildBankUpdateTab ignores an empty name; tab 3 is not bought");
});

test("GetGuildTabardFileNames: the guild's emblem as the GuildEmblems halves", () => {
  const { world, call } = opened();
  Object.assign(world.guildQuery, { emblemStyle: 12, emblemColor: 3, borderStyle: 1, borderColor: 14, backgroundColor: 44 });
  assert.deepEqual(call("GetGuildTabardFileNames"), [
    "Textures\\GuildEmblems\\Background_44_TU_U", "Textures\\GuildEmblems\\Background_44_TL_U",
    "Textures\\GuildEmblems\\Emblem_12_03_TU_U", "Textures\\GuildEmblems\\Emblem_12_03_TL_U",
    "Textures\\GuildEmblems\\Border_01_14_TU_U", "Textures\\GuildEmblems\\Border_01_14_TL_U",
  ]);
});
