import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { readField, unit } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { characterStats, characterWindow } from "./Dom.js";
import { formatMoney, formatPlayed, reputationRank } from "./Format.js";
import { skinnable, slotElement, slotSiblings } from "./Slots.js";
import { textLine } from "./Widgets.js";

/**
 * The character sheet: what the character is made of, beyond the health bar.
 *
 * Most of this has always been in the update fields and was never read — five stats, seven
 * resistances, the melee numbers — and the rest arrives in packets the world loop used to drop:
 * reputation, played time, titles, talent points.
 */
const STAT_NAMES = ["Сила", "Ловкость", "Выносливость", "Интеллект", "Дух"];

/** `SPELL_SCHOOL` order, and the first of them is armour rather than a resistance. */
const RESISTANCE_NAMES = ["Броня", "Тьма", "Огонь", "Природа", "Лёд", "Тень", "Магия"];

function fieldAt(object: WorldObjectState, name: keyof typeof UPDATE_FIELDS, offset: number): number {
  return object.fields.get(UPDATE_FIELDS[name].offset + offset) ?? 0;
}

function section(title: string, lines: HTMLElement[]): HTMLElement {
  const block = document.createElement("section");
  block.className = "sheet-section";
  const heading = document.createElement("h4");
  heading.textContent = title;
  block.append(heading, ...lines);
  return block;
}

/**
 * The two slots this window offers a module (М7), and the window itself for a `class:` entry.
 *
 * Both hosts are made once and kept, and the stats one is not touched by a redraw at all.
 * `showCharacterSheet` runs once a frame — `renderInventory` calls it above its own signature
 * guard, because money and a stat move without any slot moving — so a host built per draw would
 * rebuild a module's block sixty times a second, which is the one thing the renderer exists not to
 * do. Keeping the host and handing it back to `replaceChildren` was only half of the fix: the node
 * survived, so nothing was rebuilt and nothing in it was lost, but it was still removed and
 * re-inserted once a frame — and removing a focused element unfocuses it, so an `EditBox` a module
 * put in this slot would have kept its text and lost the caret sixty times a second. The sheet's
 * own blocks are therefore redrawn inside a box of their own, and `characterStats` itself is
 * written once, here. See {@link slotSiblings}.
 */
const characterStatsHost = slotElement("character-window/stats");
const characterFooter = slotElement("character-window/footer");
const drawStats = slotSiblings(characterStats, characterStatsHost);
characterWindow.append(characterFooter);
skinnable("character-window", characterWindow);

export function showCharacterSheet(): void {
  const world = game.world;
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world?.state.objects.get(guid);
  if (!world || !self) {
    drawStats([textLine("Персонаж", "нет данных")]);
    return;
  }

  const level = unit.level(self) ?? 0;
  const experience = readField(self, "PLAYER_XP") ?? 0;
  const nextLevel = readField(self, "PLAYER_NEXT_LEVEL_XP") ?? 0;
  const money = readField(self, "PLAYER_FIELD_COINAGE") ?? 0;

  const general = [
    textLine("Уровень", String(level)),
    textLine("Опыт", nextLevel > 0 ? `${experience} / ${nextLevel}` : String(experience)),
    textLine("Деньги", formatMoney(money)),
  ];
  if (world.playedTime) {
    general.push(textLine("Сыграно", formatPlayed(world.playedTime.total)));
    general.push(textLine("На уровне", formatPlayed(world.playedTime.atLevel)));
  }
  if (world.talents) general.push(textLine("Очки талантов", String(world.talents.unspentPoints)));
  if (world.achievements.size > 0) general.push(textLine("Достижений", String(world.achievements.size)));
  if (world.titles.size > 0) general.push(textLine("Титулов", String(world.titles.size)));

  const stats = STAT_NAMES.map((name, index) => textLine(name, String(fieldAt(self, "UNIT_FIELD_STAT0", index))));

  const combat = [
    textLine("Сила атаки", String(fieldAt(self, "UNIT_FIELD_ATTACK_POWER", 0))),
    textLine("Дальний бой", String(fieldAt(self, "UNIT_FIELD_RANGED_ATTACK_POWER", 0))),
    textLine("Урон", `${Math.round(readField(self, "UNIT_FIELD_MINDAMAGE") ?? 0)}–${Math.round(readField(self, "UNIT_FIELD_MAXDAMAGE") ?? 0)}`),
    textLine("Крит", `${(readField(self, "PLAYER_CRIT_PERCENTAGE") ?? 0).toFixed(2)} %`),
    textLine("Уклонение", `${(readField(self, "PLAYER_DODGE_PERCENTAGE") ?? 0).toFixed(2)} %`),
    textLine("Парирование", `${(readField(self, "PLAYER_PARRY_PERCENTAGE") ?? 0).toFixed(2)} %`),
    textLine("Блок", `${(readField(self, "PLAYER_BLOCK_PERCENTAGE") ?? 0).toFixed(2)} %`),
  ];

  const resistances = RESISTANCE_NAMES.map((name, index) =>
    textLine(name, String(fieldAt(self, "UNIT_FIELD_RESISTANCES", index))));

  const blocks = [
    section("Общее", general),
    section("Характеристики", stats),
    section("Бой", combat),
    section("Сопротивления", resistances),
  ];

  // Only factions the character has actually met are worth a line; the server sends all 128.
  const met = [...world.factions.values()].filter((faction) => (faction.flags & 1) !== 0 && faction.standing !== 0);
  if (met.length > 0) {
    const lines = met
      .sort((left, right) => right.standing - left.standing)
      .slice(0, 20)
      .map((faction) => textLine(
        game.factions?.name(faction.listId) ?? `Фракция ${faction.listId}`,
        `${reputationRank(faction.standing)} · ${faction.standing}`,
      ));
    blocks.push(section("Репутация", lines));
  }

  drawStats(blocks);
}
