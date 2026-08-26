/**
 * What each plate over a head should say, gathered from wherever it actually lives.
 *
 * The split is the same one the unit frames make: `NamePlate.ts` decides how a plate looks and
 * where it goes and can be tested without a browser, and this file is the part that has to know
 * about `game` — the faction table for the colour, the name cache for players, the creature rows
 * for everything else, the raid marks, the quest giver status and the casts in flight.
 *
 * Built once a frame rather than once per unit: the raid marks arrive as icon → guid and have to
 * be turned around, and doing that inside the overlay's object loop would rebuild the map for
 * every unit on screen.
 */

import { REACTION_FRIENDLY, REACTION_NEUTRAL, UNIT_FLAGS_UNTARGETABLE } from "../../world/FactionRules.js";
import { isLootable, isTappedByOther, unit, worldObject } from "../../world/Fields.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { PLATE_RANGE, RANK_NORMAL, plateVisible, type PlateData, type PlateFilter } from "../NamePlate.js";
import { healthRatio } from "../SimpleScene.js";
import { game } from "../game/Context.js";
import { reactionTo } from "../game/Targeting.js";
import { questMarkFor } from "./QuestLog.js";
import { settingOn } from "./Settings.js";
import { ensureSpellNames, spellName } from "./SpellNames.js";
import { classColor, raidMarksByUnit } from "./UnitSnapshot.js";

/**
 * Whether the two switches are on right now.
 *
 * Friendly plates are off by default, which is the original client's default too: in a city every
 * guard, every vendor and every passer-by would carry one, and the plates would be the city.
 */
export function plateFilter(): PlateFilter {
  return { hostile: settingOn("plateEnemies"), friendly: settingOn("plateFriends") };
}

/**
 * The per-frame source the overlay draws from.
 *
 * Returns `undefined` for anything that should carry no plate at all: the character itself, a
 * spent corpse, a unit the server has flagged unclickable — a spell trigger, a totem's aura
 * anchor, a bunny — and everything the two switches exclude.
 *
 * A corpse the server still marks `UNIT_DYNFLAG_LOOTABLE` is the exception, and it is the point of
 * the whole slice: the plate is the only thing on the screen that says a body is worth walking
 * back to. Every corpse used to be dropped here, so a cleared camp looked the same whether the
 * loot had been taken or not.
 *
 * This is wider than either reference on purpose, and worth saying so. The original 3.3.5 client
 * draws no plate over a body at all, and the reference client draws one only over the body that is
 * the current target — `bool isCorpse = (unit->getHealth() == 0); if (isCorpse && !isTarget)
 * continue;` (`wowee/src/ui/game_screen_hud.cpp:979-980`). Both can afford that, because both put
 * the loot sparkle on the corpse model itself. This client has no sparkle: `WorldRenderer3D` lays
 * the body down and tints it and that is all it says, so a cleared camp of eight bodies would carry
 * eight plates here where the reference carries none. The plate is standing in for the sparkle, and
 * it goes away with the loot, so the count is the count of bodies still worth the walk.
 */
export function plateSource(now: number): (object: WorldObjectState, distance: number) => PlateData | undefined {
  const world = game.world;
  if (!world) return () => undefined;
  const filter = plateFilter();
  const marks = raidMarksByUnit(world.raidTargets);
  const selfGuid = world.state.selfGuid;
  const targetGuid = world.targetGuid;
  // One request per frame for whatever is being cast nearby, so the bar has a word on it by the
  // time the cast is half done rather than a spell id for its whole length.
  ensureSpellNames([...world.casts.values()].map((cast) => cast.spellId));

  return (object, distance) => {
    if (object.typeId !== 3 && object.typeId !== 4) return undefined;
    if (object.guid === selfGuid) return undefined;
    const dead = isWorldObjectDead(object);
    const lootable = dead && isLootable(object);
    if (dead && !lootable) return undefined;
    // The same flags Tab skips. A spell trigger, a totem's aura anchor and a quest bunny are all
    // units standing in the world with a name and a health bar, and none of them can be clicked.
    if (((unit.flags(object) ?? 0) & UNIT_FLAGS_UNTARGETABLE) !== 0) return undefined;
    const target = object.guid === targetGuid;
    const reaction = reactionTo(object);
    // A body answers to neither switch. «Show enemy plates» is a rule about a crowd of names in a
    // city, and the bag is not one of those names: the corpse in front of the player is a thing
    // they just made, and hiding it behind a setting hides the only sign the kill left.
    if (!lootable && !plateVisible({ reaction, target }, distance, filter)) return undefined;
    if (lootable && !target && distance > PLATE_RANGE) return undefined;

    const metadata = object.typeId === 3
      ? game.creatureMetadata?.get(worldObject.entry(object) ?? 0)
      : undefined;
    const cast = world.casts.get(object.guid);
    const progress = cast ? world.castProgress(object.guid, now) ?? 0 : 0;
    return {
      guid: object.guid,
      // A player whose name query has not come back yet is «Игрок» rather than its own guid in
      // hex: the plate is over the body, and the body already says which one it is.
      name: object.typeId === 4
        ? world.names.get(object.guid) ?? "Игрок"
        : metadata?.name ?? `NPC ${worldObject.entry(object) ?? 0}`,
      level: unit.level(object),
      reaction,
      classColour: object.typeId === 4 ? classColor(unit.classId(object)) : undefined,
      health: healthRatio(object),
      raidMark: marks.get(object.guid),
      questMark: questMarkFor(object.guid),
      rank: metadata?.rank ?? RANK_NORMAL,
      cast: cast ? { name: spellName(cast.spellId), progress, channel: cast.channel } : undefined,
      target,
      lootable,
      tappedByOther: isTappedByOther(object),
    };
  };
}

/**
 * The colour of the ring under a unit's feet, as a packed 24-bit number for the WebGL scene.
 *
 * The same three answers the plate gives, in the form three.js wants. Kept next to the plate
 * rather than in the renderer so a hostile ring and a hostile bar can never drift apart.
 */
export function selectionRingColour(object: WorldObjectState | undefined): number {
  if (!object) return 0xffe36e;
  const reaction = reactionTo(object);
  if (reaction === REACTION_FRIENDLY) return 0x4fd06a;
  return reaction === REACTION_NEUTRAL ? 0xe0c341 : 0xdb4b45;
}
