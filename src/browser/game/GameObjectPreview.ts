import type { GameObjectTemplate } from "../../world/GameObjectProtocol.js";

/**
 * Which placing spells can show their model before the cast.
 *
 * TrinityCore places a game object from `EffectMiscValue` on four handlers: `EffectTransmitted`
 * (50), `EffectSummonObjectWild` (76), `EffectDuel` (83) and `EffectSummonObject` slots 104-107
 * (`SpellEffects.cpp`). The neighboring effects are deliberately absent: `SCRIPT_EFFECT` (77),
 * `SEND_EVENT` (61) and `DUMMY` (3) key on the spell id, not on a template, so their misc value
 * is not an entry; `SUMMON` (28) names a creature. A spell that reaches a game object only
 * through `EffectTriggerSpell` is a second hop this payload cannot see and must stay without a
 * preview rather than guess.
 */
export const GAMEOBJECT_PLACEMENT_EFFECTS: ReadonlySet<number> = new Set([50, 76, 83, 104, 105, 106, 107]);

/**
 * Object types whose placed model is owned by live server state instead of the template's display.
 *
 * A transport draws from its path, a fishing node is the client's own bobber, a destructible
 * building swaps models as it is damaged, and capture points, aura generators, dungeon-difficulty
 * markers, minigames and trapdoors are server-side bookkeeping. Previewing their template model
 * would promise a shape the realm never creates.
 */
const SERVER_OWNED_TYPES: ReadonlySet<number> = new Set([11, 15, 17, 27, 29, 30, 31, 33, 35]);
/** `MAX_GAMEOBJECT_TYPE` in SharedDefines.h: anything at or above it is not a template type. */
const MAX_GAMEOBJECT_TYPE = 36;

/** The first game object entry the spell would place, or nothing when no effect names one. */
export function gameObjectPlacementEntry(
  spell: { effects?: readonly number[]; effectMiscValue?: readonly number[] } | undefined,
): number | undefined {
  const effects = spell?.effects;
  const misc = spell?.effectMiscValue;
  if (!effects || !misc) return undefined;
  for (let slot = 0; slot < Math.min(effects.length, misc.length); slot++) {
    const entry = misc[slot];
    if (entry === undefined || !GAMEOBJECT_PLACEMENT_EFFECTS.has(effects[slot]!)) continue;
    if (Number.isSafeInteger(entry) && entry > 0) return entry;
  }
  return undefined;
}

/** Whether the placed object's own display can be trusted to draw what the realm creates. */
export function previewableGameObjectType(type: number): boolean {
  return Number.isSafeInteger(type) && type > 0 && type < MAX_GAMEOBJECT_TYPE
    && !SERVER_OWNED_TYPES.has(type);
}

export interface GameObjectPreviewModel {
  readonly entry: number;
  readonly displayId: number;
  readonly model: string;
  readonly scale: number;
}

/**
 * The ghost one placement may draw, resolved from the template's own display row.
 *
 * A WMO is refused on purpose: a building-shaped preview would ask for room geometry and portal
 * selection for a point the player has not committed to, and the placing spells this client can
 * name place small objects. Everything else fails closed — a missing template (still on the wire
 * or unknown to the realm), a server-owned type, a display with no model — never a guessed shape.
 */
export function gameObjectPreviewModel(
  entry: number, template: GameObjectTemplate | undefined, model: string | undefined,
): GameObjectPreviewModel | undefined {
  if (!template || !previewableGameObjectType(template.type)) return undefined;
  if (!Number.isSafeInteger(template.displayId) || template.displayId <= 0) return undefined;
  if (!model || model.toLowerCase().endsWith(".wmo")) return undefined;
  const scale = Number.isFinite(template.size) && template.size > 0 ? template.size : 1;
  return { entry, displayId: template.displayId, model, scale: clampScale(scale) };
}

/** The same 0.05..40 the wire scale is clamped to when a game object is placed. */
function clampScale(scale: number): number {
  return Math.max(0.05, Math.min(40, scale));
}
