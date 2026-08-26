/**
 * The plate over a head: who that is, how much of them is left, and what they are casting.
 *
 * Split out of `SimpleScene` because it stopped being a decoration. The old plate was a bar and a
 * name drawn inline in the middle of the overlay's object loop; slice R6 adds a cast bar, the
 * eight raid marks, the elite ranks and a rule about which units get a plate at all, and every one
 * of those is a decision rather than a rectangle. Decisions are worth testing, and this file is
 * the half of the work that can be: no DOM, no `game`, no world state — a plate is described to
 * it, and it says where the plate goes and paints it.
 *
 * The projection stays where it was. `SimpleScene` already shares its camera intrinsics with the
 * WebGL scene to the pixel, so a plate anchored to a head sits on that head; nothing here needs to
 * know how that happened.
 */

import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../world/FactionRules.js";

/**
 * How far a plate is drawn, in yards.
 *
 * The original client's own limit, and it is not a rendering budget: plates stop at forty yards
 * because that is roughly where one stops meaning anything — it grows wider than the gap between
 * two units standing side by side, and the screen fills with names for things nobody is going to
 * fight. The player's own target is exempt below.
 */
export const PLATE_RANGE = 41;

/** Plates keep one size on screen, the way the original client's do. */
export const PLATE_WIDTH = 104;
export const PLATE_NAME_HEIGHT = 13;
export const PLATE_BAR_HEIGHT = 8;
export const PLATE_CAST_HEIGHT = 6;
/** The gap between the crown of the head and the bottom of the plate. */
export const PLATE_GAP = 10;
/** The target's plate is drawn slightly larger, which is how the original client marks it. */
export const PLATE_TARGET_SCALE = 1.15;

/** Creature ranks, as `creature_template.rank` numbers them. */
export const RANK_NORMAL = 0;
export const RANK_ELITE = 1;
export const RANK_RARE_ELITE = 2;
export const RANK_BOSS = 3;
export const RANK_RARE = 4;

/**
 * What one plate says. Everything is already resolved: this file never asks the world anything.
 *
 * `health` is a fraction rather than a pair of numbers because a plate has no room for numbers,
 * and because a unit seen only through `SMSG_PARTY_MEMBER_STATS` has no maximum worth printing.
 */
export interface PlateData {
  guid: bigint;
  name: string;
  level: number | undefined;
  /** `REACTION_*`. Undefined while the faction table is still on its way. */
  reaction: number | undefined;
  /** A player's class colour: players are coloured by class, everything else by reaction. */
  classColour: string | undefined;
  /** 0 to 1, or undefined for a unit whose health the server has not sent. */
  health: number | undefined;
  /** 0 to 7 when the unit wears a raid mark. */
  raidMark: number | undefined;
  /** `!` or `?`, from the quest giver status. */
  questMark: string | undefined;
  /** `creature_template.rank`: 1 elite, 2 rare elite, 3 world boss, 4 rare. */
  rank: number;
  /**
   * What is being cast, if anything.
   *
   * `progress` is how full the bar should be and not how far through the cast the unit is: the two
   * are the same number for a cast and opposite ones for a channel, and `WorldClient.castProgress`
   * has already turned it round. Inverting it a second time here made the plate's bar run backwards
   * against the target frame's bar for the same spell.
   */
  cast: { name: string; progress: number; channel: boolean } | undefined;
  /** The player's own current target, which is drawn larger and framed. */
  target: boolean;
  /**
   * A body the server still shows loot on: `UNIT_DYNFLAG_LOOTABLE`, and nothing inferred.
   *
   * The plate a corpse gets is not the plate a unit gets. There is no health left to draw — the
   * bar would be a full-width empty rectangle over every body in a cleared camp — and no level
   * worth reading off something that cannot be fought, so this plate is the name and the bag.
   */
  lootable: boolean;
  /**
   * Somebody else's kill: `TAPPED` without `TAPPED_BY_PLAYER`, the pair the core writes per
   * viewer. Greys the bar, as the original client does and the reference client after it
   * (`wowee/src/ui/game_screen_hud.cpp:1025-1030`).
   */
  tappedByOther: boolean;
}

