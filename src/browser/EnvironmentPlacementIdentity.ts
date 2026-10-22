import type { EnvironmentObject } from "../gateway/VMapProtocol.js";

/**
 * 22.10 (7.34): whether two decoded placements describe the same thing. A placement that spans
 * tiles is listed in each of them under one id with equal fields — Stormwind's city WMO in 16 —
 * and `EnvironmentClient.objectsAround` keeps the object it already handed out while an equal copy
 * stays in range. Fields are plain values, except the tint and light quadruples and the bounds
 * record, which are compared one level deep.
 */
export function sameEnvironmentPlacement(left: EnvironmentObject, right: EnvironmentObject): boolean {
  if (left === right) return true;
  const keys = Object.keys(left) as (keyof EnvironmentObject)[];
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    const a: unknown = left[key];
    const b: unknown = right[key];
    if (a === b) continue;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    const inner = Object.keys(a);
    if (inner.length !== Object.keys(b).length) return false;
    for (const name of inner) {
      if ((a as Record<string, unknown>)[name] !== (b as Record<string, unknown>)[name]) return false;
    }
  }
  return true;
}
