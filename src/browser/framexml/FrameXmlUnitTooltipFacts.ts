/**
 * Plan item 4.04 (13.10): the world's answers for the rows GlueUnitTooltip.ts writes — the unit tooltip writer
 * of Wow.exe 3.3.5a 12340 (0x00621070) over this client's world (see that file for the rows and their order).
 * Each function names the Wow.exe code it follows; all of them are DOM-free and read only what they are handed.
 *
 * What is not answered, for want of data:
 * * PET_SPELLS_TEMPLATE of beast lore (0x00620950 reads CreatureFamily.SkillLine[2] and their SkillLineAbility
 *   rows with AcquireMethod 2 — no gateway route serves the family's skill lines);
 * * the quest checks 0x005e0ea0 makes beyond the counters and the carried items (reputation, money, player
 *   kills, an expired timer) when it decides whether a quest's source items are still worth a line.
 */
import { readByte, readField } from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { GameTooltipUnitFacts, GameTooltipUnitLevelSlots, GameTooltipUnitQuest, GameTooltipUnitRow } from "../glue/GlueUnitTooltip.js";

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
/** CreatureType 10, «Не указано»: no word in the class slot (0x00621712). */
const CREATURE_TYPE_NOT_SPECIFIED = 10;
/** Creature type flags (CreatureCache +0xc): BOSS_MOB, HIDE_FACTION_TOOLTIP, TREAT_AS_RAID_UNIT, TAMEABLE, EXOTIC. */
const TYPE_FLAG_BOSS = 0x4;
const TYPE_FLAG_HIDE_FACTION_TOOLTIP = 0x10;
const TYPE_FLAG_TREAT_AS_RAID_UNIT = 0x0400_0000;
const TYPE_FLAG_TAMEABLE = 0x1;
const TYPE_FLAG_EXOTIC_PET = 0x1_0000;
/** UNIT_DYNAMIC_FLAGS: SPECIALINFO (beast lore), DEAD. */
const DYNFLAG_SPECIALINFO = 0x10;
const DYNFLAG_DEAD = 0x20;
/** UNIT_FIELD_BYTES_2 byte 1 bit 0: UNIT_BYTE2_FLAG_PVP. */
const BYTE2_FLAG_PVP = 0x01;
/** PLAYER_FLAGS_CONTESTED_PVP. */
const PLAYER_FLAGS_CONTESTED_PVP = 0x100;
/** FACTION_FLAG_HIDDEN (Faction.ReputationFlags). */
const FACTION_FLAG_HIDDEN = 0x4;
/** ReputationRank friendly (4): the creature type word is written below it (0x0062171e). */
const REACTION_FRIENDLY_RANK = 4;
/** QUEST_STATE_FAIL. */
const QUEST_STATE_FAIL = 0x2;

/** The creature cache record (SMSG_CREATURE_QUERY_RESPONSE) as these rows read it. */
export interface FrameXmlUnitCreatureRecord {
  readonly found: boolean;
  readonly name?: string;
  readonly flags: number;
  readonly creatureFamily?: number;
  readonly classification: number;
  readonly proxyCreatureIds?: readonly number[];
  readonly leader?: boolean;
  readonly questItems?: readonly number[];
}

/** What the level slots read beyond the unit and the player. */
export interface FrameXmlUnitLevelSources {
  /** 0x0071f300 for the unit (FrameXmlCreatureType.ts frameXmlCreatureTypeId); undefined unknown. */
  readonly creatureTypeId?: number | undefined;
  /** CreatureType.dbc's name of an id; undefined for an id the table has no row for. */
  readonly creatureTypeName?: ((id: number) => string | undefined) | undefined;
  /** The player's view of the unit (0x007251c0(player, unit)) as a rank; undefined unknown. */
  readonly playerRank?: number | undefined;
  /** The unit's view of the player (0x007251c0(unit, player)) as a rank; undefined unknown. */
  readonly unitRank?: number | undefined;
  /** CanAttack (0x00729740) — the drunk player's lower levels apply only then. */
  readonly canAttack: boolean;
  /** UnitRace/UnitClass in the unit's sex (0x0072aa70/0x0072aab0), for a player. */
  readonly raceName?: string | undefined;
  readonly className?: string | undefined;
}

