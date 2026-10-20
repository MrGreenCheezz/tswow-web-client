import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-aura-dispel.test.mjs
{
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
}

// ── framexml-aura-performance.test.mjs
{
const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");

function makeAuraStrip(bridge, prefix, count, onUpdate) {
  const root = bridge.CreateFrame("Frame", `${prefix}Frame`);
  assert.ok(root);
  const buttons = [];
  for (let index = 1; index <= count; index += 1) {
    const button = bridge.CreateFrame("Button", `${prefix}AuraButton${index}`, root);
    assert.ok(button);
    const duration = bridge.createChild(button, "FontString", `${prefix}Duration${index}`);
    const applications = bridge.createChild(button, "FontString", `${prefix}Applications${index}`);
    assert.ok(duration);
    assert.ok(applications);
    bridge.SetScript(button, "OnUpdate", (self, elapsed) => onUpdate({
      index,
      self,
      elapsed,
      duration,
      applications,
    }));
    buttons.push({ button, duration, applications });
  }
  return { root, buttons };
}

test("one bridge tick batches all 48 visible aura-button updates into one renderer sync", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  let updates = 0;
  const strip = makeAuraStrip(bridge, "Visible", 48, ({ index, elapsed, duration, applications }) => {
    updates += 1;
    bridge.SetText(duration, `${(index * 0.1 + elapsed).toFixed(3)}s`);
    bridge.SetText(applications, String((index % 5) + 1));
    bridge.update(duration, (frame) => {
      frame.alpha = 0.5 + ((index + updates) % 2) * 0.5;
    });
  });

  let rendererSyncs = 0;
  bridge.subscribe(() => { rendererSyncs += 1; });

  assert.equal(bridge.tick(0.016), 48);
  assert.equal(updates, 48, "every visible AuraButton OnUpdate must run");
  assert.equal(rendererSyncs, 1, "all aura mutations must flush through one outer batch");
  assert.equal(strip.buttons[0].duration.text, "0.116s");
  assert.equal(strip.buttons[47].applications.text, "4");
  assert.equal(strip.buttons[0].duration.alpha, 0.5);
});

test("hidden aura subtrees do not dispatch OnUpdate or produce renderer work", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  let visibleUpdates = 0;
  let hiddenUpdates = 0;
  makeAuraStrip(bridge, "VisibleIdle", 48, () => { visibleUpdates += 1; });
  const hidden = makeAuraStrip(bridge, "HiddenIdle", 48, ({ index, duration }) => {
    hiddenUpdates += 1;
    // This mutation is intentional: a broken visibility guard would now also cause a renderer
    // notification, rather than merely incrementing an otherwise invisible counter.
    bridge.SetText(duration, `hidden-${index}`);
    bridge.update(duration, (frame) => { frame.alpha = 0; });
  });
  assert.equal(bridge.Hide(hidden.root), true);

  let rendererSyncs = 0;
  bridge.subscribe(() => { rendererSyncs += 1; });

  assert.equal(bridge.tick(0.016), 48);
  assert.equal(visibleUpdates, 48);
  assert.equal(hiddenUpdates, 0, "hidden AuraButton descendants must not run OnUpdate");
  assert.equal(rendererSyncs, 0, "handlers without mutations must not trigger a render sync");

  // Once the visible strip is hidden too, the update index still contains all 96 handlers, but
  // effective visibility prevents any of them from doing work.
  const visibleRoot = bridge.getFrame("VisibleIdleFrame");
  assert.ok(visibleRoot);
  assert.equal(bridge.Hide(visibleRoot), true);
  visibleUpdates = 0;
  hiddenUpdates = 0;
  rendererSyncs = 0;
  assert.equal(bridge.tick(0.016), 0);
  assert.equal(visibleUpdates, 0);
  assert.equal(hiddenUpdates, 0);
  assert.equal(rendererSyncs, 0);
});
}

// ── framexml-aura-seam.test.mjs
{
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
}
