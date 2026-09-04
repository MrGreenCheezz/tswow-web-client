import { POWER_DISPLAY_SCALE, unit } from "../../world/Fields.js";
import { CLASS_ICON_TCOORDS, type ClassIconCell } from "../../generated/classIcons.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * What one unit frame needs to know, gathered from wherever it actually lives.
 *
 * This is the whole reason slice I2 needs a layer between the store and the frames: **a raid of
 * forty cannot be read from the object grid.** The server only sends object updates for units
 * inside the player's own grid, so the twenty-five people in the other wing of the instance have
 * no `WorldObjectState` at all. What they do have is `SMSG_PARTY_MEMBER_STATS`, which carries
 * health, power, level and zone for exactly those members — and which slice P5 already folds
 * together into `WorldClient.partyStats`.
 *
 * A frame that read the grid would show twelve people out of forty and blank the rest; a frame
 * that read only the stats would lag behind the two people standing next to the player, because
 * the stats packet is throttled and an object update is not. So both are read, the grid wins where
 * it has an answer, and `inGrid` says which happened — because it is also the answer to "is this
 * person near enough to heal", which is the one thing a raid frame is for.
 */

/** Class ids in `UNIT_FIELD_BYTES_0` byte 1. Ten classes, and 10 is not one of them. */
export const CLASS_WARRIOR = 1;
export const CLASS_PALADIN = 2;
export const CLASS_HUNTER = 3;
export const CLASS_ROGUE = 4;
export const CLASS_PRIEST = 5;
export const CLASS_DEATH_KNIGHT = 6;
export const CLASS_SHAMAN = 7;
export const CLASS_MAGE = 8;
export const CLASS_WARLOCK = 9;
export const CLASS_DRUID = 11;

/**
 * The class colours the original client uses, by class id.
 *
 * Index 0 and index 10 are gaps: there is no class 0, and 10 was never filled in — reading this
 * table as a dense list of ten shifts every druid onto the warlock's purple.
 */
export const CLASS_COLORS: Readonly<Record<number, string>> = {
  [CLASS_WARRIOR]: "#c79c6e",
  [CLASS_PALADIN]: "#f58cba",
  [CLASS_HUNTER]: "#abd473",
  [CLASS_ROGUE]: "#fff569",
  [CLASS_PRIEST]: "#ffffff",
  [CLASS_DEATH_KNIGHT]: "#c41f3b",
  [CLASS_SHAMAN]: "#0070de",
  [CLASS_MAGE]: "#69ccf0",
  [CLASS_WARLOCK]: "#9482c9",
  [CLASS_DRUID]: "#ff7d0a",
};

/**
 * A colour for a class the table does not have, from the id alone.
 *
 * 3.3.5 has no DBC source for class colours — the original client's `RAID_CLASS_COLORS` is a Lua
 * literal — so a class a module adds has none, and this used to answer `undefined`: an unnamed
 * class also drew as an uncoloured nameplate and an uncoloured guild line, which reads as a bug
 * rather than as a class nobody has a colour for. A hue derived from the id gives every class a
 * stable colour of its own instead, the same one on every machine and between sessions.
 *
 * The golden-angle step is what keeps neighbouring ids apart: 137.5° means ids 12, 13 and 14 land
 * three-eighths of the wheel from each other rather than side by side. Saturation and lightness are
 * fixed where the ten real colours sit, so a custom class does not stand out by being brighter.
 */
export function generatedClassColor(classId: number): string {
  const hue = (classId * 137.5) % 360;
  return `hsl(${hue.toFixed(1)}, 55%, 65%)`;
}

export function classColor(classId: number | undefined): string | undefined {
  // Zero is not a class the table is missing; it is the class byte of a unit that has none — a
  // creature, or a player whose `UNIT_FIELD_BYTES_0` arrived before its character did. Giving that
  // a colour would paint every such nameplate, which is the opposite of what this is for.
  if (classId === undefined || classId <= 0) return undefined;
  return CLASS_COLORS[classId] ?? generatedClassColor(classId);
}

/**
 * The ten classes and the ten races by their own numbers, in this client's language.
 *
 * Here rather than in a window because three places already wanted them and each had its own idea:
 * the guild roster carried a copy of the classes, the character creation screen carried both lists
 * in English inside the page markup, and everything else printed the number. The gaps are real —
 * there is no class 10 and no race 9 — which is why these are records and not dense arrays.
 *
 * **These are the fallback, not the answer.** `/dbc/character-creation` serves the dataset's own
 * `ChrRaces`/`ChrClasses` names, and `learnCreationNames` lays them over these — so a race or a
 * class a module adds is named on the creation form, on a unit frame and in a tooltip, and a stock
 * one renamed by a module is renamed everywhere too. Nothing outside this file should read the two
 * records directly; `className` and `raceName` read the merged table.
 */
