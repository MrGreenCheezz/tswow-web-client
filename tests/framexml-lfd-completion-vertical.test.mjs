import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.25 (L5c, 04.10), MPQ-backed: the stock DungeonCompletionAlertFrame (AlertFrames.xml,
// loaded on demand by FrameXmlLfdCompletion.ts, as the achievement owner loads it) shows the dungeon
// finder's completion reward from LFG_COMPLETION_REWARD over the canned seam, its reward buttons'
// tooltips included (GameTooltip:SetLFGCompletionReward, GlueTooltipExtras.ts).
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
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { frameXmlLfdCompletionAlert } = await import("../dist/code/browser/framexml/FrameXmlLfdCompletion.js");
const { parseLfgPlayerReward } = await import("../dist/code/world/LfgProtocol.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const decoder = new TextDecoder("utf-8");

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "lfd-completion-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("LFG_COMPLETION_REWARD shows the stock alert with the run dungeon and the reward buttons", withClient, async () => {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    const errorsBefore = boot.vm.errors.length;
    const world = seam.lfdWorld;
    let dismissed = 0;
    world.dismissLfgReward = () => { dismissed += 1; world.lfgReward = undefined; };
    const roots = [];
    seam.lfd.popupsOwned = true;
    seam.lfd.completionAlert = frameXmlLfdCompletionAlert(boot, { addRoots: (list) => roots.push(...list), sync() {} });
    assert.equal(boot.bridge.getFrame("DungeonCompletionAlertFrame1")?.name, undefined, "AlertFrames.xml is not in the vertical");
    // TrinityCore's packet for Stratholme's main gate (canned catalog row 40), 4500 copper, 12000 XP, one item.
    world.lfgReward = parseLfgPlayerReward(new PacketWriter().u32(258 | (6 << 24)).u32(40 | (1 << 24)).u8(1).u32(1)
      .u32(4500).u32(12000).u32(0).u32(0).u8(1).u32(13444).u32(5000).u32(2).toUint8Array());
    world.emit({ kind: "reward" });
    for (let index = 0; index < 50 && dismissed === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(dismissed, 1, "the stock alert took the reward; the native prompt let go");
    const frame = boot.bridge.getFrame("DungeonCompletionAlertFrame1");
    assert.equal(frame?.type, "Button");
    assert.equal(boot.bridge.isVisible(frame), true, "the alert is up");
    assert.deepEqual(lua(boot, "return DungeonCompletionAlertFrame1.instanceName:GetText()"), ["Стратхольм - Главные врата"]);
    // Money/experience take the first button, the item the second (AlertFrames.lua:88-105).
    assert.deepEqual(lua(boot, `
      return DungeonCompletionAlertFrame1Reward1:IsShown() and 1 or 0, DungeonCompletionAlertFrame1Reward1.rewardID,
        DungeonCompletionAlertFrame1Reward2 and DungeonCompletionAlertFrame1Reward2:IsShown() and 1 or 0,
        DungeonCompletionAlertFrame1Reward2 and DungeonCompletionAlertFrame1Reward2.rewardID
    `, 4), [1, 0, 1, 1]);
    // The money button's tooltip is Lua; the item's goes through GameTooltip:SetLFGCompletionReward.
    lua(boot, "DungeonCompletionAlertFrameReward_OnEnter(DungeonCompletionAlertFrame1Reward1); DungeonCompletionAlertFrameReward_OnLeave(DungeonCompletionAlertFrame1Reward1)");
    lua(boot, "DungeonCompletionAlertFrameReward_OnEnter(DungeonCompletionAlertFrame1Reward2); DungeonCompletionAlertFrameReward_OnLeave(DungeonCompletionAlertFrame1Reward2)");
    assert.equal(boot.vm.errors.length, errorsBefore, `no Lua error: ${boot.vm.errors.slice(errorsBefore).join(" | ")}`);
  } finally {
    boot.close();
  }
});
