/**
 * Plan item 3.02: UNIT_SPELLCAST_SENT, _SUCCEEDED, _FAILED_QUIET, _INTERRUPTIBLE and
 * _NOT_INTERRUPTIBLE, and UnitCastingInfo/UnitChannelInfo's notInterruptible.
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra, .runtime/re-2026-10-02/a2-m8/):
 * - SENT (event 0x143): 0x0080ac90 raises it right after building CMSG_CAST_SPELL / CMSG_USE_ITEM /
 *   the pet cast — always for "player", with the spell's name and rank and the name of the request's
 *   target (0x0074d750: a known name, else the UNKNOWNOBJECT string; "" without a target).
 * - The outcome (0x007fecc0, given a SpellCastResult): 187 — the client's own «success», from an
 *   SMSG_SPELL_GO without CAST_FLAG_PENDING (0x0080e1b0) — raises SUCCEEDED (0x14a); 24, 27 and 105
 *   (CHARMED, DONT_REPORT, SPELL_IN_PROGRESS) raise FAILED_QUIET (0x147); 40 and 41 (INTERRUPTED,
 *   _COMBAT) raise INTERRUPTED (0x148); anything else FAILED (0x146). Each goes to every unit token
 *   the caster answers to (0x0060bf60: "%s%s%s%d" — unit, name, rank, cast count), and only then
 *   STOP (0x145) when the spell is still the unit's current cast. It is called from SMSG_SPELL_GO,
 *   SMSG_CAST_FAILED (0x00809af0, through 0x00808200), SMSG_SPELL_FAILURE (0x00809c70) and
 *   SMSG_SPELL_FAILED_OTHER (0x00806ad0) — the core sends the last two together for every interrupt, so
 *   INTERRUPTED comes twice. (3.01-go-order, 03.10: handlers corrected from the registration 0x008100e0;
 *   0x00805610 is the pet's refusal, SMSG_PET_CAST_FAILED 0x138 → 0x00806c30.)
 * - notInterruptible (0x0071ab20 over the unit's flag set by 0x007262e0) is relative to the player:
 *   the player's book gives four school masks (0x0053ca70) — interrupts (effect 68), silences (effect
 *   6 with aura 27), and the school masks of spells with SPELL_ATTR7 0x800 / 0x1000, which count only
 *   against a non-player caster. With all four empty nothing is ever «not interruptible». Otherwise a
 *   cast whose AttributesExG has 0x2000 is interruptible; one whose PreventionType is not 1 is not; and
 *   a PreventionType 1 cast is not when the caster's immunities cover every mask left: the
 *   SMSG_SPELL_START CAST_FLAG_IMMUNITY words (school mask; mechanic bit 26 interrupt, bit 9 silence)
 *   and its auras 37 (misc 68), 38 (misc 27), 39 (school mask) and 77 (misc 26, 9).
 * - INTERRUPTIBLE (0x14e) / NOT_INTERRUPTIBLE (0x14f): the aura update (0x0072f5d0) recomputes it for a
 *   unit casting or channelling a PreventionType 1 spell and raises 0x14e + new value when the old
 *   value differs from 0x007262e0's answer. That answer is 1 for a player without interrupts while the
 *   shown value is 0, so such a player gets INTERRUPTIBLE on every aura update of a casting unit, as in
 *   the original (harmless: CastingBarFrame only hides the shield).
 */

import type { SpellMetadata } from "../SpellMetadata.js";
import type { ActiveAura } from "../../world/AuraProtocol.js";

/** Wow.exe 0x007fecc0's «success» (SPELL_FAILED_UNKNOWN, 187). */
export const FRAMEXML_CAST_RESULT_SUCCESS = 187;

export type FrameXmlCastOutcome = "succeeded" | "failedQuiet" | "interrupted" | "failed";

/** Which event 0x007fecc0 raises for a SpellCastResult. */
export function frameXmlCastOutcome(result: number): FrameXmlCastOutcome {
  if (result === FRAMEXML_CAST_RESULT_SUCCESS) return "succeeded";
  if (result === 24 || result === 27 || result === 105) return "failedQuiet";
  if (result === 40 || result === 41) return "interrupted";
  return "failed";
}

/** The four school masks 0x0053ca70 builds over the player's book. */
export interface FrameXmlInterruptMasks {
  readonly interrupt: number;
  readonly interruptNonPlayer: number;
  readonly silence: number;
  readonly silenceNonPlayer: number;
}

