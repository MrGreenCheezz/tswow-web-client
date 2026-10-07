import type { EventBus, Unsubscribe, WorldPacketEvents } from "../../world/EventBus.js";
import { ENCOUNTER_FRAME_DISENGAGE, ENCOUNTER_FRAME_ENGAGE } from "../../world/InstanceProtocol.js";
import { bossDisengaged, bossEngaged } from "../game/Encounters.js";

/** The two edits `ENCOUNTER_FRAME` makes to the boss list, injectable for a test. */
export interface EncounterListEdits {
  readonly engaged: (guid: bigint | undefined) => void;
  readonly disengaged: (guid: bigint | undefined) => void;
}

/**
 * P1-20b: the five packet events that change what the unit frames show — a boss engaging, a raid
 * mark, the pet bar, a member's stats, a threat table — ask for the once-a-frame world refresh
 * (`request`, in practice `queueWorldState`) rather than repainting every frame on the spot.
 *
 * Each of them arrives from a packet whose handler returns to `WorldClient.#dispatch`, which queues
 * the same refresh anyway, so the direct `showUnitFrames()` they used to make was a second paint of
 * all fifty-six frames per packet — in a party fight a hundred a second, in a raid more. Now a frame
 * with any number of them paints once, in `drainWorldState`. The one caller without a packet behind
 * it (`setPetAction`/`swapPetActionSlots` emit `PET_BAR_CHANGED` locally) is covered the same way:
 * `request` queues the refresh that the next frame drains.
 *
 * `ENCOUNTER_FRAME` still edits the boss list at once — it is the list's only source and the order
 * of engages matters — and an encounter frame of another type asks for nothing, as before.
 *
 * DOM-free: `UnitFrames.ts` is not imported, so a test binds this against a bare bus.
 */
export function bindUnitFrameRefresh(
  events: Pick<EventBus<WorldPacketEvents>, "on">,
  request: () => void,
  encounters: EncounterListEdits = { engaged: bossEngaged, disengaged: bossDisengaged },
): Unsubscribe[] {
  return [
    events.on("ENCOUNTER_FRAME", (frame) => {
      if (frame.type === ENCOUNTER_FRAME_ENGAGE) encounters.engaged(frame.guid);
      else if (frame.type === ENCOUNTER_FRAME_DISENGAGE) encounters.disengaged(frame.guid);
      else return;
      request();
    }),
    // A raid mark moved, so somebody's frame gained or lost its star.
    events.on("RAID_TARGET_UPDATE", () => request()),
    // The pet bar arriving or coming down is what tells the pet frame there is a pet at all.
    events.on("PET_BAR_CHANGED", () => request()),
    events.on("PARTY_MEMBER_STATS", () => request()),
    events.on("THREAT_CHANGED", () => request()),
  ];
}
