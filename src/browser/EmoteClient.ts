import type { EmoteData } from "../world/EmoteRules.js";

export type { EmoteData };

/**
 * Every text emote, fetched once for the session.
 *
 * Held whole rather than asked for per command, for the same reason the faction table is: 252 rows
 * of short sentences, and the moment they are wanted is the moment a player has finished typing
 * `/dance` and pressed Enter. A round trip there would be a visible pause before a wave.
 */
export class EmoteClient {
  readonly #baseUrl: string;
  #data: EmoteData | undefined;
  #pending: Promise<void> | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  /** Called once, when the table lands, so the chat box can start answering emote commands. */
  onLoaded: ((data: EmoteData) => void) | undefined;

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
        const response = await fetch(`${this.#baseUrl}/dbc/emotes`);
        if (!response.ok) throw new Error(`Emote gateway returned ${response.status}`);
        const value = await response.json() as EmoteData;
        if (!Array.isArray(value.emotes)) throw new Error("malformed emote data");
        this.#data = value;
        this.onLoaded?.(value);
      } catch (error) {
        // Left unfetched rather than retried: emote commands answer «список эмоций ещё не
        // загружен» until a reconnection, and nothing else in the client depends on this.
        this.onStatus?.(`эмоции: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  get data(): EmoteData | undefined {
    return this.#data;
  }
}
