/**
 * The tiny expression language a module window is written in.
 *
 * A window definition is JSON a modder edits — `modules/<mod>/content/ui/*.json`, written by the
 * owner's content studio — and it has to be able to say "this bar follows the player's health" and
 * "this button is disabled below level ten". The obvious way to spell that is a string the client
 * evaluates, and the obvious way to evaluate a string is `eval` or `new Function`. Neither is on
 * the table: the file comes out of a directory a modder edits, the dev server ships no CSP at all,
 * and a definition that can reach `fetch` or `localStorage` is a definition that can do anything
 * the page can. So the language is parsed here, by hand, into **inert data** — plain objects with
 * no closures, no functions and no references to anything live, which is why the test asserts the
 * AST survives `JSON.parse(JSON.stringify(ast))` unchanged. Nothing an author writes ever becomes
 * code.
 *
 * The deliberately small grammar is:
 *
 * ```
 * expr    := ternary
 * ternary := or ( "?" expr ":" expr )?
 * or      := and ( "or" and )*
 * and     := cmp ( "and" cmp )*
 * cmp     := sum ( ("=="|"!="|"<"|"<="|">"|">=") sum )?
 * sum     := mul ( ("+"|"-") mul )*
 * mul     := unary ( ("*"|"/"|"%") unary )*
 * unary   := ("not"|"-")? primary
 * primary := number | string | "true" | "false" | path | call | "(" expr ")"
 * path    := ident ( "." ident | "[" expr "]" )*
 * call    := ident "(" (expr ("," expr)*)? ")"
 * ```
 *
 * `cmp` deliberately permits at most one comparison. Writing `( op sum )*` there instead
 * makes `0 < player.level < 100` legal: it groups as `(0 < player.level) < 100`, compares a boolean
 * with a number, and {@link compare} — which refuses to order across types on purpose — answers
 * `undefined` for every value of `player.level` there has ever been. A `then: hide` written that
 * way is a condition that can never fire and never complains, which is the opposite of what this
 * file is for, so a second comparison in one chain is refused at parse time and the message says
 * how to spell what the author meant.
 *
 * Two rules decide almost every design question below, and both are there so that a mistake in a
 * module shows up as a blank rather than as a lie on the screen:
 *
 * * **An unknown path is `undefined`.** Not an error, not a throw — the published state view grows
 *   over time and a window written against tomorrow's view should degrade, not explode.
 * * **`undefined` formats as the empty string.** The word "undefined" never reaches the screen.
 *   Division by zero is `undefined` for the same reason: a bar whose maximum has not arrived yet
 *   should be empty, not `NaN`.
 *
 * The function table is closed. `parse` refuses a call to anything outside it, by name, at load
 * time — so a module that names a function this client does not have fails when its author is
 * looking at it, not when a player presses the button.
 */

import { globalString } from "../../generated/globalStrings.js";
import { formatMoney } from "./Format.js";

/* ---------------------------------------------------------------------------------------------
 * The tree
 * ------------------------------------------------------------------------------------------- */

/** One step along a path: a fixed name, or a subscript that is itself an expression. */
export type PathStep = { readonly key: string } | { readonly at: ExprNode };

export type BinaryOperator =
  | "or" | "and"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "+" | "-" | "*" | "/" | "%";

/**
 * A parsed expression.
 *
 * Every node carries all of its fields — none is ever left `undefined` — because the round-trip
 * test compares the tree with `JSON.parse(JSON.stringify(tree))`, and `JSON.stringify` drops
 * `undefined` properties. Keeping the shape total is what makes that test able to fail.
 */
export type ExprNode =
  | { readonly node: "number"; readonly value: number }
  | { readonly node: "string"; readonly value: string }
  | { readonly node: "boolean"; readonly value: boolean }
  | { readonly node: "path"; readonly root: string; readonly steps: readonly PathStep[] }
  | { readonly node: "call"; readonly name: ExpressionFunction; readonly args: readonly ExprNode[] }
  | { readonly node: "unary"; readonly op: "not" | "-"; readonly operand: ExprNode }
  | { readonly node: "binary"; readonly op: BinaryOperator; readonly left: ExprNode; readonly right: ExprNode }
  | { readonly node: "ternary"; readonly test: ExprNode; readonly then: ExprNode; readonly otherwise: ExprNode }
  /** Text with `{…}` holes in it: the pieces, formatted and joined. */
  | { readonly node: "concat"; readonly parts: readonly ExprNode[] };

