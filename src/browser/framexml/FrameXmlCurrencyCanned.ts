/**
 * The offline currency fixture for CannedWorldSeam: four rows of the dataset's own CurrencyTypes and
 * CurrencyCategory tables (ids, items, headings, bits and the «Неактивно» flags as measured by
 * src/gateway/CurrencyCatalog.ts), a player who knows four of them, and the ruRU item names and icons
 * the item cache would answer. The world is mutable so tests can move amounts and known bits.
 */
import {
  FRAMEXML_CURRENCY_CATALOG_VERSION,
  FrameXmlCurrencyModel,
  type FrameXmlCurrencyCatalog,
  type FrameXmlCurrencyItem,
} from "./FrameXmlCurrency.js";

export const FRAMEXML_CANNED_CURRENCY_CATALOG: FrameXmlCurrencyCatalog = Object.freeze({
  version: FRAMEXML_CURRENCY_CATALOG_VERSION,
  categories: Object.freeze([
    Object.freeze({ id: 1, flags: 0, name: "Разное" }),
    Object.freeze({ id: 2, flags: 0, name: "PvP" }),
    Object.freeze({ id: 22, flags: 0, name: "Подземелья и рейды" }),
    Object.freeze({ id: 3, flags: 3, name: "Неактивно" }),
  ]),
  types: Object.freeze([
    Object.freeze({ id: 1, itemId: 37711, categoryId: 1, bitIndex: 1 }),
    Object.freeze({ id: 103, itemId: 43307, categoryId: 2, bitIndex: 12 }),
    Object.freeze({ id: 104, itemId: 43308, categoryId: 2, bitIndex: 13 }),
    Object.freeze({ id: 101, itemId: 40752, categoryId: 22, bitIndex: 10 }),
    Object.freeze({ id: 102, itemId: 40753, categoryId: 22, bitIndex: 11 }),
  ]),
});

export const FRAMEXML_CANNED_CURRENCY_ITEMS: ReadonlyMap<number, FrameXmlCurrencyItem> = new Map([
  // No icons for the PvP totals: stock draws those from extraCurrencyType (Blizzard_TokenUI.lua:99-110).
  [43307, { name: "Очки арены" }],
  [43308, { name: "Очки чести" }],
  [40752, { name: "Эмблема героизма", texture: "Interface\\Icons\\Spell_Holy_ProclaimChampion" }],
  [40753, { name: "Эмблема доблести", texture: "Interface\\Icons\\Spell_Holy_ProclaimChampion_02" }],
]);

export interface FrameXmlCannedCurrencyWorld {
  knownMask: bigint;
  honor: number;
  arena: number;
  readonly held: Map<number, number>;
}

/** Bits 10-13: both emblems and both PvP totals; 37711 (bit 1) stays unknown. */
export const FRAMEXML_CANNED_CURRENCY_KNOWN = (1n << 9n) | (1n << 10n) | (1n << 11n) | (1n << 12n);

export function createCannedFrameXmlCurrency(): { readonly model: FrameXmlCurrencyModel; readonly world: FrameXmlCannedCurrencyWorld } {
  const world: FrameXmlCannedCurrencyWorld = {
    knownMask: FRAMEXML_CANNED_CURRENCY_KNOWN,
    honor: 1500,
    arena: 0,
    held: new Map([[40752, 12]]),
  };
  const model = new FrameXmlCurrencyModel({
    catalog: () => FRAMEXML_CANNED_CURRENCY_CATALOG,
    snapshot: () => ({ knownMask: world.knownMask, honor: world.honor, arena: world.arena, held: world.held }),
    item: (entry) => FRAMEXML_CANNED_CURRENCY_ITEMS.get(entry),
  });
  return { model, world };
}
