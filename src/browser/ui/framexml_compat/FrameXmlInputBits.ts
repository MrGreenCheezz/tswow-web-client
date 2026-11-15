/**
 * widgets9 (15.11, plan item 3.21): a frame's mouse and keyboard input bits as Wow.exe 3.3.5a (12340) keeps them
 * (read-only Ghidra, .runtime/re-2026-11-15/widgets9/d1.c … d6.c, widgets7/w1.c, w3.c; behaviour described, no code
 * copied).
 *
 * - The bits live in the frame's +0xd8 word: 0x4 the mouse, 0x1 and 0x2 the keyboard (0x0048f6a0 sets bit n,
 *   0x0048f6f0 clears it).
 * - Which constructor sets them: CreateFrame (0x0081bb20) builds an XML node and goes through the type factory
 *   (0x00813df0 names the create function of each type), so a Lua-made widget starts as its constructor leaves it.
 *   Button (0x00812870 → 0x00970520) — and CheckButton, whose constructor 0x009620e0 runs the Button's —, Slider
 *   (0x0096be50) and ColorSelect (0x0096df30) set the mouse bit; EditBox (0x00966b70) sets all three. Frame
 *   (0x004922f0) and the others set none. (widgets7 named 0x00970520 ColorSelect's; the factory shows it is the
 *   Button's — it also sets the Button's pushed text offset and click mask.) So a Lua-made Button takes the mouse
 *   from birth, without RegisterForClicks (0x009781d0 only writes the click mask) or a script.
 * - The XML attributes `enableMouse`/`enableKeyboard` and `EnableMouse(flag)` (0x004a0fd0, bit 2) /
 *   `EnableKeyboard(flag)` (0x004a0ec0, bits 1 and 0) override the constructor's choice; the flag is 0x00815500's
 *   (no argument → on, nil → off, a number → on unless 0).
 * - `IsMouseEnabled` (0x004a1060) answers 1 when bit 2 is set, else nil; `IsKeyboardEnabled` (0x004a0f60) 1 when
 *   bit 0 or bit 1 is set, else nil.
 *
 * Here the bits are the frame's `enableMouse`/`enableKeyboard` attributes when present, else the constructor's
 * default below — the same rule the DOM renderer's hit test reads, so the getter and the pointer agree.
 */
import type { FrameXmlFrame } from "./FrameXmlTypes.js";

/**
 * Types whose constructor sets the mouse bit. frame10 (15.11): WorldFrame's constructor (0x004fabd0, the factory
 * 0x0050f3f0 registered for the XML element `WorldFrame` by 0x00521040) runs 0x0048f6a0 for bits 1, 2 and 3: the
 * keyboard, the mouse and the wheel (`IsMouseWheelEnabled` 0x004a1160 reads bit 3).
 */
const MOUSE_BY_DEFAULT: ReadonlySet<string> = new Set(["Button", "CheckButton", "EditBox", "Slider", "ColorSelect", "WorldFrame"]);
/** Types whose constructor sets the keyboard bits. */
const KEYBOARD_BY_DEFAULT: ReadonlySet<string> = new Set(["EditBox", "WorldFrame"]);
/** Types whose constructor sets the wheel bit (bit 3). */
const WHEEL_BY_DEFAULT: ReadonlySet<string> = new Set(["WorldFrame"]);

function attribute(frame: FrameXmlFrame, name: string): string | undefined {
  return frame.attributes[name] ?? frame.attributes[name.toLowerCase()];
}

/** Whether the frame's mouse bit is set (the attribute when present, else the constructor's default). */
export function frameXmlMouseEnabled(frame: FrameXmlFrame): boolean {
  const value = attribute(frame, "enableMouse");
  return value === undefined ? MOUSE_BY_DEFAULT.has(frame.type) : /^(?:true|1)$/i.test(value);
}

/** Whether either keyboard bit is set. */
export function frameXmlKeyboardEnabled(frame: FrameXmlFrame): boolean {
  const value = attribute(frame, "enableKeyboard");
  return value === undefined ? KEYBOARD_BY_DEFAULT.has(frame.type) : /^(?:true|1)$/i.test(value);
}

/** Whether the type's constructor gives it the mouse (the renderer's default for a frame without the attribute). */
export function frameXmlTypeTakesMouse(type: string): boolean {
  return MOUSE_BY_DEFAULT.has(type);
}

/** Whether the type's constructor sets the wheel bit (`IsMouseWheelEnabled` without an `enableMouseWheel` of its own). */
export function frameXmlTypeTakesWheel(type: string): boolean {
  return WHEEL_BY_DEFAULT.has(type);
}

/**
 * frame10 (15.11): the frame the 3D world is drawn in. Its own box is the world canvas underneath the page, so its
 * element never takes the pointer, whatever its mouse bit says: the world's input layer keeps every click, and
 * FrameXmlWorldFrame.ts runs the frame's mouse scripts from there.
 */
export function frameXmlIsWorldSurface(frame: FrameXmlFrame): boolean {
  return frame.type === "WorldFrame";
}

/** 0x00815500(L, 2, 1): no argument → true, nil → false, a boolean as is, a number when not 0, anything else false. */
export function frameXmlFlagArgument(args: readonly unknown[], fallback: boolean): boolean {
  if (args.length === 0) return fallback;
  const value = args[0];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  return false;
}
