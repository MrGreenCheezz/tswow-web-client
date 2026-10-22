// 13.10 (7.11): the MOMT flags F_UNLIT (0x1), F_UNFOGGED (0x2) and the clamp bits (0x40/0x80), honoured
// where Wow.exe's batch renderers honour them (`WmoMaterialFlags.ts`: 0x007ac6a0 classic without MOCV,
// 0x007ac9f0 classic with MOCV, 0x007a9380 unified), the unlit run's MOCV stream, the clamp view and
// the renderer wiring. What this does NOT prove: the look against the original (14.25).

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "three";

import {
  WMO_UNLIT_MOCV_ATTRIBUTE, WMO_UNLIT_MOCV_GLSL, applyWmoRunClamp, applyWmoUnlitMocv, wmoGroupNeedsUnlitMocv,
  wmoRunDrawState, wmoRunDrawStateKey, wmoUnlitMocv,
} from "../dist/code/browser/WmoMaterialFlags.js";
import { buildWmoGroupGeometry } from "../dist/code/browser/WmoGeometry.js";
import { WMO_LIGHT_EXTERIOR, WMO_LIGHT_INTERIOR, WMO_LIGHT_TRANSITION } from "../dist/code/browser/WmoModel.js";
import { wmoRunMaterialCacheKey } from "../dist/code/browser/WorldRenderer3D.js";

const CLASSIC = { vertexLight: "classic" };
const UNIFIED = { vertexLight: "unified" };
const HAS_MOCV = 0x4;
const OUTDOOR = 0x8;
const INDOOR = 0x2000;
const group = (flags) => ({ flags, indoor: (flags & INDOOR) !== 0 });
const run = (materialFlags, lighting = WMO_LIGHT_EXTERIOR) => ({ materialFlags, lighting });

test("F_UNLIT: classic without MOCV on every batch, classic with MOCV never (0x007ac6a0 / 0x007ac9f0)", () => {
  assert.equal(wmoRunDrawState(CLASSIC, group(OUTDOOR), run(0x1)).unlit, true, "exterior window, no MOCV");
  assert.equal(wmoRunDrawState(CLASSIC, group(OUTDOOR | INDOOR), run(0x1)).unlit, true, "exterior batch of a room without MOCV");
  assert.equal(wmoRunDrawState(CLASSIC, group(OUTDOOR | HAS_MOCV), run(0x1)).unlit, false, "0x007ac9f0 never reads the bit");
  assert.equal(wmoRunDrawState(CLASSIC, group(INDOOR | HAS_MOCV), run(0x1, WMO_LIGHT_TRANSITION)).unlit, false);
  assert.equal(wmoRunDrawState(CLASSIC, group(OUTDOOR), run(0x0)).unlit, false, "no flag");
});

test("F_UNLIT: unified honours it in exterior groups (0x48) and on transition batches (0x007a9380)", () => {
  assert.equal(wmoRunDrawState(UNIFIED, group(OUTDOOR | HAS_MOCV), run(0x1, WMO_LIGHT_INTERIOR)).unlit, true, "lava in an exterior group");
  assert.equal(wmoRunDrawState(UNIFIED, group(0x40 | HAS_MOCV), run(0x1)).unlit, true, "0x40 is the other half of 0x48");
  assert.equal(wmoRunDrawState(UNIFIED, group(HAS_MOCV), run(0x1, WMO_LIGHT_TRANSITION)).unlit, true, "transition batch");
  assert.equal(wmoRunDrawState(UNIFIED, group(INDOOR | HAS_MOCV), run(0x1)).unlit, false, "interior group: light 3/2, bit ignored");
  // A run this renderer already draws as a room's inside stays what it was.
  assert.equal(wmoRunDrawState(UNIFIED, group(INDOOR | HAS_MOCV), run(0x1, WMO_LIGHT_TRANSITION)).unlit, false);
  assert.equal(wmoRunDrawState(CLASSIC, group(INDOOR), run(0x1, WMO_LIGHT_INTERIOR)).unlit, false);
});

test("F_UNFOGGED: every classic batch, only transition batches on the unified path", () => {
  assert.equal(wmoRunDrawState(CLASSIC, group(OUTDOOR), run(0x2)).unfogged, true);
  assert.equal(wmoRunDrawState(CLASSIC, group(INDOOR | HAS_MOCV), run(0x2, WMO_LIGHT_INTERIOR)).unfogged, true);
  assert.equal(wmoRunDrawState(UNIFIED, group(OUTDOOR | HAS_MOCV), run(0x2)).unfogged, false, "exterior group keeps fog on");
  assert.equal(wmoRunDrawState(UNIFIED, group(INDOOR | HAS_MOCV), run(0x2, WMO_LIGHT_INTERIOR)).unfogged, false);
  assert.equal(wmoRunDrawState(UNIFIED, group(INDOOR | HAS_MOCV), run(0x2, WMO_LIGHT_TRANSITION)).unfogged, true);
});