export const FRAMEXML_NO_INTERRUPT_MASKS: FrameXmlInterruptMasks =
  Object.freeze({ interrupt: 0, interruptNonPlayer: 0, silence: 0, silenceNonPlayer: 0 });

const SPELL_EFFECT_APPLY_AURA = 6;
const SPELL_EFFECT_INTERRUPT_CAST = 68;
const SPELL_AURA_MOD_SILENCE = 27;
const SPELL_ATTR7_INTERRUPT_ONLY_NONPLAYER = 0x800;
const SPELL_ATTR7_SILENCE_ONLY_NONPLAYER = 0x1000;
const SPELL_ATTR7_ALWAYS_INTERRUPTIBLE = 0x2000;
const MECHANIC_INTERRUPT_BIT = 1 << 26;
const MECHANIC_SILENCE_BIT = 1 << 9;
const SPELL_AURA_EFFECT_IMMUNITY = 37;
const SPELL_AURA_STATE_IMMUNITY = 38;
const SPELL_AURA_SCHOOL_IMMUNITY = 39;
const SPELL_AURA_MECHANIC_IMMUNITY = 77;
const MECHANIC_SILENCE = 9;
const MECHANIC_INTERRUPT = 26;

type MaskSpell = Pick<SpellMetadata, "schoolMask" | "effectAura"> & Partial<Pick<SpellMetadata, "effects" | "attributes">>;

/** 0x0053ca70: the masks over the player's resolved book spells. */
export function frameXmlInterruptMasks(book: Iterable<MaskSpell | undefined>): FrameXmlInterruptMasks {
  let interrupt = 0;
  let interruptNonPlayer = 0;
  let silence = 0;
  let silenceNonPlayer = 0;
  for (const spell of book) {
    if (!spell) continue;
    const school = spell.schoolMask >>> 0;
    const effects = spell.effects ?? [];
    for (let index = 0; index < 3; index++) {
      const effect = effects[index] ?? 0;
      if (effect === SPELL_EFFECT_INTERRUPT_CAST) interrupt |= school;
      else if (effect === SPELL_EFFECT_APPLY_AURA && spell.effectAura[index] === SPELL_AURA_MOD_SILENCE) silence |= school;
    }
    const attr7 = spell.attributes?.[7] ?? 0;
    if ((attr7 & SPELL_ATTR7_INTERRUPT_ONLY_NONPLAYER) !== 0) interruptNonPlayer |= school;
    if ((attr7 & SPELL_ATTR7_SILENCE_ONLY_NONPLAYER) !== 0) silenceNonPlayer |= school;
  }
  return { interrupt, interruptNonPlayer, silence, silenceNonPlayer };
}

/** The caster's aura immunities 0x007262e0 reads: the effect aura and its misc value. */
export interface FrameXmlImmunityAura {
  readonly effectAura: readonly number[];
  readonly effectMiscValue: readonly number[];
}

export interface FrameXmlInterruptibilityInput {
  readonly spell: Pick<SpellMetadata, "preventionType" | "attributes"> | undefined;
  readonly casterIsPlayer: boolean;
  readonly schoolImmunityMask: number;
  readonly mechanicImmunityMask: number;
  readonly auras: Iterable<FrameXmlImmunityAura | undefined>;
  readonly masks: FrameXmlInterruptMasks;
}

/**
 * 0x007262e0 then 0x0071ab20: `raw` is what the recompute returns, `flag` the unit's +0xa34 bit 8, and
 * `shown` the value UnitCastingInfo hands out (the flag while the player has any interrupt at all).
 */
