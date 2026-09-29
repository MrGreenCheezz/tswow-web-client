import { MELEE_AUTO_ATTACK_SPELL_ID, WorldClient } from "../../world/WorldClient.js";
import { POWER, POWER_DISPLAY_SCALE, attackPower, readField, unit } from "../../world/Fields.js";
import { game } from "../game/Context.js";
import { spellButtonUsable, type SpellMetadata } from "../SpellMetadata.js";
import { syncMountSpellIds } from "../MountSpells.js";
import { spellCastBlockReason } from "../SpellCastGuard.js";
import { GROUND_TARGET_MODE, beginGroundTarget, isGroundTargetSpell } from "../game/GroundTarget.js";
import { isCurrentSpellMetadataRequest, spellMetadataEpoch } from "./SpellNames.js";
import {
  spellStatus, spellbookHideRanks, spellbookList, spellbookSearch, spellbookTabs, spellbookWindow,
} from "./Dom.js";
import { lowerRankSpells, rankChainKey, type RankedSpell } from "./SpellRanks.js";
import { spellModifierText } from "../../world/SpellModifiers.js";
import { skinnable, slotElement, slotSiblings } from "./Slots.js";
import { actionDragPayload } from "./ActionBar.js";
import {
  attachTooltip, cooldownDuration, cooldownLabel, cooldownView,
  type TooltipContent, type TooltipLine,
} from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { unknownLabel } from "./Format.js";
import { formatSpellDescription, type SpellDescriptionContext } from "./SpellText.js";
import { globalString } from "../../generated/globalStrings.js";
import { fillTemplate } from "./ItemTooltip.js";
import { notice } from "./Notices.js";
import { readSkills } from "./Skills.js";
import { professionOpener, professionSpellSkill } from "./ProfessionRules.js";
import { openProfession, closeProfessions } from "./Professions.js";
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
/** The last metadata request settled, even when the gateway omitted a requested custom row. */
let spellMetadataSettledWorld: WorldClient | undefined;

/** Formula operands the server keeps in the player's private update fields. */
export function spellDescriptionContext(): SpellDescriptionContext {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined
    : world.state.objects.get(world.state.selfGuid);
  // An empty values object is intentional: it tells the formatter this is a live tooltip and an
  // unavailable AP/SPH operand should become a readable fallback, never a raw `$MWS` formula or a
  // fabricated zero. The spell map is still useful for `$21084d` cross-row markers.
  if (!self) return { spells: game.spells, values: {} };
  const attackPowerValue = attackPower(self);
  const attackTime = readField(self, "UNIT_FIELD_BASEATTACKTIME");
  const spellHealing = readField(self, "PLAYER_FIELD_MOD_HEALING_DONE_POS");
  return {
    spells: game.spells,
    values: {
      ...(attackPowerValue === undefined ? {} : { AP: Math.max(0, attackPowerValue) }),
      // WoW's MWS operand is seconds; UNIT_FIELD_BASEATTACKTIME is milliseconds.
      ...(attackTime === undefined ? {} : { MWS: Math.max(0, attackTime) / 1000 }),
      ...(spellHealing === undefined ? {} : { SPH: Math.max(0, spellHealing) }),
    },
  };
}

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

