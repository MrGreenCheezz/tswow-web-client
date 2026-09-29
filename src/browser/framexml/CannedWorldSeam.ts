import { FrameXmlWorldStates } from "./FrameXmlWorldStates.js";
import { CannedFrameXmlCalendar } from "./FrameXmlCalendarCanned.js";
import { FrameXmlHudMechanicsCanned } from "./FrameXmlHudMechanicsCanned.js";
import { FrameXmlMap } from "./FrameXmlMap.js";
import {
  FRAMEXML_CANNED_LFD_PLAYER_GUID,
  createCannedFrameXmlLfd,
  frameXmlStockClassId,
} from "./FrameXmlLfdCanned.js";
import { createCannedFrameXmlLoot } from "./FrameXmlLootCanned.js";
import { createCannedFrameXmlPopups } from "./FrameXmlPopupsCanned.js";
import { createCannedFrameXmlFriends } from "./FrameXmlFriendsCanned.js";
import { createCannedFrameXmlMail, FRAMEXML_CANNED_MAIL_ITEMS } from "./FrameXmlMailCanned.js";
import { createCannedFrameXmlTrade } from "./FrameXmlTradeCanned.js";
import { createCannedFrameXmlThreat } from "./FrameXmlThreatCanned.js";
import { FrameXmlQuestAbandonModel } from "./FrameXmlQuestAbandon.js";
import { FrameXmlChatWindowFlags } from "./FrameXmlChatWindowFlags.js";
import { FrameXmlMechanicsModel } from "./FrameXmlMechanics.js";
import { FRAMEXML_CONTROL_EVENTS } from "./FrameXmlControl.js";
import { FrameXmlGroupCommandsModel } from "./FrameXmlGroupCommands.js";
import type { FrameXmlTargeting } from "./FrameXmlTargetingApi.js";
import { createCannedFrameXmlCurrency } from "./FrameXmlCurrencyCanned.js";
import { createCannedFrameXmlTradeSkill } from "./FrameXmlTradeSkillCanned.js";
import { createCannedFrameXmlAuction } from "./FrameXmlAuctionCanned.js";
import { createCannedFrameXmlSocket } from "./FrameXmlSocketCanned.js";
import { createCannedFrameXmlInspect } from "./FrameXmlInspectCanned.js";
import { createCannedFrameXmlBarber } from "./FrameXmlBarberCanned.js";
import { createCannedFrameXmlGlyphs } from "./FrameXmlGlyphCanned.js";
import { createCannedFrameXmlCompanions } from "./FrameXmlCompanionsCanned.js";
import { createCannedFrameXmlPetActionBar } from "./FrameXmlPetActionBarCanned.js";
import { createCannedFrameXmlTitles } from "./FrameXmlTitlesCanned.js";
import { createCannedFrameXmlEquipmentSets } from "./FrameXmlEquipmentSetsCanned.js";
import { createCannedFrameXmlAchievements } from "./FrameXmlAchievementCanned.js";
import { createCannedFrameXmlGuildBank } from "./FrameXmlGuildBankCanned.js";
import { createCannedFrameXmlNpcWindows } from "./FrameXmlGossipCannedWindows.js";
import { createCannedFrameXmlMacros } from "./FrameXmlMacroCanned.js";
import { createMacroContext, frameXmlSeamMacroSource } from "../macro/MacroContext.js";
import type { MacroContext } from "../macro/MacroOptions.js";
import { FrameXmlCursorModel, type FrameXmlActionButton } from "./FrameXmlCursor.js";
import { ACTION_BUTTON_ITEM, ACTION_BUTTON_SPELL } from "../../world/ActionBarProtocol.js";
import { FrameXmlBindingModel } from "./FrameXmlBinding.js";
import { FrameXmlChatColors } from "./FrameXmlChatColors.js";
import type { InputAction } from "../input/Bindings.js";
import {
  frameXmlChatEventArgs,
  frameXmlChatEventName,
  frameXmlChatTextIsValid,
  frameXmlChatTypeCode,
  frameXmlLanguageName,
  FRAMEXML_TRACKING_NONE_TEXTURE,
  type FrameXmlCastingInfo,
  type FrameXmlChannelInfo,
  type FrameXmlMerchantItemInfo,
  type FrameXmlMerchantCostInfo,
  type FrameXmlItemInfo,
  type FrameXmlBuybackItemInfo,
  type FrameXmlSpellCooldown,
  type FrameXmlShapeshiftFormInfo,
  type FrameXmlSpellTabInfo,
  type FrameXmlSkillLineInfo,
  type FrameXmlAuraInfo,
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
  type FrameXmlQuestRewardSpell,
  type FrameXmlFactionInfo,
  type FrameXmlWatchedFactionInfo,
  type FrameXmlFactionRow,
  type FrameXmlChatSender,
  type FrameXmlChatTarget,
  type FrameXmlChatWindowChannels,
  type FrameXmlChatWindowInfo,
  FRAMEXML_POWER_EVENTS,
  FRAMEXML_POWER_MAX_EVENTS,
  FRAMEXML_POWER_TOKENS,
  FRAMEXML_SEAM_EVENTS,
  frameXmlInventorySlotInfo,
  frameXmlItemEntry,
  FRAMEXML_CHAT_WINDOW_GROUPS,
  frameXmlCombatLogWindowInfo,
  frameXmlGeneralWindowInfo,
  type FrameXmlSeamPump,
  type FrameXmlMinimapZone,
  type FrameXmlWorldSeam,
} from "./FrameXmlWorldSeam.js";
import type { FrameXmlTalentSnapshot } from "./FrameXmlTalentResolver.js";
import type { FrameXmlLootMethod } from "./FrameXmlGroupLoot.js";
import { frameXmlSkillAbandonable, type FrameXmlSkillRow } from "./FrameXmlSkillResolver.js";
import type { FrameXmlHonorSnapshot } from "./FrameXmlHonorResolver.js";
import type { FrameXmlSettingsCVarAdapter } from "./FrameXmlSettingsCVar.js";
import { createFrameXmlOptionsModel, type FrameXmlOptionsModel } from "./FrameXmlOptions.js";
import type { FrameXmlInventoryTooltipItem } from "./FrameXmlCharacterTooltip.js";
import { spellChatLink } from "../ui/ChatLink.js";
import {
  FRAMEXML_CANNED_BATTLEGROUNDS,
  type FrameXmlBattlegroundCatalog,
} from "./FrameXmlBattlegrounds.js";
import {
  CHAT_MSG_CHANNEL,
  CHAT_MSG_SAY,
  CHAT_MSG_SYSTEM,
} from "../../world/ChatProtocol.js";
import type { ChatMessage } from "../../world/ChatProtocol.js";
import { QUEST_STATE_COMPLETE, QUEST_STATE_FAIL } from "../../world/QuestProtocol.js";
import type { BattlefieldList } from "../../world/PvpProtocol.js";
import {
  TRAINER_SPELL_AVAILABLE,
  TRAINER_SPELL_UNAVAILABLE,
  TRAINER_SPELL_KNOWN,
  type TrainerSpell,
  type TrainerList,
} from "../../world/TrainerProtocol.js";

/**
 * A believable world, for the dev page — slice F3's seam (a).
 *
 * Everything here is *canned*, and the point of canned data is that it is checkable: the twelve
 * spells are real rows of this dataset, read out of the running gateway
 * (`/dbc/spells?ids=100,78,772,1715,6673,355,7384,20252,871,2565,6552,34428`) on 2026-08-30, with
 * their ruRU names, their `SpellIcon` ids and the `Interface\Icons\…` paths the client itself
 * would hand to `GetActionTexture`. Nothing below is a plausible-looking invention; the two numbers
 * that *are* this seam's own are marked as such where they appear.
 *
 * **The icon route is a measurement that made a plumbing job disappear.** The slice brief expected
 * spell icons to need `/spell-icon/<iconId>`, a different route from the `/texture` the FrameXML
 * texture cache already speaks, and therefore a URL-shaped texture answer and an extension to the
 * renderer's path handling. Measured against the live gateway instead:
 * `/texture?path=Interface\Icons\Spell_Fire_FlameBolt.blp` answers **200 with 5,412 bytes** and
 * `/spell-icon/185` answers **200 with the same 5,412 bytes** — they are the same picture, and the
 * icon path is what the real client's `GetActionTexture` returns anyway. So the seam answers the
 * client's own texture name, `frameXmlTexturePath` appends `.blp` exactly as it does for every
 * other texture in the corpus, and no route, resolver or renderer path was extended at all.
 */

/** One canned slot. `iconId` is carried so the number behind the picture is on record. */
export interface CannedAction {
  /** The client's 1-based action slot. */
  readonly slot: number;
  /** Spell id for a spell, item entry for a consumable. */
  readonly id: number;
  readonly kind: "spell" | "item";
  readonly name: string;
  /** `SpellIcon` id for a spell, `ItemDisplayInfo` id for an item; the number behind the picture. */
  readonly iconId: number;
  /**
   * `SpellIcon.TextureFilename` for a spell, `ItemDisplayInfo.InventoryIcon` for an item — which is
   * exactly what the real client's `GetActionTexture` answers for each.
   */
  readonly texture: string;
  /** `Spell.RecoveryTime` in milliseconds, 0 when the spell has none. */
  readonly recoveryMs: number;
  /** `Spell.RangeMax`; 0 is a self-cast, which has no range indicator. */
  readonly rangeMax: number;
  /** A consumable stack, for the one slot that carries a count. */
  readonly count?: number;
}

/** Explicit offline stance fixture; the live seam resolves its rows from known spells and DBC. */
export interface CannedShapeshiftForm {
  readonly spellId: number;
  readonly name: string;
  readonly texture: string;
  readonly castable?: boolean;
  /** Explicit fixture value from SpellShapeshiftForm.dbc BonusActionBar. */
  readonly bonusActionBarOffset?: number;
}

/** One item as exposed by the stock container C-API fixture. */
export interface CannedContainerItem {
  /** The item entry is retained for diagnostics; the C-API does not return it directly. */
  readonly entry?: number;
  /** Optional cached display name used by the synchronous stock tooltip path. */
  readonly name?: string;
  readonly texture?: string;
  readonly count?: number;
  readonly locked?: boolean;
  readonly quality?: number;
  readonly readable?: boolean;
  /** Explicit fixture state; live items derive this from owner durability fields. */
  readonly broken?: boolean;
  readonly link?: string;
  readonly cooldown?: FrameXmlContainerItemCooldown;
}

/** A player container addressed by the stock FrameXML bag id (0 is the backpack). */
export interface CannedContainer {
  readonly id: number;
  /** Host inventory bag number used by `WorldClient.useItem` (19 for stock bag id 1). */
  readonly hostBagSlot?: number;
  /** Host inventory slot addressed by stock slot 1 (23 backpack, 0 carried, 86 keyring). */
  readonly hostSlotOffset?: number;
  readonly name?: string;
  readonly bagFamily?: number;
  readonly slots: readonly (CannedContainerItem | undefined)[];
}

/** One deterministic vendor row for the stock merchant fixture. */
export interface CannedMerchantCost {
  readonly honor: number;
  readonly arena: number;
  readonly items: readonly {
    readonly itemId?: number;
    readonly name?: string;
    readonly quality?: number;
    readonly texture?: string;
    readonly count: number;
    readonly link?: string;
  }[];
}

export interface CannedMerchantItem {
  readonly slot: number;
  readonly itemId: number;
  readonly name: string;
  readonly quality?: number;
  readonly texture?: string;
  readonly price: number;
  readonly quantity: number;
  readonly numAvailable: number;
  readonly isUsable: boolean;
  readonly extendedCost?: number;
  readonly cost?: CannedMerchantCost;
  readonly link?: string;
  readonly maxStack?: number;
}

/** One buyback row; the stock API remains one-based and the world operation is absolute. */
export interface CannedBuybackItem {
  readonly slot: number;
  readonly itemId: number;
  readonly name: string;
  readonly texture?: string;
  readonly price: number;
  readonly quantity: number;
  readonly numAvailable: number;
  readonly isUsable: boolean;
  readonly link?: string;
}

export interface CannedMerchant {
  readonly guid: bigint;
  readonly name: string;
  readonly items: readonly CannedMerchantItem[];
  readonly buyback: readonly CannedBuybackItem[];
}

/** A small, metadata-backed class trainer used by the seam and vertical tests. */
export interface CannedTrainerService extends TrainerSpell {
  readonly name: string;
  readonly rank?: string;
  readonly iconPath?: string;
  readonly description?: string;
}

export interface CannedTrainer extends Omit<TrainerList, "spells"> {
  readonly name: string;
  readonly services: readonly CannedTrainerService[];
}

export const CANNED_TRAINER: CannedTrainer = Object.freeze({
  guid: 0x700n,
  name: "Наставник из Штормграда",
  trainerType: 0,
  greeting: "Чему я могу тебя научить?",
  services: Object.freeze([
    Object.freeze({ spellId: 100, usable: TRAINER_SPELL_AVAILABLE, moneyCost: 1250,
      pointCost: [0, 0] as [number, number], requiredLevel: 4, requiredSkillLine: 0,
      requiredSkillRank: 0, requiredAbilities: [0, 0, 0] as [number, number, number],
      name: "Рывок", rank: "", iconPath: "Interface\\Icons\\Ability_Warrior_Charge",
      description: "Мчится к противнику." }),
    Object.freeze({ spellId: 78, usable: TRAINER_SPELL_KNOWN, moneyCost: 0,
      pointCost: [0, 0] as [number, number], requiredLevel: 1, requiredSkillLine: 0,
      requiredSkillRank: 0, requiredAbilities: [0, 0, 0] as [number, number, number],
      name: "Удар героя", rank: "", iconPath: "Interface\\Icons\\Ability_Rogue_Ambush",
      description: "Мгновенный удар." }),
    Object.freeze({ spellId: 772, usable: 9, moneyCost: 2000,
      pointCost: [0, 0] as [number, number], requiredLevel: 8, requiredSkillLine: 0,
      requiredSkillRank: 0, requiredAbilities: [0, 0, 0] as [number, number, number],
      name: "Кровопускание", rank: "", iconPath: "Interface\\Icons\\Ability_Gouge",
      description: "Наносит периодический урон." }),
  ]),
});

export const CANNED_MERCHANT: CannedMerchant = Object.freeze({
  guid: 0x600n,
  name: "Торговец из Восточных королевств",
  items: Object.freeze([
    Object.freeze({
      slot: 1, itemId: 13446, name: "Огромный флакон с лечебным зельем",
      texture: "Interface\\Icons\\INV_Potion_54", price: 1250, quantity: 1,
      numAvailable: -1, isUsable: true, extendedCost: 0, maxStack: 20,
    }),
    Object.freeze({
      slot: 2, itemId: 6948, name: "Камень возвращения",
      texture: "Interface\\Icons\\INV_Misc_Rune_01", price: 100, quantity: 1,
      numAvailable: 1, isUsable: true, extendedCost: 0, maxStack: 1,
    }),
  ]),
  buyback: Object.freeze([
    Object.freeze({
      slot: 1, itemId: 13446, name: "Огромный флакон с лечебным зельем",
      texture: "Interface\\Icons\\INV_Potion_54", price: 1000, quantity: 1,
      numAvailable: 1, isUsable: true,
    }),
  ]),
});

const CANNED_BACKPACK_SLOTS: readonly (CannedContainerItem | undefined)[] = Object.freeze([
  Object.freeze({
    entry: 13446,
    name: "Огромный флакон с лечебным зельем",
    texture: "Interface\\Icons\\INV_Potion_54",
    count: 5,
    quality: 1,
  }),
  ...Array.from({ length: 15 }, () => undefined),
]);

const CANNED_KEYRING_SLOTS: readonly (CannedContainerItem | undefined)[] = Object.freeze([
  ...Array.from({ length: 32 }, () => undefined),
]);

/** Backpack, one carried bag and the fixed 32-slot keyring fixture. */
export const CANNED_CONTAINERS: readonly CannedContainer[] = Object.freeze([
  Object.freeze({
    id: 0,
    hostBagSlot: 255,
    hostSlotOffset: 23,
    name: "Рюкзак",
    bagFamily: 0,
    slots: CANNED_BACKPACK_SLOTS,
  }),
  Object.freeze({
    id: 1,
    hostBagSlot: 19,
    hostSlotOffset: 0,
    name: "Сумка",
    bagFamily: 0,
    slots: Object.freeze([
  Object.freeze({
    entry: 13446,
    name: "Огромный флакон с лечебным зельем",
    texture: "Interface\\Icons\\INV_Potion_54",
        count: 1,
        quality: 1,
      }),
      ...Array.from({ length: 3 }, () => undefined),
    ]),
  }),
  Object.freeze({
    id: -2,
    hostBagSlot: 255,
    hostSlotOffset: 86,
    name: "Связка ключей",
    bagFamily: 0,
    slots: CANNED_KEYRING_SLOTS,
  }),
]);

/**
 * A level-60 warrior's first bar, as this dataset spells it.
 *
 * Twelve rows, in the order a warrior would actually lay them out; the eleventh is the stackable
 * one — a stack of five Superior Healing Potions, so exactly one button carries a count, which is
 * the only way to see that `ActionButton_UpdateCount` runs.
 */
export const CANNED_ACTION_BAR: readonly CannedAction[] = Object.freeze([
  { slot: 1, id: 78, kind: "spell", name: "Удар героя", iconId: 856, texture: "Interface\\Icons\\Ability_Rogue_Ambush", recoveryMs: 0, rangeMax: 5 },
  { slot: 2, id: 772, kind: "spell", name: "Кровопускание", iconId: 245, texture: "Interface\\Icons\\Ability_Gouge", recoveryMs: 0, rangeMax: 5 },
  { slot: 3, id: 7384, kind: "spell", name: "Превосходство", iconId: 26, texture: "Interface\\Icons\\Ability_MeleeDamage", recoveryMs: 0, rangeMax: 5 },
  { slot: 4, id: 34428, kind: "spell", name: "Победный раж", iconId: 2053, texture: "Interface\\Icons\\Ability_Warrior_Devastate", recoveryMs: 0, rangeMax: 5 },
  { slot: 5, id: 1715, kind: "spell", name: "Подрезать сухожилия", iconId: 23, texture: "Interface\\Icons\\Ability_ShockWave", recoveryMs: 0, rangeMax: 5 },
  { slot: 6, id: 6552, kind: "spell", name: "Зуботычина", iconId: 756, texture: "Interface\\Icons\\INV_Gauntlets_04", recoveryMs: 10_000, rangeMax: 5 },
  { slot: 7, id: 100, kind: "spell", name: "Рывок", iconId: 457, texture: "Interface\\Icons\\Ability_Warrior_Charge", recoveryMs: 15_000, rangeMax: 25 },
  { slot: 8, id: 20252, kind: "spell", name: "Перехват", iconId: 516, texture: "Interface\\Icons\\Ability_Rogue_Sprint", recoveryMs: 30_000, rangeMax: 25 },
  { slot: 9, id: 6673, kind: "spell", name: "Боевой крик", iconId: 456, texture: "Interface\\Icons\\Ability_Warrior_BattleShout", recoveryMs: 0, rangeMax: 0 },
  { slot: 10, id: 2565, kind: "spell", name: "Блок щитом", iconId: 28, texture: "Interface\\Icons\\Ability_Defend", recoveryMs: 60_000, rangeMax: 0 },
  // The one consumable, so exactly one button carries a count. Item 13446 on this dataset, whose
  // `ItemDisplayInfo` 24152 names `INV_Potion_54` — read out of the DBC, not guessed from the name.
  { slot: 11, id: 13446, kind: "item", name: "Огромный флакон с лечебным зельем", iconId: 24152, texture: "Interface\\Icons\\INV_Potion_54", recoveryMs: 0, rangeMax: 0, count: 5 },
  { slot: 12, id: 871, kind: "spell", name: "Глухая оборона", iconId: 281, texture: "Interface\\Icons\\Ability_Warrior_ShieldWall", recoveryMs: 300_000, rangeMax: 0 },
]);

/**
 * The cooldown a click starts on a spell that has none of its own, in seconds.
 *
 * **This is the seam's own number, not the game's.** Nine of the twelve rows above have a
 * `RecoveryTime` of zero — a warrior's rotation is on the global cooldown, not on per-spell
 * recovery — and a one-and-a-half-second global cooldown is over before a screenshot pair can be
 * taken. Ten seconds is long enough to photograph the wipe moving and short enough to watch it
 * finish. Every other duration on this page is the spell's own.
 */
export const CANNED_CLICK_COOLDOWN_SECONDS = 10;

/** How far into `Блок щитом`'s sixty seconds the page opens; enough that the sector is obvious. */
const CANNED_INITIAL_COOLDOWN_ELAPSED_SECONDS = 12;

/** The canned rage an attack costs. This seam's own number, like the click cooldown above. */
const CANNED_RAGE_COST = 15;

/** The player: name, level, class, race, and the health that moves. */
export interface CannedPlayer {
  readonly name: string;
  readonly level: number;
  readonly className: string;
  readonly classToken: string;
  readonly raceName: string;
  readonly raceToken: string;
  /** 1 neuter, 2 male, 3 female. */
  readonly sex: number;
  readonly healthMax: number;
  /** `Powers`: 1 is rage, which is what a warrior spends and why the bar is red. */
  readonly powerType: number;
  readonly powerMax: number;
  readonly xp: number;
  readonly xpMax: number;
  /** Copper carried by the canned player; `GetMoney` returns this value. */
  readonly money: number;
  /** Explicit PaperDoll fixture tuples; no stats are derived from level or class. */
  readonly stats: readonly FrameXmlUnitStat[];
  readonly resistances: readonly FrameXmlUnitStat[];
  readonly attackPower: FrameXmlUnitAttackPower;
  readonly rangedAttackPower: FrameXmlUnitAttackPower;
  readonly attackSpeed: readonly [number, number | undefined];
  readonly damage: FrameXmlUnitDamage;
  readonly rangedDamage: FrameXmlUnitRangedDamage;
}

