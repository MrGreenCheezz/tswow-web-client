import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { SPELL_TEXT_PLAYER_NAMES, spellTextPlayerVariable, type SpellTextPlayer } from "./SpellTextPlayer.js";

/**
 * 12.10: `${…}` as Wow.exe 3.3.5a 12340 works it out (QuestTextParser.cpp, read 2026-10-12).
 *
 * 0x00579980 copies the text up to the first `}` (at most 255 characters), takes `.N` (N 1-9) after
 * the brace as the number of decimals (`%.0f` otherwise, 0x00a11668), compiles the text with a small
 * recursive-descent parser into an opcode list and runs it on a stack of floats (0x00578d10).
 *
 * The grammar (0x005778b0 sum, 0x005777f0 product, 0x005777a0 power, 0x00577530 operand), tokens
 * split after leading spaces on the characters of 0x00aceb2c (SEPARATORS below: brackets, `^`, the
 * four operators and `%`, `#`, `,`, `>` and the space):
 *
 *     sum     := product (('+' | '-') product)*         — an operator must follow without a space
 *     product := power (('*' | '/' | '%') operand ('^' operand)*)*
 *     power   := operand ('^' operand)*
 *     operand := '(' sum ')' | '-' operand | '$<' name '>' | '$' function '(' sum (',' sum)* ')'
 *              | '$' [spell id] name | number
 *
 * The operators read the character at the cursor itself (`*(char *)(cursor + text)`), so `$m1 + 2`
 * ends at the space and is `$m1`: what the client does, kept. `%` is 0x00577ad0's own formula,
 * `a - (a/b - floor(a/b)) * b`, which is floor(a/b)·b. Functions (0x00576b10, case-insensitive,
 * the table at 0x00ace898): abs ceil floor (1), min max gt lt gte lte eq (2: eq is |a-b| < 1e-4),
 * cond clamp (3: cond(a,b,c) is a ≠ 0 ? b : c, clamp(a,b,c) is min(max(a,b),c)). Names (0x00576b50,
 * case-sensitive, the table at 0x00ace8f8) are the spell's own columns below or the player's
 * (SpellTextPlayer.ts); `$12345name` reads another spell's row (opcode 1), and a row the client does
 * not have is an error. `$<name>` is a SpellDescriptionVariables value, 0 when undefined (0x005774d0).
 *
 * Any error — an unknown name, a token where the grammar has none, a missing row — fails the block:
 * 0x00579e50 returns 0 and 0x0057aaf0 writes `$` in its place. Without an active player 0x005782d0
 * reads every name as 0, the spell's own columns too.
 */

/** The spell columns 0x005782d0 reads. All optional: a gateway older than `v=18` lacks some. */
export type SpellTextRecord = Partial<Pick<SpellMetadata,
  "id" | "effectBasePoints" | "effectDieSides" | "effectPeriod" | "effectChainTargets" | "effectRadius"
  | "duration" | "maxDuration" | "procChance" | "procCharges" | "stackAmount" | "maxTargetLevel"
  | "maxAffectedTargets" | "effectMultipleValue" | "effectPointsPerCombo" | "effectDamageMultiplier"
  | "effectBonusMultiplier" | "procTypeMask" | "manaPerSecond" | "powerType" | "powerCost"
  | "powerCostPercent" | "effectMiscValue" | "attributes">>;

/** What evaluating a block needs from its caller. */
export interface SpellExpressionEnvironment {
  readonly spell: SpellTextRecord;
  /** Another row by id; undefined when the client has none (an error, as 0x00578d10 has it). */
  readonly row: (id: number) => SpellTextRecord | undefined | "pending";
  readonly player?: SpellTextPlayer;
  /** `$<name>` inside a block: the variable's float, 0 for one not defined (0x005774d0). */
  readonly variable: (name: string) => number;
  /** 0x00800a70's milliseconds for `$d` (shared with the prose marker). */
  readonly duration: (spell: SpellTextRecord) => number | undefined;
  /** `$c`'s power cost (0x008012f0), shared with the prose marker. */
  readonly cost: (spell: SpellTextRecord) => number | undefined;
}

/** What a block came to: a value, Wow.exe's error, or a column this gateway has not served. */
export type SpellExpressionResult =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "error" }
  | { readonly kind: "unavailable" };

const SEPARATORS = "()[]^*/%+-#,> ";

/** 0x00ace898: name, argument count; the opcode is 10 + the index. */
const FUNCTIONS = [
  ["abs", 1], ["ceil", 1], ["floor", 1], ["min", 2], ["max", 2], ["gt", 2], ["lt", 2], ["gte", 2],
  ["lte", 2], ["eq", 2], ["cond", 3], ["clamp", 3],
] as const;

