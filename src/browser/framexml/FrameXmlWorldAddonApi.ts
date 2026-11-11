/**
 * 3.46 (11.11): the world's add-on switches over the character's own table — the one the character-select screen keeps
 * (glue/GlueAddons.ts `GlueWorldAddonStates`) — as Wow.exe 3.3.5a 12340's world answers them (read-only Ghidra,
 * .runtime/re-2026-11-11/fxapi/d2.c, d3.c, l3.lst, d6.c, refs2.txt):
 *
 * - `EnableAddOn(index or "name")` / `DisableAddOn` (0x00511840, 0x00511940): a number (or a numeric string, lua_isnumber)
 *   is a 1-based index into the world's add-on list, rounded — out of it, «AddOn index must be in the range of 1 to N»; any
 *   other string is a name taken as written; anything else «Usage: EnableAddOn(index or "name")». Then 0x5f90b0(add-on,
 *   the character's name 0x006b1060, 2 or 0): that character's table only.
 * - `EnableAllAddOns()` / `DisableAllAddOns()` (0x00511900, 0x00511a00): every add-on of the list, the same way.
 * - `ResetDisabledAddOns()` (0x00511a40): 0x5f91e0(the character's name) — its table again from its file.
 * - The world interface's unload (0x00528f00, ReloadUI and logout) saves the changed tables (0x5f76a0), and its load
 *   (0x0052a980) reads the character's again; GetAddOnInfo's «enabled» reads the table as it stands (0x005f7d70).
 *   What loads is decided at a load, so a switch takes effect at the next ReloadUI or entry, as in Wow.exe.
 *
 * Without the glue's table (a session that did not come through the character-select screen) nothing is registered here.
 */

import { GlueLuaRaise } from "../glue/GlueLua.js";
import { glueWorldAddonStates, type GlueWorldAddonStates } from "../glue/GlueAddons.js";

export interface FrameXmlWorldAddonVm {
  registerGlobal(name: string, fn: (args: readonly unknown[]) => readonly unknown[]): void;
}

/** The x87 store the client rounds an index with: to nearest, ties to even. */
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference < 0.5) return floor;
  if (difference > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Lua 5.1's lua_isnumber + tonumber. */
function luaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return undefined;
  return Number(text);
}

/** The add-on an index-or-name argument names, or the usage error. */
function addonArgument(value: unknown, names: readonly string[], usage: string): string {
  const number = luaNumber(value);
  if (number !== undefined) {
    const name = names[roundEven(number) - 1];
    if (name === undefined) throw new GlueLuaRaise(`AddOn index must be in the range of 1 to ${names.length}`);
    return name;
  }
  if (typeof value !== "string") throw new GlueLuaRaise(usage);
  return value;
}

/** Registers the five calls over `states` (the glue's hand-over by default); false when there is none. */
export function installFrameXmlWorldAddonApi(
  vm: FrameXmlWorldAddonVm,
  names: readonly string[],
  states: GlueWorldAddonStates | undefined = glueWorldAddonStates(),
): boolean {
  const set = states?.set;
  const reset = states?.reset;
  if (!states || !set || !reset) return false;
  const one = (on: boolean, usage: string) => (args: readonly unknown[]): readonly unknown[] => {
    set(addonArgument(args[0], names, usage), on);
    return [];
  };
  const all = (on: boolean) => (): readonly unknown[] => {
    for (const name of names) set(name, on);
    return [];
  };
  vm.registerGlobal("EnableAddOn", one(true, 'Usage: EnableAddOn(index or "name")'));
  vm.registerGlobal("DisableAddOn", one(false, 'Usage: DisableAddOn(index or "name")'));
  vm.registerGlobal("EnableAllAddOns", all(true));
  vm.registerGlobal("DisableAllAddOns", all(false));
  vm.registerGlobal("ResetDisabledAddOns", () => { reset(); return []; });
  return true;
}

/** 0x00528f00 → 0x5f76a0: the world interface goes away; the changed tables are written. */
export function saveFrameXmlWorldAddonStates(): void {
  glueWorldAddonStates()?.save?.();
}
