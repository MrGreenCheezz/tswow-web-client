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
 *   state rather than world seam values. `FrameXmlMap` separately projects `GetPlayerMapPosition`
 *   through the selected DBC map and floor for the original world map.
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
import type { FrameXmlLootMethod } from "./FrameXmlGroupLoot.js";
import { FRAMEXML_QUEST_MENU_DATA_BINDINGS } from "./FrameXmlQuestMenuData.js";
import { FRAMEXML_QUEST_GIVER_DATA_BINDINGS } from "./FrameXmlQuestGiverData.js";
import { FRAMEXML_QUEST_REWARD_DATA_BINDINGS } from "./FrameXmlQuestRewardData.js";
import { FRAMEXML_QUEST_FLAGS_DATA_BINDINGS } from "./FrameXmlQuestFlagsData.js";
import { FRAMEXML_WORLD_STATE_BINDINGS, type FrameXmlWorldStates } from "./FrameXmlWorldStates.js";
import { FRAMEXML_CALENDAR_SEAM_BINDINGS, type FrameXmlCalendar } from "./FrameXmlCalendar.js";
import { FRAMEXML_HUD_MECHANICS_BINDINGS, type FrameXmlHudMechanics } from "./FrameXmlHudMechanics.js";
import { FRAMEXML_MAP_BINDINGS, type FrameXmlMap } from "./FrameXmlMap.js";
import { FRAMEXML_LFD_BINDINGS, FRAMEXML_LFD_PRELUDE, type FrameXmlLfdModel } from "./FrameXmlLfd.js";
import { FRAMEXML_LOOT_BINDINGS, FRAMEXML_LOOT_PRELUDE, type FrameXmlLootModel } from "./FrameXmlLoot.js";
import { FRAMEXML_POPUPS_BINDINGS, FRAMEXML_POPUPS_PRELUDE, type FrameXmlPopupsModel } from "./FrameXmlPopups.js";
import { FRAMEXML_FRIENDS_BINDINGS, FRAMEXML_FRIENDS_PRELUDE, type FrameXmlFriendsModel } from "./FrameXmlFriends.js";
import { FRAMEXML_AUTOCOMPLETE_BINDINGS, type FrameXmlAutoCompleteModel } from "./FrameXmlAutoComplete.js"; // L5c 3.18
import { FRAMEXML_MAIL_BINDINGS, FRAMEXML_MAIL_PRELUDE, type FrameXmlMailModel } from "./FrameXmlMail.js";
import { FRAMEXML_TRADE_BINDINGS, type FrameXmlTradeModel } from "./FrameXmlTrade.js";
import { FRAMEXML_CURRENCY_BINDINGS, type FrameXmlCurrencyModel } from "./FrameXmlCurrency.js";
import { FRAMEXML_TRADESKILL_BINDINGS, FRAMEXML_TRADESKILL_PRELUDE, type FrameXmlTradeSkillModel } from "./FrameXmlTradeSkill.js";
import { FRAMEXML_NPC_WINDOW_BINDINGS, type FrameXmlNpcWindowModels } from "./FrameXmlGossipSeam.js";
import { createFrameXmlServices, FRAMEXML_SERVICE_BINDINGS, type FrameXmlServices } from "./FrameXmlServices.js";
import { FRAMEXML_AUCTION_BINDINGS, type FrameXmlAuctionModel } from "./FrameXmlAuction.js";
import { FRAMEXML_ACHIEVEMENT_BINDINGS, type FrameXmlAchievementModel } from "./FrameXmlAchievement.js";
import { FRAMEXML_GUILDBANK_BINDINGS, type FrameXmlGuildBankModel } from "./FrameXmlGuildBank.js";
import { FRAMEXML_MACRO_BINDINGS, type FrameXmlMacroModel } from "./FrameXmlMacro.js";
import type { MacroContext } from "../macro/MacroOptions.js";
import { FRAMEXML_COMBAT_LOG_BINDINGS, type FrameXmlCombatLogModel } from "./FrameXmlCombatLog.js";
import { frameXmlMultiCastBindings, type FrameXmlMultiCastModel } from "./FrameXmlMultiCast.js";
import { FRAMEXML_CURSOR_BINDINGS, type FrameXmlActionButton, type FrameXmlCursorModel } from "./FrameXmlCursor.js";
import { FRAMEXML_CURSOR_MONEY_BINDINGS } from "./FrameXmlCursorMoney.js"; // L5c 3.09
import { FRAMEXML_REPAIR_BINDINGS, type FrameXmlRepairModel } from "./FrameXmlRepair.js";
import { FRAMEXML_BINDING_BINDINGS, FRAMEXML_BINDING_PRELUDE, type FrameXmlBindingModel } from "./FrameXmlBinding.js";
import { FRAMEXML_CHAT_COLOR_BINDINGS, type FrameXmlChatColors } from "./FrameXmlChatColors.js";
import { FRAMEXML_RAID_LOD_BINDINGS } from "./FrameXmlRaidLodApi.js";
import { FRAMEXML_ARENA_BINDINGS } from "./FrameXmlArenaApi.js";
import type { FrameXmlArenaOpponents } from "./FrameXmlArena.js";
import { FRAMEXML_PVP_FLAG_BINDINGS, type FrameXmlPvpFlagModel } from "./FrameXmlPvpFlag.js";
import { FRAMEXML_SCOREBOARD_BINDINGS, type FrameXmlBattlefieldScoreModel } from "./FrameXmlScoreboard.js";
import { FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS, type FrameXmlAreaSpiritHealerModel } from "./FrameXmlAreaSpiritHealer.js"; // L3 5.25
import { FRAMEXML_DIFFICULTY_BINDINGS, type FrameXmlDifficultyModel } from "./FrameXmlDifficulty.js";
import { FRAMEXML_TALENT_GROUP_BINDINGS, type FrameXmlTalentGroupModel } from "./FrameXmlTalentGroup.js";
import { FRAMEXML_TRAINER_SKILL_LINE_BINDINGS, type FrameXmlTrainerSkillLineModel } from "./FrameXmlTrainerSkillLines.js"; // L12 3.29
import { FRAMEXML_TALENT_PREVIEW_BINDINGS, type FrameXmlTalentPreviewModel } from "./FrameXmlTalentPreview.js";
import { FRAMEXML_CREATURE_TYPE_BINDINGS } from "./FrameXmlCreatureType.js";
import { FRAMEXML_SERVER_PROMPTS_BINDINGS, type FrameXmlServerPromptsModel } from "./FrameXmlServerPrompts.js";
import { frameXmlQuestPoiBindings, type FrameXmlQuestPoiModel } from "./FrameXmlQuestPoi.js";
import { FRAMEXML_QUEST_SHARE_BINDINGS, type FrameXmlQuestShareModel } from "./FrameXmlQuestShare.js";
import { FRAMEXML_SUPPORT_BINDINGS, type FrameXmlSupportModel } from "./FrameXmlSupport.js";
import { FRAMEXML_QUEST_LOG_BINDINGS, FRAMEXML_QUEST_LOG_PRELUDE, type FrameXmlQuestLogModel } from "./FrameXmlQuestLog.js";
import { FRAMEXML_BAG_PORTRAIT_PRELUDE, FRAMEXML_RELIC_SLOT_BINDINGS } from "./FrameXmlRelicSlot.js";
import { FRAMEXML_ARENA_ROSTER_BINDINGS, type FrameXmlArenaRosterModel } from "./FrameXmlArenaRoster.js";
import type { FrameXmlSocketModel } from "./FrameXmlSocketModel.js";
import { FRAMEXML_INSPECT_BINDINGS, FRAMEXML_INSPECT_PRELUDE, type FrameXmlInspectModel } from "./FrameXmlInspect.js";
import { FRAMEXML_BARBER_BINDINGS, type FrameXmlBarberModel } from "./FrameXmlBarber.js";
import { FRAMEXML_COMPANION_BINDINGS, type FrameXmlCompanionModel } from "./FrameXmlCompanions.js";
import { FRAMEXML_PET_DECLENSION_BINDINGS, type FrameXmlPetDeclensionModel } from "./FrameXmlPetDeclension.js"; // L17 3.09
import {
  FRAMEXML_PET_ACTION_BINDINGS, frameXmlWithPetBook, type FrameXmlPetActionBar,
} from "./FrameXmlPetActionBar.js";
import { frameXmlWithPossess, type FrameXmlPossessModel } from "./FrameXmlPossess.js"; // 11.02-IF
import { FRAMEXML_VEHICLE_PRELUDE, frameXmlWithVehicle, type FrameXmlVehicleModel } from "./FrameXmlVehicle.js"; // 11.02-F2
import { frameXmlWithVehicleAim, type FrameXmlVehicleAimModel } from "./FrameXmlVehicleAim.js"; // 11.02-E
import { FRAMEXML_GLYPH_BINDINGS, type FrameXmlGlyphModel } from "./FrameXmlGlyph.js";
import { FRAMEXML_ITEM_TARGETING_BINDINGS } from "./FrameXmlItemTargeting.js";
import { FRAMEXML_REFUND_BINDINGS } from "./FrameXmlRefund.js";
import { FRAMEXML_TITLE_BINDINGS, type FrameXmlTitleModel } from "./FrameXmlTitles.js";
import { FRAMEXML_EQUIPMENT_SET_BINDINGS, type FrameXmlEquipmentSetModel } from "./FrameXmlEquipmentSets.js";
import { FRAMEXML_ITEM_ACTION_BINDINGS, FRAMEXML_ITEM_ACTIONS_PRELUDE } from "./FrameXmlItemActions.js";
import { FRAMEXML_DURABILITY_BINDINGS } from "./FrameXmlDurabilityFrame.js";
import { FRAMEXML_OPTIONS_BINDINGS, type FrameXmlOptionsModel } from "./FrameXmlOptions.js";
import { FRAMEXML_PLAYER_STATUS_BINDINGS, type FrameXmlPlayerStatus } from "./FrameXmlPlayerStatus.js";
import { FRAMEXML_UNIT_RELATION_BINDINGS, type FrameXmlUnitRelations } from "./FrameXmlUnitRelations.js";
import { FRAMEXML_CONTROL_BINDINGS, type FrameXmlPlayerControl } from "./FrameXmlControl.js";
import { FRAMEXML_GROUP_COMMAND_BINDINGS, type FrameXmlGroupCommandsModel } from "./FrameXmlGroupCommands.js";
import { FRAMEXML_TARGETING_BINDINGS, type FrameXmlTargeting } from "./FrameXmlTargetingApi.js";
import { FRAMEXML_TARGET_NEAREST_BINDINGS, type FrameXmlTargetNearest } from "./FrameXmlTargetNearest.js"; // L2 1.10
import { FRAMEXML_MECHANICS_BINDINGS, FRAMEXML_MECHANICS_PRELUDE, type FrameXmlMechanicsModel } from "./FrameXmlMechanics.js";
import type { FrameXmlThreatModel } from "./FrameXmlThreat.js";
import type { FrameXmlQuestAbandonModel } from "./FrameXmlQuestAbandon.js";
import type { FrameXmlChatWindowFlags } from "./FrameXmlChatWindowFlags.js";

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

/** `GetSpellInfo`'s seven DBC-backed values for an already resolved spell. */
export type FrameXmlSpellInfo = readonly [
  name: string,
  rank: string,
  icon: string,
  castTime: number,
  minRange: number,
  maxRange: number,
  spellId: number,
];

/** `GetSpellCooldown`'s GetTime-based `(start, duration, enabled)` tuple. */
export type FrameXmlSpellCooldown = readonly [
  start: number,
  duration: number,
  enabled: number,
];

/** The four values consumed by stock `ShapeshiftBar_Update`. */
export type FrameXmlShapeshiftFormInfo = readonly [
  texture: string, name: string, isActive: boolean, isCastable: boolean,
];

/** `GetMirrorTimerInfo`: an absent slot returns only the stock UNKNOWN token. */
export type FrameXmlMirrorTimerInfo = readonly ["UNKNOWN"] | readonly [
  timer: "BREATH" | "EXHAUSTION", valueMs: number, maxMs: number,
  scale: number, paused: number, label: string,
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

/** The three values returned by `GetMerchantItemCostInfo`. */
export type FrameXmlMerchantCostInfo = readonly [
  honorPoints: number,
  arenaPoints: number,
  itemCount: number,
];

/** The cached name/link/rarity prefix of the 3.3.5 `GetItemInfo` tuple. */
export type FrameXmlItemInfo = readonly [name: string, link: string, quality: number];

/** Resolve a numeric item id or a native item hyperlink without trusting its display text. */
export function frameXmlItemEntry(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /(?:^|\|H)item:(\d+)(?::|\||$)/.exec(value);
  const entry = match ? Number(match[1]) : undefined;
  return entry !== undefined && Number.isSafeInteger(entry) && entry > 0 ? entry : undefined;
}

/**
 * `GetItemInfo` of a name or of an ID written as a string, which the client reads as a number
 * (`lua_isnumber`): the client answers any item it knows. Here an ID is the item cache's first, and
 * both are an item the player holds — the equipment, then the backpack and the four carried bags —
 * found by its link's entry or the name the link shows, case aside. Stock `/cast` and `/use` ask it to
 * tell an item from a spell (ChatFrame.lua:1033).
 */
function frameXmlItemInfoByName(seam: FrameXmlWorldSeam, value: unknown): FrameXmlItemInfo | undefined {
  if (typeof value !== "string") return undefined;
  const wanted = value.trim().toLowerCase();
  if (!wanted || wanted.includes("|h")) return undefined;
  const id = /^\d+$/.test(wanted) ? Number(wanted) : undefined;
  const cached = id === undefined ? undefined : seam.itemInfo(id);
  if (cached) return cached;
  const held = (link: string | undefined, quality: number | undefined): FrameXmlItemInfo | undefined => {
    const name = link === undefined ? undefined : /\|h\[([^\]]*)\]\|h/.exec(link)?.[1];
    if (link === undefined || name === undefined) return undefined;
    if (id === undefined ? name.toLowerCase() !== wanted : frameXmlItemEntry(link) !== id) return undefined;
    return seam.itemInfo(link) ?? (quality === undefined ? undefined : [name, link, quality]);
  };
  for (let slot = 1; slot <= 19; slot += 1) {
    const info = held(seam.inventoryItemLink("player", slot), undefined);
    if (info) return info;
  }
  for (let bag = 0; bag <= 4; bag += 1) {
    for (let slot = 1; slot <= seam.containerNumSlots(bag); slot += 1) {
      const info = held(seam.containerItemLink(bag, slot), seam.containerItemInfo(bag, slot)?.[3]);
      if (info) return info;
    }
  }
  return undefined;
}

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

