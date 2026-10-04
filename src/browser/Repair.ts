// Repair at a merchant (plan item 2.02), one model for the stock MerchantFrame
// (framexml/FrameXmlRepair.ts) and the native vendor window (ui/VendorRepair.ts).
//
// Everything the player sees before the realm answers is the client's own: whether the merchant
// repairs, what it costs, whether the purse covers it, and the «repair cursor» mode in which a click
// on an item repairs it instead of picking it up. Read off Wow.exe.clean (build 12340; addresses are
// the Lua C functions from the registration table at 0x00aced60..0x00aceda0):
// * CanMerchantRepair (0x005849f0): the merchant unit is in view and its UNIT_NPC_FLAGS has 0x1000.
// * GetRepairAllCost (0x00585990): nothing (nil) without such a merchant; otherwise the sum of
//   0x00584b20 over equipment slots 0..18, backpack 23..38 and the carried bags' contents, and a
//   second value that is 1 when any of those items is worn — whether or not a price is known.
// * RepairAllItems (0x00585c90): the same sum; paying yourself, a purse short of it raises
//   ERR_NOT_ENOUGH_MONEY (game error 40) and sends nothing; the guild bank is not checked. Then
//   CMSG_REPAIR_ITEM(merchant, 0, guildBank).
// * ShowRepairCursor (0x00584a60): only while no spell awaits a target and the merchant repairs;
//   lets go of whatever the cursor holds and enters cursor mode 0x11. HideRepairCursor (0x00584390)
//   leaves it; InRepairMode (0x005843b0) asks it. Closing the merchant (0x00584600) leaves it too.
// * A click on an item with nothing held while in that mode (PickupContainerItem 0x005d7ff0,
//   PickupInventoryItem 0x005e85d0), or a right click on a bag item (UseContainerItem 0x005d8650,
//   before the mail, trade or merchant would take it): the item's price against the purse — short, ERR_NOT_ENOUGH_MONEY
//   and nothing sent — else CMSG_REPAIR_ITEM(merchant, item, 0). Worn or not: an unworn item is sent
//   too, and the realm charges it nothing.
// * CanGuildBankRepair (0x005cc200): in a guild and the rank's rights carry GR_RIGHT_WITHDRAW_REPAIR.
//
// The realm checks it all again (`HandleRepairItemOpcode`, NPCHandler.cpp:758; `DurabilityRepair`
// and `DurabilityRepairAll`, Player.cpp:4998-5140): the interaction distance, its own price, the
// purse, the guild's daily allowance. Its refusals are silent.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { ReputationCatalog } from "../gateway/ReputationMetadata.js";
import {
  itemNeedsRepair, itemRepairCost, repairPriceFactor, type DurabilityTables, type RepairItemFacts,
} from "../world/DurabilityCost.js";
import { readByte } from "../world/Fields.js";
import type { WorldClient } from "../world/WorldClient.js";
import type { WorldObjectState } from "../world/WorldState.js";
import { durabilityClient } from "./DurabilityClient.js";
import { game } from "./game/Context.js";
import { pendingItemTarget } from "./game/SpellCursor.js";
import { playerInventory, type ItemSlotState } from "./Inventory.js";

/** `UNIT_NPC_FLAG_REPAIR` (UnitDefines.h:249). */
export const UNIT_NPC_FLAG_REPAIR = 0x1000;
/** `GR_RIGHT_WITHDRAW_REPAIR` (Guild.h:99). */
export const GR_RIGHT_WITHDRAW_REPAIR = 0x40000;

/** `ReputationMgr::PointsInRank`, hated first; the cap is 42999. */
const POINTS_IN_RANK = [36_000, 3_000, 3_000, 3_000, 6_000, 12_000, 21_000, 1_000] as const;

/** `ReputationMgr::ReputationToRank` (ReputationMgr.cpp:34). */
export function reputationToRank(standing: number): number {
  let limit = 42_999 + 1;
  for (let rank = POINTS_IN_RANK.length - 1; rank >= 0; rank--) {
    limit -= POINTS_IN_RANK[rank]!;
    if (standing >= limit) return rank;
  }
  return 0;
}

