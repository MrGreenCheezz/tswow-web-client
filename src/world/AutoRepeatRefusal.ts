import { formatGlobalStringByName } from "./GlobalStringFormat.js";

/*
 * 05.10-5.05 / 05.10-3.02: what a spell refusal does to the auto-repeat and to the error frame — Wow.exe
 * 3.3.5a (12340) 0x00808200, the one handler of the player's refusals: the realm's (SMSG_CAST_FAILED,
 * 0x00809af0 passes its last argument 1) and the client's own (every other caller passes 0). Read-only notes:
 * .runtime/re-2026-10-02/a2-m8/d2.c (0x00808200), .runtime/re-2026-10-03/stock-small/g1.c (0x00809af0),
 * .runtime/re-2026-10-01/a9-combat/e2.c (0x00807560, 0x007fe140, 0x007fe190, 0x006e2be0),
 * .runtime/re-2026-10-05/l505-autoshot/ (this lane's probes).
 *
 * The repeat (0x00d397d0 — WorldClient.autoRepeatSpellId) and the wanted spell (0x00d397cc —
 * AutoRangedCombat.wantedSpellId, set only by the autoRangedCombat controller):
 * - A refusal of the repeating spell, other than SPELL_FAILED_DONT_REPORT (27), stops the repeat: 0x00807560(1)
 *   — CMSG_CANCEL_AUTO_REPEAT_SPELL and the repeat forgotten (no CMSG_SET_SHEATHED).
 * - Except the realm's refusal of the wanted spell: that stops it only for BAD_IMPLICIT_TARGETS (11),
 *   BAD_TARGETS (12), CASTER_DEAD (23), EQUIPPED_ITEM (28), EQUIPPED_ITEM_CLASS[_MAINHAND/_OFFHAND] (29-31),
 *   NEED_AMMO (52), OUT_OF_RANGE (97), TOO_CLOSE (128) and UNIT_NOT_INFRONT (134); any other leaves it.
 * Deliberate differences, both in {@link autoRepeatRefusalAction}:
 * - The wanted spell keeps its repeat for 28-31, 52, 97 and 128. Wow.exe's controller re-casts the next frame
 *   and 0x0080cce0 refuses locally (no packet) while ammunition, the weapon or the range is still wrong; this
 *   client has none of those local checks, so stopping would re-send CMSG_CAST_SPELL every controller tick
 *   while the realm (Unit.cpp:3264-3270) refuses each one — the realm keeps that Auto Shot and its refusals
 *   stay quiet below, as before.
 * - SPELL_FAILED_SPELL_IN_PROGRESS (105) answering this client's own request for the repeat forgets it without
 *   a packet: Spell::prepare refuses before SetCurrentCastSpell (Spell.cpp:3232-3237), so the realm holds no
 *   repeat, and keeping one here was the «залипший» Auto Shot — the controller waits for a repeat that never
 *   runs. Wow.exe's own rule keeps it; its request is not sent while a cast runs ({@link autoRepeatWaitsForCast}).
 *
 * The error frame (0x005216f0) and SPELL_CAST_FAILED share one switch, `local_14` — the refusal is quiet when
 * (a) it is the wanted spell's and its result is the one remembered for it (0x00d397c8; every refusal of the
 * wanted spell writes it, and 0x007fe190 alone sets it back — AutoRangedCombat.failureResets counts those), or
 * (b) the same spell and result as the last refusal (0x00d397c4/0x00d397c0) within 3000 ms of it (0x00d397bc,
 * re-armed by each repeat) — the last refusal is forgotten by every SMSG_SPELL_GO without CAST_FLAG_PENDING
 * (0x0080e1b0). Both are written before the words are chosen. TOO_MANY_OF_ITEM (129) with a limit category
 * whose ItemLimitCategory row is known says ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS (game error 0x272,
 * quantity at +8, name at +4, through 0x005216f0 at 0x00808aa5) past the switch: never quiet.
 */

/** SpellCastResult values (SharedDefines.h:984-1180). */
const SPELL_FAILED_DONT_REPORT = 27;
const SPELL_FAILED_SPELL_IN_PROGRESS = 105;
const SPELL_FAILED_TOO_MANY_OF_ITEM = 129;
/** 0x00808200's list: the realm's refusals that stop the wanted spell's repeat. */
export const WANTED_REPEAT_STOP_RESULTS: ReadonlySet<number> = new Set([11, 12, 23, 28, 29, 30, 31, 52, 97, 128, 134]);
/** Of those, the ones this client leaves running for want of Wow.exe's local checks (see above). */
export const WANTED_REPEAT_KEPT_RESULTS: ReadonlySet<number> = new Set([28, 29, 30, 31, 52, 97, 128]);
/** 0x00808200: the same spell and result again within this many milliseconds is quiet. */
export const REFUSAL_REPEAT_MS = 3000;

export type AutoRepeatRefusalAction = "keep" | "stop" | "forget";