export const CANNED_PLAYER: CannedPlayer = Object.freeze({
  name: "Игрок",
  level: 60,
  className: "Воин",
  classToken: "WARRIOR",
  raceName: "Человек",
  raceToken: "Human",
  sex: 2,
  healthMax: 4230,
  powerType: 1,
  powerMax: 100,
  xp: 0,
  xpMax: 0,
  money: 123456,
  stats: Object.freeze([
    Object.freeze([100, 100, 0, 0]), Object.freeze([90, 95, 5, 0]),
    Object.freeze([80, 80, 0, 0]), Object.freeze([70, 70, 0, 0]), Object.freeze([60, 60, 0, 0]),
  ]) as readonly FrameXmlUnitStat[],
  resistances: Object.freeze([
    Object.freeze([120, 130, 10, 0]), Object.freeze([0, 0, 0, 0]), Object.freeze([0, 0, 0, 0]),
    Object.freeze([0, 0, 0, 0]), Object.freeze([0, 0, 0, 0]), Object.freeze([0, 0, 0, 0]),
    Object.freeze([0, 0, 0, 0]),
  ]) as readonly FrameXmlUnitStat[],
  attackPower: Object.freeze([950, 25, -5]) as FrameXmlUnitAttackPower,
  rangedAttackPower: Object.freeze([120, 0, 0]) as FrameXmlUnitAttackPower,
  attackSpeed: Object.freeze([2, undefined]) as readonly [number, number | undefined],
  damage: Object.freeze([55, 80, 0, 0, 0, 0, 1]) as FrameXmlUnitDamage,
  rangedDamage: Object.freeze([2, 45, 65, 0, 0, 1]) as FrameXmlUnitRangedDamage,
});

/** Deterministic player PvP fields for the stock HonorFrame bridge. */
export const CANNED_HONOR: FrameXmlHonorSnapshot = Object.freeze({
  todayHonorableKills: 42,
  yesterdayHonorableKills: 17,
  todayContribution: 900,
  yesterdayContribution: 650,
  lifetimeHonorableKills: 1234,
  honorCurrency: 4567,
  arenaCurrency: 321,
  // Retired rank/progress fields are deliberately unavailable in this client.
  lifetimeContribution: undefined,
  rank: undefined,
  rankProgress: undefined,
});

/** One explicit equipped item, used by PaperDoll tests to prove texture/count plumbing. */
export const CANNED_EQUIPMENT: readonly (CannedContainerItem | undefined)[] = Object.freeze([
  Object.freeze({ entry: 13446, name: "Огромный флакон с лечебным зельем",
    texture: "Interface\\Icons\\INV_Potion_54", count: 1, quality: 1 }),
  ...Array.from({ length: 18 }, () => undefined),
]);

/** One objective row in the deterministic quest-log fixture. */
export interface CannedQuestObjective {
  readonly text: string;
  readonly objectiveType?: string;
  readonly have?: number;
  readonly need: number;
}

export interface CannedQuestItemObjective {
  readonly itemId: number;
  readonly have?: number;
  readonly need: number;
}

/** A cached item row used by the stock QuestInfo reward widgets. */
export interface CannedQuestRewardItem {
  readonly itemId: number;
  readonly count: number;
  readonly name: string;
  readonly texture?: string;
  readonly quality?: number;
  readonly isUsable?: boolean;
}

/** A quest row and its optional resolved template for the stock QuestLog/Watch APIs. */
export interface CannedQuest {
  readonly questId: number;
  /** Whether this quest has a POI on the fixture's current map. */
  readonly currentMap?: boolean;
  readonly title?: string;
  readonly level?: number;
  readonly questTag?: string;
  readonly suggestedGroup?: number;
  readonly daily?: boolean;
  readonly state?: number;
  readonly description?: string;
  readonly objectivesText?: string;
  readonly completedText?: string;
  readonly requiredMoney?: number;
  /** Seconds left; absent is the truthful non-timed answer. */
  readonly timeLeft?: number;
  readonly objectives?: readonly CannedQuestObjective[];
  readonly itemObjectives?: readonly CannedQuestItemObjective[];
  readonly rewardItems?: readonly CannedQuestRewardItem[];
  readonly rewardChoiceItems?: readonly CannedQuestRewardItem[];
  /** Positive reward money; negative values are displayed as a required cost. */
  readonly rewardMoney?: number;
  readonly rewardDisplaySpell?: CannedQuestRewardSpell;
  /** Retained to prove display and cast ids are distinct; stock display API uses displaySpell. */
  readonly rewardSpellCast?: number;
  readonly rewardHonor?: number;
  readonly rewardArenaPoints?: number;
  readonly rewardTalents?: number;
  readonly rewardXP?: number;
  readonly rewardTitle?: string;
  readonly watched?: boolean;
}

export interface CannedQuestRewardSpell {
  readonly spellId: number;
  readonly texture: string;
  readonly name: string;
  readonly isTradeSkillSpell?: boolean;
  readonly isSpellLearned?: boolean;
}

/** A small quest fixture with one incomplete watched quest and real objective progress. */
export const CANNED_QUESTS: readonly CannedQuest[] = Object.freeze([
  Object.freeze({
    questId: 9001,
    currentMap: true,
    title: "Проверка журнала заданий",
    level: 60,
    suggestedGroup: 0,
    description: "Описание задания.",
    objectivesText: "Проверить цели.",
    completedText: "Цель выполнена.",
    requiredMoney: 125,
    timeLeft: 90,
    objectives: Object.freeze([
      Object.freeze({ text: "Проверить цель", objectiveType: "monster", have: 2, need: 5 }),
    ]),
    watched: true,
  }),
]);

/** A reward-bearing quest used by the standalone FrameXML bridge tests. */
export const CANNED_REWARD_QUEST: CannedQuest = Object.freeze({
  questId: 9002,
  currentMap: false,
  title: "Награда для проверки",
  level: 60,
  description: "Задание с наградами.",
  objectivesText: "Получить награды.",
  completedText: "Награда готова.",
  rewardMoney: 2345,
  rewardDisplaySpell: Object.freeze({
    spellId: 133,
    texture: "Interface\\Icons\\Spell_Fire_FlameBolt",
    name: "Огненный шар",
    isTradeSkillSpell: false,
    isSpellLearned: false,
  }),
  rewardSpellCast: 689,
  rewardHonor: 12,
  rewardTalents: 2,
  rewardItems: Object.freeze([
    Object.freeze({ itemId: 13446, count: 2, name: "Сильное зелье маны", texture: "Interface\\Icons\\INV_Potion_54", quality: 1, isUsable: true }),
  ]),
  rewardChoiceItems: Object.freeze([
    Object.freeze({ itemId: 2589, count: 5, name: "Льняной материал", texture: "Interface\\Icons\\INV_Fabric_Linen_01", quality: 0, isUsable: true }),
    Object.freeze({ itemId: 2605, count: 1, name: "Зелёный краситель", texture: "Interface\\Icons\\INV_Potion_21", quality: 1, isUsable: true }),
  ]),
});

/** Separate signed-money fixture: the same wire field is a required cost when negative. */
export const CANNED_REQUIRED_MONEY_QUEST: CannedQuest = Object.freeze({
  questId: 9003,
  currentMap: false,
  title: "Задание со стоимостью",
  level: 60,
  description: "Требуется оплата.",
  objectivesText: "Оплатить.",
  rewardMoney: -125,
});

/** A small header/child pair that exercises the stock reputation row shape. */
export const CANNED_REPUTATION: readonly FrameXmlFactionRow[] = Object.freeze([
  Object.freeze({
    listId: 0,
    name: "Alliance",
    description: "Alliance factions",
    // ReputationFrame indexes FACTION_BAR_COLORS[1..8] before checking isHeader.
    standingId: 4,
    barMin: 0,
    barMax: 3000,
    barValue: 0,
    canToggleAtWar: false,
    isHeader: true,
    isChild: false,
    hasRep: true,
  }),
  Object.freeze({
    listId: 1,
    name: "Stormwind",
    description: "Stormwind reputation",
    standingId: 5,
    barMin: 3000,
    barMax: 9000,
    barValue: 4500,
    canToggleAtWar: true,
    isHeader: false,
    isChild: true,
    hasRep: true,
  }),
]);

/** Two real-shaped skill rows plus a second heading for collapse/expand coverage. */
export const CANNED_SKILL_ROWS: readonly FrameXmlSkillRow[] = Object.freeze([
  Object.freeze({ kind: "header", id: 11, categoryId: 11, name: "Профессии" }),
  Object.freeze({
    kind: "skill", id: 164, skillId: 164, categoryId: 11, name: "Кузнечное дело",
    step: 3, skillRank: 412, numTempPoints: -5, skillModifier: 10, skillMaxRank: 450,
  }),
  Object.freeze({
    kind: "skill", id: 186, skillId: 186, categoryId: 11, name: "Горное дело",
    step: 2, skillRank: 180, numTempPoints: 0, skillModifier: -2, skillMaxRank: 225,
  }),
  Object.freeze({ kind: "header", id: 9, categoryId: 9, name: "Второстепенные" }),
  Object.freeze({
    kind: "skill", id: 129, skillId: 129, categoryId: 9, name: "Первая помощь",
    step: 1, skillRank: 75, numTempPoints: 0, skillModifier: 0, skillMaxRank: 150,
  }),
]);

/** A bounded pet unit used only by the canned FrameXML page; live pet identity comes from petSpells. */
export interface CannedPet {
  readonly name: string;
  readonly level: number;
  readonly className: string;
  readonly classToken: string;
  readonly raceName: string;
  readonly raceToken: string;
  readonly sex: number;
  readonly health: number;
  readonly healthMax: number;
  readonly power: number;
  readonly powerMax: number;
  readonly powerType: number;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly possessed: boolean;
  readonly happiness: number;
  readonly happinessDamage: number;
  readonly isHunterPet: boolean;
}

export const CANNED_PET: CannedPet = Object.freeze({
  name: "Боевой питомец",
  level: 60,
  className: "Охотник",
  classToken: "HUNTER",
  raceName: "Зверь",
  raceToken: "Beast",
  sex: 2,
  health: 1800,
  healthMax: 2000,
  power: 75,
  powerMax: 100,
  powerType: 3,
  connected: true,
  visible: true,
  possessed: false,
  happiness: 3,
  happinessDamage: 0,
  isHunterPet: true,
});

/** Four deterministic classic party slots; this fixture never pretends to be a raid roster. */
export interface CannedPartyMember {
  readonly name: string;
  readonly level: number;
  readonly className: string;
  readonly classToken: string;
  readonly raceName: string;
  readonly raceToken: string;
  readonly sex: number;
  readonly health: number;
  readonly healthMax: number;
  readonly power: number;
  readonly powerMax: number;
  readonly powerType: number;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly dead: boolean;
  readonly ghost: boolean;
}

export const CANNED_PARTY_MEMBERS: readonly CannedPartyMember[] = Object.freeze([
  Object.freeze({
    name: "Альфа", level: 60, className: "Воин", classToken: "WARRIOR", raceName: "Человек", raceToken: "Human",
    sex: 2, health: 3600, healthMax: 4000, power: 55, powerMax: 100, powerType: 1,
    connected: true, visible: true, dead: false, ghost: false,
  }),
  Object.freeze({
    name: "Бета", level: 58, className: "Жрец", classToken: "PRIEST", raceName: "Ночной эльф", raceToken: "NightElf",
    sex: 3, health: 2200, healthMax: 2800, power: 820, powerMax: 1000, powerType: 0,
    connected: true, visible: false, dead: false, ghost: false,
  }),
  Object.freeze({
    name: "Гамма", level: 59, className: "Разбойник", classToken: "ROGUE", raceName: "Гном", raceToken: "Gnome",
    sex: 2, health: 2500, healthMax: 3000, power: 75, powerMax: 100, powerType: 3,
    connected: true, visible: true, dead: false, ghost: false,
  }),
  Object.freeze({
    name: "Дельта", level: 60, className: "Шаман", classToken: "SHAMAN", raceName: "Орк", raceToken: "Orc",
    sex: 2, health: 0, healthMax: 0, power: 0, powerMax: 0, powerType: 0,
    connected: false, visible: false, dead: false, ghost: false,
  }),
]);

/**
 * The minimap's fixed world-label fixture.
 *
 * This is deliberately explicit demo data rather than a claim about the connected world. The live
 * seam returns nil until its host supplies the area's own metadata resolver; the canned page gets
 * one stable tuple so the four measured Minimap.lua queries can be exercised without a server.
 */
export const CANNED_MINIMAP_ZONE: FrameXmlMinimapZone = Object.freeze({
  minimapZoneText: "Элвиннский лес",
  zoneText: "Элвиннский лес",
  subZoneText: "Златоземье",
  pvpType: "friendly",
  isSubZonePvP: false,
  factionName: "Alliance",
});

/** Two real spell rows, one helpful and one harmful, used to exercise the stock aura tuple. */
export interface CannedAuraFixture {
  readonly spellId: number;
  readonly name: string;
  readonly rank: string;
  readonly texture: string;
  readonly count: number;
  readonly debuffType: string | undefined;
  /** Full duration in the `UnitAura`/`GetTime` seconds. */
  readonly duration: number;
  /** Fixed deadline offset from the attached pump's `GetTime` origin. */
  readonly expirationOffset: number;
  readonly unitCaster: string | undefined;
  readonly isStealable: boolean;
  readonly shouldConsolidate: boolean;
}

export const CANNED_AURA_FIXTURES: Readonly<{
  helpful: CannedAuraFixture;
  harmful: CannedAuraFixture;
}> = Object.freeze({
  helpful: Object.freeze({
    spellId: 6673,
    name: "Боевой крик",
    rank: "",
    texture: "Interface\\Icons\\Ability_Warrior_BattleShout",
    count: 2,
    debuffType: undefined,
    duration: 20,
    expirationOffset: 15,
    unitCaster: "player",
    isStealable: false,
    shouldConsolidate: false,
  }),
  harmful: Object.freeze({
    spellId: 772,
    name: "Кровопускание",
    rank: "",
    texture: "Interface\\Icons\\Ability_Gouge",
    count: 1,
    debuffType: undefined,
    duration: 10,
    expirationOffset: 8,
    unitCaster: "player",
    isStealable: false,
    shouldConsolidate: false,
  }),
});

/** A bounded pair on the selected target, kept separate from player aura state. */
export const CANNED_TARGET_AURA_FIXTURES: Readonly<{
  helpful: CannedAuraFixture;
  harmful: CannedAuraFixture;
}> = Object.freeze({
  helpful: Object.freeze({
    spellId: 6673,
    name: "Боевой крик",
    rank: "",
    texture: "Interface\\Icons\\Ability_Warrior_BattleShout",
    count: 1,
    debuffType: undefined,
    duration: 30,
    expirationOffset: 20,
    unitCaster: "player",
    isStealable: false,
    shouldConsolidate: false,
  }),
  harmful: Object.freeze({
    spellId: 172,
    name: "Порча",
    rank: "",
    texture: "Interface\\Icons\\Spell_Shadow_Abomination",
    count: 1,
    debuffType: undefined,
    duration: 10,
    expirationOffset: 8,
    unitCaster: "target",
    isStealable: false,
    shouldConsolidate: false,
  }),
});

/** One bounded harmful pet row so PetFrame's stock debuff loop has truthful canned data. */
export const CANNED_PET_AURA_FIXTURES: Readonly<{
  helpful: CannedAuraFixture;
  harmful: CannedAuraFixture;
}> = Object.freeze({
  helpful: Object.freeze({
    spellId: 6673,
    name: "Боевой крик",
    rank: "",
    texture: "Interface\\Icons\\Ability_Warrior_BattleShout",
    count: 1,
    debuffType: undefined,
    duration: 30,
    expirationOffset: 20,
    unitCaster: "player",
    isStealable: false,
    shouldConsolidate: false,
  }),
  harmful: Object.freeze({
    spellId: 172,
    name: "Порча",
    rank: "",
    texture: "Interface\\Icons\\Spell_Shadow_Abomination",
    count: 1,
    debuffType: undefined,
    duration: 10,
    expirationOffset: 8,
    unitCaster: "player",
    isStealable: false,
    shouldConsolidate: false,
  }),
});

/** A separate deterministic party1 aura pair for PartyMemberFrame's stock RefreshDebuffs path. */
export const CANNED_PARTY_AURA_FIXTURES: Readonly<{
  helpful: CannedAuraFixture;
  harmful: CannedAuraFixture;
}> = Object.freeze({
  helpful: Object.freeze({
    spellId: 6673,
    name: "Боевой крик",
    rank: "",
    texture: "Interface\\Icons\\Ability_Warrior_BattleShout",
    count: 1,
    debuffType: undefined,
    duration: 30,
    expirationOffset: 20,
    unitCaster: "player",
    isStealable: false,
    shouldConsolidate: false,
  }),
  harmful: Object.freeze({
    spellId: 772,
    name: "Кровопускание",
    rank: "",
    texture: "Interface\\Icons\\Ability_Gouge",
    count: 1,
    debuffType: undefined,
    duration: 10,
    expirationOffset: 8,
    unitCaster: "player",
    isStealable: false,
    shouldConsolidate: false,
  }),
});

/** A separate selected unit for the target-frame seam; it is never an alias of CANNED_PLAYER. */
export interface CannedTarget {
  readonly name: string;
  readonly level: number;
  readonly className: string;
  readonly classToken: string;
  readonly raceName: string;
  readonly raceToken: string;
  readonly sex: number;
  readonly health: number;
  readonly healthMax: number;
  readonly power: number;
  readonly powerMax: number;
  readonly powerType: number;
  readonly factionGroup: string;
  /** `UnitIsEnemy`/`UnitIsFriend`'s relation from player to target. */
  readonly reaction: -1 | 0 | 1;
  readonly classification: string;
  readonly isPlayer: boolean;
  readonly connected: boolean;
  readonly pvp: boolean;
  readonly pvpFreeForAll: boolean;
  readonly tapped: boolean;
  readonly tappedByPlayer: boolean;
  readonly tappedByAllThreatList: boolean;
}

/** One distinct target fixture, with values chosen to exercise the red target-frame branches. */
export const CANNED_TARGET: CannedTarget = Object.freeze({
  name: "Враждебный маг",
  level: 60,
  className: "Маг",
  classToken: "MAGE",
  raceName: "Орк",
  raceToken: "Orc",
  sex: 2,
  health: 3100,
  healthMax: 3100,
  power: 500,
  powerMax: 500,
  powerType: 0,
  factionGroup: "Horde",
  reaction: -1,
  classification: "normal",
  isPlayer: true,
  connected: true,
  pvp: true,
  pvpFreeForAll: false,
  tapped: false,
  tappedByPlayer: false,
  tappedByAllThreatList: false,
});

/** Separate deterministic identities for the client-owned focus and target-of-target slots. */
export const CANNED_FOCUS: CannedTarget = Object.freeze({
  name: "Фокус",
  level: 59,
  className: "Жрец",
  classToken: "PRIEST",
  raceName: "Ночной эльф",
  raceToken: "NightElf",
  sex: 3,
  health: 2500,
  healthMax: 3000,
  power: 800,
  powerMax: 1000,
  powerType: 0,
  factionGroup: "Alliance",
  reaction: 1,
  classification: "normal",
  isPlayer: true,
  connected: true,
  pvp: false,
  pvpFreeForAll: false,
  tapped: false,
  tappedByPlayer: false,
  tappedByAllThreatList: false,
});

export const CANNED_TARGET_TARGET: CannedTarget = Object.freeze({
  name: "Цель цели",
  level: 60,
  className: "Разбойник",
  classToken: "ROGUE",
  raceName: "Человек",
  raceToken: "Human",
  sex: 2,
  health: 1900,
  healthMax: 2400,
  power: 65,
  powerMax: 100,
  powerType: 3,
  factionGroup: "Alliance",
  reaction: 1,
  classification: "normal",
  isPlayer: true,
  connected: true,
  pvp: false,
  pvpFreeForAll: false,
  tapped: false,
  tappedByPlayer: false,
  tappedByAllThreatList: false,
});

/** The same deterministic aura rows are exposed on the extra unit slots when selected. */
export const CANNED_FOCUS_AURA_FIXTURES = CANNED_TARGET_AURA_FIXTURES;
export const CANNED_TARGET_TARGET_AURA_FIXTURES = CANNED_TARGET_AURA_FIXTURES;

const CANNED_TARGET_UPDATE_SECONDS = 0.5;
const CANNED_TARGET_LOSE_SECONDS = 1;
/** The target spellbar is active for the bounded selection fixture and is cleared on target loss. */
const CANNED_TARGET_CAST_DURATION_SECONDS = 2;

/** Spell 133, a real client spell row used as the deterministic cast-bar fixture. */
export const CANNED_CAST = Object.freeze({
  spellId: 133,
  name: "Огненный шар",
  rank: "Уровень 1",
  displayName: "Огненный шар",
  texture: "Interface\\Icons\\Spell_Fire_FlameBolt",
  castID: 42,
  isTradeSkill: false,
  notInterruptible: false,
});

/** Spell 689, a second real client spell row used as the deterministic channel fixture. */
export const CANNED_CHANNEL = Object.freeze({
  spellId: 689,
  name: "Похищение жизни",
  rank: "Уровень 1",
  displayName: "Похищение жизни",
  texture: "Interface\\Icons\\Spell_Shadow_LifeDrain02",
  isTradeSkill: false,
  notInterruptible: false,
});

// Exact DBC castTime for spell 133 (1500 ms); the timeline is still deterministic because its
// clock comes from the attached pump.
const CANNED_CAST_DURATION_SECONDS = 1.5;
const CANNED_CAST_DELAY_AT_SECONDS = 0.5;
const CANNED_CAST_DELAY_SECONDS = 0.25;
// Exact DBC duration for spell 689 (5000 ms); the update below adds a deterministic pushback.
const CANNED_CHANNEL_DURATION_SECONDS = 5;
const CANNED_CHANNEL_UPDATE_AT_SECONDS = 0.5;
const CANNED_CHANNEL_EXTENSION_SECONDS = 0.25;

/** A small player-only tree used by the standalone page and MPQ bridge tests. */
export const CANNED_TALENT_SNAPSHOT: FrameXmlTalentSnapshot = Object.freeze({
  classId: 8,
  activeTalentGroup: 1,
  activeSpec: 0,
  numTalentGroups: 1,
  unspentPoints: 3,
  groups: Object.freeze([Object.freeze({
    group: 1,
    spec: 0,
    active: true,
    unspentPoints: 3,
    tabs: Object.freeze([Object.freeze({
      index: 1,
      id: 10,
      name: "Огонь",
      iconId: 700,
      iconTexture: "Interface\\Icons\\Spell_Fire_FlameBolt",
      background: "MageFire",
      pointsSpent: 1,
      previewPointsSpent: 0,
      talents: Object.freeze([
        Object.freeze({
          index: 1,
          id: 100,
          name: "Огненный удар",
          iconTexture: "Interface\\Icons\\Spell_Fire_FlameBolt",
          iconId: undefined,
          tier: 1,
          column: 1,
          rank: 1,
          maxRank: 2,
          isExceptional: undefined,
          meetsPrereq: true,
          previewRank: undefined,
          meetsPreviewPrereq: undefined,
          prerequisites: Object.freeze([]),
          link: undefined,
        }),
        Object.freeze({
          index: 2,
          id: 101,
          name: "Поджог",
          iconTexture: "Interface\\Icons\\Spell_Fire_FlameBolt",
          iconId: undefined,
          tier: 2,
          column: 1,
          rank: 0,
          maxRank: 1,
          isExceptional: undefined,
          meetsPrereq: true,
          previewRank: undefined,
          meetsPreviewPrereq: undefined,
          prerequisites: Object.freeze([Object.freeze({
            talentId: 100,
            tier: 1,
            column: 1,
            requiredRank: 1,
            meetsPrereq: true,
            meetsPreviewPrereq: undefined,
          })]),
          link: undefined,
        }),
      ]),
    })]),
  })]),
});

