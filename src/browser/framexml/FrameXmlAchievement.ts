/**
 * The stock achievement C API (Blizzard_AchievementUI, the WatchFrame's tracked achievements and
 * the achievement alert) over this client's world: what an achievement *is* comes from the catalog
 * (FrameXmlAchievementCatalog.ts, the three client tables), whether it is earned and how far each
 * criterion has come from the achievement packets WorldClient keeps (SMSG_ALL_ACHIEVEMENT_DATA,
 * SMSG_ACHIEVEMENT_EARNED, SMSG_CRITERIA_UPDATE, SMSG_RESPOND_INSPECT_ACHIEVEMENTS).
 *
 * The names are the 3.3.5a client's own (all present in its Lua registration strings, measured
 * from Wow.exe). Rules the client applies and the stock Lua relies on:
 * - a category lists its earned achievements first, then the rest, each in table order — the
 *   Complete/Incomplete filters index past `numCompleted` (Blizzard_AchievementUI.lua:1366-1376);
 * - a progressive chain (`supercedes`) shows its last earned step and its first unearned one,
 *   which is what AchievementFrame_SelectAchievement walks to (:2042-2066); the summary bars
 *   and the category tooltips count every step (`GetCategoryNumAchievements(id, true)`);
 * - Feats of Strength are listed only once earned; statistics never complete;
 * - a statistic's top-level categories answer parent -1, like the achievement ones, or the stock
 *   tree (AchievementFrameCategories_GetCategoryList) would file them under a category it never
 *   lists.
 * Criterion completion mirrors the core's own rule (AchievementMgr::IsCompletedCriteria).
 *
 * Nothing here runs per frame: the model is event-driven, and the one coalesced edge
 * (CRITERIA_UPDATE, several per kill) is flushed from the seam tick.
 */
import { CHAT_MSG_ACHIEVEMENT, CHAT_MSG_GUILD_ACHIEVEMENT, type ChatMessage } from "../../world/ChatProtocol.js";
import {
  ACHIEVEMENT_FLAG_COUNTER,
  FRAMEXML_ACHIEVEMENT_STATISTICS_ROOT,
  type FrameXmlAchievementCatalog,
  type FrameXmlAchievementCatalogSource,
  type FrameXmlAchievementCriterion,
  type FrameXmlAchievementEntry,
} from "./FrameXmlAchievementCatalog.js";

export const FRAMEXML_ACHIEVEMENT_EVENTS = Object.freeze({
  list: "RECEIVED_ACHIEVEMENT_LIST",
  earned: "ACHIEVEMENT_EARNED",
  criteria: "CRITERIA_UPDATE",
  tracked: "TRACKED_ACHIEVEMENT_UPDATE",
  inspect: "INSPECT_ACHIEVEMENT_READY",
});

/** `WATCHFRAME_MAXACHIEVEMENTS` (WatchFrame.lua:24): stock refuses an eleventh before asking. */
const MAX_TRACKED = 10;
/** `ACHIEVEMENT_COMPARISON_SUMMARY_ID` (Blizzard_AchievementUI.lua:40): the comparison summary. */
const COMPARISON_SUMMARY_ID = -1;
/** `ACHIEVEMENT_FLAG_SUMM`, `_MAX_USED`, `_REQ_COUNT`, `_AVERAGE` (DBCEnums.h): how criteria add up. */
const FLAG_SUMM = 0x8;
const FLAG_MAX_USED = 0x10;
const FLAG_REQ_COUNT = 0x20;
const FLAG_AVERAGE = 0x40;
/** `ACHIEVEMENT_FLAGS_HAS_PROGRESS_BAR` (Constants.lua:165): one bar in place of the criteria list. */
const FLAG_BAR = 0x80;
/** `ACHIEVEMENT_CRITERIA_FLAG_MONEY_COUNTER` (DBCEnums.h): the counter is copper. */
const CRITERIA_FLAG_MONEY = 0x20;
/** `ACHIEVEMENT_CRITERIA_PROGRESS_BAR` (Constants.lua:169). */
const CRITERIA_FLAG_PROGRESS_BAR = 0x1;
/** The link colour and the four "every criterion" masks of an earned achievement's link. */
const LINK_COLOUR = "|cffffff00";
const ALL_CRITERIA = 4294967295;

/** AchievementMgr::IsCompletedCriteria: types done once the counter reaches the quantity. */
const QUANTITY_TYPES = new Set([
  0, 1, 5, 7, 9, 10, 11, 13, 14, 24, 28, 29, 30, 31, 35, 36, 37, 39, 41, 42, 45, 46, 47, 48, 49, 50, 51,
  52, 53, 54, 55, 56, 57, 62, 67, 68, 69, 70, 72, 75, 76, 109, 110, 112, 113, 119, 120,
]);
/** … types done by a counter of 1 (an achievement, a quest, a spell, an area). */
const ONCE_TYPES = new Set([8, 27, 34, 43]);
const LEARN_SKILL_LEVEL = 40;
const EARN_ACHIEVEMENT_POINTS = 115;
const WIN_ARENA = 32;
const ON_LOGIN = 74;

/** One inspected player's achievements, as SMSG_RESPOND_INSPECT_ACHIEVEMENTS carried them. */
export interface FrameXmlAchievementInspect {
  readonly guid: bigint;
  readonly completed: ReadonlyMap<number, number>;
  readonly criteria: ReadonlyMap<number, bigint>;
}

/** What moved in the world's achievement state. */
export type FrameXmlAchievementChange =
  | { readonly kind: "list" }
  | { readonly kind: "earned"; readonly achievementId: number; readonly mine: boolean }
  | { readonly kind: "criteria"; readonly criteriaId: number; readonly timeElapsed: number }
  | { readonly kind: "deleted" }
  | { readonly kind: "inspect"; readonly guid: bigint };

