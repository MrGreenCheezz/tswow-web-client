import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tswowInstall } from "../tools/paths.mjs";
import { doublePacket, TswowAddonTestTransport } from "../tools/check-tswow-addons.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { CannedWorldSeam } from "../dist/code/browser/framexml/CannedWorldSeam.js";
import { createFrameXmlTsAddonWindows } from "../dist/code/browser/framexml/FrameXmlTsAddonWindows.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

let generated;
try {
  const install = tswowInstall();
  const addon = join(install, "modules/default/datasets/dataset/luaxml/Interface/FrameXML/TSAddons/gem-abilities");
  generated = await Promise.all([
    readFile(join(install, "bin/include-addon/RequireStub.lua"), "utf8"),
    readFile(join(install, "bin/include-addon/ClientNetwork.lua"), "utf8"),
    readFile(join(addon, "shared/SocketMessages.lua"), "utf8"),
    readFile(join(addon, "addon/socketing.lua"), "utf8"),
    readFile(join(addon, "../../lualib_bundle.lua"), "utf8"),
  ]);
} catch { generated = undefined; }

test("the generated gem addon selects a real item and its original button sends equipment and bag extraction packets", {
  skip: generated ? false : "Generated gem-abilities addon and TSWoW libraries are not installed",
}, async () => {
  const seam = new CannedWorldSeam();
  seam.setInventoryItem(5, { entry: 1234, name: "Socketed chest", texture: "Interface\\Icons\\INV_Chest_Cloth_17", count: 1 });
  seam.setContainerItem(0, 1, { entry: 1235, name: "Socketed gloves", texture: "Interface\\Icons\\INV_Gauntlets_17", count: 1 });
  const packets = new TswowAddonTestTransport();
  const prefix = "interface/framexml/";
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      [prefix + "framexml.toc"]: [
        "UIParent.lua", "Templates.xml", "## tsaddon-begin-lib", "RequireStub.lua", "lualib_bundle.lua", "ClientNetwork.lua", "## tsaddon-end-lib",
        "## tsaddon-begin: gem-abilities", "TSAddons/gem-abilities/shared/SocketMessages.lua",
        "TSAddons/gem-abilities/addon/socketing.lua", "TSAddons/gem-abilities/addon/addon.lua", "## tsaddon-end: gem-abilities",
      ].join("\n"),
      [prefix + "uiparent.lua"]: `
        UIParent = CreateFrame("Frame", "UIParent")
        UIParent:SetSize(1024, 768)
        SlashCmdList = {}
        function ItemSocketingFrame_LoadUI() LoadAddOn("Blizzard_ItemSocketingUI") end
      `,
      [prefix + "templates.xml"]: `<Ui>
        <Font name="GameFontNormalLarge" font="Fonts\\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="16"/></FontHeight></Font>
        <Font name="GameFontHighlight" font="Fonts\\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="12"/></FontHeight></Font>
        <Button name="UIPanelButtonTemplate" virtual="true"><ButtonText name="$parentText" /></Button>
        <Button name="UIPanelCloseButton" virtual="true" />
      </Ui>`,
      [prefix + "requirestub.lua"]: generated[0],
      [prefix + "clientnetwork.lua"]: generated[1],
      [prefix + "lualib_bundle.lua"]: generated[4],
      [prefix + "tsaddons/gem-abilities/shared/socketmessages.lua"]: generated[2],
      [prefix + "tsaddons/gem-abilities/addon/socketing.lua"]: generated[3],
      [prefix + "tsaddons/gem-abilities/addon/addon.lua"]: `require("TSAddons.gem-abilities.addon.socketing").initSocketing()` ,
    }),
    subset: ["UIParent.lua", "Templates.xml"], includeActiveTsAddons: true, seam, clientNetwork: packets,
  });
  const execute = (source) => {
    const result = boot.vm.execute(source, "@socketing-test");
    assert.equal(result.ok, true, result.error);
  };
  try {
    await boot.load();
    assert.deepEqual(boot.errors, []);
    execute('SlashCmdList.GEM_SOCKET("chest")');
    const frame = boot.bridge.getFrame("ItemSocketingFrame");
    assert.ok(frame && boot.bridge.isVisible(frame), "The /socket command must open the item window");
    assert.equal(boot.bridge.getFrame("ItemSocketingFrameItemName").text, "Socketed chest");
    assert.equal(boot.bridge.getFrame("GemAbilitiesExtractButton").enabled, true);
    execute("GemAbilitiesExtractButton:Click()");
    assert.deepEqual(packets.sent, [{ opcode: 85, body: doublePacket(0, 0, 5) }]);
    assert.equal(boot.bridge.isVisible(frame), false, "Extraction closes the selected item window");

    execute("SocketContainerItem(0, 1)");
    assert.equal(boot.bridge.isVisible(frame), true);
    assert.equal(boot.bridge.getFrame("ItemSocketingFrameItemName").text, "Socketed gloves");
    execute("GemAbilitiesExtractButton:Click()");
    assert.deepEqual(packets.sent[1], { opcode: 85, body: doublePacket(1, 0, 1) });

    execute("SocketInventoryItem(5)");
    const windows = createFrameXmlTsAddonWindows(boot);
    assert.equal(windows.isOpen(), true, "The socket window participates in the native Escape route");
    windows.close();
    assert.equal(boot.bridge.isVisible(frame), false);
    assert.equal(packets.sent.length, 2, "Closing socketing does not request extraction");
    windows.dispose();

    execute("SocketInventoryItem(5)");
    seam.setInventoryItem(5, undefined);
    assert.equal(boot.bridge.isVisible(frame), false, "Removing the selected item closes the window");
    execute("GemAbilitiesExtractButton:Click()");
    assert.equal(packets.sent.length, 2, "A stale selection cannot send an extraction request");
    execute("SocketInventoryItem(5); SocketContainerItem(-1, 1); SocketContainerItem(0, 0)");
    assert.equal(boot.bridge.isVisible(frame), false, "Invalid and empty slots never open the window");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
  assert.equal(packets.handlers.size, 0);
});
