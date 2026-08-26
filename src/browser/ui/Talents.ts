import { MAX_GLYPH_SLOTS } from "../../world/CharacterProgressProtocol.js";
import type { TalentsInfo } from "../../world/CharacterProgressProtocol.js";
import { unit } from "../../world/Fields.js";
import { game } from "../game/Context.js";
import { Panel, attachTooltip } from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { ensureSpellNames } from "./SpellNames.js";
import { formatSpellDescription } from "./SpellText.js";
import { spellDescriptionContext } from "./Spellbook.js";
import {
  TALENT_COLUMNS, learnedInTab, nextRankRequest, pointsInTree, talentArrows, talentTreeState,
  tierRequirement, treeHeight, type TalentCell, type TalentDefinition,
} from "./TalentTree.js";

/**
 * The talent window: three trees, their tiers and arrows, the glyphs and the pet's own tree.
 *
 * The packet behind it says almost nothing. `SMSG_TALENTS_INFO` is a list of `{talentId, rank}`
 * per specialisation and a list of glyph ids, and that is all — no tree, no tier, no column, no
 * prerequisite, no name, no icon. Everything that makes it a *tree* comes from `Talent.dbc` and
 * `TalentTab.dbc` through `/dbc/talents`, which is why this window could not exist before that
 * endpoint did.
 *
 * Two things about it are worth stating because neither is obvious from the packet:
 *
 * * **Switching specialisation is not an opcode.** `CMSG_SET_ACTIVE_TALENT_GROUP_OBSOLETE` is
 *   declared `Handle_NULL` — the name is the core's own — and the real route is a *spell*:
 *   `SPELL_EFFECT_TALENT_SPEC_SELECT` with `damage - 1` as the spec index. So the button here
 *   casts whichever of the two activation spells the character actually knows, and offers nothing
 *   when it knows neither, which is what a character without dual specialisation looks like.
 * * **The pet's tree arrives on the same opcode as the character's**, told apart by the packet's
 *   first byte, and its family decides which three trees it may use: `CreatureFamily.PetTalentType`
 *   against `TalentTab.CategoryEnumID`.
 */

/**
 * The two spells that switch specialisation, from `SpellEffects.cpp:5734` — `damage - 1`, so
 * damage 1 activates spec 0. They are shown only when the character knows them, which is the same
 * test the original client's button makes.
 */
const ACTIVATE_SPEC_SPELLS = [63645, 63644];

let activeTab = 0;
/** Set while the pet's trees are being shown instead of the character's. */
let showingPet = false;

export function toggleTalentsWindow(): void {
  parts ??= build();
  parts.panel.toggle();
  if (parts.panel.visible) showTalents();
}

/**
 * The window's own parts, built on first open rather than at module load.
 *
 * Deliberate: a module that touches the DOM when it is imported cannot be loaded in a test, and
 * this file's rules already live next door in `TalentTree.ts` precisely so they can be.
 */
interface TalentPanel {
  panel: Panel;
  header: HTMLElement;
  treeBar: HTMLElement;
  grid: HTMLElement;
  glyphRow: HTMLElement;
  footer: HTMLElement;
}

let parts: TalentPanel | undefined;

function build(): TalentPanel {
  const panel = new Panel({ id: "talents-window", title: "Таланты", className: "talents-window" });
  const div = (className: string): HTMLElement => {
    const element = document.createElement("div");
    element.className = className;
    return element;
  };
  const header = div("talents-header");
  const treeBar = div("talents-tabs");
  const grid = div("talents-grid");
  const glyphRow = div("talents-glyphs");
  const footer = document.createElement("p");
  footer.className = "muted";
  panel.body.append(header, treeBar, grid, glyphRow, footer);
  return { panel, header, treeBar, grid, glyphRow, footer };
}