/** Forgets the buttons of the character that has just been left. */
export function clearSpellbook(): void {
  closeProfessions();
  spellbookTab = undefined;
  spellbookQuery = "";
  spellMetadataSettledWorld = undefined;
  spellbookSearch.value = "";
  drawSpellbookTabs([]);
  spellbookList.replaceChildren();
  spellButtons.clear();
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

/** Pick the skill line from the row the current character is actually allowed to use. */
function spellSkillLineForBook(id: number): number | undefined {
  const talents = game.talentData;
  const rows = typeof talents?.spellAbilitiesOf === "function"
    ? talents.spellAbilitiesOf(id)
    : undefined;
  if (rows !== undefined) {
    const actor = spellbookActor();
    return rows.find((row) => spellAbilityMatchesActor(row, actor))?.skillLine;
  }
  return talents?.skillOfSpell(id);
}

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

/**
 * Everything the rank predicate needs about a spell, or undefined while its row is in flight.
 *
 * A spell whose metadata has not landed is never a candidate for hiding: without a name, a family
 * and a level there is nothing to compare it to, and a book that hid rows while it loaded would be
 * the same defect `belongsInSpellbook` avoids at the other end.
 */
function rankedSpell(id: number): RankedSpell | undefined {
  const metadata = game.spells.get(id);
  const skillLine = spellSkillLineForBook(id);
  if (!metadata || skillLine === undefined) return undefined;
  return {
    id, skillLine,
    name: metadata.name,
    rank: metadata.rank,
    spellLevel: metadata.spellLevel,
    spellClassSet: metadata.spellClassSet,
    spellClassMask: metadata.spellClassMask,
  };
}

/**
 * The highest known rank in this spell's chain, or the spell itself.
 *
 * Chains are the same `rankChainKey` groups the book hides lower ranks by: without the same
 * key the bar would "upgrade" a frost armour into an ice armour. Unknown rows (metadata or
 * skill line still in flight) answer the input unchanged, so a repaint can never demote a
 * slot while the tables load.
 */
export function highestKnownRank(id: number): number {
  const world = game.world;
  const self = rankedSpell(id);
  if (!world || !self) return id;
  const key = rankChainKey(self);
  const chain = world.knownSpells
    .map((spell) => rankedSpell(spell.id))
    .filter((spell): spell is RankedSpell => spell !== undefined && rankChainKey(spell) === key);
  if (chain.length < 2) return id;
  const lower = lowerRankSpells(chain);
  if (!lower.has(id)) return id;
  const top = chain.find((spell) => !lower.has(spell.id));
  return top?.id ?? id;
}

export function showSpells(): void {
  spellbookList.replaceChildren();
  spellButtons.clear();
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
    && spellMetadataSettledWorld !== world && game.spells.size === 0
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
  // A tab the character has no spell in at all cannot stay selected: the strip would not draw it,
  // and the book would sit on «В этой вкладке нет активных заклинаний» with nothing on the screen
  // to press to get out of it. General is the fallback because the original book always has it.
  if (spellbookTab === undefined || !counts.has(spellbookTab)) {
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
  });
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

/** `SchoolMask`, one bit per school, in the order `SPELL_SCHOOL_*` runs. */
const SCHOOL_NAMES = ["физический", "свет", "огонь", "природа", "лед", "тьма", "тайная магия"];

/**
 * Seconds with one decimal only when there is one, so 1500 ms reads «1,5» and 3000 reads «3».
 *
 * The comma is not decoration: every string on this screen is Russian and a decimal point in the
 * middle of one reads as a full stop. `toFixed` has no locale.
 */
const seconds = (milliseconds: number): string =>
  (milliseconds / 1000).toFixed(milliseconds % 1000 ? 1 : 0).replace(".", ",");

/** `SpellRange.Flags` 1: the row is the melee reach rather than a distance. Only row 2 carries it. */
const SPELL_RANGE_FLAG_MELEE = 1;

/**
 * The yards `SpellRange` writes for «anywhere», which are not yards.
 *
 * Two of the 65 rows carry it — 13 «Anywhere» and 173 «Anywhere (Combat Min Range)» — and no other
 * row in the table reaches four digits except 174's «U L T R A» thousand. 59 of the 7,369 spells
 * that reach the book resolve to row 13, 30 of them through a `SkillLineAbility` row with a
 * `ClassMask`, so they are in somebody's book: «Око Килрогга» (126), «Звериный глаз» (1002),
 * «Орлиный глаз» (6197), «Дальнее зрение» (6196), «Хватка смерти» (49575), the three ranks of the
 * mage's «Окоченение» (12484-12486). None of the 59 is marked passive, so all of them printed the
 * sentinel with «Мгновенное» under it.
 */
const UNLIMITED_RANGE = 50000;

/**
 * «Радиус действия: N м», or the two cases where the client writes words instead of a number.
 *
 * The strings are the ruRU client's own, out of `Interface\FrameXML\GlobalStrings.lua`:
 * `MELEE_RANGE` (:4919), `SPELL_RANGE` (:7234) and `SPELL_RANGE_UNLIMITED` (:7237). Neither
 * special case is rare — 544 book spells resolve to row 2 («Удар героя» 78, «Удар щитом» 72,
 * «Удар в спину» 53) and 59 to row 13 — and printing the number gave «Дальность: 5 м» for a melee
 * swing and «Дальность: 50000 м» for a spell that has no range at all.
 *
 * `SPELL_RANGE_DUAL` (:7236, «Радиус действия (%1$s): %2$s м») is what the client prints for the
 * 28 book rows with a minimum — «Рывок» is 8-25 — but nothing on this machine says what its first
 * argument holds, so the pair keeps the single string's shape rather than a guessed one.
 */
function rangeLine(metadata: SpellMetadata): string | undefined {
  if ((metadata.rangeFlags & SPELL_RANGE_FLAG_MELEE) !== 0) return "Дистанция ближнего боя";
  if (metadata.rangeMax >= UNLIMITED_RANGE) return "Неограниченное расстояние";
  if (metadata.rangeMax <= 0) return undefined;
  return metadata.rangeMin > 0
    ? `Радиус действия: ${metadata.rangeMin}-${metadata.rangeMax} м`
    : `Радиус действия: ${metadata.rangeMax} м`;
}

/**
 * «Затраты: N», which for a caster is not in the spell's own row.
 *
 * `ManaCost` is zero on 6,728 of the 7,369 spells that reach the book, and 1,543 of those price
 * themselves as a percentage in `ManaCostPct` instead — so before this line existed the cost was
 * missing from *every* spell a mage, a priest, a warlock, a druid or a shaman owns. No row on this
 * dataset carries both, so the two are alternatives and not summands.
 *
 * The base the percentage multiplies is the caster's, as `Spell::CalcPowerCost` has it:
 * `GetCreateMana()` — `UNIT_FIELD_BASE_MANA` — for a mana spell and `GetCreateHealth()` for a
 * health one. Of the 1,543 percentage rows in the book 1,530 are mana, 12 are health and one is
 * runes; the last is left as a percentage rather than guessed at. Rage and runic power are stored
 * ten times what they read (`POWER_DISPLAY_SCALE`), which is why «Удар героя» costs 150 in the
 * table and 15 on the screen.
 */
function powerCostLine(metadata: SpellMetadata): string | undefined {
  const scale = POWER_DISPLAY_SCALE[metadata.powerType] ?? 1;
  if (metadata.powerCost > 0) return `Затраты: ${Math.round(metadata.powerCost / scale)}`;
  if (metadata.powerCostPercent <= 0) return undefined;
  const base = basePower(metadata.powerType);
  return base === undefined
    ? `Затраты: ${metadata.powerCostPercent}%`
    : `Затраты: ${Math.floor(base * metadata.powerCostPercent / 100 / scale)}`;
}

/** The player's own create-time pool, which is what a percentage cost is taken from. */
function basePower(powerType: number): number | undefined {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined
    : world.state.objects.get(world.state.selfGuid);
  if (!self) return undefined;
  if (powerType === POWER.mana) return readField(self, "UNIT_FIELD_BASE_MANA");
  // `POWER_HEALTH` is −2 in the core's enum and in this column, and it is the warlock's twelve.
  if (powerType === -2) return readField(self, "UNIT_FIELD_BASE_HEALTH");
  return undefined;
}

/** Name a reagent from the session before falling back to the honest unnamed label. */
function reagentName(itemId: number): string {
  const world = game.world;
  return world?.itemTemplate(itemId)?.name
    ?? game.itemMetadata?.get(itemId)?.name
    ?? unknownLabel("предмет", itemId);
}

function durationLine(milliseconds: number): string | undefined {
  if (!(milliseconds > 0)) return undefined;
  const total = Math.round(milliseconds / 1000);
  if (total >= 3600) return `Длительность: ${Math.ceil(total / 3600)} ч`;
  if (total >= 60) return `Длительность: ${Math.ceil(total / 60)} мин`;
  return `Длительность: ${seconds(milliseconds)} с`;
}

/** Name, rank, what it costs and what it does — the reason a spellbook is worth opening. */
export function spellTooltip(spellId: number): TooltipContent {
  const metadata = game.spells.get(spellId);
  if (!metadata) return { title: unknownLabel("заклинание", spellId), footer: ["Описание загружается…"] };
  const lines: Array<string | TooltipLine> = [];
  if (metadata.rank) lines.push(metadata.rank);
  const school = SCHOOL_NAMES.filter((_, bit) => (metadata.schoolMask & (1 << bit)) !== 0);
  if (school.length > 0) lines.push(`Школа: ${school.join(", ")}`);
  const range = rangeLine(metadata);
  if (range) lines.push(range);
  if (!metadata.passive) {
    lines.push(metadata.castTime > 0 ? `Сотворение: ${seconds(metadata.castTime)} с` : "Мгновенное");
  }
  const cost = powerCostLine(metadata);
  if (cost) lines.push(cost);
  const cooldown = Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime);
  if (cooldown > 0) lines.push(`Восстановление: ${seconds(cooldown)} с`);
  const duration = durationLine(metadata.duration);
  if (duration) lines.push({ text: duration, tone: "muted" });
  const radius = Math.max(0, ...(metadata.effectRadius ?? []));
  if (radius > 0) lines.push({ text: `Радиус поражения: ${radius} м`, tone: "muted" });
  if (metadata.procChance > 0 && metadata.procChance < 100) {
    lines.push({ text: `Шанс срабатывания: ${metadata.procChance}%`, tone: "muted" });
  }
  if (metadata.reagents && metadata.reagents.length > 0) {
    const parts = metadata.reagents.map((reagent) => reagent.count > 1
      ? `${reagentName(reagent.itemId)} ×${reagent.count}` : reagentName(reagent.itemId));
    lines.push({ text: `Реагенты: ${parts.join(", ")}`, tone: "gold" });
  }
  if (metadata.requiredToolNames && metadata.requiredToolNames.length > 0) {
    lines.push({ text: `Инструмент: ${metadata.requiredToolNames.join(", ")}`, tone: "muted" });
  }
  if (metadata.requiredTargetMode === GROUND_TARGET_MODE) {
    lines.push({ text: "Цель: точка на земле", tone: "spell" });
  }
  if (metadata.passive) lines.push("Пассивное");
  // A description out of `Spell.dbc` is a template, not a sentence: «$s1 ед. урона» is what
  // 22,599 of them look like, and every one of those markers used to reach the tooltip intact.
  // It is also the spell's main body copy, not an interaction hint: keeping it in the footer made
  // long Russian text as small and muted as «Перетащите на панель команд».
  const description = formatSpellDescription(metadata.description, metadata, spellDescriptionContext());
  if (description) lines.push({ text: description, tone: "description" });
  return {
    title: metadata.name,
    lines,
    footer: metadata.passive ? undefined : ["Перетащите на панель команд"],
  };
}

