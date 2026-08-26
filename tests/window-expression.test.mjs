import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPRESSION_FUNCTIONS,
  evaluate,
  expressionRoots,
  formatExpressionValue,
  isExpressionSource,
  literalNode,
  parseExpression,
  parseTemplate,
  pathNode,
} from "../dist/code/browser/ui/WindowExpression.js";
import {
  GLOBAL_STRING_DATA_AVAILABLE, globalString,
} from "../dist/code/generated/globalStrings.js";

const withGlobalStrings = {
  skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data",
};

/** The tree, or the reason there is none — as an assertion, so a broken source names itself. */
const ast = (source) => {
  const parsed = parseExpression(source);
  assert.ok(parsed.ast, `«${source}» did not parse: ${parsed.problems.join("; ")}`);
  return parsed.ast;
};

const value = (source, scope = {}, helpers = undefined) => evaluate(ast(source), scope, helpers);

/** One frozen snapshot of the published view, in the shape М6 will publish. */
const SNAPSHOT = Object.freeze({
  player: Object.freeze({
    name: "Тестер", level: 42, health: 3140, maxHealth: 4200, power: 900, maxPower: 1200,
    xp: 51_200, maxXp: 89_000, money: 1_234_567, combat: false, resting: true, mounted: false,
    dead: false, buff: { "Благословение королей": { spellId: 20217 } }, debuff: {},
  }),
  target: Object.freeze({ exists: true, name: "Сварливый кабан", health: 812, maxHealth: 2100, hostile: true }),
  world: Object.freeze({ zone: "Элвиннский лес", subzone: "", clock: "12:30", inGroup: false, inRaid: false, inInstance: false }),
  party: [{ name: "Первый", health: 100 }, { name: "Второй", health: 40 }],
  // Both kinds of input, because `state.<id>` is a contract and the contract has two halves: a box
  // marked «только числа» publishes a number, any other publishes its text (`EditBoxWidget.
  // stateKind` in WindowSchema.ts). `input-1` here is a text box; `qty` is a numeric one.
  state: Object.freeze({ "input-1": "17", qty: 17 }),
});

/* ---------------------------------------------------------------------------------------------
 * The tree is data
 * ------------------------------------------------------------------------------------------- */

test("the parsed tree is inert data: it survives a JSON round trip unchanged", () => {
  // The whole reason this parser exists instead of `new Function`. If any node ever carried a
  // closure — a compiled getter, a bound formatter — `JSON.stringify` would drop it and this
  // comparison would fail. Everything the grammar can produce is covered on purpose.
  const sources = [
    "1 + 2 * 3",
    '"текст"',
    "true ? player.health : -1",
    "not player.combat",
    "party[0].name",
    'state["input-1"]',
    "clamp(pct(player.health, player.maxHealth), 0, 100)",
    'target.exists and target.health < 500 or world.inRaid',
    'fmt(player.money / 10000, 2) + " з"',
    "player.health % 7",
  ];
  for (const source of sources) {
    const tree = ast(source);
    assert.deepEqual(JSON.parse(JSON.stringify(tree)), tree, source);
  }

  // The same for a template, which is the other thing a definition can hold.
  const template = parseTemplate("Уровень {player.level} — {player.name}").ast;
  assert.deepEqual(JSON.parse(JSON.stringify(template)), template);

  // And nothing anywhere in a tree is callable, whatever the shape.
  const walk = (node) => {
    assert.notEqual(typeof node, "function");
    if (node && typeof node === "object") for (const child of Object.values(node)) walk(child);
  };
  for (const source of sources) walk(ast(source));
});

test("a call to a function outside the table is refused, by name, at parse time", () => {
  // The table is closed so that a module naming something this client has not got fails while its
  // author is looking at the file, not sixty frames into a fight.
  for (const name of ["eval", "Function", "fetch", "random", "print", "constructor", "toString"]) {
    const parsed = parseExpression(`${name}(1)`);
    assert.equal(parsed.ast, undefined, name);
    assert.ok(parsed.problems.some((problem) => problem.includes(`"${name}"`)), `${name}: ${parsed.problems}`);
    assert.ok(parsed.problems.some((problem) => problem.includes("not one of the functions")), name);
  }

  // Every name that *is* in the table parses, and the list in the message is the table itself.
  assert.deepEqual([...EXPRESSION_FUNCTIONS].sort(), [
    "abs", "ceil", "clamp", "floor", "fmt", "icon", "itemName", "loc", "max", "min", "money",
    "pct", "round", "spellName", "time",
  ]);
  assert.equal(parseExpression("nope(1)").problems[0].includes("spellName"), true);
});

