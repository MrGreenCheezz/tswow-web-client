/**
 * Plan item 5.30 (L12, 04.10): the stock UI's view of the global cooldown (`game.globalCooldownUntil`,
 * game/PredictedGlobalCooldown.ts).
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra, 2026-10-04):
 * - Right after a request writes its history entry (0x00805d70), and whenever an entry changes, the client
 *   raises ACTIONBAR_UPDATE_COOLDOWN (0x005a7cc0, event 0xb3) and SPELL_UPDATE_COOLDOWN (0x0053bac0,
 *   0xf4); the stock buttons redraw their sweep only on those (ActionButton.lua, SpellBookFrame.lua).
 * - `GetSpellCooldown` (0x00540e80 → 0x00809000 → 0x00807980) and `GetActionCooldown` (0x005a91c0 →
 *   0x005a8e40 → the same query) answer from one walk over the history: the spell's own timer, its
 *   category's and the global part of any entry whose category is the spell's StartRecoveryCategory;
 *   the one that ends last wins, as start and duration in seconds and `enable` 1.
 */
import { globalCooldownDurationIn, type GlobalCooldownRow, type GlobalCooldownWorld } from "../game/GlobalCooldownDuration.js"; // L13-review 5.30
import type { GlobalCooldownView } from "../game/PredictedGlobalCooldown.js"; // L13-review 5.30

/** The three numbers of `GetSpellCooldown`/`GetActionCooldown`. */
export type FrameXmlCooldownAnswer = readonly [number, number, number];

/**
 * The global part for a spell whose global cooldown would last `startRecoveryTime` ms: start and duration in
 * the pump's seconds, or undefined when it is not running or the spell is off it. `monotonic` is the clock
 * `until` is kept in, `nowSeconds` the pump's clock for the same moment. L12-review: the seam passes the
 * spell's predicted duration (game/GlobalCooldownDuration.ts: hasted, SPELLMOD 21), so a sweep started by a
 * spell of the same rule starts at the request. L13-review 5.30: with a model (`frameXmlGlobalCooldownFor`) `until`
 * is the end of the global cooldown of the spell's own StartRecoveryCategory and the length that entry's own.
 */
export function frameXmlGlobalCooldownAnswer(
  until: number, monotonic: number, startRecoveryTime: number, nowSeconds: number,
): FrameXmlCooldownAnswer | undefined {
  const remaining = until - monotonic;
  if (!(remaining > 0) || !(startRecoveryTime > 0)) return undefined;
  // Never a start in the future: a longer end than this spell's own global part (another spell's)
  // starts the sweep now and runs it for what is left.
  const duration = Math.max(startRecoveryTime, remaining);
  return [nowSeconds - (duration - remaining) / 1000, duration / 1000, 1];
}

/** L13-review 5.30: what the seam's context offers — the shared end, and the page's model when it has one. */
export interface FrameXmlGlobalCooldownContext {
  readonly globalCooldownUntil: () => number;
  readonly globalCooldown?: GlobalCooldownView | undefined;
}

/**
 * L13-review 5.30: the global part of `row` for `GetSpellCooldown`/`GetActionCooldown` — 0x00807980 walks the entries
 * whose category is the row's StartRecoveryCategory and answers that entry's start and its own length. With the
 * page's model: `globalCooldownEndFor`/`globalCooldownSpanFor` (a 133 row with no time of its own shows the running
 * 133 sweep, category 0 none, 38 only its own); a length the model does not know falls back to the row's predicted
 * duration. Without one (a seam host of its own): the shared end and the row's duration, as L12 had it.
 */
export function frameXmlGlobalCooldownFor(
  context: FrameXmlGlobalCooldownContext, world: GlobalCooldownWorld | undefined, row: GlobalCooldownRow | undefined,
  monotonic: number, nowSeconds: number,
): FrameXmlCooldownAnswer | undefined {
  const view = context.globalCooldown;
  if (!view) return frameXmlGlobalCooldownAnswer(context.globalCooldownUntil(), monotonic, globalCooldownDurationIn(world, row), nowSeconds);
  const until = view.endFor(row);
  if (!(until > monotonic)) return undefined;
  const span = view.spanFor(row);
  return frameXmlGlobalCooldownAnswer(until, monotonic, span > 0 ? span : globalCooldownDurationIn(world, row), nowSeconds);
}

/** The answer that ends last (0x00807980 keeps the latest end of the entries it walks). */
export function frameXmlLaterCooldown(
  own: FrameXmlCooldownAnswer, global: FrameXmlCooldownAnswer | undefined,
): FrameXmlCooldownAnswer {
  if (!global) return own;
  if (own[1] <= 0) return global;
  return global[0] + global[1] > own[0] + own[1] ? global : own;
}

/**
 * The redraw edge: once per change of the global cooldown's end — a request, the acceptance or a refusal
 * moved it — ACTIONBAR_UPDATE_COOLDOWN and SPELL_UPDATE_COOLDOWN, as the client raises them after writing
 * its history. Polled from the seam's tick: one comparison a frame. Its running out needs no edge; the
 * stock Cooldown frames finish their sweep by themselves. L13-review 5.30: with the page's model the seam feeds it
 * `globalCooldownRevision`, which moves for every category's end (a category-38 request too), not the shared end.
 */
export class FrameXmlGlobalCooldownEdge {
  #until: number | undefined;

  /** True when the end moved since the last call (the first call only records it). */
  changed(until: number): boolean {
    const previous = this.#until;
    this.#until = until;
    return previous !== undefined && previous !== until;
  }
}
