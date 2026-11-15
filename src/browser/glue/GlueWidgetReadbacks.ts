/**
 * widgets9 (15.11, plan item 3.21): widget methods real code calls that this client did not answer, read from
 * Wow.exe 3.3.5a (12340) (read-only Ghidra, .runtime/re-2026-11-15/widgets9/d1.c … d7.c, l2.lst; widgets5/g1.c,
 * g2.c; widgets7/w1.c; behaviour described, no code copied). Callers: WCollections' Util.lua:8 (GetTexCoord),
 * WCollections.xml:431-440 (Set/GetPushedTextOffset), Blizzard_DebugTools.lua:225 (RegisterAllEvents, `/etrace`).
 *
 * Texture (table 0x00ac1028):
 * * `GetTexCoord()` (0x0048c7f0): the eight corner coordinates (+0x140…+0x15c) as ULx, ULy, LLx, LLy, URx, URy,
 *   LRx, LRy. A new texture (0x00484470) holds 0, 0, 0, 1, 1, 0, 1, 1; SetTexCoord's four-number form
 *   (0x0048e170 → 0x004831d0) writes (minX, minY), (minX, maxY), (maxX, minY), (maxX, maxY) and the eight-number
 *   form (→ 0x00481640) the eight as given. Texture:SetRotation (0x0048c860) also writes the corners in Wow.exe;
 *   here the rotation is kept apart, so GetTexCoord after SetRotation answers the coordinates before it.
 * Button (table 0x00b2d418):
 * * `SetPushedTextOffset(x, y)` (0x00977f60) / `GetPushedTextOffset()` (0x00978040): FrameXmlPushedTextOffset.ts.
 * Frame (table 0x00ac1550):
 * * `EnableMouse` / `EnableKeyboard` / `IsMouseEnabled` / `IsKeyboardEnabled`: FrameXmlInputBits.ts.
 * * `RegisterAllEvents()` (0x0049f0e0): FrameXmlRuntime's `#allEvents`.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame, FrameXmlTexCoords } from "../ui/framexml_compat/FrameXmlTypes.js";
import { frameXmlFlagArgument, frameXmlKeyboardEnabled, frameXmlMouseEnabled } from "../ui/framexml_compat/FrameXmlInputBits.js";
import { frameXmlPushedTextOffset, frameXmlSetPushedTextOffset } from "../ui/framexml_compat/FrameXmlPushedTextOffset.js";
import { GlueLuaRaise } from "./GlueLua.js";
import type { WidgetMethod } from "./GlueWidgets.js";

/** A new texture's corners (0x00484470). */
const DEFAULT_CORNERS = [0, 0, 0, 1, 1, 0, 1, 1] as const;

function nameOf(frame: FrameXmlFrame): string {
  return frame.named !== false && frame.name ? frame.name : "<unnamed>";
}

/** Lua's `lua_isnumber` for a binding argument: a number or a numeric string. */
function isLuaNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isNaN(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** The eight corner coordinates a texture holds, as GetTexCoord answers them (each a float). */
export function glueTextureCorners(coords: FrameXmlTexCoords | undefined): readonly number[] {
  if (!coords) return DEFAULT_CORNERS;
  const corners = coords.corners ?? [coords.left, coords.top, coords.left, coords.bottom,
    coords.right, coords.top, coords.right, coords.bottom];
  return corners.map((value) => Math.fround(value));
}

export function textureReadbackMethods(): Record<string, WidgetMethod> {
  return {
    GetTexCoord: ({ self }) => [...glueTextureCorners(self.texCoords)],
  };
}

export function buttonOffsetMethods(aspect: () => number): Record<string, WidgetMethod> {
  return {
    SetPushedTextOffset: ({ frame, args }) => {
      if (!isLuaNumber(args[0]) || !isLuaNumber(args[1])) {
        throw new GlueLuaRaise(`Usage: ${nameOf(frame)}:SetPushedTextOffset(x, y)`);
      }
      frameXmlSetPushedTextOffset(frame, Number(args[0]), Number(args[1]), aspect());
    },
    GetPushedTextOffset: ({ frame }) => [...frameXmlPushedTextOffset(frame, aspect())],
  };
}

export function frameInputMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    EnableMouse: ({ frame, args }) => {
      const on = frameXmlFlagArgument(args, true);
      bridge.update(frame, (m) => m.setAttribute("enableMouse", on ? "true" : "false"));
    },
    EnableKeyboard: ({ frame, args }) => {
      const on = frameXmlFlagArgument(args, true);
      bridge.update(frame, (m) => m.setAttribute("enableKeyboard", on ? "true" : "false"));
    },
    IsMouseEnabled: ({ frame }) => (frameXmlMouseEnabled(frame) ? [1] : [undefined]),
    IsKeyboardEnabled: ({ frame }) => (frameXmlKeyboardEnabled(frame) ? [1] : [undefined]),
    RegisterAllEvents: ({ frame }) => { bridge.RegisterAllEvents(frame); },
  };
}
