import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { readField, unit } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import {
  characterCollectionsPane, characterCombatPets, characterCompanions, characterIdentity,
  characterMounts, characterSheetPane, characterSkillsPane, characterStats, characterTabCollections,
  characterTabSheet, characterTabSkills, characterTabs, characterWindow, equipmentSlots,
} from "./Dom.js";
import { formatMoney, formatPlayed, reputationRank } from "./Format.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { showProfessions } from "./Professions.js";
import { skinnable, slotElement, slotSiblings } from "./Slots.js";
import { setTip, textLine } from "./Widgets.js";
import { toggleReputation } from "./Reputation.js";
import { frameXmlReputationBase } from "../framexml/FrameXmlReputationResolver.js";
import { className, raceName } from "./UnitSnapshot.js";
import { stablePetRows } from "./StableControls.js";
import { frameXmlStablePublished } from "../framexml/FrameXmlStableController.js";
import { requestSpellCast } from "../game/GroundTarget.js";
import {
  PLAYER_FLAGS_HIDE_CLOAK, PLAYER_FLAGS_HIDE_HELM, SKILL_DEFENSE, showingCloak, showingHelm, unitHasMana,
} from "../../world/CharacterStatFields.js";
import { isCharacterStatCatalog, type CharacterStatCatalog } from "../../world/CharacterStatData.js";
import { characterStatSections, titleChoices, type SheetRow, type SheetSection } from "./CharacterSheetModel.js";
import { readSkills } from "./Skills.js";
import { nativeString } from "./Strings.js";
import { createLiveFrameXmlTitles } from "../framexml/FrameXmlTitlesLive.js";
import { FrameXmlCurrencyCatalogClient, createLiveFrameXmlCurrency } from "../framexml/FrameXmlCurrencyLive.js";
import type { FrameXmlCurrencyModel } from "../framexml/FrameXmlCurrency.js";
import { frameXmlClassHasRelicSlot } from "../framexml/FrameXmlRelicSlot.js";
import type { WorldClient } from "../../world/WorldClient.js";

/**
 * The character sheet: what the character is made of, beyond the health bar.
 *
 * Most of this has always been in the update fields and was never read — five stats, seven
 * resistances, the melee numbers — and the rest arrives in packets the world loop used to drop:
 * reputation, played time, titles, talent points.
 */
/** `SPELL_SCHOOL` order, and the first of them is armour rather than a resistance. */
const RESISTANCE_NAMES = ["Броня", "Свет", "Огонь", "Природа", "Лёд", "Тьма", "Тайная магия"];

/** Inventory slot 17 (zero-based), the ranged slot whose item the stock ranged rows test (slot 18 in Lua). */
const RANGED_EQUIPMENT_SLOT = 17;

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

/**
 * 4.03: the sheet's three controls — «Отображать шлем», «Отображать плащ» and the title picker.
 *
 * They live outside the box `drawStats` rebuilds every frame, for the reason the slot hosts above do:
 * a control removed and re-inserted sixty times a second loses focus, and an open `<select>` closes.
 * They are written only when what they show moved (see `syncSheetControls`), so a click is not
 * overwritten by the old field value in the frames before the realm's answer arrives.
 */
function checkboxRow(label: string): { row: HTMLLabelElement; box: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = "sheet-toggle";
  const box = document.createElement("input");
  box.type = "checkbox";
  const text = document.createElement("span");
  text.textContent = label;
  row.append(box, text);
  return { row, box };
}

const sheetControls = document.createElement("section");
sheetControls.className = "sheet-section sheet-controls";
sheetControls.hidden = true;
const helmToggle = checkboxRow(nativeString("SHOW_HELM", "Отображать шлем"));
const cloakToggle = checkboxRow(nativeString("SHOW_CLOAK", "Отображать плащ"));
const titleRow = document.createElement("label");
titleRow.className = "sheet-title-picker";
titleRow.hidden = true;
const titleLabel = document.createElement("span");
titleLabel.textContent = "Звание";
const titleSelect = document.createElement("select");
titleRow.append(titleLabel, titleSelect);
sheetControls.append(helmToggle.row, cloakToggle.row, titleRow);
/**
 * Wow.exe's ShowHelm/ShowCloak (0x006e0e00/0x006dd0f0, 0x006e0ef0/0x006dd1b0) send CMSG_SHOWING_HELM/
 * CLOAK only when the player's flag says otherwise, and write no flag locally: the realm's answer does.
 */
