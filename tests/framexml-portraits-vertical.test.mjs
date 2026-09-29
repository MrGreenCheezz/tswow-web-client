import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the selected client's own FrameXML calling SetPortraitTexture — BankFrame.lua's
// BANKFRAME_OPENED, GossipFrameUpdate, TaxiFrame's TAXIMAP_OPENED, MerchantFrame_UpdateMerchantInfo,
// TradeFrame_Update, PVPFrame_OnShow, ShowReadyCheck and UnitFrame_Update — through the host bridge
// (FrameXmlBoot) into the stock portrait host (FrameXmlPortraits.ts) over the real UI bridge.
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
const { createFrameXmlNpcWindows } = await import("../dist/code/browser/framexml/FrameXmlGossipNpcWindows.js");
const { createFrameXmlStockPortraits } = await import("../dist/code/browser/framexml/FrameXmlPortraits.js");
const { StockPortraitTargets } = await import("../dist/code/browser/PortraitRenderer.js");
const decoder = new TextDecoder("utf-8");

function node() {
  const self = {
    children: [], parentElement: null, dataset: {}, className: "", width: 0, height: 0,
    style: { position: "absolute", left: "7px", top: "-6px", width: "60px", height: "60px" },
    get nextSibling() {
      const siblings = self.parentElement?.children ?? [];
      return siblings[siblings.indexOf(self) + 1] ?? null;
    },
    insertBefore(child, sibling) {
      child.remove();
      const index = sibling ? self.children.indexOf(sibling) : -1;
      self.children.splice(index < 0 ? self.children.length : index, 0, child);
      child.parentElement = self;
      return child;
    },
    remove() {
      const parent = self.parentElement;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(self), 1);
      self.parentElement = null;
    },
    getAttribute: () => null,
  };
  return self;
}

