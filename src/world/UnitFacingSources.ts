/**
 * 5.32: the world client's answers to what Wow.exe 0x00735f60 reads beyond a unit's own fields (UnitFacing.ts):
 * the spell a unit is casting (+0xa60), the unit the player's interaction window is open on (0x00bd07a8) and a
 * creature's CreatureMovementInfo id.
 *
 * 22.10 ARC-2 S2a: built once a frame on the main thread as plain data (`UnitFacingInputs`) for the renderer,
 * instead of callbacks the renderer made into the world client (game/RenderInputsBuilder.ts).
 */

import type { FacingCast, UnitFacingInputs } from "./UnitFacing.js";
import type { WorldClient } from "./WorldClient.js";

/** What these answers read of the world client. */
export type FacingWorld = Pick<WorldClient, "casts" | "creatureTemplates" | "gossip" | "questDialog" | "questList"
  | "vendor" | "trainer" | "taxiMenu" | "bankerGuid" | "auctioneerGuid" | "tabardVendorGuid" | "petitionVendor"
  | "stable" | "stableMasterGuid"> & Partial<Pick<WorldClient, "creatureTemplatesRevision">>;

/**
 * The NPC an interaction window is open on — Wow.exe's 0x00bd07a8, which every NPC frame sets through 0x0051fce0
 * (QuestFrame.cpp, the gossip, merchant, trainer, taxi, bank, auction, tabard, charter and stable frames) and
 * 0x00512e60 clears — or undefined.
 */
export function interactionNpcGuid(world: FacingWorld | undefined): bigint | undefined {
  if (world === undefined) return undefined;
  const guid = world.gossip?.guid ?? world.questDialog?.guid ?? world.questList?.guid ?? world.vendor?.guid
    ?? world.trainer?.guid ?? world.taxiMenu?.guid ?? world.bankerGuid
    ?? (world.auctioneerGuid !== 0n ? world.auctioneerGuid : undefined)
    ?? (world.tabardVendorGuid !== 0n ? world.tabardVendorGuid : undefined)
    ?? world.petitionVendor?.vendorGuid
    ?? (world.stable !== undefined && world.stableMasterGuid !== 0n ? world.stableMasterGuid : undefined);
  return guid === undefined || guid === 0n ? undefined : guid;
}

const NO_CASTS: ReadonlyMap<bigint, FacingCast> = new Map();
const NO_SPELL_ATTRIBUTES: ReadonlyMap<number, readonly number[]> = new Map();

/**
 * 22.10 ARC-2 S2a: the facing's answers for one frame. The casts are the world client's own map (plain records,
 * read at the renderer's call with its own clock, as the callback read them); the creature entries' movement ids
 * are re-collected only when the template cache changed (`creatureTemplatesRevision`; a world without one is
 * re-read every frame). One record, refilled in place: the frame allocates nothing.
 */
export class UnitFacingInputsBuilder {
  readonly #movementIds = new Map<number, number>();
  #templatesOf: FacingWorld["creatureTemplates"] | undefined;
  #templatesRevision: number | undefined;
  readonly #inputs: { -readonly [K in keyof UnitFacingInputs]: UnitFacingInputs[K] } = {
    casts: NO_CASTS, interactionNpc: undefined, movementIds: this.#movementIds, spellAttributes: NO_SPELL_ATTRIBUTES,
  };

  build(world: FacingWorld | undefined, spellAttributes: ReadonlyMap<number, readonly number[]> | undefined): UnitFacingInputs {
    const inputs = this.#inputs;
    inputs.casts = world?.casts ?? NO_CASTS;
    inputs.interactionNpc = interactionNpcGuid(world);
    inputs.spellAttributes = spellAttributes ?? NO_SPELL_ATTRIBUTES;
    const templates = world?.creatureTemplates;
    const revision = world?.creatureTemplatesRevision;
    if (templates !== this.#templatesOf || revision === undefined || revision !== this.#templatesRevision) {
      this.#templatesOf = templates;
      this.#templatesRevision = revision;
      this.#movementIds.clear();
      if (templates !== undefined) {
        for (const [entry, template] of templates) {
          if (template.movementId !== undefined) this.#movementIds.set(entry, template.movementId);
        }
      }
    }
    return inputs;
  }
}
