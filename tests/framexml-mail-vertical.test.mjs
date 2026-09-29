import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock MailFrame.xml and TradeFrame.xml in the production vertical, driven over the
// canned mailbox. Everything here runs the real 3.3.5 Lua — the inbox rows, the letter, the send
// form, the StaticPopup confirmations — against FrameXmlMail.ts's C API.
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

// The world mount module reads `document`/`window` at import; its bag gate installs the production
// InterfaceOptionsFrame stand-in that OpenBackpack's IsOptionFrameOpen() reads on MAIL_SHOW.
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
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { frameXmlMailCorpusSource } = await import("../dist/code/browser/framexml/FrameXmlMailCorpus.js");
const { createFrameXmlMailOwner, frameXmlMailGate } = await import("../dist/code/browser/framexml/FrameXmlMailOwner.js");
const { frameXmlTradeGate } = await import("../dist/code/browser/framexml/FrameXmlTradeOwner.js");
const { frameXmlBagGate } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const { MAIL_SEND } = await import("../dist/code/world/MailProtocol.js");
const { frameXmlCannedMailList, FRAMEXML_CANNED_MAIL_ITEMS } = await import("../dist/code/browser/framexml/FrameXmlMailCanned.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const OWN_FILES = ["tradeframe.xml", "mailframe.xml"];

async function load(subset = FRAMEXML_VERTICAL_TOC, seam = new CannedWorldSeam()) {
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  const inventory = await boot.load();
  return { boot, seam, inventory, requests, loadMs: performance.now() - started };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "mail-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A renderer stand-in whose element tree mirrors the frame tree, as FrameXmlDomRenderer's does. */
function treeRenderer() {
  const elements = new Map();
  const elementFor = (frame) => {
    if (!frame) return null;
    if (!elements.has(frame)) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      elements.set(frame, { dataset: {}, get parentElement() { return elementFor(frame.parent); },
        getAttribute: (name) => attributes.get(name) ?? null });
    }
    return elements.get(frame);
  };
  return { elementFor };
}

const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
  widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
  luaFailed: inventory.lua.failed });
const deltaOf = (before, after) => Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));

