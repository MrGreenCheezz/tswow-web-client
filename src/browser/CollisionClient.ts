import { decodeCollisionModel, type CollisionModel } from "../world/CollisionFormat.js";

export type { CollisionModel };

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
  readonly #queue: string[] = [];
  #active = 0;
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

  /** The model, or undefined until it lands. A model the client does not ship resolves to null. */
  model(name: string): CollisionModel | undefined {
    const known = this.#models.get(name);
    if (known !== undefined) return known ?? undefined;
    if (!this.#requested.has(name)) {
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
    const missing = groups.filter((group) => !this.#requestedGroups.has(`${name}#${group}`));
    if (missing.length === 0) return;
    for (const group of missing) this.#requestedGroups.add(`${name}#${group}`);
    void this.#fetchGroups(name, missing);
  }

  #drain(): void {
    while (this.#active < 4) {
      const name = this.#queue.shift();
      if (!name) return;
      this.#active++;
      void this.#load(name).finally(() => {
        this.#active--;
        this.#drain();
      });
    }
  }

  async #load(name: string): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/collision/model/${encodeURIComponent(name)}?v=3`);
      if (response.status === 204 || response.status === 404) {
        // The extractor wrote no collision for this model, which is its way of saying it has none.
        // 404 remains accepted for older gateways; the current route uses 204 so the browser does
        // not report an expected render-only lookup as a failed resource.
        this.#models.set(name, null);
        return;
      }
      if (!response.ok) throw new Error(`Collision gateway returned ${response.status}`);
      this.#models.set(name, decodeCollisionModel(await response.arrayBuffer()));
      this.#revision++;
    } catch (error) {
      this.#models.set(name, null);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    }
  }

  async #fetchGroups(name: string, groups: readonly number[]): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/collision/model/${encodeURIComponent(name)}?groups=${groups.join(",")}&v=3`);
      if (!response.ok || response.status === 204) return;
      const answer = decodeCollisionModel(await response.arrayBuffer());
      const model = this.#models.get(name);
      if (!model) return;
      for (const group of groups) {
        const source = answer.groups[group];
        const target = model.groups[group];
        if (!source?.vertices || !source.indices || !target) continue;
        target.vertices = source.vertices;
        target.indices = source.indices;
      }
      this.#revision++;
    } catch (error) {
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** How much has been fetched, for the diagnostics line. */
  get counts(): { models: number; missing: number } {
    const values = [...this.#models.values()];
    return { models: values.filter(Boolean).length, missing: values.filter((model) => model === null).length };
  }
}
