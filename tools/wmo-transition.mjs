// 22.10 (7.37): a WMO group's transition vertices, as Wow.exe 12340 holds them once loaded.
//
// The first `MOGP.transBatchCount` batches of a group are its transition batches, and the vertices
// they draw sit at the front of MOVT: everything below `MOBA[transBatchCount - 1].maxIndex + 1`.
// Wow.exe treats that range apart twice before it draws a frame:
//   * `CMapObjGroup::FixColorVertexAlpha` (0x007D7380, only when MOHD 0x8 is clear) halves the MOCV
//     colour there and leaves its alpha, where every vertex past it is brightened by its alpha,
//     (c + (c·a >> 6)) >> 1, and gets an alpha of 0xFF. The bytes at 0x007D73DD are `shr byte
//     [edi+2],1 / [edi+1] / [edi]`, against the multiply-add branch at 0x007D73E7 — no ambient
//     enters either branch.
//   * `CMapObj::AttenTransVerts` (0x007D78C0, on the group's first `RenderGroup` 0x007ABF50) gives
//     each of those vertices an attenuation from the group's portals: 1 − 0.15·d summed over the
//     portals into an outdoor group (MOGI 0x48), d the vertex's distance from the portal (its
//     signed plane distance when it projects inside the polygon, else its distance from the
//     polygon's edge); a vertex within a yard of a portal into another room gets 0. The colour is
//     then pulled towards 127 by it, c + (127 − c)·atten, and the alpha becomes atten·255.
// The batch renderers (classic 0x007AC9F0, unified 0x007A9380) then draw a transition batch twice:
// sun-lit with `GxBlend_SrcAlphaOpaque` (9), then lit by the vertex colour with
// `GxBlend_InvSrcAlphaAdd` (7) — the alpha mixes the sun and the room's light per vertex.
//
// Measured on the Goldshire Inn (classic, MOHD 0x0, ambient 19/16/14): its vestibule, group 0, is
// 70 vertices all drawn by its 3 transition batches, raw MOCV alpha 101 on average. Read through
// the brightening every other vertex gets, they came out 4.78× the light the client gives them.

const MOGP_PORTAL_START = 36;
const MOGP_PORTAL_COUNT = 38;
const MOGP_TRANSITION_BATCHES = 40;
const MOBA_SIZE = 24;
const MOBA_MAX_INDEX = 20;
const MOPT_SIZE = 20;
const MOPR_SIZE = 8;
const MOGI_SIZE = 32;
/** MOGI flags 0x8 (outdoor) or 0x40 (exterior lit): the neighbour test of `AttenTransVerts`. */
const MOGI_EXTERIOR = 0x48;

/** How many of a group's vertices its transition batches own: `MOBA[t − 1].maxIndex + 1`, or 0. */
export function wmoTransitionVertexEnd(mogp, batchData, vertexCount) {
  if (!mogp || mogp.length < MOGP_TRANSITION_BATCHES + 2) return 0;
  const batches = mogp.readUInt16LE(MOGP_TRANSITION_BATCHES);
  if (batches === 0 || !batchData || batches * MOBA_SIZE > batchData.length) return 0;
  return Math.min(vertexCount, batchData.readUInt16LE((batches - 1) * MOBA_SIZE + MOBA_MAX_INDEX) + 1);
}

/** `NTempest::Intersect(point, verts, count, axis)` (0x009830D0): a crossing test in the plane of `axis`. */
function insidePolygon(point, polygon, axis) {
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  let previous = polygon[polygon.length - 1];
  let above = point[v] <= previous[v];
  let inside = false;
  for (const current of polygon) {
    const nowAbove = point[v] <= current[v];
    if (above !== nowAbove
      && ((current[u] - point[u]) * (previous[v] - current[v]) <= (previous[u] - current[u]) * (current[v] - point[v])) === nowAbove) {
      inside = !inside;
    }
    above = nowAbove;
    previous = current;
  }
  return inside;
}

/** `C3Vector::MajorAxis`: 0 x, 1 y, 2 z, ties going to the later axis. */
function majorAxis(normal) {
  const [x, y, z] = normal.map(Math.abs);
  if (x <= y) return y > z ? 1 : 2;
  return x > z ? 0 : 2;
}

/** `NTempest::DistanceFromPolygonEdge` (0x00984DB0): the nearest of the polygon's edge segments. */
function distanceFromPolygonEdge(point, polygon) {
  let best = Infinity;
  let previous = polygon[polygon.length - 1];
  for (const current of polygon) {
    const edge = [current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]];
    const offset = [point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]];
    const length = edge[0] * edge[0] + edge[1] * edge[1] + edge[2] * edge[2];
    const t = length > 0 ? Math.min(1, Math.max(0, (offset[0] * edge[0] + offset[1] * edge[1] + offset[2] * edge[2]) / length)) : 0;
    best = Math.min(best, Math.hypot(offset[0] - edge[0] * t, offset[1] - edge[1] * t, offset[2] - edge[2] * t));
    previous = current;
  }
  return best;
}

