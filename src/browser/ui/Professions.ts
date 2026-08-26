import { game } from "../game/Context.js";
import { Bar, Panel, textLine } from "./Widgets.js";
import {
  SKILL_CATEGORY_NAMES, SKILL_CATEGORY_ORDER, effectiveSkill, readSkills, type SkillEntry,
} from "./Skills.js";

/**
 * The skills window: professions first, then everything else the character has a number for.
 *
 * Nothing here arrives in a packet. The 127 skill slots have been in `PLAYER_SKILL_INFO_1_1` since
 * the first login and no line of this client read them, which is why a character with 450
 * blacksmithing had nowhere at all to see it. The names come from `SkillLine.dbc` through
 * `/dbc/talents`, since that endpoint already carries the table for the spellbook's tabs.
 */

let panel: Panel | undefined;

export function toggleProfessionsWindow(): void {
  panel ??= new Panel({ id: "professions-window", title: "Навыки", className: "professions-window" });
  panel.toggle();
  if (panel.visible) showProfessions();
}

export function showProfessions(): void {
  if (!panel?.visible) return;
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!self) {
    panel.body.replaceChildren(muted("Навыки придут вместе с персонажем."));
    return;
  }

  const skills = readSkills(self);
  if (skills.length === 0) {
    panel.body.replaceChildren(muted("Сервер ещё не прислал ни одного навыка."));
    return;
  }

  const talents = game.talentData;
  const byCategory = new Map<number, SkillEntry[]>();
  for (const skill of skills) {
    // A skill whose line is unknown — the table has not landed, or the realm added a line of its
    // own — is filed under the generic heading rather than dropped: the number is still real.
    const category = talents?.skillLine(skill.skillId)?.categoryId ?? 12;
    const list = byCategory.get(category) ?? [];
    list.push(skill);
    byCategory.set(category, list);
  }

  const sections: HTMLElement[] = [];
  const order = [...SKILL_CATEGORY_ORDER, ...[...byCategory.keys()].filter((key) => !SKILL_CATEGORY_ORDER.includes(key))];
  for (const category of order) {
    const list = byCategory.get(category);
    if (!list || list.length === 0) continue;
    sections.push(section(SKILL_CATEGORY_NAMES[category] ?? `Категория ${category}`, list));
  }
  panel.body.replaceChildren(...sections);
}

function muted(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "muted";
  line.textContent = text;
  return line;
}

function section(title: string, skills: readonly SkillEntry[]): HTMLElement {
  const block = document.createElement("section");
  block.className = "profession-section";
  const heading = document.createElement("h4");
  heading.textContent = title;
  block.append(heading);

  for (const skill of [...skills].sort((left, right) => right.value - left.value)) {
    const name = game.talentData?.skillLine(skill.skillId)?.name ?? `Навык ${skill.skillId}`;
    const row = document.createElement("div");
    row.className = "profession-row";

    // The number sits on the row's own line, not inside the bar. An 8px track with a 10.88px
    // number in it drew the digits half a pixel below their own track and at 1.99:1 against the
    // gold fill — unreadable twice over. `.ui-line` is a `space-between` flex and the right-hand
    // side of it was already there, waiting, holding nothing but a bonus that is usually empty.
    const bar = new Bar({ kind: "skill" });
    // A skill with no maximum is one the character cannot raise — a language, a racial — and it
    // draws as full rather than as an empty bar it can never fill.
    bar.set(skill.max > 0 ? skill.value : 1, skill.max > 0 ? skill.max : 1);
    row.append(textLine(name, valueText(skill)), bar.root);
    block.append(row);
  }
  return block;
}

/**
 * The whole right-hand side of a skill row: the value, and the bonuses when there are any.
 *
 * A skill with no maximum cannot be raised — a language, a racial — so it shows its value alone
 * rather than a fraction of a ceiling that does not exist.
 */
function valueText(skill: SkillEntry): string {
  const value = skill.max > 0 ? `${skill.value} / ${skill.max}` : `${skill.value}`;
  const bonus = bonusText(skill);
  return bonus ? `${value}  ${bonus}` : value;
}

/** The two bonuses, shown only when there are any: both are usually zero and both can be negative. */
function bonusText(skill: SkillEntry): string {
  const total = effectiveSkill(skill);
  if (total === skill.value) return "";
  return `${total > skill.value ? "+" : ""}${total - skill.value}`;
}
