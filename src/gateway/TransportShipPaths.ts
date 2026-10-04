// Where a ship or a zeppelin is at any moment of its cycle (plan item 11.01, slice A1).
//
// The server never says. After the create block a `GAMEOBJECT_TYPE_MO_TRANSPORT` is moved by
// `Transport::Update` (Transport.cpp:120-219) with no network output at all: `UpdatePosition`
// relocates the ship and its passengers and sends nothing (Transport.cpp:508-531). What the client
// is given is the clock — the create block's `UPDATEFLAG_TRANSPORT` word is the transport's
// `PathProgress` (Object.cpp:442-454), `GAMEOBJECT_LEVEL` is the period (`SetPeriod(pathTime)`,
// Transport.cpp:95; `GetTransportPeriod`, Transport.h:82) — and the path is the client's own
// business. Ships are not in TransportAnimation.dbc (that table is lifts and trams, see
// TransportPaths.ts); their path is a TaxiPathNode.dbc path named by the template's `data0`, run at
// `data1` yards a second with `data2` yards a second² of acceleration.
//
// This file is the server's timetable, ported: `TransportMgr::GeneratePath` (TransportMgr.cpp:122-355)
// builds the key frames, and `Transport::Update` + `Transport::CalculateSegmentPos`
// (Transport.cpp:133-219, 584-613) place the ship from them. The answer is baked into a track
// sampled every 100 ms, so the browser does an index and a lerp per ship per frame.
//
// Arithmetic. The core does this in 32-bit floats — G3D vectors, `float` key-frame fields,
// `sqrtf` — and the period it ends up with is written into `GAMEOBJECT_LEVEL` and compared by the
// browser against this file's (a mismatch keeps the ship still rather than sailing it on the wrong
// clock). So every operation that feeds the period is rounded to single precision as the core's
// x64 build does it (SSE scalar ops, `/fp:precise`, no contraction): `Math.fround` after each one,
// in the source's order of operations. Only the spline lengths are accumulated in double, because
// `TransportSpline` is `Movement::Spline<double>` (TransportMgr.h:36).

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import type { CatalogCache, CatalogRouteOptions } from "./CatalogRoutes.js";
import { originAllowed } from "./UpgradeGuard.js";

/** The answer's shape. The request names it as `?v=`; bump it with every change of shape. */
export const SHIP_PATHS_VERSION = 1;
export const SHIP_PATHS_PATHNAME = "/dbc/ship-paths";
/** The track's sample spacing. 28 yd/s × 0.1 s = 2.8 yd chords on a curve of radius ≫ 100 yd. */
export const SHIP_PATH_STEP_MS = 100;
/**
 * The most samples one track holds: an hour at `SHIP_PATH_STEP_MS`, about 2 MB of JSON. A longer
 * cycle is sampled more sparsely instead. The route takes any `speed`/`accel` from 1 up, and a slow
 * one on a long path would otherwise bake hundreds of thousands of samples per request.
 */
export const SHIP_TRACK_MAX_SAMPLES = 36_000;
/** `flags` bits of a baked sample. */
export const SHIP_SAMPLE_STOP = 1;
/** The next sample is on the far side of a jump (`KeyFrame::Teleport`): hold, do not interpolate. */
export const SHIP_SAMPLE_CUT = 2;

/** `TaxiPathNodeEntryfmt` = "diiifffiiii" (DBCfmt.h:136), `TaxiPathNodeEntry` (DBCStructure.h:1738-1749). */
const TAXI_PATH_NODE_LAYOUT = { fieldCount: 11, recordSize: 44 } as const;
/** `KeyFrame::IsStopFrame`: `Node->Flags == 2` — equality, not a bit test (TransportMgr.h:69). */
const NODE_FLAGS_STOP = 2;
/** `node_i->Flags & 1` ends a leg like a map change does (TransportMgr.cpp:147). */
const NODE_FLAGS_TELEPORT = 1;
/** `STEPS_PER_SEGMENT` of `SplineBase` (Spline.h:57): the core's chord count per segment length. */
const STEPS_PER_SEGMENT = 3;

