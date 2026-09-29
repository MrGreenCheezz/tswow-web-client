import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { buildWmoGroupGeometry, buildWmoGroupGeometrySteps } from "../dist/code/browser/WmoGeometry.js";
import {
  WMO_GEOMETRY_STEP_VERTICES, WMO_LIGHT_EXTERIOR, WMO_LIGHT_INTERIOR, WMO_LIGHT_TRANSITION,
  wmoRunIsInterior, wmoVertexLight, wmoVertexLightSteps,
} from "../dist/code/browser/WmoModel.js";

// Independent pre-optimization formula, including the Float32 rounding after every lamp.
function referenceLighting(mesh, normals, ambient, lights) {
  const count = mesh.positions.length / 3;
  const output = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    for (let c = 0; c < 3; c++) output[v * 3 + c] = mesh.colours[v * 4 + c] + ambient[c];
  }
  for (const ref of mesh.lightRefs) {
    const lamp = lights[ref];
    if (!lamp || lamp.intensity <= 0) continue;
    const reach = lamp.attenuates ? Math.max(lamp.attenuationEnd, lamp.attenuationStart) : Infinity;
    for (let v = 0; v < count; v++) {
      const dx = lamp.position[0] - mesh.positions[v * 3];
      const dy = lamp.position[1] - mesh.positions[v * 3 + 1];
      const dz = lamp.position[2] - mesh.positions[v * 3 + 2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= reach) continue;
      const span = lamp.attenuationEnd - lamp.attenuationStart;
      const attenuation = !lamp.attenuates || distance <= lamp.attenuationStart ? 1
        : span > 0 ? (lamp.attenuationEnd - distance) / span : 0;
      const scale = distance > 0 ? 1 / distance : 0;
      const facing = (normals[v * 3] * dx + normals[v * 3 + 1] * dy + normals[v * 3 + 2] * dz) * scale;
      const strength = lamp.intensity * attenuation * (0.22 + 0.78 * Math.max(facing, 0));
      for (let c = 0; c < 3; c++) output[v * 3 + c] += lamp.colour[c] * strength;
    }
  }
  for (let i = 0; i < output.length; i++) {
    const value = Math.min(1, output[i] / 255);
    output[i] = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }
  return output;
}