export const CLASS_NAMES: Readonly<Record<number, string>> = {
  [CLASS_WARRIOR]: "Воин",
  [CLASS_PALADIN]: "Паладин",
  [CLASS_HUNTER]: "Охотник",
  [CLASS_ROGUE]: "Разбойник",
  [CLASS_PRIEST]: "Жрец",
  [CLASS_DEATH_KNIGHT]: "Рыцарь смерти",
  [CLASS_SHAMAN]: "Шаман",
  [CLASS_MAGE]: "Маг",
  [CLASS_WARLOCK]: "Чернокнижник",
  [CLASS_DRUID]: "Друид",
};

/** `ChrRaces.dbc` by id. 9 is Goblin, which 3.3.5 ships unplayable. */
export const RACE_NAMES: Readonly<Record<number, string>> = {
  1: "Человек",
  2: "Орк",
  3: "Дворф",
  4: "Ночной эльф",
  5: "Нежить",
  6: "Таурен",
  7: "Гном",
  8: "Тролль",
  10: "Эльф крови",
  11: "Дреней",
};

/**
 * The stock `ChrClasses.Filename` tokens, which is how a class id reaches a cell of the atlas.
 *
 * `CLASS_ICON_TCOORDS` is keyed by this token rather than by an id — both in the client's own
 * FrameXML and in what tswow writes over it — and a class id is all the wire carries. Ten entries,
 * measured out of `ChrClasses.dbc` on this dataset; the route replaces them at runtime, which is
 * the only way a custom class can be given a cell it did not have when this was compiled.
 */
export const CLASS_FILE_NAMES: Readonly<Record<number, string>> = {
  [CLASS_WARRIOR]: "WARRIOR",
  [CLASS_PALADIN]: "PALADIN",
  [CLASS_HUNTER]: "HUNTER",
  [CLASS_ROGUE]: "ROGUE",
  [CLASS_PRIEST]: "PRIEST",
  [CLASS_DEATH_KNIGHT]: "DEATHKNIGHT",
  [CLASS_SHAMAN]: "SHAMAN",
  [CLASS_MAGE]: "MAGE",
  [CLASS_WARLOCK]: "WARLOCK",
  [CLASS_DRUID]: "DRUID",
};

/** What the dataset said, once somebody has asked it. Empty until then. */
const learnedClassNames = new Map<number, string>();
const learnedRaceNames = new Map<number, string>();
const learnedClassFiles = new Map<number, string>();

/**
 * Takes the dataset's own names for races and classes, from `/dbc/character-creation`.
 *
 * Called once per gateway by the login screen, and deliberately global rather than threaded
 * through: the frames, the nameplates, the guild roster and the character list all print these,
 * none of them has a gateway client of its own, and a name is the same answer for all of them. A
 * row with an empty name is ignored rather than learned, so a half-filled custom row falls back to
 * `Класс 14` instead of showing nothing at all.
 */
export function learnCreationNames(
  races: ReadonlyArray<{ id: number; name: string }>,
  classes: ReadonlyArray<{ id: number; name: string; fileName?: string }>,
): void {
  for (const race of races) {
    if (race.name) learnedRaceNames.set(race.id, race.name);
  }
  for (const entry of classes) {
    if (entry.name) learnedClassNames.set(entry.id, entry.name);
    if (entry.fileName) learnedClassFiles.set(entry.id, entry.fileName);
  }
}

/**
 * Forgets them again — which the login screen does the moment the gateway address changes.
 *
 * Names are laid *over* the compiled ten and never replace them, so without a clearing step a
 * second gateway that answers nothing at all would be described in the first one's words: its
 * race 22 is not the other's race 22, and every frame, nameplate and character card prints these.
 */
export function forgetCreationNames(): void {
  learnedClassNames.clear();
  learnedRaceNames.clear();
  learnedClassFiles.clear();
}

export function className(classId: number | undefined): string {
  if (classId === undefined) return "";
  return learnedClassNames.get(classId) ?? CLASS_NAMES[classId] ?? `Класс ${classId}`;
}

