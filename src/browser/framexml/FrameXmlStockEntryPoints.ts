/**
 * Whether an add-on has taken over one of UIParent.lua's entry points that the host routes keys to.
 *
 * N runs `ToggleTalentFrame` (UIParent.lua:359), TOGGLEINSCRIPTION `ToggleGlyphFrame` (:370) and a glyph
 * item's USE_GLYPH `OpenGlyphFrame` (:381). Their stock bodies load an add-on synchronously, which this
 * host cannot do, so the host opens the stock windows behind them itself (FrameXmlWorldMount.ts,
 * FrameXmlGlyphOwner.ts). An add-on — a TSWoW module is one — may assign its own function to such a
 * name, and in Wow.exe the key then runs that function. Who assigned it never matters (owner, 12.10:
 * a module's interface is a patch of the client's, nothing is keyed to its name): what matters is
 * whether the global is still UIParent's own. So UIParent's functions are remembered right after
 * UIParent.lua ran (FrameXmlBoot.ts `afterLuaFile`, the same boundary FrameXmlLoginEdge.ts uses for
 * `CombatLog_LoadUI`) and a later probe compares the global with them by identity. The VM has no
 * `debug` library, so a chunk's source cannot say whose a function is; identity can.
 *
 * `PlayerTalentFrame_Toggle` is not one of them: Blizzard_TalentUI.lua defines it, not UIParent.lua,
 * and loading that add-on redefines it whatever an add-on assigned before.
 *
 * `hooksecurefunc` also puts a wrapper in the global (FrameXmlLua51NativeShims.ts, as the client does),
 * yet the function the wrapper runs first is still UIParent's. The shim records each wrapper's inner
 * function and the probe looks through them: an add-on that only hooks an entry point has not
 * replaced it, and the key keeps its stock route.
 *
 * Probe before the host installs its own hooks on these names (FrameXmlGlyphOwner.ts replaces the two
 * glyph entry points): a host hook is not UIParent's either.
 */
import type { GlueLuaVm } from "../glue/GlueLua.js";

export const FRAMEXML_STOCK_ENTRY_POINTS = Object.freeze([
  "ToggleTalentFrame", "ToggleGlyphFrame", "OpenGlyphFrame",
] as const);
export type FrameXmlStockEntryPoint = typeof FRAMEXML_STOCK_ENTRY_POINTS[number];

/** The hidden global holding UIParent.lua's own functions, by name. */
const STOCK_ENTRY_POINTS = "__fxStockEntryPoints";
/** The shim's weak table of `hooksecurefunc` wrappers, each to the function it wraps. */
export const FRAMEXML_SECURE_HOOK_ORIGINALS = "__fxSecureHookOriginals";
/** Enough for any real chain of post-hooks; a cycle cannot be built, but the walk stays bounded. */
const MAX_HOOK_DEPTH = 64;

/**
 * Whether a corpus file is the one that defines the stock entry points: FrameXML's own, not a file of
 * that name a TSAddon block might carry under `FrameXML/TSAddons/<module>/`, which would capture the
 * add-on's functions as stock.
 */
export function frameXmlDefinesStockEntryPoints(path: string): boolean {
  return /(?:^|[\\/])framexml[\\/]uiparent\.lua$/i.test(path);
}

/** Right after UIParent.lua ran, before any later TOC entry (a TSAddon block among them): remember its functions. */
export function captureFrameXmlStockEntryPoints(vm: Pick<GlueLuaVm, "execute">): void {
  const names = FRAMEXML_STOCK_ENTRY_POINTS.map((name) => `"${name}"`).join(", ");
  vm.execute(`
    local stock = {}
    for _, name in ipairs({ ${names} }) do
      local value = rawget(_G, name)
      if type(value) == "function" then stock[name] = value end
    end
    rawset(_G, "${STOCK_ENTRY_POINTS}", stock)
  `, "@webclient/stock-entry-points");
}

// rawget throughout: the `_G` metamethod answers a first-touched name from the neutral floor, and a
// probe must neither count as that touch nor take a floor function for an add-on's.
const REPLACED_PROBE = `
  local name = ...
  local current = rawget(_G, name)
  if type(current) ~= "function" then return false end
  local originals = rawget(_G, "${FRAMEXML_SECURE_HOOK_ORIGINALS}")
  if type(originals) == "table" then
    for _ = 1, ${MAX_HOOK_DEPTH} do
      local inner = originals[current]
      if inner == nil then break end
      current = inner
    end
  end
  local stock = rawget(_G, "${STOCK_ENTRY_POINTS}")
  return type(stock) ~= "table" or stock[name] ~= current
`;

/**
 * True when the global `name` is a function and not UIParent.lua's own (seen through post-hooks). With
 * no UIParent.lua in the boot every function counts as an add-on's: nothing stock defined it.
 */
export function frameXmlEntryPointReplaced(
  boot: { readonly vm: Pick<GlueLuaVm, "compileFunction" | "call" | "release"> },
  name: FrameXmlStockEntryPoint,
): boolean {
  const probe = boot.vm.compileFunction(REPLACED_PROBE, "webclient/stock-entry-point", []);
  if (!probe) return false;
  try {
    return boot.vm.call(probe, [name], 1)[0] === true;
  } finally {
    boot.vm.release(probe);
  }
}
