import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { fieldGuid } from "../Inventory.js";
import { combatFeedbackOf, frameXmlUnitCombatArgs } from "./FrameXmlCombatFeedback.js";
import {
  EQUIPMENT_SLOT_MAINHAND, EQUIPMENT_SLOT_OFFHAND, FRAMEXML_NO_TOTEM, MAX_TOTEMS, TEMP_ENCHANTMENT_SLOT,
  tempEnchantEquipmentSlot, totemPacketSlot,
  type FrameXmlHudMechanics, type FrameXmlTotemInfo, type FrameXmlWeaponEnchantInfo,
} from "./FrameXmlHudMechanics.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";
import { SELF, type WorldStore } from "../../world/WorldStore.js";

/**
 * The stock totem bar, hit indicator and temporary weapon enchants over the live WorldClient.
 *
 * Totems: `world.totems` is the packet record (`SMSG_TOTEM_CREATED`: slot, guid, duration in
 * milliseconds, spell, stamped at receipt) and it is never cleared, because nothing on the wire
 * says a totem is over — it either runs out of duration or its creature is destroyed. So a slot is
 * «active» while its record is inside its duration and its guid has not been seen and then lost
 * from the object store. The packet precedes the creature's create block (`Totem::InitStats` runs
 * before `AddToMap`), which is why an unseen guid is not yet a lost one.
 *
 * Enchants: the worn weapon's `ITEM_FIELD_ENCHANTMENT_1_1 + 3` triple (id, duration, charges) says
 * whether there is one; how long it has left comes from `SMSG_ITEM_ENCHANT_TIME_UPDATE`, which the
 * server sends on login and on every application and which the world stamps. A weapon seen with
 * a duration but no packet yet counts from its first sighting, the one honest fallback.
 */

/** The WorldClient surface this file reads; a structural type so tests can hand in a double. */
export type FrameXmlHudMechanicsWorld = Pick<WorldClient, "events" | "state" | "totems">
  & Partial<Pick<WorldClient, "destroyTotem" | "cancelTempEnchantment">>;

/** The two store subscriptions the enchant watch uses; a test double may carry neither. */
export type FrameXmlHudMechanicsStore = Partial<Pick<WorldStore, "fieldRange" | "object">>;

export interface FrameXmlHudMechanicsLiveContext {
  readonly world: () => FrameXmlHudMechanicsWorld | undefined;
  /**
   * The world's field store. With it, the weapon imbues are watched by subscription — the worn
   * weapon guids (`PLAYER_FIELD_INV_SLOT_HEAD`) and each worn weapon's own fields — and the frame
   * tick reads nothing; a host with no store at all polls the two slots once a frame instead.
   * The live seam's quest log pins zero object reads per sub-60 ms tick (framexml-quest-seam),
   * which a per-frame poll of two equipment slots broke.
   */
  readonly store?: () => FrameXmlHudMechanicsStore | undefined;
  /** `performance.now()` milliseconds: the clock `world.totems` and the enchant stamps are in. */
  readonly monotonic: () => number;
  /** The totem spell's name and icon, from the seam's spell cache; absent until fetched. */
  readonly spell: (id: number) => { readonly name: string; readonly iconPath: string } | undefined;
  /** The seam's unit token resolution (player, pet, target, focus, targettarget, party1..4). */
  readonly unitGuid: (unit: string) => bigint | undefined;
  /** Fetch spell names outside a C-API read; `onLoaded` repaints the bar (ui/SpellNames.ts). */
  readonly prefetchSpells?: (ids: readonly number[], onLoaded: () => void) => void;
}

/** The Lua events this model fires. */
export const FRAMEXML_HUD_MECHANICS_EVENTS = Object.freeze({
  totemUpdate: "PLAYER_TOTEM_UPDATE",
  unitCombat: "UNIT_COMBAT",
  inventoryChanged: "UNIT_INVENTORY_CHANGED",
});

interface LiveTotem {
  readonly guid: bigint;
  readonly duration: number;
  readonly spellId: number;
  readonly startedAt: number;
}

interface TempEnchant {
  readonly id: number;
  readonly charges: number;
  /** Milliseconds left, or nothing when the enchant has no countdown. */
  readonly expiration: number | undefined;
}

export class FrameXmlHudMechanicsLive implements FrameXmlHudMechanics {
  readonly #context: FrameXmlHudMechanicsLiveContext;
  #pump: FrameXmlSeamPump | undefined;
  readonly #unsubscribe: (() => void)[] = [];
  /** Totem guids whose creature has been in the object store at least once. */
  readonly #seenTotems = new Set<bigint>();
  /** Totem guids seen and then destroyed before their duration ran out. */
  readonly #lostTotems = new Set<bigint>();
  /** The active guid last told to Lua per packet slot, so an expiry or a loss fires exactly once. */
  readonly #published = new Map<number, bigint | undefined>();
  /** When each item's temporary enchant runs out, in monotonic milliseconds, by item guid. */
  readonly #enchantExpiry = new Map<bigint, number>();
  #enchantSignature = "";
  /** True only for a host without a field store: the tick then polls the two weapon slots. */
  #pollEnchants = false;
  /** The `object` subscription on each worn weapon (main hand, off hand), by its guid. */
  readonly #weaponWatch: { guid: bigint; off: () => void }[] = [];

