import { POWER_DISPLAY_SCALE } from "../../world/Fields.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { spellCostUnit, type SpellDescriptionContext } from "../ui/SpellText.js";
import { spellPowerCostFor, spellPowerPerSecondFor } from "../ui/SpellTextCost.js";
import type { FrameXmlSpellInfo } from "./FrameXmlWorldSeam.js";

/**
 * 3.43 (15.11): `GetSpellInfo`'s values as Wow.exe 3.3.5a 12340 returns them (Script_GetSpellInfo 0x00540a30, Ghidra
 * 2026-11-15, .runtime/re-2026-11-15/spelltext5/r3.c; the stock MultiCastActionBarFrame.lua:957 reads the same nine):
 * `name, rank, icon, cost, isFunnel, powerType, castTime[, minRange, maxRange]`.
 *
 * * cost: the cost function 0x008012f0 for the active player (SpellTextCost.ts) over the power's scale (0x007fde00),
 *   unsigned — or, when its per-second part 0x007ff100 over the scale is 1 or more, that part, with isFunnel true.
 *   Without a player the function answers 0xffffffff, which the division leaves as -1 for mana.
 * * castTime: 0 for a passive spell (SPELL_ATTR0 0x40), else 0x007ff180's time — here the row's cast time, without
 *   that function's SPELLMOD_CASTING_TIME and haste, which this does not model.
 * * minRange, maxRange: only with a player (else seven values); here the row's hostile range, without 0x00801650's
 *   SPELLMOD_RANGE.
 *
 * A cost this client cannot tell yet (a template, a row on its way) falls back to the row's ManaCost over the scale.
 */
/**
 * 3.43 (15.11): Spell_C_HaveSpellPower's cost (0x008017e0 calls 0x008012f0 for every power but runes) for the active
 * player of `context`, in the raw units of the power fields; undefined without a player or while a fact is missing.
 */
export function frameXmlPlayerSpellCost(spell: SpellMetadata, context: SpellDescriptionContext): number | undefined {
  const unit = spellCostUnit(context);
  return unit ? spellPowerCostFor(spell, unit) : undefined;
}

export function frameXmlSpellInfo(metadata: SpellMetadata, context: SpellDescriptionContext): FrameXmlSpellInfo {
  const scale = POWER_DISPLAY_SCALE[metadata.powerType] ?? 1;
  const unit = spellCostUnit(context);
  const cost = unit ? spellPowerCostFor(metadata, unit) ?? metadata.powerCost : 0xffffffff;
  const perSecond = unit ? spellPowerPerSecondFor(metadata, unit) ?? 0 : 0;
  const shownCost = Math.trunc((cost >>> 0) / scale) | 0;
  const shownPerSecond = Math.trunc((perSecond >>> 0) / scale) | 0;
  const funnel = shownPerSecond >= 1;
  const castTime = (metadata.attributes?.[0] ?? (metadata.passive ? 0x40 : 0)) & 0x40 ? 0 : metadata.castTime;
  const head = [metadata.name, metadata.rank, metadata.iconPath, funnel ? shownPerSecond : shownCost, funnel,
    metadata.powerType, castTime] as const;
  return unit ? [...head, metadata.rangeMin, metadata.rangeMax] : head;
}
