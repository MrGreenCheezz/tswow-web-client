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

import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL, UNIT_FLAGS_UNTARGETABLE } from "../../world/FactionRules.js";
import { unit, worldObject } from "../../world/Fields.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { RANK_NORMAL, plateVisible, type PlateArt, type PlateData, type PlateFilter, type PlateImage } from "../NamePlate.js";
import { UNIT_NAME_X, UNIT_NAME_Y, UNIT_NAME_Z, resultUnitNamePoint } from "../RenderResults.js"; // 03.11 6.37
import { threatStanding } from "../framexml/FrameXmlThreat.js"; // 03.11 6.37
import { settledHoveredUnitGuid } from "../game/HoverTarget.js"; // 03.11 6.37
import { healthRatio } from "../SimpleScene.js";
import { game } from "../game/Context.js";
import { reactionBetween, reactionTo, unitReactionToPlayer } from "../game/Targeting.js"; // 5.05 (12.10): unitReactionToPlayer
import type { FactionClient } from "../FactionClient.js";
import { settingOn } from "./Settings.js";
import { ensureSpellNames } from "./SpellNames.js";
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

/** 0x0072b060: CREATURE_TYPE_FLAG_NO_NAME_PLATE. */
const TYPE_FLAG_NO_NAME_PLATE = 0x100000;
/** 0x00715d70: CREATURE_TYPE_FLAG_BOSS. */
const TYPE_FLAG_BOSS = 4;

/** An icon path as the spell table has it: no extension, and the texture route wants one. */
function iconTexture(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return /\.blp$/i.test(path) ? path : `${path}.blp`;
}

/**
 * The per-frame source the overlay draws from.
 *
 * Returns `undefined` for anything that carries no plate: the character itself, the dead (0x0072b060: health under 1, so a body
 * has none, its loot beam says what the plate used to), a unit the server has flagged unclickable — a spell trigger, a totem's aura
 * anchor, a bunny — a creature whose template refuses one, and everything the two switches exclude.
 */
export function plateSource(now: number): (object: WorldObjectState, distance: number) => PlateData | undefined {
  const world = game.world;
  if (!world) return () => undefined;
  const filter = plateFilter();
  const marks = raidMarksByUnit(world.raidTargets);
  const selfGuid = world.state.selfGuid;
  const targetGuid = world.targetGuid;
  const self = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
  const playerLevel = self ? unit.level(self) : undefined;
  const hovered = settledHoveredUnitGuid(world);
  const results = game.renderer?.results;
  const castBars = settingOn("plateCastBars");
  const classColours = settingOn("plateClassColours");

  return (object, distance) => {
    if (object.typeId !== 3 && object.typeId !== 4) return undefined;
    if (object.guid === selfGuid) return undefined;
    if (isWorldObjectDead(object)) return undefined;
    // The same flags Tab skips. A spell trigger, a totem's aura anchor and a quest bunny are all
    // units standing in the world with a name and a health bar, and none of them can be clicked.
    if (((unit.flags(object) ?? 0) & UNIT_FLAGS_UNTARGETABLE) !== 0) return undefined;
    const target = object.guid === targetGuid;
    const reaction = reactionTo(object);
    if (!plateVisible({ reaction }, distance, filter)) return undefined;

    const entry = worldObject.entry(object) ?? 0;
    const typeFlags = object.typeId === 3 ? world.creatureTemplates.get(entry)?.flags ?? 0 : 0;
    if ((typeFlags & TYPE_FLAG_NO_NAME_PLATE) !== 0) return undefined;
    const metadata = object.typeId === 3 ? game.creatureMetadata?.get(entry) : undefined;
    const colourReaction = unitReactionToPlayer(object); // 5.05 (12.10): 0x0098ee30 — the unit's view of the player
    const cast = target && castBars ? world.casts.get(object.guid) : undefined;
    if (cast) ensureSpellNames([cast.spellId]);
    const row = resultUnitNamePoint(results, object.guid);
    const table = selfGuid === undefined ? undefined : world.threat.get(object.guid);
    return {
      guid: object.guid,
      // A player whose name query has not come back yet is «Игрок» rather than its own guid in
      // hex: the plate is over the body, and the body already says which one it is.
      name: object.typeId === 4
        ? world.names.get(object.guid) ?? "Игрок"
        : metadata?.name ?? `NPC ${entry}`,
      level: unit.level(object),
      playerLevel,
      reaction,
      colourReaction,
      isPlayer: object.typeId === 4,
      classColour: classColours && object.typeId === 4 && colourReaction === REACTION_HOSTILE ? classColor(unit.classId(object)) : undefined,
      health: healthRatio(object),
      raidMark: marks.get(object.guid),
      rank: metadata?.rank ?? RANK_NORMAL,
      boss: (typeFlags & TYPE_FLAG_BOSS) !== 0,
      cast: cast ? {
        iconPath: iconTexture(game.spells.get(cast.spellId)?.iconPath),
        progress: world.castProgress(object.guid, now) ?? 0,
      } : undefined,
      target,
      dimmed: targetGuid !== undefined && targetGuid !== 0n && !target,
      hovered: hovered === object.guid,
      threat: table && selfGuid !== undefined ? threatStanding(table, selfGuid)?.status : undefined,
      namePoint: row ? { x: row[UNIT_NAME_X]!, y: row[UNIT_NAME_Y]!, z: row[UNIT_NAME_Z]! } : undefined,
    };
  };
}

