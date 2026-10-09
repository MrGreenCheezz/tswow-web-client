// 05.10-A7b-7: the static GLSL checks of `tests/world-light-glsl.test.mjs` (A7b-0 review), as a
// helper other program tests can share: include expansion over three's chunks, a small C
// preprocessor, declarations, and a typer for plain GLSL ES 3.00 expressions. It cannot prove a
// driver links a program — that needs a browser (stage 14) — but it catches the classes of error
// that turn a frame white on reload: a name used before (or without) its declaration, a name
// declared twice, an int literal where a float is needed, a vector of the wrong width.
import assert from "node:assert/strict";
import * as THREE from "three";

export function resolveIncludes(source, depth = 0) {
  assert.ok(depth < 8, "include recursion");
  return source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    const chunk = THREE.ShaderChunk[name];
    assert.ok(chunk !== undefined, `unknown include <${name}>`);
    return resolveIncludes(chunk, depth + 1);
  });
}

export function preprocess(source, defines) {
  const macros = new Map(Object.entries(defines));
  const out = [];
  const stack = [];
  const active = () => stack.every((frame) => frame.on);
  const evaluate = (expression) => {
    let text = expression.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g,
      (_, a, b) => (macros.has(a ?? b) ? " 1 " : " 0 "));
    text = text.replace(/\b[A-Za-z_]\w*\b/g, (name) => {
      const value = macros.get(name);
      return value !== undefined && /^-?[\d.]+$/.test(value.trim()) ? value : "0";
    });
    assert.match(text, /^[\d\s.()<>=!&|+\-*]*$/, `unsupported #if expression: ${expression}`);
    return Boolean(Function(`return (${text});`)());
  };
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    const directive = /^#\s*(\w+)\s*(.*)$/.exec(line);
    if (!directive) {
      if (active()) out.push(raw);
      continue;
    }
    const [, word, rest] = directive;
    switch (word) {
      case "ifdef": stack.push({ on: macros.has(rest.trim()), done: macros.has(rest.trim()) }); break;
      case "ifndef": stack.push({ on: !macros.has(rest.trim()), done: !macros.has(rest.trim()) }); break;
      case "if": { const on = evaluate(rest); stack.push({ on, done: on }); break; }
      case "elif": { const top = stack.at(-1); const on = !top.done && evaluate(rest); top.on = on; top.done ||= on; break; }
      case "else": { const top = stack.at(-1); top.on = !top.done; top.done = true; break; }
      case "endif": assert.ok(stack.pop(), "unbalanced #endif"); break;
      case "define": if (active()) {
        const match = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest);
        macros.set(match[1], match[2] ? "fn" : match[3]);
      } break;
      case "undef": if (active()) macros.delete(rest.trim()); break;
      default: break;
    }
  }
  assert.equal(stack.length, 0, "unbalanced #if");
  return out;
}

export const TYPE_RE = "(?:float|int|bool|vec[234]|ivec[234]|mat[34]|sampler2D|sampler2DArray|samplerCube|[A-Z][A-Za-z0-9_]*)";
export const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

export function declarations(text) {
  const types = new Map();
  const re = new RegExp(`\\b(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*(?=[;=,()\\[])`, "g");
  for (const match of stripComments(text).matchAll(re)) types.set(match[2], match[1]);
  return types;
}

const BUILTINS = {
  normalize: (a) => a[0], length: () => "float", dot: () => "float", abs: (a) => a[0], pow: (a) => a[0],
  max: (a) => a[0], min: (a) => a[0], clamp: (a) => a[0], mix: (a) => a[0], smoothstep: (a) => a[2],
  floor: (a) => a[0], fract: (a) => a[0], cross: (a) => a[0], inversesqrt: (a) => a[0], sign: (a) => a[0],
  texture2D: () => "vec4", texture: () => "vec4",
};
const CONSTRUCTORS = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat3: 9, mat4: 16 };
const SWIZZLE = /^[xyzw]{1,4}$|^[rgba]{1,4}$|^[stpq]{1,4}$/;
const vecSize = (type) => (type === "float" ? 1 : /^vec([234])$/.test(type) ? Number(type[3]) : 0);
const vecOf = (n) => (n === 1 ? "float" : `vec${n}`);

