import { decodeCollisionModel, type CollisionModel } from "../world/CollisionFormat.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

export type { CollisionModel };

/** A failed HTTP/decode answer is not an authored "no collision" answer. Retry without spinning. */
const COLLISION_RETRY_BASE_MS = 100;
const COLLISION_RETRY_MAX_MS = 5_000;

/**
 * The server's own collision meshes, by the name the vmap tile calls them.
 *
 * Separate from the model client that feeds the renderer, and it has to be: a building has both a
 * visual mesh and a collision mesh and they are different files describing different things. The
 * one the player sees is the artists'; the one the player bumps into is the server's, and only the
 * second can be trusted to agree with where the server thinks a wall is.
 *
 * Big models arrive as a table of their groups' boxes and nothing else — a city is hundreds of
 * thousands of triangles — and the geometry for the handful of groups the player is standing in is
 * asked for afterwards.
 */
export class CollisionClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #models = new Map<string, CollisionModel | null>();
  readonly #requested = new Set<string>();
  readonly #requestedGroups = new Set<string>();
  readonly #retryAttempts = new Map<string, number>();
  readonly #retryAfter = new Map<string, number>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #queue: string[] = [];
  readonly #errors = new Set<string>();
  #active = 0;
  #pending = 0;
  #success = 0;
  #error = 0;
  /** Bumped whenever geometry lands, so the world knows to rebuild what it could not build before. */
  #revision = 0;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Immutable exact model/group request counters; requested names are lifetime cache state. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    return Object.freeze({
      // Queue entries are pending work too; lifetime requested names below are not.
      pending: this.#pending + this.#queue.length,
      success: this.#success,
      error: this.#errors.size,
      generation: this.#revision,
    });
  }

  /** The model, or undefined until it lands. A model the client does not ship resolves to null. */
  model(name: string): CollisionModel | undefined {
    const known = this.#models.get(name);
    if (known !== undefined) return known ?? undefined;
    if (!this.#requested.has(name) && this.#retryDue(name)) {
      this.#requested.add(name);
      this.#queue.push(name);
      this.#drain();
    }
    return undefined;
  }

  /** Whether the gateway has answered this model, including a 204/no-collision answer. */
  isResolved(name: string): boolean {
    return this.#models.has(name);
  }

  /**
   * Asks for the geometry of specific groups of a model that was too big to send whole.
   *
   * Asked for once per group and never again: a group whose geometry never arrives is a group the
   * player walks through, which is bad, and a group asked for every frame is a request storm,
   * which is worse.
   */
  requestGroups(name: string, groups: readonly number[]): void {
    const missing = groups.filter((group) => {
      const key = `${name}#${group}`;
      return !this.#requestedGroups.has(key) && this.#retryDue(key);
    });
    if (missing.length === 0) return;
    for (const group of missing) this.#requestedGroups.add(`${name}#${group}`);
    this.#pending++;
    void this.#fetchGroups(name, missing);
  }

  #drain(): void {
    while (this.#active < 4) {
      const name = this.#queue.shift();
      if (!name) return;
      this.#active++;
      this.#pending++;
      void this.#load(name).finally(() => {
        this.#active--;
        this.#drain();
      });
    }
  }

  #retryDue(key: string): boolean {
    return Date.now() >= (this.#retryAfter.get(key) ?? 0);
  }

  /**
   * Leave a failed resource unresolved and wake the owning collision source after bounded backoff.
   * The source's normal rebuild then asks again; the timer never downloads behind its back.
   */
  #retryLater(key: string): void {
    const attempt = (this.#retryAttempts.get(key) ?? 0) + 1;
    this.#retryAttempts.set(key, attempt);
    const delay = Math.min(COLLISION_RETRY_MAX_MS, COLLISION_RETRY_BASE_MS * 2 ** Math.min(6, attempt - 1));
    this.#retryAfter.set(key, Date.now() + delay);
    const previous = this.#retryTimers.get(key);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#retryTimers.delete(key);
      // The caller keys rebuilds on this revision. Without the wake-up it would see the cooldown
      // once, go idle, and never call `model`/`requestGroups` after the deadline.
      this.#revision++;
    }, delay);
    this.#retryTimers.set(key, timer);
  }

  #clearRetry(key: string): void {
    this.#retryAttempts.delete(key);
    this.#retryAfter.delete(key);
    const timer = this.#retryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#retryTimers.delete(key);
  }

  async #load(name: string): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#pending--;
      this.#revision++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(`${this.#baseUrl}/collision/model/${encodeURIComponent(name)}?v=3`);
      if (response.status === 204 || response.status === 404) {
        // The extractor wrote no collision for this model, which is its way of saying it has none.
        // 404 remains accepted for older gateways; the current route uses 204 so the browser does
        // not report an expected render-only lookup as a failed resource.
        this.#models.set(name, null);
        this.#errors.delete(name);
        this.#clearRetry(name);
        settle(true);
        return;
      }
      if (!response.ok) throw new Error(`Collision gateway returned ${response.status}`);
      this.#models.set(name, decodeCollisionModel(await response.arrayBuffer()));
      this.#errors.delete(name);
      this.#clearRetry(name);
      settle(true);
    } catch (error) {
      // A transport/decode failure is not the extractor saying this model has no collision. Keeping
      // `null` here made one transient 503/session hiccup turn every copy of a tree or inn into a
      // permanent walk-through object until reload.
      this.#models.delete(name);
      this.#requested.delete(name);
      this.#errors.add(name);
      this.#retryLater(name);
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }

  async #fetchGroups(name: string, groups: readonly number[]): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#pending--;
      this.#revision++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(`${this.#baseUrl}/collision/model/${encodeURIComponent(name)}?groups=${groups.join(",")}&v=3`);
      if (!response.ok || response.status === 204) {
        if (response.status === 204) {
          for (const group of groups) {
            const key = `${name}#${group}`;
            this.#errors.delete(key);
            this.#clearRetry(key);
          }
        } else {
          for (const group of groups) {
            const key = `${name}#${group}`;
            this.#errors.add(key);
            this.#requestedGroups.delete(key);
            this.#retryLater(key);
          }
        }
        settle(response.status === 204);
        return;
      }
      const answer = decodeCollisionModel(await response.arrayBuffer());
      const model = this.#models.get(name);
      if (!model) {
        settle(true);
        return;
      }
      let incomplete = false;
      for (const group of groups) {
        const key = `${name}#${group}`;
        const source = answer.groups[group];
        const target = model.groups[group];
        if (!source?.vertices || !source.indices || !target) {
          incomplete = true;
          this.#errors.add(key);
          this.#requestedGroups.delete(key);
          this.#retryLater(key);
          continue;
        }
        target.vertices = source.vertices;
        target.indices = source.indices;
        this.#errors.delete(key);
        this.#clearRetry(key);
      }
      settle(!incomplete);
    } catch (error) {
      for (const group of groups) {
        const key = `${name}#${group}`;
        this.#errors.add(key);
        this.#requestedGroups.delete(key);
        this.#retryLater(key);
      }
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }

  /** How much has been fetched, for the diagnostics line. */
  get counts(): { models: number; missing: number } {
    const values = [...this.#models.values()];
    return { models: values.filter(Boolean).length, missing: values.filter((model) => model === null).length };
  }
}