function sendShowing(part: "helm" | "cloak", show: boolean): void {
  const world = game.world;
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world?.state.objects.get(guid);
  if (!world) return;
  if (self && (part === "helm" ? showingHelm(self) : showingCloak(self)) === show) return;
  if (part === "helm") world.setShowingHelm(show);
  else world.setShowingCloak(show);
}
helmToggle.box.addEventListener("change", () => sendShowing("helm", helmToggle.box.checked));
cloakToggle.box.addEventListener("change", () => sendShowing("cloak", cloakToggle.box.checked));
characterSheetPane.append(sheetControls, characterFooter);

/** The stock title model over the live fields (FrameXmlTitlesLive.ts), shared logic with PlayerTitleFrame. */
const sheetTitles = createLiveFrameXmlTitles({ world: () => game.world, gatewayOrigin: () => game.gatewayOrigin });
titleSelect.addEventListener("change", () => sheetTitles.model.setCurrent(Number(titleSelect.value)));

/**
 * The stock currency model (FrameXmlCurrencyLive.ts) with its own `/dbc/currencies` client, one per
 * world session: the model remembers which item names it already asked for, and a new session's
 * WorldClient has to be asked again.
 */
let sheetCurrency: FrameXmlCurrencyModel | undefined;
let sheetCurrencyCatalog: FrameXmlCurrencyCatalogClient | undefined;

/**
 * What the sheet was last built from. `showCharacterSheet` is reached once a frame while any object
 * update arrives — a city's walkers are enough — and the model, the skills, the currencies, the
 * reputation sort and the signature cost a frame's worth of work for an unchanged sheet. So the
 * inputs are compared first: the player's own fields by a running hash (one pass over the map), the
 * packet-held parts and the fetched tables by identity. A currency's count lives in an item object
 * and a late item or faction name in a cache, neither of them here, so the sheet is also rebuilt once
 * a second while anything keeps asking.
 */
let builtInputs: readonly unknown[] | undefined;
let builtAt = 0;
const SHEET_REFRESH_MS = 1000;

function fieldsHash(fields: ReadonlyMap<number, number>): number {
  let hash = fields.size;
  for (const [index, value] of fields) hash = (Math.imul(hash ^ index, 0x0100_0193) + value) | 0;
  return hash;
}

function sheetInputs(world: WorldClient, self: WorldObjectState): unknown[] {
  let factions = world.factions.size;
  for (const faction of world.factions.values()) {
    factions = (Math.imul(factions ^ faction.listId, 0x0100_0193) + faction.standing + faction.flags * 7) | 0;
  }
  return [world, self, fieldsHash(self.fields), statCatalog, sheetCurrencyCatalog?.current, world.playedTime,
    world.talents, world.talents?.unspentPoints, world.achievements.size, world.titles.size, factions,
    game.factions, game.factions?.reputationCatalog, world.itemTemplates.size];
}

/** What the controls showed last, so they are written only on a change. */
let controlsWorld: WorldClient | undefined;
let shownFlags: number | undefined;
let shownTitles: string | undefined;
/** Per world session: the one-time fetches (titles, currencies, rating tables). */
let preparedWorld: WorldClient | undefined;
let statCatalog: CharacterStatCatalog | undefined;

/** `/dbc/character-stats?version=2` — the rating tables the stock sheet loads (FrameXmlCharacterStats.ts). */
export const CHARACTER_STATS_PATH = "/dbc/character-stats?version=2";

function prepareSheet(world: WorldClient): void {
  if (preparedWorld === world) return;
  preparedWorld = world;
  statCatalog = undefined;
  void sheetTitles.prepare();
  const origin = game.gatewayOrigin;
  sheetCurrency = undefined;
  if (!origin) return;
  sheetCurrency = createLiveFrameXmlCurrency({
    world: () => game.world,
    // Item names arrive by CMSG_ITEM_QUERY_SINGLE; WorldClient asks once per entry.
    prefetchQuestMetadata: (itemIds) => { for (const id of itemIds) game.world?.itemTemplate(id); },
  });
  sheetCurrencyCatalog = new FrameXmlCurrencyCatalogClient(origin);
  sheetCurrency.catalogSource = sheetCurrencyCatalog;
  // Fetched once per world; the browser cache already holds the stock mount's answer when it ran.
  void fetch(new URL(CHARACTER_STATS_PATH, origin).href).then(async (response) => {
    const catalog: unknown = response.ok ? await response.json() : undefined;
    if (preparedWorld === world && isCharacterStatCatalog(catalog)) statCatalog = catalog;
  }).catch(() => { /* without the tables the rating tooltips and the defence row stay out */ });
}

