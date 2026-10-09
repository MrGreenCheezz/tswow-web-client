/**
 * The native spellbook's pet tab (WORK_PLAN 4.03): the stock pet book's model, not a second one.
 *
 * `FrameXmlPetActionBarLive` already answers the stock SpellBookFrame's "pet" book — `HasPetSpells`,
 * `GetSpellName(i, "pet")`, `CastSpell(i, "pet")`, `ToggleSpellAutocast(i, "pet")` — over the live
 * WorldClient: the rows are SMSG_PET_SPELLS' spell list in the realm's order, a temporary pet (no list)
 * and a vehicle or possessed unit's bar have no book, the tab is «Демон» for a demon and «Питомец»
 * otherwise, a passive spell is never sent, and a book spell dropped on the pet bar becomes
 * CMSG_PET_SET_ACTION with the spell's book state. The native book and the native pet bar read that
 * same instance, so the two interfaces answer the same.
 */
import { game } from "../game/Context.js";
import { FrameXmlPetActionBarLive } from "../framexml/FrameXmlPetActionBarLive.js";
import { ACT_DISABLED, ACT_ENABLED, type PetSpellEntry } from "../../world/PetProtocol.js";
import { nativeString } from "./Strings.js";
import { cooldownLabel } from "./Widgets.js"; // L7 4.03

/** The tab key of the pet book: not a SkillLine id (those are positive), and not the other classes' -7. */
export const SPELLBOOK_PET_TAB = -8;

let model: FrameXmlPetActionBarLive | undefined;

/** The one pet-book model over `game`; nothing in it is per frame, and it holds no world of its own. */
export function nativePetBook(): FrameXmlPetActionBarLive {
  model ??= new FrameXmlPetActionBarLive({
    world: () => game.world,
    monotonic: () => performance.now(),
    spell: (id) => game.spells.get(id),
    unitGuid: () => undefined,
  });
  return model;
}

/** One row of the pet tab, by its 1-based book index; the entry is there before its spell row is. */
export interface PetBookRow {
  readonly index: number;
  readonly entry: PetSpellEntry;
}

/** The pet tab's label and rows, or undefined when there is no pet book. */
export function petBookTab(): { readonly name: string; readonly rows: readonly PetBookRow[] } | undefined {
  const book = nativePetBook().book();
  const spells = game.world?.petSpells?.spells;
  if (!book || !spells) return undefined;
  return {
    name: book.token === "DEMON" ? nativeString("PET_TYPE_DEMON", "Демон") : nativeString("PET_TYPE_PET", "Питомец"),
    rows: spells.slice(0, book.count).map((entry, position) => ({ index: position + 1, entry })),
  };
}

/** Autocastable (ACT_ENABLED / ACT_DISABLED), and on. */
export function petBookAutocast(entry: PetSpellEntry): { readonly autocastable: boolean; readonly on: boolean } {
  return { autocastable: entry.active === ACT_ENABLED || entry.active === ACT_DISABLED, on: entry.active === ACT_ENABLED };
}

/** The drag format a pet book spell carries to the pet bar. */
export const PET_SPELL_DRAG_FORMAT = "text/pet-spell";

/**
 * L7 4.03: the pet tab's cooldown sweeps — stock's pet book shows `GetSpellCooldown(i, "pet")` on every
 * row (SpellBookFrame's SpellButton_UpdateButton). The timers are WorldClient's `petCooldowns` (the end of
 * each, on the `performance.now()` clock, from SMSG_SPELL_COOLDOWN of the pet and SMSG_PET_SPELLS); the
 * sweep's whole is the spell's own recovery, as the character's rows take it, and the time left when the
 * row has none. Drawn the way the character's rows are (`--sweep`, the label, `cooling`), written only
 * when a value moved.
 */
interface PetCooldownElements {
  readonly spellId: number;
  readonly button: HTMLElement;
  readonly cooldown: HTMLElement;
  written?: { sweep: string; label: string; hidden: boolean };
}

const petCooldownRows: PetCooldownElements[] = [];

/** Called by the book for each pet row it draws. */
export function registerPetBookCooldown(spellId: number, button: HTMLElement, cooldown: HTMLElement): void {
  petCooldownRows.push({ spellId, button, cooldown });
}

/** Called when the book's list is rebuilt. */
export function clearPetBookCooldowns(): void {
  petCooldownRows.length = 0;
}

/** One pet spell's sweep at `now`: the time left and the share of the whole still to run. */
export function petBookCooldownView(spellId: number, now: number): { readonly remaining: number; readonly fraction: number } {
  const endsAt = game.world?.petCooldowns?.get(spellId);
  const remaining = endsAt === undefined ? 0 : Math.max(0, endsAt - now);
  if (remaining <= 0) return { remaining: 0, fraction: 0 };
  const metadata = game.spells.get(spellId);
  const whole = Math.max(metadata?.recoveryTime ?? 0, metadata?.categoryRecoveryTime ?? 0, remaining);
  return { remaining, fraction: Math.min(1, remaining / whole) };
}

/** Per frame while the book is open (Spellbook.ts `updateSpellCooldowns`). */
export function updatePetBookCooldowns(now: number): void {
  for (const row of petCooldownRows) {
    const view = petBookCooldownView(row.spellId, now);
    const cooling = view.remaining > 0;
    const sweep = `${Math.round(view.fraction * 360)}deg`;
    const label = cooldownLabel(view.remaining);
    const written = row.written;
    if (written && written.sweep === sweep && written.label === label && written.hidden === !cooling) continue;
    if (!written || written.hidden !== !cooling) row.button.classList.toggle("cooling", cooling);
    row.written = { sweep, label, hidden: !cooling };
    row.cooldown.style.setProperty("--sweep", sweep);
    if (row.cooldown.textContent !== label) row.cooldown.textContent = label;
    if (row.cooldown.hidden !== !cooling) row.cooldown.hidden = !cooling;
  }
}
