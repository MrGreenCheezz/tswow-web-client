import { FRAMEXML_HUD_MECHANICS_EVENTS } from "./FrameXmlHudMechanicsLive.js";
import {
  EQUIPMENT_SLOT_MAINHAND, EQUIPMENT_SLOT_OFFHAND, FRAMEXML_NO_TOTEM, tempEnchantEquipmentSlot, totemPacketSlot,
  type FrameXmlHudMechanics, type FrameXmlTotemInfo, type FrameXmlWeaponEnchantInfo,
} from "./FrameXmlHudMechanics.js";
import { FrameXmlRunesCanned, type FrameXmlRuneCooldown } from "./FrameXmlRunes.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

/**
 * The totem bar, hit indicator, temporary weapon enchants and runes over the scripted offline world:
 * one totem and one main-hand enchant from the moment the seam attaches, so the canned vertical draws
 * TotemFrame and TempEnchant1, and the MPQ tests can right-click them and watch the calls; and six
 * ready runes, which RuneFrame draws once the canned player is a death knight (`setPlayerClass`).
 */

/** A scripted totem in one of the client's four slots (Constants.lua: fire 1, earth 2, water 3, air 4). */
export interface CannedTotem {
  readonly slot: number;
  readonly spellId: number;
  readonly name: string;
  readonly icon: string;
  /** Seconds. */
  readonly duration: number;
}

/** The owner's test character knows this earth totem; TOTEM_PRIORITIES puts earth on the first button. */
export const CANNED_TOTEM: CannedTotem = Object.freeze({
  slot: 2, spellId: 58753, name: "Тотем каменной кожи", icon: "Interface\\Icons\\Spell_Nature_StoneSkinTotem",
  duration: 300,
});

/** A scripted temporary enchant on one weapon. */
export interface CannedWeaponEnchant {
  /** `EQUIPMENT_SLOT_MAINHAND` or `EQUIPMENT_SLOT_OFFHAND`. */
  readonly equipmentSlot: number;
  /** Seconds left when the seam attaches; nothing means no countdown. */
  readonly duration: number | undefined;
  readonly charges: number;
}

/** A thirty-minute sharpening stone on the main hand. */
export const CANNED_WEAPON_ENCHANT: CannedWeaponEnchant = Object.freeze({
  equipmentSlot: EQUIPMENT_SLOT_MAINHAND, duration: 1800, charges: 0,
});

interface RunningTotem extends CannedTotem {
  /** GetTime seconds. */
  readonly startTime: number;
}

interface RunningEnchant {
  /** GetTime seconds, or nothing for an enchant without a countdown. */
  readonly expiresAt: number | undefined;
  readonly charges: number;
}

export class FrameXmlHudMechanicsCanned implements FrameXmlHudMechanics {
  #pump: FrameXmlSeamPump | undefined;
  readonly #seed: { readonly totems: readonly CannedTotem[]; readonly enchants: readonly CannedWeaponEnchant[] };
  /** By packet slot 0..3. */
  readonly #totems = new Map<number, RunningTotem>();
  /** By equipment slot 15/16. */
  readonly #enchants = new Map<number, RunningEnchant>();
  /** Every request the stock buttons made, in order: `DestroyTotem:<packet slot>`, `CancelTempEnchantment:<equipment slot>`. */
  readonly calls: string[] = [];
  /** The six runes; tests script them with `useRune`, `refreshRune` and `convertRune`. */
  readonly runes = new FrameXmlRunesCanned();

  constructor(totems: readonly CannedTotem[] = [CANNED_TOTEM], enchants: readonly CannedWeaponEnchant[] = [CANNED_WEAPON_ENCHANT]) {
    this.#seed = { totems, enchants };
  }

