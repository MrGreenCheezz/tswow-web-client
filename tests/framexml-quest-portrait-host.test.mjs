import assert from "node:assert/strict";
import test from "node:test";

let clientDir;
try {
  const { clientDirectory } = await import("../tools/paths.mjs");
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

test("selected QuestFrame.lua calls the host portrait bridge only for an existing questnpc", {
  skip: clientDir ? false : "selected 3.3.5a client unavailable",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const archives = await clientArchives(clientDir);
  const decoder = new TextDecoder();
  class QuestSeam extends CannedWorldSeam {
    giver = 0x701n;
    unitExists(unit) { return unit === "questnpc" ? this.giver !== undefined : super.unitExists(unit); }
    unitName(unit) { return unit === "questnpc" ? "Квестодатель" : super.unitName(unit); }
    questNpcPortraitGuid() { return this.giver; }
  }
  const seam = new QuestSeam();
  const calls = [];
  const boot = new FrameXmlBoot({
    provider: { async read(path) {
      const bytes = await archives.read(path);
      return bytes ? decoder.decode(bytes) : undefined;
    } },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    onQuestPortrait: (guid) => calls.push(guid),
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const selectedLua = await archives.read("Interface\\FrameXML\\QuestFrame.lua");
    assert.ok(selectedLua);
    assert.match(decoder.decode(selectedLua),
      /if \( UnitExists\("questnpc"\) \) then\s+SetPortraitTexture\(QuestFramePortrait, "questnpc"\)/);
    assert.ok(await archives.read("Interface\\QuestFrame\\UI-QuestLog-BookIcon.blp"),
      "the stock book fallback is present in the selected client resources");
    await boot.load();
    const portrait = boot.bridge.getFrame("QuestFramePortrait");
    const name = boot.bridge.getFrame("QuestFrameNpcNameText");
    assert.ok(portrait && name);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("QuestFrame")), false,
      "the helper does not publish the stock QuestFrame owner");

    assert.equal(boot.vm.execute("QuestFrame_SetPortrait()", "@quest-portrait-test").ok, true);
    assert.deepEqual(calls, [0x701n]);
    assert.equal(name.text, "Квестодатель");
    assert.equal(portrait.texture, "Interface\\QuestFrame\\UI-QuestLog-BookIcon",
      "the selected client's book texture stays behind the asynchronous model canvas");

    assert.equal(boot.vm.execute("SetPortraitTexture(QuestFramePortrait, 'target')",
      "@quest-portrait-wrong-unit").ok, true);
    assert.equal(boot.vm.execute("SetPortraitTexture(PlayerPortrait, 'questnpc')",
      "@quest-portrait-wrong-frame").ok, true);
    assert.deepEqual(calls, [0x701n], "the host callback owns only the exact stock quest slot");

    seam.giver = undefined;
    assert.equal(boot.vm.execute("QuestFrame_SetPortrait()", "@quest-portrait-absent").ok, true);
    assert.deepEqual(calls, [0x701n], "stock Lua skips SetPortraitTexture for an absent giver");
    assert.equal(portrait.texture, "Interface\\QuestFrame\\UI-QuestLog-BookIcon");
  } finally {
    boot.close();
    archives.close();
  }
});
