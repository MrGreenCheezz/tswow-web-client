/**
 * The offline professions: a canned character's Blacksmithing and Enchanting for `CannedWorldSeam`,
 * its tests and `framexml.html?tradeskill=…`.
 *
 * Every value is this dataset's, measured: recipe names, reagents, made items, cast times and
 * descriptions from `/dbc/spells?v=13`; the difficulty bands from `/dbc/talents`' SkillLineAbility
 * rows; item names from `/data/items`; icons from ItemDisplayInfo.InventoryIcon; class, subclass,
 * slot and required level from the TDB 335.24081 `item_template`; the headings from
 * `/dbc/item-subclasses`. Commands record; a test drives the bags and the queue directly.
 */
import type { SpellMetadata } from "../SpellMetadata.js";
import type { SpellSkillAbilityInfo } from "../../gateway/TalentMetadata.js";
import {
  FrameXmlTradeSkillModel,
  type FrameXmlTradeSkillCraft,
  type FrameXmlTradeSkillItem,
  type FrameXmlTradeSkillItemClass,
  type FrameXmlTradeSkillLine,
  type FrameXmlTradeSkillRecipeSource,
  type FrameXmlTradeSkillSource,
} from "./FrameXmlTradeSkill.js";

export const FRAMEXML_CANNED_BLACKSMITHING = 164;
export const FRAMEXML_CANNED_ENCHANTING = 333;
/** Carried equipment an enchant can go on: «Медные наручи» (wrist) and «Сапоги книжника» (feet). */
export const FRAMEXML_CANNED_BRACERS_GUID = 0x4000_1001n;
export const FRAMEXML_CANNED_BOOTS_GUID = 0x4000_1002n;

const icon = (name: string): string => `Interface\\Icons\\${name}`;