/** The GLSL type of a plain expression; throws on an int operand, a width mismatch or an unknown name. */
export function typeOf(expression, variables) {
  const tokens = expression.match(/\d+\.\d*(?:e[+-]?\d+)?|\d*\.\d+(?:e[+-]?\d+)?|\d+|[A-Za-z_]\w*|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = (want) => {
    const token = tokens[at++];
    if (want !== undefined && token !== want) throw new Error(`expected ${want}, got ${token} in ${expression}`);
    return token;
  };
  const arithmetic = (left, right, op) => {
    if (left === "int" || right === "int") throw new Error(`int operand of ${op} in ${expression}`);
    if (left === right) return left;
    if (left === "float" && vecSize(right) > 1) return right;
    if (right === "float" && vecSize(left) > 1) return left;
    if (op === "*" && left === "mat4" && right === "vec4") return "vec4";
    if (op === "*" && left === "mat3" && right === "vec3") return "vec3";
    throw new Error(`${left} ${op} ${right} in ${expression}`);
  };
  const samplerCall = (token, args) => {
    if (token === "texture2D" && !(args[0] === "sampler2D" && args[1] === "vec2")) throw new Error(`texture2D(${args}) in ${expression}`);
    if (token === "texture" && !((args[0] === "sampler2D" && args[1] === "vec2") || (args[0] === "sampler2DArray" && args[1] === "vec3"))) {
      throw new Error(`texture(${args}) in ${expression}`);
    }
  };
  const primary = () => {
    const token = take();
    let type;
    if (token === "(") { type = sum(); take(")"); }
    else if (token === "-") type = primary();
    else if (/^\.?\d/.test(token)) type = /[.e]/.test(token) ? "float" : "int";
    else if (/^[A-Za-z_]/.test(token)) {
      if (peek() === "(") {
        take("(");
        const args = [];
        while (peek() !== ")") { args.push(sum()); if (peek() === ",") take(","); }
        take(")");
        if (args.includes("int")) throw new Error(`int argument to ${token} in ${expression}`);
        if (token in CONSTRUCTORS) {
          const total = args.reduce((n, arg) => n + (arg === "mat4" ? 16 : arg === "mat3" ? 9 : vecSize(arg)), 0);
          const want = CONSTRUCTORS[token];
          if (!(total === want || (args.length === 1 && total === 1) || (args.length === 1 && want < total))) {
            throw new Error(`${token}(${args.join(", ")}) in ${expression}`);
          }
          type = token;
        } else if (token in BUILTINS) {
          if (["min", "max"].includes(token) && !(args[1] === "float" || args[1] === args[0])) throw new Error(`${token}(${args}) in ${expression}`);
          if (token === "clamp" && !(args[1] === args[2] && (args[1] === "float" || args[1] === args[0]))) throw new Error(`clamp(${args}) in ${expression}`);
          if (token === "mix" && !(args[0] === args[1] && (args[2] === "float" || args[2] === args[0]))) throw new Error(`mix(${args}) in ${expression}`);
          if (token === "dot" && args[0] !== args[1]) throw new Error(`dot(${args}) in ${expression}`);
          if (token === "pow" && args[0] !== args[1]) throw new Error(`pow(${args}) in ${expression}`);
          if (token === "smoothstep" && !(args[0] === args[1] && (args[0] === "float" || args[0] === args[2]))) throw new Error(`smoothstep(${args}) in ${expression}`);
          if (token === "texture2D" || token === "texture") samplerCall(token, args);
          type = BUILTINS[token](args);
        } else throw new Error(`unknown function ${token} in ${expression}`);
      } else {
        type = variables.get(token);
        if (type === undefined) throw new Error(`undeclared identifier ${token} in ${expression}`);
      }
    } else throw new Error(`unexpected ${token} in ${expression}`);
    while (peek() === ".") {
      take(".");
      const swizzle = take();
      if (!SWIZZLE.test(swizzle) || vecSize(type) < 2) throw new Error(`.${swizzle} on ${type} in ${expression}`);
      type = vecOf(swizzle.length);
    }
    return type;
  };
  const product = () => {
    let type = primary();
    while (peek() === "*" || peek() === "/") { const op = take(); type = arithmetic(type, primary(), op); }
    return type;
  };
  const sum = () => {
    let type = product();
    while (peek() === "+" || peek() === "-") { const op = take(); type = arithmetic(type, product(), op); }
    return type;
  };
  const type = sum();
  if (at !== tokens.length) throw new Error(`trailing ${tokens.slice(at).join(" ")} in ${expression}`);
  return type;
}

/**
 * Types every plain declaration and assignment of `body` (lines) against `variables`; statements
 * with ternaries, comparisons, loops or calls the typer does not know are skipped by `skip`.
 * Returns { problems, checked }.
 */
export function typeCheck(body, variables, skip = (expression) => /[?<>[&|!]|==|getShadow|\bint\b/.test(expression)) {
  const problems = [];
  let checked = 0;
  const text = stripComments(body.join("\n")).replace(/[{}]/g, ";");
  for (const raw of text.split(";")) {
    const statement = raw.trim().replace(/^(?:if|for)\s*\(.*$/s, "");
    if (!statement) continue;
    const declaration = new RegExp(`^(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*=\\s*([\\s\\S]+)$`).exec(statement);
    const bare = new RegExp(`^(${TYPE_RE})\\s+([A-Za-z_]\\w*)$`).exec(statement);
    if (bare) { variables.set(bare[2], bare[1]); continue; }
    const assignment = /^([A-Za-z_]\w*)(?:\.[a-z]+)?\s*([+\-*]?=)\s*([\s\S]+)$/.exec(statement);
    try {
      if (declaration) {
        const [, type, name, expression] = declaration;
        if (!skip(expression)) {
          const got = typeOf(expression, variables);
          if (got !== type) throw new Error(`${type} ${name} = ${got}`);
          checked++;
        }
        variables.set(name, type);
      } else if (assignment && !skip(assignment[3])) {
        let target = variables.get(assignment[1]);
        if (target === undefined) throw new Error(`undeclared ${assignment[1]}`);
        const swizzle = /^[A-Za-z_]\w*\.([a-z]+)/.exec(statement)?.[1];
        if (swizzle) target = vecOf(swizzle.length);
        const value = typeOf(assignment[3], variables);
        if (!(value === target || (assignment[2] === "*=" && value === "float"))) {
          throw new Error(`${assignment[1]} (${target}) ${assignment[2]} ${value}`);
        }
        checked++;
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { problems, checked };
}

/**
 * Asserts that every identifier matching `prefix` in `body` is declared before use and only once,
 * counting the declarations found in `before` (uniforms, varyings, functions).
 */
export function assertDeclaredBeforeUse(before, body, prefix, label) {
  const declared = new Set(declarations(before).keys());
  const seen = new Set();
  const usePattern = new RegExp(`\\b${prefix}[A-Za-z0-9_]*\\b`, "g");
  for (const raw of body) {
    const line = stripComments(raw);
    const declaredHere = [...declarations(line).keys()];
    for (const name of declaredHere) {
      assert.ok(!seen.has(name), `${label}: ${name} declared twice`);
      seen.add(name);
    }
    if (/^\s*for\s*\(/.test(line)) for (const name of declaredHere) declared.add(name);
    const uses = line.replace(new RegExp(`\\b${TYPE_RE}\\s+(${prefix}\\w*)`, "g"), " ");
    for (const [name] of uses.matchAll(usePattern)) {
      assert.ok(declared.has(name), `${label}: ${name} used before declaration in «${line.trim()}»`);
    }
    for (const name of declaredHere) declared.add(name);
  }
  return seen;
}
