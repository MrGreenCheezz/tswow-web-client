/**
 * Plan item 5.05 (11.11): what a mounted player's cast does to the mount, as Wow.exe 3.3.5a 12340's request sender
 * 0x0080ac90 decides it — Auto Shot's CMSG_CAST_SPELL included, which that function alone writes (0x12e).
 *
 * Read-only Ghidra (.runtime/re-2026-11-11/combat/d1.c, d2.c, l3.lst): after its target checks, 0x0080ac90 tests a
 * spell without SPELL_ATTR0_CASTABLE_WHILE_MOUNTED (Attributes 0x1000000) cast by a unit whose UNIT_FIELD_MOUNTDISPLAYID
 * is above 0 (and whose mount model is out, 0x00715f70 clear): 0x0071b0c0 answers true for the active player not on a
 * taxi (UNIT_FIELD_FLAGS 0x100000), with the CVar autoDismount on (0x00bd08fc, default "1") and either not flying
 * (movement flags 0x2000000) or autoDismountFlying on (0x00bd0900, default "0"). True: 0x007412e0 sends
 * CMSG_CANCEL_MOUNT_AURA (0x375) and the same function goes on to send the cast. False: the request is refused through
 * 0x00808200 with 0x40, SPELL_FAILED_NOT_MOUNTED (0x0080af27), and nothing goes on the wire.
 * So the shot from a horse dismounts like any other spell; only flight, a taxi and the CVar refuse it.
 */

/** Spell.dbc Attributes SPELL_ATTR0_CASTABLE_WHILE_MOUNTED, the bit 0x0080aedb tests. */
export const SPELL_ATTR0_CASTABLE_WHILE_MOUNTED = 0x1000000;
/** SpellCastResult SPELL_FAILED_NOT_MOUNTED (SharedDefines.h), 0x0080ac90's refusal. */
export const SPELL_FAILED_NOT_MOUNTED = 64;
/** UNIT_FLAG_TAXI_FLIGHT, the bit 0x0071b0c0 reads at descriptor +0xd4 (UNIT_FIELD_FLAGS). */
const UNIT_FLAG_TAXI_FLIGHT = 0x100000;
/** MOVEMENTFLAG_FLYING, the bit 0x0071b0c0 reads at the movement info +0x44. */
const MOVEMENTFLAG_FLYING = 0x2000000;

export type MountedCast = "keep" | "dismount" | "refuse";

/** 0x0080ac90 for a mounted player's spell: keep the mount, dismount before the cast, or refuse the cast. */
export function mountedCastRule(attributes0: number | undefined, unitFlags: number, movementFlags: number,
  autoDismount: boolean, autoDismountFlying: boolean): MountedCast {
  if (((attributes0 ?? 0) & SPELL_ATTR0_CASTABLE_WHILE_MOUNTED) !== 0) return "keep";
  if ((unitFlags & UNIT_FLAG_TAXI_FLIGHT) !== 0 || !autoDismount) return "refuse";
  if ((movementFlags & MOVEMENTFLAG_FLYING) !== 0 && !autoDismountFlying) return "refuse";
  return "dismount";
}
