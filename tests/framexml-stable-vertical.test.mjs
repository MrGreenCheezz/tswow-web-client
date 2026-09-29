import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock PetStable.xml in the production vertical, driven over the canned stable master —
// the real 3.3.5 PetStable.lua against FrameXmlStable.ts.
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
const { createFrameXmlNpcWindows } = await import("../dist/code/browser/framexml/FrameXmlGossipNpcWindows.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlStableController.js");
const canned = await import("../dist/code/browser/framexml/FrameXmlStableCanned.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

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
  const inventory = await boot.load();
  return { boot, seam, inventory, requests };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "stable-test", []);
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
const shown = (boot, name) => lua(boot, `return ${name}:IsShown() and 1 or 0`)[0];
const click = (boot, name) => boot.bridge.Click(boot.bridge.getFrame(name));

function listenMessages(boot) {
  lua(boot, `
    WebClientTestMessages = {}
    local listener = CreateFrame("Frame")
    listener:RegisterEvent("UI_ERROR_MESSAGE")
    listener:SetScript("OnEvent", function(_, event, text)
      WebClientTestMessages[#WebClientTestMessages + 1] = event .. ":" .. tostring(text)
    end)`, 0);
  return () => lua(boot, "return table.concat(WebClientTestMessages, '\\n')")[0].split("\n").filter(Boolean);
}

/** One load shared by the tests that drive the published frame (each test re-opens its own stable). */
let shared;
async function published() {
  if (!shared) {
    const { boot, seam, inventory, requests } = await load(FRAMEXML_VERTICAL_TOC);
    const escapes = [];
    const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {
      registerEscapable(entry) { escapes.push(entry); return () => escapes.splice(escapes.indexOf(entry), 1); },
    });
    shared = { boot, seam, inventory, requests, windows, escapes, release: windows.publish(), world: seam.npc.stable.world };
  }
  return shared;
}
after(() => { shared?.release(); shared?.boot.close(); });

test("PetStable.xml sits at its retail TOC slot; it adds its two files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc[toc.indexOf("mailframe.xml") + 1], "petstable.xml", "retail 120, after MailFrame");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(vertical[vertical.indexOf("mailframe.xml") + 1], "petstable.xml");
  let baseline;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "petstable.xml"));
    const candidate = await published();
    assert.ok(candidate.requests.has("interface/framexml/petstable.lua"), "PetStable.lua is reached through its XML");
    assert.ok(!baseline.requests.has("interface/framexml/petstable.lua"));
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 2, bytes: 20218, widgets: 94, errors: 0, distinct: 0, luaFailed: 0 },
      `stable closure delta ${JSON.stringify(delta)}`);
    const frame = candidate.boot.bridge.getFrame("PetStableFrame");
    assert.equal(frame?.parent?.name, "UIParent");
    assert.equal(frame.visible, false, "a hidden root");
    assert.equal(candidate.windows.gates.stable, true, "the gate passes on the real corpus");
    assert.equal(controller.frameXmlStablePublished(), true);
  } finally {
    baseline?.boot.close();
  }
});