function signedField(object: WorldObjectState, offset: number): number {
  return (object.fields.get(offset) ?? 0) | 0;
}

/** Health below 1 (0x00621070 reads UNIT_FIELD_HEALTH, +0x48) or UNIT_DYNFLAG_DEAD. */
export function frameXmlUnitTooltipDead(object: WorldObjectState): boolean {
  return (readField(object, "UNIT_FIELD_HEALTH") ?? 0) < 1 || ((readField(object, "UNIT_DYNAMIC_FLAGS") ?? 0) & DYNFLAG_DEAD) !== 0;
}

/**
 * 0x004f7290 then 0x0048bcf0: the levels a drunk player takes off an attackable unit — the larger of the
 * drunk value (PLAYER_BYTES_3 byte 1) and PLAYER_FAKE_INEBRIATION (its low byte when it is the larger),
 * 100 at most, × 0.01f, × 5.0f to a float, then fistp(x + 0.5): 10 → 1, 50 → 3, 100 → 6.
 */
export function frameXmlDrunkLevelDrop(self: WorldObjectState): number {
  const drunk = readByte(self, "PLAYER_BYTES_3", 1) ?? 0;
  const fake = (readField(self, "PLAYER_FAKE_INEBRIATION") ?? 0) | 0;
  if (drunk === 0 && fake === 0) return 0;
  let value: number;
  if ((drunk >= fake ? drunk : fake) >= 100) value = 100;
  else value = fake < drunk ? drunk : fake & 0xff;
  const scaled = Math.fround(value * Math.fround(0.01) * 5);
  const x = scaled + 0.5;
  const floor = Math.floor(x);
  const diff = x - floor;
  return diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : (floor % 2 === 0 ? floor : floor + 1);
}

/** The three slots of the level line for a unit in view (0x00621070, 0x006216c0 … 0x00621a00). */
export function frameXmlUnitLevelSlots(
  object: WorldObjectState, self: WorldObjectState | undefined, record: FrameXmlUnitCreatureRecord | undefined,
  sources: FrameXmlUnitLevelSources,
): GameTooltipUnitLevelSlots {
  const player = object.typeId === TYPEID_PLAYER;
  const flags = record?.found ? record.flags : 0;
  const dead = frameXmlUnitTooltipDead(object);
  let level = (readField(object, "UNIT_FIELD_LEVEL") ?? 0) | 0;
  const type = sources.creatureTypeId;
  // The creature type word: not «Не указано», the player not friendly with it, not a raid unit (0x00715df0).
  let typeName: string | undefined;
  if (type !== undefined && type !== CREATURE_TYPE_NOT_SPECIFIED && self && sources.playerRank !== undefined
    && sources.playerRank < REACTION_FRIENDLY_RANK && (flags & TYPE_FLAG_TREAT_AS_RAID_UNIT) === 0) {
    typeName = sources.creatureTypeName?.(type);
  }
  let question = false;
  // 0x0062173a: hostile or worse towards the player and ten levels above it.
  if (self && sources.unitRank !== undefined && sources.unitRank < 2
    && ((readField(self, "UNIT_FIELD_LEVEL") ?? 0) | 0) <= level - 10) question = true;
  if (!question && (flags & TYPE_FLAG_BOSS) !== 0) question = true; // 0x00715d70
  if (!question && level < 1) question = true;
  if (!question && self && sources.canAttack) {
    const drop = frameXmlDrunkLevelDrop(self);
    if (drop !== 0) level = level - drop > 0 ? level - drop : 1;
  }
  const slots: { level: string; race?: string; cls?: string; corpse?: boolean; typeKey?: "PLAYER" | "BOSS" | "ELITE" } = {
    level: question ? "??" : String(level),
  };
  if (dead) slots.corpse = true;
  else if (player) {
    if (sources.raceName && sources.className) { slots.race = sources.raceName; slots.cls = sources.className; }
  } else if (typeName) slots.cls = typeName;
  if (player) slots.typeKey = "PLAYER";
  else if ((flags & TYPE_FLAG_BOSS) !== 0) slots.typeKey = "BOSS";
  // 0x00718a00: the record's rank only for a unit that is nobody's pet; 0x00ad2e6c names ranks 1 and 2.
  else if (record?.found && (readField(object, "UNIT_FIELD_PETNUMBER") ?? 0) === 0
    && (record.classification === 1 || record.classification === 2)) slots.typeKey = "ELITE";
  return slots;
}

