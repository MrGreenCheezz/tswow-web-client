import { REACTION_NEUTRAL, reactionBetween, type FactionData } from "../world/FactionRules.js";
import type { ReputationCatalog } from "../gateway/ReputationMetadata.js";
import type { FactionTemplateRow } from "../gateway/FactionMetadata.js"; // L18 5.05

export type { FactionData };

/** The pause before the first retry of a failed table fetch; it doubles up to {@link DATA_RETRY_MAX_MS} (5.16). */
export const DATA_RETRY_BASE_MS = 1_000;
export const DATA_RETRY_MAX_MS = 30_000;

/** The pause before attempt `attempt + 1` (1 s, 2 s, 4 s … 30 s). */
export function dataRetryDelay(attempt: number): number {
  return Math.min(DATA_RETRY_MAX_MS, DATA_RETRY_BASE_MS * 2 ** Math.min(5, attempt));
}

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
  #retries = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #abandoned = false;
  #reputationCatalog: ReputationCatalog | undefined;
  #reputationPending: Promise<void> | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** A newer client replaced this one (the next world entry): no more retries. */
  abandon(): void {
    this.#abandoned = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  /**
   * Starts the one fetch this needs. Safe to call repeatedly: a fetch in flight or a retry already
   * waiting makes it a no-op.
   */
  load(): void {
    if (this.#data || this.#pending || this.#retryTimer !== undefined || this.#abandoned) return;
    this.#pending = (async () => {
      try {
        // The route caches for an hour and the payload grew a `names` map, so the request says
        // which shape it wants; without it a browser that fetched this realm within the hour keeps
        // a body with no names in it and every faction goes back to being a number.
        // L18 5.05: v=3 — the rows carry FactionTemplate.Flags (CONTESTED_GUARD); a gateway before its
        // restart answers v=3 with the v=2 body, whose rows have none (`templateFlagsOf` → undefined).
        const response = await fetch(`${this.#baseUrl}/dbc/factions?v=3`); // L18 5.05: was v=2
        if (!response.ok) throw new Error(`Faction gateway returned ${response.status}`);
        const value = await response.json() as FactionData;
        if (!value.templates) throw new Error("malformed faction data");
        this.#data = value;
      } catch (error) {
        // Asked again with a growing pause (5.16): until the table lands every unit reads neutral,
        // which costs Tab, CanAttack and the plate colours. Said once, not per attempt.
        if (this.#retries === 0) this.onStatus?.(`фракции: ${error instanceof Error ? error.message : String(error)}`, true);
        this.#pending = undefined;
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = undefined;
          this.load();
        }, dataRetryDelay(this.#retries++));
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

  /** A template's `Faction.dbc` row id (0 for a template standing alone); undefined until the table lands. */
  factionOf(templateId: number): number | undefined {
    return this.#data?.templates[templateId]?.faction;
  }

  /** 5.18: a template's FactionGroup mask (who may be followed, Wow.exe 0x00729BD0); undefined until the table lands. */
  factionGroupOf(templateId: number): number | undefined {
    return this.#data?.templates[templateId]?.factionGroup;
  }

  /**
   * L18 5.05: a template's FactionTemplate.Flags (CONTESTED_GUARD 0x1000 — world/ContestedGuard.ts);
   * undefined until the table lands, for a template it does not have, or from a gateway before v=3.
   */
  templateFlagsOf(templateId: number): number | undefined {
    const flags = (this.#data?.templates[templateId] as Partial<FactionTemplateRow> | undefined)?.flags;
    return typeof flags === "number" ? flags : undefined;
  }

  /** Hostile, neutral or friendly between two faction templates; neutral until the table lands. */
  reaction(selfTemplateId: number, otherTemplateId: number): number {
    if (!this.#data) return REACTION_NEUTRAL;
    return reactionBetween(this.#data, selfTemplateId, otherTemplateId);
  }
}
