/**
 * The offline loot: a level-60 corpse and a two-item group roll over a scripted world that records
 * every command, for `CannedWorldSeam`, the `?loot=` preview and the tests.
 *
 * Names, qualities and display ids are this dataset's rows (data/items.json, ruRU); the icons are
 * those displays' `ItemDisplayInfo.InventoryIcon` (dataset DBC). Bonding, RequiredDisenchantSkill
 * and the slot types are fixture choices that exercise every stock path: money, a stack, three
 * qualities, a bind-on-pickup item on a group `ALLOW_LOOT` slot (LOOT_BIND), a slot held by a
 * running roll (red), and — with seven client slots — LootFrame's three-per-page paging.
 */
import type { GroupState } from "../../world/GroupProtocol.js";
import {
  LOOT_CORPSE, LOOT_SLOT_ALLOW_LOOT, LOOT_SLOT_MASTER, LOOT_SLOT_ROLL_ONGOING, type LootSlot, type LootWindow,
} from "../../world/LootProtocol.js";
import {
  ROLL_FLAG_GREED, ROLL_FLAG_NEED, ROLL_FLAG_PASS, ROLL_NEED, ROLL_NUMBER_ANNOUNCEMENT,
  type LootRollStart, type LootRollVote, type LootRollWon,
} from "../../world/LootRollProtocol.js";
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { FrameXmlLootModel, type FrameXmlLootContext, type FrameXmlLootWorld } from "./FrameXmlLoot.js";

/** The canned looter; any 64-bit player guid serves, votes from it are "the player's own". */
export const FRAMEXML_CANNED_LOOT_PLAYER_GUID = 0x0000000000000001n;
/** The canned corpse, a creature guid (HighGuid 0xF130). */
export const FRAMEXML_CANNED_LOOT_CORPSE_GUID = 0xf130000c3500002an;
/** A second party member, for the master-loot list. */
const PARTY_MEMBER_GUID = 0x0000000000000002n;

type Row = readonly [entry: number, name: string, displayId: number, quality: number, icon: string,
  bonding: number, disenchantSkill: number];

/** data/items.json rows and ItemDisplayInfo icons; bonding/disenchant skill are fixture values. */
const ITEMS: readonly Row[] = [
  [14047, "Руническая ткань", 24897, 1, "INV_Fabric_PurpleFire_01", 0, -1],
  [12662, "Демоническая руна", 22952, 2, "INV_Misc_Rune_04", 0, -1],
  [13446, "Огромный флакон с лечебным зельем", 24152, 1, "INV_Potion_54", 0, -1],
  [14344, "Большой сверкающий осколок", 35403, 3, "INV_Enchant_ShardBrilliantLarge", 0, -1],
  [16921, "Ореол превосходства", 34233, 4, "INV_Helmet_24", 1, 300],
  [17063, "Кольцо Аккурии", 9840, 4, "INV_Jewelry_Ring_15", 1, 300],
  [20725, "Кристалл-источник", 37755, 4, "INV_Enchant_ShardNexusLarge", 0, -1],
];

function template([entry, name, displayInfoId, quality, , bonding, disenchantSkill]: Row): ItemTemplate {
  return {
    entry, found: true, itemClass: 0, subClass: 0, soundOverrideSubclass: 0, name, displayInfoId,
    quality, flags: 0, flags2: 0, buyPrice: 0, sellPrice: 0, inventoryType: 0, allowableClass: 0,
    allowableRace: 0, itemLevel: 0, requiredLevel: 0, requiredSkill: 0, requiredSkillRank: 0,
    requiredSpell: 0, requiredHonorRank: 0, requiredCityRank: 0, requiredReputationFaction: 0,
    requiredReputationRank: 0, maxCount: 0, stackable: 0, containerSlots: 0, stats: [],
    scalingStatDistribution: 0, scalingStatValue: 0, damage: [], resistances: [], delay: 0,
    ammoType: 0, rangedModRange: 0, spells: [], bonding, description: "", pageText: 0,
    languageId: 0, pageMaterial: 0, startQuest: 0, lockId: 0, material: 0, sheath: 0,
    randomProperty: 0, randomSuffix: 0, block: 0, itemSet: 0, maxDurability: 0, area: 0, map: 0,
    bagFamily: 0, totemCategory: 0, sockets: [], socketBonus: 0, gemProperties: 0,
    // Unsigned, as the query parser hands it over: -1 ("cannot be disenchanted") is 0xFFFFFFFF.
    requiredDisenchantSkill: disenchantSkill >>> 0, armorDamageModifier: 0, duration: 0,
    itemLimitCategory: 0, holidayId: 0,
  };
}

