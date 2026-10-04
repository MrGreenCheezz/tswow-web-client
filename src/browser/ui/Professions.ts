import { game } from "../game/Context.js";
import { characterSkillsPane } from "./Dom.js";
import { notice } from "./Notices.js";
import { Bar, Panel, attachTooltip, textLine } from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import {
  SKILL_CATEGORY_NAMES, SKILL_CATEGORY_ORDER, effectiveSkill, readSkills, type SkillEntry,
} from "./Skills.js";
import { entryOf, playerInventory, stackCount, type ItemSlotState } from "../Inventory.js";
import { spellCastBlockReason } from "../SpellCastGuard.js";
import { requestSpellCast } from "../game/GroundTarget.js";
import { spellTooltip } from "./Spellbook.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import {
  craftableCount, filterCraftable, learnedProfessions, professionOpener, professionRecipe, professionRecipes,
  professionSpellSkill, recipeAcceptsItem, recipeDifficulty, recipeRequiresItem, sortCraftRecipes,
  type CraftSort,
} from "./ProfessionRules.js";
import { openFrameXmlTradeSkill } from "../framexml/FrameXmlTradeSkillController.js";

/**
 * The skills tab of the character window: professions first, then everything else the character
 * has a number for.
 *
 * Nothing here arrives in a packet. The 127 skill slots have been in `PLAYER_SKILL_INFO_1_1` since
 * the first login and no line of this client read them, which is why a character with 450
 * blacksmithing had nowhere at all to see it. The names come from `SkillLine.dbc` through
 * `/dbc/talents`, since that endpoint already carries the table for the spellbook's tabs.
 */

/**
 * What the skills pane drew last, so an unchanged pane is not torn down every drained frame.
 *
 * `showWorldState` calls this for as long as packets keep arriving, and `replaceChildren` between a
 * player's pointer-down and pointer-up detaches the «Открыть» button that was pressed — the click
 * is then never dispatched and the profession never opens. The same guard covers the `<details>`
 * sections, whose open/closed state the player owns.
 */
let skillsSignature = "";
let skillsWorld: typeof game.world;

export function showProfessions(): void {
  refreshProfessionWindows();
  if (characterSkillsPane.hidden) return;
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!self) {
    characterSkillsPane.replaceChildren(muted("Навыки придут вместе с персонажем."));
    return;
  }

  const skills = readSkills(self);
  if (skills.length === 0) {
    characterSkillsPane.replaceChildren(muted("Сервер ещё не прислал ни одного навыка."));
    return;
  }
  // A world change invalidates the signature outright rather than riding in it: putting the
  // comparison itself into the string made the first call always differ from the second.
  if (game.world !== skillsWorld) {
    skillsWorld = game.world;
    skillsSignature = "";
  }
  const signature = [
    game.talentData?.revision ?? -1,
    game.spells.size,
    currentProfessions().map((entry) => entry.skillId).join(","),
    skills.map((skill) => `${skill.skillId}:${skill.value}:${skill.max}:${skill.temporaryBonus}:${skill.permanentBonus}`).join(","),
  ].join("|");
  if (signature === skillsSignature) return;
  skillsSignature = signature;

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
    sections.push(section(
      talents?.skillCategory(category)?.name ?? SKILL_CATEGORY_NAMES[category] ?? "Прочие навыки",
      list,
    ));
  }
  characterSkillsPane.replaceChildren(...sections);
}

function muted(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "muted";
  line.textContent = text;
  return line;
}

function section(title: string, skills: readonly SkillEntry[]): HTMLElement {
  const block = document.createElement("details");
  block.className = "profession-section";
  block.open = true;
  const summary = document.createElement("summary");
  const heading = document.createElement("h4");
  heading.textContent = title;
  summary.append(heading);
  block.append(summary);

  const rows = document.createElement("div");
  rows.className = "profession-section-rows";

  for (const skill of [...skills].sort((left, right) => right.value - left.value)) {
    const name = game.talentData?.skillLine(skill.skillId)?.name ?? "Неизвестный навык";
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
    const line = textLine(name, valueText(skill));
    const iconUrl = spellIconUrl(game.talentData?.skillLine(skill.skillId)?.iconId ?? 0, game.gatewayOrigin);
    if (iconUrl) {
      const icon = document.createElement("img");
      icon.className = "profession-icon";
      icon.alt = "";
      icon.addEventListener("error", () => icon.remove(), { once: true });
      setIconSource(icon, iconUrl);
      line.prepend(icon);
    }
    row.append(line, bar.root);
    if (currentProfessions().some((entry) => entry.skillId === skill.skillId)) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "profession-open";
      open.textContent = "Открыть";
      open.addEventListener("click", () => openProfession(skill.skillId));
      row.append(open);
    }
    rows.append(row);
  }
  block.append(rows);
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

