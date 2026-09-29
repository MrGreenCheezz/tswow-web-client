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
