/**
 * 3.35 (03.10, L5): the fonts of a SimpleHTML page's four kinds of block — P (the page's own font)
 * and H1–H3 — as Wow.exe 3.3.5a (12340) keeps them (notes .runtime/re-2026-10-03/l5-runtime/g1.c,
 * l334/r4.c).
 *
 * - The widget holds four font instances, P and H1–H3 (+0x2d0…+0x2dc). Every font method in its
 *   table (0x00b2d150…0x00b2d1d8: Set/GetFontObject, Font, TextColor, ShadowColor, ShadowOffset,
 *   Spacing, JustifyH, JustifyV, IndentedWordWrap) asks 0x009748f0 which one: a string first argument
 *   that is "P", "H1", "H2" or "H3" in any case (0x0076e780) picks that one and is taken off the
 *   arguments; anything else — no string, or a string naming none, like a font file — means P and the
 *   arguments stay as they are. The method then runs as a FontString's on that instance.
 * - A header block is drawn in its header's instance only once that instance has a font — a font
 *   object or SetFont (+0x34); otherwise in P's, colour, shadow and spacing included (0x0096cc90).
 *   Its justification never counts: the block's `align` places its lines.
 *
 * Here P's settings are the widget's own (`fontObject`, `textColor`, the `fontFile`/`fontHeight`/
 * `fontFlags`/`shadowColor`/`shadowOffsetX`/`shadowOffsetY`/`spacing`/`justifyH`/`justifyV`
 * attributes), and a header's are the same attributes with its number after them (`fontFile1`,
 * `textColor1` as "r g b a", `spacing1` — the last also from `<FontStringHeader1 spacing>`), with its
 * font object in `stateFonts` (`FONTSTRINGHEADER1`). The DOM renderer and GetBoundsRect both read a
 * block's font through `frameXmlSimpleHtmlLevelFont`, so what is drawn is what is measured.
 */
import type { FrameXmlColor, FrameXmlFrame } from "./FrameXmlTypes.js";
import type { FrameXmlSimpleHtmlLevel } from "./FrameXmlSimpleHtmlBounds.js";

const ELEMENTS = ["P", "H1", "H2", "H3"] as const;

/** 0x009748f0: the instance a first argument names, or undefined when it names none (the arguments then stay). */
export function frameXmlSimpleHtmlElement(value: unknown): FrameXmlSimpleHtmlLevel | undefined {
  if (typeof value !== "string") return undefined;
  const index = (ELEMENTS as readonly string[]).indexOf(value.toUpperCase());
  return index < 0 ? undefined : (index as FrameXmlSimpleHtmlLevel);
}

/** The attribute a setting of one instance is kept in: P's is the widget's own. */
export function frameXmlSimpleHtmlKey(key: string, level: FrameXmlSimpleHtmlLevel): string {
  return level === 0 ? key : `${key}${level}`;
}

/** Whether header `level` has a font of its own (+0x34): a font object, or a font file from SetFont. */
export function frameXmlSimpleHtmlOwnFont(frame: FrameXmlFrame, level: FrameXmlSimpleHtmlLevel): boolean {
  if (level === 0) return false;
  return (frame.stateFonts.get(`FONTSTRINGHEADER${level}`) ?? "") !== "" || frame.attributes[`fontFile${level}`] !== undefined;
}

/** "r g b a" as SetTextColor keeps a header's colour. */
export function frameXmlSimpleHtmlColor(value: string | undefined): FrameXmlColor | undefined {
  if (value === undefined) return undefined;
  const [r, g, b, a] = value.split(" ").map(Number);
  return [r, g, b, a].every((channel) => Number.isFinite(channel)) ? { r: r!, g: g!, b: b!, a: a! } : undefined;
}

export interface FrameXmlSimpleHtmlFont {
  /** The instance the block is drawn in: 0 for P, or the header's own. */
  readonly level: FrameXmlSimpleHtmlLevel;
  /** Its font object ("" when it has none, as after SetFont alone). */
  readonly fontObject: string;
  /** Its own settings over the font object's, under a FontString's attribute names (fontFile, fontHeight, …). */
  readonly attributes: Readonly<Record<string, string>>;
  readonly textColor: FrameXmlColor | undefined;
  /** Its own height (SetFont) and spacing (SetSpacing, `spacing`): undefined — the font object's. */
  readonly height: number | undefined;
  readonly spacing: number | undefined;
}

const FACE_KEYS = ["fontFile", "fontHeight", "fontFlags", "shadowColor", "shadowOffsetX", "shadowOffsetY"] as const;

function finite(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** The font a block of `level` is drawn in: its header's own, or P's (0x0096cc90). */
export function frameXmlSimpleHtmlLevelFont(frame: FrameXmlFrame, level: FrameXmlSimpleHtmlLevel): FrameXmlSimpleHtmlFont {
  const own: FrameXmlSimpleHtmlLevel = frameXmlSimpleHtmlOwnFont(frame, level) ? level : 0;
  const attributes: Record<string, string> = {};
  for (const key of FACE_KEYS) {
    const value = frame.attributes[frameXmlSimpleHtmlKey(key, own)];
    if (value !== undefined) attributes[key] = value;
  }
  return {
    level: own,
    fontObject: own === 0 ? frame.fontObject : frame.stateFonts.get(`FONTSTRINGHEADER${own}`) ?? "",
    attributes,
    textColor: own === 0 ? frame.textColor : frameXmlSimpleHtmlColor(frame.attributes[`textColor${own}`]),
    height: finite(frame.attributes[frameXmlSimpleHtmlKey("fontHeight", own)]),
    spacing: finite(frame.attributes[frameXmlSimpleHtmlKey("spacing", own)]),
  };
}

/** Everything about the headers' fonts that changes how a page is drawn, for a renderer's redraw key. */
export function frameXmlSimpleHtmlFontKey(frame: FrameXmlFrame): string {
  let key = "";
  for (const level of [1, 2, 3] as const) {
    key += `\u0000${frame.stateFonts.get(`FONTSTRINGHEADER${level}`) ?? ""}`;
    for (const name of [...FACE_KEYS, "textColor", "spacing"]) key += `\u0001${frame.attributes[`${name}${level}`] ?? ""}`;
  }
  return `${key}\u0002${frame.attributes["spacing"] ?? ""}\u0002${frame.attributes["fontHeight"] ?? ""}\u0002${frame.fontObject}`;
}