function groupFixture(indoor, lighting, authored = true) {
  const source = {
    positions: new Float32Array([-2, 0, 1, 2, 0, 1, 2, 3, 1, -2, 3, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    colours: new Uint8Array([20, 40, 80, 255, 70, 10, 25, 128, 0, 255, 150, 255, 35, 35, 35, 255]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    runs: lighting.map((value, i) => ({
      start: i * 3, count: 3, material: i, blendMode: 0, materialFlags: 0, lighting: value,
    })),
    lightRefs: new Uint16Array([0]),
    ...(authored ? { normals: new Float32Array([0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 0, 1]) } : {}),
  };
  return {
    groups: [{ indoor, mesh: source }], ambient: [20, 31, 7],
    lights: [{ position: [0, 1, 3], colour: [80, 45, 17], intensity: 0.8,
      attenuates: true, attenuationStart: 1, attenuationEnd: 8 }],
  };
}

for (const authored of [true, false]) {
  for (const [label, indoor, lighting, needsColours] of [
    ["outdoor shell with interior batches", false, [WMO_LIGHT_INTERIOR, WMO_LIGHT_TRANSITION], false],
    ["indoor group with exterior-only batches", true, [WMO_LIGHT_EXTERIOR, WMO_LIGHT_EXTERIOR], false],
    ["interior room", true, [WMO_LIGHT_INTERIOR, WMO_LIGHT_TRANSITION], true],
    ["mixed street and room", true, [WMO_LIGHT_EXTERIOR, WMO_LIGHT_INTERIOR], true],
  ]) {
    test(`WMO geometry preserves ${label} with ${authored ? "authored" : "fallback"} normals`, () => {
      const model = groupFixture(indoor, lighting, authored);
      const group = model.groups[0];
      const source = group.mesh;
      const geometry = buildWmoGroupGeometry(model, 0);
      assert.ok(geometry);
      const expected = new THREE.BufferGeometry();
      expected.setAttribute("position", new THREE.Float32BufferAttribute([
        2, 1, 0, -2, 1, 0, -2, 1, 3, 2, 1, 3,
      ], 3));
      expected.setIndex(new THREE.BufferAttribute(source.indices, 1));
      if (authored) {
        expected.setAttribute("normal", new THREE.Float32BufferAttribute([
          -0, 1, 0, -0, -1, 0, -0, 0, 1, -0, 1, 0,
        ], 3));
      } else expected.computeVertexNormals();
      expected.computeBoundingSphere();
      assert.deepEqual(geometry.getAttribute("position").array, expected.getAttribute("position").array);
      assert.deepEqual(geometry.getAttribute("normal").array, expected.getAttribute("normal").array);
      assert.equal(geometry.getAttribute("uv").array, source.uvs, "UVs retain the decoded buffer");
      assert.equal(geometry.index.array, source.indices, "indices retain the decoded buffer");
      assert.deepEqual(geometry.boundingSphere, expected.boundingSphere);
      assert.deepEqual(geometry.groups, [{ start: 0, count: 3, materialIndex: 0 },
        { start: 3, count: 3, materialIndex: 1 }]);
      assert.equal(source.runs.some(run => wmoRunIsInterior(group, run)), needsColours,
        "only the same indoor-batch rule used by materials permits dropping the colour channel");
      assert.equal(geometry.hasAttribute("color"), needsColours);
      if (needsColours) {
        const sceneNormals = expected.getAttribute("normal").array;
        const normals = source.normals ?? Float32Array.from(sceneNormals, (_, at) => {
          const start = Math.floor(at / 3) * 3;
          return at % 3 === 0 ? -sceneNormals[start] : sceneNormals[start + (at % 3 === 1 ? 2 : 1)];
        });
        assert.deepEqual(geometry.getAttribute("color").array,
          referenceLighting(source, normals, model.ambient, model.lights));
      }
      geometry.dispose();
      expected.dispose();
    });
  }
}

test("WMO geometry waits for the requested decoded group", () => {
  assert.equal(buildWmoGroupGeometry({ groups: [] }, 0), undefined);
  assert.equal(buildWmoGroupGeometry({ groups: [{}] }, 0), undefined);
});

test("baked lighting preserves every colour byte and fractional ambient rounding", () => {
  const positions = new Float32Array(256 * 3);
  const colours = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v++) colours.set([v, 255 - v, (v * 59) % 256, 255], v * 4);
  const mesh = { positions, colours, lightRefs: new Uint16Array([0, 255]) };
  const normals = new Float32Array(positions.length);
  const ambient = [0, 11.123456789, 127.987654321];
  const lamps = [{ intensity: 0 }];
  for (let pass = 0; pass < 3; pass++) {
    assert.deepEqual(wmoVertexLight(mesh, normals, ambient, lamps), referenceLighting(mesh, normals, ambient, lamps));
    // Reusing a decoded parent after an ambient edit must invalidate its shared transfer table.
    ambient[pass] += 3.141592653589793;
  }
});

test("sparse lamps, reach boundaries and repeated references preserve exact vertex light", () => {
  const positions = [];
  const reach = 10;
  for (let x = -30; x <= 30; x++) {
    for (const y of [-10, -1, 0, 1, 10]) positions.push(x, y, 0);
  }
  positions.push(0, 0, 0, reach - 0.000001, 0, 0, reach, 0, 0, reach + 0.000001, 0, 0);
  const count = positions.length / 3;
  const mesh = {
    positions: new Float32Array(positions), colours: new Uint8Array(count * 4),
    lightRefs: new Uint16Array([0, 1, 0, 2, 3, 255]),
  };
  const normals = new Float32Array(positions.length);
  for (let v = 0; v < count; v++) {
    mesh.colours.set([v % 63, v % 97, v % 113, 255], v * 4);
    normals.set([Math.sin(v), Math.cos(v), 0], v * 3);
  }
  const lamp = { position: [0, 0, 0], colour: [31, 77, 43], intensity: 0.25,
    attenuates: true, attenuationStart: 2, attenuationEnd: reach };
  const lights = [lamp, { ...lamp, position: [21, 5, -2] },
    { ...lamp, attenuationStart: 0, attenuationEnd: 0 },
    { ...lamp, attenuates: false, position: [-15, 12, 2] }];
  const ambient = [3, 7, 11];
  assert.deepEqual(wmoVertexLight(mesh, normals, ambient, lights), referenceLighting(mesh, normals, ambient, lights));
});

function largeRoom(authored = true) {
  const count = WMO_GEOMETRY_STEP_VERTICES * 7 + 13;
  const model = groupFixture(true, [WMO_LIGHT_INTERIOR], authored);
  const mesh = model.groups[0].mesh;
  mesh.positions = new Float32Array(count * 3);
  mesh.uvs = new Float32Array(count * 2);
  mesh.colours = new Uint8Array(count * 4);
  if (authored) mesh.normals = new Float32Array(count * 3);
  const indices = [];
  for (let v = 0; v < count; v++) {
    mesh.positions.set([Math.sin(v / 19) * 12, Math.cos(v / 21) * 9, v % 31 / 3], v * 3);
    mesh.colours.set([v % 73, v % 101, v % 129, 255], v * 4);
    mesh.normals?.set([0, 0, 1], v * 3);
    // Shared vertices, arbitrary winding, and degenerates exercise Three's accumulation order.
    if (v >= 2) indices.push(v - 2, v % 11 === 0 ? v - 2 : v - 1, v);
  }
  mesh.indices = new Uint16Array(indices);
  mesh.runs[0].count = indices.length;
  mesh.lightRefs = new Uint16Array([0, 0]);
  return model;
}

for (const authored of [true, false]) {
  test(`large WMO geometry yields through every vertex pass and preserves ${authored ? "authored" : "fallback"} output`, () => {
    const model = largeRoom(authored);
    const mesh = model.groups[0].mesh;
    let reads = 0, largestReads = 0, steps = 0;
    const originalPositions = mesh.positions;
    mesh.positions = new Proxy(originalPositions, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, target);
      },
    });
    const job = buildWmoGroupGeometrySteps(model, 0);
    let result;
    do {
      reads = 0;
      result = job.next();
      largestReads = Math.max(largestReads, reads);
      steps++;
    } while (!result.done);
    mesh.positions = originalPositions;
    assert.ok(steps > 30, "conversion, lighting, normals and bounds must allow separate frame checks");
    assert.ok(largestReads <= WMO_GEOMETRY_STEP_VERTICES * 3,
      `one step read ${largestReads} source components instead of one bounded vertex chunk`);
    const geometry = result.value;
    const expected = new THREE.BufferGeometry();
    const positions = Float32Array.from(mesh.positions, (_, i) => {
      const base = Math.floor(i / 3) * 3;
      return i % 3 === 0 ? -mesh.positions[base] : mesh.positions[base + (i % 3 === 1 ? 2 : 1)];
    });
    expected.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    expected.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    if (authored) {
      const normals = Float32Array.from(mesh.normals, (_, i) => {
        const base = Math.floor(i / 3) * 3;
        return i % 3 === 0 ? -mesh.normals[base] : mesh.normals[base + (i % 3 === 1 ? 2 : 1)];
      });
      expected.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    } else expected.computeVertexNormals();
    expected.computeBoundingSphere();
    assert.deepEqual(geometry.getAttribute("position").array, positions);
    assert.deepEqual(geometry.getAttribute("normal").array, expected.getAttribute("normal").array);
    assert.deepEqual(geometry.boundingSphere, expected.boundingSphere);
    const sceneNormals = expected.getAttribute("normal").array;
    const modelNormals = mesh.normals ?? Float32Array.from(sceneNormals, (_, i) => {
      const base = Math.floor(i / 3) * 3;
      return i % 3 === 0 ? -sceneNormals[base] : sceneNormals[base + (i % 3 === 1 ? 2 : 1)];
    });
    assert.deepEqual(geometry.getAttribute("color").array,
      referenceLighting(mesh, modelNormals, model.ambient, model.lights));
    geometry.dispose(); expected.dispose();
  });
}

