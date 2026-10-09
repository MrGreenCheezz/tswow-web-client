/**
 * The native HUD's unit tooltip — what the original writes beside the cursor over a creature or a
 * player (WORK_PLAN 4.04).
 *
 * Wow.exe 3.3.5a 12340's unit tooltip writer (0x00621070, the `GameTooltip:SetUnit` body; read
 * from `.runtime/re-2026-09-30/r4/decomp.txt`, strings from the binary 2026-10-02) writes, in order:
 *  1. the name, gold (0xffffd200) — the stock `OnTooltipSetUnit` then recolours a mouseover title
 *     with `GameTooltip_UnitColor` (GameTooltip.lua:7-70), so the colour here is that function's;
 *  2. a player's guild name, white, as it is (no brackets); a creature's cache sub-name, white,
 *     unless it is somebody's pet (`FrameXmlUnitSubName.ts`);
 *  3. the level line, white, from one of six `TOOLTIP_UNIT_LEVEL*` templates chosen by which of
 *     three slots are filled — level, "class" (race + class for a player, `CORPSE` for a dead body,
 *     the creature type for a creature the player is not friendly with) and "type" (`PLAYER` for a
 *     player, `BOSS` for a boss-flagged creature, `ELITE` for creature ranks 1 and 2). The level is
 *     "??" for a boss, below 1, or a hostile unit ten or more levels above the player;
 *  4. `PVP_ENABLED` for a unit with the PvP bit (UNIT_FIELD_BYTES_2 byte 1, 0x01) or a player with
 *     PLAYER_FLAGS_CONTESTED_PVP (0x100);
 *  5. the skinnable line of a flagged creature, in its difficulty colour (`FrameXmlSkinnableTooltip`).
 *
 * Not written here (each needs data this client does not hold yet): the faction name line (the
 * unit's Faction.dbc reputation masks against the player's race and class), `RESURRECTABLE`,
 * beast lore, the party leader line, quest objectives, master looter and the threat row.
 *
 * The content is built from {@link UnitTooltipFacts}, a flat record the caller gathers once per
 * pick; `unitTooltipKey` turns it into a string so a hover over the same unauthored unit does not
 * rebuild the tooltip on every pointer move.
 */

import { readField, unit as unitField } from "../../world/Fields.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "../../world/FactionRules.js";
import type { KnownSpell } from "../../world/SpellProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { CreatureTemplate } from "../../world/QueryCacheProtocol.js";
import type { GuildQueryInfo } from "../../world/GuildProtocol.js";
import { creatureTypeName } from "../CreatureMetadata.js";
import type { GatherSpellRow } from "../game/CreatureGather.js";
import { frameXmlUnitSkinnableLine } from "../framexml/FrameXmlSkinnableTooltip.js";
import { nativeString } from "./Strings.js";
import type { TooltipContent, TooltipLine } from "./Tooltip.js";
import { className, raceName } from "./UnitSnapshot.js";
import { femaleOf } from "./UnitSnapshot.js"; // L3-review

/** CreatureType 10, «Не указано»: no type word, and the skull rule still applies. */
const CREATURE_TYPE_NOT_SPECIFIED = 10;
/** CreatureType.dbc's rows on this dataset: 1 Beast … 13 Gas Cloud. Any other id has no word. */
const CREATURE_TYPE_MAX = 13;
/** `type_flags` 0x4, CREATURE_TYPE_FLAG_BOSS_MOB: the rank word is BOSS and the level is hidden. */
const CREATURE_TYPE_FLAG_BOSS = 0x4;
/** UNIT_DYNFLAG_DEAD (UnitDefines.h); Wow.exe reads it beside health ≤ 0. */
const UNIT_DYNFLAG_DEAD = 0x20;
/** PLAYER_FLAGS_CONTESTED_PVP (Player.h:362), the player half of the PvP line's test. */
const PLAYER_FLAGS_CONTESTED_PVP = 0x100;
/** UNIT_BYTE2_FLAG_PVP (UnitDefines.h:109). */
const UNIT_BYTE2_FLAG_PVP = 0x01;

