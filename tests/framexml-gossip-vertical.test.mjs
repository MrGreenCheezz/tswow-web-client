import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the NPC windows' stock XML (GossipFrame, ItemTextFrame, TaxiFrame) in the production
// vertical, and stock GossipFrame driven over the canned innkeeper — the real 3.3.5 GossipFrame.lua,
// UIParent.lua's GOSSIP_CONFIRM branch and StaticPopup.lua against FrameXmlGossip.ts.
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
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { frameXmlGossipGate } = await import("../dist/code/browser/framexml/FrameXmlGossipOwner.js");
const { createFrameXmlNpcWindows } = await import("../dist/code/browser/framexml/FrameXmlGossipNpcWindows.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlGossipController.js");
const { FRAMEXML_CANNED_GOSSIP_SUBPAGE } = await import("../dist/code/browser/framexml/FrameXmlGossipCanned.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const NPC_FILES = ["itemtextframe.xml", "taxiframe.xml", "gossipframe.xml"];

async function load(subset, seam = new CannedWorldSeam()) {
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
  const fn = boot.vm.compileFunction(code, "gossip-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, parentElement: null, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
  };
}

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));

test("ItemText/Taxi/Gossip sit at their retail TOC slots; the closure adds six files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const loot = toc.indexOf("lootframe.xml");
  assert.deepEqual(toc.slice(loot + 1, loot + 4), ["itemtextframe.xml", "taxiframe.xml", "bankframe.xml"], "retail 98-100");
  assert.equal(toc[toc.indexOf("colorpickerframe.xml") + 1], "gossipframe.xml", "retail 118, after ColorPickerFrame");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  const bank = vertical.indexOf("bankframe.xml");
  assert.deepEqual(vertical.slice(bank - 2, bank), ["itemtextframe.xml", "taxiframe.xml"]);
  assert.ok(vertical.indexOf("gossipframe.xml") > vertical.indexOf("colorpickerframe.xml"));
  assert.ok(vertical.indexOf("gossipframe.xml") < vertical.indexOf("worldstateframe.xml"));
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => !NPC_FILES.includes(normalize(entry))));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    for (const file of ["gossipframe.lua", "itemtextframe.lua", "taxiframe.lua"]) {
      assert.ok(candidate.requests.has(`interface/framexml/${file}`), `${file} is reached through its XML`);
      assert.ok(!baseline.requests.has(`interface/framexml/${file}`));
    }
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    // GossipFrame +2 files +25,730 B +168 widgets; ItemTextFrame +2 +13,306 +48; TaxiFrame +2 +12,260 +13.
    assert.deepEqual(delta, { files: 6, bytes: 51296, widgets: 229, errors: 0, distinct: 0, luaFailed: 0 },
      `NPC closure delta ${JSON.stringify(delta)}`);
    for (const name of ["GossipFrame", "ItemTextFrame", "TaxiFrame"]) {
      const frame = candidate.boot.bridge.getFrame(name);
      assert.equal(frame?.parent?.name, "UIParent");
      assert.equal(frame.visible, false, `${name} is a hidden root: no visible-root admission`);
    }
    console.log(`[npc] load ms baseline ${Math.round(baseline.loadMs)} candidate ${Math.round(candidate.loadMs)}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("every NPC gate passes on the real corpus, silently, and leaves every frame hidden", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    const errors = boot.errorCount;
    const result = frameXmlGossipGate(seam, boot, renderer());
    assert.ok(result, "the stock tree passes");
    assert.equal(result.rows, 4, "one quest to take, one to turn in, two options: four title buttons");
    const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {});
    assert.deepEqual(windows.gates, {
      gossip: true, bank: true, taxi: true, itemText: true, tabard: true, registrar: true, petition: true,
      stable: true,
    });
    for (const name of ["GossipFrame", "BankFrame", "TaxiFrame", "ItemTextFrame", "StaticPopup1"]) {
      assert.equal(boot.bridge.getFrame(name).visible, false, `${name} ends hidden`);
    }
    assert.deepEqual(seam.npc.gossip.world.calls, [], "muted: no CloseGossip or Select* reached the world");
    assert.deepEqual(seam.npc.taxi.world.calls, []);
    assert.deepEqual(sounds, [], "the probes play no open/close sound");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
    // No model on the seam: no stock gossip (the native window stays).
    assert.equal(frameXmlGossipGate({}, boot, renderer()), undefined);
  } finally {
    boot.close();
  }
});

test("a conversation: the page's rows, a submenu, a paid row through GOSSIP_CONFIRM, a quest, the close", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  const escapes = [];
  const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {
    registerEscapable(entry) { escapes.push(entry); return () => escapes.splice(escapes.indexOf(entry), 1); },
  });
  const release = windows.publish();
  try {
    const world = seam.npc.gossip.world;
    const errors = boot.errorCount;
    world.talk();
    assert.deepEqual(lua(boot, `return GossipFrame:IsShown() and 1 or 0, GossipFrameNpcNameText:GetText(), GossipGreetingText:GetText()`, 3),
      [1, "Трактирщик", "Добро пожаловать в «Златоземье», Тестер! Путь до Штормграда неблизкий — отдохни у огня."]);
    const rows = lua(boot, `local r = {}
      for i = 1, NUMGOSSIPBUTTONS do
        local b = _G["GossipTitleButton" .. i]
        if b:IsShown() then r[#r + 1] = i .. ":" .. b.type .. ":" .. b:GetID() .. ":" .. b:GetText() .. ":" .. (_G["GossipTitleButton" .. i .. "GossipIcon"]:GetTexture() or "") end
      end
      return table.concat(r, "\\n")`)[0].split("\n");
    // The canned player is level 60: the level-5 quest is past GetQuestGreenRange() (12) and is
    // drawn trivial (TRIVIAL_QUEST_DISPLAY, grey icon); the level-58 one is not.
    assert.deepEqual(rows.map((row) => row.replace(/:[^:]*$/, "")), [
      "1:Available:1:|cff000000Кобольдские свечи (низкий уровень)|r",
      "3:Active:1:|cff000000Золотая пыль|r",
      "5:Gossip:1:Расскажи мне об этом городе.",
      "6:Gossip:2:Я хочу остановиться в этой таверне.",
      "7:Gossip:3:Покажи мне свои товары.",
      "8:Gossip:4:Мне нужна комната на ночь.",
    ], "GossipFrameUpdate's layout: available, spacer, active, spacer, then the options");
    assert.deepEqual(rows.map((row) => row.split(":").at(-1).toLowerCase().replaceAll("\\", "/")), [
      "interface/gossipframe/availablequesticon", "interface/gossipframe/activequesticon",
      "interface/gossipframe/gossipgossipicon", "interface/gossipframe/bindergossipicon",
      "interface/gossipframe/vendorgossipicon", "interface/gossipframe/bankergossipicon",
    ], "each row's stock icon");
    assert.deepEqual(lua(boot, `local r1 = GossipTitleButton1GossipIcon:GetVertexColor()
      local r3 = GossipTitleButton3GossipIcon:GetVertexColor()
      return string.format("%.1f", r1), string.format("%.1f", r3)`, 2), ["0.5", "1.0"], "the trivial row's icon is greyed");
    // A creature's conversation: UnitExists("npc"), so GossipFrameUpdate asks SetPortraitTexture, and
    // the ring holds the client's unknown-portrait art where the 3D bust would be.
    assert.deepEqual(lua(boot, "return UnitExists('npc') and 1 or 0, GossipFramePortrait:GetTexture()", 2),
      [1, "Interface\\CharacterFrame\\TempPortrait"]);
    // QuestFontLeft (the rows' NormalFont) is LEFT-justified; the host adapter carries it to the ButtonText.
    assert.deepEqual(lua(boot, "return GossipTitleButton5:GetFontString():GetJustifyH()"), ["LEFT"]);

    // The paid row: stock asks through StaticPopup's GOSSIP_CONFIRM with the price, then sends.
    boot.bridge.Click(boot.bridge.getFrame("GossipTitleButton8"));
    assert.deepEqual(world.calls, [], "nothing sent before the dialog is accepted");
    assert.deepEqual(lua(boot, `return StaticPopup_Visible("GOSSIP_CONFIRM") and 1 or 0, StaticPopup1Text:GetText(), StaticPopup1MoneyFrame:IsShown() and 1 or 0`, 3),
      [1, "Комната стоит 10 серебряных.", 1]);
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(world.calls, [{ kind: "select", optionId: 3, code: undefined }]);

    // The chat row opens the next page: GOSSIP_SHOW again, stock redraws one row.
    boot.bridge.Click(boot.bridge.getFrame("GossipTitleButton5"));
    assert.equal(world.gossip, FRAMEXML_CANNED_GOSSIP_SUBPAGE);
    assert.deepEqual(lua(boot, `local n = 0 for i = 1, NUMGOSSIPBUTTONS do if _G["GossipTitleButton" .. i]:IsShown() then n = n + 1 end end
      return GossipFrame:IsShown() and 1 or 0, n, GossipGreetingText:GetText()`, 3),
      [1, 1, "Златоземье стоит на тракте между Штормградом и Западным краем."]);

    world.talk();
    boot.bridge.Click(boot.bridge.getFrame("GossipTitleButton1"));
    boot.bridge.Click(boot.bridge.getFrame("GossipTitleButton3"));
    assert.deepEqual(world.calls.slice(-2), [
      { kind: "quest", questId: 60, completion: false }, { kind: "quest", questId: 47, completion: true },
    ]);
    // The quest page takes the conversation's place (QuestFrame and GossipFrame share the left slot).
    boot.bridge.Show(boot.bridge.getFrame("QuestFrame"));
    assert.deepEqual(lua(boot, "return GossipFrame:IsShown() and 1 or 0"), [0]);
    assert.deepEqual(world.calls.at(-1), { kind: "close" }, "OnHide's CloseGossip ends the page");
    boot.bridge.Hide(boot.bridge.getFrame("QuestFrame"));

    // Escape (Windows.ts's registry) and the stock Goodbye button close it the same way.
    world.talk();
    assert.equal(escapes.some((entry) => entry.isOpen()), true);
    for (const entry of escapes) if (entry.isOpen()) entry.close();
    assert.deepEqual(lua(boot, "return GossipFrame:IsShown() and 1 or 0"), [0]);
    assert.equal(world.gossip, undefined);
    world.talk();
    boot.bridge.Click(boot.bridge.getFrame("GossipFrameGreetingGoodbyeButton"));
    assert.equal(world.gossip, undefined);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
});

test("a lone service row is selected by stock itself; unpublishing hides without ending the page", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {});
  const release = windows.publish();
  try {
    const world = seam.npc.gossip.world;
    const errors = boot.errorCount;
    world.talk({ ...FRAMEXML_CANNED_GOSSIP_SUBPAGE, menuId: 9, quests: [],
      options: [{ id: 5, icon: 1, coded: false, money: 0, text: "Покажи товары.", boxText: "" }] });
    assert.deepEqual(world.calls, [{ kind: "select", optionId: 5, code: undefined }],
      "GossipFrame_OnEvent: one non-gossip option and no quests goes straight to it");
    assert.deepEqual(lua(boot, "return GossipFrame:IsShown() and 1 or 0"), [0]);
    world.onChanged();
    assert.equal(world.calls.length, 1, "a text re-query does not select it twice");

    world.talk();
    assert.equal(controller.frameXmlGossipOpen(), true);
    release();
    assert.equal(controller.frameXmlGossipPublished(), false);
    assert.deepEqual(lua(boot, "return GossipFrame:IsShown() and 1 or 0"), [0]);
    assert.notEqual(world.gossip, undefined, "unmount hands the open page back to the native window");
    assert.equal(world.calls.at(-1).kind, "select", "no CloseGossip on the way out");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
});
