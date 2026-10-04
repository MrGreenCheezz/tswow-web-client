import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { explicitUnitTargetContract } from "./ExplicitUnitTargetContract.js";
import { explicitSpellTargetContract } from "./ExplicitSpellTargetContract.js";
import { openDbc, type Dbc } from "./Dbc.js";
import { parseSpellShapeshiftFormBonuses } from "./SpellShapeshiftForms.js";
import { parseSummonProperties, spellSummonProperties, type SummonPropertiesRow } from "./SummonPropertiesMetadata.js"; // L13

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
/**
 * `SPELL_ATTR0_ON_NEXT_SWING` and `_ON_NEXT_SWING_2`, which the core documents as handled
 * identically by server and client (SharedDefines.h:409, 417): the strike replaces the next melee
 * swing, and the tooltip's cast row says so («Следующая атака», `SPELL_ON_NEXT_SWING`).
 */
const SPELL_ATTR0_ON_NEXT_SWING = 0x00000004;
const SPELL_ATTR0_ON_NEXT_SWING_2 = 0x00000400;
/** `SPELL_ATTR1_CHANNELED_1` and `_2` (SharedDefines.h:446, 450): «Потоковое» on the cast row. */
const SPELL_ATTR1_CHANNELED_1 = 0x00000004;
const SPELL_ATTR1_CHANNELED_2 = 0x00000040;
/** `SPELL_ATTR2_AUTOREPEAT_FLAG`: the spell occupies the ranged repeat container. */
const SPELL_ATTR2_AUTOREPEAT_FLAG = 0x00000020;
/** The original stance bar uses this flag and the authored StanceBarOrder. */
const SPELL_ATTR2_DISPLAY_IN_STANCE_BAR = 0x00000010;
/** `SPELL_CATEGORY_FLAG_COOLDOWN_STARTS_ON_EVENT` in SpellCategory.dbc. */
const SPELL_CATEGORY_FLAG_COOLDOWN_STARTS_ON_EVENT = 0x04;

/**
 * Server-only linked effects have no client DBC row, but the world database names the visible
 * spell that owns them.  Keep these aliases at the metadata boundary so every browser surface
 * gets the owner's real localisation, icon and client-visibility flags instead of inventing an
 * "unknown buff".  The current realm's `spell_linked_spell` row is `26023 -> 61418` (type 2,
 * Pursuit of Justice mounted-speed effect); neither Spell.dbc shipped with the dataset nor the
 * original client archive contains 61418.
 */
const SERVER_LINKED_SPELL_ALIASES = new Map<number, number>([
  [61418, 26023],
]);

/** The v11 payload is understood by target-selection clients. */
export const SPELL_TARGETING_CONTRACT_VERSION = 1;

/** Semantic selection requirements, deliberately not SpellCastTargetFlags or packet bits. */
export const SPELL_REQUIRED_TARGET_MASK = {
  None: 0,
  Unit: 1,
  Item: 2,
  Ground: 4,
} as const;
/** All combinations of the three bounded semantic bits. */
export type SpellRequiredTargetMask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A single selection flow the client may enter without inventing a target. */
export const SPELL_REQUIRED_TARGET_MODE = {
  Unknown: 0,
  Unit: 1,
  Item: 2,
  Ground: 3,
} as const;
export type SpellRequiredTargetMode = typeof SPELL_REQUIRED_TARGET_MODE[keyof typeof SPELL_REQUIRED_TARGET_MODE];

export interface SpellTargetingMetadata {
  targetingContractVersion: number;
  requiredTargetMask: SpellRequiredTargetMask;
  requiredTargetMode: SpellRequiredTargetMode;
}

// SpellInfo::_InitializeExplicitTargetMask starts with Spell.dbc.Targets, then can add a
// destination from implicit effects. Spell::InitExplicitTargets fills that derived destination
// from the selected target or caster when the packet omits it. Only the DBC seed below describes
// a direct client selection. Source, mixed and unsupported selections remain Unknown. A client
// must fail closed for known v1 Unknown plus a nonzero mask; no general GameObject flow exists.
const TARGET_FLAG_UNIT_SELECTION = 0x0011058e;
const TARGET_FLAG_ITEM = 0x00000010;
const TARGET_FLAG_SOURCE_LOCATION = 0x00000020;
const TARGET_FLAG_DEST_LOCATION = 0x00000040;
const KNOWN_SELECTION_FLAGS = TARGET_FLAG_UNIT_SELECTION | TARGET_FLAG_ITEM
  | TARGET_FLAG_SOURCE_LOCATION | TARGET_FLAG_DEST_LOCATION;

