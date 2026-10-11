import assert from "node:assert/strict";
import test from "node:test";

// 11.10: the owner's tooltips showed «формулы чисел вместо реального числа». Wow.exe's description
// parser (0x00579e50, SpellTextWowRules.ts) answers the forms SpellText.ts left as written.

const { formatSpellDescription, spellDescriptionReferences } = await import("../dist/code/browser/ui/SpellText.js");
const {
  spellTextEffectValue, spellTextFactor, spellTextPluralIndex,
} = await import("../dist/code/browser/ui/SpellTextWowRules.js");
const { GLOBAL_STRING_DATA_AVAILABLE, GLOBAL_STRINGS } = await import("../dist/code/generated/globalStrings.js");

// A neutral build has no GlobalStrings; give it the client's own words for `$d` (GlobalStrings.lua:6937).
if (!GLOBAL_STRING_DATA_AVAILABLE || GLOBAL_STRINGS.SPELL_DURATION_UNTIL_CANCELLED === undefined) {
  Object.assign(GLOBAL_STRINGS, { SPELL_DURATION_UNTIL_CANCELLED: "до отмены", INT_SPELL_DURATION_SEC: "%d сек" });
}

function spell(fields = {}) {
  return {
    effectBasePoints: [0, 0, 0], effectDieSides: [1, 1, 1], effectPeriod: [0, 0, 0],
    effectChainTargets: [0, 0, 0], effectRadius: [0, 0, 0], duration: 0, maxDuration: 0, procChance: 100,
    ...fields,
  };
}

test("11.10 `$/N;` and `$*N;` scale the value markers", () => {
  // The dataset's own rows: 13741 «Улучшенный парализующий удар» (499 + 1 ms), 11069 (-101 + 1),
  // 100 «Рывок» (89 + 1 tenths of rage).
  const gouge = spell({ id: 13741, effectBasePoints: [499, 0, 0] });
  assert.equal(formatSpellDescription("на $/1000;S1 сек.", gouge), "на 0.5 сек.");
  const fireball = spell({ id: 11069, effectBasePoints: [-101, 0, 0] });
  assert.equal(formatSpellDescription("на $/1000;S1 секунды.", fireball), "на 0.1 секунды.");
  const charge = spell({ id: 100, effectBasePoints: [0, 89, 0], effectDieSides: [0, 1, 0] });
  assert.equal(formatSpellDescription("накапливая $/10;s2 ед. ярости", charge), "накапливая 9 ед. ярости");
  // A whole result is written as an integer, `S` or not; `*` multiplies.
  const second = spell({ effectBasePoints: [999, 0, 0] });
  assert.equal(formatSpellDescription("$/1000;S1 сек.", second), "1 сек.");
  assert.equal(formatSpellDescription("$*15;s1", spell({ effectBasePoints: [1, 0, 0] })), "30");
  // A fraction: `s` writes the integer below it, `S`, `m` and `M` one decimal.
  const ninetyFive = spell({ effectBasePoints: [94, 0, 0] });
  assert.equal(formatSpellDescription("$/10;s1|$/10;S1|$/10;m1|$/10;M1", ninetyFive), "9|9.5|9.5|9.5");
  // A range keeps this client's dash; its ends follow the same rules.
  const range = spell({ effectBasePoints: [13, 0, 0], effectDieSides: [9, 1, 1] });
  assert.equal(formatSpellDescription("$*2;s1", range), "28–44");
  assert.equal(formatSpellDescription("$/10;S1", range), "1.4–2.2");
  assert.equal(formatSpellDescription("$/10;s1", range), "1–3");
  // On another row, and summed over the ticks for `o` (29131: 10 a second for 10 s, in tenths).
  // 12.10: with its SpellDuration row's MaxDuration, which 0x00800a70 caps the duration by.
  const bloodrage = spell({ id: 29131, effectBasePoints: [9, 0, 0], effectPeriod: [1000, 0, 0], duration: 10000, maxDuration: 10000 });
  assert.equal(formatSpellDescription("еще $/10;29131o1 ед. ярости", spell({ id: 2687 }), {
    spells: new Map([[29131, bloodrage]]),
  }), "еще 10 ед. ярости");
  // The factor reaches only s S m M o O: on `$d` it is read and ignored, as 0x00579e50 does.
  assert.equal(formatSpellDescription("$/1000;d", spell({ duration: 5000, maxDuration: 5000 })), "5 сек");
});

test("11.10 the factor itself: atoi's number, 0 is 1, a negative N a negative factor", () => {
  assert.equal(spellTextFactor("/", "1000"), Math.fround(0.001));
  assert.equal(spellTextFactor("*", "2.9"), 2);
  assert.equal(spellTextFactor("/", "0"), 1);
  assert.equal(spellTextFactor("*", ""), 1);
  // 12.10: 0x0076f0d0 reads the `-`, and 0x00579e50 divides by -10 like by any other N.
  assert.equal(spellTextFactor("/", "-10"), Math.fround(-0.1));
  assert.equal(formatSpellDescription("$/-10;s1", spell({ effectBasePoints: [9, 0, 0] })), "-1");
  // Within 0.001 of an integer is that integer (0x009e1134).
  assert.deepEqual(spellTextEffectValue("S", 2.9996, 2.9996, 1), { text: "3", plural: 3 });
  assert.deepEqual(spellTextEffectValue("S", 2.5, 2.5, 1), { text: "2.5", plural: 2 });
});

