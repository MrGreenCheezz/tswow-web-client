// Plan item 3.33 (13.10), MPQ vertical: the stock talent frame with the talent preview on, over a canned
// mage (CANNED_TALENT_SNAPSHOT: Огненный удар 1/2, three free points) and the preview model the live seam
// uses (FrameXmlTalentPreview.ts). Blizzard_TalentUI.lua: a left click previews a point
// (PlayerTalentFrameTalent_OnClick :442-456), the preview bar and its buttons (PlayerTalentFrame_UpdateControls
// :494-514), «Изучить» → CONFIRM_LEARN_PREVIEW_TALENTS → LearnPreviewTalents (:1-8, :571). And Wow.exe's
// previewTalents CVar callback (0x005127d0): every SetCVar of it clears the preview and signals
// PREVIEW_TALENT_POINTS_CHANGED(0, 0, 0, -points), which the frame refreshes on (:322-326).
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
const { CannedWorldSeam, CANNED_TALENT_SNAPSHOT } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { installFrameXmlInspectPreload } = await import("../dist/code/browser/framexml/FrameXmlInspectOwner.js");
const { FrameXmlTalentPreviewModel } = await import("../dist/code/browser/framexml/FrameXmlTalentPreview.js");
const decoder = new TextDecoder("utf-8");

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "talent-preview-vertical", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const bar = (boot) => lua(boot, `
  return PlayerTalentFramePreviewBar:IsShown() and 1 or 0, PlayerTalentFrameLearnButton:IsEnabled(),
    GetGroupPreviewTalentPointsSpent(), PlayerTalentFrameTalent1Rank:GetText()`, 4);

test("the stock talent frame previews a point, the CVar's every write clears it, «Изучить» learns it", withClient, async () => {
  const base = CANNED_TALENT_SNAPSHOT;
  const learned = [];
  const model = new FrameXmlTalentPreviewModel({
    snapshot: (pet) => (pet ? undefined : base), packet: () => base, learn: (pet, talents) => learned.push([pet, talents]),
  });
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, base);
  // The live seam's wiring (LiveWorldSeam: talentPreview and the decorated snapshot) on the canned world.
  seam.talentPreview = model;
  seam.talentSnapshot = (pet = false) => (pet ? undefined : model.apply(false, base));
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return boot.pump.fire(event, ...args); } });
  try {
    await boot.load();
    assert.equal(await installFrameXmlInspectPreload(boot), true);
    const loaded = await boot.loadAddon("Blizzard_TalentUI");
    assert.equal(loaded.ok, true, loaded.message);
    const errors = boot.errors.length;
    lua(boot, `SetCVar("previewTalents", "1")`, 0);
    const root = boot.bridge.getFrame("PlayerTalentFrame");
    boot.bridge.Show(root);
    assert.equal(root.visible, true);
    assert.deepEqual(bar(boot), [1, 0, 0, "1"], "the preview bar, «Изучить» off, nothing previewed, rank 1");

    assert.equal(boot.bridge.Click(boot.bridge.getFrame("PlayerTalentFrameTalent1"), "LeftButton", false), true);
    assert.deepEqual(bar(boot), [1, 1, 1, "2"], "a left click previews a point: rank 2, «Изучить» on");
    assert.deepEqual(fired.at(-1), ["PREVIEW_TALENT_POINTS_CHANGED", 1, 1, 1, 1]);

    // The callback runs on the same value too, before the write; the frame refreshes on its event.
    fired.length = 0;
    lua(boot, `SetCVar("previewTalents", "1")`, 0);
    assert.deepEqual(fired, [["PREVIEW_TALENT_POINTS_CHANGED", 0, 0, 0, -1], ["PREVIEW_PET_TALENT_POINTS_CHANGED", 0, 0, 0, 0]]);
    assert.deepEqual(bar(boot), [1, 0, 0, "1"], "the preview is gone and the frame shows it");

    assert.equal(boot.bridge.Click(boot.bridge.getFrame("PlayerTalentFrameTalent1"), "LeftButton", false), true);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("PlayerTalentFrameLearnButton"), "LeftButton", false), true);
    assert.deepEqual(lua(boot, `
      local dialog = StaticPopup_FindVisible("CONFIRM_LEARN_PREVIEW_TALENTS")
      if not dialog then return 0 end
      StaticPopup_OnClick(dialog, 1)
      return 1`), [1], "the confirmation is up");
    assert.deepEqual(learned, [[false, [{ talentId: 100, rank: 2 }]]], "LearnPreviewTalents sends the previewed rank");
    const talentErrors = boot.errors.slice(errors).map((error) => `${error.file}:${error.line} ${error.message}`);
    assert.deepEqual(talentErrors, [], "no Lua error on the way");
  } finally {
    boot.close();
  }
});