function tabButton(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "talents-tab is-active" : "talents-tab";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/** The learned talents of the active specialisation, as the rules module wants them. */
function learnedOf(info: TalentsInfo | undefined): Map<number, number> {
  const learned = new Map<number, number>();
  const spec = info?.specs[info.activeSpec];
  for (const talent of spec?.talents ?? []) learned.set(talent.talentId, talent.rank);
  return learned;
}

export function showTalents(): void {
  if (!parts?.panel.visible) return;
  const { header, treeBar, grid, glyphRow, footer } = parts;
  const world = game.world;
  const talents = game.talentData;
  header.replaceChildren();
  treeBar.replaceChildren();
  grid.replaceChildren();
  glyphRow.replaceChildren();

  if (!world || !talents?.ready) {
    footer.textContent = talents?.ready === false
      ? "Ожидание таблиц талантов…"
      : "Таланты придут вместе с персонажем.";
    return;
  }

  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const classId = self ? unit.classId(self) : undefined;
  const info = showingPet ? world.petTalents : world.talents;
  const petFamily = petTalentCategory();
  const tabs = showingPet
    ? talents.petTabs(petFamily)
    : classId === undefined ? [] : talents.tabsForClass(classId);

  buildHeader(header, info, petFamily);
  if (tabs.length === 0) {
    footer.textContent = showingPet
      ? "У этого питомца нет дерева талантов."
      : "Класс персонажа ещё не известен.";
    return;
  }

  activeTab = Math.max(0, Math.min(tabs.length - 1, activeTab));
  const learned = learnedOf(info);
  for (const [index, tab] of tabs.entries()) {
    const spent = pointsInTree(talents.talentsIn(tab.id), learned);
    treeBar.append(tabButton(`${tab.name} (${spent})`, index === activeTab, () => {
      activeTab = index;
      showTalents();
    }));
  }

  const tab = tabs[activeTab];
  if (!tab) return;
  drawTree(grid, talents.talentsIn(tab.id), learned, info?.unspentPoints ?? 0);
  drawGlyphs(glyphRow, info);
  footer.textContent = `Нераспределённых очков: ${info?.unspentPoints ?? 0}`;
}

function buildHeader(header: HTMLElement, info: TalentsInfo | undefined, petFamily: number): void {
  const world = game.world;
  // Dual specialisation: one button per specialisation the packet reports, and the switch is a
  // spell rather than an opcode. A character with one spec gets one button and no way to press it
  // into anything else, which is correct rather than a limitation.
  const specs = info?.specs.length ?? 0;
  for (let index = 0; index < specs; index++) {
    const spell = ACTIVATE_SPEC_SPELLS[index];
    const known = spell !== undefined && (world?.knownSpells.some((entry) => entry.id === spell) ?? false);
    const isActive = index === (info?.activeSpec ?? 0);
    const button = tabButton(`Специализация ${index + 1}`, isActive, () => {
      if (spell !== undefined && known && !isActive) world?.castSpell(spell);
    });
    // Not `disabled`: "dual specialisation has not been bought" is the whole content of this
    // button for a character who has not bought it, and a disabled button never shows it.
    const active = isActive;
    if (active || !known) button.setAttribute("aria-disabled", "true");
    attachTooltip(button, () => ({
      title: `Специализация ${index + 1}`,
      footer: [known ? (active ? "Уже активна" : "Переключить специализацию") : "Двойная специализация не куплена"],
    }));
    header.append(button);
  }

  if (petFamily > 0 || showingPet) {
    header.append(tabButton(showingPet ? "Персонаж" : "Питомец", false, () => {
      showingPet = !showingPet;
      activeTab = 0;
      showTalents();
    }));
  }
}

/** The pet's `PetTalentType`, which is the only link between its family and its trees. */
function petTalentCategory(): number {
  const world = game.world;
  const petGuid = world?.petSpells?.guid;
  if (!world || petGuid === undefined || petGuid === 0n) return 0;
  const family = world.petSpells?.creatureFamily ?? 0;
  return game.talentData?.petTalentType(family) ?? 0;
}

function drawTree(grid: HTMLElement, talents: readonly TalentDefinition[], learned: Map<number, number>, unspent: number): void {
  // Nothing was ever asking for these. A talent row carries no name and no icon of its own — both
  // belong to the spell it teaches — and the only spell rows the client fetched were the ones the
  // character already knows, so an unlearned tree was a grid of blank squares reading «Талант
  // 1234». Asked for once per session per spell, and the tree is redrawn when they land.
  ensureSpellNames(talents.map((talent) => talent.ranks[0] ?? 0), showTalents);
  const inTab = learnedInTab(talents, learned);
  const cells = talentTreeState(talents, inTab, unspent);
  const height = treeHeight(talents);
  grid.style.gridTemplateColumns = `repeat(${TALENT_COLUMNS}, var(--talent-size, 44px))`;
  grid.style.gridTemplateRows = `repeat(${height}, var(--talent-size, 44px))`;

  // The arrows go in first and underneath: they are drawn as a stretched element between two
  // cells rather than as an overlay, so a tree that scrolls carries its arrows with it.
  for (const arrow of talentArrows(talents, inTab)) {
    const line = document.createElement("i");
    line.className = arrow.satisfied ? "talent-arrow is-open" : "talent-arrow";
    const top = Math.min(arrow.from.tier, arrow.to.tier);
    const bottom = Math.max(arrow.from.tier, arrow.to.tier);
    const left = Math.min(arrow.from.column, arrow.to.column);
    const right = Math.max(arrow.from.column, arrow.to.column);
    line.style.gridRow = `${top + 1} / ${bottom + 2}`;
    line.style.gridColumn = `${left + 1} / ${right + 2}`;
    grid.append(line);
  }

  for (const cell of cells) grid.append(talentButton(cell));
}

function talentButton(cell: TalentCell): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "talent";
  button.style.gridRow = String(cell.talent.tier + 1);
  button.style.gridColumn = String(cell.talent.column + 1);
  button.classList.toggle("is-learned", cell.rank > 0);
  button.classList.toggle("is-maxed", cell.rank >= cell.maxRank && cell.maxRank > 0);
  // Marked rather than `disabled`. A disabled button swallows every pointer event, so its tooltip
  // never appears — and the tooltip is exactly what a blocked talent needs to show, since the only
  // interesting thing about it is *why* it is blocked. The click handler already refuses.
  if (!cell.available) button.setAttribute("aria-disabled", "true");

  // The icon is the spell's, taken from the rank the character has or the first one otherwise:
  // a talent's own row carries no icon of its own.
  const spellId = cell.talent.ranks[Math.max(0, cell.rank - 1)] ?? cell.talent.ranks[0] ?? 0;
  const metadata = game.spells.get(spellId);
  const iconUrl = spellIconUrl(metadata?.iconId ?? 0, game.gatewayOrigin);
  if (iconUrl) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, iconUrl);
    button.append(icon);
  }
  const rank = document.createElement("em");
  rank.textContent = `${cell.rank}/${cell.maxRank}`;
  button.append(rank);
  attachTooltip(button, () => {
    // Read at the moment the tooltip opens rather than when the cell was drawn: the rows arrive
    // from the gateway a moment after the tree does, and a tooltip built with the button would
    // have said «Талант 1234» for the rest of the session.
    const row = game.spells.get(spellId);
    const why = cell.blockedBy === "tier" ? `Нужно ${tierRequirement(cell.talent.tier)} очков в этой ветке`
      : cell.blockedBy === "prerequisite" ? "Требуется предыдущий талант"
        : cell.blockedBy === "points" ? "Нет свободных очков"
          : cell.blockedBy === "maxed" ? "Изучено полностью" : "";
    return {
      title: row?.name ?? `Талант ${cell.talent.id}`,
      lines: [`Ранг ${cell.rank} из ${cell.maxRank}`,
        formatSpellDescription(row?.description ?? "", row, spellDescriptionContext())].filter(Boolean),
      footer: [why].filter(Boolean),
    };
  });

  button.addEventListener("click", () => {
    const world = game.world;
    if (!world || !cell.available) return;
    const rankToLearn = nextRankRequest(cell.rank);
    if (showingPet) {
      const petGuid = world.petSpells?.guid;
      if (petGuid !== undefined) world.learnPetTalents(petGuid, [{ talentId: cell.talent.id, rank: rankToLearn }]);
    } else {
      world.learnTalent(cell.talent.id, rankToLearn);
    }
  });
  return button;
}

