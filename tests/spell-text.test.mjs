import assert from "node:assert/strict";
import test from "node:test";
import {
  effectRange, effectTicks, formatDuration, formatSpellDescription,
} from "../dist/code/browser/ui/SpellText.js";
import {
  GLOBAL_STRING_DATA_AVAILABLE, GLOBAL_STRINGS,
} from "../dist/code/generated/globalStrings.js";
import { formatNpcText } from "../dist/code/browser/ui/NpcText.js";
import { attackPower } from "../dist/code/world/Fields.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// Duration formatting is part of the algorithmic spell-marker tests, so neutral builds receive
// four small test-owned templates. The separate assertion against the client's exact words stays
// skipped until the user has generated their local GlobalStrings implementation.
if (!GLOBAL_STRING_DATA_AVAILABLE) {
  Object.assign(GLOBAL_STRINGS, {
    INT_SPELL_DURATION_SEC: "%d сек",
    INT_SPELL_DURATION_MIN: "%d мин",
    INT_SPELL_DURATION_HOURS: "%d ч",
    INT_SPELL_DURATION_DAYS: "%d д",
  });
}
const withGlobalStrings = {
  skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data",
};

/** A spell carrying only the numbers a description reads. */
function spell(fields = {}) {
  return {
    effectBasePoints: [0, 0, 0],
    effectDieSides: [1, 1, 1],
    effectPeriod: [0, 0, 0],
    effectChainTargets: [0, 0, 0],
    effectRadius: [0, 0, 0],
    duration: 0,
    maxDuration: 0,
    procChance: 100,
    ...fields,
  };
}

test("Ж3.1 an effect's number is the roll, not the number in the table", () => {
  // Fireball rank 1 stores 13 and 9 and reads 14 to 22 on the real tooltip: an effect gives
  // `EffectBasePoints + 1` through `EffectBasePoints + EffectDieSides`. Printing the stored number
  // would be off by one on every spell in the game and wrong by nine on this one.
  const fireball = spell({ effectBasePoints: [13, 0, 0], effectDieSides: [9, 1, 0] });
  assert.deepEqual(effectRange(fireball, 0), { min: 14, max: 22 });

  // A single side is a single value, not a range.
  const frostbolt = spell({ effectBasePoints: [999, 0, 0], effectDieSides: [1, 0, 0] });
  assert.deepEqual(effectRange(frostbolt, 0), { min: 1000, max: 1000 });

  // A negative base point is a cost or a reduction, and reads as a magnitude.
  assert.deepEqual(effectRange(spell({ effectBasePoints: [-51, 0, 0] }), 0), { min: 50, max: 50 });
});

test("Ж3.2 the markers a description is made of are filled in", () => {
  const frostbolt = spell({ effectBasePoints: [999, 0, 0], effectDieSides: [1, 0, 0] });
  assert.equal(
    formatSpellDescription("Наносит противнику $s1 ед. урона от магии льда.", frostbolt),
    "Наносит противнику 1000 ед. урона от магии льда.");

  const fireball = spell({ effectBasePoints: [13, 0, 0], effectDieSides: [9, 1, 0] });
  assert.equal(formatSpellDescription("$s1 урона", fireball), "14–22 урона");
  assert.equal(formatSpellDescription("от $m1 до $M1", fireball), "от 14 до 22");

  // The second effect, which is what an index past one selects.
  const immolate = spell({ effectBasePoints: [3, 7, 0], effectDieSides: [1, 1, 0] });
  assert.equal(formatSpellDescription("$s2 ед. урона", immolate), "8 ед. урона");
});

test("Ж3.2 a periodic effect adds up over its own duration", () => {
  // Corruption rank 1: ten a tick, every three seconds, for twelve — which is 40, and is what the
  // real tooltip says. This is the only marker that needs two other columns to answer.
  const corruption = spell({
    effectBasePoints: [9, 0, 0], effectDieSides: [1, 0, 0],
    effectPeriod: [3000, 0, 0], duration: 12000, maxDuration: 12000,
  });
  assert.equal(effectTicks(corruption, 0), 4);
  assert.equal(
    formatSpellDescription("нанеся ей $o1 ед. урона за $d.", corruption),
    "нанеся ей 40 ед. урона за 12 сек.");
  assert.equal(formatSpellDescription("каждые $t1 сек.", corruption), "каждые 3 сек.");

  // No period at all is one application, not a division by zero.
  assert.equal(effectTicks(spell({ duration: 5000 }), 0), 1);
});