export function spellRequiredTargeting(targets: number): SpellTargetingMetadata {
  const targetFlags = targets >>> 0;
  let requiredTargetMask: SpellRequiredTargetMask = SPELL_REQUIRED_TARGET_MASK.None;
  if ((targetFlags & TARGET_FLAG_UNIT_SELECTION) !== 0) {
    requiredTargetMask = (requiredTargetMask | SPELL_REQUIRED_TARGET_MASK.Unit) as SpellRequiredTargetMask;
  }
  if ((targetFlags & TARGET_FLAG_ITEM) !== 0) {
    requiredTargetMask = (requiredTargetMask | SPELL_REQUIRED_TARGET_MASK.Item) as SpellRequiredTargetMask;
  }
  if ((targetFlags & TARGET_FLAG_DEST_LOCATION) !== 0) {
    requiredTargetMask = (requiredTargetMask | SPELL_REQUIRED_TARGET_MASK.Ground) as SpellRequiredTargetMask;
  }

  const unsupported = (targetFlags & ~KNOWN_SELECTION_FLAGS) !== 0;
  const hasSource = (targetFlags & TARGET_FLAG_SOURCE_LOCATION) !== 0;
  let requiredTargetMode: SpellRequiredTargetMode = SPELL_REQUIRED_TARGET_MODE.Unknown;
  if (!unsupported && !hasSource) {
    switch (requiredTargetMask) {
      case SPELL_REQUIRED_TARGET_MASK.Unit:
        requiredTargetMode = SPELL_REQUIRED_TARGET_MODE.Unit;
        break;
      case SPELL_REQUIRED_TARGET_MASK.Item:
        requiredTargetMode = SPELL_REQUIRED_TARGET_MODE.Item;
        break;
      case SPELL_REQUIRED_TARGET_MASK.Ground:
        requiredTargetMode = SPELL_REQUIRED_TARGET_MODE.Ground;
        break;
    }
  }

  return { targetingContractVersion: SPELL_TARGETING_CONTRACT_VERSION, requiredTargetMask, requiredTargetMode };
}

