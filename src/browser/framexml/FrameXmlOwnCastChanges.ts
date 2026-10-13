/**
 * Plan item 2.05 (13.10): CURRENT_SPELL_CAST_CHANGED on the player's own cast, as Wow.exe 3.3.5a 12340 raises it.
 *
 * 0x0053b480 raises ACTIONBAR_UPDATE_STATE (0x005a7cb0) and then CURRENT_SPELL_CAST_CHANGED. Besides the pending
 * spell's arming and drop (FrameXmlBoundTradeable.ts `frameXmlObservePendingSpells`), a cast reaches it three times
 * (read-only Ghidra: .runtime/re-2026-10-11/glue-1110/cd1210-e.txt, a205-1.txt, a205-2.txt; a2-m8/d1.c):
 *
 * - the request: 0x0080ac90 → 0x00805330(row, 0, 1) after the packet (and after UNIT_SPELLCAST_SENT) — here the
 *   world client's SPELL_CAST_SENT, which every request of the player's (CMSG_CAST_SPELL, CMSG_USE_ITEM) raises;
 * - the start: SMSG_SPELL_START (0x0080fee0 → 0x00806700) without CAST_FLAG_PENDING (1) → 0x00805330, after its
 *   UNIT_SPELLCAST_START (0x0060bf60 with 0x144) — here SPELL_START, which the bus raises after the cast bar's;
 * - the end: 0x008054f0 from the GO (0x0080e1b0), the refusals (SMSG_CAST_FAILED and the client's own through
 *   0x00808200, after 0x007fecc0's FAILED), SMSG_SPELL_FAILURE (0x00809c70) and SMSG_SPELL_FAILED_OTHER
 *   (0x00806ad0) — here SPELL_CAST_RESULT and SPELL_CAST_REFUSED_LOCAL, after the seam's own outcome events.
 *
 * Both 0x00805330 and 0x008054f0 raise it only for the client's spell object of a cast with a count (+0x24 ≠ 0:
 * a triggered spell's 0 raises nothing) whose caster (+0x10) is the active player or what 0x007fe8d0 names — the
 * player's UNIT_FIELD_CHARM, else UNIT_FIELD_SUMMON (the pet, a vehicle, a possessed unit).
 *
 * Stock listeners: ActionButton_UpdateState (ActionButton.lua: the checked state of IsCurrentAction — the spell being
 * cast), SpellBookFrame's selection (SpellBookFrame.lua:299) and UIParent's enchant popups (UIParent.lua:773-779).
 *
 * Not modelled: the request of a controlled unit's own bar (CMSG_PET_CAST_SPELL, WorldClient `#castAsControlledUnit`)
 * raises no bus event, so its send edge is missing; its start and end are here. A cursor that goes down because its
 * click sent the cast and the request raise one pair between them, as the builder does (frameXmlPendingSpellEdge).
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { FRAMEXML_PENDING_SPELL_EVENTS, frameXmlPendingSpellEdge } from "./FrameXmlBoundTradeable.js";

/** SMSG_SPELL_START's CAST_FLAG_PENDING: a triggered spell (0x00806700 skips 0x00805330). */
const CAST_FLAG_PENDING = 0x1;
const CHARM = UPDATE_FIELDS.UNIT_FIELD_CHARM.offset;
const SUMMON = UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset;

interface OwnCastPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export type FrameXmlOwnCastWorld = Pick<WorldClient, "state" | "events">;

function guidAt(fields: ReadonlyMap<number, number>, at: number): bigint | undefined {
  const low = fields.get(at) ?? 0;
  const high = fields.get(at + 1) ?? 0;
  return low === 0 && high === 0 ? undefined : (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
}

/** The caster test of 0x00805330/0x008054f0: the player, or 0x007fe8d0's charm-else-summon. */
export function frameXmlOwnCaster(world: Pick<WorldClient, "state">, caster: bigint | undefined): boolean {
  const self = world.state.selfGuid;
  if (caster === undefined || self === undefined) return false;
  if (caster === self) return true;
  const fields = world.state.objects.get(self)?.fields;
  if (!fields) return false;
  return (guidAt(fields, CHARM) ?? guidAt(fields, SUMMON)) === caster;
}

/**
 * Raises the pair on the world's own-cast edges while attached; answers the detach. Subscribe after the seam's own
 * SENT/START listeners: the pair follows them, as 0x0053b480 follows 0x0060bf60; the end's pair follows the whole
 * packet (a microtask), as 0x008054f0 follows 0x007fecc0's outcome and STOP.
 */
export function frameXmlObserveOwnCastChanges(world: FrameXmlOwnCastWorld, pump: () => OwnCastPump | undefined): () => void {
  const raise = (): void => {
    const target = pump();
    if (!target) return;
    for (const event of FRAMEXML_PENDING_SPELL_EVENTS) target.fire(event);
  };
  // The end's pair waits for the rest of its packet: 0x008054f0 runs after 0x007fecc0's outcome AND its STOP, and the
  // world client ends the cast (WorldClient `#endCast` → SPELL_CAST_STOP) after SPELL_CAST_RESULT in the same handler —
  // raised at once, ActionButton_UpdateState would still read the ended cast as current (IsCurrentAction).
  let detached = false;
  const raiseAfterPacket = (): void => { queueMicrotask(() => { if (!detached) raise(); }); };
  const stops = [
    // A pending spell's drop raised in the same turn stands for the send (frameXmlPendingSpellEdge).
    world.events.on("SPELL_CAST_SENT", (event) => { if (event.castCount !== 0 && frameXmlPendingSpellEdge("sent")) raise(); }),
    world.events.on("SPELL_START", (start) => {
      if ((start.castFlags & CAST_FLAG_PENDING) === 0 && start.castId !== 0 && frameXmlOwnCaster(world, start.casterUnit)) raise();
    }),
    world.events.on("SPELL_CAST_RESULT", (result) => {
      if (result.castCount !== 0 && frameXmlOwnCaster(world, result.casterGuid)) raiseAfterPacket();
    }),
    world.events.on("SPELL_CAST_REFUSED_LOCAL", (refusal) => {
      if (refusal.castCount !== undefined && refusal.castCount !== 0 && frameXmlOwnCaster(world, refusal.casterGuid)) raiseAfterPacket();
    }),
  ];
  return () => {
    detached = true;
    for (const stop of stops) stop();
  };
}