/**
 * The ruRU client's own words for the stock spell tooltip's rows, line for line out of
 * `Interface\FrameXML\GlobalStrings.lua`. The generated table (`tools/generate-global-strings.mjs`)
 * takes the `ITEM_*`, `INVTYPE_*` and `SPELL_FAILED_*` families and a named few, none of these, so
 * the same line of the same file stands in; a locale the generator does learn wins over it.
 * `SPELL_TOTEMS` is written `"Инструменты:\32"` there, `\32` being Lua's escape for the space.
 */
const STOCK_SPELL_STRINGS: Readonly<Record<string, string>> = {
  MANA_COST: "Мана: %d", // :4892
  RAGE_COST: "Ярость: %d", // :5938
  FOCUS_COST: "Тонус: %d", // :3713
  ENERGY_COST: "Энергия: %d", // :2816
  RUNIC_POWER_COST: "Требуется %d |4единица:единицы:единиц; силы рун", // :6162
  HEALTH_COST: "Здоровье: %d", // :4011
  SPELL_CAST_TIME_INSTANT: "Мгновенное действие", // :6919
  SPELL_CAST_CHANNELED: "Потоковое", // :6915
  SPELL_ON_NEXT_SWING: "Следующая атака", // :7222
  SPELL_CAST_TIME_SEC: "Применение: %.3g сек.", // :6923
  SPELL_CAST_TIME_MIN: "применение заклинания: %.3g мин.", // :6921
  SPELL_RECAST_TIME_SEC: "Восстановление: %.3g сек.", // :7241
  SPELL_RECAST_TIME_MIN: "Восстановление: %.3g мин.", // :7240
  SPELL_REAGENTS: "Реагенты: |n", // :7238
  SPELL_TOTEMS: "Инструменты: ", // :7321
};

