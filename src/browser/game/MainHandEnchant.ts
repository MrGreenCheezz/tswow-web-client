import { globalString } from "../../generated/globalStrings.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { fieldGuid } from "../Inventory.js";
import { itemStillBopTradeable } from "./BoundTradeable.js";
import { game } from "./Context.js";
import { cancelItemTarget, type ItemTargetSource } from "./SpellCursor.js";

/**
 * 05.10-2.05: the worn weapon a SPELL_ATTR0_TARGET_MAINHAND_ITEM spell picks itself (plan item 2.05,
 * the «автовыбор оружия»), so a shaman's weapon imbue or a fishing lure goes on without the item
 * cursor. TrinityCore marks the bit «client only» (SharedDefines.h:416): the realm only ever sees the
 * cast with TARGET_FLAG_ITEM and the weapon's guid.
 *
 * Wow.exe 12340, 0x0080c790 (called by the cast entry 0x0080cce0 before any cursor goes up; notes
 * `.runtime/re-2026-10-01/a1-w4/d1.c`, call order read from the bytes at 0x0080c9a0–0x0080cb10):
 *
 * - Only for a player caster with Attributes & 0x200, and for every effect that is
 *   ENCHANT_ITEM_TEMPORARY (54), in effect order: the items worn in slots 15 and 16 (0x00754390).
 * - When the spell's EquippedItemSubclass mask is not 0, an item stays only if its class is the
 *   spell's EquippedItemClass (0x00707220) and its subclass bit is in the mask (0x00707250).
 * - Each one's temporary enchantment (0x00518b30(1): ITEM_FIELD_ENCHANTMENT slot 1, the id) decides:
 *   main hand alone, or the main hand bare — the main hand; the main hand imbued and the off hand
 *   bare — the off hand; both imbued — the one carrying this effect's own enchantment (EffectMiscValue),
 *   and when both carry it, the one with less time left (0x005e8290(1), slot 1's duration; the off
 *   hand is read first and the main hand wins a tie); both imbued with something else — no pick.
 * - A picked item that is bound (0x00708520) and still in its two-hour trade window (!0x00708b40)
 *   stores the spell and the item and raises END_BOUND_TRADEABLE("spellenchant") — unless this is the
 *   answered re-run (`EndBoundTradeable("spellenchant")` → 0x0080da40(…, 1)); otherwise the spell goes
 *   on the item straight away (0x0080bc80 with the item: no BIND_ENCHANT / REPLACE_ENCHANT question,
 *   those belong to a click, 0x005210d0).
 * - No pick for any effect: the cursor, as before — except (05.10 review, 0x0080cce0 right after the
 *   call, `.runtime/re-2026-09-30/m3/d3.c:1102`) with nothing worn in slot 15: SPELL_FAILED_MAINHAND_EMPTY.
 *
 * Gaps, each falling back to the cursor (the old behaviour): no `attributes` (a gateway older than
 * `/dbc/spells?v=14`), an unknown item template while the mask is set. The flags-word bit 0x2000 that
 * makes 0x00518b30 answer 0 is not modelled (as in SpellCursor.ts).
 */

/** `SPELL_ATTR0_TARGET_MAINHAND_ITEM` (SharedDefines.h:416). */
export const SPELL_ATTR0_TARGET_MAINHAND_ITEM = 0x200;
const EFFECT_ENCHANT_ITEM_TEMPORARY = 54;
/** `EQUIPMENT_SLOT_MAINHAND`, `EQUIPMENT_SLOT_OFFHAND`. */
const SLOT_MAIN_HAND = 15;
const SLOT_OFF_HAND = 16;
/** `TEMP_ENCHANTMENT_SLOT`: ITEM_FIELD_ENCHANTMENT_2_1 is its id, _2_2 its duration. */
const TEMP_ENCHANTMENT_SLOT = 1;

