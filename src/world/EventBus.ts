/** Drops a subscription. Returned by every `on`, so a panel can be closed without leaking it. */
export type Unsubscribe = () => void;

import type { SpellGo } from "./SpellProtocol.js";
import type { ActiveAura } from "./AuraProtocol.js";
import type { TextEmote } from "./ChatProtocol.js";

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
  /** A ranged auto-repeat (Auto Shot or wand Shoot) stopped for this unit. */
  STOP_AUTOREPEAT_SPELL: { guid: bigint };
  /** `SMSG_TEXT_EMOTE`: the source and text-emote tuple, before any client-side sentence lookup. */
  TEXT_EMOTE: TextEmote;
  /** A unit began a cast or a channel. `castTime` is what is left to run, in milliseconds. */
  SPELL_CAST_START: { casterGuid: bigint; spellId: number; castTime: number; channel: boolean };
  /** The cast ended, whether it landed, was interrupted or was cancelled. */
  SPELL_CAST_STOP: { casterGuid: bigint; spellId: number; interrupted: boolean };
  /** The server accepted this player's request; START wins for a cast-time spell, GO for instant. */
  SPELL_CAST_ACCEPTED: {
    spellId: number;
    castId: number;
    startedAt: number;
    source: "start" | "go";
  };
  /** Pushback: damage taken while casting adds to what is left. */
  SPELL_CAST_DELAYED: { casterGuid: bigint; delay: number };
  /** A complete SMSG_SPELL_GO, including hit/miss lists and an optional target destination. */
  SPELL_GO: SpellGo;
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
  /** A level, and what it brought. */
  LEVEL_UP: { level: number; healthDelta: number; powerDelta: number[]; statDelta: number[] };
  SPELL_LEARNED: { spellId: number };
  REPUTATION_CHANGED: Record<string, never>;
  ACHIEVEMENT_EARNED: { achievementId: number; mine: boolean };
  TALENTS_CHANGED: Record<string, never>;
  /** Anything the character sheet shows that is not an update field. */
  CHARACTER_SHEET_CHANGED: Record<string, never>;
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
  /** A flight master's map of destinations arrived. */
  TAXI_MENU: { guid: bigint; currentNode: number; knownNodes: number[] };
  /** The instance difficulty changed, or the list of lockouts did. */
  INSTANCE_CHANGED: { difficulty?: number; lockouts?: number };
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
  /** A need-or-greed roll opened, moved or finished. An undefined slot means the set was replaced. */
  LOOT_ROLL_CHANGED: { itemSlot: number | undefined };
  /** The guild bank, its logs, its permissions or a tab's text changed. */
  GUILD_BANK_CHANGED: Record<string, never>;
  /** The calendar, one event of it, or the pending-invite count changed. */
  CALENDAR_CHANGED: { eventId: bigint | undefined };
  /** A chat channel's roster or state moved. */
  CHANNEL_CHANGED: { channel: string };
  /** The friends or ignore list changed, or a friend came online. */
  CONTACTS_CHANGED: Record<string, never>;
  /** A `/who` answer arrived. */
  WHO_RESULTS: Record<string, never>;
  /** A charter was queried, signed, renamed, refused or turned in. */
  PETITION_CHANGED: Record<string, never>;
  /** Anything in the dungeon finder past the queue itself: locks, role check, boot vote, reward. */
  LFG_INFO_CHANGED: Record<string, never>;
  /** How long until the next letter is delivered, and who it is from. */
  MAIL_TIME_CHANGED: Record<string, never>;
  /** The pet bar arrived, changed, or was taken down. A zero guid means there is no pet now. */
  PET_BAR_CHANGED: { guid: bigint };
  /** The pet's cooldown set was replaced, or one of them was cleared. */
  PET_COOLDOWNS_CHANGED: Record<string, never>;
  /**
   * A pet cooldown began. The duration is not on the wire — it is the spell's own DBC recovery
   * time — so this announces the start and leaves the length to whoever has the tables.
   */
  PET_COOLDOWN_STARTED: { spellId: number };
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
  QUERY_CACHE_CHANGED: { kind: "creature" | "item" | "itemSet" | "page" | "itemText" | "cleared"; id: number | bigint };
  /** The player's ticket, a game master's answer to it, or whether tickets are taken at all. */
  GM_TICKET_CHANGED: Record<string, never>;
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
