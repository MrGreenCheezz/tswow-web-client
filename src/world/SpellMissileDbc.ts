// 11.02-E: the missile tables a trajectory cast needs — every SpellMissile.dbc row and the SpellMissileID
// of every Spell.dbc row that names one — as `GET /dbc/spell-missiles?v=1` is to carry them and as the
// page holds them (browser/SpellMissileClient.ts).
//
// Wow.exe 3.3.5a 12340 (Ghidra, read-only; .runtime/re-2026-10-03/l1102e/r1-r4.c) reads both tables on
// the client: the cast sender (0x0080ac90) looks the spell's SpellMissileID (the in-memory spell record's
// +0x28c — column 227 less the 64 columns of the four collapsed localized strings) up in the
// SpellMissile index (min/max id 0x00ad492c/0x00ad4928, rows 0x00ad493c) and, when the row's Flags has
// bit 0, sends the cast as a missile trajectory; the solver (0x006fcd60), the missile in flight
// (0x00700880) and the SMSG_SPELL_START handler (0x00806700) read the same row. TrinityCore does not load
// SpellMissile.dbc and skips SpellMissileID (DBCStructure.h:1521); the gateway reads both files itself
// (gateway/SpellMissileMetadata.ts, 11.02-E-review).
//
// Column names and offsets: tswow-scripts/wotlk/dbc/SpellMissile.ts (ID, Flags, then 13 floats); the
// solver reads them at the same offsets (+8/+0xc pitch, +0x10/+0x14 speed, +0x18…+0x2c the three
// randomize pairs, +0x30 gravity, +0x34 max duration, +0x38 collision radius). On this dataset: 105 rows,
// 106 spells naming one, 105 of them with bit 0 (flags 1 ×92, 0x11 ×10, 0x13, 0x3, 0x3f).

/** The route's shape: `/dbc/spell-missiles?v=` this. Bump with every change of shape. */
export const SPELL_MISSILE_CATALOG_VERSION = 1;
export const SPELL_MISSILE_CATALOG_PATHNAME = "/dbc/spell-missiles";

/** SpellMissile Flags bit 0: the spell is cast as a missile trajectory (0x0080ac90 tests `row+4 & 1`). */
export const SPELL_MISSILE_FLAG_TRAJECTORY = 0x1;
/** SpellMissile Flags 0x3c: the missile collides on its way (0x006fcd60, 0x00700880 test `row+4 & 0x3c`). */
export const SPELL_MISSILE_COLLISION_MASK = 0x3c;

/** SpellMissile.dbc column indices (tswow SpellMissile.ts). */
export const SPELL_MISSILE_COLUMN = Object.freeze({
  ID: 0, Flags: 1, DefaultPitchMin: 2, DefaultPitchMax: 3, DefaultSpeedMin: 4, DefaultSpeedMax: 5,
  RandomizeFacingMin: 6, RandomizeFacingMax: 7, RandomizePitchMin: 8, RandomizePitchMax: 9,
  RandomizeSpeedMin: 10, RandomizeSpeedMax: 11, Gravity: 12, MaxDuration: 13, CollisionRadius: 14,
});
/** 15 columns: the id, the flag word, then thirteen floats. */
export const SPELL_MISSILE_COLUMNS = 15;

/** One SpellMissile.dbc row. */
export interface SpellMissileEntry {
  readonly id: number;
  readonly flags: number;
  readonly defaultPitchMin: number;
  readonly defaultPitchMax: number;
  readonly defaultSpeedMin: number;
  readonly defaultSpeedMax: number;
  readonly randomizeFacingMin: number;
  readonly randomizeFacingMax: number;
  readonly randomizePitchMin: number;
  readonly randomizePitchMax: number;
  readonly randomizeSpeedMin: number;
  readonly randomizeSpeedMax: number;
  readonly gravity: number;
  readonly maxDuration: number;
  readonly collisionRadius: number;
}

