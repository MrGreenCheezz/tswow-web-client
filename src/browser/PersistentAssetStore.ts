/**
 * 22.10 (6.26): what the client keeps between sessions so a character is loaded once, not once per session — the
 * browser's half of the real client's WDB cache.
 *
 * Two spaces, both in IndexedDB of the page's origin (which also survives in Electron's profile):
 *
 * - `rows`: small JSON answers by id — display records out of `/dbc/creature-models`.
 * - `blobs`: composed character body atlases (CharacterAtlas.ts), as raw texels.
 *
 * Every record is filed under a generation the gateway published (gateway/AssetGeneration.ts): `metadataGeneration`
 * for rows, `visualGeneration` for atlases. The generation is part of the key, so a record of another generation
 * can never answer; the first use of a (gateway, kind, generation) in a session also deletes that gateway's records
 * of the kind under every other generation. Without a published generation nothing is read or written.
 *
 * Each space is bounded by a count, oldest use first out (`used`, touched at most once per session per record).
 * Every operation is best effort: a store that cannot be opened, a quota error or a private window degrades to
 * "nothing kept", never to an error the caller sees.
 */

/** One stored record. `key` is `<gateway>|<kind>|<generation>|<id>`. */
export interface StoredEntry {
  readonly key: string;
  readonly value: unknown;
  readonly used: number;
}

export type AssetSpace = "rows" | "blobs";

/** The persistence primitives; IndexedDB in the browser, a Map in tests. */
export interface AssetStoreBackend {
  getMany(space: AssetSpace, keys: readonly string[]): Promise<readonly (StoredEntry | undefined)[]>;
  put(space: AssetSpace, entries: readonly StoredEntry[]): Promise<void>;
  /** Sets `used` on the records that exist. */
  touch(space: AssetSpace, keys: readonly string[], used: number): Promise<void>;
  /** Deletes the records whose key starts with `prefix` and not with `keep`. */
  deleteOtherGenerations(space: AssetSpace, prefix: string, keep: string): Promise<void>;
  /** Deletes the least recently used records until at most `limit` remain. Returns how many went. */
  evict(space: AssetSpace, limit: number): Promise<number>;
  /** The keys stored under `prefix` (one generation of one kind). */
  keys(space: AssetSpace, prefix: string): Promise<readonly string[]>;
}

export interface PersistentAssetLimits {
  readonly rows: number;
  readonly blobs: number;
}

/** Twenty thousand display rows (~1 KiB each) and 256 bodies (1 MiB of texels each). */
export const PERSISTENT_ASSET_LIMITS: PersistentAssetLimits = Object.freeze({ rows: 20_000, blobs: 256 });

/** Bumped when a stored value's shape changes; part of every key. */
export const PERSISTENT_ASSET_SCHEMA = "p1";

const SEPARATOR = "|";

export function persistentAssetKey(gateway: string, kind: string, generation: string, id: string): string {
  return [PERSISTENT_ASSET_SCHEMA, gateway, kind, generation, id].join(SEPARATOR);
}

function kindPrefix(gateway: string, kind: string): string {
  return [PERSISTENT_ASSET_SCHEMA, gateway, kind, ""].join(SEPARATOR);
}

function generationPrefix(gateway: string, kind: string, generation: string): string {
  return [PERSISTENT_ASSET_SCHEMA, gateway, kind, generation, ""].join(SEPARATOR);
}

/** One space's puts are written together, a frame or so after the first. */
const WRITE_DELAY_MS = 250;

