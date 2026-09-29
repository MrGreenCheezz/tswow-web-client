import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { WebGLUniforms } from "three/src/renderers/webgl/WebGLUniforms.js";
import { specialiseFloatUniforms, useFloatUniformSetters } from "../dist/code/browser/FloatUniformSetters.js";

const FLOAT = 0x1406, VEC2 = 0x8b50, VEC3 = 0x8b51, VEC4 = 0x8b52, MAT3 = 0x8b5b, MAT4 = 0x8b5c;
const INT = 0x1404, BOOL = 0x8b56, SAMPLER_2D = 0x8b5e;

/** A program's active uniforms, as `getActiveUniform` reports them. */
const ACTIVE = [
  { name: "modelViewMatrix", type: MAT4, size: 1 },
  { name: "normalMatrix", type: MAT3, size: 1 },
  { name: "sunDirection", type: VEC3, size: 1 },
  { name: "fogColour", type: VEC3, size: 1 },
  { name: "shadowMapSize", type: VEC2, size: 1 },
  { name: "windField", type: VEC4, size: 1 },
  { name: "opacity", type: FLOAT, size: 1 },
  { name: "lightCount", type: INT, size: 1 },
  { name: "receiveShadow", type: BOOL, size: 1 },
  { name: "map", type: SAMPLER_2D, size: 1 },
  { name: "sun.direction", type: VEC3, size: 1 },
  { name: "sun.color", type: VEC3, size: 1 },
  { name: "lightPositions[0]", type: VEC4, size: 2 },
  { name: "shadowMatrix[0]", type: MAT4, size: 3 },
  { name: "lightProbe[0]", type: VEC3, size: 2 },
];

/** A WebGL stand-in that records every upload as the float32 values the GPU would receive. */
function fakeGl() {
  const uploads = [];
  const gl = {
    ACTIVE_UNIFORMS: 0x8b86,
    getProgramParameter: () => ACTIVE.length,
    getActiveUniform: (_program, index) => ACTIVE[index],
    getUniformLocation: (_program, name) => ({ name }),
  };
  const record = (location, values) => uploads.push({ name: location.name, values: Array.from(Float32Array.from(values)) });
  for (const size of [1, 2, 3, 4]) {
    gl[`uniform${size}f`] = (location, ...values) => record(location, values);
    gl[`uniform${size}fv`] = (location, values) => record(location, values);
    gl[`uniform${size}i`] = (location, ...values) => record(location, values);
    gl[`uniform${size}iv`] = (location, values) => record(location, values);
  }
  gl.uniformMatrix3fv = (location, _transpose, values) => record(location, values);
  gl.uniformMatrix4fv = (location, _transpose, values) => record(location, values);
  return { gl, uploads };
}

function programUniforms(specialise) {
  const { gl, uploads } = fakeGl();
  const uniforms = new WebGLUniforms(gl, {});
  const changed = specialise ? specialiseFloatUniforms(uniforms.seq) : 0;
  return { gl, uploads, uniforms, changed };
}

