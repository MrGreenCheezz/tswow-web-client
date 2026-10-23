/**
 * 24.10 (7.50): the light trace of `bench/lookdev.mjs --light-trace` — when each lamp's light first
 * appears while the world streams in. Owner, 24.10: «Крайне сильно заметно, как источники света
 * загораются при подгрузке». Two sequences, both at night on the bench's real renderer:
 *
 * - `run`: settled at the first waypoint, then the player runs the path at `speed` yards a second,
 *   the camera looking along it. Every light drawn (selected pool, halo or far glow) is keyed by its
 *   position, and the distance from the player at the frame it first appears is kept. A lamp the
 *   player approaches should first show at the far-glow range (280 yards, or the fog), not near.
 * - `arrival`: settled at `from`, then teleported to the first waypoint and held there. The curtain
 *   of the live client lifts when the ground under the player is in (`LoadingScreen.ts`; the bench
 *   has no collision, so terrain alone plus the three soak frames). Which lights stand within reach
 *   at that frame, and how many seconds the others take to appear, against the settled set.
 *
 * Positions are world coordinates (x north, y west, z up) from `WorldRenderer3D.lightCensus`.
 */
import type { LightCensusFrame } from "../LightCensus.js";

export interface LightTraceSpec {
  readonly name: string;
  readonly mode: "run" | "arrival";
  /** Waypoints, world x/y; the run follows them, an arrival stands at the first. */
  readonly path: readonly (readonly [number, number])[];
  /** Where an arrival settles before the teleport. */
  readonly from?: readonly [number, number];
  readonly halfMinute: number;
  readonly pitch?: number;
  readonly orbit?: number;
  /** Yards a second along the path (7: running). */
  readonly speed?: number;
  /** Seconds an arrival is held after the teleport. */
  readonly holdSeconds?: number;
  /** Seconds of world time per frame (1/60). */
  readonly frameSeconds?: number;
  /** Strength below which a light is not counted as drawn. */
  readonly threshold?: number;
  /**
   * Hold each frame to its world time (default true): loading then runs against the clock as it does
   * live, where the bench otherwise draws two to three world seconds a second and lets assets land early.
   */
  readonly realtime?: boolean;
}

export interface LightTraceDeps {
  readonly render: (seconds: number, elapsed: number, frame: number) => void;
  readonly settle: () => Promise<unknown>;
  readonly nextFrame: () => Promise<number>;
  readonly census: () => LightCensusFrame | undefined;
  /** Stands the player (route point) and points the camera; yaw is relative to the player's facing. */
  readonly place: (x: number, y: number, yaw: number, pitch: number, orbit: number, halfMinute: number) => void;
  readonly player: () => { x: number; y: number; z: number };
  readonly terrainReady: (x: number, y: number) => boolean;
  /** Environment placements with a built model, and how many the client still waits for. */
  readonly progress: () => unknown;
}

interface LightRecord {
  x: number; y: number; z: number;
  firstFrame: number; firstSeconds: number; firstDistance: number; firstKind: "near" | "glow"; firstStrength: number;
  /** Player position when it first appeared. */
  px: number; py: number;
}

const CELL = 2;
/** First drawn strength at or above which an appearance counts as switching on (a lamp's glow at 100 yd is ~1). */
const POP_STRENGTH = 0.3;
const key = (x: number, y: number, z: number): string =>
  `${Math.round(x / CELL)},${Math.round(y / CELL)},${Math.round(z / CELL)}`;