/** Writes the three controls when the flag word or the title picker's inputs moved. */
function syncSheetControls(world: WorldClient | undefined, self: WorldObjectState | undefined): void {
  if (!world || !self) {
    if (!sheetControls.hidden) sheetControls.hidden = true;
    controlsWorld = undefined;
    return;
  }
  if (controlsWorld !== world) {
    controlsWorld = world;
    shownFlags = undefined;
    shownTitles = undefined;
  }
  if (sheetControls.hidden) sheetControls.hidden = false;
  // Only the two hide bits: an AFK or resting edge must not undo a click still awaiting its answer.
  const flags = (readField(self, "PLAYER_FLAGS") ?? 0) & (PLAYER_FLAGS_HIDE_HELM | PLAYER_FLAGS_HIDE_CLOAK);
  if (flags !== shownFlags) {
    shownFlags = flags;
    helmToggle.box.checked = showingHelm(self);
    cloakToggle.box.checked = showingCloak(self);
  }
  // Six known-title words, the worn title, the sex byte (a declined name) and whether the catalog landed.
  const first = UPDATE_FIELDS.PLAYER__FIELD_KNOWN_TITLES.offset;
  let key = `${sheetTitles.model.count()}|${readField(self, "PLAYER_CHOSEN_TITLE") ?? 0}|${unit.gender(self) ?? ""}`;
  for (let index = 0; index < 6; index++) key += `|${self.fields.get(first + index) ?? 0}`;
  if (key === shownTitles) return;
  shownTitles = key;
  const choices = titleChoices(sheetTitles.model);
  titleRow.hidden = choices === undefined;
  if (!choices) {
    titleSelect.replaceChildren();
    return;
  }
  titleSelect.replaceChildren(...choices.options.map((choice) => {
    const option = document.createElement("option");
    option.value = String(choice.value);
    option.textContent = choice.label;
    return option;
  }));
  titleSelect.value = String(choices.current);
}

/** One drawn block of the sheet as data: its rows, a muted heading line, and the reputation button. */
type DrawnRow = SheetRow | { readonly heading: string };
interface DrawnSection {
  readonly title: string;
  readonly key?: SheetSection["key"] | "currency";
  readonly rows: readonly DrawnRow[];
  readonly reputationButton?: boolean;
}

/**
 * What the box showed last. The sheet is asked to draw once a frame while packets arrive
 * (`renderInventory`), and a box rebuilt every frame both costs a frame's worth of DOM work and
 * takes a hovered row — and its tooltip — away under the pointer; so the rows are built as data
 * first and the box is rebuilt only when they read differently.
 */
let drawnSignature: string | undefined;

function signatureOf(sections: readonly DrawnSection[]): string {
  let signature = "";
  for (const entry of sections) {
    signature += `${entry.key ?? ""}${entry.title}${entry.reputationButton ? 1 : 0}`;
    for (const row of entry.rows) {
      signature += "heading" in row ? `#${row.heading}`
        : `${row.label}${row.value}${row.tip ?? ""}${row.tone ?? ""}`;
    }
  }
  return signature;
}

function drawnLine(entry: DrawnRow): HTMLElement {
  if ("heading" in entry) return muted(entry.heading);
  const line = textLine(entry.label, entry.value);
  if (entry.tone) line.classList.add(entry.tone === "buff" ? "is-buff" : "is-debuff");
  if (entry.tip) setTip(line, entry.tip);
  return line;
}

function drawnSection(entry: DrawnSection): HTMLElement {
  const lines = entry.rows.map(drawnLine);
  if (entry.reputationButton) {
    const all = document.createElement("button");
    all.type = "button";
    all.textContent = "Все фракции";
    all.addEventListener("click", () => toggleReputation());
    lines.push(all);
  }
  const block = section(entry.title, lines);
  if (entry.key) block.dataset["sheetSection"] = entry.key;
  return block;
}