const stockSpellString = (key: string): string => globalString(key) ?? STOCK_SPELL_STRINGS[key] ?? "";

/** C's `%.3g`, which is how the client writes a cast or a cooldown: 1.5, 2.5, 3, 10, 120. */
const threeDigits = (value: number): string => String(Number(value.toPrecision(3)));

/** The cost row's word per `Powers` value; −2 is the core's `POWER_HEALTH`. Runes have none here. */
const STOCK_POWER_COST_KEYS: Readonly<Record<number, string>> = {
  [POWER.mana]: "MANA_COST", [POWER.rage]: "RAGE_COST", [POWER.focus]: "FOCUS_COST",
  [POWER.energy]: "ENERGY_COST", [POWER.runicPower]: "RUNIC_POWER_COST", [-2]: "HEALTH_COST",
};

/**
 * «Мана: 320», the stock cost row's left half: the same amount `powerCostLine` works out, under the
 * power's own word instead of the native «Затраты».
 */
function stockPowerCost(metadata: SpellMetadata): string | undefined {
  const key = STOCK_POWER_COST_KEYS[metadata.powerType];
  if (key === undefined) return undefined;
  const scale = POWER_DISPLAY_SCALE[metadata.powerType] ?? 1;
  let amount: number | string | undefined;
  if (metadata.powerCost > 0) amount = Math.round(metadata.powerCost / scale);
  else if (metadata.powerCostPercent > 0) {
    const base = basePower(metadata.powerType);
    amount = base === undefined ? `${metadata.powerCostPercent}%`
      : Math.floor(base * metadata.powerCostPercent / 100 / scale);
  }
  return amount === undefined ? undefined : fillTemplate(stockSpellString(key), amount);
}

