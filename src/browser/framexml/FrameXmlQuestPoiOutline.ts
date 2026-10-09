/**
 * Plan item 3.13 (04.10, L6): the outline a QuestPOIFrame draws and hit-tests, the merging of a quest's
 * overlapping blobs and the tooltip hit test, as Wow.exe 3.3.5a 12340 does them (0x58ed80, 0x58f1a0,
 * 0x58e310, 0x58e0d0 and the NTempest spline 0x4c3830..0x4c4da0; read 2026-10-04, descriptions only).
 *
 * - The outline (0x58ed80): with smoothing off, the blob's own points. With smoothing on (the default)
 *   a closed uniform Catmull-Rom spline (the basis at 0xac37b8) through them — control points p[n−1],
 *   p0 … p[n−1], p0, p1, one segment per edge — sampled at SetNumSplinePoints parameters (default 20),
 *   t = 0.01, 0.01 + 1/N, … by arc length: each segment's length is the sum of 20 chords (0x4c3b10),
 *   the spline's length their sum, and t picks the segment its share of that length falls in
 *   (0x4c4230 → 0x4c3bd0). Each sample is rounded to whole yards. A polygon of those samples is what
 *   the client fills, borders and hit-tests.
 * - Drawing (0x58f1a0): a blob of fewer than three points, or with an outline point off the displayed
 *   map (or with |u·v| < 0.001), is not drawn. The outline's box is kept.
 * - Merging (0x58e310, after a quest's blobs are built, with EnableMerging on and the quest not met):
 *   of two drawn blobs counting for the mask whose boxes overlap, the one with the smaller box (the
 *   later one on a tie) goes into the other when more than SetMergeThreshold (default 0.25) of its
 *   outline points lie inside the other's outline: it is no longer drawn and its objectives join the
 *   other's list (at most 4, no repeats). A blob gone into one may still go into a later one.
 * - The hit test (0x58e0d0, one QuestPOIFrame slot): the point against each drawn blob's outline in
 *   turn (the crossing test of 0x9830d0); the last blob hit answers with its objective list.
 *
 * Coordinates: the client tests in screen units; an affine map of the frame keeps every inside/overlap
 * answer and every area ordering, so the map plane (u right, v down) is used here.
 */

import type { QuestPoint } from "../../world/QuestProtocol.js";

/** SetNumSplinePoints' default and EnableSmoothing's (the constructor 0x58ff50). */
export const QUEST_POI_SPLINE_POINTS = 20;
/** At most four objectives per blob and per tooltip (0x58e4f8, 0x58ea50). */
export const QUEST_POI_MAX_OBJECTIVES = 4;
/** 0x9f1968: the first sample's parameter. */
const FIRST_T = Math.fround(0.01);
/** 0x9f1958 and the 20 chords of 0x4c3b10. */
const CHORD_STEP = Math.fround(0.05);
const CHORDS = 20;
/** 0xac37b8: the uniform Catmull-Rom weights of the four control points, t³ t² t 1 each. */
const BASIS: readonly (readonly [number, number, number, number])[] = Object.freeze([
  [-0.5, 1, -0.5, 0], [1.5, -2.5, 0, 1], [-1.5, 2, 0.5, 0], [0.5, -0.5, 0, 0],
]);

/** fistp in the default mode: to the nearest integer, halves to even. */
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** One segment's point at u (0x4c39d0): the four weights against control points seg … seg + 3. */
function segmentPoint(xs: Float32Array, ys: Float32Array, seg: number, u: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c, d] = BASIS[i]!;
    const weight = Math.fround(((a * u + b) * u + c) * u + d);
    x = Math.fround(x + weight * xs[seg + i]!);
    y = Math.fround(y + weight * ys[seg + i]!);
  }
  return { x, y };
}

/**
 * A blob's outline in whole world yards: its points with `smoothing` off, else `splinePoints` samples of
 * the closed spline (see the file comment).
 */
export function questPoiOutline(points: readonly QuestPoint[], smoothing: boolean, splinePoints = QUEST_POI_SPLINE_POINTS): QuestPoint[] {
  const n = points.length;
  if (!smoothing || n < 3) return points.map((point) => ({ x: point.x, y: point.y }));
  // Control points: the last point, every point, then the first two again (0x58edf0..0x58ef0a).
  const count = n + 3;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const point = points[(index + n - 1) % n]!;
    xs[index] = point.x;
    ys[index] = point.y;
  }
  const segments = count - 3;
  const lengths = new Float32Array(segments);
  let total = 0;
  for (let seg = 0; seg < segments; seg++) {
    let previous = segmentPoint(xs, ys, seg, 0);
    let t = CHORD_STEP;
    let length = 0;
    for (let chord = 0; chord < CHORDS; chord++) {
      const next = segmentPoint(xs, ys, seg, t);
      length = Math.fround(Math.sqrt((next.x - previous.x) ** 2 + (next.y - previous.y) ** 2) + length);
      previous = next;
      t = Math.fround(t + CHORD_STEP);
    }
    lengths[seg] = length;
    total += length;
  }
  total = Math.fround(total);
  const outline: QuestPoint[] = [];
  let t = FIRST_T;
  const samples = Math.max(0, Math.trunc(splinePoints));
  for (let sample = 0; sample < samples; sample++) {
    let point: { x: number; y: number };
    if (!(t > 0)) point = { x: xs[0]!, y: ys[0]! };
    else if (t >= 1) point = { x: xs[count - 1]!, y: ys[count - 1]! };
    else {
      // 0x4c3bd0: the segment whose share of the length holds t, and how far along it.
      const at = Math.fround(total * t);
      let seg = 0;
      let before = 0;
      for (;;) {
        const through = Math.fround(lengths[seg]! + before);
        if (!(through <= at)) break;
        seg += 1;
        before = through;
        if (!(seg < segments - 1)) break;
      }
      point = segmentPoint(xs, ys, seg, Math.fround((at - before) / lengths[seg]!));
    }
    outline.push({ x: roundEven(point.x), y: roundEven(point.y) });
    t = Math.fround(1 / samples + t);
  }
  return outline;
}

