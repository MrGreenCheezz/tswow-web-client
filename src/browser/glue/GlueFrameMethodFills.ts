/**
 * widgets5 (15.11): widget methods Wow.exe 3.3.5a (12340) registers that this client did not answer at all —
 * the census of .runtime/re-2026-11-15/widgets5 (census.mjs over the client's own {name, function} tables) —
 * whose behaviour is read (.runtime/re-2026-11-15/widgets5/g1.c … g4.c; read-only Ghidra, behaviour described,
 * no code copied). Ace3's AceGUI frame calls SetMinResize/SetMaxResize on creation; without them it stops there.
 *
 * Frame (table 0x00ac1550):
 * * `SetMinResize(w, h)` (0x004a0520) / `SetMaxResize(w, h)` (0x004a06e0): both arguments must be numbers
 *   (`lua_isnumber`), else «Usage: <name>:SetMinResize(minWidth, minHeight)» / «…SetMaxResize(maxWidth,
 *   maxHeight)». The pair is kept as floats (layout units, converted back by the getters), the other pair is
 *   left as it was. `GetMinResize` (0x004a0480) / `GetMaxResize` (0x004a0640) answer the pair; a frame that never
 *   set one answers 0, 0 (the layout frame's constructor 0x00489980, run by 0x00488310 at +0x20, zeroes them).
 *   Nothing here sizes a frame (StartSizing is not answered), so the bounds are kept and read by nothing else.
 * * `SetDontSavePosition(flag)` (0x004a08c0): bit 0x80000 of +0xb4 from 0x00815500 with default 1 (no argument
 *   sets it, nil clears it); `GetDontSavePosition` (0x004a0910): 1 or nil. The constructor (0x004922f0) clears it.
 * * `EnableJoystick(flag)` (0x004a11d0): bit 0x10 of +0xd8 from 0x00815500 with default 1 — in the client only
 *   when 0x00488540 lets the call through (a protected frame from tainted code is refused; this client keeps no
 *   taint, see 3.48); `IsJoystickEnabled` (0x004a1260): 1 or nil. No joystick reaches a frame here.
 * * `IsIgnoringDepth` (0x004a1e00): 1 when IgnoreDepth(true) is in force (+0xcc), else nil.
 * Region (table 0x00ac1480):
 * * `GetRect` (0x0049ce50): left, bottom, width, height of a laid-out frame (the same rectangle GetLeft/GetBottom
 *   answer); nothing for a frame without a rectangle — here every frame has one.
 * FontString (table 0x00ac1118):
 * * `GetFieldSize` (0x0048bc70): the constant 8191.0 (0x009ead70, a double).
 * * `SetText` (0x0048d780) and `SetFormattedText` (0x0048d800) raise «<name>:SetText(): Font not set» /
 *   «<name>:SetFormattedText(): Font not set» before touching the text when the string has no font face (+0xe8).
 *   The face is set only by a font that loads: SetFont (0x0048d5b0 → 0x00483750, which leaves the old face when
 *   the file fails) or a font object (0x0048d380 → 0x00485160); SetFontObject(nil) does not take it away. Here a
 *   FontString is taken as faceless only in the one case the model is certain of: made by Lua's CreateFontString
 *   without a template and given neither SetFont nor SetFontObject since. A font file that fails to load and a font
 *   object without a font are not modelled, so those raise nothing here (a missed error, never a false one).
 * Texture (table 0x00ac1028):
 * * `SetNonBlocking(flag)` (0x0048caa0): bit 0 of +0x160 from 0x00815500 with default 1; `GetNonBlocking`
 *   (0x0048cb00): 1 or nil. The flag only says whether the client may draw before the file has loaded.
 * * `SetDesaturated(flag)` (0x0048c9a0): the flag from 0x00815500 with default 1, answering 1 while the shader
 *   exists (it always does here); `IsDesaturated` (0x0048ca30): 1 while the desaturating shader is the texture's.
 * * `SetBlendMode(mode)` (0x0048c040): a string naming one of the five modes of the table at 0x00a43fe8 —
 *   DISABLE, BLEND, ALPHAKEY, ADD, MOD — else «Usage: <name>:SetBlendMode("mode")»; `GetBlendMode` (0x0048bff0)
 *   names the mode back. The name is matched as the client's other enum lookups do (case-insensitive, 0x0076e780).
 *
 * Unsettled: a string flag argument (0x00815400 parses it; not read) is taken as false.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { plainFrameXmlText } from "../ui/framexml_compat/FrameXmlText.js";
import { frameXmlIgnoresDepth } from "./GlueWidgetMethodFills.js";
import { GlueLuaRaise } from "./GlueLua.js";
import type { WidgetMethod } from "./GlueWidgets.js";

/** The name an error names (the client's `<unnamed>` when there is none; an invented name is none). */
function nameOf(frame: FrameXmlFrame): string {
  return frame.named !== false && frame.name ? frame.name : "<unnamed>";
}

