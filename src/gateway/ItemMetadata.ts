import { readFile } from "node:fs/promises";

export interface ItemMetadata {
  entry: number;
  name: string;
  displayId: number;
  quality: number;
  inventoryType: number;
  stackable: number;
  iconId: number;
  /**
   * The four the dump does not carry, filled from `SMSG_ITEM_QUERY_SINGLE_RESPONSE` when the
   * server answers for this entry.
   *
   * Here rather than in a second type because there is one item in the client's mind and two
   * places it can be learnt from: this dump holds what a name, an icon and a tooltip need, and the
   * query carries the whole `item_template` row. What a weapon sounds like when it lands is
   * `ItemSubClass` keyed on class and subclass — `soundOverrideSubclass` standing in for the
   * latter when it is set — and the material, so those four are what Н1б will ask for, and the
   * dump would otherwise have to grow four columns for the same answer.
   */
  itemClass?: number;
  subClass?: number;
  soundOverrideSubclass?: number;
  material?: number;
}

export async function loadItemMetadata(path: string): Promise<Map<number, ItemMetadata>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || value.length > 200_000) throw new Error("Item metadata file is invalid");
  const result = new Map<number, ItemMetadata>();
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 7 || typeof row[1] !== "string"
      || !row.every((field, index) => index === 1 || typeof field === "number" && Number.isFinite(field))) {
      throw new Error("Item metadata row is invalid");
    }
    const [entry, name, displayId, quality, inventoryType, stackable, iconId] = row as [number, string, number, number, number, number, number];
    result.set(entry, { entry, name, displayId, quality, inventoryType, stackable, iconId });
  }
  return result;
}
