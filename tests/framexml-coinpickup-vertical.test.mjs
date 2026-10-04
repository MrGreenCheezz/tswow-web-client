import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.09 (L5c, 04.10), MPQ-backed: the stock CoinPickupFrame.xml joins the vertical at its
// stock slot (FrameXML.toc line 48, between MirrorTimer.xml and StackSplitFrame.xml). MoneyFrame.xml's
// coin buttons call OpenCoinPickupFrame and its OnHide CoinPickupFrame:Hide — both nil without the file.
// Over the canned seam: the frame's «OK» runs the stock PickupFunc (PickupPlayerMoney) and the hand
// holds the money (FrameXmlCursorMoney.ts).
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
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const { installFrameXmlCoinPickupKeyboard } = await import("../dist/code/browser/framexml/FrameXmlCoinPickupKeyboard.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

async function load(subset = FRAMEXML_VERTICAL_TOC) {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "coinpickup-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("CoinPickupFrame.xml at its stock slot: two files, its frame, no Lua error; the coin dialog picks money up", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(toc.indexOf("coinpickupframe.xml"), toc.indexOf("mirrortimer.xml") + 1, "stock: MirrorTimer, CoinPickupFrame");
  assert.equal(vertical.indexOf("coinpickupframe.xml"), vertical.indexOf("mirrortimer.xml") + 1);
  assert.equal(vertical.indexOf("stacksplitframe.xml"), vertical.indexOf("coinpickupframe.xml") + 1);
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "coinpickupframe.xml"));
    candidate = await load();
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 2, bytes: 11_577, widgets: 27, errors: 0, distinct: 0 }, `delta ${JSON.stringify(delta)}`);
    assert.equal(baseline.boot.bridge.getFrame("CoinPickupFrame")?.name, undefined);
    const frame = candidate.boot.bridge.getFrame("CoinPickupFrame");
    assert.equal(frame?.type, "Frame");
    assert.equal(frame.visible, false);

    const { boot, seam } = candidate;
    const errorsBefore = boot.vm.errors.length;
    const purse = seam.money();
    assert.ok(purse >= 3, `the canned purse holds money: ${purse}`);
    // A backpack-like money frame of type PLAYER (MoneyFrame.lua:16-31), its gold button's dialog.
    assert.deepEqual(lua(boot, `
      local owner = CreateFrame("Frame", "CoinPickupTestMoney", UIParent, "SmallMoneyFrameTemplate")
      MoneyFrame_SetType(owner, "PLAYER")
      OpenCoinPickupFrame(1, MoneyTypeInfo[owner.moneyType].UpdateFunc(owner), owner)
      CoinPickupFrame_OnChar(CoinPickupFrame, "2")
      local shown, money = CoinPickupFrame:IsShown() and 1 or 0, CoinPickupFrame.money
      CoinPickupFrameOkay_Click()
      return shown, money, CoinPickupFrame:IsShown() and 1 or 0
    `, 3), [1, 2, 0]);
    assert.deepEqual(lua(boot, "local t, m = GetCursorInfo(); return GetCursorMoney(), CursorHasMoney(), t, m", 4), [2, 1, "money", 2]);
    assert.deepEqual(lua(boot, "return MoneyTypeInfo.PLAYER.UpdateFunc(CoinPickupTestMoney)"), [purse - 2], "the purse shows less while held");
    // A second click on a coin button with money held drops it back (CoinPickupFrame.lua:8-14).
    lua(boot, "OpenCoinPickupFrame(1, 10, CoinPickupTestMoney)");
    assert.deepEqual(lua(boot, "return GetCursorMoney(), CoinPickupFrame:IsShown() and 1 or 0", 2), [0, 0]);

    // The keyboard (FrameXmlCoinPickupKeyboard.ts): digits type, Backspace erases, Enter is «OK»;
    // a key the dialog does not answer goes on to the world.
    const listeners = [];
    const cleanup = installFrameXmlCoinPickupKeyboard(boot, {
      addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
      removeEventListener: () => { listeners.length = 0; },
    });
    assert.deepEqual(listeners.map(({ type, capture }) => [type, capture]), [["keydown", true]]);
    const press = (code, key) => {
      let taken = false;
      listeners[0].listener({ code, key, target: null, ctrlKey: false, altKey: false, metaKey: false,
        preventDefault() { taken = true; }, stopPropagation() {} });
      return taken;
    };
    assert.equal(press("Digit4", "4"), false, "hidden dialog: the world keeps the keys");
    lua(boot, "OpenCoinPickupFrame(1, 500, CoinPickupTestMoney)");
    assert.equal(press("Digit4", "4"), true);
    press("Digit2", "2");
    assert.deepEqual(lua(boot, "return CoinPickupFrame.money"), [42]);
    press("Backspace", "Backspace");
    assert.deepEqual(lua(boot, "return CoinPickupFrame.money"), [4]);
    assert.equal(press("KeyW", "w"), false, "movement is not the dialog's");
    press("Enter", "Enter");
    assert.deepEqual(lua(boot, "return GetCursorMoney(), CoinPickupFrame:IsShown() and 1 or 0", 2), [4, 0]);
    lua(boot, "DropCursorMoney()");
    // Escape is «Cancel» (GetBindingFromClick answers TOGGLEGAMEMENU): the dialog goes, the menu does not come.
    lua(boot, "OpenCoinPickupFrame(1, 500, CoinPickupTestMoney)");
    assert.equal(press("Escape", "Escape"), true);
    assert.deepEqual(lua(boot, "return CoinPickupFrame:IsShown() and 1 or 0, GetCursorMoney(), GameMenuFrame:IsShown() and 1 or 0", 3), [0, 0, 0]);
    cleanup();
    assert.equal(listeners.length, 0);
    assert.equal(boot.vm.errors.length, errorsBefore, "no Lua error on the way");
  } finally {
    baseline?.boot.close();
    candidate?.boot.close();
  }
});