export function frameXmlInterruptibility(input: FrameXmlInterruptibilityInput): { raw: boolean; flag: boolean; shown: boolean } {
  const masks = input.masks;
  const nonPlayer = !input.casterIsPlayer;
  const any = masks.interrupt !== 0 || masks.silence !== 0
    || (nonPlayer && (masks.interruptNonPlayer !== 0 || masks.silenceNonPlayer !== 0));
  const spell = input.spell;
  if (!spell || spell.preventionType === undefined) return { raw: false, flag: false, shown: false };
  if (((spell.attributes?.[7] ?? 0) & SPELL_ATTR7_ALWAYS_INTERRUPTIBLE) !== 0) return { raw: false, flag: false, shown: false };
  if (spell.preventionType === 1) {
    if (!any) return { raw: true, flag: false, shown: false };
    let interrupt = masks.interrupt;
    let interruptNp = nonPlayer ? masks.interruptNonPlayer : 0;
    let silence = masks.silence;
    let silenceNp = nonPlayer ? masks.silenceNonPlayer : 0;
    const school = input.schoolImmunityMask >>> 0;
    if ((input.mechanicImmunityMask & MECHANIC_INTERRUPT_BIT) !== 0) { interrupt = 0; interruptNp = 0; }
    else if (school !== 0) { interrupt &= ~school; interruptNp &= ~school; }
    if ((input.mechanicImmunityMask & MECHANIC_SILENCE_BIT) !== 0) { silence = 0; silenceNp = 0; }
    else if (school !== 0) { silence &= ~school; silenceNp &= ~school; }
    if ((interrupt | interruptNp | silence | silenceNp) !== 0) {
      for (const aura of input.auras) {
        if (!aura) continue;
        for (let index = 0; index < 3; index++) {
          const type = aura.effectAura[index] ?? 0;
          const misc = aura.effectMiscValue[index] ?? 0;
          if (type === SPELL_AURA_EFFECT_IMMUNITY && misc === SPELL_EFFECT_INTERRUPT_CAST) { interrupt = 0; interruptNp = 0; }
          else if (type === SPELL_AURA_STATE_IMMUNITY && misc === SPELL_AURA_MOD_SILENCE) { silence = 0; silenceNp = 0; }
          else if (type === SPELL_AURA_SCHOOL_IMMUNITY) {
            interrupt &= ~misc; interruptNp &= ~misc; silence &= ~misc; silenceNp &= ~misc;
          } else if (type === SPELL_AURA_MECHANIC_IMMUNITY) {
            if (misc === MECHANIC_SILENCE) { silence = 0; silenceNp = 0; }
            else if (misc === MECHANIC_INTERRUPT) { interrupt = 0; interruptNp = 0; }
          }
        }
      }
      if ((interrupt | interruptNp | silence | silenceNp) !== 0) return { raw: false, flag: false, shown: false };
    }
  }
  return { raw: true, flag: true, shown: any };
}

/** What the live cast events read from the seam. */
export interface FrameXmlCastEventsDeps {
  readonly spell: (id: number) => SpellMetadata | undefined;
  /** The unit token a caster answers to, or nothing (LiveWorldSeam's cast unit). */
  readonly castUnit: (guid: bigint) => string | undefined;
  /** The player's book (resolved metadata), for the interrupt masks. */
  readonly book: () => Iterable<SpellMetadata | undefined>;
  /** The caster's auras (WorldClient.auras). */
  readonly auras: (guid: bigint) => ReadonlyMap<number, ActiveAura> | undefined;
  /** The cast or channel in progress (WorldClient.casts). */
  readonly cast: (guid: bigint) => { spellId: number; channel: boolean; schoolImmunityMask?: number; mechanicImmunityMask?: number } | undefined;
  /** A unit's or object's name for SENT's target (0x0074d750); undefined when unknown. */
  readonly guidName: (guid: bigint) => string | undefined;
  /** The current selection, for a unit spell sent without a named unit. */
  readonly selection: () => bigint | undefined;
}

export interface FrameXmlCastPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/**
 * The live half: the flag per casting unit, the masks cache, and the three event handlers the seam
 * calls from its WorldClient subscriptions.
 */
export class FrameXmlCastEventsLive {
  readonly #deps: FrameXmlCastEventsDeps;
  #globalString: (name: string) => string | undefined = () => undefined;
  /** +0xa34 bit 8, per casting guid. */
  readonly #flags = new Map<bigint, boolean>();
  #masks: FrameXmlInterruptMasks = FRAMEXML_NO_INTERRUPT_MASKS;
  #masksStale = true;

  constructor(deps: FrameXmlCastEventsDeps) {
    this.#deps = deps;
  }

  /** The UNKNOWNOBJECT text for an unnamed target. */
  useGlobalStrings(resolver: (name: string) => string | undefined): void {
    this.#globalString = resolver;
  }

  /** The book changed (a spell learned or removed, metadata arrived): rebuild the masks on next use. */
  invalidateBook(): void {
    this.#masksStale = true;
  }

