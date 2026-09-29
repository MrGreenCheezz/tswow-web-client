/**
 * The achievement catalog: the three client tables Blizzard_AchievementUI reads through its C API
 * (`Achievement.dbc`, `Achievement_Category.dbc`, `Achievement_Criteria.dbc`), as the gateway's
 * `/dbc/achievements` route sends them (src/gateway/AchievementMetadata.ts), indexed once.
 *
 * Fetched the first time something needs a name — the window, a toast, an achievement chat line —
 * never at boot. A gateway built before the route answers 404; the fetch then fails and the stock
 * owner refuses to open (FrameXmlAchievementOwner.ts), because every row the window would show is
 * catalog data and there is nothing honest to show without it.
 */

/** `/dbc/achievements?v=` this number (src/gateway/AchievementMetadata.ts ACHIEVEMENT_CATALOG_VERSION). */
export const FRAMEXML_ACHIEVEMENT_CATALOG_VERSION = 1;
/** `Achievement_Category` 1, «Статистика»: the root of the statistics tree, listed by neither tab. */
export const FRAMEXML_ACHIEVEMENT_STATISTICS_ROOT = 1;
/** `FEAT_OF_STRENGTH_ID` (Blizzard_AchievementUI.lua:47): only earned feats are ever listed. */
export const FRAMEXML_ACHIEVEMENT_FEATS_OF_STRENGTH = 81;
/** `ACHIEVEMENT_FLAG_COUNTER` (DBCEnums.h): a statistic, which never completes. */
export const ACHIEVEMENT_FLAG_COUNTER = 0x1;
/** `ACHIEVEMENT_CRITERIA_FLAG_HIDDEN` (DBCEnums.h): «not show criteria in client». */
export const ACHIEVEMENT_CRITERIA_FLAG_HIDDEN = 0x2;

const ICON_ROOT = "Interface\\Icons\\";
const QUESTION_MARK = "Interface\\Icons\\INV_Misc_QuestionMark";

export interface FrameXmlAchievementCategory {
  readonly id: number;
  /** As the table has it: -1 for a top-level achievement category, 1 for a top-level statistic. */
  readonly parent: number;
  readonly name: string;
  readonly uiOrder: number;
  /** Under the statistics root (the root itself is neither). */
  readonly statistics: boolean;
}

export interface FrameXmlAchievementEntry {
  readonly id: number;
  /** -1 both, 0 Horde, 1 Alliance. */
  readonly faction: number;
  readonly instance: number;
  /** The previous achievement of a progressive chain, 0 for none. */
  readonly supercedes: number;
  readonly name: string;
  readonly description: string;
  readonly category: number;
  readonly points: number;
  readonly uiOrder: number;
  readonly flags: number;
  /** A full `Interface\Icons\` path; the question mark when the SpellIcon row was missing. */
  readonly icon: string;
  readonly reward: string;
  readonly minimumCriteria: number;
  readonly sharesCriteria: number;
}

export interface FrameXmlAchievementCriterion {
  readonly id: number;
  readonly achievement: number;
  readonly type: number;
  readonly asset: number;
  readonly quantity: number;
  readonly description: string;
  readonly flags: number;
  readonly timerStartEvent: number;
  readonly timerAsset: number;
  /** Seconds a timed criterion allows, 0 for an untimed one. */
  readonly timerTime: number;
  readonly uiOrder: number;
}

const EMPTY: readonly never[] = Object.freeze([]);

