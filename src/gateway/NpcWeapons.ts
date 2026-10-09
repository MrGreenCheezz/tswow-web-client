// What a creature holds (plan item 6.02, line A7a slice B, 05.10).
//
// A creature's weapons are not in its display record. The server writes three words,
// `UNIT_VIRTUAL_ITEM_SLOT_ID` (UpdateFields.h, `OBJECT_END + 0x0032`, size 3, PUBLIC): main hand,
// off hand, ranged — and each is an **item entry**, not a display id. `Unit::SetVirtualItem`
// (Unit.cpp:14932-14938) stores the number it is given; `Creature::LoadEquipment`
// (Creature.cpp:1977-2003) gives it `creature_equip_template.ItemEntry1..3`; TSWoW's
// `Creature::SetOutfit` (Creature.cpp:352-368) and the NPC bots write the same words. The server
// checks those entries against `Item.dbc` — `sItemStore`, not `item_template`
// (`ObjectMgr::LoadEquipmentTemplates`, ObjectMgr.cpp:1627-1650: an entry missing from the DBC, or
// whose `InventoryType` is not one of the nine hand types, is forced to 0). So the client-side
// table the entry is read through is `Item.dbc` as well: class, subclass, display and inventory
// type, no item query and no wait for one.
//
// This route turns a batch of such entries into what the browser hangs off the hands: the model and
// texture `ItemDisplayInfo` names (`CharacterAppearanceIndex.weaponModels`), the inventory type the
// attachment point is chosen by, and the weapon subclass the swing and shot are chosen by. The
// answer does not depend on the slot (a held model lives under `Weapon\`, a shield under `Shield\`,
// whichever word it came from), so it is per entry and the browser puts the slot back.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CatalogCache, CatalogRouteOptions } from "./CatalogRoutes.js";
import type { CharacterAppearanceIndex } from "./CharacterAppearance.js";
import { openDbcFile, type Dbc } from "./Dbc.js";
import { originAllowed } from "./UpgradeGuard.js";

export const NPC_WEAPONS_VERSION = 1;
export const NPC_WEAPONS_PATHNAME = "/dbc/npc-weapons";
/** Entries one request may name; the browser batches up to this many. */
export const NPC_WEAPONS_MAX_ENTRIES = 200;

/** `Item.ClassID` of weapons: only their subclass means a kind of weapon. */
const ITEM_CLASS_WEAPON = 2;
/** The slot the model is looked up under; any of 15–17 gives the same directory. */
const LOOKUP_SLOT = 15;

/** One item entry, as the browser hangs it. */
export interface NpcWeapon {
  entry: number;
  /** `Item.InventoryType`: how a shield is told from a held off-hand, a two-hander from a one-hander. */
  inventoryType: number;
  /** `Item.SubclassID`, for class 2 only — an armour subclass is not a kind of weapon. */
  subClass?: number;
  /** Full MPQ path of the M2, or "" when the display names none (nothing to draw, the type still counts). */
  model: string;
  texture: string;
  /**
   * 05.10-A7a-E2 (6.14): `Item.DisplayInfoID`, for the display's own ItemVisual glow. Optional and additive
   * under v=1 (unreleased): the browser hangs no display glow when it is absent.
   */
  displayId?: number;
  /**
   * 05.10-A7a-G2 6.08: `Item.SheatheType`, where the creature stows it (browser/SheathPoints.ts). Optional and
   * additive under v=1 (unreleased, like displayId): without it the browser keeps the old points.
   */
  sheathe?: number;
}

/** The answer for a list of entries: one record per entry `Item.dbc` carries, in the order asked. */
export function npcWeaponsFor(items: Dbc<"Item">, appearance: CharacterAppearanceIndex,
  entries: readonly number[]): NpcWeapon[] {
  const answer: NpcWeapon[] = [];
  for (const entry of entries) {
    const row = items.rowOf(entry);
    if (row === undefined) continue;
    const inventoryType = items.int(row, "InventoryType");
    const subClass = items.int(row, "ClassID") === ITEM_CLASS_WEAPON ? items.int(row, "SubclassID") : undefined;
    const displayId = items.int(row, "DisplayInfoID"); // 05.10-A7a-E2: named once, sent below
    const [held] = appearance.weaponModels([{
      slot: LOOKUP_SLOT, inventoryType, displayId,
      ...(subClass === undefined ? {} : { subClass }),
    }]);
    answer.push({
      entry, inventoryType, ...(subClass === undefined ? {} : { subClass }),
      model: held?.model ?? "", texture: held?.texture ?? "",
      ...(displayId > 0 ? { displayId } : {}), // 05.10-A7a-E2 (6.14)
      sheathe: items.int(row, "SheatheType"), // 05.10-A7a-G2 6.08: Wow.exe 0x00725010 reads it at +0x1c
    });
  }
  return answer;
}

/** `entries=1,2,3`: 1–200 distinct positive uint32 entries, or undefined for anything else. */
export function parseNpcWeaponEntries(value: string | null): number[] | undefined {
  if (value === null || value === "") return undefined;
  const parts = value.split(",");
  if (parts.length > NPC_WEAPONS_MAX_ENTRIES) return undefined;
  const entries = new Set<number>();
  for (const part of parts) {
    if (!/^\d{1,10}$/.test(part)) return undefined;
    const entry = Number(part);
    if (entry < 1 || entry > 0xffff_ffff) return undefined;
    entries.add(entry);
  }
  return [...entries];
}

/** `Item.dbc` per dataset memo: keyed by the gateway's catalog map, which `reset()` replaces. */
const ITEM_TABLES = new WeakMap<CatalogCache, Promise<Dbc<"Item">>>();

/**
 * Answers `GET /dbc/npc-weapons?v=1&entries=…` the way its siblings do (CatalogRoutes.ts): 403 for
 * a foreign Origin, 400 for another `v=` or a bad list, `no-store`, 500 (and the memo forgotten)
 * when the dataset cannot be read. False leaves any other request to the rest of the gateway.
 */
export async function serveNpcWeaponsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  cache: CatalogCache,
  options: CatalogRouteOptions,
  appearance: () => Promise<CharacterAppearanceIndex>,
): Promise<boolean> {
  if (request.method !== "GET" || !options.dbcDirectory || url.pathname !== NPC_WEAPONS_PATHNAME) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const entries = parseNpcWeaponEntries(url.searchParams.get("entries"));
  if (url.searchParams.get("v") !== String(NPC_WEAPONS_VERSION) || entries === undefined) {
    response.writeHead(400, { "access-control-allow-origin": origin }).end();
    return true;
  }
  let items = ITEM_TABLES.get(cache);
  if (!items) {
    items = openDbcFile(options.dbcDirectory, "Item");
    ITEM_TABLES.set(cache, items);
  }
  try {
    const data = JSON.stringify(npcWeaponsFor(await items, await appearance(), entries));
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(data);
  } catch {
    // Not the rejection again on the next request: the disk may have been mid-build.
    if (ITEM_TABLES.get(cache) === items) ITEM_TABLES.delete(cache);
    response.writeHead(500, { "access-control-allow-origin": origin }).end();
  }
  return true;
}
