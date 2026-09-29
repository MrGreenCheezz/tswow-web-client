/**
 * The stock dungeon finder's C API: `LFGFrame.lua`, `LFDFrame.lua` and `LFRFrame.lua` over this
 * client's `lfg*` packet state and the gateway's `LFGDungeons`/`LFGDungeonGroup` catalog.
 *
 * Three facts shape everything below, each measured against the stock 3.3.5 Lua:
 *
 * * The list is keyed by numbers, and headers are negative (`LFGIsIDHeader`: `id < 0`,
 *   LFGFrame.lua:369). A dungeon's `groupID` must equal its header's id: the header rows read
 *   `enabledList[groupID]`/`lockList[groupID]`, which `LFGListUpdateHeaderEnabledAndLockedStates`
 *   writes from each child (LFGFrame.lua:421-450). A header is therefore `-LFGDungeonGroup.ID` and
 *   a dungeon answers `groupID = -Group_ID`.
 * * `GetLFDChoiceOrder(t)` and its four siblings *fill the table they are given* with numeric
 *   keys. The host pushes a JS object as a string-keyed table (GlueLua.ts), so those five are a Lua
 *   shim (`FRAMEXML_LFD_PRELUDE`) over flat vararg accessors.
 * * `LFGDungeonList_Setup` (LFGFrame.lua:375-386) reads the catalog exactly once per session. The
 *   model answers nothing until the catalog carries the version-2 fields, and the world mount only
 *   publishes the stock owner when it does — otherwise the native finder keeps the route.
 *
 * Stock `GetLFGMode` is Lua (UIParent.lua:3570); it reads `GetLFGProposal`, `GetLFGInfoServer`,
 * `GetLFGRoleUpdate`, `IsListedInLFR`, `IsPartyLFG` and `IsInLFGDungeon`, all answered here, so the
 * minimap eye (MiniMapLFG_UpdateIsShown) and every LFD button follow the real packets.
 *
 * TrinityCore 3.3.5 has no raid-browser protocol (`SearchLFG*`): LFRFrame.xml loads because
 * LFGFrame.lua touches `LFRParentFrame` unconditionally, and its APIs answer "nothing listed".
 */
import type { LfgStateChange } from "../../world/EventBus.js";
import {
  LFG_ROLE_DAMAGE,
  LFG_ROLE_HEALER,
  LFG_ROLE_LEADER,
  LFG_ROLE_TANK,
  LFG_ROLECHECK_INITIALITING,
  splitDungeonEntry,
  type LfgBootProposal,
  type LfgPlayerInfo,
  type LfgPlayerLocks,
  type LfgProposal,
  type LfgQueueStatus,
  type LfgRoleCheck,
  type LfgRoleChosen,
  type LfgUpdate,
} from "../../world/LfgProtocol.js";
import type { LfgDungeon, LfgDungeonGroupRow, LfgStockCatalog } from "../LfgDungeons.js";

/** `TYPEID_*` in LFDFrame.lua:5-8. */
export const FRAMEXML_LFD_TYPE_DUNGEON = 1;
export const FRAMEXML_LFD_TYPE_RAID = 2;
export const FRAMEXML_LFD_TYPE_HEROIC = 5;
export const FRAMEXML_LFD_TYPE_RANDOM = 6;
/** `LFG_FLAG_SEASONAL` (LFGMgr.h:62): the four world-event bosses carry Flags 15 in this dataset. */
const LFG_FLAG_SEASONAL = 0x4;
/** `LfgProposalState` (LFG.h): 0 initiating, 1 failed, 2 success. */
const LFG_PROPOSAL_INITIATING = 0;
const LFG_PROPOSAL_FAILED = 1;
const LFG_PROPOSAL_SUCCESS = 2;
/** `GROUPTYPE_LFG` (Group.h): a group the finder assembled. */
const GROUPTYPE_LFG = 0x08;

/**
 * `GetLFGDungeonInfo(id)`'s fourteen values in the order `LFG_RETURN_VALUES` names them
 * (LFGFrame.lua:15-28), plus the `description` and `isHoliday` LFDQueueFrameRandom_UpdateFrame
 * reads as values 13 and 14 (LFDFrame.lua:826).
 */
export type FrameXmlLfgDungeonInfo = readonly [
  name: string, typeID: number, minLevel: number, maxLevel: number,
  recLevel: number, minRecLevel: number, maxRecLevel: number, expansionLevel: number,
  groupID: number, texture: string, difficulty: number, maxPlayers: number,
  description: string, isHoliday: boolean,
];

/** Stock's `GetTexCoordsForRole` names (LFGFrame.lua:314); also the `_G[role]` label key. */
export type FrameXmlLfgRole = "TANK" | "HEALER" | "DAMAGER";

function fieldOf(row: LfgDungeon, key: keyof LfgDungeon): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The dungeon row's own answer; headers go through `frameXmlLfdHeaderInfo`. */
export function frameXmlLfdDungeonInfo(row: LfgDungeon): FrameXmlLfgDungeonInfo {
  const groupId = fieldOf(row, "groupId");
  return [
    row.name, row.type, row.minLevel, row.maxLevel,
    fieldOf(row, "targetLevel"), fieldOf(row, "targetLevelMin"), fieldOf(row, "targetLevelMax"),
    row.expansion, groupId === 0 ? 0 : -groupId, row.texture, row.difficulty,
    fieldOf(row, "maxPlayers"), row.description, (fieldOf(row, "flags") & LFG_FLAG_SEASONAL) !== 0,
  ];
}

/** A header row (`id < 0`): the group's name and TypeID; the header branch reads nothing else. */
export function frameXmlLfdHeaderInfo(group: LfgDungeonGroupRow): FrameXmlLfgDungeonInfo {
  return [group.name, group.typeId, 0, 0, 0, 0, 0, 0, 0, "", 0, 0, "", false];
}

/** Whether a dungeon row may appear for a player of this faction group (-1 both, 0 Horde, 1 Alliance). */
function factionAllows(row: LfgDungeon, faction: "Alliance" | "Horde" | undefined): boolean {
  const rowFaction = fieldOf(row, "faction");
  if (rowFaction < 0 || faction === undefined) return true;
  return rowFaction === (faction === "Horde" ? 0 : 1);
}