/** Two stable lines make the standalone FrameXML page prove that chat events reach Lua. */
export const CANNED_CHAT_MESSAGES: readonly ChatMessage[] = Object.freeze([
  Object.freeze({
    type: CHAT_MSG_SAY,
    language: 7,
    senderGuid: 0x1n,
    senderName: CANNED_PLAYER.name,
    receiverGuid: 0n,
    receiverName: "",
    channel: "",
    text: "Привет из canned seam",
    tag: 0,
    achievementId: 0,
  }),
  Object.freeze({
    type: CHAT_MSG_SYSTEM,
    language: 0,
    senderGuid: 0n,
    senderName: "",
    receiverGuid: 0n,
    receiverName: "",
    channel: "",
    text: "Canned chat seam ready",
    tag: 0,
    achievementId: 0,
  }),
]);

/**
 * Two real tracking rows of this dataset for the stock MiniMapTracking menu, read from the local
 * gateway (`/dbc/spells?ids=2383,2580`) on 2026-09-24: both are SPELL_AURA_TRACK_RESOURCES (45)
 * with LockType 2 (herbalism) and 3 (mining).
 */
export const CANNED_TRACKING: readonly { readonly spellId: number; readonly name: string; readonly texture: string }[] =
  Object.freeze([
    Object.freeze({ spellId: 2383, name: "Поиск трав", texture: "Interface\\Icons\\INV_Misc_Flower_02" }),
    Object.freeze({ spellId: 2580, name: "Поиск минералов", texture: "Interface\\Icons\\Spell_Nature_Earthquake" }),
  ]);

/**
 * Deterministic `UnitGUID` strings, in the `frameXmlGuid` form. The player's is the canned SAY
 * line's sender (0x1), so chat `arg12` and `UnitGUID("player")` agree as they do live; the pet
 * carries the 3.3.5 pet high GUID (0xF140), creature-like units the creature one (0xF130).
 */
const CANNED_UNIT_GUIDS: Readonly<Record<string, string>> = Object.freeze({
  player: "0x0000000000000001",
  target: "0xf130000000000101",
  focus: "0xf130000000000102",
  targettarget: "0xf130000000000103",
  pet: "0xf140000000000104",
  party1: "0x0000000000000011",
  party2: "0x0000000000000012",
  party3: "0x0000000000000013",
  party4: "0x0000000000000014",
});

type CannedCastPhase = "idle" | "casting" | "channeling" | "done";
type CannedTargetPhase = "idle" | "acquire" | "acquired" | "updated" | "lost" | "manual";

interface RunningCooldown {
  /** `GetTime()` seconds. */
  start: number;
  duration: number;
}

