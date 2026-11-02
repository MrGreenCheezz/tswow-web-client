import { game } from "../game/Context.js";
import { spellButtonUsable, type SpellMetadata } from "../SpellMetadata.js";
import { ensureSpellNames } from "./SpellNames.js";
import { PET_SPELL_DRAG_FORMAT, SPELLBOOK_PET_TAB, nativePetBook, petBookAutocast, petBookTab, type PetBookRow } from "./PetSpellbook.js";
import { clearPetBookCooldowns, registerPetBookCooldown, updatePetBookCooldowns } from "./PetSpellbook.js"; // L7 4.03
import {
  spellStatus, spellbookHideRanks, spellbookList, spellbookSearch, spellbookTabs, spellbookWindow,
} from "./Dom.js";
import { lowerRankSpells } from "./SpellRanks.js";
import { spellModifierText } from "../../world/SpellModifiers.js";
import { skinnable, slotElement, slotSiblings } from "./Slots.js";
import { actionDragPayload } from "./ActionBar.js";
import { beginIconDrag } from "./DragGhost.js";
import {
  getTip, setTip, attachTooltip, cooldownDuration, cooldownLabel, cooldownView,
} from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { unknownLabel } from "./Format.js";
import { closeProfessionCraft } from "./ProfessionCraft.js";
import { castSpell } from "./SpellCast.js";
import { forgetSpellMetadataSettled, rankedSpell, spellMetadataSettled } from "./SpellData.js";
import { setSpellBookHost } from "./HtmlWindowHosts.js";
import { settingOn, watchSettingsApplied } from "./Settings.js";
import { spellTooltip } from "./SpellTooltip.js";
import { globalCooldownEndFor, globalCooldownSpanFor } from "../game/PredictedGlobalCooldown.js"; // L13-review 5.30
import {
  GENERAL_TAB_ICON, SPELLBOOK_GENERAL_TAB, SPELLBOOK_OTHER_CLASS_TAB, liveSpellbookTabs, spellAbilityMatchesActor,
  spellbookActor, spellbookClassLines, spellbookOtherClassSpell, spellbookOtherClassTabName, spellbookTabFor,
  type SpellbookActorContext, type SpellbookTabData,
} from "./SpellbookTabs.js";
import { className } from "./UnitSnapshot.js";

/**
 * The tab and skill-line model lives in `SpellbookTabs.ts`, apart from this module's DOM, because
 * the stock FrameXML provider answers from the same classifier. These re-exports keep the public
 * names this module has always carried.
 */
export {
  SKILL_INTERNAL, SPELLBOOK_GENERAL_TAB, SPELLBOOK_OTHER_CLASS_TAB, liveSpellbookTabs, spellAbilityMatchesActor,
  spellAbilityVisible, spellbookActor, spellbookClassLines, spellbookOtherClassSpell, spellbookTabFor,
  type SpellbookActorContext, type SpellbookSkillAbility, type SpellbookTabData,
} from "./SpellbookTabs.js";

export const spellButtons = new Map<number, Array<{ button: HTMLButtonElement; cooldown: HTMLSpanElement }>>();

/**
 * What the search box holds, and whether the book is showing only the top rank of each chain.
 *
 * The book used to be paged twelve to a page. The number was a constant while the window is
 * `min(560px, 100vw - 32px)` wide and resizable, so a mage's 351 spells came to thirty turns of a
 * two-button footer — and the original client's page of twelve was the consequence of a frame
 * fixed at 384x512 that could not be dragged. A list that scrolls inside the window it is already
 * in needs no footer, no page number and nothing new from the gateway.
 *
 * The rank switch is an account setting (`spellbookHideLowerRanks`) rather than a local flag, and
 * it is pushed in from `applySettings` — the same way the render scale and the grass radius are —
 * so the checkbox in the book's header and the server's copy of the blob can never disagree.
 */
let spellbookQuery = "";
let hideLowerRanks = true;

