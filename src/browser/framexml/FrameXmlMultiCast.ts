/**
 * Plan item 3.07: the shaman's Call of the Elements bar (MultiCastActionBarFrame.xml) and the C API
 * it needs, against Wow.exe 3.3.5a 12340 (read-only Ghidra, .runtime/re-2026-10-02/a2-m8/d1.c, d2.c,
 * d5.c, d7.c).
 *
 * - `GetMultiCastTotemSpells(slot)` (0x005a8330) answers the list of slot `(slot - 1) & 3` — so the
 *   flyout's action ids 1..12 fold onto the four slots. The lists are built as spells are learned
 *   (0x00542030): a spell with SPELL_ATTR7_SUMMON_PLAYER_TOTEM goes into every slot its
 *   RequiredTotemCategoryID serves (0x005a7b50; `totemSlotMask`, /dbc/spells?v=16), one entry per
 *   spell name — a higher rank takes the lower one's place.
 * - `SetMultiCastSpell(action, spellId)` (0x005ab8a0): action 133..144 only; 0 clears the button, a
 *   spell whose slots do not include the action's (0x005a7ae0: (action - 133) % 4 → fire, earth,
 *   water, air) is refused, anything else is put on the action button (CMSG_SET_ACTION_BUTTON).
 * - `UPDATE_MULTI_CAST_ACTIONBAR` (0x005ab9d0, after a spell is learned and on the initial book)
 *   first fills, once per slot (CVar `autoFilledMultiCastSlots`, a bit per slot), the empty buttons of
 *   all three pages with the slot's first spell.
 * - `GetTotemInfo(slot)` for a slot with no totem (0x0051d330) answers whether the player carries a
 *   totem of that element (0x007548f0 over TotemCategory 4 fire, 2 earth, 5 water, 3 air; the «Totem
 *   of Power», 21, serves all four) — not a plain false — then "", 0, 0, "". The bar shows a slot only
 *   when that is true and the slot has spells (MultiCastActionBarFrame.lua:313). An active totem's
 *   answer stays FrameXmlHudMechanics' own.
 * - `HasMultiCastActionBar` is the bar's own Lua (MultiCastActionBarFrame.lua:361), not a C API.
 * - `IsSpellKnown(spellId[, isPet])` (0x0053c3a0): the player's or the pet's book. `CastSpellByID`
 *   (0x0053e060): a known spell is cast. `IsCurrentSpell(spellId)` (0x00541500 → 0x00806030): the
 *   spell being cast or channelled, repeated, or the attack while attacking.
 */

import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";
import type { FrameXmlTotemInfo } from "./FrameXmlHudMechanics.js";

/** Action buttons 133..144: three pages of four (fire, earth, water, air). */
export const FRAMEXML_MULTI_CAST_FIRST_ACTION = 133;
export const FRAMEXML_MULTI_CAST_LAST_ACTION = 144;

/** The bit of a 1-based slot (Constants.lua: fire 1, earth 2, water 3, air 4) in `totemSlotMask`. */
export function frameXmlMultiCastSlotBit(slot: number): number {
  return 1 << ((slot - 1) & 3);
}

/** 0x005a7ae0: an action (1-based) of the bar → its slot (1..4), or 0 off the bar. */
export function frameXmlMultiCastActionSlot(action: number): number {
  if (!Number.isInteger(action) || action < FRAMEXML_MULTI_CAST_FIRST_ACTION || action > FRAMEXML_MULTI_CAST_LAST_ACTION) return 0;
  return ((action - FRAMEXML_MULTI_CAST_FIRST_ACTION) % 4) + 1;
}

/** TotemCategory → its element mask (TotemCategory.dbc type 2): the items 0x007548f0 accepts. */
const TOTEM_CATEGORY_MASKS: ReadonlyMap<number, number> = new Map([[2, 0x1], [3, 0x2], [4, 0x4], [5, 0x8], [21, 0xf]]);
/** The category GetTotemInfo asks for per slot (0x0051d330): fire 4, earth 2, water 5, air 3. */
const SLOT_CATEGORY = [4, 2, 5, 3];

/** Whether an item of `itemCategory` serves the category a slot asks for (same type, mask covers it). */
export function frameXmlTotemItemServes(itemCategory: number, slot: number): boolean {
  const required = TOTEM_CATEGORY_MASKS.get(SLOT_CATEGORY[(slot - 1) & 3]!) ?? 0;
  const held = TOTEM_CATEGORY_MASKS.get(itemCategory) ?? 0;
  return required !== 0 && (held & required) === required;
}