/**
 * `GetLFDChoiceOrder`'s id list: each dungeon group (`LFGDungeonGroup.TypeID` 1 or 5) as a
 * negative header, sorted by `Order_index`, followed by its normal/heroic rows.
 *
 * The groups' Order_index puts Wrath heroic first and the classic list last (1..5, measured). Every
 * dungeon row has Order_index 0 in this dataset, so the rows are ordered by recommended level,
 * then minimum level, then id — the client list runs Ragefire Chasm (16) up to Stratholme (60)
 * that way. Random (6), raid (2), zone (4) and world-event rows (group TypeID 0) are not choices:
 * randoms come from the server's own list, raids belong to the absent raid browser. Rows of the
 * other faction are dropped (the server does not check `Faction`; the client list does not show
 * Ragefire Chasm to an Alliance player).
 */
export function frameXmlLfdChoiceOrder(
  catalog: LfgStockCatalog,
  faction?: "Alliance" | "Horde",
): number[] {
  const groups = [...catalog.groups]
    .filter((group) => group.typeId === FRAMEXML_LFD_TYPE_DUNGEON || group.typeId === FRAMEXML_LFD_TYPE_HEROIC)
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);
  const order: number[] = [];
  for (const group of groups) {
    const rows = catalog.dungeons
      .filter((row) => fieldOf(row, "groupId") === group.id
        && (row.type === FRAMEXML_LFD_TYPE_DUNGEON || row.type === FRAMEXML_LFD_TYPE_HEROIC)
        && factionAllows(row, faction))
      .sort((left, right) => fieldOf(left, "orderIndex") - fieldOf(right, "orderIndex")
        || fieldOf(left, "targetLevel") - fieldOf(right, "targetLevel")
        || left.minLevel - right.minLevel || left.id - right.id);
    if (rows.length === 0) continue;
    order.push(-group.id, ...rows.map((row) => row.id));
  }
  return order;
}

/** The role label a `LFG_ROLE_*` mask shows as: stock picks one icon per member. */
export function frameXmlLfgRole(mask: number): FrameXmlLfgRole {
  if ((mask & LFG_ROLE_TANK) !== 0) return "TANK";
  if ((mask & LFG_ROLE_HEALER) !== 0) return "HEALER";
  return "DAMAGER";
}

/**
 * `GetAvailableRoles` by class id for the ten stock classes. TSWoW's server strips unavailable roles
 * itself (`ObjectMgr::GetPlayerClassRoleMask`, from the `player_class_roles` world table, which no
 * client packet carries), so a custom class is offered every role and the server decides.
 */
const CLASS_ROLES: Readonly<Record<number, readonly [tank: boolean, healer: boolean, damage: boolean]>> = {
  1: [true, false, true], 2: [true, true, true], 3: [false, false, true], 4: [false, false, true],
  5: [false, true, true], 6: [true, false, true], 7: [false, true, true], 8: [false, false, true],
  9: [false, false, true], 11: [true, true, true],
};

