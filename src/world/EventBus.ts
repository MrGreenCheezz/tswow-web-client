/** Drops a subscription. Returned by every `on`, so a panel can be closed without leaking it. */
export type Unsubscribe = () => void;

/** Why an ordinary cast ended; channels retain their separate update/stop semantics. */
export type SpellCastStopReason = "success" | "interrupted" | "failed";

/** Which dungeon-finder packet (or local answer) moved `WorldClient`'s `lfg*` state. */
export type LfgStateChangeKind =
  | "joinResult" | "queue" | "update" | "proposal" | "roleChosen" | "roleCheck" | "boot"
  | "playerInfo" | "partyInfo" | "reward" | "offerContinue" | "teleportDenied" | "search"
  | "disabled" | "voteKickReasonNeeded";

export interface LfgStateChange {
  readonly kind: LfgStateChangeKind;
  /** `joinResult`: the `LfgJoinResult` code (0 is success). */
  readonly result?: number;
  /** `roleChosen`: who picked, and the `LFG_ROLE_*` mask they picked. */
  readonly guid?: bigint;
  readonly roles?: number;
  /** `joinResult`/`teleportDenied`: the text the native window shows for it. */
  readonly message?: string;
  /** `offerContinue`: the wire entry, `id + (type << 24)`; `lfgOfferContinue` keeps only the id. */
  readonly entry?: number;
  /** `voteKickReasonNeeded`: the name SMSG_PARTY_COMMAND_RESULT carried — whom the vote is about. */
  readonly name?: string;
}

/**
 * Which mailbox edge moved `WorldClient`'s `mail*` state: the window's mailbox was set (`open`) or
 * cleared (`closed`), a `SMSG_MAIL_LIST_RESULT` landed (`list`), a `SMSG_SEND_MAIL_RESULT` landed
 * (`result`, read `mailResult` after it), or `SMSG_RECEIVED_MAIL` announced a letter (`received`).
 */
export interface MailStateChange {
  readonly kind: "open" | "list" | "result" | "received" | "closed";
}

/**
 * Which trade edge moved `WorldClient`'s `trade*` state: one `SMSG_TRADE_STATUS` (`status`, with its
 * `TradeStatus` word), one `SMSG_TRADE_STATUS_EXTENDED` (`offer`, `trader` for the partner's side),
 * or a local offer change this client sent and the core never echoes back to it (`local`).
 */
export interface TradeStateChange {
  readonly kind: "status" | "offer" | "local";
  readonly status?: number;
  readonly trader?: boolean;
}

/**
 * Which auction-house edge moved `WorldClient`'s `auction*` state: MSG_AUCTION_HELLO answered
 * (`hello`, `enabled` false for a disabled house), a browse, owner or bidder list landed (`list`,
 * `owner`, `bidder`), one SMSG_AUCTION_COMMAND_RESULT (`result`: `auctionId`, `command`, `error`,
 * `bagResult`), SMSG_AUCTION_BIDDER_NOTIFICATION (`bidderNotification`: `won` when the new high
 * bidder is the player), SMSG_AUCTION_OWNER_NOTIFICATION (`ownerNotification`: `bid` 0 is an
 * expiry), or the auctioneer was let go (`closed`).
 */
export interface AuctionStateChange {
  readonly kind: "hello" | "list" | "owner" | "bidder" | "result" | "bidderNotification" | "ownerNotification" | "closed";
  readonly enabled?: boolean;
  /** `hello`: the AuctionHouse.dbc id, whose DepositRate prices a lot. */
  readonly houseId?: number;
  /** `hello`: the world sent its own opening CMSG_AUCTION_LIST_ITEMS (the native window's). */
  readonly searched?: boolean;
  /** `result`: the lists the world re-requested after a success, in the order it sent them. */
  readonly refreshed?: readonly ("list" | "owner" | "bidder")[];
  readonly auctionId?: number;
  readonly command?: number;
  readonly error?: number;
  readonly bagResult?: number;
  readonly itemId?: number;
  readonly won?: boolean;
  readonly bid?: number;
}

import type { SpellGo } from "./SpellProtocol.js";
import type { UnitCombatEvent } from "./UnitCombat.js";
import type { ActiveAura } from "./AuraProtocol.js";
import type { ChatMessage, TextEmote } from "./ChatProtocol.js";
import type { GuildBankContent } from "./GuildBankProtocol.js";

/**
 * What moved `WorldClient`'s `guildBank*` state, for the stock GuildBankFrame (FrameXmlGuildBank.ts):
 * one SMSG_GUILD_BANK_LIST as it arrived (`list` — a partial list names only the slots that moved,
 * and the world folds it into the one tab it holds), a tab's MSG_QUERY_GUILD_BANK_TEXT (`textTab`),
 * or one of the bank's SMSG_GUILD_EVENTs (`guildEvent`, GuildEvents 14-19). The log, permissions
 * and withdraw-allowance packets emit it empty.
 */
