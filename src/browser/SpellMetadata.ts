import type { SpellMetadata } from "../gateway/SpellMetadata.js";

export type { SpellMetadata };

/** `SPELL_AURA_MOUNTED` in WotLK's `AuraType` enum. */
export const SPELL_AURA_MOUNTED = 78;

/** A button is usable only after its DBC row arrived and it is not passive. */
export function spellButtonUsable(metadata: Pick<SpellMetadata, "passive"> | undefined): boolean {
  return metadata !== undefined && !metadata.passive;
}

export class SpellMetadataClient {
  readonly #baseUrl: string;
  readonly #cache = new Map<number, SpellMetadata>();

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  async load(ids: readonly number[]): Promise<Map<number, SpellMetadata>> {
    const missing = [...new Set(ids)].filter((id) => !this.#cache.has(id));
    for (let offset = 0; offset < missing.length; offset += 200) {
      // v=6 invalidated cached responses from before the spellbook learned what a rank is: the
      // family key, `SpellLevel`, the mana percentage, the range, the cast time and the school. v=7
      // puts `SpellRange.Flags` beside that range, and without it 544 of the book's 7,369 spells
      // print «Радиус действия: 5 м» for a melee swing — an hour of `cache-control` would be an
      // hour of the defect after the gateway had stopped serving it. The guard below does not list
      // the field on purpose: an absent one reads as `0 & 1`, which is a wrong word rather than a
      // thrown repaint, and refusing the whole record would cost the player their book instead.
      // v=8 carries `SPELL_ATTR2_AUTOREPEAT_FLAG`. Treating an hour-old Auto Shot as an ordinary
      // cast restarts the server repeat container and floods the player with cast failures. v=9
      // invalidates cached empty responses for server-only linked aura ids now resolved by the
      // gateway (for example 61418 -> 26023); otherwise the retry loop receives the same stale
      // empty array for the route's full one-hour cache lifetime.
      // v=10 separates recipe spells from the book and supplies crafting reagents/outputs.
      const response = await fetch(`${this.#baseUrl}/dbc/spells?ids=${missing.slice(offset, offset + 200).join(",")}&v=10`);
      if (!response.ok) throw new Error(`Spell metadata gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value) || !value.every(isSpellMetadata)) throw new Error("Spell metadata gateway returned invalid data");
      for (const metadata of value) this.#cache.set(metadata.id, metadata);
    }
    return new Map(ids.map((id) => [id, this.#cache.get(id)]).filter((entry): entry is [number, SpellMetadata] => entry[1] !== undefined));
  }
}

function isSpellMetadata(value: unknown): value is SpellMetadata {
  if (!value || typeof value !== "object") return false;
  const spell = value as Record<string, unknown>;
  return typeof spell.id === "number"
    && typeof spell.name === "string"
    && typeof spell.rank === "string"
    && typeof spell.description === "string"
    && typeof spell.iconId === "number"
    && typeof spell.iconPath === "string"
    && typeof spell.passive === "boolean"
    && typeof spell.autoRepeat === "boolean"
    && typeof spell.powerType === "number"
    && typeof spell.powerCost === "number"
    && typeof spell.recoveryTime === "number"
    && typeof spell.categoryRecoveryTime === "number"
    && typeof spell.startRecoveryTime === "number"
    && typeof spell.cooldownStartedOnEvent === "boolean"
    && Array.isArray(spell.effectAura)
    && Array.isArray(spell.effectMiscValue)
    // The substitution data. Checked rather than assumed, because the one-hour cache means a
    // browser can be handed the old shape by its own disk for an hour after the gateway learns
    // the new one — and a description parser given `undefined` where an array was promised writes
    // "NaN" into the tooltip instead of failing.
    && Array.isArray(spell.effectBasePoints)
    && Array.isArray(spell.effectDieSides)
    && Array.isArray(spell.effectPeriod)
    && typeof spell.duration === "number"
    && typeof spell.procChance === "number"
    // The rank key and the cost. Checked for the same reason as the arrays above and with more at
    // stake: `rankChainKey` joins `spellClassMask`, and `undefined.join` is a thrown TypeError in
    // the middle of a repaint, not a wrong string. The hour of `cache-control` is enough for a
    // browser to be handed the v=5 shape by its own disk after the gateway has moved on.
    && typeof spell.spellLevel === "number"
    && typeof spell.spellClassSet === "number"
    && Array.isArray(spell.spellClassMask)
    && typeof spell.powerCostPercent === "number"
    && (spell.descriptionVariables === undefined || typeof spell.descriptionVariables === "string");
}
