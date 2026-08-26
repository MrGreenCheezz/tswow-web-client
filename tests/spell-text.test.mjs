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
  assert.equal(formatDuration(2500), "3 сек", "the real tooltip rounds rather than truncates");
  assert.equal(formatDuration(60_000), "1 мин");
  assert.equal(formatDuration(90_000), "90 сек", "a minute and a half is not one minute");
  assert.equal(formatDuration(3_600_000), "1 ч");
  assert.equal(formatDuration(86_400_000), "1 д");
});

test("Ж3.2 braces are arithmetic, and only when they hold nothing else", () => {
  const numbers = spell({ effectBasePoints: [9, 0, 0], effectDieSides: [1, 0, 0] });
  assert.equal(formatSpellDescription("${$s1*3}", numbers), "30");
  assert.equal(formatSpellDescription("${$m1/2}", numbers), "5");

  // A name, a comparison or another spell's id inside the braces is left exactly as it stands: a
  // wrong number on a tooltip is worse than a marker that is visibly a marker.
  assert.equal(formatSpellDescription("${$42208m1*8*$<mult>}", numbers), "${$42208m1*8*$<mult>}");
  assert.equal(formatSpellDescription("${$<AP>*0.2}", numbers), "${$<AP>*0.2}");
});

test("Ж3.2 WotLK named formulas and cross-spell durations are resolved", () => {
  // Exact ruRU Spell.dbc text for Seal of Righteousness base row 21084. `$21084d` is a real
  // self-reference here, while MWS/AP/SPH are the player's runtime operands rather than DBC effects.
  const seal = spell({ id: 21084, duration: 1_800_000 });
  const baseSeal = spell({ id: 21084, duration: 1_800_000 });
  const text = "Наполняет паладина священным духом на $21084d. С каждой атакой ближнего боя "
    + "паладин наносит дополнительно ${$MWS*(0.022*$AP+0.044*$SPH)} ед. урона от светлой магии.\n\n"
    + "Высвободив энергию печати, вы наносите противнику ${1+0.2*$AP+0.32*$SPH} ед. урона.";
  assert.equal(
    formatSpellDescription(text, seal, {
      spells: new Map([[baseSeal.id, baseSeal]]),
      values: { MWS: 2, AP: 1000, SPH: 500 },
    }),
    "Наполняет паладина священным духом на 30 мин. С каждой атакой ближнего боя "
      + "паладин наносит дополнительно 88 ед. урона от светлой магии.\n\n"
      + "Высвободив энергию печати, вы наносите противнику 361 ед. урона.");
  // Rank row 20154 is the cross-row variant seen in the book; the gateway preloads 21084 so this
  // marker is resolved instead of leaking into the tooltip.
  const rankSeal = spell({ id: 20154, duration: 1_800_000 });
  assert.equal(formatSpellDescription("Печать на $21084d", rankSeal, {
    spells: new Map([[baseSeal.id, baseSeal]]),
  }), "Печать на 30 мин");
  assert.equal(formatSpellDescription("Урон: $1{1+0.2*$AP+0.32*$SPH}", seal, {
    values: { AP: 1000, SPH: 500 },
  }), "Урон: 361");
});

test("Ж3.2 SpellDescriptionVariables named formulas strip their authored braces", () => {
  const spell136 = spell({ id: 136, effectBasePoints: [9, 0, 0], effectDieSides: [1, 0, 0],
    descriptionVariables: "$total=${$m1*5}" });
  assert.equal(formatSpellDescription("Урон: $<total>", spell136), "Урон: 50");
});

test("Ж3.2 an unavailable runtime formula gets a readable fallback in a live tooltip", () => {
  const seal = spell({ id: 21084, duration: 1_800_000 });
  const result = formatSpellDescription("Урон: ${$MWS*(0.022*$AP+0.044*$SPH)}", seal, {
    values: { AP: 1000 },
  });
  assert.equal(result, "Урон: значение зависит от характеристик");
  assert.doesNotMatch(result, /\$[A-Za-z]|\$\{/);
  const named = formatSpellDescription("Урон: $<talentBonus>", seal, { values: {} });
  assert.equal(named, "Урон: значение зависит от характеристик");
  assert.doesNotMatch(named, /\$</);
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

test("Ж3.2 what the parser cannot answer, it leaves alone", () => {
  const plain = spell();
  // Another spell's effect would have to be fetched before it could be read.
  assert.equal(formatSpellDescription("$12345s1 урона", plain), "$12345s1 урона");
  // No variable body was supplied in this isolated parser fixture.
  assert.equal(formatSpellDescription("$<damage> урона", plain), "$<damage> урона");
  // A conditional on an aura the client cannot see.
  assert.equal(formatSpellDescription("$?s48165[да][нет]", plain), "$?s48165[да][нет]");
  // And with no spell at all, nothing is guessed.
  assert.equal(formatSpellDescription("$s1 урона", undefined), "$s1 урона");
});

test("Ж3.2 a block it cannot answer keeps its markers, and is not half filled in", () => {
  // Found by running the parser over all 49,842 rows of the real table rather than over a fixture.
  // Frostbolt: the multiplier names a variable absent from this fixture, so the block cannot be
  // worked out — and filling in the `$m2` inside it anyway left «${18*$<mult>}» on the tooltip,
  // which is neither the answer nor the marker the artist wrote.
  const frostbolt = spell({ effectBasePoints: [39, 17, 0], effectDieSides: [1, 3, 0], duration: 5000 });
  assert.equal(
    formatSpellDescription("наносящую ${$m2*$<mult>} ед. и снижающую скорость на $s1% на $d.", frostbolt),
    "наносящую ${$m2*$<mult>} ед. и снижающую скорость на 40% на 5 сек.");
});

test("Ж3.2 `$b1` is not a line break, whatever `$b` is", () => {
  // Also found against the real table. `$b` on its own is a break; `$b<n>` is the points an effect
  // gains per combo point, which is what Eviscerate's five lines are built out of. Breaking on it
  // put newlines inside the arithmetic and made the whole tooltip unreadable.
  const eviscerate = spell({ effectBasePoints: [0, 0, 0], effectDieSides: [5, 0, 0] });
  const line = "1 прием: ${$m1+(($b1*1)+$AP*0.03)*$<mult>} ед.";
  assert.equal(formatSpellDescription(line, eviscerate), line);
  assert.equal(formatSpellDescription("первая$bвторая", eviscerate), "первая\nвторая");
});

test("Ж3.2 the line break and the plural", () => {
  const one = spell({ effectBasePoints: [0, 0, 0], effectDieSides: [1, 0, 0] });
  const many = spell({ effectBasePoints: [4, 0, 0], effectDieSides: [1, 0, 0] });
  assert.equal(formatSpellDescription("первая$bвторая", one), "первая\nвторая");
  assert.equal(formatSpellDescription("$s1 $lсекунду:секунд;", one), "1 секунду");
  assert.equal(formatSpellDescription("$s1 $lсекунду:секунд;", many), "5 секунд");
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