function sameTuple(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
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

function sameCannedItem(
  left: CannedContainerItem | undefined,
  right: CannedContainerItem | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.entry === right.entry
    && left.texture === right.texture
    && left.count === right.count
    && left.locked === right.locked
    && left.quality === right.quality
    && left.readable === right.readable
    && left.broken === right.broken
    && left.link === right.link
    && (left.cooldown === undefined
      ? right.cooldown === undefined
      : right.cooldown !== undefined && sameTuple(left.cooldown, right.cooldown));
}

/**
 * The canned seam.
 *
 * It animates three small things: the player's health drifts, a clicked button goes on cooldown,
 * and the cast fixture moves through cast, pushback, channel update, and stop. They exist so that
 * a screenshot pair and a deterministic test can show the interface *doing* something rather than
 * standing still — the difference between «the widgets exist» and «the widgets work», which is the
 * whole of what F3 is for.
 */
export class CannedWorldSeam implements FrameXmlWorldSeam {
  /** GameTime's local clock and the stock calendar over a scripted month (FrameXmlCalendarCanned.ts). */
  readonly calendar = new CannedFrameXmlCalendar();
  /** One earth totem and one main-hand imbue from attach (FrameXmlHudMechanicsCanned.ts); tests script hits via `hit`. */
  readonly hudMechanics = new FrameXmlHudMechanicsCanned();
  /**
   * The canned player is alive: corpse and release pins are explicitly absent (`null`), which is
   * the answer WorldMapButton_OnUpdate needs to read `(0, 0)` instead of raising «corpseX nil»
   * once per frame (worldmapframe.lua:900; 60 raises in the canned census while the map was open).
   */
  readonly map = new FrameXmlMap({
    metadata: () => undefined, location: () => undefined,
    corpseLocation: () => null, deathReleaseLocation: () => null,
  });
  /**
   * The stock dungeon finder over a scripted world (FrameXmlLfdCanned.ts): a real slice of the
   * dataset's LFG catalog for the level-60 canned player. Tests script packets via `lfdWorld`.
   */
  readonly #cannedLfd = createCannedFrameXmlLfd({
    playerLevel: () => this.unitLevel("player") ?? 0,
    playerClassId: () => frameXmlStockClassId(this.#playerClass[1]),
    playerName: () => this.unitName("player"),
    playerGuid: () => FRAMEXML_CANNED_LFD_PLAYER_GUID,
    playerFaction: () => "Alliance",
    partyMemberCount: () => this.partyMemberCount(),
    raidMemberCount: () => this.raidMemberCount(),
    isPartyLeader: () => this.isPartyLeader(),
  });
  readonly lfd = this.#cannedLfd.model;
  readonly lfdWorld = this.#cannedLfd.world;
  /**
   * The NPC windows over scripted worlds (FrameXmlGossipCannedWindows.ts): an innkeeper's page, a
   * Stormwind flight master, a book and a plaque. Tests and the framexml.html
   * `?npc=gossip|confirm|bank|taxi|itemtext|plaque` previews script them via `npc`
   * (`npc.gossip.world.talk()`, `npc.taxi.world.open()`…).
   */
  readonly npc = createCannedFrameXmlNpcWindows({
    bankOpen: () => this.#bankOpen,
    buyBankSlot: () => this.buyBankSlot(),
    playerLevel: () => this.unitLevel("player"),
  });
  readonly gossip = this.npc.gossip.model;
  readonly bank = this.npc.bank;
  readonly taxi = this.npc.taxi.model;
  readonly itemText = this.npc.itemText.model;
  /** The charter windows over one scripted world (`npc.charters.world`, FrameXmlPetitionCanned.ts). */
  readonly tabard = this.npc.charters.tabard;
  readonly registrar = this.npc.charters.registrar;
  readonly petition = this.npc.charters.petition;
  /** The stock PetStableFrame over the canned stable master (`npc.stable.world`, FrameXmlStableCanned.ts). */
  readonly stable = this.npc.stable.model;
  /**
   * The stock loot window and group-loot rolls over a scripted world (FrameXmlLootCanned.ts): a
   * level-60 corpse and a two-item roll. Tests and the `?loot=` preview script packets via `lootWorld`.
   */
  readonly #cannedLoot = createCannedFrameXmlLoot({
    playerLevel: () => this.unitLevel("player") ?? 0,
    playSound: (name) => this.playSound(name),
  });
  readonly loot = this.#cannedLoot.model;
  readonly lootWorld = this.#cannedLoot.world;
  /**
   * The stock confirmations over a scripted world (FrameXmlPopupsCanned.ts): nothing is pending
   * until a test or `framexml.html?popup=` scripts an invite, a death, a summon or a ready check.
   */
  readonly #cannedPopups = createCannedFrameXmlPopups();
  readonly popups = this.#cannedPopups.model;
  readonly popupsWorld = this.#cannedPopups.world;
  /**
   * The stock FriendsFrame over a scripted world (FrameXmlFriendsCanned.ts): five friends, two
   * ignores, a guild the canned player leads, the canned party and two lockouts. Tests and the
   * `?friends=` preview script `/who` answers, status changes and group lists via `socialWorld`.
   */
  readonly #cannedFriends = createCannedFrameXmlFriends();
  readonly friends = this.#cannedFriends.model;
  readonly socialWorld = this.#cannedFriends.world;
  /**
   * The stock mailbox and trade window over scripted worlds (FrameXmlMailCanned.ts,
   * FrameXmlTradeCanned.ts): nothing is open until a test or `framexml.html?mail=`/`?trade=` calls
   * `mailWorld.open()` or `tradeWorld.open()`; both carry their own bags and cursor.
   */
  readonly #cannedMail = createCannedFrameXmlMail();
  readonly mail = this.#cannedMail.model;
  readonly mailWorld = this.#cannedMail.world;
  readonly #cannedTrade = createCannedFrameXmlTrade();
  readonly trade = this.#cannedTrade.model;
  readonly tradeWorld = this.#cannedTrade.world;
  /** The canned target's threat list (FrameXmlThreatCanned.ts); tests move `threatWorld.threat`. */
  readonly #cannedThreat = createCannedFrameXmlThreat({
    unitGuid: (unit) => this.unitGuid(unit),
    playerGuid: CANNED_UNIT_GUIDS["player"]!,
    targetGuid: CANNED_UNIT_GUIDS["target"]!,
    partyGuid: CANNED_UNIT_GUIDS["party1"]!,
    inGroup: () => this.partyMemberCount() > 0 || this.raidMemberCount() > 0,
  });
  readonly threat = this.#cannedThreat.model;
  readonly threatWorld = this.#cannedThreat.world;
  /** The chat cache's LOCKED/DOCKED/UNINTERACTABLE flags, per attach like `#chatWindowShown`. */
  readonly chatWindows = new FrameXmlChatWindowFlags();
  /** What the stock abandon confirmation removed (`AbandonQuest`): the row leaves the canned log. */
  readonly abandonedQuests: { slot: number; questId: number }[] = [];
  /** The stock quest log's abandon flow over the canned rows (FrameXmlQuestAbandon.ts). */
  readonly questAbandon = new FrameXmlQuestAbandonModel({
    selection: () => this.#questSelection,
    entry: (index) => {
      const quest = this.#questAt(index);
      return quest ? { slot: index - 1, questId: quest.questId } : undefined;
    },
    locate: (questId) => {
      const index = this.#questRows().findIndex((quest) => quest.questId === questId);
      return index < 0 ? undefined : { slot: index, questId };
    },
    title: (questId) => this.#quests.get(questId)?.title,
    questItems: (questId) => this.#quests.get(questId)?.itemObjectives?.map((objective) => objective.itemId) ?? [],
    carriedItems: () => {
      const entries = new Set<number>();
      for (const bag of this.#containers.values()) {
        for (const item of bag) if (item?.entry !== undefined) entries.add(item.entry);
      }
      return entries;
    },
    abandon: (entry) => {
      this.abandonedQuests.push(entry);
      this.#quests.delete(entry.questId);
      if (this.#questSelection > this.#questRows().length) this.#questSelection = 0;
      this.#pump?.fire(FRAMEXML_SEAM_EVENTS.questLogUpdate);
    },
  });
  /** No arena team, possession, scoreboard or add-on channel in the canned world: every answer is nil/false. */
  readonly mechanics = new FrameXmlMechanicsModel({ world: () => undefined, self: () => undefined });
  /** `HasFullControl` (FrameXmlControl.ts): the canned player holds the reins until `setControlLost`. */
  #controlLost = false;
  hasFullControl(): boolean { return !this.#controlLost; }
  /** A fear or a charm takes the character (true) or gives it back: PLAYER_CONTROL_LOST/GAINED; handlers run. */
  setControlLost(lost: boolean): number {
    if (lost === this.#controlLost) return 0;
    this.#controlLost = lost;
    return this.#pump?.fire(lost ? FRAMEXML_CONTROL_EVENTS.lost : FRAMEXML_CONTROL_EVENTS.gained) ?? 0;
  }
  /** What the unit menus' group commands sent (FrameXmlGroupCommands.ts): assistant, main tank/assist, AFK. */
  readonly assistantCalls: { guid: bigint; apply: boolean }[] = [];
  readonly assignments: { assignment: number; apply: boolean; guid: bigint }[] = [];
  readonly pvpAfkReports: bigint[] = [];
  /** The group commands over the canned social world's group (`socialWorld.groupList`), the player 0x42. */
  readonly groupCommands = new FrameXmlGroupCommandsModel({
    world: () => ({
      group: this.socialWorld.group, state: this.socialWorld.state, selfName: CANNED_PLAYER.name,
      setPartyAssistant: (guid, apply) => { this.assistantCalls.push({ guid, apply }); },
      assignPartyRole: (assignment, apply, guid) => { this.assignments.push({ assignment, apply, guid }); },
      reportPvpAfk: (guid) => { this.pvpAfkReports.push(guid); },
    }),
    unitGuid: (unit) => {
      const world = this.socialWorld;
      const members = world.group?.members ?? [];
      const party = /^party([1-4])$/.exec(unit);
      const raid = /^raid([1-9]\d?)$/.exec(unit);
      if (unit === "player") return world.state.selfGuid;
      if (party) return ((world.group?.groupType ?? 0) & 0x02) === 0 ? members[Number(party[1]) - 1]?.guid : undefined;
      if (raid) return Number(raid[1]) === members.length + 1 ? world.state.selfGuid : members[Number(raid[1]) - 1]?.guid;
      return undefined;
    },
  });
  /** `FocusUnit`/`ClearFocus` in turn, as the new focus's `UnitGUID` (undefined: cleared), and `/dismount`s. */
  readonly focusChanges: (string | undefined)[] = [];
  dismounts = 0;
  /**
   * Focus, assist, dismount and cancelform (FrameXmlTargetingApi.ts) over the canned units: the canned
   * target is the one unit the fixture's focus frame can hold; the canned units select nobody to assist.
   */
  readonly targeting: FrameXmlTargeting = {
    focusUnit: (unit) => {
      const token = unit === undefined || unit.trim() === "" ? "target" : unit.toLowerCase();
      this.focusChanges.push(this.unitGuid(token));
      if (token === "target") this.setFocus(this.#target);
    },
    // FocusFrame's PARTY_MEMBERS_CHANGED clears a focus that no longer exists (TargetFrame.lua:196-202):
    // with no focus that is no change.
    clearFocus: () => {
      if (this.#focus === undefined) return;
      this.focusChanges.push(undefined);
      this.setFocus(undefined);
    },
    assistUnit: () => {},
    dismount: () => { this.dismounts += 1; },
    cancelShapeshiftForm: () => {
      const form = this.#shapeshiftForms[this.#activeShapeshiftForm - 1];
      if (form) this.cancelledAuraSpellIds.push(form.spellId);
    },
  };
  /** Four known currencies of the dataset's tables (FrameXmlCurrencyCanned.ts); tests move `currencyWorld`. */
  readonly #cannedCurrency = createCannedFrameXmlCurrency();
  readonly currency = this.#cannedCurrency.model;
  readonly currencyWorld = this.#cannedCurrency.world;
  /**
   * The canned character's Blacksmithing and Enchanting (FrameXmlTradeSkillCanned.ts): no trade skill
   * is open until a test, an owner or `framexml.html?tradeskill=` opens a line.
   */
  readonly #cannedTradeSkill = createCannedFrameXmlTradeSkill();
  readonly tradeSkill = this.#cannedTradeSkill.model;
  readonly tradeSkillWorld = this.#cannedTradeSkill.world;
  /**
   * The stock auction house over a scripted world (FrameXmlAuctionCanned.ts): nothing is open until a
   * test or `framexml.html?auction=` calls `auctionWorld.open()`; it carries its own bags and cursor.
   */
  readonly #cannedAuction = createCannedFrameXmlAuction();
  readonly auction = this.#cannedAuction.model;
  readonly auctionWorld = this.#cannedAuction.world;
  /**
   * Stock socketing over a scripted head piece and four backpack gems (FrameXmlSocketCanned.ts):
   * nothing is open until a test or `framexml.html?socket=` calls SocketInventoryItem(1).
   */
  readonly #cannedSocket = createCannedFrameXmlSocket();
  readonly socket = this.#cannedSocket.model;
  readonly socketWorld = this.#cannedSocket.world;
  /**
   * Inspection of a friendly canned mage (FrameXmlInspectCanned.ts): answers only while
   * `setTarget(CANNED_INSPECT_TARGET)` holds her, her talents the canned fire tree.
   */
  readonly #cannedInspect = createCannedFrameXmlInspect(() => this.#target, () => this.#talentSnapshot);
  readonly inspect = this.#cannedInspect.model;
  readonly inspectWorld = this.#cannedInspect.world;
  /** A tauren barber chair (FrameXmlBarberCanned.ts): shut until a test or `?barber=` calls `barberWorld.sit()`. */
  readonly #cannedBarber = createCannedFrameXmlBarber();
  readonly barber = this.#cannedBarber.model;
  readonly barberWorld = this.#cannedBarber.world;
  /** Two filled sockets and a stand-in realm for the glyph tab (FrameXmlGlyphCanned.ts); `glyphWorld.use()` raises the cursor. */
  readonly #cannedGlyphs = createCannedFrameXmlGlyphs(() => this.unitLevel("player"));
  readonly glyphs = this.#cannedGlyphs.model;
  readonly glyphWorld = this.#cannedGlyphs.world;
  /**
   * Two mounts and one critter (FrameXmlCompanionsCanned.ts) for the pet page's «Спутники» and
   * «Транспорт» sub-tabs; `companionWorld` scripts learning, forgetting and the realm's summons.
   * A companion cast lands in `castSpellIds` like every other canned cast.
   */
  readonly #cannedCompanions = createCannedFrameXmlCompanions({
    pickup: (spellId, type, index) => this.cursor.pickupCompanion(spellId, type, index),
    onCast: (spellId) => { this.castSpellIds.push(spellId); },
  });
  readonly companions = this.#cannedCompanions.model;
  readonly companionWorld = this.#cannedCompanions.world;
  /**
   * The wolf's pet bar (FrameXmlPetActionBarCanned.ts), dismissed until `petActionWorld.summon()`:
   * the default HUD's measured layout has no pet bar in it; `petActionWorld.sent` records the presses.
   */
  readonly #cannedPetActions = createCannedFrameXmlPetActionBar();
  readonly petActions = this.#cannedPetActions.model;
  readonly petActionWorld = this.#cannedPetActions.world;
  /** Three known titles, «Рядовой» worn, over the canned warrior (FrameXmlTitlesCanned.ts); `titleWorld.sent` is CMSG_SET_TITLE. */
  readonly #cannedTitles = createCannedFrameXmlTitles(() => this.unitSex("player") === 3);
  readonly titles = this.#cannedTitles.model;
  readonly titleWorld = this.#cannedTitles.world;
  /** One saved set over the canned paper doll (FrameXmlEquipmentSetsCanned.ts); `equipmentSetWorld.sent` is the packets. */
  readonly #cannedEquipmentSets = createCannedFrameXmlEquipmentSets({
    wornEntry: (slot) => this.#equipmentItem(slot)?.entry,
    wornTexture: (slot) => this.inventoryItemTexture("player", slot),
    macroIcon: (index) => this.macros.icon(index),
    macroIconCount: () => this.macros.iconCount(),
  });
  readonly equipmentSets = this.#cannedEquipmentSets.model;
  readonly equipmentSetWorld = this.#cannedEquipmentSets.world;
  /** Every CMSG_UNLEARN_SKILL the canned realm was asked, by skill id (`AbandonSkill`). */
  readonly abandonedSkills: number[] = [];
  /**
   * The canned character's achievements (FrameXmlAchievementCanned.ts) over dataset catalog rows:
   * `achievementWorld.earn(id)` is an SMSG_ACHIEVEMENT_EARNED, `progress` an SMSG_CRITERIA_UPDATE.
   */
  readonly #cannedAchievements = createCannedFrameXmlAchievements();
  readonly achievement = this.#cannedAchievements.model;
  readonly achievementWorld = this.#cannedAchievements.world;
  /**
   * Three canned macros and six icons (FrameXmlMacroCanned.ts), and the real key table
   * (input/Bindings.ts) whose RunBinding verbs are recorded in `bindingRuns` instead of run.
   */
  readonly #cannedMacros = createCannedFrameXmlMacros();
  readonly macros = this.#cannedMacros.model;
  readonly macroWorld = this.#cannedMacros;
  #macroContext: MacroContext | undefined;
  /** Macro conditions over the canned answers (macro/MacroContext.ts); no world, so no mount or water. */
  macroContext(): MacroContext {
    return this.#macroContext ??= createMacroContext(frameXmlSeamMacroSource(this));
  }
  /** The one cursor (FrameXmlCursor.ts): spells from the book and actions lifted off the canned bar. */
  readonly cursor: FrameXmlCursorModel = new FrameXmlCursorModel(this);
  readonly bindingRuns: InputAction[] = [];
  readonly keyBindings = new FrameXmlBindingModel({ runAction: (action) => { this.bindingRuns.push(action); return true; } });
  /**
   * The canned guild's vault (FrameXmlGuildBankCanned.ts): nothing is open until a test or
   * `framexml.html?guildbank=` calls `guildBankWorld.open()`. Its icon picker reads the canned macro
   * icons; a vault stack dropped on a bag slot is recorded as the withdrawal into that slot.
   */
  readonly #cannedGuildBank = createCannedFrameXmlGuildBank({
    clearCursor: () => this.macros.clearCursor(),
    macroItemIcon: (index) => this.macros.itemIcon(index),
  });
  readonly guildBank = this.#cannedGuildBank.model;
  readonly guildBankWorld = this.#cannedGuildBank.world;
  /** The offline Elwynn snapshot has no active battlefield objectives. */
  readonly worldStates = new FrameXmlWorldStates(() => [], () => ({
    mapId: 0, zoneId: 12, areaId: 12, phaseMask: 1, states: new Map(),
  }));
  realmName(): string {
    return "Canned Realm";
  }

  /** The offline demonstration takes place at noon. */
  gameTime(): readonly [number, number] { return [12, 0]; }

  readonly name = "canned";
  readonly #actions = new Map<number, CannedAction>();
  /** The canned spellbook: the bar's spells as constructed (see the constructor). */
  readonly #spellbook: readonly CannedAction[];
  readonly #containers = new Map<number, (CannedContainerItem | undefined)[]>();
  readonly #equipment: (CannedContainerItem | undefined)[];
  readonly #quests = new Map<number, CannedQuest>();
  readonly #reputationRows: readonly FrameXmlFactionRow[];
  readonly #skillRows: readonly FrameXmlSkillRow[];
  readonly #honor: FrameXmlHonorSnapshot;
  readonly #battlegroundCatalog: FrameXmlBattlegroundCatalog = FRAMEXML_CANNED_BATTLEGROUNDS;
  #selectedBattleground = 1;
  /** Calls made by the stock queue page; useful to assert exact C-API routing in tests. */
  readonly battlegroundListRequests: { bgTypeId: number; fromWhere: number }[] = [];
  readonly battlegroundJoins: { bgTypeId: number; instanceId: number; asGroup: boolean }[] = [];
  /** Exact arena join tuples emitted by the stock `ArenaFrame` bridge. */
  readonly arenaJoins: {
    battlemasterGuid: bigint;
    arenaSlot: number;
    asGroup: boolean;
    rated: boolean;
  }[] = [];
  /** Test/dev hook for publishing the authoritative battlemaster list edge. */
  battlefieldList: BattlefieldList | undefined;
  #battlefieldListFresh = false;
  #arenaSeason = 0;
  #partyLeader = false;
  readonly #talentSnapshot: FrameXmlTalentSnapshot;
  readonly #merchant: CannedMerchant | undefined;
  #merchantOpen = false;
  readonly #trainer: CannedTrainer | undefined;
  #trainerOpen = false;
  #trainerSelection: number | undefined;
  readonly #trainerFilters = new Map<string, boolean>([
    ["available", true], ["unavailable", true], ["used", false],
  ]);
  /** Exact spell ids passed through the stock BuyTrainerService boundary. */
  readonly trainerBuyRequests: number[] = [];
  /** Exact stock requests, retained for bridge tests and the dev page. */
  readonly merchantBuyRequests: { slot: number; count: number }[] = [];
  readonly merchantBuybackRequests: number[] = [];
  readonly #collapsedSkillCategories = new Set<number>();
  #selectedSkillId: number | undefined;
  readonly #collapsedFactionIds = new Set<number>();
  /** Explicit UI overrides; absent entries retain the fixture's supplied server flags. */
  readonly #inactiveFactionOverrides = new Map<number, boolean>();
  readonly #atWarFactionOverrides = new Map<number, boolean>();
  #selectedFactionId: number | undefined;
  #watchedFactionId: number | undefined;
  #reputationSignature = "";
  /** Empty means native-compatible "watch every current quest". */
  readonly #initialUnwatchedQuestIds = new Set<number>();
  readonly #unwatchedQuestIds = new Set<number>();
  /** POI quests visible on the canned page's current map, in visible-index order. */
  readonly #currentMapQuestIds: number[] = [];
  readonly #containerMeta = new Map<number, {
    name: string | undefined;
    bagFamily: number | undefined;
    hostBagSlot: number;
    hostSlotOffset: number;
  }>();
  /** Calls made by the stock `UseContainerItem` bridge, including host-facing bag/slot numbers. */
  readonly usedContainerItems: { bag: number; slot: number }[] = [];
  /** Calls made by the stock `UseInventoryItem` bridge. */
  readonly usedInventoryItems: { unit: string; slot: number }[] = [];
  readonly #cooldowns = new Map<number, RunningCooldown>();
  readonly castSpellIds: number[] = [];
  readonly bankSlotBuyRequests: number[] = [];
  readonly #shapeshiftForms: CannedShapeshiftForm[] = [];
  #activeShapeshiftForm = 0;
  #comboPoints = 0;
  #bankSlotsBought = 0;
  #bankOpen = false;
  readonly #bankSlotPrices = new Map<number, number>();
  readonly #spellCvars = new Map<string, boolean>([["showallspellranks", false]]);
  readonly #settingsCVar: FrameXmlSettingsCVarAdapter | undefined;
  /** The options C API over the settings adapter a test or preview supplies (FrameXmlOptions.ts). */
  readonly options: FrameXmlOptionsModel | undefined;
  readonly #sendChatMessage: FrameXmlChatSender | undefined;
  #pump: FrameXmlSeamPump | undefined;
  #actionPage = 1;
  #healthMax = CANNED_PLAYER.healthMax;
  #health = CANNED_PLAYER.healthMax;
  #powerMax = CANNED_PLAYER.powerMax;
  #power = 0;
  #powerType = CANNED_PLAYER.powerType;
  #money = CANNED_PLAYER.money;
  #stats: readonly FrameXmlUnitStat[] = CANNED_PLAYER.stats;
  #resistances: readonly FrameXmlUnitStat[] = CANNED_PLAYER.resistances;
  #attackPower: FrameXmlUnitAttackPower = CANNED_PLAYER.attackPower;
  #rangedAttackPower: FrameXmlUnitAttackPower = CANNED_PLAYER.rangedAttackPower;
  #attackSpeed: readonly [number, number | undefined] = CANNED_PLAYER.attackSpeed;
  #damage: FrameXmlUnitDamage = CANNED_PLAYER.damage;
  #rangedDamage: FrameXmlUnitRangedDamage = CANNED_PLAYER.rangedDamage;
  #questSelection = 0;
  /** When the last health drift was published, in `GetTime()` seconds. */
  #healthAt = 0;
  #startedAt = 0;
  #castPhase: CannedCastPhase = "idle";
  #castTimelineStartedAt: number | undefined;
  #castStartedAt = 0;
  #castEndsAt = 0;
  #castDelayed = false;
  #channelStartedAt = 0;
  #channelEndsAt = 0;
  #channelUpdated = false;
  #target: CannedTarget | undefined;
  #focus: CannedTarget | undefined;
  #targetTarget: CannedTarget | undefined;
  #focusCasting = false;
  #targetTargetCasting = false;
  #targetPhase: CannedTargetPhase = "idle";
  #targetTimelineStartedAt: number | undefined;
  #targetCastPhase: CannedCastPhase = "done";
  #targetCastStartedAt = 0;
  #targetCastEndsAt = 0;
  #auraStartedAt = 0;
  /** Test-visible observation of the client request made by `CancelUnitBuff`. */
  readonly cancelledAuraSpellIds: number[] = [];
  #chatLineId = 0;
  /** The chat cache's SHOWN flags as the stock frames wrote them (`setChatWindowShown`); per attach. */
  readonly #chatWindowShown = new Map<number, boolean>();
  /** The chat cache's colours (FrameXmlChatColors.ts), raised at attach before the canned lines. */
  readonly chatColors = new FrameXmlChatColors();
  /** `tick` seconds of the last rendered frame and the newest frame intervals, for `GetFramerate`. */
  #frameAt: number | undefined;
  readonly #frameIntervals: number[] = [];
  /** Names requested by stock `PlaySound` while exercising the canned interface. */
  readonly playedSoundNames: string[] = [];
  /** The player's `UnitClass` pair; `setPlayerClass` swaps in a TSWoW class for tests. */
  #playerClass: readonly [string, string] = [CANNED_PLAYER.className, CANNED_PLAYER.classToken];
  /** Which known unit token `"mouseover"` currently aliases; undefined is «nothing under the cursor». */
  #mouseoverAlias: string | undefined;
  /** The one active canned tracker (a spell id of `CANNED_TRACKING`), mirrored by GetTrackingInfo. */
  #activeTracking: number | undefined;
  /** Exact `SetTracking` requests as spell casts (positive) and aura cancels (negative ids). */
  readonly trackingRequests: number[] = [];

  constructor(
    actions: readonly CannedAction[] = CANNED_ACTION_BAR,
    sendChatMessage?: FrameXmlChatSender,
    containers: readonly CannedContainer[] = CANNED_CONTAINERS,
    equipment: readonly (CannedContainerItem | undefined)[] = CANNED_EQUIPMENT,
    quests: readonly CannedQuest[] = CANNED_QUESTS,
    reputation: readonly FrameXmlFactionRow[] = CANNED_REPUTATION,
    skills: readonly FrameXmlSkillRow[] = CANNED_SKILL_ROWS,
    honor: FrameXmlHonorSnapshot = CANNED_HONOR,
    settingsCVar?: FrameXmlSettingsCVarAdapter,
    talentSnapshot: FrameXmlTalentSnapshot = CANNED_TALENT_SNAPSHOT,
    merchant: CannedMerchant | undefined = CANNED_MERCHANT,
    trainer: CannedTrainer | undefined = CANNED_TRAINER,
  ) {
    this.#equipment = [...equipment].slice(0, 23);
    while (this.#equipment.length < 23) this.#equipment.push(undefined);
    for (const action of actions) this.#actions.set(action.slot, action);
    // The book is the bar's spells as the page opens; moving a spell on the bar does not unlearn it.
    this.#spellbook = [...this.#actions.values()].filter((action) => action.kind === "spell")
      .sort((left, right) => left.slot - right.slot);
    for (const quest of quests) {
      if (Number.isInteger(quest.questId) && quest.questId > 0) {
        const copy: CannedQuest = quest.objectives && quest.itemObjectives
          ? { ...quest, objectives: [...quest.objectives], itemObjectives: [...quest.itemObjectives] }
          : quest.objectives
            ? { ...quest, objectives: [...quest.objectives] }
            : quest.itemObjectives
              ? { ...quest, itemObjectives: [...quest.itemObjectives] }
              : { ...quest };
        this.#quests.set(quest.questId, copy);
        if (quest.currentMap !== false && !this.#currentMapQuestIds.includes(quest.questId)) {
          this.#currentMapQuestIds.push(quest.questId);
        }
        if (quest.watched === false) this.#initialUnwatchedQuestIds.add(quest.questId);
      }
    }
    for (const questId of this.#initialUnwatchedQuestIds) this.#unwatchedQuestIds.add(questId);
    this.#reputationRows = reputation.filter(isResolvedFactionRow);
    this.#skillRows = skills.filter((row) => row.kind === "header" || row.kind === "skill");
    this.#honor = honor;
    this.#talentSnapshot = talentSnapshot;
    this.#merchant = merchant;
    this.#trainer = trainer;
    this.#settingsCVar = settingsCVar;
    this.options = settingsCVar ? createFrameXmlOptionsModel(settingsCVar) : undefined;
    for (const container of containers) {
      if (!Number.isInteger(container.id)) continue;
      this.#containers.set(container.id, [...container.slots]);
      this.#containerMeta.set(container.id, {
        name: container.name,
        bagFamily: container.bagFamily,
        hostBagSlot: container.hostBagSlot
          ?? (container.id === 0 || container.id === -2 ? 255 : 18 + container.id),
        hostSlotOffset: container.hostSlotOffset
          ?? (container.id === 0 ? 23 : container.id === -2 ? 86 : 0),
      });
    }
    this.#sendChatMessage = sendChatMessage;
  }

  attach(pump: FrameXmlSeamPump): void {
    if (this.#pump) this.detach();
    this.#pump = pump;
    // A new FrameXML load starts from the dock's default selection and a fresh frame clock.
    this.#chatWindowShown.clear();
    this.chatWindows.reset();
    this.#frameAt = undefined;
    this.#frameIntervals.length = 0;
    // The chat cache's colours before anything can print a line (FrameXmlChatColors.ts).
    this.chatColors.attach(pump);
    this.threat.attach(pump);
    this.mechanics.attach(pump);
    this.worldStates.attach(pump);
    this.map.attach(pump);
    this.lfd.attach(pump);
    this.npc.attach(pump);
    this.loot.attach(pump);
    this.popups.attach(pump);
    this.friends.attach(pump);
    this.mail.attach(pump);
    this.trade.attach(pump);
    this.currency.attach(pump);
    this.tradeSkill.attach(pump);
    this.auction.attach(pump);
    this.socket.attach(pump);
    this.inspect.attach(pump);
    this.barber.attach(pump);
    this.glyphs.attach(pump);
    this.companions.attach(pump);
    this.petActions.attach(pump);
    this.titles.attach(pump);
    this.equipmentSets.attach(pump);
    this.achievement.attach(pump);
    this.guildBank.attach(pump);
    this.macros.attach(pump);
    this.cursor.attach(pump);
    this.keyBindings.attach(pump);
    this.calendar.attach(pump);
    this.hudMechanics.attach(pump);
    const now = pump.now();
    this.#startedAt = now;
    this.#healthAt = now;
    this.#healthMax = CANNED_PLAYER.healthMax;
    this.#health = this.#healthMax;
    this.#powerMax = CANNED_PLAYER.powerMax;
    this.#power = 0;
    this.#powerType = CANNED_PLAYER.powerType;
    this.#money = CANNED_PLAYER.money;
    this.#activeShapeshiftForm = 0;
    this.#comboPoints = 0;
    this.#bankOpen = false;
    this.bankSlotBuyRequests.length = 0;
    this.#stats = CANNED_PLAYER.stats;
    this.#resistances = CANNED_PLAYER.resistances;
    this.#attackPower = CANNED_PLAYER.attackPower;
    this.#rangedAttackPower = CANNED_PLAYER.rangedAttackPower;
    this.#attackSpeed = CANNED_PLAYER.attackSpeed;
    this.#damage = CANNED_PLAYER.damage;
    this.#rangedDamage = CANNED_PLAYER.rangedDamage;
    this.#questSelection = 0;
    this.#selectedFactionId = undefined;
    this.#selectedBattleground = 1;
    this.battlefieldList = undefined;
    this.#battlefieldListFresh = false;
    this.#arenaSeason = 0;
    this.#partyLeader = false;
    this.arenaJoins.length = 0;
    this.#trainerOpen = false;
    this.#trainerSelection = undefined;
    this.#trainerFilters.set("available", true);
    this.#trainerFilters.set("unavailable", true);
    this.#trainerFilters.set("used", false);
    this.trainerBuyRequests.length = 0;
    this.#watchedFactionId = undefined;
    this.#collapsedFactionIds.clear();
    this.#inactiveFactionOverrides.clear();
    this.#atWarFactionOverrides.clear();
    this.#collapsedSkillCategories.clear();
    this.#selectedSkillId = undefined;
    this.#reputationSignature = "";
    this.#unwatchedQuestIds.clear();
    this.#currentMapQuestIds.length = 0;
    for (const quest of this.#quests.values()) {
      if (quest.currentMap !== false) this.#currentMapQuestIds.push(quest.questId);
    }
    for (const questId of this.#initialUnwatchedQuestIds) this.#unwatchedQuestIds.add(questId);
    this.#castPhase = "idle";
    this.#chatLineId = 0;
    // The first rendered tick is the timeline's origin. A slow XML/DOM mount must not cause a
    // freshly mounted cast bar to fast-forward through every transition before it can paint.
    this.#castTimelineStartedAt = undefined;
    this.#castStartedAt = 0;
    this.#castEndsAt = 0;
    this.#castDelayed = false;
    this.#channelStartedAt = 0;
    this.#channelEndsAt = 0;
    this.#channelUpdated = false;
    this.#target = undefined;
    this.#focus = undefined;
    this.#targetTarget = undefined;
    this.#focusCasting = false;
    this.#targetTargetCasting = false;
    this.#merchantOpen = false;
    this.merchantBuyRequests.length = 0;
    this.merchantBuybackRequests.length = 0;
    this.#targetPhase = "idle";
    this.#targetTimelineStartedAt = undefined;
    this.#targetCastPhase = "done";
    this.#targetCastStartedAt = 0;
    this.#targetCastEndsAt = 0;
    this.#auraStartedAt = now;
    this.cancelledAuraSpellIds.length = 0;
    this.castSpellIds.length = 0;
    this.#mouseoverAlias = undefined;
    this.#activeTracking = undefined;
    this.trackingRequests.length = 0;
    this.usedContainerItems.length = 0;
    this.usedInventoryItems.length = 0;
    // One slot is already recovering when the page opens, which is what the slice asks for: the
    // sweep has to be visible before anything has been clicked.
    const initial = [...this.#actions.values()].find((action) => action.recoveryMs === 60_000);
    if (initial) {
      this.#cooldowns.set(initial.slot, {
        start: now - CANNED_INITIAL_COOLDOWN_ELAPSED_SECONDS,
        duration: initial.recoveryMs / 1000,
      });
    }
    // The bar has to be told it changed at all: `ActionButton_Update` only registers its dozen
    // events once a slot answers `HasAction`, and at `OnLoad` this seam had not been attached.
    pump.fire(FRAMEXML_SEAM_EVENTS.actionSlotChanged, 0);
    pump.fire(FRAMEXML_SEAM_EVENTS.actionCooldown);
    // SpellBookFrame is loaded after the seam is attached. Seed the same two edges a real
    // INITIAL_SPELLS packet produces, while keeping the fixture's list deterministic.
    pump.fire(FRAMEXML_SEAM_EVENTS.spellsChanged);
    pump.fire(FRAMEXML_SEAM_EVENTS.spellUpdateCooldown);
    // HonorFrame has no OnShow handler; seed the same initial PvP edge that
    // PLAYER_ENTERING_WORLD/PLAYER_PVP_KILLS_CHANGED provides in the live client.
    pump.fire(FRAMEXML_SEAM_EVENTS.pvpKillsChanged);
    // ContainerFrame is mounted after the seam on the standalone page. This is the equivalent of
    // the server's initial BAG_UPDATE and deliberately names only containers in the fixture.
    for (const id of this.#containers.keys()) pump.fire(FRAMEXML_SEAM_EVENTS.bagUpdate, id);
    pump.fire(FRAMEXML_SEAM_EVENTS.health, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.maxHealth, "player");
    // UnitFrameManaBar_Initialize registers the type, current-power and max-power families.  Seed
    // the same three notifications a connected warrior receives so the real Lua path paints a
    // red, 0/100 rage bar before the first rendered frame.
    pump.fire(FRAMEXML_SEAM_EVENTS.unitDisplayPower, "player");
    pump.fire(FRAMEXML_POWER_EVENTS[this.#powerType] ?? "UNIT_MANA", "player");
    pump.fire(FRAMEXML_POWER_MAX_EVENTS[this.#powerType] ?? "UNIT_MAXMANA", "player");
    // BuffFrame is mounted after its XML OnLoad. One initial edge paints both fixture rows and
    // avoids relying on a packet that arrived before this seam was attached.
    pump.fire(FRAMEXML_SEAM_EVENTS.aura, "player");
    // PaperDollFrame is mounted after the seam. Seed each authoritative fixture group once, just
    // as the live seam does when the initial update-field snapshot is already present.
    pump.fire(FRAMEXML_SEAM_EVENTS.inventoryChanged, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.stats, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.resistances, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.attackPower, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.rangedAttackPower, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.attackSpeed, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.damage, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.rangedDamage, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.damageDoneMods, "player");
    pump.fire(FRAMEXML_SEAM_EVENTS.questLogUpdate);
    // Map-backed trackers refresh their local POI set on the same map update edge as the stock
    // client. This also lets WatchFrame apply its default local-zone filter on first paint.
    pump.fire(FRAMEXML_SEAM_EVENTS.worldMapUpdate);
    this.#publishReputationChanged(true);
    // PetFrame is also mounted after its OnLoad; this is the canned equivalent of the server's
    // initial PET_SPELLS/PET_BAR_CHANGED edge and lets the stock frame bind its pet unit once.
    pump.fire(FRAMEXML_SEAM_EVENTS.petChanged, "player");
    // PartyFrame is mounted after its OnLoad; seed its one supported non-raid roster exactly once.
    pump.fire(FRAMEXML_SEAM_EVENTS.partyMembers);
    // Configure the one supported chat frame before its deterministic seed reaches Lua.
    pump.fire(FRAMEXML_SEAM_EVENTS.chatWindowsUpdated);
    for (const message of CANNED_CHAT_MESSAGES) {
      const eventName = frameXmlChatEventName(message.type);
      if (eventName === undefined) continue;
      pump.fire(eventName, ...frameXmlChatEventArgs(message, message.senderName, ++this.#chatLineId));
    }
  }

  detach(): void {
    this.worldStates.detach();
    this.map.detach();
    this.lfd.detach();
    this.npc.detach();
    this.loot.detach();
    this.popups.detach();
    this.friends.detach();
    this.mail.detach();
    this.trade.detach();
    this.currency.detach();
    this.tradeSkill.detach();
    this.auction.detach();
    this.socket.detach();
    this.inspect.detach();
    this.barber.detach();
    this.glyphs.detach();
    this.companions.detach();
    this.petActions.detach();
    this.titles.detach();
    this.equipmentSets.detach();
    this.achievement.detach();
    this.guildBank.detach();
    this.macros.detach();
    this.cursor.detach();
    this.keyBindings.detach();
    this.calendar.detach();
    this.hudMechanics.detach();
    this.chatColors.detach();
    this.threat.detach();
    this.mechanics.detach();
    this.#pump = undefined;
    this.#merchantOpen = false;
    this.#cooldowns.clear();
    this.#castPhase = "done";
    this.#target = undefined;
    this.#focus = undefined;
    this.#targetTarget = undefined;
    this.#questSelection = 0;
    this.#selectedFactionId = undefined;
    this.#watchedFactionId = undefined;
    this.#collapsedFactionIds.clear();
    this.#inactiveFactionOverrides.clear();
    this.#atWarFactionOverrides.clear();
    this.#reputationSignature = "";
    this.#unwatchedQuestIds.clear();
    this.#focusCasting = false;
    this.#targetTargetCasting = false;
    this.#targetPhase = "lost";
    this.#targetTimelineStartedAt = undefined;
    this.#targetCastPhase = "done";
    this.#chatLineId = 0;
  }

  /** Canned pages have no world connection, but retain the same validated callback contract. */
  sendChatMessage(text: string, type: string, language: number | undefined, target: FrameXmlChatTarget): void {
    const code = frameXmlChatTypeCode(type);
    if (code === undefined || !frameXmlChatTextIsValid(text, code)) return;
    if (typeof target === "number" && (code !== CHAT_MSG_CHANNEL
      || !Number.isFinite(target) || !Number.isInteger(target))) return;
    const normalizedTarget = typeof target === "number"
      ? String(Math.trunc(target))
      : target;
    this.#sendChatMessage?.(text, code, language, normalizedTarget);
  }

  playSound(name: string): void {
    this.playedSoundNames.push(name);
  }

  chatWindowMessages(windowId: number): readonly string[] {
    return windowId === 1 ? FRAMEXML_CHAT_WINDOW_GROUPS : [];
  }

  chatWindowChannels(windowId: number): FrameXmlChatWindowChannels {
    return [];
  }

  chatWindowInfo(windowId: number): FrameXmlChatWindowInfo | undefined {
    if (!Number.isInteger(windowId) || windowId < 1 || windowId > 10) return undefined;
    // Window 2 is the live seam's combat tab, so the dev page and the canned probes dock the same two frames.
    const base: FrameXmlChatWindowInfo = windowId === 1 ? frameXmlGeneralWindowInfo(this.#chatWindowShown.get(1) ?? true)
      : windowId === 2 ? frameXmlCombatLogWindowInfo()
        : ["", 0, 1, 1, 1, 0, false, true, false, false];
    // Stock's own LOCKED/DOCKED/UNINTERACTABLE writes ride over the seam's answer (FrameXmlChatWindowFlags.ts).
    return this.chatWindows.apply(windowId, base, this.#chatWindowShown.get(windowId));
  }

  setChatWindowShown(windowId: number, shown: boolean): void {
    if (Number.isInteger(windowId) && windowId >= 1 && windowId <= 10) this.#chatWindowShown.set(windowId, shown);
  }

  /**
   * The canned page has no world renderer, so its rate is the one the HUD itself is drawn at: the
   * mean of the newest 60 intervals between rendered `tick`s (the mount's and the preview's
   * requestAnimationFrame step), 0 before the second frame.
   */
  framerate(): number {
    if (this.#frameIntervals.length === 0) return 0;
    const mean = this.#frameIntervals.reduce((sum, interval) => sum + interval, 0) / this.#frameIntervals.length;
    return mean > 0 ? 1 / mean : 0;
  }

  /**
   * Drift the health and retire finished cooldowns.
   *
   * Health is published at 4 Hz rather than per frame, because that is roughly how often the server
   * sends one — a value that changes sixty times a second is not «a moving bar», it is noise, and
   * `UNIT_HEALTH` is what the unit frames are written to react to.
   */
  tick(now: number): void {
    const pump = this.#pump;
    if (!pump) return;
    this.cursor.sync();
    if (this.#frameAt !== undefined && now > this.#frameAt) {
      this.#frameIntervals.push(now - this.#frameAt);
      if (this.#frameIntervals.length > 60) this.#frameIntervals.shift();
    }
    this.#frameAt = now;
    this.worldStates.tick();
    this.map.tick();
    this.keyBindings.tick(now);
    this.loot.tick();
    this.popups.tick();
    this.friends.tick();
    this.mail.tick();
    this.trade.tick();
    this.tradeSkill.tick();
    this.auction.tick();
    this.socket.tick();
    this.barber.tick();
    this.glyphs.tick();
    this.titles.tick();
    this.equipmentSets.tick();
    this.achievement.tick();
    this.guildBank.tick();
    this.hudMechanics.tick();
    for (const [slot, cooldown] of [...this.#cooldowns]) {
      if (now - cooldown.start < cooldown.duration) continue;
      this.#cooldowns.delete(slot);
      pump.fire(FRAMEXML_SEAM_EVENTS.actionCooldown);
      pump.fire(FRAMEXML_SEAM_EVENTS.actionUsable);
    }
    this.advanceTarget(now);
    this.advanceCast(now);
    if (now - this.#healthAt < 0.25) return;
    this.#healthAt = now;
    // A slow sine between 55% and 100%, so the bar is never full and never empty and the direction
    // of travel is visible in a screenshot pair. Twelve seconds a cycle.
    const phase = ((now - this.#startedAt) / 12) * Math.PI * 2;
    const affordable = this.#power >= CANNED_RAGE_COST;
    this.#health = Math.round(this.#healthMax * (0.775 + 0.225 * Math.sin(phase)));
    this.#power = Math.round(this.#powerMax * Math.max(0, Math.sin(phase / 2)));
    pump.fire(FRAMEXML_SEAM_EVENTS.health, "player");
    pump.fire(FRAMEXML_POWER_EVENTS[this.#powerType] ?? "UNIT_MANA", "player");
    // Only on the crossing: `ACTIONBAR_UPDATE_USABLE` re-tints twelve icons, and firing it four
    // times a second for a rage value nothing else reads would be the seam animating the host.
    if (affordable !== this.#power >= CANNED_RAGE_COST) {
      pump.fire(FRAMEXML_SEAM_EVENTS.actionUsable);
    }
  }

  /** Initial absent -> acquire -> update -> lose target timeline, each edge emitted once. */
  private advanceTarget(now: number): void {
    const pump = this.#pump;
    if (!pump || this.#targetPhase === "manual" || this.#targetPhase === "lost") return;
    if (this.#targetCastPhase === "casting" && now >= this.#targetCastEndsAt) {
      this.#targetCastPhase = "done";
      pump.fire(FRAMEXML_SEAM_EVENTS.castStop, ...this.targetCastEventArgs());
    }
    if (this.#targetPhase === "idle") {
      this.#targetTimelineStartedAt = now;
      // Keep the first rendered tick's existing cast/action ordering stable. The target frame
      // gets its first PLAYER_TARGET_CHANGED on the next tick, while the timeline still uses this
      // first tick as its origin (the same anchor rule as the cast fixture).
      this.#targetPhase = "acquire";
      return;
    }
    if (this.#targetPhase === "acquire") {
      this.#target = CANNED_TARGET;
      this.#targetPhase = "acquired";
      this.#targetCastPhase = "casting";
      this.#targetCastStartedAt = now;
      this.#targetCastEndsAt = now + CANNED_TARGET_CAST_DURATION_SECONDS;
      pump.fire(FRAMEXML_SEAM_EVENTS.targetChanged);
      return;
    }
    const startedAt = this.#targetTimelineStartedAt;
    if (startedAt === undefined) return;
    if (this.#targetPhase === "acquired" && now >= startedAt + CANNED_TARGET_UPDATE_SECONDS) {
      this.#target = Object.freeze({ ...CANNED_TARGET, health: Math.round(CANNED_TARGET.healthMax * 0.65) });
      this.#targetPhase = "updated";
      pump.fire(FRAMEXML_SEAM_EVENTS.health, "target");
      return;
    }
    if (this.#targetPhase === "updated" && now >= startedAt + CANNED_TARGET_LOSE_SECONDS) {
      this.#target = undefined;
      this.#targetPhase = "lost";
      this.#targetCastPhase = "done";
      if (this.#targetTarget !== undefined) {
        this.#targetTarget = undefined;
        this.#targetTargetCasting = false;
        pump.fire(FRAMEXML_SEAM_EVENTS.unitTarget, "target");
      }
      pump.fire(FRAMEXML_SEAM_EVENTS.targetChanged);
    }
  }

  private castEventArgs(): readonly unknown[] {
    return ["player", CANNED_CAST.name, CANNED_CAST.rank, CANNED_CAST.castID];
  }

  private targetCastEventArgs(): readonly unknown[] {
    return ["target", CANNED_CAST.name, CANNED_CAST.rank, CANNED_CAST.castID];
  }

  /** Advance the fixture's cast, pushback, channel update, and final stop exactly once each. */
  private advanceCast(now: number): void {
    const pump = this.#pump;
    if (!pump) return;

    if (this.#castPhase === "idle" && this.#castTimelineStartedAt === undefined) {
      this.#castTimelineStartedAt = now;
      this.#castPhase = "casting";
      this.#castStartedAt = this.#castTimelineStartedAt;
      this.#castEndsAt = this.#castStartedAt + CANNED_CAST_DURATION_SECONDS;
      pump.fire(FRAMEXML_SEAM_EVENTS.castStart, ...this.castEventArgs());
      return;
    }

    if (this.#castPhase === "casting") {
      if (!this.#castDelayed && now >= this.#castStartedAt + CANNED_CAST_DELAY_AT_SECONDS) {
        this.#castDelayed = true;
        this.#castEndsAt += CANNED_CAST_DELAY_SECONDS;
        pump.fire(FRAMEXML_SEAM_EVENTS.castDelayed, ...this.castEventArgs());
      }
      if (now >= this.#castEndsAt) {
        this.#castPhase = "channeling";
        this.#channelStartedAt = this.#castEndsAt;
        this.#channelEndsAt = this.#channelStartedAt + CANNED_CHANNEL_DURATION_SECONDS;
        pump.fire(FRAMEXML_SEAM_EVENTS.castStop, ...this.castEventArgs());
        pump.fire(FRAMEXML_SEAM_EVENTS.channelStart, "player");
      }
    }

    if (this.#castPhase !== "channeling") return;
    if (!this.#channelUpdated && now >= this.#channelStartedAt + CANNED_CHANNEL_UPDATE_AT_SECONDS) {
      this.#channelUpdated = true;
      this.#channelEndsAt += CANNED_CHANNEL_EXTENSION_SECONDS;
      pump.fire(FRAMEXML_SEAM_EVENTS.channelUpdate, "player");
    }
    if (now >= this.#channelEndsAt) {
      this.#castPhase = "done";
      pump.fire(FRAMEXML_SEAM_EVENTS.channelStop, "player");
    }
  }

  // ---- the action bar ----------------------------------------------------

  hasAction(slot: number): boolean {
    return this.#actions.has(slot);
  }

  actionTexture(slot: number): string | undefined {
    return this.#actions.get(slot)?.texture;
  }

  /** Only a macro has text, and none of the twelve is one. */
  actionText(): string | undefined {
    return undefined;
  }

  /** The stock tooltip consumes the action's id/name, never the 1-based slot as a spell id. */
  actionTooltip(slot: number) {
    const action = this.#actions.get(slot);
    if (!action) return undefined;
    return { kind: action.kind, id: action.id, name: action.name } as const;
  }

  actionCount(slot: number): number {
    return this.#actions.get(slot)?.count ?? 0;
  }

  actionCooldown(slot: number): readonly [number, number, number] {
    const cooldown = this.#cooldowns.get(slot);
    if (!cooldown) return [0, 0, 0];
    return [cooldown.start, cooldown.duration, 1];
  }

  /**
   * `isUsable, notEnoughMana` — and all three of `ActionButton_UpdateUsable`'s branches are
   * reachable on this page, which is the reason the canned rage moves at all.
   *
   * White is usable; the dark grey is a running cooldown; the blue tint is «not enough resource»,
   * which a warrior with no rage is in for half of each cycle. A seam that always answered
   * `true, false` would leave two of the three branches untested by the only page that can look
   * at them.
   */
  actionUsable(slot: number): readonly [boolean, boolean] {
    const action = this.#actions.get(slot);
    if (!action) return [false, false];
    if (this.#cooldowns.has(slot)) return [false, false];
    // Rage costs are canned: an ability with a range is a rage spender here, a shout or a potion
    // is not. The rage itself is the same drift the bar shows.
    if (action.kind === "spell" && action.rangeMax > 0 && this.#power < CANNED_RAGE_COST) {
      return [false, true];
    }
    return [true, false];
  }

  isConsumableAction(slot: number): boolean {
    return (this.#actions.get(slot)?.count ?? 0) > 0;
  }

  isStackableAction(slot: number): boolean {
    return (this.#actions.get(slot)?.count ?? 0) > 0;
  }

  isEquippedAction(): boolean {
    return false;
  }

  isCurrentAction(): boolean {
    return false;
  }

  isAttackAction(): boolean {
    return false;
  }

  isAutoRepeatAction(): boolean {
    return false;
  }

  /** In range for everything that has one; `undefined` for a self-cast, as the client answers. */
  actionInRange(slot: number): number | undefined {
    const action = this.#actions.get(slot);
    if (!action || action.rangeMax <= 0) return undefined;
    return 1;
  }

  actionBarPage(): number {
    return this.#actionPage;
  }

  changeActionBarPage(page: number): void {
    if (!Number.isInteger(page) || page < 1 || page > 6 || page === this.#actionPage) return;
    this.#actionPage = page;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.actionPageChanged);
  }

  bonusBarOffset(): number {
    return this.#shapeshiftForms[this.#activeShapeshiftForm - 1]?.bonusActionBarOffset ?? 0;
  }

  /**
   * The click. This is the whole vertical answering at once.
   *
   * To get here, `SecureActionButton_OnClick` had to read `type` off the button through the
   * three-argument `GetAttribute`, `SECURE_ACTIONS.action` had to run, and
   * `ActionButton_CalculateAction` had to resolve `actionpage` through `useparent-actionpage` onto
   * the bar. All of that is the corpus' own code; the only thing this seam does is start a
   * cooldown, so that the wipe on the button is proof the chain completed.
   */
  useAction(slot: number): void {
    // A press with a macro on the cursor puts it on the button (recorded in `macroWorld.placed`).
    if (this.macros.placeCursor(slot)) return;
    const action = this.#actions.get(slot);
    const pump = this.#pump;
    if (!action || !pump || this.#cooldowns.has(slot)) return;
    const duration = action.recoveryMs > 0
      ? action.recoveryMs / 1000
      : CANNED_CLICK_COOLDOWN_SECONDS;
    this.#cooldowns.set(slot, { start: pump.now(), duration });
    pump.fire(FRAMEXML_SEAM_EVENTS.actionCooldown);
    pump.fire(FRAMEXML_SEAM_EVENTS.actionUsable);
    pump.fire(FRAMEXML_SEAM_EVENTS.actionState);
  }

  /** The canned slot as the server word's two halves: spell 0x00, item 0x80 (`Player.h`). */
  actionButton(slot: number): FrameXmlActionButton | undefined {
    const action = this.#actions.get(slot);
    return action ? { action: action.id, type: action.kind === "item" ? ACTION_BUTTON_ITEM : ACTION_BUTTON_SPELL } : undefined;
  }

  /**
   * The canned bar's CMSG_SET_ACTION_BUTTON: nothing is sent, the fixture's slot changes. A spell
   * takes its book row, an item its row on the bar or in the bags; a macro stays with the canned
   * macro model's `placed` record (FrameXmlMacroCanned.ts), as before.
   */
  setActionButton(slot: number, action: number, type: number): boolean {
    if (!Number.isInteger(slot) || slot < 1 || slot > 144) return false;
    if (action === 0) {
      this.#actions.delete(slot);
      this.#cooldowns.delete(slot);
      return true;
    }
    let row: CannedAction | undefined;
    if (type === ACTION_BUTTON_SPELL) {
      row = this.#spellbook.find((spell) => spell.id === action);
    } else if (type === ACTION_BUTTON_ITEM) {
      row = [...this.#actions.values()].find((held) => held.kind === "item" && held.id === action);
      if (!row) {
        const texture = this.itemTexture(action);
        const name = this.itemInfo(action)?.[0];
        if (texture) row = { slot, id: action, kind: "item", name: name ?? "", iconId: 0, texture, recoveryMs: 0, rangeMax: 0 };
      }
    }
    if (!row) return false;
    this.#actions.set(slot, { ...row, slot });
    this.#cooldowns.delete(slot);
    return true;
  }

  spellBookSpellId(index: number, bookType: string | undefined): number | undefined {
    if (bookType !== undefined && bookType !== "spell") return undefined;
    return this.#spellAction(index)?.id;
  }

  /** A carried item's icon by entry, from the bar or the canned bags and equipment. */
  itemTexture(entry: number): string | undefined {
    const onBar = [...this.#actions.values()].find((held) => held.kind === "item" && held.id === entry);
    if (onBar) return onBar.texture;
    for (const bag of this.#containers.values()) {
      const item = bag.find((candidate) => candidate?.entry === entry);
      if (item?.texture) return item.texture;
    }
    return this.#equipment.find((item) => item?.entry === entry)?.texture;
  }

  // ---- player containers -----------------------------------------------

  #container(id: number): (CannedContainerItem | undefined)[] | undefined {
    return this.#containers.get(id);
  }

  containerNumSlots(bagId: number): number {
    return this.#container(bagId)?.length ?? 0;
  }

  containerNumFreeSlots(bagId: number): readonly [number, number | undefined] {
    const slots = this.#container(bagId);
    if (!slots) return [0, undefined];
    const free = slots.reduce((count, item) => count + (item === undefined ? 1 : 0), 0);
    return [free, this.#containerMeta.get(bagId)?.bagFamily];
  }

  containerItemInfo(bagId: number, slot: number): FrameXmlContainerItemInfo | undefined {
    if (!Number.isInteger(slot) || slot < 1) return undefined;
    const item = this.#container(bagId)?.[slot - 1];
    if (!item) return undefined;
    return [item.texture, item.count ?? 1, item.locked, item.quality, item.readable];
  }

  containerItemLink(bagId: number, slot: number): string | undefined {
    if (!Number.isInteger(slot) || slot < 1) return undefined;
    return this.#container(bagId)?.[slot - 1]?.link;
  }

  containerItemCooldown(bagId: number, slot: number): FrameXmlContainerItemCooldown {
    if (!Number.isInteger(slot) || slot < 1) return [0, 0, 0];
    return this.#container(bagId)?.[slot - 1]?.cooldown ?? [0, 0, 0];
  }

  bagName(bagId: number): string | undefined {
    return this.#containerMeta.get(bagId)?.name;
  }

  useContainerItem(bagId: number, slot: number): void {
    if (!Number.isInteger(slot) || slot < 1) return;
    const item = this.#container(bagId)?.[slot - 1];
    const meta = this.#containerMeta.get(bagId);
    if (!item || !meta) return;
    this.usedContainerItems.push({ bag: meta.hostBagSlot, slot: meta.hostSlotOffset + slot - 1 });
  }

  // ---- paper doll -------------------------------------------------------

  inventorySlotInfo(name: string): FrameXmlInventorySlotInfo | undefined {
    // Keep the structural table in the shared seam module so live and canned answers cannot drift.
    return frameXmlInventorySlotInfo(name);
  }

  #equipmentItem(slot: number): CannedContainerItem | undefined {
    return Number.isInteger(slot) && slot >= 1 && slot <= 23 ? this.#equipment[slot - 1] : undefined;
  }

  inventoryItemTexture(unit: string, slot: number): string | undefined {
    return unit === "player" ? this.#equipmentItem(slot)?.texture : undefined;
  }

  inventoryItemLink(unit: string, slot: number): string | undefined {
    return unit === "player" ? this.#equipmentItem(slot)?.link : undefined;
  }

  /** Item identity for the stock GameTooltip method; unlike GetInventoryItemInfo this is host-only. */
  inventoryItemTooltip(unit: string, slot: number): FrameXmlInventoryTooltipItem | undefined {
    if (unit !== "player") return undefined;
    const item = this.#equipmentItem(slot);
    if (!item?.entry || !Number.isSafeInteger(item.entry) || item.entry <= 0) return undefined;
    return {
      entry: item.entry,
      ...(item.name !== undefined ? { metadata: {
        entry: item.entry, name: item.name, displayId: 0, quality: item.quality ?? 0,
        inventoryType: 0, stackable: 0, iconId: 0,
      } } : {}),
      ...(item.count !== undefined ? { count: item.count } : {}),
    };
  }

  inventoryItemCount(unit: string, slot: number): number {
    return unit === "player" && this.#equipmentItem(slot) ? this.#equipmentItem(slot)?.count ?? 1 : 0;
  }

  inventoryItemBroken(unit: string, slot: number): boolean {
    return unit === "player" ? this.#equipmentItem(slot)?.broken === true : false;
  }

  inventoryItemCooldown(unit: string, slot: number): FrameXmlContainerItemCooldown {
    if (unit !== "player") return [0, 0, 0];
    return this.#equipmentItem(slot)?.cooldown ?? [0, 0, 0];
  }

  inventoryItemLocked(unit: string, slot: number): boolean {
    return unit === "player" ? this.#equipmentItem(slot)?.locked === true : false;
  }

  containerItemTooltip(bagId: number, slot: number): FrameXmlInventoryTooltipItem | undefined {
    if (!Number.isInteger(slot) || slot < 1) return undefined;
    const item = this.#container(bagId)?.[slot - 1];
    if (!item?.entry || !Number.isSafeInteger(item.entry) || item.entry <= 0) return undefined;
    return {
      entry: item.entry,
      ...(item.name !== undefined ? { metadata: {
        entry: item.entry, name: item.name, displayId: 0, quality: item.quality ?? 0,
        inventoryType: 0, stackable: 0, iconId: 0,
      } } : {}),
      ...(item.count !== undefined ? { count: item.count } : {}),
    };
  }

  /**
   * An item by entry for a link-shaped tooltip — SetHyperlink, SetLootItem, SetLootRollItem, the
   * mail and quest links — from the fixture that shows it: the loot world's templates, the
   * mailbox's items, a quest's reward rows. The merchant's own rows reach the tooltip through
   * itemInfo (GetItemInfo).
   */
  itemTooltip(entry: number): FrameXmlInventoryTooltipItem | undefined {
    const template = this.lootWorld.itemTemplates.get(entry);
    if (template) return { entry, template };
    let named: { readonly name: string; readonly quality?: number | undefined } | undefined = FRAMEXML_CANNED_MAIL_ITEMS.get(entry);
    for (const quest of this.#quests.values()) {
      if (named) break;
      named = [...quest.rewardItems ?? [], ...quest.rewardChoiceItems ?? []].find((item) => item.itemId === entry);
    }
    return named ? {
      entry,
      metadata: { entry, name: named.name, displayId: 0, quality: named.quality ?? 1, inventoryType: 0, stackable: 0, iconId: 0 },
    } : undefined;
  }

  useInventoryItem(unit: string, slot: number): void {
    if (unit !== "player" || !this.#equipmentItem(slot)) return;
    this.usedInventoryItems.push({ unit, slot });
  }

  // The fixture raises no bind prompt and holds no bag item, so the stock answers (FrameXmlItemActions.ts)
  // are the empty ones: nothing pending to send or drop, nothing held to store, split or wear.
  equipPendingItem(): void {}
  cancelPendingEquip(): void {}
  confirmBindOnUse(): void {}
  storeCursorItemInBag(): boolean { return false; }
  splitContainerItem(): boolean { return false; }
  cursorCanGoInSlot(): boolean { return false; }

  pickupInventoryItem(): void {
    // The fixture intentionally has no pickup operation, matching the live host's lack of one.
  }

  pickupContainerItem(bagId?: number, slot?: number): void {
    // The fixture has no authoritative inventory state to validate a cursor source against. A held
    // vault stack is the exception: it is withdrawn into the bag slot's wire position.
    const meta = bagId === undefined ? undefined : this.#containerMeta.get(bagId);
    if (meta && slot !== undefined && Number.isInteger(slot) && slot >= 1) {
      this.guildBank.dropOnBagSlot({ bag: meta.hostBagSlot, slot: meta.hostSlotOffset + slot - 1 });
    }
  }

  cursorHasItem(): boolean { return this.guildBank.cursorHasItem(); }
  cursorInfo(): readonly unknown[] { return this.macros.cursorInfo() ?? this.guildBank.cursorInfo() ?? []; }
  clearCursor(): void { this.macros.clearCursor(); this.guildBank.clearCursor(); }

  unitStat(unit: string, index: number): FrameXmlUnitStat {
    // Stock UnitStat is one-based; the fixture array follows generated STAT0..STAT4 order.
    const row = Number.isInteger(index) && index >= 1 && index <= this.#stats.length
      ? this.#stats[index - 1] : undefined;
    return unit === "player" ? row ?? [0, 0, 0, 0] : [0, 0, 0, 0];
  }

  unitResistance(unit: string, index: number): FrameXmlUnitStat {
    return unit === "player" && Number.isInteger(index) && index >= 0 && index < this.#resistances.length
      ? this.#resistances[index] ?? [0, 0, 0, 0] : [0, 0, 0, 0];
  }

  unitArmor(unit: string): FrameXmlUnitArmor {
    const [base, effective, positive, negative] = this.unitResistance(unit, 0);
    return [base, effective, base, positive, negative];
  }

  unitAttackPower(unit: string): FrameXmlUnitAttackPower {
    return unit === "player" ? this.#attackPower : [0, 0, 0];
  }

  unitRangedAttackPower(unit: string): FrameXmlUnitAttackPower {
    return unit === "player" ? this.#rangedAttackPower : [0, 0, 0];
  }

  attackPowerForStat(_statIndex: number, _statValue: number): number {
    // Canned totals are authoritative; no class formula is part of this fixture.
    return 0;
  }

  critChanceFromAgility(): number {
    return 0;
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

  combatRating(): number {
    return 0;
  }

  combatRatingBonus(): number {
    return 0;
  }

  armorPenetration(): number {
    return 0;
  }

  critChance(): number {
    return 0;
  }

  expertise(): readonly [number, number] {
    return [0, 0];
  }

  expertisePercent(): readonly [number, number] {
    return [0, 0];
  }

  unitAttackSpeed(unit: string): readonly [number, number | undefined] {
    return unit === "player" ? this.#attackSpeed : [1, undefined];
  }

  unitDamage(unit: string): FrameXmlUnitDamage {
    return unit === "player" ? this.#damage : [0, 0, 0, 0, 0, 0, 1];
  }

  unitRangedDamage(unit: string): FrameXmlUnitRangedDamage {
    return unit === "player" ? this.#rangedDamage : [1, 0, 0, 0, 0, 1];
  }

  // ---- quest log and tracker --------------------------------------------

  questGiverCall(): readonly unknown[] {
    // The canned world has quest-log fixtures, but no quest-giver packet page.
    return [];
  }

  #questRows(): CannedQuest[] {
    return [...this.#quests.values()];
  }

  #questAt(index: number): CannedQuest | undefined {
    return Number.isInteger(index) && index >= 1 ? this.#questRows()[index - 1] : undefined;
  }

  #questIndex(index: number | undefined): number {
    return index === undefined ? this.#questSelection : index;
  }

  questLogEntryCount(): readonly [number, number] {
    const count = this.#quests.size;
    return [count, count];
  }

  questLogTitle(index: number): FrameXmlQuestLogTitle {
    const quest = this.#questAt(index);
    if (!quest) return ["", 0, undefined, 0, false, false, undefined, false, 0, false];
    const state = quest.state ?? 0;
    const complete = (state & QUEST_STATE_FAIL) !== 0 ? -1
      : (state & QUEST_STATE_COMPLETE) !== 0 ? 1 : undefined;
    return [
      quest.title ?? "",
      quest.level ?? 0,
      quest.questTag,
      quest.suggestedGroup ?? 0,
      false,
      false,
      complete,
      quest.daily === true,
      quest.questId,
      false,
    ];
  }

  selectQuestLogEntry(index: number): void {
    if (index === 0) {
      this.#questSelection = 0;
      return;
    }
    this.#questSelection = this.#questAt(index) ? index : 0;
  }

  questLogSelection(): number {
    return this.#questSelection;
  }

  questLogQuestText(index?: number): readonly [string, string] | undefined {
    const quest = this.#questAt(this.#questIndex(index));
    if (!quest || quest.title === undefined) return undefined;
    return [quest.description ?? "", quest.objectivesText ?? ""];
  }

  questLogLeaderBoardCount(index?: number): number {
    const quest = this.#questAt(this.#questIndex(index));
    return (quest?.objectives?.length ?? 0) + (quest?.itemObjectives?.length ?? 0);
  }

  questLogLeaderBoard(objectiveIndex: number, questIndex?: number): FrameXmlQuestLogLeaderBoard | undefined {
    if (!Number.isInteger(objectiveIndex) || objectiveIndex < 1) return undefined;
    const quest = this.#questAt(this.#questIndex(questIndex));
    const regular = quest?.objectives ?? [];
    const objective = regular[objectiveIndex - 1];
    if (objective) {
      const type = objective.objectiveType ?? "monster";
      const progress = objective.have === undefined ? "" : `: ${objective.have}/${objective.need}`;
      return [`${objective.text}${progress}`, type,
        objective.have !== undefined && objective.have >= objective.need];
    }
    const item = quest?.itemObjectives?.[objectiveIndex - regular.length - 1];
    if (!item) return undefined;
    const progress = item.have === undefined ? "" : `: ${item.have}/${item.need}`;
    return [`Предмет ${item.itemId}${progress}`, "item",
      item.have !== undefined && item.have >= item.need];
  }

  #questRewardItemInfo(item: CannedQuestRewardItem | undefined): FrameXmlQuestItemInfo | undefined {
    if (!item || !Number.isInteger(item.itemId) || item.itemId <= 0
      || !Number.isInteger(item.count) || item.count <= 0 || typeof item.name !== "string") return undefined;
    return [item.name, item.texture, item.count, item.quality, item.isUsable];
  }

  #questReward(index: number | undefined): CannedQuest | undefined {
    return this.#questAt(this.#questIndex(index));
  }

  questLogRewardCount(index?: number): number {
    return this.#questReward(index)?.rewardItems?.length ?? 0;
  }

  questLogChoiceCount(index?: number): number {
    return this.#questReward(index)?.rewardChoiceItems?.length ?? 0;
  }

  questLogRewardInfo(itemIndex: number, questIndex?: number): FrameXmlQuestItemInfo | undefined {
    if (!Number.isInteger(itemIndex) || itemIndex < 1) return undefined;
    return this.#questRewardItemInfo(this.#questReward(questIndex)?.rewardItems?.[itemIndex - 1]);
  }

  questLogChoiceInfo(itemIndex: number, questIndex?: number): FrameXmlQuestItemInfo | undefined {
    if (!Number.isInteger(itemIndex) || itemIndex < 1) return undefined;
    return this.#questRewardItemInfo(this.#questReward(questIndex)?.rewardChoiceItems?.[itemIndex - 1]);
  }

  questLogRewardSpell(index?: number): FrameXmlQuestRewardSpell | undefined {
    const spell = this.#questReward(index)?.rewardDisplaySpell;
    if (!spell || !Number.isInteger(spell.spellId) || spell.spellId <= 0
      || typeof spell.texture !== "string" || typeof spell.name !== "string") return undefined;
    return [spell.texture, spell.name, spell.isTradeSkillSpell, spell.isSpellLearned];
  }

  questLogRewardMoney(index?: number): number {
    const value = this.#questReward(index)?.rewardMoney;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardHonor(index?: number): number {
    const value = this.#questReward(index)?.rewardHonor;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardArenaPoints(index?: number): number {
    const value = this.#questReward(index)?.rewardArenaPoints;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardTalents(index?: number): number {
    const value = this.#questReward(index)?.rewardTalents;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardXP(index?: number): number {
    const value = this.#questReward(index)?.rewardXP;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogRewardTitle(index?: number): string | undefined {
    const value = this.#questReward(index)?.rewardTitle;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  questLogRequiredMoney(index?: number): number {
    const quest = this.#questReward(index);
    const value = quest?.requiredMoney ?? (typeof quest?.rewardMoney === "number" && quest.rewardMoney < 0
      ? -quest.rewardMoney : 0);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  questLogTimeLeft(index?: number): number | undefined {
    const value = this.#questAt(this.#questIndex(index))?.timeLeft;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  questLogCompletionText(index?: number): string | undefined {
    const quest = this.#questAt(this.#questIndex(index));
    return quest?.title === undefined ? undefined : quest.completedText ?? "";
  }

  questLogGroupNum(index?: number): number {
    return this.#questAt(this.#questIndex(index))?.suggestedGroup ?? 0;
  }

  questLogCurrentFailed(): boolean {
    const state = this.#questAt(this.#questSelection)?.state ?? 0;
    return (state & QUEST_STATE_FAIL) !== 0;
  }

  questMapUpdateAllQuests(): number {
    return this.#currentMapQuestIds.length;
  }

  questPoiQuestIdByVisibleIndex(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    return this.#currentMapQuestIds[index - 1];
  }

  questNumWatches(): number {
    return this.#questRows().filter((quest) => !this.#unwatchedQuestIds.has(quest.questId)
      && quest.watched !== false).length;
  }

  questIndexForWatch(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    const rows = this.#questRows();
    let watched = 0;
    for (let row = 0; row < rows.length; row++) {
      const quest = rows[row];
      if (!quest || this.#unwatchedQuestIds.has(quest.questId) || quest.watched === false) continue;
      if (++watched === index) return row + 1;
    }
    return undefined;
  }

  questIsWatched(index: number): boolean {
    const quest = this.#questAt(index);
    return quest !== undefined && quest.watched !== false
      && !this.#unwatchedQuestIds.has(quest.questId);
  }

  addQuestWatch(index: number, _time?: number): void {
    const quest = this.#questAt(index);
    if (!quest || !this.#unwatchedQuestIds.delete(quest.questId)) return;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.questWatchUpdate, index);
  }

  removeQuestWatch(index: number): void {
    const quest = this.#questAt(index);
    if (!quest || this.#unwatchedQuestIds.has(quest.questId)) return;
    this.#unwatchedQuestIds.add(quest.questId);
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.questWatchUpdate, index);
  }

  // ---- reputation ------------------------------------------------------

  #visibleFactionRows(): readonly FrameXmlFactionRow[] {
    const visible: FrameXmlFactionRow[] = [];
    let collapsed = false;
    for (const row of this.#reputationRows) {
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
    if (this.#reputationRows.length > 0) {
      this.#pump?.fire(FRAMEXML_SEAM_EVENTS.reputationChanged);
    }
  }

  factionCount(): number {
    return this.#visibleFactionRows().length;
  }

  factionInfo(index: number): FrameXmlFactionInfo | undefined {
    const row = this.#factionAt(index);
    if (!row) return undefined;
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

  factionInfoById(): FrameXmlFactionInfo | undefined {
    // A fixture row's visible index does not establish its Faction.dbc ID.
    return undefined;
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
    const row = this.#reputationRows.find((candidate) => candidate.listId === this.#watchedFactionId);
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

  /** Test/dev hook: resolve a row's template and publish one quest-log edge. */
  setQuestTemplate(questId: number, template: Omit<CannedQuest, "questId">): number {
    const previous = this.#quests.get(questId);
    if (!previous) return 0;
    const next: CannedQuest = template.objectives && template.itemObjectives
      ? {
        ...previous, ...template, questId,
        objectives: [...template.objectives], itemObjectives: [...template.itemObjectives],
      }
      : template.objectives
        ? { ...previous, ...template, questId, objectives: [...template.objectives] }
        : template.itemObjectives
          ? { ...previous, ...template, questId, itemObjectives: [...template.itemObjectives] }
          : { ...previous, ...template, questId };
    if (JSON.stringify(previous) === JSON.stringify(next)) return 0;
    this.#quests.set(questId, next);
    if (next.watched === false) this.#unwatchedQuestIds.add(questId);
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.questLogUpdate) ?? 0;
  }

  /** Test/dev hook: advance one objective and publish the stock tracker and log edges once. */
  setQuestObjective(questId: number, objectiveIndex: number, have: number | undefined): number {
    const quest = this.#quests.get(questId);
    const objectives = quest?.objectives;
    if (!quest || !objectives || !Number.isInteger(objectiveIndex) || objectiveIndex < 1
      || objectiveIndex > objectives.length) return 0;
    const previous = objectives[objectiveIndex - 1];
    if (previous?.have === have) return 0;
    const nextObjectives = objectives.map((objective, index) => {
      if (index !== objectiveIndex - 1) return objective;
      if (have === undefined) {
        const { have: _previousHave, ...withoutHave } = objective;
        return withoutHave;
      }
      return { ...objective, have };
    });
    this.#quests.set(questId, { ...quest, objectives: nextObjectives });
    const pump = this.#pump;
    if (!pump) return 0;
    let fired = 0;
    const row = this.#questRows().findIndex((entry) => entry.questId === questId);
    if (row >= 0) fired += pump.fire(FRAMEXML_SEAM_EVENTS.questWatchUpdate, row + 1);
    fired += pump.fire(FRAMEXML_SEAM_EVENTS.questLogUpdate);
    return fired;
  }

  /** Test/dev hook: replace one equipment or carried-bag row and publish one deduplicated edge. */
  setInventoryItem(slot: number, item: CannedContainerItem | undefined): number {
    if (!Number.isInteger(slot) || slot < 1 || slot > 23 || sameCannedItem(this.#equipment[slot - 1], item)) return 0;
    this.#equipment[slot - 1] = item;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.inventoryChanged, "player") ?? 0;
  }

  setPlayerStat(index: number, value: FrameXmlUnitStat): number {
    const rowIndex = index - 1;
    if (!Number.isInteger(index) || rowIndex < 0 || rowIndex >= 5 || sameTuple(this.#stats[rowIndex], value)) return 0;
    this.#stats = this.#stats.map((row, currentIndex) => currentIndex === rowIndex ? value : row);
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.stats, "player") ?? 0;
  }

  setPlayerResistance(index: number, value: FrameXmlUnitStat): number {
    if (!Number.isInteger(index) || index < 0 || index >= 7 || sameTuple(this.#resistances[index], value)) return 0;
    this.#resistances = this.#resistances.map((row, rowIndex) => rowIndex === index ? value : row);
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.resistances, "player") ?? 0;
  }

  setPlayerAttackPower(value: FrameXmlUnitAttackPower): number {
    if (sameTuple(this.#attackPower, value)) return 0;
    this.#attackPower = value;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.attackPower, "player") ?? 0;
  }

  setPlayerRangedAttackPower(value: FrameXmlUnitAttackPower): number {
    if (sameTuple(this.#rangedAttackPower, value)) return 0;
    this.#rangedAttackPower = value;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.rangedAttackPower, "player") ?? 0;
  }

  setPlayerAttackSpeed(value: readonly [number, number | undefined]): number {
    if (sameTuple(this.#attackSpeed, value)) return 0;
    this.#attackSpeed = value;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.attackSpeed, "player") ?? 0;
  }

  setPlayerDamage(value: FrameXmlUnitDamage): number {
    if (sameTuple(this.#damage, value)) return 0;
    this.#damage = value;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.damage, "player") ?? 0;
  }

  setPlayerRangedDamage(value: FrameXmlUnitRangedDamage): number {
    if (sameTuple(this.#rangedDamage, value)) return 0;
    this.#rangedDamage = value;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.rangedDamage, "player") ?? 0;
  }

  /** Test/dev hook for a supported fixture; invalid or unsupported writes remain no-ops. */
  setContainerItem(bagId: number, slot: number, item: CannedContainerItem | undefined): number {
    if (!Number.isInteger(slot) || slot < 1) return 0;
    const slots = this.#container(bagId);
    if (!slots || slot > slots.length || slots[slot - 1] === item) return 0;
    slots[slot - 1] = item;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.bagUpdate, bagId) ?? 0;
  }

  // ---- the player --------------------------------------------------------

  /**
   * Controlled fixture updates for the same notifications the live seam will eventually publish.
   * Returning the number of handlers is useful to assert that an unchanged value stays quiet.
   */
  setPlayerHealth(value: number): number {
    const next = Math.max(0, Math.min(this.#healthMax, Number.isFinite(value) ? value : this.#health));
    if (next === this.#health) return 0;
    this.#health = next;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.health, "player") ?? 0;
  }

  setPlayerHealthMax(value: number): number {
    const next = Math.max(0, Number.isFinite(value) ? value : this.#healthMax);
    if (next === this.#healthMax) return 0;
    this.#healthMax = next;
    if (this.#health > next) this.#health = next;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.maxHealth, "player") ?? 0;
  }

  setPlayerPower(value: number): number {
    const next = Math.max(0, Math.min(this.#powerMax, Number.isFinite(value) ? value : this.#power));
    if (next === this.#power) return 0;
    this.#power = next;
    return this.#pump?.fire(FRAMEXML_POWER_EVENTS[this.#powerType] ?? "UNIT_MANA", "player") ?? 0;
  }

  setPlayerPowerMax(value: number): number {
    const next = Math.max(0, Number.isFinite(value) ? value : this.#powerMax);
    if (next === this.#powerMax) return 0;
    this.#powerMax = next;
    if (this.#power > next) this.#power = next;
    return this.#pump?.fire(FRAMEXML_POWER_MAX_EVENTS[this.#powerType] ?? "UNIT_MAXMANA", "player") ?? 0;
  }

  setPlayerMoney(value: number): number {
    const next = Math.max(0, Number.isFinite(value) ? Math.trunc(value) : this.#money);
    if (next === this.#money) return 0;
    this.#money = next;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.playerMoney) ?? 0;
  }

  setPlayerPowerType(value: number): number {
    const next = Math.trunc(value);
    if (!Number.isInteger(next) || next < 0 || next >= FRAMEXML_POWER_TOKENS.length) return 0;
    if (next === this.#powerType) return 0;
    this.#powerType = next;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.unitDisplayPower, "player") ?? 0;
  }

  /** Override the deterministic target fixture; passing the same identity is silent. */
  setTarget(target: CannedTarget | undefined): number {
    const previous = this.#target;
    if (previous === target) return 0;
    this.#targetTimelineStartedAt = undefined;
    this.#targetPhase = target === undefined ? "lost" : "manual";
    this.#target = target;
    this.#comboPoints = 0;
    if (target === undefined || previous !== undefined && previous !== target) {
      this.#targetTarget = undefined;
      this.#targetTargetCasting = false;
    }
    if (target === undefined) {
      this.#targetCastPhase = "done";
    } else {
      const now = this.#pump?.now();
      if (now === undefined) {
        this.#targetCastPhase = "done";
      } else {
        this.#targetCastPhase = "casting";
        this.#targetCastStartedAt = now;
        this.#targetCastEndsAt = now + CANNED_TARGET_CAST_DURATION_SECONDS;
      }
    }
    if (previous === undefined && target === undefined) return 0;
    if (previous !== undefined && target !== undefined) {
      // The canned fixture has no wire GUID, so object identity is its only target identity. A
      // different object is a selection edge even when its fields happen to match.
      return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.targetChanged) ?? 0;
    }
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.targetChanged) ?? 0;
  }

  /** Override the deterministic focus fixture; passing the same identity is silent. */
  setFocus(focus: CannedTarget | undefined): number {
    if (focus === this.#focus) return 0;
    this.#focus = focus;
    this.#focusCasting = false;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.focusChanged) ?? 0;
  }

  /** Override the target-of-target fixture while a selected target exists. */
  setTargetTarget(targetTarget: CannedTarget | undefined): number {
    if (!this.#target || targetTarget === this.#targetTarget) return 0;
    this.#targetTarget = targetTarget;
    this.#targetTargetCasting = false;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.unitTarget, "target") ?? 0;
  }

  /** Start/stop the deterministic focus cast without exposing it after focus is lost. */
  setFocusCast(active: boolean): number {
    if (!this.#focus || active === this.#focusCasting) return 0;
    this.#focusCasting = active;
    const event = active ? FRAMEXML_SEAM_EVENTS.castStart : FRAMEXML_SEAM_EVENTS.castStop;
    return this.#pump?.fire(event, "focus", CANNED_CAST.name, CANNED_CAST.rank, CANNED_CAST.castID) ?? 0;
  }

  /** Start/stop the deterministic target-of-target cast without leaking a stale identity. */
  setTargetTargetCast(active: boolean): number {
    if (!this.#targetTarget || active === this.#targetTargetCasting) return 0;
    this.#targetTargetCasting = active;
    const event = active ? FRAMEXML_SEAM_EVENTS.castStart : FRAMEXML_SEAM_EVENTS.castStop;
    return this.#pump?.fire(event, "targettarget", CANNED_CAST.name, CANNED_CAST.rank, CANNED_CAST.castID) ?? 0;
  }

  setTargetHealth(value: number): number {
    const target = this.#target;
    if (!target) return 0;
    const next = Math.max(0, Math.min(target.healthMax, Number.isFinite(value) ? value : target.health));
    if (next === target.health) return 0;
    this.#target = Object.freeze({ ...target, health: next });
    this.#targetPhase = "manual";
    this.#targetTimelineStartedAt = undefined;
    return this.#pump?.fire(FRAMEXML_SEAM_EVENTS.health, "target") ?? 0;
  }

  /**
   * Point the `"mouseover"` token at one of the fixture's units (or at nothing), the canned
   * equivalent of a settled world pick. A unit fires UPDATE_MOUSEOVER_UNIT like the live seam;
   * leaving every unit does not. Returns how many handlers ran.
   */
  setMouseover(unit: string | undefined): number {
    const alias = unit === undefined || unit === "mouseover" ? undefined : unit.toLowerCase();
    if (alias === this.#mouseoverAlias) return 0;
    this.#mouseoverAlias = alias;
    return alias !== undefined && this.knownUnit(alias) !== undefined
      ? this.#pump?.fire(FRAMEXML_SEAM_EVENTS.mouseover) ?? 0
      : 0;
  }

  /**
   * Give the canned player another class, e.g. the owner's TSWoW `("Герой", "HERO")` (class 13 on
   * this dataset). Set it before the boot so VARIABLES_LOADED already sees it.
   */
  setPlayerClass(className: string, classToken: string): void {
    this.#playerClass = [className, classToken];
  }

  /** `"mouseover"` is only ever an alias of a fixture token. */
  #alias(unit: string): string {
    return unit === "mouseover" ? this.#mouseoverAlias ?? "" : unit;
  }

  /** The target frame has the player and one selected target in this fixture. */
  private isPlayer(unit: string): boolean {
    return this.#alias(unit) === "player";
  }

  private target(unit: string): CannedTarget | undefined {
    return this.#alias(unit) === "target" ? this.#target : undefined;
  }

  private focus(unit: string): CannedTarget | undefined {
    return this.#alias(unit) === "focus" ? this.#focus : undefined;
  }

  private targetTarget(unit: string): CannedTarget | undefined {
    return this.#alias(unit) === "targettarget" ? this.#targetTarget : undefined;
  }

  private pet(unit: string): CannedPet | undefined {
    return this.#alias(unit) === "pet" ? CANNED_PET : undefined;
  }

  private party(unit: string): CannedPartyMember | undefined {
    const match = /^party([1-4])$/.exec(this.#alias(unit));
    if (!match) return undefined;
    return CANNED_PARTY_MEMBERS[Number(match[1]) - 1];
  }

  /** `UnitGUID` for every unit the fixture can name, `mouseover` through its alias. */
  unitGuid(unit: string): string | undefined {
    // The player's own raid token, last in the canned raid (raidMemberCount).
    const raid = this.raidMemberCount();
    if (raid > 0 && this.#alias(unit) === `raid${raid}`) return CANNED_UNIT_GUIDS["player"];
    if (this.knownUnit(unit) === undefined) return undefined;
    return CANNED_UNIT_GUIDS[this.#alias(unit)];
  }

  /** `UnitReaction` from the fixture's own -1/0/1 relation. */
  unitReaction(left: string, right: string): number | undefined {
    const reaction = this.reaction(left, right);
    return reaction === -1 ? 2 : reaction === 0 ? 4 : reaction === 1 ? 5 : undefined;
  }

  // ---- minimap indicators and languages --------------------------------

  trackingCount(): number {
    return CANNED_TRACKING.length;
  }

  trackingInfo(index: number): readonly [string, string, boolean, string] | undefined {
    const row = CANNED_TRACKING[index - 1];
    return row ? [row.name, row.texture, row.spellId === this.#activeTracking, "spell"] : undefined;
  }

  trackingTexture(): string {
    return CANNED_TRACKING.find((row) => row.spellId === this.#activeTracking)?.texture
      ?? FRAMEXML_TRACKING_NONE_TEXTURE;
  }

  /** Toggle one canned tracker, or clear it for `nil`; the stock button redraws on the event. */
  setTracking(index: number | undefined): void {
    const row = index === undefined ? undefined : CANNED_TRACKING[index - 1];
    if (index !== undefined && !row) return;
    const next = row === undefined || row.spellId === this.#activeTracking ? undefined : row.spellId;
    if (this.#activeTracking !== undefined) this.trackingRequests.push(-this.#activeTracking);
    if (next !== undefined) this.trackingRequests.push(next);
    if (next === this.#activeTracking) return;
    this.#activeTracking = next;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.tracking);
  }

  /** The canned mailbox is empty. */
  hasNewMail(): boolean {
    return false;
  }

  latestMailSenders(): readonly string[] {
    return [];
  }

  /** The canned player is Human (`ChrRaces.BaseLanguage` 7, «всеобщий» in ruRU). */
  defaultLanguage(): string {
    return frameXmlLanguageName(7);
  }

  languages(): readonly string[] {
    return [frameXmlLanguageName(7)];
  }

  private knownUnit(unit: string): CannedPlayer | CannedTarget | CannedPet | CannedPartyMember | undefined {
    if (this.isPlayer(unit)) return CANNED_PLAYER;
    return this.target(unit) ?? this.focus(unit) ?? this.targetTarget(unit) ?? this.pet(unit) ?? this.party(unit);
  }

  unitExists(unit: string): boolean {
    if (unit.toLowerCase() === "npc") return (this.#merchantOpen && this.#merchant !== undefined)
      || (this.#trainerOpen && this.#trainer !== undefined)
      || this.trade.partnerName() !== undefined
      // The canned innkeeper, flight master and banker are creatures (FrameXmlGossipCannedWindows).
      || this.npc.npcName() !== undefined;
    return this.knownUnit(unit) !== undefined;
  }

  unitName(unit: string): string | undefined {
    if (unit.toLowerCase() === "npc" && this.trade.partnerName() !== undefined) return this.trade.partnerName();
    if (unit.toLowerCase() === "npc") return this.#merchantOpen ? this.#merchant?.name
      : this.#trainerOpen ? this.#trainer?.name : this.npc.npcName();
    return this.knownUnit(unit)?.name;
  }

  questNpcPortraitGuid(): bigint | undefined {
    return undefined;
  }

  unitPvpName(unit: string): string | undefined {
    // The worn canned title around the player's name («Рядовой Игрок»); every other known unit
    // is its bare name rather than nil, which CharacterFrame would print as a literal "nil".
    const name = this.unitName(unit);
    if (name === undefined) return undefined;
    return this.isPlayer(unit)
      ? this.titles.displayName(name, { chosen: this.titleWorld.chosen(), female: this.unitSex(unit) === 3 })
      : name;
  }

  unitLevel(unit: string): number | undefined {
    return this.knownUnit(unit)?.level;
  }

  unitClass(unit: string): readonly [string, string] | undefined {
    if (this.isPlayer(unit)) return this.#playerClass;
    const known = this.knownUnit(unit);
    return known ? [known.className, known.classToken] : undefined;
  }

  unitRace(unit: string): readonly [string, string] | undefined {
    const known = this.knownUnit(unit);
    return known ? [known.raceName, known.raceToken] : undefined;
  }

  unitSex(unit: string): number | undefined {
    return this.knownUnit(unit)?.sex;
  }

  unitHealth(unit: string): number {
    if (this.isPlayer(unit)) return this.#health;
    return this.target(unit)?.health ?? this.focus(unit)?.health ?? this.targetTarget(unit)?.health
      ?? this.pet(unit)?.health ?? this.party(unit)?.health ?? 0;
  }

  unitHealthMax(unit: string): number {
    if (this.isPlayer(unit)) return this.#healthMax;
    return this.target(unit)?.healthMax ?? this.focus(unit)?.healthMax ?? this.targetTarget(unit)?.healthMax
      ?? this.pet(unit)?.healthMax ?? this.party(unit)?.healthMax ?? 0;
  }

  unitPower(unit: string): number {
    if (this.isPlayer(unit)) return this.#power;
    return this.target(unit)?.power ?? this.focus(unit)?.power ?? this.targetTarget(unit)?.power
      ?? this.pet(unit)?.power ?? this.party(unit)?.power ?? 0;
  }

  unitPowerMax(unit: string): number {
    if (this.isPlayer(unit)) return this.#powerMax;
    return this.target(unit)?.powerMax ?? this.focus(unit)?.powerMax ?? this.targetTarget(unit)?.powerMax
      ?? this.pet(unit)?.powerMax ?? this.party(unit)?.powerMax ?? 0;
  }

  unitPowerType(unit: string): readonly [number, string] | undefined {
    const type = this.isPlayer(unit)
      ? this.#powerType
      : this.target(unit)?.powerType ?? this.focus(unit)?.powerType ?? this.targetTarget(unit)?.powerType
        ?? this.pet(unit)?.powerType ?? this.party(unit)?.powerType;
    return type === undefined ? undefined : [type, FRAMEXML_POWER_TOKENS[type] ?? "MANA"];
  }

  unitXP(unit: string): number {
    return this.isPlayer(unit) ? CANNED_PLAYER.xp : 0;
  }

  unitXPMax(unit: string): number {
    return this.isPlayer(unit) ? CANNED_PLAYER.xpMax : 0;
  }

  money(): number {
    return this.#money;
  }

  comboPoints(source: string, target: string): number {
    return source === "player" && target === "target" && this.#target ? this.#comboPoints : 0;
  }

  /** Simulate only a server combo-point update for the currently selected target. */
  setComboPoints(points: number): void {
    if (!Number.isInteger(points) || points < 0 || points > 5 || points === this.#comboPoints) return;
    this.#comboPoints = points;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.unitComboPoints, "player");
  }

  bankSlots(): readonly [number, boolean] {
    return [this.#bankSlotsBought, this.#bankSlotsBought === 7];
  }

  bankSlotCost(bought: number): number | undefined {
    return Number.isInteger(bought) && bought >= 0 && bought < 7
      ? this.#bankSlotPrices.get(bought) : undefined;
  }

  setBankSlotPrice(bought: number, copper: number): void {
    if (Number.isInteger(bought) && bought >= 0 && bought < 7
      && Number.isSafeInteger(copper) && copper >= 0) this.#bankSlotPrices.set(bought, copper);
  }

  /** This fixture records the request; a server-state simulation must change the slot count. */
  buyBankSlot(): void {
    if (this.#bankOpen && this.#bankSlotsBought < 7) this.bankSlotBuyRequests.push(this.#bankSlotsBought);
  }

  setBankSlotsBought(bought: number): void {
    if (!Number.isInteger(bought) || bought < 0 || bought > 7 || bought === this.#bankSlotsBought) return;
    this.#bankSlotsBought = bought;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.playerBankBagSlotsChanged);
  }

  openBankFrame(): void {
    if (this.#bankOpen) return;
    this.#bankOpen = true;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.bankFrameOpened);
  }

  closeBankFrame(): void {
    if (!this.#bankOpen) return;
    this.#bankOpen = false;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.bankFrameClosed);
  }

  // ---- trainer ----------------------------------------------------------

  private trainerSupported(): boolean {
    const type = this.#trainer?.trainerType;
    return this.#trainerOpen && (type === 0 || type === 1 || type === 3);
  }

  private trainerRows(): readonly CannedTrainerService[] {
    if (!this.trainerSupported() || !this.#trainer) return [];
    return this.#trainer.services.filter((service) => {
      const type = service.usable === TRAINER_SPELL_AVAILABLE ? "available"
        : service.usable === TRAINER_SPELL_KNOWN ? "used" : "unavailable";
      return this.#trainerFilters.get(type) !== false;
    });
  }

  private normalizeTrainerSelection(): void {
    const count = this.trainerRows().length;
    if (this.#trainerSelection === undefined || this.#trainerSelection < 1
      || this.#trainerSelection > count) this.#trainerSelection = count > 0 ? 1 : undefined;
  }

  trainerServiceCount(): number {
    this.normalizeTrainerSelection();
    return this.trainerRows().length;
  }

  private trainerRow(index: number): CannedTrainerService | undefined {
    return Number.isInteger(index) && index > 0 ? this.trainerRows()[index - 1] : undefined;
  }

  trainerServiceInfo(index: number): readonly [string, string | undefined, string, boolean] | undefined {
    const row = this.trainerRow(index);
    if (!row) return undefined;
    return [row.name, row.rank, row.usable === TRAINER_SPELL_AVAILABLE ? "available"
      : row.usable === TRAINER_SPELL_KNOWN ? "used" : "unavailable", false];
  }

  trainerServiceCost(index: number): readonly [number, number, number] {
    const row = this.trainerRow(index);
    return row ? [row.moneyCost, row.pointCost[0], row.pointCost[1]] : [0, 0, 0];
  }

  trainerServiceLevelReq(index: number): number {
    return this.trainerRow(index)?.requiredLevel ?? 0;
  }

  trainerServiceSkillReq(index: number): readonly [string | undefined, number, boolean] {
    const row = this.trainerRow(index);
    // SkillLine.dbc names are not in this packet; preserve the numeric requirement only in the
    // neutral rank slot rather than inventing a localized skill name.
    return [undefined, 0, false];
  }

  trainerServiceNumAbilityReq(index: number): number {
    // The packet carries prerequisite spell ids, but not their truthful localized names/state.
    // Stock must see no ability rows until that metadata exists.
    return 0;
  }

  trainerServiceAbilityReq(_index: number, _requirement: number): readonly [number, boolean] | undefined {
    return undefined;
  }

  trainerServiceStepReq(_index: number): readonly [number | undefined, boolean] {
    return [undefined, false];
  }

  trainerServiceIcon(index: number): string | undefined { return this.trainerRow(index)?.iconPath; }
  trainerServiceDescription(index: number): string | undefined { return this.trainerRow(index)?.description; }
  trainerServiceSkillLine(_index: number): string | undefined { return undefined; }
  trainerServiceItemLink(_index: number): string | undefined { return undefined; }
  trainerGreeting(): string | undefined { return this.trainerSupported() ? this.#trainer?.greeting : undefined; }
  trainerType(): number | undefined { return this.#trainerOpen ? this.#trainer?.trainerType : undefined; }
  trainerSelectionIndex(): number | undefined {
    if (!this.trainerSupported()) return undefined;
    this.normalizeTrainerSelection();
    return this.#trainerSelection;
  }
  trainerContextSignature(): string {
    return this.#trainer ? `${this.#trainer.guid}:${this.#trainer.trainerType}:${this.#trainer.services.map((row) =>
      `${row.spellId},${row.usable},${row.moneyCost},${row.pointCost.join(",")},${row.requiredLevel},`
      + `${row.requiredSkillLine},${row.requiredSkillRank},${row.requiredAbilities.join(",")}`).join(";")}` : "";
  }
  selectTrainerService(index: number): void {
    // The stock ClassTrainer_SetSelection call continues painting after this command returns.
    // Firing TRAINER_DESCRIPTION_UPDATE synchronously would re-enter that same Lua function.
    if (this.trainerRow(index)) this.#trainerSelection = index;
  }
  isTradeskillTrainer(): boolean { return this.#trainerOpen && this.#trainer?.trainerType === 2; }
  buyTrainerService(index: number): void {
    const row = this.trainerRow(index);
    if (row && row.usable === TRAINER_SPELL_AVAILABLE) this.trainerBuyRequests.push(row.spellId);
  }
  closeTrainer(): void {
    if (!this.trainerSupported()) return;
    this.#trainerOpen = false;
    this.#trainerSelection = undefined;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.trainerUpdate);
  }
  trainerChanged(event: "show" | "update" | "closed"): void {
    if (event === "closed") { this.closeTrainer(); return; }
    if (!this.#trainer || (this.#trainer.trainerType !== 0 && this.#trainer.trainerType !== 1
      && this.#trainer.trainerType !== 3)) return;
    this.#trainerOpen = true;
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

  /** Open the canned class/mount/pet-style trainer without manufacturing a profession dialog. */
  openTrainer(): number {
    if (!this.#trainer || this.#trainer.trainerType === 2 || this.#trainerOpen) return 0;
    this.trainerChanged("show");
    return this.#pump ? 1 : 0;
  }

  partyMemberCount(): number {
    return CANNED_PARTY_MEMBERS.length;
  }

  /**
   * The canned social world's raid (`socialWorld.groupList(true)`), counted as the client counts
   * it: its listed members, then the player, whom a group list never carries (LiveWorldSeam's rule).
   */
  raidMemberCount(): number {
    const group = this.socialWorld.group;
    return group && (group.groupType & 0x02) !== 0 ? group.members.length + 1 : 0;
  }

  isPartyLeader(): boolean {
    return this.#partyLeader && CANNED_PARTY_MEMBERS.length > 0;
  }

  /** The demo's fixed party uses group loot with the stock uncommon threshold. */
  lootMethod(): FrameXmlLootMethod { return ["group", undefined, undefined]; }
  lootThreshold(): number { return 2; }

  /** Publish one packet-shaped battlemaster list and its stock notification edge. */
  setBattlefieldList(list: BattlefieldList | undefined): void {
    const wasArena = this.isBattlefieldArena();
    // ArenaFrame's stock handler intentionally checks IsBattlefieldArena before honoring the
    // close edge. Deliver that edge while the previous authoritative context is still current;
    // only then replace it with the queue/stale response.
    if (wasArena && !CannedWorldSeam.isArenaList(list)) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.arenaClose);
    this.battlefieldList = list;
    this.#battlefieldListFresh = list !== undefined;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.battlefieldList);
    if (this.isBattlefieldArena() && !wasArena) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.arenaShow);
  }

  /** Alias matching the world packet vocabulary used by LiveWorldSeam. */
  publishBattlefieldList(list: BattlefieldList | undefined): void {
    this.setBattlefieldList(list);
  }

  setArenaSeason(season: number | undefined): void {
    const next = typeof season === "number" && Number.isFinite(season)
      ? Math.max(0, Math.trunc(season)) : 0;
    if (next === this.#arenaSeason) return;
    this.#arenaSeason = next;
    if (this.isBattlefieldArena()) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.battlefieldStatus);
  }

  setPartyLeader(isLeader: boolean): void {
    const next = isLeader === true;
    if (next === this.#partyLeader) return;
    this.#partyLeader = next;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.partyLeaderChanged);
  }

  partyMember(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 1 || index > CANNED_PARTY_MEMBERS.length) return undefined;
    return CANNED_PARTY_MEMBERS[index - 1]?.name;
  }

  targetUnit(): void {
    // CannedWorldSeam has no world connection or selectable GUID; keeping this a validated no-op
    // preserves the binding's stock void shape without pretending to select a real unit.
  }

  unitIsVisible(unit: string): boolean {
    return this.knownUnit(unit) !== undefined
      && (this.isPlayer(unit) ? true
        : this.target(unit)?.connected ?? this.pet(unit)?.visible ?? this.party(unit)?.visible ?? false);
  }

  unitIsPossessed(unit: string): boolean {
    return this.pet(unit)?.possessed === true;
  }

  petHappiness(): readonly [number, number] | undefined {
    return [CANNED_PET.happiness, CANNED_PET.happinessDamage];
  }

  hasPetUI(): readonly [boolean, boolean] {
    return [CANNED_PET.visible, CANNED_PET.isHunterPet];
  }

  /** The pet page's abandon/rename requests, recorded instead of sent (FrameXmlCompanions.ts). */
  readonly petRenames: string[] = [];
  petAbandons = 0;

  /** The canned pet is a hunter pet: abandonable, and renameable until `petRename` has named it. */
  petCanBeAbandoned(): boolean {
    return CANNED_PET.isHunterPet;
  }

  petCanBeRenamed(): boolean {
    return CANNED_PET.isHunterPet && this.petRenames.length === 0;
  }

  petAbandon(): void {
    this.petAbandons += 1;
  }

  petRename(name: string): void {
    this.petRenames.push(name);
  }

  unitCastingInfo(unit: string): FrameXmlCastingInfo | undefined {
    if (unit === "focus") {
      if (!this.#focus || !this.#focusCasting || !this.#pump) return undefined;
      const started = this.#pump.now();
      return [CANNED_CAST.name, CANNED_CAST.rank, CANNED_CAST.displayName, CANNED_CAST.texture,
        started * 1000, (started + 2) * 1000, CANNED_CAST.isTradeSkill, CANNED_CAST.castID,
        CANNED_CAST.notInterruptible];
    }
    if (unit === "targettarget") {
      if (!this.#targetTarget || !this.#targetTargetCasting || !this.#pump) return undefined;
      const started = this.#pump.now();
      return [CANNED_CAST.name, CANNED_CAST.rank, CANNED_CAST.displayName, CANNED_CAST.texture,
        started * 1000, (started + 2) * 1000, CANNED_CAST.isTradeSkill, CANNED_CAST.castID,
        CANNED_CAST.notInterruptible];
    }
    if (unit === "target") {
      if (!this.#target || this.#targetCastPhase !== "casting") return undefined;
      return [
        CANNED_CAST.name,
        CANNED_CAST.rank,
        CANNED_CAST.displayName,
        CANNED_CAST.texture,
        this.#targetCastStartedAt * 1000,
        this.#targetCastEndsAt * 1000,
        CANNED_CAST.isTradeSkill,
        CANNED_CAST.castID,
        CANNED_CAST.notInterruptible,
      ];
    }
    if (!this.isPlayer(unit) || this.#castPhase !== "casting") return undefined;
    return [
      CANNED_CAST.name,
      CANNED_CAST.rank,
      CANNED_CAST.displayName,
      CANNED_CAST.texture,
      this.#castStartedAt * 1000,
      this.#castEndsAt * 1000,
      CANNED_CAST.isTradeSkill,
      CANNED_CAST.castID,
      CANNED_CAST.notInterruptible,
    ];
  }

  unitChannelInfo(unit: string): FrameXmlChannelInfo | undefined {
    if (!this.isPlayer(unit) || this.#castPhase !== "channeling") return undefined;
    return [
      CANNED_CHANNEL.name,
      CANNED_CHANNEL.rank,
      CANNED_CHANNEL.displayName,
      CANNED_CHANNEL.texture,
      this.#channelStartedAt * 1000,
      this.#channelEndsAt * 1000,
      CANNED_CHANNEL.isTradeSkill,
      CANNED_CHANNEL.notInterruptible,
    ];
  }

  // ---- character skills -----------------------------------------------

  #visibleSkillRows(): readonly FrameXmlSkillRow[] {
    const visible: FrameXmlSkillRow[] = [];
    let collapsed = false;
    for (const row of this.#skillRows) {
      if (row.kind === "header") {
        collapsed = this.#collapsedSkillCategories.has(row.categoryId);
        visible.push(row);
      } else if (!collapsed) {
        visible.push(row);
      }
    }
    return visible;
  }

  skillLineCount(): number {
    return this.#visibleSkillRows().length;
  }

  skillLineInfo(index: number): FrameXmlSkillLineInfo {
    const row = Number.isInteger(index) && index >= 1 ? this.#visibleSkillRows()[index - 1] : undefined;
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
    if (row?.kind === "skill" && frameXmlSkillAbandonable(row)) this.abandonedSkills.push(row.skillId);
  }

  adjustedSkillPoints(): number {
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
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.skillLinesChanged);
  }

  expandSkillHeader(index: number): void { this.#setSkillCategoryCollapsed(index, false); }
  collapseSkillHeader(index: number): void { this.#setSkillCategoryCollapsed(index, true); }
  addSkillUp(_index: number): void { /* no authoritative training packet */ }
  removeSkillUp(_index: number): void { /* no authoritative training packet */ }
  buySkillTier(_index: number): void { /* no authoritative training packet */ }
  cancelSkillUps(): void { /* no authoritative training packet */ }

  // ---- player spellbook -------------------------------------------------

  // ---- honor / PvP statistics ------------------------------------------
  pvpSessionStats(): readonly [number, number] {
    return [this.#honor.todayHonorableKills, this.#honor.todayContribution];
  }

  pvpYesterdayStats(): readonly [number, number] {
    return [this.#honor.yesterdayHonorableKills, this.#honor.yesterdayContribution];
  }

  pvpLifetimeStats(): readonly [number, number | undefined] {
    return [this.#honor.lifetimeHonorableKills, this.#honor.rank];
  }

  pvpRankInfo(_rank: number | undefined): readonly [string | undefined, number] {
    // The rank table is retired and absent from the authoritative world snapshot.
    // Keep nil name plus zero sentinel so stock HonorFrame can render safely.
    return [undefined, 0];
  }

  pvpRank(_unit: string): number | undefined {
    return _unit === "player" ? this.#honor.rank : undefined;
  }

  pvpRankProgress(): number {
    return this.#honor.rankProgress ?? 0;
  }

  pvpHonorCurrency(): number {
    return this.#honor.honorCurrency;
  }

  pvpArenaCurrency(): number {
    return this.#honor.arenaCurrency;
  }

  // ---- battleground queue ----------------------------------------------

  battlegroundCatalogReady(): boolean {
    return true;
  }

  battlegroundTypeCount(): number {
    return this.#battlegroundCatalog.length;
  }

  battlegroundInfo(index: number): readonly [string, boolean, boolean, boolean, number] | undefined {
    if (!Number.isInteger(index) || index < 1 || index > this.#battlegroundCatalog.length) return undefined;
    const row = this.#battlegroundCatalog[index - 1];
    if (!row) return undefined;
    const level = CANNED_PLAYER.level;
    return [row.name, level >= row.minLevel && level <= row.maxLevel, false, row.random, row.bgTypeId];
  }

  battlefieldInfo(): readonly [string, string, number] | undefined {
    const row = this.#battlegroundCatalog[this.#selectedBattleground - 1];
    if (!row) return undefined;
    const map = row.maps[0];
    return [map?.name ?? row.name, map?.description1 ?? map?.description0 ?? "", row.maxGroupSize];
  }

  battlefieldStatus(index: number): readonly [string, string | undefined, number, number, number, number, boolean] {
    if (!Number.isInteger(index) || index < 1 || index > 2) return ["none", undefined, 0, 0, 0, 0, false];
    return ["none", undefined, 0, 0, 0, 0, false];
  }

  requestBattlegroundInstanceInfo(index: number): void {
    const row = this.#battlegroundCatalog[index - 1];
    if (row) {
      this.#selectedBattleground = index;
      this.battlegroundListRequests.push({ bgTypeId: row.bgTypeId, fromWhere: 1 });
    }
  }

  joinBattleground(asGroup: boolean): void {
    const row = this.#battlegroundCatalog[this.#selectedBattleground - 1];
    if (row) this.battlegroundJoins.push({ bgTypeId: row.bgTypeId, instanceId: 0, asGroup });
  }

  sortBattlegroundList(): void {
    // Keep the authored BattlemasterList order stable for one-based stock indices.
  }

  closeBattleground(): void {
    // PVPBattleground's close remains packet-free, but ArenaFrame's OnHide invalidates the
    // battlemaster context so a late status edge cannot reopen a stale owner.
    this.#battlefieldListFresh = false;
  }

  isBattlefieldArena(): boolean {
    return this.#battlefieldListFresh && CannedWorldSeam.isArenaList(this.battlefieldList);
  }

  private static isArenaList(list: BattlefieldList | undefined): boolean {
    return !!list
      && typeof list.battlemasterGuid === "bigint"
      && list.battlemasterGuid !== 0n
      && list.fromWhere === 0
      && list.bgTypeId === 6;
  }

  currentArenaSeason(): number {
    return this.#arenaSeason;
  }

  canJoinBattlefieldAsGroup(): boolean {
    return this.isBattlefieldArena();
  }

  joinArena(arenaSlot: number, asGroup: boolean, rated: boolean): void {
    const list = this.battlefieldList;
    if (!this.isBattlefieldArena() || !list || !Number.isInteger(arenaSlot)
      || arenaSlot < 0 || arenaSlot > 2
      || rated && (!asGroup || this.currentArenaSeason() === 0)
      || asGroup && (this.partyMemberCount() + this.raidMemberCount() === 0 || !this.isPartyLeader())) return;
    this.arenaJoins.push({ battlemasterGuid: list.battlemasterGuid, arenaSlot, asGroup, rated });
  }

  // ---- merchant ---------------------------------------------------------

  private merchantItems(): readonly CannedMerchantItem[] {
    if (!this.#merchant) return [];
    // Extended-cost rows are exposed as buyable: the live seam sends the same buy opcode and the
    // server validates the alternate currency. Filtering them hid emblem/honor goods entirely.
    return this.#merchant.items;
  }

  /** Atomically update the canned vendor state and emit the exact stock lifecycle edge. */
  merchantChanged(event: "show" | "update" | "closed", _force = false): void {
    if (event === "closed") {
      if (!this.#merchantOpen) return;
      this.#merchantOpen = false;
      this.#pump?.fire(FRAMEXML_SEAM_EVENTS.merchantClosed);
      return;
    }
    if (!this.#merchant) return;
    if (!this.#merchantOpen) {
      if (event === "show") this.#merchantOpen = true;
      else return;
    }
    this.#pump?.fire(event === "show"
      ? FRAMEXML_SEAM_EVENTS.merchantShow
      : FRAMEXML_SEAM_EVENTS.merchantUpdate);
  }

  /** Open the deterministic vendor used by the standalone page and seam tests. */
  openMerchant(): number {
    if (this.#merchantOpen || !this.#merchant) return 0;
    const before = this.#pump;
    this.merchantChanged("show");
    return before ? 1 : 0;
  }

  /** Publish the equivalent of a server-side merchant list/price update. */
  refreshMerchant(): number {
    if (!this.#merchantOpen || !this.#merchant) return 0;
    const before = this.#pump;
    this.merchantChanged("update");
    return before ? 1 : 0;
  }

  private merchantItem(index: number): CannedMerchantItem | undefined {
    if (!this.#merchantOpen || !this.#merchant || !Number.isInteger(index) || index < 1) return undefined;
    return this.merchantItems()[index - 1];
  }

  merchantNumItems(): number {
    return this.#merchantOpen ? this.merchantItems().length : 0;
  }

  merchantItemInfo(index: number): FrameXmlMerchantItemInfo | undefined {
    const item = this.merchantItem(index);
    if (!item) return undefined;
    return [
      item.name,
      item.texture,
      item.price,
      item.quantity,
      item.numAvailable,
      item.isUsable,
      (item.extendedCost ?? 0) > 0,
    ];
  }

  merchantItemLink(index: number): string | undefined {
    return this.merchantItem(index)?.link;
  }

  merchantItemMaxStack(index: number): number {
    return this.merchantItem(index)?.maxStack ?? 0;
  }

  merchantItemCostInfo(index: number): FrameXmlMerchantCostInfo {
    const cost = this.merchantItem(index)?.cost;
    return cost ? [cost.honor, cost.arena, cost.items.length] : [0, 0, 0];
  }

  merchantItemCostItem(index: number, costIndex: number): readonly [string | undefined, number, string | undefined] | undefined {
    const required = this.merchantItem(index)?.cost?.items[costIndex - 1];
    return required ? [required.texture, required.count, required.link] : undefined;
  }

  itemInfo(value: unknown): FrameXmlItemInfo | undefined {
    const entry = frameXmlItemEntry(value);
    if (entry === undefined) return undefined;
    for (const item of this.#merchant?.items ?? []) {
      if (item.itemId === entry && item.link && item.quality !== undefined) {
        return [item.name, typeof value === "string" && value.includes("|Hitem:") ? value : item.link,
          item.quality];
      }
      for (const required of item.cost?.items ?? []) {
        if ((required.itemId === entry || frameXmlItemEntry(required.link) === entry)
          && required.name && required.link && required.quality !== undefined) {
          return [required.name,
            typeof value === "string" && value.includes("|Hitem:") ? value : required.link,
            required.quality];
        }
      }
    }
    return undefined;
  }

  buybackNumItems(): number {
    return this.#merchantOpen ? this.#merchant?.buyback.filter((item) => item.numAvailable !== 0).length ?? 0 : 0;
  }

  private merchantBuybackItem(index: number): CannedBuybackItem | undefined {
    if (!this.#merchantOpen || !this.#merchant || !Number.isInteger(index) || index < 1) return undefined;
    return this.#merchant.buyback.filter((item) => item.numAvailable !== 0)[index - 1];
  }

  buybackItemInfo(index: number): FrameXmlBuybackItemInfo | undefined {
    const item = this.merchantBuybackItem(index);
    return item ? [item.name, item.texture, item.price, item.quantity, item.numAvailable, item.isUsable] : undefined;
  }

  buybackItemLink(index: number): string | undefined {
    return this.merchantBuybackItem(index)?.link;
  }

  buyMerchantItem(index: number, count: number): void {
    const item = this.merchantItem(index);
    if (!item || !item.isUsable || item.numAvailable === 0 || !Number.isInteger(count) || count < 1) return;
    this.merchantBuyRequests.push({ slot: item.slot, count });
  }

  buybackItem(index: number): void {
    const item = this.merchantBuybackItem(index);
    if (!item || !item.isUsable || item.numAvailable === 0) return;
    // CMSG_BUYBACK_ITEM addresses the player's private absolute shelf (74..85), not row zero.
    this.merchantBuybackRequests.push(74 + item.slot - 1);
  }

  closeMerchant(): void {
    this.merchantChanged("closed");
  }

  canMerchantRepair(): boolean { return false; }
  repairAllCost(): readonly [number, boolean] { return [0, false]; }
  canGuildBankRepair(): boolean { return false; }
  inRepairMode(): boolean { return false; }

  randomBattlegroundHonorBonuses(): readonly [boolean, number, number, number, number] {
    return [false, 0, 0, 0, 0];
  }

  holidayBattlegroundHonorBonuses(): readonly [boolean, number, number, number, number] {
    return [false, 0, 0, 0, 0];
  }

  wintergraspWaitTime(): number | undefined {
    return undefined;
  }

  canQueueForWintergrasp(): boolean {
    return false;
  }

  #spellActions(): readonly CannedAction[] {
    return this.#spellbook;
  }

  /** The bar slot holding a spell now (the book row keeps the slot it started on). */
  #barSlotOf(spellId: number): number | undefined {
    for (const action of this.#actions.values()) if (action.kind === "spell" && action.id === spellId) return action.slot;
    return undefined;
  }

  #spellAction(index: number): CannedAction | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    return this.#spellActions()[index - 1];
  }

  #spellActionForValue(value: number): CannedAction | undefined {
    return this.#spellAction(value) ?? this.#spellActions().find((action) => action.id === value);
  }

  spellTabCount(): number {
    return this.#spellActions().length === 0 ? 0 : 1;
  }

  shapeshiftFormCount(): number { return this.#shapeshiftForms.length; }

  shapeshiftFormInfo(index: number): FrameXmlShapeshiftFormInfo | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    const form = this.#shapeshiftForms[index - 1];
    return form ? [form.texture, form.name, this.#activeShapeshiftForm === index,
      form.castable !== false] : undefined;
  }

  shapeshiftFormCooldown(_index: number): FrameXmlSpellCooldown { return [0, 0, 0]; }

  castShapeshiftForm(index: number): void {
    if (!this.shapeshiftFormInfo(index)?.[3]) return;
    const form = this.#shapeshiftForms[index - 1];
    if (form) this.castSpellIds.push(form.spellId);
  }

  setShapeshiftForms(forms: readonly CannedShapeshiftForm[]): void {
    const next = forms.slice(0, 10).filter((form) => Number.isSafeInteger(form.spellId)
      && form.spellId > 0 && form.name.length > 0 && form.texture.length > 0
      && (form.bonusActionBarOffset === undefined
        || (Number.isSafeInteger(form.bonusActionBarOffset) && form.bonusActionBarOffset >= 0)));
    if (JSON.stringify(next) === JSON.stringify(this.#shapeshiftForms)) return;
    const oldOffset = this.bonusBarOffset();
    this.#shapeshiftForms.splice(0, this.#shapeshiftForms.length, ...next);
    if (this.#activeShapeshiftForm > next.length) this.#activeShapeshiftForm = 0;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateShapeshiftForms);
    if (this.bonusBarOffset() !== oldOffset) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateBonusActionBar);
  }

  /** Simulate the server's later form/aura update independently of the cast request. */
  setActiveShapeshiftForm(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > this.#shapeshiftForms.length
      || index === this.#activeShapeshiftForm) return;
    const oldOffset = this.bonusBarOffset();
    this.#activeShapeshiftForm = index;
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateShapeshiftForm);
    if (this.bonusBarOffset() !== oldOffset) this.#pump?.fire(FRAMEXML_SEAM_EVENTS.updateBonusActionBar);
  }

  spellTabInfo(index: number): FrameXmlSpellTabInfo | undefined {
    const spells = this.#spellActions();
    if (index !== 1 || spells.length === 0) return undefined;
    // The last two values are the rank-folded offset/count, not guild/off-spec flags.  The
    // fixture has one row per known rank, so folding does not change its book shape.
    return ["Общие", spells[0]?.texture ?? "", 0, spells.length, 0, spells.length];
  }

  spellName(index: number, _bookType: string | undefined): readonly [string, string] | undefined {
    const action = this.#spellAction(index);
    return action ? [action.name, ""] : undefined;
  }

  spellTexture(index: number, _bookType: string | undefined): string | undefined {
    return this.#spellAction(index)?.texture;
  }

  /** `GetSpellLink` over the fixture's spell actions, in the live seam's three shapes. */
  spellLink(indexOrSpell: number | string, bookType?: string): string | undefined {
    const actions = this.#spellActions();
    const action = bookType !== undefined
      ? bookType === "spell" && typeof indexOrSpell === "number" ? this.#spellAction(indexOrSpell) : undefined
      : typeof indexOrSpell === "number"
        ? actions.find((candidate) => candidate.id === indexOrSpell)
        : actions.find((candidate) => candidate.name.toLocaleLowerCase() === indexOrSpell.trim().toLocaleLowerCase());
    return action ? spellChatLink(action.id, action.name) : undefined;
  }

  spellCooldown(index: number, _bookType: string | undefined): FrameXmlSpellCooldown {
    const action = this.#spellActionForValue(index);
    const slot = action && this.#barSlotOf(action.id);
    const cooldown = slot === undefined ? undefined : this.#cooldowns.get(slot);
    const now = this.#pump?.now() ?? 0;
    // A ready spell is `0, 0, 1`, as LiveWorldSeam.spellCooldown answers it (the stock book dims `enable ~= 1`).
    if (!cooldown || now >= cooldown.start + cooldown.duration) return action === undefined ? [0, 0, 0] : [0, 0, 1];
    return [cooldown.start, cooldown.duration, 1];
  }

  spellAutocast(index: number, _bookType: string | undefined): readonly [boolean, boolean] {
    return this.#spellAction(index) === undefined ? [false, false] : [false, false];
  }

  spellIsPassive(index: number, _bookType: string | undefined): boolean | undefined {
    return this.#spellAction(index) === undefined ? undefined : false;
  }

  knownSlotFromHighestRankSlot(index: number, _bookType: string | undefined): number | undefined {
    return this.#spellAction(index) === undefined ? undefined : index;
  }

  spellIsSelected(index: number, _bookType: string | undefined): boolean {
    return this.#spellAction(index) !== undefined && false;
  }

  hasPetSpells(): boolean {
    return false;
  }

  castSpell(spell: number, _bookType: string | undefined): void {
    const action = this.#spellActionForValue(spell);
    // The fixture's cooldowns live on bar slots: the one holding this spell now, if any.
    const slot = action && this.#barSlotOf(action.id);
    if (!action || (slot !== undefined && this.#cooldowns.has(slot))) return;
    this.castSpellIds.push(action.id);
    if (slot !== undefined) this.useAction(slot);
    this.#pump?.fire(FRAMEXML_SEAM_EVENTS.spellUpdateCooldown);
  }

  updateSpells(): void {
    // The fixture's spell list is immutable; retain the stock API call as a safe no-op.
  }

  getCVar(name: string): string | undefined {
    return this.#settingsCVar?.get(name);
  }

  getCVarDefault(name: string): string | undefined {
    return this.#settingsCVar?.getDefault(name);
  }

  getCVarBool(name: string): boolean | undefined {
    const settingValue = this.#settingsCVar?.get(name);
    if (settingValue !== undefined) return settingValue !== "" && settingValue !== "0";
    return this.#spellCvars.get(name.toLowerCase());
  }

  setCVar(name: string, value: boolean): void {
    if (name.toLowerCase() === "showallspellranks") {
      this.#spellCvars.set(name.toLowerCase(), value);
    }
  }

  setCVarValue(name: string, value: unknown): boolean | undefined {
    if (this.#settingsCVar) return this.#settingsCVar.set(name, value);
    if (name.toLowerCase() === "showallspellranks") {
      this.setCVar(name, value === true || value === 1 || value === "1" || value === "true");
    }
    return undefined;
  }

  // ---- talents -----------------------------------------------------------

  talentSnapshot(pet = false): FrameXmlTalentSnapshot | undefined {
    return pet ? undefined : this.#talentSnapshot;
  }

  learnTalent(tab: number, index: number, pet: boolean | undefined, group: number | undefined): void {
    // Canned data has no pet packet or transport; enforce its player-only fixture boundary:
    // Lua coordinates are accepted only when they resolve to an active, affordable next rank.
    if (pet === true || (group !== undefined && group !== this.#talentSnapshot.activeTalentGroup)) return;
    const groupSnapshot = this.#talentSnapshot.groups[
      (group ?? this.#talentSnapshot.activeTalentGroup) - 1
    ];
    const cell = groupSnapshot?.tabs[tab - 1]?.talents[index - 1];
    if (!groupSnapshot?.active || !cell || cell.maxRank <= 0 || cell.rank >= cell.maxRank
      || groupSnapshot.unspentPoints === undefined || groupSnapshot.unspentPoints <= 0
      || cell.meetsPrereq !== true) return;
    // The standalone seam intentionally has no packet sender; the method remains the exact future
    // world boundary and is spyable by bridge tests without inventing a second transport.
  }

  unitFactionGroup(unit: string): string | undefined {
    if (this.isPlayer(unit)) return "Alliance";
    return this.target(unit)?.factionGroup ?? this.focus(unit)?.factionGroup
      ?? this.targetTarget(unit)?.factionGroup ?? (this.party(unit) ? "Alliance" : undefined);
  }

  unitClassification(unit: string): string | undefined {
    return this.knownUnit(unit) === undefined ? undefined
      : this.target(unit)?.classification ?? this.focus(unit)?.classification
        ?? this.targetTarget(unit)?.classification ?? "normal";
  }

  unitIsUnit(left: string, right: string): boolean {
    if (!this.unitExists(left) || !this.unitExists(right)) return false;
    return this.#alias(left) === this.#alias(right);
  }

  unitIsPlayer(unit: string): boolean {
    return this.isPlayer(unit) || this.target(unit)?.isPlayer === true || this.party(unit) !== undefined;
  }

  unitIsConnected(unit: string): boolean {
    if (this.isPlayer(unit)) return true;
    return this.target(unit)?.connected === true
      || this.pet(unit)?.connected === true
      || this.party(unit)?.connected === true;
  }

  unitIsDead(unit: string): boolean {
    if (this.isPlayer(unit)) return this.#health <= 0;
    const target = this.target(unit);
    return target !== undefined
      ? target.health <= 0
      : this.pet(unit)?.health === 0 || this.party(unit)?.dead === true;
  }

  unitIsGhost(unit: string): boolean {
    return this.party(unit)?.ghost === true;
  }

  unitIsCorpse(unit: string): boolean {
    return this.unitIsDead(unit);
  }

  private reaction(leftToken: string, rightToken: string): -1 | 0 | 1 | undefined {
    const left = this.#alias(leftToken);
    const right = this.#alias(rightToken);
    if (!this.unitExists(left) || !this.unitExists(right)) return undefined;
    if (left === right) return 1;
    if (left === "player" && right === "target") return this.#target?.reaction;
    if (left === "target" && right === "player") {
      const reaction = this.#target?.reaction;
      return reaction === undefined ? undefined : reaction === -1 ? 1 : reaction === 1 ? -1 : 0;
    }
    return 0;
  }

  unitIsFriend(left: string, right: string): boolean {
    return this.reaction(left, right) === 1;
  }

  unitIsEnemy(left: string, right: string): boolean {
    return this.reaction(left, right) === -1;
  }

  unitCanAttack(left: string, right: string): boolean {
    const reaction = this.reaction(left, right);
    return reaction !== undefined && reaction !== 1;
  }

  unitPlayerControlled(unit: string): boolean {
    return this.unitIsPlayer(unit);
  }

  unitIsPVP(unit: string): boolean {
    return this.knownUnit(unit) !== undefined && (this.isPlayer(unit)
      ? false
      : this.target(unit)?.pvp === true);
  }

  unitIsPVPFreeForAll(unit: string): boolean {
    return this.target(unit)?.pvpFreeForAll === true;
  }

  unitIsTapped(unit: string): boolean {
    return this.target(unit)?.tapped === true;
  }

  unitIsTappedByPlayer(unit: string): boolean {
    return this.target(unit)?.tappedByPlayer === true;
  }

  unitIsTappedByAllThreatList(unit: string): boolean {
    return this.target(unit)?.tappedByAllThreatList === true;
  }

  unitSelectionColor(unit: string): readonly [number, number, number] | undefined {
    if (!this.unitExists(unit)) return undefined;
    const reaction = this.reaction("player", unit);
    return reaction === -1 ? [1, 0, 0] : reaction === 1 ? [0, 1, 0] : [1, 1, 0];
  }

  /**
   * `GetRestState` — and it is here because of a raise, not because a bar needs it.
   *
   * `MainMenuBar.lua:317` is `if (exhaustionStateID >= 3)` with no nil guard, and it is one of the
   * three raises the vertical's partial TOC has left. 1 is «Normal», the state a character who is
   * not resting is in, and the corpus' own comparison is against 3 («Rested»).
   */
  restState(): readonly [number, string, number] {
    return [1, "Normal", 1];
  }

  // ---- unit auras -------------------------------------------------------

  unitAura(unit: string, index: number, filter: string | undefined): FrameXmlAuraInfo | undefined {
    if ((unit !== "player" && unit !== "target" && unit !== "focus" && unit !== "targettarget"
      && unit !== "pet" && unit !== "party1") || index !== 1) {
      return undefined;
    }
    const fixtures = unit === "target"
      ? (this.#target ? CANNED_TARGET_AURA_FIXTURES : undefined)
      : unit === "focus" ? (this.#focus ? CANNED_FOCUS_AURA_FIXTURES : undefined)
        : unit === "targettarget" ? (this.#targetTarget ? CANNED_TARGET_TARGET_AURA_FIXTURES : undefined)
          : unit === "pet" ? CANNED_PET_AURA_FIXTURES
        : unit === "party1" ? CANNED_PARTY_AURA_FIXTURES
          : CANNED_AURA_FIXTURES;
    if (!fixtures) return undefined;
    const fixture = filter === "HELPFUL"
      ? fixtures.helpful
      : filter === "HARMFUL" ? fixtures.harmful : undefined;
    if (!fixture) return undefined;
    return [
      fixture.name,
      fixture.rank,
      fixture.texture,
      fixture.count,
      fixture.debuffType,
      fixture.duration,
      this.#auraStartedAt + fixture.expirationOffset,
      fixture.unitCaster,
      fixture.isStealable,
      fixture.shouldConsolidate,
      fixture.spellId,
    ];
  }

  unitBuff(unit: string, index: number): FrameXmlAuraInfo | undefined {
    return this.unitAura(unit, index, "HELPFUL");
  }

  unitDebuff(unit: string, index: number): FrameXmlAuraInfo | undefined {
    return this.unitAura(unit, index, "HARMFUL");
  }

  cancelUnitBuff(unit: string, index: number, filter: string | undefined): void {
    if (unit !== "player" || index !== 1 || filter !== "HELPFUL") return;
    this.cancelledAuraSpellIds.push(CANNED_AURA_FIXTURES.helpful.spellId);
  }

  // ---- the base minimap -------------------------------------------------

  minimapZoneText(): string | undefined {
    return CANNED_MINIMAP_ZONE.minimapZoneText;
  }

  zoneText(): string | undefined {
    return CANNED_MINIMAP_ZONE.zoneText;
  }

  subZoneText(): string | undefined {
    return CANNED_MINIMAP_ZONE.subZoneText;
  }

  zonePvpInfo(): readonly [string | undefined, boolean | undefined, string | undefined] {
    return [
      CANNED_MINIMAP_ZONE.pvpType,
      CANNED_MINIMAP_ZONE.isSubZonePvP,
      CANNED_MINIMAP_ZONE.factionName,
    ];
  }
}
