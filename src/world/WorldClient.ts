import { OPCODES } from "../generated/opcodes.js";
import { playerInventory } from "../browser/Inventory.js";
import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import type { BinaryByteStream } from "../transport/WebSocketByteStream.js";
import { sha1Bytes } from "../auth/Srp6.js";
import {
  buildCharacterGuid,
  buildCreateCharacter,
  parseCharacterList,
  parseCharacterResult,
  parseLoginVerifyWorld,
  type CharacterSummary,
  type CreateCharacterRequest,
  type LoginLocation,
} from "./CharacterProtocol.js";
import { WorldConnection, type WorldPacket } from "./WorldConnection.js";
import { UnhandledOpcodeLog } from "./UnhandledOpcodes.js";
import { buildCustomPacket, CustomPacketReassembler } from "./CustomPacket.js";
import { CustomPacketRegistry } from "./CustomPacketRegistry.js";
import {
  buildBuyBankSlot, buildEquipmentSetDelete, buildEquipmentSetSave, buildEquipmentSetUse,
  buildInspect, buildLearnPetTalents, buildLearnTalent, buildPlayedTimeQuery,
  buildRemoveGlyph, buildStandStateChange, MAX_EQUIPMENT_SETS, MAX_GLYPH_SLOTS,
  parseAchievementData, parseAchievementEarned, parseBindPoint, parseCriteriaUpdate,
  parseEnchantTimeUpdate, parseEquipmentSetList, parseEquipmentSetSaved, parseEquipmentSetUseResult,
  parseExplorationExperience,
  parseFactionStanding, parseFactionVisible, parseForcedReactions, parseGuidOnly, parseInebriation,
  parseInitialFactions, parseItemTimeUpdate, parseLearnedSpell, parseLevelUpInfo, parsePlayedTime,
  parsePlayerBound, parseProficiency, parseReferAFriendFailure, parseRemovedSpell,
  parseServerFirstAchievement, parseSocketGems, parseStandState, parseSupercededSpell,
  parseTalentsInfo, parseTitleEarned, parseUnlearnSpells,
  type BindPoint, type EquipmentSet, type FactionState, type TalentsInfo,
} from "./CharacterProgressProtocol.js";

import {
  buildAbandonQuest, buildCompletedQuestsQuery, buildQuestConfirmAccept, buildQuestInfoQuery,
  buildQuestPoiQuery, buildQuestPushResult, parseCompletedQuests, parseGossipPoi, parseQuestConfirmAccept,
  parseQuestGiverStatus, parseQuestGiverStatusMultiple, parseQuestIdUpdate, parseQuestKillUpdate,
  parseQuestPoi, parseQuestPushResult, parseQuestQueryResponse,
  type PointOfInterest, type QuestConfirmAccept, type QuestPoiBlob,
  type QuestTemplate,
} from "./QuestProtocol.js";

import { EventBus, type SpellCastStopReason, type WorldPacketEvents } from "./EventBus.js";
import {
  parseActionButtons, type ActionButton, buildSetActionButton, ACTION_BUTTON_STATE_CLEAR,
} from "./ActionBarProtocol.js";
import {
  ThreatTables, parseThreatClear, parseThreatRemove, parseThreatUpdate,
} from "./ThreatProtocol.js";
import {
  parseAiReaction, parseBreakTarget, parseClearTarget, parseComboPoints, parseDismount,
  parseFeignDeathResisted, parseMountSpecial, parsePartyKill,
} from "./UnitEventProtocol.js";
import {
  parseDamageShieldLog, parseDispelLog, parseEnchantmentLog, parseExecuteLog, parseInstantKillLog,
  parseMirrorImageData, parsePeriodicAuraLog, parseSpellDamageLog, parseSpellEnergizeLog,
  parseSpellHealLog, parseSpellLogPair, parseSpellMissLog, parseSpellVisualKit,
  AURA_PERIODIC_ENERGIZE, AURA_PERIODIC_HEAL, AURA_OBS_MOD_HEALTH, AURA_OBS_MOD_POWER,
} from "./SpellLogProtocol.js";

import { advanceGameTime, parseLoginSetTimeSpeed, type GameTime } from "./GameTimeProtocol.js";
import {
  buildAutostoreLootItem,
  buildLootMoney,
  buildLootRelease,
  buildLootRequest,
  isLootSlotTakeable,
  parseLootMoneyNotify,
  parseLootReleaseResponse,
  parseLootRemoved,
  parseLootResponse,
  type LootWindow,
} from "./LootProtocol.js";
import {
  CHAT_MSG_SYSTEM,
  CHAT_MSG_TEXT_EMOTE,
  buildChatMessage,
  buildJoinChannel,
  buildLeaveChannel,
  buildTextEmote,
  languageForRace,
  parseChatMessage,
  parseEmote,
  parseTextEmote,
  type ChatMessage,
  type TextEmote,
} from "./ChatProtocol.js";
import { emoteById, emoteSentence, type EmoteData, type EmoteName } from "./EmoteRules.js";
import { NameCache, buildNameQuery, parseNameQueryResponse } from "./NameQueryProtocol.js";
import {
  auctionErrorText,
  buildAuctionHello,
  buildAuctionListItems,
  buildAuctionListOwnerItems,
  buildAuctionPlaceBid,
  buildAuctionRemoveItem,
  buildAuctionSellItem,
  buildAuctionListPendingSales,
  parseAuctionBidderNotification,
  parseAuctionCommandResult,
  parseAuctionHello,
  parseAuctionListResult,
  parseAuctionListPendingSales,
  parseAuctionOwnerNotification,
  type AuctionList,
  type AuctionSearch,
} from "./AuctionProtocol.js";
import {
  buildLfgJoin,
  buildLfgLeave,
  buildLfgProposalResult,
  buildLfgSetRoles,
  buildLfgTeleport,
  lfgJoinResultText,
  parseLfgJoinResult,
  parseLfgProposalUpdate,
  parseLfgQueueStatus,
  parseLfgRoleChosen,
  parseLfgUpdate,
  buildLfgBootVote,
  buildLfgPartyLockInfoRequest,
  buildLfgPlayerLockInfoRequest,
  parseLfgBootProposal,
  parseLfgOfferContinue,
  parseLfgPartyInfo,
  parseLfgPlayerInfo,
  parseLfgPlayerReward,
  parseLfgRoleCheckUpdate,
  parseLfgTeleportDenied,
  parseLfgUpdateSearch,
  lfgTeleportDeniedText,
  roleCheckStateText,
  type LfgBootProposal,
  type LfgPlayerInfo,
  type LfgPlayerLocks,
  type LfgPlayerReward,
  type LfgProposal,
  type LfgQueueStatus,
  type LfgRoleCheck,
  type LfgUpdate,
} from "./LfgProtocol.js";
import {
  GE_MOTD,
  buildGuildInviteByName,
  buildGuildAddRank,
  buildGuildDelRank,
  buildGuildDisband,
  buildGuildInfoText,
  buildGuildLeader,
  buildGuildMemberNote,
  buildGuildMotd,
  buildGuildPlayerName,
  buildGuildQuery,
  buildGuildRank,
  guildErrorText,
  parseGuildCommandResult,
  parseGuildEvent,
  parseGuildInfo,
  parseGuildInvite,
  parseGuildQueryResponse,
  parseGuildRoster,
  type GuildInfo,
  type GuildInviteMessage,
  type GuildQueryInfo,
  type GuildRoster,
} from "./GuildProtocol.js";
import {
  MAIL_DELETED,
  MAIL_ITEM_TAKEN,
  MAIL_MONEY_TAKEN,
  MAIL_OK,
  MAIL_RETURNED_TO_SENDER,
  buildGetMailList,
  buildMailDelete,
  buildMailMarkAsRead,
  buildMailReturnToSender,
  buildMailTakeItem,
  buildMailTakeMoney,
  buildSendMail,
  mailErrorText,
  parseMailCommandResult,
  parseMailListResult,
  parseReceivedMail,
  parseShowMailbox,
  type MailDraft,
  type MailCommandResult,
  type MailList,
} from "./MailProtocol.js";
import {
  TRADE_STATUS_BEGIN_TRADE,
  TRADE_STATUS_CLOSE_WINDOW,
  TRADE_STATUS_OPEN_WINDOW,
  TRADE_STATUS_TRADE_ACCEPT,
  TRADE_STATUS_TRADE_CANCELED,
  TRADE_STATUS_TRADE_COMPLETE,
  buildClearTradeItem,
  buildInitiateTrade,
  buildSetTradeGold,
  buildSetTradeItem,
  parseTradeStatus,
  parseTradeStatusExtended,
  tradeStatusText,
  type TradeOffer,
} from "./TradeProtocol.js";
import {
  buildDuelResponse,
  parseDuelComplete,
  parseDuelCountdown,
  parseDuelRequested,
  parseDuelWinner,
  type DuelRequest,
} from "./DuelProtocol.js";
import {
  RAID_SUBGROUPS,
  buildGroupAccept,
  buildGroupAssistantLeader,
  buildGroupChangeSubGroup,
  buildGroupInvite,
  buildGroupRaidConvert,
  buildGroupSetLeader,
  buildGroupUninvite,
  buildLootMethod,
  buildRequestPartyMemberStats,
  parseGroupDecline,
  parseGroupInvite,
  parseGroupList,
  parsePartyCommandResult,
  partyResultText,
  type GroupInvite,
  type GroupState,
} from "./GroupProtocol.js";
import {
  buildMinimapPing, buildPartyAssignment, buildRandomRoll, buildRaidTargetQuery,
  buildReadyCheckAnswer, buildReadyCheckFinished, buildReadyCheckRequest, buildSetRaidTarget,
  mergePartyMemberStats, parseGroupSetLeader, parseMinimapPing, parsePartyMemberStats,
  parseRaidTargetUpdate, parseRandomRoll, parseReadyCheckAnswer, parseReadyCheckStart,
  parseRealGroupUpdate,
  type RealGroupUpdate, raidTargetName,
  type PartyMemberStats, type RaidTargetUpdate,
} from "./PartyProtocol.js";
import {
  buildLootMasterGive, buildLootRoll, lootRollText, parseLootAllPassed, parseLootList,
  parseLootMasterList, parseLootRoll, parseLootRollWon, parseLootStartRoll,
  type LootOwners, type LootRollStart, type LootRollVote, type LootRollWon,
} from "./LootRollProtocol.js";
import {
  buildGuildBankBuyTab,
  buildGuildBankDepositItem,
  buildGuildBankLogQuery, buildGuildBankMoneyWithdrawnQuery, buildGuildBankQueryTab,
  buildGuildBankMoney,
  buildGuildBankTextQuery, buildGuildBankerActivate, buildGuildEventLogQuery,
  buildGuildBankUpdateTab,
  buildGuildBankWithdrawItem,
  buildGuildPermissionsQuery, buildSaveGuildEmblem, buildTabardVendorActivate,
  guildEmblemErrorText, parseGuildBankList, parseGuildBankLog, parseGuildBankMoneyWithdrawn,
  parseGuildBankTabText, parseGuildEventLog, parseGuildPermissions, parseSaveGuildEmblem,
  parseTabardVendorActivate,
  type GuildBankContent, type GuildBankLog, type GuildEventLogEntry, type GuildPermissions,
} from "./GuildBankProtocol.js";
import {
  buildCalendarAddEvent,
  buildCalendarArenaTeam,
  buildCalendarComplain,
  buildCalendarCopyEvent,
  buildCalendarEventQuery, buildCalendarPendingCountQuery, buildCalendarQuery, calendarErrorText,
  buildCalendarEventStatus,
  buildCalendarGuildFilter,
  buildCalendarInvite,
  buildCalendarModeratorStatus,
  buildCalendarRemoveEvent,
  buildCalendarRemoveInvite,
  buildCalendarRsvp,
  buildCalendarSignUp,
  buildCalendarUpdateEvent,
  parseCalendarCommandResult, parseCalendarEvent, parseCalendarEventRemovedAlert,
  parseCalendarEventStatus, parseCalendarEventStatusAlert, parseCalendarEventUpdatedAlert,
  parseCalendarInitialInvites, parseCalendarInviteAdded, parseCalendarInviteAlert,
  parseCalendarInviteNotes, parseCalendarInviteNotesAlert, parseCalendarInviteRemoved,
  parseCalendarModeratorStatus, parseCalendarPendingCount, parseCalendarSnapshot,
  parseRaidLockoutAdded, parseRaidLockoutRemoved, parseRaidLockoutUpdated,
  type CalendarEventDetail, type CalendarSnapshot, type RaidLockoutChange,
  type CalendarEventFields,
  type CalendarNewInvite,
} from "./CalendarProtocol.js";
import {
  channelNotifyText, chatRestrictedText, parseChannelList, parseChannelMemberCount,
  parseChannelNotify, parseChatPlayerName, parseChatRestricted, parseComplainResult,
  parseUserlistChange,
  CHAT_YOU_LEFT_NOTICE, CHAT_MODE_CHANGE_NOTICE, CHAT_JOINED_NOTICE, CHAT_LEFT_NOTICE,
  type ChannelMember,
} from "./ChannelProtocol.js";
import {
  buildAddFriend, buildAddIgnore, buildContactListQuery, buildDeleteFriend, buildDeleteIgnore,
  buildNextMailTimeQuery, buildWhoIs, buildWhoQuery, friendResultText, parseContactList,
  parseFriendStatus, parseNextMailTime, parseWho, parseWhois,
  FRIEND_IGNORE_ADDED, FRIEND_IGNORE_REMOVED, FRIEND_REMOVED, SOCIAL_FLAG_FRIEND,
  SOCIAL_FLAG_IGNORED,
  type Contact, type ContactList, type NextMailTime, type WhoResult, type WhoRequest,
} from "./ContactProtocol.js";
import {
  buildPetitionDecline, buildPetitionQuery, buildPetitionRename, buildPetitionShowList,
  buildPetitionShowSignatures, buildPetitionSign, buildTurnInPetition, parsePetitionDecline,
  parsePetitionQueryResponse, parsePetitionRenamed, parsePetitionShowList,
  parsePetitionSignResult, parsePetitionSignatures, parseTurnInPetitionResult, petitionSignText,
  petitionTurnInText,
  type PetitionInfo, type PetitionSignatures, type PetitionVendor,
} from "./PetitionProtocol.js";
import {
  buildDismissCritter, buildPetAbandon, buildPetAction, buildPetCancelAura, buildPetNameQuery,
  buildPetRename, buildPetSetAction, buildPetSpellAutocast, buildPetStopAttack, buildPetSwapAction,
  buildRequestPetInfo, packPetAction, parsePetActionFeedback, parsePetActionSound,
  parsePetCastFailed, parsePetComboPoints, parsePetLearnedSpell, parsePetNameInvalid,
  parsePetNameQueryResponse, parsePetSpells, parsePetTameFailure, parsePetUnlearnedSpell,
  petCooldownRemaining, petFeedbackText, petNameErrorText, petTameFailureText,
  ACT_COMMAND, ACT_REACTION,
  type PetName, type PetSpells,
} from "./PetProtocol.js";
import {
  buildBuyStableSlot, buildStableListQuery, buildStablePet, buildStableSwapPet, buildUnstablePet,
  isStableSuccess, parseStableList, parseStableResult, stableResultText,
  type StableList,
} from "./StableProtocol.js";
import {
  buildEjectPassenger, buildPlayerVehicleEnter, buildRequestVehicleExit,
  buildRequestVehicleNextSeat, buildRequestVehiclePrevSeat, buildRequestVehicleSwitchSeat,
  parseCancelExpectedRideVehicleAura, parsePlayerVehicleData,
} from "./VehicleProtocol.js";
import {
  battlegroundJoinResultText, buildBattlefieldList, buildBattlefieldPort,
  buildBattlefieldStatusQuery, buildBattlegroundPlayerPositionsQuery, buildBattlemasterHello,
  buildBattlemasterJoin, buildBattlemasterJoinArena, buildLeaveBattlefield, buildPvpLogDataQuery,
  buildReportPvpAfk, buildTogglePvp, isBattlegroundJoinFailure, parseArenaUnitDestroyed,
  parseBattlefieldList, parseBattlefieldStatus, parseBattlegroundPlayer,
  parseBattlegroundPlayerPositions, parseGroupJoinedBattleground, parsePvpCredit, parsePvpLogData,
  STATUS_IN_PROGRESS,
  type BattlefieldList, type BattlefieldStatus, type FlagCarrier, type PvpCredit, type PvpLogData,
} from "./PvpProtocol.js";
import {
  arenaErrorText, arenaTeamCommandResultText, arenaTeamEventText, buildArenaTeamAccept,
  buildArenaTeamDecline, buildArenaTeamDisband, buildArenaTeamInvite, buildArenaTeamLeader,
  buildArenaTeamLeave, buildArenaTeamQuery, buildArenaTeamRemove, buildArenaTeamRosterQuery,
  buildInspectArenaTeams, buildInspectHonorStats, parseArenaError, parseArenaTeamCommandResult,
  parseArenaTeamEvent, parseArenaTeamInvite, parseArenaTeamQueryResponse, parseArenaTeamRoster,
  parseArenaTeamStats, parseInspectArenaTeams, parseInspectHonorStats,
  ARENA_TEAM_EVENT_DISBANDED,
  type ArenaTeamInfo, type ArenaTeamInvite, type ArenaTeamRoster, type ArenaTeamStats,
  type HonorStats, type InspectedArenaTeam,
} from "./ArenaProtocol.js";
import {
  battlefieldLeaveReasonText, buildBattlefieldEntryInviteResponse,
  buildBattlefieldQueueInviteResponse, buildBattlefieldExitRequest, parseBattlefieldEjected,
  parseBattlefieldEntered, parseBattlefieldEntryInvite, parseBattlefieldQueueInvite,
  parseBattlefieldQueueResponse,
  type BattlefieldQueueInvite, type BattlefieldWarInvite,
} from "./BattlefieldProtocol.js";
import {
  buildWorldStateUiTimerQuery, parseInitWorldStates, parseUpdateWorldState, parseWorldStateUiTimer,
} from "./WorldStateProtocol.js";
import {
  buildAddonBlock, buildAddonMessageBody, buildLogoutCancel, buildLogoutRequest,
  buildPlayerLogout, buildQueryTime, buildRealmSplit, buildReadyForAccountDataTimes,
  buildRequestAccountData, buildTutorialClear, buildTutorialFlag, buildTutorialReset,
  buildUpdateAccountData, chatServerMessageText, deflate, inflate, parseAccountDataTimes,
  parseAddonInfo, parseAddonMessageBody, parseChatServerMessage, parseClientCacheVersion,
  parseDeclinedNamesResult, parseEmptySessionPacket, parseFeatureSystemStatus, parseMotd,
  parseLogoutResponse, parseNotification, parseQueryTimeResponse, parseRealmSplit,
  parseTutorialFlags,
  parseUpdateAccountData, parseUpdateAccountDataComplete, parseWardenData,
  CHAT_MSG_ADDON, LANG_ADDON, MAX_ACCOUNT_TUTORIAL_VALUES, MAX_SECURE_ADDONS,
  type AccountDataTimes, type AddonInfo, type DeclaredAddon, type FeatureSystemStatus,
  type LogoutResponse, type RealmSplit, type ServerTime,
} from "./SessionProtocol.js";
import {
  buildCreatureQuery, buildItemNameQuery, buildItemQuery, buildItemTextQuery, buildPageTextQuery,
  parseCreatureQueryResponse, parseItemNameQueryResponse, parseItemQueryResponse,
  parseItemTextQueryResponse, parsePageTextQueryResponse,
  type CreatureTemplate, type ItemSetName, type ItemTemplate, type PageText,
} from "./QueryCacheProtocol.js";
import {
  buildGmResponseResolve, buildTicketCreate, buildTicketDelete, buildTicketGet,
  buildTicketSystemStatus, buildTicketUpdate, isTicketSuccess, parseGmResponse,
  parseGmResponseStatusUpdate, parseGmTicket, parseTicketResponse, parseTicketSystemStatus,
  ticketResponseText, GMTICKET_QUEUE_STATUS_ENABLED, GMTICKET_STATUS_HASTEXT,
  type GmResponse, type GmTicket, type TicketRequest,
} from "./TicketProtocol.js";
import {
  barberShopResultText, buildAlterAppearance, parseBarberShopResult, parseCharacterServiceResult,
  BARBER_SHOP_RESULT_SUCCESS,
  type CharacterServiceResult,
} from "./CharacterServiceProtocol.js";
import { parsePlayObjectSound, parsePlaySound, type SoundRequest } from "./SoundProtocol.js";
import {
  buildAutoEquipItem,
  buildAutoStoreBagItem,
  buildDestroyItem,
  buildSocketGems,
  buildSplitItem,
  buildSwapInvItem,
  buildSwapItem,
  buildUseItem,
  equipErrorText,
  parseInventoryChangeFailure,
  parseItemPushResult,
  INVENTORY_SLOT_BAG_0,
} from "./ItemProtocol.js";
import {
  BANK_SLOT_OK, bankSlotResultText, buildAutoBankItem, buildAutoStoreBankItem, buildBankerActivate,
  parseBuyBankSlotResult,
} from "./BankProtocol.js";
import {
  buildBuyItem,
  buildBuybackItem,
  buildListInventory,
  buildSellItem,
  buyErrorText,
  parseBuyFailed,
  parseBuyItem,
  parseListInventory,
  parseSellItem,
  sellErrorText,
  type VendorInventory,
} from "./VendorProtocol.js";
import {
  buildTrainerBuySpell,
  buildTrainerList,
  parseTrainerBuyFailed,
  parseTrainerBuySucceeded,
  parseTrainerList,
  TRAINER_SPELL_AVAILABLE,
  trainerBuyFailureText,
  type TrainerList,
} from "./TrainerProtocol.js";
import {
  buildAreaSpiritHealerRequest, buildCorpseMapPositionQuery, buildCorpseQuery, buildReclaimCorpse, buildRepopRequest, buildResurrectResponse, buildSpiritHealerActivate, parseAreaSpiritHealerTime, parseCorpseMapPosition, parseCorpseQuery, parseCorpseReclaimDelay, parseDeathReleaseLoc, parseResurrectRequest, parseSpiritHealerConfirm, type CorpseLocation, type DeathReleaseLocation, type ResurrectRequest,
} from "./DeathProtocol.js";
import { decompressObjectUpdate, isWorldObjectDead, WorldState, type WorldObjectState, type WorldPosition } from "./WorldState.js";
import { buildMovementPacket, parseMovementPacket, type MovementInfo } from "./MovementProtocol.js";
import {
  mirrorTimerRemaining, parsePauseMirrorTimer, parseStartMirrorTimer, parseStopMirrorTimer,
  type MirrorTimer,
} from "./MirrorTimerProtocol.js";

/** The part of a MovementInfo that is not the flags, the time or the position. */
export type MovementExtra = Omit<MovementInfo, "flags" | "flags2" | "time" | "position">;
import {
  ackOpcodeForSpeed, buildForcedSpeedAck, buildKnockBackAck, buildMovementToggleAck, buildTeleportAck,
  buildWorldportAck, isForcedSpeed, isMovementToggle, movementToggleFor, parseClientControlUpdate,
  parseForcedSpeed, parseKnockBack, parseMovementToggle, parseMultipleMoves, parseNewWorld,
  parseTeleportRequest, parseTransferAborted, parseTransferPending,
  type ForcedSpeedName, type KnockBack,
} from "./MovementAckProtocol.js";
import {
  isSplineMoveState, isSplineSpeed, parseFlightSplineSync, parseSplineMoveState, parseSplineSpeed,
} from "./SplineStateProtocol.js";
import {
  buildCinematicAck, buildSummonResponse, parseAreaTriggerMessage, parseBuildingDamage,
  parseCinematicId, parseDefenseMessage, parseOverrideLight, parsePhaseShift, parseSummonRequest,
  parseWeather, parseZoneUnderAttack, type SummonRequest, type Weather,
} from "./WorldMessageProtocol.js";
import {
  activateTaxiReplyText, buildActivateTaxi, buildActivateTaxiExpress, buildTaxiNodeStatusQuery,
  buildTaxiQuery, parseActivateTaxiReply, parseShowTaxiNodes, parseTaxiNodeStatus, TAXI_REPLY_OK,
  type TaxiMenu,
} from "./TaxiProtocol.js";
import {
  buildSetDifficulty, parseDungeonDifficulty, parseEncounterFrame, parseInstanceDifficulty,
  parseInstanceLockWarning, parseInstanceMapId, parseInstanceResetFailed, parseRaidGroupOnly,
  parseRaidInstanceInfo, parseRaidInstanceMessage, RAID_INSTANCE_WELCOME, type InstanceLockout,
} from "./InstanceProtocol.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";

/** `MAX_QUEST_LOG_SIZE`: the most quest ids one POI query may name before the server drops it. */
const QUEST_POI_CHUNK = 25;
/** A cast with no answer cannot remain a candidate forever, especially across a cast-count wrap. */
const PENDING_CAST_TTL = 60_000;
/** A missing GO query response must not retain a click intent for the rest of the realm session. */
const GAME_OBJECT_TEMPLATE_WAIT_MS = 10_000;
/** `UNIT_FLAG_MOUNT`: the authoritative mounted bit in `UNIT_FIELD_FLAGS`. */
const UNIT_FLAG_MOUNT = 0x08000000;
/** Spellbook's client action row: it maps to the melee protocol, never CMSG_CAST_SPELL. */
export const MELEE_AUTO_ATTACK_SPELL_ID = 6603;
import {
  SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED,
  buildCombatGuid, buildSetSheathed, parseAttackStart, parseAttackStop, parseAttackerStateUpdate,
  parseEnvironmentalDamage, parseExperienceGain, parseHealthUpdate,
  type AttackerState, type EnvironmentalDamage, type ExperienceGain,
} from "./CombatProtocol.js";
import {
  buildGameObjectQuery, buildGameObjectReportUse, buildGameObjectUse, parseEnableBarberShop,
  parseFishingFailure, parseGameObjectCustomAnim, parseGameObjectDespawnAnim,
  parseGameObjectPageText, parseGameObjectQueryResponse, type GameObjectTemplate,
} from "./GameObjectProtocol.js";
import { parseMonsterMove } from "./MonsterMoveProtocol.js";
import {
  isMovementRelaySpeed, parseMovementRelayKnockBack, parseMovementRelaySpeed,
  parseMovementTimeSkipped, RELAY_STATE_OPCODES,
} from "./MovementRelayProtocol.js";
import {
  buildAutoRepeatCastSpell, buildCastSpell, buildCastSpellOnGameObject, buildCastSpellOnItem,
  parseCastFailure,
  spellFailureText,
  parseClearCooldown,
  parseCooldownEvent,
  parseInitialSpells,
  parseSpellCastHeader, parseSpellGo,
  parseSpellCooldown,
  type KnownSpell,
} from "./SpellProtocol.js";
import { applyAuraUpdate, parseAuraUpdate, type ActiveAura } from "./AuraProtocol.js";
import {
  buildGossipHello,
  buildGossipSelect,
  buildNpcTextQuery,
  buildQuestAccept,
  buildQuestAction,
  buildQuestChooseReward,
  buildQuestGiverHello,
  buildQuestQuery,
  parseGossipMessage,
  parseNpcText,
  parseQuestDetails,
  parseQuestList,
  parseQuestOfferReward,
  parseQuestRequestItems,
  type GossipMessage,
  type NpcText,
  type QuestDialog,
  type QuestList,
} from "./NpcProtocol.js";
import { parseMountResult, parseSpellModifier, parseTotemCreated, parseAddRunePower, parseChannelStart, parseChannelUpdate, parseConvertRune, parseItemCooldown, parseModifyCooldown, parseProjectilePosition, parseResyncRunes, parseSpellDelayed, parseSpellFailure } from "./SpellProtocol.js";
import { parseCancelAutoRepeat, parsePowerUpdate } from "./UnitEventProtocol.js";

const encoder = new TextEncoder();
/** Account blobs are stored as C strings, so what comes back has to be decoded, not sliced. */
const TEXT_DECODER = new TextDecoder();
const AUTH_OK = 12;
const AUTH_WAIT_QUEUE = 27;
const CHAR_CREATE_SUCCESS = 47;
const CHAR_DELETE_SUCCESS = 71;
/** TrinityCore/AzerothCore WotLK SpellCastResult values for a true cancel/interruption. */
const SPELL_FAILED_INTERRUPTED = 40;
const SPELL_FAILED_INTERRUPTED_COMBAT = 41;
const MOVEMENT_OPCODES = new Set<number>([
  OPCODES.MSG_MOVE_START_FORWARD,
  OPCODES.MSG_MOVE_START_BACKWARD,
  OPCODES.MSG_MOVE_STOP,
  OPCODES.MSG_MOVE_START_STRAFE_LEFT,
  OPCODES.MSG_MOVE_START_STRAFE_RIGHT,
  OPCODES.MSG_MOVE_STOP_STRAFE,
  OPCODES.MSG_MOVE_JUMP,
  OPCODES.MSG_MOVE_START_TURN_LEFT,
  OPCODES.MSG_MOVE_START_TURN_RIGHT,
  OPCODES.MSG_MOVE_STOP_TURN,
  OPCODES.MSG_MOVE_FALL_LAND,
  OPCODES.MSG_MOVE_START_SWIM,
  OPCODES.MSG_MOVE_STOP_SWIM,
  OPCODES.MSG_MOVE_SET_FACING,
  OPCODES.MSG_MOVE_HEARTBEAT,
  // Walk mode goes both ways like the rest of the family: the client sends it when the player
  // toggles walking, and the server mirrors it to everyone who can see them.
  OPCODES.MSG_MOVE_SET_WALK_MODE,
  OPCODES.MSG_MOVE_SET_RUN_MODE,
  // Rising and sinking: a swimmer and a flying mount both use these, and there is no
  // MSG_MOVE_STOP_DESCEND in this build — stopping either one is MSG_MOVE_STOP_ASCEND.
  OPCODES.MSG_MOVE_START_ASCEND,
  OPCODES.MSG_MOVE_STOP_ASCEND,
  OPCODES.MSG_MOVE_START_DESCEND,
  // Where a swimmer is pointing, which is what makes a dive a dive rather than a sink.
  OPCODES.MSG_MOVE_SET_PITCH,
  // The rest of the family, from slice P4. Every one is the same shape — a packed guid and a
  // MovementInfo — because the server mirrors what it was sent: `Unit::BuildMovementPacket` for
  // the two states, `WorldSession::WriteMovementInfo` for the three pitch changes. Levitation
  // and hovering reach the mover as SMSG toggles to acknowledge; these are the copies everyone
  // else in the zone gets, and without them a levitating neighbour walks on the ground.
  OPCODES.MSG_MOVE_GRAVITY_CHNG,
  OPCODES.MSG_MOVE_HOVER,
  OPCODES.MSG_MOVE_START_PITCH_UP,
  OPCODES.MSG_MOVE_START_PITCH_DOWN,
  OPCODES.MSG_MOVE_STOP_PITCH,
  // Slice P9: the last three state relays, identical in shape and in meaning to the two above
  // them. `Player::SetFeatherFall`, `SetWaterWalking` and `SetCanFly` each answer the owner with
  // an SMSG toggle and then broadcast one of these to everyone else, built by the same
  // `BuildMovementPacket`. Without them a neighbour who takes a slow fall still plummets here.
  ...RELAY_STATE_OPCODES,
]);

export interface WorldLogin {
  username: string;
  sessionKey: Uint8Array;
  realmId: number;
  /** Auth-list name of the selected realm; retained for the stock GetRealmName API. */
  realmName?: string;
  /**
   * Addons to declare in the authentication packet.
   *
   * The server answers each one in `SMSG_ADDON_INFO`, in this order and with no count of its own —
   * so this list is what makes that packet readable at all, and an empty list is a valid answer to
   * a valid question rather than a missing feature.
   */
  addons?: readonly DeclaredAddon[];
}

/** `SpellMissInfo`, in the core's own order, worded for the text that floats over a head. */
const MISS_REASONS: Readonly<Record<number, string>> = {
  1: "промах", 2: "сопротивление", 3: "уклонение", 4: "парирование", 5: "блок", 6: "уклонение",
  7: "иммунитет", 8: "отражено", 9: "поглощено", 10: "отражено", 11: "не в цель", 12: "нет цели",
};

interface PendingSpellCast {
  spellId: number;
  castCount: number;
  sentAt: number;
  accepted?: boolean;
  /** A server cooldown packet already armed this request; GO must not restart it. */
  cooldownAuthoritative?: boolean;
  /** Filled by the UI when it has DBC recovery data; never starts a timer by itself. */
  cooldownDuration?: number;
  /** DBC/core marks this spell as starting recovery from a later cooldown event. */
  cooldownStartedOnEvent?: boolean;
}

export interface CooldownSnapshot {
  startedAt: number;
  duration: number;
  endsAt: number;
}

