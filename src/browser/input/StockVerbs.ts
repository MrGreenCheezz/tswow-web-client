/**
 * The arithmetic behind the stock commands of 3.11, kept apart from `Actions.ts` so it can be
 * tested without a world, a document or the panels that module imports.
 */

/** UNIT_FIELD_BYTES_2 byte 0: SHEATH_STATE_UNARMED / MELEE / RANGED (CombatProtocol.ts). */
export const SHEATH_UNARMED = 0;
export const SHEATH_MELEE = 1;
export const SHEATH_RANGED = 2;

/** Player.h:577-579: the three weapon slots of the equipment array. */
export const EQUIPMENT_SLOT_MAINHAND = 15;
export const EQUIPMENT_SLOT_OFFHAND = 16;
export const EQUIPMENT_SLOT_RANGED = 17;

/** `UNIT_FLAG_STUNNED` (UnitDefines.h:153). */
export const UNIT_FLAG_STUNNED = 0x0004_0000;

/**
 * What `ToggleSheath()` asks for next, or undefined when it asks for nothing.
 *
 * Wow.exe.clean: the Lua function (registration 0xac8370 → 0x51a6b0) calls the player's method at
 * 0x6e23a0, which — past its guards — reads the current state and moves melee → ranged when a
 * ranged weapon can be drawn (else unarmed), ranged → unarmed, and unarmed → melee when the main or
 * off hand holds something, else → ranged when it can be drawn, else nothing. A ranged weapon cannot
 * be drawn by a class whose ChrClasses.Flags has 0x8 (the relic slot): the method reads the class
 * row at +0x24 & 8 and drops the ranged weapon then. Any other current state changes nothing.
 */
export function nextSheathState(current: number | undefined, melee: boolean, ranged: boolean): number | undefined {
  switch (current ?? SHEATH_UNARMED) {
    case SHEATH_MELEE: return ranged ? SHEATH_RANGED : SHEATH_UNARMED;
    case SHEATH_RANGED: return SHEATH_UNARMED;
    case SHEATH_UNARMED: return melee ? SHEATH_MELEE : ranged ? SHEATH_RANGED : undefined;
    default: return undefined;
  }
}

/**
 * The guards 0x6e23a0 checks before anything else that this client can read: a dead player
 * (health below 1), a stunned one (UNIT_FIELD_FLAGS & 0x40000) and one channelling a spell
 * (UNIT_CHANNEL_SPELL) do not change their sheath. The method also refuses while a cast is in
 * progress and in states read through fields this client has no name for; those are left to the
 * server, which answers the packet with the state it accepts.
 */
export function sheathBlocked(health: number | undefined, flags: number | undefined, channelSpell: number | undefined): boolean {
  return (health ?? 1) < 1 || ((flags ?? 0) & UNIT_FLAG_STUNNED) !== 0 || (channelSpell ?? 0) !== 0;
}

/**
 * `ActionBar_PageUp`/`ActionBar_PageDown` (ActionButton.lua:45-78) over 0-based pages: the next or
 * previous page, wrapping at the ends. The stock pair skips pages a shown multi-bar occupies
 * (`VIEWABLE_ACTION_BAR_PAGES`); this plain wrap is that walk with every page viewable. L7 4.16b: the
 * native rows stand on main pages 3–6 now, and the page keys use `ui/ActionBarStockLayout.ts`
 * `stockPageStep`, which skips them.
 */
export function stepActionPage(current: number, delta: 1 | -1, pages = 6): number {
  if (pages <= 0) return 0;
  const page = Number.isInteger(current) && current >= 0 && current < pages ? current : 0;
  return (page + delta + pages) % pages;
}

/**
 * `TARGETPARTYMEMBERn` (Bindings.xml): the party member — unless that member is the target already
 * (or rides a vehicle, which this client cannot tell), and then the member's pet.
 */
export function partyMemberTarget(
  target: bigint | undefined, member: bigint | undefined, pet: bigint | undefined,
): bigint | undefined {
  if (member === undefined) return undefined;
  return target === member && pet !== undefined ? pet : member;
}
