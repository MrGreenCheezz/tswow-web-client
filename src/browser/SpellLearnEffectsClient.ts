import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * The LEARN_SPELL and SKILL_STEP effects of Spell.dbc (`/dbc/spell-learn-effects`,
 * gateway/SpellLearnEffectsMetadata.ts) a trainer service's skill line comes from: the class trainer's
 * group headers (3.29, FrameXmlTrainerGroups.ts) and `GetTrainerServiceSkillLine` (3.23F).
 *
 * A gateway process older than the route answers 404 until the owner restarts it; the catalog client
 * retries on its own schedule (CatalogClient.ts). Until the table lands the trainer stays a flat list
 * of services with no headers, as before 3.29, and `GetTrainerServiceSkillLine` answers nil.
 */

/** gateway/SpellLearnEffectsMetadata.ts `SPELL_LEARN_EFFECTS_VERSION`; tests/framexml-trainer-groups.test.mjs pins the two together. */
export const SPELL_LEARN_EFFECTS_ROUTE_VERSION = 2;
export const SPELL_LEARN_EFFECTS_ROUTE_PATH = `/dbc/spell-learn-effects?v=${SPELL_LEARN_EFFECTS_ROUTE_VERSION}`;

/** One Spell.dbc effect: its type, ImplicitTargetA, EffectMiscValue and EffectTriggerSpell. */
export interface SpellLearnEffect {
  readonly effect: number;
  readonly implicitTargetA: number;
  readonly miscValue: number;
  readonly triggerSpell: number;
}

export class SpellLearnEffectsTable {
  readonly #spells: ReadonlyMap<number, readonly SpellLearnEffect[]>;
  /** SkillRaceClassInfo by skill line: the race and class masks of each row. */
  readonly #skillRaceClass: ReadonlyMap<number, readonly (readonly [number, number])[]>;

  constructor(spells: ReadonlyMap<number, readonly SpellLearnEffect[]>,
    skillRaceClass: ReadonlyMap<number, readonly (readonly [number, number])[]> = new Map()) {
    this.#spells = spells;
    this.#skillRaceClass = skillRaceClass;
  }

  /**
   * Whether a SkillRaceClassInfo row of the skill line has the race and the class in its masks (0 is
   * every one) — 0x810ed0, the check 0x812410 makes before it takes a SkillLineAbility row. A line
   * with no row is open to nobody.
   */
  skillAllowed(skillLine: number, raceId: number, classId: number): boolean {
    const raceBit = raceId > 0 ? (1 << ((raceId - 1) & 31)) >>> 0 : 0;
    const classBit = classId > 0 ? (1 << ((classId - 1) & 31)) >>> 0 : 0;
    for (const [raceMask, classMask] of this.#skillRaceClass.get(skillLine) ?? NO_ROWS) {
      if ((raceMask === 0 || (raceMask & raceBit) !== 0) && (classMask === 0 || (classMask & classBit) !== 0)) return true;
    }
    return false;
  }

  /**
   * The three effects of a spell that has a LEARN_SPELL or SKILL_STEP one; an empty list for any
   * other spell (the table holds every such spell, so absence is an answer, not a gap).
   */
  effects(spellId: number): readonly SpellLearnEffect[] {
    return this.#spells.get(spellId) ?? NONE;
  }
}

const NONE: readonly SpellLearnEffect[] = Object.freeze([]);
const NO_ROWS: readonly (readonly [number, number])[] = Object.freeze([]);

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);

/** Validate a route answer; undefined when its shape is not the route's. */
export function spellLearnEffectsFrom(data: unknown, version = SPELL_LEARN_EFFECTS_ROUTE_VERSION): SpellLearnEffectsTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; spells?: unknown; skillRaceClass?: unknown };
  if (value.version !== version || !Array.isArray(value.spells) || value.spells.length > 20_000) return undefined;
  if (!Array.isArray(value.skillRaceClass) || value.skillRaceClass.length > 20_000) return undefined;
  const skillRaceClass = new Map<number, (readonly [number, number])[]>();
  for (const row of value.skillRaceClass as unknown[]) {
    if (!Array.isArray(row) || row.length !== 3 || !row.every(isInt)) return undefined;
    const [skillLine, raceMask, classMask] = row as [number, number, number];
    const rows = skillRaceClass.get(skillLine) ?? [];
    rows.push(Object.freeze([raceMask >>> 0, classMask >>> 0] as const));
    skillRaceClass.set(skillLine, rows);
  }
  const spells = new Map<number, readonly SpellLearnEffect[]>();
  for (const row of value.spells as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !isInt(row[0]) || !Array.isArray(row[1]) || row[1].length !== 3) return undefined;
    const effects: SpellLearnEffect[] = [];
    for (const effect of row[1] as unknown[]) {
      if (!Array.isArray(effect) || effect.length !== 4 || !effect.every(isInt)) return undefined;
      const [type, implicitTargetA, miscValue, triggerSpell] = effect as [number, number, number, number];
      effects.push(Object.freeze({ effect: type, implicitTargetA, miscValue, triggerSpell }));
    }
    spells.set(row[0] as number, Object.freeze(effects));
  }
  return new SpellLearnEffectsTable(spells, skillRaceClass);
}

export class SpellLearnEffectsClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<SpellLearnEffectsTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, SPELL_LEARN_EFFECTS_ROUTE_PATH,
      (data) => spellLearnEffectsFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The table; undefined until it lands. Starts the first cycle, never restarts one that gave up. */
  table(): SpellLearnEffectsTable | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }
}

let current: SpellLearnEffectsClient | undefined;

/** The page's one learn-effect table for this gateway origin. */
export function spellLearnEffectsClient(gatewayOrigin: string | undefined): SpellLearnEffectsClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new SpellLearnEffectsClient(gatewayOrigin);
  return current;
}