interface GameObjectTemplateWaiter {
  entry: number;
  /** The concrete spawn generation present when the click/hover was armed. */
  object: WorldObjectState;
  promise: Promise<GameObjectTemplate | undefined>;
  resolve: (template: GameObjectTemplate | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

function auraEqual(before: ActiveAura, after: ActiveAura): boolean {
  return before.spellId === after.spellId
    && before.flags === after.flags
    && before.casterLevel === after.casterLevel
    && before.applications === after.applications
    && before.casterGuid === after.casterGuid
    && before.maxDuration === after.maxDuration
    && before.duration === after.duration
    && before.expiresAt === after.expiresAt;
}

function auraDiff(previous: ReadonlyMap<number, ActiveAura>, current: ReadonlyMap<number, ActiveAura>): {
  added: ActiveAura[];
  removed: ActiveAura[];
  updated: { before: ActiveAura; after: ActiveAura }[];
} {
  const added: ActiveAura[] = [];
  const removed: ActiveAura[] = [];
  const updated: { before: ActiveAura; after: ActiveAura }[] = [];
  for (const [slot, before] of previous) {
    const after = current.get(slot);
    if (!after) removed.push(before);
    else if (after.spellId !== before.spellId) {
      removed.push(before);
      added.push(after);
    } else if (!auraEqual(before, after)) updated.push({ before, after });
  }
  for (const [slot, after] of current) if (!previous.has(slot)) added.push(after);
  return { added, removed, updated };
}

function isMounted(object: WorldObjectState | undefined): boolean {
  if (!object) return false;
  const flags = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset) ?? 0;
  if ((flags & UNIT_FLAG_MOUNT) !== 0) return true;
  return (object.fields.get(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset) ?? 0) > 0;
}

function hasAuraSpell(auras: ReadonlyMap<number, ActiveAura> | undefined, spellId: number): boolean {
  if (!auras) return false;
  for (const aura of auras.values()) if (aura.spellId === spellId) return true;
  return false;
}

export class WorldClient {
  readonly #connection: WorldConnection;
  readonly state = new WorldState();
  onStateChange: ((state: WorldState) => void) | undefined;
  onWorldError: ((error: Error) => void) | undefined;
  /** One packet this client could not model. The session carries on; only that packet is lost. */
  onPacketError: ((opcode: number, error: Error) => void) | undefined;
  /** A teleport has completed and the world has changed under the player. */
  onWorldChanged: ((mapId: number, position: WorldPosition) => void) | undefined;
  onMovementStatus: ((ready: boolean, sentPackets: number) => void) | undefined;
  movementReady = false;
  movementPacketsSent = 0;
  mapId: number | undefined;
  /** The rates the server has forced on this player, by name. */
  readonly speeds = new Map<ForcedSpeedName, number>();
  /**
   * What the server has decided this character may and may not do.
   *
   * These arrive as toggles that have to be acknowledged, and until now they were acknowledged and
   * forgotten — which is why walking on water, hovering, flying and being rooted were all things
   * the client agreed to and then ignored. The physics reads them every frame.
   */
  readonly movementState = {
    rooted: false,
    waterWalking: false,
    featherFall: false,
    hovering: false,
    canFly: false,
    gravityDisabled: false,
    /** From `SMSG_MOVE_SET_COLLISION_HGT`, which overrides the model's own height when it comes. */
    collisionHeight: 0,
  };
  /** The last fall clock, jump block and pitch sent, so an acknowledgement echoes the same state. */
  #movementExtra: MovementExtra = {};
  /** The mirror timers the server is running: breath, fatigue and fire, by type. */
  readonly mirrorTimers = new Map<number, { timer: MirrorTimer; receivedAt: number }>();
  onMirrorTimersChanged: (() => void) | undefined;
  targetGuid: bigint | undefined;
  attacking = false;
  /**
   * The last swing complaint, still standing. Present while the server is swinging and missing
   * because of range or facing, and cleared by the next swing that lands — which is the only
   * "resolved" signal there is.
   */
  swingWarning: string | undefined;
  onCombatStatus: ((message: string, attacking: boolean, error: boolean) => void) | undefined;
  /** Every melee swing in view, the player's own and everyone else's. */
  onSwing: ((swing: AttackerState) => void) | undefined;
  /**
   * `SMSG_EMOTE`: a unit is doing something with its body rather than saying anything.
   *
   * The id is Emotes.dbc, which names the animation; the packet itself carries no pose, so a
   * client that does not read that table has nothing to play.
   */
  onEmote: ((guid: bigint, emoteId: number) => void) | undefined;
  /** The unit this client is allowed to move: its own character, or whatever it is possessing. */
  controlledGuid: bigint | undefined;
  /** Whether `SMSG_CLIENT_CONTROL_UPDATE` has spoken; until it does, the client claims its own. */
  #controlAnnounced = false;
  /** `SMSG_MOVE_KNOCK_BACK`: the character has been thrown, and the physics has to follow. */
  onKnockBack: ((knockBack: KnockBack) => void) | undefined;
  /** The weather where the character is standing, or undefined until the server says. */
  weather: Weather | undefined;
  /** A light a script has forced on the zone, which overrides the time of day. */
  overrideLight: { areaLightId: number; overrideLightId: number; milliseconds: number } | undefined;
  /** Previous Light.dbc row for the latest transition, including a scripted clear (target id 0). */
  overrideLightFromId: number | undefined;
  /** Monotonic receive time used to honour the transition duration from SMSG_OVERRIDE_LIGHT. */
  overrideLightReceivedAt = 0;
  /** Which phases of the world this character can see. Everything is phase 1 by default. */
  phaseMask = 1;
  /** The last flight map a flight master sent. */
  taxiMenu: TaxiMenu | undefined;
  /** The last selected flight's server-authored result. */
  taxiMessage: { text: string; error: boolean } | undefined;
  /** Only the flight master whose query is still outstanding may open a map. */
  #pendingTaxiGuid = 0n;
  /** The exact visible map that owns the next activation reply. */
  #pendingTaxiActivationMenu: TaxiMenu | undefined;
  /** A newly discovered node makes the core omit SHOWTAXINODES; retry that query exactly once. */
  #retriedNewTaxiPath = false;
  /** Whether each flight master in view has a node this character already knows. */
  readonly taxiNodeStatus = new Map<bigint, boolean>();
  /** A summon waiting to be answered, until its timeout runs out. */
  summonRequest: SummonRequest | undefined;
  dungeonDifficulty = 0;
  raidDifficulty = 0;
  /** The difficulty of the map the character is standing on. */
  instanceDifficulty = 0;
  /** Every permanent lockout this character holds. */
  lockouts: InstanceLockout[] = [];
  /** Battleground spirit healers and when each next sweeps, by healer guid. */
  readonly spiritHealerTimers = new Map<bigint, { milliseconds: number; receivedAt: number }>();
  /** The healer asking whether to resurrect here, until it is answered. */
  spiritHealerConfirm: bigint | undefined;
  /** Where the corpse lies on the world map, for one left inside an instance. */
  corpseMapPosition: { x: number; y: number; z: number } | undefined;
  onExperience: ((gain: ExperienceGain) => void) | undefined;
  onEnvironmentalDamage: ((damage: EnvironmentalDamage) => void) | undefined;
  /** Game object templates by entry; null marks one the server does not know. */
  readonly gameObjectTemplates = new Map<number, GameObjectTemplate | null>();
  readonly #requestedGameObjects = new Set<number>();
  /** One deferred first-click per live GO guid; template answers fan out by entry. */
  readonly #gameObjectTemplateWaiters = new Map<bigint, GameObjectTemplateWaiter>();
  onGameObjectsChanged: (() => void) | undefined;
  knownSpells: KnownSpell[] = [];
  /**
   * Whether `SMSG_INITIAL_SPELLS` has landed.
   *
   * An empty list means two different things before and after it, and the spellbook could not tell
   * them apart: it wrote «Активных заклинаний нет» at a character who simply had not been told yet.
   */
  initialSpellsReceived = false;
  onSpellsChanged: ((spells: readonly KnownSpell[]) => void) | undefined;
  onSpellStatus: ((message: string, error: boolean) => void) | undefined;
  /** Mount spell ids resolved from DBC metadata; kept here so every cast entry point shares the rule. */
  readonly #mountSpellIds = new Set<number>();
  /** Ranged repeat spell ids resolved from `SPELL_ATTR2_AUTOREPEAT_FLAG`. */
  readonly #autoRepeatSpellIds = new Set<number>();
  /** The locally requested server repeat container, separate from melee `attacking`. */
  autoRepeatSpellId: number | undefined;
  /** Last background repeat error already reported; reset by success, stop or a changed result. */
  #autoRepeatFailure: { spellId: number; result: number } | undefined;
  readonly cooldowns = new Map<number, number>();
  /** The start/duration pair that produced each end time, for stable cooldown rendering. */
  readonly cooldownSnapshots = new Map<number, CooldownSnapshot>();
  onCooldownsChanged: (() => void) | undefined;
  onCooldownEvent: ((spellId: number) => void) | undefined;
  /** A spell went off: who cast it, which one, and everything the server says it landed on. */
  onSpellVisual: ((casterGuid: bigint, spellId: number, hits: readonly bigint[]) => void) | undefined;
  /**
   * A game object playing one of its four custom animations.
   *
   * Fire and forget: the server sends this once to whoever is in range at that moment and never
   * repeats it, not on relog and not when someone walks back into view. Nothing is stored here,
   * because there is nothing to store — the object's state byte says what it looks like now, and
   * this says only that something happened to it just then.
   */
  onGameObjectAnimation: ((guid: bigint, animation: number) => void) | undefined;
  readonly auras = new Map<bigint, Map<number, ActiveAura>>();
  onAurasChanged: (() => void) | undefined;
  gossip: GossipMessage | undefined;
  readonly npcTexts = new Map<number, NpcText>();
  onGossipChanged: (() => void) | undefined;
  questList: QuestList | undefined;
  questDialog: QuestDialog | undefined;
  questMessage: { text: string; error: boolean } | undefined;
  onQuestChanged: (() => void) | undefined;
  /**
   * What the world reports as it happens, for the panels that care. New work goes here rather
   * than onto another `onX` callback: those hold one owner each.
   */
  readonly events = new EventBus<WorldPacketEvents>();
  /** Who is casting what, by caster. A target frame reads it for the unit it is showing. */
  readonly casts = new Map<bigint, {
    spellId: number;
    startedAt: number;
    duration: number;
    channel: boolean;
    /** Ordinary START/FAILURE packets carry this 8-bit identity; channels do not. */
    castCount?: number;
  }>();
  /** The action bars as the server holds them: 144 slots, twelve pages of twelve. */
  actionButtons: ActionButton[] = [];
  /** Who each creature is angry at. */
  readonly threat = new ThreatTables();
  /** Combo points the character has on its target, and on whom. */
  comboPoints: { guid: bigint; points: number } | undefined;
  /** A death knight's runes, as last resynced. */
  runes: Array<{ type: number; readiness: number }> = [];
  /** What each quest in the log actually is, asked for once and kept. */
  readonly questTemplates = new Map<number, QuestTemplate>();
  /** The mark to draw over a head, by guid, as the server last reported it. */
  readonly questGiverStatus = new Map<bigint, number>();
  /** Every quest this character has ever finished, once it has been asked for. */
  readonly completedQuests = new Set<number>();
  /** A quest a party member is trying to share, waiting on an answer. */
  sharedQuest: QuestConfirmAccept | undefined;
  #questsAsked = new Set<number>();
  /** Reputation by list id, as the server holds it: 128 entries whether met or not. */
  readonly factions = new Map<number, FactionState>();
  /** Factions whose attitude is fixed regardless of standing. */
  readonly forcedReactions = new Map<number, number>();
  /** Achievements completed, and how far each tracked criterion has come. */
  readonly achievements = new Map<number, number>();
  readonly criteria = new Map<number, bigint>();
  /** Talents, glyphs and how many points are left to spend. */
  talents: TalentsInfo | undefined;
  /** The pet's own tree, which arrives on the same opcode with its first byte set. */
  petTalents: TalentsInfo | undefined;
  /** Where each quest in the log wants the player to go, by quest id. An empty list is an answer. */
  readonly questPoi = new Map<number, QuestPoiBlob[]>();
  /** The last point a gossip menu marked, with the map it was received on stamped alongside. */
  gossipPoi: (PointOfInterest & { mapId: number | undefined }) | undefined;
  /** Saved equipment sets, by the order the server lists them. */
  equipmentSets: EquipmentSet[] = [];
  /** Where the hearthstone goes. */
  bindPoint: BindPoint | undefined;
  /** Seconds played, in total and at this level, once asked for. */
  playedTime: { total: number; atLevel: number } | undefined;
  /** Set while a bank window is open, which needs the banker's guid to move anything. */
  bankerGuid: bigint | undefined;
  #pendingBankerGuid: bigint | undefined;
  /** What the bank last said: a slot bought, or why one was refused. */
  bankMessage: { text: string; error: boolean } | undefined;
  /** Title mask bits the character has earned. */
  readonly titles = new Set<number>();
  readonly unhandledOpcodes = new UnhandledOpcodeLog();
  /** Packets that landed while the login handshake owned the socket, waiting for the world loop. */
  readonly #deferred: WorldPacket[] = [];
  onUnhandledOpcodesChanged: (() => void) | undefined;
  /** As the server last reported it; `currentGameTime` runs it forward. */
  gameTime: GameTime | undefined;
  #gameTimeReceived = 0;
  loot: LootWindow | undefined;
  onLootChanged: (() => void) | undefined;
  onLootMoney: ((amount: number, alone: boolean) => void) | undefined;
  corpse: CorpseLocation | undefined;
  deathReleaseLocation: DeathReleaseLocation | undefined;
  resurrectRequest: ResurrectRequest | undefined;
  /** Milliseconds left on the corpse reclaim timer at the moment the server last reported it. */
  corpseReclaimDelay = 0;
  corpseReclaimReportedAt = 0;
  onDeathChanged: (() => void) | undefined;
  vendor: VendorInventory | undefined;
  onVendorChanged: (() => void) | undefined;
  trainer: TrainerList | undefined;
  onTrainerChanged: (() => void) | undefined;
  /** Last vendor or trainer message, shown next to the open window. */
  merchantMessage: { text: string; error: boolean } | undefined;
  /** Last result of an inventory action, shown next to the bags. */
  itemMessage: { text: string; error: boolean } | undefined;
  onItemMessage: (() => void) | undefined;
  /**
   * Every text emote and its sentences, once the browser has fetched the table.
   *
   * Held rather than looked up through a callback because the line an emote produces is a chat
   * line like any other and belongs in the backlog with the rest; the alternative was for the
   * renderer to invent one after the fact, which loses it on the next redraw.
   */
  emotes: EmoteData | undefined;
  /**
   * The logged in character's own name.
   *
   * Needed because a text emote names its target by name and not by GUID, so «кто-то машет рукой
   * вам» can only be told from «кто-то машет рукой кому-то» by comparing strings.
   */
  selfName: string | undefined;
  /** Chat backlog, oldest first, capped so a long session cannot grow without bound. */
  readonly chatLog: ChatMessage[] = [];
  onChatMessage: ((message: ChatMessage) => void) | undefined;
  readonly names = new NameCache();
  onNamesChanged: (() => void) | undefined;
  group: GroupState | undefined;
  /**
   * `SMSG_REAL_GROUP_UPDATE`: who is in the group as the server counts it, which is not always
   * what the last group list said — a battleground raid reports through this and nothing else.
   * It was parsed and the result dropped on the floor.
   */
  realGroup: RealGroupUpdate | undefined;
  groupInvite: GroupInvite | undefined;
  groupMessage: { text: string; error: boolean } | undefined;
  onGroupChanged: (() => void) | undefined;
  /**
   * What the server has said about each party or raid member, folded together. Each packet moves
   * only the fields whose mask bits it sets, so a member's entry is built up rather than replaced —
   * and this is the only place health is known for a member standing outside the player's own grid.
   */
  readonly partyStats = new Map<bigint, PartyMemberStats>();
  /** Set while a ready check is running: who asked, when, and who has answered what. */
  readyCheck: { initiatorGuid: bigint; startedAt: number; answers: Map<bigint, boolean> } | undefined;
  /** Raid marker to the unit wearing it. Icons run 0 to 7. */
  readonly raidTargets = new Map<number, bigint>();
  /** Open need-or-greed rolls, by the loot slot they belong to. */
  /**
   * Rolls in flight, keyed by loot slot.
   *
   * `startedAt` is the client's own clock: the packet says how long the window stays open and
   * never says when it closes, and no packet is sent when it does. Without a local start time a
   * roll that nobody answered would sit on screen for the rest of the session.
   */
  readonly lootRolls = new Map<number, {
    start: LootRollStart; startedAt: number; votes: LootRollVote[]; won?: LootRollWon; passed?: boolean;
  }>();
  /** Who the master looter may hand the current corpse's loot to. */
  masterLootCandidates: bigint[] = [];
  /** Who owns the corpse the group is standing over. */
  lootOwners: LootOwners | undefined;
  guildBank: GuildBankContent | undefined;
  guildBankLog: GuildBankLog | undefined;
  guildEventLog: GuildEventLogEntry[] | undefined;
  guildPermissions: GuildPermissions | undefined;
  /** Copper the player may still withdraw today; -1 means unlimited. */
  guildBankWithdrawRemaining: number | undefined;
  readonly guildBankTabText = new Map<number, string>();
  /** The guild bank chest or banker the player is standing at; every bank opcode needs it. */
  guildBankerGuid = 0n;
  /** The tabard designer that answered, which is what opens the emblem window. */
  tabardVendorGuid = 0n;
  tabardMessage: { text: string; error: boolean } | undefined;
  #pendingTabardVendorGuid = 0n;
  #pendingTabardSaveGuid = 0n;
  calendar: CalendarSnapshot | undefined;
  calendarEvent: CalendarEventDetail | undefined;
  calendarPending = 0;
  /** Raid saves as the calendar reports them, by map and difficulty. */
  readonly calendarLockouts = new Map<string, RaidLockoutChange>();
  calendarMessage: { text: string; error: boolean } | undefined;
  /** Channels the player is in, by the name the server localised for this session. */
  readonly channels = new Map<string, { flags: number; count: number; members: ChannelMember[] }>();
  contacts: ContactList | undefined;
  whoResult: WhoResult | undefined;
  whois: string | undefined;
  petition: PetitionInfo | undefined;
  petitionSignatures: PetitionSignatures | undefined;
  petitionVendor: PetitionVendor | undefined;
  petitionMessage: { text: string; error: boolean } | undefined;
  lfgPlayerInfo: LfgPlayerInfo | undefined;
  lfgPartyInfo: LfgPlayerLocks[] | undefined;
  lfgRoleCheck: LfgRoleCheck | undefined;
  lfgBoot: LfgBootProposal | undefined;
  lfgReward: LfgPlayerReward | undefined;
  /** Set when the dungeon finder is switched off on this realm. */
  lfgDisabled = false;
  nextMailTime: NextMailTime | undefined;
  /**
   * The pet's bar, book and timers as the server last sent them. Undefined means no pet: the
   * server takes the bar down by sending this packet with a zero guid rather than by saying so.
   */
  petSpells: PetSpells | undefined;
  /**
   * When each pet spell comes off cooldown, in `performance.now()` terms. Kept apart from the
   * player's own map because both arrive on the same three opcodes, told apart only by the guid.
   */
  readonly petCooldowns = new Map<number, number>();
  /** Names answered by pet number, which is the only correlator those packets carry. */
  readonly petNames = new Map<number, PetName>();
  /** Combo points the pet is holding, for a rogue-like charm. */
  petComboPoints: { guid: bigint; targetGuid: bigint; points: number } | undefined;
  petMessage: { text: string; error: boolean } | undefined;
  stable: StableList | undefined;
  stableMessage: { text: string; error: boolean } | undefined;
  /** The stable master being talked to; every stable opcode needs it. */
  stableMasterGuid = 0n;
  #pendingStableMasterGuid = 0n;
  /** Units the server has told us are vehicles, and which `Vehicle.dbc` row they use. */
  readonly vehicleKits = new Map<bigint, number>();
  /**
   * The two battleground queue slots, by the slot number the server names. A slot the server has
   * cleared is deleted rather than kept as an empty status: "not queued" and "queued for nothing"
   * are the same thing here, and the packet that clears a slot carries no battleground to remember.
   */
  readonly battlefieldQueues = new Map<number, BattlefieldStatus>();
  /** The last battlemaster list, which is what a queue window is built from. */
  battlefieldList: BattlefieldList | undefined;
  #pendingBattlemasterGuid = 0n;
  /** The scoreboard, whether asked for mid-match or sent unasked when the match ended. */
  pvpScores: PvpLogData | undefined;
  /** Who is in the battleground the player is standing in, as joins and leaves report it. */
  readonly battlegroundPlayers = new Set<bigint>();
  /** Where the flags are. Only ever as fresh as the last request: nothing pushes this. */
  flagCarriers: FlagCarrier[] = [];
  /** The last kill that paid honor, for the floating credit line. */
  lastHonorKill: PvpCredit | undefined;
  /** Honor earned this session, which the wire never states: it only ever sends deltas. */
  honorThisSession = 0;
  pvpMessage: { text: string; error: boolean } | undefined;
  /**
   * The numbered variables the current zone publishes, and where they belong. Replaced wholesale on
   * a zone change and patched one at a time after that — which is why the context is kept beside
   * them: an update carries no zone, so a state left over from the previous zone would be read as
   * belonging to this one.
   */
  readonly worldStates = new Map<number, number>();
  worldStateContext: { mapId: number; zoneId: number; areaId: number } | undefined;
  /** The server's own clock in unix seconds, as last answered, and when that answer arrived. */
  worldStateTime: number | undefined;
  #worldStateTimeReceived = 0;
  /** Arena teams by id: the tabard, the record and the roster arrive on three separate opcodes. */
  readonly arenaTeams = new Map<number, ArenaTeamInfo>();
  readonly arenaTeamStats = new Map<number, ArenaTeamStats>();
  readonly arenaTeamRosters = new Map<number, ArenaTeamRoster>();
  /** An invitation waiting on an answer. It names no team id: the server remembers which team. */
  arenaTeamInvite: ArenaTeamInvite | undefined;
  /** What somebody's inspection came back with, by their guid. */
  readonly inspectedArenaTeams = new Map<bigint, InspectedArenaTeam[]>();
  readonly inspectedHonor = new Map<bigint, HonorStats>();
  /** Wintergrasp: an offer to queue, an offer to fight, and whether the player is in the battle. */
  battlefieldQueueInvite: BattlefieldQueueInvite | undefined;
  battlefieldWarInvite: BattlefieldWarInvite | undefined;
  battlefieldBattleId = 0;
  /** When each of the eight saved blobs last changed, as the server last reported. */
  accountDataTimes: AccountDataTimes | undefined;
  /**
   * The account blobs themselves, already inflated, by type. This is where the original client's
   * macros, key bindings and interface configuration live — the server stores them per account or
   * per character and hands them back on request.
   */
  readonly accountData = new Map<number, { time: number; text: string }>();
  /** Eight words, 256 tutorial bits. Empty until the server sends them at login. */
  tutorialFlags: number[] = [];
  featureStatus: FeatureSystemStatus | undefined;
  /**
   * The realm's cache generation. The original client throws its `WDB` files away when this moves;
   * this client has no files, so it drops the query caches below instead.
   */
  clientCacheVersion = 0;
  realmSplit: RealmSplit | undefined;
  /** The server's clock and daily reset, as `SMSG_QUERY_TIME_RESPONSE` last reported them. */
  serverTime: ServerTime | undefined;
  #serverTimeReceived = 0;
  /** The message of the day, one string per line. */
  motd: string[] = [];
  /** The last line the server flashed across the middle of the screen. */
  notification: string | undefined;
  /** Set once a logout has been granted and until it completes or is cancelled. */
  logout: LogoutResponse | undefined;
  /** True once `SMSG_LOGOUT_COMPLETE` has arrived: the session is over. */
  loggedOut = false;
  /** What the server made of the addons this client declared at authentication. */
  addonInfo: AddonInfo | undefined;
  /** How many addons were declared, which is the only thing that makes `SMSG_ADDON_INFO` readable. */
  #declaredAddons = 0;
  /** Warden packets seen. This realm has Warden off, so this should stay at zero. */
  wardenPackets = 0;
  /** The query cache, which is this client's replacement for the original's `WDB` files. */
  readonly creatureTemplates = new Map<number, CreatureTemplate>();
  readonly itemTemplates = new Map<number, ItemTemplate>();
  readonly itemSetNames = new Map<number, ItemSetName>();
  readonly pageTexts = new Map<number, PageText>();
  readonly itemTexts = new Map<bigint, string>();
  #creaturesAsked = new Set<number>();
  #itemsAsked = new Set<number>();
  #itemSetsAsked = new Set<number>();
  #pagesAsked = new Set<number>();
  /** The player's own open ticket, and a game master's answer to it. */
  gmTicket: GmTicket | undefined;
  gmResponse: GmResponse | undefined;
  /** Whether the realm is taking tickets at all. */
  ticketsEnabled = true;
  /** Whether the server asked for a survey when the ticket closed. */
  ticketSurveyPending = false;
  ticketMessage: { text: string; error: boolean } | undefined;
  /** Set while the player is sitting in a barber's chair. */
  barberShopOpen = false;
  /** The last rename, customise or faction change the server answered. */
  characterService: CharacterServiceResult | undefined;
  serviceMessage: { text: string; error: boolean } | undefined;
  /** The last sound the server asked for. Playing it is a later slice; reading it is this one. */
  lastSound: SoundRequest | undefined;
  /** A page the server asked to be opened, and the object that asked for it. */
  openPageObject: bigint | undefined;
  /** Set while a trade window is open; the two offers arrive as separate packets. */
  tradeOpen = false;
  tradePartnerGuid = 0n;
  tradePartnerAccepted = false;
  myOffer: TradeOffer | undefined;
  theirOffer: TradeOffer | undefined;
  tradeMessage: string | undefined;
  onTradeChanged: (() => void) | undefined;
  duelRequest: DuelRequest | undefined;
  duelCountdown = 0;
  onDuelChanged: (() => void) | undefined;
  /** The mailbox the player is standing at; every mail opcode needs it. */
  mailboxGuid = 0n;
  mail: MailList | undefined;
  mailMessage: { text: string; error: boolean } | undefined;
  mailResult: MailCommandResult | undefined;
  onMailChanged: (() => void) | undefined;
  guildRoster: GuildRoster | undefined;
  guildQuery: GuildQueryInfo | undefined;
  guildInfo: GuildInfo | undefined;
  guildInvite: GuildInviteMessage | undefined;
  guildMessage: { text: string; error: boolean } | undefined;
  onGuildChanged: (() => void) | undefined;
  /** The auctioneer the player is standing at; every auction opcode needs it. */
  auctioneerGuid = 0n;
  #pendingAuctioneerGuid = 0n;
  auctions: AuctionList | undefined;
  ownAuctions: AuctionList | undefined;
  auctionMessage: { text: string; error: boolean } | undefined;
  onAuctionChanged: (() => void) | undefined;
  lfgStatus: LfgUpdate | undefined;
  lfgQueue: LfgQueueStatus | undefined;
  lfgProposal: LfgProposal | undefined;
  lfgMessage: string | undefined;
  onLfgChanged: (() => void) | undefined;
  #useCount = 0;
  #castCount = 0;
  /** Requests waiting for the server's outcome. A request is not a cooldown. */
  readonly #pendingCasts: PendingSpellCast[] = [];
  /** GO can confirm a locally timed cast before the separate cooldown-event packet arrives. */
  readonly #locallyStartedCooldowns = new Map<number, number>();
  /** Lets the legacy onCooldownEvent callback mark its timer as server-authoritative. */
  #handlingServerCooldownEvent = false;
  #pingSequence = 0;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #pendingGossipGuid = 0n;
  /** A selected gossip option may answer with any NPC service instead of another gossip page. */
  #pendingGossipServiceGuid = 0n;
  #pendingQuestGiverGuid = 0n;
  #pendingVendorGuid = 0n;
  #pendingTrainerGuid: bigint | undefined;
  /**
   * The tswow custom-packet transport: fragments of opcode 0x102 in, whole module messages out.
   *
   * Public because the diagnostics window reads `warnings` from it — a multi-fragment message is
   * read differently by tswow's own client, and a module author has no other way to find that out.
   * Named after `CustomPacketBuffer`, the C++ class it mirrors, so that `customPackets` can be the
   * one thing a module actually talks to.
   */
  readonly customPacketBuffer = new CustomPacketReassembler();
  /**
   * Who owns which custom opcode, what the last message on it decoded to, and what nobody claimed.
   *
   * The handler map used to live here as a bare `Map<number, Set<handler>>`. It moved into the
   * registry rather than being duplicated beside it: the registry has to see *every* assembled
   * message to count it and to keep the bytes of an opcode nothing claims, and a second dispatch
   * path here would have meant a message reaching a window without ever being counted.
   */
  readonly customPackets = new CustomPacketRegistry({
    send: (opcode, body) => { this.sendCustomPacket(opcode, body); },
    // Custom traffic rides `CMSG_EMOTE`'s number, and that is the opcode the diagnostics line
    // names — a module author matching this against the unhandled-opcode list needs the two to
    // agree. The inner opcode is already in the text.
    onProblem: (problem) => { this.onPacketError?.(OPCODES.CMSG_EMOTE, new Error(problem.text)); },
  });
  /** False until the login backlog has been drained; see the 0x102 branch in `#dispatch`. */
  #worldEntered = false;

  /** The exact auth-list name selected for this connection. */
  readonly realmName: string | undefined;

  private constructor(connection: WorldConnection, realmName?: string) {
    this.#connection = connection;
    this.realmName = realmName;
  }

  static async connect(stream: BinaryByteStream, login: WorldLogin): Promise<WorldClient> {
    const connection = new WorldConnection(stream);
    const challengePacket = await connection.read();
    if (challengePacket.opcode !== OPCODES.SMSG_AUTH_CHALLENGE) throw new Error("Worldserver did not send SMSG_AUTH_CHALLENGE");

    const challenge = new PacketReader(challengePacket.payload);
    challenge.u32();
    const serverSeed = challenge.bytes(4);
    challenge.bytes(32);
    challenge.assertFinished();

    const localChallenge = globalThis.crypto.getRandomValues(new Uint8Array(4));
    const digest = await sha1Bytes(
      encoder.encode(login.username),
      new Uint8Array(4),
      localChallenge,
      serverSeed,
      login.sessionKey,
    );
    // The tail of this packet is the addon block: a length and a deflate stream, not the literal
    // zero that used to stand there. Zero is legal — it means "no addon info at all" and the
    // server returns early — but it is not the same as declaring an empty list, and only the
    // second form gets an answer whose shape the client can predict.
    const addons = login.addons ?? [];
    const addonBlock = await buildAddonBlock(addons);
    const authPayload = new PacketWriter()
      .u32(12340)
      .u32(0)
      .cString(login.username)
      .u32(0)
      .bytes(localChallenge)
      .u32(0)
      .u32(0)
      .u32(login.realmId)
      .u64(0n)
      .bytes(digest)
      .bytes(addonBlock)
      .toUint8Array();

    connection.send(OPCODES.CMSG_AUTH_SESSION, authPayload);
    await connection.enableEncryption(login.sessionKey);
    const client = new WorldClient(connection, login.realmName);
    // `SMSG_ADDON_INFO` carries no count of its own: the server writes exactly as many entries as
    // were declared above, and this is the only record of how many that was. Clamped because the
    // server clamps: `ReadAddonsInfo` truncates the declared list to `MaxSecureAddons` and answers
    // for that many, so a longer declaration would leave this reader expecting entries that the
    // server never wrote.
    client.#declaredAddons = Math.min(addons.length, MAX_SECURE_ADDONS);

    while (true) {
      const response = await client.#waitFor(OPCODES.SMSG_AUTH_RESPONSE);
      const code = response.payload[0];
      if (code === AUTH_OK) break;
      if (code !== AUTH_WAIT_QUEUE) throw new Error(`World authentication failed with code ${code ?? "missing"}`);
    }
    client.#startPing();
    return client;
  }

  async characters(): Promise<CharacterSummary[]> {
    this.#connection.send(OPCODES.CMSG_CHAR_ENUM);
    return parseCharacterList((await this.#waitFor(OPCODES.SMSG_CHAR_ENUM)).payload);
  }

  async createCharacter(request: CreateCharacterRequest): Promise<number> {
    this.#connection.send(OPCODES.CMSG_CHAR_CREATE, buildCreateCharacter(request));
    return parseCharacterResult((await this.#waitFor(OPCODES.SMSG_CHAR_CREATE)).payload);
  }

  async deleteCharacter(guid: bigint): Promise<number> {
    this.#connection.send(OPCODES.CMSG_CHAR_DELETE, buildCharacterGuid(guid));
    return parseCharacterResult((await this.#waitFor(OPCODES.SMSG_CHAR_DELETE)).payload);
  }

  async loginCharacter(guid: bigint): Promise<LoginLocation> {
    this.#connection.send(OPCODES.CMSG_PLAYER_LOGIN, buildCharacterGuid(guid));
    const location = parseLoginVerifyWorld((await this.#waitFor(OPCODES.SMSG_LOGIN_VERIFY_WORLD)).payload);
    this.mapId = location.map;
    void this.#readWorld().catch((error: unknown) => {
      if (!this.#closed) this.onWorldError?.(error instanceof Error ? error : new Error(String(error)));
    });
    return location;
  }

  /**
   * The mover's state as the server expects to see it echoed in an acknowledgement.
   *
   * Every ack carries the full MovementInfo, and the server compares what comes back against
   * what it sent. Sending the player's current position and flags is what the real client does.
   */
  #currentMovement(): MovementInfo {
    const self = this.state.selfGuid === undefined ? undefined : this.state.objects.get(this.state.selfGuid);
    const position = self?.position ?? { x: 0, y: 0, z: 0, orientation: 0 };
    return {
      flags: self?.movementFlags ?? 0,
      flags2: 0,
      time: Math.trunc(performance.now()) >>> 0,
      position,
      ...this.#movementExtra,
    };
  }

  /**
   * The changes the server pushes and waits to have acknowledged.
   *
   * Until the ack arrives the server discards the player's movement entirely, so a portal, a
   * hearthstone or a spirit-healer revive used to leave the character frozen until relog; and a
   * speed change is only applied when its ack comes back, so mounts and sprints did nothing.
   */
  async #handleMovementControl(packet: WorldPacket): Promise<boolean> {
    if (packet.opcode === OPCODES.SMSG_TRANSFER_PENDING) {
      // Only a heads-up that a map change is coming; SMSG_NEW_WORLD carries the destination.
      this.onCombatStatus?.(`переход на карту ${parseTransferPending(packet.payload)}`, this.attacking, false);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_NEW_WORLD) {
      const world = parseNewWorld(packet.payload);
      // A template answer from the old map cannot authorize an interaction in the new one.
      this.#settleAllGameObjectTemplateWaiters();
      this.mapId = world.mapId;
      // Zone weather and scripted light are scoped to the map. A server that does not send an
      // explicit clear packet on transfer must not leave the previous zone's Dalaran/raid sky in
      // the new map while its first world packets are arriving.
      this.weather = undefined;
      this.overrideLight = undefined;
      this.overrideLightFromId = undefined;
      this.overrideLightReceivedAt = 0;
      const position = { x: world.x, y: world.y, z: world.z, orientation: world.orientation };
      if (this.state.selfGuid !== undefined) this.state.move(this.state.selfGuid, { flags: 0, position });
      // Nothing the player does counts until this is sent.
      this.#connection.send(OPCODES.MSG_MOVE_WORLDPORT_ACK, buildWorldportAck());
      this.onWorldChanged?.(world.mapId, position);
      this.onStateChange?.(this.state);
      return true;
    }

    if (packet.opcode === OPCODES.MSG_MOVE_TELEPORT_ACK) {
      const request = parseTeleportRequest(packet.payload);
      if (this.state.selfGuid !== undefined && request.guid === this.state.selfGuid) {
        this.state.move(request.guid, { flags: request.movement.flags, position: request.movement.position });
        // Same-map teleports use this path rather than SMSG_NEW_WORLD. They still invalidate every
        // streamed terrain/VMAP answer around the old point, so the browser must open the same
        // destination loading barrier before running local gravity again.
        if (this.mapId !== undefined) this.onWorldChanged?.(this.mapId, request.movement.position);
      }
      this.#connection.send(OPCODES.MSG_MOVE_TELEPORT_ACK,
        buildTeleportAck(request.guid, request.counter, Math.trunc(performance.now()) >>> 0));
      this.onStateChange?.(this.state);
      return true;
    }

    // Everybody else's movement state. No acknowledgement exists for any of these — they are the
    // server-controlled twin of the FORCE family below, and they never name the player's own
    // mover, so applying them on receipt is the whole of the handling.
    if (isSplineMoveState(packet.opcode)) {
      const state = parseSplineMoveState(packet.opcode, packet.payload);
      this.state.applyMovementFlag(state.guid, state.flag, state.set);
      return true;
    }

    if (isSplineSpeed(packet.opcode)) {
      const speed = parseSplineSpeed(packet.opcode, packet.payload);
      this.state.setSpeed(speed.guid, speed.name, speed.value);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_FLIGHT_SPLINE_SYNC) {
      const sync = parseFlightSplineSync(packet.payload);
      this.state.resyncSpline(sync.guid, sync.progress, performance.now());
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_MOVE_KNOCK_BACK) {
      const knockBack = parseKnockBack(packet.payload);
      // Nothing moves until this goes back: `HandleMoveKnockBackAck` is what commits the position,
      // so a client that stays silent is one the server never launched.
      this.#connection.send(OPCODES.CMSG_MOVE_KNOCK_BACK_ACK, buildKnockBackAck(knockBack, this.#currentMovement()));
      this.onKnockBack?.(knockBack);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_MULTIPLE_MOVES) {
      // The state a character logs in already holding: rooted, feather-falling, walking on water,
      // hovering. Each block is one of those packets in its own right and wants its own reply.
      for (const move of parseMultipleMoves(packet.payload)) {
        const toggle = movementToggleFor(move.opcode);
        if (!toggle) continue;
        this.#connection.send(toggle.ackOpcode, buildMovementToggleAck(
          { guid: move.guid, counter: move.counter, name: toggle.name, value: undefined, ackOpcode: toggle.ackOpcode },
          this.#currentMovement()));
        if (move.guid === this.state.selfGuid) this.#applyMovementToggle(toggle.name, undefined);
      }
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_CLIENT_CONTROL_UPDATE) {
      const control = parseClientControlUpdate(packet.payload);
      // Who the client may move. The server drops every movement packet from a client that has
      // not named its mover, and says nothing about it — so this reply is what keeps the character
      // moving at all. It spells the guid the other way round, full rather than packed.
      this.#connection.send(
        control.allowed ? OPCODES.CMSG_SET_ACTIVE_MOVER : OPCODES.CMSG_MOVE_NOT_ACTIVE_MOVER,
        buildCharacterGuid(control.guid));
      this.movementReady = control.allowed;
      this.controlledGuid = control.allowed ? control.guid : undefined;
      // From here on the server decides who moves what. Without this the claim made at login
      // would be re-made on the very next packet and take back control the server just revoked.
      this.#controlAnnounced = true;
      this.onMovementStatus?.(control.allowed, this.movementPacketsSent);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_TRANSFER_ABORTED) {
      const aborted = parseTransferAborted(packet.payload);
      this.onCombatStatus?.(`${aborted.text} (карта ${aborted.mapId})`, this.attacking, true);
      return true;
    }

    if (isForcedSpeed(packet.opcode)) {
      const speed = parseForcedSpeed(packet.opcode, packet.payload);
      this.#connection.send(ackOpcodeForSpeed(speed.name), buildForcedSpeedAck(speed, this.#currentMovement()));
      if (speed.guid === this.state.selfGuid) {
        this.speeds.set(speed.name, speed.speed);
        // The state object too, and not only the physics map above: every OTHER rider's speed
        // reaches `state.setSpeed` through the MSG_MOVE_SET_* relay, so the renderer's mount gait
        // (A2's `unitTravelSpeed`) could pace a stranger's horse and not the owner's — the one
        // mount that is on screen in every session. Same store, same drop-on-default semantics.
        this.state.setSpeed(speed.guid, speed.name, speed.speed);
      }
      return true;
    }

    if (isMovementToggle(packet.opcode)) {
      const toggle = parseMovementToggle(packet.opcode, packet.payload);
      this.#connection.send(toggle.ackOpcode, buildMovementToggleAck(toggle, this.#currentMovement()));
      // Acknowledged and then remembered. Acknowledging alone is what the client used to do, and
      // it is why a levitate, a water-walking buff and a root were all agreed to and then walked
      // straight through.
      if (toggle.guid === this.state.selfGuid) this.#applyMovementToggle(toggle.name, toggle.value);
      return true;
    }

    return false;
  }

  /**
   * One movement packet.
   *
   * `extra` is the rest of the MovementInfo — the fall clock, the jump block, the pitch — and it is
   * not optional decoration: the server reads the fall time back to decide where a fall began, and
   * a packet whose flags say falling but whose block says nothing is a fall that costs no damage.
   * It is also remembered, because every acknowledgement the server asks for has to echo the same
   * state, and an ack that says the character is standing still ends the jump it was sent during.
   */
  /** One toggle, by the name `MOVEMENT_TOGGLES` gives it. Each pair is a state and its undoing. */
  #applyMovementToggle(name: string, value: number | undefined): void {
    const state = this.movementState;
    if (name === "root") state.rooted = true;
    else if (name === "unroot") state.rooted = false;
    else if (name === "waterWalk") state.waterWalking = true;
    else if (name === "landWalk") state.waterWalking = false;
    else if (name === "featherFall") state.featherFall = true;
    else if (name === "normalFall") state.featherFall = false;
    else if (name === "hover") state.hovering = true;
    else if (name === "unsetHover") state.hovering = false;
    else if (name === "canFly") state.canFly = true;
    else if (name === "cannotFly") state.canFly = false;
    else if (name === "gravityOff") state.gravityDisabled = true;
    else if (name === "gravityOn") state.gravityDisabled = false;
    else if (name === "collisionHeight") state.collisionHeight = value ?? 0;
  }

  sendMovement(opcode: number, flags: number, position: WorldPosition, extra: MovementExtra = {}): void {
    if (this.#closed || !this.movementReady || this.state.selfGuid === undefined) return;
    const movement = { flags, position };
    this.#movementExtra = extra;
    this.#connection.send(
      opcode,
      buildMovementPacket(this.state.selfGuid, flags, position, Math.trunc(performance.now()) >>> 0, extra),
    );
    this.state.move(this.state.selfGuid, movement);
    this.movementPacketsSent++;
    this.onMovementStatus?.(true, this.movementPacketsSent);
    this.onStateChange?.(this.state);
  }

  selectTarget(guid: bigint | undefined): void {
    if (this.#closed || (guid !== undefined && !this.state.objects.has(guid))) return;
    // CMSG_SET_SELECTION names units only. Game objects are interacted with by their own guid in
    // their own opcode and must never occupy the unit target frame or leak onto this wire path.
    if (guid !== undefined && this.state.objects.get(guid)?.typeId === 5) return;
    if (this.attacking) this.stopAttack();
    if (this.autoRepeatSpellId !== undefined) this.#stopAutoRepeat(true);
    this.targetGuid = guid;
    this.#connection.send(OPCODES.CMSG_SET_SELECTION, buildCombatGuid(guid ?? 0n));
    this.onCombatStatus?.(guid === undefined ? "Цель сброшена" : "Цель выбрана", false, false);
  }

  /**
   * Turns to face the current target.
   *
   * A swing only lands inside a 120-degree arc, and the server says so exactly once and then goes
   * quiet however long the player stands the wrong way round. Nothing here ever turned the
   * character towards anything, so clicking something behind you meant attacking forever, seeing
   * one line of Russian, and never landing a blow.
   */
  faceTarget(): void {
    const self = this.state.selfGuid === undefined ? undefined : this.state.objects.get(this.state.selfGuid);
    const target = this.targetGuid === undefined ? undefined : this.state.objects.get(this.targetGuid);
    if (!self?.position || !target?.position) return;
    const orientation = Math.atan2(target.position.y - self.position.y, target.position.x - self.position.x);
    this.sendMovement(OPCODES.MSG_MOVE_SET_FACING, self.movementFlags, { ...self.position, orientation });
  }

  startAttack(): void {
    if (this.#closed || this.targetGuid === undefined || this.attacking) return;
    const target = this.state.objects.get(this.targetGuid);
    if (!target || isWorldObjectDead(target)) {
      this.onCombatStatus?.("Для автоатаки нужна живая видимая цель", false, true);
      return;
    }
    // The realm keeps melee and CURRENT_AUTOREPEAT_SPELL independently. The UI exposes them as
    // alternative combat modes, so switching must cancel the old wire state before drawing steel.
    if (this.autoRepeatSpellId !== undefined) this.#stopAutoRepeat(true);
    this.faceTarget();
    // Draw the weapon first. The server publishes the sheath state in UNIT_FIELD_BYTES_2 and the
    // renderer hangs a weapon off a hand only while it is out, so a character who never says it
    // has drawn anything fights bare-handed however much steel is equipped.
    this.#connection.send(OPCODES.CMSG_SET_SHEATHED, buildSetSheathed(SHEATH_MELEE));
    this.#connection.send(OPCODES.CMSG_ATTACK_SWING, buildCombatGuid(this.targetGuid));
    this.attacking = true;
    this.onCombatStatus?.("Запрос автоатаки отправлен", true, false);
  }

  stopAttack(): void {
    this.#cancelMeleeAttack(true);
  }

  #cancelMeleeAttack(announce: boolean): void {
    if (this.#closed || !this.attacking) return;
    this.#connection.send(OPCODES.CMSG_ATTACK_STOP);
    this.#connection.send(OPCODES.CMSG_SET_SHEATHED, buildSetSheathed(SHEATH_UNARMED));
    this.attacking = false;
    this.swingWarning = undefined;
    if (announce) this.onCombatStatus?.("Автоатака остановлена", false, false);
  }

  /** Replaces the DBC-derived mount classification used by every direct cast entry point. */
  setMountSpellIds(spellIds: Iterable<number>): void {
    this.#mountSpellIds.clear();
    for (const spellId of spellIds) {
      if (Number.isSafeInteger(spellId) && spellId > 0) this.#mountSpellIds.add(spellId);
    }
  }

  /** Replaces the DBC-derived ranged repeat classification used by spellbook and action bar. */
  setAutoRepeatSpellIds(spellIds: Iterable<number>): void {
    this.#autoRepeatSpellIds.clear();
    for (const spellId of spellIds) {
      if (Number.isSafeInteger(spellId) && spellId > 0) this.#autoRepeatSpellIds.add(spellId);
    }
  }

  #startAutoRepeat(spellId: number, cooldownDuration: number, cooldownStartedOnEvent: boolean): void {
    const targetGuid = this.targetGuid;
    const target = targetGuid === undefined ? undefined : this.state.objects.get(targetGuid);
    if (targetGuid === undefined || !target || isWorldObjectDead(target)) {
      this.onSpellStatus?.("Для стрельбы нужна живая видимая цель", true);
      return;
    }
    if (this.attacking) this.stopAttack();
    if (this.autoRepeatSpellId !== undefined) this.#stopAutoRepeat(true);
    this.faceTarget();
    this.#connection.send(OPCODES.CMSG_SET_SHEATHED, buildSetSheathed(SHEATH_RANGED));
    this.#castCount = (this.#castCount + 1) & 0xff;
    this.#connection.send(
      OPCODES.CMSG_CAST_SPELL,
      buildAutoRepeatCastSpell(spellId, this.#castCount, targetGuid),
    );
    this.#trackPendingCast(spellId, this.#castCount, cooldownDuration, cooldownStartedOnEvent);
    this.autoRepeatSpellId = spellId;
    this.#autoRepeatFailure = undefined;
    this.onSpellStatus?.(`Автострельба ${spellId} запущена`, false);
  }

  #stopAutoRepeat(sendCancel: boolean, restoreSheath = sendCancel): void {
    if (this.autoRepeatSpellId === undefined) return;
    if (!this.#closed) {
      if (sendCancel) this.#connection.send(OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL);
      if (restoreSheath) {
        this.#connection.send(
          OPCODES.CMSG_SET_SHEATHED,
          buildSetSheathed(this.attacking ? SHEATH_MELEE : SHEATH_UNARMED),
        );
      }
    }
    this.autoRepeatSpellId = undefined;
    this.#autoRepeatFailure = undefined;
  }

  /** Whether a classified mount spell currently has its own aura on the player. */
  isActiveMountSpell(spellId: number): boolean {
    const selfGuid = this.state.selfGuid;
    return selfGuid !== undefined
      && isMounted(this.state.objects.get(selfGuid))
      && this.#mountSpellIds.has(spellId)
      && hasAuraSpell(this.auras.get(selfGuid), spellId);
  }

  #cancelMountBeforeCast(spellId?: number): boolean {
    const selfGuid = this.state.selfGuid;
    if (selfGuid === undefined || !isMounted(this.state.objects.get(selfGuid))) return false;
    const activeMount = spellId !== undefined && this.#mountSpellIds.has(spellId)
      && hasAuraSpell(this.auras.get(selfGuid), spellId);
    // `CMSG_CANCEL_MOUNT_AURA` has an empty body. Keep it immediately before the cast so the
    // server processes the dismount first, while fields and auras remain server-authoritative.
    this.#connection.send(OPCODES.CMSG_CANCEL_MOUNT_AURA);
    return activeMount;
  }

