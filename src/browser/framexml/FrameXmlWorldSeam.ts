/**
 * The state seam — slice F3's second item.
 *
 * F2 finished with «an empty but well-typed world»: every in-world query answered with the value
 * the real client answers when there is genuinely nothing there. That is exactly the right answer
 * for an inventory and exactly the wrong one for a working interface, because an action bar whose
 * `HasAction` is always false hides all twelve buttons and stops.
 *
 * This is the one place where something that is *not* the corpus decides what the interface shows.
 * It is a typed provider with two implementations and no third way in: `CannedWorldSeam` for the
 * dev page, `LiveWorldSeam` over this client's own world state. Nothing in `FrameXmlBoot` knows
 * which one it has, and nothing in either implementation knows about Lua.
 *
 * **The surface is measured, not designed.** Every name below is a name `ActionButton.lua`,
 * `MainMenuBar.lua` or `SecureTemplates.lua` actually calls, and the groups follow the files:
 *
 * * the action bar — `HasAction`, `GetActionTexture`, `GetActionText`, `GetActionCount`,
 *   `GetActionCooldown`, `IsUsableAction`, `IsConsumableAction`, `IsStackableAction`,
 *   `IsEquippedAction`, `IsCurrentAction`, `IsAttackAction`, `IsAutoRepeatAction`,
 *   `IsActionInRange`, `GetActionBarPage`, `GetBonusBarOffset` and `UseAction`, which is what
 *   `SECURE_ACTIONS.action` calls once the attributes resolve (`SecureTemplates.lua:310`);
 * * the player and the selected target — `UnitName`, `UnitLevel`, `UnitClass`, `UnitRace`, `UnitSex`, `UnitHealth`,
 *   `UnitHealthMax`, `UnitIsConnected`, `UnitPower`, `UnitPowerMax`, `UnitPowerType`, `UnitXP`,
 *   `UnitXPMax`, `UnitExists`, `GetMoney` and `GetRestState` — the last of which is not decoration:
 *   `MainMenuBar.lua:317`
 *   is `if (exhaustionStateID >= 3)` with no nil guard, and it is one of only three raises the
 *   vertical's partial TOC has left.
 * * the player cast bar — `UnitCastingInfo` and `UnitChannelInfo`; the event names are kept beside
 *   the rest of the seam because `CastingBarFrame.lua` only redraws after its `UNIT_SPELLCAST_*`
 *   notifications arrive.
 *
 * * the target frame's measured relation queries — `UnitFactionGroup`, `UnitClassification`,
 *   `UnitIsUnit`, `UnitIsPlayer`, `UnitIsDead`, `UnitIsGhost`, `UnitIsCorpse`, `UnitIsConnected`,
 *   `UnitIsFriend`, `UnitIsEnemy`, `UnitCanAttack`, `UnitPlayerControlled`, `UnitIsPVP`,
 *   `UnitIsPVPFreeForAll`, `UnitIsTapped`, `UnitIsTappedByPlayer`, `UnitIsTappedByAllThreatList`
 *   and `UnitSelectionColor`; and `PLAYER_TARGET_CHANGED`, which is the only selection edge
 *   `TargetFrame.lua` registers.
 *
 * * the base minimap's world labels — `GetMinimapZoneText`, `GetZoneText`, `GetSubZoneText` and
 *   the three-return `GetZonePVPInfo`. `GetTime` is installed by the boot's shared clock,
 *   while zoom (`Minimap:GetZoom*`/`SetZoom`) and rotation (`GetCVar`/`SetCVar`) are widget/CVar
 *   state rather than world seam values. `GetPlayerMapPosition` is not a base `Minimap.lua` call
 *   in the measured 3.3.5 client, so it is intentionally not promoted here.
 *
 * `Minimap.xml` also registers `MINIMAP_PING`, but it is deliberately not promoted in this seam:
 * this client's packet carries absolute world coordinates while stock `Minimap.lua` expects
 * normalized local offsets after zoom/rotation projection. The adopted native canvas owns that
 * projection; forwarding raw values would place a ping incorrectly.
 *
 * * the player containers — `GetContainerNumSlots`, `GetContainerNumFreeSlots`,
 *   `GetContainerItemInfo`, `GetContainerItemLink`, `GetContainerItemCooldown`, `GetBagName` and
 *   `UseContainerItem`. Bag id 0 is the backpack, 1..4 are carried bags and -2 is the 32-slot
 *   keyring; pickup, split and lock/cooldown transitions remain neutral until the host owns them.
 *
 * * the battlemaster arena page — `IsBattlefieldArena`, `GetCurrentArenaSeason`,
 *   `CanJoinBattlefieldAsGroup`, `IsPartyLeader`, `GetNumPartyMembers`, `GetNumRaidMembers` and
 *   `JoinBattlefield`; the list edge is accepted only when the packet says `fromWhere=0`,
 *   `bgTypeId=6` and carries a non-zero battlemaster GUID. Queue-originated or stale lists stay
 *   neutral, so the native ArenaWindow remains a truthful fallback.
 *
 * Everything the seam does **not** answer keeps F2's neutral answer, because F2's neutral answer is
 * still the truthful one for a client with no target, no pet, no bags and no group.
 * PartyFrame's classic non-raid membership and ArenaFrame's leader/count branches are promoted only
 * when the world has an authoritative group snapshot; voice, ready-check and vehicle branches stay
 * neutral in this slice. The acceptance test covers connected, offline and out-of-range party identities
 * while requiring those unsupported optional branches to remain bounded and error-free at runtime.
 */

import {
  CHAT_MSG_ACHIEVEMENT,
  CHAT_MSG_BATTLEGROUND,
  CHAT_MSG_BG_SYSTEM_ALLIANCE,
  CHAT_MSG_BG_SYSTEM_HORDE,
  CHAT_MSG_BG_SYSTEM_NEUTRAL,
  CHAT_MSG_CHANNEL,
  CHAT_MSG_EMOTE,
  CHAT_MSG_GUILD,
  CHAT_MSG_GUILD_ACHIEVEMENT,
  CHAT_MSG_MONSTER_EMOTE,
  CHAT_MSG_MONSTER_PARTY,
  CHAT_MSG_MONSTER_SAY,
  CHAT_MSG_MONSTER_WHISPER,
  CHAT_MSG_MONSTER_YELL,
  CHAT_MSG_OFFICER,
  CHAT_MSG_PARTY,
  CHAT_MSG_PARTY_LEADER,
  CHAT_MSG_RAID,
  CHAT_MSG_RAID_BOSS_EMOTE,
  CHAT_MSG_RAID_BOSS_WHISPER,
  CHAT_MSG_RAID_LEADER,
  CHAT_MSG_RAID_WARNING,
  CHAT_MSG_SAY,
  CHAT_MSG_SYSTEM,
  CHAT_MSG_TEXT_EMOTE,
  CHAT_MSG_WHISPER,
  CHAT_MSG_WHISPER_FOREIGN,
  CHAT_MSG_WHISPER_INFORM,
  CHAT_MSG_YELL,
} from "../../world/ChatProtocol.js";
import type { ChatMessage } from "../../world/ChatProtocol.js";
import type { FrameXmlTalentSnapshot } from "./FrameXmlTalentResolver.js";

/**
 * How the seam reaches the interface: events in, and the clock both sides share.
 *
 * The seam owns the firing. That is the whole reason this is an interface and not a bag of
 * getters: `ActionButton_Update` registers its dozen events *the first time a slot has something
 * in it*, so a host that only answered questions would answer them once at load and never again.
 */
export interface FrameXmlSeamPump {
  /** Deliver one event to every frame registered for it; returns how many handlers ran. */
  fire(event: string, ...args: readonly unknown[]): number;
  /** `GetTime()` in seconds — the same clock the corpus reads, and the cooldown's units. */
  now(): number;
}

/** The 3.3.5 `UnitCastingInfo` return tuple, in the client's order. */
export type FrameXmlCastingInfo = readonly [
  name: string,
  rank: string,
  displayName: string,
  texture: string,
  startMs: number,
  endMs: number,
  isTradeSkill: boolean,
  castID: number | undefined,
  notInterruptible: boolean,
];

/** The 3.3.5 `UnitChannelInfo` return tuple, in the client's order. */
export type FrameXmlChannelInfo = readonly [
  name: string,
  rank: string,
  displayName: string,
  texture: string,
  startMs: number,
  endMs: number,
  isTradeSkill: boolean,
  notInterruptible: boolean,
];

/** The six values returned by the 3.3.5 spellbook's `GetSpellTabInfo`. */
export type FrameXmlSpellTabInfo = readonly [
  name: string,
  texture: string,
  offset: number,
  numSpells: number,
  /** Offset after lower ranks are folded (the stock `SpellBook_GetTabInfo` value). */
  highestRankOffset: number,
  /** Count after lower ranks are folded (the stock `SpellBook_GetTabInfo` value). */
  highestRankNumSpells: number,
];

/** `GetSpellCooldown`'s GetTime-based `(start, duration, enabled)` tuple. */
export type FrameXmlSpellCooldown = readonly [
  start: number,
  duration: number,
  enabled: number,
];

/** The exact thirteen values returned by the 3.3.5 `GetSkillLineInfo` API. */
export type FrameXmlSkillLineInfo = readonly [
  skillName: string,
  header: boolean,
  isExpanded: boolean,
  skillRank: number,
  numTempPoints: number,
  skillModifier: number,
  skillMaxRank: number,
  isAbandonable: boolean,
  stepCost: number | undefined,
  rankCost: number | undefined,
  minLevel: number,
  skillCostType: number,
  skillDescription: string,
];

/** The 3.3.5 `UnitAura` return tuple, in the client's order. */
export type FrameXmlAuraInfo = readonly [
  name: string,
  rank: string,
  texture: string,
  count: number,
  debuffType: string | undefined,
  duration: number,
  expirationTime: number,
  unitCaster: string | undefined,
  isStealable: boolean,
  shouldConsolidate: boolean,
  spellId: number,
];

/** The values returned by the base minimap's zone C APIs when area metadata is available. */
export interface FrameXmlMinimapZone {
  /** Text shown above the minimap; absent until the host has a zone-name answer. */
  readonly minimapZoneText?: string;
  /** `GetZoneText()`'s zone name. */
  readonly zoneText?: string;
  /** `GetSubZoneText()`'s sub-zone name. */
  readonly subZoneText?: string;
  /** The exact `GetZonePVPInfo()` values; no faction is guessed when unresolved. */
  readonly pvpType?: string;
  readonly isSubZonePvP?: boolean;
  readonly factionName?: string;
}

/** `GetZonePVPInfo()`'s 3.3.5 return tuple, including nil positions. */
export type FrameXmlZonePvpInfo = readonly [
  pvpType: string | undefined,
  isSubZonePvP: boolean | undefined,
  factionName: string | undefined,
];

/** The 3.3.5 `GetContainerItemInfo` tuple, including nil positions. */
export type FrameXmlContainerItemInfo = readonly [
  texture: string | undefined,
  itemCount: number | undefined,
  locked: boolean | undefined,
  quality: number | undefined,
  readable: boolean | undefined,
];

/** The GetTime-based `GetContainerItemCooldown` tuple. */
export type FrameXmlContainerItemCooldown = readonly [
  start: number,
  duration: number,
  enabled: number,
];

/** The seven values returned by 3.3.5 `GetMerchantItemInfo`. */
export type FrameXmlMerchantItemInfo = readonly [
  name: string,
  texture: string | undefined,
  price: number,
  quantity: number,
  numAvailable: number,
  isUsable: boolean,
  /** True when the row uses an ItemExtendedCost rather than ordinary money. */
  extendedCost: boolean | undefined,
];

/** The six values returned by 3.3.5 `GetBuybackItemInfo`. */
export type FrameXmlBuybackItemInfo = readonly [
  name: string,
  texture: string | undefined,
  price: number,
  quantity: number,
  numAvailable: number,
  isUsable: boolean,
];

/** The three values returned by `GetMerchantItemCostInfo`; unsupported currencies stay zero. */
export type FrameXmlMerchantCostInfo = readonly [
  honorPoints: number,
  arenaPoints: number,
  itemCount: number,
];

/** The structural tuple returned by `GetInventorySlotInfo`. */
export type FrameXmlInventorySlotInfo = readonly [
  slot: number,
  texture: string,
];

/** `UnitStat`'s base/effective/positive/negative tuple (the C API index is 1-based). */
export type FrameXmlUnitStat = readonly [
  base: number,
  effective: number,
  positive: number,
  negative: number,
];

/** `UnitArmor`'s five values. */
export type FrameXmlUnitArmor = readonly [
  base: number,
  effective: number,
  armor: number,
  positive: number,
  negative: number,
];

/** `UnitAttackPower` and `UnitRangedAttackPower`'s base/modifier tuple. */
export type FrameXmlUnitAttackPower = readonly [
  base: number,
  positive: number,
  negative: number,
];