/**
 * Which skill line the book is showing, or undefined for all of them.
 *
 * The tabs are the character's own skill lines, which is how the original client divides the book
 * too: a spell belongs to a `SkillLine` through `SkillLineAbility`, and a class's talent trees,
 * its professions and its general abilities are all skill lines. Nothing about that is on the
 * wire — `SMSG_INITIAL_SPELLS` is a flat list of ids — so the division comes from `/dbc/talents`
 * and the book falls back to one undivided list when that has not landed.
 */
let spellbookTab: number | undefined;

/**
 * The book's own window for a patch's `class:` entry, and the tab strip's slot (М7).
 *
 * The host is made once and the strip's redraw never touches it: `drawTabs` replaces the whole
 * strip on every `showSpells`, and a fresh host per draw would take a module's tab off the screen
 * and build it again each time the book was paged. Written through {@link slotSiblings} for the
 * reason `CharacterSheet.ts` gives — a host handed back into `replaceChildren` is still removed
 * first, and a removed element loses focus — and because `clearSpellbook` emptied this strip on
 * leaving the world, which took the host with it and left a module's tab nowhere until the next
 * `showSpells` put the host back.
 */
skinnable("spellbook-window", spellbookWindow);
const spellbookTabsHost = slotElement("spellbook/tabs");
const drawSpellbookTabs = slotSiblings(spellbookTabs, spellbookTabsHost);

export function selectSpellbookTab(skillLine: number | undefined): void {
  spellbookTab = skillLine;
  showSpells();
}

/** What the player typed into the book's search box. Matched against the name and the rank. */
export function setSpellbookSearch(text: string): void {
  spellbookQuery = text.trim().toLocaleLowerCase();
  showSpells();
}

/**
 * Escape in the search box: empty it, and let go of it.
 *
 * The blur releases movement keys again after the search is cleared. The shared Escape handler
 * sees that this field handled the first press, so a second Escape closes the book.
 *
 * The chat box has had this since it was written — `Controls.ts:95-96` clears and blurs `chatInput`
 * for the same reason, in the same two lines — and this is that pair, on this side of the fence.
 * Handled here because this field owns clearing its search query.
 */
export function spellbookSearchKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (spellbookSearch.value !== "") {
    spellbookSearch.value = "";
    setSpellbookSearch("");
  }
  spellbookSearch.blur();
  event.preventDefault();
}

/**
 * The rank switch, pushed in by `applySettings` whenever the account's blob changes or lands.
 *
 * It also carries the value back to the checkbox: the setting is per character and arrives from
 * the server long after the page was built, so the box has to follow the blob rather than the
 * other way round.
 */
export function setSpellbookRankFilter(hide: boolean): void {
  spellbookHideRanks.checked = hide;
  if (hide === hideLowerRanks) return;
  hideLowerRanks = hide;
  showSpells();
}

watchSettingsApplied(() => { setSpellbookRankFilter(settingOn("spellbookHideLowerRanks")); });

/** Forgets the buttons of the character that has just been left. */
export function clearSpellbook(): void {
  closeProfessionCraft();
  spellbookTab = undefined;
  spellbookQuery = "";
  forgetSpellMetadataSettled();
  spellbookSearch.value = "";
  drawSpellbookTabs([]);
  spellbookList.replaceChildren();
  spellButtons.clear();
  clearPetBookCooldowns(); // L7 4.03
}

/** The paged spell book, its cooldown sweeps and casting from it. */

/**
 * Whether a spell the server says the character knows belongs in the book.
 *
 * Kept beside the book rather than in `SpellbookTabs.ts` because it reads live spell metadata, but
 * the rules are the same on both books. The server does not decide this and is not meant to:
 * `Player::SendInitialSpells` sends every spell in `m_spells` that is active and not disabled, and
 * looks at no attribute at all. Which of them a player sees is the client's judgement, and the
 * real client makes it on two things.
 *
 * **The invisible bit, not the passive one.** `SPELL_ATTR0_HIDDEN_CLIENTSIDE` (0x80) is the flag
 * whose whole meaning is "not visible in spellbook or aura bar". The passive bit (0x40) means
 * something else entirely, and `SpellBookFrame.lua` proves it: a passive spell is drawn, in grey,
 * with the passive highlight. Filtering on passive was wrong in both directions — it hid 159
 * spells the real book lists (Dodge, Block, Parry, Dual Wield, every racial passive) and kept
 * 3,669 that are marked invisible.
 *
 * **And a real `SkillLineAbility` row, when one exists.** A spell whose rows are all for another
 * class or race is a creature, trigger or proc the realm let through, and it stays out. But a spell
 * with *no row at all* is one the realm taught directly — an item, a quest, a module — and it goes
 * to General, which is exactly where a learned spell that used to vanish now lands. Hiding the
 * rowless rows was why an item-taught spell never appeared.
 *
 * Nothing the player needs is lost. Languages, riding and armour proficiency carry *both* bits and
 * are not in the real book either — Blizzard shows them as skills, and this client already has
 * that window.
 *
 * A spell whose row has not arrived yet is kept: the alternative is a book that empties itself
 * while it loads.
 */

