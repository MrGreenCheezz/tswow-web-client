import assert from "node:assert/strict";
import test from "node:test";

// The pure wording of UNIT_COMBAT (FrameXmlCombatFeedback.ts): one row per action and descriptor
// CombatFeedback.lua can print, each built from the packet facts the world hands through.
const { combatFeedbackOf, frameXmlUnitCombatArgs, FRAMEXML_COMBAT_FEEDBACK_UNITS, SCHOOL_MASK_PHYSICAL } =
  await import("../dist/code/browser/framexml/FrameXmlCombatFeedback.js");
const {
  HITINFO_AFFECTS_VICTIM, HITINFO_CRITICAL, HITINFO_CRUSHING, HITINFO_GLANCING, HITINFO_MISS, HITINFO_BLOCK,
  HITINFO_FULL_ABSORB, HITINFO_FULL_RESIST,
  VICTIMSTATE_HIT, VICTIMSTATE_DODGE, VICTIMSTATE_PARRY, VICTIMSTATE_INTERRUPT, VICTIMSTATE_BLOCKS,
  VICTIMSTATE_EVADES, VICTIMSTATE_IMMUNE, VICTIMSTATE_DEFLECTS,
} = await import("../dist/code/world/CombatProtocol.js");
const {
  AURA_PERIODIC_DAMAGE, AURA_PERIODIC_HEAL, AURA_OBS_MOD_HEALTH, AURA_PERIODIC_ENERGIZE, AURA_OBS_MOD_POWER,
  AURA_PERIODIC_LEECH, AURA_PERIODIC_MANA_LEECH,
} = await import("../dist/code/world/SpellLogProtocol.js");

const ATTACKER = 0x10n;
const VICTIM = 0x20n;

function swing(overrides = {}) {
  return {
    hitInfo: HITINFO_AFFECTS_VICTIM, attacker: ATTACKER, victim: VICTIM, damage: 47, overkill: 0,
    victimState: VICTIMSTATE_HIT, blocked: 0,
    damages: [{ schoolMask: SCHOOL_MASK_PHYSICAL, damage: 47, absorbed: 0, resisted: 0 }],
    ...overrides,
  };
}

function melee(overrides) {
  return combatFeedbackOf({ source: "melee", swing: swing(overrides) });
}

const expected = (action, descriptor, amount, school) => ({
  targetGuid: VICTIM, casterGuid: ATTACKER, action, descriptor, amount, school,
});

test("melee: every HitInfo and VictimState the core sets has its stock action and descriptor", () => {
  assert.deepEqual(melee(), expected("WOUND", "", 47, 1), "a plain hit prints the number in white (school mask 1)");
  assert.deepEqual(melee({ hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_CRITICAL, damage: 94 }), expected("WOUND", "CRITICAL", 94, 1));
  assert.deepEqual(melee({ hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_CRUSHING, damage: 70 }), expected("WOUND", "CRUSHING", 70, 1));
  assert.deepEqual(melee({ hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_GLANCING, damage: 30 }), expected("WOUND", "GLANCING", 30, 1));
  assert.deepEqual(melee({ hitInfo: HITINFO_MISS, damage: 0, damages: [{ schoolMask: 1, damage: 0, absorbed: 0, resisted: 0 }] }),
    expected("MISS", "", 0, 1));
  assert.deepEqual(melee({ victimState: VICTIMSTATE_DODGE, damage: 0 }), expected("DODGE", "", 0, 1));
  assert.deepEqual(melee({ victimState: VICTIMSTATE_PARRY, damage: 0 }), expected("PARRY", "", 0, 1));
  assert.deepEqual(melee({ victimState: VICTIMSTATE_INTERRUPT, damage: 0 }), expected("INTERRUPT", "", 0, 1));
  assert.deepEqual(melee({ victimState: VICTIMSTATE_BLOCKS, damage: 0, blocked: 47, hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_BLOCK }),
    expected("BLOCK", "", 0, 1), "a block that swallows the swing is the BLOCK action");
  assert.deepEqual(melee({ hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_BLOCK, damage: 20, blocked: 27 }),
    expected("WOUND", "", 20, 1), "a partial block prints what got through");
  assert.deepEqual(melee({ victimState: VICTIMSTATE_EVADES, damage: 0 }), expected("EVADE", "", 0, 1));
  assert.deepEqual(melee({ victimState: VICTIMSTATE_IMMUNE, damage: 0 }), expected("IMMUNE", "", 0, 1));
  assert.deepEqual(melee({ victimState: VICTIMSTATE_DEFLECTS, damage: 0 }), expected("DEFLECT", "", 0, 1));
  assert.deepEqual(melee({
    hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_FULL_ABSORB, damage: 0,
    damages: [{ schoolMask: 1, damage: 0, absorbed: 47, resisted: 0 }],
  }), expected("WOUND", "ABSORB", 0, 1), "a fully absorbed swing is worded ABSORB");
  assert.deepEqual(melee({
    hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_FULL_RESIST, damage: 0,
    damages: [{ schoolMask: 0x04, damage: 0, absorbed: 0, resisted: 47 }],
  }), expected("WOUND", "RESIST", 0, 4), "a fully resisted weapon school is worded RESIST and keeps its school");
  assert.deepEqual(melee({
    damages: [{ schoolMask: 0x04, damage: 30, absorbed: 0, resisted: 0 }, { schoolMask: 1, damage: 17, absorbed: 0, resisted: 0 }],
  }), expected("WOUND", "", 47, 4), "the first sub-damage names the school of a two-school swing");
});

