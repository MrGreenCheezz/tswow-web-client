/**
 * widgets9 (15.11, plan items 3.21/3.43): GetSpellTexture's weapon icons, as Wow.exe 3.3.5a (12340) picks them
 * (read-only Ghidra, .runtime/re-2026-11-15/range8/a2.c, a3.c; behaviour described, no code copied).
 *
 * GetSpellTexture's slot (0x00540d70 → 0x0053dc20) looks at the spell's record before its SpellIcon:
 * - **Attack** (Effect[0] = 78, SPELL_EFFECT_ATTACK) answers 0x005a84d0: the player's shapeshift form's
 *   SpellShapeshiftForm AttackIconID (0x0071af70 the form byte, the row's +0x14) when it has one; else the item in
 *   the main hand (inventory slot 16) when the hand is not disarmed (0x00718fc0: UNIT_FLAG_DISARMED with a weapon in
 *   that hand) — the item's icon; else "Interface\Buttons\Spell-Reset".
 * - **A ranged auto-repeat spell** (Attributes 0x2 and AttributesEx2 0x20: Auto Shot, Shoot) answers 0x005a85e0
 *   when that gives a path: the ranged item's icon (slot 18), unless UNIT_FIELD_FLAGS_2 has 0x400 (ranged disarm),
 *   the slot is empty, or the item is a thrown weapon (subclass 16, 0x00707250); otherwise the SpellIcon as usual.
 *
 * Not done: the form's AttackIconID — `/dbc/spells` does not carry it (on this dataset Cat Form's
 * Ability_Druid_CatFormAttack and both bear forms' Ability_Druid_Swipe). While the player is in any form, the Attack
 * branch is left to the SpellIcon as before, since whether that form has its own icon cannot be told here.
 */

const SPELL_EFFECT_ATTACK = 78;
const SPELL_ATTR0_RANGED = 0x2;
const SPELL_ATTR2_AUTOREPEAT = 0x20;
const UNIT_FLAG_DISARMED = 0x200000;
const UNIT_FLAG2_DISARM_RANGED = 0x400;
const ITEM_CLASS_WEAPON = 2;
const ITEM_SUBCLASS_WEAPON_THROWN = 16;
/** Inventory ids (1-based) of the main hand and the ranged slot. */
export const FRAMEXML_MAIN_HAND_SLOT = 16;
export const FRAMEXML_RANGED_SLOT = 18;
export const FRAMEXML_ATTACK_NO_WEAPON_TEXTURE = "Interface\\Buttons\\Spell-Reset";

export interface SpellWeaponIconSpell {
  readonly effects?: readonly number[];
  readonly attributes?: readonly number[];
}

export interface SpellWeaponIconPlayer {
  /** UNIT_FIELD_BYTES_2's form byte. */
  readonly form: number;
  readonly unitFlags: number;
  readonly unitFlags2: number;
  /** The item in an inventory slot (1-based): its entry, or undefined for an empty slot. */
  slotEntry(slot: number): number | undefined;
  /** An item template's class and subclass; undefined while it is not known. */
  itemKind(entry: number): { readonly itemClass: number; readonly subClass: number } | undefined;
  /** The item's icon path; undefined while it is not known. */
  itemTexture(entry: number): string | undefined;
}

/**
 * The texture 0x0053dc20 answers ahead of the SpellIcon, or undefined when the SpellIcon applies (or when this
 * client cannot tell, see the header).
 */
export function frameXmlSpellWeaponIcon(spell: SpellWeaponIconSpell | undefined,
  readPlayer: () => SpellWeaponIconPlayer | undefined): string | undefined {
  if (!spell) return undefined;
  const attack = spell.effects?.[0] === SPELL_EFFECT_ATTACK;
  const attributes = spell.attributes ?? [];
  const ranged = ((attributes[0] ?? 0) & SPELL_ATTR0_RANGED) !== 0 && ((attributes[2] ?? 0) & SPELL_ATTR2_AUTOREPEAT) !== 0;
  // The player is read only for the two kinds of spell that look at it.
  const player = attack || ranged ? readPlayer() : undefined;
  if (!player) return undefined;
  if (attack) {
    if (player.form !== 0) return undefined;
    const entry = player.slotEntry(FRAMEXML_MAIN_HAND_SLOT);
    const disarmed = (player.unitFlags & UNIT_FLAG_DISARMED) !== 0
      && entry !== undefined && player.itemKind(entry)?.itemClass === ITEM_CLASS_WEAPON;
    if (entry === undefined || disarmed) return FRAMEXML_ATTACK_NO_WEAPON_TEXTURE;
    return player.itemTexture(entry);
  }
  if ((player.unitFlags2 & UNIT_FLAG2_DISARM_RANGED) !== 0) return undefined;
  const entry = player.slotEntry(FRAMEXML_RANGED_SLOT);
  if (entry === undefined) return undefined;
  const kind = player.itemKind(entry);
  if (!kind || kind.subClass === ITEM_SUBCLASS_WEAPON_THROWN) return undefined;
  return player.itemTexture(entry);
}
