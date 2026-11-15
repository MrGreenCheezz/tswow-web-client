/**
 * plates12 (15.11, plan items 6.37 and 3.21): the name plates as WorldFrame's children, taken for units and given back as
 * Wow.exe 3.3.5a (12340) does it (read-only Ghidra, `.runtime/re-2026-11-15/plates12/`; behaviour described, no code
 * copied).
 *
 * - **Taking a plate** (0x007256c0, from the unit's plate pass 0x0072b350 when 0x0072b060 admits the unit): a unit with
 *   no plate asks 0x007254e0, which unlinks the HEAD of the free list at 0x00adaa8c (the plate given back longest ago)
 *   or, with the list empty, makes a new CGNamePlateFrame (0x0098f790). Then the attach (0x0098f390,
 *   FrameXmlNamePlateFrame.ts), then Show (0x0048f660, OnShow), then the position.
 * - **Giving it back** (0x00725840, when 0x0072b060 refuses the unit — out of range, dead, unseen, switched off — and
 *   from the unit's update 0x00734390): the plate is linked at the TAIL of the same free list (0x0056ca00, ECX =
 *   0x00adaa8c), then hidden (0x0048f620, OnHide). The frame is never destroyed: `WorldFrame:GetChildren()` only grows,
 *   and a plate keeps the last unit's name and bars while it waits, hidden.
 * - **Moving it**: 0x007256c0 re-anchors a shown plate only when its projected point moved (or a forced pass); the
 *   plate's one point is TOP on WorldFrame's BOTTOMLEFT (the recording's `points [TOP WorldFrame BOTTOMLEFT x y]`).
 *
 * The cost: a plate that only moved has its point's offsets written in place, unannounced, and its own box placed again
 * by the renderer (`FrameXmlDomRenderer.placeMovedFrames`) — no reconciliation pass, nothing else re-laid out. Every
 * other change goes through the bridge as a Lua call would, compared first, so a frame in which no plate changed writes
 * nothing and allocates nothing here.
 */
import type { FrameXmlUiBridge } from "./FrameXmlRuntime.js";
import type { FrameXmlColor, FrameXmlFrame, FrameXmlPoint } from "./FrameXmlTypes.js";
import {
  FRAME_XML_NAME_PLATE_CAST_COLOUR,
  FRAME_XML_NAME_PLATE_FONT,
  FRAME_XML_NAME_PLATE_LEVEL,
  FRAME_XML_NAME_PLATE_TARGET_LEVEL,
  attachFrameXmlNamePlate,
  buildFrameXmlNamePlate,
  setFrameXmlShown,
  setFrameXmlStatusBarColour,
  setFrameXmlStatusBarValue,
  setFrameXmlTexCoord,
  setFrameXmlTextColour,
  setFrameXmlVertexColour,
  type FrameXmlNamePlateParts,
} from "./FrameXmlNamePlateFrame.js";

/** 127 of 255 on every plate but the target's while there is a target (the recording's alpha 0.498). */
const DIMMED_ALPHA = 127 / 255;

/** What one plate shows. Colours are 0xRRGGBB; the host fills one of these per plate and may reuse it. */
export interface FrameXmlNamePlateState {
  name: string;
  /** Undefined: no number (a unit whose level is not known). */
  level: number | undefined;
  levelColour: number;
  skull: boolean;
  elite: boolean;
  barColour: number;
  /** The health bar's value and its top; undefined while the server has not sent them (an empty bar). */
  health: number | undefined;
  healthMax: number | undefined;
  /** 0 to 7, or undefined for none. */
  raidMark: number | undefined;
  /** The threat flash's colour, or undefined for none. */
  flashColour: number | undefined;
  hovered: boolean;
  target: boolean;
  dimmed: boolean;
  cast: boolean;
  castIcon: string | undefined;
  castShielded: boolean;
  /** The cast bar's value and its top, in seconds (the recording's `value=4.365 of 0.000..90.000`). */
  castValue: number;
  castMax: number;
}

/** One plate for one unit this frame: TOP at (x, y) on WorldFrame, in its units, from its bottom-left corner. */
export interface FrameXmlNamePlateEntry {
  guid: bigint;
  x: number;
  y: number;
  readonly state: FrameXmlNamePlateState;
}

export function frameXmlNamePlateState(): FrameXmlNamePlateState {
  return {
    name: "", level: undefined, levelColour: 0xffff00, skull: false, elite: false, barColour: 0xff0000,
    health: undefined, healthMax: undefined, raidMark: undefined, flashColour: undefined, hovered: false, target: false,
    dimmed: false, cast: false, castIcon: undefined, castShielded: false, castValue: 0, castMax: 0,
  };
}

