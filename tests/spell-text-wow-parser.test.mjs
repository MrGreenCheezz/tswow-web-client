import assert from "node:assert/strict";
import test from "node:test";

// 12.10: the owner's tooltips must show finished text with numbers. SpellText.ts now ports the whole
// of Wow.exe 3.3.5a 12340's description writer (QuestTextParser.cpp: 0x0057aaf0, 0x00579e50, the
// `${…}` compiler and VM 0x00579980/0x00578d10, `$?` 0x00579ba0/0x005797f0, the SpellDescriptionVariables
// table 0x00579d60). Each test names the address whose rule it pins.

const { formatSpellDescription, spellDescriptionRows } = await import("../dist/code/browser/ui/SpellText.js");
const { evaluateSpellExpression } = await import("../dist/code/browser/ui/SpellTextExpression.js");
const { spellConditionBranch } = await import("../dist/code/browser/ui/SpellTextCondition.js");
const { spellTextVariables } = await import("../dist/code/browser/ui/SpellTextVariables.js");
const { spellTextPlayerVariable } = await import("../dist/code/browser/ui/SpellTextPlayer.js");
const { spellTextLiveContext } = await import("../dist/code/browser/ui/SpellTextLiveContext.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { GLOBAL_STRING_DATA_AVAILABLE, GLOBAL_STRINGS } = await import("../dist/code/generated/globalStrings.js");

if (!GLOBAL_STRING_DATA_AVAILABLE || GLOBAL_STRINGS.INT_SPELL_DURATION_SEC === undefined) {
  Object.assign(GLOBAL_STRINGS, { INT_SPELL_DURATION_SEC: "%d сек", INT_SPELL_DURATION_MIN: "%d мин" });
}

function spell(fields = {}) {
  return {
    effectBasePoints: [0, 0, 0], effectDieSides: [1, 1, 1], effectPeriod: [0, 0, 0],
    effectChainTargets: [0, 0, 0], effectRadius: [0, 0, 0], duration: 0, maxDuration: 0, procChance: 100,
    procTypeMask: 0, procCharges: 0, stackAmount: 0, maxTargetLevel: 0, maxAffectedTargets: 0, manaPerSecond: 0,
    effectMultipleValue: [0, 0, 0], effectPointsPerCombo: [0, 0, 0], effectDamageMultiplier: [0, 0, 0],
    effectBonusMultiplier: [0, 0, 0], attributes: [0, 0, 0, 0, 0, 0, 0, 0],
    ...fields,
  };
}

const floatWord = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};

/** The active player: update-field words by `NAME` or `NAME+offset`. */
function player(words = {}, extra = {}) {
  const slots = new Map();
  for (const [key, value] of Object.entries(words)) {
    const [name, offset = "0"] = key.split("+");
    slots.set(UPDATE_FIELDS[name].offset + Number(offset), value);
  }
  return { slot: (index) => slots.get(index), knowsSpell: () => false, hasAura: () => false, ...extra };
}

/** A bare environment for evaluateSpellExpression. */
function environment(fields = {}, me = player(), rows = new Map()) {
  return {
    spell: spell(fields), row: (id) => rows.get(id), player: me, variable: () => 0,
    duration: (record) => Math.min(record.duration, record.maxDuration), cost: () => 0,
  };
}
const value = (body, env) => {
  const result = evaluateSpellExpression(body, env);
  return result.kind === "value" ? result.value : result.kind;
};

test("12.10 `${…}`: 0x00579980's `%.0f`, `.N`, and the number a `$l` agrees with", () => {
  const live = { player: player() };
  const s = spell({ effectBasePoints: [122, 0, 0] });
  assert.equal(formatSpellDescription("${$m1*0.5}", s, live), "62", "61.5 is written `%.0f`, a tie away from zero");
  assert.equal(formatSpellDescription("${$m1/7}.2", s, live), "17.57");
  assert.equal(formatSpellDescription("${$m1/7}.0", s, live), "18.0", "`.0` is not a precision (N is 1-9)");
  // fistp (a tie to even) for the plural: 4.5 is written «5» but agrees as 4 — the second ruRU form.
  assert.equal(formatSpellDescription("${9/2} $lкекс:кекса:кексов;", s, live), "5 кекса");
});

