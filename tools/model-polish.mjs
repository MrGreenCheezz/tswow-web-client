// 04.11 (the owner's pilot): an M2's geometry refined offline, with nothing resolved and no archive read.
//
// Three passes over what `parseM2` returns, each a pure function from a model to a model:
// - `smoothModel`: rounds a silhouette by PN triangles (Vlachos 2001) over the authored normals. An edge
//   is split only where its normals say it is curved, so a crate stays a crate and a barrel gets rounder;
//   the old vertices stay where they are, so bones, attachments and the texture do not move.
// - `displaceByHeight`: moves vertices along the normal by a height map per submesh (the DeepBump maps of
//   tools/neural-relief.mjs) after refining the mesh to the map's detail.
// - `bakeVertexAo`: self-occlusion by rays against the model's own triangles, written into the length of
//   the normal (`AO_NORMAL_FLOOR`), which needs no new stream: every lit path normalises it anyway, and
//   `src/browser/ModelVertexAo.ts` reads it back only on a model whose artifact sets the flag.
//
// Nothing here may open a crack. Two triangles that share an edge by position (a UV seam splits the
// vertices, not the surface) must agree on every new point, so a new point is worked out once per welded
// edge, from one canonical pair of vertices. An edge whose two sides disagree on a normal (a hard edge) or
// on a skin, or which touches a batch that is not solid, is left exactly as authored.

/** The length of a normal whose vertex is fully occluded; a fully open one keeps length 1. */
export const AO_NORMAL_FLOOR = 0.25;

/** Vertices closer than 1/1024 yard are one point of the surface. */
const WELD_SCALE = 1024;
/** Two normals closer than this on one welded point are the same normal (a UV seam, not a hard edge). */
const SAME_NORMAL_COS = 0.995;
/** Past this between the two ends an edge is a crease the author shaded smooth: a soft-shaded box is 70°. */
const MAX_EDGE_TURN_COS = Math.cos((55 * Math.PI) / 180);
/**
 * Past this from any face round a vertex, the vertex's normal is an average over a corner and no tangent: a square
 * post shaded smooth has it at 45° and would swell along its whole length like a coffin (measured on LAMPPOST). A
 * five-sided column is 36° and still reads as round; foliage normals blown out to a sphere are far past it.
 */
const MAX_NORMAL_TILT_COS = Math.cos((42 * Math.PI) / 180);
/** Two faces folded past this over their edge meet at a corner, however its normals are shaded: a hexagon is 60°. */
const MAX_DIHEDRAL_COS = Math.cos((65 * Math.PI) / 180);
/** A fan of faces within this of their mean is flat (3°), and a normal may lean off a flat fan by this (6°). */
const FLAT_FAN_COS = Math.cos((3 * Math.PI) / 180);
const FLAT_LEAN_COS = Math.cos((6 * Math.PI) / 180);
/** A curve that deep against its chord (half-angle over 37°) is bad data, not a curve. */
const MAX_SAG_RATIO = 0.16;

const MATERIAL_UNLIT = 0x01;
const MATERIAL_BILLBOARD = 0x08;
const BLEND_OPAQUE = 0;
const BLEND_ALPHA_KEY = 1;

/** Per submesh: 2 solid (every batch opaque and lit), 1 alpha-keyed (cards, hair), 0 anything else. */
export function submeshKinds(model) {
  const kinds = new Uint8Array(model.submeshes.length);
  const seen = new Uint8Array(model.submeshes.length);
  kinds.fill(2);
  for (const batch of model.batches) {
    const submesh = batch.submesh;
    if (submesh >= kinds.length) continue;
    seen[submesh] = 1;
    const flags = batch.materialFlags ?? 0;
    let kind = 2;
    if (batch.blendMode === BLEND_ALPHA_KEY) kind = 1;
    else if (batch.blendMode !== BLEND_OPAQUE) kind = 0;
    if ((flags & (MATERIAL_UNLIT | MATERIAL_BILLBOARD)) !== 0 || (batch.textureTransform ?? -1) >= 0) kind = 0;
    kinds[submesh] = Math.min(kinds[submesh], kind);
  }
  for (let index = 0; index < kinds.length; index++) if (!seen[index]) kinds[index] = 0;
  return kinds;
}

function weldVertices(positions) {
  const count = positions.length / 3;
  const weld = new Int32Array(count);
  const seen = new Map();
  for (let vertex = 0; vertex < count; vertex++) {
    const key = `${Math.round(positions[vertex * 3] * WELD_SCALE)},${Math.round(positions[vertex * 3 + 1] * WELD_SCALE)},`
      + `${Math.round(positions[vertex * 3 + 2] * WELD_SCALE)}`;
    let id = seen.get(key);
    if (id === undefined) seen.set(key, id = seen.size);
    weld[vertex] = id;
  }
  return { weld, points: seen.size };
}

