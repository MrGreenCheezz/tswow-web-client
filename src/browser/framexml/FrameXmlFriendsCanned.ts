/**
 * The offline FriendsFrame: a scripted world with a friends list, an ignore list, a `/who` answer, a
 * guild with ranks, notes, a message of the day and an event log, three joined chat channels, the
 * canned party and two raid lockouts — for `CannedWorldSeam`, framexml.html's `?friends=` preview and the tests.
 *
 * Names, zones, races and classes are ruRU as this dataset's DBCs spell them (AreaTable, ChrRaces,
 * ChrClasses); ids are the tables' own. Commands only record, like the canned dungeon finder: a
 * test scripts the server's answer with the helpers below, which emit the same bus events and
 * replace the same fields `WorldClient` does.
 */
import { EventBus } from "../../world/EventBus.js";
import {
  FRIEND_STATUS_AFK, FRIEND_STATUS_DND, FRIEND_STATUS_OFFLINE, FRIEND_STATUS_ONLINE, SOCIAL_FLAG_FRIEND,
  SOCIAL_FLAG_IGNORED, type Contact, type ContactList, type WhoEntry, type WhoRequest, type WhoResult,
} from "../../world/ContactProtocol.js";
import type { GuildEventLogEntry } from "../../world/GuildBankProtocol.js";
import type { GuildMember, GuildQueryInfo, GuildRank, GuildRoster } from "../../world/GuildProtocol.js";
import type { GroupState } from "../../world/GroupProtocol.js";
import type { InstanceLockout } from "../../world/InstanceProtocol.js";
import { FrameXmlFriendsModel, type FrameXmlFriendsContext, type FrameXmlFriendsWorld } from "./FrameXmlFriends.js";

/** ChrClasses ruRU names and file tokens of the ten stock classes. */
export const FRAMEXML_CANNED_CLASSES: Readonly<Record<number, readonly [string, string]>> = Object.freeze({
  1: ["Воин", "WARRIOR"], 2: ["Паладин", "PALADIN"], 3: ["Охотник", "HUNTER"], 4: ["Разбойник", "ROGUE"],
  5: ["Жрец", "PRIEST"], 6: ["Рыцарь смерти", "DEATHKNIGHT"], 7: ["Шаман", "SHAMAN"], 8: ["Маг", "MAGE"],
  9: ["Чернокнижник", "WARLOCK"], 11: ["Друид", "DRUID"],
});

/** ChrRaces ruRU names (male) of the ten stock races. */
const RACES: Readonly<Record<number, string>> = {
  1: "Человек", 2: "Орк", 3: "Дворф", 4: "Ночной эльф", 5: "Нежить", 6: "Таурен", 7: "Гном",
  8: "Тролль", 10: "Эльф крови", 11: "Дреней",
};

/** AreaTable ruRU names of the zones the fixtures stand in. */
const ZONES: Readonly<Record<number, string>> = {
  12: "Элвиннский лес", 1519: "Штормград", 1537: "Стальгорн", 1657: "Дарнас", 38: "Лок Модан",
  40: "Западный Край", 10: "Сумеречный лес", 11: "Болотина", 44: "Красногорье", 3703: "Шаттрат",
  4395: "Даларан", 65: "Драконий Погост", 495: "Ревущий фьорд", 3537: "Борейская тундра",
};

/** Map rows the lockouts name: Map.dbc id, ruRU name, InstanceType (1 dungeon, 2 raid). */
const MAPS: Readonly<Record<number, { readonly name: string; readonly instanceType: number }>> = {
  533: { name: "Наксрамас", instanceType: 2 },
  615: { name: "Обсидиановое святилище", instanceType: 2 },
  574: { name: "Крепость Утгард", instanceType: 1 },
};

export const FRAMEXML_CANNED_GUILD_ID = 7;
const PLAYER_NAME = "Игрок";

/** `[guid, name, flags, status, zone, level, class, note]`. */
type ContactRow = readonly [guid: bigint, name: string, flags: number, status: number, zone: number,
  level: number, classId: number, note: string];

