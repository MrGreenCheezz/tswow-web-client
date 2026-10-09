import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * The quest log's header and tag names (`/dbc/quest-log-names`, gateway/QuestLogNameMetadata.ts) for
 * plan item 3.13a: QuestSort names for the headers of a negative `ZoneOrSort`, QuestInfo names for
 * `GetQuestLogTitle`'s questTag.
 *
 * A gateway process older than the route answers 404 until the owner restarts it; the catalog
 * client retries on its own schedule (CatalogClient.ts). Until the table lands both lookups answer
 * undefined: a QuestSort header then has no name (the stock log draws "" for it, QuestLogFrame.lua:
 * 405-409) and a quest has no questTag, as for a type without a QuestInfo row.
 */

/** gateway/QuestLogNameMetadata.ts `QUEST_LOG_NAMES_VERSION`; tests/framexml-quest-log-groups.test.mjs pins the two together. */
export const QUEST_LOG_NAMES_ROUTE_VERSION = 1;
export const QUEST_LOG_NAMES_ROUTE_PATH = `/dbc/quest-log-names?v=${QUEST_LOG_NAMES_ROUTE_VERSION}`;

export interface QuestLogNameTable {
  readonly sorts: ReadonlyMap<number, string>;
  readonly infos: ReadonlyMap<number, string>;
}

function rowsOf(value: unknown): Map<number, string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const map = new Map<number, string>();
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2) return undefined;
    const [id, name] = row as unknown[];
    if (!Number.isSafeInteger(id) || typeof name !== "string") return undefined;
    map.set(id as number, name);
  }
  return map;
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function questLogNameTableFrom(data: unknown, version = QUEST_LOG_NAMES_ROUTE_VERSION): QuestLogNameTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; sorts?: unknown; infos?: unknown };
  if (value.version !== version) return undefined;
  const sorts = rowsOf(value.sorts);
  const infos = rowsOf(value.infos);
  return sorts && infos ? { sorts, infos } : undefined;
}

export class QuestLogNameClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<QuestLogNameTable>;
  readonly #listeners = new Set<() => void>();

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, QUEST_LOG_NAMES_ROUTE_PATH,
      (data) => questLogNameTableFrom(data), options);
    this.#catalog.onLoaded = () => { for (const listener of [...this.#listeners]) listener(); };
  }

  /** Told once the table lands (an open quest log redraws its headers); answers the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  get table(): QuestLogNameTable | undefined {
    return this.#catalog.value;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }

  /** The table, starting the first cycle if none has run (never restarting one that gave up). */
  #read(): QuestLogNameTable | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }

  /** QuestSort's `SortName_lang` by id (a header's key negated). */
  sortName(id: number): string | undefined {
    return this.#read()?.sorts.get(id);
  }

  /** QuestInfo's `InfoName_lang` by a quest's `Type`. */
  infoName(type: number): string | undefined {
    return this.#read()?.infos.get(type);
  }
}

let current: QuestLogNameClient | undefined;

/** The page's one quest-log name table for this gateway origin; another gateway is another table. */
export function questLogNameClient(gatewayOrigin: string | undefined): QuestLogNameClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new QuestLogNameClient(gatewayOrigin);
  return current;
}
