/**
 * 22.10 ARC-2 S2a: what the main thread hands the world renderer each frame besides `draw()`'s arguments —
 * answers the renderer used to get by calling back into main-thread functions and module state (an enchant
 * glow resolver, a game-object predicate, the unit-facing sources, the page's spell rows and vehicle tables).
 *
 * Plain data only, so the record can cross to a DedicatedWorker by `postMessage` later: Maps and Sets of
 * primitives and plain frozen records, no functions, no class instances, nothing of three.js. Built by
 * game/RenderInputsBuilder.ts and set by the frame loop right before `draw` (`WorldRenderer3D.setRenderInputs`).
 */

import type { GatewayGenerationPush } from "./GatewayGeneration.js";
import type { EnchantGlowTables } from "./ItemEnchantments.js";
import type { RenderSwitchesPush } from "./RenderSwitches.js";
import { NO_UNIT_FACING_INPUTS, type UnitFacingInputs } from "../world/UnitFacing.js";
import type { VehicleCatalogRows } from "../world/VehicleDbc.js";

export interface RenderInputs {
  /** The enchant tables while the client holds them (ItemEnchantments.ts); absent, blades draw unlit. */
  readonly enchantGlow: EnchantGlowTables | undefined;
  /**
   * 12.10 7.33: the game objects Wow.exe hides this frame — a dungeon-difficulty portal of the other difficulty
   * (world/DungeonDifficultyObject.ts). Kept resident, neither drawn nor pinned; every other one is shown.
   */
  readonly hiddenGameObjects: ReadonlySet<bigint>;
  /** 5.32: what 0x00735f60 reads beyond a unit's own fields (world/UnitFacing.ts). */
  readonly facing: UnitFacingInputs;
  /** 11.02-H: the vehicle tables' rows (VehicleClient.ts); absent until they land. */
  readonly vehicles: VehicleCatalogRows | undefined;
  /** 22.10 ARC-2 S3a: this frame's `endRenderFrame` writes the status line into RenderResults.ts (the 2 Hz tick). */
  readonly publishStatus: boolean;
  /**
   * 22.10 ARC-2 S4b: the page's render switches (DebugTab, the lookdev preset), applied to the renderer realm's own
   * when the revision moves (RenderSwitches.ts). Absent: the renderer's stay as they are.
   */
  readonly switches: RenderSwitchesPush | undefined;
  /** 22.10 ARC-2 S4b: the page's gateway cache generation, likewise (GatewayGeneration.ts). */
  readonly gatewayGeneration: GatewayGenerationPush | undefined;
  /** 22.10 ARC-2 S4b: whether the page's frame-budget sensor records; a renderer with its own follows it. */
  readonly frameBudgetProbe: boolean;
}

/** Nothing pushed (a benchmark, a test, before the first frame): no glow, every object shown, no facing sources. */
export const NO_RENDER_INPUTS: RenderInputs = Object.freeze({
  enchantGlow: undefined,
  hiddenGameObjects: new Set<bigint>(),
  facing: NO_UNIT_FACING_INPUTS,
  vehicles: undefined,
  publishStatus: false,
  switches: undefined,
  gatewayGeneration: undefined,
  frameBudgetProbe: false,
});
