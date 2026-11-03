/**
 * The plate over a head, as Wow.exe draws it: measured 03.11 on the stand's client out of its own frames (every region of every
 * plate read through Lua, F:\WowOracle\tools\plates-probe.lua), with the rules read from CGNamePlateFrame (0x0098f390, 0x0098ee30,
 * 0x0098ef10, 0x0098e6e0, 0x0098e740). docs/implementation/nameplates-original.ru.md has the table.
 *
 * Decisions are worth testing and this file is the half of the work that can be: no DOM, no `game`, no world state. A plate is
 * described to it, and it says where the plate goes and paints it; the pictures come in through {@link PlateArt}.
 */

import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../world/FactionRules.js";

/** 0x00adaa7c: 1681, a square. The target has no exemption (0x0072b060). */
export const PLATE_RANGE = 41;
/** 0x00715720: the plate's top hangs off the name point raised by this many yards, and off nothing in pixels. */
export const PLATE_NAME_RAISE = 2 / 3;

/** The plate is sized against the screen's height, not the interface scale: WorldFrame is 768 units high whatever that says. */
const SCREEN_UNITS = 768;

/** 0x00b2da74 0.1 and 0x00b2da70 0.025, as Lua reads them on a 768-unit screen. */
export const PLATE_WIDTH = 156.651;
export const PLATE_HEIGHT = 39.163;
const BAR_WIDTH = 125.948;
const BAR_HEIGHT = 11.005;
const BAR_LEFT = 4.86;
const BAR_BOTTOM = 4.9;
const CAST_RIGHT = 4.895;
const CAST_BOTTOM = 4.895;
/** The second border, turned round and hung half a plate lower, so its level box is the spell's. */
const CAST_DROP = 19.58;
const NAME_SIZE = 15.665;
const LEVEL_SIZE = 14.099;
const SHADOW = 1.567;
const LEVEL_FROM_RIGHT = 14.41;
const LEVEL_FROM_BOTTOM = 11.12;
const SKULL_SIZE = 15.665;
const ICON_SIZE = 15.665;
const RAID_SIZE = 31.33;
const ELITE_WIDTH = 46.055;
const ELITE_HEIGHT = 33.68;
const ELITE_RIGHT = 4.7;
const ELITE_DOWN = 1.57;
const ELITE_U = 0.578125;
const ELITE_V = 0.84375;
const FLASH_WIDTH = 172.316;
const FLASH_HEIGHT = 45.429;
const FLASH_LEFT = 1.57;
const FLASH_DOWN = 10.18;
const FLASH_U = 0.555;
const FLASH_V0 = 0.53;
const FLASH_V1 = 0.6;
/** 127 of 255 on every plate but the target's, while there is a target. */
const DIMMED_ALPHA = 127 / 255;

export const PLATE_BORDER_TEXTURE = "Interface\\Tooltips\\Nameplate-Border.blp";
export const PLATE_SHIELD_TEXTURE = "Interface\\Tooltips\\Nameplate-CastBar-Shield.blp";
export const PLATE_GLOW_TEXTURE = "Interface\\Tooltips\\Nameplate-Glow.blp";
export const PLATE_ELITE_TEXTURE = "Interface\\Tooltips\\EliteNameplateIcon.blp";
export const PLATE_BAR_TEXTURE = "Interface\\TargetingFrame\\UI-TargetingFrame-BarFill.blp";
export const PLATE_FLASH_TEXTURE = "Interface\\TargetingFrame\\UI-TargetingFrame-Flash.blp";
export const PLATE_SKULL_TEXTURE = "Interface\\TargetingFrame\\UI-TargetingFrame-Skull.blp";
export const PLATE_RAID_TEXTURE = "Interface\\TargetingFrame\\UI-RaidTargetingIcons.blp";

/** NAMEPLATE_FONT: Fonts\FRIZQT__.TTF on this client, which NativeUiSkin publishes under this family. */
const PLATE_FONT = '"WoW Friz", "Trebuchet MS", sans-serif';

