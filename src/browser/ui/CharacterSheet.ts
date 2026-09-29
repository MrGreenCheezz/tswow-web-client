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
import { textLine } from "./Widgets.js";
import { toggleReputation } from "./Reputation.js";
import { className, raceName } from "./UnitSnapshot.js";
import { stablePetRows } from "./StableControls.js";
import { frameXmlStablePublished } from "../framexml/FrameXmlStableController.js";
import { requestSpellCast } from "../game/GroundTarget.js";

/**
 * The character sheet: what the character is made of, beyond the health bar.
 *
 * Most of this has always been in the update fields and was never read — five stats, seven
 * resistances, the melee numbers — and the rest arrives in packets the world loop used to drop:
 * reputation, played time, titles, talent points.
 */
const STAT_NAMES = ["Сила", "Ловкость", "Выносливость", "Интеллект", "Дух"];

/** `SPELL_SCHOOL` order, and the first of them is armour rather than a resistance. */
const RESISTANCE_NAMES = ["Броня", "Свет", "Огонь", "Природа", "Лёд", "Тьма", "Тайная магия"];

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
characterSheetPane.append(characterFooter);
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
  button.title = name;
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
      metadata?.startRecoveryTime ?? 0,
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
  if (!world || !self) {
    characterIdentity.textContent = "Нет данных о персонаже";
    drawStats([textLine("Персонаж", "нет данных")]);
    return;
  }

  const level = unit.level(self) ?? 0;
  const race = raceName(unit.race(self));
  const playerClass = className(unit.classId(self));
  characterIdentity.textContent = [race, playerClass, `уровень ${level}`].filter(Boolean).join(" · ");
  const experience = readField(self, "PLAYER_XP") ?? 0;
  const nextLevel = readField(self, "PLAYER_NEXT_LEVEL_XP") ?? 0;
  const money = readField(self, "PLAYER_FIELD_COINAGE") ?? 0;

  const general = [
    textLine("Раса", race),
    textLine("Класс", playerClass),
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
    const all = document.createElement("button");
    all.type = "button";
    all.textContent = "Все фракции";
    all.addEventListener("click", () => toggleReputation());
    blocks.push(section("Репутация", [...lines, all]));
  }

  drawStats(blocks);
}
