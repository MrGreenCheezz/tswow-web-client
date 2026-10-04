// What a repair costs, as the original client prices it (plan item 2.02).
//
// Nothing on the wire carries a repair price: GetRepairAllCost, the repair cursor's tooltip and the
// client's own «not enough money» refusal all come from the client's arithmetic over two DBC tables
// (gateway/DurabilityMetadata.ts) and the item's update fields. The charge is the server's
// (`Item::CalculateDurabilityRepairCost`, Item.cpp:753-798), from the same tables, so the number
// shown here is the number the realm takes — up to a TSWoW `OnReputationPriceDiscount` script and
// `Rate.RepairCost`, which the client cannot see.
//
// Read off Wow.exe.clean (build 12340), not copied from it:
// * 0x00708540 — one item's price before the discount: nothing for an item whose template is not in
//   the cache, for a wrapped item (ITEM_FIELD_FLAGS 0x8), without maximum durability or without
//   wear; the DurabilityCosts row whose id is the item level; the column by class and subclass —
//   weapon (2) subclass 0..21 and armour (4) subclass 0..8, every other class nothing; the
//   DurabilityQuality row at *index* `quality * 2 + 1`; then `lost × Data × column` as a float,
//   rounded half away from zero (0x005773b0: +0.5, truncate), and a price of 0 becomes 1.
// * 0x00584b20 — the discount: `1 − d` stored as a float, where d is 0.05/0.1/0.15/0.2 (the floats
//   at 0x009f1958, 0x00a349f0, 0x009f23d4, 0x009e8d84) for a merchant whose faction keeps a
//   reputation and a player friendly/honored/revered/exalted with it (0x007279a0); the product
//   stored as a float and rounded to the nearest integer, ties to even (FISTP, default mode).
//
// The server's own sum differs in two places the client does not share: it rounds the discounted
// price down (`uint32(cost * discount * rate)`) and reads the quality row by id `(quality + 1) * 2`.
// On this dataset's DurabilityQuality (ids 1..16 in order) row `quality * 2 + 1` *is* that id.

export const ITEM_CLASS_WEAPON = 2;
export const ITEM_CLASS_ARMOR = 4;
/** `ITEM_FIELD_FLAG_WRAPPED`: a gift-wrapped item has no durability to the client. */
export const ITEM_FIELD_FLAG_WRAPPED = 0x8;
/** `ReputationRank`: REP_FRIENDLY … REP_EXALTED. */
export const REPUTATION_RANK_FRIENDLY = 4;
export const REPUTATION_RANK_EXALTED = 7;

/** The route's answer (gateway/DurabilityMetadata.ts `DurabilityCatalog`). */
export interface DurabilityCatalogData {
  readonly version: number;
  readonly costs: readonly (readonly number[])[];
  readonly quality: readonly (readonly [number, number])[];
}

/** What the price reads off the item's template (the query cache); absent until it is cached. */
export interface RepairItemTemplate {
  readonly itemLevel: number;
  readonly quality: number;
  readonly itemClass: number;
  readonly subClass: number;
}

/** One item as the price reads it: its update fields, and its template when the cache has it. */
export interface RepairItemFacts {
  readonly durability: number;
  readonly maxDurability: number;
  /** `ITEM_FIELD_FLAGS`. */
  readonly flags: number;
  readonly template: RepairItemTemplate | undefined;
}

const COST_FIELDS = 30;
const WEAPON_FIRST = 1;
const ARMOR_FIRST = 22;
const WEAPON_MAX_SUBCLASS = 21;
const ARMOR_MAX_SUBCLASS = 8;

/** The two tables, indexed the way the client reads them. */
export class DurabilityTables {
  readonly #costs: readonly (readonly number[])[];
  readonly #rowByLevel = new Map<number, number>();
  readonly #quality: readonly number[];

