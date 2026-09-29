import * as THREE from "three";
import {
  WMO_GEOMETRY_STEP_VERTICES, WMO_GROUP_HAS_COLOURS, wmoRunIsInterior, wmoVertexLightSteps, type WmoModel,
} from "./WmoModel.js";

/** Builds one decoded room without calculating vertex light that none of its runs will read. */
export function buildWmoGroupGeometry(model: WmoModel, index: number): THREE.BufferGeometry | undefined {
  const steps = buildWmoGroupGeometrySteps(model, index);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/**
 * A room may contain an entire city shell. Slice every vertex/triangle pass, including fallback
 * normals and the bounding sphere, so an admitted room cannot bypass the frame's elapsed budget.
 * The iterator owns the geometry until completion; return() cancels and disposes a partial build.
 */
export function* buildWmoGroupGeometrySteps(
  model: WmoModel, index: number,
): Generator<void, THREE.BufferGeometry | undefined, void> {
  const group = model.groups[index];
  const source = group?.mesh;
  if (!group || !source) return undefined;
  const geometry = new THREE.BufferGeometry();
  let completed = false;
  try {
    let interior = false;
    for (let ordinal = 0; ordinal < source.runs.length; ordinal++) {
      if (wmoRunIsInterior(group, source.runs[ordinal]!)) { interior = true; break; }
      if ((ordinal + 1) % WMO_GEOMETRY_STEP_VERTICES === 0) yield;
    }
    const positions = new Float32Array(source.positions.length);
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    const chunk = WMO_GEOMETRY_STEP_VERTICES * 3;
    for (let start = 0; start < positions.length; start += chunk) {
      copyWmoVectors(source.positions, positions, start, Math.min(start + chunk, positions.length), bounds, point);
      yield;
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(source.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
    let modelNormals = source.normals;
    if (source.normals) {
      // Authored MONR normals use the same model-to-scene permutation as positions, (-x,z,y).
      const sceneNormals = new Float32Array(source.normals.length);
      for (let start = 0; start < sceneNormals.length; start += chunk) {
        copyWmoVectors(source.normals, sceneNormals, start, Math.min(start + chunk, sceneNormals.length));
        yield;
      }
      geometry.setAttribute("normal", new THREE.BufferAttribute(sceneNormals, 3));
    } else {
      yield* computeVertexNormalsSteps(geometry);
      if (interior) {
        // Only interior runs read model-space lamp lighting. Outdoor surfaces still use the
        // calculated scene normals, but need neither this inverse copy nor a colour buffer.
        const sceneNormals = geometry.getAttribute("normal").array;
        modelNormals = new Float32Array(sceneNormals.length);
        for (let start = 0; start < sceneNormals.length; start += chunk) {
          copyWmoVectors(sceneNormals, modelNormals, start, Math.min(start + chunk, sceneNormals.length));
          yield;
        }
      }
    }
    if (interior && modelNormals) {
      geometry.setAttribute("color", new THREE.BufferAttribute(
        yield* wmoVertexLightSteps(source, modelNormals, model.ambient, model.lights,
          model.vertexLight ?? "unified", (group.flags & WMO_GROUP_HAS_COLOURS) !== 0,
          model.vertexAlphaFixed !== false), 3,
      ));
    }
    for (const [ordinal, run] of source.runs.entries()) {
      geometry.addGroup(run.start, run.count, ordinal);
      if ((ordinal + 1) % WMO_GEOMETRY_STEP_VERTICES === 0) yield;
    }
    // Match Three's tight sphere exactly, retaining the box found during the position conversion.
    const sphere = new THREE.Sphere(bounds.getCenter(new THREE.Vector3()));
    let maxRadiusSq = 0;
    for (let start = 0; start < positions.length; start += chunk) {
      const end = Math.min(start + chunk, positions.length);
      for (let at = start; at < end; at += 3) {
        point.fromArray(positions, at);
        maxRadiusSq = Math.max(maxRadiusSq, sphere.center.distanceToSquared(point));
      }
      yield;
    }
    sphere.radius = Math.sqrt(maxRadiusSq);
    geometry.boundingSphere = sphere;
    completed = true;
    return geometry;
  } finally {
    if (!completed) geometry.dispose();
  }
}

/** Model-to-scene and its inverse are both (-x,z,y); bounds are collected only for positions. */
function copyWmoVectors(
  source: ArrayLike<number>, target: Float32Array, start: number, end: number,
  bounds?: THREE.Box3, point?: THREE.Vector3,
): void {
  for (let at = start; at < end; at += 3) {
    target[at] = -source[at]!;
    target[at + 1] = source[at + 2]!;
    target[at + 2] = source[at + 1]!;
    if (bounds && point) bounds.expandByPoint(point.fromArray(target, at));
  }
}

/** Three's indexed normal accumulation, preserving per-triangle Float32 writes and rounding. */
function* computeVertexNormalsSteps(geometry: THREE.BufferGeometry): Generator<void, void, void> {
  const position = geometry.getAttribute("position");
  const index = geometry.index!;
  const normals = new THREE.BufferAttribute(new Float32Array(position.count * 3), 3);
  geometry.setAttribute("normal", normals);
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
  const nA = new THREE.Vector3(), nB = new THREE.Vector3(), nC = new THREE.Vector3();
  const cb = new THREE.Vector3(), ab = new THREE.Vector3();
  for (let at = 0; at < index.count; at += 3) {
    const a = index.getX(at), b = index.getX(at + 1), c = index.getX(at + 2);
    pA.fromBufferAttribute(position, a);
    pB.fromBufferAttribute(position, b);
    pC.fromBufferAttribute(position, c);
    cb.subVectors(pC, pB);
    ab.subVectors(pA, pB);
    cb.cross(ab);
    // Read all three before writing: degenerate triangles may repeat a vertex index.
    nA.fromBufferAttribute(normals, a).add(cb);
    nB.fromBufferAttribute(normals, b).add(cb);
    nC.fromBufferAttribute(normals, c).add(cb);
    normals.setXYZ(a, nA.x, nA.y, nA.z);
    normals.setXYZ(b, nB.x, nB.y, nB.z);
    normals.setXYZ(c, nC.x, nC.y, nC.z);
    if ((at + 3) % (WMO_GEOMETRY_STEP_VERTICES * 3) === 0) yield;
  }
  for (let vertex = 0; vertex < normals.count; vertex++) {
    nA.fromBufferAttribute(normals, vertex).normalize();
    normals.setXYZ(vertex, nA.x, nA.y, nA.z);
    if ((vertex + 1) % WMO_GEOMETRY_STEP_VERTICES === 0) yield;
  }
  normals.needsUpdate = true;
}
