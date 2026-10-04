/**
 * The server's confirmations as the stock client asks them: StaticPopup.xml's dialogs and
 * ReadyCheck.xml's ReadyCheckFrame, both already loaded by the world vertical, driven by the real
 * events UIParent_OnEvent listens for (UIParent.lua:105-179, 454-939) and answered through the real
 * C API names.
 *
 * Before this model nothing fired PARTY_INVITE_REQUEST, DUEL_REQUESTED, RESURRECT_REQUEST,
 * PLAYER_DEAD, CORPSE_IN_RANGE, CONFIRM_SUMMON, GUILD_INVITE_REQUEST, ARENA_TEAM_INVITE_REQUEST,
 * TRADE_REQUEST, PLAYER_CAMPING, CONFIRM_XP_LOSS or READY_CHECK (measured: zero hits in src), and 30
 * of the answering C APIs were empty stub-plan functions, so every one of those dialogs stayed
 * dormant while native panels (Social.ts, Guild.ts, Npc.ts, ArenaWindow.ts, InteractionPrompts.ts,
 * ReadyCheck.ts, GameMenu.ts) asked instead.
 *
 * Most of the world's request state has no EventBus edge — `groupInvite`, `duelRequest`,
 * `resurrectRequest`, the trade and guild fields are written by packet handlers that call one
 * single-slot callback EnterWorld owns — so `tick` compares identities (a dozen property reads,
 * measured at about 1 µs) on LiveWorldSeam's 60 ms poll, the rule every other world read without
 * an edge follows, and turns a change into the stock event. The payload is never trusted: the
 * handlers re-read the world through the C API, as the client's own do.
 *
 * Ownership is an edge, not a flag (`popupsOwned`), exactly like the LFD popups: until the stock
 * popup owner is published the native prompts answer and no show event fires; from publication on,
 * whatever is still pending is shown by stock (the ordinary tick rule "pending and not yet shown"),
 * and every command binding is inert unless the stock owner holds the prompts — a Lua OnHide during
 * a gate probe or a teardown can therefore never answer a server question the native prompt owns.
 *
 * М1 (docs/implementation/line-A3.ru.md) adds three questions on the same rule: CONFIRM_BINDER (the
 * innkeeper), CONFIRM_TALENT_WIPE (the trainer's quote — fired only once Blizzard_TalentUI is
 * loaded, because UIParent's handler calls TalentFrame_LoadUI) and INSTANCE_LOCK_START/STOP (only
 * with the DungeonEncounter table behind its boss line), over WorldClient's `binderConfirm`,
 * `talentWipeConfirm`, `instanceLock` (world/ConfirmationProtocol.ts). A question stock cannot ask
 * honestly is left to the native prompt (FrameXmlPopupsController.ts `frameXmlPopupsLeftToNative`);
 * the innkeeper's and the trainer's are asked once per packet, as 3.3.5 fires them.
 */
import { globalString } from "../../generated/globalStrings.js";
import type { TalentWipeAnswer } from "../../world/ConfirmationProtocol.js";
import { frameXmlPopupAnswer, markFrameXmlPopupAnswered } from "./FrameXmlPopupsAnswered.js";
import { frameXmlPopupsLeftToNative, markFrameXmlPopupLeftToNative } from "./FrameXmlPopupsController.js";

/** `ReadyCheckFrame` has no clock of its own; the client times a check out after 35 seconds. */
export const FRAMEXML_READY_CHECK_SECONDS = 35;
/** `WorldSession::ShouldLogOut` (WorldSession.h:514): logout completes 20 s after the grant. */
export const FRAMEXML_CAMP_SECONDS = 20;
/** `Player::KillPlayer` (Player.cpp:4787): six minutes until the server repops the corpse. */
export const FRAMEXML_RELEASE_SECONDS = 360;
/** `CORPSE_RECLAIM_RADIUS` (Corpse.h:36), the range `HandleReclaimCorpseOpcode` checks. */
export const FRAMEXML_CORPSE_RECLAIM_RADIUS = 39;
/** `PLAYER_FIELD_BYTE_RELEASE_TIMER` / `_NO_RELEASE_WINDOW` (Player.h:438-439). */
export const FRAMEXML_RELEASE_TIMER_FLAG = 0x08;
export const FRAMEXML_NO_RELEASE_WINDOW_FLAG = 0x10;
/**
 * How long a show waits for a name query before it falls back to what it has. The request packets
 * for duels, summons, trades and ready checks carry a GUID only; `WorldClient` asks for the name on
 * arrival and the answer is normally back within a frame or two.
 */
export const FRAMEXML_POPUP_NAME_WAIT_MS = 1500;
/**
 * How long a talent-reset question waits for Blizzard_TalentUI before the native prompt takes it.
 * UIParent's CONFIRM_TALENT_WIPE branch calls TalentFrame_LoadUI() — UIParentLoadAddOn — right after
 * showing the dialog (UIParent.lua:880-892): with the add-on not loaded the host's LoadAddOn answers
 * NOT_READY and stock raises its load error, so the event is fired only once the add-on is in.
 */
export const FRAMEXML_TALENT_UI_WAIT_MS = 1500;
/** `STATUS_WAIT_QUEUE`/`STATUS_WAIT_JOIN`/`STATUS_IN_PROGRESS` (PvpProtocol.ts), kept local so the model stays pure. */
const BATTLEFIELD_WAIT_QUEUE = 1;
const BATTLEFIELD_WAIT_JOIN = 2;
const BATTLEFIELD_IN_PROGRESS = 3;
/** `MEMBER_FLAG_ASSISTANT` (GroupProtocol.ts). */
const MEMBER_FLAG_ASSISTANT = 0x01;

export type FrameXmlPlayerLife = "alive" | "dead" | "ghost";

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlPopupsWorld {
  readonly events?: {
    on(name: "SPIRIT_HEALER_CONFIRM", listener: (payload: { guid: bigint }) => void): () => void;
  } | undefined;
  readonly state?: { readonly selfGuid?: bigint | undefined } | undefined;
  readonly group?: {
    readonly leaderGuid?: bigint | undefined;
    readonly ownFlags?: number | undefined;
    readonly members?: readonly { readonly guid: bigint }[] | undefined;
  } | undefined;
  readonly groupInvite?: { readonly inviterName: string; readonly canAccept: boolean } | undefined;
  readonly duelRequest?: { readonly challengerGuid: bigint } | undefined;
  /**
   * The planted flag of the duel in play (SMSG_DUEL_REQUESTED, both duelists): it survives an
   * accepted request and goes with SMSG_DUEL_WINNER/SMSG_DUEL_COMPLETE or a declined one — the
   * duel's own lifetime, which DUEL_FINISHED marks the end of.
   */
  readonly duelFlag?: bigint | undefined;
  readonly duelInBounds?: boolean | undefined;
  readonly resurrectRequest?: {
    readonly casterGuid: bigint; readonly casterName: string; readonly sickness: boolean; readonly useTimer: boolean;
  } | undefined;
  readonly corpse?: {
    readonly found: boolean; readonly mapId: number; readonly corpseMapId: number;
    readonly x: number; readonly y: number; readonly z: number;
  } | undefined;
  corpseReclaimRemaining?(now?: number): number;
  readonly summonRequest?: { readonly summoner: bigint; readonly zoneId: number } | undefined;
  readonly summonExpiresAt?: number | undefined;
  summonBlockReason?(): "dead" | "combat" | undefined;
  readonly guildInvite?: { readonly inviterName: string; readonly guildName: string } | undefined;
  readonly arenaTeamInvite?: { readonly playerName: string; readonly teamName: string } | undefined;
  readonly tradePending?: boolean | undefined;
  readonly tradeOpen?: boolean | undefined;
  readonly tradeBeginRequested?: boolean | undefined;
  readonly tradePartnerGuid?: bigint | undefined;
  readonly logout?: { readonly result: number; readonly instant: boolean } | undefined;
  readonly loggedOut?: boolean | undefined;
  readonly readyCheck?: {
    readonly initiatorGuid: bigint; readonly startedAt: number; readonly answers: ReadonlyMap<bigint, boolean>;
  } | undefined;
  readonly battlefieldQueues?: ReadonlyMap<number, {
    readonly status: number; readonly isArena: boolean; readonly rated: boolean; readonly cleared?: boolean;
  }> | undefined;
  readonly battlefieldInviteDeadlines?: ReadonlyMap<number, number> | undefined;
  displayName?(guid: bigint): string;
  answerGroupInvite(accept: boolean): void;
  answerDuel(accept: boolean): void;
  answerResurrect(accept: boolean): void;
  releaseSpirit(): void;
  reclaimCorpse(): void;
  answerSummon(accept: boolean): void;
  answerGuildInvite(accept: boolean): void;
  answerArenaTeamInvite(accept: boolean): void;
  beginTrade(): void;
  cancelTrade(): void;
  answerReadyCheck(ready: boolean): void;
  finishReadyCheck(): void;
  activateSpiritHealer(guid: bigint): void;
  portToBattleground(queueSlot: number, enter: boolean): void;
  useSelfResurrection?(): void;
  /** CMSG_DESTROYITEM for the item at a wire position (count 0: the whole stack). */
  destroyItem?(bag: number, slot: number): void;
  // М1 (world/ConfirmationProtocol.ts): the world drops each of these once answered, out of the
  // NPC's reach, past the server's deadline or on a new map.
  /** SMSG_BINDER_CONFIRM: the innkeeper asking. */
  readonly binderConfirm?: { readonly guid: bigint } | undefined;
  /** MSG_TALENT_WIPE_CONFIRM: the trainer's quote, in copper. */
  readonly talentWipeConfirm?: { readonly guid: bigint; readonly cost: number } | undefined;
  /** SMSG_INSTANCE_LOCK_WARNING_QUERY: the server's deadline (monotonic ms) and the killed-boss mask. */
  readonly instanceLock?: {
    readonly expiresAt: number; readonly encounterMask: number; readonly previouslySaved: boolean;
    readonly mapId: number; readonly difficulty: number;
  } | undefined;
  /**
   * The current map and SMSG_INSTANCE_DIFFICULTY's difficulty: with no lock pending the client
   * still counts their DungeonEncounter rows for GetInstanceLockTimeRemaining (Wow.exe 0xbd088c,
   * written at each world change, and 0xbd0894, which GetInstanceDifficulty returns plus one).
   */
  readonly mapId?: number | undefined;
  readonly instanceDifficulty?: number | undefined;
  /** SMSG_BIND_POINT_UPDATE: where the hearthstone goes. */
  readonly bindPoint?: { readonly areaId: number } | undefined;
  /** SMSG_INIT_WORLD_STATES' zone and area: the place CONFIRM_BINDER names when the host has none. */
  readonly worldStateContext?: { readonly zoneId: number; readonly areaId: number } | undefined;
  /** CMSG_BINDER_ACTIVATE, once. */
  confirmBinder?(): unknown;
  answerTalentWipe?(accept: boolean): TalentWipeAnswer;
  /** CMSG_INSTANCE_LOCK_RESPONSE, once. */
  respondInstanceLock?(accept: boolean): unknown;
}