interface CraftParts {
  panel: Panel;
  list: HTMLElement;
  detail: HTMLElement;
  progress: Bar;
  query: string;
  sort: CraftSort;
  craftableOnly: boolean;
  selected: number | undefined;
  target: bigint | undefined;
  signature: string;
}

const craftPanels = new Map<number, CraftParts>();
let craftWorld: typeof game.world;
let craftSubscriptions: Array<() => void> = [];
let pendingCraft: number | undefined;
let craftFeedback = "";
let craftTimeout: ReturnType<typeof setTimeout> | undefined;
/**
 * How many more times the current recipe should be sent after the cast in flight.
 *
 * Set when the player asks for more than one, consumed one per successful finish
 * (`SPELL_CAST_STOP` with success, or `SPELL_GO` for instant recipes). Any refusal —
 * `professionCastStatus`, an interrupted stop, a closed window — clears it, so a queue never
 * outlives the reason it stopped.
 */
let craftQueue: { spellId: number; left: number; target?: bigint | undefined } | undefined;
/** How many times to offer at most in one queue. Enough for a stack, short enough to stay sane. */
export const CRAFT_QUEUE_MAX = 20;
/**
 * The ceiling the queue itself accepts. The native count box clamps to {@link CRAFT_QUEUE_MAX}
 * before it gets here; the stock TradeSkillFrame's three-digit box (`letters="3"`) and its
 * «Создать все» hand over up to 999, clamped to what the bags can complete.
 */
const CRAFT_REPEAT_MAX = 999;

/** The queue as the window sees it, for tests and for the status line. */
export function craftQueueState(): { spellId: number; left: number } | undefined {
  return craftQueue === undefined ? undefined : { spellId: craftQueue.spellId, left: craftQueue.left };
}

function knownMetadata(): SpellMetadata[] {
  return (game.world?.knownSpells ?? []).map(({ id }) => game.spells.get(id))
    .filter((spell): spell is SpellMetadata => spell !== undefined);
}

function currentProfessions(): SkillEntry[] {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  return self ? learnedProfessions(readSkills(self), knownMetadata(), game.talentData) : [];
}

export function professionsOpen(): boolean {
  if (professionListPanel?.visible === true) return true;
  return [...craftPanels.values()].some((parts) => parts.panel.visible);
}

export function closeProfessions(): void {
  for (const unsubscribe of craftSubscriptions) unsubscribe();
  craftSubscriptions = [];
  if (craftTimeout !== undefined) clearTimeout(craftTimeout);
  craftTimeout = undefined;
  pendingCraft = undefined;
  craftQueue = undefined;
  craftFeedback = "";
  professionListPanel?.hide();
  for (const parts of craftPanels.values()) {
    parts.panel.hide();
    parts.selected = undefined;
    parts.target = undefined;
    parts.signature = "";
  }
  craftWorld = undefined;
}

/**
 * The professions window: every profession the character has, in one place.
 *
 * The spellbook no longer lists them, and the character sheet only shows numbers — this is the
 * single button that opens a craft window, like the original client's profession tab, except it
 * lists all of them instead of two.
 */
let professionListPanel: Panel | undefined;

export function professionListOpen(): boolean {
  return professionListPanel?.visible ?? false;
}

export function toggleProfessionList(): void {
  if (!game.world) return;
  professionListPanel ??= new Panel({
    id: "profession-list-window", title: "Профессии", className: "profession-list-window",
  });
  if (professionListPanel.visible) {
    professionListPanel.hide();
    return;
  }
  drawProfessionList();
  professionListPanel.show();
}

/** What the profession list drew last, for the same reason as `skillsSignature`. */
let professionListSignature = "";
let professionListWorld: typeof game.world;

