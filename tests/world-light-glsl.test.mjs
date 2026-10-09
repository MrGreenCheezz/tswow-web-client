// 05.10 review of A7b-0 (7.07): the world-light GLSL every lit world program installs, checked as far
// as Node can check it without a WebGL context — the 7.07 edit (terrain `max(N.L, 0)`, a separate
// `wowGradeNL`/`wowGradeAuthored` for the enhanced grade) was never compiled in a browser, and a
// compile error there is a white frame on reload.
//
// The real hooks run over three's own lambert/standard templates (terrain also through the splat
// hook, as `WorldRenderer3D` builds it), includes are expanded, a small C preprocessor keeps the
// active lines for each surface kind with and without shadow maps, and then, over the world-light
// body only:
//   * every `wow*` identifier is declared before use, and no name is declared twice in one program;
//   * every plain declaration/assignment is typed as GLSL ES 3.00 allows (no int literal where a
//     float is needed, no vec3 = float), statements with ternaries/loops/structs skipped;
//   * the program text does not depend on the lighting preset (quality is uniform-only), so the
//     enhanced and cinematic presets compile the same source as before the slice.
// What this does NOT prove: that a driver links it. That still needs a browser (stage 14, 14.25).

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  applyWorldLight, createWorldLightUniforms, setWorldLightImmersiveStrength,
} from "../dist/code/browser/WorldLighting.js";
import { applyTerrainSplat } from "../dist/code/browser/TerrainSplat.js";

function resolveIncludes(source, depth = 0) {
  assert.ok(depth < 8, "include recursion");
  return source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    const chunk = THREE.ShaderChunk[name];
    assert.ok(chunk !== undefined, `unknown include <${name}>`);
    return resolveIncludes(chunk, depth + 1);
  });
}

function preprocess(source, defines) {
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

const TYPE_RE = "(?:float|int|bool|vec[234]|ivec[234]|mat[34]|sampler2D|sampler2DArray|samplerCube|[A-Z][A-Za-z0-9_]*)";
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function declarations(text) {
  const types = new Map();
  const re = new RegExp(`\\b(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*(?=[;=,()\\[])`, "g");
  for (const match of stripComments(text).matchAll(re)) types.set(match[2], match[1]);
  return types;
}

const BUILTINS = {
  normalize: (a) => a[0], length: () => "float", dot: () => "float", abs: (a) => a[0], pow: (a) => a[0],
  max: (a) => a[0], min: (a) => a[0], clamp: (a) => a[0], mix: (a) => a[0], smoothstep: (a) => a[2],
};
const CONSTRUCTORS = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat3: 9, mat4: 16 };
const SWIZZLE = /^[xyzw]{1,4}$|^[rgba]{1,4}$|^[stpq]{1,4}$/;
const vecSize = (type) => (type === "float" ? 1 : /^vec([234])$/.test(type) ? Number(type[3]) : 0);
const vecOf = (n) => (n === 1 ? "float" : `vec${n}`);

function typeOf(expression, variables) {
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

const FRAGMENT_PREFIX = "uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; uniform bool receiveShadow;\n";

function material(kind) {
  const uniforms = createWorldLightUniforms();
  if (kind === "terrain") {
    const terrain = new THREE.MeshLambertMaterial({ color: 0x426b45 });
    applyWorldLight(terrain, uniforms, "terrain");
    applyTerrainSplat(terrain, {
      layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1),
      alpha: new THREE.Texture(),
      index: new THREE.Texture(),
    });
    return { material: terrain, uniforms, lib: THREE.ShaderLib.lambert };
  }
  const surface = new THREE.MeshStandardMaterial();
  applyWorldLight(surface, uniforms, kind);
  return { material: surface, uniforms, lib: THREE.ShaderLib.standard };
}

function fragment(kind, strength = 0) {
  const { material: target, uniforms, lib } = material(kind);
  setWorldLightImmersiveStrength(uniforms, strength);
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  target.onBeforeCompile(shader, {});
  return shader.fragmentShader;
}

/** Active lines of the world-light body (from the sun direction to the final diffuse write). */
function activeBody(kind, shadows) {
  const defines = { USE_FOG: "", NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: shadows ? "3" : "0" };
  if (shadows) defines.USE_SHADOWMAP = "";
  if (kind !== "terrain") defines.STANDARD = "";
  const lines = preprocess(resolveIncludes(FRAGMENT_PREFIX + fragment(kind)), defines);
  const start = lines.findIndex((line) => line.includes("vec3 wowViewSunDirection ="));
  const end = lines.findIndex((line) => line.includes("reflectedLight.directDiffuse = diffuseColor.rgb * pow( wowLight"));
  assert.ok(start > 0 && end > start, `${kind}: world-light body not found`);
  return { before: lines.slice(0, start).join("\n"), body: lines.slice(start, end + 1) };
}