/** The world the model reads: WorldClient in the live seam, a script offline. */
export interface FrameXmlAchievementWorld {
  /** Earned achievements, with the packed date (WowTime) each was earned on. */
  completed(): ReadonlyMap<number, number>;
  /** Criterion counters. */
  criteria(): ReadonlyMap<number, bigint>;
  /** The player's team as the table spells it: 0 Horde, 1 Alliance; undefined while unknown. */
  faction(): number | undefined;
  selfGuid(): bigint | undefined;
  /** The last inspect answer, whoever it was about. */
  inspect(): FrameXmlAchievementInspect | undefined;
  /** CMSG_QUERY_INSPECT_ACHIEVEMENTS. */
  queryInspect(guid: bigint): void;
  /** 0 male, 1 female, as the wire has it; undefined when the player is not in view. */
  gender(guid: bigint): number | undefined;
  /** A player's name from the name cache (SMSG_NAME_QUERY_RESPONSE); undefined while unknown. */
  name?(guid: bigint): string | undefined;
  subscribe(listener: (change: FrameXmlAchievementChange) => void): () => void;
}

export interface FrameXmlAchievementPump {
  fire(event: string, ...args: readonly unknown[]): number;
  now(): number;
}

/** `id, name, points, completed, month, day, year, description, flags, icon, rewardText`. */
export type FrameXmlAchievementInfo = readonly [
  id: number, name: string, points: number, completed: boolean, month: number | undefined,
  day: number | undefined, year: number | undefined, description: string, flags: number, icon: string,
  rewardText: string,
];

/** `description, type, completed, quantity, reqQuantity, charName, flags, assetID, quantityString, criteriaID`. */
export type FrameXmlAchievementCriteriaInfo = readonly [
  description: string, type: number, completed: boolean, quantity: number, reqQuantity: number,
  charName: string | undefined, flags: number, assetID: number, quantityString: string, criteriaID: number,
];

/** WowTime::GetPackedTime: two-digit year, month and day counted from 0. Undefined when unset. */
export function frameXmlAchievementDate(packed: number | undefined): readonly [month: number, day: number, year: number] | undefined {
  if (packed === undefined) return undefined;
  const year = (packed >>> 24) & 0x1f;
  const month = (packed >>> 20) & 0xf;
  const day = (packed >>> 14) & 0x3f;
  if (year === 31 || month === 15 || day === 63) return undefined;
  return [month + 1, day + 1, year];
}

