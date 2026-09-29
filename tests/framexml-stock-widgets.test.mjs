import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");

const decoder = new TextDecoder("utf-8");

// The stock widgets the renderer lane's fixes are for, on the client's own FrameXML: the
// CharacterFrame tab labels (ButtonText with the template's state fonts), and a UIDropDownMenu list,
// which is parentless and used to be measured against itself and flipped off the top of the screen.
test("stock tab labels take their state fonts and stock dropdown lists open downward", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const provider = {
    async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(),
    screen: () => ({ width: 1024, height: 768 }), exercise: false,
  });
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@stock-widgets", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  try {
    await boot.load();
    // What the world mount answers for UIParent (FrameXmlWorldMount's setMeasure).
    boot.bridge.setMeasure((frame) => frame.name === "UIParent" ? { width: 1024, height: 768 } : undefined);
    const errorsBefore = boot.errorCount;

    const font = (index) => boot.bridge.getFrame(`CharacterFrameTab${index}Text`).fontObject;
    // CharacterFrame_OnLoad selects tab 1 (PanelTemplates_SetTab): disabled, so white.
    assert.equal(font(1), "GameFontHighlightSmall", "the selected (disabled) tab is white");
    assert.equal(font(3), "GameFontNormalSmall", "CharacterFrameTabButtonTemplate's NormalFont");
    const [file, height] = run(`return CharacterFrameTab3Text:GetFont()`, 2);
    assert.match(String(file), /FRIZQT/i);
    assert.equal(height, 10, "not the 16px host default the label used to fall back to");
    run(`PanelTemplates_SetTab(CharacterFrame, 3)`);
    assert.deepEqual([font(1), font(3)], ["GameFontNormalSmall", "GameFontHighlightSmall"]);
    assert.deepEqual(run(`return CharacterFrameTab1:IsEnabled(), CharacterFrameTab3:IsEnabled()`, 2), [1, 0]);

    run(`ProbeDropDown = CreateFrame("Frame", "ProbeDropDown", UIParent, "UIDropDownMenuTemplate")
      ProbeDropDown:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 100, -20)
      UIDropDownMenu_Initialize(ProbeDropDown, function()
        for index = 1, 3 do
          local info = UIDropDownMenu_CreateInfo()
          info.text = "Пункт " .. index
          UIDropDownMenu_AddButton(info)
        end
      end)
      ToggleDropDownMenu(1, nil, ProbeDropDown)`);
    const [shown, point, relativePoint, top] = run(`local point, _, relativePoint = DropDownList1:GetPoint(1)
      return DropDownList1:IsShown(), point, relativePoint, DropDownList1:GetTop()`, 4);
    assert.equal(shown, true);
    assert.equal(point, "TOPLEFT", "a list under a dropdown at the top of the screen stays under it");
    assert.equal(relativePoint, "BOTTOMLEFT");
    assert.ok(top > 600 && top <= 768, `the list's top is on the screen (${top})`);
    // A menu entry's label takes UIDropDownMenuButtonTemplate's NormalFont (GameFontHighlightSmallLeft)
    // instead of the host's 16px default.
    assert.equal(boot.bridge.getFrame("DropDownList1Button1NormalText").fontObject, "GameFontHighlightSmallLeft");
    const [entryFile, entryHeight] = run(`return DropDownList1Button1NormalText:GetFont()`, 2);
    assert.match(String(entryFile), /FRIZQT/i);
    assert.equal(entryHeight, 10);
    assert.equal(boot.errorCount, errorsBefore, "no Lua errors");
  } finally {
    boot.close();
  }
});