test("12.10 the compiler: precedence, unary minus, a space ends the sum, `%` is the client's formula", () => {
  const env = environment({ effectBasePoints: [9, 0, 0] });
  assert.equal(value("1+2*3^2", env), 19);
  assert.equal(value("(1+2)*3", env), 9);
  assert.equal(value("$m1*-1", env), -10);
  assert.equal(value("2^3^2", env), 64, "0x005777a0 is left-associative");
  // 0x005778b0 reads the operator at the cursor: a space after an operand ends the expression there.
  assert.equal(value("$m1 + 5", env), 10);
  assert.equal(value("$m1+ 5", env), 15, "a space before an operand is skipped by 0x00576bb0");
  // 0x00577ad0: a - (a/b - floor(a/b)) * b, which is floor(a/b)*b.
  assert.equal(value("7%3", env), 6);
  assert.equal(value("$s1*2", env), "error", "`s1` is not in 0x00ace8f8's table");
  assert.equal(value("2 3", env), 2, "the rest after a whole expression is not read");
  assert.equal(value("(2", env), "error", "a `(` without its `)`");
});

test("12.10 the twelve functions of 0x00ace898, matched without case", () => {
  const env = environment();
  assert.equal(value("$abs(-3)", env), 3);
  assert.equal(value("$ceil(1.2)+$floor(1.8)", env), 3);
  assert.equal(value("$min(4,2)+$max(4,2)", env), 6);
  assert.equal(value("$gt(3,2)+$lt(3,2)+$gte(2,2)+$lte(3,2)", env), 2);
  assert.equal(value("$eq(1,1.00001)+$eq(1,1.001)", env), 1, "eq is |a-b| < 1e-4");
  assert.equal(value("$cond(0,5,7)*10+$COND(2,5,7)", env), 75);
  assert.equal(value("$clamp(5,0,3)+$clamp(-1,0,3)+$Clamp(2,0,3)", env), 5);
  assert.equal(value("$FLOOR(2.5)", env), 2);
  assert.equal(value("$max(1)", env), "error", "a missing argument");
});

test("12.10 the spell's own names in a block: m/M, d, t, h, n, u, i, b, e, f, q, bc and another row", () => {
  const fields = {
    effectBasePoints: [9, 19, 0], effectDieSides: [1, 11, 0], effectPeriod: [3000, 0, 0],
    duration: 12000, maxDuration: 12000, procChance: 30, procCharges: 3, stackAmount: 5, maxAffectedTargets: 4,
    effectPointsPerCombo: [6.5, 0, 0], effectMultipleValue: [1.5, 0, 0], effectDamageMultiplier: [0.75, 0, 0],
    effectBonusMultiplier: [0.2, 0, 0], effectMiscValue: [135, 0, 0],
  };
  const other = spell({ id: 4242, effectBasePoints: [99, 0, 0] });
  const env = environment(fields, player(), new Map([[4242, other]]));
  assert.equal(value("$m2+$M2", env), 20 + 30);
  assert.equal(value("$d", env), Math.fround(12000 * Math.fround(0.001)), "milliseconds × 0.001f, a float");
  assert.equal(value("$t1", env), 3000, "the period in milliseconds");
  assert.equal(value("$h+$n+$u+$i", env), 42);
  assert.equal(value("$b1+$e1+$f1+$bc1", env), Math.fround(8.75 + Math.fround(0.2)), "each step stored as a float");
  // 0x005782d0's `q` case never reaches an index: always 0 in a block.
  assert.equal(value("$q1", env), 0);
  assert.equal(value("$4242m1", env), 100);
  assert.equal(value("$4243m1", env), "error", "a row the client lacks fails the block");
  // A ProcTypeMask with bit 0: `$t` is 5000 (record +0x88).
  assert.equal(value("$t1", environment({ ...fields, procTypeMask: 1 })), 5000);
});