function byOrder(left: { uiOrder: number; id: number }, right: { uiOrder: number; id: number }): number {
  return left.uiOrder - right.uiOrder || left.id - right.id;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** The indexed catalog. Everything here is built once, in the constructor. */
export class FrameXmlAchievementCatalog {
  readonly categories = new Map<number, FrameXmlAchievementCategory>();
  readonly achievements = new Map<number, FrameXmlAchievementEntry>();
  readonly criteria = new Map<number, FrameXmlAchievementCriterion>();
  /** `GetCategoryList` and `GetStatisticsCategoryList`, in table order. */
  readonly achievementCategoryIds: readonly number[];
  readonly statisticCategoryIds: readonly number[];
  readonly #inCategory = new Map<number, FrameXmlAchievementEntry[]>();
  readonly #criteriaOf = new Map<number, FrameXmlAchievementCriterion[]>();
  readonly #shownCriteriaOf = new Map<number, FrameXmlAchievementCriterion[]>();
  readonly #next = new Map<number, FrameXmlAchievementEntry[]>();

  constructor(
    categories: readonly FrameXmlAchievementCategory[],
    achievements: readonly FrameXmlAchievementEntry[],
    criteria: readonly FrameXmlAchievementCriterion[],
  ) {
    for (const category of categories) this.categories.set(category.id, category);
    for (const achievement of achievements) {
      this.achievements.set(achievement.id, achievement);
      let list = this.#inCategory.get(achievement.category);
      if (!list) this.#inCategory.set(achievement.category, list = []);
      list.push(achievement);
      if (achievement.supercedes > 0) {
        let next = this.#next.get(achievement.supercedes);
        if (!next) this.#next.set(achievement.supercedes, next = []);
        next.push(achievement);
      }
    }
    for (const list of this.#inCategory.values()) list.sort(byOrder);
    for (const criterion of criteria) {
      this.criteria.set(criterion.id, criterion);
      let list = this.#criteriaOf.get(criterion.achievement);
      if (!list) this.#criteriaOf.set(criterion.achievement, list = []);
      list.push(criterion);
    }
    for (const [id, list] of this.#criteriaOf) {
      list.sort(byOrder);
      this.#shownCriteriaOf.set(id, list.filter((criterion) => (criterion.flags & ACHIEVEMENT_CRITERIA_FLAG_HIDDEN) === 0));
    }
    const ordered = [...this.categories.values()]
      .filter((category) => category.id !== FRAMEXML_ACHIEVEMENT_STATISTICS_ROOT)
      .sort(byOrder);
    this.achievementCategoryIds = Object.freeze(ordered.filter((category) => !category.statistics).map((category) => category.id));
    this.statisticCategoryIds = Object.freeze(ordered.filter((category) => category.statistics).map((category) => category.id));
  }

  /** Every achievement filed under a category, in its table order. */
  inCategory(categoryId: number): readonly FrameXmlAchievementEntry[] {
    return this.#inCategory.get(categoryId) ?? EMPTY;
  }

  /** Every criterion of an achievement, hidden ones included (completion and statistics read them). */
  criteriaOf(achievementId: number): readonly FrameXmlAchievementCriterion[] {
    return this.#criteriaOf.get(achievementId) ?? EMPTY;
  }

  /** The criteria the client lists: `ACHIEVEMENT_CRITERIA_FLAG_HIDDEN` ones left out. */
  shownCriteriaOf(achievementId: number): readonly FrameXmlAchievementCriterion[] {
    return this.#shownCriteriaOf.get(achievementId) ?? EMPTY;
  }

  /** The achievements whose `supercedes` names this one: the next step(s) of its chain. */
  nextOf(achievementId: number): readonly FrameXmlAchievementEntry[] {
    return this.#next.get(achievementId) ?? EMPTY;
  }

  /** Whether a category is Feats of Strength or filed under it. */
  isFeatsOfStrength(categoryId: number): boolean {
    for (let id = categoryId, depth = 0; id > 0 && depth < 8; depth += 1) {
      if (id === FRAMEXML_ACHIEVEMENT_FEATS_OF_STRENGTH) return true;
      id = this.categories.get(id)?.parent ?? -1;
    }
    return false;
  }

  /**
   * The route's JSON, checked row by row; undefined for anything else (another shape version, a
   * truncated body). Rows are `[id, …]` arrays in the column order src/gateway/AchievementMetadata.ts
   * documents.
   */
  static fromJson(value: unknown): FrameXmlAchievementCatalog | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const body = value as { version?: unknown; categories?: unknown; achievements?: unknown; criteria?: unknown };
    if (body.version !== FRAMEXML_ACHIEVEMENT_CATALOG_VERSION || !Array.isArray(body.categories)
      || !Array.isArray(body.achievements) || !Array.isArray(body.criteria)) return undefined;
    const rawCategories: { id: number; parent: number; name: string; uiOrder: number }[] = [];
    for (const row of body.categories as unknown[]) {
      if (!Array.isArray(row) || row.length !== 4 || !isInt(row[0]) || !isInt(row[1]) || typeof row[2] !== "string"
        || !isInt(row[3])) return undefined;
      rawCategories.push({ id: row[0], parent: row[1], name: row[2], uiOrder: row[3] });
    }
    const parents = new Map(rawCategories.map((row) => [row.id, row.parent]));
    const underStatistics = (id: number): boolean => {
      for (let current = parents.get(id), depth = 0; current !== undefined && depth < 8; depth += 1) {
        if (current === FRAMEXML_ACHIEVEMENT_STATISTICS_ROOT) return true;
        current = parents.get(current);
      }
      return false;
    };
    const categories = rawCategories.map((row) => Object.freeze({ ...row, statistics: underStatistics(row.id) }));
    const achievements: FrameXmlAchievementEntry[] = [];
    for (const row of body.achievements as unknown[]) {
      if (!Array.isArray(row) || row.length !== 14) return undefined;
      const [id, faction, instance, supercedes, name, description, category, points, uiOrder, flags, icon,
        reward, minimumCriteria, sharesCriteria] = row as unknown[];
      if (!isInt(id) || !isInt(faction) || !isInt(instance) || !isInt(supercedes) || typeof name !== "string"
        || typeof description !== "string" || !isInt(category) || !isInt(points) || !isInt(uiOrder)
        || !isInt(flags) || typeof icon !== "string" || typeof reward !== "string" || !isInt(minimumCriteria)
        || !isInt(sharesCriteria)) return undefined;
      // One path segment under Interface\Icons\, as the gateway filtered it.
      const iconPath = icon && !/[\\/]/.test(icon) ? `${ICON_ROOT}${icon}` : QUESTION_MARK;
      achievements.push(Object.freeze({
        id, faction, instance, supercedes, name, description, category, points, uiOrder, flags,
        icon: iconPath, reward, minimumCriteria, sharesCriteria,
      }));
    }
    const criteria: FrameXmlAchievementCriterion[] = [];
    for (const row of body.criteria as unknown[]) {
      if (!Array.isArray(row) || row.length !== 11) return undefined;
      const [id, achievement, type, asset, quantity, description, flags, timerStartEvent, timerAsset, timerTime,
        uiOrder] = row as unknown[];
      if (!isInt(id) || !isInt(achievement) || !isInt(type) || !isInt(asset) || !isInt(quantity)
        || typeof description !== "string" || !isInt(flags) || !isInt(timerStartEvent) || !isInt(timerAsset)
        || !isInt(timerTime) || !isInt(uiOrder)) return undefined;
      criteria.push(Object.freeze({
        id, achievement, type, asset, quantity, description, flags, timerStartEvent, timerAsset, timerTime, uiOrder,
      }));
    }
    return new FrameXmlAchievementCatalog(categories, achievements, criteria);
  }
}

/** Where the catalog comes from: the gateway in the browser, a fixture offline. */
export interface FrameXmlAchievementCatalogSource {
  load(): Promise<FrameXmlAchievementCatalog | undefined>;
}

/**
 * The gateway route, fetched once per page. A failure (a gateway built before the route answers
 * 404, a malformed body) is remembered with its reason and answered undefined; the next caller
 * after a failure tries again, since the owner's gateway may have been restarted meanwhile.
 */
export class FrameXmlAchievementCatalogClient implements FrameXmlAchievementCatalogSource {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #pending: Promise<FrameXmlAchievementCatalog | undefined> | undefined;
  /** Why the last load failed, for the owner's refusal; undefined while unfetched or loaded. */
  failure: string | undefined;

  constructor(gatewayOrigin: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#url = new URL(`/dbc/achievements?v=${FRAMEXML_ACHIEVEMENT_CATALOG_VERSION}`, gatewayOrigin).href;
    this.#fetch = fetcher;
  }

  load(): Promise<FrameXmlAchievementCatalog | undefined> {
    if (this.#pending) return this.#pending;
    const pending = this.#request();
    this.#pending = pending;
    void pending.then((catalog) => { if (!catalog && this.#pending === pending) this.#pending = undefined; });
    return pending;
  }

  async #request(): Promise<FrameXmlAchievementCatalog | undefined> {
    try {
      const response = await this.#fetch(this.#url);
      if (!response.ok) throw new Error(`achievement catalog gateway returned ${response.status}`);
      const catalog = FrameXmlAchievementCatalog.fromJson(await response.json());
      if (!catalog) throw new Error("malformed achievement catalog");
      this.failure = undefined;
      return catalog;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }
}
