/**
 * The guild half of the stock FriendsFrame (tab 3): GuildFrame's roster, GuildMemberDetailFrame,
 * GuildInfoFrame, GuildEventLogFrame and the GuildControlPopupFrame rank editor, over this client's
 * `guild*` packet state. The FriendsFrame model (FrameXmlFriends.ts) owns one of these and adapts
 * {@link FRAMEXML_GUILD_CALLS} into seam bindings.
 *
 * What the stock Lua expects, measured against 3.3.5's FriendsFrame.lua:
 *
 * * `GetGuildRosterInfo(i)` walks a *client-sorted, client-filtered* list: `SortGuildRoster(type)`
 *   and the «show offline» checkbox (`SetGuildRosterShowOffline`) reorder and shrink what index `i`
 *   means, and `Set/GetGuildRosterSelection` is an index into that same list. The server sends one
 *   unordered roster (`SMSG_GUILD_ROSTER`, TrinityCore `Guild::HandleRoster`), so the sort, the
 *   filter and the selection live here; the selection follows its member's GUID across re-sorts.
 * * `GUILD_ROSTER_UPDATE`'s arg1 means «the roster changed, ask again» (FriendsFrame.lua:1233). A
 *   roster *packet* is the answer, so it is announced with arg1 nil; asking again on it would loop.
 * * Rank rights are TrinityCore's `GR_RIGHT_*` words (GuildModel.ts). The rank editor's seventeen
 *   checkboxes are matched to those bits by what their `GUILDCONTROL_OPTIONn` labels say (read from
 *   the ruRU GlobalStrings.lua: 1-4 chat, 5 promote, 6 demote, 7 invite, 8 remove, 9 MOTD, 10-12
 *   notes, 13 guild info, 15 repair, 16 gold, 17 events; 14 has no checkbox — «deprecated flag»,
 *   FriendsFrame.lua:1789). Bits the editor does not show are kept as the roster sent them.
 * * The rank's daily gold is copper on the wire (`MSG_GUILD_PERMISSIONS` goldPerDay, TrinityCore
 *   `Guild::_GetMemberRemainingMoney` subtracts copper withdrawals from it); the editor's box is gold
 *   (`MAX_GOLD_WITHDRAW = 1000`), so the two convert by 10000 and «unlimited» (the guild master's
 *   0xFFFFFFFF) reads -1, which the stock popup maps to its own default (FriendsFrame.lua:1680-1685).
 */
import type { GuildEventLogEntry } from "../../world/GuildBankProtocol.js";
import type { GuildInfo, GuildMember, GuildQueryInfo, GuildRank, GuildRoster } from "../../world/GuildProtocol.js";
import {
  GR_RIGHT_DEMOTE, GR_RIGHT_EOFFNOTE, GR_RIGHT_EPNOTE, GR_RIGHT_GCHATLISTEN, GR_RIGHT_GCHATSPEAK,
  GR_RIGHT_INVITE, GR_RIGHT_MODIFY_GUILD_INFO, GR_RIGHT_OFFCHATLISTEN, GR_RIGHT_OFFCHATSPEAK,
  GR_RIGHT_PROMOTE, GR_RIGHT_REMOVE, GR_RIGHT_SETMOTD, GR_RIGHT_VIEWOFFNOTE, GR_RIGHT_WITHDRAW_GOLD,
  GR_RIGHT_WITHDRAW_GOLD_LOCK, GR_RIGHT_WITHDRAW_REPAIR, GR_RIGHT_CREATE_GUILDEVENT, GR_RIGHT_EMPTY,
} from "../ui/GuildModel.js";

/** `GR_GUILDMASTER` (Guild.h): rank 0 holds every right, whatever its stored word says. */
const GUILD_MASTER_RANK = 0;
/** `GUILDMEMBER_STATUS_*` (Guild.h): the roster's status byte. */
const MEMBER_STATUS_AFK = 0x02;
const MEMBER_STATUS_DND = 0x04;
/** `GUILD_BANK_RIGHT_*` (Guild.h): per-tab rights in a rank's six tab pairs. */
const BANK_RIGHT_VIEW_TAB = 0x01;
const BANK_RIGHT_PUT_ITEM = 0x02;
const BANK_RIGHT_UPDATE_TEXT = 0x04;
/** `GUILD_BANK_MAX_TABS` (Guild.h). */
const BANK_MAX_TABS = 6;
/** `GUILD_WITHDRAW_MONEY_UNLIMITED` (Guild.h) as the roster's u32 carries it. */
const WITHDRAW_UNLIMITED = 0xffffffff;
const COPPER_PER_GOLD = 10000;
/**
 * GuildRoster() is re-asked by the stock Lua on several edges (AnimTimerFrame's 15 s login timer,
 * MailFrame's autocomplete, GuildInfoSaveButton, GuildControlPopupFrame's «update» dance). One
 * request is kept in flight until its roster packet lands; after this long a lost answer no longer
 * blocks the next ask. Client-side guard, not a server rule.
 */