  castSpell(spellId: number, cooldownDuration = 0, cooldownStartedOnEvent = false): void {
    if (this.#closed || this.state.selfGuid === undefined) return;
    // 6603 is a client action, not a spell the realm has to teach through INITIAL_SPELLS. Keep it
    // ahead of the known-spell gate so a valid action-bar Attack can never fall into CAST_SPELL.
    if (spellId === MELEE_AUTO_ATTACK_SPELL_ID) {
      this.#cancelMountBeforeCast();
      if (this.attacking) this.stopAttack();
      else this.startAttack();
      return;
    }
    if (!this.knownSpells.some((spell) => spell.id === spellId)) {
      this.onSpellStatus?.(`Заклинание ${spellId} отсутствует в книге`, true);
      return;
    }

    if (this.#cancelMountBeforeCast(spellId)) return;

    if (this.#autoRepeatSpellIds.has(spellId)) {
      if (this.autoRepeatSpellId === spellId) this.#stopAutoRepeat(true);
      else this.#startAutoRepeat(spellId, cooldownDuration, cooldownStartedOnEvent);
      return;
    }

    this.#castCount = (this.#castCount + 1) & 0xff;
    // No unit in the target block: the server resolves the cast against the selection this client
    // keeps it in step with through `CMSG_SET_SELECTION`, and falls back to the caster when the
    // selection is not a legal target for the spell. See `buildCastSpell`, which names what that
    // costs. The point *is* sent, and it is the selection's own — the server derives a ground
    // spell's landing point from the incoming block and would otherwise put every area spell at
    // the caster's feet. It is where this client last saw the target stand, which is what the
    // original client sends too: the position it has, not the server's.
    const selected = this.targetGuid === undefined ? undefined : this.state.objects.get(this.targetGuid);
    const destination = selected?.position ?? this.state.objects.get(this.state.selfGuid)?.position;
    this.#connection.send(OPCODES.CMSG_CAST_SPELL, buildCastSpell(spellId, this.#castCount, destination));
    this.#trackPendingCast(spellId, this.#castCount, cooldownDuration, cooldownStartedOnEvent);
    // Where the cast is *likely* to land: with no unit named the answer is the server's, and it
    // arrives in `SMSG_SPELL_GO`. The selection is still what it will try first.
    this.onSpellStatus?.(
      `Заклинание ${spellId} отправлено на ${this.targetGuid === undefined ? "себя" : "выбранную цель"}`,
      false,
    );
  }

  /** Crafting item targets are validated again by the realm; never mutate the item locally. */
  castSpellOnItem(spellId: number, itemGuid: bigint, cooldownDuration = 0, cooldownStartedOnEvent = false): void {
    if (this.#closed || this.state.selfGuid === undefined || itemGuid === 0n) return;
    if (!this.knownSpells.some((spell) => spell.id === spellId)) return;
    const inventory = playerInventory(this.state);
    if (!inventory || ![...inventory.equipment, ...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)]
      .some((slot) => slot.guid === itemGuid && slot.item !== undefined)) return;
    this.#cancelMountBeforeCast();
    this.#castCount = (this.#castCount + 1) & 0xff;
    this.#connection.send(OPCODES.CMSG_CAST_SPELL, buildCastSpellOnItem(spellId, this.#castCount, itemGuid));
    this.#trackPendingCast(spellId, this.#castCount, cooldownDuration, cooldownStartedOnEvent);
  }

  cancelSpellCast(): void {
    if (this.#closed || this.state.selfGuid === undefined) return;
    const active = this.casts.get(this.state.selfGuid);
    if (!active) return;
    this.#connection.send(OPCODES.CMSG_CANCEL_CAST,
      new PacketWriter().u8(active.castCount ?? 0).u32(active.spellId).toUint8Array());
  }

  startLocalCooldown(spellId: number, duration: number): void {
    if (duration <= 0) return;
    this.#prunePendingCasts();
    const pending = this.#latestPendingCast(spellId);
    // The book used to call this immediately after sending CMSG_CAST_SPELL. Keep that API, but
    // make it annotate the request instead of arming a timer before the realm accepts the cast.
    if (pending && !this.#handlingServerCooldownEvent) {
      pending.cooldownDuration = duration;
      return;
    }
    if (pending) pending.cooldownAuthoritative = true;
    this.#applyCooldown(spellId, duration, this.#handlingServerCooldownEvent ? "server" : "cast");
  }

  /** A stable cooldown snapshot for a slot that needs its own fraction or label. */
  cooldownState(spellId: number): CooldownSnapshot | undefined {
    const snapshot = this.cooldownSnapshots.get(spellId);
    if (!snapshot || snapshot.endsAt <= performance.now()) return undefined;
    return snapshot;
  }

  #trackPendingCast(
    spellId: number,
    castCount: number,
    cooldownDuration = 0,
    cooldownStartedOnEvent = false,
  ): void {
    this.#prunePendingCasts();
    this.#pendingCasts.push({
      spellId,
      castCount,
      sentAt: performance.now(),
      ...(cooldownDuration > 0 ? { cooldownDuration } : {}),
      ...(cooldownStartedOnEvent ? { cooldownStartedOnEvent: true } : {}),
    });
  }

