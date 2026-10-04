/**
 * The offline confirmations: a scripted world with `WorldClient`'s request fields and answering
 * commands, for `CannedWorldSeam`, the `framexml.html?popup=` preview and the tests.
 *
 * Commands record the wire-level intent and then change state the way `WorldClient` does (an
 * answered invite is cleared, `beginTrade` marks the request as answered); the scripted "packets"
 * below set what the matching server message would.
 */
import { EventBus } from "../../world/EventBus.js";
import type { TalentWipeAnswer } from "../../world/ConfirmationProtocol.js";
import {
  FRAMEXML_RELEASE_TIMER_FLAG,
  FrameXmlPopupsModel,
  type FrameXmlDungeonEncounter,
  type FrameXmlPlayerLife,
  type FrameXmlPopupsContext,
  type FrameXmlPopupsWorld,
  type FrameXmlTalentUiState,
} from "./FrameXmlPopups.js";

/** The canned player's GUID (the same character FrameXmlLfdCanned.ts queues). */
export const FRAMEXML_CANNED_POPUPS_PLAYER_GUID = 0x42n;

/** Named canned characters: the ones inviting, challenging, summoning and checking readiness. */
export const FRAMEXML_CANNED_POPUPS_NAMES: ReadonlyMap<bigint, string> = new Map([
  [FRAMEXML_CANNED_POPUPS_PLAYER_GUID, "Канон"],
  [0x51n, "Джайна"],
  [0x52n, "Утер"],
  [0x53n, "Тралл"],
]);

/**
 * The canned bags by wire position (`bag:slot`; the backpack is INVENTORY_SLOT_BAG_0 255, slots 23
 * up): a common item and an epic one — DELETE_ITEM and DELETE_GOOD_ITEM.
 */
export const FRAMEXML_CANNED_POPUPS_BAG: ReadonlyMap<string, { readonly name: string; readonly quality: number }> = new Map([
  ["255:23", { name: "Льняная ткань", quality: 1 }],
  ["255:24", { name: "Тесак Арканита", quality: 4 }],
]);

/** Spirit Healer entry 6491 in the canned world; its object sits beside the canned player. */
export const FRAMEXML_CANNED_SPIRIT_HEALER_GUID = 0xf130_0019_5b00_0001n;
/** The canned innkeeper (entry 6740) asking CONFIRM_BINDER, and the class trainer (entry 5480) quoting a talent reset. */
export const FRAMEXML_CANNED_INNKEEPER_GUID = 0xf130_0000_1a54_0001n;
export const FRAMEXML_CANNED_TRAINER_GUID = 0xf130_0000_1568_0002n;

/** The canned AreaTable names: Stormwind, Elwynn Forest and its Goldshire, where the canned player stands. */
const FRAMEXML_CANNED_AREAS: ReadonlyMap<number, string> = new Map([
  [1519, "Штормград"], [12, "Элвиннский лес"], [87, "Златоземье"],
]);

/** DungeonEncounter.dbc of the canned instance lock, Utgarde Keep (map 574) normal: each boss's bit and name. */
export const FRAMEXML_CANNED_DUNGEON_ENCOUNTERS: ReadonlyMap<string, readonly FrameXmlDungeonEncounter[]> = new Map([
  ["574/0", [
    { bit: 0, name: "Принц Келесет" }, { bit: 1, name: "Скарвальд и Далронн" }, { bit: 2, name: "Ингвар Расхититель" },
  ]],
]);

export type FrameXmlCannedPopupsCall =
  | { readonly kind: "group" | "duel" | "resurrect" | "summon" | "guild" | "arena" | "readyCheck" | "instanceLock"; readonly accept: boolean }
  | { readonly kind: "repop" | "reclaim" | "beginTrade" | "cancelTrade" | "finishReadyCheck" | "selfRes" | "forceQuit" | "loadTalentUi" }
  | { readonly kind: "spiritHealer" | "binder" | "talentWipe"; readonly guid: bigint }
  | { readonly kind: "destroyItem"; readonly bag: number; readonly slot: number }
  | { readonly kind: "battlefield"; readonly slot: number; readonly enter: boolean };