/** `FACTION_BAR_COLORS` (ReputationFrame.lua:3-12) at the indices `GameTooltip_UnitColor` reads. */
const COLOUR_HOSTILE = "#cc4d38"; // [2] 0.8, 0.3, 0.22
const COLOUR_NEUTRAL = "#e6b300"; // [4] 0.9, 0.7, 0
const COLOUR_FRIENDLY = "#00991a"; // [5]/[6] 0, 0.6, 0.1
const COLOUR_WHITE = "#ffffff";

/** Everything the tooltip says, gathered from the world once per pick. */
export interface UnitTooltipFacts {
  readonly name: string;
  readonly isPlayer: boolean;
  readonly level: number;
  /** The player's own level, for the skull rule; undefined outside the world. */
  readonly playerLevel: number | undefined;
  readonly dead: boolean;
  /** REACTION_* of the unit to the player; undefined until the faction table has landed. */
  readonly reaction: number | undefined;
  /** Whether the player may attack the unit (Wow.exe CanAttack). */
  readonly canAttack: boolean;
  /** `UnitIsPVP`: the unit's PvP bit. */
  readonly pvpFlagged: boolean;
  /** The PvP line: the PvP bit, or a player's contested flag. */
  readonly pvpLine: boolean;
  readonly guild?: string | undefined;
  readonly subName?: string | undefined;
  readonly raceName?: string | undefined;
  readonly className?: string | undefined;
  /** The creature template's CreatureType; undefined for a player or an unanswered template. */
  readonly creatureType?: number | undefined;
  /** The creature template's rank (classification): 1 elite, 2 rare elite, 3 boss, 4 rare. */
  readonly rank?: number | undefined;
  readonly boss?: boolean | undefined;
  readonly skinnable?: { readonly text: string; readonly color: string } | undefined;
}

/** `GameTooltip_UnitColor("mouseover")` with this client's one-directional attack test. */
export function unitTooltipNameColour(facts: UnitTooltipFacts): string {
  if (facts.isPlayer) {
    // Stock: can attack each other → red; it can attack us only → white; we can attack it → yellow;
    // a PvP-flagged friend → green; anyone else white. This client knows the player's side only.
    if (facts.canAttack) return facts.reaction === REACTION_HOSTILE ? COLOUR_HOSTILE : COLOUR_NEUTRAL;
    return facts.pvpFlagged ? COLOUR_FRIENDLY : COLOUR_WHITE;
  }
  if (facts.reaction === REACTION_HOSTILE) return COLOUR_HOSTILE;
  if (facts.reaction === REACTION_NEUTRAL) return COLOUR_NEUTRAL;
  if (facts.reaction === REACTION_FRIENDLY) return COLOUR_FRIENDLY;
  return COLOUR_WHITE;
}

/** The level slot: the number, or "??" for a boss, an unknown level, or a far stronger enemy. */
export function unitTooltipLevelText(facts: UnitTooltipFacts): string {
  const skull = facts.playerLevel !== undefined && facts.reaction === REACTION_HOSTILE
    && facts.playerLevel <= facts.level - 10;
  if (skull || facts.boss === true || !(facts.level >= 1)) return "??";
  return String(Math.trunc(facts.level));
}

/** The "class" slot: race and class, the corpse word, or the creature's type. */
function classSlot(facts: UnitTooltipFacts): { race?: string; cls?: string } {
  if (facts.dead) return { cls: nativeString("CORPSE", "Труп существа") };
  if (facts.isPlayer) {
    return facts.raceName && facts.className ? { race: facts.raceName, cls: facts.className } : {};
  }
  const type = facts.creatureType;
  // Only for a creature the player is not friendly with (Wow.exe asks the reaction < 4 before it
  // reads the CreatureType row); «Не указано» and unknown ids have no word.
  if (type === undefined || type === CREATURE_TYPE_NOT_SPECIFIED || type < 1 || type > CREATURE_TYPE_MAX
    || facts.reaction === REACTION_FRIENDLY || facts.reaction === undefined) return {};
  return { cls: creatureTypeName(type) };
}