export class PersistentAssetStore {
  readonly #backend: AssetStoreBackend;
  readonly #limits: PersistentAssetLimits;
  readonly #now: () => number;
  readonly #pruned = new Set<string>();
  readonly #touched = new Set<string>();
  readonly #pending: Record<AssetSpace, StoredEntry[]> = { rows: [], blobs: [] };
  /**
   * Which ids a (space, gateway, kind, generation) holds: listed once per session, then kept up to date by `put`.
   * A miss — every lookup of a first session — then costs a set lookup instead of a database read, which under a
   * crowd's arrival waited tens of milliseconds behind everything else (the arrival probe).
   */
  readonly #known = new Map<string, Promise<Set<string>>>();
  readonly #timers: Record<AssetSpace, ReturnType<typeof setTimeout> | undefined> = { rows: undefined, blobs: undefined };
  #writes: Promise<unknown> = Promise.resolve();
  /** Records read and written this session, for the diagnostics and the tests. */
  readonly stats = { hits: 0, misses: 0, writes: 0, evicted: 0, failures: 0 };

  constructor(backend: AssetStoreBackend, limits: PersistentAssetLimits = PERSISTENT_ASSET_LIMITS,
    now: () => number = Date.now) {
    this.#backend = backend;
    this.#limits = limits;
    this.#now = now;
  }

  /** The values stored for `ids` under this generation, in order; undefined where none is. */
  async getMany<T>(space: AssetSpace, gateway: string, kind: string, generation: string,
    ids: readonly string[]): Promise<(T | undefined)[]> {
    if (ids.length === 0) return [];
    this.#prune(space, gateway, kind, generation);
    const known = await this.#knownIds(space, gateway, kind, generation);
    const wanted = ids.filter((id) => known.has(id));
    if (wanted.length === 0) {
      this.stats.misses += ids.length;
      return ids.map(() => undefined);
    }
    const keys = wanted.map((id) => persistentAssetKey(gateway, kind, generation, id));
    let found: readonly (StoredEntry | undefined)[];
    try {
      found = await this.#backend.getMany(space, keys);
    } catch {
      this.stats.failures++;
      return ids.map(() => undefined);
    }
    const byId = new Map(wanted.map((id, index) => [id, found[index]]));
    const entries = ids.map((id) => byId.get(id));
    const fresh: string[] = [];
    const values = entries.map((entry, index) => {
      if (entry === undefined || entry.key !== persistentAssetKey(gateway, kind, generation, ids[index]!)) {
        this.stats.misses++;
        return undefined;
      }
      this.stats.hits++;
      if (!this.#touched.has(entry.key)) {
        this.#touched.add(entry.key);
        fresh.push(entry.key);
      }
      return entry.value as T;
    });
    if (fresh.length > 0) {
      this.#writes = this.#writes.then(() => this.#backend.touch(space, fresh, this.#now())).catch(() => { this.stats.failures++; });
    }
    return values;
  }

  async get<T>(space: AssetSpace, gateway: string, kind: string, generation: string, id: string): Promise<T | undefined> {
    return (await this.getMany<T>(space, gateway, kind, generation, [id]))[0];
  }

