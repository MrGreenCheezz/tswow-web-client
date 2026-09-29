import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock BankFrame as the bank window over the canned seam — BankFrame.lua's
// BANKFRAME_OPENED/CLOSED path, the purchase row and StaticPopup's CONFIRM_BUY_BANK_SLOT, and the
// publication's CSS hand-over from the native-owned dependency rule.
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

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { frameXmlBankGate, installFrameXmlBankAnswers, FRAMEXML_BANK_OWNS_CLASS } =
  await import("../dist/code/browser/framexml/FrameXmlBankOwner.js");
const { createFrameXmlNpcWindows } = await import("../dist/code/browser/framexml/FrameXmlGossipNpcWindows.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlBankController.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const decoder = new TextDecoder("utf-8");

async function load(seam = new CannedWorldSeam()) {
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "bank-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
  };
}

/** Just enough document for the publication's style element and body class. */
function fakeDocument() {
  const classes = new Set();
  const styles = [];
  return {
    head: { append: (node) => styles.push(node) },
    body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } },
    createElement: () => {
      const node = { dataset: {}, textContent: "", remove: () => styles.splice(styles.indexOf(node), 1) };
      return node;
    },
    classes, styles,
  };
}

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));

test("the purchase button the loader skips is built from its XML; the gate proves all 35 slots", withClient, async () => {
  const { boot, seam } = await load();
  try {
    assert.equal(boot.bridge.getFrame("BankFramePurchaseButton")?.name, undefined,
      "BankFrame.xml:523 marks it virtual inside <Frames>; this loader skips it");
    const errors = boot.errorCount;
    assert.equal(frameXmlBankGate(seam, boot, renderer()), undefined, "without it the structural gate refuses");
    assert.equal(installFrameXmlBankAnswers(boot), true);
    const button = boot.bridge.getFrame("BankFramePurchaseButton");
    assert.equal(button?.parent?.name, "BankFramePurchaseInfo");
    assert.deepEqual(lua(boot, `return BankFramePurchaseButton:GetText(), BankFramePurchaseButton:GetWidth(), BankFramePurchaseButton:GetHeight()`, 3),
      ["Приобрести", 124, 21]);
    const result = frameXmlBankGate(seam, boot, renderer());
    assert.deepEqual([result?.slots, result?.bags], [28, 7]);
    assert.equal(boot.bridge.getFrame("BankFrame").visible, false);
    assert.deepEqual(seam.bankSlotBuyRequests, []);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    boot.close();
  }
});

