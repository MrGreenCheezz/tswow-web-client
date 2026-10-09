import type { PacketReader } from "../protocol/PacketReader.js";
import type { MonsterMove, SplinePoint } from "./MonsterMoveProtocol.js";

/**
 * One reading and one evaluation of a server spline, for the create block (5.02) and
 * `SMSG_MONSTER_MOVE` (5.03) alike (docs/implementation/line-A4.ru.md, М-A4-1).
 *
 * Everything here mirrors TrinityCore's `Movement` namespace; paths are relative to
 * tswow/cores/TrinityCore/src/server/game/Movement/Spline.
 */

/** `MoveSplineFlag::eFlags`, MoveSplineFlag.h:30-57. The low byte is the animation tier. */
export const SPLINE_FLAGS = {
  done: 0x00000100,
  falling: 0x00000200,
  noSpline: 0x00000400,
  parabolic: 0x00000800,
  /**
   * Known to the client as a walk bit, but this core raises it for every unit that can swim
   * (`MoveSplineInit.cpp:201`, `args.flags.canswim = unit->CanSwim()`), so it says nothing about gait.
   */
  canSwim: 0x00001000,
  flying: 0x00002000,
  orientationFixed: 0x00004000,
  finalPoint: 0x00008000,
  finalTarget: 0x00010000,
  finalAngle: 0x00020000,
  catmullRom: 0x00040000,
  cyclic: 0x00080000,
  enterCycle: 0x00100000,
  animation: 0x00200000,
  frozen: 0x00400000,
  transportEnter: 0x00800000,
  transportExit: 0x01000000,
  backward: 0x08000000,
} as const;
export const SPLINE_ANIMATION_TIER_MASK = 0xff;
export const MAX_SPLINE_NODES = 4096;

/** `Movement::gravity`, `terminalVelocity`, `terminalSafefallVelocity` (MovementUtil.cpp:22-27). */
const GRAVITY = 19.29110527038574;
const TERMINAL_VELOCITY = 60.148003;
const SAFE_FALL_TERMINAL_VELOCITY = 7;

export type SplineFacing =
  | { kind: "spot"; x: number; y: number; z: number }
  /** A raw `u64` on the wire in both the create block and MONSTER_MOVE, never a packed guid. */
  | { kind: "target"; guid: bigint }
  | { kind: "angle"; angle: number };

export interface SplineDescription {
  splineId: number;
  /** The raw flags word as the packet carried it (MONSTER_MOVE strips facing, tier and Done). */
  flags: number;
  /** The real path `c0 … c(N-1)`: the virtual end points of `Spline::points` are cut off. */
  points: SplinePoint[];
  durationMs: number;
  /** Time already spent on the path when the packet was written (create block only). */
  timePassedMs: number;
  cyclic: boolean;
  /** The first lap starts at `c0`; every later lap starts at `c1` (`MoveSpline::_updateState`). */
  enterCycle: boolean;
  /** `Flying|Catmullrom` or a create block's mode byte 1. Evaluated as a polyline for now (5.03в). */
  catmullRom: boolean;
  flying: boolean;
  orientationFixed: boolean;
  backward: boolean;
  falling: boolean;
  parabolic: { acceleration: number; startMs: number } | undefined;
  animation: { tier: number; startMs: number } | undefined;
  facing: SplineFacing | undefined;
}

/**
 * The create-block spline, `PacketBuilder::WriteCreate` (MovementPacketBuilder.cpp:147-186).
 *
 * Its nodes are the whole of `Spline::points`, virtual ends included. `SplineBase::initializers`
 * (Spline.cpp:50-52) uses `InitCatmullRom` for the linear mode too, so the layout is one for both:
 * `[virtual, c0 … c(N-1), c(N-1)]` without a cycle, `[virtual, c0 … c(N-1), c(k), c(k+1)]` with one
 * (`InitCatmullRom`, Spline.cpp:~205-235), `k` being 1 exactly when `Enter_Cycle` is still set.
 */