  constructor(catalog: DurabilityCatalogData) {
    this.#costs = catalog.costs;
    catalog.costs.forEach((row, index) => {
      if (!this.#rowByLevel.has(row[0]!)) this.#rowByLevel.set(row[0]!, index);
    });
    this.#quality = catalog.quality.map(([, data]) => Math.fround(data));
  }

  /**
   * The DurabilityCosts column for an item, or undefined where 0x00708540 answers nothing.
   *
   * The bounds are the client's: 22 weapon columns are allowed where the row has 21 (subclass 21
   * reads the first armour column) and 9 armour columns where it has 8 (subclass 8 reads the field
   * after the row, which in the loaded block is the next row's id; after the last row, unknown memory — no price).
   */
  multiplier(itemLevel: number, itemClass: number, subClass: number): number | undefined {
    const index = this.#rowByLevel.get(itemLevel);
    if (index === undefined) return undefined;
    let field: number;
    if (itemClass === ITEM_CLASS_WEAPON) {
      if (!Number.isInteger(subClass) || subClass < 0 || subClass > WEAPON_MAX_SUBCLASS) return undefined;
      field = WEAPON_FIRST + subClass;
    } else if (itemClass === ITEM_CLASS_ARMOR) {
      if (!Number.isInteger(subClass) || subClass < 0 || subClass > ARMOR_MAX_SUBCLASS) return undefined;
      field = ARMOR_FIRST + subClass;
    } else {
      return undefined;
    }
    if (field < COST_FIELDS) return this.#costs[index]![field] ?? 0;
    // Past the last row the client reads whatever follows the block; unknown, so no price at all.
    return this.#costs[index + 1]?.[field - COST_FIELDS];
  }

  /** DurabilityQuality's `Data` at row `quality * 2 + 1` (0x00708540 → 0x004d8580), as a float. */
  qualityData(quality: number): number | undefined {
    if (!Number.isInteger(quality)) return undefined;
    return this.#quality[quality * 2 + 1];
  }
}

/** Round to nearest, ties to even: the x87 FISTP under the default control word. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 0x005773b0: add or subtract a half by sign, then truncate. */
function roundHalfAway(value: number): number {
  return value > 0 ? Math.trunc(value + 0.5) : Math.trunc(value - 0.5);
}

/** Whether the item counts as worn for GetRepairAllCost's second value (not wrapped, max > cur). */
export function itemNeedsRepair(item: RepairItemFacts): boolean {
  return (item.flags & ITEM_FIELD_FLAG_WRAPPED) === 0 && item.maxDurability > 0
    && item.durability < item.maxDurability;
}

/** One item's price before the discount (0x00708540); 0 where the client prices nothing. */
export function baseRepairCost(item: RepairItemFacts, tables: DurabilityTables): number {
  const template = item.template;
  if (!template || !itemNeedsRepair(item)) return 0;
  const multiplier = tables.multiplier(template.itemLevel, template.itemClass, template.subClass);
  if (multiplier === undefined) return 0;
  const data = tables.qualityData(template.quality);
  if (data === undefined) return 0;
  const lost = item.maxDurability - item.durability;
  // `(float)lost * Data * (float)column`, handed on as a float: every factor is exact in a double
  // (lost and the column are small integers, Data a float), so only the final float rounding counts.
  const cost = roundHalfAway(Math.fround(lost * data * multiplier));
  return cost === 0 ? 1 : cost;
}

/** The reputation discount 0x007279a0 subtracts, by the player's rank with the merchant's faction. */
export function repairDiscount(rank: number | undefined): number {
  switch (rank) {
    case 4: return Math.fround(0.05);
    case 5: return Math.fround(0.1);
    case 6: return Math.fround(0.15);
    case 7: return Math.fround(0.2);
    default: return 0;
  }
}

/** The factor 0x00584b20 multiplies by: `1 − discount`, stored as a float. */
export function repairPriceFactor(rank: number | undefined): number {
  return Math.fround(1 - repairDiscount(rank));
}

/** One item's price as the client shows it and checks it against the purse (0x00584b20). */
export function itemRepairCost(item: RepairItemFacts, tables: DurabilityTables, factor = 1): number {
  const base = baseRepairCost(item, tables);
  return roundHalfEven(Math.fround(base * Math.fround(factor)));
}
