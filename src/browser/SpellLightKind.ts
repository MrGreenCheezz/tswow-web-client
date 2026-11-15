import type { SpellLightKind } from "./SpellLights.js";
import { spellModelGivesNoLight, type VisualInstance } from "./SpellVisuals.js";

/**
 * 25.10 (6.27): what kind of light a spell model gives in the enhanced profile (SpellLights.ts); 26.10: none for a
 * debuff's — a curse, disease or poison by the spell's DispelType (`noLight`), or by the effect model's own name.
 */
export function spellLightKind(
  instance: Pick<VisualInstance, "noLight" | "path" | "flight" | "modelPlayback">,
): SpellLightKind | undefined {
  if (instance.noLight || spellModelGivesNoLight(instance.path)) return undefined;
  return instance.flight ? "missile" : instance.modelPlayback === "hold" ? "aura" : "burst";
}
