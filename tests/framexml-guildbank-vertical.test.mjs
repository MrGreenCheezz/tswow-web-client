import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the real load-on-demand Blizzard_GuildBankUI over the production vertical and the canned
// vault (FrameXmlGuildBankCanned.ts). The add-on is loaded the way the world mount loads it — the lazy
// owner's boot.loadAddon, gate and `owned` edge — and then driven through the stock Lua: the tabs, the
// item and money logs, the tab text, the buy screen, the vault cursor (pick up, move, split, into a
// bag slot), money in and out behind their StaticPopups, the tab icon picker and the close.
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
const { createLazyFrameXmlGuildBankOwner, frameXmlGuildBankGate } = await import("../dist/code/browser/framexml/FrameXmlGuildBankOwner.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_guildbankui/";

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
  await boot.load();
  return { boot, seam, requests, loadMs: performance.now() - started };
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
  const fn = boot.vm.compileFunction(code, "guildbank-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

/** The world mount's route: the lazy owner, the vault's activation (the model's tick sees it), its answer. */
async function openVault(loaded, renderer = treeRenderer()) {
  const native = { hidden: false, shows: 0 };
  const failures = [];
  const owner = createLazyFrameXmlGuildBankOwner(loaded.seam, loaded.boot, renderer, {
    hide: () => { native.hidden = true; }, show: () => { native.shows += 1; native.hidden = false; },
  }, (reason) => failures.push(reason));
  loaded.seam.guildBankWorld.open();
  loaded.seam.guildBank.tick();
  const pending = owner.isOpen();
  loaded.seam.guildBankWorld.answerOpen();
  await owner.settled;
  return { owner, native, failures, pending };
}

test("Blizzard_GuildBankUI costs nothing at boot and loads its four files on the first vault", withClient, async () => {
  const loaded = await load();
  const { boot, seam, requests } = loaded;
  try {
    assert.equal(boot.bridge.getFrame("GuildBankFrame")?.name, undefined, "the vertical does not carry the LoD add-on");
    assert.equal(requests.some((path) => path.startsWith(ADDON_PREFIX)), false, "no add-on file is read at boot");
    const updateHandlers = boot.bridge.tick(1 / 60);
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const started = performance.now();
    const { owner, native, failures, pending } = await openVault(loaded);
    const addonMs = performance.now() - started;
    assert.equal(pending, true, "the load is in flight: the owner reports the vault open");
    assert.deepEqual(failures, []);
    assert.equal(owner.loaded, true);
    assert.deepEqual([...new Set(requests.filter((path) => path.startsWith(ADDON_PREFIX)))].sort(), [
      "blizzard_guildbankui.lua", "blizzard_guildbankui.toc", "blizzard_guildbankui.xml", "localization.lua",
    ].map((file) => ADDON_PREFIX + file), "exactly the add-on's own TOC closure, nothing of the base corpus");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-3))}`);
    assert.equal(boot.bridge.diagnostics.length, diagnostics);
    assert.deepEqual(lua(boot, "return GuildBankFrame:IsShown() and 1 or 0, GuildBankFrame.mode, GetCurrentGuildBankTab()", 3), [1, "bank", 1],
      "the `owned` edge's GUILDBANKFRAME_OPENED opened the vault UIParent-style");
    assert.equal(native.hidden, true, "the native window stepped aside only after the gate");
    assert.deepEqual(seam.guildBankWorld.calls, [{ kind: "queryTab", tab: 0 }],
      "OnShow asked for the shown tab once; the gate's muted tab visits asked nothing");
    assert.deepEqual(sounds, ["igCharacterInfoTab", "GuildVaultOpen"],
      "the silent gate played nothing; the real open played GuildBankFrame_OnShow's tab and vault sounds");
    assert.deepEqual(lua(boot, "return GuildBankTabTitle:GetText(), GuildBankLimitLabel:GetText(), GuildBankColumn1Button1IconTexture:GetTexture(), GuildBankColumn1Button1Count:GetText()", 4), [
      "Общее  |cff20ff20(полный доступ)|r", "Остаток дневного лимита снятия для \"Общее\": |cffffffffнеогр.|r",
      "Interface\\Icons\\INV_Fabric_Linen_01", "20",
    ], "the tab title with its access, the withdrawals left, the first slot's icon and count (ruRU GlobalStrings)");
    assert.equal(lua(boot, "return GuildBankTab3:IsShown() and 1 or 0, GuildBankTab4:IsShown() and 1 or 0", 2).join(), "1,0",
      "two tabs bought: the guild master sees the third as the buy tab");
    assert.equal(boot.bridge.tick(1 / 60), updateHandlers,
      "the 98 slot buttons' comment-only OnUpdate is out of the per-frame dispatch (it took 32 handlers to 130)");
    assert.deepEqual(lua(boot, "return GuildBankColumn1Button1:GetScript('OnUpdate') == nil and 1 or 0, GuildBankColumn7Button14:GetScript('OnUpdate') == nil and 1 or 0", 2), [1, 1]);
    console.log(`[guildbank] vertical boot ms ${Math.round(loaded.loadMs)}; Blizzard_GuildBankUI load + gate + open ms ${Math.round(addonMs)}`);
  } finally {
    boot.close();
  }
});

test("a missing add-on or a failed gate leaves the vault to the native window", withClient, async () => {
  const missing = await load({ missingAddon: true });
  try {
    const { owner, native, failures } = await openVault(missing);
    assert.equal(owner.loaded, false);
    assert.equal(owner.failed, true);
    assert.equal(failures.length, 1);
    assert.equal(native.hidden, false, "the native window never stepped aside");
    assert.equal(missing.seam.guildBank.owned, false);
    assert.equal(owner.isOpen(), false, "a failed owner answers for nothing: the native window keeps Escape");
  } finally {
    missing.boot.close();
  }
  const sabotaged = await load();
  try {
    // The gate reads GuildBankColumn1Button1's OnClick: take it away after the load, as a broken script would.
    const renderer = treeRenderer();
    const loadAddon = sabotaged.boot.loadAddon.bind(sabotaged.boot);
    sabotaged.boot.loadAddon = async (name) => {
      const result = await loadAddon(name);
      lua(sabotaged.boot, "GuildBankColumn1Button1:SetScript('OnClick', nil)");
      return result;
    };
    const { owner, native, failures } = await openVault(sabotaged, renderer);
    assert.equal(owner.failed, true);
    assert.match(failures[0], /did not pass its gate/);
    assert.equal(native.hidden, false);
    assert.equal(lua(sabotaged.boot, "return GuildBankFrame:IsShown() and 1 or 0")[0], 0, "no stock frame beside the native window");
    assert.equal(frameXmlGuildBankGate(sabotaged.seam, sabotaged.boot, renderer), undefined);
    assert.notEqual(sabotaged.seam.guildBankWorld.guildBankerGuid, 0n, "the failed gate closed nothing");
  } finally {
    sabotaged.boot.close();
  }
});

test("the stock vault: logs, tab text, the buy screen, the cursor, money popups, the icon picker, the close", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  const world = seam.guildBankWorld;
  const run = (code, results) => lua(boot, code, results);
  try {
    await openVault(loaded);
    const errors = boot.errorCount;
    // OnShow's QueryGuildBankTab(1) is answered: tab 0 in full, with the tab list (GUILDBANK_UPDATE_TABS).
    world.deliverTab(0);
    world.autoAnswer = true;
    run("GuildBankFrameTab_OnClick(GuildBankFrameTab2, 2)");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "log", tab: 0 });
    assert.deepEqual(run("return GuildBankFrame.mode, GetNumGuildBankTransactions(1), GuildBankMessageFrame:GetNumMessages(), GuildBankTabTitle:GetText()", 4),
      ["log", 5, 5, "Журнал \"Общее\"  |cff20ff20(полный доступ)|r"], "the item log's five lines");
    run("GuildBankFrameTab_OnClick(GuildBankFrameTab3, 3)");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "log", tab: 6 }, "MAX_GUILDBANK_TABS + 1 is TrinityCore's money log");
    // Info left before its MSG_QUERY_GUILD_BANK_TEXT answer: OnHide's Save sees `"" ~= nil`; nothing is sent.
    run("GuildBankFrameTab_OnClick(GuildBankFrameTab4, 4) GuildBankFrameTab_OnClick(GuildBankFrameTab3, 3)");
    await settle();
    assert.deepEqual(world.calls.slice(-2), [{ kind: "text", tab: 0 }, { kind: "log", tab: 6 }],
      "an empty text over an unanswered tab would wipe it for the guild");
    assert.deepEqual(run("return GuildBankFrame.mode, GuildBankMessageFrame:GetNumMessages(), GuildBankTab1Button:IsEnabled()", 3),
      ["moneylog", 5, 0], "every tab button is off in the money log (IsEnabled answers 0/1 in 3.3.5)");
    assert.deepEqual(run("return GetDenominationsFromCopper(500000), GetDenominationsFromCopper(1234567), GetDenominationsFromCopper(0)", 3), [
      "50 |4золотая:золотые:золотых;",
      "123 |4золотая:золотые:золотых; 45 |4серебряная:серебряные:серебряных; 67 |4медная монета:медные монеты:медных монет;",
      "0 |4медная монета:медные монеты:медных монет;",
    ], "the money log's amounts: GetCoinText through MoneyFrame.lua, not nil");
    run("GuildBankFrameTab_OnClick(GuildBankFrameTab4, 4)");
    await settle();
    assert.deepEqual(run("return GuildBankInfo:IsShown() and 1 or 0, GuildBankTabInfoEditBox:GetText(), GuildBankInfoSaveButton:IsShown() and 1 or 0", 3),
      [1, "Общие материалы гильдии.\nБерите для профессий, возвращайте излишки.", 1], "GUILDBANK_UPDATE_TEXT filled the text box");
    run("GuildBankTabInfoEditBox:SetText('Новый текст') GuildBankInfoSaveButton:Click()");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "setText", tab: 0, text: "Новый текст" });
    run("GuildBankFrameTab_OnClick(GuildBankFrameTab1, 1)");
    await settle();
    run("GuildBankTab3Button:Click()");
    await settle();
    assert.deepEqual(run("return GetCurrentGuildBankTab(), GuildBankFrameBuyInfo:IsShown() and 1 or 0, GetGuildBankTabCost(), GuildBankFramePurchaseButton:IsEnabled()", 4),
      [3, 1, 5_000_000, 1], "the third tab costs 500 gold; the player's and the bank's money cover it");
    run("GuildBankTab1Button:Click()");
    await settle();

    // The vault cursor: a stack picked up locks its slot; a click on another slot moves it there.
    run("GuildBankColumn1Button1:Click('LeftButton')");
    assert.deepEqual(run("return CursorHasItem() and 1 or 0, GetCursorInfo()", 3), [1, "item", 2589]);
    assert.equal(run("return select(3, GetGuildBankItemInfo(1, 1))")[0], 1);
    run("GuildBankColumn1Button6:Click('LeftButton')");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "move", fromTab: 0, fromSlot: 0, fromItemId: 2589, toTab: 0, toSlot: 5, toItemId: 0, split: 0 });
    assert.deepEqual(run("return CursorHasItem() and 1 or 0, GuildBankColumn1Button6Count:GetText()", 2), [0, "20"],
      "the answering partial list repainted slot 6");
    // StackSplitFrame's OK splits onto the cursor; a click on a bag slot drops exactly there.
    run("OpenStackSplitFrame(20, GuildBankColumn1Button6, 'BOTTOMLEFT', 'TOPLEFT') StackSplitFrame.split = 5 StackSplitOkayButton:Click()");
    run("PickupContainerItem(0, 3)");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "withdrawTo", tab: 0, slot: 5, itemId: 2589, bag: 255, bagSlot: 25, split: 5 });
    assert.equal(run("return select(2, GetGuildBankItemInfo(1, 6))")[0], 15);
    run("GuildBankColumn1Button2:Click('RightButton')");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "autoStore", tab: 0, slot: 1, itemId: 2589 });
    run("GuildBankColumn1Button6:GetScript('OnEnter')(GuildBankColumn1Button6)");
    assert.deepEqual(run("return GameTooltip:IsShown() and 1 or 0, GameTooltipTextLeft1:GetText()", 2), [1, "Льняной материал"],
      "GameTooltip:SetGuildBankItem (the in-lane fallback until GlueWidgets has it)");
    run("GameTooltip:Hide()");

    // Money in and out through stock's own StaticPopups.
    run("GuildBankFrameDepositButton:Click()");
    run("local f = _G[StaticPopup_Visible('GUILDBANK_DEPOSIT')] MoneyInputFrame_SetCopper(f.moneyInputFrame, 12345) StaticPopup_OnClick(f, 1)");
    await settle();
    assert.deepEqual(world.calls.slice(-2), [{ kind: "deposit", copper: 12345 }, { kind: "withdrawn" }],
      "GE_BANK_MONEY_SET answered it and the open vault asked its allowance again");
    const total = run("return GetGuildBankMoney()")[0];
    run("GuildBankFrameWithdrawButton:Click()");
    run("local f = _G[StaticPopup_Visible('GUILDBANK_WITHDRAW')] MoneyInputFrame_SetCopper(f.moneyInputFrame, 10000) StaticPopup_OnClick(f, 1)");
    await settle();
    assert.equal(run("return GetGuildBankMoney()")[0], total - 10000);

    // The guild master's right click on a tab opens the icon picker; OK renames it.
    run("GuildBankTab2Button:Click('RightButton')");
    await settle();
    assert.deepEqual(run("return GuildBankPopupFrame:IsShown() and 1 or 0, GuildBankPopupEditBox:GetText()", 2), [1, "Рейд"]);
    run("GuildBankPopupEditBox:SetText('Эликсиры') GuildBankPopupOkayButton:Click()");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "rename", tab: 1, name: "Эликсиры", icon: "INV_Potion_54" });
    assert.equal(run("return (GetGuildBankTabInfo(2))")[0], "Эликсиры", "GE_BANK_TAB_UPDATED renamed it");
    // The picker's grid is the macro item icons (the gateway's /dbc list live; the canned macro fixture
    // has none, so three are given here): the tab's own icon is preselected, a clicked one is sent by name.
    const itemIcons = ["Interface\\Icons\\INV_Fabric_Linen_01", "Interface\\Icons\\INV_Potion_54", "Interface\\Icons\\INV_Misc_Gem_Opal_03"];
    seam.macros.itemIconCount = () => itemIcons.length;
    seam.macros.itemIcon = (index) => itemIcons[Math.trunc(Number(index)) - 1];
    run("GuildBankTab2Button:Click('RightButton')");
    await settle();
    assert.deepEqual(run(`return GuildBankPopupFrame.selectedIcon, GuildBankPopupButton2:GetChecked() and 1 or 0,
      GuildBankPopupButton3Icon:GetTexture(), GuildBankPopupButton3:IsShown() and 1 or 0, GuildBankPopupButton4:IsShown() and 1 or 0`, 5),
    [2, 1, "Interface\\Icons\\INV_Misc_Gem_Opal_03", 1, 0], "INV_Potion_54 found in the list; three buttons shown");
    run("GuildBankPopupButton3:Click() GuildBankPopupOkayButton:Click()");
    await settle();
    assert.deepEqual(world.calls.at(-1), { kind: "rename", tab: 1, name: "Эликсиры", icon: "INV_Misc_Gem_Opal_03" });
    assert.deepEqual(run("return GetGuildBankTabInfo(2)", 2), ["Эликсиры", "Interface\\Icons\\INV_Misc_Gem_Opal_03"]);

    // Buying the third tab through CONFIRM_BUY_GUILDBANK_TAB.
    run("GuildBankTab3Button:Click()");
    await settle();
    run("GuildBankFramePurchaseButton:Click()");
    run("local f = _G[StaticPopup_Visible('CONFIRM_BUY_GUILDBANK_TAB')] StaticPopup_OnClick(f, 1)");
    await settle();
    assert.ok(world.calls.some((entry) => entry.kind === "buy" && entry.tab === 2));
    assert.deepEqual(run("return GetNumGuildBankTabs(), GuildBankTab4:IsShown() and 1 or 0, GetGuildBankTabCost()", 3), [3, 1, 10_000_000]);
    assert.equal(boot.errorCount, errors, `no Lua error through the whole visit: ${JSON.stringify(boot.errors.slice(-3))}`);

    run("HideUIPanel(GuildBankFrame)");
    await settle();
    assert.equal(world.guildBankerGuid, 0n, "OnHide → CloseGuildBankFrame let the banker go");
    assert.deepEqual(world.calls.at(-1), { kind: "close" });
    assert.equal(run("return GuildBankFrame:IsShown() and 1 or 0")[0], 0);
    world.open();
    world.answerOpen();
    await settle();
    assert.equal(run("return GuildBankFrame:IsShown() and 1 or 0")[0], 1, "the next visit opens straight into stock");
    world.closeGuildBank();
    seam.guildBank.tick();
    assert.equal(run("return GuildBankFrame:IsShown() and 1 or 0")[0], 0, "a close with no packet (native, relog) hides it through GUILDBANKFRAME_CLOSED");
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});