/** One Faction.dbc row with a reputation, as the faction line reads it. */
export interface FrameXmlUnitFactionRow {
  readonly raceMasks?: readonly number[];
  readonly classMasks?: readonly number[];
  readonly flags?: readonly number[];
}

/**
 * The faction line (0x00621ae0): the row's name when the first entry matching the player's race and class is
 * not hidden; undefined for a unit with HIDE_FACTION_TOOLTIP, no row, no match, a hidden entry or no name.
 */
export function frameXmlUnitFactionName(
  record: FrameXmlUnitCreatureRecord | undefined, row: FrameXmlUnitFactionRow | undefined, name: string | undefined,
  race: number, playerClass: number,
): string | undefined {
  if (record?.found && (record.flags & TYPE_FLAG_HIDE_FACTION_TOOLTIP) !== 0) return undefined;
  if (!row || !name) return undefined;
  const raceBit = race > 0 ? 1 << (race - 1) : 0;
  const classBit = playerClass > 0 ? 1 << (playerClass - 1) : 0;
  for (let index = 0; index < 4; index += 1) {
    const races = (row.raceMasks?.[index] ?? 0) | 0;
    const classes = (row.classMasks?.[index] ?? 0) | 0;
    const matches = races === 0 ? classes : races & raceBit;
    if (matches !== 0 && (classes === 0 || (classes & classBit) !== 0)) {
      return ((row.flags?.[index] ?? 0) & FACTION_FLAG_HIDDEN) === 0 ? name : undefined;
    }
  }
  return undefined;
}

/** UNIT_BYTE2_FLAG_PVP, or a player's PLAYER_FLAGS_CONTESTED_PVP (0x00621cd4). */
export function frameXmlUnitPvpLine(object: WorldObjectState): boolean {
  if (((readByte(object, "UNIT_FIELD_BYTES_2", 1) ?? 0) & BYTE2_FLAG_PVP) !== 0) return true;
  return object.typeId === TYPEID_PLAYER && ((readField(object, "PLAYER_FLAGS") ?? 0) & PLAYER_FLAGS_CONTESTED_PVP) !== 0;
}

/** RESURRECTABLE: a player at health below 1 whom the player can assist (0x00621d3a). */
export function frameXmlUnitResurrectable(object: WorldObjectState, self: WorldObjectState | undefined, canAssist: boolean): boolean {
  return object.typeId === TYPEID_PLAYER && self !== undefined && (readField(object, "UNIT_FIELD_HEALTH") ?? 0) < 1 && canAssist;
}

/** PVP_RANK_LEADER (0x0071b680): the PvP bit and a racial leader's creature record. */
export function frameXmlUnitRacialLeader(object: WorldObjectState, record: FrameXmlUnitCreatureRecord | undefined): boolean {
  return ((readByte(object, "UNIT_FIELD_BYTES_2", 1) ?? 0) & BYTE2_FLAG_PVP) !== 0 && record?.found === true && record.leader === true;
}

/** fistp's default rounding. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  return diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : (floor % 2 === 0 ? floor : floor + 1);
}

/** The family's diet as beast lore reads it: ItemPetFood names by the family's PetFoodMask. */
export interface FrameXmlBeastLoreFoods {
  familyMask(family: number): number;
  foodNames(mask: number): readonly string[];
}