function unitNormals(normals) {
  const result = new Float32Array(normals.length);
  for (let at = 0; at < normals.length; at += 3) {
    const length = Math.hypot(normals[at], normals[at + 1], normals[at + 2]);
    if (length > 1e-6) {
      result[at] = normals[at] / length;
      result[at + 1] = normals[at + 1] / length;
      result[at + 2] = normals[at + 2] / length;
    } else result[at + 2] = 1; // A zero normal lights nothing; up is as good as any and keeps the length meaningful.
  }
  return result;
}

function sameSkin(model, a, b) {
  for (let slot = 0; slot < 4; slot++) {
    if (model.boneWeights[a * 4 + slot] !== model.boneWeights[b * 4 + slot]) return false;
    if (model.boneWeights[a * 4 + slot] > 0 && model.boneIndices[a * 4 + slot] !== model.boneIndices[b * 4 + slot]) return false;
  }
  return true;
}

/** The four strongest influences of the two ends, equally weighted, summing to 255 as the file's do. */
function blendSkin(model, a, b, boneIndices, boneWeights, target) {
  const weights = new Map();
  for (const vertex of [a, b]) {
    for (let slot = 0; slot < 4; slot++) {
      const weight = model.boneWeights[vertex * 4 + slot];
      if (weight > 0) weights.set(model.boneIndices[vertex * 4 + slot], (weights.get(model.boneIndices[vertex * 4 + slot]) ?? 0) + weight / 2);
    }
  }
  const kept = [...weights.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]).slice(0, 4);
  const total = kept.reduce((sum, [, weight]) => sum + weight, 0);
  let left = 255;
  kept.forEach(([bone, weight], slot) => {
    const share = slot === kept.length - 1 ? left : Math.round((weight / total) * 255);
    boneIndices[target * 4 + slot] = bone;
    boneWeights[target * 4 + slot] = share;
    left -= share;
  });
}

/**
 * One refinement: `split(edge)` decides per welded edge and returns the new point, or nothing.
 *
 * An edge is `{ a, b, blocked, hard, length }`; `a`/`b` are its canonical vertices. A triangle takes the
 * pattern its split edges ask for, in place, so the file's triangle order — the draw order — survives.
 */
