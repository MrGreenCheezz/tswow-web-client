// 05.10-A7a-D (6.06): the client's weapon → animation tables for the browser, `GET /dbc/weapon-anims?v=1`
// — a row of CatalogRoutes.ts (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the
// memo dropped).
//
// Why: which swing, stance and parry a weapon draws is data in the 3.3.5 client, not a list in code.
// Three tables carry it:
// * `ItemSubClass` rows of class 2 — `WeaponParrySeq`, `WeaponReadySeq`, `WeaponAttackSeq`,
//   `WeaponSwingSize` (tools/dbd/ItemSubClass.dbd, generated layout). The seq columns are small enums
//   decoded against the subclasses in docs/implementation/line-A7a.ru.md A7-M3.
// * `AttackAnimKits` — the swing variants per weapon subclass and hand: ID, ItemSubclass,
//   AttackAnimType, a flag (1/2/4, meaning not established) and an off-hand marker. No `.dbd` and no
//   TrinityCore format (the core never loads it); the layout is the WDBC header — 5 fields, 20 bytes
//   — checked on read, measured 26 rows on this dataset.
// * `AttackAnimTypes` — ID and an internal name (`1H_Main_Swing` …). Header: 2 fields, 8 bytes; 7 rows.
//
//   { version: 1, subclasses: [[sub, parry, ready, attack, swing], …], kits: [[id, sub, type, flags, offhand], …],
//     types: [[id, name], …] }  — every row in file order; subclasses only for class 2.

import { openDbcFile } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const WEAPON_ANIMS_VERSION = 1;

export const ATTACK_ANIM_KITS_LAYOUT = Object.freeze({ fieldCount: 5, recordSize: 20 });
export const ATTACK_ANIM_TYPES_LAYOUT = Object.freeze({ fieldCount: 2, recordSize: 8 });

const ITEM_CLASS_WEAPON = 2;

export type WeaponSubclassRow = [subClass: number, parrySeq: number, readySeq: number, attackSeq: number, swingSize: number];
export type AttackAnimKitRow = [id: number, subClass: number, type: number, flags: number, offhand: number];
export type AttackAnimTypeRow = [id: number, name: string];

export interface WeaponAnimCatalog {
  version: number;
  subclasses: WeaponSubclassRow[];
  kits: AttackAnimKitRow[];
  types: AttackAnimTypeRow[];
}

/** The two raw tables out of already-checked rows; pure, so a test can feed it synthetic files. */
export function weaponAnimCatalog(subclasses: WeaponSubclassRow[], kits: FixedRows, types: FixedRows): WeaponAnimCatalog {
  const kitRows: AttackAnimKitRow[] = [];
  for (let row = 0; row < kits.records; row++) {
    kitRows.push([kits.int(row, 0), kits.int(row, 1), kits.int(row, 2), kits.int(row, 3), kits.int(row, 4)]);
  }
  const typeRows: AttackAnimTypeRow[] = [];
  for (let row = 0; row < types.records; row++) typeRows.push([types.int(row, 0), types.string(row, 1)]);
  return { version: WEAPON_ANIMS_VERSION, subclasses, kits: kitRows, types: typeRows };
}

export async function loadWeaponAnims(dbcDirectory: string): Promise<WeaponAnimCatalog> {
  const [itemSubClass, kits, types] = await Promise.all([
    openDbcFile(dbcDirectory, "ItemSubClass"),
    readFixed(dbcDirectory, "AttackAnimKits", ATTACK_ANIM_KITS_LAYOUT),
    readFixed(dbcDirectory, "AttackAnimTypes", ATTACK_ANIM_TYPES_LAYOUT),
  ]);
  const subclasses: WeaponSubclassRow[] = [];
  for (const row of itemSubClass.rows()) {
    if (itemSubClass.int(row, "ClassID") !== ITEM_CLASS_WEAPON) continue;
    subclasses.push([
      itemSubClass.int(row, "SubClassID"), itemSubClass.int(row, "WeaponParrySeq"),
      itemSubClass.int(row, "WeaponReadySeq"), itemSubClass.int(row, "WeaponAttackSeq"),
      itemSubClass.int(row, "WeaponSwingSize"),
    ]);
  }
  return weaponAnimCatalog(subclasses, kits, types);
}