export function readCreateSpline(reader: PacketReader): SplineDescription {
  const flags = reader.u32();
  let facing: SplineFacing | undefined;
  if (flags & SPLINE_FLAGS.finalAngle) facing = { kind: "angle", angle: reader.f32() };
  else if (flags & SPLINE_FLAGS.finalTarget) facing = { kind: "target", guid: reader.u64() };
  else if (flags & SPLINE_FLAGS.finalPoint) facing = { kind: "spot", x: reader.f32(), y: reader.f32(), z: reader.f32() };
  const timePassedMs = reader.u32();
  const durationMs = reader.u32();
  const splineId = reader.u32();
  reader.f32(); // duration_mod, always 1
  reader.f32(); // duration_mod_next, always 1
  const verticalAcceleration = reader.f32();
  const effectStartMs = reader.u32();
  const nodeCount = reader.u32();
  if (nodeCount > MAX_SPLINE_NODES) throw new RangeError(`Invalid spline node count ${nodeCount}`);
  const nodes: SplinePoint[] = new Array(nodeCount);
  for (let index = 0; index < nodeCount; index++) nodes[index] = { x: reader.f32(), y: reader.f32(), z: reader.f32() };
  const mode = reader.u8();
  reader.f32(); // FinalDestination, or zero for a cycle: the last real node says the same
  reader.f32();
  reader.f32();

  const cyclic = (flags & SPLINE_FLAGS.cyclic) !== 0;
  const tail = cyclic ? 2 : 1;
  const points = nodeCount >= 1 + tail + 1 ? nodes.slice(1, nodeCount - tail) : [];
  return {
    splineId,
    flags,
    points,
    durationMs,
    timePassedMs,
    cyclic,
    enterCycle: cyclic && (flags & SPLINE_FLAGS.enterCycle) !== 0,
    catmullRom: mode === 1,
    flying: (flags & SPLINE_FLAGS.flying) !== 0,
    orientationFixed: (flags & SPLINE_FLAGS.orientationFixed) !== 0,
    backward: (flags & SPLINE_FLAGS.backward) !== 0,
    falling: (flags & SPLINE_FLAGS.falling) !== 0,
    parabolic: flags & SPLINE_FLAGS.parabolic ? { acceleration: verticalAcceleration, startMs: effectStartMs } : undefined,
    animation: flags & SPLINE_FLAGS.animation
      ? { tier: flags & SPLINE_ANIMATION_TIER_MASK, startMs: effectStartMs }
      : undefined,
    facing,
  };
}

/** The same description out of a parsed `SMSG_MONSTER_MOVE`, which starts at time zero. */
export function describeMonsterMove(move: MonsterMove): SplineDescription {
  const flags = move.flags ?? 0;
  const catmullRom = (flags & (SPLINE_FLAGS.flying | SPLINE_FLAGS.catmullRom)) !== 0;
  // A linear cycle is written by `WriteLinearPath` over the cyclic layout, whose last "real" node
  // is the closing point `c(k)` (MovementPacketBuilder.cpp:96-113 over Spline.cpp InitCatmullRom):
  // the packet's path already ends where the lap closes, which `buildTrack` adds itself.
  const points = (flags & SPLINE_FLAGS.cyclic) !== 0 && !catmullRom && move.points.length > 2
    ? move.points.slice(0, -1)
    : move.points;
  const facing = move.facing
    ?? (move.finalOrientation === undefined ? undefined : { kind: "angle" as const, angle: move.finalOrientation });
  return {
    splineId: move.splineId ?? 0,
    flags,
    points,
    durationMs: move.duration,
    timePassedMs: 0,
    cyclic: move.cyclic,
    enterCycle: move.cyclic && (move.enterCycle ?? (flags & SPLINE_FLAGS.enterCycle) !== 0),
    catmullRom,
    flying: move.flying === true || (flags & SPLINE_FLAGS.flying) !== 0,
    orientationFixed: (flags & SPLINE_FLAGS.orientationFixed) !== 0,
    backward: (flags & SPLINE_FLAGS.backward) !== 0,
    falling: (flags & SPLINE_FLAGS.falling) !== 0,
    parabolic: move.parabolic,
    animation: move.animation,
    facing,
  };
}