/**
 * `ReputationMgr::GetBaseReputation` (ReputationMgr.cpp:97): the first of Faction.dbc's four
 * race/class entries that matches. The wire's standing (SMSG_INITIALIZE_FACTIONS,
 * SMSG_SET_FACTION_STANDING) is the stored standing *without* this base.
 */
export function baseReputation(
  faction: { raceMasks: readonly number[]; classMasks: readonly number[]; bases: readonly number[] },
  race: number,
  playerClass: number,
): number {
  const raceMask = race > 0 ? 1 << (race - 1) : 0;
  const classMask = playerClass > 0 ? 1 << (playerClass - 1) : 0;
  for (let index = 0; index < 4; index++) {
    const races = faction.raceMasks[index] ?? 0;
    const classes = faction.classMasks[index] ?? 0;
    if (((races & raceMask) !== 0 || (races === 0 && classes !== 0))
      && ((classes & classMask) !== 0 || classes === 0)) return faction.bases[index] ?? 0;
  }
  return 0;
}

export interface RepairHost {
  world(): WorldClient | undefined;
  /** The durability tables; undefined until they land. */
  tables(): DurabilityTables | undefined;
  /** Start fetching the tables; idempotent. Called when a merchant who repairs is open. */
  loadTables?(): void;
  /** FactionTemplate.dbc's `Faction` column for a template id. */
  factionOf?(templateId: number): number | undefined;
  /** Faction.dbc's reputation rows by list index (bases and masks). */
  reputation?(): ReputationCatalog | undefined;
  /** Whether a spell or item already waits for its target (the client's SpellIsTargeting). */
  targeting?(): boolean;
}

/** What a repair request came to: sent, refused by the client for money, or nothing to do. */
export type RepairOutcome = "sent" | "unaffordable" | "unavailable";

export interface RepairAllCost {
  readonly cost: number;
  /** Some item is worn: the second value of GetRepairAllCost. */
  readonly canRepair: boolean;
}

export class RepairSession {
  readonly host: RepairHost;
  /** The merchant the repair cursor was shown at; undefined while the mode is off. */
  #armedAt: bigint | undefined;
  #announced = false;
  /** The vendor list whose worn items' templates were last asked for. */
  #prefetchedFor: object | undefined;
  readonly #listeners = new Set<(active: boolean) => void>();

  constructor(host: RepairHost) {
    this.host = host;
  }