function belongsInSpellbook(id: number): boolean {
  const metadata = game.spells.get(id);
  if (metadata?.hidden) return false;
  // Recipes still live in the craft window: a recipe only casts from one and its reagents and
  // difficulty belong there. Openers now stay — the book shows them in General, and a click routes
  // to `openProfession` the way the original client's opener cast opens its trade window. The
  // client's own rule is the TRADESPELL attribute, not the craft effect: `professionRecipe` also
  // counts every item-creating spell, which hid Conjure Water and Create Healthstone from this
  // book while they sit in the original's Arcane and Demonology tabs.
  if (metadata?.tradeSkill === true) return false;
  const talents = game.talentData;
  const rows = typeof talents?.spellAbilitiesOf === "function"
    ? talents.spellAbilitiesOf(id)
    : undefined;
  // No row at all is not the same answer as a row for somebody else: until the table lands nothing
  // can be judged (keep everything), and a spell the realm taught directly has no row to match and
  // belongs to General (keep it). Rows that exist and all exclude this actor hide their spell —
  // unless they place it in another class's ability line: that is the character's borrowed kit, and
  // it has a tab of its own (SpellbookTabs.ts, SPELLBOOK_OTHER_CLASS_TAB).
  if (rows === undefined || rows.length === 0) return true;
  const actor = spellbookActor();
  if (rows.some((row) => spellAbilityMatchesActor(row, actor))) return true;
  const tabs = liveSpellbookTabs();
  return tabs !== undefined && spellbookOtherClassSpell(id, tabs.data, tabs.actor);
}

