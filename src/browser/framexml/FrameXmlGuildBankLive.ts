/**
 * The live guild bank model's host: LiveWorldSeam's one GUID-checked bag cursor and the item caches,
 * shaped as FrameXmlGuildBankContext. A C-API read never starts a fetch: templates and metadata are
 * read from their caches, and `prefetchItems` (outside the read) asks for the rest.
 */
import type { WorldClient } from "../../world/WorldClient.js";
import { entryOf, type ItemSlotState } from "../Inventory.js";
import { FrameXmlGuildBankModel } from "./FrameXmlGuildBank.js";
import type { FrameXmlQuestItemMetadata } from "./FrameXmlWorldSeam.js";

export interface LiveFrameXmlGuildBankHost {
  world(): WorldClient | undefined;
  itemInfo?(entry: number): FrameXmlQuestItemMetadata | undefined;
  itemTexture?(entry: number): string | undefined;
  prefetchItems?(itemIds: readonly number[], spellIds: readonly number[], onChanged: () => void): void;
  /** The bag item on the shared cursor (LiveWorldSeam's GUID-checked source). */
  cursorSource(): ItemSlotState | undefined;
  /** LiveWorldSeam.clearCursor: the bag item and a held macro. */
  clearCursor(): void;
  playerLevel(): number;
  macroItemIcon?(index: number): string | undefined;
}

export function createLiveFrameXmlGuildBank(host: LiveFrameXmlGuildBankHost): FrameXmlGuildBankModel {
  return new FrameXmlGuildBankModel({
    world: () => host.world(),
    item: (entry) => {
      const world = host.world();
      const template = world && world.itemTemplates instanceof Map ? world.itemTemplates.get(entry) : undefined;
      const found = template?.found === true ? template : undefined;
      const metadata = host.itemInfo?.(entry);
      const name = metadata?.name || found?.name;
      if (!name) return undefined;
      return { name, texture: host.itemTexture?.(entry) ?? metadata?.texture, quality: found?.quality ?? metadata?.quality };
    },
    playerLevel: () => host.playerLevel(),
    cursorItem: () => {
      const source = host.cursorSource();
      return source?.item ? { entry: entryOf(source.item), bag: source.bag, slot: source.slot } : undefined;
    },
    clearCursor: () => host.clearCursor(),
    // The page shows the item cursor while a vault stack is held, as it does for a bag item.
    cursorChanged: (held) => {
      if (typeof document !== "undefined") document.body?.classList?.toggle("framexml-item-cursor", held);
    },
    prefetchItems: (entries, onChanged) => {
      // Templates carry the quality the links need; the metadata client's load asks the server too.
      const world = host.world();
      for (const entry of entries) world?.itemTemplate?.(entry);
      host.prefetchItems?.(entries, [], onChanged);
    },
    macroItemIcon: (index) => host.macroItemIcon?.(index),
  });
}
