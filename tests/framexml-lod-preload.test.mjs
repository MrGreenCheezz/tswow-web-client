import assert from "node:assert/strict";
import test from "node:test";

// Plan items 3.18/3.24: the idle preloader of load-on-demand add-ons (FrameXmlLodPreload.ts).
const { startFrameXmlLodPreload } = await import("../dist/code/browser/framexml/FrameXmlLodPreload.js");

function manualIdle() {
  const waiting = [];
  return {
    idle: () => new Promise((resolve) => waiting.push(resolve)),
    async step() {
      const next = waiting.shift();
      assert.ok(next, "a load waits for an idle slice");
      next();
      for (let index = 0; index < 5; index++) await Promise.resolve();
    },
    get pending() { return waiting.length; },
  };
}

test("one load per idle slice, in order, each only after the previous one finished", async () => {
  const idle = manualIdle();
  const started = [];
  const preload = startFrameXmlLodPreload({
    names: ["MSBTOptions", "Blizzard_TrainerUI"],
    idle: idle.idle,
    load: async (name) => { started.push(name); return { ok: true }; },
  });
  await Promise.resolve();
  assert.deepEqual(started, [], "nothing before the first idle slice");
  await idle.step();
  assert.deepEqual(started, ["MSBTOptions"]);
  await idle.step();
  assert.deepEqual(started, ["MSBTOptions", "Blizzard_TrainerUI"]);
  assert.deepEqual((await preload.done).map((result) => result.name), ["MSBTOptions", "Blizzard_TrainerUI"]);
});

test("a failed or throwing load does not stop the rest; duplicates are loaded once", async () => {
  const seen = [];
  const preload = startFrameXmlLodPreload({
    names: ["A", "B", "a", "C"],
    idle: async () => {},
    load: async (name) => {
      if (name === "A") return { ok: false, message: "missing" };
      if (name === "B") throw new Error("boom");
      return { ok: true };
    },
    onResult: (result) => seen.push(result),
  });
  const results = await preload.done;
  assert.deepEqual(results, [
    { name: "A", ok: false, message: "missing" },
    { name: "B", ok: false, message: "Error: boom" },
    { name: "C", ok: true },
  ]);
  assert.deepEqual(seen, results);
});

test("cancel stops before the next load and drops a result that lands after it", async () => {
  const idle = manualIdle();
  const started = [];
  let release;
  const preload = startFrameXmlLodPreload({
    names: ["A", "B"],
    idle: idle.idle,
    load: (name) => { started.push(name); return new Promise((resolve) => { release = () => resolve({ ok: true }); }); },
  });
  await idle.step();
  assert.deepEqual(started, ["A"]);
  preload.cancel();
  release();
  const results = await preload.done;
  assert.deepEqual(results, [], "A finished after the cancel: not reported");
  assert.equal(preload.cancelled, true);
  assert.deepEqual(started, ["A"], "B never started");
});

test("the mount's list: the trainer first, then the client's LoD add-ons outside the policy", async () => {
  const { frameXmlLodPreloadNames } = await import("../dist/code/browser/framexml/FrameXmlLodPreload.js");
  assert.deepEqual(frameXmlLodPreloadNames([
    { name: "MikScrollingBattleText", loadOnDemand: false },
    { name: "MSBTOptions", loadOnDemand: true },
    { name: "blizzard_combatlog", loadOnDemand: true },
  // L5c 3.24: the profession owner's add-on follows the trainer's. L5c-review 3.24 (owner pending):
  // the auction and guild-bank add-ons load at their first visit again, as before L5c.
  // DEC-A 3.24: the owner decided 04.10 — preload both: the auction and guild-bank add-ons follow.
  ]), ["Blizzard_TrainerUI", "Blizzard_TradeSkillUI", "Blizzard_AuctionUI", "Blizzard_GuildBankUI", "MSBTOptions"]);
});
