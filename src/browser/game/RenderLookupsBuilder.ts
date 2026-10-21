/**
 * 22.10 ARC-2 S2b: the main thread's half of RenderLookups.ts, built right before `draw` from the page's clients:
 *
 * * the game-object and creature display rows: the clients' own caches, handed over as they are — every lookup
 *   the renderer made into them (`loopGameObjectDisplay`, `loopCreatureDisplayAnswered`, `mountModel`) was a
 *   plain `get`, so the map answers every key exactly as the function did, and nothing is asked for;
 * * the collision models: for every WMO placement in the environment list `draw` is handed (the renderer's
 *   environment admission only ever picks from that list), what `CollisionClient.model` would answer now, read
 *   with `peek` so nothing is downloaded. The names the renderer then misses come back through
 *   `WorldRenderer3D.collisionModelWants()` and are asked for with `model` right after `draw`
 *   (`requestCollisionModels`), in the same frame and order the renderer used to ask in during `draw`.
 *
 * The record and its collision map are refilled in place; nothing reads them between frames.
 */

import type { CollisionModel } from "../../world/CollisionFormat.js";
import type { RenderLookups } from "../RenderLookups.js";
import type { EnvironmentObject } from "../Terrain.js";
import type { CreatureModelMetadata } from "../CreatureModelClient.js";
import type { GameObjectDisplayMetadata } from "../GameObjectMetadata.js";

/**
 * The archive path a visual placement carries, reduced to the file the collision route serves.
 *
 * Case is not this function's business any more. The extractor writes `Stormwind.wmo.vmo` and the
 * placement says `STORMWIND.WMO`; `CollisionClient.model` folds the second onto the first — the
 * spelling the `.vmtile` uses, which is the file's own — so the renderer's water probe and the
 * collision source share one download of the city rather than making two, and the probe no longer
 * depends on the gateway's disk ignoring case. (22.10 ARC-2 S2b: moved from app/EnterWorld.ts.)
 */
export function collisionModelName(name: string): string {
  const cut = Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/"));
  return cut >= 0 ? name.slice(cut + 1) : name;
}

/** The collision client's two doors: a read that asks for nothing, and the ask itself. */
export interface CollisionModelSource {
  peek(name: string): CollisionModel | undefined;
  model(name: string): CollisionModel | undefined;
}

/** What one frame's lookups are built from. */
export interface RenderLookupSources {
  /** `game.gameObjectMetadata`. */
  readonly gameObjectMetadata: { readonly displays: ReadonlyMap<number, GameObjectDisplayMetadata>; readonly revision: number } | undefined;
  /** `game.creatureModels`. */
  readonly creatureModels: { readonly displays: ReadonlyMap<number, CreatureModelMetadata>; readonly revision: number } | undefined;
  /** `game.collision?.models` — the client the renderer's water probe asked (was `setCollisionModels`). */
  readonly collision: CollisionModelSource | undefined;
  /** The environment list `draw` is handed this frame. */
  readonly environment: readonly EnvironmentObject[];
}

export class RenderLookupsBuilder {
  readonly #lookups: { -readonly [K in keyof RenderLookups]: RenderLookups[K] };
  readonly #collisionModels = new Map<string, CollisionModel>();
  #collisionSource: CollisionModelSource | undefined;
  #namesOf: readonly EnvironmentObject[] | undefined;
  /** Placement name and the collision route's name for it, once per WMO model in the list. */
  #names: { readonly placement: string; readonly collision: string }[] = [];

  constructor() {
    this.#lookups = {
      gameObjectDisplays: undefined,
      gameObjectDisplayRevision: undefined,
      creatureDisplays: undefined,
      creatureDisplayRevision: undefined,
      collisionModels: undefined,
      collisionRevision: 0,
    };
  }

  build(sources: RenderLookupSources): RenderLookups {
    const lookups = this.#lookups;
    lookups.gameObjectDisplays = sources.gameObjectMetadata?.displays;
    lookups.gameObjectDisplayRevision = sources.gameObjectMetadata?.revision;
    lookups.creatureDisplays = sources.creatureModels?.displays;
    lookups.creatureDisplayRevision = sources.creatureModels?.revision;
    lookups.collisionModels = this.#fillCollision(sources.collision, sources.environment);
    return lookups;
  }

  /**
   * The misses `draw` reported (`WorldRenderer3D.collisionModelWants`), asked for as the renderer asked: by the
   * collision route's name, starting the download (or its retry) on the client's own queue.
   */
  requestCollisionModels(collision: CollisionModelSource | undefined, wants: Iterable<string>): void {
    if (!collision) return;
    for (const name of wants) collision.model(collisionModelName(name));
  }

  #fillCollision(collision: CollisionModelSource | undefined, environment: readonly EnvironmentObject[]): ReadonlyMap<string, CollisionModel> | undefined {
    const models = this.#collisionModels;
    if (collision !== this.#collisionSource) {
      this.#collisionSource = collision;
      if (models.size > 0) {
        models.clear();
        this.#lookups.collisionRevision++;
      }
    }
    if (!collision) return undefined;
    if (environment !== this.#namesOf) this.#collectNames(environment);
    // Every frame and not on a revision: a vmap tile naming the file (`preferSpelling`) can change the answer
    // without the client's revision moving. A map lookup or two per WMO model in the list.
    for (const { placement, collision: name } of this.#names) {
      const model = collision.peek(name);
      if (model === models.get(placement)) continue;
      if (model) models.set(placement, model);
      else models.delete(placement);
      this.#lookups.collisionRevision++;
    }
    return models;
  }

  #collectNames(environment: readonly EnvironmentObject[]): void {
    this.#namesOf = environment;
    const seen = new Set<string>();
    const names: { placement: string; collision: string }[] = [];
    for (const object of environment) {
      if (object.kind !== "wmo" || seen.has(object.name)) continue;
      seen.add(object.name);
      names.push({ placement: object.name, collision: collisionModelName(object.name) });
    }
    this.#names = names;
    const models = this.#collisionModels;
    for (const placement of models.keys()) {
      if (seen.has(placement)) continue;
      models.delete(placement);
      this.#lookups.collisionRevision++;
    }
  }
}