function spellDamage(overrides = {}) {
  return combatFeedbackOf({ source: "spellDamage", log: {
    targetGuid: VICTIM, casterGuid: ATTACKER, spellId: 133, damage: 250, overkill: 0, schoolMask: 0x04,
    absorbed: 0, resisted: 0, periodic: false, blocked: 0, hitInfo: 0, critical: false, ...overrides,
  } });
}

test("spell damage: the number with CRITICAL, or the part that stopped a zero hit", () => {
  assert.deepEqual(spellDamage(), expected("WOUND", "", 250, 4));
  assert.deepEqual(spellDamage({ critical: true, damage: 500 }), expected("WOUND", "CRITICAL", 500, 4));
  assert.deepEqual(spellDamage({ damage: 0, absorbed: 250 }), expected("WOUND", "ABSORB", 0, 4));
  assert.deepEqual(spellDamage({ damage: 0, blocked: 250 }), expected("WOUND", "BLOCK", 0, 4));
  assert.deepEqual(spellDamage({ damage: 0, resisted: 250 }), expected("WOUND", "RESIST", 0, 4));
  assert.deepEqual(spellDamage({ damage: 100, absorbed: 150, critical: true }), expected("WOUND", "CRITICAL", 100, 4),
    "a partial absorb still prints the damage that landed");
});

test("heals and energizes carry their amount and only CRITICAL as a descriptor", () => {
  const heal = (overrides = {}) => combatFeedbackOf({ source: "heal", log: {
    targetGuid: VICTIM, casterGuid: ATTACKER, spellId: 2050, amount: 300, overheal: 0, absorbed: 0, critical: false, ...overrides,
  } });
  assert.deepEqual(heal(), expected("HEAL", "", 300, 0));
  assert.deepEqual(heal({ critical: true, amount: 600, overheal: 100 }), expected("HEAL", "CRITICAL", 600, 0),
    "the packet's amount is what the indicator prints, overheal and all, as the combat log words it");
  assert.deepEqual(combatFeedbackOf({ source: "energize", log: {
    targetGuid: VICTIM, casterGuid: ATTACKER, spellId: 29166, powerType: 0, amount: 120,
  } }), expected("ENERGIZE", "", 120, 0));
});