/** Every value form three's setters accept, including repeats that must not upload again. */
function* valueSequence() {
  const matrix = new THREE.Matrix4();
  yield ["modelViewMatrix", matrix];
  yield ["modelViewMatrix", matrix];
  matrix.makeRotationY(0.3).setPosition(1.5, -2.25, 7);
  yield ["modelViewMatrix", matrix];
  yield ["modelViewMatrix", matrix.clone()];
  matrix.elements[15] = 0.5;
  yield ["modelViewMatrix", matrix];
  yield ["modelViewMatrix", Float32Array.from(matrix.elements)];
  yield ["modelViewMatrix", new Float32Array(16).fill(2)];
  yield ["modelViewMatrix", new THREE.Matrix4().set(...new Array(16).fill(2))];
  yield ["modelViewMatrix", new THREE.Matrix4().makeScale(Number.NaN, 1, 1)];
  yield ["modelViewMatrix", new THREE.Matrix4().makeScale(Number.NaN, 1, 1)];
  const normal = new THREE.Matrix3().getNormalMatrix(new THREE.Matrix4().makeRotationX(0.7));
  yield ["normalMatrix", normal];
  yield ["normalMatrix", normal];
  yield ["normalMatrix", new THREE.Matrix3()];
  yield ["normalMatrix", [1, 0, 0, 0, 1, 0, 0, 0, 1]];
  yield ["normalMatrix", new Float32Array([0.5, 0, 0, 0, 1, 0, 0, 0, 1])];
  yield ["sunDirection", new THREE.Vector3(0.25, -0.5, 1)];
  yield ["sunDirection", new THREE.Vector3(0.25, -0.5, 1)];
  yield ["sunDirection", new THREE.Color(0.25, -0.5, 1)];
  yield ["sunDirection", [0.25, -0.5, 1]];
  yield ["sunDirection", { x: 0.25, y: -0.5, z: 2 }];
  yield ["sunDirection", new THREE.Vector3(0, 0, 0)];
  yield ["sunDirection", new THREE.Vector3(-0, 0, 0)];
  yield ["sunDirection", new THREE.Vector3(Number.NaN, 0, 0)];
  yield ["sunDirection", new THREE.Vector3(Number.NaN, 0, 0)];
  yield ["fogColour", new THREE.Color(0.8, 0.6, 0.4)];
  yield ["fogColour", new THREE.Color(0.8, 0.6, 0.4)];
  yield ["fogColour", new THREE.Color(0.8, 0.6, 0.41)];
  yield ["fogColour", new Float32Array([0.1, 0.2, 0.3])];
  yield ["shadowMapSize", new THREE.Vector2(2048, 2048)];
  yield ["shadowMapSize", new THREE.Vector2(2048, 2048)];
  yield ["shadowMapSize", new THREE.Vector2(1024, 2048)];
  yield ["shadowMapSize", [1024, 512]];
  yield ["windField", new THREE.Vector4(1, 2, 3, 4)];
  yield ["windField", new THREE.Vector4(1, 2, 3, 4)];
  yield ["windField", new THREE.Vector4(1, 2, 3, 4.5)];
  yield ["windField", new THREE.Quaternion(0, 0, 0, 1)];
  yield ["windField", [0, 0, 0, 1]];
  yield ["windField", [0, 0, 1, 1]];
  yield ["opacity", 0.5];
  yield ["opacity", 0.5];
  yield ["lightCount", 3];
  yield ["receiveShadow", true];
  yield ["receiveShadow", true];
  yield ["receiveShadow", false];
  yield ["sun", { direction: new THREE.Vector3(0, 1, 0), color: new THREE.Color(1, 0.9, 0.8) }];
  yield ["sun", { direction: new THREE.Vector3(0, 1, 0), color: new THREE.Color(1, 0.9, 0.7) }];
  yield ["lightProbe", [new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 5, 6)]];
}

/** Array uniforms: three uploads them on every set, the specialised setters only on a change. */
function* arraySequence() {
  const v4 = (...values) => new THREE.Vector4(...values);
  yield ["lightPositions", [v4(1, 2, 3, 4), v4(5, 6, 7, 8)], true];
  yield ["lightPositions", [v4(1, 2, 3, 4), v4(5, 6, 7, 8)], false];
  yield ["lightPositions", [v4(1, 2, 3, 4), v4(5, 6, 7, 8.5)], true];
  yield ["lightPositions", Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]), true];
  // Back to the vectors three's flat upload replaced: the program holds the flat values now.
  yield ["lightPositions", [v4(1, 2, 3, 4), v4(5, 6, 7, 8.5)], true];
  yield ["lightPositions", [v4(1, 2, 3, 4), new THREE.Vector3(5, 6, 7)], true];
  yield ["lightPositions", [v4(1, 2, 3, 4), v4(5, 6, 7, 8.5)], true];
  yield ["lightPositions", [v4(0, 2, 3, 4), v4(5, 6, 7, 8.5)], true];
  yield ["lightPositions", [v4(-0, 2, 3, 4), v4(5, 6, 7, 8.5)], false];
  // A real change elsewhere uploads the whole array, and then with this call's zeros.
  yield ["lightPositions", [v4(0, 2, 3, 4), v4(5, 6, 7, 9)], true];
  yield ["lightPositions", [v4(-0, 2, 3, 4), v4(5, 6, 7, 9.5)], true];
  yield ["lightPositions", [v4(Number.NaN, 2, 3, 4), v4(5, 6, 7, 8.5)], true];
  yield ["lightPositions", [v4(Number.NaN, 2, 3, 4), v4(5, 6, 7, 8.5)], true];
  const cascades = [new THREE.Matrix4(), new THREE.Matrix4().makeRotationZ(0.4), new THREE.Matrix4().makeTranslation(1, 2, 3)];
  yield ["shadowMatrix", cascades, true];
  yield ["shadowMatrix", cascades.map((m) => m.clone()), false];
  cascades[2].elements[15] = 2;
  yield ["shadowMatrix", cascades, true];
  yield ["shadowMatrix", [...cascades[0].elements, ...cascades[1].elements, ...cascades[2].elements], true];
  yield ["shadowMatrix", cascades, true];
  cascades[1].elements[1] = -cascades[1].elements[1];
  yield ["shadowMatrix", cascades, true];
}

test("the specialised setters upload exactly what three's own setters upload", () => {
  const three = programUniforms(false);
  const ours = programUniforms(true);
  for (const [name, value] of valueSequence()) {
    const before = [three.uploads.length, ours.uploads.length];
    three.uniforms.setValue(three.gl, name, value);
    ours.uniforms.setValue(ours.gl, name, value);
    assert.deepEqual(ours.uploads.slice(before[1]), three.uploads.slice(before[0]),
      `${name} = ${Array.isArray(value) ? `[${value}]` : value?.constructor?.name ?? value}`);
  }
  // Every repeat above was skipped by both: the sequence is not all uploads.
  assert.ok(three.uploads.length < [...valueSequence()].length);
});

