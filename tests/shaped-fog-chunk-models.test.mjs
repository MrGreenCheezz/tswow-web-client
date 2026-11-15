import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

// Only the model builder is imported here, as on the page's own thread when the world draws in a worker: the login
// screens set a fog, and their additive batches and particles compile ModelBuild's fog step.
import { applyFogMode } from "../dist/code/browser/ModelBuild.js";

test("7.66: importing the model builder alone installs the fog function its fog step calls", () => {
  const material = new THREE.MeshBasicMaterial();
  applyFogMode(material, 4); // BLEND_ADD
  const shader = { fragmentShader: "#include <fog_pars_fragment>\nvoid main() {\n#include <fog_fragment>\n}", vertexShader: "", uniforms: {} };
  material.onBeforeCompile(shader, undefined);
  assert.match(shader.fragmentShader, /wowFogFactor\( fogNear, fogFar, vFogDepth \)/, "the step calls the function");
  assert.match(THREE.ShaderChunk.fog_pars_fragment, /float wowFogFactor\(/, "and three's chunk declares it");
  assert.match(THREE.ShaderChunk.fog_fragment, /wowFogFactor\( fogNear, fogFar, vFogDepth \)/);
  // The stock linear fog survives for a plain far distance: the function's positive branch is three's own line.
  assert.match(THREE.ShaderChunk.fog_pars_fragment, /smoothstep\( fogNear, fogFar, depth \)/);
});