/** `/data/items` names, ItemDisplayInfo icons and TDB class/subclass/slot/level, per entry. */
const ITEMS: ReadonlyMap<number, FrameXmlTradeSkillItem & FrameXmlTradeSkillItemClass> = new Map([
  [2862, { name: "Грубое точило", texture: icon("INV_Stone_SharpeningStone_01"), quality: 1, itemClass: 0, subClass: 8, inventoryType: 0, requiredLevel: 1 }],
  [3239, { name: "Грубое грузило", texture: icon("INV_Stone_WeightStone_01"), quality: 1, itemClass: 0, subClass: 8, inventoryType: 0, requiredLevel: 1 }],
  [3470, { name: "Грубый шлифовальный камень", texture: icon("INV_Stone_GrindingStone_01"), quality: 1, itemClass: 7, subClass: 7, inventoryType: 0, requiredLevel: 0 }],
  [2853, { name: "Медные наручи", texture: icon("INV_Bracer_03"), quality: 1, itemClass: 4, subClass: 3, inventoryType: 9, requiredLevel: 2 }],
  [2852, { name: "Медные плетеные штаны", texture: icon("INV_Pants_03"), quality: 1, itemClass: 4, subClass: 3, inventoryType: 7, requiredLevel: 4 }],
  [2844, { name: "Медная палица", texture: icon("INV_Mace_01"), quality: 1, itemClass: 2, subClass: 4, inventoryType: 21, requiredLevel: 4 }],
  [2845, { name: "Медный топор", texture: icon("INV_Axe_23"), quality: 1, itemClass: 2, subClass: 0, inventoryType: 21, requiredLevel: 4 }],
  [2847, { name: "Медный короткий меч", texture: icon("INV_Sword_26"), quality: 1, itemClass: 2, subClass: 7, inventoryType: 21, requiredLevel: 4 }],
  [3488, { name: "Медный боевой топор", texture: icon("INV_ThrowingAxe_02"), quality: 2, itemClass: 2, subClass: 1, inventoryType: 17, requiredLevel: 8 }],
  [6214, { name: "Тяжелая медная кувалда", texture: icon("INV_Hammer_18"), quality: 2, itemClass: 2, subClass: 5, inventoryType: 17, requiredLevel: 11 }],
  [7955, { name: "Медный клеймор", texture: icon("INV_Sword_21"), quality: 1, itemClass: 2, subClass: 8, inventoryType: 17, requiredLevel: 6 }],
  [2854, { name: "Рунические медные наручи", texture: icon("INV_Bracer_03"), quality: 2, itemClass: 4, subClass: 3, inventoryType: 9, requiredLevel: 14 }],
  [2863, { name: "Зернистое точило", texture: icon("INV_Stone_SharpeningStone_02"), quality: 1, itemClass: 0, subClass: 8, inventoryType: 0, requiredLevel: 5 }],
  [3240, { name: "Зернистое грузило", texture: icon("INV_Stone_WeightStone_02"), quality: 1, itemClass: 0, subClass: 8, inventoryType: 0, requiredLevel: 5 }],
  [3478, { name: "Зернистый шлифовальный камень", texture: icon("INV_Stone_GrindingStone_02"), quality: 1, itemClass: 7, subClass: 7, inventoryType: 0, requiredLevel: 0 }],
  [2835, { name: "Грубый камень", texture: icon("INV_Stone_06"), quality: 1, itemClass: 7, subClass: 7, inventoryType: 0, requiredLevel: 0 }],
  [2840, { name: "Медный слиток", texture: icon("INV_Ingot_02"), quality: 1, itemClass: 7, subClass: 7, inventoryType: 0, requiredLevel: 0 }],
  [2589, { name: "Льняной материал", texture: icon("INV_Fabric_Linen_01"), quality: 1, itemClass: 7, subClass: 5, inventoryType: 0, requiredLevel: 0 }],
  [2880, { name: "Слабый плавень", texture: icon("INV_Misc_Ammo_Gunpowder_02"), quality: 1, itemClass: 7, subClass: 11, inventoryType: 0, requiredLevel: 0 }],
  [774, { name: "Малахит", texture: icon("INV_Misc_Gem_Emerald_03"), quality: 2, itemClass: 3, subClass: 7, inventoryType: 0, requiredLevel: 0 }],
  [2318, { name: "Тонкая кожа", texture: icon("INV_Misc_LeatherScrap_03"), quality: 1, itemClass: 7, subClass: 6, inventoryType: 0, requiredLevel: 0 }],
  [2836, { name: "Необработанный камень", texture: icon("INV_Stone_09"), quality: 1, itemClass: 7, subClass: 7, inventoryType: 0, requiredLevel: 0 }],
  [2592, { name: "Шерсть", texture: icon("INV_Fabric_Wool_01"), quality: 1, itemClass: 7, subClass: 5, inventoryType: 0, requiredLevel: 0 }],
  [10940, { name: "Странная пыль", texture: icon("INV_Enchant_DustStrange"), quality: 1, itemClass: 7, subClass: 12, inventoryType: 0, requiredLevel: 0 }],
  [10938, { name: "Простая магическая субстанция", texture: icon("INV_Enchant_EssenceMagicSmall"), quality: 2, itemClass: 7, subClass: 12, inventoryType: 0, requiredLevel: 0 }],
  [4470, { name: "Простая древесина", texture: icon("INV_TradeskillItem_01"), quality: 1, itemClass: 7, subClass: 11, inventoryType: 0, requiredLevel: 0 }],
  [6217, { name: "Медный жезл", texture: icon("INV_Misc_Flute_01"), quality: 1, itemClass: 7, subClass: 12, inventoryType: 0, requiredLevel: 0 }],
  [6218, { name: "Рунический медный жезл", texture: icon("INV_Staff_Goldfeathered_01"), quality: 1, itemClass: 7, subClass: 12, inventoryType: 0, requiredLevel: 1 }],
  [11287, { name: "Малый магический жезл", texture: icon("INV_Staff_02"), quality: 2, itemClass: 2, subClass: 19, inventoryType: 26, requiredLevel: 5 }],
  [6612, { name: "Сапоги книжника", texture: icon("INV_Boots_05"), quality: 2, itemClass: 4, subClass: 1, inventoryType: 8, requiredLevel: 23 }],
  [5956, { name: "Кузнечный молот", texture: icon("INV_Hammer_20"), quality: 1, itemClass: 2, subClass: 14, inventoryType: 21, requiredLevel: 1 }],
]);

/** `/dbc/item-subclasses` DisplayName for the classes the fixture makes. */
const SUBCLASSES: ReadonlyMap<string, string> = new Map([
  ["0:8", "Другое"], ["2:0", "Топор"], ["2:1", "Топор"], ["2:4", "Дробящее"], ["2:5", "Дробящее"],
  ["2:7", "Меч"], ["2:8", "Меч"], ["2:19", "Жезл"], ["3:7", "Простые"], ["4:1", "Ткань"], ["4:3", "Кольчуга"],
  ["7:5", "Ткань"], ["7:6", "Кожа"], ["7:7", "Металл и камень"], ["7:11", "Другое"], ["7:12", "Наложение чар"],
]);

