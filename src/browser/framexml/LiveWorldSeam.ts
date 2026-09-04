import {
  ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL,
} from "../../world/ActionBarProtocol.js";
import {
  isPlayerGhost, player as playerFields, readField, unit as unitField,
  UNIT_DYNFLAG_TAPPED, UNIT_DYNFLAG_TAPPED_BY_PLAYER,
} from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import { isWorldObjectDead } from "../../world/WorldState.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldStore } from "../../world/WorldStore.js";
import { SELF } from "../../world/WorldStore.js";
import {
  INVENTORY_SLOT_BAG_0,
  INVENTORY_SLOT_BAG_START,
  BUYBACK_SLOT_START,
  BUYBACK_SLOTS,
  entryOf,
  fieldGuid,
  playerInventory,
  stackCount,
} from "../Inventory.js";
import type { BuybackSlotState, ItemSlotState, PlayerInventoryState } from "../Inventory.js";
import { GROUPTYPE_RAID, MEMBER_STATUS_ONLINE, MEMBER_STATUS_PVP } from "../../world/GroupProtocol.js";
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
import { CHAT_MSG_ADDON, LANG_ADDON } from "../../world/SessionProtocol.js";
import { CHAT_MSG_CHANNEL, CHAT_MSG_SYSTEM } from "../../world/ChatProtocol.js";
import type { ChatMessage } from "../../world/ChatProtocol.js";
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
import {
  TRAINER_SPELL_AVAILABLE,
  TRAINER_SPELL_KNOWN,
  TRAINER_SPELL_UNAVAILABLE,
} from "../../world/TrainerProtocol.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { ensureSpellNames } from "../ui/SpellNames.js";
import { QUALITY_LINK_COLORS } from "../ui/ChatLink.js";
import { className, raceName } from "../ui/UnitSnapshot.js";
import {
  AURA_FLAGS,
  type ActiveAura,
} from "../../world/AuraProtocol.js";
import {
  FRAMEXML_POWER_MAX_EVENTS,
  FRAMEXML_POWER_EVENTS,
  FRAMEXML_POWER_TOKENS,
  frameXmlInventorySlotInfo,
  FRAMEXML_CHAT_WINDOW_GROUPS,
  FRAMEXML_SEAM_EVENTS,
  frameXmlChatEventArgs,
  frameXmlChatEventName,
  frameXmlChatTextIsValid,
  frameXmlChatTypeCode,
  type FrameXmlChatSender,
  type FrameXmlChatTarget,
  type FrameXmlChatWindowChannels,
  type FrameXmlChatWindowInfo,
  type FrameXmlCastingInfo,
  type FrameXmlChannelInfo,
  type FrameXmlMerchantItemInfo,
  type FrameXmlMerchantCostInfo,
  type FrameXmlBuybackItemInfo,
  type FrameXmlAuraInfo,
  type FrameXmlSpellCooldown,
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
  type FrameXmlSkillRow,
  type FrameXmlSkillMetadata,
  type FrameXmlSkillResolvers,
} from "./FrameXmlSkillResolver.js";
import type { FrameXmlSettingsCVarAdapter } from "./FrameXmlSettingsCVar.js";
import type { FrameXmlInventoryTooltipItem } from "./FrameXmlCharacterTooltip.js";
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
const RACE_TOKENS: Readonly<Record<number, string>> = Object.freeze({
  1: "Human", 2: "Orc", 3: "Dwarf", 4: "NightElf", 5: "Scourge", 6: "Tauren",
  7: "Gnome", 8: "Troll", 10: "BloodElf", 11: "Draenei",
});

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
 * Item and macro slots answer with what they have — an item has no `Interface\Icons\…` path on
 * this client (item icons are generated PNGs behind `/item-icon/<displayId>`), so an item slot
 * answers `HasAction` truthfully and leaves the texture nil, which is the corpus' own «no icon»
 * branch rather than a broken picture.
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

function isArenaBattlefieldList(list: BattlefieldList | undefined): boolean {
  return !!list
    && typeof list.battlemasterGuid === "bigint"
    && list.battlemasterGuid !== 0n
    && list.fromWhere === 0
    && list.bgTypeId === 6;
}