test("12.10 the player's names (0x005782d0 over the update fields)", () => {
  const me = player({
    "UNIT_FIELD_STAT0+3": 300, "UNIT_FIELD_POSSTAT0+3": 40, "UNIT_FIELD_NEGSTAT0+3": -10 >>> 0,
    UNIT_FIELD_ATTACK_POWER: 1000, UNIT_FIELD_ATTACK_POWER_MODS: (30 << 16) | ((-20) & 0xffff),
    UNIT_FIELD_ATTACK_POWER_MULTIPLIER: floatWord(0.5), UNIT_FIELD_RANGED_ATTACK_POWER: 700,
    UNIT_FIELD_MINDAMAGE: floatWord(10.6), UNIT_FIELD_MAXDAMAGE: floatWord(20.2),
    UNIT_FIELD_BASEATTACKTIME: 2600, UNIT_FIELD_RANGEDATTACKTIME: 2900, UNIT_FIELD_LEVEL: 80,
    "PLAYER_FIELD_MOD_DAMAGE_DONE_POS+1": 500, "PLAYER_FIELD_MOD_DAMAGE_DONE_POS+2": 300,
    "PLAYER_FIELD_MOD_DAMAGE_DONE_POS+3": 400, "PLAYER_FIELD_MOD_DAMAGE_DONE_POS+4": 400,
    "PLAYER_FIELD_MOD_DAMAGE_DONE_POS+5": 600, "PLAYER_FIELD_MOD_DAMAGE_DONE_POS+6": 350,
    "PLAYER_FIELD_MOD_DAMAGE_DONE_NEG+2": -20 >>> 0, PLAYER_FIELD_MOD_HEALING_DONE_POS: 900,
    "PLAYER_FIELD_MOD_DAMAGE_DONE_PCT+5": floatWord(1.1), PLAYER_FIELD_MOD_HEALING_PCT: floatWord(1.25),
    PLAYER_VISIBLE_ITEM_16_ENTRYID: 30000,
  }, {
    item: (entry) => entry === 30000 ? { itemClass: 2, subClass: 8, damageMin: 150, damageMax: 280, damageType: 0 } : undefined,
  });
  const read = (name) => spellTextPlayerVariable(name, me);
  assert.equal(read("INT"), 300);
  assert.equal(read("int"), 270, "STAT − POSSTAT − NEGSTAT");
  assert.equal(read("ap"), 1000);
  assert.equal(read("AP"), 1515, "(1000 + 30 − 20) × 1.5");
  assert.equal(read("RAP"), 700);
  assert.equal(read("mw"), 10);
  assert.equal(read("MW"), 21);
  assert.equal(read("MWS"), Math.fround(2600 * Math.fround(0.001)));
  assert.equal(read("rws"), Math.fround(2900 * Math.fround(0.001)));
  assert.equal(read("PL"), 80);
  assert.equal(read("SPH"), 500, "holy, not healing");
  assert.equal(read("sph"), 500, "both cases read one value");
  assert.equal(read("SPFI"), 280);
  assert.equal(read("SP"), 280, "the least of the six schools");
  assert.equal(read("BH"), 900);
  assert.equal(read("ps"), Math.fround(1.1));
  assert.equal(read("pBH"), Math.fround(1.25));
  assert.equal(read("MWB"), 280);
  assert.equal(read("HND"), 2, "a two-handed sword in the main hand");
  assert.equal(read("owb"), 0, "nothing in the off hand");
  assert.equal(read("Ap"), undefined, "names are case-sensitive (0x00576b50, strncmp)");
});

