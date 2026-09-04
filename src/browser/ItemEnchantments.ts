import type { ItemEnchantmentData, ItemEnchantmentInfo, GemPropertyInfo } from "../gateway/ItemEnchantments.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "../world/WorldState.js";

export type { ItemEnchantmentInfo, GemPropertyInfo };

export class ItemEnchantmentClient {
  readonly enchantments = new Map<number, ItemEnchantmentInfo>();
  readonly gems = new Map<number, GemPropertyInfo>();
  #pending: Promise<void> | undefined;
  ready = false;

  constructor(readonly origin: string) {}

  load(refresh = false): Promise<void> {
    if (this.ready && !refresh) return Promise.resolve();
    if (refresh) this.ready = false;
    this.#pending ??= this.#load().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #load(): Promise<void> {
    const response = await fetch(`${this.origin}/dbc/item-enchantments`);
    if (!response.ok) throw new Error(`Не удалось загрузить сведения о камнях (${response.status})`);
    const data = await response.json() as ItemEnchantmentData;
    if (!Array.isArray(data.enchantments) || !Array.isArray(data.gems)
      || !data.enchantments.every((row) => Number.isInteger(row.id) && typeof row.name === "string"
        && Number.isInteger(row.gemItemId) && Number.isInteger(row.conditionId))
      || !data.gems.every((row) => Number.isInteger(row.id) && Number.isInteger(row.enchantmentId)
        && Number.isInteger(row.color))) throw new Error("Некорректные сведения о камнях");
    this.enchantments.clear();
    this.gems.clear();
    for (const enchantment of data.enchantments) this.enchantments.set(enchantment.id, enchantment);
    for (const gem of data.gems) this.gems.set(gem.id, gem);
    this.ready = true;
  }
}

let cached: ItemEnchantmentClient | undefined;
export function itemEnchantments(origin: string): ItemEnchantmentClient {
  if (cached?.origin !== origin) cached = new ItemEnchantmentClient(origin);
  return cached;
}

/** Item.h: each enchantment occupies id/duration/charges; sockets are slots 2..4,
 * socket bonus is slot 5, a blacksmith/buckle prismatic socket is slot 6. */
export function itemEnchantmentIds(item: WorldObjectState): number[] {
  return Array.from({ length: 7 }, (_, slot) =>
    item.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + slot * 3) ?? 0);
}

export function itemSocketColors(sockets: readonly { color: number }[], enchantments: readonly number[] = []): number[] {
  const colors = Array.from({ length: 3 }, (_, index) => sockets[index]?.color ?? 0);
  const extra = colors.indexOf(0);
  if ((enchantments[6] ?? 0) > 0 && extra >= 0) colors[extra] = 14;
  return colors;
}

/** Ordinary colours may mismatch (losing the bonus); only meta vs ordinary is a hard gate. */
export function gemFitsSocket(socketColor: number, gemColor: number): boolean {
  return socketColor > 0 && gemColor > 0 && (socketColor === 1) === (gemColor === 1);
}

export function socketColorName(color: number): string {
  return ({ 1: "Особое гнездо", 2: "Красное гнездо", 4: "Жёлтое гнездо", 8: "Синее гнездо", 14: "Радужное гнездо" } as Record<number, string>)[color]
    ?? "Гнездо";
}