interface Queued {
  status: number;
  isArena: boolean;
  rated: boolean;
  cleared: boolean;
}

export class FrameXmlCannedPopupsWorld implements FrameXmlPopupsWorld {
  readonly events = new EventBus<{ SPIRIT_HEALER_CONFIRM: { guid: bigint } }>();
  readonly calls: FrameXmlCannedPopupsCall[] = [];
  readonly state = { selfGuid: FRAMEXML_CANNED_POPUPS_PLAYER_GUID as bigint | undefined };
  group: { leaderGuid: bigint; ownFlags: number; members: { guid: bigint }[] } | undefined;
  groupInvite: { inviterName: string; canAccept: boolean } | undefined;
  duelRequest: { challengerGuid: bigint } | undefined;
  duelFlag: bigint | undefined;
  duelInBounds: boolean | undefined;
  resurrectRequest: { casterGuid: bigint; casterName: string; sickness: boolean; useTimer: boolean } | undefined;
  corpse: { found: boolean; mapId: number; corpseMapId: number; x: number; y: number; z: number } | undefined;
  corpseReclaimDelay = 0;
  corpseReclaimReportedAt = 0;
  summonRequest: { summoner: bigint; zoneId: number } | undefined;
  summonExpiresAt = 0;
  guildInvite: { inviterName: string; guildName: string } | undefined;
  arenaTeamInvite: { playerName: string; teamName: string } | undefined;
  tradePending = false;
  tradeOpen = false;
  tradeBeginRequested = false;
  tradePartnerGuid = 0n;
  logout: { result: number; instant: boolean } | undefined;
  loggedOut = false;
  readyCheck: { initiatorGuid: bigint; startedAt: number; answers: Map<bigint, boolean> } | undefined;
  readonly battlefieldQueues = new Map<number, Queued>();
  readonly battlefieldInviteDeadlines = new Map<number, number>();
  /** The player's own facts, as the update fields would carry them. */
  life: FrameXmlPlayerLife = "alive";
  fieldBytes = FRAMEXML_RELEASE_TIMER_FLAG;
  selfResSpell = 0;
  inCombat = false;
  level = 60;
  position = { mapId: 0, x: -9449, y: 64, z: 56, reach: 1.5 };
  healerInRange = true;
  /** `Quit()` asked for the logout being counted (GameMenu.ts's intent). */
  quitting = false;
  /** The canned bags: wire position → the item there (`FRAMEXML_CANNED_POPUPS_BAG`). */
  readonly bag = new Map<string, { readonly name: string; readonly quality: number }>(FRAMEXML_CANNED_POPUPS_BAG);
  /** The stock bag cursor: the wire position of the item picked up. */
  cursor: { bag: number; slot: number } | undefined;
  binderConfirm: { guid: bigint } | undefined;
  talentWipeConfirm: { guid: bigint; cost: number } | undefined;
  instanceLock: {
    expiresAt: number; encounterMask: number; previouslySaved: boolean; mapId: number; difficulty: number;
  } | undefined;
  /** The current map and SMSG_INSTANCE_DIFFICULTY's difficulty (GetInstanceLockTimeRemaining with no lock). */
  mapId: number | undefined = 0;
  instanceDifficulty = 0;
  bindPoint: { areaId: number } | undefined;
  /** SMSG_INIT_WORLD_STATES: Elwynn Forest, Goldshire. */
  worldStateContext: { mapId: number; zoneId: number; areaId: number } | undefined = { mapId: 0, zoneId: 12, areaId: 87 };
  /** The innkeeper or trainer that asked is within INTERACTION_DISTANCE. */
  npcInRange = true;
  /** The player's sub-zone, as the host's terrain reads it. */
  playerArea: string | undefined = "Златоземье";
  /** Blizzard_TalentUI as a lazy talent owner reports it; undefined: the host has none (CannedWorldSeam). */
  talentUiState: FrameXmlTalentUiState | undefined;
  /** PLAYER_FIELD_COINAGE, for the talent-reset quote. */
  money = 1_000_000;
  #duelFlags = 0n;
  readonly #clock: () => number;

