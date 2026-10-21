/**
 * 22.10 ARC-2 S2b: the main thread's caches the world renderer reads by key during `draw`, pushed as data
 * (`WorldRenderer3D.setRenderLookups`) instead of the lookup functions `draw` used to take — the game-object
 * display rows, the creature display rows (a mount's record, a display answered for the stand-in ledger) and the
 * collision models a building's own water is built from.
 *
 * Every lookup the renderer made was cache-only except the collision one, which also started the model's
 * download. That half stays on the main thread: the renderer lists the placement names it missed
 * (`collisionModelWants`) and the main thread asks for them right after `draw` (game/RenderLookupsBuilder.ts).
 *
 * Plain data: Maps of numbers or strings to plain records, no functions, nothing of three.js. In-process the two
 * display maps ARE the clients' live caches (no copy per frame); a worker slice must post a copy when their
 * revision moves (`gameObjectDisplayRevision`, `creatureDisplayRevision`) and the collision map when
 * `collisionRevision` moves — ideally only the groups' liquids, the one part the renderer reads.
 */

import type { GameObjectDisplayMetadata } from "./GameObjectMetadata.js";
import type { CreatureModelMetadata, UnitModel } from "./CreatureModelClient.js";
import type { CollisionModel } from "../world/CollisionFormat.js";
import { unit } from "../world/Fields.js";
import type { WorldObjectState } from "../world/WorldState.js";

export interface RenderLookups {
  /** GameObjectDisplayInfo rows by display id (`GameObjectMetadataClient`); absent without a client. */
  readonly gameObjectDisplays: ReadonlyMap<number, GameObjectDisplayMetadata> | undefined;
  /** That cache's monotonic revision; absent means fail-open (WorldRenderer3D `#refreshGameObjectAdmissionTrust`). */
  readonly gameObjectDisplayRevision: number | undefined;
  /** CreatureDisplayInfo records by display id (`CreatureModelClient`); absent without a client. */
  readonly creatureDisplays: ReadonlyMap<number, CreatureModelMetadata> | undefined;
  /** For a worker slice: moves whenever `creatureDisplays` may have changed. */
  readonly creatureDisplayRevision: number | undefined;
  /**
   * The collision models landed for this frame's WMO placements, by the placement's own name; absent while no
   * world's collision exists (the renderer then asks for none, as before).
   */
  readonly collisionModels: ReadonlyMap<string, CollisionModel> | undefined;
  /** For a worker slice: moves whenever `collisionModels` changed content. */
  readonly collisionRevision: number;
}

/** Nothing pushed (a benchmark harness, a test, between worlds): every lookup misses and nothing is asked for. */
export const NO_RENDER_LOOKUPS: RenderLookups = Object.freeze({
  gameObjectDisplays: undefined,
  gameObjectDisplayRevision: undefined,
  creatureDisplays: undefined,
  creatureDisplayRevision: undefined,
  collisionModels: undefined,
  collisionRevision: 0,
});

/** What a display cache answers with: a live client (`get`) or the pushed map. */
export interface DisplayRows {
  get(displayId: number): UnitModel | undefined;
}

/**
 * The model a unit is riding: UNIT_FIELD_MOUNTDISPLAYID's record, read-only (ui/Frames.ts `mountModelFor`, which
 * now answers through this, explains the field). Requests are owned by `ui/WorldView.ts`.
 */
export function mountDisplayModel(object: WorldObjectState, displays: DisplayRows | undefined): UnitModel | undefined {
  const displayId = unit.mountDisplayId(object) ?? 0;
  if (displayId <= 0 || !displays) return undefined;
  return displays.get(displayId);
}

/** Whether a display id has been answered (game/Loop.ts `loopCreatureDisplayAnswered`; diagnostics only). */
export function creatureDisplayAnswered(displayId: number, displays: DisplayRows | undefined): boolean {
  return displays?.get(displayId) !== undefined;
}