export interface TaxiPathNodeRow {
  readonly pathId: number;
  readonly nodeIndex: number;
  readonly mapId: number;
  /** Single-precision values, as read. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly flags: number;
  /** Seconds the ship waits at a stop node. */
  readonly delay: number;
  readonly arrivalEventId: number;
  readonly departureEventId: number;
}

/** Every path, nodes in `NodeIndex` order; a path with a hole in its indices is left out. */
export function parseTaxiPathNodes(rows: FixedRows): Map<number, TaxiPathNodeRow[]> {
  const byPath = new Map<number, TaxiPathNodeRow[]>();
  for (let row = 0; row < rows.records; row++) {
    const node: TaxiPathNodeRow = {
      pathId: rows.int(row, 1),
      nodeIndex: rows.int(row, 2),
      mapId: rows.int(row, 3),
      x: rows.float(row, 4),
      y: rows.float(row, 5),
      z: rows.float(row, 6),
      flags: rows.int(row, 7),
      delay: rows.int(row, 8) >>> 0,
      arrivalEventId: rows.int(row, 9),
      departureEventId: rows.int(row, 10),
    };
    if (node.pathId <= 0 || node.nodeIndex < 0) continue;
    let list = byPath.get(node.pathId);
    if (!list) byPath.set(node.pathId, list = []);
    list.push(node);
  }
  // `sTaxiPathNodesByPath[PathID][NodeIndex] = entry` (DBCStores.cpp:587-592): placed by index, so a
  // gap would be a null node the core dereferences. Such a path is not served at all.
  for (const [pathId, list] of byPath) {
    list.sort((left, right) => left.nodeIndex - right.nodeIndex);
    if (list.some((node, index) => node.nodeIndex !== index)) byPath.delete(pathId);
  }
  return byPath;
}

// ---------------------------------------------------------------------------------------------
// Single-precision Catmull-Rom, `Movement::SplineBase` (Spline.cpp) with G3D's operation order.

const f = Math.fround;

/** `s_catmullRomCoeffs` (Spline.cpp:59-63), row-major as G3D's `Matrix4` constructor takes it. */
const CATMULL_ROM: readonly (readonly number[])[] = [
  [-0.5, 1.5, -1.5, 0.5],
  [1, -2.5, 2, -0.5],
  [-0.5, 0, 0.5, 0],
  [0, 1, 0, 0],
];

interface Vec3 { x: number; y: number; z: number }

const WEIGHTS = [0, 0, 0, 0];

/** `Vector4 * Matrix4` (G3D Vector4.cpp:128-137): `result[i] += v[j] * M[j][i]`, j ascending. */
function weights(t0: number, t1: number, t2: number, t3: number): number[] {
  for (let i = 0; i < 4; i++) {
    let sum = 0;
    sum = f(sum + f(t0 * CATMULL_ROM[0]![i]!));
    sum = f(sum + f(t1 * CATMULL_ROM[1]![i]!));
    sum = f(sum + f(t2 * CATMULL_ROM[2]![i]!));
    sum = f(sum + f(t3 * CATMULL_ROM[3]![i]!));
    WEIGHTS[i] = sum;
  }
  return WEIGHTS;
}

/** `v0*w0 + v1*w1 + v2*w2 + v3*w3`, left to right, per component. */
function combine(points: readonly Vec3[], base: number, w: readonly number[], out: Vec3): Vec3 {
  const p0 = points[base]!;
  const p1 = points[base + 1]!;
  const p2 = points[base + 2]!;
  const p3 = points[base + 3]!;
  out.x = f(f(f(f(p0.x * w[0]!) + f(p1.x * w[1]!)) + f(p2.x * w[2]!)) + f(p3.x * w[3]!));
  out.y = f(f(f(f(p0.y * w[0]!) + f(p1.y * w[1]!)) + f(p2.y * w[2]!)) + f(p3.y * w[3]!));
  out.z = f(f(f(f(p0.z * w[0]!) + f(p1.z * w[1]!)) + f(p2.z * w[2]!)) + f(p3.z * w[3]!));
  return out;
}

