/**
 * The offline macros and icon list for CannedWorldSeam (framexml.html, the RICH route, the tests):
 * two account macros in slots 1 and 3 — a gap the Lua positions close — one character macro, and
 * six icons that exist in the client's archives. Macros placed on the canned bar are recorded in
 * `placed` rather than sent anywhere.
 */

import { MACRO_DEFAULT_ICON, type Macro } from "../ui/MacroModel.js";
import { FrameXmlMacroModel, createFrameXmlMemoryMacroStore, type FrameXmlMacroStore } from "./FrameXmlMacro.js";

export const FRAMEXML_CANNED_MACROS: readonly Macro[] = Object.freeze([
  Object.freeze({ index: 1, name: "Рывок", body: "#showtooltip\n/cast Рывок", icon: "Interface\\Icons\\Ability_Warrior_Charge" }),
  Object.freeze({ index: 3, name: "Привет", body: "/say Привет!\n/wave" }),
  Object.freeze({ index: 37, name: "Щит", body: "/cast Блок щитом", icon: "Interface\\Icons\\Ability_Defend" }),
]);

export const FRAMEXML_CANNED_MACRO_ICONS: readonly string[] = Object.freeze([
  MACRO_DEFAULT_ICON,
  "Interface\\Icons\\Ability_Warrior_Charge",
  "Interface\\Icons\\Ability_Defend",
  "Interface\\Icons\\Ability_Warrior_BattleShout",
  "Interface\\Icons\\Spell_Fire_FlameBolt",
  "Interface\\Icons\\INV_Potion_54",
]);

export interface CannedFrameXmlMacros {
  readonly model: FrameXmlMacroModel;
  readonly store: FrameXmlMacroStore;
  /** `[1-based action slot, macro slot]` for every macro put on the canned bar. */
  readonly placed: [actionSlot: number, macroSlot: number][];
}

export function createCannedFrameXmlMacros(): CannedFrameXmlMacros {
  const store = createFrameXmlMemoryMacroStore(FRAMEXML_CANNED_MACROS);
  const placed: [number, number][] = [];
  const model = new FrameXmlMacroModel({
    store,
    icons: { spellIcons: () => FRAMEXML_CANNED_MACRO_ICONS, itemIcons: () => [], load: () => Promise.resolve() },
    placeOnActionBar: (slot, macro) => {
      placed.push([slot, macro]);
      return true;
    },
  });
  return { model, store, placed };
}
