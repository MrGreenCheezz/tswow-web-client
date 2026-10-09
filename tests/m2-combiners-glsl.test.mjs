// 05.10 review of A7a-F2 (6.22, 6.16е): the GLSL every resolved combiner program installs, checked
// as far as Node can check it without a WebGL context.
//
// For each program key the real `buildModel` produces (every stage pair, sphere bits, lit/unlit,
// opaque/blended so the fog step is chained too), the material's own hook runs over three's own
// templates; the includes are expanded the way `WebGLProgram` expands them, a prefix with three's
// built-in declarations and the material's defines is put in front, and a small preprocessor keeps
// the active lines. Then, over the statements the combiner step inserted:
//   * every identifier is declared before use (active declarations, snippet locals, GLSL built-ins);
//   * every expression is typed — scalar/vector mixing as GLSL ES 3.00 allows it, no int literal
//     where a float is needed, assignments of the declared type;
//   * the chunks it replaces are gone and its varying is declared once and written.
// What this does NOT prove: that a driver links the program (precision of each variable, varying
// packing limits, sampler units), or anything about other hooks' text beyond the declarations the
// snippet reads. That still needs a browser compile (lookdev / stage 14).

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { EVERY_GEOSET, buildModel } from "../dist/code/browser/ModelBuild.js";

// --- a tiny GLSL front end -------------------------------------------------------------------

const BUILTIN_FUNCTIONS = {
  normalize: (args) => args[0], length: () => "float", dot: () => "float",
  max: (args) => args[0], min: (args) => args[0], clamp: (args) => args[0], mix: (args) => args[0],
  texture2D: () => "vec4", texture: () => "vec4",
};
const CONSTRUCTORS = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat3: 9, mat4: 16 };
const TYPE_RE = "(?:float|int|bool|vec[234]|ivec[234]|mat[34]|sampler2D|samplerCube|[A-Z][A-Za-z0-9_]*)";

function resolveIncludes(source, depth = 0) {
  assert.ok(depth < 8, "include recursion");
  return source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    const chunk = THREE.ShaderChunk[name];
    assert.ok(chunk !== undefined, `unknown include <${name}>`);
    return resolveIncludes(chunk, depth + 1);
  });
}

/** Active lines of `source` under `defines` (name → value string), C-preprocessor style. */
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
      case "include": assert.fail(`unresolved ${line}`); break;
      default: break; // #version, #pragma, #extension
    }
  }
  assert.equal(stack.length, 0, "unbalanced #if");
  return { lines: out, macros };
}

/** `name → type` of every declaration in `text` (globals, locals, parameters; last one wins). */
function declarations(text) {
  const types = new Map();
  const re = new RegExp(`\\b(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*(?=[;=,()\\[])`, "g");
  for (const match of text.matchAll(re)) {
    if (["return", "else"].includes(match[1])) continue;
    types.set(match[2], match[1]);
  }
  return types;
}

const SWIZZLE = /^[xyzw]{1,4}$|^[rgba]{1,4}$|^[stpq]{1,4}$/;
const vecSize = (type) => (type === "float" ? 1 : /^vec([234])$/.test(type) ? Number(type[3]) : 0);
const vecOf = (n) => (n === 1 ? "float" : `vec${n}`);

