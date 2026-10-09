import type { CreatureMetadata } from "../gateway/CreatureMetadata.js";
import type { EventBus, Unsubscribe, WorldPacketEvents } from "../world/EventBus.js";
import type { CreatureTemplate } from "../world/QueryCacheProtocol.js";
import { creatureFamilyIconUrl, spellIconUrl } from "./ui/IconImage.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

export type { CreatureMetadata };

/**
 * What this client needs of the world: the query, and the news that one was answered.
 *
 * Narrower than `WorldClient` so that a test can answer a query without a socket, and so that the
 * dependency reads as what it is — the dump is the first answer, the wire is the correction.
 */
export interface CreatureQuerySource {
  creatureTemplate(entry: number, guid?: bigint): CreatureTemplate | undefined;
  readonly events: Pick<EventBus<WorldPacketEvents>, "on">;
}

const TYPE_ICONS: Partial<Record<number, number>> = {
  1: 1573,
  2: 1548,
  3: 214,
  4: 2134,
  5: 84,
  6: 221,
  7: 2273,
  8: 1522,
  9: 656,
  11: 689,
  12: 1522,
  13: 1960,
};

// L1 (3.23): CreatureType.dbc Name_lang (ruRU) — 1, 8, 10 and 13 were not the table's words (tests/creature-type-names).
const TYPE_NAMES: Partial<Record<number, string>> = {
  1: "Животное", // L1 (3.23)
  2: "Дракон",
  3: "Демон",
  4: "Элементаль",
  5: "Великан",
  6: "Нежить",
  7: "Гуманоид",
  8: "Существо", // L1 (3.23)
  9: "Механизм",
  10: "Не указано", // L1 (3.23)
  11: "Тотем",
  12: "Спутник",
  13: "Облако газа", // L1 (3.23)
};

/**
 * The little picture beside a creature's name: its pet family's own, or the glyph for its type.
 *
 * The fallback is a spell icon id and not a file — 2,273 is the question mark — so both halves go
 * through the gateway's icon routes, and a module that gives its own creature family an icon gets
 * it here without anything being rebuilt.
 */
export function creatureIconSource(metadata: CreatureMetadata | undefined, gatewayOrigin: string | undefined): string {
  const family = metadata?.family ? creatureFamilyIconUrl(metadata.family, gatewayOrigin) : undefined;
  return family ?? spellIconUrl(TYPE_ICONS[metadata?.type ?? 0] ?? 2273, gatewayOrigin)!;
}

export function creatureTypeName(type: number | undefined): string {
  return TYPE_NAMES[type ?? 0] ?? "Существо";
}

export class CreatureMetadataClient {
  readonly #baseUrl: string;
  readonly #cache = new Map<number, CreatureMetadata>();
  readonly #requested = new Set<number>();
  readonly #httpPending = new Set<number>();
  readonly #wirePending = new Set<number>();
  readonly #failures = new Map<number, { attempts: number; after: number }>();
  #world: CreatureQuerySource | undefined;
  #changed: (() => void) | undefined;
  #attachedUnsubscribe: Unsubscribe | undefined;
  readonly #abort = new AbortController();
  #disposed = false;
  #pendingRequests = 0;
  #success = 0;
  #error = 0;
  #generation = 0;
  readonly #now: () => number;

