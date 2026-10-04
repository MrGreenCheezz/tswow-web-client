import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameXmlCastEventsLive, frameXmlCastOutcome, frameXmlInterruptMasks, frameXmlInterruptibility,
  FRAMEXML_NO_INTERRUPT_MASKS,
} from "../dist/code/browser/framexml/FrameXmlCastEvents.js";

// 3.02 over the seam's half (FrameXmlCastEvents.ts), against Wow.exe 3.3.5a 12340:
// 0x0080ac90 SENT, 0x007fecc0 outcome → event, 0x0053ca70 masks, 0x007262e0/0x0071ab20 notInterruptible,
// 0x0072f5d0 (NOT_)INTERRUPTIBLE on an aura update. Synthetic spells; ids are realistic.

const MOB = 0xf130000000000abcn;
const PLAYER2 = 0x21n;
const SPELLS = new Map([
  [133, { id: 133, name: "Огненный шар", rank: "Уровень 1", schoolMask: 4, preventionType: 1, attributes: [0, 0, 0, 0, 0, 0, 0, 0], effects: [2, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], requiredTargetMask: 1 }],
  [78, { id: 78, name: "Удар героя", rank: "", schoolMask: 1, preventionType: 2, attributes: [0, 0, 0, 0, 0, 0, 0, 0], effects: [0, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0] }],
  // Kick: SPELL_EFFECT_INTERRUPT_CAST, physical.
  [1766, { id: 1766, name: "Пинок", rank: "", schoolMask: 1, preventionType: 0, effects: [68, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  // Silence: APPLY_AURA MOD_SILENCE, shadow.
  [15487, { id: 15487, name: "Безмолвие", rank: "", schoolMask: 32, preventionType: 1, effects: [6, 0, 0], effectAura: [27, 0, 0], effectMiscValue: [0, 0, 0], attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  // An aura of interrupt-mechanic immunity (77, misc 26) and one of school immunity (39, all schools).
  [9001, { id: 9001, name: "Невозмутимость", rank: "", schoolMask: 1, effects: [6, 0, 0], effectAura: [77, 0, 0], effectMiscValue: [26, 0, 0] }],
  [642, { id: 642, name: "Божественный щит", rank: "", schoolMask: 2, effects: [6, 0, 0], effectAura: [39, 0, 0], effectMiscValue: [127, 0, 0] }],
]);

test("0x007fecc0: which event a result raises", () => {
  assert.deepEqual([187, 24, 27, 105, 40, 41, 12, 0].map(frameXmlCastOutcome),
    ["succeeded", "failedQuiet", "failedQuiet", "failedQuiet", "interrupted", "interrupted", "failed", "failed"]);
});

test("0x0053ca70: interrupt and silence masks from the book; ATTR7 0x800/0x1000 count apart", () => {
  const masks = frameXmlInterruptMasks([SPELLS.get(1766), SPELLS.get(15487), SPELLS.get(133), undefined,
    { schoolMask: 8, effects: [0, 0, 0], effectAura: [0, 0, 0], attributes: [0, 0, 0, 0, 0, 0, 0, 0x800] },
    { schoolMask: 16, effects: [0, 0, 0], effectAura: [0, 0, 0], attributes: [0, 0, 0, 0, 0, 0, 0, 0x1000] }]);
  assert.deepEqual(masks, { interrupt: 1, interruptNonPlayer: 8, silence: 32, silenceNonPlayer: 16 });
});

test("0x007262e0/0x0071ab20: notInterruptible is the player's question", () => {
  const masks = { interrupt: 1, interruptNonPlayer: 0, silence: 0, silenceNonPlayer: 0 };
  const base = { casterIsPlayer: false, schoolImmunityMask: 0, mechanicImmunityMask: 0, auras: [], masks };
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(133) }).shown, false, "a kick stops a fireball");
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(78) }).shown, true, "PreventionType 2: nothing to interrupt");
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(133), mechanicImmunityMask: 1 << 26 }).shown, true,
    "the cast's interrupt immunity (CAST_FLAG_IMMUNITY) leaves the kick nothing");
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(133), schoolImmunityMask: 1 }).shown, true,
    "physical immunity covers a physical kick");
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(133),
    masks: { ...masks, silence: 32 }, mechanicImmunityMask: 1 << 26 }).shown, false, "the silence still works");
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(133), auras: [SPELLS.get(9001)] }).shown, true,
    "aura 77 misc 26");
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(133), auras: [SPELLS.get(642)] }).shown, true,
    "aura 39 over every school");
  const none = frameXmlInterruptibility({ ...base, spell: SPELLS.get(78), masks: FRAMEXML_NO_INTERRUPT_MASKS });
  assert.deepEqual(none, { raw: true, flag: true, shown: false }, "no interrupts at all: never shown");
  const quirk = frameXmlInterruptibility({ ...base, spell: SPELLS.get(133), masks: FRAMEXML_NO_INTERRUPT_MASKS });
  assert.deepEqual(quirk, { raw: true, flag: false, shown: false });
  const always = { ...SPELLS.get(78), attributes: [0, 0, 0, 0, 0, 0, 0, 0x2000] };
  assert.equal(frameXmlInterruptibility({ ...base, spell: always }).shown, false, "ATTR7 0x2000");
  assert.equal(frameXmlInterruptibility({ ...base, spell: SPELLS.get(133), masks: { ...masks, interrupt: 0, interruptNonPlayer: 1 },
    casterIsPlayer: true }).shown, false, "a non-player-only kick asks nothing of a player caster");
  assert.equal(frameXmlInterruptibility({ ...base, spell: undefined }).shown, false, "no metadata (an old gateway): false");
});

