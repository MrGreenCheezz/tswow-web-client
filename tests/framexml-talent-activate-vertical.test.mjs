// Plan item 1.07 (L12, 04.10), MPQ vertical: the stock talent frame's «Активировать» button over a canned
// player with two talent groups. Blizzard_TalentUI.lua: the spec tabs (PlayerSpecTab_OnClick :976), the
// button shown for a selected group that is not the active one (PlayerTalentFrame_UpdateControls :479-490),
// its click (PlayerTalentFrameActivateButton_OnClick :523-530 → SetActiveTalentGroup), and the realm's
// answer (PLAYER_TALENT_UPDATE, ACTIVE_TALENT_GROUP_CHANGED) hiding it. SetActiveTalentGroup casts 63644
// for group 2 and 63645 for group 1 (Wow.exe 0x5c5e70, table 0xad05e8; FrameXmlTalentGroup.ts).
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
const decoder = new TextDecoder("utf-8");

/** The canned mage with a second, empty talent group; `active` is the 1-based active group. */
function twoGroups(active) {
  const base = CANNED_TALENT_SNAPSHOT.groups[0];
  const group = (number) => ({
    ...base, group: number, spec: number - 1, active: number === active,
    unspentPoints: number === active ? base.unspentPoints : undefined,
    tabs: number === 1 ? base.tabs : base.tabs.map((tab) => ({
      ...tab, pointsSpent: 0, talents: tab.talents.map((cell) => ({ ...cell, rank: 0 })),
    })),
  });
  return {
    ...CANNED_TALENT_SNAPSHOT, activeTalentGroup: active, activeSpec: active - 1, numTalentGroups: 2,
    groups: [group(1), group(2)],
  };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "talent-activate-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** The spec tab frame for "spec1"/"spec2" (PlayerSpecTabN.specIndex, set by the add-on's OnLoad). */
function specTab(boot, specIndex) {
  const [name] = lua(boot, `
    for i = 1, 10 do
      local frame = _G["PlayerSpecTab" .. i]
      if frame and frame.specIndex == ${JSON.stringify(specIndex)} then return frame:GetName() end
    end
  `);
  assert.ok(name, `a tab for ${specIndex}`);
  return boot.bridge.getFrame(name);
}

const activate = (boot) => lua(boot,
  `local button = PlayerTalentFrameActivateButton
   return button:IsShown() and 1 or 0, (button:IsShown() and button:IsEnabled()) and 1 or 0`, 2);

test("«Активировать» on the second group casts 63644; the realm's answer hides it; the first group casts 63645", withClient, async () => {
  let snapshot = twoGroups(1);
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, snapshot);
  // The realm's SMSG_TALENTS_INFO, as far as the snapshot goes (the canned seam keeps the one it was given).
  seam.talentSnapshot = (pet = false) => (pet ? undefined : snapshot);
  seam.setTalentGroups(2, 1);
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
    // The full stock corpus runs TalentFrameBase.lua/TalentFrameTemplates.xml; the vertical one does not,
    // so they go in first, as the glyph and inspect owners do (FrameXmlInspectOwner.ts).
    assert.equal(await installFrameXmlInspectPreload(boot), true);
    const loaded = await boot.loadAddon("Blizzard_TalentUI");
    assert.equal(loaded.ok, true, loaded.message);
    const errors = boot.errors.length;
    const root = boot.bridge.getFrame("PlayerTalentFrame");
    assert.ok(root);
    boot.bridge.Show(root);
    assert.equal(root.visible, true);
    assert.deepEqual(activate(boot), [0, 0], "the active group is selected: no button");

    assert.equal(boot.bridge.Click(specTab(boot, "spec2"), "LeftButton", false), true);
    assert.deepEqual(lua(boot, "return PlayerTalentFrame.talentGroup"), [2]);
    assert.deepEqual(activate(boot), [1, 1], "the inactive group: the button, enabled");
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("PlayerTalentFrameActivateButton"), "LeftButton", false), true);
    assert.deepEqual(seam.talentGroupCasts, [63644], "SetActiveTalentGroup(2) → the second activation spell, once");

    // The realm switched: its talent packet raises PLAYER_TALENT_UPDATE, then the group edge.
    snapshot = twoGroups(2);
    boot.bridge.dispatchEvent("PLAYER_TALENT_UPDATE");
    seam.setTalentGroups(2, 2);
    assert.deepEqual(activate(boot), [0, 0], "the selected group is the active one now");
    assert.deepEqual(lua(boot, "return PlayerTalentFrameStatusFrame:IsShown() and 1 or 0"), [1]);

    assert.equal(boot.bridge.Click(specTab(boot, "spec1"), "LeftButton", false), true);
    assert.deepEqual(activate(boot), [1, 1]);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("PlayerTalentFrameActivateButton"), "LeftButton", false), true);
    assert.deepEqual(seam.talentGroupCasts, [63644, 63645]);
    const talentErrors = boot.errors.slice(errors).map((error) => `${error.file}:${error.line} ${error.message}`);
    assert.deepEqual(talentErrors, [], "no Lua error on the way");
  } finally {
    boot.close();
  }
});