/** `UnitDamage`'s melee damage tuple. */
export type FrameXmlUnitDamage = readonly [
  minDamage: number,
  maxDamage: number,
  minOffHandDamage: number,
  maxOffHandDamage: number,
  physicalBonusPositive: number,
  physicalBonusNegative: number,
  physicalPercent: number,
];

/** `UnitRangedDamage`'s speed/damage tuple. */
export type FrameXmlUnitRangedDamage = readonly [
  speed: number,
  minDamage: number,
  maxDamage: number,
  physicalBonusPositive: number,
  physicalBonusNegative: number,
  physicalPercent: number,
];

/** The ten values returned by \`GetQuestLogTitle\` for one displayed row. */
export type FrameXmlQuestLogTitle = readonly [
  title: string,
  level: number,
  questTag: string | undefined,
  suggestedGroup: number,
  isHeader: boolean,
  isCollapsed: boolean,
  isComplete: number | undefined,
  isDaily: boolean,
  questId: number,
  displayQuestId: boolean,
];

/** The three values returned by \`GetQuestLogLeaderBoard\`. */
export type FrameXmlQuestLogLeaderBoard = readonly [
  text: string,
  objectiveType: string,
  finished: boolean,
];

/** The five values returned by the stock quest reward item APIs. */
export type FrameXmlQuestItemInfo = readonly [
  name: string,
  texture: string | undefined,
  count: number,
  quality: number | undefined,
  isUsable: boolean | undefined,
];

/** Cached item metadata supplied by the host; the callback must never perform I/O. */
export interface FrameXmlQuestItemMetadata {
  readonly name: string;
  readonly texture?: string;
  readonly quality?: number;
  readonly isUsable?: boolean;
}

/** Cached creature metadata supplied by the host; resolving it must never perform I/O. */
export interface FrameXmlQuestCreatureMetadata {
  readonly name: string;
}

/** The four values returned by `GetQuestLogRewardSpell`. */
export type FrameXmlQuestRewardSpell = readonly [
  texture: string,
  name: string,
  isTradeSkillSpell: boolean | undefined,
  isSpellLearned: boolean | undefined,
];

/** The exact thirteen values returned by 3.3.5 `GetFactionInfo`. */
export type FrameXmlFactionInfo = readonly [
  name: string,
  description: string,
  standingId: number,
  barMin: number,
  barMax: number,
  barValue: number,
  atWarWith: boolean,
  canToggleAtWar: boolean,
  isHeader: boolean,
  isCollapsed: boolean,
  hasRep: boolean,
  isWatched: boolean,
  isChild: boolean,
];

/** The five values returned by 3.3.5 `GetWatchedFactionInfo`. */
export type FrameXmlWatchedFactionInfo = readonly [
  name: string,
  reaction: number,
  barMin: number,
  barMax: number,
  barValue: number,
];

/** Resolved faction metadata; dynamic selection/state remains seam-local. */
export interface FrameXmlFactionRow {
  readonly listId: number;
  readonly name: string;
  readonly description: string;
  readonly standingId: number;
  readonly barMin: number;
  readonly barMax: number;
  readonly barValue: number;
  readonly canToggleAtWar: boolean;
  readonly isHeader: boolean;
  readonly isChild: boolean;
  readonly hasRep: boolean;
  /** Initial server flags; optional so canned rows can keep their local interaction state. */
  readonly atWarWith?: boolean;
  readonly isInactive?: boolean;
}