export interface LiveWorldSeamContext {
  readonly world: () => WorldClient | undefined;
  readonly store: () => WorldStore | undefined;
  readonly spell: (id: number) => SpellMetadata | undefined;
  /** The interface-owned focus identity; sampled on the seam's existing rendered-frame path. */
  readonly focusGuid?: () => bigint | undefined;
  /** Optional FactionTemplate resolver supplied by the host when client-side faction data is ready. */
  readonly reaction?: (left: WorldObjectState, right: WorldObjectState) => number | undefined;
  /** Optional resolver joining Faction.dbc metadata to the live faction map. */
  readonly reputation?: (world: WorldClient) => readonly FrameXmlFactionRow[] | undefined;
  /** SkillLine/SkillLineCategory metadata; absent means this host has no skill rows yet. */
  readonly skillMetadata?: () => FrameXmlSkillMetadata | undefined;
  /** Talent tree metadata; absent means Blizzard_TalentUI must remain safely empty. */
  readonly talentMetadata?: () => FrameXmlTalentMetadata | undefined;
  /** Explicit host revision for talent metadata and spell-name enrichment. */
  readonly talentMetadataRevision?: () => number;
  /** Resolve the current `WorldMapArea` id used by Quest POI filtering, when area metadata is ready. */
  readonly worldMapAreaId?: () => number | undefined;
  /** `performance.now()` milliseconds — the clock the world's cooldowns are stamped in. */
  readonly monotonic: () => number;
  /** The global cooldown's end, in the same milliseconds; `game.globalCooldownUntil`. */
  readonly globalCooldownUntil: () => number;
  /** Cast a spell the way the rest of the client casts one; `ui/Spellbook.castSpell`. */
  readonly castSpell: (id: number) => void;
  /** Optional skill-line tabs; absent hosts get one truthful undivided resolved-spell tab. */
  readonly spellTabs?: () => readonly FrameXmlSpellTabInfo[];
  /** 1-based tab ordinal for a spell. Returning undefined keeps it in the fallback tab. */
  readonly spellTabFor?: (spellId: number) => number | undefined;
  /** Optional CVar bridge used by SpellBookFrame's Show All Spell Ranks checkbox. */
  readonly getCVarBool?: (name: string) => boolean | undefined;
  readonly setCVar?: (name: string, value: boolean) => void;
  /** Optional settings-backed string CVar bridge used by stock options panels. */
  readonly settingsCVar?: FrameXmlSettingsCVarAdapter;
  /** Optional host bridge for FrameXML's `SendChatMessage`; called only for valid payloads. */
  readonly sendChatMessage?: FrameXmlChatSender;
  /** Cached item texture resolver; it must not perform network I/O from a C-API read. */
  readonly itemTexture?: (entry: number) => string | undefined;
  /** Cached item metadata for quest rewards; it must not perform network I/O from a C-API read. */
  readonly itemInfo?: (entry: number) => FrameXmlQuestItemMetadata | undefined;
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
}

interface LiveContainer {
  readonly id: number;
  readonly slots: readonly ItemSlotState[];
  readonly name: string | undefined;
  readonly bagFamily: number | undefined;
}

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
    && typeof row.standingId === "number" && Number.isFinite(row.standingId)
    && typeof row.barMin === "number" && Number.isFinite(row.barMin)
    && typeof row.barMax === "number" && Number.isFinite(row.barMax)
    && typeof row.barValue === "number" && Number.isFinite(row.barValue)
    && typeof row.canToggleAtWar === "boolean"
    && typeof row.isHeader === "boolean"
    && typeof row.isChild === "boolean"
    && typeof row.hasRep === "boolean";
}

export class LiveWorldSeam implements FrameXmlWorldSeam {
  realmName(): string | undefined {
    return this.#context.world()?.realmName;
  }