test("a function called with the wrong number of arguments is refused by name", () => {
  const cases = [
    ["floor()", "floor"], ["floor(1, 2)", "floor"], ["clamp(1, 2)", "clamp"], ["clamp(1, 2, 3, 4)", "clamp"],
    ["pct(1)", "pct"], ["fmt(1, 2, 3)", "fmt"], ["min()", "min"],
  ];
  for (const [source, name] of cases) {
    const parsed = parseExpression(source);
    assert.equal(parsed.ast, undefined, source);
    assert.ok(parsed.problems[0].includes(name), `${source}: ${parsed.problems[0]}`);
  }
  // Variadic min/max take any number above one, and fmt takes one or two.
  assert.equal(value("min(3, 1, 2)"), 1);
  assert.equal(value("max(3, 1, 2, 9)"), 9);
  assert.equal(value("fmt(1.239, 2)"), "1.24");

  // `min` and `max` are the two with no ceiling on the count, and they used to answer by spreading
  // the arguments into `Math.min`, which puts every one of them on the stack: measured on this
  // machine, 100,000 arguments answered and 130,000 threw `RangeError: Maximum call stack size
  // exceeded` out of the one function in the module that promises never to throw.
  const many = `min(${Array(130_000).fill("2").join(",")}, 1)`;
  assert.equal(value(many), 1, "folded, not spread");
  assert.equal(value(`max(${Array(130_000).fill("2").join(",")}, 9)`), 9);
});

/* ---------------------------------------------------------------------------------------------
 * The grammar
 * ------------------------------------------------------------------------------------------- */

test("the grammar binds the way the plan writes it", () => {
  assert.equal(value("1 + 2 * 3"), 7);
  assert.equal(value("(1 + 2) * 3"), 9);
  assert.equal(value("10 - 3 - 2"), 5, "sum is left-associative");
  assert.equal(value("100 / 5 / 2"), 10, "so is mul");
  assert.equal(value("1 + 2 == 3"), true, "arithmetic binds tighter than comparison");
  assert.equal(value("true or false and false"), true, "and binds tighter than or");
  assert.equal(value("1 < 2 ? 10 : 20"), 10);
  assert.equal(value("1 > 2 ? 10 : 1 < 2 ? 30 : 40"), 30, "the false branch takes a whole expression");
  assert.equal(value("-3 + 5"), 2);
  assert.equal(value("2 * -3"), -6);
  assert.equal(value("not false"), true);
  // `unary` binds tighter than `cmp`, exactly as the grammar is written: `not a == b` is
  // `(not a) == b`, and the other reading needs parentheses.
  assert.equal(value("not 0 == true"), true);
  assert.equal(value("not (1 == 2)"), true);
});

test("a comparison cannot be chained, because a chained one could never be true", () => {
  // `0 < player.level < 100` groups left, so the second comparison orders a boolean against a
  // number — and ordering across types has no answer here, on purpose. Every value of
  // `player.level` gives `undefined`, so a `then: hide` written that way is a rule that can never
  // fire. Refused where the author can see it rather than left to be discovered on the screen.
  for (const source of ["0 < player.level < 100", "1 < 2 < 3", "a == b == c", "1 >= 2 <= 3"]) {
    const parsed = parseExpression(source);
    assert.equal(parsed.ast, undefined, source);
    assert.ok(parsed.problems[0].includes("chain"), `${source}: ${parsed.problems[0]}`);
    assert.ok(parsed.problems[0].includes('"and"'), `${source}: ${parsed.problems[0]}`);
  }
  // One comparison is the shape everything in this client actually writes, and the spelling the
  // message recommends parses and works.
  assert.equal(value("player.level > 10 and player.level < 100", SNAPSHOT), true);
  assert.equal(value("(0 < player.level) == true", SNAPSHOT), true, "brackets say which reading was meant");
  assert.equal(value("1 + 2 == 3"), true);
});