/** The stock paper-doll backgrounds and 1-based equipment IDs. */
export const FRAMEXML_INVENTORY_SLOTS: Readonly<Record<string, FrameXmlInventorySlotInfo>> = Object.freeze({
  HeadSlot: [1, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Head"],
  NeckSlot: [2, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Neck"],
  ShoulderSlot: [3, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Shoulder"],
  ShirtSlot: [4, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Shirt"],
  ChestSlot: [5, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Chest"],
  WaistSlot: [6, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Waist"],
  LegsSlot: [7, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Legs"],
  FeetSlot: [8, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Feet"],
  // The stock XML calls this "Wrist", but the 3.3.5 archive's file is plural.
  WristSlot: [9, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Wrists"],
  HandsSlot: [10, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Hands"],
  Finger0Slot: [11, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Finger"],
  Finger1Slot: [12, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Finger"],
  Trinket0Slot: [13, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Trinket"],
  Trinket1Slot: [14, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Trinket"],
  // The slot is named Back in XML; the archive calls its background Rear.
  BackSlot: [15, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Rear"],
  MainHandSlot: [16, "Interface\\Paperdoll\\UI-PaperDoll-Slot-MainHand"],
  SecondaryHandSlot: [17, "Interface\\Paperdoll\\UI-PaperDoll-Slot-SecondaryHand"],
  RangedSlot: [18, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Ranged"],
  TabardSlot: [19, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Tabard"],
  // Ammo is the stock special slot (ID 0), not one of the nineteen equipment rows.  Keep it in
  // the shared table because the Character/PaperDoll Lua asks for it while the seam is installed.
  AmmoSlot: [0, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Ammo"],
  // All four bag buttons share one background file; the button ID distinguishes them.
  Bag0Slot: [20, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Bag"],
  Bag1Slot: [21, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Bag"],
  Bag2Slot: [22, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Bag"],
  Bag3Slot: [23, "Interface\\Paperdoll\\UI-PaperDoll-Slot-Bag"],
});

/** The native API accepts the stock slot tokens case-insensitively. */
export function frameXmlInventorySlotInfo(name: string): FrameXmlInventorySlotInfo | undefined {
  const exact = FRAMEXML_INVENTORY_SLOTS[name];
  if (exact) return exact;
  const wanted = name.toLowerCase();
  for (const [candidate, value] of Object.entries(FRAMEXML_INVENTORY_SLOTS)) {
    if (candidate.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** The canonical 3.3.5 `CHAT_MSG_*` argument tuple. BigInts never cross this boundary. */
export type FrameXmlChatEventArgs = readonly [
  message: string,
  sender: string,
  languageName: string,
  channelString: string,
  target: string,
  flags: string,
  zoneChannelId: number,
  channelNumber: number,
  channelName: string,
  unknown: number,
  lineId: number,
  senderGuid: string,
];

/** The only target shapes stock `SendChatMessage` can hand to the seam. */
export type FrameXmlChatTarget = string | number;

/** Flat `channelName, zoneChannelId` pairs returned by `GetChatWindowChannels`. */
export type FrameXmlChatWindowChannels = readonly (string | number)[];

/** The outbound callback receives the numeric protocol type only after seam validation. */
export type FrameXmlChatSender = (
  text: string,
  type: number,
  language: number | undefined,
  target: string,
) => void;

/** The `FCF_GetChatWindowInfo` ten-return tuple used by ChatFrame configuration. */
export type FrameXmlChatWindowInfo = readonly [
  name: string,
  fontSize: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
  shown: boolean,
  locked: boolean,
  docked: boolean,
  uninteractable: boolean,
];

/** Numeric chat types that the parser can place in `ChatMessage`, by their stock event suffix. */
export const FRAMEXML_CHAT_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [CHAT_MSG_SYSTEM]: "SYSTEM",
  [CHAT_MSG_SAY]: "SAY",
  [CHAT_MSG_PARTY]: "PARTY",
  [CHAT_MSG_RAID]: "RAID",
  [CHAT_MSG_GUILD]: "GUILD",
  [CHAT_MSG_OFFICER]: "OFFICER",
  [CHAT_MSG_YELL]: "YELL",
  [CHAT_MSG_WHISPER]: "WHISPER",
  [CHAT_MSG_WHISPER_FOREIGN]: "WHISPER_FOREIGN",
  [CHAT_MSG_WHISPER_INFORM]: "WHISPER_INFORM",
  [CHAT_MSG_EMOTE]: "EMOTE",
  [CHAT_MSG_TEXT_EMOTE]: "TEXT_EMOTE",
  [CHAT_MSG_MONSTER_SAY]: "MONSTER_SAY",
  [CHAT_MSG_MONSTER_PARTY]: "MONSTER_PARTY",
  [CHAT_MSG_MONSTER_YELL]: "MONSTER_YELL",
  [CHAT_MSG_MONSTER_WHISPER]: "MONSTER_WHISPER",
  [CHAT_MSG_MONSTER_EMOTE]: "MONSTER_EMOTE",
  [CHAT_MSG_CHANNEL]: "CHANNEL",
  0x12: "CHANNEL_JOIN",
  0x13: "CHANNEL_LEAVE",
  0x14: "CHANNEL_LIST",
  0x15: "CHANNEL_NOTICE",
  0x16: "CHANNEL_NOTICE_USER",
  0x17: "AFK",
  0x18: "DND",
  0x19: "IGNORED",
  0x1a: "SKILL",
  0x1b: "LOOT",
  0x1c: "MONEY",
  0x1d: "OPENING",
  0x1e: "TRADESKILLS",
  0x1f: "PET_INFO",
  0x20: "COMBAT_MISC_INFO",
  0x21: "COMBAT_XP_GAIN",
  0x22: "COMBAT_HONOR_GAIN",
  0x23: "COMBAT_FACTION_CHANGE",
  [CHAT_MSG_BG_SYSTEM_NEUTRAL]: "BG_SYSTEM_NEUTRAL",
  [CHAT_MSG_BG_SYSTEM_ALLIANCE]: "BG_SYSTEM_ALLIANCE",
  [CHAT_MSG_BG_SYSTEM_HORDE]: "BG_SYSTEM_HORDE",
  [CHAT_MSG_RAID_LEADER]: "RAID_LEADER",
  [CHAT_MSG_RAID_WARNING]: "RAID_WARNING",
  [CHAT_MSG_RAID_BOSS_EMOTE]: "RAID_BOSS_EMOTE",
  [CHAT_MSG_RAID_BOSS_WHISPER]: "RAID_BOSS_WHISPER",
  [CHAT_MSG_BATTLEGROUND]: "BATTLEGROUND",
  0x2b: "FILTERED",
  0x2d: "BATTLEGROUND_LEADER",
  0x2e: "RESTRICTED",
  [CHAT_MSG_ACHIEVEMENT]: "ACHIEVEMENT",
  [CHAT_MSG_GUILD_ACHIEVEMENT]: "GUILD_ACHIEVEMENT",
  [CHAT_MSG_PARTY_LEADER]: "PARTY_LEADER",
});

/**
 * The stock 3.3.5 `ChatTypeGroup` keys that can contain a parser-backed chat event.
 *
 * Keep this as group names rather than flattening event names: `ChatFrame_RegisterForMessages`
 * expands these through the corpus' own `ChatTypeGroup` table, preserving stock aliases such as
 * `EMOTE` (text emotes), `WHISPER` (inform/AFK/DND) and `PARTY` (monster party).  Battle.net
 * groups are intentionally absent because this parser does not produce the stock `CHAT_MSG_BN_*`
 * events.  The groups whose events are not yet emitted by this client are harmless configuration
 * coverage and make ownership loss-free when those existing numeric message types are enabled.
 */
export const FRAMEXML_CHAT_WINDOW_GROUPS: readonly string[] = Object.freeze([
  "SYSTEM",
  "SAY",
  "EMOTE",
  "YELL",
  "WHISPER",
  "PARTY",
  "PARTY_LEADER",
  "RAID",
  "RAID_LEADER",
  "RAID_WARNING",
  "BATTLEGROUND",
  "BATTLEGROUND_LEADER",
  "GUILD",
  "OFFICER",
  "MONSTER_SAY",
  "MONSTER_YELL",
  "MONSTER_EMOTE",
  "MONSTER_WHISPER",
  "MONSTER_BOSS_EMOTE",
  "MONSTER_BOSS_WHISPER",
  "ERRORS",
  "AFK",
  "DND",
  "IGNORED",
  "BG_HORDE",
  "BG_ALLIANCE",
  "BG_NEUTRAL",
  "COMBAT_XP_GAIN",
  "COMBAT_HONOR_GAIN",
  "COMBAT_FACTION_CHANGE",
  "SKILL",
  "LOOT",
  "MONEY",
  "OPENING",
  "TRADESKILLS",
  "PET_INFO",
  "COMBAT_MISC_INFO",
  "ACHIEVEMENT",
  "GUILD_ACHIEVEMENT",
  "CHANNEL",
  "TARGETICONS",
]);

/** SendChatMessage types this client can truthfully forward to its existing world builder. */
export const FRAMEXML_CHAT_OUTBOUND_TYPES: Readonly<Record<string, number>> = Object.freeze({
  SAY: CHAT_MSG_SAY,
  YELL: CHAT_MSG_YELL,
  PARTY: CHAT_MSG_PARTY,
  RAID: CHAT_MSG_RAID,
  GUILD: CHAT_MSG_GUILD,
  OFFICER: CHAT_MSG_OFFICER,
  WHISPER: CHAT_MSG_WHISPER,
  EMOTE: CHAT_MSG_EMOTE,
  CHANNEL: CHAT_MSG_CHANNEL,
});

/** The server's three language IDs represented in the stock FrameXML string slot. */
const FRAMEXML_LANGUAGE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: "Universal",
  1: "Orcish",
  7: "Common",
});

/** A bounded protocol payload is the only validation this seam can perform without the world. */
export const FRAMEXML_CHAT_MAX_BYTES = 255;

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Convert a wire GUID to a stable Lua-safe textual value. */
export function frameXmlGuid(guid: bigint): string {
  return guid === 0n ? "" : `0x${guid.toString(16).padStart(16, "0")}`;
}

/** Map a numeric parser type to the exact event name stock ChatFrame registers. */
export function frameXmlChatEventName(type: number): string | undefined {
  const suffix = FRAMEXML_CHAT_TYPE_NAMES[type];
  return suffix === undefined ? undefined : `CHAT_MSG_${suffix}`;
}

/** Resolve only the stock outbound type tokens this client can send. */
export function frameXmlChatTypeCode(type: string): number | undefined {
  return FRAMEXML_CHAT_OUTBOUND_TYPES[type];
}

/** Match the 255-byte server limit without splitting a UTF-8 code point. */
export function frameXmlChatTextIsValid(text: string): boolean {
  return text.length > 0 && utf8Length(text) <= FRAMEXML_CHAT_MAX_BYTES;
}

/** Build stock ChatFrame's twelve arguments from the client's already parsed message. */
export function frameXmlChatEventArgs(
  message: ChatMessage,
  sender = message.senderName,
  lineId = 0,
  channelNumber = 0,
  channelName = message.channel,
  channelString?: string,
): FrameXmlChatEventArgs {
  const flags = [
    (message.tag & 1) !== 0 ? "AFK" : "",
    (message.tag & 2) !== 0 ? "DND" : "",
    (message.tag & 4) !== 0 ? "GM" : "",
  ].filter(Boolean).join(" ");
  return [
    message.text,
    message.type === CHAT_MSG_WHISPER_INFORM ? message.receiverName : sender,
    FRAMEXML_LANGUAGE_NAMES[message.language] ?? "",
    channelString ?? (channelNumber > 0 ? `${channelNumber}. ${channelName}` : channelName),
    message.receiverName,
    flags,
    0,
    channelNumber,
    channelName,
    0,
    lineId,
    frameXmlGuid(message.senderGuid),
  ];
}

/**
 * The events the seam fires, and the file that registers each one.
 *
 * Measured by reading every `RegisterEvent("…")` in the vertical's own files rather than by
 * picking plausible names:
 *
 * | event | registered by |
 * |---|---|
 * | `ACTIONBAR_UPDATE_STATE` | `ActionButton.lua:173` |
 * | `ACTIONBAR_UPDATE_USABLE` | `ActionButton.lua:174` |
 * | `ACTIONBAR_UPDATE_COOLDOWN` | `ActionButton.lua:175` |
 * | `ACTIONBAR_SLOT_CHANGED` | `ActionButton.lua:95` (arg1 is the slot, or 0 for «all») |
 * | `ACTIONBAR_PAGE_CHANGED` | `ActionButton.lua:94`, `MainMenuBar.lua` |
 * | `UPDATE_BINDINGS` | `ActionButton.lua:96` |
 * | `PLAYER_XP_UPDATE` | `MainMenuBar.lua` |
 * | `PLAYER_MONEY` | `MoneyFrame.lua` |
 * | `PLAYER_LEVEL_UP` | `MainMenuBar.lua` |
 * | `PLAYER_UPDATE_RESTING` | `MainMenuBar.lua` |
 * | `UPDATE_EXHAUSTION` | `MainMenuBar.lua` |
 * | `UNIT_HEALTH` / `UNIT_MAXHEALTH` | `UnitFrame.lua` (arg1 is the unit) |
 * | `UNIT_NAME_UPDATE` / `UNIT_PORTRAIT_UPDATE` / `UNIT_DISPLAYPOWER` | `UnitFrame.lua` |
 * | `UNIT_LEVEL` / `UNIT_MAXMANA` … `UNIT_MAXRUNIC_POWER` | `PlayerFrame.lua`, `UnitFrame.lua` |
 * | `UNIT_MANA`/`RAGE`/`ENERGY`/`FOCUS`/`RUNIC_POWER` and their `MAX` twins | `UnitFrame.lua` |
 * | `UNIT_FACTION` / `UNIT_CLASSIFICATION_CHANGED` / `UNIT_AURA` / `PLAYER_FLAGS_CHANGED` | `TargetFrame.lua` |
 * | `PARTY_MEMBERS_CHANGED` / `RAID_TARGET_UPDATE` / `PLAYER_TARGET_CHANGED` | `TargetFrame.lua` |
 * | `PLAYER_FOCUS_CHANGED` | `TargetFrame.lua` (`FocusFrame`) |
 * | `UNIT_TARGET` | `TargetFrame.lua` (`TargetofTargetFrame`) |
 * | `UNIT_SPELLCAST_START` … `UNIT_SPELLCAST_NOT_INTERRUPTIBLE` | `CastingBarFrame.lua` |
 * | `ZONE_CHANGED` / `ZONE_CHANGED_INDOORS` / `ZONE_CHANGED_NEW_AREA` | `Minimap.xml`'s minimap cluster |
 * | `WORLD_MAP_UPDATE` / `QUEST_POI_UPDATE` | `WatchFrame.lua`'s current-map POI filter |
 * | `BAG_UPDATE` | `ContainerFrame.lua` |
 * | `ITEM_LOCK_CHANGED` | `ContainerFrame.lua` |
 * | `BAG_UPDATE_COOLDOWN` | `ContainerFrame.lua` |
 *
 * `ZONE_CHANGED_INDOORS` is kept as the measured registration name but is not emitted here: the
 * world state has no indoor/zoom transition bit. `MINIMAP_UPDATE_ZOOM` and
 * `MINIMAP_UPDATE_TRACKING` similarly remain widget/settings concerns, not fabricated world edges.
 *
 * The three `ActionButton.lua` registrations that are *not* here — `ACTIONBAR_SHOWGRID`,
 * `ACTIONBAR_HIDEGRID` and `UPDATE_SHAPESHIFT_FORM` — are a drag in progress and a stance change,
 * neither of which any seam in this slice can produce.
 */
export const FRAMEXML_SEAM_EVENTS = Object.freeze({
  actionState: "ACTIONBAR_UPDATE_STATE",
  actionUsable: "ACTIONBAR_UPDATE_USABLE",
  actionCooldown: "ACTIONBAR_UPDATE_COOLDOWN",
  actionSlotChanged: "ACTIONBAR_SLOT_CHANGED",
  actionPageChanged: "ACTIONBAR_PAGE_CHANGED",
  bindings: "UPDATE_BINDINGS",
  experience: "PLAYER_XP_UPDATE",
  playerMoney: "PLAYER_MONEY",
  levelUp: "PLAYER_LEVEL_UP",
  resting: "PLAYER_UPDATE_RESTING",
  exhaustion: "UPDATE_EXHAUSTION",
  chatWindowsUpdated: "UPDATE_CHAT_WINDOWS",
  playerEnteringWorld: "PLAYER_ENTERING_WORLD",
  unitName: "UNIT_NAME_UPDATE",
  unitPortrait: "UNIT_PORTRAIT_UPDATE",
  unitDisplayPower: "UNIT_DISPLAYPOWER",
  unitLevel: "UNIT_LEVEL",
  health: "UNIT_HEALTH",
  maxHealth: "UNIT_MAXHEALTH",
  petChanged: "UNIT_PET",
  faction: "UNIT_FACTION",
  classification: "UNIT_CLASSIFICATION_CHANGED",
  aura: "UNIT_AURA",
  playerFlags: "PLAYER_FLAGS_CHANGED",
  partyMembers: "PARTY_MEMBERS_CHANGED",
  raidTarget: "RAID_TARGET_UPDATE",
  targetChanged: "PLAYER_TARGET_CHANGED",
  focusChanged: "PLAYER_FOCUS_CHANGED",
  unitTarget: "UNIT_TARGET",
  castStart: "UNIT_SPELLCAST_START",
  castStop: "UNIT_SPELLCAST_STOP",
  castFailed: "UNIT_SPELLCAST_FAILED",
  castInterrupted: "UNIT_SPELLCAST_INTERRUPTED",
  castDelayed: "UNIT_SPELLCAST_DELAYED",
  channelStart: "UNIT_SPELLCAST_CHANNEL_START",
  channelUpdate: "UNIT_SPELLCAST_CHANNEL_UPDATE",
  channelStop: "UNIT_SPELLCAST_CHANNEL_STOP",
  interruptible: "UNIT_SPELLCAST_INTERRUPTIBLE",
  notInterruptible: "UNIT_SPELLCAST_NOT_INTERRUPTIBLE",
  zoneChanged: "ZONE_CHANGED",
  zoneChangedNewArea: "ZONE_CHANGED_NEW_AREA",
  zoneChangedIndoors: "ZONE_CHANGED_INDOORS",
  spellsChanged: "SPELLS_CHANGED",
  learnedSpellInTab: "LEARNED_SPELL_IN_TAB",
  spellUpdateCooldown: "SPELL_UPDATE_COOLDOWN",
  updateShapeshiftForm: "UPDATE_SHAPESHIFT_FORM",
  currentSpellCastChanged: "CURRENT_SPELL_CAST_CHANGED",
  tradeSkillShow: "TRADE_SKILL_SHOW",
  tradeSkillClose: "TRADE_SKILL_CLOSE",
  petBarUpdate: "PET_BAR_UPDATE",
  bagUpdate: "BAG_UPDATE",
  itemLockChanged: "ITEM_LOCK_CHANGED",
  bagUpdateCooldown: "BAG_UPDATE_COOLDOWN",
  inventoryChanged: "UNIT_INVENTORY_CHANGED",
  stats: "UNIT_STATS",
  resistances: "UNIT_RESISTANCES",
  damage: "UNIT_DAMAGE",
  rangedDamage: "UNIT_RANGEDDAMAGE",
  attack: "UNIT_ATTACK",
  damageDoneMods: "PLAYER_DAMAGE_DONE_MODS",
  attackSpeed: "UNIT_ATTACK_SPEED",
  attackPower: "UNIT_ATTACK_POWER",
  rangedAttackPower: "UNIT_RANGED_ATTACK_POWER",
  questLogUpdate: "QUEST_LOG_UPDATE",
  unitQuestLogChanged: "UNIT_QUEST_LOG_CHANGED",
  questWatchUpdate: "QUEST_WATCH_UPDATE",
  questPoiUpdate: "QUEST_POI_UPDATE",
  worldMapUpdate: "WORLD_MAP_UPDATE",
  reputationChanged: "UPDATE_FACTION",
  skillLinesChanged: "SKILL_LINES_CHANGED",
  pvpKillsChanged: "PLAYER_PVP_KILLS_CHANGED",
  pvpRankChanged: "PLAYER_PVP_RANK_CHANGED",
  honorCurrencyUpdate: "HONOR_CURRENCY_UPDATE",
  /** A queue slot changed in the world client; PVPBattlegroundFrame consumes this exact edge. */
  battlefieldStatus: "UPDATE_BATTLEFIELD_STATUS",
  /** Group leader changed; ArenaFrame repaints its group-join affordance on this edge. */
  partyLeaderChanged: "PARTY_LEADER_CHANGED",
  /** A battlemaster list/reward response arrived. */
  battlefieldList: "PVPQUEUE_ANYWHERE_UPDATE_AVAILABLE",
  /** Opening the queue page asks the stock frame to fill itself. */
  battlegroundsShow: "PVPQUEUE_ANYWHERE_SHOW",
  npcBattlegroundsShow: "NPC_PVPQUEUE_ANYWHERE",
  /** A fresh battlemaster arena list opens the stock ArenaFrame. */
  arenaShow: "BATTLEFIELDS_SHOW",
  /** Closing or invalidating the current battlemaster list closes ArenaFrame. */
  arenaClose: "BATTLEFIELDS_CLOSED",
  battlefieldClose: "BATTLEFIELDS_CLOSED",
  merchantShow: "MERCHANT_SHOW",
  merchantUpdate: "MERCHANT_UPDATE",
  merchantClosed: "MERCHANT_CLOSED",
  trainerUpdate: "TRAINER_UPDATE",
  trainerDescriptionUpdate: "TRAINER_DESCRIPTION_UPDATE",
  talentsChanged: "PLAYER_TALENT_UPDATE",
} as const);

/** `UnitPowerType`'s first return, from the core's own `Powers` enum. */
export const FRAMEXML_POWER_TOKENS: readonly string[] = Object.freeze([
  "MANA", "RAGE", "FOCUS", "ENERGY", "HAPPINESS", "RUNES", "RUNIC_POWER",
]);

/**
 * `UnitPowerType` decides which `UNIT_*` event a power change is announced with.
 *
 * `UnitFrame.lua` registers a *different* event per power type and switches on the string, so a
 * seam that fired `UNIT_MANA` for a warrior would update nothing. Index by the power type.
 */
export const FRAMEXML_POWER_EVENTS: readonly string[] = Object.freeze([
  "UNIT_MANA", "UNIT_RAGE", "UNIT_FOCUS", "UNIT_ENERGY", "UNIT_HAPPINESS",
  "UNIT_RUNIC_POWER", "UNIT_RUNIC_POWER",
]);

/** The corresponding max-power notifications registered by `UnitFrameManaBar_Initialize`. */
export const FRAMEXML_POWER_MAX_EVENTS: readonly string[] = Object.freeze([
  "UNIT_MAXMANA", "UNIT_MAXRAGE", "UNIT_MAXFOCUS", "UNIT_MAXENERGY", "UNIT_MAXHAPPINESS",
  "UNIT_MAXRUNIC_POWER", "UNIT_MAXRUNIC_POWER",
]);

/** What one action slot answers. Slots are the client's own 1-based `action` numbers. */
export type FrameXmlActionTooltipKind = "spell" | "item" | "macro" | "equipment";

/**
 * The bounded payload the stock `GameTooltip:SetAction` adapter may render.
 *
 * `id` is the server action id (spell id, item entry, macro id or equipment-set id); it is never
 * the 1-based slot. Keeping the kind beside it prevents a slot number from accidentally entering
 * the spell lookup path when a bar row is empty or contains a non-spell action.
 */
export interface FrameXmlActionTooltip {
  readonly kind: FrameXmlActionTooltipKind;
  readonly id: number;
  readonly name: string;
  readonly rank?: string;
}

export interface FrameXmlWorldSeam {
  /** Exact auth-list realm name selected by the player. */
  realmName(): string | undefined;
  /** For the report: which implementation is answering. */
  readonly name: string;

  /** Called once, with the way back into the interface. */
  attach(pump: FrameXmlSeamPump): void;
  detach(): void;
  /** Stock `SendChatMessage` bridge; unsupported types and overlong text are ignored. */
  sendChatMessage(text: string, type: string, language: number | undefined, target: FrameXmlChatTarget): void;
  /** Message groups returned by `GetChatWindowMessages`; window 1 is the supported chat frame. */
  chatWindowMessages(windowId: number): readonly string[];
  /** Flat `channelName, zoneChannelId` pairs returned by `GetChatWindowChannels`. */
  chatWindowChannels(windowId: number): FrameXmlChatWindowChannels;
  /** `FCF_GetChatWindowInfo`'s ten values, or undefined for an unsupported window id. */
  chatWindowInfo(windowId: number): FrameXmlChatWindowInfo | undefined;
  /**
   * Advance the seam and fire whatever changed. Called once per rendered frame by the host, with
   * `GetTime()` seconds; a seam with nothing to animate may do nothing.
   */
  tick(now: number): void;

  // ---- the action bar ----------------------------------------------------
  hasAction(slot: number): boolean;
  /** A texture the renderer can resolve — the client's own `Interface\\Icons\\…` name. */
  actionTexture(slot: number): string | undefined;
  /** Only a macro has text; a spell answers nothing, and so does an item. */
  actionText(slot: number): string | undefined;
  /** Localised name/rank for stock `GameTooltip:SetAction`; slot is 1-based, id is not the slot. */
  actionTooltip(slot: number): FrameXmlActionTooltip | undefined;
  actionCount(slot: number): number;
  /** `start` (in `GetTime()` seconds), `duration`, `enable` — `GetActionCooldown`'s triple. */
  actionCooldown(slot: number): readonly [number, number, number];
  /** `isUsable`, `notEnoughMana` — `IsUsableAction`'s pair. */
  actionUsable(slot: number): readonly [boolean, boolean];
  isConsumableAction(slot: number): boolean;
  isStackableAction(slot: number): boolean;
  isEquippedAction(slot: number): boolean;
  isCurrentAction(slot: number): boolean;
  isAttackAction(slot: number): boolean;
  isAutoRepeatAction(slot: number): boolean;
  /**
   * 1 in range, 0 out of range, `undefined` for an action with no range check.
   *
   * `ActionButton_OnUpdate` compares against both numbers explicitly and treats anything else as
   * «no indicator», which is why `undefined` is a real answer and not a gap.
   */
  actionInRange(slot: number): number | undefined;
  actionBarPage(): number;
  bonusBarOffset(): number;
  /** `SECURE_ACTIONS.action`'s call, once the secure attributes have resolved the slot. */
  useAction(slot: number, unit: string | undefined, button: string | undefined): void;

  // ---- the player --------------------------------------------------------
  unitExists(unit: string): boolean;
  unitName(unit: string): string | undefined;
  /** `UnitPVPName`'s display name; the live world has no separate title cache, so it follows the unit name. */
  unitPvpName(unit: string): string | undefined;
  unitLevel(unit: string): number | undefined;
  /** Localised class name and the uppercase token, as `UnitClass` answers both. */
  unitClass(unit: string): readonly [string, string] | undefined;
  unitRace(unit: string): readonly [string, string] | undefined;
  /** 1 neuter, 2 male, 3 female — the client's own numbering. */
  unitSex(unit: string): number | undefined;
  unitHealth(unit: string): number;
  unitHealthMax(unit: string): number;
  unitPower(unit: string): number;
  unitPowerMax(unit: string): number;
  /** The power index and its token; `undefined` for a unit the seam does not know. */
  unitPowerType(unit: string): readonly [number, string] | undefined;
  unitXP(unit: string): number;
  unitXPMax(unit: string): number;
  /** Authoritative player coinage in copper; the neutral answer is zero. */
  money(): number;
  /** Number of non-player party members in the current non-raid group. */
  partyMemberCount(): number;
  /** Number of non-player raid members; zero is truthful when raid state is unavailable. */
  raidMemberCount(): number;
  /** True only when a real group snapshot names the local player as leader. */
  isPartyLeader(): boolean;
  /** The 1-based `GetPartyMember` name, or undefined for an empty/out-of-range slot. */
  partyMember(index: number): string | undefined;
  /** `TargetUnit` resolves one known unit token and delegates selection to the world. */
  targetUnit(unit: string): void;
  /** `UnitIsVisible` is true only while the seam has an in-range object for the unit. */
  unitIsVisible(unit: string): boolean;
  /** The current world contract has no possession bit; implementations answer conservatively. */
  unitIsPossessed(unit: string): boolean;
  /** `GetPetHappiness`'s happiness and damage percentage, or undefined when not modelled. */
  petHappiness(): readonly [number, number] | undefined;
  /** `HasPetUI`'s `(hasPetUI, isHunterPet)` pair. */
  hasPetUI(): readonly [boolean, boolean];
  /** `GetRestState`'s triple: state id, localised name, rest multiplier. */
  restState(): readonly [number, string, number];

  // ---- unit auras -------------------------------------------------------
  /** `UnitAura`'s 3.3.5 tuple for a 1-based filtered player slot. */
  unitAura(unit: string, index: number, filter: string | undefined): FrameXmlAuraInfo | undefined;
  /** Stock aliases over the same filtered aura rows. */
  unitBuff(unit: string, index: number): FrameXmlAuraInfo | undefined;
  unitDebuff(unit: string, index: number): FrameXmlAuraInfo | undefined;
  /** `CancelUnitBuff`, resolved through the same filtered player slot as `UnitAura`. */
  cancelUnitBuff(unit: string, index: number, filter: string | undefined): void;

  // ---- the base minimap -------------------------------------------------
  /** `GetMinimapZoneText()`, or undefined while the zone metadata is unavailable. */
  minimapZoneText(): string | undefined;
  /** `GetZoneText()`, or undefined while the area metadata is unavailable. */
  zoneText(): string | undefined;
  /** `GetSubZoneText()`, or undefined while the area metadata is unavailable. */
  subZoneText(): string | undefined;
  /** `GetZonePVPInfo()`'s tuple, preserving nil positions; undefined means no zone answer. */
  zonePvpInfo(): FrameXmlZonePvpInfo | undefined;

  // ---- the selected target -----------------------------------------------
  /** These are the C-side unit queries TargetFrame.lua reaches for. */
  unitFactionGroup(unit: string): string | undefined;
  unitClassification(unit: string): string | undefined;
  unitIsUnit(left: string, right: string): boolean;
  unitIsPlayer(unit: string): boolean;
  unitIsConnected(unit: string): boolean;
  unitIsDead(unit: string): boolean;
  unitIsGhost(unit: string): boolean;
  unitIsCorpse(unit: string): boolean;
  unitIsFriend(left: string, right: string): boolean;
  unitIsEnemy(left: string, right: string): boolean;
  unitCanAttack(left: string, right: string): boolean;
  unitPlayerControlled(unit: string): boolean;
  unitIsPVP(unit: string): boolean;
  unitIsPVPFreeForAll(unit: string): boolean;
  unitIsTapped(unit: string): boolean;
  unitIsTappedByPlayer(unit: string): boolean;
  unitIsTappedByAllThreatList(unit: string): boolean;
  /** RGB, in the same 0..1 values UnitSelectionColor hands to SetVertexColor. */
  unitSelectionColor(unit: string): readonly [number, number, number] | undefined;

  /** `UnitCastingInfo` for a unit the seam knows, or `undefined` when it is not casting. */
  unitCastingInfo(unit: string): FrameXmlCastingInfo | undefined;
  /** `UnitChannelInfo` for a unit the seam knows, or `undefined` when it is not channeling. */
  unitChannelInfo(unit: string): FrameXmlChannelInfo | undefined;

  // ---- the player spellbook ---------------------------------------------
  /** Number of skill-line tabs currently backed by known, resolved spells. */
  spellTabCount(): number;
  /** `GetSpellTabInfo`'s six values, or nil for an invalid tab. */
  spellTabInfo(index: number): FrameXmlSpellTabInfo | undefined;
  /** `GetSpellName`'s `(name, rank)` for a 1-based spellbook slot. */
  spellName(index: number, bookType: string | undefined): readonly [string, string] | undefined;
  spellTexture(index: number, bookType: string | undefined): string | undefined;
  spellCooldown(index: number, bookType: string | undefined): FrameXmlSpellCooldown;
  spellAutocast(index: number, bookType: string | undefined): readonly [boolean, boolean];
  spellIsPassive(index: number, bookType: string | undefined): boolean | undefined;
  /** The rank-normalized slot; nil when the requested slot does not exist. */
  knownSlotFromHighestRankSlot(index: number, bookType: string | undefined): number | undefined;
  spellIsSelected(index: number, bookType: string | undefined): boolean;
  hasPetSpells(): boolean;
  /** Existing client cast path; invalid/unknown spells are rejected there. */
  castSpell(spell: number, bookType: string | undefined): void;
  /** Tells the host to refresh spellbook state; stock Lua also calls this on load. */
  updateSpells(): void;
  /** A string-valued CVar owned by the settings model, or undefined for neutral fallback. */
  getCVar?(name: string): string | undefined;
  /** The settings model's stock default string, or undefined for neutral fallback. */
  getCVarDefault?(name: string): string | undefined;
  /** A host-backed boolean CVar, or undefined so the neutral string CVar can answer. */
  getCVarBool(name: string): boolean | undefined;
  setCVar(name: string, value: boolean): void;
  /** Writes a stock CVar through the settings model; false preserves neutral behavior. */
  setCVarValue?(name: string, value: unknown): boolean | undefined;

  // ---- player talents ----------------------------------------------------
  /** Immutable player-only projection for Blizzard_TalentUI, or undefined until both packet and DBC are ready. */
  talentSnapshot(): FrameXmlTalentSnapshot | undefined;
  /** Maps Lua's tab/index/group to the existing player talent packet boundary. */
  learnTalent(tab: number, index: number, pet: boolean | undefined, group: number | undefined): void;

  // ---- character skills -----------------------------------------------
  /** Number of visible skill rows, including category headers. */
  skillLineCount(): number;
  /** Exact thirteen-value `GetSkillLineInfo`, or a safe empty row for an invalid index. */
  skillLineInfo(index: number): FrameXmlSkillLineInfo;
  /** Unspent character skill points adjusted by pending skill purchases. */
  adjustedSkillPoints(): number;
  /** Current visible row selection; zero means no visible selection. */
  selectedSkill(): number;
  setSelectedSkill(index: number): void;
  expandSkillHeader(index: number): void;
  collapseSkillHeader(index: number): void;
  /** Unsupported skill training is intentionally a no-op: no client packet path exists. */
  addSkillUp(index: number): void;
  removeSkillUp(index: number): void;
  buySkillTier(index: number): void;
  cancelSkillUps(): void;

  // ---- player containers -----------------------------------------------
  /** Stock bag ids: 0 is the backpack, 1..4 carried bags, -2 the keyring. */
  // ---- honor / PvP statistics ------------------------------------------
  /** `GetPVPSessionStats` — today's honorable kills and contribution points. */
  pvpSessionStats(): readonly [number, number];
  /** `GetPVPYesterdayStats` — yesterday's honorable kills and contribution. */
  pvpYesterdayStats(): readonly [number, number];
  /** `GetPVPLifetimeStats` — lifetime HK and an unavailable rank sentinel. */
  pvpLifetimeStats(): readonly [number, number | undefined];
  /** `GetPVPRankInfo`; an unavailable rank returns nil name and rank number 0. */
  pvpRankInfo(rank: number | undefined): readonly [string | undefined, number];
  /** `UnitPVPRank`; retired rank state is unavailable in this protocol. */
  pvpRank(unit: string): number | undefined;
  /** `GetPVPRankProgress`; zero is the stock-safe unavailable sentinel. */
  pvpRankProgress(): number;
  /** Current honor currency. The max cap is not part of the authoritative player snapshot. */
  pvpHonorCurrency(): number;
  /** Current arena currency. The max cap is not part of the authoritative player snapshot. */
  pvpArenaCurrency(): number;

  // ---- battleground queue ----------------------------------------------
  /** True only when the complete seven-row type-3 catalog is available. */
  battlegroundCatalogReady(): boolean;
  /** Number of supported battleground types, in the catalog's stable order. */
  battlegroundTypeCount(): number;
  /** `GetBattlegroundInfo`'s five-value tuple for a 1-based type index. */
  battlegroundInfo(index: number): readonly [string, boolean, boolean, boolean, number] | undefined;
  /** `GetBattlefieldInfo` for the currently selected stock row. */
  battlefieldInfo(): readonly [string, string, number] | undefined;
  /** The queue slot tuple consumed by PVPBattlegroundFrame's status repaint. */
  battlefieldStatus(index: number): readonly [string, string | undefined, number, number, number, number, boolean];
  /** Requests the server's reward/instance list for a battleground type. */
  requestBattlegroundInstanceInfo(index: number): void;
  /** Joins the currently selected battleground; `true` is the group join button. */
  joinBattleground(asGroup: boolean): void;
  /** Stock sorting is client-local; this seam keeps the catalog's authoritative order. */
  sortBattlegroundList(): void;
  /** Closing the stock queue window has no packet side effect. */
  closeBattleground(): void;
  /** Random and holiday five-value reward tuples, preserving no-bonus false/zero values. */
  randomBattlegroundHonorBonuses(): readonly [boolean, number, number, number, number];
  holidayBattlegroundHonorBonuses(): readonly [boolean, number, number, number, number];
  /** Outdoor Wintergrasp is not part of this queue slice; the timer remains hidden by the gate. */
  wintergraspWaitTime(): number | undefined;
  canQueueForWintergrasp(): boolean;

  // ---- arena battlemaster context --------------------------------------
  /** True only for a fresh battlemaster list (fromWhere=0, bgTypeId=6, non-zero GUID). */
  isBattlefieldArena(): boolean;
  /** World-state 3191 when authoritative; zero is the neutral unavailable value. */
  currentArenaSeason(): number;
  /** Whether the current authoritative battlemaster context permits group queueing. */
  canJoinBattlefieldAsGroup(): boolean;
  /** Sends the exact CMSG_BATTLEMASTER_JOIN_ARENA tuple for the current list. */
  joinArena(arenaSlot: number, asGroup: boolean, rated: boolean): void;

  // ---- merchant ---------------------------------------------------------
  /** Number of vendor rows in the currently opened list. */
  merchantNumItems(): number;
  /** Atomically publish a vendor lifecycle edge and update the seam's dedupe state. */
  merchantChanged(event: "show" | "update" | "closed", force?: boolean): void;
  /** Exact seven-value `GetMerchantItemInfo`, or undefined for a missing row. */
  merchantItemInfo(index: number): FrameXmlMerchantItemInfo | undefined;
  /** The server's link for a vendor row; nil is honest until item data is known. */
  merchantItemLink(index: number): string | undefined;
  /** Max stack for the vendor row, or zero when the host cannot answer it. */
  merchantItemMaxStack(index: number): number;
  /** Extended currency costs are not represented by this host; the neutral tuple is all zero. */
  merchantItemCostInfo(index: number): FrameXmlMerchantCostInfo;
  merchantItemCostItem(index: number, costIndex: number): readonly [string, number, string] | undefined;
  /** Number of currently available buyback rows. */
  buybackNumItems(): number;
  /** Exact six-value `GetBuybackItemInfo`, or undefined for a missing row. */
  buybackItemInfo(index: number): FrameXmlBuybackItemInfo | undefined;
  buybackItemLink(index: number): string | undefined;
  /** Routes stock's one-based BuyMerchantItem index/count to the world purchase path. */
  buyMerchantItem(index: number, count: number): void;
  /** Routes stock's one-based BuybackItem index to the absolute player buyback slot. */
  buybackItem(index: number): void;
  /** Closes the current vendor interaction. */
  closeMerchant(): void;
  /** Repair data is not present in the current world snapshot. */
  canMerchantRepair(): boolean;
  repairAllCost(): readonly [number, boolean];
  canGuildBankRepair(): boolean;
  inRepairMode(): boolean;

  // ---- trainer ----------------------------------------------------------
  /** Visible, metadata-resolved trainer rows in the packet's stable order. */
  trainerServiceCount(): number;
  /** `GetTrainerServiceInfo`'s name/subtext/type/expanded tuple. */
  trainerServiceInfo(index: number): readonly [string, string | undefined, string, boolean] | undefined;
  trainerServiceCost(index: number): readonly [number, number, number];
  trainerServiceLevelReq(index: number): number;
  trainerServiceSkillReq(index: number): readonly [string | undefined, number, boolean];
  trainerServiceNumAbilityReq(index: number): number;
  trainerServiceAbilityReq(index: number, requirement: number): readonly [number, boolean] | undefined;
  trainerServiceStepReq(index: number): readonly [number | undefined, boolean];
  trainerServiceIcon(index: number): string | undefined;
  trainerServiceDescription(index: number): string | undefined;
  trainerServiceSkillLine(index: number): string | undefined;
  trainerServiceItemLink(index: number): string | undefined;
  trainerGreeting(): string | undefined;
  trainerType(): number | undefined;
  trainerSelectionIndex(): number | undefined;
  /** Stable world/trainer/list identity; metadata arrival must not invalidate it. */
  trainerContextSignature(): string;
  selectTrainerService(index: number): void;
  isTradeskillTrainer(): boolean;
  buyTrainerService(index: number): void;
  closeTrainer(): void;
  trainerChanged(event: "show" | "update" | "closed"): void;
  trainerTypeFilter(type: string): boolean;
  setTrainerTypeFilter(type: string, enabled: boolean): void;
  collapseTrainerSkillLine(index: number): void;
  expandTrainerSkillLine(index: number): void;
  characterPoints(unit: string): readonly [number, number];

  containerNumSlots(bagId: number): number;
  /** Free slots and bag-family mask; nil family means the bag metadata is unresolved. */
  containerNumFreeSlots(bagId: number): readonly [number, number | undefined];
  /** `GetContainerItemInfo`'s five values, or nil for an empty/unsupported slot. */
  containerItemInfo(bagId: number, slot: number): FrameXmlContainerItemInfo | undefined;
  /** An authoritative item link, or nil when the host cannot provide one. */
  containerItemLink(bagId: number, slot: number): string | undefined;
  /** `GetContainerItemCooldown`'s `(start, duration, enabled)` tuple. */
  containerItemCooldown(bagId: number, slot: number): FrameXmlContainerItemCooldown;
  /** `GetBagName`, or nil while carried-bag metadata is unresolved. */
  bagName(bagId: number): string | undefined;
  /** `UseContainerItem`; implementations must reject an empty/unsupported slot. */
  useContainerItem(bagId: number, slot: number): void;

  // ---- paper doll -------------------------------------------------------
  /** `GetInventorySlotInfo`; undefined is the stock answer for an unknown slot name. */
  inventorySlotInfo(name: string): FrameXmlInventorySlotInfo | undefined;
  /** Equipment is addressed by the stock 1-based paper-doll slot number. */
  inventoryItemTexture(unit: string, slot: number): string | undefined;
  inventoryItemLink(unit: string, slot: number): string | undefined;
  inventoryItemCount(unit: string, slot: number): number;
  inventoryItemBroken(unit: string, slot: number): boolean;
  inventoryItemCooldown(unit: string, slot: number): FrameXmlContainerItemCooldown;
  /** Neutral false when the host has no item-lock state. */
  inventoryItemLocked(unit: string, slot: number): boolean;
  /** Existing authoritative item-use path; unsupported units/slots are no-ops. */
  useInventoryItem(unit: string, slot: number): void;
  /** There is no authoritative pickup path in the current host; this remains a no-op. */
  pickupInventoryItem(unit: string, slot: number): void;
  /** `UnitStat` uses 1..5 for the five generated STAT0..STAT4 fields. */
  unitStat(unit: string, index: number): FrameXmlUnitStat;
  unitArmor(unit: string): FrameXmlUnitArmor;
  unitResistance(unit: string, index: number): FrameXmlUnitStat;
  unitAttackPower(unit: string): FrameXmlUnitAttackPower;
  unitRangedAttackPower(unit: string): FrameXmlUnitAttackPower;
  /** Derived stat contribution; zero when the host has no authoritative class formula. */
  attackPowerForStat(statIndex: number, statValue: number): number;
  /** Derived agility contribution; zero when the host has no authoritative class formula. */
  critChanceFromAgility(unit: string): number;
  /** Multiplicative health modifier; one is the neutral value without authoritative state. */
  unitMaxHealthModifier(unit: string): number;
  /** Derived spirit regeneration; zero when the unit's regen fields are not authoritative. */
  unitHealthRegenRateFromSpirit(unit: string): number;
  unitManaRegenRateFromSpirit(unit: string): number;
  /** Combat-rating fields are not present in the current world snapshot. */
  combatRating(index: number): number;
  combatRatingBonus(index: number): number;
  armorPenetration(): number;
  critChance(): number;
  expertise(): readonly [number, number];
  expertisePercent(): readonly [number, number];
  /** Main-hand speed and optional off-hand speed; nil off-hand preserves stock no-off-hand logic. */
  unitAttackSpeed(unit: string): readonly [number, number | undefined];
  unitDamage(unit: string): FrameXmlUnitDamage;
  unitRangedDamage(unit: string): FrameXmlUnitRangedDamage;

  // ---- quest log and tracker --------------------------------------------
  /** Number of displayed rows and real quests; this seam has no synthetic headers. */
  questLogEntryCount(): readonly [number, number];
  /** One 1-based quest-log row, or a safe empty row while its template is unresolved. */
  questLogTitle(index: number): FrameXmlQuestLogTitle;
  /** Select one 1-based row; zero clears the selection. */
  selectQuestLogEntry(index: number): void;
  /** The selected 1-based row, or zero when there is no selection. */
  questLogSelection(): number;
  /** Selected quest description/objectives text, or nil before its template arrives. */
  questLogQuestText(index?: number): readonly [string, string] | undefined;
  /** Number of objective rows for a quest-log row (or the current selection). */
  questLogLeaderBoardCount(index?: number): number;
  /** One objective row, preserving nil before the quest template is available. */
  questLogLeaderBoard(objectiveIndex: number, questIndex?: number): FrameXmlQuestLogLeaderBoard | undefined;
  /** Number of fixed reward items on the selected quest. */
  questLogRewardCount(index?: number): number;
  /** Number of choice reward items on the selected quest. */
  questLogChoiceCount(index?: number): number;
  /** One fixed reward item, or nil while its cached item metadata is unresolved. */
  questLogRewardInfo(itemIndex: number, questIndex?: number): FrameXmlQuestItemInfo | undefined;
  /** One choice reward item, or nil while its cached item metadata is unresolved. */
  questLogChoiceInfo(itemIndex: number, questIndex?: number): FrameXmlQuestItemInfo | undefined;
  /** The selected quest's display spell, or nil while spell metadata is unresolved. */
  questLogRewardSpell(index?: number): FrameXmlQuestRewardSpell | undefined;
  /** Positive signed quest money; a negative wire value is exposed by requiredMoney instead. */
  questLogRewardMoney(index?: number): number;
  questLogRewardHonor(index?: number): number;
  questLogRewardArenaPoints(index?: number): number;
  questLogRewardTalents(index?: number): number;
  questLogRewardXP(index?: number): number;
  /** Title reward text is nil when title metadata is not available. */
  questLogRewardTitle(index?: number): string | undefined;
  /** Required copper for a quest, when the host carries that authoritative field. */
  questLogRequiredMoney(index?: number): number;
  /** Seconds remaining for a timed quest, or nil without an authoritative server clock. */
  questLogTimeLeft(index?: number): number | undefined;
  /** Completion prose for the selected quest, or nil before its template arrives. */
  questLogCompletionText(index?: number): string | undefined;
  /** Suggested group size for the selected quest. */
  questLogGroupNum(index?: number): number;
  /** Whether the selected quest is failed according to its state word. */
  questLogCurrentFailed(): boolean;
  /** Refresh the stock current-map POI list and return its visible quest count. */
  questMapUpdateAllQuests(): number;
  /** Return the quest id at a 1-based current-map POI index, or undefined. */
  questPoiQuestIdByVisibleIndex(index: number): number | undefined;
  /** The only watch operations promoted in this read-only seam. */
  questNumWatches(): number;
  questIndexForWatch(index: number): number | undefined;
  questIsWatched(index: number): boolean;
  /** Client-local tracker state; the server has no watch persistence in this host. */
  addQuestWatch(index: number, time?: number): void;
  removeQuestWatch(index: number): void;

  // ---- reputation ------------------------------------------------------
  /** Number of resolved, currently displayed faction rows. */
  factionCount(): number;
  /** Exact thirteen-value `GetFactionInfo` tuple, or nil for an unresolved row. */
  factionInfo(index: number): FrameXmlFactionInfo | undefined;
  /** Current displayed faction selection; zero means no selection. */
  selectedFaction(): number;
  setSelectedFaction(index: number): void;
  /** Exact five-value `GetWatchedFactionInfo` tuple, or nil without a watch. */
  watchedFactionInfo(): FrameXmlWatchedFactionInfo | undefined;
  setWatchedFactionIndex(index: number): void;
  expandFactionHeader(index: number): void;
  collapseFactionHeader(index: number): void;
  isFactionInactive(index: number): boolean;
  setFactionInactive(index: number): void;
  setFactionActive(index: number): void;
  factionToggleAtWar(index: number): void;
  /** Wrath's account expansion and the current host's XP-lock state. */
  accountExpansionLevel(): number;
  isXpUserDisabled(): boolean;
}

/**
 * One C-API name, and how it is answered out of the seam.
 *
 * Data rather than sixteen registrations in `FrameXmlBoot`, for the same reason
 * `FRAMEXML_NEUTRAL_API` is data: the report, the test and the code then cannot drift, and the
 * boot's job stays «hand every one of these to the same machinery».
 */
export type FrameXmlSeamBinding = (
  seam: FrameXmlWorldSeam,
  args: readonly unknown[],
) => readonly unknown[];

function slotOf(value: unknown): number {
  const slot = Number(value);
  return Number.isFinite(slot) ? Math.trunc(slot) : 0;
}

function unitOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function filterOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function questIndexOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const index = Number(value);
  return Number.isFinite(index) ? Math.trunc(index) : undefined;
}

function boolOf(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function chatTargetOf(value: unknown): FrameXmlChatTarget | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : undefined;
}

/** `[]` is «answers nothing», which is nil in Lua; `[undefined]` would be nil too but noisier. */
const NOTHING: readonly unknown[] = Object.freeze([]);

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

function talentGroupOf(snapshot: FrameXmlTalentSnapshot | undefined, value: unknown): number {
  const group = Number(value);
  if (Number.isInteger(group) && group > 0) return Math.trunc(group);
  return snapshot?.activeTalentGroup ?? 0;
}

export const FRAMEXML_SEAM_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  GetRealmName: (seam) => optional(seam.realmName()),
  SendChatMessage: (seam, args) => {
    const text = typeof args[0] === "string" ? args[0] : "";
    const type = typeof args[1] === "string" ? args[1] : "";
    const language = typeof args[2] === "number" && Number.isFinite(args[2])
      ? Math.trunc(args[2])
      : undefined;
    const target = chatTargetOf(args[3]);
    if (target === undefined) return NOTHING;
    seam.sendChatMessage(text, type, language, target);
    return NOTHING;
  },
  GetChatWindowMessages: (seam, args) => [...seam.chatWindowMessages(slotOf(args[0]))],
  GetChatWindowChannels: (seam, args) => [...seam.chatWindowChannels(slotOf(args[0]))],
  GetChatWindowInfo: (seam, args) => seam.chatWindowInfo(slotOf(args[0])) ?? NOTHING,
  HasAction: (seam, args) => [seam.hasAction(slotOf(args[0]))],
  GetActionTexture: (seam, args) => optional(seam.actionTexture(slotOf(args[0]))),
  GetActionText: (seam, args) => optional(seam.actionText(slotOf(args[0]))),
  GetActionTooltip: (seam, args) => {
    const tooltip = seam.actionTooltip(slotOf(args[0]));
    return tooltip === undefined
      ? NOTHING
      : [tooltip.kind, tooltip.id, tooltip.name, tooltip.rank ?? ""];
  },
  GetActionCount: (seam, args) => [seam.actionCount(slotOf(args[0]))],
  GetActionCooldown: (seam, args) => [...seam.actionCooldown(slotOf(args[0]))],
  IsUsableAction: (seam, args) => [...seam.actionUsable(slotOf(args[0]))],
  IsConsumableAction: (seam, args) => [seam.isConsumableAction(slotOf(args[0]))],
  IsStackableAction: (seam, args) => [seam.isStackableAction(slotOf(args[0]))],
  IsEquippedAction: (seam, args) => [seam.isEquippedAction(slotOf(args[0]))],
  IsCurrentAction: (seam, args) => [seam.isCurrentAction(slotOf(args[0]))],
  IsAttackAction: (seam, args) => [seam.isAttackAction(slotOf(args[0]))],
  IsAutoRepeatAction: (seam, args) => [seam.isAutoRepeatAction(slotOf(args[0]))],
  IsActionInRange: (seam, args) => optional(seam.actionInRange(slotOf(args[0]))),
  GetActionBarPage: (seam) => [seam.actionBarPage()],
  GetBonusBarOffset: (seam) => [seam.bonusBarOffset()],
  UseAction: (seam, args) => {
    seam.useAction(slotOf(args[0]), unitOf(args[1]) || undefined, unitOf(args[2]) || undefined);
    return NOTHING;
  },
  UnitExists: (seam, args) => [seam.unitExists(unitOf(args[0]))],
  UnitName: (seam, args) => optional(seam.unitName(unitOf(args[0]))),
  UnitPVPName: (seam, args) => optional(seam.unitPvpName(unitOf(args[0]))),
  UnitLevel: (seam, args) => optional(seam.unitLevel(unitOf(args[0]))),
  UnitClass: (seam, args) => seam.unitClass(unitOf(args[0])) ?? NOTHING,
  UnitRace: (seam, args) => seam.unitRace(unitOf(args[0])) ?? NOTHING,
  UnitSex: (seam, args) => optional(seam.unitSex(unitOf(args[0]))),
  UnitIsConnected: (seam, args) => [seam.unitIsConnected(unitOf(args[0]))],
  UnitHealth: (seam, args) => [seam.unitHealth(unitOf(args[0]))],
  UnitHealthMax: (seam, args) => [seam.unitHealthMax(unitOf(args[0]))],
  // `UnitMana`/`UnitManaMax`, 3.3.5's older spelling of the pair below, are deliberately absent:
  // measured over all 335 files, **zero** call sites. The corpus was updated to `UnitPower`.
  UnitPower: (seam, args) => [seam.unitPower(unitOf(args[0]))],
  UnitPowerMax: (seam, args) => [seam.unitPowerMax(unitOf(args[0]))],
  UnitPowerType: (seam, args) => seam.unitPowerType(unitOf(args[0])) ?? NOTHING,
  UnitXP: (seam, args) => [seam.unitXP(unitOf(args[0]))],
  UnitXPMax: (seam, args) => [seam.unitXPMax(unitOf(args[0]))],
  GetMoney: (seam) => [seam.money()],
  GetNumPartyMembers: (seam) => [seam.partyMemberCount()],
  GetNumRaidMembers: (seam) => [seam.raidMemberCount()],
  IsPartyLeader: (seam) => [seam.isPartyLeader()],
  GetPartyMember: (seam, args) => optional(seam.partyMember(slotOf(args[0]))),
  TargetUnit: (seam, args) => {
    seam.targetUnit(unitOf(args[0]));
    return NOTHING;
  },
  UnitIsVisible: (seam, args) => [seam.unitIsVisible(unitOf(args[0]))],
  UnitIsPossessed: (seam, args) => [seam.unitIsPossessed(unitOf(args[0]))],
  GetPetHappiness: (seam) => seam.petHappiness() ?? NOTHING,
  HasPetUI: (seam) => [...seam.hasPetUI()],
  GetRestState: (seam) => [...seam.restState()],
  UnitAura: (seam, args) => seam.unitAura(
    unitOf(args[0]), slotOf(args[1]), filterOf(args[2]),
  ) ?? NOTHING,
  UnitBuff: (seam, args) => seam.unitBuff(unitOf(args[0]), slotOf(args[1])) ?? NOTHING,
  UnitDebuff: (seam, args) => seam.unitDebuff(unitOf(args[0]), slotOf(args[1])) ?? NOTHING,
  CancelUnitBuff: (seam, args) => {
    seam.cancelUnitBuff(unitOf(args[0]), slotOf(args[1]), filterOf(args[2]));
    return NOTHING;
  },
  UnitFactionGroup: (seam, args) => optional(seam.unitFactionGroup(unitOf(args[0]))),
  UnitClassification: (seam, args) => optional(seam.unitClassification(unitOf(args[0]))),
  UnitIsUnit: (seam, args) => [seam.unitIsUnit(unitOf(args[0]), unitOf(args[1]))],
  UnitIsPlayer: (seam, args) => [seam.unitIsPlayer(unitOf(args[0]))],
  UnitIsDead: (seam, args) => [seam.unitIsDead(unitOf(args[0]))],
  UnitIsGhost: (seam, args) => [seam.unitIsGhost(unitOf(args[0]))],
  UnitIsCorpse: (seam, args) => [seam.unitIsCorpse(unitOf(args[0]))],
  UnitIsFriend: (seam, args) => [seam.unitIsFriend(unitOf(args[0]), unitOf(args[1]))],
  UnitIsEnemy: (seam, args) => [seam.unitIsEnemy(unitOf(args[0]), unitOf(args[1]))],
  UnitCanAttack: (seam, args) => [seam.unitCanAttack(unitOf(args[0]), unitOf(args[1]))],
  UnitPlayerControlled: (seam, args) => [seam.unitPlayerControlled(unitOf(args[0]))],
  UnitIsPVP: (seam, args) => [seam.unitIsPVP(unitOf(args[0]))],
  UnitIsPVPFreeForAll: (seam, args) => [seam.unitIsPVPFreeForAll(unitOf(args[0]))],
  UnitIsTapped: (seam, args) => [seam.unitIsTapped(unitOf(args[0]))],
  UnitIsTappedByPlayer: (seam, args) => [seam.unitIsTappedByPlayer(unitOf(args[0]))],
  UnitIsTappedByAllThreatList: (seam, args) => [seam.unitIsTappedByAllThreatList(unitOf(args[0]))],
  UnitSelectionColor: (seam, args) => seam.unitSelectionColor(unitOf(args[0])) ?? NOTHING,
  UnitCastingInfo: (seam, args) => seam.unitCastingInfo(unitOf(args[0])) ?? NOTHING,
  UnitChannelInfo: (seam, args) => seam.unitChannelInfo(unitOf(args[0])) ?? NOTHING,
  GetNumSpellTabs: (seam) => [seam.spellTabCount()],
  GetSpellTabInfo: (seam, args) => seam.spellTabInfo(slotOf(args[0])) ?? NOTHING,
  GetSpellName: (seam, args) => seam.spellName(slotOf(args[0]), filterOf(args[1])) ?? NOTHING,
  GetSpellTexture: (seam, args) => optional(seam.spellTexture(slotOf(args[0]), filterOf(args[1]))),
  GetSpellCooldown: (seam, args) => [...seam.spellCooldown(slotOf(args[0]), filterOf(args[1]))],
  GetSpellAutocast: (seam, args) => [...seam.spellAutocast(slotOf(args[0]), filterOf(args[1]))],
  IsPassiveSpell: (seam, args) => optional(seam.spellIsPassive(slotOf(args[0]), filterOf(args[1]))),
  GetKnownSlotFromHighestRankSlot: (seam, args) => optional(
    seam.knownSlotFromHighestRankSlot(slotOf(args[0]), filterOf(args[1])),
  ),
  IsSelectedSpell: (seam, args) => [seam.spellIsSelected(slotOf(args[0]), filterOf(args[1]))],
  HasPetSpells: (seam) => [seam.hasPetSpells()],
  CastSpell: (seam, args) => {
    seam.castSpell(slotOf(args[0]), filterOf(args[1]));
    return NOTHING;
  },
  UpdateSpells: (seam) => {
    seam.updateSpells();
    return NOTHING;
  },
  GetCVar: (seam, args) => optional(
    seam.getCVar?.(typeof args[0] === "string" ? args[0] : ""),
  ),
  GetCVarDefault: (seam, args) => optional(
    seam.getCVarDefault?.(typeof args[0] === "string" ? args[0] : ""),
  ),
  GetCVarBool: (seam, args) => optional(
    seam.getCVarBool(typeof args[0] === "string" ? args[0] : ""),
  ),
  SetCVar: (seam, args) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    if (seam.setCVarValue) {
      const handled = seam.setCVarValue(name, args[1]);
      return handled === undefined ? NOTHING : [handled];
    }
    seam.setCVar(name, boolOf(args[1]));
    return NOTHING;
  },
  GetActiveTalentGroup: (seam, args) => {
    if (boolOf(args[0]) || boolOf(args[1])) return [0];
    return [seam.talentSnapshot()?.activeTalentGroup ?? 0];
  },
  GetNumTalentGroups: (seam, args) => {
    if (boolOf(args[0]) || boolOf(args[1])) return [0];
    return [seam.talentSnapshot()?.numTalentGroups ?? 0];
  },
  GetNumTalentTabs: (seam, args) => {
    if (boolOf(args[0]) || boolOf(args[1])) return [0];
    const snapshot = seam.talentSnapshot();
    return [snapshot?.groups[talentGroupOf(snapshot, args[2]) - 1]?.tabs.length ?? 0];
  },
  GetTalentTabInfo: (seam, args) => {
    if (boolOf(args[1]) || boolOf(args[2])) return NOTHING;
    const snapshot = seam.talentSnapshot();
    const tab = snapshot?.groups[talentGroupOf(snapshot, args[3]) - 1]?.tabs[slotOf(args[0]) - 1];
    // Preview allocations are deliberately unsupported in this player-only slice. The stock
    // TalentFrame nevertheless adds this value numerically, so the honest empty preview is 0,
    // not Lua nil (which aborts the first tab refresh).
    return tab ? [tab.name, tab.iconTexture, tab.pointsSpent, tab.background, tab.previewPointsSpent ?? 0] : NOTHING;
  },
  GetNumTalents: (seam, args) => {
    if (boolOf(args[1]) || boolOf(args[2])) return [0];
    const snapshot = seam.talentSnapshot();
    return [snapshot?.groups[talentGroupOf(snapshot, args[3]) - 1]?.tabs[slotOf(args[0]) - 1]?.talents.length ?? 0];
  },
  GetTalentInfo: (seam, args) => {
    if (boolOf(args[2]) || boolOf(args[3])) return NOTHING;
    const snapshot = seam.talentSnapshot();
    const group = snapshot?.groups[talentGroupOf(snapshot, args[4]) - 1];
    const cell = group?.tabs[slotOf(args[0]) - 1]?.talents[slotOf(args[1]) - 1];
    if (!cell) return NOTHING;
    return [
      cell.name,
      cell.iconTexture,
      cell.tier,
      cell.column,
      cell.rank,
      cell.maxRank,
      cell.isExceptional,
      cell.meetsPrereq,
      cell.previewRank,
      cell.meetsPreviewPrereq,
    ];
  },
  GetTalentPrereqs: (seam, args) => {
    if (boolOf(args[2]) || boolOf(args[3])) return NOTHING;
    const snapshot = seam.talentSnapshot();
    const group = snapshot?.groups[talentGroupOf(snapshot, args[4]) - 1];
    const cell = group?.tabs[slotOf(args[0]) - 1]?.talents[slotOf(args[1]) - 1];
    if (!cell) return NOTHING;
    const values: unknown[] = [];
    for (const prerequisite of cell.prerequisites) {
      values.push(prerequisite.tier, prerequisite.column, prerequisite.meetsPrereq, prerequisite.meetsPreviewPrereq);
    }
    return values;
  },
  GetUnspentTalentPoints: (seam, args) => {
    if (boolOf(args[0]) || boolOf(args[1])) return [0];
    const snapshot = seam.talentSnapshot();
    return [snapshot?.groups[talentGroupOf(snapshot, args[2]) - 1]?.unspentPoints ?? 0];
  },
  GetGroupPreviewTalentPointsSpent: () => [0],
  LearnTalent: (seam, args) => {
    // Lua's PlayerTalentFrame uses the selected tab's actual one-based slot. A zero is an
    // invalid/unselected tab and must remain invalid here; the stock owner initializes selection
    // through PlayerTalentFrame_Toggle before any learn click reaches this boundary.
    seam.learnTalent(slotOf(args[0]), slotOf(args[1]), boolOf(args[2]),
      Number.isFinite(Number(args[3])) ? Math.trunc(Number(args[3])) : undefined);
    return NOTHING;
  },
  GetNumSkillLines: (seam) => [seam.skillLineCount()],
  GetSkillLineInfo: (seam, args) => [...seam.skillLineInfo(slotOf(args[0]))],
  GetAdjustedSkillPoints: (seam) => [seam.adjustedSkillPoints()],
  GetSelectedSkill: (seam) => [seam.selectedSkill()],
  SetSelectedSkill: (seam, args) => {
    seam.setSelectedSkill(slotOf(args[0]));
    return NOTHING;
  },
  ExpandSkillHeader: (seam, args) => {
    seam.expandSkillHeader(slotOf(args[0]));
    return NOTHING;
  },
  CollapseSkillHeader: (seam, args) => {
    seam.collapseSkillHeader(slotOf(args[0]));
    return NOTHING;
  },
  AddSkillUp: (seam, args) => {
    seam.addSkillUp(slotOf(args[0]));
    return NOTHING;
  },
  RemoveSkillUp: (seam, args) => {
    seam.removeSkillUp(slotOf(args[0]));
    return NOTHING;
  },
  BuySkillTier: (seam, args) => {
    seam.buySkillTier(slotOf(args[0]));
    return NOTHING;
  },
  CancelSkillUps: (seam) => {
    seam.cancelSkillUps();
    return NOTHING;
  },
  GetPVPSessionStats: (seam) => [...seam.pvpSessionStats()],
  GetPVPYesterdayStats: (seam) => [...seam.pvpYesterdayStats()],
  GetPVPLifetimeStats: (seam) => [...seam.pvpLifetimeStats()],
  GetPVPRankInfo: (seam, args) => [...seam.pvpRankInfo(
    typeof args[0] === "number" && Number.isFinite(args[0]) ? Math.trunc(args[0]) : undefined,
  )],
  UnitPVPRank: (seam, args) => optional(seam.pvpRank(unitOf(args[0]))),
  GetPVPRankProgress: (seam) => [seam.pvpRankProgress()],
  GetHonorCurrency: (seam) => [seam.pvpHonorCurrency()],
  GetArenaCurrency: (seam) => [seam.pvpArenaCurrency()],
  GetNumBattlegroundTypes: (seam) => [seam.battlegroundTypeCount()],
  GetBattlegroundInfo: (seam, args) => seam.battlegroundInfo(slotOf(args[0])) ?? NOTHING,
  GetBattlefieldInfo: (seam) => seam.battlefieldInfo() ?? NOTHING,
  GetBattlefieldStatus: (seam, args) => [...seam.battlefieldStatus(slotOf(args[0]))],
  RequestBattlegroundInstanceInfo: (seam, args) => {
    seam.requestBattlegroundInstanceInfo(slotOf(args[0]));
    return NOTHING;
  },
  JoinBattlefield: (seam, args) => {
    // ArenaFrame passes a 1-based arena selection and a third rated flag; the stock
    // battleground page passes zero and only the group flag.  Dispatch by that exact
    // call shape so a fresh arena list cannot steal the existing battleground route,
    // while a stale arena-shaped call remains a neutral no-op.
    const selection = slotOf(args[0]);
    if (selection >= 1 && selection <= 3) {
      if (seam.isBattlefieldArena()) {
        seam.joinArena(selection - 1, boolOf(args[1]), boolOf(args[2]));
      }
      return NOTHING;
    }
    if (selection !== 0) return NOTHING;
    seam.joinBattleground(boolOf(args[1]));
    return NOTHING;
  },
  SortBGList: (seam) => {
    seam.sortBattlegroundList();
    return NOTHING;
  },
  CloseBattlefield: (seam) => {
    seam.closeBattleground();
    return NOTHING;
  },
  GetRandomBGHonorCurrencyBonuses: (seam) => [...seam.randomBattlegroundHonorBonuses()],
  GetHolidayBGHonorCurrencyBonuses: (seam) => [...seam.holidayBattlegroundHonorBonuses()],
  GetWintergraspWaitTime: (seam) => optional(seam.wintergraspWaitTime()),
  CanQueueForWintergrasp: (seam) => [seam.canQueueForWintergrasp()],
  IsBattlefieldArena: (seam) => [seam.isBattlefieldArena()],
  GetCurrentArenaSeason: (seam) => [seam.currentArenaSeason()],
  CanJoinBattlefieldAsGroup: (seam) => [seam.canJoinBattlefieldAsGroup()],
  GetMerchantNumItems: (seam) => [seam.merchantNumItems()],
  GetMerchantItemInfo: (seam, args) => seam.merchantItemInfo(slotOf(args[0])) ?? NOTHING,
  GetMerchantItemLink: (seam, args) => optional(seam.merchantItemLink(slotOf(args[0]))),
  GetMerchantItemMaxStack: (seam, args) => [seam.merchantItemMaxStack(slotOf(args[0]))],
  GetMerchantItemCostInfo: (seam, args) => [...seam.merchantItemCostInfo(slotOf(args[0]))],
  GetMerchantItemCostItem: (seam, args) => seam.merchantItemCostItem(slotOf(args[0]), slotOf(args[1])) ?? NOTHING,
  GetNumBuybackItems: (seam) => [seam.buybackNumItems()],
  GetBuybackItemInfo: (seam, args) => seam.buybackItemInfo(slotOf(args[0])) ?? NOTHING,
  GetBuybackItemLink: (seam, args) => optional(seam.buybackItemLink(slotOf(args[0]))),
  BuyMerchantItem: (seam, args) => {
    seam.buyMerchantItem(slotOf(args[0]), Math.max(1, slotOf(args[1]) || 1));
    return NOTHING;
  },
  BuybackItem: (seam, args) => {
    seam.buybackItem(slotOf(args[0]));
    return NOTHING;
  },
  CloseMerchant: (seam) => {
    seam.closeMerchant();
    return NOTHING;
  },
  GetNumTrainerServices: (seam) => [seam.trainerServiceCount()],
  GetTrainerServiceInfo: (seam, args) => seam.trainerServiceInfo(slotOf(args[0])) ?? NOTHING,
  GetTrainerServiceCost: (seam, args) => [...seam.trainerServiceCost(slotOf(args[0]))],
  GetTrainerServiceLevelReq: (seam, args) => [seam.trainerServiceLevelReq(slotOf(args[0]))],
  GetTrainerServiceSkillReq: (seam, args) => [...seam.trainerServiceSkillReq(slotOf(args[0]))],
  GetTrainerServiceNumAbilityReq: (seam, args) => [seam.trainerServiceNumAbilityReq(slotOf(args[0]))],
  GetTrainerServiceAbilityReq: (seam, args) => seam.trainerServiceAbilityReq(
    slotOf(args[0]), slotOf(args[1]),
  ) ?? NOTHING,
  GetTrainerServiceStepReq: (seam, args) => [...seam.trainerServiceStepReq(slotOf(args[0]))],
  GetTrainerServiceIcon: (seam, args) => optional(seam.trainerServiceIcon(slotOf(args[0]))),
  GetTrainerServiceDescription: (seam, args) => optional(seam.trainerServiceDescription(slotOf(args[0]))),
  GetTrainerServiceSkillLine: (seam, args) => optional(seam.trainerServiceSkillLine(slotOf(args[0]))),
  GetTrainerServiceItemLink: (seam, args) => optional(seam.trainerServiceItemLink(slotOf(args[0]))),
  GetTrainerGreetingText: (seam) => optional(seam.trainerGreeting()),
  GetTrainerSelectionIndex: (seam) => optional(seam.trainerSelectionIndex()),
  SelectTrainerService: (seam, args) => {
    seam.selectTrainerService(slotOf(args[0]));
    return NOTHING;
  },
  IsTradeskillTrainer: (seam) => [seam.isTradeskillTrainer()],
  BuyTrainerService: (seam, args) => {
    seam.buyTrainerService(slotOf(args[0]));
    return NOTHING;
  },
  CloseTrainer: (seam) => {
    seam.closeTrainer();
    return NOTHING;
  },
  GetTrainerServiceTypeFilter: (seam, args) => [
    seam.trainerTypeFilter(typeof args[0] === "string" ? args[0] : ""),
  ],
  SetTrainerServiceTypeFilter: (seam, args) => {
    seam.setTrainerTypeFilter(typeof args[0] === "string" ? args[0] : "", boolOf(args[1]));
    return NOTHING;
  },
  CollapseTrainerSkillLine: (seam, args) => {
    seam.collapseTrainerSkillLine(slotOf(args[0]));
    return NOTHING;
  },
  ExpandTrainerSkillLine: (seam, args) => {
    seam.expandTrainerSkillLine(slotOf(args[0]));
    return NOTHING;
  },
  UnitCharacterPoints: (seam, args) => [...seam.characterPoints(unitOf(args[0]))],
  PickupMerchantItem: () => NOTHING,
  CanMerchantRepair: (seam) => [seam.canMerchantRepair()],
  GetRepairAllCost: (seam) => [...seam.repairAllCost()],
  CanGuildBankRepair: (seam) => [seam.canGuildBankRepair()],
  InRepairMode: (seam) => [seam.inRepairMode()],
  GetContainerNumSlots: (seam, args) => [seam.containerNumSlots(slotOf(args[0]))],
  GetContainerNumFreeSlots: (seam, args) => {
    const [free, family] = seam.containerNumFreeSlots(slotOf(args[0]));
    return family === undefined ? [free] : [free, family];
  },
  GetContainerItemInfo: (seam, args) => seam.containerItemInfo(
    slotOf(args[0]), slotOf(args[1]),
  ) ?? NOTHING,
  GetContainerItemLink: (seam, args) => optional(
    seam.containerItemLink(slotOf(args[0]), slotOf(args[1])),
  ),
  GetContainerItemCooldown: (seam, args) => [
    ...seam.containerItemCooldown(slotOf(args[0]), slotOf(args[1])),
  ],
  GetBagName: (seam, args) => optional(seam.bagName(slotOf(args[0]))),
  UseContainerItem: (seam, args) => {
    seam.useContainerItem(slotOf(args[0]), slotOf(args[1]));
    return NOTHING;
  },
  GetInventorySlotInfo: (seam, args) => seam.inventorySlotInfo(
    typeof args[0] === "string" ? args[0] : "",
  ) ?? NOTHING,
  GetInventoryItemTexture: (seam, args) => optional(
    seam.inventoryItemTexture(unitOf(args[0]), slotOf(args[1])),
  ),
  GetInventoryItemLink: (seam, args) => optional(
    seam.inventoryItemLink(unitOf(args[0]), slotOf(args[1])),
  ),
  GetInventoryItemCount: (seam, args) => [
    seam.inventoryItemCount(unitOf(args[0]), slotOf(args[1])),
  ],
  IsInventoryItemBroken: (seam, args) => [
    seam.inventoryItemBroken(unitOf(args[0]), slotOf(args[1])),
  ],
  GetInventoryItemCooldown: (seam, args) => [
    ...seam.inventoryItemCooldown(unitOf(args[0]), slotOf(args[1])),
  ],
  IsInventoryItemLocked: (seam, args) => [
    seam.inventoryItemLocked(unitOf(args[0]), slotOf(args[1])),
  ],
  UseInventoryItem: (seam, args) => {
    seam.useInventoryItem(unitOf(args[0]), slotOf(args[1]));
    return NOTHING;
  },
  PickupInventoryItem: (seam, args) => {
    seam.pickupInventoryItem(unitOf(args[0]), slotOf(args[1]));
    return NOTHING;
  },
  UnitStat: (seam, args) => [...seam.unitStat(unitOf(args[0]), slotOf(args[1]))],
  UnitArmor: (seam, args) => [...seam.unitArmor(unitOf(args[0]))],
  UnitResistance: (seam, args) => [...seam.unitResistance(unitOf(args[0]), slotOf(args[1]))],
  UnitAttackPower: (seam, args) => [...seam.unitAttackPower(unitOf(args[0]))],
  UnitRangedAttackPower: (seam, args) => [...seam.unitRangedAttackPower(unitOf(args[0]))],
  GetAttackPowerForStat: (seam, args) => [seam.attackPowerForStat(slotOf(args[0]), Number(args[1]))],
  GetCritChanceFromAgility: (seam, args) => [seam.critChanceFromAgility(unitOf(args[0]))],
  GetUnitMaxHealthModifier: (seam, args) => [seam.unitMaxHealthModifier(unitOf(args[0]))],
  GetUnitHealthRegenRateFromSpirit: (seam, args) => [seam.unitHealthRegenRateFromSpirit(unitOf(args[0]))],
  GetUnitManaRegenRateFromSpirit: (seam, args) => [seam.unitManaRegenRateFromSpirit(unitOf(args[0]))],
  GetCombatRating: (seam, args) => [seam.combatRating(slotOf(args[0]))],
  GetCombatRatingBonus: (seam, args) => [seam.combatRatingBonus(slotOf(args[0]))],
  GetArmorPenetration: (seam) => [seam.armorPenetration()],
  GetCritChance: (seam) => [seam.critChance()],
  GetExpertise: (seam) => [...seam.expertise()],
  GetExpertisePercent: (seam) => [...seam.expertisePercent()],
  UnitAttackSpeed: (seam, args) => [...seam.unitAttackSpeed(unitOf(args[0]))],
  UnitDamage: (seam, args) => [...seam.unitDamage(unitOf(args[0]))],
  UnitRangedDamage: (seam, args) => [...seam.unitRangedDamage(unitOf(args[0]))],
  GetNumQuestLogEntries: (seam) => [...seam.questLogEntryCount()],
  GetQuestLogTitle: (seam, args) => [...seam.questLogTitle(slotOf(args[0]))],
  SelectQuestLogEntry: (seam, args) => {
    seam.selectQuestLogEntry(slotOf(args[0]));
    return NOTHING;
  },
  GetQuestLogSelection: (seam) => [seam.questLogSelection()],
  GetQuestLogQuestText: (seam, args) => {
    const text = seam.questLogQuestText(questIndexOf(args[0]));
    return text === undefined ? NOTHING : [...text];
  },
  GetNumQuestLeaderBoards: (seam, args) => [
    seam.questLogLeaderBoardCount(questIndexOf(args[0])),
  ],
  GetQuestLogLeaderBoard: (seam, args) => {
    const row = seam.questLogLeaderBoard(slotOf(args[0]), questIndexOf(args[1]));
    return row === undefined ? NOTHING : [...row];
  },
  GetNumQuestLogRewards: (seam, args) => [
    seam.questLogRewardCount(questIndexOf(args[0])),
  ],
  GetNumQuestLogChoices: (seam, args) => [
    seam.questLogChoiceCount(questIndexOf(args[0])),
  ],
  GetQuestLogRewardInfo: (seam, args) => {
    const row = seam.questLogRewardInfo(slotOf(args[0]), questIndexOf(args[1]));
    return row === undefined ? NOTHING : [...row];
  },
  GetQuestLogChoiceInfo: (seam, args) => {
    const row = seam.questLogChoiceInfo(slotOf(args[0]), questIndexOf(args[1]));
    return row === undefined ? NOTHING : [...row];
  },
  GetQuestLogRewardSpell: (seam, args) => {
    const row = seam.questLogRewardSpell(questIndexOf(args[0]));
    return row === undefined ? NOTHING : [...row];
  },
  GetQuestLogRewardMoney: (seam, args) => [
    seam.questLogRewardMoney(questIndexOf(args[0])),
  ],
  GetQuestLogRewardHonor: (seam, args) => [
    seam.questLogRewardHonor(questIndexOf(args[0])),
  ],
  GetQuestLogRewardArenaPoints: (seam, args) => [
    seam.questLogRewardArenaPoints(questIndexOf(args[0])),
  ],
  GetQuestLogRewardTalents: (seam, args) => [
    seam.questLogRewardTalents(questIndexOf(args[0])),
  ],
  GetQuestLogRewardXP: (seam, args) => [
    seam.questLogRewardXP(questIndexOf(args[0])),
  ],
  GetQuestLogRewardTitle: (seam, args) => optional(
    seam.questLogRewardTitle(questIndexOf(args[0])),
  ),
  GetQuestLogRequiredMoney: (seam, args) => [
    seam.questLogRequiredMoney(questIndexOf(args[0])),
  ],
  GetQuestLogTimeLeft: (seam, args) => optional(
    seam.questLogTimeLeft(questIndexOf(args[0])),
  ),
  GetQuestLogCompletionText: (seam, args) => optional(
    seam.questLogCompletionText(questIndexOf(args[0])),
  ),
  GetQuestLogGroupNum: (seam, args) => [
    seam.questLogGroupNum(questIndexOf(args[0])),
  ],
  IsCurrentQuestFailed: (seam) => [seam.questLogCurrentFailed()],
  QuestMapUpdateAllQuests: (seam) => [seam.questMapUpdateAllQuests()],
  QuestPOIGetQuestIDByVisibleIndex: (seam, args) => optional(
    seam.questPoiQuestIdByVisibleIndex(slotOf(args[0])),
  ),
  GetNumQuestWatches: (seam) => [seam.questNumWatches()],
  GetQuestIndexForWatch: (seam, args) => optional(
    seam.questIndexForWatch(slotOf(args[0])),
  ),
  IsQuestWatched: (seam, args) => [seam.questIsWatched(slotOf(args[0]))],
  AddQuestWatch: (seam, args) => {
    seam.addQuestWatch(slotOf(args[0]), questIndexOf(args[1]));
    return NOTHING;
  },
  RemoveQuestWatch: (seam, args) => {
    seam.removeQuestWatch(slotOf(args[0]));
    return NOTHING;
  },
  GetNumFactions: (seam) => [seam.factionCount()],
  GetFactionInfo: (seam, args) => seam.factionInfo(slotOf(args[0])) ?? NOTHING,
  GetSelectedFaction: (seam) => [seam.selectedFaction()],
  SetSelectedFaction: (seam, args) => {
    seam.setSelectedFaction(slotOf(args[0]));
    return NOTHING;
  },
  GetWatchedFactionInfo: (seam) => seam.watchedFactionInfo() ?? NOTHING,
  SetWatchedFactionIndex: (seam, args) => {
    seam.setWatchedFactionIndex(slotOf(args[0]));
    return NOTHING;
  },
  ExpandFactionHeader: (seam, args) => {
    seam.expandFactionHeader(slotOf(args[0]));
    return NOTHING;
  },
  CollapseFactionHeader: (seam, args) => {
    seam.collapseFactionHeader(slotOf(args[0]));
    return NOTHING;
  },
  IsFactionInactive: (seam, args) => [seam.isFactionInactive(slotOf(args[0]))],
  SetFactionInactive: (seam, args) => {
    seam.setFactionInactive(slotOf(args[0]));
    return NOTHING;
  },
  SetFactionActive: (seam, args) => {
    seam.setFactionActive(slotOf(args[0]));
    return NOTHING;
  },
  FactionToggleAtWar: (seam, args) => {
    seam.factionToggleAtWar(slotOf(args[0]));
    return NOTHING;
  },
  GetAccountExpansionLevel: (seam) => [seam.accountExpansionLevel()],
  IsXPUserDisabled: (seam) => [seam.isXpUserDisabled()],
  GetMinimapZoneText: (seam) => optional(seam.minimapZoneText()),
  GetZoneText: (seam) => optional(seam.zoneText()),
  GetSubZoneText: (seam) => optional(seam.subZoneText()),
  GetZonePVPInfo: (seam) => {
    const info = seam.zonePvpInfo();
    return info === undefined ? NOTHING : [...info];
  },
});

/** Every name the seam answers, in report order. */
export const FRAMEXML_SEAM_NAMES: readonly string[] = Object.freeze(
  Object.keys(FRAMEXML_SEAM_BINDINGS),
);

/**
 * The Lua half: point the neutral API's implementation table at the host bindings.
 *
 * Assignment rather than a wrapper for ordinary names, because `FrameXmlBoot`'s `_G` metamethod
 * already wraps `__fxNeutralImpl[name]` in the counting stub that records the first touch — so a
 * seam answer lands in the same census, with the same counter, as an F2 constant. CVars are the
 * exception: the neutral API owns the fallback string-valued CVar map, while a settings-backed
 * seam owns only names it can answer truthfully. Their bindings are composed below: supported
 * names never enter the fallback map, while unsupported names retain the neutral round-trip.
 */
export const FRAMEXML_SEAM_PRELUDE = `
do
  local impl, names = __fxNeutralImpl, __fxSeamNames or {}
  for index = 1, #names do
    local name = names[index]
    local binding = rawget(_G, "__fxSeam_" .. name)
    if binding ~= nil and name ~= "GetCVar" and name ~= "GetCVarDefault"
      and name ~= "GetCVarBool" and name ~= "SetCVar" then
      impl[name] = binding
    end
  end

  local getCVar = rawget(_G, "__fxSeam_GetCVar")
  if getCVar ~= nil then
    local neutralGetCVar = impl.GetCVar
    impl.GetCVar = function(...)
      local hostValue = getCVar(...)
      if hostValue ~= nil then return hostValue end
      if neutralGetCVar ~= nil then return neutralGetCVar(...) end
    end
  end

  local getCVarDefault = rawget(_G, "__fxSeam_GetCVarDefault")
  if getCVarDefault ~= nil then
    local neutralGetCVarDefault = impl.GetCVarDefault
    impl.GetCVarDefault = function(...)
      local hostValue = getCVarDefault(...)
      if hostValue ~= nil then return hostValue end
      if neutralGetCVarDefault ~= nil then return neutralGetCVarDefault(...) end
    end
  end

  local getCVarBool = rawget(_G, "__fxSeam_GetCVarBool")
  if getCVarBool ~= nil then
    local neutralGetCVarBool = impl.GetCVarBool
    impl.GetCVarBool = function(...)
      local hostValue = getCVarBool(...)
      if hostValue ~= nil then return hostValue end
      if neutralGetCVarBool ~= nil then return neutralGetCVarBool(...) end
    end
  end

  local setCVar = rawget(_G, "__fxSeam_SetCVar")
  if setCVar ~= nil then
    local neutralSetCVar = impl.SetCVar
    impl.SetCVar = function(...)
      local handled = setCVar(...)
      if handled == true then return end
      if handled == false then
        if neutralSetCVar ~= nil then neutralSetCVar(...) end
        return
      end
      if neutralSetCVar ~= nil then return neutralSetCVar(...) end
      return handled
    end
  end
end
`;