export function raceName(raceId: number | undefined): string {
  if (raceId === undefined) return "";
  return learnedRaceNames.get(raceId) ?? RACE_NAMES[raceId] ?? `Раса ${raceId}`;
}

/** `ChrClasses.Filename` for an id: what the dataset says, else what this build was compiled with. */
export function classFileName(classId: number | undefined): string | undefined {
  if (classId === undefined) return undefined;
  return learnedClassFiles.get(classId) ?? CLASS_FILE_NAMES[classId];
}

/**
 * The eight raid marks, in the order the server numbers them: star first, skull last.
 *
 * The last two were an X and a plus the wrong way round — `RAID_TARGET_NAMES` calls slot 6 «Крест»
 * and slot 7 «Череп», and a raid told to kill the skull would have been looking for a cross.
 */
export const RAID_MARKS = ["★", "◯", "◆", "▲", "☾", "■", "✖", "☠"];

export function raidMarkGlyph(icon: number | undefined): string | undefined {
  return icon === undefined ? undefined : RAID_MARKS[icon];
}

export interface UnitSnapshot {
  guid: bigint;
  name: string;
  level: number | undefined;
  classId: number | undefined;
  health: number | undefined;
  maxHealth: number | undefined;
  power: number | undefined;
  maxPower: number | undefined;
  powerType: number | undefined;
  /** What to divide the power by before showing it: rage and runic power arrive times ten. */
  powerScale: number;
  dead: boolean;
  /** False for a group member the server says is offline. Always true for anything else. */
  online: boolean;
  /**
   * Whether this unit is a real object in the client's grid. False means everything above came
   * from `SMSG_PARTY_MEMBER_STATS` — the unit is in the raid but not near enough to be sent.
   */
  inGrid: boolean;
  /** 0 to 7 when the unit wears a raid mark. */
  raidMark: number | undefined;
  /** `REACTION_*`, when the caller could work one out. */
  reaction: number | undefined;
  /** Away or busy, which only a group member reports and only through the status word. */
  away: boolean;
}

const emptySnapshot = (guid: bigint, name: string): UnitSnapshot => ({
  guid, name, level: undefined, classId: undefined, health: undefined, maxHealth: undefined,
  power: undefined, maxPower: undefined, powerType: undefined, powerScale: 1, dead: false,
  online: true, inGrid: false, raidMark: undefined, reaction: undefined, away: false,
});

/** What `SMSG_PARTY_MEMBER_STATS` carries, narrowed to the fields a frame draws. */
export interface PartyStatsLike {
  health?: number | undefined;
  maxHealth?: number | undefined;
  power?: number | undefined;
  maxPower?: number | undefined;
  powerType?: number | undefined;
  level?: number | undefined;
  status?: number | undefined;
}

/**
 * `GroupMemberOnlineStatus` in Group.h.
 *
 * Dead is `0x0004` and **not** `0x0002` — `0x0002` is the PvP flag, and taking it for death marks
 * every flagged member in the raid as a corpse. The two sit next to each other and both are common.
 */
export const MEMBER_STATUS_ONLINE = 0x0001;
export const MEMBER_STATUS_PVP = 0x0002;
export const MEMBER_STATUS_DEAD = 0x0004;
export const MEMBER_STATUS_GHOST = 0x0008;
export const MEMBER_STATUS_AFK = 0x0040;
export const MEMBER_STATUS_DND = 0x0080;

export interface SnapshotSources {
  object?: WorldObjectState | undefined;
  stats?: PartyStatsLike | undefined;
  /** From the group list, which is the only place an offline member is named at all. */
  online?: boolean | undefined;
  raidMark?: number | undefined;
  reaction?: number | undefined;
}

/**
 * One unit, from whichever of its two sources has an answer.
 *
 * The grid wins every field it has, because an object update is immediate and a stats packet is
 * throttled to roughly one every two seconds. Where the grid has nothing the stats fill in, and
 * `inGrid` records which of the two happened rather than leaving the caller to guess from a
 * missing field — a raid member at full health and a raid member out of range look identical
 * otherwise.
 */
