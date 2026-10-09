/**
 * The NPC-window models over the live world — gossip, bank, taxi, item text and the three charter
 * windows (tabard designer, charter vendors, charter) and the stable (FrameXmlStableLive.ts) — built
 * once by LiveWorldSeam's constructor from what only the seam can reach (its private item cursor,
 * container projection and unit answers). Kept here so LiveWorldSeam carries one construction line, one attach and one detach.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { entryOf, playerInventory, type ItemSlotState, type PlayerInventoryState } from "../Inventory.js";
import type { MapAreaBounds } from "../MinimapGeometry.js";
import { formatNpcText, type NpcTextSubject } from "../ui/NpcText.js";
import { FrameXmlGossipModel } from "./FrameXmlGossip.js";
import { FrameXmlBankModel, frameXmlBankInventorySlot, type FrameXmlBankItemTemplate } from "./FrameXmlBank.js";
import { FrameXmlTaxiModel, type FrameXmlTaxiMapTransform } from "./FrameXmlTaxi.js";
import { FrameXmlItemTextModel } from "./FrameXmlItemText.js";
import { FrameXmlTabardModel } from "./FrameXmlTabard.js";
import { FrameXmlRegistrarModel, type FrameXmlRegistrarItem } from "./FrameXmlRegistrar.js";
import { FrameXmlPetitionModel } from "./FrameXmlPetition.js";
import type { FrameXmlStableModel } from "./FrameXmlStable.js";
import { createLiveFrameXmlStable } from "./FrameXmlStableLive.js";

/** `UNIT_FLAG_ON_TAXI` (UnitDefines.h), set by FlightPathMovementGenerator. */
const UNIT_FLAG_ON_TAXI = 0x00100000;

/** What the models need from LiveWorldSeam; each entry is one of the seam's own answers. */
export interface LiveFrameXmlNpcWindowsHost {
  world(): WorldClient | undefined;
  unitName(unit: string): string | undefined;
  /** `UnitClass`/`UnitRace` localized names; `UnitSex` 2 male, 3 female. */
  unitClassName(unit: string): string | undefined;
  unitRaceName(unit: string): string | undefined;
  unitSex(unit: string): number | undefined;
  unitFlags(unit: string): number | undefined;
  playerFaction(): "Alliance" | "Horde" | undefined;
  itemTemplate(entry: number): FrameXmlBankItemTemplate | undefined;
  /** An entry's resolved icon and quality, as the seam's container signature compares them. */
  itemAppearance(entry: number): string;
  /** PLAYER_QUEST_LOG rows: quest id and its complete bit. */
  questLog(): readonly { readonly questId: number; readonly complete: boolean }[];
  /** Whether a quest of this level is grey to the player (FrameXmlGossip `frameXmlQuestTrivial`). */
  questTrivial(questLevel: number): boolean | undefined;
  /** The seam's carried-container projection (stock ids 0..4 and -2). */
  containerSlot(bagId: number, slot: number): ItemSlotState | undefined;
  cursorSlot(): { readonly bag: number; readonly slot: number } | undefined;
  clickBankSlot(bag: number, slot: number): boolean;
  clearCursor(): void;
  /**
   * The rectangle a map's flight map is drawn for, from the area metadata: WorldMapContinent's
   * TaxiMin/TaxiMax, else the continent-wide WorldMapArea (FrameXmlTaxi `frameXmlTaxiMapBounds`).
   */
  continent(mapId: number): MapAreaBounds | undefined;
  /** WorldMapTransforms from the area metadata: Quel'Thalas and the Draenei isles drawn on EK/Kalimdor. */
  mapTransforms(): readonly FrameXmlTaxiMapTransform[] | undefined;
  /** An item's icon path (GetPetitionItemInfo's texture), when the host resolves one. */
  itemTexture?(entry: number): string | undefined;
}