/** Creature ranks, as `creature_template.rank` numbers them. */
export const RANK_NORMAL = 0;
export const RANK_ELITE = 1;
export const RANK_RARE_ELITE = 2;
export const RANK_BOSS = 3;
export const RANK_RARE = 4;

/**
 * What one plate says. Everything is already resolved: this file never asks the world anything.
 *
 * Health stays optional: a missing server value must not become an invented full or empty bar.
 */
export interface PlateData {
  guid: bigint;
  name: string;
  level: number | undefined;
  /** The player's own level, which a level's colour and the skull are measured from. */
  playerLevel?: number | undefined;
  /** `REACTION_*`. Undefined while the faction table is still on its way. */
  reaction: number | undefined;
  /**
   * 5.05 (12.10): the unit's view of the player (`Targeting.unitReactionToPlayer`), which the colour reads — Wow.exe
   * 0x0098ee30 paints a plate by `0x007251c0(unit, player)`. Absent: `reaction`. Which switch shows the plate
   * (`plateVisible`) still reads `reaction`.
   */
  colourReaction?: number | undefined;
  isPlayer?: boolean | undefined;
  /** A hostile player's class colour, and only with ShowClassColorInNameplate on. */
  classColour: string | undefined;
  /** 0 to 1, or undefined for a unit whose health the server has not sent. */
  health: number | undefined;
  /** 0 to 7 when the unit wears a raid mark. */
  raidMark: number | undefined;
  /** `creature_template.rank`: 1 elite, 2 rare elite, 3 world boss, 4 rare. */
  rank: number;
  /** CREATURE_TYPE_FLAG_BOSS (4, 0x00715d70): what the skull and the dragon go by, not the rank. */
  boss?: boolean | undefined;
  /** The target's cast (ShowVKeyCastbar). `progress` is how full the bar is: `WorldClient.castProgress` turned a channel round. */
  cast: { iconPath: string | undefined; progress: number; shielded?: boolean | undefined } | undefined;
  /** The player's own current target: drawn last and at full strength. */
  target: boolean;
  /** There is a target and this is not it. */
  dimmed?: boolean | undefined;
  /** Under the mouse: Nameplate-Glow, added. */
  hovered?: boolean | undefined;
  /** UnitThreatSituation of the player on this unit; 2 and 3 light the flash (0x0098eb18). */
  threat?: number | undefined;
  /** The name point (0x0071fef0) in the world as drawn, where the renderer knows it. */
  namePoint?: { x: number; y: number; z: number } | undefined;
}

export interface PlateBox {
  /** Left edge, in CSS pixels of the overlay. */
  x: number;
  /** Top edge. */
  y: number;
  width: number;
  height: number;
  /** Pixels to a unit of the 768-high screen. */
  scale: number;
}

/**
 * Which units are worth a plate.
 *
 * The two switches are the original client's two: enemies and friends, each on its own. Neutral
 * counts as an enemy here because that is what the colour says and what Tab does with it — a
 * critter is neutral, and so is every quest mob before it notices you.
 */
export interface PlateFilter {
  hostile: boolean;
  friendly: boolean;
}

export function plateVisible(data: Pick<PlateData, "reaction">, distance: number, filter: PlateFilter): boolean {
  if (distance > PLATE_RANGE) return false;
  return data.reaction === REACTION_FRIENDLY ? filter.friendly : filter.hostile;
}

/**
 * The colour of the health bar (0x0098ee30): red for the hostile, or their class with ShowClassColorInNameplate on; among the rest
 * blue for a player, green for a friend, yellow otherwise. Somebody else's kill changes nothing: measured on a tapped creature with
 * UnitIsTapped true, the bar stays red.
 */
export function plateColour(data: Pick<PlateData, "reaction" | "classColour" | "isPlayer" | "colourReaction">): string {
  const reaction = data.colourReaction ?? data.reaction;
  if (reaction === REACTION_HOSTILE) return data.classColour ?? "#ff0000";
  if (data.isPlayer) return "#0000ff";
  return reaction === REACTION_FRIENDLY ? "#00ff00" : "#ffff00";
}

