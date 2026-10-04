// The gateway's small DBC catalogs, one table and one place in Gateway.ts (line A3, М2 «Новый
// DBC-маршрут»).
//
// Each of the existing `/dbc/*` catalogs is a 28-line block of its own in Gateway.ts: the Origin
// (403), the shape the page asks for (`?v=`, 400), a promise memoised per dataset, the answer (200,
// JSON, never cached — a rebuilt dataset resets the memo through `DatasetFingerprint`), and on a
// failed read the memo dropped again so the next request reads the disk rather than the same
// rejection (500). A new route is a row here instead: `serveCatalogRoute` is that block once, and
// its memo is `DatasetIndexes.catalogs`, which `DatasetIndexes.reset()` forgets with the rest.
//
// The browser half is `browser/CatalogClient.ts`: a gateway process older than a row here answers
// 404 for it, and the client retries rather than giving up on the mechanic for the whole page.

import type { IncomingMessage, ServerResponse } from "node:http";
import { AREA_TRIGGERS_VERSION, loadAreaTriggers } from "./AreaTriggerMetadata.js";
import { CREATURE_TYPES_VERSION, loadCreatureTypes } from "./CreatureTypeMetadata.js";
import { CHARACTER_REGEN_VERSION, loadCharacterRegen } from "./CharacterRegenMetadata.js";
import { SPELL_LEARN_EFFECTS_VERSION, loadSpellLearnEffects } from "./SpellLearnEffectsMetadata.js";
import { DURABILITY_VERSION, loadDurability } from "./DurabilityMetadata.js";
import { DUNGEON_ENCOUNTERS_VERSION, loadDungeonEncounters } from "./DungeonEncounterMetadata.js";
import { REALM_CATEGORIES_VERSION, loadRealmCategories } from "./RealmCategoryMetadata.js";
import { QUEST_LOG_NAMES_VERSION, loadQuestLogNames } from "./QuestLogNameMetadata.js";
import { VEHICLES_VERSION, loadVehicles } from "./VehicleMetadata.js"; // 11.02-F1
import { SPELL_MISSILES_VERSION, loadSpellMissiles } from "./SpellMissileMetadata.js"; // 11.02-E-review
import { originAllowed } from "./UpgradeGuard.js";

export interface CatalogRoute {
  /** The path the browser asks for, `/dbc/<name>`. */
  readonly pathname: string;
  /** The answer's shape. The request must name it as `?v=`; bump it with every change of shape. */
  readonly version: number;
  /** Builds the answer from the dataset's DBC directory; serialised once per dataset. */
  load(dbcDirectory: string): Promise<unknown>;
}

export const CATALOG_ROUTES: readonly CatalogRoute[] = Object.freeze([
  // 2.01: the volumes CMSG_AREATRIGGER names (AreaTriggerMetadata.ts).
  { pathname: "/dbc/area-triggers", version: AREA_TRIGGERS_VERSION, load: loadAreaTriggers },
  // 2.02: the repair price tables (DurabilityMetadata.ts).
  { pathname: "/dbc/durability", version: DURABILITY_VERSION, load: loadDurability },
  // 2.09: the bosses behind the instance-lock dialog's killed-boss mask (DungeonEncounterMetadata.ts).
  { pathname: "/dbc/dungeon-encounters", version: DUNGEON_ENCOUNTERS_VERSION, load: loadDungeonEncounters },
  // 10.08/1.19: the realm list's category names and the name-alphabet mask (RealmCategoryMetadata.ts).
  { pathname: "/dbc/realm-categories", version: REALM_CATEGORIES_VERSION, load: loadRealmCategories },
  // 3.13a: the quest log headers of a QuestSort and the questTag names (QuestLogNameMetadata.ts).
  { pathname: "/dbc/quest-log-names", version: QUEST_LOG_NAMES_VERSION, load: loadQuestLogNames },
  // 3.23A: UnitCreatureType/UnitCreatureFamily names and the race and form types (CreatureTypeMetadata.ts).
  { pathname: "/dbc/creature-types", version: CREATURE_TYPES_VERSION, load: loadCreatureTypes },
  // 3.23C: melee crit from agility and the spirit regeneration tables (CharacterRegenMetadata.ts).
  { pathname: "/dbc/character-regen", version: CHARACTER_REGEN_VERSION, load: loadCharacterRegen },
  // 3.29/3.23F: the LEARN_SPELL and SKILL_STEP effects a trainer service's skill line comes from (SpellLearnEffectsMetadata.ts).
  { pathname: "/dbc/spell-learn-effects", version: SPELL_LEARN_EFFECTS_VERSION, load: loadSpellLearnEffects },
  // 11.02-F1: Vehicle, VehicleSeat and the seat-indicator tables, every column (VehicleMetadata.ts).
  { pathname: "/dbc/vehicles", version: VEHICLES_VERSION, load: loadVehicles },
  // 11.02-E-review: SpellMissile.dbc and every spell's SpellMissileID — the trajectory casts (SpellMissileMetadata.ts).
  { pathname: "/dbc/spell-missiles", version: SPELL_MISSILES_VERSION, load: loadSpellMissiles },
]);

/** The serialised answers, by pathname, for the dataset on disk: `DatasetIndexes.catalogs`. */
export type CatalogCache = Map<string, Promise<string>>;

export interface CatalogRouteOptions {
  readonly dbcDirectory?: string | undefined;
  readonly allowedOrigins: readonly string[];
}

function refuse(response: ServerResponse, status: number, origin: string | undefined): void {
  response.writeHead(status, origin ? { "access-control-allow-origin": origin } : {}).end();
}

/**
 * Answers the request if its path is one of `routes`; false leaves it to the rest of the gateway.
 *
 * Without a DBC directory nothing here matches, and the request falls through to the gateway's
 * 404, as the hand-written routes do.
 */
export async function serveCatalogRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  cache: CatalogCache,
  options: CatalogRouteOptions,
  routes: readonly CatalogRoute[] = CATALOG_ROUTES,
): Promise<boolean> {
  if (request.method !== "GET" || !options.dbcDirectory) return false;
  const route = routes.find((candidate) => candidate.pathname === url.pathname);
  if (!route) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  if (url.searchParams.get("v") !== String(route.version)) {
    refuse(response, 400, origin);
    return true;
  }
  const dbcDirectory = options.dbcDirectory;
  let body = cache.get(route.pathname);
  if (!body) {
    // Set before the first await, so two requests arriving together share one read.
    body = Promise.resolve().then(() => route.load(dbcDirectory)).then((catalog) => JSON.stringify(catalog));
    cache.set(route.pathname, body);
  }
  try {
    const data = await body;
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      // Fetched once per page; a rebuilt dataset resets the memo (DatasetFingerprint).
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(data);
  } catch {
    // Not the rejection again on the next request: the disk may have been mid-build.
    if (cache.get(route.pathname) === body) cache.delete(route.pathname);
    refuse(response, 500, origin);
  }
  return true;
}
