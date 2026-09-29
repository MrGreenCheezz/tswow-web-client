import { MAX_GLYPH_SLOTS } from "../../world/CharacterProgressProtocol.js";
import type { TalentsInfo } from "../../world/CharacterProgressProtocol.js";
import type { TalentTabInfo } from "../../gateway/TalentMetadata.js";
import { unit, worldObject } from "../../world/Fields.js";
import { game } from "../game/Context.js";
import { playerInventory } from "../Inventory.js";
import { spellCastAllowed } from "../SpellCastGuard.js";
import { Panel, attachTooltip, confirmPanel } from "./Widgets.js";
import { formatMoney } from "./Format.js";
import { globalString } from "../../generated/globalStrings.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { ensureSpellNames } from "./SpellNames.js";
import { formatSpellDescription } from "./SpellText.js";
import { requestSpellCast } from "../game/GroundTarget.js";
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

/** Close the native fallback without constructing it solely for a FrameXML takeover. */
export function hideTalentsWindow(): void {
  parts?.panel.hide();
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

function clientTextureUrl(path: string | undefined): string | undefined {
  if (!path || !game.gatewayOrigin) return undefined;
  const resolved = path.includes("\\") || path.includes("/")
    ? path : `Interface\\TalentFrame\\${path}`;
  const withExtension = /\.(?:blp|png|jpe?g|gif)$/i.test(resolved) ? resolved : `${resolved}.blp`;
  const url = new URL("/texture", game.gatewayOrigin);
  url.searchParams.set("path", withExtension);
  return url.href;
}

function tabButton(label: string, active: boolean, onClick: () => void, tab?: TalentTabInfo): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "talents-tab is-active" : "talents-tab";
  const icon = document.createElement("img");
  icon.className = "talent-tab-icon";
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  const iconUrl = clientTextureUrl(tab?.iconPath)
    ?? spellIconUrl(tab?.iconId ?? 0, game.gatewayOrigin);
  if (iconUrl) {
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, iconUrl);
    button.append(icon);
  }
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
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
  const petMask = petTalentMask();
  const tabs = showingPet
    ? talents.petTabs(petMask)
    : classId === undefined ? [] : talents.tabsForClass(classId);

  buildHeader(header, info, petMask);
  if (tabs.length === 0) {
    footer.textContent = showingPet
      ? "У этого питомца нет дерева талантов."
      : "Класс персонажа ещё не известен.";
    return;
  }

  activeTab = Math.max(0, Math.min(tabs.length - 1, activeTab));
  const learned = learnedOf(info);
  for (const [index, tab] of tabs.entries()) {
    const spent = pointsInTree(talents.talentsIn(tab.id), learned, showingPet ? 3 : 5);
    treeBar.append(tabButton(`${tab.name} (${spent})`, index === activeTab, () => {
      activeTab = index;
      showTalents();
    }, tab));
  }

  const tab = tabs[activeTab];
  if (!tab) return;
  drawTree(grid, talents.talentsIn(tab.id), learned, info?.unspentPoints ?? 0,
    showingPet ? 3 : 5);
  drawGlyphs(glyphRow, info);
  footer.textContent = `Нераспределённых очков: ${info?.unspentPoints ?? 0}`;
}

function buildHeader(header: HTMLElement, info: TalentsInfo | undefined, petMask: number): void {
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
      if (spell !== undefined && known && !isActive && world
        && (game.world !== world || spellCastAllowed(world, spell))) {
        requestSpellCast(spell, () => world.castSpell(spell));
      }
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

  if (petMask !== 0 || showingPet) {
    header.append(tabButton(showingPet ? "Персонаж" : "Питомец", false, () => {
      showingPet = !showingPet;
      activeTab = 0;
      showTalents();
    }));
  }

  if (!showingPet) header.append(talentResetButton());
}

/**
 * «Сбросить» (1.28, part 1). The original talent frame has no reset button: the trainer's «Забыть
 * таланты» makes the server send its quote (MSG_TALENT_WIPE_CONFIRM, `WorldClient.talentWipeConfirm`)
 * and only accepting that question answers. The core keeps no pending state (SkillHandler.cpp:61-93):
 * an answer naming a trainer in range resets and charges at once — so this button never sends on its
 * own. With a quote it asks with the price; without one it is marked unavailable and says where to go.
 * The window is repainted by talent packets, not by the quote, so the state is read again on hover and
 * on click.
 */