/** A path with its cumulative lengths; time along it is proportional to distance. */
export interface SplinePath {
  points: SplinePoint[];
  /** `lengths[i]` is the distance from `points[0]` to `points[i]`; `lengths[0] === 0`. */
  lengths: number[];
  total: number;
}

/** A description made ready to sample every frame: lengths are worked out once, here. */
export interface SplineTrack {
  readonly desc: SplineDescription;
  /** The unit's facing when the path began; `OrientationFixed` and `Falling` keep it. */
  readonly initialOrientation: number;
  /** The whole path, closed for a cycle (on `c1` under `Enter_Cycle`, else on `c0`). */
  readonly first: SplinePath;
  /** Every lap after the first under `Enter_Cycle`: `c1 … c(N-1), c1`, in the same duration. */
  readonly loop: SplinePath | undefined;
  /** Whether the first lap is behind: every lap from then on runs `loop`. */
  looped: boolean;
  /**
   * The lap clock of a cycle, as Wow.exe keeps it (0x0098CA00): the elapsed time the current lap
   * began at, its length (`duration × duration_mod`), and the modifier the next lap takes up
   * (`duration_mod_next`), which only `SMSG_FLIGHT_SPLINE_SYNC` sets (`resyncTrack`).
   */
  lapStartMs: number;
  lapDurationMs: number;
  nextDurationMod: number;
}

/**
 * Whether a description can run: two points, a duration, and — without a cycle — time left.
 * Anything else is a unit standing where its block put it (a stopped or finished spline).
 */
export function isRunnableSpline(desc: SplineDescription): boolean {
  return desc.points.length >= 2 && desc.durationMs > 0 && (desc.cyclic || desc.timePassedMs < desc.durationMs);
}

export function buildTrack(desc: SplineDescription, initialOrientation: number): SplineTrack {
  const points = desc.points;
  let first: SplinePoint[] = points;
  let loop: SplinePath | undefined;
  if (desc.cyclic) {
    // `MoveSpline::init_spline`: `cyclic_point = 1` under Enter_Cycle, which `MoveSplineInit::Launch`
    // always sets with a cycle (MoveSplineInit.cpp:92, MoveSpline.cpp:126); the path closes there.
    const close = desc.enterCycle && points.length > 2 ? 1 : 0;
    first = [...points, points[close]!];
    if (close === 1) loop = measure([...points.slice(1), points[1]!]);
  }
  return {
    desc, initialOrientation, first: measure(first), loop, looped: false,
    lapStartMs: 0, lapDurationMs: desc.durationMs, nextDurationMod: 1,
  };
}

/**
 * Brings a cycle's lap clock up to `elapsedMs` and returns the time into the current lap.
 *
 * At a lap boundary Wow.exe (0x0098CA00) carries the overshoot into the next lap, drops `c0` after
 * the first one under Enter_Cycle (0x0098C940), and takes up `duration_mod_next` as the new lap's
 * modifier, resetting it to 1. Laps after that one are all `durationMs` long, so a long gap (a
 * hidden tab) is skipped in one step rather than lap by lap.
 */
