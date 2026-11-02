import { readByte, readField, trackedTypesFromMask } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import type { SpellMetadata } from "../SpellMetadata.js";

/**
 * Tracking: what the character has asked to see on the minimap, and what that turns out to mean.
 *
 * There is no tracking opcode. Not one — searching the whole protocol for it comes back empty,
 * because turning tracking on is casting an ordinary spell and turning it off is `CMSG_CANCEL_AURA`.
 * What is being tracked lives in two bit fields on the player, `PLAYER_TRACK_CREATURES` and
 * `PLAYER_TRACK_RESOURCES`, plus one flag in `PLAYER_FIELD_BYTES` for the hidden.
 *
 * The bits are **one less** than the id they stand for. `SPELL_AURA_TRACK_CREATURES` carries a
 * `CreatureType` in its misc value and the core sets `1 << (MiscValue - 1)`, so bit 0 is creature
 * type 1 and reading the bit as the type puts every beast under "none". Measured over this
 * dataset: 22 spells track a creature type (misc values 1..13, never 0), 9 track a resource
 * (2, 3, 6, 7, 15, 19 — lock types, never 0) and exactly one tracks the hidden, with misc 0.
 *
 * This module has what the stock minimap's tracking button reads through the FrameXML seam, and no
 * window: the state is read back out of the fields rather than remembered from what was asked for —
 * the server is free to disagree, and does: only one tracker may be active at a time, except for
 * the two combinations the core makes exceptions for.
 */

/** `SPELL_AURA_TRACK_CREATURES`, `_RESOURCES`, `_STEALTHED` in SpellAuraDefines.h. */
const AURA_TRACK_CREATURES = 44;
const AURA_TRACK_RESOURCES = 45;
const AURA_TRACK_STEALTHED = 151;
/** `PLAYER_FIELD_BYTE_TRACK_STEALTHED` — byte 0 of `PLAYER_FIELD_BYTES`. */
const TRACK_STEALTHED_FLAG = 0x02;

export interface TrackingSpell {
  spellId: number;
  aura: number;
  /** One-based `CreatureType` or `LockType`; zero for the hidden, which has no type. */
  miscValue: number;
  name: string;
  iconId: number;
}

/** The DBC columns a tracking spell is recognised by; a structural subset of `SpellMetadata`. */
export type TrackingSpellMetadata = Pick<SpellMetadata, "effectAura" | "effectMiscValue" | "name" | "iconId">;

/**
 * The tracking spells among `knownSpellIds`, in that order, from any spell lookup.
 *
 * The world-free form of `knownTrackingSpells`, so the stock minimap's GetTrackingInfo (through the
 * FrameXML seam, which carries its own world and spell cache) and the tracking panel list the same rows.
 */
export function trackingSpellsOf(
  knownSpellIds: Iterable<number>,
  spell: (id: number) => TrackingSpellMetadata | undefined,
): TrackingSpell[] {
  const found: TrackingSpell[] = [];
  for (const id of knownSpellIds) {
    const metadata = spell(id);
    // A C-API read must never throw: a partial row without effect columns is simply not a tracker.
    if (!metadata || !Array.isArray(metadata.effectAura)) continue;
    const effect = metadata.effectAura.findIndex((aura) =>
      aura === AURA_TRACK_CREATURES || aura === AURA_TRACK_RESOURCES || aura === AURA_TRACK_STEALTHED);
    if (effect < 0) continue;
    found.push({
      spellId: id,
      aura: metadata.effectAura[effect]!,
      miscValue: metadata.effectMiscValue?.[effect] ?? 0,
      name: metadata.name,
      iconId: metadata.iconId,
    });
  }
  return found;
}

/** The session's own player, whose fields say what is tracked. */
export function trackingPlayer(): WorldObjectState | undefined {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return undefined;
  return world.state.objects.get(world.state.selfGuid);
}

export function trackedCreatureTypes(player: WorldObjectState | undefined = trackingPlayer()): Set<number> {
  return trackedTypesFromMask(player ? readField(player, "PLAYER_TRACK_CREATURES") : undefined);
}

export function trackedResourceTypes(player: WorldObjectState | undefined = trackingPlayer()): Set<number> {
  return trackedTypesFromMask(player ? readField(player, "PLAYER_TRACK_RESOURCES") : undefined);
}

export function trackingStealthed(player: WorldObjectState | undefined = trackingPlayer()): boolean {
  return player !== undefined && ((readByte(player, "PLAYER_FIELD_BYTES", 0) ?? 0) & TRACK_STEALTHED_FLAG) !== 0;
}

/**
 * Whether one tracking spell's own effect is currently showing in the fields of `player` (the
 * session's own player by default). The fields, not the last click, are the answer: the server
 * allows one tracker at a time and is free to refuse.
 */
export function isTracking(spell: TrackingSpell, player: WorldObjectState | undefined = trackingPlayer()): boolean {
  if (spell.aura === AURA_TRACK_STEALTHED) return trackingStealthed(player);
  const active = spell.aura === AURA_TRACK_CREATURES ? trackedCreatureTypes(player) : trackedResourceTypes(player);
  return spell.miscValue > 0 && active.has(spell.miscValue);
}

/**
 * The raw tracking words of `player`, as one comparable string: a change in any of them is a
 * MINIMAP_UPDATE_TRACKING edge for the stock tracking button. Nothing tracked is `""`, so a
 * consumer comparing against an empty start publishes only a real tracker.
 */
export function trackingFieldsSignature(player: WorldObjectState | undefined): string {
  if (!player) return "";
  const creatures = readField(player, "PLAYER_TRACK_CREATURES") ?? 0;
  const resources = readField(player, "PLAYER_TRACK_RESOURCES") ?? 0;
  const stealthed = (readByte(player, "PLAYER_FIELD_BYTES", 0) ?? 0) & TRACK_STEALTHED_FLAG;
  return creatures === 0 && resources === 0 && stealthed === 0 ? "" : `${creatures}:${resources}:${stealthed}`;
}
