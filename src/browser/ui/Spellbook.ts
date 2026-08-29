import { MELEE_AUTO_ATTACK_SPELL_ID, WorldClient } from "../../world/WorldClient.js";
import { POWER, POWER_DISPLAY_SCALE, attackPower, readField } from "../../world/Fields.js";
import { game } from "../game/Context.js";
import { spellButtonUsable, type SpellMetadata } from "../SpellMetadata.js";
import { syncMountSpellIds } from "../MountSpells.js";
import { spellCastBlockReason } from "../SpellCastGuard.js";
import { isCurrentSpellMetadataRequest, spellMetadataEpoch } from "./SpellNames.js";
import {
  spellStatus, spellbookHideRanks, spellbookList, spellbookSearch, spellbookTabs, spellbookWindow,
} from "./Dom.js";
import { lowerRankSpells, type RankedSpell } from "./SpellRanks.js";
import { skinnable, slotElement, slotSiblings } from "./Slots.js";
import { actionDragPayload } from "./ActionBar.js";
import {
  attachTooltip, cooldownDuration, cooldownLabel, cooldownView,
  type TooltipContent,
} from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { unknownLabel } from "./Format.js";
import { formatSpellDescription, type SpellDescriptionContext } from "./SpellText.js";
import { notice } from "./Notices.js";

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
 * The blur is the half that matters, and it is not decoration. `Controls.onKeyDown`
 * (`input/Controls.ts:91-99`) returns on the first line for any focused input that is not the chat
 * box, so while the caret sits here Escape never reaches `backOut()`, and W/A/S/D and the action
 * bar's digits are typed into the search box instead of moving the character. Clearing the text
 * without releasing the focus left exactly that: the book could not be closed, the game menu could
 * not be opened, and the way out was the mouse. Letting go on the first press means the second one
 * reaches `Controls` and closes the book, which is what Escape did before there was a box here.
 *
 * The chat box has had this since it was written — `Controls.ts:95-96` clears and blurs `chatInput`
 * for the same reason, in the same two lines — and this is that pair, on this side of the fence.
 * Handled here rather than in `Controls` because `input/` belongs to another lane and this is the
 * book's own field.
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
  spellbookTab = undefined;
  spellbookQuery = "";
  spellbookSearch.value = "";
  drawSpellbookTabs([]);
  spellbookList.replaceChildren();
  spellButtons.clear();
}

/** The paged spell book, its cooldown sweeps and casting from it. */

/**
 * Whether a spell the server says the character knows belongs in the book.
 *
 * The server does not decide this and is not meant to: `Player::SendInitialSpells` sends every
 * spell in `m_spells` that is active and not disabled, and looks at no attribute at all. Which of
 * them a player sees is the client's judgement, and the real client makes it on two things.
 *
 * **The invisible bit, not the passive one.** `SPELL_ATTR0_HIDDEN_CLIENTSIDE` (0x80) is the flag
 * whose whole meaning is "not visible in spellbook or aura bar". The passive bit (0x40) means
 * something else entirely, and `SpellBookFrame.lua` proves it: a passive spell is drawn, in grey,
 * with the passive highlight. Filtering on passive was wrong in both directions — it hid 159
 * spells the real book lists (Dodge, Block, Parry, Dual Wield, every racial passive) and kept
 * 3,669 that are marked invisible.
 *
 * **And membership of a skill line.** A tab in the real book is a `SkillLine`, and a spell with no
 * `SkillLineAbility` row belongs to no tab and cannot appear. That is what removes the creature
 * spells, the quest triggers, the item procs and the visual-only rows — 40,123 of 49,842 on this
 * dataset. Together the two rules take the corpus from 49,842 to 7,369, and every "(DND)" row,
 * every "Visual", and every "Generic" name goes with them.
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
  const line = game.talentData?.skillOfSpell(id);
  // No skill data yet is not the same answer as "no skill line": until the table lands nothing can
  // be judged, and hiding everything would empty the book on the way in.
  if (game.talentData && (line === undefined || line <= 0)) return false;
  return true;
}

/** `SkillLine` 183, "GENERIC (DND)" in the table and "Общий" on the screen. */
const SKILL_LINE_GENERIC = 183;

/**
 * Everything the rank predicate needs about a spell, or undefined while its row is in flight.
 *
 * A spell whose metadata has not landed is never a candidate for hiding: without a name, a family
 * and a level there is nothing to compare it to, and a book that hid rows while it loaded would be
 * the same defect `belongsInSpellbook` avoids at the other end.
 */
