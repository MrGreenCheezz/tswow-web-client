import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { CascadedSunShadows, depthOnlyActive } from "../dist/code/browser/CascadedShadows.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";
import { createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";

const sunTowards = new THREE.Vector3(0.19, 0.53, -0.84);

/**
 * A renderer stand-in: `shadowMap.render` plays three's `renderObject` for one mesh per light —
 * `object.onBeforeShadow(…, depthMaterial, group)`, `renderBufferDirect`, `object.onAfterShadow` —
 * with one depth material shared by every light, as three's private `_depthMaterial` is; the colour
 * mask is recorded the way `WebGLState.buffers.color` keeps it.
 */
function fakeRenderer({ throwOn } = {}) {
  const submitted = [];
  const masks = [];
  const caster = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const renderer = {
    info: { render: { calls: 0 } },
    state: { buffers: { color: { setMask(value) { masks.push(value); } } } },
    renderBufferDirect(camera, scene, geometry, material) {
      submitted.push({ material, colorWrite: material.colorWrite, active: depthOnlyActive() });
      renderer.info.render.calls++;
    },
    shadowMap: {
      shared: new THREE.MeshDepthMaterial(),
      // The clone three keeps per alpha-keyed source material: every second draw uses it.
      clone: new THREE.MeshDepthMaterial(),
      draws: 0,
      render(lights) {
        for (const light of lights) {
          this.draws++;
          light.shadow.map ??= { dispose() {} };
          const material = this.draws % 2 === 0 ? this.clone : this.shared;
          caster.onBeforeShadow(renderer, caster, null, light.shadow.camera, caster.geometry, material, null);
          if (throwOn !== undefined && this.draws === throwOn) throw new Error("driver lost");
          renderer.renderBufferDirect(light.shadow.camera, null, caster.geometry, material, caster, null);
          caster.onAfterShadow(renderer, caster, null, light.shadow.camera, caster.geometry, material, null);
        }
      },
    },
  };
  return { renderer, submitted, masks, caster };
}

function setup(options) {
  const scene = new THREE.Scene();
  const primary = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(primary, primary.target);
  const cascades = new CascadedSunShadows(primary, createWorldLightUniforms().wowShadowFade);
  const fake = fakeRenderer(options);
  cascades.configure(scene, fake.renderer, lightingProfile(2, { shadowMaps: true, maxTextureSize: 4096 }));
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 4000);
  camera.position.set(-9600, 60, 300);
  camera.lookAt(-9570, 55, 330);
  camera.updateMatrixWorld();
  cascades.update(camera, sunTowards, 1);
  return { ...fake, cascades, scene, camera };
}

test("the cascades' depth materials write no colour, set before three binds them", () => {
  const { renderer, submitted, masks, cascades, scene, camera, caster } = setup();
  const direct = renderer.renderBufferDirect;
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.equal(submitted.length, 3);
  for (const { colorWrite } of submitted) assert.equal(colorWrite, false, "off while three binds and draws it");
  assert.equal(renderer.shadowMap.shared.colorWrite, true, "handed back after each draw");
  assert.equal(renderer.shadowMap.clone.colorWrite, true, "every material the pass touched, not only the last");
  assert.equal(renderer.renderBufferDirect, direct, "renderBufferDirect is never replaced");
  assert.equal(depthOnlyActive(), false, "the hook acts only while the cascades render");
  assert.deepEqual(masks, [false, true], "clears skip colour during the pass; the mask is on again after it");
  assert.equal(caster.material.colorWrite, true, "the caster's own material is untouched");

  // Outside the shadow pass the hook does nothing, whatever reaches it.
  const main = new THREE.MeshStandardMaterial();
  caster.onBeforeShadow(renderer, caster, camera, camera, caster.geometry, main, null);
  assert.equal(main.colorWrite, true);
});

test("lights that are not cascades render with colour as before, on the same shared depth material", () => {
  const { renderer, submitted, cascades, scene, camera } = setup();
  renderer.shadowMap.render(cascades.lights, scene, camera);
  submitted.length = 0;
  renderer.shadowMap.render([new THREE.DirectionalLight()], scene, camera);
  assert.equal(submitted.length, 1);
  assert.ok([renderer.shadowMap.shared, renderer.shadowMap.clone].includes(submitted[0].material), "a depth material the cascades used");
  assert.equal(submitted[0].colorWrite, true);
  assert.equal(submitted[0].active, false);
});

test("an outer renderBufferDirect hook stays outermost and still sees every shadow draw", () => {
  const { renderer, submitted, cascades, scene, camera } = setup();
  const seen = [];
  const inner = renderer.renderBufferDirect;
  const outer = function (...args) {
    seen.push(args[3].colorWrite);
    return inner.apply(this, args);
  };
  renderer.renderBufferDirect = outer;
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.deepEqual(seen, [false, false, false]);
  assert.equal(submitted.length, 3);
  assert.equal(renderer.renderBufferDirect, outer);
});

test("an exception inside a cascade still ends the depth-only window and restores the mask", () => {
  const { renderer, masks, cascades, scene, camera } = setup({ throwOn: 2 });
  assert.throws(() => renderer.shadowMap.render(cascades.lights, scene, camera), /driver lost/);
  assert.equal(depthOnlyActive(), false);
  assert.equal(masks.at(-1), true);
  assert.equal(renderer.shadowMap.clone.colorWrite, true, "a draw that threw still gets its colour back");
  assert.equal(renderer.shadowMap.shared.colorWrite, true);
});

test("the hook is installed once however many renderers the cascades meet", () => {
  const hook = THREE.Object3D.prototype.onBeforeShadow;
  setup();
  setup();
  assert.equal(THREE.Object3D.prototype.onBeforeShadow, hook);
});
