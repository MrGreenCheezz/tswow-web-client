import type * as THREE from "three";
import { hypot2 } from "./GroundCover.js";
import type { WmoGroup } from "./WmoModel.js";

/** P1-12b: whether a placement's last attached selection holds exactly these groups, in order. */
export function sameWmoSelection(applied: readonly number[] | undefined, selected: readonly number[]): boolean {
  if (applied === undefined || applied.length !== selected.length) return false;
  for (let at = 0; at < selected.length; at++) {
    if (applied[at] !== selected[at]) return false;
  }
  return true;
}

/** P1-12: `select` calls and recomputes summed over the tables that share this object. */
export interface WmoRangeTotals {
  selects: number;
  recomputes: number;
}

/** A group with no triangles: never chosen. */
const KIND_EMPTY = 0;
/** A non-empty group with no trustworthy box: always chosen (conservative). */
const KIND_ALWAYS = 1;
/** Chosen while the player's flat distance to its box is under its leash. */
const KIND_RANGED = 2;

/**
 * P1-12a (ENV-7): `wmoGroupsInRange` for one placed building, answered from a rest radius.
 *
 * The flat distance from the player to a group's box is 1-Lipschitz in the player's position, so
 * while the player stays nearer to where the set was last computed than the smallest gap between
 * any group's distance and its leash, no group can cross its leash and the set is the same, bit for
 * bit. Inside that radius {@link select} returns the array it returned last; outside it recomputes
 * with the same arithmetic as `wmoGroupsInRange` (`hypot2` is `Math.hypot` double for double) and
 * keeps the old array when the answer did not change. The boxes, flags and triangle counts of a
 * placed building are fixed, so they are read once into typed arrays and a recompute allocates
 * nothing unless the set itself changed.
 */
export class WmoRangeTable {
  readonly #kind: Uint8Array;
  /** Whether the group holds the shell leash (`exterior || !indoor`) rather than the room one. */
  readonly #shell: Uint8Array;
  readonly #minX: Float64Array;
  readonly #maxX: Float64Array;
  readonly #minZ: Float64Array;
  readonly #maxZ: Float64Array;
  /** The shell leash each group earns by its box (`shellRange(box)`); unused for rooms. */
  readonly #shellByBox: Float64Array;
  /** The leash in force for each ranged group. */
  readonly #range: Float64Array;
  readonly #roomRange: number;
  /** The caller's shell override the leashes were filled for (undefined: by box size). */
  #shellOverride: number | undefined;
  #result: readonly number[] | undefined;
  readonly #scratch: number[] = [];
  /** The position of the last recompute — the centre of the rest radius, not the last call. */
  #x = Number.NaN;
  #y = Number.NaN;
  #slackSq = 0;
  /** Recomputes so far (tests and diagnostics). */
  recomputes = 0;
  /** `select` calls so far; `recomputes / selects` is the share the rest radius did not answer. */
  selects = 0;
  /**
   * P1-12 telemetry: totals shared by many tables (the renderer's, by kind of table), counted with
   * the two above when set; undefined counts into this table alone.
   */
  totals: WmoRangeTotals | undefined = undefined;

  constructor(
    model: { readonly groups: readonly Pick<WmoGroup, "triangleCount" | "exterior" | "indoor">[] },
    boxes: readonly (THREE.Box3 | undefined)[],
    roomRange: number,
    shellRange: (box: THREE.Box3) => number,
  ) {
    const count = model.groups.length;
    this.#kind = new Uint8Array(count);
    this.#shell = new Uint8Array(count);
    this.#minX = new Float64Array(count);
    this.#maxX = new Float64Array(count);
    this.#minZ = new Float64Array(count);
    this.#maxZ = new Float64Array(count);
    this.#shellByBox = new Float64Array(count);
    this.#range = new Float64Array(count);
    this.#roomRange = roomRange;
    for (let index = 0; index < count; index++) {
      const group = model.groups[index]!;
      if (group.triangleCount === 0) continue;
      const box = boxes[index];
      if (!box) {
        this.#kind[index] = KIND_ALWAYS;
        continue;
      }
      this.#kind[index] = KIND_RANGED;
      this.#minX[index] = box.min.x;
      this.#maxX[index] = box.max.x;
      this.#minZ[index] = box.min.z;
      this.#maxZ[index] = box.max.z;
      if (group.exterior || !group.indoor) {
        this.#shell[index] = 1;
        this.#shellByBox[index] = shellRange(box);
      }
    }
    this.#fillRanges(undefined);
  }

  /**
   * The groups worth drawing with the player at (x, y), exactly as
   * `wmoGroupsInRange(model, boxes, { x, y }, roomRange, shellRange)` answers; the same array while
   * the answer is unchanged. `shellRange` is the moving-transport hull leash (05.10-7.05-review).
   */
  select(x: number, y: number, shellRange?: number): readonly number[] {
    this.selects++;
    if (this.totals !== undefined) this.totals.selects++;
    if (shellRange !== this.#shellOverride) {
      this.#fillRanges(shellRange);
      this.#slackSq = 0;
      this.#x = Number.NaN;
    }
    const result = this.#result;
    if (result !== undefined) {
      const dx = x - this.#x;
      const dy = y - this.#y;
      // A NaN anywhere fails both tests and recomputes.
      if ((dx === 0 && dy === 0) || dx * dx + dy * dy < this.#slackSq) return result;
    }
    return this.#recompute(x, y);
  }

  #fillRanges(shellRange: number | undefined): void {
    this.#shellOverride = shellRange;
    for (let index = 0; index < this.#range.length; index++) {
      this.#range[index] = this.#shell[index] ? shellRange ?? this.#shellByBox[index]! : this.#roomRange;
    }
  }

  #recompute(x: number, y: number): readonly number[] {
    this.recomputes++;
    if (this.totals !== undefined) this.totals.recomputes++;
    const z = -y;
    const scratch = this.#scratch;
    let count = 0;
    let minGap = Infinity;
    let unordered = false;
    for (let index = 0; index < this.#kind.length; index++) {
      const kind = this.#kind[index];
      if (kind === KIND_EMPTY) continue;
      if (kind === KIND_ALWAYS) {
        scratch[count++] = index;
        continue;
      }
      const outsideX = Math.max(this.#minX[index]! - x, 0, x - this.#maxX[index]!);
      const outsideZ = Math.max(this.#minZ[index]! - z, 0, z - this.#maxZ[index]!);
      const distance = hypot2(outsideX, outsideZ);
      const range = this.#range[index]!;
      if (distance < range) scratch[count++] = index;
      const gap = Math.abs(distance - range);
      if (gap !== gap) unordered = true;
      else if (gap < minGap) minGap = gap;
    }
    // A margin for rounding in the subtractions and the square root: far under a millimetre.
    const safe = unordered ? 0 : Math.max(0, minGap * (1 - 1e-9) - 1e-6);
    this.#slackSq = safe * safe;
    this.#x = x;
    this.#y = y;
    const previous = this.#result;
    if (previous !== undefined && previous.length === count) {
      let same = true;
      for (let index = 0; index < count; index++) {
        if (previous[index] !== scratch[index]) {
          same = false;
          break;
        }
      }
      if (same) return previous;
    }
    const next = scratch.slice(0, count);
    this.#result = next;
    return next;
  }
}
