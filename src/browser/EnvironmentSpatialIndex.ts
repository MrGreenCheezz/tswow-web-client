import type { EnvironmentObject } from "../gateway/VMapProtocol.js";

/** World-space width of one resident environment index cell. */
export const ENVIRONMENT_SPATIAL_CELL_SIZE = 128;
/** A placement with a wider footprint stays in the conservative fallback list. */
export const ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT = 256;
/** Global cap for replicated object references held by one immutable index. */
export const ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES = 262_144;
/** A finite but impractically broad query is handled by the same conservative path as bad input. */
const ENVIRONMENT_SPATIAL_MAX_QUERY_CELLS = 4_096;

export interface EnvironmentSpatialQuery {
  readonly objects: EnvironmentObject[];
  /** Number of grid coordinates checked, including coordinates without an index bucket. */
  readonly visitedCells: number;
  /** Number of index entries inspected, including repeated entries for spanning bounds. */
  readonly visitedEntries: number;
}

export interface CachedEnvironmentSpatialQuery {
  readonly objects: readonly EnvironmentObject[];
  readonly visitedCells: number;
  readonly visitedEntries: number;
}

interface IndexedEntry {
  readonly object: EnvironmentObject;
  readonly ordinal: number;
}

interface CellCoverage {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly count: number;
}

/**
 * Immutable, wire-only spatial index for one environment object array.
 *
 * The index is deliberately conservative: it only narrows the candidate stream. The renderer
 * still owns the exact distance/range decision, so the square query may return objects outside the
 * circle and never needs model, metadata or transport lookups.
 *
 * Precondition: source object coordinates and bounds remain immutable for this index's lifetime.
 * `WorldRenderer3D` enforces that precondition by rebuilding on each new EnvironmentClient snapshot
 * identity/generation rather than mutating an existing index.
 */
export class EnvironmentSpatialIndex {
  readonly #objects: readonly EnvironmentObject[];
  readonly #cells: ReadonlyMap<string, readonly IndexedEntry[]>;
  readonly #fallback: readonly IndexedEntry[];
  readonly #cellSize: number;
  /** One raw pool per immutable index, replaced as soon as the query's cell rectangle changes. */
  #lastQuery: { cells: CellCoverage; result: CachedEnvironmentSpatialQuery } | undefined;