test("vec4 and mat4 arrays upload on a change and leave the program holding three's values", () => {
  const three = programUniforms(false);
  const ours = programUniforms(true);
  // What the program holds for a uniform: its last upload (-0 and 0 are the same value to a shader).
  const held = (uploads, name) => uploads.findLast((upload) => upload.name === `${name}[0]`)?.values;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i] || (Number.isNaN(x) && Number.isNaN(b[i])));
  let step = 0;
  for (const [name, value, uploads] of arraySequence()) {
    const before = ours.uploads.length;
    three.uniforms.setValue(three.gl, name, value);
    ours.uniforms.setValue(ours.gl, name, value);
    assert.equal(ours.uploads.length - before, uploads ? 1 : 0, `step ${step} uploads`);
    if (uploads) assert.deepEqual(ours.uploads.at(-1), three.uploads.at(-1), `step ${step} uploads three's values`);
    assert.ok(same(held(ours.uploads, name), held(three.uploads, name)), `step ${step} leaves ${name} as three does`);
    step++;
  }
});

test("only float vector and matrix uniforms change, struct members and vec4/mat4 arrays included", () => {
  const three = programUniforms(false);
  const { uniforms, changed } = programUniforms(true);
  const byName = (seq) => new Map(seq.flatMap((u) => u.seq ? u.seq.map((m) => [`${u.id}.${m.id}`, m]) : [[u.id, u]]));
  const before = byName(three.uniforms.seq), after = byName(uniforms.seq);
  const specialised = [...after].filter(([name, u]) => u.setValue !== before.get(name).setValue).map(([name]) => name);
  assert.deepEqual(specialised.sort(), ["fogColour", "lightPositions", "modelViewMatrix", "normalMatrix", "shadowMapSize",
    "shadowMatrix", "sun.color", "sun.direction", "sunDirection", "windField"]);
  assert.equal(changed, specialised.length);
  const components = { fogColour: 3, lightPositions: 8, modelViewMatrix: 16, normalMatrix: 9, shadowMapSize: 2,
    shadowMatrix: 48, "sun.color": 3, "sun.direction": 3, sunDirection: 3, windField: 4 };
  for (const name of specialised) {
    const cache = after.get(name).cache;
    assert.ok(cache instanceof Float64Array, name);
    assert.equal(cache.length, components[name], `${name} holds the whole value`);
    assert.ok(cache.every(Number.isNaN), `${name} starts unknown`);
  }
  for (const [name, u] of after) if (!specialised.includes(name)) assert.ok(Array.isArray(u.cache), name);
  assert.equal(specialiseFloatUniforms(uniforms.seq), 0, "already converted uniforms are left alone");
});

test("a renderer's programs are converted on their own first getUniforms, then put back", () => {
  let built = 0;
  const program = () => {
    const self = {};
    let uniforms;
    // Like three's WebGLProgram: the uniforms are built (after the link) on the first call only.
    self.getUniforms = function () { if (!uniforms) { built++; uniforms = new WebGLUniforms(fakeGl().gl, {}); } return uniforms; };
    return self;
  };
  const existing = program();
  const renderer = { info: { programs: [existing] } };
  const originalExisting = existing.getUniforms;
  useFloatUniformSetters(renderer);
  assert.equal(built, 0, "hooking builds nothing and waits for no link");
  const added = program(), originalAdded = added.getUniforms;
  assert.equal(renderer.info.programs.push(added), 2);
  assert.equal(built, 0);
  for (const [candidate, original] of [[existing, originalExisting], [added, originalAdded]]) {
    const uniforms = candidate.getUniforms();
    assert.equal(candidate.getUniforms, original, "the wrapper removes itself");
    assert.ok(uniforms.map.modelViewMatrix.cache instanceof Float64Array);
    assert.equal(candidate.getUniforms(), uniforms);
  }
  assert.equal(built, 2);
  const push = renderer.info.programs.push;
  useFloatUniformSetters(renderer);
  assert.equal(renderer.info.programs.push, push, "a second hook on the same list is a no-op");
});

test("three still keeps its programs on the list the hook watches", async () => {
  // useFloatUniformSetters relies on these two lines of three's WebGL renderer.
  const source = await readFile(new URL("../node_modules/three/build/three.module.js", import.meta.url), "utf8");
  assert.match(source, /info\.programs = programCache\.programs;/);
  assert.match(source, /program = new WebGLProgram\( renderer, cacheKey, parameters, bindingStates \);\s*programs\.push\( program \);/);
});