export interface GuildBankChange {
  readonly list?: GuildBankContent;
  readonly textTab?: number;
  readonly guildEvent?: { readonly type: number; readonly params: readonly string[] };
}

import type {
  CalendarCommandResult, CalendarEventDetail, CalendarEventRemovedAlert, CalendarEventStatus,
  CalendarEventStatusAlert, CalendarEventUpdatedAlert, CalendarInitialInvite, CalendarInviteAdded,
  CalendarInviteAlert, CalendarInviteRemoved, CalendarModeratorStatus, CalendarSnapshot, RaidLockoutChange,
} from "./CalendarProtocol.js";

/**
 * One calendar packet as it arrived, beside the native window's CALENDAR_CHANGED (which drops the
 * alert bodies). The stock Blizzard_Calendar model (FrameXmlCalendarLive.ts) folds these in the
 * client's own way — an alert updates the one row it names instead of asking for a new snapshot.
 */
export type CalendarPacket =
  | { readonly kind: "snapshot"; readonly snapshot: CalendarSnapshot }
  | { readonly kind: "event"; readonly detail: CalendarEventDetail }
  | { readonly kind: "pending"; readonly count: number }
  | { readonly kind: "result"; readonly result: CalendarCommandResult }
  | { readonly kind: "candidates"; readonly source: "guild" | "arena"; readonly invites: readonly CalendarInitialInvite[] }
  | { readonly kind: "inviteAdded"; readonly invite: CalendarInviteAdded }
  | { readonly kind: "inviteAlert"; readonly alert: CalendarInviteAlert }
  | { readonly kind: "inviteRemoved"; readonly removed: CalendarInviteRemoved }
  | { readonly kind: "inviteRemovedAlert"; readonly alert: CalendarEventStatusAlert }
  | { readonly kind: "status"; readonly status: CalendarEventStatus }
  | { readonly kind: "moderator"; readonly status: CalendarModeratorStatus }
  | { readonly kind: "updatedAlert"; readonly alert: CalendarEventUpdatedAlert }
  | { readonly kind: "removedAlert"; readonly alert: CalendarEventRemovedAlert }
  | { readonly kind: "clearPending" }
  | { readonly kind: "lockout"; readonly change: RaidLockoutChange; readonly removed: boolean };

type AnyListener = (payload: unknown) => void;

/**
 * A typed publish/subscribe channel.
 *
 * The interface this client needs is many small panels that each care about one thing, and the
 * shape it grew instead is one `onX` callback per feature on `WorldClient` — 34 of them, each with
 * room for exactly one owner. The second panel that wants the same event has to find the first and
 * chain onto it by hand, which is why every panel is currently redrawn by one function whenever
 * anything at all changes.
 *
 * The event map is constrained to `object` rather than to a record of strings: an interface has no
 * implicit index signature, so a record constraint rejects every event map declared as one.
 */