/** The client's GetCoinTextureString: the denominations present, each with its coin. */
export function frameXmlAchievementMoney(copper: number): string {
  const amount = Math.max(0, Math.floor(copper));
  const gold = Math.floor(amount / 10000);
  const silver = Math.floor(amount / 100) % 100;
  const rest = amount % 100;
  const parts: string[] = [];
  if (gold > 0) parts.push(`${gold}|TInterface\\MoneyFrame\\UI-GoldIcon:0:0:2:0|t`);
  if (silver > 0) parts.push(`${silver}|TInterface\\MoneyFrame\\UI-SilverIcon:0:0:2:0|t`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest}|TInterface\\MoneyFrame\\UI-CopperIcon:0:0:2:0|t`);
  return parts.join(" ");
}

function guidText(guid: bigint | undefined): string {
  return (guid ?? 0n).toString(16).toUpperCase().padStart(16, "0");
}

function intArg(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) ? number : undefined;
}

interface CategoryView {
  readonly revision: number;
  /** Every listed achievement (chains in full). */
  readonly all: readonly FrameXmlAchievementEntry[];
  readonly allCompleted: number;
  /** What the category shows: earned first, then unearned, chains collapsed. */
  readonly shown: readonly FrameXmlAchievementEntry[];
  readonly shownCompleted: number;
}

/** An achievement shown as one progress bar: the criteria behind it and its maximum. */
interface AchievementBar {
  readonly criteria: readonly FrameXmlAchievementCriterion[];
  readonly required: number;
}

const EMPTY_VIEW: CategoryView = Object.freeze({ revision: -1, all: [], allCompleted: 0, shown: [], shownCompleted: 0 });

/** `$g<male>:<female>;` and the ruRU `$g<male>:<female>:<case>;` of BroadcastText 29245. */
const GENDER = /\$g([^:;]*):([^:;]*)(?::([^;]*))?;/gi;

export class FrameXmlAchievementModel {
  readonly #world: FrameXmlAchievementWorld;
  #pump: FrameXmlAchievementPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #catalog: FrameXmlAchievementCatalog | undefined;
  #catalogSource: FrameXmlAchievementCatalogSource | undefined;
  #catalogPending: Promise<FrameXmlAchievementCatalog | undefined> | undefined;
  /** Bumped on every progress change; the category views compare against it. */
  #revision = 0;
  readonly #views = new Map<number, CategoryView>();
  #totals: { readonly revision: number; readonly total: number; readonly completed: number } | undefined;
  readonly #tracked: number[] = [];
  #compareGuid: bigint | undefined;
  #owned = false;
  #criteriaDirty = false;
  /** Earned while the stock UI was not loaded: their ACHIEVEMENT_EARNED waits for it. */
  readonly #earnedQueue: number[] = [];
  /** Achievement chat lines waiting for the catalog to name their `$a`. */
  readonly #heldLines: { readonly message: ChatMessage; readonly emit: (message: ChatMessage) => void }[] = [];
  /** The stock owner is published and has not failed: CanShowAchievementUI. */
  available = false;
  /** The stock owner's load, asked for by an earned achievement while nothing is loaded. */
  onLoadRequest: (() => void) | undefined;
  /** HasCompletedAnyAchievement may have changed (the micro button follows it). */
  onAvailabilityChanged: (() => void) | undefined;

  constructor(world: FrameXmlAchievementWorld) {
    this.#world = world;
  }

  get catalog(): FrameXmlAchievementCatalog | undefined { return this.#catalog; }

  get catalogSource(): FrameXmlAchievementCatalogSource | undefined { return this.#catalogSource; }

  /** Set once by whoever knows where the catalog lives (the mount's gateway, a fixture). */
  set catalogSource(source: FrameXmlAchievementCatalogSource | undefined) {
    if (this.#catalogSource === source) return;
    this.#catalogSource = source;
    this.#catalogPending = undefined;
  }

  /** Load the catalog once; a failed load is retried by the next caller. */
  loadCatalog(): Promise<FrameXmlAchievementCatalog | undefined> {
    if (this.#catalog) return Promise.resolve(this.#catalog);
    const source = this.#catalogSource;
    if (!source) return Promise.resolve(undefined);
    if (this.#catalogPending) return this.#catalogPending;
    const pending = source.load().then((catalog) => {
      if (this.#catalogSource !== source) return undefined;
      if (catalog) this.#adoptCatalog(catalog);
      return catalog;
    }, () => undefined).finally(() => {
      if (this.#catalogPending === pending) this.#catalogPending = undefined;
      this.#releaseHeldLines();
    });
    this.#catalogPending = pending;
    return pending;
  }

  #adoptCatalog(catalog: FrameXmlAchievementCatalog): void {
    this.#catalog = catalog;
    this.#revision += 1;
    this.#views.clear();
  }

  /** Stock owns the loaded UI: events reach Lua, and the edge delivers what waited for it. */
  get owned(): boolean { return this.#owned; }

  set owned(value: boolean) {
    if (this.#owned === value) return;
    this.#owned = value;
    if (!value) return;
    const pump = this.#pump;
    if (!pump) return;
    for (const id of this.#earnedQueue.splice(0)) pump.fire(FRAMEXML_ACHIEVEMENT_EVENTS.earned, id);
    this.tick();
  }

  attach(pump: FrameXmlAchievementPump): void {
    this.detach();
    this.#pump = pump;
    this.#revision += 1;
    this.#unsubscribe = this.#world.subscribe((change) => this.#onChange(change));
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    // A new VM has no AchievementFrame yet: nothing is tracked, compared or waiting in it.
    this.#owned = false;
    this.#tracked.length = 0;
    this.#compareGuid = undefined;
    this.#earnedQueue.length = 0;
    this.#criteriaDirty = false;
  }

  /** A load that could not happen: the ACHIEVEMENT_EARNED events waiting for it are not replayed later. */
  discardQueuedEarned(): void {
    this.#earnedQueue.length = 0;
  }

  /** The coalesced CRITERIA_UPDATE: one per frame however many criteria the packets moved. */
  tick(): void {
    if (!this.#criteriaDirty || !this.#owned) return;
    this.#criteriaDirty = false;
    this.#pump?.fire(FRAMEXML_ACHIEVEMENT_EVENTS.criteria);
  }

  #onChange(change: FrameXmlAchievementChange): void {
    const pump = this.#pump;
    if (!pump) return;
    switch (change.kind) {
      case "list":
        this.#revision += 1;
        this.#criteriaDirty = true;
        pump.fire(FRAMEXML_ACHIEVEMENT_EVENTS.list);
        this.onAvailabilityChanged?.();
        return;
      case "earned":
        // Another player's achievement near this one: its chat line is CHAT_MSG_ACHIEVEMENT's.
        if (!change.mine) return;
        this.#revision += 1;
        this.onAvailabilityChanged?.();
        // An earned achievement leaves the watch list (it cannot be tracked once earned, and would
        // keep one of the ten slots): the core sends the last SMSG_CRITERIA_UPDATE before
        // SMSG_ACHIEVEMENT_EARNED, so nothing else redraws the WatchFrame without it. First, so the
        // window's ACHIEVEMENT_EARNED redraw already reads it untracked.
        if (this.#tracked.includes(change.achievementId)) this.removeTracked(change.achievementId);
        if (this.#owned) {
          pump.fire(FRAMEXML_ACHIEVEMENT_EVENTS.earned, change.achievementId);
        } else if (this.onLoadRequest) {
          // AlertFrame_OnEvent loads the add-on for its toast; here that load is the host's.
          this.#earnedQueue.push(change.achievementId);
          this.onLoadRequest();
        }
        return;
      case "criteria":
        this.#revision += 1;
        this.#criteriaDirty = true;
        if (this.#owned) this.#trackedCriteria(pump, change.criteriaId, change.timeElapsed);
        return;
      case "deleted":
        this.#revision += 1;
        this.#criteriaDirty = true;
        this.onAvailabilityChanged?.();
        return;
      case "inspect":
        if (this.#owned && change.guid === this.#compareGuid) pump.fire(FRAMEXML_ACHIEVEMENT_EVENTS.inspect);
        return;
    }
  }

  /** TRACKED_ACHIEVEMENT_UPDATE for a tracked achievement's criterion, with its clock when timed. */
  #trackedCriteria(pump: FrameXmlAchievementPump, criteriaId: number, elapsed: number): void {
    const catalog = this.#catalog;
    const criterion = catalog?.criteria.get(criteriaId);
    if (!criterion) return;
    // The tracked achievements this criterion counts for: its own, and one that borrows its
    // achievement's criteria (`sharesCriteria`, «Счастливые часы» over a statistic's).
    for (const tracked of this.#tracked) {
      if (tracked !== criterion.achievement && catalog!.achievements.get(tracked)?.sharesCriteria !== criterion.achievement) continue;
      if (criterion.timerTime > 0) {
        pump.fire(FRAMEXML_ACHIEVEMENT_EVENTS.tracked, tracked, criteriaId, elapsed, criterion.timerTime);
      } else {
        pump.fire(FRAMEXML_ACHIEVEMENT_EVENTS.tracked, tracked, criteriaId);
      }
    }
  }

  // --- progress ---------------------------------------------------------------------------------

  #completedDate(id: number): number | undefined {
    return this.#world.completed().get(id);
  }

  #counter(criteriaId: number, source?: FrameXmlAchievementInspect): number | undefined {
    const value = (source ? source.criteria : this.#world.criteria()).get(criteriaId);
    return value === undefined ? undefined : Number(value);
  }

  /** AchievementMgr::IsCompletedCriteria, over this player's (or the inspected player's) counters. */
  #criterionDone(criterion: FrameXmlAchievementCriterion, entry: FrameXmlAchievementEntry | undefined,
    source?: FrameXmlAchievementInspect): boolean {
    if (!entry || (entry.flags & ACHIEVEMENT_FLAG_COUNTER) !== 0) return false;
    const counter = this.#counter(criterion.id, source);
    if (counter === undefined) return false;
    if (QUANTITY_TYPES.has(criterion.type)) return counter >= criterion.quantity;
    if (ONCE_TYPES.has(criterion.type)) return counter >= 1;
    if (criterion.type === LEARN_SKILL_LEVEL) return counter >= criterion.quantity * 75;
    if (criterion.type === EARN_ACHIEVEMENT_POINTS) return counter >= 9000;
    if (criterion.type === WIN_ARENA) return criterion.quantity > 0 && counter >= criterion.quantity;
    return criterion.type === ON_LOGIN;
  }

  #factionAllows(entry: FrameXmlAchievementEntry): boolean {
    const faction = this.#world.faction();
    return entry.faction < 0 || faction === undefined || entry.faction === faction;
  }

  #view(categoryId: number): CategoryView {
    const catalog = this.#catalog;
    if (!catalog) return EMPTY_VIEW;
    const cached = this.#views.get(categoryId);
    if (cached && cached.revision === this.#revision) return cached;
    const feats = catalog.isFeatsOfStrength(categoryId);
    const listed = catalog.inCategory(categoryId).filter((entry) => this.#factionAllows(entry)
      && (!feats || this.#completedDate(entry.id) !== undefined));
    const done = (entry: FrameXmlAchievementEntry): boolean => this.#completedDate(entry.id) !== undefined;
    const shownEarned: FrameXmlAchievementEntry[] = [];
    const shownOpen: FrameXmlAchievementEntry[] = [];
    let allCompleted = 0;
    for (const entry of listed) {
      if (done(entry)) allCompleted += 1;
      const previous = entry.supercedes > 0 ? catalog.achievements.get(entry.supercedes) : undefined;
      const next = catalog.nextOf(entry.id).filter((candidate) => this.#factionAllows(candidate));
      if (done(entry)) {
        // The last earned step of its chain.
        if (!next.some(done)) shownEarned.push(entry);
      } else if (!previous || done(previous) || !this.#factionAllows(previous)) {
        // The first unearned step.
        shownOpen.push(entry);
      }
    }
    const view: CategoryView = {
      revision: this.#revision,
      all: listed,
      allCompleted,
      shown: [...shownEarned, ...shownOpen],
      shownCompleted: shownEarned.length,
    };
    this.#views.set(categoryId, view);
    return view;
  }

  /** Every listed achievement outside the statistics and Feats of Strength, chains in full. */
  #overall(): { total: number; completed: number } {
    const catalog = this.#catalog;
    if (!catalog) return { total: 0, completed: 0 };
    if (this.#totals?.revision === this.#revision) return this.#totals;
    let total = 0;
    let completed = 0;
    for (const id of catalog.achievementCategoryIds) {
      if (catalog.isFeatsOfStrength(id)) continue;
      const view = this.#view(id);
      total += view.all.length;
      completed += view.allCompleted;
    }
    this.#totals = { revision: this.#revision, total, completed };
    return this.#totals;
  }

  // --- the C API ------------------------------------------------------------------------------

  categoryList(): readonly number[] { return this.#catalog?.achievementCategoryIds ?? []; }

  statisticsCategoryList(): readonly number[] { return this.#catalog?.statisticCategoryIds ?? []; }

  /** `name, parentID, flags`; a top-level statistic's parent is -1, as an achievement category's. */
  categoryInfo(id: unknown): readonly [string, number, number] | undefined {
    const category = this.#catalog?.categories.get(intArg(id) ?? 0);
    if (!category) return undefined;
    const parent = category.parent === FRAMEXML_ACHIEVEMENT_STATISTICS_ROOT ? -1 : category.parent;
    return [category.name, parent, 0];
  }

  /** `numAchievements, numCompleted, numIncomplete`; `includeAll` counts every step of a chain. */
  categoryNumAchievements(id: unknown, includeAll: unknown): readonly [number, number, number] {
    const categoryId = intArg(id);
    if (categoryId === COMPARISON_SUMMARY_ID) {
      const overall = this.#overall();
      return [overall.total, overall.completed, overall.total - overall.completed];
    }
    if (categoryId === undefined) return [0, 0, 0];
    const view = this.#view(categoryId);
    const all = includeAll !== undefined && includeAll !== null && includeAll !== false;
    const total = all ? view.all.length : view.shown.length;
    const completed = all ? view.allCompleted : view.shownCompleted;
    return [total, completed, total - completed];
  }

  #entry(id: unknown): FrameXmlAchievementEntry | undefined {
    const achievementId = intArg(id);
    return achievementId === undefined ? undefined : this.#catalog?.achievements.get(achievementId);
  }

  /** `GetAchievementInfo(id)` or `GetAchievementInfo(category, index)`. */
  achievementInfo(first: unknown, second?: unknown): FrameXmlAchievementInfo | undefined {
    let entry: FrameXmlAchievementEntry | undefined;
    const index = intArg(second);
    if (index !== undefined) {
      const categoryId = intArg(first);
      entry = categoryId === undefined ? undefined : this.#view(categoryId).shown[index - 1];
    } else {
      entry = this.#entry(first);
    }
    return entry ? this.#info(entry, this.#completedDate(entry.id)) : undefined;
  }

  #info(entry: FrameXmlAchievementEntry, packed: number | undefined): FrameXmlAchievementInfo {
    const date = frameXmlAchievementDate(packed);
    const completed = packed !== undefined && (entry.flags & ACHIEVEMENT_FLAG_COUNTER) === 0;
    return [
      entry.id, entry.name, entry.points, completed, completed ? date?.[0] : undefined,
      completed ? date?.[1] : undefined, completed ? date?.[2] : undefined, entry.description, entry.flags,
      entry.icon, entry.reward,
    ];
  }

  achievementInfoFromCriteria(criteriaId: unknown): FrameXmlAchievementInfo | undefined {
    const criterion = this.#catalog?.criteria.get(intArg(criteriaId) ?? 0);
    return criterion ? this.achievementInfo(criterion.achievement) : undefined;
  }

  achievementCategory(id: unknown): number | undefined {
    return this.#entry(id)?.category;
  }

  /** The criteria the client lists; an achievement that borrows another's criteria lists those. */
  #criteriaList(entry: FrameXmlAchievementEntry): readonly FrameXmlAchievementCriterion[] {
    const catalog = this.#catalog!;
    const own = catalog.shownCriteriaOf(entry.id);
    return own.length === 0 && entry.sharesCriteria > 0 ? catalog.shownCriteriaOf(entry.sharesCriteria) : own;
  }

  /**
   * An `ACHIEVEMENT_FLAGS_HAS_PROGRESS_BAR` achievement lists one bar instead of its criteria — in the
   * 3.3.5a tables all 22 of them have only hidden criteria (Loremaster, the emblem chain, «По вкусу –
   * как курица») — which is why stock skips such an achievement's criteria in its progressive
   * mini-tooltips (Blizzard_AchievementUI.lua:1335). The bar's maximum follows the core
   * (AchievementMgr::IsCompletedAchievement; DBCEnums.h ACHIEVEMENT_FLAG_BAR "value / max value depend
   * from other flag, by default the last criterion"): SUMM against the criteria's quantity, REQ_COUNT
   * against MinimumCriteria (every criterion when that is 0), otherwise the last criterion's quantity.
   * The criteria are the shared achievement's when the entry names one, as the core tests them.
   */
  #bar(entry: FrameXmlAchievementEntry): AchievementBar | undefined {
    if ((entry.flags & FLAG_BAR) === 0 || (entry.flags & ACHIEVEMENT_FLAG_COUNTER) !== 0) return undefined;
    const criteria = this.#catalog!.criteriaOf(entry.sharesCriteria > 0 ? entry.sharesCriteria : entry.id);
    const last = criteria[criteria.length - 1];
    if (!last) return undefined;
    let required = last.quantity;
    if ((entry.flags & FLAG_SUMM) !== 0) {
      for (const criterion of criteria) required = Math.max(required, criterion.quantity);
    } else if ((entry.flags & FLAG_REQ_COUNT) !== 0) {
      required = entry.minimumCriteria > 0 ? entry.minimumCriteria : criteria.length;
    }
    return required > 0 ? { criteria, required } : undefined;
  }

  /** The bar as `GetAchievementCriteriaInfo(id, 1)` answers it: the counters' sum, the completed count, or the last counter; full once earned. */
  #barInfo(entry: FrameXmlAchievementEntry, bar: AchievementBar): FrameXmlAchievementCriteriaInfo {
    const { criteria, required } = bar;
    const last = criteria[criteria.length - 1]!;
    let quantity = 0;
    if ((entry.flags & FLAG_SUMM) !== 0) {
      for (const criterion of criteria) quantity += this.#counter(criterion.id) ?? 0;
    } else if ((entry.flags & FLAG_REQ_COUNT) !== 0) {
      for (const criterion of criteria) if (this.#criterionDone(criterion, entry)) quantity += 1;
    } else {
      quantity = this.#counter(last.id) ?? 0;
    }
    const earned = this.#completedDate(entry.id) !== undefined;
    const shown = earned ? required : Math.min(quantity, required);
    return [
      entry.description, last.type, shown >= required, shown, required, undefined,
      CRITERIA_FLAG_PROGRESS_BAR, 0, `${shown}/${required}`, 0,
    ];
  }

  numCriteria(id: unknown): number {
    const entry = this.#entry(id);
    if (!entry) return 0;
    return this.#bar(entry) ? 1 : this.#criteriaList(entry).length;
  }

  /** `GetAchievementCriteriaInfo(achievementID, index)` or `GetAchievementCriteriaInfo(criteriaID)`. */
  criteriaInfo(first: unknown, second?: unknown): FrameXmlAchievementCriteriaInfo | undefined {
    const catalog = this.#catalog;
    if (!catalog) return undefined;
    let criterion: FrameXmlAchievementCriterion | undefined;
    let entry: FrameXmlAchievementEntry | undefined;
    const index = intArg(second);
    if (index !== undefined) {
      entry = this.#entry(first);
      const bar = entry ? this.#bar(entry) : undefined;
      if (entry && bar) return index === 1 ? this.#barInfo(entry, bar) : undefined;
      criterion = entry ? this.#criteriaList(entry)[index - 1] : undefined;
    } else {
      criterion = catalog.criteria.get(intArg(first) ?? 0);
      entry = criterion ? catalog.achievements.get(criterion.achievement) : undefined;
    }
    if (!criterion) return undefined;
    const owner = catalog.achievements.get(criterion.achievement) ?? entry;
    const quantity = this.#counter(criterion.id) ?? 0;
    const money = (criterion.flags & CRITERIA_FLAG_MONEY) !== 0;
    const quantityString = money
      ? `${frameXmlAchievementMoney(quantity)} / ${frameXmlAchievementMoney(criterion.quantity)}`
      : (criterion.flags & CRITERIA_FLAG_PROGRESS_BAR) !== 0 || criterion.quantity > 1
        ? `${quantity}/${criterion.quantity}`
        : String(quantity);
    return [
      criterion.description, criterion.type, this.#criterionDone(criterion, owner), quantity, criterion.quantity,
      undefined, criterion.flags, criterion.asset, quantityString, criterion.id,
    ];
  }

  /**
   * `|cffffff00|Hachievement:id:GUID:completed:month:day:year:c1:c2:c3:c4|h[name]|h|r`. An earned
   * achievement carries its date and every criteria bit; an unearned one `0:0:0:-1` and the bits of
   * the criteria done so far, by position in the listed criteria.
   */
  achievementLink(id: unknown, guid = this.#world.selfGuid(), earnedOn?: number): string | undefined {
    const entry = this.#entry(id);
    if (!entry) return undefined;
    const packed = earnedOn ?? this.#completedDate(entry.id);
    const date = frameXmlAchievementDate(packed);
    let fields: string;
    if (packed !== undefined && date) {
      fields = `1:${date[0]}:${date[1]}:${date[2]}:${ALL_CRITERIA}:${ALL_CRITERIA}:${ALL_CRITERIA}:${ALL_CRITERIA}`;
    } else {
      const masks = [0, 0, 0, 0];
      this.#criteriaList(entry).forEach((criterion, index) => {
        if (index >= 128 || !this.#criterionDone(criterion, entry)) return;
        const slot = index >> 5;
        masks[slot] = (masks[slot] ?? 0) | (1 << (index & 31));
      });
      fields = `0:0:0:-1:${masks.map((mask) => mask >>> 0).join(":")}`;
    }
    return `${LINK_COLOUR}|Hachievement:${entry.id}:${guidText(guid)}:${fields}|h[${entry.name}]|h|r`;
  }

  /** The table's one reward column: the title or item the achievement grants, or nothing. */
  numRewards(id: unknown): number {
    return this.#entry(id)?.reward ? 1 : 0;
  }

  reward(id: unknown, index: unknown): string | undefined {
    const entry = this.#entry(id);
    return entry?.reward && (intArg(index) ?? 1) === 1 ? entry.reward : undefined;
  }

  numCompleted(): readonly [total: number, completed: number] {
    const overall = this.#overall();
    return [overall.total, overall.completed];
  }

  totalPoints(source?: FrameXmlAchievementInspect): number {
    const catalog = this.#catalog;
    if (!catalog) return 0;
    let points = 0;
    for (const id of (source ? source.completed : this.#world.completed()).keys()) {
      points += catalog.achievements.get(id)?.points ?? 0;
    }
    return points;
  }

  /** Up to five, the most recently earned first (packed dates order by minute; ties by id). */
  latestCompleted(source?: FrameXmlAchievementInspect): readonly number[] {
    const catalog = this.#catalog;
    if (!catalog) return [];
    return [...(source ? source.completed : this.#world.completed()).entries()]
      .filter(([id]) => catalog.achievements.has(id))
      .sort((left, right) => right[1] - left[1] || right[0] - left[0])
      .slice(0, 5)
      .map(([id]) => id);
  }

  /**
   * A statistic's value as the window prints it: the sum of its criteria (`ACHIEVEMENT_FLAG_SUMM`,
   * or the one criterion most statistics have), the name of the busiest criterion for a «most …»
   * statistic (`_MAX_USED`, whose criteria are the ones it `shares`), copper as coins. Undefined
   * — the window's "--" — before any criterion has counted, and for the per-day averages, which
   * divide by a character age this client is never told.
   */
  statistic(id: unknown, source?: FrameXmlAchievementInspect): string | undefined {
    const entry = this.#entry(id);
    const catalog = this.#catalog;
    if (!entry || !catalog || (entry.flags & FLAG_AVERAGE) !== 0) return undefined;
    const own = catalog.criteriaOf(entry.id);
    const criteria = own.length === 0 && entry.sharesCriteria > 0 ? catalog.criteriaOf(entry.sharesCriteria) : own;
    let best: FrameXmlAchievementCriterion | undefined;
    let bestValue = 0;
    let sum = 0;
    let counted = false;
    let money = false;
    for (const criterion of criteria) {
      const value = this.#counter(criterion.id, source);
      if (value === undefined) continue;
      counted = true;
      money ||= (criterion.flags & CRITERIA_FLAG_MONEY) !== 0;
      sum += value;
      if (!best || value > bestValue) {
        best = criterion;
        bestValue = value;
      }
    }
    if (!counted) return undefined;
    if ((entry.flags & FLAG_MAX_USED) !== 0) return bestValue > 0 ? best?.description : undefined;
    const value = (entry.flags & FLAG_SUMM) !== 0 || criteria.length > 1 ? sum : bestValue;
    return money ? frameXmlAchievementMoney(value) : String(value);
  }

  /** `GetPreviousAchievement`: the step before, when the table names one. */
  previous(id: unknown): number | undefined {
    const entry = this.#entry(id);
    return entry && entry.supercedes > 0 && this.#catalog?.achievements.has(entry.supercedes) ? entry.supercedes : undefined;
  }

  /** `GetNextAchievement`: `nextID, completed` of the step after, for this player's side. */
  next(id: unknown): readonly [number, boolean] | undefined {
    const entry = this.#entry(id);
    if (!entry) return undefined;
    const next = this.#catalog!.nextOf(entry.id).find((candidate) => this.#factionAllows(candidate));
    return next ? [next.id, this.#completedDate(next.id) !== undefined] : undefined;
  }

  hasCompletedAny(): boolean {
    return this.#world.completed().size > 0;
  }

  // --- tracking -------------------------------------------------------------------------------

  trackedAchievements(): readonly number[] { return this.#tracked; }

  isTracked(id: unknown): boolean {
    const achievementId = intArg(id);
    return achievementId !== undefined && this.#tracked.includes(achievementId);
  }

  /** The watch list is the stock window's: nothing can be tracked before it is loaded. */
  addTracked(id: unknown): void {
    const entry = this.#entry(id);
    if (!entry || !this.#owned || this.#tracked.includes(entry.id) || this.#tracked.length >= MAX_TRACKED) return;
    this.#tracked.push(entry.id);
    this.#pump?.fire(FRAMEXML_ACHIEVEMENT_EVENTS.tracked);
  }

  removeTracked(id: unknown): void {
    const at = this.#tracked.indexOf(intArg(id) ?? 0);
    if (at < 0) return;
    this.#tracked.splice(at, 1);
    this.#pump?.fire(FRAMEXML_ACHIEVEMENT_EVENTS.tracked);
  }

  // --- comparison -----------------------------------------------------------------------------

  /** Ask the server for another player's achievements (the answer raises INSPECT_ACHIEVEMENT_READY). */
  setComparisonGuid(guid: bigint | undefined): void {
    this.#compareGuid = guid;
    if (guid !== undefined && guid !== 0n) this.#world.queryInspect(guid);
  }

  clearComparison(): void {
    this.#compareGuid = undefined;
  }

  /** The answer about the compared player, once it has arrived; neutral otherwise. */
  #compared(): FrameXmlAchievementInspect | undefined {
    const data = this.#world.inspect();
    return data && this.#compareGuid !== undefined && data.guid === this.#compareGuid ? data : undefined;
  }

  comparisonInfo(id: unknown): readonly [boolean, number | undefined, number | undefined, number | undefined] {
    const entry = this.#entry(id);
    const packed = entry ? this.#compared()?.completed.get(entry.id) : undefined;
    const date = frameXmlAchievementDate(packed);
    return packed === undefined || !date ? [false, undefined, undefined, undefined] : [true, date[0], date[1], date[2]];
  }

  comparisonPoints(): number {
    const data = this.#compared();
    return data ? this.totalPoints(data) : 0;
  }

  /** The compared player's earned count over the same list this player's category shows. */
  comparisonCategoryCompleted(id: unknown): number {
    const data = this.#compared();
    const categoryId = intArg(id);
    if (!data || categoryId === undefined) return 0;
    if (categoryId === COMPARISON_SUMMARY_ID) return this.comparisonNumCompleted()[1];
    return this.#view(categoryId).shown.filter((entry) => data.completed.has(entry.id)).length;
  }

  comparisonNumCompleted(): readonly [number, number] {
    const data = this.#compared();
    const catalog = this.#catalog;
    const [total] = this.numCompleted();
    if (!data || !catalog) return [total, 0];
    let completed = 0;
    for (const id of data.completed.keys()) {
      const entry = catalog.achievements.get(id);
      const category = entry ? catalog.categories.get(entry.category) : undefined;
      if (entry && category && !category.statistics && !catalog.isFeatsOfStrength(category.id)) completed += 1;
    }
    return [total, completed];
  }

  comparisonStatistic(id: unknown): string | undefined {
    const data = this.#compared();
    return data ? this.statistic(id, data) : undefined;
  }

  latestComparisonCompleted(): readonly number[] {
    const data = this.#compared();
    return data ? this.latestCompleted(data) : [];
  }

  /** Whose achievement link this is (its 16-digit GUID field): `true` for this player, else the cached name. */
  linkPlayer(guidHex: string): true | string | undefined {
    if (!/^[0-9a-f]{16}$/i.test(guidHex)) return undefined;
    const guid = BigInt(`0x${guidHex}`);
    if (guid === 0n) return undefined;
    return guid === this.#world.selfGuid() ? true : this.#world.name?.(guid);
  }

  // --- the chat line --------------------------------------------------------------------------

  /**
   * CHAT_MSG_ACHIEVEMENT and CHAT_MSG_GUILD_ACHIEVEMENT carry BroadcastText 29245 («%s
   * $gзаслужил:заслужила; достижение $a!») and the achievement id; the client writes the link for
   * `$a` and the earner's gender for `$g` before ChatFrame formats the name into `%s`. Answers the
   * line to show now, or undefined when it waits for the catalog (`emit` then shows it once the
   * catalog is in, or, if it cannot be had, with the id standing for the name).
   */
  chatLine(message: ChatMessage, emit: (message: ChatMessage) => void): ChatMessage | undefined {
    if ((message.type !== CHAT_MSG_ACHIEVEMENT && message.type !== CHAT_MSG_GUILD_ACHIEVEMENT)
      || message.achievementId <= 0 || !/\$a|\$g/i.test(message.text)) return message;
    if (this.#catalog || !this.#catalogSource) return this.#writeLine(message);
    this.#heldLines.push({ message, emit });
    void this.loadCatalog();
    return undefined;
  }

  #releaseHeldLines(): void {
    for (const held of this.#heldLines.splice(0)) held.emit(this.#writeLine(held.message));
  }

  #writeLine(message: ChatMessage): ChatMessage {
    const female = this.#world.gender(message.senderGuid) === 1;
    const now = new Date();
    // The link a chat line carries is dated the moment it is read, in the client's own clock.
    const packed = ((now.getFullYear() % 100) << 24) | (now.getMonth() << 20) | ((now.getDate() - 1) << 14)
      | (now.getDay() << 11) | (now.getHours() << 6) | now.getMinutes();
    const link = this.achievementLink(message.achievementId, message.senderGuid, packed)
      ?? `${LINK_COLOUR}|Hachievement:${message.achievementId}:${guidText(message.senderGuid)}:1:${now.getMonth() + 1}:${now.getDate()}:${now.getFullYear() % 100}:${ALL_CRITERIA}:${ALL_CRITERIA}:${ALL_CRITERIA}:${ALL_CRITERIA}|h[${message.achievementId}]|h|r`;
    const text = message.text
      .replace(GENDER, (_whole, male: string, femaleForm: string) => (female ? femaleForm : male).trim())
      .replace(/\$a/gi, link);
    return { ...message, text };
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlAchievementHost {
  readonly achievement?: FrameXmlAchievementModel | undefined;
  unitGuid?(unit: string): string | undefined;
}

export type FrameXmlAchievementBinding = (host: FrameXmlAchievementHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

const withModel = (answer: (model: FrameXmlAchievementModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlAchievementBinding =>
  (host, args) => host.achievement ? answer(host.achievement, args) : NOTHING;

const command = (run: (model: FrameXmlAchievementModel, args: readonly unknown[], host: FrameXmlAchievementHost) => void): FrameXmlAchievementBinding =>
  (host, args) => {
    if (host.achievement) run(host.achievement, args, host);
    return NOTHING;
  };

/** `UnitGUID`'s text back to the number the inspect query sends. */
function guidOf(text: string | undefined): bigint | undefined {
  if (!text || !/^0x[0-9a-f]{1,16}$/i.test(text)) return undefined;
  const guid = BigInt(text);
  return guid === 0n ? undefined : guid;
}

/**
 * The flat C API, spread into FRAMEXML_SEAM_BINDINGS. Without a model, or before the catalog has
 * loaded, every name answers the client's "nothing known" (empty lists, zero counts, nil info).
 */
export const FRAMEXML_ACHIEVEMENT_BINDINGS: Readonly<Record<string, FrameXmlAchievementBinding>> = Object.freeze({
  GetCategoryList: (host) => [[...(host.achievement?.categoryList() ?? [])]],
  GetStatisticsCategoryList: (host) => [[...(host.achievement?.statisticsCategoryList() ?? [])]],
  GetCategoryInfo: withModel((model, args) => model.categoryInfo(args[0]) ?? NOTHING),
  GetCategoryNumAchievements: (host, args) => host.achievement?.categoryNumAchievements(args[0], args[1]) ?? [0, 0, 0],
  GetAchievementInfo: withModel((model, args) => model.achievementInfo(args[0], args[1]) ?? NOTHING),
  GetAchievementInfoFromCriteria: withModel((model, args) => model.achievementInfoFromCriteria(args[0]) ?? NOTHING),
  GetAchievementCategory: withModel((model, args) => optional(model.achievementCategory(args[0]))),
  GetAchievementNumCriteria: (host, args) => [host.achievement?.numCriteria(args[0]) ?? 0],
  GetAchievementCriteriaInfo: withModel((model, args) => model.criteriaInfo(args[0], args[1]) ?? NOTHING),
  GetAchievementLink: withModel((model, args) => optional(model.achievementLink(args[0]))),
  GetAchievementNumRewards: (host, args) => [host.achievement?.numRewards(args[0]) ?? 0],
  GetAchievementReward: withModel((model, args) => optional(model.reward(args[0], args[1]))),
  GetNumCompletedAchievements: (host) => host.achievement?.numCompleted() ?? [0, 0],
  GetTotalAchievementPoints: (host) => [host.achievement?.totalPoints() ?? 0],
  GetLatestCompletedAchievements: (host) => host.achievement?.latestCompleted() ?? NOTHING,
  GetStatistic: withModel((model, args) => optional(model.statistic(args[0]))),
  GetPreviousAchievement: withModel((model, args) => optional(model.previous(args[0]))),
  GetNextAchievement: withModel((model, args) => model.next(args[0]) ?? NOTHING),
  HasCompletedAnyAchievement: (host) => [host.achievement?.hasCompletedAny() === true],
  CanShowAchievementUI: (host) => [host.achievement?.available === true],
  GetTrackedAchievements: (host) => host.achievement?.trackedAchievements() ?? NOTHING,
  GetNumTrackedAchievements: (host) => [host.achievement?.trackedAchievements().length ?? 0],
  IsTrackedAchievement: (host, args) => [host.achievement?.isTracked(args[0]) === true],
  AddTrackedAchievement: command((model, args) => model.addTracked(args[0])),
  RemoveTrackedAchievement: command((model, args) => model.removeTracked(args[0])),
  SetAchievementComparisonUnit: command((model, args, host) => {
    model.setComparisonGuid(typeof args[0] === "string" ? guidOf(host.unitGuid?.(args[0].toLowerCase())) : undefined);
  }),
  ClearAchievementComparisonUnit: command((model) => model.clearComparison()),
  GetAchievementComparisonInfo: (host, args) => host.achievement?.comparisonInfo(args[0]) ?? [false],
  GetComparisonAchievementPoints: (host) => [host.achievement?.comparisonPoints() ?? 0],
  GetComparisonCategoryNumAchievements: (host, args) => [host.achievement?.comparisonCategoryCompleted(args[0]) ?? 0],
  GetComparisonStatistic: withModel((model, args) => optional(model.comparisonStatistic(args[0]))),
  GetNumComparisonCompletedAchievements: (host) => host.achievement?.comparisonNumCompleted() ?? [0, 0],
  GetLatestCompletedComparisonAchievements: (host) => host.achievement?.latestComparisonCompleted() ?? NOTHING,
});

