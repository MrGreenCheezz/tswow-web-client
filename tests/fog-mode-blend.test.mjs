import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyFogMode, fogModeBody } from "../dist/code/browser/ModelBuild.js";

// 15.11 (6.11 follow-up): an M2 draw's fog colour by blend, Wow.exe 0x0081fb10 reading 0x00a45390:
// {0: scene, 1: scene, 2: scene, 3: black, 4: black, 5: white, 6: grey 0x808080, 7: none}; the stand's mod2x batches
// get c2 = 0.502 and its mod batches 1.0.

function compiled(blend) {
  const material = new THREE.MeshBasicMaterial();
  applyFogMode(material, blend);
  const shader = { fragmentShader: "void main() {\n#include <fog_fragment>\n}", vertexShader: "", uniforms: {} };
  material.onBeforeCompile(shader, undefined);
  return shader.fragmentShader;
}

test("6.11 the scene's own fog for opaque, alpha-key and alpha blends", () => {
  for (const blend of [0, 1, 2]) {
    assert.equal(fogModeBody(blend), undefined);
    assert.match(compiled(blend), /#include <fog_fragment>/, `blend ${blend} keeps three's fog`);
  }
});

test("6.11 additive blends fog to black, mod to white, mod2x to grey 0x808080, blend-add not at all", () => {
  for (const blend of [3, 4]) assert.match(compiled(blend), /gl_FragColor\.rgb \*= \( 1\.0 - fogFactor \);/);
  assert.match(compiled(5), /mix\( gl_FragColor\.rgb, vec3\( 1\.0 \), fogFactor \)/);
  assert.match(compiled(6), /mix\( gl_FragColor\.rgb, vec3\( 128\.0 \/ 255\.0 \), fogFactor \)/);
  const blendAdd = compiled(7);
  assert.doesNotMatch(blendAdd, /#include <fog_fragment>/);
  assert.doesNotMatch(blendAdd, /gl_FragColor\.rgb\s*(\*=|=)/, "blend-add leaves its colour as it is");
  assert.match(blendAdd, /wowFogFactor\( fogNear, fogFar, vFogDepth \)/, "the step still holds the fog function line");
});