/** A non-cyclic Catmull-Rom spline; segment `index` runs from `points[index]` to `points[index + 1]`. */
export class FloatSpline {
  readonly points: readonly Vec3[];
  readonly lo: number;
  readonly hi: number;
  /** `Spline<double>::lengths`: `lengths[i + 1]` is the length from `lo` to the end of segment `i`. */
  readonly lengths: number[];

  constructor(points: readonly Vec3[], lo: number, hi: number) {
    this.points = points;
    this.lo = lo;
    this.hi = hi;
    // `Spline::initLengths` (SplineImpl.h): float segment lengths summed into doubles.
    this.lengths = new Array<number>(Math.max(hi + 1, 0)).fill(0);
    let length = 0;
    for (let i = lo; i < hi; i++) {
      length += this.segLength(i);
      this.lengths[i + 1] = length;
    }
  }

  /**
   * `SplineBase::InitCatmullRom` for `init_spline(controls, count, ModeCatmullrom)`, orientation 0:
   * a virtual first point one yard behind the first control along −x, the last control repeated.
   */
  static catmullRom(controls: readonly Vec3[]): FloatSpline {
    const count = controls.length;
    const first = controls[0]!;
    const points: Vec3[] = [{ x: f(first.x - 1), y: f(first.y - 0), z: f(first.z - 0) }];
    for (const control of controls) points.push({ x: control.x, y: control.y, z: control.z });
    points.push({ ...controls[count - 1]! });
    return new FloatSpline(points, 1, count);
  }

  /** `length(first, last)`: a double difference, which the key frame stores as a float. */
  length(first: number, last: number): number {
    return (this.lengths[last] ?? 0) - (this.lengths[first] ?? 0);
  }

  /** `SegLengthCatmullRom`: three chords. */
  segLength(index: number): number {
    const cur: Vec3 = { ...this.points[index]! };
    const next: Vec3 = { x: 0, y: 0, z: 0 };
    let length = 0;
    for (let i = 1; i <= STEPS_PER_SEGMENT; i++) {
      this.evaluate(index, f(i / STEPS_PER_SEGMENT), next);
      const dx = f(next.x - cur.x);
      const dy = f(next.y - cur.y);
      const dz = f(next.z - cur.z);
      length = f(length + f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz)))));
      cur.x = next.x;
      cur.y = next.y;
      cur.z = next.z;
    }
    return length;
  }

  /** `EvaluateCatmullRom` / `C_Evaluate`: the point at `u` of segment `index`. */
  evaluate(index: number, u: number, out: Vec3): Vec3 {
    const t = f(u);
    const t2 = f(t * t);
    return combine(this.points, index - 1, weights(f(t2 * t), t2, t, 1), out);
  }

  /** `EvaluateDerivativeCatmullRom` / `C_Evaluate_Derivative`. */
  derivative(index: number, u: number, out: Vec3): Vec3 {
    const t = f(u);
    return combine(this.points, index - 1, weights(f(f(3 * t) * t), f(2 * t), 1, 0), out);
  }
}

// ---------------------------------------------------------------------------------------------
// `TransportMgr::GeneratePath`.

export interface ShipKeyFrame {
  readonly node: TaxiPathNodeRow;
  index: number;
  initialOrientation: number;
  distSinceStop: number;
  distUntilStop: number;
  distFromPrev: number;
  timeFrom: number;
  timeTo: number;
  teleport: boolean;
  arriveTime: number;
  departureTime: number;
  spline: FloatSpline | undefined;
  nextDistFromPrev: number;
  nextArriveTime: number;
}

export interface ShipPathModel {
  readonly keyFrames: readonly ShipKeyFrame[];
  /** `TransportTemplate::pathTime`: what the server writes into `GAMEOBJECT_LEVEL`. */
  readonly pathTime: number;
  readonly accelTime: number;
  readonly accelDist: number;
  readonly speed: number;
  readonly accel: number;
}

export class ShipPathError extends Error {}

function isStop(frame: ShipKeyFrame): boolean {
  return frame.node.flags === NODE_FLAGS_STOP;
}