function drawProfessionList(): void {
  const panel = professionListPanel;
  const world = game.world;
  if (!panel) return;
  if (!world) {
    panel.hide();
    return;
  }
  // Three different empties, and they must not read the same: the table still on the wire, the
  // character's skills not arrived yet, and genuinely no profession to show.
  if (!game.talentData) {
    panel.body.replaceChildren(muted("Данные профессий загружаются…"));
    return;
  }
  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!self) {
    panel.body.replaceChildren(muted("Навыки придут вместе с персонажем."));
    return;
  }
  const professions = currentProfessions();
  // Rebuild the rows only when what they show changed. `refreshProfessionWindows` runs on every
  // drained frame, and replacing the pressed «Открыть» button mid-click is what made the open
  // silently do nothing. A world change invalidates outright, for the reason `skillsSignature` says.
  if (game.world !== professionListWorld) {
    professionListWorld = game.world;
    professionListSignature = "";
  }
  const signature = [
    game.talentData.revision,
    game.spells.size,
    game.itemMetadata?.revision ?? -1,
    professions.map((skill) => `${skill.skillId}:${skill.value}:${skill.max}`).join(","),
  ].join("|");
  if (signature === professionListSignature && panel.body.children.length > 0) return;
  professionListSignature = signature;
  const rows = professions.map((skill) => {
    const row = document.createElement("div");
    row.className = "profession-row";
    const meta = game.talentData?.skillLine(skill.skillId);
    const iconUrl = spellIconUrl(meta?.iconId ?? 0, game.gatewayOrigin);
    if (iconUrl) {
      const icon = document.createElement("img");
      icon.className = "profession-icon";
      icon.alt = "";
      icon.addEventListener("error", () => icon.remove(), { once: true });
      setIconSource(icon, iconUrl);
      row.append(icon);
    }
    const line = textLine(meta?.name ?? "Неизвестная профессия", valueText(skill));
    row.append(line);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "profession-open";
    open.textContent = "Открыть";
    open.addEventListener("click", () => openProfession(skill.skillId));
    row.append(open);
    return row;
  });
  if (rows.length === 0) {
    panel.body.replaceChildren(muted("У персонажа пока нет профессий."));
    return;
  }
  panel.body.replaceChildren(...rows);
}

/** The realm's normal cast refusal also belongs beside the recipe that initiated it. */
export function professionCastStatus(message: string, error: boolean): void {
  if (pendingCraft === undefined || !error) return;
  pendingCraft = undefined;
  craftQueue = undefined;
  craftFeedback = message;
  if (craftTimeout !== undefined) clearTimeout(craftTimeout);
  for (const parts of craftPanels.values()) parts.signature = "";
  refreshProfessionWindows();
}

/**
 * Every profession gets the same window, selected from the character's real skill fields. The stock
 * TradeSkillFrame answers first once the world mount has published it (FrameXmlTradeSkillController.ts);
 * the native craft window below is the fallback, and the one shown while Blizzard_TradeSkillUI loads.
 */
export function openProfession(skillId: number): boolean {
  if (openFrameXmlTradeSkill(skillId)) return true;
  return openNativeProfession(skillId);
}

/** The native craft window for one profession line, whoever else may own the route. */
export function openNativeProfession(skillId: number): boolean {
  if (!currentProfessions().some((skill) => skill.skillId === skillId)) {
    // A silent refusal reads as a dead button; say the one thing that can make it fail while the
    // profession list still shows the row.
    notice("Эта профессия больше не изучена");
    return false;
  }
  ensureCraftTracking();
  let parts = craftPanels.get(skillId);
  if (!parts) {
    const panel = new Panel({ id: `profession-window-${skillId}`, title: "Профессия", className: "craft-window" });
    const progress = new Bar({ kind: "skill", text: true });
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Поиск изученного рецепта";
    search.setAttribute("aria-label", "Поиск рецепта");
    search.addEventListener("input", () => {
      const current = craftPanels.get(skillId)!;
      current.query = search.value.trim().toLocaleLowerCase();
      current.signature = "";
      refreshProfessionWindows();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { search.blur(); panel.hide(); event.preventDefault(); }
    });
    const columns = document.createElement("div");
    columns.className = "craft-columns";
    const list = document.createElement("div");
    list.className = "craft-recipes";
    const detail = document.createElement("div");
    detail.className = "craft-detail";
    columns.append(list, detail);
    const filters = document.createElement("div");
    filters.className = "craft-filters";
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "Сортировка рецептов");
    for (const [value, label] of [["name", "По имени"], ["level", "По уровню"], ["difficulty", "По сложности"]] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.append(option);
    }
    sort.addEventListener("change", () => {
      const current = craftPanels.get(skillId)!;
      current.sort = sort.value === "level" || sort.value === "difficulty" ? sort.value : "name";
      current.signature = "";
      refreshProfessionWindows();
    });
    const craftable = document.createElement("label");
    craftable.className = "craft-available";
    const craftableBox = document.createElement("input");
    craftableBox.type = "checkbox";
    craftableBox.setAttribute("aria-label", "Только создаваемые");
    craftableBox.addEventListener("change", () => {
      const current = craftPanels.get(skillId)!;
      current.craftableOnly = craftableBox.checked;
      current.signature = "";
      refreshProfessionWindows();
    });
    craftable.append(craftableBox, document.createTextNode("Только создаваемые"));
    filters.append(sort, craftable);
    panel.body.append(progress.root, search, filters, columns);
    parts = {
      panel, list, detail, progress, selected: undefined, target: undefined,
      query: "", sort: "name", craftableOnly: false, signature: "",
    };
    craftPanels.set(skillId, parts);
  }
  parts.panel.show();
  parts.signature = "";
  refreshProfessionWindows();
  return true;
}