export interface PlateBox {
  /** Left edge of the bar block, in CSS pixels of the overlay. */
  x: number;
  /** Top edge of the name row. */
  y: number;
  width: number;
  height: number;
  /** How much the whole plate is scaled: only the target's is not 1. */
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

export function plateVisible(
  data: Pick<PlateData, "reaction" | "target">,
  distance: number,
  filter: PlateFilter,
): boolean {
  // The target always keeps its plate: the ring under its feet is drawn at any distance, and a
  // ring with no name over it is the one combination that tells the player nothing.
  if (data.target) return true;
  if (distance > PLATE_RANGE) return false;
  return data.reaction === REACTION_FRIENDLY ? filter.friendly : filter.hostile;
}

/**
 * The colour of the health bar.
 *
 * Someone else's kill comes first and answers "not yours" before anything else the colour could
 * say, and a creature already tapped is not a creature to open on. Ahead of the reaction is where
 * the original client puts it: `TargetFrame_CheckFaction` greys the name background and the
 * portrait on the tap test alone and reaches `UnitSelectionColor` — the reaction — only in the
 * `else` (`Interface/FrameXML/TargetFrame.lua:261-272`, read out of the 3.3.5a archives).
 *
 * The reference client reads the same two bits and reads them somewhere else: its tap test lives
 * *inside* the hostile branch — `:1020` is `if (isCorpse)`, `:1024` is `} else if (isHostile) {`
 * and the pair is at `:1027-1030` (`wowee/src/ui/game_screen_hud.cpp`) — so a friendly or neutral
 * creature that somebody else killed keeps its own colour there and goes grey here. The difference
 * is real and this file follows the original: `hasLootRecipient()` sets `TAPPED` whatever the
 * faction of the thing killed (`Unit.cpp:14747-14749`), so the bit means "not yours" and nothing
 * about who it belonged to.
 *
 * Then reaction, and class only third, which is the opposite of a unit frame: a plate answers "can
 * I hit that", and a hostile warlock is red before it is purple. A friendly *player* is the one
 * case where the class colour wins, because there the question is "who is that".
 */
export function plateColour(
  data: Pick<PlateData, "reaction" | "classColour"> & Partial<Pick<PlateData, "tappedByOther">>,
): string {
  if (data.tappedByOther) return "#8d9298";
  if (data.reaction === REACTION_HOSTILE) return "#c5423d";
  if (data.reaction === REACTION_FRIENDLY) return data.classColour ?? "#3fae5a";
  return "#d8bb3f";
}

/**
 * The level, as the plate writes it.
 *
 * A world boss is `??` — the original client shows a skull there, and for the same reason: the
 * number is not the useful part of "you cannot win this". Everything else prints its level, and an
 * elite carries the `+` the target frame already uses.
 */
export function plateLevelText(level: number | undefined, rank: number): string {
  if (rank === RANK_BOSS) return "??";
  if (level === undefined) return "";
  if (rank === RANK_ELITE || rank === RANK_RARE_ELITE) return `${level}+`;
  return `${level}`;
}

/** The mark a rank puts in front of the name, or nothing for an ordinary creature. */
export function plateRankMark(rank: number): string {
  if (rank === RANK_RARE || rank === RANK_RARE_ELITE) return "★";
  if (rank === RANK_BOSS) return "☠";
  return "";
}

/**
 * Where a plate sits, given where the crown of the head projected to.
 *
 * A lootable corpse is the one plate with no bar under the name: `lootable` shortens the box to
 * the name row alone, and `drawPlate` puts the bag where the bar would have been.
 */
export function plateLayout(
  data: Pick<PlateData, "cast" | "target"> & Partial<Pick<PlateData, "lootable">>,
  x: number,
  headY: number,
): PlateBox {
  const scale = data.target ? PLATE_TARGET_SCALE : 1;
  const width = PLATE_WIDTH * scale;
  const height = data.lootable
    ? PLATE_NAME_HEIGHT * scale
    : (PLATE_NAME_HEIGHT + PLATE_BAR_HEIGHT + (data.cast ? PLATE_CAST_HEIGHT + 1 : 0)) * scale;
  return { x: x - width / 2, y: headY - PLATE_GAP * scale - height, width, height, scale };
}

export interface StackedPlate {
  box: PlateBox;
  /** Distance from the camera. The nearer plate keeps its place and the further one moves. */
  depth: number;
}

/**
 * Pushes overlapping plates apart, upwards.
 *
 * Two units standing on the same spot used to draw two bars over each other, and the result read
 * as one bar at some third value. The original client solves it the same way: plates stack rather
 * than overlap. The nearer one keeps its place, because it is the one the player is looking at,
 * and because any other rule makes the whole stack jump as the camera turns.
 *
 * Mutates the boxes it is given and returns the list it was given, in that order.
 */
export function stackPlates(plates: readonly StackedPlate[]): readonly StackedPlate[] {
  const placed: PlateBox[] = [];
  for (const plate of [...plates].sort((left, right) => left.depth - right.depth)) {
    const box = plate.box;
    let moved = true;
    // One shove can push a plate back into another it had already cleared, so this repeats until
    // a pass changes nothing. It is bounded: every pass either stops, or lifts the plate above one
    // more of the plates already placed.
    for (let pass = 0; moved && pass <= placed.length; pass++) {
      moved = false;
      for (const other of placed) {
        if (box.x + box.width <= other.x || other.x + other.width <= box.x) continue;
        if (box.y >= other.y + other.height || box.y + box.height <= other.y) continue;
        box.y = other.y - box.height - 2;
        moved = true;
      }
    }
    placed.push(box);
  }
  return plates;
}

/** The eight raid marks in the sheet's own colours, in the order the server numbers them. */
export const RAID_MARK_COLOURS = [
  "#ffe04a", "#ff9a30", "#b45cd8", "#4cd94c", "#dfe3ee", "#3f8fdd", "#e04141", "#f0ece0",
];

/**
 * One raid mark, drawn rather than fetched.
 *
 * `UI-RaidTargetingIcons.blp` is one sheet in the client's `Interface` archive, and reaching it
 * would mean a new extractor, a new route on the gateway and a texture to wait for — for eight
 * shapes that are a star, a circle, a diamond, a triangle, a crescent, a square, a cross and a
 * skull. They are paths. Only the colours had to come from the sheet.
 */
export function drawRaidMark(context: CanvasRenderingContext2D, icon: number, x: number, y: number, size: number): void {
  const colour = RAID_MARK_COLOURS[icon];
  if (!colour) return;
  const radius = size / 2;
  context.save();
  context.translate(x, y);
  context.fillStyle = colour;
  context.strokeStyle = "#10131a";
  context.lineWidth = Math.max(1, size * 0.09);
  context.beginPath();
  if (icon === 0) {
    for (let point = 0; point < 10; point++) {
      const angle = -Math.PI / 2 + point * Math.PI / 5;
      const reach = point % 2 === 0 ? radius : radius * 0.44;
      const px = Math.cos(angle) * reach;
      const py = Math.sin(angle) * reach;
      if (point === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
  } else if (icon === 1) {
    context.arc(0, 0, radius * 0.86, 0, Math.PI * 2);
  } else if (icon === 2) {
    context.moveTo(0, -radius);
    context.lineTo(radius * 0.72, 0);
    context.lineTo(0, radius);
    context.lineTo(-radius * 0.72, 0);
    context.closePath();
  } else if (icon === 3) {
    context.moveTo(0, -radius);
    context.lineTo(radius * 0.9, radius * 0.72);
    context.lineTo(-radius * 0.9, radius * 0.72);
    context.closePath();
  } else if (icon === 4) {
    // A crescent is a disc with a second disc taken out of it, and the even-odd rule below is what
    // takes it out: two circles wound the same way and filled by the non-zero rule are a full moon.
    context.arc(0, 0, radius * 0.9, 0, Math.PI * 2);
    context.moveTo(radius * 1.16, -radius * 0.16);
    context.arc(radius * 0.38, -radius * 0.16, radius * 0.78, 0, Math.PI * 2);
  } else if (icon === 5) {
    context.rect(-radius * 0.78, -radius * 0.78, radius * 1.56, radius * 1.56);
  } else if (icon === 6) {
    const arm = radius * 0.34;
    const reach = radius * 0.95;
    context.moveTo(-arm, -reach);
    context.lineTo(arm, -reach);
    context.lineTo(arm, -arm);
    context.lineTo(reach, -arm);
    context.lineTo(reach, arm);
    context.lineTo(arm, arm);
    context.lineTo(arm, reach);
    context.lineTo(-arm, reach);
    context.lineTo(-arm, arm);
    context.lineTo(-reach, arm);
    context.lineTo(-reach, -arm);
    context.lineTo(-arm, -arm);
    context.closePath();
  } else {
    // The skull: a dome over a jaw, with two sockets punched through it by the same even-odd rule.
    context.moveTo(-radius * 0.72, radius * 0.1);
    context.bezierCurveTo(-radius * 0.72, -radius, radius * 0.72, -radius, radius * 0.72, radius * 0.1);
    context.lineTo(radius * 0.36, radius * 0.1);
    context.lineTo(radius * 0.36, radius * 0.72);
    context.lineTo(-radius * 0.36, radius * 0.72);
    context.lineTo(-radius * 0.36, radius * 0.1);
    context.closePath();
    context.moveTo(-radius * 0.14, -radius * 0.28);
    context.arc(-radius * 0.34, -radius * 0.28, radius * 0.2, 0, Math.PI * 2);
    context.moveTo(radius * 0.54, -radius * 0.28);
    context.arc(radius * 0.34, -radius * 0.28, radius * 0.2, 0, Math.PI * 2);
  }
  context.fill("evenodd");
  context.stroke();
  context.restore();
}

/**
 * The bag over a lootable body.
 *
 * A path, for the same reason the eight raid marks are paths: the sheet it would otherwise come
 * from (`Interface\Cursor\LootAll.blp`) would cost an extractor, a gateway route and a wait, for a
 * shape that is a trapezoid, a lid and a drawstring.
 */
export function drawLootBag(context: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const half = size / 2;
  context.save();
  context.translate(x, y);
  context.fillStyle = "#d8a94a";
  context.strokeStyle = "#2a1d08";
  context.lineWidth = Math.max(1, size * 0.1);
  context.beginPath();
  // The body: narrow at the tie, widening to a flat bottom.
  context.moveTo(-half * 0.42, -half * 0.28);
  context.lineTo(half * 0.42, -half * 0.28);
  context.lineTo(half * 0.86, half * 0.9);
  context.lineTo(-half * 0.86, half * 0.9);
  context.closePath();
  context.fill();
  context.stroke();
  // And the drawstring across the neck.
  context.beginPath();
  context.moveTo(-half * 0.6, -half * 0.28);
  context.lineTo(half * 0.6, -half * 0.28);
  context.stroke();
  context.restore();
}

/**
 * One plate, painted.
 *
 * Everything is measured out of `box`, so the target's larger plate is this same code at another
 * scale. Nothing here reads a clock: a cast arrives as a fraction, worked out against the same
 * frame's `now` as every other bar in the interface.
 */
export function drawPlate(context: CanvasRenderingContext2D, box: PlateBox, data: PlateData): void {
  const scale = box.scale;
  const nameHeight = PLATE_NAME_HEIGHT * scale;
  const barHeight = PLATE_BAR_HEIGHT * scale;
  const barY = box.y + nameHeight;

  const rankMark = plateRankMark(data.rank);
  // A corpse has no level worth reading: the number answers "can I take this one", and that
  // question is over. The bag stands in the level's corner instead, right-aligned like it was.
  const levelText = data.lootable ? "" : plateLevelText(data.level, data.rank);
  context.font = `${Math.round(11 * scale)}px system-ui, sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  const label = rankMark ? `${rankMark} ${data.name}` : data.name;
  const nameBaseline = barY - 3 * scale;
  // The name is outlined rather than boxed. A plate sits over a body, and a filled strip behind
  // every name in a crowd hides more of the world than the names are worth.
  context.lineWidth = 3 * scale;
  context.strokeStyle = "#0a0d12cc";
  context.strokeText(label, box.x, nameBaseline);
  context.fillStyle = data.target ? "#ffe36e" : "#f2f5f8";
  context.fillText(label, box.x, nameBaseline);
  if (levelText) {
    context.textAlign = "right";
    context.strokeText(levelText, box.x + box.width, nameBaseline);
    context.fillStyle = data.rank === RANK_BOSS ? "#ff8f6b" : "#cfd8e0";
    context.fillText(levelText, box.x + box.width, nameBaseline);
    context.textAlign = "left";
  }

  // A corpse gets the bag where the level stood and no bar at all: a dead unit's health is zero,
  // and the bar would be an empty strip repeated over every body in a cleared camp. The raid mark
  // below still draws — a body keeps its mark, which is how a group finds the one it killed.
  if (data.lootable) {
    drawLootBag(context, box.x + box.width - nameHeight * 0.5, box.y + nameHeight * 0.5, nameHeight);
  } else {
    context.fillStyle = "#080b0fd8";
    context.fillRect(box.x, barY, box.width, barHeight);
    if (data.health !== undefined) {
      context.fillStyle = plateColour(data);
      context.fillRect(box.x + 1, barY + 1, (box.width - 2) * data.health, barHeight - 2);
    }
    context.strokeStyle = data.target ? "#ffe36e" : "#0b0f13aa";
    context.lineWidth = data.target ? 2 : 1;
    context.strokeRect(box.x, barY, box.width, barHeight);
  }

  if (!data.lootable && data.cast) {
    const castY = barY + barHeight + scale;
    const castHeight = PLATE_CAST_HEIGHT * scale;
    context.fillStyle = "#080b0fd8";
    context.fillRect(box.x, castY, box.width, castHeight);
    // A channel empties instead of filling, and it arrives already emptying. The flag is left for
    // the colour, which is the only thing here that still has to tell the two apart.
    context.fillStyle = data.cast.channel ? "#57b0d8" : "#e0b64a";
    const filled = Math.max(0, Math.min(1, data.cast.progress));
    context.fillRect(box.x + 1, castY + 1, (box.width - 2) * filled, castHeight - 2);
    context.font = `${Math.round(9 * scale)}px system-ui, sans-serif`;
    context.textAlign = "center";
    // Outlined and light, like the name above it, rather than dark on the fill. Dark text was
    // chosen to sit on the amber fill — 10.2:1 there — but the bar is only filled in proportion to
    // the cast, so for the first half of every cast the name sat on the unfilled backdrop instead:
    // 1.01:1 over dark geometry, 1.34:1 against the brightest sky. Unreadable exactly while the
    // cast is worth reading, and readable only once it no longer matters.
    //
    // The outline is what carries it, which is why the pair of numbers to check is not the fill
    // against the background but the glyph against its own outline: #f2f5f8 on the outline reads
    // 12.2:1 over the amber fill and 12.9:1 over the channel blue, and the outline itself stands
    // 7.0:1 and 5.8:1 off those fills. Whatever is behind the bar, the letters keep their edge.
    context.lineWidth = 3 * scale;
    context.strokeStyle = "#0a0d12cc";
    context.strokeText(data.cast.name, box.x + box.width / 2, castY + castHeight - scale);
    context.fillStyle = "#f2f5f8";
    context.fillText(data.cast.name, box.x + box.width / 2, castY + castHeight - scale);
    context.textAlign = "left";
  }

  const markSize = 15 * scale;
  let markX = box.x + box.width / 2;
  if (data.raidMark !== undefined) {
    drawRaidMark(context, data.raidMark, markX, box.y - markSize * 0.7, markSize);
    markX += markSize;
  }
  if (data.questMark) {
    context.font = `bold ${Math.round(16 * scale)}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.lineWidth = 3 * scale;
    context.strokeStyle = "#1b1200";
    context.fillStyle = data.questMark === "?" ? "#ffd24a" : "#ffe36e";
    context.strokeText(data.questMark, markX, box.y - markSize * 0.3);
    context.fillText(data.questMark, markX, box.y - markSize * 0.3);
    context.textAlign = "left";
  }
}
