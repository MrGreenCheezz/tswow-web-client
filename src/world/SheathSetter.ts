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
    // A sheath byte the server never wrote is zero: update fields left out of a create block read 0, so the
    // weapon is away and a request to put it away has nothing to change.
    if (next === (this.#held ?? published ?? SHEATH_UNARMED)) return false;
    this.#held = next;
    return true;
  }

  /** The state the setter holds, or undefined before this client has sent one. */
  get held(): number | undefined {
    return this.#held;
  }

  /**
   * 5.05 (15.11, combat7): a new player object (login, a far teleport) holds the sheath byte of its CREATE block. Later
   * VALUES changes of the byte do not move the active player's held state:
   *
   * * Read (re-2026-11-15/combat7/g7.c, g8.lst, g9.lst): the value callbacks are dispatched by 0x004d5150, reached only
   *   from the VALUES path 0x004d5550 (a CREATE block, 0x004d53c0, only refreshes the snapshot), and only for a field
   *   whose new bytes differ from the snapshot. The call is (guid lo, guid hi, field offset, size, snapshot pointer,
   *   user data): `*param_5` is the OLD value, read as a dword (the PvP byte 0x1d1 rides in it). 0x00737aa0 then calls
   *   0x00736d30(new byte, 1, 1) for the active player only when +0xb5c equals that old dword.
   * * Recorded on Wow.exe (runs/sheath6-calib, a fresh login with the byte 0 in CREATE, then a VALUES block with
   *   BYTES_2 = 1 and the main-hand item): the sword stayed on the back and the first ToggleSheath sent 1 — the held
   *   state was still 0. Read literally (held 0 = old 0) the callback would have drawn it, so the reading is incomplete
   *   (a guess, unverified: in that block the byte's callback ran before the item's, and the setter's clamp 0x00715d00
   *   may have turned the state back to 0 with no weapon in the hand yet). The taking branch is left out.
   * * On TrinityCore it would never fire anyway: a player's byte changes only from its own CMSG_SET_SHEATHED
   *   (CombatHandler.cpp:77), whose echo always finds +0xb5c already moved, so it is ignored either way.
   */
  reset(published: number | undefined): void {
    this.#held = published;
  }

  /**
   * 5.05 (15.11, combat7): the sheath the active player's model shows (+0xb5c): the held state, else the server's
   * byte. The model hangs its pieces by it (0x00731f40), so a state this client decides shows in the frame it is set.
   */
  shown(published: number | undefined): number {
    return this.#held ?? published ?? SHEATH_UNARMED;
  }
}
