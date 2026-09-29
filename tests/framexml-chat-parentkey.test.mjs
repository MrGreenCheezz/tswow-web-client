import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  ({ clientDirectory } = await import("../tools/paths.mjs"));
  clientDirectory = clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");

test("stock classic chat keeps its editBox parentKey after Interface Options reparents it",
  { skip: clientDirectory ? false : "no 3.3.5a client on this machine" }, async () => {
    const { clientArchives } = await import("../tools/mpq.mjs");
    const chain = await clientArchives(clientDirectory);
    const decoder = new TextDecoder("utf-8");
    const provider = {
      async read(path) {
        const bytes = await chain.read(path.replaceAll("/", "\\"));
        return bytes ? decoder.decode(bytes) : undefined;
      },
    };
    const boot = new FrameXmlBoot({
      provider,
      locale: "ruRU",
      screen: () => ({ width: 1280, height: 768 }),
      seam: new CannedWorldSeam(),
    });
    try {
      const report = await boot.load();
      const chat = boot.bridge.getFrame("ChatFrame1");
      const editBox = boot.bridge.getFrame("ChatFrame1EditBox");
      const uiParent = boot.bridge.getFrame("UIParent");
      assert.ok(chat && editBox && uiParent);
      assert.equal(editBox.parent, uiParent,
        "stock InterfaceOptionsPanels.lua moves the classic input box for layout");
      assert.equal(chat.children.includes(editBox), false,
        "the visual hierarchy follows SetParent");

      const probe = boot.vm.execute(`
        StockChatIsClassic = GetCVar("chatStyle") == "classic"
        StockChatOwnerHasEditBox = DEFAULT_CHAT_FRAME.editBox == ChatFrame1EditBox
        StockChatMenuHasEditBox = ChatMenu.chatFrame.editBox == ChatFrame1EditBox
        StockChatLanguageMenuHasEditBox = LanguageMenu:GetParent().chatFrame.editBox == ChatFrame1EditBox
        StockChatChooseBox = ChatEdit_ChooseBoxForSend() == ChatFrame1EditBox
      `, "@stock-chat-parent-key-regression");
      assert.equal(probe.ok, true, probe.error ?? "stock chat parentKey probe failed");
      for (const name of ["StockChatIsClassic", "StockChatOwnerHasEditBox",
        "StockChatMenuHasEditBox", "StockChatLanguageMenuHasEditBox", "StockChatChooseBox"]) {
        assert.equal(boot.vm.getGlobal(name), true, name);
      }
      assert.deepEqual(report.errors.filter((error) => error.file === "interface/framexml/chatframe.lua"), [],
        "classic chat initialization and language menu run without stock ChatFrame errors");
    } finally {
      boot.close();
      chain.close();
    }
  });