  constructor(clock: () => number = () => performance.now()) {
    this.#clock = clock;
  }

  now(): number { return this.#clock(); }

  displayName(guid: bigint): string {
    return FRAMEXML_CANNED_POPUPS_NAMES.get(guid) ?? `0x${guid.toString(16).padStart(16, "0")}`;
  }

  corpseReclaimRemaining(now = this.now()): number {
    if (this.corpseReclaimDelay <= 0) return 0;
    return Math.max(0, this.corpseReclaimDelay - (now - this.corpseReclaimReportedAt));
  }

  summonBlockReason(): "dead" | "combat" | undefined {
    if (this.life !== "alive") return "dead";
    return this.inCombat ? "combat" : undefined;
  }

  // ---- commands (as WorldClient changes its state on each) -------------------------------------

  answerGroupInvite(accept: boolean): void {
    if (!this.groupInvite) return;
    this.groupInvite = undefined;
    this.calls.push({ kind: "group", accept });
  }
  answerDuel(accept: boolean): void {
    if (!this.duelRequest) return;
    this.duelRequest = undefined;
    // As WorldClient.answerDuel: an accepted duel keeps its flag for the fight, a declined one goes.
    if (!accept) this.duelFlag = undefined;
    this.calls.push({ kind: "duel", accept });
  }
  answerResurrect(accept: boolean): void {
    if (!this.resurrectRequest) return;
    this.resurrectRequest = undefined;
    this.calls.push({ kind: "resurrect", accept });
  }
  releaseSpirit(): void { this.calls.push({ kind: "repop" }); }
  reclaimCorpse(): void { this.calls.push({ kind: "reclaim" }); }
  answerSummon(accept: boolean): void {
    if (!this.summonRequest || this.summonExpiresAt <= this.now()) return;
    if (accept && this.summonBlockReason() !== undefined) return;
    this.summonRequest = undefined;
    this.calls.push({ kind: "summon", accept });
  }
  answerGuildInvite(accept: boolean): void {
    if (!this.guildInvite) return;
    this.guildInvite = undefined;
    this.calls.push({ kind: "guild", accept });
  }
  answerArenaTeamInvite(accept: boolean): void {
    this.arenaTeamInvite = undefined;
    this.calls.push({ kind: "arena", accept });
  }
  beginTrade(): void {
    if (!this.tradePending || this.tradeBeginRequested) return;
    this.tradeBeginRequested = true;
    this.calls.push({ kind: "beginTrade" });
  }
  cancelTrade(): void {
    this.calls.push({ kind: "cancelTrade" });
    this.tradePending = false;
    this.tradeOpen = false;
    this.tradeBeginRequested = false;
    this.tradePartnerGuid = 0n;
  }
  answerReadyCheck(ready: boolean): void { this.calls.push({ kind: "readyCheck", accept: ready }); }
  finishReadyCheck(): void { this.calls.push({ kind: "finishReadyCheck" }); }
  activateSpiritHealer(guid: bigint): void { this.calls.push({ kind: "spiritHealer", guid }); }
  portToBattleground(queueSlot: number, enter: boolean): void {
    this.calls.push({ kind: "battlefield", slot: queueSlot, enter });
  }
  useSelfResurrection(): void { this.calls.push({ kind: "selfRes" }); }
  destroyItem(bag: number, slot: number): void {
    this.calls.push({ kind: "destroyItem", bag, slot });
    this.bag.delete(`${bag}:${slot}`);
  }
  confirmBinder(): boolean {
    const request = this.binderConfirm;
    if (!request) return false;
    this.binderConfirm = undefined;
    this.calls.push({ kind: "binder", guid: request.guid });
    return true;
  }
  declineBinder(): void { this.binderConfirm = undefined; }
  answerTalentWipe(accept: boolean): TalentWipeAnswer {
    const request = this.talentWipeConfirm;
    if (!request) return "none";
    this.talentWipeConfirm = undefined;
    if (!accept) return "declined";
    if (this.money < request.cost) return "unaffordable";
    this.calls.push({ kind: "talentWipe", guid: request.guid });
    return "sent";
  }
  respondInstanceLock(accept: boolean): boolean {
    const lock = this.instanceLock;
    if (!lock || lock.expiresAt <= this.now()) return false;
    this.instanceLock = undefined;
    this.calls.push({ kind: "instanceLock", accept });
    return true;
  }

  // ---- the stock bag cursor, as the seam keeps it ------------------------------------------

  cursorItem(): { bag: number; slot: number; name: string; quality: number } | undefined {
    const cursor = this.cursor;
    const item = cursor && this.bag.get(`${cursor.bag}:${cursor.slot}`);
    return cursor && item ? { ...cursor, ...item } : undefined;
  }
  pickupItem(bag: number, slot: number): boolean {
    if (!this.bag.has(`${bag}:${slot}`)) return false;
    this.cursor = { bag, slot };
    return true;
  }
  clearCursor(): void { this.cursor = undefined; }

  // ---- scripted server messages ------------------------------------------------------------

  /** SMSG_GROUP_INVITE. */
  invite(inviterName = "Джайна", canAccept = true): void {
    this.groupInvite = { inviterName, canAccept };
  }
  /** SMSG_DUEL_REQUESTED naming `challenger`. */
  duel(challengerGuid = 0x53n): void {
    this.duelRequest = { challengerGuid };
    this.#duelFlags += 1n;
    this.duelFlag = 0xf130_0000_5268_0000n + this.#duelFlags;
  }
  /** SMSG_DUEL_OUTOFBOUNDS / SMSG_DUEL_INBOUNDS. */
  bounds(inBounds: boolean): void { this.duelInBounds = inBounds; }
  /** SMSG_DUEL_COMPLETE. */
  endDuel(): void {
    this.duelRequest = undefined;
    this.duelFlag = undefined;
    this.duelInBounds = undefined;
  }
  /** Health 0: the corpse, with the release timer flag the server sets outside instances. */
  die(flags = FRAMEXML_RELEASE_TIMER_FLAG): void {
    this.life = "dead";
    this.fieldBytes = flags;
  }
  /** PLAYER_FLAGS_GHOST after CMSG_REPOP_REQUEST, with MSG_CORPSE_QUERY's answer and the reclaim delay. */
  release(corpseDistance = 200, reclaimDelayMs = 30_000): void {
    this.life = "ghost";
    this.corpse = { found: true, mapId: this.position.mapId, corpseMapId: this.position.mapId,
      x: this.position.x + corpseDistance, y: this.position.y, z: this.position.z };
    this.corpseReclaimDelay = reclaimDelayMs;
    this.corpseReclaimReportedAt = this.now();
  }
  /** The ghost walks to its body. */
  reachCorpse(): void {
    if (this.corpse) this.position = { ...this.position, x: this.corpse.x - 5 };
  }
  /** Resurrected: health back, the ghost flag cleared. */
  revive(): void {
    this.life = "alive";
    this.corpse = undefined;
    this.corpseReclaimDelay = 0;
    this.resurrectRequest = undefined;
  }
  /** SMSG_RESURRECT_REQUEST. */
  offerResurrect(casterGuid = 0x52n, sickness = false, useTimer = true, casterName = ""): void {
    this.resurrectRequest = { casterGuid, casterName, sickness, useTimer };
  }
  /** SMSG_SUMMON_REQUEST (Stormwind, zone 1519, two minutes). */
  summon(summoner = 0x51n, zoneId = 1519, timeoutMs = 120_000): void {
    this.summonRequest = { summoner, zoneId };
    this.summonExpiresAt = this.now() + timeoutMs;
  }
  /** SMSG_GUILD_INVITE. */
  guild(inviterName = "Утер", guildName = "Серебряная длань"): void {
    this.guildInvite = { inviterName, guildName };
  }
  /** SMSG_ARENA_TEAM_INVITE. */
  arena(playerName = "Тралл", teamName = "Орда навсегда"): void {
    this.arenaTeamInvite = { playerName, teamName };
  }
  /** SMSG_TRADE_STATUS TRADE_STATUS_BEGIN_TRADE from `partner`. */
  tradeRequest(partner = 0x51n): void {
    this.tradePending = true;
    this.tradeOpen = false;
    this.tradeBeginRequested = false;
    this.tradePartnerGuid = partner;
  }
  /** TRADE_STATUS_OPEN_WINDOW after BeginTrade. */
  openTrade(): void {
    this.tradePending = false;
    this.tradeOpen = true;
    this.tradeBeginRequested = false;
  }
  /** SMSG_LOGOUT_RESPONSE granted (not instant) — the countdown; `cancelCamp` is the cancel ack. */
  camp(instant = false): void { this.logout = { result: 0, instant }; }
  /** `Quit()`: the same logout, remembered as a quit. */
  quit(): void {
    this.quitting = true;
    this.camp();
  }
  cancelCamp(): void {
    this.logout = undefined;
    this.quitting = false;
  }
  /** MSG_RAID_READY_CHECK from `initiator`; the player's party is Джайна, Утер and Тралл. */
  startReadyCheck(initiator = 0x51n, leader = 0x51n): void {
    this.group = { leaderGuid: leader, ownFlags: 0, members: [{ guid: 0x51n }, { guid: 0x52n }, { guid: 0x53n }] };
    this.readyCheck = { initiatorGuid: initiator, startedAt: this.now(), answers: new Map() };
  }
  /** MSG_RAID_READY_CHECK_CONFIRM. */
  confirmReady(guid: bigint, ready: boolean): void { this.readyCheck?.answers.set(guid, ready); }
  /** MSG_RAID_READY_CHECK_FINISHED. */
  endReadyCheck(): void { this.readyCheck = undefined; }
  /** SMSG_BATTLEFIELD_STATUS STATUS_WAIT_JOIN for `slot`, two minutes to enter. */
  battlefieldInvite(slot = 0, isArena = false, removeMs = 120_000): void {
    this.battlefieldQueues.set(slot, { status: 2, isArena, rated: false, cleared: false });
    this.battlefieldInviteDeadlines.set(slot, this.now() + removeMs);
  }
  /** SMSG_SPIRIT_HEALER_CONFIRM. */
  spiritHealer(guid = FRAMEXML_CANNED_SPIRIT_HEALER_GUID): void {
    this.events.emit("SPIRIT_HEALER_CONFIRM", { guid });
  }
  /** SMSG_BINDER_CONFIRM: the innkeeper asks (a new object per packet, as WorldClient keeps it). */
  binder(guid = FRAMEXML_CANNED_INNKEEPER_GUID): void { this.binderConfirm = { guid }; }
  /** SMSG_BIND_POINT_UPDATE: the hearthstone's area (Goldshire). */
  bound(areaId = 87): void { this.bindPoint = { areaId }; }
  /** MSG_TALENT_WIPE_CONFIRM: the trainer's quote in copper. */
  talentWipe(cost = 50_000, guid = FRAMEXML_CANNED_TRAINER_GUID): void { this.talentWipeConfirm = { guid, cost }; }
  /** SMSG_INSTANCE_LOCK_WARNING_QUERY: Utgarde Keep normal, bosses 1 and 3 of 3 killed. */
  lockWarning(milliseconds = 60_000, encounterMask = 0b101, mapId = 574, difficulty = 0, previouslySaved = false): void {
    this.instanceLock = { expiresAt: this.now() + milliseconds, encounterMask, previouslySaved, mapId, difficulty };
  }
}

/** The `framexml.html?popup=` and RICH-route scenes, each the server messages behind one dialog. */
export const FRAMEXML_CANNED_POPUP_SCENES: Readonly<Record<string, (world: FrameXmlCannedPopupsWorld) => void>> = Object.freeze({
  party: (world) => world.invite(),
  duel: (world) => world.duel(),
  outofbounds: (world) => { world.duel(0x42n); world.bounds(false); },
  death: (world) => world.die(),
  corpse: (world) => { world.die(); world.release(10, 25_000); world.reachCorpse(); },
  resurrect: (world) => { world.die(); world.offerResurrect(0x52n, false, false); },
  sickness: (world) => { world.die(); world.offerResurrect(0x52n, true, true); },
  summon: (world) => world.summon(),
  guild: (world) => world.guild(),
  arena: (world) => world.arena(),
  trade: (world) => world.tradeRequest(),
  camp: (world) => world.camp(),
  readycheck: (world) => world.startReadyCheck(),
  xploss: (world) => { world.die(); world.release(); world.spiritHealer(); },
  quit: (world) => world.quit(),
  binder: (world) => world.binder(),
  // No DELETE_ITEM scene: CannedWorldSeam's CursorHasItem is always false, so the dialog's own
  // OnUpdate closes it a frame later; the tests and the rich route give the seam this cursor. No
  // talent-reset scene: the canned seam has no lazy Blizzard_TalentUI owner, so the question stays
  // with the native prompt; and no instance-lock scene: its dialog names the instance through
  // GetInstanceInfo, which CannedWorldSeam does not answer.
});

/** A canned model over its own scripted world. */
export function createCannedFrameXmlPopups(
  world = new FrameXmlCannedPopupsWorld(),
  overrides: Partial<FrameXmlPopupsContext> = {},
): { readonly model: FrameXmlPopupsModel; readonly world: FrameXmlCannedPopupsWorld } {
  const tokens = (): readonly (readonly [string, bigint])[] => [
    ["player", FRAMEXML_CANNED_POPUPS_PLAYER_GUID],
    ...(world.group?.members ?? []).map((member, index): readonly [string, bigint] => [`party${index + 1}`, member.guid]),
  ];
  const model = new FrameXmlPopupsModel({
    world: () => world,
    playerLife: () => world.life,
    playerPosition: () => world.position,
    playerFieldBytes: () => world.fieldBytes,
    selfResurrectSpell: () => world.selfResSpell,
    playerLevel: () => world.level,
    unitGuid: (unit) => tokens().find(([token]) => token === unit)?.[1],
    unitToken: (guid) => tokens().find(([, member]) => member === guid)?.[0],
    spellName: (id) => (id === 20608 ? "Перерождение" : undefined),
    areaName: (zoneId) => FRAMEXML_CANNED_AREAS.get(zoneId),
    spiritHealerInRange: () => world.healerInRange,
    npcInRange: () => world.npcInRange,
    playerAreaName: () => world.playerArea,
    talentUi: () => world.talentUiState,
    loadTalentUi: () => {
      world.calls.push({ kind: "loadTalentUi" });
      if (world.talentUiState === "idle") world.talentUiState = "loading";
    },
    dungeonEncounters: (mapId, difficulty) => FRAMEXML_CANNED_DUNGEON_ENCOUNTERS.get(`${mapId}/${difficulty}`),
    quitting: () => world.quitting,
    forceQuit: () => { world.calls.push({ kind: "forceQuit" }); },
    cursorItem: () => world.cursorItem(),
    pickupItem: (bag, slot) => world.pickupItem(bag, slot),
    clearCursor: () => world.clearCursor(),
    monotonic: () => world.now(),
    ...overrides,
  });
  return { model, world };
}
