import type { SpellSkillAbilityInfo, TalentData } from "../gateway/TalentMetadata.js";

export type { TalentData };

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
  #revision = 0;
  #failed = false;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Starts the one fetch this needs. Safe to call repeatedly; only the first does anything. */
  load(): void {
    if (this.#data || this.#pending) return;
    this.#pending = (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/talents`);
        if (!response.ok) throw new Error(`Talent gateway returned ${response.status}`);
        const value = await response.json() as TalentData;
        if (!Array.isArray(value.talents) || !Array.isArray(value.tabs)
          || !Array.isArray(value.skillCategories)) throw new Error("malformed talent data");
        this.#index(value);
        this.onLoaded?.();
      } catch (error) {
        // Left unfetched rather than retried: without it the talent window says so and the
        // spellbook falls back to one undivided list, which is what it was before this slice.
        this.#failed = true;
        this.onStatus?.(`таланты: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  #index(value: TalentData): void {
    this.#data = value;
    for (const tab of value.tabs) {
      // A tab belongs to every class its mask names, and the three pet trees name none.
      for (let classId = 1; classId <= 11; classId++) {
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
    this.#revision++;
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

  /** The three pet trees, matched to a family by its `PetTalentType`. */
  petTabs(petCategory: number): TalentData["tabs"] {
    return (this.#data?.tabs ?? []).filter((tab) => tab.classMask === 0 && tab.petCategory === petCategory);
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

  /** A pet family's `PetTalentType`, or zero for a family with no trees at all. */
  petTalentType(creatureFamily: number): number {
    return this.#data?.petFamilies[creatureFamily] ?? 0;
  }
}