/**
 * Blizzard_TalentUI as the host's lazy talent owner reports it: `ready` (loaded — UIParent's
 * TalentFrame_LoadUI is quiet and PlayerTalentFrame_Open exists), `idle` (not loaded, the load not
 * started), `loading`, `failed`.
 */
export type FrameXmlTalentUiState = "ready" | "idle" | "loading" | "failed";

/** One `DungeonEncounter.dbc` row of a map and difficulty: its bit in the killed-boss mask and name. */
export interface FrameXmlDungeonEncounter {
  readonly bit: number;
  readonly name: string;
}

/**
 * The innkeeper's and the trainer's questions stock has asked. 3.3.5 fires CONFIRM_BINDER and
 * CONFIRM_TALENT_WIPE when the packet arrives and nothing re-fires them on PLAYER_ENTERING_WORLD, so
 * a /reload (re-publication) or a remount does not ask them again — the question itself stays
 * pending, as stock's Cancel calls no C API (`/run ConfirmBinder()` still binds). Per request object,
 * like `refusedInvitesAnnounced`. INSTANCE_LOCK is shown again: its dialog counts on from what is left.
 */
const stockAskedOnce = new WeakSet<object>();

/** CONFIRM_BINDER's place when no name is loaded: the native prompt's own words. */
const FRAMEXML_BIND_PLACE_FALLBACK = "Это место";

/**
 * Bit `bit` of a killed-boss mask (`1 << DungeonEncounter.Bit`, InstanceScript.cpp:940), tested as
 * the client tests it: `1 << (Bit & 31)` (Wow.exe 0x00553830), as DungeonEncounterClient's
 * `encounterKilled`.
 */
function killedBit(mask: number, bit: number): boolean {
  return ((mask >>> 0) & (1 << (bit & 31))) !== 0;
}

/** The item on the stock bag cursor: its wire position and what DELETE_ITEM_CONFIRM names. */
export interface FrameXmlPopupsCursorItem {
  readonly bag: number;
  readonly slot: number;
  readonly name: string;
  /** `ITEM_QUALITY_*`: UIParent asks DELETE_GOOD_ITEM (type the word) from rare (3) up. */
  readonly quality: number;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlPopupsContext {
  world(): FrameXmlPopupsWorld | undefined;
  /** The player's life from the update fields: health 0 is a corpse, PLAYER_FLAGS_GHOST a ghost. */
  playerLife(): FrameXmlPlayerLife | undefined;
  /** The player's map, position and UNIT_FIELD_COMBATREACH, for the corpse range. */
  playerPosition(): { readonly mapId: number; readonly x: number; readonly y: number; readonly z: number;
    readonly reach: number } | undefined;
  /** `PLAYER_FIELD_BYTES`: the release-timer and no-release-window flags. */
  playerFieldBytes(): number | undefined;
  /** `PLAYER_SELF_RES_SPELL`: a soulstone, Reincarnation or ankh the player may use while dead. */
  selfResurrectSpell(): number | undefined;
  playerLevel(): number;
  /** The unit token's GUID, as the seam's own unit functions resolve it. */
  unitGuid(unit: string): bigint | undefined;
  /** The unit token for a group member (`player`, `partyN`, `raidN`), for READY_CHECK_CONFIRM. */
  unitToken?(guid: bigint): string | undefined;
  spellName?(id: number): string | undefined;
  /** `AreaTable` name of a zone id (the summon's destination). */
  areaName?(zoneId: number): string | undefined;
  /**
   * Whether the spirit healer that asked is still within the core's NPC interaction range
   * (`withinNpcInteraction`, ConfirmationProtocol.ts); undefined if unknown.
   */
  spiritHealerInRange?(guid: bigint): boolean | undefined;
  /**
   * Whether the logout being counted was asked for by `Quit()` (GameMenu.ts keeps that intent):
   * the client then fires PLAYER_QUITING — StaticPopup QUIT — instead of PLAYER_CAMPING.
   */
  quitting?(): boolean;
  /** `ForceQuit()`: leave for the login screen now instead of when the server completes the logout. */
  forceQuit?(): void;
  /** The item on the seam's stock bag cursor, or undefined with an empty cursor. */
  cursorItem?(): FrameXmlPopupsCursorItem | undefined;
  /** Put the item at a wire position on the stock cursor; false when there is no such item. */
  pickupItem?(bag: number, slot: number): boolean;
  clearCursor?(): void;
  /** Monotonic milliseconds on the clock the world stamps requests with (`performance.now`). */
  monotonic(): number;
  /**
   * Whether the NPC that asked (the innkeeper, the trainer) can still take the answer — the core's
   * interaction range (`withinInteractionDistance`, ConfirmationProtocol.ts); undefined when unknown.
   * Without it CheckBinderDist/CheckTalentMasterDist turn false when the world drops the question.
   */
  npcInRange?(guid: bigint): boolean | undefined;
  /** The player's sub-zone, else zone: the place CONFIRM_BINDER names (the core binds where the player stands). */
  playerAreaName?(): string | undefined;
  /** Blizzard_TalentUI for CONFIRM_TALENT_WIPE; absent: the host has no lazy talent owner. */
  talentUi?(): FrameXmlTalentUiState | undefined;
  /** Start the lazy talent owner's load, without opening the window. */
  loadTalentUi?(): void;
  /** The DungeonEncounter rows of a map and difficulty (М2), undefined while the table is unknown. */
  dungeonEncounters?(mapId: number, difficulty: number): readonly FrameXmlDungeonEncounter[] | undefined;
}

interface FrameXmlPopupsPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** One pending server question: the world's object, whether stock was asked to show it, since when. */
interface Pending<T> {
  value: T | undefined;
  shown: boolean;
  seenAt: number;
}

function pending<T>(): Pending<T> {
  return { value: undefined, shown: false, seenAt: 0 };
}

/** Lua truthiness: nil and false are false; stock passes `1`/nil for booleans. */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

function resolvedName(world: FrameXmlPopupsWorld, guid: bigint): string | undefined {
  const name = world.displayName?.(guid);
  return name && !/^0x[0-9a-f]+$/i.test(name) ? name : undefined;
}

/** What the client remembers of the player's death while one world lives (see `lifeMemory`). */
interface LifeMemory {
  /** The life the last look at this world saw. */
  life: FrameXmlPlayerLife;
  /** When the death the release timer counts from was first seen (monotonic ms). */
  diedAt: number;
  /** CMSG_REPOP_REQUEST already went out for this death. */
  repopSent: boolean;
}

/**
 * The death the release timer counts from, per world rather than per model: `Player::KillPlayer`
 * starts the server's six minutes once, and a /reload or a mount rebuilt after its gate — a new
 * model, or this one detached and attached again — must not restart the dialog at «6 мин.» while
 * the server repops the body on its original clock. The client's own GetReleaseTimeRemaining
 * survives a UI reload the same way. Keyed by the world object: a new session starts afresh.
 */
const lifeMemory = new WeakMap<object, LifeMemory>();

/**
 * Group invitations that could not be accepted (canAccept 0) and were already said in chat. The
 * world keeps such an invite until it is answered, and nothing answers one, so without this every
 * re-publication of the owner (each /reload) printed ERR_INVITED_ALREADY_IN_GROUP_SS again.
 */
const refusedInvitesAnnounced = new WeakSet<object>();

/**
 * One owner of the confirmation C API and its events. Client-held state (when the player died,
 * when the logout was granted, the spirit healer that asked, the answers already sent) lives here,
 * as the client keeps it in its own memory; server state is read from the world on every call.
 */
export class FrameXmlPopupsModel {
  readonly #context: FrameXmlPopupsContext;
  #pump: FrameXmlPopupsPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #popupsOwned = false;
  #muted = false;
  #warned = false;
  #world: FrameXmlPopupsWorld | undefined;
  readonly #invite = pending<object>();
  readonly #duel = pending<{ readonly challengerGuid: bigint }>();
  /** The duel flag last seen: its going away is SMSG_DUEL_COMPLETE's DUEL_FINISHED. */
  #duelFlag: bigint | undefined;
  #duelOutShown = false;
  readonly #resurrect = pending<NonNullable<FrameXmlPopupsWorld["resurrectRequest"]>>();
  readonly #summon = pending<{ readonly summoner: bigint; readonly zoneId: number }>();
  readonly #guild = pending<{ readonly inviterName: string; readonly guildName: string }>();
  readonly #arena = pending<{ readonly playerName: string; readonly teamName: string }>();
  readonly #trade = pending<{ readonly partner: bigint }>();
  #tradeKey: bigint | undefined;
  readonly #camp = pending<object>();
  #campGrantedAt = 0;
  /** PLAYER_QUITING was fired for the logout being counted (QUIT is up). */
  #campQuitShown = false;
  readonly #readyCheck = pending<NonNullable<FrameXmlPopupsWorld["readyCheck"]>>();
  #readyAnswers = new Map<bigint, boolean>();
  #readyFinishSent: object | undefined;
  #readyLocallyFinished: object | undefined;
  /** The life this attach saw last; the death's own clock is `lifeMemory`'s. */
  #life: FrameXmlPlayerLife | undefined;
  #deathShown = false;
  #corpse: "near" | "instance" | "far" = "far";
  #corpseShown = false;
  /** Queue slots whose STATUS_WAIT_JOIN stock was told about. */
  readonly #battlefieldShown = new Set<number>();
  #healer: bigint | undefined;
  readonly #binder = pending<NonNullable<FrameXmlPopupsWorld["binderConfirm"]>>();
  readonly #talentWipe = pending<NonNullable<FrameXmlPopupsWorld["talentWipeConfirm"]>>();
  /** The talent-reset question this model asked the host to load Blizzard_TalentUI for. */
  #talentUiLoadFor: object | undefined;
  readonly #instanceLock = pending<NonNullable<FrameXmlPopupsWorld["instanceLock"]>>();