/** A book spell as the lists read it. */
export interface FrameXmlMultiCastSpell {
  readonly id: number;
  readonly name: string;
  readonly spellLevel: number;
  readonly totemSlotMask?: number;
}

/** 0x00542030 over the book in learning order: per slot, one spell per name, the higher rank kept. */
export function frameXmlMultiCastLists(book: Iterable<FrameXmlMultiCastSpell | undefined>): number[][] {
  const lists: { id: number; name: string; level: number }[][] = [[], [], [], []];
  for (const spell of book) {
    const mask = spell?.totemSlotMask ?? 0;
    if (!spell || mask === 0) continue;
    for (let index = 0; index < 4; index++) {
      if ((mask & (1 << index)) === 0) continue;
      const list = lists[index]!;
      const same = list.findIndex((entry) => entry.name === spell.name);
      if (same < 0) list.push({ id: spell.id, name: spell.name, level: spell.spellLevel });
      else if (spell.spellLevel > list[same]!.level) list[same] = { id: spell.id, name: spell.name, level: spell.spellLevel };
    }
  }
  return lists.map((list) => list.map((entry) => entry.id));
}

/** What the seam's `multiCast` member answers. */
export interface FrameXmlMultiCastModel {
  /** GetMultiCastTotemSpells: the list of a 1-based slot (already folded). */
  totemSpells(slot: number): readonly number[];
  /** SetMultiCastSpell. */
  setMultiCastSpell(action: number, spellId: number): void;
  /** GetTotemInfo's answer for an empty slot: does the player carry that element's totem. */
  hasTotemItem(slot: number): boolean;
  isSpellKnown(spellId: number, pet: boolean): boolean;
  castSpellById(spellId: number): void;
  isCurrentSpell(spellId: number): boolean;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function number(value: unknown): number {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? Math.trunc(result) : Number.NaN;
}

/**
 * The C API names, spread after FRAMEXML_HUD_MECHANICS_BINDINGS: `GetTotemInfo` wraps theirs so an
 * empty slot answers the item test instead of a plain false when the seam has this model.
 */
export function frameXmlMultiCastBindings(
  hudTotemInfo: FrameXmlSeamBinding,
): Readonly<Record<string, FrameXmlSeamBinding>> {
  return Object.freeze({
    GetMultiCastTotemSpells: (seam, args) => {
      const slot = number(args[0]);
      if (Number.isNaN(slot)) throw new Error("Usage: GetMultiCastTotemSpells(slot)");
      return seam.multiCast?.totemSpells(slot) ?? NOTHING;
    },
    SetMultiCastSpell: (seam, args) => {
      const action = number(args[0]);
      const spellId = number(args[1]);
      if (Number.isNaN(action) && Number.isNaN(spellId)) throw new Error("Usage: SetMultiCastSpell(slot, spellID)");
      seam.multiCast?.setMultiCastSpell(action, Number.isNaN(spellId) ? 0 : spellId);
      return NOTHING;
    },
    IsSpellKnown: (seam, args) => {
      const spellId = number(args[0]);
      if (Number.isNaN(spellId) || spellId <= 0) throw new Error("Usage: IsSpellKnown(spellID[, isPet])");
      const pet = args[1] !== undefined && args[1] !== null && args[1] !== false;
      return [seam.multiCast?.isSpellKnown(spellId, pet) ?? false];
    },
    CastSpellByID: (seam, args) => {
      const spellId = number(args[0]);
      if (Number.isNaN(spellId)) throw new Error("Usage: CastSpellByID(spellID[, target])");
      seam.multiCast?.castSpellById(spellId);
      return NOTHING;
    },
    IsCurrentSpell: (seam, args) => {
      const spellId = number(args[0]);
      return seam.multiCast?.isCurrentSpell(spellId) ? [1] : NOTHING;
    },
    GetTotemInfo: (seam, args) => {
      const answer = hudTotemInfo(seam, args) as FrameXmlTotemInfo;
      const model = seam.multiCast;
      if (!model || answer[0] === true) return answer;
      const slot = number(args[0]);
      if (Number.isNaN(slot) || slot < 1 || slot > 4) return answer;
      return [model.hasTotemItem(slot), "", 0, 0, ""];
    },
  });
}
