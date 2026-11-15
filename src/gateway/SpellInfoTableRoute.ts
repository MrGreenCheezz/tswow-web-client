// 3.43 (15.11, names10): `/dbc/spell-info?v=<SPELL_INFO_TABLE_VERSION>` — every spell of the dataset as the compact
// table the by-id spell globals answer from (src/world/SpellInfoTable.ts; browser half src/browser/SpellInfoTableClient.ts).
//
// Built from the very rows `/dbc/spells` serves (`indexes.spellMetadata`, gateway/SpellMetadata.ts — the same parse, the
// same locale), encoded once per parse: a rebuilt dataset drops that parse (DatasetIndexes.reset), and the memo below,
// keyed by the parse's promise, goes with it. Measured on this dataset (49,840 rows, node 22, this machine): the parse
// 1.5 s (shared with `/dbc/spells`, which the spellbook asks at entry anyway), the encoding 0.46 s, 7.32 MB raw, 0.95 MB
// gzip 6 / 0.92 MB brotli 4 through ResponseCompression.ts.
//
// Caching: immutable for a year when the URL names this gateway's metadata generation (`mg=`, AssetGeneration.ts: its
// code and the dataset's DBC half — the table is a function of both), else revalidated, and ContentEtag.ts then answers a
// second entry's revalidation with a 304 by the bytes' tag. Same Origin rule (403) and shape rule (`?v=`, 400) as the
// catalog routes; a failed read is a 500 and the next request reads again.

import type { IncomingMessage, ServerResponse } from "node:http";
import { METADATA_GENERATION_PARAM, assetCacheControl } from "./AssetGeneration.js";
import { REVALIDATE } from "./CachePolicy.js";
import type { SpellMetadata } from "./SpellMetadata.js";
import { originAllowed } from "./UpgradeGuard.js";
import { SPELL_INFO_TABLE_PATH, SPELL_INFO_TABLE_VERSION, encodeSpellInfoTable } from "../world/SpellInfoTable.js";

export interface SpellInfoTableRouteOptions {
  readonly dbcDirectory?: string | undefined;
  readonly allowedOrigins: readonly string[];
  /** The memoised `/dbc/spells` parse (`indexes.spellMetadata ??= loadSpellMetadata(…)`). */
  readonly spells: () => Promise<Map<number, SpellMetadata>>;
  /** This request's metadata generation (AssetGeneration.ts), undefined when there is none. */
  readonly metadataGeneration: string | undefined;
}

const encoded = new WeakMap<Promise<Map<number, SpellMetadata>>, Promise<Uint8Array>>();

/** Answers `/dbc/spell-info`; false leaves any other request to the rest of the gateway. */
export async function serveSpellInfoTable(request: IncomingMessage, response: ServerResponse, url: URL,
  options: SpellInfoTableRouteOptions): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== SPELL_INFO_TABLE_PATH || !options.dbcDirectory) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  if (url.searchParams.get("v") !== String(SPELL_INFO_TABLE_VERSION)) {
    response.writeHead(400, origin ? { "access-control-allow-origin": origin } : {}).end();
    return true;
  }
  const parse = options.spells();
  let body = encoded.get(parse);
  if (!body) {
    body = parse.then((spells) => encodeSpellInfoTable(spells.values()));
    encoded.set(parse, body);
  }
  try {
    const data = await body;
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": assetCacheControl(url.searchParams.get(METADATA_GENERATION_PARAM), options.metadataGeneration, REVALIDATE),
      "content-type": "application/octet-stream",
      vary: "Origin",
    });
    response.end(data);
  } catch {
    if (encoded.get(parse) === body) encoded.delete(parse);
    response.writeHead(500, origin ? { "access-control-allow-origin": origin } : {}).end();
  }
  return true;
}
