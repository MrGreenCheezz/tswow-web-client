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
 * * 22.10 ARC-2 S2c: the unit models: for every unit, player and corpse the renderer's unit admission could pick
 *   (`WorldRenderer3D.#updateUnits` before its range, pin, frustum and budget tests — the main thread cannot run
 *   those, and the read-only answer costs nothing on the wire), the read-only answer (ui/Frames.ts
 *   `unitModelPeek`). The guids `draw` then admitted come back through `WorldRenderer3D.unitModelWants()` and get
 *   the asking path (`unitModel`) right after `draw`, in the renderer's order (`requestUnitModels`).
 *
 * The record and its maps are refilled in place; nothing reads them between frames.
 */

import type { CollisionModel } from "../../world/CollisionFormat.js";
import type { RenderLookups } from "../RenderLookups.js";
import type { EnvironmentObject } from "../Terrain.js";
import type { CreatureModelMetadata } from "../CreatureModelClient.js";
import type { GameObjectDisplayMetadata } from "../GameObjectMetadata.js";
import type { UnitModel } from "../CreatureModelClient.js";
import { corpseUnitView } from "../CorpseModel.js";
import { fieldsVersion } from "../../world/FieldsVersion.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/** 22.10 ARC-2 S2c: the units drawn this frame and the read-only answer for one of them. */
export interface UnitModelSource {
  /** The state `draw` is handed (its `objects`). */
  readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  /** ui/Frames.ts `unitModelPeek` over the live clients (a replay's or bench's own answer otherwise). */
  readonly peek: (object: WorldObjectState) => UnitModel | undefined;
  /**
   * Every client identity and revision `peek` reads — creature records and looks, NPC weapons, item rows, mirror
   * replies. A change in any recomputes every unit; otherwise a unit is recomputed only when its fields are written
   * (world/FieldsVersion.ts) or it is `volatile`.
   */
  readonly inputs: readonly unknown[];
  /** Whether a unit's answer can change with time alone — a mirror image's wait — so it is recomputed every frame. */
  readonly volatile?: ((object: WorldObjectState) => boolean) | undefined;
}

/** One unit's cached answer and what it was computed from (RenderLookupsBuilder `#fillUnits`). */
interface UnitEntry {
  readonly candidate: WorldObjectState;
  fields: ReadonlyMap<number, number>;
  version: number;
  epoch: number;
  volatile: boolean;
  model: UnitModel | undefined;
  stamp: number;
}

/**
 * The object the renderer's unit pass draws for a world object — a corpse as its body view (CorpseModel.ts), a
 * unit or player as itself — or undefined for anything it never asks a model for (WorldRenderer3D `#updateUnits`).
 */
export function unitPassObject(candidate: WorldObjectState): WorldObjectState | undefined {
  const object = candidate.typeId === 7 ? corpseUnitView(candidate) : candidate;
  if (object === undefined || (object.typeId !== 3 && object.typeId !== 4 && object.typeId !== 7) || !object.position) return undefined;
  return object;
}

/** Element-wise identity of two input lists (22.10 ARC-2 S2c). */
function sameInputs(previous: readonly unknown[], next: readonly unknown[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index++) if (!Object.is(previous[index], next[index])) return false;
  return true;
}

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
  /** 22.10 ARC-2 S2c: the units to answer; absent, the renderer gets no unit models (none drawn but capsules). */
  readonly units?: UnitModelSource | undefined;
}

export class RenderLookupsBuilder {
  readonly #lookups: { -readonly [K in keyof RenderLookups]: RenderLookups[K] };
  readonly #collisionModels = new Map<string, CollisionModel>();
  #collisionSource: CollisionModelSource | undefined;
  #namesOf: readonly EnvironmentObject[] | undefined;
  /** Placement name and the collision route's name for it, once per WMO model in the list. */
  #names: { readonly placement: string; readonly collision: string }[] = [];
  readonly #unitModels = new Map<bigint, UnitModel>();
  /** 22.10 ARC-2 S2c: the cached answers, by world object (the lookup) and by guid (the sweep of departed units). */
  #unitEntries = new WeakMap<WorldObjectState, UnitEntry>();
  readonly #unitsByGuid = new Map<bigint, UnitEntry>();
  #unitInputs: readonly unknown[] = [];
  #unitEpoch = 0;
  #unitStamp = 0;
  /** How many answers `peek` was asked for since the builder was made (tests count the steady state's zero). */
  unitRecomputations = 0;