const ROSTER_REQUEST_RETRY_MS = 10_000;

/**
 * The seventeen `GuildControlPopupFrameCheckboxN` rights, in checkbox order (see the module doc).
 * Index 13 (checkbox 14) has no widget in 3.3.5; it reports the gold-lock bit so a round trip keeps it.
 */
export const FRAMEXML_GUILD_CONTROL_RIGHTS: readonly number[] = Object.freeze([
  GR_RIGHT_GCHATLISTEN, GR_RIGHT_GCHATSPEAK, GR_RIGHT_OFFCHATLISTEN, GR_RIGHT_OFFCHATSPEAK,
  GR_RIGHT_PROMOTE, GR_RIGHT_DEMOTE, GR_RIGHT_INVITE, GR_RIGHT_REMOVE,
  GR_RIGHT_SETMOTD, GR_RIGHT_EPNOTE, GR_RIGHT_VIEWOFFNOTE, GR_RIGHT_EOFFNOTE,
  GR_RIGHT_MODIFY_GUILD_INFO, GR_RIGHT_WITHDRAW_GOLD_LOCK, GR_RIGHT_WITHDRAW_REPAIR, GR_RIGHT_WITHDRAW_GOLD,
  GR_RIGHT_CREATE_GUILDEVENT,
]);

/** The bit a right adds beyond `GR_RIGHT_EMPTY` — `GR_RIGHT_PROMOTE` is EMPTY|0x80, for example. */
function ownBits(right: number): number {
  return (right & ~GR_RIGHT_EMPTY) || right;
}

/** `GUILDEVENT_TYPE_*`'s stock keys by TrinityCore `GuildEventLogTypes` (Guild.h, 1-6). */
const EVENT_TYPES: Readonly<Record<number, string>> = {
  1: "invite", 2: "join", 3: "promote", 4: "demote", 5: "remove", 6: "quit",
};

/** The world facts and commands the guild model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlGuildWorld {
  readonly guildRoster?: GuildRoster | undefined;
  readonly guildQuery?: GuildQueryInfo | undefined;
  readonly guildInfo?: GuildInfo | undefined;
  readonly guildEventLog?: readonly GuildEventLogEntry[] | undefined;
  /** `MSG_GUILD_PERMISSIONS`, only after a guild vault was opened; its tab count feeds the editor. */
  readonly guildPermissions?: { readonly purchasedTabs: number } | undefined;
  readonly guildBank?: { readonly tabs: readonly { readonly name: string; readonly icon: string }[] } | undefined;
  displayName(guid: bigint): string;
  requestName?(guid: bigint): void;
  requestGuildRoster(): void;
  requestGuildEventLog(): void;
  setGuildMemberNote(name: string, note: string, officer?: boolean): void;
  setGuildInfoText(text: string): void;
  setGuildRank(rankId: number, flags: number, name: string, withdrawGoldLimit: number,
    tabs: ReadonlyArray<{ rights: number; slots: number }>): void;
  addGuildRank(name: string): void;
  removeLowestGuildRank(): void;
}

/** What the guild model asks its host besides the world. */
export interface FrameXmlGuildContext {
  world(): FrameXmlGuildWorld | undefined;
  /** `PLAYER_GUILDID`/`PLAYER_GUILDRANK` of a unit's object; they are PUBLIC update fields. */
  unitGuild?(unit: string): { readonly guildId: number; readonly rankId: number } | undefined;
  playerGuid(): bigint | undefined;
  areaName?(areaId: number): string | undefined;
  classInfo?(classId: number): readonly [name: string, token: string] | undefined;
  /** Monotonic milliseconds, for the roster request guard. */
  monotonic?(): number;
}

interface GuildPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

