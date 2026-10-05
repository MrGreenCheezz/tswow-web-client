import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the real Blizzard_InspectUI loaded on demand by the lazy owner the world mount publishes
// (FrameXmlInspectOwner.ts) and reached through the stock InspectUnit (FrameXmlInspectMount.ts), over
// the vertical corpus and the canned inspection: CMSG_INSPECT, the paper doll from the visible entries
// and then from SMSG_INSPECT_TALENT's enchantments, the talent tab over the inspected trees, the PvP
// tab over the honor and arena answers, and the target change that closes it.
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
const { CannedWorldSeam, CANNED_TARGET } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createLazyFrameXmlInspectOwner, frameXmlInspectGate } = await import("../dist/code/browser/framexml/FrameXmlInspectOwner.js");
const { routeFrameXmlInspectUnit } = await import("../dist/code/browser/framexml/FrameXmlInspectMount.js");
const { CANNED_INSPECT_TARGET, FRAMEXML_CANNED_INSPECT_GUID } = await import("../dist/code/browser/framexml/FrameXmlInspectCanned.js");
const decoder = new TextDecoder("utf-8");

async function load() {
  const seam = new CannedWorldSeam();
  const reads = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        if (data) reads.push([path.toLowerCase(), data.length]);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam, reads };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "inspect-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
    addRoots() {},
    sync() {},
  };
}

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));
const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

async function opened() {
  const { boot, seam, reads } = await load();
  seam.setTarget(CANNED_INSPECT_TARGET);
  const fallbacks = [];
  const owner = createLazyFrameXmlInspectOwner(seam, boot, renderer(), (unit) => fallbacks.push(unit));
  const unroute = routeFrameXmlInspectUnit(boot, owner);
  return { boot, seam, reads, owner, unroute, fallbacks };
}

test("InspectUnit loads Blizzard_InspectUI on first use, sends CMSG_INSPECT and shows the stock paper doll", withClient, async () => {
  const { boot, seam, reads, owner, unroute, fallbacks } = await opened();
  try {
    assert.equal(boot.bridge.getFrame("InspectFrame")?.name, undefined, "no inspect frame at boot");
    const errors = boot.errorCount;
    const before = reads.length;
    const widgets = boot.bridge.frames.length;
    lua(boot, 'InspectUnit("target")', 0);
    await owner.settled;
    await settle();
    const files = reads.slice(before);
    const addon = files.filter(([path]) => path.includes("blizzard_inspectui"));
    assert.equal(addon.length, 10, JSON.stringify(files));
    assert.equal(addon.reduce((sum, [, bytes]) => sum + bytes, 0), 75_300);
    assert.deepEqual(files.slice(0, 2), [["interface/framexml/talentframebase.lua", 23_535],
      ["interface/framexml/talentframetemplates.xml", 1_910]], "the two stock talent files run first");
    // The add-on and the talent tab's forty buttons with their branches and arrows (TalentFrameTemplates.xml).
    assert.equal(boot.bridge.frames.length - widgets, 839);
    assert.deepEqual(fallbacks, []);
    const frame = boot.bridge.getFrame("InspectFrame");
    assert.equal(boot.bridge.isVisible(frame), true);
    assert.deepEqual(seam.inspectWorld.requests, [`inspect:${FRAMEXML_CANNED_INSPECT_GUID}`]);
    assert.equal(boot.bridge.getFrame("InspectNameText").text, "Алистра");
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("InspectPaperDollFrame")), true);
    // Before SMSG_INSPECT_TALENT: the visible entry and its permanent enchantment only.
    assert.equal(boot.bridge.getFrame("InspectHeadSlotIconTexture").texture, "Interface\\Icons\\INV_Crown_01");
    assert.match(lua(boot, 'return GetInventoryItemLink("target", 1)')[0], /\|Hitem:40416:0:0:0:0:0:0:0:80\|/);
    assert.deepEqual(lua(boot, 'return GetInventoryItemLink("target", 2)'), [undefined], "an empty neck slot");
    assert.notEqual(boot.bridge.getFrame("InspectNeckSlotIconTexture").texture, undefined, "the empty slot shows its background");
    seam.inspectWorld.answer();
    assert.match(lua(boot, 'return GetInventoryItemLink("target", 1)')[0], /\|Hitem:40416:0:3621:3518:0:0:0:0:80\|h\[Доблестный венец ледяного огня\]/,
      "the answer's socket enchantments are in the link");
    assert.deepEqual(lua(boot, 'return GetInventoryItemLink("player", 1)'), [undefined], "the player's own slot still reads the player");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    unroute();
    owner.dispose();
    boot.close();
  }
});