/** The spell-side names of 0x00ace8f8 (both cases read the same column; `q` is always 0, see below). */
const SPELL_NAMES = new Set([
  "m1", "m2", "m3", "M1", "M2", "M3", "a1", "a2", "a3", "A1", "A2", "A3", "d", "D", "c", "C", "p", "P",
  "x1", "x2", "x3", "X1", "X2", "X3", "t1", "t2", "t3", "T1", "T2", "T3", "h", "H", "n", "N",
  "b1", "b2", "b3", "B1", "B2", "B3", "u", "U", "v", "V", "e1", "e2", "e3", "E1", "E2", "E3", "i", "I",
  "f1", "f2", "f3", "F1", "F2", "F3", "q1", "q2", "q3", "Q1", "Q2", "Q3", "bc1", "bc2", "bc3", "BC1", "BC2", "BC3",
]);

type Op =
  | { readonly op: "number"; readonly value: number }
  | { readonly op: "variable"; readonly value: number }
  | { readonly op: "name"; readonly name: string; readonly spellId?: number }
  | { readonly op: "negate" | "power" | "*" | "/" | "%" | "+" | "-" }
  | { readonly op: "function"; readonly name: string; readonly arguments: number };

class Unavailable extends Error {}

/** The compiler: 0x00577530 and its three callers over one body, building the opcode list. */
class Compiler {
  readonly ops: Op[] = [];
  error = false;
  at = 0;
  constructor(readonly text: string, readonly variable: (name: string) => number) {}

  /** 0x00576bb0: skip spaces, then one separator or a run of anything else. */
  token(): string | undefined {
    while (this.text[this.at] === " ") this.at++;
    if (this.at >= this.text.length) return undefined;
    const first = this.text[this.at]!;
    if (SEPARATORS.includes(first)) { this.at++; return first; }
    const start = this.at;
    while (this.at < this.text.length && !SEPARATORS.includes(this.text[this.at]!)) this.at++;
    return this.text.slice(start, this.at);
  }

  /** 0x00576c80: the next token must be this one (case-insensitively), or the block is in error. */
  expect(wanted: string): void {
    const token = this.token();
    if (token === undefined || token.toLowerCase() !== wanted) this.error = true;
  }

  sum(): void {
    this.product();
    for (let ch = this.text[this.at]; ch === "+" || ch === "-"; ch = this.text[this.at]) {
      this.at++;
      this.product();
      this.ops.push({ op: ch });
    }
  }

  product(): void {
    this.power();
    for (let ch = this.text[this.at]; ch === "*" || ch === "/" || ch === "%"; ch = this.text[this.at]) {
      this.at++;
      this.operand();
      while (this.text[this.at] === "^") {
        this.at++;
        this.operand();
        this.ops.push({ op: "power" });
      }
      this.ops.push({ op: ch });
    }
  }

  power(): void {
    this.operand();
    while (this.text[this.at] === "^") {
      this.at++;
      this.operand();
      this.ops.push({ op: "power" });
    }
  }

  operand(): void {
    const token = this.token();
    if (token === undefined) return;
    if (token === "(") { this.sum(); this.expect(")"); return; }
    if (token === "-") { this.operand(); this.ops.push({ op: "negate" }); return; }
    if (token.startsWith("$")) {
      const rest = token.slice(1);
      if (rest.startsWith("<")) {
        this.ops.push({ op: "variable", value: this.variable(rest.slice(1)) });
        this.expect(">");
        return;
      }
      const fn = FUNCTIONS.findIndex(([name]) => name === rest.toLowerCase());
      if (fn >= 0) {
        const [name, count] = FUNCTIONS[fn]!;
        this.expect("(");
        this.sum();
        for (let more = count - 1; more > 0; more--) {
          if (this.token() !== ",") this.error = true;
          this.sum();
        }
        this.ops.push({ op: "function", name, arguments: count });
        this.expect(")");
        return;
      }
      const digits = /^\d*/.exec(rest)![0];
      const name = rest.slice(digits.length);
      if (SPELL_NAMES.has(name) || SPELL_TEXT_PLAYER_NAMES.has(name)) {
        this.ops.push(digits ? { op: "name", name, spellId: Number(digits) } : { op: "name", name });
        return;
      }
      this.error = true;
      return;
    }
    if (!/^[\d.]/.test(token)) { this.error = true; return; }
    this.ops.push({ op: "number", value: Math.fround(Number.parseFloat(token) || 0) });
  }
}

/** One effect's signed min or max (0x007ff770 without the caster-level and spell-modifier parts). */
function effectValue(spell: SpellTextRecord, effect: number, max: boolean): number {
  const base = spell.effectBasePoints?.[effect];
  const sides = spell.effectDieSides?.[effect];
  if (base === undefined || sides === undefined) throw new Unavailable();
  return max ? base + Math.max(1, sides) : base + 1;
}

function column(values: readonly number[] | undefined, effect: number): number {
  const value = values?.[effect];
  if (value === undefined) throw new Unavailable();
  return value;
}

function scalar(value: number | undefined): number {
  if (value === undefined) throw new Unavailable();
  return value;
}