test("Ж3.2 a duration is written in the client's own words", withGlobalStrings, () => {
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(3000), "3 сек");
  // 12.10: not whole in its unit, Wow.exe writes SPELL_DURATION_<unit>'s `%.2f` (0x0061aee0) — the
  // «2.50 сек» and «1.50 мин» of the real tooltips, not a rounded «3 сек» or «90 сек».
  assert.equal(formatDuration(2500), "2.50 сек");
  assert.equal(formatDuration(60_000), "1 мин");
  assert.equal(formatDuration(90_000), "1.50 мин");
  assert.equal(formatDuration(3_600_000), "1 ч");
  assert.equal(formatDuration(86_400_000), "1 д");
});

/** 12.10: the active player as SpellText.ts reads it: update-field words by name (and index). */
function player(words = {}, extra = {}) {
  const slots = new Map();
  for (const [key, value] of Object.entries(words)) {
    const [name, offset = "0"] = key.split("+");
    slots.set(UPDATE_FIELDS[name].offset + Number(offset), value);
  }
  return { slot: (index) => slots.get(index), knowsSpell: () => false, hasAura: () => false, ...extra };
}
const floatWord = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};

test("Ж3.2 braces are arithmetic, over the names Wow.exe's table has", () => {
  const numbers = spell({ effectBasePoints: [9, 0, 0], effectDieSides: [1, 0, 0] });
  const live = { player: player() };
  assert.equal(formatSpellDescription("${$m1*3}", numbers, live), "30");
  assert.equal(formatSpellDescription("${$m1/2}", numbers, live), "5");
  // 12.10: `s1` is not a name of 0x00ace8f8's table (only `m`/`M` are), so Wow.exe's block fails and
  // 0x0057aaf0 writes `$` in its place; an unknown row inside a block fails it the same way.
  assert.equal(formatSpellDescription("${$s1*3}", numbers, live), "$");
  assert.equal(formatSpellDescription("${$42208m1*8}", numbers, live), "$");
});

test("Ж3.2 WotLK named formulas and cross-spell durations are resolved", () => {
  // Exact ruRU Spell.dbc text for Seal of Righteousness base row 21084. `$21084d` is a real
  // self-reference here, while MWS/AP/SPH are the player's own update fields.
  const seal = spell({ id: 21084, duration: 1_800_000, maxDuration: 1_800_000 });
  const text = "Наполняет паладина священным духом на $21084d. С каждой атакой ближнего боя "
    + "паладин наносит дополнительно ${$MWS*(0.022*$AP+0.044*$SPH)} ед. урона от светлой магии.\n\n"
    + "Высвободив энергию печати, вы наносите противнику ${1+0.2*$AP+0.32*$SPH} ед. урона.";
  // 12.10: MWS is UNIT_FIELD_BASEATTACKTIME in seconds, AP the attack power sum, SPH the HOLY spell
  // damage (PLAYER_FIELD_MOD_DAMAGE_DONE_POS+1 plus _NEG+1) — 0x005782d0, not the healing bonus.
  const paladin = player({
    UNIT_FIELD_BASEATTACKTIME: 2000, UNIT_FIELD_ATTACK_POWER: 1000,
    "PLAYER_FIELD_MOD_DAMAGE_DONE_POS+1": 500,
  });
  assert.equal(formatSpellDescription(text, seal, { player: paladin }),
    "Наполняет паладина священным духом на 30 мин. С каждой атакой ближнего боя "
      + "паладин наносит дополнительно 88 ед. урона от светлой магии.\n\n"
      + "Высвободив энергию печати, вы наносите противнику 361 ед. урона.");
  // Rank row 20154 is the cross-row variant seen in the book; the gateway preloads 21084 so this
  // marker is resolved instead of leaking into the tooltip.
  const rankSeal = spell({ id: 20154, duration: 1_800_000 });
  assert.equal(formatSpellDescription("Печать на $21084d", rankSeal, {
    spells: new Map([[seal.id, seal]]),
  }), "Печать на 30 мин");
  // 12.10: the legacy `$1{…}` spelling is a spell id followed by a `{`, which 0x00579e50 has no case
  // for: Wow.exe writes `$`, and so does this (no more per-module rewriting).
  assert.equal(formatSpellDescription("Урон: $1{1}", seal, { player: paladin }), "Урон: ${1}");
});

