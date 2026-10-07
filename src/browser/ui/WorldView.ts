import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { runFrameTasks } from "../../transport/PacketPump.js";
import { player } from "../../world/Fields.js";
import { WorldObjectState, WorldState, isWorldObjectDead } from "../../world/WorldState.js";
import { creatureIconSource } from "../CreatureMetadata.js";
import { sweepUnitModels } from "../UnitModelRequests.js"; // P1-20c (corpses: 05.10-A7a-G2 6.05)
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
 * How often the sorted prefetch lists below are rebuilt.
 *
 * `showWorldState` runs on every packet, and packets stream constantly while moving through a
 * populated area — but metadata fetching is async anyway, so sorting the whole object table
 * sixty times a second to decide what to ask for is pure overhead. The visible UI above stays
 * per-packet; only the prefetch sorts wait. The first call always runs (the name-query test
 * pins that the player's own query goes out synchronously).
 */
const PREFETCH_INTERVAL_MS = 250;
let lastPrefetchAt = Number.NEGATIVE_INFINITY;
/** Last computed nearby list, reused by the diagnostics cards between prefetch runs. */
let lastNearby: WorldObjectState[] = [];

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
  // Then the refreshes packets queued (`queueFrameTask`), also outside the guard: an aura or a name
  // answer need not have queued a world state of its own. Before `showWorldState`, so a refresh
  // that queues one is shown on this frame.
  runFrameTasks();
  // The diagnostics lines are kept only while their window is open; one that has just opened (the
  // game menu opens it without a redraw) shows them now rather than at the next world update.
  const diagnosticsOpen = !diagnosticsWindow.hidden;
  const opened = diagnosticsOpen && !diagnosticsShown;
  diagnosticsShown = diagnosticsOpen;
  if (!pendingWorldState) {
    const world = game.world;
    if (opened && world) {
      const self = world.state.selfGuid;
      showWorldStatusLines(world.state, self === undefined ? undefined : world.state.objects.get(self));
    }
    return;
  }
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

/**
 * The diagnostics window's two lines about the world: the object count and revision, and where the
 * character stands. Both change with every update and every step, and both live in a window that is
 * closed nearly always — and the first is a live region — so they are written only while it is
 * open, and once more when it opens (`drainWorldState`).
 */
function showWorldStatusLines(state: WorldState, player: WorldObjectState | undefined): void {
  const worldText = `Объектов в памяти: ${state.objects.size}. Обновление #${state.revision}.`;
  if (worldStatus.textContent !== worldText) worldStatus.textContent = worldText;
  const positionText = player?.position
    ? `Позиция: ${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)} · ${player.position.orientation.toFixed(2)} rad`
    : "Позиция персонажа ещё не получена.";
  if (playerPosition.textContent !== positionText) playerPosition.textContent = positionText;
}

/** Whether the diagnostics window was open at the last drain; see `showWorldStatusLines`. */
let diagnosticsShown = false;

export function showWorldState(state: WorldState): void {
  const player = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  if (!diagnosticsWindow.hidden) showWorldStatusLines(state, player);
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
  renderInventory(state);
  showTarget();

  // The sorted prefetch below is throttled (see PREFETCH_INTERVAL_MS): the lists only decide
  // what async metadata to ask for, and rebuilding them per packet costs two full sorts.
  if (performance.now() - lastPrefetchAt >= PREFETCH_INTERVAL_MS) {
    lastPrefetchAt = performance.now();
    // Every visible unit needs its M2 resolved from UNIT_FIELD_DISPLAYID. P1-20c: the store's events
    // ask for new units, display ids and mounts as they land (`bindUnitModelRequests`); this sweep
    // is the net under them — objects from before the binding, corpses, the client's retry ladder.
    if (game.creatureModels) sweepUnitModels(state, game.creatureModels);
    const nearby = [...state.objects.values()]
      .filter((object) => object.guid !== state.selfGuid && object.position && !isWorldObjectDead(object))
      .sort((left, right) => distanceSquared(left, player) - distanceSquared(right, player))
      .slice(0, 40);
    lastNearby = nearby;
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
  }
  // The cards below live in the diagnostics window; building them while it is closed is waste.
  if (diagnosticsWindow.hidden) return;
  worldObjects.replaceChildren();
  if (lastNearby.length === 0) {
    worldObjects.textContent = "Ожидание ближайших объектов…";
    return;
  }

  for (const object of lastNearby) {
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