function live({ book = [1766], auras = new Map(), casts = new Map(), selection, names = new Map() } = {}) {
  const fired = [];
  const pump = { fire: (...args) => { fired.push(args); return 1; } };
  const units = new Map([[0x10n, "player"], [MOB, "target"]]);
  const events = new FrameXmlCastEventsLive({
    spell: (id) => SPELLS.get(id),
    castUnit: (guid) => units.get(guid),
    book: () => book.map((id) => SPELLS.get(id)),
    auras: (guid) => auras.get(guid),
    cast: (guid) => casts.get(guid),
    guidName: (guid) => names.get(guid),
    selection: () => selection,
  });
  return { events, pump, fired, auras, casts };
}

test("SENT: always \"player\", the rank a string, the target's name or \"\"", () => {
  const { events, pump, fired } = live({ selection: MOB, names: new Map([[MOB, "Кобольд"]]) });
  events.onSent(pump, { spellId: 133, castCount: 4, targetGuid: MOB });
  events.onSent(pump, { spellId: 78, castCount: 5 });
  events.onSent(pump, { spellId: 133, castCount: 6 });
  events.onSent(pump, { spellId: 133, castCount: 7, targetGuid: PLAYER2 });
  events.useGlobalStrings((name) => (name === "UNKNOWNOBJECT" ? "Неизвестно" : undefined));
  events.onSent(pump, { spellId: 4242, castCount: 8, targetGuid: PLAYER2 });
  assert.deepEqual(fired, [
    ["UNIT_SPELLCAST_SENT", "player", "Огненный шар", "Уровень 1", "Кобольд"],
    ["UNIT_SPELLCAST_SENT", "player", "Удар героя", "", ""],
    ["UNIT_SPELLCAST_SENT", "player", "Огненный шар", "Уровень 1", "Кобольд"],
    ["UNIT_SPELLCAST_SENT", "player", "Огненный шар", "Уровень 1", "Unknown"],
    ["UNIT_SPELLCAST_SENT", "player", "Заклинание 4242", "", "Неизвестно"],
  ]);
});

test("the outcome reaches the caster's token with the packet's cast count; other units stay silent", () => {
  const { events, pump, fired } = live();
  events.onResult(pump, { casterGuid: 0x10n, spellId: 133, castCount: 9, result: 187 });
  events.onResult(pump, { casterGuid: 0x10n, spellId: 133, castCount: 9, result: 27 });
  events.onResult(pump, { casterGuid: MOB, spellId: 78, castCount: 2, result: 40 });
  events.onResult(pump, { casterGuid: MOB, spellId: 78, castCount: 2, result: 12 });
  events.onResult(pump, { casterGuid: 0xf130000000000999n, spellId: 133, castCount: 1, result: 187 });
  assert.deepEqual(fired, [
    ["UNIT_SPELLCAST_SUCCEEDED", "player", "Огненный шар", "Уровень 1", 9],
    ["UNIT_SPELLCAST_FAILED_QUIET", "player", "Огненный шар", "Уровень 1", 9],
    ["UNIT_SPELLCAST_INTERRUPTED", "target", "Удар героя", "", 2],
    ["UNIT_SPELLCAST_FAILED", "target", "Удар героя", "", 2],
  ]);
});

test("0x0072f5d0: an immunity aura on a casting target raises NOT_INTERRUPTIBLE, losing it INTERRUPTIBLE", () => {
  const { events, pump, fired, auras, casts } = live();
  casts.set(MOB, { spellId: 133, channel: false });
  events.onCastStart(MOB);
  assert.equal(events.notInterruptible(MOB), false);
  auras.set(MOB, new Map([[1, { spellId: 9001 }]]));
  events.onAuraChanged(pump, MOB);
  assert.equal(events.notInterruptible(MOB), true);
  events.onAuraChanged(pump, MOB);
  auras.set(MOB, new Map());
  events.onAuraChanged(pump, MOB);
  assert.deepEqual(fired, [["UNIT_SPELLCAST_NOT_INTERRUPTIBLE", "target"], ["UNIT_SPELLCAST_INTERRUPTIBLE", "target"]],
    "only the edges");
  casts.delete(MOB);
  events.onCastStop(MOB);
  assert.equal(events.notInterruptible(MOB), false);
  fired.length = 0;
  events.onAuraChanged(pump, MOB);
  assert.deepEqual(fired, [], "a unit that does not cast is not asked");
});

test("the original's quirk: a player without interrupts hears INTERRUPTIBLE on each aura update of a casting unit", () => {
  const { events, pump, fired, casts } = live({ book: [133] });
  casts.set(MOB, { spellId: 133, channel: false });
  events.onCastStart(MOB);
  events.onAuraChanged(pump, MOB);
  events.onAuraChanged(pump, MOB);
  assert.deepEqual(fired, [["UNIT_SPELLCAST_INTERRUPTIBLE", "target"], ["UNIT_SPELLCAST_INTERRUPTIBLE", "target"]]);
  casts.set(MOB, { spellId: 78, channel: false });
  fired.length = 0;
  events.onAuraChanged(pump, MOB);
  assert.deepEqual(fired, [], "only a PreventionType 1 cast is recomputed");
});
