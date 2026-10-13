// 13.10 6.15: M2 ribbon emitters as Wow.exe's CRibbonEmitter runs them (read-only Ghidra, Wow.exe 3.3.5a 12340).
//
//   0x009808a0  Initialize(edgesPerSecond, edgeLifetime, …, rect {0,0,1,1}, rows = record+0x80, columns = +0x82):
//               the rate is ceil(edgesPerSecond) (+0x10c), the lifetime max(edgeLifetime, 0.25) (+0x110), the ring
//               holds ceil(lifetime · rate) + 2 edges — no fixed cap; one texture cell is 1/columns along the trail
//               (+0x5c) by 1/rows across it (+0x60).
//   0x00828a00  CM2Model::Animate, per ribbon per frame: colour (0x0097fb60), alpha × the model's alpha (0x0097fba0),
//               heightAbove/heightBelow (0x0097f610/0x0097f620), the texture slot (0x0097f5f0), visibility
//               (0x0097f570: hidden also forgets the previous position), then the bone frame (0x0097f940) and the
//               update (0x00980090) — the bone's Y axis (matrix row 1) is the ribbon's width, its Z axis (row 2)
//               the tangent the new edges curve along, record+0x08 its offset on the bone.
//   0x00980090  Update(dt): the first call steps 1/rate + 1e-4; dt is clamped to [0, lifetime]; edges whose
//               age + dt passes the lifetime retire first; dt · rate + carry new edges are laid along the curve
//               between last frame's bone and this one's (0x0097f700, 0x0097fef0: t = (i − carry)/(count − carry),
//               age −t·dt, then every edge ages by dt), and one more *head* edge is written at the bone itself
//               without advancing the ring, so the strip always reaches the bone. Gravity (record+0x7c, passed
//               unchanged by 0x00833a3b) moves every edge along world up by g·(2·age·dt + dt²), i.e. g·age² in all.
//               The vertex colour is the colour and alpha of the frame the edge was laid in — nothing fades it with
//               age; the length coordinate is cellU + age/lifetime · cellWidth, recomputed every frame from the
//               current slot (column = slot % columns, row = slot / columns: 0x0097f510).
//   0x00980b70  Render: the strip once per material/texture pair of the ribbon (`ParticleRender.ts`).

import type { WvmRibbonEmitter, WvmTrack } from "./Wvm.js";
import { emitterTrackSequence, sampleTrack, type EmitterFrame } from "./Particles.js";

export interface RibbonEdge {
  /** The bone's own path through the curve, for callers that ask where the trail is. */
  x: number; y: number; z: number;
  /** The two vertices, already placed: below = −Y·heightBelow side, above = +Y·heightAbove side. */
  belowX: number; belowY: number; belowZ: number;
  aboveX: number; aboveY: number; aboveZ: number;
  /** The cross coordinate of this edge's cell row (v of the below vertex; above is + 1/rows). */
  cellV: number;
  red: number; green: number; blue: number; alpha: number;
  age: number;
}

export interface RibbonSystem {
  readonly ribbon: WvmRibbonEmitter;
  readonly globalSequences: Uint32Array;
  /** The laid edges, oldest first. The head edge is apart: it is rewritten at the bone every frame. */
  readonly edges: RibbonEdge[];
  head: RibbonEdge | undefined;
  /** Fractional edges owed (0x00980090's +0x1c). */
  pending: number;
  /** Whether the first update, which steps one edge interval, has run (+0x160 bit 0x10). */
  started: boolean;
  /** Whether a previous bone frame exists to curve from (+0x160 bit 1). */
  placed: boolean;
  /** The current texture slot (+0x170). */
  slot: number;
  /** ceil(lifetime · ceil(edgesPerSecond)) + 2: how many edges the ring of 0x009808a0 holds. */
  readonly capacity: number;
  /** Last and this frame's bone: position, Y axis, Z axis (9 numbers each). */
  readonly previous: Float64Array;
  readonly current: Float64Array;
  /** Retired edges, kept so a long trail does not allocate an object per edge. */
  readonly spare: RibbonEdge[];
}