/** The currencies the player knows, under their headings, as the stock token list orders them. */
function currencySection(): DrawnSection | undefined {
  if (!sheetCurrency) return undefined;
  sheetCurrency.tick();
  const rows = sheetCurrency.rows();
  if (rows.length === 0) return undefined;
  return {
    title: nativeString("CURRENCY", "Валюта"), key: "currency",
    rows: rows.map((entry) => entry.header ? { heading: entry.name ?? "" } : { label: entry.name ?? "…", value: String(entry.count) }),
  };
}
skinnable("character-window", characterWindow);

export type CharacterTab = "sheet" | "skills" | "collections";

const CHARACTER_TABS: readonly CharacterTab[] = ["sheet", "skills", "collections"];
const tabControls: Readonly<Record<CharacterTab, { button: HTMLButtonElement; pane: HTMLElement }>> = {
  sheet: { button: characterTabSheet, pane: characterSheetPane },
  skills: { button: characterTabSkills, pane: characterSkillsPane },
  collections: { button: characterTabCollections, pane: characterCollectionsPane },
};

/** Stock WotLK SkillLine rows used by the spellbook's companion page. */
export const SKILL_LINE_MOUNTS = 777;
export const SKILL_LINE_COMPANIONS = 778;

let selectedTab: CharacterTab = "sheet";
let tabsWired = false;
let combatPetInputs: readonly unknown[] | undefined;

export function selectedCharacterTab(): CharacterTab {
  return selectedTab;
}

/**
 * Selects one page inside the character window without creating another movable window.
 *
 * `focus` is reserved for keyboard navigation: a mouse click leaves focus where the browser put
 * it, while Arrow/Home/End move both the selected page and the roving tab stop.
 */
export function selectCharacterTab(tab: CharacterTab, focus = false): void {
  selectedTab = tab;
  for (const id of CHARACTER_TABS) {
    const control = tabControls[id];
    const active = id === tab;
    control.button.setAttribute("aria-selected", String(active));
    control.button.tabIndex = active ? 0 : -1;
    control.pane.hidden = !active;
  }
  if (focus) tabControls[tab].button.focus();
  if (tab === "sheet") showCharacterSheet();
  else if (tab === "skills") showProfessions();
  else showCharacterCollections();
}

/** Connects click and standard tab-list keyboard behaviour once, during the normal UI wiring. */
export function wireCharacterTabs(): void {
  if (tabsWired) return;
  tabsWired = true;
  for (const id of CHARACTER_TABS) {
    tabControls[id].button.addEventListener("click", () => selectCharacterTab(id));
  }
  characterTabs.addEventListener("keydown", (event) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const current = CHARACTER_TABS.findIndex((id) => tabControls[id].button === event.target);
    if (current < 0) return;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = (current - 1 + CHARACTER_TABS.length) % CHARACTER_TABS.length;
    else if (event.key === "ArrowRight") next = (current + 1) % CHARACTER_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = CHARACTER_TABS.length - 1;
    if (next === undefined) return;
    selectCharacterTab(CHARACTER_TABS[next] as CharacterTab, true);
    event.preventDefault();
  });
}

/** Draws the collection data already present in the spellbook and pet state. */
export function showCharacterCollections(): void {
  if (characterCollectionsPane.hidden) return;
  const world = game.world;
  if (!world) {
    combatPetInputs = undefined;
    characterMounts.replaceChildren(muted("Нет данных о персонаже."));
    characterCompanions.replaceChildren(muted("Нет данных о персонаже."));
    characterCombatPets.replaceChildren(muted("Нет данных о персонаже."));
    return;
  }

  const mounts: HTMLElement[] = [];
  const companions: HTMLElement[] = [];
  for (const known of world.knownSpells) {
    const metadata = game.spells.get(known.id);
    const line = spellSkillLine(known.id);
    const isMount = line === SKILL_LINE_MOUNTS || metadata?.effectAura.includes(78) === true;
    if (isMount) mounts.push(collectionSpell(known.id, "Маунт"));
    else if (line === SKILL_LINE_COMPANIONS) companions.push(collectionSpell(known.id, "Питомец"));
  }
  characterMounts.replaceChildren(...(mounts.length > 0 ? mounts : [muted(
    game.talentData?.ready ? "Известных маунтов пока нет." : "Данные о маунтах загружаются…",
  )]));
  characterCompanions.replaceChildren(...(companions.length > 0 ? companions : [muted(
    game.talentData?.ready ? "Известных декоративных питомцев пока нет." : "Данные о питомцах загружаются…",
  )]));
  // Inventory redraws this page every frame. Keep actionable rows attached while the pointer
  // moves from down to up; rebuild only when their server state or service permission changes.
  const pet = world.petSpells;
  const inputs = [world, pet, pet?.spells.length, pet ? world.displayName(pet.guid) : "",
    world.stable, world.stableMessage, world.stableMasterGuid, frameXmlStablePublished()];
  if (!combatPetInputs || inputs.some((input, index) => input !== combatPetInputs![index])) {
    combatPetInputs = inputs;
    characterCombatPets.replaceChildren(...combatPetRows());
  }
}

