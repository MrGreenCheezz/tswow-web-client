/**
 * The offline achievements: a scripted world for `CannedWorldSeam`, its tests and the
 * `framexml.html?achievement=` preview, over the canned catalog (FrameXmlAchievementCannedData.ts,
 * dataset rows). The progress below — which achievements the canned Alliance character has earned,
 * when, and how far each criterion has come — is the fixture's, chosen to put every row kind on
 * screen: an earned and an open step of each chain, a half-full progress bar, a partial
 * exploration, statistics with and without data. The comparison answers for `party1`, a player.
 */
import {
  FrameXmlAchievementCatalog,
  type FrameXmlAchievementCatalogSource,
} from "./FrameXmlAchievementCatalog.js";
import {
  FrameXmlAchievementModel,
  type FrameXmlAchievementChange,
  type FrameXmlAchievementInspect,
  type FrameXmlAchievementWorld,
} from "./FrameXmlAchievement.js";
import { FRAMEXML_ACHIEVEMENT_CANNED_CATALOG } from "./FrameXmlAchievementCannedData.js";

/** WowTime::GetPackedTime for a fixture moment (the weekday is the calendar's). */
export function cannedAchievementDate(year: number, month: number, day: number, hour = 12, minute = 0): number {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return ((year % 100) << 24) | ((month - 1) << 20) | ((day - 1) << 14) | (weekday << 11) | (hour << 6) | minute;
}

/** `CANNED_UNIT_GUIDS.player` and `.party1` (CannedWorldSeam.ts). */
export const CANNED_ACHIEVEMENT_SELF = 0x1n;
export const CANNED_ACHIEVEMENT_PARTY1 = 0x11n;

const EARNED: readonly (readonly [number, number])[] = [
  [6, cannedAchievementDate(2026, 8, 30, 20, 14)],
  [7, cannedAchievementDate(2026, 9, 3, 21, 2)],
  [545, cannedAchievementDate(2026, 9, 5, 18, 40)],
  [1017, cannedAchievementDate(2026, 9, 7, 19, 5)],
  [1176, cannedAchievementDate(2026, 9, 12, 22, 31)],
  [121, cannedAchievementDate(2026, 9, 14, 17, 0)],
  [411, cannedAchievementDate(2026, 9, 20, 18, 30)],
];

const PROGRESS: readonly (readonly [number, bigint])[] = [
  [34, 10n], [35, 20n], [36, 25n], // levels 10 and 20 reached, 25 of 30
  [3506, 1_500_000n], [3507, 1_500_000n], // 150 gold looted, towards 100 (done) and 1,000
  [167, 150n], // unarmed skill 150 of 400: a progress bar
  [230, 37n], // 37 of 50 quests: a progress bar
  [1146, 1n], [1147, 1n], [1149, 1n], // three of Elwynn Forest's twelve areas
  [168, 150n], // cooking journeyman
  [111, 42n], // total deaths
  [4948, 120n], [4953, 310n], // beasts and humanoids killed: the creature sum
  [3631, 37n], [4984, 3n], // quests completed, dailies
  [4091, 1_234_567n], [4093, 98_765n], // copper from vendors and loot: the money sum
  [3301, 4n], [3305, 11n], // bandages: the «most used» statistic names the busier one
];

export interface CannedFrameXmlAchievementWorld extends FrameXmlAchievementWorld {
  /** Earn one as SMSG_ACHIEVEMENT_EARNED would (the toast, ACHIEVEMENT_EARNED). */
  earn(achievementId: number, mine?: boolean): void;
  /** One SMSG_CRITERIA_UPDATE. */
  progress(criteriaId: number, counter: bigint, timeElapsed?: number): void;
  /** Queries CMSG_QUERY_INSPECT_ACHIEVEMENTS sent, by guid. */
  readonly inspectQueries: bigint[];
}

export interface CannedFrameXmlAchievements {
  readonly model: FrameXmlAchievementModel;
  readonly world: CannedFrameXmlAchievementWorld;
  readonly catalog: FrameXmlAchievementCatalog;
}

export function createCannedFrameXmlAchievements(): CannedFrameXmlAchievements {
  const catalog = FrameXmlAchievementCatalog.fromJson(JSON.parse(JSON.stringify(FRAMEXML_ACHIEVEMENT_CANNED_CATALOG)));
  if (!catalog) throw new Error("the canned achievement catalog does not match its own shape");
  const completed = new Map<number, number>(EARNED);
  const criteria = new Map<number, bigint>(PROGRESS);
  const listeners = new Set<(change: FrameXmlAchievementChange) => void>();
  let inspect: FrameXmlAchievementInspect | undefined;
  const emit = (change: FrameXmlAchievementChange): void => { for (const listener of [...listeners]) listener(change); };
  const inspectQueries: bigint[] = [];
  const world: CannedFrameXmlAchievementWorld = {
    completed: () => completed,
    criteria: () => criteria,
    faction: () => 1,
    selfGuid: () => CANNED_ACHIEVEMENT_SELF,
    inspect: () => inspect,
    queryInspect: (guid) => {
      inspectQueries.push(guid);
      if (guid !== CANNED_ACHIEVEMENT_PARTY1) return;
      // The core answers in the same tick it reads the query; the answer lands a microtask later.
      queueMicrotask(() => {
        inspect = {
          guid,
          completed: new Map([
            [6, cannedAchievementDate(2026, 7, 2)], [7, cannedAchievementDate(2026, 7, 9)],
            [8, cannedAchievementDate(2026, 7, 21)], [1176, cannedAchievementDate(2026, 8, 1)],
            [1177, cannedAchievementDate(2026, 8, 19)], [545, cannedAchievementDate(2026, 8, 3)],
          ]),
          criteria: new Map([[111, 7n], [4948, 50n], [3631, 120n]]),
        };
        emit({ kind: "inspect", guid });
      });
    },
    gender: (guid) => guid === CANNED_ACHIEVEMENT_SELF ? 0 : undefined,
    // `party1`'s name in CannedWorldSeam's roster, as the name cache would hold it.
    name: (guid) => guid === CANNED_ACHIEVEMENT_PARTY1 ? "Альфа" : undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    earn: (achievementId, mine = true) => {
      const now = new Date();
      if (mine) {
        completed.set(achievementId, cannedAchievementDate(now.getFullYear(), now.getMonth() + 1, now.getDate(),
          now.getHours(), now.getMinutes()));
      }
      emit({ kind: "earned", achievementId, mine });
    },
    progress: (criteriaId, counter, timeElapsed = 0) => {
      criteria.set(criteriaId, counter);
      emit({ kind: "criteria", criteriaId, timeElapsed });
    },
    inspectQueries,
  };
  const model = new FrameXmlAchievementModel(world);
  const source: FrameXmlAchievementCatalogSource = { load: () => Promise.resolve(catalog) };
  model.catalogSource = source;
  return { model, world, catalog };
}
