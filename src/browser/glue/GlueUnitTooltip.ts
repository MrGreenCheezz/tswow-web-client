/**
 * Plan item 4.04 (13.10): the middle and the tail of `GameTooltip:SetUnit` as Wow.exe 3.3.5a 12340 writes them —
 * the unit tooltip writer 0x00621070 (decompiled in `.runtime/re-2026-09-30/r4/decomp.txt`; its callees read
 * 2026-10-13, `.runtime/re-2026-10-11/glue-1110/t1013-a.txt` … `-j.txt`). GlueWidgets.setGameTooltipUnit writes
 * the name, the guild, the colour-blind standing, the sub-name and the summon title itself, then these rows in
 * this order:
 *
 *  1. **The level line** (0x0062177e … 0x00621b2f), white: one of six templates chosen by which of three slots
 *     are filled — `TOOLTIP_UNIT_LEVEL[_RACE]_CLASS[_TYPE]`, `TOOLTIP_UNIT_LEVEL[_TYPE]`. The level is "%d" or
 *     "??" (a BOSS-flagged creature, a level below 1, or a unit that hates the player standing ten or more
 *     levels above it); a drunk player sees an attackable unit up to six levels lower (0x004f7290: the larger
 *     of PLAYER_BYTES_3 byte 1 and PLAYER_FAKE_INEBRIATION, capped at 100, × 0.01 × 5, rounded by 0x0048bcf0
 *     as fistp(x + 0.5), never below 1). The class slot is CORPSE for a dead unit, the race and class (in the
 *     unit's sex) for a player, else the creature type's name for a creature the player is not friendly with
 *     (and not TREAT_AS_RAID_UNIT, type 10 none). The type slot is PLAYER, else BOSS (type flag 0x4), else ELITE
 *     for ranks 1 and 2 of a creature that is nobody's pet (the table at 0x00ad2e6c; rare and world boss none).
 *  2. **The faction** (0x00621ae0 … 0x00621cd4), white: a unit whose creature record lacks HIDE_FACTION_TOOLTIP
 *     (0x10; 0x00715dd0) and whose template's Faction keeps a reputation: the Faction name, from the first of
 *     the row's four entries whose race mask holds the player's race (or is empty while the class mask is not)
 *     and whose class mask holds the player's class (or is empty) — none when that entry is FACTION_FLAG_HIDDEN
 *     (0x4) or no entry matches.
 *  3. `PVP_ENABLED`, white: UNIT_FIELD_BYTES_2's PvP bit, or a player's PLAYER_FLAGS_CONTESTED_PVP (0x100).
 *  4. `RESURRECTABLE`, green (0x00ad2d40): a player at health below 1 whom the player can assist (0x007293d0).
 *  5. **Beast lore** (UNIT_DYNFLAG_SPECIALINFO 0x10; 0x00620950), white: DAMAGE_TEMPLATE (min rounded, max raised
 *     then rounded — SINGLE_DAMAGE_TEMPLATE when equal), ARMOR_TEMPLATE, HP_TEMPLATE, RESISTANCE_TEMPLATE for each
 *     of the six schools above 0 whose RESISTANCE<i>_NAME is not empty, PET_DIET_TEMPLATE (the family's
 *     PetFoodMask over ItemPetFood, joined by ", "), TAMEABLE / TAMEABLE_EXOTIC / NOT_TAMEABLE, PET_SPELLS_TEMPLATE.
 *  6. The skinnable line (GlueWidgets, FrameXmlSkinnableTooltip.ts).
 *  7. `PVP_RANK_LEADER`, white: a PvP-flagged creature whose record is a racial leader (0x0071b680, +0x3c).
 *  8. **Quest objectives** (0x00621e66 … 0x0062220c, the `showQuestTrackingTooltips` CVar, default "1"): for a
 *     creature not summoned by a player, each quest of the log in its order that the creature, its two kill
 *     credits or its six quest items count for — the title in gold (0x00ad2d2c), then " - %s" rows, white.
 *  9. The loot owners of a corpse (GlueWidgets, FrameXmlLootOwnerTooltip.ts).
 * 10. **Threat** (0x00622317, while IsThreatWarningEnabled — 0x00519df0 keeps the same flag): THREAT_TOOLTIP
 *     with the player's scaled threat on the unit less 0.5, rounded half to even (fistp), white — the value
 *     `UnitDetailedThreatSituation("player", unit)` answers third (0x00613b40 reads the same 0x007374c0).
 *     Wow.exe then puts the threat icon (Interface\RaidFrame\UI-RaidFrame-Threat, tinted by the status) on the
 *     line; GameTooltip:AddTexture is not drawn by this client, so the icon is missing.
 *
 * The world's answers come from the adapter (`unitTooltipFacts`, FrameXmlUnitTooltipFacts.ts on the live seam);
 * without them (the canned routes) the level line is chosen from the Lua C API by the same slot rules.
 */
import type { FrameXmlColor } from "../ui/framexml_compat/FrameXmlTypes.js";