/** `Position::NormalizeOrientation` (Position.cpp:156-168) in float; `fmod` is exact. */
function normalizeOrientationF(o: number): number {
  const turn = f(2 * f(Math.PI));
  if (o < 0) return f(-f(f(-o) % turn) + turn);
  return f(o % turn);
}

/** `uint32(curPathTime * float(IN_MILLISECONDS))`: a float product truncated toward zero. */
function toMs(seconds: number): number {
  const value = f(seconds * 1000);
  return value <= 0 ? 0 : Math.trunc(value) >>> 0;
}

/**
 * The key frames and the period of one transport, as `TransportMgr::GeneratePath` builds them for
 * the template whose `moTransport` is (`taxiPathId`, `moveSpeed`, `accelRate`).
 */
export function generateShipPath(nodes: readonly TaxiPathNodeRow[], moveSpeed: number, accelRate: number): ShipPathModel {
  if (nodes.length < 2) throw new ShipPathError(`a path needs two nodes, this one has ${nodes.length}`);
  if (!(moveSpeed > 0) || !(accelRate > 0)) throw new ShipPathError("speed and acceleration must be positive");

  // Extra points so every node has a derivative (TransportMgr.cpp:129-135), each by `lerp`:
  // `this + (v - this) * alpha`.
  const lerp = (a: Vec3, b: Vec3, alpha: number): Vec3 => ({
    x: f(a.x + f(f(b.x - a.x) * alpha)),
    y: f(a.y + f(f(b.y - a.y) * alpha)),
    z: f(a.z + f(f(b.z - a.z) * alpha)),
  });
  const allPoints: Vec3[] = nodes.map((node) => ({ x: node.x, y: node.y, z: node.z }));
  allPoints.unshift(lerp(allPoints[0]!, allPoints[1]!, f(-0.2)));
  allPoints.push(lerp(allPoints[allPoints.length - 1]!, allPoints[allPoints.length - 2]!, f(-0.2)));
  allPoints.push(lerp(allPoints[allPoints.length - 1]!, allPoints[allPoints.length - 2]!, -1));
  // `SplineRawInitializer`: the points as they are, segments 1 … size − 2.
  const orientationSpline = new FloatSpline(allPoints, 1, allPoints.length - 2);

  const keyFrames: ShipKeyFrame[] = [];
  const splinePath: Vec3[] = [];
  const derivative: Vec3 = { x: 0, y: 0, z: 0 };
  let mapChange = false;
  for (let i = 0; i < nodes.length; i++) {
    if (mapChange) {
      // The node after a jump is a Catmull-Rom guard too.
      mapChange = false;
      continue;
    }
    const node = nodes[i]!;
    if (i !== nodes.length - 1 && ((node.flags & NODE_FLAGS_TELEPORT) !== 0 || node.mapId !== nodes[i + 1]!.mapId)) {
      const last = keyFrames[keyFrames.length - 1];
      if (!last) throw new ShipPathError("the path begins with a jump");
      last.teleport = true;
      mapChange = true;
      continue;
    }
    orientationSpline.derivative(i + 1, 0, derivative);
    keyFrames.push({
      node,
      index: 0,
      initialOrientation: normalizeOrientationF(f(f(Math.atan2(derivative.y, derivative.x)) + f(Math.PI))),
      distSinceStop: -1,
      distUntilStop: -1,
      distFromPrev: -1,
      timeFrom: 0,
      timeTo: 0,
      teleport: false,
      arriveTime: 0,
      departureTime: 0,
      spline: undefined,
      nextDistFromPrev: 0,
      nextArriveTime: 0,
    });
    splinePath.push({ x: node.x, y: node.y, z: node.z });
  }

  if (splinePath.length >= 2) {
    // The first and last nodes are the spline's own guards unless something happens there.
    const first = keyFrames[0]!;
    if (!isStop(first) && !first.node.arrivalEventId && !first.node.departureEventId) {
      splinePath.shift();
      keyFrames.shift();
    }
    const last = keyFrames[keyFrames.length - 1]!;
    if (!isStop(last) && !last.node.arrivalEventId && !last.node.departureEventId) {
      splinePath.pop();
      keyFrames.pop();
    }
  }
  if (keyFrames.length === 0) throw new ShipPathError("the path has no key frames");

  // Last to first is always a jump, even for a closed path.
  keyFrames[keyFrames.length - 1]!.teleport = true;

  const speed = f(moveSpeed);
  const accel = f(accelRate);
  const accelDist = f(f(f(0.5 * speed) * speed) / accel);
  const accelTime = f(speed / accel);

  let firstStop = -1;
  let lastStop = -1;
  keyFrames[0]!.distFromPrev = 0;
  keyFrames[0]!.index = 1;
  if (isStop(keyFrames[0]!)) {
    firstStop = 0;
    lastStop = 0;
  }

  // One spline per leg (TransportMgr.cpp:217-255).
  let start = 0;
  for (let i = 1; i < keyFrames.length; i++) {
    const previous = keyFrames[i - 1]!;
    if (previous.teleport || i + 1 === keyFrames.length) {
      const extra = previous.teleport ? 0 : 1;
      const spline = FloatSpline.catmullRom(splinePath.slice(start, i + extra));
      for (let j = start; j < i + extra; j++) {
        const frame = keyFrames[j]!;
        frame.index = j - start + 1;
        frame.distFromPrev = f(spline.length(j - start, j + 1 - start));
        if (j > 0) keyFrames[j - 1]!.nextDistFromPrev = frame.distFromPrev;
        frame.spline = spline;
      }
      if (previous.teleport) {
        const frame = keyFrames[i]!;
        frame.index = i - start + 1;
        frame.distFromPrev = 0;
        previous.nextDistFromPrev = 0;
        frame.spline = spline;
      }
      start = i;
    }
    if (isStop(keyFrames[i]!)) {
      if (firstStop === -1) firstStop = i;
      lastStop = i;
    }
  }
  keyFrames[keyFrames.length - 1]!.nextDistFromPrev = keyFrames[0]!.distFromPrev;
  if (firstStop === -1 || lastStop === -1) firstStop = lastStop = 0;

  const count = keyFrames.length;
  // Distance since the last stop and until the next one (TransportMgr.cpp:262-284).
  let tmpDist = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + lastStop) % count;
    const frame = keyFrames[j]!;
    if (isStop(frame) || j === lastStop) tmpDist = 0;
    else tmpDist = f(tmpDist + frame.distFromPrev);
    frame.distSinceStop = tmpDist;
  }
  tmpDist = 0;
  for (let i = count - 1; i >= 0; i--) {
    const j = (i + firstStop) % count;
    tmpDist = f(tmpDist + keyFrames[(j + 1) % count]!.distFromPrev);
    keyFrames[j]!.distUntilStop = tmpDist;
    if (isStop(keyFrames[j]!) || j === firstStop) tmpDist = 0;
  }

  // Time to the next stop under a trapezoidal speed profile (TransportMgr.cpp:286-312).
  for (const frame of keyFrames) {
    const since = frame.distSinceStop;
    const until = frame.distUntilStop;
    const total = f(since + until);
    if (total < f(2 * accelDist)) {
      if (since < until) {
        const segmentTime = f(2 * f(Math.sqrt(f(f(until + since) / accel))));
        frame.timeTo = f(segmentTime - f(Math.sqrt(f(f(2 * since) / accel))));
      } else {
        frame.timeTo = f(Math.sqrt(f(f(2 * until) / accel)));
      }
    } else if (since < accelDist) {
      const segmentTime = f(f(f(until + since) / speed) + f(speed / accel));
      frame.timeTo = f(segmentTime - f(Math.sqrt(f(f(2 * since) / accel))));
    } else if (until < accelDist) {
      frame.timeTo = f(Math.sqrt(f(f(2 * until) / accel)));
    } else {
      frame.timeTo = f(f(until / speed) + f(f(0.5 * speed) / accel));
    }
  }

  let segmentTime = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + lastStop) % count;
    const frame = keyFrames[j]!;
    if (isStop(frame) || j === lastStop) segmentTime = frame.timeTo;
    frame.timeFrom = f(segmentTime - frame.timeTo);
  }

  // Arrival and departure times (TransportMgr.cpp:324-354).
  keyFrames[0]!.arriveTime = 0;
  let curPathTime = 0;
  if (isStop(keyFrames[0]!)) {
    curPathTime = f(keyFrames[0]!.node.delay);
    keyFrames[0]!.departureTime = toMs(curPathTime);
  }
  for (let i = 1; i < count; i++) {
    const frame = keyFrames[i]!;
    curPathTime = f(curPathTime + keyFrames[i - 1]!.timeTo);
    if (isStop(frame)) {
      frame.arriveTime = toMs(curPathTime);
      keyFrames[i - 1]!.nextArriveTime = frame.arriveTime;
      curPathTime = f(curPathTime + f(frame.node.delay));
      frame.departureTime = toMs(curPathTime);
    } else {
      curPathTime = f(curPathTime - frame.timeTo);
      frame.arriveTime = toMs(curPathTime);
      keyFrames[i - 1]!.nextArriveTime = frame.arriveTime;
      frame.departureTime = frame.arriveTime;
    }
  }
  const lastFrame = keyFrames[count - 1]!;
  lastFrame.nextArriveTime = lastFrame.departureTime;

  return { keyFrames, pathTime: lastFrame.departureTime, accelTime, accelDist, speed, accel };
}