test("hovering an inspected slot shows the item link; the talent and PvP tabs read the inspected player", withClient, async () => {
  const { boot, seam, owner, unroute } = await opened();
  try {
    lua(boot, 'InspectUnit("target")', 0);
    await owner.settled;
    await settle();
    seam.inspectWorld.answer();
    const errors = boot.errorCount;
    lua(boot, 'InspectPaperDollItemSlotButton_OnEnter(InspectHeadSlot)', 0);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("GameTooltip")), true);
    // The canned seam has no item metadata, so the title is the entry; the link is the inspected one.
    assert.match(lua(boot, "return GameTooltip:GetItem()", 2)[1], /|Hitem:40416:0:3621:3518:0:0:0:0:80|/);
    lua(boot, "GameTooltip:Hide()", 0);

    lua(boot, "InspectFrameTab3:Click()", 0);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("InspectTalentFrame")), true);
    assert.deepEqual(lua(boot, "return GetTalentTabInfo(1, true)", 3), ["Огонь", "Interface\\Icons\\Spell_Fire_FlameBolt", 1]);
    assert.deepEqual(lua(boot, "return GetNumTalentTabs(true), GetNumTalents(1, true), GetActiveTalentGroup(true)", 3), [1, 2, 1]);
    assert.equal(boot.bridge.getFrame("InspectTalentFrameTalent1").visible, true);
    assert.equal(boot.bridge.getFrame("InspectTalentFrameTab1").text, "Огонь");

    lua(boot, "InspectFrameTab2:Click()", 0);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("InspectPVPFrame")), true);
    assert.deepEqual(seam.inspectWorld.requests.slice(1), [`honor:${FRAMEXML_CANNED_INSPECT_GUID}`]);
    seam.inspectWorld.answerHonor();
    assert.equal(boot.bridge.getFrame("InspectPVPHonorTodayKills").text, "3");
    assert.equal(boot.bridge.getFrame("InspectPVPHonorLifetimeKills").text, "2104");
    assert.equal(boot.bridge.getFrame("InspectPVPTeam1DataName").text, "Ледяные искры");
    assert.equal(boot.bridge.getFrame("InspectPVPTeam1DataRating").text, "1650");
    // Back to the PvP tab of the same inspection: the answer is kept (HasInspectHonorData).
    lua(boot, "InspectFrameTab1:Click() InspectFrameTab2:Click()", 0);
    assert.equal(seam.inspectWorld.requests.length, 2);
    // Inspected again: NotifyInspect forgot it, so the PvP tab asks again and shows nothing old meanwhile.
    lua(boot, 'InspectUnit("target")', 0);
    assert.deepEqual(lua(boot, "return HasInspectHonorData(), GetInspectHonorData()", 2), [false, 0]);
    lua(boot, "InspectFrameTab2:Click()", 0);
    assert.deepEqual(seam.inspectWorld.requests.slice(2), [`inspect:${FRAMEXML_CANNED_INSPECT_GUID}`, `honor:${FRAMEXML_CANNED_INSPECT_GUID}`]);
    seam.inspectWorld.answerHonor();
    assert.equal(boot.bridge.getFrame("InspectPVPHonorLifetimeKills").text, "2104");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    unroute();
    owner.dispose();
    boot.close();
  }
});

test("a hostile target cannot be inspected; a target change closes the stock frame", withClient, async () => {
  const { boot, seam, owner, unroute } = await opened();
  try {
    lua(boot, 'InspectUnit("target")', 0);
    await owner.settled;
    await settle();
    const frame = boot.bridge.getFrame("InspectFrame");
    assert.equal(boot.bridge.isVisible(frame), true);
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, 'return CheckInteractDistance("target", 1), CheckInteractDistance("target", 3)', 2), [true, true]);
    // 5.18: follow (index 4, 28 yards) answers now; UnitPopup_OnUpdate enables «Следовать» by it.
    assert.deepEqual(lua(boot, 'return CheckInteractDistance("target", 4)'), [true]);
    seam.setTarget(CANNED_TARGET);
    assert.equal(boot.bridge.isVisible(frame), false, "PLAYER_TARGET_CHANGED and CanInspect false hide it");
    assert.deepEqual(lua(boot, 'return CanInspect("target")'), [false]);
    lua(boot, 'InspectUnit("target")', 0);
    assert.equal(boot.bridge.isVisible(frame), false, "the hostile mage opens nothing");
    assert.equal(seam.inspectWorld.requests.length, 1, "and sends no CMSG_INSPECT");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    unroute();
    owner.dispose();
    boot.close();
  }
});

test("a failed gate hands InspectUnit back to the stock function", withClient, async () => {
  const { boot, seam } = await load();
  seam.setTarget(CANNED_INSPECT_TARGET);
  const fallbacks = [];
  const broken = { ...renderer(), elementFor: () => undefined };
  const owner = createLazyFrameXmlInspectOwner(seam, boot, broken, (unit) => fallbacks.push(unit));
  const unroute = routeFrameXmlInspectUnit(boot, owner);
  try {
    lua(boot, 'InspectUnit("target")', 0);
    await owner.settled;
    await settle();
    assert.equal(owner.failed, true);
    assert.deepEqual(fallbacks, ["target"]);
    assert.equal(frameXmlInspectGate(boot, renderer()) !== undefined, true, "the same tree gates with a rendered DOM");
    // 05.10 suite-fix: the unitless probe sets the paper doll's own shown flag aside; it must leave it as the XML made it.
    assert.deepEqual(lua(boot, "return InspectPaperDollFrame:IsShown() and 1 or 0"), [1], "the gate leaves the paper doll shown");
    unroute();
    assert.equal(lua(boot, "return InspectUnit == __fxStockInspectUnit")[0], false);
    assert.equal(lua(boot, "return __fxStockInspectUnit")[0], undefined, "the cleanup restores the stock InspectUnit");
  } finally {
    owner.dispose();
    boot.close();
  }
});
