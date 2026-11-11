/**
 * Macro action buttons as Wow.exe keeps them (5.37).
 *
 * Wow.exe's action button holds a macro by its id with the type bit 0x40 over it: the packed word is
 * `0x40000000 | id`, and 0x00567520 finds the macro of a slot word `w` with `(w & 0xf0000000) ==
 * 0x40000000` as id `w & 0xbfffffff`. A character macro's id is 0x1000000 + n, so its word is type 0x41
 * with action n — TrinityCore's ACTION_BUTTON_CMACRO (`ACTION_BUTTON_C | ACTION_BUTTON_MACRO`, Player.h);
 * an account macro's is type 0x40 (ACTION_BUTTON_MACRO) with its id. The core stores both as they come
 * (Player::IsActionButtonDataValid accepts 0x01, 0x40, 0x41 unchecked).
 *
 * This client's code reads a macro button as type 0x40 holding the macro's slot here (1..36 account,
 * 37..54 character): `WorldClient.actionButtons` is that view, `actionButtonsWire` what the server keeps,
 * and the codec below turns one into the other both ways. Buttons this client saved before 5.37 are
 * type 0x40 with a character slot 37..54; one is read as that character macro when no account macro of
 * Wow.exe has that id (Wow.exe would show its own account macro there), and is written in Wow.exe's form
 * when it is next placed — never rewritten on its own.
 */

import { ACTION_BUTTON_MACRO, type ActionButton } from "../../world/ActionBarProtocol.js";
import { MAX_ACCOUNT_MACROS, MAX_MACROS } from "./MacroModel.js";

/** ACTION_BUTTON_CMACRO (Player.h): a character macro's button. */
export const ACTION_BUTTON_CMACRO = 0x41;

export interface MacroButtonLookup {
  /** This client's slot of the macro with that Wow.exe id. */
  indexOfId(id: number): number | undefined;
  /** The Wow.exe id of the macro in this client's slot. */
  idAt(index: number): number | undefined;
}

/** Whether a type byte is a macro's (0x40 or 0x41): 0x00567520's `& 0xf0000000 == 0x40000000` on the top byte. */
export function isWireMacroType(type: number): boolean {
  return (type & 0xf0) === 0x40;
}

/** The macro id a wire button names: the word less bit 0x40000000. */
export function wireMacroId(button: Pick<ActionButton, "action" | "type">): number {
  return (((button.type & 0xbf) << 24) | button.action) >>> 0;
}

/** The slot here a wire macro button means, or undefined when no macro here is it. */
export function macroIndexOfButton(button: Pick<ActionButton, "action" | "type">, lookup: MacroButtonLookup): number | undefined {
  if (!isWireMacroType(button.type)) return undefined;
  const index = lookup.indexOfId(wireMacroId(button));
  if (index !== undefined) return index;
  // Before 5.37 this client saved a character macro as 0x40 + its slot 37..54.
  const old = button.type === ACTION_BUTTON_MACRO && button.action > MAX_ACCOUNT_MACROS && button.action <= MAX_MACROS;
  return old && lookup.idAt(button.action) !== undefined ? button.action : undefined;
}

/** This client's view of a wire button: a macro one as 0x40 + its slot here; anything else as it is. */
export function viewActionButton(button: ActionButton, lookup: MacroButtonLookup): ActionButton {
  const index = macroIndexOfButton(button, lookup);
  if (index === undefined) return button;
  return index === button.action && button.type === ACTION_BUTTON_MACRO ? button : { slot: button.slot, action: index, type: ACTION_BUTTON_MACRO };
}

/** The wire form of this client's button: a macro slot as Wow.exe's word for that macro's id. */
export function wireActionButton(button: ActionButton, lookup: MacroButtonLookup): ActionButton {
  if (button.type !== ACTION_BUTTON_MACRO) return button;
  const id = lookup.idAt(button.action);
  if (id === undefined) return button;
  return { slot: button.slot, action: id & 0x00ff_ffff, type: ACTION_BUTTON_MACRO | ((id >>> 24) & 0xbf) };
}
