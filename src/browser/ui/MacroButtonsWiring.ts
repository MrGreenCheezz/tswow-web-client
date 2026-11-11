/**
 * 5.37 (11.11): the macro button codec (`MacroButtons.ts`) over the two macro stores, on one world.
 * `app/EnterWorld.ts` attaches it with the stores and tracks the disposer.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import { viewActionButton, wireActionButton, type MacroButtonLookup } from "./MacroButtons.js";
import { macroIdAt, macroIndexOfId, onAnyMacroChange } from "./MacroStore.js";

const lookup: MacroButtonLookup = { indexOfId: macroIndexOfId, idAt: macroIdAt };

export function attachMacroButtons(world: Pick<WorldClient, "actionButtonCodec" | "reviewActionButtons">): () => void {
  world.actionButtonCodec = {
    view: (button) => viewActionButton(button, lookup),
    wire: (button) => wireActionButton(button, lookup),
  };
  // Buttons that landed before the macros did are read again when they arrive or change.
  world.reviewActionButtons();
  const off = onAnyMacroChange(() => world.reviewActionButtons());
  return () => {
    off();
    world.actionButtonCodec = undefined;
  };
}
