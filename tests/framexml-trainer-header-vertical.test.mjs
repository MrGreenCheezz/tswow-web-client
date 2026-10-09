// Plan item 3.29 (L12, 04.10), MPQ vertical: the real Blizzard_TrainerUI over a canned trainer with skill
// lines (CANNED_GROUPED_TRAINER). A click on a header row collapses its line through the stock path
// (ClassTrainerSkillButton_OnClick → ClassTrainer_SetSelection → CollapseTrainerSkillLine → TRAINER_UPDATE →
// ClassTrainerFrame_Update, Blizzard_TrainerUI.lua:242-266, :387-394), the collapse-all button folds every
// line (:414-424), and Train buys the row selected under the headers.
import assert from "node:assert/strict";
import test, { after } from "node:test";

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
const { CannedWorldSeam, CANNED_GROUPED_TRAINER } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const decoder = new TextDecoder("utf-8");

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "trainer-header-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** Rows 1..n as the stock buttons show them: text, and + / - for a header. */
function shown(boot, count) {
  return lua(boot, `
    local out = {}
    for i = 1, ${count} do
      local button = _G["ClassTrainerSkill" .. i]
      if button:IsShown() then
        local texture = button:GetNormalTexture() and button:GetNormalTexture():GetTexture() or ""
        local mark = string.find(texture, "PlusButton") and "+" or (string.find(texture, "MinusButton") and "-" or "")
        out[#out + 1] = mark .. (button:GetText() or "")
      end
    end
    return table.concat(out, ";")
  `)[0];
}

test("a header click collapses its line, collapse-all folds every line, Train buys the row under a header", withClient, async () => {
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, CANNED_GROUPED_TRAINER);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const loaded = await boot.loadAddon("Blizzard_TrainerUI");
    assert.equal(loaded.ok, true, loaded.message);
    const errors = boot.errorCount;
    seam.openTrainer();
    const root = boot.bridge.getFrame("ClassTrainerFrame");
    assert.ok(root);
    boot.bridge.Show(root);
    lua(boot, "ClassTrainerFrame_Show()", 0);
    assert.equal(root.visible, true);
    assert.equal(shown(boot, 11),
      "-Защита;  Оборонительная стойка;-Неистовство;  Боевой крик;-Оружие;  Рывок;  Кровопускание");
    assert.deepEqual(lua(boot, "return GetTrainerSelectionIndex(), ClassTrainerFrame.selectedService", 2), [2, 2],
      "the first available service under its header");

    // The header row: ClassTrainerSkillButton_OnClick → ClassTrainer_SetSelection → CollapseTrainerSkillLine(1).
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("ClassTrainerSkill1"), "LeftButton", false), true);
    assert.equal(shown(boot, 11), "+Защита;-Неистовство;  Боевой крик;-Оружие;  Рывок;  Кровопускание");
    assert.deepEqual(lua(boot, "return GetNumTrainerServices()"), [6]);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("ClassTrainerSkill1"), "LeftButton", false), true);
    assert.deepEqual(lua(boot, "return GetNumTrainerServices()"), [7], "the second click expands it again");

    // The collapse-all button: CollapseTrainerSkillLine(0), then ExpandTrainerSkillLine(0).
    const all = boot.bridge.getFrame("ClassTrainerCollapseAllButton");
    assert.equal(boot.bridge.Click(all, "LeftButton", false), true);
    assert.equal(shown(boot, 11), "+Защита;+Неистовство;+Оружие");
    assert.deepEqual(lua(boot, "return ClassTrainerCollapseAllButton.collapsed"), [1]);
    assert.equal(boot.bridge.Click(all, "LeftButton", false), true);
    assert.deepEqual(lua(boot, "return GetNumTrainerServices()"), [7]);

    // Боевой крик (row 4) under Неистовство: the Train button buys exactly that spell.
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("ClassTrainerSkill4"), "LeftButton", false), true);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("ClassTrainerTrainButton"), "LeftButton", false), true);
    assert.deepEqual(seam.trainerBuyRequests, [6673]);
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.join(" | ")}`);
  } finally {
    boot.close();
  }
});