const CASES = [];
for (const kind of ["terrain", "surface", "foliage"]) for (const shadows of [false, true]) CASES.push([kind, shadows]);

test("7.07 world-light body: every wow* name is declared once and before its use", () => {
  for (const [kind, shadows] of CASES) {
    const { before, body } = activeBody(kind, shadows);
    const declared = new Set(declarations(before).keys());
    const seen = new Map();
    for (const raw of body) {
      const line = stripComments(raw);
      const declaredHere = [...declarations(line).keys()];
      for (const name of declaredHere) {
        assert.ok(!seen.has(name), `${kind}/${shadows}: ${name} declared twice`);
        seen.set(name, true);
      }
      // Uses: the line without its own "type name" declarators; the initialiser may not read the new
      // name, except a `for` header's counter in its condition and step.
      if (/^\s*for\s*\(/.test(line)) for (const name of declaredHere) declared.add(name);
      const uses = line.replace(new RegExp(`\\b${TYPE_RE}\\s+(wow\\w*)`, "g"), " ");
      for (const [name] of uses.matchAll(/\bwow[A-Za-z0-9_]*\b/g)) {
        assert.ok(declared.has(name), `${kind}/${shadows}: ${name} used before declaration in «${line.trim()}»`);
      }
      for (const name of declaredHere) declared.add(name);
    }
    for (const name of ["wowNL", "wowGradeNL", "wowAuthoredLight", "wowGradeAuthored", "wowLight"]) {
      assert.ok(seen.has(name), `${kind}/${shadows}: ${name} missing`);
    }
  }
});

test("7.07 world-light body: plain statements type-check as GLSL ES 3.00 (float literals, vec widths)", () => {
  let checked = 0;
  for (const [kind, shadows] of CASES) {
    const { before, body } = activeBody(kind, shadows);
    const variables = declarations(before);
    variables.set("normal", "vec3");
    variables.set("vViewPosition", "vec3");
    variables.set("diffuseColor", "vec4");
    const problems = [];
    const text = stripComments(body.join("\n")).replace(/[{}]/g, ";");
    for (const raw of text.split(";")) {
      const statement = raw.trim().replace(/^(?:if|for)\s*\(.*$/s, "");
      if (!statement) continue;
      const declaration = new RegExp(`^(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*=\\s*([\\s\\S]+)$`).exec(statement);
      const bare = new RegExp(`^(${TYPE_RE})\\s+([A-Za-z_]\\w*)$`).exec(statement);
      if (bare) { variables.set(bare[2], bare[1]); continue; }
      const assignment = /^([A-Za-z_]\w*)\s*([+\-*]?=)\s*([\s\S]+)$/.exec(statement);
      const skip = (expression) => /[?<>[&|!]|==|getShadow|\bint\b/.test(expression);
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
          const target = variables.get(assignment[1]);
          if (target === undefined) throw new Error(`undeclared ${assignment[1]}`);
          const value = typeOf(assignment[3], variables);
          if (!(value === target || (assignment[2] === "*=" && value === "float"))) {
            throw new Error(`${assignment[1]} (${target}) ${assignment[2]} ${value}`);
          }
          checked++;
        }
      } catch (error) {
        problems.push(`${kind}/${shadows}: ${error.message}`);
      }
    }
    assert.deepEqual(problems, []);
  }
  assert.ok(checked > 100, `only ${checked} statements typed`);
});

test("7.07 the 7.07 statements themselves are among the typed ones (terrain, shadows on)", () => {
  const { body } = activeBody("terrain", true);
  const text = body.join("\n");
  for (const pattern of [
    /float wowNL = max\( wowDot, 0\.0 \);/,
    /float wowGradeNL = max\( abs\( wowDot \), 0\.2 \);/,
    /vec3 wowGradeAuthored = max\( wowAmbient \+ wowDiffuse \* \( wowGradeNL \* wowShadow \), vec3\( 0\.0 \) \);/,
  ]) assert.match(text, pattern);
  assert.doesNotMatch(text, /float wowGradeNL = wowNL;/, "terrain declares the grade N.L once, its own");
});

test("7.07 the program text is the same at every lighting preset (quality is uniform-only)", () => {
  for (const kind of ["terrain", "surface", "foliage"]) {
    const classic = fragment(kind, 0);
    assert.equal(fragment(kind, 0.65), classic, `${kind}: enhanced`);
    assert.equal(fragment(kind, 1), classic, `${kind}: cinematic`);
  }
});
