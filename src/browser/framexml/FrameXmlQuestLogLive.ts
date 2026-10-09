/**
 * The live world's answers for the quest log model (FrameXmlQuestLog.ts), kept out of the hot
 * LiveWorldSeam: the daily-quest words, the completed-quest list, the carried special item and its
 * use, and the header/tag names.
 */
import type { QuestLogEntry } from "../../world/Fields.js";
import type { WorldObjectState, WorldState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { entryOf, playerInventory } from "../Inventory.js";
import { itemUseSpellId, requestInventoryItemUse } from "../game/GroundTarget.js";
import {
  FRAMEXML_DAILY_QUEST_WORDS, FrameXmlQuestLogModel,
  type FrameXmlQuestLogNames, type FrameXmlQuestLogTemplate, type FrameXmlQuestSpecialItem,
} from "./FrameXmlQuestLog.js";
import { questGreenRange } from "./FrameXmlWorldSeam.js";

const DAILY_QUESTS_OFFSET = UPDATE_FIELDS.PLAYER_FIELD_DAILY_QUESTS_1.offset;
const SPELL_CHARGES_OFFSET = UPDATE_FIELDS.ITEM_FIELD_SPELL_CHARGES.offset;

/** The WorldClient surface the quest log reads; WorldClient satisfies it structurally. */
export interface FrameXmlQuestLogLiveWorld {
  readonly state: WorldState;
  readonly completedQuests?: ReadonlySet<number>;
  readonly events?: { on(name: "QUESTS_COMPLETED", listener: () => void): () => void };
  queryQuest?(questId: number): void;
  requestCompletedQuests?(): void;
  itemTemplate?(entry: number): { readonly spells?: ReadonlyArray<{ spellId: number; trigger: number }> } | undefined;
  useItem(bag: number, slot: number, itemGuid: bigint): void;
}

export interface FrameXmlQuestLogLiveOptions {
  world(): FrameXmlQuestLogLiveWorld | undefined;
  rows(): readonly QuestLogEntry[];
  template(questId: number): FrameXmlQuestLogTemplate | undefined;
  playerLevel(): number | undefined;
  areaName(areaId: number): string | undefined;
  names?: FrameXmlQuestLogNames | undefined;
  /** GetItemInfo's link for an entry (the seam's `itemInfo`). */
  itemLink(entry: number): string | undefined;
  itemTexture(entry: number): string | undefined;
  /** `GetItemCooldown(entry)` (the seam's `itemCooldown`). */
  itemCooldown(entry: number): readonly [number, number, number];
}

interface LiveSpecialItem extends FrameXmlQuestSpecialItem {
  readonly guid: bigint;
  readonly entry: number;
  readonly object: WorldObjectState;
}

function self(world: FrameXmlQuestLogLiveWorld): WorldObjectState | undefined {
  const guid = world.state.selfGuid;
  return guid === undefined ? undefined : world.state.objects.get(guid);
}

/** The item's charges for its use spell: ITEM_FIELD_SPELL_CHARGES of that spell's slot, unsigned. */
function useSpellCharges(object: WorldObjectState, spells: ReadonlyArray<{ spellId: number; trigger: number }> | undefined,
  spellId: number): number {
  const index = spells?.findIndex((spell) => spell.spellId === spellId) ?? -1;
  if (index < 0) return 0;
  const raw = object.fields.get(SPELL_CHARGES_OFFSET + index);
  return raw === undefined ? 0 : Math.abs(raw | 0);
}

export function createLiveFrameXmlQuestLog(options: FrameXmlQuestLogLiveOptions): FrameXmlQuestLogModel {
  return new FrameXmlQuestLogModel({
    rows: options.rows,
    template: options.template,
    requestTemplate: (questId) => options.world()?.queryQuest?.(questId),
    playerLevel: options.playerLevel,
    greenRange: () => questGreenRange(options.playerLevel()),
    areaName: options.areaName,
    names: options.names,
    dailyQuests: () => {
      const world = options.world();
      const player = world ? self(world) : undefined;
      if (!player) return undefined;
      const words: number[] = [];
      for (let index = 0; index < FRAMEXML_DAILY_QUEST_WORDS; index++) {
        words.push(player.fields.get(DAILY_QUESTS_OFFSET + index) ?? 0);
      }
      return words;
    },
    completedQuests: () => options.world()?.completedQuests,
    requestCompletedQuests: () => options.world()?.requestCompletedQuests?.(),
    onCompletedQuests: (listener) => options.world()?.events?.on("QUESTS_COMPLETED", listener),
    findItem: (entries) => {
      const world = options.world();
      const inventory = world ? playerInventory(world.state) : undefined;
      if (!world || !inventory) return undefined;
      const slots = [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)];
      for (const entry of entries) {
        const template = world.itemTemplate?.(entry);
        const spellId = itemUseSpellId(template);
        if (spellId === undefined) continue;
        const held = slots.find((slot) => slot.item !== undefined && slot.guid !== 0n && entryOf(slot.item) === entry);
        if (!held?.item) continue;
        const link = options.itemLink(entry);
        const texture = options.itemTexture(entry);
        if (!link || !texture) continue;
        const item: LiveSpecialItem = {
          bag: held.bag, slot: held.slot, guid: held.guid, entry, object: held.item, link, texture,
          charges: useSpellCharges(held.item, template?.spells, spellId),
        };
        return item;
      }
      return undefined;
    },
    itemCooldown: (item) => options.itemCooldown((item as LiveSpecialItem).entry),
    useItem: (item) => {
      const world = options.world();
      const held = item as LiveSpecialItem;
      if (!world) return;
      requestInventoryItemUse({ bag: held.bag, slot: held.slot, guid: held.guid, item: held.object },
        () => world.useItem(held.bag, held.slot, held.guid));
    },
  });
}