function refine(model, kinds, normals, split) {
  const { weld } = weldVertices(model.positions);
  const positions = model.positions;
  const indices = model.indices;
  const edges = new Map();
  const faceOf = (a, b, c) => {
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    return length > 1e-12 ? [nx / length, ny / length, nz / length] : undefined;
  };
  const edgeKey = (a, b) => (weld[a] < weld[b] ? `${weld[a]}:${weld[b]}` : `${weld[b]}:${weld[a]}`);
  const dot = (a, b) => normals[a * 3] * normals[b * 3] + normals[a * 3 + 1] * normals[b * 3 + 1] + normals[a * 3 + 2] * normals[b * 3 + 2];

  // A vertex whose normal leaves any of its faces too far is a corner, whichever edge is being asked about.
  // And a normal leaning off a flat fan of faces describes a curve that is not there: a painting's canvas, whose
  // corners lean with the frame beside it, would sink through the wall behind (measured in Goldshire's inn). The fan
  // is taken over every copy of the point sharing this normal, so a UV seam does not narrow it; a fan that is not
  // flat is left alone, since the rim of an open bowl leans past its faces and is a real curve.
  const corner = new Uint8Array(positions.length / 3);
  const fans = new Map();
  const fanOf = (vertex) => {
    const key = `${weld[vertex]}/${Math.round(normals[vertex * 3] * 64)},${Math.round(normals[vertex * 3 + 1] * 64)},${Math.round(normals[vertex * 3 + 2] * 64)}`;
    let fan = fans.get(key);
    if (!fan) fans.set(key, fan = { vertices: new Set(), faces: [] });
    fan.vertices.add(vertex);
    return fan;
  };
  model.submeshes.forEach((submesh) => {
    for (let at = submesh.indexStart; at + 2 < submesh.indexStart + submesh.indexCount; at += 3) {
      const vertices = [indices[at], indices[at + 1], indices[at + 2]];
      const face = faceOf(...vertices);
      if (!face) continue;
      for (const vertex of vertices) {
        fanOf(vertex).faces.push(face);
        if (normals[vertex * 3] * face[0] + normals[vertex * 3 + 1] * face[1] + normals[vertex * 3 + 2] * face[2] < MAX_NORMAL_TILT_COS) corner[vertex] = 1;
      }
    }
  });
  for (const fan of fans.values()) {
    const mean = [0, 0, 0];
    for (const face of fan.faces) for (let axis = 0; axis < 3; axis++) mean[axis] += face[axis];
    const length = Math.hypot(...mean);
    if (length < 1e-6) continue;
    let spread = 1;
    for (const face of fan.faces) spread = Math.min(spread, (face[0] * mean[0] + face[1] * mean[1] + face[2] * mean[2]) / length);
    if (spread < FLAT_FAN_COS) continue;
    const vertex = fan.vertices.values().next().value;
    const lean = (normals[vertex * 3] * mean[0] + normals[vertex * 3 + 1] * mean[1] + normals[vertex * 3 + 2] * mean[2]) / length;
    if (lean < FLAT_LEAN_COS) for (const copy of fan.vertices) corner[copy] = 1;
  }

  model.submeshes.forEach((submesh, index) => {
    const solid = kinds[index] === 2;
    for (let at = submesh.indexStart; at + 2 < submesh.indexStart + submesh.indexCount; at += 3) {
      const corners = [indices[at], indices[at + 1], indices[at + 2]];
      const face = faceOf(...corners);
      for (let side = 0; side < 3; side++) {
        let a = corners[side];
        let b = corners[(side + 1) % 3];
        if (weld[a] === weld[b]) continue;
        if (weld[a] > weld[b]) [a, b] = [b, a];
        const key = edgeKey(a, b);
        let edge = edges.get(key);
        if (!edge) edges.set(key, edge = { a, b, blocked: false, hard: false, face, instances: [] });
        else {
          if (dot(edge.a, a) < SAME_NORMAL_COS || dot(edge.b, b) < SAME_NORMAL_COS) edge.hard = true;
          if (!sameSkin(model, edge.a, a) || !sameSkin(model, edge.b, b)) edge.blocked = true;
          if (edge.face && face && edge.face[0] * face[0] + edge.face[1] * face[1] + edge.face[2] * face[2] < MAX_DIHEDRAL_COS) edge.hard = true;
        }
        edge.instances.push(a, b);
        if (!solid || !face) edge.blocked = true;
        if (corner[a] || corner[b]) edge.hard = true;
      }
    }
  });

  let splits = 0;
  for (const edge of edges.values()) {
    edge.point = edge.blocked ? undefined : split(edge, positions, normals);
    if (edge.point) splits++;
  }
  if (splits === 0) return undefined;

  const count = positions.length / 3;
  const newPositions = [];
  const newNormals = [];
  const newUv0 = [];
  const newUv1 = [];
  const pairs = new Map();
  const midpoint = (u, v) => {
    const edge = edges.get(edgeKey(u, v));
    if (!edge?.point) return -1;
    const key = u < v ? `${u}:${v}` : `${v}:${u}`;
    let vertex = pairs.get(key);
    if (vertex !== undefined) return vertex;
    vertex = count + pairs.size;
    pairs.set(key, vertex);
    newPositions.push(...edge.point.position);
    if (edge.point.normal) newNormals.push(...edge.point.normal);
    else {
      // A straight split keeps each side's own normal, or a hard edge would turn soft.
      const x = normals[u * 3] + normals[v * 3];
      const y = normals[u * 3 + 1] + normals[v * 3 + 1];
      const z = normals[u * 3 + 2] + normals[v * 3 + 2];
      const length = Math.hypot(x, y, z) || 1;
      newNormals.push(x / length, y / length, z / length);
    }
    for (const [target, source] of [[newUv0, model.uv0], [newUv1, model.uv1]]) {
      target.push((source[u * 2] + source[v * 2]) / 2, (source[u * 2 + 1] + source[v * 2 + 1]) / 2);
    }
    return vertex;
  };

  const newIndices = [];
  const submeshes = model.submeshes.map((submesh) => {
    const indexStart = newIndices.length;
    for (let at = submesh.indexStart; at + 2 < submesh.indexStart + submesh.indexCount; at += 3) {
      const a = indices[at];
      const b = indices[at + 1];
      const c = indices[at + 2];
      const ab = weld[a] === weld[b] ? -1 : midpoint(a, b);
      const bc = weld[b] === weld[c] ? -1 : midpoint(b, c);
      const ca = weld[c] === weld[a] ? -1 : midpoint(c, a);
      const pattern = (ab >= 0 ? 1 : 0) | (bc >= 0 ? 2 : 0) | (ca >= 0 ? 4 : 0);
      switch (pattern) {
        case 0: newIndices.push(a, b, c); break;
        case 1: newIndices.push(a, ab, c, ab, b, c); break;
        case 2: newIndices.push(a, b, bc, a, bc, c); break;
        case 4: newIndices.push(a, b, ca, b, c, ca); break;
        case 3: newIndices.push(a, ab, c, ab, bc, c, ab, b, bc); break;
        case 6: newIndices.push(a, b, ca, b, bc, ca, bc, c, ca); break;
        case 5: newIndices.push(a, ab, ca, ab, b, ca, b, c, ca); break;
        default: newIndices.push(a, ab, ca, ab, b, bc, bc, c, ca, ab, bc, ca); break;
      }
    }
    return { ...submesh, indexStart, indexCount: newIndices.length - indexStart };
  });

  const total = count + pairs.size;
  const concat = (old, extra, size) => {
    const result = new Float32Array(total * size);
    result.set(old);
    result.set(extra, count * size);
    return result;
  };
  const boneIndices = new Uint8Array(total * 4);
  const boneWeights = new Uint8Array(total * 4);
  boneIndices.set(model.boneIndices);
  boneWeights.set(model.boneWeights);
  for (const [key, vertex] of pairs) {
    const [u, v] = key.split(":").map(Number);
    blendSkin(model, u, v, boneIndices, boneWeights, vertex);
  }
  return {
    ...model,
    positions: concat(positions, newPositions, 3),
    normals: concat(normals, newNormals, 3),
    uv0: concat(model.uv0, newUv0, 2),
    uv1: concat(model.uv1, newUv1, 2),
    boneIndices,
    boneWeights,
    indices: Uint32Array.from(newIndices),
    submeshes,
  };
}