export function unitSnapshot(guid: bigint, name: string, sources: SnapshotSources): UnitSnapshot {
  const snapshot = emptySnapshot(guid, name);
  snapshot.raidMark = sources.raidMark;
  snapshot.reaction = sources.reaction;
  snapshot.online = sources.online ?? true;

  const stats = sources.stats;
  if (stats) {
    snapshot.health = stats.health;
    snapshot.maxHealth = stats.maxHealth;
    snapshot.power = stats.power;
    snapshot.maxPower = stats.maxPower;
    snapshot.powerType = stats.powerType;
    snapshot.level = stats.level;
    // The status word is the only thing that says a member is dead while they are out of range:
    // there is no health of zero to read, because there is no object to read it from.
    if (stats.status !== undefined) {
      snapshot.dead = (stats.status & (MEMBER_STATUS_DEAD | MEMBER_STATUS_GHOST)) !== 0;
      snapshot.away = (stats.status & (MEMBER_STATUS_AFK | MEMBER_STATUS_DND)) !== 0;
      if (sources.online === undefined) snapshot.online = (stats.status & MEMBER_STATUS_ONLINE) !== 0;
    }
  }

  const object = sources.object;
  if (object) {
    snapshot.inGrid = true;
    snapshot.level = unit.level(object) ?? snapshot.level;
    snapshot.classId = unit.classId(object);
    snapshot.health = unit.health(object) ?? snapshot.health;
    snapshot.maxHealth = unit.maxHealth(object) ?? snapshot.maxHealth;
    const power = unit.power(object);
    if (power !== undefined) {
      snapshot.power = power;
      snapshot.maxPower = unit.maxPower(object);
      snapshot.powerType = unit.powerType(object);
    }
    // Zero health is a corpse and undefined health is a unit whose fields have not arrived: the
    // two must not be conflated, or every unit is dead for one frame after it appears.
    const health = unit.health(object);
    if (health !== undefined) snapshot.dead = health === 0;
  }

  snapshot.powerScale = snapshot.powerType === undefined
    ? 1
    : POWER_DISPLAY_SCALE[snapshot.powerType] ?? 1;
  return snapshot;
}

/** Health as a fraction, with an unknown maximum reading as empty rather than as full. */
export function healthFraction(snapshot: UnitSnapshot): number {
  if (snapshot.health === undefined || !snapshot.maxHealth) return 0;
  return Math.max(0, Math.min(1, snapshot.health / snapshot.maxHealth));
}

/**
 * Which guid wears which raid mark, inverted from the map the world client keeps.
 *
 * The server indexes by icon because an icon is unique and a unit is not — moving the star to a
 * second target takes it off the first, and the packet says so only by naming the icon again. A
 * frame needs the opposite question answered, so the inversion happens once per repaint rather
 * than eight times per frame.
 */
export function raidMarksByUnit(marks: ReadonlyMap<number, bigint>): Map<bigint, number> {
  const byUnit = new Map<bigint, number>();
  for (const [icon, guid] of marks) if (guid !== 0n) byUnit.set(guid, icon);
  return byUnit;
}

/**
 * How much of the tank's threat this unit holds on that creature, from 0 to 1.
 *
 * The server sends raw threat values, not percentages, and the number that matters is the ratio to
 * whoever is highest — 4000 threat is safe behind a tank on 30000 and lethal behind one on 4100.
 * An empty table is not zero threat but *no information*, so it answers undefined.
 */
export function threatFraction(
  entries: ReadonlyArray<{ guid: bigint; threat: number }>,
  guid: bigint,
): number | undefined {
  if (entries.length === 0) return undefined;
  let mine: number | undefined;
  let highest = 0;
  for (const entry of entries) {
    if (entry.threat > highest) highest = entry.threat;
    if (entry.guid === guid) mine = entry.threat;
  }
  if (mine === undefined || highest <= 0) return undefined;
  return Math.max(0, Math.min(1, mine / highest));
}

/**
 * The atlas itself, in the archives, reached through the gateway's texture route.
 *
 * `String.raw` rather than a plain literal, and that is the whole of this line's history: written
 * `"Interface\TargetingFrame\UI-Classes-Circles.blp"`, neither `\T` nor `\U` is an escape sequence,
 * so TypeScript dropped both backslashes and the value shipped as the 45-character
 * `InterfaceTargetingFrameUI-Classes-Circles.blp`. `/texture` answered 404 for it and the class
 * portrait had never once been drawn. `tests/character-creation.test.mjs` sweeps every path literal
 * in `src/browser` and `src/world` for the same collapse, because nothing in `npm run build` did.
 */
export const CLASS_ATLAS_PATH = String.raw`Interface\TargetingFrame\UI-Classes-Circles.blp`;

/**
 * How wide one drawn cell of that atlas is, in the image's own pixels.
 *
 * A constant rather than `(right − left) × width`, because the stock coordinates trim a pixel of
 * bleed off some cells — measured on this dataset, the four columns start at 0, 64, 127 and 190 of
 * 256 and are 64, 63, 63 and 63 wide — while the art in each of them is a 64px circle. This is the
 * number the portrait is centred on, not the number the sheet is divided by.
 */
