/**
 * Plan item 3.01 (06.11): COMBAT_TEXT_UPDATE("SPELL_ACTIVE", name), as Wow.exe 3.3.5a (12340) raises it (Ghidra
 * read-only, 06.11; .runtime/re-2026-11-06/301). Learning a spell with SPELL_ATTR4_TRIGGER_ACTIVATE (AttributesEx4
 * 0x200, "initially disabled": Overpower, Revenge, Execute, Victory Rush…) lists it, one entry per name (0x00542030:
 * a higher rank takes the entry's place and keeps its state); a new entry starts neither usable nor powered. The
 * usable pass (0x0053cf10, after CGActionBar::UpdateUsable) and the power pass (0x0053d1b0) ask each entry again —
 * Spell_C_IsUsableAction (0x0080b5d0) and Spell_C_HaveSpellPower (0x008017e0) — and the message goes out when the
 * pair turns to usable and powered from anything else. It names the spell and does not ask for the combat-text unit.
 *
 * Here the pass runs on the seam's usable poll (LiveWorldSeam, every 100 ms) instead of Wow.exe's edges, so a spell
 * that lights up and goes out again between two polls says nothing. The rank is the row's spell level (0x0053b540's
 * own rank source is not read).
 */

import type { SpellMetadata } from "../SpellMetadata.js";

const SPELL_ATTR4_TRIGGER_ACTIVATE = 0x200;
const USABLE = 1;
const POWERED = 2;

export class FrameXmlSpellActive {
  /** By name: the entry's last answers (0x00be8e5c's two bytes), USABLE | POWERED. */
  readonly #entries = new Map<string, number>();
  #owner: object | undefined;

  /**
   * One pass over `book` for the character `owner` (a new one starts a new list): the names to raise SPELL_ACTIVE
   * for. `check` answers Spell_C_IsUsableAction and Spell_C_HaveSpellPower for a row.
   */
  pass(owner: object, book: readonly { readonly id: number }[], spell: (id: number) => SpellMetadata | undefined,
    check: (row: SpellMetadata) => readonly [usable: boolean, powered: boolean]): readonly string[] {
    if (owner !== this.#owner) { this.#entries.clear(); this.#owner = owner; }
    const listed = new Map<string, SpellMetadata>();
    for (const known of book) {
      const row = spell(known.id);
      if (!row?.name || ((row.attributes?.[4] ?? 0) & SPELL_ATTR4_TRIGGER_ACTIVATE) === 0) continue;
      const held = listed.get(row.name);
      if (!held || held.spellLevel < row.spellLevel) listed.set(row.name, row);
    }
    for (const name of this.#entries.keys()) if (!listed.has(name)) this.#entries.delete(name);
    const active: string[] = [];
    for (const [name, row] of listed) {
      const [usable, powered] = check(row);
      const now = (usable ? USABLE : 0) | (powered ? POWERED : 0);
      if (now === (USABLE | POWERED) && this.#entries.get(name) !== now) active.push(name);
      this.#entries.set(name, now);
    }
    return active;
  }
}