const CONTACTS: readonly ContactRow[] = [
  [0x101n, "Аэлинда", SOCIAL_FLAG_FRIEND, FRIEND_STATUS_ONLINE, 1519, 60, 8, "танк по пятницам"],
  [0x102n, "Бранд", SOCIAL_FLAG_FRIEND, FRIEND_STATUS_ONLINE | FRIEND_STATUS_AFK, 1537, 58, 3, ""],
  [0x103n, "Вэйлин", SOCIAL_FLAG_FRIEND, FRIEND_STATUS_ONLINE | FRIEND_STATUS_DND, 12, 42, 5, ""],
  [0x104n, "Гортан", SOCIAL_FLAG_FRIEND, FRIEND_STATUS_OFFLINE, 0, 0, 0, "алхимик"],
  [0x105n, "Дарэль", SOCIAL_FLAG_FRIEND, FRIEND_STATUS_OFFLINE, 0, 0, 0, ""],
  [0x201n, "Шумный", SOCIAL_FLAG_IGNORED, FRIEND_STATUS_OFFLINE, 0, 0, 0, ""],
  [0x202n, "Спамер", SOCIAL_FLAG_IGNORED, FRIEND_STATUS_OFFLINE, 0, 0, 0, ""],
];

/** `[name, guild, level, class, race, zone]` — an answer to `/who 55-60` in Elwynn's realm. */
type WhoRow = readonly [name: string, guild: string, level: number, classId: number, race: number, zone: number];
const WHO: readonly WhoRow[] = [
  ["Аэлинда", "Стражи Элвинна", 60, 8, 1, 1519], ["Бранд", "", 58, 3, 3, 1537],
  ["Эстер", "Серебряный рассвет", 60, 2, 1, 1519], ["Жорик", "", 57, 4, 7, 38],
  ["Зелана", "Орден Тирисфаля", 59, 11, 4, 1657], ["Ивор", "Стражи Элвинна", 55, 1, 3, 1537],
  ["Кэйра", "", 56, 5, 11, 44], ["Лиан", "Серебряный рассвет", 60, 9, 1, 10],
  ["Мирт", "", 55, 7, 11, 11], ["Нэлл", "Орден Тирисфаля", 58, 8, 7, 40],
  ["Орин", "", 60, 1, 1, 12], ["Прайм", "Стражи Элвинна", 59, 3, 4, 1657],
  ["Рита", "", 57, 5, 1, 1519], ["Сельва", "Орден Тирисфаля", 60, 11, 4, 1657],
  ["Тарк", "", 56, 4, 3, 1537], ["Ульм", "Серебряный рассвет", 58, 2, 3, 38],
  ["Фрея", "", 55, 9, 7, 40], ["Хельга", "Стражи Элвинна", 60, 1, 3, 1537],
  ["Цирра", "", 59, 8, 4, 10], ["Эрин", "", 57, 7, 11, 12],
];

/** `[guid, name, rank, level, class, zone, online status (0 offline, 1, 1|AFK…), days offline, note, officer note]`. */
type MemberRow = readonly [guid: bigint, name: string, rank: number, level: number, classId: number,
  zone: number, status: number, daysOffline: number, note: string, officerNote: string];
const MEMBERS: readonly MemberRow[] = [
  [0x42n, PLAYER_NAME, 0, 60, 1, 12, 1, 0, "глава", "основатель"],
  [0x101n, "Аэлинда", 1, 60, 8, 1519, 1, 0, "рейд-лидер", "ключи от Наксрамаса"],
  [0x301n, "Ивор", 2, 55, 1, 1537, 1, 0, "", ""],
  [0x302n, "Прайм", 2, 59, 3, 1657, 3, 0, "охотник рейда", ""],
  [0x303n, "Хельга", 3, 60, 1, 1537, 1, 0, "танк", "кандидат в офицеры"],
  [0x304n, "Лорн", 3, 44, 5, 44, 5, 0, "", ""],
  [0x305n, "Мира", 3, 38, 11, 40, 1, 0, "твинк", ""],
  [0x306n, "Нордан", 3, 60, 2, 0, 0, 0.4, "", ""],
  [0x307n, "Олли", 4, 23, 4, 0, 0, 2.5, "", "проверить активность"],
  [0x308n, "Пэнни", 4, 17, 9, 0, 0, 12.25, "", ""],
  [0x309n, "Рон", 3, 51, 7, 0, 0, 40, "фарм", ""],
  [0x30an, "Сая", 4, 30, 8, 12, 1, 0, "", ""],
  [0x30bn, "Тео", 3, 60, 6, 0, 0, 400, "ушёл в отпуск", ""],
  [0x30cn, "Уна", 4, 12, 3, 12, 1, 0, "", ""],
  [0x30dn, "Фин", 3, 47, 11, 11, 1, 0, "травник", ""],
];