/** The "type" slot: PLAYER, BOSS or ELITE. */
function typeSlot(facts: UnitTooltipFacts): string | undefined {
  if (facts.isPlayer) return nativeString("PLAYER", "игрок");
  if (facts.boss === true) return nativeString("BOSS", "босс");
  if (facts.rank === 1 || facts.rank === 2) return nativeString("ELITE", "элита");
  return undefined;
}

/** The level line in the template Wow.exe picks for the filled slots. */
export function unitTooltipLevelLine(facts: UnitTooltipFacts): string {
  const level = unitTooltipLevelText(facts);
  const { race, cls } = classSlot(facts);
  const type = typeSlot(facts);
  if (race !== undefined && cls !== undefined) {
    return type === undefined
      ? nativeString("TOOLTIP_UNIT_LEVEL_RACE_CLASS", "%2$s, %3$s %1$s-го уровня", level, race, cls)
      : nativeString("TOOLTIP_UNIT_LEVEL_RACE_CLASS_TYPE", "%2$s, %3$s %1$s-го уровня (%4$s)", level, race, cls, type);
  }
  if (cls !== undefined) {
    return type === undefined
      ? nativeString("TOOLTIP_UNIT_LEVEL_CLASS", "%2$s %1$s-го уровня", level, cls)
      : nativeString("TOOLTIP_UNIT_LEVEL_CLASS_TYPE", "%2$s %1$s-го уровня (%3$s)", level, cls, type);
  }
  return type === undefined
    ? nativeString("TOOLTIP_UNIT_LEVEL", "Уровень %s", level)
    : nativeString("TOOLTIP_UNIT_LEVEL_TYPE", "Уровень %s (%s)", level, type);
}

function white(text: string): TooltipLine {
  return { text, runs: [{ text, color: COLOUR_WHITE }] };
}

/** The tooltip card for the facts, in Wow.exe's line order. */
export function unitTooltipContent(facts: UnitTooltipFacts): TooltipContent {
  const lines: TooltipLine[] = [];
  const second = facts.isPlayer ? facts.guild : facts.subName;
  if (second) lines.push(white(second));
  lines.push(white(unitTooltipLevelLine(facts)));
  if (facts.pvpLine) lines.push(white(nativeString("PVP_ENABLED", "PvP")));
  if (facts.skinnable) {
    const { text, color } = facts.skinnable;
    lines.push({ text, runs: [{ text, color }] });
  }
  return { title: facts.name, titleColor: unitTooltipNameColour(facts), lines, cursor: true };
}

/** A string that changes whenever the card would. */
export function unitTooltipKey(facts: UnitTooltipFacts): string {
  return [
    facts.name, facts.isPlayer, facts.level, facts.playerLevel, facts.dead, facts.reaction, facts.canAttack,
    facts.pvpFlagged, facts.pvpLine, facts.guild, facts.subName, facts.raceName, facts.className,
    facts.creatureType, facts.rank, facts.boss, facts.skinnable?.text, facts.skinnable?.color,
  ].join("\u0001");
}

/** What the gatherer reads from the world client; a structural slice so tests can hand a stub. */
export interface UnitTooltipWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly names: { get(guid: bigint): string | undefined };
  readonly selfName?: string | undefined;
  readonly guildQuery?: GuildQueryInfo | undefined;
  readonly knownSpells?: readonly KnownSpell[] | undefined;
  creatureTemplate(entry: number, guid?: bigint): CreatureTemplate | undefined;
}

export interface UnitTooltipSources {
  /** REACTION_* of the unit to the player, or undefined until the table has landed. */
  readonly reaction: (object: WorldObjectState) => number | undefined;
  readonly canAttack: (object: WorldObjectState) => boolean;
  readonly spellRow: (id: number) => GatherSpellRow | undefined;
}

const toHex = (value: number): string => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");