test("12.10 `$?`: s and a terms, `!`, `&`, `|`, groups, the chain and the else after `]$[`", () => {
  const me = player({}, { knowsSpell: (id) => id === 1 || id === 3, hasAura: (id) => id === 7 });
  const pick = (text) => {
    const chosen = spellConditionBranch(text, 0, me);
    return "branch" in chosen ? chosen.branch : `@${chosen.at}`;
  };
  assert.equal(pick("s1[y][n]"), "y");
  assert.equal(pick("s2[y][n]"), "n");
  assert.equal(pick("a7[y][n]"), "y");
  assert.equal(pick("!s2[y][n]"), "y");
  assert.equal(pick("s1&s2[y][n]"), "n");
  assert.equal(pick("s2|a7[y][n]"), "y");
  assert.equal(pick("(s2|s3)&a7[y][n]"), "y");
  assert.equal(pick("s2[a]?s3[b][c]"), "b");
  assert.equal(pick("s2[a]?s4[b][c]"), "c");
  assert.equal(pick("s3[a]$[b]"), "a");
  assert.equal(pick("s2[a]$[b]"), "b");
  // Anything but s/a terms is skipped: `$gte($pl,68)` is no condition at all — false.
  assert.equal(pick("$gte($pl,68)[][Предмет должен быть не выше 138-го уровня.]"), "Предмет должен быть не выше 138-го уровня.");
  // No brackets: nothing is chosen and the reading stays after the spaces.
  assert.equal(pick("  s1 и всё"), "@2");
  // Without an active player every term is false.
  assert.equal("branch" in spellConditionBranch("s1[y][n]", 0, undefined) && spellConditionBranch("s1[y][n]", 0, undefined).branch, "n");
  // In a description the chosen branch is written by 0x0057aaf0 again, its markers included.
  const s = spell({ effectBasePoints: [4, 0, 0] });
  assert.equal(formatSpellDescription("Удар$?s1[ на $s1 ед.][] сильнее.", s, { player: me }), "Удар на 5 ед. сильнее.");
  assert.equal(formatSpellDescription("Удар$?s2[ на $s1 ед.][] сильнее.", s, { player: me }), "Удар сильнее.");
});

test("12.10 SpellDescriptionVariables: in order, conditional, `.N`, and what defines nothing", () => {
  const me = player({ UNIT_FIELD_LEVEL: 80 }, { knowsSpell: (id) => id === 48165 });
  const evaluate = (body, table) => {
    const result = evaluateSpellExpression(body, {
      ...environment({ effectBasePoints: [9, 0, 0] }, me),
      variable: (name) => table.find((entry) => entry.name === name)?.value ?? 0,
    });
    return result.kind === "value" ? result.value : undefined;
  };
  const source = "$base=($pl-1)*3+10\n$one=$?s1[${10}][${20}]\n$two=${$<one>*2}.1\n"
    + "$glyph=$?s48165[${3}]$[${0}]\n$funny=$?s1[${1}]?s48165[${$m1/4}.5][${7}]\n$bad=${$s1}\n$verylongvariablename=${1}";
  const built = spellTextVariables(source, me, evaluate);
  const byName = Object.fromEntries(built.filter((entry) => entry.name).map((entry) => [entry.name, entry.text]));
  assert.deepEqual(byName, { one: "20", two: "40.0", glyph: "3", funny: "2.50000", verylongvariab: "1" },
    "$base's next `$` is its `$pl`: no variable; $bad fails; a name is cut to 14 characters");
  // In a description: the written text, and the client's failure for an undefined name.
  const s = spell({ effectBasePoints: [9, 0, 0], descriptionVariables: source });
  assert.equal(formatSpellDescription("$<two> / $<funny> / $<base>", s, { player: me }), "40.0 / 2.50000 / $<base>");
});

test("12.10 the prose markers of the `v=18` columns: n u i v e f F b, and an older gateway", () => {
  const s = spell({
    procCharges: 3, stackAmount: 5, maxAffectedTargets: 4, maxTargetLevel: 60,
    effectMultipleValue: [1.25, 0, 0], effectDamageMultiplier: [0.5, 2.5, 0], effectPointsPerCombo: [6.9, 0, 0],
  });
  assert.equal(formatSpellDescription("$n $lзаряд:заряда:зарядов;, $u, $i, $v", s), "3 заряда, 5, 4, 60");
  assert.equal(formatSpellDescription("$e1 $f1 $F2 $*10;F1 $b1", s), "1.3 0.5 3 5 6");
  // A gateway before v=18 serves none of these: the markers stay as written until it is restarted.
  const old = spell();
  for (const key of ["procCharges", "stackAmount", "maxAffectedTargets", "maxTargetLevel", "effectMultipleValue",
    "effectDamageMultiplier", "effectPointsPerCombo", "procTypeMask"]) delete old[key];
  assert.equal(formatSpellDescription("$n, $u, $i, $v, $e1, $F1, $b1, $t1", old), "$n, $u, $i, $v, $e1, $F1, $b1, $t1");
});