  /** The open merchant's unit, when it repairs. */
  #merchant(world: WorldClient | undefined): WorldObjectState | undefined {
    const vendor = world?.vendor;
    if (!world || !vendor) return undefined;
    const unit = world.state.objects.get(vendor.guid);
    const flags = unit?.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0;
    return (flags & UNIT_NPC_FLAG_REPAIR) !== 0 ? unit : undefined;
  }

  /** `CanMerchantRepair`. */
  canMerchantRepair(): boolean {
    return this.#merchant(this.host.world()) !== undefined;
  }

  /** The player's purse, `PLAYER_FIELD_COINAGE`; 0 without the player's object. */
  money(): number {
    const world = this.host.world();
    const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    return self?.fields.get(UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset) ?? 0;
  }

  /** The item's fields and cached template, as the price reads them. */
  facts(world: WorldClient, item: WorldObjectState): RepairItemFacts {
    const entry = item.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
    // The cache only, never a query: this runs from C-API reads and every price redraw.
    const template = world.itemTemplates.get(entry);
    return {
      durability: item.fields.get(UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset) ?? 0,
      maxDurability: item.fields.get(UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset) ?? 0,
      flags: item.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset) ?? 0,
      template: template?.found ? template : undefined,
    };
  }

  /** The items GetRepairAllCost and RepairAllItems walk: equipment 0..18, backpack, carried bags' contents. */
  #walked(world: WorldClient): WorldObjectState[] {
    const inventory = playerInventory(world.state);
    if (!inventory) return [];
    const slots: ItemSlotState[] = [
      ...inventory.equipment.filter((slot) => slot.slot < 19),
      ...inventory.backpack,
      ...inventory.bags.flatMap((bag) => bag.slots),
    ];
    const items: WorldObjectState[] = [];
    for (const slot of slots) if (slot.item) items.push(slot.item);
    return items;
  }

  /**
   * The price factor 0x00584b20 applies: 1 unless the merchant's faction keeps a reputation and the
   * player is friendly or better with it. Forced reactions (SMSG_SET_FORCED_REACTIONS) are not
   * modelled; the realm's own discount can also be changed by a TSWoW script the client cannot see.
   */
  priceFactor(world: WorldClient | undefined = this.host.world()): number {
    const merchant = this.#merchant(world);
    const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    if (!world || !merchant || !self) return 1;
    const template = merchant.fields.get(UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset) ?? 0;
    const factionId = this.host.factionOf?.(template);
    const catalog = this.host.reputation?.();
    if (!factionId || !catalog) return 1;
    let listId: number | undefined;
    for (const [key, faction] of Object.entries(catalog.factions)) {
      if (faction.factionId === factionId) { listId = Number(key); break; }
    }
    if (listId === undefined) return 1;
    const faction = catalog.factions[listId]!;
    const state = world.factions.get(listId);
    // No reputation state for the faction: the core's GetReputation answers 0, neutral.
    if (!state) return 1;
    const race = readByte(self, "UNIT_FIELD_BYTES_0", 0) ?? 0;
    const playerClass = readByte(self, "UNIT_FIELD_BYTES_0", 1) ?? 0;
    return repairPriceFactor(reputationToRank(baseReputation(faction, race, playerClass) + state.standing));
  }

  /** One item's price as the client shows it; 0 without a merchant who repairs or without the tables. */
  itemCost(item: WorldObjectState | undefined): number {
    const world = this.host.world();
    const tables = this.host.tables();
    if (!world || !item || !tables || !this.#merchant(world)) return 0;
    return itemRepairCost(this.facts(world, item), tables, this.priceFactor(world));
  }

  /**
   * One item's price as GameTooltip:SetInventoryItem/SetBagItem answer it (0x0062e050, 0x0062f420
   * call 0x00584b20 whether or not a merchant is open): discounted at a merchant who repairs, whole
   * otherwise; 0 without the tables.
   */
  priceOf(item: WorldObjectState | undefined): number {
    const world = this.host.world();
    const tables = this.host.tables();
    if (!world || !item || !tables) return 0;
    return itemRepairCost(this.facts(world, item), tables, this.priceFactor(world));
  }

  /** `GetRepairAllCost`; undefined (nil) without a merchant who repairs. */
  allCost(): RepairAllCost | undefined {
    const world = this.host.world();
    if (!world || !this.#merchant(world)) return undefined;
    const tables = this.host.tables();
    const factor = this.priceFactor(world);
    let cost = 0;
    let canRepair = false;
    for (const item of this.#walked(world)) {
      const facts = this.facts(world, item);
      if (!itemNeedsRepair(facts)) continue;
      canRepair = true;
      if (tables) cost = (cost + itemRepairCost(facts, tables, factor)) >>> 0;
    }
    return { cost, canRepair };
  }

  /** `CanGuildBankRepair`: in a guild, and the rank's rights let it pay for repairs. */
  canGuildBankRepair(): boolean {
    const world = this.host.world();
    const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    if (!world || !self || (self.fields.get(UPDATE_FIELDS.PLAYER_GUILDID.offset) ?? 0) === 0) return false;
    const rank = self.fields.get(UPDATE_FIELDS.PLAYER_GUILDRANK.offset) ?? 0;
    return ((world.guildRoster?.ranks[rank]?.flags ?? 0) & GR_RIGHT_WITHDRAW_REPAIR) !== 0;
  }

  /** `InRepairMode`: the cursor was shown at the merchant still open, and it still repairs. */
  get active(): boolean {
    const armed = this.#armedAt;
    if (armed === undefined) return false;
    const world = this.host.world();
    return world?.vendor?.guid === armed && this.#merchant(world) !== undefined;
  }

  /** `ShowRepairCursor`; true when the mode is now on. */
  show(): boolean {
    const world = this.host.world();
    if (this.host.targeting?.() || !this.#merchant(world)) return false;
    this.#armedAt = world!.vendor!.guid;
    this.sync();
    return true;
  }

  /** `HideRepairCursor`. */
  hide(): void {
    this.#armedAt = undefined;
    this.sync();
  }

  /**
   * Settle the mode against the world — a merchant closed or replaced ends it, as CloseMerchant does
   * — tell the listeners when it changed, and start the tables once a merchant who repairs is open.
   */
  sync(): void {
    if (this.#armedAt !== undefined && !this.active) this.#armedAt = undefined;
    const active = this.#armedAt !== undefined;
    if (active !== this.#announced) {
      this.#announced = active;
      for (const listener of this.#listeners) listener(active);
    }
    const world = this.host.world();
    if (!world?.vendor || world.vendor === this.#prefetchedFor || !this.#merchant(world)) return;
    // Once per merchant list: the tables, and the templates a worn item's price needs (the cache
    // is only read from C-API calls, so a missing template would price the item at nothing).
    this.#prefetchedFor = world.vendor;
    if (!this.host.tables()) this.host.loadTables?.();
    for (const item of this.#walked(world)) {
      const entry = item.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
      if (entry > 0 && itemNeedsRepair(this.facts(world, item)) && !world.itemTemplates.has(entry)) world.itemTemplate(entry);
    }
  }

  /** Called with the mode each time it changes; returns the unsubscribe. */
  onActiveChange(listener: (active: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** `RepairAllItems([guildBank])`. */
  repairAll(guildBank: boolean): RepairOutcome {
    const world = this.host.world();
    const cost = this.allCost();
    if (!world || !cost) return "unavailable";
    if (!guildBank && this.money() < cost.cost) return "unaffordable";
    world.repairAtVendor(0n, guildBank);
    return "sent";
  }

  /**
   * A click on one of the player's items while the repair cursor is shown and nothing is held:
   * «unavailable» when the mode is off (the click is the caller's ordinary one then).
   */
  repairItem(item: WorldObjectState | undefined, guid: bigint): RepairOutcome {
    this.sync();
    const world = this.host.world();
    if (!world || !this.active || !item || guid === 0n) return "unavailable";
    if (this.money() < this.itemCost(item)) return "unaffordable";
    world.repairAtVendor(guid, false);
    return "sent";
  }

  /** A signature of the walked items' wear, for UPDATE_INVENTORY_DURABILITY edges. */
  wearSignature(): string {
    const world = this.host.world();
    if (!world) return "";
    let signature = "";
    for (const item of this.#walked(world)) {
      const max = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset) ?? 0;
      if (max <= 0) continue;
      signature += `${item.guid}:${item.fields.get(UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset) ?? 0}/${max},`;
    }
    return signature;
  }
}

/** The page's session: the live world, the gateway's tables and the faction catalogs in `game`. */
export const repair = new RepairSession({
  world: () => game.world,
  tables: () => durabilityClient(game.gatewayOrigin)?.tables,
  loadTables: () => durabilityClient(game.gatewayOrigin)?.load(),
  factionOf: (templateId) => game.factions?.factionOf(templateId),
  reputation: () => game.factions?.reputationCatalog,
  // Any pending spell holds the repair cursor back (0x00584a60 asks 0x007fd620 first): the reticle
  // or the item-target cursor (2.05).
  targeting: () => game.groundTarget !== undefined || pendingItemTarget() !== undefined,
});