/** The level line's three slots (0x00621070's local_70, local_1b0/local_130, local_b0). */
export interface GameTooltipUnitLevelSlots {
  /** "%d" of the (adjusted) level, or "??". */
  readonly level: string;
  /** A player's race in its sex (the RACE_CLASS templates); with `cls`. */
  readonly race?: string | undefined;
  /** A player's class in its sex, or a creature type's name. */
  readonly cls?: string | undefined;
  /** The class slot is CORPSE (a dead unit). */
  readonly corpse?: boolean | undefined;
  readonly typeKey?: "PLAYER" | "BOSS" | "ELITE" | undefined;
}

/** A GlobalStrings template and its arguments; `{ global }` is another GlobalStrings value. */
export interface GameTooltipUnitRow {
  readonly key: string;
  readonly args: readonly (string | number | { readonly global: string })[];
}

/** One quest's rows: its title and the " - %s" lines under it (a template, or a plain name). */
export interface GameTooltipUnitQuest {
  readonly title: string;
  readonly lines: readonly (GameTooltipUnitRow | { readonly text: string })[];
}

/** What the world knows for the rows above; undefined members write nothing. */
export interface GameTooltipUnitFacts {
  readonly level: GameTooltipUnitLevelSlots;
  readonly factionName?: string | undefined;
  readonly pvp?: boolean | undefined;
  readonly resurrectable?: boolean | undefined;
  readonly beastLore?: readonly GameTooltipUnitRow[] | undefined;
  readonly leader?: boolean | undefined;
  readonly quests?: readonly GameTooltipUnitQuest[] | undefined;
}

/** What the rows read of the Lua state; GlueWidgets satisfies it. */
export interface GlueUnitTooltipHost {
  callGlobal(name: string, args: readonly unknown[], results: number): readonly unknown[];
  globalString(key: string): string | undefined;
  format(template: string, ...values: readonly unknown[]): string;
}

export interface GlueUnitTooltipRow {
  readonly text: string;
  readonly color: FrameXmlColor;
}

export const GLUE_UNIT_TOOLTIP_WHITE: FrameXmlColor = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });
/** 0x00ad2d2c (0xffffd200): the name and quest-title gold. */
export const GLUE_UNIT_TOOLTIP_GOLD: FrameXmlColor = Object.freeze({ r: 1, g: 210 / 255, b: 0, a: 1 });
/** 0x00ad2d40 (0xff00ff00). */
export const GLUE_UNIT_TOOLTIP_GREEN: FrameXmlColor = Object.freeze({ r: 0, g: 1, b: 0, a: 1 });

/** CreatureType 10 «Не указано» has no word; on the Lua path the name is all there is. */
const LEVEL_SKULL_GAP = 10;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The slots from the Lua C API, for a seam without world facts (the canned routes): the same rules over what
 * Lua can tell — `UnitIsDead`, `UnitIsPlayer`, `UnitRace`/`UnitClass`, `UnitCreatureType` for a unit the
 * player's `UnitReaction` is below friendly (5) on, `UnitClassification` (worldboss → BOSS and "??", elite and
 * rareelite → ELITE), and the skull for a unit whose `UnitReaction(unit, "player")` is hostile or worse.
 */
export function glueUnitLevelSlotsFromLua(host: GlueUnitTooltipHost, unit: string): GameTooltipUnitLevelSlots {
  const call = (name: string, args: readonly unknown[]): unknown => host.callGlobal(name, args, 1)[0];
  const player = call("UnitIsPlayer", [unit]) === true;
  const dead = call("UnitIsDead", [unit]) === true;
  const level = num(call("UnitLevel", [unit])) ?? 0;
  const classification = call("UnitClassification", [unit]);
  const boss = !player && classification === "worldboss";
  const hates = num(call("UnitReaction", [unit, "player"]));
  const ownLevel = num(call("UnitLevel", ["player"]));
  const skull = hates !== undefined && hates < 3 && ownLevel !== undefined && ownLevel <= level - LEVEL_SKULL_GAP;
  const slots: { level: string; race?: string; cls?: string; corpse?: boolean; typeKey?: "PLAYER" | "BOSS" | "ELITE" } = {
    level: skull || boss || level < 1 ? "??" : String(Math.trunc(level)),
  };
  if (dead) slots.corpse = true;
  else if (player) {
    const race = call("UnitRace", [unit]);
    const cls = call("UnitClass", [unit]);
    if (typeof race === "string" && race && typeof cls === "string" && cls) { slots.race = race; slots.cls = cls; }
  } else {
    const view = num(call("UnitReaction", ["player", unit]));
    const type = call("UnitCreatureType", [unit]);
    if (view !== undefined && view < 5 && typeof type === "string" && type) slots.cls = type;
  }
  if (player) slots.typeKey = "PLAYER";
  else if (boss) slots.typeKey = "BOSS";
  else if (classification === "elite" || classification === "rareelite") slots.typeKey = "ELITE";
  return slots;
}