test("Ж3.2 SpellDescriptionVariables named formulas strip their authored braces", () => {
  const spell136 = spell({ id: 136, effectBasePoints: [9, 0, 0], effectDieSides: [1, 0, 0],
    descriptionVariables: "$total=${$m1*5}" });
  assert.equal(formatSpellDescription("Урон: $<total>", spell136, { player: player() }), "Урон: 50");
});

test("12.10 without an active player every name in a block reads 0, as 0x005782d0 has it", () => {
  const seal = spell({ id: 21084, effectBasePoints: [9, 0, 0] });
  const result = formatSpellDescription("Урон: ${$MWS*(0.022*$AP+0.044*$SPH)} и ${$m1+1}", seal);
  assert.equal(result, "Урон: 0 и 1");
  // An undefined `$<name>` is 0 inside a block (0x005774d0) and the client's `$` failure in prose.
  assert.equal(formatSpellDescription("${$<talentBonus>+2} / $<talentBonus>", seal), "2 / $<talentBonus>");
});

test("Ж3.2 attack-power operands include signed modifiers and the float multiplier", () => {
  const bits = new ArrayBuffer(4);
  new DataView(bits).setFloat32(0, 0.5, true);
  const object = { fields: new Map([
    [123, 100],
    [124, ((30 & 0xffff) << 16) | ((-20) & 0xffff)],
    [125, new DataView(bits).getUint32(0, true)],
  ]) };
  assert.equal(attackPower(object), 165, "(100 - 20 + 30) * (1 + 0.5)");
});

test("Ж3.2 what Wow.exe's writer cannot answer, it writes as the client does", () => {
  const plain = spell();
  // 12.10: a row the client lacks: 0x00579e50 fails after reading the id, and 0x0057aaf0 writes `$`
  // and goes on from the letter — «$s1» is what the original tooltip shows for such a row.
  assert.equal(formatSpellDescription("$12345s1 урона", plain), "$s1 урона");
  // A row still on its way (the gateway has not answered) is left as written, to be redrawn.
  assert.equal(formatSpellDescription("$12345s1 урона", plain, { answered: () => false }), "$12345s1 урона");
  // An undefined `$<name>`: 0x00577c40 fails without moving, so the text after the `$` stands.
  assert.equal(formatSpellDescription("$<damage> урона", plain), "$<damage> урона");
  // Without an active player every `$?` term is false: the else branch.
  assert.equal(formatSpellDescription("$?s48165[да][нет]", plain), "нет");
  // And with no spell at all, nothing is guessed.
  assert.equal(formatSpellDescription("$s1 урона", undefined), "$s1 урона");
});

test("Ж3.2 a block is worked out whole, its `$<name>` included", () => {
  // Frostbolt's `${$m2*$<mult>}`, its SpellDescriptionVariables row #167 cut down to one rank of each
  // talent: no talent known, both factors 1.
  const frostbolt = spell({
    effectBasePoints: [39, 17, 0], effectDieSides: [1, 3, 0], duration: 5000, maxDuration: 5000,
    descriptionVariables: "$arctic1=$?s31674[${1.01}][${1}]\n$piercing1=$?s11151[${1.02}][${1}]\n"
      + "$mult=${$<arctic1>*$<piercing1>}",
  });
  const text = "наносящую ${$m2*$<mult>} ед. и снижающую скорость на $s1% на $d.";
  assert.equal(formatSpellDescription(text, frostbolt, { player: player() }),
    "наносящую 18 ед. и снижающую скорость на 40% на 5 сек.");
  // With both talents known: `$m2` 18 × 1.01 × 1.02 = 18.54 → «%.0f» 19.
  assert.equal(formatSpellDescription(text, frostbolt, { player: player({}, { knowsSpell: () => true }) }),
    "наносящую 19 ед. и снижающую скорость на 40% на 5 сек.");
});

