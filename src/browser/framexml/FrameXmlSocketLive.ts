/**
 * The live socketing model's host: LiveWorldSeam's equipment and carried slots, its one GUID-checked
 * bag cursor, the item caches and the `/dbc/item-enchantments` gem tables (the same ItemEnchantmentClient
 * the native window reads). A C-API read never starts a fetch: templates and metadata come from their
 * caches, and `prefetch` (outside the read) asks for the rest.
 */
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { readField } from "../../world/Fields.js";
import { equipErrorText } from "../../world/ItemProtocol.js";
import { entryOf, playerInventory, stackCount, type ItemSlotState } from "../Inventory.js";
import { itemEnchantmentIds, itemEnchantments, type ItemEnchantmentClient } from "../ItemEnchantments.js";
import { game } from "../game/Context.js";
import { FrameXmlSocketModel, type FrameXmlSocketCarried, type FrameXmlSocketGemFacts } from "./FrameXmlSocketModel.js";
import type { FrameXmlQuestItemMetadata } from "./FrameXmlWorldSeam.js";

/** Bag template: `ItemClass` container, subclasses ordinary (0) and gem bag (5); `BAG_FAMILY_MASK_GEMS`. */
const ITEM_CLASS_CONTAINER = 1;
const BAG_SUBCLASS_ORDINARY = 0;
const BAG_SUBCLASS_GEMS = 5;
const BAG_FAMILY_GEMS = 0x200;

export interface LiveFrameXmlSocketHost {
  world(): WorldClient | undefined;
  /** Equipment slot 1..19 of the player (`GetInventoryItem*`'s numbering). */
  equipment(slot: number): ItemSlotState | undefined;
  /** Stock container addressing: bag 0..4, slot 1..n. */
  container(bag: number, slot: number): ItemSlotState | undefined;
  cursorSource(): ItemSlotState | undefined;
  setCursor(slot: ItemSlotState | undefined): void;
  clearCursor(): void;
  itemInfo?(entry: number): FrameXmlQuestItemMetadata | undefined;
  itemTexture?(entry: number): string | undefined;
  prefetchItems?(itemIds: readonly number[], spellIds: readonly number[], onChanged: () => void): void;
  /** The gem tables; the page's shared client when absent. */
  enchantments?(): ItemEnchantmentClient | undefined;
  /** The staged gems changed: repaint the bags' lock state (LiveWorldSeam's BAG_UPDATE). */
  locksChanged?(): void;
  now(): number;
}

/** The backpack, then bags 1-4: where a gem to socket can come from. */
function carriedSlots(world: WorldClient | undefined): ItemSlotState[] {
  const inventory = world && typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
  return inventory ? [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)] : [];
}

function carriedOf(slot: ItemSlotState | undefined): FrameXmlSocketCarried | undefined {
  return slot?.item && slot.guid !== 0n
    ? { guid: slot.guid, entry: entryOf(slot.item), count: stackCount(slot), bag: slot.bag, slot: slot.slot }
    : undefined;
}

/**
 * Stock `ITEM_QUALITY_COLORS` hex (UIParent.lua), TrinityCore's `ItemQualityColors`: the realm drops
 * a chat message whose item link has any other colour (Hyperlinks.cpp `IsColorValid`, checked from
 * `ChatStrictLinkChecking.Severity` 0, this realm's setting). ChatLink.ts lightens rare and epic for
 * the native chat's contrast; a stock frame's link can end up in a sent message (shift-click).
 */
const ITEM_QUALITY_HEX: readonly string[] = [
  "ff9d9d9d", "ffffffff", "ff1eff00", "ff0070dd", "ffa335ee", "ffff8000", "ffe6cc80", "ffe6cc80",
];

/**
 * A 3.3.5 item link: `item:entry:enchant:gem1:gem2:gem3:gem4:random:suffix:level`, the gem fields
 * holding socket enchantment ids (`SOCK_ENCHANTMENT_SLOT` 2..4). The fourth gem field is always 0:
 * the core keeps a buckle's prismatic gem in a socket slot, and its link parser refuses anything else
 * there (HyperlinkTags.cpp item `!dummy`), so the socket bonus (slot 5) is not written.
 */
export function frameXmlSocketItemLink(
  entry: number, name: string | undefined, quality: number | undefined,
  enchantments: readonly number[] = [], randomPropertyId = 0, suffix = 0, level = 0,
): string | undefined {
  if (!Number.isSafeInteger(entry) || entry <= 0 || !name) return undefined;
  const color = ITEM_QUALITY_HEX[quality ?? 1] ?? ITEM_QUALITY_HEX[1];
  const at = (slot: number): number => enchantments[slot] ?? 0;
  return `|c${color}|Hitem:${entry}:${at(0)}:${at(2)}:${at(3)}:${at(4)}:0:${randomPropertyId}:${suffix}:${level}|h[${name}]|h|r`;
}

