// 13.09 (pins9): the few text pins that stay — what behaviour cannot show without a whole renderer (an order inside
// one method, a guard on one call) — are written through these helpers, so a pin names the least text that says it:
// the call it guards and the terms of its condition, not a window of characters around them. A lane that moves,
// reformats or extends the surrounding lines does not break such a pin; one that drops the rule does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sources = new Map();

/** The text of a file under `src/`, read once per test process. */
export async function readSource(path) {
  let text = sources.get(path);
  if (text === undefined) {
    text = (await readFile(new URL(`../src/${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    sources.set(path, text);
  }
  return text;
}

/**
 * The body of one class member (`  #name(` or `  name(`, optionally `async`/`static`/`get`), from its declaration to
 * the class-level closing brace. Throws when the member is not there, so a renamed member fails loudly.
 */
export function memberSource(source, name) {
  const declaration = new RegExp(`\\n  (?:(?:private|public|static|async|override|get|set) )*${name.replace(/[#$]/g, "\\$&")}\\(`);
  const match = declaration.exec(source);
  assert.ok(match, `member ${name} is declared`);
  const start = match.index + 1;
  const end = source.indexOf("\n  }\n", start);
  assert.ok(end > start, `member ${name} has a body`);
  return source.slice(start, end + 5);
}

/** The text between the parentheses of `open` (the index of a `(`), balanced. */
function balanced(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error("unbalanced parentheses");
}

/** The top-level `&&` terms of a condition, each trimmed and with its whitespace collapsed. */
export function conditionTerms(condition) {
  const terms = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < condition.length; index++) {
    const char = condition[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (depth === 0 && condition.startsWith("&&", index)) {
      terms.push(condition.slice(from, index));
      from = index + 2;
      index++;
    }
  }
  terms.push(condition.slice(from));
  return terms.map((term) => term.replace(/\s+/g, " ").trim());
}

/**
 * The condition of the nearest `if (…)` whose statement holds `call` (the call text must occur once in `source`).
 * Pins a guard by its terms, so the order of the terms and the formatting are free.
 */
export function guardOf(source, call) {
  const at = source.indexOf(call);
  assert.ok(at >= 0, `the call ${call} is made`);
  assert.equal(source.indexOf(call, at + 1), -1, `the call ${call} is made once`);
  for (let open = source.lastIndexOf("if (", at); open >= 0; open = source.lastIndexOf("if (", open - 1)) {
    const condition = balanced(source, open + 3);
    const after = open + 3 + condition.length + 2;
    // The `if` holds the call when the call starts right after its condition (a single statement or a block).
    const between = source.slice(after, at);
    if (/^\s*(\{\s*)?(?:[\w.#]+ = )?$/.test(between) || /^\s*(?:[\w.#]+ = )?$/.test(between)) return conditionTerms(condition);
    if (at - open > 2000) break;
  }
  assert.fail(`no if (…) guards ${call}`);
}

/**
 * 15.11 (tests9): the arguments of the call `callee(` (it must occur once in `source`), split at top-level commas, each
 * without comments and with its whitespace collapsed. Pins what goes into a parameter by its position, whatever is added
 * after it or how the call is wrapped.
 */
export function callArguments(source, callee) {
  const at = source.indexOf(`${callee}(`);
  assert.ok(at >= 0, `the call ${callee}(…) is made`);
  assert.equal(source.indexOf(`${callee}(`, at + 1), -1, `the call ${callee}(…) is made once`);
  const inside = balanced(source, at + callee.length).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < inside.length; index++) {
    const char = inside[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (depth === 0 && char === ",") {
      parts.push(inside.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(inside.slice(from));
  return parts.map((part) => part.replace(/\s+/g, " ").trim()).filter((part, index, all) => part !== "" || index < all.length - 1);
}

/** The top-level `*` factors of an expression, each trimmed and with its whitespace collapsed. */
export function productFactors(expression) {
  const factors = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (depth === 0 && char === "*" && expression[index + 1] !== "*" && expression[index - 1] !== "*") {
      factors.push(expression.slice(from, index));
      from = index + 1;
    }
  }
  factors.push(expression.slice(from));
  return factors.map((factor) => factor.replace(/\s+/g, " ").trim());
}

/** Asserts that a guard holds every term in `terms` (it may hold more). */
export function assertGuard(source, call, terms, message) {
  const held = guardOf(source, call);
  for (const term of terms) assert.ok(held.includes(term), `${message}: the guard of ${call} holds ${term} (it holds ${held.join(" && ")})`);
}

/** Asserts that each needle occurs in `source`, in this order; returns their indices. */
export function assertOrder(source, needles, message) {
  const found = [];
  let from = 0;
  for (const needle of needles) {
    const at = typeof needle === "string" ? source.indexOf(needle, from) : searchFrom(source, needle, from);
    assert.ok(at >= 0, `${message}: ${String(needle)} follows ${found.length ? String(needles[found.length - 1]) : "the start"}`);
    found.push(at);
    from = at + 1;
  }
  return found;
}

/**
 * A value that absorbs anything a harnessed method does with a collaborator the test does not care about: every
 * property is another inert value, a call answers inert, it iterates as empty and reads as 0 / "" / false-ish in
 * comparisons (`x.size > 0` is false). Returned by {@link withInertFields} for each field a harness did not set.
 */
export const inert = new Proxy(function inertValue() {}, {
  get(_target, key) {
    if (key === Symbol.iterator) return function* empty() {};
    if (key === Symbol.toPrimitive) return (hint) => (hint === "string" ? "" : 0);
    if (key === "then") return undefined; // not a thenable: `await inert` is inert itself
    return inert;
  },
  apply: () => inert,
  construct: () => inert,
});

/**
 * 13.09 (pins9): a harness instance (a class built from the renderer's own method text) whose unset fields are
 * {@link inert}. A method harness checks the method's real behaviour on the fields the test sets; a collaborator a
 * later lane adds to the method (a new `this.#x.publish(…)`) no longer breaks every such harness with
 * "Cannot read properties of undefined". Fields the rule under test reads must still be set explicitly.
 */
export function withInertFields(instance) {
  return new Proxy(instance, {
    get(target, key, receiver) {
      if (key in target || typeof key === "symbol") return Reflect.get(target, key, receiver);
      return inert;
    },
  });
}

/**
 * 13.09 (pins9): a class of the named members of `className` in `source`, `#` stripped, compiled as they are — so a
 * test calls the method's real code. Module-level names the members use (imports, top-level functions and constants
 * of the file) are {@link inert} unless `dependencies` gives them; give every one the rule under test depends on.
 * Instances should go through {@link withInertFields}.
 */
export async function methodHarness(source, className, names, dependencies = {}) {
  const { default: ts } = await import("typescript");
  return methodHarnessWith(ts, source, className, names, dependencies);
}

/** {@link methodHarness} for a test that already holds `typescript` and builds its harness synchronously. */
export function methodHarnessWith(ts, source, className, names, dependencies = {}) {
  const parsed = ts.createSourceFile("source.ts", source, ts.ScriptTarget.ES2022, true);
  const owner = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(owner, `class ${className}`);
  const members = names.map((name) => {
    const member = owner.members.find((each) => each.name?.getText(parsed) === name);
    assert.ok(member, name);
    return member.getText(parsed).replaceAll("#", "");
  });
  const moduleNames = new Set();
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) moduleNames.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) moduleNames.add(element.name.text);
      else if (bindings) moduleNames.add(bindings.name.text);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      moduleNames.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) moduleNames.add(declaration.name.text);
      }
    }
  }
  moduleNames.delete(className);
  const body = ts.transpileModule(`class Harness { ${members.join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const deps = {};
  for (const name of moduleNames) if (new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)) deps[name] = inert;
  Object.assign(deps, dependencies);
  return Function(...Object.keys(deps), `${body}; return Harness;`)(...Object.values(deps));
}

function searchFrom(source, pattern, from) {
  const at = source.slice(from).search(pattern);
  return at < 0 ? -1 : from + at;
}
