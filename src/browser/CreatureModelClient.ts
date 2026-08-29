import type { CreatureModelMetadata } from "../gateway/CreatureModelMetadata.js";
import type { EquippedItem } from "../gateway/CharacterAppearance.js";
import {
  CHARACTER_APPEARANCE_VERSION, CREATURE_MODEL_VERSION, IMAGE_RETRY_BACKOFF_MS,
  type CharacterAppearance,
} from "./CharacterAtlas.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

export type { CreatureModelMetadata, EquippedItem };

/** A display record plus, for a player, the look resolved from its appearance bytes. */
export interface UnitModel extends CreatureModelMetadata {
  appearance?: CharacterAppearance;
  /** True while one of the player's visible item rows is still missing from ItemMetadata. */
  appearancePending?: boolean;
}

/**
 * Resolves UNIT_FIELD_DISPLAYID to the M2 a creature or player actually wears, through
 * CreatureDisplayInfo and CreatureModelData. Requests are batched; a look that failed is asked for
 * again on the same backoff a texture is (`IMAGE_RETRY_BACKOFF_MS`).
 */
export class CreatureModelClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #cache = new Map<number, CreatureModelMetadata>();
  readonly #requested = new Set<number>();
  readonly #appearances = new Map<string, CharacterAppearance>();
  readonly #requestedAppearances = new Set<string>();
  /**
   * Looks whose fetch failed: how many times, and when to ask again.
   *
   * The key stays out of `#requestedAppearances` while it waits, and this is what stops the wait
   * being a request per frame. Т6: before it, one non-2xx — a 500 from a gateway still building an
   * index, a dropped connection — killed that look for the life of the tab, and the unit wearing it
   * kept its capsule with the ledger correctly, and uselessly, saying «внешность не вернулась».
   */
  readonly #appearanceFailures = new Map<string, { attempts: number; after: number }>();
  /** The same ledger for display ids, on the same ladder; see the `catch` in `#flush`. */
  readonly #failures = new Map<number, { attempts: number; after: number }>();
  /** A successful batch may legitimately omit an id; retain that negative answer explicitly. */
  readonly #negative = new Set<number>();
  readonly #now: () => number;
  #pending: number[] = [];
  #flushing = false;
  #pendingRequests = 0;
  #success = 0;
  #error = 0;
  #generation = 0;

  /** Immutable current async ownership; lifetime attempt totals are not readiness errors. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    const pending = this.#pendingRequests
      + [...this.#failures.entries()].filter(([id, failure]) =>
        failure.after !== Infinity && !this.#requested.has(id)).length
      + [...this.#appearanceFailures.entries()].filter(([key, failure]) =>
        failure.after !== Infinity && !this.#requestedAppearances.has(key)).length;
    return Object.freeze({
      pending,
      success: this.#success,
      error: this.#negative.size
        + [...this.#failures.values()].filter((failure) => failure.after === Infinity).length
        + [...this.#appearanceFailures.values()].filter((failure) => failure.after === Infinity).length,
      generation: this.#generation,
    });
  }

  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#generation;
  }

  /** @param now the clock the backoff is measured against; injected so a test need not wait. */
  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#now = now;
  }

  get(displayId: number): CreatureModelMetadata | undefined {
    return this.#cache.get(displayId);
  }

  /**
   * A player's look, from the appearance bytes the server publishes: the textures to paint its
   * body from, the hair texture, and which geosets to draw. Returns undefined until the answer
   * arrives — the unit keeps its stand-in rather than appearing with the wrong face.
   */
  playerAppearance(race: number, sex: number, skin: number, face: number, hairStyle: number,
    hairColor: number, facialHair: number,
    equipment: readonly EquippedItem[] = []): CharacterAppearance | undefined {
    // Equipment belongs in the key: changing armour changes the body texture, the geosets and
    // what hangs off the bones, so it is a different appearance and a different composed atlas.
    // Sorted for a stable identity — the order it paints in is the gateway's decision, not this
    // list's, so sorting here cannot reach the picture.
    // The subclass is part of the look identity as well as the gateway payload: INVTYPE_RANGEDRIGHT
    // covers both guns and wands, and reusing the gun appearance after the item query resolves a
    // wand would leave the attached model right while its shoot pose stays wrong.
    const worn = equipment.map((item) => `${item.slot}:${item.inventoryType}:${item.displayId}`
      + (item.subClass === undefined ? "" : `:${item.subClass}`)).sort().join(",");
    const key = `${race}/${sex}/${skin}/${face}/${hairStyle}/${hairColor}/${facialHair}/${worn}`;
    const known = this.#appearances.get(key);
    if (known !== undefined) return known;
    if (this.#requestedAppearances.has(key)) return undefined;
    const failure = this.#appearanceFailures.get(key);
    if (failure && this.#now() < failure.after) return undefined;
    const attempt = (failure?.attempts ?? 0) + 1;
    this.#requestedAppearances.add(key);
    this.#pendingRequests++;
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#pendingRequests--;
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    void (async () => {
      try {
        // The payload's shape is part of the URL; `CHARACTER_APPEARANCE_VERSION` says why, and is
        // shared with the lab so that the two ask for exactly the same thing.
        //
        // Note what the bump cannot do. The *gateway* memoises the whole index (`Gateway.ts`,
        // `characterAppearance ??=`), so until the process that is running has been restarted onto
        // a build that knows the new field, every `v=` in the world gets the same old answer — and
        // the browser then holds that answer for the life of the tab, because a look that has
        // arrived is never asked for again. The player needs a reload after the restart, not
        // before it.
        const query = `v=${CHARACTER_APPEARANCE_VERSION}&race=${race}&sex=${sex}&skin=${skin}&face=${face}`
          + `&hair=${hairStyle}&hairColor=${hairColor}&facialHair=${facialHair}`
          + (worn ? `&items=${encodeURIComponent(worn)}` : "");
        const response = await fetch(`${this.#baseUrl}/dbc/character-appearance?${query}`);
        if (!response.ok) throw new Error(`Character appearance gateway returned ${response.status}`);
        const value = await response.json() as CharacterAppearance;
        if (!isAppearance(value)) throw new Error("malformed appearance");
        this.#appearances.set(key, value);
        this.#appearanceFailures.delete(key);
        settle(true);
      } catch (error) {
        // Asked for again after a wait, not every frame and not never. The key comes back out of
        // the requested set so the next frame past `after` really re-requests it; three retries
        // over forty seconds and then it is left alone, and the unit keeps its stand-in.
        this.#requestedAppearances.delete(key);
        const wait = IMAGE_RETRY_BACKOFF_MS[attempt - 1];
        this.#appearanceFailures.set(key, {
          attempts: attempt,
          after: wait === undefined ? Infinity : this.#now() + wait,
        });
        settle(false);
        this.onStatus?.(`внешность персонажа: ${error instanceof Error ? error.message : String(error)}`, true);
      } finally {
        settle(false);
      }
    })();
    return undefined;
  }

  /** Asks for a display id if it has not been seen; the answer arrives on a later frame. */
  request(displayId: number): void {
    if (displayId <= 0 || this.#requested.has(displayId)) return;
    if (this.#negative.has(displayId)) return;
    const failure = this.#failures.get(displayId);
    if (failure && this.#now() < failure.after) return;
    this.#requested.add(displayId);
    this.#pending.push(displayId);
    this.#pendingRequests++;
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#pending.length > 0) {
        // The gateway accepts at most 200 ids per call.
        const batch = this.#pending.splice(0, 200);
        let settled = false;
        const settle = (success: boolean): void => {
          if (settled) return;
          settled = true;
          this.#pendingRequests -= batch.length;
          this.#generation++;
          if (success) this.#success += batch.length;
          else this.#error += batch.length;
        };
        try {
          // `v` is not read by the gateway: it is there to break the browser's own HTTP cache.
          // This route answers `max-age=3600` and an id that has been requested is never requested
          // again, so a deploy that adds a field to the record would otherwise be served an hour of
          // pre-upgrade responses and then never ask again. `CREATURE_MODEL_VERSION` is shared
          // with the lab, which fetches the same route for the same reason.
          const response = await fetch(
            `${this.#baseUrl}/dbc/creature-models?v=${CREATURE_MODEL_VERSION}&ids=${batch.join(",")}`);
          if (!response.ok) throw new Error(`Creature model gateway returned ${response.status}`);
          const value: unknown = await response.json();
          if (!Array.isArray(value) || !value.every(isMetadata)) throw new Error("Creature model gateway returned invalid data");
          const returned = new Set<number>();
          for (const metadata of value) {
            if (!batch.includes(metadata.id)) continue;
            returned.add(metadata.id);
            const previous = this.#cache.get(metadata.id);
            this.#cache.set(metadata.id, metadata);
            if (previous !== metadata) this.#generation++;
            this.#failures.delete(metadata.id);
            this.#negative.delete(metadata.id);
          }
          // A short successful response is still a settled answer. Keep omitted ids terminal so
          // a capsule cannot be certified merely because the HTTP request itself was successful.
          for (const id of batch) {
            if (returned.has(id)) continue;
            this.#negative.add(id);
            this.#failures.delete(id);
          }
          settle(true);
          this.onStatus?.(`моделей существ: ${this.#cache.size}`, false);
        } catch (error) {
          // Asked for again after a wait, not every frame and not never. The ids used to stay in
          // `#requested` for the life of the tab, so one failed batch — a 500 from a gateway still
          // building its index, a dropped connection — was permanent: `get` answered undefined for
          // good, `Frames.unitModel` answered undefined with it, and `#drawUnit` leaves the node
          // alone when it does, so a druid who shifted during that batch stayed a night elf until
          // the page was reloaded. Same ladder as a texture and a look (`IMAGE_RETRY_BACKOFF_MS`):
          // 2 s, 8 s, 30 s, and then the id is left alone.
          for (const id of batch) {
      this.#requested.delete(id);
            const attempt = (this.#failures.get(id)?.attempts ?? 0) + 1;
            const wait = IMAGE_RETRY_BACKOFF_MS[attempt - 1];
            this.#failures.set(id, {
              attempts: attempt,
              after: wait === undefined ? Infinity : this.#now() + wait,
            });
          }
          settle(false);
          this.onStatus?.(error instanceof Error ? error.message : String(error), true);
        }
      }
    } finally {
      this.#flushing = false;
    }
  }
}

/** A display record may now carry a whole appearance, and it is built from, so it is checked. */
function isAppearance(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const appearance = value as Record<string, unknown>;
  return Array.isArray(appearance.body) && Array.isArray(appearance.geosets)
    && Array.isArray(appearance.attached)
    && typeof appearance.hair === "string" && typeof appearance.cloak === "string";
}

function isMetadata(value: unknown): value is CreatureModelMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return isAppearance(metadata.appearance)
    && typeof metadata.id === "number" && typeof metadata.model === "string"
    && typeof metadata.scale === "number" && Number.isFinite(metadata.scale) && metadata.scale > 0
    // Zero is a real answer here — the model declares no collision height and the reader falls
    // back to the core's default — so this checks the number, not that it is positive.
    && typeof metadata.collisionHeight === "number" && Number.isFinite(metadata.collisionHeight)
    // And zero is a real answer here for the same reason: 917 of the 1,331 rows of
    // `CreatureModelData` name no seat, and the renderer falls back to the model's own bounds.
    && typeof metadata.mountHeight === "number" && Number.isFinite(metadata.mountHeight)
    && typeof metadata.textures === "string";
}