  constructor(context: FrameXmlPopupsContext) {
    this.#context = context;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlPopupsPump): void {
    this.detach();
    this.#pump = pump;
    this.#safely(() => this.#observe(this.#context.world()));
  }

  /**
   * The comparison runs inside the seam's attach and every rendered frame's tick, before the rest
   * of that work: a world that throws (a partial test double, a half-torn-down session) must cost
   * this model its edges, never the seam its frame. Said once in the console.
   */
  #safely(run: () => void): void {
    try {
      run();
    } catch (error) {
      if (!this.#warned) {
        this.#warned = true;
        console.warn(`[FrameXML popups] the confirmations could not read the world: ${String(error)}`);
      }
    }
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#world = undefined;
    this.#popupsOwned = false;
    this.#forgetShown();
  }

  /**
   * Whether the stock dialogs own the confirmations. Until the popup owner is published the native
   * prompts answer them and every show event stays silent; taking ownership shows at once whatever
   * is still waiting for an answer, and giving it up forgets what stock showed (its VM is going).
   */
  get popupsOwned(): boolean { return this.#popupsOwned; }
  set popupsOwned(owned: boolean) {
    if (owned === this.#popupsOwned) return;
    this.#popupsOwned = owned;
    if (owned) this.tick();
    else this.#forgetShown();
  }

  /** Run a transactional probe (the mount's gate) without sending a packet. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #forgetShown(): void {
    for (const slot of [this.#invite, this.#duel, this.#resurrect, this.#summon, this.#guild, this.#arena,
      this.#trade, this.#camp, this.#readyCheck, this.#binder, this.#talentWipe, this.#instanceLock] as Pending<unknown>[]) {
      slot.shown = false;
    }
    this.#duelOutShown = false;
    this.#campQuitShown = false;
    this.#deathShown = false;
    this.#corpseShown = false;
    this.#battlefieldShown.clear();
    this.#healer = undefined;
  }

  /** A command reaches the world only while stock owns the prompts and no probe is running. */
  #command(run: (world: FrameXmlPopupsWorld) => void): boolean {
    if (this.#muted || !this.#popupsOwned) return false;
    const world = this.#context.world();
    if (!world) return false;
    run(world);
    return true;
  }

  #fire(event: string, ...args: readonly unknown[]): void {
    if (this.#popupsOwned && !this.#muted) this.#pump?.fire(event, ...args);
  }

  // ---- the per-frame comparison ---------------------------------------------------------

  /** Compare the world's pending questions with what stock was last told; fire the differences. */
  tick(): void {
    if (!this.#pump) return;
    this.#safely(() => this.#observe(this.#context.world()));
  }

  #observe(world: FrameXmlPopupsWorld | undefined): void {
    if (world !== this.#world) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#world = world;
      this.#forgetShown();
      this.#life = undefined;
      // A duel already in play when this world is first seen ends with a DUEL_FINISHED; its start
      // was never this model's to announce.
      this.#duelFlag = world?.duelFlag;
      this.#readyAnswers = new Map();
      if (world?.events && typeof world.events.on === "function") {
        this.#unsubscribe = world.events.on("SPIRIT_HEALER_CONFIRM", ({ guid }) => this.#spiritHealerConfirm(guid));
      }
    }
    if (!world) return;
    const now = this.#context.monotonic();
    this.#observeLife(world, now);
    this.#observeInvite(world, now);
    this.#observeDuel(world, now);
    this.#observeResurrect(world, now);
    this.#observeSummon(world, now);
    this.#observeGuild(world, now);
    this.#observeArena(world, now);
    this.#observeTrade(world, now);
    this.#observeCamp(world, now);
    this.#observeReadyCheck(world, now);
    this.#observeBattlefield(world, now);
    this.#observeBinder(world, now);
    this.#observeTalentWipe(world, now);
    this.#observeInstanceLock(world, now);
  }

  /** Move a slot to `value`; a slot whose shown request went away fires `hide` (if any). */
  #track<T>(slot: Pending<T>, value: T | undefined, now: number, hide?: () => void): void {
    if (slot.value === value) return;
    const wasShown = slot.shown && slot.value !== undefined;
    slot.value = value;
    slot.shown = false;
    slot.seenAt = now;
    if (wasShown && value === undefined) hide?.();
  }

  /** Show a pending slot once stock owns it and `args` are ready (a name may still be on its way). */
  #show<T>(slot: Pending<T>, now: number, event: string, args: (value: T, late: boolean) => readonly unknown[] | undefined): void {
    if (slot.value === undefined || slot.shown || !this.#popupsOwned || this.#muted) return;
    const values = args(slot.value, now - slot.seenAt >= FRAMEXML_POPUP_NAME_WAIT_MS);
    if (!values) return;
    slot.shown = true;
    this.#pump?.fire(event, ...values);
  }

  #name(world: FrameXmlPopupsWorld, guid: bigint, late: boolean): string | undefined {
    return resolvedName(world, guid) ?? (late ? world.displayName?.(guid) ?? "" : undefined);
  }

