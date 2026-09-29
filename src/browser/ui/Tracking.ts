import { lockIdOf } from "../../world/GameObjectProtocol.js";
import { LOCK_KEY_SKILL } from "../../world/LockRules.js";
import { readByte, readField, trackedTypesFromMask, worldObject } from "../../world/Fields.js";
import type { WorldObjectState, WorldState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { spellCastAllowed } from "../SpellCastGuard.js";
import { requestSpellCast } from "../game/GroundTarget.js";
import { IconButton, Panel } from "./Widgets.js";
import { spellIconUrl } from "./IconImage.js";
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
 * This menu shows what the character actually knows, and reads the state back out of the fields
 * rather than remembering what it asked for — the server is free to disagree, and does: only one
 * tracker may be active at a time, except for the two combinations the core makes exceptions for.
 */

/** `SPELL_AURA_TRACK_CREATURES`, `_RESOURCES`, `_STEALTHED` in SpellAuraDefines.h. */
const AURA_TRACK_CREATURES = 44;
const AURA_TRACK_RESOURCES = 45;
const AURA_TRACK_STEALTHED = 151;
/** `PLAYER_FIELD_BYTE_TRACK_STEALTHED` — byte 0 of `PLAYER_FIELD_BYTES`. */
const TRACK_STEALTHED_FLAG = 0x02;
/** How far out a tracked thing still counts as nearby, in yards. Beyond it there is no object. */
const TRACK_RANGE = 250;
const TRACK_RANGE_SQUARED = TRACK_RANGE * TRACK_RANGE;

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
 * FrameXML seam, which carries its own world and spell cache) and this panel list the same rows.
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

/** The tracking spells the character knows, in the order the spellbook lists them. */
export function knownTrackingSpells(): TrackingSpell[] {
  const world = game.world;
  if (!world) return [];
  return trackingSpellsOf(world.knownSpells.map((known) => known.id), (id) => game.spells.get(id));
}

function self(): WorldObjectState | undefined {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return undefined;
  return world.state.objects.get(world.state.selfGuid);
}

export function trackedCreatureTypes(player: WorldObjectState | undefined = self()): Set<number> {
  return trackedTypesFromMask(player ? readField(player, "PLAYER_TRACK_CREATURES") : undefined);
}

export function trackedResourceTypes(player: WorldObjectState | undefined = self()): Set<number> {
  return trackedTypesFromMask(player ? readField(player, "PLAYER_TRACK_RESOURCES") : undefined);
}

export function trackingStealthed(player: WorldObjectState | undefined = self()): boolean {
  return player !== undefined && ((readByte(player, "PLAYER_FIELD_BYTES", 0) ?? 0) & TRACK_STEALTHED_FLAG) !== 0;
}

/**
 * Whether one tracking spell's own effect is currently showing in the fields of `player` (the
 * session's own player by default). The fields, not the last click, are the answer: the server
 * allows one tracker at a time and is free to refuse.
 */
