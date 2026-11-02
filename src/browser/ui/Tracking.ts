import { lockIdOf } from "../../world/GameObjectProtocol.js";
import { LOCK_KEY_SKILL } from "../../world/LockRules.js";
import { worldObject } from "../../world/Fields.js";
import type { WorldObjectState, WorldState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { spellCastAllowed } from "../SpellCastGuard.js";
import { requestSpellCast } from "../game/GroundTarget.js";
import { IconButton, Panel } from "./Widgets.js";
import { spellIconUrl } from "./IconImage.js";
import {
  isTracking, trackedCreatureTypes, trackedResourceTypes, trackingPlayer, trackingSpellsOf, type TrackingSpell,
} from "./TrackingSpells.js";

/**
 * The tracking menu and the minimap's rule for what tracking shows; the fields and the spells are
 * TrackingSpells.ts. The menu shows what the character actually knows, and reads the state back out
 * of the fields rather than remembering what it asked for.
 */

/** How far out a tracked thing still counts as nearby, in yards. Beyond it there is no object. */
const TRACK_RANGE = 250;
const TRACK_RANGE_SQUARED = TRACK_RANGE * TRACK_RANGE;

/** The tracking spells the character knows, in the order the spellbook lists them. */
export function knownTrackingSpells(): TrackingSpell[] {
  const world = game.world;
  if (!world) return [];
  return trackingSpellsOf(world.knownSpells.map((known) => known.id), (id) => game.spells.get(id));
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
  const player = trackingPlayer();
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
  const player = trackingPlayer()!.position!;

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