/** 0x00aa34b8, by the player's level over five: how far below it a level is still green. */
const GREEN_RANGE = [4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8];

/** A level's colour against the player's (0x0098e5f0). Before the player's level is known, the middle of it. */
export function plateLevelColour(level: number, playerLevel: number | undefined): string {
  if (playerLevel === undefined) return "#ffff00";
  const difference = level - playerLevel;
  if (difference >= 5) return "#ff1919";
  if (difference >= 3) return "#ff7f3f";
  if (difference >= -2) return "#ffff00";
  const green = GREEN_RANGE[Math.trunc(playerLevel / 5)] ?? 8;
  return -difference <= green ? "#3fb23f" : "#7f7f7f";
}

/** The skull instead of the number (0x0098ef10): a boss, or something hostile ten levels above the player. */
export function plateShowsSkull(data: Pick<PlateData, "boss" | "level" | "playerLevel" | "reaction" | "colourReaction">): boolean {
  if (data.boss) return true;
  if ((data.colourReaction ?? data.reaction) !== REACTION_HOSTILE) return false;
  return data.level !== undefined && data.playerLevel !== undefined && data.level - 10 >= data.playerLevel;
}

/** The dragon round the level (0x0098e6e0): a boss, an elite, a rare elite. A rare alone has none. */
export function plateShowsElite(data: Pick<PlateData, "boss" | "rank">): boolean {
  return data.boss === true || data.rank === RANK_ELITE || data.rank === RANK_RARE_ELITE;
}

/**
 * Where a plate sits, given where its anchor projected to: the name point raised by {@link PLATE_NAME_RAISE}. The plate hangs from
 * there and keeps its size on screen, so a far unit's plate comes down over the model, as it does in Wow.exe.
 */
export function plateLayout(x: number, anchorY: number, screenHeight: number): PlateBox {
  const scale = screenHeight / SCREEN_UNITS;
  const width = PLATE_WIDTH * scale;
  return { x: x - width / 2, y: anchorY, width, height: PLATE_HEIGHT * scale, scale };
}

export interface StackedPlate {
  box: PlateBox;
  /** Distance from the camera. The nearer plate keeps its place and the further one moves. */
  depth: number;
}

/**
 * Pushes overlapping plates apart, upwards: nameplateAllowOverlap off, the "(old) never overlapping version" as the client calls
 * it. The default is on, and there plates simply overlap. The nearer one keeps its place, because it is the one the player is
 * looking at, and because any other rule makes the whole stack jump as the camera turns.
 *
 * Mutates the boxes it is given and returns the list it was given, in that order.
 */
export function stackPlates(plates: readonly StackedPlate[]): readonly StackedPlate[] {
  const placed: PlateBox[] = [];
  for (const plate of [...plates].sort((left, right) => left.depth - right.depth)) {
    const box = plate.box;
    // Visit lower plates before higher ones. A shove above a higher plate cannot re-enter a
    // lower one, so each placed box is tested at most once. In depth order a vertical chain
    // needed one full rescan per shove, giving cubic work in a crowded view.
    for (const other of placed) {
      if (box.x + box.width <= other.x || other.x + other.width <= box.x) continue;
      if (box.y >= other.y + other.height || box.y + box.height <= other.y) continue;
      box.y = other.y - box.height - 2;
    }

    // Keep the settled boxes in descending screen-y order without sorting the growing list
    // again. Near-first admission above still decides whose original anchor takes precedence.
    let low = 0;
    let high = placed.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (placed[middle]!.y > box.y) low = middle + 1;
      else high = middle;
    }
    placed.splice(low, 0, box);
  }
  return plates;
}

export type PlateImage = CanvasImageSource & { readonly width: number; readonly height: number };