export interface SpellMetadata {
  id: number;
  name: string;
  rank: string;
  description: string;
  /**
   * `AuraDescription_lang`: what the 3.3.5 client shows on a buff or debuff's tooltip, which is
   * not the cast description. «Боевой крик» (6673) casts as «Воин издает боевой крик, увеличивающий
   * силу атаки всех участников группы…» and sits on the buff bar as «Сила атаки увеличена на $s1.».
   * Measured on this dataset: 17,443 of 72,029 rows carry one and 13,553 of those differ from the
   * description. Empty where the row has none; absent from a gateway older than the browser's
   * v=13 key, which the browser reads as «use the description».
   */
  auraDescription?: string;
  /** `SPELL_ATTR0_ON_NEXT_SWING` or `_2` (434 rows, «Удар героя» among them): «Следующая атака». */
  onNextSwing?: boolean;
  /**
   * `SPELL_ATTR1_CHANNELED_1` or `_2`: «Потоковое». 1,961 rows, 1,745 of them with a cast time of 0
   * — «Чародейские стрелы» (5143) is one — which is why `castTime` alone read them as instant.
   */
  channeled?: boolean;
  iconId: number;
  iconPath: string;
  passive: boolean;
  /** Marked invisible by the artist. Never belongs in the spellbook or on the aura bar. */
  hidden: boolean;
  /** SPELL_ATTR0_TRADESPELL: recipes belong in a profession, not the spellbook. */
  tradeSkill?: boolean;
  /** Crafting operands come from the same DBC row as the spell description. */
  effects?: number[];
  effectItemType?: number[];
  reagents?: Array<{ itemId: number; count: number }>;
  tools?: number[];
  requiredToolCategories?: number[];
  requiredToolNames?: string[];
  equippedItemClass?: number;
  equippedItemSubclass?: number;
  equippedItemInvTypes?: number;
  /** Auto Shot/Shoot: one targeted start request followed by server-timed ranged attacks. */
  autoRepeat: boolean;
  displayInStanceBar: boolean;
  stanceBarOrder: number;
  /** SpellShapeshiftForm.dbc BonusActionBar for a MOD_SHAPESHIFT effect; absent if unresolved. */
  bonusActionBarOffset?: number;
  targetingContractVersion?: number;
  requiredTargetMask?: SpellRequiredTargetMask;
  requiredTargetMode?: SpellRequiredTargetMode;
  /**
   * OPEN_LOCK (33) with ImplicitTargetA 26, TARGET_GAMEOBJECT_ITEM_TARGET: «Взлом замка» (1804), the
   * lock picks and the keys — 19 rows on this dataset, all with Targets 0. The original client ORs
   * TARGET_FLAG_GAMEOBJECT_ITEM into the pending mask for that implicit target (Wow.exe 0x00809610),
   * so its cursor takes a carried item or a game object (0x0080bc80). Since the browser's `v=14`.
   */
  itemOrObject?: boolean;
  /**
   * `DispelType` (record +0x08), raw: 1 Magic, 2 Curse, 3 Disease, 4 Poison, 9 Enrage…
   * (`SharedDefines.h` DispelType). Present on every row since the browser's `v=15` (5.20) — the
   * browser tells an older gateway by its absence. UnitAura's isStealable tests `1 << dispelType`
   * against the player's steal mask (Wow.exe 0x0053d680).
   */
  dispelType?: number;
  /**
   * UnitAura's fifth value as Wow.exe 0x006147c0 builds it: the `SpellDispelType.dbc` row's
   * `InternalName` when that row's `ImmunityPossible` is set — "Magic", "Curse", "Disease",
   * "Poison", and "" for Enrage (9) on this dataset, which BuffFrame.lua maps to
   * `DebuffTypeColor[""]`. Absent for any other type (nil in Lua) and without the side table.
   */
  debuffType?: string;
  /**
   * The name the aura tooltip writes right of the aura's title (Wow.exe 0x00625350, `SetUnitAura`):
   * the `SpellDispelType.dbc` row's localised `Name` («Магия», «Проклятие», «Исступление»…) when
   * DispelType is not 0 and the row's `ImmunityPossible` is set. Absent otherwise. Since `v=15`.
   */
  dispelName?: string;
  /**
   * `DefenseType` (SpellDmgClass: 0 none, 1 magic, 2 melee, 3 ranged), raw. Since `v=16`, present on
   * every row — the browser tells an older gateway by `preventionType`'s absence.
   */
  dmgClass?: number;
  /**
   * `PreventionType` (record +0x258 in the client's copy): 1 silence, 2 pacify. Wow.exe 0x007262e0
   * treats only a cast with 1 as one the player's interrupts and silences can stop (UnitCastingInfo's
   * notInterruptible, UNIT_SPELLCAST_(NOT_)INTERRUPTIBLE). Since `v=16`, on every row.
   */
  preventionType?: number;
  /** `InterruptFlags` and `ChannelInterruptFlags`, raw (SpellInterruptFlags / channel flags). Since `v=16`. */
  interruptFlags?: number;
  channelInterruptFlags?: number;
  /**
   * The Call of the Elements slots this spell fills, as Wow.exe 0x00542030 files a learned spell into
   * GetMultiCastTotemSpells' lists: only with SPELL_ATTR7_SUMMON_PLAYER_TOTEM (0x20), and per
   * `RequiredTotemCategoryID` through 0x005a7b50 (2 → 0x2 earth, 3 → 0x8 air, 4 → 0x1 fire,
   * 5 → 0x4 water, 21 → 0xf). Bit n is slot n+1 (fire 1, earth 2, water 3, air 4, Constants.lua).
   * 0 for every other spell. Since `v=16`.
   */
  totemSlotMask?: number;
  /**
   * L13 (v=17, 5.30): `StartRecoveryCategory` (record +0x234 in the client's copy): the global cooldown's
   * category. The realm keys its global cooldowns by it and starts none for 0 (Spell.cpp:8698,
   * SpellHistory.cpp:585-594); Wow.exe 0x00807980 holds a spell while a running global part of the same
   * category lasts (133 for 7,045 of the dataset's non-passive rows, 0 for 56,741). Present on every row
   * since `v=17`, 0 included — the browser tells an older gateway by its absence.
   */
  startRecoveryCategory?: number;
  /** L13 (v=17, 3.12): `EffectMiscValueB[3]`, raw (for SPELL_EFFECT_SUMMON, a SummonProperties id). */
  effectMiscValueB?: number[];
  /**
   * L13 (v=17, 3.12): per effect, the `SummonProperties.dbc` row a SPELL_EFFECT_SUMMON (28) names by its
   * EffectMiscValueB, null for any other effect or an id the table lacks (SummonPropertiesMetadata.ts).
   * Only on rows with a summon effect, and only when the dataset ships the table.
   */
  summonProperties?: (SummonPropertiesRow | null)[];
  /** Narrow v1 fallback for active implicit UNIT_TARGET* effects when legacy Targets is zero. */
  unitTargetContractVersion?: number;
  supportsExplicitUnitTarget?: boolean;
  /** Bounded v2 semantic target shape and mandatory native-selection subset from the active TrinityCore target/effect tables. */
  explicitTargetContractVersion?: number;
  explicitTargetMask?: number;
  /** Native choices that must be collected; inferred Unit/Source/destination data stays server-derived. */
  clientSelectionMask?: number;
  supportsExplicitTarget?: boolean;
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
   * focus, energy and happiness. The selected core does not apply `ManaCostPct` to rune or runic
   * power. Resolution belongs on the client that knows the caster.
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
  /**
   * The friendly slot of the same `SpellRange` row (`RangeMin[1]`, `RangeMax[1]`). The client picks
   * the slot per target (Wow.exe 0x00801650: 1 when the caster can assist the target, 0x007293d0, or —
   * without a unit target — when the spell reads as helpful, 0x007fe1b0) before it measures
   * `IsActionInRange` (1.14b). They differ on 5 of the 65 rows (159-162, 167). Since the browser's
   * `v=14`; absent from an older gateway, which the browser reads as «the hostile slot».
   */
  rangeMinFriendly?: number;
  rangeMaxFriendly?: number;
  /**
   * The raw target columns 0x00809610 builds the client's target mask from, since `v=14`:
   * `Targets` (record +0x40; the low 16 bits are the TARGET_FLAG_* mask),
   * `ImplicitTargetA[3]` (+0x158) and `ImplicitTargetB[3]` (+0x164; read by 0x007fe1b0 only), and
   * `TargetCreatureType` (+0x44).
   */
  targets?: number;
  implicitTargetA?: number[];
  implicitTargetB?: number[];
  targetCreatureType?: number;
  /**
   * `Attributes` … `AttributesExG` (+0x10 … +0x2c), raw, since `v=14`: the range and target
   * checks read bits of five of them (ATTR0 0x2 ranged, 0x404 next swing; ATTR2 0x1 dead targets;
   * ATTR3 0x20000000 no caster modifiers; ATTR5 0x800 target of target; ATTR6 0x8, 0x1000000).
   */
  attributes?: number[];
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

/** The eight attribute words, in record order (+0x10 … +0x2c). */
const SPELL_ATTRIBUTE_COLUMNS = [
  "Attributes", "AttributesEx", "AttributesExB", "AttributesExC", "AttributesExD", "AttributesExE",
  "AttributesExF", "AttributesExG",
] as const;

/** `SPELL_EFFECT_OPEN_LOCK` and `TARGET_GAMEOBJECT_ITEM_TARGET` (SharedDefines.h). */
const SPELL_EFFECT_OPEN_LOCK = 33;
const TARGET_GAMEOBJECT_ITEM_TARGET = 26;

/**
 * `itemOrObject`: an OPEN_LOCK effect whose ImplicitTargetA is TARGET_GAMEOBJECT_ITEM_TARGET — the
 * 19 rows of this dataset («Взлом замка» 1804, the picks 491/857/10165/10166, the keys 19646…). «Открывание»
 * (3365, 21651: target 23) is the object-click autocast and gets no cursor.
 */
export function opensLockOnItemOrObject(effects: readonly number[], implicitTargetA: readonly number[]): boolean {
  return effects.some((effect, index) => effect === SPELL_EFFECT_OPEN_LOCK && implicitTargetA[index] === TARGET_GAMEOBJECT_ITEM_TARGET);
}

/** `SPELL_ATTR7_SUMMON_PLAYER_TOTEM` (SharedDefines.h): the shaman's own totems. */
const SPELL_ATTR7_SUMMON_PLAYER_TOTEM = 0x20;

/** Wow.exe 0x005a7b50: a TotemCategory id → the multi-cast slot bits it serves. */
export function totemCategorySlotMask(category: number): number {
  switch (category) {
    case 2: return 0x2;
    case 3: return 0x8;
    case 4: return 0x1;
    case 5: return 0x4;
    case 21: return 0xf;
    default: return 0;
  }
}

/** `totemSlotMask`: the slots of both required totem categories, only for a player totem. */
export function spellTotemSlotMask(attributesExG: number, requiredTotemCategories: readonly number[]): number {
  if ((attributesExG & SPELL_ATTR7_SUMMON_PLAYER_TOTEM) === 0) return 0;
  let mask = 0;
  for (const category of requiredTotemCategories) mask |= totemCategorySlotMask(category);
  return mask;
}

export function parseSpellMetadata(
  spellPayload: Uint8Array,
  iconPayload: Uint8Array,
  durationPayload?: Uint8Array,
  radiusPayload?: Uint8Array,
  categoryPayload?: Uint8Array,
  descriptionVariablesPayload?: Uint8Array,
  rangePayload?: Uint8Array,
  castTimePayload?: Uint8Array,
  shapeshiftFormPayload?: Uint8Array,
  dispelTypePayload?: Uint8Array,
  summonPropertiesPayload?: Uint8Array, // L13 (v=17)
): Map<number, SpellMetadata> {
  const view = (payload: Uint8Array): Buffer =>
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const spells = openDbc(view(spellPayload), "Spell");
  const icons = openDbc(view(iconPayload), "SpellIcon");
  const formBonuses = shapeshiftFormPayload
    ? parseSpellShapeshiftFormBonuses(shapeshiftFormPayload) : new Map<number, number>();
  const debuffTypes = dispelTypePayload ? parseDebuffTypeNames(dispelTypePayload) : new Map<number, string>();
  const dispelNames = dispelTypePayload
    ? parseDispelTypeNames(dispelTypePayload, process.env["CLIENT_LOCALE"] ?? "ruRU") : new Map<number, string>();
  // L13 (v=17): without the table no row gets `summonProperties` (unknown, not «no row»).
  const summonProperties = summonPropertiesPayload ? parseSummonProperties(summonPropertiesPayload) : undefined;

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
  const ranges = new Map<number, { min: number; max: number; minFriendly: number; maxFriendly: number; flags: number }>();
  if (rangePayload) {
    const table = openDbc(view(rangePayload), "SpellRange");
    for (const row of table.rows()) {
      // Slot 0 is the hostile range and slot 1 the friendly one; the pair differs on 5 of the 65
      // rows (ids 159-162 and 167), and the tooltip in the original client shows the hostile one.
      ranges.set(table.id(row), {
        min: table.float(row, "RangeMin", 0),
        max: table.float(row, "RangeMax", 0),
        minFriendly: table.float(row, "RangeMin", 1),
        maxFriendly: table.float(row, "RangeMax", 1),
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
    const targeting = spellRequiredTargeting(spells.int(row, "Targets"));
    const unitTargetContract = explicitUnitTargetContract({
      targets: spells.int(row, "Targets"),
      effects: perEffect((effect) => spells.int(row, "Effect", effect)),
      implicitTargetA: perEffect((effect) => spells.int(row, "ImplicitTargetA", effect)),
      implicitTargetB: perEffect((effect) => spells.int(row, "ImplicitTargetB", effect)),
    });
    const range = ranges.get(spells.int(row, "RangeIndex"));
    const explicitTargetContract = explicitSpellTargetContract({
      targets: spells.int(row, "Targets"),
      effects: perEffect((effect) => spells.int(row, "Effect", effect)),
      implicitTargetA: perEffect((effect) => spells.int(row, "ImplicitTargetA", effect)),
      implicitTargetB: perEffect((effect) => spells.int(row, "ImplicitTargetB", effect)),
      rangeMaxHostile: range?.max ?? 0,
      rangeMaxFriendly: range?.maxFriendly ?? 0,
    });
    const iconId = spells.int(row, "SpellIconID");
    const metadata: SpellMetadata = {
      id,
      name: spells.locstring(row, "Name_lang") || `Spell ${id}`,
      rank: spells.locstring(row, "NameSubtext_lang"),
      description: spells.locstring(row, "Description_lang"),
      auraDescription: spells.locstring(row, "AuraDescription_lang"),
      onNextSwing: (spells.int(row, "Attributes") & (SPELL_ATTR0_ON_NEXT_SWING | SPELL_ATTR0_ON_NEXT_SWING_2)) !== 0,
      channeled: (spells.int(row, "AttributesEx") & (SPELL_ATTR1_CHANNELED_1 | SPELL_ATTR1_CHANNELED_2)) !== 0,
      iconId,
      iconPath: iconPaths.get(iconId) ?? "",
      passive: (spells.int(row, "Attributes") & SPELL_ATTR0_PASSIVE) !== 0,
      hidden: (spells.int(row, "Attributes") & SPELL_ATTR0_HIDDEN_CLIENTSIDE) !== 0,
      tradeSkill: (spells.int(row, "Attributes") & 0x20) !== 0,
      effects: perEffect((effect) => spells.int(row, "Effect", effect)),
      effectItemType: perEffect((effect) => spells.int(row, "EffectItemType", effect)),
      reagents: Array.from({ length: 8 }, (_, index) => ({
        itemId: spells.int(row, "Reagent", index), count: spells.int(row, "ReagentCount", index),
      })).filter((reagent) => reagent.itemId > 0 && reagent.count > 0),
      tools: [0, 1].map((index) => spells.int(row, "Totem", index)).filter((id) => id > 0),
      requiredToolCategories: [0, 1].map((index) => spells.int(row, "RequiredTotemCategoryID", index)).filter((id) => id > 0),
      equippedItemClass: spells.int(row, "EquippedItemClass"),
      equippedItemSubclass: spells.int(row, "EquippedItemSubclass"),
      equippedItemInvTypes: spells.int(row, "EquippedItemInvTypes"),
      autoRepeat: (spells.int(row, "AttributesExB") & SPELL_ATTR2_AUTOREPEAT_FLAG) !== 0,
      displayInStanceBar: (spells.int(row, "AttributesExB") & SPELL_ATTR2_DISPLAY_IN_STANCE_BAR) !== 0,
      stanceBarOrder: spells.int(row, "StanceBarOrder"),
      targetingContractVersion: targeting.targetingContractVersion,
      requiredTargetMask: targeting.requiredTargetMask,
      requiredTargetMode: targeting.requiredTargetMode,
      unitTargetContractVersion: unitTargetContract.unitTargetContractVersion,
      supportsExplicitUnitTarget: unitTargetContract.supportsExplicitUnitTarget,
      explicitTargetContractVersion: explicitTargetContract.explicitTargetContractVersion,
      explicitTargetMask: explicitTargetContract.explicitTargetMask,
      clientSelectionMask: explicitTargetContract.clientSelectionMask,
      supportsExplicitTarget: explicitTargetContract.supportsExplicitTarget,
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
      rangeMin: range?.min ?? 0,
      rangeMax: range?.max ?? 0,
      rangeFlags: range?.flags ?? 0,
      rangeMinFriendly: range?.minFriendly ?? 0,
      rangeMaxFriendly: range?.maxFriendly ?? 0,
      targets: spells.int(row, "Targets") >>> 0,
      implicitTargetA: perEffect((effect) => spells.int(row, "ImplicitTargetA", effect)),
      implicitTargetB: perEffect((effect) => spells.int(row, "ImplicitTargetB", effect)),
      targetCreatureType: spells.int(row, "TargetCreatureType") >>> 0,
      attributes: SPELL_ATTRIBUTE_COLUMNS.map((column) => spells.int(row, column) >>> 0),
      itemOrObject: opensLockOnItemOrObject(
        perEffect((effect) => spells.int(row, "Effect", effect)),
        perEffect((effect) => spells.int(row, "ImplicitTargetA", effect))),
      dispelType: spells.int(row, "DispelType"),
      dmgClass: spells.int(row, "DefenseType"),
      preventionType: spells.int(row, "PreventionType"),
      interruptFlags: spells.int(row, "InterruptFlags") >>> 0,
      channelInterruptFlags: spells.int(row, "ChannelInterruptFlags") >>> 0,
      totemSlotMask: spellTotemSlotMask(spells.int(row, "AttributesExG"),
        [0, 1].map((index) => spells.int(row, "RequiredTotemCategoryID", index))),
      startRecoveryCategory: spells.int(row, "StartRecoveryCategory"), // L13 (v=17)
      effectMiscValueB: perEffect((effect) => spells.int(row, "EffectMiscValueB", effect)), // L13 (v=17)
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
    const debuffType = debuffTypes.get(metadata.dispelType ?? 0);
    if (debuffType !== undefined) metadata.debuffType = debuffType;
    const dispelName = metadata.dispelType ? dispelNames.get(metadata.dispelType) : undefined;
    if (dispelName !== undefined) metadata.dispelName = dispelName;
    if (summonProperties) { // L13 (v=17)
      const summon = spellSummonProperties(metadata.effects ?? [], metadata.effectMiscValueB ?? [], summonProperties);
      if (summon !== undefined) metadata.summonProperties = summon;
    }
    const variables = descriptionVariables.get(metadata.descriptionVariablesId);
    if (variables !== undefined) metadata.descriptionVariables = variables;
    const formEffect = metadata.effectAura.indexOf(36); // SPELL_AURA_MOD_SHAPESHIFT
    if (formEffect >= 0) {
      const bonus = formBonuses.get(metadata.effectMiscValue[formEffect]!);
      if (bonus !== undefined) metadata.bonusActionBarOffset = bonus;
    }
    result.set(id, metadata);
  }
  return result;
}

export async function loadSpellMetadata(directory: string): Promise<Map<number, SpellMetadata>> {
  const [spells, icons, durations, radii, categories, variables, ranges, castTimes, shapeshiftForms] = await Promise.all([
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
    // Older/custom datasets can omit the side table. In that case the page offset remains
    // unresolved; do not guess one from a stance name, spell id or display flag.
    readFile(join(directory, "SpellShapeshiftForm.dbc")).catch(() => undefined),
  ]);
  // Optional like the side tables above: without it every aura's debuffType stays nil.
  const dispelTypes = await readFile(join(directory, "SpellDispelType.dbc")).catch(() => undefined);
  // L13 (v=17): optional too — without it a summon effect's title stays unknown in the browser.
  const summonProperties = await readFile(join(directory, "SummonProperties.dbc")).catch(() => undefined);
  const metadata = parseSpellMetadata(spells, icons, durations, radii, categories, variables, ranges, castTimes,
    shapeshiftForms, dispelTypes, summonProperties);
  const toolNames = await loadTotemCategoryNames(directory);
  for (const spell of metadata.values()) {
    spell.requiredToolNames = (spell.requiredToolCategories ?? []).map((id) => toolNames.get(id) ?? "Профессиональный инструмент");
  }
  for (const [effectId, ownerId] of SERVER_LINKED_SPELL_ALIASES) {
    if (metadata.has(effectId)) continue;
    const owner = metadata.get(ownerId);
    if (owner) metadata.set(effectId, { ...owner, id: effectId });
  }
  return metadata;
}

/**
 * `SpellDispelType.dbc` (3.3.5.12340, WoWDBDefs: ID, Name_lang[17], Mask, ImmunityPossible,
 * InternalName — 21 words a row): dispel type → the string UnitAura returns, kept only for rows
 * with ImmunityPossible set, which is the test Wow.exe 0x006147c0 applies (row +0xc) before it
 * hands out InternalName (row +0x10). An unreadable table gives an empty map.
 */
export function parseDebuffTypeNames(payload: Uint8Array): Map<number, string> {
  const result = new Map<number, string>();
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("latin1") !== "WDBC") return result;
  const rows = bytes.readUInt32LE(4);
  if (bytes.readUInt32LE(8) !== 21 || bytes.readUInt32LE(12) !== 84) return result;
  const strings = 20 + rows * 84;
  if (strings + bytes.readUInt32LE(16) !== bytes.length) return result;
  for (let index = 0; index < rows; index++) {
    const at = 20 + index * 84;
    if (bytes.readUInt32LE(at + 19 * 4) === 0) continue;
    const offset = bytes.readUInt32LE(at + 20 * 4);
    if (strings + offset >= bytes.length) continue;
    const end = bytes.indexOf(0, strings + offset);
    if (end < 0) continue;
    result.set(bytes.readUInt32LE(at), bytes.subarray(strings + offset, end).toString("utf8"));
  }
  return result;
}

/**
 * `SpellDispelType.dbc`'s localised `Name_lang` (the client's locale column, then enUS, then any)
 * for the rows with ImmunityPossible set — what Wow.exe 0x00625350 writes right of an aura
 * tooltip's title (row +0x4 after the row +0xc test). An unreadable table gives an empty map.
 */
export function parseDispelTypeNames(payload: Uint8Array, locale: string): Map<number, string> {
  const result = new Map<number, string>();
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("latin1") !== "WDBC") return result;
  const rows = bytes.readUInt32LE(4);
  if (bytes.readUInt32LE(8) !== 21 || bytes.readUInt32LE(12) !== 84) return result;
  const strings = 20 + rows * 84;
  if (strings + bytes.readUInt32LE(16) !== bytes.length) return result;
  const locales = ["enUS", "koKR", "frFR", "deDE", "zhCN", "zhTW", "esES", "esMX", "ruRU"];
  const preferred = Math.max(0, locales.indexOf(locale));
  for (let index = 0; index < rows; index++) {
    const at = 20 + index * 84;
    if (bytes.readUInt32LE(at + 19 * 4) === 0) continue;
    for (const column of [preferred, 0, ...Array.from({ length: 16 }, (_, slot) => slot)]) {
      const offset = bytes.readUInt32LE(at + 4 + column * 4);
      if (offset <= 0 || strings + offset >= bytes.length) continue;
      const end = bytes.indexOf(0, strings + offset);
      if (end <= strings + offset) continue;
      result.set(bytes.readUInt32LE(at), bytes.subarray(strings + offset, end).toString("utf8"));
      break;
    }
  }
  return result;
}

/** DBCStructure.h: ID, sixteen localised names, locale mask, category type and mask. */
async function loadTotemCategoryNames(directory: string): Promise<Map<number, string>> {
  const payload = await readFile(join(directory, "TotemCategory.dbc")).catch(() => undefined);
  const result = new Map<number, string>();
  if (!payload || payload.length < 20 || payload.subarray(0, 4).toString("latin1") !== "WDBC") return result;
  const rows = payload.readUInt32LE(4);
  if (payload.readUInt32LE(8) !== 20 || payload.readUInt32LE(12) !== 80) return result;
  const strings = 20 + rows * 80;
  if (strings + payload.readUInt32LE(16) !== payload.length) return result;
  const locales = ["enUS", "koKR", "frFR", "deDE", "zhCN", "zhTW", "esES", "esMX", "ruRU"];
  const preferred = Math.max(0, locales.indexOf(process.env["CLIENT_LOCALE"] ?? "ruRU"));
  for (let index = 0; index < rows; index++) {
    const at = 20 + index * 80;
    for (const locale of [preferred, 0, ...Array.from({ length: 16 }, (_, slot) => slot)]) {
      const offset = payload.readUInt32LE(at + 4 + locale * 4);
      if (offset <= 0 || strings + offset >= payload.length) continue;
      const end = payload.indexOf(0, strings + offset);
      if (end <= strings + offset) continue;
      result.set(payload.readUInt32LE(at), payload.subarray(strings + offset, end).toString("utf8"));
      break;
    }
  }
  return result;
}

export type SpellDbc = Dbc<"Spell">;