/** The camera yaw that looks along world heading `theta` (atan2 of dy, dx): the player faces orientation π. */
export function yawAlong(theta: number): number {
  const yaw = theta + Math.PI;
  return ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function visitCensus(frame: LightCensusFrame | undefined, threshold: number,
  visit: (x: number, y: number, z: number, strength: number, kind: "near" | "glow") => void): void {
  if (!frame) return;
  for (const [list, kind] of [[frame.near, "near"], [frame.glows, "glow"]] as const) {
    for (let at = 0; at + 3 < list.length; at += 4) {
      if (list[at + 3]! > threshold) visit(list[at]!, list[at + 1]!, list[at + 2]!, list[at + 3]!, kind);
    }
  }
}

/** The lights of one census within `range` yards of `centre`, keyed. */
function present(frame: LightCensusFrame | undefined, threshold: number, centre: { x: number; y: number; z: number },
  range: number): Map<string, number> {
  const found = new Map<string, number>();
  visitCensus(frame, threshold, (x, y, z, strength) => {
    const distance = Math.hypot(x - centre.x, y - centre.y, z - centre.z);
    if (distance <= range) found.set(key(x, y, z), distance);
  });
  return found;
}

function bins(distances: readonly number[], edges: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let index = 0; index <= edges.length; index++) {
    const low = index === 0 ? 0 : edges[index - 1]!;
    const high = index === edges.length ? Infinity : edges[index]!;
    out[`${low}-${high === Infinity ? "" : high}`] = distances.filter((d) => d >= low && d < high).length;
  }
  return out;
}