test("and and or hand back the operand, not a boolean, so `a or b` is a fallback", () => {
  // The `zone` binding is `world.subzone or world.zone`, which only works because `or` returns the
  // value it chose. A boolean here would print "да" where the zone should be.
  assert.equal(value("world.subzone or world.zone", SNAPSHOT), "Элвиннский лес");
  assert.equal(value("world.subzone or world.zone", { world: { subzone: "Гоблинская пристань", zone: "Дуротар" } }), "Гоблинская пристань");
  assert.equal(value("player.name and player.level", SNAPSHOT), 42);
  assert.equal(value("nothing and player.level", SNAPSHOT), undefined, "and short-circuits on the falsy left");
});

test("the tokenizer names the position of what it could not read", () => {
  for (const [source, needle] of [
    ["1 +", "stops early"],
    ["(1", 'expected ")"'],
    ["'unclosed", "never closed"],
    ["1 @ 2", '"@" means nothing here'],
    ["player.", 'a name has to follow "."'],
    ["1 2", "goes on"],
    ["", "empty"],
    ["and 1", "operator"],
  ]) {
    const parsed = parseExpression(source);
    assert.equal(parsed.ast, undefined, source);
    assert.ok(parsed.problems.some((problem) => problem.includes(needle)), `${source}: ${parsed.problems}`);
  }
  assert.equal(parseExpression("1 +").problems.length, 1, "one cause, not six consequences");
});

test("an expression may not nest deeper than the parser's own limit", () => {
  // A definition file is not written by this client, and five hundred open brackets would be a
  // stack overflow rather than a parse problem. The limit counts grammar levels, and one bracket
  // costs the eight of the precedence cascade — so thirty brackets pass and five hundred do not.
  const deep = `${"(".repeat(500)}1${")".repeat(500)}`;
  const parsed = parseExpression(deep);
  assert.equal(parsed.ast, undefined);
  assert.ok(parsed.problems[0].includes("nests deeper"), parsed.problems[0]);
  assert.ok(parseExpression(`${"(".repeat(25)}1${")".repeat(25)}`).ast, "twenty-five brackets is fine");
  // Nothing a window actually holds comes anywhere near it.
  assert.ok(parseExpression('clamp(pct(player.health, player.maxHealth), 0, 100) > 30 ? "a" : "b"').ast);
});

test("a flat chain of operators is a deep tree, and it is bounded by the same limit", () => {
  // Brackets are not the only way to build a tall tree, and they were the only way this guard
  // caught. Each `+` folds the whole left side into a new node, so `1+1+…` grew a left-deep tree
  // with the depth counter sitting at 8: measured here before the fix, 993 terms parsed with no
  // problems and then threw RangeError out of JSON.stringify — the inertness property — and 3,290
  // terms threw out of `evaluate` and `expressionRoots`, which promise never to throw.
  const chain = (terms, operator = "+") => Array(terms).fill("1").join(operator);
  for (const operator of ["+", "*", "and", "or", "-"]) {
    const source = operator === "and" || operator === "or" ? chain(5000, ` ${operator} `) : chain(5000, operator);
    const parsed = parseExpression(source);
    assert.equal(parsed.ast, undefined, operator);
    assert.ok(parsed.problems[0].includes("nests deeper"), `${operator}: ${parsed.problems[0]}`);
  }

  // What does parse, walks — all three walkers, on the tallest tree the parser will still build.
  const tall = parseExpression(chain(200)).ast;
  assert.ok(tall);
  assert.deepEqual(JSON.parse(JSON.stringify(tall)), tall);
  assert.equal(evaluate(tall, {}), 200);
  assert.deepEqual(expressionRoots(tall), []);

  // A hundred terms is already far past anything a person writes, and it parses.
  assert.ok(parseExpression(chain(100)).ast);
});

/* ---------------------------------------------------------------------------------------------
 * Missing data
 * ------------------------------------------------------------------------------------------- */

