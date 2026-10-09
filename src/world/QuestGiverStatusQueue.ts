/**
 * When to ask for the marks over heads (WORK_PLAN 5.23), batched so a city does not cost a burst.
 *
 * What Wow.exe 3.3.5a (12340) asks and when (`.runtime/re-2026-10-02/a3-mech/`, d1–d4):
 * * one `CMSG_QUESTGIVER_STATUS_QUERY` (0x6d5000 through 0x6d5080) for a unit or game object that
 *   gives quests, from its per-object refresh (unit 0x729f40, game object 0x7111a0); the unit
 *   refresh also sends `CMSG_TAXINODE_STATUS_QUERY` (0x6d5130) for a flight master
 *   (UNIT_NPC_FLAGS bit 13);
 * * one `CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY` (0x6d50c0, 0x6dc5a0) when the quest log or what it
 *   depends on changes — a quest-log slot of the player (0x6df370), the daily count (0x6d9f20),
 *   looted money (0x6da070), a profession skill (0x6da4a0), a quest event (0x5e1250, 0x5e57e0) — and
 *   when the character comes back to life or into the world (0x73d530, 0x6df710, 0x71f8f0).
 * The original has no timer. This client keeps a slow one (`SAFETY_MS`) instead of the old five
 * seconds: the core announces a neighbour's change of status only to a player whose own quests
 * changed (5.23 risk 1).
 *
 * Batching, where the original sends each at once: at most `PER_PUMP` single queries per frame, a
 * guid asked at most once per `REASK_MS`, quest-log changes folded into one sweep after
 * `DEBOUNCE_MS`, and a single query dropped when a sweep is already due — the sweep answers for every
 * quest giver the server has in view, which includes it. Pure: no clock, no socket.
 */

import { PacketWriter } from "../protocol/PacketWriter.js";

/** `CMSG_QUESTGIVER_STATUS_QUERY`: the guid alone (QuestHandler.cpp:47; Wow.exe 0x6d5000). */
export function buildQuestGiverStatusQuery(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export interface QuestGiverStatusSink {
  /** `CMSG_QUESTGIVER_STATUS_QUERY` for one guid. */
  queryOne(guid: bigint): void;
  /** `CMSG_TAXINODE_STATUS_QUERY` for one flight master. */
  queryTaxi(guid: bigint): void;
  /** `CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY`: every quest giver in view. */
  queryAll(): void;
}

/** What made an object worth asking about. */
export interface QuestGiverCandidate {
  readonly questGiver: boolean;
  readonly flightMaster: boolean;
}

export class QuestGiverStatusQueue {
  static readonly PER_PUMP = 8;
  static readonly REASK_MS = 30_000;
  static readonly DEBOUNCE_MS = 300;
  static readonly SAFETY_MS = 60_000;

  readonly #sink: QuestGiverStatusSink;
  /** Insertion-ordered: first noticed, first asked. */
  readonly #quest = new Set<bigint>();
  readonly #taxi = new Set<bigint>();
  readonly #questAskedAt = new Map<bigint, number>();
  readonly #taxiAskedAt = new Map<bigint, number>();
  /** When the folded sweep goes out; undefined while none is due. */
  #sweepAt: number | undefined;
  /** The last sweep; undefined until the first pump, which starts the safety interval. */
  #lastSweepAt: number | undefined;

  constructor(sink: QuestGiverStatusSink) {
    this.#sink = sink;
  }

  /** A unit or game object arrived, or its flags changed: queue what it calls for. */
  noticed(guid: bigint, candidate: QuestGiverCandidate, now: number): void {
    if (candidate.questGiver && this.#sweepAt === undefined && !this.#recent(this.#questAskedAt, guid, now)) this.#quest.add(guid);
    if (candidate.flightMaster && !this.#recent(this.#taxiAskedAt, guid, now)) this.#taxi.add(guid);
  }

  /**
   * The object left view: nothing more to ask about it until it comes back — and then at once, as
   * Wow.exe's refresh of the new object does; `REASK_MS` only spaces out flag changes in view.
   */
  forget(guid: bigint): void {
    this.#quest.delete(guid);
    this.#taxi.delete(guid);
    this.#questAskedAt.delete(guid);
    this.#taxiAskedAt.delete(guid);
  }

  /** Something the marks depend on changed: one sweep, `DEBOUNCE_MS` after the first such change. */
  sweepSoon(now: number): void {
    this.#sweepAt ??= now + QuestGiverStatusQueue.DEBOUNCE_MS;
    // The sweep answers for every quest giver in view, so the singles waiting now are covered.
    this.#quest.clear();
  }

  /** A sweep went out some other way (the one asked for at world entry): it counts as this one. */
  swept(now: number): void {
    this.#sweepAt = undefined;
    this.#lastSweepAt = now;
    this.#quest.clear();
  }

  /** Once per frame. Sends what is due and no more than `PER_PUMP` single queries. */
  pump(now: number): void {
    this.#lastSweepAt ??= now;
    if (this.#sweepAt !== undefined ? now >= this.#sweepAt : now - this.#lastSweepAt >= QuestGiverStatusQueue.SAFETY_MS) {
      this.swept(now);
      this.#sink.queryAll();
    }
    // Per frame and usually with nothing waiting: no closure, no array — two size checks.
    if (this.#quest.size === 0 && this.#taxi.size === 0) return;
    let budget = QuestGiverStatusQueue.PER_PUMP;
    for (const guid of this.#quest) {
      if (budget <= 0) break;
      this.#quest.delete(guid);
      this.#questAskedAt.set(guid, now);
      this.#sink.queryOne(guid);
      budget--;
    }
    for (const guid of this.#taxi) {
      if (budget <= 0) break;
      this.#taxi.delete(guid);
      this.#taxiAskedAt.set(guid, now);
      this.#sink.queryTaxi(guid);
      budget--;
    }
    if (budget < QuestGiverStatusQueue.PER_PUMP) {
      QuestGiverStatusQueue.#prune(this.#questAskedAt, now);
      QuestGiverStatusQueue.#prune(this.#taxiAskedAt, now);
    }
  }

  /** A new map: everything asked before is about objects that are gone. */
  reset(now: number): void {
    this.#quest.clear();
    this.#taxi.clear();
    this.#questAskedAt.clear();
    this.#taxiAskedAt.clear();
    this.#sweepAt = undefined;
    this.#lastSweepAt = now;
  }

  /** Waiting single queries, for diagnostics and tests. */
  get pending(): number {
    return this.#quest.size + this.#taxi.size;
  }

  #recent(askedAt: Map<bigint, number>, guid: bigint, now: number): boolean {
    const at = askedAt.get(guid);
    return at !== undefined && now - at < QuestGiverStatusQueue.REASK_MS;
  }

  /** The memory of what was asked only has to outlive REASK_MS; pruned after a send, when it grew. */
  static #prune(askedAt: Map<bigint, number>, now: number): void {
    if (askedAt.size <= 512) return;
    for (const [guid, at] of askedAt) if (now - at >= QuestGiverStatusQueue.REASK_MS) askedAt.delete(guid);
  }
}
