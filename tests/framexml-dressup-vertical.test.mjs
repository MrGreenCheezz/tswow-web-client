import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock DressUpFrame over the production vertical and the canned seam, with a fixture
// host for the player's look and the item rows. One boot drives the whole route: the gate, the
// DressUpModel methods and IsDressableItem, a real Ctrl+click through HandleModifiedItemClick's
// DRESSUP branch, the stock buttons, and then — with Blizzard_AuctionUI loaded the way the world
// mount loads it — the auction wrapper's side frame, and the plain frame again once the house closes.
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
const { createLazyFrameXmlAuctionOwner } = await import("../dist/code/browser/framexml/FrameXmlAuctionOwner.js");
const { FrameXmlDressUpModels, frameXmlDressUpGate, installFrameXmlDressUp } = await import("../dist/code/browser/framexml/FrameXmlDressUp.js");
const decoder = new TextDecoder("utf-8");

const LOOK = Object.freeze({
  displayId: 49, race: 1, sex: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0,
  equipment: Object.freeze([{ slot: 4, inventoryType: 5, displayId: 9001 }, { slot: 6, inventoryType: 7, displayId: 9002 }]),
});
const ITEMS = new Map([
  [2001, { inventoryType: 5, displayId: 201 }],
  [2002, { inventoryType: 16, displayId: 202 }],
  [2003, { inventoryType: 11, displayId: 203 }],
]);
const link = (entry) => `|cff1eff00|Hitem:${entry}:0:0:0:0:0:0:0:80|h[Предмет ${entry}]|h|r`;
const slots = (outfit) => outfit?.equipment.map((item) => [item.slot, item.displayId]);

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
  const fn = boot.vm.compileFunction(code, "dressup-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("stock DressUpFrame: Ctrl+click dresses the model, the buttons work, the auction side frame takes over while the house is open", withClient, async () => {
  const held = { LSHIFT: false, RSHIFT: false, LCTRL: false, RCTRL: false, LALT: false, RALT: false, button: 0 };
  const seam = new CannedWorldSeam();
  const sounds = [];
  const playSound = seam.playSound.bind(seam);
  seam.playSound = (name) => { sounds.push(name); playSound(name); };
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
    modifiers: { state: () => held },
  });
  try {
    const started = performance.now();
    await boot.load();
    const loadMs = performance.now() - started;
    const renderer = treeRenderer();
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    assert.deepEqual(lua(boot, "return IsDressableItem == nil and 1 or 0, type(DressUpItemLink)", 2)[1], "function",
      "DressUpFrame.lua is in the boot vertical");

    const frame = frameXmlDressUpGate(boot, renderer);
    assert.equal(frame?.name, "DressUpFrame", "the stock tree passes its gate");
    assert.deepEqual(lua(boot, "return DressUpBackgroundTopLeft:GetTexture(), DressUpBackgroundBotRight:GetTexture()", 2),
      ["Interface\\DressUpFrame\\DressUpBackground-Human1", "Interface\\DressUpFrame\\DressUpBackground-Human4"],
      "SetDressUpBackground painted the canned human's race art at OnLoad");

    const asked = [];
    const models = new FrameXmlDressUpModels({
      look: (unit) => (unit === "player" ? LOOK : undefined),
      item: (entry) => { const row = ITEMS.get(entry); if (!row) asked.push(entry); return row; },
    });
    let changes = 0;
    assert.equal(installFrameXmlDressUp(boot, models, () => { changes += 1; }), true);
    const model = boot.bridge.getFrame("DressUpModel");
    assert.equal(model.model.facing, 0.61, "Model_OnLoad's 0.61 reaches the stage's facing");

    // A plain click is not DRESSUP; Ctrl+left is (Bindings.xml CTRL-BUTTON1).
    assert.deepEqual(lua(boot, `return HandleModifiedItemClick("${link(2001)}") and 1 or 0`), [0]);
    assert.equal(frame.visible, false);
    Object.assign(held, { LCTRL: true, button: 1 });
    assert.deepEqual(lua(boot, `return HandleModifiedItemClick("${link(2001)}") and 1 or 0, DressUpFrame:IsShown() and 1 or 0`, 2), [1, 1]);
    assert.deepEqual(slots(models.outfit(model)), [[4, 201], [6, 9002]], "SetUnit(\"player\") then TryOn: the chest replaced");
    assert.ok(sounds.includes("igCharacterInfoOpen"), "the stock OnShow played its sound");
    assert.ok(changes >= 3, "OnShow, SetUnit and TryOn each woke the stage");

    lua(boot, `DressUpItemLink("${link(2002)}")`);
    assert.deepEqual(slots(models.outfit(model)), [[4, 201], [6, 9002], [14, 202]], "a second try-on keeps the first");
    lua(boot, `DressUpItemLink("${link(2003)}"); DressUpItemLink("${link(2999)}")`);
    assert.deepEqual(slots(models.outfit(model)), [[4, 201], [6, 9002], [14, 202]], "a ring and an unknown row are not dressable");
    assert.deepEqual(asked, [2999], "the unknown row was asked for");

    lua(boot, "DressUpModelRotateLeftButton:Click()");
    assert.ok(Math.abs(model.model.facing - 0.58) < 1e-9, `the left arrow turns by 0.03 (${model.model.facing})`);
    lua(boot, "DressUpModel:Undress()");
    assert.deepEqual(slots(models.outfit(model)), []);
    lua(boot, "DressUpFrameResetButton:Click()");
    assert.deepEqual(slots(models.outfit(model)), [[4, 9001], [6, 9002]], "«Сброс» is Dress(): the player's own outfit");
    assert.ok(sounds.includes("gsTitleOptionOK"));
    lua(boot, "DressUpFrameCancelButton:Click()");
    assert.equal(frame.visible, false, "«Закрыть» is HideParentPanel");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-3))}`);
    assert.equal(boot.bridge.diagnostics.length, diagnostics);

    // The auction house: Blizzard_AuctionDressUp.lua's wrapper captured this DressUpItemLink.
    const owner = createLazyFrameXmlAuctionOwner(seam, boot, renderer, { hide() {}, show() {} }, (reason) => assert.fail(reason));
    seam.auctionWorld.open();
    await owner.settled;
    assert.equal(owner.loaded, true);
    assert.deepEqual(lua(boot, "return AuctionFrame:IsShown() and 1 or 0"), [1]);
    assert.deepEqual(lua(boot, `return HandleModifiedItemClick("${link(2001)}") and 1 or 0, AuctionDressUpFrame:IsShown() and 1 or 0, DressUpFrame:IsShown() and 1 or 0`, 3),
      [1, 1, 0], "while AuctionFrame is shown the side frame dresses, not DressUpFrame");
    const side = boot.bridge.getFrame("AuctionDressUpModel");
    assert.deepEqual(slots(models.outfit(side)), [[4, 201], [6, 9002]], "AuctionDressUpModel shares the DressUpModel type's methods");
    assert.equal(side.model.facing, 0.61, "its Model_OnLoad ran after the install and reached the facing");
    lua(boot, "AuctionDressUpFrameResetButton:Click()");
    assert.deepEqual(slots(models.outfit(side)), [[4, 9001], [6, 9002]]);
    lua(boot, "HideUIPanel(AuctionFrame)");
    assert.deepEqual(lua(boot, "return AuctionFrame:IsShown() and 1 or 0"), [0]);
    assert.deepEqual(lua(boot, `DressUpItemLink("${link(2002)}"); return DressUpFrame:IsShown() and 1 or 0`), [1],
      "with the house closed the wrapper hands the link to the original");
    assert.deepEqual(slots(models.outfit(model)), [[4, 9001], [6, 9002], [14, 202]], "a fresh SetUnit: the earlier try-ons are gone");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-3))}`);
    console.log(`[dressup] vertical boot ms ${Math.round(loadMs)}`);
    owner.dispose();
  } finally {
    boot.close();
  }
});
