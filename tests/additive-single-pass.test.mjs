import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { applyBlendMode, cloneMaterialFaded } from '../dist/code/browser/ModelBuild.js';
import { BLEND_NO_ALPHA_ADD, BLEND_ADD, BLEND_ALPHA } from '../dist/code/browser/Wvm.js';

test('only unlit additive modes opt out of the two sided transparent pass', () => {
  for (const Material of [THREE.MeshBasicMaterial, THREE.MeshStandardMaterial, THREE.MeshLambertMaterial]) {
    for (let mode = 0; mode < 8; mode++) {
      const material = new Material({ side: THREE.DoubleSide });
      applyBlendMode(material, mode);
      const eligible = Material === THREE.MeshBasicMaterial && [BLEND_NO_ALPHA_ADD, BLEND_ADD].includes(mode);
      assert.equal(material.forceSinglePass, eligible, `${material.type} / ${mode}`);
      assert.equal(material.side, THREE.DoubleSide, 'both faces stay visible');
      if (eligible) {
        assert.equal(material.depthWrite, false);
        assert.equal(material.blendDst, THREE.OneFactor);
        assert.equal(material.blendSrc, mode === BLEND_ADD ? THREE.SrcAlphaFactor : THREE.OneFactor);
      }
    }
  }
});

test('separate alpha blending and subtractive equations preserve ordered passes', () => {
  for (const override of [
    { blendEquation: THREE.ReverseSubtractEquation }, { blendEquation: THREE.SubtractEquation },
    { blendSrcAlpha: THREE.SrcAlphaFactor }, { blendDstAlpha: THREE.OneMinusSrcAlphaFactor },
    { blendEquationAlpha: THREE.ReverseSubtractEquation },
  ]) {
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, ...override });
    applyBlendMode(material, BLEND_ADD);
    assert.equal(material.forceSinglePass, false);
  }
});

test('switching a material from additive to ordinary alpha restores two passes', () => {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  applyBlendMode(material, BLEND_ADD);
  assert.equal(material.forceSinglePass, true);
  applyBlendMode(material, BLEND_ALPHA);
  assert.equal(material.forceSinglePass, false);
  assert.equal(material.blending, THREE.NormalBlending);
});

test('spawn/stealth material clones preserve additive policy and blend equation', () => {
  for (const mode of [BLEND_NO_ALPHA_ADD, BLEND_ADD, BLEND_ALPHA]) {
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: 0x778899 });
    applyBlendMode(material, mode);
    const faded = cloneMaterialFaded(material, .35);
    assert.equal(faded.forceSinglePass, mode !== BLEND_ALPHA);
    assert.equal(faded.blendSrc, material.blendSrc);
    assert.equal(faded.blendDst, material.blendDst);
    assert.equal(faded.depthWrite, material.depthWrite);
    assert.equal(faded.opacity, .35);
    assert.equal(material.opacity, 1);
  }
});