test("an unknown identifier is undefined, at every step of a path", () => {
  assert.equal(value("nosuchroot", SNAPSHOT), undefined);
  assert.equal(value("player.nosuchfield", SNAPSHOT), undefined);
  assert.equal(value("player.nosuchfield.deeper", SNAPSHOT), undefined);
  assert.equal(value("party[99].name", SNAPSHOT), undefined);
  assert.equal(value("party[-1]", SNAPSHOT), undefined);
  assert.equal(value("player.health.x", SNAPSHOT), undefined, "a number has no fields");
});

test("a path reaches own properties only: nothing on a prototype and nothing callable", () => {
  // Keys can come from an expression — `player.buff[<name>]` is how `hasBuff` is spelled — so a
  // path is a place a definition could reach for the prototype chain if this were a plain lookup.
  assert.equal(value("player.constructor", SNAPSHOT), undefined);
  assert.equal(value('player["__proto__"]', SNAPSHOT), undefined);
  assert.equal(value("player.toString", SNAPSHOT), undefined);
  assert.equal(value("party.length", SNAPSHOT), undefined);
  // A view that carried a method would hand the renderer a function, and `String(fn)` is source
  // code on the screen.
  assert.equal(value("world.reload", { world: { reload: () => "boom" } }), undefined);

  // The same invariant one screen further down: `loc` reads a plain object literal, so the
  // prototype chain was reachable through it too. `loc("toString")` came back as
  // `Object.prototype.toString` — a live function, and truthy, so a condition that must never fire
  // fired — and `loc("__proto__")` came back as the prototype itself.
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(value(`loc("${key}")`), undefined, key);
  }
  assert.equal(value('loc("toString") ? 1 : 2'), 2, "a condition on a missing string takes the else");
  // A helper that answers with something that is not words is refused in the same way.
  assert.equal(value("spellName(1)", {}, { spellName: () => ({}) }), undefined);
  assert.equal(value('loc("X")', {}, { globalString: () => 5 }), undefined);
});

test("division by zero is undefined, and so is every arithmetic on something missing", () => {
  assert.equal(value("1 / 0"), undefined);
  assert.equal(value("1 % 0"), undefined);
  assert.equal(value("player.health / player.missing", SNAPSHOT), undefined);
  assert.equal(value("pct(1, 0)"), undefined, "pct is the division every window does");
  assert.equal(value("pct(player.health, player.maxHealth)", SNAPSHOT), (3140 / 4200) * 100);
  assert.equal(value("-player.missing", SNAPSHOT), undefined);
  assert.equal(value('"a" < 1'), undefined, "ordering across types has no answer");
  assert.equal(value("player.missing < 30", SNAPSHOT), undefined);
  assert.equal(value("player.missing < 30 ? 1 : 2", SNAPSHOT), 2, "and undefined is falsy");
});

test("undefined never reaches the screen as a word", () => {
  assert.equal(formatExpressionValue(undefined), "");
  assert.equal(formatExpressionValue(null), "");
  assert.equal(formatExpressionValue(Number.NaN), "");
  assert.equal(formatExpressionValue(Number.POSITIVE_INFINITY), "");
  assert.equal(formatExpressionValue({ a: 1 }), "", "never [object Object]");
  assert.equal(formatExpressionValue([1, 2]), "");
  assert.equal(formatExpressionValue(0), "0");
  assert.equal(formatExpressionValue("текст"), "текст");
  assert.equal(formatExpressionValue(true), "да");
  assert.equal(formatExpressionValue(false), "нет");
});

test("`+` poisons on a missing value; a template with a hole in it does not", () => {
  // Two different jobs. `+` is arithmetic that also concatenates, and a sum with an unknown term
  // has no answer; a template is text assembly, and a missing piece is simply absent.
  assert.equal(value('"уровень " + player.missing', SNAPSHOT), undefined);
  assert.equal(value('"уровень " + player.level', SNAPSHOT), "уровень 42");
  assert.equal(evaluate(parseTemplate("уровень {player.missing}").ast, SNAPSHOT), "уровень ");
  assert.equal(evaluate(parseTemplate("уровень {player.level}").ast, SNAPSHOT), "уровень 42");
});

/* ---------------------------------------------------------------------------------------------
 * The function table
 * ------------------------------------------------------------------------------------------- */