/** A cast or a recovery in the client's two units: seconds under a minute, minutes from one up. */
function stockTime(milliseconds: number, secondsKey: string, minutesKey: string): string {
  return milliseconds >= 60_000
    ? stockSpellString(minutesKey).replace("%.3g", threeDigits(milliseconds / 60_000))
    : stockSpellString(secondsKey).replace("%.3g", threeDigits(milliseconds / 1000));
}

/**
 * The spell as the stock `GameTooltip` draws it in 3.3.5, for the FrameXML HUD.
 *
 * The native {@link spellTooltip} lists one fact per line, which suits the spellbook's own box and
 * stays as it is. The original pairs them instead: the name with the rank right-aligned in grey,
 * the cost with the range, the cast time with the cooldown, and then the description as wrapped
 * gold prose. Duration, radius and proc chance are not rows of their own there — the description
 * says them — and neither is the school, which the native box alone prints. The description keeps
 * its `description` tone because the aura tooltip picks it out by that tone.
 *
 * The cast row is the `SpellAttributes` bits first, then the time: an on-next-swing strike
 * («Удар героя») reads «Следующая атака» and a channelled spell («Чародейские стрелы», cast time
 * 0 on 1,745 of the dataset's 1,961 channels) «Потоковое», before a cast time or «Мгновенное
 * действие» is considered. A gateway that predates those bits (`onNextSwing`/`channeled` absent)
 * gets the time rows it got before.
 *
 * `aura: true` is the buff bar's tooltip: the same rows with the spell's `AuraDescription` as the
 * gold prose, which is what the 3.3.5 client shows on a buff or debuff, and the cast description
 * when the row has none or the gateway serves none.
 */
