// 05.10-A7b-7 (7.06, 7.16): the terrain splat program after the baked shadow and the per-chunk
// alpha clamp, checked as far as Node can without a WebGL context (`tests/glsl-static-check.mjs`).
// The splat block runs inside three's lambert template, wrapped by world light (`terrain`), with
// and without MCCV and the micro-normal profile — every combination `WorldRenderer3D` compiles. A
// compile error here is a white ground on reload, before anyone can look at it.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  applyTerrainSplat, setTerrainBakedShadowStrength, setTerrainSplatMicroNormals,
} from "../dist/code/browser/TerrainSplat.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import {
  assertDeclaredBeforeUse, declarations, preprocess, resolveIncludes, typeCheck,
} from "./glsl-static-check.mjs";

const FRAGMENT_PREFIX = "uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; uniform bool receiveShadow;\n";

function splat(painted) {
  return {
    layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1),
    alpha: new THREE.Texture(),
    index: new THREE.Texture(),
    ...(painted ? { colours: new THREE.Texture() } : {}),
  };
}

function compiled({ painted = false, micro = false } = {}) {
  const material = new THREE.MeshLambertMaterial({ color: 0x426b45 });
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, splat(painted));
  if (micro) setTerrainSplatMicroNormals(material, true);
  const lib = THREE.ShaderLib.lambert;
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return { material, shader };
}

const CASES = [];
for (const painted of [false, true]) for (const micro of [false, true]) for (const shadows of [false, true]) {
  CASES.push({ painted, micro, shadows });
}

/** Active lines from the splat block's first statement to its last (the baked shadow or MCCV). */
function splatBlock({ painted, micro, shadows }) {
  const defines = { USE_FOG: "", NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: shadows ? "3" : "0" };
  if (shadows) defines.USE_SHADOWMAP = "";
  const { shader } = compiled({ painted, micro });
  const lines = preprocess(resolveIncludes(FRAGMENT_PREFIX + shader.fragmentShader), defines);
  const start = lines.findIndex((line) => line.includes("vec4 splatSlots ="));
  const lastMarker = painted ? "diffuseColor.rgb *= pow(texture2D(splatColours" : "diffuseColor.rgb *= 0.7 + 0.3 * splatBakedLit";
  const end = lines.findIndex((line) => line.includes(lastMarker));
  assert.ok(start > 0 && end > start, `splat block not found (${JSON.stringify({ painted, micro, shadows })})`);
  return { before: lines.slice(0, start).join("\n"), body: lines.slice(start, end + 1), all: lines };
}

test("7.06/7.16 splat block: every splat* name is declared once and before its use", () => {
  for (const variant of CASES) {
    const { before, body } = splatBlock(variant);
    const seen = assertDeclaredBeforeUse(before, body, "splat", JSON.stringify(variant));
    for (const name of ["splatChunk", "splatCell", "splatAlphaUv", "splatAlphaTexel", "splatBlend", "splatBakedLit"]) {
      assert.ok(seen.has(name), `${JSON.stringify(variant)}: ${name} missing`);
    }
    // The uniform the new lines read is declared exactly once in the program.
    assert.equal(before.split("uniform float splatBakedShadow;").length - 1, 1);
  }
});

test("7.06/7.16 splat block: plain statements type-check as GLSL ES 3.00", () => {
  let checked = 0;
  for (const variant of CASES) {
    const { before, body } = splatBlock(variant);
    const variables = declarations(before);
    variables.set("diffuseColor", "vec4");
    const result = typeCheck(body, variables,
      (expression) => /[?<>[&|!]|==|\bint\b|splatLayer\(/.test(expression));
    assert.deepEqual(result.problems, [], JSON.stringify(variant));
    checked += result.checked;
  }
  assert.ok(checked >= 8 * 7, `only ${checked} statements typed`);
});

test("7.06/7.16 the new statements are the typed ones, with float literals", () => {
  const { body } = splatBlock({ painted: false, micro: false, shadows: false });
  const text = body.join("\n");
  for (const pattern of [
    /vec2 splatChunk = vSplatUv \* 16\.0;/,
    /vec2 splatCell = min\( floor\( splatChunk \), vec2\( 15\.0 \) \);/,
    /clamp\( splatChunk - splatCell, vec2\( 0\.5 \/ 64\.0 \), vec2\( 63\.5 \/ 64\.0 \) \)/,
    /vec4 splatAlphaTexel = texture2D\(splatAlpha, splatAlphaUv\);/,
    /float splatBakedLit = mix\( 1\.0, splatAlphaTexel\.a, splatBakedShadow \);/,
    /diffuseColor\.rgb \*= 0\.7 \+ 0\.3 \* splatBakedLit;/,
  ]) assert.match(text, pattern);
  assert.doesNotMatch(text, /texture2D\(splatAlpha, vSplatUv\)/, "the alpha map is no longer read across the chunk border");
  // The baked term follows the blended albedo and precedes MCCV and the world light.
  const all = splatBlock({ painted: true, micro: false, shadows: false }).all.join("\n");
  assert.ok(all.indexOf("diffuseColor.rgb *= splatColour;") < all.indexOf("diffuseColor.rgb *= 0.7 + 0.3 * splatBakedLit;"));
  assert.ok(all.indexOf("diffuseColor.rgb *= 0.7 + 0.3 * splatBakedLit;") < all.indexOf("vec3 wowViewSunDirection"));
});

test("7.06 the baked strength is a shared uniform: same program text at every preset", () => {
  setTerrainBakedShadowStrength(1);
  const classic = compiled();
  setTerrainBakedShadowStrength(0);
  const enhanced = compiled();
  assert.equal(enhanced.shader.fragmentShader, classic.shader.fragmentShader);
  assert.equal(enhanced.material.customProgramCacheKey(), classic.material.customProgramCacheKey());
  assert.equal(classic.shader.uniforms.splatBakedShadow === enhanced.shader.uniforms.splatBakedShadow, true, "one object");
  assert.equal(classic.shader.uniforms.splatBakedShadow.value, 0);
  setTerrainBakedShadowStrength(1);
  assert.equal(enhanced.shader.uniforms.splatBakedShadow.value, 1, "a preset change reaches compiled tiles");
  assert.match(classic.material.customProgramCacheKey(), /terrain-splat-v2/);
  assert.match(compiled({ painted: true }).material.customProgramCacheKey(), /terrain-splat-mccv-v2/);
});
