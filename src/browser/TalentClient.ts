import type { SpellSkillAbilityInfo, TalentData } from "../gateway/TalentMetadata.js";
import { dataRetryDelay } from "./FactionClient.js";

export type { TalentData };

/** `SkillLineCategory` 7, the class ability lines. */
const SKILL_CATEGORY_CLASS = 7;
/** Single-class rows a class-category line needs to count as that class's line (`skillLineClass`). */
const CLASS_LINE_MIN_ROWS = 10;

/**
 * Talent trees, glyphs and skill lines, fetched once for the session.
 *
 * The same arrangement `FactionClient` uses, and for the same reason: the answer is wanted for
 * every talent in every tree on every repaint, and the whole of it is smaller than one texture.
 * Nothing here is on the wire — `SMSG_TALENTS_INFO` says which talents are learned and to what
 * rank, and not one thing about what a talent is or where it sits.
 */
export class TalentClient {
  readonly #baseUrl: string;
  #data: TalentData | undefined;
  #pending: Promise<void> | undefined;
  #tabsByClass = new Map<number, TalentData["tabs"]>();
  #talentsByTab = new Map<number, TalentData["talents"]>();
  #skillLines = new Map<number, TalentData["skillLines"][number]>();
  #skillCategories = new Map<number, TalentData["skillCategories"][number]>();
  #skillCategoryOrder: readonly TalentData["skillCategories"][number][] = Object.freeze([]);
  #glyphs = new Map<number, TalentData["glyphs"][number]>();
  #spellAbilities = new Map<number, readonly SpellSkillAbilityInfo[]>();
  /** Category-7 skill line to the class whose ability line it is (`skillLineClass`). */
  #lineClasses = new Map<number, number>();
  #revision = 0;
  #failed = false;
  #retries = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #abandoned = false;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** A newer client replaced this one (the next world entry): no more retries. */
  abandon(): void {
    this.#abandoned = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  /**
   * Starts the one fetch this needs. Safe to call repeatedly: a fetch in flight or a retry already
   * waiting makes it a no-op.
   */
  load(): void {
    if (this.#data || this.#pending || this.#retryTimer !== undefined || this.#abandoned) return;
    this.#pending = (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/talents`);
        if (!response.ok) throw new Error(`Talent gateway returned ${response.status}`);
        const value = await response.json() as TalentData;
        if (!Array.isArray(value.talents) || !Array.isArray(value.tabs)
          || !Array.isArray(value.skillCategories)) throw new Error("malformed talent data");
        this.#index(value);
        this.#failed = false;
        this.onLoaded?.();
      } catch (error) {
        // Until it lands the talent window says so and the spellbook falls back to one undivided
        // list; it is asked again with a growing pause (5.16), and the failure is said once.
        this.#failed = true;
        if (this.#retries === 0) this.onStatus?.(`таланты: ${error instanceof Error ? error.message : String(error)}`, true);
        this.#pending = undefined;
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = undefined;
          this.load();
        }, dataRetryDelay(this.#retries++));
      }
    })();
  }

  #index(value: TalentData): void {
    this.#data = value;
    for (const tab of value.tabs) {
      // A tab belongs to every class its mask names, and the three pet trees name none. Every bit
      // up to class 31, not 1..11: a dataset's own classes (12, 13 HERO) have tabs too (9.05).
      for (let classId = 1; classId <= 31; classId++) {
        if ((tab.classMask & (1 << (classId - 1))) === 0) continue;
        const tabs = this.#tabsByClass.get(classId) ?? [];
        tabs.push(tab);
        this.#tabsByClass.set(classId, tabs);
      }
    }
    for (const tabs of this.#tabsByClass.values()) tabs.sort((left, right) => left.orderIndex - right.orderIndex);
    for (const talent of value.talents) {
      const list = this.#talentsByTab.get(talent.tabId) ?? [];
      list.push(talent);
      this.#talentsByTab.set(talent.tabId, list);
    }
    for (const list of this.#talentsByTab.values()) {
      list.sort((left, right) => left.tier - right.tier || left.column - right.column);
    }
    for (const line of value.skillLines) this.#skillLines.set(line.id, line);
    const categories = value.skillCategories
      .filter((category) => Number.isInteger(category.id) && category.id > 0 && category.name.length > 0)
      .map((category) => Object.freeze({ ...category }));
    categories.sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);
    this.#skillCategoryOrder = Object.freeze(categories);
    for (const category of this.#skillCategoryOrder) this.#skillCategories.set(category.id, category);
    for (const glyph of value.glyphs) this.#glyphs.set(glyph.id, glyph);
    for (const [spellId, rows] of Object.entries(value.spellAbilities ?? {})) {
      const id = Number(spellId);
      if (!Number.isSafeInteger(id) || id <= 0 || !Array.isArray(rows)) continue;
      this.#spellAbilities.set(id, Object.freeze(rows.map((row) => Object.freeze({ ...row }))));
    }
    this.#indexLineClasses();
    this.#revision++;
  }