/**
 * Follow the current world's craft casts: the START/STOP/GO edges that move the queue on. Shared by
 * the native window and the stock TradeSkillFrame's craft hooks below.
 */
function ensureCraftTracking(): void {
  if (craftWorld !== undefined && craftWorld !== game.world) closeProfessions();
  craftWorld = game.world;
  if (craftSubscriptions.length === 0 && craftWorld) {
    const world = craftWorld;
    craftSubscriptions.push(world.events.on("SPELL_CAST_START", ({ casterGuid, spellId }) => {
      if (game.world !== world || casterGuid !== world.state.selfGuid || pendingCraft !== spellId) return;
      craftFeedback = "Создание…";
      for (const parts of craftPanels.values()) parts.signature = "";
      refreshProfessionWindows();
    }), world.events.on("SPELL_CAST_STOP", ({ casterGuid, spellId, reason }) => {
      if (game.world !== world || casterGuid !== world.state.selfGuid || pendingCraft !== spellId) return;
      pendingCraft = undefined;
      if (craftTimeout !== undefined) clearTimeout(craftTimeout);
      if (reason === "success") continueCraftQueue(spellId);
      else {
        craftQueue = undefined;
        craftFeedback = "Создание прервано.";
        for (const parts of craftPanels.values()) parts.signature = "";
        refreshProfessionWindows();
      }
    }), world.events.on("SPELL_GO", ({ casterGuid, casterUnit, spellId }) => {
      // Instant recipes have GO without START and therefore no active cast to stop.
      if (game.world !== world || pendingCraft !== spellId
        || (casterGuid !== world.state.selfGuid && casterUnit !== world.state.selfGuid)) return;
      pendingCraft = undefined;
      if (craftTimeout !== undefined) clearTimeout(craftTimeout);
      continueCraftQueue(spellId);
    }));
  }
}

/** A recipe spell the character knows, which is all the craft hooks below will cast. */
function knownRecipe(spell: SpellMetadata | undefined): spell is SpellMetadata {
  return professionRecipe(spell) && (game.world?.knownSpells.some(({ id }) => id === spell!.id) ?? false);
}

/**
 * The stock TradeSkillFrame's DoTradeSkill (FrameXmlTradeSkill.ts): `count` casts of a known recipe
 * through the same queue, preflight and cast tracking as «Создать», clamped to what the bags can
 * complete. A missing tool is left to the realm's answer, as the stock button leaves it. False when
 * nothing was sent.
 */
export function craftProfessionRecipe(spellId: number, count: number): boolean {
  const spell = game.spells.get(spellId);
  if (!game.world || !knownRecipe(spell) || recipeRequiresItem(spell)) return false;
  ensureCraftTracking();
  const available = craftableCount(spell, carriedCounts(carriedSlots()));
  if (available === undefined || available <= 0) return false;
  const wanted = Math.max(1, Math.min(CRAFT_REPEAT_MAX, Math.floor(count) || 1));
  return sendProfessionCast(spell, undefined, available === Infinity ? wanted : Math.min(wanted, available));
}

/** The stock enchant cursor's click: one cast of an enchant recipe on a carried item. */
export function castProfessionRecipeOnItem(spellId: number, itemGuid: bigint): boolean {
  const spell = game.spells.get(spellId);
  if (!game.world || !knownRecipe(spell) || !recipeRequiresItem(spell)) return false;
  ensureCraftTracking();
  if ((craftableCount(spell, carriedCounts(carriedSlots())) ?? 0) <= 0) return false;
  return sendProfessionCast(spell, itemGuid, 1);
}

/**
 * One known enchant on the trader's «will not be traded» slot (the stock TradeFrame's
 * `ClickTargetTradeButton(7)` with the enchant waiting): `CMSG_CAST_SPELL` with TARGET_FLAG_TRADE_ITEM
 * and slot 6 (WorldClient.castSpellOnTradeSlot). The realm parks it in the trade until both accept.
 */
