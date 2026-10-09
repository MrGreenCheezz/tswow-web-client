/**
 * Action buttons and the player's repeating attacks: `IsAttackAction`, `IsAutoRepeatAction`,
 * `IsCurrentAction` for the attack button, and `START_AUTOREPEAT_SPELL`/`STOP_AUTOREPEAT_SPELL`.
 *
 * Stock callers: `ActionButton.lua:306` (checked state: `IsCurrentAction or IsAutoRepeatAction`),
 * `:400-413` (flash on PLAYER_ENTER/LEAVE_COMBAT for the attack button and on START/STOP_AUTOREPEAT
 * for the repeating one) and `:498` (`ActionButton_UpdateFlash`).
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra), in this file's words:
 * * All three answer 1 or nil (0x5a9ba0, 0x5a9c10, 0x5aad40), for slots 1..144.
 * * `IsAttackAction(slot)` (0x5a9ba0 → 0x5a96d0): the slot's spell has `SPELL_EFFECT_ATTACK` (78,
 *   `SharedDefines.h:884`) as its first effect (Spell.dbc column Effect[0], row offset 0x11c).
 * * `IsAutoRepeatAction(slot)` (0x5a9c10 → 0x5a9470): the slot's spell is the spell the client is
 *   repeating (0xd397d0, or the second slot 0xd397cc; both read back by 0x7fe130/0x7fe180).
 * * `IsCurrentAction(slot)` (0x5aad40 → 0x5aa240) answers an attack action by whether the player is
 *   auto-attacking (the player object's attack target, +0xa20/+0xa24).
 * * The repeating spell's setters (0x7fe140, 0x800a00) fire `START_AUTOREPEAT_SPELL` whenever it
 *   changes to a spell and `STOP_AUTOREPEAT_SPELL` when it is cleared (0x807560 on cancel), while the
 *   other slot is clear. `ACTIONBAR_UPDATE_STATE` is not theirs: the client fires it with
 *   `CURRENT_SPELL_CAST_CHANGED` from its cast path (0x53b480). This browser client has no such edge
 *   at the moment the repeat starts, so the model follows each START/STOP with one
 *   `ACTIONBAR_UPDATE_STATE`, which only re-reads the checked state.
 *
 * `WorldClient.autoRepeatSpellId` has no bus edge; the seam reads it once a rendered frame, as it
 * reads `attacking` for PLAYER_ENTER_COMBAT.
 */

/** `SPELL_EFFECT_ATTACK` (`SharedDefines.h:884`), the first effect of «Атака» (6603). */
export const SPELL_EFFECT_ATTACK = 78;

export const START_AUTOREPEAT_SPELL = "START_AUTOREPEAT_SPELL";
export const STOP_AUTOREPEAT_SPELL = "STOP_AUTOREPEAT_SPELL";
export const ACTIONBAR_UPDATE_STATE = "ACTIONBAR_UPDATE_STATE";

/** `IsAttackAction`'s test on a spell row: its first effect is SPELL_EFFECT_ATTACK. */
export function frameXmlIsAttackSpell(spell: { readonly effects?: readonly number[] | undefined } | undefined): boolean {
  return spell?.effects?.[0] === SPELL_EFFECT_ATTACK;
}

interface FrameXmlAutoRepeatPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** The START/STOP_AUTOREPEAT_SPELL edges over the repeating spell id, read once a frame. */
export class FrameXmlAutoRepeatEdge {
  #pump: FrameXmlAutoRepeatPump | undefined;
  #spell: number | undefined;

  /** A (re)mount starts from what is repeating now: an edge belongs to a change, not to a mount. */
  attach(pump: FrameXmlAutoRepeatPump, spell: number | undefined): void {
    this.#pump = pump;
    this.#spell = spell;
  }

  detach(): void {
    this.#pump = undefined;
  }

  sync(spell: number | undefined): void {
    if (spell === this.#spell) return;
    this.#spell = spell;
    const pump = this.#pump;
    if (!pump) return;
    pump.fire(spell !== undefined ? START_AUTOREPEAT_SPELL : STOP_AUTOREPEAT_SPELL);
    pump.fire(ACTIONBAR_UPDATE_STATE);
  }
}