function modelRadius(model) {
  const { positions } = model;
  let radius = 0;
  for (let at = 0; at < positions.length; at += 3) {
    radius = Math.max(radius, Math.hypot(positions[at], positions[at + 1], positions[at + 2]));
  }
  return radius;
}

/** The authored bounds, grown (never shrunk) to hold every vertex: culling reads them. */
function grownBounds(model) {
  const bounds = model.bounds ?? { min: [0, 0, 0], max: [0, 0, 0], radius: 0 };
  const min = [...bounds.min];
  const max = [...bounds.max];
  let radius = bounds.radius;
  const { positions } = model;
  for (let at = 0; at < positions.length; at += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[at + axis]);
      max[axis] = Math.max(max[axis], positions[at + axis]);
    }
    radius = Math.max(radius, Math.hypot(positions[at], positions[at + 1], positions[at + 2]));
  }
  return { min, max, radius };
}

/**
 * Rounds the silhouette. `levels` is how many times an edge may be halved (1 → up to ×4, 2 → up to ×16
 * triangles, but only on edges that are curved). `sag` is how far a curve must leave its chord to be worth a
 * vertex, as a share of the chord: an arc turning by 2θ over an edge sags θ/4 of it, so 0.012 is ≈ 5.5° of turn.
 */
export function smoothModel(model, options = {}) {
  const { levels = 2, sag: sagRatio = 0.012, minSag = 0.0005, minEdge = 0.004 } = options;
  const radius = modelRadius(model);
  const kinds = submeshKinds(model);
  let current = { ...model, normals: unitNormals(model.normals) };
  for (let level = 0; level < levels; level++) {
    const next = refine(current, kinds, current.normals, (edge, positions, normals) => {
      if (edge.hard) return undefined;
      const { a, b } = edge;
      const dx = positions[b * 3] - positions[a * 3];
      const dy = positions[b * 3 + 1] - positions[a * 3 + 1];
      const dz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const length = Math.hypot(dx, dy, dz);
      if (length < minEdge * radius) return undefined;
      const [ax, ay, az] = [normals[a * 3], normals[a * 3 + 1], normals[a * 3 + 2]];
      const [bx, by, bz] = [normals[b * 3], normals[b * 3 + 1], normals[b * 3 + 2]];
      if (ax * bx + ay * by + az * bz < MAX_EDGE_TURN_COS) return undefined;
      // The cubic's midpoint reduces to the chord's plus this (w_ij = (p_j − p_i)·n_i), one point per edge.
      const wa = dx * ax + dy * ay + dz * az;
      const wb = -(dx * bx + dy * by + dz * bz);
      const sx = -(wa * ax + wb * bx) / 8;
      const sy = -(wa * ay + wb * by) / 8;
      const sz = -(wa * az + wb * bz) / 8;
      const sag = Math.hypot(sx, sy, sz);
      if (sag < Math.max(sagRatio * length, minSag * radius) || sag > MAX_SAG_RATIO * length) return undefined;
      // Only outward. An edge that would sink has a panel set in a frame at it, not a hollow: the normals averaged
      // over the crease lean inward, and the canvas of a painting went through the wall behind (Goldshire's inn).
      if (sx * (ax + bx) + sy * (ay + by) + sz * (az + bz) < 0) return undefined;
      // PN's quadratic normal, which also carries an inflection the cubic has.
      const v = (2 * (dx * (ax + bx) + dy * (ay + by) + dz * (az + bz))) / (length * length);
      const nx = ax + bx - v * dx;
      const ny = ay + by - v * dy;
      const nz = az + bz - v * dz;
      const normal = Math.hypot(nx, ny, nz) || 1;
      return {
        position: [
          (positions[a * 3] + positions[b * 3]) / 2 + sx,
          (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2 + sy,
          (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2 + sz,
        ],
        normal: [nx / normal, ny / normal, nz / normal],
      };
    });
    if (!next) break;
    current = next;
  }
  return { ...current, bounds: grownBounds(current) };
}

/** Bilinear height of a map at a UV, in texels of its texture; wrapping as its slot says. */
function sampleHeight(map, u, v) {
  const fold = (value, wrap) => (wrap ? value - Math.floor(value) : Math.max(0, Math.min(1, value)));
  const texel = (index, size, wrap) => (wrap ? (index + size) % size : Math.max(0, Math.min(size - 1, index)));
  const x = fold(u, map.wrapX) * map.width - 0.5;
  const y = fold(v, map.wrapY) * map.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (column, row) => map.data[texel(row, map.height, map.wrapY) * map.width + texel(column, map.width, map.wrapX)];
  return ((at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy) / 256;
}

/**
 * Real relief from height maps: refine where an edge spans more texels than `texels`, then move each point
 * along its welded normal. `heightOf(submeshIndex)` answers `{ width, height, data: Int16Array, wrapX, wrapY }`
 * (data in 1/256 texel) or nothing. Every copy of a welded point moves by one vector, and a point touching
 * anything that does not displace (no map, not solid) stays, so the surface cannot tear.
 */
export function displaceByHeight(model, heightOf, options = {}) {
  const { levels = 2, texels = 10, minEdge = 0.012, gain = 1, maxDepth = 0.03, budget = 60_000 } = options;
  const radius = modelRadius(model);
  const kinds = submeshKinds(model);
  const maps = model.submeshes.map((_, index) => (kinds[index] === 2 ? heightOf(index) : undefined));
  if (!maps.some(Boolean)) return model;
  let current = { ...model, normals: unitNormals(model.normals) };
  const blockedKinds = Uint8Array.from(kinds, (kind, index) => (kind === 2 && maps[index] ? 2 : 0));
  const uvSpan = (a, b, map, source) => Math.hypot((source[a * 2] - source[b * 2]) * map.width, (source[a * 2 + 1] - source[b * 2 + 1]) * map.height);
  for (let level = 0; level < levels && current.indices.length / 3 < budget; level++) {
    // Which map an instance of an edge reads: the widest span over the submeshes the vertices are in.
    const vertexMap = new Array(current.positions.length / 3);
    current.submeshes.forEach((submesh, index) => {
      if (!maps[index]) return;
      for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at++) vertexMap[current.indices[at]] = maps[index];
    });
    const next = refine(current, blockedKinds, current.normals, (edge, positions) => {
      const { a, b } = edge;
      const length = Math.hypot(positions[b * 3] - positions[a * 3], positions[b * 3 + 1] - positions[a * 3 + 1], positions[b * 3 + 2] - positions[a * 3 + 2]);
      if (length < minEdge * radius) return undefined;
      let span = 0;
      for (let at = 0; at < edge.instances.length; at += 2) {
        const map = vertexMap[edge.instances[at]];
        if (map) span = Math.max(span, uvSpan(edge.instances[at], edge.instances[at + 1], map, current.uv0));
      }
      if (span < texels) return undefined;
      return { position: [
        (positions[a * 3] + positions[b * 3]) / 2,
        (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
      ] };
    });
    if (!next) break;
    current = next;
  }

  const count = current.positions.length / 3;
  const { positions, normals, uv0, indices } = current;
  const { weld, points } = weldVertices(positions);
  // Per point: the mean depth over the copies that have a map, the mean normal, whether anything pins it.
  const depth = new Float64Array(points);
  const samples = new Uint32Array(points);
  const pinned = new Uint8Array(points);
  const direction = new Float64Array(points * 3);
  const texelSize = new Float64Array(count);
  const texelWeight = new Float64Array(count);
  const vertexMap = new Array(count);
  current.submeshes.forEach((submesh, index) => {
    const map = maps[index];
    for (let at = submesh.indexStart; at + 2 < submesh.indexStart + submesh.indexCount; at += 3) {
      const corners = [indices[at], indices[at + 1], indices[at + 2]];
      if (!map) {
        for (const vertex of corners) pinned[weld[vertex]] = 1;
        continue;
      }
      const [a, b, c] = corners;
      const area = Math.hypot(
        (positions[b * 3 + 1] - positions[a * 3 + 1]) * (positions[c * 3 + 2] - positions[a * 3 + 2]) - (positions[b * 3 + 2] - positions[a * 3 + 2]) * (positions[c * 3 + 1] - positions[a * 3 + 1]),
        (positions[b * 3 + 2] - positions[a * 3 + 2]) * (positions[c * 3] - positions[a * 3]) - (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 2] - positions[a * 3 + 2]),
        (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 1] - positions[a * 3 + 1]) - (positions[b * 3 + 1] - positions[a * 3 + 1]) * (positions[c * 3] - positions[a * 3]),
      ) / 2;
      const uvArea = Math.abs((uv0[b * 2] - uv0[a * 2]) * (uv0[c * 2 + 1] - uv0[a * 2 + 1]) - (uv0[c * 2] - uv0[a * 2]) * (uv0[b * 2 + 1] - uv0[a * 2 + 1])) / 2 * map.width * map.height;
      if (uvArea < 1e-6) continue;
      const size = Math.sqrt(area / uvArea);
      for (const vertex of corners) {
        texelSize[vertex] += size * area;
        texelWeight[vertex] += area;
        vertexMap[vertex] = map;
      }
    }
  });
  const limit = maxDepth * radius;
  for (let vertex = 0; vertex < count; vertex++) {
    const point = weld[vertex];
    direction[point * 3] += normals[vertex * 3];
    direction[point * 3 + 1] += normals[vertex * 3 + 1];
    direction[point * 3 + 2] += normals[vertex * 3 + 2];
    if (!vertexMap[vertex] || texelWeight[vertex] === 0) continue;
    const size = texelSize[vertex] / texelWeight[vertex];
    depth[point] += Math.max(-limit, Math.min(limit, sampleHeight(vertexMap[vertex], uv0[vertex * 2], uv0[vertex * 2 + 1]) * size * gain));
    samples[point]++;
  }

  const moved = new Float32Array(positions);
  let displaced = 0;
  for (let vertex = 0; vertex < count; vertex++) {
    const point = weld[vertex];
    if (pinned[point] || samples[point] === 0) continue;
    const length = Math.hypot(direction[point * 3], direction[point * 3 + 1], direction[point * 3 + 2]);
    if (length < 1e-6) continue;
    const by = depth[point] / samples[point] / length;
    moved[vertex * 3] += direction[point * 3] * by;
    moved[vertex * 3 + 1] += direction[point * 3 + 1] * by;
    moved[vertex * 3 + 2] += direction[point * 3 + 2] * by;
    displaced++;
  }

  // The normals follow by what the faces did, per group of copies sharing a normal: a hard edge stays hard.
  const groupOf = (vertex) => `${weld[vertex]}/${Math.round(normals[vertex * 3] * 32)},${Math.round(normals[vertex * 3 + 1] * 32)},${Math.round(normals[vertex * 3 + 2] * 32)}`;
  const groups = new Map();
  const faceSum = (source, a, b, c) => {
    const ux = source[b * 3] - source[a * 3];
    const uy = source[b * 3 + 1] - source[a * 3 + 1];
    const uz = source[b * 3 + 2] - source[a * 3 + 2];
    const vx = source[c * 3] - source[a * 3];
    const vy = source[c * 3 + 1] - source[a * 3 + 1];
    const vz = source[c * 3 + 2] - source[a * 3 + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  for (const submesh of current.submeshes) {
    for (let at = submesh.indexStart; at + 2 < submesh.indexStart + submesh.indexCount; at += 3) {
      const [a, b, c] = [indices[at], indices[at + 1], indices[at + 2]];
      const before = faceSum(positions, a, b, c);
      const after = faceSum(moved, a, b, c);
      for (const vertex of [a, b, c]) {
        const key = groupOf(vertex);
        let group = groups.get(key);
        if (!group) groups.set(key, group = [0, 0, 0, 0, 0, 0]);
        for (let axis = 0; axis < 3; axis++) {
          group[axis] += before[axis];
          group[axis + 3] += after[axis];
        }
      }
    }
  }
  const newNormals = new Float32Array(normals);
  for (let vertex = 0; vertex < count; vertex++) {
    const group = groups.get(groupOf(vertex));
    if (!group) continue;
    const before = Math.hypot(group[0], group[1], group[2]);
    const after = Math.hypot(group[3], group[4], group[5]);
    if (before < 1e-12 || after < 1e-12) continue;
    const x = normals[vertex * 3] + group[3] / after - group[0] / before;
    const y = normals[vertex * 3 + 1] + group[4] / after - group[1] / before;
    const z = normals[vertex * 3 + 2] + group[5] / after - group[2] / before;
    const length = Math.hypot(x, y, z);
    if (length < 1e-6) continue;
    newNormals[vertex * 3] = x / length;
    newNormals[vertex * 3 + 1] = y / length;
    newNormals[vertex * 3 + 2] = z / length;
  }
  const result = { ...current, positions: moved, normals: newNormals, displacedVertices: displaced };
  return { ...result, bounds: grownBounds(result) };
}

/** A two-level split over triangle centroids: flat arrays, a closest-hit walk with no allocation. */
function buildBvh(positions, triangles) {
  const count = triangles.length / 4;
  const order = new Uint32Array(count).map((_, index) => index);
  const centres = new Float32Array(count * 3);
  for (let tri = 0; tri < count; tri++) {
    for (let axis = 0; axis < 3; axis++) {
      centres[tri * 3 + axis] = (positions[triangles[tri * 4] * 3 + axis] + positions[triangles[tri * 4 + 1] * 3 + axis] + positions[triangles[tri * 4 + 2] * 3 + axis]) / 3;
    }
  }
  const lower = [];
  const upper = [];
  const left = [];
  const right = [];
  const first = [];
  const size = [];
  const build = (start, end) => {
    const node = first.length;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let at = start; at < end; at++) {
      for (let corner = 0; corner < 3; corner++) {
        const vertex = triangles[order[at] * 4 + corner];
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], positions[vertex * 3 + axis]);
          max[axis] = Math.max(max[axis], positions[vertex * 3 + axis]);
        }
      }
    }
    lower.push(...min);
    upper.push(...max);
    left.push(0);
    right.push(0);
    first.push(start);
    size.push(end - start);
    if (end - start <= 4) return node;
    const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axis = extent[0] >= extent[1] && extent[0] >= extent[2] ? 0 : extent[1] >= extent[2] ? 1 : 2;
    const middle = (start + end) >> 1;
    const part = Array.from(order.subarray(start, end)).sort((a, b) => centres[a * 3 + axis] - centres[b * 3 + axis]);
    order.set(part, start);
    size[node] = 0;
    left[node] = build(start, middle);
    right[node] = build(middle, end);
    return node;
  };
  if (count > 0) build(0, count);
  return { positions, triangles, order, lower: Float32Array.from(lower), upper: Float32Array.from(upper),
    left: Int32Array.from(left), right: Int32Array.from(right), first: Int32Array.from(first), size: Int32Array.from(size) };
}