/** 0x009808a0: below a quarter of a second the lifetime is a quarter of a second (0x00aa2d0c = 0.25). */
export const RIBBON_MIN_LIFETIME = 0.25;

/** ceil(edgesPerSecond), as 0x009808a0 stores it (+0x10c). */
export function ribbonRate(ribbon: WvmRibbonEmitter): number {
  return ribbon.edgesPerSecond > 0 ? Math.ceil(ribbon.edgesPerSecond) : 0;
}

export function ribbonLifetime(ribbon: WvmRibbonEmitter): number {
  return Math.max(RIBBON_MIN_LIFETIME, Number.isFinite(ribbon.edgeLifetime) ? ribbon.edgeLifetime : 0);
}

/** The ring size of 0x009808a0: ceil(lifetime · ceil(rate)) + 2 (0x00a4040c = 2.0). */
export function ribbonCapacity(ribbon: WvmRibbonEmitter): number {
  return Math.ceil(ribbonLifetime(ribbon) * ribbonRate(ribbon)) + 2;
}

export function createRibbonSystem(ribbon: WvmRibbonEmitter, globalSequences: Uint32Array): RibbonSystem {
  return {
    ribbon, globalSequences, edges: [], head: undefined, pending: 0, started: false, placed: false, slot: 0,
    capacity: ribbonCapacity(ribbon), previous: new Float64Array(9), current: new Float64Array(9), spare: [],
  };
}

/** Rewinds one trail while retaining its authored tracks and array identity. */
export function resetRibbonSystem(system: RibbonSystem): void {
  system.edges.length = 0;
  system.head = undefined;
  system.pending = 0;
  system.started = false;
  system.placed = false;
  system.slot = 0;
  system.previous.fill(0);
  system.current.fill(0);
}

/** Advances one ordinary ribbon frame; a hitch is deliberately capped at 100 ms. */
export function stepRibbon(system: RibbonSystem, seconds: number, frame: EmitterFrame): void {
  stepRibbonOnce(system, seconds > 0 && Number.isFinite(seconds) ? Math.min(seconds, 0.1) : 0, frame);
}