export const CLASS_ATLAS_CELL_SIZE = 64;

/** The sheet this build was written against, used only until an image has actually been decoded. */
export const CLASS_ATLAS_DEFAULT_SIZE = 256;

/**
 * Where to put the atlas behind a `windowWidth` by `windowHeight` opening so one cell shows through.
 *
 * `object-fit: none` draws the image at its natural size, so the cell is selected by moving the
 * image rather than by scaling it — which keeps the icon pixel-exact at any frame width.
 *
 * The cell is no longer a hardcoded column and row. It is the fraction pair the dataset's own
 * `CLASS_ICON_TCOORDS` declares, multiplied by the size of the picture the browser actually
 * decoded — which is the only arrangement that survives a module adding a class. The moment any
 * module calls tswow's `stitchClassIcon`, all three class sheets are redrawn at 512x512 with eight
 * columns and every stock class's coordinates are rewritten to 0.125 steps (`ClassIcon.ts:33-51`);
 * a 4-column, 256-pixel assumption would then point every portrait at a quarter of the wrong icon.
 * Passing the natural size through also fixed the stock sheet: the hand-written table put rogue,
 * druid, priest and warlock on multiples of 64, and the client's own coordinates put them at 127
 * and 190, so those four were drawn one and two pixels off.
 */
export function classIconOffset(
  classId: number | undefined,
  windowWidth: number,
  atlasWidth: number = CLASS_ATLAS_DEFAULT_SIZE,
  atlasHeight: number = atlasWidth,
  windowHeight: number = windowWidth,
): string | undefined {
  const cell = classIconCell(classId);
  if (!cell) return undefined;
  // A picture that has not loaded yet reports 0, and scaling by it would stack every class on the
  // first cell; the sheet this build knows about is a better guess than a certain collision.
  const width = atlasWidth > 0 ? atlasWidth : CLASS_ATLAS_DEFAULT_SIZE;
  const height = atlasHeight > 0 ? atlasHeight : CLASS_ATLAS_DEFAULT_SIZE;
  const insetX = (windowWidth - CLASS_ATLAS_CELL_SIZE) / 2;
  const insetY = (windowHeight - CLASS_ATLAS_CELL_SIZE) / 2;
  return `${-Math.round(cell.left * width) + insetX}px ${-Math.round(cell.top * height) + insetY}px`;
}

/** The class's own corner of the sheet, by the `Filename` token the coordinates are keyed on. */
function classIconCell(classId: number | undefined): ClassIconCell | undefined {
  const token = classFileName(classId);
  return token === undefined ? undefined : CLASS_ICON_TCOORDS[token];
}

/** Whether the sheet this session knows about has a cell for that class at all. */
export function hasClassIcon(classId: number | undefined): boolean {
  return classIconCell(classId) !== undefined;
}

/**
 * How wide the ring around the portrait is, per `.unit-frame > img` — the guess, not the answer.
 *
 * `style.css` has two sizes for that box: 58, and 46 under `@media (max-width: 760px)`. Only the
 * element itself knows which one it currently has, so this is what stands in when there is no
 * element to ask — a hidden one measures zero — and `classPortraitPosition` measures the rest.
 */
export const CLASS_PORTRAIT_SIZE = 58;
export const CLASS_MICRO_PORTRAIT_WIDTH = 18;
export const CLASS_MICRO_PORTRAIT_HEIGHT = 25;

/**
 * The same offset, for the image element that actually carries the sheet.
 *
 * The measured width and height rather than one constant matter twice: the unit-frame ring narrows
 * from 58px to 46px, while the stock microbutton opening is rectangular (18px by 25px). Optional
 * authored fallbacks keep both shapes correct when an ancestor is hidden and the browser reports
 * zero for both client dimensions.
 */
export function classPortraitPosition(
  image: { clientWidth: number; clientHeight?: number; naturalWidth: number; naturalHeight: number },
  classId: number | undefined,
  fallbackWidth: number = CLASS_PORTRAIT_SIZE,
  fallbackHeight: number = fallbackWidth,
): string | undefined {
  const width = image.clientWidth || fallbackWidth;
  const height = image.clientHeight || fallbackHeight;
  return classIconOffset(
    classId, width, image.naturalWidth, image.naturalHeight, height);
}
