/**
 * 3.21 (widgets7, 15.11): `GameTooltip:AddFontStrings(left, right)` as Wow.exe 3.3.5a (12340) answers it (0x006201f0
 * → 0x0061fe30; read-only Ghidra, notes .runtime/re-2026-11-15/widgets7/w1.c, w3.c):
 *
 * - Each of the two arguments in turn must be a table, else «Usage: <name>:AddFontStrings(leftstring,
 *   rightstring)»; the table's [0] must hold a widget, else «<name>:AddFontStrings(): Couldn't find 'this' in
 *   fontstring»; and that widget must be a FontString, else «<name>:AddFontStrings(): Wrong object type, expected
 *   fontstring». `<name>` is the tooltip's (`<unnamed>` without one).
 * - Then the tooltip's line count (+0x2a8) goes up by one, its line arrays grow, and the pair becomes that new last
 *   line's left and right strings (+0x2b4, +0x2c0), with the line's flag word (+0x2cc) cleared. Nothing is answered.
 *
 * WCollections calls it on a parentless scanning tooltip before SetHyperlink (WCollections.lua:5525, :6499). Here
 * the tooltip's lines are found by their `<name>TextLeft<i>` names (GlueWidgets' line cache), so an added pair is
 * kept per tooltip and laid over that row; a pair whose strings belong to another frame is kept but not drawn as a
 * line (Wow.exe would draw it wherever it lives).
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { GlueLuaRaise, GlueLuaRef } from "./GlueLua.js";
import type { WidgetMethod } from "./GlueWidgets.js";

export interface GlueTooltipAddedLine {
  readonly left: FrameXmlFrame;
  readonly right: FrameXmlFrame;
}

const added = new WeakMap<FrameXmlFrame, Map<number, GlueTooltipAddedLine>>();

/** The rows AddFontStrings made on a tooltip, by 1-based line index; undefined when none. */
export function glueTooltipAddedLines(frame: FrameXmlFrame): ReadonlyMap<number, GlueTooltipAddedLine> | undefined {
  return added.get(frame);
}

function nameOf(frame: FrameXmlFrame): string {
  return frame.named !== false && frame.name ? frame.name : "<unnamed>";
}

/** `lineCount(tooltip)`: the tooltip's current number of lines (the highest row it has). */
export function tooltipFontStringMethods(
  bridge: FrameXmlUiBridge, lineCount: (tooltip: FrameXmlFrame) => number,
): Record<string, WidgetMethod> {
  const fontStringOf = (tooltip: FrameXmlFrame, value: unknown): FrameXmlFrame => {
    // A widget reaches a binding as its handle; any other Lua table as a reference.
    const widget = value !== null && typeof value === "object" && !(value instanceof GlueLuaRef)
      ? bridge.resolve(value as FrameXmlFrame) : undefined;
    if (!widget) {
      if (value instanceof GlueLuaRef) throw new GlueLuaRaise(`${nameOf(tooltip)}:AddFontStrings(): Couldn't find 'this' in fontstring`);
      throw new GlueLuaRaise(`Usage: ${nameOf(tooltip)}:AddFontStrings(leftstring, rightstring)`);
    }
    if (widget.type !== "FontString") {
      throw new GlueLuaRaise(`${nameOf(tooltip)}:AddFontStrings(): Wrong object type, expected fontstring`);
    }
    return widget;
  };
  return {
    AddFontStrings: ({ frame, args }) => {
      const left = fontStringOf(frame, args[0]);
      const right = fontStringOf(frame, args[1]);
      let rows = added.get(frame);
      if (!rows) {
        rows = new Map();
        added.set(frame, rows);
      }
      rows.set(lineCount(frame) + 1, { left, right });
    },
  };
}