/** The beast lore rows (0x00620950) for a unit with UNIT_DYNFLAG_SPECIALINFO; none without it. */
export function frameXmlBeastLoreRows(
  object: WorldObjectState, record: FrameXmlUnitCreatureRecord | undefined, foods: FrameXmlBeastLoreFoods | undefined,
): GameTooltipUnitRow[] {
  if (((readField(object, "UNIT_DYNAMIC_FLAGS") ?? 0) & DYNFLAG_SPECIALINFO) === 0) return [];
  const rows: GameTooltipUnitRow[] = [];
  const min = roundHalfEven(readField(object, "UNIT_FIELD_MINDAMAGE") ?? 0);
  const max = roundHalfEven(Math.ceil(readField(object, "UNIT_FIELD_MAXDAMAGE") ?? 0));
  rows.push(min === max ? { key: "SINGLE_DAMAGE_TEMPLATE", args: [min] } : { key: "DAMAGE_TEMPLATE", args: [min, max] });
  // UNIT_FIELD_RESISTANCES (+0x174): school 0 is the armour (0x006337a0's index), shown even at 0.
  const offset = UPDATE_FIELDS.UNIT_FIELD_RESISTANCES.offset;
  const armor = signedField(object, offset);
  rows.push({ key: "ARMOR_TEMPLATE", args: [armor > 0 ? armor : 0] });
  rows.push({ key: "HP_TEMPLATE", args: [(readField(object, "UNIT_FIELD_HEALTH") ?? 0) | 0] });
  for (let school = 1; school < 7; school += 1) {
    const value = signedField(object, offset + school);
    if (value > 0) rows.push({ key: "RESISTANCE_TEMPLATE", args: [value, { global: `RESISTANCE${school}_NAME` }] });
  }
  const family = record?.found ? record.creatureFamily ?? 0 : 0;
  const mask = family > 0 && foods ? foods.familyMask(family) : 0;
  const diet = mask !== 0 && foods ? foods.foodNames(mask).filter((name) => name.length > 0) : [];
  if (diet.length > 0) rows.push({ key: "PET_DIET_TEMPLATE", args: [diet.join(", ")] }); // 0x009fc494 ", "
  const flags = record?.found ? record.flags : 0;
  if ((flags & TYPE_FLAG_TAMEABLE) === 0 || family === 0) rows.push({ key: "NOT_TAMEABLE", args: [] });
  else rows.push({ key: (flags & TYPE_FLAG_EXOTIC_PET) === 0 ? "TAMEABLE" : "TAMEABLE_EXOTIC", args: [] });
  return rows;
}

/** The quest rows' sources (FrameXmlUnitTooltipFacts.ts `frameXmlUnitQuestRows`). */
export interface FrameXmlUnitQuestSources {
  /** The log's quests in its displayed order (headers left out), each with its cache record. */
  readonly rows: readonly {
    readonly entry: { readonly state: number; readonly counters: readonly number[] };
    readonly template: FrameXmlUnitQuestTemplate;
  }[];
  /** Names from the caches; undefined while not cached (the caller asks for it and waits). */
  creatureName(entry: number): string | undefined;
  itemName(itemId: number): string | undefined;
  /** Carried in the bags (0x00754d00). */
  itemCount(itemId: number): number;
}

export interface FrameXmlUnitQuestTemplate {
  readonly title: string;
  readonly startItem?: number;
  readonly objectives: readonly {
    readonly slot: number; readonly entry: number; readonly count: number; readonly gameObject: boolean; readonly text: string;
  }[];
  readonly itemObjectives: readonly { readonly itemId: number; readonly count: number }[];
  readonly sourceItems?: readonly number[];
}

/** 0x005e0ea0's objective part: every creature counter and carried item at its count, and not failed. */
function questObjectivesDone(entry: { readonly state: number; readonly counters: readonly number[] },
  template: FrameXmlUnitQuestTemplate, itemCount: (itemId: number) => number): boolean {
  if ((entry.state & QUEST_STATE_FAIL) !== 0) return false;
  if (template.objectives.length === 0 && template.itemObjectives.length === 0) return false;
  for (const objective of template.objectives) if ((entry.counters[objective.slot] ?? 0) < objective.count) return false;
  for (const item of template.itemObjectives) if (itemCount(item.itemId) < item.count) return false;
  return true;
}

/**
 * The quest rows (0x00621e66 … 0x0062220c) for a creature: per quest, 0x005e2370 for its entry and its two kill
 * credits (the first objective naming the entry: QUEST_OBJECTS_FOUND with the objective's own text, else
 * QUEST_MONSTERS_KILLED with the creature's name, the counter and the count), then for each of its six quest
 * items (until the first 0) 0x005e2630 (QUEST_ITEMS_NEEDED with the item's name, the carried count up to the
 * need, the need — not for the quest's own start item needed once) and, while the quest is not done, the item's
 * name when it is one of the four source items. A name not cached is " " (0x009e1050).
 */