export function showSpells(): void {
  spellbookList.replaceChildren();
  spellButtons.clear();
  clearPetBookCooldowns(); // L7 4.03
  const world = game.world;
  const talentData = game.talentData;
  if (world?.initialSpellsReceived && talentData && !talentData.ready
    && !("failed" in talentData && talentData.failed)) {
    drawSpellbookTabs([]);
    spellStatus.className = "muted";
    spellStatus.textContent = "Проверяем доступность заклинаний…";
    return;
  }
  const known = world?.knownSpells.filter((spell) => belongsInSpellbook(spell.id)) ?? [];
  // Only the very first batch blanks the book: with no rows at all every spell would be a
  // placeholder. A spell learned later, while other rows are already in hand, is drawn as its own
  // placeholder in General and filled in when it lands — blanking the page here was the other half
  // of "learned spells never appear".
  if (world?.initialSpellsReceived && game.spellMetadataClient
    && !spellMetadataSettled(world) && game.spells.size === 0
    && known.some((spell) => !game.spells.has(spell.id))) {
    drawSpellbookTabs([]);
    spellStatus.className = "muted";
    spellStatus.textContent = "Загрузка описаний заклинаний…";
    return;
  }
  const tabs = liveSpellbookTabs();
  const knownIds = known.map((spell) => spell.id);
  const classLines = tabs === undefined
    ? new Set<number>()
    : spellbookClassLines(tabs.data, knownIds, tabs.actor);
  const tabOf = (id: number): number => tabs === undefined
    ? SPELLBOOK_GENERAL_TAB
    : spellbookTabFor(id, tabs.data, classLines, tabs.actor);
  const counts = new Map<number, number>();
  for (const id of knownIds) counts.set(tabOf(id), (counts.get(tabOf(id)) ?? 0) + 1);
  // 4.03: the pet's book is a tab of its own, last, while there is one (PetSpellbook.ts).
  const petTab = tabs === undefined ? undefined : petBookTab();
  if (spellbookTab === SPELLBOOK_PET_TAB && !petTab) spellbookTab = undefined;
  // A tab the character has no spell in at all cannot stay selected: the strip would not draw it,
  // and the book would sit on «В этой вкладке нет активных заклинаний» with nothing on the screen
  // to press to get out of it. General is the fallback because the original book always has it.
  if (spellbookTab !== SPELLBOOK_PET_TAB && (spellbookTab === undefined || !counts.has(spellbookTab))) {
    // A class's own tree before the other classes' tab, which has no SkillLine name to sort by.
    const fallback = [...counts.keys()].filter((line) => line !== SPELLBOOK_GENERAL_TAB)
      .sort((left, right) => Number(left === SPELLBOOK_OTHER_CLASS_TAB) - Number(right === SPELLBOOK_OTHER_CLASS_TAB)
        || tabName(left, tabs).localeCompare(tabName(right, tabs)))[0];
    spellbookTab = (counts.get(SPELLBOOK_GENERAL_TAB) ?? 0) > 0 || fallback === undefined
      ? SPELLBOOK_GENERAL_TAB : fallback;
  }
  // Tabs come from the unfiltered list, and so does the count on each of them: a strip counted
  // after the rank or search filter would reshuffle while the player filters. The other classes'
  // tab has no SkillLine of its own; its label and picture come from the character and its first spell.
  const otherFirst = knownIds.find((id) => tabOf(id) === SPELLBOOK_OTHER_CLASS_TAB);
  drawTabs(tabs, counts, {
    name: spellbookOtherClassTabName(className(tabs?.actor.classId), classLines.size > 0),
    iconId: otherFirst === undefined ? 0 : game.spells.get(otherFirst)?.iconId ?? 0,
  }, petTab && {
    name: petTab.name, count: petTab.rows.length,
    iconId: petTab.rows[0] === undefined ? 0 : game.spells.get(petTab.rows[0].entry.spellId)?.iconId ?? 0,
  });
  if (spellbookTab === SPELLBOOK_PET_TAB && petTab) {
    drawPetBook(petTab.rows);
    return;
  }
  const inTab = known.filter((spell) => tabOf(spell.id) === spellbookTab);

  const lower = hideLowerRanks
    ? lowerRankSpells(inTab.map((spell) => rankedSpell(spell.id)).filter((spell) => spell !== undefined))
    : new Set<number>();
  const ranked = inTab.filter((spell) => !lower.has(spell.id));
  const activeSpells = ranked.filter((spell) => matchesQuery(spell.id));
  // Level first, then the name: a book is read from the spell learned at one to the spell learned
  // at eighty, and `SMSG_INITIAL_SPELLS` arrives in the order the server happened to store them —
  // `Player.cpp:2883` writes a constant where the wire's slot number would go, so even that is not
  // an order the client may honour.
  activeSpells.sort((left, right) => {
    const first = game.spells.get(left.id);
    const second = game.spells.get(right.id);
    return (first?.spellLevel ?? 0) - (second?.spellLevel ?? 0)
      || (first?.name ?? "").localeCompare(second?.name ?? "");
  });

  if (activeSpells.length === 0) {
    spellStatus.className = "muted";
    // Four states and not two. "Nothing here" and "nothing yet" look the same and are not: a
    // character who has just entered the world has an empty list because the packet is still on
    // its way, and telling them they know no spells is simply false. The third is a tab of the
    // book that happens to be empty while the others are not, and the fourth is a search that
    // matched nothing — which is the only one of the four the player can undo.
    spellStatus.textContent = !world || !world.initialSpellsReceived
      ? "Список заклинаний ещё не пришёл…"
      : known.length === 0
        ? "Активных заклинаний нет."
        : spellbookQuery ? "Ничего не найдено." : "В этой вкладке нет активных заклинаний.";
    return;
  }

  spellStatus.className = "success";
  spellStatus.textContent = spellbookQuery
    ? `Найдено ${activeSpells.length} из ${ranked.length}`
    : lower.size > 0
      ? `${activeSpells.length} заклинаний, младших рангов скрыто ${lower.size}`
      : `${activeSpells.length} заклинаний`;
  // Live spell modifiers (procs, talents, set bonuses): the server owns which spells each one
  // touches, so the book lists them globally rather than per spell. Without this the
  // `SMSG_SET_FLAT/PCT_SPELL_MODIFIER` state had no reader at all. Optional chaining: tests
  // drive this with partial world fakes that predate the field.
  if (world && (world.spellModifiers?.size ?? 0) > 0) {
    const modifiers = document.createElement("div");
    modifiers.className = "spellbook-modifiers";
    const title = document.createElement("strong");
    title.textContent = "Активные усиления заклинаний:";
    modifiers.append(title);
    for (const modifier of world.spellModifiers.values()) {
      const line = document.createElement("div");
      line.textContent = spellModifierText(modifier);
      modifiers.append(line);
    }
    spellbookList.append(modifiers);
  }
  for (const spell of activeSpells) {
    // The badge carries the rank rather than the id: a gold `#1234` on every row said nothing.
    spellbookList.append(createSpellButton(spell.id, game.spells.get(spell.id)?.rank ?? ""));
  }
  updateSpellCooldowns(performance.now());
}