export function castProfessionRecipeOnTradeSlot(spellId: number): boolean {
  const spell = game.spells.get(spellId);
  if (!game.world?.tradeOpen || !knownRecipe(spell) || !recipeRequiresItem(spell)) return false;
  ensureCraftTracking();
  if ((craftableCount(spell, carriedCounts(carriedSlots())) ?? 0) <= 0) return false;
  return sendProfessionCast(spell, TRADE_SLOT_TARGET, 1);
}

/** StopTradeSkillRepeat: the queue ends after the cast in flight, which stays the server's to finish. */
export function stopProfessionCraftRepeat(): void {
  if (craftQueue === undefined) return;
  craftQueue = undefined;
  for (const parts of craftPanels.values()) parts.signature = "";
  refreshProfessionWindows();
}

/** GetTradeskillRepeatCount's source: the casts still to go, the one in flight included. */
export function professionCraftRemaining(): number {
  return (pendingCraft !== undefined ? 1 : 0) + (craftQueue?.left ?? 0);
}

/** The stock TradeSkillFrame took the window: the native craft panels step aside; the queue runs on. */
export function hideProfessionWindows(): void {
  for (const parts of craftPanels.values()) parts.panel.hide();
}

/** Whether one line's native craft window shows (the stock owner's fallback while its add-on loads). */
export function nativeProfessionOpen(skillId: number): boolean {
  return craftPanels.get(skillId)?.panel.visible === true;
}

function carriedSlots(): ItemSlotState[] {
  const inventory = game.world && playerInventory(game.world.state);
  return inventory ? [...inventory.equipment, ...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)] : [];
}

function carriedCounts(slots: readonly ItemSlotState[]): Map<number, number> {
  const owned = new Map<number, number>();
  for (const slot of slots) {
    const entry = entryOf(slot.item);
    if (entry > 0) owned.set(entry, (owned.get(entry) ?? 0) + stackCount(slot));
  }
  return owned;
}

/** Repaints only when recipes, inventory, skill or cast state changed, retaining search focus. */
export function refreshProfessionWindows(): void {
  if (!professionsOpen()) return;
  if (!game.world || (craftWorld !== undefined && craftWorld !== game.world)) {
    closeProfessions();
    return;
  }
  if (professionListPanel?.visible) drawProfessionList();
  const skills = currentProfessions();
  const known = knownMetadata();
  const slots = carriedSlots();
  const owned = carriedCounts(slots);
  for (const [skillId, parts] of craftPanels) {
    if (!parts.panel.visible) continue;
    const skill = skills.find((entry) => entry.skillId === skillId);
    if (!skill) { parts.panel.hide(); continue; }
    const recipes = professionRecipes(skillId, known, game.talentData);
    const signature = [skill.value, skill.max, game.spells.size, game.itemMetadata?.revision,
      game.world.itemTemplates.size, pendingCraft, craftQueue?.spellId ?? "", craftQueue?.left ?? 0,
      craftFeedback, parts.query, parts.sort,
      parts.craftableOnly,
      recipes.map((spell) => `${spell.id}:${Math.ceil(game.world!.cooldownRemaining(spell.id, performance.now()) / 1000)}`).join(","),
      slots.map((slot) => `${slot.guid}:${entryOf(slot.item)}:${stackCount(slot)}`).join(","),
      game.world.casts.get(game.world.state.selfGuid!)?.spellId ?? "", Math.ceil(Math.max(0, game.globalCooldownUntil - performance.now()) / 1000),
    ].join("|");
    if (signature === parts.signature) continue;
    parts.signature = signature;
    const metadataClient = game.itemMetadata;
    const owner = game.world;
    const items = [...new Set(recipes.flatMap((spell) => [
      ...(spell.effectItemType ?? []), ...(spell.reagents ?? []).map((reagent) => reagent.itemId), ...(spell.tools ?? []),
    ]).filter((entry) => entry > 0))];
    if (metadataClient && items.some((entry) => !metadataClient.get(entry))) {
      void metadataClient.load(items).then((changed) => {
        if (changed && game.world === owner) { parts.signature = ""; refreshProfessionWindows(); }
      }).catch(() => {});
    }
    parts.panel.title = game.talentData?.skillLine(skillId)?.name ?? "Профессия";
    parts.progress.set(skill.value, skill.max, `${skill.value} / ${skill.max}`);
    const abilities = (spell: SpellMetadata): string => recipeDifficulty(
      skill, game.talentData?.spellAbilitiesOf?.(spell.id)?.find((row) => row.skillLine === skillId));
    const withDifficulty = recipes.map((spell) => ({ spell, difficulty: abilities(spell) }));
    const inQuery = withDifficulty.filter(({ spell }) => spell.name.toLocaleLowerCase().includes(parts.query));
    const filtered = sortCraftRecipes(filterCraftable(inQuery, owned, parts.craftableOnly), parts.sort);
    if (!filtered.some(({ spell }) => spell.id === parts.selected)) parts.selected = filtered[0]?.spell.id;
    const rows = filtered.map(({ spell, difficulty }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `craft-recipe ${spell.id === parts.selected ? "is-selected" : ""}`;
      button.dataset.spellId = String(spell.id);
      button.dataset.difficulty = difficulty;
      const icon = iconForSpell(spell);
      const label = document.createElement("span");
      label.textContent = spell.name;
      const count = document.createElement("small");
      const available = craftableCount(spell, owned);
      count.textContent = available !== undefined && available !== Infinity ? `[${available}]` : "";
      button.append(icon, label, count);
      button.addEventListener("click", () => {
        parts.selected = spell.id; parts.target = undefined; parts.signature = ""; refreshProfessionWindows();
      });
      attachTooltip(button, () => spellTooltip(spell.id));
      return button;
    });
    parts.list.replaceChildren(...rows);
    const selected = recipes.find((spell) => spell.id === parts.selected);
    if (selected) drawRecipe(parts, skillId, selected, owned, slots);
    else {
      parts.detail.replaceChildren(muted(parts.query ? "Ничего не найдено." : "Изученных рецептов пока нет."));
      for (const spell of known.filter((spell) => !spell.hidden && !spell.passive && !professionOpener(spell)
        && !recipes.includes(spell) && professionSpellSkill(spell, game.talentData) === skillId)) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = spell.name;
        button.addEventListener("click", () => sendProfessionCast(spell));
        attachTooltip(button, () => spellTooltip(spell.id));
        parts.detail.append(button);
      }
    }
  }
}