  readonly name = "live";
  readonly #context: LiveWorldSeamContext;
  #pump: FrameXmlSeamPump | undefined;
  readonly #unsubscribe: (() => void)[] = [];
  #polledAt = 0;
  /** The last published shape of the bar, so a change fires one event instead of sixty a second. */
  #barSignature = "";
  #cooldownSignature = "";
  #spellSignature = "";
  #spellCooldownSignature = "";
  /** Last vendor list shape delivered to stock MerchantFrame. */
  #merchantSignature = "";
  #trainerSelection: number | undefined;
  readonly #trainerFilters = new Map<string, boolean>([
    ["available", true], ["unavailable", true], ["used", true],
  ]);
  /** Last published stock bag-id shapes; inventory fields are coalesced by WorldStore.any. */
  #containerSignatures = new Map<number, string>();
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
  /** The world deletes a cast before emitting STOP; retain only its identity until that edge. */
  readonly #castStates = new Map<bigint, LiveCastState>();

  constructor(context: LiveWorldSeamContext) {
    this.#context = context;
    this.#skillResolvers = createFrameXmlSkillResolvers(() => ({
      player: this.#self(),
      playerRevision: this.#skillRevision,
      talent: this.#context.skillMetadata?.(),
    }));
    this.#talentResolvers = createFrameXmlTalentResolvers(() => ({
      player: this.#self(),
      playerRevision: this.#talentRevision,
      talents: this.#context.world()?.talents,
      talentsRevision: this.#talentRevision,
      talent: this.#context.talentMetadata?.(),
    }));
  }

  attach(pump: FrameXmlSeamPump): void {
    // A mount/unmount can reattach the same seam. Do not leave the old packet listeners alive.
    if (this.#pump) this.detach();
    this.#pump = pump;
    // Reattachment can follow a world reset. The first poll must describe the new world's current
    // state, not compare it with the old world's signatures.
    this.#polledAt = Number.NEGATIVE_INFINITY;
    this.#barSignature = "";
    this.#cooldownSignature = "";
    this.#spellSignature = "";
    this.#spellCooldownSignature = "";
    this.#merchantSignature = "";
    this.#trainerSelection = undefined;
    this.#trainerFilters.set("available", true);
    this.#trainerFilters.set("unavailable", true);
    this.#trainerFilters.set("used", true);
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
      this.#unsubscribe.push(store.field(SELF, "UNIT_FIELD_MAXHEALTH", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.maxHealth, "player");
      }));
      this.#unsubscribe.push(store.field(SELF, "UNIT_FIELD_LEVEL", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.levelUp);
        // MainMenuBar listens to PLAYER_LEVEL_UP, while PlayerFrame.lua listens to UNIT_LEVEL. The
        // same server field drives both paths; dropping the latter leaves PlayerLevelText stale.
        pump.fire(FRAMEXML_SEAM_EVENTS.unitLevel, "player");
      }));
      this.#unsubscribe.push(store.field(SELF, "PLAYER_XP", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.experience);
      }));
      // Inventory fields have no named WorldStore event. `any` is the store's coalesced mutation
      // edge, so one packet batch produces at most one BAG_UPDATE per changed stock container and
      // one PLAYER_MONEY edge for changed coinage.
      const any = (store as unknown as {
        any?: (listener: () => void) => (() => void);
      }).any;
      if (typeof any === "function") {
        this.#unsubscribe.push(any.call(store, () => {
          this.#reconcileContainers();
          this.#reconcileMoney();
          // Item-objective progress is derived from the same carried fields. The signature gate
          // keeps ordinary inventory changes quiet when no quest objective count moved.
          this.#publishQuestLogChange();
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
      // INIT_WORLD_STATES is the authoritative map/zone/area edge. The same primitive comparison
      // is also run in tick because mapId can become known on the movement path first.
      this.#reconcileZone(true);
      // ChatFrame_OnLoad initially registers only channel traffic. Configure its saved window
      // groups before replaying lines so the initial backlog reaches the freshly loaded frame.
      // Real WorldClient always owns a channel Map.  Keep older focused seam doubles that only
      // model auras/casts/minimap free of a synthetic chat configuration edge.
      if (world.channels instanceof Map) pump.fire(FRAMEXML_SEAM_EVENTS.chatWindowsUpdated);
      this.#replayChat(world, pump);
      const previousGroupCallback = world.onGroupChanged;
      const groupCallback = () => {
        try {
          previousGroupCallback?.();
        } finally {
          this.#reconcileParty();
          pump.fire(FRAMEXML_SEAM_EVENTS.partyLeaderChanged);
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
      this.#unsubscribe.push(world.events.on("PET_BAR_CHANGED", () => {
        this.#reconcilePet(true);
      }));
      this.#unsubscribe.push(world.events.on("TALENTS_CHANGED", ({ pet }) => {
        // WorldClient emits once per authoritative talent packet/reset. Do not poll this edge:
        // stock Blizzard_TalentUI relies on exactly one PLAYER_TALENT_UPDATE per player packet.
        if (pet) return;
        this.#talentRevision += 1;
        this.#pump?.fire(FRAMEXML_SEAM_EVENTS.talentsChanged);
      }));
      this.#unsubscribe.push(world.events.on("CHAT_MESSAGE", (message) => {
        this.#emitChatMessage(pump, world, message);
      }));
      this.#unsubscribe.push(world.events.on("CHANNEL_CHANGED", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.chatWindowsUpdated);
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
      this.#unsubscribe.push(world.events.on("SPELL_LEARNED", () => {
        this.#invalidateSpellEntries();
        pump.fire(FRAMEXML_SEAM_EVENTS.spellsChanged);
        pump.fire(FRAMEXML_SEAM_EVENTS.learnedSpellInTab);
        this.#spellSignature = this.#spellShapeSignature(world);
      }));
      this.#unsubscribe.push(world.events.on("SPELL_COOLDOWN_STARTED", () => {
        pump.fire(FRAMEXML_SEAM_EVENTS.spellUpdateCooldown);
        this.#spellCooldownSignature = this.#spellCooldownShapeSignature(world);
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
        if (event.kind === "item") {
          // Item quality/name/bag-family metadata can arrive after the inventory update. The
          // signature includes those resolved fields, so ContainerFrame gets one redraw without
          // asking the query cache from a render loop.
          this.#reconcileContainers();
          // QuestInfo reward rows use the same synchronous item metadata cache. Once a query
          // arrives, repaint the selected log so an unresolved row becomes a real icon/name.
          this.#publishQuestLogChange();
          return;
        }
        if (event.kind === "gameObject") {
          this.#publishQuestLogChange();
          return;
        }
        if (event.kind !== "creature") return;
        this.#publishQuestLogChange();
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
  }

  #selfGuid(): bigint | undefined {
    return this.#context.world()?.state.selfGuid;
  }

  /** Emit one parsed line, translating the GUID/name boundary before Lua sees it. */
  #emitChatMessage(pump: FrameXmlSeamPump, world: WorldClient, message: ChatMessage): void {
    if (message.language === (LANG_ADDON | 0) || message.type === CHAT_MSG_ADDON) return;
    const mappedEventName = frameXmlChatEventName(message.type);
    const eventName = mappedEventName ?? "CHAT_MSG_SYSTEM";
    const fallback = mappedEventName === undefined;
    const channel = message.type === CHAT_MSG_CHANNEL
      ? this.#channelInfo(world, message.channel)
      : undefined;
    // A channel line without a joined-channel match would be dropped by stock ChatFrame anyway;
    // suppressing it here also keeps the seam honest while the native chat is owned by FrameXML.
    if (message.type === CHAT_MSG_CHANNEL && channel === undefined) return;
    const displayMessage: ChatMessage = fallback
      ? {
        ...message,
        type: CHAT_MSG_SYSTEM,
        language: 0,
        senderGuid: 0n,
        senderName: "",
        receiverGuid: 0n,
        receiverName: "",
        channel: "",
        tag: 0,
      }
      : message;
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
    );
    pump.fire(eventName, ...args);
  }

  /** Resolve an incoming channel name to stock ChatFrame's 1-based current channel slot. */
  #channelInfo(world: WorldClient, channel: string): LiveChatChannel | undefined {
    if (!channel || !(world.channels instanceof Map)) return undefined;
    const wanted = shortChannelName(channel);
    let index = 1;
    for (const name of world.channels.keys()) {
      if (typeof name !== "string") {
        index += 1;
        continue;
      }
      const shortName = shortChannelName(name);
      if (shortName === wanted) {
        return {
          number: index,
          shortName,
          displayName: displayChannelName(name, index),
        };
      }
      index += 1;
    }
    return undefined;
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

  #liveContainers(world = this.#context.world()): Map<number, LiveContainer> {
    const result = new Map<number, LiveContainer>();
    if (!world) return result;
    // Focused seams may expose a world shell before its object map is ready. Inventory reads are
    // unavailable in that snapshot; leave the container projection empty until it is authoritative.
    if (typeof world.state.objects?.get !== "function") return result;
    const inventory = playerInventory(world.state);
    if (!inventory) return result;
    for (const id of [-2, 0, 1, 2, 3, 4]) {
      const container = this.#liveContainer(id, inventory, world);
      if (container) result.set(id, container);
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
    const next = this.#liveContainers();
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

  #itemTemplate(world: WorldClient | undefined, entry: number) {
    return world && world.itemTemplates instanceof Map ? world.itemTemplates.get(entry) : undefined;
  }

  #itemTexture(entry: number): string | undefined {
    const texture = entry > 0 ? this.#context.itemTexture?.(entry) : undefined;
    return texture || undefined;
  }

  // ---- merchant ---------------------------------------------------------

  #vendorItems(world: WorldClient | undefined): readonly VendorItem[] {
    const items = world?.vendor?.items;
    if (!items) return [];
    // ItemExtendedCost is not represented by this client yet.  Keep those rows out of the stock
    // money-only page instead of exposing a clickable row whose alternate-currency branch cannot
    // be answered truthfully.
    return items.filter((item) => item.extendedCost === 0);
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
    // Keep unsupported ItemExtendedCost rows out of the lifecycle signature too. They are not
    // rendered by this money-only page, so changing one must not cause a pointless Lua redraw.
    return [vendor.guid.toString(), vendor.error ?? "", this.#merchantNameFor(world) ?? "",
      ...this.#vendorItems(world).map((item) => {
        const metadata = this.#context.itemInfo?.(item.itemId);
        const template = this.#itemTemplate(world, item.itemId);
        return [
          item.slot, item.itemId, item.displayId, item.leftInStock, item.price, item.buyCount,
          item.extendedCost, metadata?.name ?? (template?.found ? template.name : "") ?? "",
          metadata?.texture ?? this.#itemTexture(item.itemId) ?? "",
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
    const supported = item.extendedCost === 0;
    const available = item.leftInStock !== 0;
    return [name, texture, item.price, item.buyCount, item.leftInStock, supported && available, false];
  }

  merchantItemLink(_index: number): string | undefined {
    // Vendor packets contain no item link and constructing one would fabricate enchant/seed data.
    return undefined;
  }

  merchantItemMaxStack(index: number): number {
    const item = this.#vendorItem(index);
    if (!item) return 0;
    return this.#itemTemplate(this.#context.world(), item.itemId)?.stackable ?? 0;
  }

  merchantItemCostInfo(_index: number): FrameXmlMerchantCostInfo {
    // ItemExtendedCost/currency ownership is not represented by this client's vendor snapshot.
    return [0, 0, 0];
  }

  merchantItemCostItem(_index: number, _costIndex: number): readonly [string, number, string] | undefined {
    return undefined;
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

  buybackItemLink(_index: number): string | undefined { return undefined; }

  buyMerchantItem(index: number, count: number): void {
    const item = this.#vendorItem(index);
    if (!item || item.extendedCost !== 0 || item.leftInStock === 0 || !Number.isInteger(count) || count < 1) return;
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
    // Selection is a plain WorldClient property: `selectTarget` sends the packet but intentionally
    // emits no EventBus edge. Reconcile it before the throttled reads so a click is visible on the
    // next rendered frame rather than waiting for the 60 ms data poll.
    this.#reconcileTarget();
    this.#reconcileTargetTarget();
    this.#reconcileFocus();
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
    }
    // Inventory fields are event-driven through WorldStore.any; this bounded poll only catches
    // focused seam doubles and cached texture changes which have no named world event.
    this.#reconcileContainers();
    this.#reconcilePaperDoll();
    // Coinage normally arrives through the named WorldStore field subscription; this bounded
    // fallback also catches focused seam doubles that mutate the player without flushing fields.
    this.#reconcileMoney();
    // The spell list and cooldown map are not update fields. Keep their signatures primitive and
    // sample them at the same 60 ms boundary as the action bar, so removal/initial replacement
    // (which have no dedicated EventBus edge) still redraw the stock book without a per-rAF walk.
    const spellSignature = this.#spellShapeSignature(world);
    if (spellSignature !== this.#spellSignature) {
      this.#invalidateSpellEntries();
      this.#spellSignature = spellSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.spellsChanged);
    }
    const spellCooldownSignature = this.#spellCooldownShapeSignature(world);
    if (spellCooldownSignature !== this.#spellCooldownSignature) {
      this.#spellCooldownSignature = spellCooldownSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.spellUpdateCooldown);
    }
    // Group membership normally arrives through WorldClient.onGroupChanged. Keep this existing
    // bounded poll only as a fallback for hosts that mutate the snapshot without invoking it;
    // never scan the roster on every rendered frame.
    this.#reconcileParty();

    const auraSignature = this.#auraShapeSignature("player");
    if (auraSignature !== this.#auraSignature) {
      this.#auraSignature = auraSignature;
      pump.fire(FRAMEXML_SEAM_EVENTS.aura, "player");
    }
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
      .map((button) => `${button.slot}:${button.type}:${button.action}`).join(",");
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
    // supplies the exact renderer-compatible texture without making this read perform I/O. Lock
    // and readable bits are not present in the current item update state and remain nil.
    return [this.#itemTexture(entry), stackCount(item), undefined,
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

  containerItemCooldown(): FrameXmlContainerItemCooldown {
    // WorldClient parses no per-item cooldown table (only spell/action cooldowns are retained).
    return [0, 0, 0];
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
    world.useItem(item.bag, item.slot, item.guid);
  }

  // ---- paper doll -------------------------------------------------------

  inventorySlotInfo(name: string): FrameXmlInventorySlotInfo | undefined {
    return frameXmlInventorySlotInfo(name);
  }

  #equipmentSlot(unit: string, slot: number): ItemSlotState | undefined {
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

  inventoryItemTexture(unit: string, slot: number): string | undefined {
    const item = this.#equipmentSlot(unit, slot)?.item;
    return item ? this.#itemTexture(entryOf(item)) : undefined;
  }

  inventoryItemLink(unit: string, slot: number): string | undefined {
    return this.#itemLink(this.#equipmentSlot(unit, slot)?.item);
  }

  #itemLink(item: WorldObjectState | undefined): string | undefined {
    if (!item) return undefined;
    const entry = entryOf(item);
    if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
    const world = this.#context.world();
    const template = this.#itemTemplate(world, entry);
    const metadata = this.#context.itemInfo?.(entry);
    const name = template?.found ? template.name : metadata?.name;
    const quality = template?.found ? template.quality : metadata?.quality;
    const color = QUALITY_LINK_COLORS[quality ?? 1] ?? QUALITY_LINK_COLORS[1];
    const enchantOffset = UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset;
    const enchant = (index: number): number => item.fields.get(enchantOffset + index * 3) ?? 0;
    const random = (readField(item, "ITEM_FIELD_RANDOM_PROPERTIES_ID") ?? 0) | 0;
    const suffix = readField(item, "ITEM_FIELD_PROPERTY_SEED") ?? 0;
    const player = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    const level = player ? readField(player, "UNIT_FIELD_LEVEL") ?? 0 : 0;
    // TSItem::GetItemLink uses permanent, three socket and socket-bonus enchantments, then suffix/level.
    return `|c${color}|Hitem:${entry}:${enchant(0)}:${enchant(2)}:${enchant(3)}:${enchant(4)}:${enchant(5)}:${random}:${suffix}:${level}|h[${name || "Item"}]|h|r`;
  }

  /** Item identity for GameTooltip; all reads stay on the already-cached world snapshot. */
  inventoryItemTooltip(unit: string, slot: number): FrameXmlInventoryTooltipItem | undefined {
    const state = this.#equipmentSlot(unit, slot);
    if (!state?.item) return undefined;
    const entry = entryOf(state.item);
    if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
    const world = this.#context.world();
    const template = this.#itemTemplate(world, entry);
    const metadata = this.#context.itemInfo?.(entry);
    const result: FrameXmlInventoryTooltipItem = {
      entry, count: stackCount(state), enchantments: itemEnchantmentIds(state.item),
      ...(template?.found === true ? { template } : {}),
      ...(metadata && metadata.name.length > 0 ? { metadata: {
        entry, name: metadata.name, displayId: 0,
        quality: metadata.quality ?? (template?.found === true ? template.quality : 0),
        inventoryType: template?.found === true ? template.inventoryType : 0,
        stackable: template?.found === true ? template.stackable : 0,
        iconId: 0,
      } } : {}),
    };
    const durability = readField(state.item, "ITEM_FIELD_DURABILITY");
    return typeof durability === "number" && Number.isFinite(durability) && durability >= 0
      ? { ...result, durability } : result;
  }

  inventoryItemCount(unit: string, slot: number): number {
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

  inventoryItemCooldown(): FrameXmlContainerItemCooldown {
    // WorldClient has no per-item cooldown table. Keep the stock neutral triple rather than
    // deriving one from an action or spell cooldown with different semantics.
    return [0, 0, 0];
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
    // Equipment and bag use share the existing authoritative opcode bridge. Do not synthesize a
    // client-side equip/use operation when the world has not exposed an item to that bridge.
    world.useItem(item.bag, item.slot, item.guid);
  }

  pickupInventoryItem(): void {
    // There is currently no authoritative WorldClient pickup bridge. A no-op is safer than
    // reusing move/equip operations, whose server semantics and acknowledgement differ.
  }

  // ---- quest log and tracker --------------------------------------------

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
    if (!entry) return undefined;
    const templates = this.#context.world()?.questTemplates;
    return templates instanceof Map ? templates.get(entry.questId) : undefined;
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
      const have = entry.counters[objectiveIndex] ?? 0;
      const world = this.#context.world();
      const resolvedName = objective.gameObject
        ? world?.gameObjectTemplates?.get(objective.entry)?.name
        : this.#context.creatureInfo?.(objective.entry)?.name
          ?? world?.creatureTemplates?.get(objective.entry)?.name;
      const text = questObjectiveLabel({
        kind: objective.gameObject ? "gameObject" : "creature",
        id: objective.entry,
        poiIndex: objectiveIndex,
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
        poiIndex: QUEST_OBJECTIVES + objectiveIndex,
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
          objective.entry, objective.count, objective.gameObject, objective.itemDrop, objective.text,
          objective.gameObject
            ? this.#context.world()?.gameObjectTemplates?.get(objective.entry)?.name ?? ""
            : this.#context.creatureInfo?.(objective.entry)?.name
              ?? this.#context.world()?.creatureTemplates?.get(objective.entry)?.name ?? "",
        ].join(":")),
        ...(template?.itemObjectives ?? []).map((objective) => [
          objective.itemId, objective.count, carried?.get(objective.itemId) ?? "?",
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
    const base = this.#signed(this.#fieldAtOffset(object, "UNIT_FIELD_STAT0", i));
    const positive = this.#signed(this.#fieldAtOffset(object, "UNIT_FIELD_POSSTAT0", i));
    const negative = this.#signed(this.#fieldAtOffset(object, "UNIT_FIELD_NEGSTAT0", i));
    return [base, base + positive + negative, positive, negative];
  }

  unitResistance(unit: string, index: number): FrameXmlUnitStat {
    const object = this.#unitObject(unit);
    const i = Number.isInteger(index) ? index : -1;
    if (!object || i < 0 || i >= 7) return [0, 0, 0, 0];
    const base = this.#signed(this.#rawField(object, "UNIT_FIELD_RESISTANCES", i));
    const positive = this.#signed(this.#rawField(object, "UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE", i));
    const negative = this.#signed(this.#rawField(object, "UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE", i));
    return [base, base + positive + negative, positive, negative];
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
      ].join(":")).join("|");
    }
    if (kind === "stats") {
      return Array.from({ length: 5 }, (_, index) => this.unitStat("player", index + 1).join(":")).join("|");
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
    const rows: readonly ["inventory" | "stats" | "resistance" | "attackPower" | "rangedAttackPower" | "attackSpeed" | "damage" | "rangedDamage" | "damageModifier", string, string][] = [
      ["inventory", "#inventorySignature", FRAMEXML_SEAM_EVENTS.inventoryChanged],
      ["stats", "#statsSignature", FRAMEXML_SEAM_EVENTS.stats],
      ["resistance", "#resistanceSignature", FRAMEXML_SEAM_EVENTS.resistances],
      ["attackPower", "#attackPowerSignature", FRAMEXML_SEAM_EVENTS.attackPower],
      ["rangedAttackPower", "#rangedAttackPowerSignature", FRAMEXML_SEAM_EVENTS.rangedAttackPower],
      ["attackSpeed", "#attackSpeedSignature", FRAMEXML_SEAM_EVENTS.attackSpeed],
      ["damage", "#damageSignature", FRAMEXML_SEAM_EVENTS.damage],
      ["rangedDamage", "#rangedDamageSignature", FRAMEXML_SEAM_EVENTS.rangedDamage],
      ["damageModifier", "#damageModifierSignature", FRAMEXML_SEAM_EVENTS.damageDoneMods],
    ];
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
      pump.fire(event, "player");
    }
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
    if (unit === "pet") return this.#pet();
    return this.#partyObject(unit);
  }

  #unitGuid(unit: string): bigint | undefined {
    const object = this.#unit(unit);
    if (object) return object.guid;
    return this.#partyMember(unit)?.guid;
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

  /** Publish one UNIT_PET edge for a real pet bar/object identity transition. */
  #reconcilePet(force = false): void {
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
    const metadata = this.#metadata(slot);
    // An empty `iconPath` is a real answer on this dataset — `SpellIcon` has no row for the id —
    // and the corpus' own branch for a missing texture hides the icon and shows the empty
    // quickslot art, which is exactly right.
    return metadata?.iconPath || undefined;
  }

  /** Only a macro carries text on a bar, and its name is the text. */
  actionText(slot: number): string | undefined {
    const button = this.#button(slot);
    return button?.type === ACTION_BUTTON_MACRO ? String(button.action) : undefined;
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
    return this.isStackableAction(slot) ? 1 : 0;
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
    if (!world || !pump || !button || button.type !== ACTION_BUTTON_SPELL) return [0, 0, 0];
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
    if (button.type !== ACTION_BUTTON_SPELL) return [true, false];
    const metadata = this.#metadata(slot);
    if (!metadata) return [true, false];
    if (metadata.passive) return [false, false];
    const world = this.#context.world();
    if (world && world.cooldownRemaining(button.action, this.#context.monotonic()) > 0) {
      return [false, false];
    }
    return [true, false];
  }

  isConsumableAction(slot: number): boolean {
    return this.#button(slot)?.type === ACTION_BUTTON_ITEM;
  }

  isStackableAction(slot: number): boolean {
    return this.#button(slot)?.type === ACTION_BUTTON_ITEM;
  }

  isEquippedAction(): boolean {
    return false;
  }

  isCurrentAction(slot: number): boolean {
    const button = this.#button(slot);
    const world = this.#context.world();
    if (!button || !world || button.type !== ACTION_BUTTON_SPELL) return false;
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

  /**
   * Which page the FrameXML bar is on.
   *
   * 1 rather than the DOM bar's current page, deliberately: the DOM bar's `page` is a module-level
   * `let` inside `ui/ActionBar.ts` with no accessor, and reaching into it would make two interfaces
   * share one piece of hidden state. The FrameXML bar has `ActionBar_PageUp`/`PageDown` of its own
   * and `ChangeActionBarPage` is the seam it would write through — F4's, not this slice's.
   */
  actionBarPage(): number {
    return 1;
  }

  bonusBarOffset(): number {
    return 0;
  }

  /**
   * The only outbound chat path exposed to FrameXML. The host owns the world connection; this seam
   * only resolves the stock token and applies the server's byte limit before invoking it.
   */
  sendChatMessage(text: string, type: string, language: number | undefined, target: FrameXmlChatTarget): void {
    const code = frameXmlChatTypeCode(type);
    if (code === undefined || !frameXmlChatTextIsValid(text)) return;
    const resolvedTarget = typeof target === "number"
      ? code === CHAT_MSG_CHANNEL ? this.#channelTarget(target) : undefined
      : target;
    if (resolvedTarget === undefined) return;
    this.#context.sendChatMessage?.(text, code, language, resolvedTarget);
  }

  chatWindowMessages(windowId: number): readonly string[] {
    return windowId === 1 ? FRAMEXML_CHAT_WINDOW_GROUPS : [];
  }

  chatWindowChannels(windowId: number): FrameXmlChatWindowChannels {
    if (windowId !== 1) return [];
    const channels = this.#context.world()?.channels;
    if (!(channels instanceof Map)) return [];
    const result: (string | number)[] = [];
    for (const name of channels.keys()) {
      if (typeof name !== "string") continue;
      result.push(shortChannelName(name), 0);
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
    if (windowId === 1) return ["Общий", 14, 1, 1, 1, 0, true, true, true, false];
    return ["", 0, 1, 1, 1, 0, false, true, false, false];
  }

  useAction(slot: number): void {
    const button = this.#button(slot);
    if (!button || button.type !== ACTION_BUTTON_SPELL) return;
    this.#context.castSpell(button.action);
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

  unitExists(unit: string): boolean {
    if (unit.toLowerCase() === "npc") return this.#context.world()?.vendor !== undefined
      || this.#context.world()?.trainer !== undefined;
    return this.#unit(unit) !== undefined || this.#partyMember(unit) !== undefined;
  }

  unitName(unit: string): string | undefined {
    if (unit.toLowerCase() === "npc") {
      const world = this.#context.world();
      if (world?.vendor) return this.#merchantName();
      const trainer = world?.trainer;
      if (!trainer) return undefined;
      const object = world.state.objects.get(trainer.guid);
      return (object ? this.#targetNameFor(object) : undefined) ?? world.names.get(trainer.guid);
    }
    return this.#partyMember(unit)?.name ?? this.#targetNameFor(this.#unit(unit));
  }

  unitPvpName(unit: string): string | undefined {
    // The world protocol supplies the character's display name, but not the optional title/PvP
    // name record.  UnitPVPName therefore has the same truthful answer as UnitName until that
    // cache exists; returning nil here makes CharacterFrame print a literal "nil".
    return this.unitName(unit);
  }

  unitLevel(unit: string): number | undefined {
    const object = this.#unit(unit);
    return (object ? unitField.level(object) : undefined) ?? this.#partyStats(unit)?.level;
  }

  /** `UnitClass` answers the merged localised class name and the stock uppercase file token. */
  unitClass(unit: string): readonly [string, string] | undefined {
    const object = this.#unit(unit);
    if (object?.typeId !== TYPEID_PLAYER) return undefined;
    const classId = object ? unitField.classId(object) : undefined;
    const token = classId === undefined ? undefined : CLASS_TOKENS[classId];
    return token === undefined ? undefined : [className(classId), token];
  }

  unitRace(unit: string): readonly [string, string] | undefined {
    const object = this.#unit(unit);
    if (object?.typeId !== TYPEID_PLAYER) return undefined;
    const raceId = unitField.race(object);
    const token = raceId === undefined ? undefined : RACE_TOKENS[raceId];
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

  partyMemberCount(): number {
    const group = this.#context.world()?.group;
    return group && (group.groupType & GROUPTYPE_RAID) === 0
      ? Math.min(4, group.members.length)
      : 0;
  }

  raidMemberCount(): number {
    const group = this.#context.world()?.group;
    return group && (group.groupType & GROUPTYPE_RAID) !== 0
      ? group.members.length
      : 0;
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

  partyMember(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 1 || index > 4) return undefined;
    const group = this.#context.world()?.group;
    if (!group || (group.groupType & GROUPTYPE_RAID) !== 0) return undefined;
    return group.members[index - 1]?.name;
  }

  targetUnit(unit: string): void {
    const world = this.#context.world();
    const guid = this.#unitGuid(unit);
    if (!world || guid === undefined || guid === 0n) return;
    world.selectTarget(guid);
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
    return [petSpells !== undefined && petSpells.guid !== 0n, false];
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
      : undefined;
  }

  unitChannelInfo(unit: string): FrameXmlChannelInfo | undefined {
    return unit === "player" || unit === "target" || unit === "focus"
      || unit === "targettarget" || unit === "pet"
      ? this.#castInfo(unit, true) as FrameXmlChannelInfo | undefined
      : undefined;
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
      row.skillMaxRank, false, undefined, undefined, 0, 0, ""];
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

  // ---- player talents ----------------------------------------------------

  talentSnapshot(): FrameXmlTalentSnapshot | undefined {
    return this.#talentResolvers.talentSnapshot();
  }

  learnTalent(tab: number, index: number, pet: boolean | undefined, group: number | undefined): void {
    if (pet === true) return;
    const world = this.#context.world();
    const snapshot = this.#talentResolvers.talentSnapshot();
    if (!world || !snapshot) return;
    const requestedGroup = group === undefined || !Number.isInteger(group)
      ? snapshot.activeTalentGroup : Math.trunc(group);
    if (requestedGroup !== snapshot.activeTalentGroup) return;
    const groupSnapshot = snapshot.groups[requestedGroup - 1];
    const cell = groupSnapshot?.tabs[tab - 1]?.talents[index - 1];
    if (!groupSnapshot?.active || !cell || cell.maxRank <= 0 || cell.rank >= cell.maxRank
      || groupSnapshot.unspentPoints === undefined || groupSnapshot.unspentPoints <= 0
      || cell.meetsPrereq !== true) return;
    world.learnTalent(cell.id, cell.rank + 1);
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
    return [
      state,
      row?.name,
      status.clientInstanceId,
      status.minLevel,
      status.maxLevel,
      row?.maxGroupSize ?? 0,
      status.rated,
    ];
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

  spellTabInfo(index: number): FrameXmlSpellTabInfo | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    return this.#spellTabs()[index - 1];
  }

  spellName(index: number, _bookType: string | undefined): readonly [string, string] | undefined {
    const id = this.#spellEntry(index)?.id;
    const metadata = id === undefined ? undefined : this.#context.spell(id);
    return metadata === undefined ? undefined : [metadata.name, metadata.rank];
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
    if (!snapshot || snapshot.endsAt <= monotonic || !pump) return [0, 0, 0];
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

  knownSlotFromHighestRankSlot(index: number, _bookType: string | undefined): number | undefined {
    return this.#spellEntry(index) === undefined ? undefined : index;
  }

  spellIsSelected(index: number, _bookType: string | undefined): boolean {
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
    // The world owns the list and publishes its own packet/event edges. The call is retained as a
    // truthful no-op because stock SpellBookFrame invokes it during OnLoad/PLAYER_ENTERING_WORLD.
    this.#invalidateSpellEntries();
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

  /** Resting is a client-side flag this client does not model; 1 is «Normal», as F3's canned seam. */
  restState(): readonly [number, string, number] {
    return [1, "Normal", 1];
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
}

/** `Classes`, from the core's own enum; index is `UNIT_FIELD_BYTES_0`'s class byte. */
const CLASS_TOKENS: readonly (string | undefined)[] = Object.freeze([
  undefined, "WARRIOR", "PALADIN", "HUNTER", "ROGUE", "PRIEST", "DEATHKNIGHT",
  "SHAMAN", "MAGE", "WARLOCK", undefined, "DRUID",
]);

/** Object type ids in the 3.3.5 update block. */
const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

/** `CreatureTemplate.classification`, in the order sent by QueryCreatureResponse. */
const CREATURE_CLASSIFICATIONS: readonly string[] = Object.freeze([
  "normal", "elite", "rareelite", "worldboss", "rare",
]);