test("every function in the table does what its name says, and answers nothing for nothing", () => {
  assert.equal(value("floor(2.9)"), 2);
  assert.equal(value("ceil(2.1)"), 3);
  assert.equal(value("round(2.5)"), 3);
  assert.equal(value("abs(-4)"), 4);
  assert.equal(value("min(3, 1)"), 1);
  assert.equal(value("max(3, 1)"), 3);
  assert.equal(value("clamp(15, 0, 10)"), 10);
  assert.equal(value("clamp(-1, 0, 10)"), 0);
  assert.equal(value("clamp(5, 10, 0)"), undefined, "a backwards range has no answer");
  assert.equal(value("pct(1, 4)"), 25);
  assert.equal(value("fmt(1.239)"), "1");
  assert.equal(value("fmt(1.239, 2)"), "1.24");
  assert.equal(value("fmt(1, 99)"), undefined, "more decimals than a double has");
  assert.equal(value("money(1234567)"), "123з 45с 67м");
  assert.equal(value("money(0)"), "0м");
  assert.equal(value("time(65)"), "1:05");
  assert.equal(value("time(3661)"), "1:01:01");
  assert.equal(value("time(-5)"), "0:00");
  assert.equal(value("icon(133784)"), "/icons/133784.png");
  assert.equal(value("icon(0)"), undefined);
  assert.equal(value('icon("/icons/9.png")'), "/icons/9.png", "a string is handed back untouched");

  // Every one of them is undefined for a value that has not arrived.
  for (const name of ["floor", "ceil", "round", "abs", "min", "max", "money", "time", "icon", "fmt", "spellName", "itemName"]) {
    assert.equal(value(`${name}(player.missing)`, SNAPSHOT), undefined, name);
  }
  assert.equal(value("clamp(player.missing, 0, 1)", SNAPSHOT), undefined);
  assert.equal(value("pct(player.missing, 1)", SNAPSHOT), undefined);
});

test("loc reaches the generated global strings", withGlobalStrings, () => {
  // `loc` is the one function with a table behind it in this build, and the table is the realm's
  // own ruRU GlobalStrings.lua.
  const words = globalString("SPELL_FAILED_ALREADY_OPEN");
  assert.ok(words && words.length > 0, "the generated table has this string");
  assert.equal(value('loc("SPELL_FAILED_ALREADY_OPEN")'), words);
  assert.equal(value('loc("NO_SUCH_STRING_ANYWHERE")'), undefined);
  assert.equal(value("loc(5)"), undefined);
});

test("expression lookup helpers reach the session scope", () => {
  // `spellName`/`itemName` come from the session, so with no session they are simply empty rather
  // than an error — a definition written against a client that has them still loads here.
  assert.equal(value("spellName(133)"), undefined);
  assert.equal(value("spellName(133)", {}, { spellName: (id) => `заклинание ${id}` }), "заклинание 133");
  assert.equal(value("itemName(6948)", {}, { itemName: (id) => `предмет ${id}` }), "предмет 6948");
  assert.equal(value('loc("X")', {}, { globalString: () => "подменено" }), "подменено");
});

/* ---------------------------------------------------------------------------------------------
 * Templates and helpers
 * ------------------------------------------------------------------------------------------- */

test("a whole-brace value keeps its type; a mixed one becomes text", () => {
  // `enabled` has to come back as a boolean and `max` as a number, so one expression on its own is
  // not wrapped in text.
  assert.equal(evaluate(parseTemplate("{player.level > 10}").ast, SNAPSHOT), true);
  assert.equal(evaluate(parseTemplate("{player.maxHealth}").ast, SNAPSHOT), 4200);
  assert.equal(evaluate(parseTemplate("Кнопка").ast, SNAPSHOT), "Кнопка");
  assert.equal(evaluate(parseTemplate("{player.level} ур.").ast, SNAPSHOT), "42 ур.");
  assert.equal(parseTemplate("Уровень {player.level").ast, undefined, "an unclosed hole is a problem");
  assert.equal(parseTemplate("{floor(}").ast, undefined);

  assert.equal(isExpressionSource("{player.health}"), true);
  assert.equal(isExpressionSource(" {player.health} "), true);
  assert.equal(isExpressionSource("{a} и {b}"), false, "two holes are text, not one expression");
  assert.equal(isExpressionSource("{}"), false);
  assert.equal(isExpressionSource("текст"), false);
});

