import type { SpellMetadata } from "../gateway/SpellMetadata.js";

export type { SpellMetadata };

/** `SPELL_AURA_MOUNTED` in WotLK's `AuraType` enum. */
export const SPELL_AURA_MOUNTED = 78;

/** A button is usable only after its DBC row arrived and it is not passive. */
export function spellButtonUsable(metadata: Pick<SpellMetadata, "passive"> | undefined): boolean {
  return metadata !== undefined && !metadata.passive;
}

/** What `/dbc/spells` accepts in one request; the route answers 400 past it. */
const IDS_PER_REQUEST = 200;

export class SpellMetadataClient {
  readonly #baseUrl: string;
  readonly #cache = new Map<number, SpellMetadata>();
  /**
   * Ids the gateway answered without a row, asked for once per session.
   *
   * `/dbc/spells` filters its answer through a table it loads once per process (server-side
   * aliases included), so an id it has no row for today has none for as long as that gateway runs.
   * Asking again only ever cost a request — and the aura strip used to ask again for every
   * unresolved aura of every unit in view on every aura packet, each time under a new URL the
   * browser cache could not answer. A failed request records nothing here: only an answer is final.
   */
  readonly #missing = new Set<number>();
  /**
   * The request already asking for an id. A caller that needs the same row waits for that answer
   * instead of sending a second request for it; in a crowd, two hundred aura packets used to send
   * two hundred overlapping requests before the first had come back.
   */
  readonly #inFlight = new Map<number, Promise<void>>();
  /**
   * Whether this gateway has been seen to answer the v=13 key in the v=12 shape (no
   * `auraDescription` on any row) even when asked past the browser cache: an older gateway process,
   * still running. Until then, a batch in the old shape is asked once more with `cache: "reload"`.
   */
  #olderGateway = false;
  readonly #fetch: typeof fetch;

  constructor(gatewayWebSocketUrl: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#fetch = fetcher;
  }

  /** Whether the gateway has answered for this id: a row, or the final word that there is none. */
  answered(id: number): boolean {
    return this.#cache.has(id) || this.#missing.has(id);
  }

