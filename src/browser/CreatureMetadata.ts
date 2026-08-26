import type { CreatureMetadata } from "../gateway/CreatureMetadata.js";
import type { EventBus, WorldPacketEvents } from "../world/EventBus.js";
import type { CreatureTemplate } from "../world/QueryCacheProtocol.js";
import { creatureFamilyIconUrl, spellIconUrl } from "./ui/IconImage.js";

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

const TYPE_NAMES: Partial<Record<number, string>> = {
  1: "Зверь",
  2: "Дракон",
  3: "Демон",
  4: "Элементаль",
  5: "Великан",
  6: "Нежить",
  7: "Гуманоид",
  8: "Зверёк",
  9: "Механизм",
  11: "Тотем",
  12: "Спутник",
  13: "Газовое облако",
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
  #world: CreatureQuerySource | undefined;
  #changed: (() => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
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
    this.#world = world;
    this.#changed = onChanged;
    world.events.on("QUERY_CACHE_CHANGED", (change) => {
      // `cleared` is `SMSG_CLIENTCACHE_VERSION`: the realm's data moved under the session, so
      // everything asked so far may be asked again. The answers already held are kept until the
      // new ones arrive — a name that is one build old reads better than no name at all.
      if (change.kind === "cleared") {
        this.#requested.clear();
        return;
      }
      if (change.kind !== "creature" || typeof change.id !== "number") return;
      this.#absorb(change.id);
    });
  }

  get(entry: number): CreatureMetadata | undefined {
    return this.#cache.get(entry);
  }

  async load(entries: readonly number[]): Promise<boolean> {
    const missing = [...new Set(entries)].filter((entry) => entry > 0 && !this.#requested.has(entry));
    if (missing.length === 0) return false;
    for (const entry of missing) this.#requested.add(entry);
    // Before the fetch, and for every entry rather than only for the ones the dump misses: the
    // wire is the newer of the two answers, and a gateway that is down must not also cost the
    // names the world session could have given. `WorldClient.creatureTemplate` remembers what it
    // has asked, so this is one `CMSG_CREATURE_QUERY` per entry for the life of the session even
    // when the fetch below fails and re-arms these entries.
    for (const entry of missing) this.#world?.creatureTemplate(entry);
    try {
      const response = await fetch(`${this.#baseUrl}/data/creatures?entries=${missing.join(",")}`);
      if (!response.ok) throw new Error(`Creature metadata gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value) || !value.every(isCreatureMetadata)) throw new Error("Creature metadata gateway returned invalid data");
      for (const metadata of value) {
        this.#cache.set(metadata.entry, metadata);
        // The query went out before this fetch and may already have been answered. The wire is the
        // newer of the two, so it goes back on top rather than being lost to the dump landing
        // second; the caller repaints for the whole batch, so this one does not.
        this.#absorb(metadata.entry, false);
      }
      return true;
    } catch (error) {
      for (const entry of missing) this.#requested.delete(entry);
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
    this.#cache.set(entry, known
      ? { ...known, name: template.name, subname: template.subName }
      : {
        entry,
        name: template.name,
        subname: template.subName,
        type: template.creatureType,
        family: template.creatureFamily,
        rank: template.classification,
      });
    if (repaint) this.#changed?.();
  }
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