test("12.10 `$t`: a period of 0 is 0, ProcTypeMask bit 0 is 5000, `%.2f` for a fraction, haste", () => {
  assert.equal(formatSpellDescription("$t1", spell()), "0");
  assert.equal(formatSpellDescription("$t1", spell({ procTypeMask: 1 })), "5");
  assert.equal(formatSpellDescription("$t1", spell({ effectPeriod: [1500, 0, 0] })), "1.50");
  assert.equal(formatSpellDescription("$t1", spell({ effectPeriod: [120000, 0, 0] })), "120");
  // SPELL_ATTR5_HASTE_AFFECT_DURATION with a player at 80 % cast time: 3000 → 2400.
  const hasted = spell({ effectPeriod: [3000, 0, 0], attributes: [0, 0, 0, 0, 0, 0x2000, 0, 0] });
  const quick = player({ UNIT_MOD_CAST_SPEED: floatWord(0.8) });
  assert.equal(formatSpellDescription("$t1", hasted, { player: quick }), "2.40");
  assert.equal(formatSpellDescription("$t1", hasted), "3", "no haste without a player");
});

test("12.10 `$o` and `$d` the way 0x00579e50 and 0x00800a70 compute them", () => {
  // «Пища» 434: a regeneration aura without a period counts 5000 ms — 58 × 21 s / 5 s = 243.6 → 243,
  // the «243 ед. здоровья за 21 сек.» of the real tooltip.
  const food = spell({ effectBasePoints: [57, 0, 0], duration: 21000, maxDuration: 21000 });
  assert.equal(formatSpellDescription("Восполнение $o1 ед. здоровья за $d.", food), "Восполнение 243 ед. здоровья за 21 сек.");
  // Duration over period, not whole ticks: 10 × 10 s / 3 s = 33.3 → 33.
  assert.equal(formatSpellDescription("$o1", spell({ effectBasePoints: [9, 0, 0], effectPeriod: [3000, 0, 0], duration: 10000, maxDuration: 10000 })), "33");
  // SPELL_ATTR5_START_PERIODIC_AT_APPLY adds one period.
  assert.equal(formatSpellDescription("$o1", spell({
    effectBasePoints: [9, 0, 0], effectPeriod: [3000, 0, 0], duration: 12000, maxDuration: 12000,
    attributes: [0, 0, 0, 0, 0, 0x200, 0, 0],
  })), "50");
  assert.equal(formatSpellDescription("$o1", spell({ effectBasePoints: [9, 0, 0], effectPeriod: [3000, 0, 0] })), "0", "no duration");
  // `$D` is `$d` (one case), capped by MaxDuration, and hasted for a periodic spell with the attribute.
  assert.equal(formatSpellDescription("$D", spell({ duration: 30000, maxDuration: 20000 })), "20 сек");
  const dot = spell({ effectPeriod: [3000, 0, 0], duration: 18000, maxDuration: 18000, attributes: [0, 0, 0, 0, 0, 0x2000, 0, 0] });
  assert.equal(formatSpellDescription("$d", dot, { player: player({ UNIT_MOD_CAST_SPEED: floatWord(0.5) }) }), "9 сек");
});