/**
 * The facts for a creature or player in view, or undefined while its name is not known yet (the
 * template query or the name query is still out; the hover's refresh asks again).
 */
export function unitTooltipFacts(
  world: UnitTooltipWorld, object: WorldObjectState, sources: UnitTooltipSources,
): UnitTooltipFacts | undefined {
  if (object.typeId !== 3 && object.typeId !== 4) return undefined;
  const isPlayer = object.typeId === 4;
  const selfGuid = world.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
  const entry = isPlayer ? 0 : readField(object, "OBJECT_FIELD_ENTRY") ?? 0;
  const template = isPlayer || entry <= 0 ? undefined : world.creatureTemplate(entry, object.guid);
  const name = isPlayer
    ? world.names.get(object.guid) ?? (object.guid === selfGuid ? world.selfName : undefined)
    : template?.found ? template.name : undefined;
  if (!name) return undefined;
  const health = unitField.health(object);
  const dynamicFlags = unitField.dynamicFlags(object) ?? 0;
  const dead = (health !== undefined && health < 1) || (dynamicFlags & UNIT_DYNFLAG_DEAD) !== 0;
  const pvpFlagged = ((unitField.pvpFlags(object) ?? 0) & UNIT_BYTE2_FLAG_PVP) !== 0;
  const contested = isPlayer && ((readField(object, "PLAYER_FLAGS") ?? 0) & PLAYER_FLAGS_CONTESTED_PVP) !== 0;
  // The guild's name is known for the player's own guild only (one `guildQuery` slot); another
  // guild gets no line rather than a number.
  const guildId = isPlayer ? readField(object, "PLAYER_GUILDID") ?? 0 : 0;
  const guild = guildId > 0 && world.guildQuery?.guildId === guildId ? world.guildQuery.name : undefined;
  const petNumber = isPlayer ? 0 : readField(object, "UNIT_FIELD_PETNUMBER") ?? 0;
  const subName = !isPlayer && petNumber === 0 && template?.subName ? template.subName : undefined;
  const skin = isPlayer ? undefined : frameXmlUnitSkinnableLine({
    object,
    player: self,
    templateFlags: () => (template === undefined ? undefined : template.found ? template.flags : 0),
    knownSpells: world.knownSpells ?? [],
    spellRow: sources.spellRow,
  });
  const skinText = skin ? nativeString(skin.globalName, SKIN_FALLBACK[skin.globalName] ?? "") : "";
  return {
    name,
    isPlayer,
    level: unitField.level(object) ?? 0,
    playerLevel: self ? unitField.level(self) : undefined,
    dead,
    reaction: sources.reaction(object),
    canAttack: sources.canAttack(object),
    pvpFlagged,
    pvpLine: pvpFlagged || contested,
    guild,
    subName,
    // L3-review: Wow.exe 0x621070 asks 0x72aa70/0x72aab0 with the unit: names in its sex byte.
    raceName: isPlayer ? raceName(unitField.race(object), femaleOf(unitField.gender(object))) || undefined : undefined,
    className: isPlayer ? className(unitField.classId(object), femaleOf(unitField.gender(object))) || undefined : undefined,
    creatureType: template?.found ? template.creatureType : undefined,
    rank: template?.found ? template.classification : undefined,
    boss: template?.found ? (template.flags & CREATURE_TYPE_FLAG_BOSS) !== 0 : undefined,
    skinnable: skin && skinText
      ? { text: skin.prefix + skinText, color: `#${toHex(skin.color.r)}${toHex(skin.color.g)}${toHex(skin.color.b)}` }
      : undefined,
  };
}

const SKIN_FALLBACK: Readonly<Record<string, string>> = {
  UNIT_SKINNABLE_LEATHER: "Можно снять шкуру",
  UNIT_SKINNABLE_HERB: "Требуется знание травничества",
  UNIT_SKINNABLE_ROCK: "Требуется знание горного дела",
  UNIT_SKINNABLE_BOLTS: "Требуется знание инженерного дела",
};