export function createLiveFrameXmlSocket(host: LiveFrameXmlSocketHost): FrameXmlSocketModel {
  const enchantments = (): ItemEnchantmentClient | undefined => {
    if (host.enchantments) return host.enchantments();
    const origin = game.gatewayOrigin;
    return origin ? itemEnchantments(origin) : undefined;
  };
  const template = (entry: number) => {
    const world = host.world();
    const found = world && world.itemTemplates instanceof Map ? world.itemTemplates.get(entry) : undefined;
    return found?.found === true ? found : undefined;
  };
  const name = (entry: number): string | undefined => host.itemInfo?.(entry)?.name || template(entry)?.name || undefined;
  const quality = (entry: number): number | undefined => template(entry)?.quality ?? host.itemInfo?.(entry)?.quality;
  const carried = (guid: bigint): ItemSlotState | undefined =>
    carriedSlots(host.world()).find((slot) => slot.guid === guid && slot.item !== undefined);
  const playerLevel = (): number => {
    const world = host.world();
    const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    return self ? readField(self, "UNIT_FIELD_LEVEL") ?? 0 : 0;
  };
  const model = new FrameXmlSocketModel({
    item: (target) => {
      const slot = target.location === 0 && target.bag === 0 ? host.equipment(target.slot)
        : target.location === 1 ? host.container(target.bag, target.slot) : undefined;
      const object: WorldObjectState | undefined = slot?.item;
      if (!slot || !object || slot.guid === 0n) return undefined;
      const entry = entryOf(object);
      const facts = template(entry);
      return {
        guid: slot.guid, entry, name: name(entry), texture: host.itemTexture?.(entry), quality: quality(entry),
        sockets: facts ? facts.sockets.map((socket) => socket.color) : undefined,
        enchantments: itemEnchantmentIds(object),
        flags: readField(object, "ITEM_FIELD_FLAGS") ?? 0,
      };
    },
    carried: (guid) => carriedOf(carried(guid)),
    carriedAt: (bag, slot) => carriedOf(carriedSlots(host.world()).find((item) => item.bag === bag && item.slot === slot)),
    cursor: () => {
      const source = host.cursorSource();
      // Only a carried item can be socketed: the equipment and bank never hold a gem to place.
      return source && carried(source.guid) ? carriedOf(source) : undefined;
    },
    clearCursor: () => host.clearCursor(),
    pickup: (guid) => { const slot = carried(guid); if (slot) host.setCursor(slot); },
    gem: (entry): FrameXmlSocketGemFacts | undefined => {
      const facts = template(entry);
      const properties = facts && facts.gemProperties > 0 ? enchantments()?.gems.get(facts.gemProperties) : undefined;
      const itemName = name(entry);
      if (!itemName && !facts) return undefined;
      return {
        name: itemName, texture: host.itemTexture?.(entry), quality: quality(entry),
        color: properties?.color, enchantmentId: properties?.enchantmentId,
      };
    },
    enchantmentGem: (enchantmentId) => {
      const gem = enchantments()?.enchantments.get(enchantmentId)?.gemItemId ?? 0;
      return gem > 0 ? gem : undefined;
    },
    itemLink: (entry, slots) => frameXmlSocketItemLink(entry, name(entry), quality(entry), slots, 0, 0, playerLevel()),
    splitOne: (guid) => {
      const world = host.world();
      const stack = carried(guid);
      const inventory = world && playerInventory(world.state);
      if (!world || !stack?.item || !inventory || stackCount(stack) <= 1) return undefined;
      // A free herb/quiver slot cannot take a gem. Ordinary bags and gem bags can (ui/Socketing.ts).
      const gemFamily = template(entryOf(stack.item))?.bagFamily ?? 0;
      const destination = [...inventory.backpack, ...inventory.bags.flatMap((bag) => {
        const container = template(entryOf(bag.bag));
        return container?.itemClass === ITEM_CLASS_CONTAINER && (container.subClass === BAG_SUBCLASS_ORDINARY
          || container.subClass === BAG_SUBCLASS_GEMS && (gemFamily & BAG_FAMILY_GEMS) !== 0) ? bag.slots : [];
      })].find((slot) => slot.guid === 0n);
      if (!destination) return undefined;
      world.splitItem(stack.bag, stack.slot, destination.bag, destination.slot, 1);
      return { bag: destination.bag, slot: destination.slot };
    },
    socketGems: (itemGuid, gems) => {
      const world = host.world();
      if (!world) return false;
      world.socketGems(itemGuid, gems);
      return true;
    },
    prefetch: (entries, onChanged) => {
      const world = host.world();
      for (const entry of entries) world?.itemTemplate?.(entry);
      host.prefetchItems?.(entries, [], onChanged);
      const index = enchantments();
      if (index && !index.ready) void index.load().then(onChanged, () => undefined);
    },
    locksChanged: () => host.locksChanged?.(),
    subscribe: (target) => {
      const events = host.world()?.events;
      if (!events || typeof events.on !== "function") return () => {};
      const off = [
        events.on("SOCKET_GEMS_RESULT", (result) => target.result(result.itemGuid)),
        events.on("INVENTORY_CHANGE_FAILURE", (failure) => {
          if (failure.result !== 0) target.failure(failure.itemGuid, equipErrorText(failure));
        }),
      ];
      return () => { for (const unsubscribe of off) unsubscribe(); };
    },
    now: () => host.now(),
  });
  return model;
}