test("TradeFrame and MailFrame keep their retail TOC order; the closure adds four files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  // Every vertical entry the retail TOC also lists appears in the retail order around the two files.
  for (const file of OWN_FILES) {
    const at = vertical.indexOf(file);
    assert.ok(at > 0, `${file} is in the vertical`);
    const retail = toc.indexOf(file);
    const before = vertical.slice(0, at).filter((entry) => toc.includes(entry));
    const afterEntries = vertical.slice(at + 1).filter((entry) => toc.includes(entry));
    assert.ok(before.every((entry) => toc.indexOf(entry) < retail), `${file}: nothing after it in retail precedes it`);
    assert.ok(afterEntries.every((entry) => toc.indexOf(entry) > retail), `${file}: nothing before it in retail follows it`);
  }
  assert.equal(toc.indexOf("tradeframe.xml"), toc.indexOf("merchantframe.xml") + 1, "retail TOC 94 → 95");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => !OWN_FILES.includes(normalize(entry))));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("MailFrame")?.name, undefined);
    const added = [...candidate.requests].filter((path) => !baseline.requests.has(path)).sort();
    assert.deepEqual(added, ["interface/framexml/mailframe.lua", "interface/framexml/mailframe.xml",
      "interface/framexml/tradeframe.lua", "interface/framexml/tradeframe.xml"]);
    // MailFrame.xml is served with its tab template renamed only while FriendsFrame.xml is absent
    // (FrameXmlMailCorpus.ts): «CharacterFrameTabButtonTemplate» is 8 bytes longer, twice.
    const friends = FRAMEXML_VERTICAL_TOC.some((entry) => normalize(entry) === "friendsframe.xml");
    const delta = deltaOf(metric(baseline.inventory), metric(candidate.inventory));
    // 957 widgets since the runtime merges a template's <ButtonText> into the button's own text
    // (FrameXmlUiBridge.mergeButtonText): TradeFrameTradeButton and TradeFrameCancelButton each
    // carried a second, anonymous FontString before (959 measured then).
    assert.deepEqual(delta, { files: 4, bytes: 130_023 + (friends ? 0 : 16), widgets: 957, errors: 0, distinct: 0, luaFailed: 0 },
      `mail/trade closure delta ${JSON.stringify(delta)}`);
    for (const name of ["MailFrame", "OpenMailFrame", "StationeryPopupFrame", "TradeFrame"]) {
      const frame = candidate.boot.bridge.getFrame(name);
      assert.equal(frame?.parent?.name, "UIParent", `${name} is a UIParent child, not a root to admit`);
      assert.equal(frame.visible, false, `${name} loads hidden`);
    }
    console.log(`[mail] load ms baseline ${Math.round(baseline.loadMs)} candidate ${Math.round(candidate.loadMs)}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("without FriendsFrame.xml the mail tabs still exist: the stock template is served by its base", withClient, async () => {
  // Unit: only MailFrame.xml changes, only its two tab declarations, only when FriendsFrame is absent.
  const source = { async read(path) { return normalize(path).endsWith("mailframe.xml")
    ? '<Button name="MailFrameTab1" inherits="FriendsFrameTabTemplate"/><Button inherits="FriendsFrameTabTemplate"/>'
    : "other"; } };
  const served = frameXmlMailCorpusSource(source, ["MailFrame.xml"]);
  assert.equal(await served.read("Interface\\FrameXML\\MailFrame.xml"),
    '<Button name="MailFrameTab1" inherits="CharacterFrameTabButtonTemplate"/><Button inherits="CharacterFrameTabButtonTemplate"/>');
  assert.equal(await served.read("interface/framexml/other.xml"), "other");
  assert.equal(frameXmlMailCorpusSource(source, ["FriendsFrame.xml", "MailFrame.xml"]), source);
  assert.equal(frameXmlMailCorpusSource(source, ["GossipFrame.xml"]), source);
  // MPQ: the vertical without the social frames, with and without the two mail/trade entries.
  const withoutFriends = FRAMEXML_VERTICAL_TOC.filter((entry) => !["friendsframe.xml", "raidframe.xml"].includes(normalize(entry)));
  let baseline;
  let candidate;
  try {
    baseline = await load(withoutFriends.filter((entry) => !OWN_FILES.includes(normalize(entry))));
    candidate = await load(withoutFriends);
    const delta = deltaOf(metric(baseline.inventory), metric(candidate.inventory));
    assert.deepEqual({ errors: delta.errors, distinct: delta.distinct, luaFailed: delta.luaFailed },
      { errors: 0, distinct: 0, luaFailed: 0 }, `no Lua error from MailFrame without FriendsFrame: ${JSON.stringify(delta)}`);
    assert.equal(candidate.boot.bridge.diagnostics.filter(({ message }) => /FriendsFrameTabTemplate/.test(message)).length, 0);
    assert.equal(candidate.boot.bridge.getFrame("MailFrameTab2")?.type, "Button");
    assert.ok(candidate.boot.bridge.getFrame("MailFrame").registeredEvents.has("MAIL_SHOW"),
      "MailFrame_OnLoad ran to its RegisterEvent calls");
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the gates prove MailFrame and TradeFrame silently: no packet, no sound, both end hidden", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    seam.mailWorld.open();
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const mail = frameXmlMailGate(seam, boot, treeRenderer());
    const trade = frameXmlTradeGate(seam, boot, treeRenderer());
    assert.ok(mail, "the stock mailbox tree passes");
    assert.ok(trade, "the stock trade tree passes");
    assert.deepEqual([mail.frame.name, mail.open.name, trade.frame.name], ["MailFrame", "OpenMailFrame", "TradeFrame"]);
    assert.equal(mail.frame.visible || trade.frame.visible, false, "both probes end hidden");
    assert.deepEqual(seam.mailWorld.calls, [], "MailFrame's OnHide CloseMail is muted: the open mailbox stays open");
    assert.deepEqual(seam.tradeWorld.calls, [], "TradeFrame's OnShow money and OnHide CloseTrade are muted");
    assert.deepEqual(sounds, []);
    assert.equal(boot.errorCount, errors);
    assert.equal(boot.bridge.diagnostics.length, diagnostics);
    assert.deepEqual(lua(boot, "return SendMailNameEditBox:HasFocus() and 1 or 0"), [0], "the probe leaves no focused box");
    assert.equal(frameXmlMailGate({}, boot, treeRenderer()), undefined, "no mail model, no stock mailbox");
    assert.equal(frameXmlTradeGate({}, boot, treeRenderer()), undefined);
  } finally {
    boot.close();
  }
});

test("the stock mailbox runs the canned letters: inbox rows, a letter, the invoice, COD and delete confirmations", withClient, async () => {
  const { boot, seam } = await load();
  try {
    assert.ok(frameXmlBagGate(boot, treeRenderer()), "the production bag owner and its stand-ins");
    const gate = frameXmlMailGate(seam, boot, treeRenderer());
    const owner = createFrameXmlMailOwner(boot, gate);
    seam.mail.owned = true;
    const errors = boot.errorCount;
    seam.mailWorld.open();
    assert.equal(owner.isOpen(), true, "MAIL_SHOW opened MailFrame");
    assert.deepEqual(lua(boot, "return InboxFrame:IsShown() and 1 or 0, ContainerFrame1:IsShown() and 1 or 0", 2), [1, 1],
      "the inbox tab, and OpenBackpack() beside it");
    const row = (index) => lua(boot, `return MailItem${index}Sender:GetText(), MailItem${index}Subject:GetText(),
      MailItem${index}ExpireTime:GetText(), MailItem${index}Button:IsShown() and 1 or 0`, 4);
    assert.deepEqual(row(1), ["Алистра", "Зелья для рейда", "|cff20ff2029 д. |r", 1]);
    assert.deepEqual(row(2).slice(0, 2), ["Аукционный дом Альянса", "Вы выиграли торги: Льняной материал"],
      "AUCTION_WON_MAIL_SUBJECT from ruRU GlobalStrings, worded by the prelude");
    assert.deepEqual(row(3).slice(0, 2), ["Аукционный дом Альянса", "Аукцион состоялся: Шелковый материал"]);
    assert.match(row(4)[2], /^\|cffff2020/, "less than a day left is red (SecondsToTime)");
    assert.deepEqual(lua(boot, "return MailItem5Button:IsShown() and 1 or 0, InboxTooMuchMail:IsShown() and 1 or 0", 2), [0, 0]);

    lua(boot, "MailItem1Button:Click()", 0);
    assert.deepEqual(lua(boot, `return OpenMailFrame:IsShown() and 1 or 0, OpenMailSender:GetText(), OpenMailSubject:GetText(),
      OpenMailBodyText:GetText(), OpenMailAttachmentButton1:IsShown() and 1 or 0, OpenMailAttachmentButton2:IsShown() and 1 or 0,
      OpenMailAttachmentButton3:IsShown() and 1 or 0, OpenMailMoneyButton:IsShown() and 1 or 0,
      OpenMailLetterButton:IsShown() and 1 or 0, OpenMailDeleteButton:GetText(), OpenMailReplyButton:IsEnabled()`, 11),
    [1, "Алистра", "Зелья для рейда", "Держи зелья и немного золота на ремонт. Увидимся в четверг!", 1, 1, 0, 1, 1,
      "Вернуть", 1], "the letter, two items, the money, the takeable text; a player's parcel is returned, not deleted");
    assert.deepEqual(seam.mailWorld.calls, [{ kind: "read", mailId: 101 }], "opening it marked it read");
    assert.deepEqual(lua(boot, "return OpenMailMoneyButtonIconTexture:GetTexture()"), ["Interface\\Icons\\INV_Misc_Coin_01"],
      "25,000 copper is a gold pile (GetCoinIcon), not an empty slot");
    lua(boot, "OpenMailAttachmentButton2:Click() OpenMailMoneyButton:Click() OpenMailLetterButton:Click()", 0);
    assert.deepEqual(seam.mailWorld.calls.slice(1), [
      { kind: "takeItem", mailId: 101, attachId: 9002 }, { kind: "takeMoney", mailId: 101 }, { kind: "copyText", mailId: 101 },
    ]);
    // Reply: the send tab with the sender and a «RE:» subject.
    lua(boot, "OpenMailReplyButton:Click()", 0);
    assert.deepEqual(lua(boot, "return SendMailFrame:IsShown() and 1 or 0, SendMailNameEditBox:GetText(), SendMailSubjectEditBox:GetText()", 3),
      [1, "Алистра", `${lua(boot, "return MAIL_REPLY_PREFIX")[0]} Зелья для рейда`]);
    lua(boot, "MailFrameTab_OnClick(nil, 1)", 0);
    // A list refresh after the letter was closed runs OpenMail_Update on openMailID 0 (MailFrame.lua:359).
    lua(boot, "HideUIPanel(OpenMailFrame)", 0);
    seam.mailWorld.deliver(frameXmlCannedMailList());
    assert.deepEqual(boot.errors.slice(errors), [], "no «compare number with nil» at mailframe.lua:673");

    // The auction win's invoice.
    lua(boot, "MailItem2Button:Click()", 0);
    assert.deepEqual(lua(boot, "return OpenMailInvoiceFrame:IsShown() and 1 or 0, OpenMailInvoiceItemLabel:GetText(), OpenMailInvoicePurchaser:GetText(), OpenMailDeleteButton:GetText()", 4),
      [1, `${lua(boot, "return ITEM_PURCHASED_COLON")[0]} Льняной материал  (${lua(boot, "return HIGH_BIDDER")[0]})`,
        `${lua(boot, "return SOLD_BY_COLON")[0]} Торвальд`, lua(boot, "return DELETE")[0]]);

    // COD: the stock confirmation, then the take.
    lua(boot, "MailItem4Button:Click()", 0);
    seam.mailWorld.calls.length = 0;
    lua(boot, "OpenMailAttachmentButton1:Click()", 0);
    assert.deepEqual(lua(boot, "local dialog = StaticPopup_Visible('COD_CONFIRMATION') return dialog and 1 or 0"), [1],
      "a COD item asks first");
    assert.deepEqual(seam.mailWorld.calls, []);
    lua(boot, "StaticPopup_OnClick(_G[StaticPopup_Visible('COD_CONFIRMATION')], 1)", 0);
    assert.deepEqual(seam.mailWorld.calls, [{ kind: "takeItem", mailId: 104, attachId: 9004 }]);

    // Delete an auction letter with an item: DELETE_MAIL confirms, then the request.
    lua(boot, "MailItem2Button:Click()", 0);
    seam.mailWorld.calls.length = 0;
    lua(boot, "OpenMailDeleteButton:Click()", 0);
    assert.deepEqual(lua(boot, "return StaticPopup_Visible('DELETE_MAIL') and 1 or 0"), [1]);
    lua(boot, "StaticPopup_OnClick(_G[StaticPopup_Visible('DELETE_MAIL')], 1)", 0);
    assert.deepEqual(seam.mailWorld.calls, [{ kind: "delete", mailId: 102 }]);
    assert.equal(boot.bridge.getFrame("OpenMailFrame").visible, false);

    // Closing the window closes the mailbox, and nothing raised along the way.
    owner.hide();
    assert.equal(owner.isOpen(), false);
    assert.equal(seam.mailWorld.mailboxGuid, 0n, "MailFrame's OnHide CloseMail reached the world");
    assert.deepEqual(boot.errors.slice(errors), []);
  } finally {
    boot.close();
  }
});

test("an auction letter whose item is not cached opens without a Lua error; its invoice follows the item", withClient, async () => {
  const { boot, seam } = await load();
  // The canned cache without Linen Cloth, as a live mailbox is until the item metadata answers.
  const linen = FRAMEXML_CANNED_MAIL_ITEMS.get(2589);
  FRAMEXML_CANNED_MAIL_ITEMS.delete(2589);
  try {
    assert.ok(frameXmlBagGate(boot, treeRenderer()));
    seam.mail.owned = true;
    const errors = boot.errorCount;
    seam.mailWorld.open();
    lua(boot, "MailItem3Button:Click()", 0);
    assert.deepEqual(lua(boot, "return OpenMailInvoiceFrame:IsShown() and 1 or 0"), [1], "the sale's invoice (item cached)");
    lua(boot, "MailItem2Button:Click()", 0);
    assert.deepEqual(boot.errors.slice(errors), [], "no «attempt to concatenate nil» at MailFrame.lua:481");
    assert.deepEqual(lua(boot, "return OpenMailFrame:IsShown() and 1 or 0, OpenMailInvoiceFrame:IsShown() and 1 or 0", 2), [1, 0],
      "the win opens, and the sale's invoice does not stay on it");
    FRAMEXML_CANNED_MAIL_ITEMS.set(2589, linen);
    await new Promise((resolve) => setTimeout(resolve, 300));
    seam.mail.tick();
    assert.deepEqual(lua(boot, "return OpenMailInvoiceFrame:IsShown() and 1 or 0, OpenMailInvoiceItemLabel:GetText(), OpenMailInvoicePurchaser:GetText()", 3),
      [1, `${lua(boot, "return ITEM_PURCHASED_COLON")[0]} Льняной материал  (${lua(boot, "return HIGH_BIDDER")[0]})`,
        `${lua(boot, "return SOLD_BY_COLON")[0]} Торвальд`], "the metadata tick's MAIL_INBOX_UPDATE paints the invoice");
    assert.deepEqual(boot.errors.slice(errors), []);
  } finally {
    if (linen) FRAMEXML_CANNED_MAIL_ITEMS.set(2589, linen);
    boot.close();
  }
});

test("the stock send form takes a bag item, prices it, sends the draft, and resets on MAIL_SEND_SUCCESS", withClient, async () => {
  const { boot, seam } = await load();
  try {
    assert.ok(frameXmlBagGate(boot, treeRenderer()));
    seam.mail.owned = true;
    const errors = boot.errorCount;
    seam.mailWorld.open();
    lua(boot, "MailFrameTab_OnClick(nil, 2)", 0);
    assert.deepEqual(lua(boot, "return SendMailFrame:IsShown() and 1 or 0, SendMailMailButton:IsEnabled(), SendMailCODButton:IsEnabled()", 3),
      [1, 0, 0], "no recipient yet, and COD needs an item");
    seam.mailWorld.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
    lua(boot, "SendMailAttachment1:Click()", 0);
    assert.equal(seam.mailWorld.cursor, undefined);
    assert.deepEqual(lua(boot, "return SendMailSubjectEditBox:GetText(), SendMailAttachment1Count:GetText(), SendMailCostMoneyFrame.staticMoney, SendMailCODButton:IsEnabled()", 4),
      ["Огромный флакон с лечебным зельем (5)", "5", 30, 1], "stock names the letter after its first item");
    lua(boot, `SendMailNameEditBox:SetText("Алистра") SendMailBodyEditBox:SetText("К четвергу.")
      MoneyInputFrame_SetCopper(SendMailMoney, 20000) SendMailFrame_CanSend()`, 0);
    assert.deepEqual(lua(boot, "return SendMailMailButton:IsEnabled()"), [1]);
    lua(boot, "SendMailMailButton:Click()", 0);
    assert.deepEqual(lua(boot, "return StaticPopup_Visible('SEND_MONEY') and 1 or 0"), [1], "sending money asks first");
    assert.equal(seam.mailWorld.calls.some(({ kind }) => kind === "send"), false);
    lua(boot, "StaticPopup_OnClick(_G[StaticPopup_Visible('SEND_MONEY')], 1)", 0);
    assert.deepEqual(seam.mailWorld.calls.at(-1), { kind: "send", draft: {
      target: "Алистра", subject: "Огромный флакон с лечебным зельем (5)", body: "К четвергу.", money: 20_000,
      attachments: [0x4000_0001n],
    } });
    seam.mailWorld.answer({ mailId: 0, command: MAIL_SEND, error: 0 });
    assert.deepEqual(lua(boot, "return SendMailNameEditBox:GetText(), SendMailSubjectEditBox:GetText(), GetSendMailItem(1)", 3),
      ["", "", undefined], "SendMailFrame_Reset after MAIL_SEND_SUCCESS; the draft is empty");
    // A refusal re-enables the button and names the reason in the error frame.
    lua(boot, `SendMailNameEditBox:SetText("Никто") SendMailSubjectEditBox:SetText("Тема") SendMailFrame_CanSend() SendMailMailButton:Click()`, 0);
    seam.mailWorld.answer({ mailId: 0, command: MAIL_SEND, error: 4 }, "Получатель не найден");
    assert.deepEqual(lua(boot, "return SendMailMailButton:IsEnabled()"), [1]);
    assert.deepEqual(boot.errors.slice(errors), []);
  } finally {
    boot.close();
  }
});

test("hovering mail buttons asks GameTooltip for the letter's items without a Lua error", withClient, async () => {
  const { boot, seam } = await load();
  try {
    assert.ok(frameXmlBagGate(boot, treeRenderer()));
    seam.mail.owned = true;
    seam.mailWorld.open();
    const errors = boot.errorCount;
    lua(boot, `InboxFrameItem_OnEnter(MailItem1Button) GameTooltip:Hide()
      MailItem1Button:Click() OpenMailAttachment_OnEnter(OpenMailAttachmentButton1, 1) GameTooltip:Hide()
      MailFrameTab_OnClick(nil, 2) SendMailAttachment_OnEnter(SendMailAttachment1) GameTooltip:Hide()`, 0);
    assert.deepEqual(boot.errors.slice(errors), []);
  } finally {
    boot.close();
  }
});