  #observeLife(world: FrameXmlPopupsWorld, now: number): void {
    const life = this.#context.playerLife();
    if (life === undefined) return;
    const previous = this.#life;
    this.#life = life;
    const memory = lifeMemory.get(world);
    // A death is stamped once per world, on the first look that finds the body after anything
    // else. A remount finds the death it already stamped and keeps that clock; a death seen on the
    // very first look at a world (login dead) has no moment of death, so the release timer counts
    // from here, the upper bound of what is left.
    if (life === "dead" && memory?.life !== "dead") lifeMemory.set(world, { life, diedAt: now, repopSent: false });
    else if (memory) memory.life = life;
    else lifeMemory.set(world, { life, diedAt: 0, repopSent: false });
    if (previous !== life) {
      if (previous !== undefined) {
        // PLAYER_ALIVE: released to the graveyard, or resurrected before releasing (UIParent.lua:494).
        if (previous === "dead") this.#fire("PLAYER_ALIVE");
        if (previous === "ghost" && life === "alive") this.#fire("PLAYER_UNGHOST");
      }
      if (life !== "dead") this.#deathShown = false;
    }
    if (life === "dead" && !this.#deathShown && this.#popupsOwned && !this.#muted) {
      this.#deathShown = true;
      this.#pump?.fire("PLAYER_DEAD");
    }
    const corpse = life === "ghost" ? this.#corpseRange() : "far";
    if (corpse !== this.#corpse) {
      const wasShown = this.#corpseShown && this.#corpse !== "far";
      this.#corpse = corpse;
      this.#corpseShown = false;
      if (wasShown) this.#fire("CORPSE_OUT_OF_RANGE");
    }
    if (corpse !== "far" && !this.#corpseShown && this.#popupsOwned && !this.#muted) {
      this.#corpseShown = true;
      this.#pump?.fire(corpse === "near" ? "CORPSE_IN_RANGE" : "CORPSE_IN_INSTANCE");
    }
  }

  /**
   * Where the ghost stands relative to its body: within CORPSE_RECLAIM_RADIUS plus the ghost's own
   * reach (`IsWithinDistInMap`, MiscHandler.cpp:679) on the body's map, or at the entrance of the
   * instance the body lies in (MSG_CORPSE_QUERY reports the entrance map and coordinates then).
   */
  #corpseRange(): "near" | "instance" | "far" {
    const corpse = this.#context.world()?.corpse;
    const self = this.#context.playerPosition();
    if (!corpse?.found || !self || self.mapId !== corpse.mapId) return "far";
    const distance = Math.hypot(corpse.x - self.x, corpse.y - self.y, corpse.z - self.z);
    if (distance > FRAMEXML_CORPSE_RECLAIM_RADIUS + Math.max(0, self.reach)) return "far";
    return corpse.corpseMapId === corpse.mapId ? "near" : "instance";
  }

  #observeInvite(world: FrameXmlPopupsWorld, now: number): void {
    this.#track(this.#invite, world.groupInvite, now, () => this.#fire("PARTY_INVITE_CANCEL"));
    const invite = world.groupInvite;
    if (!invite) return;
    // SMSG_GROUP_INVITE with canAccept 0 is TrinityCore telling an invitee already in a group that
    // someone asked (GroupHandler.cpp): no invitation is held server-side, so the client prints
    // ERR_INVITED_ALREADY_IN_GROUP_SS instead of a dialog (the adapter's private event) — once.
    if (!invite.canAccept && refusedInvitesAnnounced.has(invite)) return;
    this.#show(this.#invite, now, invite.canAccept ? "PARTY_INVITE_REQUEST" : "WEBCLIENT_PARTY_INVITE_REFUSED",
      () => [invite.inviterName]);
    if (!invite.canAccept && this.#invite.shown) refusedInvitesAnnounced.add(invite);
  }

  #observeDuel(world: FrameXmlPopupsWorld, now: number): void {
    // DUEL_FINISHED is SMSG_DUEL_COMPLETE's event: the end of the duel, for both duelists — never
    // the player's own answer. `answerDuel` clears the request at once for an accept too, which is
    // when the fight begins; the flag stays until the duel is over (or declined, for which the
    // server sends SMSG_DUEL_COMPLETE as well). Stock hides DUEL_REQUESTED/DUEL_OUTOFBOUNDS on it
    // (UIParent.lua:692-695), so a bounds dialog ends without a DUEL_INBOUNDS of its own.
    const flag = world.duelFlag;
    if (flag !== this.#duelFlag) {
      const ended = this.#duelFlag !== undefined;
      this.#duelFlag = flag;
      if (ended) {
        this.#fire("DUEL_FINISHED");
        this.#duelOutShown = false;
      }
    }
    // SMSG_DUEL_REQUESTED goes to both duelists (SpellEffects.cpp EffectDuel); the challenger's own
    // copy names itself and asks nothing.
    const request = world.duelRequest;
    const incoming = request && request.challengerGuid !== world.state?.selfGuid ? request : undefined;
    this.#track(this.#duel, incoming, now);
    this.#show(this.#duel, now, "DUEL_REQUESTED", (duel, late) => {
      const name = this.#name(world, duel.challengerGuid, late);
      return name === undefined ? undefined : [name];
    });
    // Out of bounds only while a duel is in play: SMSG_DUEL_WINNER can take the flag a frame before
    // SMSG_DUEL_COMPLETE resets the bounds, and that frame must not reopen the finished dialog.
    const out = world.duelInBounds === false && flag !== undefined;
    if (!out && this.#duelOutShown) {
      this.#duelOutShown = false;
      this.#fire("DUEL_INBOUNDS");
    } else if (out && !this.#duelOutShown && this.#popupsOwned && !this.#muted) {
      // Player::CheckDuelDistance counts 10 s once out of bounds — the dialog's own timeout.
      this.#duelOutShown = true;
      this.#pump?.fire("DUEL_OUTOFBOUNDS");
    }
  }

  #observeResurrect(world: FrameXmlPopupsWorld, now: number): void {
    // Accepting, declining and PLAYER_UNGHOST/PLAYER_ALIVE hide the dialog stock-side; a request
    // the server withdrew has no event of its own in 3.3.5, so none is invented here.
    this.#track(this.#resurrect, world.resurrectRequest, now);
    this.#show(this.#resurrect, now, "RESURRECT_REQUEST", (request, late) => {
      const name = request.casterName || this.#name(world, request.casterGuid, late);
      return name === undefined ? undefined : [name];
    });
  }

  #summonPending(world: FrameXmlPopupsWorld, now: number): FrameXmlPopupsWorld["summonRequest"] {
    const request = world.summonRequest;
    return request && (world.summonExpiresAt ?? 0) > now ? request : undefined;
  }

  #observeSummon(world: FrameXmlPopupsWorld, now: number): void {
    this.#track(this.#summon, this.#summonPending(world, now), now, () => this.#fire("CANCEL_SUMMON"));
    this.#show(this.#summon, now, "CONFIRM_SUMMON", (summon, late) =>
      this.#name(world, summon.summoner, late) === undefined ? undefined : []);
  }

  #observeGuild(world: FrameXmlPopupsWorld, now: number): void {
    this.#track(this.#guild, world.guildInvite, now, () => this.#fire("GUILD_INVITE_CANCEL"));
    this.#show(this.#guild, now, "GUILD_INVITE_REQUEST", (invite) => [invite.inviterName, invite.guildName]);
  }

  #observeArena(world: FrameXmlPopupsWorld, now: number): void {
    // No ARENA_TEAM_INVITE_CANCEL: UIParent has a branch for it (UIParent.lua:564) but never
    // registers it (only ARENA_TEAM_INVITE_REQUEST, :119), and `arenaTeamInvite` is cleared only by
    // the player's own answer, whose click already hid the dialog. A stale Accept finds nothing.
    this.#track(this.#arena, world.arenaTeamInvite, now);
    this.#show(this.#arena, now, "ARENA_TEAM_INVITE_REQUEST", (invite) => [invite.playerName, invite.teamName]);
  }

  #observeTrade(world: FrameXmlPopupsWorld, now: number): void {
    // TRADE_STATUS_BEGIN_TRADE reaches only the invitee (TradeHandler.cpp HandleInitiateTradeOpcode);
    // BeginTrade answered or the window opening ends the request, CancelTrade or a cancel status too.
    const partner = world.tradePending && !world.tradeOpen && !world.tradeBeginRequested
      ? world.tradePartnerGuid ?? 0n : undefined;
    if (partner !== this.#tradeKey) {
      this.#tradeKey = partner;
      this.#track(this.#trade, partner === undefined ? undefined : { partner }, now,
        () => this.#fire("TRADE_REQUEST_CANCEL"));
    }
    this.#show(this.#trade, now, "TRADE_REQUEST", (trade, late) => {
      const name = trade.partner === 0n ? "" : this.#name(world, trade.partner, late);
      return name === undefined ? undefined : [name];
    });
  }

  #observeCamp(world: FrameXmlPopupsWorld, now: number): void {
    const logout = world.logout;
    // An instant logout (resting, flying, GM) completes at once: HandleLogoutRequestOpcode calls
    // LogoutPlayer without a countdown, and the client shows no CAMP dialog for it.
    const counting = logout && logout.result === 0 && !logout.instant && !world.loggedOut ? logout : undefined;
    if (counting !== this.#camp.value && counting) this.#campGrantedAt = now;
    this.#track(this.#camp, counting, now, () => { if (!world.loggedOut) this.#fire("LOGOUT_CANCEL"); });
    if (this.#camp.value === undefined) {
      this.#campQuitShown = false;
      return;
    }
    // `Quit()` asks for the same logout; the client then says so with PLAYER_QUITING — QUIT's
    // «До выхода из игры …» and «Выйти сейчас» (UIParent.lua:572) — not CAMP's character list. A
    // Quit asked while CAMP already counts adds QUIT once, as the client's second event would;
    // LOGOUT_CANCEL hides both.
    const quitting = this.#context.quitting?.() === true;
    if (this.#camp.shown) {
      if (quitting && !this.#campQuitShown) {
        this.#campQuitShown = true;
        this.#fire("PLAYER_QUITING");
      }
      return;
    }
    this.#show(this.#camp, now, quitting ? "PLAYER_QUITING" : "PLAYER_CAMPING", () => []);
    if (this.#camp.shown) this.#campQuitShown = quitting;
  }

  /** `CAMP`/`QUIT`'s seconds left: 20 from the grant (SMSG_LOGOUT_RESPONSE), counted on the local clock. */
  campTimeLeft(): number | undefined {
    if (this.#camp.value === undefined) return undefined;
    return Math.max(0, FRAMEXML_CAMP_SECONDS - (this.#context.monotonic() - this.#campGrantedAt) / 1000);
  }

  #observeReadyCheck(world: FrameXmlPopupsWorld, now: number): void {
    const check = world.readyCheck;
    const previous = this.#readyCheck.value;
    if (check !== previous) {
      const wasShown = this.#readyCheck.shown && previous !== undefined;
      this.#readyAnswers = new Map();
      this.#track(this.#readyCheck, check, now);
      // MSG_RAID_READY_CHECK_FINISHED (or a new check replacing a running one) ends the frame.
      if (wasShown && previous !== this.#readyLocallyFinished) this.#fire("READY_CHECK_FINISHED", check !== undefined);
    }
    if (!check) return;
    const self = world.state?.selfGuid;
    this.#show(this.#readyCheck, now, "READY_CHECK", (running, late) => {
      const name = running.initiatorGuid === self ? world.displayName?.(running.initiatorGuid) ?? ""
        : this.#name(world, running.initiatorGuid, late);
      return name === undefined ? undefined : [name, this.readyCheckTimeLeft()];
    });
    if (!this.#readyCheck.shown) return;
    // MSG_RAID_READY_CHECK_CONFIRM reaches the leader and assistants; each new answer is one edge.
    for (const [guid, ready] of check.answers) {
      if (this.#readyAnswers.get(guid) === ready) continue;
      this.#readyAnswers.set(guid, ready);
      const unit = guid === self ? "player" : this.#context.unitToken?.(guid);
      if (unit) this.#fire("READY_CHECK_CONFIRM", unit, ready);
    }
    const elapsed = (now - check.startedAt) / 1000;
    if (elapsed < FRAMEXML_READY_CHECK_SECONDS) return;
    // The initiator's client ends the check when its 35 s run out: the server only relays
    // MSG_RAID_READY_CHECK_FINISHED from a leader or assistant (GroupHandler.cpp:722-733).
    if (check.initiatorGuid === self && this.#readyFinishSent !== check) {
      this.#readyFinishSent = check;
      this.#command((target) => target.finishReadyCheck());
    }
    // A check whose FINISHED never comes (the initiator left) still ends on screen, once.
    if (elapsed >= FRAMEXML_READY_CHECK_SECONDS + 5 && this.#readyLocallyFinished !== check) {
      this.#readyLocallyFinished = check;
      this.#fire("READY_CHECK_FINISHED", false);
    }
  }

  #observeBattlefield(world: FrameXmlPopupsWorld, now: number): void {
    const queues = world.battlefieldQueues;
    for (const slot of [...this.#battlefieldShown]) {
      const queued = queues?.get(slot);
      if (!queued || queued.cleared || queued.status !== BATTLEFIELD_WAIT_JOIN) this.#battlefieldShown.delete(slot);
    }
    if (!queues || !this.#popupsOwned || this.#muted) return;
    for (const [slot, queued] of queues) {
      if (queued.status !== BATTLEFIELD_WAIT_JOIN || queued.cleared || this.#battlefieldShown.has(slot)) continue;
      if ((world.battlefieldInviteDeadlines?.get(slot) ?? 0) <= now) continue;
      // Once per entry into STATUS_WAIT_JOIN: the server repeats a slot's status, and each repeat
      // would re-show the dialog and replay PVPTHROUGHQUEUE. Leaving the confirm state hides it
      // stock-side (the seam's plain UPDATE_BATTLEFIELD_STATUS, BattlefieldFrame.lua:252-254).
      this.#battlefieldShown.add(slot);
      // BattlefieldFrame_UpdateStatus shows CONFIRM_BATTLEFIELD_ENTRY only for the queue the event
      // names (BattlefieldFrame.lua:289); the seam's own UPDATE_BATTLEFIELD_STATUS carries no index.
      this.#pump?.fire("UPDATE_BATTLEFIELD_STATUS", slot + 1);
    }
  }

  #observeBinder(world: FrameXmlPopupsWorld, now: number): void {
    // No cancel event: CONFIRM_BINDER's own OnUpdate closes it once CheckBinderDist is false — out
    // of reach, answered, or the question dropped with the map (StaticPopup.lua:2519).
    this.#track(this.#binder, world.binderConfirm, now);
    const request = this.#binder.value;
    if (!request || stockAskedOnce.has(request)) return;
    this.#show(this.#binder, now, "CONFIRM_BINDER", (_request, late) => {
      const place = this.#bindPlace(world);
      return place ? [place] : late ? [FRAMEXML_BIND_PLACE_FALLBACK] : undefined;
    });
    if (this.#binder.shown) stockAskedOnce.add(request);
  }

  /**
   * CONFIRM_BINDER's `%s`: the place the core binds, which is where the player stands
   * (Spell::EffectBind, SpellEffects.cpp:5865 — `GetAreaId`): the host's sub-zone under the player,
   * else the zone. Not SMSG_INIT_WORLD_STATES' area: that packet comes on a zone change only, so its
   * area is where the zone was entered. "" while no name is loaded.
   */
  #bindPlace(world: FrameXmlPopupsWorld): string {
    const own = this.#context.playerAreaName?.();
    if (own) return own;
    const zoneId = world.worldStateContext?.zoneId;
    return (zoneId !== undefined && zoneId > 0 ? this.#context.areaName?.(zoneId) : undefined) || "";
  }

  #observeTalentWipe(world: FrameXmlPopupsWorld, now: number): void {
    // CheckTalentMasterDist closes a shown dialog, as CheckBinderDist does.
    this.#track(this.#talentWipe, world.talentWipeConfirm, now);
    const request = this.#talentWipe.value;
    if (!request || this.#talentWipe.shown || !this.#popupsOwned || this.#muted
      || stockAskedOnce.has(request) || frameXmlPopupsLeftToNative(request)) return;
    const talentUi = this.#context.talentUi?.();
    if (talentUi === "ready") {
      this.#show(this.#talentWipe, now, "CONFIRM_TALENT_WIPE", ({ cost }) => [cost]);
      if (this.#talentWipe.shown) stockAskedOnce.add(request);
      return;
    }
    // The first look starts the lazy load; a load that cannot start, fails, or takes longer than
    // the wait leaves the question to the native prompt — for good, never two owners at once.
    if (talentUi === "idle" && this.#context.loadTalentUi && this.#talentUiLoadFor !== request) {
      this.#talentUiLoadFor = request;
      this.#context.loadTalentUi();
    }
    const loading = talentUi === "loading" || (talentUi === "idle" && this.#talentUiLoadFor === request);
    if (!loading || now - this.#talentWipe.seenAt >= FRAMEXML_TALENT_UI_WAIT_MS) markFrameXmlPopupLeftToNative(request);
  }

  #instanceLockPending(world: FrameXmlPopupsWorld, now: number): FrameXmlPopupsWorld["instanceLock"] {
    const lock = world.instanceLock;
    return lock && lock.expiresAt > now ? lock : undefined;
  }

  #observeInstanceLock(world: FrameXmlPopupsWorld, now: number): void {
    // INSTANCE_LOCK_STOP is StaticPopup_Hide (UIParent.lua:876): a question answered, run out or left
    // with the map. The dialog reads everything else through GetInstanceLockTimeRemaining.
    this.#track(this.#instanceLock, this.#instanceLockPending(world, now), now, () => this.#fire("INSTANCE_LOCK_STOP"));
    const lock = this.#instanceLock.value;
    if (!lock || this.#instanceLock.shown || !this.#popupsOwned || this.#muted || frameXmlPopupsLeftToNative(lock)) return;
    // The dialog always prints «Убито боссов: %d/%d». Without the DungeonEncounter table (М2) the
    // total is unknown, so after the same wait a name gets the native prompt keeps the question: it
    // says only the killed count.
    if (this.#encounters(lock)) this.#show(this.#instanceLock, now, "INSTANCE_LOCK_START", () => []);
    else if (now - this.#instanceLock.seenAt >= FRAMEXML_POPUP_NAME_WAIT_MS) markFrameXmlPopupLeftToNative(lock);
  }

  #spiritHealerConfirm(guid: bigint): void {
    this.#healer = guid;
    // UIParent's CONFIRM_XP_LOSS branch picks XP_LOSS or its no-sickness/no-durability variants.
    this.#fire("CONFIRM_XP_LOSS");
  }

  // ---- the C API ---------------------------------------------------------------------------

  #world_(): FrameXmlPopupsWorld | undefined { return this.#context.world(); }

  acceptGroup(): void { this.#command((world) => { if (world.groupInvite) world.answerGroupInvite(true); }); }
  declineGroup(): void { this.#command((world) => { if (world.groupInvite) world.answerGroupInvite(false); }); }

  acceptDuel(): void { this.#command((world) => { if (world.duelRequest) world.answerDuel(true); }); }
  cancelDuel(): void { this.#command((world) => { if (world.duelRequest) world.answerDuel(false); }); }

  resurrectOfferer(): string | undefined {
    const world = this.#world_();
    const request = world?.resurrectRequest;
    return request ? request.casterName || world?.displayName?.(request.casterGuid) : undefined;
  }
  resurrectHasSickness(): boolean { return this.#world_()?.resurrectRequest?.sickness === true; }
  resurrectHasTimer(): boolean { return this.#world_()?.resurrectRequest?.useTimer === true; }
  acceptResurrect(): void { this.#command((world) => { if (world.resurrectRequest) world.answerResurrect(true); }); }
  declineResurrect(): void { this.#command((world) => { if (world.resurrectRequest) world.answerResurrect(false); }); }

  /** Whole seconds before the body may be reclaimed (SMSG_CORPSE_RECLAIM_DELAY, counted down). */
  corpseRecoveryDelay(): number {
    const world = this.#world_();
    const remaining = world?.corpseReclaimRemaining?.(this.#context.monotonic()) ?? 0;
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  /**
   * `GetReleaseTimeRemaining`: 0 while alive or when the server hides the release window, -1 when
   * no timer runs (instances; PLAYER_FIELD_BYTE_RELEASE_TIMER off), else the seconds left of the
   * server's six minutes, counted from the death this model saw.
   */
  releaseTimeRemaining(): number {
    if (this.#context.playerLife() !== "dead") return 0;
    const bytes = this.#context.playerFieldBytes() ?? 0;
    if ((bytes & FRAMEXML_NO_RELEASE_WINDOW_FLAG) !== 0) return 0;
    if ((bytes & FRAMEXML_RELEASE_TIMER_FLAG) === 0) return -1;
    const world = this.#world_();
    if (!world) return 0;
    const diedAt = this.#deathMemory(world).diedAt;
    return Math.max(0, FRAMEXML_RELEASE_SECONDS - (this.#context.monotonic() - diedAt) / 1000);
  }

  /** The world's record of the current death; a body no look has seen yet is stamped now. */
  #deathMemory(world: object): LifeMemory {
    const memory = lifeMemory.get(world);
    if (memory?.life === "dead") return memory;
    const stamped: LifeMemory = { life: "dead", diedAt: this.#context.monotonic(), repopSent: false };
    lifeMemory.set(world, stamped);
    return stamped;
  }

  /** `RepopMe`: once per death, only while the body has not been released. */
  repop(): void {
    this.#command((world) => {
      if (this.#context.playerLife() !== "dead") return;
      const death = this.#deathMemory(world);
      if (death.repopSent) return;
      death.repopSent = true;
      world.releaseSpirit();
    });
  }

  retrieveCorpse(): void {
    this.#command((world) => { if (this.#context.playerLife() === "ghost") world.reclaimCorpse(); });
  }

  /** The self-resurrection spell's name, "" when its name is not cached, undefined without one. */
  selfResurrectName(): string | undefined {
    const spell = this.#context.selfResurrectSpell() ?? 0;
    return spell > 0 ? this.#context.spellName?.(spell) ?? "" : undefined;
  }

  useSelfResurrection(): void {
    this.#command((world) => {
      if (this.#context.playerLife() === "dead" && (this.#context.selfResurrectSpell() ?? 0) > 0) {
        world.useSelfResurrection?.();
      }
    });
  }

  /** Seconds left of the packet's own timeout (SMSG_SUMMON_REQUEST), fractional as stock counts. */
  summonTimeLeft(): number {
    const world = this.#world_();
    if (!world) return 0;
    const now = this.#context.monotonic();
    return this.#summonPending(world, now) ? Math.max(0, ((world.summonExpiresAt ?? 0) - now) / 1000) : 0;
  }
  summonAreaName(): string {
    const request = this.#world_()?.summonRequest;
    return request ? this.#context.areaName?.(request.zoneId) ?? "" : "";
  }
  summonSummoner(): string {
    const world = this.#world_();
    const request = world?.summonRequest;
    return request ? world?.displayName?.(request.summoner) ?? "" : "";
  }
  /** MovementHandler ignores a summon reply while dead or in combat; stock disables Accept then. */
  canTeleport(): boolean {
    return this.#world_()?.summonBlockReason?.() === undefined;
  }
  confirmSummon(): void { this.#command((world) => { if (world.summonRequest) world.answerSummon(true); }); }
  cancelSummon(): void { this.#command((world) => { if (world.summonRequest) world.answerSummon(false); }); }

  acceptGuild(): void { this.#command((world) => { if (world.guildInvite) world.answerGuildInvite(true); }); }
  declineGuild(): void { this.#command((world) => { if (world.guildInvite) world.answerGuildInvite(false); }); }
  acceptArenaTeam(): void { this.#command((world) => { if (world.arenaTeamInvite) world.answerArenaTeamInvite(true); }); }
  declineArenaTeam(): void { this.#command((world) => { if (world.arenaTeamInvite) world.answerArenaTeamInvite(false); }); }

  beginTrade(): void {
    this.#command((world) => { if (world.tradePending && !world.tradeBeginRequested) world.beginTrade(); });
  }
  cancelTrade(): void {
    this.#command((world) => { if (world.tradePending || world.tradeOpen) world.cancelTrade(); });
  }

  /** `ForceQuit` (QUIT's «Выйти сейчас»): the host leaves only for a Quit it is counting. */
  forceQuit(): void {
    this.#command(() => { if (this.#context.quitting?.() === true) this.#context.forceQuit?.(); });
  }

  // ---- destroying an item ------------------------------------------------------------------

  /**
   * DELETE_ITEM_CONFIRM(name, quality) for the item on the stock cursor — what the client fires
   * when an item is dropped outside every frame; UIParent then asks DELETE_ITEM, or from rare
   * quality up DELETE_GOOD_ITEM with its typed confirmation (UIParent.lua:609-613). False when the
   * stock dialogs do not own the prompts or the cursor is empty: the caller keeps its own route.
   */
  confirmDeleteCursorItem(): boolean {
    if (!this.#popupsOwned || this.#muted || !this.#pump) return false;
    const item = this.#context.cursorItem?.();
    if (!item) return false;
    this.#pump.fire("DELETE_ITEM_CONFIRM", item.name, item.quality);
    return true;
  }

  /** The native «Разрушить»: the item goes onto the stock cursor, as a drag would, and stock asks. */
  destroyItem(bag: number, slot: number): boolean {
    if (!this.#popupsOwned || this.#muted || !this.#pump || !this.#context.pickupItem?.(bag, slot)) return false;
    return this.confirmDeleteCursorItem();
  }

  /** `DeleteCursorItem`: CMSG_DESTROYITEM for the cursor's item, once — the cursor is emptied. */
  deleteCursorItem(): void {
    this.#command((world) => {
      const item = this.#context.cursorItem?.();
      if (!item || typeof world.destroyItem !== "function") return;
      world.destroyItem(item.bag, item.slot);
      this.#context.clearCursor?.();
    });
  }

  // ---- ready check -------------------------------------------------------------------------

  readyCheckTimeLeft(): number {
    const check = this.#world_()?.readyCheck;
    if (!check) return 0;
    return Math.max(0, Math.ceil(FRAMEXML_READY_CHECK_SECONDS - (this.#context.monotonic() - check.startedAt) / 1000));
  }

  /** "initiator", "answered" (by either surface), "responder", or undefined without a check. */
  readyCheckRole(): "initiator" | "answered" | "responder" | undefined {
    const world = this.#world_();
    const check = world?.readyCheck;
    if (!check) return undefined;
    const self = world?.state?.selfGuid;
    if (check.initiatorGuid === self) return "initiator";
    if (frameXmlPopupAnswer(check) !== undefined || (self !== undefined && check.answers.has(self))) return "answered";
    return "responder";
  }

  /** The unit token of the initiator, for ReadyCheckPortrait; stock hands SetPortraitTexture a name. */
  readyCheckInitiatorUnit(): string | undefined {
    const world = this.#world_();
    const check = world?.readyCheck;
    if (!check) return undefined;
    return check.initiatorGuid === world?.state?.selfGuid ? "player" : this.#context.unitToken?.(check.initiatorGuid);
  }

  /**
   * `GetReadyCheckStatus(unit)`: "ready", "notready", "waiting" or nil. The initiator counts as
   * ready. Answers reach only the leader and assistants (`Group::BroadcastReadyCheck`), so for a
   * plain member other units answer nil rather than a "waiting" that would turn into an AFK mark.
   */
  readyCheckStatus(unit: string): "ready" | "notready" | "waiting" | undefined {
    const world = this.#world_();
    const check = world?.readyCheck;
    const guid = this.#context.unitGuid(unit);
    if (!world || !check || guid === undefined) return undefined;
    if (guid === check.initiatorGuid) return "ready";
    const self = world.state?.selfGuid;
    const answer = check.answers.get(guid) ?? (guid === self ? frameXmlPopupAnswer(check) : undefined);
    if (typeof answer === "boolean") return answer ? "ready" : "notready";
    const group = world.group;
    const collects = self !== undefined && (group?.leaderGuid === self || ((group?.ownFlags ?? 0) & MEMBER_FLAG_ASSISTANT) !== 0);
    return guid === self || collects ? "waiting" : undefined;
  }

  /** `ConfirmReadyCheck(isReady)`: one answer per check, whichever surface gives it. */
  confirmReadyCheck(ready: boolean): void {
    this.#command((world) => {
      const check = world.readyCheck;
      const self = world.state?.selfGuid;
      if (!check || check.initiatorGuid === self || frameXmlPopupAnswer(check) !== undefined) return;
      markFrameXmlPopupAnswered(check, ready);
      world.answerReadyCheck(ready);
      // A plain member never hears its own answer back (only the leader and assistants do), yet
      // PlayerFrame shows it at once: repaint it from the answer just given, once.
      if (self !== undefined) this.#readyAnswers.set(self, ready);
      this.#fire("READY_CHECK_CONFIRM", "player", ready);
    });
  }

  // ---- battlefield entry --------------------------------------------------------------------

  /** Whole seconds until the queue slot's invitation lapses (SMSG_BATTLEFIELD_STATUS remove time). */
  battlefieldPortExpiration(index: number): number {
    const world = this.#world_();
    const deadline = world?.battlefieldInviteDeadlines?.get(index - 1);
    if (deadline === undefined) return 0;
    return Math.max(0, Math.ceil((deadline - this.#context.monotonic()) / 1000));
  }

  /** `AcceptBattlefieldPort(index, accept)`: answers whether a CMSG_BATTLEFIELD_PORT went out. */
  acceptBattlefieldPort(index: number, accept: boolean): boolean {
    let sent = false;
    this.#command((world) => {
      const queued = world.battlefieldQueues?.get(index - 1);
      if (!queued || queued.cleared) return;
      if (accept && (queued.status !== BATTLEFIELD_WAIT_JOIN || this.battlefieldPortExpiration(index) <= 0)) return;
      if (!accept && queued.status !== BATTLEFIELD_WAIT_JOIN && queued.status !== BATTLEFIELD_WAIT_QUEUE) return;
      world.portToBattleground(index - 1, accept);
      sent = true;
    });
    return sent;
  }

  /** `IsActiveBattlefieldArena`: in a running arena match, and whether it is rated. */
  activeArena(): readonly [boolean, boolean] {
    for (const queued of this.#world_()?.battlefieldQueues?.values() ?? []) {
      if (queued.status === BATTLEFIELD_IN_PROGRESS && queued.isArena && !queued.cleared) return [true, queued.rated];
    }
    return [false, false];
  }

  // ---- the spirit healer --------------------------------------------------------------------

  /** Seconds of resurrection sickness a spirit healer would give (Player::ResurrectPlayer, 4745-4759). */
  resSicknessSeconds(): number | undefined {
    const level = this.#context.playerLevel();
    if (level < 11) return undefined;
    return level < 20 ? (level - 10) * 60 : 600;
  }

  spiritHealerInRange(): boolean {
    const healer = this.#healer;
    return healer === undefined ? false : this.#context.spiritHealerInRange?.(healer) ?? true;
  }

  acceptXpLoss(): void {
    this.#command((world) => {
      const healer = this.#healer;
      if (healer === undefined || this.#context.playerLife() !== "ghost") return;
      this.#healer = undefined;
      world.activateSpiritHealer(healer);
    });
  }

  // ---- the innkeeper, the talent trainer (М1) ------------------------------------------------

  /** The NPC that asked is still within reach; false with nothing asked. Unknown range keeps it up. */
  #npcInRange(guid: bigint | undefined): boolean {
    return guid === undefined ? false : this.#context.npcInRange?.(guid) ?? true;
  }

  /** `CheckBinderDist`: false hides CONFIRM_BINDER (its OnUpdate). */
  binderInRange(): boolean { return this.#npcInRange(this.#world_()?.binderConfirm?.guid); }

  /** `ConfirmBinder`: CMSG_BINDER_ACTIVATE once; stock's Cancel calls nothing. */
  confirmBinder(): void { this.#command((world) => { if (world.binderConfirm) world.confirmBinder?.(); }); }

  /** `GetBindLocation`: the hearthstone's area (SMSG_BIND_POINT_UPDATE), undefined until reported or named. */
  bindLocation(): string | undefined {
    const point = this.#world_()?.bindPoint;
    return point ? this.#context.areaName?.(point.areaId) : undefined;
  }

  /** `CheckTalentMasterDist`: false hides CONFIRM_TALENT_WIPE (its OnUpdate). */
  talentMasterInRange(): boolean { return this.#npcInRange(this.#world_()?.talentWipeConfirm?.guid); }

  /**
   * `ConfirmTalentWipe`: MSG_TALENT_WIPE_CONFIRM once. Short of money it is not sent — the core
   * would ignore it without a word — and UIErrorsFrame says ERR_NOT_ENOUGH_MONEY instead.
   */
  confirmTalentWipe(): void {
    this.#command((world) => {
      if (!world.talentWipeConfirm || world.answerTalentWipe?.(true) !== "unaffordable") return;
      this.#fire("UI_ERROR_MESSAGE", globalString("ERR_NOT_ENOUGH_MONEY") ?? "У вас недостаточно денег.");
    });
  }

  // ---- the instance lock (М1) ------------------------------------------------------------------

  #encounters(lock: NonNullable<FrameXmlPopupsWorld["instanceLock"]>): readonly FrameXmlDungeonEncounter[] | undefined {
    return this.#context.dungeonEncounters?.(lock.mapId, lock.difficulty);
  }

  /**
   * `GetInstanceLockTimeRemaining`: whole seconds left of the server's minute (Wow.exe 0x00516340
   * divides the milliseconds left by 1000 as integers; the dialog's own lockTimeleft counts on from
   * it — a remount resumes, it does not restart), isPreviousInstance,
   * the bosses and those killed. Without the DungeonEncounter table nothing about the bosses is
   * invented: `0, 0`, what the client answers for a map without encounter rows (and the stock dialog
   * is not asked then). With no question the client still counts the current map's bosses against
   * an empty mask (0x00516340 always calls 0x00553830 with 0xbd088c/0xbd0894): `0, false, N, 0`.
   */
  instanceLockTimeRemaining(): readonly [number, boolean, number, number] {
    const world = this.#world_();
    const now = this.#context.monotonic();
    const lock = world ? this.#instanceLockPending(world, now) : undefined;
    if (!lock) {
      const current = world?.mapId === undefined ? undefined
        : this.#context.dungeonEncounters?.(world.mapId, world.instanceDifficulty ?? 0);
      return [0, false, current?.length ?? 0, 0];
    }
    const encounters = this.#encounters(lock) ?? [];
    const complete = encounters.filter(({ bit }) => killedBit(lock.encounterMask, bit)).length;
    return [Math.max(0, Math.floor((lock.expiresAt - now) / 1000)), lock.previouslySaved, encounters.length, complete];
  }

  /**
   * `GetInstanceLockTimeRemainingEncounter(i)`: `bossName, texture, isKilled` (LFRFrame.lua:684) of
   * the i-th row of the lock's map and difficulty in file order (Wow.exe 0x005538b0). The texture is
   * the row's SpellIcon, nil for SpellIconID 0 — every row of this dataset; the route carries none.
   */
  instanceLockEncounter(index: number): readonly [string, undefined, boolean] | undefined {
    const world = this.#world_();
    const lock = world ? this.#instanceLockPending(world, this.#context.monotonic()) : undefined;
    if (!lock || !Number.isInteger(index) || index < 1) return undefined;
    const encounter = this.#encounters(lock)?.[index - 1];
    return encounter ? [encounter.name, undefined, killedBit(lock.encounterMask, encounter.bit)] : undefined;
  }

  /** `RespondInstanceLock(accept)`: CMSG_INSTANCE_LOCK_RESPONSE once, never past the deadline. */
  respondInstanceLock(accept: boolean): void {
    this.#command((world) => {
      if (this.#instanceLockPending(world, this.#context.monotonic())) world.respondInstanceLock?.(accept);
    });
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlPopupsHost {
  readonly popups?: FrameXmlPopupsModel | undefined;
}

export type FrameXmlPopupsBinding = (host: FrameXmlPopupsHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

const withPopups = (answer: (popups: FrameXmlPopupsModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlPopupsBinding =>
  (host, args) => host.popups ? answer(host.popups, args) : NOTHING;

const command = (run: (popups: FrameXmlPopupsModel, args: readonly unknown[]) => void): FrameXmlPopupsBinding =>
  withPopups((popups, args) => { run(popups, args); return NOTHING; });

/**
 * The flat C API StaticPopup.lua, UIParent.lua, ReadyCheck.xml, BattlefieldFrame.lua and the unit
 * frames call. `WebClient*` are the flat accessors the Lua prelude and the owner's adapters read.
 * `CancelLogout` is not here: the world mount registers it (and Logout/Quit) after load; QUIT's
 * OnHide asks the same CancelLogout. `ForceQuit` and `DeleteCursorItem` are QUIT's and DELETE_ITEM's
 * accept buttons, inert unless stock owns the prompts.
 */
export const FRAMEXML_POPUPS_BINDINGS: Readonly<Record<string, FrameXmlPopupsBinding>> = Object.freeze({
  AcceptGroup: command((popups) => popups.acceptGroup()),
  DeclineGroup: command((popups) => popups.declineGroup()),
  AcceptDuel: command((popups) => popups.acceptDuel()),
  CancelDuel: command((popups) => popups.cancelDuel()),
  AcceptResurrect: command((popups) => popups.acceptResurrect()),
  DeclineResurrect: command((popups) => popups.declineResurrect()),
  ResurrectGetOfferer: withPopups((popups) => optional(popups.resurrectOfferer())),
  ResurrectHasSickness: withPopups((popups) => [popups.resurrectHasSickness()]),
  ResurrectHasTimer: withPopups((popups) => [popups.resurrectHasTimer()]),
  GetCorpseRecoveryDelay: withPopups((popups) => [popups.corpseRecoveryDelay()]),
  GetReleaseTimeRemaining: withPopups((popups) => [popups.releaseTimeRemaining()]),
  RepopMe: command((popups) => popups.repop()),
  RetrieveCorpse: command((popups) => popups.retrieveCorpse()),
  UseSoulstone: command((popups) => popups.useSelfResurrection()),
  // SPELL_AURA_PREVENT_RESURRECTION is not modelled: the release dialog then closes on accept, as
  // it does for every character without that aura.
  CannotBeResurrected: () => [false],
  ConfirmSummon: command((popups) => popups.confirmSummon()),
  CancelSummon: command((popups) => popups.cancelSummon()),
  GetSummonConfirmTimeLeft: withPopups((popups) => [popups.summonTimeLeft()]),
  GetSummonConfirmAreaName: withPopups((popups) => [popups.summonAreaName()]),
  GetSummonConfirmSummoner: withPopups((popups) => [popups.summonSummoner()]),
  PlayerCanTeleport: withPopups((popups) => [popups.canTeleport()]),
  AcceptGuild: command((popups) => popups.acceptGuild()),
  DeclineGuild: command((popups) => popups.declineGuild()),
  AcceptArenaTeam: command((popups) => popups.acceptArenaTeam()),
  DeclineArenaTeam: command((popups) => popups.declineArenaTeam()),
  BeginTrade: command((popups) => popups.beginTrade()),
  CancelTrade: command((popups) => popups.cancelTrade()),
  ForceQuit: command((popups) => popups.forceQuit()),
  DeleteCursorItem: command((popups) => popups.deleteCursorItem()),
  ConfirmReadyCheck: command((popups, args) => popups.confirmReadyCheck(truthy(args[0]))),
  GetReadyCheckStatus: withPopups((popups, args) =>
    optional(typeof args[0] === "string" ? popups.readyCheckStatus(args[0]) : undefined)),
  GetReadyCheckTimeLeft: withPopups((popups) => [popups.readyCheckTimeLeft()]),
  GetBattlefieldPortExpiration: withPopups((popups, args) => [popups.battlefieldPortExpiration(integerArg(args[0]) ?? 0)]),
  AcceptBattlefieldPort: withPopups((popups, args) =>
    [popups.acceptBattlefieldPort(integerArg(args[0]) ?? 0, truthy(args[1]))]),
  IsActiveBattlefieldArena: withPopups((popups) => popups.activeArena()),
  CheckSpiritHealerDist: withPopups((popups) => [popups.spiritHealerInRange()]),
  AcceptXPLoss: command((popups) => popups.acceptXpLoss()),
  ConfirmBinder: command((popups) => popups.confirmBinder()),
  CheckBinderDist: withPopups((popups) => [popups.binderInRange()]),
  GetBindLocation: withPopups((popups) => optional(popups.bindLocation())),
  ConfirmTalentWipe: command((popups) => popups.confirmTalentWipe()),
  CheckTalentMasterDist: withPopups((popups) => [popups.talentMasterInRange()]),
  GetInstanceLockTimeRemaining: withPopups((popups) => popups.instanceLockTimeRemaining()),
  GetInstanceLockTimeRemainingEncounter: withPopups((popups, args) =>
    popups.instanceLockEncounter(integerArg(args[0]) ?? 0) ?? NOTHING),
  RespondInstanceLock: command((popups, args) => popups.respondInstanceLock(truthy(args[0]))),
  WebClientSelfResurrectName: withPopups((popups) => optional(popups.selfResurrectName())),
  WebClientResSicknessSeconds: withPopups((popups) => optional(popups.resSicknessSeconds())),
  WebClientCampTimeLeft: withPopups((popups) => optional(popups.campTimeLeft())),
  WebClientReadyCheckRole: withPopups((popups) => optional(popups.readyCheckRole())),
  WebClientReadyCheckUnit: withPopups((popups) => optional(popups.readyCheckInitiatorUnit())),
});

/**
 * The Lua half, appended to FRAMEXML_SEAM_PRELUDE: the two answers stock formats from strings the
 * host does not own. `HasSoulstone` names the self-resurrection spell, falling back to the stock
 * USE_SOULSTONE label while its name is not cached; `GetResSicknessDuration` is the client's
 * formatted duration, which SecondsToTime (UIParent.lua) produces from the server's minutes.
 */
export const FRAMEXML_POPUPS_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local selfRes = rawget(_G, "__fxSeam_WebClientSelfResurrectName")
  local sickness = rawget(_G, "__fxSeam_WebClientResSicknessSeconds")
  if impl ~= nil and selfRes ~= nil and sickness ~= nil then
    impl.HasSoulstone = function()
      local name = selfRes()
      if name == nil then return nil end
      if name == "" then return USE_SOULSTONE end
      return name
    end
    impl.GetResSicknessDuration = function()
      local seconds = sickness()
      if seconds == nil then return nil end
      if type(SecondsToTime) == "function" then return SecondsToTime(seconds) end
      return tostring(seconds)
    end
  end
end
`;

/** Every stock event this model fires; the owner's gate checks UIParent registered the ones it shows. */
export const FRAMEXML_POPUPS_EVENTS: readonly string[] = Object.freeze([
  "PARTY_INVITE_REQUEST", "PARTY_INVITE_CANCEL", "DUEL_REQUESTED", "DUEL_OUTOFBOUNDS", "DUEL_INBOUNDS",
  "DUEL_FINISHED", "RESURRECT_REQUEST", "PLAYER_DEAD", "PLAYER_ALIVE", "PLAYER_UNGHOST", "CORPSE_IN_RANGE",
  "CORPSE_IN_INSTANCE", "CORPSE_OUT_OF_RANGE", "CONFIRM_SUMMON", "CANCEL_SUMMON", "GUILD_INVITE_REQUEST",
  "GUILD_INVITE_CANCEL", "ARENA_TEAM_INVITE_REQUEST", "TRADE_REQUEST", "TRADE_REQUEST_CANCEL",
  "PLAYER_CAMPING", "PLAYER_QUITING", "LOGOUT_CANCEL", "CONFIRM_XP_LOSS", "DELETE_ITEM_CONFIRM",
  "CONFIRM_BINDER", "CONFIRM_TALENT_WIPE", "INSTANCE_LOCK_START", "INSTANCE_LOCK_STOP",
]);
