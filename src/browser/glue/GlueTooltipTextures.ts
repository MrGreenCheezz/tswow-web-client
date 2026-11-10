/**
 * Plan item 4.04 (11.11): `GameTooltip:AddTexture` as Wow.exe 3.3.5a 12340 draws it — the Lua method 0x0061d810 over
 * the writer 0x0061c8b0, undone by ClearLines' 0x0061c620 (Ghidra, `.runtime/re-2026-11-11/usable/u7.c`, `u6.c`,
 * `u13.lst`, `u12.c`; described here in this file's words):
 *
 * - The textures are the template's own `<name>Texture1` … `<name>Texture10` (GameTooltipTemplate.xml: hidden,
 *   12 × 12, no anchors), looked up by name when the tooltip is built (0x0061fb30). At most ten per tooltip.
 * - A texture goes on the last line written, and never on the first: with fewer than two lines nothing happens.
 * - That line's left text is moved right to make room: TOPLEFT to the line above's BOTTOMLEFT at
 *   (texture width + gap, −2), or at (0, −2) when the previous texture sits on the line above (that line is moved
 *   already). The texture's TOPRIGHT is at the line's TOPLEFT, −gap to the left. A line below that exists already
 *   is put back: TOPLEFT to this line's BOTTOMLEFT at (−(width + gap), −2).
 * - The gap is 0.005 of Wow.exe's screen-diagonal units (0x00a246fc): in UI units 0.005 × 768 × √(aspect² + 1) —
 *   0x0047bf90 sets the scales from the aspect, 0x0047c070 and 1024 (0x009e300c) convert — 6.4 at 4:3.
 * - Then the file, the tex coords (Lua `minx, maxx, miny, maxy`, default 0, 1, 0, 1) and the tint (white from Lua;
 *   the threat icon's from the caller), shown.
 * - ClearLines (0x0061c620, which SetOwner and the setters reach through the line clear) puts every texture's line
 *   back at (0, −2) under the line above, the line below a texture at (0, 0) under it — Wow.exe writes 0 there —
 *   and hides the textures; the count starts again at 0.
 */
import type { FrameXmlColor, FrameXmlFrame, FrameXmlTexCoords } from "../ui/framexml_compat/FrameXmlTypes.js";

/** What the textures read and write of the tooltip; GlueWidgets satisfies it. */
export interface GlueTooltipTextureHost {
  /** `<name>Texture<i>`, the template's texture, or undefined. */
  texture(frame: FrameXmlFrame, index: number): FrameXmlFrame | undefined;
  /** The left text of a line (1-based) that exists already; undefined otherwise. */
  line(frame: FrameXmlFrame, index: number): FrameXmlFrame | undefined;
  /** How many lines the tooltip has written since it was cleared. */
  lineCount(frame: FrameXmlFrame): number;
  /** The screen's width over its height, for the gap. */
  aspect(): number;
  /** A region's width in UI units (GetWidth; the template's textures are 12). */
  width(region: FrameXmlFrame): number;
  setPoint(region: FrameXmlFrame, point: string, relativeTo: FrameXmlFrame, relativePoint: string, x: number, y: number): void;
  clearAllPoints(region: FrameXmlFrame): void;
  paint(texture: FrameXmlFrame, file: string, coords: FrameXmlTexCoords, color: FrameXmlColor): void;
  show(region: FrameXmlFrame): void;
  hide(region: FrameXmlFrame): void;
}

export const GLUE_TOOLTIP_MAX_TEXTURES = 10;
const LINE_GAP = -2;
const GAP_DIAGONAL_UNITS = 0.005;
const WHITE: FrameXmlColor = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });
export const GLUE_TOOLTIP_FULL_TEX_COORDS: FrameXmlTexCoords = Object.freeze({ left: 0, right: 1, top: 0, bottom: 1 });

/** 0.005 diagonal units in UI units at this aspect. */
export function glueTooltipTextureGap(aspect: number): number {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  return GAP_DIAGONAL_UNITS * 768 * Math.sqrt(ratio * ratio + 1);
}

/** Each tooltip's placed textures: the line (1-based) each one sits on, in order. */
export class GlueTooltipTextures {
  readonly #host: GlueTooltipTextureHost;
  readonly #placed = new WeakMap<FrameXmlFrame, number[]>();

  constructor(host: GlueTooltipTextureHost) {
    this.#host = host;
  }

  /** The lines carrying a texture, for tests and probes. */
  lines(frame: FrameXmlFrame): readonly number[] {
    return this.#placed.get(frame) ?? [];
  }

  /** 0x0061c8b0: one texture on the last line written; false when there is no room or no line for it. */
  add(frame: FrameXmlFrame, file: string, coords: FrameXmlTexCoords = GLUE_TOOLTIP_FULL_TEX_COORDS,
    color: FrameXmlColor = WHITE): boolean {
    const host = this.#host;
    const placed = this.#placed.get(frame) ?? [];
    const count = placed.length;
    const texture = count < GLUE_TOOLTIP_MAX_TEXTURES ? host.texture(frame, count + 1) : undefined;
    const lines = host.lineCount(frame);
    if (!texture || lines < 2) return false;
    const line = host.line(frame, lines);
    const above = host.line(frame, lines - 1);
    if (!line || !above) return false;
    const gap = glueTooltipTextureGap(host.aspect());
    const width = host.width(texture);
    const shift = count === 0 || placed[count - 1] !== lines - 1 ? width + gap : 0;
    host.setPoint(line, "TOPLEFT", above, "BOTTOMLEFT", shift, LINE_GAP);
    host.clearAllPoints(texture);
    host.setPoint(texture, "TOPRIGHT", line, "TOPLEFT", -gap, 0);
    const below = host.line(frame, lines + 1);
    if (below) host.setPoint(below, "TOPLEFT", line, "BOTTOMLEFT", -(width + gap), LINE_GAP);
    host.paint(texture, file, coords, color);
    host.show(texture);
    placed.push(lines);
    this.#placed.set(frame, placed);
    return true;
  }

  /** 0x0061c620's texture part: the lines put back, the textures hidden, the count 0. */
  clear(frame: FrameXmlFrame): void {
    const placed = this.#placed.get(frame);
    if (!placed || placed.length === 0) return;
    const host = this.#host;
    placed.forEach((index, slot) => {
      const line = host.line(frame, index);
      const above = host.line(frame, index - 1);
      if (line && above) host.setPoint(line, "TOPLEFT", above, "BOTTOMLEFT", 0, LINE_GAP);
      const below = host.line(frame, index + 1);
      if (line && below) host.setPoint(below, "TOPLEFT", line, "BOTTOMLEFT", 0, 0);
      const texture = host.texture(frame, slot + 1);
      if (texture) host.hide(texture);
    });
    placed.length = 0;
  }
}

/**
 * 0x0061d810's arguments `"file" [, minx, maxx, miny, maxy]`: no number second — the whole texture; four numbers —
 * those; a number second without the other three is the usage error (undefined: nothing is added).
 */
export function glueTooltipTextureCoords(args: readonly unknown[]): FrameXmlTexCoords | undefined {
  const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  if (!isNumber(args[1])) return GLUE_TOOLTIP_FULL_TEX_COORDS;
  const values = args.slice(1, 5);
  if (values.length !== 4 || !values.every(isNumber)) return undefined;
  const [left, right, top, bottom] = values as number[];
  return { left: left!, right: right!, top: top!, bottom: bottom! };
}