interface Slot {
  readonly parts: FrameXmlNamePlateParts;
  guid: bigint;
  /** The `present` call that last showed it. */
  stamp: number;
  readonly shown: FrameXmlNamePlateState;
  x: number;
  y: number;
}

export interface FrameXmlNamePlatePoolOptions {
  /** NAMEPLATE_FONT, the client's own (GlobalStrings); the recording's file otherwise. */
  readonly fontFile?: string;
  /** Place the plates that only moved, after the batch's own pass (`FrameXmlDomRenderer.placeMovedFrames`). */
  readonly placeMoved?: (frames: readonly FrameXmlFrame[]) => void;
  /** Draw the shown plates in this order among themselves (`FrameXmlDomRenderer.stackSiblings`). */
  readonly stack?: (frames: readonly FrameXmlFrame[]) => void;
}

const NO_ENTRIES: readonly FrameXmlNamePlateEntry[] = Object.freeze([]);

/** `to` becomes what `from` says, field by field (no allocation, unlike a spread). */
function copyState(to: FrameXmlNamePlateState, from: FrameXmlNamePlateState): void {
  to.name = from.name;
  to.level = from.level;
  to.levelColour = from.levelColour;
  to.skull = from.skull;
  to.elite = from.elite;
  to.barColour = from.barColour;
  to.health = from.health;
  to.healthMax = from.healthMax;
  to.raidMark = from.raidMark;
  to.flashColour = from.flashColour;
  to.hovered = from.hovered;
  to.target = from.target;
  to.dimmed = from.dimmed;
  to.cast = from.cast;
  to.castIcon = from.castIcon;
  to.castShielded = from.castShielded;
  to.castValue = from.castValue;
  to.castMax = from.castMax;
}

type WritablePoint ={ -readonly [K in keyof FrameXmlPoint]: FrameXmlPoint[K] };

const red = (rgb: number): number => ((rgb >> 16) & 0xff) / 255;
const green = (rgb: number): number => ((rgb >> 8) & 0xff) / 255;
const blue = (rgb: number): number => (rgb & 0xff) / 255;

/** Plates under one WorldFrame, kept for the units they show. */
export class FrameXmlNamePlatePool {
  readonly #bridge: FrameXmlUiBridge;
  readonly #worldFrame: FrameXmlFrame;
  readonly #options: FrameXmlNamePlatePoolOptions;
  readonly #byGuid = new Map<bigint, Slot>();
  readonly #active: Slot[] = [];
  /** 0x00adaa8c: given back at the tail, taken from the head. */
  readonly #free: Slot[] = [];
  readonly #all: FrameXmlFrame[] = [];
  readonly #moved: FrameXmlFrame[] = [];
  /** This frame's plates in drawing order: the first `#orderCount`, written in place (the rest is stale). */
  readonly #order: FrameXmlFrame[] = [];
  #orderCount = 0;
  #stackedOrder: FrameXmlFrame[] = [];
  #stamp = 0;
  #entries: readonly FrameXmlNamePlateEntry[] = NO_ENTRIES;
  #count = 0;
  readonly #colour = { r: 1, g: 1, b: 1, a: 1 };

  constructor(bridge: FrameXmlUiBridge, worldFrame: FrameXmlFrame, options: FrameXmlNamePlatePoolOptions = {}) {
    this.#bridge = bridge;
    this.#worldFrame = worldFrame;
    this.#options = options;
  }

  /** Every plate frame made so far, in the order they were made (WorldFrame's children among them). */
  get frames(): readonly FrameXmlFrame[] {
    return this.#all;
  }

  /** The plate showing `guid`, if one does. */
  frameFor(guid: bigint): FrameXmlFrame | undefined {
    return this.#byGuid.get(guid)?.parts.frame;
  }

  /**
   * This frame's plates, in drawing order (far first, the target last): a unit with a plate keeps it, a new one takes
   * one, and every plate not listed is given back.
   */
  present(entries: readonly FrameXmlNamePlateEntry[], count = entries.length): void {
    this.#stamp += 1;
    const moved = this.#moved;
    // Emptied only when it holds something: `length = 0` gives the array's storage back, and a still frame would
    // allocate it again (measured: the drawing-order list did, 18–70 B a frame).
    if (moved.length > 0) moved.length = 0;
    this.#orderCount = 0;
    this.#entries = entries;
    this.#count = count;
    try {
      this.#bridge.runInMutationBatch(this.#presentBody);
    } finally {
      this.#entries = NO_ENTRIES;
    }
    if (moved.length > 0) this.#options.placeMoved?.(moved);
    if (this.#options.stack && !this.sameOrder()) {
      this.#stackedOrder = this.#order.slice(0, this.#orderCount);
      this.#options.stack(this.#stackedOrder);
    }
  }