test("the stable master's list: slots, the pet out, a selection, the purchase row", withClient, async () => {
  const { boot, world, escapes } = await published();
  const errors = boot.errorCount;
  world.calls.length = 0;
  world.open();
  assert.deepEqual(lua(boot, `return PetStableFrame:IsShown() and 1 or 0, GetSelectedStablePet(),
    PetStableCurrentPet:GetChecked() and 1 or 0, PetStableLevelText:GetText(),
    PetStableCurrentPetIconTexture:GetTexture(), PetStableStabledPet1IconTexture:GetTexture(),
    PetStableStabledPet3:IsEnabled() == 1 and 1 or 0, PetStableStabledPet4:IsEnabled() == 1 and 1 or 0,
    PetStableStabledPet3.tooltip == EMPTY_STABLE_SLOT and 1 or 0`, 9),
  [1, 0, 1, lua(boot, "return format(STABLE_PET_INFO_TEXT, 'Боевой питомец', 60, 'Волк', 'Свирепость')")[0],
    "Interface\\Icons\\Ability_Hunter_Pet_Wolf", "Interface\\Icons\\Ability_Hunter_Pet_Cat", 1, 0, 1],
  "PET_STABLE_SHOW: the pet out is selected (GetPetIcon), three slots bought");
  assert.deepEqual(lua(boot, `return PetStablePurchaseButton:IsShown() and 1 or 0,
    PetStablePurchaseButton:IsEnabled() == 1 and 1 or 0, PetStableCostMoneyFrameGoldButton:GetText()`, 3),
  [1, 1, "10"], "the fourth slot's price in the stock money frame");

  click(boot, "PetStableStabledPet2");
  assert.deepEqual(lua(boot, `return GetSelectedStablePet(), PetStableStabledPet2:GetChecked() and 1 or 0,
    PetStableCurrentPet:GetChecked() and 1 or 0, PetStableLevelText:GetText()`, 4),
  [2, 1, 0, lua(boot, "return format(STABLE_PET_INFO_TEXT, 'Паучок', 18, 'Паук', 'Хитрость')")[0]]);
  assert.equal(boot.bridge.getFrame("PetStableModel").model?.creatureEntry, 30,
    "SetPetStablePaperdoll: the selected pet's creature on the PlayerModel (drawn only where a model stage runs)");
  assert.equal(escapes.some((entry) => entry.isOpen()), true, "Escape closes it");
  assert.deepEqual(world.calls, []);
  assert.equal(boot.errorCount, errors, newErrors(boot, errors));
});

test("moves: lift and drop is the move's packet; a purchase goes through the stock popup", withClient, async () => {
  const { boot, world } = await published();
  const messages = listenMessages(boot);
  const errors = boot.errorCount;
  world.calls.length = 0;
  world.open();
  // A stabled pet onto the current slot: CMSG_UNSTABLE_PET with its number.
  boot.bridge.fireScript(boot.bridge.getFrame("PetStableStabledPet1"), "OnDragStart", "LeftButton");
  click(boot, "PetStableCurrentPet");
  // The pet out onto the empty third slot: CMSG_STABLE_PET.
  boot.bridge.fireScript(boot.bridge.getFrame("PetStableCurrentPet"), "OnDragStart", "LeftButton");
  click(boot, "PetStableStabledPet3");
  assert.deepEqual(world.calls, [{ kind: "unstable", petNumber: 3 }, { kind: "stable" }]);

  click(boot, "PetStablePurchaseButton");
  assert.equal(lua(boot, "return StaticPopup_Visible('CONFIRM_BUY_STABLE_SLOT') and 1 or 0")[0], 1);
  lua(boot, `_G[StaticPopup_Visible("CONFIRM_BUY_STABLE_SLOT") .. "Button1"]:Click()`, 0);
  assert.deepEqual(world.calls.at(-1), { kind: "buy" }, "OnAccept: BuyStableSlot");
  world.answer(0x01);
  assert.equal(messages().at(-1), `UI_ERROR_MESSAGE:${lua(boot, "return ERR_NOT_ENOUGH_MONEY")[0]}`);
  world.answer(0x0a, { ...canned.FRAMEXML_CANNED_STABLE_LIST, stableSlots: 4 });
  assert.deepEqual(lua(boot, `return PetStableStabledPet4:IsEnabled() == 1 and 1 or 0,
    PetStablePurchaseButton:IsShown() and 1 or 0`, 2), [1, 0], "four slots: the purchase row hides");
  assert.equal(boot.errorCount, errors, newErrors(boot, errors));
});

test("closing: the close button forgets the master; closeNpcServices closes it; unpublishing hands it back",
  withClient, async () => {
    const { boot, world } = await published();
    const errors = boot.errorCount;
    world.open();
    click(boot, "PetStableFrameCloseButton");
    assert.equal(shown(boot, "PetStableFrame"), 0);
    assert.equal(world.stableMasterGuid, 0n, "ClosePetStables");
    world.open();
    assert.equal(shown(boot, "PetStableFrame"), 1);
    world.stableMasterGuid = 0n;
    controller.notifyFrameXmlStable();
    assert.equal(shown(boot, "PetStableFrame"), 0, "PET_STABLE_CLOSED");
    world.open();
    shared.release();
    assert.equal(controller.frameXmlStablePublished(), false);
    assert.equal(shown(boot, "PetStableFrame"), 0);
    assert.notEqual(world.stableMasterGuid, 0n, "the master stays for the native rows");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  });