// ---------------------------------------------------------------------------------------------
// `Transport::Update` + `CalculateSegmentPos`: the ship at a moment of its cycle.

export interface ShipPose {
  map: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  /** Waiting at a stop node. */
  stop: boolean;
  /** The key frame the moment belongs to. */
  frame: number;
}

/** The key frame `timer` falls in: arrived at, and not yet arrived at the next one. */
export function shipFrameAt(model: ShipPathModel, timer: number, from = 0): number {
  const frames = model.keyFrames;
  let k = Math.max(0, Math.min(from, frames.length - 1));
  if (frames[k]!.arriveTime > timer) k = 0;
  while (k + 1 < frames.length && timer >= frames[k]!.nextArriveTime) k++;
  return k;
}

/**
 * `CalculateSegmentPos(now)` for the frame `frame`: how far along its segment the ship is, as a
 * fraction of the segment's spline length — the core maps distance to the spline parameter linearly.
 */
export function shipSegmentPos(model: ShipPathModel, frame: ShipKeyFrame, nowSeconds: number): number {
  const elapsed = nowSeconds - frame.departureTime / 1000;
  const timeSinceStop = frame.timeFrom + elapsed;
  const timeUntilStop = frame.timeTo - elapsed;
  let segmentPos: number;
  if (timeSinceStop < timeUntilStop) {
    const dist = timeSinceStop < model.accelTime
      ? 0.5 * model.accel * timeSinceStop * timeSinceStop
      : model.accelDist + (timeSinceStop - model.accelTime) * model.speed;
    segmentPos = dist - frame.distSinceStop;
  } else {
    const dist = timeUntilStop < model.accelTime
      ? 0.5 * model.accel * timeUntilStop * timeUntilStop
      : model.accelDist + (timeUntilStop - model.accelTime) * model.speed;
    segmentPos = frame.distUntilStop - dist;
  }
  return segmentPos / frame.nextDistFromPrev;
}