export interface MainHandSpellFacts {
  readonly attributes?: readonly number[] | undefined;
  readonly effects?: readonly number[] | undefined;
  readonly effectMiscValue?: readonly number[] | undefined;
  readonly equippedItemClass?: number | undefined;
  readonly equippedItemSubclass?: number | undefined;
  readonly recoveryTime?: number | undefined;
  readonly categoryRecoveryTime?: number | undefined;
  readonly cooldownStartedOnEvent?: boolean | undefined;
}

export interface MainHandWorld {
  readonly state?: {
    readonly selfGuid?: bigint | undefined;
    readonly objects: { get(guid: bigint): WorldObjectState | undefined };
  } | undefined;
  readonly itemTemplates?: { get(entry: number): { itemClass?: number; subClass?: number } | undefined } | undefined;
  playedSecondsNow?(now?: number): number | undefined;
  useItemOnItem?(bag: number, slot: number, itemGuid: bigint, spellId: number, targetGuid: bigint): boolean;
  castSpellOnItem?(spellId: number, itemGuid: bigint, cooldownDuration?: number, cooldownStartedOnEvent?: boolean): void;
  onSpellStatus?: ((message: string, error: boolean) => void) | undefined;
}

interface Worn {
  readonly guid: bigint;
  readonly item: WorldObjectState;
}

/** What the question stored (0x0080c790: 0x00513a10 the item, 0x00513a00 the spell). */
let asked: { readonly world: object; readonly spellId: number; readonly source: ItemTargetSource | undefined } | undefined;
const askers = new Set<() => void>();

function temporary(item: WorldObjectState, word: 0 | 1): number {
  return item.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + TEMP_ENCHANTMENT_SLOT * 3 + word) ?? 0;
}

function worn(world: MainHandWorld, player: WorldObjectState, slot: number, spell: MainHandSpellFacts): Worn | undefined {
  const guid = fieldGuid(player, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + slot * 2);
  const item = guid === 0n ? undefined : world.state?.objects.get(guid);
  if (!item) return undefined;
  const mask = spell.equippedItemSubclass ?? 0;
  if (mask === 0) return { guid, item };
  const entry = item.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const template = entry > 0 ? world.itemTemplates?.get(entry) : undefined;
  if (template?.itemClass === undefined || template.subClass === undefined) return undefined;
  if (template.itemClass !== spell.equippedItemClass) return undefined;
  return template.subClass >= 0 && template.subClass < 32 && (mask & (1 << template.subClass)) !== 0 ? { guid, item } : undefined;
}

/** One effect's pick between the two hands (0x0080c790's ladder); undefined for none. */
function pickBetween(main: Worn | undefined, off: Worn | undefined, enchantId: number): Worn | undefined {
  if (!main) return off;
  if (!off) return main;
  const mainTemp = temporary(main.item, 0);
  if (mainTemp === 0) return main;
  const offTemp = temporary(off.item, 0);
  if (offTemp === 0) return off;
  if (mainTemp === enchantId) {
    if (offTemp !== enchantId) return main;
    return temporary(main.item, 1) <= temporary(off.item, 1) ? main : off;
  }
  return offTemp === enchantId ? off : undefined;
}

/**
 * The worn weapon the spell picks for itself, or undefined (no such spell, no player, nothing fits):
 * 0x0080c790's choice, without the question.
 */
export function mainHandEnchantTarget(world: MainHandWorld | undefined, spell: MainHandSpellFacts | undefined): Worn | undefined {
  const attributes = spell?.attributes?.[0];
  if (!world || !spell || attributes === undefined || (attributes & SPELL_ATTR0_TARGET_MAINHAND_ITEM) === 0) return undefined;
  const selfGuid = world.state?.selfGuid;
  const player = selfGuid === undefined ? undefined : world.state?.objects.get(selfGuid);
  const effects = spell.effects;
  if (!player || !effects) return undefined;
  for (let index = 0; index < effects.length; index++) {
    if (effects[index] !== EFFECT_ENCHANT_ITEM_TEMPORARY) continue;
    const picked = pickBetween(worn(world, player, SLOT_MAIN_HAND, spell), worn(world, player, SLOT_OFF_HAND, spell),
      spell.effectMiscValue?.[index] ?? 0);
    if (picked) return picked;
  }
  return undefined;
}