  /**
   * Which class each class-category (7) skill line belongs to: the class its single-class
   * `SkillLineAbility` rows name, once at least `CLASS_LINE_MIN_ROWS` of them do. Measured on this
   * dataset (2026-09-28): the 30 talent-tree lines and Runeforging carry 11-183 such rows each, all
   * of one class (Holy 594: 166 paladin rows and one priest row); the pet-family and minion lines
   * carry none; Mounts (777) carries 4 paladin rows among 315 and Lockpicking (633) one rogue row —
   * both general lines. A talent spell's own row is maskless (Corpse Explosion in Unholy, 51328),
   * which is why a spell's tab has to ask its line's class and not only its row's mask.
   */
  #indexLineClasses(): void {
    const counts = new Map<number, Map<number, number>>();
    for (const rows of this.#spellAbilities.values()) {
      for (const row of rows) {
        const mask = row.classMask >>> 0;
        if (mask === 0 || (mask & (mask - 1)) !== 0) continue;
        const byClass = counts.get(row.skillLine) ?? new Map<number, number>();
        byClass.set(mask, (byClass.get(mask) ?? 0) + 1);
        counts.set(row.skillLine, byClass);
      }
    }
    this.#lineClasses.clear();
    for (const [line, byClass] of counts) {
      if (this.#skillLines.get(line)?.categoryId !== SKILL_CATEGORY_CLASS) continue;
      let bestMask = 0;
      let bestCount = 0;
      for (const [mask, count] of byClass) {
        if (count > bestCount) {
          bestMask = mask;
          bestCount = count;
        }
      }
      if (bestCount >= CLASS_LINE_MIN_ROWS) this.#lineClasses.set(line, Math.log2(bestMask) + 1);
    }
  }

  get ready(): boolean {
    return this.#data !== undefined;
  }

  /** True after the optional snapshot failed; consumers may use their ungrouped fallback. */
  get failed(): boolean {
    return this.#failed;
  }

  /** Monotonic metadata revision, zero until the complete `/dbc/talents` snapshot lands. */
  get revision(): number {
    return this.#revision;
  }

  /** The three trees of one class, in the order the original client shows them. */
  tabsForClass(classId: number): TalentData["tabs"] {
    return this.#tabsByClass.get(classId) ?? [];
  }

  /** The pet trees whose core `PetTalentMask` accepts this family's mask. */
  petTabs(familyMask: number): TalentData["tabs"] {
    if (familyMask === 0) return [];
    return (this.#data?.tabs ?? []).filter((tab) =>
      tab.classMask === 0 && (tab.petTalentMask & familyMask) !== 0);
  }

  talentsIn(tabId: number): TalentData["talents"] {
    return this.#talentsByTab.get(tabId) ?? [];
  }

  skillLine(id: number): TalentData["skillLines"][number] | undefined {
    return this.#skillLines.get(id);
  }

  /** The stock category attached to a `SkillLine.CategoryID`, or undefined when it is unknown. */
  skillCategory(id: number): TalentData["skillCategories"][number] | undefined {
    return this.#skillCategories.get(id);
  }

  /** Immutable categories sorted by the client's explicit `SkillLineCategory.SortIndex`. */
  skillCategories(): readonly TalentData["skillCategories"][number][] {
    return this.#skillCategoryOrder;
  }

  glyph(id: number): TalentData["glyphs"][number] | undefined {
    return this.#glyphs.get(id);
  }

  /** Which skill line a spell belongs to, which is what a spellbook tab is. */
  skillOfSpell(spellId: number): number | undefined {
    return this.#data?.spellSkill[spellId];
  }

  /** All authoritative SkillLineAbility rows for a spell, including class/race masks. */
  spellAbilitiesOf(spellId: number): readonly SpellSkillAbilityInfo[] | undefined {
    return this.#spellAbilities.get(spellId);
  }

  /** The class (1-based id) whose ability line a class-category skill line is; undefined for any other line. */
  skillLineClass(line: number): number | undefined {
    return this.#lineClasses.get(line);
  }

  /** Core's `1 << CreatureFamily.PetTalentType`, including valid type zero. */
  petTalentMask(creatureFamily: number): number {
    return this.#data?.petFamilyMasks[creatureFamily] ?? 0;
  }

  /** `CreatureFamily.Name_lang`; undefined before the talents load or from an older gateway. */
  petFamilyName(creatureFamily: number): string | undefined {
    return this.#data?.petFamilyNames?.[creatureFamily] || undefined;
  }
}
