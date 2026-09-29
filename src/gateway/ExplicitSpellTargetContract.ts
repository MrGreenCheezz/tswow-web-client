/**
 * A bounded semantic view of TrinityCore's `SpellInfo::_InitializeExplicitTargetMask`.
 *
 * It is intentionally not a copy of packet flags.  The Unity client can write one ordinary
 * world-object GUID, one carried-item GUID, and optional destination coordinates.  A source
 * location stays semantic only: `Spell::InitExplicitTargets` supplies the caster when it is
 * omitted from the packet.  Every target/effect code below comes from the active 3.3.5
 * `SpellImplicitTargetInfo::_data` and `SpellEffectInfo::_data` tables.
 */
// v2 adds `clientSelectionMask`.  The final core mask and a mandatory native cursor are
// deliberately different concepts: `Spell::InitExplicitTargets` supplies omitted Unit,
// Source and effect-derived Destination data from selection/caster state.
export const EXPLICIT_SPELL_TARGET_CONTRACT_VERSION = 2;

export const EXPLICIT_SPELL_TARGET_MASK = {
  None: 0,
  Unit: 1 << 0,
  Item: 1 << 1,
  GameObject: 1 << 2,
  CorpseAlly: 1 << 3,
  CorpseEnemy: 1 << 4,
  Source: 1 << 5,
  Destination: 1 << 6,
} as const;

export interface ExplicitSpellTargetInput {
  /** Raw `Spell.dbc.Targets`, before Trinity adds active implicit effect requirements. */
  targets: number;
  /** Raw `Effect[3]`; zero marks an inactive slot. */
  effects: readonly number[];
  /** Raw `ImplicitTargetA[3]`. */
  implicitTargetA: readonly number[];
  /** Raw `ImplicitTargetB[3]`. */
  implicitTargetB: readonly number[];
  /** `SpellRange.RangeMax[0]`, the hostile maximum used by Trinity's zero-range suppression. */
  rangeMaxHostile: number;
  /** `SpellRange.RangeMax[1]`, the friendly maximum used by the same core check. */
  rangeMaxFriendly: number;
}

export interface ExplicitSpellTargetContract {
  explicitTargetContractVersion: number;
  explicitTargetMask: number;
  /** Target portions for which the native client must collect a new choice before writing. */
  clientSelectionMask: number;
  supportsExplicitTarget: boolean;
}

const SPELL_EFFECT_SLOTS = 3;
const LAST_KNOWN_TARGET = 110;
const LAST_KNOWN_EFFECT = 164;

const Unit = EXPLICIT_SPELL_TARGET_MASK.Unit;
const Item = EXPLICIT_SPELL_TARGET_MASK.Item;
const GameObject = EXPLICIT_SPELL_TARGET_MASK.GameObject;
const CorpseAlly = EXPLICIT_SPELL_TARGET_MASK.CorpseAlly;
const CorpseEnemy = EXPLICIT_SPELL_TARGET_MASK.CorpseEnemy;
const Source = EXPLICIT_SPELL_TARGET_MASK.Source;
const Destination = EXPLICIT_SPELL_TARGET_MASK.Destination;
const Corpse = CorpseAlly | CorpseEnemy;
const WorldObject = Unit | GameObject | Corpse;

// `SpellDefines.h`, represented as semantic categories rather than copied packet bits.
const RAW_UNIT = 0x00000002 | 0x00000004 | 0x00000008 | 0x00000080 | 0x00000100 | 0x00000400;
const RAW_ITEM = 0x00000010;
const RAW_SOURCE = 0x00000020;
const RAW_DESTINATION = 0x00000040;
const RAW_CORPSE_ENEMY = 0x00000200;
const RAW_GAME_OBJECT = 0x00000800;
const RAW_CORPSE_ALLY = 0x00008000;
const RAW_SUPPORTED = RAW_UNIT | RAW_ITEM | RAW_SOURCE | RAW_DESTINATION
  | RAW_CORPSE_ENEMY | RAW_GAME_OBJECT | RAW_CORPSE_ALLY;

// Target codes with TARGET_REFERENCE_TYPE_TARGET that can be represented by one ordinary Unit
// GUID.  90 (minipet) and 95 (vehicle passenger) are intentionally excluded below.
const DIRECT_UNIT_TARGETS = new Set<number>([
  6, 21, 25, 35, 45, 53, 57, 61, 63, 64, 65, 66, 67, 68, 69, 70, 71, 74, 75,
]);
const DIRECT_GAME_OBJECT_TARGETS = new Set<number>([23]);
const SOURCE_REFERENCE_TARGETS = new Set<number>([7, 11, 15, 30, 33, 51, 93]);
const DESTINATION_REFERENCE_TARGETS = new Set<number>([
  8, 16, 28, 29, 31, 34, 52, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 91, 107,
]);
const SPECIAL_UNSUPPORTED_TARGETS = new Set<number>([
  26, // TARGET_GAMEOBJECT_ITEM_TARGET: a special combined item/GameObject selector.
  90, // TARGET_UNIT_TARGET_MINIPET.
  95, // TARGET_UNIT_TARGET_PASSENGER.
]);

