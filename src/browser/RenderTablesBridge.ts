/**
 * 22.10 ARC-2 S5: the pushed renderer records (RenderInputs.ts, RenderLookups.ts) as messages — what crosses each
 * frame, and what crosses only when it changed.
 *
 * Small per-frame parts go whole every frame (the hidden portals, the status tick, the probe flag). The big tables go
 * as Map differences (MapDelta.ts): the unit models and the facing's casts, spell words and movement ids every frame
 * (their Maps are refilled or written in place, with no revision on the record), the display rows and collision models
 * only when their revision moves. Records the main thread replaces whole (the enchant tables, the vehicle rows, the
 * switch and generation pushes) go when they are another object. The receiving side keeps one record per kind with
 * stable inner identities, so the renderer's identity checks (`#vehicles`, the glow memo) see what they saw in-process.
 */

import type { EnchantGlowTables } from "./ItemEnchantments.js";
import type { GameObjectDisplayMetadata } from "./GameObjectMetadata.js";
import type { CreatureModelMetadata, UnitModel } from "./CreatureModelClient.js";
import type { CollisionModel } from "../world/CollisionFormat.js";
import type { FacingCast, UnitFacingInputs } from "../world/UnitFacing.js";
import type { VehicleCatalogRows } from "../world/VehicleDbc.js";
import type { RenderSwitchesPush } from "./RenderSwitches.js";
import type { GatewayGenerationPush } from "./GatewayGeneration.js";
import type { RenderInputs } from "./RenderInputs.js";
import type { RenderLookups } from "./RenderLookups.js";
import { MapDeltaReceiver, MapDeltaSender, type MapDelta } from "./MapDelta.js";
import { toRenderTime } from "./RenderClock.js";

/** An object sent only when it is another one than last time (`changed`). */
interface Replaced<T> {
  readonly changed: boolean;
  readonly value?: T;
}

class ReplacedSender<T> {
  #started = false;
  #last: T | undefined;

  send(value: T): Replaced<T> {
    if (this.#started && value === this.#last) return UNCHANGED;
    this.#started = true;
    this.#last = value;
    return { changed: true, value };
  }
}

const UNCHANGED: Replaced<never> = Object.freeze({ changed: false });

class ReplacedReceiver<T> {
  constructor(public value: T) {}

  apply(message: Replaced<T>): T {
    if (message.changed) this.value = message.value as T;
    return this.value;
  }
}

export interface RenderInputsMessage {
  readonly enchantGlow: Replaced<EnchantGlowTables | undefined>;
  readonly hiddenGameObjects: readonly bigint[];
  readonly casts: MapDelta<bigint, FacingCast> | undefined;
  readonly interactionNpc: bigint | undefined;
  readonly movementIds: MapDelta<number, number> | undefined;
  readonly spellAttributes: MapDelta<number, readonly number[]> | undefined;
  readonly vehicles: Replaced<VehicleCatalogRows | undefined>;
  readonly publishStatus: boolean;
  readonly switches: Replaced<RenderSwitchesPush | undefined>;
  readonly gatewayGeneration: Replaced<GatewayGenerationPush | undefined>;
  readonly frameBudgetProbe: boolean;
}

export class RenderInputsSender {
  readonly #enchantGlow = new ReplacedSender<EnchantGlowTables | undefined>();
  readonly #casts = new MapDeltaSender<bigint, FacingCast>();
  readonly #movementIds = new MapDeltaSender<number, number>();
  readonly #spellAttributes = new MapDeltaSender<number, readonly number[]>();
  readonly #vehicles = new ReplacedSender<VehicleCatalogRows | undefined>();
  readonly #switches = new ReplacedSender<RenderSwitchesPush | undefined>();
  readonly #generation = new ReplacedSender<GatewayGenerationPush | undefined>();