function iconForSpell(spell: SpellMetadata): HTMLElement {
  const icon = document.createElement("img");
  icon.alt = "";
  icon.className = "craft-icon";
  const url = spellIconUrl(spell.iconId, game.gatewayOrigin);
  if (url) setIconSource(icon, url);
  return icon;
}

function itemLine(entry: number, suffix: string, missing = false): HTMLElement {
  const metadata = game.itemMetadata?.get(entry);
  const template = game.world?.itemTemplate(entry);
  const row = document.createElement("div");
  row.className = `craft-reagent ${missing ? "is-missing" : ""}`;
  const icon = document.createElement("img");
  icon.alt = ""; icon.className = "craft-icon";
  if (metadata && game.itemMetadata) setIconSource(icon, game.itemMetadata.iconUrl(metadata));
  const name = document.createElement("span");
  name.textContent = metadata?.name ?? template?.name ?? "Название предмета загружается…";
  const count = document.createElement("strong");
  count.textContent = suffix;
  row.append(icon, name, count);
  attachTooltip(row, () => itemTooltipFor(entry));
  return row;
}

function drawRecipe(parts: CraftParts, skillId: number, spell: SpellMetadata, owned: Map<number, number>, slots: ItemSlotState[]): void {
  const title = document.createElement("h3");
  title.textContent = spell.name;
  const header = document.createElement("div"); header.className = "craft-recipe-header";
  header.append(iconForSpell(spell), title);
  parts.detail.replaceChildren(header);
  attachTooltip(header, () => spellTooltip(spell.id));
  for (const [index, itemId] of (spell.effectItemType ?? []).entries()) {
    if (itemId > 0 && [24, 157].includes(spell.effects?.[index] ?? 0)) {
      parts.detail.append(itemLine(itemId, `×${Math.max(1, (spell.effectBasePoints[index] ?? 0) + 1)}`));
    }
  }
  const description = spellTooltip(spell.id).lines?.filter((line) => typeof line !== "string" && line.tone === "description") ?? [];
  for (const line of description) parts.detail.append(muted(typeof line === "string" ? line : line.text));
  const reagentTitle = document.createElement("h4"); reagentTitle.textContent = "Реагенты"; parts.detail.append(reagentTitle);
  if (spell.reagents === undefined) parts.detail.append(muted("Данные рецепта ещё загружаются."));
  else if (spell.reagents.length === 0) parts.detail.append(muted("Не требуются."));
  for (const reagent of spell.reagents ?? []) {
    parts.detail.append(itemLine(reagent.itemId, `${owned.get(reagent.itemId) ?? 0} / ${reagent.count}`,
      (owned.get(reagent.itemId) ?? 0) < reagent.count));
  }
  for (const tool of spell.tools ?? []) parts.detail.append(itemLine(tool, "Инструмент", !owned.has(tool)));
  if (spell.requiredToolCategories?.length) {
    parts.detail.append(muted(`Инструменты: ${(spell.requiredToolNames ?? ["Профессиональный инструмент"]).join(", ")}`));
  }
  if (recipeRequiresItem(spell)) {
    const label = document.createElement("label"); label.textContent = "Предмет для зачарования";
    const target = document.createElement("select");
    target.setAttribute("aria-label", "Предмет для зачарования");
    const prompt = document.createElement("option"); prompt.value = ""; prompt.textContent = "Выберите предмет"; target.append(prompt);
    for (const slot of slots) {
      const template = slot.item && game.world?.itemTemplate(entryOf(slot.item));
      if (!template?.found || !recipeAcceptsItem(spell, template)) continue;
      const option = document.createElement("option"); option.value = String(slot.guid); option.textContent = template.name;
      target.append(option);
    }
    if (parts.target !== undefined && slots.some((slot) => slot.guid === parts.target)) target.value = String(parts.target);
    else parts.target = undefined;
    target.addEventListener("change", () => { parts.target = target.value ? BigInt(target.value) : undefined; parts.signature = ""; refreshProfessionWindows(); });
    label.append(target); parts.detail.append(label);
  }
  const available = craftableCount(spell, owned);
  const queued = craftQueue?.spellId === spell.id ? craftQueue.left : 0;
  const countRow = document.createElement("label"); countRow.className = "craft-count";
  const countText = document.createElement("span"); countText.textContent = "Количество";
  const countInput = document.createElement("input");
  countInput.type = "number"; countInput.min = "1"; countInput.max = String(CRAFT_QUEUE_MAX);
  countInput.value = String(queued > 0 ? queued + 1 : 1);
  countInput.setAttribute("aria-label", "Сколько создать");
  countRow.append(countText, countInput);
  parts.detail.append(countRow);
  const button = document.createElement("button"); button.type = "button"; button.className = "craft-create";
  button.textContent = recipeRequiresItem(spell) ? "Наложить чары" : "Создать";
  const busy = game.world?.state.selfGuid === undefined ? false : game.world.casts.has(game.world.state.selfGuid);
  button.disabled = available === undefined || available === 0 || busy || pendingCraft !== undefined || queued > 0
    || (spell.tools ?? []).some((tool) => !owned.has(tool))
    || (recipeRequiresItem(spell) && parts.target === undefined)
    || (game.world !== undefined && spellCastBlockReason(game.world, spell.id) !== undefined);
  const status = document.createElement("p"); status.className = "muted craft-status";
  status.textContent = queued > 0 ? `Осталось создать: ${queued}.`
    : craftFeedback || (busy ? "Дождитесь завершения текущего действия." : available === 0 ? "Недостаточно реагентов."
    : available === undefined ? "Ожидание данных рецепта." : available !== Infinity ? `Можно создать: ${available}` : "Реагенты не расходуются.");
  button.addEventListener("click", () => {
    // Validate fresh character/inventory state, not the snapshot captured by the button.
    if (!currentProfessions().some((skill) => skill.skillId === skillId)
      || !professionRecipes(skillId, knownMetadata(), game.talentData).some((row) => row.id === spell.id)) return;
    const counts = carriedCounts(carriedSlots());
    if ((craftableCount(spell, counts) ?? 0) <= 0 || (spell.tools ?? []).some((tool) => !counts.has(tool))) return;
    // Clamp to what the bags can complete: a queue longer than the reagents is one that the
    // server would refuse mid-way, and the refusal is the worse teacher.
    const wanted = Math.max(1, Math.min(CRAFT_QUEUE_MAX, Math.floor(Number(countInput.value) || 1)));
    const count = available !== undefined && available !== Infinity ? Math.min(wanted, available) : wanted;
    if (sendProfessionCast(spell, parts.target, count)) { status.textContent = "Запрос отправлен. Ожидаем ответ сервера…"; button.disabled = true; }
  });
  parts.detail.append(button, status);
  if (busy && game.world?.casts.get(game.world.state.selfGuid!)?.spellId === spell.id) {
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Отмена";
    cancel.addEventListener("click", () => game.world?.cancelSpellCast());
    parts.detail.append(cancel);
  }
  if (queued > 0) {
    const stop = document.createElement("button");
    stop.type = "button"; stop.textContent = "Остановить очередь";
    stop.addEventListener("click", () => {
      craftQueue = undefined;
      craftFeedback = "Очередь остановлена.";
      game.world?.cancelSpellCast();
      for (const entry of craftPanels.values()) entry.signature = "";
      refreshProfessionWindows();
    });
    parts.detail.append(stop);
  }
}