/** Guild.h rank words: GM all, officer most, veteran/member chat + notes, recruit chat only. */
const RANKS: readonly GuildRank[] = [
  { flags: 0x001df1ff, withdrawGoldLimit: 0xffffffff, tabs: [] },
  { flags: 0x001df1ff & ~0x00010000, withdrawGoldLimit: 500 * 10000, tabs: [] },
  { flags: 0x00000043 | 0x00002040 | 0x00000050, withdrawGoldLimit: 50 * 10000, tabs: [] },
  { flags: 0x00000043, withdrawGoldLimit: 0, tabs: [] },
  { flags: 0x00000043, withdrawGoldLimit: 0, tabs: [] },
].map((rank, index) => ({
  ...rank,
  tabs: Array.from({ length: 6 }, (_, tab) => ({
    rights: tab === 0 ? (index <= 2 ? 0x07 : 0x01) : index === 0 ? 0xff : 0, slots: index <= 1 ? 100 : index === 2 ? 10 : 0,
  })),
}));

const RANK_NAMES = ["Глава гильдии", "Офицер", "Ветеран", "Участник", "Новобранец"];

/** A command the canned world received, in order; tests assert the wire-level intent. */
export type FrameXmlCannedSocialCall =
  | { readonly kind: "contacts" | "roster" | "eventLog" | "raidInfo" | "convertToRaid" }
  | { readonly kind: "friendNote"; readonly guid: bigint; readonly note: string }
  | { readonly kind: "memberNote"; readonly name: string; readonly note: string; readonly officer: boolean }
  | { readonly kind: "infoText"; readonly text: string }
  | { readonly kind: "rank"; readonly rankId: number; readonly flags: number; readonly name: string;
    readonly gold: number; readonly tabs: readonly { rights: number; slots: number }[] }
  | { readonly kind: "addRank"; readonly name: string }
  | { readonly kind: "removeRank" }
  | { readonly kind: "extend"; readonly mapId: number; readonly difficulty: number; readonly extend: boolean }
  | { readonly kind: "channelList"; readonly channel: string };

interface CannedSocialEvents {
  CONTACTS_CHANGED: Record<string, never>;
  WHO_RESULTS: Record<string, never>;
  CHANNEL_CHANGED: { channel: string };
}

/** `WorldClient`'s contact, who, guild, group and lockout fields and commands, plus scripted packets. */
export class FrameXmlCannedSocialWorld implements FrameXmlFriendsWorld {
  readonly events = new EventBus<CannedSocialEvents>();
  readonly calls: FrameXmlCannedSocialCall[] = [];
  readonly names = new Map<bigint, string>([[0x42n, PLAYER_NAME]]);
  readonly state = { selfGuid: 0x42n as bigint | undefined };
  contacts: ContactList | undefined = {
    flags: 0x07,
    contacts: CONTACTS.map(([guid, name, flags, status, areaId, level, classId, note]): Contact => {
      this.names.set(guid, name);
      return { guid, flags, note, status, areaId, level, classId };
    }),
  };
  whoResult: WhoResult | undefined;
  guildRoster: GuildRoster | undefined = {
    welcomeText: "Рейд в Наксрамас в пятницу в 20:00. Не опаздывайте!",
    infoText: "Стражи Элвинна — дружелюбная гильдия Альянса.\nРейды: пт и вс.\nСайт: нет.",
    ranks: [...RANKS],
    members: MEMBERS.map(([guid, name, rankId, level, classId, areaId, status, days, note, officerNote]): GuildMember => {
      this.names.set(guid, name);
      return { guid, status, online: status !== 0, name, rankId, level, classId, gender: 0, areaId,
        lastSaveDays: days, note, officerNote };
    }),
  };
  guildQuery: GuildQueryInfo | undefined = {
    guildId: FRAMEXML_CANNED_GUILD_ID, name: "Стражи Элвинна",
    rankNames: [...RANK_NAMES, "", "", "", "", ""],
    emblemStyle: 0, emblemColor: 0, borderStyle: 0, borderColor: 0, backgroundColor: 0, rankCount: RANK_NAMES.length,
  };
  guildInfo = undefined;
  guildEventLog: GuildEventLogEntry[] | undefined = [
    { type: 1, playerGuid: 0x101n, otherGuid: 0x30cn, rankId: 0, secondsAgo: 3 * 86400 },
    { type: 2, playerGuid: 0x30cn, otherGuid: 0n, rankId: 0, secondsAgo: 3 * 86400 - 60 },
    { type: 3, playerGuid: 0x42n, otherGuid: 0x303n, rankId: 3, secondsAgo: 26 * 3600 },
    { type: 4, playerGuid: 0x101n, otherGuid: 0x307n, rankId: 4, secondsAgo: 5 * 3600 },
    { type: 6, playerGuid: 0x30en, otherGuid: 0n, rankId: 0, secondsAgo: 40 * 60 },
  ];
  guildPermissions: { purchasedTabs: number } | undefined = { purchasedTabs: 2 };
  guildBank: { tabs: { name: string; icon: string }[] } | undefined = {
    tabs: [{ name: "Общее", icon: "INV_Misc_Bag_10" }, { name: "Рейд", icon: "INV_Potion_54" }],
  };
  /**
   * Joined channels as TrinityCore names them (ruRU): two server channels, whose rosters the server
   * does not list, and a custom one the player owns with a three-member roster.
   */
  readonly channels = new Map<string, { flags: number; count: number; members: { guid: bigint; flags: number }[] }>([
    ["Общий - Элвиннский лес", { flags: 0x18, count: 0, members: [] }],
    ["Оборона: Элвиннский лес", { flags: 0x18, count: 0, members: [] }],
    ["стражи", { flags: 0x01, count: 3, members: [
      { guid: 0x42n, flags: 0x01 }, { guid: 0x101n, flags: 0x02 }, { guid: 0x301n, flags: 0x00 },
    ] }],
  ]);
  group: GroupState | undefined;
  lockouts: InstanceLockout[] | undefined = [
    { mapId: 533, difficulty: 0, instanceId: 0x0000000100000017n, active: true, extended: false, secondsUntilReset: 3 * 86400 + 7200 },
    { mapId: 574, difficulty: 1, instanceId: 0x2an, active: true, extended: true, secondsUntilReset: 5400 },
  ];