const ICONS = new Map(ITEMS.map((row) => [row[2], `Interface\\Icons\\${row[4]}`]));

function slot(index: number, itemId: number, count: number, slotType = LOOT_SLOT_ALLOW_LOOT): LootSlot {
  const displayId = ITEMS.find((row) => row[0] === itemId)?.[2] ?? 0;
  return { index, itemId, count, displayId, randomSuffix: 0, randomPropertyId: 0, slotType, taken: false };
}

/** A command the canned world received, in order; tests assert the wire-level intent. */
export type FrameXmlCannedLootCall =
  | { readonly kind: "take"; readonly slot: number }
  | { readonly kind: "money" | "release" }
  | { readonly kind: "roll"; readonly itemGuid: bigint; readonly rollType: number }
  | { readonly kind: "give"; readonly slot: number; readonly target: bigint };

interface CannedRoll {
  start: LootRollStart;
  startedAt: number;
  votes: LootRollVote[];
  won?: LootRollWon | undefined;
  passed?: boolean | undefined;
}

/**
 * `WorldClient`'s loot fields and commands. With `answer` on (the default), each command also plays
 * the server's reply at once — SMSG_LOOT_REMOVED, SMSG_LOOT_CLEAR_MONEY, the release, the vote echo —
 * so the preview behaves; a test turns it off to see exactly what was sent.
 */
export class FrameXmlCannedLootWorld implements FrameXmlLootWorld {
  readonly calls: FrameXmlCannedLootCall[] = [];
  answer = true;
  loot: LootWindow | undefined;
  readonly lootRolls = new Map<bigint, CannedRoll>();
  masterLootCandidates: bigint[] = [];
  group: GroupState | undefined;
  readonly state = { selfGuid: FRAMEXML_CANNED_LOOT_PLAYER_GUID as bigint | undefined, objects: new Map<bigint, WorldObjectState>() };
  readonly itemTemplates = new Map<number, ItemTemplate>(ITEMS.map((row) => [row[0], template(row)]));
  /** Entries asked for through `itemTemplate`, as the real client would query them. */
  readonly asked: number[] = [];
  readonly #names = new Map<bigint, string>([[FRAMEXML_CANNED_LOOT_PLAYER_GUID, "Тестовый"], [PARTY_MEMBER_GUID, "Бета"]]);
  #nextRollGuid = 0x4000000000000101n;

  itemTemplate(entry: number): ItemTemplate | undefined {
    const known = this.itemTemplates.get(entry);
    if (!known) this.asked.push(entry);
    return known;
  }

  displayName(guid: bigint): string {
    return this.#names.get(guid) ?? "";
  }

  takeLootSlot(index: number): void {
    this.calls.push({ kind: "take", slot: index });
    const taken = this.loot?.slots.find((candidate) => candidate.index === index);
    if (this.answer && taken) taken.taken = true;
  }

  takeLootMoney(): void {
    this.calls.push({ kind: "money" });
    if (this.answer && this.loot) this.loot.gold = 0;
  }

  closeLoot(): void {
    this.calls.push({ kind: "release" });
    this.loot = undefined;
  }

  rollForLoot(itemGuid: bigint, rollType: number): void {
    this.calls.push({ kind: "roll", itemGuid, rollType });
    const roll = this.lootRolls.get(itemGuid);
    if (!this.answer || !roll) return;
    // SMSG_LOOT_ROLL to every roller, the voter included: need is announced as number 0, the
    // rest as 128 (LootRollProtocol.ts:25-29).
    roll.votes.push({
      itemGuid: 0n, itemSlot: roll.start.itemSlot, playerGuid: FRAMEXML_CANNED_LOOT_PLAYER_GUID,
      itemId: roll.start.itemId, randomSuffix: 0, randomPropertyId: 0,
      rollNumber: rollType === ROLL_NEED ? 0 : ROLL_NUMBER_ANNOUNCEMENT, rollType, autoPass: false,
    });
  }