  constructor() {
    this.#lookups = {
      gameObjectDisplays: undefined,
      gameObjectDisplayRevision: undefined,
      creatureDisplays: undefined,
      creatureDisplayRevision: undefined,
      collisionModels: undefined,
      collisionRevision: 0,
      unitModels: undefined,
    };
  }

  build(sources: RenderLookupSources): RenderLookups {
    const lookups = this.#lookups;
    lookups.gameObjectDisplays = sources.gameObjectMetadata?.displays;
    lookups.gameObjectDisplayRevision = sources.gameObjectMetadata?.revision;
    lookups.creatureDisplays = sources.creatureModels?.displays;
    lookups.creatureDisplayRevision = sources.creatureModels?.revision;
    lookups.collisionModels = this.#fillCollision(sources.collision, sources.environment);
    lookups.unitModels = this.#fillUnits(sources.units);
    return lookups;
  }

  /**
   * 22.10 ARC-2 S2c: the asking path for the guids `draw` admitted (`WorldRenderer3D.unitModelWants`), in its order —
   * item loads, looks, mirror-image questions and weapon requests start here, in the frame they always started in.
   */
  requestUnitModels(objects: ReadonlyMap<bigint, WorldObjectState> | undefined, wants: Iterable<bigint>,
    unitModel: (object: WorldObjectState) => unknown): void {
    if (!objects) return;
    for (const guid of wants) {
      const candidate = objects.get(guid);
      const object = candidate === undefined ? undefined : unitPassObject(candidate);
      if (object !== undefined) unitModel(object);
    }
  }

  /**
   * 22.10 ARC-2 S2c: the table, refilled by change. An entry is recomputed when its object is new, its fields were
   * written, a client it reads moved, or it is volatile; an unchanged entry keeps the same answer object and costs
   * a WeakMap read and three compares. Units that left the state (or stopped being drawable) leave the table.
   */
  #fillUnits(units: UnitModelSource | undefined): ReadonlyMap<bigint, UnitModel> | undefined {
    const models = this.#unitModels;
    if (!units) {
      if (this.#unitsByGuid.size > 0) this.#dropUnits();
      return undefined;
    }
    if (!sameInputs(this.#unitInputs, units.inputs)) {
      this.#unitInputs = units.inputs.slice();
      this.#unitEpoch++;
    }
    const epoch = this.#unitEpoch;
    const stamp = ++this.#unitStamp;
    let visited = 0;
    for (const candidate of units.objects.values()) {
      const object = unitPassObject(candidate);
      if (object === undefined) continue;
      // A corpse's look is read off the corpse (CorpseModel `owners`), so its fields are the key.
      const fields = candidate.fields;
      const version = fieldsVersion(fields);
      let entry = this.#unitEntries.get(candidate);
      if (entry === undefined) {
        entry = { candidate, fields, version: -1, epoch: -1, volatile: true, model: undefined, stamp };
        this.#unitEntries.set(candidate, entry);
        // Another object under the same guid (a re-created unit) gives up the slot; its answer is replaced below.
        const previous = this.#unitsByGuid.get(candidate.guid);
        if (previous !== undefined) this.#unitEntries.delete(previous.candidate);
        this.#unitsByGuid.set(candidate.guid, entry);
        models.delete(candidate.guid);
      }
      entry.stamp = stamp;
      visited++;
      if (!entry.volatile && entry.epoch === epoch && entry.fields === fields && entry.version === version) continue;
      entry.fields = fields;
      entry.version = version;
      entry.epoch = epoch;
      entry.volatile = units.volatile?.(object) ?? false;
      this.unitRecomputations++;
      const model = units.peek(object);
      if (model === entry.model) continue;
      entry.model = model;
      if (model === undefined) models.delete(candidate.guid);
      else models.set(candidate.guid, model);
    }
    if (visited !== this.#unitsByGuid.size) {
      for (const [guid, entry] of this.#unitsByGuid) {
        if (entry.stamp === stamp) continue;
        this.#unitsByGuid.delete(guid);
        this.#unitEntries.delete(entry.candidate);
        models.delete(guid);
      }
    }
    return models;
  }

  #dropUnits(): void {
    this.#unitsByGuid.clear();
    this.#unitEntries = new WeakMap();
    this.#unitModels.clear();
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