  /** Queues values for writing under this generation; written together shortly after, then the space is bounded. */
  put(space: AssetSpace, gateway: string, kind: string, generation: string,
    entries: readonly (readonly [id: string, value: unknown])[]): void {
    if (entries.length === 0) return;
    this.#prune(space, gateway, kind, generation);
    const used = this.#now();
    const known = this.#knownIds(space, gateway, kind, generation);
    for (const [id, value] of entries) {
      const key = persistentAssetKey(gateway, kind, generation, id);
      this.#touched.add(key);
      this.#pending[space].push({ key, value, used });
      void known.then((ids) => ids.add(id));
    }
    if (this.#timers[space] !== undefined) return;
    this.#timers[space] = setTimeout(() => {
      this.#timers[space] = undefined;
      void this.flush(space);
    }, WRITE_DELAY_MS);
  }

  /** Writes what is queued in `space` now and bounds it. Resolves when done (tests, page hide). */
  flush(space?: AssetSpace): Promise<void> {
    for (const name of space === undefined ? (["rows", "blobs"] as const) : [space]) {
      const timer = this.#timers[name];
      if (timer !== undefined) clearTimeout(timer);
      this.#timers[name] = undefined;
      const batch = this.#pending[name].splice(0);
      if (batch.length === 0) continue;
      this.#writes = this.#writes
        .then(async () => {
          await this.#backend.put(name, batch);
          this.stats.writes += batch.length;
          this.stats.evicted += await this.#backend.evict(name, this.#limits[name]);
        })
        .catch(() => { this.stats.failures++; });
    }
    return this.#writes.then(() => undefined);
  }

  #knownIds(space: AssetSpace, gateway: string, kind: string, generation: string): Promise<Set<string>> {
    const prefix = generationPrefix(gateway, kind, generation);
    const marker = `${space}${SEPARATOR}${prefix}`;
    let known = this.#known.get(marker);
    if (known === undefined) {
      known = this.#backend.keys(space, prefix)
        .then((keys) => new Set(keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))))
        .catch(() => {
          this.stats.failures++;
          return new Set<string>();
        });
      this.#known.set(marker, known);
    }
    return known;
  }

  /** The first use of a (gateway, kind, generation) this session drops that gateway's other generations of the kind. */
  #prune(space: AssetSpace, gateway: string, kind: string, generation: string): void {
    const marker = `${space}${SEPARATOR}${gateway}${SEPARATOR}${kind}${SEPARATOR}${generation}`;
    if (this.#pruned.has(marker)) return;
    this.#pruned.add(marker);
    const prefix = kindPrefix(gateway, kind);
    this.#writes = this.#writes
      .then(() => this.#backend.deleteOtherGenerations(space, prefix, `${prefix}${generation}${SEPARATOR}`))
      .catch(() => { this.stats.failures++; });
  }
}

/** The test and fallback backend: the same semantics over two Maps. */
export class MemoryAssetBackend implements AssetStoreBackend {
  readonly spaces: Record<AssetSpace, Map<string, StoredEntry>> = { rows: new Map(), blobs: new Map() };

  async getMany(space: AssetSpace, keys: readonly string[]): Promise<readonly (StoredEntry | undefined)[]> {
    return keys.map((key) => this.spaces[space].get(key));
  }

  async put(space: AssetSpace, entries: readonly StoredEntry[]): Promise<void> {
    for (const entry of entries) this.spaces[space].set(entry.key, entry);
  }

  async touch(space: AssetSpace, keys: readonly string[], used: number): Promise<void> {
    const map = this.spaces[space];
    for (const key of keys) {
      const entry = map.get(key);
      if (entry) map.set(key, { ...entry, used });
    }
  }

  async deleteOtherGenerations(space: AssetSpace, prefix: string, keep: string): Promise<void> {
    for (const key of [...this.spaces[space].keys()]) {
      if (key.startsWith(prefix) && !key.startsWith(keep)) this.spaces[space].delete(key);
    }
  }

  async keys(space: AssetSpace, prefix: string): Promise<readonly string[]> {
    return [...this.spaces[space].keys()].filter((key) => key.startsWith(prefix));
  }

  async evict(space: AssetSpace, limit: number): Promise<number> {
    const map = this.spaces[space];
    const over = map.size - limit;
    if (over <= 0) return 0;
    const oldest = [...map.values()].sort((a, b) => a.used - b.used).slice(0, over);
    for (const entry of oldest) map.delete(entry.key);
    return oldest.length;
  }
}

const DATABASE = "webclient-assets";
const VERSION = 2;
/** The last key of a prefix's range: no stored key contains this code unit. */
const RANGE_END = String.fromCharCode(0xffff);

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** The small store beside each space that holds when each record was last used (`{ key, used }`, indexed on `used`). */
function usageStore(space: AssetSpace): string {
  return `${space}-used`;
}

/**
 * IndexedDB: one database per page origin; per space, the values (keyed on `key`) and, apart from them, when each was
 * last used. Apart, because touching a record must not rewrite it: a body is a mebibyte, and a read-write transaction
 * on the values store would also hold up every read behind it.
 */