/**
 * 05.10 review: 0x0080cce0's test after an empty 0x0080c790 answer — the spell has
 * SPELL_ATTR0_TARGET_MAINHAND_ITEM and the player wears nothing in slot 15 (0x00512590(0xf) is 0).
 */
function mainHandEmpty(world: MainHandWorld, spell: MainHandSpellFacts | undefined): boolean {
  const attributes = spell?.attributes?.[0];
  if (attributes === undefined || (attributes & SPELL_ATTR0_TARGET_MAINHAND_ITEM) === 0) return false;
  const selfGuid = world.state?.selfGuid;
  const player = selfGuid === undefined ? undefined : world.state?.objects.get(selfGuid);
  return player !== undefined && fieldGuid(player, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + SLOT_MAIN_HAND * 2) === 0n;
}

/**
 * The cast entry's step before the cursor: true when the spell went on the picked weapon or the
 * END_BOUND_TRADEABLE("spellenchant") question was raised — the caller raises no cursor then. A
 * question nobody can show (no stock interface attached, {@link observeSpellEnchantQuestion}) is not
 * asked: the spell goes out and the realm binds the item, as with every other fact this client lacks.
 */
export function castOnMainHandWeapon(
  world: MainHandWorld | undefined, spellId: number, source?: ItemTargetSource,
  spell: MainHandSpellFacts | undefined = game.spells.get(spellId), answered = false,
): boolean {
  const picked = mainHandEnchantTarget(world, spell);
  if (world && !picked && mainHandEmpty(world, spell)) {
    // 05.10 review: 0x0080cce0 after 0x0080c790 found nothing — an 0x200 spell with slot 15 empty fails
    // locally with SPELL_FAILED_MAINHAND_EMPTY (0x32) instead of raising the cursor.
    world.onSpellStatus?.(globalString("SPELL_FAILED_MAINHAND_EMPTY") ?? "SPELL_FAILED_MAINHAND_EMPTY", true);
    return true;
  }
  if (!world || !picked) return false;
  // One pending spell (Wow.exe DAT_00d3f4e4): a cursor still up for another spell goes down.
  cancelItemTarget();
  if (!answered && askers.size > 0
    && itemStillBopTradeable(picked.item, world.playedSecondsNow?.(), world.state?.selfGuid)) {
    asked = { world, spellId, source };
    for (const ask of [...askers]) {
      try { ask(); } catch { /* the question is presentation; the stored answer stays */ }
    }
    return true;
  }
  asked = undefined;
  if (source) return world.useItemOnItem?.(source.bag, source.slot, source.guid, spellId, picked.guid) === true;
  const cooldown = Math.max(spell?.recoveryTime ?? 0, spell?.categoryRecoveryTime ?? 0);
  world.castSpellOnItem?.(spellId, picked.guid, cooldown, spell?.cooldownStartedOnEvent ?? false);
  return true;
}

/**
 * `EndBoundTradeable("spellenchant")` (0x005233d0 → 0x0080da40(spell, 0, item, 1)): the stored spell
 * again, the question answered. Nothing when nothing is stored or the world changed.
 */
export function answerSpellEnchant(world: MainHandWorld | undefined = game.world as MainHandWorld | undefined): boolean {
  const stored = asked;
  asked = undefined;
  if (!stored || !world || stored.world !== world) return false;
  return castOnMainHandWeapon(world, stored.spellId, stored.source, undefined, true);
}

/** Follow the question being raised (the stock interface fires END_BOUND_TRADEABLE("spellenchant")). */
export function observeSpellEnchantQuestion(ask: () => void): () => void {
  askers.add(ask);
  return () => { askers.delete(ask); };
}
