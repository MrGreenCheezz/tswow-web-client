import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { player, unit } from "../../world/Fields.js";
import { WorldObjectState, WorldState, isWorldObjectDead } from "../../world/WorldState.js";
import { creatureIconSource } from "../CreatureMetadata.js";
import { game } from "../game/Context.js";
import { renderInventory } from "./Bags.js";
import { setIconSource } from "./IconImage.js";
import {
  creatureStatus, diagnosticsWindow, environmentStatus, playerPosition, worldObjects, worldStatus,
} from "./Dom.js";
import { typeNames, showTarget } from "./Frames.js";
import { showDeath } from "./Npc.js";
import { showUnitFrames } from "./UnitFrames.js";
import { showProfessions } from "./Professions.js";
import { settings } from "./Settings.js";
import { refreshModuleWindows } from "./WindowBindings.js";

/**
 * How many game objects may have their display metadata asked for in one drain.
 *
 * The route's own cap is 200 ids a request and the client chunks past that, so this is not a
 * protocol limit — it is the point past which asking stops being useful. The renderer draws game
 * objects to 120 yards, where the worst measured circle holds 739; the ones past this are the
 * ones a cap of any size would drop, and they are the furthest away.
 */
const GAMEOBJECT_METADATA_LIMIT = 400;

/**
 * World updates arrive far more often than the screen refreshes, and every one of them used to
 * rebuild the inventory, the target frame and the nearby-object list. They are coalesced into a
 * single refresh per animation frame instead.
 */
let pendingWorldState: WorldState | undefined;

/** Called once a frame by the render loop: shows whatever the packets left waiting. */
export function drainWorldState(): void {
  // Module windows first, and outside the guard below on purpose. Their bindings follow things
  // that move without any object update behind them — the game clock, the window's own state, the
  // zone under the character — so a window pinned to `world.clock` would stand still for as long
  // as the player did if it only ran when a packet had arrived. It costs one `Map.size` comparison
  // a frame while no module is loaded, which is every session that has none.
  //
  // The settings are handed in rather than imported by `WindowBindings`: that file is the pure half
  // of the view and is loaded by a test that has no page, while `Settings.ts` reaches the action
  // bar, the minimap and `Dom.ts`. This file already has all three.
  refreshModuleWindows({ settings });
  if (!pendingWorldState) return;
  const state = pendingWorldState;
  pendingWorldState = undefined;
  showWorldState(state);
}

/** The once-a-frame refresh of everything the old whole-interface redraw still owns. */

/** Coalesces a burst of world updates into one refresh on the next animation frame. */
export function queueWorldState(state: WorldState): void {
  pendingWorldState = state;
}

export function distanceSquared(left: WorldObjectState, right: WorldObjectState | undefined): number {
  if (!left.position || !right?.position) return Number.POSITIVE_INFINITY;
  const x = left.position.x - right.position.x;
  const y = left.position.y - right.position.y;
  const z = left.position.z - right.position.z;
  return x * x + y * y + z * z;
}

