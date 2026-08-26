import type { ItemSoundInfo, WeaponSoundTables } from "../SoundClient.js";

/**
 * Which `SoundEntries` rows one swing makes, decided from the tables and from what the two
 * fighters are holding.
 *
 * Pure and free of the DOM on purpose: everything here is a table lookup over numbers the wire
 * already carries, and the acceptance for it is a list of ten combat events that must each name a
 * row of `SoundEntries` that exists. Playing them is `EnterWorld`'s `world.onSwing`, which is the
 * next slice; this is the part that can be checked without a server.
 *
 * The taxonomy is the client's own, read out of `WeaponImpactSounds`: ten slots per weapon row —
 * flesh, chain, plate, metal shield, wood shield, metal weapon, wood weapon, wood, stone,
 * ethereal — of which a body hit takes one of the first three, a block one of slots 3 and 4, and a
 * parry one of slots 5 and 6. A miss is the only outcome whose sound is not in that row at all.
 */

/** What became of a swing, in the terms `SMSG_ATTACKERSTATEUPDATE` reports it. */
export type SwingOutcome = "hit" | "miss" | "dodge" | "parry" | "block" | "evade" | "deflect";

/** One side of a swing: what it is holding, and what it is made of where it holds nothing. */
export interface Combatant {
  /** The main hand. Absent means bare hands, which is most creatures. */
  weapon?: ItemSoundInfo | undefined;
  /** The other hand, for a block — a shield, usually. */
  offHand?: ItemSoundInfo | undefined;
  /** The breastplate, which is what decides flesh, chain or plate. */
  chest?: ItemSoundInfo | undefined;
  /**
   * `CreatureSoundData.CreatureImpactType`, used when nothing is worn.
   *
   * It is a slot number in the same ten: 1,304 of the 1,306 rows are 0 — flesh — and the two that
   * are not are 1, chain.
   */
  impactType?: number | undefined;
}

/** The two sounds one swing makes: the whoosh on the way in and whatever it arrived at. */
export interface SwingSounds {
  /** `WeaponSwingSounds2`, by the swing size of the attacker's weapon. Zero for silence. */
  swing: number;
  /** The impact, the parry, the block or the miss whoosh. Zero for silence. */
  impact: number;
}

/** The ten slots of a `WeaponImpactSounds` row, named. */
export const IMPACT_SLOT = {
  flesh: 0,
  chain: 1,
  plate: 2,
  metalShield: 3,
  woodShield: 4,
  metalWeapon: 5,
  woodWeapon: 6,
  wood: 7,
  stone: 8,
  ethereal: 9,
} as const;

/** `Item.Material`, for the four values that decide a combat sound. */
const MATERIAL_METAL = 1;
const MATERIAL_WOOD = 2;
const MATERIAL_CHAIN = 5;
const MATERIAL_PLATE = 6;

/** `Item.ClassID` 2 is a weapon; everything else in a hand is held, not swung. */
const WEAPON_CLASS = 2;

/**
 * Weapon subclasses that need saying out loud.
 *
 * Measured against `Item.dbc`: 6,020 of the 6,652 class-2 items reach a `WeaponImpactSounds` row,
 * and the 632 that do not are exactly these three — Thrown 135, Crossbow 158, Wand 339. A bolt
 * lands like an arrow and a knife thrown lands like a knife held, so two of them borrow; a wand is
 * a spell in the shape of a stick and is deliberately silent.
 */
const SUBCLASS_BOW = 2;
const SUBCLASS_UNARMED = 13;
const SUBCLASS_DAGGER = 15;
const SUBCLASS_THROWN = 16;
const SUBCLASS_CROSSBOW = 18;
const SUBCLASS_WAND = 19;

/**
 * The swing size of an attacker with nothing in its hands.
 *
 * `ItemSubClass` gives the fist-weapon subclass a size of 0 — light — but a bear's paw is not a
 * dagger, and a creature swinging at you is the commonest attack in the game. Its *impact* still
 * comes from the fist row, whose ten sounds are literally named `Unarmed_Generic`,
 * `Unarmed_WeaponMetal` and `Unarmed_WeaponWood`.
 */
const UNARMED_SWING_SIZE = 1;

/**
 * The subclass an item says it is.
 *
 * `Item.Sound_Override_Subclassid` wins where the item has one — 1,976 of the 46,098 rows do — and
 * that is the column's whole purpose: a mace shaped like a hammer says so here.
 */
function declaredSubclassOf(item: ItemSoundInfo): number {
  return item.soundOverrideSubclass >= 0 ? item.soundOverrideSubclass : item.subClass;
}

/**
 * The subclass whose `WeaponImpactSounds` row decides this weapon's sound.
 *
 * Only the *landing* borrows: the two substitutions below say what a blow arrives like, not how
 * big the arm behind it is, and `weaponSoundFor` takes the whoosh from the item's own subclass.
 */
export function impactSubclassOf(item: ItemSoundInfo | undefined): number {
  if (!item || item.classId !== WEAPON_CLASS) return SUBCLASS_UNARMED;
  const subClass = declaredSubclassOf(item);
  if (subClass === SUBCLASS_CROSSBOW) return SUBCLASS_BOW;
  if (subClass === SUBCLASS_THROWN) return SUBCLASS_DAGGER;
  return subClass;
}

/** A wand is silent on purpose: it fires a spell, and the spell has a sound of its own. */
export function isSilentWeapon(item: ItemSoundInfo | undefined): boolean {
  if (!item || item.classId !== WEAPON_CLASS) return false;
  return declaredSubclassOf(item) === SUBCLASS_WAND;
}

