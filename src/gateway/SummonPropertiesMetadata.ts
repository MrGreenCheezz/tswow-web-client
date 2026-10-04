/**
 * L13 (04.10), plan item 3.12: `SummonProperties.dbc`, resolved into the `/dbc/spells?v=17` rows rather
 * than served as a table of its own.
 *
 * The layout is TrinityCore's (DBCfmt.h `SummonPropertiesfmt` "niiiii", DBCStructure.h:1680-1688): ID,
 * Control, Faction, Title, Slot, Flags — six 32-bit words, 24 bytes a row, no strings. WoWDBDefs has no
 * definition vendored under tools/dbd, so the file is read by that layout and refused when its header
 * says otherwise. 200 rows on this dataset; 174 distinct ids are named by the 2,671 SPELL_EFFECT_SUMMON
 * effects of Spell.dbc, every one of them present.
 *
 * Why inside the spell rows: the only reader is a spell — Wow.exe 0x0061e830 takes the unit's
 * UNIT_CREATED_BY_SPELL, finds its first SPELL_EFFECT_SUMMON (28) and looks the effect's EffectMiscValueB
 * up in this table (bounds 0x00ad4b48..0x00ad4b44, rows 0x00ad4b58) for the Title word (+0xc). The spell
 * row is needed for the effect list anyway, so the row carries its own summon rows, as `/dbc/spells`
 * already carries SpellDuration, SpellRadius, SpellRange, SpellCastTimes and SpellDispelType resolved:
 * no second route, no second client cache, no table the browser holds an index into.
 */

/** `SPELL_EFFECT_SUMMON` (SharedDefines.h): the effect whose EffectMiscValueB names a SummonProperties row. */
export const SPELL_EFFECT_SUMMON = 28;

/** One `SummonProperties.dbc` row, every column, raw (Title is signed: -1 asks for the default title). */
export interface SummonPropertiesRow {
  id: number;
  /** SummonCategory: 0 wild, 1 ally, 2 pet, 3 puppet, 4 vehicle. */
  control: number;
  faction: number;
  /** UNITNAME_SUMMON_TITLE<n>; 0 writes no line, -1 the default (Wow.exe 0x0061e830). */
  title: number;
  /** The summon slot (1-4 the totems, 5 the critter…). */
  slot: number;
  flags: number;
}

const FIELDS = 6;
const RECORD = FIELDS * 4;

/** The table by id; an empty map for a file that is not this layout (nothing guessed from it). */
export function parseSummonProperties(payload: Uint8Array): Map<number, SummonPropertiesRow> {
  const result = new Map<number, SummonPropertiesRow>();
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("latin1") !== "WDBC") return result;
  const rows = bytes.readUInt32LE(4);
  if (bytes.readUInt32LE(8) !== FIELDS || bytes.readUInt32LE(12) !== RECORD) return result;
  if (20 + rows * RECORD + bytes.readUInt32LE(16) !== bytes.length) return result;
  for (let index = 0; index < rows; index++) {
    const at = 20 + index * RECORD;
    const id = bytes.readInt32LE(at);
    result.set(id, {
      id,
      control: bytes.readInt32LE(at + 4),
      faction: bytes.readInt32LE(at + 8),
      title: bytes.readInt32LE(at + 12),
      slot: bytes.readInt32LE(at + 16),
      flags: bytes.readInt32LE(at + 20),
    });
  }
  return result;
}

/**
 * The `summonProperties` of one spell row: for each of the three effects, the SummonProperties row its
 * EffectMiscValueB names when the effect is SPELL_EFFECT_SUMMON, null otherwise (and null for an id the
 * table lacks — Wow.exe then gives the default title). Undefined for a spell with no summon effect.
 */
export function spellSummonProperties(
  effects: readonly number[], miscValueB: readonly number[], table: ReadonlyMap<number, SummonPropertiesRow>,
): (SummonPropertiesRow | null)[] | undefined {
  if (!effects.includes(SPELL_EFFECT_SUMMON)) return undefined;
  return effects.map((effect, index) => (effect === SPELL_EFFECT_SUMMON ? table.get(miscValueB[index] ?? 0) ?? null : null));
}
