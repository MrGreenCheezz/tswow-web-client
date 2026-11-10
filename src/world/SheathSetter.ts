/**
 * Plan item 5.05 (11.11): when the player's own sheath request goes on the wire — Wow.exe 3.3.5a 12340's sheath
 * setter 0x00736d30 (read-only Ghidra, .runtime/re-2026-10-11/glue-1110/a505-3.txt).
 *
 * The setter keeps the state it last took at unit +0xb5c and does nothing for a request equal to it: no model
 * change and no CMSG_SET_SHEATHED. Only a different state is stored and, for the active player, sent as 0x1e0
 * with the state as a u32. Its callers — the swing 0x006e2610 (1), ToggleSheath 0x006e23a0, the shot — call it
 * on every start, so a second swing or shot with the weapon already out sends nothing. The stops send no sheath
 * at all: StopAttack 0x006e1660, the swing stop 0x006d5f70 and the repeat's stop 0x00807560 never call it
 * (.runtime/re-2026-10-01/a4-world/d2.c, re-2026-10-04/l12-small/g2.c).
 *
 * TrinityCore changes a player's sheath only from that packet (CombatHandler.cpp:77, Player::SetSheath), so
 * UNIT_FIELD_BYTES_2's sheath byte is the last state this client sent; it stands in for the setter's memory
 * until this client has sent one of its own. Not modelled: the setter's refusals of a ranged sheath for a
 * class whose ChrClasses row has flag 0x8, under an aura flag 0x10000000, and for a unit without a model.
 */
import { SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED } from "./CombatProtocol.js";

/** SPELL_ATTR0_RANGED: the bit 0x007fa2e0 tests at the spell row's +0x10 before it draws the ranged weapon. */
export const SPELL_ATTR0_RANGED = 0x2;

/**
 * 5.05 (11.11): Wow.exe 0x0073f060, the active player's stand-state change — from its own request 0x006dcb40 (after
 * CMSG_STANDSTATECHANGE) and from SMSG_STANDSTATE_UPDATE (0x0073f540) — puts the weapon away, the setter's
 * 0x00736d30(0, 1, 0), when the setter holds a drawn state and the new state is neither standing (0) nor sitting in a
 * chair (2): sitting, sleeping, kneeling, dead, a low/medium/high chair (.runtime/re-2026-11-11/combat/d4.c, d5.c).
 */
export function standStateSheathes(standState: number): boolean {
  return standState !== 0 && standState !== 2;
}

export class SheathSetter {
  #held: number | undefined;

  /**
   * Whether a request for `state` goes on the wire: false when it equals the held state — the one this
   * client last sent, else `published`, the server's sheath byte. A request that goes out becomes the held state.
   */
  request(state: number, published: number | undefined): boolean {
    const next = state === SHEATH_MELEE || state === SHEATH_RANGED ? state : SHEATH_UNARMED;
    if (next === (this.#held ?? published)) return false;
    this.#held = next;
    return true;
  }

  /** The state the setter holds, or undefined before this client has sent one. */
  get held(): number | undefined {
    return this.#held;
  }
}