test("BANKFRAME_OPENED shows the stock bank; the purchase row asks and buys; the close ends the visit", withClient, async () => {
  const { boot, seam } = await load();
  const document = fakeDocument();
  const windows = createFrameXmlNpcWindows(seam, boot, renderer(), { document, hostId: "framexml-world-host" });
  const release = windows.publish();
  try {
    assert.equal(windows.gates.bank, true);
    assert.ok(document.classes.has(FRAMEXML_BANK_OWNS_CLASS), "the native-owned CSS rule is lifted for BankFrame");
    assert.match(document.styles[0].textContent,
      /body\.framexml-world-owns-bank #framexml-world-host \[data-framexml-name="BankFrame"\]:not\(\[hidden\]\) \{ display: block !important; \}/);
    const errors = boot.errorCount;
    // No price known (the gateway's /dbc/slot-prices failed, or has not landed): the row must not
    // print «0 copper» for a slot the server charges for — its money frame is hidden and the
    // purchase button disabled, so CONFIRM_BUY_BANK_SLOT cannot show 0 either.
    seam.openBankFrame();
    assert.deepEqual(lua(boot, `return BankFramePurchaseInfo:IsShown() and 1 or 0, BankFrameDetailMoneyFrame:IsShown() and 1 or 0,
      BankFramePurchaseButton:IsEnabled(), BankFrame.nextSlotCost == nil and 1 or 0, BankPortraitTexture:GetTexture()`, 5),
      [1, 0, 0, 1, "Interface\\CharacterFrame\\TempPortrait"], "the banker's ring holds the unknown-portrait art");
    // The prices land while that bank is open (fetched once at world entry, and nothing announces
    // them): the waiting row asks again once a second and is priced without a reopen.
    seam.setBankSlotPrice(0, 1000);
    boot.bridge.tick(0.5);
    assert.deepEqual(lua(boot, "return BankFrameDetailMoneyFrame:IsShown() and 1 or 0, BankFramePurchaseButton:IsEnabled()", 2),
      [0, 0], "not before the second has passed");
    boot.bridge.tick(0.6);
    assert.deepEqual(lua(boot, "return BankFrameDetailMoneyFrame:IsShown() and 1 or 0, BankFramePurchaseButton:IsEnabled(), BankFrame.nextSlotCost", 3),
      [1, 1, 1000], "priced on the next poll");
    seam.closeBankFrame();
    seam.openBankFrame();
    assert.deepEqual(lua(boot, `return BankFrame:IsShown() and 1 or 0, BankFrameTitleText:GetText(), BankFramePurchaseInfo:IsShown() and 1 or 0, BankFrame.nextSlotCost`, 4),
      [1, "Банкир", 1, 1000]);
    assert.deepEqual(lua(boot, "return BankFrameDetailMoneyFrame:IsShown() and 1 or 0, BankFramePurchaseButton:IsEnabled()", 2),
      [1, 1], "a known price is shown and can be bought");
    assert.equal(controller.frameXmlBankOpen(), true);
    // Unbought bag slots are tinted red and say so (UpdateBagSlotStatus).
    assert.deepEqual(lua(boot, "return BankFrameBag1.tooltipText", 1), ["Ячейка, которую можно приобрести"]);
    // An empty bank bag slot shows the bag silhouette: GetInventorySlotInfo("Bag1") (BankFrame.lua:43).
    assert.deepEqual(lua(boot, "return BankFrameBag1IconTexture:GetTexture(), BankFrameBag1IconTexture:IsShown() and 1 or 0", 2),
      ["Interface\\Paperdoll\\UI-PaperDoll-Slot-Bag", 1]);
    boot.bridge.Click(boot.bridge.getFrame("BankFramePurchaseButton"));
    assert.deepEqual(lua(boot, `return StaticPopup_Visible("CONFIRM_BUY_BANK_SLOT") and 1 or 0`), [1]);
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(seam.bankSlotBuyRequests, [0], "PurchaseSlot reached the bank's buy command");
    seam.setBankSlotsBought(1);
    assert.deepEqual(lua(boot, "return BankFrameBag1.tooltipText, BankFrameBag2.tooltipText", 2),
      ["Ячейка для сумки", "Ячейка, которую можно приобрести"], "PLAYERBANKBAGSLOTS_CHANGED repaints the bag row");
    controller.closeFrameXmlBank();
    assert.deepEqual(lua(boot, "return BankFrame:IsShown() and 1 or 0"), [0]);
    seam.buyBankSlot();
    assert.deepEqual(seam.bankSlotBuyRequests, [0], "OnHide's CloseBankFrame ended the banker's permission");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
  assert.equal(document.classes.has(FRAMEXML_BANK_OWNS_CLASS), false, "unpublished: the dependency rule hides it again");
  assert.deepEqual(document.styles, []);
  assert.equal(controller.frameXmlBankPublished(), false);
});

test("over the live seam a bank bag opens as a stock ContainerFrame; the bank shows the player's slots", withClient, async () => {
  const place = (fields, offset, guid) => {
    fields.set(offset, Number(guid & 0xffffffffn));
    fields.set(offset + 1, Number(guid >> 32n));
  };
  const item = (guid, entry, count = 1) => ({ guid, typeId: 1, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, count],
  ]) });
  const player = { guid: 1n, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 60]]) };
  const bag = { guid: 4n, typeId: 2, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 4496], [UPDATE_FIELDS.CONTAINER_FIELD_NUM_SLOTS.offset, 6],
  ]) };
  const herb = item(6n, 765, 3);
  const ore = item(3n, 2770, 20);
  place(bag.fields, UPDATE_FIELDS.CONTAINER_FIELD_SLOT_1.offset, herb.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset, ore.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANKBAG_SLOT_1.offset, bag.guid);
  player.fields.set(UPDATE_FIELDS.PLAYER_BYTES_2.offset, 1 << 16); // one bank bag slot bought
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [3n, ore], [4n, bag], [6n, herb]]) },
    names: { get: () => undefined, declined: () => undefined }, creatureTemplates: new Map(),
    itemTemplates: new Map([[4496, { found: true, name: "Маленький мешочек", bagFamily: 0, itemClass: 1, startQuest: 0 }]]),
    bankerGuid: 9n, casts: new Map(), auras: new Map(), knownSpells: [], actionButtons: [],
    cooldownRemaining: () => 0, events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {}, itemTexture: (entry) => `Interface\\Icons\\INV_${entry}`,
  });
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    installFrameXmlBankAnswers(boot);
    const errors = boot.errorCount;
    const values = lua(boot, `
      if not InterfaceOptionsFrame then InterfaceOptionsFrame = CreateFrame("Frame") InterfaceOptionsFrame:Hide() end
      BankFrame_OnEvent(BankFrame, "BANKFRAME_OPENED")
      BankFrameItemButtonBag_OnClick(BankFrameBag1)
      local frame
      for i = 1, NUM_CONTAINER_FRAMES do
        local candidate = _G["ContainerFrame" .. i]
        if candidate:IsShown() and candidate:GetID() == 5 then frame = candidate end
      end
      local button = frame and _G[frame:GetName() .. "Item" .. frame.size]
      return frame and frame.size or 0, frame and _G[frame:GetName() .. "Name"]:GetText() or "",
        button and _G[button:GetName() .. "IconTexture"]:GetTexture() or "", button and _G[button:GetName() .. "Count"]:GetText() or "",
        BankFrameItem1IconTexture:GetTexture(), BankFrameItem1Count:GetText(), BankFrameBag1IconTexture:GetTexture()`, 7);
    assert.deepEqual(values, [6, "Маленький мешочек", "Interface\\Icons\\INV_765", "3",
      "Interface\\Icons\\INV_2770", "20", "Interface\\Icons\\INV_4496"],
      "ToggleBag(5) from the bag button: container 5 with its six slots; generic slot 1 and the bag itself");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    boot.close();
  }
});