function rankedSpell(id: number): RankedSpell | undefined {
  const metadata = game.spells.get(id);
  const skillLine = game.talentData?.skillOfSpell(id);
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

export function showSpells(): void {
  spellbookList.replaceChildren();
  spellButtons.clear();
  const world = game.world;
  const known = world?.knownSpells.filter((spell) => belongsInSpellbook(spell.id)) ?? [];
  // A tab the character has no spell in at all cannot stay selected: the strip would not draw it,
  // and the book would sit on «В этой вкладке нет активных заклинаний» with nothing on the screen
  // to press to get out of it.
  if (spellbookTab !== undefined && !known.some((spell) => game.talentData?.skillOfSpell(spell.id) === spellbookTab)) {
    spellbookTab = undefined;
  }
  // Tabs come from the unfiltered list, and so does the count on each of them. The strip is sorted
  // by how many spells a line holds, so counting the *shown* spells would reshuffle the whole thing
  // the moment the rank switch was flipped.
  drawTabs(known.map((spell) => spell.id));
  const inTab = spellbookTab === undefined
    ? known
    : known.filter((spell) => (game.talentData?.skillOfSpell(spell.id) ?? 0) === spellbookTab);

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
      : `${activeSpells.length} активных заклинаний`;
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

/**
 * One tab per skill line the character actually has spells in, plus "all".
 *
 * Built from the spells rather than from the class: a hunter's pet abilities, a profession picked
 * up at level five and a racial all live in their own lines, and listing the class's three talent
 * trees would miss every one of them.
 */
function drawTabs(spellIds: readonly number[]): void {
  const talents = game.talentData;
  // Both branches draw, since a book whose skill lines have not landed still has a tab strip a
  // module may have put a tab into (М7) — and the host itself is out of the redraw either way.
  if (!talents?.ready) {
    drawSpellbookTabs([]);
    return;
  }
  const lines = new Map<number, number>();
  for (const id of spellIds) {
    const line = talents.skillOfSpell(id);
    if (line === undefined) continue;
    lines.set(line, (lines.get(line) ?? 0) + 1);
  }

  const tabs: HTMLElement[] = [tabButton("Все", spellbookTab === undefined, undefined, spellIds.length)];
  // SkillLine 183 is where "Attack" and the other everyone-has-them spells live, and the table
  // names it "GENERIC (DND)" — a developer's label that the real client never shows: it calls the
  // tab GENERAL. Every character had that string on a tab in their spellbook.
  const named = [...lines].map(([line, count]) => ({
    line,
    count,
    name: line === SKILL_LINE_GENERIC ? "Общий" : talents.skillLine(line)?.name ?? `Навык ${line}`,
  }));
  named.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  for (const entry of named) tabs.push(tabButton(entry.name, spellbookTab === entry.line, entry.line, entry.count));
  drawSpellbookTabs(tabs);
}

function tabButton(label: string, active: boolean, line: number | undefined, count: number): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "spellbook-tab is-active" : "spellbook-tab";
  button.textContent = `${label} (${count})`;
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

/** Name, rank, what it costs and what it does — the reason a spellbook is worth opening. */
export function spellTooltip(spellId: number): TooltipContent {
  const metadata = game.spells.get(spellId);
  if (!metadata) return { title: unknownLabel("заклинание", spellId), footer: ["Описание загружается…"] };
  const lines: string[] = [];
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
  if (metadata.passive) lines.push("Пассивное");
  return {
    title: metadata.name,
    lines,
    // A description out of `Spell.dbc` is a template, not a sentence: «$s1 ед. урона» is what
    // 22,599 of them look like, and every one of those markers used to reach the tooltip intact.
    footer: [formatSpellDescription(metadata.description, metadata, spellDescriptionContext()), metadata.passive ? "" : "Перетащите на панель команд"].filter(Boolean),
  };
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
  const disabled = !usable || (!togglingMount && remaining > 0);
  const base = metadata?.name ?? unknownLabel("заклинание", spellId);
  const label = !usable && metadata?.passive ? `${base} · пассивное`
    : togglingMount ? `${base} · Снять маунта`
      : remaining > 0 ? `${base} · Восстанавливается` : base;
  button.disabled = disabled;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-disabled", String(disabled));
}

export function castSpell(spellId: number): boolean {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return false;
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
  const cooldown = Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime);
  // The world matches the request and emits SPELL_CAST_ACCEPTED only after the realm accepts it.
  // GCD bookkeeping is bound once when the world is entered; a per-click listener could survive a
  // failure and fire for a later cast of the same spell.
  world.castSpell(spellId, cooldown, metadata.cooldownStartedOnEvent);
  return true;
}

export async function loadSpellMetadata(world: WorldClient): Promise<void> {
  const client = game.spellMetadataClient;
  if (!client) return;
  const epoch = spellMetadataEpoch();
  if (!isCurrentSpellMetadataRequest(world, client, epoch)) return;
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
    if (game.world === world) showSpells();
  } catch (error) {
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    // A failed known-spell batch must not discard a classification that another loader already
    // supplied (for example the action bar or aura strip landing first).
    syncMountSpellIds(world);
    spellStatus.className = "error";
    spellStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

export function updateSpellCooldowns(now: number): void {
  const world = game.world;
  if (!world) return;
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
    for (const elements of copies) {
      setSpellButtonState(elements.button, spellId, metadata, view.remaining);
      elements.button.classList.toggle("cooling", view.remaining > 0);
      elements.cooldown.hidden = view.remaining <= 0;
      elements.cooldown.style.setProperty("--sweep", `${view.fraction * 360}deg`);
      elements.cooldown.textContent = cooldownLabel(view.remaining);
    }
  }
}