test("clamp bits on every path; a plain run's state and key change nothing", () => {
  for (const model of [CLASSIC, UNIFIED]) {
    assert.deepEqual(wmoRunDrawState(model, group(INDOOR | HAS_MOCV), run(0x40)), { unlit: false, unfogged: false, clampS: true, clampT: false });
    assert.deepEqual(wmoRunDrawState(model, group(OUTDOOR), run(0x80)), { unlit: false, unfogged: false, clampS: false, clampT: true });
  }
  const plain = wmoRunDrawState(CLASSIC, group(OUTDOOR), run(0x10 | 0x4 | 0x20 | 0x8));
  assert.deepEqual(plain, { unlit: false, unfogged: false, clampS: false, clampT: false });
  assert.equal(wmoRunDrawStateKey(plain), "");
  assert.equal(wmoRunDrawStateKey(wmoRunDrawState(CLASSIC, group(OUTDOOR), run(0xc0))), "", "clamp is in the flag byte already");
  const old = JSON.stringify(["parent", "wmo-run", 3, "url", 0, 0x1, false]);
  assert.equal(wmoRunMaterialCacheKey("parent", 3, "url", 0, 0x1, false, undefined, ""), old);
  const unlit = wmoRunMaterialCacheKey("parent", 3, "url", 0, 0x1, false, undefined,
    wmoRunDrawStateKey(wmoRunDrawState(CLASSIC, group(OUTDOOR), run(0x1))));
  assert.notEqual(unlit, old, "the same flag byte lit in one group and unlit in another is two materials");
  assert.equal(wmoRunDrawStateKey(wmoRunDrawState(CLASSIC, group(OUTDOOR), run(0x3))), "wmo-flags-v1:uf");
  // The same 0x2 byte is fogged in a unified exterior group and not in a classic one: two materials.
  assert.equal(wmoRunDrawStateKey(wmoRunDrawState(CLASSIC, group(OUTDOOR | HAS_MOCV), run(0x2))), "wmo-flags-v1:f");
  assert.equal(wmoRunDrawStateKey(wmoRunDrawState(UNIFIED, group(OUTDOOR | HAS_MOCV), run(0x2))), "");
});

test("the clamp view: the run's own sampler, the shared base untouched", () => {
  const base = new THREE.Texture();
  base.wrapS = THREE.RepeatWrapping;
  base.wrapT = THREE.RepeatWrapping;
  const view = base.clone();
  applyWmoRunClamp(view, { unlit: false, unfogged: false, clampS: true, clampT: false });
  assert.equal(view.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(view.wrapT, THREE.RepeatWrapping);
  assert.equal(base.wrapS, THREE.RepeatWrapping);
  applyWmoRunClamp(view, { unlit: false, unfogged: false, clampS: false, clampT: true });
  assert.equal(view.wrapS, THREE.RepeatWrapping);
  assert.equal(view.wrapT, THREE.ClampToEdgeWrapping);
});

test("the unlit MOCV stream is the sRGB bytes made linear, and only a group that needs it gets it", () => {
  const linear = wmoUnlitMocv(new Uint8Array([255, 0, 128, 7, 10, 255, 0, 0]));
  assert.equal(linear.length, 6);
  assert.ok(Math.abs(linear[0] - 1) < 1e-6 && linear[1] === 0);
  assert.ok(Math.abs(linear[2] - 0.2158605) < 1e-5, "128 → 0.2159");
  assert.ok(Math.abs(linear[3] - 10 / 255 / 12.92) < 1e-7 && Math.abs(linear[4] - 1) < 1e-6);

  const source = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
    uvs: new Float32Array(6),
    colours: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
    indices: new Uint16Array([0, 1, 2]),
    runs: [{ start: 0, count: 3, material: 0, blendMode: 0, materialFlags: 0x1, lighting: WMO_LIGHT_INTERIOR }],
    lightRefs: new Uint16Array(0),
  };
  const model = (flags, vertexLight, materialFlags = 0x1) => ({
    vertexLight, ambient: [0, 0, 0], lights: [],
    groups: [{ flags, indoor: (flags & INDOOR) !== 0, mesh: { ...source, runs: [{ ...source.runs[0], materialFlags }] } }],
  });
  const lava = buildWmoGroupGeometry(model(OUTDOOR | HAS_MOCV, "unified"), 0);
  const attribute = lava.getAttribute(WMO_UNLIT_MOCV_ATTRIBUTE);
  assert.ok(attribute, "unified exterior group, F_UNLIT, MOCV");
  assert.equal(attribute.itemSize, 3);
  assert.deepEqual([...attribute.array.slice(0, 3)], [1, 0, 0]);
  assert.equal(buildWmoGroupGeometry(model(OUTDOOR | HAS_MOCV, "unified", 0), 0).getAttribute(WMO_UNLIT_MOCV_ATTRIBUTE), undefined);
  assert.equal(buildWmoGroupGeometry(model(OUTDOOR, "classic"), 0).getAttribute(WMO_UNLIT_MOCV_ATTRIBUTE), undefined,
    "unlit but no MOCV: white, no stream");
  assert.equal(buildWmoGroupGeometry(model(OUTDOOR | HAS_MOCV, "classic"), 0).getAttribute(WMO_UNLIT_MOCV_ATTRIBUTE), undefined,
    "classic with MOCV draws it lit");
  assert.equal(wmoGroupNeedsUnlitMocv(UNIFIED, group(OUTDOOR | HAS_MOCV), [run(0x1, WMO_LIGHT_INTERIOR)]), true);
  assert.equal(wmoGroupNeedsUnlitMocv(UNIFIED, group(OUTDOOR), [run(0x1, WMO_LIGHT_INTERIOR)]), false);
});