/** Types one expression; throws on anything GLSL ES 3.00 would reject (as far as modelled). */
export function typeOf(expression, scope) {
  const tokens = expression.match(/\d+\.\d*(?:e[+-]?\d+)?|\d*\.\d+(?:e[+-]?\d+)?|\d+e[+-]?\d+|\d+|[A-Za-z_]\w*|\S/g) ?? [];
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
    if (op === "*" && left === "mat3" && right === "vec3") return "vec3";
    if (op === "*" && left === "mat4" && right === "vec4") return "vec4";
    throw new Error(`${left} ${op} ${right} in ${expression}`);
  };
  const primary = () => {
    const token = take();
    let type;
    if (token === "(") {
      type = sum();
      take(")");
    } else if (token === "-") {
      type = primary();
    } else if (/^\d/.test(token) || /^\.\d/.test(token)) {
      type = /[.e]/.test(token) ? "float" : "int";
    } else if (/^[A-Za-z_]/.test(token)) {
      if (peek() === "(") {
        take("(");
        const args = [];
        while (peek() !== ")") {
          args.push(sum());
          if (peek() === ",") take(",");
        }
        take(")");
        if (token in CONSTRUCTORS) {
          if (args.some((arg) => arg === "int")) throw new Error(`int argument to ${token} in ${expression}`);
          const total = args.reduce((n, arg) => n + (arg === "mat4" ? 16 : arg === "mat3" ? 9 : vecSize(arg)), 0);
          const want = CONSTRUCTORS[token];
          const matrixFromMatrix = token.startsWith("mat") && args.length === 1 && args[0].startsWith("mat");
          if (!(total === want || (args.length === 1 && total === 1) || matrixFromMatrix || (want < total && args.length === 1))) {
            throw new Error(`${token}(${args.join(", ")}) in ${expression}`);
          }
          type = token;
        } else if (token in BUILTIN_FUNCTIONS) {
          if (args.some((arg) => arg === "int")) throw new Error(`int argument to ${token} in ${expression}`);
          if (token === "clamp" && !(args[1] === "float" || args[1] === args[0])) throw new Error(`clamp bounds in ${expression}`);
          if ((token === "max" || token === "min") && !(args[1] === "float" || args[1] === args[0])) throw new Error(`${token} in ${expression}`);
          if (token === "dot" && args[0] !== args[1]) throw new Error(`dot(${args}) in ${expression}`);
          type = BUILTIN_FUNCTIONS[token](args);
        } else if (scope.functions.has(token)) {
          type = scope.functions.get(token);
        } else {
          throw new Error(`undeclared function ${token} in ${expression}`);
        }
      } else {
        type = scope.variables.get(token);
        if (type === undefined) throw new Error(`undeclared identifier ${token} in ${expression}`);
      }
    } else {
      throw new Error(`unexpected ${token} in ${expression}`);
    }
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
    while (peek() === "*" || peek() === "/") type = arithmetic(type, (take(), primary()), "*");
    return type;
  };
  const sum = () => {
    let type = product();
    while (peek() === "+" || peek() === "-") type = arithmetic(type, (take(), product()), "+");
    return type;
  };
  const type = sum();
  if (at !== tokens.length) throw new Error(`trailing ${tokens.slice(at).join(" ")} in ${expression}`);
  return type;
}

let checkedStatements = 0;