/**
 * 4.03: the pet tab's page — the pet's spells in the realm's order, as the stock pet book lists them.
 * A click is `CastSpell(i, "pet")`, a right click `ToggleSpellAutocast(i, "pet")`, a drag onto the pet
 * bar `PickupSpell(i, "pet")` dropped there (PetBar.ts); all three through the stock pet book model.
 */
function drawPetBook(rows: readonly PetBookRow[]): void {
  const ids = rows.map((row) => row.entry.spellId);
  if (ids.some((id) => !game.spells.has(id))) ensureSpellNames(ids, () => showSpells());
  const shown = rows.filter((row) => matchesQuery(row.entry.spellId));
  spellStatus.className = shown.length > 0 ? "success" : "muted";
  spellStatus.textContent = shown.length === 0
    ? (spellbookQuery ? "Ничего не найдено." : "В этой вкладке нет активных заклинаний.")
    : spellbookQuery ? `Найдено ${shown.length} из ${rows.length}` : `${shown.length} заклинаний`;
  for (const row of shown) spellbookList.append(createPetSpellButton(row));
}

function createPetSpellButton(row: PetBookRow): HTMLButtonElement {
  const spellId = row.entry.spellId;
  const metadata = game.spells.get(spellId);
  const autocast = petBookAutocast(row.entry);
  const button = document.createElement("button");
  const icon = document.createElement("span");
  const label = document.createElement("span");
  const badge = document.createElement("small");
  button.type = "button";
  button.className = autocast.on ? "spell-button pet-spell-button is-autocast" : "spell-button pet-spell-button";
  button.dataset["petBookIndex"] = String(row.index);
  attachTooltip(button, () => spellTooltip(spellId));
  icon.className = "spell-icon";
  icon.style.background = `hsl(${(metadata?.iconId ?? spellId) * 47 % 360} 45% 38%)`;
  const iconUrl = spellIconUrl(metadata?.iconId ?? 0, game.gatewayOrigin);
  if (iconUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.addEventListener("error", () => image.remove(), { once: true });
    setIconSource(image, iconUrl);
    icon.append(image);
  }
  label.className = "spell-label";
  label.textContent = [metadata?.name ?? unknownLabel("заклинание", spellId), metadata?.passive ? "пассивное" : "",
    autocast.on ? "автоприменение" : ""].filter(Boolean).join(" · ");
  badge.textContent = metadata?.rank ?? "";
  button.append(icon, label, badge);
  // L7 4.03: the row's cooldown sweep, as the character's rows draw theirs (PetSpellbook.ts).
  const cooldown = document.createElement("span");
  cooldown.className = "spell-cooldown";
  cooldown.hidden = true;
  button.append(cooldown);
  registerPetBookCooldown(spellId, button, cooldown);
  // Until the row lands nothing is sent; a passive spell is never sent (the model refuses it too).
  const castable = metadata !== undefined && metadata.passive !== true;
  button.disabled = !castable;
  button.setAttribute("aria-label", label.textContent);
  if (!castable) return button;
  button.addEventListener("click", () => nativePetBook().castBookSpell(row.index));
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (autocast.autocastable) nativePetBook().toggleBookAutocast(row.index);
  });
  button.draggable = true;
  button.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData(PET_SPELL_DRAG_FORMAT, String(spellId));
    beginIconDrag(event, icon, { label: metadata.name.trim().charAt(0) || undefined });
  });
  return button;
}

