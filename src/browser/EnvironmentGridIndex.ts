/**
 * P2-04a (first step): the renderer's environment index, built in a fraction of the time.
 *
 * Same contract and the same answers as {@link EnvironmentSpatialIndex}, which stays as the
 * reference: the same cells (`objectCellCoverage`), the same fallback rule and entry cap, the same
 * query rectangle, the same conservative pool in source order, the same visit counts, and the same
 * frozen result from `queryCached` while the rectangle holds. Only the representation differs:
 *
 * - cells are numeric keys into one flat `Int32Array` of source ordinals (CSR), instead of a
 *   `Map<string, frozen entry[]>` with a template-string key per covered cell and a frozen
 *   `{object, ordinal}` record per placement;
 * - a query marks ordinals in a reused stamp array and sorts the hits as numbers, instead of
 *   building a `Set` of records and sorting it with a comparator.
 *
 * On Stormwind's footprint (16 818 placements) the reference spends ≈ 10 ms per landing tile on
 * construction alone (`.runtime/perf-step23/probe-env-reselect.mjs`); see `docs/PERF_STATUS.md`.
 */

import type { EnvironmentObject } from "../gateway/VMapProtocol.js";
import {
  ENVIRONMENT_SPATIAL_CELL_SIZE, ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT, ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES,
  cellIndex, objectCellCoverage, validCellSize, validQuery,
  type CachedEnvironmentSpatialQuery, type CellCoverage, type EnvironmentSpatialQuery,
} from "./EnvironmentSpatialIndex.js";

/** Mirrors the reference's private query cap. */
const MAX_QUERY_CELLS = 4_096;
/** Cell coordinates within ±2^20 pack into one exact number; anything wider keys by string. */
const PACK_LIMIT = 1 << 20;
const PACK_STRIDE = 2 ** 21;

function packedKey(x: number, y: number): number | undefined {
  return x >= -PACK_LIMIT && x < PACK_LIMIT && y >= -PACK_LIMIT && y < PACK_LIMIT
    ? (x + PACK_LIMIT) * PACK_STRIDE + (y + PACK_LIMIT) : undefined;
}

export class EnvironmentGridIndex {
  readonly #objects: readonly EnvironmentObject[];
  readonly #cellSize: number;
  /** Cell key → slot; slot `s` owns `#ordinals[#offsets[s] .. #offsets[s + 1])`, ascending. */
  readonly #slots = new Map<number, number>();
  readonly #wideSlots = new Map<string, number>();
  readonly #offsets: Int32Array;
  readonly #ordinals: Int32Array;
  /** Ordinals that sit in no cell, ascending; part of every valid query. */
  readonly #fallback: Int32Array;
  /** Per-ordinal stamp of the query that last took it, and the hit buffer it fills. */
  readonly #seen: Uint32Array;
  readonly #hits: Int32Array;
  #stamp = 0;
  #lastQuery: { cells: CellCoverage; result: CachedEnvironmentSpatialQuery } | undefined;

  constructor(objects: readonly EnvironmentObject[], cellSize = ENVIRONMENT_SPATIAL_CELL_SIZE) {
    this.#objects = Object.freeze(objects.slice());
    const count = this.#objects.length;
    this.#cellSize = validCellSize(cellSize) ? cellSize : Number.NaN;
    this.#seen = new Uint32Array(count);
    this.#hits = new Int32Array(count);
    if (!Number.isFinite(this.#cellSize)) {
      this.#offsets = new Int32Array(1);
      this.#ordinals = new Int32Array(0);
      this.#fallback = Int32Array.from({ length: count }, (_, ordinal) => ordinal);
      return;
    }
    // Pass 1: each placement's cells, the reference's fallback rule and cap, and a count per cell.
    const coverages: (CellCoverage | undefined)[] = new Array(count);
    const counts: number[] = [];
    const fallback: number[] = [];
    let indexedEntryCount = 0;
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const coverage = objectCellCoverage(this.#objects[ordinal]!, this.#cellSize);
      if (coverage === undefined
        || coverage.count > ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT
        || coverage.count > ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES - indexedEntryCount) {
        fallback.push(ordinal);
        continue;
      }
      indexedEntryCount += coverage.count;
      coverages[ordinal] = coverage;
      for (let x = coverage.minX; x <= coverage.maxX; x++) {
        for (let y = coverage.minY; y <= coverage.maxY; y++) {
          const slot = this.#slotFor(x, y, true, counts.length)!;
          if (slot === counts.length) counts.push(0);
          counts[slot]!++;
          if (y === coverage.maxY) break;
        }
        if (x === coverage.maxX) break;
      }
    }
    // Pass 2: offsets, then the ordinals in source order (so each cell's run is ascending).
    const offsets = new Int32Array(counts.length + 1);
    for (let slot = 0; slot < counts.length; slot++) offsets[slot + 1] = offsets[slot]! + counts[slot]!;
    const ordinals = new Int32Array(indexedEntryCount);
    const cursor = offsets.slice(0, counts.length);
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const coverage = coverages[ordinal];
      if (coverage === undefined) continue;
      for (let x = coverage.minX; x <= coverage.maxX; x++) {
        for (let y = coverage.minY; y <= coverage.maxY; y++) {
          const slot = this.#slotFor(x, y, false, 0)!;
          ordinals[cursor[slot]!++] = ordinal;
          if (y === coverage.maxY) break;
        }
        if (x === coverage.maxX) break;
      }
    }
    this.#offsets = offsets;
    this.#ordinals = ordinals;
    this.#fallback = Int32Array.from(fallback);
  }

