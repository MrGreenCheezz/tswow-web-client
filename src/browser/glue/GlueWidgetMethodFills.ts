/**
 * Plan item 3.21 (05.10): widget methods the stock corpus calls that no type table answered — the
 * census of 05.10 (.runtime/re-2026-10-05/3.21/census.txt) — whose Wow.exe behaviour is settled.
 * Read from Wow.exe.clean 3.3.5a 12340 (read-only Ghidra; behaviour described, no code copied):
 *
 * * `FontString:SetAlphaGradient(start, length)` (0x0048d0f0): see FrameXmlAlphaGradient.ts.
 * * `Frame:IgnoreDepth(ignore)` (0x004a1d80, table entry 0x00ac17e8): the argument must be a boolean
 *   (`lua_type == LUA_TBOOLEAN`), else «Usage: <name>:IgnoreDepth(ignore)»; it is stored on the frame
 *   (the stereoscopic-depth flag) and nothing is answered. Nothing here draws in depth, so the flag
 *   is kept and read by nothing; WorldFrame.lua:28 calls it once at load.
 * * `GameTooltip:SetSpellByID(id[, isPet[, showSubtext]])` (0x00625b90, entry 0x00ad2ba0): the id
 *   must be a number and not negative, else «Invalid spell ID in <name>:SetSpellByID». `isPet` and
 *   `showSubtext` are read as flags (0x00815500: nil → no, a boolean as is, a number when not 0). The
 *   spell must be the player's — or with `isPet` the pet's — (0x0053b930 → 0x0053b4e0, the spell
 *   book); otherwise it answers nil and leaves the tooltip as it was. Then the shared spell tooltip
 *   builder (0x006238a0, the one `SetSpell` uses) draws it and the method answers 1 when it did.
 *   MultiCastActionBarFrame.lua:561, :882 (the totem bar's buttons) are the stock callers, always
 *   `(id, false, true)`.
 *
 * Unsettled, so not modelled: 0x0053b930's second chance for a spell not in the book (the pet
 * action bar at 0x00c23508, 0x005d3560, taken on a condition the decompiler does not show);
 * `showSubtext` false dropping the rank right of the name (the builder clears that text when both
 * its third argument and `showSubtext` are 0) — the drawn content is the spell link's, rank included;
 * a string `isPet` (0x00815400); the cooldown line the builder adds from 0x00809000.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { setFrameXmlAlphaGradient } from "../ui/framexml_compat/FrameXmlAlphaGradient.js";
import type { WidgetMethod } from "./GlueWidgets.js";

/** Lua's `lua_isnumber` for a binding argument: a number or a numeric string. */
function isLuaNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isNaN(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** 0x0088b9c0: a Lua number to an integer, toward zero. */
function truncate(value: unknown): number {
  return Math.trunc(Number(value));
}

/** The name an error names (the client's `<unnamed>` when there is none). */
function nameOf(frame: FrameXmlFrame): string {
  return frame.name || "<unnamed>";
}

/** 0x00815500 for the cases settled: nil → false, boolean as is, number when not 0, others false. */
function flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  return false;
}

export function fontStringGradientMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    SetAlphaGradient: ({ frame, self, args }) => {
      if (!isLuaNumber(args[0]) || !isLuaNumber(args[1])) {
        throw new Error(`Usage: ${nameOf(frame)}:SetAlphaGradient(start, length)`);
      }
      const { answer, changed } = setFrameXmlAlphaGradient(frame, self.text, truncate(args[0]), truncate(args[1]));
      // Called from QuestInfoFadingFrame's OnUpdate every frame: only a new pair is a repaint.
      if (changed) bridge.update(frame, () => {}, "paint");
      return answer ? [1] : [];
    },
  };
}

const ignoringDepth = new WeakMap<FrameXmlFrame, boolean>();

/** Whether `IgnoreDepth(true)` is in force on a frame; nothing draws by it (see the header). */
export function frameXmlIgnoresDepth(frame: FrameXmlFrame): boolean {
  return ignoringDepth.get(frame) === true;
}

export function frameDepthMethods(): Record<string, WidgetMethod> {
  return {
    IgnoreDepth: ({ frame, args }) => {
      if (typeof args[0] !== "boolean") throw new Error(`Usage: ${nameOf(frame)}:IgnoreDepth(ignore)`);
      ignoringDepth.set(frame, args[0]);
    },
  };
}

/** What `SetSpellByID` needs from the tooltip binder (GlueTooltipExtras' host). */
export interface TooltipSpellByIdHost {
  callGlobal(name: string, args: readonly unknown[], results: number): readonly unknown[];
  /** The spell's own tooltip drawn and OnTooltipSetSpell raised; false when nothing is known. */
  spell(frame: FrameXmlFrame, spellId: number): boolean;
}

export function tooltipSpellByIdMethods(host: TooltipSpellByIdHost): Record<string, WidgetMethod> {
  return {
    SetSpellByID: ({ frame, args }) => {
      const id = isLuaNumber(args[0]) ? truncate(args[0]) : -1;
      if (id < 0) throw new Error(`Invalid spell ID in ${nameOf(frame)}:SetSpellByID`);
      // 0x0053b4e0 finds nothing for id 0 (and IsSpellKnown would refuse it).
      if (id === 0) return [];
      const isPet = flag(args[1]);
      // The spell book check (0x0053b4e0) is what IsSpellKnown answers (FrameXmlMultiCast.ts).
      const known = host.callGlobal("IsSpellKnown", isPet ? [id, true] : [id], 1)[0];
      if (known !== true && !(typeof known === "number" && known !== 0)) return [];
      return host.spell(frame, id) ? [1] : [];
    },
  };
}
