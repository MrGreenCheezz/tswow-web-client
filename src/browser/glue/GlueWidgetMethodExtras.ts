/**
 * Plan item 3.21: widget methods the boot census found called but unanswered.
 *
 * `ColorSelect:SetColorRGB/GetColorRGB` (ColorPickerFrame — OpenColorPicker, UIDropDownMenu.lua:986-996,
 * and the chat colour swatches, ChatConfigFrame.lua:1336-1374) and
 * `ScrollingMessageFrame:UpdateColorByID` (ChatFrame.lua:2522, :2530 on UPDATE_CHAT_COLOR).
 *
 * Behaviour is the client's, read from Wow.exe.clean (descriptions only, no code copied):
 *
 * * `SetColorRGB` (0x00971050): each of r, g, b is clamped to [0, 1] (0x00960420), packed into a
 *   byte colour (0x0048bd20: channel × 255 + 0.5, whole part), stored, and the widget's
 *   `OnColorSelect` script — when it has one — runs with the stored colour (0x0096dd80), on every
 *   call, changed or not: OpenColorPicker relies on that («This must come last, since it triggers a
 *   call to ColorPickerFrame.func()»). It answers nothing.
 * * `GetColorRGB` (0x009710d0): the stored colour, each channel byte / 255.
 * * widgets9 (15.11, .runtime/re-2026-11-15/widgets9/d1.c, d5.c): the client keeps the colour as three floats
 *   h, s, v (+0x2b0), which a new ColorSelect (0x0096df30) sets to 0, 0, 1 — white. SetColorRGB turns its bytes
 *   into floats (0x00982970: byte × the float 1/255) and those into HSV (0x00984f60: v the largest channel,
 *   s = (max − min) / max or 0, h in degrees from the largest channel, +360 when negative, and −1 for a grey);
 *   GetColorRGB and the OnColorSelect arguments go back through 0x00985030 (h ≥ 360 wraps once, sector
 *   round(h / 60 − 0.5) capped at 5, s capped at 1, the usual six sectors; s = 0 is grey v) and 0x009851a0
 *   (each channel rounded to a byte, ties to even). `SetColorHSV(h, s, v)` (0x00970f50) stores the three numbers
 *   as they come and runs OnColorSelect (0x0096e3d0 → 0x0096dd80); `GetColorHSV` (0x00970fd0) answers them.
 *   WCollections' wardrobe colour picker (Blizzard_Wardrobe.xml:1346-1366) reads and writes them.
 * * `UpdateColorByID(id, r, g, b)` (0x00973590 → 0x0096a6e0): all four must be numbers, otherwise
 *   nothing happens; id 0 changes nothing; every line added with that id (AddMessage's fifth
 *   argument) takes the clamped colour; the others keep theirs.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { WidgetMethod } from "./GlueWidgets.js";

type Rgb = readonly [number, number, number];

/** Clamp as 0x00960420 does: below 0 or not a number → 0, 1 and above → 1. */
function unit(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!(number >= 0)) return 0;
  return number >= 1 ? 1 : number;
}

/** One channel as the client packs it (0x0048bd20): a float, × 255 + 0.5, whole part. */
function toByte(value: number): number {
  return Math.floor(Math.fround(value) * 255 + 0.5);
}

/** Lua's `type(x) == "number"` for a binding argument (lua_isnumber also takes numeric strings). */
function isLuaNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** The float at 0x00a45564 (u32 0x3b808081) 0x00982970 scales a byte by. */
const BYTE_UNIT = Math.fround(1 / 255);
/** A new ColorSelect's h, s, v (0x0096df30): white. */
const DEFAULT_HSV: Rgb = [0, 0, 1];

