import {
  ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL,
} from "../../world/ActionBarProtocol.js";
import {
  isPlayerGhost, PLAYER_FLAGS_AFK, PLAYER_FLAGS_DND, PLAYER_FLAGS_RESTING,
  player as playerFields, readByte, readField, unit as unitField,
  UNIT_DYNFLAG_TAPPED, UNIT_DYNFLAG_TAPPED_BY_PLAYER,
} from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "../../world/FactionRules.js";
import { isWorldObjectDead } from "../../world/WorldState.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { LevelUpInfo } from "../../world/CharacterProgressProtocol.js";
import type { WorldStore } from "../../world/WorldStore.js";
import { SELF } from "../../world/WorldStore.js";
import {
  INVENTORY_SLOT_BAG_0,
  INVENTORY_SLOT_BAG_START,
  BANK_BAG_SLOTS,
  BANK_SLOT_BAG_START,
  BUYBACK_SLOT_START,
  BUYBACK_SLOTS,
  EQUIPMENT_SLOT_NAMES,
  INVENTORY_SLOT_ITEM_START,
  KEYRING_SLOTS,
  KEYRING_SLOT_START,
  entryOf,
  fieldGuid,
  inventoryWatch,
  isBankSlot,
  itemWear,
  playerInventory,
  slotAt,
  stackCount,
} from "../Inventory.js";
import type { BuybackSlotState, ItemSlotState, PlayerInventoryState } from "../Inventory.js";
import { itemUseSpellId, requestInventoryItemUse } from "../game/GroundTarget.js";
import { bonusBarOffset as worldBonusBarOffset } from "../game/BonusBar.js";
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";
import {
  FRAMEXML_BIND_CONFIRM_EVENTS, FRAMEXML_BIND_WHEN_EQUIPPED, FRAMEXML_BIND_WHEN_USE, FRAMEXML_DUAL_WIELD_SPELLS,
  FRAMEXML_INVENTORY_ALERT_SLOTS, FRAMEXML_INVSLOT_AMMO, FRAMEXML_INVTYPE_AMMO, FRAMEXML_INVTYPE_NON_EQUIP,
  FRAMEXML_ITEM_CLASS_CONSUMABLE,
  FRAMEXML_ITEM_FIELD_FLAG_SOULBOUND, FRAMEXML_ITEM_INVENTORY_BAG_BIT_OFFSET, FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS,
  FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER, frameXmlEquipmentSlotsForInventoryType,
} from "./FrameXmlItemActions.js";
import { ITEM_EQUIP_COOLDOWN_MS } from "../../world/ItemProtocol.js";
import { withEventOwnersExcluded } from "../ui/framexml_compat/FrameXmlRuntime.js";
import { readSkills } from "../ui/Skills.js";
import { characterCombatRatingBonus, spellCritFromIntellect, type CharacterStatCatalog } from "../../world/CharacterStatData.js";
import {
  MIRROR_TIMER_BREATH, MIRROR_TIMER_FATIGUE, MIRROR_TIMER_NAMES, mirrorTimerRemaining,
} from "../../world/MirrorTimerProtocol.js";
import { GROUPTYPE_LFG, GROUPTYPE_RAID, LOOT_METHOD_MASTER, MEMBER_STATUS_ONLINE, MEMBER_STATUS_PVP } from "../../world/GroupProtocol.js";
import type { GroupMember } from "../../world/GroupProtocol.js";
import {
  GROUP_UPDATE_AURAS,
  GROUP_UPDATE_CUR_HP,
  GROUP_UPDATE_CUR_POWER,
  GROUP_UPDATE_LEVEL,
  GROUP_UPDATE_MAX_HP,
  GROUP_UPDATE_MAX_POWER,
  GROUP_UPDATE_POWER_TYPE,
  GROUP_UPDATE_STATUS,
  MEMBER_STATUS_DEAD,
  MEMBER_STATUS_GHOST,
  type PartyMemberStats,
} from "../../world/PartyProtocol.js";
import { MEMBER_STATUS_AFK, MEMBER_STATUS_DND } from "../../world/PartyProtocol.js";
import {
  frameXmlGroupRoles, frameXmlPartyLeaderIndex, frameXmlPlayerFlagAfk, frameXmlPlayerFlagDnd,
  frameXmlPlayerFlagResting, frameXmlRaidTargetIndex, frameXmlRestState, frameXmlXpExhaustion,
  type FrameXmlGroupRoles,
} from "./FrameXmlPlayerStatus.js";
import {
  frameXmlGroupHas, frameXmlGroupLeader, frameXmlRaidIndex, frameXmlRaidOfficer, frameXmlUnitFlagsInCombat,
} from "./FrameXmlUnitRelations.js";
import {
  FrameXmlControlEdge, frameXmlControlWords, frameXmlHasFullControl, frameXmlInControl,
} from "./FrameXmlControl.js";
import { FrameXmlGroupCommandsModel } from "./FrameXmlGroupCommands.js";
import { FrameXmlTargetingModel } from "./FrameXmlTargetingApi.js";
import { CHAT_MSG_ADDON, LANG_ADDON } from "../../world/SessionProtocol.js";
import { CHAT_MSG_CHANNEL, CHAT_MSG_SYSTEM, languageForRace } from "../../world/ChatProtocol.js";
import type { ChatMessage } from "../../world/ChatProtocol.js";
import { CHAT_YOU_JOINED_NOTICE, type ChannelNotify } from "../../world/ChannelProtocol.js";
import { isVehicleActionBar } from "../../world/PetProtocol.js";
import {
  buildCarriedItemCounts,
  questObjectiveLabel,
  splitQuestMoney,
  QUEST_OBJECTIVES,
  QUEST_STATE_COMPLETE,
  QUEST_STATE_FAIL,
} from "../../world/QuestProtocol.js";
import type {
  QuestCarriedItemStack,
  QuestTemplate,
} from "../../world/QuestProtocol.js";
import type { QuestLogEntry } from "../../world/Fields.js";
import type { VendorItem } from "../../world/VendorProtocol.js";
import type { VendorCost } from "../../gateway/VendorCostMetadata.js";
import {
  TRAINER_SPELL_AVAILABLE,
  TRAINER_SPELL_KNOWN,
  TRAINER_SPELL_UNAVAILABLE,
} from "../../world/TrainerProtocol.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import type { SpellSkillAbilityInfo } from "../../gateway/TalentMetadata.js";
import { frameXmlShapeshiftForms, type FrameXmlShapeshiftForm } from "./FrameXmlShapeshiftForms.js";
import { createMacroContext, frameXmlSeamMacroSource, macroFormMemo } from "../macro/MacroContext.js";
import type { MacroContext } from "../macro/MacroOptions.js";
import { FrameXmlWorldStates } from "./FrameXmlWorldStates.js";
import { LiveFrameXmlCalendar } from "./FrameXmlCalendar.js";
import { FrameXmlLfdModel } from "./FrameXmlLfd.js";
import { FrameXmlLootModel, type FrameXmlLootHostContext } from "./FrameXmlLoot.js";
import { FrameXmlPopupsModel } from "./FrameXmlPopups.js";
import { FrameXmlFriendsModel, frameXmlSocialAreaLookup } from "./FrameXmlFriends.js";
import { FrameXmlMailModel } from "./FrameXmlMail.js";
import { FrameXmlTradeModel } from "./FrameXmlTrade.js";
import { FrameXmlThreatModel } from "./FrameXmlThreat.js";
import { FrameXmlQuestAbandonModel } from "./FrameXmlQuestAbandon.js";
import { FrameXmlChatWindowFlags } from "./FrameXmlChatWindowFlags.js";
import { FrameXmlMechanicsModel } from "./FrameXmlMechanics.js";
import type { FrameXmlCurrencyModel } from "./FrameXmlCurrency.js";
import { createLiveFrameXmlCurrency } from "./FrameXmlCurrencyLive.js";
import { FrameXmlArenaOpponents } from "./FrameXmlArena.js";
import type { FrameXmlAuctionModel } from "./FrameXmlAuction.js";
import { createLiveFrameXmlAuction } from "./FrameXmlAuctionLive.js";
import type { FrameXmlSocketModel } from "./FrameXmlSocketModel.js";
import { createLiveFrameXmlSocket } from "./FrameXmlSocketLive.js";
import type { FrameXmlInspectModel } from "./FrameXmlInspect.js";
import { createLiveFrameXmlInspect } from "./FrameXmlInspectLive.js";
import type { FrameXmlBarberModel } from "./FrameXmlBarber.js";
import { createLiveFrameXmlBarber } from "./FrameXmlBarberLive.js";
import type { FrameXmlGlyphModel } from "./FrameXmlGlyph.js";
import { createLiveFrameXmlGlyphs } from "./FrameXmlGlyphLive.js";
import { createLiveFrameXmlTitles, liveFrameXmlTitleWearer } from "./FrameXmlTitlesLive.js";
import type { FrameXmlTitleModel } from "./FrameXmlTitles.js";
import { createLiveFrameXmlEquipmentSets } from "./FrameXmlEquipmentSetsLive.js";
import type { FrameXmlEquipmentSetModel } from "./FrameXmlEquipmentSets.js";
import type { FrameXmlAchievementModel } from "./FrameXmlAchievement.js";
import { createLiveFrameXmlAchievement } from "./FrameXmlAchievementLive.js";
import type { FrameXmlGuildBankModel } from "./FrameXmlGuildBank.js";
import { createLiveFrameXmlGuildBank } from "./FrameXmlGuildBankLive.js";
import { createLiveFrameXmlTradeSkill, type FrameXmlTradeSkillLiveHost, type FrameXmlTradeSkillModel } from "./FrameXmlTradeSkill.js";
import { frameXmlPopupsLiveContext } from "./FrameXmlPopupsLive.js";
import {
  FrameXmlMacroModel, createFrameXmlMemoryMacroStore, type FrameXmlMacroIcons, type FrameXmlMacroStore,
} from "./FrameXmlMacro.js";
import { FrameXmlCursorModel, type FrameXmlActionButton } from "./FrameXmlCursor.js";
import { FrameXmlBindingModel } from "./FrameXmlBinding.js";
import { FrameXmlChatColors } from "./FrameXmlChatColors.js";
import type { InputAction } from "../input/Bindings.js";
import {
  attachLiveFrameXmlNpcWindows, createLiveFrameXmlNpcWindows, detachLiveFrameXmlNpcWindows,
  liveFrameXmlBankInventorySlot, liveFrameXmlGameObjectName, liveFrameXmlInteractionNpc, liveFrameXmlNpcUseContainerItem,
  liveFrameXmlInteractionUnit,
  type LiveFrameXmlNpcWindows,
} from "./FrameXmlGossipLive.js";
import { frameXmlBankContainer, frameXmlIsBankContainer, FRAMEXML_FIRST_BANK_INVENTORY_ID } from "./FrameXmlBank.js";
import { frameXmlQuestTrivial } from "./FrameXmlGossip.js";
import { frameXmlTaxiMapBounds } from "./FrameXmlTaxi.js";
import { questGreenRange } from "./FrameXmlWorldSeam.js";
import type { LfgStockCatalog } from "../LfgDungeons.js";
import { FrameXmlHudMechanicsLive } from "./FrameXmlHudMechanicsLive.js";
import { FrameXmlPetActionBarLive } from "./FrameXmlPetActionBarLive.js";
import { FrameXmlMap, type FrameXmlMapSource } from "./FrameXmlMap.js";
import { frameXmlPetExperience } from "./FrameXmlPetExperience.js";
import { frameXmlHunterPet } from "./FrameXmlStable.js";
import { FrameXmlCompanionModel, frameXmlPetCanBeRenamed, frameXmlUnitMounted } from "./FrameXmlCompanions.js";
import { frameXmlPetSpellBonusDamage } from "./FrameXmlPetSpellPower.js";
import { createFrameXmlServices, type FrameXmlServices, type FrameXmlSendMailItem } from "./FrameXmlServices.js";
import type { WorldStateUiRow } from "../../world/WorldStateUiData.js";
import { ensureSpellNames } from "../ui/SpellNames.js";
import { QUALITY_LINK_COLORS, itemChatLink, spellChatLink } from "../ui/ChatLink.js";
import { className, classFileName, raceBaseLanguage, raceFileName, raceName } from "../ui/UnitSnapshot.js";
import { settledHoveredUnitGuid } from "../game/HoverTarget.js";
import { clientLocale } from "../Environment.js";
import {
  isTracking, trackingFieldsSignature, trackingSpellsOf, type TrackingSpell,
} from "../ui/Tracking.js";
import {
  AURA_FLAGS,
  type ActiveAura,
} from "../../world/AuraProtocol.js";
import {
  FRAMEXML_POWER_MAX_EVENTS,
  FRAMEXML_POWER_EVENTS,
  FRAMEXML_POWER_TOKENS,
  frameXmlInventorySlotInfo,
  frameXmlItemEntry,
  FRAMEXML_CHAT_WINDOW_GROUPS,
  FRAMEXML_SEAM_EVENTS,
  frameXmlCombatLogWindowInfo,
  frameXmlGeneralWindowInfo,
  frameXmlChatEventArgs,
  frameXmlChatEventName,
  frameXmlChannelNotice,
  frameXmlChatTextIsValid,
  frameXmlChatTypeCode,
  frameXmlEscapeLocalChatText,
  frameXmlGuid,
  frameXmlLanguageName,
  frameXmlLfgMode,
  FRAMEXML_LANGUAGE_SKILLS,
  FRAMEXML_TRACKING_NONE_TEXTURE,
  type FrameXmlInstanceInfo,
  type FrameXmlLfgMode,
  type FrameXmlTrackingInfo,
  type FrameXmlChatSender,
  type FrameXmlChatTarget,
  type FrameXmlChatWindowChannels,
  type FrameXmlChatWindowInfo,
  type FrameXmlCastingInfo,
  type FrameXmlChannelInfo,
  type FrameXmlMerchantItemInfo,
  type FrameXmlMerchantCostInfo,
  type FrameXmlItemInfo,
  type FrameXmlBuybackItemInfo,
  type FrameXmlAuraInfo,
  type FrameXmlSpellCooldown,
  type FrameXmlShapeshiftFormInfo,
  type FrameXmlMirrorTimerInfo,
  type FrameXmlSpellTabInfo,
  type FrameXmlSkillLineInfo,
  type FrameXmlMinimapZone,
  type FrameXmlZonePvpInfo,
  type FrameXmlContainerItemInfo,
  type FrameXmlContainerItemCooldown,
  type FrameXmlInventorySlotInfo,
  type FrameXmlUnitStat,
  type FrameXmlUnitArmor,
  type FrameXmlUnitAttackPower,
  type FrameXmlUnitDamage,
  type FrameXmlUnitRangedDamage,
  type FrameXmlQuestLogTitle,
  type FrameXmlQuestLogLeaderBoard,
  type FrameXmlQuestItemInfo,
  type FrameXmlQuestItemMetadata,
  type FrameXmlQuestCreatureMetadata,
  type FrameXmlQuestRewardSpell,
  type FrameXmlActionTooltip,
  type FrameXmlFactionInfo,
  type FrameXmlWatchedFactionInfo,
  type FrameXmlFactionRow,
  type FrameXmlSeamPump,
  type FrameXmlWorldSeam,
} from "./FrameXmlWorldSeam.js";
import type { BattlefieldList } from "../../world/PvpProtocol.js";
import {
  createFrameXmlTalentResolvers,
  type FrameXmlTalentMetadata,
  type FrameXmlTalentResolvers,
  type FrameXmlTalentSnapshot,
} from "./FrameXmlTalentResolver.js";
import {
  resolveFrameXmlHonorSnapshot,
  type FrameXmlHonorSnapshot,
} from "./FrameXmlHonorResolver.js";
import {
  createFrameXmlSkillResolvers,
  frameXmlSkillAbandonable,
  type FrameXmlSkillRow,
  type FrameXmlSkillMetadata,
  type FrameXmlSkillResolvers,
} from "./FrameXmlSkillResolver.js";
import type { FrameXmlSettingsCVarAdapter } from "./FrameXmlSettingsCVar.js";
import { createFrameXmlOptionsModel, type FrameXmlOptionsModel } from "./FrameXmlOptions.js";
import type { FrameXmlInventoryTooltipItem } from "./FrameXmlCharacterTooltip.js";
import type { ReputationCatalog } from "../../gateway/ReputationMetadata.js";
import { frameXmlFactionInfoById } from "./FrameXmlFactionById.js";
import {
  frameXmlQuestGiverRead,
  performFrameXmlQuestGiverCommand,
  resolveFrameXmlQuestGiverCommand,
} from "./FrameXmlQuestGiverAdapter.js";
import { cachedQuestRewardSpellInfo } from "./FrameXmlQuestRewardData.js";
import { publishFrameXmlNativeBankCursor } from "./FrameXmlItemCursorBridge.js";
import { frameXmlLootMethod, FRAMEXML_LOOT_METHODS, type FrameXmlLootMethod } from "./FrameXmlGroupLoot.js";
import { itemEnchantmentIds } from "../ItemEnchantments.js";
import type {
  FrameXmlBattlegroundCatalog,
} from "./FrameXmlBattlegrounds.js";
import { FRAMEXML_BATTLEGROUND_TYPE_IDS } from "./FrameXmlBattlegrounds.js";
import {
  STATUS_IN_PROGRESS,
  STATUS_WAIT_JOIN,
  STATUS_WAIT_QUEUE,
} from "../../world/PvpProtocol.js";

const ALLIANCE_RACE_IDS = new Set([1, 3, 4, 7, 11]);
const HORDE_RACE_IDS = new Set([2, 5, 6, 8, 10]);

/**
 * The same seam over this client's real world state — slice F3's seam (b).
 *
 * Every read below is the read `src/browser/ui/ActionBar.ts` already performs, cited line by line,
 * because the point of the exercise is that the FrameXML bar and the DOM bar are looking at the
 * *same* state and not at two interpretations of it:
 *
 * | this seam | `ui/ActionBar.ts` |
 * |---|---|
 * | `#button(slot)` | `contentOf` — `game.world.actionButtons.find(b => b.slot === …)` (:258-261) |
 * | slot numbering | `actionSlot(page, column)`, `page * 12 + column` (`ActionBarProtocol.ts:96`) |
 * | `actionTexture` | `spellIcon` — `game.spells.get(id)?.iconId` (:219-221), by path rather than by id; see below |
 * | `actionCooldown` | `world.cooldownState(id)` and `world.cooldownRemaining(id, now)` (:444-457) |
 * | `actionUsable` | `spellButtonUsable(metadata)` and the cooldown, the same two gates `slotBlockedBy` applies (:274-288) |
 * | `useAction` | `useSlot(column, page)` (:291-314) |
 * | player fields | `unit.health/maxHealth/level/powerType/power/maxPower` (`ui/Frames.ts:275-281`) |
 * | selected target | `world.targetGuid` and `world.state.objects` (selection is polled because `selectTarget` has no event) |
 * | target name/classification | `world.names` / `world.creatureTemplates`, nil while the query cache is empty |
 * | minimap zone IDs | `world.mapId` + `world.worldStateContext`; labels require the optional `minimapZone` resolver |
 *
 * **The icon is a path, not a URL, and that is the one deliberate difference.** `ui/ActionBar.ts`
 * builds `spellIconUrl(iconId)` because an `IconButton` is an `<img>` whose `src` it sets directly.
 * The FrameXML renderer resolves a *texture name* through `frameXmlTexturePath` and the gateway's
 * `/texture`, so this seam answers `metadata.iconPath` — the client's own
 * `Interface\Icons\…` string, which is also what the real `GetActionTexture` returns. Measured
 * against the running gateway: `/texture?path=Interface\Icons\Spell_Fire_FlameBolt.blp` and
 * `/spell-icon/185` both answer 200 with the same 5,412 bytes, so the two routes are the same
 * picture and nothing had to be re-plumbed.
 *
 * **What this seam does not do.** It is constructed in the world and mounted by the ordinary
 * default-on route; `?framexml=0` prevents that mount. It is not the DOM HUD's replacement and
 * nothing outside the mounted FrameXML route can reach it.
 * Item actions share the cached texture/inventory and cooldown sources used by the bags. The
 * optional host action dispatcher also shares macro/equipment-set execution with keyboard input.
 * Faction and hostility have separate boundaries: the player's `UnitFactionGroup` is derived from
 * its authoritative race byte, while object relations still carry only a `UNIT_FIELD_FACTIONTEMPLATE`
 * id and need the optional `reaction` callback's exact resolver. The current mount leaves that
 * relation resolver absent, so live hostility stays neutral/unknown rather than inventing an alias.
 *
 * The world bus's `MINIMAP_PING` coordinates are absolute world points. Stock `Minimap.lua`
 * expects normalized local offsets, so this seam leaves that event to the adopted native canvas
 * until a host can provide a projection tied to its zoom and rotation state.
 */

/** How often the seam re-reads the world; 60 ms is four world ticks and under a rendered frame. */
const LIVE_POLL_SECONDS = 0.06;
const EMPTY_SPELL_TABS: readonly FrameXmlSpellTabInfo[] = Object.freeze([]);

/**
 * The paper-doll edges stock PaperDollFrame answers with `PaperDollFrame_UpdateStats()` for the
 * player (PaperDollFrame.lua:187-194); UNIT_RESISTANCES runs `PaperDollFrame_SetResistances()` first.
 * UNIT_ATTACK_POWER is not one: that frame registers it and does nothing with it.
 */
const PAPER_DOLL_STATS_EVENTS: ReadonlySet<string> = new Set([
  FRAMEXML_SEAM_EVENTS.resistances, FRAMEXML_SEAM_EVENTS.stats, FRAMEXML_SEAM_EVENTS.rangedAttackPower,
  FRAMEXML_SEAM_EVENTS.attackSpeed, FRAMEXML_SEAM_EVENTS.damage, FRAMEXML_SEAM_EVENTS.rangedDamage,
  FRAMEXML_SEAM_EVENTS.damageDoneMods,
]);
const PAPER_DOLL_FRAME: ReadonlySet<string> = new Set(["PaperDollFrame"]);

function isArenaBattlefieldList(list: BattlefieldList | undefined): boolean {
  return !!list
    && typeof list.battlemasterGuid === "bigint"
    && list.battlemasterGuid !== 0n
    && list.fromWhere === 0
    && list.bgTypeId === 6;
}

export interface LiveWorldSeamContext {
  readonly mailDraftAttachments?: () => readonly bigint[];
  readonly stableSlotPrice?: (slotsOwned: number) => number | undefined;
  readonly mapSource?: FrameXmlMapSource;
  readonly worldStateUi?: () => readonly WorldStateUiRow[] | undefined;
  /** Exact class/level coefficients from the configured dataset's gtChanceToSpellCrit tables. */
  readonly characterStats?: () => CharacterStatCatalog | undefined;
  readonly world: () => WorldClient | undefined;
  readonly store: () => WorldStore | undefined;
  readonly spell: (id: number) => SpellMetadata | undefined;
  /** Resolved spell cache for the name form of `GetSpellInfo`; never fetches in a Lua C-API read. */
  readonly spells?: () => Iterable<SpellMetadata>;
  /** Authoritative SkillLineAbility supersession rows, cached by TalentClient. */
  readonly spellAbilities?: (id: number) => readonly SpellSkillAbilityInfo[] | undefined;
  /** The interface-owned focus identity; sampled on the seam's existing rendered-frame path. */
  readonly focusGuid?: () => bigint | undefined;
  /** Its writer, for `FocusUnit`/`ClearFocus` (FrameXmlTargetingApi.ts); absent, those change nothing. */
  readonly setFocus?: (guid: bigint | undefined) => void;
  /** Optional FactionTemplate resolver supplied by the host when client-side faction data is ready. */
  readonly reaction?: (left: WorldObjectState, right: WorldObjectState) => number | undefined;
  /** Optional resolver joining Faction.dbc metadata to the live faction map. */
  readonly reputation?: (world: WorldClient) => readonly FrameXmlFactionRow[] | undefined;
  /** Already fetched catalog linking Faction.dbc IDs to reputation-list slots. */
  readonly reputationCatalog?: () => ReputationCatalog | undefined;
  /** SkillLine/SkillLineCategory metadata; absent means this host has no skill rows yet. */
  readonly skillMetadata?: () => FrameXmlSkillMetadata | undefined;
  /** Talent tree metadata; absent means Blizzard_TalentUI must remain safely empty. */
  readonly talentMetadata?: () => FrameXmlTalentMetadata | undefined;
  /** Explicit host revision for talent metadata and spell-name enrichment. */
  readonly talentMetadataRevision?: () => number;
  /** Resolve the current `WorldMapArea` id used by Quest POI filtering, when area metadata is ready. */
  readonly worldMapAreaId?: () => number | undefined;
  /**
   * The render loop's measured requestAnimationFrame cadence (`WorldRenderer3D.fps`), for
   * `GetFramerate`; absent, the seam answers 0 rather than a made-up rate.
   */
  readonly framerate?: () => number;
  /** `performance.now()` milliseconds — the clock the world's cooldowns are stamped in. */
  readonly monotonic: () => number;
  /** The global cooldown's end, in the same milliseconds; `game.globalCooldownUntil`. */
  readonly globalCooldownUntil: () => number;
  /** Cast a spell the way the rest of the client casts one; `ui/Spellbook.castSpell`. */
  readonly castSpell: (id: number) => void;
  /** Configured bank bag slot price for the number already bought; cache-only. */
  readonly bankSlotPrice?: (slotsBought: number) => number | undefined;
  /** The keyboard/main-bar page, in stock Lua's 1-based 1..6 numbering. */
  readonly actionBarPage?: () => number;
  readonly changeActionBarPage?: (page: number) => void;
  /** Execute an absolute 1-based action slot through the same dispatcher as keyboard input. */
  readonly useAction?: (slot: number, button?: string) => void;
  /** Optional skill-line tabs; absent hosts get one truthful undivided resolved-spell tab. */
  readonly spellTabs?: () => readonly FrameXmlSpellTabInfo[];
  /** 1-based tab ordinal for a spell. Returning undefined keeps it in the fallback tab. */
  readonly spellTabFor?: (spellId: number) => number | undefined;
  /**
   * Whether a known spell is a lower rank of another known one (FrameXmlSpellBookTabs.ts): the
   * rows `GetSpellTabInfo`'s highest-rank offset/count leave out and
   * `GetKnownSlotFromHighestRankSlot` steps over while `ShowAllSpellRanks` is off.
   */
  readonly spellIsLowerRank?: (spellId: number) => boolean;
  /** Optional CVar bridge used by SpellBookFrame's Show All Spell Ranks checkbox. */
  readonly getCVarBool?: (name: string) => boolean | undefined;
  readonly setCVar?: (name: string, value: boolean) => void;
  /** Optional settings-backed string CVar bridge used by stock options panels. */
  readonly settingsCVar?: FrameXmlSettingsCVarAdapter;
  /** Optional host bridge for FrameXML's `SendChatMessage`; called only for valid payloads. */
  readonly sendChatMessage?: FrameXmlChatSender;
  /** Host audio path for a stock `PlaySound` name. */
  readonly playSound?: (name: string) => void;
  /** Cached item texture resolver; it must not perform network I/O from a C-API read. */
  readonly itemTexture?: (entry: number) => string | undefined;
  /** The loot packet's display-id icons, auto-loot switch and modifier (FrameXmlLootHost.ts). */
  readonly lootHost?: FrameXmlLootHostContext;
  /** Cached item metadata for quest rewards; it must not perform network I/O from a C-API read. */
  readonly itemInfo?: (entry: number) => FrameXmlQuestItemMetadata | undefined;
  /** Cache-only ItemExtendedCost lookup; the vendor packet carries only the row id. */
  readonly vendorCost?: (id: number) => VendorCost | undefined;
  /** Cached creature metadata for quest targets; it must not perform network I/O from a C-API read. */
  readonly creatureInfo?: (entry: number) => FrameXmlQuestCreatureMetadata | undefined;
  /** Prefetches unresolved quest item/spell metadata outside C-API reads and reports cache arrival. */
  readonly prefetchQuestMetadata?: (
    itemIds: readonly number[],
    spellIds: readonly number[],
    onChanged: () => void,
  ) => void;
  /**
   * Resolve the server's numeric map/zone/area context to the exact labels and PvP tuple the
   * minimap asks for. The callback is optional because the mount currently does not expose the
   * area's cache; returning undefined is preferable to manufacturing a zone or faction.
   */
  readonly minimapZone?: (
    mapId: number | undefined,
    zoneId: number | undefined,
    areaId: number | undefined,
  ) => FrameXmlMinimapZone | undefined;
  /** Cached `/dbc/battlegrounds` rows; C-API reads never start a fetch. */
  readonly battlegroundCatalog?: () => FrameXmlBattlegroundCatalog | undefined;
  /**
   * The `/dbc/lfg-dungeons` catalog in its version-2 shape, loaded before boot; undefined keeps
   * every stock LFD answer empty and the native finder in charge (FrameXmlLfd.ts).
   */
  readonly lfgCatalog?: () => LfgStockCatalog | undefined;
  /**
   * Client locale for `Languages.dbc` names in chat and the language menu; `clientLocale()` (the
   * configured VITE_CLIENT_LOCALE, ruRU by default) when absent.
   */
  readonly locale?: string;
  /**
   * `MapDifficulty.MaxPlayers` for a map and 0-based difficulty, when a host has the table. Absent,
   * GetInstanceInfo falls back to the counts measured on this dataset (see `instanceInfo`).
   */
  readonly instanceMaxPlayers?: (mapId: number, difficulty: number) => number | undefined;
  /** The mount's profession tables, subclass words and craft queue; absent, every trade skill stays closed. */
  readonly tradeSkill?: FrameXmlTradeSkillLiveHost;
  /** The two account-data macro stores (Macros.ts); absent, the macro API holds an empty, unsaved set. */
  readonly macroStore?: FrameXmlMacroStore;
  /** The macro window's icon lists, fetched when it first opens (FrameXmlMacroIcons.ts). */
  readonly macroIcons?: FrameXmlMacroIcons;
  /** RunBinding's verb for a compiled-in action (`Actions.runAction`). */
  readonly runBinding?: (action: InputAction) => boolean;
}

interface LiveCastState {
  readonly spellId: number;
  readonly channel: boolean;
  readonly castID: number | undefined;
}

interface LiveChatChannel {
  readonly number: number;
  readonly shortName: string;
  readonly displayName: string;
  /** The held ChatChannels id (`WorldClient.channels`), 0 for a custom channel: stock's `arg7`. */
  readonly zoneChannelId: number;
}

interface LiveContainer {
  readonly id: number;
  readonly slots: readonly ItemSlotState[];
  readonly name: string | undefined;
  readonly bagFamily: number | undefined;
}

/**
 * The 3.3.5 unit ids, lower-cased as the binding hands them over, each optionally followed by any
 * number of `target`s («party1target», «targettarget»). `TargetUnit` given one of these selects
 * that unit or nothing; only a string that is none of them is a name to look for.
 */
const FRAMEXML_UNIT_TOKEN =
  /^(?:player|target|focus|mouseover|pet|vehicle|npc|none|party[1-4]|partypet[1-4]|raid\d{1,2}|raidpet\d{1,2}|arena[1-5]|arenapet[1-5]|boss[1-4])(?:target)*$/;

/** The server may include a numeric prefix and/or a zone suffix in a channel display name. */
function shortChannelName(raw: string): string {
  return raw.trim()
    .replace(/^\d+\.\s*/, "")
    .replace(/\s+-\s+[^-]+$/, "")
    .trim();
}

function displayChannelName(raw: string, number: number): string {
  const trimmed = raw.trim();
  return /^\d+\.\s*/.test(trimmed) ? trimmed : `${number}. ${trimmed}`;
}

function isResolvedFactionRow(value: unknown): value is FrameXmlFactionRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<FrameXmlFactionRow>;
  const listId = row.listId;
  return typeof listId === "number" && Number.isInteger(listId) && listId >= 0
    && typeof row.name === "string" && row.name.length > 0
    && typeof row.description === "string"
    && typeof row.standingId === "number" && Number.isInteger(row.standingId)
    && row.standingId >= 1 && row.standingId <= 8
    && typeof row.barMin === "number" && Number.isFinite(row.barMin)
    && typeof row.barMax === "number" && Number.isFinite(row.barMax)
    && typeof row.barValue === "number" && Number.isFinite(row.barValue)
    && typeof row.canToggleAtWar === "boolean"
    && typeof row.isHeader === "boolean"
    && typeof row.isChild === "boolean"
    && typeof row.hasRep === "boolean";
}

export class LiveWorldSeam implements FrameXmlWorldSeam {
  readonly worldStates: FrameXmlWorldStates;
  readonly calendar: LiveFrameXmlCalendar;
  readonly lfd: FrameXmlLfdModel;
  /** The stock LootFrame/GroupLootFrame C API and its events (FrameXmlLoot.ts). */
  readonly loot: FrameXmlLootModel;
  /** The stock StaticPopup/ReadyCheckFrame confirmations (FrameXmlPopups.ts). */
  readonly popups: FrameXmlPopupsModel;
  /** The stock FriendsFrame/RaidFrame C API: friends, ignore, who, guild, raid (FrameXmlFriends.ts). */
  readonly friends: FrameXmlFriendsModel;
  /** The stock MailFrame C API and its send draft (FrameXmlMail.ts). */
  readonly mail: FrameXmlMailModel;
  /** The stock TradeFrame C API (FrameXmlTrade.ts). */
  readonly trade: FrameXmlTradeModel;
  /** The stock currency C API over the known-currency bits and the token slots (FrameXmlCurrencyLive.ts). */
  readonly currency: FrameXmlCurrencyModel;
  /** The enemy arena team behind `arenaN`/`arenapetN` and GetNumArenaOpponents (FrameXmlArena.ts). */
  readonly arena: FrameXmlArenaOpponents;
  /** The stock AuctionFrame C API, its sell slot and multisell (FrameXmlAuction.ts). */
  readonly auction: FrameXmlAuctionModel;
  /** The stock ItemSocketingFrame C API over the equipped/carried item and its gems (FrameXmlSocketModel.ts). */
  readonly socket: FrameXmlSocketModel;
  /** The stock InspectFrame C API over the inspection packets (FrameXmlInspect.ts). */
  readonly inspect: FrameXmlInspectModel;
  /** The stock BarberShopFrame C API over the chair and the player's appearance (FrameXmlBarber.ts). */
  readonly barber: FrameXmlBarberModel;
  readonly barberPrepare: () => Promise<void>;
  /** The stock GlyphFrame C API over the glyph fields, SMSG_TALENTS_INFO and `/dbc/glyphs` (FrameXmlGlyphLive.ts). */
  readonly glyphs: FrameXmlGlyphModel;
  /** The stock title picker's C API over the title fields and `/dbc/char-titles` (FrameXmlTitlesLive.ts). */
  readonly titles: FrameXmlTitleModel;
  /** The stock equipment manager's C API over the equipment-set packets and the bags (FrameXmlEquipmentSetsLive.ts). */
  readonly equipmentSets: FrameXmlEquipmentSetModel;
  /** The stock PetPaperDollFrame's companion C API over the known mount/critter spells (FrameXmlCompanions.ts). */
  readonly companions: FrameXmlCompanionModel;
  /** The stock PetActionBarFrame and the pet commands over the pet bar packet (FrameXmlPetActionBarLive.ts). */
  readonly petActions: FrameXmlPetActionBarLive;
  /** The stock achievement C API over the achievement packets; the mount hands it the catalog (FrameXmlAchievement.ts). */
  readonly achievement: FrameXmlAchievementModel;
  /** The stock GuildBankFrame C API and its vault cursor (FrameXmlGuildBank.ts). */
  readonly guildBank: FrameXmlGuildBankModel;
  /** The stock TradeSkillFrame C API over the professions and the native craft queue (FrameXmlTradeSkill.ts). */
  readonly tradeSkill: FrameXmlTradeSkillModel;
  /** The macro C API over the account-data macro stores, and the macro cursor (FrameXmlMacro.ts). */
  readonly macros: FrameXmlMacroModel;
  /** The one cursor over the item, macro and vault holders, plus spells and lifted actions (FrameXmlCursor.ts). */
  readonly cursor: FrameXmlCursorModel = new FrameXmlCursorModel(this);
  /** The binding C API over this client's key table (FrameXmlBinding.ts). */
  readonly keyBindings: FrameXmlBindingModel;
  /** The options C API over the settings adapter, when the host supplies one (FrameXmlOptions.ts). */
  readonly options: FrameXmlOptionsModel | undefined;
  /** The stock Gossip/Bank/Taxi/ItemText frames' models (FrameXmlGossipLive.ts). */
  readonly gossip: LiveFrameXmlNpcWindows["gossip"];
  readonly bank: LiveFrameXmlNpcWindows["bank"];
  readonly taxi: LiveFrameXmlNpcWindows["taxi"];
  readonly itemText: LiveFrameXmlNpcWindows["itemText"];
  /** The stock Tabard/Guild- and ArenaRegistrar/Petition frames' models (FrameXmlGossipLive.ts). */
  readonly tabard: LiveFrameXmlNpcWindows["tabard"];
  readonly registrar: LiveFrameXmlNpcWindows["registrar"];
  readonly petition: LiveFrameXmlNpcWindows["petition"];
  /** The stock PetStableFrame's model (FrameXmlStable.ts, FrameXmlStableLive.ts). */
  readonly stable: LiveFrameXmlNpcWindows["stable"];
  readonly map: FrameXmlMap;
  /** The totem bar, the hit indicator and the temporary weapon enchants (FrameXmlHudMechanicsLive.ts). */
  readonly hudMechanics: FrameXmlHudMechanicsLive;
  readonly services: FrameXmlServices;
  /** The stock threat C API over `WorldClient.threat` and its two UNIT_THREAT_* edges (FrameXmlThreat.ts). */
  readonly threat: FrameXmlThreatModel;
  /** The stock quest log's abandon confirmation over `abandonQuest` (FrameXmlQuestAbandon.ts). */
  readonly questAbandon: FrameXmlQuestAbandonModel;
  /** The chat cache's LOCKED/DOCKED/UNINTERACTABLE flags, per attach like `#chatWindowShown`. */
  readonly chatWindows = new FrameXmlChatWindowFlags();
  /** Arena teams, the possess bar, the battlefield winner and the add-on channel (FrameXmlMechanics.ts). */
  readonly mechanics: FrameXmlMechanicsModel;
  /** The unit menus' assistant and main tank/assist commands over the group packets (FrameXmlGroupCommands.ts). */
  readonly groupCommands: FrameXmlGroupCommandsModel;
  /** Focus, assist, dismount and the stance bar's cancel (FrameXmlTargetingApi.ts). */
  readonly targeting: FrameXmlTargetingModel;
  /** The last PLAYER_CONTROL_LOST/GAINED told to Lua (FrameXmlControl.ts). */
  readonly #controlEdge = new FrameXmlControlEdge();
  #serviceSignature = "";

  petExperience(): readonly [number, number] { return frameXmlPetExperience(this.#pet()) ?? [0, 0]; }
  petSpellBonusDamage(): number | undefined {
    return this.#pet() ? frameXmlPetSpellBonusDamage(this.#self()) : undefined;
  }

  #sendMailItems(): readonly FrameXmlSendMailItem[] {
    const world = this.#context.world();
    return (this.#context.mailDraftAttachments?.() ?? []).map((guid): FrameXmlSendMailItem => {
      const item = world?.state.objects.get(guid);
      const entry = item ? entryOf(item) : 0;
      const template = this.#itemTemplate(world, entry);
      const metadata = this.#context.itemInfo?.(entry);
      const count = item ? readField(item, "ITEM_FIELD_STACK_COUNT") : undefined;
      return [template?.name ?? metadata?.name, this.#context.itemTexture?.(entry), count ?? 0,
        template?.quality ?? metadata?.quality];
    });
  }

  #servicesSignature(): string {
    return JSON.stringify([this.#sendMailItems(), this.services.nextStableSlotCost(),
      this.services.stableSlots(), this.#context.world()?.stableMasterGuid?.toString()]);
  }
  realmName(): string | undefined {
    return this.#context.world()?.realmName;
  }

  gameTime(): readonly [number, number] | undefined {
    const time = this.#context.world()?.currentGameTime?.(this.#context.monotonic());
    if (!time || !Number.isFinite(time.minuteOfDay)) return undefined;
    const minutes = Math.floor((time.minuteOfDay % 1440 + 1440) % 1440);
    return [Math.floor(minutes / 60), minutes % 60];
  }

  framerate(): number {
    return this.#context.framerate?.() ?? 0;
  }

  /** The last CMSG_PING/SMSG_PONG round trip WorldClient measured, for GetNetStats. */
  netLatency(): number | undefined {
    return this.#context.world()?.latencyMs;
  }

  /** The world socket's KB/s in and out WorldClient measures, for GetNetStats. */
  netBandwidth(): { inKBps: number; outKBps: number } | undefined {
    return this.#context.world()?.netBandwidth?.();
  }

  readonly name = "live";
  readonly #context: LiveWorldSeamContext;
  /**
   * The mount builds this seam without `locale` (it hands `clientLocale()` only to FrameXmlBoot),
   * so the fallback is the same configured client locale rather than a fixed ruRU: an enUS client
   * must hear «Common», not «всеобщий», and GetDefaultLanguage must match its own chat lines.
   */
  get locale(): string { return this.#context.locale ?? clientLocale(); }
  #pump: FrameXmlSeamPump | undefined;
  #releaseNativeBankCursor: (() => void) | undefined;
  /** `count` is set for a split part (SplitContainerItem): the next drop sends CMSG_SPLIT_ITEM for that many. */
  #itemCursor: { world: WorldClient; bag: number; slot: number; guid: bigint; count?: number } | undefined;
  readonly #unsubscribe: (() => void)[] = [];
  #polledAt = 0;
  /**
   * The two combat edges last told to Lua: the player's own swing (`WorldClient.attacking`, from
   * SMSG_ATTACK_START/STOP) as PLAYER_ENTER/LEAVE_COMBAT, and `UNIT_FLAG_IN_COMBAT` on the player as
   * PLAYER_REGEN_DISABLED/ENABLED. Both start false at attach, so the first check publishes a fight
   * already under way (PlayerFrame keeps its combat glow only from these events).
   */
  #meleeAnnounced = false;
  #combatAnnounced = false;
  /** A level-up packet waiting for its level to land, with the free talent points before it. */
  #pendingLevelUp: { info: LevelUpInfo; pointsBefore: number } | undefined;
  /** The last published shape of the bar, so a change fires one event instead of sixty a second. */
  #barSignature = "";
  #cooldownSignature = "";
  #itemCooldownSignature = "";
  #actionPage = 1;
  readonly #mirrorTimerSignatures = new Map<number, string>();
  #spellSignature = "";
  #spellCooldownSignature = "";
  #shapeshiftSignature = "";
  #shapeshiftActiveSignature = "";
  #shapeshiftCooldownSignature = "";
  #bonusActionBarOffset = 0;
  #comboSignature = "";
  #bankSlotsBought: number | undefined;
  #bankerGuid: bigint | undefined;
  /** Last vendor list shape delivered to stock MerchantFrame. */
  #merchantSignature = "";
  #trainerSelection: number | undefined;
  readonly #trainerFilters = new Map<string, boolean>([
    ["available", true], ["unavailable", true], ["used", false],
  ]);
  /** Last published stock bag-id shapes; inventory fields are coalesced by WorldStore.any. */
  #containerSignatures = new Map<number, string>();
  /**
   * Every item entry those shapes were read from — the carried slots and the bags themselves — as
   * of the last reconcile; undefined until there was one. An item answer about any other entry (a
   * crowd's gear, a hundred at a time) cannot change a shape (`QUERY_CACHE_CHANGED` below).
   */
  #containerEntries: Set<number> | undefined;
  /** The same for the quest signature: every reward, choice and objective item it named. */
  #questItemIds: Set<number> | undefined;
  /** And the creature and game-object objectives whose names it read. */
  #questCreatureIds: Set<number> | undefined;
  #questGameObjectIds: Set<number> | undefined;
  /** Paper-doll signatures are sampled at the same 60 ms world boundary as other derived state. */
  #inventorySignature = "";
  #statsSignature = "";
  #resistanceSignature = "";
  #attackPowerSignature = "";
  #rangedAttackPowerSignature = "";
  #attackSpeedSignature = "";
  #damageSignature = "";
  #rangedDamageSignature = "";
  #damageModifierSignature = "";
  /** Quest fields and cached templates are read only at their existing world/store event edges. */
  #questLogSignature = "";
  #unitQuestLogSignature = "";
  #questProgressSignature = "";
  #questMetadataPrefetchSignature = "";
  #questMetadataInvalidated = false;
  #questSelection = 0;
  #currentMapQuestIdsCache: readonly number[] | undefined;
  #currentMapQuestWorld: WorldClient | undefined;
  #currentMapQuestMapId: number | undefined;
  #currentMapQuestAreaId: number | undefined;
  #reputationSignature = "";
  #skillSignature = "";
  #skillRevision = 0;
  #talentRevision = 0;
  #talentMetadataRevision = Number.NaN;
  #petTalentOwnerSeen = false;
  #petTalentOwnerGuid: bigint | undefined;
  #petTalentsAtOwnerChange: WorldClient["petTalents"];
  #awaitPetTalentPacket = false;
  readonly #talentResolvers: FrameXmlTalentResolvers;
  #honorSignature = "";
  #honorCurrencySignature = "";
  #selectedSkillId: number | undefined;
  readonly #collapsedSkillCategories = new Set<number>();
  readonly #skillResolvers: FrameXmlSkillResolvers;
  #selectedFactionId: number | undefined;
  /** Last type index passed through GetBattlegroundInfo; stock calls this before GetBattlefieldInfo. */
  #selectedBattleground = 1;
  /** A battlemaster list is valid only for the world/session that delivered it. */
  #arenaListWorld: WorldClient | undefined;
  #arenaListReference: BattlefieldList | undefined;
  #arenaListFresh = false;
  #arenaWasPublished = false;
  #arenaClosing = false;
  /** Only the first attach may adopt a list that arrived before FrameXML mounted. */
  #arenaInitialAttach = true;
  /**
   * When each SMSG_BATTLEFIELD_STATUS snapshot (a fresh object per packet) was first read, on the
   * monotonic clock: its clocks are the server's at send time and count on from there.
   */
  readonly #battlefieldStatusSeen = new WeakMap<object, number>();
  #watchedFactionId: number | undefined;
  readonly #collapsedFactionIds = new Set<number>();
  /** Explicit UI overrides; absent entries retain the latest server-provided flag. */
  readonly #inactiveFactionOverrides = new Map<number, boolean>();
  readonly #atWarFactionOverrides = new Map<number, boolean>();
  /** Quest ids explicitly removed from the client-local watch list. An empty set means "all". */
  readonly #unwatchedQuestIds = new Set<number>();
  #spellEntriesCache: readonly { id: number; slot: number }[] | undefined;
  #spellEntriesCacheWorld: WorldClient | undefined;
  #spellEntriesCacheKnown: unknown;
  #spellEntriesCacheTabs: readonly FrameXmlSpellTabInfo[] | undefined;
  #spellCvars = new Map<string, boolean>([["showallspellranks", false]]);
  #health = -1;
  #money: number | undefined;
  #power = -1;
  #powerMax = -1;
  #powerType = -1;
  /** Last selected target identity published to FrameXML; selection itself has no EventBus edge. */
  #targetGuid: bigint | undefined;
  #targetName = "";
  /** Last target-of-target identity published; the source is current target's UNIT_FIELD_TARGET. */
  #targetTargetGuid: bigint | undefined;
  #targetTargetName = "";
  /** Last focus identity published; focus is client state and has no world EventBus edge. */
  #focusGuid: bigint | undefined;
  #focusName = "";
  /** Last pet object identity published to FrameXML; the authoritative token is petSpells.guid. */
  #petGuid: bigint | undefined;
  #petName = "";
  /** The current four-slot non-raid group shape, used only to publish membership edges. */
  #partySignature = "";
  /** Last world location tuple whose zone edge was published; primitive fields avoid rAF objects. */
  #zoneKnown = false;
  #zoneMapId: number | undefined;
  #zoneId: number | undefined;
  #areaId: number | undefined;
  /** Last sampled WorldMapArea id used to refresh WatchFrame's current-map POI filter. */
  #worldMapAreaKnown = false;
  #worldMapAreaId: number | undefined;
  /**
   * The numeric location can stay fixed while AreaClient fills its cache later. Keep the resolved
   * primitive shape separately so that nil -> known and label/PvP changes still publish one edge;
   * primitive fields also avoid retaining or allocating a per-frame snapshot object here.
   */
  #zoneShapeKnown = false;
  #zoneMinimapText: string | undefined;
  #zoneText: string | undefined;
  #zoneSubZoneText: string | undefined;
  #zonePvpType: string | undefined;
  #zoneIsSubZonePvp: boolean | undefined;
  #zoneFactionName: string | undefined;
  /** Last aura/metadata shape handed to FrameXML, sampled on the existing 60 ms poll. */
  #auraSignature = "";
  /** The selected target's aura shape; target transitions seed this so the next poll is quiet. */
  #targetAuraSignature = "";
  /** The current focus's aura shape; focus transitions seed this so the next poll is quiet. */
  #focusAuraSignature = "";
  /** The current target-of-target aura shape; transitions seed this so the next poll is quiet. */
  #targetTargetAuraSignature = "";
  /** The pet aura shape; pet bar/object transitions seed this so the next poll is quiet. */
  #petAuraSignature = "";
  /** Local line IDs are only for FrameXML links; the wire packet has no line ID. */
  #chatLineId = 0;
  /** `GetChatWindowChannels(1)` as last announced with UPDATE_CHAT_WINDOWS (`#chatWindowsUpdated`). */
  #chatWindowsSignature = "";
  /** The chat cache's SHOWN flags as the stock frames wrote them (`setChatWindowShown`); per attach. */
  readonly #chatWindowShown = new Map<number, boolean>();
  /**
   * The chat cache's colours (FrameXmlChatColors.ts), scoped like the client's per-character cache:
   * a `ChangeChatColor` outlives `/reload`, whose remount builds a new seam.
   */
  readonly chatColors = new FrameXmlChatColors(() => {
    const world = this.#context.world();
    const self = world?.state.selfGuid;
    return self === undefined ? undefined : JSON.stringify([world?.realmName ?? "", self.toString()]);
  });
  /** The settled world pick last announced with UPDATE_MOUSEOVER_UNIT. */
  #mouseoverGuid: bigint | undefined;
  /** Minimap indicator shapes, sampled on the 60 ms poll: tracking, mail, LFG eye, difficulty. */
  #trackingSignature = "";
  #mailSignature = "";
  /** What the last MSG_QUERY_NEXT_MAIL_TIME was asked against; see `#queryPendingMail`. */
  #mailQueryWorld: WorldClient | undefined;
  #mailNotice: unknown;
  #mailboxOpen = false;
  #lfgSignature = "";
  #instanceSignature = "";
  /** The world deletes a cast before emitting STOP; retain only its identity until that edge. */
  readonly #castStates = new Map<bigint, LiveCastState>();

  constructor(context: LiveWorldSeamContext) {
    this.#context = context;
    this.calendar = new LiveFrameXmlCalendar(context.world, context.monotonic);
    this.lfd = new FrameXmlLfdModel({
      world: () => context.world(),
      catalog: () => context.lfgCatalog?.(),
      playerLevel: () => this.unitLevel("player") ?? 0,
      playerClassId: () => {
        const player = this.#self();
        return player ? unitField.classId(player) : undefined;
      },
      playerName: () => this.unitName("player"),
      playerGuid: () => context.world()?.state.selfGuid,
      playerFaction: () => {
        const faction = this.unitFactionGroup("player");
        return faction === "Alliance" || faction === "Horde" ? faction : undefined;
      },
      partyMemberCount: () => this.partyMemberCount(),
      raidMemberCount: () => this.raidMemberCount(),
      isPartyLeader: () => this.isPartyLeader(),
      inDungeonInstance: () => this.instanceInfo()?.[1] === "party",
      item: (entry) => {
        const metadata = context.itemInfo?.(entry);
        return metadata && metadata.name.length > 0
          ? { name: metadata.name, texture: context.itemTexture?.(entry) ?? metadata.texture, quality: metadata.quality }
          : undefined;
      },
      monotonic: () => context.monotonic(),
    });
    this.popups = new FrameXmlPopupsModel(frameXmlPopupsLiveContext({
      world: () => context.world(),
      self: () => this.#self(),
      unitGuid: (unit) => this.#unitGuid(unit),
      playerLevel: () => this.unitLevel("player") ?? 0,
      spellName: (id) => context.spell(id)?.name,
      // DELETE_ITEM_CONFIRM names the stock cursor's item as #itemLink does (the realm's template,
      // else the client metadata); the native «Разрушить» picks a bag item up onto the same cursor,
      // unless the letter or the trade holds it (pickupContainerItem's rule).
      cursorItem: () => {
        const source = this.#cursorSource();
        if (!source?.item) return undefined;
        const entry = entryOf(source.item);
        const template = this.#itemTemplate(context.world(), entry);
        const metadata = context.itemInfo?.(entry);
        return {
          bag: source.bag, slot: source.slot,
          name: (template?.found ? template.name : metadata?.name) ?? "",
          quality: (template?.found ? template.quality : metadata?.quality) ?? 1,
        };
      },
      pickupItem: (bag, slot) => {
        const world = context.world();
        const inventory = world && typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
        const source = inventory && slotAt(inventory, bag, slot);
        if (!source?.item || source.guid === 0n || this.mail.attached(source.guid) || this.trade.offered(source.guid)) return false;
        this.#setCursor(source);
        return this.#cursorSource() !== undefined;
      },
      clearCursor: () => this.clearCursor(),
      // Older seam doubles omit the clock; the world stamps its requests with performance.now().
      monotonic: () => (typeof context.monotonic === "function" ? context.monotonic() : performance.now()),
    }));
    this.loot = new FrameXmlLootModel({
      world: () => context.world(),
      item: (entry) => context.itemInfo?.(entry),
      displayIcon: (displayId) => context.lootHost?.displayIcon?.(displayId),
      playerLevel: () => this.unitLevel("player") ?? 0,
      autoLootDefault: () => context.lootHost?.autoLootDefault?.() ?? false,
      autoLootModifier: () => context.lootHost?.autoLootModifier?.() ?? false,
      playSound: (name) => this.playSound(name),
    });
    const socialAreas = frameXmlSocialAreaLookup(() => context.mapSource?.metadata());
    this.friends = new FrameXmlFriendsModel({
      world: () => context.world(),
      playerGuid: () => context.world()?.state.selfGuid,
      playerName: () => this.unitName("player"),
      // PLAYER_GUILDID/PLAYER_GUILDRANK are PUBLIC fields: the player's and any visible player's.
      // A player object whose PLAYER_GUILDID is 0 (or absent: a create block omits zero fields) is
      // «in no guild» — /gquit and a kick zero it; undefined means «no such player object».
      unitGuild: (unit) => {
        const object = this.#unit(unit);
        if (object?.typeId !== TYPEID_PLAYER) return undefined;
        const guildId = readField(object, "PLAYER_GUILDID") ?? 0;
        return guildId > 0 ? { guildId, rankId: readField(object, "PLAYER_GUILDRANK") ?? 0 } : { guildId: 0, rankId: 0 };
      },
      areaName: socialAreas.areaName,
      mapInfo: socialAreas.mapInfo,
      classInfo: (classId) => {
        const token = classFileName(classId);
        return token === undefined ? undefined : [className(classId), token];
      },
      raceName: (raceId) => raceFileName(raceId) === undefined ? undefined : raceName(raceId),
      memberFacts: (guid) => {
        const world = context.world();
        const stats = world?.partyStats.get(guid);
        const object = world?.state.objects.get(guid);
        return {
          level: stats?.level ?? (object ? unitField.level(object) : undefined),
          classId: object ? unitField.classId(object) : undefined,
          areaId: stats?.zoneId,
          dead: object ? isWorldObjectDead(object) : undefined,
        };
      },
      monotonic: () => context.monotonic(),
    });
    // Mail and trade share this seam's one bag cursor: a stock bag click picks an item up, and the
    // attachment/trade slot takes it from the same GUID-checked source (#cursorSource).
    {
      const carried = (guid: bigint): ItemSlotState | undefined => {
        const world = context.world();
        const inventory = world && typeof world.state.objects?.get === "function"
          ? playerInventory(world.state) : undefined;
        return inventory
          ? [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)]
            .find((slot) => slot.guid === guid && slot.item !== undefined)
          : undefined;
      };
      const cursorItem = (): { guid: bigint; bag: number; slot: number } | undefined => {
        const source = this.#cursorSource();
        return source ? { guid: source.guid, bag: source.bag, slot: source.slot } : undefined;
      };
      const shared = {
        item: (entry: number) => context.itemInfo?.(entry),
        itemLink: (guid: bigint) => this.#itemLink(carried(guid)?.item),
        cursorItem,
        clearCursor: () => this.clearCursor(),
        pickupItem: (guid: bigint) => { const slot = carried(guid); if (slot) this.#setCursor(slot); },
        prefetchItems: (entries: readonly number[], onChanged: () => void) =>
          context.prefetchQuestMetadata?.(entries, [], onChanged),
        // An attachment or offer moved: repaint the carried bags' lock state (containerItemInfo).
        locksChanged: () => {
          for (const id of [0, 1, 2, 3, 4]) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.bagUpdate, id);
        },
      };
      this.mail = new FrameXmlMailModel({
        ...shared,
        world: () => context.world(),
        itemObject: (guid) => {
          const slot = carried(guid);
          return slot?.item ? { entry: entryOf(slot.item), count: stackCount(slot) } : undefined;
        },
        creatureName: (entry) => context.creatureInfo?.(entry)?.name,
      });
      this.trade = new FrameXmlTradeModel({
        ...shared,
        world: () => context.world(),
        displayIcon: (displayId) => context.lootHost?.displayIcon?.(displayId),
        itemPosition: (guid) => {
          const slot = carried(guid);
          return slot ? { bag: slot.bag, slot: slot.slot } : undefined;
        },
        spellName: (id) => context.spell(id)?.name,
      });
    }
    // The stock auction house's sell slot takes from the same carried bags and bag cursor.
    this.auction = createLiveFrameXmlAuction({
      world: () => context.world(),
      itemInfo: (entry) => context.itemInfo?.(entry),
      itemTexture: (entry) => context.itemTexture?.(entry),
      prefetchItems: (itemIds, spellIds, onChanged) => context.prefetchQuestMetadata?.(itemIds, spellIds, onChanged),
      cursorSource: () => this.#cursorSource(),
      setCursor: (slot) => this.#setCursor(slot),
      clearCursor: () => this.clearCursor(),
      itemLink: (item) => this.#itemLink(item),
      playerLevel: () => this.unitLevel("player") ?? 0,
      playerClassRace: () => {
        const player = this.#self();
        return player ? { classId: unitField.classId(player), raceId: unitField.race(player) } : undefined;
      },
      locksChanged: () => { for (const id of [0, 1, 2, 3, 4]) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.bagUpdate, id); },
    });
    // The stock guild bank deposits from and withdraws into the same bags and bag cursor.
    this.guildBank = createLiveFrameXmlGuildBank({
      world: () => context.world(),
      itemInfo: (entry) => context.itemInfo?.(entry),
      itemTexture: (entry) => context.itemTexture?.(entry),
      prefetchItems: (itemIds, spellIds, onChanged) => context.prefetchQuestMetadata?.(itemIds, spellIds, onChanged),
      cursorSource: () => this.#cursorSource(),
      clearCursor: () => this.clearCursor(),
      playerLevel: () => this.unitLevel("player") ?? 0,
      macroItemIcon: (index) => this.macros.itemIcon(index),
    });
    // Stock socketing reads the same equipment, carried slots and bag cursor (FrameXmlSocketLive.ts).
    this.socket = createLiveFrameXmlSocket({
      world: () => context.world(),
      equipment: (slot) => this.#equipmentSlot("player", slot),
      container: (bag, slot) => this.#liveContainerSlot(bag, slot),
      cursorSource: () => this.#cursorSource(),
      setCursor: (slot) => this.#setCursor(slot),
      clearCursor: () => this.clearCursor(),
      itemInfo: (entry) => context.itemInfo?.(entry),
      itemTexture: (entry) => context.itemTexture?.(entry),
      prefetchItems: (itemIds, spellIds, onChanged) => context.prefetchQuestMetadata?.(itemIds, spellIds, onChanged),
      locksChanged: () => { for (const id of [0, 1, 2, 3, 4]) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.bagUpdate, id); },
      now: () => context.monotonic() / 1000,
    });
    // Inspection: the unit the stock frame names, the inspection maps and the talent trees (FrameXmlInspectLive.ts).
    this.inspect = createLiveFrameXmlInspect({
      world: () => context.world(),
      unitObject: (unit) => this.#unit(unit),
      canAttack: (unit) => this.unitCanAttack("player", unit),
      itemInfo: (entry) => context.itemInfo?.(entry),
      itemTexture: (entry) => context.itemTexture?.(entry),
      prefetchItems: (itemIds, spellIds, onChanged) => context.prefetchQuestMetadata?.(itemIds, spellIds, onChanged),
      talentMetadata: () => context.talentMetadata?.(),
    });
    // The barber chair: the player's appearance bytes and the gateway's barber tables (FrameXmlBarberLive.ts).
    ({ model: this.barber, prepare: this.barberPrepare } = createLiveFrameXmlBarber({ world: () => context.world() }));
    // The glyph sockets: the player's glyph fields, the talents packet and the gateway's glyph tables.
    this.glyphs = createLiveFrameXmlGlyphs({
      world: () => context.world(),
      spellName: (spellId) => this.spellInfo(spellId)?.[0],
    }).model;
    // The title picker: the chosen/known title fields, the sex byte and the gateway's CharTitles rows.
    this.titles = createLiveFrameXmlTitles({ world: () => context.world() }).model;
    // The equipment manager: WorldClient's sets, the bags for where each piece is, the worn pictures, the macro icons.
    this.equipmentSets = createLiveFrameXmlEquipmentSets({
      world: () => context.world(),
      itemTexture: (entry) => this.#itemTexture(entry),
      macroIcon: (index) => this.macros.icon(index),
      macroIconCount: () => this.macros.iconCount(),
    });
    // The pet page's companions: the known mount/critter spells, the player's mount aura and the
    // critters it summoned (FrameXmlCompanions.ts). Skill lines answer only once the catalog is
    // ready, so a spell without rows is «none», not «not yet».
    this.companions = new FrameXmlCompanionModel({
      knownSpells: () => context.world()?.knownSpells,
      spell: (id) => context.spell(id),
      skillLines: (id) => {
        const ready = context.skillMetadata ? context.skillMetadata()?.ready === true : true;
        return ready ? (context.spellAbilities?.(id) ?? []).map((row) => row.skillLine) : undefined;
      },
      mounted: () => frameXmlUnitMounted(this.#self()),
      hasAura: (spellId) => {
        const world = context.world();
        const guid = world?.state.selfGuid;
        if (!world || guid === undefined) return false;
        const auras = world.auras?.get(guid);
        if (auras) {
          for (const aura of auras.values()) if (aura.spellId === spellId) return true;
          return false;
        }
        return typeof world.aurasFor === "function" && world.aurasFor(guid).some((aura) => aura.spellId === spellId);
      },
      forEachSummon: (visit) => {
        const world = context.world();
        const self = world?.state.selfGuid;
        if (!world || self === undefined || typeof world.state.objects?.values !== "function") return;
        for (const object of world.state.objects.values()) {
          // TYPEID_UNIT: a critter is a creature; the player's own object names nobody as its summoner.
          if (object.typeId !== 3 || readField(object, "UNIT_FIELD_SUMMONEDBY") !== self) continue;
          const spellId = readField(object, "UNIT_CREATED_BY_SPELL");
          if (spellId !== undefined && spellId > 0) visit(spellId, object.guid);
        }
      },
      cast: (spellId) => context.castSpell(spellId),
      dismissCritter: (guid) => context.world()?.dismissCritter?.(guid),
      // GetSpellCooldown's arithmetic over the world's cooldown snapshot, by spell id: a book slot
      // number and a spell id share one numeric argument in `spellCooldown`, and a mount's id can be
      // a valid slot.
      cooldown: (spellId) => {
        const snapshot = context.world()?.cooldownSnapshots?.get(spellId);
        const pump = this.#pump;
        const monotonic = context.monotonic();
        if (!snapshot || snapshot.endsAt <= monotonic || !pump) return [0, 0, 0];
        return [pump.now() - (monotonic - snapshot.startedAt) / 1000, snapshot.duration / 1000, 1];
      },
      pickup: (spellId, type, index) => this.cursor.pickupCompanion(spellId, type, index),
      locale: () => this.locale,
    });
    // The professions read the same skills, recipes and carried slots as ui/Professions.ts.
    this.tradeSkill = createLiveFrameXmlTradeSkill(context);
    // Currencies: PLAYER_FIELD_KNOWN_CURRENCIES, the token slots and the item cache's names.
    this.currency = createLiveFrameXmlCurrency(context);
    // Arena opponents: the players in sight on the other arena team, and their pets.
    this.arena = new FrameXmlArenaOpponents({
      world: () => context.world(), spell: (id) => context.spell(id), monotonic: () => context.monotonic(),
    });
    this.achievement = createLiveFrameXmlAchievement(() => context.world(), () => this.unitFactionGroup("player"));
    // Macros and key bindings: this client's own stores, which the native windows write too.
    this.macros = new FrameXmlMacroModel({
      store: context.macroStore ?? createFrameXmlMemoryMacroStore(),
      ...(context.macroIcons ? { icons: context.macroIcons } : {}),
      placeOnActionBar: (slot, macro) => {
        const world = context.world();
        if (!world) return false;
        world.setActionButton(slot - 1, macro, ACTION_BUTTON_MACRO);
        return true;
      },
    });
    this.keyBindings = new FrameXmlBindingModel(context.runBinding ? { runAction: context.runBinding } : {});
    this.options = context.settingsCVar ? createFrameXmlOptionsModel(context.settingsCVar) : undefined;
    this.map = new FrameXmlMap(context.mapSource ?? { metadata: () => undefined, location: () => undefined });
    // Totems, the hit indicator and the weapon imbues: the world's packet records and the same
    // unit-token resolution the unit frames use; totem spell names are fetched outside C-API reads.
    this.hudMechanics = new FrameXmlHudMechanicsLive({
      world: () => context.world(),
      store: () => context.store(),
      monotonic: () => context.monotonic(),
      spell: (id) => context.spell(id),
      unitGuid: (unit) => this.#unitGuid(unit),
      prefetchSpells: (ids, onLoaded) => ensureSpellNames(ids, onLoaded),
    });
    // The pet bar: WorldClient's pet packet, timers and swing, the same unit tokens for a target.
    this.petActions = new FrameXmlPetActionBarLive({
      world: () => context.world(),
      monotonic: () => context.monotonic(),
      spell: (id) => context.spell(id),
      unitGuid: (unit) => this.#unitGuid(unit),
      prefetchSpells: (ids, onLoaded) => ensureSpellNames(ids, onLoaded),
    });
    ({
      gossip: this.gossip, bank: this.bank, taxi: this.taxi, itemText: this.itemText,
      tabard: this.tabard, registrar: this.registrar, petition: this.petition, stable: this.stable,
    } = createLiveFrameXmlNpcWindows({
      world: () => context.world(),
      unitName: (unit) => this.unitName(unit),
      unitClassName: (unit) => this.unitClass(unit)?.[0],
      unitRaceName: (unit) => this.unitRace(unit)?.[0],
      unitSex: (unit) => this.unitSex(unit),
      unitFlags: (unit) => {
        const player = unit === "player" ? this.#self() : undefined;
        return player ? unitField.flags(player) : undefined;
      },
      playerFaction: () => {
        const faction = this.unitFactionGroup("player");
        return faction === "Alliance" || faction === "Horde" ? faction : undefined;
      },
      itemTemplate: (entry) => {
        const template = this.#itemTemplate(context.world(), entry);
        return template?.found ? template : undefined;
      },
      itemAppearance: (entry) =>
        `${this.#itemTemplate(context.world(), entry)?.quality ?? ""}:${this.#itemTexture(entry) ?? ""}`,
      questLog: () => this.#questRows().map((row) => ({
        questId: row.questId, complete: (row.state & QUEST_STATE_COMPLETE) !== 0,
      })),
      questTrivial: (level) => {
        const playerLevel = this.unitLevel("player");
        return frameXmlQuestTrivial(level, playerLevel, questGreenRange(playerLevel));
      },
      containerSlot: (bagId, slot) => this.#liveContainerSlot(bagId, slot),
      cursorSlot: () => this.#cursorSource(),
      clickBankSlot: (bag, slot) => this.clickNativeBankSlot(bag, slot),
      clearCursor: () => this.clearCursor(),
      continent: (mapId) => frameXmlTaxiMapBounds(
        context.mapSource?.metadata()?.continents?.find((row) => row.mapId === mapId),
        context.mapSource?.metadata()?.mapAreas.find((area) => area.mapId === mapId && area.areaId === 0)),
      mapTransforms: () => context.mapSource?.metadata()?.transforms,
      itemTexture: (entry) => this.#itemTexture(entry),
    }));
    this.services = createFrameXmlServices({
      sendMailItems: () => this.#sendMailItems(),
      stableService: () => {
        const world = context.world();
        const stable = world?.stable;
        return stable && world?.stableMasterGuid !== 0n && world?.stableMasterGuid === stable.npcGuid
          ? { masterGuid: stable.npcGuid, slotsOwned: stable.stableSlots } : undefined;
      },
      stableSlotPrice: (owned) => context.stableSlotPrice?.(owned),
    });
    this.worldStates = new FrameXmlWorldStates(() => context.worldStateUi?.(), () => {
      const world = context.world();
      const location = world?.worldStateContext;
      if (!world || !location) return undefined;
      const serverTime = world.currentServerTime?.(context.monotonic());
      return { ...location, phaseMask: world.phaseMask, states: world.worldStates,
        ...(serverTime === undefined ? {} : { serverTime }) };
    });
    this.threat = new FrameXmlThreatModel({
      world: () => context.world(),
      unitGuid: (unit) => this.#unitGuid(unit),
      inInstance: () => {
        const type = this.instanceInfo()?.[1];
        return type === "party" || type === "raid";
      },
      inGroup: () => this.partyMemberCount() > 0 || this.raidMemberCount() > 0,
    });
    this.questAbandon = new FrameXmlQuestAbandonModel({
      selection: () => this.#questSelection,
      entry: (index) => {
        const entry = this.#questAt(index);
        return entry ? { slot: entry.slot, questId: entry.questId } : undefined;
      },
      locate: (questId) => {
        const entry = this.#questRows().find((row) => row.questId === questId);
        return entry ? { slot: entry.slot, questId: entry.questId } : undefined;
      },
      title: (questId) => this.#questTemplateById(questId)?.title,
      questItems: (questId) => {
        const template = this.#questTemplateById(questId);
        return template ? [template.startItem, ...template.itemObjectives.map((objective) => objective.itemId)] : undefined;
      },
      carriedItems: () => {
        const inventory = this.#inventoryOf(context.world());
        if (!inventory) return undefined;
        const entries = new Set<number>();
        for (const slot of [...inventory.backpack, ...inventory.keyring, ...inventory.bags.flatMap((bag) => bag.slots)]) {
          if (slot.item) entries.add(entryOf(slot.item));
        }
        return entries;
      },
      abandon: (entry) => context.world()?.abandonQuest(entry.slot),
    });
    this.mechanics = new FrameXmlMechanicsModel({
      world: () => context.world(),
      self: () => this.#self(),
      spell: (id) => context.spell(id),
    });
    this.groupCommands = new FrameXmlGroupCommandsModel({
      world: () => context.world(), unitGuid: (unit) => this.#unitGuid(unit),
    });
    this.targeting = new FrameXmlTargetingModel({
      world: () => context.world(),
      unitGuid: (unit) => this.#unitGuid(unit),
      namedGuid: (name) => this.#relationGuid(name) ?? this.#nearestNamed(name, false),
      setFocus: (guid) => context.setFocus?.(guid),
      activeStanceEntries: () => this.#shapeshiftForms().filter((form) => this.#shapeshiftActive(form)),
    });
    this.#skillResolvers = createFrameXmlSkillResolvers(() => ({
      player: this.#self(),
      playerRevision: this.#skillRevision,
      talent: this.#context.skillMetadata?.(),
    }));
    this.#talentResolvers = createFrameXmlTalentResolvers(() => {
      const world = this.#context.world();
      const talent = this.#context.talentMetadata?.();
      const family = world?.petSpells?.creatureFamily;
      const petTalents = this.#currentPetTalents(world);
      return {
        player: this.#self(),
        playerRevision: this.#talentRevision,
        talents: world?.talents,
        talentsRevision: this.#talentRevision,
        petGuid: world?.petSpells?.guid,
        petFamilyMask: family === undefined ? undefined : talent?.petTalentMask?.(family),
        petTalents,
        petTalentsRevision: this.#talentRevision,
        talent,
      };
    });
  }

  attach(pump: FrameXmlSeamPump): void {
    // A mount/unmount can reattach the same seam. Do not leave the old packet listeners alive.
    if (this.#pump) this.detach();
    this.#pump = pump;
    // A new FrameXML load starts from the dock's default selection, «Общий».
    this.#chatWindowShown.clear();
    this.chatWindows.reset();
    // The chat cache's colours before anything can print a line (FrameXmlChatColors.ts).
    this.chatColors.attach(pump);
    this.threat.attach(pump);
    this.mechanics.attach(pump);
    this.#serviceSignature = this.#servicesSignature();
    this.worldStates.attach(pump);
    this.calendar.attach(pump);
    this.lfd.attach(pump);
    attachLiveFrameXmlNpcWindows(this, pump);
    this.loot.attach(pump);
    this.popups.attach(pump);
    this.friends.attach(pump);
    this.mail.attach(pump);
    this.trade.attach(pump);
    this.currency.attach(pump);
    this.arena.attach(pump);
    this.auction.attach(pump);
    this.socket.attach(pump);
    this.inspect.attach(pump);
    this.barber.attach(pump);
    this.glyphs.attach(pump);
    this.companions.attach(pump);
    this.titles.attach(pump);
    this.equipmentSets.attach(pump);
    this.achievement.attach(pump);
    this.guildBank.attach(pump);
    this.tradeSkill.attach(pump);
    this.macros.attach(pump);
    this.cursor.attach(pump);
    this.keyBindings.attach(pump);
    this.map.attach(pump);
    this.hudMechanics.attach(pump);
    this.petActions.attach(pump);
    this.#context.world()?.requestWorldStateTime?.();
    this.#releaseNativeBankCursor = publishFrameXmlNativeBankCursor({
      clickBankSlot: (slot) => this.clickNativeBankSlot(slot.bag, slot.slot),
    });
    // Reattachment can follow a world reset. The first poll must describe the new world's current
    // state, not compare it with the old world's signatures.
    this.#polledAt = Number.NEGATIVE_INFINITY;
    this.#meleeAnnounced = false;
    this.#combatAnnounced = false;
    this.#controlEdge.reset();
    this.#pendingLevelUp = undefined;
    this.#barSignature = "";
    this.#cooldownSignature = "";
    this.#itemCooldownSignature = "";
    this.#actionPage = this.actionBarPage();
    this.#mirrorTimerSignatures.clear();
    this.#spellSignature = "";
    this.#spellCooldownSignature = "";
    this.#shapeshiftSignature = "";
    this.#shapeshiftActiveSignature = "";
    this.#shapeshiftCooldownSignature = "";
    this.#bonusActionBarOffset = this.bonusBarOffset();
    this.#comboSignature = "";
    this.#bankSlotsBought = undefined;
    this.#bankerGuid = undefined;
    this.#merchantSignature = "";
    this.#trainerSelection = undefined;
    this.#trainerFilters.set("available", true);
    this.#trainerFilters.set("unavailable", true);
    this.#trainerFilters.set("used", false);
    this.#containerSignatures.clear();
    this.#inventorySignature = "";
    this.#statsSignature = "";
    this.#resistanceSignature = "";
    this.#attackPowerSignature = "";
    this.#rangedAttackPowerSignature = "";
    this.#attackSpeedSignature = "";
    this.#damageSignature = "";
    this.#rangedDamageSignature = "";
    this.#damageModifierSignature = "";
    this.#questLogSignature = "";
    this.#unitQuestLogSignature = "";
    this.#questProgressSignature = "";
    this.#questMetadataPrefetchSignature = "";
    this.#questMetadataInvalidated = false;
    this.#questSelection = 0;
    this.#invalidateCurrentMapQuestIds();
    this.#reputationSignature = "";
    this.#skillSignature = "";
    this.#honorSignature = "";
    this.#honorCurrencySignature = "";
    // Keep this monotonic across detach/reattach. The resolver cache is intentionally shared by
    // the seam, so resetting to zero could make a newly attached world with the same player object
    // look unchanged and retain rows from the previous world snapshot.
    this.#skillRevision += 1;
    this.#talentRevision += 1;
    this.#talentMetadataRevision = Number.NaN;
    this.#petTalentOwnerSeen = false;
    this.#petTalentOwnerGuid = undefined;
    this.#petTalentsAtOwnerChange = undefined;
    this.#awaitPetTalentPacket = false;
    this.#selectedSkillId = undefined;
    this.#collapsedSkillCategories.clear();
    this.#selectedFactionId = undefined;
    this.#selectedBattleground = 1;
    this.#arenaListWorld = undefined;
    this.#arenaListReference = undefined;
    this.#arenaListFresh = false;
    this.#arenaWasPublished = false;
    this.#arenaClosing = false;
    if (this.#arenaInitialAttach) {
      this.#arenaInitialAttach = false;
      const initialWorld = this.#context.world();
      const initialList = initialWorld?.battlefieldList;
      if (initialWorld && initialList !== undefined) {
        this.#arenaListWorld = initialWorld;
        this.#arenaListReference = initialList;
        this.#arenaListFresh = true;
      }
    }
    this.#watchedFactionId = undefined;
    this.#collapsedFactionIds.clear();
    this.#inactiveFactionOverrides.clear();
    this.#atWarFactionOverrides.clear();
    this.#unwatchedQuestIds.clear();
    this.#invalidateSpellEntries();
    this.#health = -1;
    this.#money = this.#currentMoney();
    this.#power = -1;
    this.#powerMax = -1;
    this.#powerType = -1;
    this.#targetGuid = this.#target()?.guid;
    this.#targetName = this.#targetNameFor(this.#target()) ?? "";
    this.#comboSignature = String(this.comboPoints("player", "target"));
    this.#bankSlotsBought = this.bankSlots()?.[0];
    this.#bankerGuid = this.#context.world()?.bankerGuid;
    this.#targetTargetGuid = this.#targetTarget()?.guid;
    this.#targetTargetName = this.#targetNameFor(this.#targetTarget()) ?? "";
    this.#focusGuid = this.#focus()?.guid;
    this.#focusName = this.#targetNameFor(this.#focus()) ?? "";
    this.#petGuid = this.#pet()?.guid;
    this.#petName = this.#targetNameFor(this.#pet()) ?? "";
    this.#partySignature = this.#partyShapeSignature();
    this.#zoneKnown = false;
    this.#zoneMapId = undefined;
    this.#zoneId = undefined;
    this.#areaId = undefined;
    this.#worldMapAreaKnown = true;
    this.#worldMapAreaId = this.#resolvedWorldMapAreaId();
    this.#zoneShapeKnown = false;
    this.#zoneMinimapText = undefined;
    this.#zoneText = undefined;
    this.#zoneSubZoneText = undefined;
    this.#zonePvpType = undefined;
    this.#zoneIsSubZonePvp = undefined;
    this.#zoneFactionName = undefined;
    this.#auraSignature = this.#auraShapeSignature("player");
    this.#targetAuraSignature = this.#auraShapeSignature("target");
    this.#focusAuraSignature = this.#auraShapeSignature("focus");
    this.#targetTargetAuraSignature = this.#auraShapeSignature("targettarget");
    this.#petAuraSignature = this.#auraShapeSignature("pet");
    this.#castStates.clear();
    this.#chatLineId = 0;
    // Empty shapes: the first poll after attach publishes whatever the world already has (a
    // tracker switched on before the mount, mail waiting at login, a queue in progress).
    this.#mouseoverGuid = undefined;
    this.#trackingSignature = "";
    this.#mailSignature = "";
    this.#mailQueryWorld = undefined;
    this.#lfgSignature = "";
    this.#instanceSignature = "";
    const store = this.#context.store();
    if (store) {
      // PLAYER_SKILL_INFO_1_1 is a 384-word private array. Subscribe to the complete named field
      // when the store exposes its range primitive; the 60 ms signature poll remains the
      // compatibility path for older focused store doubles.
      const fieldRange = (store as unknown as {
        fieldRange?: (subject: typeof SELF, name: "PLAYER_SKILL_INFO_1_1", listener: () => void) => (() => void);
      }).fieldRange;
      if (typeof fieldRange === "function") {
        this.#unsubscribe.push(fieldRange.call(store, SELF, "PLAYER_SKILL_INFO_1_1", () => {
          this.#skillRevision += 1;
          this.#publishSkillLinesChanged();
        }));
      }
      // HonorFrame reads six private player words. Subscribe to each named word rather than polling
      // or interpreting PLAYER_FIELD_BYTES2; the resolver returns undefined until all are present.
      // Keep the two stock event families separate: kill/contribution fields refresh
      // PLAYER_PVP_KILLS_CHANGED, while currency fields refresh HONOR_CURRENCY_UPDATE.
      for (const name of [
        "PLAYER_FIELD_KILLS",
        "PLAYER_FIELD_TODAY_CONTRIBUTION",
        "PLAYER_FIELD_YESTERDAY_CONTRIBUTION",
        "PLAYER_FIELD_LIFETIME_HONORABLE_KILLS",
      ] as const) {
        this.#unsubscribe.push(store.field(SELF, name, () => this.#publishHonorChanged("stats")));
      }
      for (const name of [
        "PLAYER_FIELD_HONOR_CURRENCY",
        "PLAYER_FIELD_ARENA_CURRENCY",
      ] as const) {
        this.#unsubscribe.push(store.field(SELF, name, () => this.#publishHonorChanged("currency")));
      }
      // The store is the cheap half: a field subscription costs nothing until the field moves, and
      // health is the field that moves most. Everything the store cannot answer — the bar's
      // contents, the cooldown table — is polled in `tick`, because neither lives in a field.
      this.#unsubscribe.push(store.field(SELF, "UNIT_FIELD_HEALTH", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.health, "player");
      }));
      // The combat flag is UNIT_FIELD_FLAGS' bit 19: PLAYER_REGEN_* within the frame it lands in;
      // the fear/confusion/possession bits are PLAYER_CONTROL_* the same way (FrameXmlControl.ts).
      this.#unsubscribe.push(store.field(SELF, "UNIT_FIELD_FLAGS", () => {
        this.#reconcileCombat();
        this.#reconcileControl();
      }));
      this.#unsubscribe.push(store.field(SELF, "UNIT_FIELD_MAXHEALTH", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.maxHealth, "player");
      }));
      this.#unsubscribe.push(store.field(SELF, "UNIT_FIELD_LEVEL", () => {
        // PlayerFrame.lua listens to UNIT_LEVEL for the level text. PLAYER_LEVEL_UP is the level-up
        // packet's own event (#publishLevelUp), not this field's: the field also moves at login,
        // where a bare PLAYER_LEVEL_UP made ChatFrame.lua:2567 raise on `format(LEVEL_UP, nil)`.
        pump.fire(FRAMEXML_SEAM_EVENTS.unitLevel, "player");
        this.#publishLevelUp();
      }));
      // The form byte is written by Unit::SetShapeshiftForm. Publish the action-page edge as
      // soon as that authoritative field arrives; the 60 ms poll also catches metadata arrival.
      this.#unsubscribe.push(store.field(SELF, "UNIT_FIELD_BYTES_2", () => {
        this.#reconcileShapeshiftActive();
        this.#reconcileBonusActionBar();
      }));
      this.#unsubscribe.push(store.field(SELF, "PLAYER_XP", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.experience);
      }));
      // One word carries the inn bit, AFK and DND (Player.h:354-359), and stock keeps a listener
      // per family: PLAYER_UPDATE_RESTING repaints the «zzz» (PlayerFrame_UpdateStatus) and
      // PLAYER_FLAGS_CHANGED("player") the «<AFK>» name — so each bit family gets its own edge,
      // and a ghost/GM bit moving fires neither.
      let playerFlags = this.#playerFlags() ?? 0;
      this.#unsubscribe.push(store.field(SELF, "PLAYER_FLAGS", () => {
        const next = this.#playerFlags() ?? 0;
        const changed = playerFlags ^ next;
        playerFlags = next;
        if ((changed & PLAYER_FLAGS_RESTING) !== 0) pump.fire(FRAMEXML_SEAM_EVENTS.resting);
        if ((changed & (PLAYER_FLAGS_AFK | PLAYER_FLAGS_DND)) !== 0) pump.fire(FRAMEXML_SEAM_EVENTS.playerFlags, "player");
      }));
      // The rested bonus ticks down with every kill (ExhaustionTick_OnEvent redraws the tick).
      this.#unsubscribe.push(store.field(SELF, "PLAYER_REST_STATE_EXPERIENCE", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.exhaustion);
      }));
      // PLAYER_AMMO_ID is the AmmoSlot's item (`#ammoEntry`), written by Player::SetAmmo/RemoveAmmo.
      // The stock slot repaints on UNIT_INVENTORY_CHANGED("player") (PaperDollFrame.lua:1192, the
      // AmmoSlot's OnEvent in PaperDollFrame.xml), so a new ammo takes that edge at once; the carried
      // count moving under it (a shot, a sale) is caught by the paper doll's 60 ms poll in `tick`.
      this.#unsubscribe.push(store.field(SELF, "PLAYER_AMMO_ID", () => this.#reconcilePaperDollInventory()));
      // Inventory fields have no named WorldStore event. `any` is the store's coalesced mutation
      // edge, so one packet batch produces at most one BAG_UPDATE per changed stock container and
      // one PLAYER_MONEY edge for changed coinage.
      const any = (store as unknown as {
        any?: (listener: () => void) => (() => void);
      }).any;
      if (typeof any === "function") {
        // `any` fires on every flush in which anything at all changed, which in a crowd is every
        // frame, while the containers and the carried counts only move with the player's own slot
        // fields and item objects. The store's inventory watch (`Inventory.ts`) says when those
        // did, so the two signature walks below run for an inventory change and not for a
        // neighbour's step. Cached textures and names are still caught by the 60 ms poll in `tick`
        // (containers) and by the cache edges below (quests); a cache change that has no edge of
        // its own is picked up by the same bounded poll here. A focused store double without the
        // watch's primitives keeps the old every-flush behaviour.
        const watch = typeof (store as { fieldRange?: unknown }).fieldRange === "function"
          && typeof (store as { object?: unknown }).object === "function" && store.events && store.state
          ? inventoryWatch(store) : undefined;
        // Attach seeds the container and quest signatures itself (`#reconcileContainers(true)`
        // below), so the inventory as it stands now is the one they were built from.
        let seenRevision = watch?.revision;
        let questPolledAt = Number.NEGATIVE_INFINITY;
        // The quest log's own words — a kill counter, an accepted quest — are the other store input
        // of the quest signature. Their event is emitted earlier in the same flush than `any`.
        let questFieldsMoved = false;
        if (watch) {
          this.#unsubscribe.push(store.events.on("PLAYER_QUEST_LOG_UPDATE", ({ guid }) => {
            if (guid === this.#selfGuid()) questFieldsMoved = true;
          }));
        }
        this.#unsubscribe.push(any.call(store, () => {
          const revision = watch?.revision;
          const inventoryMoved = revision === undefined || revision !== seenRevision;
          seenRevision = revision;
          if (inventoryMoved) this.#reconcileContainers();
          this.#reconcileMoney();
          this.#reconcileBankSlots();
          // PLAYERBANKSLOTS_CHANGED and the bank bags' BAG_UPDATE (FrameXmlBank.ts).
          this.bank.reconcile();
          // Item-objective progress is derived from the same carried fields. The signature gate
          // keeps ordinary inventory changes quiet when no quest objective count moved.
          const now = typeof this.#context.monotonic === "function" ? this.#context.monotonic() : performance.now();
          if (inventoryMoved || questFieldsMoved || now - questPolledAt >= LIVE_POLL_SECONDS * 1000) {
            questFieldsMoved = false;
            questPolledAt = now;
            this.#publishQuestLogChange();
          }
        }));
      }
      // Selection is a WorldClient property rather than a store field. Store events still carry
      // the authoritative updates for whichever object is currently selected. The small guard is
      // intentional: older player-only test doubles supplied just `field`, and player/cast seams
      // must retain their detach behavior when no event bus is present.
      const events = store.events;
      if (events) {
        this.#unsubscribe.push(events.on("OBJECT_CREATED", () => {
          this.#reconcileTarget();
          this.#reconcileTargetTarget();
          this.#reconcileFocus();
          this.#reconcilePet();
        }));
        this.#unsubscribe.push(events.on("OBJECT_DESTROYED", () => {
          this.#reconcileTarget();
          this.#reconcileTargetTarget();
          this.#reconcileFocus();
          this.#reconcilePet();
        }));
        this.#unsubscribe.push(events.on("PLAYER_ENTERING_WORLD", () => {
          this.#reconcileTarget();
          this.#reconcileTargetTarget();
          this.#reconcileFocus();
          this.#reconcilePet();
          this.#skillRevision += 1;
          this.#publishSkillLinesChanged();
        }));
        this.#unsubscribe.push(events.on("UNIT_TARGET", ({ guid }) => {
          // `UNIT_FIELD_TARGET` is the server's target mirror. It is only a selection edge when it
          // belongs to this client's own unit; a neighbour changing whom *they* target must not
          // repaint this player's TargetFrame.
          if (guid === this.#selfGuid()) this.#reconcileTarget();
          if (guid === this.#targetGuid && this.#target()?.guid === guid) this.#reconcileTargetTarget();
          // FocusFrame's OnEvent runs TargetofTarget_Update(self.totFrame) for UNIT_TARGET of its
          // own unit; the focus's target has no cached identity here, its frame reads it back.
          if (guid === this.#focusGuid && this.#focus()?.guid === guid) pump.fire(FRAMEXML_SEAM_EVENTS.unitTarget, "focus");
        }));
        const targetField = <Name extends "UNIT_HEALTH" | "UNIT_MAX_HEALTH" | "UNIT_LEVEL" | "UNIT_FACTION" | "UNIT_DISPLAY_POWER" | "UNIT_POWER" | "UNIT_MAX_POWER">(
          name: Name,
          event: string,
        ): void => {
          this.#unsubscribe.push(events.on(name, ({ guid }) => {
            this.#reconcileTarget();
            this.#reconcileTargetTarget();
            this.#reconcileFocus();
            this.#reconcilePet();
            if (guid === this.#targetGuid && this.#target()?.guid === guid) {
              if (event === FRAMEXML_SEAM_EVENTS.health || event === FRAMEXML_SEAM_EVENTS.maxHealth
                || event === FRAMEXML_SEAM_EVENTS.unitLevel || event === FRAMEXML_SEAM_EVENTS.faction
                || event === FRAMEXML_SEAM_EVENTS.unitDisplayPower) {
                pump.fire(event, "target");
              } else {
                const powerType = this.#target() ? unitField.powerType(this.#target()!) ?? 0 : 0;
                pump.fire(event === "UNIT_POWER"
                  ? (FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA")
                  : (FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA"), "target");
              }
            }
            if (guid === this.#petGuid && this.#pet()?.guid === guid) {
              if (event === FRAMEXML_SEAM_EVENTS.health || event === FRAMEXML_SEAM_EVENTS.maxHealth
                || event === FRAMEXML_SEAM_EVENTS.unitLevel || event === FRAMEXML_SEAM_EVENTS.faction
                || event === FRAMEXML_SEAM_EVENTS.unitDisplayPower) {
                pump.fire(event, "pet");
              } else {
                const powerType = this.#pet() ? unitField.powerType(this.#pet()!) ?? 0 : 0;
                pump.fire(event === "UNIT_POWER"
                  ? (FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA")
                  : (FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA"), "pet");
              }
            }
            if (guid === this.#focusGuid && this.#focus()?.guid === guid) {
              if (event === FRAMEXML_SEAM_EVENTS.health || event === FRAMEXML_SEAM_EVENTS.maxHealth
                || event === FRAMEXML_SEAM_EVENTS.unitLevel || event === FRAMEXML_SEAM_EVENTS.faction
                || event === FRAMEXML_SEAM_EVENTS.unitDisplayPower) {
                pump.fire(event, "focus");
              } else {
                const powerType = this.#focus() ? unitField.powerType(this.#focus()!) ?? 0 : 0;
                pump.fire(event === "UNIT_POWER"
                  ? (FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA")
                  : (FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA"), "focus");
              }
            }
            if (guid === this.#targetTargetGuid && this.#targetTarget()?.guid === guid) {
              if (event === FRAMEXML_SEAM_EVENTS.health || event === FRAMEXML_SEAM_EVENTS.maxHealth
                || event === FRAMEXML_SEAM_EVENTS.unitLevel || event === FRAMEXML_SEAM_EVENTS.faction
                || event === FRAMEXML_SEAM_EVENTS.unitDisplayPower) {
                pump.fire(event, "targettarget");
              } else {
                const powerType = this.#targetTarget()
                  ? unitField.powerType(this.#targetTarget()!) ?? 0 : 0;
                pump.fire(event === "UNIT_POWER"
                  ? (FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA")
                  : (FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA"), "targettarget");
              }
            }
            // The focus's target has no cached identity (its frame is shown by TargetFrame_OnUpdate
            // polling UnitExists); resolving it here is two map reads per event.
            const focusTarget = this.#focusTarget();
            if (focusTarget !== undefined && focusTarget.guid === guid) {
              if (event === FRAMEXML_SEAM_EVENTS.health || event === FRAMEXML_SEAM_EVENTS.maxHealth
                || event === FRAMEXML_SEAM_EVENTS.unitLevel || event === FRAMEXML_SEAM_EVENTS.faction
                || event === FRAMEXML_SEAM_EVENTS.unitDisplayPower) {
                pump.fire(event, "focus-target");
              } else {
                const powerType = unitField.powerType(focusTarget) ?? 0;
                pump.fire(event === "UNIT_POWER"
                  ? (FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA")
                  : (FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA"), "focus-target");
              }
            }
            const partyUnit = this.#partyUnitForGuid(guid);
            if (partyUnit) {
              if (event === FRAMEXML_SEAM_EVENTS.health || event === FRAMEXML_SEAM_EVENTS.maxHealth
                || event === FRAMEXML_SEAM_EVENTS.unitLevel || event === FRAMEXML_SEAM_EVENTS.faction
                || event === FRAMEXML_SEAM_EVENTS.unitDisplayPower) {
                pump.fire(event, partyUnit);
              } else {
                const powerType = this.#partyPowerType(guid);
                pump.fire(event === "UNIT_POWER"
                  ? (FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA")
                  : (FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA"), partyUnit);
              }
            }
          }));
        };
        targetField("UNIT_HEALTH", FRAMEXML_SEAM_EVENTS.health);
        targetField("UNIT_MAX_HEALTH", FRAMEXML_SEAM_EVENTS.maxHealth);
        targetField("UNIT_LEVEL", FRAMEXML_SEAM_EVENTS.unitLevel);
        targetField("UNIT_FACTION", FRAMEXML_SEAM_EVENTS.faction);
        targetField("UNIT_DISPLAY_POWER", FRAMEXML_SEAM_EVENTS.unitDisplayPower);
        targetField("UNIT_POWER", "UNIT_POWER");
        targetField("UNIT_MAX_POWER", "UNIT_MAX_POWER");
        this.#unsubscribe.push(events.on("PLAYER_QUEST_LOG_UPDATE", ({ guid }) => {
          if (guid !== this.#selfGuid()) return;
          this.#publishQuestUnitChange();
        }));
        this.#unsubscribe.push(events.on("UNIT_DYNAMIC_FLAGS", ({ guid }) => {
          if (guid === this.#targetGuid && this.#target()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.aura, "target");
          } else if (guid === this.#focusGuid && this.#focus()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.aura, "focus");
          } else if (guid === this.#targetTargetGuid && this.#targetTarget()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.aura, "targettarget");
          } else if (guid === this.#petGuid && this.#pet()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.aura, "pet");
          }
        }));
        this.#unsubscribe.push(events.on("UNIT_FLAGS", ({ guid }) => {
          if (guid === this.#targetGuid && this.#target()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.playerFlags, "target");
          } else if (guid === this.#focusGuid && this.#focus()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.playerFlags, "focus");
          } else if (guid === this.#targetTargetGuid && this.#targetTarget()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.playerFlags, "targettarget");
          }
        }));
        // UNIT_FIELD_DISPLAYID arriving or changing (the player's own on login, a shapeshift, a
        // mount) is the client's UNIT_PORTRAIT_UPDATE: CharacterMicroButton_OnEvent and
        // UnitFrame_OnEvent call SetPortraitTexture again for that unit, which is how a stock
        // claim made before the object was in view gets its face.
        this.#unsubscribe.push(events.on("UNIT_DISPLAY_ID", ({ guid }) => {
          const unit = this.#castUnit(guid) ?? (guid === this.#focusTarget()?.guid ? "focus-target" : undefined);
          if (unit !== undefined) pump.fire(FRAMEXML_SEAM_EVENTS.unitPortrait, unit);
        }));
        this.#unsubscribe.push(events.on("UNIT_NPC_FLAGS", ({ guid }) => {
          if (guid === this.#targetGuid && this.#target()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.classification, "target");
          } else if (guid === this.#focusGuid && this.#focus()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.classification, "focus");
          } else if (guid === this.#targetTargetGuid && this.#targetTarget()?.guid === guid) {
            pump.fire(FRAMEXML_SEAM_EVENTS.classification, "targettarget");
          }
        }));
      }
    }
    const world = this.#context.world();
    if (world) {
      this.#unsubscribe.push(world.events.on("BANK_OPENED", ({ bankerGuid }) => {
        if (bankerGuid === undefined) this.clearCursor();
        if (bankerGuid === this.#bankerGuid) return;
        this.#bankerGuid = bankerGuid;
        pump.fire(bankerGuid === undefined
          ? FRAMEXML_SEAM_EVENTS.bankFrameClosed : FRAMEXML_SEAM_EVENTS.bankFrameOpened);
      }));
      this.#unsubscribe.push(world.events.on("COMBO_POINTS_CHANGED", () => this.#reconcileComboPoints()));
      // MSG_RAID_TARGET_UPDATE, whole list or one mark: TargetFrame/FocusFrame re-read
      // GetRaidTargetIndex(self.unit) on the stock event and carry no argument.
      this.#unsubscribe.push(world.events.on("RAID_TARGET_UPDATE", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.raidTarget);
      }));
      // INIT_WORLD_STATES is the authoritative map/zone/area edge. The same primitive comparison
      // is also run in tick because mapId can become known on the movement path first.
      this.#reconcileZone(true);
      // ChatFrame_OnLoad initially registers only channel traffic. Configure its saved window
      // groups before replaying lines so the initial backlog reaches the freshly loaded frame.
      // Real WorldClient always owns a channel Map.  Keep older focused seam doubles that only
      // model auras/casts/minimap free of a synthetic chat configuration edge.
      if (world.channels instanceof Map) this.#chatWindowsUpdated(pump, true);
      this.#replayChat(world, pump);
      const previousGroupCallback = world.onGroupChanged;
      // The player's own role byte rides the group list header (SMSG_GROUP_LIST `ownRoles`);
      // PlayerFrame refreshes its role icon on PLAYER_ROLES_ASSIGNED, not on the roster edge.
      let ownRoles = world.group?.ownRoles;
      const groupCallback = () => {
        try {
          previousGroupCallback?.();
        } finally {
          this.#reconcileParty();
          pump.fire(FRAMEXML_SEAM_EVENTS.partyLeaderChanged);
          const roles = world.group?.ownRoles;
          if (roles !== ownRoles) {
            ownRoles = roles;
            pump.fire(FRAMEXML_SEAM_EVENTS.playerRolesAssigned);
          }
        }
      };
      world.onGroupChanged = groupCallback;
      this.#unsubscribe.push(() => {
        if (world.onGroupChanged === groupCallback) world.onGroupChanged = previousGroupCallback;
      });
      const previousTrainerCallback = world.onTrainerChanged;
      const trainerCallback = () => {
        try { previousTrainerCallback?.(); }
        finally {
          this.#trainerSelection = this.trainerServiceCount() > 0 ? 1 : undefined;
          // EnterWorld's single owner routes this callback to either stock or native UI. A direct
          // seam mount has no such callback, so only that standalone path emits the stock edge.
          if (!previousTrainerCallback) pump.fire(FRAMEXML_SEAM_EVENTS.trainerUpdate);
        }
      };
      world.onTrainerChanged = trainerCallback;
      this.#unsubscribe.push(() => {
        if (world.onTrainerChanged === trainerCallback) world.onTrainerChanged = previousTrainerCallback;
      });
      if (this.#partySignature !== "") pump.fire(FRAMEXML_SEAM_EVENTS.partyMembers);
      // SMSG_LEVELUP_INFO precedes the level it announces (`Player::GiveLevel` sends it before
      // SetLevel); the event waits for the level field so the talent points can be measured.
      this.#unsubscribe.push(world.events.on("LEVEL_UP", (info) => {
        const self = this.#self();
        this.#pendingLevelUp = {
          info, pointsBefore: self ? readField(self, "PLAYER_CHARACTER_POINTS1") ?? 0 : 0,
        };
        this.#publishLevelUp();
      }));
      this.#unsubscribe.push(world.events.on("PET_BAR_CHANGED", () => {
        this.#reconcilePet(true);
      }));
      this.#unsubscribe.push(world.events.on("TALENTS_CHANGED", ({ pet }) => {
        // WorldClient emits once per authoritative talent packet/reset. Stock Blizzard_TalentUI
        // listens to separate player and pet edges; neither is a polled synthetic packet.
        this.#talentRevision += 1;
        this.#pump?.fire(pet ? FRAMEXML_SEAM_EVENTS.petTalentsChanged
          : FRAMEXML_SEAM_EVENTS.talentsChanged);
      }));
      this.#unsubscribe.push(world.events.on("CHAT_MESSAGE", (message) => {
        this.#emitChatMessage(pump, world, message);
      }));
      // Only when the channel list stock reads has changed: a member count or a roster leaves
      // `GetChatWindowChannels` as it was (`#chatWindowsUpdated`).
      this.#unsubscribe.push(world.events.on("CHANNEL_CHANGED", () => {
        this.#chatWindowsUpdated(pump);
      }));
      this.#unsubscribe.push(world.events.on("WORLD_STATE_CHANGED", () => {
        this.#invalidateCurrentMapQuestIds();
        this.#reconcileZone(true);
      }));
      this.#unsubscribe.push(world.events.on("WORLD_STATE_CHANGED", ({ variableId }) => {
        if (variableId === undefined || variableId === 3191) {
          // ArenaFrame repaints its season/rated affordances on the stock status edge. Do not
          // synthesize a battlemaster list or SHOW event when the list context is absent.
          if (this.isBattlefieldArena()) pump.fire(FRAMEXML_SEAM_EVENTS.battlefieldStatus);
        }
      }));
      this.#unsubscribe.push(world.events.on("QUEST_LOG_CHANGED", () => {
        this.#invalidateCurrentMapQuestIds();
        this.#publishQuestLogChange();
      }));
      this.#unsubscribe.push(world.events.on("REPUTATION_CHANGED", () => {
        this.#publishReputationChanged();
      }));
      // WorldClient already owns the packet parsing and queue/list state. Forward only the exact
      // stock edges; the registrations are removed with the rest of this seam on every detach.
      this.#unsubscribe.push(world.events.on("BATTLEFIELD_QUEUE_CHANGED", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.battlefieldStatus);
      }));
      this.#unsubscribe.push(world.events.on("BATTLEFIELD_LIST_CHANGED", () => {
        const previousArena = this.#arenaWasPublished;
        const list = world.battlefieldList;
        const nextArena = isArenaBattlefieldList(list);
        if (previousArena && !nextArena) {
          // Stock ArenaFrame checks IsBattlefieldArena before processing BATTLEFIELDS_CLOSED. Keep
          // the prior packet context authoritative for this synchronous close dispatch, then
          // publish the new queue/stale state below.
          this.#arenaClosing = true;
          pump.fire(FRAMEXML_SEAM_EVENTS.arenaClose);
          this.#arenaClosing = false;
        }
        this.#arenaListWorld = list === undefined ? undefined : world;
        this.#arenaListReference = list;
        this.#arenaListFresh = list !== undefined;
        const currentArena = nextArena;
        this.#arenaWasPublished = currentArena;
        pump.fire(FRAMEXML_SEAM_EVENTS.battlefieldList);
        if (currentArena && !previousArena) pump.fire(FRAMEXML_SEAM_EVENTS.arenaShow);
      }));
      this.#unsubscribe.push(world.events.on("QUEST_PROGRESS", (event) => {
        this.#publishQuestProgress(event);
      }));
      this.#unsubscribe.push(world.events.on("QUEST_POI", () => {
        // The payload is intentionally empty in WorldClient; the packet itself is the
        // authoritative edge and there is no per-rAF POI scan here.
        this.#invalidateCurrentMapQuestIds();
        pump.fire(FRAMEXML_SEAM_EVENTS.questPoiUpdate);
        // Keep the stock tracker fresh even when the optional WorldMapFrame is not mounted.
        pump.fire(FRAMEXML_SEAM_EVENTS.worldMapUpdate);
      }));
      // FrameXML may mount after login, while a cast is already running. Capture its identity now:
      // WorldClient removes the map entry before publishing STOP, so a later fallback cannot know
      // whether this was a channel or which castID CastingBarFrame put on its bar.
      // FrameXML can mount after either the player or selected target has started casting. Keep
      // both identities until their STOP edge; WorldClient deletes the map entry first.
      for (const guid of [
        this.#selfGuid(), this.#targetGuid, this.#focusGuid, this.#targetTargetGuid, this.#petGuid,
      ]) {
        const cast = guid === undefined ? undefined : world.casts.get(guid);
        if (guid !== undefined && cast) {
          this.#castStates.set(guid, {
            spellId: cast.spellId,
            channel: cast.channel,
            castID: cast.castCount,
          });
        }
      }
      this.#unsubscribe.push(world.events.on("SPELL_CAST_START", (event) => {
        const unit = this.#castUnit(event.casterGuid);
        if (unit === undefined) return;
        const cast = world.casts.get(event.casterGuid);
        const state: LiveCastState = {
          spellId: cast?.spellId ?? event.spellId,
          channel: event.channel,
          castID: cast?.castCount,
        };
        this.#castStates.set(event.casterGuid, state);
        if (state.channel) {
          pump.fire(FRAMEXML_SEAM_EVENTS.channelStart, unit);
        } else {
          pump.fire(FRAMEXML_SEAM_EVENTS.castStart, unit, ...this.#castIdentity(state));
        }
      }));
      this.#unsubscribe.push(world.events.on("SPELL_CAST_STOP", (event) => {
        const unit = this.#castUnit(event.casterGuid);
        if (unit === undefined) {
          // A target can be deselected before its STOP packet arrives. Do not let that old
          // identity leak into a later selection, and never repaint the new target.
          if (event.casterGuid !== this.#selfGuid()) this.#castStates.delete(event.casterGuid);
          return;
        }
        const state = this.#castStates.get(event.casterGuid);
        const cast = world.casts.get(event.casterGuid);
        const effective: LiveCastState = state ?? {
          spellId: cast?.spellId ?? event.spellId,
          channel: cast?.channel ?? false,
          castID: cast?.castCount,
        };
        if (effective.channel) {
          pump.fire(FRAMEXML_SEAM_EVENTS.channelStop, unit);
        } else {
          // `interrupted` remains for older listeners; reason is authoritative when present.
          const reason = event.reason ?? (event.interrupted ? "interrupted" : "success");
          const eventName = reason === "failed"
            ? FRAMEXML_SEAM_EVENTS.castFailed
            : reason === "interrupted"
              ? FRAMEXML_SEAM_EVENTS.castInterrupted
              : FRAMEXML_SEAM_EVENTS.castStop;
          pump.fire(eventName, unit, ...this.#castIdentity(effective));
        }
        this.#castStates.delete(event.casterGuid);
      }));
      this.#unsubscribe.push(world.events.on("SPELL_CAST_DELAYED", (event) => {
        const unit = this.#castUnit(event.casterGuid);
        if (unit === undefined) return;
        const cast = world.casts.get(event.casterGuid);
        const state = this.#castStates.get(event.casterGuid);
        const effective: LiveCastState = state ?? {
          spellId: cast?.spellId ?? 0,
          channel: cast?.channel ?? false,
          castID: cast?.castCount,
        };
        // The protocol has no failure distinction here. DELAYED is the only truthful event.
        pump.fire(FRAMEXML_SEAM_EVENTS.castDelayed, unit, ...this.#castIdentity(effective));
      }));
      this.#unsubscribe.push(world.events.on("SPELL_CHANNEL_UPDATE", (event) => {
        const unit = this.#castUnit(event.casterGuid);
        if (unit === undefined) return;
        // WorldClient emits the zero update immediately before deleting the cast and then emits
        // SPELL_CAST_STOP. Let that STOP become CHANNEL_STOP; this event is only the update edge.
        pump.fire(FRAMEXML_SEAM_EVENTS.channelUpdate, unit);
      }));
      // SpellBookFrame is deliberately driven through the packet bus instead of claiming the
      // WorldClient's single legacy onSpellsChanged/onCooldownsChanged callbacks. The poll below
      // still catches removals and initial-spell replacement, for which the packet bus has no
      // dedicated event, while these edges make a learned spell/cooldown repaint immediate.
      this.#unsubscribe.push(world.events.on("SPELL_LEARNED", (event) => {
        this.#invalidateSpellEntries();
        pump.fire(FRAMEXML_SEAM_EVENTS.spellsChanged);
        // arg1 is the tab: SpellBookFrame_OnEvent concatenates it into
        // `"SpellBookSkillLineTab"..arg1.."Flash"` (SpellBookFrame.lua:62-64), which raised on a nil
        // for every spell learned. A spell with no tab yet (its line still loading) flashes nothing.
        const tab = this.#context.spellTabFor
          ? this.#context.spellTabFor(event.spellId)
          : this.#spellTabs(world).length > 0 ? 1 : undefined;
        if (tab !== undefined) pump.fire(FRAMEXML_SEAM_EVENTS.learnedSpellInTab, tab);
        this.#spellSignature = this.#spellShapeSignature(world);
      }));
      this.#unsubscribe.push(world.events.on("SPELL_COOLDOWN_STARTED", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.spellUpdateCooldown);
        this.#spellCooldownSignature = this.#spellCooldownShapeSignature(world);
        this.#reconcileItemCooldowns();
      }));
      this.#unsubscribe.push(world.events.on("ITEM_COOLDOWN_STARTED", () => {
        this.#reconcileItemCooldowns();
      }));
      this.#unsubscribe.push(world.events.on("QUERY_CACHE_CHANGED", (event) => {
        if (event.kind === "cleared") {
          // The realm invalidated every client query answer. Consume one forced refresh on the
          // current quest targets even when the metadata clients deliberately keep their old name
          // visible until replacement data arrives.
          this.#questMetadataPrefetchSignature = "";
          this.#questMetadataInvalidated = true;
          this.#publishQuestLogChange(true);
          return;
        }
        // Every visible piece of gear of every player in view, and every creature nearby, is asked
        // of the server, so a crowd answers a few hundred of these in a burst, and each one rebuilt
        // the signatures below. An answer can only move a signature that read its entry: the
        // carried slots and bags for the containers, the quests' reward, objective and target
        // entries for the log (recorded when each was last built; before that, every answer
        // counts).
        const entry = typeof event.id === "number" ? event.id : undefined;
        const concerns = (entries: Set<number> | undefined): boolean =>
          entry === undefined || entries === undefined || entries.has(entry);
        if (event.kind === "item") {
          // Item quality/name/bag-family metadata can arrive after the inventory update. The
          // signature includes those resolved fields, so ContainerFrame gets one redraw without
          // asking the query cache from a render loop.
          if (concerns(this.#containerEntries)) this.#reconcileContainers();
          // The open bank's slots and bank bags the same way (FrameXmlBank.ts; free with no banker).
          this.bank.reconcile();
          // QuestInfo reward rows use the same synchronous item metadata cache. Once a query
          // arrives, repaint the selected log so an unresolved row becomes a real icon/name.
          if (concerns(this.#questItemIds)) this.#publishQuestLogChange();
          return;
        }
        if (event.kind === "gameObject") {
          if (concerns(this.#questGameObjectIds)) this.#publishQuestLogChange();
          return;
        }
        if (event.kind !== "creature") return;
        if (concerns(this.#questCreatureIds)) this.#publishQuestLogChange();
        this.#reconcileFocus();
        this.#reconcileTargetTarget();
        const namedUnits: readonly [
          "target" | "focus" | "targettarget" | "pet", WorldObjectState | undefined, string,
        ][] = [
          ["target", this.#target(), this.#targetName],
          ["focus", this.#focus(), this.#focusName],
          ["targettarget", this.#targetTarget(), this.#targetTargetName],
          ["pet", this.#pet(), this.#petName],
        ];
        for (const [unit, object, previousName] of namedUnits) {
          if (!object || object.typeId !== TYPEID_UNIT) continue;
          const entry = readField(object, "OBJECT_FIELD_ENTRY");
          if (entry !== event.id) continue;
          const name = this.#targetNameFor(object) ?? "";
          if (name === previousName) continue;
          if (unit === "target") this.#targetName = name;
          else if (unit === "focus") this.#focusName = name;
          else if (unit === "targettarget") this.#targetTargetName = name;
          else this.#petName = name;
          pump.fire(FRAMEXML_SEAM_EVENTS.unitName, unit);
        }
      }));
      this.#unsubscribe.push(world.events.on("AURA_CHANGED", ({ guid }) => {
        // Focus is client-owned and ToT is derived from a mutable target field; reconcile both
        // before accepting an aura packet so an old GUID cannot repaint a newly bound unit token.
        this.#reconcileFocus();
        this.#reconcileTargetTarget();
        if (guid === this.#selfGuid()) {
          this.#auraSignature = this.#auraShapeSignature("player");
          pump.fire(FRAMEXML_SEAM_EVENTS.aura, "player");
        } else if (guid === this.#targetGuid && this.#target()?.guid === guid) {
          this.#targetAuraSignature = this.#auraShapeSignature("target");
          pump.fire(FRAMEXML_SEAM_EVENTS.aura, "target");
        } else if (guid === this.#focusGuid && this.#focus()?.guid === guid) {
          this.#focusAuraSignature = this.#auraShapeSignature("focus");
          pump.fire(FRAMEXML_SEAM_EVENTS.aura, "focus");
        } else if (guid === this.#targetTargetGuid && this.#targetTarget()?.guid === guid) {
          this.#targetTargetAuraSignature = this.#auraShapeSignature("targettarget");
          pump.fire(FRAMEXML_SEAM_EVENTS.aura, "targettarget");
        } else if (guid === this.#petGuid && this.#pet()?.guid === guid) {
          this.#petAuraSignature = this.#auraShapeSignature("pet");
          pump.fire(FRAMEXML_SEAM_EVENTS.aura, "pet");
        } else {
          const partyUnit = this.#partyUnitForGuid(guid);
          if (partyUnit) pump.fire(FRAMEXML_SEAM_EVENTS.aura, partyUnit);
        }
      }));
      this.#unsubscribe.push(world.events.on("PARTY_MEMBER_STATS", ({ guid }) => {
        this.#publishPartyStats(guid);
      }));
      // If FrameXML mounted after the inventory packet, seed the current player containers once.
      this.#reconcileContainers(true);
      this.#reconcilePaperDoll(true);
      this.#publishQuestLogChange(true);
      this.#publishQuestUnitChange();
      // WorldMapFrame normally primes this edge, but it is outside the bounded vertical world
      // slice. Replay it once so WatchFrame can apply its local-zone filter on first paint.
      pump.fire(FRAMEXML_SEAM_EVENTS.worldMapUpdate);
      this.#publishReputationChanged(true);
      this.#publishHonorChanged("all", true);
      if (this.#talentResolvers.talentSnapshot() !== undefined) {
        this.#talentMetadataRevision = this.#context.talentMetadataRevision?.() ?? 0;
        pump.fire(FRAMEXML_SEAM_EVENTS.talentsChanged);
      }
      if (this.#talentResolvers.petTalentSnapshot() !== undefined) {
        this.#talentMetadataRevision = this.#context.talentMetadataRevision?.() ?? 0;
        pump.fire(FRAMEXML_SEAM_EVENTS.petTalentsChanged);
      }
    }
    // If the list arrived before FrameXML mounted, expose it once to the freshly loaded stock
    // root; subsequent packet callbacks and the bounded poll use the same signature gate.
    this.#reconcileMerchant(true);
    pump.fire(FRAMEXML_SEAM_EVENTS.actionSlotChanged, 0);
    pump.fire(FRAMEXML_SEAM_EVENTS.actionCooldown);
    // FrameXML may mount after the server's initial aura packet. Seed one redraw only when there
    // is a real aura snapshot; an empty world needs no synthetic edge and keeps old seam fakes
    // that do not expose aura state compatible.
    if (this.#auraSignature !== "") pump.fire(FRAMEXML_SEAM_EVENTS.aura, "player");
    if (this.isBattlefieldArena()) {
      this.#arenaWasPublished = true;
      pump.fire(FRAMEXML_SEAM_EVENTS.battlefieldList);
      pump.fire(FRAMEXML_SEAM_EVENTS.arenaShow);
    }
  }

  detach(): void {
    this.worldStates.detach();
    this.calendar.detach();
    this.lfd.detach();
    detachLiveFrameXmlNpcWindows(this);
    this.loot.detach();
    this.popups.detach();
    this.friends.detach();
    this.mail.detach();
    this.trade.detach();
    this.currency.detach();
    this.arena.detach();
    this.auction.detach();
    this.socket.detach();
    this.inspect.detach();
    this.barber.detach();
    this.glyphs.detach();
    this.companions.detach();
    this.titles.detach();
    this.equipmentSets.detach();
    this.achievement.detach();
    this.guildBank.detach();
    this.tradeSkill.detach();
    this.macros.detach();
    this.cursor.detach();
    this.keyBindings.detach();
    this.map.detach();
    this.hudMechanics.detach();
    this.petActions.detach();
    this.chatColors.detach();
    this.threat.detach();
    this.mechanics.detach();
    this.clearCursor();
    this.#releaseNativeBankCursor?.();
    this.#releaseNativeBankCursor = undefined;
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#castStates.clear();
    this.#pump = undefined;
    this.#polledAt = Number.NEGATIVE_INFINITY;
    this.#barSignature = "";
    this.#cooldownSignature = "";
    this.#spellSignature = "";
    this.#spellCooldownSignature = "";
    this.#merchantSignature = "";
    this.#containerSignatures.clear();
    this.#inventorySignature = "";
    this.#statsSignature = "";
    this.#resistanceSignature = "";
    this.#attackPowerSignature = "";
    this.#rangedAttackPowerSignature = "";
    this.#attackSpeedSignature = "";
    this.#damageSignature = "";
    this.#rangedDamageSignature = "";
    this.#damageModifierSignature = "";
    this.#questLogSignature = "";
    this.#unitQuestLogSignature = "";
    this.#questProgressSignature = "";
    this.#questMetadataPrefetchSignature = "";
    this.#questMetadataInvalidated = false;
    this.#questSelection = 0;
    this.#invalidateCurrentMapQuestIds();
    this.#reputationSignature = "";
    this.#honorSignature = "";
    this.#honorCurrencySignature = "";
    this.#selectedFactionId = undefined;
    this.#watchedFactionId = undefined;
    this.#arenaListWorld = undefined;
    this.#arenaListReference = undefined;
    this.#arenaListFresh = false;
    this.#arenaWasPublished = false;
    this.#arenaClosing = false;
    this.#collapsedFactionIds.clear();
    this.#inactiveFactionOverrides.clear();
    this.#atWarFactionOverrides.clear();
    this.#unwatchedQuestIds.clear();
    this.#invalidateSpellEntries();
    this.#health = -1;
    this.#power = -1;
    this.#powerMax = -1;
    this.#powerType = -1;
    this.#targetGuid = undefined;
    this.#targetName = "";
    this.#targetTargetGuid = undefined;
    this.#targetTargetName = "";
    this.#focusGuid = undefined;
    this.#focusName = "";
    this.#petGuid = undefined;
    this.#petName = "";
    this.#partySignature = "";
    this.#zoneKnown = false;
    this.#zoneMapId = undefined;
    this.#zoneId = undefined;
    this.#areaId = undefined;
    this.#worldMapAreaKnown = false;
    this.#worldMapAreaId = undefined;
    this.#zoneShapeKnown = false;
    this.#zoneMinimapText = undefined;
    this.#zoneText = undefined;
    this.#zoneSubZoneText = undefined;
    this.#zonePvpType = undefined;
    this.#zoneIsSubZonePvp = undefined;
    this.#zoneFactionName = undefined;
    this.#auraSignature = "";
    this.#targetAuraSignature = "";
    this.#focusAuraSignature = "";
    this.#targetTargetAuraSignature = "";
    this.#petAuraSignature = "";
    this.#chatLineId = 0;
    this.#mouseoverGuid = undefined;
    this.#trackingSignature = "";
    this.#mailSignature = "";
    this.#mailQueryWorld = undefined;
    this.#lfgSignature = "";
    this.#instanceSignature = "";
  }

  #selfGuid(): bigint | undefined {
    return this.#context.world()?.state.selfGuid;
  }

  /** Emit one parsed line, translating the GUID/name boundary before Lua sees it. */
  #emitChatMessage(pump: FrameXmlSeamPump, world: WorldClient, message: ChatMessage): void {
    if (message.language === (LANG_ADDON | 0) || message.type === CHAT_MSG_ADDON) return;
    // An achievement line's `$a` link and `$g` gender are the client's to write, from the catalog;
    // the line waits for it once (FrameXmlAchievement.chatLine).
    const written = this.achievement.chatLine(message, (line) => { if (this.#pump === pump) this.#emitChatMessage(pump, world, line); });
    if (!written) return;
    message = written;
    if (message.channelNotice && this.#emitChannelNotice(pump, world, message.channelNotice)) return;
    const mappedEventName = frameXmlChatEventName(message.type);
    const eventName = mappedEventName ?? "CHAT_MSG_SYSTEM";
    const fallback = mappedEventName === undefined;
    const channel = message.type === CHAT_MSG_CHANNEL
      ? this.#channelInfo(world, message.channel)
      : undefined;
    // A channel line without a joined-channel match would be dropped by stock ChatFrame anyway;
    // suppressing it here also keeps the seam honest while the native chat is owned by FrameXML.
    if (message.type === CHAT_MSG_CHANNEL && channel === undefined) return;
    // Text the client wrote itself is prose: its pipes are doubled so stock parses them as
    // literal characters (`ChatMessage.local`). Server text keeps every escape it was sent with.
    const text = message.local ? frameXmlEscapeLocalChatText(message.text) : message.text;
    const displayMessage: ChatMessage = fallback
      ? {
        ...message,
        text,
        type: CHAT_MSG_SYSTEM,
        language: 0,
        senderGuid: 0n,
        senderName: "",
        receiverGuid: 0n,
        receiverName: "",
        channel: "",
        tag: 0,
      }
      : text === message.text ? message : { ...message, text };
    const sender = fallback ? "" : displayMessage.senderName
      || (displayMessage.senderGuid === world.state.selfGuid ? world.selfName : undefined)
      || (displayMessage.senderGuid === 0n ? "" : world.displayName(displayMessage.senderGuid));
    const args = frameXmlChatEventArgs(
      displayMessage,
      sender ?? "",
      ++this.#chatLineId,
      channel?.number ?? 0,
      channel?.shortName,
      channel?.displayName,
      this.locale,
      channel?.zoneChannelId ?? 0,
    );
    pump.fire(eventName, ...args);
  }

  /**
   * One `SMSG_CHANNEL_NOTIFY` as the client raises it: `CHAT_MSG_CHANNEL_NOTICE` (`_USER`, `_JOIN`,
   * `_LEAVE`) with stock's layout — `arg1` the notice token, `arg2` the player it is about, `arg4`
   * «N. name», `arg5` the second player (who kicked, who banned), `arg7` the zone channel id,
   * `arg8` the number, `arg9` the short name, and a number in `arg10`, which stock compares with 0
   * (ChatFrame.lua:2796). This is what keeps stock ChatFrame's own channel list true: it drops a
   * channel on `YOU_LEFT` alone (:2714-2717) and re-reads `GetChatWindowChannels` on
   * `UPDATE_CHAT_WINDOWS`, raised here ahead of a `YOU_JOINED` so the new channel is on the list
   * its own notice is filtered against.
   *
   * A join that replaced the zone channel of the same id (`ChannelNotify.replacedChannel`) is the
   * client's `YOU_CHANGED` («Смена канала: [1. Общий: Западный край]», GlobalStrings.lua:1611).
   * Its id and number are the old channel's; the list is re-read ahead of it only when the name
   * stock lists has changed (`#chatWindowsUpdated`).
   *
   * False — and the caller writes the native system line as before — when stock has no sentence
   * for the code, or the notice is about a channel the player is not in: stock shows a channel
   * notice only for a channel on its list (:2697-2724), so «wrong password» or «not in area» for a
   * channel never joined would be swallowed. `INVITE` is the exception stock itself makes.
   */
  #emitChannelNotice(pump: FrameXmlSeamPump, world: WorldClient, notice: ChannelNotify): boolean {
    const changed = notice.code === CHAT_YOU_JOINED_NOTICE && notice.replacedChannel !== undefined;
    const shape = changed
      ? { event: "CHAT_MSG_CHANNEL_NOTICE", token: "YOU_CHANGED" } as const
      : frameXmlChannelNotice(notice.code, notice.oldMemberFlags, notice.newMemberFlags);
    if (!shape) return false;
    const channel = this.#channelInfo(world, notice.channel);
    if (!channel && shape.token !== "INVITE") return false;
    if (notice.code === CHAT_YOU_JOINED_NOTICE) this.#chatWindowsUpdated(pump, !changed);
    const nameOf = (guid: bigint): string => guid === 0n ? ""
      : world.names?.get(guid) ?? (guid === world.state.selfGuid ? world.selfName : undefined)
        ?? world.displayName(guid);
    pump.fire(
      shape.event,
      shape.token,
      notice.name || nameOf(notice.guid),
      "",
      channel?.displayName ?? notice.channel,
      nameOf(notice.actorGuid),
      "",
      notice.channelId,
      channel?.number ?? 0,
      channel?.shortName ?? shortChannelName(notice.channel),
      0,
      ++this.#chatLineId,
      frameXmlGuid(notice.guid),
    );
    return true;
  }

  /**
   * Resolve an incoming channel name to stock ChatFrame's 1-based current channel slot: the held
   * channel of that exact name, else the first one sharing its short name (a replayed line from a
   * zone channel since swapped for the next zone's).
   */
  #channelInfo(world: WorldClient, channel: string): LiveChatChannel | undefined {
    if (!channel || !(world.channels instanceof Map)) return undefined;
    const wanted = shortChannelName(channel);
    const info = (name: string, number: number, channelId: number | undefined): LiveChatChannel => ({
      number,
      shortName: shortChannelName(name),
      displayName: displayChannelName(name, number),
      zoneChannelId: channelId ?? 0,
    });
    let byShortName: LiveChatChannel | undefined;
    let index = 1;
    for (const [name, held] of world.channels) {
      if (typeof name === "string") {
        if (name === channel) return info(name, index, held?.channelId);
        if (byShortName === undefined && shortChannelName(name) === wanted) {
          byShortName = info(name, index, held?.channelId);
        }
      }
      index += 1;
    }
    return byShortName;
  }

  /**
   * Raise UPDATE_CHAT_WINDOWS when `GetChatWindowChannels(1)` answers something new, or always
   * when `force`d (attach, a plain join, a replay that held notices).
   *
   * Every UPDATE_CHAT_WINDOWS re-runs `FloatingChatFrame_Update` and `ChatFrame_ConfigEventHandler`
   * for each window, and both `Show()` a window whose `shown` is set (FloatingChatFrame.lua:138-142,
   * ChatFrame.lua:2506-2508), while nothing in stock re-hides the dock's unselected frames
   * afterwards. The client itself raises this event only when chat settings load, so window 1's
   * `shown` is the chat cache's flag ChatFrame1 wrote from its own OnShow/OnHide
   * ({@link frameXmlGeneralWindowInfo}): with «Журнал боя» selected it is false and the update only
   * re-reads the lists. Before that, measured on the stock corpus, one update left ChatFrame1 and
   * ChatFrame2 both shown until «Общий» was clicked. A member count or a roster, which change
   * nothing stock reads, still raise nothing.
   *
   * A zone channel swapped in its slot still does when its name changes, as the dataset's
   * «Общий: %s» does (ChatChannels.dbc): stock matches a channel only while the incoming «N. name»
   * is longer than the listed name (ChatFrame.lua:2708), so a stale «Общий: Элвиннский лес» on the
   * list would swallow every line of a shorter «Общий: Даларан».
   */
  #chatWindowsUpdated(pump: FrameXmlSeamPump, force = false): void {
    const signature = JSON.stringify(this.chatWindowChannels(1));
    if (!force && signature === this.#chatWindowsSignature) return;
    this.#chatWindowsSignature = signature;
    pump.fire(FRAMEXML_SEAM_EVENTS.chatWindowsUpdated);
  }

  /** Replay only the newest bounded non-addon lines; the world backlog itself remains untouched. */
  #replayChat(world: WorldClient, pump: FrameXmlSeamPump): void {
    const replay: ChatMessage[] = [];
    const chatLog = world.chatLog ?? [];
    for (let index = chatLog.length - 1; index >= 0 && replay.length < 128; index -= 1) {
      const message = chatLog[index];
      if (message === undefined) continue;
      if (message.language === (LANG_ADDON | 0) || message.type === CHAT_MSG_ADDON) continue;
      replay.push(message);
    }
    replay.reverse();
    for (const message of replay) this.#emitChatMessage(pump, world, message);
    // A replayed `YOU_LEFT` takes its channel off stock's list even when the player has since
    // joined it again; one more UPDATE_CHAT_WINDOWS leaves the list as the world has it now.
    if (replay.some((message) => message.channelNotice !== undefined)) this.#chatWindowsUpdated(pump, true);
  }

  /**
   * Reconcile the cheap raw location edge and, when due, the optional AreaClient's resolved shape.
   * The latter is a second freshness key because its cache can become ready after IDs are stable.
   */
  #reconcileZone(resolveShape: boolean): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    const context = world.worldStateContext;
    const mapId = world.mapId ?? context?.mapId;
    const zoneId = context?.zoneId;
    const areaId = context?.areaId;
    // No world location yet: do not publish a fake initial zone and do not mark this as seen. A
    // later INIT_WORLD_STATES packet remains a real first-area edge.
    if (mapId === undefined && zoneId === undefined && areaId === undefined) return;
    const locationChanged = !this.#zoneKnown
      || this.#zoneMapId !== mapId || this.#zoneId !== zoneId || this.#areaId !== areaId;
    // A raw location transition must resolve immediately to preserve one edge. When IDs are
    // stable, only the existing throttled poll asks the optional AreaClient resolver again; this
    // keeps late metadata fresh without turning every rendered frame into an area lookup.
    if (!locationChanged && !resolveShape) return;
    const zone = this.#minimapZone();
    const shapeKnown = zone !== undefined;
    const shapeChanged = shapeKnown !== this.#zoneShapeKnown
      || (shapeKnown && (
        this.#zoneMinimapText !== zone.minimapZoneText
        || this.#zoneText !== zone.zoneText
        || this.#zoneSubZoneText !== zone.subZoneText
        || this.#zonePvpType !== zone.pvpType
        || this.#zoneIsSubZonePvp !== zone.isSubZonePvP
        || this.#zoneFactionName !== zone.factionName
      ));
    if (!shapeChanged && !locationChanged) return;
    const previousMapId = this.#zoneMapId;
    const first = !this.#zoneKnown;
    this.#zoneKnown = true;
    this.#zoneMapId = mapId;
    this.#zoneId = zoneId;
    this.#areaId = areaId;
    this.#zoneShapeKnown = shapeKnown;
    this.#zoneMinimapText = zone?.minimapZoneText;
    this.#zoneText = zone?.zoneText;
    this.#zoneSubZoneText = zone?.subZoneText;
    this.#zonePvpType = zone?.pvpType;
    this.#zoneIsSubZonePvp = zone?.isSubZonePvP;
    this.#zoneFactionName = zone?.factionName;
    // The seam is attached after FrameXML OnLoad. If the world context arrives after that mount,
    // one initial NEW_AREA edge is the only way for Minimap_Update to paint its now-known labels.
    // Resolved shape changes after that are ordinary ZONE_CHANGED edges, even if raw IDs are the
    // same (for example when AreaClient metadata arrives after the world-state packet).
    if (first) {
      pump.fire(FRAMEXML_SEAM_EVENTS.zoneChangedNewArea);
      return;
    }
    pump.fire(previousMapId !== mapId
      ? FRAMEXML_SEAM_EVENTS.zoneChangedNewArea
      : FRAMEXML_SEAM_EVENTS.zoneChanged);
  }

  #minimapZone(): FrameXmlMinimapZone | undefined {
    const world = this.#context.world();
    const context = world?.worldStateContext;
    return this.#context.minimapZone?.(
      world?.mapId ?? context?.mapId,
      context?.zoneId,
      context?.areaId,
    );
  }

  #resolvedWorldMapAreaId(): number | undefined {
    const areaId = this.#context.worldMapAreaId?.();
    return typeof areaId === "number" && Number.isSafeInteger(areaId) && areaId >= 0
      ? areaId
      : undefined;
  }

  /**
   * AreaClient is filled asynchronously after the world-state packet. Keep the WatchFrame POI
   * filter fresh on the existing 60 ms poll, while stable area metadata stays completely quiet.
   */
  #reconcileWorldMapArea(resolve: boolean): void {
    if (!resolve || !this.#pump) return;
    const next = this.#resolvedWorldMapAreaId();
    if (!this.#worldMapAreaKnown) {
      this.#worldMapAreaKnown = true;
      this.#worldMapAreaId = next;
      return;
    }
    if (next === this.#worldMapAreaId) return;
    this.#worldMapAreaId = next;
    this.#invalidateCurrentMapQuestIds();
    this.#pump.fire(FRAMEXML_SEAM_EVENTS.worldMapUpdate);
  }

  #castIdentity(cast: LiveCastState): readonly [string, string, number | undefined] {
    const metadata = this.#context.spell(cast.spellId);
    const name = metadata?.name ?? `Заклинание ${cast.spellId}`;
    return [name, metadata?.rank ?? "", cast.castID];
  }

  /** The book only exposes resolved, non-hidden rows; metadata arrival is part of the signature. */
  #resolvedSpellEntries(world = this.#context.world()): readonly { id: number; slot: number }[] {
    if (!world) return [];
    return (world.knownSpells ?? [])
      .map((known, order) => ({ id: known.id, slot: Number.isFinite(known.slot) ? known.slot : order }))
      .filter(({ id }) => {
        const metadata = this.#context.spell(id);
        return metadata !== undefined && metadata.hidden !== true;
      })
      .sort((left, right) => left.slot - right.slot || left.id - right.id);
  }

  #invalidateSpellEntries(): void {
    this.#spellEntriesCache = undefined;
    this.#spellEntriesCacheWorld = undefined;
    this.#spellEntriesCacheKnown = undefined;
    this.#spellEntriesCacheTabs = undefined;
  }

  #spellEntries(world = this.#context.world()): readonly { id: number; slot: number }[] {
    const known = world?.knownSpells;
    const suppliedTabs = this.#context.spellTabs?.();
    const tabs = suppliedTabs ?? EMPTY_SPELL_TABS;
    if (this.#spellEntriesCacheWorld === world && this.#spellEntriesCacheKnown === known
      && this.#spellEntriesCacheTabs === suppliedTabs
      && this.#spellEntriesCache !== undefined) return this.#spellEntriesCache;
    const entries = [...this.#resolvedSpellEntries(world)];
    // A host that supplies a tab resolver owns the not-ready state as well.  In particular, the
    // world mount deliberately returns [] while TalentClient is still loading; do not turn that
    // authoritative empty answer into the legacy one-undivided-tab fallback below.  Older seam
    // hosts which do not provide either callback retain the pre-SpellBook fallback behaviour.
    const normalized = this.#context.spellTabs !== undefined
      ? (tabs.length === 0 ? [] : entries)
      : entries;
    const tabbed = this.#context.spellTabs !== undefined && tabs.length > 0 && this.#context.spellTabFor
      ? normalized
      // Once a host has authoritative skill-line tabs, a resolved spell with no line is not a
      // spellbook row (the native Spellbook applies the same boundary). Keeping it out also keeps
      // each tab's offset/count tuple aligned with the global book index.
      .filter(({ id }) => {
        const tab = this.#context.spellTabFor?.(id);
        return tab !== undefined && tab >= 1 && tab <= tabs.length;
      })
      .sort((left, right) => {
        const leftTab = this.#context.spellTabFor?.(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightTab = this.#context.spellTabFor?.(right.id) ?? Number.MAX_SAFE_INTEGER;
        return leftTab - rightTab || left.slot - right.slot || left.id - right.id;
      })
      : normalized;
    this.#spellEntriesCacheWorld = world;
    this.#spellEntriesCacheKnown = known;
    this.#spellEntriesCacheTabs = suppliedTabs;
    this.#spellEntriesCache = tabbed;
    return tabbed;
  }

  #spellShapeSignature(world = this.#context.world()): string {
    return this.#spellEntries(world).map(({ id, slot }) => {
      const metadata = this.#context.spell(id);
      return `${id}:${slot}:${metadata?.name ?? ""}:${metadata?.rank ?? ""}:${metadata?.iconPath ?? ""}:${this.#context.spellTabFor?.(id) ?? ""}`;
    }).join(",");
  }

  #spellCooldownShapeSignature(world = this.#context.world()): string {
    if (!world) return "";
    return [...(world.cooldownSnapshots ?? new Map()).entries()]
      .filter(([spellId, snapshot]) => this.#context.spell(spellId) !== undefined
        && snapshot.endsAt > this.#context.monotonic())
      .sort(([left], [right]) => left - right)
      .map(([spellId, snapshot]) => `${spellId}:${snapshot.startedAt}:${snapshot.duration}:${snapshot.endsAt}`)
      .join(",");
  }

  #spellEntry(index: number, world = this.#context.world()): { id: number; slot: number } | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    return this.#spellEntries(world)[index - 1];
  }

  #spellId(value: number, world = this.#context.world()): number | undefined {
    const entry = this.#spellEntry(value, world);
    if (entry) return entry.id;
    // This fallback is useful to host probes and harmless for Lua: stock SpellBookFrame passes a
    // 1-based book slot, while a few addons pass a spell id to the same C APIs.
    return world?.knownSpells?.some((known) => known.id === value) ? value : undefined;
  }

  #spellTabs(world = this.#context.world()): readonly FrameXmlSpellTabInfo[] {
    const supplied = this.#context.spellTabs?.();
    if (this.#context.spellTabs !== undefined) return supplied ?? EMPTY_SPELL_TABS;
    const count = this.#resolvedSpellEntries(world).length;
    return count === 0 ? [] : [["", "", 0, count, 0, count]];
  }

  #castInfo(
    unit: "player" | "target" | "focus" | "targettarget" | "pet",
    channel: boolean,
  ): FrameXmlCastingInfo | FrameXmlChannelInfo | undefined {
    const world = this.#context.world();
    const guid = unit === "player" ? world?.state.selfGuid
      : unit === "target" ? this.#target()?.guid
        : unit === "focus" ? this.#focus()?.guid
          : unit === "targettarget" ? this.#targetTarget()?.guid
            : this.#pet()?.guid;
    const pump = this.#pump;
    if (guid === undefined || !world || !pump) return undefined;
    const cast = world.casts.get(guid);
    if (!cast || cast.channel !== channel) return undefined;
    const metadata = this.#context.spell(cast.spellId);
    const name = metadata?.name ?? `Заклинание ${cast.spellId}`;
    const rank = metadata?.rank ?? "";
    const texture = metadata?.iconPath ?? "";
    // `startedAt` is performance.now() while the Lua API is GetTime() milliseconds. Align the
    // epochs through the elapsed monotonic interval instead of exposing either raw clock.
    const startMs = pump.now() * 1000 - (this.#context.monotonic() - cast.startedAt);
    const endMs = startMs + cast.duration;
    if (channel) {
      return [name, rank, name, texture, startMs, endMs, false, false];
    }
    return [name, rank, name, texture, startMs, endMs, false, cast.castCount, false];
  }

  // ---- player containers -----------------------------------------------

  /** Map stock bag ids to the inventory projection's host bag/slot layout. */
  #liveContainer(id: number, inventory: PlayerInventoryState, world: WorldClient): LiveContainer | undefined {
    if (id === 0) {
      return { id, slots: inventory.backpack, name: "Рюкзак", bagFamily: 0 };
    }
    if (id === -2) {
      return { id, slots: inventory.keyring, name: "Связка ключей", bagFamily: 0 };
    }
    // BANK_CONTAINER (-1) and the bank bags 5..11, stock BankFrame's containers (FrameXmlBank.ts).
    if (frameXmlIsBankContainer(id)) {
      return frameXmlBankContainer(id, inventory, (entry) => {
        const template = this.#itemTemplate(world, entry);
        return template?.found ? template : undefined;
      });
    }
    if (!Number.isInteger(id) || id < 1 || id > 4) return undefined;
    const bag = inventory.bags.find((candidate) => candidate.bagSlot === INVENTORY_SLOT_BAG_START + id - 1);
    if (!bag) return undefined;
    const template = this.#itemTemplate(world, entryOf(bag.bag));
    return {
      id,
      slots: bag.slots,
      name: template?.found ? template.name : undefined,
      bagFamily: template?.found ? template.bagFamily : undefined,
    };
  }

  /** `entries`, when given, collects every item entry the projection is read from. */
  #liveContainers(world = this.#context.world(), entries?: Set<number>): Map<number, LiveContainer> {
    const result = new Map<number, LiveContainer>();
    if (!world) return result;
    // Focused seams may expose a world shell before its object map is ready. Inventory reads are
    // unavailable in that snapshot; leave the container projection empty until it is authoritative.
    if (typeof world.state.objects?.get !== "function") return result;
    const inventory = playerInventory(world.state);
    if (!inventory) return result;
    // A carried bag's own template names its stock container (1-4, `#liveContainer`).
    if (entries) for (const bag of inventory.bags) entries.add(entryOf(bag.bag));
    for (const id of [-2, 0, 1, 2, 3, 4]) {
      const container = this.#liveContainer(id, inventory, world);
      if (!container) continue;
      result.set(id, container);
      if (entries) for (const slot of container.slots) entries.add(entryOf(slot.item));
    }
    return result;
  }

  #liveContainerSlot(bagId: number, slot: number): ItemSlotState | undefined {
    if (!Number.isInteger(slot) || slot < 1) return undefined;
    const world = this.#context.world();
    if (!world || typeof world.state.objects?.get !== "function") return undefined;
    const inventory = playerInventory(world.state);
    if (!inventory) return undefined;
    return this.#liveContainer(bagId, inventory, world)?.slots[slot - 1];
  }

  #containerShapeSignature(container: LiveContainer): string {
    return [
      container.slots.length,
      container.name ?? "",
      container.bagFamily ?? "",
      ...container.slots.map((slot) => [
        slot.guid,
        entryOf(slot.item),
        stackCount(slot),
        slot.item ? this.#itemTemplate(this.#context.world(), entryOf(slot.item))?.quality ?? "" : "",
        slot.item ? this.#itemTexture(entryOf(slot.item)) ?? "" : "",
      ].join(":")),
    ].join("|");
  }

  /** Turn one coalesced inventory/cache mutation into the stock BAG_UPDATE(id) edges. */
  #reconcileContainers(force = false): void {
    const pump = this.#pump;
    if (!pump) return;
    const entries = new Set<number>();
    const next = this.#liveContainers(undefined, entries);
    this.#containerEntries = entries;
    const changed = new Set<number>();
    for (const id of this.#containerSignatures.keys()) {
      if (!next.has(id)) changed.add(id);
    }
    const signatures = new Map<number, string>();
    for (const [id, container] of next) {
      const signature = this.#containerShapeSignature(container);
      signatures.set(id, signature);
      if (force || this.#containerSignatures.get(id) !== signature) changed.add(id);
    }
    this.#containerSignatures = signatures;
    for (const id of [...changed].sort((left, right) => left - right)) {
      pump.fire(FRAMEXML_SEAM_EVENTS.bagUpdate, id);
    }
  }

  #currentMoney(): number | undefined {
    // Focused seams can expose a self GUID before the object map is populated. Keep that
    // incomplete snapshot unknown instead of making the money read take down attach/tick.
    const world = this.#context.world();
    const guid = world?.state.selfGuid;
    const objects = world?.state.objects;
    const player = guid !== undefined && typeof objects?.get === "function"
      ? objects.get(guid) : undefined;
    const money = player ? playerFields.money(player) : undefined;
    return money === undefined || !Number.isFinite(money) ? undefined : Math.max(0, Math.trunc(money));
  }

  /** Publish one PLAYER_MONEY edge for each authoritative coinage transition. */
  #reconcileMoney(): void {
    const pump = this.#pump;
    if (!pump) return;
    const next = this.#currentMoney();
    // An absent player/world is an unknown snapshot, not a coinage transition. Preserve the last
    // authoritative value and wait for a real field value before publishing PLAYER_MONEY.
    if (next === undefined) return;
    if (next === this.#money) return;
    this.#money = next;
    pump.fire(FRAMEXML_SEAM_EVENTS.playerMoney);
  }

  #reconcileBankSlots(): void {
    const bought = this.bankSlots()?.[0];
    if (bought === undefined || bought === this.#bankSlotsBought) return;
    this.#bankSlotsBought = bought;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.playerBankBagSlotsChanged);
  }

  #reconcileComboPoints(): void {
    const next = String(this.comboPoints("player", "target"));
    if (next === this.#comboSignature) return;
    this.#comboSignature = next;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.unitComboPoints, "player");
  }

  #shapeshiftForms() {
    return frameXmlShapeshiftForms(this.#context.world()?.knownSpells ?? [],
      this.#context.spell, this.#context.spellAbilities);
  }

  #shapeshiftActive(form: FrameXmlShapeshiftForm): boolean {
    const world = this.#context.world();
    const player = this.#self();
    if (!world || !player) return false;
    if (form.formId !== undefined) return unitField.shapeshiftForm(player) === form.formId;
    return world.aurasFor(player.guid).some((aura) => aura.spellId === form.spellId
      && (aura.casterGuid === undefined || aura.casterGuid === player.guid));
  }

  #reconcileShapeshiftForms(): void {
    const next = this.#shapeshiftForms()
      .map((form) => `${form.spellId}:${form.order}:${form.texture}:${form.name}`).join("|");
    if (next === this.#shapeshiftSignature) return;
    this.#shapeshiftSignature = next;
    this.#shapeshiftActiveSignature = "";
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateShapeshiftForms);
    this.#reconcileShapeshiftActive();
  }

  #reconcileShapeshiftActive(): void {
    const next = this.#shapeshiftForms().map((form) => this.#shapeshiftActive(form) ? "1" : "0").join("");
    if (next === this.#shapeshiftActiveSignature) return;
    this.#shapeshiftActiveSignature = next;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateShapeshiftForm);
  }

  #reconcileBonusActionBar(): void {
    const next = this.bonusBarOffset();
    if (next === this.#bonusActionBarOffset) return;
    this.#bonusActionBarOffset = next;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateBonusActionBar);
  }

  #shapeshiftCooldownRemaining(spellId: number, now: number): number {
    const world = this.#context.world();
    const direct = Math.max(0, (world?.cooldownSnapshots?.get(spellId)?.endsAt ?? 0) - now);
    return Math.max(direct, world?.cooldownRemaining?.(spellId, now) ?? 0);
  }

  #reconcileShapeshiftCooldowns(): void {
    const world = this.#context.world();
    const now = this.#context.monotonic();
    const next = this.#shapeshiftForms().map((form) => {
      const cooldown = world?.cooldownSnapshots?.get(form.spellId);
      const remaining = this.#shapeshiftCooldownRemaining(form.spellId, now);
      return remaining > 0
        ? `${form.spellId}:${cooldown?.startedAt ?? ""}:${cooldown?.duration ?? ""}:${Math.round(now + remaining)}` : "";
    }).join("|");
    if (next === this.#shapeshiftCooldownSignature) return;
    this.#shapeshiftCooldownSignature = next;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateShapeshiftCooldown);
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateShapeshiftUsable);
  }

  #itemTemplate(world: WorldClient | undefined, entry: number) {
    return world && world.itemTemplates instanceof Map ? world.itemTemplates.get(entry) : undefined;
  }

  #itemTexture(entry: number): string | undefined {
    const texture = entry > 0 ? this.#context.itemTexture?.(entry) : undefined;
    return texture || undefined;
  }

  /** Carried inventory only: bank/buyback entries cannot satisfy an action-bar item. */
  #actionItems(entry: number): readonly ItemSlotState[] {
    const world = this.#context.world();
    if (!world || typeof world.state.objects?.get !== "function") return [];
    const inventory = playerInventory(world.state);
    if (!inventory) return [];
    return [...inventory.equipment, ...inventory.backpack, ...inventory.keyring,
      ...inventory.bags.flatMap((bag) => bag.slots)]
      .filter((slot) => slot.item !== undefined && entryOf(slot.item) === entry);
  }

  /** Item spells use the realm's retained spell timer or its fixed equip cooldown. */
  #itemCooldown(entry: number): FrameXmlContainerItemCooldown {
    const world = this.#context.world();
    const pump = this.#pump;
    const spellId = itemUseSpellId(this.#itemTemplate(world, entry));
    if (!world || !pump || spellId === undefined) return [0, 0, 0];
    const now = this.#context.monotonic();
    const equipEnd = world.itemCooldowns?.get(spellId) ?? 0;
    const equipRemaining = Math.max(0, equipEnd - now);
    const spellRemaining = world.cooldownRemaining(spellId, now);
    if (equipRemaining >= spellRemaining && equipRemaining > 0) {
      return [pump.now() - (ITEM_EQUIP_COOLDOWN_MS - equipRemaining) / 1000,
        ITEM_EQUIP_COOLDOWN_MS / 1000, 1];
    }
    if (spellRemaining <= 0) return [0, 0, 0];
    const snapshot = world.cooldownSnapshots?.get(spellId);
    if (snapshot) {
      return [pump.now() - (now - snapshot.startedAt) / 1000, snapshot.duration / 1000, 1];
    }
    return [pump.now(), spellRemaining / 1000, 1];
  }

  /** Announce timer start/clear/expiry once, so stock bag and paperdoll sweeps stay current. */
  #reconcileItemCooldowns(): void {
    const world = this.#context.world();
    const pump = this.#pump;
    if (!world || !pump) return;
    const now = this.#context.monotonic();
    const equip = [...(world.itemCooldowns ?? new Map<number, number>())]
      .filter(([, end]) => end > now)
      .map(([id, end]) => `e:${id}:${end}`);
    const spells = [...(world.cooldownSnapshots ?? new Map())]
      .filter(([, snapshot]) => snapshot.endsAt > now)
      .map(([id, snapshot]) => `s:${id}:${snapshot.startedAt}:${snapshot.duration}:${snapshot.endsAt}`);
    const signature = [...equip, ...spells].sort().join("|");
    if (signature === this.#itemCooldownSignature) return;
    this.#itemCooldownSignature = signature;
    pump.fire(FRAMEXML_SEAM_EVENTS.bagUpdateCooldown);
    pump.fire(FRAMEXML_SEAM_EVENTS.actionCooldown);
    pump.fire(FRAMEXML_SEAM_EVENTS.actionUsable);
  }

  // ---- merchant ---------------------------------------------------------

  #vendorItems(world: WorldClient | undefined): readonly VendorItem[] {
    const items = world?.vendor?.items;
    if (!items) return [];
    // Extended-cost rows keep their original physical slots; the server validates each purchase.
    return items;
  }

  #vendorItem(index: number) {
    const world = this.#context.world();
    const vendor = world?.vendor;
    if (!vendor || !Number.isInteger(index) || index < 1) return undefined;
    return this.#vendorItems(world)[index - 1];
  }

  #vendorShape(world: WorldClient | undefined): string {
    const vendor = world?.vendor;
    if (!vendor) return "";
    return [vendor.guid.toString(), vendor.error ?? "", this.#merchantNameFor(world) ?? "",
      ...this.#vendorItems(world).map((item) => {
        const metadata = this.#context.itemInfo?.(item.itemId);
        const template = this.#itemTemplate(world, item.itemId);
        const cost = this.#context.vendorCost?.(item.extendedCost);
        return [
          item.slot, item.itemId, item.displayId, item.leftInStock, item.price, item.buyCount,
          item.extendedCost, metadata?.name ?? (template?.found ? template.name : "") ?? "",
          metadata?.texture ?? this.#itemTexture(item.itemId) ?? "",
          this.#merchantTemplateLink(item.itemId) ?? "",
          cost?.honor ?? "", cost?.arena ?? "", cost?.arenaBracket ?? "", cost?.rating ?? "",
          ...(cost?.items.map((required) => [required.entry, required.count,
            this.#context.itemInfo?.(required.entry)?.texture ?? this.#itemTexture(required.entry) ?? "",
            this.#merchantTemplateLink(required.entry) ?? "",
          ].join(":")) ?? []),
        ].join(":");
      }), this.#buybackShape(world)].join("|");
  }

  /**
   * Buyback lives in the player's private update fields, not in the vendor packet. Read just those
   * twelve GUID/price pairs so a field-only sell or buyback change reaches MERCHANT_UPDATE without
   * rebuilding the complete inventory projection on every rendered tick.
   */
  #buybackShape(world: WorldClient): string {
    const selfGuid = world.state.selfGuid;
    const player = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
    if (!player) return "";
    const guidOffset = UPDATE_FIELDS.PLAYER_FIELD_VENDORBUYBACK_SLOT_1.offset;
    const priceOffset = UPDATE_FIELDS.PLAYER_FIELD_BUYBACK_PRICE_1.offset;
    const parts: string[] = [];
    for (let index = 0; index < BUYBACK_SLOTS; index += 1) {
      const guid = fieldGuid(player, guidOffset + index * 2);
      const item = guid === 0n ? undefined : world.state.objects.get(guid);
      const entry = item ? entryOf(item) : 0;
      const quantity = item
        ? item.fields.get(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset) ?? 1
        : 0;
      const price = player.fields.get(priceOffset + index) ?? 0;
      parts.push(`${index}:${guid}:${entry}:${quantity}:${price}`);
    }
    return parts.join(",");
  }

  /** Publish exactly one stock lifecycle edge for each vendor identity/list transition. */
  #reconcileMerchant(force = false): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump) return;
    const next = this.#vendorShape(world);
    if (!force && next === this.#merchantSignature) return;
    this.merchantChanged(next === "" ? "closed" : this.#merchantSignature === "" ? "show" : "update");
  }

  /**
   * Atomically publish a vendor edge and advance the poll signature.  EnterWorld's packet callback
   * and the rendered-frame poll both use this method, so a callback followed by the next tick can
   * never emit a duplicate SHOW/UPDATE/CLOSED pair.
   */
  merchantChanged(event: "show" | "update" | "closed", force = false): void {
    const pump = this.#pump;
    if (!pump) return;
    if (event === "closed") {
      if (this.#merchantSignature === "") return;
      this.#merchantSignature = "";
      pump.fire(FRAMEXML_SEAM_EVENTS.merchantClosed);
      return;
    }
    const next = this.#vendorShape(this.#context.world());
    if (next === "" || (!force && next === this.#merchantSignature)) return;
    const previous = this.#merchantSignature;
    this.#merchantSignature = next;
    pump.fire(previous === "" ? FRAMEXML_SEAM_EVENTS.merchantShow : FRAMEXML_SEAM_EVENTS.merchantUpdate);
  }

  merchantNumItems(): number {
    return this.#vendorItems(this.#context.world()).length;
  }

  merchantItemInfo(index: number): FrameXmlMerchantItemInfo | undefined {
    const item = this.#vendorItem(index);
    if (!item) return undefined;
    const world = this.#context.world();
    const metadata = this.#context.itemInfo?.(item.itemId);
    const template = this.#itemTemplate(world, item.itemId);
    const name = metadata?.name ?? (template?.found ? template.name : undefined) ?? `Предмет ${item.itemId}`;
    const texture = metadata?.texture ?? this.#itemTexture(item.itemId);
    const available = item.leftInStock !== 0;
    // Stock Lua still offers a click when isUsable=false. The buy method below enforces the
    // same unresolved-cost gate, while this flag makes the pending row visibly unavailable.
    const costKnown = item.extendedCost === 0 || this.#context.vendorCost?.(item.extendedCost) !== undefined;
    return [name, texture, item.price, item.buyCount, item.leftInStock,
      available && costKnown, item.extendedCost > 0];
  }

  #merchantTemplateLink(entry: number): string | undefined {
    if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
    const template = this.#itemTemplate(this.#context.world(), entry);
    const metadata = this.#context.itemInfo?.(entry);
    const name = template?.found ? template.name : metadata?.name;
    const quality = template?.found ? template.quality : metadata?.quality;
    if (!name || !Number.isInteger(quality) || quality === undefined || quality < 0) return undefined;
    // A vendor row is an item template, not an instance. TrinityCore builds this exact base-item
    // form with zero enchant, gems and random-property fields for template links
    // (Transmogrification::GetItemLink(uint32 entry)). Never present it as a purchased instance.
    return itemChatLink(entry, quality, name);
  }

  merchantItemLink(index: number): string | undefined {
    const item = this.#vendorItem(index);
    return item ? this.#merchantTemplateLink(item.itemId) : undefined;
  }

  merchantItemMaxStack(index: number): number {
    const item = this.#vendorItem(index);
    if (!item) return 0;
    return this.#itemTemplate(this.#context.world(), item.itemId)?.stackable ?? 0;
  }

  merchantItemCostInfo(index: number): FrameXmlMerchantCostInfo {
    const item = this.#vendorItem(index);
    const cost = item && item.extendedCost > 0 ? this.#context.vendorCost?.(item.extendedCost) : undefined;
    return cost ? [cost.honor, cost.arena, cost.items.length] : [0, 0, 0];
  }

  merchantItemCostItem(index: number, costIndex: number): readonly [string | undefined, number, string | undefined] | undefined {
    const item = this.#vendorItem(index);
    if (!item || item.extendedCost === 0 || !Number.isInteger(costIndex) || costIndex < 1) return undefined;
    const required = this.#context.vendorCost?.(item.extendedCost)?.items[costIndex - 1];
    if (!required) return undefined;
    // The DBC row names a template entry. Its link is available only when name and quality are
    // known from the server item template or cached metadata.
    return [this.#context.itemInfo?.(required.entry)?.texture ?? this.#itemTexture(required.entry),
      required.count, this.#merchantTemplateLink(required.entry)];
  }

  itemInfo(value: unknown): FrameXmlItemInfo | undefined {
    const entry = frameXmlItemEntry(value);
    if (entry === undefined) return undefined;
    const template = this.#itemTemplate(this.#context.world(), entry);
    const metadata = this.#context.itemInfo?.(entry);
    const name = template?.found ? template.name : metadata?.name;
    const quality = template?.found ? template.quality : metadata?.quality;
    const link = typeof value === "string" && value.includes("|Hitem:")
      ? value : this.#merchantTemplateLink(entry);
    if (!name || !Number.isInteger(quality) || quality === undefined || quality < 0 || !link) {
      return undefined;
    }
    return [name, link, quality];
  }

  #liveBuyback(index: number): BuybackSlotState | undefined {
    const world = this.#context.world();
    if (!world?.vendor || !Number.isInteger(index) || index < 1 || index > BUYBACK_SLOTS) return undefined;
    const inventory = playerInventory(world.state);
    return inventory?.buyback.filter((slot) => slot.item !== undefined)[index - 1];
  }

  buybackNumItems(): number {
    const inventory = this.#context.world() ? playerInventory(this.#context.world()!.state) : undefined;
    if (!inventory || !this.#context.world()?.vendor) return 0;
    let count = 0;
    for (const slot of inventory.buyback) if (slot.item !== undefined) count += 1;
    return count;
  }

  buybackItemInfo(index: number): FrameXmlBuybackItemInfo | undefined {
    const slot = this.#liveBuyback(index);
    if (!slot?.item) return undefined;
    const entry = entryOf(slot.item);
    const metadata = this.#context.itemInfo?.(entry);
    const template = this.#itemTemplate(this.#context.world(), entry);
    const name = metadata?.name ?? (template?.found ? template.name : undefined) ?? `Предмет ${entry}`;
    const texture = metadata?.texture ?? this.#itemTexture(entry);
    const quantity = stackCount(slot);
    return [name, texture, slot.price, quantity, quantity, slot.price > 0];
  }

  buybackItemLink(index: number): string | undefined {
    return this.#itemLink(this.#liveBuyback(index)?.item);
  }

  buyMerchantItem(index: number, count: number): void {
    const item = this.#vendorItem(index);
    if (!item || item.leftInStock === 0 || !Number.isInteger(count) || count < 1) return;
    // A missing DBC row would make GetMerchantItemCostInfo answer zeroes. Stock Lua treats that
    // as a free purchase, so never submit an extended-cost request until its row is known.
    if (item.extendedCost > 0 && !this.#context.vendorCost?.(item.extendedCost)) return;
    this.#context.world()?.buyFromVendor(item.slot, count);
  }

  buybackItem(index: number): void {
    const slot = this.#liveBuyback(index);
    if (!slot?.item || slot.price <= 0) return;
    // The protocol expects absolute PLAYER_FIELD_VENDORBUYBACK_SLOT_1 numbering (74..85).
    this.#context.world()?.buybackFromVendor(slot.slot);
  }

  closeMerchant(): void { this.#context.world()?.closeVendor(); }
  canMerchantRepair(): boolean { return false; }
  repairAllCost(): readonly [number, boolean] { return [0, false]; }
  canGuildBankRepair(): boolean { return false; }
  inRepairMode(): boolean { return false; }

  /**
   * Poll the two things no field subscription can see: what is on the bar, and what is recovering.
   *
   * `actionButtons` is a plain array replaced wholesale when `SMSG_ACTION_BUTTONS` lands, and the
   * cooldown table is a `Map` written by half a dozen packet handlers; neither is an update field,
   * so neither has a subscription to take. A signature comparison is what turns «read it every
   * frame» into «fire an event when it actually changed».
   */
  tick(now: number): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    // A holder that let go on its own (the item moved, the vault closed) takes the grid and picture along.
    this.cursor.sync();
    this.calendar.tick();
    // Loot edges (LOOT_OPENED/…/CANCEL_LOOT_ROLL) follow the packets within one rendered frame.
    this.loot.tick();
    this.map.tick();
    // PLAYER_TOTEM_UPDATE for a totem that ran out or lost its creature; UNIT_INVENTORY_CHANGED for an imbue.
    this.hudMechanics.tick();
    // Mail/trade repaint once item names or sender names arrive (their packet edges are events).
    this.mail.tick();
    this.trade.tick();
    // KNOWN_CURRENCY_TYPES_UPDATE / CURRENCY_DISPLAY_UPDATE edges, once Blizzard_TokenUI took them.
    this.currency.tick();
    // ARENA_OPPONENT_UPDATE, UNIT_PET and the enemy frames' UNIT_* edges (outside an arena: two queue slots).
    this.arena.tick();
    this.auction.tick();
    this.socket.tick();
    this.barber.tick();
    // GLYPH_ADDED/REMOVED/UPDATED once the realm's answer has moved a socket.
    this.glyphs.tick();
    // One CRITERIA_UPDATE per frame, however many criteria the packets since the last one moved.
    this.achievement.tick();
    // A bank opened or closed without a packet (the native window, a relog): GUILDBANKFRAME_* edges.
    this.guildBank.tick();
    // The open trade skill: deferred TRADE_SKILL_* edges, the repeat count, bags and item replies.
    this.tradeSkill.tick();
    // A key changed in the native window or a module action added: UPDATE_BINDINGS (throttled).
    this.keyBindings.tick(now);
    this.#reconcileActionPage();
    this.#reconcileMirrorTimers();
    // Selection is a plain WorldClient property: `selectTarget` sends the packet but intentionally
    // emits no EventBus edge. Reconcile it before the throttled reads so a click is visible on the
    // next rendered frame rather than waiting for the 60 ms data poll.
    this.#reconcileTarget();
    this.#reconcileComboPoints();
    this.#reconcileTargetTarget();
    this.#reconcileFocus();
    // The settled hover is one Map lookup; reading it every frame also catches a hovered unit
    // that despawned, which has no pointer event of its own.
    this.#reconcileMouseover(world, pump);
    // The player's swing is a plain WorldClient property with no bus edge; one read a frame.
    this.#reconcileMelee(world, pump);
    // Resolving AreaClient metadata can allocate a small result object. Keep that callback on the
    // existing 60 ms seam poll, while still reconciling raw IDs immediately when they move.
    const resolveZone = now - this.#polledAt >= LIVE_POLL_SECONDS;
    this.#reconcileZone(resolveZone);
    this.#reconcileWorldMapArea(resolveZone);
    const targetName = this.#targetNameFor(this.#target()) ?? "";
    if (targetName !== this.#targetName) {
      this.#targetName = targetName;
      pump.fire(FRAMEXML_SEAM_EVENTS.unitName, "target");
    }
    const focusName = this.#targetNameFor(this.#focus()) ?? "";
    if (focusName !== this.#focusName) {
      this.#focusName = focusName;
      pump.fire(FRAMEXML_SEAM_EVENTS.unitName, "focus");
    }
    const targetTargetName = this.#targetNameFor(this.#targetTarget()) ?? "";
    if (targetTargetName !== this.#targetTargetName) {
      this.#targetTargetName = targetTargetName;
      pump.fire(FRAMEXML_SEAM_EVENTS.unitName, "targettarget");
    }
    if (now - this.#polledAt < LIVE_POLL_SECONDS) return;
    this.#polledAt = now;
    this.worldStates.tick();
    // The server's confirmations (invites, death, summon, ready check …) sit in single-slot world
    // fields with no bus edge; they are compared on this poll, within 60 ms of their packet.
    this.popups.tick();
    // Guild packets reach only WorldClient's single onGuildChanged slot and the group list only
    // onGroupChanged; the social model compares their field identities on this poll instead.
    this.friends.tick();
    const serviceSignature = this.#servicesSignature();
    if (serviceSignature !== this.#serviceSignature) {
      this.#serviceSignature = serviceSignature;
      pump.fire("MAIL_SEND_INFO_UPDATE");
      pump.fire("PET_STABLE_UPDATE");
    }
    // Merchant presentation reads item/name/texture metadata for every supported row. Keep that
    // cache-backed work on the bounded poll just like the other non-event-driven snapshots; packet
    // callbacks still use merchantChanged() for immediate lifecycle edges.
    this.#reconcileMerchant();
    // Faction metadata may resolve after the server standing packet. Keep the
    // same bounded poll as the other cache-backed FrameXML data and gate the
    // edge by shape so repeated REPUTATION_CHANGED packets stay quiet.
    this.#publishReputationChanged();
    // Skill metadata arrives independently of the player update block. The resolver cache and
    // this primitive signature turn that late arrival into one redraw edge, not a per-rAF scan.
    this.#publishSkillLinesChanged();
    const talentMetadataRevision = this.#context.talentMetadataRevision?.() ?? 0;
    if (talentMetadataRevision !== this.#talentMetadataRevision) {
      const hadRevision = Number.isFinite(this.#talentMetadataRevision);
      this.#talentMetadataRevision = talentMetadataRevision;
      // A late TalentClient/spell-name arrival repaints the already mounted stock tree once. The
      // first unavailable snapshot is silent; no synthetic player talent update is fabricated.
      if (hadRevision || this.#talentResolvers.talentSnapshot() !== undefined) {
        pump.fire(FRAMEXML_SEAM_EVENTS.talentsChanged);
      }
      if (this.#talentResolvers.petTalentSnapshot() !== undefined) {
        pump.fire(FRAMEXML_SEAM_EVENTS.petTalentsChanged);
      }
    }
    // Inventory fields are event-driven through WorldStore.any; this bounded poll only catches
    // focused seam doubles and cached texture changes which have no named world event.
    this.#reconcileContainers();
    this.#reconcileItemCooldowns();
    this.#reconcilePaperDoll();
    // Coinage normally arrives through the named WorldStore field subscription; this bounded
    // fallback also catches focused seam doubles that mutate the player without flushing fields.
    this.#reconcileMoney();
    // Likewise the combat flag, whose store subscription publishes it within the frame, and a
    // level-up whose level field reached a double with no store. SMSG_CLIENT_CONTROL_UPDATE has no
    // bus edge at all: this poll is where a control change without a flag reaches Lua.
    this.#reconcileCombat();
    this.#reconcileControl();
    this.#publishLevelUp();
    this.#reconcileBankSlots();
    // The spell list and cooldown map are not update fields. Keep their signatures primitive and
    // sample them at the same 60 ms boundary as the action bar, so removal/initial replacement
    // (which have no dedicated EventBus edge) still redraw the stock book without a per-rAF walk.
    const spellSignature = this.#spellShapeSignature(world);
    if (spellSignature !== this.#spellSignature) {
      this.#invalidateSpellEntries();
      this.#spellSignature = spellSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.spellsChanged);
    }
    // COMPANION_LEARNED/UNLEARNED/UPDATE: the known set, rows that arrived, the mount aura and the
    // critter in view, on the same 60 ms boundary as the spell list above (FrameXmlCompanions.ts).
    this.companions.tick();
    // PET_BAR_UPDATE for a bar whose kind or spell rows changed without a packet, and
    // PET_BAR_UPDATE_USABLE on the pet's power and life: one pet read a poll, none without a pet.
    this.petActions.tick();
    // KNOWN_TITLES_UPDATE / UNIT_NAME_UPDATE on the title fields and EQUIPMENT_SETS_CHANGED on the
    // set list: two player-object reads a poll, which is why they sit on this boundary rather than
    // on every rendered frame (the quest log pins zero object reads per sub-60 ms tick).
    this.titles.tick();
    this.equipmentSets.tick();
    this.#reconcileShapeshiftForms();
    const spellCooldownSignature = this.#spellCooldownShapeSignature(world);
    if (spellCooldownSignature !== this.#spellCooldownSignature) {
      this.#spellCooldownSignature = spellCooldownSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.spellUpdateCooldown);
    }
    this.#reconcileShapeshiftCooldowns();
    // Group membership normally arrives through WorldClient.onGroupChanged. Keep this existing
    // bounded poll only as a fallback for hosts that mutate the snapshot without invoking it;
    // never scan the roster on every rendered frame.
    this.#reconcileParty();
    this.#reconcileMinimapIndicators(world, pump);

    const auraSignature = this.#auraShapeSignature("player");
    if (auraSignature !== this.#auraSignature) {
      this.#auraSignature = auraSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.aura, "player");
    }
    this.#reconcileShapeshiftActive();
    this.#reconcileBonusActionBar();
    const targetAuraSignature = this.#auraShapeSignature("target");
    if (targetAuraSignature !== this.#targetAuraSignature) {
      this.#targetAuraSignature = targetAuraSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.aura, "target");
    }
    const focusAuraSignature = this.#auraShapeSignature("focus");
    if (focusAuraSignature !== this.#focusAuraSignature) {
      this.#focusAuraSignature = focusAuraSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.aura, "focus");
    }
    const targetTargetAuraSignature = this.#auraShapeSignature("targettarget");
    if (targetTargetAuraSignature !== this.#targetTargetAuraSignature) {
      this.#targetTargetAuraSignature = targetTargetAuraSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.aura, "targettarget");
    }

    const bar = world.actionButtons
      .map((button) => `${button.slot}:${button.type}:${button.action}:${this.actionTexture(button.slot + 1) ?? ""}`
        + (button.type === ACTION_BUTTON_ITEM ? `:${this.actionCount(button.slot + 1)}:${this.isEquippedAction(button.slot + 1)}` : ""))
      .join(",");
    if (bar !== this.#barSignature) {
      this.#barSignature = bar;
      pump.fire(FRAMEXML_SEAM_EVENTS.actionSlotChanged, 0);
    }
    const monotonic = this.#context.monotonic();
    const cooldowns = world.actionButtons
      .filter((button) => button.type === ACTION_BUTTON_SPELL)
      .map((button) => `${button.slot}:${Math.round(world.cooldownRemaining(button.action, monotonic) / 250)}`)
      .join(",");
    if (cooldowns !== this.#cooldownSignature) {
      this.#cooldownSignature = cooldowns;
      pump.fire(FRAMEXML_SEAM_EVENTS.actionCooldown);
      pump.fire(FRAMEXML_SEAM_EVENTS.actionUsable);
    }
    // Power has no `SELF` field of its own — the index depends on the power type — so it is polled
    // beside the two above rather than subscribed like health.
    const player = this.#self();
    const powerType = player ? unitField.powerType(player) ?? 0 : 0;
    const power = player ? unitField.power(player) ?? 0 : 0;
    const powerMax = player ? unitField.maxPower(player) ?? 0 : 0;
    const typeChanged = powerType !== this.#powerType;
    const powerChanged = power !== this.#power;
    const powerMaxChanged = powerMax !== this.#powerMax;
    if (typeChanged) {
      this.#powerType = powerType;
      this.#power = power;
      this.#powerMax = powerMax;
      // UnitFrameManaBar_UpdateType must run first. It selects the new token and unregisters the
      // old power event; the two following events then update the value and maximum under that token.
      pump.fire(FRAMEXML_SEAM_EVENTS.unitDisplayPower, "player");
      pump.fire(FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA", "player");
      pump.fire(FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA", "player");
    } else {
      if (powerChanged) {
        this.#power = power;
        pump.fire(FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA", "player");
      }
      if (powerMaxChanged) {
        this.#powerMax = powerMax;
        pump.fire(FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA", "player");
      }
    }
    const health = player ? unitField.health(player) ?? 0 : 0;
    if (health !== this.#health) this.#health = health;
  }

  containerNumSlots(bagId: number): number {
    const world = this.#context.world();
    if (!world || typeof world.state.objects?.get !== "function") return 0;
    const inventory = playerInventory(world.state);
    return inventory ? this.#liveContainer(bagId, inventory, world)?.slots.length ?? 0 : 0;
  }

  containerNumFreeSlots(bagId: number): readonly [number, number | undefined] {
    const world = this.#context.world();
    if (!world || typeof world.state.objects?.get !== "function") return [0, undefined];
    const inventory = playerInventory(world.state);
    const container = inventory ? this.#liveContainer(bagId, inventory, world) : undefined;
    if (!container) return [0, undefined];
    return [container.slots.filter((slot) => slot.item === undefined).length, container.bagFamily];
  }

  containerItemInfo(bagId: number, slot: number): FrameXmlContainerItemInfo | undefined {
    const item = this.#liveContainerSlot(bagId, slot);
    if (!item?.item) return undefined;
    const world = this.#context.world();
    const entry = entryOf(item.item);
    const template = this.#itemTemplate(world, entry);
    // The client has count and (when its item query has arrived) quality. The optional host cache
    // supplies the exact renderer-compatible texture without making this read perform I/O. The
    // server's lock bit is not in the item update state; the client's own locks are: an item
    // attached to the send draft or offered in the trade window is locked, as in the client.
    const locked = this.mail.attached(item.guid) || this.trade.offered(item.guid)
      || this.auction.selling(item.guid) || this.socket.staged(item.guid) ? true : undefined;
    return [this.#itemTexture(entry), stackCount(item), locked,
      template?.found ? template.quality : undefined, undefined];
  }

  containerItemTooltip(bagId: number, slot: number): FrameXmlInventoryTooltipItem | undefined {
    const item = this.#liveContainerSlot(bagId, slot);
    if (!item?.item) return undefined;
    const entry = entryOf(item.item);
    if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
    const world = this.#context.world();
    const template = this.#itemTemplate(world, entry);
    const metadata = this.#context.itemInfo?.(entry);
    return {
      entry, count: stackCount(item), enchantments: itemEnchantmentIds(item.item),
      ...(template?.found === true ? { template } : {}),
      ...(metadata && metadata.name.length > 0 ? { metadata: {
        entry, name: metadata.name, displayId: 0,
        quality: metadata.quality ?? (template?.found === true ? template.quality : 0),
        inventoryType: template?.found === true ? template.inventoryType : 0,
        stackable: template?.found === true ? template.stackable : 0,
        iconId: 0,
      } } : {}),
    };
  }

  containerItemLink(bagId: number, slot: number): string | undefined {
    return this.#itemLink(this.#liveContainerSlot(bagId, slot)?.item);
  }

  containerItemCooldown(bagId: number, slot: number): FrameXmlContainerItemCooldown {
    return this.#itemCooldown(entryOf(this.#liveContainerSlot(bagId, slot)?.item));
  }

  bagName(bagId: number): string | undefined {
    const world = this.#context.world();
    if (!world) return undefined;
    const inventory = playerInventory(world.state);
    if (!inventory) return undefined;
    return this.#liveContainer(bagId, inventory, world)?.name;
  }

  useContainerItem(bagId: number, slot: number): void {
    const world = this.#context.world();
    const item = this.#liveContainerSlot(bagId, slot);
    if (!world || !item?.item || item.guid === 0n) return;
    // An enchant from the stock TradeSkillFrame is waiting for its item (SpellCanTargetItem): this is it.
    if (this.tradeSkill.targetItem(item.guid)) return;
    // A locked item (attached to the send draft or offered in the trade) is not used, as in the
    // client: the letter or the trade already holds it, even on the inbox tab.
    if (this.mail.attached(item.guid) || this.trade.offered(item.guid)) return;
    if (this.auction.selling(item.guid)) return;
    // … or staged in a stock socket (FrameXmlSocketModel.staged).
    if (this.socket.staged(item.guid)) return;
    // As in the client, a right-clicked bag item goes into the open send-mail draft or trade window.
    if (this.mail.useItem(item.guid) || this.trade.useItem(item.guid)) return;
    // … or, with the stock Auctions tab showing, into the auction sell slot (SetAuctionsTabShowing).
    if (this.auction.useItem(item.guid)) return;
    // … or, with the stock guild bank shown, into its current tab (FrameXmlGuildBank.useItem).
    if (this.guildBank.useItem({ entry: entryOf(item.item), bag: item.bag, slot: item.slot })) return;
    // At an open bank it moves across; a readable item is read (FrameXmlGossipLive.ts).
    if (liveFrameXmlNpcUseContainerItem(this, world, bagId, slot, item)) return;
    // A glyph raises the glyph cursor and USE_GLYPH; its socket is chosen in GlyphFrame (FrameXmlGlyph.ts).
    if (this.glyphs.useItem({
      guid: item.guid, bag: item.bag, slot: item.slot,
      spellId: itemUseSpellId(this.#itemTemplate(world, entryOf(item.item))),
    })) return;
    // What is left is the client's own order (ContainerFrame.lua:722-734 has already kept the buyback
    // tab and an extended-cost refund out of it): at a merchant the stack is sold, gear is worn, a
    // bind-on-use item asks first, and only the rest is a plain use. Measured before this: a right
    // click on a belt sent CMSG_USE_ITEM, which HandleUseItemOpcode refuses for anything with an
    // InventoryType («some item classes can be used only in equipped state»), so nothing happened.
    if (world.vendor !== undefined) {
      world.sellToVendor(item.guid);
      return;
    }
    this.#useCarriedItem(world, item, () => this.useContainerItem(bagId, slot));
  }

  /** The Lua cursor holds a GUID and a wire position; only the realm changes the inventory. */
  #cursorSource(): ItemSlotState | undefined {
    const selected = this.#itemCursor;
    if (!selected) return undefined;
    const world = this.#context.world();
    const inventory = world?.state && typeof world.state.objects?.get === "function"
      ? playerInventory(world.state) : undefined;
    const source = inventory && slotAt(inventory, selected.bag, selected.slot);
    // A split part outlives its stack no better than a whole item outlives its slot.
    if (world !== selected.world || !source?.item || source.guid !== selected.guid
      || (selected.count !== undefined && selected.count >= stackCount(source))
      || (isBankSlot(selected.bag, selected.slot) && world.bankerGuid === undefined)) {
      this.clearCursor();
      return undefined;
    }
    return source;
  }

  #setCursor(source: ItemSlotState | undefined): void {
    const world = this.#context.world();
    this.#itemCursor = source?.item && source.guid !== 0n && world
      ? { world, bag: source.bag, slot: source.slot, guid: source.guid } : undefined;
    // One thing on the cursor: an item picked up drops a macro held there.
    if (this.#itemCursor) this.macros.clearCursor();
    if (this.#itemCursor) this.guildBank.clearCursor();
    if (typeof document !== "undefined") {
      document.body?.classList?.toggle("framexml-item-cursor", this.#itemCursor !== undefined);
    }
    this.#pump?.fire("CURSOR_UPDATE");
  }

  #clickItemSlot(target: ItemSlotState | undefined): boolean {
    if (!target) return false;
    const world = this.#context.world();
    if (!world) return false;
    const source = this.#cursorSource();
    if (source) {
      if (source.bag === target.bag && source.slot === target.slot) {
        this.clearCursor();
        return true;
      }
      if ((isBankSlot(source.bag, source.slot) || isBankSlot(target.bag, target.slot))
        && world.bankerGuid === undefined) {
        this.clearCursor();
        return false;
      }
      const held = this.#itemCursor;
      if (held?.count !== undefined) {
        // A split part: CMSG_SPLIT_ITEM names its destination; the realm makes the stack or refuses.
        world.splitItem(source.bag, source.slot, target.bag, target.slot, held.count);
        this.clearCursor();
        return true;
      }
      // Dropped on the paper doll, an unbound bind-on-equip item asks first (EQUIP_BIND_CONFIRM,
      // FrameXmlItemActions.ts); the hand lets go either way, as in the client.
      const template = target.bag === INVENTORY_SLOT_BAG_0 && target.slot < INVENTORY_SLOT_ITEM_START
        ? this.#itemTemplate(world, entryOf(source.item)) : undefined;
      if (template?.found) {
        this.#equipCarriedItem(world, source, template, FRAMEXML_BIND_CONFIRM_EVENTS.equip,
          { bag: target.bag, slot: target.slot });
        this.clearCursor();
        return true;
      }
      // CMSG_SWAP_INV_ITEM/CMSG_SWAP_ITEM ask the server to move or swap these exact positions.
      // No local item is removed, and stale cursor GUIDs are rejected above before a packet goes out.
      world.moveItem(source.bag, source.slot, target.bag, target.slot);
      this.clearCursor();
      return true;
    }
    if (!target.item || target.guid === 0n
      || (isBankSlot(target.bag, target.slot) && world.bankerGuid === undefined)) return false;
    this.#setCursor(target);
    return true;
  }

  pickupContainerItem(bagId: number, slot: number): void {
    const target = this.#liveContainerSlot(bagId, slot);
    // A held guild bank stack goes into exactly this bag slot (FrameXmlGuildBank.dropOnBagSlot).
    if (target && this.guildBank.dropOnBagSlot(target)) return;
    // A locked bag item (attached to the send draft or offered in the trade) is neither picked up
    // nor swapped with the cursor's item, as in the client. Measured before this: an offered item
    // picked up again and dropped on another trade slot left the stock trade model and WorldClient
    // disagreeing about which item that slot held. Dropping it back on its own slot still clears.
    if (target?.item && target.guid !== 0n && (this.mail.attached(target.guid) || this.trade.offered(target.guid)
      || this.auction.selling(target.guid))
      && this.#cursorSource()?.guid !== target.guid) return;
    // A gem staged in a stock socket is locked the same way; its socket gives it back.
    if (target?.item && target.guid !== 0n && this.socket.staged(target.guid)) return;
    this.#clickItemSlot(target);
  }

  /** The bank panel is still native; its slot coordinates use the same world inventory projection. */
  clickNativeBankSlot(bag: number, slot: number): boolean {
    const world = this.#context.world();
    if (!world || world.bankerGuid === undefined || !isBankSlot(bag, slot)) return false;
    const inventory = playerInventory(world.state);
    if (bag === INVENTORY_SLOT_BAG_0 && slot >= BANK_SLOT_BAG_START
      && slot < BANK_SLOT_BAG_START + BANK_BAG_SLOTS
      && (!inventory || slot - BANK_SLOT_BAG_START >= inventory.bankBagSlotsBought)) return false;
    return this.#clickItemSlot(inventory && slotAt(inventory, bag, slot));
  }

  cursorHasItem(): boolean { return this.#cursorSource() !== undefined || this.guildBank.cursorHasItem(); }

  cursorInfo(): readonly unknown[] {
    const macro = this.macros.cursorInfo();
    if (macro) return macro;
    const vault = this.guildBank.cursorInfo();
    if (vault) return vault;
    const source = this.#cursorSource();
    if (!source?.item) return [];
    const entry = entryOf(source.item);
    const link = this.#itemLink(source.item);
    return link ? ["item", entry, link] : ["item", entry];
  }

  clearCursor(): void {
    this.macros.clearCursor();
    this.guildBank.clearCursor();
    if (!this.#itemCursor) return;
    this.#setCursor(undefined);
  }

  // ---- paper doll -------------------------------------------------------

  inventorySlotInfo(name: string): FrameXmlInventorySlotInfo | undefined {
    return frameXmlInventorySlotInfo(name);
  }

  #equipmentSlot(unit: string, slot: number): ItemSlotState | undefined {
    // The keyring's inventory ids 87..118 (KeyRingButtonIDToInvSlotID), which its tooltip reads through.
    if (unit === "player" && slot > KEYRING_SLOT_START && slot <= KEYRING_SLOT_START + KEYRING_SLOTS) {
      return this.#inventoryOf(this.#context.world())?.keyring[slot - KEYRING_SLOT_START - 1];
    }
    // Stock BankFrame reads the bank as inventory ids 40..74 (BankButtonIDToInvSlotID, FrameXmlBank.ts).
    if (unit === "player" && slot >= FRAMEXML_FIRST_BANK_INVENTORY_ID) {
      return liveFrameXmlBankInventorySlot(this.#context.world(), slot);
    }
    if (unit !== "player" || !Number.isInteger(slot) || slot < 1 || slot > 23) return undefined;
    const world = this.#context.world();
    if (!world || typeof world.state.objects?.get !== "function") return undefined;
    const inventory = world ? playerInventory(world.state) : undefined;
    if (!inventory) return undefined;
    if (slot <= 19) return inventory.equipment[slot - 1];
    const bag = inventory.bags.find((candidate) => candidate.bagSlot === 19 + slot - 20);
    if (!bag) return undefined;
    // The four bag buttons are inventory slots 20..23. Their item is the bag object itself, while
    // the opcodes still address it through the player's bag (255) at slots 19..22.
    return {
      index: slot - 1,
      item: bag.bag,
      guid: bag.guid,
      bag: INVENTORY_SLOT_BAG_0,
      slot: bag.bagSlot,
    };
  }

  /**
   * The AmmoSlot, inventory id 0 (`INVSLOT_AMMO`, GetInventorySlotInfo("AmmoSlot")), is no item
   * position: its item is PLAYER_AMMO_ID, the entry `Player::SetAmmo` wrote (Player.cpp:12246-12266),
   * and its count every carried stack of that entry — the `GetItemCount` sum `HandleSetAmmoOpcode`
   * checks (ItemHandler.cpp:829). Nothing while the field is 0. The field outlives the last arrow:
   * a shot spends one with DestroyItemCount (Spell.cpp:5102-5103) and only the next shot with none
   * left clears it (Spell.cpp:7429-7432), so a count of 0 keeps the entry.
   */
  #ammoEntry(unit: string): number | undefined {
    const player = unit === "player" ? this.#self() : undefined;
    const entry = player ? readField(player, "PLAYER_AMMO_ID") : undefined;
    return entry !== undefined && Number.isSafeInteger(entry) && entry > 0 ? entry : undefined;
  }

  inventoryItemTexture(unit: string, slot: number): string | undefined {
    if (slot === FRAMEXML_INVSLOT_AMMO) {
      const ammo = this.#ammoEntry(unit);
      return ammo === undefined ? undefined : this.#itemTexture(ammo);
    }
    const item = this.#equipmentSlot(unit, slot)?.item;
    return item ? this.#itemTexture(entryOf(item)) : undefined;
  }

  inventoryItemLink(unit: string, slot: number): string | undefined {
    if (slot === FRAMEXML_INVSLOT_AMMO) {
      const ammo = this.#ammoEntry(unit);
      return ammo === undefined ? undefined : this.#entryLink(ammo);
    }
    return this.#itemLink(this.#equipmentSlot(unit, slot)?.item);
  }

  #itemLink(item: WorldObjectState | undefined): string | undefined {
    return item ? this.#entryLink(entryOf(item), item) : undefined;
  }

  /** An entry's chat link; the instance's parts (enchantments, random suffix) are `item`'s, zero without one. */
  #entryLink(entry: number, item?: WorldObjectState): string | undefined {
    if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
    const world = this.#context.world();
    const template = this.#itemTemplate(world, entry);
    const metadata = this.#context.itemInfo?.(entry);
    const name = template?.found ? template.name : metadata?.name;
    const quality = template?.found ? template.quality : metadata?.quality;
    const color = QUALITY_LINK_COLORS[quality ?? 1] ?? QUALITY_LINK_COLORS[1];
    const enchantOffset = UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset;
    const enchant = (index: number): number => item?.fields.get(enchantOffset + index * 3) ?? 0;
    const random = item ? (readField(item, "ITEM_FIELD_RANDOM_PROPERTIES_ID") ?? 0) | 0 : 0;
    const suffix = item ? readField(item, "ITEM_FIELD_PROPERTY_SEED") ?? 0 : 0;
    const player = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    const level = player ? readField(player, "UNIT_FIELD_LEVEL") ?? 0 : 0;
    // TSItem::GetItemLink uses permanent, three socket and socket-bonus enchantments, then suffix/level.
    return `|c${color}|Hitem:${entry}:${enchant(0)}:${enchant(2)}:${enchant(3)}:${enchant(4)}:${enchant(5)}:${random}:${suffix}:${level}|h[${name || "Item"}]|h|r`;
  }

  /** Item identity for GameTooltip; all reads stay on the already-cached world snapshot. */
  inventoryItemTooltip(unit: string, slot: number): FrameXmlInventoryTooltipItem | undefined {
    if (slot === FRAMEXML_INVSLOT_AMMO) {
      // The AmmoSlot's entry and carried count (`#ammoEntry`); ammo has no enchantment or durability.
      const ammo = this.#ammoEntry(unit);
      return ammo === undefined ? undefined : this.#entryTooltip(ammo, this.itemCount(ammo, false), []);
    }
    const state = this.#equipmentSlot(unit, slot);
    if (!state?.item) return undefined;
    const entry = entryOf(state.item);
    if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
    const result = this.#entryTooltip(entry, stackCount(state), itemEnchantmentIds(state.item));
    const durability = readField(state.item, "ITEM_FIELD_DURABILITY");
    return typeof durability === "number" && Number.isFinite(durability) && durability >= 0
      ? { ...result, durability } : result;
  }

  /** The cached template and the host's metadata of an entry, for GameTooltip; nothing is fetched. */
  #entryTooltip(entry: number, count: number, enchantments: readonly number[]): FrameXmlInventoryTooltipItem {
    const template = this.#itemTemplate(this.#context.world(), entry);
    const metadata = this.#context.itemInfo?.(entry);
    return {
      entry, count, enchantments,
      ...(template?.found === true ? { template } : {}),
      ...(metadata && metadata.name.length > 0 ? { metadata: {
        entry, name: metadata.name, displayId: 0,
        quality: metadata.quality ?? (template?.found === true ? template.quality : 0),
        inventoryType: template?.found === true ? template.inventoryType : 0,
        stackable: template?.found === true ? template.stackable : 0,
        iconId: 0,
      } } : {}),
    };
  }

  inventoryItemCount(unit: string, slot: number): number {
    if (slot === FRAMEXML_INVSLOT_AMMO) {
      const ammo = this.#ammoEntry(unit);
      return ammo === undefined ? 0 : this.itemCount(ammo, false);
    }
    const item = this.#equipmentSlot(unit, slot);
    return item?.item ? stackCount(item) : 0;
  }

  inventoryItemBroken(unit: string, slot: number): boolean {
    const object = this.#equipmentSlot(unit, slot)?.item;
    if (!object) return false;
    const durability = readField(object, "ITEM_FIELD_DURABILITY");
    const maxDurability = readField(object, "ITEM_FIELD_MAXDURABILITY");
    // A missing owner-only durability pair is unknown, not evidence of a broken item. A zero
    // durability value is the one authoritative broken state the update fields carry.
    return typeof maxDurability === "number" && maxDurability > 0
      && typeof durability === "number" && durability <= 0;
  }

  inventoryItemCooldown(unit: string, slot: number): FrameXmlContainerItemCooldown {
    return this.#itemCooldown(entryOf(this.#equipmentSlot(unit, slot)?.item));
  }

  inventoryItemLocked(): boolean {
    // ITEM_FIELD_FLAGS is public, but it does not mean the client-side temporary lock used by
    // ContainerFrame. No authoritative lock bit is retained by this host.
    return false;
  }

  useInventoryItem(unit: string, slot: number): void {
    const world = this.#context.world();
    const item = this.#equipmentSlot(unit, slot);
    if (!world || !item?.item || item.guid === 0n) return;
    // At a merchant a right click on the paper doll sells the piece, as in the client.
    if (world.vendor !== undefined) {
      world.sellToVendor(item.guid);
      return;
    }
    const entry = entryOf(item.item);
    const template = this.#itemTemplate(world, entry);
    if (template === undefined && this.#awaitItemTemplate(world, item, entry, () => this.useInventoryItem(unit, slot))) return;
    // Worn gear with no use effect sends nothing, as in the client; the realm would only refuse it.
    if (template?.found && itemUseSpellId(template) === undefined) return;
    // Equipment and bag use share the existing authoritative opcode bridge. Do not synthesize a
    // client-side equip/use operation when the world has not exposed an item to that bridge.
    this.#useItemAfterBindPrompt(world, item, template);
  }

  pickupInventoryItem(unit: string, slot: number): void {
    // An enchant waiting for its item takes the paper doll's click (PaperDollItemSlotButton_OnClick).
    if (this.tradeSkill.targetItem(this.#equipmentSlot(unit, slot)?.guid)) return;
    if (unit === "player" && slot === FRAMEXML_INVSLOT_AMMO) {
      this.#dropOnAmmoSlot();
      return;
    }
    this.#clickItemSlot(this.#equipmentSlot(unit, slot));
  }

  /**
   * `PickupInventoryItem(INVSLOT_AMMO)`, the AmmoSlot's click and its OnReceiveDrag (PaperDollFrame.xml):
   * the slot is no item position (`#ammoEntry`), so the held item is not moved there but named to
   * CMSG_SET_AMMO — a whole stack or a split part alike, since no stack moves — and the hand lets go.
   * The realm judges it as it judges a drop on a row the item cannot take (`#equipCarriedItem`):
   * `Player::CanUseAmmo` refuses anything but INVTYPE_AMMO with EQUIP_ERR_ONLY_AMMO_CAN_GO_HERE
   * (Player.cpp:12216-12244). With nothing held the click does nothing: what the original client
   * does then is not established here.
   */
  #dropOnAmmoSlot(): void {
    const world = this.#context.world();
    const source = this.#cursorSource();
    if (!world || !source?.item) return;
    const entry = entryOf(source.item);
    this.clearCursor();
    if (entry > 0) world.setAmmo(entry);
  }

  // ---- the stock item actions (FrameXmlItemActions.ts) ------------------

  /** An equip or swap held while a bind prompt is up: EquipPendingItem sends it, CancelPendingEquip drops it. */
  #pendingEquip: {
    world: WorldClient;
    /** The stock slot id the prompt was fired with, which its answer hands back. */
    slot: number;
    source: { bag: number; slot: number; guid: bigint };
    target?: { bag: number; slot: number };
  } | undefined;
  /** A use held while USE_BIND is up (ConfirmBindOnUse). */
  #pendingUse: { world: WorldClient; bag: number; slot: number; guid: bigint } | undefined;
  /** Drops the one click waiting for its item template (`#awaitItemTemplate`). */
  #cancelPendingTemplateClick: (() => void) | undefined;

  #inventoryOf(world: WorldClient | undefined): PlayerInventoryState | undefined {
    return world && typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
  }

  #itemSoulbound(item: WorldObjectState | undefined): boolean {
    return item !== undefined && ((readField(item, "ITEM_FIELD_FLAGS") ?? 0) & FRAMEXML_ITEM_FIELD_FLAG_SOULBOUND) !== 0;
  }

  /** `Player::CanDualWield` is the dual-wield passive's effect; the known spells say whether it is there. */
  #canDualWield(world: WorldClient): boolean {
    return Array.isArray(world.knownSpells) && world.knownSpells.some((spell) => FRAMEXML_DUAL_WIELD_SPELLS.has(spell.id));
  }

  /** An item by id, link or — over the session's cached templates only — name; nothing is fetched. */
  #itemEntryOf(world: WorldClient | undefined, value: unknown): number | undefined {
    const direct = frameXmlItemEntry(value);
    if (direct !== undefined) return direct;
    if (typeof value !== "string" || value.length === 0 || !(world?.itemTemplates instanceof Map)) return undefined;
    const wanted = value.toLowerCase();
    for (const template of world.itemTemplates.values()) {
      if (template.found && template.name.toLowerCase() === wanted) return template.entry;
    }
    return undefined;
  }

  /** A prompt counts as asked only when a handler took it (UIParent's); with none, nobody could ever answer. */
  #askBindPrompt(event: string, ...args: readonly unknown[]): boolean {
    return (this.#pump?.fire(event, ...args) ?? 0) > 0;
  }

  /**
   * The stock slot id (1-based) an equip of this template would fill: the first empty of the slots its
   * InventoryType may take, else the first (`Player::FindEquipSlot`); 0 for a type that fits no row.
   */
  #equipTargetSlot(world: WorldClient, template: ItemTemplate): number {
    const candidates = frameXmlEquipmentSlotsForInventoryType(template.inventoryType, this.#canDualWield(world));
    const inventory = this.#inventoryOf(world);
    const empty = candidates.find((index) => index < EQUIPMENT_SLOT_NAMES.length
      ? inventory?.equipment[index]?.item === undefined
      : !inventory?.bags.some((bag) => bag.bagSlot === index));
    const chosen = empty ?? candidates[0];
    return chosen === undefined ? 0 : chosen + 1;
  }

  /**
   * The realm decides what a right-clicked item does, but it decides by packet: CMSG_SET_AMMO for ammo,
   * CMSG_AUTOEQUIP_ITEM for gear, CMSG_USE_ITEM for the rest, and it refuses the wrong one. The template
   * tells them apart; one still on its way holds the click (`#awaitItemTemplate`), and `retry` is the
   * click made again.
   */
  #useCarriedItem(world: WorldClient, item: ItemSlotState, retry: () => void): void {
    const entry = entryOf(item.item);
    const template = this.#itemTemplate(world, entry);
    if (template === undefined && this.#awaitItemTemplate(world, item, entry, retry)) return;
    // Ammo is neither worn nor used: its entry becomes PLAYER_AMMO_ID through CMSG_SET_AMMO, the one
    // handler that takes INVTYPE_AMMO (HandleSetAmmoOpcode, ItemHandler.cpp:814; Player::CanUseAmmo,
    // Player.cpp:12216). Measured before this: Rough Arrow sent CMSG_AUTOEQUIP_ITEM, which
    // FindEquipSlot has no row for.
    if (template?.found && template.inventoryType === FRAMEXML_INVTYPE_AMMO) {
      world.setAmmo(entry);
      return;
    }
    const worn = item.bag === INVENTORY_SLOT_BAG_0 && item.slot < INVENTORY_SLOT_ITEM_START;
    // Gear is what fits an equipment row or a bag slot; a template naming no such InventoryType is not.
    if (template?.found && !worn && frameXmlEquipmentSlotsForInventoryType(template.inventoryType, true).length > 0) {
      this.#equipCarriedItem(world, item, template, FRAMEXML_BIND_CONFIRM_EVENTS.autoEquip);
      return;
    }
    this.#useItemAfterBindPrompt(world, item, template);
  }

  /**
   * CMSG_AUTOEQUIP_ITEM — or CMSG_SWAP_ITEM/CMSG_SWAP_INV_ITEM into `target` — for a carried item, after
   * the bind prompt when wearing it would bind it: `event` is the auto-equip or the equip form
   * (FRAMEXML_BIND_CONFIRM_EVENTS), its argument the slot the item would take. A prompt nobody handles
   * (a corpus without UIParent) does not swallow the click: the realm binds on equip either way.
   */
  #equipCarriedItem(world: WorldClient, item: ItemSlotState, template: ItemTemplate, event: string,
    target?: { bag: number; slot: number }): void {
    const candidates = frameXmlEquipmentSlotsForInventoryType(template.inventoryType, this.#canDualWield(world));
    const slot = target ? target.slot + 1 : this.#equipTargetSlot(world, template);
    // A drop on a row the item cannot take is the realm's to refuse, not a prompt's to ask about.
    const fits = target === undefined || (target.bag === INVENTORY_SLOT_BAG_0 && candidates.includes(target.slot));
    if (fits && template.bonding === FRAMEXML_BIND_WHEN_EQUIPPED && !this.#itemSoulbound(item.item)) {
      this.#pendingEquip = {
        world, slot, source: { bag: item.bag, slot: item.slot, guid: item.guid }, ...(target ? { target } : {}),
      };
      if (this.#askBindPrompt(event, slot)) return;
      this.#pendingEquip = undefined;
    }
    if (target) world.moveItem(item.bag, item.slot, target.bag, target.slot);
    else world.equipItem(item.bag, item.slot);
  }

  /** CMSG_USE_ITEM (or CMSG_OPEN_ITEM, WorldClient.useItem), after USE_BIND for an unbound bind-on-use item. */
  #useItemAfterBindPrompt(world: WorldClient, item: ItemSlotState, template: ItemTemplate | undefined): void {
    if (template?.found && template.bonding === FRAMEXML_BIND_WHEN_USE && !this.#itemSoulbound(item.item)) {
      this.#pendingUse = { world, bag: item.bag, slot: item.slot, guid: item.guid };
      if (this.#askBindPrompt(FRAMEXML_BIND_CONFIRM_EVENTS.use)) return;
      this.#pendingUse = undefined;
    }
    requestInventoryItemUse(item, () => world.useItem(item.bag, item.slot, item.guid));
  }

  /**
   * The same right click means «wear» for a belt and «drink» for a potion, and only the item's template
   * says which. One not yet in the session cache is asked of the realm (CMSG_ITEM_QUERY_SINGLE) and the
   * click waits for the answer — one click at a time, resumed once, and only while the same item still
   * stands in that slot (WorldClient.useItem keeps the same rule for its own deferred use). False when
   * this world cannot be asked, which leaves the click to the plain use.
   */
  #awaitItemTemplate(world: WorldClient, item: ItemSlotState, entry: number, retry: () => void): boolean {
    if (entry <= 0 || typeof world.itemTemplate !== "function" || typeof world.events?.on !== "function") return false;
    this.#cancelPendingTemplateClick?.();
    if (world.itemTemplate(entry) !== undefined) return false;
    const { bag, slot, guid } = item;
    const off = world.events.on("QUERY_CACHE_CHANGED", (event) => {
      if (event.kind === "item" ? event.id !== entry : event.kind !== "cleared") return;
      cancel();
      if (event.kind !== "item" || this.#context.world() !== world) return;
      const inventory = this.#inventoryOf(world);
      const current = inventory && slotAt(inventory, bag, slot);
      if (current?.guid === guid) retry();
    });
    const cancel = (): void => {
      off();
      const index = this.#unsubscribe.indexOf(cancel);
      if (index >= 0) this.#unsubscribe.splice(index, 1);
      if (this.#cancelPendingTemplateClick === cancel) this.#cancelPendingTemplateClick = undefined;
    };
    this.#cancelPendingTemplateClick = cancel;
    // Detach drains this list, so a held click never outlives the seam's world subscriptions.
    this.#unsubscribe.push(cancel);
    return true;
  }

  equipPendingItem(slot: number | undefined): void {
    const pending = this.#pendingEquip;
    this.#pendingEquip = undefined;
    const world = this.#context.world();
    if (!pending || !world || pending.world !== world || (slot !== undefined && slot !== pending.slot)) return;
    // The realm may have moved the item while the prompt was up: the answer names the item, not the slot.
    const inventory = this.#inventoryOf(world);
    const source = inventory && slotAt(inventory, pending.source.bag, pending.source.slot);
    if (!source?.item || source.guid !== pending.source.guid) return;
    if (pending.target) world.moveItem(source.bag, source.slot, pending.target.bag, pending.target.slot);
    else world.equipItem(source.bag, source.slot);
  }

  cancelPendingEquip(slot: number | undefined): void {
    // OnHide cancels after OnAccept too (StaticPopup.lua:1535): an answered prompt has nothing to drop.
    if (this.#pendingEquip && (slot === undefined || slot === this.#pendingEquip.slot)) this.#pendingEquip = undefined;
  }

  confirmBindOnUse(): void {
    const pending = this.#pendingUse;
    this.#pendingUse = undefined;
    const world = this.#context.world();
    if (!pending || !world || pending.world !== world) return;
    const inventory = this.#inventoryOf(world);
    const source = inventory && slotAt(inventory, pending.bag, pending.slot);
    if (!source?.item || source.guid !== pending.guid) return;
    requestInventoryItemUse(source, () => world.useItem(source.bag, source.slot, source.guid));
  }

  /**
   * `PutItemInBackpack()` / `PutItemInBag(20..23)`: the held item into that container's first free slot
   * (CMSG_AUTOSTORE_BAG_ITEM; CMSG_SPLIT_ITEM to the slot for a split part), or — no bag in the slot —
   * into the slot itself, which is how a held bag is equipped there. False with nothing held or nowhere
   * to go, and stock opens the bag instead.
   */
  storeCursorItemInBag(bagId: number): boolean {
    const world = this.#context.world();
    const source = this.#cursorSource();
    const inventory = this.#inventoryOf(world);
    if (!world || !source?.item || !inventory) return false;
    const container = this.#liveContainer(bagId, inventory, world);
    if (!container) {
      if (bagId < 1 || bagId > 4) return false;
      const bagSlot = INVENTORY_SLOT_BAG_START + bagId - 1;
      return this.#clickItemSlot({ index: bagId - 1, item: undefined, guid: 0n, bag: INVENTORY_SLOT_BAG_0, slot: bagSlot });
    }
    const count = this.#itemCursor?.count;
    if (count !== undefined) {
      const free = container.slots.find((candidate) => candidate.item === undefined);
      if (free) world.splitItem(source.bag, source.slot, free.bag, free.slot, count);
    } else {
      world.storeItemInBag(source.bag, source.slot, bagId === 0 ? INVENTORY_SLOT_BAG_0 : INVENTORY_SLOT_BAG_START + bagId - 1);
    }
    this.clearCursor();
    return true;
  }

  /**
   * `SplitContainerItem(bag, slot, count)`: the part goes on the cursor, as in the client, and the next
   * slot click (`#clickItemSlot`) or bag button (`storeCursorItemInBag`) sends CMSG_SPLIT_ITEM naming its
   * destination; the realm makes the new stack. False for anything but a proper part of an unlocked stack.
   */
  splitContainerItem(bagId: number, slot: number, count: number): boolean {
    const world = this.#context.world();
    const source = this.#liveContainerSlot(bagId, slot);
    if (!world || !source?.item || source.guid === 0n || !Number.isInteger(count) || count < 1
      || count >= stackCount(source)) return false;
    if (isBankSlot(source.bag, source.slot) && world.bankerGuid === undefined) return false;
    // Locked as pickupContainerItem locks: the letter, the trade, the auction or a socket holds it.
    if (this.mail.attached(source.guid) || this.trade.offered(source.guid) || this.auction.selling(source.guid)
      || this.socket.staged(source.guid)) return false;
    this.#setCursor(source);
    if (!this.#itemCursor) return false;
    this.#itemCursor = { ...this.#itemCursor, count };
    return true;
  }

  deleteSplitCursorItem(): boolean {
    const count = this.#itemCursor?.count;
    if (count === undefined) return false;
    const world = this.#context.world();
    const source = this.#cursorSource();
    if (world && source) world.destroyItem(source.bag, source.slot, count);
    this.clearCursor();
    return true;
  }

  autoEquipCursorItem(): void {
    const world = this.#context.world();
    const source = this.#cursorSource();
    // A split part is a stack, and a stack is not worn.
    if (!world || !source?.item || this.#itemCursor?.count !== undefined) return;
    const template = this.#itemTemplate(world, entryOf(source.item));
    this.clearCursor();
    if (template?.found) this.#equipCarriedItem(world, source, template, FRAMEXML_BIND_CONFIRM_EVENTS.autoEquip);
    else world.equipItem(source.bag, source.slot);
  }

  equipCursorItem(slot: number): void {
    if (this.#cursorSource() === undefined) return;
    this.#clickItemSlot(this.#equipmentSlot("player", slot));
  }

  /** `EquipItemByName(item[, slot])`: the first carried copy is worn, into `slot` when one is named. */
  equipItemByName(value: unknown, slot: number | undefined): void {
    const world = this.#context.world();
    const entry = this.#itemEntryOf(world, value);
    const inventory = this.#inventoryOf(world);
    if (!world || entry === undefined || !inventory) return;
    const source = [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)]
      .find((candidate) => candidate.item !== undefined && entryOf(candidate.item) === entry);
    if (!source) return;
    const template = this.#itemTemplate(world, entry);
    const target = slot !== undefined && slot >= 1 && slot <= 23 ? { bag: INVENTORY_SLOT_BAG_0, slot: slot - 1 } : undefined;
    if (template?.found) {
      this.#equipCarriedItem(world, source, template,
        target ? FRAMEXML_BIND_CONFIRM_EVENTS.equip : FRAMEXML_BIND_CONFIRM_EVENTS.autoEquip, target);
    } else if (target) {
      world.moveItem(source.bag, source.slot, target.bag, target.slot);
    } else {
      world.equipItem(source.bag, source.slot);
    }
  }

  /**
   * A highlight only: the realm still judges the drop, and a held split part fits no slot but the
   * AmmoSlot, which takes an INVTYPE_AMMO entry whatever the stack (`#dropOnAmmoSlot`). The AmmoSlot
   * asks too: it is a PaperDollItemSlotButton, whose CURSOR_UPDATE calls CursorCanGoInSlot(self:GetID()).
   */
  cursorCanGoInSlot(slot: number): boolean {
    const world = this.#context.world();
    const source = this.#cursorSource();
    if (!world || !source?.item) return false;
    const template = this.#itemTemplate(world, entryOf(source.item));
    if (!template?.found) return false;
    if (slot === FRAMEXML_INVSLOT_AMMO) return template.inventoryType === FRAMEXML_INVTYPE_AMMO;
    if (this.#itemCursor?.count !== undefined) return false;
    return frameXmlEquipmentSlotsForInventoryType(template.inventoryType, this.#canDualWield(world)).includes(slot - 1);
  }

  containerItemDurability(bagId: number, slot: number): readonly [number, number] | undefined {
    const wear = itemWear(this.#liveContainerSlot(bagId, slot)?.item);
    return wear ? [wear.durability, wear.maximum] : undefined;
  }

  inventoryItemDurability(slot: number): readonly [number, number] | undefined {
    const wear = itemWear(this.#equipmentSlot("player", slot)?.item);
    return wear ? [wear.durability, wear.maximum] : undefined;
  }

  inventoryItemQuality(unit: string, slot: number): number | undefined {
    const item = this.#equipmentSlot(unit, slot)?.item;
    if (!item) return undefined;
    const entry = entryOf(item);
    const template = this.#itemTemplate(this.#context.world(), entry);
    return template?.found ? template.quality : this.#context.itemInfo?.(entry)?.quality;
  }

  inventoryItemId(unit: string, slot: number): number | undefined {
    const entry = entryOf(this.#equipmentSlot(unit, slot)?.item);
    return entry > 0 ? entry : undefined;
  }

  containerItemId(bagId: number, slot: number): number | undefined {
    const entry = entryOf(this.#liveContainerSlot(bagId, slot)?.item);
    return entry > 0 ? entry : undefined;
  }

  /** Carried bags and the keyring, the bank on request; worn gear is `isEquippedItem`'s, as in the client. */
  itemCount(value: unknown, includeBank: boolean): number {
    const world = this.#context.world();
    const entry = this.#itemEntryOf(world, value);
    const inventory = this.#inventoryOf(world);
    return entry === undefined || !inventory ? 0 : this.#carriedCount(inventory, entry, includeBank);
  }

  /**
   * `itemCount`'s sum over an inventory already built: the backpack, the keyring and the carried bags,
   * the bank and its bags on request. Plain loops, because the paper doll's 60 ms poll runs it too.
   */
  #carriedCount(inventory: PlayerInventoryState, entry: number, includeBank: boolean): number {
    let count = 0;
    const add = (slots: readonly ItemSlotState[]): void => {
      for (const candidate of slots) {
        if (candidate.item !== undefined && entryOf(candidate.item) === entry) count += stackCount(candidate);
      }
    };
    add(inventory.backpack);
    add(inventory.keyring);
    for (const bag of inventory.bags) add(bag.slots);
    if (includeBank) {
      add(inventory.bank);
      for (const bag of inventory.bankBags) add(bag.slots);
    }
    return count;
  }

  /** The use spell's name and rank from the cached spell row; nil until the template and the row are both known. */
  itemSpell(value: unknown): readonly [string, string] | undefined {
    const world = this.#context.world();
    const entry = this.#itemEntryOf(world, value);
    const template = entry === undefined ? undefined : this.#itemTemplate(world, entry);
    const spellId = itemUseSpellId(template);
    const spell = spellId === undefined ? undefined : this.#context.spell(spellId);
    return spell ? [spell.name, spell.rank] : undefined;
  }

  itemIcon(value: unknown): string | undefined {
    const entry = this.#itemEntryOf(this.#context.world(), value);
    return entry === undefined ? undefined : this.itemTexture(entry);
  }

  isEquippableItem(value: unknown): boolean | undefined {
    const world = this.#context.world();
    const entry = this.#itemEntryOf(world, value);
    const template = entry === undefined ? undefined : this.#itemTemplate(world, entry);
    if (!template?.found || !Number.isInteger(template.inventoryType)) return undefined;
    return template.inventoryType !== FRAMEXML_INVTYPE_NON_EQUIP;
  }

  isEquippedItem(value: unknown): boolean {
    const world = this.#context.world();
    const entry = this.#itemEntryOf(world, value);
    const inventory = this.#inventoryOf(world);
    if (entry === undefined || !inventory) return false;
    return inventory.equipment.some((worn) => worn.item !== undefined && entryOf(worn.item) === entry)
      || inventory.bags.some((bag) => entryOf(bag.bag) === entry);
  }

  /** Whether the item has a use at all; the realm's own checks (level, class, reagents) are not modelled. */
  isUsableItem(value: unknown): boolean | undefined {
    const world = this.#context.world();
    const entry = this.#itemEntryOf(world, value);
    const template = entry === undefined ? undefined : this.#itemTemplate(world, entry);
    return template?.found ? itemUseSpellId(template) !== undefined : undefined;
  }

  isConsumableItem(value: unknown): boolean | undefined {
    const world = this.#context.world();
    const entry = this.#itemEntryOf(world, value);
    const template = entry === undefined ? undefined : this.#itemTemplate(world, entry);
    return template?.found ? template.itemClass === FRAMEXML_ITEM_CLASS_CONSUMABLE : undefined;
  }

  itemCooldown(value: unknown): FrameXmlContainerItemCooldown {
    const entry = this.#itemEntryOf(this.#context.world(), value);
    return entry === undefined ? [0, 0, 0] : this.#itemCooldown(entry);
  }

  /**
   * `GetInventoryItemsForSlot(slot, table)`: every carried item that fits the paper-doll slot, keyed by
   * the equipment manager's packed location (Constants.lua:183-186: ITEM_INVENTORY_LOCATION_PLAYER, and
   * for a bag ITEM_INVENTORY_LOCATION_BAGS with the stock container id above bit 8 and the 1-based slot
   * below it), plus the worn item under PLAYER + slot, which PaperDollFrameItemFlyout_Show removes
   * itself. Flat (location, id, …) for FrameXmlItemActions' Lua half to key; the bank is not offered.
   */
  inventoryItemsForSlot(slot: number): readonly number[] {
    const world = this.#context.world();
    if (!world || !Number.isInteger(slot) || slot < 1 || slot > 23) return [];
    const result: number[] = [];
    const worn = this.#equipmentSlot("player", slot)?.item;
    if (worn) result.push(FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER + slot, entryOf(worn));
    const dualWield = this.#canDualWield(world);
    for (const [bagId, container] of this.#liveContainers(world)) {
      // The keyring (-2) holds no gear.
      if (bagId < 0) continue;
      container.slots.forEach((candidate, index) => {
        if (!candidate.item) return;
        const template = this.#itemTemplate(world, entryOf(candidate.item));
        if (!template?.found) return;
        if (!frameXmlEquipmentSlotsForInventoryType(template.inventoryType, dualWield).includes(slot - 1)) return;
        result.push(FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER + FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS
          + (bagId << FRAMEXML_ITEM_INVENTORY_BAG_BIT_OFFSET) + index + 1, template.entry);
      });
    }
    return result;
  }

  /**
   * `GetInventoryAlertStatus(index)` over DurabilityFrame's own slot order (FRAMEXML_INVENTORY_ALERT_SLOTS):
   * 2 for a broken piece, 1 for one worn to a fifth, 0 otherwise — the thresholds the reference client
   * answers with (CPPClientExample/wowee, lua_inventory_api.cpp); a piece without durability is sound.
   */
  inventoryAlertStatus(index: number): number {
    const equipmentIndex = FRAMEXML_INVENTORY_ALERT_SLOTS[index - 1];
    if (equipmentIndex === undefined) return 0;
    const wear = itemWear(this.#inventoryOf(this.#context.world())?.equipment[equipmentIndex]?.item);
    if (!wear) return 0;
    if (wear.durability <= 0) return 2;
    return wear.durability * 5 <= wear.maximum ? 1 : 0;
  }

  // ---- quest log and tracker --------------------------------------------

  questGiverCall(name: string, args: readonly unknown[]): readonly unknown[] {
    const world = this.#context.world();
    if (!world) return [];
    const command = resolveFrameXmlQuestGiverCommand(name, args, world);
    if (command) {
      performFrameXmlQuestGiverCommand(world, command);
      return [];
    }
    const menuFacts = world.questList && name === "GetActiveTitle" ? {
      activeCompleteByQuestId: new Map(this.#questRows().map((entry) => [
        entry.questId, (entry.state & QUEST_STATE_COMPLETE) !== 0,
      ])),
    } : undefined;
    return frameXmlQuestGiverRead(name, args, world, {
      ...(menuFacts ? { menuFacts } : {}),
      rewardMetadata: {
        item: (itemId) => {
          const cached = this.#questItemInfo({ itemId, count: 1 });
          return cached && cached[1] ? {
            name: cached[0], texture: cached[1],
            ...(cached[3] === undefined ? {} : { quality: cached[3] }),
            ...(cached[4] === undefined ? {} : { isUsable: cached[4] }),
          } : undefined;
        },
        spell: (spellId) => {
          const cached = this.#context.spell(spellId);
          const known = Array.isArray(world.knownSpells)
            ? world.knownSpells.some((spell) => spell.id === spellId) : undefined;
          return cachedQuestRewardSpellInfo(cached, known);
        },
      },
    }) ?? [];
  }

  /** The browser log is the compact, header-free order present in the player's update fields. */
  #questRows(): QuestLogEntry[] {
    const player = this.#self();
    return player ? playerFields.quests(player) : [];
  }

  #questAt(index: number | undefined): QuestLogEntry | undefined {
    const resolved = index === undefined ? this.#questSelection : index;
    if (!Number.isInteger(resolved) || resolved < 1) return undefined;
    return this.#questRows()[resolved - 1];
  }

  #questTemplate(entry: QuestLogEntry | undefined): QuestTemplate | undefined {
    return entry ? this.#questTemplateById(entry.questId) : undefined;
  }

  #questTemplateById(questId: number): QuestTemplate | undefined {
    const templates = this.#context.world()?.questTemplates;
    return templates instanceof Map ? templates.get(questId) : undefined;
  }

  #questIndexForId(questId: number): number | undefined {
    const index = this.#questRows().findIndex((entry) => entry.questId === questId);
    return index < 0 ? undefined : index + 1;
  }

  #invalidateCurrentMapQuestIds(): void {
    this.#currentMapQuestIdsCache = undefined;
    this.#currentMapQuestWorld = undefined;
    this.#currentMapQuestMapId = undefined;
    this.#currentMapQuestAreaId = undefined;
  }

  /**
   * Quest POI responses are the authoritative current-WorldMapArea membership used by
   * WatchFrame's default local-zone filter. The world client keeps one response per quest; no
   * map scan or network request belongs on this C-API read.
   */
  #currentMapQuestIds(): readonly number[] {
    const world = this.#context.world();
    const mapId = world?.mapId;
    const worldMapAreaId = this.#resolvedWorldMapAreaId();
    if (!world || typeof mapId !== "number" || !Number.isSafeInteger(mapId) || mapId < 0
      || typeof worldMapAreaId !== "number" || !Number.isSafeInteger(worldMapAreaId)
      || worldMapAreaId < 0 || !(world.questPoi instanceof Map)) {
      return [];
    }
    if (this.#currentMapQuestIdsCache !== undefined
      && this.#currentMapQuestWorld === world
      && this.#currentMapQuestMapId === mapId
      && this.#currentMapQuestAreaId === worldMapAreaId) {
      return this.#currentMapQuestIdsCache;
    }
    const ids: number[] = [];
    for (const entry of this.#questRows()) {
      const blobs = world.questPoi.get(entry.questId);
      if (Array.isArray(blobs) && blobs.some((blob) => blob.worldMapAreaId === worldMapAreaId)) {
        ids.push(entry.questId);
      }
    }
    this.#currentMapQuestWorld = world;
    this.#currentMapQuestMapId = mapId;
    this.#currentMapQuestAreaId = worldMapAreaId;
    this.#currentMapQuestIdsCache = ids;
    return ids;
  }

  /**
   * Build the carried-item side of item objectives from the same private inventory fields as the
   * browser quest UI. A non-zero guid without a resolved item is deliberately unknown, not zero.
   */
  #questCarriedItems(): ReadonlyMap<number, number> | undefined {
    const world = this.#context.world();
    if (!world || typeof world.state.objects?.get !== "function") return undefined;
    const inventory = playerInventory(world.state);
    if (!inventory) return undefined;
    const slots = [
      ...inventory.equipment,
      ...inventory.backpack,
      ...inventory.keyring,
      ...inventory.bags.flatMap((bag) => bag.slots),
    ];
    const stacks: QuestCarriedItemStack[] = [];
    for (const slot of slots) {
      if (slot.guid !== 0n && !slot.item) return undefined;
      if (!slot.item) continue;
      const entry = entryOf(slot.item);
      if (entry <= 0) return undefined;
      stacks.push({ itemId: entry, count: stackCount(slot) });
    }
    return buildCarriedItemCounts(stacks);
  }

  #questObjectives(index?: number): FrameXmlQuestLogLeaderBoard[] | undefined {
    const entry = this.#questAt(index);
    const template = this.#questTemplate(entry);
    if (!entry || !template) return undefined;
    const rows: FrameXmlQuestLogLeaderBoard[] = [];
    for (const [objectiveIndex, objective] of template.objectives.entries()) {
      const slot = objective.slot ?? objectiveIndex;
      const have = entry.counters[slot] ?? 0;
      const world = this.#context.world();
      const resolvedName = objective.gameObject
        ? world?.gameObjectTemplates?.get(objective.entry)?.name
        : this.#context.creatureInfo?.(objective.entry)?.name
          ?? world?.creatureTemplates?.get(objective.entry)?.name;
      const text = questObjectiveLabel({
        kind: objective.gameObject ? "gameObject" : "creature",
        id: objective.entry,
        poiIndex: slot,
        text: objective.text,
        have,
        need: objective.count,
        done: have >= objective.count,
      }, resolvedName);
      rows.push([
        `${text}: ${have}/${objective.count}`,
        objective.gameObject ? "object" : "monster",
        have >= objective.count,
      ]);
    }
    const carried = this.#questCarriedItems();
    for (const [objectiveIndex, objective] of template.itemObjectives.entries()) {
      const have = carried?.get(objective.itemId);
      const resolvedName = this.#context.itemInfo?.(objective.itemId)?.name
        ?? this.#itemTemplate(this.#context.world(), objective.itemId)?.name;
      const text = questObjectiveLabel({
        kind: "item",
        id: objective.itemId,
        poiIndex: QUEST_OBJECTIVES + (objective.slot ?? objectiveIndex),
        text: "",
        have: have ?? Number.NaN,
        need: objective.count,
        done: have !== undefined && have >= objective.count,
      }, resolvedName);
      rows.push([
        have === undefined
          ? text
          : `${text}: ${have}/${objective.count}`,
        "item",
        have !== undefined && have >= objective.count,
      ]);
    }
    return rows;
  }

  #questShapeSignature(): string {
    const rows = this.#questRows();
    // Item objectives all use one carried snapshot for this boundary. Do not walk the full
    // equipment/backpack/bag graph once per quest row when a single quest-log edge arrives.
    const hasItemObjectives = rows.some((entry) => (this.#questTemplate(entry)?.itemObjectives.length ?? 0) > 0);
    const carried = hasItemObjectives ? this.#questCarriedItems() : undefined;
    // The entries whose cached rows this signature reads, for the query-answer edges.
    const itemIds = new Set<number>();
    const creatureIds = new Set<number>();
    const gameObjectIds = new Set<number>();
    for (const entry of rows) {
      const template = this.#questTemplate(entry);
      for (const item of template?.rewardItems ?? []) itemIds.add(item.itemId);
      for (const item of template?.rewardChoiceItems ?? []) itemIds.add(item.itemId);
      for (const objective of template?.itemObjectives ?? []) itemIds.add(objective.itemId);
      for (const objective of template?.objectives ?? []) {
        (objective.gameObject ? gameObjectIds : creatureIds).add(objective.entry);
      }
    }
    this.#questItemIds = itemIds;
    this.#questCreatureIds = creatureIds;
    this.#questGameObjectIds = gameObjectIds;
    return rows.map((entry) => {
      const template = this.#questTemplate(entry);
      return [
        entry.slot, entry.questId, entry.state, entry.timer, ...entry.counters,
        template?.title ?? "", template?.level ?? 0, template?.suggestedPlayers ?? 0,
        template?.details ?? "", template?.objectivesText ?? "", template?.completedText ?? "",
        template?.rewardMoney ?? 0, template?.requiredMoney ?? 0, template?.rewardDisplaySpell ?? 0,
        template?.rewardSpellCast ?? 0, template?.rewardHonor ?? 0, template?.rewardTalents ?? 0,
        ...(template?.rewardItems ?? []).map((item) => {
          const metadata = this.#context.itemInfo?.(item.itemId);
          const cached = this.#itemTemplate(this.#context.world(), item.itemId);
          return [item.itemId, item.count, metadata?.name ?? cached?.name ?? "",
            metadata?.texture ?? this.#itemTexture(item.itemId) ?? "", metadata?.quality ?? cached?.quality ?? "",
            metadata?.isUsable ?? this.#questItemUsable(cached) ?? ""].join(":");
        }),
        ...(template?.rewardChoiceItems ?? []).map((item) => {
          const metadata = this.#context.itemInfo?.(item.itemId);
          const cached = this.#itemTemplate(this.#context.world(), item.itemId);
          return [item.itemId, item.count, metadata?.name ?? cached?.name ?? "",
            metadata?.texture ?? this.#itemTexture(item.itemId) ?? "", metadata?.quality ?? cached?.quality ?? "",
            metadata?.isUsable ?? this.#questItemUsable(cached) ?? ""].join(":");
        }),
        (() => {
          const spellId = template?.rewardDisplaySpell ?? 0;
          const spell = spellId > 0 ? this.#context.spell(spellId) : undefined;
          return [spell?.name ?? "", spell?.iconPath ?? "",
            Array.isArray(this.#context.world()?.knownSpells)
              && this.#context.world()!.knownSpells.some((known) => known.id === spellId)].join(":");
        })(),
        ...(template?.objectives ?? []).map((objective) => [
          objective.slot, objective.entry, objective.count, objective.gameObject, objective.itemDrop, objective.text,
          objective.gameObject
            ? this.#context.world()?.gameObjectTemplates?.get(objective.entry)?.name ?? ""
            : this.#context.creatureInfo?.(objective.entry)?.name
              ?? this.#context.world()?.creatureTemplates?.get(objective.entry)?.name ?? "",
        ].join(":")),
        ...(template?.itemObjectives ?? []).map((objective) => [
          objective.slot, objective.itemId, objective.count, carried?.get(objective.itemId) ?? "?",
          this.#context.itemInfo?.(objective.itemId)?.name
            ?? this.#itemTemplate(this.#context.world(), objective.itemId)?.name ?? "",
        ].join(":")),
      ].join(":");
    }).join("|");
  }

  /** Ask existing cache clients for reward and objective rows before synchronous quest C APIs. */
  #prefetchQuestMetadata(): void {
    const rows = this.#questRows();
    const world = this.#context.world();
    const forceRefresh = this.#questMetadataInvalidated;
    // Consume the invalidation before starting any query: focused test doubles may answer
    // synchronously, and a nested cache event must not start a second refresh wave.
    this.#questMetadataInvalidated = false;
    const itemIds = new Set<number>();
    const spellIds = new Set<number>();
    const creatureIds = new Set<number>();
    const gameObjectIds = new Set<number>();
    for (const entry of rows) {
      const template = this.#questTemplate(entry);
      for (const item of [...(template?.rewardItems ?? []), ...(template?.rewardChoiceItems ?? [])]) {
        // A row is already synchronously renderable when either cache can supply its name. Only
        // ask the host for entries that would currently return nil from the C API.
        if (item.itemId > 0 && (forceRefresh || this.#questItemInfo(item) === undefined)) {
          itemIds.add(item.itemId);
        }
      }
      for (const item of template?.itemObjectives ?? []) {
        if (item.itemId > 0 && (forceRefresh || !this.#context.itemInfo?.(item.itemId))) {
          itemIds.add(item.itemId);
        }
      }
      for (const objective of template?.objectives ?? []) {
        if (objective.text || objective.entry <= 0) continue;
        if (objective.gameObject) {
          if (forceRefresh || !world?.gameObjectTemplates?.get(objective.entry)) {
            gameObjectIds.add(objective.entry);
          }
        } else if (forceRefresh || (!this.#context.creatureInfo?.(objective.entry)
          && !world?.creatureTemplates?.get(objective.entry))) {
          creatureIds.add(objective.entry);
        }
      }
      const spell = template?.rewardDisplaySpell ?? 0;
      if (spell > 0 && !this.#context.spell(spell)) spellIds.add(spell);
    }
    for (const entry of creatureIds) world?.creatureTemplate?.(entry);
    for (const entry of gameObjectIds) world?.gameObjectTemplate?.(entry, 0n);
    const items = [...itemIds].sort((left, right) => left - right);
    const spells = [...spellIds].sort((left, right) => left - right);
    const signature = `${items.join(",")}|${spells.join(",")}|${[...creatureIds].sort().join(",")}|${[...gameObjectIds].sort().join(",")}`;
    if (signature === this.#questMetadataPrefetchSignature) return;
    this.#questMetadataPrefetchSignature = signature;
    if (items.length === 0 && spells.length === 0) return;
    // Cache clients may also publish their own QUERY_CACHE_CHANGED edge. Use the normal shape
    // gate here so an item arriving through both HTTP and the world query path repaints once.
    const changed = (): void => this.#publishQuestLogChange();
    this.#context.prefetchQuestMetadata?.(items, spells, changed);
    // Focused hosts may omit the richer callback but still expose the standard spell metadata
    // loader through the shared SpellNames helper. The callback is only a repaint edge; it does not
    // change the synchronous getter contract.
    if (spells.length > 0 && !this.#context.prefetchQuestMetadata) ensureSpellNames(spells, changed);
  }

  #publishQuestLogChange(force = false): void {
    const pump = this.#pump;
    if (!pump) return;
    this.#prefetchQuestMetadata();
    const next = this.#questShapeSignature();
    if (!force && next === this.#questLogSignature) return;
    this.#questLogSignature = next;
    pump.fire(FRAMEXML_SEAM_EVENTS.questLogUpdate);
  }

  #publishQuestUnitChange(): void {
    const pump = this.#pump;
    if (!pump) return;
    // A newly accepted quest may already have its quest template cached, so no
    // QUEST_LOG_CHANGED/query-response edge is guaranteed to follow the player field update.
    // Prime its target metadata here as well; the resulting cache edge repaints stock QuestLog.
    this.#prefetchQuestMetadata();
    const next = this.#questShapeSignature();
    if (next === this.#unitQuestLogSignature) return;
    this.#unitQuestLogSignature = next;
    pump.fire(FRAMEXML_SEAM_EVENTS.unitQuestLogChanged, "player");
  }

  #publishQuestProgress(event: { questId: number; entry: number; count: number; required: number }): void {
    const pump = this.#pump;
    if (!pump) return;
    const signature = [event.questId, event.entry, event.count, event.required].join(":");
    if (signature === this.#questProgressSignature) return;
    this.#questProgressSignature = signature;
    const index = this.#questIndexForId(event.questId);
    if (index !== undefined) pump.fire(FRAMEXML_SEAM_EVENTS.questWatchUpdate, index);
  }

  questLogEntryCount(): readonly [number, number] {
    const count = this.#questRows().length;
    return [count, count];
  }

  questLogTitle(index: number): FrameXmlQuestLogTitle {
    const entry = this.#questAt(index);
    const template = this.#questTemplate(entry);
    if (!entry) return ["", 0, undefined, 0, false, false, undefined, false, 0, false];
    const complete = (entry.state & QUEST_STATE_FAIL) !== 0 ? -1
      : (entry.state & QUEST_STATE_COMPLETE) !== 0 ? 1 : undefined;
    return [
      template?.title ?? "", template?.level ?? 0, undefined, template?.suggestedPlayers ?? 0,
      false, false, complete, false, entry.questId, false,
    ];
  }

  selectQuestLogEntry(index: number): void {
    if (index === 0) {
      this.#questSelection = 0;
      return;
    }
    const entry = this.#questAt(index);
    this.#questSelection = entry ? index : 0;
    if (entry) {
      const world = this.#context.world();
      if (world && world.questTemplates instanceof Map && !world.questTemplates.has(entry.questId)
        && typeof world.queryQuest === "function") {
        world.queryQuest(entry.questId);
      }
    }
  }

  questLogSelection(): number {
    return this.#questSelection;
  }

  questLogQuestText(index?: number): readonly [string, string] | undefined {
    const template = this.#questTemplate(this.#questAt(index));
    return template ? [template.details, template.objectivesText] : undefined;
  }

  questLogLeaderBoardCount(index?: number): number {
    return this.#questObjectives(index)?.length ?? 0;
  }

  questLogLeaderBoard(objectiveIndex: number, questIndex?: number): FrameXmlQuestLogLeaderBoard | undefined {
    if (!Number.isInteger(objectiveIndex) || objectiveIndex < 1) return undefined;
    return this.#questObjectives(questIndex)?.[objectiveIndex - 1];
  }

  #questReward(index: number | undefined): QuestTemplate | undefined {
    return this.#questTemplate(this.#questAt(index));
  }

  #questItemUsable(item: ReturnType<WorldClient["itemTemplate"]>): boolean | undefined {
    if (!item) return undefined;
    const player = this.#self();
    if (!player) return undefined;
    const level = unitField.level(player);
    if (item.requiredLevel > 0 && (level === undefined || level < item.requiredLevel)) return false;
    const classId = unitField.classId(player);
    if (item.allowableClass !== 0 && (classId === undefined
      || (item.allowableClass & (1 << Math.max(0, classId - 1))) === 0)) return false;
    const raceId = unitField.race(player);
    if (item.allowableRace !== 0 && (raceId === undefined
      || (item.allowableRace & (1 << Math.max(0, raceId - 1))) === 0)) return false;
    // Skill/spell/reputation requirements are authoritative in ItemTemplate but their player-side
    // progress is not part of this world snapshot. Nil is honest here; false would claim the item
    // is unusable when the missing skill may in fact be present.
    if (item.requiredSkill > 0 || item.requiredSkillRank > 0 || item.requiredSpell > 0
      || item.requiredReputationFaction > 0) return undefined;
    return true;
  }

  #questItemInfo(item: { itemId: number; count: number } | undefined): FrameXmlQuestItemInfo | undefined {
    if (!item || !Number.isInteger(item.itemId) || item.itemId <= 0
      || !Number.isInteger(item.count) || item.count <= 0) return undefined;
    const world = this.#context.world();
    const template = this.#itemTemplate(world, item.itemId);
    const metadata = this.#context.itemInfo?.(item.itemId);
    // The stock row needs both its display name and icon. Do not hand Lua a partially resolved
    // item when the world template has supplied a name but the item metadata/icon cache has not
    // arrived yet: that would make QuestInfo paint a permanent blank icon and stop prefetch.
    const name = metadata?.name ?? template?.name;
    const texture = metadata?.texture ?? this.#itemTexture(item.itemId);
    if (typeof name !== "string" || name.length === 0 || typeof texture !== "string" || texture.length === 0) {
      return undefined;
    }
    const quality = metadata?.quality ?? template?.quality;
    const usable = metadata?.isUsable ?? this.#questItemUsable(template);
    return [name, texture, item.count, quality, usable];
  }

  questLogRewardCount(index?: number): number {
    return this.#questReward(index)?.rewardItems?.length ?? 0;
  }

  questLogChoiceCount(index?: number): number {
    return this.#questReward(index)?.rewardChoiceItems?.length ?? 0;
  }

  questLogRewardInfo(itemIndex: number, questIndex?: number): FrameXmlQuestItemInfo | undefined {
    if (!Number.isInteger(itemIndex) || itemIndex < 1) return undefined;
    return this.#questItemInfo(this.#questReward(questIndex)?.rewardItems?.[itemIndex - 1]);
  }

  questLogChoiceInfo(itemIndex: number, questIndex?: number): FrameXmlQuestItemInfo | undefined {
    if (!Number.isInteger(itemIndex) || itemIndex < 1) return undefined;
    return this.#questItemInfo(this.#questReward(questIndex)?.rewardChoiceItems?.[itemIndex - 1]);
  }

  questLogRewardSpell(index?: number): FrameXmlQuestRewardSpell | undefined {
    const template = this.#questReward(index);
    const spellId = template?.rewardDisplaySpell ?? 0;
    if (!Number.isInteger(spellId) || spellId <= 0) return undefined;
    const metadata = this.#context.spell(spellId);
    if (!metadata) return undefined;
    const world = this.#context.world();
    const isSpellLearned = Array.isArray(world?.knownSpells)
      ? world.knownSpells.some((known) => known.id === spellId)
      : undefined;
    // SpellMetadata does not carry a profession/trade-skill classification. Keep that field nil
    // instead of presenting a false classification to QuestInfo_ShowRewards.
    return [metadata.iconPath, metadata.name, undefined, isSpellLearned];
  }

  questLogRewardMoney(index?: number): number {
    const value = this.#questReward(index)?.rewardMoney;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardHonor(index?: number): number {
    const value = this.#questReward(index)?.rewardHonor;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardArenaPoints(): number {
    // Arena points are not part of QuestTemplate's query payload in this client.
    return 0;
  }

  questLogRewardTalents(index?: number): number {
    const value = this.#questReward(index)?.rewardTalents;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardXP(): number {
    // The server query has no XP reward field; the client does not have a level-formula cache here.
    return 0;
  }

  questLogRewardTitle(): string | undefined {
    // QuestTemplate retains only rewardTitleId. Title strings are not available in this client.
    return undefined;
  }

  questLogRequiredMoney(index?: number): number {
    const template = this.#questReward(index);
    const value = template?.requiredMoney ?? (typeof template?.rewardMoney === "number"
      ? splitQuestMoney(template.rewardMoney).required : 0);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogTimeLeft(index?: number): number | undefined {
    const entry = this.#questAt(index);
    if (!entry || !Number.isFinite(entry.timer) || entry.timer <= 0) return undefined;
    const world = this.#context.world();
    const now = world?.currentServerTime(this.#context.monotonic());
    return now === undefined ? undefined : Math.max(0, entry.timer - now);
  }

  questLogCompletionText(index?: number): string | undefined {
    const template = this.#questTemplate(this.#questAt(index));
    return template?.completedText;
  }

  questLogGroupNum(index?: number): number {
    return this.#questTemplate(this.#questAt(index))?.suggestedPlayers ?? 0;
  }

  questLogCurrentFailed(): boolean {
    return ((this.#questAt(undefined)?.state ?? 0) & QUEST_STATE_FAIL) !== 0;
  }

  questMapUpdateAllQuests(): number {
    return this.#currentMapQuestIds().length;
  }

  questPoiQuestIdByVisibleIndex(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    return this.#currentMapQuestIds()[index - 1];
  }

  questNumWatches(): number {
    return this.#questRows().filter((entry) => !this.#unwatchedQuestIds.has(entry.questId)).length;
  }

  questIndexForWatch(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    let watched = 0;
    const rows = this.#questRows();
    for (let row = 0; row < rows.length; row++) {
      const entry = rows[row];
      if (!entry || this.#unwatchedQuestIds.has(entry.questId)) continue;
      if (++watched === index) return row + 1;
    }
    return undefined;
  }

  questIsWatched(index: number): boolean {
    const entry = this.#questAt(index);
    return entry !== undefined && !this.#unwatchedQuestIds.has(entry.questId);
  }

  addQuestWatch(index: number, _time?: number): void {
    const entry = this.#questAt(index);
    if (!entry || !this.#unwatchedQuestIds.delete(entry.questId)) return;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.questWatchUpdate, index);
  }

  removeQuestWatch(index: number): void {
    const entry = this.#questAt(index);
    if (!entry || this.#unwatchedQuestIds.has(entry.questId)) return;
    this.#unwatchedQuestIds.add(entry.questId);
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.questWatchUpdate, index);
  }

  // ---- reputation ------------------------------------------------------

  #allFactionRows(): readonly FrameXmlFactionRow[] {
    const world = this.#context.world();
    const rows = world && this.#context.reputation?.(world);
    return Array.isArray(rows) ? rows.filter(isResolvedFactionRow) : [];
  }

  #visibleFactionRows(): readonly FrameXmlFactionRow[] {
    const visible: FrameXmlFactionRow[] = [];
    let collapsed = false;
    for (const row of this.#allFactionRows()) {
      if (row.isHeader) {
        collapsed = this.#collapsedFactionIds.has(row.listId);
        visible.push(row);
      } else if (!row.isChild || !collapsed) {
        visible.push(row);
      }
    }
    return visible;
  }

  #factionAt(index: number): FrameXmlFactionRow | undefined {
    return Number.isInteger(index) && index >= 1
      ? this.#visibleFactionRows()[index - 1]
      : undefined;
  }

  #factionIndex(listId: number | undefined): number {
    if (listId === undefined) return 0;
    const index = this.#visibleFactionRows().findIndex((row) => row.listId === listId);
    return index < 0 ? 0 : index + 1;
  }

  #factionAtWar(row: FrameXmlFactionRow): boolean {
    return this.#atWarFactionOverrides.get(row.listId) ?? row.atWarWith === true;
  }

  #factionInactive(row: FrameXmlFactionRow): boolean {
    return this.#inactiveFactionOverrides.get(row.listId) ?? row.isInactive === true;
  }

  #reputationShapeSignature(): string {
    return JSON.stringify([
      this.#visibleFactionRows().map((row) => [
        row.listId, row.name, row.description, row.standingId,
        row.barMin, row.barMax, row.barValue, row.canToggleAtWar,
        row.isHeader, row.isChild, row.hasRep,
        this.#factionAtWar(row), this.#factionInactive(row),
      ]),
      [...this.#collapsedFactionIds].sort((left, right) => left - right),
      this.#selectedFactionId === undefined ? "none" : this.#selectedFactionId,
      this.#watchedFactionId === undefined ? "none" : this.#watchedFactionId,
    ]);
  }

  #publishReputationChanged(force = false): void {
    const next = this.#reputationShapeSignature();
    if (!force && next === this.#reputationSignature) return;
    this.#reputationSignature = next;
    if (this.#allFactionRows().length > 0) {
      this.#pump?.fire(FRAMEXML_SEAM_EVENTS.reputationChanged);
    }
  }

  factionCount(): number {
    return this.#visibleFactionRows().length;
  }

  #factionInfoRow(row: FrameXmlFactionRow): FrameXmlFactionInfo {
    return [
      row.name,
      row.description,
      row.standingId,
      row.barMin,
      row.barMax,
      row.barValue,
      this.#factionAtWar(row),
      row.canToggleAtWar,
      row.isHeader,
      row.isHeader && this.#collapsedFactionIds.has(row.listId),
      row.hasRep,
      this.#watchedFactionId === row.listId,
      row.isChild,
    ];
  }

  factionInfo(index: number): FrameXmlFactionInfo | undefined {
    const row = this.#factionAt(index);
    return row ? this.#factionInfoRow(row) : undefined;
  }

  factionInfoById(factionId: unknown): FrameXmlFactionInfo | undefined {
    const rows = this.#allFactionRows();
    return frameXmlFactionInfoById(
      factionId, this.#context.reputationCatalog?.(), rows,
      (index) => {
        const row = rows[index - 1];
        return row ? this.#factionInfoRow(row) : undefined;
      },
    );
  }

  selectedFaction(): number {
    return this.#factionIndex(this.#selectedFactionId);
  }

  setSelectedFaction(index: number): void {
    const next = index === 0 ? undefined : this.#factionAt(index)?.listId;
    if (next === this.#selectedFactionId) return;
    this.#selectedFactionId = next;
    this.#publishReputationChanged();
  }

  watchedFactionInfo(): FrameXmlWatchedFactionInfo | undefined {
    const row = this.#allFactionRows().find((candidate) => candidate.listId === this.#watchedFactionId);
    return row ? [row.name, row.standingId, row.barMin, row.barMax, row.barValue] : undefined;
  }

  setWatchedFactionIndex(index: number): void {
    const next = index === 0 ? undefined : this.#factionAt(index)?.listId;
    if (next === this.#watchedFactionId) return;
    this.#watchedFactionId = next;
    this.#publishReputationChanged();
  }

  expandFactionHeader(index: number): void {
    const row = this.#factionAt(index);
    if (!row?.isHeader || !this.#collapsedFactionIds.delete(row.listId)) return;
    this.#publishReputationChanged();
  }

  collapseFactionHeader(index: number): void {
    const row = this.#factionAt(index);
    if (!row?.isHeader || this.#collapsedFactionIds.has(row.listId)) return;
    this.#collapsedFactionIds.add(row.listId);
    this.#publishReputationChanged();
  }

  isFactionInactive(index: number): boolean {
    const row = this.#factionAt(index);
    return row !== undefined && this.#factionInactive(row);
  }

  setFactionInactive(index: number): void {
    const row = this.#factionAt(index);
    if (!row || this.#factionInactive(row)) return;
    this.#inactiveFactionOverrides.set(row.listId, true);
    this.#publishReputationChanged();
  }

  setFactionActive(index: number): void {
    const row = this.#factionAt(index);
    if (!row || !this.#factionInactive(row)) return;
    this.#inactiveFactionOverrides.set(row.listId, false);
    this.#publishReputationChanged();
  }

  factionToggleAtWar(index: number): void {
    const row = this.#factionAt(index);
    if (!row || row.isHeader || !row.canToggleAtWar) return;
    this.#atWarFactionOverrides.set(row.listId, !this.#factionAtWar(row));
    this.#publishReputationChanged();
  }

  accountExpansionLevel(): number {
    return 2;
  }

  isXpUserDisabled(): boolean {
    return false;
  }

  #rawField(object: WorldObjectState, name: string, index = 0): number | undefined {
    const field = (UPDATE_FIELDS as unknown as Record<string, { offset: number; size?: number }>)[name];
    if (!field || !Number.isInteger(index) || index < 0 || index >= (field.size ?? 1)) return undefined;
    const value = object.fields.get(field.offset + index);
    return value === undefined ? undefined : value;
  }

  /** Adjacent generated fields such as UNIT_FIELD_STAT0..4 are declared one word each. */
  #fieldAtOffset(object: WorldObjectState, name: string, index: number): number | undefined {
    const field = (UPDATE_FIELDS as unknown as Record<string, { offset: number }>)[name];
    if (!field || !Number.isInteger(index) || index < 0) return undefined;
    const value = object.fields.get(field.offset + index);
    return value === undefined ? undefined : value;
  }

  #fieldNumber(object: WorldObjectState, name: Parameters<typeof readField>[1]): number | undefined {
    const value = readField(object, name);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  #signed(value: number | undefined): number {
    return value === undefined ? 0 : value | 0;
  }

  /** UpdateFields marks this array INT, but the 3.3.5 server stores its multiplier as a float. */
  #floatWord(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    const bytes = new ArrayBuffer(4);
    const view = new DataView(bytes);
    view.setUint32(0, value >>> 0, true);
    const decoded = view.getFloat32(0, true);
    return Number.isFinite(decoded) ? decoded : undefined;
  }

  #unitObject(unit: string): WorldObjectState | undefined {
    return this.#unit(unit);
  }

  unitStat(unit: string, index: number): FrameXmlUnitStat {
    const object = this.#unitObject(unit);
    // The C API is one-based even though the generated fields are STAT0..STAT4.
    const i = Number.isInteger(index) ? index - 1 : -1;
    if (!object || i < 0 || i >= 5) return [0, 0, 0, 0];
    const effective = this.#signed(this.#fieldAtOffset(object, "UNIT_FIELD_STAT0", i));
    const positive = this.#signed(this.#fieldAtOffset(object, "UNIT_FIELD_POSSTAT0", i));
    const negative = this.#signed(this.#fieldAtOffset(object, "UNIT_FIELD_NEGSTAT0", i));
    // StatSystem.cpp publishes the total; stock PaperDoll subtracts buffs from the first
    // return for its tooltip. Adding the buffs again inflates the visible stat.
    return [effective, effective, positive, negative];
  }

  unitResistance(unit: string, index: number): FrameXmlUnitStat {
    const object = this.#unitObject(unit);
    const i = Number.isInteger(index) ? index : -1;
    if (!object || i < 0 || i >= 7) return [0, 0, 0, 0];
    const effective = this.#signed(this.#rawField(object, "UNIT_FIELD_RESISTANCES", i));
    const positive = this.#signed(this.#rawField(object, "UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE", i));
    const negative = this.#signed(this.#rawField(object, "UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE", i));
    return [effective - positive - negative, effective, positive, negative];
  }

  unitArmor(unit: string): FrameXmlUnitArmor {
    const [base, effective, positive, negative] = this.unitResistance(unit, 0);
    return [base, effective, base, positive, negative];
  }

  #attackPowerTuple(object: WorldObjectState | undefined, baseName: string, modsName: string): FrameXmlUnitAttackPower {
    if (!object) return [0, 0, 0];
    const fieldName = baseName as Parameters<typeof readField>[1];
    const baseValue = this.#fieldNumber(object, fieldName);
    const rawModsWord = this.#rawField(object, modsName, 0) ?? 0;
    // Both modifier fields are one TWO_SHORT update-field word. Keep the signed halves explicit;
    // the generated metadata intentionally exposes the word as one slot.
    const rawMods: [number, number] = [rawModsWord & 0xffff, rawModsWord >>> 16];
    const positive = (rawMods[0] << 16) >> 16;
    const negative = (rawMods[1] << 16) >> 16;
    return [baseValue === undefined ? 0 : baseValue | 0, positive, negative];
  }

  unitAttackPower(unit: string): FrameXmlUnitAttackPower {
    return this.#attackPowerTuple(this.#unitObject(unit), "UNIT_FIELD_ATTACK_POWER", "UNIT_FIELD_ATTACK_POWER_MODS");
  }

  unitRangedAttackPower(unit: string): FrameXmlUnitAttackPower {
    return this.#attackPowerTuple(this.#unitObject(unit), "UNIT_FIELD_RANGED_ATTACK_POWER", "UNIT_FIELD_RANGED_ATTACK_POWER_MODS");
  }

  attackPowerForStat(_statIndex: number, _statValue: number): number {
    // The client sends total AP and stat fields, but not the class-specific contribution formula.
    // A neutral zero keeps PaperDollFrame's explanatory tooltip numeric without inventing one.
    return 0;
  }

  critChanceFromAgility(): number {
    return 0;
  }

  spellCritChanceFromIntellect(unit: string): number | undefined {
    const object = this.#unitObject(unit);
    if (!object || unit !== "player") return undefined;
    // Update masks omit zero-valued fields; STAT3 is the effective value, not POSSTAT3 added again.
    const intellect = this.#signed(this.#fieldAtOffset(object, "UNIT_FIELD_STAT0", 3));
    return spellCritFromIntellect(this.#context.characterStats?.(), unitField.classId(object) ?? 0,
      unitField.level(object) ?? 0, intellect);
  }

  unitMaxHealthModifier(): number {
    return 1;
  }

  unitHealthRegenRateFromSpirit(): number {
    return 0;
  }

  unitManaRegenRateFromSpirit(): number {
    return 0;
  }

  combatRating(index: number): number {
    const object = this.#self();
    // FrameXML's CR_* constants are one-based; the core's array is zero-based.
    return object ? this.#rawField(object, "PLAYER_FIELD_COMBAT_RATING_1", index - 1) ?? 0 : 0;
  }

  combatRatingBonus(index: number): number {
    const object = this.#self();
    return object ? characterCombatRatingBonus(this.#context.characterStats?.(), unitField.classId(object) ?? 0,
      unitField.level(object) ?? 0, index, this.combatRating(index)) ?? 0 : 0;
  }

  armorPenetration(): number {
    return 0;
  }

  critChance(): number {
    return this.#playerStatNumber("PLAYER_CRIT_PERCENTAGE");
  }

  expertise(): readonly [number, number] {
    return [this.#playerStatNumber("PLAYER_EXPERTISE"), this.#playerStatNumber("PLAYER_OFFHAND_EXPERTISE")];
  }

  expertisePercent(): readonly [number, number] {
    // Player.cpp::GetExpertiseDodgeOrParryReduction uses one quarter percent per point.
    const [main, off] = this.expertise();
    return [main / 4, off / 4];
  }

  #playerStatNumber(name: Parameters<typeof readField>[1]): number {
    const object = this.#self();
    return object ? this.#fieldNumber(object, name) ?? 0 : 0;
  }

  rangedCritChance(): number { return this.#playerStatNumber("PLAYER_RANGED_CRIT_PERCENTAGE"); }
  dodgeChance(): number { return this.#playerStatNumber("PLAYER_DODGE_PERCENTAGE"); }
  parryChance(): number { return this.#playerStatNumber("PLAYER_PARRY_PERCENTAGE"); }
  blockChance(): number { return this.#playerStatNumber("PLAYER_BLOCK_PERCENTAGE"); }
  shieldBlock(): number { return this.#playerStatNumber("PLAYER_SHIELD_BLOCK"); }

  spellCritChance(school: number): number {
    const object = this.#self();
    return object ? this.#floatWord(this.#rawField(object, "PLAYER_SPELL_CRIT_PERCENTAGE1", school - 1)) ?? 0 : 0;
  }

  spellBonusDamage(school: number): number {
    const object = this.#self();
    return object ? this.#signed(this.#rawField(object, "PLAYER_FIELD_MOD_DAMAGE_DONE_POS", school - 1))
      + this.#signed(this.#rawField(object, "PLAYER_FIELD_MOD_DAMAGE_DONE_NEG", school - 1)) : 0;
  }

  spellBonusHealing(): number { return this.#playerStatNumber("PLAYER_FIELD_MOD_HEALING_DONE_POS"); }

  spellPenetration(): number {
    // Player::ApplySpellPenetrationBonus stores the negative resistance modifier.
    return -this.#signed(this.#playerStatNumber("PLAYER_FIELD_MOD_TARGET_RESISTANCE"));
  }

  manaRegen(): readonly [number, number] {
    // StatSystem.cpp writes mana per second into the first (POWER_MANA) float of each array.
    return [this.#playerStatNumber("UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER"),
      this.#playerStatNumber("UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER")];
  }

  unitDefense(unit: string): readonly [number, number] {
    const object = this.#unitObject(unit);
    // SKILL_DEFENSE = 95 in the compatible core's SharedDefines.h.
    const skill = object ? readSkills(object).find((entry) => entry.skillId === 95) : undefined;
    return skill ? [skill.value, skill.temporaryBonus + skill.permanentBonus
      + (object === this.#self() ? Math.trunc(this.combatRatingBonus(2)) : 0)] : [0, 0];
  }

  dodgeBlockParryChanceFromDefense(): number {
    const object = this.#self();
    if (!object) return 0;
    const [base, bonus] = this.unitDefense("player");
    // Player::UpdateBlockPercentage uses 0.04% per defense point above the level's cap.
    return (base + bonus - (unitField.level(object) ?? 0) * 5) * 0.04;
  }

  unitAttackSpeed(unit: string): readonly [number, number | undefined] {
    const object = this.#unitObject(unit);
    if (!object) return [1, undefined];
    // UpdateFields stores attack times in milliseconds; UnitAttackSpeed exposes seconds. Keep an
    // absent off-hand speed nil: Lua treats numeric zero as truthy and PaperDoll divides by it.
    const mainMs = this.#fieldNumber(object, "UNIT_FIELD_BASEATTACKTIME");
    const offMs = this.#fieldNumber(object, "UNIT_FIELD_BASEATTACKTIME") === undefined
      ? undefined : this.#rawField(object, "UNIT_FIELD_BASEATTACKTIME", 1);
    const main = mainMs !== undefined && mainMs > 0 ? mainMs / 1000 : 1;
    const off = offMs !== undefined && offMs > 0 ? offMs / 1000 : undefined;
    return [main, off];
  }

  #damageModifiers(object: WorldObjectState | undefined): readonly [number, number, number] {
    if (!object) return [0, 0, 1];
    const positive = this.#signed(this.#rawField(object, "PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 0));
    const negative = this.#signed(this.#rawField(object, "PLAYER_FIELD_MOD_DAMAGE_DONE_NEG", 0));
    const rawPercent = this.#rawField(object, "PLAYER_FIELD_MOD_DAMAGE_DONE_PCT", 0);
    // The generated metadata says INT, but the 3.3.5 server stores this particular array with
    // SetFloatValue and serializes the float word unchanged. Missing/invalid state is neutral.
    const percent = rawPercent === undefined ? 1 : this.#floatWord(rawPercent) ?? 1;
    return [positive, negative, percent > 0 ? percent : 1];
  }

  unitDamage(unit: string): FrameXmlUnitDamage {
    const object = this.#unitObject(unit);
    const modifiers = this.#damageModifiers(object);
    return [
      object ? this.#fieldNumber(object, "UNIT_FIELD_MINDAMAGE") ?? 0 : 0,
      object ? this.#fieldNumber(object, "UNIT_FIELD_MAXDAMAGE") ?? 0 : 0,
      object ? this.#fieldNumber(object, "UNIT_FIELD_MINOFFHANDDAMAGE") ?? 0 : 0,
      object ? this.#fieldNumber(object, "UNIT_FIELD_MAXOFFHANDDAMAGE") ?? 0 : 0,
      ...modifiers,
    ];
  }

  unitRangedDamage(unit: string): FrameXmlUnitRangedDamage {
    const object = this.#unitObject(unit);
    const modifiers = this.#damageModifiers(object);
    const speed = object ? this.#rawField(object, "UNIT_FIELD_RANGEDATTACKTIME") : undefined;
    return [
      speed !== undefined && speed > 0 ? speed / 1000 : 1,
      object ? this.#fieldNumber(object, "UNIT_FIELD_MINRANGEDDAMAGE") ?? 0 : 0,
      object ? this.#fieldNumber(object, "UNIT_FIELD_MAXRANGEDDAMAGE") ?? 0 : 0,
      modifiers[0], modifiers[1], modifiers[2],
    ];
  }

  #paperDollSignature(kind: "inventory" | "stats" | "resistance" | "attackPower" | "rangedAttackPower" | "attackSpeed" | "damage" | "rangedDamage" | "damageModifier"): string | undefined {
    const object = this.#self();
    if (!object) return undefined;
    if (kind === "inventory") {
      const world = this.#context.world();
      const inventory = world ? playerInventory(world.state) : undefined;
      if (!inventory) return undefined;
      // The AmmoSlot as slot 0's readers draw it (`#ammoEntry`): a new PLAYER_AMMO_ID, an arrow spent,
      // sold or banked, and the entry's icon arriving each repaint it through this row's edge.
      const ammo = this.#ammoEntry("player");
      const ammoSignature = ammo === undefined ? ""
        : `${ammo}:${this.#carriedCount(inventory, ammo, false)}:${this.#itemTexture(ammo) ?? ""}`;
      return [...inventory.equipment, ...inventory.bags.map((bag) => ({
        index: bag.bagSlot,
        item: bag.bag,
        guid: bag.guid,
        bag: INVENTORY_SLOT_BAG_0,
        slot: bag.bagSlot,
      }))].map((slot) => [
        slot.guid, entryOf(slot.item), stackCount(slot),
        slot.item ? this.#itemTexture(entryOf(slot.item)) ?? "" : "",
        slot.item ? readField(slot.item, "ITEM_FIELD_DURABILITY") ?? "" : "",
        slot.item ? readField(slot.item, "ITEM_FIELD_MAXDURABILITY") ?? "" : "",
      ].join(":")).join("|") + `|ammo:${ammoSignature}`;
    }
    if (kind === "stats") {
      // Crit, rating, spellpower, avoidance and regeneration can change without a primary stat.
      // UNIT_STATS is handled by the stock PaperDoll for every displayed category.
      return [
        ...Array.from({ length: 5 }, (_, index) => this.unitStat("player", index + 1).join(":")),
        ...Array.from({ length: 25 }, (_, index) => this.combatRating(index + 1)),
        this.critChance(), this.rangedCritChance(), ...this.expertise(),
        ...Array.from({ length: 7 }, (_, index) => this.spellCritChance(index + 1)),
        ...Array.from({ length: 7 }, (_, index) => this.spellBonusDamage(index + 1)),
        this.spellBonusHealing(), this.spellPenetration(), ...this.manaRegen(),
        this.dodgeChance(), this.parryChance(), this.blockChance(), this.shieldBlock(),
        ...this.unitDefense("player"), unitField.level(object),
      ].join("|");
    }
    if (kind === "resistance") {
      return Array.from({ length: 7 }, (_, index) => this.unitResistance("player", index).join(":")).join("|");
    }
    if (kind === "attackPower") {
      return this.unitAttackPower("player").join(":");
    }
    if (kind === "rangedAttackPower") {
      return this.unitRangedAttackPower("player").join(":");
    }
    if (kind === "attackSpeed") {
      return this.unitAttackSpeed("player").join(":");
    }
    if (kind === "damage") {
      return this.unitDamage("player").join(":");
    }
    if (kind === "rangedDamage") {
      return this.unitRangedDamage("player").join(":");
    }
    return this.#damageModifiers(object).join(":");
  }

  #reconcilePaperDoll(force = false): void {
    const pump = this.#pump;
    if (!pump) return;
    // UNIT_RESISTANCES ahead of UNIT_STATS: of the stats edges it is the one whose PaperDollFrame
    // handler does the most (see `statsDelivered` below).
    const rows: readonly ["inventory" | "stats" | "resistance" | "attackPower" | "rangedAttackPower" | "attackSpeed" | "damage" | "rangedDamage" | "damageModifier", string, string][] = [
      ["inventory", "#inventorySignature", FRAMEXML_SEAM_EVENTS.inventoryChanged],
      ["resistance", "#resistanceSignature", FRAMEXML_SEAM_EVENTS.resistances],
      ["stats", "#statsSignature", FRAMEXML_SEAM_EVENTS.stats],
      ["attackPower", "#attackPowerSignature", FRAMEXML_SEAM_EVENTS.attackPower],
      ["rangedAttackPower", "#rangedAttackPowerSignature", FRAMEXML_SEAM_EVENTS.rangedAttackPower],
      ["attackSpeed", "#attackSpeedSignature", FRAMEXML_SEAM_EVENTS.attackSpeed],
      ["damage", "#damageSignature", FRAMEXML_SEAM_EVENTS.damage],
      ["rangedDamage", "#rangedDamageSignature", FRAMEXML_SEAM_EVENTS.rangedDamage],
      ["damageModifier", "#damageModifierSignature", FRAMEXML_SEAM_EVENTS.damageDoneMods],
    ];
    // An equip moves five or six of these rows in one poll, and PaperDollFrame answered each with
    // PaperDollFrame_UpdateStats — every stat row read and rewritten again, 1.4-2.3 ms apiece in
    // fengari over the stock corpus (Node 22, CharacterFrame open). The first stats edge of the poll
    // reaches it; the rest go to every other listener (PetPaperDollFrame, add-ons) and not to it.
    let statsDelivered = false;
    for (const [kind, _field, event] of rows) {
      const next = this.#paperDollSignature(kind);
      if (next === undefined) continue;
      const previous = kind === "inventory" ? this.#inventorySignature
            : kind === "stats" ? this.#statsSignature
              : kind === "resistance" ? this.#resistanceSignature
                : kind === "attackPower" ? this.#attackPowerSignature
                  : kind === "rangedAttackPower" ? this.#rangedAttackPowerSignature
                    : kind === "attackSpeed" ? this.#attackSpeedSignature
                      : kind === "damage" ? this.#damageSignature
                        : kind === "rangedDamage" ? this.#rangedDamageSignature
                          : this.#damageModifierSignature;
      if (!force && next === previous) continue;
      if (kind === "inventory") this.#inventorySignature = next;
      else if (kind === "stats") this.#statsSignature = next;
      else if (kind === "resistance") this.#resistanceSignature = next;
      else if (kind === "attackPower") this.#attackPowerSignature = next;
      else if (kind === "rangedAttackPower") this.#rangedAttackPowerSignature = next;
      else if (kind === "attackSpeed") this.#attackSpeedSignature = next;
      else if (kind === "damage") this.#damageSignature = next;
      else if (kind === "rangedDamage") this.#rangedDamageSignature = next;
      else this.#damageModifierSignature = next;
      if (!PAPER_DOLL_STATS_EVENTS.has(event)) {
        pump.fire(event, "player");
      } else if (statsDelivered) {
        withEventOwnersExcluded(event, PAPER_DOLL_FRAME, () => pump.fire(event, "player"));
      } else {
        statsDelivered = true;
        pump.fire(event, "player");
      }
    }
  }

  /**
   * `#reconcilePaperDoll`'s inventory row alone, for an edge that should not wait for the poll
   * (PLAYER_AMMO_ID); it leaves the signature the poll compares, so one change fires once.
   */
  #reconcilePaperDollInventory(): void {
    const pump = this.#pump;
    if (!pump) return;
    const next = this.#paperDollSignature("inventory");
    if (next === undefined || next === this.#inventorySignature) return;
    this.#inventorySignature = next;
    pump.fire(FRAMEXML_SEAM_EVENTS.inventoryChanged, "player");
  }

  // ---- the world, read the way `ui/ActionBar.ts` reads it ----------------

  #self(): WorldObjectState | undefined {
    const world = this.#context.world();
    const guid = world?.state.selfGuid;
    const objects = world?.state.objects;
    return world && guid !== undefined && typeof objects?.get === "function"
      ? objects.get(guid) : undefined;
  }

  /** Resolve only the four classic party slots; raid roster aliases are intentionally absent. */
  #partySlot(unit: string): number | undefined {
    const match = /^party([1-4])$/.exec(unit);
    if (!match) return undefined;
    const world = this.#context.world();
    const group = world?.group;
    const index = Number(match[1]) - 1;
    return group && (group.groupType & GROUPTYPE_RAID) === 0 && group.members[index] !== undefined
      ? index + 1
      : undefined;
  }

  #partyMember(unit: string): GroupMember | undefined {
    const slot = this.#partySlot(unit);
    if (slot === undefined) return undefined;
    return this.#context.world()?.group?.members[slot - 1];
  }

  #partyStats(unit: string): PartyMemberStats | undefined {
    const member = this.#partyMember(unit);
    return member === undefined ? undefined : this.#context.world()?.partyStats.get(member.guid);
  }

  #partyUnitForGuid(guid: bigint): string | undefined {
    const group = this.#context.world()?.group;
    if (!group || (group.groupType & GROUPTYPE_RAID) !== 0) return undefined;
    const index = group.members.slice(0, 4).findIndex((member) => member.guid === guid);
    return index < 0 ? undefined : `party${index + 1}`;
  }

  #partyPowerType(guid: bigint): number {
    const world = this.#context.world();
    const object = world?.state.objects.get(guid);
    return (object ? unitField.powerType(object) : undefined)
      ?? world?.partyStats.get(guid)?.powerType
      ?? 0;
  }

  #partyObject(unit: string): WorldObjectState | undefined {
    const member = this.#partyMember(unit);
    const world = this.#context.world();
    return world && member ? world.state.objects.get(member.guid) : undefined;
  }

  /** A primitive group shape keeps membership/order/status changes event-driven and allocation-light. */
  #partyShapeSignature(): string {
    const group = this.#context.world()?.group;
    if (!group || (group.groupType & GROUPTYPE_RAID) !== 0) return "";
    return [
      group.groupType,
      group.leaderGuid,
      ...group.members.slice(0, 4).map((member) => [
        member.guid, member.name, member.online, member.status, member.flags, member.roles,
      ].join("\u0001")),
    ].join("\u0002");
  }

  /** The selected object, without ever substituting the controlled player for a missing target. */
  #target(): WorldObjectState | undefined {
    const world = this.#context.world();
    const guid = world?.targetGuid;
    return world && guid !== undefined ? world.state.objects.get(guid) : undefined;
  }

  /** The selected target's target mirror, resolved only while both world objects are present. */
  #targetTarget(): WorldObjectState | undefined {
    const target = this.#target();
    const world = this.#context.world();
    const guid = target === undefined ? undefined : unitField.target(target);
    return world && guid !== undefined && guid !== 0n ? world.state.objects.get(guid) : undefined;
  }

  /** The interface-owned focus, resolved only while its object remains in world state. */
  #focus(): WorldObjectState | undefined {
    const world = this.#context.world();
    const guid = this.#context.focusGuid?.();
    return world && guid !== undefined && guid !== 0n ? world.state.objects.get(guid) : undefined;
  }

  /** The focus's target mirror, as `#targetTarget` reads the target's: both objects must be present. */
  #focusTarget(): WorldObjectState | undefined {
    const focus = this.#focus();
    const world = this.#context.world();
    const guid = focus === undefined ? undefined : unitField.target(focus);
    return world && guid !== undefined && guid !== 0n ? world.state.objects.get(guid) : undefined;
  }

  /** The pet GUID is authoritative only when both the pet bar and an in-range world object agree. */
  #pet(): WorldObjectState | undefined {
    const world = this.#context.world();
    const guid = world?.petSpells?.guid;
    return world && guid !== undefined && guid !== 0n ? world.state.objects.get(guid) : undefined;
  }

  #unit(unit: string): WorldObjectState | undefined {
    if (unit === "player") return this.#self();
    if (unit === "target") return this.#target();
    if (unit === "focus") return this.#focus();
    if (unit === "targettarget") return this.#targetTarget();
    // FocusFrame's target-of-target row (TargetFrame.xml:678 creates it for "focus-target").
    if (unit === "focus-target") return this.#focusTarget();
    if (unit === "pet") return this.#pet();
    if (unit === "mouseover") return this.#mouseover();
    if (unit.startsWith("arena")) return this.arena.object(unit);
    return this.#partyObject(unit);
  }

  /**
   * The settled unit under the world cursor (`HoverTarget`), only while the same object is still
   * in this seam's world. Every unit query — UnitExists, UnitName, UnitLevel, UnitHealth,
   * UnitIsUnit, UnitGUID… — resolves `"mouseover"` through here.
   */
  #mouseover(): WorldObjectState | undefined {
    const world = this.#context.world();
    const guid = settledHoveredUnitGuid(world);
    return world && guid !== undefined ? world.state.objects.get(guid) : undefined;
  }

  /**
   * GUID-only tokens: identities stock and add-on code key maps by even when the object is out of
   * range, and which the seam deliberately does not promote to full units (no event stream keeps
   * their frames fresh). `raidN` follows `raidMemberCount`: the listed members in wire order, then
   * the player, whom the server's group list never carries.
   */
  #guidOnlyUnit(unit: string): bigint | undefined {
    const world = this.#context.world();
    const group = world?.group;
    const partyPet = /^partypet([1-4])$/.exec(unit);
    if (partyPet) {
      const member = this.#partyMember(`party${partyPet[1]}`);
      const petGuid = member === undefined ? undefined : world?.partyStats.get(member.guid)?.petGuid;
      return petGuid !== undefined && petGuid !== 0n ? petGuid : undefined;
    }
    const raid = /^raid([1-9]\d?)$/.exec(unit);
    if (raid) {
      if (!group || (group.groupType & GROUPTYPE_RAID) === 0) return undefined;
      const index = Number(raid[1]);
      return index === this.#raidSelfIndex(world) ? world?.state.selfGuid : group.members[index - 1]?.guid;
    }
    // An arena opponent or pet out of sight keeps its GUID for the match (FrameXmlArena.ts).
    if (unit.startsWith("arena")) return this.arena.guid(unit);
    if (unit === "vehicle") {
      // A vehicle's spell bar replaces the pet bar and carries the vehicle's own GUID
      // (`VehicleSpellInitialize`); an ordinary pet bar is not a vehicle.
      const petSpells = world?.petSpells;
      return petSpells && petSpells.guid !== 0n && isVehicleActionBar(petSpells.bar) ? petSpells.guid : undefined;
    }
    return undefined;
  }

  #unitGuid(unit: string): bigint | undefined {
    const object = this.#unit(unit);
    if (object) return object.guid;
    return this.#partyMember(unit)?.guid ?? this.#guidOnlyUnit(unit);
  }

  /** `UnitGUID` in the text form chat's `arg12` already uses, so the two compare equal in Lua. */
  unitGuid(unit: string): string | undefined {
    const guid = this.#unitGuid(unit);
    return guid === undefined || guid === 0n ? undefined : frameXmlGuid(guid);
  }

  /** `UnitReaction`'s stock index from the FactionTemplate relation this seam already resolves. */
  unitReaction(left: string, right: string): number | undefined {
    const reaction = this.#reaction(left, right);
    return reaction === REACTION_HOSTILE ? 2
      : reaction === REACTION_NEUTRAL ? 4
        : reaction === REACTION_FRIENDLY ? 5 : undefined;
  }

  /** Announce a settled hover change; leaving every unit is not an UPDATE_MOUSEOVER_UNIT edge. */
  #reconcileMouseover(world: WorldClient, pump: FrameXmlSeamPump): void {
    const guid = settledHoveredUnitGuid(world);
    if (guid === this.#mouseoverGuid) return;
    this.#mouseoverGuid = guid;
    if (guid !== undefined) pump.fire(FRAMEXML_SEAM_EVENTS.mouseover);
  }

  /** Translate one world caster identity to a live FrameXML unit without aliasing old targets. */
  #castUnit(guid: bigint): "player" | "target" | "focus" | "targettarget" | "pet" | undefined {
    if (guid === this.#selfGuid()) return "player";
    if (guid === this.#targetGuid && this.#target()?.guid === guid) return "target";
    if (guid === this.#focusGuid && this.#focus()?.guid === guid) return "focus";
    if (guid === this.#targetTargetGuid && this.#targetTarget()?.guid === guid) return "targettarget";
    if (guid === this.#petGuid && this.#pet()?.guid === guid) return "pet";
    return undefined;
  }

  /**
   * UnitName is deliberately nil until the client's own name/query cache has an answer. The
   * `displayName` helper's GUID fallback is useful for diagnostics, but it is not the stock
   * UnitName result and would make an unknown target look identified.
   */
  #targetNameFor(target: WorldObjectState | undefined): string | undefined {
    const world = this.#context.world();
    if (!world || !target) return undefined;
    const playerName = world.names.get(target.guid)
      ?? (target.guid === world.state.selfGuid ? world.selfName : undefined);
    if (playerName) return playerName;
    if (target.typeId !== TYPEID_UNIT) return undefined;
    const entry = readField(target, "OBJECT_FIELD_ENTRY");
    const creature = entry === undefined ? undefined : world.creatureTemplates.get(entry);
    return creature?.found && creature.name ? creature.name : undefined;
  }

  /** Publish one selection edge for a real target identity transition. */
  #reconcileTarget(): void {
    const nextGuid = this.#target()?.guid;
    if (nextGuid === this.#targetGuid) return;
    const previousGuid = this.#targetGuid;
    const world = this.#context.world();
    const selfGuid = this.#selfGuid();
    if (previousGuid !== undefined && previousGuid !== selfGuid) this.#castStates.delete(previousGuid);
    this.#targetGuid = nextGuid;
    if (nextGuid !== undefined) {
      const cast = world?.casts.get(nextGuid);
      if (cast) {
        this.#castStates.set(nextGuid, {
          spellId: cast.spellId,
          channel: cast.channel,
          castID: cast.castCount,
        });
      } else {
        this.#castStates.delete(nextGuid);
      }
    }
    this.#targetAuraSignature = this.#auraShapeSignature("target");
    this.#targetName = this.#targetNameFor(this.#target()) ?? "";
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.targetChanged);
  }

  /** Publish the target-of-target UNIT_TARGET edge for the currently selected target only. */
  #reconcileTargetTarget(): void {
    const nextGuid = this.#targetTarget()?.guid;
    if (nextGuid === this.#targetTargetGuid) return;
    const previousGuid = this.#targetTargetGuid;
    if (previousGuid !== undefined) this.#castStates.delete(previousGuid);
    this.#targetTargetGuid = nextGuid;
    const world = this.#context.world();
    if (nextGuid !== undefined) {
      const cast = world?.casts.get(nextGuid);
      if (cast) {
        this.#castStates.set(nextGuid, {
          spellId: cast.spellId,
          channel: cast.channel,
          castID: cast.castCount,
        });
      }
    }
    this.#targetTargetAuraSignature = this.#auraShapeSignature("targettarget");
    this.#targetTargetName = this.#targetNameFor(this.#targetTarget()) ?? "";
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.unitTarget, "target");
  }

  /** Publish one focus identity edge from the client-owned focus callback. */
  #reconcileFocus(): void {
    const nextGuid = this.#focus()?.guid;
    if (nextGuid === this.#focusGuid) return;
    const previousGuid = this.#focusGuid;
    if (previousGuid !== undefined) this.#castStates.delete(previousGuid);
    this.#focusGuid = nextGuid;
    const world = this.#context.world();
    if (nextGuid !== undefined) {
      const cast = world?.casts.get(nextGuid);
      if (cast) {
        this.#castStates.set(nextGuid, {
          spellId: cast.spellId,
          channel: cast.channel,
          castID: cast.castCount,
        });
      }
    }
    this.#focusAuraSignature = this.#auraShapeSignature("focus");
    this.#focusName = this.#targetNameFor(this.#focus()) ?? "";
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.focusChanged);
  }

  /**
   * A pet talent packet has no GUID. On a replacement pet, the core sends PET_SPELLS first and
   * TALENTS_INFO after it; wait for that new packet rather than showing the previous pet's ranks.
   */
  #notePetTalentOwner(world: WorldClient | undefined): void {
    const guid = world?.petSpells?.guid;
    if (!this.#petTalentOwnerSeen) {
      this.#petTalentOwnerSeen = true;
      this.#petTalentOwnerGuid = guid;
      return;
    }
    if (guid === this.#petTalentOwnerGuid) return;
    this.#petTalentOwnerGuid = guid;
    this.#awaitPetTalentPacket = guid !== undefined && guid !== 0n;
    this.#petTalentsAtOwnerChange = world?.petTalents;
  }

  #currentPetTalents(world: WorldClient | undefined): WorldClient["petTalents"] {
    this.#notePetTalentOwner(world);
    const packet = world?.petTalents;
    if (!this.#awaitPetTalentPacket) return packet;
    if (packet === this.#petTalentsAtOwnerChange) return undefined;
    this.#awaitPetTalentPacket = false;
    return packet;
  }

  /** Publish one UNIT_PET edge for a real pet bar/object identity transition. */
  #reconcilePet(force = false): void {
    this.#notePetTalentOwner(this.#context.world());
    const nextGuid = this.#pet()?.guid;
    if (nextGuid === this.#petGuid) {
      if (force) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.petChanged, "player");
      return;
    }
    const previousGuid = this.#petGuid;
    if (previousGuid !== undefined) this.#castStates.delete(previousGuid);
    this.#petGuid = nextGuid;
    const world = this.#context.world();
    if (nextGuid !== undefined) {
      const cast = world?.casts.get(nextGuid);
      if (cast) {
        this.#castStates.set(nextGuid, {
          spellId: cast.spellId,
          channel: cast.channel,
          castID: cast.castCount,
        });
      }
    }
    this.#petAuraSignature = this.#auraShapeSignature("pet");
    this.#petName = this.#targetNameFor(this.#pet()) ?? "";
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.petChanged, "player");
  }

  /** Publish one membership edge when the bounded roster shape changes. */
  #reconcileParty(): void {
    const nextSignature = this.#partyShapeSignature();
    if (nextSignature === this.#partySignature) return;
    this.#partySignature = nextSignature;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.partyMembers);
  }

  /** Translate one authoritative party-stats packet into the stock unit edge family. */
  #publishPartyStats(guid: bigint): void {
    const pump = this.#pump;
    const unit = this.#partyUnitForGuid(guid);
    const world = this.#context.world();
    const stats = world?.partyStats.get(guid);
    if (!pump || !unit || !stats) return;
    const flags = stats.flags;
    if ((flags & (GROUP_UPDATE_STATUS | GROUP_UPDATE_CUR_HP)) !== 0) {
      pump.fire(FRAMEXML_SEAM_EVENTS.health, unit);
    }
    if ((flags & GROUP_UPDATE_MAX_HP) !== 0) pump.fire(FRAMEXML_SEAM_EVENTS.maxHealth, unit);
    if ((flags & GROUP_UPDATE_POWER_TYPE) !== 0) pump.fire(FRAMEXML_SEAM_EVENTS.unitDisplayPower, unit);
    const powerType = this.#partyPowerType(guid);
    if ((flags & GROUP_UPDATE_CUR_POWER) !== 0) {
      pump.fire(FRAMEXML_POWER_EVENTS[powerType] ?? "UNIT_MANA", unit);
    }
    if ((flags & GROUP_UPDATE_MAX_POWER) !== 0) {
      pump.fire(FRAMEXML_POWER_MAX_EVENTS[powerType] ?? "UNIT_MAXMANA", unit);
    }
    if ((flags & GROUP_UPDATE_LEVEL) !== 0) pump.fire(FRAMEXML_SEAM_EVENTS.unitLevel, unit);
    if ((flags & GROUP_UPDATE_AURAS) !== 0) pump.fire(FRAMEXML_SEAM_EVENTS.aura, unit);
  }

  /**
   * The button in one 1-based action slot.
   *
   * The corpus counts actions from 1 and the wire counts slots from 0 — `actionSlot(page, column)`
   * is `page * 12 + column` with both zero-based — so the conversion is exactly one subtraction,
   * and getting it wrong would shift the whole bar by one button.
   */
  #button(slot: number): { slot: number; action: number; type: number } | undefined {
    const world = this.#context.world();
    if (!world || slot <= 0) return undefined;
    const wire = slot - 1;
    return world.actionButtons.find((button) => button.slot === wire);
  }

  #metadata(slot: number): SpellMetadata | undefined {
    const button = this.#button(slot);
    if (!button || button.type !== ACTION_BUTTON_SPELL) return undefined;
    return this.#context.spell(button.action);
  }

  hasAction(slot: number): boolean {
    return this.#button(slot) !== undefined;
  }

  actionTexture(slot: number): string | undefined {
    const button = this.#button(slot);
    if (button?.type === ACTION_BUTTON_ITEM) {
      return this.#context.itemInfo?.(button.action)?.texture || this.#itemTexture(button.action);
    }
    // A macro wears the icon its window chose (the question mark when none was).
    if (button?.type === ACTION_BUTTON_MACRO) return this.macros.slotTexture(button.action);
    const metadata = this.#metadata(slot);
    // An empty `iconPath` is a real answer on this dataset — `SpellIcon` has no row for the id —
    // and the corpus' own branch for a missing texture hides the icon and shows the empty
    // quickslot art, which is exactly right.
    return metadata?.iconPath || undefined;
  }

  /** Only a macro carries text on a bar, and its name is the text (the slot number until it has one). */
  actionText(slot: number): string | undefined {
    const button = this.#button(slot);
    return button?.type === ACTION_BUTTON_MACRO ? this.macros.slotName(button.action) ?? String(button.action) : undefined;
  }

  /** Resolve the stock 1-based slot to its server action identity without treating the slot as a spell id. */
  actionTooltip(slot: number): FrameXmlActionTooltip | undefined {
    const button = this.#button(slot);
    if (!button || !Number.isSafeInteger(button.action) || button.action <= 0) return undefined;
    if (button.type === ACTION_BUTTON_SPELL) {
      const metadata = this.#metadata(slot);
      if (!metadata?.name) return undefined;
      return { kind: "spell", id: button.action, name: metadata.name, rank: metadata.rank };
    }
    if (button.type === ACTION_BUTTON_ITEM) {
      const metadata = this.#context.itemInfo?.(button.action);
      const template = this.#itemTemplate(this.#context.world(), button.action);
      const name = metadata?.name ?? (template?.found ? template.name : "");
      if (!name) return undefined;
      return { kind: "item", id: button.action, name };
    }
    // Macro/equipment names are not present in the authoritative world snapshot; fail closed.
    return undefined;
  }

  actionCount(slot: number): number {
    const button = this.#button(slot);
    return button?.type === ACTION_BUTTON_ITEM
      ? this.#actionItems(button.action).reduce((count, item) => count + stackCount(item), 0) : 0;
  }

  /**
   * `GetActionCooldown`'s triple, translated from the two clocks this client keeps.
   *
   * The world stamps a cooldown in `performance.now()` milliseconds and the corpus reads
   * `GetTime()` seconds, so the start is expressed as «this many seconds ago» against the pump's
   * own clock rather than converted between epochs — which is the only translation that stays
   * right when the two clocks were started at different moments.
   */
  actionCooldown(slot: number): readonly [number, number, number] {
    const world = this.#context.world();
    const button = this.#button(slot);
    const pump = this.#pump;
    if (button?.type === ACTION_BUTTON_ITEM) return this.#itemCooldown(button.action);
    if (!world || !pump || !button || button.type !== ACTION_BUTTON_SPELL) return [0, 0, 0];
    // Held until its aura ends: stock answers `0, 0, 0` — `enable` 0, no sweep, not even the GCD's.
    if (world.isSpellOnHold?.(button.action)) return [0, 0, 0];
    const monotonic = this.#context.monotonic();
    const snapshot = world.cooldownState(button.action);
    const remaining = world.cooldownRemaining(button.action, monotonic);
    if (snapshot) {
      const elapsed = (monotonic - snapshot.startedAt) / 1000;
      return [pump.now() - elapsed, snapshot.duration / 1000, 1];
    }
    if (remaining > 0) {
      // No snapshot: the packet gave a remaining time and nothing else, so the duration is the
      // remaining time and the sweep starts full. `ui/ActionBar.ts` takes the same fallback.
      return [pump.now(), remaining / 1000, 1];
    }
    const global = this.#context.globalCooldownUntil() - monotonic;
    const metadata = this.#metadata(slot);
    if (global > 0 && (metadata?.startRecoveryTime ?? 0) > 0) {
      return [pump.now() - (metadata!.startRecoveryTime - global) / 1000, metadata!.startRecoveryTime / 1000, 1];
    }
    return [0, 0, 0];
  }

  actionUsable(slot: number): readonly [boolean, boolean] {
    const button = this.#button(slot);
    if (!button) return [false, false];
    if (button.type === ACTION_BUTTON_ITEM) {
      return [this.#actionItems(button.action).length > 0 && this.#itemCooldown(button.action)[2] === 0, false];
    }
    if (button.type !== ACTION_BUTTON_SPELL) return [true, false];
    const metadata = this.#metadata(slot);
    if (!metadata) return [true, false];
    if (metadata.passive) return [false, false];
    const world = this.#context.world();
    if (world && world.cooldownRemaining(button.action, this.#context.monotonic()) > 0) {
      return [false, false];
    }
    // A held spell is refused as NOT_READY until its aura ends (WorldClient.isSpellOnHold).
    if (world?.isSpellOnHold?.(button.action)) return [false, false];
    return [true, false];
  }

  isConsumableAction(slot: number): boolean {
    return this.#button(slot)?.type === ACTION_BUTTON_ITEM;
  }

  isStackableAction(slot: number): boolean {
    return this.#button(slot)?.type === ACTION_BUTTON_ITEM;
  }

  isEquippedAction(slot: number): boolean {
    const button = this.#button(slot);
    return button?.type === ACTION_BUTTON_ITEM && this.#actionItems(button.action)
      .some((item) => item.bag === INVENTORY_SLOT_BAG_0 && item.slot < INVENTORY_SLOT_BAG_START);
  }

  isCurrentAction(slot: number): boolean {
    const button = this.#button(slot);
    const world = this.#context.world();
    if (!button || !world || button.type !== ACTION_BUTTON_SPELL) return false;
    // A profession's opener while its stock trade skill window shows (FrameXmlTradeSkill.ts).
    if (this.tradeSkill.openerShowing(this.#context.spell(button.action))) return true;
    return world.isActiveMountSpell(button.action);
  }

  isAttackAction(): boolean {
    return false;
  }

  isAutoRepeatAction(slot: number): boolean {
    return this.#metadata(slot)?.autoRepeat === true;
  }

  /** No range check yet: the world knows where the target is, the bar does not ask. */
  actionInRange(): number | undefined {
    return undefined;
  }

  /** Stock arrows and keyboard input share the same main-bar page when the host supplies it. */
  actionBarPage(): number {
    const page = this.#context.actionBarPage?.() ?? this.#actionPage;
    return Number.isInteger(page) && page >= 1 && page <= 6 ? page : 1;
  }

  changeActionBarPage(page: number): void {
    if (!Number.isInteger(page) || page < 1 || page > 6 || page === this.actionBarPage()) return;
    if (this.#context.changeActionBarPage) {
      this.#context.changeActionBarPage(page);
      this.#reconcileActionPage();
    } else {
      this.#actionPage = page;
      this.#pump?.fire(FRAMEXML_SEAM_EVENTS.actionPageChanged);
    }
  }

  #reconcileActionPage(): void {
    const page = this.actionBarPage();
    if (page === this.#actionPage) return;
    this.#actionPage = page;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.actionPageChanged);
  }

  /** The active core sends FATIGUE/BREATH; FIRE is a server-only environmental damage timer. */
  mirrorTimerInfo(index: number): FrameXmlMirrorTimerInfo {
    const type = index === 1 ? MIRROR_TIMER_FATIGUE : index === 2 ? MIRROR_TIMER_BREATH : undefined;
    if (type === undefined) return ["UNKNOWN"];
    const held = this.#context.world()?.mirrorTimers?.get(type);
    if (!held) return ["UNKNOWN"];
    const timer = type === MIRROR_TIMER_BREATH ? "BREATH" : "EXHAUSTION";
    return [timer, mirrorTimerRemaining(held.timer, held.receivedAt, this.#context.monotonic()),
      held.timer.maxValue, held.timer.scale, held.timer.paused ? 1 : 0, MIRROR_TIMER_NAMES[type]!];
  }

  mirrorTimerProgress(timer: string): number {
    const index = timer === "EXHAUSTION" ? 1 : timer === "BREATH" ? 2 : 0;
    const info = this.mirrorTimerInfo(index);
    return info[0] === "UNKNOWN" ? 0 : info[1];
  }

  #reconcileMirrorTimers(): void {
    const pump = this.#pump;
    if (!pump) return;
    for (const [type, index, token] of [
      [MIRROR_TIMER_FATIGUE, 1, "EXHAUSTION"], [MIRROR_TIMER_BREATH, 2, "BREATH"],
    ] as const) {
      const held = this.#context.world()?.mirrorTimers?.get(type);
      const previous = this.#mirrorTimerSignatures.get(type);
      if (!held) {
        if (previous !== undefined) {
          this.#mirrorTimerSignatures.delete(type);
          pump.fire(FRAMEXML_SEAM_EVENTS.mirrorTimerStop, token);
        }
        continue;
      }
      const timer = held.timer;
      const signature = `${held.receivedAt}:${timer.value}:${timer.maxValue}:${timer.scale}:${timer.paused}`;
      if (signature === previous) continue;
      this.#mirrorTimerSignatures.set(type, signature);
      // A repeated START updates the stock dialog's value and paused bit atomically, using the
      // authoritative snapshot. It also avoids the legacy PAUSE handler's mixed token/number arg.
      pump.fire(FRAMEXML_SEAM_EVENTS.mirrorTimerStart, ...this.mirrorTimerInfo(index));
    }
  }

  bonusBarOffset(): number {
    // The rule is shared with the native bar and keys 1 to = (game/BonusBar.ts).
    return worldBonusBarOffset(this.#context.world(), (id) => this.#context.spell(id));
  }

  /**
   * The only outbound chat path exposed to FrameXML. The host owns the world connection; this seam
   * only resolves the stock token and applies the server's byte limit before invoking it.
   */
  sendChatMessage(text: string, type: string, language: number | undefined, target: FrameXmlChatTarget): void {
    const code = frameXmlChatTypeCode(type);
    if (code === undefined || !frameXmlChatTextIsValid(text, code)) return;
    const resolvedTarget = typeof target === "number"
      ? code === CHAT_MSG_CHANNEL ? this.#channelTarget(target) : undefined
      : target;
    if (resolvedTarget === undefined) return;
    this.#context.sendChatMessage?.(text, code, language, resolvedTarget);
  }

  playSound(name: string): void {
    this.#context.playSound?.(name);
  }

  chatWindowMessages(windowId: number): readonly string[] {
    return windowId === 1 ? FRAMEXML_CHAT_WINDOW_GROUPS : [];
  }

  /**
   * Window 1's channels by short name, each with its zone channel id — the ChatChannels id a join
   * gave a built-in channel, 0 for a custom one. Stock keeps that id in `zoneChannelList` and
   * matches a notice's `arg7` against it (ChatFrame.lua:2710), which is how it follows General
   * from zone to zone.
   */
  chatWindowChannels(windowId: number): FrameXmlChatWindowChannels {
    if (windowId !== 1) return [];
    const channels = this.#context.world()?.channels;
    if (!(channels instanceof Map)) return [];
    const result: (string | number)[] = [];
    for (const [name, held] of channels) {
      if (typeof name !== "string") continue;
      result.push(shortChannelName(name), held?.channelId ?? 0);
    }
    return result;
  }

  /** Resolve stock's 1-based numeric `channelTarget` against the world's stable Map insertion order. */
  #channelTarget(target: number): string | undefined {
    if (!Number.isInteger(target) || target < 1) return undefined;
    const channels = this.#context.world()?.channels;
    if (!(channels instanceof Map)) return undefined;
    let index = 1;
    for (const name of channels.keys()) {
      if (index === target) return typeof name === "string" ? name : undefined;
      index += 1;
    }
    return undefined;
  }

  chatWindowInfo(windowId: number): FrameXmlChatWindowInfo | undefined {
    if (!Number.isInteger(windowId) || windowId < 1 || windowId > 10) return undefined;
    const base: FrameXmlChatWindowInfo = windowId === 1 ? frameXmlGeneralWindowInfo(this.#chatWindowShown.get(1) ?? true)
      : windowId === 2 ? frameXmlCombatLogWindowInfo(this.locale)
        : ["", 0, 1, 1, 1, 0, false, true, false, false];
    // Stock's own LOCKED/DOCKED/UNINTERACTABLE writes ride over the seam's answer (FrameXmlChatWindowFlags.ts).
    return this.chatWindows.apply(windowId, base, this.#chatWindowShown.get(windowId));
  }

  setChatWindowShown(windowId: number, shown: boolean): void {
    if (Number.isInteger(windowId) && windowId >= 1 && windowId <= 10) this.#chatWindowShown.set(windowId, shown);
  }

  useAction(slot: number, _unit?: string, mouseButton?: string): void {
    // A press with a macro on the cursor puts it on the button, as in the client.
    if (this.macros.placeCursor(slot)) return;
    const button = this.#button(slot);
    if (!button) return;
    if (this.#context.useAction) {
      // The clicking mouse button reaches a macro on the slot: `[btn:N]` (Wow.exe 0x5abbc0).
      this.#context.useAction(slot, mouseButton);
      return;
    }
    if (button.type === ACTION_BUTTON_SPELL) {
      this.#context.castSpell(button.action);
      return;
    }
    if (button.type !== ACTION_BUTTON_ITEM || !this.actionUsable(slot)[0]) return;
    const world = this.#context.world();
    const held = this.#actionItems(button.action)[0];
    if (world && held) requestInventoryItemUse(held, () => world.useItem(held.bag, held.slot, held.guid));
  }

  /** The slot's server word, split as `Player.h` `ActionButton::GetAction`/`GetType` split it. */
  actionButton(slot: number): FrameXmlActionButton | undefined {
    const button = this.#button(slot);
    return button ? { action: button.action, type: button.type } : undefined;
  }

  /** The native bar's own write (ui/ActionBar.ts `dropSlot`): CMSG_SET_ACTION_BUTTON plus the local copy. */
  setActionButton(slot: number, action: number, type: number): boolean {
    const world = this.#context.world();
    if (!world || !Number.isInteger(slot) || slot < 1 || slot > 144) return false;
    if (!Number.isSafeInteger(action) || action < 0 || action > 0x00ff_ffff) return false;
    world.setActionButton(slot - 1, action, type);
    return true;
  }

  spellBookSpellId(index: number, bookType: string | undefined): number | undefined {
    // The pet book is not modelled (`hasPetSpells` answers false).
    if (bookType !== undefined && bookType !== "spell") return undefined;
    return this.#spellEntry(index)?.id;
  }

  itemTexture(entry: number): string | undefined {
    return this.#context.itemInfo?.(entry)?.texture || this.#itemTexture(entry);
  }

  // ---- the player --------------------------------------------------------

  private player(unit: string): WorldObjectState | undefined {
    return unit === "player" ? this.#self() : undefined;
  }

  #merchantName(): string | undefined {
    const world = this.#context.world();
    return world ? this.#merchantNameFor(world) : undefined;
  }

  #merchantNameFor(world: WorldClient): string | undefined {
    const guid = world.vendor?.guid;
    if (!world || guid === undefined) return undefined;
    const object = world.state.objects.get(guid);
    return this.#targetNameFor(object) ?? world.names.get(guid);
  }

  /** Stock QuestFrame addresses the active giver as `questnpc`, independently of target selection. */
  #questNpc(): { world: WorldClient; guid: bigint; object: WorldObjectState } | undefined {
    const world = this.#context.world();
    const guid = world?.questDialog?.guid ?? world?.questList?.guid;
    if (!world || guid === undefined || guid === 0n) return undefined;
    const object = world.state.objects.get(guid);
    // With no object we cannot tell a streamed-out creature from a gameobject giver. Fail closed.
    if (!object || (object.typeId !== TYPEID_UNIT && object.typeId !== TYPEID_PLAYER)) return undefined;
    return { world, guid, object };
  }

  questNpcPortraitGuid(): bigint | undefined {
    const giver = this.#questNpc();
    // SetPortraitTexture displays the unit's current model. The server update field, not the
    // creature-template entry or the selected target, identifies that model. A missing/zero
    // display cannot produce a real portrait, so the host keeps QuestFrame's book fallback.
    return giver && (unitField.displayId(giver.object) ?? 0) > 0 ? giver.guid : undefined;
  }

  unitExists(unit: string): boolean {
    if (unit.toLowerCase() === "questnpc") return this.#questNpc() !== undefined;
    if (unit.toLowerCase() === "npc") return this.#context.world()?.vendor !== undefined
      || this.#context.world()?.trainer !== undefined
      // The open trade's partner is "NPC" to TradeFrame_Update (UnitName("NPC"), TradeFrame.lua:57).
      || this.trade.partnerName() !== undefined
      // The creature a conversation, flight map or bank is open with, as UnitName("npc") names it.
      || liveFrameXmlInteractionUnit(this.#context.world());
    return this.#unit(unit) !== undefined || this.#partyMember(unit) !== undefined;
  }

  unitName(unit: string): string | undefined {
    if (unit.toLowerCase() === "questnpc") {
      const giver = this.#questNpc();
      if (!giver) return undefined;
      return this.#targetNameFor(giver.object) ?? giver.world.names.get(giver.guid);
    }
    if (unit.toLowerCase() === "npc") {
      const world = this.#context.world();
      const partner = this.trade.partnerName();
      if (partner !== undefined) return partner;
      if (world?.vendor) return this.#merchantName();
      const trainer = world?.trainer;
      if (!trainer) {
        // GossipFrame/TaxiFrame/BankFrame title the conversation, flight master or banker (NPC lane).
        const npc = liveFrameXmlInteractionNpc(world);
        if (npc === undefined || !world) return undefined;
        const talker = world.state.objects.get(npc);
        return (talker ? this.#targetNameFor(talker) : undefined) ?? world.names.get(npc)
          ?? liveFrameXmlGameObjectName(world, talker);
      }
      const object = world.state.objects.get(trainer.guid);
      return (object ? this.#targetNameFor(object) : undefined) ?? world.names.get(trainer.guid);
    }
    return this.#partyMember(unit)?.name ?? this.#targetNameFor(this.#unit(unit)) ?? this.arena.name(unit);
  }

  unitPvpName(unit: string): string | undefined {
    // The worn title around the name («Рядовой Игрок»), from any player object's public
    // PLAYER_CHOSEN_TITLE and sex byte; the bare name until the CharTitles catalog lands, and for
    // anything that is not a player. Nil only without a name: CharacterFrame would print "nil".
    const name = this.unitName(unit);
    return name === undefined ? undefined : this.titles.displayName(name, liveFrameXmlTitleWearer(this.#unit(unit)));
  }

  unitLevel(unit: string): number | undefined {
    const object = this.#unit(unit);
    return (object ? unitField.level(object) : undefined) ?? this.#partyStats(unit)?.level;
  }

  /**
   * `UnitClass` answers the merged localised class name and the dataset's `ChrClasses.Filename`.
   *
   * The token is the dataset's, not a compiled ten: a TSWoW class (HERO is id 13, ARCHAEOLOGIST
   * id 12 on this dataset) answered nil before, and stock PaperDollFrame_SetStat's unguarded
   * `strupper` (PaperDollFrame.lua:268-269) aborted the stat pane after «Сила» and printed
   * «Человек, nil 80-го уровня». The dataset's own FrameXML carries rows for both tokens
   * (Constants.lua:54-97 RAID_CLASS_COLORS, CLASS_SORT_ORDER, CLASS_ICON_TCOORDS; WorldStateFrame.lua
   * CLASS_BUTTONS), so the real client with this dataset answers exactly these strings.
   * `ensureFrameXmlCreationNames` learns the list before the world boot; until it is learned a
   * custom class stays nil rather than receiving an invented token.
   */
  unitClass(unit: string): readonly [string, string] | undefined {
    const object = this.#unit(unit);
    // An arena opponent out of sight keeps the class the client saw (Blizzard_ArenaUI.lua:133-136).
    const arenaClass = object ? undefined : this.arena.classId(unit);
    if (arenaClass !== undefined) {
      const arenaToken = classFileName(arenaClass);
      return arenaToken === undefined ? undefined : [className(arenaClass), arenaToken];
    }
    if (object?.typeId !== TYPEID_PLAYER) return undefined;
    const classId = object ? unitField.classId(object) : undefined;
    const token = classFileName(classId);
    return token === undefined ? undefined : [className(classId), token];
  }

  /** `UnitRace` with the dataset's `ChrRaces.ClientFileString`, custom rows included. */
  unitRace(unit: string): readonly [string, string] | undefined {
    const object = this.#unit(unit);
    if (object?.typeId !== TYPEID_PLAYER) return undefined;
    const raceId = unitField.race(object);
    const token = raceFileName(raceId);
    return token === undefined ? undefined : [raceName(raceId), token];
  }

  unitSex(unit: string): number | undefined {
    const object = this.#unit(unit);
    if (object?.typeId !== TYPEID_PLAYER) return undefined;
    const gender = object ? unitField.gender(object) : undefined;
    // The wire counts 0 male / 1 female; the API counts 1 neuter / 2 male / 3 female.
    return gender === undefined ? undefined : gender + 2;
  }

  unitHealth(unit: string): number {
    const object = this.#unit(unit);
    return (object ? unitField.health(object) : undefined) ?? this.#partyStats(unit)?.health ?? 0;
  }

  unitHealthMax(unit: string): number {
    const object = this.#unit(unit);
    return (object ? unitField.maxHealth(object) : undefined) ?? this.#partyStats(unit)?.maxHealth ?? 0;
  }

  unitPower(unit: string): number {
    const object = this.#unit(unit);
    return (object ? unitField.power(object) : undefined) ?? this.#partyStats(unit)?.power ?? 0;
  }

  unitPowerMax(unit: string): number {
    const object = this.#unit(unit);
    return (object ? unitField.maxPower(object) : undefined) ?? this.#partyStats(unit)?.maxPower ?? 0;
  }

  unitPowerType(unit: string): readonly [number, string] | undefined {
    const object = this.#unit(unit);
    const type = (object ? unitField.powerType(object) : undefined) ?? this.#partyStats(unit)?.powerType;
    if (type === undefined) return undefined;
    return [type, FRAMEXML_POWER_TOKENS[type] ?? "MANA"];
  }

  /** Resolve the player faction from the authoritative 3.3.5 race id; unknown ids stay nil. */
  unitFactionGroup(unit: string): string | undefined {
    if (unit !== "player") return undefined;
    const player = this.#self();
    if (!player || player.typeId !== TYPEID_PLAYER) return undefined;
    const raceId = unitField.race(player);
    if (raceId === undefined) return undefined;
    if (ALLIANCE_RACE_IDS.has(raceId)) return "Alliance";
    if (HORDE_RACE_IDS.has(raceId)) return "Horde";
    return undefined;
  }

  unitClassification(unit: string): string | undefined {
    const object = this.#unit(unit);
    if (!object) return undefined;
    if (object.typeId === TYPEID_PLAYER) return "normal";
    if (object.typeId !== TYPEID_UNIT) return undefined;
    const entry = readField(object, "OBJECT_FIELD_ENTRY");
    const classification = entry === undefined
      ? undefined
      : this.#context.world()?.creatureTemplates.get(entry)?.classification;
    return classification === undefined ? undefined : CREATURE_CLASSIFICATIONS[classification] ?? "normal";
  }

  unitIsUnit(left: string, right: string): boolean {
    const l = this.#unitGuid(left);
    const r = this.#unitGuid(right);
    return l !== undefined && r !== undefined && l === r;
  }

  unitIsPlayer(unit: string): boolean {
    return this.#partyMember(unit) !== undefined || this.#unit(unit)?.typeId === TYPEID_PLAYER;
  }

  /** Party status carries connectivity even when the member's object is outside this grid. */
  unitIsConnected(unit: string): boolean {
    const member = this.#partyMember(unit);
    if (member) {
      const stats = this.#partyStats(unit);
      // `status` is present only when GROUP_UPDATE_STATUS was carried. If an older stats packet
      // is folded onto a new group snapshot, the roster's own online bit remains authoritative
      // until a fresh status field arrives.
      const status = stats && (stats.flags & GROUP_UPDATE_STATUS) !== 0 ? stats.status : undefined;
      return status === undefined ? member.online : (status & MEMBER_STATUS_ONLINE) !== 0;
    }
    // Connectivity has no separate bit in WorldObjectState; an object in range is connected.
    return this.#unit(unit) !== undefined;
  }

  unitIsDead(unit: string): boolean {
    const stats = this.#partyStats(unit);
    if (stats && (stats.flags & GROUP_UPDATE_STATUS) !== 0
      && stats.status !== undefined && (stats.status & MEMBER_STATUS_DEAD) !== 0) return true;
    const object = this.#unit(unit);
    return object !== undefined && isWorldObjectDead(object);
  }

  unitIsGhost(unit: string): boolean {
    const stats = this.#partyStats(unit);
    if (stats && (stats.flags & GROUP_UPDATE_STATUS) !== 0 && stats.status !== undefined) {
      return (stats.status & MEMBER_STATUS_GHOST) !== 0;
    }
    const object = this.#unit(unit);
    return object !== undefined && isPlayerGhost(object);
  }

  unitIsCorpse(unit: string): boolean {
    return this.unitIsDead(unit);
  }

  /**
   * Relation is intentionally neutral until FactionTemplate.dbc is supplied. The world carries
   * only each object's template id, and `LiveWorldSeamContext` cannot reach `game.factions` without
   * changing the mount contract; inventing hostility from creature/player type would be unsafe.
   */
  #reaction(left: string, right: string): number | undefined {
    const l = this.#unit(left);
    const r = this.#unit(right);
    if (!l || !r) return undefined;
    if (l.guid === r.guid) return REACTION_FRIENDLY;
    // The actual mount currently has no resolver in its LiveWorldSeamContext, so this remains a
    // neutral/unknown answer there. A host with FactionTemplate.dbc can provide the exact relation
    // without making the seam guess from player-vs-creature type.
    return this.#context.reaction?.(l, r);
  }

  unitIsFriend(left: string, right: string): boolean {
    return this.#reaction(left, right) === REACTION_FRIENDLY;
  }

  unitIsEnemy(left: string, right: string): boolean {
    return this.#reaction(left, right) === REACTION_HOSTILE;
  }

  unitCanAttack(left: string, right: string): boolean {
    const reaction = this.#reaction(left, right);
    // A known neutral unit is attackable; an unresolved relation is not safe to act on.
    return reaction !== undefined && reaction !== REACTION_FRIENDLY;
  }

  unitPlayerControlled(unit: string): boolean {
    return this.unitIsPlayer(unit);
  }

  unitIsPVP(unit: string): boolean {
    const member = this.#partyMember(unit);
    // GroupMember.status is the server's authoritative PvP bit and remains available for an
    // out-of-range party slot; do not require a world object just to answer this PartyFrame edge.
    if (member) return (member.status & MEMBER_STATUS_PVP) !== 0;
    const object = this.#unit(unit);
    return object !== undefined && (unitField.pvpFlags(object) ?? 0) !== 0;
  }

  /** No FFA bit is retained in the current world-state contract. */
  unitIsPVPFreeForAll(): boolean {
    return false;
  }

  unitIsTapped(unit: string): boolean {
    const object = this.#unit(unit);
    return object !== undefined && ((unitField.dynamicFlags(object) ?? 0) & UNIT_DYNFLAG_TAPPED) !== 0;
  }

  unitIsTappedByPlayer(unit: string): boolean {
    const object = this.#unit(unit);
    return object !== undefined
      && ((unitField.dynamicFlags(object) ?? 0) & UNIT_DYNFLAG_TAPPED_BY_PLAYER) !== 0;
  }

  /** The all-threat-list bit is not represented by the current UNIT_DYNAMIC_FLAGS accessor. */
  unitIsTappedByAllThreatList(): boolean {
    return false;
  }

  unitSelectionColor(unit: string): readonly [number, number, number] | undefined {
    if (!this.unitExists(unit)) return undefined;
    const reaction = this.#reaction("player", unit);
    return reaction === REACTION_HOSTILE
      ? [1, 0, 0]
      : reaction === REACTION_FRIENDLY ? [0, 1, 0] : [1, 1, 0];
  }

  unitXP(unit: string): number {
    const player = this.player(unit);
    return (player ? playerFields.experience(player) : 0) ?? 0;
  }

  unitXPMax(unit: string): number {
    const player = this.player(unit);
    return (player ? playerFields.nextLevelExperience(player) : 0) ?? 0;
  }

  money(): number {
    return this.#currentMoney() ?? 0;
  }

  comboPoints(source: string, target: string): number {
    const world = this.#context.world();
    if (source !== "player" || this.#selfGuid() === undefined || !world) return 0;
    const targetGuid = this.#unitGuid(target);
    const combo = world.comboPoints;
    return targetGuid !== undefined && combo?.guid === targetGuid
      ? Math.max(0, Math.min(5, Math.trunc(combo.points))) : 0;
  }

  bankSlots(): readonly [number, boolean] | undefined {
    const world = this.#context.world();
    if (!world || typeof world.state.objects?.get !== "function") return undefined;
    // The one byte `playerInventory(...).bankBagSlotsBought` reads, without building the three
    // hundred slots around it: `#reconcileBankSlots` asks on every store flush.
    const guid = world.state.selfGuid;
    const player = guid === undefined ? undefined : world.state.objects.get(guid);
    const bought = player ? readByte(player, "PLAYER_BYTES_2", 2) ?? 0 : undefined;
    return bought !== undefined && Number.isInteger(bought) && bought >= 0 && bought <= BANK_BAG_SLOTS
      ? [bought, bought === BANK_BAG_SLOTS] : undefined;
  }

  bankSlotCost(bought: number): number | undefined {
    if (!Number.isInteger(bought) || bought < 0 || bought >= BANK_BAG_SLOTS) return undefined;
    const price = this.#context.bankSlotPrice?.(bought);
    return price !== undefined && Number.isSafeInteger(price) && price >= 0 ? price : undefined;
  }

  buyBankSlot(): void {
    const world = this.#context.world();
    const slots = this.bankSlots();
    if (world?.bankerGuid !== undefined && slots && !slots[1]) world.buyBankSlot();
  }

  closeBankFrame(): void { this.#context.world()?.closeBank(); }

  partyMemberCount(): number {
    const group = this.#context.world()?.group;
    return group && (group.groupType & GROUPTYPE_RAID) === 0
      ? Math.min(4, group.members.length)
      : 0;
  }

  /**
   * `GetNumRaidMembers` counts the player, as the client does: stock walks `raid1..N` and
   * `GetRaidRosterInfo(1..N)` expecting to meet the player there (PlayerFrame.lua:473-491, the
   * «Группа N» indicator). SMSG_GROUP_LIST never lists its receiver (Group::SendUpdateToPlayer), so
   * the player is the one after the listed members — FrameXmlRaid's row order and `raid<N>` here.
   */
  raidMemberCount(): number {
    const world = this.#context.world();
    const group = world?.group;
    if (!group || (group.groupType & GROUPTYPE_RAID) === 0) return 0;
    return group.members.length + (this.#raidSelfIndex(world) === undefined ? 0 : 1);
  }

  /** The player's `raid<i>` index when the list left the player out (never listed on the wire). */
  #raidSelfIndex(world: WorldClient | undefined): number | undefined {
    const self = world?.state.selfGuid;
    const members = world?.group?.members;
    if (self === undefined || self === 0n || !members) return undefined;
    for (const member of members) if (member.guid === self) return undefined;
    return members.length + 1;
  }

  isPartyLeader(): boolean {
    const world = this.#context.world();
    const group = world?.group;
    const selfGuid = world?.state.selfGuid;
    return group !== undefined
      && selfGuid !== undefined
      && selfGuid !== 0n
      && group.leaderGuid === selfGuid;
  }

  lootMethod(): FrameXmlLootMethod | undefined {
    const world = this.#context.world();
    return frameXmlLootMethod(world?.group, world?.state.selfGuid);
  }

  lootThreshold(): number {
    return this.#context.world()?.group?.lootThreshold ?? 0;
  }

  setLootMethod(method: string, master: string | undefined, threshold: number | undefined): void {
    const world = this.#context.world();
    const group = world?.group;
    const entry = Object.entries(FRAMEXML_LOOT_METHODS).find(([, token]) => token === method);
    if (!world || !group || !entry || !this.isPartyLeader() || (group.groupType & GROUPTYPE_LFG) !== 0) return;
    const value = Number(entry[0]);
    const quality = threshold ?? group.lootThreshold;
    // HandleLootMethodOpcode accepts uncommon through artifact, and checks the master is a member.
    if (!Number.isInteger(quality) || quality < 2 || quality > 6) return;
    let masterGuid = 0n;
    if (value === LOOT_METHOD_MASTER) {
      if (!master) return;
      const name = master.toLocaleLowerCase();
      const selfGuid = world.state.selfGuid;
      if (master === "player" || this.unitName("player")?.toLocaleLowerCase() === name) {
        masterGuid = selfGuid ?? 0n;
      } else {
        const member = this.#partyMember(master) ?? group.members.find((candidate) => candidate.name.toLocaleLowerCase() === name);
        masterGuid = member?.guid ?? 0n;
      }
      if (masterGuid === 0n) return;
    }
    world.setLootMethod(value, masterGuid, quality);
  }

  setLootThreshold(threshold: number): void {
    const world = this.#context.world();
    const group = world?.group;
    if (!world || !group || !this.isPartyLeader() || (group.groupType & GROUPTYPE_LFG) !== 0
      || FRAMEXML_LOOT_METHODS[group.lootMethod] === undefined
      || !Number.isInteger(threshold) || threshold < 2 || threshold > 6) return;
    world.setLootMethod(group.lootMethod, group.masterLooterGuid, threshold);
  }

  partyMember(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 1 || index > 4) return undefined;
    const group = this.#context.world()?.group;
    if (!group || (group.groupType & GROUPTYPE_RAID) !== 0) return undefined;
    return group.members[index - 1]?.name;
  }

  /**
   * `TargetUnit(unit or name[, exactMatch])`. A unit token selects that unit, or nothing when it is
   * absent. Anything else is a name, as stock `/target Name` (`SecureCmdList.TARGET`,
   * ChatFrame.lua:1143-1150) and `/targetexact` (`TargetUnit(target, 1)`, :1153-1160) pass it: the
   * nearest visible player or creature whose displayed name — `UnitName`'s own answer, so an
   * unnamed row never matches — is that name, case-insensitively. Without `exactMatch` a name that
   * only begins with the text counts too, after every whole-name match. That the partial match is a
   * prefix rather than a substring is this client's reading, not a measurement of the original.
   */
  targetUnit(unit: string, exactMatch = false): void {
    const world = this.#context.world();
    if (!world) return;
    const guid = this.#unitGuid(unit);
    if (guid !== undefined && guid !== 0n) {
      world.selectTarget(guid);
      return;
    }
    if (FRAMEXML_UNIT_TOKEN.test(unit)) return;
    const found = this.#nearestNamed(unit, exactMatch);
    if (found !== undefined) world.selectTarget(found);
  }

  /** The nearest in-range player or creature called `name` (see {@link targetUnit}). */
  #nearestNamed(name: string, exactMatch: boolean): bigint | undefined {
    const world = this.#context.world();
    const wanted = name.trim().toLocaleLowerCase();
    const objects = world?.state.objects;
    if (!world || !wanted || typeof objects?.values !== "function") return undefined;
    const origin = this.#self()?.position;
    let best: { guid: bigint; whole: boolean; distance: number } | undefined;
    for (const object of objects.values()) {
      if (object.typeId !== TYPEID_PLAYER && object.typeId !== TYPEID_UNIT) continue;
      const shown = this.#targetNameFor(object)?.toLocaleLowerCase();
      if (!shown) continue;
      const whole = shown === wanted;
      if (!whole && (exactMatch || !shown.startsWith(wanted))) continue;
      const position = object.guid === world.state.selfGuid ? origin : object.position;
      // A row the world has no position for is not somewhere the player can see.
      if (!position) continue;
      const distance = origin
        ? Math.hypot(position.x - origin.x, position.y - origin.y, position.z - origin.z) : 0;
      if (!best || (whole && !best.whole) || (whole === best.whole && distance < best.distance)) {
        best = { guid: object.guid, whole, distance };
      }
    }
    return best?.guid;
  }

  unitIsVisible(unit: string): boolean {
    return this.#unit(unit) !== undefined;
  }

  /** Possession is not represented in the current world object or pet packet model. */
  unitIsPossessed(): boolean {
    return false;
  }

  /** The current host has no happiness/damage percentage field for a live pet. */
  petHappiness(): readonly [number, number] | undefined {
    return undefined;
  }

  hasPetUI(): readonly [boolean, boolean] {
    const petSpells = this.#context.world()?.petSpells;
    const visible = petSpells !== undefined && petSpells.guid !== 0n;
    // isHunterPet: the pet's UNIT_PET_FLAG_CAN_BE_ABANDONED, set for hunter pets only (FrameXmlStable.ts).
    return [visible, visible && frameXmlHunterPet(this.#pet())];
  }

  /** `PetCanBeAbandoned`: the pet's UNIT_CAN_BE_ABANDONED flag — a hunter pet's (FrameXmlStable.ts). */
  petCanBeAbandoned(): boolean {
    return frameXmlHunterPet(this.#pet());
  }

  /** `PetCanBeRenamed`: the pet's UNIT_CAN_BE_RENAMED flag, cleared once a hunter pet has been named. */
  petCanBeRenamed(): boolean {
    return frameXmlPetCanBeRenamed(this.#pet());
  }

  /** `PetAbandon()`: CMSG_PET_ABANDON; the realm takes the bar down with the packet that follows. */
  petAbandon(): void {
    this.#context.world()?.abandonPet?.();
  }

  /** `PetRename(name)`: CMSG_PET_RENAME without declined forms, the stock popup's own call. */
  petRename(name: string): void {
    this.#context.world()?.renamePet?.(name);
  }

  /** Return the filtered 1-based player aura without exposing the server's raw slot number. */
  #playerAura(index: number, filter: string | undefined): ActiveAura | undefined {
    if (!Number.isInteger(index) || index <= 0
      || (filter !== "HELPFUL" && filter !== "HARMFUL")) return undefined;
    const world = this.#context.world();
    const selfGuid = world?.state.selfGuid;
    if (!world || selfGuid === undefined || typeof world.aurasFor !== "function") return undefined;
    let filteredIndex = 0;
    for (const aura of world.aurasFor(selfGuid)) {
      const positive = (aura.flags & AURA_FLAGS.positive) !== 0;
      const negative = (aura.flags & AURA_FLAGS.negative) !== 0;
      const matches = filter === "HELPFUL" ? positive && !negative : negative && !positive;
      if (!matches) continue;
      filteredIndex += 1;
      if (filteredIndex === index) return aura;
    }
    return undefined;
  }

  /** Translate one world aura to the exact 3.3.5 UnitAura tuple. */
  #auraInfo(aura: ActiveAura): FrameXmlAuraInfo {
    const metadata = this.#context.spell(aura.spellId);
    // The packet's `duration` is the remaining duration at receipt; UnitAura's duration is the
    // full duration. `maxDuration` is therefore the authoritative numerator when present.
    const fullDuration = aura.maxDuration ?? aura.duration;
    const duration = fullDuration === undefined ? 0 : Math.max(0, fullDuration) / 1000;
    const pumpNow = this.#pump?.now() ?? 0;
    const expirationTime = duration > 0 && aura.expiresAt !== undefined
      ? pumpNow + (aura.expiresAt - this.#context.monotonic()) / 1000
      : 0;
    const world = this.#context.world();
    const selfGuid = world?.state.selfGuid;
    const unitCaster = (aura.casterGuid === selfGuid
      || (aura.casterGuid === undefined && (aura.flags & AURA_FLAGS.caster) !== 0))
      ? "player"
      : aura.casterGuid !== undefined && aura.casterGuid === this.#targetGuid
        ? "target"
        : aura.casterGuid !== undefined && aura.casterGuid === this.#focusGuid
          ? "focus"
          : aura.casterGuid !== undefined && aura.casterGuid === this.#targetTargetGuid
            ? "targettarget"
            : aura.casterGuid !== undefined && aura.casterGuid === this.#petGuid
              ? "pet"
              : undefined;
    return [
      metadata?.name ?? `Заклинание ${aura.spellId}`,
      metadata?.rank ?? "",
      metadata?.iconPath ?? "",
      aura.applications,
      undefined,
      duration,
      expirationTime,
      unitCaster,
      false,
      false,
      aura.spellId,
    ];
  }

  /**
   * A primitive signature for the existing throttled poll. It includes metadata because the DBC
   * row can arrive after the aura packet; a changed name/rank/icon therefore gets one redraw too.
   */
  #auraShapeSignature(
    unit: "player" | "target" | "focus" | "targettarget" | "pet" = "player",
  ): string {
    const world = this.#context.world();
    const guid = unit === "player" ? world?.state.selfGuid
      : unit === "target" ? this.#target()?.guid
        : unit === "focus" ? this.#focus()?.guid
          : unit === "targettarget" ? this.#targetTarget()?.guid
            : this.#pet()?.guid;
    if (!world || guid === undefined || typeof world.aurasFor !== "function") return "";
    return world.aurasFor(guid).map((aura) => {
      const metadata = this.#context.spell(aura.spellId);
      return [
        aura.slot,
        aura.spellId,
        aura.flags,
        aura.casterLevel,
        aura.applications,
        aura.casterGuid ?? "",
        aura.maxDuration ?? "",
        aura.duration ?? "",
        aura.expiresAt ?? "",
        metadata?.name ?? `Заклинание ${aura.spellId}`,
        metadata?.rank ?? "",
        metadata?.iconPath ?? "",
      ].join("\u0001");
    }).join("\u0002");
  }

  // ---- unit auras -------------------------------------------------------

  unitAura(unit: string, index: number, filter: string | undefined): FrameXmlAuraInfo | undefined {
    const partyAura = this.#partyAura(unit, index, filter);
    if (partyAura !== undefined) return this.#auraInfo(partyAura);
    if (unit !== "player" && unit !== "target" && unit !== "focus"
      && unit !== "targettarget" && unit !== "pet") return undefined;
    const aura = this.#unitAura(unit, index, filter);
    return aura === undefined ? undefined : this.#auraInfo(aura);
  }

  unitBuff(unit: string, index: number): FrameXmlAuraInfo | undefined {
    return this.unitAura(unit, index, "HELPFUL");
  }

  unitDebuff(unit: string, index: number): FrameXmlAuraInfo | undefined {
    return this.unitAura(unit, index, "HARMFUL");
  }

  /** Return a filtered aura for either supported unit; UnitBuff/UnitDebuff bind fixed filters. */
  #unitAura(
    unit: "player" | "target" | "focus" | "targettarget" | "pet",
    index: number,
    filter: string | undefined,
  ): ActiveAura | undefined {
    if (!Number.isInteger(index) || index <= 0
      || (filter !== "HELPFUL" && filter !== "HARMFUL")) return undefined;
    const world = this.#context.world();
    const guid = unit === "player" ? world?.state.selfGuid
      : unit === "target" ? this.#target()?.guid
        : unit === "focus" ? this.#focus()?.guid
          : unit === "targettarget" ? this.#targetTarget()?.guid
            : this.#pet()?.guid;
    if (!world || guid === undefined || typeof world.aurasFor !== "function") return undefined;
    let filteredIndex = 0;
    for (const aura of world.aurasFor(guid)) {
      const positive = (aura.flags & AURA_FLAGS.positive) !== 0;
      const negative = (aura.flags & AURA_FLAGS.negative) !== 0;
      const matches = filter === "HELPFUL" ? positive && !negative : negative && !positive;
      if (!matches) continue;
      filteredIndex += 1;
      if (filteredIndex === index) return aura;
    }
    return undefined;
  }

  /**
   * Resolve only an in-range party object's authoritative ActiveAura rows.
   *
   * PartyMemberStats.auras are group-update rows, not ActiveAura rows: their flags have a
   * different protocol meaning and carry no application count/caster/duration fields.  In
   * particular, an out-of-range stats row cannot truthfully answer UnitBuff versus UnitDebuff,
   * so leave that query nil until the object enters range and `aurasFor` has authoritative flags.
   */
  #partyAura(unit: string, index: number, filter: string | undefined): ActiveAura | undefined {
    if (!Number.isInteger(index) || index <= 0
      || (filter !== "HELPFUL" && filter !== "HARMFUL")) return undefined;
    const member = this.#partyMember(unit);
    const world = this.#context.world();
    if (!member || !world) return undefined;
    if (!this.#partyObject(unit) || typeof world.aurasFor !== "function") return undefined;
    const auras = world.aurasFor(member.guid);
    let filteredIndex = 0;
    for (const aura of auras) {
      if (aura.spellId <= 0) continue;
      const positive = (aura.flags & AURA_FLAGS.positive) !== 0;
      const negative = (aura.flags & AURA_FLAGS.negative) !== 0;
      const matches = filter === "HELPFUL" ? positive && !negative : negative && !positive;
      if (!matches) continue;
      filteredIndex += 1;
      if (filteredIndex === index) return aura;
    }
    return undefined;
  }

  cancelUnitBuff(unit: string, index: number, filter: string | undefined): void {
    if (unit !== "player" || filter !== "HELPFUL") return;
    const aura = this.#playerAura(index, filter);
    if (aura === undefined) return;
    // Native BuffFrame only permits cancelling a resolved, non-passive spell. Keep unknown
    // metadata visible through UnitAura's fallback, but do not turn an unresolved row into an
    // unsafe cancel request.
    const metadata = this.#context.spell(aura.spellId);
    if (metadata?.passive !== false) return;
    this.#context.world()?.cancelAura(aura.spellId);
  }

  unitCastingInfo(unit: string): FrameXmlCastingInfo | undefined {
    return unit === "player" || unit === "target" || unit === "focus"
      || unit === "targettarget" || unit === "pet"
      ? this.#castInfo(unit, false) as FrameXmlCastingInfo | undefined
      : this.arena.castInfo(unit, false) as FrameXmlCastingInfo | undefined;
  }

  unitChannelInfo(unit: string): FrameXmlChannelInfo | undefined {
    return unit === "player" || unit === "target" || unit === "focus"
      || unit === "targettarget" || unit === "pet"
      ? this.#castInfo(unit, true) as FrameXmlChannelInfo | undefined
      : this.arena.castInfo(unit, true) as FrameXmlChannelInfo | undefined;
  }

  // ---- character skills -----------------------------------------------

  #allSkillRows(): readonly FrameXmlSkillRow[] {
    return this.#skillResolvers.skillRows();
  }

  #visibleSkillRows(): readonly FrameXmlSkillRow[] {
    const visible: FrameXmlSkillRow[] = [];
    let collapsed = false;
    for (const row of this.#allSkillRows()) {
      if (row.kind === "header") {
        collapsed = this.#collapsedSkillCategories.has(row.categoryId);
        visible.push(row);
      } else if (!collapsed) {
        visible.push(row);
      }
    }
    return visible;
  }

  #skillShapeSignature(): string {
    const rows = this.#visibleSkillRows();
    return rows.map((row) => row.kind === "header"
      ? `h:${row.categoryId}:${this.#collapsedSkillCategories.has(row.categoryId) ? 0 : 1}:${row.name}`
      : `s:${row.skillId}:${row.step}:${row.skillRank}:${row.numTempPoints}:${row.skillModifier}:${row.skillMaxRank}:${row.name}`
    ).join("|");
  }

  #publishSkillLinesChanged(force = false): void {
    const next = this.#skillShapeSignature();
    if (!force && next === this.#skillSignature) return;
    this.#skillSignature = next;
    if (this.#pump) this.#pump.fire(FRAMEXML_SEAM_EVENTS.skillLinesChanged);
  }

  skillLineCount(): number {
    return this.#visibleSkillRows().length;
  }

  skillLineInfo(index: number): FrameXmlSkillLineInfo {
    const rows = this.#visibleSkillRows();
    const row = Number.isInteger(index) && index >= 1 ? rows[index - 1] : undefined;
    if (!row) return ["", false, true, 0, 0, 0, 0, false, undefined, undefined, 0, 0, ""];
    if (row.kind === "header") {
      return [row.name, true, !this.#collapsedSkillCategories.has(row.categoryId),
        0, 0, 0, 0, false, undefined, undefined, 0, 0, ""];
    }
    return [row.name, false, true, row.skillRank, row.numTempPoints, row.skillModifier,
      row.skillMaxRank, frameXmlSkillAbandonable(row), undefined, undefined, 0, 0, ""];
  }

  abandonSkill(index: number): void {
    const row = Number.isInteger(index) && index >= 1 ? this.#visibleSkillRows()[index - 1] : undefined;
    // The stock button shows on `isAbandonable` alone (SkillFrame.lua:221); the core refuses the rest.
    if (row?.kind === "skill" && frameXmlSkillAbandonable(row)) this.#context.world()?.unlearnSkill(row.skillId);
  }

  adjustedSkillPoints(): number {
    // The current client has no authoritative skill-training point packet. Zero is the stock
    // reference's safe answer and keeps all purchase branches unreachable without fabrication.
    return 0;
  }

  selectedSkill(): number {
    if (this.#selectedSkillId === undefined) return 0;
    const index = this.#visibleSkillRows().findIndex((row) =>
      row.kind === "skill" && row.skillId === this.#selectedSkillId);
    return index < 0 ? 0 : index + 1;
  }

  setSelectedSkill(index: number): void {
    const row = Number.isInteger(index) && index >= 1 ? this.#visibleSkillRows()[index - 1] : undefined;
    this.#selectedSkillId = row?.kind === "skill" ? row.skillId : undefined;
  }

  #setSkillCategoryCollapsed(index: number, collapsed: boolean): void {
    const row = Number.isInteger(index) && index >= 1 ? this.#visibleSkillRows()[index - 1] : undefined;
    if (!row || row.kind !== "header") return;
    const wasCollapsed = this.#collapsedSkillCategories.has(row.categoryId);
    if (wasCollapsed === collapsed) return;
    if (collapsed) this.#collapsedSkillCategories.add(row.categoryId);
    else this.#collapsedSkillCategories.delete(row.categoryId);
    this.#publishSkillLinesChanged(true);
  }

  expandSkillHeader(index: number): void { this.#setSkillCategoryCollapsed(index, false); }
  collapseSkillHeader(index: number): void { this.#setSkillCategoryCollapsed(index, true); }
  addSkillUp(_index: number): void { /* no authoritative training packet */ }
  removeSkillUp(_index: number): void { /* no authoritative training packet */ }
  buySkillTier(_index: number): void { /* no authoritative training packet */ }
  cancelSkillUps(): void { /* no authoritative training packet */ }

  // ---- player and pet talents -------------------------------------------

  talentSnapshot(pet = false): FrameXmlTalentSnapshot | undefined {
    return pet ? this.#talentResolvers.petTalentSnapshot()
      : this.#talentResolvers.talentSnapshot();
  }

  learnTalent(tab: number, index: number, pet: boolean | undefined, group: number | undefined): void {
    const world = this.#context.world();
    const snapshot = this.talentSnapshot(pet === true);
    if (!world || !snapshot) return;
    const requestedGroup = group === undefined || !Number.isInteger(group)
      ? snapshot.activeTalentGroup : Math.trunc(group);
    if (requestedGroup !== snapshot.activeTalentGroup) return;
    const groupSnapshot = snapshot.groups[requestedGroup - 1];
    const cell = groupSnapshot?.tabs[tab - 1]?.talents[index - 1];
    if (!groupSnapshot?.active || !cell || cell.maxRank <= 0 || cell.rank >= cell.maxRank
      || groupSnapshot.unspentPoints === undefined || groupSnapshot.unspentPoints <= 0
      || cell.meetsPrereq !== true) return;
    if (pet === true) {
      const guid = world.petSpells?.guid;
      if (guid !== undefined && guid !== 0n) {
        world.learnPetTalents(guid, [{ talentId: cell.id, rank: cell.rank + 1 }]);
      }
    } else world.learnTalent(cell.id, cell.rank + 1);
  }

  // ---- player spellbook -------------------------------------------------

  // ---- honor / PvP statistics ------------------------------------------

  #honorSnapshot(): FrameXmlHonorSnapshot | undefined {
    return resolveFrameXmlHonorSnapshot(this.#self());
  }

  #publishHonorChanged(kind: "all" | "stats" | "currency" = "all", force = false): void {
    const snapshot = this.#honorSnapshot();
    const stats = snapshot === undefined ? "unavailable" : JSON.stringify([
      snapshot.todayHonorableKills,
      snapshot.yesterdayHonorableKills,
      snapshot.todayContribution,
      snapshot.yesterdayContribution,
      snapshot.lifetimeHonorableKills,
      snapshot.lifetimeContribution,
      snapshot.rank,
      snapshot.rankProgress,
    ]);
    const currency = snapshot === undefined
      ? "unavailable"
      : `${snapshot.honorCurrency}:${snapshot.arenaCurrency}`;
    const statsChanged = this.#honorSignature !== stats;
    const currencyChanged = this.#honorCurrencySignature !== currency;
    const publishStats = force || (kind === "all" || kind === "stats") && statsChanged;
    const publishCurrency = !force && (kind === "all" || kind === "currency") && currencyChanged;
    if (!publishStats && !publishCurrency) return;
    // A store may deliver several field writes before their callbacks run.  Do not let a
    // stats callback consume the currency signature (or vice versa): each callback owns only
    // the signature for its stock event family.  The attach path uses `all` and seeds both.
    if (kind === "all" || kind === "stats") this.#honorSignature = stats;
    if (kind === "all" || kind === "currency") this.#honorCurrencySignature = currency;
    if (publishStats) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.pvpKillsChanged);
    if (publishCurrency) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.honorCurrencyUpdate);
  }

  pvpSessionStats(): readonly [number, number] {
    const snapshot = this.#honorSnapshot();
    return snapshot === undefined
      ? [0, 0]
      : [snapshot.todayHonorableKills, snapshot.todayContribution];
  }

  pvpYesterdayStats(): readonly [number, number] {
    const snapshot = this.#honorSnapshot();
    return snapshot === undefined
      ? [0, 0]
      : [snapshot.yesterdayHonorableKills, snapshot.yesterdayContribution];
  }

  pvpLifetimeStats(): readonly [number, number | undefined] {
    const snapshot = this.#honorSnapshot();
    return snapshot === undefined
      ? [0, undefined]
      : [snapshot.lifetimeHonorableKills, snapshot.rank];
  }

  pvpRankInfo(_rank: number | undefined): readonly [string | undefined, number] {
    // The rank table is retired and absent from the authoritative world
    // snapshot. Keep nil name plus zero sentinel so stock HonorFrame can
    // render safely without claiming a rank that is not known.
    return [undefined, 0];
  }

  pvpRank(unit: string): number | undefined {
    return unit === "player" ? this.#honorSnapshot()?.rank : undefined;
  }

  pvpRankProgress(): number {
    return this.#honorSnapshot()?.rankProgress ?? 0;
  }

  pvpHonorCurrency(): number {
    return this.#honorSnapshot()?.honorCurrency ?? 0;
  }

  pvpArenaCurrency(): number {
    return this.#honorSnapshot()?.arenaCurrency ?? 0;
  }

  // ---- battleground queue ----------------------------------------------

  #battlegroundCatalog(): FrameXmlBattlegroundCatalog | undefined {
    const catalog = this.#context.battlegroundCatalog?.();
    if (!catalog || catalog.length !== FRAMEXML_BATTLEGROUND_TYPE_IDS.length) return undefined;
    for (let index = 0; index < FRAMEXML_BATTLEGROUND_TYPE_IDS.length; index += 1) {
      if (catalog[index]?.bgTypeId !== FRAMEXML_BATTLEGROUND_TYPE_IDS[index]) return undefined;
    }
    return catalog;
  }

  battlegroundCatalogReady(): boolean {
    return this.#battlegroundCatalog() !== undefined;
  }

  battlegroundTypeCount(): number {
    return this.#battlegroundCatalog()?.length ?? 0;
  }

  battlegroundInfo(index: number): readonly [string, boolean, boolean, boolean, number] | undefined {
    const catalog = this.#battlegroundCatalog();
    if (!catalog || !Number.isInteger(index) || index < 1 || index > catalog.length) return undefined;
    const row = catalog[index - 1];
    if (!row) return undefined;
    const level = this.unitLevel("player") ?? 0;
    const canEnter = level >= row.minLevel && level <= row.maxLevel;
    // HolidayWorldState identifies a possible world-state variable, not an active holiday. No
    // active holiday is asserted until a future authoritative state resolver exists.
    return [row.name, canEnter, false, row.random, row.bgTypeId];
  }

  battlefieldInfo(): readonly [string, string, number] | undefined {
    const catalog = this.#battlegroundCatalog();
    const row = catalog?.[this.#selectedBattleground - 1];
    if (!row) return undefined;
    const map = row.maps[0];
    // Battleground map descriptions follow the Map.dbc faction convention: description0 is Horde,
    // description1 is Alliance. Keep the other side as a truthful fallback if a map only carries
    // one localized description, and never invent a faction for an unresolved player.
    const faction = this.unitFactionGroup("player");
    const description = faction === "Alliance"
      ? map?.description1 ?? map?.description0
      : faction === "Horde"
        ? map?.description0 ?? map?.description1
        : map?.description0 !== undefined && map.description0 === map.description1
          ? map.description0
          : undefined;
    return [map?.name ?? row.name, description ?? "", row.maxGroupSize];
  }

  battlefieldStatus(index: number): readonly [string, string | undefined, number, number, number, number, boolean] {
    if (!Number.isInteger(index) || index < 1 || index > 2) return ["none", undefined, 0, 0, 0, 0, false];
    const world = this.#context.world();
    const status = world?.battlefieldQueues.get(index - 1);
    if (!status || status.cleared) return ["none", undefined, 0, 0, 0, 0, false];
    const row = this.#battlegroundCatalog()?.find((candidate) => candidate.bgTypeId === status.bgTypeId);
    const state = status.status === STATUS_WAIT_QUEUE
      ? "queued"
      : status.status === STATUS_WAIT_JOIN ? "confirm"
        : status.status === STATUS_IN_PROGRESS ? "active" : "none";
    // teamSize is the packet's arena type (BattlegroundMgr.cpp:206), 0 for a battleground: stock
    // reads non-zero as an arena, renames the queue ARENA_CASUAL/ARENA_RATED_MATCH "(N против N)"
    // (BattlefieldFrame.lua:242-248) and disables the entry dialog's Leave Queue (StaticPopup.lua:492).
    // That rename hides an arena's own name, which the seven-row catalog lacks; stock still
    // concatenates it unguarded (BattlefieldFrame.lua:431), so it is the invited map's Map.dbc name,
    // or "" while the all-arenas queue names no map.
    const arena = status.isArena;
    const name = row?.name ?? (arena
      ? this.#context.mapSource?.metadata()?.maps.find((map) => map.id === status.mapId)?.name ?? ""
      : undefined);
    return [
      state,
      name,
      status.clientInstanceId,
      status.minLevel,
      status.maxLevel,
      arena ? status.arenaType : 0,
      status.rated,
    ];
  }

  battlefieldQueueTimes(index: number): readonly [number, number] {
    const status = this.#context.world()?.battlefieldQueues.get(index - 1);
    if (!status || status.cleared || status.status !== STATUS_WAIT_QUEUE) return [0, 0];
    // Time2 is refreshed once a minute by the core (BattlegroundMgr.cpp:224); the client counts on.
    return [status.averageWaitTime, status.timeInQueue + this.#battlefieldStatusAge(status)];
  }

  battlefieldInstanceTimes(): readonly [number, number] {
    for (const status of this.#context.world()?.battlefieldQueues.values() ?? []) {
      if (status.cleared || status.status !== STATUS_IN_PROGRESS) continue;
      const age = this.#battlefieldStatusAge(status);
      // Time1 is 0 while the match runs and the auto-leave countdown once it has ended
      // (BattlegroundMgr.cpp:234); Time2 is the time since the match began.
      return [status.autoLeaveTime > 0 ? Math.max(0, status.autoLeaveTime - age) : 0, status.elapsedTime + age];
    }
    return [0, 0];
  }

  /** Milliseconds since this status snapshot was first read. */
  #battlefieldStatusAge(status: object): number {
    const now = this.#context.monotonic();
    const seen = this.#battlefieldStatusSeen.get(status);
    if (seen === undefined) this.#battlefieldStatusSeen.set(status, now);
    return seen === undefined ? 0 : Math.max(0, now - seen);
  }

  requestBattlegroundInstanceInfo(index: number): void {
    const row = this.#battlegroundCatalog()?.[index - 1];
    if (!row) return;
    this.#selectedBattleground = index;
    this.#context.world()?.requestBattlefieldList(row.bgTypeId, 1);
  }

  joinBattleground(asGroup: boolean): void {
    const row = this.#battlegroundCatalog()?.[this.#selectedBattleground - 1];
    if (!row) return;
    this.#context.world()?.joinBattleground(0n, row.bgTypeId, 0, asGroup);
  }

  sortBattlegroundList(): void {
    // BattlemasterList order is the client's authored order and must not be replaced with a
    // locale-dependent sort while the stock frame is holding one-based type indices.
  }

  closeBattleground(): void {
    // Closing the queue page does not send CMSG_BATTLEFIELD_LIST or leave a queue. ArenaFrame's
    // OnHide does, however, retire the local battlemaster publication so a late status edge cannot
    // reopen a stale window; PVPBattleground's own protocol behavior remains packet-free.
    this.#arenaListFresh = false;
    this.#arenaWasPublished = false;
  }

  isBattlefieldArena(): boolean {
    const world = this.#context.world();
    const list = world?.battlefieldList;
    return this.#arenaListFresh
      && this.#arenaListWorld === world
      && (this.#arenaClosing || this.#arenaListReference === list)
      && isArenaBattlefieldList(this.#arenaListReference);
  }

  currentArenaSeason(): number {
    const states = this.#context.world()?.worldStates;
    const value = states instanceof Map ? states.get(3191) : undefined;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  canJoinBattlefieldAsGroup(): boolean {
    return this.isBattlefieldArena();
  }

  joinArena(arenaSlot: number, asGroup: boolean, rated: boolean): void {
    const world = this.#context.world();
    const list = world?.battlefieldList;
    if (!world || !this.isBattlefieldArena() || !list || !Number.isInteger(arenaSlot)
      || arenaSlot < 0 || arenaSlot > 2
      || rated && (!asGroup || this.currentArenaSeason() === 0)
      || asGroup && (this.partyMemberCount() + this.raidMemberCount() === 0 || !this.isPartyLeader())
      || typeof world.joinArena !== "function") return;
    world.joinArena(list.battlemasterGuid, arenaSlot, asGroup, rated);
  }

  // ---- trainer ----------------------------------------------------------

  private trainerSupported(): boolean {
    const type = this.#context.world()?.trainer?.trainerType;
    return type === 0 || type === 1 || type === 3;
  }

  private trainerRows(): NonNullable<WorldClient["trainer"]>["spells"] {
    const trainer = this.#context.world()?.trainer;
    if (!trainer || !this.trainerSupported()) return [];
    return trainer.spells.filter((spell) => {
      const type = spell.usable === TRAINER_SPELL_AVAILABLE ? "available"
        : spell.usable === TRAINER_SPELL_KNOWN ? "used" : "unavailable";
      const metadata = this.#context.spell(spell.spellId);
      return this.#trainerFilters.get(type) !== false && metadata !== undefined && metadata.hidden !== true;
    });
  }

  private normalizeTrainerSelection(): void {
    const count = this.trainerRows().length;
    if (this.#trainerSelection === undefined || this.#trainerSelection < 1
      || this.#trainerSelection > count) this.#trainerSelection = count > 0 ? 1 : undefined;
  }

  private trainerRow(index: number): NonNullable<WorldClient["trainer"]>["spells"][number] | undefined {
    return Number.isInteger(index) && index > 0 ? this.trainerRows()[index - 1] : undefined;
  }

  trainerServiceCount(): number {
    this.normalizeTrainerSelection();
    return this.trainerRows().length;
  }

  trainerServiceInfo(index: number): readonly [string, string | undefined, string, boolean] | undefined {
    const row = this.trainerRow(index);
    const metadata = row ? this.#context.spell(row.spellId) : undefined;
    if (!row || !metadata) return undefined;
    return [metadata.name, metadata.rank, row.usable === TRAINER_SPELL_AVAILABLE ? "available"
      : row.usable === TRAINER_SPELL_KNOWN ? "used" : "unavailable", false];
  }

  trainerServiceCost(index: number): readonly [number, number, number] {
    const row = this.trainerRow(index);
    return row ? [row.moneyCost, row.pointCost[0], row.pointCost[1]] : [0, 0, 0];
  }
  trainerServiceLevelReq(index: number): number { return this.trainerRow(index)?.requiredLevel ?? 0; }
  trainerServiceSkillReq(index: number): readonly [string | undefined, number, boolean] {
    const row = this.trainerRow(index);
    return [undefined, 0, false];
  }
  trainerServiceNumAbilityReq(index: number): number {
    // Trainer packets expose prerequisite ids but not the localized metadata/state needed by the
    // stock ability rows. Keep the projection neutral until that tuple is truthful.
    return 0;
  }
  trainerServiceAbilityReq(_index: number, _requirement: number): readonly [number, boolean] | undefined {
    return undefined;
  }
  trainerServiceStepReq(_index: number): readonly [number | undefined, boolean] { return [undefined, false]; }
  trainerServiceIcon(index: number): string | undefined {
    const row = this.trainerRow(index);
    return row ? this.#context.spell(row.spellId)?.iconPath : undefined;
  }
  trainerServiceDescription(index: number): string | undefined {
    const row = this.trainerRow(index);
    return row ? this.#context.spell(row.spellId)?.description : undefined;
  }
  trainerServiceSkillLine(_index: number): string | undefined { return undefined; }
  trainerServiceItemLink(_index: number): string | undefined { return undefined; }
  trainerGreeting(): string | undefined {
    const trainer = this.#context.world()?.trainer;
    return this.trainerSupported() ? trainer?.greeting : undefined;
  }
  trainerType(): number | undefined { return this.#context.world()?.trainer?.trainerType; }
  trainerSelectionIndex(): number | undefined {
    if (!this.trainerSupported()) return undefined;
    this.normalizeTrainerSelection();
    return this.#trainerSelection;
  }
  trainerContextSignature(): string {
    const trainer = this.#context.world()?.trainer;
    return trainer ? `${trainer.guid}:${trainer.trainerType}:${trainer.spells.map((row) =>
      `${row.spellId},${row.usable},${row.moneyCost},${row.pointCost.join(",")},${row.requiredLevel},`
      + `${row.requiredSkillLine},${row.requiredSkillRank},${row.requiredAbilities.join(",")}`).join(";")}` : "";
  }
  selectTrainerService(index: number): void {
    // Stock calls this from ClassTrainer_SetSelection and completes the repaint on that stack.
    // A synchronous description event would recursively enter ClassTrainer_SetSelection again.
    if (this.trainerRow(index)) this.#trainerSelection = index;
  }
  isTradeskillTrainer(): boolean { return this.#context.world()?.trainer?.trainerType === 2; }
  buyTrainerService(index: number): void {
    const row = this.trainerRow(index);
    if (row?.usable === TRAINER_SPELL_AVAILABLE) this.#context.world()?.learnFromTrainer(row.spellId);
  }
  closeTrainer(): void {
    const world = this.#context.world();
    if (!world?.trainer || !this.trainerSupported()) return;
    world.closeTrainer();
    this.#trainerSelection = undefined;
  }
  trainerChanged(event: "show" | "update" | "closed"): void {
    if (event === "closed") { this.closeTrainer(); return; }
    if (!this.trainerSupported()) return;
    this.normalizeTrainerSelection();
    this.#pump?.fire(event === "show" ? FRAMEXML_SEAM_EVENTS.trainerUpdate : FRAMEXML_SEAM_EVENTS.trainerDescriptionUpdate);
  }
  trainerTypeFilter(type: string): boolean { return this.#trainerFilters.get(type) === true; }
  setTrainerTypeFilter(type: string, enabled: boolean): void {
    if (this.#trainerFilters.has(type)) {
      this.#trainerFilters.set(type, enabled);
      this.#trainerSelection = undefined;
    }
    this.normalizeTrainerSelection();
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.trainerUpdate);
  }
  collapseTrainerSkillLine(_index: number): void { this.#pump?.fire(FRAMEXML_SEAM_EVENTS.trainerUpdate); }
  expandTrainerSkillLine(_index: number): void { this.#pump?.fire(FRAMEXML_SEAM_EVENTS.trainerUpdate); }
  characterPoints(_unit: string): readonly [number, number] { return [0, 0]; }

  randomBattlegroundHonorBonuses(): readonly [boolean, number, number, number, number] {
    const list = this.#context.world()?.battlefieldList;
    if (!list?.random) return [false, 0, 0, 0, 0];
    return [list.randomHasWin, list.randomWinHonor, list.randomWinArena, list.randomLossHonor, 0];
  }

  holidayBattlegroundHonorBonuses(): readonly [boolean, number, number, number, number] {
    // No holiday world-state resolver is in this slice; expose the current ordinary list only if
    // stock asks for this tuple, while GetBattlegroundInfo keeps isHoliday false.
    const list = this.#context.world()?.battlefieldList;
    if (!list) return [false, 0, 0, 0, 0];
    return [list.hasWin, list.winHonor, list.winArena, list.lossHonor, 0];
  }

  wintergraspWaitTime(): number | undefined {
    // The outdoor BattlefieldMgr state is intentionally not represented by this queue C-API.
    return undefined;
  }

  canQueueForWintergrasp(): boolean {
    return false;
  }

  spellTabCount(): number {
    return this.#spellTabs().length;
  }

  shapeshiftFormCount(): number { return this.#shapeshiftForms().length; }

  shapeshiftFormInfo(index: number): FrameXmlShapeshiftFormInfo | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    const form = this.#shapeshiftForms()[index - 1];
    if (!form) return undefined;
    const castable = this.#shapeshiftCooldownRemaining(form.spellId, this.#context.monotonic()) <= 0;
    return [form.texture, form.name, this.#shapeshiftActive(form), castable];
  }

  shapeshiftFormCooldown(index: number): FrameXmlSpellCooldown {
    if (!Number.isInteger(index) || index < 1) return [0, 0, 0];
    const form = this.#shapeshiftForms()[index - 1];
    const cooldown = form && this.#context.world()?.cooldownSnapshots?.get(form.spellId);
    const monotonic = this.#context.monotonic();
    const remaining = form ? this.#shapeshiftCooldownRemaining(form.spellId, monotonic) : 0;
    if (remaining <= 0 || !this.#pump) return [0, 0, 0];
    if (cooldown && cooldown.endsAt - monotonic >= remaining) {
      return [this.#pump.now() - (monotonic - cooldown.startedAt) / 1000,
        cooldown.duration / 1000, 1];
    }
    return [this.#pump.now(), remaining / 1000, 1];
  }

  castShapeshiftForm(index: number): void {
    if (!Number.isInteger(index) || index < 1) return;
    const form = this.#shapeshiftForms()[index - 1];
    if (form && this.shapeshiftFormInfo(index)?.[3]) this.#context.castSpell(form.spellId);
  }

  spellTabInfo(index: number): FrameXmlSpellTabInfo | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    return this.#spellTabs()[index - 1];
  }

  spellName(index: number, _bookType: string | undefined): readonly [string, string] | undefined {
    const id = this.#spellEntry(index)?.id;
    const metadata = id === undefined ? undefined : this.#context.spell(id);
    return metadata === undefined ? undefined : [metadata.name, metadata.rank];
  }

  spellInfo(idOrName: number | string): readonly [string, string, string, number, number, number, number] | undefined {
    let metadata: SpellMetadata | undefined;
    if (typeof idOrName === "number") {
      if (!Number.isSafeInteger(idOrName) || idOrName <= 0) return undefined;
      metadata = this.#context.spell(idOrName);
    } else if (idOrName.length > 0) {
      for (const spell of this.#context.spells?.() ?? []) {
        if (spell.name !== idOrName) continue;
        // Rank selection is only meaningful among real cached rows with this exact name.
        if (!metadata || spell.spellLevel > metadata.spellLevel) metadata = spell;
      }
    }
    if (!metadata || !Number.isSafeInteger(metadata.id) || metadata.id <= 0
      || typeof metadata.name !== "string" || !metadata.name
      || typeof metadata.rank !== "string" || typeof metadata.iconPath !== "string"
      || !Number.isFinite(metadata.castTime)
      || !Number.isFinite(metadata.rangeMin) || !Number.isFinite(metadata.rangeMax)) return undefined;
    return [metadata.name, metadata.rank, metadata.iconPath, metadata.castTime,
      metadata.rangeMin, metadata.rangeMax, metadata.id];
  }

  /**
   * `GetSpellLink`, from the same cached rows as `GetSpellName`: a book slot when `bookType` is
   * given, else a spell id, else the name of a spell in the player's book — the highest rank of
   * it, as the client resolves a name. The pet book is not modelled (`hasPetSpells` answers
   * false), so a `"pet"` slot has no link. A row that has not arrived is nil, never a link to a
   * «Spell N» the chat would then carry.
   */
  spellLink(indexOrSpell: number | string, bookType?: string): string | undefined {
    let id: number | undefined;
    if (bookType !== undefined) {
      if (bookType !== "spell" || typeof indexOrSpell !== "number") return undefined;
      id = this.#spellEntry(indexOrSpell)?.id;
    } else if (typeof indexOrSpell === "number") {
      id = Number.isSafeInteger(indexOrSpell) && indexOrSpell > 0 ? indexOrSpell : undefined;
    } else {
      const wanted = indexOrSpell.trim().toLocaleLowerCase();
      let best: SpellMetadata | undefined;
      for (const entry of wanted ? this.#spellEntries() : []) {
        const spell = this.#context.spell(entry.id);
        if (spell?.name.toLocaleLowerCase() !== wanted) continue;
        if (!best || spell.spellLevel > best.spellLevel) best = spell;
      }
      id = best?.id;
    }
    const metadata = id === undefined ? undefined : this.#context.spell(id);
    return metadata && metadata.name ? spellChatLink(metadata.id, metadata.name) : undefined;
  }

  spellTexture(index: number, _bookType: string | undefined): string | undefined {
    const id = this.#spellEntry(index)?.id;
    return id === undefined ? undefined : this.#context.spell(id)?.iconPath;
  }

  spellCooldown(index: number, _bookType: string | undefined): FrameXmlSpellCooldown {
    const id = this.#spellId(index);
    const world = this.#context.world();
    const pump = this.#pump;
    const monotonic = this.#context.monotonic();
    const snapshot = id === undefined ? undefined : world?.cooldownSnapshots?.get(id);
    // A known spell that is ready answers `0, 0, 1`: `enable` is 0 only for a cooldown held back
    // (Stealth's, WorldClient.isSpellOnHold), and SpellButton_UpdateButton (SpellBookFrame.lua:462-467)
    // dims the icon to 0.4 for anything else — measured on the fixture, every ready spell in the
    // stock book was dimmed.
    if (id !== undefined && world?.isSpellOnHold?.(id)) return [0, 0, 0];
    if (!snapshot || snapshot.endsAt <= monotonic || !pump) return id === undefined ? [0, 0, 0] : [0, 0, 1];
    const start = pump.now() - (monotonic - snapshot.startedAt) / 1000;
    return [start, snapshot.duration / 1000, 1];
  }

  spellAutocast(index: number, _bookType: string | undefined): readonly [boolean, boolean] {
    return this.#spellEntry(index) === undefined ? [false, false] : [false, false];
  }

  spellIsPassive(index: number, _bookType: string | undefined): boolean | undefined {
    const id = this.#spellEntry(index)?.id;
    return id === undefined ? undefined : this.#context.spell(id)?.passive;
  }

  /**
   * `SpellBook_GetSpellID` (SpellBookFrame.lua:591-601) counts in the rank-folded book while
   * `ShowAllSpellRanks` is off and asks for the real slot here: the `index`-th row that is not a
   * lower rank. Without a rank classifier every row is its own highest rank.
   */
  knownSlotFromHighestRankSlot(index: number, _bookType: string | undefined): number | undefined {
    const lower = this.#context.spellIsLowerRank;
    if (!lower) return this.#spellEntry(index) === undefined ? undefined : index;
    if (!Number.isInteger(index) || index < 1) return undefined;
    let seen = 0;
    const entries = this.#spellEntries();
    for (let slot = 0; slot < entries.length; slot += 1) {
      if (lower(entries[slot]!.id)) continue;
      seen += 1;
      if (seen === index) return slot + 1;
    }
    return undefined;
  }

  spellIsSelected(index: number, _bookType: string | undefined): boolean {
    // A profession's opener is the selected spell while its stock trade skill window shows.
    const opener = this.#spellEntry(index)?.id;
    if (opener !== undefined && this.tradeSkill.openerShowing(this.#context.spell(opener))) return true;
    return this.#spellEntry(index) !== undefined && false;
  }

  hasPetSpells(): boolean {
    return false;
  }

  castSpell(spell: number, _bookType: string | undefined): void {
    const id = this.#spellId(spell);
    if (id !== undefined) this.#context.castSpell(id);
  }

  updateSpells(): void {
    // The world owns the list and publishes its own packet/event edges; this call is the client's
    // `UpdateSpells()`, and what it does in the client is raise SPELLS_CHANGED. The stock book
    // repaints itself on nothing else: SpellBookSkillLineTab_OnClick, the two page arrows and
    // ShowAllSpellRanksCheckBox all end in UpdateSpells() and rely on SpellButton_OnEvent to
    // redraw the twelve buttons (SpellBookFrame.lua). Kept as a bare cache invalidation, a tab
    // click moved `selectedSkillLine` and not one button on the page.
    this.#invalidateSpellEntries();
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.spellsChanged);
  }

  getCVar(name: string): string | undefined {
    return this.#context.settingsCVar?.get(name);
  }

  getCVarDefault(name: string): string | undefined {
    return this.#context.settingsCVar?.getDefault(name);
  }

  getCVarBool(name: string): boolean | undefined {
    const settingValue = this.#context.settingsCVar?.get(name);
    if (settingValue !== undefined) return settingValue !== "" && settingValue !== "0";
    const supplied = this.#context.getCVarBool?.(name);
    return supplied ?? this.#spellCvars.get(name.toLowerCase());
  }

  setCVar(name: string, value: boolean): void {
    if (name.toLowerCase() === "showallspellranks") {
      this.#spellCvars.set(name.toLowerCase(), value);
    }
    this.#context.setCVar?.(name, value);
  }

  setCVarValue(name: string, value: unknown): boolean | undefined {
    const settingsCVar = this.#context.settingsCVar;
    if (settingsCVar) return settingsCVar.set(name, value);
    this.setCVar(name, value === true || value === 1 || value === "1" || value === "true");
    return undefined;
  }

  /**
   * `GetRestState` follows the rested bonus (`frameXmlRestState`): MainMenuBar.lua:350-358 paints
   * the bar blue for 1 and purple for 2, so the old constant 1 kept a rested-blue bar for a
   * character with no bonus at all.
   */
  restState(): readonly [number, string, number] {
    return frameXmlRestState(this.#restedExperience());
  }

  // ---- player status (FrameXmlPlayerStatus.ts) ---------------------------------------------

  #playerFlags(): number | undefined {
    const self = this.#self();
    return self === undefined ? undefined : playerFields.flags(self);
  }

  #restedExperience(): number | undefined {
    const self = this.#self();
    return self === undefined ? undefined : playerFields.restedExperience(self);
  }

  isResting(): boolean {
    return frameXmlPlayerFlagResting(this.#playerFlags());
  }

  xpExhaustion(): number | undefined {
    return frameXmlXpExhaustion(this.#restedExperience());
  }

  unitIsAFK(unit: string): boolean {
    return this.#unitAway(unit, frameXmlPlayerFlagAfk, MEMBER_STATUS_AFK);
  }

  unitIsDND(unit: string): boolean {
    return this.#unitAway(unit, frameXmlPlayerFlagDnd, MEMBER_STATUS_DND);
  }

  /**
   * A player in view carries `PLAYER_FLAGS` (a public field); a party member out of range only
   * the status byte of SMSG_PARTY_MEMBER_STATS, whose AFK/DND bits are `GroupMemberOnlineStatus`.
   * A creature has neither, and is never away.
   */
  #unitAway(unit: string, flag: (flags: number | undefined) => boolean, memberStatus: number): boolean {
    const object = this.#unit(unit);
    if (object !== undefined) return flag(playerFields.flags(object));
    return ((this.#partyStats(unit)?.status ?? 0) & memberStatus) !== 0;
  }

  partyLeaderIndex(): number {
    const world = this.#context.world();
    return frameXmlPartyLeaderIndex(world?.group, world?.state.selfGuid);
  }

  /**
   * PLAYER_LEVEL_UP with the stock nine arguments (ChatFrame.lua:2562-2600 prints each): the level,
   * the health and mana gained and the five stat gains from SMSG_LEVELUP_INFO, and the talent points
   * gained — which the packet does not carry — as the rise of PLAYER_CHARACTER_POINTS1 that
   * `InitTalentForLevel` writes beside the new level, the realm's own rule for every class.
   * Fired once the player's level field reads the packet's level.
   */
  #publishLevelUp(): void {
    const pending = this.#pendingLevelUp;
    const pump = this.#pump;
    const self = this.#self();
    if (!pending || !pump || !self || readField(self, "UNIT_FIELD_LEVEL") !== pending.info.level) return;
    this.#pendingLevelUp = undefined;
    const { info } = pending;
    const points = Math.max(0, (readField(self, "PLAYER_CHARACTER_POINTS1") ?? 0) - pending.pointsBefore);
    const stat = (index: number): number => info.statDelta[index] ?? 0;
    pump.fire(FRAMEXML_SEAM_EVENTS.levelUp, info.level, info.healthDelta, info.powerDelta[0] ?? 0, points,
      stat(0), stat(1), stat(2), stat(3), stat(4));
  }

  // ---- control (FrameXmlControl.ts) ----------------------------------------

  /** `HasFullControl`: no fear, confusion, possession or stun, and the mover is the character. */
  hasFullControl(): boolean {
    return frameXmlHasFullControl(frameXmlControlWords(this.#context.world(), this.#self()));
  }

  /** PLAYER_CONTROL_LOST / _GAINED when the player goes out of control and back (not for a stun or a vehicle). */
  #reconcileControl(): void {
    this.#controlEdge.reconcile(frameXmlInControl(frameXmlControlWords(this.#context.world(), this.#self())), this.#pump);
  }

  // ---- combat and the group's relations (FrameXmlUnitRelations.ts) ------

  /** PLAYER_ENTER_COMBAT / PLAYER_LEAVE_COMBAT: the player's own auto-attack started or stopped. */
  #reconcileMelee(world: WorldClient, pump: FrameXmlSeamPump): void {
    const attacking = world.attacking === true;
    if (attacking === this.#meleeAnnounced) return;
    this.#meleeAnnounced = attacking;
    pump.fire(attacking ? "PLAYER_ENTER_COMBAT" : "PLAYER_LEAVE_COMBAT");
  }

  /** PLAYER_REGEN_DISABLED / PLAYER_REGEN_ENABLED: the player's `UNIT_FLAG_IN_COMBAT` came or went. */
  #reconcileCombat(): void {
    const pump = this.#pump;
    if (!pump) return;
    const inCombat = this.inCombatLockdown();
    if (inCombat === this.#combatAnnounced) return;
    this.#combatAnnounced = inCombat;
    pump.fire(inCombat ? "PLAYER_REGEN_DISABLED" : "PLAYER_REGEN_ENABLED");
  }

  unitAffectingCombat(unit: string): boolean {
    const object = this.#unit(unit);
    return object !== undefined && frameXmlUnitFlagsInCombat(unitField.flags(object));
  }

  inCombatLockdown(): boolean {
    const self = this.#self();
    return self !== undefined && frameXmlUnitFlagsInCombat(unitField.flags(self));
  }

  /**
   * A unit token, or — as the calendar and the channel roster pass it — a player's name, to the
   * guid the group list knows. Names match the list's own and the player's, case aside.
   */
  #relationGuid(unitOrName: string): bigint | undefined {
    if (unitOrName.length === 0) return undefined;
    const byToken = this.#unitGuid(unitOrName.toLowerCase());
    if (byToken !== undefined) return byToken;
    const world = this.#context.world();
    const wanted = unitOrName.toLowerCase();
    const member = world?.group?.members.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (member) return member.guid;
    return world?.selfName !== undefined && world.selfName.toLowerCase() === wanted ? world.state.selfGuid : undefined;
  }

  unitInParty(unitOrName: string): boolean {
    const world = this.#context.world();
    return frameXmlGroupHas(world?.group, world?.state.selfGuid, this.#relationGuid(unitOrName));
  }

  unitInRaid(unitOrName: string): number | undefined {
    const world = this.#context.world();
    return frameXmlRaidIndex(world?.group, world?.state.selfGuid, this.#relationGuid(unitOrName));
  }

  unitIsPartyLeader(unitOrName: string): boolean {
    return frameXmlGroupLeader(this.#context.world()?.group, this.#relationGuid(unitOrName));
  }

  unitIsRaidOfficer(unitOrName: string): boolean {
    const world = this.#context.world();
    return frameXmlRaidOfficer(world?.group, world?.state.selfGuid, this.#relationGuid(unitOrName));
  }

  #macroContext: MacroContext | undefined;

  /**
   * Macro conditions over this seam (macro/MacroContext.ts): its unit, group and bar answers, the
   * stance bar's own forms, and the world for what no stock function asks (mount, water, stealth).
   * The form walks (stance, bonus bar) are remembered until the learned spells, the form or the
   * resolved spell rows change: `bonusBarOffset` is a form lookup (game/BonusBar.ts) — a bonus bar
   * that comes from anything else (possession, line A9) must join the key.
   */
  macroContext(): MacroContext {
    if (this.#macroContext) return this.#macroContext;
    const world = (): WorldClient | undefined => this.#context.world();
    const revision = (): number | undefined => this.#context.talentMetadataRevision?.();
    return this.#macroContext = createMacroContext({
      ...frameXmlSeamMacroSource(this),
      world,
      shapeshiftForms: () => this.#shapeshiftForms(),
      spellRevision: revision,
      bonusBar: macroFormMemo(world, revision)(() => this.bonusBarOffset()),
      spec: () => {
        const talents = this.#context.world()?.talents;
        return talents ? talents.activeSpec + 1 : 0;
      },
    });
  }

  unitGroupRoles(unit: string): FrameXmlGroupRoles {
    const world = this.#context.world();
    const group = world?.group;
    if (!group) return frameXmlGroupRoles(undefined);
    // The list never carries the player; the header does (`ownRoles`).
    if (unit === "player") return frameXmlGroupRoles(group.ownRoles);
    const guid = this.#unitGuid(unit);
    if (guid === undefined) return frameXmlGroupRoles(undefined);
    if (guid === world.state.selfGuid) return frameXmlGroupRoles(group.ownRoles);
    return frameXmlGroupRoles(group.members.find((member) => member.guid === guid)?.roles);
  }

  optOutOfLoot(): boolean {
    return this.#context.world()?.optOutOfLoot ?? false;
  }

  setOptOutOfLoot(passOnLoot: boolean): void {
    this.#context.world()?.setOptOutOfLoot(passOnLoot);
  }

  raidTargetIndex(unit: string): number | undefined {
    return frameXmlRaidTargetIndex(this.#context.world()?.raidTargets, this.#unitGuid(unit));
  }

  // ---- the base minimap -------------------------------------------------

  minimapZoneText(): string | undefined {
    const zone = this.#minimapZone();
    return zone?.minimapZoneText ?? zone?.zoneText;
  }

  zoneText(): string | undefined {
    return this.#minimapZone()?.zoneText;
  }

  subZoneText(): string | undefined {
    return this.#minimapZone()?.subZoneText;
  }

  zonePvpInfo(): FrameXmlZonePvpInfo | undefined {
    const zone = this.#minimapZone();
    if (!zone) return undefined;
    return [zone.pvpType, zone.isSubZonePvP, zone.factionName];
  }

  // ---- minimap indicators -------------------------------------------------

  /** Tracking spells among the known spells, by the same DBC test the native panel uses. */
  #trackingSpells(world: WorldClient | undefined): TrackingSpell[] {
    if (!world || !Array.isArray(world.knownSpells)) return [];
    return trackingSpellsOf(world.knownSpells.map((known) => known.id), (id) => this.#context.spell(id));
  }

  trackingCount(): number {
    return this.#trackingSpells(this.#context.world()).length;
  }

  trackingInfo(index: number): FrameXmlTrackingInfo | undefined {
    const spell = this.#trackingSpells(this.#context.world())[index - 1];
    if (!spell) return undefined;
    // Every tracker this client models is a spell, which is also what stock keys its icon crop on.
    return [spell.name, this.#context.spell(spell.spellId)?.iconPath ?? "", isTracking(spell, this.#self()), "spell"];
  }

  trackingTexture(): string {
    const player = this.#self();
    const active = this.#trackingSpells(this.#context.world()).find((spell) => isTracking(spell, player));
    return (active && this.#context.spell(active.spellId)?.iconPath) || FRAMEXML_TRACKING_NONE_TEXTURE;
  }

  /**
   * There is no tracking opcode: turning a tracker on is casting its spell and turning it off is
   * `CMSG_CANCEL_AURA`, exactly as the native panel does (Tracking.ts). The cast goes through the
   * host's `castSpell` — Spellbook.castSpell, the shared preflight with the known-spell, cooldown,
   * `spellCastBlockReason` (GCD, combat) and ground-target checks — so the stock button can bypass
   * none of them. The fields, not this call, then say what is tracked.
   */
  setTracking(index: number | undefined): void {
    const world = this.#context.world();
    const spells = this.#trackingSpells(world);
    const player = this.#self();
    if (!world) return;
    if (index === undefined) {
      for (const spell of spells) if (isTracking(spell, player)) world.cancelAura(spell.spellId);
      return;
    }
    const spell = spells[index - 1];
    if (!spell) return;
    if (isTracking(spell, player)) world.cancelAura(spell.spellId);
    else this.#context.castSpell(spell.spellId);
  }

  /** `MSG_QUERY_NEXT_MAIL_TIME` answers 0 while unread mail waits and minus one day otherwise. */
  hasNewMail(): boolean {
    const next = this.#context.world()?.nextMailTime;
    return next !== undefined && next.nextMailTime >= 0;
  }

  latestMailSenders(): readonly string[] {
    const world = this.#context.world();
    if (!world || !this.hasNewMail()) return [];
    const names: string[] = [];
    for (const sender of world.nextMailTime?.senders ?? []) {
      // Player mail names a GUID (queried when the packet landed); creature mail names its entry.
      const name = sender.senderGuid !== 0n
        ? world.names.get(sender.senderGuid)
        : sender.altSenderType === MAIL_SENDER_CREATURE
          ? world.creatureTemplates.get(sender.altSenderId)?.name
          : undefined;
      if (name) names.push(name);
    }
    return names.slice(0, 3);
  }

  lfgMode(): FrameXmlLfgMode | undefined {
    const world = this.#context.world();
    if (!world) return undefined;
    return frameXmlLfgMode({
      lfgStatus: world.lfgStatus,
      lfgProposal: world.lfgProposal,
      lfgRoleCheck: world.lfgRoleCheck,
      groupType: world.group?.groupType,
      inGroup: world.group !== undefined,
      isGroupLeader: this.isPartyLeader(),
    });
  }

  /**
   * `GetInstanceInfo` from `Map.InstanceType` and the client's selected difficulties.
   *
   * `MapDifficulty.MaxPlayers` has no gateway route; a host may pass `instanceMaxPlayers`. Without
   * it the answer comes from this dataset's MapDifficulty.dbc, carried as data (`RAID_MAX_PLAYERS`,
   * `DUNGEON_MAX_PLAYERS`). A raid difficulty the map has no row for is downscaled the way the
   * server builds the instance, so a 25-player selection in Karazhan reads 10 and difficulty 1.
   * Inside a raid the server already reports the map's own difficulty when it differs from the
   * selection (Player.cpp:23348-23358). A raid map missing from the table, i.e. a TSWoW custom
   * raid, falls back to the uniform sizes of difficulties 1-3; its difficulty 0 stays unknown and
   * the answer is nil, so the stock flag hides rather than print an invented size.
   * `difficultyName` stays "": stock GetDungeonNameWithDifficulty (UIParent.lua:3374) then shows
   * the bare instance name.
   */
  instanceInfo(): FrameXmlInstanceInfo | undefined {
    const world = this.#context.world();
    const mapId = world?.mapId;
    if (!world || mapId === undefined) return undefined;
    const map = this.#context.mapSource?.metadata()?.maps.find((row) => row.id === mapId);
    if (!map) return undefined;
    const type = INSTANCE_TYPES[map.instanceType] ?? "none";
    const raid = type === "raid";
    let difficulty = (raid ? world.raidDifficulty : world.dungeonDifficulty) ?? 0;
    const known = this.#context.instanceMaxPlayers?.(mapId, difficulty);
    let maxPlayers: number | undefined;
    if (known !== undefined) maxPlayers = known;
    else if (type === "party") maxPlayers = DUNGEON_MAX_PLAYERS[mapId] ?? 5;
    else if (!raid) maxPlayers = 0;
    else {
      const sizes = RAID_MAX_PLAYERS[mapId];
      if (sizes) {
        const scaled = downscaledRaidDifficulty((index) => sizes[index] !== undefined, difficulty);
        if (scaled !== undefined) difficulty = scaled;
        maxPlayers = scaled === undefined ? undefined : sizes[scaled];
      } else {
        maxPlayers = RAID_MAX_PLAYERS_BY_DIFFICULTY[difficulty];
      }
    }
    if (maxPlayers === undefined) return undefined;
    return [map.name, type, difficulty + 1, "", maxPlayers, 0, false];
  }

  /**
   * One edge per indicator whose shape moved since the previous 60 ms poll. Every «nothing to
   * show» shape is `""`, the value attach starts from, so an empty world stays silent while a
   * tracker, letter, queue or instance that predates the mount is published on the first poll.
   */
  #reconcileMinimapIndicators(world: WorldClient, pump: FrameXmlSeamPump): void {
    // The active tracker lives in three player words; which spells are known is read afresh
    // whenever the stock dropdown opens, so learning one is not a tracking edge.
    const tracking = trackingFieldsSignature(this.#self());
    if (tracking !== this.#trackingSignature) {
      this.#trackingSignature = tracking;
      pump.fire(FRAMEXML_SEAM_EVENTS.tracking);
    }
    this.#queryPendingMail(world);
    const mail = this.hasNewMail() ? `1|${this.latestMailSenders().join("\u0001")}` : "";
    if (mail !== this.#mailSignature) {
      this.#mailSignature = mail;
      pump.fire(FRAMEXML_SEAM_EVENTS.pendingMail);
    }
    const lfg = this.lfgMode()?.join("\u0001") ?? "";
    if (lfg !== this.#lfgSignature) {
      this.#lfgSignature = lfg;
      pump.fire(FRAMEXML_SEAM_EVENTS.lfgUpdate);
    }
    const info = this.instanceInfo();
    const instance = info === undefined || info[1] === "none" ? "" : info.join("\u0001");
    if (instance !== this.#instanceSignature) {
      this.#instanceSignature = instance;
      pump.fire(FRAMEXML_SEAM_EVENTS.instanceInfo);
    }
  }

  /**
   * Ask the server what `HasNewMail` answers. `world.nextMailTime` is only ever a reply:
   * TrinityCore sends MSG_QUERY_NEXT_MAIL_TIME only as the reply to one (HandleQueryNextMailTime,
   * MailHandler.cpp:622) and announces a new letter with SMSG_RECEIVED_MAIL alone
   * (Player::SendNewMail, Player.cpp:3084), which WorldClient turns into a fresh `mailMessage`.
   * Nothing else in this client sends the query, so without this the stock MiniMapMailFrame could
   * never show. It is asked in three cases: once per world, after the player object exists (the
   * handler is STATUS_LOGGEDIN, Opcodes.cpp:775); on every new `mailMessage` (the received-mail
   * notice, or a mailbox result); and when the mailbox closes, because the server recounts unread
   * mail on CMSG_GET_MAIL_LIST and on each read (MailHandler.cpp:322, :562). Each is one small
   * packet on a player action or a server notice, never a per-poll stream.
   */
  #queryPendingMail(world: WorldClient): void {
    if (!this.#self()) return;
    const notice = world.mailMessage;
    const mailboxOpen = Boolean(world.mailboxGuid);
    const ask = world !== this.#mailQueryWorld
      || (notice !== this.#mailNotice && notice !== undefined)
      || (this.#mailboxOpen && !mailboxOpen);
    this.#mailQueryWorld = world;
    this.#mailNotice = notice;
    this.#mailboxOpen = mailboxOpen;
    if (ask) world.requestNextMailTime?.();
  }

  // ---- chat languages ------------------------------------------------------

  /** The player's `ChrRaces.BaseLanguage`, learned from the dataset for custom races too. */
  #defaultLanguageId(): number | undefined {
    const player = this.#self();
    const raceId = player ? unitField.race(player) : undefined;
    if (raceId === undefined) return undefined;
    return raceBaseLanguage(raceId) ?? languageForRace(raceId);
  }

  /**
   * `GetDefaultLanguage`: stock ChatFrame compares every line's `arg3` with it and hides the
   * bracket for the player's own language (ChatFrame.lua:2901) — a Human no longer sees
   * «[всеобщий]» on every SAY line.
   */
  defaultLanguage(): string | undefined {
    const id = this.#defaultLanguageId();
    const name = id === undefined ? "" : frameXmlLanguageName(id, this.locale);
    return name || undefined;
  }

  /** The languages whose skill line is in the player's skill fields, in `Languages.dbc` order. */
  languages(): readonly string[] {
    const player = this.#self();
    const known = new Set(player ? readSkills(player).map((skill) => skill.skillId) : []);
    const names: string[] = [];
    for (const [language, skill] of Object.entries(FRAMEXML_LANGUAGE_SKILLS)) {
      if (!known.has(skill)) continue;
      const name = frameXmlLanguageName(Number(language), this.locale);
      if (name) names.push(name);
    }
    const fallback = this.defaultLanguage();
    // Skill fields can trail the player object; the racial language is known from the race alone.
    return names.length > 0 || fallback === undefined ? names : [fallback];
  }
}

/** `MailMessageType` MAIL_CREATURE: `altSenderId` is a creature entry. */
const MAIL_SENDER_CREATURE = 3;

/** `Map.InstanceType` to the strings stock `GetInstanceInfo` callers compare against. */
const INSTANCE_TYPES: Readonly<Record<number, string>> = Object.freeze({
  0: "none", 1: "party", 2: "raid", 3: "pvp", 4: "arena",
});

/**
 * Raid difficulty 1..3 sizes, uniform across this dataset (all 15 rows: 25/10/25); difficulty 0 is
 * raid-specific. Used only for a raid map missing from `RAID_MAX_PLAYERS`.
 */
const RAID_MAX_PLAYERS_BY_DIFFICULTY: Readonly<Record<number, number>> = Object.freeze({
  1: 25, 2: 10, 3: 25,
});

/**
 * `MapDifficulty.MaxPlayers` for every raid map (Map.InstanceType 2), indexed by 0-based
 * difficulty. A hole is a difficulty that the map has no row for. Measured on this dataset's
 * MapDifficulty.dbc (189 rows, 2026-09-24), which has 24 raid maps and 39 raid rows; difficulty 0
 * alone is 10 for 11 raids, 20 for 2, 25 for 7 and 40 for 4. Map.MaxPlayers cannot stand in for
 * it: Map.dbc says 5 for Ulduar and 0 for Icecrown Citadel.
 */
const RAID_MAX_PLAYERS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  169: [40], 249: [10, 25], 309: [20], 409: [40], 469: [40], 509: [20], 531: [40], 532: [10],
  533: [10, 25], 534: [25], 544: [25], 548: [25], 550: [25], 564: [25], 565: [25], 568: [10],
  580: [25], 603: [10, 25], 615: [10, 25], 616: [10, 25], 624: [10, 25],
  631: [10, 25, 10, 25], 649: [10, 25, 10, 25], 724: [10, 25, 10, 25],
});

/**
 * The dungeon rows of the same table that are not 5-player: map 44 (the unused old Monastery) is
 * 10 and 229 (Blackrock Spire) is 15. Of the other 84 dungeon rows, 81 are 5 and three heroic rows
 * (553, 554, 598) say 0. For those three the answer stays 5, which is what Map.MaxPlayers says for
 * each of them; the real client's choice there is unmeasured.
 */
const DUNGEON_MAX_PLAYERS: Readonly<Record<number, number>> = Object.freeze({ 44: 10, 229: 15 });

/**
 * TrinityCore's GetDownscaledMapDifficultyData (DBCStores.cpp:827-849): a heroic difficulty the
 * map lacks drops to its normal size, any other drops by one, and then by one more.
 */
function downscaledRaidDifficulty(has: (difficulty: number) => boolean, difficulty: number): number | undefined {
  if (has(difficulty)) return difficulty;
  let next = difficulty > 1 ? difficulty - 2 : difficulty - 1;
  if (next >= 0 && has(next)) return next;
  next -= 1;
  return next >= 0 && has(next) ? next : undefined;
}

/** Object type ids in the 3.3.5 update block. */
const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

/** `CreatureTemplate.classification`, in the order sent by QueryCreatureResponse. */
const CREATURE_CLASSIFICATIONS: readonly string[] = Object.freeze([
  "normal", "elite", "rareelite", "worldboss", "rare",
]);
