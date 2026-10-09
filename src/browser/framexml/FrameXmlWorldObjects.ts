import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * seam-sweep: the object table of a world the stock-UI models read, or a shared empty one when the world
 * carries none. `WorldClient` always has `state.objects`; a sparse fake world (`state: { selfGuid }`, as the
 * live-seam tests build) does not, and LiveWorldSeam has always read such a world as holding no objects
 * (`typeof world.state.objects?.get === "function"`). The possess, vehicle and vehicle-aim models follow
 * the same rule through this one helper: no possession, no seat, no aimer. No allocation per call.
 */
export const NO_WORLD_OBJECTS: ReadonlyMap<bigint, WorldObjectState> = Object.freeze(new Map<bigint, WorldObjectState>());

/** `world.state.objects` when it is a table, else `NO_WORLD_OBJECTS`. */
export function frameXmlWorldObjects<Objects extends { get(guid: bigint): WorldObjectState | undefined }>(
  world: { readonly state?: { readonly objects?: Objects | undefined } | undefined } | undefined,
): Objects | ReadonlyMap<bigint, WorldObjectState> {
  const objects = world?.state?.objects;
  return typeof objects?.get === "function" ? objects : NO_WORLD_OBJECTS;
}