/** Explicit, bounded async catch-up for a newly resolved ribbon system (at most one second, 100 ms steps). */
export function stepRibbonCatchUp(system: RibbonSystem, seconds: number, frame: EmitterFrame): void {
  const duration = Math.min(1, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  if (duration <= 0) {
    stepRibbonOnce(system, 0, frame);
    return;
  }
  const startAnimation = frame.animationStartMs ?? frame.animationMs;
  const startWorld = frame.worldStartMs ?? frame.worldMs;
  const steps = Math.ceil(duration / 0.1);
  for (let index = 0; index < steps; index++) {
    const elapsed = Math.min(0.1, duration - index * 0.1);
    if (elapsed <= 0) break;
    const fraction = (index * 0.1 + elapsed) / duration;
    stepRibbonOnce(system, elapsed, {
      ...frame,
      animationMs: startAnimation + (frame.animationMs - startAnimation) * fraction,
      worldMs: startWorld + (frame.worldMs - startWorld) * fraction,
    });
  }
}

function sample(system: RibbonSystem, value: WvmTrack, frame: EmitterFrame, fallback: number, component = 0): number {
  return sampleTrack(value, frame.animationMs, frame.worldMs, system.globalSequences, fallback, component,
    emitterTrackSequence(value, frame.sequence));
}

/** Where the bone is and which way its Y and Z axes point, unnormalised (the bone's scale widens the strip). */
function boneFrame(ribbon: WvmRibbonEmitter, m: ArrayLike<number>, out: Float64Array): void {
  const [x, y, z] = ribbon.position;
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  out[3] = m[4]!; out[4] = m[5]!; out[5] = m[6]!;
  out[6] = m[8]!; out[7] = m[9]!; out[8] = m[10]!;
}

function takeEdge(system: RibbonSystem): RibbonEdge {
  return system.spare.pop() ?? {
    x: 0, y: 0, z: 0, belowX: 0, belowY: 0, belowZ: 0, aboveX: 0, aboveY: 0, aboveZ: 0,
    cellV: 0, red: 1, green: 1, blue: 1, alpha: 1, age: 0,
  };
}

/**
 * One point of 0x0097fef0's curve between last frame's bone (t = 0) and this one's (t = 1):
 * (1 − t)·(P + t·Zp·d) + t·(C − (1 − t)·Zc·d), for the bone itself and for its two width vertices.
 */
function placeEdge(system: RibbonSystem, edge: RibbonEdge, t: number, above: number, below: number): void {
  const p = system.previous;
  const c = system.current;
  const d = Math.hypot(c[0]! - p[0]!, c[1]! - p[1]!, c[2]! - p[2]!);
  const s = 1 - t;
  for (let axis = 0; axis < 3; axis++) {
    const from = p[axis]! + t * p[6 + axis]! * d;
    const to = c[axis]! - s * c[6 + axis]! * d;
    const centre = s * from + t * to;
    const belowAt = s * (from - p[3 + axis]! * below) + t * (to - c[3 + axis]! * below);
    const aboveAt = s * (from + p[3 + axis]! * above) + t * (to + c[3 + axis]! * above);
    if (axis === 0) { edge.x = centre; edge.belowX = belowAt; edge.aboveX = aboveAt; }
    else if (axis === 1) { edge.y = centre; edge.belowY = belowAt; edge.aboveY = aboveAt; }
    else { edge.z = centre; edge.belowZ = belowAt; edge.aboveZ = aboveAt; }
  }
}

function stepRibbonOnce(system: RibbonSystem, seconds: number, frame: EmitterFrame): void {
  const { ribbon, edges } = system;
  const rate = ribbonRate(ribbon);
  const lifetime = ribbonLifetime(ribbon);

  // 0x00828a00: the animated values of this frame.
  const visible = sample(system, ribbon.visibility, frame, 1) > 0.5;
  const above = sample(system, ribbon.heightAbove, frame, 0.5);
  const below = sample(system, ribbon.heightBelow, frame, 0.5);
  const red = sample(system, ribbon.color, frame, 1, 0);
  const green = sample(system, ribbon.color, frame, 1, 1);
  const blue = sample(system, ribbon.color, frame, 1, 2);
  const alpha = Math.min(1, Math.max(0, sample(system, ribbon.alpha, frame, 1)));
  const slot = Math.max(0, Math.floor(sample(system, ribbon.textureSlot, frame, 0)));
  system.slot = slot;
  const columns = Math.max(1, ribbon.textureColumns);
  const rows = Math.max(1, ribbon.textureRows);
  const cellV = Math.floor(slot / columns) / rows;

  // 0x0097f570: hidden forgets the previous bone, so a ribbon that reappears does not curve in from where it was.
  if (!visible) system.placed = false;
  else {
    // 0x0097f940: last frame's bone becomes the previous one; the first frame is both.
    boneFrame(ribbon, frame.matrix, system.current);
    if (!system.placed) {
      system.previous.set(system.current);
      system.pending = 0;
      system.placed = true;
    }
  }

  // 0x00980090.
  let dt = seconds;
  if (!system.started && rate > 0) dt = 1 / rate + 1e-4;
  dt = Math.min(lifetime, Math.max(0, dt));
  while (edges.length > 0 && edges[0]!.age + dt > lifetime) system.spare.push(edges.shift()!);

  if (visible && system.placed && rate > 0) {
    const count = dt * rate + system.pending;
    const carry = system.pending;
    for (let index = 1; index <= Math.floor(count); index++) {
      const t = (index - carry) / (count - carry);
      const edge = takeEdge(system);
      placeEdge(system, edge, t, above, below);
      edge.age = -t * dt;
      edge.cellV = cellV;
      edge.red = red; edge.green = green; edge.blue = blue; edge.alpha = alpha;
      edges.push(edge);
      // The ring holds the head too; the formula of 0x009808a0 never fills it, this only guards a bad record.
      if (edges.length >= system.capacity) system.spare.push(edges.shift()!);
    }
    system.pending = count - Math.floor(count);
    const head = system.head ?? takeEdge(system);
    placeEdge(system, head, 1, above, below);
    head.age = 0;
    head.cellV = cellV;
    head.red = red; head.green = green; head.blue = blue; head.alpha = alpha;
    system.head = head;
  }

  // Every laid edge ages; gravity runs along world up (Wow's z is the scene's y) as g·(2·age·dt + dt²).
  const gravity = ribbon.gravity;
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index]!;
    if (gravity !== 0) {
      const lift = (edge.age * 2 + dt) * gravity * dt;
      edge.y += lift;
      edge.belowY += lift;
      edge.aboveY += lift;
    }
    edge.age += dt;
  }
  system.started = true;
  if (visible) system.previous.set(system.current);
}