/** Where the pictures come from: none of them may be there yet, and a plate is drawn without what has not landed. */
export interface PlateArt {
  image(path: string): PlateImage | undefined;
  /** The picture multiplied by a colour, as a vertex colour would. */
  tinted(path: string, colour: string): PlateImage | undefined;
  /** 6.38: a picture drawn by adding it, with {@link alphaFromBrightness} applied. */
  added(path: string): PlateImage | undefined;
}

const NO_ART: PlateArt = { image: () => undefined, tinted: () => undefined, added: () => undefined };

/**
 * 6.38: a picture for adding onto the plates' transparent layer, in place, as straight RGBA.
 *
 * Nameplate-Glow has no alpha: light on black, and Wow.exe adds it to the screen, where black adds
 * nothing. A 2D canvas's `lighter` also adds alpha, so on a layer that is transparent everywhere but
 * the plate its black came out as an opaque rectangle. Each pixel's brightness becomes its alpha and
 * the colour is lifted to match, so the premultiplied sum is the picture's own light and black is nothing.
 */
export function alphaFromBrightness(pixels: Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]! / 255;
    const brightness = Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) * alpha;
    if (brightness > 0) {
      const lift = (255 * alpha) / brightness;
      pixels[i] = pixels[i]! * lift;
      pixels[i + 1] = pixels[i + 1]! * lift;
      pixels[i + 2] = pixels[i + 2]! * lift;
    }
    pixels[i + 3] = brightness;
  }
}

/** 0x0061a4f0's table: what a threat status lights the flash with. */
const THREAT_COLOURS: Readonly<Record<number, string>> = { 2: "#ff9900", 3: "#ff0000" };

/** A status bar's fill: the texture cut at the bar's value, not squeezed into it. */
function drawBar(
  context: CanvasRenderingContext2D, art: PlateArt, x: number, y: number, width: number, height: number, ratio: number, colour: string,
): void {
  const fill = Math.max(0, Math.min(1, ratio));
  if (fill <= 0) return;
  const image = art.tinted(PLATE_BAR_TEXTURE, colour);
  if (image) {
    context.drawImage(image, 0, 0, image.width * fill, image.height, x, y, width * fill, height);
  } else {
    context.fillStyle = colour;
    context.fillRect(x, y, width * fill, height);
  }
}

/** A font string with its shadow: the same text in black, a little right and down. */
function drawText(
  context: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, scale: number, colour: string,
): void {
  context.font = `${size * scale}px ${PLATE_FONT}`;
  context.fillStyle = "#000000";
  context.fillText(text, x + SHADOW * scale, y + SHADOW * scale);
  context.fillStyle = colour;
  context.fillText(text, x, y);
}

/**
 * One plate, painted, in the order of the frame's layers: the bars under it, then BACKGROUND, BORDER, ARTWORK, OVERLAY, HIGHLIGHT.
 * Nothing here reads a clock: a cast arrives as a fraction.
 */