  giveMasterLoot(slotIndex: number, target: bigint): void {
    this.calls.push({ kind: "give", slot: slotIndex, target });
    const given = this.loot?.slots.find((candidate) => candidate.index === slotIndex);
    if (this.answer && given) given.taken = true;
  }

  // ---- scripted server packets ----------------------------------------------------------------

  /**
   * SMSG_LOOT_RESPONSE for the canned corpse: 1 gold 23 silver 45 copper and six items, the ring
   * held by its running roll. `master` makes the player the master looter of the two rares
   * (LOOT_SLOT_TYPE_MASTER) and sends SMSG_LOOT_MASTER_LIST.
   */
  openCorpse(options: { readonly master?: boolean } = {}): LootWindow {
    const master = options.master === true;
    this.loot = {
      guid: FRAMEXML_CANNED_LOOT_CORPSE_GUID, lootType: LOOT_CORPSE, gold: 12345,
      slots: [
        slot(0, 14047, 2),
        slot(1, 12662, 1),
        slot(2, 13446, 3),
        slot(3, 14344, 1, master ? LOOT_SLOT_MASTER : LOOT_SLOT_ALLOW_LOOT),
        slot(4, 16921, 1, master ? LOOT_SLOT_MASTER : LOOT_SLOT_ALLOW_LOOT),
        slot(5, 17063, 1, LOOT_SLOT_ROLL_ONGOING),
      ],
    };
    this.masterLootCandidates = master ? [FRAMEXML_CANNED_LOOT_PLAYER_GUID, PARTY_MEMBER_GUID] : [];
    return this.loot;
  }

  /** SMSG_LOOT_RELEASE_RESPONSE, as when the server lets the corpse go. */
  releaseCorpse(): void {
    this.loot = undefined;
  }

  /**
   * Two SMSG_LOOT_START_ROLLs from the same boss: the ring (bind on pickup) and the crystal, one
   * minute each, need/greed/pass offered — no enchanter in the canned party, so no disenchant. Each
   * call mints fresh roll guids, as the server does for every roll (Group.cpp's itemGUID).
   */
  startRolls(now = Date.now()): readonly bigint[] {
    const guids = [this.#nextRollGuid, this.#nextRollGuid + 1n];
    this.#nextRollGuid += 2n;
    const mask = ROLL_FLAG_PASS | ROLL_FLAG_NEED | ROLL_FLAG_GREED;
    const items: readonly (readonly [itemId: number, itemSlot: number])[] = [[17063, 5], [20725, 6]];
    items.forEach(([itemId, itemSlot], index) => {
      const itemGuid = guids[index]!;
      this.lootRolls.set(itemGuid, {
        start: {
          itemGuid, mapId: 409, itemSlot, itemId, randomSuffix: 0, randomPropertyId: 0,
          count: 1, countdown: 60000, voteMask: mask,
        },
        startedAt: now, votes: [],
      });
    });
    return guids;
  }

  /** SMSG_LOOT_ROLL_WON for a roll, which takes its frame down for everyone. */
  winRoll(itemGuid: bigint, winner = PARTY_MEMBER_GUID): void {
    const roll = this.lootRolls.get(itemGuid);
    if (!roll) return;
    roll.won = {
      itemGuid: 0n, itemSlot: roll.start.itemSlot, itemId: roll.start.itemId, randomSuffix: 0,
      randomPropertyId: 0, winnerGuid: winner, rollNumber: 87, rollType: ROLL_NEED,
    };
  }
}

/** The display-id pictures the canned corpse's slots and rolls resolve to. */
export function frameXmlCannedLootIcon(displayId: number): string | undefined {
  return ICONS.get(displayId);
}

export function createCannedFrameXmlLoot(
  context: Omit<FrameXmlLootContext, "world" | "autoLootDefault"> & { readonly autoLootDefault?: () => boolean },
): { readonly model: FrameXmlLootModel; readonly world: FrameXmlCannedLootWorld } {
  const world = new FrameXmlCannedLootWorld();
  const model = new FrameXmlLootModel({
    ...context,
    world: () => world,
    displayIcon: context.displayIcon ?? frameXmlCannedLootIcon,
    autoLootDefault: context.autoLootDefault ?? (() => false),
  });
  return { model, world };
}