export function stockSpellTooltip(spellId: number, options?: { readonly aura?: boolean }): TooltipContent {
  const metadata = game.spells.get(spellId);
  if (!metadata) return { title: unknownLabel("заклинание", spellId), footer: ["Описание загружается…"] };
  const lines: TooltipLine[] = [];
  const pair = (left: string | undefined, right: string | undefined): void => {
    if (!left && !right) return;
    lines.push(right ? { text: left ?? "", right } : { text: left ?? "" });
  };
  pair(stockPowerCost(metadata), rangeLine(metadata));
  const cooldown = Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime);
  pair(
    metadata.passive ? undefined
      : metadata.onNextSwing === true ? stockSpellString("SPELL_ON_NEXT_SWING")
        : metadata.channeled === true ? stockSpellString("SPELL_CAST_CHANNELED")
          : metadata.castTime > 0
            ? stockTime(metadata.castTime, "SPELL_CAST_TIME_SEC", "SPELL_CAST_TIME_MIN")
            : stockSpellString("SPELL_CAST_TIME_INSTANT"),
    cooldown > 0 ? stockTime(cooldown, "SPELL_RECAST_TIME_SEC", "SPELL_RECAST_TIME_MIN") : undefined,
  );
  if (metadata.reagents && metadata.reagents.length > 0) {
    const parts = metadata.reagents.map((reagent) => reagent.count > 1
      ? `${reagentName(reagent.itemId)} ×${reagent.count}` : reagentName(reagent.itemId));
    // `|n` is the client's line break; the list stays on the label's line, as the native box has it.
    lines.push({ text: `${stockSpellString("SPELL_REAGENTS").replace(/\|n\s*$/, "")}${parts.join(", ")}` });
  }
  if (metadata.requiredToolNames && metadata.requiredToolNames.length > 0) {
    lines.push({ text: `${stockSpellString("SPELL_TOTEMS")}${metadata.requiredToolNames.join(", ")}` });
  }
  // The aura text uses the same `$` markers as the description (`$s1`, `$t2`, `$42208s1`), so it
  // goes through the same formatter.
  const prose = options?.aura && metadata.auraDescription ? metadata.auraDescription : metadata.description;
  const description = formatSpellDescription(prose, metadata, spellDescriptionContext());
  if (description) lines.push({ text: description, tone: "description", wrap: true });
  return metadata.rank ? { title: metadata.name, titleRight: metadata.rank, lines } : { title: metadata.name, lines };
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
  if (button.title !== label) button.title = label;
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  const ariaDisabled = String(disabled);
  if (button.getAttribute("aria-disabled") !== ariaDisabled) {
    button.setAttribute("aria-disabled", ariaDisabled);
  }
}

export function castSpell(spellId: number, explicitUnitTarget?: bigint): boolean {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return false;
  const profession = game.spells.get(spellId);
  // A named macro target is safe only for the DBC shapes the gateway has classified as a single
  // direct unit. Ground/item/mixed casts still use their own selection flow.
  if (explicitUnitTarget !== undefined
    && (profession?.unitTargetContractVersion !== 1 || profession.supportsExplicitUnitTarget !== true)) {
    return false;
  }
  if (explicitUnitTarget !== undefined) {
    const object = world.state.objects.get(explicitUnitTarget);
    if (object?.typeId !== 3 && object?.typeId !== 4) return false;
  }
  if (professionOpener(profession) && profession) {
    const skill = professionSpellSkill(profession, game.talentData);
    return skill !== undefined && openProfession(skill);
  }
  // Attack is a client action, not a learned spell. Trinity does not normally include row 6603 in
  // INITIAL_SPELLS, and it has no metadata preflight: WorldClient maps it to ATTACK_SWING/STOP.
  if (spellId === MELEE_AUTO_ATTACK_SPELL_ID) {
    world.castSpell(spellId);
    return true;
  }
  // Reapplying the active mount is a dismount toggle, not a new spell cast. It must remain
  // clickable while the old mount's recovery or the global cooldown is still visible locally.
  const togglingMount = typeof world.isActiveMountSpell === "function"
    && world.isActiveMountSpell(spellId);
  if (!togglingMount && world.cooldownRemaining(spellId, performance.now()) > 0) return false;
  const metadata = game.spells.get(spellId);
  if (!world.knownSpells.some((spell) => spell.id === spellId)) return false;
  if (!metadata) {
    const message = "Данные заклинания загружаются…";
    spellStatus.className = "muted";
    spellStatus.textContent = message;
    notice(message, "info");
    return false;
  }
  if (!spellButtonUsable(metadata)) {
    const message = "Пассивное заклинание нельзя применить";
    spellStatus.className = "error";
    spellStatus.textContent = message;
    notice(message);
    return false;
  }
  // The book, tracker, talent window and module actions share the same local preflight. WorldClient
  // intentionally cannot inspect DBC/UI metadata, so it must only handle the final wire request.
  if (spellCastBlockReason(world, spellId) !== undefined) return false;
  // Area spells do not take the selection: arm the reticle and let the click choose the point.
  // Every guard above has already passed, so the targeting mode never opens for a blocked cast.
  if (isGroundTargetSpell(metadata)) {
    if (!beginGroundTarget(spellId)) return false;
    notice("Кликните по земле для выбора точки · правый клик или Esc — отмена", "info");
    return true;
  }
  const cooldown = Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime);
  // The world matches the request and emits SPELL_CAST_ACCEPTED only after the realm accepts it.
  // GCD bookkeeping is bound once when the world is entered; a per-click listener could survive a
  // failure and fire for a later cast of the same spell.
  if (explicitUnitTarget === undefined) world.castSpell(spellId, cooldown, metadata.cooldownStartedOnEvent);
  else world.castSpell(spellId, cooldown, metadata.cooldownStartedOnEvent, explicitUnitTarget);
  return true;
}