/** Lua's `lua_isnumber` for a binding argument: a number or a numeric string. */
function isLuaNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isNaN(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** 0x00815500(L, 2, fallback): no argument → fallback, nil → false, boolean as is, number when not 0. */
function flagArgument(args: readonly unknown[], fallback: boolean): boolean {
  if (args.length === 0) return fallback;
  const value = args[0];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  return false;
}

interface ResizeBounds { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number }
const resizeBounds = new WeakMap<FrameXmlFrame, ResizeBounds>();
const dontSavePosition = new WeakMap<FrameXmlFrame, boolean>();
const joystickEnabled = new WeakMap<FrameXmlFrame, boolean>();

function boundsOf(frame: FrameXmlFrame): ResizeBounds {
  let bounds = resizeBounds.get(frame);
  if (!bounds) {
    bounds = { minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0 };
    resizeBounds.set(frame, bounds);
  }
  return bounds;
}

/** A frame's resize bounds as SetMinResize/SetMaxResize left them (0, 0 each when never set). */
export function glueFrameResizeBounds(frame: FrameXmlFrame): Readonly<ResizeBounds> {
  return resizeBounds.get(frame) ?? { minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0 };
}

export function frameFillMethods(): Record<string, WidgetMethod> {
  const setter = (min: boolean): WidgetMethod => ({ frame, args }) => {
    if (!isLuaNumber(args[0]) || !isLuaNumber(args[1])) {
      throw new GlueLuaRaise(min
        ? `Usage: ${nameOf(frame)}:SetMinResize(minWidth, minHeight)`
        : `Usage: ${nameOf(frame)}:SetMaxResize(maxWidth, maxHeight)`);
    }
    const width = Math.fround(Number(args[0]));
    const height = Math.fround(Number(args[1]));
    const bounds = boundsOf(frame);
    if (min) { bounds.minWidth = width; bounds.minHeight = height; } else { bounds.maxWidth = width; bounds.maxHeight = height; }
  };
  return {
    SetMinResize: setter(true),
    SetMaxResize: setter(false),
    GetMinResize: ({ frame }) => {
      const bounds = glueFrameResizeBounds(frame);
      return [bounds.minWidth, bounds.minHeight];
    },
    GetMaxResize: ({ frame }) => {
      const bounds = glueFrameResizeBounds(frame);
      return [bounds.maxWidth, bounds.maxHeight];
    },
    SetDontSavePosition: ({ frame, args }) => { dontSavePosition.set(frame, flagArgument(args, true)); },
    GetDontSavePosition: ({ frame }) => (dontSavePosition.get(frame) === true ? [1] : [undefined]),
    EnableJoystick: ({ frame, args }) => { joystickEnabled.set(frame, flagArgument(args, true)); },
    IsJoystickEnabled: ({ frame }) => (joystickEnabled.get(frame) === true ? [1] : [undefined]),
    IsIgnoringDepth: ({ frame }) => (frameXmlIgnoresDepth(frame) ? [1] : [undefined]),
  };
}

export function regionRectMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    GetRect: ({ frame }) => {
      const rect = bridge.geometry(frame);
      return [rect.left, rect.bottom, rect.width, rect.height];
    },
  };
}

/** FontStrings Lua made without a template that have had no SetFont or SetFontObject since: no face. */
const faceless = new WeakSet<FrameXmlFrame>();