function spellSkillLine(spellId: number): number | undefined {
  const talents = game.talentData;
  const rows = typeof talents?.spellAbilitiesOf === "function" ? talents.spellAbilitiesOf(spellId) : undefined;
  return rows?.[0]?.skillLine ?? talents?.skillOfSpell(spellId);
}

function collectionSpell(spellId: number, kind: "Маунт" | "Питомец"): HTMLButtonElement {
  const metadata = game.spells.get(spellId);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "character-collection-card";
  button.disabled = metadata === undefined || metadata.passive;
  const name = metadata?.name ?? `${kind} — данные загружаются`;
  setTip(button, name);
  button.setAttribute("aria-label", name);
  const iconUrl = spellIconUrl(metadata?.iconId ?? 0, game.gatewayOrigin);
  if (iconUrl) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, iconUrl);
    button.append(icon);
  }
  const label = document.createElement("span");
  label.textContent = name;
  button.append(label);
  button.addEventListener("click", () => {
    const current = game.world;
    if (!current) return;
    requestSpellCast(spellId, () => current.castSpell(spellId, Math.max(
      metadata?.recoveryTime ?? 0,
      metadata?.categoryRecoveryTime ?? 0,
      // L13-review 5.30: StartRecoveryTime no longer — the global part is the model's (PredictedGlobalCooldown.ts), and
      // as the spell's own timer it held the category-0 mounts (47977, 71342, 75973) 1.5 s the realm does not.
    ), metadata?.cooldownStartedOnEvent ?? false));
  });
  return button;
}

function combatPetRows(): HTMLElement[] {
  const world = game.world;
  if (!world) return [muted("Нет данных о питомцах.")];
  const rows: HTMLElement[] = [];
  const active = world.petSpells;
  if (active && !active.closed && active.guid !== 0n) {
    const spellCount = active.spells.length;
    rows.push(textLine(world.displayName(active.guid) || "Активный питомец",
      `${spellCount} ${spellCount === 1 ? "умение" : "умений"}`));
  }
  rows.push(...stablePetRows(world, showCharacterCollections));
  if (rows.length === 0) rows.push(muted(
    world.stable ? "Боевых питомцев пока нет." : "Активного боевого питомца нет. Остальные появятся после посещения стойл.",
  ));
  return rows;
}

function muted(text: string): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = "muted";
  line.textContent = text;
  return line;
}

/**
 * Bags owns the equipment redraw and intentionally knows nothing about the paperdoll layout.  Add
 * a stable semantic slot number at this boundary so the native skin can place every one of the
 * nineteen controls without depending on whichever children a module happened to insert first.
 */
function decorateEquipmentSlots(): void {
  for (const [index, child] of [...equipmentSlots.children].entries()) {
    const slot = child as HTMLElement;
    const number = String(index + 1);
    slot.dataset["equipmentSlot"] = number;
    slot.setAttribute("data-equipment-slot", number);
  }
}

if (typeof MutationObserver !== "undefined") {
  const equipmentObserver = new MutationObserver(decorateEquipmentSlots);
  equipmentObserver.observe(equipmentSlots, { childList: true });
}