export async function loadSpellMetadata(world: WorldClient): Promise<void> {
  const client = game.spellMetadataClient;
  if (!client) return;
  const epoch = spellMetadataEpoch();
  if (!isCurrentSpellMetadataRequest(world, client, epoch)) return;
  spellMetadataSettledWorld = undefined;
  try {
    const known = await client.load(world.knownSpells.map((spell) => spell.id));
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    for (const [id, metadata] of known) game.spells.set(id, metadata);
    // Mount classification belongs to the world client: the book, action bar, tracking window and
    // module actions all eventually call the same `WorldClient.castSpell` entry point.
    syncMountSpellIds(world);
    // WotLK descriptions legitimately point at a base/rank row that is not in the character's
    // known-spell list (`$21084d` in Seal of Righteousness). Fetch those rows as well so the live
    // context can resolve the marker instead of leaving an otherwise answerable duration visible.
    const referenced = new Set<number>();
    for (const metadata of known.values()) {
      for (const match of metadata.description.matchAll(/\$(\d+)[a-zA-Z]\d?/g)) {
        const id = Number(match[1]);
        if (Number.isSafeInteger(id) && id > 0 && !game.spells.has(id)) referenced.add(id);
      }
    }
    const loadedReferences = await client.load([...referenced]);
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    for (const [id, metadata] of loadedReferences) game.spells.set(id, metadata);
    syncMountSpellIds(world);
    spellMetadataSettledWorld = world;
    if (game.world === world) showSpells();
  } catch (error) {
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    // A failed known-spell batch must not discard a classification that another loader already
    // supplied (for example the action bar or aura strip landing first).
    syncMountSpellIds(world);
    spellMetadataSettledWorld = world;
    // Repaint before writing the error: the guard above no longer blanks the book for a missing
    // row, but a repaint suppressed before this call would otherwise leave the page stale until
    // some unrelated event. The message goes back on top afterwards.
    if (game.world === world) showSpells();
    spellStatus.className = "error";
    spellStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

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
    const gcdDuration = metadata?.startRecoveryTime ?? 0;
    // Keep the denominator stable. Deriving it from `remaining` on every frame makes the overlay
    // look stuck until it vanishes; WorldClient's snapshot preserves the real server/local window.
    const ownDuration = cooldownDuration(
      metadata?.recoveryTime, metadata?.categoryRecoveryTime,
    );
    const view = cooldownView(
      now, own, ownDuration,
      gcdDuration > 0 ? Math.max(0, game.globalCooldownUntil - now) : 0,
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
}
