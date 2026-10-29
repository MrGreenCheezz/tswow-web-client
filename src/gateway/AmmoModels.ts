// 29.10: the model an ammo display flies as (owner: «у охотника не проигрывается анимация стрельбы»).
//
// SMSG_SPELL_GO's `CAST_FLAG_AMMO` pair names an `ItemDisplayInfo` id and an inventory type (world/SpellAmmo.ts).
// Wow.exe turns it into a model in 0x004eab50 (read in .runtime/re-2026-10-05/A7a-H/h6.c:1074-1170), which the
// missile launcher 0x00732ff0 calls when the spell's SpellVisual names no MissileModel
// (.runtime/re-2026-10-11/glue-1110/1013-m1.txt:590-597):
// - only inventory type 24 (`INVTYPE_AMMO`) or 25 (`INVTYPE_THROWN`), and only when the record's *second* model
//   and *second* texture are both set (`param_2 + 8`, `param_2 + 0x10`: ModelName[1], ModelTexture[1]);
// - the directory is `Item\ObjectComponents\Ammo\` for 24 and `Item\ObjectComponents\Weapon\` for 25;
// - the texture goes into the model's texture slot 2 (`FUN_00825260(2, …)`, the object skin) and the display's
//   ItemVisual (`param_2 + 0x5c`) is applied (`FUN_004ea8f0`).
// Measured on this dataset (29.10): every INVTYPE_AMMO display names its flight model in ModelName[1] only —
// 5996 `ArrowFlight_01` / `Arrow_A_01Brown`, 5998 `BulletFlight_01` / `bullet`, both under `Ammo\` in the client
// archives — and 128 of the 133 thrown weapons name one there too (the two read carry an InFlight (144) clip, which
// the missile plays: MissileSequence.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import { validAssetPath } from "./AssetPath.js";
import type { CatalogCache, CatalogRouteOptions } from "./CatalogRoutes.js";
import { openDbcFile, type Dbc } from "./Dbc.js";
import { originAllowed } from "./UpgradeGuard.js";

export const AMMO_MODELS_VERSION = 1;
export const AMMO_MODELS_PATHNAME = "/dbc/ammo-models";
/** Pairs one request may name; a world rarely shows more than a handful of ammo kinds. */
export const AMMO_MODELS_MAX_ITEMS = 64;

const INVTYPE_AMMO = 24;
const INVTYPE_THROWN = 25;

/** One ammo display as it flies. `model` is "" when Wow.exe 0x004eab50 would draw nothing for it. */
export interface AmmoModel {
  displayId: number;
  inventoryType: number;
  /** Full MPQ path of the M2, or "". */
  model: string;
  /** Full MPQ path of the object-skin texture (slot 2), or "". */
  texture: string;
  /** `ItemDisplayInfo.ItemVisual` when not 0: carried, not yet drawn on a missile. */
  itemVisual?: number;
}

/** The flight model of one display, by Wow.exe 0x004eab50's rule. */
export function ammoModelFor(displays: Dbc<"ItemDisplayInfo">, displayId: number, inventoryType: number): AmmoModel {
  const none: AmmoModel = { displayId, inventoryType, model: "", texture: "" };
  if (inventoryType !== INVTYPE_AMMO && inventoryType !== INVTYPE_THROWN) return none;
  const row = displays.rowOf(displayId);
  if (row === undefined) return none;
  const name = displays.string(row, "ModelName", 1);
  const skin = displays.string(row, "ModelTexture", 1);
  if (!name || !skin) return none;
  const directory = inventoryType === INVTYPE_AMMO ? "Item\\ObjectComponents\\Ammo\\" : "Item\\ObjectComponents\\Weapon\\";
  // Every ItemDisplayInfo ModelName ends in `.mdx`; the shipped asset is the M2 (CharacterAppearance.ts #attached).
  const model = `${directory}${name.replace(/\.mdx$/i, "")}.m2`.replaceAll("/", "\\");
  const texture = `${directory}${skin}.blp`.replaceAll("/", "\\");
  if (!validAssetPath(model, { extensions: ["m2"] }) || !validAssetPath(texture, { extensions: ["blp"] })) return none;
  const itemVisual = displays.int(row, "ItemVisual");
  return { displayId, inventoryType, model, texture, ...(itemVisual > 0 ? { itemVisual } : {}) };
}

/** `items=5996:24,5998:24`: 1–64 distinct `display:inventoryType` pairs, or undefined for anything else. */
export function parseAmmoItems(value: string | null): Array<[number, number]> | undefined {
  if (value === null || value === "") return undefined;
  const parts = value.split(",");
  if (parts.length > AMMO_MODELS_MAX_ITEMS) return undefined;
  const seen = new Set<string>();
  const items: Array<[number, number]> = [];
  for (const part of parts) {
    const match = /^(\d{1,10}):(\d{1,2})$/.exec(part);
    if (!match) return undefined;
    const displayId = Number(match[1]);
    const inventoryType = Number(match[2]);
    if (displayId < 1 || displayId > 0xffff_ffff) return undefined;
    if (seen.has(part)) continue;
    seen.add(part);
    items.push([displayId, inventoryType]);
  }
  return items;
}

const DISPLAY_TABLES = new WeakMap<CatalogCache, Promise<Dbc<"ItemDisplayInfo">>>();

/**
 * Answers `GET /dbc/ammo-models?v=1&items=…` the way its siblings do (NpcWeapons.ts): 403 for a foreign Origin,
 * 400 for another `v=` or a bad list, `no-store`, 500 (and the memo forgotten) when the dataset cannot be read.
 */
export async function serveAmmoModelsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  cache: CatalogCache,
  options: CatalogRouteOptions,
): Promise<boolean> {
  if (request.method !== "GET" || !options.dbcDirectory || url.pathname !== AMMO_MODELS_PATHNAME) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const items = parseAmmoItems(url.searchParams.get("items"));
  if (url.searchParams.get("v") !== String(AMMO_MODELS_VERSION) || items === undefined) {
    response.writeHead(400, { "access-control-allow-origin": origin }).end();
    return true;
  }
  let displays = DISPLAY_TABLES.get(cache);
  if (!displays) {
    displays = openDbcFile(options.dbcDirectory, "ItemDisplayInfo");
    DISPLAY_TABLES.set(cache, displays);
  }
  try {
    const table = await displays;
    const data = JSON.stringify(items.map(([displayId, inventoryType]) => ammoModelFor(table, displayId, inventoryType)));
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(data);
  } catch {
    if (DISPLAY_TABLES.get(cache) === displays) DISPLAY_TABLES.delete(cache);
    response.writeHead(500, { "access-control-allow-origin": origin }).end();
  }
  return true;
}