interface CannedRecipe {
  readonly id: number;
  readonly name: string;
  readonly skill: number;
  readonly castTime: number;
  readonly iconPath: string;
  /** Effect 24 with its item, or 53 (an enchant) with the slot mask it goes on. */
  readonly made?: number;
  readonly enchant?: { readonly invTypes: number; readonly subclassMask: number };
  readonly reagents: readonly (readonly [itemId: number, count: number])[];
  readonly bands: readonly [low: number, high: number];
  readonly description?: string;
}

const SEAL_OF_KINGS = icon("Spell_Shadow_SealOfKings");
const GREATER_HEAL = icon("Spell_Holy_GreaterHeal");

const RECIPES: readonly CannedRecipe[] = [
  { id: 2660, name: "Грубое точило", skill: 164, castTime: 1500, iconPath: SEAL_OF_KINGS, made: 2862, reagents: [[2835, 1]], bands: [15, 55] },
  { id: 3115, name: "Грубое грузило", skill: 164, castTime: 1500, iconPath: SEAL_OF_KINGS, made: 3239, reagents: [[2835, 1], [2589, 1]], bands: [15, 55] },
  { id: 3320, name: "Грубый шлифовальный камень", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 3470, reagents: [[2835, 2]], bands: [45, 85] },
  { id: 2663, name: "Медные наручи", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 2853, reagents: [[2840, 2]], bands: [20, 60] },
  { id: 2662, name: "Медные плетеные штаны", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 2852, reagents: [[2840, 4]], bands: [50, 90] },
  { id: 2737, name: "Медная палица", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 2844, reagents: [[2840, 6], [2880, 1], [2589, 2]], bands: [55, 95] },
  { id: 2738, name: "Медный топор", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 2845, reagents: [[2840, 6], [2880, 1], [2589, 2]], bands: [60, 100] },
  { id: 2739, name: "Медный короткий меч", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 2847, reagents: [[2840, 6], [2880, 1], [2589, 2]], bands: [65, 105] },
  { id: 3293, name: "Медный боевой топор", skill: 164, castTime: 3000, iconPath: SEAL_OF_KINGS, made: 3488, reagents: [[2840, 12], [2880, 2], [774, 2], [3470, 2], [2318, 2]], bands: [75, 115] },
  { id: 7408, name: "Тяжелая медная кувалда", skill: 164, castTime: 3000, iconPath: SEAL_OF_KINGS, made: 6214, reagents: [[2840, 12], [2880, 2], [2318, 2]], bands: [105, 145] },
  { id: 9983, name: "Медный клеймор", skill: 164, castTime: 3000, iconPath: SEAL_OF_KINGS, made: 7955, reagents: [[2840, 10], [2880, 2], [3470, 1], [2318, 1]], bands: [70, 110] },
  { id: 2664, name: "Рунические медные наручи", skill: 164, castTime: 3000, iconPath: SEAL_OF_KINGS, made: 2854, reagents: [[2840, 10], [3470, 3]], bands: [115, 140] },
  { id: 2665, name: "Зернистое точило", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 2863, reagents: [[2836, 1]], bands: [65, 80] },
  { id: 3116, name: "Зернистое грузило", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 3240, reagents: [[2836, 1], [2592, 1]], bands: [65, 80] },
  { id: 3326, name: "Зернистый шлифовальный камень", skill: 164, castTime: 2000, iconPath: SEAL_OF_KINGS, made: 3478, reagents: [[2836, 2]], bands: [75, 100] },
  {
    id: 7418, name: "Чары для наручей - здоровье I", skill: 333, castTime: 5000, iconPath: GREATER_HEAL,
    enchant: { invTypes: 512, subclassMask: 31 }, reagents: [[10940, 1]], bands: [70, 110],
    description: "Обучение наложению на наручи чар, повышающих максимальный запас здоровья на 5 ед.",
  },
  {
    id: 7420, name: "Чары для нагрудника - здоровье I", skill: 333, castTime: 5000, iconPath: GREATER_HEAL,
    enchant: { invTypes: 1048608, subclassMask: 31 }, reagents: [[10940, 1]], bands: [70, 110],
    description: "Наложение на нагрудник чар, увеличивающих максимальный запас здоровья на 5 ед.",
  },
  {
    id: 7428, name: "Чары для наручей - отражение I", skill: 333, castTime: 5000, iconPath: GREATER_HEAL,
    enchant: { invTypes: 512, subclassMask: 31 }, reagents: [[10938, 1], [10940, 1]], bands: [80, 120],
    description: "Наложение на наручи чар, повышающих рейтинг защиты на 2.",
  },
  {
    id: 14293, name: "Малый магический жезл", skill: 333, castTime: 10000, iconPath: icon("INV_Staff_02"),
    made: 11287, reagents: [[4470, 1], [10938, 1]], bands: [75, 115], description: "Создание малого магического жезла.",
  },
  {
    id: 7421, name: "Рунический медный жезл", skill: 333, castTime: 10000, iconPath: icon("INV_Staff_Goldfeathered_01"),
    made: 6218, reagents: [[6217, 1], [10940, 1], [10938, 1]], bands: [5, 10],
  },
];

