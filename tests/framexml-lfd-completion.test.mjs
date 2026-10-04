import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.25 (L5c, 04.10): the dungeon finder's completion reward in the stock UI. Wow.exe 3.3.5a
// 12340 (read-only Ghidra, .runtime/re-2026-10-04/l5c/b6.txt): SMSG_LFG_PLAYER_REWARD (0x0055bdc0)
// keeps random and run dungeon, first-of-the-day, strangers, base money and experience, their
// per-stranger parts and the items, then raises LFG_COMPLETION_REWARD (event 0x205);
// GetLFGCompletionReward (0x00557e40) answers the run dungeon's name, TypeID and TextureFilename and
// the six numbers and the item count; GetLFGCompletionRewardItem (0x00557f70) the icon and quantity.
// AlertFrames.lua's DungeonCompletionAlertFrame is the stock owner; the native prompt keeps the
// reward whenever the stock alert cannot take it. MPQ-free.
const { FRAMEXML_LFD_BINDINGS, FrameXmlLfdModel } = await import("../dist/code/browser/framexml/FrameXmlLfd.js");
const {
  FRAMEXML_CANNED_LFD_CATALOG, FrameXmlCannedLfdWorld,
} = await import("../dist/code/browser/framexml/FrameXmlLfdCanned.js");
const { parseLfgPlayerReward } = await import("../dist/code/world/LfgProtocol.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { frameXmlLfdCompletionAlert } = await import("../dist/code/browser/framexml/FrameXmlLfdCompletion.js");

// TrinityCore's SendLfgPlayerReward (LFGHandler.cpp:488-509): random 258|6<<24, run 40|1<<24, done,
// literal 1, money, experience, two literal zeros, one item 13444 ×2.
const REWARD_PACKET = new PacketWriter().u32(258 | (6 << 24)).u32(40 | (1 << 24)).u8(1).u32(1).u32(4500).u32(12000)
  .u32(0).u32(0).u8(1).u32(13444).u32(5000).u32(2).toUint8Array();

function harness({ alert = async () => true, owned = true } = {}) {
  const world = new FrameXmlCannedLfdWorld();
  let dismissed = 0;
  world.lfgReward = undefined;
  world.dismissLfgReward = () => { dismissed += 1; world.lfgReward = undefined; };
  const model = new FrameXmlLfdModel({
    world: () => world, catalog: () => FRAMEXML_CANNED_LFD_CATALOG, playerLevel: () => 60, playerClassId: () => 1,
    playerName: () => "Игрок", playerGuid: () => 1n, playerFaction: () => "Alliance", partyMemberCount: () => 4,
    raidMemberCount: () => 0, isPartyLeader: () => false, inDungeonInstance: () => true, monotonic: () => 0,
    item: (entry) => (entry === 13444 ? { name: "Большой флакон маны", texture: "Interface\\Icons\\INV_Potion_76", quality: 1 } : undefined),
  });
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  model.popupsOwned = owned;
  model.completionAlert = alert;
  const reward = () => {
    world.lfgReward = parseLfgPlayerReward(REWARD_PACKET);
    world.emit({ kind: "reward" });
  };
  const call = (name, ...args) => FRAMEXML_LFD_BINDINGS[name]({ lfd: model }, args);
  const settle = async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); };
  return { world, model, fired, reward, call, settle, dismissed: () => dismissed };
}

test("the reward packet keeps strangers and the per-stranger money and experience", () => {
  const reward = parseLfgPlayerReward(REWARD_PACKET);
  assert.equal(reward.strangers, 1);
  assert.equal(reward.moneyVar, 0);
  assert.equal(reward.experienceVar, 0);
  assert.equal(reward.reward.money, 4500);
  assert.deepEqual(reward.reward.items, [{ itemId: 13444, displayId: 5000, count: 2 }]);
});

test("with the stock LFD: the alert owns the reward, then the native prompt lets it go", async () => {
  const { fired, reward, call, settle, dismissed, world } = harness();
  assert.deepEqual([...call("GetLFGCompletionReward")], [], "nothing before a reward");
  reward();
  await settle();
  assert.deepEqual(fired.map(([event]) => event), ["LFG_COMPLETION_REWARD"]);
  assert.equal(dismissed(), 1);
  assert.equal(world.lfgReward, undefined);
  assert.deepEqual([...call("GetLFGCompletionReward")],
    ["Стратхольм - Главные врата", 1, "STRATHOLME", 4500, 0, 12000, 0, 1, 1], "kept after the prompt let go");
  assert.deepEqual([...call("GetLFGCompletionRewardItem", 1)], ["Interface\\Icons\\INV_Potion_76", 2]);
  assert.deepEqual([...call("GetLFGCompletionRewardItem", 2)], []);
  assert.match(call("WebClientLFGCompletionRewardLink", 1)[0], /\|Hitem:13444:.*\[Большой флакон маны\]/);
});

test("without the stock LFD, or when AlertFrames.xml does not load, the native prompt keeps it", async () => {
  let asked = 0;
  const native = harness({ owned: false, alert: async () => { asked += 1; return true; } });
  native.reward();
  await native.settle();
  assert.deepEqual(native.fired, []);
  assert.equal(native.dismissed(), 0);
  assert.equal(asked, 0, "AlertFrames.xml is not even loaded for a reward the native prompt owns");
  assert.equal(native.call("GetLFGCompletionReward")[0], "Стратхольм - Главные врата", "answered anyway, as the client does");
  const failed = harness({ alert: async () => false });
  failed.reward();
  await failed.settle();
  assert.deepEqual(failed.fired, []);
  assert.equal(failed.dismissed(), 0);
  const thrown = harness({ alert: async () => { throw new Error("no file"); } });
  thrown.reward();
  await thrown.settle();
  assert.deepEqual(thrown.fired, []);
  assert.equal(thrown.dismissed(), 0);
});

test("the alert loader loads AlertFrames once and answers by DungeonCompletionAlertFrame1", async () => {
  let loads = 0;
  const frames = new Map();
  const boot = { bridge: { getFrame: (name) => frames.get(name) } };
  const added = [];
  const renderer = { addRoots: (roots) => added.push(...roots), sync() {} };
  const alert = frameXmlLfdCompletionAlert(boot, renderer, async () => {
    loads += 1;
    frames.set("DungeonCompletionAlertFrame1", { name: "DungeonCompletionAlertFrame1" });
    return { ok: true, roots: [{ name: "AlertFrame" }], loaded: ["AlertFrames.xml"] };
  });
  assert.equal(await alert(), true);
  assert.equal(await alert(), true);
  assert.equal(loads, 1);
  assert.deepEqual(added.map((root) => root.name), ["AlertFrame"]);
  const missing = frameXmlLfdCompletionAlert({ bridge: { getFrame: () => undefined } }, renderer,
    async () => ({ ok: true, roots: [], loaded: [] }));
  const warn = console.warn;
  console.warn = () => {};
  try { assert.equal(await missing(), false); } finally { console.warn = warn; }
});