  /** Immutable current ownership; unresolved world queries remain pending after HTTP settles. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    const pending = new Set<number>([...this.#httpPending, ...this.#wirePending]);
    for (const [entry, failure] of this.#failures) {
      if (failure.after !== Infinity && !this.#httpPending.has(entry)) pending.add(entry);
    }
    return Object.freeze({
      pending: pending.size,
      success: this.#success,
      error: [...this.#failures.values()].filter((failure) => failure.after === Infinity).length,
      generation: this.#generation,
    });
  }

  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#generation;
  }

  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#now = now;
  }

  /**
   * Puts the world behind the dump: every entry asked about is also asked of the server.
   *
   * The dump is generated from `creature_template` and `creature_template_locale` by
   * `npm run assets:creatures`, so it is those two tables as they stood when the generator last
   * ran — here 14:32 on 23 August, which is the only reason a module's own entry 45000 is in it
   * at all. A row written since is simply not in the file, and the route invents nothing in its
   * place: it maps the entries asked for over its own table and drops the misses (`Gateway.ts`,
   * `entries.map((entry) => metadata.get(entry)).filter(Boolean)`), so a miss is a shorter array
   * and never somebody else's name. Measured against the gateway on this machine,
   * `/data/creatures?entries=190011` — one past the dump's largest entry — answers `[]`, and the
   * object wearing that entry is drawn as «unit · entry 190011» (`Frames.ts:222`).
   * The query is the same two tables read at run time, in the session's locale
   * (`QueryHandler.cpp` builds the answer with `GetSessionDbLocaleIndex()`), so this does not
   * settle whether the database holds Russian strings — it moves the question from build time to
   * run time, where a module author can fix it without regenerating anything.
   *
   * `onChanged` is the repaint. It is the caller's because this file must not know what a frame
   * is; `EnterWorld` gives it the same `queueWorldState` that `loadCreatureMetadata` already uses.
   */
  attach(world: CreatureQuerySource, onChanged: () => void): void {
    if (this.#disposed) return;
    this.#world = world;
    this.#changed = onChanged;
    // Reattaching this instance replaces its subscription; dispose retires a whole character.
    this.#attachedUnsubscribe?.();
    this.#attachedUnsubscribe = world.events.on("QUERY_CACHE_CHANGED", (change) => {
      // `cleared` is `SMSG_CLIENTCACHE_VERSION`: the realm's data moved under the session, so
      // everything asked so far may be asked again. The answers already held are kept until the
      // new ones arrive — a name that is one build old reads better than no name at all.
      if (change.kind === "cleared") {
        this.#requested.clear();
        this.#wirePending.clear();
        this.#failures.clear();
        return;
      }
      if (change.kind !== "creature" || typeof change.id !== "number") return;
      this.#wirePending.delete(change.id);
      this.#absorb(change.id);
    });
  }

  get(entry: number): CreatureMetadata | undefined {
    return this.#cache.get(entry);
  }

  /** A character owns this cache, but the query bus may survive its logout. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#attachedUnsubscribe?.();
    this.#attachedUnsubscribe = undefined;
    this.#world = undefined;
    this.#changed = undefined;
    this.#abort.abort();
    this.#cache.clear();
    this.#requested.clear();
    this.#httpPending.clear();
    this.#wirePending.clear();
    this.#failures.clear();
    this.#pendingRequests = 0;
    this.#generation++;
  }

  async load(entries: readonly number[]): Promise<boolean> {
    if (this.#disposed) return false;
    const now = this.#now();
    const missing = [...new Set(entries)].filter((entry) => entry > 0 && !this.#requested.has(entry)
      && (this.#failures.get(entry)?.after ?? 0) <= now);
    if (missing.length === 0) return false;
    for (const entry of missing) {
      this.#requested.add(entry);
      this.#httpPending.add(entry);
      this.#failures.delete(entry);
    }
    this.#pendingRequests += missing.length;
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled || this.#disposed) return;
      settled = true;
      this.#pendingRequests -= missing.length;
      for (const entry of missing) this.#httpPending.delete(entry);
      this.#generation++;
      if (success) this.#success += missing.length;
      else this.#error += missing.length;
    };
    // Before the fetch, and for every entry rather than only for the ones the dump misses: the
    // wire is the newer of the two answers, and a gateway that is down must not also cost the
    // names the world session could have given. `WorldClient.creatureTemplate` remembers what it
    // has asked, so this is one `CMSG_CREATURE_QUERY` per entry for the life of the session even
    // when the fetch below fails and re-arms these entries.
    try {
      for (const entry of missing) {
        const template = this.#world?.creatureTemplate(entry);
        if (this.#world && !template) this.#wirePending.add(entry);
        else this.#absorb(entry, false);
      }
    } catch (error) {
      for (const entry of missing) {
        this.#requested.delete(entry);
        this.#httpPending.delete(entry);
      }
      settle(false);
      throw error;
    }
    try {
      const response = await fetch(`${this.#baseUrl}/data/creatures?entries=${missing.join(",")}`,
        { signal: this.#abort.signal });
      if (this.#disposed) return false;
      if (!response.ok) throw new Error(`Creature metadata gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (this.#disposed) return false;
      if (!Array.isArray(value) || !value.every(isCreatureMetadata)) throw new Error("Creature metadata gateway returned invalid data");
      for (const metadata of value) {
        const previous = this.#cache.get(metadata.entry);
        this.#cache.set(metadata.entry, metadata);
        if (!sameCreatureMetadata(previous, metadata)) this.#generation++;
        // The query went out before this fetch and may already have been answered. The wire is the
        // newer of the two, so it goes back on top rather than being lost to the dump landing
        // second; the caller repaints for the whole batch, so this one does not.
        this.#absorb(metadata.entry, false);
      }
      settle(true);
      return true;
    } catch (error) {
      // Cancellation belongs to the retired character. Live request errors still surface below.
      if (this.#disposed) return false;
      for (const entry of missing) this.#requested.delete(entry);
      for (const entry of missing) this.#httpPending.delete(entry);
      for (const entry of missing) {
        const attempts = (this.#failures.get(entry)?.attempts ?? 0) + 1;
        const wait = CREATURE_METADATA_RETRY_MS[attempts - 1];
        this.#failures.set(entry, {
          attempts,
          after: wait === undefined ? Infinity : this.#now() + wait,
        });
      }
      settle(false);
      throw error;
    }
  }

  /**
   * Puts one query answer over the dump's row, or in place of it.
   *
   * A row the dump has keeps its type, family and rank: those decide the icon, and the query
   * carries them out of the same `creature_template` columns, so rewriting them changes nothing
   * and would let a mid-session answer redraw an icon for no reason. What the query is here for
   * is the two strings, which are the half a module can change and the half that is localised.
   * An entry the dump has never heard of has nothing else to be built from, so it is built from
   * the answer whole — that is the custom creature naming itself instead of showing «entry 45000».
   */
  #absorb(entry: number, repaint = true): void {
    const template = this.#world?.creatureTemplate(entry);
    if (!template?.found) return;
    const known = this.#cache.get(entry);
    if (known && known.name === template.name && known.subname === template.subName) return;
    const next = known
      ? { ...known, name: template.name, subname: template.subName }
      : {
        entry,
        name: template.name,
        subname: template.subName,
        type: template.creatureType,
        family: template.creatureFamily,
        rank: template.classification,
      };
    if (!sameCreatureMetadata(known, next)) {
      this.#cache.set(entry, next);
      this.#generation++;
    }
    if (repaint) this.#changed?.();
  }
}

const CREATURE_METADATA_RETRY_MS: readonly number[] = [2_000, 8_000, 30_000];

function sameCreatureMetadata(left: CreatureMetadata | undefined, right: CreatureMetadata): boolean {
  return left?.entry === right.entry && left.name === right.name && left.subname === right.subname
    && left.type === right.type && left.family === right.family && left.rank === right.rank;
}

function isCreatureMetadata(value: unknown): value is CreatureMetadata {
  if (!value || typeof value !== "object") return false;
  const creature = value as Record<string, unknown>;
  return typeof creature.entry === "number"
    && typeof creature.name === "string"
    && typeof creature.subname === "string"
    && typeof creature.type === "number"
    && typeof creature.family === "number"
    && typeof creature.rank === "number";
}