function drawGlyphs(glyphRow: HTMLElement, info: TalentsInfo | undefined): void {
  // Six slots, three major and three minor, and the packet carries them as a flat list per
  // specialisation. An empty slot is a zero rather than a gap in the list.
  const glyphs = info?.specs[info.activeSpec]?.glyphs ?? [];
  for (let slot = 0; slot < MAX_GLYPH_SLOTS; slot++) {
    const id = glyphs[slot] ?? 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = id > 0 ? "glyph-slot is-filled" : "glyph-slot";
    const glyph = id > 0 ? game.talentData?.glyph(id) : undefined;
    const glyphIcon = spellIconUrl(glyph?.iconId ?? 0, game.gatewayOrigin);
    if (glyphIcon) {
      const icon = document.createElement("img");
      icon.alt = "";
      icon.addEventListener("error", () => icon.remove(), { once: true });
      setIconSource(icon, glyphIcon);
      button.append(icon);
    } else {
      const label = document.createElement("span");
      label.textContent = id > 0 ? String(id) : "—";
      button.append(label);
    }
    // An empty socket is marked rather than disabled, so «Пустая ячейка символа» — which is the
    // only thing it has to say — can actually be read.
    if (id === 0) button.setAttribute("aria-disabled", "true");
    attachTooltip(button, () => {
      const row = glyph ? game.spells.get(glyph.spellId) : undefined;
      return id === 0
        ? { title: "Ячейка символа", footer: ["Пусто"] }
        : { title: row?.name ?? `Символ ${id}`, footer: ["Щелчок вынимает символ"] };
    });
    button.addEventListener("click", () => {
      if (id !== 0) game.world?.removeGlyph(slot);
    });
    glyphRow.append(button);
  }
}