export interface ExpressionParse {
  /** Absent when anything at all went wrong: there is no half-parsed expression. */
  readonly ast?: ExprNode;
  readonly problems: readonly string[];
}

/* ---------------------------------------------------------------------------------------------
 * The closed function table
 * ------------------------------------------------------------------------------------------- */

/**
 * Every function an expression may call, and how many arguments each takes.
 *
 * `[min, max]`, with `max` at `Infinity` for the variadic pair. The arity is checked at parse time
 * rather than at evaluation time so that `clamp(x, 0)` is a load-time complaint naming the
 * function, not a silent `undefined` sixty times a second.
 */
const FUNCTION_ARITY = {
  floor: [1, 1], ceil: [1, 1], round: [1, 1], abs: [1, 1],
  min: [1, Infinity], max: [1, Infinity], clamp: [3, 3], pct: [2, 2],
  fmt: [1, 2], money: [1, 1], time: [1, 1], loc: [1, 1],
  icon: [1, 1], spellName: [1, 1], itemName: [1, 1],
} as const satisfies Record<string, readonly [number, number]>;

export type ExpressionFunction = keyof typeof FUNCTION_ARITY;

/** The table's names, in the order the plan lists them. For the module checker and the editor. */
export const EXPRESSION_FUNCTIONS: readonly ExpressionFunction[] =
  Object.keys(FUNCTION_ARITY) as ExpressionFunction[];

/**
 * The same table as a `Map`, and that is not a micro-optimisation.
 *
 * Looked up as `FUNCTION_ARITY[name]`, the table is not closed at all: `constructor`, `toString`
 * and `valueOf` all resolve through `Object.prototype` to something truthy, so `constructor(1)`
 * passed the "is this one of ours" check and then compared its argument count against `undefined`,
 * which is false both ways. A `Map` has no prototype chain to fall through.
 */
const FUNCTION_TABLE = new Map<string, readonly [number, number]>(
  Object.entries(FUNCTION_ARITY) as [string, readonly [number, number]][],
);

/**
 * What `spellName`, `itemName` and `loc` reach.
 *
 * They live on the *scope side* rather than in the tree so that the tree stays inert: a definition
 * carries the name of a function, never the function. `loc` defaults to the generated
 * `globalString` table — the realm's own words, in the realm's own locale — and the other two
 * default to nothing at all, because the metadata clients that answer them belong to the browser
 * session (М6 supplies them) and this module has to load in a bare node process.
 */
export interface ExpressionHelpers {
  readonly spellName?: (id: number) => string | undefined;
  readonly itemName?: (id: number) => string | undefined;
  readonly globalString?: (key: string) => string | undefined;
}

export type ExpressionScope = Readonly<Record<string, unknown>>;

/* ---------------------------------------------------------------------------------------------
 * Tokens
 * ------------------------------------------------------------------------------------------- */

type Token =
  | { readonly kind: "number"; readonly at: number; readonly value: number }
  | { readonly kind: "string"; readonly at: number; readonly value: string }
  | { readonly kind: "ident"; readonly at: number; readonly text: string }
  | { readonly kind: "punct"; readonly at: number; readonly text: string };

/** Longest first, so `==` is never read as two `=` and `<=` never as `<` then `=`. */
const PUNCTUATION = ["==", "!=", "<=", ">=", "(", ")", "[", "]", ",", ".", "?", ":", "+", "-", "*", "/", "%", "<", ">"];