/**
 * The `FCF_GetChatWindowInfo` ten-return tuple used by ChatFrame configuration.
 *
 * `docked` is the dock slot, not a flag: `FloatingChatFrame_Update` hands it straight to
 * `FCF_DockFrame(frame, docked)`, whose `FCFDock_AddChatFrame` inserts at that position
 * (FloatingChatFrame.lua:151, 1987-1988). Window 1 answers `true` — it is the dock's primary and
 * is already docked, so the position is never compared — and any other docked window its slot.
 */
export type FrameXmlChatWindowInfo = readonly [
  name: string,
  fontSize: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
  shown: boolean,
  locked: boolean,
  docked: number | boolean,
  uninteractable: boolean,
];

/**
 * Chat window 2 as the 3.3.5 client's default `chat-cache.txt` has it: the «Журнал боя» tab,
 * docked in slot 2 beside «Общий» and not shown (`SHOWN 0` — a docked window that is not the
 * dock's selection). Its message and channel lists stay empty on purpose: the mount mirrors the
 * native combat feed into `ChatFrame2` (`FrameXmlChatApi.ts`), and a stock group registered here as
 * well would print every combat line twice. The name is `COMBAT_LOG` from the dataset's
 * GlobalStrings.lua:1716; enUS is the client's own «Combat Log».
 *
 * `shown` must stay false. `FloatingChatFrame_Update`'s shown branch (FloatingChatFrame.lua:138-142)
 * runs `ChatFrame2:Show()` and `FCF_SetTabPosition(ChatFrame2, 0)` on every UPDATE_CHAT_WINDOWS,
 * and `FCF_DockFrame` then returns early for a frame already docked (:1468), so the dock never
 * repairs it: measured, the second update left ChatFrame2 shown over the selected ChatFrame1 and
 * its tab anchored on ChatFrame2Background right over «Общий». Not shown and docked is the
 * branch that leaves it alone, and `FCFDock_UpdateTabs` still shows the tab.
 */
export function frameXmlCombatLogWindowInfo(locale = "ruRU"): FrameXmlChatWindowInfo {
  return [locale === "enUS" ? "Combat Log" : "Журнал боя", 14, 1, 1, 1, 0, false, true, 2, false];
}

/**
 * Chat window 1, «Общий» — the dock's primary — with the chat cache's SHOWN flag as ChatFrame1
 * last wrote it (`setChatWindowShown`; true until it writes anything).
 *
 * The 3.3.5 client answers `shown` from that cache, and ChatFrame1 keeps it true to the dock
 * itself: selecting «Журнал боя» hides it, and its OnHide writes `SetChatWindowShown(1, nil)`;
 * selecting «Общий» shows it and its OnShow writes 1 (FloatingChatFrame.xml:718, :729). The client
 * raises UPDATE_CHAT_WINDOWS only when chat settings load; this seam also raises it when the channel
 * list stock reads changes (a /join, a /leave, a zone crossing — `LiveWorldSeam`), and a constant
 * `true` there made `FloatingChatFrame_Update(1)` and `ChatFrame_ConfigEventHandler`
 * (FloatingChatFrame.lua:138-142, ChatFrame.lua:2506-2508) show ChatFrame1 over the selected combat
 * log. With the cache's answer that update only re-registers window 1's groups and channels, and
 * the dock keeps its selection: measured over the MPQ corpus and a real WorldClient, a /join, a zone
 * crossing into the shorter «Общий: Даларан» and a /leave with «Журнал боя» selected left
 * ChatFrame1 hidden, ChatFrame2 shown and its tab beside «Общий», and «Общий» had every line when
 * reselected; before, the /join showed both frames. Window 2 keeps its constant not-shown answer:
 * see {@link frameXmlCombatLogWindowInfo} for why its shown branch must never run after docking.
 */
export function frameXmlGeneralWindowInfo(shown = true): FrameXmlChatWindowInfo {
  return ["Общий", 14, 1, 1, 1, 0, shown, true, true, false];
}

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

/** `ChatMsg` 0x17/0x18 in SharedDefines.h: the auto-reply toggles stock `/afk` and `/dnd` send. */
const CHAT_MSG_AFK = 0x17;
const CHAT_MSG_DND = 0x18;

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
  // ChatFrame.lua:1936-1941 `SlashCmdList["CHAT_AFK"/"CHAT_DND"]` send `SendChatMessage(msg,
  // "AFK"|"DND")`, usually with an empty msg. TrinityCore's HandleMessagechatOpcode reads a bare
  // CString for both and treats an empty one as meaningful (ChatHandler.cpp:235-236, 528-564):
  // it toggles the state off, or sets the server's default auto-reply.
  AFK: CHAT_MSG_AFK,
  DND: CHAT_MSG_DND,
});

/**
 * `Languages.dbc` names, per client locale, as stock ChatFrame's `arg3` needs them.
 *
 * Measured from this dataset's `dbc/Languages.dbc` (17 rows, ruRU string column) on 2026-09-24;
 * the file is the client's own and the gateway has no route for it, so the rows are carried here
 * the way `FRAMEXML_INVENTORY_SLOTS` carries the paper-doll table. The case is the client's: the
 * ruRU rows are lower-case («всеобщий»), and stock prints `"["..arg3.."] "` verbatim.
 *
 * Id 0 (`LANG_UNIVERSAL`) has no row, so the client has no name for it and answers "" — stock
 * ChatFrame.lua:2901 hides the bracket for an empty `arg3`. (Its `arg3 ~= "Universal"` literal
 * only ever matched an enUS string.) Only the three ids this client previously named keep their
 * English spelling for other locales; no enUS table was measured, so none is invented.
 */
const FRAMEXML_LANGUAGE_NAMES_BY_LOCALE: Readonly<Record<string, Readonly<Record<number, string>>>> = Object.freeze({
  ruRU: Object.freeze({
    0: "", 1: "орочий", 2: "дарнасский", 3: "таурахэ", 6: "дворфийский", 7: "всеобщий",
    8: "язык демонов", 9: "язык титанов", 10: "талассийский", 11: "драконий", 12: "калимаг",
    13: "гномский", 14: "язык троллей", 33: "наречие нежити", 35: "дренейский",
    36: "наречие зомби", 37: "машинный гномский", 38: "машинный гоблинский",
  }),
  enUS: Object.freeze({ 0: "", 1: "Orcish", 7: "Common" }),
});

/**
 * `SkillLine` ids of the language skills, from TrinityCore's `lang_description` (ObjectMgr.cpp:170)
 * and `SkillType` (SharedDefines.h:2902-3008). A player knows a language exactly when the matching
 * skill is in `PLAYER_SKILL_INFO_1_1`; this is how `GetNumLanguages` enumerates without a guess.
 */
export const FRAMEXML_LANGUAGE_SKILLS: Readonly<Record<number, number>> = Object.freeze({
  1: 109, 2: 113, 3: 115, 6: 111, 7: 98, 8: 139, 9: 140, 10: 137, 11: 138, 12: 141,
  13: 313, 14: 315, 33: 673, 35: 759,
});

function languageTable(locale: string | undefined): Readonly<Record<number, string>> {
  return FRAMEXML_LANGUAGE_NAMES_BY_LOCALE[locale ?? "ruRU"] ?? FRAMEXML_LANGUAGE_NAMES_BY_LOCALE.enUS!;
}

/** The client's display name for a language id; "" for Universal and for an unnamed id. */
export function frameXmlLanguageName(language: number, locale = "ruRU"): string {
  return languageTable(locale)[language] ?? "";
}

/**
 * The language id for a stock language *name*.
 *
 * Stock `ChatEdit_OnLoad` stores `GetDefaultLanguage()` in `editBox.language`, and every outbound
 * `SendChatMessage` passes that string back (ChatFrame.lua:3669-3686), so the seam has to accept
 * the name form as well as the numeric one. Case-insensitive; unknown names answer undefined.
 */
export function frameXmlLanguageId(name: string, locale = "ruRU"): number | undefined {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return undefined;
  for (const [id, label] of Object.entries(languageTable(locale))) {
    if (label && label.toLocaleLowerCase() === wanted) return Number(id);
  }
  return undefined;
}

/**
 * Escape a line this client wrote itself so stock FrameXML shows it as written.
 *
 * A FontString parses every `|` (FrameXmlText.ts), and `|n` is a line break: the native help line
 * «/vehicle enter|leave|next|prev|eject» reached ChatFrame1 as two lines broken inside «next». The
 * client's rule is that a literal pipe is written `||`. Only sequences that are well formed *and*
 * that this client writes on purpose survive: `||`, `|cAARRGGBB` … `|r` (an `|r` with no open colour
 * is prose), a whole `|H…|h…|h` link, a whole `|T…|t` icon, a `|4sing:plur;` plural and a `|3-N(`
 * declension that closes. Everything else — `|n` included — is doubled.
 */
export function frameXmlEscapeLocalChatText(text: string): string {
  if (!text.includes("|")) return text;
  let output = "";
  let colors = 0;
  let at = 0;
  while (at < text.length) {
    const character = text[at]!;
    if (character !== "|") {
      output += character;
      at += 1;
      continue;
    }
    const rest = text.slice(at);
    const sequence = /^\|\|/.exec(rest)?.[0]
      ?? /^\|[cC][0-9a-fA-F]{8}/.exec(rest)?.[0]
      ?? /^\|H[^|]*\|h[^|]*\|h/.exec(rest)?.[0]
      ?? /^\|T[^|]*\|t/.exec(rest)?.[0]
      ?? /^\|4[^:;|]*:[^;|]*;/.exec(rest)?.[0]
      ?? (/^\|3-\d+\([^|)]*\)/.test(rest) ? /^\|3-\d+\(/.exec(rest)?.[0] : undefined)
      ?? (colors > 0 ? /^\|[rR]/.exec(rest)?.[0] : undefined);
    if (sequence === undefined) {
      output += "||";
      at += 1;
      continue;
    }
    if (/^\|[cC]/.test(sequence)) colors += 1;
    else if (/^\|[rR]$/.test(sequence)) colors -= 1;
    output += sequence;
    at += sequence.length;
  }
  return output;
}

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

/**
 * Convert a wire GUID to a stable Lua-safe textual value: Wow.exe's "0x" and sixteen upper-case hex
 * digits (0x0074d0d0, the form UnitGUID and the combat log hand out — add-ons written against the
 * real client compare it with upper-case literals such as "0xF13").
 */