  constructor(
    objects: readonly EnvironmentObject[],
    cellSize = ENVIRONMENT_SPATIAL_CELL_SIZE,
  ) {
    this.#objects = Object.freeze([...objects]);
    this.#cellSize = validCellSize(cellSize) ? cellSize : Number.NaN;

    const entries = this.#objects.map((object, ordinal) => Object.freeze({ object, ordinal }));
    if (!Number.isFinite(this.#cellSize)) {
      this.#cells = new Map();
      this.#fallback = Object.freeze(entries);
      return;
    }

    const cellsByKey = new Map<string, IndexedEntry[]>();
    const fallback: IndexedEntry[] = [];
    let indexedEntryCount = 0;
    for (const entry of entries) {
      const coverage = objectCellCoverage(entry.object, this.#cellSize);
      if (coverage === undefined
        || coverage.count > ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT
        || coverage.count > ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES - indexedEntryCount) {
        fallback.push(entry);
        continue;
      }
      indexedEntryCount += coverage.count;
      for (let x = coverage.minX; x <= coverage.maxX; x++) {
        for (let y = coverage.minY; y <= coverage.maxY; y++) {
          const key = cellKey(x, y);
          let entriesInCell = cellsByKey.get(key);
          if (!entriesInCell) {
            entriesInCell = [];
            cellsByKey.set(key, entriesInCell);
          }
          entriesInCell.push(entry);
          if (y === coverage.maxY) break;
        }
        if (x === coverage.maxX) break;
      }
    }

    // The map is private and never mutated after this point. Frozen bucket arrays prevent accidental
    // edits even if this implementation is refactored to expose diagnostics later.
    this.#cells = new Map([...cellsByKey].map(([key, entriesInCell]) => [
      key, Object.freeze([...entriesInCell]),
    ]));
    this.#fallback = Object.freeze(fallback);
  }

  /**
   * Returns a conservative square candidate set in original source order.
   *
   * A bad query (including arithmetic overflow while forming its square) deliberately returns
   * every source object. Fallback entries are checked on every valid query as well, rather than
   * being silently lost because they have no safe cell.
   */
  query(x: number, y: number, range: number): EnvironmentSpatialQuery {
    const cells = this.#queryCells(x, y, range);
    return cells ? this.#queryWithinCells(cells) : this.#failOpenQuery();
  }

  /**
   * Reuse the raw pool while its exact cell rectangle is unchanged. Distances and visibility
   * remain the caller's current-frame decisions. Unlike query(), this opt-in result is immutable.
   */
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
    if (!validQuery(x, y, range) || !Number.isFinite(this.#cellSize)) {
      return undefined;
    }
    const minX = x - range;
    const maxX = x + range;
    const minY = y - range;
    const maxY = y + range;
    if (![minX, maxX, minY, maxY].every(Number.isFinite)) return undefined;

    const minCellX = cellIndex(minX, this.#cellSize);
    const maxCellX = cellIndex(maxX, this.#cellSize);
    const minCellY = cellIndex(minY, this.#cellSize);
    const maxCellY = cellIndex(maxY, this.#cellSize);
    if (![minCellX, maxCellX, minCellY, maxCellY].every(Number.isSafeInteger)) {
      return undefined;
    }
    const xCount = maxCellX - minCellX + 1;
    const yCount = maxCellY - minCellY + 1;
    if (!Number.isSafeInteger(xCount) || !Number.isSafeInteger(yCount)
      || xCount <= 0 || yCount <= 0
      || xCount > ENVIRONMENT_SPATIAL_MAX_QUERY_CELLS
      || yCount > ENVIRONMENT_SPATIAL_MAX_QUERY_CELLS
      || xCount > ENVIRONMENT_SPATIAL_MAX_QUERY_CELLS / yCount) {
      return undefined;
    }
    return { minX: minCellX, maxX: maxCellX, minY: minCellY, maxY: maxCellY, count: xCount * yCount };
  }

  #queryWithinCells({ minX, maxX, minY, maxY }: CellCoverage): EnvironmentSpatialQuery {
    const selected = new Set<IndexedEntry>();
    let visitedCells = 0;
    let visitedEntries = this.#fallback.length;
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellY = minY; cellY <= maxY; cellY++) {
        visitedCells++;
        const entriesInCell = this.#cells.get(cellKey(cellX, cellY));
        if (entriesInCell) {
          visitedEntries += entriesInCell.length;
          for (const entry of entriesInCell) selected.add(entry);
        }
        if (cellY === maxY) break;
      }
      if (cellX === maxX) break;
    }
    for (const entry of this.#fallback) selected.add(entry);

    const ordered = [...selected].sort((left, right) => left.ordinal - right.ordinal);
    return Object.freeze({
      objects: ordered.map(({ object }) => object),
      visitedCells,
      visitedEntries,
    });
  }

  #failOpenQuery(): EnvironmentSpatialQuery {
    return Object.freeze({
      objects: [...this.#objects],
      visitedCells: 0,
      visitedEntries: this.#objects.length,
    });
  }
}

function validCellSize(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validQuery(x: number, y: number, range: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(range) && range >= 0;
}

function cellIndex(value: number, cellSize: number): number {
  const index = Math.floor(value / cellSize);
  return Number.isSafeInteger(index) ? index : Number.NaN;
}

function cellKey(x: number, y: number): string {
  return `${x}/${y}`;
}

function objectCellCoverage(object: EnvironmentObject, cellSize: number): CellCoverage | undefined {
  if (!object || typeof object !== "object" || !Number.isFinite(object.x) || !Number.isFinite(object.y)) {
    return undefined;
  }
  if (object.bounds === undefined) {
    const x = cellIndex(object.x, cellSize);
    const y = cellIndex(object.y, cellSize);
    return Number.isFinite(x) && Number.isFinite(y)
      ? { minX: x, maxX: x, minY: y, maxY: y, count: 1 }
      : undefined;
  }
  const bounds = object.bounds;
  if (!orderedFiniteBounds(bounds)) return undefined;
  const minCellX = cellIndex(bounds.minX, cellSize);
  const maxCellX = cellIndex(bounds.maxX, cellSize);
  const minCellY = cellIndex(bounds.minY, cellSize);
  const maxCellY = cellIndex(bounds.maxY, cellSize);
  if (![minCellX, maxCellX, minCellY, maxCellY].every(Number.isFinite)) return undefined;
  const xCount = maxCellX - minCellX + 1;
  const yCount = maxCellY - minCellY + 1;
  if (!Number.isSafeInteger(xCount) || !Number.isSafeInteger(yCount) || xCount <= 0 || yCount <= 0) {
    return undefined;
  }
  if (xCount > ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT
    || yCount > ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT
    || xCount > ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT / yCount) {
    return undefined;
  }
  return { minX: minCellX, maxX: maxCellX, minY: minCellY, maxY: maxCellY, count: xCount * yCount };
}

function orderedFiniteBounds(value: unknown): value is {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Record<string, unknown>;
  const values = [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  const minX = bounds.minX as number;
  const minY = bounds.minY as number;
  const minZ = bounds.minZ as number;
  const maxX = bounds.maxX as number;
  const maxY = bounds.maxY as number;
  const maxZ = bounds.maxZ as number;
  return minX <= maxX && minY <= maxY && minZ <= maxZ;
}
