/**
 * 3.27 (13.10): a Slider's range, step and value as Wow.exe 3.3.5a 12340 keeps them (CSimpleSlider; notes
 * .runtime/re-2026-10-03/l334/r3.c, re-2026-10-04/l5b-review/s1.c, re-2026-10-11/glue-1110/1013-q1.txt).
 *
 * - Everything is a 32-bit float: the minimum (+0x2a0), the range (+0x2a4, max − min), the step (+0x2ac) and
 *   the value (+0x2a8). `GetValue`, `GetMinMaxValues` (min, min + range) and the scripts read them back as such
 *   (`SetValue(0.1)` reads 0.10000000149011612).
 * - `SetMinMaxValues(min, max)` (Lua 0x00971df0): two numbers with min ≤ max, else «Usage: <name>:SetMinMaxValues(min,
 *   max)». Then 0x0096c470: when no range was set yet, or the range or the minimum moved by 2^-22 (0x009ea27c) or
 *   more — the range, OnMinMaxChanged(self, min, min + range) (0x0096bbb0), and when a value was set, that value
 *   again through SetValue.
 * - `SetValue(value)` (Lua 0x00971f00, a number else «Usage: <name>:SetValue(value)»; the thumb's drag 0x0096c320
 *   too) → 0x0096c090: nothing at all before a range is set; else clamped to the range, put on the step (0x0096bc10:
 *   (v − min) / step rounded half away from zero, times the step, plus min; a step of 0 leaves it), then the maximum
 *   when one step more would pass it and the minimum when one step less would; it is written — and OnValueChanged
 *   (self, value) runs — the first time, and after that only when it moved by 2^-22 or more.
 * - `SetValueStep(step)` (Lua 0x00971fd0, a number else «Usage: <name>:SetValueStep(value)») → 0x0096c1b0: at
 *   least FLT_EPSILON (0x009ea624); when it moved by 2^-22 or more, and a value was set, that value again.
 * - The XML loader (0x0096c500): `valueStep`, else 0.001 (0x009e1134), at least FLT_EPSILON; a range only from
 *   `minValue` with `maxValue`; a value only from `defaultValue` (through SetValue). A Slider made by CreateFrame
 *   without a template is not loaded: step 0, no range, value 0 (constructor 0x0096be50).
 */
import type { FrameXmlElement } from "./FrameXmlTypes.js";

/** 0x009ea27c: two floats closer than this are the same. */
export const FRAMEXML_SLIDER_TINY = 2.384185791015625e-7;
/** 0x009ea624: FLT_EPSILON, the least step. */
export const FRAMEXML_SLIDER_MIN_STEP = 1.1920928955078125e-7;
/** 0x009e1134: the XML loader's step when `valueStep` is absent (0.001 as a float). */
export const FRAMEXML_SLIDER_XML_STEP = Math.fround(0.001);

/** The slider fields these rules read and write (FrameXmlTypes `slider`). */
export interface FrameXmlSliderState {
  min: number;
  max: number;
  value: number;
  valueStep: number;
  rangeSet?: boolean;
  valueSet?: boolean;
}

/** +0x2a4, the float range as set (min + range is `max`). */
const ranges = new WeakMap<FrameXmlSliderState, number>();

/** 0x0096bc10: the value on the step from the minimum, half away from zero; a step of 0 leaves it. */
export function frameXmlSliderOnStep(value: number, min: number, step: number): number {
  if (step === 0) return value;
  const offset = value - min;
  const steps = Math.trunc(offset > 0 ? (offset + step * 0.5) / step : (offset - step * 0.5) / step);
  return steps * step + min;
}

/**
 * 0x0096c090: the value SetValue writes, or undefined when it writes nothing (no range yet, or within 2^-22 of a
 * value already set). The caller writes it, marks it set and runs OnValueChanged.
 */
export function frameXmlSliderValue(state: FrameXmlSliderState, value: number): number | undefined {
  if (!state.rangeSet) return undefined;
  const { min, max, valueStep: step } = state;
  // The client's two comparisons, NaN included (it lands on the maximum).
  const clamped = (value < min ? min : value) <= max ? (value < min ? min : value) : max;
  let next = frameXmlSliderOnStep(clamped, min, step);
  if (max < next + step) next = max;
  if (next - step < min) next = min;
  next = Math.fround(next);
  if (state.valueSet && !(Math.abs(next - state.value) >= FRAMEXML_SLIDER_TINY)) return undefined;
  return next;
}

/** 0x0096c470: whether `SetMinMaxValues(min, max)` sets a range (then written here); the caller signals. */
export function frameXmlSliderSetRange(state: FrameXmlSliderState, min: number, max: number): boolean {
  const low = Math.fround(min);
  const range = Math.fround(Math.fround(max) - low);
  const known = ranges.get(state) ?? Math.fround(state.max - state.min);
  if (state.rangeSet && !(Math.abs(range - known) >= FRAMEXML_SLIDER_TINY)
    && !(Math.abs(state.min - low) >= FRAMEXML_SLIDER_TINY)) return false;
  state.min = low;
  state.max = Math.fround(range + low);
  ranges.set(state, range);
  state.rangeSet = true;
  return true;
}

/** 0x0096c1b0: whether `SetValueStep(step)` changes the step (then written here). */
export function frameXmlSliderSetStep(state: FrameXmlSliderState, step: number): boolean {
  const next = Math.fround(step < FRAMEXML_SLIDER_MIN_STEP ? FRAMEXML_SLIDER_MIN_STEP : step);
  if (!(Math.abs(next - state.valueStep) >= FRAMEXML_SLIDER_TINY)) return false;
  state.valueStep = next;
  return true;
}

/** Elements CreateFrame made for a Slider without a template: the XML loader never sees them. */
const bareElements = new WeakSet<FrameXmlElement>();

export function markFrameXmlBareCreate(element: FrameXmlElement): void {
  bareElements.add(element);
}

/** The XML loader's step (0x0096c500): `valueStep`, else 0.001, at least FLT_EPSILON; 0 for a bare CreateFrame. */
export function frameXmlSliderLoadedStep(element: FrameXmlElement, declared: number | undefined): number {
  if (declared === undefined && bareElements.has(element)) return 0;
  const step = declared ?? FRAMEXML_SLIDER_XML_STEP;
  return Math.fround(step < FRAMEXML_SLIDER_MIN_STEP ? FRAMEXML_SLIDER_MIN_STEP : step);
}
