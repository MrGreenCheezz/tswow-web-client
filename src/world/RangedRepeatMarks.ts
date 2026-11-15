// 5.05 (15.11, bow9): which units carry Wow.exe's ranged auto-repeat mark (+0xa38 bit 0x200) and their ammo display
// (+0xb48), for the bow draw the renderer plays (browser/BowDraw.ts). Read in Wow.exe 3.3.5a 12340
// (.runtime/re-2026-11-15/bow9/r1, r2; re-2026-11-11/combat/d3.c, d4.c; re-2026-10-04/l18-wiring/h1.c):
//
// - set: 0x007fa2e0, the cast's visual start, for a spell with AttributesEx2 & 0x20 (0x00715ac0(1)); 0x00805330 runs it
//   on the player's own send and on SMSG_SPELL_START without CAST_FLAG_PENDING (0x00806700) for any caster;
// - cleared: SMSG_CANCEL_AUTO_REPEAT for the unit it names (0x0072d130), the player's own cancel 0x00807560
//   (0x00715ac0(0)), the unit's teardown 0x00734fd0;
// - the ammo: SMSG_SPELL_START of a spell with Attributes & 2 (REQ_AMMO) hands the packet's ammo display to 0x007206a0
//   (0x00806700), whatever the caster, even without the mark.
//
// One frozen record per unit, replaced only when it changes, so the render inputs' Map difference stays empty while
// nothing happens (RenderTablesBridge.ts).

/** SMSG_SPELL_START's CAST_FLAG_PENDING: a triggered cast, which 0x00806700 does not hand to 0x00805330. */
const CAST_FLAG_PENDING = 0x1;
/** `SPELL_ATTR0_REQ_AMMO`, Attributes word 0. */
export const SPELL_ATTR0_REQ_AMMO = 0x2;
/** `SPELL_ATTR2_AUTOREPEAT_FLAG`, AttributesEx2 (word 2). */
export const SPELL_ATTR2_AUTOREPEAT_FLAG = 0x20;

/** A marked unit: its ammo display (0: none known) and, for the active player, whether its repeat spell needs ammo. */
export interface RangedRepeatMark {
  readonly ammo: number;
  readonly reqAmmo: boolean;
}

/** The attribute words of a spell (`/dbc/spells` `attributes`), undefined while its row is unknown. */
export type SpellAttributeWords = (spellId: number) => readonly number[] | undefined;

export class RangedRepeatMarks {
  /** The marked units; read by the render inputs. */
  readonly marks = new Map<bigint, RangedRepeatMark>();
  readonly #ammo = new Map<bigint, number>();
  readonly #reqAmmo = new Map<bigint, boolean>();
  readonly #attributes: SpellAttributeWords;

  constructor(attributes: SpellAttributeWords) {
    this.#attributes = attributes;
  }

  /** SMSG_SPELL_START (0x00806700 → 0x00805330 → 0x007fa2e0, and → 0x007206a0). */
  spellStart(caster: bigint, spellId: number, castFlags: number, ammoDisplay: number | undefined): void {
    const words = this.#attributes(spellId);
    if (((words?.[0] ?? 0) & SPELL_ATTR0_REQ_AMMO) !== 0) {
      this.#ammo.set(caster, ammoDisplay ?? 0);
      this.#refresh(caster);
    }
    if ((castFlags & CAST_FLAG_PENDING) === 0 && ((words?.[2] ?? 0) & SPELL_ATTR2_AUTOREPEAT_FLAG) !== 0) {
      this.#mark(caster, words);
    }
  }

  /** The active player's own send of a repeat spell (0x00805330 after the packet → 0x007fa2e0). */
  ownSend(self: bigint, spellId: number): void {
    const words = this.#attributes(spellId);
    if (((words?.[2] ?? 0) & SPELL_ATTR2_AUTOREPEAT_FLAG) !== 0) this.#mark(self, words);
  }

  /** SMSG_CANCEL_AUTO_REPEAT (0x0072d130) or the player's own cancel (0x00807560): the mark goes. */
  cancel(guid: bigint): void {
    this.#reqAmmo.delete(guid);
    this.marks.delete(guid);
  }

  /** The unit is gone (0x00734fd0). */
  forget(guid: bigint): void {
    this.cancel(guid);
    this.#ammo.delete(guid);
  }

  /** Drops the units the world no longer holds. */
  prune(present: (guid: bigint) => boolean): void {
    if (this.#ammo.size === 0 && this.marks.size === 0) return;
    for (const guid of this.#ammo.keys()) if (!present(guid)) this.forget(guid);
    for (const guid of this.marks.keys()) if (!present(guid)) this.forget(guid);
  }

  clear(): void {
    this.marks.clear();
    this.#ammo.clear();
    this.#reqAmmo.clear();
  }

  #mark(guid: bigint, words: readonly number[] | undefined): void {
    this.#reqAmmo.set(guid, ((words?.[0] ?? 0) & SPELL_ATTR0_REQ_AMMO) !== 0);
    if (!this.marks.has(guid)) this.marks.set(guid, NO_MARK);
    this.#refresh(guid);
  }

  #refresh(guid: bigint): void {
    const mark = this.marks.get(guid);
    if (mark === undefined) return;
    const ammo = this.#ammo.get(guid) ?? 0;
    const reqAmmo = this.#reqAmmo.get(guid) ?? false;
    if (mark.ammo !== ammo || mark.reqAmmo !== reqAmmo) this.marks.set(guid, Object.freeze({ ammo, reqAmmo }));
  }
}

const NO_MARK: RangedRepeatMark = Object.freeze({ ammo: -1, reqAmmo: false });