/** PET_BAR_CHANGED: the pet tab appears, goes or redraws its autocast marks while the book is open. */
export function refreshPetSpellbook(): void {
  if (!spellbookWindow.hidden) showSpells();
}

/** Name or rank, folded to lower case. Empty query matches everything. */
function matchesQuery(spellId: number): boolean {
  if (!spellbookQuery) return true;
  const metadata = game.spells.get(spellId);
  if (!metadata) return false;
  return metadata.name.toLocaleLowerCase().includes(spellbookQuery)
    || metadata.rank.toLocaleLowerCase().includes(spellbookQuery);
}

/** The label one tab carries: General is the client's own word, a class line its `SkillLine` name. */
function tabName(line: number, tabs: { data: SpellbookTabData } | undefined): string {
  if (line === SPELLBOOK_GENERAL_TAB) return "Общие";
  return tabs?.data.skillLine(line)?.name ?? `Навык ${line}`;
}

/**
 * The class tabs the character actually has spells in, with General always first.
 *
 * This is the original book's shape: tab one is General, then the class lines. A profession, a
 * racial, a mount line and any rowless custom spell all count toward General, so the strip can
 * never grow one tab per skill line the way it used to.
 */
function drawTabs(
  tabs: { data: SpellbookTabData; actor: SpellbookActorContext } | undefined,
  counts: ReadonlyMap<number, number>,
  other: { readonly name: string; readonly iconId: number },
  pet?: { readonly name: string; readonly count: number; readonly iconId: number },
): void {
  // A book whose skill lines have not landed still has a tab strip a module may have put a tab
  // into (М7) — and the host itself is out of the redraw either way.
  if (tabs === undefined) {
    drawSpellbookTabs([]);
    return;
  }
  const entries: Array<{ line: number; count: number; name: string; iconId: number }> = [
    {
      line: SPELLBOOK_GENERAL_TAB,
      count: counts.get(SPELLBOOK_GENERAL_TAB) ?? 0,
      name: tabName(SPELLBOOK_GENERAL_TAB, tabs),
      iconId: GENERAL_TAB_ICON,
    },
  ];
  for (const [line, count] of counts) {
    if (line === SPELLBOOK_GENERAL_TAB) continue;
    if (line === SPELLBOOK_OTHER_CLASS_TAB) {
      entries.push({ line, count, name: other.name, iconId: other.iconId });
      continue;
    }
    const info = tabs.data.skillLine(line);
    entries.push({ line, count, name: info?.name ?? `Навык ${line}`, iconId: info?.iconId ?? 0 });
  }
  // General first and the other classes' tab last, as the stock book orders them.
  const rank = (line: number): number => (line === SPELLBOOK_GENERAL_TAB ? 0 : line === SPELLBOOK_OTHER_CLASS_TAB ? 2 : 1);
  entries.sort((left, right) => rank(left.line) - rank(right.line)
    || left.name.localeCompare(right.name) || left.line - right.line);
  // The pet's book after all of the character's own, as the stock book puts its pet tab last.
  if (pet) entries.push({ line: SPELLBOOK_PET_TAB, count: pet.count, name: pet.name, iconId: pet.iconId });
  drawSpellbookTabs(entries.map((entry) =>
    tabButton(entry.name, spellbookTab === entry.line, entry.line, entry.count, entry.iconId)));
}

