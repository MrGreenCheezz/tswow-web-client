/**
 * 22.10 ARC-2 S2a: the main thread's half of RenderInputs.ts — the frame's answers, built from the page's own
 * clients right before `draw`, with the same logic the renderer used to call back into:
 *
 * * the enchant glow: the ready client's tables (was a resolver closure allocated every frame);
 * * the game objects not shown: Loop.ts `loopGameObjectShown` asked for exactly the objects the renderer's
 *   admission pass asked it for — game objects with a position inside `GAMEOBJECT_RANGE` of the view subject
 *   (a dungeon-difficulty object is never a moving transport) — so a template is asked for the same objects;
 * * the unit facing's casts, interaction NPC and creature movement ids (world/UnitFacingSources.ts);
 * * the spell rows' attribute words (SpellRows.ts) and the vehicle tables' rows;
 * * 22.10 ARC-2 S4b: the page's render switches, gateway cache generation and frame-budget flag.
 *
 * Nothing here is read by the renderer between frames, so the record and its sets are refilled in place.
 */

import { GO_TYPE_DUNGEON_DIFFICULTY } from "../../world/DungeonDifficultyObject.js";
import { UnitFacingInputsBuilder, type FacingWorld } from "../../world/UnitFacingSources.js";
import type { VehicleCatalog } from "../../world/VehicleDbc.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { GAMEOBJECT_RANGE, gameObjectWithinAdmissionRange } from "../GameObjectTransportAdmission.js";
import { hypot2 } from "../GroundCover.js";
import { frameBudgetProbe } from "../FrameBudgetProbe.js"; // 22.10 ARC-2 S4b
import { gatewayGenerationPush } from "../GatewayGeneration.js"; // 22.10 ARC-2 S4b
import { enchantGlowTables, type ItemEnchantmentClient } from "../ItemEnchantments.js";
import { renderSwitchesPush } from "../RenderSwitches.js"; // 22.10 ARC-2 S4b
import type { RenderInputs } from "../RenderInputs.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { spellAttributeWordsOf } from "../SpellRows.js";
import { viewSubjectIn, type ViewSubjectState } from "./ViewSubject.js";

const GAMEOBJECT_BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const TYPEID_GAMEOBJECT = 5;

/** What one frame's inputs are built from. */
export interface RenderInputSources {
  /** The world being drawn (`game.world`); its `state` is the one `draw` is handed. */
  readonly world: (FacingWorld & { readonly state: ViewSubjectState }) | undefined;
  /** The page's spell rows (`game.spells`). */
  readonly spells: ReadonlyMap<number, SpellMetadata>;
  /** The gateway's enchant client (`itemEnchantments`), loaded or not. */
  readonly enchantments: ItemEnchantmentClient | undefined;
  /** The page's vehicle tables (`vehicleCatalog()`). */
  readonly vehicles: VehicleCatalog | undefined;
  /** 12.10 7.33: whether a game object is drawn (Loop.ts `loopGameObjectShown`). */
  readonly gameObjectShown: (object: WorldObjectState) => boolean;
  /** 22.10 ARC-2 S3a: whether the loop shows the status line after this frame. */
  readonly publishStatus?: boolean;
}

export class RenderInputsBuilder {
  readonly #facing = new UnitFacingInputsBuilder();
  readonly #hidden = new Set<bigint>();
  readonly #inputs: { -readonly [K in keyof RenderInputs]: RenderInputs[K] };

  constructor() {
    this.#inputs = {
      enchantGlow: undefined,
      hiddenGameObjects: this.#hidden,
      facing: this.#facing.build(undefined, undefined),
      vehicles: undefined,
      publishStatus: false,
      switches: undefined,
      gatewayGeneration: undefined,
      frameBudgetProbe: false,
    };
  }

  build(sources: RenderInputSources): RenderInputs {
    const inputs = this.#inputs;
    const world = sources.world;
    inputs.enchantGlow = enchantGlowTables(sources.enchantments);
    inputs.facing = this.#facing.build(world, spellAttributeWordsOf(sources.spells));
    inputs.vehicles = sources.vehicles?.rows;
    inputs.publishStatus = sources.publishStatus === true; // 22.10 ARC-2 S3a
    // 22.10 ARC-2 S4b: the page's switches, cache generation and sensor flag — frozen records reused until they change.
    inputs.switches = renderSwitchesPush();
    inputs.gatewayGeneration = gatewayGenerationPush();
    inputs.frameBudgetProbe = frameBudgetProbe.enabled;
    this.#collectHidden(world?.state, sources.gameObjectShown);
    return inputs;
  }

  /** The renderer's admission filter (WorldRenderer3D `#updateGameObjects`), then the predicate it asked. */
  #collectHidden(state: ViewSubjectState | undefined, shown: (object: WorldObjectState) => boolean): void {
    const hidden = this.#hidden;
    hidden.clear();
    const player = viewSubjectIn(state)?.position;
    if (state === undefined || player === undefined) return;
    for (const object of state.objects.values()) {
      if (object.typeId !== TYPEID_GAMEOBJECT || !object.position) continue;
      // Any other type is shown without a question asked (`loopGameObjectShown` reads the type first).
      if ((((object.fields.get(GAMEOBJECT_BYTES_1) ?? 0) >>> 8) & 0xff) !== GO_TYPE_DUNGEON_DIFFICULTY) continue;
      const distance = hypot2(object.position.x - player.x, object.position.y - player.y);
      if (!gameObjectWithinAdmissionRange(distance, false, GAMEOBJECT_RANGE)) continue;
      if (!shown(object)) hidden.add(object.guid);
    }
  }
}
