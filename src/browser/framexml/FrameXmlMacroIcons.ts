/**
 * The stock macro window's icon lists, fetched from the gateway (`/dbc/macro-icons`, see
 * src/gateway/MacroIcons.ts) the first time the window is opened — never at boot.
 *
 * One fetch per page. A failure (a gateway built before the route existed answers 404) leaves the
 * lists empty, which FrameXmlMacroModel answers with the question mark alone, and is not retried:
 * the window still works, it just offers one icon.
 */

import type { FrameXmlMacroIcons } from "./FrameXmlMacro.js";

const ICON_ROOT = "Interface\\Icons\\";
/** The route's shape: texture names under Interface\Icons\, the gateway's own filter applied. */
const ICON_NAME = /^[\x21-\x7e][\x20-\x7e]{0,127}$/;

function paths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !ICON_NAME.test(name) || /[\\/]/.test(name)) return undefined;
    result.push(`${ICON_ROOT}${name}`);
  }
  return result;
}

export class FrameXmlMacroIconClient implements FrameXmlMacroIcons {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #spell: readonly string[] | undefined;
  #item: readonly string[] | undefined;
  #pending: Promise<void> | undefined;
  /** Why the lists are empty, for diagnostics; undefined while unfetched or loaded. */
  failure: string | undefined;

  constructor(gatewayOrigin: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#url = new URL("/dbc/macro-icons?v=1", gatewayOrigin).href;
    this.#fetch = fetcher;
  }

  spellIcons(): readonly string[] | undefined {
    return this.#spell;
  }

  itemIcons(): readonly string[] | undefined {
    return this.#item;
  }

  load(): Promise<void> {
    this.#pending ??= (async () => {
      try {
        const response = await this.#fetch(this.#url);
        if (!response.ok) throw new Error(`macro icon gateway returned ${response.status}`);
        const value = await response.json() as { spell?: unknown; item?: unknown };
        const spell = paths(value?.spell);
        const item = paths(value?.item);
        if (!spell || !item) throw new Error("malformed macro icon data");
        this.#spell = Object.freeze(spell);
        this.#item = Object.freeze(item);
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
      }
    })();
    return this.#pending;
  }
}