/**
 * Sends the next cast of a finished queue, or finishes it with words.
 *
 * Called with `pendingCraft` already cleared by the STOP/GO handler. The server still owns every
 * verdict — this only revalidates against the fresh inventory so a queue that would instantly
 * fail stops with «реагенты закончились» instead of spending a round trip per missing herb.
 */
function continueCraftQueue(spellId: number): void {
  const queue = craftQueue;
  craftQueue = undefined;
  if (!queue || queue.spellId !== spellId || queue.left <= 0) {
    craftFeedback = "Действие выполнено.";
    for (const parts of craftPanels.values()) parts.signature = "";
    refreshProfessionWindows();
    return;
  }
  const world = game.world;
  const spell = game.spells.get(spellId);
  if (!world || !spell) {
    craftFeedback = "Очередь остановлена: рецепт недоступен.";
    for (const parts of craftPanels.values()) parts.signature = "";
    refreshProfessionWindows();
    return;
  }
  const counts = carriedCounts(carriedSlots());
  if ((craftableCount(spell, counts) ?? 0) <= 0 || (spell.tools ?? []).some((tool) => !counts.has(tool))) {
    craftFeedback = "Очередь остановлена: недостаточно реагентов.";
    for (const parts of craftPanels.values()) parts.signature = "";
    refreshProfessionWindows();
    return;
  }
  if (!sendProfessionCast(spell, queue.target, queue.left)) {
    craftFeedback = "Очередь остановлена.";
    for (const parts of craftPanels.values()) parts.signature = "";
    refreshProfessionWindows();
  }
  // On success `sendProfessionCast` armed the fresh queue and refreshed already.
}