function tabButton(label: string, active: boolean, line: number, count: number, iconId: number): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "spellbook-tab is-active" : "spellbook-tab";
  const url = spellIconUrl(iconId, game.gatewayOrigin);
  if (url) {
    const icon = document.createElement("img");
    icon.className = "spellbook-tab-icon";
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, url);
    button.append(icon);
  }
  const text = document.createElement("span");
  text.textContent = `${label} (${count})`;
  button.append(text);
  button.addEventListener("click", () => selectSpellbookTab(line));
  return button;
}

function createSpellButton(spellId: number, badge: string): HTMLButtonElement {
  const metadata = game.spells.get(spellId);
  const button = document.createElement("button");
  const icon = document.createElement("span");
  const label = document.createElement("span");
  const id = document.createElement("small");
  const cooldown = document.createElement("span");
  button.type = "button";
  button.className = "spell-button";
  attachTooltip(button, () => spellTooltip(spellId));
  // Until the async DBC row arrives this is only a placeholder. It must not send a cast with an
  // unknown recovery/GCD duration; showSpells() rebuilds it and enables it once metadata lands.
  setSpellButtonState(button, spellId, metadata, 0);
  icon.className = "spell-icon";
  icon.style.background = `hsl(${(metadata?.iconId ?? spellId) * 47 % 360} 45% 38%)`;
  const iconUrl = spellIconUrl(metadata?.iconId ?? 0, game.gatewayOrigin);
  if (iconUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.addEventListener("error", () => image.remove(), { once: true });
    setIconSource(image, iconUrl);
    icon.append(image);
  }
  label.className = "spell-label";
  // The rank is not here, because it is already drawn in the corner of this same button: the badge
  // (`<small>`, `:172`) carries it. Printing it twice cost the name — the label sits in the `1fr`
  // half of a two-column 48-pixel row with `white-space: nowrap` and `text-overflow: ellipsis`
  // (`style.css:446,447,450`), so «Огненный шар · Уровень 16» was clipped mid-name to make room
  // for a string that was legible three centimetres to the right.
  label.textContent = [metadata?.name ?? unknownLabel("заклинание", spellId), metadata?.passive ? "пассивное" : ""].filter(Boolean).join(" · ");
  id.textContent = badge;
  cooldown.className = "spell-cooldown";
  cooldown.hidden = true;
  button.append(icon, label, id, cooldown);
  if (spellButtonUsable(metadata)) {
    button.addEventListener("click", () => castSpell(spellId));
    // Dragged onto a bar slot, which is how anything gets onto a bar in the first place.
    button.draggable = true;
    button.addEventListener("dragstart", (event) => {
      const [format, payload] = actionDragPayload(spellId);
      event.dataTransfer?.setData(format, payload);
      // 4.02: the spell's icon on the cursor rather than the whole row with its name and rank.
      beginIconDrag(event, icon, { label: metadata?.name?.trim().charAt(0) || undefined });
    });
    const elements = spellButtons.get(spellId) ?? [];
    elements.push({ button, cooldown });
    spellButtons.set(spellId, elements);
  }
  return button;
}

/** Applies the book's disabled and accessible-name state, including the active-mount toggle. */
function setSpellButtonState(
  button: HTMLButtonElement,
  spellId: number,
  metadata: SpellMetadata | undefined,
  remaining: number,
): void {
  const world = game.world;
  const togglingMount = typeof world?.isActiveMountSpell === "function"
    && world.isActiveMountSpell(spellId);
  const usable = spellButtonUsable(metadata);
  // Held until its aura ends (WorldClient.isSpellOnHold): not ready, and nothing to count down.
  const held = !togglingMount && world?.isSpellOnHold?.(spellId) === true;
  const disabled = !usable || (!togglingMount && remaining > 0) || held;
  const base = metadata?.name ?? unknownLabel("заклинание", spellId);
  const label = !usable && metadata?.passive ? `${base} · пассивное`
    : togglingMount ? `${base} · Снять маунта`
      : remaining > 0 ? `${base} · Восстанавливается`
        : held ? `${base} · Ещё не готово` : base;
  // Called 60 times a second for every known spell: reads are free, writes force style and
  // accessibility work, so only touch the DOM when the value actually moved.
  if (button.disabled !== disabled) button.disabled = disabled;
  if (getTip(button) !== label) setTip(button, label);
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  const ariaDisabled = String(disabled);
  if (button.getAttribute("aria-disabled") !== ariaDisabled) {
    button.setAttribute("aria-disabled", ariaDisabled);
  }
}