test("Ж3.2 `$b1` is not a line break, and neither is `$b`", () => {
  // `$b<n>` is the points an effect gains per combo point, which is what Eviscerate's five lines
  // are built out of. 12.10: so is `$b` alone — 0x00579e50's `b` case writes EffectPointsPerCombo
  // of the first effect, truncated; it is never a line break in a spell description.
  const eviscerate = spell({ effectBasePoints: [0, 0, 0], effectDieSides: [5, 0, 0], effectPointsPerCombo: [6.5, 0, 0] });
  const line = "1 прием: ${$m1+(($b1*1)+$AP*0.03)} ед.";
  assert.equal(formatSpellDescription(line, eviscerate, { player: player({ UNIT_FIELD_ATTACK_POWER: 100 }) }),
    "1 прием: 11 ед.");
  assert.equal(formatSpellDescription("первая$bвторая", eviscerate), "первая6вторая");
});

test("Ж3.2 the plural", () => {
  const one = spell({ effectBasePoints: [0, 0, 0], effectDieSides: [1, 0, 0] });
  const many = spell({ effectBasePoints: [4, 0, 0], effectDieSides: [1, 0, 0] });
  assert.equal(formatSpellDescription("$s1 $lсекунду:секунд;", one), "1 секунду");
  // 12.10: 5 takes the third Russian form, and a list of two has none — 0x00576ef0 copies nothing.
  assert.equal(formatSpellDescription("$s1 $lсекунду:секунд;", many), "5 ");
  assert.equal(formatSpellDescription("$s1 $lсекунду:секунды:секунд;", many), "5 секунд");
});

const HUNTER = {
  name: "Тралл", className: "Охотник", raceName: "Орк", gender: 0,
  declined: ["Тралла", "Траллу", "Тралла", "Траллом", "Тралле"],
};
const HUNTRESS = { ...HUNTER, name: "Сильвана", gender: 1, declined: undefined };

test("Ж3.3 a greeting is written for whoever is reading it", () => {
  // Two markers of a dozen were read before this: the name and the line break. In the base world
  // dump the ones that were not are 1,646 occurrences in `npc_text` alone.
  assert.equal(formatNpcText("Приветствую, $N.", HUNTER), "Приветствую, Тралл.");
  assert.equal(formatNpcText("Ты $c, а значит $r.", HUNTER), "Ты Охотник, а значит Орк.");
  assert.equal(formatNpcText("первая$bвторая", HUNTER), "первая\nвторая");
});

test("Ж3.3 the gender marker takes the segment that fits, in both of its spellings", () => {
  assert.equal(formatNpcText("Слушай, $gдруг:подруга;.", HUNTER), "Слушай, друг.");
  assert.equal(formatNpcText("Слушай, $gдруг:подруга;.", HUNTRESS), "Слушай, подруга.");
  // The dump's spacing is not tidy — `$g lad : lass;` is a real row — so the segments are trimmed.
  assert.equal(formatNpcText("$g lad : lass ;", HUNTER), "lad");
  // ruRU adds a third segment naming a case. There is nothing here to decline with, so it goes.
  assert.equal(formatNpcText("$gдоблестный:доблестная:c;", HUNTRESS), "доблестная");
});

test("Ж3.3 a declension uses the name query's own cases, and nothing else", () => {
  // Case 2 is the dative, which the name query carries when the player filled it in.
  assert.equal(formatNpcText("Отдай это |3-2($N).", HUNTER), "Отдай это Траллу.");
  // A player who never filled them in keeps the nominative, exactly as the original client does.
  assert.equal(formatNpcText("Отдай это |3-2($N).", HUNTRESS), "Отдай это Сильвана.");
  // The ruRU rows use the marker for a *class* name, in a sixth case the packet has no room for.
  assert.equal(formatNpcText("Слышишь зов охоты, |3-6($c)?", HUNTER), "Слышишь зов охоты, Охотник?");
});

test("Ж3.3 the escapes that are not substitutions come out", () => {
  assert.equal(formatNpcText("|cff00ff00зелёный|r текст", HUNTER), "зелёный текст");
  assert.equal(formatNpcText("Принеси |Hitem:2589:0:0|hПолотно|h мне.", HUNTER), "Принеси Полотно мне.");
  // And a marker nothing here understands stays visible rather than leaving a hole.
  assert.equal(formatNpcText("Я, $t, приветствую тебя.", HUNTER), "Я, $t, приветствую тебя.");
});