test("WMO lighting yields even when every lamp misses every vertex", () => {
  const model = largeRoom();
  model.lights[0].position = [10000, 10000, 10000];
  const mesh = model.groups[0].mesh;
  const job = wmoVertexLightSteps(mesh, mesh.normals, model.ambient, model.lights);
  let result, steps = 0;
  do { result = job.next(); steps++; } while (!result.done);
  assert.ok(steps >= 8 * 4, "initialization, both lamps and transfer must each be sliced");
  assert.deepEqual(result.value, referenceLighting(mesh, mesh.normals, model.ambient, model.lights));
});

test("cancelled and failed WMO jobs dispose only their partial geometry, exactly once", () => {
  const original = THREE.BufferGeometry.prototype.dispose;
  const disposed = [];
  THREE.BufferGeometry.prototype.dispose = function () { disposed.push(this); original.call(this); };
  try {
    const model = largeRoom();
    const cancelled = buildWmoGroupGeometrySteps(model, 0);
    assert.equal(cancelled.next().done, false);
    cancelled.return(); cancelled.return();
    assert.equal(disposed.length, 1);
    const failed = buildWmoGroupGeometrySteps(model, 0);
    assert.equal(failed.next().done, false);
    const failure = new Error("decode source invalidated");
    assert.throws(() => failed.throw(failure), error => error === failure);
    assert.equal(disposed.length, 2);
    const invalid = largeRoom();
    Object.defineProperty(invalid.groups[0].mesh, "uvs", { get() { throw failure; } });
    const broken = buildWmoGroupGeometrySteps(invalid, 0);
    assert.throws(() => { while (!broken.next().done) {} }, error => error === failure);
    broken.return();
    assert.equal(disposed.length, 3, "a build-time exception also releases its partial buffers");
    const completed = buildWmoGroupGeometrySteps(model, 0);
    let result;
    do { result = completed.next(); } while (!result.done);
    assert.equal(disposed.length, 3, "completed geometry belongs to the renderer");
    completed.return();
    assert.equal(disposed.length, 3);
    result.value.dispose();
    assert.equal(disposed.length, 4);
    assert.equal(disposed[3], result.value);
  } finally { THREE.BufferGeometry.prototype.dispose = original; }
});