export function isTracking(spell: TrackingSpell, player: WorldObjectState | undefined = self()): boolean {
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

/**
 * The rule for creatures and objects the current tracking says to show.
 *
 * A creature matches on its `CreatureType`, which the creature dump already carries. A resource
 * node matches on its lock: `data0` of a chest is a `Lock.dbc` id, and a lock's skill case names
 * the `LockType` — herbalism is 2 and mining 3 — which is exactly the misc value the tracking
 * spell carried. `LockClient` already ships every lock's cases for the sake of opening them, so
 * this needs no new data at all.
 */
/** Captures the current tracking fields once for a minimap repaint. */
export function trackingMatcher(
  state: WorldState,
  mapId: number | undefined,
): ((object: WorldObjectState, distanceSquared: number) => boolean) | undefined {
  const creatures = trackedCreatureTypes();
  const resources = trackedResourceTypes();
  if (creatures.size === 0 && resources.size === 0) return undefined;
  const player = self();
  if (!player?.position || mapId === undefined) return undefined;

  return (object, distanceSquared) => {
    if (object.guid === state.selfGuid || distanceSquared > TRACK_RANGE_SQUARED) return false;
    if (object.typeId === 3 && creatures.size > 0) {
      const type = game.creatureMetadata?.get(worldObject.entry(object) ?? 0)?.type ?? 0;
      return creatures.has(type);
    }
    return object.typeId === 5 && resources.size > 0 && matchesTrackedResource(object, resources);
  };
}

/** Standalone list form for callers that do not already scan the world object table. */
export function trackedNearby(state: WorldState, mapId: number | undefined): WorldObjectState[] {
  const matches = trackingMatcher(state, mapId);
  if (!matches) return [];
  const player = self()!.position!;

  const found: WorldObjectState[] = [];
  for (const object of state.objects.values()) {
    if (!object.position || (object.typeId !== 3 && object.typeId !== 5)) continue;
    const dx = object.position.x - player.x;
    const dy = object.position.y - player.y;
    if (matches(object, dx * dx + dy * dy)) found.push(object);
  }
  return found;
}

function matchesTrackedResource(object: WorldObjectState, resources: Set<number>): boolean {
  const world = game.world;
  const entry = worldObject.entry(object) ?? 0;
  // The template is asked for the first time it is wanted and cached for the session; until it
  // lands the node simply is not shown, rather than being shown as the wrong thing.
  const template = world?.gameObjectTemplate(entry, object.guid);
  if (!template) return false;
  const lockId = lockIdOf(template);
  if (lockId <= 0) return false;
  return (game.locks?.casesOf(lockId) ?? [])
    .some((lockCase) => lockCase.type === LOCK_KEY_SKILL && resources.has(lockCase.index));
}

let panel: Panel | undefined;
let list: HTMLElement | undefined;

export function toggleTrackingMenu(): void {
  if (!panel) {
    panel = new Panel({ id: "tracking-menu", title: "Слежение", className: "tracking-menu" });
    list = document.createElement("div");
    list.className = "tracking-list";
    panel.body.append(list);
  }
  panel.toggle();
  if (panel.visible) showTracking();
}

export function trackingMenuOpen(): boolean {
  return panel?.visible === true;
}

export function closeTrackingMenu(): void {
  panel?.hide();
}

/** Redraws the menu from the fields, not from what was last clicked. */
export function showTracking(): void {
  if (!panel?.visible || !list) return;
  const world = game.world;
  const spells = knownTrackingSpells();
  if (!world || spells.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Этот персонаж ничего не выслеживает";
    list.replaceChildren(empty);
    return;
  }

  const rows = spells.map((spell) => {
    const active = isTracking(spell);
    const icon = spellIconUrl(spell.iconId, game.gatewayOrigin);
    const button = new IconButton({
      icon,
      label: icon ? undefined : spell.name.slice(0, 2),
      title: spell.name,
      // The server allows one tracker at a time and refuses the rest, so the click is the same
      // either way: cast to start, cancel the aura to stop, and let the fields say what happened.
      onClick: () => {
        if (active) world.cancelAura(spell.spellId);
        else if (game.world !== world || spellCastAllowed(world, spell.spellId)) {
          requestSpellCast(spell.spellId, () => world.castSpell(spell.spellId));
        }
      },
    });
    button.setUsable(true);
    const row = document.createElement("div");
    row.className = active ? "tracking-row is-active" : "tracking-row";
    const name = document.createElement("span");
    name.textContent = spell.name;
    row.append(button.root, name);
    return row;
  });

  const off = document.createElement("button");
  off.type = "button";
  off.className = "tracking-off";
  off.textContent = "Ничего не выслеживать";
  off.addEventListener("click", () => {
    for (const spell of spells) if (isTracking(spell)) world.cancelAura(spell.spellId);
  });
  list.replaceChildren(...rows, off);
}

export function forgetTracking(): void {
  panel?.hide();
}