function advanceLaps(track: SplineTrack, elapsedMs: number): number {
  let into = elapsedMs - track.lapStartMs;
  if (into < track.lapDurationMs) return into < 0 ? 0 : into;
  track.lapStartMs += track.lapDurationMs;
  track.lapDurationMs = lapLength(track.desc.durationMs, track.nextDurationMod);
  track.nextDurationMod = 1;
  if (track.loop) track.looped = true;
  into = elapsedMs - track.lapStartMs;
  if (into >= track.lapDurationMs) {
    track.lapStartMs += track.lapDurationMs;
    into -= track.lapDurationMs;
    const lap = track.lapDurationMs = track.desc.durationMs;
    const skipped = Math.floor(into / lap);
    track.lapStartMs += skipped * lap;
    into -= skipped * lap;
  }
  return into;
}

/** `duration × mod` rounded half up, as the client's truncating FPU mode does it after adding ½. */
function lapLength(durationMs: number, mod: number): number {
  return Math.max(1, Math.floor(durationMs * mod + 0.5));
}

/** Wow.exe's bounds on a synced lap's pace (0x0098B5D0): half to double the nominal duration. */
const MIN_DURATION_MOD = 0.5;
const MAX_DURATION_MOD = 2;

/**
 * `SMSG_FLIGHT_SPLINE_SYNC` as Wow.exe applies it (0x0098B5D0): not a jump to the server's point,
 * but the next lap's pace. The phase error — the server's progress less the client's, wrapped into
 * ±½ lap so a client just short of the lap end is not sent round again — shortens or stretches the
 * next lap by as much, within ½…2 of its duration; the current lap runs on unchanged. A path that
 * does not loop never reaches a next lap, so a sync for one changes nothing.
 */
export function resyncTrack(track: SplineTrack, elapsedMs: number, progress: number): void {
  const duration = track.desc.durationMs;
  if (!track.desc.cyclic || !Number.isFinite(progress)) return;
  const into = advanceLaps(track, elapsedMs);
  let delta = progress - into / track.lapDurationMs;
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  const next = (duration - Math.round(duration * delta)) / duration;
  track.nextDurationMod = Math.min(MAX_DURATION_MOD, Math.max(MIN_DURATION_MOD, next));
}

function measure(points: SplinePoint[]): SplinePath {
  const lengths = new Array<number>(points.length);
  lengths[0] = 0;
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const next = points[index]!;
    total += Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z);
    lengths[index] = total;
  }
  return { points, lengths, total };
}

export interface SplineSample {
  x: number;
  y: number;
  z: number;
  orientation: number;
}

/**
 * The position and facing `elapsedMs` into the track, written into `out`; returns whether a
 * noncyclic path has arrived. Mirrors `MoveSpline::ComputePosition` (MoveSpline.cpp:26-63):
 *
 * - parabolic and falling elevation are added to the path's height, never both, and never under
 *   `Animation`;
 * - on arrival an angle or spot facing is applied; a target facing is left to the caller, which
 *   knows where the target is (the core does nothing for it either, the client turns itself);
 * - on the way, the tangent unless `OrientationFixed|Falling`, then minus π for `Backward`.
 *
 * `currentOrientation` answers for a zero-length stretch, whose tangent is `atan2(0, 0) = 0`: a
 * facing-only spline (two equal points, `minimal_duration = 1`, MoveSpline.cpp:~88) would otherwise
 * flash its unit north for a frame.
 */