const POSE_POINT: Vec3 = { x: 0, y: 0, z: 0 };
const POSE_DIRECTION: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Where the server puts the ship when its `PathProgress % period` is `timer` ms.
 *
 * Waiting at a stop: the node itself, facing `InitialOrientation` (the `justStopped` branch,
 * Transport.cpp:214-215). Moving: the frame's spline at `CalculateSegmentPos`, facing along the
 * tangent plus π — ship models face backwards along their path (Transport.cpp:210-212). A jump
 * frame has no length to move along (its `NextDistFromPrev` is 0 and so is its time to the next
 * frame), so the ship holds its node until the next frame takes over.
 */
export function shipPoseAtTime(model: ShipPathModel, timer: number, out: ShipPose, hint = 0): ShipPose {
  const k = shipFrameAt(model, timer, hint);
  const frame = model.keyFrames[k]!;
  out.frame = k;
  out.map = frame.node.mapId;
  if (timer < frame.departureTime || frame.teleport || !frame.spline || !(frame.nextDistFromPrev > 0)) {
    out.x = frame.node.x;
    out.y = frame.node.y;
    out.z = frame.node.z;
    out.orientation = frame.initialOrientation;
    out.stop = timer < frame.departureTime && isStop(frame);
    return out;
  }
  const t = shipSegmentPos(model, frame, timer / 1000);
  frame.spline.evaluate(frame.index, t, POSE_POINT);
  frame.spline.derivative(frame.index, t, POSE_DIRECTION);
  out.x = POSE_POINT.x;
  out.y = POSE_POINT.y;
  out.z = POSE_POINT.z;
  const heading = Math.atan2(POSE_DIRECTION.y, POSE_DIRECTION.x) + Math.PI;
  out.orientation = ((heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  out.stop = false;
  return out;
}

// ---------------------------------------------------------------------------------------------
// The baked track the browser reads.

export interface ShipTrack {
  readonly version: number;
  readonly path: number;
  readonly speed: number;
  readonly accel: number;
  /** `pathTime` in ms; the browser checks it against `GAMEOBJECT_LEVEL`. */
  readonly period: number;
  readonly step: number;
  /** Sample `i` is the moment `i × step`; `ceil(period / step)` samples. */
  readonly map: number[];
  readonly x: number[];
  readonly y: number[];
  readonly z: number[];
  readonly o: number[];
  /** `SHIP_SAMPLE_STOP` | `SHIP_SAMPLE_CUT`. */
  readonly flags: number[];
}

export interface ShipTrackRefusal {
  readonly version: number;
  readonly path: number;
  readonly speed: number;
  readonly accel: number;
  readonly error: string;
}

const round = (value: number, scale: number): number => Math.round(value * scale) / scale;

/**
 * Samples the cycle every `step` ms — or more sparsely, so that no track holds more than
 * `SHIP_TRACK_MAX_SAMPLES` — marking each sample whose successor is across a jump.
 */
export function bakeShipTrack(model: ShipPathModel, path: number, minimumStep = SHIP_PATH_STEP_MS): ShipTrack {
  const period = model.pathTime;
  const step = Math.max(minimumStep, Math.ceil(period / SHIP_TRACK_MAX_SAMPLES));
  const samples = Math.max(1, Math.ceil(period / step));
  const track: ShipTrack = {
    version: SHIP_PATHS_VERSION, path, speed: model.speed, accel: model.accel, period, step,
    map: [], x: [], y: [], z: [], o: [], flags: [],
  };
  const pose: ShipPose = { map: 0, x: 0, y: 0, z: 0, orientation: 0, stop: false, frame: 0 };
  const frames: number[] = [];
  for (let i = 0; i < samples; i++) {
    shipPoseAtTime(model, Math.min(i * step, Math.max(0, period - 1)), pose, pose.frame);
    track.map.push(pose.map);
    track.x.push(round(pose.x, 1000));
    track.y.push(round(pose.y, 1000));
    track.z.push(round(pose.z, 1000));
    track.o.push(round(pose.orientation, 10000));
    track.flags.push(pose.stop ? SHIP_SAMPLE_STOP : 0);
    frames.push(pose.frame);
  }
  const keyFrames = model.keyFrames;
  for (let i = 0; i < samples; i++) {
    const from = frames[i]!;
    // The last sample's successor is the first, across the always-jump from the last frame.
    if (i + 1 === samples) {
      track.flags[i]! |= SHIP_SAMPLE_CUT;
      continue;
    }
    const to = frames[i + 1]!;
    for (let k = from; k < to; k++) {
      if (keyFrames[k]!.teleport) {
        track.flags[i]! |= SHIP_SAMPLE_CUT;
        break;
      }
    }
  }
  return track;
}

/** One track out of the dataset's TaxiPathNode.dbc, or the reason there is none. */
export function shipTrackFor(
  paths: ReadonlyMap<number, readonly TaxiPathNodeRow[]>, path: number, speed: number, accel: number,
): ShipTrack | ShipTrackRefusal {
  const nodes = paths.get(path);
  try {
    if (!nodes) throw new ShipPathError(`TaxiPathNode.dbc has no path ${path}`);
    return bakeShipTrack(generateShipPath(nodes, speed, accel), path);
  } catch (error) {
    if (!(error instanceof ShipPathError)) throw error;
    return { version: SHIP_PATHS_VERSION, path, speed, accel, error: error.message };
  }
}

export async function loadTaxiPathNodes(dbcDirectory: string): Promise<Map<number, TaxiPathNodeRow[]>> {
  return parseTaxiPathNodes(await readFixed(dbcDirectory, "TaxiPathNode", TAXI_PATH_NODE_LAYOUT));
}

// ---------------------------------------------------------------------------------------------
// `GET /dbc/ship-paths?v=1&path=&speed=&accel=`.

/** The node table per catalog memo: `DatasetIndexes.reset()` drops the memo map and this with it. */
const NODE_TABLES = new WeakMap<CatalogCache, Promise<Map<number, TaxiPathNodeRow[]>>>();
/**
 * A ceiling on memoised tracks: a few dozen transports exist; a stream of odd parameters is not
 * kept. With `SHIP_TRACK_MAX_SAMPLES` that bounds the memo at about 128 MB in the worst case.
 */
const MAX_MEMOISED_TRACKS = 64;

function memoisedTracks(cache: CatalogCache): number {
  let kept = 0;
  for (const key of cache.keys()) if (key.startsWith(`${SHIP_PATHS_PATHNAME}?`)) kept++;
  return kept;
}

function positiveInteger(value: string | null, maximum: number): number | undefined {
  if (value === null || !/^\d{1,10}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= 1 && number <= maximum ? number : undefined;
}

/**
 * Answers `GET /dbc/ship-paths` — the gateway's catalog-route block (CatalogRoutes.ts) with a key
 * per (path, speed, accel): 403 for a foreign Origin, 400 for another `?v=` or a bad parameter,
 * 200 JSON never cached (a rebuilt dataset resets the memo), 500 with the memo dropped on a failed
 * read. A path the table cannot build answers 200 with `error`, so the browser stops asking.
 */
export async function serveShipPathRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  cache: CatalogCache,
  options: CatalogRouteOptions,
): Promise<boolean> {
  if (request.method !== "GET" || !options.dbcDirectory || url.pathname !== SHIP_PATHS_PATHNAME) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const path = positiveInteger(url.searchParams.get("path"), 0xffff);
  // `moveSpeed` and `accelRate` are uint32 template words (GameObjectData.h `moTransport`).
  const speed = positiveInteger(url.searchParams.get("speed"), 10_000);
  const accel = positiveInteger(url.searchParams.get("accel"), 10_000);
  if (url.searchParams.get("v") !== String(SHIP_PATHS_VERSION) || path === undefined
    || speed === undefined || accel === undefined) {
    response.writeHead(400, { "access-control-allow-origin": origin }).end();
    return true;
  }
  const dbcDirectory = options.dbcDirectory;
  const key = `${SHIP_PATHS_PATHNAME}?path=${path}&speed=${speed}&accel=${accel}`;
  let body = cache.get(key);
  if (!body) {
    let nodes = NODE_TABLES.get(cache);
    if (!nodes) {
      nodes = loadTaxiPathNodes(dbcDirectory);
      NODE_TABLES.set(cache, nodes);
    }
    const table = nodes;
    body = table.then((paths) => JSON.stringify(shipTrackFor(paths, path, speed, accel)));
    if (memoisedTracks(cache) < MAX_MEMOISED_TRACKS) cache.set(key, body);
  }
  try {
    const data = await body;
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(data);
  } catch {
    // Not the rejection again on the next request: the disk may have been mid-build.
    if (cache.get(key) === body) cache.delete(key);
    NODE_TABLES.delete(cache);
    response.writeHead(500, { "access-control-allow-origin": origin }).end();
  }
  return true;
}
