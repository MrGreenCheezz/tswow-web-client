/**
 * 3.27 (13.10): the Slider's own Lua methods as Wow.exe 3.3.5a 12340 registers them (table 0x00b2ce48…; notes
 * .runtime/re-2026-10-04/l5b-review/s1.c, re-2026-10-11/glue-1110/1013-q1.txt) over the rules of
 * FrameXmlSlider.ts. A StatusBar keeps the shared value methods (its SetMinMaxValues is 0x009713c0, other rules).
 *
 * - `SetMinMaxValues(min, max)` (0x00971df0): both `lua_isnumber` and (float)min ≤ max, else «Usage:
 *   <name>:SetMinMaxValues(min, max)» (`<unnamed>` without a name).
 * - `SetValue(value)` (0x00971f00): a number, else «Usage: <name>:SetValue(value)» — nil excepted here (below).
 * - `SetValueStep(value)` (0x00971fd0): a number, else «Usage: <name>:SetValueStep(value)».
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { WidgetMethod } from "./GlueWidgets.js";

/** `lua_isnumber`: a number or a numeric string; then `lua_tonumber`. */
function luaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value.trim());
  return Number.isNaN(number) ? undefined : number;
}

/** The name the error names: GetName's, or the client's `<unnamed>` (an anonymous frame's own name is internal). */
const nameOf = (frame: FrameXmlFrame): string => (frame.named && frame.name ? frame.name : "<unnamed>");

export function sliderValueMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    SetMinMaxValues: ({ frame, args }) => {
      const min = luaNumber(args[0]);
      const max = luaNumber(args[1]);
      if (min === undefined || max === undefined || !(Math.fround(min) <= max)) {
        throw new Error(`Usage: ${nameOf(frame)}:SetMinMaxValues(min, max)`);
      }
      bridge.SetSliderMinMax(frame, min, max);
    },
    SetValue: ({ frame, args }) => {
      // Deviation: nil stays the old 0. The stock option panels pass the value of 13 CVars this client leaves
      // unanswered (the unavailable video and sound controls, FrameXmlOptions.ts FRAMEXML_OPTIONS_UNAVAILABLE:
      // farclip, particleDensity, Sound_NumChannels…) — in Wow.exe those CVars exist and the call never sees nil.
      const value = args[0] === undefined || args[0] === null ? 0 : luaNumber(args[0]);
      if (value === undefined) throw new Error(`Usage: ${nameOf(frame)}:SetValue(value)`);
      bridge.SetValue(frame, value);
    },
    SetValueStep: ({ frame, args }) => {
      const step = luaNumber(args[0]);
      if (step === undefined) throw new Error(`Usage: ${nameOf(frame)}:SetValueStep(value)`);
      bridge.SetSliderStep(frame, step);
    },
  };
}
