import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbc, type Dbc } from "./Dbc.js";

/**
 * `SPELL_ATTR0_PASSIVE`. A passive spell has no button; the real spellbook still lists it, greyed.
 */
const SPELL_ATTR0_PASSIVE = 0x40;
/**
 * `SPELL_ATTR0_HIDDEN_CLIENTSIDE`, and the core's own comment on it is "Not visible in spellbook
 * or aura bar". This — not the passive bit — is the flag that means "do not show me".
 *
 * Measured on this dataset: of 49,842 spells, 10,243 carry it and 7,554 carry the passive bit,
 * 6,574 carry both. Filtering on passive alone therefore hid 159 spells the real book shows in
 * grey — Dodge, Block, Parry, Dual Wield, the racial passives — while leaving 3,669 spells that
 * are explicitly marked invisible.
 */
const SPELL_ATTR0_HIDDEN_CLIENTSIDE = 0x80;
/** `SPELL_ATTR0_DISABLED_WHILE_ACTIVE`: the server starts recovery from the later event. */
const SPELL_ATTR0_DISABLED_WHILE_ACTIVE = 0x02000000;
/** `SPELL_CATEGORY_FLAG_COOLDOWN_STARTS_ON_EVENT` in SpellCategory.dbc. */
const SPELL_CATEGORY_FLAG_COOLDOWN_STARTS_ON_EVENT = 0x04;

export interface SpellMetadata {
  id: number;
  name: string;
  rank: string;
  description: string;
  iconId: number;
  iconPath: string;
  passive: boolean;
  /** Marked invisible by the artist. Never belongs in the spellbook or on the aura bar. */
  hidden: boolean;
  powerType: number;
  powerCost: number;
  /**
   * `ManaCostPct`, a percentage of the caster's base power — and in 3.3.5 it is how a caster's
   * spell is priced at all. Measured on this dataset: of the 7,369 spells that reach the book,
   * **6,728 have `ManaCost = 0`, and 1,543 of those carry a non-zero `ManaCostPct`** («Огненный
   * шар» rank 1 is 8%, rank 16 is 19%, «Кара» 9%, «Малое исцеление» 16%). Without this column the
   * cost line is missing from every spell a mage, a priest, a warlock, a druid or a shaman owns.
   *
   * The base it multiplies is the caster's, not the spell's: `Spell::CalcPowerCost` takes
   * `GetCreateMana()` — `UNIT_FIELD_BASE_MANA` — for a mana spell and the unit's maximum for rage,
   * energy and runic power, so the resolution belongs on the client that knows the caster.
   */
  powerCostPercent: number;
  recoveryTime: number;
  categoryRecoveryTime: number;
  startRecoveryTime: number;
  /** The server waits for SMSG_COOLDOWN_EVENT/SPELL_COOLDOWN before starting own recovery. */
  cooldownStartedOnEvent: boolean;
  /**
   * The level the spell itself is written for — `SpellLevel`, not `BaseLevel` and not the level a
   * trainer asks for. It orders a rank chain: «Огненный шар» runs 1, 6, 12, 18 … 78 across its
   * sixteen ranks, and the ranks are the only thing in the table that says which of two rows with
   * the same name is the later one.
   */
  spellLevel: number;
  /**
   * `SpellClassSet` and the three words of `SpellClassMask` — the spell family, which is what a
   * talent's «affects your Fire spells» is matched against. Carried here because the book has no
   * other way to tell two spells of the same name apart from two ranks of one spell: `SpellChain`
   * does not exist in 3.3.5a, and `SkillLineAbility.SupercededBySpell` is filled on 1,059 of
   * 10,220 rows — none of the sixteen «Огненный шар» rows among them.
   */
  spellClassSet: number;
  spellClassMask: number[];
  /** `SchoolMask`: 1 physical, 2 holy, 4 fire, 8 nature, 16 frost, 32 shadow, 64 arcane. */
  schoolMask: number;
  /** Yards, already resolved through `SpellRange.dbc` (65 rows), hostile slot. */
  rangeMin: number;
  rangeMax: number;
  /**
   * `SpellRange.Flags`, because the yards alone say the wrong thing twice.
   *
   * The 1 marks the melee reach — row 2, «Combat Range», `RangeMax` 5 — which the client prints as
   * `MELEE_RANGE` and not as a number, and 544 of the 7,369 spells that reach the book resolve to
   * it. Only four of the 65 rows carry a flag at all: that one, and the weapon rows 74, 114 and 155
   * with a 2. Nothing else in the payload can tell a five-yard reach from a five-yard spell.
   */
  rangeFlags: number;
  /** Milliseconds, already resolved through `SpellCastTimes.dbc` (71 rows). Zero is instant. */
  castTime: number;
  /**
   * `EffectAura[0..2]` and the misc value beside each, which is the only way to tell a tracking
   * spell from any other. Aura 44 tracks a creature type, 45 a resource type and 151 the hidden;
   * the misc value is a one-based id into `CreatureType.dbc` or `LockType.dbc`, and 151 carries
   * none. Nothing else in this payload could distinguish them: the name and the icon cannot.
   */
  effectAura: number[];
  effectMiscValue: number[];
  /**
   * What a description's `$s`, `$m`, `$M` and `$o` markers are made of.
   *
   * The client's own rule, and it is not "the number in the table": an effect rolls
   * `EffectBasePoints + 1` to `EffectBasePoints + EffectDieSides`, so Fireball rank 1 stores 13
   * and 9 and reads 14 to 22 on the tooltip. 22,599 of the 31,749 spells with a Russian
   * description contain a `$`, and until now every one of them showed the marker.
   */
  effectBasePoints: number[];
  effectDieSides: number[];
  /**
   * `EffectAuraPeriod`, in milliseconds — how often a periodic effect ticks, and therefore `$t`.
   *
   * Not `EffectAmplitude`, which sits in the next three slots and is a float. The two are one
   * field apart and only one of them is a time; reading the wrong one gives 1.0 where 3000 was
   * wanted, which is a plausible number and a silent mistake.
   */
  effectPeriod: number[];
  /** `EffectChainTargets`, which is `$x`. */
  effectChainTargets: number[];
  /** The yards `$a` and `$A` name, already resolved through `SpellRadius`. */
  effectRadius: number[];
  /** Milliseconds, already resolved through `SpellDuration`. Zero for a spell with no duration. */
  duration: number;
  maxDuration: number;
  /** `$h`, as a percentage. 101 in the table means "always", and is served as 100. */
  procChance: number;
  /**
   * `SpellDescriptionVariables::ID`, carried alongside the optional macro body below. Older or
   * custom datasets may omit the side table entirely, in which case the id remains available and
   * the browser leaves unknown named formulas honest rather than inventing a value.
   */
  descriptionVariablesId: number;
  /**
   * The macro definitions from `SpellDescriptionVariables.dbc`, when this dataset carries the
   * table. The browser uses these to expand `${$<name>}` blocks without guessing at a missing
   * variable. Kept as the authored string because definitions may contain conditionals.
   */
  descriptionVariables?: string;
}