// Object types for every target code in the active TrinityCore table. They are used only to
// reproduce `SpellEffectInfo::GetProvidedTargetMask`, so an implicit caster/area target can
// correctly suppress a missing target without becoming a client cursor.
const UNIT_OBJECT_TARGETS = new Set<number>([
  1, 2, 3, 4, 5, 6, 7, 8, 11, 15, 16, 20, 21, 24, 25, 27, 30, 31, 33, 34, 35, 37,
  38, 45, 54, 56, 57, 58, 59, 60, 61, 77, 90, 92, 94, 95, 96, 97, 98, 99, 100, 101,
  102, 103, 104, 105,
]);
const DESTINATION_OBJECT_TARGETS = new Set<number>([
  9, 17, 18, 28, 29, 32, 36, 39, 41, 42, 43, 44, 46, 47, 48, 49, 50, 53, 55, 63,
  64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 78, 79, 80, 81, 82, 83, 84,
  85, 86, 87, 88, 89, 91, 106, 110,
]);
const GAME_OBJECT_TARGETS = new Set<number>([23, 40, 51, 52, 108]);
const CORPSE_OBJECT_TARGETS = new Set<number>([93]);
const SOURCE_OBJECT_TARGETS = new Set<number>([22]);

// `SpellEffectInfo::_data` entries whose implicit target type is EXPLICIT. Every other effect
// id in the current 0..164 table is EFFECT_IMPLICIT_TARGET_NONE and adds no missing target mask.
const UNIT_EFFECTS = new Set<number>([
  1, 2, 6, 7, 8, 9, 10, 11, 16, 17, 19, 24, 31, 35, 36, 38, 40, 41, 44, 45, 55, 57,
  58, 59, 62, 63, 65, 66, 67, 68, 70, 71, 73, 75, 80, 82, 90, 91, 92, 95, 96, 98,
  100, 102, 103, 108, 111, 112, 114, 115, 117, 119, 120, 121, 123, 124, 125, 126,
  128, 129, 130, 132, 133, 136, 137, 138, 139, 140, 141, 142, 143, 146, 147, 150,
  153, 154, 157, 159, 160, 161, 162, 163, 164,
]);
const UNIT_AND_DESTINATION_EFFECTS = new Set<number>([5, 29, 43, 69, 83, 144, 145]);
const DESTINATION_EFFECTS = new Set<number>([27, 28, 50, 56, 72, 76, 81, 104, 105, 106, 107, 109, 135, 149]);
const ITEM_EFFECTS = new Set<number>([53, 54, 99, 101, 127, 156, 158]);
const GAME_OBJECT_EFFECTS = new Set<number>([86, 87, 88, 89]);
const CORPSE_ALLY_EFFECTS = new Set<number>([18, 113]);
const CORPSE_ENEMY_EFFECTS = new Set<number>([116]);
const GAME_OBJECT_ITEM_EFFECTS = new Set<number>([33]);

type EffectKind = "none" | "unit" | "unitDestination" | "item" | "gameObject"
  | "corpseAlly" | "corpseEnemy" | "destination" | "unsupported";
type TargetObjectKind = "none" | "unit" | "item" | "gameObject" | "gameObjectItem"
  | "corpse" | "source" | "destination";

interface TargetState {
  mask: number;
  srcSet: boolean;
  dstSet: boolean;
}

function unavailable(): ExplicitSpellTargetContract {
  return {
    explicitTargetContractVersion: EXPLICIT_SPELL_TARGET_CONTRACT_VERSION,
    explicitTargetMask: EXPLICIT_SPELL_TARGET_MASK.None,
    clientSelectionMask: EXPLICIT_SPELL_TARGET_MASK.None,
    supportsExplicitTarget: false,
  };
}

function available(mask: number, clientSelectionMask: number): ExplicitSpellTargetContract {
  return {
    explicitTargetContractVersion: EXPLICIT_SPELL_TARGET_CONTRACT_VERSION,
    explicitTargetMask: mask,
    clientSelectionMask,
    supportsExplicitTarget: mask !== EXPLICIT_SPELL_TARGET_MASK.None,
  };
}