/** CreateFontString's hook: a string made without a template starts without a font face. */
export function glueNoteCreatedFontString(child: unknown, template: string | undefined): void {
  if (template !== undefined && template.trim() !== "") return;
  if (child && typeof child === "object" && (child as FrameXmlFrame).type === "FontString") {
    faceless.add(child as FrameXmlFrame);
  }
}

/**
 * Whether a FontString is certainly without a font face (see the header). A Button hands its string a face too
 * (tests7, 15.11): SetFontString (0x009777c0 → 0x0096f7b0) and Set{Normal,Highlight,Disabled}FontObject
 * (0x00977340 …) end in 0x0096f4a0, which gives the button's FontString (+0x2ac) the current state's font object
 * through 0x00485160 — the setter SetFontObject uses. This client models that as the label's `fontObject`
 * (FrameXmlRuntime.syncButtonLabelFont), so a string that has one is not faceless. MSBTOptionsControls.lua:863-865
 * builds its option buttons from a template-less CreateFontString that way.
 */
export function glueFontStringFaceless(frame: FrameXmlFrame): boolean {
  return faceless.has(frame) && !frame.fontObject;
}

/**
 * The FontString's own SetText/SetFormattedText/SetFont/SetFontObject over the shared text methods `text`:
 * the face check first, then the shared method.
 */
export function fontStringFaceMethods(text: Readonly<Record<string, WidgetMethod>>): Record<string, WidgetMethod> {
  const checked = (method: string): WidgetMethod => {
    const inner = text[method];
    return (context) => {
      if (glueFontStringFaceless(context.frame)) throw new GlueLuaRaise(`${nameOf(context.frame)}:${method}(): Font not set`);
      return inner?.(context);
    };
  };
  const giving = (method: string): WidgetMethod => {
    const inner = text[method];
    return (context) => {
      const answer = inner?.(context);
      // SetFont that took the font (it answers 1), or any SetFontObject given a font object or its name.
      if (method === "SetFont" ? Array.isArray(answer) && answer[0] === true : context.args[0] !== undefined && context.args[0] !== null) {
        faceless.delete(context.frame);
      }
      return answer;
    };
  };
  return {
    SetText: checked("SetText"),
    SetFormattedText: checked("SetFormattedText"),
    SetFont: giving("SetFont"),
    SetFontObject: giving("SetFontObject"),
    GetFieldSize: () => [8191],
  };
}

/**
 * Batch 2 (15.11, notes g1.c, g5.c):
 * * `IsProtected` (0x0049cad0) answers two values — protected (0x00489bb0) and explicitly protected (+0x60 bit
 *   0x10000) — each 1 or nil; `CanChangeProtectedState` (0x0049cb60) answers nil only for a protected frame while
 *   the lockdown word (+0x124c of the frame manager) is clear, else 1; `CanChangeAttribute` (0x0049f260) answers 1
 *   when 0x00488540 lets the caller through (untainted code always) and `AllowAttributeChanges` (0x0049f210) only
 *   sets the manager's permission (0x0048ecf0). This client has no taint and no protected frames (see 3.48), so
 *   these answer what the original answers for an unprotected frame out of combat: nil, nil / 1 / 1 — constants
 *   for want of the model, not a rule of their own.
 * * `GetEffectiveAlpha` (0x0049f900): the frame's alpha byte (+0xbc) times the byte its parent handed down (+0xbd,
 *   255 at the root, 0x004922f0), integer-divided by 255, times 1/255. SetAlpha (0x0048c3e0) keeps
 *   round(clamp(alpha, 0, 1) × 255) under the FPU's default rounding (to nearest, ties even).
 * * `SetDepth(depth)` (0x004a1c40): a number, else «Usage: <name>:SetDepth(additiveDepth)»; kept (+0xc4, 0x0048f5d0)
 *   and answered by `GetDepth` (0x004a1cc0) — no depth is drawn here. GetEffectiveDepth (+0xc8 handed down by the
 *   virtual +0xd8, not read) is not answered.
 * EditBox (table 0x00b2d210; flags +0x2a0):
 * * `SetMultiLine(flag)` (0x00975b30: 0x00815500 default 1 → 0x00965f20) / `IsMultiLine` (0x00975b80, bit 2);
 *   `IsNumeric` (0x00975c30, bit 4); `IsPassword` (0x00975ce0, bit 8) — 1 or nil, from the same state the XML
 *   `multiLine`/`numeric`/`password` attributes and SetNumeric/SetPassword write.
 * * `GetNumLetters` (0x009766a0): a password box counts its text's UTF-8 characters (0x0076eea0); any other box
 *   counts its laid-out characters of kinds 0, 3 and 4 (0x00962ea0) — taken here as the text the box shows, escape
 *   sequences out (`plainFrameXmlText`); which kinds the markup gets is inferred, not read.
 */