  /** The cell's slot; with `create`, an absent cell is given `next`. Undefined for an absent cell otherwise. */
  #slotFor(x: number, y: number, create: boolean, next: number): number | undefined {
    const key = packedKey(x, y);
    if (key !== undefined) {
      const slot = this.#slots.get(key);
      if (slot !== undefined || !create) return slot;
      this.#slots.set(key, next);
      return next;
    }
    const wide = `${x}/${y}`;
    const slot = this.#wideSlots.get(wide);
    if (slot !== undefined || !create) return slot;
    this.#wideSlots.set(wide, next);
    return next;
  }

  /** {@link EnvironmentSpatialIndex.query}: a conservative square candidate set in source order. */
  query(x: number, y: number, range: number): EnvironmentSpatialQuery {
    const cells = this.#queryCells(x, y, range);
    return cells ? this.#queryWithinCells(cells) : this.#failOpenQuery();
  }

  /** {@link EnvironmentSpatialIndex.queryCached}: the frozen pool, reused while the cell rectangle holds. */
  queryCached(x: number, y: number, range: number): CachedEnvironmentSpatialQuery {
    const cells = this.#queryCells(x, y, range);
    if (!cells) {
      this.#lastQuery = undefined;
      const result = this.#failOpenQuery();
      return Object.freeze({ ...result, objects: Object.freeze(result.objects) });
    }
    const previous = this.#lastQuery;
    if (previous && cells.minX === previous.cells.minX && cells.maxX === previous.cells.maxX
      && cells.minY === previous.cells.minY && cells.maxY === previous.cells.maxY) {
      return previous.result;
    }
    const query = this.#queryWithinCells(cells);
    const result = Object.freeze({ ...query, objects: Object.freeze(query.objects) });
    this.#lastQuery = { cells, result };
    return result;
  }

  #queryCells(x: number, y: number, range: number): CellCoverage | undefined {
    if (!validQuery(x, y, range) || !Number.isFinite(this.#cellSize)) return undefined;
    const minX = x - range;
    const maxX = x + range;
    const minY = y - range;
    const maxY = y + range;
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return undefined;
    const minCellX = cellIndex(minX, this.#cellSize);
    const maxCellX = cellIndex(maxX, this.#cellSize);
    const minCellY = cellIndex(minY, this.#cellSize);
    const maxCellY = cellIndex(maxY, this.#cellSize);
    if (!Number.isSafeInteger(minCellX) || !Number.isSafeInteger(maxCellX)
      || !Number.isSafeInteger(minCellY) || !Number.isSafeInteger(maxCellY)) return undefined;
    const xCount = maxCellX - minCellX + 1;
    const yCount = maxCellY - minCellY + 1;
    if (!Number.isSafeInteger(xCount) || !Number.isSafeInteger(yCount)
      || xCount <= 0 || yCount <= 0
      || xCount > MAX_QUERY_CELLS || yCount > MAX_QUERY_CELLS || xCount > MAX_QUERY_CELLS / yCount) {
      return undefined;
    }
    return { minX: minCellX, maxX: maxCellX, minY: minCellY, maxY: maxCellY, count: xCount * yCount };
  }

  #queryWithinCells({ minX, maxX, minY, maxY }: CellCoverage): EnvironmentSpatialQuery {
    if (++this.#stamp === 0xffffffff) {
      this.#seen.fill(0);
      this.#stamp = 1;
    }
    const stamp = this.#stamp;
    const seen = this.#seen;
    const hits = this.#hits;
    const ordinals = this.#ordinals;
    const offsets = this.#offsets;
    let found = 0;
    let visitedCells = 0;
    let visitedEntries = this.#fallback.length;
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellY = minY; cellY <= maxY; cellY++) {
        visitedCells++;
        const slot = this.#slotFor(cellX, cellY, false, 0);
        if (slot !== undefined) {
          const end = offsets[slot + 1]!;
          visitedEntries += end - offsets[slot]!;
          for (let at = offsets[slot]!; at < end; at++) {
            const ordinal = ordinals[at]!;
            if (seen[ordinal] !== stamp) {
              seen[ordinal] = stamp;
              hits[found++] = ordinal;
            }
          }
        }
        if (cellY === maxY) break;
      }
      if (cellX === maxX) break;
    }
    const fallback = this.#fallback;
    for (let index = 0; index < fallback.length; index++) {
      const ordinal = fallback[index]!;
      if (seen[ordinal] !== stamp) {
        seen[ordinal] = stamp;
        hits[found++] = ordinal;
      }
    }
    const ordered = hits.subarray(0, found).sort();
    const objects: EnvironmentObject[] = new Array(found);
    for (let index = 0; index < found; index++) objects[index] = this.#objects[ordered[index]!]!;
    return Object.freeze({ objects, visitedCells, visitedEntries });
  }

  #failOpenQuery(): EnvironmentSpatialQuery {
    return Object.freeze({
      objects: [...this.#objects],
      visitedCells: 0,
      visitedEntries: this.#objects.length,
    });
  }
}
