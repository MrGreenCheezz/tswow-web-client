/**
 * The live auction model's host: LiveWorldSeam's carried bags, its one GUID-checked bag cursor and
 * the item caches, shaped as FrameXmlAuctionContext. A C-API read never starts a fetch: templates and
 * metadata are read from their caches, and `prefetchItems` (outside the read) asks for the rest.
 */
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { readField } from "../../world/Fields.js";
import { entryOf, playerInventory, stackCount, type ItemSlotState } from "../Inventory.js";
import { FrameXmlAuctionModel, type FrameXmlAuctionItem } from "./FrameXmlAuction.js";
import type { FrameXmlQuestItemMetadata } from "./FrameXmlWorldSeam.js";

/** ITEM_FIELD_FLAGS bit 0, ITEM_FIELD_FLAG_SOULBOUND (ItemDefines.h). */
const ITEM_FIELD_FLAG_SOULBOUND = 0x1;

export interface LiveFrameXmlAuctionHost {
  world(): WorldClient | undefined;
  itemInfo?(entry: number): FrameXmlQuestItemMetadata | undefined;
  itemTexture?(entry: number): string | undefined;
  prefetchItems?(itemIds: readonly number[], spellIds: readonly number[], onChanged: () => void): void;
  cursorSource(): ItemSlotState | undefined;
  setCursor(slot: ItemSlotState | undefined): void;
  clearCursor(): void;
  itemLink?(item: WorldObjectState | undefined): string | undefined;
  playerLevel(): number;
  playerClassRace?(): { readonly classId?: number | undefined; readonly raceId?: number | undefined } | undefined;
  locksChanged(): void;
}

/** The backpack, then bags 1-4: stock's bag order, and where a multisell takes its stacks from. */
function carriedSlots(world: WorldClient | undefined): ItemSlotState[] {
  const inventory = world && typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
  return inventory ? [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)]
    .filter((slot) => slot.item !== undefined && slot.guid !== 0n) : [];
}

export function createLiveFrameXmlAuction(host: LiveFrameXmlAuctionHost): FrameXmlAuctionModel {
  const carried = (guid: bigint): ItemSlotState | undefined => carriedSlots(host.world()).find((slot) => slot.guid === guid);
  return new FrameXmlAuctionModel({
    world: () => host.world(),
    item: (entry): FrameXmlAuctionItem | undefined => {
      const world = host.world();
      const template = world && world.itemTemplates instanceof Map ? world.itemTemplates.get(entry) : undefined;
      const found = template?.found === true ? template : undefined;
      const metadata = host.itemInfo?.(entry);
      const name = metadata?.name || found?.name;
      if (!name) return undefined;
      return {
        name,
        texture: host.itemTexture?.(entry) ?? metadata?.texture,
        quality: found?.quality ?? metadata?.quality,
        requiredLevel: found?.requiredLevel,
        sellPrice: found?.sellPrice,
        maxStack: found?.stackable,
        flags: found?.flags,
        allowableClass: found?.allowableClass,
        allowableRace: found?.allowableRace,
      };
    },
    itemObject: (guid) => {
      const slot = carried(guid);
      if (!slot?.item) return undefined;
      return {
        entry: entryOf(slot.item),
        count: stackCount(slot),
        soulbound: ((readField(slot.item, "ITEM_FIELD_FLAGS") ?? 0) & ITEM_FIELD_FLAG_SOULBOUND) !== 0,
        duration: readField(slot.item, "ITEM_FIELD_DURATION") ?? 0,
      };
    },
    carriedStacks: (entry) => carriedSlots(host.world())
      .filter((slot) => entryOf(slot.item) === entry)
      .map((slot) => ({ guid: slot.guid, count: stackCount(slot) })),
    itemLink: (guid) => host.itemLink?.(carried(guid)?.item),
    cursorItem: () => {
      const source = host.cursorSource();
      return source ? { guid: source.guid, bag: source.bag, slot: source.slot } : undefined;
    },
    clearCursor: () => host.clearCursor(),
    pickupItem: (guid) => { const slot = carried(guid); if (slot) host.setCursor(slot); },
    playerLevel: () => host.playerLevel(),
    playerClassRace: () => host.playerClassRace?.(),
    prefetchItems: (entries, onChanged) => {
      // Templates carry the required level, vendor price and stack size the auction rows need; the
      // metadata client's own load also asks the server for them (ItemMetadataClient.attach).
      const world = host.world();
      for (const entry of entries) world?.itemTemplate?.(entry);
      host.prefetchItems?.(entries, [], onChanged);
    },
    locksChanged: () => host.locksChanged(),
  });
}