/** The six the parser folds and the evaluator hands to {@link compare}. One list, read twice. */
const COMPARISONS: readonly string[] = ["==", "!=", "<", "<=", ">", ">="];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/**
 * How tall a tree this parser will build, counted in grammar levels and folded operands.
 *
 * A recursive-descent parser walks the JS stack, and the JSON it reads comes from a file this
 * client did not write; five hundred open parentheses would be a stack overflow rather than a
 * parse problem. One bracket costs the whole precedence cascade — expr, or, and, cmp, sum, mul,
 * unary, primary — so 256 levels is about thirty nested brackets, far past anything a person
 * writes by hand and a few hundred stack frames short of trouble.
 *
 * The limit is charged **per folded operand as well as per grammar level**, and that is the whole
 * point. Counting only levels bounds bracket nesting and nothing else: the precedence loops below
 * fold each extra operand inside a `while`, so `1+1+…` built a left-deep tree of unbounded height
 * while the guard sat at depth 8. Measured on this machine, `1+1+…` with **993 terms** (1,985
 * characters) parsed with no problems and then threw `RangeError` out of `JSON.stringify` — the
 * inertness test the whole design rests on — and 3,290 terms threw out of {@link evaluate} and
 * {@link expressionRoots}, both of which promise never to throw. Through the schema, a `text` field
 * holding 60,000 terms is 120 KB, well inside the 256 KiB a module file may be. Height is what the
 * recursive walkers cost, so height is what is bounded.
 */
const MAX_DEPTH = 256;

function tokenize(source: string, problems: string[]): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      index++;
      let text = "";
      let closed = false;
      while (index < source.length) {
        const next = source[index] as string;
        if (next === "\\" && index + 1 < source.length) {
          const escaped = source[index + 1] as string;
          text += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
          index += 2;
          continue;
        }
        if (next === char) {
          closed = true;
          index++;
          break;
        }
        text += next;
        index++;
      }
      if (!closed) {
        problems.push(`at ${start}: a quote is never closed`);
        return undefined;
      }
      tokens.push({ kind: "string", at: start, value: text });
      continue;
    }
    if (DIGIT.test(char)) {
      const start = index;
      while (index < source.length && DIGIT.test(source[index] as string)) index++;
      if (source[index] === "." && DIGIT.test(source[index + 1] ?? "")) {
        index++;
        while (index < source.length && DIGIT.test(source[index] as string)) index++;
      }
      const value = Number(source.slice(start, index));
      if (!Number.isFinite(value)) {
        problems.push(`at ${start}: "${source.slice(start, index)}" is not a number this client can hold`);
        return undefined;
      }
      tokens.push({ kind: "number", at: start, value });
      continue;
    }
    if (IDENT_START.test(char)) {
      const start = index;
      while (index < source.length && IDENT_PART.test(source[index] as string)) index++;
      tokens.push({ kind: "ident", at: start, text: source.slice(start, index) });
      continue;
    }
    const punct = PUNCTUATION.find((candidate) => source.startsWith(candidate, index));
    if (!punct) {
      problems.push(`at ${index}: "${char}" means nothing here`);
      return undefined;
    }
    tokens.push({ kind: "punct", at: index, text: punct });
    index += punct.length;
  }
  return tokens;
}

/* ---------------------------------------------------------------------------------------------
 * The parser
 * ------------------------------------------------------------------------------------------- */

class Parser {
  readonly #tokens: readonly Token[];
  readonly #problems: string[];
  #index = 0;
  #failed = false;

  constructor(tokens: readonly Token[], problems: string[]) {
    this.#tokens = tokens;
    this.#problems = problems;
  }

  get atEnd(): boolean {
    return this.#index >= this.#tokens.length;
  }

  /** Where the next unread token starts, for a complaint about what is left over. */
  get position(): number {
    return this.#where();
  }

  fail(text: string): undefined {
    // Only the first complaint is kept. Everything after a syntax error is guesswork, and a list
    // of six consequences of one missing bracket is worse for the author than the one cause.
    if (!this.#failed) this.#problems.push(text);
    this.#failed = true;
    return undefined;
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#index];
  }

  #where(): number {
    return this.#peek()?.at ?? this.#tokens[this.#tokens.length - 1]?.at ?? 0;
  }