export function drawPlate(context: CanvasRenderingContext2D, box: PlateBox, data: PlateData, art: PlateArt = NO_ART): void {
  const s = box.scale;
  const left = box.x;
  const top = box.y;
  const right = left + box.width;
  const bottom = top + box.height;
  const castTop = top + CAST_DROP * s;
  const castBottom = castTop + box.height;
  context.save();
  context.globalAlpha = data.dimmed ? DIMMED_ALPHA : 1;

  // The bars, a level under the frame's own regions.
  if (data.health !== undefined) {
    drawBar(context, art, left + BAR_LEFT * s, bottom - (BAR_BOTTOM + BAR_HEIGHT) * s, BAR_WIDTH * s, BAR_HEIGHT * s,
      data.health, plateColour(data));
  }
  if (data.cast) {
    // 0x0098f112: (1, 0.7, 0), a cast and a channel alike.
    drawBar(context, art, right - (CAST_RIGHT + BAR_WIDTH) * s, castBottom - (CAST_BOTTOM + BAR_HEIGHT) * s, BAR_WIDTH * s, BAR_HEIGHT * s,
      data.cast.progress, "#ffb300");
  }

  // BACKGROUND: the threat flash, a piece of the target frame's.
  const flashColour = data.threat === undefined ? undefined : THREAT_COLOURS[data.threat];
  if (flashColour) {
    const flash = art.tinted(PLATE_FLASH_TEXTURE, flashColour);
    if (flash) {
      const width = FLASH_WIDTH * s;
      context.drawImage(flash, 0, FLASH_V0 * flash.height, FLASH_U * flash.width, (FLASH_V1 - FLASH_V0) * flash.height,
        left + box.width / 2 - FLASH_LEFT * s - width / 2, top + FLASH_DOWN * s, width, FLASH_HEIGHT * s);
    }
  }

  const levelX = right - LEVEL_FROM_RIGHT * s;
  const levelY = bottom - LEVEL_FROM_BOTTOM * s;
  // BORDER: the dragon, under the border and round the level.
  if (plateShowsElite(data)) {
    const elite = art.image(PLATE_ELITE_TEXTURE);
    if (elite) {
      const width = ELITE_WIDTH * s;
      const height = ELITE_HEIGHT * s;
      context.drawImage(elite, 0, 0, ELITE_U * elite.width, ELITE_V * elite.height,
        levelX + ELITE_RIGHT * s - width / 2, levelY + ELITE_DOWN * s - height / 2, width, height);
    }
  }

  // ARTWORK: the border over the bar, the same picture turned round under it for a cast, the mark, the words.
  const border = art.image(PLATE_BORDER_TEXTURE);
  if (border) context.drawImage(border, left, top, box.width, box.height);
  if (data.cast) {
    if (data.cast.shielded) {
      const shield = art.image(PLATE_SHIELD_TEXTURE);
      if (shield) context.drawImage(shield, left, castTop, box.width, box.height);
    } else if (border) {
      context.save();
      context.translate(right, castTop);
      context.scale(-1, 1);
      context.drawImage(border, 0, 0, box.width, box.height);
      context.restore();
    }
  }
  if (data.raidMark !== undefined && data.raidMark >= 0 && data.raidMark < 8) {
    // 0x0098e740: a four by four sheet, the mark's low bits across.
    const sheet = art.image(PLATE_RAID_TEXTURE);
    if (sheet) {
      const size = RAID_SIZE * s;
      const cellWidth = sheet.width / 4;
      const cellHeight = sheet.height / 4;
      context.drawImage(sheet, (data.raidMark & 3) * cellWidth, (data.raidMark >> 2) * cellHeight, cellWidth, cellHeight,
        left - size, top + (box.height - size) / 2, size, size);
    }
  }
  context.textAlign = "center";
  context.textBaseline = "bottom";
  drawText(context, data.name, left + box.width / 2, top + box.height / 2, NAME_SIZE, s, "#ffffff");
  const skull = plateShowsSkull(data);
  if (!skull && data.level !== undefined) {
    context.textBaseline = "middle";
    drawText(context, `${data.level}`, levelX, levelY, LEVEL_SIZE, s, plateLevelColour(data.level, data.playerLevel));
  }

  // OVERLAY: the skull in the level's place, the spell in the turned border's level box.
  if (skull) {
    const picture = art.image(PLATE_SKULL_TEXTURE);
    const size = SKULL_SIZE * s;
    if (picture) context.drawImage(picture, levelX - size / 2, levelY - size / 2, size, size);
  }
  if (data.cast?.iconPath) {
    const icon = art.image(data.cast.iconPath);
    const size = ICON_SIZE * s;
    if (icon) {
      context.drawImage(icon, left + LEVEL_FROM_RIGHT * s - size / 2, castBottom - LEVEL_FROM_BOTTOM * s - size / 2, size, size);
    }
  }

  // HIGHLIGHT: the glow, added to the plate under the mouse.
  if (data.hovered) {
    const glow = art.added(PLATE_GLOW_TEXTURE); // 6.38: `added`, was `image`
    if (glow) {
      context.globalCompositeOperation = "lighter";
      context.drawImage(glow, left, top, box.width, box.height);
    }
  }
  context.restore();
}