export interface LiveFrameXmlNpcWindows {
  readonly gossip: FrameXmlGossipModel;
  readonly bank: FrameXmlBankModel;
  readonly taxi: FrameXmlTaxiModel;
  readonly itemText: FrameXmlItemTextModel;
  readonly tabard: FrameXmlTabardModel;
  readonly registrar: FrameXmlRegistrarModel;
  readonly petition: FrameXmlPetitionModel;
  readonly stable: FrameXmlStableModel;
}

function inventoryOf(world: WorldClient | undefined): PlayerInventoryState | undefined {
  return world && typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
}

/** The backpack and the four bags' items, where a bought charter is stored (CanStoreNewItem). */
function carriedItems(world: WorldClient | undefined): FrameXmlRegistrarItem[] {
  const inventory = inventoryOf(world);
  if (!inventory) return [];
  const items: FrameXmlRegistrarItem[] = [];
  for (const slot of [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)]) {
    if (slot.item && slot.guid !== 0n) items.push({ guid: slot.guid, entry: entryOf(slot.item) });
  }
  return items;
}

export function createLiveFrameXmlNpcWindows(host: LiveFrameXmlNpcWindowsHost): LiveFrameXmlNpcWindows {
  const subject = (): NpcTextSubject => {
    const world = host.world();
    const self = world?.state.selfGuid;
    return {
      name: host.unitName("player") ?? world?.selfName ?? "",
      className: host.unitClassName("player") ?? "",
      raceName: host.unitRaceName("player") ?? "",
      gender: host.unitSex("player") === 3 ? 1 : 0,
      declined: self === undefined ? undefined : world?.names.declined(self),
    };
  };
  const questComplete = (questId: number): boolean | undefined =>
    host.questLog().find((row) => row.questId === questId)?.complete;
  return {
    gossip: new FrameXmlGossipModel({
      world: () => host.world(),
      formatText: (text) => formatNpcText(text, subject()),
      questComplete,
      questTrivial: (level) => host.questTrivial(level),
    }),
    bank: new FrameXmlBankModel({
      world: () => host.world(),
      inventory: () => inventoryOf(host.world()),
      itemTemplate: (entry) => host.itemTemplate(entry),
      itemAppearance: (entry) => host.itemAppearance(entry),
      questLogged: (questId) => questComplete(questId) !== undefined,
      cursorSlot: () => host.cursorSlot(),
      clickBankSlot: (bag, slot) => host.clickBankSlot(bag, slot),
      clearCursor: () => host.clearCursor(),
      containerSlot: (bagId, slot) => host.containerSlot(bagId, slot),
    }),
    taxi: new FrameXmlTaxiModel({
      world: () => host.world(),
      continent: (mapId) => host.continent(mapId),
      transforms: () => host.mapTransforms(),
      playerFaction: () => host.playerFaction(),
      unitOnTaxi: (unit) => ((host.unitFlags(unit) ?? 0) & UNIT_FLAG_ON_TAXI) !== 0,
    }),
    itemText: new FrameXmlItemTextModel({ world: () => host.world() }),
    tabard: new FrameXmlTabardModel({ world: () => host.world() }),
    registrar: new FrameXmlRegistrarModel({
      world: () => host.world(),
      carriedItems: () => carriedItems(host.world()),
      itemTexture: (entry) => host.itemTexture?.(entry),
    }),
    petition: new FrameXmlPetitionModel({ world: () => host.world() }),
    stable: createLiveFrameXmlStable({ world: () => host.world() }),
  };
}

/** Attach them all to the seam's pump (LiveWorldSeam.attach). */
export function attachLiveFrameXmlNpcWindows(
  windows: LiveFrameXmlNpcWindows,
  pump: { fire(event: string, ...args: readonly unknown[]): number },
): void {
  windows.gossip.attach(pump);
  windows.bank.attach(pump);
  windows.taxi.attach(pump);
  windows.itemText.attach(pump);
  windows.tabard.attach(pump);
  windows.registrar.attach(pump);
  windows.petition.attach(pump);
  windows.stable.attach(pump);
}