// The metadata load (SpellData.ts) redraws this window and writes under its header through this.
setSpellBookHost({
  redraw: showSpells,
  status: (message, tone) => {
    spellStatus.className = tone;
    spellStatus.textContent = message;
  },
});

/** Last overlay values per cooldown span, so idle frames compare instead of writing. */
const spellCooldownWritten = new WeakMap<HTMLSpanElement, { sweep: string; label: string; hidden: boolean }>();
const spellCoolingWritten = new WeakMap<HTMLButtonElement, boolean>();

export function updateSpellCooldowns(now: number): void {
  const world = game.world;
  // The cooldown surface is optional for the partial world doubles the tests drive this book with;
  // a real `WorldClient` always answers both.
  if (!world || typeof world.cooldownRemaining !== "function" || typeof world.cooldownState !== "function") return;
  // Every button of the book lives in its window, and a closed book shows no sweep: each frame
  // walked every known spell with four DOM reads apiece — for the whole session under the stock
  // SpellBookFrame, which keeps this window hidden. Opening the book rebuilds it (`showSpells`,
  // from `toggleGameWindow`) and the first frame after draws the sweeps from the world's clock.
  if (spellbookWindow.hidden) return;
  for (const [spellId, copies] of spellButtons) {
    const metadata = game.spells.get(spellId);
    const own = world.cooldownRemaining(spellId, now);
    const ownState = world.cooldownState(spellId);
    // L13-review 5.30: the cast guard's rule — the global cooldown of the row's own category and that entry's own
    // length (0x00807980); unknown length: the row's StartRecoveryTime. A category-0 spell's button is not disabled
    // by a 133 global cooldown it may be cast through, a 133 spell without a time of its own is.
    const globalEnd = globalCooldownEndFor(game, metadata); // L13-review 5.30
    const globalRemaining = globalEnd > now ? globalEnd - now : 0; // L13-review 5.30
    const gcdDuration = globalRemaining > 0 ? globalCooldownSpanFor(game, metadata) || (metadata?.startRecoveryTime ?? 0) : 0; // L13-review 5.30
    // Keep the denominator stable. Deriving it from `remaining` on every frame makes the overlay
    // look stuck until it vanishes; WorldClient's snapshot preserves the real server/local window.
    const ownDuration = cooldownDuration(
      metadata?.recoveryTime, metadata?.categoryRecoveryTime,
    );
    const view = cooldownView(
      now, own, ownDuration,
      globalRemaining, // L13-review 5.30: was `gcdDuration > 0 ? shared remaining : 0`
      gcdDuration, ownState,
    );
    const cooling = view.remaining > 0;
    const label = cooldownLabel(view.remaining);
    // Whole degrees: a long cooldown changes the visible sweep a few times a minute, and even a
    // 1.5 s GCD steps through the same integers it would have written as floats.
    const sweep = `${Math.round(view.fraction * 360)}deg`;
    const hidden = !cooling;
    for (const elements of copies) {
      setSpellButtonState(elements.button, spellId, metadata, view.remaining);
      if (spellCoolingWritten.get(elements.button) !== cooling) {
        spellCoolingWritten.set(elements.button, cooling);
        elements.button.classList.toggle("cooling", cooling);
      }
      const written = spellCooldownWritten.get(elements.cooldown);
      if (written === undefined
        || written.sweep !== sweep || written.label !== label || written.hidden !== hidden) {
        spellCooldownWritten.set(elements.cooldown, { sweep, label, hidden });
        elements.cooldown.style.setProperty("--sweep", sweep);
        if (elements.cooldown.textContent !== label) elements.cooldown.textContent = label;
        if (elements.cooldown.hidden !== hidden) elements.cooldown.hidden = hidden;
      }
    }
  }
  updatePetBookCooldowns(now); // L7 4.03: the pet tab's rows
}