/** Round half to even, as the FPU's default mode rounds in 0x00985030 and 0x009851a0. */
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 0x00984f60: three 0..1 floats to h (degrees, −1 for a grey), s, v, each kept as a float. */
export function colorSelectHsvFromRgb(rgb: Rgb): Rgb {
  const max = rgb.indexOf(Math.max(...rgb));
  const min = rgb.indexOf(Math.min(...rgb));
  const v = rgb[max]!;
  const s = v !== 0 ? Math.fround((v - rgb[min]!) / v) : 0;
  if (s === 0) return [-1, s, Math.fround(v)];
  const delta = v - rgb[min]!;
  const [r, g, b] = rgb;
  let h = max === 0 ? (g - b) / delta : max === 1 ? (b - r) / delta + 2 : (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [Math.fround(h), s, Math.fround(v)];
}

/** 0x00985030: h, s, v to three floats; a negative sector leaves black, as the switch there does. */
export function colorSelectRgbFromHsv(hsv: Rgb): Rgb {
  const [hue, saturation, value] = hsv;
  if (saturation === 0) return [value, value, value];
  const h = hue >= 360 ? hue - 360 : hue;
  const sector = Math.min(5, roundEven(h * Math.fround(1 / 60) - 0.5));
  const f = h * Math.fround(1 / 60) - sector;
  const s = saturation >= 1 ? 1 : saturation;
  const p = Math.fround((1 - s) * value);
  const q = Math.fround((1 - s * f) * value);
  const t = Math.fround((1 - (1 - f) * s) * value);
  switch (sector) {
    case 0: return [value, t, p];
    case 1: return [q, value, p];
    case 2: return [p, value, t];
    case 3: return [p, q, value];
    case 4: return [t, p, value];
    case 5: return [value, p, q];
    default: return [0, 0, 0];
  }
}

export function colorSelectMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  const colors = new WeakMap<FrameXmlFrame, Rgb>();
  // GetColorRGB and the OnColorSelect arguments: 0x009851a0's bytes times 1/255 (the double at 0x009ece88).
  const read = (frame: FrameXmlFrame): readonly [number, number, number] => {
    const rgb = colorSelectRgbFromHsv(colors.get(frame) ?? DEFAULT_HSV);
    return [rgb[0], rgb[1], rgb[2]].map((channel) => (roundEven(channel * 255) & 0xff) / 255) as unknown as Rgb;
  };
  return {
    SetColorRGB: ({ frame, args }) => {
      const bytes = [toByte(unit(args[0])), toByte(unit(args[1])), toByte(unit(args[2]))];
      colors.set(frame, colorSelectHsvFromRgb(bytes.map((byte) => Math.fround(byte * BYTE_UNIT)) as unknown as Rgb));
      bridge.fireScript(frame, "OnColorSelect", ...read(frame));
    },
    GetColorRGB: ({ frame }) => read(frame),
    SetColorHSV: ({ frame, args }) => {
      const float = (value: unknown): number => Math.fround(typeof value === "number" ? value : Number(value) || 0);
      colors.set(frame, [float(args[0]), float(args[1]), float(args[2])]);
      bridge.fireScript(frame, "OnColorSelect", ...read(frame));
    },
    GetColorHSV: ({ frame }) => [...(colors.get(frame) ?? DEFAULT_HSV)],
  };
}

export function messageColorMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    UpdateColorByID: ({ frame, self, args }) => {
      if (!args.slice(0, 4).every(isLuaNumber) || args.length < 4) return;
      const id = Math.trunc(Number(args[0]));
      if (id === 0) return;
      const matches = (lineID: unknown): boolean =>
        isLuaNumber(lineID) && Math.trunc(Number(lineID)) === id;
      if (!self.messageFrame.messages.some((message) => matches(message.lineID))) return;
      const color = { r: unit(args[1]), g: unit(args[2]), b: unit(args[3]), a: 1 };
      bridge.update(frame, (mutable) => {
        const state = mutable.messageFrame;
        state.messages = state.messages.map((message) => matches(message.lineID) ? { ...message, color } : message);
        state.revision += 1;
      }, "paint");
    },
  };
}