  #currentMasks(): FrameXmlInterruptMasks {
    if (this.#masksStale) {
      this.#masks = frameXmlInterruptMasks(this.#deps.book());
      this.#masksStale = false;
    }
    return this.#masks;
  }

  #compute(guid: bigint): { raw: boolean; flag: boolean; shown: boolean } | undefined {
    const cast = this.#deps.cast(guid);
    if (!cast) return undefined;
    const auras = this.#deps.auras(guid);
    const spell = this.#deps.spell(cast.spellId);
    const auraSpells: (FrameXmlImmunityAura | undefined)[] = [];
    if (auras) for (const aura of auras.values()) auraSpells.push(this.#deps.spell(aura.spellId));
    return frameXmlInterruptibility({
      spell,
      casterIsPlayer: (guid >> 48n) === 0n,
      schoolImmunityMask: cast.schoolImmunityMask ?? 0,
      mechanicImmunityMask: cast.mechanicImmunityMask ?? 0,
      auras: auraSpells,
      masks: this.#currentMasks(),
    });
  }

  /** SPELL_CAST_START: the flag as the cast begins (no event — the bar reads UnitCastingInfo). */
  onCastStart(guid: bigint): void {
    // The book and its metadata move without an edge of their own here; a cast start is rare enough
    // (one walk over a few hundred book rows) to rebuild the masks each time.
    this.#masksStale = true;
    const result = this.#compute(guid);
    if (result) this.#flags.set(guid, result.flag);
    else this.#flags.delete(guid);
  }

  /** SPELL_CAST_STOP: the unit no longer casts. */
  onCastStop(guid: bigint): void {
    if (!this.#deps.cast(guid)) this.#flags.delete(guid);
  }

  /** UnitCastingInfo/UnitChannelInfo's last value. */
  notInterruptible(guid: bigint): boolean {
    const flag = this.#flags.get(guid);
    if (flag === undefined) return false;
    const masks = this.#currentMasks();
    const any = masks.interrupt !== 0 || masks.silence !== 0
      || ((guid >> 48n) !== 0n && (masks.interruptNonPlayer !== 0 || masks.silenceNonPlayer !== 0));
    return flag && any;
  }

  /** SPELL_CAST_SENT → UNIT_SPELLCAST_SENT("player", name, rank, target). */
  onSent(pump: FrameXmlCastPump, event: { spellId: number; castCount: number; targetGuid?: bigint }): void {
    const spell = this.#deps.spell(event.spellId);
    let target = event.targetGuid;
    // A unit spell sent without a named unit goes to the selection (the server's fallback, and the
    // original client fills the request's target from it before 0x0080ac90 builds the packet).
    if (target === undefined && spell !== undefined && ((spell.requiredTargetMask ?? 0) & 1) !== 0) {
      target = this.#deps.selection();
    }
    let targetName = "";
    if (target !== undefined && target !== 0n) {
      targetName = this.#deps.guidName(target) ?? this.#globalString("UNKNOWNOBJECT") ?? "Unknown";
    }
    pump.fire("UNIT_SPELLCAST_SENT", "player", spell?.name ?? `Заклинание ${event.spellId}`, spell?.rank ?? "", targetName);
  }

  /** SPELL_CAST_RESULT → SUCCEEDED / FAILED_QUIET / INTERRUPTED / FAILED for the caster's token. */
  onResult(pump: FrameXmlCastPump, event: { casterGuid: bigint; spellId: number; castCount: number; result: number }): void {
    const unit = this.#deps.castUnit(event.casterGuid);
    if (unit === undefined) return;
    const spell = this.#deps.spell(event.spellId);
    const outcome = frameXmlCastOutcome(event.result);
    const name = outcome === "succeeded" ? "UNIT_SPELLCAST_SUCCEEDED"
      : outcome === "failedQuiet" ? "UNIT_SPELLCAST_FAILED_QUIET"
        : outcome === "interrupted" ? "UNIT_SPELLCAST_INTERRUPTED"
          : "UNIT_SPELLCAST_FAILED";
    pump.fire(name, unit, spell?.name ?? `Заклинание ${event.spellId}`, spell?.rank ?? "", event.castCount);
  }

  /** AURA_CHANGED for a unit that casts a PreventionType 1 spell: 0x0072f5d0's recompute. */
  onAuraChanged(pump: FrameXmlCastPump, guid: bigint): void {
    const cast = this.#deps.cast(guid);
    if (!cast) return;
    const spell = this.#deps.spell(cast.spellId);
    if (spell?.preventionType !== 1) return;
    const shownBefore = this.notInterruptible(guid);
    const result = this.#compute(guid);
    if (!result) return;
    this.#flags.set(guid, result.flag);
    if (shownBefore === result.raw) return;
    const unit = this.#deps.castUnit(guid);
    if (unit === undefined) return;
    pump.fire(result.shown ? "UNIT_SPELLCAST_NOT_INTERRUPTIBLE" : "UNIT_SPELLCAST_INTERRUPTIBLE", unit);
  }

  reset(): void {
    this.#flags.clear();
    this.#masksStale = true;
  }
}