test("a path can be built from parts an expression could not spell", () => {
  // The studio's `valueFrom` names a widget id, and ids carry hyphens: `state.input-1` is a
  // subtraction, not a path.
  const node = pathNode("state", "input-1");
  assert.deepEqual(JSON.parse(JSON.stringify(node)), node);
  assert.equal(evaluate(node, SNAPSHOT), "17");
  // And the half of the contract that lets a comparison work at all: ordering "17" against 10 has
  // no answer here, which is why a box a packet or a condition reads is marked «только числа».
  assert.equal(value('state["input-1"] > 10', SNAPSHOT), undefined);
  assert.equal(value("state.qty > 10", SNAPSHOT), true);
  assert.deepEqual(literalNode(5), { node: "number", value: 5 });
  assert.deepEqual(literalNode(true), { node: "boolean", value: true });
  assert.equal(evaluate(ast('state["input-1"]'), SNAPSHOT), "17", "and brackets spell the same thing");
});

test("expressionRoots names every view an expression reads", () => {
  assert.deepEqual(expressionRoots(ast("player.health")), ["player"]);
  assert.deepEqual(expressionRoots(ast('target.exists ? target.name : world.zone')), ["target", "world"]);
  assert.deepEqual(expressionRoots(ast("party[state.row].name")), ["party", "state"], "a subscript counts too");
  assert.deepEqual(expressionRoots(ast("fmt(min(player.xp, setting.cap))")), ["player", "setting"]);
  assert.deepEqual(expressionRoots(ast("1 + 2")), []);
});

/* ---------------------------------------------------------------------------------------------
 * The budget
 * ------------------------------------------------------------------------------------------- */

/**
 * How long 10,000 evaluations of a representative expression may take.
 *
 * Measured on this machine (node 20.18), median of five timed loops after three warm-ups — the
 * median, not one sample, because the number this has to survive is measured under a *parallel*
 * suite and one descheduled loop is not a regression:
 *
 * * standalone `node --test tests/window-expression.test.mjs`, three sessions: **5.68 / 5.75 /
 *   5.84 ms**;
 * * the whole suite in parallel (`node --test tests`), four sessions: **12.88 / 12.03 / 13.86 /
 *   12.49 ms**, worst single sample 18.94;
 * * under `npm test` itself, three sessions: **13.34 / 14.70 / 13.10 ms**, worst sample 17.40.
 *
 * So the parallel run costs about 2.3x the standalone one on an idle machine, and a budget written
 * against the standalone figure would have been spending most of itself on scheduling. The budget
 * is **30 ms**: twice the worst median seen under `npm test`, and still well under the regression
 * it exists to catch — re-parsing the source on every evaluation measures **42.7 ms** for this same
 * loop standalone (5.55 ms without the re-parse), and more than that in parallel.
 *
 * 10,000 is the shape of the real load: the binding pass runs once a frame (М5), and a screen full
 * of module windows is on the order of a hundred bound values, so this is roughly a hundred frames
 * of the worst case in one go.
 */
const EVALUATION_BUDGET_MS = 30;

test("10,000 evaluations against one snapshot stay inside the measured budget", () => {
  const tree = ast('target.exists ? fmt(pct(target.health, target.maxHealth), 1) + "% " + target.name : "—"');
  assert.equal(evaluate(tree, SNAPSHOT), "38.7% Сварливый кабан");

  for (let warm = 0; warm < 3; warm++) for (let index = 0; index < 10_000; index++) evaluate(tree, SNAPSHOT);
  const samples = [];
  let last;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    for (let index = 0; index < 10_000; index++) last = evaluate(tree, SNAPSHOT);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const elapsed = samples[2];

  assert.equal(last, "38.7% Сварливый кабан");
  assert.ok(
    elapsed < EVALUATION_BUDGET_MS,
    `10,000 evaluations took ${elapsed.toFixed(2)} ms (samples ${samples.map((sample) => sample.toFixed(2)).join(", ")}),`
    + ` over the ${EVALUATION_BUDGET_MS} ms budget`,
  );
});