  async load(ids: readonly number[]): Promise<Map<number, SpellMetadata>> {
    const wanted = [...new Set(ids)];
    const missing: number[] = [];
    const shared = new Set<Promise<void>>();
    for (const id of wanted) {
      if (this.#cache.has(id) || this.#missing.has(id)) continue;
      const pending = this.#inFlight.get(id);
      if (pending) shared.add(pending);
      else missing.push(id);
    }
    // This call's own request starts at once; the rows another call is already asking for are
    // waited for rather than asked twice. Only this call's own failure is its failure, as before.
    await Promise.all([this.#request(missing), Promise.allSettled(shared)]);
    if (shared.size > 0) {
      // A request this call was waiting on failed: its ids are asked for again here, which is the
      // request this call would have made on its own before requests were shared.
      const unanswered = wanted.filter((id) => !this.#cache.has(id) && !this.#missing.has(id));
      const again = unanswered.filter((id) => !this.#inFlight.has(id));
      const still = new Set(unanswered.flatMap((id) => {
        const pending = this.#inFlight.get(id);
        return pending ? [pending] : [];
      }));
      await Promise.all([this.#request(again), Promise.allSettled(still)]);
    }
    return new Map(ids.map((id) => [id, this.#cache.get(id)]).filter((entry): entry is [number, SpellMetadata] => entry[1] !== undefined));
  }

  /**
   * Asks for `ids` in route-sized chunks, one after another, and publishes each chunk's promise as
   * the in-flight answer for its ids. A failed chunk fails the rest unasked, exactly as the loop
   * that stopped at the first thrown batch did.
   */
  #request(ids: readonly number[]): Promise<void> {
    let previous: Promise<void> = Promise.resolve();
    for (let offset = 0; offset < ids.length; offset += IDS_PER_REQUEST) {
      const chunk = ids.slice(offset, offset + IDS_PER_REQUEST);
      // The first chunk is asked for synchronously, as the loop it replaces did.
      const batch = offset === 0 ? this.#fetchChunk(chunk) : previous.then(() => this.#fetchChunk(chunk));
      for (const id of chunk) this.#inFlight.set(id, batch);
      const release = (): void => {
        for (const id of chunk) if (this.#inFlight.get(id) === batch) this.#inFlight.delete(id);
      };
      batch.then(release, release);
      previous = batch;
    }
    return previous;
  }

  async #fetchChunk(chunk: readonly number[]): Promise<void> {
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
    // v=11 adds an explicit, bounded target-selection contract for the Unity client.
    // v=12 supplies the original stance bar flag, ordering and form action-page offset.
    // v=13 adds what the stock tooltip rows need: `auraDescription` (the buff bar's text),
    // `onNextSwing` («Следующая атака») and `channeled` («Потоковое»). All three are optional
    // below: a gateway process started before them answers v=13 in the v=12 shape, and that
    // must still draw today's rows rather than refuse the book.
    // v=14 adds what IsActionInRange and the lock-pick cursor read (1.14b, 2.05): the friendly
    // range slot, the raw Targets/ImplicitTarget/TargetCreatureType columns, the eight attribute
    // words and `itemOrObject`. Optional below like v=13's: a gateway started before them answers
    // v=14 in the v=13 shape, and the range then stays nil and Pick Lock keeps no cursor.
    // v=15 adds `dispelType` and `debuffType` (5.20): UnitAura's fifth value and the steal test.
    // Optional as well: an older gateway leaves debuffType nil and isStealable off.
    // v=16 adds what the cast events, the combat log and the multi-cast bar read (3.01, 3.02, 3.07):
    // `dmgClass`, `preventionType`, `interruptFlags`, `channelInterruptFlags`, `totemSlotMask`.
    // Optional too: an older gateway leaves notInterruptible false and GetMultiCastTotemSpells empty.
    // L13: v=17 adds `startRecoveryCategory` (5.30: the global cooldown's category), `effectMiscValueB` and
    // the SummonProperties rows of a summon effect (3.12). Optional: an older gateway's rows keep the one
    // global cooldown for every spell with a StartRecoveryTime and give a summoned unit no title line.
    const url = `${this.#baseUrl}/dbc/spells?ids=${chunk.join(",")}&v=17`; // L13: was v=16
    let value = await this.#batch(url);
    // The key alone cannot tell a restarted gateway from the hour-long browser cache: an answer the
    // old process gave before the restart is still on disk. A batch whose every row lacks the newest
    // field (L13: `startRecoveryCategory`, present on every v=17 row, 0 included) is asked once more past
    // that cache; if the gateway itself still answers the old shape, this session stops asking twice.
    if (!this.#olderGateway && value.length > 0 && value.every((row) => row.startRecoveryCategory === undefined)) { // L13
      value = await this.#batch(url, { cache: "reload" });
      if (value.every((row) => row.startRecoveryCategory === undefined)) this.#olderGateway = true; // L13
    }
    for (const metadata of value) this.#cache.set(metadata.id, metadata);
    // Answered, and without a row: final for this gateway process (see `#missing`).
    for (const id of chunk) if (!this.#cache.has(id)) this.#missing.add(id);
  }

  async #batch(url: string, init?: RequestInit): Promise<SpellMetadata[]> {
    const response = await this.#fetch(url, init);
    if (!response.ok) throw new Error(`Spell metadata gateway returned ${response.status}`);
    const value: unknown = await response.json();
    if (!Array.isArray(value) || !value.every(isSpellMetadata)) throw new Error("Spell metadata gateway returned invalid data");
    return value;
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
    && typeof spell.displayInStanceBar === "boolean"
    && typeof spell.stanceBarOrder === "number"
    && Number.isInteger(spell.stanceBarOrder)
    && spell.stanceBarOrder >= 0
    && (spell.bonusActionBarOffset === undefined
      || (typeof spell.bonusActionBarOffset === "number"
        && Number.isInteger(spell.bonusActionBarOffset)
        && spell.bonusActionBarOffset >= 0))
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
    && (spell.targetingContractVersion === undefined
      ? spell.requiredTargetMask === undefined && spell.requiredTargetMode === undefined
      : spell.targetingContractVersion === 1
        && typeof spell.requiredTargetMask === "number"
        && Number.isInteger(spell.requiredTargetMask)
        && spell.requiredTargetMask >= 0
        && spell.requiredTargetMask <= 7
        && typeof spell.requiredTargetMode === "number"
        && Number.isInteger(spell.requiredTargetMode)
        && spell.requiredTargetMode >= 0
        && spell.requiredTargetMode <= 3)
    && (spell.descriptionVariables === undefined || typeof spell.descriptionVariables === "string")
    // v=13's three are optional (see `load`), but a present one must be what it says.
    && (spell.auraDescription === undefined || typeof spell.auraDescription === "string")
    && (spell.onNextSwing === undefined || typeof spell.onNextSwing === "boolean")
    && (spell.channeled === undefined || typeof spell.channeled === "boolean")
    // v=14's are optional too; a present one must be what it says.
    && optionalNumber(spell.rangeMinFriendly) && optionalNumber(spell.rangeMaxFriendly)
    && optionalInteger(spell.targets) && optionalInteger(spell.targetCreatureType)
    && optionalIntegers(spell.implicitTargetA, 3) && optionalIntegers(spell.implicitTargetB, 3)
    && optionalIntegers(spell.attributes, 8)
    && (spell.itemOrObject === undefined || typeof spell.itemOrObject === "boolean")
    // v=15's: DispelType is a small index (SpellDispelType.dbc has 12 rows here), debuffType a string.
    && (spell.dispelType === undefined
      || (Number.isInteger(spell.dispelType) && (spell.dispelType as number) >= 0 && (spell.dispelType as number) < 32))
    && (spell.debuffType === undefined || typeof spell.debuffType === "string")
    && (spell.dispelName === undefined || typeof spell.dispelName === "string")
    // v=16's: small enums and raw flag words; absent from an older gateway.
    && optionalInteger(spell.dmgClass) && optionalInteger(spell.preventionType)
    && optionalInteger(spell.interruptFlags) && optionalInteger(spell.channelInterruptFlags)
    && (spell.totemSlotMask === undefined
      || (Number.isInteger(spell.totemSlotMask) && (spell.totemSlotMask as number) >= 0
        && (spell.totemSlotMask as number) <= 0xf))
    // L13 (v=17): a category is a non-negative id; MiscValueB three raw words; the summon rows one per effect.
    && (spell.startRecoveryCategory === undefined
      || (Number.isSafeInteger(spell.startRecoveryCategory) && (spell.startRecoveryCategory as number) >= 0))
    && optionalIntegers(spell.effectMiscValueB, 3)
    && (spell.summonProperties === undefined
      || (Array.isArray(spell.summonProperties) && spell.summonProperties.length === 3
        && spell.summonProperties.every(isSummonPropertiesEntry)));
}

/** L13 (v=17): a `summonProperties` entry — null, or a SummonProperties row of six integers. */
function isSummonPropertiesEntry(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.id) && Number.isSafeInteger(row.control) && Number.isSafeInteger(row.faction)
    && Number.isSafeInteger(row.title) && Number.isSafeInteger(row.slot) && Number.isSafeInteger(row.flags);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function optionalInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function optionalIntegers(value: unknown, length: number): boolean {
  return value === undefined || (Array.isArray(value) && value.length === length && value.every((entry) => Number.isSafeInteger(entry)));
}