/** A point on the displayed map (u right, v down). */
export interface QuestPoiPlanePoint {
  readonly u: number;
  readonly v: number;
}

/** One built blob of a drawn quest (0x58f1a0's render data, as far as merging and hit tests read it). */
export interface QuestPoiDrawnBlob {
  readonly objectiveIndex: number;
  /** Its own objective first, then those of blobs merged into it. */
  readonly objectives: number[];
  /** Still drawn: not merged into another. */
  active: boolean;
  readonly points: readonly QuestPoiPlanePoint[];
  readonly minU: number;
  readonly minV: number;
  readonly maxU: number;
  readonly maxV: number;
}

/** A drawn blob from its outline on the map plane: the box is the outline's (0x58f1a0). */
export function questPoiDrawnBlob(objectiveIndex: number, points: readonly QuestPoiPlanePoint[]): QuestPoiDrawnBlob {
  let minU = Number.MAX_VALUE;
  let minV = Number.MAX_VALUE;
  let maxU = -Number.MAX_VALUE;
  let maxV = -Number.MAX_VALUE;
  for (const point of points) {
    minU = Math.min(minU, point.u);
    maxU = Math.max(maxU, point.u);
    minV = Math.min(minV, point.v);
    maxV = Math.max(maxV, point.v);
  }
  return { objectiveIndex, objectives: [objectiveIndex], active: true, points, minU, minV, maxU, maxV };
}

/** The crossing test of 0x9830d0 on the map plane. */
export function questPoiInside(points: readonly QuestPoiPlanePoint[], u: number, v: number): boolean {
  let inside = false;
  const count = points.length;
  if (count === 0) return false;
  let previous = points[count - 1]!;
  let previousAbove = previous.v >= v;
  for (let index = 0; index < count; index++) {
    const point = points[index]!;
    const above = point.v >= v;
    if (above !== previousAbove
      && ((point.v - v) * (previous.u - point.u) >= (point.u - u) * (previous.v - point.v)) === above) {
      inside = !inside;
    }
    previous = point;
    previousAbove = above;
  }
  return inside;
}

/**
 * 0x58e310: merge a quest's overlapping drawn blobs, in place. The caller has left out blobs that do not
 * count for the mask and runs this only for a quest that is not met with merging on.
 */
export function questPoiMergeBlobs(blobs: readonly QuestPoiDrawnBlob[], threshold: number): void {
  for (let i = 0; i < blobs.length; i++) {
    const a = blobs[i]!;
    if (!a.active) continue;
    for (let j = i + 1; j < blobs.length; j++) {
      const b = blobs[j]!;
      if (!b.active) continue;
      // The boxes overlap (0x48ed60 and the strict test after it).
      if (!(Math.max(a.minV, b.minV) < Math.min(a.maxV, b.maxV) && Math.max(a.minU, b.minU) < Math.min(a.maxU, b.maxU))) continue;
      const areaA = (a.maxV - a.minV) * (a.maxU - a.minU);
      const areaB = (b.maxV - b.minV) * (b.maxU - b.minU);
      const [small, large] = areaA < areaB ? [a, b] : [b, a];
      let inside = 0;
      for (const point of small.points) if (questPoiInside(large.points, point.u, point.v)) inside += 1;
      if (!(small.points.length > 0 && threshold < inside / small.points.length)) continue;
      small.active = false;
      for (const objective of small.objectives) {
        if (large.objectives.length >= QUEST_POI_MAX_OBJECTIVES) break;
        if (!large.objectives.includes(objective)) large.objectives.push(objective);
      }
    }
  }
}

/**
 * 0x58e0d0 over one slot: the objectives of the last drawn blob under (u, v), written into `into`
 * from its start (a shorter later list leaves the rest as it was, as the client's does); answers how
 * many, 0 for none.
 */
export function questPoiHitTest(blobs: readonly { readonly points: readonly QuestPoiPlanePoint[]; readonly objectives: readonly number[] }[],
  u: number, v: number, into: number[]): number {
  let count = 0;
  for (const blob of blobs) {
    if (blob.points.length < 2 || !questPoiInside(blob.points, u, v)) continue;
    count = blob.objectives.length;
    for (let index = 0; index < count && index < QUEST_POI_MAX_OBJECTIVES; index++) into[index] = blob.objectives[index]!;
  }
  return count;
}
