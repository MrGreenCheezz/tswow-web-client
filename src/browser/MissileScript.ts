// 05.10-A7a-E (6.12): the motion scripts of SpellMissileMotion.dbc, run the way Wow.exe runs them.
//
// `SpellMissileMotion.ScriptBody` is Lua: 204 rows on this dataset, the longest 1,357 characters.
// What a script may read and write is fixed by two name tables in Wow.exe 3.3.5a 12340 (read-only):
//
// - inputs, 0x00ada7c0 (12 names, null-terminated): progress, time, missileIndex, missileCount,
//   distanceToFirePos, distanceToImpactPos, startDistance, totalDistance, rand1, rand2, rand3, spellID;
// - outputs, 0x00ada7f4 (12 names): transAngle, transMag, transRight, transFront, transUp, modelYaw,
//   modelPitch, modelRoll, speedAbs, speedScalar, speedOffset, scale.
//
// 0x006ff0a0 compiles a missile's script with both tables; 0x00700350 fills the twelve inputs as
// doubles, runs it, and turns every output that is not finite into 0 (so an output the script never
// assigned — nil — reads 0); when the run fails the missile drops its script for good (0x00701230
// sets the script handle to −1) and flies straight. This file keeps those rules:
//
// - only the subset the 204 scripts use is understood: numbers, `local`, assignment, `+ - * / % ^`,
//   unary minus, parentheses, `== ~= < <= > >=`, `and`/`or`/`not` over comparisons,
//   `if … then … elseif … else … end`, `;`, comments (`--` and `--[[ … ]]`), and the calls `sin`,
//   `cos` (degrees, as the scripts are written: `sin(time * wavesPerSec * 360)`) and `math.fmod`;
// - anything else — another statement, another function, a value-producing `and`/`or`, arithmetic on a
//   name that is neither an input nor assigned before it is read (Lua would raise on nil there) — is a
//   compile failure with a reason, and the caller treats the missile as having no motion, as Wow.exe
//   treats a script that raises. Reading such a name plainly (`transFront = distanceFromImpactPos`,
//   row 821) is not an error in Lua: the output becomes nil and reads 0.
//
// Not settled (listed, not guessed): whether outputs keep their previous run's value between frames
// (this file starts every run with all outputs nil, which the "not finite → 0" rule then reads as 0).
//
// Cost: a script compiles once into closures over one Float64Array; `evaluate` writes 24 numbers,
// runs the closures and allocates nothing.

/** Input names, in Wow.exe's order (0x00ada7c0). */
export const MISSILE_MOTION_INPUTS = Object.freeze([
  "progress", "time", "missileIndex", "missileCount", "distanceToFirePos", "distanceToImpactPos",
  "startDistance", "totalDistance", "rand1", "rand2", "rand3", "spellID",
] as const);

/** Output names, in Wow.exe's order (0x00ada7f4). */
export const MISSILE_MOTION_OUTPUTS = Object.freeze([
  "transAngle", "transMag", "transRight", "transFront", "transUp", "modelYaw", "modelPitch", "modelRoll",
  "speedAbs", "speedScalar", "speedOffset", "scale",
] as const);

export type MissileMotionInput = typeof MISSILE_MOTION_INPUTS[number];
export type MissileMotionOutput = typeof MISSILE_MOTION_OUTPUTS[number];

function indexOf<T extends string>(names: readonly T[]): Readonly<Record<T, number>> {
  const result = {} as Record<T, number>;
  names.forEach((name, index) => { result[name] = index; });
  return Object.freeze(result);
}

/** Slot of each input in the `inputs` array `evaluate` takes. */
export const MOTION_IN = indexOf(MISSILE_MOTION_INPUTS);
/** Slot of each output in the `outputs` array `evaluate` fills. */
export const MOTION_OUT = indexOf(MISSILE_MOTION_OUTPUTS);

const INPUTS = MISSILE_MOTION_INPUTS.length;
const OUTPUTS = MISSILE_MOTION_OUTPUTS.length;
const DEG = Math.PI / 180;

/** A compiled script. One environment per program: evaluation is synchronous and never re-entered. */
export interface MissileProgram {
  /** Bit `i` set when the script assigns output `i` somewhere. */
  readonly writes: number;
  /** Runs the script on `inputs` (12 numbers) and writes the 12 outputs, non-finite as 0. */
  evaluate(inputs: ArrayLike<number>, outputs: Float64Array): void;
}

export type MissileCompileResult =
  | { readonly ok: true; readonly program: MissileProgram }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------------------------
// Tokens

type Token =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "name"; readonly v: string }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "eof" };

