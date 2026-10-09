// Plan item 3.22a: INSTANCE_BOOT_START/STOP with GetInstanceBootTimeRemaining, and QUEST_ACCEPT_CONFIRM
// with ConfirmAcceptQuest, as Wow.exe 3.3.5a 12340 raises them (0x6e3c10 → 0x513ad0, 0x5162e0;
// 0x6cbc50 → 0x58bc50, 0x58c910; read 2026-10-02).
import assert from "node:assert/strict";
import test from "node:test";

const {
  FrameXmlServerPromptsModel, FRAMEXML_SERVER_PROMPTS_BINDINGS, INSTANCE_BOOT_START, INSTANCE_BOOT_STOP, QUEST_ACCEPT_CONFIRM,
} = await import("../dist/code/browser/framexml/FrameXmlServerPrompts.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

function fixture({ owned = true } = {}) {
  const events = new EventBus();
  const answers = [];
  const world = {
    events, sharedQuest: undefined,
    names: new Map([[0x77n, "Друг"]]),
    answerSharedQuest(accept) { answers.push([this.sharedQuest?.questId, accept]); this.sharedQuest = undefined; },
  };
  let now = 10_000;
  const model = new FrameXmlServerPromptsModel({ world: () => world, monotonic: () => now, popupsOwned: () => owned });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const host = { serverPrompts: model };
  const api = (name) => [...FRAMEXML_SERVER_PROMPTS_BINDINGS[name](host, [])];
  return { events, world, model, fired, answers, api, tick: (ms) => { now += ms; }, now: () => now };
}

/** What WorldClient emits for SMSG_RAID_GROUP_ONLY (WorldClient.ts). */
function raidGroupOnly(f, milliseconds) {
  f.events.emit("INSTANCE_BOOT", { milliseconds });
}

test("a homebind delay starts the boot timer, a 0 stops it; the remaining time is in whole seconds", () => {
  const f = fixture();
  assert.deepEqual(f.api("GetInstanceBootTimeRemaining"), [0]);
  raidGroupOnly(f, 60_000);
  assert.deepEqual(f.fired, [[INSTANCE_BOOT_START]]);
  assert.deepEqual(f.api("GetInstanceBootTimeRemaining"), [60]);
  f.tick(1_500);
  assert.deepEqual(f.api("GetInstanceBootTimeRemaining"), [58], "58.5 s left reads 58");
  raidGroupOnly(f, 0);
  assert.deepEqual(f.fired, [[INSTANCE_BOOT_START], [INSTANCE_BOOT_STOP]]);
  assert.deepEqual(f.api("GetInstanceBootTimeRemaining"), [0]);
  raidGroupOnly(f, 1_000);
  f.tick(5_000);
  assert.deepEqual(f.api("GetInstanceBootTimeRemaining"), [0], "past the deadline: 0, never negative");
});

test("a shared quest asks with the sharer's cached name and the title; the answer goes to that share", () => {
  const f = fixture();
  f.world.sharedQuest = { questId: 5, title: "Волчья охота", initiatorGuid: 0x77n };
  f.events.emit("QUEST_SHARED", { quest: f.world.sharedQuest });
  assert.deepEqual(f.fired, [[QUEST_ACCEPT_CONFIRM, "Друг", "Волчья охота"]]);
  f.api("ConfirmAcceptQuest");
  assert.deepEqual(f.answers, [[5, true]]);
  f.api("ConfirmAcceptQuest");
  assert.deepEqual(f.answers, [[5, true]], "the share is gone: nothing more is sent");
});

test("an unknown sharer raises nothing, but the quest id is still the one ConfirmAcceptQuest answers", () => {
  const f = fixture();
  f.world.sharedQuest = { questId: 9, title: "Тайна", initiatorGuid: 0x99n };
  f.events.emit("QUEST_SHARED", { quest: f.world.sharedQuest });
  assert.deepEqual(f.fired, [], "0x58bc50 signals only with a cached name");
  f.api("ConfirmAcceptQuest");
  assert.deepEqual(f.answers, [[9, true]]);
});

test("a stale share is not answered, and the native prompt keeps the question until stock owns the popups", () => {
  const f = fixture({ owned: false });
  f.world.sharedQuest = { questId: 5, title: "Волчья охота", initiatorGuid: 0x77n };
  f.events.emit("QUEST_SHARED", { quest: f.world.sharedQuest });
  assert.deepEqual(f.fired, [], "stock does not own the popups: no stock question");
  f.world.sharedQuest = { questId: 6, title: "Другое", initiatorGuid: 0x77n };
  f.api("ConfirmAcceptQuest");
  assert.deepEqual(f.answers, [], "the stored id is 5; the world now holds 6");
  f.events.emit("QUEST_SHARED", { quest: undefined });
  assert.deepEqual(f.fired, []);
});

test("detach takes both subscriptions away; the seam table carries the two names", () => {
  const f = fixture();
  f.model.detach();
  raidGroupOnly(f, 60_000);
  f.world.sharedQuest = { questId: 5, title: "Волчья охота", initiatorGuid: 0x77n };
  f.events.emit("QUEST_SHARED", { quest: f.world.sharedQuest });
  assert.deepEqual(f.fired, []);
  // Attached again: one subscription each, not the old ones as well.
  f.model.attach({ fire(event, ...args) { f.fired.push([event, ...args]); return 1; } });
  raidGroupOnly(f, 0);
  assert.deepEqual(f.fired, [[INSTANCE_BOOT_STOP]]);
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.GetInstanceBootTimeRemaining, "function");
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.ConfirmAcceptQuest, "function");
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetInstanceBootTimeRemaining({}, [])], [0], "a seam without the model");
});
