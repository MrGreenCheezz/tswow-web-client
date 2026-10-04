import assert from "node:assert/strict";
import test from "node:test";

// 5.20: UnitAura's fifth (debuffType), ninth (isStealable) and tenth (shouldConsolidate) values as
// Wow.exe 0x006147c0 builds them, over the gateway's v=15 `dispelType`/`debuffType` and the v=14
// attribute words. isStealable is 0x0053d680 with the steal mask of 0x00542263.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { AURA_FLAGS } = await import("../dist/code/world/AuraProtocol.js");
const { debuffTypeBorder } = await import("../dist/code/browser/ui/DebuffType.js");

const SELF = 0x10n;
const TARGET = 0x20n;
const HOSTILE = -1;
const FRIENDLY = 1;

const ROWS = {
  // Порча: Magic debuff.
  172: { dispelType: 1, debuffType: "Magic" },
  702: { dispelType: 2, debuffType: "Curse" },
  55095: { dispelType: 3, debuffType: "Disease" },
  2818: { dispelType: 4, debuffType: "Poison" },
  // An enrage: SpellDispelType row 9 has ImmunityPossible and an empty InternalName.
  18499: { dispelType: 9, debuffType: "" },
  // Stealth (5): no ImmunityPossible, no string.
  1784: { dispelType: 5 },
  // Знак дикой природы: a stealable Magic buff.
  1126: { dispelType: 1, debuffType: "Magic" },
  // Magic but NOT_STEALABLE (ATTR4 0x40).
  9001: { dispelType: 1, debuffType: "Magic", attributes: [0, 0, 0, 0, 0x40, 0, 0, 0] },
  // Magic but channeled (ATTR1 0x4).
  9002: { dispelType: 1, debuffType: "Magic", attributes: [0, 0x4, 0, 0, 0, 0, 0, 0] },
  // Magic but passive.
  9003: { dispelType: 1, debuffType: "Magic", passive: true },
  // Magic with an effect-0 aura 27 (MOD_SILENCE) the client never lets be stolen.
  9004: { dispelType: 1, debuffType: "Magic", effectAura: [27, 0, 0] },
  // A consolidated raid buff (ATTR7 0x10000000).
  9005: { dispelType: 1, debuffType: "Magic", attributes: [0, 0, 0, 0, 0, 0, 0, 0x10000000] },
  // Похищение заклинания: effect 126 at an enemy (ImplicitTargetA 6), misc 1.
  30449: { effects: [126, 0, 0], implicitTargetA: [6, 0, 0], effectMiscValue: [1, 0, 0] },
};

function metadata(id) {
  const row = ROWS[id];
  if (!row) return undefined;
  return {
    id, name: `Заклинание ${id}`, rank: "", iconPath: "", passive: false,
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effects: [0, 0, 0], implicitTargetA: [0, 0, 0],
    attributes: [0, 0, 0, 0, 0, 0, 0, 0], dispelType: 0,
    ...row,
  };
}

function fixture({ known = [30449], reaction = HOSTILE, auras = {} } = {}) {
  const aura = (slot, spellId, flags) => [slot, { slot, spellId, flags, casterLevel: 80, applications: 1 }];
  const world = {
    state: {
      selfGuid: SELF,
      objects: new Map([[SELF, { guid: SELF, typeId: 4, fields: new Map() }], [TARGET, { guid: TARGET, typeId: 4, fields: new Map() }]]),
    },
    targetGuid: TARGET,
    knownSpells: known.map((id, slot) => ({ id, slot })),
    auras: new Map([
      [SELF, new Map(auras.self ?? [])],
      [TARGET, new Map(auras.target ?? [])],
    ]),
    aurasFor(guid) { return [...(this.auras.get(guid)?.values() ?? [])].sort((a, b) => a.slot - b.slot); },
    events: { on: () => () => {} },
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0, names: new Map(), creatureTemplates: new Map(),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: metadata, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
    reaction: () => reaction,
  });
  seam.attach({ fire: () => 1, now: () => 0 });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return { seam, world, call, aura };
}

const NEG = AURA_FLAGS.negative | 0x01;
const POS = AURA_FLAGS.positive | 0x01;

test("debuffType is the SpellDispelType string, nil without one", () => {
  const entries = [172, 702, 55095, 2818, 18499, 1784].map((id, index) => [index + 1, {
    slot: index + 1, spellId: id, flags: NEG, casterLevel: 80, applications: 1,
  }]);
  const { call, seam } = fixture({ auras: { self: entries } });
  const types = [1, 2, 3, 4, 5, 6].map((index) => call("UnitDebuff", "player", index)[4]);
  assert.deepEqual(types, ["Magic", "Curse", "Disease", "Poison", "", undefined]);
  seam.detach();
});

test("the stock border colour table: four types, Enrage as none, nothing for the rest", () => {
  assert.equal(debuffTypeBorder("Magic"), "rgb(51, 153, 255)");
  assert.equal(debuffTypeBorder("Curse"), "rgb(153, 0, 255)");
  assert.equal(debuffTypeBorder("Disease"), "rgb(153, 102, 0)");
  assert.equal(debuffTypeBorder("Poison"), "rgb(0, 153, 0)");
  assert.equal(debuffTypeBorder(""), "rgb(204, 0, 0)");
  assert.equal(debuffTypeBorder(undefined), undefined);
  assert.equal(debuffTypeBorder("Магия"), undefined, "never a localised word");
});

test("isStealable follows Wow.exe 0x0053d680", () => {
  const ids = [1126, 9001, 9002, 9003, 9004, 172];
  const entries = ids.map((id, index) => [index + 1, {
    slot: index + 1, spellId: id, flags: id === 172 ? NEG : POS, casterLevel: 80, applications: 1,
  }]);
  const mage = fixture({ auras: { target: entries, self: entries } });
  const stealable = (f, unit, filter, index) => f.call("UnitAura", unit, index, filter)[8];
  assert.equal(stealable(mage, "target", "HELPFUL", 1), true, "a Magic buff on an enemy, with Spellsteal known");
  assert.deepEqual([2, 3, 4, 5].map((index) => stealable(mage, "target", "HELPFUL", index)), [false, false, false, false],
    "NOT_STEALABLE, channeled, passive, aura 27");
  assert.equal(stealable(mage, "target", "HARMFUL", 1), false, "a debuff is never stolen");
  assert.equal(stealable(mage, "player", "HELPFUL", 1), false, "not on oneself");
  mage.seam.detach();

  const warrior = fixture({ known: [], auras: { target: entries } });
  assert.equal(stealable(warrior, "target", "HELPFUL", 1), false, "no steal mask without Spellsteal");
  warrior.seam.detach();

  const friend = fixture({ reaction: FRIENDLY, auras: { target: entries } });
  assert.equal(stealable(friend, "target", "HELPFUL", 1), false, "only on a unit the player can attack");
  friend.seam.detach();
});

test("shouldConsolidate is SPELL_ATTR7_CONSOLIDATED_RAID_BUFF", () => {
  const { call, seam } = fixture({ auras: { self: [[1, { slot: 1, spellId: 9005, flags: POS, casterLevel: 80, applications: 1 }],
    [2, { slot: 2, spellId: 1126, flags: POS, casterLevel: 80, applications: 1 }]] } });
  assert.equal(call("UnitBuff", "player", 1)[9], true);
  assert.equal(call("UnitBuff", "player", 2)[9], false);
  seam.detach();
});