export function detachLiveFrameXmlNpcWindows(windows: LiveFrameXmlNpcWindows): void {
  windows.gossip.detach();
  windows.bank.detach();
  windows.taxi.detach();
  windows.itemText.detach();
  windows.tabard.detach();
  windows.registrar.detach();
  windows.petition.detach();
  windows.stable.detach();
}

/** The Lua inventory ids 40..74 (BankButtonIDToInvSlotID) as the seam's equipment reads take them. */
export function liveFrameXmlBankInventorySlot(world: WorldClient | undefined, inventoryId: number): ItemSlotState | undefined {
  const inventory = inventoryOf(world);
  return inventory ? frameXmlBankInventorySlot(inventory, inventoryId) : undefined;
}

/**
 * UseContainerItem's NPC-window meanings, asked before the ordinary item use: a move across the
 * bank while the banker's permission stands, opening a charter (`ITEM_FLAG_PETITION`, PetitionFrame)
 * and reading a readable item. False: use it.
 */
export function liveFrameXmlNpcUseContainerItem(
  windows: LiveFrameXmlNpcWindows,
  world: WorldClient | undefined,
  bagId: number,
  slot: number,
  source: ItemSlotState | undefined,
): boolean {
  if (windows.bank.useContainerItem(bagId, slot)) return true;
  if (!world || !source?.item) return false;
  const template = world.itemTemplates.get(entryOf(source.item));
  if (windows.petition.useItem(source.guid, template)) return true;
  return windows.itemText.useItem(source.bag, source.slot, template, source.guid); // 5.28 (L6): the guid for a mail copy
}

/**
 * The NPC stock `UnitName("npc")`/`UnitExists("npc")` means while a conversation, flight map, bank,
 * tabard designer or charter list is open: the gossip page's creature, the flight master, the
 * banker, the designer, the registrar.
 */
export function liveFrameXmlInteractionNpc(world: WorldClient | undefined): bigint | undefined {
  const candidates = [
    world?.gossip?.guid, world?.taxiMenu?.guid, world?.bankerGuid, world?.tabardVendorGuid,
    world?.petitionVendor?.vendorGuid,
  ];
  return candidates.find((guid): guid is bigint => guid !== undefined && guid !== 0n);
}

/** `TYPEID_UNIT` (ObjectGuid.h) and the creature/vehicle `HighGuid`s, for an object not in view. */
const TYPEID_UNIT = 3;
const HIGHGUID_UNIT = 0xf130;
const HIGHGUID_VEHICLE = 0xf150;

/**
 * `UnitExists("npc")` for that NPC: true for a creature, false for a game object's gossip — stock
 * then draws GossipFrame's book (GossipFrameUpdate), as the client does for a lectern or a sign.
 */
export function liveFrameXmlInteractionUnit(world: WorldClient | undefined): boolean {
  const guid = liveFrameXmlInteractionNpc(world);
  if (guid === undefined || !world) return false;
  const typeId = typeof world.state.objects?.get === "function" ? world.state.objects.get(guid)?.typeId : undefined;
  if (typeId !== undefined) return typeId === TYPEID_UNIT;
  const high = Number((guid >> 48n) & 0xffffn);
  return high === HIGHGUID_UNIT || high === HIGHGUID_VEHICLE;
}

/** A game object's name from its template, for a gossip page an object (not a creature) opened. */
export function liveFrameXmlGameObjectName(
  world: WorldClient,
  object: { readonly typeId?: number | undefined; readonly fields: ReadonlyMap<number, number> } | undefined,
): string | undefined {
  if (!object || object.typeId !== 5) return undefined;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const name = entry > 0 ? world.gameObjectTemplates.get(entry)?.name : undefined;
  return name || undefined;
}