const depths = new WeakMap<FrameXmlFrame, number>();

/** SetAlpha's byte (0x0048c3e0): clamp, × 255, rounded to nearest with ties to even. */
function alphaByte(alpha: number): number {
  const scaled = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1)) * 255;
  const floor = Math.floor(scaled);
  const rest = scaled - floor;
  return rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
}

/** The byte a frame hands its children: its own byte times its parent's, integer-divided by 255. */
function effectiveAlphaByte(frame: FrameXmlFrame): number {
  const own = alphaByte(frame.alpha);
  return frame.parent ? Math.floor((own * effectiveAlphaByte(frame.parent)) / 255) : own;
}

export function frameProtectionMethods(): Record<string, WidgetMethod> {
  return {
    IsProtected: () => [undefined, undefined],
    CanChangeProtectedState: () => [1],
    CanChangeAttribute: () => [1],
    AllowAttributeChanges: () => {},
    GetEffectiveAlpha: ({ frame }) => [effectiveAlphaByte(frame) * (1 / 255)],
    SetDepth: ({ frame, args }) => {
      if (!isLuaNumber(args[0])) throw new GlueLuaRaise(`Usage: ${nameOf(frame)}:SetDepth(additiveDepth)`);
      depths.set(frame, Math.fround(Number(args[0])));
    },
    GetDepth: ({ frame }) => [depths.get(frame) ?? 0],
  };
}

export function editBoxFillMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    SetMultiLine: ({ frame, self, args }) => {
      const multiLine = flagArgument(args, true);
      if (self.editBox.multiLine !== multiLine) bridge.update(frame, (m) => { m.editBox.multiLine = multiLine; });
    },
    IsMultiLine: ({ self }) => (self.editBox.multiLine ? [1] : [undefined]),
    IsNumeric: ({ self }) => (self.editBox.numeric ? [1] : [undefined]),
    IsPassword: ({ self }) => (self.editBox.password ? [1] : [undefined]),
    GetNumLetters: ({ self }) => {
      if (self.editBox.password) {
        let count = 0;
        for (const byte of new TextEncoder().encode(self.text)) {
          if (byte === 0) break;
          if ((byte & 0xc0) !== 0x80) count += 1;
        }
        return [count];
      }
      return [Array.from(plainFrameXmlText(self.text)).length];
    },
  };
}

const nonBlocking = new WeakMap<FrameXmlFrame, boolean>();
const BLEND_MODES = ["DISABLE", "BLEND", "ALPHAKEY", "ADD", "MOD"] as const;

export function textureFillMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    SetNonBlocking: ({ frame, args }) => { nonBlocking.set(frame, flagArgument(args, true)); },
    GetNonBlocking: ({ frame }) => (nonBlocking.get(frame) === true ? [1] : [undefined]),
    SetDesaturated: ({ frame, self, args }) => {
      const desaturated = flagArgument(args, true);
      if (self.desaturated !== desaturated) bridge.update(frame, (m) => { m.desaturated = desaturated; }, "paint");
      return [1];
    },
    IsDesaturated: ({ self }) => (self.desaturated ? [1] : [undefined]),
    SetBlendMode: ({ frame, self, args }) => {
      const mode = typeof args[0] === "string" ? BLEND_MODES.find((name) => name === (args[0] as string).toUpperCase()) : undefined;
      if (mode === undefined) throw new GlueLuaRaise(`Usage: ${nameOf(frame)}:SetBlendMode("mode")`);
      if (self.alphaMode !== mode) bridge.update(frame, (m) => { m.alphaMode = mode; }, "paint");
    },
    GetBlendMode: ({ self }) => [(BLEND_MODES as readonly string[]).includes(self.alphaMode) ? self.alphaMode : "UNKNOWN"],
  };
}