/** Checks the statements of `snippet` (active lines) against `context` declarations. */
export function checkStatements(snippet, scope) {
  const problems = [];
  const body = snippet.join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/[{}]/g, ";");
  for (const raw of body.split(";")) {
    const statement = raw.trim();
    if (!statement) continue;
    checkedStatements++;
    try {
      const declaration = new RegExp(`^(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*=\\s*([\\s\\S]+)$`).exec(statement);
      if (declaration) {
        const [, type, name, expression] = declaration;
        const got = typeOf(expression, scope);
        if (got !== type) throw new Error(`${type} ${name} = ${got}`);
        scope.variables.set(name, type);
        continue;
      }
      const varying = /^(?:varying|in|out)\s+(\w+)\s+(\w+)$/.exec(statement);
      if (varying) { scope.variables.set(varying[2], varying[1]); continue; }
      const assignment = /^([A-Za-z_]\w*(?:\.\w+)?)\s*([+\-*]?=)\s*([\s\S]+)$/.exec(statement);
      if (!assignment) throw new Error(`unparsed statement: ${statement}`);
      const target = typeOf(assignment[1], scope);
      const value = typeOf(assignment[3], scope);
      if (!(value === target || (assignment[2] === "*=" && value === "float"))) {
        throw new Error(`${assignment[1]} (${target}) ${assignment[2]} ${value}`);
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems;
}

// --- building the real materials ------------------------------------------------------------------

const SECOND_UV_SET = Float32Array.from([0, 0, 1, 0, 0, 1]);

function build(shaderId, { textures = [0, 1], blendMode = 0, unlit = false } = {}) {
  const model = {
    positions: new Float32Array(9), normals: new Float32Array(9),
    uv0: new Float32Array(6), uv1: SECOND_UV_SET, indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [{
      submesh: 0, blendMode, materialFlags: unlit ? 1 : 0, priorityPlane: 0, materialLayer: 0,
      textures, uvSets: textures.map((_, unit) => unit), shaderId, colorIndex: 0xffff, textureWeight: -1,
      textureTransform: -1,
    }],
    textures: [{ type: 0, flags: 0, path: "Spells\\Layer0.blp" }, { type: 0, flags: 0, path: "Spells\\Layer1.blp" }],
    attachments: [], bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 }, globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [], textureTransforms: [],
    shaderIdsResolved: true,
  };
  return buildModel(model, {
    modelPath: "Spells\\Test.m2", baseUrl: "http://127.0.0.1:8090",
    loadTexture: () => new THREE.Texture(), geosets: EVERY_GEOSET,
  }).materials[0];
}

const VERTEX_PREFIX = `
uniform mat4 modelMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform mat4 viewMatrix;
uniform mat3 normalMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic;
#ifdef USE_INSTANCING
attribute mat4 instanceMatrix;
#endif
attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
#ifdef USE_UV1
attribute vec2 uv1;
#endif
#ifdef USE_SKINNING
attribute vec4 skinIndex; attribute vec4 skinWeight;
#endif
`;
const FRAGMENT_PREFIX = `
uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic;
${THREE.ShaderChunk.colorspace_pars_fragment}
`;

/** The material's program as three would hand it to the driver, reduced to its active lines. */
function program(material, extraDefines = {}) {
  const lib = material.isMeshStandardMaterial ? THREE.ShaderLib.standard : THREE.ShaderLib.basic;
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {}, defines: {} };
  material.onBeforeCompile(shader, undefined);
  const defines = { ...extraDefines, texture2D: "fn", ...shader.defines };
  if (material.isMeshStandardMaterial) defines.STANDARD = "";
  if (material.map) { defines.USE_MAP = ""; defines.MAP_UV = material.map.channel === 1 ? "uv1" : "uv"; }
  if (material.alphaMap) {
    defines.USE_ALPHAMAP = "";
    defines.ALPHAMAP_UV = material.alphaMap.channel === 1 ? "uv1" : "uv";
    if (material.alphaMap.channel === 1) defines.USE_UV1 = "";
  }
  if (material.alphaTest > 0) defines.USE_ALPHATEST = "";
  return {
    raw: shader,
    vertex: preprocess(resolveIncludes(VERTEX_PREFIX + shader.vertexShader), defines),
    fragment: preprocess(resolveIncludes(FRAGMENT_PREFIX + shader.fragmentShader), defines),
  };
}

function scopeOf(lines) {
  const text = lines.join("\n");
  const variables = declarations(text);
  const functions = new Map();
  for (const match of text.matchAll(new RegExp(`\\b(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*\\([^;{]*\\)\\s*\\{`, "g"))) {
    functions.set(match[2], match[1]);
    variables.delete(match[2]);
  }
  return { variables, functions };
}

/** Lines `from` (inclusive) up to the line closing the brace block it opens, or matching `keep`. */
function fragmentSnippet(lines) {
  const start = lines.findIndex((line) => line.includes("/* wvm-combiner"));
  assert.ok(start >= 0, "the combiner block is active");
  let depth = 0;
  for (let index = start + 1; index < lines.length; index++) {
    depth += (lines[index].match(/\{/g) ?? []).length - (lines[index].match(/\}/g) ?? []).length;
    if (depth === 0) return { start, lines: lines.slice(start, index + 1) };
  }
  throw new Error("combiner block never closes");
}

function vertexSnippet(lines) {
  const start = lines.findIndex((line) => /\bwvm(ViewNormal|ObjectNormal)\b/.test(line));
  const end = lines.findIndex((line) => line.includes("vWvmSphereUv ="));
  assert.ok(start >= 0 && end >= start, "the sphere-map code is active");
  return { start, lines: lines.slice(start, end + 1) };
}

const VARIANTS = [{}, { USE_SKINNING: "" }, { USE_INSTANCING: "" }];

