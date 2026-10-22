/**
 * 22.10 ARC-2 S5: a Map sent as differences — the entries whose value is another object (or another number) than the
 * one sent last, and the keys gone. The receiving side keeps one Map whose identity never changes and whose unchanged
 * values keep theirs, so a renderer cache keyed on a record (a unit's model, a display row) sees a change only where
 * the main thread made one.
 */

import { sameNumber } from "./FrameInput.js";

export interface MapDelta<K, V> {
  /** No source Map: the receiver answers `undefined`. */
  readonly absent: boolean;
  /** The source is another Map than last time: the receiver empties its own first. */
  readonly reset: boolean;
  readonly set: ReadonlyArray<readonly [K, V]>;
  readonly deleted: readonly K[];
}

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" ? sameNumber(a, b) : a === b;
}

export class MapDeltaSender<K, V> {
  readonly #sent = new Map<K, V>();
  #source: ReadonlyMap<K, V> | undefined;
  #started = false;

  /** The difference since the last call; `undefined` when there is none. */
  delta(source: ReadonlyMap<K, V> | undefined): MapDelta<K, V> | undefined {
    const sent = this.#sent;
    if (source === undefined) {
      if (this.#started && this.#source === undefined) return undefined;
      this.#started = true;
      this.#source = undefined;
      sent.clear();
      return { absent: true, reset: true, set: [], deleted: [] };
    }
    const reset = !this.#started || source !== this.#source;
    this.#started = true;
    this.#source = source;
    if (reset) sent.clear();
    let set: Array<readonly [K, V]> | undefined;
    for (const [key, value] of source) {
      const old = sent.get(key);
      if (old !== undefined || sent.has(key)) {
        if (sameValue(old, value)) continue;
      }
      sent.set(key, value);
      (set ??= []).push([key, value]);
    }
    let deleted: K[] | undefined;
    if (sent.size !== source.size) {
      for (const key of sent.keys()) {
        if (source.has(key)) continue;
        sent.delete(key);
        (deleted ??= []).push(key);
      }
    }
    if (!reset && set === undefined && deleted === undefined) return undefined;
    return { absent: false, reset, set: set ?? [], deleted: deleted ?? [] };
  }
}

export class MapDeltaReceiver<K, V> {
  readonly map = new Map<K, V>();
  #absent = true;

  /** `receive`: what a value becomes on this side (a main-clock time made the renderer's); the value itself by default. */
  constructor(readonly receive: (value: V) => V = (value) => value) {}

  /** Applies one delta (`undefined`: nothing changed) and answers the Map, or `undefined` while there is no source. */
  apply(delta: MapDelta<K, V> | undefined): ReadonlyMap<K, V> | undefined {
    if (delta !== undefined) {
      const map = this.map;
      if (delta.reset) map.clear();
      this.#absent = delta.absent;
      for (const [key, value] of delta.set) map.set(key, this.receive(value));
      for (const key of delta.deleted) map.delete(key);
    }
    return this.#absent ? undefined : this.map;
  }
}
