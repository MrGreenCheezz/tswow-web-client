import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam, CANNED_AURA_FIXTURES, CANNED_TARGET_AURA_FIXTURES, CANNED_TARGET } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
  FRAMEXML_SEAM_NAMES,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function harness() {
  let now = 100;
  const fired = [];
  const seam = new CannedWorldSeam();
  seam.attach({
    now: () => now,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  });
  return { seam, fired, setNow: (value) => { now = value; } };
}

test("aura seam exposes stock 3.3.5 names and the UNIT_AURA event", () => {
  assert.equal(FRAMEXML_SEAM_EVENTS.aura, "UNIT_AURA");
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.UnitAura, "function");
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.CancelUnitBuff, "function");
  assert.ok(FRAMEXML_SEAM_NAMES.includes("UnitAura"));
  assert.ok(FRAMEXML_SEAM_NAMES.includes("CancelUnitBuff"));
});

test("canned UnitAura returns the exact 3.3.5 11-tuple and player/target filters", () => {
  const { seam, setNow } = harness();
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const helpful = CANNED_AURA_FIXTURES.helpful;
  const harmful = CANNED_AURA_FIXTURES.harmful;
  assert.deepEqual(call("UnitAura", "player", 1, "HELPFUL"), [
    helpful.name, helpful.rank, helpful.texture, helpful.count, helpful.debuffType,
    helpful.duration, 100 + helpful.expirationOffset, helpful.unitCaster,
    helpful.isStealable, helpful.shouldConsolidate, helpful.spellId,
  ]);
  assert.equal(call("UnitAura", "player", 1, "HARMFUL")[0], harmful.name);
  assert.deepEqual(call("UnitAura", "player", 1), []);
  const targetHelpful = CANNED_TARGET_AURA_FIXTURES.helpful;
  assert.ok(seam.setTarget(CANNED_TARGET) > 0, "target aura lookup requires a selected target");
  assert.deepEqual(call("UnitAura", "target", 1, "HELPFUL"), [
    targetHelpful.name, targetHelpful.rank, targetHelpful.texture, targetHelpful.count,
    targetHelpful.debuffType, targetHelpful.duration, 100 + targetHelpful.expirationOffset,
    targetHelpful.unitCaster, targetHelpful.isStealable, targetHelpful.shouldConsolidate,
    targetHelpful.spellId,
  ]);
  setNow(103);
  assert.equal(call("UnitAura", "player", 1, "HELPFUL")[6], 100 + helpful.expirationOffset,
    "the deadline stays on the pump time axis when the clock advances");
  assert.equal(call("UnitAura", "player", 1, "HARMFUL")[6], 100 + harmful.expirationOffset);
  assert.equal(call("UnitAura", "player", 2, "HARMFUL").length, 0);
});

test("canned aura attach announces one initial UNIT_AURA and cancellation observes spell id", () => {
  const { seam, fired } = harness();
  assert.deepEqual(
    fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.aura),
    [[FRAMEXML_SEAM_EVENTS.aura, "player"]],
  );
  fired.length = 0;
  seam.tick(100);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.aura), []);

  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 2, "HELPFUL"]);
  assert.deepEqual(seam.cancelledAuraSpellIds, []);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 1, "HELPFUL"]);
  assert.deepEqual(seam.cancelledAuraSpellIds, [CANNED_AURA_FIXTURES.helpful.spellId]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["target", 1, "HELPFUL"]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 1, "HARMFUL"]);
  assert.deepEqual(seam.cancelledAuraSpellIds, [CANNED_AURA_FIXTURES.helpful.spellId]);
});