function auditMaterial(material, label) {
  const problems = [];
  for (const variant of VARIANTS) {
    const tag = `${label} ${material.customProgramCacheKey()} ${Object.keys(variant).join("+") || "plain"}`;
    const { raw, vertex, fragment } = program(material, variant);
    const frag = fragmentSnippet(fragment.lines);
    const fragScope = scopeOf(fragment.lines.slice(0, frag.start));
    for (const problem of checkStatements(frag.lines, fragScope)) problems.push(`${tag} [fragment] ${problem}`);
    const text = fragment.lines.join("\n");
    if (/sampledDiffuseColor/.test(text)) problems.push(`${tag} three's map_fragment still runs`);
    if (/texture2D\(\s*alphaMap,\s*vAlphaMapUv\s*\)\.g/.test(text)) problems.push(`${tag} three's alphamap_fragment still runs`);
    const sphere = raw.vertexShader.includes("vWvmSphereUv");
    if (sphere) {
      const vert = vertexSnippet(vertex.lines);
      const vertScope = scopeOf(vertex.lines.slice(0, vert.start));
      for (const problem of checkStatements(vert.lines, vertScope)) problems.push(`${tag} [vertex] ${problem}`);
      const declared = (lines) => lines.filter((line) => /^\s*varying\s+vec2\s+vWvmSphereUv\s*;/.test(line)).length;
      if (declared(vertex.lines) !== 1 || declared(fragment.lines) !== 1) problems.push(`${tag} vWvmSphereUv declared ≠ once`);
      if (!/vWvmSphereUv/.test(frag.lines.join("\n"))) problems.push(`${tag} sphere varying never read`);
    }
    for (const name of ["d", "t0", "t1", "wvmLit", "wvmSum", "wvmLitLinear"]) {
      if (fragment.macros.has(name)) problems.push(`${tag} a macro named ${name} rewrites the block`);
    }
  }
  return problems;
}

// --- tests ---------------------------------------------------------------------------------------

test("the GLSL checker itself rejects what GLSL ES 3.00 rejects (negative controls)", () => {
  const scope = () => ({
    variables: new Map([["t0", "vec4"], ["t1", "vec4"], ["d", "vec4"], ["diffuseColor", "vec4"], ["n", "mat3"]]),
    functions: new Map(),
  });
  assert.deepEqual(checkStatements(["vec3 a = clamp( t0.rgb * t1.rgb * d.rgb * 2.0, 0.0, 1.0 );"], scope()), []);
  assert.match(checkStatements(["vec3 a = t0.rgb * 2;"], scope())[0], /int operand/, "an int literal next to a vector");
  assert.match(checkStatements(["vec3 a = t0.rgb * missing;"], scope())[0], /undeclared identifier missing/);
  assert.match(checkStatements(["vec3 a = t0 * d.a;"], scope())[0], /vec3 a = vec4/, "vec4 into vec3");
  assert.match(checkStatements(["diffuseColor.a = t0.rgb;"], scope())[0], /float\) = vec3/);
  assert.match(checkStatements(["vec3 a = t0.rgb + t1.rg;"], scope())[0], /vec3 \+ vec2/);
  assert.match(checkStatements(["vec2 a = d.qx;"], scope())[0], /\.qx on vec4/, "swizzle sets do not mix");
  assert.match(checkStatements(["vec3 a = clamp( t0.rgb, 0, 1.0 );"], scope())[0], /int argument to clamp/);
  assert.match(checkStatements(["vec3 a = sRGBTransferEOTF( t0 ).rgb;"], scope())[0], /undeclared function sRGBTransferEOTF/);
  assert.deepEqual(checkStatements(["vec3 a = n * t0.rgb;"], scope()), [], "mat3 × vec3");
  // The preprocessor keeps only the active branch.
  const kept = preprocess("#ifdef A\nx\n#elif defined( B ) || defined( C )\ny\n#else\nz\n#endif", { C: "" }).lines;
  assert.deepEqual(kept, ["y"]);
});

