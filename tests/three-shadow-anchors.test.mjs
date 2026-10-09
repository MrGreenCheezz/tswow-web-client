import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// P2-01a/P2-01d rest on how three r185's WebGLShadowMap walks and draws: the caster list hands it a
// synthetic root, `referenceShadowWalk` copies `renderObject`, and the depth-only wrapper relies on
// every shadow draw going through `renderer.renderBufferDirect`. A three update that moves any of
// these has to send the reader back to docs/implementation/line-P-P2.ru.md (P2-01).
const source = readFileSync(new URL("../node_modules/three/build/three.module.js", import.meta.url), "utf8");

function body(start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `anchor ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `end anchor ${end}`);
  return source.slice(from, to);
}

const shadowMap = body("function WebGLShadowMap( renderer, objects, capabilities ) {", "function WebGLState(");

const ANCHORS = [
  // renderObject: own visibility only, then layers, kind, castShadow and the frustum, then children.
  ["renderObject", "function renderObject( object, camera, shadowCamera, light, type ) {"],
  ["renderObject", "if ( object.visible === false ) return;"],
  ["renderObject", "const visible = object.layers.test( camera.layers );"],
  ["renderObject", "( ! object.frustumCulled || _frustum.intersectsObject( object ) )"],
  ["renderObject", "object.onBeforeShadow( renderer, object, camera, shadowCamera, geometry, depthMaterial, group );"],
  ["renderObject", "renderer.renderBufferDirect( shadowCamera, null, geometry, depthMaterial, object, group );"],
  ["renderObject", "renderObject( children[ i ], camera, shadowCamera, light, type );"],
  // getDepthMaterial: a custom depth material wins; otherwise the shared one or a clone per source.
  ["getDepthMaterial", "function getDepthMaterial( object, material, light, type ) {"],
  ["getDepthMaterial", "object.customDepthMaterial"],
  ["getDepthMaterial", "result.side = ( material.shadowSide !== null ) ? material.shadowSide : shadowSide[ material.side ];"],
  ["getDepthMaterial", "result.map = material.map;"],
  // render: the walk starts at the object it is handed.
  ["render", "renderObject( scene, camera, shadow.camera, light, this.type );"],
  ["render", "renderer.clear();"],
];

test("three's shadow walk still has the shape P2-01 was written against", () => {
  for (const [where, anchor] of ANCHORS) {
    assert.ok(shadowMap.includes(anchor), `${where}: ${anchor}`);
  }
  // No colour write survives into the program key: P2-01d may flip it without new programs.
  const parameters = body("function getParameters( material, lights, shadows, scene, object", "function getProgramCacheKey(");
  assert.equal(parameters.includes("colorWrite"), false);
});
