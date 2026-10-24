/**
 * 25.10 (6.27): the colour a spell puts on a unit's model — a kit's CharProc 1 tint while the kit lives, its
 * CharProc 13 flash (CGUnit_C::CreateProceduralEffect 0x007265c0).
 *
 * Wow.exe keeps one flash per unit (m_flashColor/m_flashStartTime/m_flashDelay/m_flashDuration, the newest replacing
 * the last) and a list of proc effects, newest first; UpdateModelTint (0x00720db0) takes the flash while it lasts
 * (GetFlashColor 0x0071a9a0: the flash colour until start + delay, then back to white over the duration) and the
 * newest proc effect's colour otherwise, and sets it as the model's diffuse tint. A tint belongs to its cast — the
 * aura's end (cancelSpellVisual) takes it away — a flash to the unit.
 *
 * Census 25.10: CharProc 1 in 840 spell visuals (Frost Nova's blue, poisons' green, stone forms' grey), 13 in 183.
 */
import type { VisualTint } from "./SpellVisuals.js";

interface HeldTint {
  owner: object;
  colour: number;
  startedAt: number;
  endsAt: number;
  order: number;
}

interface HeldFlash {
  colour: number;
  startedAt: number;
  delayMs: number;
  durationMs: number;
}

export const WHITE = 0xffffff;

/** The flash colour `now`, or undefined once it has faded (GetFlashColor 0x0071a9a0). */
export function flashColour(flash: HeldFlash, now: number): number | undefined {
  if (now < flash.startedAt) return undefined;
  const fadeFrom = flash.startedAt + flash.delayMs;
  if (now < fadeFrom) return flash.colour;
  if (!(flash.durationMs > 0) || now - fadeFrom >= flash.durationMs) return undefined;
  // InterpColor(t, flash) from white with t = (1 − elapsed / duration) · 255: the flash colour at the start of the
  // fade, white at its end.
  const t = 1 - (now - fadeFrom) / flash.durationMs;
  let packed = 0;
  for (let shift = 16; shift >= 0; shift -= 8) {
    const channel = (flash.colour >> shift) & 0xff;
    packed |= Math.round(255 + (channel - 255) * t) << shift;
  }
  return packed;
}

export class UnitTints {
  readonly #tints = new Map<bigint, HeldTint[]>();
  readonly #flashes = new Map<bigint, HeldFlash>();
  #order = 0;

  /** A plan's tints and flashes, owned by its handle (`cancel`/`retime` find them by it). */
  add(owner: object, tints: readonly VisualTint[]): void {
    for (const tint of tints) {
      if (tint.flash) {
        this.#flashes.set(tint.guid, {
          colour: tint.flash.colour, startedAt: tint.startedAt, delayMs: tint.flash.delayMs, durationMs: tint.flash.durationMs,
        });
      }
      if (tint.tint === undefined) continue;
      let list = this.#tints.get(tint.guid);
      if (!list) this.#tints.set(tint.guid, list = []);
      list.push({ owner, colour: tint.tint, startedAt: tint.startedAt, endsAt: tint.endsAt, order: ++this.#order });
    }
  }

  /** The cast ended: its tints go (its flashes stay — a flash is the unit's). */
  cancel(owner: object): void {
    for (const [guid, list] of this.#tints) {
      for (let index = list.length - 1; index >= 0; index--) if (list[index]!.owner === owner) list.splice(index, 1);
      if (list.length === 0) this.#tints.delete(guid);
    }
  }

  retime(owner: object, endsAt: number): void {
    for (const list of this.#tints.values()) for (const tint of list) if (tint.owner === owner) tint.endsAt = endsAt;
  }

  clear(): void {
    this.#tints.clear();
    this.#flashes.clear();
  }

  /** The unit's model colour `now` as 0xRRGGBB — white when nothing tints it. Drops what has ended. */
  colourOf(guid: bigint, now: number): number {
    const flash = this.#flashes.get(guid);
    if (flash) {
      const colour = flashColour(flash, now);
      if (colour !== undefined) return colour;
      if (now >= flash.startedAt) this.#flashes.delete(guid);
    }
    const list = this.#tints.get(guid);
    if (!list) return WHITE;
    let newest: HeldTint | undefined;
    for (let index = list.length - 1; index >= 0; index--) {
      const tint = list[index]!;
      if (tint.endsAt <= now) {
        list.splice(index, 1);
        continue;
      }
      if (tint.startedAt <= now && (!newest || tint.order > newest.order)) newest = tint;
    }
    if (list.length === 0) this.#tints.delete(guid);
    return newest ? newest.colour : WHITE;
  }

  /** Whether any unit is (or will be) tinted — the frame skips the per-unit pass otherwise. */
  get empty(): boolean {
    return this.#tints.size === 0 && this.#flashes.size === 0;
  }
}
