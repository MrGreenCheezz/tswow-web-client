/**
 * 3.24 (12.10): the client's one battlefield-list state and the C API over it — the battlemaster's
 * stock BattlefieldFrame (BattlefieldFrame.lua:380-584) reads it, as PVPBattlegroundFrame does.
 *
 * Wow.exe keeps a single list (read-only Ghidra, `.runtime/re-2026-10-11/glue-1110/bf324-*.txt`):
 *   0x00bea53c the current BattlemasterList id — written by the SMSG_BATTLEFIELD_LIST handler (0x0054e390)
 *              and at once by RequestBattlegroundInstanceInfo (0x0054e5b0), before the answer;
 *   0x00bea568 the battlemaster's guid — set by 0x005496d0 for a battlemaster's list (or 0x0054e390 for a
 *              random battleground's), cleared by CloseBattlefield (0x00549b40) and 0x005496d0(0);
 *   0x00bea5c4[0x00bea5c0] the instance ids of the last list (every list, the PvP tab's too);
 *   0x00bea538 the selected instance id, 0 = «first available» (SetSelectedBattlefield 0x0054bb40).
 *
 * The list handler 0x0054e390, after storing the packet: a random battleground (id 32) with a guid sets the
 * guid and raises NPC_PVPQUEUE_ANYWHERE (0x280: PVPBattlegroundFrame opens PVPParentFrame «just BG»);
 * otherwise a list asked from the PvP tab (`fromWhere` ≠ 0) raises PVPQUEUE_ANYWHERE_SHOW (0x26e) and
 * leaves the guid alone; a battlemaster's list goes through 0x005496d0 — with a guid it is kept and
 * BATTLEFIELDS_SHOW (0x19b) raised, without one BATTLEFIELDS_CLOSED (0x19c) and the guid cleared — and a
 * guid-less one raises BATTLEFIELDS_SHOW after that close as well.
 *
 * JoinBattlefield(index, asGroup, rated) (0x0054d990 → 0x0054cc70) on a battleground: the group join
 * refuses a party or raid larger than the type's MaxGroupSize (UI error 0x1df,
 * ERR_GROUP_JOIN_BATTLEGROUND_TOO_MANY), any join refuses inside a battleground map (InstanceType 3; UI
 * error 0x1e4, ERR_BATTLEGROUND_NOT_IN_BATTLEGROUND), then CMSG_BATTLEMASTER_JOIN carries the guid, the
 * current type, the instance id at `index - 1` — only with a battlemaster's guid, else 0 — and the group
 * flag. The arena branch (InstanceType 4 → CMSG_BATTLEMASTER_JOIN_ARENA) stays the seams' existing one.
 */
import type { BattlefieldList } from "../../world/PvpProtocol.js";

/** Wow.exe's event ids for the list edges (0x0054e390, 0x005496d0, 0x00549b40). */
export const FRAMEXML_BATTLEFIELD_LIST_EVENTS = Object.freeze({
  show: "BATTLEFIELDS_SHOW",
  closed: "BATTLEFIELDS_CLOSED",
  anywhere: "PVPQUEUE_ANYWHERE_SHOW",
  npcAnywhere: "NPC_PVPQUEUE_ANYWHERE",
} as const);

export type FrameXmlBattlefieldListEvent =
  (typeof FRAMEXML_BATTLEFIELD_LIST_EVENTS)[keyof typeof FRAMEXML_BATTLEFIELD_LIST_EVENTS];

/** BattlemasterList id of the random battleground (0x0054e390 compares with 0x20). */
const RANDOM_BATTLEGROUND = 32;

/** What JoinBattlefield needs to know of the world besides the list (0x0054cc70). */
export interface FrameXmlBattlefieldJoinFacts {
  /** BattlemasterList.MaxGroupSize of the current type, or undefined for a type the catalog lacks. */
  readonly maxGroupSize: number | undefined;
  /** GetNumPartyMembers() and GetNumRaidMembers(). */
  readonly partyMembers: number;
  readonly raidMembers: number;
  /** The player's map is a battleground (Map.InstanceType 3). */
  readonly inBattleground: boolean;
}

export type FrameXmlBattlefieldJoin =
  | { readonly kind: "join"; readonly guid: bigint; readonly bgTypeId: number; readonly instanceId: number; readonly asGroup: boolean }
  | { readonly kind: "refused"; readonly error: "ERR_GROUP_JOIN_BATTLEGROUND_TOO_MANY" | "ERR_BATTLEGROUND_NOT_IN_BATTLEGROUND" }
  | { readonly kind: "none" };

export class FrameXmlBattlefieldListState {
  #type: number | undefined;
  #guid = 0n;
  #instances: readonly number[] = [];
  #selected = 0;

