import { REACTION_NEUTRAL, reactionBetween, type FactionData } from "../world/FactionRules.js";
import type { ReputationCatalog } from "../gateway/ReputationMetadata.js";

export type { FactionData };

/**
 * Every faction template, fetched once for the session.
 *
 * 841 rows, and the answer they give — is this unit an enemy — is wanted for every unit on screen
 * on every frame. Holding the table is the only shape that makes that free; the alternative is a
 * request per creature for a table smaller than one texture.
 */
export class FactionClient {
  readonly #baseUrl: string;
  #data: FactionData | undefined;
  #pending: Promise<void> | undefined;
  #reputationCatalog: ReputationCatalog | undefined;
  #reputationPending: Promise<void> | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Starts the one fetch this needs. Safe to call repeatedly; only the first does anything. */
  load(): void {
    if (this.#data || this.#pending) return;
    this.#pending = (async () => {
      try {
        // The route caches for an hour and the payload grew a `names` map, so the request says
        // which shape it wants; without it a browser that fetched this realm within the hour keeps
        // a body with no names in it and every faction goes back to being a number.
        const response = await fetch(`${this.#baseUrl}/dbc/factions?v=2`);
        if (!response.ok) throw new Error(`Faction gateway returned ${response.status}`);
        const value = await response.json() as FactionData;
        if (!value.templates) throw new Error("malformed faction data");
        this.#data = value;
      } catch (error) {
        // Left unfetched rather than retried: until a reconnection every unit reads as neutral,
        // which costs Tab targeting and a name plate colour, and nothing else.
        this.onStatus?.(`фракции: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  /** Fetch the separate Faction.dbc ID → reputation-list slot catalog before stock reward reads. */
  loadReputation(): void {
    if (this.#reputationCatalog || this.#reputationPending) return;
    this.#reputationPending = (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/reputation?v=1`);
        if (!response.ok) throw new Error(`Reputation gateway returned ${response.status}`);
        const value = await response.json() as ReputationCatalog;
        if (value.version !== 1 || !value.factions || typeof value.factions !== "object") {
          throw new Error("malformed reputation catalog");
        }
        this.#reputationCatalog = value;
      } catch (error) {
        this.onStatus?.(`репутация: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  get reputationCatalog(): ReputationCatalog | undefined {
    return this.#reputationCatalog;
  }

  get ready(): boolean {
    return this.#data !== undefined;
  }

  /** The faction's own name by its reputation slot, or nothing until the table lands. */
  name(reputationIndex: number): string | undefined {
    return this.#data?.names?.[reputationIndex];
  }

  /** Hostile, neutral or friendly between two faction templates; neutral until the table lands. */
  reaction(selfTemplateId: number, otherTemplateId: number): number {
    if (!this.#data) return REACTION_NEUTRAL;
    return reactionBetween(this.#data, selfTemplateId, otherTemplateId);
  }
}