/** A picture multiplied by a colour once, then kept: three or four colours of a handful of pictures. */
const tintedPictures = new Map<string, PlateImage | null>();

function tintedPicture(source: PlateImage, key: string, colour: string): PlateImage | undefined {
  const known = tintedPictures.get(key);
  if (known !== undefined) return known ?? undefined;
  if (typeof OffscreenCanvas !== "function") {
    tintedPictures.set(key, null);
    return undefined;
  }
  const canvas = new OffscreenCanvas(source.width, source.height);
  const context = canvas.getContext("2d");
  if (!context) {
    tintedPictures.set(key, null);
    return undefined;
  }
  context.drawImage(source, 0, 0);
  context.globalCompositeOperation = "multiply";
  context.fillStyle = colour;
  context.fillRect(0, 0, source.width, source.height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(source, 0, 0);
  tintedPictures.set(key, canvas);
  return canvas;
}

/** The plate's pictures: the client's own, through the same cache as the minimap's. */
export const plateArt: PlateArt = {
  image: (path) => game.mapArt?.bitmap(path),
  tinted: (path, colour) => {
    const source = game.mapArt?.bitmap(path);
    return source ? tintedPicture(source, `${path}|${colour}`, colour) : undefined;
  },
};

/**
 * The colour of the ring under a unit's feet, as a packed 24-bit number for the WebGL scene.
 *
 * The same three answers the plate gives, in the form three.js wants. Kept next to the plate
 * rather than in the renderer so a hostile ring and a hostile bar can never drift apart.
 *
 * 5.05 (12.10): the selection colour is the unit's view of the player — Wow.exe 0x00521bf0 indexes its table by
 * `0x007251c0(unit, player)` — so `reactionBetween` is asked with the unit first (was the player first). This
 * captured form reads the template masks and forced reactions; the live wrapper adds the reputation rules.
 */
export function selectionRingColourFor(
  object: WorldObjectState | undefined,
  self: WorldObjectState | undefined,
  factions: FactionClient | undefined,
): number {
  if (!object) return 0xffe36e;
  return ringColourOf(self === undefined ? REACTION_NEUTRAL : reactionBetween(object, self, factions)); // 5.05 (12.10)
}

/** The live wrapper retains the current world and faction client. */
export function selectionRingColour(object: WorldObjectState | undefined): number {
  if (!object) return 0xffe36e;
  return ringColourOf(unitReactionToPlayer(object)); // 5.05 (12.10): was the player's view (`reactionBetween(self, object)`)
}

/** 5.05 (12.10): one reaction as the ring's colour. */
function ringColourOf(reaction: number): number {
  if (reaction === REACTION_FRIENDLY) return 0x4fd06a;
  return reaction === REACTION_NEUTRAL ? 0xe0c341 : 0xdb4b45;
}
