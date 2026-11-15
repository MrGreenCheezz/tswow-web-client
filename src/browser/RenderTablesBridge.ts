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
import type { GroundNormal } from "../world/UnitTilt.js"; // 05.11 (6.44)
import type { VehicleCatalogRows } from "../world/VehicleDbc.js";
import type { RenderSwitchesPush } from "./RenderSwitches.js";
import type { GatewayGenerationPush } from "./GatewayGeneration.js";
import type { RenderInputs } from "./RenderInputs.js";
import type { RenderLookups } from "./RenderLookups.js";
import type { OwnSheathRequest } from "./SheathCeremony.js"; // 5.05 (15.11, combat7)
import type { RangedRepeatMark } from "../world/RangedRepeatMarks.js"; // 5.05 (15.11, bow9)
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
  readonly groundNormals: MapDelta<bigint, GroundNormal> | undefined; // 05.11 (6.44)
  readonly lootRanks: MapDelta<bigint, number> | undefined; // 06.11 (6.41)
  readonly vehicles: Replaced<VehicleCatalogRows | undefined>;
  readonly publishStatus: boolean;
  readonly switches: Replaced<RenderSwitchesPush | undefined>;
  readonly gatewayGeneration: Replaced<GatewayGenerationPush | undefined>;
  readonly frameBudgetProbe: boolean;
  readonly ownSheath: number | undefined; // 5.05 (15.11, combat7)
  /** 5.05 (15.11, combat7): the latest own ToggleSheath, sent when it is another record (SheathCeremony.ts). */
  readonly ownSheathRequest: Replaced<OwnSheathRequest | undefined>;
  /** 15.11 (5.32, combat7 follow-up): the facings kept after a melee victim died (UnitFixedFacing.ts), as differences. */
  readonly fixedFacings: MapDelta<bigint, number> | undefined;
  /** 5.05 (15.11, bow9): the auto-repeat marks (world/RangedRepeatMarks.ts), as differences. */
  readonly rangedRepeat: MapDelta<bigint, RangedRepeatMark> | undefined;
}

export class RenderInputsSender {
  readonly #enchantGlow = new ReplacedSender<EnchantGlowTables | undefined>();
  readonly #casts = new MapDeltaSender<bigint, FacingCast>();
  readonly #movementIds = new MapDeltaSender<number, number>();
  readonly #spellAttributes = new MapDeltaSender<number, readonly number[]>();
  readonly #groundNormals = new MapDeltaSender<bigint, GroundNormal>(); // 05.11 (6.44)
  readonly #lootRanks = new MapDeltaSender<bigint, number>(); // 06.11 (6.41)
  readonly #vehicles = new ReplacedSender<VehicleCatalogRows | undefined>();
  readonly #switches = new ReplacedSender<RenderSwitchesPush | undefined>();
  readonly #generation = new ReplacedSender<GatewayGenerationPush | undefined>();
  readonly #ownSheathRequest = new ReplacedSender<OwnSheathRequest | undefined>(); // 5.05 (15.11, combat7)
  readonly #fixedFacings = new MapDeltaSender<bigint, number>(); // 15.11 (5.32, combat7 follow-up)
  readonly #rangedRepeat = new MapDeltaSender<bigint, RangedRepeatMark>(); // 5.05 (15.11, bow9)

  encode(inputs: RenderInputs): RenderInputsMessage {
    return {
      enchantGlow: this.#enchantGlow.send(inputs.enchantGlow),
      hiddenGameObjects: [...inputs.hiddenGameObjects],
      casts: this.#casts.delta(inputs.facing.casts),
      interactionNpc: inputs.facing.interactionNpc,
      movementIds: this.#movementIds.delta(inputs.facing.movementIds),
      spellAttributes: this.#spellAttributes.delta(inputs.facing.spellAttributes),
      groundNormals: this.#groundNormals.delta(inputs.groundNormals),
      lootRanks: this.#lootRanks.delta(inputs.lootRanks),
      vehicles: this.#vehicles.send(inputs.vehicles),
      publishStatus: inputs.publishStatus,
      switches: this.#switches.send(inputs.switches),
      gatewayGeneration: this.#generation.send(inputs.gatewayGeneration),
      frameBudgetProbe: inputs.frameBudgetProbe,
      ownSheath: inputs.ownSheath, // 5.05 (15.11, combat7)
      ownSheathRequest: this.#ownSheathRequest.send(inputs.ownSheathRequest), // 5.05 (15.11, combat7)
      // 15.11 (5.32, combat7 follow-up): one Map refilled in place; nothing is built while it stays as it was.
      fixedFacings: this.#fixedFacings.delta(inputs.facing.fixedFacings),
      rangedRepeat: this.#rangedRepeat.delta(inputs.rangedRepeat), // 5.05 (15.11, bow9)
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
  readonly #groundNormals = new MapDeltaReceiver<bigint, GroundNormal>(); // 05.11 (6.44)
  readonly #lootRanks = new MapDeltaReceiver<bigint, number>(); // 06.11 (6.41)
  readonly #vehicles = new ReplacedReceiver<VehicleCatalogRows | undefined>(undefined);
  readonly #switches = new ReplacedReceiver<RenderSwitchesPush | undefined>(undefined);
  readonly #generation = new ReplacedReceiver<GatewayGenerationPush | undefined>(undefined);
  readonly #ownSheathRequest = new ReplacedReceiver<OwnSheathRequest | undefined>(undefined); // 5.05 (15.11, combat7)
  readonly #fixedFacings = new MapDeltaReceiver<bigint, number>(); // 15.11 (5.32, combat7 follow-up)
  readonly #rangedRepeat = new MapDeltaReceiver<bigint, RangedRepeatMark>(); // 5.05 (15.11, bow9)
  readonly #facing: { -readonly [K in keyof UnitFacingInputs]: UnitFacingInputs[K] } = {
    casts: this.#casts.map, interactionNpc: undefined, movementIds: this.#movementIds.map,
    spellAttributes: this.#spellAttributes.map,
  };
  readonly #inputs: { -readonly [K in keyof RenderInputs]: RenderInputs[K] } = {
    enchantGlow: undefined, hiddenGameObjects: this.#hidden, facing: this.#facing, groundNormals: this.#groundNormals.map, lootRanks: this.#lootRanks.map, vehicles: undefined,
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
    inputs.groundNormals = this.#groundNormals.apply(message.groundNormals) ?? this.#groundNormals.map;
    inputs.lootRanks = this.#lootRanks.apply(message.lootRanks) ?? this.#lootRanks.map; // 06.11 (6.41)
    inputs.vehicles = this.#vehicles.apply(message.vehicles);
    inputs.publishStatus = message.publishStatus;
    inputs.switches = this.#switches.apply(message.switches);
    inputs.gatewayGeneration = this.#generation.apply(message.gatewayGeneration);
    inputs.frameBudgetProbe = message.frameBudgetProbe;
    inputs.ownSheath = message.ownSheath; // 5.05 (15.11, combat7)
    // 5.05 (15.11, combat7): a new toggle record, its moment onto the renderer's clock (RenderClock.ts).
    if (message.ownSheathRequest.changed) {
      const request = message.ownSheathRequest.value;
      this.#ownSheathRequest.value = request === undefined ? undefined : { ...request, at: toRenderTime(request.at) };
    }
    inputs.ownSheathRequest = this.#ownSheathRequest.value;
    facing.fixedFacings = this.#fixedFacings.apply(message.fixedFacings); // 15.11 (5.32, combat7 follow-up)
    inputs.rangedRepeat = this.#rangedRepeat.apply(message.rangedRepeat); // 5.05 (15.11, bow9)
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
