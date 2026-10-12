// 12.10-7.30: sun beams through canopies with the camera level and the sun off screen — the
// volumetric march through the sun's shadow cascades.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  CINEMATIC_TUNING, CinematicPost, VOLUME_CASCADES, VOLUME_CONTEXT_TEXELS, VOLUME_FADE_YARDS, VOLUME_REACH_YARDS,
  VOLUME_STEPS, volumeScatter,
} from "../dist/code/browser/CinematicPost.js";

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test("beams are lit air among shade: nothing in open sun or full shade, a lit ray in a canopy all of it", () => {
  // volumeScatter(lit share of the ray, lit share around it, air, forward lobe)
  assert.equal(volumeScatter(1, 1, 1, 1), 0, "open sunlit air is the haze leaf's");
  assert.equal(volumeScatter(0, 0, 1, 1), 0, "full shade");
  close(volumeScatter(1, 0, 1, 1), 1, 1e-12);
  close(volumeScatter(0.25, 0, 1, 1), 0.5); // a thin beam over a dim canopy floor still reads
  close(volumeScatter(0.25, 0, 0.5, 1), 0.25); // a short ray (the ground a few yards off) carries less
  close(volumeScatter(0.25, 0, 1, 0), 0.05); // side-on a tenth
  assert.equal(volumeScatter(0, 1, 1, 1), 0, "a shaded ray among lit ones adds nothing");
  // Along a large shadow's edge the lit side glows softly, the shaded side not at all.
  assert.ok(volumeScatter(1, 0.5, 1, 1) <= 0.5);
  assert.equal(volumeScatter(Number.NaN, 0, 1, 1), 0);
  assert.ok(VOLUME_STEPS >= 16 && VOLUME_REACH_YARDS >= 30 && VOLUME_FADE_YARDS > 0 && VOLUME_CONTEXT_TEXELS > 4);
  assert.ok(CINEMATIC_TUNING.volume > 0 && CINEMATIC_TUNING.volumeGolden >= 0);
});

test("the march reads the cascades the world material reads, nearest first", () => {
  const post = new CinematicPost();
  const march = post.volumeMarch.fragmentShader;
  for (let index = 0; index < VOLUME_CASCADES; index++) {
    assert.ok(march.includes(`uniform highp sampler2DShadow sunShadowMap${index};`));
    assert.ok(march.includes(`uniform mat4 sunShadowMatrix${index};`));
  }
  assert.ok(march.includes("return texture(sunShadowMap0, c.xyz);"), "hardware compare, as three's PCF maps are made");
  assert.ok(march.indexOf("sunShadowMatrix0 * vec4(world, 1.0)") < march.indexOf("sunShadowMatrix1 * vec4(world, 1.0)"));
  assert.ok(march.includes(`for (int i = 0; i < ${VOLUME_STEPS}; i++)`));
  assert.ok(march.includes("exp(-t * volume.z)"), "near air outweighs the far glow");
  assert.ok(post.materials.includes(post.volumeMarch), "warmed with the other passes");
  const composite = post.composite.fragmentShader;
  assert.ok(composite.includes("float beam = sqrt(march.r) * (1.0 - min(around, march.r)) * march.g;"));
  assert.ok(composite.includes(`vec2 vw = vt * ${VOLUME_CONTEXT_TEXELS.toFixed(1)};`), "the shade around, from a wide cross");
  assert.ok(composite.includes("(0.1 + 0.9 * volumeLobe) * volumeLight.x"));
  post.dispose();
});

function fakeRenderer() {
  const targets = [];
  return {
    targets,
    extensions: { has: () => true },
    autoClear: true,
    setRenderTarget(target) { targets.push(target); },
    render() {},
  };
}

function frame(sunShadows, shafts = 1) {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 2000);
  camera.updateMatrixWorld();
  return {
    scene: new THREE.Texture(), depth: new THREE.DepthTexture(64, 36), glow: new THREE.Texture(), glowStrength: 0,
    rays: new THREE.Texture(), rayStrength: 0, shafts, sunShadows, camera, width: 64, height: 36,
    contextGeneration: 1, renderScale: 1, elapsedSeconds: 1 / 60,
  };
}

function cascade(withMap = true) {
  const light = new THREE.DirectionalLight();
  if (withMap) {
    light.shadow.map = new THREE.WebGLRenderTarget(16, 16);
    light.shadow.map.depthTexture = new THREE.DepthTexture(16, 16);
    light.shadow.map.depthTexture.compareFunction = THREE.LessEqualCompare;
  }
  light.shadow.matrix.makeTranslation(1, 2, 3);
  return light;
}

test("the march runs only with cascades handed over, and never leaves a compare slot empty", () => {
  const post = new CinematicPost();
  post.setProfile({ grade: true, bloom: true, sunScattering: true });
  post.updateLight({
    diffuse: { r: 1, g: 0.53, b: 0 }, ambient: { r: 0.4, g: 0.5, b: 0.6 }, fog: { r: 0.3, g: 0.47, b: 0.56 },
    fogFar: 500, sun: new THREE.Vector3(0.2, 0.9, 0.3).normalize(), storm: 0, underwater: false, indoors: false, glow: 0.65,
  });
  const u = post.uniforms;
  // No cascades (the comparison level, lighting quality without a shadow map, an old renderer): off.
  post.render(fakeRenderer(), frame(undefined));
  assert.equal(u.volumeLight.value.x, 0);
  // Two cascades (lighting quality 1): the third slot holds a real compare texture, not three's
  // 1x1 stand-in, which ANGLE refused the whole draw for (GL 1282).
  const near = cascade(), far = cascade();
  post.render(fakeRenderer(), frame([near, far]));
  assert.ok(u.volumeLight.value.x > 0);
  assert.equal(u.volume.value.x, 2);
  assert.equal(u.sunShadowMap0.value, near.shadow.map.depthTexture);
  assert.equal(u.sunShadowMap1.value, far.shadow.map.depthTexture);
  assert.equal(u.sunShadowMap2.value, near.shadow.map.depthTexture);
  assert.deepEqual(u.sunShadowMatrix1.value.elements, far.shadow.matrix.elements);
  // A cascade not rendered yet ends the run.
  post.render(fakeRenderer(), frame([near, cascade(false), far]));
  assert.equal(u.volume.value.x, 1);
  // The shafts' ceiling is the march's too: the slider at zero turns it off.
  post.render(fakeRenderer(), frame([near, far], 0));
  assert.equal(u.volumeLight.value.x, 0);
  post.release();
  assert.equal(u.sunShadowMap0.value, null, "the cascades' maps are only borrowed for a frame");
  post.dispose();
});
