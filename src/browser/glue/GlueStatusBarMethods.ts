/**
 * 3.27 (11.11): `StatusBar:SetMinMaxValues(min, max)` as Wow.exe 3.3.5a 12340 answers it (0x009713c0 → 0x00961800;
 * read-only Ghidra, .runtime/re-2026-10-04/l5b-review/s1.c, .runtime/re-2026-11-11/fxapi/d8.c, data4.txt):
 *
 * - Both arguments `lua_isnumber`, else «Usage: <name>:SetMinMaxValues(min, max)» (`<unnamed>` without a name).
 * - (float)min and max within ±1e12 (0x00a9f8f0, 0x00a4c4e0), else «Min or Max out of range» — a NaN too; then
 *   max − (float)min at most 1e12, else «Min and Max too far apart».
 * - 0x00961800 with both as floats: a max below the min lowers the min to it (not the max up to the min); nothing
 *   changes when both are what the bar holds; otherwise the bar takes them and its value is set again (+0xe4 with the
 *   value it holds), which clamps it.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/** ±1e12: the doubles at 0x00a9f8f0 and 0x00a4c4e0. */
const LIMIT = 1e12;

/** `lua_isnumber`: a number or a numeric string; then `lua_tonumber`. */
function luaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value.trim());
  return Number.isNaN(number) ? undefined : number;
}

const nameOf = (frame: FrameXmlFrame): string => (frame.named && frame.name ? frame.name : "<unnamed>");

/** 0x009713c0 for a StatusBar `frame`. */
export function statusBarSetMinMaxValues(bridge: FrameXmlUiBridge, frame: FrameXmlFrame, args: readonly unknown[]): void {
  if (frame.type !== "StatusBar") return;
  const minArgument = luaNumber(args[0]);
  const maxArgument = luaNumber(args[1]);
  if (minArgument === undefined || maxArgument === undefined) {
    throw new Error(`Usage: ${nameOf(frame)}:SetMinMaxValues(min, max)`);
  }
  const low = Math.fround(minArgument);
  if (!(-LIMIT <= low && low <= LIMIT && -LIMIT <= maxArgument && maxArgument <= LIMIT)) {
    throw new Error("Min or Max out of range");
  }
  if (!(maxArgument - low <= LIMIT)) throw new Error("Min and Max too far apart");
  const max = Math.fround(maxArgument);
  const min = max < low ? max : low;
  const bar = frame.statusBar;
  if (bar.min === min && bar.max === max) return;
  bridge.runInMutationBatch(() => {
    bridge.update(frame, (m) => {
      if (m.type !== "StatusBar") return;
      m.statusBar.min = min;
      m.statusBar.max = max;
    }, "paint");
    bridge.SetValue(frame, frame.statusBar.value);
  });
}