  constructor() {
    this.names.set(0x30en, "Вейд");
  }

  displayName(guid: bigint): string { return this.names.get(guid) ?? `0x${guid.toString(16)}`; }
  requestName(): void { /* every canned name is known */ }

  /**
   * The canned server answers the way TrinityCore does — a fresh SMSG_CONTACT_LIST, SMSG_GUILD_ROSTER,
   * MSG_GUILD_EVENT_LOG_QUERY or SMSG_RAID_INSTANCE_INFO replacing the held field — a microtask
   * later, as a packet would, never inside the Lua that asked.
   */
  #answer(apply: () => void): void {
    void Promise.resolve().then(apply);
  }
  requestContacts(): void {
    this.calls.push({ kind: "contacts" });
    this.#answer(() => {
      if (!this.contacts) return;
      this.contacts = { ...this.contacts, contacts: this.contacts.contacts.map((contact) => ({ ...contact })) };
      this.events.emit("CONTACTS_CHANGED", {});
    });
  }
  setFriendNote(guid: bigint, note: string): void {
    this.calls.push({ kind: "friendNote", guid, note });
    const held = this.contacts?.contacts.find((contact) => contact.guid === guid);
    if (held) held.note = note;
  }
  requestWho(_request?: WhoRequest): void { /* answered by answerWho */ }
  requestGuildRoster(): void {
    this.calls.push({ kind: "roster" });
    this.#answer(() => this.rosterPacket());
  }
  requestGuildEventLog(): void {
    this.calls.push({ kind: "eventLog" });
    this.#answer(() => { if (this.guildEventLog) this.guildEventLog = [...this.guildEventLog]; });
  }
  setGuildMemberNote(name: string, note: string, officer = false): void {
    this.calls.push({ kind: "memberNote", name, note, officer });
  }
  setGuildInfoText(text: string): void { this.calls.push({ kind: "infoText", text }); }
  setGuildRank(rankId: number, flags: number, name: string, gold: number,
    tabs: ReadonlyArray<{ rights: number; slots: number }>): void {
    this.calls.push({ kind: "rank", rankId, flags, name, gold, tabs: tabs.map((tab) => ({ ...tab })) });
  }
  addGuildRank(name: string): void { this.calls.push({ kind: "addRank", name }); }
  removeLowestGuildRank(): void { this.calls.push({ kind: "removeRank" }); }
  convertToRaid(): void { this.calls.push({ kind: "convertToRaid" }); }
  requestChannelList(channel: string): void {
    this.calls.push({ kind: "channelList", channel });
    this.#answer(() => {
      const held = this.channels.get(channel);
      if (held) this.channels.set(channel, { ...held, members: [...held.members] });
      this.events.emit("CHANNEL_CHANGED", { channel });
    });
  }
  requestRaidInfo(): void {
    this.calls.push({ kind: "raidInfo" });
    this.#answer(() => { if (this.lockouts) this.lockouts = [...this.lockouts]; });
  }
  setSavedInstanceExtend(mapId: number, difficulty: number, extend: boolean): void {
    this.calls.push({ kind: "extend", mapId, difficulty, extend });
  }

  /** SMSG_WHO: `rows` of the canned table (all by default), as the server caps and counts them. */
  answerWho(count = WHO.length, matched = count): void {
    const entries = WHO.slice(0, count).map(([name, guild, level, classId, race, zoneId]): WhoEntry =>
      ({ name, guild, level, classId, race, gender: 0, zoneId }));
    this.whoResult = { displayed: entries.length, matched, entries };
    this.events.emit("WHO_RESULTS", {});
  }

  /** SMSG_FRIEND_STATUS for a friend going on/offline, folded as WorldClient does. */
  friendStatus(guid: bigint, status: number, areaId = 12, level = 60, classId = 1): void {
    const contact = this.contacts?.contacts.find((row) => row.guid === guid);
    if (!contact) return;
    contact.status = status;
    contact.areaId = status === FRIEND_STATUS_OFFLINE ? 0 : areaId;
    contact.level = status === FRIEND_STATUS_OFFLINE ? 0 : level;
    contact.classId = status === FRIEND_STATUS_OFFLINE ? 0 : classId;
    this.events.emit("CONTACTS_CHANGED", {});
  }

  /** SMSG_GUILD_ROSTER: a fresh roster object with `change` applied to a copy of the members. */
  rosterPacket(change: (members: GuildMember[]) => void = () => {}, welcomeText?: string): void {
    const roster = this.guildRoster;
    if (!roster) return;
    const members = roster.members.map((member) => ({ ...member }));
    change(members);
    this.guildRoster = { ...roster, welcomeText: welcomeText ?? roster.welcomeText, members };
  }

  /** SMSG_GROUP_LIST for the canned four as a party, or as a ten-man raid. */
  groupList(raid: boolean): void {
    const members = [
      [0x501n, "Альфа"], [0x502n, "Бета"], [0x503n, "Гамма"], [0x504n, "Дельта"],
    ] as const;
    this.group = {
      groupType: raid ? 0x02 : 0, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 0x1f0000000000001n,
      counter: (this.group?.counter ?? 0) + 1,
      members: members.map(([guid, name], index) => {
        this.names.set(guid, name);
        return { name, guid, online: index !== 3, status: index !== 3 ? 1 : 0, subGroup: raid ? Math.floor((index + 1) / 5) : 0,
          flags: index === 0 ? 0x01 : index === 1 ? 0x02 : 0, roles: 0 };
      }),
      leaderGuid: 0x42n, lootMethod: 3, masterLooterGuid: 0n, lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0,
    };
  }
}