  attach(pump: FrameXmlSeamPump): void {
    this.#pump = pump;
    this.runes.attach(pump);
    const now = pump.now();
    this.#totems.clear();
    this.#enchants.clear();
    for (const totem of this.#seed.totems) {
      const packetSlot = totemPacketSlot(totem.slot);
      if (packetSlot !== undefined) this.#totems.set(packetSlot, { ...totem, startTime: now });
    }
    for (const enchant of this.#seed.enchants) {
      if (enchant.equipmentSlot !== EQUIPMENT_SLOT_MAINHAND && enchant.equipmentSlot !== EQUIPMENT_SLOT_OFFHAND) continue;
      this.#enchants.set(enchant.equipmentSlot, {
        expiresAt: enchant.duration === undefined ? undefined : now + enchant.duration, charges: enchant.charges,
      });
    }
  }

  detach(): void {
    this.#pump = undefined;
    this.runes.detach();
  }

  /**
   * Once a frame: a totem whose duration ran out leaves its slot, and a spent rune whose ten seconds
   * are over comes back, with the same edges the live model fires.
   */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    this.runes.tick();
    const now = pump.now();
    for (const [slot, totem] of [...this.#totems]) {
      if (now - totem.startTime < totem.duration) continue;
      this.#totems.delete(slot);
      pump.fire(FRAMEXML_HUD_MECHANICS_EVENTS.totemUpdate, slot + 1);
    }
  }

  /** Script a totem into its slot (a recast replaces the old one), as `SMSG_TOTEM_CREATED` would. */
  placeTotem(totem: CannedTotem): void {
    const pump = this.#pump;
    const packetSlot = totemPacketSlot(totem.slot);
    if (!pump || packetSlot === undefined) return;
    this.#totems.set(packetSlot, { ...totem, startTime: pump.now() });
    pump.fire(FRAMEXML_HUD_MECHANICS_EVENTS.totemUpdate, totem.slot);
  }

  /** Script a blow, heal, energize or miss on a unit token, as the live model words a packet. */
  hit(unit: string, action: string, descriptor: string, amount: number, school: number): void {
    this.#pump?.fire(FRAMEXML_HUD_MECHANICS_EVENTS.unitCombat, unit, action, descriptor, amount, school);
  }

  runeType(rune: number): number | undefined {
    return this.runes.runeType(rune);
  }

  runeCooldown(rune: number): FrameXmlRuneCooldown | undefined {
    return this.runes.runeCooldown(rune);
  }

  totemInfo(slot: number): FrameXmlTotemInfo {
    const packetSlot = totemPacketSlot(slot);
    const totem = packetSlot === undefined ? undefined : this.#totems.get(packetSlot);
    if (!totem) return FRAMEXML_NO_TOTEM;
    return [true, totem.name, totem.startTime, totem.duration, totem.icon];
  }

  totemTimeLeft(slot: number): number {
    const packetSlot = totemPacketSlot(slot);
    const totem = packetSlot === undefined ? undefined : this.#totems.get(packetSlot);
    if (!totem || !this.#pump) return 0;
    return Math.max(0, Math.ceil(totem.duration - (this.#pump.now() - totem.startTime)));
  }

  destroyTotem(slot: number): void {
    const packetSlot = totemPacketSlot(slot);
    if (packetSlot === undefined || !this.#totems.has(packetSlot)) return;
    this.calls.push(`DestroyTotem:${packetSlot}`);
    // The realm unsummons the creature and the slot empties on the next object update; scripted at once.
    this.#totems.delete(packetSlot);
    this.#pump?.fire(FRAMEXML_HUD_MECHANICS_EVENTS.totemUpdate, slot);
  }

  weaponEnchantInfo(): FrameXmlWeaponEnchantInfo {
    const now = this.#pump?.now() ?? 0;
    const main = this.#enchants.get(EQUIPMENT_SLOT_MAINHAND);
    const off = this.#enchants.get(EQUIPMENT_SLOT_OFFHAND);
    const expiration = (enchant: RunningEnchant | undefined): number | undefined =>
      enchant?.expiresAt === undefined ? undefined : Math.max(0, (enchant.expiresAt - now) * 1000);
    return [main !== undefined, expiration(main), main?.charges, off !== undefined, expiration(off), off?.charges];
  }

  cancelItemTempEnchantment(weapon: number): void {
    const slot = tempEnchantEquipmentSlot(weapon);
    if (slot === undefined || !this.#enchants.has(slot)) return;
    this.calls.push(`CancelTempEnchantment:${slot}`);
    this.#enchants.delete(slot);
    this.#pump?.fire(FRAMEXML_HUD_MECHANICS_EVENTS.inventoryChanged, "player");
  }
}
