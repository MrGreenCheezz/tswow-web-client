/**
 * A deliberately narrow supplement to the legacy Spell.dbc `Targets` selection contract.
 *
 * TrinityCore derives its explicit mask from every active effect's implicit targets, but a
 * `Targets == 0` DBC row can still require a client-supplied Unit GUID.  This helper exposes
 * only the ordinary direct-unit subset; callers must leave every other shape unavailable.
 */
export const EXPLICIT_UNIT_TARGET_CONTRACT_VERSION = 1;

export interface ExplicitUnitTargetInput {
  /** Raw Spell.dbc `Targets`. This fallback is for the zero-seed case only. */
  targets: number;
  /** Raw Spell.dbc `Effect[3]`; an effect value of zero is inactive. */
  effects: readonly number[];
  /** Raw Spell.dbc `ImplicitTargetA[3]`. */
  implicitTargetA: readonly number[];
  /** Raw Spell.dbc `ImplicitTargetB[3]`. */
  implicitTargetB: readonly number[];
}

export interface ExplicitUnitTargetContract {
  unitTargetContractVersion: number;
  supportsExplicitUnitTarget: boolean;
}

const SPELL_EFFECT_SLOTS = 3;

// `SpellImplicitTargetInfo::_data` in the active TrinityCore has these ordinary, direct
// Unit/TARGET/DEFAULT entries. They describe target semantics, not particular spells.
//
// 6  TARGET_UNIT_TARGET_ENEMY       21 TARGET_UNIT_TARGET_ALLY
// 25 TARGET_UNIT_TARGET_ANY         35 TARGET_UNIT_TARGET_PARTY
// 45 TARGET_UNIT_TARGET_CHAINHEAL_ALLY
// 57 TARGET_UNIT_TARGET_RAID
const DIRECT_UNIT_TARGETS = new Set<number>([6, 21, 25, 35, 45, 57]);

function unsupported(): ExplicitUnitTargetContract {
  return {
    unitTargetContractVersion: EXPLICIT_UNIT_TARGET_CONTRACT_VERSION,
    supportsExplicitUnitTarget: false,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Returns true only when one or more active effects select the same client-provided Unit target
 * through the bounded TrinityCore allowlist. Any self, area, source/destination, item, unknown,
 * or mixed target source fails closed. Inactive effect slots are intentionally ignored, matching
 * `SpellInfo::_InitializeExplicitTargetMask`'s `if (!effect.IsEffect()) continue`.
 */
export function explicitUnitTargetContract(input: ExplicitUnitTargetInput): ExplicitUnitTargetContract {
  if (!isNonNegativeInteger(input.targets) || input.targets !== 0
    || !Array.isArray(input.effects) || !Array.isArray(input.implicitTargetA) || !Array.isArray(input.implicitTargetB)
    || input.effects.length !== SPELL_EFFECT_SLOTS
    || input.implicitTargetA.length !== SPELL_EFFECT_SLOTS
    || input.implicitTargetB.length !== SPELL_EFFECT_SLOTS) {
    return unsupported();
  }

  let hasDirectUnitTarget = false;
  for (let effect = 0; effect < SPELL_EFFECT_SLOTS; effect++) {
    const effectId = input.effects[effect];
    if (!isNonNegativeInteger(effectId)) return unsupported();
    if (effectId === 0) continue;

    const targets = [input.implicitTargetA[effect], input.implicitTargetB[effect]];
    for (const target of targets) {
      if (!isNonNegativeInteger(target)) return unsupported();
      if (target === 0) continue;
      if (!DIRECT_UNIT_TARGETS.has(target)) return unsupported();
      hasDirectUnitTarget = true;
    }
  }

  return {
    unitTargetContractVersion: EXPLICIT_UNIT_TARGET_CONTRACT_VERSION,
    supportsExplicitUnitTarget: hasDirectUnitTarget,
  };
}
