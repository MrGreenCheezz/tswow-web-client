/**
 * 5.05 (15.11, combat7): a parry with the weapons shown away is ParryUnarmed — Wow.exe 0x0073b050 picks the parry
 * from the unit's sheath state (+0xb5c), the one the model shows (UnitShownSheath.ts for other units, the page's
 * setter state for the active player, world/SheathSetter.ts), not from the server's UNIT_FIELD_BYTES_2 byte. The
 * renderer holds that state, so it decides here, when the reaction's entry is drawn; the page's cue (game/
 * SwingReactionCues.ts) sends a plain "parry". A unit the renderer has not judged yet (no state) parries armed.
 */
import type { CombatPosePayload } from "./game/CombatAnimations.js";

/** The sheath state with every weapon away (`SHEATH_STATE_UNARMED`). */
const SHEATH_UNARMED = 0;

const PARRY_UNARMED_PAYLOAD: CombatPosePayload = Object.freeze({ action: undefined, reaction: "parryUnarmed" });

/** The payload the combat ladders read: a parry with the weapons shown away becomes ParryUnarmed; anything else as is. */
export function shownParryPayload(payload: CombatPosePayload, shownSheath: number | undefined): CombatPosePayload {
  return payload.reaction === "parry" && shownSheath === SHEATH_UNARMED ? PARRY_UNARMED_PAYLOAD : payload;
}