/** The level line's text: the template 0x00621070 picks for the filled slots. */
export function glueUnitLevelText(host: GlueUnitTooltipHost, slots: GameTooltipUnitLevelSlots): string | undefined {
  const cls = slots.corpse ? host.globalString("CORPSE") : slots.cls;
  const type = slots.typeKey ? host.globalString(slots.typeKey) : undefined;
  const race = slots.corpse ? undefined : slots.race;
  const template = (key: string): string | undefined => host.globalString(key);
  let key: string;
  let args: string[];
  if (race && cls) {
    key = type ? "TOOLTIP_UNIT_LEVEL_RACE_CLASS_TYPE" : "TOOLTIP_UNIT_LEVEL_RACE_CLASS";
    args = type ? [slots.level, race, cls, type] : [slots.level, race, cls];
  } else if (cls) {
    key = type ? "TOOLTIP_UNIT_LEVEL_CLASS_TYPE" : "TOOLTIP_UNIT_LEVEL_CLASS";
    args = type ? [slots.level, cls, type] : [slots.level, cls];
  } else {
    key = type ? "TOOLTIP_UNIT_LEVEL_TYPE" : "TOOLTIP_UNIT_LEVEL";
    args = type ? [slots.level, type] : [slots.level];
  }
  const text = template(key);
  return text === undefined ? undefined : host.format(text, ...args);
}

/** One GlobalStrings row; undefined when its template or a `{ global }` argument is missing or empty. */
export function glueUnitRowText(host: GlueUnitTooltipHost, row: GameTooltipUnitRow): string | undefined {
  const template = host.globalString(row.key);
  if (!template) return undefined;
  const args: (string | number)[] = [];
  for (const arg of row.args) {
    if (typeof arg === "object") {
      const value = host.globalString(arg.global);
      if (!value) return undefined;
      args.push(value);
    } else args.push(arg);
  }
  return args.length === 0 ? template : host.format(template, ...args);
}

/** Rows 2-5 (faction … beast lore), in order. */
export function glueUnitRowsBeforeSkin(host: GlueUnitTooltipHost, facts: GameTooltipUnitFacts | undefined,
  luaPvp: () => boolean): GlueUnitTooltipRow[] {
  const rows: GlueUnitTooltipRow[] = [];
  const white = (text: string | undefined): void => { if (text) rows.push({ text, color: GLUE_UNIT_TOOLTIP_WHITE }); };
  white(facts?.factionName);
  if (facts?.pvp ?? luaPvp()) white(host.globalString("PVP_ENABLED"));
  const resurrectable = facts?.resurrectable ? host.globalString("RESURRECTABLE") : undefined;
  if (resurrectable) rows.push({ text: resurrectable, color: GLUE_UNIT_TOOLTIP_GREEN });
  for (const row of facts?.beastLore ?? []) white(glueUnitRowText(host, row));
  return rows;
}

/** Rows 7-8 (the racial leader, the quests), in order; the quests only with `showQuestTrackingTooltips` on. */
export function glueUnitRowsAfterSkin(host: GlueUnitTooltipHost, facts: GameTooltipUnitFacts | undefined): GlueUnitTooltipRow[] {
  const rows: GlueUnitTooltipRow[] = [];
  if (facts?.leader) {
    const text = host.globalString("PVP_RANK_LEADER");
    if (text) rows.push({ text, color: GLUE_UNIT_TOOLTIP_WHITE });
  }
  if (facts?.quests?.length && host.callGlobal("GetCVarBool", ["showQuestTrackingTooltips"], 1)[0] === true) {
    for (const quest of facts.quests) {
      rows.push({ text: quest.title, color: GLUE_UNIT_TOOLTIP_GOLD });
      for (const line of quest.lines) {
        const text = "text" in line ? line.text : glueUnitRowText(host, line);
        // " - %s" (0x009e…): the row is written whatever the text, as 0x0076f070 formats it.
        rows.push({ text: ` - ${text ?? ""}`, color: GLUE_UNIT_TOOLTIP_WHITE });
      }
    }
  }
  return rows;
}

/** fistp's default rounding: to nearest, ties to even. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Row 10: THREAT_TOOLTIP when the warning is on and the unit has the player on its threat list. */
export function glueUnitThreatRow(host: GlueUnitTooltipHost, unit: string): GlueUnitTooltipRow | undefined {
  if (host.callGlobal("IsThreatWarningEnabled", [], 1)[0] !== true) return undefined;
  const [, status, scaled] = host.callGlobal("UnitDetailedThreatSituation", ["player", unit], 3);
  const percent = num(scaled);
  if (num(status) === undefined || percent === undefined) return undefined;
  const template = host.globalString("THREAT_TOOLTIP");
  if (!template) return undefined;
  // 0x00622317: (int)ROUND(pct - 0.5f) — so 99 % reads 98 % and 100 % reads 100 %.
  return { text: host.format(template, roundHalfEven(Math.fround(percent) - 0.5)), color: GLUE_UNIT_TOOLTIP_WHITE };
}
