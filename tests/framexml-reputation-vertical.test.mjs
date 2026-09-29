import assert from "node:assert/strict";
import test from "node:test";

// Keep this proof against the retail archive.  A hand-built ReputationFrame would miss the stock
// tab template, row scripts and the relative ReputationFrame.lua sidecar that this slice promotes.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam, CANNED_REPUTATION } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function frame(boot, name) {
  const value = boot.bridge.getFrame(name);
  assert.ok(value, `${name} exists in the retail FrameXML subset`);
  return value;
}

test("MPQ ReputationFrame occupies Character tab 3 and runs stock rows through CannedWorldSeam",
  withClient, async () => {
    const { clientArchives } = await import("../tools/mpq.mjs");
    const chain = await clientArchives(clientDirectory);
    const decoder = new TextDecoder("utf-8");
    const requests = new Set();
    const subset = [...FRAMEXML_VERTICAL_TOC];
    const boot = new FrameXmlBoot({
      provider: {
        async read(path) {
          requests.add(normalized(path));
          const data = await chain.read(path);
          return data ? decoder.decode(data) : undefined;
        },
      },
      locale: "ruRU",
      subset,
      seam: new CannedWorldSeam(),
      exercise: false,
      screen: () => ({ width: 1024, height: 768 }),
    });
    try {
      const toc = await chain.read(FRAMEXML_TOC_PATH);
      assert.ok(toc, "retail FrameXML.toc is available");
      const realPaths = parseGlueToc(decoder.decode(toc), "interface/framexml/")
        .map((entry) => normalized(entry.path));
      const reputationPath = realPaths.indexOf("interface/framexml/reputationframe.xml");
      const skillPath = realPaths.indexOf("interface/framexml/skillframe.xml");
      const honorPath = realPaths.indexOf("interface/framexml/honorframe.xml");
      assert.ok(skillPath >= 0 && reputationPath > skillPath,
        "ReputationFrame follows SkillFrame in the retail TOC");
      assert.ok(honorPath >= 0 && reputationPath < honorPath,
        "ReputationFrame precedes HonorFrame in the retail TOC");

      const inventory = await boot.load();
      assert.ok(requests.has("interface/framexml/reputationframe.xml"),
        "ReputationFrame.xml is read from the MPQ chain");
      assert.ok(requests.has("interface/framexml/reputationframe.lua"),
        "ReputationFrame.lua is reached through the XML Script sidecar");
      assert.equal(inventory.files.missing.length, 0, "reputation subset has no missing files");
      assert.equal(inventory.xml.failed.length, 0, "ReputationFrame.xml parses");
      assert.equal(inventory.lua.failed, 0, "ReputationFrame.lua executes");

      const character = frame(boot, "CharacterFrame");
      const tab3 = frame(boot, "CharacterFrameTab3");
      const tab4 = frame(boot, "CharacterFrameTab4");
      const reputation = frame(boot, "ReputationFrame");
      assert.equal(reputation.id, 3, "the real ReputationFrame keeps stock id 3");
      assert.equal(tab3.id, 3, "CharacterFrameTab3 is the reputation tab");
      assert.equal(tab4.id, 4, "CharacterFrameTab4 remains the skill tab");
      assert.equal(reputation.visible, false, "ReputationFrame starts hidden");

      const beforeShowErrors = boot.vm.errors.length;
      assert.equal(boot.bridge.Show(character), true, "stock CharacterFrame can open");
      assert.equal(boot.bridge.Click(tab3, "LeftButton", false), true,
        "stock CharacterFrameTab3 click is dispatched");
      assert.equal(reputation.visible, true, "tab 3 shows stock ReputationFrame");
      assert.equal(frame(boot, "PaperDollFrame").visible, false,
        "tab 3 hides PaperDollFrame");
      assert.equal(frame(boot, "ReputationBar1FactionName").text, CANNED_REPUTATION[0].name,
        "first stock row renders the CannedWorldSeam header");
      assert.equal(frame(boot, "ReputationBar2FactionName").text, CANNED_REPUTATION[1].name,
        "second stock row renders the CannedWorldSeam child");
      assert.equal(frame(boot, "ReputationBar2ReputationBar").statusBar?.min, 0,
        "stock row normalizes the reputation bar minimum");
      assert.equal(frame(boot, "ReputationBar2ReputationBar").statusBar?.max, 6000,
        "stock row normalizes the reputation bar maximum");
      assert.equal(frame(boot, "ReputationBar2ReputationBar").statusBar?.value, 1500,
        "stock row normalizes the reputation bar value");
      assert.equal(boot.vm.errors.length, beforeShowErrors,
        "opening and selecting the stock reputation tab adds no Lua errors");
      assert.equal(boot.errorCount, 0, "default canned rows produce no handled Lua errors either");

      const expand = frame(boot, "ReputationBar1ExpandOrCollapseButton");
      assert.equal(boot.bridge.Click(expand, "LeftButton", false), true,
        "stock expand/collapse button dispatches");
      assert.equal(frame(boot, "ReputationBar2").visible, false,
        "collapsing the CannedWorldSeam header hides its child row");
      assert.equal(frame(boot, "ReputationBar1ExpandOrCollapseButton").visible, true);
      assert.equal(boot.bridge.Click(expand, "LeftButton", false), true);
      assert.equal(frame(boot, "ReputationBar2").visible, true,
        "expanding the same header restores its child row");

      assert.equal(boot.bridge.Hide(character), true, "CharacterFrame teardown hides the stock pane");
      assert.equal(boot.bridge.isVisible(reputation), false,
        "hiding CharacterFrame hides ReputationFrame effectively");
      assert.equal(boot.bridge.isVisible(tab3), false,
        "hiding CharacterFrame hides tab controls effectively");
    } finally {
      boot.close();
      chain.close();
    }
  });