export async function runLightTrace(spec: LightTraceSpec, deps: LightTraceDeps): Promise<unknown> {
  const dt = spec.frameSeconds ?? 1 / 60;
  const threshold = spec.threshold ?? 0.01;
  const pitch = spec.pitch ?? -0.2;
  const orbit = spec.orbit ?? 12;
  const [start] = spec.path;
  if (!start) throw new Error("light trace needs a path");
  const heading = (index: number): number => {
    const a = spec.path[Math.min(index, spec.path.length - 2)] ?? start;
    const b = spec.path[Math.min(index + 1, spec.path.length - 1)] ?? start;
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const records = new Map<string, LightRecord>();
  let frame = 0;
  let seconds = 0;
  const record = (census: LightCensusFrame | undefined): void => {
    const p = deps.player();
    visitCensus(census, threshold, (x, y, z, strength, kind) => {
      const id = key(x, y, z);
      if (records.has(id)) return;
      records.set(id, { x, y, z, firstFrame: frame, firstSeconds: seconds, firstKind: kind, firstStrength: strength,
        firstDistance: Math.hypot(x - p.x, y - p.y, z - p.z), px: p.x, py: p.y });
    });
  };
  let clockStart = -1;
  const step = async (): Promise<void> => {
    await deps.nextFrame();
    if (spec.realtime !== false) {
      if (clockStart < 0) clockStart = performance.now() - seconds * 1000;
      while (performance.now() - clockStart < seconds * 1000) await deps.nextFrame();
    }
    deps.render(seconds, dt, frame);
    record(deps.census());
    frame++;
    seconds += dt;
  };

  if (spec.mode === "run") {
    deps.place(start[0], start[1], yawAlong(heading(0)), pitch, orbit, spec.halfMinute);
    await deps.settle();
    await step();
    const initial = records.size;
    for (const value of records.values()) value.firstFrame = -1;
    const speed = spec.speed ?? 7;
    const timeline: unknown[] = [];
    for (let leg = 0; leg + 1 < spec.path.length; leg++) {
      const a = spec.path[leg]!, b = spec.path[leg + 1]!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(length / (speed * dt)));
      const yaw = yawAlong(heading(leg));
      for (let index = 1; index <= steps; index++) {
        const t = index / steps;
        deps.place(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, yaw, pitch, orbit, spec.halfMinute);
        await step();
        if (frame % 60 === 0) {
          const census = deps.census();
          timeline.push({ frame, seconds: Number(seconds.toFixed(2)), near: (census?.near.length ?? 0) / 4,
            glows: (census?.glows.length ?? 0) / 4, progress: deps.progress() });
        }
      }
    }
    const appeared = [...records.values()].filter((value) => value.firstFrame >= 0);
    // A light that shows at a third of a lamp's strength or more within 250 yards switched on there; one
    // that came in faint at the edge of its range (the far glow's fade, the selection's) did not.
    const pops = appeared.filter((value) => value.firstStrength >= POP_STRENGTH && value.firstDistance < 250);
    const distances = appeared.map((value) => value.firstDistance);
    const sorted = [...distances].sort((a, b) => a - b);
    return {
      name: spec.name, mode: spec.mode, frames: frame, seconds: Number(seconds.toFixed(2)),
      initial, appeared: appeared.length,
      firstDistanceBins: bins(distances, [32, 64, 100, 150, 200, 250]),
      under150: distances.filter((d) => d < 150).length,
      under64: distances.filter((d) => d < 64).length,
      median: sorted[sorted.length >> 1] ?? null,
      pops: pops.length,
      popBins: bins(pops.map((value) => value.firstDistance), [64, 100, 150, 200]),
      lights: appeared.map((value) => ({ ...value, x: +value.x.toFixed(1), y: +value.y.toFixed(1), z: +value.z.toFixed(1),
        firstDistance: +value.firstDistance.toFixed(1), firstSeconds: +value.firstSeconds.toFixed(2) })),
      timeline,
    };
  }

  // Arrival: settle elsewhere, then stand at the destination from the teleport on.
  const from = spec.from ?? start;
  const yaw = yawAlong(heading(0));
  deps.place(from[0], from[1], yaw, pitch, orbit, spec.halfMinute);
  await deps.settle();
  records.clear();
  deps.place(start[0], start[1], yaw, pitch, orbit, spec.halfMinute);
  const hold = spec.holdSeconds ?? 20;
  let liftFrame = -1;
  let readyFrame = -1;
  let liftCensus: LightCensusFrame | undefined;
  const snapshots: { seconds: number; census: LightCensusFrame | undefined }[] = [];
  const marks = [0, 0.5, 1, 2, 3, 5, 8, 12, 20];
  let mark = 0;
  while (seconds < hold || liftFrame < 0) {
    await step();
    if (readyFrame < 0 && deps.terrainReady(start[0], start[1])) readyFrame = frame;
    if (liftFrame < 0 && readyFrame >= 0 && frame >= readyFrame + 3) {
      liftFrame = frame;
      liftCensus = deps.census();
    }
    if (liftFrame >= 0) {
      const after = (frame - liftFrame) * dt;
      while (mark < marks.length && after >= marks[mark]!) {
        snapshots.push({ seconds: marks[mark]!, census: deps.census() });
        mark++;
      }
    }
    if (frame > 60 * 120) break;
  }
  await deps.settle();
  for (let index = 0; index < 30; index++) await step();
  const settled = deps.census();
  const centre = deps.player();
  const report: Record<string, unknown> = { name: spec.name, mode: spec.mode, liftFrame, readyFrame, frames: frame };
  for (const range of [64, 100, 150]) {
    const all = present(settled, threshold, centre, range);
    const atLift = present(liftCensus, threshold, centre, range);
    const missing = [...all.keys()].filter((id) => !atLift.has(id));
    report[`within${range}`] = {
      settled: all.size,
      atLift: [...all.keys()].filter((id) => atLift.has(id)).length,
      missingAtLift: missing.length,
      byTime: Object.fromEntries(snapshots.map(({ seconds: at, census }) => {
        const there = present(census, threshold, centre, range);
        return [`+${at}s`, [...all.keys()].filter((id) => there.has(id)).length];
      })),
      missingNearest: missing.map((id) => +(all.get(id) ?? 0).toFixed(1)).sort((a, b) => a - b).slice(0, 12),
      // Seconds after the lift each missing one first showed (distance @ seconds).
      lateAppearances: missing.map((id) => {
        const found = records.get(id);
        return found ? `${(all.get(id) ?? 0).toFixed(0)}yd@${((found.firstFrame - liftFrame) * dt).toFixed(2)}s` : "settle";
      }).slice(0, 40),
    };
  }
  report["progress"] = deps.progress();
  return report;
}
