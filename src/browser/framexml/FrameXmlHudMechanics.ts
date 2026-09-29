import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

/**
 * The three stock HUD mechanics the boot census found without a host: the totem bar
 * (TotemFrame.xml, `GetTotemInfo`/`GetTotemTimeLeft`/`DestroyTotem`, `PLAYER_TOTEM_UPDATE`), the
 * hit indicator over the Player/Target/Pet portraits (CombatFeedback.xml, `UNIT_COMBAT`) and the
 * temporary weapon enchant buttons of the buff frame (BuffFrame.lua's TemporaryEnchantFrame,
 * `GetWeaponEnchantInfo`/`CancelItemTempEnchantment`).
 *
 * This file is the contract and the C-API table; FrameXmlHudMechanicsLive.ts answers it over the
 * WorldClient and FrameXmlHudMechanicsCanned.ts over the scripted offline world. The hit indicator
 * has no C API of its own — it is an event — so its wording lives in FrameXmlCombatFeedback.ts.
 */

/** `GetTotemInfo`'s five values; `startTime` is GetTime-based and `duration` is in seconds. */
export type FrameXmlTotemInfo = readonly [
  haveTotem: boolean, name: string, startTime: number, duration: number, icon: string,
];

/**
 * The answer for an empty slot. Not `nil`: TotemFrame_OnEvent hands `duration` straight to
 * TotemButton_Update's `duration > 0` for the button that held the slot, so it must be a number.
 */
export const FRAMEXML_NO_TOTEM: FrameXmlTotemInfo = Object.freeze([false, "", 0, 0, ""]) as FrameXmlTotemInfo;

/**
 * `GetWeaponEnchantInfo`'s six values. The expirations are milliseconds — BuffFrame.lua divides them
 * by 1000 before `AuraButton_UpdateDuration` — and nil when the enchant has no countdown.
 */
export type FrameXmlWeaponEnchantInfo = readonly [
  hasMainHandEnchant: boolean, mainHandExpiration: number | undefined, mainHandCharges: number | undefined,
  hasOffHandEnchant: boolean, offHandExpiration: number | undefined, offHandCharges: number | undefined,
];

export const FRAMEXML_NO_WEAPON_ENCHANTS: FrameXmlWeaponEnchantInfo =
  Object.freeze([false, undefined, undefined, false, undefined, undefined]) as FrameXmlWeaponEnchantInfo;

/** Constants.lua: four slots, fire 1, earth 2, water 3, air 4; TOTEM_PRIORITIES lists earth first. */
export const MAX_TOTEMS = 4;

/** `EQUIPMENT_SLOT_MAINHAND`/`_OFFHAND` (Player.h): the two weapons a temporary enchant can sit on. */
export const EQUIPMENT_SLOT_MAINHAND = 15;
export const EQUIPMENT_SLOT_OFFHAND = 16;

/** `TEMP_ENCHANTMENT_SLOT` (Item.h): the second of an item's enchantment triples (id, duration, charges). */
export const TEMP_ENCHANTMENT_SLOT = 1;

/**
 * The client's 1-based totem slot (Constants.lua) as `SMSG_TOTEM_CREATED`/`CMSG_TOTEM_DESTROYED`
 * number it: `Totem::InitStats` writes `Slot - SUMMON_SLOT_TOTEM_FIRE`, 0 to 3.
 */
export function totemPacketSlot(slot: number): number | undefined {
  return Number.isInteger(slot) && slot >= 1 && slot <= MAX_TOTEMS ? slot - 1 : undefined;
}

/**
 * The equipment slot behind `CancelItemTempEnchantment`'s argument. The stock button passes 1 for
 * the main hand and 2 for the off hand (BuffFrame.lua TempEnchantButton_OnClick); the inventory
 * ids the same buttons carry (16, 17) are taken too, since nothing else in a two-weapon API could
 * mean them.
 */
export function tempEnchantEquipmentSlot(weapon: number): number | undefined {
  if (weapon === 1 || weapon === EQUIPMENT_SLOT_MAINHAND + 1) return EQUIPMENT_SLOT_MAINHAND;
  if (weapon === 2 || weapon === EQUIPMENT_SLOT_OFFHAND + 1) return EQUIPMENT_SLOT_OFFHAND;
  return undefined;
}

/** What the seam answers for the three mechanics; every read must stay cheap (totem buttons read per frame). */
export interface FrameXmlHudMechanics {
  /** `GetTotemInfo(slot)`, slot 1..4 in the client's numbering. */
  totemInfo(slot: number): FrameXmlTotemInfo;
  /** `GetTotemTimeLeft(slot)`: whole seconds left, 0 for an empty slot. */
  totemTimeLeft(slot: number): number;
  /** `DestroyTotem(slot)`: the right-click on a totem button. */
  destroyTotem(slot: number): void;
  /** `GetWeaponEnchantInfo()` for the worn main and off hand. */
  weaponEnchantInfo(): FrameXmlWeaponEnchantInfo;
  /** `CancelItemTempEnchantment(1|2)`: the right-click on a temporary enchant button. */
  cancelItemTempEnchantment(weapon: number): void;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function slotOf(value: unknown): number {
  const slot = Number(value);
  return Number.isFinite(slot) ? Math.trunc(slot) : 0;
}

/** The five C-API names, answered by `seam.hudMechanics`; a seam without the model keeps the stock frames empty. */
export const FRAMEXML_HUD_MECHANICS_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  GetTotemInfo: (seam, args) => seam.hudMechanics?.totemInfo(slotOf(args[0])) ?? FRAMEXML_NO_TOTEM,
  GetTotemTimeLeft: (seam, args) => [seam.hudMechanics?.totemTimeLeft(slotOf(args[0])) ?? 0],
  DestroyTotem: (seam, args) => {
    seam.hudMechanics?.destroyTotem(slotOf(args[0]));
    return NOTHING;
  },
  GetWeaponEnchantInfo: (seam) => seam.hudMechanics?.weaponEnchantInfo() ?? FRAMEXML_NO_WEAPON_ENCHANTS,
  CancelItemTempEnchantment: (seam, args) => {
    seam.hudMechanics?.cancelItemTempEnchantment(slotOf(args[0]));
    return NOTHING;
  },
});