type SortKey = "name" | "rank" | "note" | "online" | "zone" | "level" | "class";
const SORT_KEYS: ReadonlySet<string> = new Set(["name", "rank", "note", "online", "zone", "level", "class"]);

/** The rank the editor is changing, as the stock popup's pending state holds it. */
interface ControlRank {
  readonly rankId: number;
  flags: number;
  withdrawGoldLimit: number;
  tabs: { rights: number; slots: number }[];
}

export class FrameXmlGuildModel {
  readonly #context: FrameXmlGuildContext;
  #pump: GuildPump | undefined;
  #muted = false;
  #showOffline = true;
  #sortKey: SortKey = "name";
  #sortDescending = false;
  #selectedGuid: bigint | undefined;
  #requestedAt: number | undefined;
  #control: ControlRank | undefined;
  #rosterSeen: GuildRoster | undefined;
  #querySeen: GuildQueryInfo | undefined;
  #logSeen: readonly GuildEventLogEntry[] | undefined;
  #motdSeen: string | undefined;
  #guildSeen = "";
  #list: { roster: GuildRoster; key: string; members: readonly GuildMember[] } | undefined;

  constructor(context: FrameXmlGuildContext) {
    this.#context = context;
  }

  attach(pump: GuildPump): void {
    this.#pump = pump;
    const world = this.#context.world();
    // What the world holds at attach is the corpus' starting state, not a change to announce.
    this.#rosterSeen = this.#roster();
    this.#querySeen = world?.guildQuery;
    this.#logSeen = this.#eventLog();
    this.#motdSeen = this.#rosterSeen?.welcomeText;
    this.#guildSeen = this.#membershipSignature();
  }

  detach(): void {
    this.#pump = undefined;
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #command(run: (world: FrameXmlGuildWorld) => void): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (world) run(world);
  }

  // ---- membership --------------------------------------------------------------------------