class ScriptError extends Error {}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in", "local", "nil",
  "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const n = text.length;
  while (at < n) {
    const c = text[at]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { at++; continue; }
    if (c === "-" && text[at + 1] === "-") {
      // `--[[ … ]]` (any `=` level) or a line comment.
      const long = /^--\[(=*)\[/.exec(text.slice(at, at + 16));
      if (long) {
        const close = `]${long[1]}]`;
        const end = text.indexOf(close, at + long[0].length);
        at = end < 0 ? n : end + close.length;
      } else {
        const end = text.indexOf("\n", at);
        at = end < 0 ? n : end + 1;
      }
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && /[0-9]/.test(text[at + 1] ?? ""))) {
      const match = /^(?:0[xX][0-9a-fA-F]+|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at, at + 64));
      if (!match) throw new ScriptError(`bad number at ${at}`);
      tokens.push({ t: "num", v: Number(match[0]) });
      at += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let end = at + 1;
      while (end < n && /[A-Za-z0-9_]/.test(text[end]!)) end++;
      tokens.push({ t: "name", v: text.slice(at, end) });
      at = end;
      continue;
    }
    const two = text.slice(at, at + 2);
    if (two === "==" || two === "~=" || two === "<=" || two === ">=" || two === "..") {
      tokens.push({ t: "op", v: two });
      at += 2;
      continue;
    }
    if ("+-*/%^<>=(),;.[]{}#:\"'".includes(c)) {
      tokens.push({ t: "op", v: c });
      at++;
      continue;
    }
    throw new ScriptError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Compilation straight to closures: a number-valued and a boolean-valued expression kind, statements.

type Env = Float64Array;
type NumFn = (env: Env) => number;
type BoolFn = (env: Env) => boolean;
type StmtFn = (env: Env) => void;

type Expr =
  | { readonly kind: "num"; readonly fn: NumFn; readonly constant?: number }
  | { readonly kind: "bool"; readonly fn: BoolFn }
  /** A name with no value yet: Lua's nil. */
  | { readonly kind: "nil"; readonly name: string };

const FUNCTIONS: Readonly<Record<string, (args: NumFn[]) => NumFn>> = Object.freeze({
  sin: (args) => { const [a] = args; return (env) => Math.sin(a!(env) * DEG); },
  cos: (args) => { const [a] = args; return (env) => Math.cos(a!(env) * DEG); },
  // C fmod: the sign of the dividend, which is what JavaScript's `%` is.
  "math.fmod": (args) => { const [a, b] = args; return (env) => a!(env) % b!(env); },
});
const ARITY: Readonly<Record<string, number>> = Object.freeze({ sin: 1, cos: 1, "math.fmod": 2 });

/**
 * 05.10 review E: a name's entry in one of the tables above, own keys only — `constructor`, `toString`,
 * `__proto__` in a script are plain unassigned globals (nil), never Object.prototype members.
 */
function own<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

/**
 * 05.10 review E: Lua 5.1's parser limit (LUAI_MAXCCALLS, "chunk has too many syntax levels"): nested
 * parentheses, unary operators, `^` chains and blocks beyond it fail to compile, as they fail in Wow.exe.
 */
export const MISSILE_SCRIPT_MAX_LEVELS = 200;

class Compiler {
  readonly #tokens: Token[];
  #at = 0;
  /** Block scopes of locals, innermost last. */
  readonly #scopes: Map<string, number>[] = [new Map()];
  /** Globals that are neither input nor output, assigned somewhere (`speedscalar`, row 1503). */
  readonly #extras = new Map<string, number>();
  /** Outputs and extras assigned textually before the current point. */
  readonly #assigned = new Set<string>();
  #slots = INPUTS + OUTPUTS;
  /** 05.10 review E: current syntax nesting. */
  #levels = 0;
  writes = 0;

  constructor(text: string) {
    this.#tokens = tokenize(text);
  }

  get slots(): number {
    return this.#slots;
  }

  #peek(): Token {
    return this.#tokens[this.#at]!;
  }

  #next(): Token {
    return this.#tokens[this.#at++]!;
  }

  #isOp(value: string): boolean {
    const token = this.#peek();
    return token.t === "op" && token.v === value;
  }

  #isName(value: string): boolean {
    const token = this.#peek();
    return token.t === "name" && token.v === value;
  }

  #expectOp(value: string): void {
    if (!this.#isOp(value)) throw new ScriptError(`expected '${value}'`);
    this.#at++;
  }

  #expectName(value: string): void {
    if (!this.#isName(value)) throw new ScriptError(`expected '${value}'`);
    this.#at++;
  }

  #identifier(): string {
    const token = this.#next();
    if (token.t !== "name" || KEYWORDS.has(token.v)) throw new ScriptError("expected a name");
    return token.v;
  }

  program(): StmtFn {
    const body = this.#block();
    if (this.#peek().t !== "eof") throw new ScriptError(`unexpected '${describe(this.#peek())}'`);
    return body;
  }

  #block(): StmtFn {
    const statements: StmtFn[] = [];
    for (;;) {
      const token = this.#peek();
      if (token.t === "eof") break;
      if (token.t === "name" && (token.v === "end" || token.v === "else" || token.v === "elseif")) break;
      if (token.t === "op" && token.v === ";") { this.#at++; continue; }
      const statement = this.#statement();
      if (statement) statements.push(statement);
    }
    const list = statements;
    const count = list.length;
    if (count === 0) return () => {};
    if (count === 1) return list[0]!;
    return (env) => { for (let index = 0; index < count; index++) list[index]!(env); };
  }

  #statement(): StmtFn | undefined {
    const token = this.#peek();
    if (token.t !== "name") throw new ScriptError(`unexpected '${describe(token)}'`);
    if (token.v === "local") {
      this.#at++;
      const name = this.#identifier();
      if (this.#isOp(",")) throw new ScriptError("multiple assignment");
      let value: Expr | undefined;
      if (this.#isOp("=")) {
        this.#at++;
        value = this.#expression();
      }
      // The new local is visible only after its own initializer (`local x = x` reads the outer x).
      const slot = this.#slots++;
      this.#scopes[this.#scopes.length - 1]!.set(name, slot);
      return assign(slot, value);
    }
    if (token.v === "if") return this.#if();
    if (KEYWORDS.has(token.v)) throw new ScriptError(`unsupported statement '${token.v}'`);
    // Assignment to a name.
    const name = this.#identifier();
    if (this.#isOp(".") || this.#isOp("(") || this.#isOp("[") || this.#isOp(":")) {
      throw new ScriptError(`unsupported statement starting '${name}'`);
    }
    if (this.#isOp(",")) throw new ScriptError("multiple assignment");
    this.#expectOp("=");
    const value = this.#expression();
    const slot = this.#targetSlot(name);
    return assign(slot, value);
  }

  /** Where an assignment to `name` writes: a local, an input, an output or an extra global. */
  #targetSlot(name: string): number {
    const local = this.#local(name);
    if (local !== undefined) return local;
    const input = own(MOTION_IN, name);
    if (input !== undefined) return input;
    const output = own(MOTION_OUT, name);
    this.#assigned.add(name);
    if (output !== undefined) {
      this.writes |= 1 << output;
      return INPUTS + output;
    }
    let extra = this.#extras.get(name);
    if (extra === undefined) {
      extra = this.#slots++;
      this.#extras.set(name, extra);
    }
    return extra;
  }

  #local(name: string): number | undefined {
    for (let index = this.#scopes.length - 1; index >= 0; index--) {
      const slot = this.#scopes[index]!.get(name);
      if (slot !== undefined) return slot;
    }
    return undefined;
  }

  #scoped(): StmtFn {
    this.#enter();
    this.#scopes.push(new Map());
    try {
      return this.#block();
    } finally {
      this.#scopes.pop();
      this.#levels--;
    }
  }

  /** 05.10 review E: one syntax level deeper; past MISSILE_SCRIPT_MAX_LEVELS the script does not compile. */
  #enter(): void {
    if (++this.#levels > MISSILE_SCRIPT_MAX_LEVELS) throw new ScriptError("too many syntax levels");
  }

  #if(): StmtFn {
    const branches: { test: BoolFn; body: StmtFn }[] = [];
    let otherwise: StmtFn | undefined;
    this.#expectName("if");
    const first = this.#condition();
    this.#expectName("then");
    branches.push({ test: first, body: this.#scoped() });
    for (;;) {
      if (this.#isName("elseif")) {
        this.#at++;
        const test = this.#condition();
        this.#expectName("then");
        branches.push({ test, body: this.#scoped() });
        continue;
      }
      if (this.#isName("else")) {
        this.#at++;
        otherwise = this.#scoped();
      }
      this.#expectName("end");
      break;
    }
    const tests = branches.map((branch) => branch.test);
    const bodies = branches.map((branch) => branch.body);
    const count = tests.length;
    const fallback = otherwise;
    return (env) => {
      for (let index = 0; index < count; index++) {
        if (tests[index]!(env)) { bodies[index]!(env); return; }
      }
      fallback?.(env);
    };
  }

  /** A condition: a comparison, or a number (any number is true in Lua; nil is false). */
  #condition(): BoolFn {
    const value = this.#expression();
    if (value.kind === "bool") return value.fn;
    if (value.kind === "nil") return () => false;
    const fn = value.fn;
    return (env) => !Number.isNaN(fn(env));
  }

  // Precedence, lowest first (Lua 5.1): or < and < comparison < .. < + - < * / % < unary < ^.
  #expression(): Expr {
    this.#enter();
    try {
      return this.#or();
    } finally {
      this.#levels--;
    }
  }

  #or(): Expr {
    let left = this.#and();
    while (this.#isName("or")) {
      this.#at++;
      const right = this.#and();
      const a = boolOf(left, "or");
      const b = boolOf(right, "or");
      left = { kind: "bool", fn: (env) => a(env) || b(env) };
    }
    return left;
  }

  #and(): Expr {
    let left = this.#comparison();
    while (this.#isName("and")) {
      this.#at++;
      const right = this.#comparison();
      const a = boolOf(left, "and");
      const b = boolOf(right, "and");
      left = { kind: "bool", fn: (env) => a(env) && b(env) };
    }
    return left;
  }

  #comparison(): Expr {
    let left = this.#additive();
    for (;;) {
      const token = this.#peek();
      if (token.t !== "op" || !["==", "~=", "<", "<=", ">", ">="].includes(token.v)) return left;
      this.#at++;
      const right = this.#additive();
      const a = numOf(left, token.v);
      const b = numOf(right, token.v);
      let fn: BoolFn;
      switch (token.v) {
        case "==": fn = (env) => a(env) === b(env); break;
        case "~=": fn = (env) => a(env) !== b(env); break;
        case "<": fn = (env) => a(env) < b(env); break;
        case "<=": fn = (env) => a(env) <= b(env); break;
        case ">": fn = (env) => a(env) > b(env); break;
        default: fn = (env) => a(env) >= b(env); break;
      }
      left = { kind: "bool", fn };
    }
  }

  #additive(): Expr {
    let left = this.#multiplicative();
    for (;;) {
      if (this.#isOp("..")) throw new ScriptError("unsupported operator '..'");
      if (!this.#isOp("+") && !this.#isOp("-")) return left;
      const op = (this.#next() as { v: string }).v;
      const right = this.#multiplicative();
      const a = numOf(left, op);
      const b = numOf(right, op);
      left = num(op === "+" ? (env) => a(env) + b(env) : (env) => a(env) - b(env));
    }
  }

  #multiplicative(): Expr {
    let left = this.#unary();
    for (;;) {
      if (!this.#isOp("*") && !this.#isOp("/") && !this.#isOp("%")) return left;
      const op = (this.#next() as { v: string }).v;
      const right = this.#unary();
      const a = numOf(left, op);
      const b = numOf(right, op);
      if (op === "*") left = num((env) => a(env) * b(env));
      else if (op === "/") left = num((env) => a(env) / b(env));
      // Lua's `%`: a − floor(a / b) · b (the sign of the divisor).
      else left = num((env) => { const x = a(env); const y = b(env); return x - Math.floor(x / y) * y; });
    }
  }

  #unary(): Expr {
    this.#enter();
    try {
      return this.#unaryLevel();
    } finally {
      this.#levels--;
    }
  }

  #unaryLevel(): Expr {
    if (this.#isOp("-")) {
      this.#at++;
      const operand = this.#unary();
      const a = numOf(operand, "-");
      return num((env) => -a(env));
    }
    if (this.#isName("not")) {
      this.#at++;
      const operand = this.#unary();
      if (operand.kind === "nil") return { kind: "bool", fn: () => true };
      if (operand.kind === "num") {
        const fn = operand.fn;
        return { kind: "bool", fn: (env) => Number.isNaN(fn(env)) };
      }
      const fn = operand.fn;
      return { kind: "bool", fn: (env) => !fn(env) };
    }
    if (this.#isOp("#")) throw new ScriptError("unsupported operator '#'");
    return this.#power();
  }

  #power(): Expr {
    const base = this.#primary();
    if (!this.#isOp("^")) return base;
    this.#at++;
    // Right-associative and above unary minus on its left: -x^2 is -(x^2), 2^-1 is 2^(-1).
    const exponent = this.#unary();
    const a = numOf(base, "^");
    const b = numOf(exponent, "^");
    return num((env) => Math.pow(a(env), b(env)));
  }

  #primary(): Expr {
    const token = this.#next();
    if (token.t === "num") {
      const value = token.v;
      return { kind: "num", fn: () => value, constant: value };
    }
    if (token.t === "op" && token.v === "(") {
      const inner = this.#expression();
      this.#expectOp(")");
      return inner;
    }
    if (token.t === "name") {
      if (token.v === "true") return { kind: "bool", fn: () => true };
      if (token.v === "false") return { kind: "bool", fn: () => false };
      if (token.v === "nil") return { kind: "nil", name: "nil" };
      if (KEYWORDS.has(token.v)) throw new ScriptError(`unexpected '${token.v}'`);
      let name = token.v;
      while (this.#isOp(".")) {
        this.#at++;
        name += `.${this.#identifier()}`;
      }
      if (this.#isOp("(")) return this.#call(name);
      if (name.includes(".")) throw new ScriptError(`unsupported field '${name}'`);
      return this.#read(name);
    }
    throw new ScriptError(`unexpected '${describe(token)}'`);
  }

  #read(name: string): Expr {
    const local = this.#local(name);
    const input = own(MOTION_IN, name);
    let slot: number | undefined = local ?? input;
    if (slot === undefined && this.#assigned.has(name)) {
      const output = own(MOTION_OUT, name);
      slot = output !== undefined ? INPUTS + output : this.#extras.get(name);
    }
    if (slot === undefined) return { kind: "nil", name };
    const at = slot;
    return { kind: "num", fn: (env) => env[at]! };
  }

  #call(name: string): Expr {
    const make = own(FUNCTIONS, name);
    if (!make) throw new ScriptError(`unsupported function '${name}'`);
    this.#expectOp("(");
    const args: NumFn[] = [];
    if (!this.#isOp(")")) {
      for (;;) {
        args.push(numOf(this.#expression(), name));
        if (!this.#isOp(",")) break;
        this.#at++;
      }
    }
    this.#expectOp(")");
    if (args.length !== ARITY[name]) throw new ScriptError(`'${name}' takes ${ARITY[name]} argument(s)`);
    return num(make(args));
  }
}

function describe(token: Token): string {
  return token.t === "eof" ? "end of script" : String(token.v);
}

function num(fn: NumFn): Expr {
  return { kind: "num", fn };
}

/** A number operand; nil or a boolean in arithmetic is a run-time error in Lua, so a compile failure here. */
function numOf(expr: Expr, op: string): NumFn {
  if (expr.kind === "num") return expr.fn;
  if (expr.kind === "nil") throw new ScriptError(`'${op}' on nil '${expr.name}'`);
  throw new ScriptError(`'${op}' on a boolean`);
}

/** An `and`/`or` operand: only comparisons; Lua's value-returning form over numbers is not interpreted. */
function boolOf(expr: Expr, op: string): BoolFn {
  if (expr.kind === "bool") return expr.fn;
  throw new ScriptError(`value-producing '${op}'`);
}

function assign(slot: number, value: Expr | undefined): StmtFn {
  if (value === undefined || value.kind === "nil") return (env) => { env[slot] = Number.NaN; };
  if (value.kind === "bool") throw new ScriptError("a boolean assigned to a number");
  if (value.constant !== undefined) {
    const constant = value.constant;
    return (env) => { env[slot] = constant; };
  }
  const fn = value.fn;
  return (env) => { env[slot] = fn(env); };
}

/** Compiles one ScriptBody; a failure carries the reason and means "no motion". */
export function compileMissileScript(text: string): MissileCompileResult {
  try {
    const compiler = new Compiler(text);
    const run = compiler.program();
    const env = new Float64Array(compiler.slots);
    const writes = compiler.writes;
    const program: MissileProgram = {
      writes,
      evaluate(inputs, outputs) {
        for (let index = 0; index < INPUTS; index++) env[index] = inputs[index] ?? 0;
        // Outputs and extra globals start nil each run; locals are written before they are read.
        env.fill(Number.NaN, INPUTS);
        run(env);
        for (let index = 0; index < OUTPUTS; index++) {
          const value = env[INPUTS + index]!;
          outputs[index] = Number.isFinite(value) ? value : 0;
        }
      },
    };
    return { ok: true, program };
  } catch (error) {
    if (error instanceof ScriptError) return { ok: false, reason: error.message };
    // 05.10 review E: the text is data (a module may ship any SpellMissileMotion row); whatever else goes
    // wrong compiling it means "no motion", never an exception in the frame that launched the missile.
    return { ok: false, reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

const programs = new Map<string, MissileProgram | null>();

/** The compiled program of a script text, compiled once per text; undefined when it does not compile. */
export function missileProgram(text: string): MissileProgram | undefined {
  let program = programs.get(text);
  if (program === undefined) {
    const result = compileMissileScript(text);
    program = result.ok ? result.program : null;
    programs.set(text, program);
  }
  return program ?? undefined;
}