test("the unlit MOCV hook over three's basic template: declared before use, after the colour markers", () => {
  const material = new THREE.MeshBasicMaterial();
  const key = material.customProgramCacheKey();
  applyWmoUnlitMocv(material);
  assert.notEqual(material.customProgramCacheKey(), key);
  const shader = {
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    uniforms: {},
  };
  material.onBeforeCompile(shader, undefined);
  const vertex = shader.vertexShader;
  const fragment = shader.fragmentShader;
  assert.ok(vertex.indexOf(`attribute vec3 ${WMO_UNLIT_MOCV_ATTRIBUTE};`) < vertex.indexOf(`vWowWmoMocv = ${WMO_UNLIT_MOCV_ATTRIBUTE};`));
  assert.ok(vertex.indexOf("#include <color_vertex>") < vertex.indexOf("vWowWmoMocv ="));
  assert.ok(fragment.indexOf("varying vec3 vWowWmoMocv;") < fragment.indexOf("diffuseColor.rgb *= vWowWmoMocv;"));
  assert.ok(fragment.indexOf("#include <color_fragment>") < fragment.indexOf("diffuseColor.rgb *= vWowWmoMocv;"));
  assert.ok(fragment.indexOf("diffuseColor.rgb *= vWowWmoMocv;") < fragment.indexOf("#include <opaque_fragment>"));
  assert.match(WMO_UNLIT_MOCV_GLSL.fragment, /diffuseColor\.rgb \*= vWowWmoMocv;/);
  assert.throws(() => applyAgain(), /colour marker/);
  function applyAgain() {
    const twice = new THREE.MeshBasicMaterial();
    applyWmoUnlitMocv(twice);
    twice.onBeforeCompile({ vertexShader: "void main() {}", fragmentShader: "void main() {}", uniforms: {} }, undefined);
  }
});

test("the renderer draws an unlit exterior run basic, in the sky's fog, its F_UNFOGGED run without fog", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  #wmoRunMaterial("), source.indexOf("  #wmoEnvTexture("));
  assert.match(body, /const state = wmoRunDrawState\(model, group, run\);/);
  assert.match(body, /const value = interior \|\| state\.unlit\r?\n\s+\? new THREE\.MeshBasicMaterial\(\{/);
  assert.match(body, /vertexColors: interior,/);
  assert.match(body, /if \(state\.unfogged\) value\.fog = false;/);
  assert.match(body, /if \(mocv && value instanceof THREE\.MeshBasicMaterial\) applyWmoUnlitMocv\(value\);/);
  assert.match(body, /if \(interior\) applyWmoInteriorFog\(value, this\.#wmoInteriorFog\);/);
  // 22.10 (7.37): the transition blend joins the same tail (`WmoTransitionLight.ts`).
  assert.match(body, /\[wmoRunDrawStateKey\(state\), blendsSun \? WMO_TRANSITION_PROGRAM_KEY : ""\]\.filter\(Boolean\)\.join\("\|"\), \/\/ 13\.10 7\.11/);
  assert.match(body, /if \(texture && !clamped\) \{/);
  assert.match(body, /const view = privateTextureView\(base\);\r?\n\s+applyWmoRunClamp\(view, state\);/);
});