  /** `present`'s batch, made once so a frame allocates no closure. */
  readonly #presentBody = (): void => {
    const stamp = this.#stamp;
    const entries = this.#entries;
    for (let index = 0; index < this.#count; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      let slot = this.#byGuid.get(entry.guid);
      if (slot && slot.stamp === stamp) continue;
      if (!slot) {
        slot = this.take(entry);
        if (!slot) continue;
      } else this.apply(slot, entry.state, false);
      slot.stamp = stamp;
      if (this.move(slot, entry.x, entry.y)) this.#moved.push(slot.parts.frame);
      this.#order[this.#orderCount] = slot.parts.frame;
      this.#orderCount += 1;
    }
    for (let index = this.#active.length - 1; index >= 0; index -= 1) {
      const slot = this.#active[index]!;
      if (slot.stamp !== stamp) this.giveBack(slot, index);
    }
  };

  /** Give every plate back (the world left, the plates switched off). */
  clear(): void {
    this.present([], 0);
  }

  /** This frame's drawing order (the first `#orderCount` of `#order`) is the one last stacked. */
  private sameOrder(): boolean {
    const stacked = this.#stackedOrder;
    const order = this.#order;
    const count = this.#orderCount;
    if (stacked.length !== count) return false;
    for (let index = 0; index < count; index += 1) if (stacked[index] !== order[index]) return false;
    return true;
  }

  /** 0x007254e0 + 0x0098f390 + Show. */
  private take(entry: FrameXmlNamePlateEntry): Slot | undefined {
    let slot = this.#free.shift();
    if (!slot) {
      const parts = buildFrameXmlNamePlate(this.#bridge, this.#worldFrame, this.#options.fontFile ?? FRAME_XML_NAME_PLATE_FONT);
      if (!parts) return undefined;
      this.#all.push(parts.frame);
      slot = { parts, guid: entry.guid, stamp: 0, shown: { ...entry.state }, x: Number.NaN, y: Number.NaN };
    }
    slot.guid = entry.guid;
    this.#byGuid.set(entry.guid, slot);
    this.#active.push(slot);
    attachFrameXmlNamePlate(this.#bridge, slot.parts, entry.state.name);
    this.apply(slot, entry.state, true);
    setFrameXmlShown(this.#bridge, slot.parts.frame, true);
    return slot;
  }

  /** 0x00725840: to the tail of the free list, then hidden. */
  private giveBack(slot: Slot, index: number): void {
    const last = this.#active.length - 1;
    if (index !== last) this.#active[index] = this.#active[last]!;
    this.#active.length = last;
    if (this.#byGuid.get(slot.guid) === slot) this.#byGuid.delete(slot.guid);
    this.#free.push(slot);
    setFrameXmlShown(this.#bridge, slot.parts.frame, false);
  }

  private colour(rgb: number, a = 1): FrameXmlColor {
    const colour = this.#colour;
    colour.r = red(rgb);
    colour.g = green(rgb);
    colour.b = blue(rgb);
    colour.a = a;
    return colour;
  }

  /** Write what changed (everything, on an attach). */
  private apply(slot: Slot, state: FrameXmlNamePlateState, all: boolean): void {
    const bridge = this.#bridge;
    const shown = slot.shown;
    const parts = slot.parts;
    if (all || shown.name !== state.name) bridge.SetText(parts.name, state.name);

    // 0x0098ef10: the skull instead of the number; the number in its colour.
    if (all || shown.skull !== state.skull || shown.level !== state.level || shown.levelColour !== state.levelColour) {
      const number = !state.skull && state.level !== undefined;
      setFrameXmlShown(bridge, parts.skull, state.skull);
      if (number) {
        bridge.SetText(parts.level, String(state.level));
        setFrameXmlTextColour(bridge, parts.level, red(state.levelColour), green(state.levelColour), blue(state.levelColour), 1);
      }
      setFrameXmlShown(bridge, parts.level, number);
    }
    if (all || shown.elite !== state.elite) setFrameXmlShown(bridge, parts.elite, state.elite);

    // 0x0098ee30 and 0x00990280: the health bar's colour, range and value.
    if (all || shown.barColour !== state.barColour) setFrameXmlStatusBarColour(bridge, parts.healthBar, this.colour(state.barColour));
    if (all || shown.health !== state.health || shown.healthMax !== state.healthMax) {
      const max = state.healthMax !== undefined && state.health !== undefined && state.healthMax > 0 ? state.healthMax : 0;
      setFrameXmlStatusBarValue(bridge, parts.healthBar, 0, max, max > 0 ? state.health ?? 0 : 0);
    }

    // 0x0098e740: a four by four sheet, the mark's low bits across.
    if (all || shown.raidMark !== state.raidMark) {
      const mark = state.raidMark;
      const marked = mark !== undefined && mark >= 0 && mark < 8;
      if (marked) {
        const left = (mark & 3) * 0.25;
        const top = (mark >> 2) * 0.25;
        setFrameXmlTexCoord(bridge, parts.raidIcon, left, left + 0.25, top, top + 0.25);
      }
      setFrameXmlShown(bridge, parts.raidIcon, marked);
    }
    if (all || shown.flashColour !== state.flashColour) {
      const flash = state.flashColour;
      if (flash !== undefined) setFrameXmlVertexColour(bridge, parts.flash, red(flash), green(flash), blue(flash), 1);
      setFrameXmlShown(bridge, parts.flash, flash !== undefined);
    }
    if (all || shown.hovered !== state.hovered) setFrameXmlShown(bridge, parts.glow, state.hovered);

    // The target over every other plate (level 20 against 10, its bars 19 against 9), the others dimmed.
    if (all || shown.target !== state.target) {
      const level = state.target ? FRAME_XML_NAME_PLATE_TARGET_LEVEL : FRAME_XML_NAME_PLATE_LEVEL;
      for (const frame of [parts.frame, parts.healthBar, parts.castBar]) {
        const wanted = frame === parts.frame ? level : level - 1;
        if (frame.frameLevel !== wanted) bridge.update(frame, (m) => { m.frameLevel = wanted; });
      }
    }
    if (all || shown.dimmed !== state.dimmed) {
      const alpha = state.dimmed ? DIMMED_ALPHA : 1;
      if (parts.frame.alpha !== alpha) bridge.update(parts.frame, (m) => { m.alpha = alpha; }, "paint");
    }

    // The target's cast (ShowVKeyCastbar): the turned border (or the shield), the spell, the bar.
    if (all || shown.cast !== state.cast || shown.castShielded !== state.castShielded || shown.castIcon !== state.castIcon
      || shown.castValue !== state.castValue || shown.castMax !== state.castMax) {
      if (state.cast) {
        if (state.castIcon !== undefined && parts.spellIcon.texture !== state.castIcon) bridge.SetTexture(parts.spellIcon, state.castIcon);
        setFrameXmlStatusBarColour(bridge, parts.castBar, FRAME_XML_NAME_PLATE_CAST_COLOUR);
        setFrameXmlStatusBarValue(bridge, parts.castBar, 0, state.castMax, state.castValue);
      }
      setFrameXmlShown(bridge, parts.castBorder, state.cast && !state.castShielded);
      setFrameXmlShown(bridge, parts.shield, state.cast && state.castShielded);
      setFrameXmlShown(bridge, parts.spellIcon, state.cast && state.castIcon !== undefined);
      setFrameXmlShown(bridge, parts.castBar, state.cast);
    }
    copyState(shown, state);
  }

  /**
   * The plate's one point, TOP on WorldFrame's BOTTOMLEFT at (x, y). Answers whether the point only moved — written in
   * place, for `placeMoved`; a point of another shape (a new plate, one an add-on re-anchored) is set through the bridge
   * and placed by the batch's own pass.
   */
  private move(slot: Slot, x: number, y: number): boolean {
    if (slot.x === x && slot.y === y && this.anchored(slot.parts.frame)) return false;
    slot.x = x;
    slot.y = y;
    const frame = slot.parts.frame;
    if (!this.anchored(frame)) {
      this.#bridge.ClearAllPoints(frame);
      this.#bridge.SetPoint(frame, "TOP", this.#worldFrame, "BOTTOMLEFT", x, y);
      return false;
    }
    const point = frame.points[0] as WritablePoint;
    if (point.x === x && point.y === y) return false;
    point.x = x;
    point.y = y;
    return true;
  }

  private anchored(frame: FrameXmlFrame): boolean {
    const points = frame.points;
    if (points.length !== 1) return false;
    const point = points[0]!;
    return point.point === "TOP" && point.relativeTo === this.#worldFrame && point.relativePoint === "BOTTOMLEFT";
  }
}