  encode(inputs: RenderInputs): RenderInputsMessage {
    return {
      enchantGlow: this.#enchantGlow.send(inputs.enchantGlow),
      hiddenGameObjects: [...inputs.hiddenGameObjects],
      casts: this.#casts.delta(inputs.facing.casts),
      interactionNpc: inputs.facing.interactionNpc,
      movementIds: this.#movementIds.delta(inputs.facing.movementIds),
      spellAttributes: this.#spellAttributes.delta(inputs.facing.spellAttributes),
      vehicles: this.#vehicles.send(inputs.vehicles),
      publishStatus: inputs.publishStatus,
      switches: this.#switches.send(inputs.switches),
      gatewayGeneration: this.#generation.send(inputs.gatewayGeneration),
      frameBudgetProbe: inputs.frameBudgetProbe,
    };
  }
}

export class RenderInputsReceiver {
  readonly #enchantGlow = new ReplacedReceiver<EnchantGlowTables | undefined>(undefined);
  readonly #hidden = new Set<bigint>();
  // A cast's start is a main-clock moment: onto the renderer's (RenderClock.ts), a new record only off the page.
  readonly #casts = new MapDeltaReceiver<bigint, FacingCast>((cast) => {
    const startedAt = toRenderTime(cast.startedAt);
    return startedAt === cast.startedAt ? cast : { ...cast, startedAt };
  });
  readonly #movementIds = new MapDeltaReceiver<number, number>();
  readonly #spellAttributes = new MapDeltaReceiver<number, readonly number[]>();
  readonly #vehicles = new ReplacedReceiver<VehicleCatalogRows | undefined>(undefined);
  readonly #switches = new ReplacedReceiver<RenderSwitchesPush | undefined>(undefined);
  readonly #generation = new ReplacedReceiver<GatewayGenerationPush | undefined>(undefined);
  readonly #facing: { -readonly [K in keyof UnitFacingInputs]: UnitFacingInputs[K] } = {
    casts: this.#casts.map, interactionNpc: undefined, movementIds: this.#movementIds.map,
    spellAttributes: this.#spellAttributes.map,
  };
  readonly #inputs: { -readonly [K in keyof RenderInputs]: RenderInputs[K] } = {
    enchantGlow: undefined, hiddenGameObjects: this.#hidden, facing: this.#facing, vehicles: undefined,
    publishStatus: false, switches: undefined, gatewayGeneration: undefined, frameBudgetProbe: false,
  };

  /** The renderer's record: one object, refreshed in place each frame, as the main thread's builder does. */
  apply(message: RenderInputsMessage): RenderInputs {
    const inputs = this.#inputs;
    inputs.enchantGlow = this.#enchantGlow.apply(message.enchantGlow);
    this.#hidden.clear();
    for (const guid of message.hiddenGameObjects) this.#hidden.add(guid);
    const facing = this.#facing;
    facing.casts = this.#casts.apply(message.casts) ?? this.#casts.map;
    facing.interactionNpc = message.interactionNpc;
    facing.movementIds = this.#movementIds.apply(message.movementIds) ?? this.#movementIds.map;
    facing.spellAttributes = this.#spellAttributes.apply(message.spellAttributes) ?? this.#spellAttributes.map;
    inputs.vehicles = this.#vehicles.apply(message.vehicles);
    inputs.publishStatus = message.publishStatus;
    inputs.switches = this.#switches.apply(message.switches);
    inputs.gatewayGeneration = this.#generation.apply(message.gatewayGeneration);
    inputs.frameBudgetProbe = message.frameBudgetProbe;
    return inputs;
  }
}

export interface RenderLookupsMessage {
  readonly gameObjectDisplays: MapDelta<number, GameObjectDisplayMetadata> | undefined;
  readonly gameObjectDisplayRevision: number | undefined;
  readonly creatureDisplays: MapDelta<number, CreatureModelMetadata> | undefined;
  readonly creatureDisplayRevision: number | undefined;
  readonly collisionModels: MapDelta<string, CollisionModel> | undefined;
  readonly collisionRevision: number;
  readonly unitModels: MapDelta<bigint, UnitModel> | undefined;
}

/** A table diffed only when its Map or its revision is another than last time. */
class RevisedSender<K, V> {
  readonly #sender = new MapDeltaSender<K, V>();
  #started = false;
  #map: ReadonlyMap<K, V> | undefined;
  #revision: number | undefined;

  delta(map: ReadonlyMap<K, V> | undefined, revision: number | undefined): MapDelta<K, V> | undefined {
    if (this.#started && map === this.#map && revision === this.#revision && revision !== undefined) return undefined;
    this.#started = true;
    this.#map = map;
    this.#revision = revision;
    return this.#sender.delta(map);
  }
}

export class RenderLookupsSender {
  readonly #gameObjectDisplays = new RevisedSender<number, GameObjectDisplayMetadata>();
  readonly #creatureDisplays = new RevisedSender<number, CreatureModelMetadata>();
  readonly #collisionModels = new RevisedSender<string, CollisionModel>();
  readonly #unitModels = new MapDeltaSender<bigint, UnitModel>();

  encode(lookups: RenderLookups): RenderLookupsMessage {
    return {
      gameObjectDisplays: this.#gameObjectDisplays.delta(lookups.gameObjectDisplays, lookups.gameObjectDisplayRevision),
      gameObjectDisplayRevision: lookups.gameObjectDisplayRevision,
      creatureDisplays: this.#creatureDisplays.delta(lookups.creatureDisplays, lookups.creatureDisplayRevision),
      creatureDisplayRevision: lookups.creatureDisplayRevision,
      collisionModels: this.#collisionModels.delta(lookups.collisionModels, lookups.collisionRevision),
      collisionRevision: lookups.collisionRevision,
      unitModels: this.#unitModels.delta(lookups.unitModels),
    };
  }
}

export class RenderLookupsReceiver {
  readonly #gameObjectDisplays = new MapDeltaReceiver<number, GameObjectDisplayMetadata>();
  readonly #creatureDisplays = new MapDeltaReceiver<number, CreatureModelMetadata>();
  readonly #collisionModels = new MapDeltaReceiver<string, CollisionModel>();
  readonly #unitModels = new MapDeltaReceiver<bigint, UnitModel>();
  readonly #lookups: { -readonly [K in keyof RenderLookups]: RenderLookups[K] } = {
    gameObjectDisplays: undefined, gameObjectDisplayRevision: undefined, creatureDisplays: undefined,
    creatureDisplayRevision: undefined, collisionModels: undefined, collisionRevision: 0, unitModels: undefined,
  };

  apply(message: RenderLookupsMessage): RenderLookups {
    const lookups = this.#lookups;
    lookups.gameObjectDisplays = this.#gameObjectDisplays.apply(message.gameObjectDisplays);
    lookups.gameObjectDisplayRevision = message.gameObjectDisplayRevision;
    lookups.creatureDisplays = this.#creatureDisplays.apply(message.creatureDisplays);
    lookups.creatureDisplayRevision = message.creatureDisplayRevision;
    lookups.collisionModels = this.#collisionModels.apply(message.collisionModels);
    lookups.collisionRevision = message.collisionRevision;
    lookups.unitModels = this.#unitModels.apply(message.unitModels);
    return lookups;
  }
}