/**
 * A canned model over its own scripted world. The canned player (0x42, «Игрок», the canned seam's
 * name) leads «Стражи Элвинна» and the canned party of four; `world.groupList(true)` makes it a raid.
 */
export function createCannedFrameXmlFriends(): {
  readonly model: FrameXmlFriendsModel; readonly world: FrameXmlCannedSocialWorld;
} {
  const world = new FrameXmlCannedSocialWorld();
  world.groupList(false);
  const context: FrameXmlFriendsContext = {
    world: () => world,
    playerGuid: () => world.state.selfGuid,
    playerName: () => PLAYER_NAME,
    unitGuild: (unit) => unit.toLowerCase() === "player"
      ? { guildId: FRAMEXML_CANNED_GUILD_ID, rankId: world.guildRoster?.members.find((member) => member.guid === 0x42n)?.rankId ?? 0 }
      : undefined,
    areaName: (areaId) => ZONES[areaId],
    classInfo: (classId) => FRAMEXML_CANNED_CLASSES[classId],
    raceName: (raceId) => RACES[raceId],
    mapInfo: (mapId) => MAPS[mapId],
    // The canned party's classes (CannedWorldSeam's Альфа/Бета/Гамма/Дельта); the player is a warrior.
    memberFacts: (guid) => {
      const index = world.group?.members.findIndex((row) => row.guid === guid) ?? -1;
      return { level: 60, classId: [1, 5, 4, 7][index] ?? 1, areaId: 12 };
    },
  };
  return { model: new FrameXmlFriendsModel(context), world };
}

export { FRIEND_STATUS_OFFLINE, FRIEND_STATUS_ONLINE, FRIEND_STATUS_AFK, FRIEND_STATUS_DND };