/** A full `/dbc/spells` row for one canned recipe; the columns a recipe does not use are zero. */
function recipeSpell(recipe: CannedRecipe): SpellMetadata {
  const enchant = recipe.enchant;
  return {
    id: recipe.id, name: recipe.name, rank: "", description: recipe.description ?? "", iconId: 0,
    iconPath: recipe.iconPath, passive: false, hidden: false, tradeSkill: true,
    effects: [enchant ? 53 : 24, 0, 0],
    effectItemType: [recipe.made ?? 0, 0, 0],
    reagents: recipe.reagents.map(([itemId, count]) => ({ itemId, count })),
    tools: [], requiredToolCategories: [], requiredToolNames: [],
    equippedItemClass: enchant ? 4 : -1, equippedItemSubclass: enchant?.subclassMask ?? 0,
    equippedItemInvTypes: enchant?.invTypes ?? 0,
    autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0,
    recoveryTime: 0, categoryRecoveryTime: 0, startRecoveryTime: 0, cooldownStartedOnEvent: false,
    spellLevel: 0, spellClassSet: 0, spellClassMask: [0, 0, 0], schoolMask: 1,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: recipe.castTime,
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0],
    effectBasePoints: [enchant ? -1 : 0, 0, 0], effectDieSides: [1, 0, 0],
    effectPeriod: [0, 0, 0], effectChainTargets: [0, 0, 0], effectRadius: [0, 0, 0],
    duration: 0, maxDuration: 0, procChance: 0, descriptionVariablesId: 0,
  };
}

function ability(recipe: CannedRecipe): SpellSkillAbilityInfo {
  return {
    skillLine: recipe.skill, raceMask: 0, classMask: 0, excludeRace: 0, excludeClass: 0, minSkillLineRank: 1,
    supercededBySpell: 0, acquireMethod: 0, trivialSkillLineRankLow: recipe.bands[0],
    trivialSkillLineRankHigh: recipe.bands[1], characterPoints: [0, 0],
  };
}

export type FrameXmlCannedTradeSkillCall =
  | { readonly kind: "craft"; readonly spellId: number; readonly count: number }
  | { readonly kind: "item"; readonly spellId: number; readonly guid: bigint }
  | { readonly kind: "trade"; readonly spellId: number }
  | { readonly kind: "stop" };

/** The canned character's side of the trade skill window, and a recording craft queue. */
export class FrameXmlCannedTradeSkillWorld {
  readonly calls: FrameXmlCannedTradeSkillCall[] = [];
  readonly lines = new Map<number, FrameXmlTradeSkillLine>([
    [164, { skillId: 164, name: "Кузнечное дело", value: 110, max: 150, modifier: 0 }],
    [333, { skillId: 333, name: "Наложение чар", value: 95, max: 150, modifier: 0 }],
  ]);
  readonly bags = new Map<number, number>([
    [2840, 14], [2835, 9], [2589, 6], [2880, 3], [2318, 2], [2836, 1], [10940, 4], [10938, 1], [4470, 2],
  ]);
  readonly equipment = new Map<bigint, number>([
    [FRAMEXML_CANNED_BRACERS_GUID, 2853], [FRAMEXML_CANNED_BOOTS_GUID, 6612],
  ]);
  readonly cooldowns = new Map<number, number>();
  /** TotemCategory ids the carried items answer (none in the fixture's bags). */
  readonly toolCategorySet = new Set<number>();
  /** Entries whose reply has not "arrived": item() and itemClass() answer nothing for them. */
  readonly unanswered = new Set<number>();
  readonly recipesBySkill: ReadonlyMap<number, readonly FrameXmlTradeSkillRecipeSource[]>;
  /** The queue: casts still to go including the one in flight. */
  queued = 0;
  /** Enchantments already on carried items, by guid: [old name, new name] REPLACE_ENCHANT asks with. */
  readonly replaceNames = new Map<bigint, readonly [string, string]>();
  /** Carried items with a refund record and time left: an enchant on one asks END_REFUND (2.10). */
  readonly refundItems = new Set<bigint>();
  /** The trader's seventh-slot item's enchantment, as TRADE_REPLACE_ENCHANT names it; none by default. */
  tradeReplaceNames: readonly [string, string] | undefined;
  #token = {};

