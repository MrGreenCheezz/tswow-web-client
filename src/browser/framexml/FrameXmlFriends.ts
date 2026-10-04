/**
 * The stock FriendsFrame's C API — FriendsFrame.xml (Friends/Ignore, Who, Guild and Chat tabs,
 * AddFriendFrame) and RaidFrame.xml (the Raid tab) — over this client's contact, `/who`, guild and
 * group state. One model per seam; the guild and raid halves are FrameXmlGuild.ts/FrameXmlRaid.ts.
 *
 * Measured against the stock 3.3.5 Lua (FriendsFrame.lua, 2830 lines):
 *
 * * `FriendsList_Update` treats friend ids `1..numOnline` as the online ones and the rest as offline
 *   (FriendsFrame.lua:386-407), so `GetFriendInfo(i)` walks online friends first, then offline, each
 *   by name. `GetFriendInfo` and `SetFriendNotes` take an index *or* a name: the row's note button
 *   passes its id (FriendsFrame.xml:411) and UnitPopup's SET_NOTE the name (UnitPopup.lua:1221).
 * * `status` is compared with `CHAT_FLAG_AFK`/`CHAT_FLAG_DND` (FriendsFrame.lua:2144-2147), which are
 *   locale strings; the flat `WebClientFriendInfo` answers the status bits and the Lua prelude
 *   substitutes the strings, as it does for the guild roster.
 * * A contact's note is nil when empty: the friend tooltip shows the note icon on any non-nil note
 *   (FriendsFrame.lua:2448).
 * * `WhoList_Update` ends in `ShowUIPanel(FriendsFrame)` (FriendsFrame.lua:852-853), so every
 *   WHO_LIST_UPDATE opens the Who tab. WhoFrame's OnShow/OnHide flip `SetWhoToUI(1/0)`.
 * * Battle.net does not exist on a 3.3.5 TrinityCore realm: `BNFeaturesEnabled()` is false, which is
 *   the stock branch that hides the Pending tab, the broadcast box and the Battle.net status
 *   (FriendsFrame.lua:235-240), and every other `BN*` call answers «none».
 *
 * Names FrameXmlChatApi registers after load — `AddFriend`, `RemoveFriend`, `AddOrRemoveFriend`,
 * `AddIgnore`, `DelIgnore`, `AddOrDelIgnore`, `SendWho`, `InviteUnit` and the `Guild*` commands —
 * keep that single owner: the stock frame calls them by name (`AddFriend(WhoFrame.selectedName)`,
 * `DelIgnore(GetIgnoreName(i))`, UnitPopup's `RemoveFriend(name)`), which is what it registers.
 */
import {
  FRIEND_STATUS_AFK, FRIEND_STATUS_DND, FRIEND_STATUS_OFFLINE, SOCIAL_FLAG_ALL, SOCIAL_FLAG_FRIEND,
  SOCIAL_FLAG_IGNORED, type Contact, type ContactList, type WhoEntry, type WhoResult,
} from "../../world/ContactProtocol.js";
import { FRAMEXML_GUILD_CALLS, FrameXmlGuildModel, type FrameXmlGuildContext, type FrameXmlGuildWorld } from "./FrameXmlGuild.js";
import {
  FRAMEXML_RAID_CALLS, FrameXmlRaidModel, type FrameXmlRaidContext, type FrameXmlRaidWorld,
} from "./FrameXmlRaid.js";
import { FRAMEXML_CHANNELS_CALLS, FrameXmlChannelsModel, type FrameXmlChannelsWorld } from "./FrameXmlFriendsChannels.js";
import { femaleOf } from "../ui/UnitSnapshot.js"; // L3-review

/**
 * The real client prints a `/who` answer of this many rows or fewer into chat while the Who tab is
 * closed (`SetWhoToUI(0)`), and opens the tab for a longer one. Recorded from the 3.3.5 client's
 * behaviour, not measured here: the live client is the check.
 */
export const FRAMEXML_WHO_CHAT_ROWS = 3;