function talentResetButton(): HTMLButtonElement {
  const quoted = () => game.world?.talentWipeConfirm;
  const reset = tabButton("Сбросить", false, () => {
    const world = game.world;
    const offer = sync();
    if (!world || !offer) return;
    confirmPanel(reset, {
      title: "Сбросить таланты?",
      lines: [
        globalString("CONFIRM_TALENT_WIPE")
          ?? "Вы уверены, что хотите отказаться от всех своих талантов? Все питомцы, которых вы контролируете, окажутся на свободе. Сброс талантов с каждым разом будет обходиться все дороже.",
        `Стоимость: ${formatMoney(offer.cost)}`,
      ],
      confirm: "Принять",
      danger: true,
      onConfirm: () => {
        // Only the question asked here: a newer quote was never confirmed.
        if (world.talentWipeConfirm !== offer) return;
        if (world.answerTalentWipe(true) === "unaffordable") {
          world.onSpellStatus?.(globalString("ERR_NOT_ENOUGH_MONEY") ?? "У вас недостаточно денег.", true);
        }
      },
    });
  });
  const sync = (): ReturnType<typeof quoted> => {
    const offer = quoted();
    if (offer) reset.removeAttribute("aria-disabled");
    else reset.setAttribute("aria-disabled", "true");
    return offer;
  };
  sync();
  attachTooltip(reset, () => {
    const offer = sync();
    return {
      title: "Сбросить таланты",
      footer: [offer
        ? `Стоимость: ${formatMoney(offer.cost)}`
        : "Сброс талантов — у тренера своего класса, пункт «Забыть таланты»."],
    };
  });
  return reset;
}

/** The core's pet-family mask, which matches the `TalentTab.PetTalentMask` trees. */
function petTalentMask(): number {
  const world = game.world;
  const petGuid = world?.petSpells?.guid;
  if (!world || petGuid === undefined || petGuid === 0n) return 0;
  const family = world.petSpells?.creatureFamily ?? 0;
  return game.talentData?.petTalentMask(family) ?? 0;
}

function drawTree(
  grid: HTMLElement, talents: readonly TalentDefinition[], learned: Map<number, number>,
  unspent: number, pointsPerTier: number,
): void {
  // Nothing was ever asking for these. A talent row carries no name and no icon of its own — both
  // belong to the spell it teaches — and the only spell rows the client fetched were the ones the
  // character already knows, so an unlearned tree was a grid of blank squares reading «Талант
  // 1234». Asked for once per session per spell, and the tree is redrawn when they land.
  ensureSpellNames(talents.map((talent) => talent.ranks[0] ?? 0), showTalents);
  const inTab = learnedInTab(talents, learned);
  const cells = talentTreeState(talents, inTab, unspent, pointsPerTier);
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

  for (const cell of cells) grid.append(talentButton(cell, pointsPerTier));
}

function talentButton(cell: TalentCell, pointsPerTier: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "talent";
  button.style.gridRow = String(cell.talent.tier + 1);
  button.style.gridColumn = String(cell.talent.column + 1);
  button.classList.toggle("is-learned", cell.rank > 0);
  button.classList.toggle("is-maxed", cell.rank >= cell.maxRank && cell.maxRank > 0);
  button.classList.toggle("is-available", cell.available && cell.rank < cell.maxRank);
  button.classList.toggle("is-blocked", !cell.available);
  button.dataset["state"] = cell.rank >= cell.maxRank && cell.maxRank > 0
    ? "maxed" : cell.available ? "available" : "blocked";
  button.setAttribute("aria-label", `Талант ${cell.talent.id}, ранг ${cell.rank} из ${cell.maxRank}`);
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
    const why = cell.blockedBy === "tier" ? `Нужно ${tierRequirement(cell.talent.tier, pointsPerTier)} очков в этой ветке`
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
        ? { title: "Ячейка символа", footer: ["Щелчок вставляет символ из сумок"] }
        : { title: row?.name ?? `Символ ${id}`, footer: ["Щелчок вынимает символ"] };
    });
    button.addEventListener("click", () => {
      if (id !== 0) game.world?.removeGlyph(slot);
      else insertGlyphFromBags();
    });
    glyphRow.append(button);
  }
}

/**
 * Inserts a glyph by using the item: there is no "insert" opcode, only `CMSG_USE_ITEM`.
 * Uses the first glyph item found in the bags; the server validates slot/type/level.
 */
function insertGlyphFromBags(): void {
  const world = game.world;
  if (!world) return;
  const inventory = playerInventory(world.state);
  const bags = [...(inventory?.backpack ?? []), ...(inventory?.bags ?? []).flatMap((bag) => bag.slots)];
  // Glyph items are consumables whose use casts the insert; find any usable glyph the server
  // has a template for. The exact slot choice stays server-side — this only starts the use.
  const candidate = bags.find((slot) => {
    if (slot.item === undefined) return false;
    const entry = worldObject.entry(slot.item) ?? 0;
    const template = entry ? world.itemTemplate(entry) : undefined;
    return (template?.name ?? "").toLowerCase().includes("символ")
      || (template?.name ?? "").toLowerCase().includes("glyph");
  });
  if (!candidate?.item) {
    world.onSpellStatus?.("В сумках нет символов для вставки", true);
    return;
  }
  world.useItem(candidate.bag, candidate.slot, candidate.guid);
}