test("12.10 `$c`, `$p` and `$z`", () => {
  const s = spell({ powerType: 0, powerCost: 50, powerCostPercent: 10, manaPerSecond: 7 });
  const me = player({}, { basePower: () => 1000 });
  assert.equal(formatSpellDescription("$c / $p", s, { player: me }), "150 / 7");
  assert.equal(formatSpellDescription("$c / $p", s), "-1 / 0", "0x008012f0 and 0x007ff100 without a unit");
  assert.equal(formatSpellDescription("в \"$z\"", spell(), { homeName: "Златоземье" }), "в \"Златоземье\"");
  assert.equal(formatSpellDescription("в \"$z\"", spell()), "в \"ваша таверна\"", "HOME_INN without a bind point");
});

test("12.10 typos of the dataset come out as the client writes them", () => {
  const rows = new Map([[100, spell({ id: 100 })], [45548, spell({ id: 45548, effectBasePoints: [99, 0, 0] })]]);
  const s = spell({ id: 1 });
  // A factor after the id (57070's aura): the id is read, `/` has no case — `$`, then the rest.
  assert.equal(formatSpellDescription("Восстановление $45548/5;s1 ед.", s, { spells: rows }), "Восстановление $/5;s1 ед.");
  // `$100%` (28412): spell 100, then `%` — `$`.
  assert.equal(formatSpellDescription("получает $100% урона", s, { spells: rows }), "получает $% урона");
  assert.equal(formatSpellDescription("на $s1% в течение $.", s), "на 1% в течение $.");
  // `$PlayerName` (47695): `P` is ManaPerSecond.
  assert.equal(formatSpellDescription("|3-4($PlayerName)", s, { player: player() }), "|3-4(0layerName)");
});

test("12.10 a live context reads the session's player, spellbook and auras", () => {
  const self = 7n;
  const world = {
    state: { selfGuid: self, objects: new Map([[self, { fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 70]]) }]]) },
    knownSpells: [{ id: 31674 }], auras: new Map([[self, new Map([[0, { spellId: 63279 }]])]]),
    itemTemplates: new Map(), bindPoint: { areaId: 1519 },
  };
  const context = spellTextLiveContext(world, new Map(), { areaName: (id) => id === 1519 ? "Штормград" : undefined, answered: () => true });
  assert.equal(context.player.knowsSpell(31674), true);
  assert.equal(context.player.hasAura(63279), true);
  assert.equal(context.homeName, "Штормград");
  assert.equal(formatSpellDescription("${$pl*2} $?a63279[да][нет] $z", spell(), context), "140 да Штормград");
  assert.equal(spellTextLiveContext(undefined, undefined).player, undefined);
});

test("12.10 the rows a description reads include its SpellDescriptionVariables formulas'", () => {
  assert.deepEqual(spellDescriptionRows({ description: "${$m1*$<mult>}", descriptionVariables: "$mult=$?s57810[${1+0.01*$57810m1}][${1}]" }), [57810]);
  assert.deepEqual(spellDescriptionRows({ description: "$s1", auraDescription: "$4187s1" }, true), [4187]);
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("12.10 over the base dataset, a `$` is left only where Wow.exe itself writes one", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const rows = await loadSpellMetadata(dbcDirectory);
  const context = { spells: rows, player: player({}, { basePower: () => 0 }) };
  const unexplained = [];
  let written = 0;
  for (const [id, row] of rows) {
    for (const text of [row.description, row.auraDescription ?? ""]) {
      if (!text.includes("$")) continue;
      written++;
      const out = formatSpellDescription(text, row, context);
      if (!out.includes("$")) continue;
      // What 0x00579e50 cannot read: a row Spell.dbc lacks, a letter with no case, a factor after an
      // id, a factor with no `;` anywhere after it (71180's «$/1000S1»).
      const failures = [...text.matchAll(/\$(\d+)[a-zA-Z]/g)].some((m) => !rows.has(Number(m[1])))
        || /\$\d+[/*%]|\$[ .|%]|\$\d+%|\$[/*][^;]*$/.test(text);
      if (!failures) unexplained.push(`${id}: ${out.slice(0, 120)}`);
    }
  }
  assert.ok(written > 30_000, `the dataset carries markers (${written})`);
  assert.deepEqual(unexplained, []);
});