export function showWorldState(state: WorldState): void {
  const player = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  worldStatus.textContent = `Объектов в памяти: ${state.objects.size}. Обновление #${state.revision}.`;
  // Death is only visible through the player's own dynamic flags, so it is refreshed here.
  showDeath();
  // Every unit frame in slice I2 — party, raid, target of target, focus, pet, bosses, arena.
  // They live on the object updates this call carries: a member's health is a field of their
  // object, and the target-of-target frame reads a field of the target that changes without the
  // target itself doing anything. `showGroup` is not called here any more; it owns the invite
  // window and the group message, and both of those are events rather than a per-frame state.
  showUnitFrames();
  // Skills live in the update fields and move as the character uses a profession.
  showProfessions();
  playerPosition.textContent = player?.position
    ? `Позиция: ${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)} · ${player.position.orientation.toFixed(2)} rad`
    : "Позиция персонажа ещё не получена.";
  renderInventory(state);
  showTarget();

  // Every visible unit needs its M2 resolved from UNIT_FIELD_DISPLAYID; the client dedupes.
  if (game.creatureModels) {
    for (const object of state.objects.values()) {
      if (object.typeId !== 3 && object.typeId !== 4) continue;
      game.creatureModels.request(object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0);
      // And its mount, which is a display id of the same table and would otherwise never be
      // asked for: `request` ignores a zero, which is what all but the mounted carry.
      game.creatureModels.request(unit.mountDisplayId(object) ?? 0);
    }
  }

  const nearby = [...state.objects.values()]
    .filter((object) => object.guid !== state.selfGuid && object.position && !isWorldObjectDead(object))
    .sort((left, right) => distanceSquared(left, player) - distanceSquared(right, player))
    .slice(0, 40);
  void loadCreatureMetadata(nearby
    .filter((object) => object.typeId === 3)
    .map((object) => object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0), state);
  // A player's name is not in its object at all — it is a query, and nothing was ever asking it
  // for the people standing next to the character. Every plate over a player therefore said
  // «Игрок». `requestName` sends at most one query per GUID for the life of the session.
  if (game.world) {
    // The character's own guid is not in `nearby` — that list is built with `guid !== selfGuid` —
    // so the one name never asked for was the player's own. Measured before this line: two queries
    // for two neighbours, none for self. The name is on the screen either way now, because
    // `displayName` reads `selfName`; what only a real answer can bring is the five Russian cases
    // in `SMSG_NAME_QUERY_RESPONSE`, which `Npc.ts` needs for a `$`-declension in gossip text and
    // which seeding the cache from the character screen would starve for ever — `shouldQuery`
    // stops asking the moment the cache holds the guid.
    if (state.selfGuid !== undefined) game.world.requestName(state.selfGuid);
    for (const object of nearby) if (object.typeId === 4) game.world.requestName(object.guid);
  }
  // Game objects get a list of their own, and they have to: the forty above is forty of
  // *everything*, and in a city creatures and players fill it before a door is reached. The
  // renderer draws game objects out to its own radius, where up to 739 of them stand — so a door
  // that never placed in the top forty of all nearby objects never learned its model at all and
  // stood there as a stand-in for as long as the player did.
  void loadGameObjectMetadata([...state.objects.values()]
    .filter((object) => object.typeId === 5 && object.position)
    .sort((left, right) => distanceSquared(left, player) - distanceSquared(right, player))
    .slice(0, GAMEOBJECT_METADATA_LIMIT)
    .map((object) => object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset) ?? 0));
  // The cards below live in the diagnostics window; building them while it is closed is waste.
  if (diagnosticsWindow.hidden) return;
  worldObjects.replaceChildren();
  if (nearby.length === 0) {
    worldObjects.textContent = "Ожидание ближайших объектов…";
    return;
  }

  for (const object of nearby) {
    const card = document.createElement("article");
    const title = document.createElement("strong");
    const details = document.createElement("span");
    const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
    const metadata = game.creatureMetadata?.get(entry);
    const level = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset);
    const health = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset);
    const maxHealth = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset);
    const position = object.position!;
    title.textContent = metadata?.name ?? `${typeNames[object.typeId ?? -1] ?? `type ${object.typeId ?? "?"}`} · entry ${entry}`;
    details.textContent = [
      `GUID 0x${object.guid.toString(16).padStart(16, "0")}`,
      level === undefined ? "" : `ур. ${level}`,
      health === undefined ? "" : `HP ${health}/${maxHealth ?? "?"}`,
      `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`,
    ].filter(Boolean).join(" · ");
    card.append(title, details);
    if (object.typeId === 3 || metadata) {
      const icon = document.createElement("img");
      icon.className = "creature-icon";
      icon.alt = "";
      setIconSource(icon, creatureIconSource(metadata, game.gatewayOrigin));
      card.prepend(icon);
    }
    if (object.typeId === 3 || object.typeId === 4) {
      const actions = document.createElement("div");
      const select = document.createElement("button");
      actions.className = "actions";
      select.type = "button";
      select.textContent = game.world?.targetGuid === object.guid ? "В цели" : "Выбрать цель";
      select.disabled = game.world?.targetGuid === object.guid;
      select.addEventListener("click", () => {
        game.world?.selectTarget(object.guid);
        showTarget();
      });
      actions.append(select);
      card.append(actions);
    }
    worldObjects.append(card);
  }
}

export async function loadCreatureMetadata(entries: number[], state: WorldState): Promise<void> {
  const client = game.creatureMetadata;
  if (!client) return;
  try {
    if (!await client.load(entries)) return;
    if (game.creatureMetadata !== client) return;
    creatureStatus.className = "success";
    creatureStatus.textContent = "Creature data: имена и семейства загружены";
    queueWorldState(state);
  } catch (error) {
    creatureStatus.className = "error";
    creatureStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

export async function loadGameObjectMetadata(displayIds: number[]): Promise<void> {
  const client = game.gameObjectMetadata;
  if (!client) return;
  try {
    await client.load(displayIds);
  } catch (error) {
    environmentStatus.className = "error";
    environmentStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}