/** `sendProfessionCast`'s target for the trader's seventh slot rather than a carried item. */
const TRADE_SLOT_TARGET = "trade-slot";

function sendProfessionCast(spell: SpellMetadata, target?: bigint | typeof TRADE_SLOT_TARGET, count = 1): boolean {
  const world = game.world;
  if (!world || pendingCraft !== undefined || spellCastBlockReason(world, spell.id) !== undefined
    || (world.state.selfGuid !== undefined && world.casts.has(world.state.selfGuid))) return false;
  const cooldown = Math.max(spell.recoveryTime, spell.categoryRecoveryTime);
  if (target === TRADE_SLOT_TARGET) {
    if (!world.castSpellOnTradeSlot(spell.id, cooldown, spell.cooldownStartedOnEvent)) return false;
    pendingCraft = spell.id;
  } else if (recipeRequiresItem(spell)) {
    const slot = carriedSlots().find((entry) => entry.guid === target);
    const template = slot?.item && world.itemTemplate(entryOf(slot.item));
    if (target === undefined || !template?.found || !recipeAcceptsItem(spell, template)) return false;
    pendingCraft = spell.id;
    world.castSpellOnItem(spell.id, target, cooldown, spell.cooldownStartedOnEvent);
  } else {
    requestSpellCast(spell.id, () => {
      pendingCraft = spell.id;
      world.castSpell(spell.id, cooldown, spell.cooldownStartedOnEvent);
    });
  }
  // A ground-target recipe arms the reticle instead of sending: the closure above never ran, so
  // there is no cast in flight and nothing for a queue to follow.
  if (pendingCraft === spell.id) {
    const left = Math.max(0, Math.min(CRAFT_REPEAT_MAX, Math.floor(count) || 1) - 1);
    craftQueue = left > 0 && target !== TRADE_SLOT_TARGET ? { spellId: spell.id, left, target } : undefined;
  } else craftQueue = undefined;
  craftFeedback = "Запрос отправлен. Ожидаем ответ сервера…";
  craftTimeout = setTimeout(() => {
    if (game.world === world && pendingCraft === spell.id && !world.casts.has(world.state.selfGuid!)) {
      pendingCraft = undefined;
      craftFeedback = "Ответ не получен. Можно повторить создание.";
      refreshProfessionWindows();
    }
  }, 10000);
  refreshProfessionWindows();
  return true;
}
