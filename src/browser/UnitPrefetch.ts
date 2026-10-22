/**
 * 22.10 (6.26): a unit's model, look and body start loading when it arrives, not when the renderer admits it.
 *
 * Everything past the display record waits for the renderer to *admit* the unit: the nearest 64 in range, those in
 * view or not yet measurable (a unit with no built model counts as visible, WorldRenderer3D `#unitVisibilityRadius`).
 * Measured in the arrival probe (.runtime/lane-charcache), that already admits a crowd that arrives behind the
 * camera; what it leaves out is everyone past the 64th in a crowded place, who had nothing at all loaded — no item
 * rows, no look, no model file, no body — until a nearer unit left view. Two halves, nearest first:
 *
 * - the page (`UnitLookPrefetch`): the asking path (ui/Frames.ts `unitModelFor`: item rows, the look) for the nearest
 *   units every few frames, admitted or not; it memoises, so a resolved unit costs a lookup;
 * - the renderer (`selectUnitPrefetch`): for the nearest in-range units it did not draw this frame, the model file,
 *   the attached pieces' files and the body atlas, at a priority below every admitted unit's.
 *
 * Nothing is built ahead: geometry, rigs and GPU uploads still happen on admission, under the build budget.
 */

import type { UnitAdmissionCandidate } from "./RenderAdmission.js";
import type { WorldObjectState } from "../world/WorldState.js";

/** How many not-drawn units the renderer prefetches for per pass (the nearest), and every how many frames it passes. */
export const UNIT_PREFETCH_LIMIT = 24;
export const UNIT_PREFETCH_EVERY = 8;
/** How many units the page asks the look of per pass, and how often it passes. */
export const UNIT_LOOK_PREFETCH_LIMIT = 32;
export const UNIT_LOOK_PREFETCH_INTERVAL_MS = 200;
/** Units further than this are not asked about ahead of time (the renderer's draw distance is 220). */
export const UNIT_LOOK_PREFETCH_RANGE = 160;

/**
 * The nearest `limit` candidates the renderer did not draw this frame, nearest first. `drawn` is what it admitted.
 * Pure: the candidates are the admission's own list, so this adds no distance computation.
 */
export function selectUnitPrefetch<T extends { readonly guid: bigint }>(
  candidates: readonly UnitAdmissionCandidate<T>[], drawn: ReadonlySet<bigint>, limit: number = UNIT_PREFETCH_LIMIT,
): T[] {
  if (limit <= 0) return [];
  const rest: UnitAdmissionCandidate<T>[] = [];
  for (const candidate of candidates) if (!drawn.has(candidate.value.guid)) rest.push(candidate);
  rest.sort((left, right) => left.distance - right.distance);
  return rest.slice(0, limit).map((candidate) => candidate.value);
}

/** The objects whose look the page asks for ahead of time: units and players, nearest first, within range. */
export function nearestUnitsForLook(objects: Iterable<WorldObjectState>, self: { x: number; y: number } | undefined,
  limit: number = UNIT_LOOK_PREFETCH_LIMIT, range: number = UNIT_LOOK_PREFETCH_RANGE): WorldObjectState[] {
  if (self === undefined || limit <= 0) return [];
  const near: { object: WorldObjectState; distance: number }[] = [];
  for (const object of objects) {
    if ((object.typeId !== 3 && object.typeId !== 4) || !object.position) continue;
    const distance = Math.hypot(object.position.x - self.x, object.position.y - self.y);
    if (distance <= range) near.push({ object, distance });
  }
  near.sort((left, right) => left.distance - right.distance);
  return near.slice(0, limit).map((entry) => entry.object);
}

/**
 * The page's half: every `UNIT_LOOK_PREFETCH_INTERVAL_MS`, the asking path for the nearest units. The asking path
 * is the one the renderer's admitted units already get (game/RenderLookupsBuilder.ts `requestUnitModels`), so a
 * unit asked here is answered exactly as it would be on admission — only earlier.
 */
export class UnitLookPrefetch {
  #lastAt = Number.NEGATIVE_INFINITY;
  /** Units asked about, for the tests. */
  asked = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  tick(objects: Iterable<WorldObjectState> | undefined, self: { x: number; y: number } | undefined,
    unitModel: (object: WorldObjectState) => unknown): void {
    if (objects === undefined) return;
    const now = this.now();
    if (now - this.#lastAt < UNIT_LOOK_PREFETCH_INTERVAL_MS) return;
    this.#lastAt = now;
    for (const object of nearestUnitsForLook(objects, self)) {
      unitModel(object);
      this.asked++;
    }
  }
}
