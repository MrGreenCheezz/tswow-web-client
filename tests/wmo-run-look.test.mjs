// 05.10-A7b-2 (7.11 P1): what a WMO run's MOMT record changes about how it is drawn (`WmoRunLook.ts`),
// the cache key that keeps such a run its own material, and — because these programs are built
// for every Stormwind/Dalaran/ICC run on reload and a compile error there is a missing building —
// a static check of the GLSL the look adds over three's own templates, after the world light, the
// interior-room fog and the aerial fog have run, the way `#wmoRunMaterial` stacks them.
// What this does NOT prove: that a driver links it — that still needs a browser (14.24/14.25).

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "three";

import {
  WMO_RUN_LOOK_GLSL, applyWmoRunLook, wmoRunLook, wmoRunLookKey,
} from "../dist/code/browser/WmoRunLook.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { applyWmoInteriorFog, wmoRunMaterialCacheKey } from "../dist/code/browser/WorldRenderer3D.js";

const record = (shader, { flags = 0, sidn = [0, 0, 0, 0], texture2 = "" } = {}) => ({
  flags, shader, blendMode: 0, groundType: 0, sidnColour: sidn, diffColour: [0, 0, 0, 0], colour2: [0, 0, 0, 0], texture2,
});

test("a record's look: only what the client's programs change", () => {
  assert.equal(wmoRunLook(undefined, false, undefined), undefined, "no record (an artifact before v25)");
  assert.equal(wmoRunLook(record(0), false, undefined), undefined, "plain Diffuse");
  assert.equal(wmoRunLook(record(6), false, undefined), undefined, "Composite stays Diffuse (no second UV set)");
  assert.equal(wmoRunLook(record(0, { flags: 0x10 }), false, undefined), undefined, "a window flag with no colour");

  const window = wmoRunLook(record(0, { flags: 0x10, sidn: [255, 128, 0, 255] }), false, undefined);
  assert.deepEqual(window, { primaryAlpha: false, sidn: [1, 128 / 255, 0] });
  assert.equal(wmoRunLook(record(0, { flags: 0x10, sidn: [255, 128, 0, 255] }), true, undefined), undefined,
    "an interior run is drawn unlit: its programs have no emissive term");
  assert.equal(wmoRunLook(record(0, { sidn: [255, 128, 0, 255] }), false, undefined), undefined, "a colour without 0x10");

  // 05.10 review A7b-2: 1 Specular, 2 Metal, 4 Opaque (Wow.exe slot order; see the test below).
  for (const shader of [1, 2, 4]) assert.deepEqual(wmoRunLook(record(shader), false, undefined), { primaryAlpha: true });
  assert.deepEqual(wmoRunLook(record(5, { texture2: "a.blp" }), true, "http://g/texture?path=a.blp"),
    { primaryAlpha: true, env: { url: "http://g/texture?path=a.blp", metal: true } });
  assert.deepEqual(wmoRunLook(record(3), false, "u"), { primaryAlpha: true, env: { url: "u", metal: false } }); // 05.10 review A7b-2
  assert.deepEqual(wmoRunLook(record(5), false, ""), { primaryAlpha: true }, "no second texture: alpha only");

  assert.equal(wmoRunLookKey({ primaryAlpha: true }), "wmo-look-v1:a");
  assert.equal(wmoRunLookKey({ primaryAlpha: true, sidn: [1, 1, 1], env: { url: "u", metal: true } }), "wmo-look-v1:asm");
});