export function showCharacterSheet(): void {
  // Reached on every packet via `renderInventory`: rebuilding dozens of DOM nodes for a closed
  // window is pure waste. Tab switches refresh explicitly above, and world entry below in
  // `EnterWorld`, so an opened window never shows stale content.
  if (characterWindow.hidden) return;
  // Inventory changes already refresh the sheet; let that same update refresh an open collection
  // page so a learned summon or changed active pet appears without closing and reopening it.
  if (!characterCollectionsPane.hidden) showCharacterCollections();
  decorateEquipmentSlots();
  const world = game.world;
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world?.state.objects.get(guid);
  syncSheetControls(world, self);
  if (!world || !self) {
    characterIdentity.textContent = "Нет данных о персонаже";
    drawnSignature = undefined;
    builtInputs = undefined;
    drawStats([textLine("Персонаж", "нет данных")]);
    return;
  }
  prepareSheet(world);
  const inputs = sheetInputs(world, self);
  const now = performance.now();
  if (builtInputs && now - builtAt < SHEET_REFRESH_MS && inputs.length === builtInputs.length
    && inputs.every((input, index) => input === builtInputs![index])) return;
  builtInputs = inputs;
  builtAt = now;

  const level = unit.level(self) ?? 0;
  const race = raceName(unit.race(self));
  const playerClass = className(unit.classId(self));
  const identity = [race, playerClass, `уровень ${level}`].filter(Boolean).join(" · ");
  if (characterIdentity.textContent !== identity) characterIdentity.textContent = identity;
  const experience = readField(self, "PLAYER_XP") ?? 0;
  const nextLevel = readField(self, "PLAYER_NEXT_LEVEL_XP") ?? 0;
  const money = readField(self, "PLAYER_FIELD_COINAGE") ?? 0;

  const line = (label: string, value: string): SheetRow => ({ label, value });
  const general: SheetRow[] = [
    line("Раса", race),
    line("Класс", playerClass),
    line("Уровень", String(level)),
    line("Опыт", nextLevel > 0 ? `${experience} / ${nextLevel}` : String(experience)),
    line("Деньги", formatMoney(money)),
  ];
  if (world.playedTime) {
    general.push(line("Сыграно", formatPlayed(world.playedTime.total)));
    general.push(line("На уровне", formatPlayed(world.playedTime.atLevel)));
  }
  if (world.talents) general.push(line("Очки талантов", String(world.talents.unspentPoints)));
  if (world.achievements.size > 0) general.push(line("Достижений", String(world.achievements.size)));
  if (world.titles.size > 0) general.push(line("Титулов", String(world.titles.size)));

  // 4.03: the stock PaperDoll's categories, read as LiveWorldSeam reads them (CharacterSheetModel.ts).
  const classId = unit.classId(self) ?? 0;
  const rangedSlot = UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + RANGED_EQUIPMENT_SLOT * 2;
  const sections = characterStatSections(self, {
    classId, level,
    catalog: statCatalog,
    defenseSkill: readSkills(self).find((skill) => skill.skillId === SKILL_DEFENSE),
    hasMana: unitHasMana(self),
    rangedWeapon: ((self.fields.get(rangedSlot) ?? 0) !== 0 || (self.fields.get(rangedSlot + 1) ?? 0) !== 0)
      && !frameXmlClassHasRelicSlot(classId),
  });

  const resistances = RESISTANCE_NAMES.map((name, index) =>
    line(name, String(fieldAt(self, "UNIT_FIELD_RESISTANCES", index))));

  const blocks: DrawnSection[] = [
    { title: "Общее", rows: general },
    ...sections,
    { title: "Сопротивления", rows: resistances },
  ];
  const currency = currencySection();
  if (currency) blocks.push(currency);

  // Only factions the character has actually met are worth a line; the server sends all 128.
  // 5.19: the standing shown is Faction.dbc's race/class base plus the wire's (Wow.exe 0x005d05b0);
  // a home city met at the base alone (wire 0) is met all the same (FACTION_FLAG_VISIBLE).
  const catalog = game.factions?.reputationCatalog;
  const met = [...world.factions.values()].filter((faction) => (faction.flags & 1) !== 0)
    .map((faction) => ({ listId: faction.listId, standing: frameXmlReputationBase(world, catalog, faction.listId) + faction.standing }));
  if (met.length > 0) {
    const lines = met
      .sort((left, right) => right.standing - left.standing)
      .slice(0, 20)
      .map((faction) => line(
        game.factions?.name(faction.listId) ?? `Фракция ${faction.listId}`,
        `${reputationRank(faction.standing)} · ${faction.standing}`,
      ));
    blocks.push({ title: "Репутация", rows: lines, reputationButton: true });
  }

  const signature = signatureOf(blocks);
  if (signature === drawnSignature) return;
  drawnSignature = signature;
  drawStats(blocks.map(drawnSection));
}