  constructor(context: FrameXmlHudMechanicsLiveContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlSeamPump): void {
    if (this.#pump) this.detach();
    this.#pump = pump;
    // A totem placed before the interface mounted is read by TotemFrame's PLAYER_ENTERING_WORLD
    // refresh; only later edges are announced.
    for (let slot = 0; slot < MAX_TOTEMS; slot++) this.#published.set(slot, this.#activeTotem(slot)?.guid);
    this.#enchantSignature = this.#weaponEnchantSignature();
    const store = this.#context.store?.();
    this.#pollEnchants = store === undefined;
    if (store && typeof store.fieldRange === "function" && typeof store.object === "function") {
      this.#unsubscribe.push(store.fieldRange(SELF, "PLAYER_FIELD_INV_SLOT_HEAD", () => this.#refreshEnchants()));
      this.#watchWeapons(store);
    }
    const world = this.#context.world();
    // Older player-only test doubles carry no bus; the models above stay quiet the same way.
    if (typeof world?.events?.on !== "function") return;
    this.#unsubscribe.push(world.events.on("TOTEM_CREATED", (totem) => {
      // A recast into an occupied slot replaces its record; the old creature's loss is then no edge.
      this.#published.set(totem.slot, totem.guid);
      pump.fire(FRAMEXML_HUD_MECHANICS_EVENTS.totemUpdate, totem.slot + 1);
      if (this.#context.spell(totem.spellId) === undefined) {
        this.#context.prefetchSpells?.([totem.spellId], () => {
          if (this.#pump === pump && this.#published.get(totem.slot) === totem.guid) {
            pump.fire(FRAMEXML_HUD_MECHANICS_EVENTS.totemUpdate, totem.slot + 1);
          }
        });
      }
    }));
    this.#unsubscribe.push(world.events.on("UNIT_COMBAT", (event) => {
      const feedback = combatFeedbackOf(event);
      if (!feedback) return;
      for (const args of frameXmlUnitCombatArgs(feedback, this.#context.unitGuid)) {
        pump.fire(FRAMEXML_HUD_MECHANICS_EVENTS.unitCombat, ...args);
      }
    }));
    this.#unsubscribe.push(world.events.on("ITEM_ENCHANT_TIME_UPDATE", (update) => {
      if (update.slot !== TEMP_ENCHANTMENT_SLOT) return;
      this.#enchantExpiry.set(update.itemGuid, update.receivedAt + update.duration * 1000);
      // A re-stamp is an edge of its own (the signature carries the stamp); the polling host
      // reaches the same compare on its next tick.
      if (!this.#pollEnchants) this.#refreshEnchants();
    }));
  }

  detach(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const watch of this.#weaponWatch.splice(0)) watch.off();
    this.#pump = undefined;
    this.#published.clear();
    this.#enchantSignature = "";
    this.#pollEnchants = false;
  }

  /**
   * Follows the worn weapons: one `object` subscription per worn main/off-hand item, replaced
   * when the slot's guid changes (the `PLAYER_FIELD_INV_SLOT_HEAD` range subscription brings the
   * swap here). One player read per call; nothing on the frame tick.
   */
  #watchWeapons(store: FrameXmlHudMechanicsStore): void {
    if (typeof store.object !== "function") return;
    const world = this.#context.world();
    const objects = world?.state?.objects;
    const player = typeof objects?.get === "function" && world?.state.selfGuid !== undefined
      ? objects.get(world.state.selfGuid) : undefined;
    const wanted = [EQUIPMENT_SLOT_MAINHAND, EQUIPMENT_SLOT_OFFHAND]
      .map((slot) => (player ? fieldGuid(player, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + slot * 2) : 0n))
      .filter((guid) => guid !== 0n);
    for (const watch of this.#weaponWatch.splice(0)) {
      if (wanted.includes(watch.guid)) this.#weaponWatch.push(watch);
      else watch.off();
    }
    for (const guid of wanted) {
      if (this.#weaponWatch.some((watch) => watch.guid === guid)) continue;
      this.#weaponWatch.push({ guid, off: store.object(guid, () => this.#refreshEnchants()) });
    }
  }

  /** Compares the weapon imbues with what Lua was last told and announces a change once. */
  #refreshEnchants(): void {
    const pump = this.#pump;
    if (!pump) return;
    const store = this.#context.store?.();
    if (store) this.#watchWeapons(store);
    const signature = this.#weaponEnchantSignature();
    if (signature === this.#enchantSignature) return;
    this.#enchantSignature = signature;
    pump.fire(FRAMEXML_HUD_MECHANICS_EVENTS.inventoryChanged, "player");
  }

  /** Once a frame: totems that ran out or lost their creature, and enchants that came or went. */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const world = this.#context.world();
    if (!world) return;
    const objects = world.state?.objects;
    for (let slot = 0; slot < MAX_TOTEMS; slot++) {
      const record = world.totems?.get(slot);
      if (record && !this.#lostTotems.has(record.guid) && typeof objects?.has === "function") {
        if (objects.has(record.guid)) this.#seenTotems.add(record.guid);
        else if (this.#seenTotems.has(record.guid)) this.#lostTotems.add(record.guid);
      }
      const active = this.#activeTotem(slot)?.guid;
      if (this.#published.get(slot) === active) continue;
      this.#published.set(slot, active);
      pump.fire(FRAMEXML_HUD_MECHANICS_EVENTS.totemUpdate, slot + 1);
    }
    if (this.#pollEnchants) this.#refreshEnchants();
  }

  totemInfo(slot: number): FrameXmlTotemInfo {
    const packetSlot = totemPacketSlot(slot);
    const totem = packetSlot === undefined ? undefined : this.#activeTotem(packetSlot);
    const pump = this.#pump;
    if (!totem || !pump) return FRAMEXML_NO_TOTEM;
    const spell = this.#context.spell(totem.spellId);
    const startTime = pump.now() - (this.#context.monotonic() - totem.startedAt) / 1000;
    return [true, spell?.name ?? "", startTime, totem.duration / 1000, spell?.iconPath ?? ""];
  }

  totemTimeLeft(slot: number): number {
    const packetSlot = totemPacketSlot(slot);
    const totem = packetSlot === undefined ? undefined : this.#activeTotem(packetSlot);
    if (!totem) return 0;
    return Math.max(0, Math.ceil((totem.duration - (this.#context.monotonic() - totem.startedAt)) / 1000));
  }

  destroyTotem(slot: number): void {
    const packetSlot = totemPacketSlot(slot);
    if (packetSlot === undefined || this.#activeTotem(packetSlot) === undefined) return;
    this.#context.world()?.destroyTotem?.(packetSlot);
  }

  weaponEnchantInfo(): FrameXmlWeaponEnchantInfo {
    const main = this.#tempEnchant(this.#wornItem(EQUIPMENT_SLOT_MAINHAND));
    const off = this.#tempEnchant(this.#wornItem(EQUIPMENT_SLOT_OFFHAND));
    return [main !== undefined, main?.expiration, main?.charges, off !== undefined, off?.expiration, off?.charges];
  }

  cancelItemTempEnchantment(weapon: number): void {
    const slot = tempEnchantEquipmentSlot(weapon);
    if (slot === undefined || this.#tempEnchant(this.#wornItem(slot)) === undefined) return;
    this.#context.world()?.cancelTempEnchantment?.(slot);
  }

  #activeTotem(packetSlot: number): LiveTotem | undefined {
    const totem = this.#context.world()?.totems?.get(packetSlot);
    if (!totem || this.#lostTotems.has(totem.guid)) return undefined;
    if (totem.duration > 0 && this.#context.monotonic() - totem.startedAt >= totem.duration) return undefined;
    return totem;
  }

  /** The item in one equipment slot, by the player's own inventory fields; two lookups, no arrays. */
  #wornItem(equipmentSlot: number): WorldObjectState | undefined {
    const world = this.#context.world();
    const objects = world?.state?.objects;
    if (typeof objects?.get !== "function" || world?.state.selfGuid === undefined) return undefined;
    const player = objects.get(world.state.selfGuid);
    if (!player) return undefined;
    const guid = fieldGuid(player, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + equipmentSlot * 2);
    return guid === 0n ? undefined : objects.get(guid);
  }

  #tempEnchant(item: WorldObjectState | undefined): TempEnchant | undefined {
    if (!item) return undefined;
    const offset = UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + TEMP_ENCHANTMENT_SLOT * 3;
    const id = item.fields.get(offset) ?? 0;
    if (id <= 0) {
      this.#enchantExpiry.delete(item.guid);
      return undefined;
    }
    const now = this.#context.monotonic();
    let expiresAt = this.#enchantExpiry.get(item.guid);
    if (expiresAt === undefined) {
      const duration = item.fields.get(offset + 1) ?? 0;
      if (duration > 0) {
        expiresAt = now + duration;
        this.#enchantExpiry.set(item.guid, expiresAt);
      }
    }
    return {
      id, charges: item.fields.get(offset + 2) ?? 0,
      expiration: expiresAt === undefined ? undefined : Math.max(0, expiresAt - now),
    };
  }

  /** What UNIT_INVENTORY_CHANGED compares: the enchant identity and its stamp, not the countdown. */
  #weaponEnchantSignature(): string {
    const parts: string[] = [];
    for (const slot of [EQUIPMENT_SLOT_MAINHAND, EQUIPMENT_SLOT_OFFHAND]) {
      const item = this.#wornItem(slot);
      const enchant = this.#tempEnchant(item);
      parts.push(item === undefined ? ""
        : `${item.guid}:${enchant?.id ?? 0}:${enchant?.charges ?? 0}:${this.#enchantExpiry.get(item.guid) ?? ""}`);
    }
    return parts.join("|");
  }
}