/** 0x005782d0 for a spell-side name, against `spell` (the description's row or a `$12345` one). */
function spellName(name: string, spell: SpellTextRecord, environment: SpellExpressionEnvironment): number {
  const effect = /\d$/.test(name) ? Math.min(2, Number(name.at(-1)) - 1) : 0;
  const stem = name.replace(/\d$/, "");
  switch (stem) {
    case "m": return effectValue(spell, effect, false);
    case "M": return effectValue(spell, effect, true);
    case "a": case "A": return column(spell.effectRadius, effect);
    // 0x00800a70 in milliseconds, times 0.001.
    case "d": case "D": return Math.fround(scalar(environment.duration(spell)) * Math.fround(0.001));
    case "c": case "C": return scalar(environment.cost(spell));
    case "p": case "P": return scalar(spell.manaPerSecond);
    case "x": case "X": return column(spell.effectChainTargets, effect);
    // The period in milliseconds, or 5000 for a spell whose ProcTypeMask has bit 0 (record +0x88).
    case "t": case "T": return (scalar(spell.procTypeMask) & 1) !== 0 ? 5000 : column(spell.effectPeriod, effect);
    case "h": case "H": return scalar(spell.procChance);
    case "n": case "N": return scalar(spell.procCharges);
    case "b": case "B": return column(spell.effectPointsPerCombo, effect);
    case "u": case "U": return scalar(spell.stackAmount);
    case "v": case "V": return scalar(spell.maxTargetLevel);
    case "e": case "E": return column(spell.effectMultipleValue, effect);
    case "i": case "I": return scalar(spell.maxAffectedTargets);
    case "f": case "F": return column(spell.effectDamageMultiplier, effect);
    // 0x005782d0's `q` case subtracts 0x57 from 0x5a…0x5f and so never reaches an index below 3:
    // every `$q` inside a block is 0 in the client. Kept.
    case "q": case "Q": return 0;
    case "bc": case "BC": return column(spell.effectBonusMultiplier, effect);
    default: throw new Unavailable();
  }
}

/** 0x00577900's twelve functions over their arguments, first argument first. */
function call(name: string, args: readonly number[]): number {
  const [a = 0, b = 0, c = 0] = args;
  switch (name) {
    case "abs": return Math.abs(a);
    case "ceil": return Math.ceil(a);
    case "floor": return Math.floor(a);
    case "min": return a < b ? a : b;
    case "max": return b < a ? a : b;
    case "gt": return a > b ? 1 : 0;
    case "lt": return a < b ? 1 : 0;
    case "gte": return a >= b ? 1 : 0;
    case "lte": return a <= b ? 1 : 0;
    case "eq": return Math.abs(Math.fround(a - b)) < Math.fround(1e-4) ? 1 : 0;
    case "cond": return a === 0 ? c : b;
    default: { // clamp
      const high = a < b ? b : a;
      return high < c ? high : c;
    }
  }
}

/** Evaluates a block's text (what is between `${` and the first `}`). */
export function evaluateSpellExpression(body: string, environment: SpellExpressionEnvironment): SpellExpressionResult {
  const compiler = new Compiler(body.slice(0, 255), environment.variable);
  compiler.sum();
  if (compiler.error) return { kind: "error" };
  const stack: number[] = [];
  const pop = (): number => stack.pop() ?? 0;
  try {
    for (const op of compiler.ops) {
      switch (op.op) {
        case "number": case "variable": stack.push(op.value); break;
        case "name": {
          let spell: SpellTextRecord = environment.spell;
          if (op.spellId !== undefined) {
            const row = environment.row(op.spellId);
            if (row === "pending") throw new Unavailable();
            if (row === undefined) return { kind: "error" };
            spell = row;
          }
          // No active player: 0x005782d0 answers 0 for every name before it looks at any.
          if (!environment.player) { stack.push(0); break; }
          const value = SPELL_NAMES.has(op.name)
            ? spellName(op.name, spell, environment)
            : spellTextPlayerVariable(op.name, environment.player);
          if (value === undefined) throw new Unavailable();
          stack.push(Math.fround(value));
          break;
        }
        case "negate": stack.push(Math.fround(-pop())); break;
        case "function": {
          const args: number[] = [];
          for (let index = 0; index < op.arguments; index++) args.unshift(pop());
          stack.push(Math.fround(call(op.name, args)));
          break;
        }
        default: {
          const b = pop();
          const a = pop();
          const value = op.op === "power" ? a ** b
            : op.op === "*" ? a * b
              : op.op === "/" ? a / b
                : op.op === "%" ? a - (Math.fround(a / b) - Math.floor(Math.fround(a / b))) * b
                  : op.op === "+" ? a + b : a - b;
          stack.push(Math.fround(value));
        }
      }
    }
  } catch (error) {
    if (error instanceof Unavailable) return { kind: "unavailable" };
    throw error;
  }
  return { kind: "value", value: Math.fround(stack.at(-1) ?? 0) };
}