test("periodic ticks follow their aura type; leeches and unknown types show nothing", () => {
  const tick = (auraType, overrides = {}) => combatFeedbackOf({ source: "periodic", log: {
    targetGuid: VICTIM, casterGuid: ATTACKER, spellId: 172, auraType, amount: 40, overAmount: 0, schoolMask: 0x20,
    absorbed: 0, resisted: 0, critical: false, powerType: undefined, ...overrides,
  } });
  assert.deepEqual(tick(AURA_PERIODIC_DAMAGE), expected("WOUND", "", 40, 0x20));
  assert.deepEqual(tick(AURA_PERIODIC_DAMAGE, { critical: true }), expected("WOUND", "CRITICAL", 40, 0x20));
  assert.deepEqual(tick(AURA_PERIODIC_DAMAGE, { amount: 0, absorbed: 40 }), expected("WOUND", "ABSORB", 0, 0x20));
  assert.deepEqual(tick(AURA_PERIODIC_DAMAGE, { amount: 0, resisted: 40 }), expected("WOUND", "RESIST", 0, 0x20));
  assert.deepEqual(tick(AURA_PERIODIC_HEAL), expected("HEAL", "", 40, 0));
  assert.deepEqual(tick(AURA_OBS_MOD_HEALTH, { critical: true }), expected("HEAL", "CRITICAL", 40, 0));
  assert.deepEqual(tick(AURA_PERIODIC_ENERGIZE, { powerType: 0 }), expected("ENERGIZE", "", 40, 0));
  assert.deepEqual(tick(AURA_OBS_MOD_POWER, { powerType: 0 }), expected("ENERGIZE", "", 40, 0));
  assert.equal(tick(AURA_PERIODIC_LEECH), undefined);
  assert.equal(tick(AURA_PERIODIC_MANA_LEECH, { powerType: 0 }), undefined);
  assert.equal(tick(999), undefined);
});

test("spell misses map SpellMissInfo 1..11 to the stock actions; none and unknown show nothing", () => {
  const miss = (missInfo) => combatFeedbackOf({ source: "miss", casterGuid: ATTACKER, targetGuid: VICTIM, spellId: 133, missInfo });
  const table = [[1, "MISS"], [2, "RESIST"], [3, "DODGE"], [4, "PARRY"], [5, "BLOCK"], [6, "EVADE"], [7, "IMMUNE"],
    [8, "IMMUNE"], [9, "DEFLECT"], [10, "ABSORB"], [11, "REFLECT"]];
  for (const [missInfo, action] of table) assert.deepEqual(miss(missInfo), expected(action, "", 0, 0), `miss ${missInfo}`);
  assert.equal(miss(0), undefined);
  assert.equal(miss(12), undefined);
});

test("damage shields, immunity and resist logs", () => {
  const shield = (damage) => combatFeedbackOf({ source: "damageShield", log: {
    targetGuid: VICTIM, casterGuid: ATTACKER, spellId: 7294, damage, overkill: 0, schoolMask: 0x02,
  } });
  assert.deepEqual(shield(12), expected("WOUND", "", 12, 2));
  assert.equal(shield(0), undefined, "an empty shield log shows nothing");
  const pair = { casterGuid: ATTACKER, targetGuid: VICTIM, spellId: 133 };
  assert.deepEqual(combatFeedbackOf({ source: "immune", log: pair }), expected("IMMUNE", "", 0, 0));
  assert.deepEqual(combatFeedbackOf({ source: "resist", log: pair }), expected("RESIST", "", 0, 0));
});

test("one event becomes one UNIT_COMBAT per watched token the target currently is", () => {
  assert.deepEqual([...FRAMEXML_COMBAT_FEEDBACK_UNITS],
    ["player", "pet", "target", "focus", "targettarget", "party1", "party2", "party3", "party4"]);
  const feedback = expected("WOUND", "CRITICAL", 94, 1);
  const guids = { player: VICTIM, target: 0x30n, party2: VICTIM, targettarget: VICTIM };
  assert.deepEqual(frameXmlUnitCombatArgs(feedback, (unit) => guids[unit]), [
    ["player", "WOUND", "CRITICAL", 94, 1],
    ["targettarget", "WOUND", "CRITICAL", 94, 1],
    ["party2", "WOUND", "CRITICAL", 94, 1],
  ]);
  assert.deepEqual(frameXmlUnitCombatArgs(feedback, () => undefined), []);
});