/** The AreaTable/Map rows the zone and lockout columns name, as `/dbc/areas` serves them. */
export interface FrameXmlSocialAreaData {
  readonly areas: readonly { readonly id: number; readonly name: string }[];
  readonly maps: readonly { readonly id: number; readonly name: string; readonly instanceType: number }[];
}

/**
 * `areaName`/`mapInfo` over the session's area snapshot, indexed once per snapshot. Before the area
 * metadata lands both answer undefined and the zone columns read empty, never an invented name.
 */
export function frameXmlSocialAreaLookup(metadata: () => FrameXmlSocialAreaData | undefined): {
  areaName(areaId: number): string | undefined;
  mapInfo(mapId: number): { readonly name: string; readonly instanceType: number } | undefined;
} {
  let indexed: FrameXmlSocialAreaData | undefined;
  let areas = new Map<number, string>();
  let maps = new Map<number, { readonly name: string; readonly instanceType: number }>();
  const index = (): void => {
    const data = metadata();
    if (data === indexed) return;
    indexed = data;
    areas = new Map((data?.areas ?? []).map((row) => [row.id, row.name]));
    maps = new Map((data?.maps ?? []).map((row) => [row.id, row]));
  };
  return {
    areaName: (areaId) => { index(); return areaId > 0 ? areas.get(areaId) : undefined; },
    mapInfo: (mapId) => { index(); return maps.get(mapId); },
  };
}