  constructor() {
    const grouped = new Map<number, FrameXmlTradeSkillRecipeSource[]>();
    for (const recipe of RECIPES) {
      const list = grouped.get(recipe.skill) ?? [];
      list.push({ spell: recipeSpell(recipe), ability: ability(recipe) });
      grouped.set(recipe.skill, list);
    }
    this.recipesBySkill = grouped;
  }

  /** A new world (a relog): the open window must close. */
  replaceWorld(): void { this.#token = {}; }

  line(skillId: number): FrameXmlTradeSkillLine | undefined { return this.lines.get(skillId); }
  recipes(skillId: number): readonly FrameXmlTradeSkillRecipeSource[] { return this.recipesBySkill.get(skillId) ?? []; }
  carried(): ReadonlyMap<number, number> { return this.bags; }
  toolCategories(): ReadonlySet<number> { return this.toolCategorySet; }
  cooldown(spellId: number): number { return this.cooldowns.get(spellId) ?? 0; }
  item(entry: number): FrameXmlTradeSkillItem | undefined {
    const item = this.unanswered.has(entry) ? undefined : ITEMS.get(entry);
    return item ? { name: item.name, texture: item.texture, quality: item.quality } : undefined;
  }
  itemClass(entry: number): FrameXmlTradeSkillItemClass | undefined {
    return this.unanswered.has(entry) ? undefined : ITEMS.get(entry);
  }
  subclassName(itemClass: number, subClass: number): string | undefined {
    return SUBCLASSES.get(`${itemClass}:${subClass}`);
  }
  prefetch(entries: readonly number[], onChanged: () => void): void {
    // The offline replies land on the next microtask, as a cached HTTP answer would.
    if (!entries.some((entry) => this.unanswered.has(entry))) return;
    void Promise.resolve().then(() => {
      for (const entry of entries) this.unanswered.delete(entry);
      onChanged();
    });
  }
  carriedItem(guid: bigint): FrameXmlTradeSkillItemClass | undefined {
    const entry = this.equipment.get(guid);
    return entry === undefined ? undefined : ITEMS.get(entry);
  }
  token(): unknown { return this.#token; }

  craftCall(spellId: number, count: number): boolean {
    this.calls.push({ kind: "craft", spellId, count });
    this.queued = count;
    return true;
  }
  castOnItem(spellId: number, guid: bigint): boolean {
    this.calls.push({ kind: "item", spellId, guid });
    this.queued = 1;
    return true;
  }
  castOnTradeSlot(spellId: number): boolean {
    this.calls.push({ kind: "trade", spellId });
    this.queued = 1;
    return true;
  }
  stop(): void {
    this.calls.push({ kind: "stop" });
    // The cast in flight finishes; only what was queued behind it goes.
    this.queued = Math.min(this.queued, 1);
  }
  remaining(): number { return this.queued; }
  /** One cast finished: the queue moves to the next, as the native STOP/GO edge does. */
  finishCast(): void { this.queued = Math.max(0, this.queued - 1); }
}

/** The canned model over the canned world. */
export function createCannedFrameXmlTradeSkill(): {
  readonly model: FrameXmlTradeSkillModel;
  readonly world: FrameXmlCannedTradeSkillWorld;
} {
  const world = new FrameXmlCannedTradeSkillWorld();
  const craft: FrameXmlTradeSkillCraft = {
    craft: (spellId, count) => world.craftCall(spellId, count),
    castOnItem: (spellId, guid) => world.castOnItem(spellId, guid),
    castOnTradeSlot: (spellId) => world.castOnTradeSlot(spellId),
    stop: () => world.stop(),
    remaining: () => world.remaining(),
  };
  const source: FrameXmlTradeSkillSource = {
    line: (skillId) => world.line(skillId),
    recipes: (skillId) => world.recipes(skillId),
    carried: () => world.carried(),
    toolCategories: () => world.toolCategories(),
    cooldown: (spellId) => world.cooldown(spellId),
    item: (entry) => world.item(entry),
    itemClass: (entry) => world.itemClass(entry),
    subclassName: (itemClass, subClass) => world.subclassName(itemClass, subClass),
    prefetch: (entries, onChanged) => world.prefetch(entries, onChanged),
    carriedItem: (guid) => world.carriedItem(guid),
    enchantReplace: (_spell, guid) => world.replaceNames.get(guid),
    enchantEndsRefund: (_spell, guid) => world.refundItems.has(guid),
    tradeEnchantReplace: () => world.tradeReplaceNames,
    craft,
    token: () => world.token(),
  };
  return { model: new FrameXmlTradeSkillModel(source), world };
}