function isUnsignedInt(value: unknown, maximum = 0xffffffff): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isRange(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function targetObjectKind(target: number): TargetObjectKind | undefined {
  if (!isUnsignedInt(target, LAST_KNOWN_TARGET)) return undefined;
  if (target === 0 || target === 10 || target === 12 || target === 13 || target === 14 || target === 19
    || target === 62 || target === 107 || target === 109) return "none";
  if (UNIT_OBJECT_TARGETS.has(target)) return "unit";
  if (DESTINATION_OBJECT_TARGETS.has(target)) return "destination";
  if (GAME_OBJECT_TARGETS.has(target)) return "gameObject";
  if (CORPSE_OBJECT_TARGETS.has(target)) return "corpse";
  if (SOURCE_OBJECT_TARGETS.has(target)) return "source";
  if (target === 26) return "gameObjectItem";
  // The exhaustive current table has no Item implicit-target object. An unrecognised entry is not
  // silently considered None when Trinity adds a later target code.
  return undefined;
}

function objectMask(kind: TargetObjectKind): number {
  switch (kind) {
    case "unit": return Unit;
    case "item": return Item;
    case "gameObject": return GameObject;
    case "gameObjectItem": return GameObject | Item;
    case "corpse": return Corpse;
    case "source": return Source;
    case "destination": return Destination;
    default: return 0;
  }
}

function effectKind(effect: number): EffectKind {
  if (!isUnsignedInt(effect, LAST_KNOWN_EFFECT)) return "unsupported";
  if (effect === 0) return "none";
  if (UNIT_EFFECTS.has(effect)) return "unit";
  if (UNIT_AND_DESTINATION_EFFECTS.has(effect)) return "unitDestination";
  if (DESTINATION_EFFECTS.has(effect)) return "destination";
  if (ITEM_EFFECTS.has(effect)) return "item";
  if (GAME_OBJECT_EFFECTS.has(effect)) return "gameObject";
  if (CORPSE_ALLY_EFFECTS.has(effect)) return "corpseAlly";
  if (CORPSE_ENEMY_EFFECTS.has(effect)) return "corpseEnemy";
  if (GAME_OBJECT_ITEM_EFFECTS.has(effect)) return "unsupported";
  return "none";
}

function applyRawTargetFlags(targets: number, state: TargetState): boolean {
  const raw = targets >>> 0;
  if (((raw & ~RAW_SUPPORTED) >>> 0) !== 0) return false;
  if ((raw & RAW_UNIT) !== 0) state.mask |= Unit;
  if ((raw & RAW_ITEM) !== 0) state.mask |= Item;
  if ((raw & RAW_SOURCE) !== 0) state.mask |= Source;
  if ((raw & RAW_DESTINATION) !== 0) state.mask |= Destination;
  if ((raw & RAW_GAME_OBJECT) !== 0) state.mask |= GameObject;
  if ((raw & RAW_CORPSE_ALLY) !== 0) state.mask |= CorpseAlly;
  if ((raw & RAW_CORPSE_ENEMY) !== 0) state.mask |= CorpseEnemy;
  return true;
}

/** Applies `SpellImplicitTargetInfo::GetExplicitTargetMask` and returns its provided object mask. */
function applyImplicitTarget(target: number, state: TargetState): number | undefined {
  const kind = targetObjectKind(target);
  if (kind === undefined || SPECIAL_UNSUPPORTED_TARGETS.has(target)) return undefined;

  if (target === 89) { // TARGET_DEST_TRAJ is the one core target that requests both coordinates.
    if (!state.srcSet) state.mask |= Source;
    if (!state.dstSet) state.mask |= Destination;
  } else if (SOURCE_REFERENCE_TARGETS.has(target)) {
    if (!state.srcSet) state.mask |= Source;
  } else if (DESTINATION_REFERENCE_TARGETS.has(target)) {
    if (!state.dstSet) state.mask |= Destination;
  } else if (DIRECT_UNIT_TARGETS.has(target)) {
    state.mask |= Unit;
  } else if (DIRECT_GAME_OBJECT_TARGETS.has(target)) {
    state.mask |= GameObject;
  }

  // This is the state mutation at the end of GetExplicitTargetMask. It must happen after the
  // reference calculation above: TARGET_DEST_TRAJ itself first asks for the coordinates.
  if (kind === "source") state.srcSet = true;
  if (kind === "destination") state.dstSet = true;
  return objectMask(kind);
}

/** Mirrors `SpellEffectInfo::GetMissingTargetMask` for the target classes the client can encode. */
function missingTargetMask(effect: number, provided: number, srcSet: boolean, dstSet: boolean): number | undefined {
  const kind = effectKind(effect);
  if (kind === "unsupported") return undefined;
  if (kind === "none") return 0;

  let missing = kind === "unit" ? Unit
    : kind === "unitDestination" ? Unit | Destination
      : kind === "item" ? Item
        : kind === "gameObject" ? GameObject
          : kind === "corpseAlly" ? CorpseAlly
            : kind === "corpseEnemy" ? CorpseEnemy
              : Destination;

  if ((provided & Unit) !== 0) missing &= ~Unit;
  if ((provided & Corpse) !== 0) missing &= ~(Unit | Corpse);
  // A GameObject+Item selector is intentionally unavailable, but retain these exact removal
  // rules so an unsupported shape cannot accidentally become available after a future table edit.
  if ((provided & (GameObject | Item)) === (GameObject | Item)) missing &= ~(GameObject | Item);
  else if ((provided & GameObject) !== 0) missing &= ~GameObject;
  else if ((provided & Item) !== 0) missing &= ~Item;
  if (dstSet || (provided & Destination) !== 0) missing &= ~Destination;
  if (srcSet || (provided & Source) !== 0) missing &= ~Source;
  return missing;
}

function hasSingleRepresentableWorldObject(mask: number): boolean {
  const hasUnit = (mask & Unit) !== 0;
  const hasGameObject = (mask & GameObject) !== 0;
  const hasAllyCorpse = (mask & CorpseAlly) !== 0;
  const hasEnemyCorpse = (mask & CorpseEnemy) !== 0;
  const count = Number(hasUnit) + Number(hasGameObject) + Number(hasAllyCorpse) + Number(hasEnemyCorpse);
  return count <= 1;
}

/**
 * Returns only choices that cannot be supplied by `Spell::InitExplicitTargets`.
 *
 * An omitted Unit keeps the core's selected-unit/self fallback.  An omitted Source always becomes
 * the caster.  A Destination asks for a ground pick only when the DBC seed itself has the direct
 * destination flag; a destination inferred from an effect/reference is filled from the object
 * target or caster by the core.  Item/GameObject/corpse masks have no such default and remain
 * mandatory regardless of whether they came from the DBC seed or an explicit effect.
 */
function clientSelectionMask(rawTargets: number, mask: number): number {
  let selection = mask & (Item | GameObject | Corpse);
  if ((rawTargets & RAW_DESTINATION) !== 0) selection |= Destination;
  return selection;
}

/**
 * Returns a v2 contract only for a shape that maps to the native generic target cursor.
 *
 * A caller must treat `supportsExplicitTarget === false`, an absent field, a new contract version,
 * or a mask with an unknown bit as unavailable. The server remains responsible for relation,
 * range, movement, object state and all cast validation.
 */
export function explicitSpellTargetContract(input: ExplicitSpellTargetInput): ExplicitSpellTargetContract {
  if (!input || !isUnsignedInt(input.targets) || !Array.isArray(input.effects)
    || !Array.isArray(input.implicitTargetA) || !Array.isArray(input.implicitTargetB)
    || input.effects.length !== SPELL_EFFECT_SLOTS || input.implicitTargetA.length !== SPELL_EFFECT_SLOTS
    || input.implicitTargetB.length !== SPELL_EFFECT_SLOTS || !isRange(input.rangeMaxHostile)
    || !isRange(input.rangeMaxFriendly)) return unavailable();

  const state: TargetState = { mask: 0, srcSet: false, dstSet: false };
  if (!applyRawTargetFlags(input.targets, state)) return unavailable();
  const noMaximumRange = input.rangeMaxHostile === 0 && input.rangeMaxFriendly === 0;

  for (let slot = 0; slot < SPELL_EFFECT_SLOTS; slot++) {
    const effect = input.effects[slot];
    const implicitTargetA = input.implicitTargetA[slot];
    const implicitTargetB = input.implicitTargetB[slot];
    if (!isUnsignedInt(effect, LAST_KNOWN_EFFECT)) return unavailable();
    if (effect === 0) continue; // Trinity skips inactive effect rows, including their stale A/B values.
    if (!isUnsignedInt(implicitTargetA, LAST_KNOWN_TARGET)
      || !isUnsignedInt(implicitTargetB, LAST_KNOWN_TARGET)) return unavailable();

    const targetA = applyImplicitTarget(implicitTargetA, state);
    const targetB = applyImplicitTarget(implicitTargetB, state);
    if (targetA === undefined || targetB === undefined) return unavailable();

    let missing = missingTargetMask(effect, state.mask | targetA | targetB, state.srcSet, state.dstSet);
    if (missing === undefined) return unavailable();
    // The core removes only missing Unit/GameObject/Corpse/Destination requirements on a zero-range
    // spell. Existing raw or implicit selection flags survive exactly as they do in Trinity.
    if (noMaximumRange) missing &= ~(Unit | GameObject | Corpse | Destination);
    state.mask |= missing;
  }

  // GameObjectItem, trade slots, strings, glyphs, minipets/passengers, and two different world
  // object kinds have no canonical native cursor or one-GUID packet representation here.
  if (!hasSingleRepresentableWorldObject(state.mask)) return unavailable();
  return available(state.mask, clientSelectionMask(input.targets >>> 0, state.mask));
}