/** The world's typed bus, narrowed to what the model listens to. */
export interface FrameXmlFriendsEvents {
  on(name: "CONTACTS_CHANGED", listener: () => void): () => void;
  on(name: "WHO_RESULTS", listener: () => void): () => void;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlFriendsWorld extends FrameXmlGuildWorld, FrameXmlRaidWorld, FrameXmlChannelsWorld {
  readonly events?: FrameXmlFriendsEvents | undefined;
  readonly contacts?: ContactList | undefined;
  readonly whoResult?: WhoResult | undefined;
  displayName(guid: bigint): string;
  requestName?(guid: bigint): void;
  requestContacts(flags?: number): void;
  /** CMSG_SET_CONTACT_NOTES; absent on a world built before it existed. */
  setFriendNote?(guid: bigint, note: string): void;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlFriendsContext extends Omit<FrameXmlGuildContext, "world">, Omit<FrameXmlRaidContext, "world"> {
  world(): FrameXmlFriendsWorld | undefined;
  /** L3-review: `female` picks the sexed name (Wow.exe 0x715970); undefined, `Name_lang`. */
  raceName?(raceId: number, female?: boolean): string | undefined;
}

interface FriendsPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

type WhoSortKey = "name" | "zone" | "guild" | "race" | "level" | "class";
const WHO_SORT_KEYS: ReadonlySet<string> = new Set(["name", "zone", "guild", "race", "level", "class"]);

/** Status bits → the prelude's code: 0 available, 1 AFK, 2 DND. */
function statusCode(status: number): number {
  if ((status & FRIEND_STATUS_AFK) !== 0) return 1;
  if ((status & FRIEND_STATUS_DND) !== 0) return 2;
  return 0;
}

export class FrameXmlFriendsModel {
  readonly guild: FrameXmlGuildModel;
  readonly raid: FrameXmlRaidModel;
  /** The Chat tab (ChannelFrame): joined channels and rosters (FrameXmlFriendsChannels.ts). */
  readonly channels: FrameXmlChannelsModel;
  /**
   * Set by the world mount once the stock FriendsFrame is published. `/who` answers are announced to
   * stock only then: WhoList_Update opens FriendsFrame (FriendsFrame.lua:853), and while the native
   * social window owns the route a stock frame must not appear beside it. The list-only events
   * (FRIENDLIST_UPDATE…) repaint only what is shown, so they flow either way.
   */
  owned = false;
  readonly #context: FrameXmlFriendsContext;
  #pump: FriendsPump | undefined;
  #unsubscribe: (() => void)[] = [];
  #muted = false;
  #selectedFriend: bigint | undefined;
  #selectedIgnore: bigint | undefined;
  #whoToUi = false;
  #whoSort: WhoSortKey | undefined;
  #whoDescending = false;
  #whoSeen: WhoResult | undefined;
  #whoRows: { result: WhoResult; key: string; rows: readonly WhoEntry[] } | undefined;
  #friendSignature = "";
  #ignoreSignature = "";
  #contactsSeen: ContactList | undefined;
  readonly #sortedLists = new Map<"friends" | "ignores", { source: readonly Contact[]; key: string; list: Contact[] }>();

  constructor(context: FrameXmlFriendsContext) {
    this.#context = context;
    this.guild = new FrameXmlGuildModel(context);
    this.raid = new FrameXmlRaidModel(context);
    this.channels = new FrameXmlChannelsModel(() => context.world());
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  attach(pump: FriendsPump): void {
    this.detach();
    this.#pump = pump;
    this.guild.attach(pump);
    this.raid.attach(pump);
    this.channels.attach(pump);
    const world = this.#context.world();
    this.#whoSeen = world?.whoResult;
    this.#contactsSeen = world?.contacts;
    this.#friendSignature = this.#listSignature(SOCIAL_FLAG_FRIEND);
    this.#ignoreSignature = this.#listSignature(SOCIAL_FLAG_IGNORED);
    const events = world?.events;
    // A world without an event bus (older fakes) answers the C API and simply raises no events.
    if (events && typeof events.on === "function") {
      this.#unsubscribe.push(events.on("CONTACTS_CHANGED", () => this.#contactsChanged()));
      this.#unsubscribe.push(events.on("WHO_RESULTS", () => this.#whoChanged()));
    }
  }

  detach(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.guild.detach();
    this.raid.detach();
    this.channels.detach();
    this.#pump = undefined;
  }

  /** Run a transactional probe (the mount's gate) without sending a packet. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try {
      return this.guild.muted(() => this.raid.muted(() => this.channels.muted(operation)));
    } finally {
      this.#muted = previous;
    }
  }

  #command(run: (world: FrameXmlFriendsWorld) => void): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (world) run(world);
  }

  /**
   * The 60 ms poll: guild and group state have no event this model can subscribe to, and the chat
   * seam owns the one CHANNEL_CHANGED listener; each half compares its fields' identities.
   */
  tick(): void {
    this.guild.tick();
    this.raid.tick();
    this.channels.tick();
  }

  // ---- friends -----------------------------------------------------------------------------

  #name(guid: bigint): string {
    const world = this.#context.world();
    const name = world?.displayName(guid) ?? "";
    if (name.startsWith("0x")) world?.requestName?.(guid);
    return name;
  }

  /**
   * One contact list in its stock order. FriendsList_Update and IgnoreList_Update read it a row at
   * a time (`GetFriendInfo(i)`, `GetIgnoreName(i)`), and sorting it per row cost 3.7 ms a repaint
   * for 50 friends (TrinityCore's cap) and 10 ms for 100 (measured in node on P-cores). The order
   * is kept while the held contact array and every entry's order key — GUID, online, name — hold: a
   * folded status packet changes a key in place, a new SMSG_CONTACT_LIST replaces the array, and a
   * name that arrives later changes its key.
   */
  #sortedContacts(which: "friends" | "ignores"): Contact[] {
    const source = this.#context.world()?.contacts?.contacts ?? [];
    const flag = which === "friends" ? SOCIAL_FLAG_FRIEND : SOCIAL_FLAG_IGNORED;
    const entries = source
      .filter((contact) => (contact.flags & flag) !== 0)
      .map((contact) => ({ contact, name: this.#name(contact.guid), online: contact.status !== FRIEND_STATUS_OFFLINE }));
    const key = entries.map((entry) => `${entry.contact.guid}:${which === "friends" && entry.online ? 1 : 0}:${entry.name}`)
      .join("\u0001");
    const held = this.#sortedLists.get(which);
    if (held?.source === source && held.key === key) return held.list;
    const byName = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name, "ru");
    const list = entries
      .sort(which === "friends" ? (left, right) => Number(right.online) - Number(left.online) || byName(left, right) : byName)
      .map((entry) => entry.contact);
    this.#sortedLists.set(which, { source, key, list });
    return list;
  }

  /** Online friends first, then offline, each by name (see the module doc). */
  #friends(): Contact[] { return this.#sortedContacts("friends"); }

  #ignores(): Contact[] { return this.#sortedContacts("ignores"); }

  /** A 1-based index or a name, as stock passes either. */
  #friend(key: unknown): { contact: Contact; index: number } | undefined {
    const friends = this.#friends();
    if (typeof key === "number" && Number.isInteger(key)) {
      const contact = friends[key - 1];
      return contact ? { contact, index: key } : undefined;
    }
    const wanted = typeof key === "string" ? key.trim().toLowerCase() : "";
    if (!wanted) return undefined;
    const index = friends.findIndex((contact) => this.#name(contact.guid).toLowerCase() === wanted);
    const contact = friends[index];
    return contact ? { contact, index: index + 1 } : undefined;
  }

  numFriends(): readonly [total: number, online: number] {
    const friends = this.#friends();
    return [friends.length, friends.filter((contact) => contact.status !== FRIEND_STATUS_OFFLINE).length];
  }

  /**
   * `GetFriendInfo(i or name)`'s flat half: name, level, class, area, connected, status code, note.
   * An offline friend carries no level, class or zone on the wire (ContactProtocol), so those are
   * 0/""/"" — stock prints only the name for it (FriendsFrame.lua:2151-2156).
   */
  friendInfo(key: unknown): readonly unknown[] | undefined {
    const found = this.#friend(key);
    if (!found) return undefined;
    const { contact } = found;
    const online = contact.status !== FRIEND_STATUS_OFFLINE;
    return [
      this.#name(contact.guid), online ? contact.level : 0,
      // L3-review: Wow.exe 0x6b4130 — the name cache's sex; no entry, Name_lang (female undefined).
      online ? this.#context.classInfo?.(contact.classId, this.#context.female?.(contact.guid))?.[0] ?? "" : "",
      online ? this.#context.areaName?.(contact.areaId) ?? "" : "",
      online, statusCode(contact.status), contact.note === "" ? undefined : contact.note,
    ];
  }

  selectedFriend(): number {
    const guid = this.#selectedFriend;
    if (guid === undefined) return 0;
    return this.#friends().findIndex((contact) => contact.guid === guid) + 1;
  }

  selectFriend(index: number): void {
    this.#selectedFriend = this.#friends()[index - 1]?.guid;
  }

  /**
   * `SetFriendNotes(i or name, note)`: CMSG_SET_CONTACT_NOTES (TrinityCore
   * `HandleSetContactNotesOpcode`: guid, note; no answer), and the held note changes at once, as the
   * client's own list does — FRIENDLIST_UPDATE repaints it. TrinityCore keeps 48 characters.
   */
  setFriendNote(key: unknown, note: string): void {
    const found = this.#friend(key);
    if (!found || this.#muted) return;
    const world = this.#context.world();
    if (!world?.setFriendNote) return;
    const trimmed = note.slice(0, 48);
    world.setFriendNote(found.contact.guid, trimmed);
    found.contact.note = trimmed;
    this.#friendSignature = this.#listSignature(SOCIAL_FLAG_FRIEND);
    this.#pump?.fire("FRIENDLIST_UPDATE");
  }

  /** `ShowFriends()`: CMSG_CONTACT_LIST; the answer arrives as CONTACTS_CHANGED. */
  showFriends(): void {
    this.#command((world) => world.requestContacts(SOCIAL_FLAG_ALL));
  }

  // ---- ignore ------------------------------------------------------------------------------

  numIgnores(): number { return this.#ignores().length; }

  ignoreName(index: number): string | undefined {
    const contact = this.#ignores()[index - 1];
    return contact ? this.#name(contact.guid) : undefined;
  }

  selectedIgnore(): number {
    const guid = this.#selectedIgnore;
    if (guid === undefined) return 0;
    return this.#ignores().findIndex((contact) => contact.guid === guid) + 1;
  }

  selectIgnore(index: number): void {
    this.#selectedIgnore = this.#ignores()[index - 1]?.guid;
  }

  // ---- who ---------------------------------------------------------------------------------

  setWhoToUi(toUi: boolean): void { this.#whoToUi = toUi; }
  whoToUi(): boolean { return this.#whoToUi; }

  #whoZone(entry: WhoEntry): string { return this.#context.areaName?.(entry.zoneId) ?? ""; }

  #whoList(): readonly WhoEntry[] {
    const result = this.#context.world()?.whoResult;
    if (!result) return [];
    const key = `${this.#whoSort ?? ""}|${this.#whoDescending}`;
    if (this.#whoRows?.result === result && this.#whoRows.key === key) return this.#whoRows.rows;
    const sort = this.#whoSort;
    let rows: readonly WhoEntry[] = result.entries;
    if (sort) {
      const value = (entry: WhoEntry): string | number => {
        switch (sort) {
          case "name": return entry.name;
          case "guild": return entry.guild;
          case "zone": return this.#whoZone(entry);
          // L3-review: 0x6b5016 sorts by the row's sexed names, as GetWhoInfo shows them.
          case "race": return this.#context.raceName?.(entry.race, femaleOf(entry.gender)) ?? "";
          case "class": return this.#context.classInfo?.(entry.classId, femaleOf(entry.gender))?.[0] ?? "";
          case "level": return entry.level;
        }
      };
      const direction = this.#whoDescending ? -1 : 1;
      rows = [...result.entries].sort((left, right) => {
        const a = value(left);
        const b = value(right);
        const order = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "ru");
        return direction * order || left.name.localeCompare(right.name, "ru");
      });
    }
    this.#whoRows = { result, key, rows };
    return rows;
  }

  /** `GetNumWhoResults()`: rows sent, and how many matched (the server caps the rows at 50). */
  numWhoResults(): readonly [shown: number, total: number] {
    const result = this.#context.world()?.whoResult;
    return result ? [result.entries.length, Math.max(result.matched, result.entries.length)] : [0, 0];
  }

  /** `GetWhoInfo(i)`: name, guild, level, race, class, zone, classFileName. */
  whoInfo(index: number): readonly unknown[] | undefined {
    const entry = Number.isInteger(index) && index >= 1 ? this.#whoList()[index - 1] : undefined;
    if (!entry) return undefined;
    // L3-review: Wow.exe 0x6b4a80 names race and class by the row's sex byte (0x715970/0x7159e0).
    const female = femaleOf(entry.gender);
    const classInfo = this.#context.classInfo?.(entry.classId, female);
    return [entry.name, entry.guild, entry.level, this.#context.raceName?.(entry.race, female) ?? "",
      classInfo?.[0] ?? "", this.#whoZone(entry), classInfo?.[1]];
  }

  /** `SortWho(type)`: the client sorts its held answer; the same column twice reverses it. */
  sortWho(type: string): void {
    if (!WHO_SORT_KEYS.has(type)) return;
    const key = type as WhoSortKey;
    this.#whoDescending = key === this.#whoSort ? !this.#whoDescending : false;
    this.#whoSort = key;
    this.#whoRows = undefined;
    if (this.#context.world()?.whoResult) this.#pump?.fire("WHO_LIST_UPDATE");
  }

  // ---- events ------------------------------------------------------------------------------

  #listSignature(flag: number): string {
    const contacts = this.#context.world()?.contacts?.contacts ?? [];
    return contacts.filter((contact) => (contact.flags & flag) !== 0)
      .map((contact) => `${contact.guid}:${contact.status}:${contact.areaId}:${contact.level}:${contact.classId}:${contact.note}`)
      .join("|");
  }

  /**
   * SMSG_CONTACT_LIST and SMSG_FRIEND_STATUS both land as CONTACTS_CHANGED with no payload. A list
   * packet replaces `contacts` and is always announced — it is the answer to ShowFriends(), and
   * FriendsList_Update skips its rows until FriendsListFrame is shown (FriendsFrame.lua:352), which
   * FriendsFrame_OnShow does only after asking. A status packet is folded into the held list
   * (`WorldClient.#applyFriendStatus`), so the friend and ignore halves are compared separately and
   * an ignore change does not repaint friends.
   */
  #contactsChanged(): void {
    const pump = this.#pump;
    if (!pump) return;
    const list = this.#context.world()?.contacts;
    const replaced = list !== this.#contactsSeen;
    this.#contactsSeen = list;
    const friends = this.#listSignature(SOCIAL_FLAG_FRIEND);
    const ignores = this.#listSignature(SOCIAL_FLAG_IGNORED);
    if (replaced) {
      this.#friendSignature = friends;
      this.#ignoreSignature = ignores;
      pump.fire("FRIENDLIST_UPDATE");
      pump.fire("IGNORELIST_UPDATE");
      return;
    }
    if (friends !== this.#friendSignature) {
      this.#friendSignature = friends;
      pump.fire("FRIENDLIST_UPDATE");
    }
    if (ignores !== this.#ignoreSignature) {
      this.#ignoreSignature = ignores;
      pump.fire("IGNORELIST_UPDATE");
    }
  }

  /**
   * SMSG_WHO replaces `whoResult`; SMSG_WHOIS rides the same bus event with the list untouched and is
   * ignored here. With the Who tab open (`SetWhoToUI(1)`) or a long answer the stock tab takes it;
   * a short answer to a closed tab goes to chat, one CHAT_MSG_SYSTEM line per row and a total, in
   * the stock `WHO_LIST_FORMAT`/`WHO_LIST_GUILD_FORMAT`/`WHO_NUM_RESULTS` words (the prelude's
   * `WebClientWhoChatLines` formats them in the running locale).
   */
  #whoChanged(): void {
    const pump = this.#pump;
    const result = this.#context.world()?.whoResult;
    if (!pump || !result || result === this.#whoSeen) return;
    this.#whoSeen = result;
    this.#whoRows = undefined;
    if (!this.owned) return;
    if (this.#whoToUi || result.entries.length > FRAMEXML_WHO_CHAT_ROWS) {
      pump.fire("WHO_LIST_UPDATE");
      return;
    }
    pump.fire("WEBCLIENT_WHO_TO_CHAT");
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlFriendsHost {
  readonly friends?: FrameXmlFriendsModel | undefined;
}

export type FrameXmlFriendsBinding = (host: FrameXmlFriendsHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

/** An index when the argument is numeric (stock passes both `3` and `"3"`), else the name. */
function indexOrName(value: unknown): unknown {
  const index = integerArg(value);
  return index !== undefined ? index : value;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

const withFriends = (answer: (friends: FrameXmlFriendsModel, args: readonly unknown[]) => readonly unknown[] | undefined): FrameXmlFriendsBinding =>
  (host, args) => (host.friends ? answer(host.friends, args) : undefined) ?? NOTHING;

const command = (run: (friends: FrameXmlFriendsModel, args: readonly unknown[]) => void): FrameXmlFriendsBinding =>
  withFriends((friends, args) => { run(friends, args); return NOTHING; });

/**
 * Battle.net's C API on a realm without Battle.net: the counts are zero, the lookups nil and the
 * commands do nothing. `BNFeaturesEnabled` false is the stock branch that hides the Battle.net UI.
 * Names the FrameXML corpus (FriendsFrame, UnitPopup, StaticPopup, ChatFrame) calls: 48.
 */
const BATTLE_NET_NEUTRAL: Readonly<Record<string, FrameXmlFriendsBinding>> = Object.freeze({
  BNFeaturesEnabled: () => [false],
  BNFeaturesEnabledAndConnected: () => [false],
  BNConnected: () => [false],
  BNGetNumFriends: () => [0, 0],
  BNGetNumFriendInvites: () => [0],
  BNGetNumBlocked: () => [0],
  BNGetNumBlockedToons: () => [0],
  BNGetNumFOF: () => [0],
  BNGetNumFriendToons: () => [0],
  BNGetSelectedFriend: () => [0],
  BNGetSelectedBlock: () => [0],
  BNGetSelectedToonBlock: () => [0],
  BNGetInfo: () => NOTHING,
  BNGetFriendInfo: () => NOTHING,
  BNGetFriendInfoByID: () => NOTHING,
  BNGetFriendToonInfo: () => NOTHING,
  BNGetToonInfo: () => NOTHING,
  BNGetFOFInfo: () => NOTHING,
  BNGetBlockedInfo: () => NOTHING,
  BNGetBlockedToonInfo: () => NOTHING,
  BNGetFriendInviteInfo: () => NOTHING,
  BNGetMaxPlayersInConversation: () => [0],
  BNGetNumConversationMembers: () => [0],
  BNGetConversationInfo: () => NOTHING,
  BNGetConversationMemberInfo: () => NOTHING,
  BNIsSelf: () => [false],
  BNIsFriend: () => [false],
  BNIsBlocked: () => [false],
  BNIsToonBlocked: () => [false],
  BNRequestFOFInfo: () => NOTHING,
  BNSendFriendInvite: () => NOTHING,
  BNSendFriendInviteByID: () => NOTHING,
  BNAcceptFriendInvite: () => NOTHING,
  BNDeclineFriendInvite: () => NOTHING,
  BNRemoveFriend: () => NOTHING,
  BNSetBlocked: () => NOTHING,
  BNSetToonBlocked: () => NOTHING,
  BNSetCustomMessage: () => NOTHING,
  BNSetSelectedBlock: () => NOTHING,
  BNSetSelectedFriend: () => NOTHING,
  BNSetSelectedToonBlock: () => NOTHING,
  BNSetFriendNote: () => NOTHING,
  BNSetAFK: () => NOTHING,
  BNSetDND: () => NOTHING,
  BNSetFocus: () => NOTHING,
  BNReportPlayer: () => NOTHING,
  BNReportFriendInvite: () => NOTHING,
  SynchronizeBNetStatus: () => NOTHING,
});

function adapt<Model>(
  calls: Readonly<Record<string, (model: Model, args: readonly unknown[]) => readonly unknown[] | undefined>>,
  select: (friends: FrameXmlFriendsModel) => Model,
): Record<string, FrameXmlFriendsBinding> {
  return Object.fromEntries(Object.entries(calls).map(([name, call]) =>
    [name, withFriends((friends, args) => call(select(friends), args))]));
}

/**
 * The flat C API. Names here are installed into `__fxNeutralImpl` like every seam name, so they also
 * replace F2's neutral answers (`GetNumFriends`, `BNGetNumFriends`, `IsInGuild`, `GetRaidRosterInfo`).
 * `WebClient*` are the flat accessors the Lua prelude below turns into stock-shaped answers.
 */
export const FRAMEXML_FRIENDS_BINDINGS: Readonly<Record<string, FrameXmlFriendsBinding>> = Object.freeze({
  ...BATTLE_NET_NEUTRAL,
  ShowFriends: command((friends) => friends.showFriends()),
  GetNumFriends: withFriends((friends) => friends.numFriends()),
  WebClientFriendInfo: withFriends((friends, args) => friends.friendInfo(indexOrName(args[0]))),
  GetSelectedFriend: withFriends((friends) => [friends.selectedFriend()]),
  SetSelectedFriend: command((friends, args) => friends.selectFriend(integerArg(args[0]) ?? 0)),
  SetFriendNotes: command((friends, args) =>
    friends.setFriendNote(indexOrName(args[0]), typeof args[1] === "string" ? args[1] : "")),
  // Recruit-a-Friend summoning is not modelled: no friend is linked, so the summon button stays hidden.
  IsReferAFriendLinked: () => [false],
  CanSummonFriend: () => [false],
  GetSummonFriendCooldown: () => [0, 0],
  SummonFriend: () => NOTHING,
  GetNumIgnores: withFriends((friends) => [friends.numIgnores()]),
  GetIgnoreName: withFriends((friends, args) => optional(friends.ignoreName(integerArg(args[0]) ?? 0))),
  GetSelectedIgnore: withFriends((friends) => [friends.selectedIgnore()]),
  SetSelectedIgnore: command((friends, args) => friends.selectIgnore(integerArg(args[0]) ?? 0)),
  // Voice chat is off (`IsVoiceChatEnabled` false), so the mute list is empty and never shown.
  GetNumMutes: () => [0],
  GetMuteName: () => NOTHING,
  GetSelectedMute: () => [0],
  SetSelectedMute: () => NOTHING,
  IsMuted: () => [false],
  GetNumWhoResults: withFriends((friends) => friends.numWhoResults()),
  GetWhoInfo: withFriends((friends, args) => friends.whoInfo(integerArg(args[0]) ?? 0)),
  SetWhoToUI: command((friends, args) => friends.setWhoToUi(truthy(args[0]))),
  SortWho: command((friends, args) => friends.sortWho(typeof args[0] === "string" ? args[0] : "")),
  ...adapt(FRAMEXML_GUILD_CALLS, (friends) => friends.guild),
  ...adapt(FRAMEXML_RAID_CALLS, (friends) => friends.raid),
  ...adapt(FRAMEXML_CHANNELS_CALLS, (friends) => friends.channels),
});

/**
 * The Lua half, appended to FRAMEXML_SEAM_PRELUDE: the stock-shaped answers the flat accessors
 * cannot give from JS because they are locale strings (`CHAT_FLAG_AFK`, `RAID_DIFFICULTYn`), or a
 * table the caller passes in (`BNGetCustomMessageTable(t)` returns `t` and the two broadcast counts).
 * `WebClientWhoChatLines` formats a short `/who` answer the way the client prints it to chat.
 */
export const FRAMEXML_FRIENDS_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local friendInfo = rawget(_G, "__fxSeam_WebClientFriendInfo")
  local rosterInfo = rawget(_G, "__fxSeam_WebClientGuildRosterInfo")
  local savedInstanceInfo = rawget(_G, "__fxSeam_WebClientSavedInstanceInfo")
  if impl ~= nil and friendInfo ~= nil and rosterInfo ~= nil and savedInstanceInfo ~= nil then
    local function status(code)
      if code == 1 then return CHAT_FLAG_AFK or "<AFK>" end
      if code == 2 then return CHAT_FLAG_DND or "<DND>" end
      return ""
    end
    impl.GetFriendInfo = function(key)
      local name, level, class, area, connected, code, note = friendInfo(key)
      if name == nil then return nil end
      return name, level, class, area, connected, status(code), note
    end
    impl.GetGuildRosterInfo = function(index)
      local name, rank, rankIndex, level, class, zone, note, officernote, online, code, classFileName = rosterInfo(index)
      if name == nil then return nil end
      return name, rank, rankIndex, level, class, zone, note, officernote, online, status(code), classFileName
    end
    impl.GetSavedInstanceInfo = function(index)
      local name, id, reset, difficulty, locked, extended, mostSig, isRaid, maxPlayers = savedInstanceInfo(index)
      if name == nil then return nil end
      local label = isRaid and _G["RAID_DIFFICULTY" .. (difficulty + 1)] or _G["DUNGEON_DIFFICULTY" .. (difficulty + 1)]
      return name, id, reset, difficulty, locked, extended, mostSig, isRaid, maxPlayers, label or ""
    end
    impl.BNGetCustomMessageTable = function(t)
      if type(t) == "table" then for key in pairs(t) do t[key] = nil end else t = {} end
      return t, 0, 0
    end
    -- A plain global, not an impl entry: no corpus file calls it, so the census never lists it.
    -- Read by the owner's WEBCLIENT_WHO_TO_CHAT handler (FrameXmlFriendsOwner.ts).
    WebClientWhoChatLines = function()
      local lines = {}
      local shown, total = GetNumWhoResults()
      for index = 1, shown or 0 do
        local name, guild, level, race, class, zone = GetWhoInfo(index)
        if name then
          if guild and guild ~= "" then
            lines[#lines + 1] = format(WHO_LIST_GUILD_FORMAT, name, name, level, race, class, guild, zone)
          else
            lines[#lines + 1] = format(WHO_LIST_FORMAT, name, name, level, race, class, zone)
          end
        end
      end
      lines[#lines + 1] = format(WHO_NUM_RESULTS, total or 0)
      return lines
    end
  end
end
`;
