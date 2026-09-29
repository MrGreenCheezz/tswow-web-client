import { openDbcFile } from "./Dbc.js";

/**
 * What a character is wearing the moment it is created.
 *
 * The creation screen's 3D preview needs it and nothing in this client read it: the preview stood
 * naked, and a naked warrior is not what the original shows. `CharStartOutfit` is keyed on
 * `(race, class, sex, outfit)` and carries 24 parallel slots of item id, **display** id and
 * inventory type — the display column is the one that matters here, so the answer needs no
 * `Item.dbc` chain at all.
 *
 * Measured on this dataset (and byte-identical in `F:/CircleClean`, where the table resolves out of
 * tswow's own `patch-ruRU-A.MPQ`): 126 records, 77 fields, 296 bytes a record, which is exactly
 * `int ID` + four `u8` keys + three `int[24]` arrays and admits no other reading. Ten races
 * (1..8, 10, 11), ten classes (1..9, 11) and one outfit id, 0.
 *
 * Two rows read against known reality:
 *
 * * **Dwarf rogue, male** (row id 288) — Worn Dagger `2092` display `6442`
 *   (`Knife_1H_Dagger_A_01Copper`) at INVTYPE_WEAPON, a second one at INVTYPE_WEAPONOFFHAND,
 *   Recruit's shirt/pants/boots at 4/7/8, throwing axes at INVTYPE_THROWN and a Hearthstone at
 *   inventory type 0. That is the stock 3.3.5 rogue kit, slot for slot.
 * * **Human warrior, male** (row id 1) — shirt `38`, pants `39`, boots `40`, a Hearthstone, and one
 *   weapon: item `49778`, display `2380`, INVTYPE_2HWEAPON. Display 2380 is
 *   `Sword_2H_Claymore_A_01` / `Sword_2H_Claymore_A_01Rusty`. So this server's human warrior does
 *   **not** start with the stock Worn Shortsword and shield — the owner's dataset replaced item 25
 *   and 2362 with one two-hander. The layout is right; the contents are this server's.
 */

/** One visible piece of a starting outfit. */
export interface StartOutfitItem {
  /** `ItemDisplayInfo` id, straight out of `DisplayItemID`. */
  displayId: number;
  /** `INVTYPE_*`, straight out of `InventoryType`. */
  inventoryType: number;
  /**
   * `EQUIPMENT_SLOT_*` — which of the nineteen visible-item words this would arrive in.
   *
   * `CharStartOutfit` does not carry it, and `/dbc/character-appearance` needs it: the inventory
   * type alone cannot tell a main hand from an off hand, since a one-handed weapon is
   * INVTYPE_WEAPON in either. It is derived here rather than in the browser so the two ends of the
   * `slot:inventoryType:displayId` contract are decided in one place.
   */
  slot: number;
}

/**
 * `INVTYPE_*` to `EQUIPMENT_SLOT_*`.
 *
 * The same nineteen slots `CharacterAppearance.ts` names — head 0, shoulders 2, shirt 3, chest 4,
 * waist 5, legs 6, feet 7, wrists 8, hands 9, back 14, main hand 15, off hand 16, ranged 17,
 * tabard 18. Types with no visible slot (bag 18, ammo 24) and inventory type 0 (a Hearthstone, a
 * quest item — every outfit carries one) are absent and are dropped rather than placed.
 */
const SLOT_FOR_INVENTORY_TYPE: Readonly<Record<number, number>> = Object.freeze({
  1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9,
  11: 10, 12: 12,
  13: 15, 14: 16, 15: 17, 16: 14, 17: 15,
  19: 18, 20: 4, 21: 15, 22: 16, 23: 16,
  25: 17, 26: 17, 28: 17,
});

/** The 24 parallel columns of one row. */
const OUTFIT_SLOTS = 24;

export class CharStartOutfitIndex {
  /** `race/class/sex/outfit` -> the visible items of that row. */
  readonly #byKey = new Map<string, StartOutfitItem[]>();

  private constructor(rows: ReadonlyMap<string, StartOutfitItem[]>) {
    this.#byKey = new Map(rows);
  }

  static async load(dbcDirectory: string): Promise<CharStartOutfitIndex> {
    const table = await openDbcFile(dbcDirectory, "CharStartOutfit");
    const rows = new Map<string, StartOutfitItem[]>();
    for (const row of table.rows()) {
      const items: StartOutfitItem[] = [];
      for (let index = 0; index < OUTFIT_SLOTS; index++) {
        const displayId = table.int(row, "DisplayItemID", index);
        const inventoryType = table.int(row, "InventoryType", index);
        if (displayId <= 0) continue;
        const slot = SLOT_FOR_INVENTORY_TYPE[inventoryType];
        if (slot === undefined) continue;
        items.push({ displayId, inventoryType, slot });
      }
      const key = outfitKey(
        table.int(row, "RaceID"), table.int(row, "ClassID"),
        table.int(row, "SexID"), table.int(row, "OutfitID"));
      // First row wins, as `Dbc.rowOf` does: a dataset with a duplicate key is a dataset whose
      // second row the client would never reach either.
      if (!rows.has(key)) rows.set(key, items);
    }
    return new CharStartOutfitIndex(rows);
  }

  /** For a test that wants the shape without a dataset. */
  static fromRows(rows: ReadonlyMap<string, StartOutfitItem[]>): CharStartOutfitIndex {
    return new CharStartOutfitIndex(rows);
  }

  /**
   * The outfit for one profile, or an empty list.
   *
   * Empty rather than undefined: a race/class pair the table says nothing about is a character the
   * server will still create, and the preview's honest answer is "wearing nothing" rather than a
   * failed request.
   */
  outfit(race: number, classId: number, sex: number, outfit = 0): StartOutfitItem[] {
    return [...(this.#byKey.get(outfitKey(race, classId, sex, outfit)) ?? [])];
  }

  get size(): number {
    return this.#byKey.size;
  }
}

export function outfitKey(race: number, classId: number, sex: number, outfit: number): string {
  return `${race}/${classId}/${sex}/${outfit}`;
}