test("11.10 `$d` without a duration, `$q`, `$r` and `$a` without a radius", () => {
  // 1753 «Съеживание»: DurationIndex 0; 13741: SpellDuration -1. Both are «до отмены» in the client.
  assert.equal(formatSpellDescription("в течение $d.", spell({ duration: 0 })), "в течение до отмены.");
  assert.equal(formatSpellDescription("на $d", spell({ duration: -1 })), "на до отмены");
  // 2006 «Воскрешение»: EffectMiscValue 135 is the mana.
  assert.equal(formatSpellDescription("и $q1 ед. маны", spell({ effectMiscValue: [135, 0, 0] })), "и 135 ед. маны");
  assert.equal(formatSpellDescription("$r1 м", spell({ rangeMax: 30 })), "30 м");
  assert.equal(formatSpellDescription("$r м", spell({ rangeMax: 5.5 })), "6 м");
  assert.equal(formatSpellDescription("в радиусе $a1 м", spell()), "в радиусе 0 м");
  assert.equal(formatSpellDescription("в радиусе $a1 м", spell({ effectRadius: [6.5, 0, 0] })), "в радиусе 6 м");
});

test("11.10 `$g` by the player's sex; without a player, the client's failure", () => {
  const text = "обеспечить мага и $gего:ее; союзников";
  assert.equal(formatSpellDescription(text, spell(), { female: false }), "обеспечить мага и его союзников");
  assert.equal(formatSpellDescription(text, spell(), { female: true }), "обеспечить мага и ее союзников");
  // 12.10: 0x00579e50 steps past the `g` before it asks for the active player, then fails: `$`, and
  // the forms as they stand.
  assert.equal(formatSpellDescription(text, spell()), "обеспечить мага и $его:ее; союзников");
  assert.equal(formatSpellDescription("$G Охотник : Охотница ;", spell(), { female: true }), "Охотница");
  // A Latin C or R after a second colon asks another function (0x0071a620/0x0071a540).
  assert.equal(formatSpellDescription("$gа:б:C;", spell(), { female: true }), "$gа:б:C;");
});

test("11.10 `$l` takes the Russian form of the number written before it", () => {
  const food = (count) => spell({ effectBasePoints: [count - 1, 0, 0] });
  const text = "Создает $s1 $lкекс:кекса:кексов;";
  assert.equal(formatSpellDescription(text, food(1)), "Создает 1 кекс");
  assert.equal(formatSpellDescription(text, food(2)), "Создает 2 кекса");
  assert.equal(formatSpellDescription(text, food(5)), "Создает 5 кексов");
  assert.equal(formatSpellDescription(text, food(11)), "Создает 11 кексов");
  assert.equal(formatSpellDescription(text, food(21)), "Создает 21 кекс");
  // In reading order: each plural agrees with its own number, not with the description's last.
  const two = spell({ effectBasePoints: [0, 4, 0], effectDieSides: [1, 1, 0] });
  assert.equal(formatSpellDescription("$s1 $lкекс:кекса:кексов; и $s2 $lзелье:зелья:зелий;", two),
    "1 кекс и 5 зелий");
  // Two forms: the second for 3; 12.10: past the last one, nothing (0x00576ef0 walks into the `;`).
  assert.equal(formatSpellDescription("$s1 $lсекунду:секунд;", food(3)), "3 секунд");
  assert.equal(formatSpellDescription("$s1 $lсекунду:секунд;", food(5)), "5 ");
  assert.equal(spellTextPluralIndex("ruRU", 3), 1);
  assert.equal(spellTextPluralIndex("ruRU", 14), 2);
  assert.equal(spellTextPluralIndex("enUS", 0), 1);
  assert.equal(spellTextPluralIndex("frFR", 1), 0);
  assert.equal(spellTextPluralIndex("frFR", 0), 0);
});

test("11.10 the rows a description reads, for the tooltip to fetch", () => {
  assert.deepEqual(spellDescriptionReferences("$/10;2687s1 и $?s12296[${$29131m1*$29131d/10+$m2}][$/10;29131o1] за $29131d"),
    [2687, 29131]);
  assert.deepEqual(spellDescriptionReferences("$s1 и $d, $1{2+2}"), []);
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("11.10 no factor marker is left in a stock description whose rows exist", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const rows = await loadSpellMetadata(dbcDirectory);
  const left = [];
  let scaled = 0;
  for (const [id, row] of rows) {
    for (const text of [row.description, row.auraDescription ?? ""]) {
      const markers = text.match(/\$[/*][^;$]*;\d*[sSmMoO]\d?/g);
      if (!markers) continue;
      scaled += markers.length;
      const out = formatSpellDescription(text, row, { spells: rows, female: false });
      for (const marker of out.match(/\$[/*][^;$]*;\d*[sSmMoO]\d?/g) ?? []) {
        const reference = /;(\d+)/.exec(marker)?.[1];
        if (!reference || rows.has(Number(reference))) left.push(`${id}: ${marker}`);
      }
    }
  }
  assert.ok(scaled > 500, `the dataset carries factor markers (${scaled})`);
  assert.deepEqual(left, []);
  // 587 «Сотворение пищи» rank 1: two cakes, and the mage's own pronoun.
  assert.match(formatSpellDescription(rows.get(587).description, rows.get(587), { female: false }),
    /^Создает 2 кекса, чтобы обеспечить мага и его союзников едой\./);
});