export function sampleSpline(track: SplineTrack, elapsedMs: number, currentOrientation: number, out: SplineSample): boolean {
  const desc = track.desc;
  const duration = desc.durationMs;
  let time: number;
  let path = track.first;
  let done = false;
  if (desc.cyclic) {
    // Within the lap, as on all but one frame a lap, without a call: a double argument or result
    // of a call that is not inlined is boxed, which is garbage per unit per frame.
    let into = elapsedMs - track.lapStartMs;
    if (into >= track.lapDurationMs) into = advanceLaps(track, elapsedMs);
    else if (into < 0) into = 0;
    if (track.looped && track.loop) path = track.loop;
    // The lap's own length paces it; the effects below count in nominal milliseconds.
    time = (into / track.lapDurationMs) * duration;
  } else if (elapsedMs >= duration) {
    time = duration;
    done = true;
  } else {
    time = Math.max(0, elapsedMs);
  }

  const points = path.points;
  const lengths = path.lengths;
  const last = points.length - 1;
  let segment: number;
  let ratio: number;
  if (done || path.total === 0) {
    segment = Math.max(0, last - 1);
    ratio = done ? 1 : 0;
  } else {
    const distance = (time / duration) * path.total;
    // Binary search for the stretch holding `distance`: lengths[segment] <= distance < lengths[segment + 1].
    let low = 0;
    let high = last - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lengths[middle]! <= distance) low = middle;
      else high = middle - 1;
    }
    segment = low;
    const span = lengths[segment + 1]! - lengths[segment]!;
    ratio = span === 0 ? 0 : Math.min(1, (distance - lengths[segment]!) / span);
  }
  const start = points[segment]!;
  const end = points[Math.min(segment + 1, last)]!;
  if (done) {
    out.x = end.x;
    out.y = end.y;
    out.z = end.z;
  } else {
    out.x = start.x + (end.x - start.x) * ratio;
    out.y = start.y + (end.y - start.y) * ratio;
    out.z = start.z + (end.z - start.z) * ratio;
  }

  if (desc.animation === undefined) {
    if (desc.parabolic) out.z += parabolicElevation(desc.parabolic, duration, time);
    else if (desc.falling) out.z = Math.max(points[0]!.z - fallDistance(time / 1000), points[last]!.z);
  }

  const facing = desc.facing;
  if (done && facing && facing.kind !== "target") {
    out.orientation = facing.kind === "angle" ? facing.angle : Math.atan2(facing.y - out.y, facing.x - out.x);
    return done;
  }
  let orientation = track.initialOrientation;
  if (!desc.orientationFixed && !desc.falling) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) {
      // Already the facing this stretch should keep, `Backward` included.
      out.orientation = currentOrientation;
      return done;
    }
    orientation = Math.atan2(dy, dx);
  }
  out.orientation = desc.backward ? orientation - Math.PI : orientation;
  return done;
}

/**
 * `MoveSpline::computeParabolicElevation` (MoveSpline.cpp:65-76): nothing until the effect starts,
 * then `(Tdur − Tpassed)·a/2·Tpassed`, both counted from the effect start — so the arc peaks
 * halfway through what is left, at `a·Tdur²/8`, which is the amplitude `MoveSpline::Initialize`
 * solved `a` from.
 */
export function parabolicElevation(parabolic: { acceleration: number; startMs: number }, durationMs: number, timeMs: number): number {
  if (timeMs <= parabolic.startMs) return 0;
  const passed = (timeMs - parabolic.startMs) / 1000;
  const remaining = (durationMs - parabolic.startMs) / 1000;
  return (remaining - passed) * 0.5 * parabolic.acceleration * passed;
}

/** `Movement::computeFallElevation` (MovementUtil.cpp:57-80): distance fallen after `seconds`. */
export function fallDistance(seconds: number, safeFall = false, startVelocity = 0): number {
  const terminal = safeFall ? SAFE_FALL_TERMINAL_VELOCITY : TERMINAL_VELOCITY;
  const velocity = Math.min(startVelocity, terminal);
  const terminalTime = terminal / GRAVITY - velocity / GRAVITY;
  if (seconds > terminalTime) {
    return terminal * (seconds - terminalTime) + velocity * terminalTime + GRAVITY * terminalTime * terminalTime * 0.5;
  }
  return seconds * (velocity + seconds * GRAVITY * 0.5);
}

/** The spline's animation tier once its effect has started, else undefined (5.03). */
export function trackAnimationTier(track: SplineTrack, elapsedMs: number): number | undefined {
  const animation = track.desc.animation;
  return animation && elapsedMs >= animation.startMs ? animation.tier : undefined;
}