export function frameXmlGuid(guid: bigint): string {
  return guid === 0n ? "" : `0x${guid.toString(16).toUpperCase().padStart(16, "0")}`;
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

/**
 * Match the 255-byte server limit without splitting a UTF-8 code point.
 *
 * Empty text is refused except for the AFK/DND toggles, where the server gives an empty auto-reply
 * its own meaning (see `FRAMEXML_CHAT_OUTBOUND_TYPES`).
 */
export function frameXmlChatTextIsValid(text: string, type?: number): boolean {
  if (text.length === 0) return type === CHAT_MSG_AFK || type === CHAT_MSG_DND;
  return utf8Length(text) <= FRAMEXML_CHAT_MAX_BYTES;
}

/** Build stock ChatFrame's twelve arguments from the client's already parsed message. */
export function frameXmlChatEventArgs(
  message: ChatMessage,
  sender = message.senderName,
  lineId = 0,
  channelNumber = 0,
  channelName = message.channel,
  channelString?: string,
  locale = "ruRU",
  /** `arg7`: a built-in channel's ChatChannels id, which stock matches against `zoneChannelList`. */
  zoneChannelId = 0,
): FrameXmlChatEventArgs {
  const flags = [
    (message.tag & 1) !== 0 ? "AFK" : "",
    (message.tag & 2) !== 0 ? "DND" : "",
    (message.tag & 4) !== 0 ? "GM" : "",
  ].filter(Boolean).join(" ");
  return [
    message.text,
    message.type === CHAT_MSG_WHISPER_INFORM ? message.receiverName : sender,
    frameXmlLanguageName(message.language, locale),
    channelString ?? (channelNumber > 0 ? `${channelNumber}. ${channelName}` : channelName),
    message.receiverName,
    flags,
    zoneChannelId,
    channelNumber,
    channelName,
    0,
    lineId,
    frameXmlGuid(message.senderGuid),
  ];
}

/**
 * `SMSG_CHANNEL_NOTIFY` codes (Channel.h `ChatNotify`) by the `arg1` token stock ChatFrame looks up
 * as `CHAT_<token>_NOTICE`, and whether the notice names a player (`CHAT_MSG_CHANNEL_NOTICE_USER`,
 * formatted with `arg2`/`arg5`, ChatFrame.lua:2778-2790) or not (`CHAT_MSG_CHANNEL_NOTICE`,
 * :2791-2802). Every token here has its `CHAT_*_NOTICE` string in the dataset's GlobalStrings.lua;
 * `NOT_IN_LFG` (0x21) has none, so stock would `format(nil, …)` and it stays a system line.
 * `MODE_CHANGE` (0x0c) is spelled out by {@link frameXmlChannelNotice}; `JOINED`/`LEFT` (0x00/0x01),
 * another player coming and going, are the `CHANNEL_JOIN`/`CHANNEL_LEAVE` chat types instead.
 */
const FRAMEXML_CHANNEL_NOTICE_TOKENS: Readonly<Record<number, readonly [token: string, user: boolean]>> = Object.freeze({
  0x02: ["YOU_JOINED", false],
  0x03: ["YOU_LEFT", false],
  0x04: ["WRONG_PASSWORD", false],
  0x05: ["NOT_MEMBER", false],
  0x06: ["NOT_MODERATOR", false],
  0x07: ["PASSWORD_CHANGED", true],
  0x08: ["OWNER_CHANGED", true],
  0x09: ["PLAYER_NOT_FOUND", true],
  0x0a: ["NOT_OWNER", false],
  0x0b: ["CHANNEL_OWNER", true],
  0x0d: ["ANNOUNCEMENTS_ON", true],
  0x0e: ["ANNOUNCEMENTS_OFF", true],
  0x0f: ["MODERATION_ON", true],
  0x10: ["MODERATION_OFF", true],
  0x11: ["MUTED", false],
  0x12: ["PLAYER_KICKED", true],
  0x13: ["BANNED", false],
  0x14: ["PLAYER_BANNED", true],
  0x15: ["PLAYER_UNBANNED", true],
  0x16: ["PLAYER_NOT_BANNED", true],
  0x17: ["PLAYER_ALREADY_MEMBER", true],
  0x18: ["INVITE", true],
  0x19: ["INVITE_WRONG_FACTION", false],
  0x1a: ["WRONG_FACTION", false],
  0x1b: ["INVALID_NAME", false],
  0x1c: ["NOT_MODERATED", false],
  0x1d: ["PLAYER_INVITED", true],
  0x1e: ["PLAYER_INVITE_BANNED", true],
  0x1f: ["THROTTLED", false],
  0x20: ["NOT_IN_AREA", false],
  0x22: ["VOICE_ON", true],
  0x23: ["VOICE_OFF", true],
});

/** `ChannelMemberFlags` (Channel.h) a `MODE_CHANGE` compares. */
const CHANNEL_MEMBER_MODERATOR = 0x02;
const CHANNEL_MEMBER_VOICED = 0x04;
const CHANNEL_MEMBER_MUTED = 0x08;

/** The stock event and `arg1` for one channel notify, or undefined when stock has no words for it. */
export interface FrameXmlChannelNotice {
  readonly event: "CHAT_MSG_CHANNEL_NOTICE" | "CHAT_MSG_CHANNEL_NOTICE_USER"
    | "CHAT_MSG_CHANNEL_JOIN" | "CHAT_MSG_CHANNEL_LEAVE";
  /** `arg1`: the `CHAT_<token>_NOTICE` key; "" for a join or leave, whose `arg1` is the (empty) text. */
  readonly token: string;
}

/**
 * Which stock event one `SMSG_CHANNEL_NOTIFY` becomes.
 *
 * A `MODE_CHANGE` carries the member's old and new flags and stock has a sentence per direction:
 * moderator given or taken (`SET_/UNSET_MODERATOR`); the mute is the permission to talk
 * (`SET_/UNSET_VOICE`, «получает разрешение на общение»); the voiced bit is voice chat
 * (`SET_/UNSET_SPEAK`, «…право на голосовое общение»). That split is read off the dataset's own
 * wording, GlobalStrings.lua; a change of the owner bit alone has its own `OWNER_CHANGED` notify
 * and answers undefined here.
 */
export function frameXmlChannelNotice(
  code: number, oldFlags = 0, newFlags = 0,
): FrameXmlChannelNotice | undefined {
  if (code === 0x00) return { event: "CHAT_MSG_CHANNEL_JOIN", token: "" };
  if (code === 0x01) return { event: "CHAT_MSG_CHANNEL_LEAVE", token: "" };
  if (code === 0x0c) {
    const changed = oldFlags ^ newFlags;
    const gained = (bit: number): boolean => (newFlags & bit) !== 0;
    const token = (changed & CHANNEL_MEMBER_MODERATOR) !== 0
      ? gained(CHANNEL_MEMBER_MODERATOR) ? "SET_MODERATOR" : "UNSET_MODERATOR"
      : (changed & CHANNEL_MEMBER_MUTED) !== 0
        ? gained(CHANNEL_MEMBER_MUTED) ? "UNSET_VOICE" : "SET_VOICE"
        : (changed & CHANNEL_MEMBER_VOICED) !== 0
          ? gained(CHANNEL_MEMBER_VOICED) ? "SET_SPEAK" : "UNSET_SPEAK"
          : undefined;
    return token === undefined ? undefined : { event: "CHAT_MSG_CHANNEL_NOTICE_USER", token };
  }
  const known = FRAMEXML_CHANNEL_NOTICE_TOKENS[code];
  if (!known) return undefined;
  return { event: known[1] ? "CHAT_MSG_CHANNEL_NOTICE_USER" : "CHAT_MSG_CHANNEL_NOTICE", token: known[0] };
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
 * Drag-grid events remain owned by the renderer. Stance and combo events below are sourced from
 * the known spell list, player fields, auras, cooldowns and combo-point packet.
 */
export const FRAMEXML_SEAM_EVENTS = Object.freeze({
  actionState: "ACTIONBAR_UPDATE_STATE",
  actionUsable: "ACTIONBAR_UPDATE_USABLE",
  actionCooldown: "ACTIONBAR_UPDATE_COOLDOWN",
  actionSlotChanged: "ACTIONBAR_SLOT_CHANGED",
  actionPageChanged: "ACTIONBAR_PAGE_CHANGED",
  mirrorTimerStart: "MIRROR_TIMER_START",
  mirrorTimerStop: "MIRROR_TIMER_STOP",
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
  // 3.02 (FrameXmlCastEvents.ts).
  castSent: "UNIT_SPELLCAST_SENT",
  castSucceeded: "UNIT_SPELLCAST_SUCCEEDED",
  castFailedQuiet: "UNIT_SPELLCAST_FAILED_QUIET",
  zoneChanged: "ZONE_CHANGED",
  zoneChangedNewArea: "ZONE_CHANGED_NEW_AREA",
  zoneChangedIndoors: "ZONE_CHANGED_INDOORS",
  // 5.18: following (input/Follow.ts) for ZoneText.lua's AutoFollowStatus.
  autofollowBegin: "AUTOFOLLOW_BEGIN",
  autofollowEnd: "AUTOFOLLOW_END",
  spellsChanged: "SPELLS_CHANGED",
  learnedSpellInTab: "LEARNED_SPELL_IN_TAB",
  spellUpdateCooldown: "SPELL_UPDATE_COOLDOWN",
  updateShapeshiftForm: "UPDATE_SHAPESHIFT_FORM",
  updateShapeshiftForms: "UPDATE_SHAPESHIFT_FORMS",
  updateShapeshiftUsable: "UPDATE_SHAPESHIFT_USABLE",
  updateShapeshiftCooldown: "UPDATE_SHAPESHIFT_COOLDOWN",
  updateBonusActionBar: "UPDATE_BONUS_ACTIONBAR",
  unitComboPoints: "UNIT_COMBO_POINTS",
  bankFrameOpened: "BANKFRAME_OPENED",
  bankFrameClosed: "BANKFRAME_CLOSED",
  playerBankBagSlotsChanged: "PLAYERBANKBAGSLOTS_CHANGED",
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
  /** The player's dungeon-finder role byte changed; PlayerFrame_UpdateRolesAssigned reads it back. */
  playerRolesAssigned: "PLAYER_ROLES_ASSIGNED",
  /**
   * A battlemaster list/reward response arrived: the data for the stock PVPBattlegroundFrame, which
   * repaints on PVPQUEUE_ANYWHERE_SHOW. Not PVPQUEUE_ANYWHERE_UPDATE_AVAILABLE — that one tells the
   * frame its list is stale, and its handler (PVPBattleground_ResetInfo) asks for the list again,
   * so answering every list with it ping-ponged CMSG/SMSG_BATTLEFIELD_LIST about twenty times a
   * second for the whole session (live recording 27.09).
   */
  battlefieldList: "PVPQUEUE_ANYWHERE_SHOW",
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
  petTalentsChanged: "PET_TALENT_UPDATE",
  /** The settled world pick under the cursor changed; GameTooltip.xml tests `IsUnit("mouseover")`. */
  mouseover: "UPDATE_MOUSEOVER_UNIT",
  /** Minimap.xml:479, MiniMapTracking — the active tracking aura changed. */
  tracking: "MINIMAP_UPDATE_TRACKING",
  /** Minimap.xml:141, MiniMapMailFrame — `HasNewMail` may have changed. */
  pendingMail: "UPDATE_PENDING_MAIL",
  /** Minimap.xml:549, MiniMapLFGFrame — `GetLFGMode`'s derived mode changed. */
  lfgUpdate: "LFG_UPDATE",
  /** Minimap.xml:735, MiniMapInstanceDifficulty — the instance or its difficulty changed. */
  instanceInfo: "UPDATE_INSTANCE_INFO",
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

/** `GetTrackingInfo(i)`'s four values, in the client's order (Minimap.lua:430). */
export type FrameXmlTrackingInfo = readonly [name: string, texture: string, active: boolean, category: string];

/** The picture `GetTrackingTexture` answers while nothing is tracked (Minimap.lua:409-411). */
export const FRAMEXML_TRACKING_NONE_TEXTURE = "Interface\\Minimap\\Tracking\\None";

/** `GetLFGMode`'s `(mode, submode)`; stock Minimap.lua:214-326 switches on both strings. */
export type FrameXmlLfgMode = readonly [mode: string, submode?: string];

/** `GetInstanceInfo`'s seven values (Minimap.lua:486). */
export type FrameXmlInstanceInfo = readonly [
  name: string,
  instanceType: string,
  difficulty: number,
  difficultyName: string,
  maxPlayers: number,
  playerDifficulty: number,
  isDynamicInstance: boolean,
];

/** The world facts `frameXmlLfgMode` reads; a structural subset of `WorldClient`. */
export interface FrameXmlLfgSource {
  readonly lfgStatus?: { readonly joined: boolean; readonly queued: boolean } | undefined;
  readonly lfgProposal?: {
    readonly state: number;
    readonly players: readonly { readonly self: boolean; readonly answered: boolean; readonly accepted: boolean }[];
  } | undefined;
  readonly lfgRoleCheck?: { readonly state: number } | undefined;
  /** `GROUPTYPE_*` bits of the current group, and whether this player leads it. */
  readonly groupType?: number | undefined;
  readonly isGroupLeader?: boolean | undefined;
  readonly inGroup?: boolean | undefined;
}

/** `LfgProposalState` and `LfgRoleCheckState` values TrinityCore's LFG manager sends. */
const LFG_PROPOSAL_INITIATING = 0;
const LFG_ROLECHECK_INITIALITING = 2;
const GROUPTYPE_LFG = 0x08;

/**
 * Derive the stock `GetLFGMode` answer from this client's dungeon-finder packets.
 *
 * The client keeps no mode string of its own; this is the smallest mapping the stock minimap eye
 * needs, kept in one pure function so the full LFD owner can reuse it. Precedence follows what the
 * packets mean: an open proposal outranks a running role check, which outranks a plain queue
 * (`SMSG_LFG_UPDATE_PLAYER/PARTY` with `joined` and `queued`), which outranks being inside a
 * finder group (`GROUPTYPE_LFG`). `submode` is «empowered» for a solo player or the leader, since
 * only they may leave the queue (Minimap.lua:266 disables LEAVE_QUEUE for «unempowered»).
 */
export function frameXmlLfgMode(source: FrameXmlLfgSource): FrameXmlLfgMode | undefined {
  const proposal = source.lfgProposal;
  if (proposal && proposal.state === LFG_PROPOSAL_INITIATING) {
    const self = proposal.players.find((player) => player.self);
    return ["proposal", self?.answered && self.accepted ? "accepted" : "unaccepted"];
  }
  if (source.lfgRoleCheck?.state === LFG_ROLECHECK_INITIALITING) return ["rolecheck"];
  const empowered = !source.inGroup || source.isGroupLeader === true;
  if (source.lfgStatus?.joined && source.lfgStatus.queued) {
    return ["queued", empowered ? "empowered" : "unempowered"];
  }
  if (source.groupType !== undefined && (source.groupType & GROUPTYPE_LFG) !== 0) return ["lfgparty"];
  return undefined;
}

export interface FrameXmlWorldSeam {
  readonly worldStates?: FrameXmlWorldStates;
  readonly calendar?: FrameXmlCalendar;
  readonly map?: FrameXmlMap;
  /** The stock totem bar, hit indicator and temporary weapon enchants (FrameXmlHudMechanics.ts). */
  readonly hudMechanics?: FrameXmlHudMechanics;
  /** 3.01: the combat log's buffer, filters and C API (FrameXmlCombatLog.ts); absent: an empty log. */
  readonly combatLog?: FrameXmlCombatLogModel;
  /** 3.07: the Call of the Elements bar's C API (FrameXmlMultiCast.ts); absent: no totem spells. */
  readonly multiCast?: FrameXmlMultiCastModel;
  /** The stock dungeon finder's C API and its LFG_* events (FrameXmlLfd.ts). */
  readonly lfd?: FrameXmlLfdModel;
  /** The stock LootFrame/GroupLootFrame C API and its loot and loot-roll events (FrameXmlLoot.ts). */
  readonly loot?: FrameXmlLootModel;
  /** The stock StaticPopup/ReadyCheckFrame confirmations' C API and events (FrameXmlPopups.ts). */
  readonly popups?: FrameXmlPopupsModel;
  /** The stock FriendsFrame/RaidFrame C API (friends, ignore, who, guild, raid) and events (FrameXmlFriends.ts). */
  readonly friends?: FrameXmlFriendsModel;
  /** L5c 3.18: the stock AutoComplete's name list behind GetAutoCompleteResults (FrameXmlAutoComplete.ts). */
  readonly autoComplete?: FrameXmlAutoCompleteModel;
  /** The stock MailFrame/OpenMailFrame C API, its send draft and MAIL_* events (FrameXmlMail.ts). */
  readonly mail?: FrameXmlMailModel;
  /** The stock TradeFrame C API and its TRADE_* events (FrameXmlTrade.ts). */
  readonly trade?: FrameXmlTradeModel;
  /** The stock currency C API (Blizzard_TokenUI, the backpack strip) and its two events (FrameXmlCurrency.ts). */
  readonly currency?: FrameXmlCurrencyModel;
  /** The enemy arena team (`arenaN`/`arenapetN`) Blizzard_ArenaUI reads (FrameXmlArena.ts). */
  readonly arena?: FrameXmlArenaOpponents;
  /** The stock TradeSkillFrame (Blizzard_TradeSkillUI) C API and its TRADE_SKILL_* events (FrameXmlTradeSkill.ts). */
  readonly tradeSkill?: FrameXmlTradeSkillModel;
  /** The stock AuctionFrame (Blizzard_AuctionUI) C API and its AUCTION_* events (FrameXmlAuction.ts). */
  readonly auction?: FrameXmlAuctionModel;
  /** The stock achievement C API (Blizzard_AchievementUI, WatchFrame, the alert) and its events (FrameXmlAchievement.ts). */
  readonly achievement?: FrameXmlAchievementModel;
  /** The stock GuildBankFrame (Blizzard_GuildBankUI) C API, its vault cursor and GUILDBANK* events (FrameXmlGuildBank.ts). */
  readonly guildBank?: FrameXmlGuildBankModel;
  /** The macro C API over this client's macro store, and the macro cursor (FrameXmlMacro.ts). */
  readonly macros?: FrameXmlMacroModel;
  /**
   * What macro conditions — `SecureCmdOptionParse`'s `[combat]`, `[@focus,help]`, `[stance:2]` —
   * are evaluated against: this seam's own answers to the same questions (macro/MacroContext.ts).
   */
  macroContext?(): MacroContext;
  /** The one cursor over every holder: spells, lifted actions, items for the bars (FrameXmlCursor.ts). */
  readonly cursor?: FrameXmlCursorModel;
  /** The merchant's repair and the repair cursor (FrameXmlRepair.ts); absent, the four repair answers below. */
  readonly repair?: FrameXmlRepairModel;
  /** The binding C API over this client's key table (FrameXmlBinding.ts). */
  readonly keyBindings?: FrameXmlBindingModel;
  /** The options C API over the settings model: CVar ranges, the extra bars (FrameXmlOptions.ts). */
  readonly options?: FrameXmlOptionsModel | undefined;
  /** The stock Gossip/Bank/Taxi/ItemText frames' C API and events (FrameXmlGossipSeam.ts). */
  readonly gossip?: FrameXmlNpcWindowModels["gossip"];
  readonly bank?: FrameXmlNpcWindowModels["bank"];
  readonly taxi?: FrameXmlNpcWindowModels["taxi"];
  readonly itemText?: FrameXmlNpcWindowModels["itemText"];
  /** The stock Tabard/GuildRegistrar/ArenaRegistrar/Petition frames' C API and events (same table). */
  readonly tabard?: FrameXmlNpcWindowModels["tabard"];
  readonly registrar?: FrameXmlNpcWindowModels["registrar"];
  readonly petition?: FrameXmlNpcWindowModels["petition"];
  /** The stock PetStableFrame's C API and events (FrameXmlStable.ts, same table). */
  readonly stable?: FrameXmlNpcWindowModels["stable"];
  /** The stock ItemSocketingFrame (Blizzard_ItemSocketingUI) C API and its SOCKET_INFO_* events (FrameXmlSocketModel.ts). */
  readonly socket?: FrameXmlSocketModel;
  /** The stock InspectFrame (Blizzard_InspectUI) C API over the inspection packets (FrameXmlInspect.ts). */
  readonly inspect?: FrameXmlInspectModel;
  /** The stock BarberShopFrame (Blizzard_BarbershopUI) C API over the barber chair (FrameXmlBarber.ts). */
  readonly barber?: FrameXmlBarberModel;
  /** Fetches the barber's gateway tables before its add-on loads (FrameXmlBarberLive.ts); absent offline. */
  readonly barberPrepare?: () => Promise<void>;
  /** The stock GlyphFrame (Blizzard_GlyphUI) C API over the glyph sockets and the glyph cursor (FrameXmlGlyph.ts). */
  readonly glyphs?: FrameXmlGlyphModel;
  /** The stock PaperDoll title picker's C API and UnitPVPName's title over the title fields and CharTitles (FrameXmlTitles.ts). */
  readonly titles?: FrameXmlTitleModel;
  /** The 3.3.5 equipment manager's C API (GearManagerDialog) over the equipment-set packets (FrameXmlEquipmentSets.ts). */
  readonly equipmentSets?: FrameXmlEquipmentSetModel;
  /** The stock threat C API (UnitFrame.lua's indicator) over the threat tables (FrameXmlThreat.ts). */
  readonly threat?: FrameXmlThreatModel | undefined;
  /** The stock quest log's abandon confirmation over CMSG_QUESTLOG_REMOVE_QUEST (FrameXmlQuestAbandon.ts). */
  readonly questAbandon?: FrameXmlQuestAbandonModel | undefined;
  /** The chat cache's LOCKED/DOCKED/UNINTERACTABLE flags as stock writes them (FrameXmlChatWindowFlags.ts). */
  readonly chatWindows?: FrameXmlChatWindowFlags | undefined;
  /** Arena teams, the possess bar, the battlefield winner and the add-on channel (FrameXmlMechanics.ts). */
  readonly mechanics?: FrameXmlMechanicsModel | undefined;
  /** The player's PvP flag and its five-minute timer (FrameXmlPvpFlag.ts). */
  readonly pvpFlag?: FrameXmlPvpFlagModel | undefined;
  /** The battlefield scoreboard and LeaveBattlefield (FrameXmlScoreboard.ts). */
  readonly scoreboard?: FrameXmlBattlefieldScoreModel | undefined;
  /** L3 5.25: the battleground spirit guide's queue and the AREA_SPIRIT_HEAL clock (FrameXmlAreaSpiritHealer.ts). */
  readonly areaSpiritHealer?: FrameXmlAreaSpiritHealerModel | undefined;
  /** Dungeon/raid difficulty and IsInInstance (FrameXmlDifficulty.ts). */
  readonly difficulty?: FrameXmlDifficultyModel | undefined;
  /** SetActiveTalentGroup and ACTIVE_TALENT_GROUP_CHANGED (FrameXmlTalentGroup.ts). */
  readonly talentGroup?: FrameXmlTalentGroupModel | undefined;
  /** L12 3.29: GetTrainerSkillLines and the skill-line filter (FrameXmlTrainerSkillLines.ts). */
  readonly trainerSkillLines?: FrameXmlTrainerSkillLineModel | undefined;
  /** The talent preview: AddPreviewTalentPoints … LearnPreviewTalents (FrameXmlTalentPreview.ts, 3.33). */
  readonly talentPreview?: FrameXmlTalentPreviewModel | undefined;
  /** UnitCreatureType/UnitCreatureFamily (FrameXmlCreatureType.ts, 3.23A); absent on the canned seam. */
  readonly creatureTypes?: { type(unit: string): string | undefined; family(unit: string): string | undefined | null } | undefined;
  /** GetQuestLogPushable, QuestLogPushQuest and the sharer's MSG_QUEST_PUSH_RESULT lines (FrameXmlQuestShare.ts). */
  readonly questShare?: FrameXmlQuestShareModel | undefined;
  /** FlagTutorial, IsTutorialFlagged, GMReportLag (FrameXmlSupport.ts, 5.25/8.17); absent on the canned seam. */
  readonly support?: FrameXmlSupportModel | undefined;
  /** 3.13c: the quest POI C API (FrameXmlQuestPoi.ts); absent on the canned seam. */
  readonly questPoi?: FrameXmlQuestPoiModel | undefined;
  /** 3.22a: INSTANCE_BOOT_*, QUEST_ACCEPT_CONFIRM and their C API (FrameXmlServerPrompts.ts). */
  readonly serverPrompts?: FrameXmlServerPromptsModel | undefined;
  /** Quest log headers, collapsing, GetQuestLink, the special item, daily/completed counts (FrameXmlQuestLog.ts). */
  readonly questLog?: FrameXmlQuestLogModel | undefined;
  /** `UnitHasRelicSlot`: a player unit whose class has a relic slot (FrameXmlRelicSlot.ts). */
  unitHasRelicSlot?(unit: string): boolean;
  /** PVPFrame's arena team roster and team commands (FrameXmlArenaRoster.ts). */
  readonly arenaRoster?: FrameXmlArenaRosterModel | undefined;
  readonly services?: FrameXmlServices;
  petExperience?(): readonly [current: number, nextLevel: number];
  petSpellBonusDamage?(): number | undefined;
  /** The stock PetPaperDollFrame's companion C API over the known mount/critter spells (FrameXmlCompanions.ts). */
  readonly companions?: FrameXmlCompanionModel | undefined;
  /** The stock PetActionBarFrame's C API and the pet commands over the pet bar packet (FrameXmlPetActionBar.ts). */
  readonly petActions?: FrameXmlPetActionBar | undefined;
  /** 11.02-IF: the possess bar and the possessed unit's spells on the main bar (FrameXmlPossess.ts). */
  readonly possess?: FrameXmlPossessModel | undefined;
  /** 11.02-F2: the vehicle C API and the UNIT_*_VEHICLE events (FrameXmlVehicle.ts). */
  readonly vehicle?: FrameXmlVehicleModel | undefined;
  /** 11.02-E: the VehicleAim* C API and VEHICLE_ANGLE_UPDATE on pitch changes (FrameXmlVehicleAim.ts). */
  readonly vehicleAim?: FrameXmlVehicleAimModel | undefined;
  /** `PetCanBeAbandoned`/`PetCanBeRenamed`: the pet's UNIT_FIELD_BYTES_2 pet-flags byte (FrameXmlCompanions.ts). */
  petCanBeAbandoned?(): boolean;
  petCanBeRenamed?(): boolean;
  /** `PetAbandon()` / `PetRename(name)`: CMSG_PET_ABANDON and CMSG_PET_RENAME for the current pet. */
  petAbandon?(): void;
  petRename?(name: string): void;
  /** L17 3.09: PetRename's checks and declensions, PET_FORCE_NAME_DECLENSION (FrameXmlPetDeclension.ts). */
  readonly petDeclension?: FrameXmlPetDeclensionModel | undefined;
  /** `GetPetFoodTypes()`: the diet's names when a seam carries them; nothing otherwise (FrameXmlStable.ts). */
  petFoodTypes?(): readonly string[];
  /** Exact auth-list realm name selected by the player. */
  realmName(): string | undefined;
  /** Server world clock, as whole 24-hour hours/minutes; unknown until its login packet arrives. */
  gameTime?(): readonly [hour: number, minute: number] | undefined;
  /**
   * `GetFramerate()`: frames per second as this host measures them, 0 before a second frame. Stock
   * `MainMenuBarPerformanceBarFrame_OnEnter` formats it into the micro-menu tooltip
   * (`MAINMENUBAR_FPS_LABEL`, MainMenuBar.lua:508); unbound, `format('%.0f', nil)` raised there.
   */
  framerate?(): number;
  /**
   * `GetNetStats()`'s latency: the last CMSG_PING/SMSG_PONG round trip in milliseconds
   * (`WorldClient.latencyMs`), undefined before the first answer. MainMenuBar.lua:498 colours the
   * micro-menu's latency bar with it and prints it in the tooltip.
   */
  netLatency?(): number | undefined;
  /**
   * `GetNetStats()`' bandwidth in and out, KB/s over the world socket's bytes
   * (`WorldClient.netBandwidth`); undefined, or no method at all, answers the neutral zeros.
   */
  netBandwidth?(): { inKBps: number; outKBps: number } | undefined;
  /** For the report: which implementation is answering. */
  readonly name: string;

  /** Called once, with the way back into the interface. */
  attach(pump: FrameXmlSeamPump): void;
  detach(): void;
  /** Stock `PlaySound` names a `SoundEntries`/`UISoundLookups` row for interface playback. */
  playSound(name: string): void;
  /** Stock `SendChatMessage` bridge; unsupported types and overlong text are ignored. */
  sendChatMessage(text: string, type: string, language: number | undefined, target: FrameXmlChatTarget): void;
  /** Message groups returned by `GetChatWindowMessages`; window 1 is the supported chat frame. */
  chatWindowMessages(windowId: number): readonly string[];
  /** Flat `channelName, zoneChannelId` pairs returned by `GetChatWindowChannels`. */
  chatWindowChannels(windowId: number): FrameXmlChatWindowChannels;
  /** `FCF_GetChatWindowInfo`'s ten values, or undefined for an unsupported window id. */
  chatWindowInfo(windowId: number): FrameXmlChatWindowInfo | undefined;
  /**
   * `SetChatWindowShown(id, shown)`: the chat cache's SHOWN flag, which every stock ChatFrame writes
   * from its own OnShow and OnHide (FloatingChatFrame.xml:718, :729) — so it follows the dock's
   * selection — and `chatWindowInfo` answers back ({@link frameXmlGeneralWindowInfo}).
   */
  setChatWindowShown?(windowId: number, shown: boolean): void;
  /** The chat cache's colours: UPDATE_CHAT_COLOR at attach and `ChangeChatColor` (FrameXmlChatColors.ts). */
  readonly chatColors?: FrameXmlChatColors;
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
  actionInRange(slot: number, unit?: string): number | undefined;
  actionBarPage(): number;
  changeActionBarPage?(page: number): void;
  mirrorTimerInfo?(index: number): FrameXmlMirrorTimerInfo;
  mirrorTimerProgress?(timer: string): number;
  bonusBarOffset(): number;
  /** `SECURE_ACTIONS.action`'s call, once the secure attributes have resolved the slot. */
  useAction(slot: number, unit: string | undefined, button: string | undefined): void;
  /** A 1-based slot's server action and `ActionButtonType` (FrameXmlCursor.ts); nil when empty. */
  actionButton?(slot: number): FrameXmlActionButton | undefined;
  /** CMSG_SET_ACTION_BUTTON for a 1-based slot (action 0 empties it); false without a bar to write. */
  setActionButton?(slot: number, action: number, type: number): boolean;
  /** The spell id in a 1-based spellbook slot, resolved exactly as `GetSpellName` resolves it. */
  spellBookSpellId?(index: number, bookType: string | undefined): number | undefined;
  /** An item's icon by entry, for an item action and the cursor picture; nil until known. */
  itemTexture?(entry: number): string | undefined;

  // ---- the player --------------------------------------------------------
  unitExists(unit: string): boolean;
  unitName(unit: string): string | undefined;
  /** Host-only portrait identity for the active quest page; absent without a loaded unit/display. */
  questNpcPortraitGuid(): bigint | undefined;
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
  /** Combo points only belong to the supplied source/target identity pair. */
  comboPoints(source: string, target: string): number;
  /** Purchased bank bag slots and whether all seven are unlocked. Nil before player fields arrive. */
  bankSlots(): readonly [bought: number, full: boolean] | undefined;
  /** Next bank bag slot price in copper, or nil until the host has the configured price. */
  bankSlotCost(bought: number): number | undefined;
  buyBankSlot(): void;
  closeBankFrame(): void;
  /** Number of non-player party members in the current non-raid group. */
  partyMemberCount(): number;
  /** Number of non-player raid members; zero is truthful when raid state is unavailable. */
  raidMemberCount(): number;
  /** True only when a real group snapshot names the local player as leader. */
  isPartyLeader(): boolean;
  lootMethod?(): FrameXmlLootMethod | undefined;
  lootThreshold?(): number;
  setLootMethod?(method: string, master: string | undefined, threshold: number | undefined): void;
  setLootThreshold?(threshold: number): void;
  /** The 1-based `GetPartyMember` name, or undefined for an empty/out-of-range slot. */
  partyMember(index: number): string | undefined;
  /**
   * `TargetUnit(unit or name[, exactMatch])`: a known unit token, else — as `/target Name` passes
   * it — the nearest visible unit of that name; selection is the world's.
   */
  targetUnit(unit: string, exactMatch?: boolean): void;
  /** `UnitIsVisible` is true only while the seam has an in-range object for the unit. */
  unitIsVisible(unit: string): boolean;
  /** `UnitIsPossessed`: `UNIT_FLAG_POSSESSED` on the unit's flags (live: FrameXmlPossess.ts → `unitPossessed`). */
  unitIsPossessed(unit: string): boolean;
  /**
   * `GetPetHappiness`'s happiness and damage percentage, or undefined when not modelled.
   * 3.36 (L14): the live answer without a hunter's pet is `[undefined, 100]` — nil, 100 as Wow.exe (FrameXmlPetHappiness.ts).
   */
  petHappiness(): readonly [number | undefined, number] | undefined;
  /** `HasPetUI`'s `(hasPetUI, isHunterPet)` pair. */
  hasPetUI(): readonly [boolean, boolean];
  /** `GetRestState`'s triple: state id, localised name, rest multiplier. */
  restState(): readonly [number, string, number];
  /** The rest of the player-status family (FrameXmlPlayerStatus.ts); absent members answer «no». */
  isResting?: FrameXmlPlayerStatus["isResting"];
  xpExhaustion?: FrameXmlPlayerStatus["xpExhaustion"];
  unitIsAFK?: FrameXmlPlayerStatus["unitIsAFK"];
  unitIsDND?: FrameXmlPlayerStatus["unitIsDND"];
  partyLeaderIndex?: FrameXmlPlayerStatus["partyLeaderIndex"];
  unitGroupRoles?: FrameXmlPlayerStatus["unitGroupRoles"];
  optOutOfLoot?: FrameXmlPlayerStatus["optOutOfLoot"];
  setOptOutOfLoot?: FrameXmlPlayerStatus["setOptOutOfLoot"];
  raidTargetIndex?: FrameXmlPlayerStatus["raidTargetIndex"];
  /** Combat and the group's relations (FrameXmlUnitRelations.ts); absent members answer «no». */
  unitAffectingCombat?: FrameXmlUnitRelations["unitAffectingCombat"];
  inCombatLockdown?: FrameXmlUnitRelations["inCombatLockdown"];
  unitInParty?: FrameXmlUnitRelations["unitInParty"];
  unitInRaid?: FrameXmlUnitRelations["unitInRaid"];
  unitIsPartyLeader?: FrameXmlUnitRelations["unitIsPartyLeader"];
  unitIsRaidOfficer?: FrameXmlUnitRelations["unitIsRaidOfficer"];
  /** `HasFullControl` (FrameXmlControl.ts); absent, the player holds the reins. */
  hasFullControl?: FrameXmlPlayerControl["hasFullControl"];
  /** The unit menus' and SecureTemplates' assistant and main tank/assist commands (FrameXmlGroupCommands.ts). */
  readonly groupCommands?: FrameXmlGroupCommandsModel | undefined;
  /** Focus, assist, dismount and the stance bar's cancel (FrameXmlTargetingApi.ts). */
  readonly targeting?: FrameXmlTargeting | undefined;
  /** L2 1.10: `TargetNearest*` and `TargetLast*` (FrameXmlTargetNearest.ts); absent, they do nothing. */
  readonly targetNearest?: FrameXmlTargetNearest | undefined;

  // ---- unit auras -------------------------------------------------------
  /** `UnitAura`'s 3.3.5 tuple for a 1-based filtered player slot. */
  unitAura(unit: string, index: number, filter: string | undefined): FrameXmlAuraInfo | undefined;
  /** Stock aliases over the same filtered aura rows. */
  unitBuff(unit: string, index: number): FrameXmlAuraInfo | undefined;
  unitDebuff(unit: string, index: number): FrameXmlAuraInfo | undefined;
  /** `CancelUnitBuff`, resolved through the same filtered player slot as `UnitAura`. */
  cancelUnitBuff(unit: string, index: number, filter: string | undefined): void;

  // ---- the base minimap -------------------------------------------------
  /** `GetMinimapZoneText()` (the most specific area); undefined, which the binding answers as "", while unknown. */
  minimapZoneText(): string | undefined;
  /** `GetZoneText()`; undefined (bound as "") while the area metadata is unavailable. */
  zoneText(): string | undefined;
  /** `GetSubZoneText()`; undefined (bound as "") without a sub-zone or area metadata. */
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
  /**
   * `UnitGUID` in this client's `frameXmlGuid` text form (the same string chat `arg12` carries),
   * or undefined for a token that names no unit. Client add-ons key maps by it every frame:
   * MikScrollingBattleText's `petMap[UnitGUID(unitID)]` (MSBTParser.lua:767-769) raised «table
   * index is nil» once per frame while the answer was nil.
   */
  unitGuid?(unit: string): string | undefined;
  /** `UnitReaction`'s stock 1..8 index (2 hostile, 4 neutral, 5 friendly), or undefined. */
  unitReaction?(left: string, right: string): number | undefined;

  // ---- minimap indicators -------------------------------------------------
  /** `GetNumTrackingTypes`: the tracking spells the player knows. */
  trackingCount?(): number;
  /** `GetTrackingInfo(i)`'s name, texture, active, category («spell» for every spell tracker). */
  trackingInfo?(index: number): FrameXmlTrackingInfo | undefined;
  /** `GetTrackingTexture`: the active tracker's icon, else the stock «None» picture. */
  trackingTexture?(): string;
  /** `SetTracking(i)` toggles one tracker; `SetTracking(nil)` cancels every active one. */
  setTracking?(index: number | undefined): void;
  /** `HasNewMail`: the server's pending-mail answer says something unread is waiting. */
  hasNewMail?(): boolean;
  /** `GetLatestThreeSenders`: the resolved names among the server's at most three senders. */
  latestMailSenders?(): readonly string[];
  /** `GetLFGMode`'s `(mode, submode)`, or undefined when the player is not in the dungeon finder. */
  lfgMode?(): FrameXmlLfgMode | undefined;
  /** `GetInstanceInfo`'s seven values, or undefined while the map row is unresolved. */
  instanceInfo?(): FrameXmlInstanceInfo | undefined;

  // ---- chat languages ------------------------------------------------------
  /** The client locale whose `Languages.dbc` names the seam speaks; ruRU when absent. */
  readonly locale?: string;
  /** `GetDefaultLanguage`: the player's racial `ChrRaces.BaseLanguage`, by name. */
  defaultLanguage?(): string | undefined;
  /** `GetNumLanguages`/`GetLanguageByIndex`: the named languages the player's skills say it knows. */
  languages?(): readonly string[];

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
  /** `GetSpellInfo` from cached DBC metadata; nil when the id/name has not resolved. */
  spellInfo?(idOrName: number | string): FrameXmlSpellInfo | undefined;
  /**
   * `GetSpellLink`: the stock spell hyperlink (`|cff71d5ff|Hspell:ID|h[Name]|h|r`) for a spellbook
   * slot when `bookType` is given, else for a spell id or a known spell's name; undefined — nil —
   * when nothing resolves.
   */
  spellLink?(indexOrSpell: number | string, bookType?: string): string | undefined;
  spellTexture(index: number, bookType: string | undefined): string | undefined;
  spellCooldown(index: number, bookType: string | undefined): FrameXmlSpellCooldown;
  spellAutocast(index: number, bookType: string | undefined): readonly [boolean, boolean];
  spellIsPassive(index: number, bookType: string | undefined): boolean | undefined;
  /** The rank-normalized slot; nil when the requested slot does not exist. */
  knownSlotFromHighestRankSlot(index: number, bookType: string | undefined): number | undefined;
  spellIsSelected(index: number, bookType: string | undefined): boolean;
  hasPetSpells(): boolean;
  shapeshiftFormCount(): number;
  shapeshiftFormInfo(index: number): FrameXmlShapeshiftFormInfo | undefined;
  shapeshiftFormCooldown(index: number): FrameXmlSpellCooldown;
  castShapeshiftForm(index: number): void;
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

  // ---- player and pet talents -------------------------------------------
  /** Immutable player or pet projection for Blizzard_TalentUI, when packet and DBC are ready. */
  talentSnapshot(pet?: boolean): FrameXmlTalentSnapshot | undefined;
  /** Maps Lua's tab/index/group to the appropriate player or pet talent packet boundary. */
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
  /** `AbandonSkill(index)`: CMSG_UNLEARN_SKILL for the profession in that visible row; any other row sends nothing. */
  abandonSkill?(index: number): void;

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
  /**
   * `GetBattlefieldEstimatedWaitTime(i)` and `GetBattlefieldTimeWaited(i)`, milliseconds, for a
   * queued slot; absent, both answer 0 (BattlefieldFrame.lua:260-261 reads 0 as QUEUE_TIME_UNAVAILABLE).
   */
  battlefieldQueueTimes?(index: number): readonly [estimatedWait: number, waited: number];
  /**
   * `GetBattlefieldInstanceExpiration()` and `GetBattlefieldInstanceRunTime()`, milliseconds, for
   * the running match; absent, both answer 0 — no shutdown timer (BattlefieldFrame.lua:303).
   */
  battlefieldInstanceTimes?(): readonly [expiration: number, runTime: number];
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
  /** Current ItemExtendedCost values from the cache; an unresolved row returns neutral zeroes. */
  merchantItemCostInfo(index: number): FrameXmlMerchantCostInfo;
  merchantItemCostItem(index: number, costIndex: number): readonly [string | undefined, number, string | undefined] | undefined;
  /** Cache-only `GetItemInfo` prefix used by stock token-purchase confirmation. */
  itemInfo(value: unknown): FrameXmlItemInfo | undefined;
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
  /** 3.23F: the required spell's name («name (rank)») and whether the player knows it. */
  trainerServiceAbilityReq(index: number, requirement: number): readonly [string | undefined, boolean] | undefined;
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
  /** Stock left-click item cursor. The server receives a move only on a valid second click. */
  pickupContainerItem(bagId: number, slot: number): void;
  cursorHasItem(): boolean;
  cursorInfo(): readonly unknown[];
  clearCursor(): void;

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
  /** Stock paper-doll slot IDs are one-based; pickup shares the container cursor. */
  pickupInventoryItem(unit: string, slot: number): void;
  /** `SpellTargetItem(itemID|name|link)`: the item-target cursor takes that carried item (2.05). */
  spellTargetItem?(query: unknown): void;
  /** `ClickTargetTradeButton(index)`: the item-target cursor takes the trader's slot 7 (2.05). */
  clickTargetTradeButton?(index: number): void;
  /** `BindEnchant()`: BIND_ENCHANT's accept — 0x005210d0 again, the bind answered (0x00522f70). */
  bindEnchant?(): void;
  /** `ReplaceEnchant()`: REPLACE_ENCHANT's accept — the named item takes the waiting spell (0x005167a0). */
  replaceEnchant?(): void;
  /** 2.10 (FrameXmlRefund.ts): `GetContainerItemPurchaseInfo`'s five values, or nothing. */
  containerItemPurchaseInfo?(bag: number, slot: number, equipped: boolean): readonly unknown[] | undefined;
  /** 2.10: `GetContainerItemPurchaseItem`'s texture, count and link, or nothing. */
  containerItemPurchaseItem?(bag: number, slot: number, index: number, equipped: boolean): readonly unknown[] | undefined;
  /** 2.10: `ContainerRefundItemPurchase` — CMSG_ITEM_REFUND, or the client's error line. */
  containerRefundItemPurchase?(bag: number, slot: number, equipped: boolean): void;
  /** 2.10: `EndRefund(kind)` — END_REFUND's accept (1 the enchant, 2 the sockets). */
  endRefund?(kind: number): void;
  /** `ReplaceTradeEnchant()`: TRADE_REPLACE_ENCHANT's accept — the trade slot takes it (0x00510b80). */
  replaceTradeEnchant?(): void;
  /** L1 (1.10): `DropItemOnUnit(unit)` — wear, trade or feed the held bag item (0x0051bdd0). */
  dropItemOnUnit?(unit: string): void;
  /** L1 (3.23): `PickupMerchantItem` with a bag item held sells it (0x005853a0); true when one was held. */
  sellCursorItemToMerchant?(): boolean;
  /** L1 (3.23): the merchant row's item entry as the cursor holds it (0x00584080); undefined for no row. */
  merchantItemEntry?(index: number): number | undefined;
  /**
   * L1 (3.23): a held merchant row dropped on a container slot (`bagId`) or a paper-doll slot (`bagId`
   * undefined): CMSG_BUY_ITEM_IN_SLOT (0x005d7ff0 / 0x005e85d0 → 0x006d2ea0). True when sent, false
   * when not, undefined with no merchant open (FrameXmlMerchantCursor.ts).
   */
  buyMerchantItemInSlot?(index: number, bagId: number | undefined, slot: number): boolean | undefined;

  // ---- the stock item actions (FrameXmlItemActions.ts) --------------------
  /**
   * The bind prompts' answers (StaticPopup.lua:1525-1571): `EquipPendingItem(slot)` sends the equip
   * or swap held since AUTOEQUIP_BIND_CONFIRM/EQUIP_BIND_CONFIRM fired with that slot,
   * `CancelPendingEquip(slot)` drops it, `ConfirmBindOnUse()` performs the use held since
   * USE_BIND_CONFIRM. Absent on a host without the prompts.
   */
  equipPendingItem?(slot: number | undefined): void;
  cancelPendingEquip?(slot: number | undefined): void;
  confirmBindOnUse?(): void;
  /** `PutItemInBackpack`/`PutItemInBag(20..23)` by stock container id (0 the backpack): true when the held item went. */
  storeCursorItemInBag?(bagId: number): boolean;
  /** `SplitContainerItem`: the part onto the cursor; false leaves the stack where it is. */
  splitContainerItem?(bagId: number, slot: number, count: number): boolean;
  /** `DeleteCursorItem` for a split part on the cursor; false leaves a whole stack to FrameXmlPopups. */
  deleteSplitCursorItem?(): boolean;
  /** `AutoEquipCursorItem()`, `EquipCursorItem(slot)`, `EquipItemByName(item[, slot])`. */
  autoEquipCursorItem?(): void;
  equipCursorItem?(slot: number): void;
  equipItemByName?(item: unknown, slot: number | undefined): void;
  /** `CursorCanGoInSlot(slot)`: the held bag item fits that paper-doll slot. */
  cursorCanGoInSlot?(slot: number): boolean;
  /** `GetContainerItemDurability`/`GetInventoryItemDurability`: `[current, max]`, or nil without a durability pair. */
  containerItemDurability?(bagId: number, slot: number): readonly [number, number] | undefined;
  inventoryItemDurability?(slot: number): readonly [number, number] | undefined;
  inventoryItemQuality?(unit: string, slot: number): number | undefined;
  inventoryItemId?(unit: string, slot: number): number | undefined;
  containerItemId?(bagId: number, slot: number): number | undefined;
  /** The readers by id, link or cached name; nil (never a guess) while the template is unknown. */
  itemCount?(item: unknown, includeBank: boolean): number;
  itemSpell?(item: unknown): readonly [name: string, rank: string] | undefined;
  itemIcon?(item: unknown): string | undefined;
  isEquippableItem?(item: unknown): boolean | undefined;
  isEquippedItem?(item: unknown): boolean;
  isUsableItem?(item: unknown): boolean | undefined;
  isConsumableItem?(item: unknown): boolean | undefined;
  itemCooldown?(item: unknown): FrameXmlContainerItemCooldown;
  /** `GetInventoryItemsForSlot`, as flat `location, id, …` pairs (FrameXmlItemActions.ts keys them). */
  inventoryItemsForSlot?(slot: number): readonly number[];
  /** `GetInventoryAlertStatus(index)`: 0 sound, 1 worn low, 2 broken. */
  inventoryAlertStatus?(index: number): number;
  /** `OffhandHasWeapon()`: the off-hand item is a weapon (FrameXmlDurabilityFrame.ts, Wow.exe 0x005eac10). */
  offhandHasWeapon?(): boolean;

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
  /** Intellect contribution including its class base; unknown without DBC coefficients/player fields. */
  spellCritChanceFromIntellect?(unit: string): number | undefined;
  /** Multiplicative health modifier; one is the neutral value without authoritative state. */
  unitMaxHealthModifier(unit: string): number;
  /** Derived spirit regeneration; zero when the unit's regen fields are not authoritative. */
  unitHealthRegenRateFromSpirit(unit: string): number;
  unitManaRegenRateFromSpirit(unit: string): number;
  /** One-based index into the player's replicated combat-rating array. */
  combatRating(index: number): number;
  combatRatingBonus(index: number): number;
  armorPenetration(): number;
  critChance(): number;
  rangedCritChance?(): number;
  spellCritChance?(school: number): number;
  spellBonusDamage?(school: number): number;
  spellBonusHealing?(): number;
  spellPenetration?(): number;
  manaRegen?(): readonly [number, number];
  dodgeChance?(): number;
  parryChance?(): number;
  blockChance?(): number;
  shieldBlock?(): number;
  unitDefense?(unit: string): readonly [number, number];
  dodgeBlockParryChanceFromDefense?(): number;
  expertise(): readonly [number, number];
  expertisePercent(): readonly [number, number];
  /** Main-hand speed and optional off-hand speed; nil off-hand preserves stock no-off-hand logic. */
  unitAttackSpeed(unit: string): readonly [number, number | undefined];
  unitDamage(unit: string): FrameXmlUnitDamage;
  unitRangedDamage(unit: string): FrameXmlUnitRangedDamage;

  // ---- quest giver C API -------------------------------------------------
  /** Packet-backed greeting/dialog C API. Invalid or absent pages answer Lua nil. */
  questGiverCall(name: string, args: readonly unknown[]): readonly unknown[];

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
  /** Resolve a Faction.dbc ID through the cached list-slot catalog, or answer nil. */
  factionInfoById(factionId: unknown): FrameXmlFactionInfo | undefined;
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
  // The original PetPaperDoll calls the same APIs with both "pet" and "Pet".
  return typeof value === "string" ? value.toLowerCase() : "";
}

function filterOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function questIndexOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const index = Number(value);
  return Number.isFinite(index) ? Math.trunc(index) : undefined;
}

/**
 * The 3.3.5 quest-colour range is wider than the creature XP range above level 59.
 * Compatible core contract: MaNGOS::XP::GetQuestGreenRange in
 * https://github.com/cmangos/mangos-wotlk/blob/master/src/game/Tools/Formulas.h
 */
export function questGreenRange(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level) || level < 1) return 0;
  if (level < 40) return 4 + Math.floor(level / 10);
  return Math.min(12, Math.floor(level / 5));
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
/** `IsActionInRange`'s two numeric answers (Wow.exe 0x005a9d50 pushes 1.0 or 0.0). */
const IN_RANGE: readonly unknown[] = Object.freeze([1]);
const OUT_OF_RANGE: readonly unknown[] = Object.freeze([0]);

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

function talentGroupOf(snapshot: FrameXmlTalentSnapshot | undefined, value: unknown): number {
  const group = Number(value);
  if (Number.isInteger(group) && group > 0) return Math.trunc(group);
  return snapshot?.activeTalentGroup ?? 0;
}

const QUEST_GIVER_C_API_NAMES = Object.freeze([
  ...Object.keys(FRAMEXML_QUEST_MENU_DATA_BINDINGS),
  ...Object.keys(FRAMEXML_QUEST_GIVER_DATA_BINDINGS),
  ...Object.keys(FRAMEXML_QUEST_REWARD_DATA_BINDINGS),
  ...Object.keys(FRAMEXML_QUEST_FLAGS_DATA_BINDINGS),
  "SelectActiveQuest", "SelectAvailableQuest", "AcceptQuest", "CompleteQuest",
  "GetQuestReward", "DeclineQuest", "CloseQuest",
]);

const QUEST_GIVER_SEAM_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> =
  Object.fromEntries(QUEST_GIVER_C_API_NAMES.map((name) => [
    name, (seam: FrameXmlWorldSeam, args: readonly unknown[]) => seam.questGiverCall(name, args),
  ]));

const CLOSED_SERVICES = createFrameXmlServices({
  sendMailItems: () => [], stableService: () => undefined, stableSlotPrice: () => undefined,
});
const SERVICE_SEAM_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.fromEntries(
  Object.entries(FRAMEXML_SERVICE_BINDINGS).map(([name, call]) => [name,
    (seam: FrameXmlWorldSeam, args: readonly unknown[]) => call(seam.services ?? CLOSED_SERVICES, args)]),
);

// The spellbook names take a `bookType`; frameXmlWithPetBook answers the "pet" book from the pet model.
// 11.02-IF: frameXmlWithPossess answers slots 121-132 and the possess names while a possessed unit's bar is up.
// 11.02-F2: frameXmlWithVehicle answers the vehicle C API while the vehicle tables are there.
// 11.02-E: frameXmlWithVehicleAim answers VehicleAim* while the vehicle tables are there.
export const FRAMEXML_SEAM_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze(frameXmlWithVehicleAim(frameXmlWithVehicle(frameXmlWithPossess(frameXmlWithPetBook({
  ...SERVICE_SEAM_BINDINGS,
  ...FRAMEXML_WORLD_STATE_BINDINGS,
  ...FRAMEXML_MAP_BINDINGS,
  ...FRAMEXML_LFD_BINDINGS,
  ...FRAMEXML_LOOT_BINDINGS,
  ...FRAMEXML_POPUPS_BINDINGS,
  ...FRAMEXML_FRIENDS_BINDINGS,
  ...FRAMEXML_AUTOCOMPLETE_BINDINGS, // L5c 3.18
  ...FRAMEXML_RAID_LOD_BINDINGS,
  ...FRAMEXML_ARENA_BINDINGS,
  ...FRAMEXML_MAIL_BINDINGS,
  ...FRAMEXML_TRADE_BINDINGS,
  ...FRAMEXML_CURRENCY_BINDINGS,
  ...FRAMEXML_TRADESKILL_BINDINGS,
  ...FRAMEXML_NPC_WINDOW_BINDINGS,
  ...FRAMEXML_AUCTION_BINDINGS,
  ...FRAMEXML_ACHIEVEMENT_BINDINGS,
  ...FRAMEXML_GUILDBANK_BINDINGS,
  ...FRAMEXML_MACRO_BINDINGS, ...FRAMEXML_BINDING_BINDINGS,
  ...FRAMEXML_MECHANICS_BINDINGS,
  // PvP after the mechanics; IsInInstance is FrameXmlDifficulty's alone, after the arena table.
  ...FRAMEXML_PVP_FLAG_BINDINGS, ...FRAMEXML_SCOREBOARD_BINDINGS, ...FRAMEXML_DIFFICULTY_BINDINGS,
  ...FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS, // L3 5.25
  ...FRAMEXML_ARENA_ROSTER_BINDINGS,
  ...FRAMEXML_TALENT_GROUP_BINDINGS, ...FRAMEXML_QUEST_SHARE_BINDINGS, ...FRAMEXML_RELIC_SLOT_BINDINGS,
  ...FRAMEXML_SUPPORT_BINDINGS,
  ...FRAMEXML_SERVER_PROMPTS_BINDINGS,
  ...FRAMEXML_QUEST_LOG_BINDINGS,
  ...FRAMEXML_CALENDAR_SEAM_BINDINGS,
  ...FRAMEXML_HUD_MECHANICS_BINDINGS,
  // 3.07, over the HUD's GetTotemInfo for an empty slot (FrameXmlMultiCast.ts).
  ...frameXmlMultiCastBindings(FRAMEXML_HUD_MECHANICS_BINDINGS.GetTotemInfo!),
  ...FRAMEXML_OPTIONS_BINDINGS,
  ...FRAMEXML_PLAYER_STATUS_BINDINGS,
  ...FRAMEXML_UNIT_RELATION_BINDINGS,
  ...FRAMEXML_CONTROL_BINDINGS, ...FRAMEXML_GROUP_COMMAND_BINDINGS, ...FRAMEXML_TARGETING_BINDINGS,
  ...FRAMEXML_TARGET_NEAREST_BINDINGS, // L2 1.10
  ...FRAMEXML_INSPECT_BINDINGS,
  ...FRAMEXML_TITLE_BINDINGS, ...FRAMEXML_EQUIPMENT_SET_BINDINGS, AbandonSkill: (seam, args) => { seam.abandonSkill?.(slotOf(args[0])); return NOTHING; },
  ...FRAMEXML_BARBER_BINDINGS,
  ...FRAMEXML_COMPANION_BINDINGS,
  ...FRAMEXML_PET_DECLENSION_BINDINGS, // L17 3.09: after the companions', so its PetRename answers
  ...FRAMEXML_PET_ACTION_BINDINGS,
  // After the trade skill's: its SpellIsTargeting/SpellStopTargeting answer the glyph cursor first.
  ...FRAMEXML_GLYPH_BINDINGS,
  // After the trade's, the trade skill's and the glyph's: the item-target cursor (2.05) answers
  // SpellCanTargetItem first and owns SpellTargetItem, SpellTargetUnit and ClickTargetTradeButton.
  ...FRAMEXML_ITEM_TARGETING_BINDINGS,
  ...FRAMEXML_REFUND_BINDINGS,
  // After the bank's and the popups': its PutItemInBag/SplitContainerItem/DeleteCursorItem answer the
  // carried bags and the split cursor first and hand the rest back.
  ...FRAMEXML_ITEM_ACTION_BINDINGS,
  ...FRAMEXML_DURABILITY_BINDINGS,
  GetPetExperience: (seam) => seam.petExperience?.() ?? [0, 0],
  GetPetSpellBonusDamage: (seam) => [seam.petSpellBonusDamage?.() ?? 0],
  ...QUEST_GIVER_SEAM_BINDINGS,
  GetRealmName: (seam) => optional(seam.realmName()),
  GetGameTime: (seam) => seam.gameTime?.() ?? NOTHING,
  GetFramerate: (seam) => {
    const fps = seam.framerate?.() ?? 0;
    return [Number.isFinite(fps) && fps > 0 ? fps : 0];
  },
  // `bandwidthIn, bandwidthOut, latency` (MainMenuBar.lua:498 reads the third; add-ons the first
  // two). A seam that does not measure the socket — the canned world — answers zeros for the rates.
  GetNetStats: (seam) => {
    const latency = seam.netLatency?.();
    const bandwidth = seam.netBandwidth?.();
    const rate = (value: number | undefined): number =>
      value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
    return [rate(bandwidth?.inKBps), rate(bandwidth?.outKBps),
      latency !== undefined && Number.isFinite(latency) && latency > 0 ? latency : 0];
  },
  PlaySound: (seam, args) => {
    const name = args[0];
    if (typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name)) seam.playSound(name);
    return NOTHING;
  },
  SendChatMessage: (seam, args) => {
    const text = typeof args[0] === "string" ? args[0] : "";
    const type = typeof args[1] === "string" ? args[1] : "";
    // Stock passes `editBox.language`, which it filled from GetDefaultLanguage/GetLanguageByIndex:
    // a language *name*. Resolve it back to the id; a number is still accepted as the API allows.
    const language = typeof args[2] === "number" && Number.isFinite(args[2])
      ? Math.trunc(args[2])
      : typeof args[2] === "string" ? frameXmlLanguageId(args[2], seam.locale) : undefined;
    const target = chatTargetOf(args[3]);
    if (target === undefined) return NOTHING;
    seam.sendChatMessage(text, type, language, target);
    return NOTHING;
  },
  GetChatWindowMessages: (seam, args) => [...seam.chatWindowMessages(slotOf(args[0]))],
  GetChatWindowChannels: (seam, args) => [...seam.chatWindowChannels(slotOf(args[0]))],
  GetChatWindowInfo: (seam, args) => seam.chatWindowInfo(slotOf(args[0])) ?? NOTHING,
  SetChatWindowShown: (seam, args) => {
    // Lua truthiness: ChatFrame's OnShow passes 1 and its OnHide nil.
    seam.setChatWindowShown?.(slotOf(args[0]), args[1] !== undefined && args[1] !== null && args[1] !== false);
    return NOTHING;
  },
  ...FRAMEXML_CHAT_COLOR_BINDINGS,
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
  // 1 or nil, as Wow.exe 0x5aad40/0x5a9ba0/0x5a9c10 answer (FrameXmlActionRepeat.ts).
  IsCurrentAction: (seam, args) => [seam.isCurrentAction(slotOf(args[0])) ? 1 : undefined],
  IsAttackAction: (seam, args) => [seam.isAttackAction(slotOf(args[0])) ? 1 : undefined],
  IsAutoRepeatAction: (seam, args) => [seam.isAutoRepeatAction(slotOf(args[0])) ? 1 : undefined],
  // Asked by stock ActionButton_OnUpdate for every button every 0.2 s: shared answers, no allocation.
  IsActionInRange: (seam, args) => {
    const inRange = seam.actionInRange(slotOf(args[0]), typeof args[1] === "string" ? args[1] : undefined);
    return inRange === 1 ? IN_RANGE : inRange === 0 ? OUT_OF_RANGE : NOTHING;
  },
  GetActionBarPage: (seam) => [seam.actionBarPage()],
  ChangeActionBarPage: (seam, args) => {
    if (typeof args[0] === "number") seam.changeActionBarPage?.(args[0]);
    return NOTHING;
  },
  GetMirrorTimerInfo: (seam, args) => seam.mirrorTimerInfo?.(slotOf(args[0])) ?? ["UNKNOWN"],
  GetMirrorTimerProgress: (seam, args) => [seam.mirrorTimerProgress?.(
    typeof args[0] === "string" ? args[0].toUpperCase() : "",
  ) ?? 0],
  GetBonusBarOffset: (seam) => [seam.bonusBarOffset()],
  UseAction: (seam, args) => {
    seam.useAction(slotOf(args[0]), unitOf(args[1]) || undefined, filterOf(args[2]) || undefined);
    return NOTHING;
  },
  UnitExists: (seam, args) => [seam.unitExists(unitOf(args[0]))],
  UnitName: (seam, args) => optional(seam.unitName(unitOf(args[0]))),
  UnitPVPName: (seam, args) => optional(seam.unitPvpName(unitOf(args[0]))),
  // The client answers 0 for a token with no unit: stock TargetFrame_CheckLevel (TargetFrame.lua:
  // 236-242) runs `targetLevel > 0` unguarded for Target/Focus/Boss1-4 on every UNIT_FACTION
  // ("player"), boss frames included while no boss exists — 6 raises per event with nil here.
  UnitLevel: (seam, args) => [seam.unitLevel(unitOf(args[0])) ?? 0],
  UnitClass: (seam, args) => seam.unitClass(unitOf(args[0])) ?? NOTHING,
  UnitRace: (seam, args) => seam.unitRace(unitOf(args[0])) ?? NOTHING,
  UnitSex: (seam, args) => optional(seam.unitSex(unitOf(args[0]))),
  UnitIsConnected: (seam, args) => [seam.unitIsConnected(unitOf(args[0]))],
  UnitHealth: (seam, args) => [seam.unitHealth(unitOf(args[0]))],
  UnitHealthMax: (seam, args) => [seam.unitHealthMax(unitOf(args[0]))],
  UnitPower: (seam, args) => [seam.unitPower(unitOf(args[0]))],
  UnitPowerMax: (seam, args) => [seam.unitPowerMax(unitOf(args[0]))],
  // `UnitMana`/`UnitManaMax` are 3.3.5's older spelling of the pair above: the unit's power of
  // its display type. Stock never calls them (zero call sites in all 335 files), but add-ons
  // written for 3.3.5 do. MikScrollingBattleText's UNIT_MANA handler (MSBTTriggers.lua:711)
  // divides one by the other, and the nil stub raised msbttriggers.lua:526 on a player mana
  // change in the live-seam census.
  UnitMana: (seam, args) => [seam.unitPower(unitOf(args[0]))],
  UnitManaMax: (seam, args) => [seam.unitPowerMax(unitOf(args[0]))],
  UnitPowerType: (seam, args) => seam.unitPowerType(unitOf(args[0])) ?? NOTHING,
  UnitXP: (seam, args) => [seam.unitXP(unitOf(args[0]))],
  UnitXPMax: (seam, args) => [seam.unitXPMax(unitOf(args[0]))],
  GetMoney: (seam) => [seam.money()],
  GetComboPoints: (seam, args) => [seam.comboPoints(unitOf(args[0]), unitOf(args[1]))],
  GetNumBankSlots: (seam) => seam.bankSlots() ?? NOTHING,
  GetBankSlotCost: (seam, args) => optional(seam.bankSlotCost(slotOf(args[0]))),
  BuyBankSlot: (seam) => { seam.buyBankSlot(); return NOTHING; },
  CloseBankFrame: (seam) => { seam.closeBankFrame(); return NOTHING; },
  GetNumPartyMembers: (seam) => [seam.partyMemberCount()],
  GetNumRaidMembers: (seam) => [seam.raidMemberCount()],
  IsPartyLeader: (seam) => [seam.isPartyLeader()],
  GetLootMethod: (seam) => seam.lootMethod?.() ?? NOTHING,
  GetLootThreshold: (seam) => optional(seam.lootThreshold?.()),
  SetLootMethod: (seam, args) => {
    seam.setLootMethod?.(unitOf(args[0]), typeof args[1] === "string" ? args[1] : undefined,
      typeof args[2] === "number" ? args[2] : undefined);
    return NOTHING;
  },
  SetLootThreshold: (seam, args) => {
    if (typeof args[0] === "number") seam.setLootThreshold?.(args[0]);
    return NOTHING;
  },
  GetPartyMember: (seam, args) => optional(seam.partyMember(slotOf(args[0]))),
  TargetUnit: (seam, args) => {
    // `exactMatch` is a Lua truth value: `/targetexact` passes 1 (ChatFrame.lua:1159).
    const exactMatch = args[1] !== undefined && args[1] !== null && args[1] !== false;
    seam.targetUnit(unitOf(args[0]), exactMatch);
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
  UnitGUID: (seam, args) => optional(seam.unitGuid?.(unitOf(args[0]))),
  UnitReaction: (seam, args) => optional(seam.unitReaction?.(unitOf(args[0]), unitOf(args[1]))),
  // These four shadow the neutral constant `GetNumTrackingTypes = 0` (FrameXmlNeutralApi.ts): a
  // seam name is installed into `__fxNeutralImpl` by FRAMEXML_SEAM_PRELUDE, which the `_G`
  // metamethod consults before the constant table.
  GetNumTrackingTypes: (seam) => [seam.trackingCount?.() ?? 0],
  GetTrackingInfo: (seam, args) => seam.trackingInfo?.(slotOf(args[0])) ?? NOTHING,
  GetTrackingTexture: (seam) => [seam.trackingTexture?.() ?? FRAMEXML_TRACKING_NONE_TEXTURE],
  SetTracking: (seam, args) => {
    // MiniMapTrackingDropDown_Initialize's «NONE» row passes `arg1 = nil` (Minimap.lua:462-465).
    seam.setTracking?.(args[0] === undefined || args[0] === null ? undefined : slotOf(args[0]));
    return NOTHING;
  },
  HasNewMail: (seam) => [seam.hasNewMail?.() ?? false],
  GetLatestThreeSenders: (seam) => (seam.latestMailSenders?.() ?? []).slice(0, 3),
  GetLFGMode: (seam) => seam.lfgMode?.() ?? NOTHING,
  GetInstanceInfo: (seam) => seam.instanceInfo?.() ?? NOTHING,
  GetDefaultLanguage: (seam) => optional(seam.defaultLanguage?.()),
  GetNumLanguages: (seam) => [seam.languages?.().length ?? 0],
  GetLanguageByIndex: (seam, args) => optional(seam.languages?.()[slotOf(args[0]) - 1]),
  UnitCastingInfo: (seam, args) => seam.unitCastingInfo(unitOf(args[0])) ?? NOTHING,
  UnitChannelInfo: (seam, args) => seam.unitChannelInfo(unitOf(args[0])) ?? NOTHING,
  GetNumSpellTabs: (seam) => [seam.spellTabCount()],
  GetSpellTabInfo: (seam, args) => seam.spellTabInfo(slotOf(args[0])) ?? NOTHING,
  GetSpellName: (seam, args) => seam.spellName(slotOf(args[0]), filterOf(args[1])) ?? NOTHING,
  GetSpellInfo: (seam, args) => {
    const value = args[0];
    return (typeof value === "number" || typeof value === "string")
      ? seam.spellInfo?.(value) ?? NOTHING
      : NOTHING;
  },
  // Two shapes, told apart as the client does, by the second argument: `GetSpellLink(slot,
  // bookType)` is a spellbook slot (SpellBookFrame, `GameTooltip:SetSpell`); `GetSpellLink(id or
  // name)` a spell. The link is what gives stock `SetSpell`, AnyIDTooltip and `GetSpell` an id.
  GetSpellLink: (seam, args) => {
    const value = args[0];
    const bookType = typeof args[1] === "string" ? args[1] : undefined;
    if (bookType !== undefined) {
      return typeof value === "number" ? optional(seam.spellLink?.(slotOf(value), bookType)) : NOTHING;
    }
    return typeof value === "number" || typeof value === "string"
      ? optional(seam.spellLink?.(value))
      : NOTHING;
  },
  GetSpellTexture: (seam, args) => optional(seam.spellTexture(slotOf(args[0]), filterOf(args[1]))),
  GetSpellCooldown: (seam, args) => [...seam.spellCooldown(slotOf(args[0]), filterOf(args[1]))],
  GetSpellAutocast: (seam, args) => [...seam.spellAutocast(slotOf(args[0]), filterOf(args[1]))],
  IsPassiveSpell: (seam, args) => optional(seam.spellIsPassive(slotOf(args[0]), filterOf(args[1]))),
  GetKnownSlotFromHighestRankSlot: (seam, args) => optional(
    seam.knownSlotFromHighestRankSlot(slotOf(args[0]), filterOf(args[1])),
  ),
  IsSelectedSpell: (seam, args) => [seam.spellIsSelected(slotOf(args[0]), filterOf(args[1]))],
  HasPetSpells: (seam) => [seam.hasPetSpells()],
  GetNumShapeshiftForms: (seam) => [seam.shapeshiftFormCount()],
  GetShapeshiftFormInfo: (seam, args) => seam.shapeshiftFormInfo(slotOf(args[0])) ?? NOTHING,
  GetShapeshiftFormCooldown: (seam, args) => [...seam.shapeshiftFormCooldown(slotOf(args[0]))],
  CastShapeshiftForm: (seam, args) => { seam.castShapeshiftForm(slotOf(args[0])); return NOTHING; },
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
    if (boolOf(args[0])) return [0];
    return [seam.talentSnapshot(boolOf(args[1]))?.activeTalentGroup ?? 0];
  },
  GetNumTalentGroups: (seam, args) => {
    if (boolOf(args[0])) return [0];
    return [seam.talentSnapshot(boolOf(args[1]))?.numTalentGroups ?? 0];
  },
  GetNumTalentTabs: (seam, args) => {
    if (boolOf(args[0])) return [0];
    const snapshot = seam.talentSnapshot(boolOf(args[1]));
    return [snapshot?.groups[talentGroupOf(snapshot, args[2]) - 1]?.tabs.length ?? 0];
  },
  GetTalentTabInfo: (seam, args) => {
    if (boolOf(args[1])) return NOTHING;
    const snapshot = seam.talentSnapshot(boolOf(args[2]));
    const tab = snapshot?.groups[talentGroupOf(snapshot, args[3]) - 1]?.tabs[slotOf(args[0]) - 1];
    // Preview allocations are deliberately unsupported here. The stock
    // TalentFrame nevertheless adds this value numerically, so the honest empty preview is 0,
    // not Lua nil (which aborts the first tab refresh).
    return tab ? [tab.name, tab.iconTexture, tab.pointsSpent, tab.background, tab.previewPointsSpent ?? 0] : NOTHING;
  },
  GetNumTalents: (seam, args) => {
    if (boolOf(args[1])) return [0];
    const snapshot = seam.talentSnapshot(boolOf(args[2]));
    return [snapshot?.groups[talentGroupOf(snapshot, args[3]) - 1]?.tabs[slotOf(args[0]) - 1]?.talents.length ?? 0];
  },
  GetTalentInfo: (seam, args) => {
    if (boolOf(args[2])) return NOTHING;
    const snapshot = seam.talentSnapshot(boolOf(args[3]));
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
    if (boolOf(args[2])) return NOTHING;
    const snapshot = seam.talentSnapshot(boolOf(args[3]));
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
    if (boolOf(args[0])) return [0];
    const snapshot = seam.talentSnapshot(boolOf(args[1]));
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
  // Wow.exe 0x0060fc40/0x0060fcc0: the current points and the cap, 75000 honor / 10000 arena — the
  // stock refund popup compares against the second value (StaticPopup.lua:143-146, 2.10).
  GetHonorCurrency: (seam) => [seam.pvpHonorCurrency(), 75000],
  GetArenaCurrency: (seam) => [seam.pvpArenaCurrency(), 10000],
  GetNumBattlegroundTypes: (seam) => [seam.battlegroundTypeCount()],
  GetBattlegroundInfo: (seam, args) => seam.battlegroundInfo(slotOf(args[0])) ?? NOTHING,
  GetBattlefieldInfo: (seam) => seam.battlefieldInfo() ?? NOTHING,
  GetBattlefieldStatus: (seam, args) => [...seam.battlefieldStatus(slotOf(args[0]))],
  // BattlefieldFrame_UpdateStatus does arithmetic on these unguarded (BattlefieldFrame.lua:261, 303):
  // a number always, 0 when the seam has no queue clock.
  GetBattlefieldEstimatedWaitTime: (seam, args) => [seam.battlefieldQueueTimes?.(slotOf(args[0]))[0] ?? 0],
  GetBattlefieldTimeWaited: (seam, args) => [seam.battlefieldQueueTimes?.(slotOf(args[0]))[1] ?? 0],
  GetBattlefieldInstanceExpiration: (seam) => [seam.battlefieldInstanceTimes?.()[0] ?? 0],
  GetBattlefieldInstanceRunTime: (seam) => [seam.battlefieldInstanceTimes?.()[1] ?? 0],
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
  GetItemInfo: (seam, args) => seam.itemInfo(args[0]) ?? frameXmlItemInfoByName(seam, args[0]) ?? NOTHING,
  GetNumBuybackItems: (seam) => [seam.buybackNumItems()],
  GetBuybackItemInfo: (seam, args) => seam.buybackItemInfo(slotOf(args[0])) ?? NOTHING,
  GetBuybackItemLink: (seam, args) => optional(seam.buybackItemLink(slotOf(args[0]))),
  BuyMerchantItem: (seam, args) => {
    // Wow.exe 0x005854c0: a missing or non-positive count is 1, a larger one stops at 255.
    seam.buyMerchantItem(slotOf(args[0]), Math.min(255, Math.max(1, slotOf(args[1]) || 1)));
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
  PickupContainerItem: (seam, args) => {
    seam.pickupContainerItem(slotOf(args[0]), slotOf(args[1]));
    return NOTHING;
  },
  CursorHasItem: (seam) => [seam.cursorHasItem()],
  GetCursorInfo: (seam) => seam.cursorInfo(),
  ClearCursor: (seam) => {
    seam.clearCursor();
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
    // Stock item actions take the player's slot ID, unlike the GetInventoryItem* readers.
    seam.useInventoryItem("player", slotOf(args[0]));
    return NOTHING;
  },
  PickupInventoryItem: (seam, args) => {
    seam.pickupInventoryItem("player", slotOf(args[0]));
    return NOTHING;
  },
  UnitStat: (seam, args) => [...seam.unitStat(unitOf(args[0]), slotOf(args[1]))],
  UnitArmor: (seam, args) => [...seam.unitArmor(unitOf(args[0]))],
  UnitResistance: (seam, args) => [...seam.unitResistance(unitOf(args[0]), slotOf(args[1]))],
  UnitAttackPower: (seam, args) => [...seam.unitAttackPower(unitOf(args[0]))],
  UnitRangedAttackPower: (seam, args) => [...seam.unitRangedAttackPower(unitOf(args[0]))],
  GetAttackPowerForStat: (seam, args) => [seam.attackPowerForStat(slotOf(args[0]), Number(args[1]))],
  GetCritChanceFromAgility: (seam, args) => [seam.critChanceFromAgility(unitOf(args[0]))],
  // PaperDollFrame.lua:296 (and PetPaperDoll for a non-mana pet) passes this straight into
  // `format(tooltip2, …)`: a missing value raises «bad argument #3 to '_format'» and aborts
  // UpdatePaperdollStats after the intellect row. Without the class/level catalog the honest
  // contribution this host can state is none, i.e. 0, never nil.
  GetSpellCritChanceFromIntellect: (seam, args) => [
    seam.spellCritChanceFromIntellect?.(unitOf(args[0])) ?? 0,
  ],
  GetUnitMaxHealthModifier: (seam, args) => [seam.unitMaxHealthModifier(unitOf(args[0]))],
  GetUnitHealthRegenRateFromSpirit: (seam, args) => [seam.unitHealthRegenRateFromSpirit(unitOf(args[0]))],
  GetUnitManaRegenRateFromSpirit: (seam, args) => [seam.unitManaRegenRateFromSpirit(unitOf(args[0]))],
  GetCombatRating: (seam, args) => [seam.combatRating(slotOf(args[0]))],
  GetCombatRatingBonus: (seam, args) => [seam.combatRatingBonus(slotOf(args[0]))],
  // Unit.h caps all three resilience critical-damage reductions at 33 percent. L7 4.03: as Wow.exe
  // 0x006082c0 answers it — the double at 0x00a1f778 for CR 15-17 and the one at 0x009ec208 (-1) for
  // every other index (ui/CharacterSheetModel.ts `maxCombatRatingBonus`), never nil.
  GetMaxCombatRatingBonus: (_seam, args) => [[15, 16, 17].includes(slotOf(args[0])) ? 33.000001311302185 : -1],
  GetArmorPenetration: (seam) => [seam.armorPenetration()],
  GetCritChance: (seam) => [seam.critChance()],
  GetRangedCritChance: (seam) => [seam.rangedCritChance?.() ?? 0],
  GetSpellCritChance: (seam, args) => [seam.spellCritChance?.(slotOf(args[0])) ?? 0],
  GetSpellBonusDamage: (seam, args) => [seam.spellBonusDamage?.(slotOf(args[0])) ?? 0],
  GetSpellBonusHealing: (seam) => [seam.spellBonusHealing?.() ?? 0],
  GetSpellPenetration: (seam) => [seam.spellPenetration?.() ?? 0],
  GetManaRegen: (seam) => [...seam.manaRegen?.() ?? [0, 0]],
  GetDodgeChance: (seam) => [seam.dodgeChance?.() ?? 0],
  GetParryChance: (seam) => [seam.parryChance?.() ?? 0],
  GetBlockChance: (seam) => [seam.blockChance?.() ?? 0],
  GetShieldBlock: (seam) => [seam.shieldBlock?.() ?? 0],
  UnitDefense: (seam, args) => [...seam.unitDefense?.(unitOf(args[0])) ?? [0, 0]],
  GetDodgeBlockParryChanceFromDefense: (seam) => [seam.dodgeBlockParryChanceFromDefense?.() ?? 0],
  GetExpertise: (seam) => [...seam.expertise()],
  GetExpertisePercent: (seam) => [...seam.expertisePercent()],
  UnitAttackSpeed: (seam, args) => [...seam.unitAttackSpeed(unitOf(args[0]))],
  UnitDamage: (seam, args) => [...seam.unitDamage(unitOf(args[0]))],
  UnitRangedDamage: (seam, args) => [...seam.unitRangedDamage(unitOf(args[0]))],
  GetQuestGreenRange: (seam) => [questGreenRange(seam.unitLevel("player"))],
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
  GetFactionInfoByID: (seam, args) => seam.factionInfoById(args[0]) ?? NOTHING,
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
  // The four zone texts are strings in the client, "" when there is none: ZoneText_OnEvent tests
  // `GetSubZoneText() == ""`, Minimap_SetTooltip compares the sub-zone with the zone, and
  // WhoFrame_GetDefaultWhoCommand (FriendsFrame.lua:1502) concatenates GetRealZoneText unguarded.
  // So "" while the area metadata is unavailable, and "" for the sub-zone of a zone's own ground.
  GetMinimapZoneText: (seam) => [seam.minimapZoneText() ?? ""],
  GetZoneText: (seam) => [seam.zoneText() ?? ""],
  GetRealZoneText: (seam) => [seam.zoneText() ?? ""],
  GetSubZoneText: (seam) => [seam.subZoneText() ?? ""],
  // The client pushes the number 1 or nil for isSubZonePvP, never false (its GetZonePVPInfo at
  // Wow.exe 0x0051BA50); ZoneText.lua only tests it for truth.
  GetZonePVPInfo: (seam) => {
    const info = seam.zonePvpInfo();
    return info === undefined ? NOTHING : [info[0], info[1] === true ? 1 : undefined, info[2]];
  },
  // Over the base GetGroupPreviewTalentPointsSpent: the talent preview (FrameXmlTalentPreview.ts, 3.33).
  ...FRAMEXML_TALENT_PREVIEW_BINDINGS,
  // Over the stable's pet-only UnitCreatureFamily and the neutral nil UnitCreatureType (3.23A).
  ...FRAMEXML_CREATURE_TYPE_BINDINGS,
  // 3.13c: over the two POI answers above — a seam with a POI model answers through it (FrameXmlQuestPoi.ts).
  ...frameXmlQuestPoiBindings<FrameXmlWorldSeam>({
    QuestMapUpdateAllQuests: (seam) => [seam.questMapUpdateAllQuests()],
    QuestPOIGetQuestIDByVisibleIndex: (seam, args) => optional(seam.questPoiQuestIdByVisibleIndex(slotOf(args[0]))),
  }),
  // 3.01: the combat log (FrameXmlCombatLog.ts).
  ...FRAMEXML_COMBAT_LOG_BINDINGS,
  // L12 3.29: the trainer's skill-line filter, and BuyTrainerService over the base one (FrameXmlTrainerSkillLines.ts).
  ...FRAMEXML_TRAINER_SKILL_LINE_BINDINGS,
  // Last: the one cursor answers the cursor C API over every holder above (FrameXmlCursor.ts).
  ...FRAMEXML_CURSOR_BINDINGS,
  // L5c 3.09: money on that cursor, over the trade's inert PickupTradeMoney/AddTradeMoney and the neutral 0.
  ...FRAMEXML_CURSOR_MONEY_BINDINGS,
  // The repair answers over the neutral four above, and the three repair commands (FrameXmlRepair.ts).
  ...FRAMEXML_REPAIR_BINDINGS,
}))))); // 11.02-F2: one more closing parenthesis for frameXmlWithVehicle; 11.02-E: and one for frameXmlWithVehicleAim

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
${FRAMEXML_LFD_PRELUDE}
${FRAMEXML_LOOT_PRELUDE}
${FRAMEXML_POPUPS_PRELUDE}
${FRAMEXML_FRIENDS_PRELUDE}
${FRAMEXML_MAIL_PRELUDE}
${FRAMEXML_TRADESKILL_PRELUDE}
${FRAMEXML_BINDING_PRELUDE}
${FRAMEXML_INSPECT_PRELUDE}
${FRAMEXML_ITEM_ACTIONS_PRELUDE}
${FRAMEXML_MECHANICS_PRELUDE}
${FRAMEXML_BAG_PORTRAIT_PRELUDE}
${FRAMEXML_QUEST_LOG_PRELUDE}
${FRAMEXML_VEHICLE_PRELUDE}`; // 11.02-F2