export class EventBus<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<AnyListener>>();

  /**
   * Reported rather than thrown: a listener that fails is a broken panel, and the panels after it
   * in the set are not broken. The world loop already isolates errors per packet for the same
   * reason — one bad payload used to kill a session.
   */
  onListenerError: ((name: keyof Events, error: unknown) => void) | undefined;

  on<Name extends keyof Events>(name: Name, listener: (payload: Events[Name]) => void): Unsubscribe {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    const stored = listener as unknown as AnyListener;
    listeners.add(stored);
    return () => {
      const current = this.#listeners.get(name);
      current?.delete(stored);
      if (current?.size === 0) this.#listeners.delete(name);
    };
  }

  once<Name extends keyof Events>(name: Name, listener: (payload: Events[Name]) => void): Unsubscribe {
    const unsubscribe = this.on(name, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  emit<Name extends keyof Events>(name: Name, payload: Events[Name]): void {
    const listeners = this.#listeners.get(name);
    if (!listeners) return;
    // Copied first: a listener is allowed to unsubscribe itself, or to open a panel that
    // subscribes, and neither may disturb the walk that is delivering this event.
    for (const listener of [...listeners]) {
      try {
        listener(payload as unknown);
      } catch (error) {
        this.onListenerError?.(name, error);
      }
    }
  }

  listenerCount(name: keyof Events): number {
    return this.#listeners.get(name)?.size ?? 0;
  }

  clear(): void {
    this.#listeners.clear();
  }
}

/**
 * What the world reports as it changes. The names are the ones the original client uses, not for
 * compatibility with FrameXML — this client has its own interface — but because they already name
 * these events well, and because a future decision to run addons would otherwise have to rename
 * every subscription in the tree.
 *
 * The state events carry only a guid: the object is already in the store, and passing a snapshot
 * would let a listener read a value that has since moved on.
 */
export interface WorldEvents {
  OBJECT_CREATED: { guid: bigint; typeId: number | undefined };
  OBJECT_DESTROYED: { guid: bigint };
  /** Position or spline changed. Fires at most once per flush, not once per waypoint. */
  OBJECT_MOVED: { guid: bigint };
  /** The controlled character became known, or was lost on leaving the world. */
  PLAYER_ENTERING_WORLD: { guid: bigint | undefined };
  UNIT_HEALTH: { guid: bigint };
  UNIT_MAX_HEALTH: { guid: bigint };
  UNIT_POWER: { guid: bigint };
  UNIT_MAX_POWER: { guid: bigint };
  UNIT_DISPLAY_POWER: { guid: bigint };
  UNIT_LEVEL: { guid: bigint };
  UNIT_TARGET: { guid: bigint };
  UNIT_DISPLAY_ID: { guid: bigint };
  UNIT_FLAGS: { guid: bigint };
  UNIT_DYNAMIC_FLAGS: { guid: bigint };
  UNIT_NPC_FLAGS: { guid: bigint };
  UNIT_FACTION: { guid: bigint };
  PLAYER_XP: { guid: bigint };
  PLAYER_MONEY: { guid: bigint };
  PLAYER_QUEST_LOG_UPDATE: { guid: bigint };
  PLAYER_EXPLORED_ZONES: { guid: bigint };
  PLAYER_TRACK_CREATURES: { guid: bigint };
  PLAYER_TRACK_RESOURCES: { guid: bigint };
  GAMEOBJECT_STATE: { guid: bigint };
}

/**
 * What the world client reports as packets land — the things that happen rather than the things
 * that are. A cast starting is an event; the health it leaves behind is state, and state is
 * `WorldEvents` above.
 *
 * This is where the 34 `onX` callbacks on `WorldClient` are heading: a panel subscribes to what it
 * cares about instead of claiming the single slot for it.
 */
export interface WorldPacketEvents {
  SOCKET_GEMS_RESULT: { itemGuid: bigint; enchantments: number[] };
  INVENTORY_CHANGE_FAILURE: import("./ItemProtocol.js").EquipFailure;
  /** 2.10: SMSG_ITEM_REFUND_RESULT codes 10/11 — the GlobalStrings key UIErrorsFrame shows. */
  ITEM_REFUND_ERROR: { error: string };
  /** A ranged auto-repeat (Auto Shot or wand Shoot) stopped for this unit. */
  STOP_AUTOREPEAT_SPELL: { guid: bigint };
  /** A non-addon line entered the chat log; the same object reaches the legacy callback. */
  CHAT_MESSAGE: ChatMessage;
  /** `SMSG_TEXT_EMOTE`: the source and text-emote tuple, before any client-side sentence lookup. */
  TEXT_EMOTE: TextEmote;
  /** A unit began a cast or a channel. `castTime` is what is left to run, in milliseconds. */
  SPELL_CAST_START: { casterGuid: bigint; spellId: number; castTime: number; channel: boolean };
  /** The cast ended, with the packet-level reason preserved for castbar consumers. */
  SPELL_CAST_STOP: {
    casterGuid: bigint;
    spellId: number;
    interrupted: boolean;
    reason: SpellCastStopReason;
  };
  /** The server accepted this player's request; START wins for a cast-time spell, GO for instant. */
  SPELL_CAST_ACCEPTED: {
    spellId: number;
    castId: number;
    startedAt: number;
    source: "start" | "go";
  };
  /**
   * 3.02: this client sent a cast request (`CMSG_CAST_SPELL`) — Wow.exe 0x0080ac90 raises
   * UNIT_SPELLCAST_SENT right after building it. `targetGuid` is the request's named unit or object.
   */
  SPELL_CAST_SENT: { spellId: number; castCount: number; targetGuid?: bigint };
  /**
   * 3.02: a cast's outcome as Wow.exe 0x007fecc0 takes it — 187 (the client's own "success",
   * SPELL_FAILED_UNKNOWN in SharedDefines.h) from an SMSG_SPELL_GO without CAST_FLAG_PENDING, or the
   * SpellCastResult of SMSG_CAST_FAILED (the player), SMSG_SPELL_FAILURE and SMSG_SPELL_FAILED_OTHER
   * (each). Emitted before the SPELL_CAST_STOP the same packet causes.
   * 3.01-castlog: `refusal` marks SMSG_CAST_FAILED's — the only one Wow.exe logs as SPELL_CAST_FAILED
   * (0x00809af0 → 0x00808200 → 0x00751ad0; the interrupt pair's handlers 0x00809c70/0x00806ad0 log nothing).
   */
  SPELL_CAST_RESULT: { casterGuid: bigint; spellId: number; castCount: number; result: number; refusal?: true };
  /** 3.01: combat facts UNIT_COMBAT does not carry (world/CombatFacts.ts). */
  COMBAT_FACT: import("./CombatFacts.js").CombatFact;
  /** Pushback: damage taken while casting adds to what is left. */
  SPELL_CAST_DELAYED: { casterGuid: bigint; delay: number };
  /** A complete SMSG_SPELL_GO, including hit/miss lists and an optional target destination. */
  SPELL_GO: SpellGo;
  /**
   * 3.01-castlog: every SMSG_SPELL_START as parsed — instants, channels and triggered casts included —
   * emitted after the cast bar's SPELL_CAST_START, as Wow.exe 0x00806700 updates the bar (0x00805330)
   * before it logs (0x00751920).
   */
  SPELL_START: import("./SpellProtocol.js").SpellStart;
  /** Remaining channel time changed, including the zero update that precedes SPELL_CAST_STOP. */
  SPELL_CHANNEL_UPDATE: { casterGuid: bigint; spellId: number; remaining: number };
  /**
   * A player spell cooldown was actually armed. `startedAt` and `duration` describe one stable
   * snapshot, so a panel can draw a fraction without reconstructing the start from a later frame.
   * This is emitted only after a successful cast or an authoritative cooldown packet/event.
   */
  SPELL_COOLDOWN_STARTED: {
    spellId: number;
    startedAt: number;
    duration: number;
    source: "cast" | "server";
  };
  /** Aura maps before/after the packet, with refreshes separated from true removals. */
  AURA_CHANGED: {
    guid: bigint;
    previous: ReadonlyMap<number, ActiveAura>;
    current: ReadonlyMap<number, ActiveAura>;
    added: readonly ActiveAura[];
    removed: readonly ActiveAura[];
    updated: readonly { before: ActiveAura; after: ActiveAura }[];
    /** SMSG_AURA_UPDATE_ALL rather than one slot's SMSG_AURA_UPDATE (absent from older emitters). */
    replaceAll?: boolean;
  };
  /** One line of the spell combat log, already worded and semantically classified. */
  COMBAT_LOG: {
    casterGuid: bigint;
    targetGuid: bigint;
    spellId: number;
    text: string;
    critical: boolean;
    kind: "damage" | "heal" | "utility" | "kill";
  };
  /** Damage or healing worth showing over a unit's head. */
  FLOATING_TEXT: { guid: bigint; amount: number; kind: "damage" | "heal" | "power" | "miss"; critical: boolean; text?: string };
  ACTION_BUTTONS_CHANGED: Record<string, never>;
  THREAT_CHANGED: { guid: bigint };
  COMBO_POINTS_CHANGED: { guid: bigint; points: number };
  RUNES_CHANGED: Record<string, never>;
  /** A creature noticed someone. */
  AI_REACTION: { guid: bigint; reaction: number };
  /**
   * A unit told the people around it to stop keeping an eye on it: `SMSG_BREAK_TARGET`, which
   * `Spell::EffectForceDeselect` sends with the caster's own guid to everyone hostile — and which
   * `Unit::SendClearTarget` also broadcasts to everyone in sight when a passenger boards a vehicle.
   *
   * The *focus* is the whole of it, and the focus is a thing the interface keeps and the world
   * client has never heard of, hence the announcement. The selection belongs to this packet's
   * sibling `SMSG_CLEAR_TARGET`, which the fear sends three lines later with the same guid.
   */
  TARGET_BROKEN: { guid: bigint };
  PARTY_KILL: { killerGuid: bigint; victimGuid: bigint };
  /**
   * Somebody got off a mount: `SMSG_DISMOUNT`, from `Unit::Dismount` (`Unit.cpp:8742-8762`).
   *
   * Neither a cause nor a cure — dismounting arrives a second time as `UNIT_FIELD_MOUNTDISPLAYID`
   * going to zero, and that is the state everything reads. This is the *edge*: a sound, the camera
   * dropping back to the character's own height and the end of a ride animation all want the moment
   * rather than the level, and the packet was being parsed and thrown away.
   */
  UNIT_DISMOUNTED: { guid: bigint };
  /**
   * `SMSG_MOUNTSPECIAL_ANIM`: the trick a mount does when its rider presses the key.
   *
   * `WorldSession::HandleMountSpecialAnimOpcode` (`MovementHandler.cpp:603-609`) broadcasts it to
   * everyone in sight, so it names a rider who may be anybody, and it is the only way the animation
   * can be known — nothing about it is in the update fields.
   *
   * The rider is always somebody *else*: that broadcast is `SendMessageToSet(&data, false)`, and
   * with `self == false` `Player::SendMessageToSetInRange` (`Player.cpp:6546-6553`) skips
   * `SendDirectMessage` while `MessageDistDeliverer::SendPacket` (`GridNotifiers.h:147-149`)
   * refuses `player == i_source`. So the player who pressed the key never receives their own, and
   * a consumer hung on this event to animate the player's own character would never once fire.
   * `SMSG_DISMOUNT` is not symmetrical — `SendMessageToSet(&data, true)` (`Unit.cpp:8761`) — and
   * does name its own player.
   */
  MOUNT_SPECIAL: { guid: bigint };
  /**
   * `SMSG_MOUNT_RESULT`: why a mount was refused. It is never sent for success.
   *
   * `Spell::SendMountResult` (`Spell.cpp:4391-4406`) returns before writing anything when the
   * result is `MountResult::Ok`, which is **10** and not 0 (`SharedDefines.h:3813-3826`); it also
   * says nothing to a non-player caster or to one still loading. So an arriving packet always
   * carries a refusal, and 0 is `InvalidMountee`.
   */
  MOUNT_RESULT: { result: number };
  /** A SpellVisualKit the server asked to be played on a unit. */
  SPELL_VISUAL: { guid: bigint; kitId: number; impact: boolean };
  /** The quest log moved: a counter, a completion, a template that arrived, an abandonment. */
  QUEST_LOG_CHANGED: Record<string, never>;
  /** One objective advanced, with the numbers to show next to it. */
  QUEST_PROGRESS: { questId: number; entry: number; count: number; required: number };
  QUEST_FINISHED: { questId: number; failed: boolean };
  /** The mark over a head changed. An undefined guid means the whole list was replaced. */
  QUEST_GIVER_STATUS: { guid: bigint | undefined };
  /** A party member is sharing a quest, or the offer has been answered. */
  QUEST_SHARED: { quest: { questId: number; title: string; initiatorGuid: bigint } | undefined };
  /** MSG_QUEST_PUSH_RESULT to the sharer: what one party member did with the offer (`QUEST_PARTY_MSG_*`). */
  QUEST_PUSH_RESULT: { guid: bigint; result: number };
  /** A level, and what it brought. */
  LEVEL_UP: { level: number; healthDelta: number; powerDelta: number[]; statDelta: number[] };
  SPELL_LEARNED: { spellId: number };
  REPUTATION_CHANGED: Record<string, never>;
  ACHIEVEMENT_EARNED: { achievementId: number; mine: boolean };
  /**
   * The other achievement packets: the whole list at login (`list`), one criterion's progress
   * (`criteria`, with the seconds a timed one has run), a deletion (`deleted`), or another player's
   * list answering CMSG_QUERY_INSPECT_ACHIEVEMENTS (`inspect`, read `inspectAchievements`).
   */
  ACHIEVEMENT_STATE_CHANGED:
    | { kind: "list" }
    | { kind: "criteria"; criteriaId: number; timeElapsed: number }
    | { kind: "deleted" }
    | { kind: "inspect"; guid: bigint };
  /** The packet identifies pet talent state separately; player-only UI must ignore pet updates. */
  TALENTS_CHANGED: { pet: boolean };
  /** Anything the character sheet shows that is not an update field. */
  CHARACTER_SHEET_CHANGED: Record<string, never>;
  /** `SMSG_EQUIPMENT_SET_USE_RESULT`: 0 for a set worn, 4 for «inventory full» — the only failure the core sends. */
  EQUIPMENT_SET_USE_RESULT: { result: number };
  /** A bank window opened, or its slots changed. */
  BANK_OPENED: { bankerGuid: bigint | undefined };
  /** A new area walked into, and the experience it was worth. */
  EXPLORATION: { areaId: number; experience: number };
  /** The weather in the zone changed, or a script overrode its light. */
  WEATHER_CHANGED: { state: number; intensity: number; abrupt: boolean } | undefined;
  /**
   * Something the world said to everyone standing in it.
   *
   * `banner` is the yellow flash across the middle of the screen an area trigger raises,
   * `defense` the zone-attack line, `system` everything the world says about itself.
   */
  WORLD_MESSAGE: { text: string; kind: "banner" | "defense" | "system" };
  /** A destructible building took damage. */
  BUILDING_DAMAGE: { target: bigint; attacker: bigint; controller: bigint; damage: number; spellId: number };
  /** Somebody is offering to summon the character, and the offer expires. */
  SUMMON_REQUEST: { summoner: bigint; zoneId: number; timeoutMilliseconds: number };
  /** An innkeeper asks whether to make this place home (SMSG_BINDER_CONFIRM); `binderConfirm` holds it. */
  BINDER_CONFIRM: { guid: bigint };
  /** A trainer quotes a talent reset (MSG_TALENT_WIPE_CONFIRM with a guid); `talentWipeConfirm` holds it. */
  TALENT_WIPE_CONFIRM: { guid: bigint; cost: number };
  /** Bind to this instance or leave it, within the server's minute (SMSG_INSTANCE_LOCK_WARNING_QUERY). */
  INSTANCE_LOCK_START: { milliseconds: number; encounterMask: number; previouslySaved: boolean };
  /** That question went: answered, run out, or the instance left. */
  INSTANCE_LOCK_STOP: Record<string, never>;
  /**
   * 3.22a: SMSG_RAID_GROUP_ONLY's homebind delay — above 0 the server will port the player out of a
   * raid instance they have no raid group for (INSTANCE_BOOT_START), 0 the reminder taken back
   * (INSTANCE_BOOT_STOP; Wow.exe 0x6e3c10 → 0x513ad0; FrameXmlServerPrompts.ts keeps the deadline).
   */
  INSTANCE_BOOT: { milliseconds: number };
  /** A flight master's map of destinations arrived. */
  TAXI_MENU: { guid: bigint; currentNode: number; knownNodes: number[] };
  /** A selected flight was accepted or refused; the native window owns the visible outcome. */
  TAXI_CHANGED: { guid: bigint; reply: number };
  /** SMSG_TAXINODE_STATUS (5.28): whether a flight master in view has a node this character knows. */
  TAXI_NODE_STATUS_CHANGED: { guid: bigint; known: boolean };
  /** The instance difficulty changed, or the list of lockouts did. */
  INSTANCE_CHANGED: { difficulty?: number; lockouts?: number };
  /** SMSG_NEW_WORLD: the character left its map through a loading screen; the realm recreates it there. */
  WORLD_TRANSFER: { mapId: number };
  /** A boss frame: engage, disengage, or an objective moving. */
  ENCOUNTER_FRAME: { type: number; guid: bigint | undefined; param1: number; param2: number };
  /** A spirit healer is asking whether to resurrect the character here and now. */
  SPIRIT_HEALER_CONFIRM: { guid: bigint };
  /** A party or raid member's health, power, zone, auras or pet moved. */
  PARTY_MEMBER_STATS: { guid: bigint };
  /** A ready check began, an answer arrived, or it ended. An undefined initiator means it ended. */
  READY_CHECK: { initiatorGuid: bigint | undefined; answeredGuid?: bigint };
  /** A raid marker moved. An undefined icon means the whole set was replaced. */
  RAID_TARGET_UPDATE: { icon: number | undefined };
  /** Somebody pinged the minimap. Not always a player: a Sentry Totem pings with its own guid. */
  MINIMAP_PING: { guid: bigint; x: number; y: number };
  /** Quest markers arrived, or a gossip menu named a place. */
  QUEST_POI: Record<string, never>;
  /**
   * SMSG_QUERY_QUESTS_COMPLETED_RESPONSE replaced `completedQuests` (the stock client raises
   * QUEST_QUERY_COMPLETE after every answer, Wow.exe 0x005b5190).
   */
  QUESTS_COMPLETED: Record<string, never>;
  /** A need-or-greed roll opened, moved or finished. An undefined slot means the set was replaced. */
  LOOT_ROLL_CHANGED: { itemSlot: number | undefined; newItemGuid?: bigint };
  /** SMSG_LOOT_LIST (5.28): the master looter and the round-robin owner of a corpse; `lootOwners` holds it. */
  LOOT_LIST_CHANGED: { corpseGuid: bigint };
  /** The guild bank, its logs, its permissions or a tab's text changed. */
  GUILD_BANK_CHANGED: GuildBankChange;
  /** The calendar, one event of it, or the pending-invite count changed. */
  CALENDAR_CHANGED: {
    eventId: bigint | undefined;
    /** Responses redraw; only an alert requires another snapshot. */
    reason?: "snapshot" | "event" | "pending" | "error" | "alert" | "complete" | "invite";
  };
  /** One calendar packet's parsed body, emitted right after its CALENDAR_CHANGED/INSTANCE_CHANGED. */
  CALENDAR_PACKET: CalendarPacket;
  /** A chat channel's roster or state moved. */
  CHANNEL_CHANGED: { channel: string };
  /** The friends or ignore list changed, or a friend came online. */
  CONTACTS_CHANGED: Record<string, never>;
  /** L5c 3.18: SMSG_CHAT_PLAYER_NOT_FOUND's name — the autocomplete list takes ONLINE back (Wow.exe 0x006e2e90). */
  CHAT_PLAYER_NOT_FOUND: { name: string };
  /** A `/who` answer arrived. */
  WHO_RESULTS: Record<string, never>;
  /** A charter was queried, signed, renamed, refused or turned in. */
  PETITION_CHANGED: Record<string, never>;
  /** Anything in the dungeon finder past the queue itself: locks, role check, boot vote, reward. */
  LFG_INFO_CHANGED: Record<string, never>;
  /**
   * One dungeon-finder packet landed, named by what it changed. Emitted beside the single-slot
   * `onLfgChanged` (still the native window's) so a second owner — the stock LFD frames — can
   * subscribe without taking that slot. `kind` maps one-to-one onto the handlers in WorldClient;
   * the state itself stays on the client's `lfg*` fields, read after the event.
   */
  LFG_STATE_CHANGED: LfgStateChange;
  /** How long until the next letter is delivered, and who it is from. */
  MAIL_TIME_CHANGED: Record<string, never>;
  /**
   * One mailbox packet or edge, beside the single-slot `onMailChanged` (still the native window's),
   * so the stock MailFrame model can subscribe without taking that slot (FrameXmlMail.ts).
   */
  MAIL_STATE_CHANGED: MailStateChange;
  /** One trade packet or local offer change, beside the native `onTradeChanged` (FrameXmlTrade.ts). */
  TRADE_STATE_CHANGED: TradeStateChange;
  /** One auction-house packet or edge, beside the native `onAuctionChanged` (FrameXmlAuction.ts). */
  AUCTION_STATE_CHANGED: AuctionStateChange;
  /** The pet bar arrived, changed, or was taken down. A zero guid means there is no pet now. */
  PET_BAR_CHANGED: { guid: bigint };
  /** The pet's cooldown set was replaced, or one of them was cleared. */
  PET_COOLDOWNS_CHANGED: Record<string, never>;
  /** The pet started swinging (`SMSG_ATTACK_START`) at `victim`, or stopped: undefined. */
  PET_ATTACK_CHANGED: { victim: bigint | undefined };
  /**
   * A pet cooldown began. The duration is not on the wire — it is the spell's own DBC recovery
   * time — so this announces the start and leaves the length to whoever has the tables.
   */
  PET_COOLDOWN_STARTED: { spellId: number };
  /** An item use cooldown began (marker; exact length comes from DBC/cooldown packets). */
  ITEM_COOLDOWN_STARTED: { spellId: number; itemGuid: bigint };
  /** Spell cost/duration/damage modifiers changed (procs, talents, set bonuses). */
  SPELL_MODIFIERS_CHANGED: Record<string, never>;
  /** A totem was created in one of the four slots. */
  TOTEM_CREATED: { slot: number; guid: bigint; duration: number; spellId: number };
  /**
   * A blow, heal, energize or miss as its packet states it (UnitCombat.ts) — the facts behind the
   * stock hit indicator, where FLOATING_TEXT is the already-worded number over a head.
   */
  UNIT_COMBAT: UnitCombatEvent;
  /**
   * `SMSG_ITEM_ENCHANT_TIME_UPDATE`: how many seconds an item's enchantment slot has left,
   * `receivedAt` in `performance.now()` terms. Sent on login and whenever a timed enchantment is
   * applied (Player::AddEnchantmentDuration); the item field alone carries no start time.
   */
  ITEM_ENCHANT_TIME_UPDATE: { itemGuid: bigint; slot: number; duration: number; playerGuid: bigint; receivedAt: number };
  /** A missile position update arrived for a caster. */
  PROJECTILE_MOVED: { casterGuid: bigint; castCount: number; x: number; y: number; z: number };
  /** Something the pet said back: a refusal, a taming failure, a rejected name. */
  PET_MESSAGE: { text: string; error: boolean };
  /** A pet name query answered, so a name that was a number is now a name. */
  PET_NAME_CHANGED: { petNumber: number };
  /** The stable master's list, or the result of stabling something. */
  STABLE_CHANGED: Record<string, never>;
  /** A unit gained or lost a vehicle kit. A zero id means it is no longer a vehicle. */
  VEHICLE_CHANGED: { guid: bigint; vehicleId: number };
  /**
   * One of the two battleground queue slots moved: queued, invited, playing, or emptied.
   *
   * `cleared` is how the slot going free is reported, because the server has no status code for it
   * — it sends the slot number and eight zero bytes.
   */
  BATTLEFIELD_QUEUE_CHANGED: { queueSlot: number; status: number; cleared: boolean };
  /** A battlemaster's list of battlegrounds and what a win there is worth. */
  BATTLEFIELD_LIST_CHANGED: { bgTypeId: number };
  /** A tabard designer opened, or accepted/refused an emblem change. */
  TABARD_VENDOR_CHANGED: { guid: bigint };
  /** The scoreboard arrived, or the match ended and sent its final one. */
  PVP_SCOREBOARD_CHANGED: { ended: boolean };
  /** Anything PvP said in words: a queue refusal, an arena team error, a battlefield ejection. */
  PVP_MESSAGE: { text: string; error: boolean };
  /** Honor for a kill. The amount is already scaled by the realm's rate. */
  HONOR_AWARDED: { honor: number; victimGuid: bigint; victimRank: number };
  /** Somebody entered or left the battleground the player is standing in. */
  BATTLEGROUND_PLAYER_CHANGED: { guid: bigint; joined: boolean };
  /** Where the flags are. Answers a request, and is never sent unasked. */
  FLAG_CARRIERS_CHANGED: Record<string, never>;
  /**
   * A world state moved. An undefined variable means the whole set was replaced, which is what a
   * zone change does.
   */
  WORLD_STATE_CHANGED: { variableId: number | undefined };
  /** An arena team's tabard, record or roster arrived, or an event happened to it. */
  ARENA_TEAM_CHANGED: { teamId: number | undefined };
  /** Somebody's honor or arena teams came back from an inspection. */
  PVP_INSPECTION: { guid: bigint };
  /** Somebody's talents and equipped enchantments came back from `CMSG_INSPECT` (`WorldClient.inspections`). */
  INSPECT_TALENT_READY: { guid: bigint };
  /** The outdoor battlefield — Wintergrasp — invited, admitted or ejected the player. */
  BATTLEFIELD_CHANGED: { battleId: number };
  /**
   * Something the session itself said: the message of the day, a flashed notification, a shutdown
   * announcement. Not the world talking — that is `WORLD_MESSAGE` — but the server.
   */
  SESSION_MESSAGE: { text: string; kind: "motd" | "notification" | "server" };
  /** One of the eight saved account blobs arrived or was stored. Undefined means the times list. */
  ACCOUNT_DATA_CHANGED: { type: number | undefined };
  /** The 256 tutorial bits arrived. */
  TUTORIALS_CHANGED: Record<string, never>;
  /**
   * The logout moved. `pending` is set from the moment the server grants it; `complete` is the
   * end — the session is over and nothing else will arrive on it.
   */
  LOGOUT_CHANGED: { pending: boolean; complete: boolean };
  /**
   * A query answer landed in the cache that stands in for the original client's `WDB` files.
   *
   * `cleared` is the whole cache going rather than one answer arriving, which is what
   * `SMSG_CLIENTCACHE_VERSION` means, and its `id` is 0. A listener holding answers of its own —
   * the two metadata clients do, over the top of the gateway dumps — has to let go of them as
   * well, or the one packet whose entire job is to say "ask again" is heard by this cache and by
   * nothing else.
   */
  QUERY_CACHE_CHANGED: { kind: "creature" | "gameObject" | "item" | "itemSet" | "page" | "itemText" | "cleared"; id: number | bigint };
  /**
   * A reader opened: `SMSG_READ_ITEM_OK` for a readable item (`item`), `SMSG_GAMEOBJECT_PAGETEXT` for
   * a goober with a page (`object`). What it shows is in the named object's template and its pages.
   */
  ITEM_TEXT_OPENED: { kind: "item" | "object"; guid: bigint; text?: string };
  /** SMSG_ITEM_TEXT_QUERY_RESPONSE (5.28): an item's text (a mail copy) arrived; `itemText(guid)` holds it. */
  ITEM_TEXT_RECEIVED: { guid: bigint };
  /** The player's ticket, a game master's answer to it, or whether tickets are taken at all. */
  GM_TICKET_CHANGED: { kind?: "snapshot" | "result" | "system" | "response" | "resolved" };
  /** A rename, a customise, a faction change, or a haircut paid for. */
  CHARACTER_SERVICE: { kind: "rename" | "customize" | "factionChange" | "barber"; result: number };
  /** A barber's chair opened or closed its window. */
  BARBER_SHOP: { open: boolean };
  /** The server asked for a sound. Audio is a later slice; the request is read now. */
  PLAY_SOUND: { soundKitId: number; sourceGuid: bigint; music: boolean };
  /**
   * A message on the addon channel, already split at the tab into prefix and payload.
   *
   * These never reach the chat log: they are traffic between addons, and the original client hides
   * them for the same reason.
   */
  ADDON_MESSAGE: { prefix: string; message: string; senderGuid: bigint; senderName: string; type: number };
}
