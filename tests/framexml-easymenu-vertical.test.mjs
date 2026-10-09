import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock EasyMenu.lua (stock TOC line 139) in the production vertical — the real
// 3.3.5 EasyMenu/EasyMenu_Initialize over UIDropDownMenu.lua. Blizzard_CombatLog.xml:85 and most
// third-party add-ons open their menus through it; without the file `EasyMenu` is a nil global.
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

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

async function load(subset) {
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam: new CannedWorldSeam(), exercise: true,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, inventory };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "easymenu-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("EasyMenu.lua sits at its stock slot; the closure adds one file, no widget and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc[toc.indexOf("easymenu.lua") - 1], "runeframe.xml", "stock TOC line 139 follows RuneFrame.xml (138)");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.ok(vertical.includes("easymenu.lua"), "EasyMenu.lua is in the vertical");
  // 11.02-F2: VehicleMenuBar.xml (stock line 142) is in the vertical now; 140-141 still are not.
  assert.equal(vertical[vertical.indexOf("easymenu.lua") + 1], "vehiclemenubar.xml",
    "nothing of stock lines 140-141 is in the vertical, so VehicleMenuBar.xml (142) follows it");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "easymenu.lua"));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(lua(baseline.boot, "return type(EasyMenu)")[0], "nil", "the defect: no EasyMenu without the file");
    assert.equal(lua(candidate.boot, "return type(EasyMenu)")[0], "function");
    assert.equal(lua(candidate.boot, "return type(EasyMenu_Initialize)")[0], "function");
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    // 996 bytes of Lua and the synthetic TOC's 13-byte line naming it.
    assert.deepEqual(delta, { files: 1, bytes: 1009, widgets: 0, errors: 0, distinct: 0, luaFailed: 0 },
      `EasyMenu closure delta ${JSON.stringify(delta)}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("EasyMenu fills DropDownList1 from a menu table at the cursor; a click runs the entry's func and closes it", withClient, async () => {
  const { boot } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    const shown = lua(boot, `
      EASYMENU_TEST_CLICKS = {}
      local frame = CreateFrame("Frame", "EasyMenuTestDropDown", UIParent, "UIDropDownMenuTemplate")
      EasyMenu({
        { text = "Фильтры", isTitle = true, notCheckable = true },
        { text = "A", notCheckable = true, arg1 = "a", func = function(self, arg1) tinsert(EASYMENU_TEST_CLICKS, arg1) end },
        { text = "B", notCheckable = true, func = function() tinsert(EASYMENU_TEST_CLICKS, "b") end },
      }, frame, "cursor", 0, 0, "MENU")
      return DropDownList1:IsShown(), DropDownList1.numButtons, DropDownList1Button1:GetText(),
        DropDownList1Button2:GetText(), DropDownList1Button3:GetText(), UIDROPDOWNMENU_OPEN_MENU == frame,
        frame.displayMode`, 7);
    assert.deepEqual(shown, [true, 3, "Фильтры", "A", "B", true, "MENU"],
      "three entries, the title first, owned by the menu frame in MENU display mode");
    lua(boot, "DropDownList1Button2:Click()", 0);
    assert.deepEqual(lua(boot, "return #EASYMENU_TEST_CLICKS, EASYMENU_TEST_CLICKS[1], DropDownList1:IsShown()", 3),
      [1, "a", false], "the entry's func ran with its arg1, and the list closed");
    assert.equal(boot.errorCount, errors, "no Lua error on the way");
  } finally {
    boot.close();
  }
});