/**
 * The row for a subclass and a material, falling back to the subclass alone and then to fists.
 *
 * Measured: 5,756 of the 6,020 weapons that have a row at all hit `subclass|metal` exactly, and
 * the 264 that do not are all in the four subclasses that ship a single row — Bow, Gun, Exotic,
 * Exotic2 — where the material has nothing to choose between. A subclass with no row at all is a
 * subclass this client's tables have never heard of, and it is heard as a fist rather than as
 * nothing at all.
 */
export function impactRowOf(tables: WeaponSoundTables, subClass: number, metal: boolean) {
  const wanted = metal ? 1 : 0;
  return tables.impacts.find((row) => row.subClass === subClass && row.metal === wanted)
    ?? tables.impacts.find((row) => row.subClass === subClass)
    ?? tables.impacts.find((row) => row.subClass === SUBCLASS_UNARMED);
}

/** `ItemSubClass.WeaponSwingSize`: 0 light, 1 one-handed, 2 two-handed. */
export function swingSizeOf(tables: WeaponSoundTables, subClass: number): number {
  return tables.swingSizes.find(([id]) => id === subClass)?.[1] ?? UNARMED_SWING_SIZE;
}

/** Which of the three body slots a defender wearing this is. */
function bodySlotOf(defender: Combatant): number {
  const material = defender.chest?.material;
  if (material === MATERIAL_CHAIN) return IMPACT_SLOT.chain;
  // Plate is spelled two ways in `Item.dbc`, and both are plate: of the 643 chests and robes whose
  // armour subclass is plate, 345 carry `Material` 6 and 274 carry 1, metal — and metal is on no
  // chest of any other subclass at all, so it is not a value that could mean something else here.
  // Reading it as flesh took the plate sound from 619 of those 643 down to 345.
  if (material === MATERIAL_PLATE || material === MATERIAL_METAL) return IMPACT_SLOT.plate;
  // Cloth, leather and nothing at all are all flesh, which is what the original client does too:
  // the table has three body sounds and padding is not one of them.
  if (material !== undefined) return IMPACT_SLOT.flesh;
  return defender.impactType ?? IMPACT_SLOT.flesh;
}

/**
 * Whether a thing that stopped a blow sounds like metal.
 *
 * A different question from the one that picks the attacker's row — that one is `Material == 1`,
 * measured — because here the choice is between exactly two sounds. Everything that is not wood
 * rings: 567 of the 686 shields in `Item.dbc` are metal and 105 more are plate, against 9 wooden
 * ones, and among weapons it is 4,099 metal to 2,388 wood.
 */
function soundsMetallic(item: ItemSoundInfo | undefined): boolean {
  return item?.material !== MATERIAL_WOOD;
}

/**
 * The whoosh and the landing of one swing.
 *
 * Zero for either half means silence, and silence is a real answer: a wand makes none of its own,
 * and a weapon table that has not arrived yet makes none either.
 */
export function weaponSoundFor(
  outcome: SwingOutcome,
  critical: boolean,
  attacker: Combatant,
  defender: Combatant,
  tables: WeaponSoundTables | undefined,
): SwingSounds {
  const silent = { swing: 0, impact: 0 };
  if (!tables) return silent;
  if (isSilentWeapon(attacker.weapon)) return silent;

  const subClass = impactSubclassOf(attacker.weapon);
  // The whoosh is the weapon's *own* size, not the size of the row its landing borrows, and the
  // question is «is a weapon being swung» rather than «is the hand holding anything». Both matter:
  // a thrown knife lands like a held one but is a one-handed swing where the dagger is a light one
  // — 135 of them in `Item.dbc`, the only subclass the borrowing moves — and a subclass number
  // means nothing outside its own class, so a hand holding a piece of armour would take its size
  // from whatever weapon shares that number (6 is a shield among armour and a polearm among
  // weapons) instead of swinging like the hand it is.
  const weapon = attacker.weapon?.classId === WEAPON_CLASS ? attacker.weapon : undefined;
  const size = weapon ? swingSizeOf(tables, declaredSubclassOf(weapon)) : UNARMED_SWING_SIZE;
  const swing = tables.swings.find((row) => row.size === size && row.critical === critical)?.soundId ?? 0;

  if (outcome === "miss" || outcome === "dodge" || outcome === "evade" || outcome === "deflect") {
    // A dodge plays the miss whoosh: a search of every `SoundEntries` name for miss, dodge, parry,
    // block, evade or deflect turns up 80 rows and not one of them is a dodge. Two-handed is the
    // swing size and not the inventory slot, because that is the column that says how big it is.
    return { swing, impact: size === 2 ? tables.miss.twoHanded : tables.miss.oneHanded };
  }

  const row = impactRowOf(tables, subClass, attacker.weapon?.material === MATERIAL_METAL);
  if (!row) return { swing, impact: 0 };
  const slot = outcome === "parry"
    ? (soundsMetallic(defender.weapon) ? IMPACT_SLOT.metalWeapon : IMPACT_SLOT.woodWeapon)
    : outcome === "block"
      ? (soundsMetallic(defender.offHand) ? IMPACT_SLOT.metalShield : IMPACT_SLOT.woodShield)
      : bodySlotOf(defender);
  const sounds = critical ? row.critical : row.normal;
  // A critical slot the table leaves at zero falls back to the ordinary sound: 12 of the 300 are
  // zero, 2 of them beside an ordinary sound that exists, and a critical hit that is silent when
  // an ordinary one would be heard reads as a bug in the client rather than as a gap in a table.
  // The two are `WeaponImpactSounds` rows 21 and 22, the dagger's metal-weapon slot, whose
  // ordinary sound is `1hParryMetalHitMetal` — and 921 of `Item.dbc`'s weapons land on one of
  // those two rows, so it is a critical dagger blow parried on a sword that goes quiet without it.
  return { swing, impact: sounds[slot] || row.normal[slot] || 0 };
}