/** Closest hit along a ray within `reach`; `bvh.hitWeight` is what the triangle hit weighs. Returns the distance. */
function castRay(bvh, ox, oy, oz, dx, dy, dz, reach, stack) {
  const { positions, triangles, order, lower, upper, left, right, first, size } = bvh;
  if (first.length === 0) return Infinity;
  let closest = reach;
  let found = -1;
  const ix = 1 / dx;
  const iy = 1 / dy;
  const iz = 1 / dz;
  let top = 0;
  stack[top++] = 0;
  while (top > 0) {
    const node = stack[--top];
    let t0 = (lower[node * 3] - ox) * ix;
    let t1 = (upper[node * 3] - ox) * ix;
    let near = Math.min(t0, t1);
    let far = Math.max(t0, t1);
    t0 = (lower[node * 3 + 1] - oy) * iy;
    t1 = (upper[node * 3 + 1] - oy) * iy;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
    t0 = (lower[node * 3 + 2] - oz) * iz;
    t1 = (upper[node * 3 + 2] - oz) * iz;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
    if (far < 0 || near > far || near > closest) continue;
    if (size[node] === 0) {
      stack[top++] = left[node];
      stack[top++] = right[node];
      continue;
    }
    for (let at = first[node]; at < first[node] + size[node]; at++) {
      const tri = order[at];
      const a = triangles[tri * 4] * 3;
      const b = triangles[tri * 4 + 1] * 3;
      const c = triangles[tri * 4 + 2] * 3;
      const e1x = positions[b] - positions[a];
      const e1y = positions[b + 1] - positions[a + 1];
      const e1z = positions[b + 2] - positions[a + 2];
      const e2x = positions[c] - positions[a];
      const e2y = positions[c + 1] - positions[a + 1];
      const e2z = positions[c + 2] - positions[a + 2];
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inverse = 1 / det;
      const sx = ox - positions[a];
      const sy = oy - positions[a + 1];
      const sz = oz - positions[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inverse;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inverse;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
      if (t > 0 && t < closest) {
        closest = t;
        found = tri;
      }
    }
  }
  if (found < 0) return Infinity;
  bvh.hitWeight = triangles[found * 4 + 3] === 2 ? 1 : 0.5;
  return closest;
}

/**
 * Ambient occlusion from the model's own triangles. `rays` per vertex, cosine-weighted, reaching a share of
 * the model's radius; a hit counts for less the farther it is. Solid triangles occlude fully, alpha-keyed ones
 * (leaves, chains) half. `ground` adds the plane z = 0 the doodad stands on, unless it is not near it.
 * A model whose geosets are chosen per appearance would darken itself with parts it may not wear, so `occluder`
 * may narrow which submeshes count.
 */
export function bakeVertexAo(model, options = {}) {
  const { rays = 64, reach = 0.45, maxReach = 6, ground = true, groundWeight = 0.7, occluder = () => true } = options;
  const kinds = submeshKinds(model);
  const normals = unitNormals(model.normals);
  const { positions, indices } = model;
  const count = positions.length / 3;
  const radius = Math.max(modelRadius(model), 1e-3);
  const distance = Math.min(maxReach, radius * reach);
  const triangles = [];
  const shaded = new Uint8Array(count);
  model.submeshes.forEach((submesh, index) => {
    const kind = kinds[index];
    const blocks = kind > 0 && occluder(submesh, index);
    for (let at = submesh.indexStart; at + 2 < submesh.indexStart + submesh.indexCount; at += 3) {
      if (blocks) triangles.push(indices[at], indices[at + 1], indices[at + 2], kind);
      if (kind === 2) for (let corner = 0; corner < 3; corner++) shaded[indices[at + corner]] = 1;
    }
  });
  const bvh = buildBvh(positions, triangles);
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let at = 2; at < positions.length; at += 3) {
    minZ = Math.min(minZ, positions[at]);
    maxZ = Math.max(maxZ, positions[at]);
  }
  const hasGround = ground && minZ <= 0.08 * radius && maxZ > 0;

  // A Fibonacci spiral over the disc, lifted to the hemisphere: cosine-weighted, deterministic.
  const samples = new Float64Array(rays * 3);
  for (let index = 0; index < rays; index++) {
    const r = Math.sqrt((index + 0.5) / rays);
    const angle = index * 2.399963229728653;
    samples[index * 3] = r * Math.cos(angle);
    samples[index * 3 + 1] = r * Math.sin(angle);
    samples[index * 3 + 2] = Math.sqrt(Math.max(0, 1 - r * r));
  }
  const bias = Math.max(radius * 0.001, 0.0005);
  const stack = new Int32Array(128);
  const cache = new Map();
  const result = new Float32Array(count).fill(1);
  const { weld } = weldVertices(positions);
  for (let vertex = 0; vertex < count; vertex++) {
    if (!shaded[vertex]) continue;
    const nx = normals[vertex * 3];
    const ny = normals[vertex * 3 + 1];
    const nz = normals[vertex * 3 + 2];
    // Copies across a UV seam read one answer, so a seam does not show in the shade.
    const key = `${weld[vertex]}/${Math.round(nx * 64)},${Math.round(ny * 64)},${Math.round(nz * 64)}`;
    const known = cache.get(key);
    if (known !== undefined) {
      result[vertex] = known;
      continue;
    }
    // A frame round the normal (Duff et al. 2017).
    const sign = nz >= 0 ? 1 : -1;
    const a = -1 / (sign + nz);
    const b = nx * ny * a;
    const tx = 1 + sign * nx * nx * a;
    const ty = sign * b;
    const tz = -sign * nx;
    const bx = b;
    const by = sign + ny * ny * a;
    const bz = -ny;
    const ox = positions[vertex * 3] + nx * bias;
    const oy = positions[vertex * 3 + 1] + ny * bias;
    const oz = positions[vertex * 3 + 2] + nz * bias;
    let occlusion = 0;
    for (let ray = 0; ray < rays; ray++) {
      const sx = samples[ray * 3];
      const sy = samples[ray * 3 + 1];
      const sz = samples[ray * 3 + 2];
      const dx = tx * sx + bx * sy + nx * sz;
      const dy = ty * sx + by * sy + ny * sz;
      const dz = tz * sx + bz * sy + nz * sz;
      const hit = castRay(bvh, ox, oy, oz, dx, dy, dz, distance, stack);
      let t = hit;
      let weight = hit === Infinity ? 0 : bvh.hitWeight;
      if (hasGround && oz > 0 && dz < 0) {
        const down = -oz / dz;
        if (down < distance && down < t) {
          t = down;
          weight = groundWeight;
        }
      }
      if (t !== Infinity && weight > 0) {
        const near = t / distance;
        occlusion += weight * (1 - near * near);
      }
    }
    const ao = Math.max(0, Math.min(1, 1 - occlusion / rays));
    cache.set(key, ao);
    result[vertex] = ao;
  }
  // Stored in the normal's length; a vertex nothing shades keeps length 1 and so reads back as open.
  const stored = new Float32Array(normals.length);
  let sum = 0;
  let darkest = 1;
  let counted = 0;
  for (let vertex = 0; vertex < count; vertex++) {
    const length = AO_NORMAL_FLOOR + (1 - AO_NORMAL_FLOOR) * result[vertex];
    stored[vertex * 3] = normals[vertex * 3] * length;
    stored[vertex * 3 + 1] = normals[vertex * 3 + 1] * length;
    stored[vertex * 3 + 2] = normals[vertex * 3 + 2] * length;
    if (shaded[vertex]) {
      sum += result[vertex];
      darkest = Math.min(darkest, result[vertex]);
      counted++;
    }
  }
  return { ...model, normals: stored, normalsCarryAo: true, aoStats: { mean: counted ? sum / counted : 1, darkest, vertices: counted } };
}
