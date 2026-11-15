import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

// Only the world lighting is imported here: its aerial fog body replaces three's `fog_fragment` and calls the
// function by name, so the import alone has to bring the chunk that declares it.
import { WORLD_AERIAL_FOG_BODY } from "../dist/code/browser/WorldLighting.js";

test("7.66: importing the world lighting alone installs the fog function its aerial body calls", () => {
  assert.match(WORLD_AERIAL_FOG_BODY, /wowFogFactor\( fogNear, fogFar, vFogDepth \)/);
  assert.match(THREE.ShaderChunk.fog_pars_fragment, /float wowFogFactor\(/);
  assert.match(THREE.ShaderChunk.fog_pars_fragment, /float wowLinearFogFactor\(/, "the WMO rooms' linear form as well");
});