/**
 * `AttenTransVerts`' factor for one vertex, 0 to 1. `portals` is the group's own slice of MOPR,
 * each with its MOPT plane and polygon and whether the group behind it is outdoor (MOGI 0x48).
 */
export function wmoTransitionAttenuation(vertex, portals) {
  let attenuation = 0;
  for (const portal of portals) {
    const { normal, distance: planeDistance, polygon } = portal;
    const side = normal[0] * vertex[0] + normal[1] * vertex[1] + normal[2] * vertex[2] + planeDistance;
    // The client casts a ray along the normal onto the plane; MOPT normals are unit length.
    const onPlane = Math.abs(side) > 0.001
      ? [vertex[0] - normal[0] * side, vertex[1] - normal[1] * side, vertex[2] - normal[2] * side]
      : vertex;
    let distance;
    if (polygon.length > 0 && insidePolygon(onPlane, polygon, majorAxis(normal))) {
      distance = portal.side !== 1 ? -side : side;
    } else {
      distance = polygon.length > 0 ? distanceFromPolygonEdge(vertex, polygon) : Infinity;
    }
    if (portal.exterior) {
      const weight = 1 - Math.max(0, distance) * 0.15;
      if (weight > 0.001) attenuation += weight;
    } else if (distance > -1 && distance < 1) {
      return 0;
    }
  }
  return attenuation <= 0.001 ? 0 : Math.min(1, attenuation);
}

/** The group's portals as `wmoTransitionAttenuation` reads them, from the root's chunks. */
export function wmoGroupTransitionPortals(rootChunks, mogp) {
  const vertices = rootChunks.get("MOPV");
  const definitions = rootChunks.get("MOPT");
  const references = rootChunks.get("MOPR");
  const info = rootChunks.get("MOGI");
  const portals = [];
  if (!vertices || !definitions || !references || !mogp || mogp.length < MOGP_PORTAL_COUNT + 2) return portals;
  const start = mogp.readUInt16LE(MOGP_PORTAL_START);
  const count = mogp.readUInt16LE(MOGP_PORTAL_COUNT);
  for (let reference = start; reference < start + count; reference++) {
    const at = reference * MOPR_SIZE;
    if (at + MOPR_SIZE > references.length) break;
    const index = references.readUInt16LE(at);
    const group = references.readUInt16LE(at + 2);
    const side = references.readInt16LE(at + 4);
    const definition = index * MOPT_SIZE;
    if (definition + MOPT_SIZE > definitions.length) continue;
    const first = definitions.readUInt16LE(definition);
    const corners = definitions.readUInt16LE(definition + 2);
    const polygon = [];
    for (let corner = first; corner < first + corners && (corner + 1) * 12 <= vertices.length; corner++) {
      polygon.push([vertices.readFloatLE(corner * 12), vertices.readFloatLE(corner * 12 + 4), vertices.readFloatLE(corner * 12 + 8)]);
    }
    const flags = info && (group + 1) * MOGI_SIZE <= info.length ? info.readUInt32LE(group * MOGI_SIZE) : 0;
    portals.push({
      normal: [definitions.readFloatLE(definition + 4), definitions.readFloatLE(definition + 8), definitions.readFloatLE(definition + 12)],
      distance: definitions.readFloatLE(definition + 16),
      polygon, side, exterior: (flags & MOGI_EXTERIOR) !== 0,
    });
  }
  return portals;
}

/**
 * Rewrites a group's transition vertices (RGBA bytes, `colours[0 .. end)`) to what Wow.exe holds after
 * both load steps: colour halved when `fixAlpha` (MOHD 0x8 clear), pulled towards 127 by the
 * attenuation, alpha = attenuation·255. `positions` are the group's own MOVT floats.
 */
export function wmoApplyTransitionLight(colours, positions, end, portals, fixAlpha) {
  for (let vertex = 0; vertex < end; vertex++) {
    const attenuation = Math.fround(wmoTransitionAttenuation(
      [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]], portals));
    for (let channel = 0; channel < 3; channel++) {
      const stored = fixAlpha ? colours[vertex * 4 + channel] >> 1 : colours[vertex * 4 + channel];
      colours[vertex * 4 + channel] = Math.trunc(stored + (127 - stored) * attenuation) & 0xff;
    }
    colours[vertex * 4 + 3] = Math.trunc(attenuation * 255) & 0xff;
  }
}