/** `MAX_SPELL_EFFECTS`: every effect column in this table is three wide. */
const SPELL_EFFECTS = 3;

export function parseSpellMetadata(
  spellPayload: Uint8Array,
  iconPayload: Uint8Array,
  durationPayload?: Uint8Array,
  radiusPayload?: Uint8Array,
  categoryPayload?: Uint8Array,
  descriptionVariablesPayload?: Uint8Array,
  rangePayload?: Uint8Array,
  castTimePayload?: Uint8Array,
): Map<number, SpellMetadata> {
  const view = (payload: Uint8Array): Buffer =>
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const spells = openDbc(view(spellPayload), "Spell");
  const icons = openDbc(view(iconPayload), "SpellIcon");

  const iconPaths = new Map<number, string>();
  for (const row of icons.rows()) iconPaths.set(icons.id(row), icons.string(row, "TextureFilename"));

  // Both are indexes into small side tables, and both are resolved here rather than served raw:
  // a browser holding an index into a table it does not have is holding nothing.
  const durations = new Map<number, { duration: number; maxDuration: number }>();
  if (durationPayload) {
    const table = openDbc(view(durationPayload), "SpellDuration");
    for (const row of table.rows()) {
      durations.set(table.id(row), {
        duration: table.int(row, "Duration"),
        maxDuration: table.int(row, "MaxDuration"),
      });
    }
  }
  const radii = new Map<number, number>();
  if (radiusPayload) {
    const table = openDbc(view(radiusPayload), "SpellRadius");
    for (const row of table.rows()) radii.set(table.id(row), table.float(row, "Radius"));
  }
  const categoryFlags = new Map<number, number>();
  if (categoryPayload) {
    const categories = openDbc(view(categoryPayload), "SpellCategory");
    for (const row of categories.rows()) categoryFlags.set(categories.id(row), categories.int(row, "Flags"));
  }
  // Two more indexes into two more small tables, resolved for the same reason as the two above.
  const ranges = new Map<number, { min: number; max: number; flags: number }>();
  if (rangePayload) {
    const table = openDbc(view(rangePayload), "SpellRange");
    for (const row of table.rows()) {
      // Slot 0 is the hostile range and slot 1 the friendly one; the pair differs on 5 of the 65
      // rows (ids 159-162 and 167), and the tooltip in the original client shows the hostile one.
      ranges.set(table.id(row), {
        min: table.float(row, "RangeMin", 0),
        max: table.float(row, "RangeMax", 0),
        flags: table.int(row, "Flags"),
      });
    }
  }
  const castTimes = new Map<number, number>();
  if (castTimePayload) {
    const table = openDbc(view(castTimePayload), "SpellCastTimes");
    for (const row of table.rows()) castTimes.set(table.id(row), table.int(row, "Base"));
  }
  const descriptionVariables = new Map<number, string>();
  if (descriptionVariablesPayload) {
    const table = openDbc(view(descriptionVariablesPayload), "SpellDescriptionVariables");
    for (const row of table.rows()) descriptionVariables.set(table.id(row), table.string(row, "Variable"));
  }

  const perEffect = (read: (effect: number) => number): number[] =>
    Array.from({ length: SPELL_EFFECTS }, (_, effect) => read(effect));

  const result = new Map<number, SpellMetadata>();
  for (const row of spells.rows()) {
    const id = spells.id(row);
    const iconId = spells.int(row, "SpellIconID");
    const metadata: SpellMetadata = {
      id,
      name: spells.locstring(row, "Name_lang") || `Spell ${id}`,
      rank: spells.locstring(row, "NameSubtext_lang"),
      description: spells.locstring(row, "Description_lang"),
      iconId,
      iconPath: iconPaths.get(iconId) ?? "",
      passive: (spells.int(row, "Attributes") & SPELL_ATTR0_PASSIVE) !== 0,
      hidden: (spells.int(row, "Attributes") & SPELL_ATTR0_HIDDEN_CLIENTSIDE) !== 0,
      powerType: spells.int(row, "PowerType"),
      powerCost: spells.int(row, "ManaCost"),
      powerCostPercent: spells.int(row, "ManaCostPct"),
      recoveryTime: spells.int(row, "RecoveryTime"),
      categoryRecoveryTime: spells.int(row, "CategoryRecoveryTime"),
      startRecoveryTime: spells.int(row, "StartRecoveryTime"),
      cooldownStartedOnEvent: (spells.int(row, "Attributes") & SPELL_ATTR0_DISABLED_WHILE_ACTIVE) !== 0
        || (((categoryFlags.get(spells.int(row, "Category")) ?? 0) & SPELL_CATEGORY_FLAG_COOLDOWN_STARTS_ON_EVENT) !== 0),
      spellLevel: spells.int(row, "SpellLevel"),
      spellClassSet: spells.int(row, "SpellClassSet"),
      // Three words, and three for a different reason than the effect columns above: this is
      // `flag96`, the 96-bit family mask a talent's condition is written against.
      spellClassMask: [0, 1, 2].map((word) => spells.int(row, "SpellClassMask", word)),
      schoolMask: spells.int(row, "SchoolMask"),
      rangeMin: ranges.get(spells.int(row, "RangeIndex"))?.min ?? 0,
      rangeMax: ranges.get(spells.int(row, "RangeIndex"))?.max ?? 0,
      rangeFlags: ranges.get(spells.int(row, "RangeIndex"))?.flags ?? 0,
      castTime: castTimes.get(spells.int(row, "CastingTimeIndex")) ?? 0,
      effectAura: perEffect((effect) => spells.int(row, "EffectAura", effect)),
      effectMiscValue: perEffect((effect) => spells.int(row, "EffectMiscValue", effect)),
      effectBasePoints: perEffect((effect) => spells.int(row, "EffectBasePoints", effect)),
      effectDieSides: perEffect((effect) => spells.int(row, "EffectDieSides", effect)),
      effectPeriod: perEffect((effect) => spells.int(row, "EffectAuraPeriod", effect)),
      effectChainTargets: perEffect((effect) => spells.int(row, "EffectChainTargets", effect)),
      effectRadius: perEffect((effect) => radii.get(spells.int(row, "EffectRadiusIndex", effect)) ?? 0),
      duration: durations.get(spells.int(row, "DurationIndex"))?.duration ?? 0,
      maxDuration: durations.get(spells.int(row, "DurationIndex"))?.maxDuration ?? 0,
      // 101 is the table's own way of writing «always», and it is written on 44,180 of the rows.
      // Left alone it would put "101%" on every tooltip that mentions a chance.
      procChance: Math.min(100, spells.int(row, "ProcChance")),
      descriptionVariablesId: spells.int(row, "DescriptionVariablesID"),
    };
    const variables = descriptionVariables.get(metadata.descriptionVariablesId);
    if (variables !== undefined) metadata.descriptionVariables = variables;
    result.set(id, metadata);
  }
  return result;
}

export async function loadSpellMetadata(directory: string): Promise<Map<number, SpellMetadata>> {
  const [spells, icons, durations, radii, categories, variables, ranges, castTimes] = await Promise.all([
    readFile(join(directory, "Spell.dbc")),
    readFile(join(directory, "SpellIcon.dbc")),
    readFile(join(directory, "SpellDuration.dbc")),
    readFile(join(directory, "SpellRadius.dbc")),
    readFile(join(directory, "SpellCategory.dbc")),
    // Old/custom datasets may not ship this optional side table. Basic `$s1`/`$d` markers still
    // work without it; only named macro definitions are unavailable in that case.
    readFile(join(directory, "SpellDescriptionVariables.dbc")).catch(() => undefined),
    readFile(join(directory, "SpellRange.dbc")),
    readFile(join(directory, "SpellCastTimes.dbc")),
  ]);
  return parseSpellMetadata(spells, icons, durations, radii, categories, variables, ranges, castTimes);
}

export type SpellDbc = Dbc<"Spell">;