test("the selected client's windows hand every non-HUD SetPortraitTexture to the host, which follows them", withClient, async () => {
  class NpcSeam extends CannedWorldSeam {
    npcPresent = true;
    unitExists(unit) { return unit.toLowerCase() === "npc" ? this.npcPresent : super.unitExists(unit); }
    unitName(unit) { return unit.toLowerCase() === "npc" ? "Банкир" : super.unitName(unit); }
  }
  const seam = new NpcSeam();
  const unitCalls = [];
  const questCalls = [];
  let portraits;
  let hostMs = 0;
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
    onQuestPortrait: (guid) => questCalls.push(guid),
    onUnitPortrait: (texture, unit) => {
      unitCalls.push(`${texture.name}:${unit}`);
      const started = performance.now();
      portraits.setPortraitTexture(texture, unit);
      hostMs += performance.now() - started;
    },
  });
  const layer = node();
  const elements = new Map();
  const targets = new StockPortraitTargets();
  const guids = { npc: 0x701n, player: 0x12n, party1: 0x11n };
  portraits = createFrameXmlStockPortraits({
    bridge: boot.bridge, targets, document: { createElement: () => node() },
    resolve: (unit) => guids[unit],
    elementFor: (frame) => {
      let element = elements.get(frame);
      if (!element) {
        element = node();
        layer.insertBefore(element, null);
        elements.set(frame, element);
      }
      return element;
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const run = (code) => {
    const result = boot.vm.execute(code, "@portraits-vertical");
    assert.equal(result.ok, true, `${code}: ${result.error ?? ""}`);
  };
  try {
    await boot.load();
    // The session exercise drives UnitFrame_Update for every unit frame; all of those and the
    // party pets' unnamed units go through the bridge and claim nothing.
    assert.ok(unitCalls.includes("PlayerPortrait:player"));
    assert.ok(unitCalls.includes("TargetFramePortrait:target"));
    assert.ok(unitCalls.includes("PartyMemberFrame1PetFramePortrait:partypet1"));
    // Two claims at boot, neither a HUD frame: stock PetStable.lua names the player's portrait
    // while PetStableFrame is still hidden (measured: PetStableFramePortrait:player), and
    // CharacterMicroButton_OnEvent's PLAYER_ENTERING_WORLD names the micro-button's face.
    assert.ok(unitCalls.includes("PetStableFramePortrait:player"));
    assert.ok(unitCalls.includes("MicroButtonPortrait:player"), "the «Персонаж» button's face is a stock claim");
    assert.equal(portraits.claims, 2, "HUD unit frames keep their dedicated slots");
    const microButton = boot.bridge.getFrame("MicroButtonPortrait");
    assert.deepEqual(microButton.texCoords, { left: 0.2, right: 0.8, top: 0.0666, bottom: 0.9 },
      "the authored crop survives the claim");
    assert.equal(microButton.texture, "Interface\\CharacterFrame\\TempPortrait");
    await settle();
    const face = targets.get("stock:MicroButtonPortrait");
    if (boot.bridge.isVisible(microButton)) {
      assert.equal(face?.guid, 0x12n, "a shown micro-button has the player's renderer target");
      assert.equal(face.canvas.dataset.framexmlTexcoords, "0.2:0.8:0.0666:0.9", "the canvas carries the crop");
    } else {
      assert.equal(face, undefined, "a hidden row's claim waits for its OnShow");
    }
    console.log(`[portraits] boot: ${unitCalls.length} SetPortraitTexture calls reached the host, ${hostMs.toFixed(3)} ms inside it`);
    unitCalls.length = 0;

    // GossipFrameUpdate alone, before the NPC lane's «?» wrapper is installed: a chest's gossip
    // after a creature's must show the book again — the very picture the creature's claim found.
    const gossipTexture = boot.bridge.getFrame("GossipFramePortrait");
    const bootErrors = boot.errorCount;
    for (let visit = 1; visit <= 2; visit++) {
      seam.npcPresent = false;
      run("GossipFrame:Show(); GossipFrameUpdate()");
      await settle();
      assert.equal(gossipTexture.texture, "Interface\\QuestFrame\\UI-QuestLog-BookIcon");
      assert.equal(targets.get("stock:GossipFramePortrait"), undefined, `visit ${visit}: the chest shows the book`);
      run("GossipFrame:Hide()");
      seam.npcPresent = true;
      run("GossipFrame:Show(); GossipFrameUpdate()");
      await settle();
      assert.equal(targets.get("stock:GossipFramePortrait")?.guid, 0x701n, `visit ${visit}: the creature's face`);
      run("GossipFrame:Hide()");
      await settle();
    }
    assert.equal(gossipTexture.texture, "Interface\\CharacterFrame\\TempPortrait", "the claim replaced the book");
    assert.equal(boot.errorCount, bootErrors, JSON.stringify(boot.errors.slice(bootErrors)));
    assert.deepEqual(unitCalls.splice(0), ["GossipFramePortrait:npc", "GossipFramePortrait:npc"]);

    // As the live mount does: bank answers and the NPC lane's «?» stand-in wrapper.
    createFrameXmlNpcWindows(seam, boot, { elementFor: () => undefined }, {});
    // MerchantFrame_OnShow opens the backpack, whose IsOptionFrameOpen reads InterfaceOptionsFrame;
    // the live bag gate aliases it to a hidden frame, and so does this.
    run("InterfaceOptionsFrame = InterfaceOptionsFrame or CreateFrame('Frame'); InterfaceOptionsFrame:Hide()");
    const errors = boot.errorCount;

    boot.bridge.dispatchEvent("BANKFRAME_OPENED");
    assert.deepEqual(unitCalls.splice(0), ["BankPortraitTexture:npc"], "BankFrame_OnEvent names \"npc\"");
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("BankFrame")), true);
    await settle();
    const bank = targets.get("stock:BankPortraitTexture");
    assert.equal(bank?.guid, 0x701n, "ShowUIPanel after SetPortraitTexture: the claim activates on the show");
    const bankTexture = boot.bridge.getFrame("BankPortraitTexture");
    assert.equal(bankTexture.texture, "Interface\\CharacterFrame\\TempPortrait", "the «?» stays under the canvas");
    assert.equal(elements.get(bankTexture).nextSibling, bank.canvas);
    boot.bridge.dispatchEvent("BANKFRAME_CLOSED");
    await settle();
    assert.equal(targets.get("stock:BankPortraitTexture"), undefined, "HideUIPanel gives the renderer surface back");
    assert.equal(bank.canvas.style.display, "none");

    run("GossipFrame:Show(); GossipFrameUpdate()");
    assert.deepEqual(unitCalls.splice(0), ["GossipFramePortrait:npc"]);
    await settle();
    assert.equal(targets.get("stock:GossipFramePortrait")?.guid, 0x701n);
    seam.npcPresent = false; // a lectern's gossip: stock puts the book in
    run("GossipFrameUpdate()");
    assert.deepEqual(unitCalls.splice(0), []);
    await settle();
    assert.equal(boot.bridge.getFrame("GossipFramePortrait").texture, "Interface\\QuestFrame\\UI-QuestLog-BookIcon");
    assert.equal(targets.get("stock:GossipFramePortrait"), undefined, "the book replaces the earlier face");
    run("GossipFrame:Hide()");
    seam.npcPresent = true;

    run("TaxiFrame_OnEvent(TaxiFrame, 'TAXIMAP_OPENED')");
    assert.deepEqual(unitCalls.splice(0), ["TaxiPortrait:npc"]);
    run("TradeFrame:Show(); TradeFrame_Update()");
    assert.deepEqual(unitCalls.splice(0), ["TradeFramePlayerPortrait:player", "TradeFrameRecipientPortrait:npc"],
      "TradeFrame's \"NPC\" is lower-cased like every token");
    run("ShowReadyCheck('party1', 30)");
    assert.deepEqual(unitCalls.splice(0), ["ReadyCheckPortrait:party1"]);
    run("PVPFrame_OnShow()");
    assert.deepEqual(unitCalls.splice(0), ["PVPFramePortrait:player"]);
    await settle();
    assert.equal(targets.get("stock:TradeFramePlayerPortrait")?.guid, 0x12n);
    assert.equal(targets.get("stock:TradeFrameRecipientPortrait")?.guid, 0x701n);
    assert.equal(targets.get("stock:ReadyCheckPortrait")?.guid, 0x11n);
    assert.equal(targets.get("stock:PVPFramePortrait"), undefined, "PVPFrame is not shown: claimed, no surface");
    for (const name of ["TradeFramePlayerPortrait", "TradeFrameRecipientPortrait", "ReadyCheckPortrait", "PVPFramePortrait"]) {
      assert.equal(boot.bridge.getFrame(name).texture, "Interface\\CharacterFrame\\TempPortrait",
        `${name}: a claim puts the client's stand-in under its canvas`);
    }
    // Lane RC's SetPortraitToTexture is Lua's own round picture: it replaces a claimed face.
    run("SetPortraitToTexture(TradeFrameRecipientPortrait, 'Interface\\\\Icons\\\\INV_Misc_QuestionMark')");
    await settle();
    const recipient = boot.bridge.getFrame("TradeFrameRecipientPortrait");
    assert.equal(recipient.portrait, true);
    assert.equal(recipient.texture, "Interface\\Icons\\INV_Misc_QuestionMark");
    assert.equal(targets.get("stock:TradeFrameRecipientPortrait"), undefined, "the icon wins over the face");
    run("TradeFrame_Update()");
    await settle();
    assert.equal(targets.get("stock:TradeFrameRecipientPortrait")?.guid, 0x701n, "the next update claims it again");
    assert.equal(recipient.texture, "Interface\\CharacterFrame\\TempPortrait");
    assert.equal(recipient.portrait, false, "a plain picture again: the icon's round crop goes with it");
    unitCalls.length = 0;

    // MerchantFrame_UpdateMerchantInfo runs on every MERCHANT_UPDATE: the repeat is free.
    run("MerchantFrame:Show(); MerchantFrame_UpdateMerchantInfo()");
    await settle();
    const version = targets.version;
    const started = performance.now();
    run("for i = 1, 1000 do MerchantFrame_UpdateMerchantInfo() end");
    const perCall = (performance.now() - started) / 1000;
    await settle();
    assert.equal(targets.version, version, "1000 repeated updates change nothing the renderer reads");
    const bare = performance.now();
    run("for i = 1, 10000 do SetPortraitTexture(MerchantFramePortrait, 'NPC') end");
    const perPortrait = (performance.now() - bare) / 10000;
    await settle();
    assert.equal(targets.version, version);
    console.log(`[portraits] MerchantFrame_UpdateMerchantInfo ${perCall.toFixed(4)} ms/call; `
      + `a repeated SetPortraitTexture alone ${(perPortrait * 1000).toFixed(2)} µs/call`);
    unitCalls.length = 0;

    run("SetPortraitTexture(QuestFramePortrait, 'questnpc')");
    assert.deepEqual(unitCalls, [], "QuestFramePortrait keeps its own bridge");
    assert.equal(questCalls.length > 0, true);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors)));
    portraits.dispose();
    assert.equal(targets.size, 0, "unmount releases every stock target");
  } finally {
    portraits.dispose();
    boot.close();
  }
});