/** Where one texture cell starts along the trail and how long it is (0x0097f510, 0x009808a0). */
function cellU(system: RibbonSystem): { start: number; width: number } {
  const columns = Math.max(1, system.ribbon.textureColumns);
  return { start: (system.slot % columns) / columns, width: 1 / columns };
}

/**
 * Writes the strip's triangles — laid edges oldest first, then the head at the bone — and says how many quads.
 * u = the slot's cell start + age/lifetime · the cell's width (0x00980090), v = the edge's cell row, below → above.
 */
export function writeRibbonStrip(system: RibbonSystem, buffers: { positions: Float32Array; uvs: Float32Array; colors: Float32Array }): number {
  const { edges, head } = system;
  const lifetime = ribbonLifetime(system.ribbon);
  const rows = Math.max(1, system.ribbon.textureRows);
  const { start, width } = cellU(system);
  const capacity = Math.floor(buffers.positions.length / 12);
  const total = edges.length + (head ? 1 : 0);
  let quads = 0;
  for (let index = 0; index + 1 < total && quads < capacity; index++) {
    const near = edges[index]!;
    const far = index + 1 < edges.length ? edges[index + 1]! : head!;
    const at = quads * 12;
    const positions = buffers.positions;
    positions[at] = near.belowX; positions[at + 1] = near.belowY; positions[at + 2] = near.belowZ;
    positions[at + 3] = far.belowX; positions[at + 4] = far.belowY; positions[at + 5] = far.belowZ;
    positions[at + 6] = far.aboveX; positions[at + 7] = far.aboveY; positions[at + 8] = far.aboveZ;
    positions[at + 9] = near.aboveX; positions[at + 10] = near.aboveY; positions[at + 11] = near.aboveZ;

    const uNear = start + (near.age / lifetime) * width;
    const uFar = start + (far.age / lifetime) * width;
    const uvAt = quads * 8;
    const uvs = buffers.uvs;
    uvs[uvAt] = uNear; uvs[uvAt + 1] = near.cellV;
    uvs[uvAt + 2] = uFar; uvs[uvAt + 3] = far.cellV;
    uvs[uvAt + 4] = uFar; uvs[uvAt + 5] = far.cellV + 1 / rows;
    uvs[uvAt + 6] = uNear; uvs[uvAt + 7] = near.cellV + 1 / rows;

    const colorAt = quads * 16;
    const colors = buffers.colors;
    for (let corner = 0; corner < 4; corner++) {
      const edge = corner === 1 || corner === 2 ? far : near;
      const to = colorAt + corner * 4;
      colors[to] = edge.red;
      colors[to + 1] = edge.green;
      colors[to + 2] = edge.blue;
      colors[to + 3] = edge.alpha;
    }
    quads++;
  }
  return quads;
}
