import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the real load-on-demand Blizzard_AuctionUI over the production vertical and the canned
// auction house (FrameXmlAuctionCanned.ts). The add-on is loaded the way the world mount loads it —
// the lazy owner's boot.loadAddon, adapters, gate and `owned` edge — and then driven through the
// stock Lua: the browse filters and search, bids and buyouts behind their StaticPopups, the Bids
// tab, and the Auctions tab's sell slot, deposit, multisell and cancel.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

function fakeNode() {
  return {
    children: [], style: {}, dataset: {}, hidden: false, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append() {}, replaceChildren() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }, getContext() { return {}; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? fakeNode() : null; },
  };
}
globalThis.document ??= {
  head: fakeNode(), body: fakeNode(), createElement: fakeNode, getElementById: fakeNode, querySelectorAll() { return []; },
};
globalThis.window ??= {
  innerWidth: 1024, innerHeight: 768, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
};
globalThis.location ??= globalThis.window.location;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createLazyFrameXmlAuctionOwner, frameXmlAuctionGate, FRAMEXML_AUCTION_ADDON } = await import("../dist/code/browser/framexml/FrameXmlAuctionOwner.js");
const { AUCTION_SELL_ITEM, AUCTION_PLACE_BID, AUCTION_CANCEL } = await import("../dist/code/world/AuctionProtocol.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_auctionui/";

async function load({ missingAddon = false } = {}) {
  const requests = [];
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (missingAddon && key.startsWith(ADDON_PREFIX)) return undefined;
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  const inventory = await boot.load();
  return { boot, seam, requests, inventory, loadMs: performance.now() - started };
}

/** A renderer stand-in whose element tree mirrors the frame tree, as FrameXmlDomRenderer's does. */
function treeRenderer() {
  const elements = new Map();
  const elementFor = (frame) => {
    if (!frame) return null;
    if (!elements.has(frame)) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      elements.set(frame, { dataset: {}, get parentElement() { return elementFor(frame.parent); }, getAttribute: (name) => attributes.get(name) ?? null });
    }
    return elements.get(frame);
  };
  return { elementFor, addRoots() {}, sync() {} };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "auction-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** The world mount's route: the lazy owner, the canned hello, the add-on load and the gate. */
async function openHouse(loaded, renderer = treeRenderer()) {
  const native = { hidden: false, shows: 0 };
  const failures = [];
  const owner = createLazyFrameXmlAuctionOwner(loaded.seam, loaded.boot, renderer, {
    hide: () => { native.hidden = true; }, show: () => { native.shows += 1; native.hidden = false; },
  }, (reason) => failures.push(reason));
  loaded.seam.auctionWorld.open();
  const pending = owner.isOpen();
  await owner.settled;
  return { owner, native, failures, pending };
}

test("Blizzard_AuctionUI costs nothing at boot and loads its seven files on the first auctioneer", withClient, async () => {
  const loaded = await load();
  const { boot, seam, requests } = loaded;
  try {
    assert.equal(boot.bridge.getFrame("AuctionFrame")?.name, undefined, "the vertical does not carry the LoD add-on");
    assert.equal(requests.some((path) => path.startsWith(ADDON_PREFIX)), false, "no add-on file is read at boot");
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const started = performance.now();
    const { owner, native, failures, pending } = await openHouse(loaded);
    const addonMs = performance.now() - started;
    assert.equal(pending, true, "the load is in flight: the owner reports the house open");
    assert.deepEqual(failures, []);
    assert.equal(owner.loaded, true);
    assert.deepEqual([...new Set(requests.filter((path) => path.startsWith(ADDON_PREFIX)))].sort(), [
      "blizzard_auctiondressup.lua", "blizzard_auctiondressup.xml", "blizzard_auctionui.lua", "blizzard_auctionui.toc",
      "blizzard_auctionui.xml", "blizzard_auctionuitemplates.xml", "localization.lua",
    ].map((file) => ADDON_PREFIX + file), "exactly the add-on's own TOC closure, nothing of the base corpus");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-3))}`);
    assert.equal(boot.bridge.diagnostics.length, diagnostics);
    assert.deepEqual(lua(boot, "return AuctionFrame:IsShown() and 1 or 0, AuctionFrameBrowse:IsShown() and 1 or 0", 2), [1, 1],
      "the `owned` edge's AUCTION_HOUSE_SHOW opened the house UIParent-style");
    assert.equal(native.hidden, true, "the native window stepped aside only after the gate");
    assert.deepEqual(seam.auctionWorld.calls, [{ kind: "bidder" }, { kind: "owner" }],
      "OnLoad asked for the bid and owner lists once; the gate's muted tab visits and AuctionFrame_Show asked nothing more");
    assert.deepEqual(sounds, ["igCharacterInfoTab", "AuctionWindowOpen"],
      "the silent gate played nothing; the real open played AuctionFrame_OnShow's tab and window sounds");
    console.log(`[auction] vertical boot ms ${Math.round(loaded.loadMs)}; Blizzard_AuctionUI load + gate + open ms ${Math.round(addonMs)}`);
  } finally {
    boot.close();
  }
});

test("a missing add-on or a failed gate leaves the house to the native window", withClient, async () => {
  const loaded = await load({ missingAddon: true });
  try {
    const { owner, native, failures } = await openHouse(loaded);
    assert.equal(owner.failed, true);
    assert.match(failures[0], /Blizzard_AuctionUI/);
    assert.equal(native.hidden, false);
    assert.equal(loaded.seam.auction.owned, false, "no AUCTION_HOUSE_SHOW reaches a frame that does not exist");
    assert.equal(owner.ownsWindow(), false);
    assert.equal(owner.isOpen(), false, "Escape's stock entry stays inert");
    assert.equal(frameXmlAuctionGate({}, loaded.boot, treeRenderer()), undefined, "no model, no stock house");
    assert.equal(FRAMEXML_AUCTION_ADDON, "Blizzard_AuctionUI");
  } finally {
    loaded.boot.close();
  }
});

test("a Lua error inside the gate's silent pass leaves no stock frame beside the native window", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    // Fault injection between the load and the gate (renderer.sync runs right after addRoots): the
    // pass's third tab raises after its ShowUIPanel(AuctionFrame).
    const renderer = treeRenderer();
    renderer.sync = () => lua(boot, `
      local original = AuctionFrameTab_OnClick
      AuctionFrameTab_OnClick = function(self, ...)
        if self == AuctionFrameTab3 then error("injected fault") end
        return original(self, ...)
      end`, 0);
    const { owner, native, failures } = await openHouse(loaded, renderer);
    assert.equal(owner.failed, true);
    assert.match(failures[0], /gate/);
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 0, "the pass's ShowUIPanel was undone");
    assert.deepEqual([native.hidden, native.shows], [false, 1], "the native window shows the house");
    assert.equal(seam.auction.owned, false);
    assert.deepEqual(seam.auctionWorld.calls.filter(({ kind }) => kind === "close"), [],
      "muted: AuctionFrame's OnHide did not close the house under the native window");
    assert.notEqual(seam.auctionWorld.auctioneerGuid, 0n);
    // The gate on its own ends with the frame hidden, whoever calls it.
    assert.equal(frameXmlAuctionGate(seam, boot, treeRenderer()), undefined);
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 0);
    assert.deepEqual(seam.auctionWorld.calls.filter(({ kind }) => kind === "close"), []);
  } finally {
    boot.close();
  }
});

test("a failure after the gate passed also takes the shown stock frame down and disowns the model", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    const failures = [];
    const native = { shows: 0 };
    const owner = createLazyFrameXmlAuctionOwner(seam, boot, treeRenderer(), {
      hide: () => { throw new Error("the native window is gone"); }, show: () => { native.shows += 1; },
    }, (reason) => failures.push(reason));
    seam.auctionWorld.open();
    await owner.settled;
    assert.equal(owner.failed, true);
    assert.match(failures[0], /the native window is gone/);
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 0, "the `owned` edge's AuctionFrame is hidden again");
    assert.equal(seam.auction.owned, false);
    assert.equal(native.shows, 1);
    assert.deepEqual(seam.auctionWorld.calls.filter(({ kind }) => kind === "close"), []);
  } finally {
    boot.close();
  }
});

test("teardown hides the stock window muted and hands the open house back", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    const { owner } = await openHouse(loaded);
    const world = seam.auctionWorld;
    const auctioneer = world.auctioneerGuid;
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 1);
    // The mount's cleanup (publishFrameXmlAuction's release): hide, then dispose.
    owner.hide();
    owner.dispose();
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 0);
    assert.deepEqual(world.calls.filter(({ kind }) => kind === "close"), [], "OnHide's CloseAuctionHouse was muted");
    assert.equal(world.auctioneerGuid, auctioneer, "the player still stands at the auctioneer");
    assert.equal(seam.auction.owned, false, "disposed: the model no longer hands a house to stock");
    assert.equal(owner.ownsWindow(), false);
    world.open();
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 0, "the next hello is the native window's");
  } finally {
    boot.close();
  }
});

test("item names take their quality colour: browse and bid rows and the sell slot", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  const world = seam.auctionWorld;
  try {
    await openHouse(loaded);
    const errors = boot.errorCount;
    // Each shown row: its quality, and the text colour when it is not ITEM_QUALITY_COLORS[quality].
    const tinted = (prefix, list, count, scroll) => lua(boot, `
      local out = {}
      for i = 1, ${count} do
        local button, name = _G["${prefix}" .. i], _G["${prefix}" .. i .. "Name"]
        local _, _, _, quality = GetAuctionItemInfo("${list}", FauxScrollFrame_GetOffset(${scroll}) + i)
        if button:IsShown() and quality then
          local r, g, b = name:GetTextColor()
          local c = ITEM_QUALITY_COLORS[quality]
          local same = math.abs(r - c.r) < 0.01 and math.abs(g - c.g) < 0.01 and math.abs(b - c.b) < 0.01
          out[#out + 1] = quality .. (same and "" or string.format("~%.2f,%.2f,%.2f", r, g, b))
        end
      end
      return table.concat(out, ";")`)[0];
    lua(boot, "AuctionFrameBrowse_Search()", 0);
    world.deliverList();
    assert.equal(tinted("BrowseButton", "list", 8, "BrowseScrollFrame"), "1;1;1;1;1;1;2;2",
      "quality up: six common lots, then the uncommon ones in green");
    // The Bids tab with an uncommon lot (Тигровый глаз).
    world.deliverBidder({ searchDelay: 300, totalCount: 2, entries: [world.search({}).entries[4], world.search({}).entries[1]] });
    lua(boot, "AuctionFrameTab_OnClick(AuctionFrameTab2)", 0);
    assert.equal(tinted("BidButton", "bidder", 9, "BidScrollFrame"), "1;2");
    // The sell slot, with the uncommon tigerseyes in it.
    lua(boot, "AuctionFrameTab_OnClick(AuctionFrameTab3)", 0);
    world.cursor = { guid: 0x4000_0105n, bag: 255, slot: 27 };
    lua(boot, "AuctionsItemButton:Click()", 0);
    assert.equal(lua(boot, `local r, g, b = AuctionsItemButtonName:GetTextColor() local c = ITEM_QUALITY_COLORS[2]
      return (math.abs(r - c.r) < 0.01 and math.abs(g - c.g) < 0.01 and math.abs(b - c.b) < 0.01) and 1 or 0`)[0], 1);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("browse: the filter tree, a search, bid and buyout behind their popups, pages and a sort click", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  const world = seam.auctionWorld;
  try {
    await openHouse(loaded);
    const errors = boot.errorCount;
    world.deliverBidder();
    world.deliverOwner();
    assert.deepEqual(lua(boot, "return AuctionFilterButton1:GetText(), AuctionFilterButton2:GetText(), AuctionFilterButton12:GetText(), AuctionFilterButton13:IsShown() and 1 or 0", 4),
      ["Оружие", "Доспехи", "Задания", 0]);
    // Доспехи → Тканевые: the subclass rows, then the Cloth slot rows with Back last.
    lua(boot, "AuctionFrameFilter_OnClick(AuctionFilterButton2) AuctionFrameFilter_OnClick(AuctionFilterButton4)", 0);
    const shown = lua(boot, `local out = {} for i = 1, 15 do local b = _G["AuctionFilterButton"..i] if b:IsShown() then out[#out + 1] = b:GetText() end end return table.concat(out, ";")`)[0]
      .replace(/\|c[0-9a-f]{8}/gi, "").replace(/\|r/g, "");
    assert.equal(shown, `Оружие;Доспехи;Разное;Тканевые;${lua(boot, `return INVTYPE_HEAD, INVTYPE_SHOULDER, INVTYPE_CHEST, INVTYPE_WAIST,
      INVTYPE_LEGS, INVTYPE_FEET, INVTYPE_WRIST, INVTYPE_HAND, INVTYPE_CLOAK`, 9).join(";")};Кожаные;Кольчужные`,
    "Доспехи open, Тканевые open with its nine slots and Back last; the list scrolls past the fifteenth row");
    lua(boot, `for i = 1, 15 do local b = _G["AuctionFilterButton"..i] if b:IsShown() and b.type == "invtype" and b.index == 13 then AuctionFrameFilter_OnClick(b) end end`, 0);
    lua(boot, `BrowseName:SetText("плащ") BrowseMinLevel:SetText("10") IsUsableCheckButton:SetChecked(1) UIDropDownMenu_SetSelectedValue(BrowseDropDown, 2) AuctionFrameBrowse_Search()`, 0);
    assert.deepEqual(world.calls.at(-1), { kind: "search", search: {
      name: "плащ", levelMin: 10, inventoryType: 16, itemClass: 4, itemSubClass: 1, page: 0, quality: 2, usableOnly: true,
    } });
    assert.deepEqual(lua(boot, "return BrowseSearchButton:IsEnabled(), BrowseNoResultsText:GetText()", 2).slice(0, 1), [1],
      "the button greys on its next OnUpdate; CanSendAuctionQuery already refuses");
    assert.deepEqual(lua(boot, "return CanSendAuctionQuery('list')"), [undefined]);
    lua(boot, "AuctionFrameBrowse_Reset(BrowseResetButton)", 0);
    world.deliverList();
    assert.deepEqual(lua(boot, "return BrowseButton1Name:GetText(), BrowseButton1Level:GetText(), BrowseButton1HighBidder:GetText(), BrowseButton1YourBidText:IsShown() and 1 or 0, BrowseButton1ClosingTimeText:GetText()", 5),
      ["Огромный флакон с лечебным зельем", "45", "Мираэль", 1, lua(boot, "return AUCTION_TIME_LEFT1")[0]],
      "quality up, level down: the potion the player leads is first");
    // Bid on the linen lot (row 4: 20 × linen, 3 c.) through BID_AUCTION.
    lua(boot, "BrowseButton_OnClick(BrowseButton4)", 0);
    assert.deepEqual(lua(boot, "return GetSelectedAuctionItem('list'), BrowseBidButton:IsEnabled(), BrowseBuyoutButton:IsEnabled(), MoneyInputFrame_GetCopper(BrowseBidPrice)", 4), [4, 1, 1, 300]);
    lua(boot, "BrowseBidButton:Click()", 0);
    assert.equal(world.calls.at(-1).kind, "search", "the popup asks first");
    lua(boot, "StaticPopup_OnClick(_G[StaticPopup_Visible('BID_AUCTION')], 1)", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "bid", auctionId: 3001, price: 300 });
    world.answer(AUCTION_PLACE_BID, 0, 3001);
    // Buyout the silk (row 6) through BUYOUT_AUCTION; the player's own runecloth offers neither.
    lua(boot, "BrowseButton_OnClick(BrowseButton6) BrowseBuyoutButton:Click()", 0);
    lua(boot, "StaticPopup_OnClick(_G[StaticPopup_Visible('BUYOUT_AUCTION')], 1)", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "bid", auctionId: 3002, price: 3000 });
    lua(boot, "BrowseButton_OnClick(BrowseButton5)", 0);
    assert.deepEqual(lua(boot, "return BrowseBidButton:IsEnabled(), BrowseBuyoutButton:IsEnabled()", 2), [0, 0]);
    // A sort click re-searches (the client sends its sort, which TrinityCore ignores) and sorts the page.
    await new Promise((resolve) => setTimeout(resolve, 350)); // the canned house's 300 ms search delay
    lua(boot, "AuctionFrame_OnClickSortColumn('list', 'bid')", 0);
    assert.equal(world.calls.at(-1).kind, "search");
    world.deliverList();
    assert.deepEqual(lua(boot, "return GetAuctionSort('list', 1)", 2), ["bid", undefined]);
    assert.equal(lua(boot, "return BrowseButton1Name:GetText()")[0], "Льняной материал", "the 1 s 20 c linen is the cheapest current bid");
    // Sixty results: the pager lights up and «Next» asks for page 1.
    world.deliverList({ searchDelay: 300, totalCount: 60, entries: world.search({}).entries });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(lua(boot, "return BrowseNextPageButton.isEnabled and 1 or 0, BrowsePrevPageButton.isEnabled and 1 or 0", 2), [1, 0]);
    lua(boot, "BrowseNextPageButton:Click()", 0);
    assert.equal(world.calls.at(-1).search.page, 1);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("Bids and Auctions tabs: statuses, a sell slot, the deposit, a multisell with progress, and a cancel", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  const world = seam.auctionWorld;
  try {
    await openHouse(loaded);
    const errors = boot.errorCount;
    world.deliverBidder();
    world.deliverOwner();
    lua(boot, "AuctionFrameTab_OnClick(AuctionFrameTab2)", 0);
    const bid = (i) => lua(boot, `return BidButton${i}:IsShown() and 1 or 0, BidButton${i}Name:GetText(), BidButton${i}BidStatus:GetText()`, 3);
    assert.deepEqual(bid(1), [1, "Огромный флакон с лечебным зельем", `|cff20ff20${lua(boot, "return HIGH_BIDDER")[0]}|r`]);
    assert.deepEqual(bid(2), [1, "Шелковый материал", `|cffff2020${lua(boot, "return OUTBID")[0]}|r`]);
    // Outbid on the silk: the bid field offers bid + increment.
    lua(boot, "BidButton_OnClick(BidButton2)", 0);
    assert.deepEqual(lua(boot, "return BidBidButton:IsEnabled(), MoneyInputFrame_GetCopper(BidBidPrice)", 2), [1, 1575]);
    lua(boot, "BidBidButton:Click()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "bid", auctionId: 3002, price: 1575 });

    lua(boot, "AuctionFrameTab_OnClick(AuctionFrameTab3)", 0);
    assert.deepEqual(lua(boot, "return AuctionsButton1Name:GetText(), AuctionsButton1HighBidder:GetText(), AuctionsButton2HighBidder:GetText()", 3),
      ["Руническая ткань", `|cffff2020${lua(boot, "return NO_BIDS")[0]}|r`, "Торвальд"]);
    // The linen stack onto the sell slot: 47 carried, stock's opening price and the deposit floor.
    world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
    lua(boot, "AuctionsItemButton:Click()", 0);
    assert.equal(world.cursor, undefined);
    assert.deepEqual(lua(boot, `return AuctionsItemButtonName:GetText(), AuctionsItemButtonCount:GetText(), AuctionsStackSizeEntry:GetNumber(),
      AuctionsNumStacksEntry:GetNumber(), MoneyInputFrame_GetCopper(StartPrice), AuctionsCreateAuctionButton:IsEnabled(),
      AuctionsDepositMoneyFrame.staticMoney`, 7), ["Льняной материал", "47", 20, 1, 390, 1, 100]);
    // «Максимум»: 20 × 2 of 47, and the deposit follows (the post-hook for OnTextChanged).
    lua(boot, "AuctionsNumStacksMaxButton:Click()", 0);
    assert.deepEqual(lua(boot, "return AuctionsStackSizeEntry:GetNumber(), AuctionsNumStacksEntry:GetNumber(), AuctionsDepositMoneyFrame.staticMoney", 3),
      [20, 2, 156], "floor(5 × 13 × 40 / 100) × 6");
    lua(boot, "AuctionsStackSizeEntry:SetNumber(10) AuctionsNumStacksEntry:SetNumber(3) UpdateDeposit() AuctionsFrameAuctions_ValidateAuction()", 0);
    lua(boot, "AuctionsCreateAuctionButton:Click()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "sell", items: [{ guid: 0x4000_0101n, count: 10 }], startBid: 390, buyout: 0, minutes: 1440 });
    const progress = () => lua(boot, "return AuctionsBlockFrame:IsShown() and 1 or 0, AuctionProgressFrame:IsShown() and 1 or 0, AuctionProgressBarText:GetText()", 3);
    assert.deepEqual(progress(), [1, 1, "Прогресс: 0/3"], "AUCTION_MULTISELL_START's arg1 reaches the stock handler");
    // The shown bar's frames tick: its empty OnUpdate must not run the inherited casting-bar update.
    for (let frame = 0; frame < 5; frame += 1) boot.bridge.tick(0.05);
    assert.equal(boot.errorCount, errors, `no CastingBarFrame_OnUpdate on AuctionProgressBar: ${JSON.stringify(boot.errors.slice(-2))}`);
    world.answer(AUCTION_SELL_ITEM, 0, 3200);
    assert.deepEqual(progress(), [1, 1, "Прогресс: 1/3"]);
    world.answer(AUCTION_SELL_ITEM, 0, 3201);
    world.answer(AUCTION_SELL_ITEM, 0, 3202);
    assert.deepEqual(progress().slice(0, 1).concat(progress().slice(2)), [0, "Прогресс: 3/3"], "the block lifts when every lot is posted");
    assert.deepEqual(world.calls.filter(({ kind }) => kind === "sell").map(({ items }) => items), [
      [{ guid: 0x4000_0101n, count: 10 }], [{ guid: 0x4000_0101n, count: 10 }], [{ guid: 0x4000_0102n, count: 10 }],
    ]);
    assert.equal(lua(boot, "return AuctionsItemButtonName:GetText()")[0], "", "the slot is empty again");
    // Cancel the linen lot Торвальд bid on: CANCEL_AUCTION with the 5% cut, then the request.
    lua(boot, "AuctionsButton_OnClick(AuctionsButton2)", 0);
    assert.deepEqual(lua(boot, "return AuctionsCancelAuctionButton:IsEnabled(), AuctionFrameAuctions.cancelPrice", 2), [1, 13]);
    lua(boot, "AuctionsCancelAuctionButton:Click()", 0);
    lua(boot, "StaticPopup_OnClick(_G[StaticPopup_Visible('CANCEL_AUCTION')], 1)", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "cancel", auctionId: 3011 });
    world.answer(AUCTION_CANCEL, 0, 3011);
    // Closing the window closes the house, and nothing raised along the way.
    lua(boot, "AuctionFrameCloseButton:Click()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "close" });
    assert.equal(world.auctioneerGuid, 0n);
    // The next auctioneer: the loaded add-on opens at once, on the Browse tab, and asks for both lists.
    world.calls.length = 0;
    world.open();
    assert.deepEqual(lua(boot, "return AuctionFrame:IsShown() and 1 or 0, AuctionFrameBrowse:IsShown() and 1 or 0, AuctionsItemButtonName:GetText()", 3),
      [1, 1, ""]);
    assert.deepEqual(world.calls, [{ kind: "bidder" }, { kind: "owner" }], "AuctionFrame_Show's two requests, once");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("hovering a row or the sell slot gives GameTooltip the item, without a Lua error", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    await openHouse(loaded);
    const errors = boot.errorCount;
    lua(boot, "AuctionFrameBrowse_Search()", 0);
    seam.auctionWorld.deliverList();
    lua(boot, `AuctionFrameItem_OnEnter(BrowseButton1Item, "list", 1)`, 0);
    assert.deepEqual(lua(boot, "return GameTooltip:IsShown() and 1 or 0, GameTooltipTextLeft1:GetText()", 2), [1, "Огромный флакон с лечебным зельем"]);
    lua(boot, "GameTooltip:Hide() AuctionFrameTab_OnClick(AuctionFrameTab3)", 0);
    seam.auctionWorld.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
    lua(boot, "AuctionsItemButton:Click() AuctionsItemButton:GetScript('OnEnter')(AuctionsItemButton)", 0);
    assert.deepEqual(lua(boot, "return GameTooltip:IsShown() and 1 or 0, GameTooltipTextLeft1:GetText()", 2), [1, "Льняной материал"]);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});