export function frameXmlLfgAvailableRoles(classId: number | undefined): readonly [boolean, boolean, boolean] {
  return (classId === undefined ? undefined : CLASS_ROLES[classId]) ?? [true, true, true];
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlLfdWorld {
  readonly events?: {
    on(name: "LFG_STATE_CHANGED", listener: (payload: LfgStateChange) => void): () => void;
  } | undefined;
  readonly lfgPlayerInfo?: LfgPlayerInfo | undefined;
  readonly lfgPartyInfo?: readonly LfgPlayerLocks[] | undefined;
  readonly lfgStatus?: LfgUpdate | undefined;
  readonly lfgQueue?: LfgQueueStatus | undefined;
  readonly lfgProposal?: LfgProposal | undefined;
  readonly lfgRoleCheck?: LfgRoleCheck | undefined;
  readonly lfgRolesChosen?: ReadonlyMap<bigint, LfgRoleChosen> | undefined;
  readonly lfgBoot?: LfgBootProposal | undefined;
  readonly lfgBootExpiresAt?: number | undefined;
  readonly lfgOfferContinue?: number | undefined;
  readonly group?: { readonly groupType: number } | undefined;
  displayName?(guid: bigint): string;
  joinLfg(roles: number, dungeons: number[], comment?: string): void;
  leaveLfg(): void;
  setLfgRoles(roles: number): void;
  answerLfgProposal(accept: boolean): void;
  requestDungeonLocks(): void;
  voteToRemove(agree: boolean): void;
  teleportToDungeon(toDungeon?: boolean): void;
  answerLfgContinue(accept: boolean, dungeons?: number[], roles?: number): void;
}

export interface FrameXmlLfdItem {
  readonly name: string;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlLfdContext {
  world(): FrameXmlLfdWorld | undefined;
  catalog(): LfgStockCatalog | undefined;
  playerLevel(): number;
  playerClassId(): number | undefined;
  playerName(): string | undefined;
  playerGuid(): bigint | undefined;
  playerFaction(): "Alliance" | "Horde" | undefined;
  partyMemberCount(): number;
  raidMemberCount(): number;
  isPartyLeader(): boolean;
  /** The current map is a dungeon instance (Map.InstanceType 1). */
  inDungeonInstance(): boolean;
  item?(entry: number): FrameXmlLfdItem | undefined;
  /** Monotonic milliseconds on the clock `lfgBootExpiresAt` uses (performance.now in WorldClient). */
  monotonic?(): number;
}

interface FrameXmlLfdPump {
  fire(event: string, ...args: readonly unknown[]): number;
  now(): number;
}

/** Stock `ITEM_QUALITY_COLORS` hex (UIParent.lua), for the reward item link. */
const QUALITY_HEX: readonly string[] = [
  "ff9d9d9d", "ffffffff", "ff1eff00", "ff0070dd", "ffa335ee", "ffff8000", "ffe6cc80", "ffe6cc80",
];

function popcount(value: number): number {
  let bits = value >>> 0;
  let count = 0;
  while (bits) { count += bits & 1; bits >>>= 1; }
  return count;
}

/**
 * One owner of the stock finder's C API. Client-held state (roles, the checked list, collapsed
 * headers, the join selection) lives here, as the real client keeps it in its own memory; server
 * state is read from the world on every call.
 */
export class FrameXmlLfdModel {
  readonly #context: FrameXmlLfdContext;
  #pump: FrameXmlLfdPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #roles = { leader: false, tank: false, healer: false, damage: false };
  readonly #enabled = new Set<number>();
  readonly #collapsed = new Set<number>();
  readonly #selection = new Set<number>();
  #comment = "";
  #muted = false;
  /** Set by the world mount once the stock LFD owner is published; see `popupsOwned`. */
  #popupsOwned = false;
  /** The proposal stock was sent LFG_PROPOSAL_SHOW for — only ever while it owned the popups. */
  #shownProposalId: number | undefined;
  /** A role check is running on the world (seen, whether or not stock was asked to show it). */
  #roleCheckActive = false;
  #queue: LfgQueueStatus | undefined;
  #queueStampedAt = 0;
  #offerEntry: number | undefined;
  #orderCatalog: LfgStockCatalog | undefined;
  #orderFaction: string | undefined;
  #order: readonly number[] = [];
  #index: Map<number, LfgDungeon> | undefined;
  #indexCatalog: LfgStockCatalog | undefined;

  constructor(context: FrameXmlLfdContext) {
    this.#context = context;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlLfdPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    // A world without an event bus (older fakes) answers the C API and simply raises no events.
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("LFG_STATE_CHANGED", (change) => this.#onState(change));
    }
    // What the world already holds is *seen*, not *shown*: `detach` handed the prompts back, so a
    // proposal or role check open now is the native prompt's until `popupsOwned` replays it.
    this.#roleCheckActive = world?.lfgRoleCheck?.state === LFG_ROLECHECK_INITIALITING;
    this.#shownProposalId = undefined;
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#popupsOwned = false;
    this.#shownProposalId = undefined;
  }

  /** The catalog carries what the stock list needs; the gate refuses to publish otherwise. */
  ready(): boolean {
    return this.#context.catalog() !== undefined;
  }

  /**
   * Whether the stock ready/role-check/boot/offer popups own those prompts. Until the stock LFD is
   * published the native InteractionPrompts show them, so their *show* events stay silent: a
   * stock popup beside the native one would be two answers to one server question.
   *
   * Taking ownership is an edge, not a flag: the native prompts step aside at the same moment
   * (`frameXmlLfdPublished`), so whatever is still open is handed over (`#replayPrompts`).
   */
  get popupsOwned(): boolean { return this.#popupsOwned; }
  set popupsOwned(owned: boolean) {
    if (owned === this.#popupsOwned) return;
    this.#popupsOwned = owned;
    if (owned) this.#replayPrompts();
    else this.#shownProposalId = undefined;
  }

  /** The leader's roles came with the join; the role-check popup asks only a member who has not chosen. */
  #roleCheckAsksPlayer(check: LfgRoleCheck): boolean {
    const self = this.#context.playerGuid();
    return check.members.find((member) => member.guid === self)?.ready !== true;
  }

  /**
   * Show in stock the prompts the native InteractionPrompts held until publication. Nothing else
   * would: the server re-sends an open proposal only as a same-id LFG_PROPOSAL_UPDATE, and
   * LFDDungeonReadyPopup_Update never shows the popup (LFDFrame.lua:477-484; only
   * LFG_PROPOSAL_SHOW calls StaticPopupSpecial_Show); a running role check or boot vote comes back
   * only as updates of a state already seen, and the continue offer is sent once. Measured before
   * this replay: a proposal that arrived during the corpus load left GetLFGMode "proposal" with
   * LFDDungeonReadyPopup hidden and the native prompt suppressed. An answered proposal is shown
   * too — stock keeps the popup up on its LFDDungeonReadyStatus view until it succeeds or fails.
   */
  #replayPrompts(): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    const proposal = world.lfgProposal;
    if (proposal?.state === LFG_PROPOSAL_INITIATING && proposal.proposalId !== this.#shownProposalId) {
      this.#shownProposalId = proposal.proposalId;
      pump.fire("LFG_PROPOSAL_SHOW");
      pump.fire("LFG_PROPOSAL_UPDATE");
    }
    const check = world.lfgRoleCheck;
    if (check?.state === LFG_ROLECHECK_INITIALITING) {
      this.#roleCheckActive = true;
      if (this.#roleCheckAsksPlayer(check)) {
        pump.fire("LFG_ROLE_CHECK_SHOW");
        pump.fire("LFG_ROLE_CHECK_UPDATE");
      }
    }
    // LFDFrame_OnEvent re-reads GetLFGBootProposal and shows VOTE_BOOT_PLAYER only to a non-voter.
    if (world.lfgBoot?.inProgress) pump.fire("LFG_BOOT_PROPOSAL_UPDATE");
    // WorldClient clears lfgOfferContinue once it is answered, so a value here is still unanswered.
    const offer = this.backfillInfo();
    if (offer) pump.fire("LFG_OFFER_CONTINUE", ...offer);
  }

  /** Run a transactional probe (the mount's gate) without sending a packet. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #command(run: (world: FrameXmlLfdWorld) => void): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (world) run(world);
  }

  // ---- the catalog -----------------------------------------------------------------------

  #row(id: number): LfgDungeon | undefined {
    const catalog = this.#context.catalog();
    if (!catalog) return undefined;
    if (this.#indexCatalog !== catalog) {
      this.#indexCatalog = catalog;
      this.#index = new Map(catalog.dungeons.map((row) => [row.id, row]));
    }
    return this.#index?.get(id);
  }

  /** `GetLFDChoiceOrder`'s ids, memoized per catalog and faction (it never changes in a session). */
  choiceIds(): readonly number[] {
    const catalog = this.#context.catalog();
    if (!catalog) return [];
    const faction = this.#context.playerFaction();
    if (catalog !== this.#orderCatalog || faction !== this.#orderFaction) {
      this.#orderCatalog = catalog;
      this.#orderFaction = faction;
      this.#order = frameXmlLfdChoiceOrder(catalog, faction);
    }
    return this.#order;
  }

  dungeonInfo(id: number): FrameXmlLfgDungeonInfo | undefined {
    if (!Number.isInteger(id)) return undefined;
    if (id < 0) {
      const group = this.#context.catalog()?.groups.find((row) => row.id === -id);
      return group ? frameXmlLfdHeaderInfo(group) : undefined;
    }
    const row = this.#row(id);
    return row ? frameXmlLfdDungeonInfo(row) : undefined;
  }

  /** The wire entry for a dungeon id: the catalog's TypeID in the top byte. */
  #entry(id: number): number | undefined {
    const row = this.#row(id);
    return row ? (id & 0x00ffffff) | ((row.type & 0xff) << 24) : undefined;
  }

  // ---- randoms, locks and rewards -------------------------------------------------------

  /** The server's random list (`SMSG_LFG_PLAYER_INFO`), limited to rows the catalog can name. */
  #randoms(): { id: number; row: LfgDungeon; index: number }[] {
    const info = this.#context.world()?.lfgPlayerInfo;
    if (!info) return [];
    const randoms: { id: number; row: LfgDungeon; index: number }[] = [];
    info.dungeons.forEach((dungeon, index) => {
      const id = splitDungeonEntry(dungeon.entry).dungeonId;
      const row = this.#row(id);
      if (row) randoms.push({ id, row, index });
    });
    return randoms;
  }

  numRandomDungeons(): number { return this.#randoms().length; }

  randomDungeonInfo(index: number): readonly [id: number, name: string] | undefined {
    const random = this.#randoms()[index - 1];
    return random ? [random.id, random.row.name] : undefined;
  }

  /** Locks by player: self first (stock index 1), then each party member the server listed. */
  #lockTable(): { guid: bigint | undefined; locks: Map<number, number> }[] {
    const world = this.#context.world();
    const own = new Map<number, number>();
    for (const lock of world?.lfgPlayerInfo?.locks ?? []) own.set(splitDungeonEntry(lock.dungeonId).dungeonId, lock.reason);
    const table = [{ guid: this.#context.playerGuid(), locks: own }];
    for (const member of world?.lfgPartyInfo ?? []) {
      if (member.guid === this.#context.playerGuid()) continue;
      const locks = new Map<number, number>();
      for (const lock of member.dungeons) locks.set(splitDungeonEntry(lock.dungeonId).dungeonId, lock.reason);
      table.push({ guid: member.guid, locks });
    }
    return table;
  }

  isJoinable(id: number): boolean {
    return this.#row(id) !== undefined && this.#lockTable().every((player) => !player.locks.has(id));
  }

  /** `GetRandomDungeonBestChoice`: the joinable random whose level band holds the player's level. */
  randomBestChoice(): number | undefined {
    const level = this.#context.playerLevel();
    const candidates = this.#randoms().filter(({ id, row }) =>
      this.isJoinable(id) && level >= row.minLevel && level <= row.maxLevel);
    candidates.sort((left, right) => right.row.minLevel - left.row.minLevel || left.id - right.id);
    return candidates[0]?.id;
  }

  lockPlayerCount(): number { return this.#lockTable().length; }

  lockInfo(id: number, index: number): readonly [name: string, reason: number] | undefined {
    const player = this.#lockTable()[index - 1];
    if (!player) return undefined;
    const world = this.#context.world();
    const name = index === 1
      ? this.#context.playerName() ?? ""
      : player.guid !== undefined ? world?.displayName?.(player.guid) ?? "" : "";
    return [name, player.locks.get(id) ?? 0];
  }

  /** Every id some player in the group may not enter (`GetLFDChoiceLockedState`). */
  lockedIds(): number[] {
    const ids = new Set<number>();
    for (const player of this.#lockTable()) for (const id of player.locks.keys()) ids.add(id);
    return [...ids];
  }

  #reward(id: number): LfgPlayerInfo["dungeons"][number]["reward"] | undefined {
    const info = this.#context.world()?.lfgPlayerInfo;
    return info?.dungeons.find((dungeon) => splitDungeonEntry(dungeon.entry).dungeonId === id)?.reward;
  }

  /**
   * `doneToday, moneyBase, moneyVar, experienceBase, experienceVar, numRewards`. TrinityCore writes
   * the two variance words as literal zeros (LFGHandler.cpp BuildQuestReward); LfgProtocol skips them.
   */
  rewards(id: number): readonly [boolean, number, number, number, number, number] {
    const reward = this.#reward(id);
    return reward
      ? [reward.done, reward.money, 0, reward.experience, 0, reward.items.length]
      : [false, 0, 0, 0, 0, 0];
  }

  rewardInfo(id: number, index: number): readonly [name: string, texture: string | undefined, count: number] | undefined {
    const item = this.#reward(id)?.items[index - 1];
    if (!item) return undefined;
    const known = this.#context.item?.(item.itemId);
    return [known?.name ?? "", known?.texture, item.count];
  }

  rewardLink(id: number, index: number): string | undefined {
    const item = this.#reward(id)?.items[index - 1];
    if (!item) return undefined;
    const known = this.#context.item?.(item.itemId);
    if (!known?.name) return undefined;
    const color = QUALITY_HEX[known.quality ?? 1] ?? QUALITY_HEX[1];
    return `|c${color}|Hitem:${item.itemId}:0:0:0:0:0:0:0:${this.#context.playerLevel()}|h[${known.name}]|h|r`;
  }

  // ---- queue, proposal, role check, boot ------------------------------------------------

  /** `GetLFGInfoServer`: inParty, joined, queued, noPartialClear, achievements, comment, slotCount. */
  infoServer(): readonly [boolean, boolean, boolean, boolean, boolean, string, number] {
    const status = this.#context.world()?.lfgStatus;
    if (!status) return [false, false, false, false, false, "", 0];
    return [status.party === true, status.joined, status.queued, false, false, status.comment, status.dungeons.length];
  }

  /** Queued dungeon ids (`GetLFGQueuedList`), from the last `SMSG_LFG_UPDATE_*`. */
  queuedIds(): number[] {
    const status = this.#context.world()?.lfgStatus;
    return status?.joined ? status.dungeons.map((entry) => splitDungeonEntry(entry).dungeonId) : [];
  }

  #selfProposalPlayer(proposal: LfgProposal): LfgProposal["players"][number] | undefined {
    return proposal.players.find((player) => player.self);
  }

  /** The open proposal; a failed or finished one is no proposal (stock GetLFGMode then moves on). */
  #openProposal(): LfgProposal | undefined {
    const proposal = this.#context.world()?.lfgProposal;
    return proposal?.state === LFG_PROPOSAL_INITIATING ? proposal : undefined;
  }

  /**
   * `proposalExists, typeID, id, name, texture, role, hasResponded, totalEncounters,
   * completedEncounters, numMembers, isLeader, isHoliday`. The packet's encounter word is the
   * killed-boss mask; the number of bosses is DungeonEncounter.dbc data no route serves, so
   * `totalEncounters` is 0 — LFDDungeonReadyDialogInstanceInfo_OnEnter then shows no boss list.
   */
  proposal(): readonly unknown[] {
    const proposal = this.#openProposal();
    if (!proposal) return [false];
    const { dungeonId, type } = splitDungeonEntry(proposal.dungeonEntry);
    const row = this.#row(dungeonId);
    const self = this.#selfProposalPlayer(proposal);
    return [
      true, type || row?.type || FRAMEXML_LFD_TYPE_DUNGEON, dungeonId, row?.name ?? "", row?.texture ?? "",
      frameXmlLfgRole(self?.roles ?? 0), self?.answered === true, 0, popcount(proposal.encounters),
      proposal.players.length, ((self?.roles ?? 0) & LFG_ROLE_LEADER) !== 0,
      row ? (fieldOf(row, "flags") & LFG_FLAG_SEASONAL) !== 0 : false,
    ];
  }

  /** `isLeader, role, level, responded, accepted, name, class` for proposal slot `index`. */
  proposalMember(index: number): readonly unknown[] | undefined {
    const player = this.#openProposal()?.players[index - 1];
    if (!player) return undefined;
    return [
      (player.roles & LFG_ROLE_LEADER) !== 0, frameXmlLfgRole(player.roles),
      player.self ? this.#context.playerLevel() : 0, player.answered, player.accepted,
      player.self ? this.#context.playerName() ?? "" : "", undefined,
    ];
  }

  /** `inProgress, slots, members` of the running role check. */
  roleUpdate(): readonly [boolean, number, number] {
    const check = this.#context.world()?.lfgRoleCheck;
    if (!check) return [false, 0, 0];
    return [check.state === LFG_ROLECHECK_INITIALITING, check.dungeons.length, check.members.length];
  }

  roleUpdateSlot(index: number): readonly [type: number, id: number] | undefined {
    const entry = this.#context.world()?.lfgRoleCheck?.dungeons[index - 1];
    if (entry === undefined) return undefined;
    const { dungeonId, type } = splitDungeonEntry(entry);
    return [type || this.#row(dungeonId)?.type || FRAMEXML_LFD_TYPE_DUNGEON, dungeonId];
  }

  /**
   * `hasData, leaderNeeds, tankNeeds, healerNeeds, dpsNeeds, instanceType, instanceName,
   * averageWait, tankWait, healerWait, damageWait, myWait, queuedTime`. The packet says how long the
   * player has already waited; `queuedTime` is that moment on the GetTime clock, stamped when the
   * packet was delivered (LFDSearchStatus_OnUpdate subtracts it from GetTime()).
   */
  queueStats(): readonly unknown[] {
    const queue = this.#context.world()?.lfgQueue;
    if (!queue) return [false];
    const stamped = queue === this.#queue ? this.#queueStampedAt : this.#pump?.now() ?? 0;
    const { dungeonId, type } = splitDungeonEntry(queue.dungeonId);
    const row = this.#row(dungeonId);
    return [
      true, 0, queue.tanksNeeded, queue.healersNeeded, queue.damageNeeded,
      type || row?.type || FRAMEXML_LFD_TYPE_DUNGEON, row?.name ?? "",
      queue.waitTimeAverage, queue.waitTimeTank, queue.waitTimeHealer, queue.waitTimeDamage,
      queue.waitTime, stamped - queue.queuedSeconds,
    ];
  }

  /** `voteInProgress, didVote, myVote, targetName, totalVotes, bootVotes, timeLeft, reason`. */
  bootProposal(): readonly unknown[] {
    const world = this.#context.world();
    const boot = world?.lfgBoot;
    if (!boot?.inProgress) return [false];
    const now = this.#context.monotonic?.() ?? 0;
    const left = world?.lfgBootExpiresAt ? Math.max(0, Math.ceil((world.lfgBootExpiresAt - now) / 1000)) : 0;
    return [true, boot.voted, boot.votedYes, world?.displayName?.(boot.victimGuid) ?? "",
      boot.votes, boot.agree, left, boot.reason];
  }

  // ---- group facts -----------------------------------------------------------------------

  isPartyLfg(): boolean {
    const group = this.#context.world()?.group;
    return group !== undefined && (group.groupType & GROUPTYPE_LFG) !== 0;
  }

  inLfgDungeon(): boolean {
    return this.isPartyLfg() && this.#context.inDungeonInstance();
  }

  // ---- client-held selection and roles --------------------------------------------------

  roles(): readonly [boolean, boolean, boolean, boolean] {
    const roles = this.#roles;
    return [roles.leader, roles.tank, roles.healer, roles.damage];
  }

  #roleMask(): number {
    const roles = this.#roles;
    const solo = this.#context.partyMemberCount() === 0 && this.#context.raidMemberCount() === 0;
    return (roles.leader && (solo || this.#context.isPartyLeader()) ? LFG_ROLE_LEADER : 0)
      | (roles.tank ? LFG_ROLE_TANK : 0) | (roles.healer ? LFG_ROLE_HEALER : 0)
      | (roles.damage ? LFG_ROLE_DAMAGE : 0);
  }

  /** `SetLFGRoles(leader, tank, healer, dps)`: CheckButton:GetChecked() answers 1 or nil. */
  setRoles(leader: boolean, tank: boolean, healer: boolean, damage: boolean): void {
    const [canTank, canHeal, canDamage] = this.availableRoles();
    const next = { leader, tank: tank && canTank, healer: healer && canHeal, damage: damage && canDamage };
    const changed = Object.entries(next).some(([key, value]) => this.#roles[key as keyof typeof next] !== value);
    this.#roles = next;
    // The stock role checkboxes on LFDQueueFrame, LFRQueueFrame and LFDRoleCheckPopup mirror one
    // selection through LFG_ROLE_UPDATE (LFDFrame.lua:74).
    if (changed) this.#pump?.fire("LFG_ROLE_UPDATE");
  }

  availableRoles(): readonly [boolean, boolean, boolean] {
    return frameXmlLfgAvailableRoles(this.#context.playerClassId());
  }

  enabledIds(): number[] { return [...this.#enabled]; }
  collapsedIds(): number[] { return [...this.#collapsed]; }

  setDungeonEnabled(id: number, enabled: boolean): void {
    if (!Number.isInteger(id)) return;
    if (enabled) this.#enabled.add(id);
    else this.#enabled.delete(id);
  }

  /** Stock also collapses the children in Lua (LFDList_SetHeaderCollapsed); keep the same set. */
  setHeaderCollapsed(id: number, collapsed: boolean): void {
    if (!Number.isInteger(id)) return;
    const affected = [id, ...this.choiceIds().filter((child) => this.dungeonInfo(child)?.[8] === id)];
    for (const each of affected) {
      if (collapsed) this.#collapsed.add(each);
      else this.#collapsed.delete(each);
    }
  }

  setDungeon(id: number): void {
    if (Number.isInteger(id) && id > 0) this.#selection.add(id);
  }

  clearDungeons(): void { this.#selection.clear(); }

  setComment(comment: string): void { this.#comment = comment.slice(0, 255); }

  /** The join selection as wire entries, in catalog order; ids the catalog cannot type are dropped. */
  selectionEntries(): number[] {
    return [...this.#selection].sort((left, right) => left - right)
      .map((id) => this.#entry(id)).filter((entry): entry is number => entry !== undefined);
  }

  // ---- commands --------------------------------------------------------------------------

  /** `JoinLFG()`: the selection `SetLFGDungeon` built, with the roles the checkboxes hold. */
  join(): void {
    const entries = this.selectionEntries();
    const roles = this.#roleMask();
    this.#command((world) => world.joinLfg(roles, entries, this.#comment));
  }

  leave(): void { this.#command((world) => world.leaveLfg()); }
  acceptProposal(): void { this.#command((world) => world.answerLfgProposal(true)); }
  rejectProposal(): void { this.#command((world) => world.answerLfgProposal(false)); }

  /**
   * `CompleteLFGRoleCheck(accept)`. Accepting sends the chosen roles and answers whether any
   * combat role was chosen (the popup stays open otherwise); declining sends no role, which
   * TrinityCore's UpdateRoleCheck turns into LFG_ROLECHECK_NO_ROLE (LFGMgr.cpp:851).
   */
  completeRoleCheck(accept: boolean): boolean {
    if (!accept) {
      this.#command((world) => world.setLfgRoles(0));
      return true;
    }
    const roles = this.#roleMask();
    if ((roles & (LFG_ROLE_TANK | LFG_ROLE_HEALER | LFG_ROLE_DAMAGE)) === 0) return false;
    this.#command((world) => world.setLfgRoles(roles));
    return true;
  }

  /** One request covers both stock calls: `requestDungeonLocks` asks for the party too when grouped. */
  requestLocks(): void { this.#command((world) => world.requestDungeonLocks()); }

  /** `LFGTeleport(out)`: true leaves the dungeon, false enters it. */
  teleport(out: boolean): void { this.#command((world) => world.teleportToDungeon(!out)); }

  setBootVote(agree: boolean): void { this.#command((world) => world.voteToRemove(agree)); }

  /** `GetPartyLFGBackfillInfo`: the dungeon the server offered to continue, as stock names it. */
  backfillInfo(): readonly [name: string, id: number, type: number] | undefined {
    const world = this.#context.world();
    const id = world?.lfgOfferContinue;
    if (id === undefined) return undefined;
    const row = this.#row(id);
    const type = this.#offerEntry !== undefined && splitDungeonEntry(this.#offerEntry).dungeonId === id
      ? splitDungeonEntry(this.#offerEntry).type : row?.type ?? FRAMEXML_LFD_TYPE_DUNGEON;
    return [row?.name ?? String(id), id, type];
  }

  /** `PartyLFGStartBackfill`: re-queue the offered dungeon with the current roles. */
  startBackfill(): void {
    const info = this.backfillInfo();
    if (!info) return;
    const [, id, type] = info;
    const roles = this.#roleMask();
    this.#command((world) => world.answerLfgContinue(true, [(id & 0x00ffffff) | ((type & 0xff) << 24)], roles));
  }

  // ---- events ----------------------------------------------------------------------------

  /**
   * Map one world notification onto the stock events. The world state is re-read, never the
   * payload: several packets can land before the pump runs a handler.
   */
  #onState(change: LfgStateChange): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    switch (change.kind) {
      case "joinResult":
        // `LfgJoinResult` 0 is "joined"; anything else is a refusal the stock UI shows in red.
        if (change.result !== undefined && change.result !== 0 && change.message) {
          pump.fire("UI_ERROR_MESSAGE", change.message);
        }
        pump.fire("LFG_UPDATE");
        return;
      case "queue":
        this.#queue = world.lfgQueue;
        this.#queueStampedAt = pump.now();
        pump.fire("LFG_QUEUE_STATUS_UPDATE");
        return;
      case "update":
        pump.fire("LFG_UPDATE");
        return;
      case "proposal": {
        const proposal = world.lfgProposal;
        if (proposal?.state === LFG_PROPOSAL_INITIATING) {
          // Recorded only when shown: an id seen while the native prompt owned it is replayed at
          // the ownership edge, never mistaken for one stock already shows.
          if (this.#popupsOwned && proposal.proposalId !== this.#shownProposalId) {
            this.#shownProposalId = proposal.proposalId;
            pump.fire("LFG_PROPOSAL_SHOW");
          }
          pump.fire("LFG_PROPOSAL_UPDATE");
        } else if (proposal?.state === LFG_PROPOSAL_FAILED) {
          pump.fire("LFG_PROPOSAL_FAILED");
        } else if (proposal?.state === LFG_PROPOSAL_SUCCESS) {
          pump.fire("LFG_PROPOSAL_SUCCEEDED");
        }
        pump.fire("LFG_UPDATE");
        return;
      }
      case "roleCheck": {
        const check = world.lfgRoleCheck;
        const active = check?.state === LFG_ROLECHECK_INITIALITING;
        if (active && !this.#roleCheckActive) {
          this.#roleCheckActive = true;
          if (this.#popupsOwned && check && this.#roleCheckAsksPlayer(check)) pump.fire("LFG_ROLE_CHECK_SHOW");
        } else if (!active && this.#roleCheckActive) {
          this.#roleCheckActive = false;
          pump.fire("LFG_ROLE_CHECK_HIDE");
        }
        pump.fire("LFG_ROLE_CHECK_UPDATE");
        pump.fire("LFG_UPDATE");
        return;
      }
      case "roleChosen": {
        if (change.guid !== undefined && change.roles !== undefined) {
          const name = world.displayName?.(change.guid) ?? "";
          pump.fire("LFG_ROLE_CHECK_ROLE_CHOSEN", name,
            (change.roles & LFG_ROLE_TANK) !== 0, (change.roles & LFG_ROLE_HEALER) !== 0,
            (change.roles & LFG_ROLE_DAMAGE) !== 0);
        }
        pump.fire("LFG_ROLE_CHECK_UPDATE");
        return;
      }
      case "boot":
        if (this.#popupsOwned) pump.fire("LFG_BOOT_PROPOSAL_UPDATE");
        return;
      case "playerInfo":
        pump.fire("LFG_UPDATE_RANDOM_INFO");
        pump.fire("LFG_LOCK_INFO_RECEIVED");
        return;
      case "partyInfo":
        pump.fire("LFG_LOCK_INFO_RECEIVED");
        return;
      case "offerContinue": {
        this.#offerEntry = change.entry;
        const info = this.backfillInfo();
        if (this.#popupsOwned && info) pump.fire("LFG_OFFER_CONTINUE", ...info);
        return;
      }
      case "teleportDenied":
        if (change.message) pump.fire("UI_ERROR_MESSAGE", change.message);
        return;
      case "search":
      case "disabled":
        pump.fire("LFG_UPDATE");
        return;
      case "reward":
        // The completion reward keeps its native prompt: 3.3.5's stock owner for it is
        // DungeonCompletionAlertFrame (AlertFrames.xml), which this vertical does not load.
        return;
    }
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlLfdHost {
  readonly lfd?: FrameXmlLfdModel | undefined;
}

export type FrameXmlLfdBinding = (host: FrameXmlLfdHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

/** Lua truthiness: nil and false are false; stock passes `CheckButton:GetChecked()` (1 or nil). */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

const withLfd = (answer: (lfd: FrameXmlLfdModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlLfdBinding =>
  (host, args) => host.lfd ? answer(host.lfd, args) : NOTHING;

const command = (run: (lfd: FrameXmlLfdModel, args: readonly unknown[]) => void): FrameXmlLfdBinding =>
  withLfd((lfd, args) => { run(lfd, args); return NOTHING; });

/**
 * The flat C API. Names here are installed into `__fxNeutralImpl` like every seam name, so they
 * also replace F2's constants (`IsPartyLFG`) and the empty stub-plan functions the corpus touches.
 * `WebClientLfd*` are the flat accessors the Lua shim below turns into filled tables.
 */
export const FRAMEXML_LFD_BINDINGS: Readonly<Record<string, FrameXmlLfdBinding>> = Object.freeze({
  GetLFGDungeonInfo: withLfd((lfd, args) => {
    const id = integerArg(args[0]);
    return id === undefined ? NOTHING : lfd.dungeonInfo(id) ?? NOTHING;
  }),
  GetNumRandomDungeons: withLfd((lfd) => [lfd.numRandomDungeons()]),
  GetLFGRandomDungeonInfo: withLfd((lfd, args) => lfd.randomDungeonInfo(integerArg(args[0]) ?? 0) ?? NOTHING),
  GetRandomDungeonBestChoice: withLfd((lfd) => optional(lfd.randomBestChoice())),
  IsLFGDungeonJoinable: withLfd((lfd, args) => [lfd.isJoinable(integerArg(args[0]) ?? 0)]),
  GetLFDLockPlayerCount: withLfd((lfd) => [lfd.lockPlayerCount()]),
  GetLFDLockInfo: withLfd((lfd, args) =>
    lfd.lockInfo(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? 0) ?? NOTHING),
  GetLFGDungeonRewards: withLfd((lfd, args) => lfd.rewards(integerArg(args[0]) ?? 0)),
  GetLFGDungeonRewardInfo: withLfd((lfd, args) =>
    lfd.rewardInfo(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? 0) ?? NOTHING),
  GetLFGDungeonRewardLink: withLfd((lfd, args) =>
    optional(lfd.rewardLink(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? 0))),
  GetLFGInfoServer: withLfd((lfd) => lfd.infoServer()),
  GetLFGProposal: withLfd((lfd) => lfd.proposal()),
  GetLFGProposalMember: withLfd((lfd, args) => lfd.proposalMember(integerArg(args[0]) ?? 0) ?? NOTHING),
  // Boss names and kill state per encounter are DungeonEncounter.dbc data no route serves; the
  // proposal reports 0 encounters, so stock never asks for one.
  GetLFGProposalEncounter: () => NOTHING,
  GetLFGRoleUpdate: withLfd((lfd) => lfd.roleUpdate()),
  GetLFGRoleUpdateSlot: withLfd((lfd, args) => lfd.roleUpdateSlot(integerArg(args[0]) ?? 0) ?? NOTHING),
  GetLFGQueueStats: withLfd((lfd) => lfd.queueStats()),
  GetLFGBootProposal: withLfd((lfd) => lfd.bootProposal()),
  GetLFGRoles: withLfd((lfd) => lfd.roles()),
  SetLFGRoles: command((lfd, args) => lfd.setRoles(truthy(args[0]), truthy(args[1]), truthy(args[2]), truthy(args[3]))),
  GetAvailableRoles: withLfd((lfd) => lfd.availableRoles()),
  SetLFGDungeon: command((lfd, args) => { const id = integerArg(args[0]); if (id !== undefined) lfd.setDungeon(id); }),
  ClearAllLFGDungeons: command((lfd) => lfd.clearDungeons()),
  SetLFGDungeonEnabled: command((lfd, args) => {
    const id = integerArg(args[0]);
    if (id !== undefined) lfd.setDungeonEnabled(id, truthy(args[1]));
  }),
  SetLFGHeaderCollapsed: command((lfd, args) => {
    const id = integerArg(args[0]);
    if (id !== undefined) lfd.setHeaderCollapsed(id, truthy(args[1]));
  }),
  SetLFGComment: command((lfd, args) => lfd.setComment(typeof args[0] === "string" ? args[0] : "")),
  JoinLFG: command((lfd) => lfd.join()),
  LeaveLFG: command((lfd) => lfd.leave()),
  AcceptProposal: command((lfd) => lfd.acceptProposal()),
  RejectProposal: command((lfd) => lfd.rejectProposal()),
  CompleteLFGRoleCheck: withLfd((lfd, args) => [lfd.completeRoleCheck(truthy(args[0]))]),
  RequestLFDPlayerLockInfo: command((lfd) => lfd.requestLocks()),
  // `requestDungeonLocks` already sent CMSG_LFD_PARTY_LOCK_INFO_REQUEST beside the player one when
  // grouped; stock always calls the pair back to back (LFDFrame.xml OnShow).
  RequestLFDPartyLockInfo: () => NOTHING,
  LFGTeleport: command((lfd, args) => lfd.teleport(truthy(args[0]))),
  SetLFGBootVote: command((lfd, args) => lfd.setBootVote(truthy(args[0]))),
  PartyLFGStartBackfill: command((lfd) => lfd.startBackfill()),
  GetPartyLFGBackfillInfo: withLfd((lfd) => lfd.backfillInfo() ?? NOTHING),
  // Neutral by contract: no backfill decision, deserter or random-cooldown state is read here
  // (the auras exist, but their expiry is not modelled for the stock cooldown frame yet).
  CanPartyLFGBackfill: () => [false],
  UnitHasLFGDeserter: () => [false],
  UnitHasLFGRandomCooldown: () => [false],
  GetLFGDeserterExpiration: () => NOTHING,
  GetLFGRandomCooldownExpiration: () => NOTHING,
  IsPartyLFG: withLfd((lfd) => [lfd.isPartyLfg()]),
  IsInLFGDungeon: withLfd((lfd) => [lfd.inLfgDungeon()]),
  // 3.3.5 answers true inside a finder group, which is what makes every member "empowered" in
  // LFD_IsEmpowered (UIParent.lua:3560).
  HasLFGRestrictions: withLfd((lfd) => [lfd.isPartyLfg()]),
  // The raid browser: TrinityCore 3.3.5 has no SearchLFG protocol, so nothing is ever listed.
  IsListedInLFR: () => [false],
  SearchLFGGetNumResults: () => [0, 0],
  SearchLFGGetResults: () => NOTHING,
  SearchLFGGetPartyResults: () => NOTHING,
  SearchLFGGetEncounterResults: () => NOTHING,
  SearchLFGGetJoinedID: () => NOTHING,
  SearchLFGJoin: () => NOTHING,
  SearchLFGLeave: () => NOTHING,
  RefreshLFGList: () => NOTHING,
  WebClientLfdChoiceIds: withLfd((lfd) => lfd.choiceIds()),
  WebClientLfdEnabledIds: withLfd((lfd) => lfd.enabledIds()),
  WebClientLfdCollapsedIds: withLfd((lfd) => lfd.collapsedIds()),
  WebClientLfdLockedIds: withLfd((lfd) => lfd.lockedIds()),
  WebClientLfdQueuedIds: withLfd((lfd) => lfd.queuedIds()),
});

/**
 * The table-filling half, appended to FRAMEXML_SEAM_PRELUDE. Each function wipes the table stock
 * hands it (or makes one — `LFGLockList = GetLFDChoiceLockedState()` passes none) and fills numeric
 * keys, which a JS object pushed through GlueLua cannot do. `GetLFDChoiceInfo` builds one array per
 * id from `GetLFGDungeonInfo`, the same answer stock reads through LFGGetDungeonInfoByID.
 */
export const FRAMEXML_LFD_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local choiceIds = rawget(_G, "__fxSeam_WebClientLfdChoiceIds")
  local dungeonInfo = rawget(_G, "__fxSeam_GetLFGDungeonInfo")
  local enabledIds = rawget(_G, "__fxSeam_WebClientLfdEnabledIds")
  local collapsedIds = rawget(_G, "__fxSeam_WebClientLfdCollapsedIds")
  local lockedIds = rawget(_G, "__fxSeam_WebClientLfdLockedIds")
  local queuedIds = rawget(_G, "__fxSeam_WebClientLfdQueuedIds")
  if impl ~= nil and choiceIds ~= nil and dungeonInfo ~= nil then
    local type, select, pairs = type, select, pairs
    local function cleared(t)
      if type(t) ~= "table" then return {} end
      for key in pairs(t) do t[key] = nil end
      return t
    end
    local function list(t, ...)
      t = cleared(t)
      for index = 1, select("#", ...) do t[index] = (select(index, ...)) end
      return t
    end
    local function set(t, ...)
      t = cleared(t)
      for index = 1, select("#", ...) do t[(select(index, ...))] = true end
      return t
    end
    impl.GetLFDChoiceOrder = function(t) return list(t, choiceIds()) end
    impl.GetLFDChoiceInfo = function(t)
      t = cleared(t)
      local ids = { choiceIds() }
      for index = 1, #ids do
        local id = ids[index]
        t[id] = { dungeonInfo(id) }
      end
      return t
    end
    impl.GetLFDChoiceEnabledState = function(t) return set(t, enabledIds()) end
    impl.GetLFDChoiceCollapseState = function(t) return set(t, collapsedIds()) end
    impl.GetLFDChoiceLockedState = function(t) return set(t, lockedIds()) end
    impl.GetLFGQueuedList = function(t) return set(t, queuedIds()) end
    -- LFRQueueFrame_Update's only table source; raids have no browse protocol in 3.3.5 TrinityCore.
    impl.GetLFRChoiceOrder = function(t) return cleared(t) end
  end
end
`;