  #isPunct(text: string): boolean {
    const token = this.#peek();
    return token !== undefined && token.kind === "punct" && token.text === text;
  }

  #isWord(text: string): boolean {
    const token = this.#peek();
    return token !== undefined && token.kind === "ident" && token.text === text;
  }

  #expect(text: string): boolean {
    if (this.#isPunct(text)) {
      this.#index++;
      return true;
    }
    this.fail(`at ${this.#where()}: expected "${text}"`);
    return false;
  }

  /**
   * True once the tree being built is taller than this parser is willing to walk.
   *
   * Called from the recursive descents *and* from every fold in the precedence loops, because a
   * folded operand raises the tree by one just as a bracket does. See {@link MAX_DEPTH}.
   */
  #tooDeep(depth: number): boolean {
    if (depth <= MAX_DEPTH) return false;
    this.fail(`at ${this.#where()}: the expression nests deeper than ${MAX_DEPTH}`);
    return true;
  }

  expr(depth: number): ExprNode | undefined {
    if (this.#tooDeep(depth)) return undefined;
    const test = this.#or(depth + 1);
    if (!test || !this.#isPunct("?")) return test;
    this.#index++;
    const then = this.expr(depth + 1);
    if (!then || !this.#expect(":")) return undefined;
    const otherwise = this.expr(depth + 1);
    return otherwise ? { node: "ternary", test, then, otherwise } : undefined;
  }

  #or(depth: number): ExprNode | undefined {
    let level = depth;
    let left = this.#and(level + 1);
    while (left && this.#isWord("or")) {
      if (this.#tooDeep(++level)) return undefined;
      this.#index++;
      const right = this.#and(level + 1);
      left = right ? { node: "binary", op: "or", left, right } : undefined;
    }
    return left;
  }

  #and(depth: number): ExprNode | undefined {
    let level = depth;
    let left = this.#cmp(level + 1);
    while (left && this.#isWord("and")) {
      if (this.#tooDeep(++level)) return undefined;
      this.#index++;
      const right = this.#cmp(level + 1);
      left = right ? { node: "binary", op: "and", left, right } : undefined;
    }
    return left;
  }

  /**
   * One comparison, and refusing the second is the point.
   *
   * `a < b < c` is legal in the plan's grammar and is a permanently dead condition here (see the
   * file header): it groups left, and ordering a boolean against a number has no answer. Refused
   * with the spelling the author meant, rather than left to be discovered by a rule that never
   * fires.
   */
  #cmp(depth: number): ExprNode | undefined {
    const left = this.#sum(depth + 1);
    if (!left) return undefined;
    const token = this.#peek();
    if (!token || token.kind !== "punct" || !COMPARISONS.includes(token.text)) return left;
    this.#index++;
    const right = this.#sum(depth + 1);
    if (!right) return undefined;
    const node: ExprNode = { node: "binary", op: token.text as BinaryOperator, left, right };
    const next = this.#peek();
    if (next && next.kind === "punct" && COMPARISONS.includes(next.text)) {
      return this.fail(
        `at ${next.at}: "${next.text}" would chain a second comparison onto the first, which is always`
        + ` undefined here; write it as two comparisons joined with "and"`,
      );
    }
    return node;
  }

  #sum(depth: number): ExprNode | undefined {
    let level = depth;
    let left = this.#mul(level + 1);
    while (left && (this.#isPunct("+") || this.#isPunct("-"))) {
      if (this.#tooDeep(++level)) return undefined;
      const op = this.#isPunct("+") ? "+" : "-";
      this.#index++;
      const right = this.#mul(level + 1);
      left = right ? { node: "binary", op, left, right } : undefined;
    }
    return left;
  }

  #mul(depth: number): ExprNode | undefined {
    let level = depth;
    let left = this.#unary(level + 1);
    while (left && (this.#isPunct("*") || this.#isPunct("/") || this.#isPunct("%"))) {
      if (this.#tooDeep(++level)) return undefined;
      const op = this.#isPunct("*") ? "*" : this.#isPunct("/") ? "/" : "%";
      this.#index++;
      const right = this.#unary(level + 1);
      left = right ? { node: "binary", op, left, right } : undefined;
    }
    return left;
  }

  /**
   * One prefix operator at most, exactly as the grammar in the plan is written.
   *
   * `not not x` and `- -x` are therefore parse errors rather than tautologies; both are spelled
   * with parentheses. This also means `not a == b` groups as `(not a) == b`, because `unary` binds
   * tighter than `cmp` — the same shape the grammar gives every other prefix language.
   */
  #unary(depth: number): ExprNode | undefined {
    if (this.#tooDeep(depth)) return undefined;
    if (this.#isWord("not") || this.#isPunct("-")) {
      const op = this.#isWord("not") ? "not" : "-";
      this.#index++;
      const operand = this.#primary(depth + 1);
      return operand ? { node: "unary", op, operand } : undefined;
    }
    return this.#primary(depth + 1);
  }

  #primary(depth: number): ExprNode | undefined {
    if (this.#tooDeep(depth)) return undefined;
    const token = this.#peek();
    if (!token) return this.fail(`at ${this.#where()}: the expression stops early`);
    if (token.kind === "number") {
      this.#index++;
      return { node: "number", value: token.value };
    }
    if (token.kind === "string") {
      this.#index++;
      return { node: "string", value: token.value };
    }
    if (this.#isPunct("(")) {
      this.#index++;
      const inner = this.expr(depth + 1);
      if (!inner || !this.#expect(")")) return undefined;
      return inner;
    }
    if (token.kind === "ident") {
      if (token.text === "true" || token.text === "false") {
        this.#index++;
        return { node: "boolean", value: token.text === "true" };
      }
      if (token.text === "and" || token.text === "or" || token.text === "not") {
        return this.fail(`at ${token.at}: "${token.text}" is an operator and cannot start a value`);
      }
      this.#index++;
      if (this.#isPunct("(")) return this.#call(token, depth);
      return this.#path(token.text, depth);
    }
    return this.fail(`at ${token.at}: unexpected "${token.kind === "punct" ? token.text : ""}"`);
  }

  #call(name: Token & { kind: "ident" }, depth: number): ExprNode | undefined {
    this.#index++; // the "("
    const args: ExprNode[] = [];
    if (!this.#isPunct(")")) {
      for (;;) {
        const argument = this.expr(depth + 1);
        if (!argument) return undefined;
        args.push(argument);
        if (!this.#isPunct(",")) break;
        this.#index++;
      }
    }
    if (!this.#expect(")")) return undefined;
    const arity = FUNCTION_TABLE.get(name.text);
    if (!arity) {
      // The whole point of a closed table: an author who writes `random()` hears about it when the
      // file loads, and never gets a window that half works.
      return this.fail(
        `at ${name.at}: "${name.text}" is not one of the functions this client has`
        + ` (${EXPRESSION_FUNCTIONS.join(", ")})`,
      );
    }
    if (args.length < arity[0] || args.length > arity[1]) {
      const wanted = arity[1] === Infinity
        ? `at least ${arity[0]}`
        : arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]} or ${arity[1]}`;
      return this.fail(`at ${name.at}: ${name.text}() takes ${wanted} argument(s), not ${args.length}`);
    }
    return { node: "call", name: name.text as ExpressionFunction, args };
  }

  #path(root: string, depth: number): ExprNode | undefined {
    const steps: PathStep[] = [];
    for (;;) {
      if (this.#isPunct(".")) {
        this.#index++;
        const next = this.#peek();
        if (!next || next.kind !== "ident") return this.fail(`at ${this.#where()}: a name has to follow "."`);
        this.#index++;
        steps.push({ key: next.text });
        continue;
      }
      if (this.#isPunct("[")) {
        this.#index++;
        const inner = this.expr(depth + 1);
        if (!inner || !this.#expect("]")) return undefined;
        // A literal subscript is folded into a plain key: `state["input-1"]` is how a widget id
        // with a hyphen in it is reached, and it should cost the same as `state.gold` at run time.
        steps.push(inner.node === "string" ? { key: inner.value } : { at: inner });
        continue;
      }
      break;
    }
    return { node: "path", root, steps };
  }
}

/**
 * Parses one expression — the text *inside* the braces, without them.
 *
 * Collects at most one problem, because a syntax error makes every later token guesswork.
 */
export function parseExpression(source: string): ExpressionParse {
  const problems: string[] = [];
  const tokens = tokenize(source, problems);
  if (!tokens) return { problems };
  if (tokens.length === 0) return { problems: ["the expression is empty"] };
  const parser = new Parser(tokens, problems);
  const ast = parser.expr(0);
  if (!ast) return { problems: problems.length ? problems : ["the expression could not be read"] };
  if (!parser.atEnd) {
    parser.fail(`at ${parser.position}: the expression is complete and then goes on`);
    return { problems };
  }
  return { ast, problems };
}

/** Whether a JSON string is meant as one expression rather than as text: `"{player.health}"`. */
export function isExpressionSource(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") && trimmed.length > 2 && !trimmed.slice(1, -1).includes("{");
}

/**
 * Parses a value that may be text, one expression, or text with expressions in it.
 *
 * Three shapes, and the difference between the first two matters:
 *
 * * `"Кнопка"` — a string. Stays a string.
 * * `"{player.level > 10}"` — one expression and nothing else, so the **value keeps its type**.
 *   `enabled` has to come back as a boolean and `max` as a number; wrapping either in text would
 *   turn every bar into a string comparison.
 * * `"Уровень {player.level}"` — text with holes, which is always a string. A hole whose value is
 *   missing contributes nothing, so the label reads "Уровень " rather than "Уровень undefined".
 *   That is deliberately unlike `+`, which poisons: `+` is arithmetic that happens to concatenate,
 *   and a sum with an unknown term has no answer.
 */
export function parseTemplate(source: string): ExpressionParse {
  if (!source.includes("{")) return { ast: { node: "string", value: source }, problems: [] };
  if (isExpressionSource(source)) return parseExpression(source.trim().slice(1, -1));

  const parts: ExprNode[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open < 0) {
      parts.push({ node: "string", value: source.slice(index) });
      break;
    }
    if (open > index) parts.push({ node: "string", value: source.slice(index, open) });
    const close = source.indexOf("}", open + 1);
    if (close < 0) return { problems: [`at ${open}: "{" is never closed`] };
    const inner = parseExpression(source.slice(open + 1, close));
    if (!inner.ast) return { problems: inner.problems };
    parts.push(inner.ast);
    index = close + 1;
  }
  return { ast: { node: "concat", parts }, problems: [] };
}

/* ---------------------------------------------------------------------------------------------
 * Building a tree without writing it out
 * ------------------------------------------------------------------------------------------- */

/** A constant, for the places where the schema knows the value and not the text. */
export function literalNode(value: string | number | boolean): ExprNode {
  if (typeof value === "string") return { node: "string", value };
  if (typeof value === "boolean") return { node: "boolean", value };
  return { node: "number", value: Number.isFinite(value) ? value : 0 };
}

/**
 * A path, from parts that may not be spellable.
 *
 * The studio's `valueFrom` names a widget id, and widget ids carry hyphens — `state.input-1` is a
 * subtraction, not a path. Built here, the step is a key and the hyphen is just a character.
 */
export function pathNode(root: string, ...keys: readonly string[]): ExprNode {
  return { node: "path", root, steps: keys.map((key) => ({ key })) };
}

/** Which roots a tree reads, so the module checker can say "this window names a view you removed". */
export function expressionRoots(ast: ExprNode): string[] {
  const found = new Set<string>();
  const walk = (node: ExprNode): void => {
    switch (node.node) {
      case "path":
        found.add(node.root);
        for (const step of node.steps) if ("at" in step) walk(step.at);
        return;
      case "call":
        for (const argument of node.args) walk(argument);
        return;
      case "concat":
        for (const part of node.parts) walk(part);
        return;
      case "unary":
        walk(node.operand);
        return;
      case "binary":
        walk(node.left);
        walk(node.right);
        return;
      case "ternary":
        walk(node.test);
        walk(node.then);
        walk(node.otherwise);
        return;
      default:
        return;
    }
  };
  walk(ast);
  return [...found].sort();
}

/* ---------------------------------------------------------------------------------------------
 * Evaluation
 * ------------------------------------------------------------------------------------------- */

/**
 * What counts as true.
 *
 * JavaScript's rule, not Lua's: `0` and `""` are false. The window definitions are JSON read by a
 * browser, every published value comes from JavaScript, and a bar whose value is `0` reading as
 * "true" would be a trap laid for whoever writes the first `{target.health}` condition.
 */
function truthy(value: unknown): boolean {
  return Boolean(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Only own properties of plain objects and arrays: nothing reaches a prototype through a path. */
function step(container: unknown, key: string | number): unknown {
  if (container === null || typeof container !== "object") return undefined;
  if (Array.isArray(container)) {
    const index = typeof key === "number" ? key : Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= container.length) return undefined;
    return container[index];
  }
  const name = String(key);
  if (!Object.prototype.hasOwnProperty.call(container, name)) return undefined;
  const value = (container as Record<string, unknown>)[name];
  // A published view holding a method would hand an expression a callable. It cannot call it —
  // there is no call-on-a-value in the grammar — but it could hand it back to the renderer as a
  // value, and `String(fn)` is source code on the screen.
  return typeof value === "function" ? undefined : value;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

function callFunction(name: ExpressionFunction, args: unknown[], helpers: ExpressionHelpers): unknown {
  const first = args[0];
  switch (name) {
    case "floor":
    case "ceil":
    case "round":
    case "abs": {
      const value = numberOf(first);
      if (value === undefined) return undefined;
      return name === "floor" ? Math.floor(value) : name === "ceil" ? Math.ceil(value) : name === "round" ? Math.round(value) : Math.abs(value);
    }
    case "min":
    case "max": {
      // Folded, not spread. `Math.min(...args)` puts every argument on the stack: measured here,
      // 100,000 of them still answer 1 and 130,000 throw `RangeError: Maximum call stack size
      // exceeded` — out of the one function in this file that promises never to throw, over a call
      // a definition file is free to write, since `min`/`max` are the two with no arity ceiling.
      let best: number | undefined;
      for (const argument of args) {
        const value = numberOf(argument);
        if (value === undefined) return undefined;
        if (best === undefined) best = value;
        else best = name === "min" ? Math.min(best, value) : Math.max(best, value);
      }
      return best;
    }
    case "clamp": {
      const value = numberOf(first);
      const low = numberOf(args[1]);
      const high = numberOf(args[2]);
      if (value === undefined || low === undefined || high === undefined || low > high) return undefined;
      return Math.min(high, Math.max(low, value));
    }
    case "pct": {
      const value = numberOf(first);
      const total = numberOf(args[1]);
      // The one arithmetic every window does, and the one that divides by a number the server has
      // not sent yet. Zero out means nothing known, not zero percent.
      if (value === undefined || total === undefined || total === 0) return undefined;
      return (value / total) * 100;
    }
    case "fmt": {
      const value = numberOf(first);
      if (value === undefined) return undefined;
      const digits = args.length > 1 ? numberOf(args[1]) : 0;
      if (digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 8) return undefined;
      return value.toFixed(digits);
    }
    case "money": {
      const value = numberOf(first);
      return value === undefined ? undefined : formatMoney(Math.max(0, Math.round(value)));
    }
    case "time": {
      const value = numberOf(first);
      return value === undefined ? undefined : formatDuration(value);
    }
    case "loc": {
      if (typeof first !== "string") return undefined;
      // The answer is checked, not trusted, and the reason is the same one that made the function
      // table a `Map`. `globalString` reads a plain object literal (`globalStrings.ts:13`), so
      // `loc("toString")` came back as `Object.prototype.toString` — a live function, truthy, so
      // `loc("toString") ? … : …` took the branch that must never be taken — and `loc("__proto__")`
      // came back as the prototype itself. Both are typed `string | undefined`, which is how they
      // got past the compiler and would have got past М5.
      const words = (helpers.globalString ?? globalString)(first);
      return typeof words === "string" ? words : undefined;
    }
    case "icon": {
      // The page serves its own icons at `/icons/<id>.png` (`ActionBar.ts:209`), and the published
      // view carries icon ids, not paths. A string is handed back untouched so that a definition
      // written against a view that later publishes paths keeps working.
      if (typeof first === "string") return first;
      const value = numberOf(first);
      return value === undefined || value <= 0 ? undefined : `/icons/${Math.floor(value)}.png`;
    }
    case "spellName":
    case "itemName": {
      const value = numberOf(first);
      if (value === undefined) return undefined;
      const lookup = name === "spellName" ? helpers.spellName : helpers.itemName;
      // Checked for the same reason as `loc`: these reach a metadata client this file never sees.
      const found = lookup?.(Math.floor(value));
      return typeof found === "string" ? found : undefined;
    }
    default:
      return undefined;
  }
}

function compare(op: BinaryOperator, left: unknown, right: unknown): unknown {
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;
  // Ordering only where ordering means something. `"5" < 10` is not a question with an answer, and
  // answering it would let a text field silently decide a condition.
  if (typeof left === "number" && typeof right === "number") {
    return op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : left >= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : left >= right;
  }
  return undefined;
}

function arithmetic(op: BinaryOperator, left: unknown, right: unknown): unknown {
  if (op === "+" && (typeof left === "string" || typeof right === "string")) {
    if (left === undefined || right === undefined || left === null || right === null) return undefined;
    return `${formatExpressionValue(left)}${formatExpressionValue(right)}`;
  }
  const a = numberOf(left);
  const b = numberOf(right);
  if (a === undefined || b === undefined) return undefined;
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    // Division by zero is `undefined`, not `Infinity`: a bar whose maximum has not arrived is
    // blank, and `Infinity` would draw it full.
    case "/": return b === 0 ? undefined : finite(a / b);
    case "%": return b === 0 ? undefined : finite(a % b);
    default: return undefined;
  }
}

function finite(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Evaluates a tree against one frozen snapshot of the published state.
 *
 * Total: it never throws, whatever the tree and whatever the scope. A window is drawn sixty times
 * a second from data that arrives out of order, and an exception in one label would take down the
 * frame that draws the rest of the interface.
 */
export function evaluate(ast: ExprNode, scope: ExpressionScope, helpers: ExpressionHelpers = {}): unknown {
  switch (ast.node) {
    case "number":
    case "string":
    case "boolean":
      return ast.value;
    case "path": {
      let value = step(scope, ast.root);
      for (const part of ast.steps) {
        if (value === undefined) return undefined;
        if ("key" in part) {
          value = step(value, part.key);
          continue;
        }
        const index = evaluate(part.at, scope, helpers);
        if (typeof index !== "number" && typeof index !== "string") return undefined;
        value = step(value, index);
      }
      return value;
    }
    case "call": {
      const args = ast.args.map((argument) => evaluate(argument, scope, helpers));
      return callFunction(ast.name, args, helpers);
    }
    case "unary": {
      if (ast.op === "not") return !truthy(evaluate(ast.operand, scope, helpers));
      const value = numberOf(evaluate(ast.operand, scope, helpers));
      return value === undefined ? undefined : -value;
    }
    case "binary": {
      const left = evaluate(ast.left, scope, helpers);
      // Short-circuit, and hand back the operand rather than a boolean, so that
      // `world.subzone or world.zone` reads as the fallback it looks like.
      if (ast.op === "and") return truthy(left) ? evaluate(ast.right, scope, helpers) : left;
      if (ast.op === "or") return truthy(left) ? left : evaluate(ast.right, scope, helpers);
      const right = evaluate(ast.right, scope, helpers);
      if (COMPARISONS.includes(ast.op)) return compare(ast.op, left, right);
      return arithmetic(ast.op, left, right);
    }
    case "ternary":
      return truthy(evaluate(ast.test, scope, helpers))
        ? evaluate(ast.then, scope, helpers)
        : evaluate(ast.otherwise, scope, helpers);
    case "concat": {
      let text = "";
      for (const part of ast.parts) text += formatExpressionValue(evaluate(part, scope, helpers));
      return text;
    }
    default:
      return undefined;
  }
}

/**
 * The words a value becomes on screen.
 *
 * Nothing here can produce "undefined", "null", "NaN" or "[object Object]". Those four strings are
 * what a half-arrived interface looks like when nobody wrote this function, and a player cannot
 * tell them from content.
 */
export function formatExpressionValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value === 0 ? 0 : value) : "";
  if (typeof value === "boolean") return value ? "да" : "нет";
  return "";
}