test("every resolved combiner program's inserted GLSL is declared, typed and replaces three's chunks", () => {
  const id = (op0, op1, sphere0, sphere1) => ((op0 | (sphere0 ? 8 : 0)) << 4) | op1 | (sphere1 ? 8 : 0);
  const keys = new Set();
  const problems = [];
  let audited = 0;
  const before = checkedStatements;
  for (let op0 = 0; op0 < 8; op0++) for (let op1 = 0; op1 < 8; op1++) {
    for (const sphere0 of [false, true]) for (const sphere1 of [false, true]) {
      for (const textures of [[0], [0, 1]]) for (const unlit of [false, true]) for (const blendMode of [0, 2, 4]) {
        if (textures.length === 1 && (op1 !== 0 || sphere1)) continue;
        const material = build(id(op0, op1, sphere0, sphere1), { textures, unlit, blendMode });
        if (material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) continue; // three's own Mod
        const key = `${material.type}|${material.customProgramCacheKey()}|${material.alphaTest > 0}`;
        if (!key.includes("wvm-comb1-") || keys.has(key)) continue;
        keys.add(key);
        audited++;
        problems.push(...auditMaterial(material, `ids ${id(op0, op1, sphere0, sphere1).toString(16)}`));
      }
    }
  }
  const programKeys = new Set([...keys].map((key) => /wvm-comb1-[^|]+/.exec(key)[0]));
  // 18 two-stage programs + Mod_Mod fallback share names; with sphere bits and the -e variant the
  // corpus used 42 keys (05.10 census), all of which are among these.
  assert.ok(programKeys.size >= 42, `program keys covered: ${programKeys.size}`);
  assert.ok(audited >= programKeys.size);
  // Each material: 3 define variants × (≥ 7 fragment statements, + 4 vertex ones with a sphere).
  assert.ok(checkedStatements - before >= audited * 3 * 7, `statements checked: ${checkedStatements - before}`);
  assert.deepEqual(problems.slice(0, 20), [], `${problems.length} problems over ${audited} materials`);
});

test("the census's 42 program keys are all among the audited ones", () => {
  // `.runtime/re-2026-10-05/A7a-F2/probe-f2-programs.out.txt`, 05.10 — the keys the corpus reaches.
  const census = ["Opaque_Mod2x-01", "Mod-10", "Mod_Mod2x-00", "Mod_Mod-00", "Opaque_Mod2xNA-01", "Mod_Opaque-00",
    "Mod_Opaque-01", "Opaque_Add-01-e", "Mod_Mod2x-01", "Mod_Mod-01", "Opaque_Mod-01", "Opaque_Opaque-01",
    "Opaque_AddNA-00-e", "Opaque_AddNA-01-e", "Opaque_Add-00-e", "Mod2x-00", "Opaque_Add-01", "Opaque_Mod2x-00",
    "Mod_Add-00", "Mod_Mod2xNA-01", "Mod_Opaque-11", "Mod_AddNA-01", "Opaque-10", "Opaque-00", "Mod_Mod2xNA-00",
    "Opaque_Add-00", "Mod_AddNA-00", "Opaque_AddNA-01", "Opaque_Mod-00", "Mod_Add-00-e", "Opaque_Opaque-00",
    "Mod2x_Mod2x-01", "Opaque_Mod2xNA-00", "Mod_Mod-10", "Mod_Add-01", "Mod_Add-11-e", "Opaque_AddNA-00",
    "Add_Mod-01", "Mod_Mod2x-10", "Mod_Add-11", "Mod_AddNA-00-e"].map((key) => `wvm-comb1-${key}`);
  const id = (op0, op1, sphere0, sphere1) => ((op0 | (sphere0 ? 8 : 0)) << 4) | op1 | (sphere1 ? 8 : 0);
  const seen = new Set();
  for (let op0 = 0; op0 < 8; op0++) for (let op1 = 0; op1 < 8; op1++) for (const s0 of [false, true]) {
    for (const s1 of [false, true]) for (const textures of [[0], [0, 1]]) for (const unlit of [false, true]) {
      for (const blendMode of [0, 2]) {
        const key = /wvm-comb1-[^|]+/.exec(build(id(op0, op1, s0, s1), { textures, unlit, blendMode }).customProgramCacheKey())?.[0];
        if (key) seen.add(key);
      }
    }
  }
  assert.deepEqual(census.filter((key) => !seen.has(key)), []);
});
