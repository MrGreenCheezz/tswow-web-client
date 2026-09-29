/**
 * The live page's share of the stock loot model's context: the loot packet's display-id pictures,
 * the client's `autoLootDefault` and the auto-loot toggle modifier. Browser-only (the world mount
 * imports it); FrameXmlLoot.ts itself stays free of the DOM and the game context.
 */
import { game } from "../game/Context.js";
import { settingOn } from "../ui/Settings.js";
import type { FrameXmlLootHostContext } from "./FrameXmlLoot.js";

/**
 * How long Shift on the click (or key) that asked for the loot still counts when the answer comes.
 * The client decides auto-loot at the interaction; SMSG_LOOT_RESPONSE arrives a round trip later,
 * by which time a quick Shift+right-click has already let go of Shift.
 */
const INTERACTION_MODIFIER_MS = 2000;

let tracking = false;
let shiftHeld = false;
let shiftOnInteraction = false;
let interactionAt = Number.NEGATIVE_INFINITY;

function trackModifier(): void {
  if (tracking || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  tracking = true;
  const interaction = (event: { readonly shiftKey: boolean }): void => {
    shiftHeld = event.shiftKey;
    shiftOnInteraction = event.shiftKey;
    interactionAt = performance.now();
  };
  window.addEventListener("pointerdown", interaction, true);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Shift") shiftHeld = true;
    else interaction(event);
  }, true);
  window.addEventListener("keyup", (event) => { if (event.key === "Shift") shiftHeld = false; }, true);
  window.addEventListener("blur", () => { shiftHeld = false; });
}

/** `AUTOLOOTTOGGLE` (Shift) held now, or held on the interaction that asked for this loot. */
function autoLootModifier(): boolean {
  return shiftHeld || (shiftOnInteraction && performance.now() - interactionAt <= INTERACTION_MODIFIER_MS);
}

export function createFrameXmlLiveLootHost(): FrameXmlLootHostContext {
  trackModifier();
  return {
    // The native window's own picture source: the display id rides in the loot packet, so no item
    // query or metadata row is needed (Npc.ts showLoot).
    displayIcon: (displayId) => game.itemMetadata?.displayIconUrl(displayId),
    autoLootDefault: () => settingOn("autoLoot"),
    autoLootModifier,
  };
}