// 05.10 review A7b-2 (7.11): the MOMT shader index. Wow.exe loads the MapObj pixel programs by name
// into one array of handles at 0x00D1C3F0 (code at 0x007AFF1D-0x007AFF7C): Diffuse, Specular, Metal,
// Env, Opaque, EnvMetal at +0 to +0x14, Composite at +0x18 (`.runtime/re-2026-10-05/A7b-2-review/
// probe-shader-table.out.txt`). The corpus agrees: 191 of the 192 shader-3 records carry a second
// (environment) texture, and no record uses 4 (Opaque) - under the order 1 Opaque ... 4 Env, Env would
// be the unused one and "Metal" would carry environment maps.
test("MOMT shader ids follow the client's program table: 1 Specular, 2 Metal, 3 Env, 4 Opaque", async () => {
  const ids = await import("../dist/code/browser/WmoMaterials.js");
  assert.deepEqual(
    [ids.WMO_SHADER_DIFFUSE, ids.WMO_SHADER_SPECULAR, ids.WMO_SHADER_METAL, ids.WMO_SHADER_ENV, ids.WMO_SHADER_OPAQUE,
      ids.WMO_SHADER_ENV_METAL, ids.WMO_SHADER_COMPOSITE],
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(wmoRunLook(record(3, { texture2: "env.blp" }), false, "http://g/texture?path=env.blp"),
    { primaryAlpha: true, env: { url: "http://g/texture?path=env.blp", metal: false } }, "shader 3 samples its environment map");
});

test("a run with no look keeps the exact cache key it always had; a look makes its own material", () => {
  const old = JSON.stringify(["parent", "wmo-run", 3, "url", 1, 0x10, false]);
  assert.equal(wmoRunMaterialCacheKey("parent", 3, "url", 1, 0x10, false), old);
  assert.equal(wmoRunMaterialCacheKey("parent", 3, "url", 1, 0x10, false, undefined), old);
  const a = wmoRunMaterialCacheKey("parent", 3, "url", 1, 0x10, false, { record: 7, key: "wmo-look-v1:s" });
  const b = wmoRunMaterialCacheKey("parent", 3, "url", 1, 0x10, false, { record: 8, key: "wmo-look-v1:s" });
  assert.notEqual(a, old);
  assert.notEqual(a, b, "two window colours on one texture are two materials");
});

test("the renderer applies a look only when the run names a record that has one", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  #wmoRunMaterial("), source.indexOf("  #wmoEnvTexture("));
  assert.match(body, /const look = record === undefined\r?\n\s+\? undefined\r?\n\s+: wmoRunLook\(wmoRunMaterial\(model, run\), interior, model\.materialTextureUrls\?\.\[record\]\);/);
  assert.match(body, /look === undefined \? undefined : \{ record: record!, key: wmoRunLookKey\(look\) \}/);
  assert.match(body, /if \(look\) \{ \/\/ 05\.10-A7b-2 \(7\.11 P1\)\r?\n\s+applyWmoRunLook\(value, look, \{ daylight: this\.#worldLight\.wowDaylight \},/);
  // Before the world light and the room fog wrap it: their hooks run first, the look's after.
  assert.ok(body.indexOf("applyWmoRunLook(") < body.indexOf("applyWmoInteriorFog(value"));
  assert.ok(body.indexOf("applyWmoRunLook(") < body.indexOf("applyWorldLight(value"));
});

test("a look with nothing for its material installs no hook", () => {
  const basic = new THREE.MeshBasicMaterial();
  const compile = basic.onBeforeCompile;
  const key = basic.customProgramCacheKey();
  applyWmoRunLook(basic, { primaryAlpha: false, sidn: [1, 0, 0] }, { daylight: { value: 1 } }, undefined);
  assert.equal(basic.onBeforeCompile === compile, true, "a glow on an unlit run is not drawn");
  assert.equal(basic.customProgramCacheKey(), key);
  applyWmoRunLook(basic, { primaryAlpha: false, env: { url: "u", metal: false } }, { daylight: { value: 1 } }, undefined);
  assert.equal(basic.onBeforeCompile === compile, true, "an environment map with no texture to sample");
});

// ---- static GLSL ---------------------------------------------------------------------------------

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

const TYPE_RE = "(?:float|int|bool|vec[234]|ivec[234]|mat[34]|sampler2D|samplerCube|[A-Z][A-Za-z0-9_]*)";
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
function declarations(text) {
  const types = new Map();
  const re = new RegExp(`\\b(${TYPE_RE})\\s+([A-Za-z_]\\w*)\\s*(?=[;=,()\\[])`, "g");
  for (const match of stripComments(text).matchAll(re)) types.set(match[2], match[1]);
  return types;
}
const NOT_NAMES = new Set([
  "float", "int", "bool", "vec2", "vec3", "vec4", "mat3", "mat4", "uniform", "varying", "attribute", "sampler2D",
  "if", "else", "for", "return", "normalize", "dot", "pow", "min", "max", "clamp", "mix", "texture2D", "smoothstep",
  "length", "abs", "gl_FragColor", "gl_Position", "true", "false",
]);

/** three's own prefixes, as far as the looked-at lines need them. */
const FRAGMENT_PREFIX = "uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; uniform bool receiveShadow;\n";
const VERTEX_PREFIX = "uniform mat4 modelMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform mat4 viewMatrix;"
  + " uniform mat3 normalMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic;"
  + " attribute vec3 position; attribute vec3 normal; attribute vec2 uv;\n";

/** Every identifier on a look line is declared above it in the active program, and none twice. */
function checkLookLines(lines, label) {
  const lookLines = [];
  const seen = new Map();
  for (let index = 0; index < lines.length; index++) {
    const line = stripComments(lines[index]);
    for (const [name] of declarations(line)) {
      if (/^v?[wW]owWmo/.test(name)) {
        assert.ok(!seen.has(name), `${label}: ${name} declared twice`);
        seen.set(name, index);
      }
    }
    if (!/\b[vV]?[wW]owWmo\w*/.test(line) && !/wowWmo/.test(line)) continue;
    if (/^\s*(uniform|varying)\b/.test(line)) continue;
    lookLines.push(line.trim());
    const above = declarations(FRAGMENT_PREFIX + VERTEX_PREFIX + lines.slice(0, index).join("\n"));
    const own = declarations(line);
    const uses = line.replace(new RegExp(`\\b${TYPE_RE}\\s+([A-Za-z_]\\w*)`, "g"), " ");
    for (const [name] of uses.matchAll(/(?<![.\w])[A-Za-z_]\w*/g)) {
      if (NOT_NAMES.has(name) || own.has(name) && false) continue;
      assert.ok(above.has(name), `${label}: «${name}» used before any declaration in «${line.trim()}»`);
    }
  }
  return lookLines;
}

function composed(material, lib) {
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return shader;
}

const daylight = { value: 1 };
const environment = new THREE.Texture();

function litRun(look) {
  const value = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  applyWmoRunLook(value, look, { daylight }, look.env ? environment : undefined);
  applyWorldLight(value, createWorldLightUniforms(), "surface");
  return composed(value, THREE.ShaderLib.standard);
}

function roomRun(look) {
  const value = new THREE.MeshBasicMaterial({ map: new THREE.Texture(), vertexColors: true });
  applyWmoRunLook(value, look, { daylight }, look.env ? environment : undefined);
  applyWmoInteriorFog(value, { colour: { value: new THREE.Color() }, near: { value: 1 }, far: { value: 2 } });
  return composed(value, THREE.ShaderLib.basic);
}

const LOOKS = [
  { primaryAlpha: true },
  { primaryAlpha: false, sidn: [1, 0.5, 0.25] },
  { primaryAlpha: true, env: { url: "u", metal: false } },
  { primaryAlpha: true, env: { url: "u", metal: true } },
  { primaryAlpha: true, sidn: [1, 1, 1], env: { url: "u", metal: true } },
];

test("look GLSL over the lit (standard + world light) template: names declared before use", () => {
  for (const look of LOOKS) {
    const shader = litRun(look);
    for (const marker of ["#include <map_fragment>", "#include <opaque_fragment>", "#include <aomap_fragment>"]) {
      assert.equal(shader.fragmentShader.split(marker).length - 1, 1, `${wmoRunLookKey(look)}: ${marker}`);
    }
    assert.equal(shader.vertexShader.split("#include <fog_vertex>").length - 1, 1);
    for (const shadows of [false, true]) {
      const defines = { USE_FOG: "", USE_MAP: "", STANDARD: "", NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: shadows ? "3" : "0" };
      if (shadows) defines.USE_SHADOWMAP = "";
      const fragment = preprocess(resolveIncludes(FRAGMENT_PREFIX + shader.fragmentShader), defines);
      const lines = checkLookLines(fragment, `lit ${wmoRunLookKey(look)}`);
      if (look.sidn) assert.ok(lines.some((line) => line.includes("wowWmoGlow = wowWmoSidn * ( 1.0 - wowDaylight )")));
      if (look.env) assert.ok(lines.some((line) => line.includes("texture2D( wowWmoEnvMap, vWowWmoEnvUv )")));
      const vertex = preprocess(resolveIncludes(VERTEX_PREFIX + shader.vertexShader), { USE_FOG: "", USE_MAP: "" });
      const vertexLines = checkLookLines(vertex, `lit vertex ${wmoRunLookKey(look)}`);
      if (look.env) assert.ok(vertexLines.some((line) => line.startsWith("vWowWmoEnvUv =")));
    }
    if (look.sidn) {
      // The glow's uniforms reach the program: its own colour and the world light's daylight.
      assert.ok(shader.uniforms.wowWmoSidn.value.equals(new THREE.Vector3(...look.sidn)));
      assert.ok(shader.uniforms.wowDaylight !== undefined);
    }
    if (look.env) assert.equal(shader.uniforms.wowWmoEnvMap.value === environment, true);
  }
});

test("look GLSL over the room (basic + room fog) template: names declared before use, no glow", () => {
  for (const look of LOOKS) {
    const shader = roomRun(look);
    const fragment = preprocess(resolveIncludes(FRAGMENT_PREFIX + shader.fragmentShader),
      { USE_FOG: "", USE_MAP: "", USE_COLOR: "", USE_COLOR_ALPHA: "" });
    const lines = checkLookLines(fragment, `room ${wmoRunLookKey(look)}`);
    assert.ok(!lines.some((line) => line.includes("wowWmoGlow")), "an unlit run never glows");
    const vertex = preprocess(resolveIncludes(VERTEX_PREFIX + shader.vertexShader), { USE_FOG: "", USE_MAP: "" });
    checkLookLines(vertex, `room vertex ${wmoRunLookKey(look)}`);
  }
});

test("the look's statements are typed as GLSL ES allows", () => {
  // The few statements the look adds, typed by hand against the names they read.
  const glsl = Object.values(WMO_RUN_LOOK_GLSL).join("\n");
  for (const pattern of [
    /float wowWmoAlpha = diffuseColor\.a;/,
    /diffuseColor\.a = wowWmoAlpha;/,
    /vec3 wowWmoGlow = wowWmoSidn \* \( 1\.0 - wowDaylight \);/, // vec3 * float
    /\* pow\( min\( wowLight \+ wowWmoGlow, max\( wowLight, vec3\( 1\.0 \) \) \), vec3\( 2\.2 \) \);/, // vec3 everywhere
    /vec3 wowWmoEnv = texture2D\( wowWmoEnvMap, vWowWmoEnvUv \)\.rgb;/,
    /outgoingLight \+= sampledDiffuseColor\.rgb \* sampledDiffuseColor\.a \* wowWmoEnv;/,
    /outgoingLight \+= sampledDiffuseColor\.a \* wowWmoEnv;/,
    /vec3 wowWmoEye = normalize\( mvPosition\.xyz \);/,
    /vec3 wowWmoNormal = normalize\( normalMatrix \* normal \);/,
    /vWowWmoEnvUv = wowWmoEye\.xy - 2\.0 \* wowWmoNormal\.xy \* dot\( wowWmoNormal, wowWmoEye \);/,
  ]) assert.match(glsl, pattern);
  // No int literal where a float is needed (the commonest driver-only failure).
  for (const line of glsl.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    assert.doesNotMatch(line, /(?<![\w.])\d+(?![\w.])/, `int literal in «${line.trim()}»`);
  }
});