  /** The current BattlemasterList id (0x00bea53c); undefined before any list or request. */
  get type(): number | undefined { return this.#type; }
  /** The battlemaster whose list is open (0x00bea568); 0 for none. */
  get guid(): bigint { return this.#guid; }

  /**
   * SMSG_BATTLEFIELD_LIST, as 0x0054e390 stores it, and the events it raises in order. An absent list
   * (a seam fake, or the world forgetting one) changes nothing and raises the PvP tab's edge.
   */
  receive(list: BattlefieldList | undefined): readonly FrameXmlBattlefieldListEvent[] {
    if (!list) return [FRAMEXML_BATTLEFIELD_LIST_EVENTS.anywhere];
    this.#type = list.bgTypeId;
    this.#instances = Object.freeze([...list.instances]);
    if (list.bgTypeId === RANDOM_BATTLEGROUND && list.battlemasterGuid !== 0n) {
      this.#guid = list.battlemasterGuid;
      return [FRAMEXML_BATTLEFIELD_LIST_EVENTS.npcAnywhere];
    }
    if (list.fromWhere !== 0) return [FRAMEXML_BATTLEFIELD_LIST_EVENTS.anywhere];
    if (list.battlemasterGuid === 0n) {
      this.#guid = 0n;
      return [FRAMEXML_BATTLEFIELD_LIST_EVENTS.closed, FRAMEXML_BATTLEFIELD_LIST_EVENTS.show];
    }
    this.#guid = list.battlemasterGuid;
    return [FRAMEXML_BATTLEFIELD_LIST_EVENTS.show];
  }

  /** The world's reset (0x0054ca50): no type, battlemaster, instances or selection. */
  reset(): void {
    this.#type = undefined;
    this.#guid = 0n;
    this.#instances = [];
    this.#selected = 0;
  }

  /** RequestBattlegroundInstanceInfo (0x0054e5b0): the type is current before the answer comes. */
  request(bgTypeId: number): void {
    this.#type = bgTypeId;
  }

  /** CloseBattlefield (0x00549b40): the guid goes; the caller raises BATTLEFIELDS_CLOSED. */
  close(): void {
    this.#guid = 0n;
  }

  /** GetNumBattlefields (0x0054baa0). */
  count(): number {
    return this.#instances.length;
  }

  /** GetBattlefieldInstanceInfo(index) (0x0054d8f0): nothing outside 1..count. */
  instance(index: number): number | undefined {
    return Number.isInteger(index) && index >= 1 && index <= this.#instances.length ? this.#instances[index - 1] : undefined;
  }

  /** SetSelectedBattlefield(index) (0x0054bb40): an index outside 1..count selects «first available». */
  select(index: number): void {
    this.#selected = this.instance(index) ?? 0;
  }

  /** GetSelectedBattlefield (0x0054bbd0): the selected id's 1-based row, 0 when it is not listed. */
  selectedIndex(): number {
    return this.#instances.indexOf(this.#selected) + 1;
  }

  /** JoinBattlefield's battleground branch (0x0054cc70) for a 1-based `index` (0 = first available). */
  join(index: number, asGroup: boolean, facts: FrameXmlBattlefieldJoinFacts): FrameXmlBattlefieldJoin {
    const type = this.#type;
    if (type === undefined) return { kind: "none" };
    const max = facts.maxGroupSize;
    if (asGroup && max !== undefined && (max < facts.partyMembers || max < facts.raidMembers)) {
      return { kind: "refused", error: "ERR_GROUP_JOIN_BATTLEGROUND_TOO_MANY" };
    }
    if (facts.inBattleground) return { kind: "refused", error: "ERR_BATTLEGROUND_NOT_IN_BATTLEGROUND" };
    const slot = index - 1;
    const instanceId = this.#guid !== 0n && slot >= 0 && slot < this.#instances.length ? this.#instances[slot]! : 0;
    return { kind: "join", guid: this.#guid, bgTypeId: type, instanceId, asGroup };
  }

  /** The gate's synthetic list: run `body` over it and put the real state back whatever happens. */
  probe<T>(list: BattlefieldList, body: () => T): T {
    const saved = [this.#type, this.#guid, this.#instances, this.#selected] as const;
    try {
      this.receive(list);
      return body();
    } finally {
      [this.#type, this.#guid, this.#instances, this.#selected] = saved;
    }
  }
}

/** The part of the world seam the four list bindings read. */
export interface FrameXmlBattlefieldListHost {
  readonly battlefieldListState?: FrameXmlBattlefieldListState | undefined;
}

function indexOf(value: unknown): number {
  // Wow.exe rounds the Lua number (0x0054bb40, 0x0054d8f0).
  const index = Number(value);
  return Number.isFinite(index) ? Math.round(index) : 0;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_BATTLEFIELD_LIST_BINDINGS: Readonly<Record<string,
  (host: FrameXmlBattlefieldListHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetNumBattlefields: (host) => [host.battlefieldListState?.count() ?? 0],
  GetBattlefieldInstanceInfo: (host, args) => {
    const id = host.battlefieldListState?.instance(indexOf(args[0]));
    return id === undefined ? NOTHING : [id];
  },
  SetSelectedBattlefield: (host, args) => {
    host.battlefieldListState?.select(indexOf(args[0]));
    return NOTHING;
  },
  GetSelectedBattlefield: (host) => [host.battlefieldListState?.selectedIndex() ?? 0],
});