export function frameXmlUnitQuestRows(
  creatureEntry: number, record: FrameXmlUnitCreatureRecord, sources: FrameXmlUnitQuestSources,
): GameTooltipUnitQuest[] {
  const quests: GameTooltipUnitQuest[] = [];
  const credits = [creatureEntry, ...(record.proxyCreatureIds ?? []).slice(0, 2)];
  const items: number[] = [];
  for (const item of (record.questItems ?? []).slice(0, 6)) { if (item === 0) break; items.push(item); }
  for (const { entry, template } of sources.rows) {
    const lines: (GameTooltipUnitRow | { readonly text: string })[] = [];
    credits.forEach((credit, index) => {
      if (credit === 0 && index > 0) return;
      const objective = template.objectives.find((row) => !row.gameObject && row.entry === credit);
      if (!objective) return;
      const counter = entry.counters[objective.slot] ?? 0;
      lines.push(objective.text
        ? { key: "QUEST_OBJECTS_FOUND", args: [objective.text, counter, objective.count] }
        : { key: "QUEST_MONSTERS_KILLED", args: [sources.creatureName(objective.entry) ?? " ", counter, objective.count] });
    });
    let done: boolean | undefined;
    for (const item of items) {
      const need = template.itemObjectives.find((row) => row.itemId === item && (row.itemId !== (template.startItem ?? 0) || row.count > 1));
      if (need) {
        const have = Math.min(sources.itemCount(item), need.count);
        lines.push({ key: "QUEST_ITEMS_NEEDED", args: [sources.itemName(item) ?? " ", have, need.count] });
      }
      done ??= questObjectivesDone(entry, template, (id) => sources.itemCount(id));
      if (done) continue;
      for (const source of (template.sourceItems ?? []).slice(0, 4)) {
        if (source !== item) continue;
        const name = sources.itemName(item);
        if (name !== undefined) lines.push({ text: name });
      }
    }
    if (lines.length > 0) quests.push({ title: template.title, lines });
  }
  return quests;
}

/** Whether the creature was summoned by a player (UNIT_FIELD_SUMMONEDBY a player guid): no quest rows then. */
export function frameXmlSummonedByPlayer(object: WorldObjectState): boolean {
  const owner = readField(object, "UNIT_FIELD_SUMMONEDBY") ?? 0n;
  return owner !== 0n && (owner >> 60n) === 0n;
}

/** Everything the live seam gathers for one unit (LiveWorldSeam.unitTooltipFacts). */
export interface FrameXmlUnitTooltipFactsInput {
  readonly object: WorldObjectState;
  readonly self: WorldObjectState | undefined;
  readonly record: FrameXmlUnitCreatureRecord | undefined;
  readonly level: FrameXmlUnitLevelSources;
  readonly factionRow?: FrameXmlUnitFactionRow | undefined;
  readonly factionName?: string | undefined;
  readonly canAssist: boolean;
  readonly foods?: FrameXmlBeastLoreFoods | undefined;
  readonly quests?: FrameXmlUnitQuestSources | undefined;
}

/** The facts GlueUnitTooltip.ts writes from. */
export function frameXmlUnitTooltipFacts(input: FrameXmlUnitTooltipFactsInput): GameTooltipUnitFacts {
  const { object, self, record } = input;
  const unitObject = object.typeId === TYPEID_UNIT;
  const race = self ? readByte(self, "UNIT_FIELD_BYTES_0", 0) ?? 0 : 0;
  const playerClass = self ? readByte(self, "UNIT_FIELD_BYTES_0", 1) ?? 0 : 0;
  const quests = unitObject && record?.found && input.quests && !frameXmlSummonedByPlayer(object)
    ? frameXmlUnitQuestRows((readField(object, "OBJECT_FIELD_ENTRY") ?? 0) | 0, record, input.quests) : undefined;
  return {
    level: frameXmlUnitLevelSlots(object, self, record, input.level),
    factionName: self ? frameXmlUnitFactionName(record, input.factionRow, input.factionName, race, playerClass) : undefined,
    pvp: frameXmlUnitPvpLine(object),
    resurrectable: frameXmlUnitResurrectable(object, self, input.canAssist),
    beastLore: frameXmlBeastLoreRows(object, record, input.foods),
    leader: frameXmlUnitRacialLeader(object, record),
    quests,
  };
}