  #prunePendingCasts(now = performance.now()): void {
    const firstLive = this.#pendingCasts.findIndex((cast) => now - cast.sentAt <= PENDING_CAST_TTL);
    if (firstLive > 0) this.#pendingCasts.splice(0, firstLive);
    else if (firstLive < 0) this.#pendingCasts.length = 0;
  }

  #latestPendingCast(spellId: number): PendingSpellCast | undefined {
    for (let index = this.#pendingCasts.length - 1; index >= 0; index--) {
      const cast = this.#pendingCasts[index];
      if (cast?.spellId === spellId) return cast;
    }
    return undefined;
  }

  #markPendingCooldownAuthoritative(spellId: number): PendingSpellCast | undefined {
    this.#prunePendingCasts();
    let latest: PendingSpellCast | undefined;
    // Cooldown packets carry the spell id but no cast count. If multiple requests for this
    // spell are in flight, the one server timer settles all of their possible GO fallbacks.
    for (const pending of this.#pendingCasts) {
      if (pending.spellId !== spellId) continue;
      pending.cooldownAuthoritative = true;
      latest = pending;
    }
    return latest;
  }

  #takePendingCast(spellId: number, castCount?: number): PendingSpellCast | undefined {
    this.#prunePendingCasts();
    let index = -1;
    for (let cursor = this.#pendingCasts.length - 1; cursor >= 0; cursor--) {
      const cast = this.#pendingCasts[cursor];
      if (cast?.spellId === spellId && (castCount === undefined || cast.castCount === castCount)) {
        index = cursor;
        break;
      }
    }
    return index < 0 ? undefined : this.#pendingCasts.splice(index, 1)[0];
  }

  #emitCastAccepted(pending: PendingSpellCast, source: "start" | "go", startedAt = performance.now()): void {
    // The pending object is the request identity. A spell/count pair is only an 8-bit wire
    // token, so deduplicating by that pair would suppress a legitimate request after wrap.
    if (pending.accepted) return;
    pending.accepted = true;
    this.events.emit("SPELL_CAST_ACCEPTED", {
      spellId: pending.spellId,
      castId: pending.castCount,
      startedAt,
      source,
    });
  }

  #acceptPendingCast(spellId: number, castCount: number, source: "start" | "go"): void {
    this.#prunePendingCasts();
    let pending: PendingSpellCast | undefined;
    for (let index = this.#pendingCasts.length - 1; index >= 0; index--) {
      const candidate = this.#pendingCasts[index];
      if (candidate?.spellId === spellId && candidate.castCount === castCount) {
        pending = candidate;
        break;
      }
    }
    // A spell GO/START from a proc, aura or another server-side effect is not acceptance of a
    // client request and must not start the action-bar GCD. Only a tracked request can emit this.
    if (!pending) return;
    this.#emitCastAccepted(pending, source);
  }

  #rejectPendingCast(spellId: number, castCount?: number): boolean {
    const pending = this.#takePendingCast(spellId, castCount);
    return pending !== undefined;
  }

  #confirmPendingCast(spellId: number, castCount: number): void {
    // GO carries the cast id. Never fall back to another same-spell request: a late GO for a
    // rejected cast must not consume the newer request that is still waiting for its own result.
    const pending = this.#takePendingCast(spellId, castCount);
    if (pending) {
      // The pending record owns duplicate suppression for this completed GO. It is safe to
      // remove it now; a later request with the same wrapped cast count is a new identity.
      this.#emitCastAccepted(pending, "go");
    }
    if (!pending || pending.cooldownAuthoritative || pending.cooldownStartedOnEvent
      || pending.cooldownDuration === undefined) return;
    this.#applyCooldown(spellId, pending.cooldownDuration, "cast");
  }

  #applyCooldown(
    spellId: number,
    duration: number,
    source: "cast" | "server",
    replace = false,
    startedAt = performance.now(),
  ): boolean {
    if (duration <= 0) return false;
    const end = startedAt + duration;
    if (!replace && (this.cooldowns.get(spellId) ?? 0) >= end) return false;
    this.cooldowns.set(spellId, end);
    this.cooldownSnapshots.set(spellId, { startedAt, duration, endsAt: end });
    if (source === "cast") this.#locallyStartedCooldowns.set(spellId, end);
    else this.#locallyStartedCooldowns.delete(spellId);
    this.events.emit("SPELL_COOLDOWN_STARTED", { spellId, startedAt, duration, source });
    this.onCooldownsChanged?.();
    return true;
  }

  #clearCooldown(spellId: number): void {
    this.cooldowns.delete(spellId);
    this.cooldownSnapshots.delete(spellId);
    this.#locallyStartedCooldowns.delete(spellId);
  }

  cooldownRemaining(spellId: number, now = performance.now()): number {
    return Math.max(0, (this.cooldowns.get(spellId) ?? 0) - now);
  }

  aurasFor(guid: bigint | undefined): readonly ActiveAura[] {
    return guid === undefined ? [] : [...(this.auras.get(guid)?.values() ?? [])].sort((left, right) => left.slot - right.slot);
  }

  openGossip(guid: bigint): void {
    if (this.#closed || !this.state.objects.has(guid)) return;
    this.#pendingGossipGuid = guid;
    this.#pendingGossipServiceGuid = 0n;
    this.#connection.send(OPCODES.CMSG_GOSSIP_HELLO, buildGossipHello(guid));
  }

  selectGossipOption(optionId: number, code?: string): void {
    const gossip = this.gossip;
    const option = gossip?.options.find((candidate) => candidate.id === optionId);
    if (this.#closed || !gossip || !option) return;
    this.#pendingGossipGuid = gossip.guid;
    this.#pendingGossipServiceGuid = gossip.guid;
    this.#connection.send(OPCODES.CMSG_GOSSIP_SELECT_OPTION, buildGossipSelect(gossip.guid, gossip.menuId, optionId, option.coded ? code ?? "" : undefined));
  }

  closeGossip(): void {
    const hadGossip = this.gossip !== undefined;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    if (!hadGossip) return;
    this.gossip = undefined;
    this.onGossipChanged?.();
  }

  /** Finishes the gossip page before its selected option opens a different NPC service. */
  #consumeGossipService(guid: bigint): void {
    if (guid === 0n || this.#pendingGossipServiceGuid !== guid) return;
    this.#pendingGossipServiceGuid = 0n;
    this.#pendingGossipGuid = 0n;
    if (this.gossip?.guid !== guid) return;
    this.gossip = undefined;
    this.onGossipChanged?.();
  }

  openQuestList(guid: bigint): void {
    if (this.#closed || !this.state.objects.has(guid)) return;
    this.questMessage = undefined;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.#pendingQuestGiverGuid = guid;
    this.#connection.send(OPCODES.CMSG_QUESTGIVER_HELLO, buildQuestGiverHello(guid));
  }

  openQuest(guid: bigint, questId: number, completion: boolean): void {
    if (this.#closed) return;
    this.questMessage = undefined;
    this.#connection.send(
      completion ? OPCODES.CMSG_QUESTGIVER_COMPLETE_QUEST : OPCODES.CMSG_QUESTGIVER_QUERY_QUEST,
      completion ? buildQuestAction(guid, questId) : buildQuestQuery(guid, questId),
    );
  }

  acceptQuest(): void {
    if (this.#closed || this.questDialog?.kind !== "details") return;
    this.#connection.send(OPCODES.CMSG_QUESTGIVER_ACCEPT_QUEST, buildQuestAccept(this.questDialog.guid, this.questDialog.questId));
  }

  requestQuestReward(): void {
    if (this.#closed || this.questDialog?.kind !== "request-items" || !this.questDialog.canComplete) return;
    this.#connection.send(OPCODES.CMSG_QUESTGIVER_REQUEST_REWARD, buildQuestAction(this.questDialog.guid, this.questDialog.questId));
  }

  chooseQuestReward(choice: number): void {
    if (this.#closed || this.questDialog?.kind !== "reward") return;
    this.#connection.send(OPCODES.CMSG_QUESTGIVER_CHOOSE_REWARD, buildQuestChooseReward(this.questDialog.guid, this.questDialog.questId, choice));
  }

  closeQuest(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_QUESTGIVER_CANCEL);
    this.#pendingQuestGiverGuid = 0n;
    this.questList = undefined;
    this.questDialog = undefined;
    this.questMessage = undefined;
    this.onQuestChanged?.();
  }

  /**
   * The template behind one game object, or undefined until it arrives.
   *
   * Asking is what makes an object more than a diamond on the screen: its update fields carry a
   * display id and a state, and the type it can be acted on by lives in the template. One request
   * per entry, and a miss is remembered so a bad entry is not asked for on every frame.
   */
  gameObjectTemplate(entry: number, guid: bigint): GameObjectTemplate | undefined {
    const known = this.gameObjectTemplates.get(entry);
    if (known !== undefined) return known ?? undefined;
    if (this.#closed || this.#requestedGameObjects.has(entry)) return undefined;
    this.#requestedGameObjects.add(entry);
    this.#connection.send(OPCODES.CMSG_GAMEOBJECT_QUERY, buildGameObjectQuery(entry, guid));
    return undefined;
  }

  /**
   * Waits for the template query an eligible click has already started.
   *
   * The waiter belongs to the world lifecycle instead of `onGameObjectsChanged`: that callback is
   * a renderer notification with one owner, while several live objects may share one template
   * entry. A guid is retained only while it still names the same GO entry, and every exit resolves
   * rather than rejects so a disappearing object cannot create an unhandled UI promise.
   */
  waitForGameObjectTemplate(entry: number, guid: bigint): Promise<GameObjectTemplate | undefined> {
    const known = this.gameObjectTemplates.get(entry);
    if (known !== undefined || this.gameObjectTemplates.has(entry)) return Promise.resolve(known ?? undefined);
    if (this.#closed || entry <= 0 || !this.#requestedGameObjects.has(entry)) return Promise.resolve(undefined);

    const object = this.state.objects.get(guid);
    const currentEntry = object?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
    if (object?.typeId !== 5 || currentEntry !== entry) return Promise.resolve(undefined);

    const existing = this.#gameObjectTemplateWaiters.get(guid);
    if (existing?.entry === entry && existing.object === object) return existing.promise;
    if (existing) this.#cancelGameObjectTemplateWaiters(guid);

    let resolve = (_template: GameObjectTemplate | undefined): void => undefined;
    const promise = new Promise<GameObjectTemplate | undefined>((settle) => { resolve = settle; });
    const timer = setTimeout(() => this.#cancelGameObjectTemplateWaiters(guid), GAME_OBJECT_TEMPLATE_WAIT_MS);
    this.#gameObjectTemplateWaiters.set(guid, { entry, object, promise, resolve, timer });
    return promise;
  }

  #settleGameObjectTemplateWaiters(entry: number, template: GameObjectTemplate | undefined): void {
    for (const [guid, waiter] of this.#gameObjectTemplateWaiters) {
      if (waiter.entry !== entry) continue;
      this.#gameObjectTemplateWaiters.delete(guid);
      clearTimeout(waiter.timer);
      waiter.resolve(this.state.objects.get(guid) === waiter.object ? template : undefined);
    }
  }

  #cancelGameObjectTemplateWaiters(guid: bigint): void {
    const waiter = this.#gameObjectTemplateWaiters.get(guid);
    if (!waiter) return;
    this.#gameObjectTemplateWaiters.delete(guid);
    clearTimeout(waiter.timer);
    waiter.resolve(undefined);
  }

  #settleAllGameObjectTemplateWaiters(): void {
    for (const guid of [...this.#gameObjectTemplateWaiters.keys()]) this.#cancelGameObjectTemplateWaiters(guid);
  }

  /** `UPDATE_OUT_OF_RANGE` removes objects inside WorldState rather than through a destroy opcode. */
  #cancelStaleGameObjectTemplateWaiters(): void {
    for (const [guid, waiter] of this.#gameObjectTemplateWaiters) {
      if (this.state.objects.get(guid) !== waiter.object) this.#cancelGameObjectTemplateWaiters(guid);
    }
  }

  /**
   * Opens a door, pulls a lever, sits in a chair, steps through a portal.
   *
   * The server answers nothing at all — not even a refusal — so whether this was worth sending is
   * the client's judgement, and a use it rejects looks exactly like one it accepted and had no
   * visible effect. The report is sent alongside because quest credit for using an object hangs
   * off it and off nothing else.
   */
  useGameObject(guid: bigint): void {
    const object = this.state.objects.get(guid);
    if (this.#closed || !object || object.typeId !== 5) return;
    this.#connection.send(OPCODES.CMSG_GAMEOBJ_USE, buildGameObjectUse(guid));
    this.#connection.send(OPCODES.CMSG_GAMEOBJ_REPORT_USE, buildGameObjectReportUse(guid));
  }

  /**
   * Opens a chest, an ore vein or a herb by casting at it.
   *
   * These are not in the server's use switch, so nothing else opens them. The server accepts a
   * spell the player does not know, but only the one it worked out from the lock itself, so the
   * caller has to have reached the same answer. The loot arrives unbidden when the cast lands.
   */
  openLock(guid: bigint, spellId: number): void {
    const object = this.state.objects.get(guid);
    if (this.#closed || !object || object.typeId !== 5 || spellId <= 0) return;
    this.#cancelMountBeforeCast();
    this.#castCount = (this.#castCount + 1) & 0xff;
    this.#connection.send(OPCODES.CMSG_CAST_SPELL, buildCastSpellOnGameObject(spellId, this.#castCount, guid));
    this.#trackPendingCast(spellId, this.#castCount);
  }

  #handleGameObject(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_GAMEOBJECT_QUERY_RESPONSE) {
      const template = parseGameObjectQueryResponse(packet.payload);
      // A miss is stored as null so the entry is never asked for twice.
      const reader = new PacketReader(packet.payload);
      const entry = template?.entry ?? (reader.u32() & 0x7fffffff);
      this.gameObjectTemplates.set(entry, template ?? null);
      this.#settleGameObjectTemplateWaiters(entry, template);
      this.onGameObjectsChanged?.();
      this.events.emit("QUERY_CACHE_CHANGED", { kind: "gameObject", id: entry });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GAMEOBJECT_CUSTOM_ANIM) {
      const custom = parseGameObjectCustomAnim(packet.payload);
      this.onGameObjectAnimation?.(custom.guid, custom.animation);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GAMEOBJECT_DESPAWN_ANIM) {
      // The only warning a mined vein gives that it is going; the destroy update comes later.
      const guid = parseGameObjectDespawnAnim(packet.payload);
      this.#cancelGameObjectTemplateWaiters(guid);
      this.state.destroy(guid);
      return true;
    }
    return false;
  }

  openLoot(guid: bigint): void {
    // A game object's loot is never asked for: the server refuses CMSG_LOOT outright for anything
    // that is not a creature, and a chest's loot arrives unbidden once a lock-opening spell has
    // finished. Sending it anyway was a silent no-op.
    const object = this.state.objects.get(guid);
    if (this.#closed || !object || object.typeId === 5) return;
    this.#connection.send(OPCODES.CMSG_LOOT, buildLootRequest(guid));
  }

  takeLootSlot(index: number): void {
    const slot = this.loot?.slots.find((candidate) => candidate.index === index);
    if (this.#closed || !slot || !isLootSlotTakeable(slot)) return;
    this.#connection.send(OPCODES.CMSG_AUTOSTORE_LOOT_ITEM, buildAutostoreLootItem(index));
  }

  takeLootMoney(): void {
    if (this.#closed || !this.loot || this.loot.gold <= 0) return;
    this.#connection.send(OPCODES.CMSG_LOOT_MONEY, buildLootMoney());
  }

  closeLoot(): void {
    const guid = this.loot?.guid;
    this.loot = undefined;
    this.onLootChanged?.();
    if (!this.#closed && guid !== undefined) this.#connection.send(OPCODES.CMSG_LOOT_RELEASE, buildLootRelease(guid));
  }

  /** Releases the spirit after death, which turns the character into a ghost at the graveyard. */
  releaseSpirit(): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_REPOP_REQUEST, buildRepopRequest());
    this.queryCorpse();
  }

  queryCorpse(): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_CORPSE_QUERY, buildCorpseQuery());
  }

  /** Runs back to the body and revives. The server resolves the corpse itself and ignores the GUID. */
  reclaimCorpse(corpseGuid = 0n): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_RECLAIM_CORPSE, buildReclaimCorpse(corpseGuid));
  }

  answerResurrect(accept: boolean): void {
    const request = this.resurrectRequest;
    if (this.#closed || !request) return;
    this.resurrectRequest = undefined;
    this.#connection.send(OPCODES.CMSG_RESURRECT_RESPONSE, buildResurrectResponse(request.casterGuid, accept));
    this.onDeathChanged?.();
  }

  /** Revives at a spirit healer, which costs durability and applies resurrection sickness. */
  activateSpiritHealer(guid: bigint): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_SPIRIT_HEALER_ACTIVATE, buildSpiritHealerActivate(guid));
  }

  /** Milliseconds still to wait before the corpse can be reclaimed, counted down locally. */
  corpseReclaimRemaining(now = performance.now()): number {
    if (this.corpseReclaimDelay <= 0) return 0;
    return Math.max(0, this.corpseReclaimDelay - (now - this.corpseReclaimReportedAt));
  }

  openVendor(guid: bigint): void {
    if (this.#closed || !this.state.objects.has(guid)) return;
    this.merchantMessage = undefined;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.#pendingVendorGuid = guid;
    this.#connection.send(OPCODES.CMSG_LIST_INVENTORY, buildListInventory(guid));
  }

  /** `slot` is the one based number from the vendor list; `count` is in purchase units. */
  buyFromVendor(slot: number, count = 1): void {
    const vendor = this.vendor;
    const item = vendor?.items.find((candidate) => candidate.slot === slot);
    if (this.#closed || !vendor || !item || count < 1) return;
    this.#connection.send(OPCODES.CMSG_BUY_ITEM, buildBuyItem(vendor.guid, item.itemId, slot, count));
  }

  sellToVendor(itemGuid: bigint, count = 0): void {
    const vendor = this.vendor;
    if (this.#closed || !vendor || itemGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_SELL_ITEM, buildSellItem(vendor.guid, itemGuid, count));
  }

  buybackFromVendor(slot: number): void {
    const vendor = this.vendor;
    if (this.#closed || !vendor) return;
    this.#connection.send(OPCODES.CMSG_BUYBACK_ITEM, buildBuybackItem(vendor.guid, slot));
  }

  closeVendor(): void {
    const hadVendor = this.vendor !== undefined;
    this.#pendingVendorGuid = 0n;
    if (!hadVendor) return;
    this.vendor = undefined;
    this.merchantMessage = undefined;
    this.onVendorChanged?.();
  }

  openTrainer(guid: bigint): void {
    if (this.#closed || !this.state.objects.has(guid)) return;
    this.merchantMessage = undefined;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.#pendingTrainerGuid = guid;
    this.#connection.send(OPCODES.CMSG_TRAINER_LIST, buildTrainerList(guid));
  }

  learnFromTrainer(spellId: number): void {
    const trainer = this.trainer;
    const spell = trainer?.spells.find((candidate) => candidate.spellId === spellId && candidate.usable === TRAINER_SPELL_AVAILABLE);
    if (this.#closed || !trainer || !spell) return;
    this.#connection.send(OPCODES.CMSG_TRAINER_BUY_SPELL, buildTrainerBuySpell(trainer.guid, spellId));
  }

  closeTrainer(): void {
    const hadTrainer = this.trainer !== undefined;
    this.#pendingTrainerGuid = undefined;
    if (!hadTrainer) return;
    this.trainer = undefined;
    this.merchantMessage = undefined;
    this.onTrainerChanged?.();
  }

  /** Equips the item in the given container slot into whatever slot fits. */
  equipItem(bag: number, slot: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_AUTOEQUIP_ITEM, buildAutoEquipItem(bag, slot));
  }

  /**
   * Uses the item. The server picks the spell from the item template and only logs the id we
   * send, so zero is fine; targets are written as "no target", which covers consumables.
   */
  useItem(bag: number, slot: number, itemGuid: bigint): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_USE_ITEM, buildUseItem(bag, slot, ++this.#useCount & 0xff, 0, itemGuid));
  }

  /** A count of zero destroys the whole stack, which is what the original client sends. */
  destroyItem(bag: number, slot: number, count = 0): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_DESTROYITEM, buildDestroyItem(bag, slot, count));
  }

  /** Only stages a request; the realm consumes gems and supplies the resulting enchantments. */
  socketGems(itemGuid: bigint, gems: readonly [bigint, bigint, bigint]): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_SOCKET_GEMS, buildSocketGems(itemGuid, gems));
  }

  /** Moves an item, choosing the right opcode for whether either end is the player inventory. */
  moveItem(sourceBag: number, sourceSlot: number, destinationBag: number, destinationSlot: number): void {
    if (this.#closed) return;
    if (sourceBag === INVENTORY_SLOT_BAG_0 && destinationBag === INVENTORY_SLOT_BAG_0) {
      this.#connection.send(OPCODES.CMSG_SWAP_INV_ITEM, buildSwapInvItem(sourceSlot, destinationSlot));
      return;
    }
    this.#connection.send(OPCODES.CMSG_SWAP_ITEM, buildSwapItem(sourceBag, sourceSlot, destinationBag, destinationSlot));
  }

  /** Moves an item into the first free slot of a bag. */
  storeItemInBag(sourceBag: number, sourceSlot: number, destinationBag: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_AUTOSTORE_BAG_ITEM, buildAutoStoreBagItem(sourceBag, sourceSlot, destinationBag));
  }

  splitItem(sourceBag: number, sourceSlot: number, destinationBag: number, destinationSlot: number, count: number): void {
    if (this.#closed || count < 1) return;
    this.#connection.send(OPCODES.CMSG_SPLIT_ITEM, buildSplitItem(sourceBag, sourceSlot, destinationBag, destinationSlot, count));
  }

  /** The racial language of the logged in character; the server rejects the universal one. */
  get chatLanguage(): number {
    const player = this.state.selfGuid === undefined ? undefined : this.state.objects.get(this.state.selfGuid);
    const bytes = player?.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset) ?? 0;
    return languageForRace(bytes & 0xff);
  }

  sendChat(type: number, text: string, target = ""): void {
    if (this.#closed || !text) return;
    this.#connection.send(OPCODES.CMSG_MESSAGECHAT, buildChatMessage(type, this.chatLanguage, text, target));
  }

  /**
   * `/dance`, `/wave` and the other two hundred and fifty.
   *
   * The variant number is sent as zero, the way the original client sends it: the server echoes it
   * untouched and only the receiving client reads it, to pick between two wordings of the same
   * emote. Nothing here picks the second one.
   */
  sendTextEmote(textEmoteId: number, target = 0n): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_TEXT_EMOTE, buildTextEmote(textEmoteId, 0, target));
  }

  joinChannel(name: string, password = ""): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_JOIN_CHANNEL, buildJoinChannel(0, name, password));
  }

  leaveChannel(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_LEAVE_CHANNEL, buildLeaveChannel(0, name));
  }

  /** Asks the server for a player name, at most once per GUID. */
  requestName(guid: bigint): void {
    if (this.#closed || !this.names.shouldQuery(guid)) return;
    this.#connection.send(OPCODES.CMSG_NAME_QUERY, buildNameQuery(guid));
  }

  /**
   * Name for a GUID, falling back to the raw GUID until the query comes back.
   *
   * The character's own name goes in front of that fallback, and that is the whole of the player
   * report «при выделении себя показывается не никнейм, а 0000000000000»: for a character whose
   * guid is 4 the fallback reads `0x0000000000000004`, eighteen characters of which sixteen are
   * the digit zero, and the target frame is 213 px wide. The name has been in the session since
   * the character screen — `EnterWorld` writes `selfName` — and 26 of this method's 27 callers
   * hand it a bare guid, so this is the one place that can put it back. It costs no round trip,
   * which is why it is here *as well as* in the query the world loop now sends: this fixes the
   * first frame, the query fixes the declensions nothing else can obtain.
   */
  displayName(guid: bigint): string {
    return this.names.get(guid)
      ?? (guid === this.state.selfGuid ? this.selfName : undefined)
      ?? `0x${guid.toString(16).padStart(16, "0")}`;
  }

  inviteToGroup(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_GROUP_INVITE, buildGroupInvite(name));
  }

  answerGroupInvite(accept: boolean): void {
    if (this.#closed || !this.groupInvite) return;
    this.groupInvite = undefined;
    if (accept) this.#connection.send(OPCODES.CMSG_GROUP_ACCEPT, buildGroupAccept());
    else this.#connection.send(OPCODES.CMSG_GROUP_DECLINE);
    this.onGroupChanged?.();
  }

  removeFromGroup(guid: bigint, reason = ""): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GROUP_UNINVITE_GUID, buildGroupUninvite(guid, reason));
  }

  /** Leaving and disbanding are the same opcode; the server decides by who sent it. */
  leaveGroup(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GROUP_DISBAND);
  }

  // --- Slice P5: the raid, the rolls, the guild bank, the calendar, contacts and charters. ---

  /** Only a leader or an assistant may ask; the server drops it silently from anyone else. */
  startReadyCheck(): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_RAID_READY_CHECK, buildReadyCheckRequest());
  }

  /** One byte is an answer to a running check, where an empty body would start a new one. */
  answerReadyCheck(ready: boolean): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_RAID_READY_CHECK, buildReadyCheckAnswer(ready));
  }

  finishReadyCheck(): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.MSG_RAID_READY_CHECK_FINISHED, buildReadyCheckFinished());
  }

  /** Hands the group over. Only the current leader may ask, and only for a member. */
  setGroupLeader(guid: bigint): void {
    if (!this.#closed && guid !== 0n) this.#connection.send(OPCODES.CMSG_GROUP_SET_LEADER, buildGroupSetLeader(guid));
  }

  /** Turns a party into a raid. The server refuses below two members and inside a battleground. */
  convertToRaid(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GROUP_RAID_CONVERT, buildGroupRaidConvert());
  }

  /** The assistant flag, which is what lets somebody else mark targets and start a ready check. */
  setPartyAssistant(guid: bigint, apply: boolean): void {
    if (!this.#closed && guid !== 0n) {
      this.#connection.send(OPCODES.CMSG_GROUP_ASSISTANT_LEADER, buildGroupAssistantLeader(guid, apply));
    }
  }

  /**
   * Loot rules for the whole group.
   *
   * All three go in one packet: the server reads method, master and threshold together and
   * rejects a method above `NEED_BEFORE_GREED`, so they cannot be set one at a time.
   */
  setLootMethod(method: number, masterGuid: bigint, threshold: number): void {
    if (this.#closed || method < 0 || method > 4) return;
    this.#connection.send(OPCODES.CMSG_LOOT_METHOD, buildLootMethod(method, masterGuid, threshold));
  }

  /** Moving a raid member between subgroups, which the server does by name rather than by guid. */
  changeSubGroup(name: string, subGroup: number): void {
    if (this.#closed || !name || subGroup < 0 || subGroup >= RAID_SUBGROUPS) return;
    this.#connection.send(OPCODES.CMSG_GROUP_CHANGE_SUB_GROUP, buildGroupChangeSubGroup(name, subGroup));
  }

  /** Asks for one member's full stats, for a frame that has only ever seen the summary. */
  requestPartyMemberStats(guid: bigint): void {
    if (!this.#closed && guid !== 0n) {
      this.#connection.send(OPCODES.CMSG_REQUEST_PARTY_MEMBER_STATS, buildRequestPartyMemberStats(guid));
    }
  }

  /** Main tank and main assist. The answer comes back as a group list, not as an echo. */
  assignPartyRole(assignment: number, apply: boolean, guid: bigint): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_PARTY_ASSIGNMENT, buildPartyAssignment(assignment, apply, guid));
  }

  requestRaidTargets(): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_RAID_TARGET_UPDATE, buildRaidTargetQuery());
  }

  /** A zero guid clears the marker. Icons run 0 to 7; `raidTargetName` words them. */
  setRaidTarget(icon: number, guid: bigint): void {
    if (this.#closed || icon < 0 || icon > 7) return;
    this.#connection.send(OPCODES.MSG_RAID_TARGET_UPDATE, buildSetRaidTarget(icon, guid));
  }

  pingMinimap(x: number, y: number): void {
    if (!this.#closed && this.group) this.#connection.send(OPCODES.MSG_MINIMAP_PING, buildMinimapPing(x, y));
  }

  /** The server refuses a backwards range or a maximum above ten thousand, without answering. */
  rollDice(minimum = 1, maximum = 100): void {
    if (this.#closed || minimum > maximum || maximum > 10000) return;
    this.#connection.send(OPCODES.MSG_RANDOM_ROLL, buildRandomRoll(minimum, maximum));
  }

  /** The item guid is the synthetic one the roll was announced with. */
  rollForLoot(itemSlot: number, rollType: number): void {
    const roll = this.lootRolls.get(itemSlot);
    if (this.#closed || !roll) return;
    this.#connection.send(OPCODES.CMSG_LOOT_ROLL, buildLootRoll(roll.start.itemGuid, itemSlot, rollType));
  }

  giveMasterLoot(slot: number, targetGuid: bigint): void {
    if (this.#closed || !this.loot) return;
    this.#connection.send(OPCODES.CMSG_LOOT_MASTER_GIVE, buildLootMasterGive(this.loot.guid, slot, targetGuid));
  }

  /** Opens the guild bank at the chest or banker the player is standing at. */
  openGuildBank(bankerGuid: bigint): void {
    if (this.#closed || bankerGuid === 0n) return;
    this.guildBankerGuid = bankerGuid;
    this.#connection.send(OPCODES.CMSG_GUILD_BANKER_ACTIVATE, buildGuildBankerActivate(bankerGuid, true));
    this.#connection.send(OPCODES.MSG_GUILD_PERMISSIONS, buildGuildPermissionsQuery());
    this.#connection.send(OPCODES.MSG_GUILD_BANK_MONEY_WITHDRAWN, buildGuildBankMoneyWithdrawnQuery());
  }

  requestGuildBankTab(tabId: number): void {
    if (this.#closed || this.guildBankerGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_GUILD_BANK_QUERY_TAB, buildGuildBankQueryTab(this.guildBankerGuid, tabId, true));
    this.#connection.send(OPCODES.MSG_QUERY_GUILD_BANK_TEXT, buildGuildBankTextQuery(tabId));
  }

  /** Tab six is the money log rather than a real tab. */
  requestGuildBankLog(tabId: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_GUILD_BANK_LOG_QUERY, buildGuildBankLogQuery(tabId));
  }

  requestGuildEventLog(): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_GUILD_EVENT_LOG_QUERY, buildGuildEventLogQuery());
  }

  /**
   * Walking away from the banker.
   *
   * Local only: there is no close opcode for a guild bank. Without it the guid stayed set for the
   * rest of the session and the client would happily keep querying tabs from across the map.
   */
  closeGuildBank(): void {
    this.guildBankerGuid = 0n;
    this.guildBank = undefined;
  }

  /** Unlocking the next tab. The price climbs steeply and the server checks it, not the client. */
  buyGuildBankTab(tabId: number): void {
    if (this.#closed || this.guildBankerGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_GUILD_BANK_BUY_TAB, buildGuildBankBuyTab(this.guildBankerGuid, tabId));
  }

  renameGuildBankTab(tabId: number, name: string, icon: string): void {
    if (this.#closed || this.guildBankerGuid === 0n) return;
    this.#connection.send(
      OPCODES.CMSG_GUILD_BANK_UPDATE_TAB, buildGuildBankUpdateTab(this.guildBankerGuid, tabId, name, icon));
  }

  /** Copper in, copper out. Both are a u32, so one transfer cannot exceed about 429 000 gold. */
  depositGuildBankMoney(copper: number): void {
    if (this.#closed || this.guildBankerGuid === 0n || copper <= 0) return;
    this.#connection.send(OPCODES.CMSG_GUILD_BANK_DEPOSIT_MONEY, buildGuildBankMoney(this.guildBankerGuid, copper));
  }

  withdrawGuildBankMoney(copper: number): void {
    if (this.#closed || this.guildBankerGuid === 0n || copper <= 0) return;
    this.#connection.send(OPCODES.CMSG_GUILD_BANK_WITHDRAW_MONEY, buildGuildBankMoney(this.guildBankerGuid, copper));
  }

  withdrawGuildBankItem(tabId: number, slotId: number, itemId: number): void {
    if (this.#closed || this.guildBankerGuid === 0n) return;
    this.#connection.send(
      OPCODES.CMSG_GUILD_BANK_SWAP_ITEMS,
      buildGuildBankWithdrawItem(this.guildBankerGuid, tabId, slotId, itemId));
  }

  depositGuildBankItem(tabId: number, slotId: number, itemId: number, bag: number, bagSlot: number, split = 0): void {
    if (this.#closed || this.guildBankerGuid === 0n) return;
    this.#connection.send(
      OPCODES.CMSG_GUILD_BANK_SWAP_ITEMS,
      buildGuildBankDepositItem(this.guildBankerGuid, tabId, slotId, itemId, bag, bagSlot, split));
  }

  openTabardVendor(guid: bigint): void {
    if (this.#closed || guid === 0n) return;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.tabardVendorGuid = 0n;
    this.tabardMessage = undefined;
    this.#pendingTabardSaveGuid = 0n;
    this.#pendingTabardVendorGuid = guid;
    this.#connection.send(OPCODES.MSG_TABARDVENDOR_ACTIVATE, buildTabardVendorActivate(guid));
  }

  saveGuildEmblem(style: number, color: number, borderStyle: number, borderColor: number, background: number): void {
    if (this.#closed || this.tabardVendorGuid === 0n) return;
    this.#pendingTabardSaveGuid = this.tabardVendorGuid;
    this.#connection.send(
      OPCODES.MSG_SAVE_GUILD_EMBLEM,
      buildSaveGuildEmblem(this.tabardVendorGuid, style, color, borderStyle, borderColor, background),
    );
  }

  requestCalendar(): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_GET_CALENDAR, buildCalendarQuery());
    this.#connection.send(OPCODES.CMSG_CALENDAR_GET_NUM_PENDING, buildCalendarPendingCountQuery());
  }

  requestCalendarEvent(eventId: bigint): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_CALENDAR_GET_EVENT, buildCalendarEventQuery(eventId));
  }

  addCalendarEvent(event: CalendarEventFields, invites: readonly CalendarNewInvite[] = []): void {
    if (this.#closed || !event.title) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_ADD_EVENT, buildCalendarAddEvent(event, invites));
  }

  updateCalendarEvent(eventId: bigint, moderatorId: bigint, event: CalendarEventFields): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_UPDATE_EVENT, buildCalendarUpdateEvent(eventId, moderatorId, event));
  }

  removeCalendarEvent(eventId: bigint, moderatorId = 0n, isSignUp = false): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_REMOVE_EVENT, buildCalendarRemoveEvent(eventId, moderatorId, isSignUp));
  }

  copyCalendarEvent(eventId: bigint, moderatorId: bigint, packedDate: number): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_COPY_EVENT, buildCalendarCopyEvent(eventId, moderatorId, packedDate));
  }

  /** Answering an invitation addressed to this character. */
  answerCalendarInvite(eventId: bigint, inviteId: bigint, status: number): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_EVENT_RSVP, buildCalendarRsvp(eventId, inviteId, status));
  }

  inviteToCalendarEvent(eventId: bigint, name: string, moderatorId = 0n, creating = false, isSignUp = false): void {
    if (this.#closed || !name) return;
    this.#connection.send(
      OPCODES.CMSG_CALENDAR_EVENT_INVITE, buildCalendarInvite(eventId, moderatorId, name, creating, isSignUp));
  }

  /** Putting yourself down for a guild event nobody invited you to. */
  signUpForCalendarEvent(eventId: bigint, tentative = false): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_EVENT_SIGNUP, buildCalendarSignUp(eventId, tentative));
  }

  removeCalendarInvite(guid: bigint, inviteId: bigint, eventId: bigint, moderatorId = 0n): void {
    if (this.#closed) return;
    this.#connection.send(
      OPCODES.CMSG_CALENDAR_EVENT_REMOVE_INVITE, buildCalendarRemoveInvite(guid, inviteId, moderatorId, eventId));
  }

  setCalendarInviteStatus(guid: bigint, eventId: bigint, inviteId: bigint, status: number, moderatorId = 0n): void {
    if (this.#closed) return;
    this.#connection.send(
      OPCODES.CMSG_CALENDAR_EVENT_STATUS, buildCalendarEventStatus(guid, eventId, inviteId, moderatorId, status));
  }

  setCalendarModerator(guid: bigint, eventId: bigint, inviteId: bigint, status: number, moderatorId = 0n): void {
    if (this.#closed) return;
    this.#connection.send(
      OPCODES.CMSG_CALENDAR_EVENT_MODERATOR_STATUS,
      buildCalendarModeratorStatus(guid, eventId, inviteId, moderatorId, status));
  }

  /** Which guild members a new event's invite list is drawn from. */
  requestCalendarGuildFilter(minLevel: number, maxLevel: number, maxRankOrder: number): void {
    if (this.#closed) return;
    this.#connection.send(
      OPCODES.CMSG_CALENDAR_GUILD_FILTER, buildCalendarGuildFilter(minLevel, maxLevel, maxRankOrder));
  }

  requestCalendarArenaTeam(arenaTeamId: number): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CALENDAR_ARENA_TEAM, buildCalendarArenaTeam(arenaTeamId));
  }

  complainAboutCalendarInvite(invitedByGuid: bigint, eventId: bigint, inviteId: bigint): void {
    if (this.#closed) return;
    this.#connection.send(
      OPCODES.CMSG_CALENDAR_COMPLAIN, buildCalendarComplain(invitedByGuid, eventId, inviteId));
  }

  requestContacts(flags?: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_CONTACT_LIST, buildContactListQuery(flags));
  }

  addFriend(name: string, note = ""): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_ADD_FRIEND, buildAddFriend(name, note));
  }

  removeFriend(guid: bigint): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_DEL_FRIEND, buildDeleteFriend(guid));
  }

  addIgnore(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_ADD_IGNORE, buildAddIgnore(name));
  }

  removeIgnore(guid: bigint): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_DEL_IGNORE, buildDeleteIgnore(guid));
  }

  /** `/who`. The server caps the rows it returns but still reports how many matched. */
  requestWho(request: WhoRequest = {}): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_WHO, buildWhoQuery(request));
  }

  requestWhois(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_WHOIS, buildWhoIs(name));
  }

  requestNextMailTime(): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_QUERY_NEXT_MAIL_TIME, buildNextMailTimeQuery());
  }

  requestPetition(petitionGuid: bigint): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_PETITION_QUERY, buildPetitionQuery(petitionGuid));
    this.#connection.send(OPCODES.CMSG_PETITION_SHOW_SIGNATURES, buildPetitionShowSignatures(petitionGuid));
  }

  requestPetitionVendor(vendorGuid: bigint): void {
    if (!this.#closed && vendorGuid !== 0n) this.#connection.send(OPCODES.CMSG_PETITION_SHOWLIST, buildPetitionShowList(vendorGuid));
  }

  signPetition(petitionGuid: bigint): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_PETITION_SIGN, buildPetitionSign(petitionGuid));
  }

  declinePetition(petitionGuid: bigint): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_PETITION_DECLINE, buildPetitionDecline(petitionGuid));
  }

  renamePetition(petitionGuid: bigint, name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.MSG_PETITION_RENAME, buildPetitionRename(petitionGuid, name));
  }

  /**
   * An arena charter must carry the emblem: the server destroys the charter item before reading
   * it, so leaving the block off loses the charter rather than cancelling the turn-in.
   */
  turnInPetition(petitionGuid: bigint, emblem?: {
    background: number; icon: number; iconColor: number; border: number; borderColor: number;
  }): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_TURN_IN_PETITION, buildTurnInPetition(petitionGuid, emblem));
  }

  /** What this character, and then the rest of the party, may not enter and why. */
  requestDungeonLocks(): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_LFD_PLAYER_LOCK_INFO_REQUEST, buildLfgPlayerLockInfoRequest());
    if (this.group) this.#connection.send(OPCODES.CMSG_LFD_PARTY_LOCK_INFO_REQUEST, buildLfgPartyLockInfoRequest());
  }

  voteToRemove(agree: boolean): void {
    if (this.#closed || !this.lfgBoot) return;
    this.#connection.send(OPCODES.CMSG_LFG_SET_BOOT_VOTE, buildLfgBootVote(agree));
  }

  // --- Slice P6: the pet bar, the stable and riding something. ---

  /** Asks for the pet bar again. The server answers with a full one, or with nothing if no pet. */
  requestPetInfo(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_REQUEST_PET_INFO, buildRequestPetInfo());
  }

  /** Presses a slot on the pet bar, sending back the word the server put in it. */
  usePetSlot(slot: number, targetGuid?: bigint): void {
    const button = this.petSpells?.bar[slot];
    if (this.#closed || !this.petSpells || !button) return;
    const target = targetGuid ?? this.targetGuid ?? 0n;
    this.#connection.send(OPCODES.CMSG_PET_ACTION, buildPetAction(this.petSpells.guid, button.packed, target));
  }

  /** Stay, follow, attack or dismiss. */
  commandPet(command: number, targetGuid?: bigint): void {
    if (this.#closed || !this.petSpells) return;
    const target = targetGuid ?? this.targetGuid ?? 0n;
    this.#connection.send(
      OPCODES.CMSG_PET_ACTION,
      buildPetAction(this.petSpells.guid, packPetAction(command, ACT_COMMAND), target),
    );
  }

  /** Passive, defensive or aggressive. */
  setPetReaction(react: number): void {
    if (this.#closed || !this.petSpells) return;
    this.#connection.send(
      OPCODES.CMSG_PET_ACTION,
      buildPetAction(this.petSpells.guid, packPetAction(react, ACT_REACTION), 0n),
    );
  }

  /**
   * Moves a button, or clears one. A command or reaction button can only be moved, never removed;
   * a swap must name both slots and their true current contents, which the server cross-checks.
   */
  setPetActionSlot(slot: number, packed: number): void {
    const bar = this.petSpells?.bar;
    if (this.#closed || !this.petSpells || !bar?.[slot]) return;
    this.#connection.send(OPCODES.CMSG_PET_SET_ACTION, buildPetSetAction(this.petSpells.guid, slot, packed));
    this.#placePetButton(slot, packed);
    this.events.emit("PET_BAR_CHANGED", { guid: this.petSpells.guid });
  }

  swapPetActionSlots(first: number, second: number): void {
    const bar = this.petSpells?.bar;
    if (this.#closed || !this.petSpells || !bar?.[first] || !bar[second]) return;
    const wasFirst = bar[first]!.packed;
    const wasSecond = bar[second]!.packed;
    this.#connection.send(
      OPCODES.CMSG_PET_SET_ACTION,
      buildPetSwapAction(this.petSpells.guid, first, wasSecond, second, wasFirst),
    );
    this.#placePetButton(first, wasSecond);
    this.#placePetButton(second, wasFirst);
    this.events.emit("PET_BAR_CHANGED", { guid: this.petSpells.guid });
  }

  /**
   * Nothing answers `CMSG_PET_SET_ACTION` — no acknowledgement, no fresh bar — so the held bar has
   * to move itself. It is not bookkeeping: a swap names both slots and the server rejects the whole
   * packet unless the two words match what it believes is in them, so a bar left stale here makes
   * the *next* swap fail silently and the buttons stop responding altogether.
   */
  #placePetButton(slot: number, packed: number): void {
    const button = this.petSpells?.bar[slot];
    if (!button) return;
    button.packed = packed;
    button.action = packed & 0x00ff_ffff;
    button.type = (packed >>> 24) & 0xff;
  }

  togglePetAutocast(spellId: number, enabled: boolean): void {
    if (this.#closed || !this.petSpells) return;
    this.#connection.send(OPCODES.CMSG_PET_SPELL_AUTOCAST, buildPetSpellAutocast(this.petSpells.guid, spellId, enabled));
  }

  cancelPetAura(spellId: number): void {
    if (this.#closed || !this.petSpells) return;
    this.#connection.send(OPCODES.CMSG_PET_CANCEL_AURA, buildPetCancelAura(this.petSpells.guid, spellId));
  }

  stopPetAttack(): void {
    if (this.#closed || !this.petSpells) return;
    this.#connection.send(OPCODES.CMSG_PET_STOP_ATTACK, buildPetStopAttack(this.petSpells.guid));
  }

  /** Only a hunter pet can be abandoned; the bar is taken down by the packet that follows. */
  abandonPet(): void {
    if (this.#closed || !this.petSpells) return;
    this.#connection.send(OPCODES.CMSG_PET_ABANDON, buildPetAbandon(this.petSpells.guid));
  }

  dismissCritter(guid: bigint): void {
    if (!this.#closed && guid !== 0n) this.#connection.send(OPCODES.CMSG_DISMISS_CRITTER, buildDismissCritter(guid));
  }

  /** The pet number comes first here, which is the reverse of every other query. */
  requestPetName(petNumber: number, petGuid: bigint): void {
    if (this.#closed || this.petNames.has(petNumber)) return;
    this.#connection.send(OPCODES.CMSG_PET_NAME_QUERY, buildPetNameQuery(petNumber, petGuid));
  }

  /**
   * The server renames the pet before it reads the declined forms, so a rejected declined block
   * still leaves the new name in place — the rename is not atomic and should not be shown as one.
   */
  renamePet(name: string, declined?: readonly string[]): void {
    if (this.#closed || !this.petSpells || !name) return;
    this.#connection.send(OPCODES.CMSG_PET_RENAME, buildPetRename(this.petSpells.guid, name, declined));
  }

  requestStable(npcGuid: bigint): void {
    if (this.#closed || npcGuid === 0n) return;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.stableMasterGuid = npcGuid;
    this.#pendingStableMasterGuid = npcGuid;
    this.#connection.send(OPCODES.MSG_LIST_STABLED_PETS, buildStableListQuery(npcGuid));
  }

  /** Nothing names the pet: the server stables whichever one is out and picks the slot itself. */
  stablePet(): void {
    if (this.#closed || this.stableMasterGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_STABLE_PET, buildStablePet(this.stableMasterGuid));
  }

  /** The number is the pet's own, not the slot it sits in. */
  unstablePet(petNumber: number): void {
    if (this.#closed || this.stableMasterGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_UNSTABLE_PET, buildUnstablePet(this.stableMasterGuid, petNumber));
  }

  swapStabledPet(petNumber: number): void {
    if (this.#closed || this.stableMasterGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_STABLE_SWAP_PET, buildStableSwapPet(this.stableMasterGuid, petNumber));
  }

  buyStableSlot(): void {
    if (this.#closed || this.stableMasterGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_BUY_STABLE_SLOT, buildBuyStableSlot(this.stableMasterGuid));
  }

  /** A seat the server considers non-exitable ignores this in silence. */
  leaveVehicle(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_REQUEST_VEHICLE_EXIT, buildRequestVehicleExit());
  }

  /** Stepping through seats: the opcode is the direction, and neither carries a body. */
  changeVehicleSeat(next: boolean): void {
    if (this.#closed) return;
    if (next) this.#connection.send(OPCODES.CMSG_REQUEST_VEHICLE_NEXT_SEAT, buildRequestVehicleNextSeat());
    else this.#connection.send(OPCODES.CMSG_REQUEST_VEHICLE_PREV_SEAT, buildRequestVehiclePrevSeat());
  }

  /** The seat index is signed, and a negative one is meaningful. */
  takeVehicleSeat(vehicleGuid: bigint, seat: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_REQUEST_VEHICLE_SWITCH_SEAT, buildRequestVehicleSwitchSeat(vehicleGuid, seat));
  }

  /** Climbing onto another player's vehicle. Both must be in the same raid and standing close. */
  enterPlayerVehicle(targetGuid: bigint): void {
    if (!this.#closed && targetGuid !== 0n) this.#connection.send(OPCODES.CMSG_PLAYER_VEHICLE_ENTER, buildPlayerVehicleEnter(targetGuid));
  }

  /** Only ever for somebody really seated: the server asserts on a passenger without a seat. */
  ejectPassenger(passengerGuid: bigint): void {
    if (!this.#closed && passengerGuid !== 0n) this.#connection.send(OPCODES.CMSG_CONTROLLER_EJECT_PASSENGER, buildEjectPassenger(passengerGuid));
  }

  /** Milliseconds left on a pet spell, or zero. */
  petCooldownRemaining(spellId: number, now = performance.now()): number {
    return Math.max(0, (this.petCooldowns.get(spellId) ?? 0) - now);
  }

  /** Talking to a battlemaster; the answer is the list of what it runs. */
  battlemasterHello(guid: bigint): void {
    if (this.#closed || guid === 0n) return;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.battlefieldList = undefined;
    this.#pendingBattlemasterGuid = guid;
    this.#connection.send(OPCODES.CMSG_BATTLEMASTER_HELLO, buildBattlemasterHello(guid));
  }

  /** Makes delayed NPC-service replies stale when their shared native window is closed. */
  closeNpcServices(): void {
    this.closeGossip();
    this.closeTaxiMenu();
    this.#pendingQuestGiverGuid = 0n;
    this.#pendingVendorGuid = 0n;
    this.#pendingTrainerGuid = undefined;
    this.#pendingBankerGuid = undefined;
    this.#pendingAuctioneerGuid = 0n;
    this.#pendingStableMasterGuid = 0n;
    if (this.questList) {
      this.questList = undefined;
      this.onQuestChanged?.();
    }
    if (this.battlefieldList?.fromWhere === 0) this.battlefieldList = undefined;
    this.#pendingBattlemasterGuid = 0n;
    this.tabardVendorGuid = 0n;
    this.tabardMessage = undefined;
    this.#pendingTabardVendorGuid = 0n;
    this.#pendingTabardSaveGuid = 0n;
  }

  /** Asking for the instance list from the queue window rather than from a battlemaster. */
  requestBattlefieldList(bgTypeId: number, fromWhere = 1): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_BATTLEFIELD_LIST, buildBattlefieldList(bgTypeId, fromWhere));
  }

  /** A zero instance id is "first available"; anything else is a `clientInstanceId` from the list. */
  joinBattleground(battlemasterGuid: bigint, bgTypeId: number, instanceId = 0, asGroup = false): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_BATTLEMASTER_JOIN, buildBattlemasterJoin(battlemasterGuid, bgTypeId, instanceId, asGroup));
  }

  /** The slot is 0, 1 or 2 for 2v2, 3v3 and 5v5. A rated match must be queued as a group. */
  joinArena(battlemasterGuid: bigint, arenaSlot: number, asGroup = false, rated = false): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_BATTLEMASTER_JOIN_ARENA, buildBattlemasterJoinArena(battlemasterGuid, arenaSlot, asGroup, rated));
  }

  /** Empty request; the server answers with one status packet per occupied queue slot. */
  requestBattlefieldStatus(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_BATTLEFIELD_STATUS, buildBattlefieldStatusQuery());
  }

  /**
   * Accepting an invitation, or dropping out of the queue.
   *
   * The battleground and arena type come from the queue slot rather than from the caller: the
   * server finds the queue by both together, and a wrong arena type looks up a queue this player is
   * not in and does nothing at all — silently, which is the part that makes it worth taking from
   * the slot instead of asking for it.
   */
  portToBattleground(queueSlot: number, enter: boolean): void {
    const queued = this.battlefieldQueues.get(queueSlot);
    if (this.#closed || !queued) return;
    this.#connection.send(OPCODES.CMSG_BATTLEFIELD_PORT, buildBattlefieldPort(queued.arenaType, queued.bgTypeId, enter));
  }

  /** Leaving the match the player is standing in. Refused by the server while in combat. */
  leaveBattleground(): void {
    if (this.#closed) return;
    const playing = [...this.battlefieldQueues.values()].find((queued) => queued.status === STATUS_IN_PROGRESS);
    this.#connection.send(OPCODES.CMSG_LEAVE_BATTLEFIELD, buildLeaveBattlefield(playing?.arenaType ?? 0, playing?.bgTypeId ?? 0));
  }

  /** The scoreboard. Refused inside an arena until the match ends and the server sends it unasked. */
  requestPvpScores(): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_PVP_LOG_DATA, buildPvpLogDataQuery());
  }

  /** Where the flags are. Nothing pushes this, so a flag map has to poll it. */
  requestFlagCarriers(): void {
    if (!this.#closed) this.#connection.send(OPCODES.MSG_BATTLEGROUND_PLAYER_POSITIONS, buildBattlegroundPlayerPositionsQuery());
  }

  /** Reporting somebody as away. There is no answer: the server just counts the reports. */
  reportPvpAfk(guid: bigint): void {
    if (!this.#closed && guid !== 0n) this.#connection.send(OPCODES.CMSG_REPORT_PVP_AFK, buildReportPvpAfk(guid));
  }

  /** Leaving it undefined toggles the flag; passing one sets it. The length is what says which. */
  togglePvp(enable?: boolean): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_TOGGLE_PVP, buildTogglePvp(enable));
  }

  /** The server's clock, which every world-state countdown is measured against. */
  requestWorldStateTime(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_WORLD_STATE_UI_TIMER_UPDATE, buildWorldStateUiTimerQuery());
  }

  /**
   * The server's time in unix seconds, run forward from the last answer.
   *
   * World-state timers carry an absolute end time in the server's terms, so a countdown has to be
   * measured against this rather than against the local clock — the two can differ by minutes, and
   * a battlefield's "battle begins in" would be wrong by exactly that much.
   */
  currentServerTime(now = performance.now()): number | undefined {
    if (this.worldStateTime === undefined) return undefined;
    return this.worldStateTime + Math.floor((now - this.#worldStateTimeReceived) / 1000);
  }

  /** Asking for a team's tabard and record. Two packets come back for this one request. */
  requestArenaTeam(teamId: number): void {
    if (!this.#closed && teamId !== 0) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_QUERY, buildArenaTeamQuery(teamId));
  }

  requestArenaTeamRoster(teamId: number): void {
    if (!this.#closed && teamId !== 0) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_ROSTER, buildArenaTeamRosterQuery(teamId));
  }

  inviteToArenaTeam(teamId: number, name: string): void {
    if (!this.#closed && teamId !== 0 && name) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_INVITE, buildArenaTeamInvite(teamId, name));
  }

  /** Both answers are empty: the server remembers which team the invitation was for. */
  answerArenaTeamInvite(accept: boolean): void {
    if (this.#closed) return;
    this.arenaTeamInvite = undefined;
    if (accept) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_ACCEPT, buildArenaTeamAccept());
    else this.#connection.send(OPCODES.CMSG_ARENA_TEAM_DECLINE, buildArenaTeamDecline());
  }

  leaveArenaTeam(teamId: number): void {
    if (!this.#closed && teamId !== 0) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_LEAVE, buildArenaTeamLeave(teamId));
  }

  removeFromArenaTeam(teamId: number, name: string): void {
    if (!this.#closed && teamId !== 0 && name) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_REMOVE, buildArenaTeamRemove(teamId, name));
  }

  disbandArenaTeam(teamId: number): void {
    if (!this.#closed && teamId !== 0) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_DISBAND, buildArenaTeamDisband(teamId));
  }

  promoteArenaTeamCaptain(teamId: number, name: string): void {
    if (!this.#closed && teamId !== 0 && name) this.#connection.send(OPCODES.CMSG_ARENA_TEAM_LEADER, buildArenaTeamLeader(teamId, name));
  }

  /** Both inspections need the target within interaction range and not attackable. */
  inspectArenaTeams(guid: bigint): void {
    if (!this.#closed && guid !== 0n) this.#connection.send(OPCODES.MSG_INSPECT_ARENA_TEAMS, buildInspectArenaTeams(guid));
  }

  inspectHonor(guid: bigint): void {
    if (!this.#closed && guid !== 0n) this.#connection.send(OPCODES.MSG_INSPECT_HONOR_STATS, buildInspectHonorStats(guid));
  }

  /** Wintergrasp: answering the offer to queue for the battle. */
  answerBattlefieldQueueInvite(battleId: number, accept: boolean): void {
    if (this.#closed) return;
    this.battlefieldQueueInvite = undefined;
    this.#connection.send(OPCODES.CMSG_BATTLEFIELD_MGR_QUEUE_INVITE_RESPONSE, buildBattlefieldQueueInviteResponse(battleId, accept));
  }

  /**
   * Wintergrasp: answering the offer to join the war.
   *
   * Refusing is not a no-op — the server kicks a refuser who is standing in the battle's own zone
   * out of the zone, and there is nothing the client can do to soften that.
   */
  answerBattlefieldWarInvite(battleId: number, accept: boolean): void {
    if (this.#closed) return;
    this.battlefieldWarInvite = undefined;
    this.#connection.send(OPCODES.CMSG_BATTLEFIELD_MGR_ENTRY_INVITE_RESPONSE, buildBattlefieldEntryInviteResponse(battleId, accept));
  }

  /**
   * Wintergrasp: leaving the queue. The only battlefield request a client may start on its own —
   * `CMSG_BATTLEFIELD_MGR_QUEUE_REQUEST` is declared `Handle_NULL`, so a client cannot ask to join
   * one; it can only answer an invitation the server sends first.
   */
  leaveBattlefieldQueue(battleId: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_BATTLEFIELD_MGR_EXIT_REQUEST, buildBattlefieldExitRequest(battleId));
  }

  /**
   * What a creature is. Asked once per entry and kept for the session.
   *
   * This and the four below it are the replacement for the original client's `WDB` files: the same
   * queries, the same answers, held in memory instead of on disk. A miss is remembered too — the
   * server answers a missing row with the entry's top bit set — so a bad entry is asked for once
   * rather than on every frame that draws it.
   */
  creatureTemplate(entry: number, guid = 0n): CreatureTemplate | undefined {
    const known = this.creatureTemplates.get(entry);
    if (known) return known;
    if (this.#closed || entry === 0 || this.#creaturesAsked.has(entry)) return undefined;
    this.#creaturesAsked.add(entry);
    this.#connection.send(OPCODES.CMSG_CREATURE_QUERY, buildCreatureQuery(entry, guid));
    return undefined;
  }

  /** Everything about an item. The one query in this group that carries no guid at all. */
  itemTemplate(entry: number): ItemTemplate | undefined {
    const known = this.itemTemplates.get(entry);
    if (known) return known;
    if (this.#closed || entry === 0 || this.#itemsAsked.has(entry)) return undefined;
    this.#itemsAsked.add(entry);
    this.#connection.send(OPCODES.CMSG_ITEM_QUERY_SINGLE, buildItemQuery(entry));
    return undefined;
  }

  /**
   * The name of an item *set* — what a random-suffix item is titled with.
   *
   * The one query here that answers nothing when the row is missing: no packet at all, not even a
   * missing-bit, so the asked-set is the only record that the question was put.
   */
  itemSetName(entry: number, guid = 0n): ItemSetName | undefined {
    const known = this.itemSetNames.get(entry);
    if (known) return known;
    if (this.#closed || entry === 0 || this.#itemSetsAsked.has(entry)) return undefined;
    this.#itemSetsAsked.add(entry);
    this.#connection.send(OPCODES.CMSG_ITEM_NAME_QUERY, buildItemNameQuery(entry, guid));
    return undefined;
  }

  /**
   * A page of a book or a sign.
   *
   * Asking for one page fetches the whole book: the server walks `NextPageID` itself and sends a
   * packet per page, so the pages after this one arrive without being asked for.
   */
  pageText(pageId: number, guid = 0n): PageText | undefined {
    const known = this.pageTexts.get(pageId);
    if (known) return known;
    if (this.#closed || pageId === 0 || this.#pagesAsked.has(pageId)) return undefined;
    this.#pagesAsked.add(pageId);
    this.#connection.send(OPCODES.CMSG_PAGE_TEXT_QUERY, buildPageTextQuery(pageId, guid));
    return undefined;
  }

  /** The text written inside one particular item — a letter, a scroll. Keyed by guid, not entry. */
  requestItemText(itemGuid: bigint): void {
    if (!this.#closed && itemGuid !== 0n) this.#connection.send(OPCODES.CMSG_ITEM_TEXT_QUERY, buildItemTextQuery(itemGuid));
  }

  /** Asking for one of the eight saved blobs: macros, bindings, the interface layout. */
  requestAccountData(type: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_REQUEST_ACCOUNT_DATA, buildRequestAccountData(type));
  }

  /**
   * Storing one of the eight blobs.
   *
   * The text is deflated here because the server inflates into a buffer of exactly the size it is
   * told — the size is not a hint. An empty string is the erase instruction and travels with no
   * body at all, which is the one case where nothing is compressed.
   */
  async saveAccountData(type: number, text: string, timestamp = Math.floor(Date.now() / 1000)): Promise<void> {
    if (this.#closed) return;
    if (!text) {
      this.accountData.delete(type);
      this.#connection.send(OPCODES.CMSG_UPDATE_ACCOUNT_DATA, buildUpdateAccountData(type, timestamp, 0, new Uint8Array(0)));
      return;
    }
    // The server reads a std::string out of the inflated buffer, so the terminator is part of both
    // the payload and the size it is promised.
    const plain = new PacketWriter().cString(text).toUint8Array();
    const compressed = await deflate(plain);
    this.accountData.set(type, { time: timestamp, text });
    this.#connection.send(OPCODES.CMSG_UPDATE_ACCOUNT_DATA, buildUpdateAccountData(type, timestamp, plain.byteLength, compressed));
  }

  /** Empty. The server answers with the per-character mask once the character is in the world. */
  requestAccountDataTimes(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_READY_FOR_ACCOUNT_DATA_TIMES, buildReadyForAccountDataTimes());
  }

  /** Marks one tutorial tip as seen. Nothing comes back; the eight words arrive at next login. */
  setTutorialSeen(index: number): void {
    if (this.#closed || index < 0 || index >= MAX_ACCOUNT_TUTORIAL_VALUES * 32) return;
    this.#connection.send(OPCODES.CMSG_TUTORIAL_FLAG, buildTutorialFlag(index));
  }

  /** Sets every tutorial bit, or clears them all. Neither is answered. */
  setAllTutorials(seen: boolean): void {
    if (this.#closed) return;
    if (seen) this.#connection.send(OPCODES.CMSG_TUTORIAL_CLEAR, buildTutorialClear());
    else this.#connection.send(OPCODES.CMSG_TUTORIAL_RESET, buildTutorialReset());
  }

  /** The word is echoed straight back, so it can be anything a caller wants to match on. */
  requestRealmSplit(requestId = 0): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_REALM_SPLIT, buildRealmSplit(requestId));
  }

  /** The server's clock and the next daily reset. */
  requestServerTime(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_QUERY_TIME, buildQueryTime());
  }

  /**
   * Unix seconds on the server, run forward from the last answer.
   *
   * Distinct from `currentServerTime`, which comes from the world-state timer: this one is the
   * clock the daily reset and the ticket ages are measured against, and the two are answered by
   * different opcodes at different moments.
   */
  currentQueryTime(now = performance.now()): number | undefined {
    if (!this.serverTime) return undefined;
    return this.serverTime.time + Math.floor((now - this.#serverTimeReceived) / 1000);
  }

  /**
   * Asking to leave the world.
   *
   * The grant is not the end of it — the server sits the character down, counts twenty seconds and
   * then sends `SMSG_LOGOUT_COMPLETE`. `finishLogout` skips what is left of that.
   */
  requestLogout(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_LOGOUT_REQUEST, buildLogoutRequest());
  }

  cancelLogout(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_LOGOUT_CANCEL, buildLogoutCancel());
  }

  /** Only legal after a granted request: the core reads it as "the animation is done", not as one. */
  finishLogout(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_PLAYER_LOGOUT, buildPlayerLogout());
  }

  /** Opening a ticket. The chat log is optional and only read when timestamps travel with it. */
  async createTicket(request: TicketRequest): Promise<void> {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_GMTICKET_CREATE, await buildTicketCreate(request));
  }

  /** Rewriting the open ticket. The message is replaced whole; there is no append. */
  updateTicket(message: string): void {
    if (!this.#closed && message) this.#connection.send(OPCODES.CMSG_GMTICKET_UPDATETEXT, buildTicketUpdate(message));
  }

  abandonTicket(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GMTICKET_DELETETICKET, buildTicketDelete());
  }

  /** The server answers this with the server clock first and the ticket second. */
  requestTicket(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GMTICKET_GETTICKET, buildTicketGet());
  }

  requestTicketSystemStatus(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GMTICKET_SYSTEMSTATUS, buildTicketSystemStatus());
  }

  /** Acknowledging a game master's answer, which closes the ticket. */
  resolveGmResponse(): void {
    if (this.#closed) return;
    this.gmResponse = undefined;
    this.#connection.send(OPCODES.CMSG_GMRESPONSE_RESOLVE, buildGmResponseResolve());
  }

  /**
   * Paying for a haircut.
   *
   * The three style arguments are `BarberShopStyle.dbc` row ids and not the style values
   * themselves; only the colour is raw. A wrong row makes the server drop the packet without any
   * answer at all, which is indistinguishable from the packet never arriving.
   */
  alterAppearance(hairStyleId: number, hairColor: number, facialHairId: number, skinColorId = 0): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_ALTER_APPEARANCE, buildAlterAppearance(hairStyleId, hairColor, facialHairId, skinColorId));
  }

  /** Sales waiting at the auction house. Always an empty list in this core. */
  requestPendingSales(): void {
    if (this.#closed || this.auctioneerGuid === 0n) return;
    this.#connection.send(OPCODES.CMSG_AUCTION_LIST_PENDING_SALES, buildAuctionListPendingSales(this.auctioneerGuid));
  }

  /**
   * Sending on the addon channel.
   *
   * Ordinary chat with `LANG_ADDON` in the language field and the prefix joined to the payload by
   * a tab. The server only accepts it on party, raid, guild, battleground and whisper, and only
   * when the realm has `Addon.Channel` on — where it refuses, it refuses in silence.
   */
  sendAddonMessage(type: number, prefix: string, message: string, target = ""): void {
    if (this.#closed || !prefix) return;
    this.#connection.send(
      OPCODES.CMSG_MESSAGECHAT,
      buildChatMessage(type, LANG_ADDON, buildAddonMessageBody(prefix, message), target),
    );
  }


  startTrade(guid: bigint): void {
    if (!this.#closed && guid !== 0n) this.#connection.send(OPCODES.CMSG_INITIATE_TRADE, buildInitiateTrade(guid));
  }

  /** `tradeSlot` is 0 to 5; slot 6 is the "will not be traded" one. */
  offerTradeItem(tradeSlot: number, bag: number, slot: number): void {
    if (!this.#closed && this.tradeOpen) this.#connection.send(OPCODES.CMSG_SET_TRADE_ITEM, buildSetTradeItem(tradeSlot, bag, slot));
  }

  clearTradeItem(tradeSlot: number): void {
    if (!this.#closed && this.tradeOpen) this.#connection.send(OPCODES.CMSG_CLEAR_TRADE_ITEM, buildClearTradeItem(tradeSlot));
  }

  offerTradeGold(copper: number): void {
    if (!this.#closed && this.tradeOpen) this.#connection.send(OPCODES.CMSG_SET_TRADE_GOLD, buildSetTradeGold(Math.max(0, Math.floor(copper))));
  }

  acceptTrade(): void {
    if (!this.#closed && this.tradeOpen) this.#connection.send(OPCODES.CMSG_ACCEPT_TRADE);
  }

  cancelTrade(): void {
    if (!this.#closed && this.tradeOpen) this.#connection.send(OPCODES.CMSG_CANCEL_TRADE);
    this.#closeTrade();
  }

  #closeTrade(): void {
    this.tradeOpen = false;
    this.tradePartnerGuid = 0n;
    this.tradePartnerAccepted = false;
    this.myOffer = undefined;
    this.theirOffer = undefined;
    this.onTradeChanged?.();
  }

  openAuctionHouse(guid: bigint): void {
    if (this.#closed || guid === 0n) return;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.auctioneerGuid = guid;
    this.#pendingAuctioneerGuid = guid;
    this.auctionMessage = undefined;
    this.#connection.send(OPCODES.MSG_AUCTION_HELLO, buildAuctionHello(guid));
  }

  closeAuctionHouse(): void {
    this.#pendingAuctioneerGuid = 0n;
    this.auctioneerGuid = 0n;
    this.auctions = undefined;
    this.ownAuctions = undefined;
    this.auctionMessage = undefined;
    this.onAuctionChanged?.();
  }

  searchAuctions(search: AuctionSearch = {}): void {
    if (!this.#closed && this.auctioneerGuid !== 0n) {
      this.#connection.send(OPCODES.CMSG_AUCTION_LIST_ITEMS, buildAuctionListItems(this.auctioneerGuid, search));
    }
  }

  listOwnAuctions(page = 0): void {
    if (!this.#closed && this.auctioneerGuid !== 0n) {
      this.#connection.send(OPCODES.CMSG_AUCTION_LIST_OWNER_ITEMS, buildAuctionListOwnerItems(this.auctioneerGuid, page));
    }
  }

  bidOnAuction(auctionId: number, price: number): void {
    if (!this.#closed && this.auctioneerGuid !== 0n && price > 0) {
      this.#connection.send(OPCODES.CMSG_AUCTION_PLACE_BID, buildAuctionPlaceBid(this.auctioneerGuid, auctionId, price));
    }
  }

  cancelAuction(auctionId: number): void {
    if (!this.#closed && this.auctioneerGuid !== 0n) {
      this.#connection.send(OPCODES.CMSG_AUCTION_REMOVE_ITEM, buildAuctionRemoveItem(this.auctioneerGuid, auctionId));
    }
  }

  /** `durationMinutes` must be 720, 1440 or 2880; the server rejects anything else. */
  createAuction(itemGuid: bigint, count: number, startBid: number, buyout: number, durationMinutes: number): void {
    if (this.#closed || this.auctioneerGuid === 0n) return;
    this.#connection.send(
      OPCODES.CMSG_AUCTION_SELL_ITEM,
      buildAuctionSellItem(this.auctioneerGuid, [{ guid: itemGuid, count }], startBid, buyout, durationMinutes),
    );
  }

  joinLfg(roles: number, dungeons: number[], comment = ""): void {
    if (!this.#closed && dungeons.length > 0) this.#connection.send(OPCODES.CMSG_LFG_JOIN, buildLfgJoin(roles, dungeons, comment));
  }

  leaveLfg(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_LFG_LEAVE, buildLfgLeave());
  }

  setLfgRoles(roles: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_LFG_SET_ROLES, buildLfgSetRoles(roles));
  }

  answerLfgProposal(accept: boolean): void {
    const proposal = this.lfgProposal;
    if (this.#closed || !proposal) return;
    this.lfgProposal = undefined;
    this.#connection.send(OPCODES.CMSG_LFG_PROPOSAL_RESULT, buildLfgProposalResult(proposal.proposalId, accept));
    this.onLfgChanged?.();
  }

  teleportToDungeon(toDungeon = true): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_LFG_TELEPORT, buildLfgTeleport(toDungeon));
  }

  requestGuildRoster(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_ROSTER);
  }

  requestGuildInfo(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_INFO);
  }

  queryGuild(guildId: number): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_QUERY, buildGuildQuery(guildId));
  }

  inviteToGuild(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_GUILD_INVITE, buildGuildInviteByName(name));
  }

  answerGuildInvite(accept: boolean): void {
    if (this.#closed || !this.guildInvite) return;
    this.guildInvite = undefined;
    this.#connection.send(accept ? OPCODES.CMSG_GUILD_ACCEPT : OPCODES.CMSG_GUILD_DECLINE);
    this.onGuildChanged?.();
  }

  promoteGuildMember(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_GUILD_PROMOTE, buildGuildPlayerName(name));
  }

  demoteGuildMember(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_GUILD_DEMOTE, buildGuildPlayerName(name));
  }

  removeGuildMember(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_GUILD_REMOVE, buildGuildPlayerName(name));
  }

  setGuildMotd(text: string): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_MOTD, buildGuildMotd(text));
  }

  leaveGuild(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_LEAVE);
  }

  /**
   * One rank's whole permission row, tab rights included.
   *
   * There is no packet for a single flag: the server reads the name, the guild-wide flags, the
   * gold allowance and six tab pairs together, so a rank is always rewritten in one piece.
   */
  setGuildRank(
    rankId: number, flags: number, name: string, withdrawGoldLimit: number,
    tabs: ReadonlyArray<{ rights: number; slots: number }> = [],
  ): void {
    if (this.#closed || !name) return;
    this.#connection.send(OPCODES.CMSG_GUILD_RANK, buildGuildRank(rankId, flags, name, withdrawGoldLimit, tabs));
  }

  addGuildRank(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_GUILD_ADD_RANK, buildGuildAddRank(name));
  }

  /** Always the lowest rank; the packet names none. */
  removeLowestGuildRank(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_DEL_RANK, buildGuildDelRank());
  }

  setGuildMemberNote(name: string, note: string, officer = false): void {
    if (this.#closed || !name) return;
    this.#connection.send(
      officer ? OPCODES.CMSG_GUILD_SET_OFFICER_NOTE : OPCODES.CMSG_GUILD_SET_PUBLIC_NOTE,
      buildGuildMemberNote(name, note));
  }

  /** The long text about the guild, which is not the message of the day. */
  setGuildInfoText(text: string): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_INFO_TEXT, buildGuildInfoText(text));
  }

  setGuildLeader(name: string): void {
    if (!this.#closed && name) this.#connection.send(OPCODES.CMSG_GUILD_LEADER, buildGuildLeader(name));
  }

  disbandGuild(): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_GUILD_DISBAND, buildGuildDisband());
  }

  openMailbox(guid: bigint): void {
    if (this.#closed || guid === 0n) return;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.mailboxGuid = guid;
    this.mailMessage = undefined;
    this.mailResult = undefined;
    this.#connection.send(OPCODES.CMSG_GET_MAIL_LIST, buildGetMailList(guid));
  }

  closeMailbox(): void {
    this.mail = undefined;
    this.mailboxGuid = 0n;
    this.mailMessage = undefined;
    this.mailResult = undefined;
    this.onMailChanged?.();
  }

  sendMail(draft: MailDraft): void {
    if (this.#closed || this.mailboxGuid === 0n || !draft.target) return;
    this.#connection.send(OPCODES.CMSG_SEND_MAIL, buildSendMail(this.mailboxGuid, draft));
  }

  takeMailItem(mailId: number, attachId: number): void {
    if (!this.#closed && this.mailboxGuid !== 0n) this.#connection.send(OPCODES.CMSG_MAIL_TAKE_ITEM, buildMailTakeItem(this.mailboxGuid, mailId, attachId));
  }

  takeMailMoney(mailId: number): void {
    if (!this.#closed && this.mailboxGuid !== 0n) this.#connection.send(OPCODES.CMSG_MAIL_TAKE_MONEY, buildMailTakeMoney(this.mailboxGuid, mailId));
  }

  markMailRead(mailId: number): void {
    if (!this.#closed && this.mailboxGuid !== 0n) this.#connection.send(OPCODES.CMSG_MAIL_MARK_AS_READ, buildMailMarkAsRead(this.mailboxGuid, mailId));
  }

  deleteMail(mailId: number): void {
    if (!this.#closed && this.mailboxGuid !== 0n) this.#connection.send(OPCODES.CMSG_MAIL_DELETE, buildMailDelete(this.mailboxGuid, mailId));
  }

  returnMail(mailId: number, senderGuid: bigint): void {
    if (!this.#closed && this.mailboxGuid !== 0n) this.#connection.send(OPCODES.CMSG_MAIL_RETURN_TO_SENDER, buildMailReturnToSender(this.mailboxGuid, mailId, senderGuid));
  }

  answerDuel(accept: boolean): void {
    const request = this.duelRequest;
    if (this.#closed || !request) return;
    this.duelRequest = undefined;
    this.#connection.send(accept ? OPCODES.CMSG_DUEL_ACCEPTED : OPCODES.CMSG_DUEL_CANCELLED, buildDuelResponse(request.flagGuid));
    this.onDuelChanged?.();
  }

  /**
   * A line the client itself wrote — a reply to a slash command, a refusal, a notice.
   *
   * It goes into the same backlog as anything the server said, because the chat window is redrawn
   * from that backlog whenever a name reply lands: a line that only ever reached the DOM survived
   * until the first `SMSG_NAME_QUERY_RESPONSE` and then vanished.
   */
  pushLocalMessage(message: ChatMessage): void {
    message.at ??= Date.now();
    this.chatLog.push(message);
    if (this.chatLog.length > 500) this.chatLog.splice(0, this.chatLog.length - 500);
    this.events.emit("CHAT_MESSAGE", message);
    this.onChatMessage?.(message);
  }

  /**
   * A line the client itself wrote, into the chat backlog rather than into a status field.
   *
   * The loot roll announcements used to land in `itemMessage`, which is the status line beside
   * the **bags** — so a roll in a dungeon wrote into a window most players never have open, and
   * overwrote whatever the bags were actually trying to say.
   */
  #systemChat(text: string): void {
    this.pushLocalMessage({
      type: CHAT_MSG_SYSTEM, language: 0, senderGuid: 0n, senderName: "", receiverGuid: 0n,
      receiverName: "", channel: "", text, tag: 0, achievementId: 0,
    });
  }

  /** A name and, when the player filled them in at creation, its five Russian cases. */
  #emoteName(guid: bigint, fallback: string): EmoteName {
    const known = this.names.get(guid);
    const name = known ?? (fallback || this.displayName(guid));
    const declined = this.names.declined(guid);
    return declined ? { name, declined } : { name };
  }

  /**
   * What a text emote reads as from this client's seat.
   *
   * Empty when the table has not arrived or the row has no sentence for this point of view —
   * `/sit` is the standing example, a pose the table deliberately leaves wordless.
   */
  emoteLine(emote: TextEmote): string {
    const entry = emoteById(this.emotes, emote.textEmoteId);
    if (!entry) return "";
    const selfGuid = this.state.selfGuid;
    const selfIsEmoter = selfGuid !== undefined && emote.guid === selfGuid;
    const own = this.selfName ?? (selfGuid === undefined ? undefined : this.names.get(selfGuid));
    const selfIsTarget = emote.targetName.length > 0 && emote.targetName === own;
    return emoteSentence(entry, {
      emoter: this.#emoteName(emote.guid, ""),
      target: emote.targetName ? { name: emote.targetName } : undefined,
      selfIsEmoter,
      selfIsTarget,
      variant: emote.emoteNumber,
    });
  }

  /**
   * Writes every emote line in the backlog again.
   *
   * Called when a name lands and when the emote table does: both change what an already-recorded
   * sentence should say, and neither can be handled by redrawing, because the name is baked into
   * the prose rather than sitting in front of it.
   */
  refreshEmoteLines(): void {
    if (!this.emotes) return;
    for (const message of this.chatLog) {
      if (message.emote) message.text = this.emoteLine(message.emote);
    }
  }

  #recordChat(message: ChatMessage): void {
    message.at ??= Date.now();
    // The addon channel is ordinary chat with `LANG_ADDON` in the language field — read signed,
    // that is −1 — and a body split at the first tab into a prefix and a payload. Nothing marks
    // the split but the tab, and nothing but the language marks the message: an addon message on
    // the party channel is a party message the player must never see, so it is republished on its
    // own event and never reaches the chat log.
    if (message.language === (LANG_ADDON | 0) || message.type === CHAT_MSG_ADDON) {
      const body = parseAddonMessageBody(message.text);
      this.events.emit("ADDON_MESSAGE", {
        prefix: body.prefix,
        message: body.message,
        senderGuid: message.senderGuid,
        senderName: message.senderName,
        type: message.type,
      });
      return;
    }
    this.chatLog.push(message);
    if (this.chatLog.length > 500) this.chatLog.splice(0, this.chatLog.length - 500);
    if (!message.senderName) this.requestName(message.senderGuid);
    this.events.emit("CHAT_MESSAGE", message);
    this.onChatMessage?.(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#settleAllGameObjectTemplateWaiters();
    const hadTrainer = this.trainer !== undefined;
    this.#pendingTrainerGuid = undefined;
    if (hadTrainer) {
      this.trainer = undefined;
      this.merchantMessage = undefined;
    }
    this.movementReady = false;
    this.#stopAutoRepeat(false);
    this.#pendingCasts.length = 0;
    this.#locallyStartedCooldowns.clear();
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#connection.close();
    if (hadTrainer) this.onTrainerChanged?.();
  }

  /**
   * Waits for one opcode, and keeps everything that arrives before it.
   *
   * The wait runs before the world loop exists — `loginCharacter` sends `CMSG_PLAYER_LOGIN` and
   * blocks here, and `#readWorld` only starts once this has returned — so for that window this is
   * the only reader the socket has. It used to run each packet through `#handleUtilityPacket` and
   * drop whatever did not match: 85 opcodes of the 514 live ones are named there, so the other 429
   * were thrown away during login.
   *
   * The server sends real work into exactly that window. `Player::LoadFromDB` and
   * `SendDungeonDifficulty` both run before `SMSG_LOGIN_VERIFY_WORLD` is written, and loading a
   * character casts its passives, which sends `SMSG_SET_PROFICIENCY` and
   * `SMSG_SET_PCT_SPELL_MODIFIER`; restoring its power sends `SMSG_POWER_UPDATE`. The measurable
   * loss was the difficulty: a character logging in on heroic read as normal until something
   * happened to send the packet again.
   *
   * Held rather than dispatched here, because dispatching would run `onStateChange` and hand the
   * mover over before the panels that listen for either have been built. `#readWorld` drains the
   * queue first, in arrival order, once there is somebody to hear it.
   */
  async #waitFor(opcode: number): Promise<WorldPacket> {
    for (let ignored = 0; ignored < 2000; ignored++) {
      const packet = await this.#connection.read();
      if (this.#handleUtilityPacket(packet)) continue;
      if (packet.opcode === opcode) return packet;
      this.#deferred.push(packet);
    }
    throw new Error(`Worldserver did not send opcode 0x${opcode.toString(16)}`);
  }

  #startPing(): void {
    this.#pingTimer = setInterval(() => {
      const payload = new PacketWriter().u32(++this.#pingSequence).u32(0).toUint8Array();
      this.#connection.send(OPCODES.CMSG_PING, payload);
    }, 30_000);
  }

  async #readWorld(): Promise<void> {
    // Everything that arrived while the login handshake held the socket, in the order it arrived,
    // before anything new is read.
    const held = this.#deferred.splice(0, this.#deferred.length);
    for (const packet of held) await this.#deliver(packet);
    this.#worldEntered = true;
    while (!this.#closed) {
      const packet = await this.#connection.read();
      if (this.#closed) break;
      await this.#deliver(packet);
    }
  }

  /** One packet through the world loop, and the guarantee that it cannot end the session. */
  async #deliver(packet: WorldPacket): Promise<void> {
    try {
      await this.#dispatch(packet);
    } catch (error) {
      // One packet this client does not model must not end the session. Every parser here
      // throws RangeError on a layout it has not seen — a custom opcode, an unmodelled chat
      // type, a movement flag combination — and without this the read loop exited and the
      // player was disconnected mid-play with no way back.
      this.#recordUnhandled(packet);
      this.onPacketError?.(packet.opcode, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #dispatch(packet: { opcode: number; payload: Uint8Array }): Promise<void> {
    {
      if (packet.opcode === OPCODES.CMSG_EMOTE) {
        // A tswow module talking. Server to client rides `CMSG_EMOTE`'s number — 0x102, chosen
        // because the 3.3.5 client refuses higher ones (`CustomPacketDefines.h:27-31`) — and this
        // core never sends that opcode itself, so every one of these is a custom packet and none of
        // them is an emote. First in the chain rather than inside `#handleUtilityPacket`, because
        // the backlog this world loop drains first is packets that arrived during login: a module
        // message from that window predates every handler a window could have registered, so it
        // goes to the diagnostics log as a login-time drop instead of to a handler that is not
        // there yet.
        if (!this.#worldEntered) {
          this.#recordUnhandled(packet, true);
          return;
        }
        const receipt = this.customPacketBuffer.receive(packet.payload);
        if (receipt.kind === "error") {
          this.onPacketError?.(packet.opcode, new Error(`custom packet ${receipt.error} (${receipt.code})`));
        } else if (receipt.kind === "message") {
          // The registry counts every message, decodes the ones with a schema, keeps the bytes of
          // the ones without, and wraps each subscriber on its own — one module's failure is not
          // the others', and that failure is the ordinary case rather than the exotic one: a JSON
          // schema that has fallen behind its livescript makes `decodeCustom` throw by design.
          // `false` means nothing claimed the inner opcode, which is the only record such a message
          // leaves anywhere else.
          if (!this.customPackets.deliver(receipt.opcode, receipt.body)) this.#recordUnhandled(packet);
        }
        return;
      }
      if (this.#handleUtilityPacket(packet)) return;
      if (await this.#handleMovementControl(packet)) return;

      if (packet.opcode === OPCODES.SMSG_UPDATE_OBJECT) {
        this.state.applyUpdate(packet.payload);
        this.#cancelStaleGameObjectTemplateWaiters();
      } else if (packet.opcode === OPCODES.SMSG_COMPRESSED_UPDATE_OBJECT) {
        this.state.applyUpdate(await decompressObjectUpdate(packet.payload));
        this.#cancelStaleGameObjectTemplateWaiters();
      } else if (packet.opcode === OPCODES.SMSG_DESTROY_OBJECT) {
        const reader = new PacketReader(packet.payload);
        const guid = reader.u64();
        const previousAuras = new Map(this.auras.get(guid));
        this.#cancelGameObjectTemplateWaiters(guid);
        this.state.destroy(guid);
        if (this.auras.delete(guid)) {
          const currentAuras = new Map<number, ActiveAura>();
          const diff = auraDiff(previousAuras, currentAuras);
          this.events.emit("AURA_CHANGED", {
            guid, previous: previousAuras, current: currentAuras, ...diff,
          });
          this.onAurasChanged?.();
        }
        reader.u8();
        reader.assertFinished();
      } else if (MOVEMENT_OPCODES.has(packet.opcode)) {
        const movement = parseMovementPacket(packet.payload);
        this.state.move(movement.guid, movement);
      } else if (packet.opcode === OPCODES.MSG_MOVE_TELEPORT) {
        // Somebody else was moved without travelling. The packet is shaped exactly like an
        // ordinary movement relay, which is what makes it easy to miss: routed through `move` it
        // would be *glided*, and a blink is about twenty yards — comfortably under the smoothing
        // threshold — so the mage would slide across the ground instead of vanishing.
        const movement = parseMovementPacket(packet.payload);
        this.state.teleport(movement.guid, movement);
        if (movement.guid === this.state.selfGuid && this.mapId !== undefined) {
          this.onWorldChanged?.(this.mapId, movement.position);
        }
      } else if (isMovementRelaySpeed(packet.opcode)) {
        // A neighbour's speed changed. The same nine speeds the SMSG_SPLINE_SET_* family carries
        // for server-driven units, and they go into the same store: without them somebody who
        // mounts up keeps running at walking pace on this screen.
        //
        // The movement info is applied first and not for tidiness: `setSpeed` drops a speed for a
        // unit the store has never seen, and this packet can be the first thing that arrives about
        // a player who just came into range.
        const speed = parseMovementRelaySpeed(packet.opcode, packet.payload);
        this.state.move(speed.guid, speed.movement);
        this.state.setSpeed(speed.guid, speed.name, speed.value);
      } else if (packet.opcode === OPCODES.MSG_MOVE_KNOCK_BACK) {
        // The relay of a knock back somebody else already acknowledged — a fact, not an
        // instruction, so there is nothing to answer and the movement info in it is already the
        // post-knock one.
        const knockBack = parseMovementRelayKnockBack(packet.payload);
        this.state.move(knockBack.guid, knockBack.movement);
      } else if (packet.opcode === OPCODES.MSG_MOVE_TIME_SKIPPED) {
        // A neighbour's clock stalled and jumped. It moves nobody: acting on it as a position
        // change would move a player who did not move.
        parseMovementTimeSkipped(packet.payload);
      } else if (packet.opcode === OPCODES.MSG_MOVE_ROOT
        || packet.opcode === OPCODES.MSG_MOVE_UNROOT
        || packet.opcode === OPCODES.MSG_MOVE_SET_COLLISION_HGT
        || packet.opcode === OPCODES.MSG_MOVE_UPDATE_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY) {
        // Declared and never built. Each of these four is named exactly once outside the opcode
        // tables, in the commented-out `//!` mapping table at the top of `MovementPacketSender.h`
        // — the reference scan cannot tell a comment from code, which is why the report calls them
        // live. Rooting somebody else really does reach this client, but through
        // `SMSG_SPLINE_MOVE_ROOT` for a server-driven unit and through the update fields for a
        // player. Named so the ratchet counts them, and not parsed, because there is no sender.
        return;
      } else if (packet.opcode === OPCODES.SMSG_MONSTER_MOVE || packet.opcode === OPCODES.SMSG_MONSTER_MOVE_TRANSPORT) {
        this.state.startSpline(
          parseMonsterMove(packet.payload, packet.opcode === OPCODES.SMSG_MONSTER_MOVE_TRANSPORT),
          performance.now(),
        );
      } else if (this.#handleCharacterProgress(packet)) {
        // handled below
      } else if (this.#handleQuestLog(packet)) {
        // handled below
      } else if (this.#handleSpellLog(packet)) {
        // handled below
      } else if (this.#handleCombat(packet)) {
        // handled below
      } else if (this.#handleGameObject(packet)) {
        // handled below
      } else if (this.#handleWorld(packet)) {
        // handled below
      } else if (this.#handleSocial(packet)) {
        // handled below
      } else if (this.#handlePvp(packet)) {
        // handled below
      } else if (await this.#handleSession(packet)) {
        // handled below
      } else {
        this.#recordUnhandled(packet);
        return;
      }
      this.#activateMover();
      this.#checkTarget();
      this.onStateChange?.(this.state);
    }
  }


  /**
   * The world around the character: weather, banners, flight paths, instances, corpses.
   *
   * Slice P4. Most of it is one packet in and a line of state out, but three of them are a
   * conversation the server is waiting on — a cinematic holds the player's view until it is told
   * the show is over, a movie stalls whatever script is behind it, and a summon offer expires.
   */
  #handleWorld(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_WEATHER) {
      this.weather = parseWeather(packet.payload);
      this.events.emit("WEATHER_CHANGED", this.weather);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_OVERRIDE_LIGHT) {
      // A zone lit by a script rather than by the time of day. Held rather than drawn: which
      // light row wins belongs to the renderer's own tables.
      const next = parseOverrideLight(packet.payload);
      const previous = this.overrideLight;
      this.overrideLightFromId = previous && previous.areaLightId === next.areaLightId
        && previous.overrideLightId > 0 && next.milliseconds > 0
        ? previous.overrideLightId : undefined;
      this.overrideLight = next;
      this.overrideLightReceivedAt = performance.now();
      this.events.emit("WEATHER_CHANGED", this.weather);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AREA_TRIGGER_MESSAGE) {
      this.events.emit("WORLD_MESSAGE", { text: parseAreaTriggerMessage(packet.payload), kind: "banner" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DEFENSE_MESSAGE) {
      const message = parseDefenseMessage(packet.payload);
      this.events.emit("WORLD_MESSAGE", { text: message.text, kind: "defense" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ZONE_UNDER_ATTACK) {
      const areaId = parseZoneUnderAttack(packet.payload);
      this.events.emit("WORLD_MESSAGE", { text: `Зона ${areaId} атакована`, kind: "defense" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TRIGGER_CINEMATIC || packet.opcode === OPCODES.SMSG_TRIGGER_MOVIE) {
      const id = parseCinematicId(packet.payload);
      const movie = packet.opcode === OPCODES.SMSG_TRIGGER_MOVIE;
      // Skipped, deliberately — the plan puts cinematics outside this client. Skipping still has
      // to be said out loud: until the client answers, its view stays bound to the server's
      // camera creature and it cannot see its own character.
      if (movie) this.#connection.send(OPCODES.CMSG_COMPLETE_MOVIE, buildCinematicAck());
      else {
        this.#connection.send(OPCODES.CMSG_NEXT_CINEMATIC_CAMERA, buildCinematicAck());
        this.#connection.send(OPCODES.CMSG_COMPLETE_CINEMATIC, buildCinematicAck());
      }
      this.events.emit("WORLD_MESSAGE", { text: `${movie ? "Ролик" : "Кинематика"} ${id} пропущен${movie ? "" : "а"}`, kind: "system" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_PHASE_SHIFT) {
      this.phaseMask = parsePhaseShift(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DESTRUCTIBLE_BUILDING_DAMAGE) {
      const damage = parseBuildingDamage(packet.payload);
      this.events.emit("BUILDING_DAMAGE", damage);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SUMMON_REQUEST) {
      this.summonRequest = parseSummonRequest(packet.payload);
      this.events.emit("SUMMON_REQUEST", this.summonRequest);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_SHOWTAXINODES) {
      const menu = parseShowTaxiNodes(packet.payload);
      if (menu.guid !== this.#pendingTaxiGuid && menu.guid !== this.#pendingGossipServiceGuid) return true;
      this.#pendingTaxiGuid = 0n;
      this.#consumeGossipService(menu.guid);
      this.#retriedNewTaxiPath = false;
      this.taxiMessage = undefined;
      this.taxiMenu = menu;
      this.events.emit("TAXI_MENU", this.taxiMenu);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TAXINODE_STATUS) {
      const status = parseTaxiNodeStatus(packet.payload);
      // A burst of these arrives at login, one per flight master in view.
      this.taxiNodeStatus.set(status.guid, status.known);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ACTIVATETAXIREPLY) {
      const reply = parseActivateTaxiReply(packet.payload);
      const menu = this.#pendingTaxiActivationMenu;
      if (!menu || this.taxiMenu !== menu) return true;
      this.#pendingTaxiActivationMenu = undefined;
      const guid = menu.guid;
      const text = activateTaxiReplyText(reply);
      this.taxiMessage = { text, error: reply !== TAXI_REPLY_OK };
      if (reply === TAXI_REPLY_OK) this.taxiMenu = undefined;
      this.events.emit("TAXI_CHANGED", { guid, reply });
      this.onCombatStatus?.(text, this.attacking, reply !== TAXI_REPLY_OK);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_NEW_TAXI_PATH) {
      // Empty by design: a node was just discovered, and the status packet that follows says
      // which. Asking for the menu again is what the original client does with it.
      this.events.emit("WORLD_MESSAGE", { text: "Открыт новый маршрут полёта", kind: "system" });
      if (this.#pendingTaxiGuid !== 0n && !this.#retriedNewTaxiPath) {
        this.#retriedNewTaxiPath = true;
        this.#connection.send(OPCODES.CMSG_TAXIQUERYAVAILABLENODES, buildTaxiQuery(this.#pendingTaxiGuid));
      }
      return true;
    }

    if (packet.opcode === OPCODES.MSG_SET_DUNGEON_DIFFICULTY || packet.opcode === OPCODES.MSG_SET_RAID_DIFFICULTY) {
      const difficulty = parseDungeonDifficulty(packet.payload);
      if (packet.opcode === OPCODES.MSG_SET_RAID_DIFFICULTY) this.raidDifficulty = difficulty.difficulty;
      else this.dungeonDifficulty = difficulty.difficulty;
      this.events.emit("INSTANCE_CHANGED", { difficulty: difficulty.difficulty });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INSTANCE_DIFFICULTY) {
      const difficulty = parseInstanceDifficulty(packet.payload);
      this.instanceDifficulty = difficulty.difficulty;
      this.events.emit("INSTANCE_CHANGED", { difficulty: difficulty.difficulty });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_RAID_INSTANCE_INFO) {
      this.lockouts = parseRaidInstanceInfo(packet.payload);
      this.events.emit("INSTANCE_CHANGED", { lockouts: this.lockouts.length });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_RAID_INSTANCE_MESSAGE) {
      const message = parseRaidInstanceMessage(packet.payload);
      this.events.emit("WORLD_MESSAGE", {
        text: message.type === RAID_INSTANCE_WELCOME
          ? `Подземелье ${message.mapId}: сброс через ${Math.round(message.secondsLeft / 60)} мин`
          : `Подземелье ${message.mapId} закроется через ${Math.round(message.secondsLeft / 60)} мин`,
        kind: "system",
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INSTANCE_RESET) {
      this.events.emit("WORLD_MESSAGE", { text: `Подземелье ${parseInstanceMapId(packet.payload)} сброшено`, kind: "system" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INSTANCE_RESET_FAILED) {
      const failure = parseInstanceResetFailed(packet.payload);
      this.events.emit("WORLD_MESSAGE", { text: `Не удалось сбросить подземелье ${failure.mapId}`, kind: "system" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_RESET_FAILED_NOTIFY || packet.opcode === OPCODES.SMSG_UPDATE_LAST_INSTANCE) {
      parseInstanceMapId(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INSTANCE_SAVE_CREATED || packet.opcode === OPCODES.SMSG_UPDATE_INSTANCE_OWNERSHIP) {
      // One word each, and this build hardcodes both: a bind was created, the party owns the
      // instance. Nothing to read, but they are answered for rather than dropped.
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY) {
      const warning = parseInstanceLockWarning(packet.payload);
      this.events.emit("WORLD_MESSAGE", {
        text: `Вход свяжет с подземельем: ответ через ${Math.round(warning.milliseconds / 1000)} с`,
        kind: "system",
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_RAID_GROUP_ONLY) {
      const only = parseRaidGroupOnly(packet.payload);
      this.events.emit("WORLD_MESSAGE", {
        text: only.homebindMilliseconds > 0
          ? `Только для рейда: выход через ${Math.round(only.homebindMilliseconds / 1000)} с`
          : "Только для рейда",
        kind: "system",
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT) {
      this.events.emit("ENCOUNTER_FRAME", parseEncounterFrame(packet.payload));
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_AREA_SPIRIT_HEALER_TIME) {
      const timer = parseAreaSpiritHealerTime(packet.payload);
      this.spiritHealerTimers.set(timer.guid, { milliseconds: timer.milliseconds, receivedAt: performance.now() });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPIRIT_HEALER_CONFIRM) {
      const healer = parseSpiritHealerConfirm(packet.payload);
      this.spiritHealerConfirm = healer;
      this.events.emit("SPIRIT_HEALER_CONFIRM", { guid: healer });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CORPSE_MAP_POSITION_QUERY_RESPONSE) {
      this.corpseMapPosition = parseCorpseMapPosition(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CORPSE_NOT_IN_INSTANCE) {
      this.events.emit("WORLD_MESSAGE", { text: "Тело осталось в подземелье", kind: "system" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_FORCED_DEATH_UPDATE) {
      // Empty, and it means the release timer starts again from here.
      this.events.emit("WORLD_MESSAGE", { text: "Отсчёт освобождения духа сброшен", kind: "system" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CLEAR_FAR_SIGHT_IMMEDIATE
      || packet.opcode === OPCODES.SMSG_MOVE_SET_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY
      || packet.opcode === OPCODES.SMSG_MOVE_UNSET_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY) {
      // Declared and never built. Grepping the whole core for each of these three finds only the
      // enum value and its `STATUS_NEVER` table row — no `WorldPacket` is ever constructed with
      // them, and for the two transition opcodes even the acknowledgement handler that would
      // receive the reply reads its fields and discards them (`MovementHandler.cpp:800`).
      //
      // So there is no layout to write down: anything here would be inferred from the shape of a
      // sibling rather than read off a sender, which is the one thing this client does not do.
      // They are named so the coverage ratchet counts them and so one arriving from somewhere
      // else is a fact in the log rather than a silent drop.
      return true;
    }
    return false;
  }

  /** Asks a flight master for its map of destinations. */
  requestTaxiMenu(guid: bigint): void {
    if (this.#closed) return;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.taxiMenu = undefined;
    this.taxiMessage = undefined;
    this.#pendingTaxiActivationMenu = undefined;
    this.#pendingTaxiGuid = guid;
    this.#retriedNewTaxiPath = false;
    this.#connection.send(OPCODES.CMSG_TAXIQUERYAVAILABLENODES, buildTaxiQuery(guid));
  }

  /** Closes a native flight map and makes any delayed SHOWTAXINODES response stale. */
  closeTaxiMenu(): void {
    this.taxiMenu = undefined;
    this.taxiMessage = undefined;
    this.#pendingTaxiGuid = 0n;
    this.#pendingTaxiActivationMenu = undefined;
    this.#retriedNewTaxiPath = false;
  }

  /** Whether this flight master has anything this character has not discovered yet. */
  requestTaxiNodeStatus(guid: bigint): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_TAXINODE_STATUS_QUERY, buildTaxiNodeStatusQuery(guid));
  }

  /**
   * Takes a flight. One hop uses `CMSG_ACTIVATETAXI`; a route the client plotted itself uses the
   * express form, which is the only way to fly anywhere the map has no direct path to.
   */
  takeTaxi(guid: bigint, nodes: readonly number[]): void {
    const menu = this.taxiMenu;
    if (this.#closed || nodes.length < 2 || menu?.guid !== guid || this.#pendingTaxiActivationMenu === menu) return;
    this.taxiMessage = undefined;
    this.#pendingTaxiActivationMenu = menu;
    if (nodes.length === 2) {
      this.#connection.send(OPCODES.CMSG_ACTIVATETAXI, buildActivateTaxi(guid, nodes[0]!, nodes[1]!));
      return;
    }
    this.#connection.send(OPCODES.CMSG_ACTIVATETAXIEXPRESS, buildActivateTaxiExpress(guid, nodes));
  }

  /** Answers a summon. The guid has to go back byte for byte or the server drops the reply. */
  answerSummon(accept: boolean): void {
    const request = this.summonRequest;
    if (this.#closed || !request) return;
    this.summonRequest = undefined;
    this.#connection.send(OPCODES.CMSG_SUMMON_RESPONSE, buildSummonResponse(request.summoner, accept));
  }

  /** Asks a battleground spirit healer when the next resurrection sweep is, and to be in it. */
  queueForSpiritHealer(healerGuid: bigint): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUERY, buildAreaSpiritHealerRequest(healerGuid));
    this.#connection.send(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUEUE, buildAreaSpiritHealerRequest(healerGuid));
  }

  /** Where the corpse lies on the world map, for one left inside an instance. */
  requestCorpseMapPosition(corpseGuid: bigint): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CORPSE_MAP_POSITION_QUERY, buildCorpseMapPositionQuery(corpseGuid));
  }

  /** Asks for a difficulty. The server answers on the same `MSG_` opcode, or refuses silently. */
  setDifficulty(difficulty: number, raid: boolean): void {
    if (this.#closed) return;
    // Two-way opcodes: the client asks on the same number the server answers on.
    this.#connection.send(raid ? OPCODES.MSG_SET_RAID_DIFFICULTY : OPCODES.MSG_SET_DUNGEON_DIFFICULTY,
      buildSetDifficulty(difficulty));
  }

  /**
   * One custom message to a tswow livescript, in a single fragment.
   *
   * Throws `RangeError` past `CUSTOM_MAX_SEND_BODY` rather than splitting the body: the socket
   * refuses a larger frame by hanging up, and a second fragment would be under the server's
   * 25,000-byte floor and get the player kicked. Throws below `CUSTOM_MIN_SEND_BODY` too — the
   * body is required and may not be empty, because a frame of nothing but its header is what the
   * server calls `NO_HEADER` and kicks for. See `CustomPacket.ts` for all three limits.
   */
  sendCustomPacket(opcode: number, body: Uint8Array): void {
    if (this.#closed) return;
    this.#connection.send(OPCODES.CMSG_CUSTOM, buildCustomPacket(opcode, body));
  }

  /**
   * Listens for one custom opcode's raw bytes. Returns the function that stops listening.
   *
   * The short way to say `world.customPackets.on(opcode, handler)`, kept because it is the pair of
   * `sendCustomPacket` and because a module that reads its own bytes should not have to know that
   * a registry exists.
   */
  onCustomPacket(opcode: number, handler: (body: Uint8Array, opcode: number) => void): () => void {
    return this.customPackets.on(opcode, handler);
  }

  // Dropping these silently hid both the list of missing features and the packet corpus needed
  // to implement them, so every one is counted and the first few payloads are kept.
  #recordUnhandled(packet: WorldPacket, duringLogin = false): void {
    const before = this.unhandledOpcodes.entries.size;
    this.unhandledOpcodes.record(packet, duringLogin);
    if (this.unhandledOpcodes.entries.size !== before) this.onUnhandledOpcodesChanged?.();
  }

  /** The world clock now, run forward from the one packet that reports it. */
  currentGameTime(now = performance.now()): GameTime | undefined {
    return this.gameTime && advanceGameTime(this.gameTime, (now - this.#gameTimeReceived) / 1000);
  }

  #handleUtilityPacket(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_PONG) return true;

    // The three bars the world runs against the character: breath under water, fatigue in the deep
    // ocean, and fire. All three are the server's own reading of the liquid it thinks the character
    // is standing in, so none of them can be computed here — which is why swimming had no breath.
    if (packet.opcode === OPCODES.SMSG_START_MIRROR_TIMER) {
      const timer = parseStartMirrorTimer(packet.payload);
      this.mirrorTimers.set(timer.timer, { timer, receivedAt: performance.now() });
      this.onMirrorTimersChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PAUSE_MIRROR_TIMER) {
      const paused = parsePauseMirrorTimer(packet.payload);
      const held = this.mirrorTimers.get(paused.timer);
      // Paused where it stands, so the bar has to be brought up to now before it stops moving.
      if (held) {
        held.timer = { ...held.timer, value: mirrorTimerRemaining(held.timer, held.receivedAt, performance.now()), paused: paused.paused };
        held.receivedAt = performance.now();
        this.onMirrorTimersChanged?.();
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_STOP_MIRROR_TIMER) {
      if (this.mirrorTimers.delete(parseStopMirrorTimer(packet.payload))) this.onMirrorTimersChanged?.();
      return true;
    }

    // The only packet that says what time of day it is. It arrives once, on entering the world,
    // and the clock runs from it afterwards.
    if (packet.opcode === OPCODES.SMSG_LOGIN_SET_TIME_SPEED) {
      this.gameTime = parseLoginSetTimeSpeed(packet.payload);
      this.#gameTimeReceived = performance.now();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GOSSIP_MESSAGE) {
      const gossip = parseGossipMessage(packet.payload);
      if (this.#pendingGossipGuid === 0n || gossip.guid !== this.#pendingGossipGuid) return true;
      this.#pendingGossipGuid = 0n;
      this.#pendingGossipServiceGuid = 0n;
      this.gossip = gossip;
      this.#connection.send(OPCODES.CMSG_NPC_TEXT_QUERY, buildNpcTextQuery(this.gossip.textId, this.gossip.guid));
      this.onGossipChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_NPC_TEXT_UPDATE) {
      const text = parseNpcText(packet.payload);
      this.npcTexts.set(text.id, text);
      // The query may outlive the gossip page that asked for it. Repainting with no matching page
      // would hide a taxi, battleground or tabard dialog that has since replaced that page.
      if (this.gossip?.textId === text.id) this.onGossipChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_LIST) {
      const questList = parseQuestList(packet.payload);
      if (questList.guid !== this.#pendingQuestGiverGuid
        && questList.guid !== this.#pendingGossipServiceGuid) return true;
      this.#pendingQuestGiverGuid = 0n;
      this.#consumeGossipService(questList.guid);
      this.questList = questList;
      this.#pendingGossipGuid = 0n;
      this.#pendingGossipServiceGuid = 0n;
      this.questDialog = undefined;
      this.questMessage = undefined;
      this.gossip = undefined;
      this.onGossipChanged?.();
      this.onQuestChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUEST_GIVER_QUEST_DETAILS) {
      this.questDialog = parseQuestDetails(packet.payload);
      this.questList = undefined;
      this.questMessage = undefined;
      this.onQuestChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_REQUEST_ITEMS) {
      this.questDialog = parseQuestRequestItems(packet.payload);
      this.questList = undefined;
      this.questMessage = undefined;
      this.onQuestChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUEST_GIVER_OFFER_REWARD_MESSAGE) {
      this.questDialog = parseQuestOfferReward(packet.payload);
      this.questList = undefined;
      this.questMessage = undefined;
      this.onQuestChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_INVALID || packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_FAILED || packet.opcode === OPCODES.SMSG_QUESTLOG_FULL) {
      const reader = new PacketReader(packet.payload);
      const reason = reader.remaining >= 4 ? reader.u32() : 0;
      this.questMessage = { text: packet.opcode === OPCODES.SMSG_QUESTLOG_FULL ? "Журнал заданий заполнен" : `Задание отклонено сервером, код ${reason}`, error: true };
      this.onQuestChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_COMPLETE) {
      const reader = new PacketReader(packet.payload);
      const questId = reader.u32();
      const xp = reader.u32();
      const money = reader.u32();
      reader.u32();
      reader.u32();
      reader.u32();
      reader.assertFinished();
      this.questList = undefined;
      this.questDialog = undefined;
      this.gossip = undefined;
      this.questMessage = { text: `Задание ${questId} выполнено · опыт ${xp} · деньги ${money}`, error: false };
      this.onGossipChanged?.();
      this.onQuestChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GOSSIP_COMPLETE) {
      this.closeGossip();
      if (this.questDialog || this.questList) {
        this.questDialog = undefined;
        this.questList = undefined;
        this.onQuestChanged?.();
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_RESPONSE) {
      this.loot = parseLootResponse(packet.payload);
      this.onLootChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_REMOVED) {
      const slot = parseLootRemoved(packet.payload);
      const taken = this.loot?.slots.find((candidate) => candidate.index === slot);
      if (taken) taken.taken = true;
      this.onLootChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_CLEAR_MONEY) {
      if (this.loot) this.loot.gold = 0;
      this.onLootChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_MONEY_NOTIFY) {
      const notify = parseLootMoneyNotify(packet.payload);
      this.onLootMoney?.(notify.amount, notify.alone);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_RELEASE_RESPONSE) {
      const guid = parseLootReleaseResponse(packet.payload);
      if (this.loot?.guid === guid) this.loot = undefined;
      this.onLootChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.MSG_AUCTION_HELLO) {
      const hello = parseAuctionHello(packet.payload);
      if (hello.auctioneerGuid !== this.#pendingAuctioneerGuid
        && hello.auctioneerGuid !== this.#pendingGossipServiceGuid) return true;
      this.#pendingAuctioneerGuid = 0n;
      this.#consumeGossipService(hello.auctioneerGuid);
      this.auctioneerGuid = hello.auctioneerGuid;
      this.auctionMessage = hello.enabled ? undefined : { text: "Аукцион закрыт", error: true };
      if (hello.enabled) this.searchAuctions();
      this.onAuctionChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AUCTION_LIST_RESULT) {
      this.auctions = parseAuctionListResult(packet.payload);
      this.onAuctionChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AUCTION_OWNER_LIST_RESULT || packet.opcode === OPCODES.SMSG_AUCTION_BIDDER_LIST_RESULT) {
      this.ownAuctions = parseAuctionListResult(packet.payload);
      this.onAuctionChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AUCTION_COMMAND_RESULT) {
      const result = parseAuctionCommandResult(packet.payload);
      this.auctionMessage = result.error === 0
        ? { text: "Готово", error: false }
        : { text: auctionErrorText(result.error), error: true };
      if (result.error === 0 && this.auctioneerGuid !== 0n) this.searchAuctions();
      this.onAuctionChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_JOIN_RESULT) {
      const result = parseLfgJoinResult(packet.payload);
      this.lfgMessage = lfgJoinResultText(result.result);
      this.onLfgChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_QUEUE_STATUS) {
      this.lfgQueue = parseLfgQueueStatus(packet.payload);
      this.onLfgChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_UPDATE_PLAYER || packet.opcode === OPCODES.SMSG_LFG_UPDATE_PARTY) {
      this.lfgStatus = parseLfgUpdate(packet.payload, packet.opcode === OPCODES.SMSG_LFG_UPDATE_PARTY);
      if (!this.lfgStatus.joined) this.lfgQueue = undefined;
      this.onLfgChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_PROPOSAL_UPDATE) {
      this.lfgProposal = parseLfgProposalUpdate(packet.payload);
      this.onLfgChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_ROLE_CHOSEN) {
      parseLfgRoleChosen(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_ROSTER) {
      this.guildRoster = parseGuildRoster(packet.payload);
      for (const member of this.guildRoster.members) {
        this.names.accept({ guid: member.guid, known: true, name: member.name, realm: "", race: 0, gender: member.gender, classId: member.classId, declined: [] });
      }
      this.onGuildChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_QUERY_RESPONSE) {
      this.guildQuery = parseGuildQueryResponse(packet.payload);
      this.onGuildChanged?.();
      if (this.tabardVendorGuid !== 0n) {
        this.events.emit("TABARD_VENDOR_CHANGED", { guid: this.tabardVendorGuid });
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_INFO) {
      this.guildInfo = parseGuildInfo(packet.payload);
      this.onGuildChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_INVITE) {
      this.guildInvite = parseGuildInvite(packet.payload);
      this.onGuildChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_COMMAND_RESULT) {
      const result = parseGuildCommandResult(packet.payload);
      this.guildMessage = result.result === 0 ? undefined : { text: guildErrorText(result.result, result.name), error: true };
      // A successful roster or membership change is easiest to reflect by asking again.
      if (result.result === 0) this.requestGuildRoster();
      this.onGuildChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_EVENT) {
      const event = parseGuildEvent(packet.payload);
      const who = event.params[0] ?? "";
      this.guildMessage = { text: event.type === GE_MOTD ? `Гильдия: ${who}` : `Гильдия · событие ${event.type}${who ? ": " + who : ""}`, error: false };
      this.requestGuildRoster();
      this.onGuildChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_MAIL_LIST_RESULT) {
      this.mail = parseMailListResult(packet.payload);
      for (const entry of this.mail.mails) if (entry.senderGuid !== 0n) this.requestName(entry.senderGuid);
      this.onMailChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SEND_MAIL_RESULT) {
      const result = parseMailCommandResult(packet.payload);
      this.mailResult = result;
      if (result.error !== MAIL_OK) this.mailMessage = { text: mailErrorText(result.error), error: true };
      else {
        const done = result.command === MAIL_ITEM_TAKEN ? "Предмет забран"
          : result.command === MAIL_MONEY_TAKEN ? "Деньги забраны"
          : result.command === MAIL_DELETED ? "Письмо удалено"
          : result.command === MAIL_RETURNED_TO_SENDER ? "Письмо возвращено" : "Письмо отправлено";
        this.mailMessage = { text: done, error: false };
        // Every one of these changes the list, so refresh it rather than patch it locally.
        if (this.mailboxGuid !== 0n) this.#connection.send(OPCODES.CMSG_GET_MAIL_LIST, buildGetMailList(this.mailboxGuid));
      }
      this.onMailChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_RECEIVED_MAIL) {
      parseReceivedMail(packet.payload);
      this.mailMessage = { text: "Вам пришло письмо", error: false };
      this.onMailChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TRADE_STATUS) {
      const info = parseTradeStatus(packet.payload);
      if (info.status === TRADE_STATUS_BEGIN_TRADE) {
        this.tradeOpen = true;
        this.tradePartnerGuid = info.traderGuid;
        this.tradePartnerAccepted = false;
        this.requestName(info.traderGuid);
      } else if (info.status === TRADE_STATUS_OPEN_WINDOW) {
        this.tradeOpen = true;
      } else if (info.status === TRADE_STATUS_TRADE_ACCEPT) {
        this.tradePartnerAccepted = true;
      } else if (info.status === TRADE_STATUS_TRADE_CANCELED || info.status === TRADE_STATUS_TRADE_COMPLETE || info.status === TRADE_STATUS_CLOSE_WINDOW) {
        this.#closeTrade();
      } else {
        this.tradePartnerAccepted = false;
      }
      this.tradeMessage = tradeStatusText(info.status) || undefined;
      this.onTradeChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TRADE_STATUS_EXTENDED) {
      const offer = parseTradeStatusExtended(packet.payload);
      if (offer.traderData) this.theirOffer = offer;
      else this.myOffer = offer;
      this.onTradeChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_REQUESTED) {
      this.duelRequest = parseDuelRequested(packet.payload);
      this.requestName(this.duelRequest.challengerGuid);
      this.onDuelChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_COUNTDOWN) {
      this.duelCountdown = parseDuelCountdown(packet.payload);
      this.onDuelChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_COMPLETE) {
      parseDuelComplete(packet.payload);
      this.duelRequest = undefined;
      this.duelCountdown = 0;
      this.onDuelChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_WINNER) {
      const winner = parseDuelWinner(packet.payload);
      this.groupMessage = {
        text: winner.fled ? `${winner.loser} сбежал, победил ${winner.winner}` : `${winner.winner} побеждает ${winner.loser}`,
        error: false,
      };
      this.onGroupChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_INBOUNDS || packet.opcode === OPCODES.SMSG_DUEL_OUTOFBOUNDS) {
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_LIST) {
      this.group = parseGroupList(packet.payload);
      for (const member of this.group.members) this.names.accept({ guid: member.guid, known: true, name: member.name, realm: "", race: 0, gender: 0, classId: 0, declined: [] });
      this.onGroupChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_INVITE) {
      this.groupInvite = parseGroupInvite(packet.payload);
      this.onGroupChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_DECLINE) {
      this.groupMessage = { text: `${parseGroupDecline(packet.payload)} отклонил приглашение`, error: true };
      this.onGroupChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_DESTROYED || packet.opcode === OPCODES.SMSG_GROUP_UNINVITE) {
      this.group = undefined;
      this.groupMessage = { text: packet.opcode === OPCODES.SMSG_GROUP_UNINVITE ? "Вас исключили из группы" : "Группа распущена", error: false };
      this.onGroupChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PARTY_COMMAND_RESULT) {
      const result = parsePartyCommandResult(packet.payload);
      this.groupMessage = result.result === 0 ? undefined : { text: partyResultText(result.result, result.member), error: true };
      this.onGroupChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_MESSAGECHAT || packet.opcode === OPCODES.SMSG_GM_MESSAGECHAT) {
      this.#recordChat(parseChatMessage(packet.payload, packet.opcode === OPCODES.SMSG_GM_MESSAGECHAT));
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_NAME_QUERY_RESPONSE) {
      if (this.names.accept(parseNameQueryResponse(packet.payload))) {
        // Emote lines are sentences with a name inside them, so they are rewritten here rather
        // than merely redrawn: the renderer has no way to put a name back into finished prose.
        this.refreshEmoteLines();
        this.onNamesChanged?.();
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_EMOTE) {
      const emote = parseEmote(packet.payload);
      this.onEmote?.(emote.guid, emote.emoteId);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TEXT_EMOTE) {
      const emote = parseTextEmote(packet.payload);
      // Keep text emotes distinct from SMSG_EMOTE: the latter is only the animation edge and must
      // never cause a second sound lookup. Audio consumers subscribe to this event exclusively.
      this.events.emit("TEXT_EMOTE", emote);
      this.requestName(emote.guid);
      const message: ChatMessage = {
        type: CHAT_MSG_TEXT_EMOTE, language: 0, senderGuid: emote.guid, senderName: "",
        receiverGuid: 0n, receiverName: emote.targetName, channel: "", text: "", tag: 0,
        achievementId: 0, emote,
      };
      message.text = this.emoteLine(emote);
      this.pushLocalMessage(message);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INVENTORY_CHANGE_FAILURE) {
      const failure = parseInventoryChangeFailure(packet.payload);
      this.itemMessage = failure.result === 0 ? undefined : { text: equipErrorText(failure), error: true };
      this.onItemMessage?.();
      this.events.emit("INVENTORY_CHANGE_FAILURE", failure);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_PUSH_RESULT) {
      const push = parseItemPushResult(packet.payload);
      this.itemMessage = { text: `Получено: предмет ${push.itemId} ×${push.count}`, error: false };
      this.onItemMessage?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LIST_INVENTORY) {
      const vendor = parseListInventory(packet.payload);
      if (vendor.guid !== this.#pendingVendorGuid && vendor.guid !== this.#pendingGossipServiceGuid) return true;
      this.#pendingVendorGuid = 0n;
      this.#consumeGossipService(vendor.guid);
      this.vendor = vendor;
      this.merchantMessage = this.vendor.error === undefined
        ? undefined
        : { text: "У торговца нечего купить", error: true };
      this.onVendorChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BUY_ITEM) {
      const result = parseBuyItem(packet.payload);
      if (!this.vendor || result.guid !== this.vendor.guid) return true;
      const item = this.vendor?.items.find((candidate) => candidate.slot === result.slot);
      if (item && result.leftInStock >= 0) item.leftInStock = result.leftInStock;
      this.merchantMessage = { text: `Куплено: ${result.count} шт.`, error: false };
      this.onVendorChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BUY_FAILED) {
      const failure = parseBuyFailed(packet.payload);
      if (!this.vendor || failure.guid !== this.vendor.guid) return true;
      this.merchantMessage = { text: buyErrorText(failure.error), error: true };
      this.onVendorChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SELL_ITEM) {
      // The server only ever writes this packet from SendSellError, so it always means failure.
      const failure = parseSellItem(packet.payload);
      if (!this.vendor || failure.guid !== this.vendor.guid) return true;
      this.merchantMessage = { text: sellErrorText(failure.error), error: true };
      this.onVendorChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TRAINER_LIST) {
      const trainer = parseTrainerList(packet.payload);
      if (this.#closed || (this.#pendingTrainerGuid !== trainer.guid
        && this.#pendingGossipServiceGuid !== trainer.guid)) return true;
      this.#pendingTrainerGuid = undefined;
      this.#consumeGossipService(trainer.guid);
      this.trainer = trainer;
      this.merchantMessage = undefined;
      this.onTrainerChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TRAINER_BUY_SUCCEEDED) {
      const result = parseTrainerBuySucceeded(packet.payload);
      if (this.#closed || !this.trainer || result.guid !== this.trainer.guid) return true;
      // Refresh the list so the spell flips to "known" and any follow-up rank appears.
      if (this.trainer) this.openTrainer(this.trainer.guid);
      // openTrainer intentionally clears an old interaction message. Publish this result after
      // the refresh request so it remains visible until the replacement list arrives.
      this.merchantMessage = { text: `Изучено заклинание ${result.spellId}`, error: false };
      this.onTrainerChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TRAINER_BUY_FAILED) {
      const result = parseTrainerBuyFailed(packet.payload);
      if (this.#closed || !this.trainer || result.guid !== this.trainer.guid) return true;
      this.merchantMessage = { text: trainerBuyFailureText(result.reason), error: true };
      this.onTrainerChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.MSG_CORPSE_QUERY) {
      this.corpse = parseCorpseQuery(packet.payload);
      this.onDeathChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CORPSE_RECLAIM_DELAY) {
      this.corpseReclaimDelay = parseCorpseReclaimDelay(packet.payload);
      this.corpseReclaimReportedAt = performance.now();
      this.onDeathChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DEATH_RELEASE_LOC) {
      this.deathReleaseLocation = parseDeathReleaseLoc(packet.payload);
      this.onDeathChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_RESURRECT_REQUEST) {
      this.resurrectRequest = parseResurrectRequest(packet.payload);
      this.onDeathChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PRE_RESURRECT || packet.opcode === OPCODES.SMSG_RESURRECT_FAILED) {
      // Nothing to show yet: the state that matters arrives with the following object update.
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELL_GO) {
      const cast = parseSpellGo(packet.payload);
      const selfGuid = this.state.selfGuid;
      const ownCast = selfGuid === undefined || cast.casterUnit === selfGuid || cast.casterGuid === selfGuid;
      if (ownCast) {
        this.#confirmPendingCast(cast.spellId, cast.castId);
        if (this.autoRepeatSpellId === cast.spellId) this.#autoRepeatFailure = undefined;
      }
      this.events.emit("SPELL_GO", cast);
      this.onSpellVisual?.(cast.casterUnit, cast.spellId, cast.hits);
      // A successful non-channel GO is the authoritative end of its cast bar. Channels remain in
      // `casts` until MSG_CHANNEL_UPDATE says zero, because their GO can arrive while the channel
      // is still ticking.
      for (const casterGuid of [cast.casterUnit, cast.casterGuid]) {
        const active = this.casts.get(casterGuid);
        if (active?.spellId === cast.spellId
          && !active.channel
          && (active.castCount === undefined || active.castCount === cast.castId)) {
          this.#endCast(casterGuid, cast.spellId, "success");
          break;
        }
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AURA_UPDATE || packet.opcode === OPCODES.SMSG_AURA_UPDATE_ALL) {
      const update = parseAuraUpdate(packet.payload, packet.opcode === OPCODES.SMSG_AURA_UPDATE_ALL);
      const previousAuras = new Map(this.auras.get(update.guid));
      const auras = applyAuraUpdate(this.auras.get(update.guid), update, performance.now());
      if (auras.size > 0) this.auras.set(update.guid, auras);
      else this.auras.delete(update.guid);
      const currentAuras = new Map(auras);
      const diff = auraDiff(previousAuras, currentAuras);
      this.events.emit("AURA_CHANGED", {
        guid: update.guid, previous: previousAuras, current: currentAuras, ...diff,
      });
      this.onAurasChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INITIAL_SPELLS) {
      const initial = parseInitialSpells(packet.payload);
      this.knownSpells = initial.spells;
      this.initialSpellsReceived = true;
      const now = performance.now();
      this.cooldowns.clear();
      this.cooldownSnapshots.clear();
      this.#pendingCasts.length = 0;
      this.#locallyStartedCooldowns.clear();
      for (const cooldown of initial.cooldowns) {
        const duration = Math.max(cooldown.cooldown, cooldown.categoryCooldown);
        if (duration > 0) {
          this.cooldowns.set(cooldown.spellId, now + duration);
          this.cooldownSnapshots.set(cooldown.spellId, { startedAt: now, duration, endsAt: now + duration });
        }
      }
      this.onSpellsChanged?.(this.knownSpells);
      this.onCooldownsChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CAST_FAILED) {
      const failure = parseCastFailure(packet.payload);
      const pending = this.#rejectPendingCast(failure.spellId, failure.castCount);
      const activeRepeat = this.autoRepeatSpellId === failure.spellId;
      if (activeRepeat) {
        const duplicate = this.#autoRepeatFailure?.spellId === failure.spellId
          && this.#autoRepeatFailure.result === failure.result;
        this.#autoRepeatFailure = { spellId: failure.spellId, result: failure.result };
        // Auto Shot may stay active while the core emits the same background failure every ranged
        // timer. Preserve the first edge (including the request's own failure), suppress only its
        // identical repeats, and leave unmatched manual spell failures untouched.
        if (!pending && duplicate) return true;
      }
      // The words are the realm's own, out of its GlobalStrings; `DONT_REPORT` means say nothing.
      const text = spellFailureText(failure.result);
      if (text) this.onSpellStatus?.(text, true);
      return true;
    }
    // The pet's cooldowns arrive on these same three opcodes, carrying the pet's guid rather than
    // the player's — `SpellHistory` writes `_owner->GetGUID()` and sends it to the owner's session.
    // Letting only the player's guid through, as this used to, discarded every one of them, and a
    // pet bar whose sweep never moves is the visible result.
    if (packet.opcode === OPCODES.SMSG_SPELL_COOLDOWN) {
      const update = parseSpellCooldown(packet.payload);
      const pet = this.#isPetCooldown(update.guid);
      if (pet || this.state.selfGuid === undefined || update.guid === this.state.selfGuid) {
        const target = pet ? this.petCooldowns : this.cooldowns;
        for (const cooldown of update.cooldowns) {
          if (pet) {
            if (cooldown.duration > 0) target.set(cooldown.spellId, performance.now() + cooldown.duration);
            else target.delete(cooldown.spellId);
            continue;
          }
          // A duration-bearing packet is the server's complete answer. It also settles a pending
          // local request, so a rejected cast can never leave the book's speculative timer behind.
          this.#markPendingCooldownAuthoritative(cooldown.spellId);
          if (cooldown.duration > 0) this.#applyCooldown(cooldown.spellId, cooldown.duration, "server", true);
          else this.#clearCooldown(cooldown.spellId);
        }
        if (pet) this.events.emit("PET_COOLDOWNS_CHANGED", {});
        else this.onCooldownsChanged?.();
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_COOLDOWN_EVENT) {
      const event = parseCooldownEvent(packet.payload);
      // This opcode *starts* a cooldown — the core's own comment above it says "send activate
      // cooldown timer" — so it is announced rather than applied: the duration is not on the wire
      // and comes from the spell's own DBC row, exactly as the player's branch below does it.
      if (this.#isPetCooldown(event.guid)) {
        this.events.emit("PET_COOLDOWN_STARTED", { spellId: event.spellId });
      } else if (this.state.selfGuid === undefined || event.guid === this.state.selfGuid) {
        // A duplicate event can arrive after GO (or while the pending request is still waiting
        // for GO). Once an authoritative timer is live, do not move its end forward by packet
        // latency; CLEAR_COOLDOWN/SPELL_COOLDOWN are the explicit ways to replace that state.
        if ((this.cooldowns.get(event.spellId) ?? 0) > performance.now()) {
          this.#locallyStartedCooldowns.delete(event.spellId);
          return true;
        }
        const pending = this.#latestPendingCast(event.spellId);
        // If GO already armed the known local duration, this packet is its confirmation. Do not
        // restart the timer a few milliseconds later and make every cast last packet-latency longer.
        const locallyStarted = this.#locallyStartedCooldowns.get(event.spellId);
        if (locallyStarted !== undefined && locallyStarted > performance.now()) {
          this.#locallyStartedCooldowns.delete(event.spellId);
        } else if (pending?.cooldownDuration !== undefined) {
          pending.cooldownAuthoritative = true;
          this.#applyCooldown(event.spellId, pending.cooldownDuration, "server");
        } else {
          // Keep the request pending for the exact START/GO, but prevent a later GO from
          // falling back to a speculative duration if the callback has no metadata.
          if (pending) pending.cooldownAuthoritative = true;
          this.#handlingServerCooldownEvent = true;
          try {
            this.onCooldownEvent?.(event.spellId);
          } finally {
            this.#handlingServerCooldownEvent = false;
          }
        }
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CLEAR_COOLDOWN) {
      const cleared = parseClearCooldown(packet.payload);
      if (this.#isPetCooldown(cleared.guid)) {
        this.petCooldowns.delete(cleared.spellId);
        this.events.emit("PET_COOLDOWNS_CHANGED", {});
      } else if (this.state.selfGuid === undefined || cleared.guid === this.state.selfGuid) {
        this.#clearCooldown(cleared.spellId);
        this.onCooldownsChanged?.();
      }
      return true;
    }
    if (packet.opcode !== OPCODES.SMSG_TIME_SYNC_REQ) return false;

    const reader = new PacketReader(packet.payload);
    const sequence = reader.u32();
    reader.assertFinished();
    this.#connection.send(
      OPCODES.CMSG_TIME_SYNC_RESP,
      new PacketWriter().u32(sequence).u32(Math.trunc(performance.now()) >>> 0).toUint8Array(),
    );
    return true;
  }

  #activateMover(): void {
    if (this.movementReady || this.#controlAnnounced || this.state.selfGuid === undefined) return;
    this.#connection.send(OPCODES.CMSG_SET_ACTIVE_MOVER, buildCharacterGuid(this.state.selfGuid));
    this.movementReady = true;
    this.onMovementStatus?.(true, this.movementPacketsSent);
  }


  /** Puts an action on a bar slot, or empties the slot when the action is zero. */
  setActionButton(slot: number, action: number, type: number): void {
    this.#connection.send(OPCODES.CMSG_SET_ACTION_BUTTON, buildSetActionButton(slot, action, type));
    const kept = this.actionButtons.filter((button) => button.slot !== slot);
    if (action !== 0) kept.push({ slot, action, type });
    this.actionButtons = kept.sort((left, right) => left.slot - right.slot);
    this.events.emit("ACTION_BUTTONS_CHANGED", {});
  }

  /** How far through a cast a unit is, 0 to 1, or undefined when it is not casting. */
  castProgress(guid: bigint, now = performance.now()): number | undefined {
    const cast = this.casts.get(guid);
    if (!cast) return undefined;
    if (cast.duration <= 0) return cast.channel ? 0 : 1;
    const elapsed = (now - cast.startedAt) / cast.duration;
    const clamped = Math.max(0, Math.min(1, elapsed));
    // A channel empties as it runs; a cast fills.
    return cast.channel ? 1 - clamped : clamped;
  }

  #beginCast(casterGuid: bigint, spellId: number, castTime: number, channel: boolean, castCount?: number): void {
    if (castTime <= 0 && !channel) {
      // An instant cast has no bar to draw, but it still ends whatever was running.
      this.#endCast(casterGuid, spellId, "success", castCount);
      return;
    }
    this.casts.set(casterGuid, {
      spellId,
      startedAt: performance.now(),
      duration: castTime,
      channel,
      ...(castCount === undefined ? {} : { castCount }),
    });
    this.events.emit("SPELL_CAST_START", { casterGuid, spellId, castTime, channel });
  }

  #endCast(
    casterGuid: bigint,
    spellId: number,
    reason: SpellCastStopReason,
    expectedCastCount?: number,
  ): void {
    const cast = this.casts.get(casterGuid);
    if (cast?.castCount !== undefined && expectedCastCount !== undefined && cast.castCount !== expectedCastCount) return;
    this.casts.delete(casterGuid);
    if (cast || reason !== "success") {
      this.events.emit("SPELL_CAST_STOP", {
        casterGuid,
        spellId: cast?.spellId ?? spellId,
        interrupted: reason !== "success",
        reason,
      });
    }
  }

  #spellName(spellId: number): string {
    return `заклинание ${spellId}`;
  }

  /**
   * The spell half of the combat log, plus everything else a cast makes the server announce.
   *
   * Every parser here mirrors one sender in the core; the wording is this client's own, because
   * the strings the original interface uses live in its own locale files and not in the protocol.
   */

  /** Asks what a quest is, once. The answer is cached for as long as the session lasts. */
  queryQuest(questId: number): void {
    if (questId <= 0 || this.questTemplates.has(questId) || this.#questsAsked.has(questId)) return;
    this.#questsAsked.add(questId);
    this.#connection.send(OPCODES.CMSG_QUEST_QUERY, buildQuestInfoQuery(questId));
  }

  /** Asks for the marks to draw over every head in range. */
  requestQuestGiverStatus(): void {
    this.#connection.send(OPCODES.CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY, new Uint8Array());
  }

  /**
   * Drops an aura the player put on themselves. Tracking is turned *off* this way and no other:
   * there is no tracking opcode at all, so turning it on is an ordinary cast and turning it off is
   * this. The body is the spell id and nothing else.
   */
  cancelAura(spellId: number): void {
    if (!this.#closed && spellId > 0) {
      this.#connection.send(OPCODES.CMSG_CANCEL_AURA, new PacketWriter().u32(spellId).toUint8Array());
    }
  }

  /**
   * Asks where the quests in the log want the player to go.
   *
   * Sent in chunks the size of the log itself: the handler reads a count and then
   * that many ids, and a request naming more than the log can hold is dropped **whole** rather than
   * trimmed, so one oversized packet loses every marker rather than the extra ones.
   */
  requestQuestPoi(questIds: readonly number[]): void {
    if (this.#closed) return;
    for (let start = 0; start < questIds.length; start += QUEST_POI_CHUNK) {
      const chunk = questIds.slice(start, start + QUEST_POI_CHUNK);
      if (chunk.length > 0) this.#connection.send(OPCODES.CMSG_QUEST_POI_QUERY, buildQuestPoiQuery(chunk));
    }
  }

  requestCompletedQuests(): void {
    this.#connection.send(OPCODES.CMSG_QUERY_QUESTS_COMPLETED, buildCompletedQuestsQuery());
  }

  /** Gives up a quest, by its slot in the log rather than by its id. */
  abandonQuest(slot: number): void {
    this.#connection.send(OPCODES.CMSG_QUESTLOG_REMOVE_QUEST, buildAbandonQuest(slot));
    this.events.emit("QUEST_LOG_CHANGED", {});
  }

  /** Answers a quest a party member shared. */
  answerSharedQuest(accept: boolean): void {
    const shared = this.sharedQuest;
    if (!shared) return;
    this.sharedQuest = undefined;
    if (accept) this.#connection.send(OPCODES.CMSG_QUEST_CONFIRM_ACCEPT, buildQuestConfirmAccept(shared.questId));
    // 8 is "declined" in the core's own list of push results.
    else this.#connection.send(OPCODES.MSG_QUEST_PUSH_RESULT, buildQuestPushResult(shared.initiatorGuid, 8));
    this.events.emit("QUEST_SHARED", { quest: undefined });
  }

  /**
   * The quest half of the protocol. The log itself is not here — it lives in the character's own
   * update fields, five words a slot — so these are the descriptions and the announcements that a
   * counter moved.
   */

  /** Asks how long this character has been played. */
  requestPlayedTime(): void {
    this.#connection.send(OPCODES.CMSG_PLAYED_TIME, buildPlayedTimeQuery());
  }

  /** Sits down or stands up. `UnitStandStateType` in the core: 0 stands, 1 sits. */
  setStandState(state: number): void {
    this.#connection.send(OPCODES.CMSG_STANDSTATECHANGE, buildStandStateChange(state));
  }

  /** Spends a talent point. The rank is the one to reach, counting from one. */
  /**
   * Taking a glyph out of its slot.
   *
   * There is no "insert": a glyph goes in by using the item, which is an ordinary
   * `CMSG_USE_ITEM`. Only removal has an opcode of its own, and the server answers it with a fresh
   * `SMSG_TALENTS_INFO` rather than with anything about the glyph.
   */
  removeGlyph(slot: number): void {
    if (!this.#closed && slot >= 0 && slot < MAX_GLYPH_SLOTS) {
      this.#connection.send(OPCODES.CMSG_REMOVE_GLYPH, buildRemoveGlyph(slot));
    }
  }

  /**
   * Spending points in the pet's tree.
   *
   * A pet has no `CMSG_LEARN_TALENT` of its own: the only way in is the batch opcode the original
   * client uses for its preview panel, so even a single point is sent as a list of one.
   */
  learnPetTalents(petGuid: bigint, talents: ReadonlyArray<{ talentId: number; rank: number }>): void {
    if (this.#closed || petGuid === 0n || talents.length === 0) return;
    this.#connection.send(OPCODES.CMSG_LEARN_PREVIEW_TALENTS_PET, buildLearnPetTalents(petGuid, talents));
  }

  learnTalent(talentId: number, rank: number): void {
    this.#connection.send(OPCODES.CMSG_LEARN_TALENT, buildLearnTalent(talentId, rank));
  }

  /** Asks to see another character's talents and gear. */
  inspect(guid: bigint): void {
    this.#connection.send(OPCODES.CMSG_INSPECT, buildInspect(guid));
  }

  /** Buys the next bag slot in the bank. Needs the banker whose window is open. */
  buyBankSlot(): void {
    if (this.bankerGuid === undefined) return;
    this.#connection.send(OPCODES.CMSG_BUY_BANK_SLOT, buildBuyBankSlot(this.bankerGuid));
  }

  /**
   * Asks the banker to open the vault. The bank's contents are already here — they arrive in the
   * player's own private update fields — so this is purely permission: the server remembers the
   * guid in `m_currentBankerGUID` and refuses every bank move without it.
   */
  openBank(guid: bigint): void {
    if (this.#closed || !this.state.objects.has(guid)) return;
    this.bankMessage = undefined;
    this.#pendingGossipGuid = 0n;
    this.#pendingGossipServiceGuid = 0n;
    this.#pendingBankerGuid = guid;
    this.#connection.send(OPCODES.CMSG_BANKER_ACTIVATE, buildBankerActivate(guid));
  }

  closeBank(): void {
    const hadBanker = this.bankerGuid !== undefined;
    this.#pendingBankerGuid = undefined;
    if (!hadBanker) return;
    this.bankerGuid = undefined;
    this.bankMessage = undefined;
    this.events.emit("BANK_OPENED", { bankerGuid: undefined });
  }

  /** Moves an item from the bags into the first bank slot that fits. */
  depositToBank(bag: number, slot: number): void {
    if (!this.#closed && this.bankerGuid !== undefined) {
      this.#connection.send(OPCODES.CMSG_AUTOBANK_ITEM, buildAutoBankItem(bag, slot));
    }
  }

  /** Moves an item from the bank into the first bag slot that fits. */
  withdrawFromBank(bag: number, slot: number): void {
    if (!this.#closed && this.bankerGuid !== undefined) {
      this.#connection.send(OPCODES.CMSG_AUTOSTORE_BANK_ITEM, buildAutoStoreBankItem(bag, slot));
    }
  }

  /**
   * Saves the worn equipment as a set. `setGuid` is zero for a new one, and the id comes back in
   * `SMSG_EQUIPMENT_SET_SAVED`; `pieces` holds an item guid per equipment slot, zero to empty the
   * slot and `EQUIPMENT_SET_IGNORED` to leave it alone.
   */
  saveEquipmentSet(setGuid: bigint, index: number, name: string, icon: string, pieces: ReadonlyArray<bigint>): void {
    if (this.#closed || index < 0 || index >= MAX_EQUIPMENT_SETS || !name) return;
    this.#connection.send(OPCODES.CMSG_EQUIPMENT_SET_SAVE, buildEquipmentSetSave(setGuid, index, name, icon, pieces));
    // The server never re-sends the list, so a saved set is folded in here. A new one keeps a zero
    // guid until `SMSG_EQUIPMENT_SET_SAVED` names it, and without a guid it cannot be deleted.
    const existing = this.equipmentSets.find((set) => set.setId === index);
    const saved = { guid: setGuid, setId: index, name, icon, pieces: [...pieces] };
    if (existing) Object.assign(existing, saved);
    else this.equipmentSets = [...this.equipmentSets, saved];
    this.events.emit("CHARACTER_SHEET_CHANGED", {});
  }

  /**
   * Wears a set. The opcode never names it: the client says where each piece is now, so a piece
   * the caller could not find is a slot the server will empty rather than one it will leave alone.
   */
  useEquipmentSet(pieces: ReadonlyArray<{ guid: bigint; bag: number; slot: number }>): void {
    if (!this.#closed) this.#connection.send(OPCODES.CMSG_EQUIPMENT_SET_USE, buildEquipmentSetUse(pieces));
  }

  deleteEquipmentSet(setGuid: bigint): void {
    if (this.#closed || setGuid === 0n) return;
    this.equipmentSets = this.equipmentSets.filter((set) => set.guid !== setGuid);
    this.#connection.send(OPCODES.CMSG_DELETEEQUIPMENT_SET, buildEquipmentSetDelete(setGuid));
    this.events.emit("CHARACTER_SHEET_CHANGED", {});
  }

  /**
   * What the character has become. None of this is in the update fields: reputation, achievements,
   * talents and the bind point each have their own packet, which is why a character sheet built
   * only out of object state can show health and very little else.
   */
  #handleCharacterProgress(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_LEVELUP_INFO) {
      const info = parseLevelUpInfo(packet.payload);
      this.events.emit("LEVEL_UP", info);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LEARNED_SPELL) {
      const spellId = parseLearnedSpell(packet.payload);
      if (!this.knownSpells.some((known) => known.id === spellId)) {
        this.knownSpells = [...this.knownSpells, { id: spellId, slot: this.knownSpells.length }];
        this.onSpellsChanged?.(this.knownSpells);
      }
      this.events.emit("SPELL_LEARNED", { spellId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_REMOVED_SPELL) {
      const spellId = parseRemovedSpell(packet.payload);
      this.knownSpells = this.knownSpells.filter((known) => known.id !== spellId);
      this.onSpellsChanged?.(this.knownSpells);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SUPERCEDED_SPELL) {
      const change = parseSupercededSpell(packet.payload);
      this.knownSpells = this.knownSpells.map((known) => (known.id === change.oldSpell ? { ...known, id: change.newSpell } : known));
      this.onSpellsChanged?.(this.knownSpells);
      this.events.emit("SPELL_LEARNED", { spellId: change.newSpell });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SEND_UNLEARN_SPELLS) {
      parseUnlearnSpells(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BIND_POINT_UPDATE) {
      this.bindPoint = parseBindPoint(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PLAYER_BOUND) {
      parsePlayerBound(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BINDER_CONFIRM || packet.opcode === OPCODES.SMSG_INVALIDATE_PLAYER) {
      parseGuidOnly(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SHOW_BANK) {
      const bankerGuid = parseGuidOnly(packet.payload);
      if (bankerGuid !== this.#pendingBankerGuid && bankerGuid !== this.#pendingGossipServiceGuid) return true;
      this.#pendingBankerGuid = undefined;
      this.#consumeGossipService(bankerGuid);
      this.bankerGuid = bankerGuid;
      this.bankMessage = undefined;
      this.events.emit("BANK_OPENED", { bankerGuid: this.bankerGuid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BUY_BANK_SLOT_RESULT) {
      // The bought slot itself arrives as a field update; this word only says whether it worked.
      const result = parseBuyBankSlotResult(packet.payload);
      this.bankMessage = { text: bankSlotResultText(result), error: result !== BANK_SLOT_OK };
      this.events.emit("BANK_OPENED", { bankerGuid: this.bankerGuid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_STANDSTATE_UPDATE) {
      parseStandState(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PLAYED_TIME) {
      this.playedTime = parsePlayedTime(packet.payload);
      this.events.emit("CHARACTER_SHEET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_PROFICIENCY) {
      parseProficiency(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TITLE_EARNED) {
      const title = parseTitleEarned(packet.payload);
      if (title.earned) this.titles.add(title.maskId);
      else this.titles.delete(title.maskId);
      this.events.emit("CHARACTER_SHEET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_EXPLORATION_EXPERIENCE) {
      const exploration = parseExplorationExperience(packet.payload);
      this.events.emit("EXPLORATION", exploration);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INITIALIZE_FACTIONS) {
      this.factions.clear();
      for (const faction of parseInitialFactions(packet.payload)) this.factions.set(faction.listId, faction);
      this.events.emit("REPUTATION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_FACTION_STANDING) {
      const update = parseFactionStanding(packet.payload);
      for (const standing of update.standings) {
        const existing = this.factions.get(standing.listId);
        this.factions.set(standing.listId, { listId: standing.listId, flags: existing?.flags ?? 0, standing: standing.standing });
      }
      this.events.emit("REPUTATION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_FACTION_VISIBLE) {
      const listId = parseFactionVisible(packet.payload);
      const existing = this.factions.get(listId);
      // Bit 0 of the flags is "visible", which is what makes a faction appear on the sheet.
      this.factions.set(listId, { listId, flags: (existing?.flags ?? 0) | 1, standing: existing?.standing ?? 0 });
      this.events.emit("REPUTATION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_FORCED_REACTIONS) {
      this.forcedReactions.clear();
      for (const reaction of parseForcedReactions(packet.payload)) this.forcedReactions.set(reaction.factionId, reaction.rank);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ACHIEVEMENT_EARNED) {
      const earned = parseAchievementEarned(packet.payload);
      if (earned.playerGuid === this.state.selfGuid) this.achievements.set(earned.achievementId, earned.date);
      this.events.emit("ACHIEVEMENT_EARNED", { achievementId: earned.achievementId, mine: earned.playerGuid === this.state.selfGuid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CRITERIA_UPDATE) {
      const update = parseCriteriaUpdate(packet.payload);
      this.criteria.set(update.criteriaId, update.counter);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ACHIEVEMENT_DELETED) {
      const reader = new PacketReader(packet.payload);
      this.achievements.delete(reader.u32());
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CRITERIA_DELETED) {
      const reader = new PacketReader(packet.payload);
      this.criteria.delete(reader.u32());
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ALL_ACHIEVEMENT_DATA || packet.opcode === OPCODES.SMSG_RESPOND_INSPECT_ACHIEVEMENTS) {
      const inspect = packet.opcode === OPCODES.SMSG_RESPOND_INSPECT_ACHIEVEMENTS;
      const data = parseAchievementData(packet.payload, inspect);
      if (!inspect) {
        this.achievements.clear();
        this.criteria.clear();
        for (const entry of data.completed) this.achievements.set(entry.achievementId, entry.date);
        for (const entry of data.criteria) this.criteria.set(entry.criteriaId, entry.counter);
        this.events.emit("CHARACTER_SHEET_CHANGED", {});
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SERVER_FIRST_ACHIEVEMENT) {
      parseServerFirstAchievement(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TALENTS_INFO) {
      const talents = parseTalentsInfo(packet.payload);
      // A pet's talents share the opcode and are not the character's own. Both are kept: the
      // talent window shows the pet's tree beside the character's, and the packet's leading byte
      // is the only thing that says which of the two just arrived.
      if (talents.pet) this.petTalents = talents;
      else this.talents = talents;
      this.events.emit("TALENTS_CHANGED", { pet: talents.pet });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TALENTS_INVOLUNTARILY_RESET || packet.opcode === OPCODES.MSG_TALENT_WIPE_CONFIRM) {
      this.events.emit("TALENTS_CHANGED", { pet: false });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_INSPECT_TALENT) {
      parseTalentsInfo(packet.payload.slice(0));
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_EQUIPMENT_SET_LIST) {
      this.equipmentSets = parseEquipmentSetList(packet.payload);
      this.events.emit("CHARACTER_SHEET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_EQUIPMENT_SET_SAVED) {
      // The set that was just saved, now with the id it will be deleted and re-saved under. The
      // server does not re-send the list, so the set is folded in here or it stays invisible until
      // the next login.
      const saved = parseEquipmentSetSaved(packet.payload);
      const existing = this.equipmentSets.find((set) => set.setId === saved.setId);
      if (existing) existing.guid = saved.guid;
      this.events.emit("CHARACTER_SHEET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_EQUIPMENT_SET_USE_RESULT) {
      // The core writes a zero here whatever happened, and only documents 4 as "inventory full".
      // It is an inventory failure rather than a character one, so it goes where the bags show it.
      const result = parseEquipmentSetUseResult(packet.payload);
      if (result !== 0) {
        this.itemMessage = { text: "Не удалось надеть набор: инвентарь заполнен", error: true };
        this.onItemMessage?.();
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_TIME_UPDATE) {
      parseItemTimeUpdate(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_ENCHANT_TIME_UPDATE) {
      parseEnchantTimeUpdate(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SOCKET_GEMS_RESULT) {
      const result = parseSocketGems(packet.payload);
      // This packet is authoritative too, and can precede the general object update.
      const item = this.state.objects.get(result.itemGuid);
      for (const [index, enchantment] of result.enchantments.slice(0, 4).entries()) {
        item?.fields.set(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + (index + 2) * 3, enchantment);
      }
      this.events.emit("SOCKET_GEMS_RESULT", result);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_READ_ITEM_OK || packet.opcode === OPCODES.SMSG_READ_ITEM_FAILED) {
      parseGuidOnly(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_REFUND_INFO_RESPONSE || packet.opcode === OPCODES.SMSG_ITEM_REFUND_RESULT) {
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CROSSED_INEBRIATION_THRESHOLD) {
      parseInebriation(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DURABILITY_DAMAGE_DEATH) {
      // Sent empty: dying costs durability, and the amount is in the item fields that follow.
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LEARNED_DANCE_MOVES) {
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PROPOSE_LEVEL_GRANT) {
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_REFER_A_FRIEND_FAILURE) {
      parseReferAFriendFailure(packet.payload);
      return true;
    }
    return false;
  }

  #handleQuestLog(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_QUEST_QUERY_RESPONSE) {
      const template = parseQuestQueryResponse(packet.payload);
      this.questTemplates.set(template.questId, template);
      this.events.emit("QUEST_LOG_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_STATUS) {
      const status = parseQuestGiverStatus(packet.payload);
      this.questGiverStatus.set(status.guid, status.status);
      this.events.emit("QUEST_GIVER_STATUS", { guid: status.guid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_STATUS_MULTIPLE) {
      for (const status of parseQuestGiverStatusMultiple(packet.payload)) {
        this.questGiverStatus.set(status.guid, status.status);
      }
      this.events.emit("QUEST_GIVER_STATUS", { guid: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_ADD_KILL) {
      const update = parseQuestKillUpdate(packet.payload);
      this.events.emit("QUEST_PROGRESS", {
        questId: update.questId, entry: update.entry, count: update.count, required: update.required,
      });
      this.events.emit("QUEST_LOG_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_ADD_ITEM) {
      // The core builds this one empty: the body is commented out in Player::SendQuestUpdateAddItem
      // and the counter arrives through the update fields instead.
      this.events.emit("QUEST_LOG_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_ADD_PVP_KILL) {
      this.events.emit("QUEST_LOG_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_COMPLETE || packet.opcode === OPCODES.SMSG_QUESTUPDATE_FAILEDTIMER) {
      const questId = parseQuestIdUpdate(packet.payload);
      const failed = packet.opcode === OPCODES.SMSG_QUESTUPDATE_FAILEDTIMER;
      this.events.emit("QUEST_FINISHED", { questId, failed });
      this.events.emit("QUEST_LOG_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUEST_CONFIRM_ACCEPT) {
      this.sharedQuest = parseQuestConfirmAccept(packet.payload);
      this.events.emit("QUEST_SHARED", { quest: this.sharedQuest });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_QUEST_PUSH_RESULT) {
      parseQuestPushResult(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUERY_QUESTS_COMPLETED_RESPONSE) {
      this.completedQuests.clear();
      for (const questId of parseCompletedQuests(packet.payload)) this.completedQuests.add(questId);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUEST_POI_QUERY_RESPONSE) {
      // The answer only ever covers quests that are in the log right now, and a quest with no
      // points comes back with an empty list — which is a real answer and is kept as one, or the
      // map asks for it again on every log change forever.
      for (const [questId, blobs] of parseQuestPoi(packet.payload)) this.questPoi.set(questId, blobs);
      this.events.emit("QUEST_POI", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GOSSIP_POI) {
      // The packet says nothing about which map it belongs to, so the map is stamped on here and
      // the marker is dropped when the character changes continent.
      this.gossipPoi = { ...parseGossipPoi(packet.payload), mapId: this.mapId };
      this.events.emit("QUEST_POI", {});
      return true;
    }
    return false;
  }

  #handleSpellLog(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_SPELL_START) {
      const start = parseSpellCastHeader(packet.payload);
      const selfGuid = this.state.selfGuid;
      if (selfGuid === undefined || start.casterUnit === selfGuid || start.casterGuid === selfGuid) {
        this.#acceptPendingCast(start.spellId, start.castId, "start");
      }
      this.#beginCast(start.casterUnit, start.spellId, start.castTime, false, start.castId);
      return true;
    }
    if (packet.opcode === OPCODES.MSG_CHANNEL_START) {
      const start = parseChannelStart(packet.payload);
      this.#beginCast(start.casterGuid, start.spellId, start.duration, true);
      return true;
    }
    if (packet.opcode === OPCODES.MSG_CHANNEL_UPDATE) {
      const update = parseChannelUpdate(packet.payload);
      const cast = this.casts.get(update.casterGuid);
      const spellId = cast?.spellId ?? 0;
      if (update.remaining === 0) {
        // The zero update is the channel's final state and must be observable before the cast
        // stop. Keep the identity captured at CHANNEL_START while the cast is still available.
        this.events.emit("SPELL_CHANNEL_UPDATE", {
          casterGuid: update.casterGuid, spellId, remaining: update.remaining,
        });
        this.#endCast(update.casterGuid, spellId, "success");
      } else if (cast) {
        cast.duration = update.remaining;
        cast.startedAt = performance.now();
        this.events.emit("SPELL_CHANNEL_UPDATE", {
          casterGuid: update.casterGuid, spellId, remaining: update.remaining,
        });
      } else {
        this.events.emit("SPELL_CHANNEL_UPDATE", {
          casterGuid: update.casterGuid, spellId, remaining: update.remaining,
        });
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELL_FAILURE || packet.opcode === OPCODES.SMSG_SPELL_FAILED_OTHER) {
      const failure = parseSpellFailure(packet.payload);
      if (this.state.selfGuid === undefined || failure.casterGuid === this.state.selfGuid) {
        this.#rejectPendingCast(failure.spellId, failure.castCount);
      }
      const active = this.casts.get(failure.casterGuid);
      if (!active || active.spellId === failure.spellId) {
        const reason = failure.result === SPELL_FAILED_INTERRUPTED
          || failure.result === SPELL_FAILED_INTERRUPTED_COMBAT
          ? "interrupted"
          : "failed";
        this.#endCast(failure.casterGuid, failure.spellId, reason, failure.castCount);
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELL_DELAYED) {
      const delayed = parseSpellDelayed(packet.payload);
      const cast = this.casts.get(delayed.casterGuid);
      if (cast) cast.duration += delayed.delay;
      this.events.emit("SPELL_CAST_DELAYED", delayed);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLNONMELEEDAMAGELOG) {
      const log = parseSpellDamageLog(packet.payload);
      const parts = [`${log.damage}`];
      if (log.absorbed > 0) parts.push(`поглощено ${log.absorbed}`);
      if (log.resisted > 0) parts.push(`сопротивление ${log.resisted}`);
      if (log.blocked > 0) parts.push(`блок ${log.blocked}`);
      this.events.emit("COMBAT_LOG", {
        casterGuid: log.casterGuid, targetGuid: log.targetGuid, spellId: log.spellId, critical: log.critical,
        kind: "damage",
        text: `${this.#spellName(log.spellId)}: ${parts.join(", ")}${log.critical ? " (крит)" : ""}`,
      });
      this.events.emit("FLOATING_TEXT", { guid: log.targetGuid, amount: log.damage, kind: "damage", critical: log.critical });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLHEALLOG) {
      const log = parseSpellHealLog(packet.payload);
      const effective = log.amount - log.overheal;
      this.events.emit("COMBAT_LOG", {
        casterGuid: log.casterGuid, targetGuid: log.targetGuid, spellId: log.spellId, critical: log.critical,
        kind: "heal",
        text: `${this.#spellName(log.spellId)}: лечение ${effective}${log.overheal > 0 ? ` (сверх ${log.overheal})` : ""}`,
      });
      this.events.emit("FLOATING_TEXT", { guid: log.targetGuid, amount: effective, kind: "heal", critical: log.critical });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLENERGIZELOG) {
      const log = parseSpellEnergizeLog(packet.payload);
      this.events.emit("FLOATING_TEXT", { guid: log.targetGuid, amount: log.amount, kind: "power", critical: false });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PERIODICAURALOG) {
      const log = parsePeriodicAuraLog(packet.payload);
      const healing = log.auraType === AURA_PERIODIC_HEAL || log.auraType === AURA_OBS_MOD_HEALTH;
      const power = log.auraType === AURA_PERIODIC_ENERGIZE || log.auraType === AURA_OBS_MOD_POWER;
      this.events.emit("FLOATING_TEXT", {
        guid: log.targetGuid, amount: log.amount, critical: log.critical,
        kind: healing ? "heal" : power ? "power" : "damage",
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLLOGMISS) {
      const log = parseSpellMissLog(packet.payload);
      for (const target of log.targets) {
        this.events.emit("FLOATING_TEXT", { guid: target.guid, amount: 0, kind: "miss", critical: false, text: MISS_REASONS[target.missInfo] ?? "промах" });
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLDAMAGESHIELD) {
      const log = parseDamageShieldLog(packet.payload);
      this.events.emit("FLOATING_TEXT", { guid: log.targetGuid, amount: log.damage, kind: "damage", critical: false });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLINSTAKILLLOG) {
      const log = parseInstantKillLog(packet.payload);
      this.events.emit("COMBAT_LOG", {
        ...log, critical: false, kind: "kill", text: `${this.#spellName(log.spellId)}: цель уничтожена`,
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLDISPELLOG || packet.opcode === OPCODES.SMSG_SPELLSTEALLOG) {
      const log = parseDispelLog(packet.payload);
      const stolen = packet.opcode === OPCODES.SMSG_SPELLSTEALLOG;
      for (const entry of log.dispelled) {
        this.events.emit("COMBAT_LOG", {
          casterGuid: log.casterGuid, targetGuid: log.targetGuid, spellId: entry.spellId, critical: false,
          kind: "utility",
          text: `${stolen ? "похищено" : "рассеяно"}: ${this.#spellName(entry.spellId)}`,
        });
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PROCRESIST || packet.opcode === OPCODES.SMSG_SPELLORDAMAGE_IMMUNE) {
      const log = parseSpellLogPair(packet.payload);
      const immune = packet.opcode === OPCODES.SMSG_SPELLORDAMAGE_IMMUNE;
      this.events.emit("FLOATING_TEXT", { guid: log.targetGuid, amount: 0, kind: "miss", critical: false, text: immune ? "иммунитет" : "сопротивление" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DISPEL_FAILED) {
      // Caster, target, then the spells that would not come off. Only the fact is shown.
      const log = parseExecuteLog(packet.payload);
      this.events.emit("COMBAT_LOG", {
        casterGuid: log.casterGuid, targetGuid: 0n, spellId: log.spellId, critical: false,
        kind: "utility", text: "рассеивание не удалось",
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SPELLLOGEXECUTE) {
      parseExecuteLog(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ENCHANTMENTLOG) {
      parseEnchantmentLog(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_MIRRORIMAGE_DATA) {
      parseMirrorImageData(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PLAY_SPELL_VISUAL || packet.opcode === OPCODES.SMSG_PLAY_SPELL_IMPACT) {
      const visual = parseSpellVisualKit(packet.payload);
      this.events.emit("SPELL_VISUAL", { ...visual, impact: packet.opcode === OPCODES.SMSG_PLAY_SPELL_IMPACT });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ACTION_BUTTONS) {
      const buttons = parseActionButtons(packet.payload);
      if (buttons.state !== ACTION_BUTTON_STATE_CLEAR || buttons.buttons.length > 0) this.actionButtons = buttons.buttons;
      else this.actionButtons = [];
      this.events.emit("ACTION_BUTTONS_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_THREAT_UPDATE || packet.opcode === OPCODES.SMSG_HIGHEST_THREAT_UPDATE) {
      const update = parseThreatUpdate(packet.payload, packet.opcode === OPCODES.SMSG_HIGHEST_THREAT_UPDATE);
      this.threat.apply(update);
      this.events.emit("THREAT_CHANGED", { guid: update.guid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_THREAT_REMOVE) {
      const removal = parseThreatRemove(packet.payload);
      this.threat.remove(removal);
      this.events.emit("THREAT_CHANGED", { guid: removal.guid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_THREAT_CLEAR) {
      const guid = parseThreatClear(packet.payload);
      this.threat.clear(guid);
      this.events.emit("THREAT_CHANGED", { guid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_UPDATE_COMBO_POINTS) {
      const combo = parseComboPoints(packet.payload);
      this.comboPoints = combo.points > 0 ? combo : undefined;
      this.events.emit("COMBO_POINTS_CHANGED", combo);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_RESYNC_RUNES) {
      this.runes = parseResyncRunes(packet.payload);
      this.events.emit("RUNES_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CONVERT_RUNE) {
      const converted = parseConvertRune(packet.payload);
      const rune = this.runes[converted.index];
      if (rune) rune.type = converted.type;
      this.events.emit("RUNES_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ADD_RUNE_POWER) {
      const mask = parseAddRunePower(packet.payload);
      for (let index = 0; index < this.runes.length; index++) {
        if (mask & (1 << index)) this.runes[index]!.readiness = 255;
      }
      this.events.emit("RUNES_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_MODIFY_COOLDOWN) {
      const change = parseModifyCooldown(packet.payload);
      if (this.state.selfGuid !== undefined && change.guid !== this.state.selfGuid) return true;
      const cooldown = this.cooldowns.get(change.spellId);
      if (cooldown !== undefined) {
        const end = cooldown + change.delta;
        if (end <= performance.now()) this.#clearCooldown(change.spellId);
        else {
          this.cooldowns.set(change.spellId, end);
          const snapshot = this.cooldownSnapshots.get(change.spellId);
          if (snapshot) this.cooldownSnapshots.set(change.spellId, {
            startedAt: snapshot.startedAt,
            duration: Math.max(0, end - snapshot.startedAt),
            endsAt: end,
          });
        }
      }
      this.onCooldownsChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_COOLDOWN) {
      parseItemCooldown(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CLEAR_TARGET) {
      // The guid in it is the *caster's*, not this player's: `Spell::EffectForceDeselect` writes
      // `unitCaster->GetGUID()` (`SpellEffects.cpp:4314-4317`) and sends it to everyone hostile to
      // that caster. Compared against `selfGuid` the branch could never fire for anybody — a
      // player never receives a packet naming themselves through a hostile deliverer — so
      // SPELL_EFFECT_FORCE_DESELECT did nothing here at all.
      const guid = parseClearTarget(packet.payload);
      if (guid === this.targetGuid) this.selectTarget(undefined);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BREAK_TARGET) {
      // The other half of the same effect, sent three lines earlier (`SpellEffects.cpp:4308-4311`)
      // with the same caster guid, packed rather than full. It was parsed and thrown away, so the
      // *focus* survived a fear or a vanish that took the selection with it. The focus lives in
      // the interface and not in here, hence the announcement.
      //
      // The focus and nothing else, which is what the core's own two comments call this pair:
      // «clear focus» over this packet (`SpellEffects.cpp:4307`) and «and selection» over its
      // sibling (`:4313`). The split is not bookkeeping, because this one has a second sender.
      // `Unit::SendClearTarget` (`Unit.cpp:13413-13418`) broadcasts it with `SendMessageToSet` to
      // everyone in sight rather than to everyone hostile, and `Vehicle.cpp:933` calls it on the
      // passenger every time somebody boards a controllable seat. Dropping the selection here
      // would deselect that passenger for every bystander who had them selected, and put a
      // `CMSG_SET_SELECTION 0` on the wire for each of them. Nothing is lost by leaving it alone:
      // a fear sends `SMSG_CLEAR_TARGET` with the same guid three lines later, and that branch
      // above drops the selection.
      this.events.emit("TARGET_BROKEN", { guid: parseBreakTarget(packet.payload) });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AI_REACTION) {
      this.events.emit("AI_REACTION", parseAiReaction(packet.payload));
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PARTYKILLLOG) {
      this.events.emit("PARTY_KILL", parsePartyKill(packet.payload));
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_FEIGN_DEATH_RESISTED) {
      parseFeignDeathResisted(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_DISMOUNT) {
      // Announced rather than dropped. The state behind it arrives anyway as MOUNTDISPLAYID going
      // to zero, but only this packet says *when*, and a ride that ends has a sound and a camera
      // to go with it. Its sibling `SMSG_MOVE_SET_COLLISION_HGT` is sent in the same breath by
      // `Unit::Dismount` (`Unit.cpp:8750-8756`) and is handled elsewhere.
      this.events.emit("UNIT_DISMOUNTED", { guid: parseDismount(packet.payload) });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_MOUNTSPECIAL_ANIM) {
      // Broadcast to everyone in sight (`MovementHandler.cpp:603-609`) with `self == false`, so
      // the guid is never this player: `MessageDistDeliverer::SendPacket` (`GridNotifiers.h:147-149`)
      // refuses the source. Nothing in the update fields carries the trick either.
      this.events.emit("MOUNT_SPECIAL", { guid: parseMountSpecial(packet.payload) });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_PROJECTILE_POSITION) {
      parseProjectilePosition(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_POWER_UPDATE) {
      // The same number the update fields carry, sent early. Writing it into the object keeps the
      // one reader — a panel asks the unit for its power and does not care which packet moved it.
      const update = parsePowerUpdate(packet.payload);
      if (update.powerType < 7) this.state.setField(update.guid, UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + update.powerType, update.value);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CANCEL_AUTO_REPEAT) {
      // Ranged auto-repeat is a spell container, not the melee swing controlled by `attacking`.
      // Keep that state intact and publish the stop edge for UI/state consumers. The packet's guid
      // is packed (`WorldPackets::Combat::CancelAutoRepeat`).
      const guid = parseCancelAutoRepeat(packet.payload);
      // The server already cancelled the repeat; acknowledge only in local state and return the
      // visible weapon pose to neutral (or melee in a defensive inconsistent-state recovery).
      if (guid === this.state.selfGuid) this.#stopAutoRepeat(false, true);
      this.events.emit("STOP_AUTOREPEAT_SPELL", { guid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_FLAT_SPELL_MODIFIER || packet.opcode === OPCODES.SMSG_SET_PCT_SPELL_MODIFIER) {
      parseSpellModifier(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TOTEM_CREATED) {
      parseTotemCreated(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_MOUNT_RESULT) {
      // Always a refusal: `Spell::SendMountResult` (`Spell.cpp:4391-4406`) returns without writing
      // when the result is `MountResult::Ok`, which is 10 rather than 0 (`SharedDefines.h:3813-3826`).
      this.events.emit("MOUNT_RESULT", { result: parseMountResult(packet.payload) });
      return true;
    }
    return false;
  }

  /**
   * Everybody else: the raid, the loot rolls, the guild bank, the calendar, the chat channels, the
   * friends list, the charters and the rest of the dungeon finder.
   *
   * Slice P5. Two things run through the whole of it. Names arrive far more often than guids do —
   * `SMSG_GROUP_SET_LEADER` carries a name and no guid at all, and `/who` carries no guid anywhere
   * — so what can be looked up is asked for and what cannot is kept as written. And the loot rolls
   * are keyed by their slot rather than by the item guid they nominally carry, because the core
   * fills that guid in only on the three auto-pass broadcasts and leaves it empty everywhere else.
   */
  #handleSocial(packet: WorldPacket): boolean {
    if (this.#handleParty(packet)) return true;
    if (this.#handlePets(packet)) return true;
    if (this.#handleLootRolls(packet)) return true;
    if (this.#handleGuildBank(packet)) return true;
    if (this.#handleCalendar(packet)) return true;
    if (this.#handleChannels(packet)) return true;
    if (this.#handleContacts(packet)) return true;
    if (this.#handlePetitions(packet)) return true;
    if (this.#handleDungeonFinder(packet)) return true;
    return false;
  }

  /**
   * The pet, the stable and riding something.
   *
   * Slice P6. The bar is the whole of it: ten fixed words that are commands, spells and reaction
   * modes at once, and everything else in the slice either fills that bar in or answers a button
   * pressed on it. Three pet opcodes the core declares are never built — the pet mode, the
   * renameable flag and the pet guid list — but only the last is named here, because it is the only
   * one the coverage report counts as live: its sole mention outside the opcode tables is a
   * comment, and the reference scan cannot tell a comment from code.
   */
  #handlePets(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_PET_SPELLS) {
      const spells = parsePetSpells(packet.payload);
      if (spells.closed) {
        // A bare zero guid is how the server says the pet is gone; there is no other signal.
        this.petSpells = undefined;
        this.petCooldowns.clear();
        this.petComboPoints = undefined;
      } else {
        this.petSpells = spells;
        this.petCooldowns.clear();
        const now = performance.now();
        for (const cooldown of spells.cooldowns) {
          const left = petCooldownRemaining(cooldown);
          if (left > 0) this.petCooldowns.set(cooldown.spellId, now + left);
        }
      }
      this.events.emit("PET_BAR_CHANGED", { guid: spells.closed ? 0n : spells.guid });
      this.events.emit("PET_COOLDOWNS_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_LEARNED_SPELL) {
      // A fresh bar follows this one, so the book is not patched here — it would be overwritten.
      parsePetLearnedSpell(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_UNLEARNED_SPELL) {
      const spellId = parsePetUnlearnedSpell(packet.payload);
      if (this.petSpells) {
        this.petSpells.spells = this.petSpells.spells.filter((entry) => entry.spellId !== spellId);
      }
      this.petCooldowns.delete(spellId);
      this.events.emit("PET_BAR_CHANGED", { guid: this.petSpells?.guid ?? 0n });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_UPDATE_COMBO_POINTS) {
      const combo = parsePetComboPoints(packet.payload);
      this.petComboPoints = combo.points > 0 ? combo : undefined;
      // The holder comes first and the target second. `COMBO_POINTS_CHANGED` already means the
      // target everywhere else — the player's own packet carries nothing but that — so the second
      // guid is the one republished; the holder stays in `petComboPoints` for whoever wants it.
      this.events.emit("COMBO_POINTS_CHANGED", { guid: combo.targetGuid, points: combo.points });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_ACTION_FEEDBACK) {
      // No guid: it belongs to whichever pet is out.
      this.#recordPetMessage(petFeedbackText(parsePetActionFeedback(packet.payload)), true);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_ACTION_SOUND) {
      // Only a summoned pet ever talks, and only about one time in ten; the sound itself is P8's.
      parsePetActionSound(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_CAST_FAILED) {
      const failure = parsePetCastFailed(packet.payload);
      this.#recordPetMessage(`Питомец не смог применить заклинание ${failure.spellId} (код ${failure.result})`, true);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_TAME_FAILURE) {
      this.#recordPetMessage(petTameFailureText(parsePetTameFailure(packet.payload)), true);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_NAME_QUERY_RESPONSE) {
      const name = parsePetNameQueryResponse(packet.payload);
      this.petNames.set(name.petNumber, name);
      this.events.emit("PET_NAME_CHANGED", { petNumber: name.petNumber });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_NAME_INVALID) {
      const rejected = parsePetNameInvalid(packet.payload);
      this.#recordPetMessage(petNameErrorText(rejected.error), true);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PET_GUIDS) {
      // Declared and never built: the only mention outside the opcode tables is a comment in
      // `SendInitialPacketsBeforeAddToMap`, which is also why the coverage report calls it live.
      // Named so the ratchet counts it, and not parsed, because there is no sender to read.
      return true;
    }

    if (packet.opcode === OPCODES.MSG_LIST_STABLED_PETS) {
      const stable = parseStableList(packet.payload);
      if (stable.npcGuid !== this.#pendingStableMasterGuid
        && stable.npcGuid !== this.#pendingGossipServiceGuid) return true;
      this.#pendingStableMasterGuid = 0n;
      this.#consumeGossipService(stable.npcGuid);
      this.stable = stable;
      this.stableMasterGuid = stable.npcGuid;
      this.events.emit("STABLE_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_STABLE_RESULT) {
      const result = parseStableResult(packet.payload);
      this.stableMessage = { text: stableResultText(result), error: !isStableSuccess(result) };
      // Success brings no fresh roster, so the list is asked for again rather than guessed at.
      if (isStableSuccess(result) && this.stableMasterGuid !== 0n) this.requestStable(this.stableMasterGuid);
      this.events.emit("STABLE_CHANGED", {});
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_PLAYER_VEHICLE_DATA) {
      const data = parsePlayerVehicleData(packet.payload);
      // A zero id is the message: this unit stopped being a vehicle.
      if (data.vehicleId === 0) this.vehicleKits.delete(data.guid);
      else this.vehicleKits.set(data.guid, data.vehicleId);
      this.events.emit("VEHICLE_CHANGED", data);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ON_CANCEL_EXPECTED_RIDE_VEHICLE_AURA) {
      // Empty body: stop waiting for the aura that would have seated the player.
      parseCancelExpectedRideVehicleAura(packet.payload);
      return true;
    }
    return false;
  }

  /**
   * Battlegrounds, arenas, the outdoor battlefield and the numbered variables all four of them
   * publish.
   *
   * Slice P7. Three of these packets are told apart by their length rather than by anything in
   * them: a queue slot going free, an arena team event that names somebody, and a group's failure
   * to queue. The core writes the optional tail only when it is non-zero and puts no marker on the
   * wire saying it did, so each of those parsers reads what is left rather than a flag.
   *
   * World states live here because that is where the plan put them, but they are not PvP: every
   * zone publishes them, and a boss's remaining pylons arrives on the same two opcodes as a
   * battleground's flag count. The context is kept beside them for exactly that reason.
   */
  #handlePvp(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_BATTLEFIELD_STATUS) {
      const status = parseBattlefieldStatus(packet.payload);
      if (status.cleared) this.battlefieldQueues.delete(status.queueSlot);
      else this.battlefieldQueues.set(status.queueSlot, status);
      this.events.emit("BATTLEFIELD_QUEUE_CHANGED", {
        queueSlot: status.queueSlot, status: status.status, cleared: status.cleared,
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BATTLEFIELD_LIST) {
      const list = parseBattlefieldList(packet.payload);
      if (list.fromWhere === 0) {
        if (list.battlemasterGuid !== this.#pendingBattlemasterGuid
          && list.battlemasterGuid !== this.#pendingGossipServiceGuid) return true;
        this.#pendingBattlemasterGuid = 0n;
        this.#consumeGossipService(list.battlemasterGuid);
      }
      this.battlefieldList = list;
      this.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: this.battlefieldList.bgTypeId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_JOINED_BATTLEGROUND) {
      const joined = parseGroupJoinedBattleground(packet.payload);
      this.#recordPvpMessage(battlegroundJoinResultText(joined.result), isBattlegroundJoinFailure(joined.result));
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BATTLEGROUND_PLAYER_JOINED || packet.opcode === OPCODES.SMSG_BATTLEGROUND_PLAYER_LEFT) {
      const guid = parseBattlegroundPlayer(packet.payload);
      const joined = packet.opcode === OPCODES.SMSG_BATTLEGROUND_PLAYER_JOINED;
      if (joined) this.battlegroundPlayers.add(guid);
      else this.battlegroundPlayers.delete(guid);
      // The packet carries a guid and nothing else, so the name has to be asked for separately.
      this.requestName(guid);
      // `SendPacketToTeam(team, &data, player, false)`: the player's own side, and not the player
      // who moved. So this set is arrivals and departures on one team since this client joined —
      // never a roster. The roster is the scoreboard, which arrives on entry and at the end.
      this.events.emit("BATTLEGROUND_PLAYER_CHANGED", { guid, joined });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_BATTLEGROUND_PLAYER_POSITIONS) {
      const positions = parseBattlegroundPlayerPositions(packet.payload);
      this.flagCarriers = [...positions.players, ...positions.carriers];
      this.events.emit("FLAG_CARRIERS_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_PVP_LOG_DATA) {
      this.pvpScores = parsePvpLogData(packet.payload);
      this.events.emit("PVP_SCOREBOARD_CHANGED", { ended: this.pvpScores.ended });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PVP_CREDIT) {
      const credit = parsePvpCredit(packet.payload);
      this.lastHonorKill = credit;
      this.honorThisSession += credit.honor;
      this.events.emit("HONOR_AWARDED", credit);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ARENA_UNIT_DESTROYED) {
      // An arena-only hint that arrives just before SMSG_DESTROY_OBJECT for the same guid. Acting
      // on it would take the unit down a frame early and leave the real destroy nothing to remove.
      parseArenaUnitDestroyed(packet.payload);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_INIT_WORLD_STATES) {
      const init = parseInitWorldStates(packet.payload);
      this.worldStateContext = { mapId: init.mapId, zoneId: init.zoneId, areaId: init.areaId };
      this.worldStates.clear();
      for (const state of init.states) this.worldStates.set(state.variableId, state.value);
      this.events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_UPDATE_WORLD_STATE) {
      const state = parseUpdateWorldState(packet.payload);
      this.worldStates.set(state.variableId, state.value);
      this.events.emit("WORLD_STATE_CHANGED", { variableId: state.variableId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_WORLD_STATE_UI_TIMER_UPDATE) {
      this.worldStateTime = parseWorldStateUiTimer(packet.payload);
      this.#worldStateTimeReceived = performance.now();
      this.events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_ARENA_TEAM_QUERY_RESPONSE) {
      const info = parseArenaTeamQueryResponse(packet.payload);
      this.arenaTeams.set(info.teamId, info);
      this.events.emit("ARENA_TEAM_CHANGED", { teamId: info.teamId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ARENA_TEAM_STATS) {
      const stats = parseArenaTeamStats(packet.payload);
      this.arenaTeamStats.set(stats.teamId, stats);
      this.events.emit("ARENA_TEAM_CHANGED", { teamId: stats.teamId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ARENA_TEAM_ROSTER) {
      const roster = parseArenaTeamRoster(packet.payload);
      this.arenaTeamRosters.set(roster.teamId, roster);
      this.events.emit("ARENA_TEAM_CHANGED", { teamId: roster.teamId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ARENA_TEAM_INVITE) {
      this.arenaTeamInvite = parseArenaTeamInvite(packet.payload);
      this.events.emit("ARENA_TEAM_CHANGED", { teamId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ARENA_TEAM_EVENT) {
      const event = parseArenaTeamEvent(packet.payload);
      this.#recordPvpMessage(arenaTeamEventText(event), false);
      // A disband names the team by name and never by id — no arena packet but the three queries
      // carries an id at all — so the held team is found by the name in the event and dropped.
      // Nothing replaces it: a team that stopped existing must not go on being shown.
      if (event.event === ARENA_TEAM_EVENT_DISBANDED) this.#forgetArenaTeam(event.strings[1] ?? "");
      this.events.emit("ARENA_TEAM_CHANGED", { teamId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ARENA_TEAM_COMMAND_RESULT) {
      this.#recordPvpMessage(arenaTeamCommandResultText(parseArenaTeamCommandResult(packet.payload)), true);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ARENA_ERROR) {
      this.#recordPvpMessage(arenaErrorText(parseArenaError(packet.payload)), true);
      return true;
    }
    if (packet.opcode === OPCODES.MSG_INSPECT_ARENA_TEAMS) {
      const team = parseInspectArenaTeams(packet.payload);
      // One packet per team the inspected player is on, so up to three arrive for one request and
      // only the slot inside tells them apart. The slot is replaced rather than appended, or a
      // second inspection would double the list.
      const teams = (this.inspectedArenaTeams.get(team.guid) ?? []).filter((held) => held.slot !== team.slot);
      teams.push(team);
      teams.sort((left, right) => left.slot - right.slot);
      this.inspectedArenaTeams.set(team.guid, teams);
      this.events.emit("PVP_INSPECTION", { guid: team.guid });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_INSPECT_HONOR_STATS) {
      const stats = parseInspectHonorStats(packet.payload);
      this.inspectedHonor.set(stats.guid, stats);
      this.events.emit("PVP_INSPECTION", { guid: stats.guid });
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_BATTLEFIELD_MGR_QUEUE_INVITE) {
      this.battlefieldQueueInvite = parseBattlefieldQueueInvite(packet.payload);
      this.events.emit("BATTLEFIELD_CHANGED", { battleId: this.battlefieldQueueInvite.battleId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BATTLEFIELD_MGR_QUEUE_REQUEST_RESPONSE) {
      const response = parseBattlefieldQueueResponse(packet.payload);
      if (response.queued) this.battlefieldQueueInvite = undefined;
      this.#recordPvpMessage(
        response.queued ? "Вы в очереди на битву" : response.hasRoom ? "В очередь встать не удалось" : "Битва заполнена",
        !response.queued,
      );
      this.events.emit("BATTLEFIELD_CHANGED", { battleId: response.battleId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BATTLEFIELD_MGR_ENTRY_INVITE) {
      this.battlefieldWarInvite = parseBattlefieldEntryInvite(packet.payload);
      this.events.emit("BATTLEFIELD_CHANGED", { battleId: this.battlefieldWarInvite.battleId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BATTLEFIELD_MGR_ENTERED) {
      const entered = parseBattlefieldEntered(packet.payload);
      this.battlefieldBattleId = entered.battleId;
      this.battlefieldWarInvite = undefined;
      this.battlefieldQueueInvite = undefined;
      this.events.emit("BATTLEFIELD_CHANGED", { battleId: entered.battleId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BATTLEFIELD_MGR_EJECTED) {
      const ejected = parseBattlefieldEjected(packet.payload);
      this.battlefieldBattleId = 0;
      this.battlefieldWarInvite = undefined;
      this.battlefieldQueueInvite = undefined;
      this.#recordPvpMessage(battlefieldLeaveReasonText(ejected.reason), true);
      this.events.emit("BATTLEFIELD_CHANGED", { battleId: ejected.battleId });
      return true;
    }
    return false;
  }

  /**
   * The session itself: what the account remembers, what the realm announces, what a query
   * answers, the ticket window, the barber's chair and the sounds.
   *
   * Slice P8. Two threads run through it. The account blobs and the addon block are deflate on the
   * wire in both directions, which is why this handler is the only asynchronous one — inflating is
   * a stream here, not a call. And the five query answers are the replacement for the original
   * client's `WDB` cache: they are asked for once, kept for the session, and thrown away when
   * `SMSG_CLIENTCACHE_VERSION` says the realm's data moved, which is the one job that packet has.
   */
  async #handleSession(packet: WorldPacket): Promise<boolean> {
    if (packet.opcode === OPCODES.SMSG_ACCOUNT_DATA_TIMES) {
      this.accountDataTimes = parseAccountDataTimes(packet.payload);
      this.events.emit("ACCOUNT_DATA_CHANGED", { type: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_UPDATE_ACCOUNT_DATA) {
      const blob = parseUpdateAccountData(packet.payload);
      if (blob.decompressedSize === 0) this.accountData.delete(blob.type);
      else {
        const plain = await inflate(blob.compressed, blob.decompressedSize);
        // The stored value is a C string: the server wrote it out of a std::string and the
        // terminator travels with it, so the last byte is dropped rather than kept as a NUL.
        const end = plain.indexOf(0) < 0 ? plain.byteLength : plain.indexOf(0);
        this.accountData.set(blob.type, { time: blob.time, text: TEXT_DECODER.decode(plain.subarray(0, end)) });
      }
      this.events.emit("ACCOUNT_DATA_CHANGED", { type: blob.type });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_UPDATE_ACCOUNT_DATA_COMPLETE) {
      this.events.emit("ACCOUNT_DATA_CHANGED", { type: parseUpdateAccountDataComplete(packet.payload) });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TUTORIAL_FLAGS) {
      this.tutorialFlags = parseTutorialFlags(packet.payload);
      this.events.emit("TUTORIALS_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_FEATURE_SYSTEM_STATUS) {
      this.featureStatus = parseFeatureSystemStatus(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CLIENTCACHE_VERSION) {
      const version = parseClientCacheVersion(packet.payload);
      // The whole point of this packet: the realm's static data changed, so anything cached from a
      // query is stale. Dropping the maps costs a few packets and removes the entire class of bug
      // the original client's WDB files are famous for.
      if (version !== this.clientCacheVersion) this.#clearQueryCache();
      this.clientCacheVersion = version;
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_REALM_SPLIT) {
      this.realmSplit = parseRealmSplit(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_QUERY_TIME_RESPONSE) {
      this.serverTime = parseQueryTimeResponse(packet.payload);
      this.#serverTimeReceived = performance.now();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_MOTD) {
      this.motd = parseMotd(packet.payload);
      for (const line of this.motd) this.events.emit("SESSION_MESSAGE", { text: line, kind: "motd" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_NOTIFICATION) {
      this.notification = parseNotification(packet.payload);
      this.events.emit("SESSION_MESSAGE", { text: this.notification, kind: "notification" });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHAT_SERVER_MESSAGE) {
      this.events.emit("SESSION_MESSAGE", {
        text: chatServerMessageText(parseChatServerMessage(packet.payload)), kind: "server",
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SET_PLAYER_DECLINED_NAMES_RESULT) {
      const result = parseDeclinedNamesResult(packet.payload);
      this.serviceMessage = {
        text: result.result === 0 ? "Склонения имени приняты" : "Склонения имени отклонены",
        error: result.result !== 0,
      };
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ADDON_INFO) {
      // Readable only because the count comes from what this client declared: the packet carries
      // none of its own.
      this.addonInfo = parseAddonInfo(packet.payload, this.#declaredAddons);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_WARDEN_DATA) {
      // RC4 over a key derived from the session key. Answering wrongly is worse than not
      // answering — the server kicks on a bad response and waits on a missing one — so the bytes
      // are counted and dropped. This realm has Warden off, so this should never run.
      parseWardenData(packet.payload);
      this.wardenPackets++;
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_LOGOUT_RESPONSE) {
      const response = parseLogoutResponse(packet.payload);
      this.logout = response;
      // A granted logout is not the end: the countdown runs on the server and SMSG_LOGOUT_COMPLETE
      // is what ends the session. Treating a zero result as "we are out" leaves twenty seconds of
      // world running behind a logged-out interface.
      this.events.emit("LOGOUT_CHANGED", { pending: response.result === 0, complete: false });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOGOUT_COMPLETE) {
      parseEmptySessionPacket(packet.payload);
      this.loggedOut = true;
      this.logout = undefined;
      this.events.emit("LOGOUT_CHANGED", { pending: false, complete: true });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOGOUT_CANCEL_ACK) {
      parseEmptySessionPacket(packet.payload);
      this.logout = undefined;
      this.events.emit("LOGOUT_CHANGED", { pending: false, complete: false });
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_CREATURE_QUERY_RESPONSE) {
      const template = parseCreatureQueryResponse(packet.payload);
      this.creatureTemplates.set(template.entry, template);
      this.events.emit("QUERY_CACHE_CHANGED", { kind: "creature", id: template.entry });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_QUERY_SINGLE_RESPONSE) {
      const template = parseItemQueryResponse(packet.payload);
      this.itemTemplates.set(template.entry, template);
      this.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: template.entry });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_NAME_QUERY_RESPONSE) {
      const name = parseItemNameQueryResponse(packet.payload);
      this.itemSetNames.set(name.entry, name);
      this.events.emit("QUERY_CACHE_CHANGED", { kind: "itemSet", id: name.entry });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ITEM_TEXT_QUERY_RESPONSE) {
      const text = parseItemTextQueryResponse(packet.payload);
      if (text.guid !== 0n) this.itemTexts.set(text.guid, text.text);
      this.events.emit("QUERY_CACHE_CHANGED", { kind: "itemText", id: text.guid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PAGE_TEXT_QUERY_RESPONSE) {
      const page = parsePageTextQueryResponse(packet.payload);
      this.pageTexts.set(page.pageId, page);
      // The server walks the chain itself and sends one packet per page, so the rest of the book
      // arrives unasked; marking each as asked stops a re-request when the reader turns the page.
      this.#pagesAsked.add(page.pageId);
      this.events.emit("QUERY_CACHE_CHANGED", { kind: "page", id: page.pageId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GAMEOBJECT_PAGETEXT) {
      const guid = parseGameObjectPageText(packet.payload);
      this.openPageObject = guid;
      // The packet names no page. Which page this object holds is in its template, so opening a
      // sign is three round trips deep: this, then the template, then the page text itself.
      const entry = this.state.objects.get(guid)?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
      if (entry !== 0) this.gameObjectTemplate(entry, guid);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_GMTICKET_GETTICKET) {
      const ticket = parseGmTicket(packet.payload);
      this.gmTicket = ticket.status === GMTICKET_STATUS_HASTEXT ? ticket : undefined;
      this.events.emit("GM_TICKET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GMTICKET_CREATE
      || packet.opcode === OPCODES.SMSG_GMTICKET_UPDATETEXT
      || packet.opcode === OPCODES.SMSG_GMTICKET_DELETETICKET) {
      const response = parseTicketResponse(packet.payload);
      this.ticketMessage = { text: ticketResponseText(response), error: !isTicketSuccess(response) };
      if (packet.opcode === OPCODES.SMSG_GMTICKET_DELETETICKET) this.gmTicket = undefined;
      this.events.emit("GM_TICKET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GMTICKET_SYSTEMSTATUS) {
      this.ticketsEnabled = parseTicketSystemStatus(packet.payload) === GMTICKET_QUEUE_STATUS_ENABLED;
      this.events.emit("GM_TICKET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GMRESPONSE_RECEIVED) {
      this.gmResponse = parseGmResponse(packet.payload);
      this.events.emit("GM_TICKET_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GMRESPONSE_STATUS_UPDATE) {
      this.ticketSurveyPending = parseGmResponseStatusUpdate(packet.payload);
      this.gmResponse = undefined;
      this.events.emit("GM_TICKET_CHANGED", {});
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_ENABLE_BARBER_SHOP) {
      parseEnableBarberShop(packet.payload);
      this.barberShopOpen = true;
      this.events.emit("BARBER_SHOP", { open: true });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_BARBER_SHOP_RESULT) {
      const result = parseBarberShopResult(packet.payload);
      this.serviceMessage = { text: barberShopResultText(result), error: result !== BARBER_SHOP_RESULT_SUCCESS };
      // Success stands the character up, which closes the window; a refusal leaves it open.
      if (result === BARBER_SHOP_RESULT_SUCCESS) this.barberShopOpen = false;
      this.events.emit("CHARACTER_SERVICE", { kind: "barber", result });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHAR_RENAME
      || packet.opcode === OPCODES.SMSG_CHAR_CUSTOMIZE
      || packet.opcode === OPCODES.SMSG_CHAR_FACTION_CHANGE) {
      const kind = packet.opcode === OPCODES.SMSG_CHAR_RENAME ? "rename"
        : packet.opcode === OPCODES.SMSG_CHAR_CUSTOMIZE ? "customize" : "factionChange";
      const result = parseCharacterServiceResult(packet.payload, kind);
      this.characterService = result;
      this.events.emit("CHARACTER_SERVICE", { kind, result: result.result });
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_PLAY_SOUND || packet.opcode === OPCODES.SMSG_PLAY_MUSIC) {
      this.lastSound = parsePlaySound(packet.payload, packet.opcode === OPCODES.SMSG_PLAY_MUSIC);
      this.events.emit("PLAY_SOUND", this.lastSound);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PLAY_OBJECT_SOUND) {
      this.lastSound = parsePlayObjectSound(packet.payload);
      this.events.emit("PLAY_SOUND", this.lastSound);
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_FISH_ESCAPED || packet.opcode === OPCODES.SMSG_FISH_NOT_HOOKED) {
      parseFishingFailure(packet.payload);
      this.events.emit("SESSION_MESSAGE", {
        text: packet.opcode === OPCODES.SMSG_FISH_ESCAPED ? "Рыба сорвалась" : "Рыба ещё не клюнула",
        kind: "notification",
      });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_SHOW_MAILBOX) {
      const mailboxGuid = parseShowMailbox(packet.payload);
      if (mailboxGuid !== this.#pendingGossipServiceGuid) return true;
      this.#consumeGossipService(mailboxGuid);
      this.mailboxGuid = mailboxGuid;
      this.mailMessage = undefined;
      this.#connection.send(OPCODES.CMSG_GET_MAIL_LIST, buildGetMailList(mailboxGuid));
      this.onMailChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION) {
      const notification = parseAuctionBidderNotification(packet.payload);
      // One packet for "you won" and "you were outbid": the only difference is whether the bidder
      // is the player, so the wording has to be decided here rather than in the parser.
      const mine = this.controlledGuid !== undefined && notification.bidderGuid === this.controlledGuid;
      this.auctionMessage = {
        text: mine ? `Лот ${notification.auctionId} выигран за ${notification.bidSum}` : `Вашу ставку на лот ${notification.auctionId} перебили`,
        error: !mine,
      };
      this.onAuctionChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AUCTION_OWNER_NOTIFICATION) {
      const sold = parseAuctionOwnerNotification(packet.payload);
      this.auctionMessage = { text: `Ваш лот ${sold.auctionId} продан за ${sold.bid}`, error: false };
      this.onAuctionChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_AUCTION_LIST_PENDING_SALES) {
      // Always zero in this core: the loop that would fill it is commented out.
      parseAuctionListPendingSales(packet.payload);
      return true;
    }
    return false;
  }

  #clearQueryCache(): void {
    this.creatureTemplates.clear();
    this.itemTemplates.clear();
    this.itemSetNames.clear();
    this.pageTexts.clear();
    this.itemTexts.clear();
    this.#creaturesAsked.clear();
    this.#itemsAsked.clear();
    this.#itemSetsAsked.clear();
    this.#pagesAsked.clear();
    // Said out loud, because this cache is no longer the only place a query answer ends up: the
    // creature and item metadata clients keep the answers over the top of the gateway's dumps, and
    // an asked-set that is cleared here while theirs is not means the entries this packet just
    // invalidated are never asked for again.
    this.events.emit("QUERY_CACHE_CHANGED", { kind: "cleared", id: 0 });
  }

  /** Drops a team by name, which is all a disband event gives to identify it by. */
  #forgetArenaTeam(name: string): void {
    if (!name) return;
    for (const [teamId, info] of this.arenaTeams) {
      if (info.name !== name) continue;
      this.arenaTeams.delete(teamId);
      this.arenaTeamStats.delete(teamId);
      this.arenaTeamRosters.delete(teamId);
    }
  }

  #recordPvpMessage(text: string, error: boolean): void {
    this.pvpMessage = { text, error };
    this.events.emit("PVP_MESSAGE", { text, error });
  }

  #recordPetMessage(text: string, error: boolean): void {
    this.petMessage = { text, error };
    this.events.emit("PET_MESSAGE", { text, error });
  }

  /**
   * Whether a cooldown packet is about the pet rather than the player. Both arrive on the same
   * three opcodes and are told apart only by the guid inside, which is the pet's own — so a filter
   * that only lets the player's guid through drops every pet cooldown there is.
   */
  #isPetCooldown(guid: bigint): boolean {
    return guid !== 0n && this.petSpells !== undefined && guid === this.petSpells.guid;
  }

  #handleParty(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_PARTY_MEMBER_STATS || packet.opcode === OPCODES.SMSG_PARTY_MEMBER_STATS_FULL) {
      const stats = parsePartyMemberStats(packet.payload, packet.opcode === OPCODES.SMSG_PARTY_MEMBER_STATS_FULL);
      this.partyStats.set(stats.guid, mergePartyMemberStats(this.partyStats.get(stats.guid), stats));
      this.events.emit("PARTY_MEMBER_STATS", { guid: stats.guid });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_SET_LEADER) {
      const name = parseGroupSetLeader(packet.payload);
      // The packet names the new leader and nothing else, so the group list is matched by name.
      const member = this.group?.members.find((candidate) => candidate.name === name);
      if (this.group && member) this.group.leaderGuid = member.guid;
      this.groupMessage = { text: `${name} теперь лидер группы`, error: false };
      this.onGroupChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_REAL_GROUP_UPDATE) {
      // How big the party is behind a battleground or dungeon-finder group. Held rather than shown.
      this.realGroup = parseRealGroupUpdate(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.MSG_RAID_READY_CHECK) {
      const initiatorGuid = parseReadyCheckStart(packet.payload);
      this.readyCheck = { initiatorGuid, startedAt: performance.now(), answers: new Map() };
      this.requestName(initiatorGuid);
      this.events.emit("READY_CHECK", { initiatorGuid });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_RAID_READY_CHECK_CONFIRM) {
      // The answers come back on their own opcode, and the server answers for everyone offline the
      // moment the check starts — so these usually arrive before any person has pressed anything.
      const answer = parseReadyCheckAnswer(packet.payload);
      this.readyCheck?.answers.set(answer.guid, answer.ready);
      this.events.emit("READY_CHECK", { initiatorGuid: this.readyCheck?.initiatorGuid, answeredGuid: answer.guid });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_RAID_READY_CHECK_FINISHED) {
      this.readyCheck = undefined;
      this.events.emit("READY_CHECK", { initiatorGuid: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_RAID_TARGET_UPDATE) {
      const update: RaidTargetUpdate = parseRaidTargetUpdate(packet.payload);
      if (update.whole) {
        this.raidTargets.clear();
        for (const entry of update.icons) this.raidTargets.set(entry.icon, entry.guid);
        this.events.emit("RAID_TARGET_UPDATE", { icon: undefined });
        return true;
      }
      const entry = update.icons[0]!;
      // A zero target is how the server clears a marker, including the clearing packet it sends
      // before moving one that was already in use.
      if (entry.guid === 0n) this.raidTargets.delete(entry.icon);
      else this.raidTargets.set(entry.icon, entry.guid);
      this.events.emit("RAID_TARGET_UPDATE", { icon: entry.icon });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_MINIMAP_PING) {
      this.events.emit("MINIMAP_PING", parseMinimapPing(packet.payload));
      return true;
    }
    if (packet.opcode === OPCODES.MSG_RANDOM_ROLL) {
      const roll = parseRandomRoll(packet.payload);
      const name = this.names.get(roll.rollerGuid);
      if (!name) this.requestName(roll.rollerGuid);
      this.groupMessage = {
        text: `${name || "Игрок"} выбрасывает ${roll.result} (${roll.minimum}-${roll.maximum})`,
        error: false,
      };
      this.onGroupChanged?.();
      return true;
    }
    return false;
  }

  #handleLootRolls(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_LOOT_START_ROLL) {
      const start = parseLootStartRoll(packet.payload);
      this.lootRolls.set(start.itemSlot, { start, startedAt: Date.now(), votes: [] });
      this.events.emit("LOOT_ROLL_CHANGED", { itemSlot: start.itemSlot });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_ROLL) {
      const vote = parseLootRoll(packet.payload);
      const roll = this.lootRolls.get(vote.itemSlot);
      if (roll) roll.votes.push(vote);
      const name = this.names.get(vote.playerGuid);
      if (!name) this.requestName(vote.playerGuid);
      this.#systemChat(lootRollText(vote, name ?? ""));
      this.events.emit("LOOT_ROLL_CHANGED", { itemSlot: vote.itemSlot });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_ROLL_WON) {
      const won = parseLootRollWon(packet.payload);
      const roll = this.lootRolls.get(won.itemSlot);
      if (roll) roll.won = won;
      const name = this.names.get(won.winnerGuid);
      if (!name) this.requestName(won.winnerGuid);
      this.#systemChat(`${name || "Игрок"} выигрывает предмет ${won.itemId} с броском ${won.rollNumber}`);
      this.events.emit("LOOT_ROLL_CHANGED", { itemSlot: won.itemSlot });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_ALL_PASSED) {
      const passed = parseLootAllPassed(packet.payload);
      const roll = this.lootRolls.get(passed.itemSlot);
      if (roll) roll.passed = true;
      this.#systemChat(`Все пропустили предмет ${passed.itemId}`);
      this.events.emit("LOOT_ROLL_CHANGED", { itemSlot: passed.itemSlot });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_MASTER_LIST) {
      this.masterLootCandidates = parseLootMasterList(packet.payload);
      for (const guid of this.masterLootCandidates) this.requestName(guid);
      this.events.emit("LOOT_ROLL_CHANGED", { itemSlot: undefined });
      this.onLootChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOOT_LIST) {
      this.lootOwners = parseLootList(packet.payload);
      this.onLootChanged?.();
      return true;
    }
    return false;
  }

  #handleGuildBank(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_GUILD_BANK_LIST) {
      const list = parseGuildBankList(packet.payload);
      // An incremental update names only the slots that moved, so it is folded into what is held
      // rather than replacing it; a full refresh of the same tab is the replacement.
      const held = this.guildBank;
      if (!held || list.fullUpdate || held.tabId !== list.tabId) {
        this.guildBank = list;
      } else {
        held.money = list.money;
        held.withdrawalsRemaining = list.withdrawalsRemaining;
        for (const item of list.items) {
          const index = held.items.findIndex((candidate) => candidate.slot === item.slot);
          if (item.itemId === 0) {
            if (index >= 0) held.items.splice(index, 1);
          } else if (index >= 0) {
            held.items[index] = item;
          } else {
            held.items.push(item);
          }
        }
      }
      this.events.emit("GUILD_BANK_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_GUILD_BANK_LOG_QUERY) {
      this.guildBankLog = parseGuildBankLog(packet.payload);
      for (const entry of this.guildBankLog.entries) this.requestName(entry.playerGuid);
      this.events.emit("GUILD_BANK_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_GUILD_EVENT_LOG_QUERY) {
      this.guildEventLog = parseGuildEventLog(packet.payload);
      for (const entry of this.guildEventLog) {
        this.requestName(entry.playerGuid);
        if (entry.otherGuid !== 0n) this.requestName(entry.otherGuid);
      }
      this.onGuildChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.MSG_GUILD_PERMISSIONS) {
      this.guildPermissions = parseGuildPermissions(packet.payload);
      this.events.emit("GUILD_BANK_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_GUILD_BANK_MONEY_WITHDRAWN) {
      this.guildBankWithdrawRemaining = parseGuildBankMoneyWithdrawn(packet.payload);
      this.events.emit("GUILD_BANK_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_QUERY_GUILD_BANK_TEXT) {
      // Also arrives unasked: setting a tab's text broadcasts this to the whole guild.
      const text = parseGuildBankTabText(packet.payload);
      this.guildBankTabText.set(text.tabId, text.text);
      this.events.emit("GUILD_BANK_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_SAVE_GUILD_EMBLEM) {
      if (this.#pendingTabardSaveGuid === 0n || this.#pendingTabardSaveGuid !== this.tabardVendorGuid) return true;
      this.#pendingTabardSaveGuid = 0n;
      const error = parseSaveGuildEmblem(packet.payload);
      this.tabardMessage = { text: guildEmblemErrorText(error), error: error !== 0 };
      this.events.emit("TABARD_VENDOR_CHANGED", { guid: this.tabardVendorGuid });
      return true;
    }
    if (packet.opcode === OPCODES.MSG_TABARDVENDOR_ACTIVATE) {
      const guid = parseTabardVendorActivate(packet.payload);
      if (guid !== this.#pendingTabardVendorGuid && guid !== this.#pendingGossipServiceGuid) return true;
      this.#pendingTabardVendorGuid = 0n;
      this.#consumeGossipService(guid);
      this.tabardVendorGuid = guid;
      this.tabardMessage = undefined;
      this.#pendingTabardSaveGuid = 0n;
      this.events.emit("TABARD_VENDOR_CHANGED", { guid: this.tabardVendorGuid });
      return true;
    }
    return false;
  }

  #handleCalendar(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_CALENDAR_SEND_CALENDAR) {
      this.calendar = parseCalendarSnapshot(packet.payload);
      for (const invite of this.calendar.invites) this.requestName(invite.inviterGuid);
      for (const event of this.calendar.events) this.requestName(event.ownerGuid);
      this.events.emit("CALENDAR_CHANGED", { eventId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_SEND_EVENT) {
      this.calendarEvent = parseCalendarEvent(packet.payload);
      this.requestName(this.calendarEvent.ownerGuid);
      for (const invite of this.calendarEvent.invites) this.requestName(invite.guid);
      this.events.emit("CALENDAR_CHANGED", { eventId: this.calendarEvent.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_SEND_NUM_PENDING) {
      this.calendarPending = parseCalendarPendingCount(packet.payload);
      this.events.emit("CALENDAR_CHANGED", { eventId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_COMMAND_RESULT) {
      const result = parseCalendarCommandResult(packet.payload);
      this.calendarMessage = result.result === 0
        ? undefined
        : { text: calendarErrorText(result.result) + (result.name ? `: ${result.name}` : ""), error: true };
      this.events.emit("CALENDAR_CHANGED", { eventId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_ARENA_TEAM || packet.opcode === OPCODES.SMSG_CALENDAR_FILTER_GUILD) {
      // The same class with the opcode chosen by a flag: who could be mass-invited to an event.
      for (const invite of parseCalendarInitialInvites(packet.payload)) this.requestName(invite.guid);
      this.events.emit("CALENDAR_CHANGED", { eventId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_INVITE) {
      const invite = parseCalendarInviteAdded(packet.payload);
      this.requestName(invite.inviteeGuid);
      this.events.emit("CALENDAR_CHANGED", { eventId: invite.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_INVITE_ALERT) {
      const alert = parseCalendarInviteAlert(packet.payload);
      this.requestName(alert.invitedByGuid);
      this.calendarPending += 1;
      this.events.emit("CALENDAR_CHANGED", { eventId: alert.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_INVITE_REMOVED) {
      const removed = parseCalendarInviteRemoved(packet.payload);
      this.events.emit("CALENDAR_CHANGED", { eventId: removed.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_INVITE_REMOVED_ALERT) {
      const alert = parseCalendarEventStatusAlert(packet.payload);
      this.events.emit("CALENDAR_CHANGED", { eventId: alert.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_STATUS) {
      const status = parseCalendarEventStatus(packet.payload);
      this.events.emit("CALENDAR_CHANGED", { eventId: status.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_MODERATOR_STATUS_ALERT) {
      const status = parseCalendarModeratorStatus(packet.payload);
      this.events.emit("CALENDAR_CHANGED", { eventId: status.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_UPDATED_ALERT) {
      const alert = parseCalendarEventUpdatedAlert(packet.payload);
      this.events.emit("CALENDAR_CHANGED", { eventId: alert.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_REMOVED_ALERT) {
      const alert = parseCalendarEventRemovedAlert(packet.payload);
      if (this.calendarEvent?.eventId === alert.eventId) this.calendarEvent = undefined;
      this.events.emit("CALENDAR_CHANGED", { eventId: alert.eventId });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_CLEAR_PENDING_ACTION) {
      // No body at all: drop whatever the calendar was waiting on.
      this.calendarPending = 0;
      this.events.emit("CALENDAR_CHANGED", { eventId: undefined });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_RAID_LOCKOUT_ADDED
      || packet.opcode === OPCODES.SMSG_CALENDAR_RAID_LOCKOUT_REMOVED
      || packet.opcode === OPCODES.SMSG_CALENDAR_RAID_LOCKOUT_UPDATED) {
      // Three shapes for one idea, and the removed one drops the leading time so every field after
      // it sits four bytes earlier.
      const lockout = packet.opcode === OPCODES.SMSG_CALENDAR_RAID_LOCKOUT_ADDED
        ? parseRaidLockoutAdded(packet.payload)
        : packet.opcode === OPCODES.SMSG_CALENDAR_RAID_LOCKOUT_REMOVED
          ? parseRaidLockoutRemoved(packet.payload)
          : parseRaidLockoutUpdated(packet.payload);
      const key = `${lockout.mapId}:${lockout.difficulty}`;
      if (packet.opcode === OPCODES.SMSG_CALENDAR_RAID_LOCKOUT_REMOVED) this.calendarLockouts.delete(key);
      else this.calendarLockouts.set(key, lockout);
      this.events.emit("INSTANCE_CHANGED", { lockouts: this.calendarLockouts.size });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_INVITE_NOTES) {
      // Compiled by the core and never constructed, so this never arrives from this build. The
      // layout is read off the real writer rather than guessed from a sibling.
      parseCalendarInviteNotes(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_INVITE_NOTES_ALERT) {
      parseCalendarInviteNotesAlert(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CALENDAR_EVENT_INVITE_STATUS_ALERT) {
      // Also never constructed, and byte for byte the removed-invite alert above.
      parseCalendarEventStatusAlert(packet.payload);
      return true;
    }
    return false;
  }

  #handleChannels(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_CHANNEL_NOTIFY) {
      const notify = parseChannelNotify(packet.payload);
      if (notify.guid !== 0n) this.requestName(notify.guid);
      if (notify.code === CHAT_YOU_LEFT_NOTICE) this.channels.delete(notify.channel);
      const held = this.channels.get(notify.channel);
      if (held && notify.code === CHAT_MODE_CHANGE_NOTICE) {
        const member = held.members.find((candidate) => candidate.guid === notify.guid);
        if (member) member.flags = notify.newMemberFlags;
      }
      if (held && notify.code === CHAT_LEFT_NOTICE) {
        held.members = held.members.filter((candidate) => candidate.guid !== notify.guid);
      }
      if (held && notify.code === CHAT_JOINED_NOTICE && !held.members.some((c) => c.guid === notify.guid)) {
        held.members.push({ guid: notify.guid, flags: 0 });
      }
      this.#recordSystemLine(channelNotifyText(notify));
      this.events.emit("CHANNEL_CHANGED", { channel: notify.channel });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHANNEL_LIST) {
      const list = parseChannelList(packet.payload);
      this.channels.set(list.channel, { flags: list.channelFlags, count: list.members.length, members: list.members });
      for (const member of list.members) this.requestName(member.guid);
      this.events.emit("CHANNEL_CHANGED", { channel: list.channel });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHANNEL_MEMBER_COUNT) {
      const count = parseChannelMemberCount(packet.payload);
      const held = this.channels.get(count.channel);
      if (held) {
        held.flags = count.channelFlags;
        held.count = count.count;
      } else {
        this.channels.set(count.channel, { flags: count.channelFlags, count: count.count, members: [] });
      }
      this.events.emit("CHANNEL_CHANGED", { channel: count.channel });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_USERLIST_ADD || packet.opcode === OPCODES.SMSG_USERLIST_UPDATE
      || packet.opcode === OPCODES.SMSG_USERLIST_REMOVE) {
      // Add and update share one builder; remove is a byte shorter because it has no member flags.
      const removal = packet.opcode === OPCODES.SMSG_USERLIST_REMOVE;
      const change = parseUserlistChange(packet.payload, removal);
      const held = this.channels.get(change.channel)
        ?? { flags: change.channelFlags, count: change.count, members: [] };
      held.flags = change.channelFlags;
      held.count = change.count;
      held.members = held.members.filter((candidate) => candidate.guid !== change.guid);
      if (!removal) held.members.push({ guid: change.guid, flags: change.memberFlags });
      this.channels.set(change.channel, held);
      this.requestName(change.guid);
      this.events.emit("CHANNEL_CHANGED", { channel: change.channel });
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHAT_PLAYER_NOT_FOUND) {
      this.#recordSystemLine(`Игрок ${parseChatPlayerName(packet.payload)} не найден`);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHAT_PLAYER_AMBIGUOUS) {
      this.#recordSystemLine(`Имя ${parseChatPlayerName(packet.payload)} неоднозначно`);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHAT_RESTRICTED) {
      this.#recordSystemLine(chatRestrictedText(parseChatRestricted(packet.payload)));
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_CHAT_WRONG_FACTION) {
      // No body at all, unlike the restriction next to it.
      this.#recordSystemLine("Этот игрок из другой фракции");
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_COMPLAIN_RESULT) {
      parseComplainResult(packet.payload);
      this.#recordSystemLine("Жалоба принята");
      return true;
    }
    return false;
  }

  #handleContacts(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_CONTACT_LIST) {
      this.contacts = parseContactList(packet.payload);
      for (const contact of this.contacts.contacts) this.requestName(contact.guid);
      this.events.emit("CONTACTS_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_FRIEND_STATUS) {
      const status = parseFriendStatus(packet.payload);
      this.#applyFriendStatus(status);
      const name = this.names.get(status.guid);
      if (!name && status.guid !== 0n) this.requestName(status.guid);
      this.#recordSystemLine(friendResultText(status.result, name ?? ""));
      this.events.emit("CONTACTS_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_WHO) {
      this.whoResult = parseWho(packet.payload);
      this.events.emit("WHO_RESULTS", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_WHOIS) {
      this.whois = parseWhois(packet.payload);
      this.#recordSystemLine(this.whois);
      this.events.emit("WHO_RESULTS", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_QUERY_NEXT_MAIL_TIME) {
      this.nextMailTime = parseNextMailTime(packet.payload);
      for (const sender of this.nextMailTime.senders) {
        if (sender.senderGuid !== 0n) this.requestName(sender.senderGuid);
      }
      this.events.emit("MAIL_TIME_CHANGED", {});
      return true;
    }
    return false;
  }

  /** Folds one friend-status packet into the held contact list rather than asking for it again. */
  #applyFriendStatus(status: { result: number; guid: bigint; note: string; status: number; areaId: number; level: number; classId: number }): void {
    if (!this.contacts || status.guid === 0n) return;
    const held = this.contacts.contacts.find((candidate) => candidate.guid === status.guid);
    if (status.result === FRIEND_REMOVED || status.result === FRIEND_IGNORE_REMOVED) {
      this.contacts.contacts = this.contacts.contacts.filter((candidate) => candidate.guid !== status.guid);
      return;
    }
    if (held) {
      held.status = status.status;
      held.areaId = status.areaId;
      held.level = status.level;
      held.classId = status.classId;
      if (status.note) held.note = status.note;
      return;
    }
    const contact: Contact = {
      guid: status.guid,
      flags: status.result === FRIEND_IGNORE_ADDED ? SOCIAL_FLAG_IGNORED : SOCIAL_FLAG_FRIEND,
      note: status.note,
      status: status.status,
      areaId: status.areaId,
      level: status.level,
      classId: status.classId,
    };
    this.contacts.contacts.push(contact);
  }

  #handlePetitions(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_PETITION_QUERY_RESPONSE) {
      this.petition = parsePetitionQueryResponse(packet.payload);
      this.requestName(this.petition.ownerGuid);
      this.events.emit("PETITION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PETITION_SHOWLIST) {
      this.petitionVendor = parsePetitionShowList(packet.payload);
      this.events.emit("PETITION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PETITION_SHOW_SIGNATURES) {
      this.petitionSignatures = parsePetitionSignatures(packet.payload);
      this.requestName(this.petitionSignatures.ownerGuid);
      for (const signer of this.petitionSignatures.signers) this.requestName(signer);
      this.events.emit("PETITION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_PETITION_SIGN_RESULTS) {
      const result = parsePetitionSignResult(packet.payload);
      // The charter's owner receives this too, and then the guid names somebody else.
      const mine = result.signerGuid === this.state.selfGuid;
      const name = this.names.get(result.signerGuid);
      if (!name) this.requestName(result.signerGuid);
      this.petitionMessage = {
        text: mine ? petitionSignText(result.result) : `${name || "Игрок"} подписал хартию`,
        error: mine && result.result !== 0,
      };
      this.events.emit("PETITION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_TURN_IN_PETITION_RESULTS) {
      const result = parseTurnInPetitionResult(packet.payload);
      this.petitionMessage = { text: petitionTurnInText(result), error: result !== 0 };
      this.events.emit("PETITION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_PETITION_DECLINE) {
      // The client asked about a charter; what comes back is the guid of whoever refused it.
      const guid = parsePetitionDecline(packet.payload);
      const name = this.names.get(guid);
      if (!name) this.requestName(guid);
      this.petitionMessage = { text: `${name || "Игрок"} отказался подписать хартию`, error: true };
      this.events.emit("PETITION_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.MSG_PETITION_RENAME) {
      const renamed = parsePetitionRenamed(packet.payload);
      if (this.petition) this.petition.name = renamed.name;
      this.petitionMessage = { text: `Хартия переименована: ${renamed.name}`, error: false };
      this.events.emit("PETITION_CHANGED", {});
      return true;
    }
    return false;
  }

  #handleDungeonFinder(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_LFG_PLAYER_INFO) {
      this.lfgPlayerInfo = parseLfgPlayerInfo(packet.payload);
      this.events.emit("LFG_INFO_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_PARTY_INFO) {
      this.lfgPartyInfo = parseLfgPartyInfo(packet.payload);
      for (const member of this.lfgPartyInfo) this.requestName(member.guid);
      this.events.emit("LFG_INFO_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_ROLE_CHECK_UPDATE) {
      this.lfgRoleCheck = parseLfgRoleCheckUpdate(packet.payload);
      for (const member of this.lfgRoleCheck.members) this.requestName(member.guid);
      this.lfgMessage = roleCheckStateText(this.lfgRoleCheck.state);
      this.onLfgChanged?.();
      this.events.emit("LFG_INFO_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE) {
      const boot = parseLfgBootProposal(packet.payload);
      this.lfgBoot = boot.inProgress ? boot : undefined;
      this.requestName(boot.victimGuid);
      this.events.emit("LFG_INFO_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_PLAYER_REWARD) {
      this.lfgReward = parseLfgPlayerReward(packet.payload);
      this.events.emit("LFG_INFO_CHANGED", {});
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_OFFER_CONTINUE) {
      const entry = parseLfgOfferContinue(packet.payload);
      this.lfgMessage = `Можно вернуться в подземелье ${entry & 0x00ffffff}`;
      this.onLfgChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_TELEPORT_DENIED) {
      this.lfgMessage = lfgTeleportDeniedText(parseLfgTeleportDenied(packet.payload));
      this.onLfgChanged?.();
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_UPDATE_SEARCH) {
      parseLfgUpdateSearch(packet.payload);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LFG_DISABLED) {
      // No body. The builder exists and nothing in this build calls it, so it is answered for
      // rather than dropped.
      this.lfgDisabled = true;
      this.lfgMessage = "Поиск подземелий отключён";
      this.onLfgChanged?.();
      return true;
    }
    return false;
  }

  /** A line the world said about itself, put where the chat panel already looks. */
  #recordSystemLine(text: string): void {
    this.events.emit("WORLD_MESSAGE", { text, kind: "system" });
  }

  #handleCombat(packet: WorldPacket): boolean {
    if (packet.opcode === OPCODES.SMSG_ATTACK_START) {
      const attack = parseAttackStart(packet.payload);
      if (attack.attacker === this.state.selfGuid) {
        this.targetGuid = attack.victim;
        this.attacking = true;
        this.onCombatStatus?.("Автоатака началась", true, false);
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ATTACK_STOP) {
      const attack = parseAttackStop(packet.payload);
      if (attack.attacker === this.state.selfGuid) {
        this.attacking = false;
        if (attack.victimDied) this.state.setField(attack.victim, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
        this.onCombatStatus?.(attack.victimDied ? "Цель погибла" : "Автоатака остановлена сервером", false, false);
      }
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_HEALTH_UPDATE) {
      const update = parseHealthUpdate(packet.payload);
      this.state.setField(update.guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, update.health);
      // This compact packet can be the only authoritative death edge for the selected target.
      // Re-run the same target invariant used after object updates so an active Auto Shot is
      // cancelled immediately instead of leaving Trinity's repeat slot to report BAD_TARGETS.
      if (update.guid === this.targetGuid) this.#checkTarget();
      return true;
    }

    if (packet.opcode === OPCODES.SMSG_ATTACKERSTATEUPDATE) {
      const swing = parseAttackerStateUpdate(packet.payload);
      // Landing a swing is the only signal the server ever sends that a swing can land again: it
      // reports "out of range" and "wrong way round" once each and stays silent afterwards,
      // whichever way the situation resolves.
      if (swing.attacker === this.state.selfGuid && this.swingWarning !== undefined) {
        this.swingWarning = undefined;
        this.onCombatStatus?.("Автоатака идёт", this.attacking, false);
      }
      this.onSwing?.(swing);
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_LOG_XPGAIN) {
      this.onExperience?.(parseExperienceGain(packet.payload));
      return true;
    }
    if (packet.opcode === OPCODES.SMSG_ENVIRONMENTAL_DAMAGE_LOG) {
      this.onEnvironmentalDamage?.(parseEnvironmentalDamage(packet.payload));
      return true;
    }

    // Out of range and facing the wrong way do NOT stop the attack. The server re-arms its swing
    // timer to a tenth of a second and keeps `UNIT_STATE_MELEE_ATTACKING` set; it only latches the
    // message so it is sent once. Clearing `attacking` here desynced the client permanently on the
    // first bad swing — the button offered to start an attack that was already running, and
    // pressing it sent another CMSG_ATTACK_SWING for a target already being attacked.
    const warning = packet.opcode === OPCODES.SMSG_ATTACK_SWING_NOT_IN_RANGE ? "Цель слишком далеко"
      : packet.opcode === OPCODES.SMSG_ATTACK_SWING_BAD_FACING ? "Нужно повернуться к цели"
        : undefined;
    if (warning) {
      this.swingWarning = warning;
      // Facing the wrong way is the one of the two the client can fix by itself, and it has to:
      // the server sends this once and then stays quiet however long the player stands there.
      if (packet.opcode === OPCODES.SMSG_ATTACK_SWING_BAD_FACING) this.faceTarget();
      this.onCombatStatus?.(warning, this.attacking, true);
      return true;
    }

    const error = packet.opcode === OPCODES.SMSG_ATTACK_SWING_DEAD_TARGET ? "Цель уже мертва"
      : packet.opcode === OPCODES.SMSG_ATTACK_SWING_CANT_ATTACK ? "Эту цель нельзя атаковать"
        : packet.opcode === OPCODES.SMSG_CANCEL_COMBAT ? "Бой завершён"
          : undefined;
    if (!error) return false;
    this.attacking = false;
    this.swingWarning = undefined;
    this.onCombatStatus?.(error, false, true);
    return true;
  }

  /**
   * Stops the swing at a target that has died, and drops a target that has left the world.
   *
   * Death used to drop the selection too, and that is what made looting unreachable: this runs
   * from `#dispatch` after every packet of the main chain, and `SMSG_UPDATE_OBJECT` is applied on
   * `:3339` in the same call — so the target frame emptied in the same breath that reported the
   * kill, and the «Обыскать» button that lives on that frame (`ui/Frames.ts:379`) had never once
   * been on the screen. The reference client keeps a corpse selected: `setTarget` takes one with
   * no liveness check (`wowee/src/game/combat_handler.cpp:1304-1307`) and it has no path anywhere
   * that deselects on death. Only vanishing from `state.objects` — out of sight, out of phase, a
   * map change — is still a reason to let go, and that is where the message belongs.
   *
   * The player's own body was already excepted here for the same reason one packet earlier: the
   * target frame is how a dead player watches their own corpse timer. That exception is now the
   * rule, so it needs no branch of its own.
   */
  #checkTarget(): void {
    if (this.targetGuid === undefined) return;
    const target = this.state.objects.get(this.targetGuid);
    if (target) {
      // What the method was written for, and the half of it that death still means.
      if (isWorldObjectDead(target)) {
        if (this.attacking) this.#cancelMeleeAttack(false);
        // Auto Shot 75 may remain in TrinityCore's repeat slot and keep emitting BAD_TARGETS.
        // Cancel it explicitly at the authoritative death edge instead of only forgetting it.
        this.#stopAutoRepeat(true);
      }
      return;
    }
    if (this.attacking) this.#cancelMeleeAttack(false);
    this.#stopAutoRepeat(true);
    this.targetGuid = undefined;
    this.onCombatStatus?.("Цель вышла из видимости", false, false);
  }
}