export class IndexedDbAssetBackend implements AssetStoreBackend {
  readonly #database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory) {
    this.#database = new Promise((resolve, reject) => {
      const open = factory.open(DATABASE, VERSION);
      open.onupgradeneeded = () => {
        const database = open.result;
        // A layout this file no longer writes is dropped whole: it is a cache.
        for (const name of [...database.objectStoreNames]) database.deleteObjectStore(name);
        for (const space of ["rows", "blobs"] as const) {
          database.createObjectStore(space, { keyPath: "key" });
          database.createObjectStore(usageStore(space), { keyPath: "key" }).createIndex("used", "used");
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("asset store blocked"));
    });
    this.#database.catch(() => {});
  }

  async getMany(space: AssetSpace, keys: readonly string[]): Promise<readonly (StoredEntry | undefined)[]> {
    const store = (await this.#database).transaction(space, "readonly").objectStore(space);
    return Promise.all(keys.map((key) => request(store.get(key) as IDBRequest<{ key: string; value: unknown } | undefined>)
      .then((record) => record === undefined ? undefined : { key: record.key, value: record.value, used: 0 })));
  }

  async put(space: AssetSpace, entries: readonly StoredEntry[]): Promise<void> {
    const transaction = (await this.#database).transaction([space, usageStore(space)], "readwrite");
    const values = transaction.objectStore(space);
    const usage = transaction.objectStore(usageStore(space));
    for (const entry of entries) {
      values.put({ key: entry.key, value: entry.value });
      usage.put({ key: entry.key, used: entry.used });
    }
    await done(transaction);
  }

  async touch(space: AssetSpace, keys: readonly string[], used: number): Promise<void> {
    const transaction = (await this.#database).transaction(usageStore(space), "readwrite");
    const usage = transaction.objectStore(usageStore(space));
    for (const key of keys) usage.put({ key, used });
    await done(transaction);
  }

  async deleteOtherGenerations(space: AssetSpace, prefix: string, keep: string): Promise<void> {
    const transaction = (await this.#database).transaction([space, usageStore(space)], "readwrite");
    // The kind's key range minus the kept generation's: the two ranges either side of it.
    const end = `${prefix}${RANGE_END}`;
    const keepEnd = `${keep}${RANGE_END}`;
    for (const name of [space, usageStore(space)]) {
      const store = transaction.objectStore(name);
      if (prefix < keep) store.delete(IDBKeyRange.bound(prefix, keep, false, true));
      if (keepEnd < end) store.delete(IDBKeyRange.bound(keepEnd, end, true, false));
    }
    await done(transaction);
  }

  async keys(space: AssetSpace, prefix: string): Promise<readonly string[]> {
    const store = (await this.#database).transaction(usageStore(space), "readonly").objectStore(usageStore(space));
    const keys = await request(store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}${RANGE_END}`)));
    return keys.filter((key): key is string => typeof key === "string");
  }

  async evict(space: AssetSpace, limit: number): Promise<number> {
    const transaction = (await this.#database).transaction([space, usageStore(space)], "readwrite");
    const values = transaction.objectStore(space);
    const usage = transaction.objectStore(usageStore(space));
    const count = await request(usage.count());
    let over = count - limit;
    const removed = Math.max(0, over);
    if (over > 0) {
      const cursor = usage.index("used").openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at || over <= 0) return;
        values.delete(at.primaryKey);
        at.delete();
        over--;
        at.continue();
      };
    }
    await done(transaction);
    return removed;
  }
}

let shared: PersistentAssetStore | null | undefined;

/**
 * The realm's store, or null where there is no IndexedDB (Node, an old worker, a browser that refuses it). One per
 * realm: the page and the render worker each open the same database.
 */
export function persistentAssetStore(): PersistentAssetStore | null {
  if (shared !== undefined) return shared;
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    shared = factory === undefined ? null : new PersistentAssetStore(new IndexedDbAssetBackend(factory));
  } catch {
    shared = null;
  }
  return shared;
}

/** For tests: replaces the realm's store (null: none). */
export function setPersistentAssetStore(store: PersistentAssetStore | null | undefined): void {
  shared = store;
}