export interface AutoRepeatRefusal {
  readonly spellId: number;
  readonly result: number;
  /** The spell repeating now (0x00d397d0). */
  readonly repeating: number | undefined;
  /** The controller's wanted spell (0x00d397cc). */
  readonly wanted: number | undefined;
  /** The realm's refusal (SMSG_CAST_FAILED), not the client's own. */
  readonly fromServer: boolean;
  /** It answers a request this client still had pending (the cast count matched). */
  readonly answersRequest: boolean;
}

/**
 * 0x00808200's repeat half: "stop" — CMSG_CANCEL_AUTO_REPEAT_SPELL and forget (0x00807560(1)); "forget" — forget
 * without a packet (the realm holds none); "keep".
 */
export function autoRepeatRefusalAction(refusal: AutoRepeatRefusal): AutoRepeatRefusalAction {
  const { spellId, result } = refusal;
  if (refusal.repeating === undefined || spellId !== refusal.repeating || result === SPELL_FAILED_DONT_REPORT) return "keep";
  if (refusal.fromServer && spellId === refusal.wanted) {
    if (result === SPELL_FAILED_SPELL_IN_PROGRESS && refusal.answersRequest) return "forget";
    return WANTED_REPEAT_STOP_RESULTS.has(result) && !WANTED_REPEAT_KEPT_RESULTS.has(result) ? "stop" : "keep";
  }
  return "stop";
}

/**
 * Whether the autoRangedCombat controller holds its shot for the player's own cast: a cast bar runs (an SMSG_SPELL_START
 * with a cast time, not a channel). The realm refuses Auto Shot then with SPELL_IN_PROGRESS
 * (Spell.cpp:3232-3237, Unit::IsNonMeleeSpellCast(false, true, true, …) — channels skipped, Unit.cpp:3414-3442).
 * Its ATTR2_NOT_RESET_AUTO_ACTIONS exemption (Steady Shot) is not read: the shot then waits for the bar.
 * Not past the bar's end by more than {@link AUTO_REPEAT_CAST_GRACE_MS}: a bar whose GO never matched must not hold
 * the shot for good (a bound of this client's, not a rule of the original).
 */
export function autoRepeatWaitsForCast(cast: { readonly channel: boolean; readonly startedAt: number; readonly duration: number } | undefined,
  now: number): boolean {
  return cast !== undefined && !cast.channel && now - cast.startedAt < cast.duration + AUTO_REPEAT_CAST_GRACE_MS;
}

/** How long past a cast bar's end the shot still waits for its GO. */
export const AUTO_REPEAT_CAST_GRACE_MS = 1000;

/** The two fields of an ItemLimitCategory row the refusal names. */
export interface RefusalLimitCategory {
  readonly name: string;
  readonly quantity: number;
}

/** Case 0x81: the limit-category sentence, or undefined when the plain words speak. */
export function refusalLimitCategoryText(result: number, extra: readonly number[] | undefined,
  category: ((id: number) => RefusalLimitCategory | undefined) | undefined): string | undefined {
  if (result !== SPELL_FAILED_TOO_MANY_OF_ITEM || category === undefined) return undefined;
  const id = extra?.[0] ?? 0;
  if (id <= 0) return undefined;
  const row = category(id);
  if (row === undefined) return undefined;
  return formatGlobalStringByName("ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS", [row.quantity, row.name],
    "You can only have %d %s at a time");
}

/** 0x00808200's `local_14` and the state behind it, for the error frame. */
export class RefusalQuietRules {
  /** 0x00d397c8: the wanted spell's last result; undefined is 0x007fe190's 187, which no refusal carries. */
  #wantedResult: number | undefined;
  #seenResets: number | undefined;
  #lastSpell = 0;
  #lastResult = -1;
  #lastAt = 0;
  #hasLast = false;

  /**
   * One refusal: true when the error frame stays quiet. `resets` is AutoRangedCombat.failureResets — a change
   * since the last call is 0x007fe190 having run. Allocation-free: a realm can refuse every update.
   */
  quiet(spellId: number, result: number, now: number, wanted: number | undefined, resets: number | undefined): boolean {
    if (resets !== this.#seenResets) {
      if (this.#seenResets !== undefined) this.#wantedResult = undefined;
      this.#seenResets = resets;
    }
    let quiet = false;
    if (wanted !== undefined && wanted !== 0 && spellId === wanted) {
      if (result === this.#wantedResult) quiet = true;
      this.#wantedResult = result;
    }
    if (this.#hasLast && spellId === this.#lastSpell && result === this.#lastResult) {
      if (now - this.#lastAt < REFUSAL_REPEAT_MS) quiet = true;
      this.#lastAt = now;
    } else {
      this.#hasLast = true;
      this.#lastSpell = spellId;
      this.#lastResult = result;
      this.#lastAt = now;
    }
    return quiet;
  }

  /** 0x0080e1b0: an SMSG_SPELL_GO without CAST_FLAG_PENDING, whoever cast it — the last refusal forgotten. */
  spellGo(): void {
    this.#hasLast = false;
  }
}