/** The route's answer: SpellMissile rows in file order, and `[spellId, spellMissileId]` for every spell naming one. */
export interface SpellMissileCatalogAnswer {
  readonly version: number;
  readonly missiles: readonly (readonly number[])[];
  readonly spells: readonly (readonly [number, number])[];
}

/** The page's view of both tables. A repeated id keeps the last row, as an index by id does. */
export class SpellMissileCatalog {
  readonly #missiles = new Map<number, SpellMissileEntry>();
  readonly #spells = new Map<number, number>();

  constructor(missiles: readonly SpellMissileEntry[], spells: Iterable<readonly [number, number]>) {
    for (const row of missiles) this.#missiles.set(row.id, row);
    for (const [spellId, missileId] of spells) this.#spells.set(spellId, missileId);
  }

  get size(): number {
    return this.#missiles.size;
  }

  missile(id: number): SpellMissileEntry | undefined {
    return this.#missiles.get(id);
  }

  /** The spell's SpellMissile row, whatever its flags. */
  missileOfSpell(spellId: number): SpellMissileEntry | undefined {
    const id = this.#spells.get(spellId);
    return id === undefined ? undefined : this.#missiles.get(id);
  }

  /** The row when it makes the spell a trajectory cast (Flags bit 0, 0x0080ac90); undefined otherwise. */
  trajectoryMissile(spellId: number): SpellMissileEntry | undefined {
    const row = this.missileOfSpell(spellId);
    return row !== undefined && (row.flags & SPELL_MISSILE_FLAG_TRAJECTORY) !== 0 ? row : undefined;
  }
}

/** A row from its fifteen numbers (file order), or undefined for anything else. */
export function spellMissileEntry(row: readonly unknown[]): SpellMissileEntry | undefined {
  if (row.length !== SPELL_MISSILE_COLUMNS) return undefined;
  for (const value of row) if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = (column: number): number => row[column] as number;
  const id = n(SPELL_MISSILE_COLUMN.ID);
  const flags = n(SPELL_MISSILE_COLUMN.Flags);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(flags) || flags < 0 || flags > 0xffff_ffff) return undefined;
  const C = SPELL_MISSILE_COLUMN;
  return Object.freeze({
    id, flags,
    defaultPitchMin: n(C.DefaultPitchMin), defaultPitchMax: n(C.DefaultPitchMax),
    defaultSpeedMin: n(C.DefaultSpeedMin), defaultSpeedMax: n(C.DefaultSpeedMax),
    randomizeFacingMin: n(C.RandomizeFacingMin), randomizeFacingMax: n(C.RandomizeFacingMax),
    randomizePitchMin: n(C.RandomizePitchMin), randomizePitchMax: n(C.RandomizePitchMax),
    randomizeSpeedMin: n(C.RandomizeSpeedMin), randomizeSpeedMax: n(C.RandomizeSpeedMax),
    gravity: n(C.Gravity), maxDuration: n(C.MaxDuration), collisionRadius: n(C.CollisionRadius),
  });
}

/** The catalog from the route's answer, or undefined for another version or shape. Bad rows are dropped. */
export function spellMissileCatalogFrom(data: unknown, version = SPELL_MISSILE_CATALOG_VERSION): SpellMissileCatalog | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const answer = data as Partial<Record<keyof SpellMissileCatalogAnswer, unknown>>;
  if (answer.version !== version || !Array.isArray(answer.missiles) || !Array.isArray(answer.spells)) return undefined;
  const missiles: SpellMissileEntry[] = [];
  for (const row of answer.missiles) {
    const entry = Array.isArray(row) ? spellMissileEntry(row) : undefined;
    if (entry) missiles.push(entry);
  }
  const spells: [number, number][] = [];
  for (const pair of answer.spells) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [spellId, missileId] = pair as unknown[];
    if (Number.isSafeInteger(spellId) && Number.isSafeInteger(missileId) && (spellId as number) > 0 && (missileId as number) > 0) {
      spells.push([spellId as number, missileId as number]);
    }
  }
  return new SpellMissileCatalog(missiles, spells);
}