  #playerGuild(): { readonly guildId: number; readonly rankId: number } | undefined {
    const fields = this.#context.unitGuild?.("player");
    // The player's own PLAYER_GUILDID decides whenever its object is there: 0 is «in no guild», even
    // though WorldClient keeps the last SMSG_GUILD_ROSTER it got after /gquit or a kick.
    if (fields) return fields.guildId > 0 ? fields : undefined;
    // Without the player object (not created yet, or a seam double) the roster naming it is membership.
    const world = this.#context.world();
    const self = this.#context.playerGuid();
    const member = self === undefined ? undefined : world?.guildRoster?.members.find((row) => row.guid === self);
    return member ? { guildId: world?.guildQuery?.guildId ?? 1, rankId: member.rankId } : undefined;
  }

  #membershipSignature(): string {
    const guild = this.#playerGuild();
    const name = this.#guildName();
    return guild ? `${guild.guildId}|${guild.rankId}|${name ?? ""}` : "";
  }

  isInGuild(): boolean { return this.#playerGuild() !== undefined; }

  /** The held roster, but only while the player is in a guild: a left guild's roster lists nobody. */
  #roster(): GuildRoster | undefined {
    return this.isInGuild() ? this.#context.world()?.guildRoster : undefined;
  }

  /** The held event log, on the same terms as {@link #roster}. */
  #eventLog(): readonly GuildEventLogEntry[] | undefined {
    return this.isInGuild() ? this.#context.world()?.guildEventLog : undefined;
  }

  #guildName(): string | undefined {
    const guild = this.#playerGuild();
    const query = this.#context.world()?.guildQuery;
    if (!guild || !query) return undefined;
    // SMSG_GUILD_QUERY_RESPONSE also answers queries about other guilds; only the player's names it.
    return query.guildId === guild.guildId || this.#context.unitGuild?.("player") === undefined
      ? query.name : undefined;
  }

  rankName(rankId: number): string {
    const name = this.#context.world()?.guildQuery?.rankNames[rankId];
    return name ?? "";
  }

  /**
   * `GetGuildInfo(unit)`: guild name, rank name, rank index. The client knows the name of its own
   * guild only (one `guildQuery` slot), so another unit answers when it shares the player's guild.
   */
  guildInfo(unit: string): readonly [name: string, rankName: string, rankIndex: number] | undefined {
    const own = this.#playerGuild();
    if (!own) return undefined;
    const token = unit.trim().toLowerCase();
    const fields = token === "player" ? own : this.#context.unitGuild?.(token);
    if (!fields || fields.guildId <= 0 || fields.guildId !== own.guildId) return undefined;
    const name = this.#guildName();
    return name === undefined ? undefined : [name, this.rankName(fields.rankId), fields.rankId];
  }

  #rankFlags(): number {
    const guild = this.#playerGuild();
    if (!guild) return 0;
    if (guild.rankId === GUILD_MASTER_RANK) return 0xffffffff;
    return this.#context.world()?.guildRoster?.ranks[guild.rankId]?.flags ?? 0;
  }

  can(right: number): boolean {
    return (this.#rankFlags() & right) === right;
  }

  isLeader(): boolean { return this.#playerGuild()?.rankId === GUILD_MASTER_RANK; }

  motd(): string { return this.#roster()?.welcomeText ?? ""; }
  infoText(): string { return this.#roster()?.infoText ?? ""; }

  /** `GuildRoster()`: one request in flight until the roster packet answers it. */
  requestRoster(): void {
    if (this.#muted || !this.isInGuild()) return;
    const now = this.#context.monotonic?.() ?? Date.now();
    if (this.#requestedAt !== undefined && now - this.#requestedAt < ROSTER_REQUEST_RETRY_MS) return;
    const world = this.#context.world();
    if (!world) return;
    this.#requestedAt = now;
    world.requestGuildRoster();
  }

  // ---- the roster list ---------------------------------------------------------------------

  showOffline(): boolean { return this.#showOffline; }

  setShowOffline(show: boolean): void {
    if (show === this.#showOffline) return;
    const selected = this.#selectedGuid;
    this.#showOffline = show;
    this.#list = undefined;
    if (selected !== undefined && !this.#members().some((member) => member.guid === selected)) this.#selectedGuid = undefined;
    this.#pump?.fire("GUILD_ROSTER_UPDATE");
  }

  /** `SortGuildRoster(type)`: the same column twice reverses it, as the stock headers expect. */
  sort(type: string): void {
    if (!SORT_KEYS.has(type)) return;
    const key = type as SortKey;
    this.#sortDescending = key === this.#sortKey ? !this.#sortDescending : false;
    this.#sortKey = key;
    this.#list = undefined;
    this.#pump?.fire("GUILD_ROSTER_UPDATE");
  }

  #zone(member: GuildMember): string {
    return this.#context.areaName?.(member.areaId) ?? "";
  }

  #className(member: GuildMember): string {
    return this.#context.classInfo?.(member.classId)?.[0] ?? "";
  }

  #members(): readonly GuildMember[] {
    const roster = this.#roster();
    if (!roster) return [];
    const key = `${this.#showOffline}|${this.#sortKey}|${this.#sortDescending}`;
    if (this.#list?.roster === roster && this.#list.key === key) return this.#list.members;
    const visible = roster.members.filter((member) => this.#showOffline || member.online);
    const byName = (left: GuildMember, right: GuildMember): number => left.name.localeCompare(right.name, "ru");
    const compare: Record<SortKey, (left: GuildMember, right: GuildMember) => number> = {
      name: byName,
      rank: (left, right) => left.rankId - right.rankId,
      note: (left, right) => left.note.localeCompare(right.note, "ru"),
      online: (left, right) => Number(right.online) - Number(left.online) || left.lastSaveDays - right.lastSaveDays,
      zone: (left, right) => this.#zone(left).localeCompare(this.#zone(right), "ru"),
      level: (left, right) => left.level - right.level,
      class: (left, right) => this.#className(left).localeCompare(this.#className(right), "ru"),
    };
    const primary = compare[this.#sortKey];
    const direction = this.#sortDescending ? -1 : 1;
    const members = [...visible].sort((left, right) => direction * primary(left, right) || byName(left, right));
    this.#list = { roster, key, members };
    return members;
  }

  numMembers(includeOffline: boolean): number {
    const roster = this.#roster();
    if (!roster) return 0;
    return includeOffline ? roster.members.length : this.#members().length;
  }

  #member(index: number): GuildMember | undefined {
    return Number.isInteger(index) && index >= 1 ? this.#members()[index - 1] : undefined;
  }

  /**
   * `GetGuildRosterInfo(i)`'s eleven values: name, rank, rankIndex, level, class, zone, note,
   * officernote, online, status, classFileName. `status` is the roster's AFK/DND bits as a number;
   * the Lua prelude turns it into `CHAT_FLAG_AFK`/`CHAT_FLAG_DND` so the string follows the locale.
   */
  rosterInfo(index: number): readonly unknown[] | undefined {
    const member = this.#member(index);
    if (!member) return undefined;
    const classInfo = this.#context.classInfo?.(member.classId);
    const status = (member.status & MEMBER_STATUS_AFK) !== 0 ? 1 : (member.status & MEMBER_STATUS_DND) !== 0 ? 2 : 0;
    return [
      member.name, this.rankName(member.rankId), member.rankId, member.level, classInfo?.[0] ?? "",
      this.#zone(member), member.note, member.officerNote, member.online, status, classInfo?.[1],
    ];
  }

  /**
   * `GetGuildRosterLastOnline(i)`: years, months, days, hours since the member logged out. The
   * roster carries it as float days (`Guild::Member::WritePacket`, `(now - logout) / DAY`).
   */
  lastOnline(index: number): readonly [number, number, number, number] | undefined {
    const member = this.#member(index);
    if (!member || member.online) return undefined;
    let days = Math.max(0, member.lastSaveDays);
    const years = Math.floor(days / 365);
    days -= years * 365;
    const months = Math.floor(days / 30);
    days -= months * 30;
    const wholeDays = Math.floor(days);
    const hours = Math.floor((days - wholeDays) * 24);
    return [years, months, wholeDays, hours];
  }

  selection(): number {
    const guid = this.#selectedGuid;
    if (guid === undefined) return 0;
    const index = this.#members().findIndex((member) => member.guid === guid);
    return index < 0 ? 0 : index + 1;
  }

  select(index: number): void {
    this.#selectedGuid = this.#member(index)?.guid;
  }

  setNote(index: number, note: string, officer: boolean): void {
    const member = this.#member(index);
    if (!member) return;
    this.#command((world) => world.setGuildMemberNote(member.name, note.slice(0, 31), officer));
  }

  setInfoText(text: string): void {
    this.#command((world) => world.setGuildInfoText(text.slice(0, 500)));
  }

  // ---- the event log -----------------------------------------------------------------------

  queryEventLog(): void { this.#command((world) => world.requestGuildEventLog()); }

  numEvents(): number { return this.#eventLog()?.length ?? 0; }

  #nameOf(guid: bigint): string | undefined {
    if (guid === 0n) return undefined;
    const world = this.#context.world();
    const name = world?.displayName(guid);
    if (!name || name.startsWith("0x")) {
      world?.requestName?.(guid);
      return undefined;
    }
    return name;
  }

  /**
   * `GetGuildEventInfo(i)`: type, player1, player2, rank, and the time since it happened as years,
   * months, days, hours (stock formats them with RecentTimeDate). Entries are in wire order —
   * TrinityCore's LogHolder appends, so 1 is the oldest and stock walks from the last one down.
   */
  eventInfo(index: number): readonly unknown[] | undefined {
    const entry = Number.isInteger(index) && index >= 1 ? this.#eventLog()?.[index - 1] : undefined;
    if (!entry) return undefined;
    const type = EVENT_TYPES[entry.type];
    if (!type) return undefined;
    let seconds = Math.max(0, entry.secondsAgo);
    const hour = 3600;
    const day = 24 * hour;
    const years = Math.floor(seconds / (365 * day));
    seconds -= years * 365 * day;
    const months = Math.floor(seconds / (30 * day));
    seconds -= months * 30 * day;
    const days = Math.floor(seconds / day);
    seconds -= days * day;
    const hours = Math.floor(seconds / hour);
    const rank = entry.type === 3 || entry.type === 4 ? this.rankName(entry.rankId) : undefined;
    return [type, this.#nameOf(entry.playerGuid), this.#nameOf(entry.otherGuid), rank, years, months, days, hours];
  }

  // ---- the rank editor ---------------------------------------------------------------------

  numRanks(): number {
    const world = this.#context.world();
    return this.#roster()?.ranks.length ?? (this.isInGuild() ? world?.guildQuery?.rankCount : undefined) ?? 0;
  }

  /** `GuildControlGetRankName(i)`, 1-based: rank 1 is the guild master. */
  controlRankName(index: number): string {
    return Number.isInteger(index) && index >= 1 ? this.rankName(index - 1) : "";
  }

  /** `GuildControlSetRank(i)`: the rank the popup edits; its pending state starts from the roster. */
  setControlRank(index: number): void {
    const rankId = Number.isInteger(index) ? index - 1 : -1;
    const rank: GuildRank | undefined = this.#roster()?.ranks[rankId];
    this.#control = rank ? {
      rankId,
      flags: rank.flags,
      withdrawGoldLimit: rank.withdrawGoldLimit,
      tabs: Array.from({ length: BANK_MAX_TABS }, (_, tab) => ({
        rights: rank.tabs[tab]?.rights ?? 0, slots: rank.tabs[tab]?.slots ?? 0,
      })),
    } : undefined;
  }

  #controlRank(): ControlRank | undefined {
    if (!this.#control) this.setControlRank(1);
    return this.#control;
  }

  /** `GuildControlGetRankFlags()`: seventeen booleans in checkbox order. */
  controlRankFlags(): boolean[] {
    const control = this.#controlRank();
    const flags = control?.rankId === GUILD_MASTER_RANK ? 0xffffffff : control?.flags ?? 0;
    return FRAMEXML_GUILD_CONTROL_RIGHTS.map((right) => (flags & ownBits(right)) !== 0);
  }

  setControlRankFlag(index: number, enabled: boolean): void {
    const control = this.#controlRank();
    const right = FRAMEXML_GUILD_CONTROL_RIGHTS[index - 1];
    if (!control || right === undefined) return;
    // A granted right always carries GR_RIGHT_EMPTY, as every stored rank word does.
    control.flags = enabled ? control.flags | right : (control.flags & ~ownBits(right)) | GR_RIGHT_EMPTY;
  }

  /** `GetGuildBankWithdrawLimit()` in gold; -1 is the guild master's unlimited allowance. */
  withdrawLimit(): number {
    const control = this.#controlRank();
    if (!control) return 0;
    const copper = control.withdrawGoldLimit >>> 0;
    return copper === WITHDRAW_UNLIMITED || control.rankId === GUILD_MASTER_RANK ? -1 : Math.floor(copper / COPPER_PER_GOLD);
  }

  setWithdrawLimit(gold: number): void {
    const control = this.#controlRank();
    if (!control || !Number.isFinite(gold) || gold < 0) return;
    control.withdrawGoldLimit = Math.min(WITHDRAW_UNLIMITED - 1, Math.floor(gold) * COPPER_PER_GOLD);
  }

  /** Purchased vault tabs, known once the vault answered `MSG_GUILD_PERMISSIONS`; 0 otherwise. */
  numBankTabs(): number {
    const world = this.#context.world();
    return Math.min(BANK_MAX_TABS, world?.guildPermissions?.purchasedTabs ?? world?.guildBank?.tabs.length ?? 0);
  }

  bankTabName(tab: number): readonly [name: string, icon: string] | undefined {
    const info = Number.isInteger(tab) && tab >= 1 ? this.#context.world()?.guildBank?.tabs[tab - 1] : undefined;
    return info ? [info.name, info.icon] : undefined;
  }

  /** `GetGuildBankTabPermissions(tab)`: viewTab, canDeposit, canUpdateText, numWithdrawals. */
  bankTabPermissions(tab: number): readonly [boolean, boolean, boolean, number] | undefined {
    const entry = Number.isInteger(tab) && tab >= 1 ? this.#controlRank()?.tabs[tab - 1] : undefined;
    if (!entry) return undefined;
    return [(entry.rights & BANK_RIGHT_VIEW_TAB) !== 0, (entry.rights & BANK_RIGHT_PUT_ITEM) !== 0,
      (entry.rights & BANK_RIGHT_UPDATE_TEXT) !== 0, entry.slots];
  }

  /**
   * `SetGuildBankTabPermissions(tab, id, checked)`: the three checkboxes carry ids 1-3 (view,
   * deposit, update text — FriendsFrame.xml GuildControlTabPermissions*), `GUILD_BANK_RIGHT_*` bits.
   */
  setBankTabPermission(tab: number, id: number, enabled: boolean): void {
    const entry = Number.isInteger(tab) && tab >= 1 ? this.#controlRank()?.tabs[tab - 1] : undefined;
    const bit = [BANK_RIGHT_VIEW_TAB, BANK_RIGHT_PUT_ITEM, BANK_RIGHT_UPDATE_TEXT][id - 1];
    if (!entry || bit === undefined) return;
    entry.rights = enabled ? entry.rights | bit : entry.rights & ~bit;
  }

  setBankTabWithdraw(tab: number, slots: number): void {
    const entry = Number.isInteger(tab) && tab >= 1 ? this.#controlRank()?.tabs[tab - 1] : undefined;
    if (!entry || !Number.isFinite(slots) || slots < 0) return;
    entry.slots = Math.floor(slots);
  }

  /** `GuildControlSaveRank(name)`: CMSG_GUILD_RANK rewrites the whole row, tab pairs included. */
  saveControlRank(name: string): void {
    const control = this.#controlRank();
    const trimmed = name.trim();
    if (!control || !trimmed) return;
    const tabs = control.tabs.map((tab) => ({ ...tab }));
    this.#command((world) => world.setGuildRank(control.rankId, control.flags >>> 0, trimmed.slice(0, 15),
      control.withdrawGoldLimit >>> 0, tabs));
  }

  addRank(name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.#command((world) => world.addGuildRank(trimmed.slice(0, 15)));
  }

  /** TrinityCore's CMSG_GUILD_DEL_RANK names no rank: the lowest one goes, as stock only offers it. */
  removeRank(): void { this.#command((world) => world.removeLowestGuildRank()); }

  // ---- events ------------------------------------------------------------------------------

  /**
   * The 60 ms poll's guild half. `WorldClient` reports guild packets through one `onGuildChanged`
   * slot the native window owns; every packet replaces its field, so an identity change is exactly
   * «that packet arrived». Roster → GUILD_ROSTER_UPDATE (arg1 nil) and, when its welcome text
   * moved, GUILD_MOTD; membership or name → PLAYER_GUILD_UPDATE; the log → GUILD_EVENT_LOG_UPDATE.
   * Roster and log are the membership-gated ones, so leaving the guild (PLAYER_GUILDID → 0 while
   * WorldClient still holds the old roster) is PLAYER_GUILD_UPDATE plus an emptied roster.
   */
  tick(): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump) return;
    const roster = this.#roster();
    const query = world?.guildQuery;
    const log = this.#eventLog();
    const membership = this.#membershipSignature();
    if (membership !== this.#guildSeen) {
      this.#guildSeen = membership;
      if (!membership) {
        this.#selectedGuid = undefined;
        this.#control = undefined;
      }
      pump.fire("PLAYER_GUILD_UPDATE", "player");
    }
    if (roster !== this.#rosterSeen || query !== this.#querySeen) {
      if (roster !== this.#rosterSeen) this.#requestedAt = undefined;
      this.#rosterSeen = roster;
      this.#querySeen = query;
      this.#list = undefined;
      if (this.#control && !roster?.ranks[this.#control.rankId]) this.#control = undefined;
      const motd = roster?.welcomeText;
      if (motd !== undefined && motd !== this.#motdSeen) pump.fire("GUILD_MOTD", motd);
      this.#motdSeen = motd;
      pump.fire("GUILD_ROSTER_UPDATE");
    }
    if (log !== this.#logSeen) {
      this.#logSeen = log;
      pump.fire("GUILD_EVENT_LOG_UPDATE");
    }
  }
}

/** One stock guild C-API name over the model; `undefined` answers nothing. */
export type FrameXmlGuildCall = (guild: FrameXmlGuildModel, args: readonly unknown[]) => readonly unknown[] | undefined;

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

const command = (run: (guild: FrameXmlGuildModel, args: readonly unknown[]) => void): FrameXmlGuildCall =>
  (guild, args) => { run(guild, args); return NOTHING; };

/**
 * The guild C API. Names FrameXmlChatApi registers after load — `GuildInvite`, `GuildUninvite`,
 * `GuildPromote`, `GuildDemote`, `GuildSetMOTD`, `GuildLeave`, `GuildInfo`, `GuildSetLeader` — are
 * deliberately absent: the stock frame calls them by name and they already reach the world there.
 * `GetGuildRosterInfo` is the flat `WebClientGuildRosterInfo` here; the prelude adds the status text.
 */
export const FRAMEXML_GUILD_CALLS: Readonly<Record<string, FrameXmlGuildCall>> = Object.freeze({
  IsInGuild: (guild) => [guild.isInGuild()],
  GetGuildInfo: (guild, args) => guild.guildInfo(text(args[0]) || "player"),
  GuildRoster: command((guild) => guild.requestRoster()),
  GetNumGuildMembers: (guild, args) => [guild.numMembers(truthy(args[0]))],
  WebClientGuildRosterInfo: (guild, args) => guild.rosterInfo(integerArg(args[0]) ?? 0),
  GetGuildRosterLastOnline: (guild, args) => guild.lastOnline(integerArg(args[0]) ?? 0),
  GetGuildRosterSelection: (guild) => [guild.selection()],
  SetGuildRosterSelection: command((guild, args) => guild.select(integerArg(args[0]) ?? 0)),
  GetGuildRosterShowOffline: (guild) => [guild.showOffline()],
  SetGuildRosterShowOffline: command((guild, args) => guild.setShowOffline(truthy(args[0]))),
  SortGuildRoster: command((guild, args) => guild.sort(text(args[0]))),
  GetGuildRosterMOTD: (guild) => [guild.motd()],
  GetGuildInfoText: (guild) => [guild.infoText()],
  SetGuildInfoText: command((guild, args) => guild.setInfoText(text(args[0]))),
  GuildRosterSetPublicNote: command((guild, args) => guild.setNote(integerArg(args[0]) ?? 0, text(args[1]), false)),
  GuildRosterSetOfficerNote: command((guild, args) => guild.setNote(integerArg(args[0]) ?? 0, text(args[1]), true)),
  IsGuildLeader: (guild) => [guild.isLeader()],
  CanGuildInvite: (guild) => [guild.can(GR_RIGHT_INVITE)],
  CanGuildRemove: (guild) => [guild.can(GR_RIGHT_REMOVE)],
  CanGuildPromote: (guild) => [guild.can(GR_RIGHT_PROMOTE)],
  CanGuildDemote: (guild) => [guild.can(GR_RIGHT_DEMOTE)],
  CanEditMOTD: (guild) => [guild.can(GR_RIGHT_SETMOTD)],
  CanEditPublicNote: (guild) => [guild.can(GR_RIGHT_EPNOTE)],
  CanViewOfficerNote: (guild) => [guild.can(GR_RIGHT_VIEWOFFNOTE)],
  CanEditOfficerNote: (guild) => [guild.can(GR_RIGHT_EOFFNOTE)],
  CanEditGuildInfo: (guild) => [guild.can(GR_RIGHT_MODIFY_GUILD_INFO)],
  QueryGuildEventLog: command((guild) => guild.queryEventLog()),
  GetNumGuildEvents: (guild) => [guild.numEvents()],
  GetGuildEventInfo: (guild, args) => guild.eventInfo(integerArg(args[0]) ?? 0),
  GuildControlGetNumRanks: (guild) => [guild.numRanks()],
  GuildControlGetRankName: (guild, args) => [guild.controlRankName(integerArg(args[0]) ?? 0)],
  GuildControlSetRank: command((guild, args) => guild.setControlRank(integerArg(args[0]) ?? 0)),
  GuildControlGetRankFlags: (guild) => guild.controlRankFlags(),
  GuildControlSetRankFlag: command((guild, args) =>
    guild.setControlRankFlag(integerArg(args[0]) ?? 0, truthy(args[1]))),
  GuildControlSaveRank: command((guild, args) => guild.saveControlRank(text(args[0]))),
  GuildControlAddRank: command((guild, args) => guild.addRank(text(args[0]))),
  GuildControlDelRank: command((guild) => guild.removeRank()),
  GetGuildBankWithdrawLimit: (guild) => [guild.withdrawLimit()],
  SetGuildBankWithdrawLimit: command((guild, args) => guild.setWithdrawLimit(Number(text(args[0])))),
  GetNumGuildBankTabs: (guild) => [guild.numBankTabs()],
  GetGuildBankTabInfo: (guild, args) => guild.bankTabName(integerArg(args[0]) ?? 0),
  GetGuildBankTabPermissions: (guild, args) => guild.bankTabPermissions(integerArg(args[0]) ?? 0),
  SetGuildBankTabPermissions: command((guild, args) =>
    guild.setBankTabPermission(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? 0, truthy(args[2]))),
  SetGuildBankTabWithdraw: command((guild, args) =>
    guild.setBankTabWithdraw(integerArg(args[0]) ?? 0, Number(text(args[1])))),
});
