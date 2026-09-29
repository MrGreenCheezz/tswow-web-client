import { GlueLoadScheduler } from "../glue/GlueLoadScheduler.js";
import { gatewayOrigin as defaultGatewayOrigin, clientLocale } from "../Environment.js";
import { createHttpFileProvider } from "../glue/GlueLoader.js";
import { game, registerWorldContextCleanup } from "../game/Context.js";
import { reactionBetween, setFocusGuid } from "../game/Targeting.js";
import { castSpell } from "../ui/Spellbook.js";
import { getActionBarPage, turnActionPage, useSlot } from "../ui/ActionBar.js";
import { ensureSpellNames } from "../ui/SpellNames.js";
import { playNamedUiSound } from "../game/GameSounds.js";
import { setSetting, settings, watchSettingsApplied } from "../ui/Settings.js";
import { settingNumber } from "../ui/SettingsModel.js";
import { characterWindow, characterModel, characterSheetPane, gameWindows, gossipWindow, inventoryWindow, questWindow, spellbookWindow, trainerWindow, vendorWindow } from "../ui/Dom.js";
import { closeBagWindows } from "../ui/Bags.js";
import { hideTalentsWindow } from "../ui/Talents.js";
import { showQuestState, showTrainer, showVendor } from "../ui/Npc.js";
import {
  beginQuestLogNativeReplacement,
  restoreQuestLogNativeReplacement,
  type QuestLogNativeState,
} from "../ui/QuestLog.js";
import { GlueLuaRef } from "../glue/GlueLua.js";
import {
  toggleFrameXmlSpellBook, publishFrameXmlSpellBook,
} from "./FrameXmlSpellBookController.js";
import {
  publishFrameXmlTalent,
  toggleFrameXmlTalent,
  type FrameXmlTalentOwner,
} from "./FrameXmlTalentController.js";
import { showAuras } from "../ui/Auras.js";
import { repaintPlayerHud } from "../ui/Frames.js";
import { chatLog } from "../ui/Dom.js";
import { redrawChatLog } from "../ui/ChatDock.js";
// The stock chat input owner and C-API (chat lane); kept on their own lines beside the chat imports.
import { combatHistory, onCombatEntry } from "../ui/ChatDock.js";
import { nativeSlashCommands, onNativeSlashCommandsChanged, runNativeCommand } from "../ui/Chat.js";
import { macroUnitGuid, runCastCommand, runUseCommand } from "../ui/CombatCommands.js";
import { installFrameXmlStockChat } from "./FrameXmlChatApi.js";
import {
  adoptPartyPortraitCanvas,
  adoptFocusPortraitCanvas,
  adoptPetPortraitCanvas,
  adoptPlayerPortraitCanvas,
  adoptTargetPortraitCanvas,
  adoptTargetOfTargetPortraitCanvas,
  adoptFocusTargetPortraitCanvas,
  adoptQuestGiverPortraitCanvas,
  setQuestGiverPortrait,
  mountNativeCharacterPortrait,
} from "../ui/Portraits.js";
import { createFrameXmlStockPortraits, frameXmlPortraitUnitGuid } from "./FrameXmlPortraits.js";
import {
  adoptMinimapCanvas,
  currentAreaId,
  forgetMinimap,
  minimapWidgetAdapter,
} from "../ui/Minimap.js";
import { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { FrameXmlFontLoader } from "../ui/framexml_compat/FrameXmlFonts.js";
import { FrameXmlTextureCache } from "../ui/framexml_compat/FrameXmlTextures.js";
import { loadFrameXmlDeclensionDictionary } from "../ui/framexml_compat/FrameXmlDeclension.js";
import { FrameXmlWorldPerf, publishFrameXmlWorldPerf } from "./FrameXmlWorldPerf.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { unit, exploredZones, isAreaExplored, isPlayerGhost } from "../../world/Fields.js";
import { isWorldObjectDead } from "../../world/WorldState.js";
import type { FrameXmlFactionRow, FrameXmlQuestItemMetadata } from "./FrameXmlWorldSeam.js";
import type { FrameXmlTalentMetadata } from "./FrameXmlTalentResolver.js";
import { resolveFrameXmlReputationRows } from "./FrameXmlReputationResolver.js";
import { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } from "./FrameXmlBoot.js";
import { loadFrameXmlCharacterStats } from "./FrameXmlCharacterStats.js";
import { fetchFrameXmlClientAddons } from "./FrameXmlClientAddons.js";
import { isPatchChainChangedError, type PatchChainChangedError } from "../PatchChainChanged.js";
import {
  publishFrameXmlBags,
  type FrameXmlBagOwner,
} from "./FrameXmlBagController.js";
import { installOwnedGlobals, releaseOwnedGlobals } from "./FrameXmlBagCompat.js";
import {
  publishFrameXmlCharacter, frameXmlCharacterModelGate, createFrameXmlCharacterOwner,
  type FrameXmlCharacterOwner,
} from "./FrameXmlCharacterController.js";
import {
  frameXmlQuestGate,
  publishFrameXmlQuest,
  toggleFrameXmlQuest,
  type FrameXmlQuestOwner,
} from "./FrameXmlQuestController.js";
import { FRAMEXML_VERTICAL_TOC } from "./FrameXmlCorpus.js";
import { resetFrameXmlTooltipRedraws } from "./FrameXmlCharacterTooltip.js";
import { LiveWorldSeam } from "./LiveWorldSeam.js";
import { fetchFrameXmlWorldStates } from "./FrameXmlWorldStates.js";
import { mailDraftAttachments } from "../ui/Mail.js";
import { openCalendar, openNativeCalendar, toggleCalendar } from "../ui/Calendar.js";
import { FrameXmlCalendarCatalogClient, installFrameXmlCalendarRoutes, mountFrameXmlCalendar } from "./FrameXmlCalendarOwner.js";
import { closeWorldMap, toggleWorldMap } from "../ui/WorldMap.js";
import { frameXmlWorldMapGate } from "./FrameXmlWorldMapController.js";
import { publishFrameXmlWorldMap } from "./FrameXmlWorldMapPublication.js";
import { waitForFrameXmlLoginClock } from "./FrameXmlLoginClock.js";
import {
  compileFrameXmlWorldMouseoverScripts, createFrameXmlWorldMouseover,
} from "./FrameXmlWorldMouseover.js";
import { hoveredUnitGuid } from "../game/HoverTarget.js";
import {
  frameXmlQuestGiverStructureGate, hideIdleQuestRequiredMoneyFrame,
} from "./FrameXmlQuestGiverGate.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { FRAMEXML_PET_ACTION_SLOTS } from "./FrameXmlPetActionBar.js";
import { createFrameXmlSpellBookTabResolvers } from "./FrameXmlSpellBookTabs.js";
import { installFrameXmlCursorDom } from "./FrameXmlCursorDom.js";
import { createFrameXmlSettingsCVar } from "./FrameXmlSettingsCVar.js";
import { toggleSocialPanel } from "../ui/SocialPanel.js";
import { closeSocialPanel, openSocialTab, toggleSocialTab } from "../ui/SocialPanel.js";
import { closeGuildWindow, guildWindowOpen } from "../ui/Guild.js";
import { publishFrameXmlFriends, type FrameXmlFriendsOwner } from "./FrameXmlFriendsController.js";
import { createFrameXmlFriendsOwner, frameXmlFriendsGate, installFrameXmlFriendsRoutes } from "./FrameXmlFriendsOwner.js";
import { closeLfgWindow, toggleLfgWindow } from "../ui/Social.js";
import {
  cancelLogoutRequest, closeGameMenu, logoutPending, openDiagnosticsWindow, registerGameMenuAddonButton,
  requestQuitToLogin, resetWindowLayout, toggleGameMenu,
} from "../ui/GameMenu.js";
import { addModuleCommand, beginModuleCommandLoad, removeModuleCommands, systemLine } from "../ui/Chat.js";
import { toggleGmTickets } from "../ui/GmTickets.js";
import { discoverFrameXmlAddonEntrypoints } from "./FrameXmlAddonEntrypoints.js";
import { FrameXmlTsAddonPresentation, markFrameXmlNativeHud } from "./FrameXmlTsAddonPresentation.js";
import { mountFrameXmlAddonsOnlySurfaces, watchFrameXmlDialogLayer } from "./FrameXmlAddonsOnlyMessages.js";
import { createFrameXmlTsAddonWindows } from "./FrameXmlTsAddonWindows.js";
import { openCharacterWindow, registerEscapable } from "../ui/Windows.js";
import {
  closeFrameXmlQuestGiver, frameXmlQuestGiverOpen,
  notifyFrameXmlQuestGiverItemUpdate, publishFrameXmlQuestGiver,
} from "./FrameXmlQuestGiverController.js";
import { createFrameXmlQuestGiverMountOwner } from "./FrameXmlQuestGiverMount.js";
import type { FrameXmlQuestGiverOwner } from "./FrameXmlQuestGiverController.js";
import type { QuestDialog } from "../../world/NpcProtocol.js";
import { installFrameXmlNativeItemTooltip } from "./FrameXmlNativeItemTooltip.js";
import { FrameXmlModelPreview } from "./FrameXmlModelPreview.js";
import {
  FRAMEXML_BATTLEGROUND_TYPE_IDS,
  FrameXmlBattlegroundClient,
} from "./FrameXmlBattlegrounds.js";
import {
  publishFrameXmlPvp,
  toggleFrameXmlPvp,
  type FrameXmlPvpOwner,
} from "./FrameXmlPvpController.js";
import {
  publishFrameXmlMerchant,
  type FrameXmlMerchantOwner,
} from "./FrameXmlMerchantController.js";
import {
  publishFrameXmlTrainer,
  type FrameXmlTrainerOwner,
} from "./FrameXmlTrainerController.js";
import { mountFrameXmlAuction } from "./FrameXmlAuctionMount.js";
import { mountFrameXmlDressUp } from "./FrameXmlDressUpMount.js";
import { mountFrameXmlInspectSocketBarber } from "./FrameXmlInspectMount.js";
import { mountFrameXmlAchievement, provideFrameXmlAchievementCatalog } from "./FrameXmlAchievementMount.js";
import { toggleFrameXmlAchievement } from "./FrameXmlAchievementController.js";
import { mountFrameXmlGuildBank } from "./FrameXmlGuildBankMount.js";
import { mountFrameXmlRaidGrid } from "./FrameXmlRaidLod.js";
import { mountFrameXmlArenaEnemy } from "./FrameXmlArenaLod.js";
import { createFrameXmlGlyphExtension, type FrameXmlTalentLodExtension } from "./FrameXmlGlyphOwner.js";
import { mountFrameXmlToken } from "./FrameXmlTokenOwner.js";
import { publishFrameXmlGameMenu, type FrameXmlGameMenuOwner } from "./FrameXmlGameMenuController.js";
import {
  createFrameXmlGameMenuOwner, frameXmlGameMenuGate, installFrameXmlGameMenuButtons,
} from "./FrameXmlGameMenuOwner.js";
import { publishFrameXmlLfd, type FrameXmlLfdOwner } from "./FrameXmlLfdController.js";
import {
  createFrameXmlLfdOwner,
  frameXmlLfdGate,
  installFrameXmlLfdToggle,
} from "./FrameXmlLfdOwner.js";
import type { FrameXmlLootOwner } from "./FrameXmlLootController.js";
import {
  createFrameXmlLootOwner, frameXmlLootGate, installFrameXmlLootAdapters, publishFrameXmlLootMount,
} from "./FrameXmlLootOwner.js";
import { createFrameXmlLiveLootHost } from "./FrameXmlLootHost.js";
import { showLoot } from "../ui/Npc.js";
import { showLootRolls } from "../ui/LootRolls.js";
import { publishFrameXmlPopups, type FrameXmlPopupsOwner } from "./FrameXmlPopupsController.js";
import { createFrameXmlPopupsOwner, frameXmlPopupsGate, installFrameXmlPopupsAdapters } from "./FrameXmlPopupsOwner.js";
import { refreshFrameXmlPopupsNative } from "./FrameXmlPopupsNative.js";
import { publishFrameXmlMail, type FrameXmlMailOwner } from "./FrameXmlMailController.js";
import { createFrameXmlMailOwner, frameXmlMailGate } from "./FrameXmlMailOwner.js";
import { publishFrameXmlTrade, type FrameXmlTradeOwner } from "./FrameXmlTradeController.js";
import { createFrameXmlTradeOwner, frameXmlTradeGate } from "./FrameXmlTradeOwner.js";
// The TSK lane: load-on-demand Blizzard_TradeSkillUI in front of the native profession window.
import { frameXmlLiveTradeSkillHost, mountFrameXmlTradeSkill, type FrameXmlTradeSkillMount } from "./FrameXmlTradeSkillLive.js";
// The NPC lane: stock GossipFrame, BankFrame, TaxiFrame and ItemTextFrame as one publication unit.
import { mountFrameXmlNpcWindows } from "./FrameXmlGossipNpcMount.js";
import { showMail as showNativeMail } from "../ui/Mail.js";
import { showTrade as showNativeTrade } from "../ui/Social.js";
import { LfgDungeonClient } from "../LfgDungeons.js";
import { openSettingsSection } from "../ui/Settings.js";
import { keyBindingsOpen, toggleKeyBindingsWindow } from "../ui/KeyBindings.js";
import { macroWindowOpen, toggleMacroWindow } from "../ui/Macros.js";
import { openNativeKeyBindingsWindow } from "../ui/KeyBindings.js";
import { frameXmlMacroStore, openMacroWindow, openNativeMacroWindow } from "../ui/Macros.js";
import { runAction } from "../input/Actions.js";
import { FrameXmlMacroIconClient } from "./FrameXmlMacroIcons.js";
import { mountFrameXmlMacroBindingWindows } from "./FrameXmlMacroBindingMount.js";
import { mountFrameXmlOptions } from "./FrameXmlOptionsOwner.js";
import { frameXmlLiveOptionsHost } from "./FrameXmlOptionsLive.js";
import {
  NATIVE_FOCUS_REPLACED, NATIVE_LANES_REPLACED, NATIVE_MIRROR_TIMERS_REPLACED, NATIVE_TARGET_CONTEXT_REPLACED,
} from "../ui/NativeHudReplacement.js";

export { frameXmlFlagEnabled } from "./FrameXmlWorldPolicy.js";
import { frameXmlViewport } from "./FrameXmlWorldPolicy.js";

/** `WorldObjectState.typeId` of a player, as the other FrameXML resolvers spell it. */
const TYPEID_PLAYER = 4;
/** How often the addons-only mount re-measures the native owners it anchors stock frames to. */
const NATIVE_ANCHOR_INTERVAL_MS = 250;

/**
 * Build the stock reputation list from the two authoritative client tables.  The world owns the
 * character's 128 server slots and standing values; FactionClient owns the DBC name keyed by the
 * same reputation index.  Until both sides are ready, return an empty list rather than inventing
 * names or category headers.  ReputationFrame can therefore mount safely first and repopulate on
 * the existing REPUTATION_CHANGED/poll path when the metadata request completes.
 */
export function frameXmlLiveReputationRows(world: WorldClient): readonly FrameXmlFactionRow[] {
  return resolveFrameXmlReputationRows(world, game.factions);
}

/**
 * Shared world VM: enabled TSWoW modules overlay the native UI; the saved interface setting
 * selects the stock HUD, with `?framexml=1` retained as a diagnostic override.
 *
 * Three rules the slice set for it, and each is a line of code below rather than an intention.
 *
 * **It never blocks the world.** The whole module is loaded by a dynamic `import()` from
 * `EnterWorld.ts`. Both modes boot asynchronously after the world is already up. The addon-only
 * path below returns before the stock HUD gates and publishes no native replacement classes.
 * The subset keeps the stock dependencies needed by the loaded modules. When enabled, TSWoW
 * blocks are appended from the client's TOC and their byte cost belongs in each boot report.
 *
 * **Only the DOM lanes replaced by this vertical are hidden.** Once the renderer has mounted,
 * one owner class on `<body>` activates exact-ID CSS for the player HUD/cast, player-aura strip and
 * action-bar containers, plus the duplicate target shell. Optional classes are published only after
 * their own concrete stock gates pass: one owns exactly the target cast/aura lanes, and one owns
 * exactly the native pet frame after borrowing the existing pet portrait canvas. The minimap is
 * wholly stock: MinimapCluster borrows the native canvas and owns zoom, tracking, the world-map
 * button (routed to the gated map toggle) and Blizzard_TimeManager's clock, so the native
 * `#minimap` root is hidden as one element and the rest of the native rail starts below the
 * 192-unit cluster. The target rail itself stays present:
 * its native actions remain contextual UI outside this static slice. The core class is added only
 * after all renderer, Minimap, TargetFrame and portrait gates succeed; the optional target class is
 * added only after its own concrete structural/rendered gates. Both are removed during teardown;
 * no native `hidden` property or inline style is mutated. The overlay is
 * at `z-index: 3` — over both world canvases, under the native chat form (20), the windows (21/22)
 * and the menus (210). The optional chat display lane hides only the native tabs/log after its own
 * concrete FrameXML gates; the native form/input remains the command owner.
 *
 * **Its stylesheet is its own.** The four browser facts the widget renderer needs are written in
 * `glue/glue.css` scoped to `#glue-stage`, and `index.html` already owns one of those for the login
 * screens — so the rules are repeated here against this host's own id rather than an id being
 * shared between two lanes. That duplication is deliberate and is written down as a followup: the
 * proper home is one stylesheet both stages import.
 */

/** The host element's id, and the scope of every rule below. */
const HOST_ID = "framexml-world-host";
const STAGE_ID = "framexml-world-stage";
// The native lanes' per-frame updaters read these four to skip a lane nobody sees (NativeHudReplacement.ts).
const NATIVE_LANES_REPLACEMENT_CLASS = NATIVE_LANES_REPLACED;
const NATIVE_TARGET_CONTEXT_REPLACEMENT_CLASS = NATIVE_TARGET_CONTEXT_REPLACED;
const NATIVE_PET_REPLACEMENT_CLASS = "framexml-world-replaces-pet";
const NATIVE_PET_BAR_REPLACEMENT_CLASS = "framexml-world-replaces-pet-bar";
const NATIVE_PARTY_REPLACEMENT_CLASS = "framexml-world-replaces-party";
const NATIVE_CHAT_REPLACEMENT_CLASS = "framexml-world-replaces-chat";
const NATIVE_FOCUS_REPLACEMENT_CLASS = NATIVE_FOCUS_REPLACED;
const NATIVE_TOT_REPLACEMENT_CLASS = "framexml-world-replaces-tot";
const NATIVE_BAGS_REPLACEMENT_CLASS = "framexml-world-replaces-bags";
const NATIVE_CHARACTER_REPLACEMENT_CLASS = "framexml-world-replaces-character";
const NATIVE_MICROBUTTONS_REPLACEMENT_CLASS = "framexml-world-replaces-microbuttons";

/**
 * Visible top-level widgets that are allowed to paint in the world vertical.
 *
 * `FrameXmlBoot.roots` is intentionally a faithful list of every parentless XML declaration.  It
 * is not, however, a visibility/ownership list: stock XML also declares helper popups and dropdowns
 * at the top level, and some of those start visible in the browser bridge.  Mounting that list
 * blindly made `QuestInfoRequiredMoneyFrame`, `ChatChannelDropDown` and `ChatBNPlayerDropDown`
 * appear at the stage origin before any user opened a quest or chat menu.  Initially hidden roots are
 * retained below so their real Lua Show() lifecycle still works; only a visible root needs this
 * explicit world-owner proof.
 *
 * Keep this list narrow.  A new visible top-level root is a product/ownership decision, not a parser
 * detail.  Children of an admitted root continue to be reconciled by the renderer as usual.
 */
const FRAMEXML_WORLD_VISIBLE_ROOT_NAMES: ReadonlySet<string> = new Set([
  "UIParent",
  "MainMenuBar",
  "MainMenuBarArtFrame",
  "MultiBarBottomLeft",
  "MultiBarBottomRight",
  "MultiBarLeft",
  "MultiBarRight",
  "ShapeshiftBarFrame",
  "BonusActionBarFrame",
  "PlayerFrame",
  "CastingBarFrame",
  "BuffFrame",
  "MinimapCluster",
  "Minimap",
  "GameTimeFrame",
  "WorldStateAlwaysUpFrame",
  "TargetFrame",
  "FocusFrame",
  "TargetFrameToT",
  "PetFrame",
  // FloatingChatFrame.xml owns the primary dock and BN popout lifecycle.  These are
  // parentless in the boot root list but are real chat owners, not transient menus.
  "GeneralDockManager",
  "FloatingChatFrameManager",
  "QuestLogFrame",
  "WatchFrame",
  "QuestFrame",
  "SpellBookFrame",
  "CharacterFrame",
  "MerchantFrame",
  "ClassTrainerFrame",
  "PVPParentFrame",
  "PVPBattlegroundFrame",
  "ArenaFrame",
  "TimerTracker",
  "MirrorTimerFrame",
  // LFGFrame.xml:213 declares the finder's event owner parentless and shown, with no size or art.
  // Its LFG_* events reach it through the bridge either way; admitting it records it as a real
  // world owner (it drives LFG_UpdateQueuedList and the minimap eye) rather than a stray helper.
  "LFGEventFrame",
]);

const FRAMEXML_WORLD_VISIBLE_ROOT_PATTERNS: readonly RegExp[] = Object.freeze([
  /^ActionButton\d+$/,
  /^ChatFrame\d+(?:Tab|EditBox)?$/,
  /^PartyMemberFrame[1-4]$/,
  /^ContainerFrame(?:[1-9]|1[0-3])$/,
  /^(?:MirrorTimer|MirrorTimerFrame)\d+$/,
  /^(?:Boss\d+(?:Target)?Frame|ArenaEnemyFrame\d*|ArenaFramesContainer\d*)$/,
]);

/** Whether a visible top-level FrameXML root is an admitted world owner. */
export function frameXmlWorldVisibleRootAllowed(name: string): boolean {
  return FRAMEXML_WORLD_VISIBLE_ROOT_NAMES.has(name)
    || FRAMEXML_WORLD_VISIBLE_ROOT_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Select roots safe for the production world renderer.
 *
 * The input is deliberately typed as the real FrameXML shape so tests can pass tiny structural
 * fixtures while production keeps the frame identity and children untouched.  Hidden roots remain
 * mounted for future Show()/Hide() calls; visible roots must be explicitly admitted above.
 */
export function selectFrameXmlWorldRoots(
  roots: readonly FrameXmlFrame[],
  addonVisibleRoots: ReadonlySet<string> = new Set(),
): readonly FrameXmlFrame[] {
  const selected = roots.filter((root) => !root.visible
    || frameXmlWorldVisibleRootAllowed(root.name)
    || addonVisibleRoots.has(root.name));
  // `roots` is a snapshot of XML declarations taken before Lua lifecycle runs.  Once Lua has
  // assigned any parent (the stock chat path moves ChatFrame1Tab under GeneralDockManager), the
  // declaration is no longer a top-level owner.  Do not re-promote it even when that parent is a
  // rejected helper or a child that was itself reparented; explicit publication is required for
  // a detached lifecycle root.
  return selected.filter((root) => !root.parent);
}

/**
 * The stock micro-button row is a single owner, not ten independent decorations.  It is loaded in
 * the production TOC, but every button starts hidden and receives a host adapter before the first
 * synthetic session event.  That order matters: MainMenuBarMicroButtons.lua's event path assumes
 * optional Blizzard panels exist, while this route owns some of those panels lazily or delegates
 * them to an existing native surface.
 */
export const FRAMEXML_MICROBUTTON_NAMES = Object.freeze([
  "CharacterMicroButton",
  "SpellbookMicroButton",
  "TalentMicroButton",
  "AchievementMicroButton",
  "QuestLogMicroButton",
  "SocialsMicroButton",
  "PVPMicroButton",
  "LFDMicroButton",
  "MainMenuMicroButton",
  "HelpMicroButton",
] as const);

export type FrameXmlMicroButtonOwnerName =
  | "character" | "spellbook" | "talent" | "achievement" | "quest"
  | "socials" | "pvp" | "lfd" | "gameMenu" | "help";

/** A disabled stock button is a complete, explicit unavailable-by-contract owner. */
export type FrameXmlMicroButtonOwnerState = boolean | "disabled";

export type FrameXmlNativeMicroButtonReplacementName =
  | "character" | "bags" | "spellbook" | "talents" | "professions" | "diagnostics";

export interface FrameXmlMicroButtonOwnerProof {
  /** Every stock handler has a real, owned destination; Achievement may be explicitly unavailable. */
  readonly owners: Readonly<Record<FrameXmlMicroButtonOwnerName, FrameXmlMicroButtonOwnerState>>;
  /** The native row's complete C/B/P/N/J/gear surface has an explicit replacement owner. */
  readonly nativeReplacement: Readonly<Record<FrameXmlNativeMicroButtonReplacementName, boolean>>;
  /** Set only when the pre-exercise host adapter replaced the unsafe stock event handlers. */
  readonly adaptersInstalled: boolean;
}

const FRAMEXML_MICROBUTTON_REQUIRED_SCRIPTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  CharacterMicroButton: ["OnLoad", "OnEvent", "OnMouseDown", "OnMouseUp"],
  SpellbookMicroButton: ["OnLoad", "OnClick"],
  TalentMicroButton: ["OnLoad", "OnClick", "OnEvent"],
  AchievementMicroButton: ["OnLoad", "OnClick", "OnEvent", "OnEnter", "OnLeave"],
  QuestLogMicroButton: ["OnLoad", "OnClick"],
  SocialsMicroButton: ["OnLoad", "OnClick"],
  PVPMicroButton: ["OnLoad", "OnMouseDown", "OnMouseUp"],
  LFDMicroButton: ["OnLoad", "OnClick"],
  MainMenuMicroButton: ["OnLoad", "OnMouseDown", "OnMouseUp"],
  HelpMicroButton: ["OnLoad", "OnClick"],
});

const FRAMEXML_MICROBUTTON_OWNER_NAMES: readonly FrameXmlMicroButtonOwnerName[] = Object.freeze([
  "character", "spellbook", "talent", "achievement", "quest",
  "socials", "pvp", "lfd", "gameMenu", "help",
]);

const FRAMEXML_NATIVE_MICROBUTTON_REPLACEMENT_NAMES:
  readonly FrameXmlNativeMicroButtonReplacementName[] = Object.freeze([
    "character", "bags", "spellbook", "talents", "professions", "diagnostics",
  ]);

/** Host-side destinations for the stock row; every enabled button reaches a real owner. */
export interface FrameXmlMicroButtonActions {
  readonly character: () => unknown;
  readonly spellbook: () => unknown;
  readonly talent: () => unknown;
  readonly quest: () => unknown;
  readonly socials: () => unknown;
  readonly pvp: () => unknown;
  readonly lfd: () => unknown;
  readonly gameMenu: () => unknown;
  readonly help: () => unknown;
  /**
   * The stock AchievementFrame owner (FrameXmlAchievementMount.ts). The button stays disabled until
   * that owner is published after the row gate; absent, a click does nothing.
   */
  readonly achievement?: () => unknown;
}

function microButtonFrames(boot: Pick<FrameXmlBoot, "bridge">): FrameXmlFrame[] | undefined {
  const buttons: FrameXmlFrame[] = [];
  for (const name of FRAMEXML_MICROBUTTON_NAMES) {
    const button = boot.bridge.getFrame(name);
    if (!button || button.type !== "Button") return undefined;
    buttons.push(button);
  }
  return buttons;
}

/**
 * Install the narrow host callbacks before session exercise.  Only Talent/Achievement OnEvent
 * bodies are replaced because their `UpdateMicroButtons()` walk indexes optional LoD globals that
 * are not part of this world route; Character's portrait event remains untouched. Click/mouse
 * handlers retain stock semantics while calling an existing controller/native owner.
 */
export function installFrameXmlMicroButtonAdapters(
  boot: Pick<FrameXmlBoot, "bridge">,
  actions: FrameXmlMicroButtonActions,
): readonly FrameXmlFrame[] | undefined {
  const buttons = microButtonFrames(boot);
  if (!buttons) return undefined;
  const [character, spellbook, talent, achievement, quest, socials, pvp, lfd, gameMenu, help] = buttons;
  if (!character || !spellbook || !talent || !achievement || !quest
    || !socials || !pvp || !lfd || !gameMenu || !help) return undefined;

  const set = (frame: FrameXmlFrame, script: string, handler: Parameters<typeof boot.bridge.SetScript>[2]): boolean =>
    boot.bridge.SetScript(frame, script, handler);
  const armed = new WeakSet<FrameXmlFrame>();
  const mouse = (action: () => unknown) => ({
    down: (frame: FrameXmlFrame) => { armed.add(frame); },
    up: (frame: FrameXmlFrame) => {
      if (armed.delete(frame)) void action();
    },
  });
  const characterMouse = mouse(actions.character);
  const pvpMouse = mouse(actions.pvp);
  const menuMouse = mouse(actions.gameMenu);
  const click = (action: () => unknown) => () => { void action(); };

  // Hide first in the caller's beforeExercise hook; replacing OnEvent here makes every later
  // UPDATE_* notification safe even while the row is still hidden behind the publication gate.
  const scripts: readonly [FrameXmlFrame, string, Parameters<typeof boot.bridge.SetScript>[2]][] = [
    [character, "OnMouseDown", characterMouse.down],
    [character, "OnMouseUp", characterMouse.up],
    [spellbook, "OnClick", click(actions.spellbook)],
    [talent, "OnClick", click(actions.talent)],
    [achievement, "OnClick", actions.achievement ? click(actions.achievement) : () => {}],
    [quest, "OnClick", click(actions.quest)],
    [socials, "OnClick", click(actions.socials)],
    [pvp, "OnMouseDown", pvpMouse.down],
    [pvp, "OnMouseUp", pvpMouse.up],
    [lfd, "OnClick", click(actions.lfd)],
    [gameMenu, "OnMouseDown", menuMouse.down],
    [gameMenu, "OnMouseUp", menuMouse.up],
    [help, "OnClick", click(actions.help)],
  ];
  // Only Talent/Achievement's event bodies call UpdateMicroButtons(), whose stock walk dereferences
  // optional Blizzard panels absent from this route. Keep CharacterMicroButton_OnEvent intact: its
  // PLAYER_ENTERING_WORLD/UNIT_PORTRAIT_UPDATE path is the authored portrait-update hook, and its
  // SetPortraitTexture(MicroButtonPortrait, "player") is a stock claim (FrameXmlPortraits.ts).
  if (!set(talent, "OnEvent", () => {}) || !set(achievement, "OnEvent", () => {})) return undefined;
  // The unsupported Achievement destination is still present as a real stock button, but is
  // visibly and interactively disabled instead of advertising a false min-level/LoD tooltip.
  if (!boot.bridge.update(achievement, (frame) => { frame.enabled = false; })) return undefined;
  if (!set(achievement, "OnEnter", () => {}) || !set(achievement, "OnLeave", () => {})) return undefined;
  for (const [frame, script, handler] of scripts) if (!set(frame, script, handler)) return undefined;
  return buttons;
}

/** Hide the stock row before exercise or when any owner gate fails; native fallback remains live. */
function hideFrameXmlMicroButtons(boot: Pick<FrameXmlBoot, "bridge">): void {
  for (const name of FRAMEXML_MICROBUTTON_NAMES) {
    const frame = boot.bridge.getFrame(name);
    if (frame) boot.bridge.Hide(frame);
  }
}

function microButtonOwnerClosed(name: FrameXmlMicroButtonOwnerName, value: FrameXmlMicroButtonOwnerState): boolean {
  return value === true || (name === "achievement" && value === "disabled");
}

/** Structural and ownership proof required before the native C/B/P/N/J/gear row may be hidden. */
export function frameXmlMicroButtonOwnerGate(
  boot: Pick<FrameXmlBoot, "bridge">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  proof: FrameXmlMicroButtonOwnerProof,
): readonly FrameXmlFrame[] | undefined {
  if (proof.adaptersInstalled !== true
    || !FRAMEXML_MICROBUTTON_OWNER_NAMES.every((name) => microButtonOwnerClosed(name, proof.owners[name]))
    || !FRAMEXML_NATIVE_MICROBUTTON_REPLACEMENT_NAMES.every((name) => proof.nativeReplacement[name] === true)) {
    return undefined;
  }
  const buttons: FrameXmlFrame[] = [];
  for (const name of FRAMEXML_MICROBUTTON_NAMES) {
    const button = boot.bridge.getFrame(name);
    if (!button || button.type !== "Button" || !button.named || !button.loaded
      || button.parent?.name !== "MainMenuBarArtFrame"
      || !renderedFrameElement(renderer.elementFor(button), name, "Button")) return undefined;
    if (name === "AchievementMicroButton" ? button.enabled : !button.enabled) return undefined;
    const scripts = FRAMEXML_MICROBUTTON_REQUIRED_SCRIPTS[name];
    if (!scripts || !scripts.every((script) => boot.bridge.hasScript(button, script))) {
      return undefined;
    }
    buttons.push(button);
  }
  return buttons;
}

/** Native DOM lanes with a direct replacement in `FRAMEXML_VERTICAL_TOC`. */
const NATIVE_LANES_REPLACED_BY_VERTICAL = [
  "player-hud",        // PlayerFrame.xml (including the player portrait/name/health/power HUD).
  "player-cast",       // CastingBarFrame.xml (the player-only FrameXML cast bar).
  "player-auras",      // BuffFrame.xml (the stock player buff/debuff strip).
  "action-bar",        // MainMenuBar.xml (the primary twelve action buttons).
  "action-bar-extras", // MultiBarBottomLeft/Right.xml (the extra bottom action rows).
  "action-bar-side",   // MultiBarLeft/Right.xml (the extra side action rows).
] as const;

const NATIVE_LANES_HIDE_SELECTOR = NATIVE_LANES_REPLACED_BY_VERTICAL
  .map((id) => `body.${NATIVE_LANES_REPLACEMENT_CLASS} #${id}`)
  .join(",\n");

/** The legacy target shell is replaced piecemeal; its actions remain native. */
const NATIVE_TARGET_CORE_HIDE_SELECTOR = [
  "target-icon",
  "target-name",
  "target-details",
  "target-panel .target-health",
  "target-health-bar",
  "target-health-text",
  "target-power",
  "clear-target-button",
].map((id) => `body.${NATIVE_LANES_REPLACEMENT_CLASS} #${id}`)
  .join(",\n");

const NATIVE_TARGET_PANEL_SELECTOR = `body.${NATIVE_LANES_REPLACEMENT_CLASS} #target-panel`;

/** The target spellbar and aura containers are an optional contextual replacement. */
const NATIVE_TARGET_CONTEXT_HIDE_SELECTOR = ["target-cast", "target-auras"]
  .map((id) => `body.${NATIVE_TARGET_CONTEXT_REPLACEMENT_CLASS} #${id}`)
  .join(",\n");

/** The pet portrait/status/debuff slice is optional until every static stock widget is rendered. */
const NATIVE_PET_HIDE_SELECTOR = `body.${NATIVE_PET_REPLACEMENT_CLASS} #pet-frame`;
const NATIVE_PARTY_HIDE_SELECTOR = `body.${NATIVE_PARTY_REPLACEMENT_CLASS} #party-frames`;

/**
 * The stock MinimapCluster owns the whole top-right corner: map, zone text, zoom, tracking, the
 * world-map button and (Blizzard_TimeManager) the clock. The native `#minimap` root is therefore
 * retired as one element. Its canvas is not under it any more — adoptMinimapCanvas moved it into
 * FrameXML's Minimap slot — and the adoption cleanup returns it before this class is removed.
 *
 * The earlier hybrid kept the native root visible below the cluster for its clock, tracking and
 * world-map buttons. Those are absolutely positioned inside a root with no in-flow height, so in the
 * 260px-tall `#right-rail` (overflow-y:auto) they became scroll overflow: measured scrollHeight 389
 * against clientHeight 260, the scrollbar the owner saw at x≈1893, y≈10..265 at 1920x919.
 */
const NATIVE_MINIMAP_HIDE_SELECTOR = `body.${NATIVE_LANES_REPLACEMENT_CLASS} #right-rail > #minimap`;

/**
 * What stays in the native rail (boss/arena frames, a native quest tracker while its stock owner is
 * unpublished) starts below the stock cluster rather than on top of it. MinimapCluster is 192 of
 * the stage's 768 units at the stage scale `height/768 * uiScale/100` (frameXmlViewport), i.e.
 * `25vh * --ui-scale`; the rail keeps its old bottom edge (native-wow-ui top 8px + max-height).
 */
const NATIVE_RAIL_BELOW_STOCK_MINIMAP_CSS = `body.${NATIVE_LANES_REPLACEMENT_CLASS} #right-rail {
  top: calc(25vh * var(--ui-scale, 1) + 10px);
  max-height: calc(
    (100vh - 24px - var(--hud-safe-bottom) - 25vh * var(--ui-scale, 1)) / var(--ui-scale-effective, 1)
  );
}`;

// BonusActionBarFrame's stance layout calls the original ShowPetActionBar even without a pet.
// The stock bar draws only once its own gate has published (petActionBarGate); until then, and
// for a seam without the pet-bar model, the native #pet-bar keeps every pet command.
// Container anchors also need BankFrame; the native bank remains its interaction owner.
const FRAMEXML_NATIVE_OWNED_DEPENDENCY_SELECTOR = [
  `body:not(.${NATIVE_PET_BAR_REPLACEMENT_CLASS}) #${HOST_ID} [data-framexml-name="PetActionBarFrame"]`,
  `#${HOST_ID} [data-framexml-name="BankFrame"]`,
].join(",\n");

/**
 * The native #pet-bar steps aside only for the bar the stock one draws: a pet's or a charmed
 * creature's (`data-kind="pet"`, PetProtocol.ts `petBarKind`). A vehicle's bar, a possessed unit's
 * and the seat/eject row (`.is-vehicle`) have no stock owner in this vertical and stay native.
 */
const NATIVE_PET_BAR_HIDE_SELECTOR = `body.${NATIVE_PET_BAR_REPLACEMENT_CLASS} #pet-bar[data-kind="pet"]:not(.is-vehicle)`;

/** Added beside the chat class only while `ChatFrame1EditBox` owns the chat keys (`ChatInputOwner`). */
const NATIVE_CHAT_INPUT_REPLACEMENT_CLASS = "framexml-world-owns-chat-input";
/**
 * The chat gate display-owns the native log and tab strip. The whole `#chat-window` — its form and
 * input included — goes only when the stock edit box owns the keys as well: the input used to stay
 * over ChatFrame1 (live: input at y≈767-785, stock lines continuing at y≈795), and hiding it any
 * earlier would leave Enter with nothing to type into.
 */
const NATIVE_CHAT_HIDE_SELECTOR = [
  ...["chat-tabs", "chat-log"].map((id) => `body.${NATIVE_CHAT_REPLACEMENT_CLASS} #${id}`),
  `body.${NATIVE_CHAT_REPLACEMENT_CLASS}.${NATIVE_CHAT_INPUT_REPLACEMENT_CLASS} #chat-window`,
].join(",\n");
/**
 * An EditBox's `<input>` fills its widget and draws nothing of its own: the `#glue-stage
 * input[data-framexml-input]` rule of `glue/glue.css`, for this host. The world host lives in
 * `index.html`, whose page-wide `input` rules (`style.css` — 44px min-height, 8px rounded border,
 * 0 12px padding, dark fill, the gold `:focus-visible` ring) made ChatFrame1EditBox's field a
 * 188x22 pill at 202,808 inside its 527x38 box, clipping the typed text, once that box became the
 * only chat input (measured on the index.html route). `padding: 0` yields to the renderer's inline
 * `<TextInsets>` padding, which is where `ChatEdit_UpdateHeader` puts the text after «Сказать:».
 */
const FRAMEXML_EDIT_BOX_INPUT_CSS = `#${STAGE_ID} [data-framexml-type="EditBox"] input[data-framexml-input="true"] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
  color: inherit;
  font: inherit;
  text-align: inherit;
  outline: none;
  /* Above the widget's own BACKGROUND/ARTWORK regions, which top out just under 1000. */
  z-index: 900;
}`;
const NATIVE_FOCUS_HIDE_SELECTOR = `body.${NATIVE_FOCUS_REPLACEMENT_CLASS} #focus-frame`;
const NATIVE_TOT_HIDE_SELECTOR = `body.${NATIVE_TOT_REPLACEMENT_CLASS} #tot-frame`;
/** The stock ContainerFrame owns these two native bag surfaces only after its gate passes. */
const NATIVE_BAGS_HIDE_SELECTOR = ["#inventory-window", "#bag-bar", ".bag-window"]
  .map((selector) => `body.${NATIVE_BAGS_REPLACEMENT_CLASS} ${selector}`)
  .join(",\n");
const NATIVE_CHARACTER_HIDE_SELECTOR = `body.${NATIVE_CHARACTER_REPLACEMENT_CLASS} #character-window`;
/** The native circular C/B/P/N/J/gear row remains visible until the complete stock row owns it. */
const NATIVE_MICROBUTTONS_HIDE_SELECTOR = `body.${NATIVE_MICROBUTTONS_REPLACEMENT_CLASS} #game-buttons`;

function setNativeLanesReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_LANES_REPLACEMENT_CLASS, active);
}

function setNativeTargetContextReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_TARGET_CONTEXT_REPLACEMENT_CLASS, active);
}

function setNativePetReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_PET_REPLACEMENT_CLASS, active);
}

function setNativePetBarReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_PET_BAR_REPLACEMENT_CLASS, active);
}

function setNativePartyReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_PARTY_REPLACEMENT_CLASS, active);
}

function setNativeChatReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_CHAT_REPLACEMENT_CLASS, active);
  if (!active) document.body.classList.remove(NATIVE_CHAT_INPUT_REPLACEMENT_CLASS);
}

function setNativeFocusReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_FOCUS_REPLACEMENT_CLASS, active);
}

function setNativeTargetOfTargetReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_TOT_REPLACEMENT_CLASS, active);
}

function setNativeBagsReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_BAGS_REPLACEMENT_CLASS, active);
}

function setNativeCharacterReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_CHARACTER_REPLACEMENT_CLASS, active);
}

function setNativeMicroButtonsReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_MICROBUTTONS_REPLACEMENT_CLASS, active);
}

/**
 * Close the native owner at the publication boundary, not when the asynchronous boot starts.
 * The player can open a native bag while the corpus is loading; closing here makes that race
 * deterministic and prevents a hidden `.bag-window` from returning when the replacement class is
 * later removed. The stock gate remains the only condition that reaches this helper.
 */
function closeNativeBagsBeforeReplacement(): boolean {
  const wasHidden = inventoryWindow.hidden;
  bestEffortCleanup(() => closeBagWindows());
  inventoryWindow.hidden = true;
  return wasHidden;
}

interface NativeChatLogState {
  readonly scrollTop: number;
  readonly atBottom: boolean;
}

function captureNativeChatLogState(): NativeChatLogState {
  const scrollTop = chatLog.scrollTop;
  const atBottom = scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 8;
  return { scrollTop, atBottom };
}

function restoreNativeChatLogState(state: NativeChatLogState): void {
  chatLog.scrollTop = state.atBottom ? chatLog.scrollHeight : state.scrollTop;
}

function frameXmlDataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

function renderedFrameElement(
  element: HTMLElement | undefined,
  name: string,
  type: string,
): element is HTMLElement {
  return !!element
    && frameXmlDataAttribute(element, "data-framexml-name") === name
    && frameXmlDataAttribute(element, "data-framexml-type") === type;
}

/**
 * The stock bag code is an all-or-nothing owner.  A named ContainerFrame tree by itself is not
 * enough: `ContainerFrame_OnShow` calls back into the main-menu backpack button, and the first
 * click immediately exercises the container-size/item API.  Probe that real click while the
 * native fallback is still visible, and publish only when it creates a visible frame without a
 * new bridge diagnostic.  A missing parallel corpus/seam therefore leaves the native bags alone.
 */
export function frameXmlBagGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  onFailure?: () => void,
): FrameXmlBagOwner | undefined {
  let releaseLifetimeGlobals: (() => void) | undefined;
  try {
    const backpack = boot.bridge.getFrame("MainMenuBarBackpackButton");
    const bagButtons = [0, 1, 2, 3].map((index) => boot.bridge.getFrame(`CharacterBag${index}Slot`));
    const keyring = boot.bridge.getFrame("KeyRingButton");
    const gameMenu = boot.bridge.getFrame("GameMenuFrame");
    const containers = Array.from({ length: 13 }, (_unused, index) =>
      boot.bridge.getFrame(`ContainerFrame${index + 1}`));
    if (!backpack || backpack.type !== "CheckButton"
      || !bagButtons.every((button): button is FrameXmlFrame => button?.type === "CheckButton")
      || !keyring || keyring.type !== "CheckButton"
      || !gameMenu || gameMenu.type !== "Frame"
      || !containers.every((frame): frame is FrameXmlFrame => frame?.type === "Frame")) return undefined;

    // MainMenuBarBagButtons.xml inherits PaperDollItemSlotButton_OnLoad. Its stock inventory IDs
    // are 20..23 (TabardSlot is 19), and are the contract that BagSlotButton_OnClick translates
    // to container IDs 1..4; a zero (the omitted PaperDoll handler's old result) would make every
    // carried button target bag 1.
    if (!bagButtons.every((button, index) => button.id === 20 + index)) return undefined;

    const roots = [backpack, ...bagButtons, keyring];
    if (!roots.every((frame) => {
      const element = renderer.elementFor(frame);
      return !!element && renderedFrameElement(element, frame.name, frame.type)
        && boot.bridge.hasScript(frame, "OnClick");
    })) return undefined;
    const gameMenuElement = renderer.elementFor(gameMenu);
    if (!gameMenuElement || !renderedFrameElement(gameMenuElement, gameMenu.name, gameMenu.type)
      || !boot.bridge.hasScript(gameMenu, "OnShow")
      || !boot.bridge.hasScript(gameMenu, "OnHide")) return undefined;
    if (!containers.every((frame) => {
      const element = renderer.elementFor(frame);
      return !!element && renderedFrameElement(element, frame.name, frame.type)
        && boot.bridge.hasScript(frame, "OnLoad")
        && boot.bridge.hasScript(frame, "OnShow")
        && boot.bridge.hasScript(frame, "OnHide")
        && boot.bridge.hasScript(frame, "OnEvent");
    })) return undefined;

    const before = containers.map((frame) => frame.visible);
    if (before.some(Boolean)) return undefined;
    // GameMenuFrame itself is a real dependency here: IsOptionFrameOpen() (UIParent.lua:2205) asks
    // GameMenuFrame:IsShown() before InterfaceOptionsFrame. It is no longer anyone's alias — the
    // stock menu is the game menu now and is shown — so absent optional frames get their own
    // hidden stand-in below.
    const interfaceOptions = boot.bridge.getFrame("InterfaceOptionsFrame");
    const bank = boot.bridge.getFrame("BankFrame");
    const merchant = boot.bridge.getFrame("MerchantFrame");
    const stackSplit = boot.bridge.getFrame("StackSplitFrame");
    if ((bank && bank.type !== "Frame")
      || (merchant && merchant.type !== "Frame")
      || (stackSplit && stackSplit.type !== "Frame")) return undefined;

    // GlueLuaVm retains tables/functions returned by getGlobal(). Release those scratch handles
    // here; named FrameXML globals are decoded host frames, while an unrelated pre-existing value
    // is a hard gate failure rather than something to overwrite with a proxy.
    const vmGlobal = (name: string): unknown => {
      const value = boot.vm.getGlobal(name);
      if (value instanceof GlueLuaRef) boot.vm.release(value);
      return value;
    };
    const interfaceOptionsGlobal = vmGlobal("InterfaceOptionsFrame");
    const bankGlobal = vmGlobal("BankFrame");
    const merchantGlobal = vmGlobal("MerchantFrame");
    const stackSplitGlobal = vmGlobal("StackSplitFrame");
    if ((!interfaceOptions && interfaceOptionsGlobal !== undefined && interfaceOptionsGlobal !== boot.optionsFrameStandIn)
      || (!bank && bankGlobal !== undefined)
      || (!merchant && merchantGlobal !== undefined)
      || (!stackSplit && stackSplitGlobal !== undefined)) return undefined;

    // IsOptionFrameOpen() dereferences InterfaceOptionsFrame unconditionally; the options chain
    // (TOC 37-45) is not in this vertical. A missing frame is answered by one dedicated, unnamed,
    // hidden bridge frame created here — never by GameMenuFrame, which is shown as the game menu
    // and would otherwise read as «options open» and be hidden by StackSplitFrame:Hide().
    let hiddenProxy: FrameXmlFrame | undefined;
    const proxy = (): FrameXmlFrame => {
      if (hiddenProxy) return hiddenProxy;
      const created = boot.bridge.CreateFrame("Frame");
      if (!created || created.type !== "Frame") throw new Error("cannot create the hidden bag proxy");
      boot.bridge.Hide(created);
      if (created.visible) throw new Error("the bag proxy did not hide");
      hiddenProxy = created;
      return created;
    };
    const aliases: readonly (readonly [string, FrameXmlFrame])[] = [
      ...(!interfaceOptions && interfaceOptionsGlobal === undefined
        ? [["InterfaceOptionsFrame", proxy()] as const] : []),
      // ContainerFrame_GenerateFrame always asks BankFrame:IsShown() while placing a bag. BankFrame.xml
      // is in the vertical; a corpus without it gets the same hidden stand-in's no-bank answer.
      ...(!bank && bankGlobal === undefined
        ? [["BankFrame", proxy()] as const] : []),
    ];
    // ContainerFrameItemButton_OnClick unconditionally calls MerchantFrame:IsShown() on a
    // right-click and StackSplitFrame:Hide() after UseContainerItem. Both XML files are in the
    // vertical (StackSplitFrame.xml at stock TOC line 49), so the real frames answer; a narrower
    // corpus gets the hidden stand-in for the owner's lifetime. This is not a fake test alias: it
    // is installed in the production VM before owner publication and removed by owner.dispose()
    // on controller unpublish or any later mount failure.
    const lifetimeAliases: readonly (readonly [string, FrameXmlFrame])[] = [
      ...aliases,
      ...(merchantGlobal === undefined
        ? [["MerchantFrame", merchant ?? proxy()] as const] : []),
      ...(stackSplitGlobal === undefined
        ? [["StackSplitFrame", stackSplit ?? proxy()] as const] : []),
    ];
    // A stand-in goes only where the global is still empty and comes off only while it still holds
    // the stand-in: the lazy options chain's real InterfaceOptionsFrame, loaded after publication
    // (or while a probe runs), is never covered and stays when the owner goes (FrameXmlBagCompat.ts).
    // withBagGlobals and the lifetime install below follow the same rule.
    const clearGlobals = (installed: readonly (readonly [string, FrameXmlFrame])[]): void => {
      releaseOwnedGlobals(boot.vm, installed);
    };
    const withBagGlobals = <T>(operation: () => T): T => {
      if (aliases.length === 0) return operation();
      const installed: Array<readonly [string, FrameXmlFrame]> = [];
      try {
        installOwnedGlobals(boot.vm, aliases, installed);
        return operation();
      } finally {
        clearGlobals(installed);
      }
    };
    const checkedMutation = <T>(operation: () => T, label: string): T => {
      const diagnosticsBefore = boot.bridge.diagnostics.length;
      const luaErrorsBefore = boot.vm.errors.length;
      const result = operation();
      if (boot.bridge.diagnostics.length !== diagnosticsBefore
        || boot.vm.errors.length !== luaErrorsBefore) {
        throw new Error(`stock bag ${label} reported a bridge or Lua error`);
      }
      return result;
    };
    const diagnosticsBefore = boot.bridge.diagnostics.length;
    // Lua handler failures are kept by GlueLuaVm rather than FrameXmlUiBridge. ContainerFrame's
    // first click can therefore fail with a nil global while still returning bridge.Click=true;
    // count both channels before publishing an owner.
    const luaErrorsBefore = boot.vm.errors.length;
    if (!withBagGlobals(() => boot.bridge.Click(backpack, "LeftButton", false))) return undefined;
    const opened = containers.some((frame) => frame.visible);
    withBagGlobals(() => {
      for (const frame of containers) if (frame.visible) boot.bridge.Hide(frame);
    });
    // Hiding is part of the probe's transaction.  If its OnHide path failed, the check must not
    // publish an owner that would leave a checked button or stale `bagsShown` state behind.
    const closed = containers.every((frame) => !frame.visible);
    const diagnosticsClean = boot.bridge.diagnostics.length === diagnosticsBefore;
    const luaErrorsClean = boot.vm.errors.length === luaErrorsBefore;
    if (!opened || !diagnosticsClean || !luaErrorsClean || !closed) {
      return undefined;
    }

    try {
      const installed: Array<readonly [string, FrameXmlFrame]> = [];
      installOwnedGlobals(boot.vm, lifetimeAliases, installed);
      let released = false;
      releaseLifetimeGlobals = (): void => {
        if (released) return;
        released = true;
        clearGlobals(installed);
      };
    } catch {
      // If a VM rejected one alias, remove every alias installed before that rejection and leave
      // the native route untouched. The outer catch handles the final undefined result.
      clearGlobals(lifetimeAliases);
      return undefined;
    }

    const click = (frame: FrameXmlFrame): void => {
      if (!checkedMutation(
        () => boot.bridge.Click(frame, "LeftButton", false),
        `click ${frame.name}`,
      )) {
        throw new Error(`cannot click ${frame.name}`);
      }
    };
    const close = (): void => {
      const closed = checkedMutation(() => {
        let ok = true;
        for (const frame of containers) {
          if (frame.visible && !boot.bridge.Hide(frame)) ok = false;
        }
        return ok;
      }, "hide");
      if (!closed) throw new Error("cannot hide stock bag frame");
    };
    const owner: FrameXmlBagOwner = {
      isOpen: () => containers.some((frame) => frame.visible),
      toggleBackpack: () => click(backpack),
      toggleBag: (index) => {
        if (!Number.isInteger(index) || index < 1 || index > 4) return;
        const button = bagButtons[index - 1];
        if (button) click(button);
      },
      toggleKeyring: () => click(keyring),
      toggleAllBags: () => {
        // Backpack is the stock all-bags sentinel: when it is open, OpenAllBags closes the set;
        // otherwise the same button sequence opens the backpack and every available carried bag.
        if (containers.some((frame) => frame.visible)) {
          close();
          return;
        }
        click(backpack);
        for (const button of bagButtons) click(button);
      },
      close,
      dispose: () => releaseLifetimeGlobals?.(),
      ...(onFailure ? { onFailure } : {}),
    };
    return owner;
  } catch {
    releaseLifetimeGlobals?.();
    return undefined;
  }
}

/**
 * Chat is an optional display enhancement of the working vertical.  The gate is deliberately
 * structural: it checks the concrete named frame, its renderer DOM element/message layer, and the
 * seam's complete supported chat-window type group before publishing the body class.
 */
function chatGate(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): boolean {
  try {
    const frame = boot.bridge.getFrame("ChatFrame1");
    const frameElement = frame ? renderer.elementFor(frame) : undefined;
    if (!frame || frame.type !== "ScrollingMessageFrame"
      || !renderedFrameElement(frameElement, "ChatFrame1", "ScrollingMessageFrame")) return false;
    if (!Array.isArray(frame.messageFrame.messages)
      || !frameElement.querySelector('[data-framexml-message-layer="true"]')) return false;
    const availableTypes = new Set(seam.chatWindowMessages(1));
    if (!["SYSTEM", "SAY", "YELL", "PARTY", "RAID", "GUILD", "OFFICER", "WHISPER", "EMOTE", "CHANNEL"]
      .every((type) => availableTypes.has(type))) return false;
    return [
      "CHAT_MSG_SYSTEM", "CHAT_MSG_SAY", "CHAT_MSG_YELL", "CHAT_MSG_PARTY", "CHAT_MSG_RAID",
      "CHAT_MSG_GUILD", "CHAT_MSG_OFFICER", "CHAT_MSG_WHISPER", "CHAT_MSG_WHISPER_INFORM",
      "CHAT_MSG_EMOTE", "CHAT_MSG_TEXT_EMOTE", "CHAT_MSG_CHANNEL",
    ].every((event) => frame.registeredEvents.has(event));
  } catch {
    return false;
  }
}

/**
 * After the chat gate: the stock edit box takes the chat keys, the stock slash bodies get their
 * world API, and this client's own commands are mirrored into `SlashCmdList` (`FrameXmlChatApi.ts`).
 * Undefined — and nothing installed — when the edit box or its Lua is missing; the native form then
 * stays the chat input. `onFailure` shows the native form again if a later open fails.
 */
function installStockChatInput(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  onFailure: () => void,
): (() => void) | undefined {
  try {
    return installFrameXmlStockChat({
      vm: boot.vm,
      bridge: boot.bridge,
      inputFor: (frame) => renderer.elementFor(frame)
        ?.querySelector<HTMLInputElement>('input[data-framexml-input="true"]') ?? undefined,
    }, {
      world: () => game.world,
      notice: systemLine,
      cast: runCastCommand,
      use: runUseCommand,
      unitGuid: macroUnitGuid,
      // Macro conditions (`SecureCmdOptionParse`, stock macros) are evaluated over the seam's answers.
      macroContext: () => seam.macroContext?.(),
      commands: nativeSlashCommands,
      emotes: () => game.world?.emotes,
      run: runNativeCommand,
      onCommandsChanged: onNativeSlashCommandsChanged,
      onCombatEntry,
      combatHistory,
      // Stock reads `docked` as the dock slot (FCF_DockFrame(frame, docked)); any truthy slot counts.
      combatWindowEnabled: () => {
        const info = seam.chatWindowInfo?.(2);
        return info !== undefined && (info[6] === true || Boolean(info[8]));
      },
    }, onFailure);
  } catch {
    return undefined;
  }
}

/**
 * Target cast/auras are an optional contextual slice. The stock target has one spellbar and two
 * static aura containers under `TargetFrame`; aura buttons are deliberately not part of this gate,
 * because TargetFrame.lua creates `TargetFrameBuff1`/`TargetFrameDebuff1` lazily on first target.
 * This checks only stable named bridge widgets and their rendered DOM nodes, never current target,
 * cast or aura visibility.
 */
function targetContextGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): boolean {
  try {
    const targetFrame = boot.bridge.getFrame("TargetFrame");
    const targetFrameElement = targetFrame ? renderer.elementFor(targetFrame) : undefined;
    if (!targetFrame || !targetFrameElement
      || !renderedFrameElement(targetFrameElement, "TargetFrame", "Button")) return false;

    const requiredChildren = [
      ["TargetFrameSpellBar", "StatusBar"],
      ["TargetFrameBuffs", "Frame"],
      ["TargetFrameDebuffs", "Frame"],
    ] as const;
    return requiredChildren.every(([name, type]) => {
      const frame = boot.bridge.getFrame(name);
      const element = frame ? renderer.elementFor(frame) : undefined;
      return !!frame
        && frame.parent === targetFrame
        && !!element
        && element.parentElement === targetFrameElement
        && renderedFrameElement(element, name, type);
    });
  } catch {
    return false;
  }
}

interface SecondaryUnitPortraitGate {
  readonly root: FrameXmlFrame;
  readonly rootElement: HTMLElement;
  readonly portraitElement: HTMLElement;
}

/**
 * The secondary unit frames are independent native lanes. Keep this check structural and
 * current-data agnostic: a missing focus/ToT unit must not prevent the stock frame from taking
 * over once the client later receives one. The portrait canvas is borrowed only after all three
 * stable stock children have rendered beneath the exact secure unit button.
 */
function secondaryUnitPortraitGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  rootName: string,
  unit: string,
  portraitName: string,
  healthName: string,
  manaName: string,
  parent?: FrameXmlFrame,
): SecondaryUnitPortraitGate | undefined {
  try {
    const root = boot.bridge.getFrame(rootName);
    const rootElement = root ? renderer.elementFor(root) : undefined;
    if (!root || root.type !== "Button" || !rootElement
      || !renderedFrameElement(rootElement, rootName, "Button")
      || root.secureAttributes.get("unit") !== unit
      || root.secureAttributes.get("*type1") !== "target"
      || (parent !== undefined && root.parent !== parent)) return undefined;

    const required = [
      [portraitName, "Texture"],
      [healthName, "StatusBar"],
      [manaName, "StatusBar"],
    ] as const;
    let portraitElement: HTMLElement | undefined;
    for (const [name, type] of required) {
      const frame = boot.bridge.getFrame(name);
      const element = frame ? renderer.elementFor(frame) : undefined;
      if (!frame || !frameDescendsFrom(frame, root) || !element
        || !elementDescendsFrom(element, rootElement)
        || !renderedFrameElement(element, name, type)) return undefined;
      if (name === portraitName) portraitElement = element;
    }
    return portraitElement ? { root, rootElement, portraitElement } : undefined;
  } catch {
    return undefined;
  }
}

function focusGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): SecondaryUnitPortraitGate | undefined {
  return secondaryUnitPortraitGate(
    boot, renderer, "FocusFrame", "focus", "FocusFramePortrait",
    "FocusFrameHealthBar", "FocusFrameManaBar",
  );
}

function targetOfTargetGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): SecondaryUnitPortraitGate | undefined {
  const targetFrame = boot.bridge.getFrame("TargetFrame");
  return targetFrame
    ? secondaryUnitPortraitGate(
      boot, renderer, "TargetFrameToT", "targettarget", "TargetFrameToTPortrait",
      "TargetFrameToTHealthBar", "TargetFrameToTManaBar", targetFrame,
    )
    : undefined;
}

/** FocusFrame's own ToT row, created by TargetFrame.xml:678 for "focus-target". */
function focusTargetOfTargetGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): SecondaryUnitPortraitGate | undefined {
  const focusFrame = boot.bridge.getFrame("FocusFrame");
  return focusFrame
    ? secondaryUnitPortraitGate(
      boot, renderer, "FocusFrameToT", "focus-target", "FocusFrameToTPortrait",
      "FocusFrameToTHealthBar", "FocusFrameToTManaBar", focusFrame,
    )
    : undefined;
}

interface SpellBookGate {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
}

interface MerchantGate {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
}

/**
 * Prove the stock merchant tree before hiding the native vendor panel. MerchantFrame has a large
 * authored surface, but ordinary buying only needs the root lifecycle, ten visible row buttons,
 * the buyback row, and the close/tabs/navigation controls. Repair widgets are required to exist
 * and remain safely disabled by the seam's neutral repair answers.
 */
export function frameXmlMerchantGate(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): MerchantGate | undefined {
  try {
    const root = boot.bridge.getFrame("MerchantFrame");
    const uiParent = boot.bridge.getFrame("UIParent");
    const element = root ? renderer.elementFor(root) : undefined;
    if (!root || !uiParent || root.type !== "Frame" || root.parent !== uiParent || !element
      || !renderedFrameElement(element, "MerchantFrame", "Frame")) return undefined;
    boot.bridge.Hide(root);
    if (boot.bridge.isVisible(root)
      || !["OnLoad", "OnShow", "OnHide", "OnEvent"].every((script) => boot.bridge.hasScript(root, script))
      || !["MERCHANT_SHOW", "MERCHANT_UPDATE", "MERCHANT_CLOSED"].every((event) => root.registeredEvents.has(event))) {
      return undefined;
    }
    const requiredApis = [
      "merchantNumItems", "merchantItemInfo", "merchantItemLink", "merchantItemMaxStack",
      "merchantItemCostInfo", "merchantItemCostItem", "itemInfo", "buybackNumItems", "buybackItemInfo",
      "buybackItemLink", "buyMerchantItem", "buybackItem", "closeMerchant", "canMerchantRepair",
      "repairAllCost", "canGuildBankRepair", "inRepairMode",
    ] as const;
    if (!requiredApis.every((name) => typeof seam[name] === "function")) return undefined;

    const requireChild = (name: string, parent: FrameXmlFrame, type: string): FrameXmlFrame | undefined => {
      const frame = boot.bridge.getFrame(name);
      const childElement = frame ? renderer.elementFor(frame) : undefined;
      return frame && frame.type === type && frame.parent === parent && frameDescendsFrom(frame, parent)
        && renderedFrameElement(childElement, name, type)
        && elementDescendsFrom(childElement!, renderer.elementFor(parent)!) ? frame : undefined;
    };
    const controls = [
      ["MerchantFrameCloseButton", "Button"],
      ["MerchantFrameTab1", "Button"], ["MerchantFrameTab2", "Button"],
      ["MerchantPrevPageButton", "Button"], ["MerchantNextPageButton", "Button"],
      ["MerchantRepairAllButton", "Button"], ["MerchantRepairItemButton", "Button"],
    ] as const;
    for (const [name, type] of controls) if (!requireChild(name, root, type)) return undefined;
    for (let index = 1; index <= 12; index += 1) {
      const row = requireChild(`MerchantItem${index}`, root, "Frame");
      const itemButton = row ? requireChild(`MerchantItem${index}ItemButton`, row, "Button") : undefined;
      // MerchantItemTemplate's OnLoad/OnClick belong to its child item button; the row Frame
      // itself intentionally has no scripts in stock MerchantFrame.xml.
      if (!itemButton || !boot.bridge.hasScript(itemButton, "OnLoad")
        || !boot.bridge.hasScript(itemButton, "OnClick")) return undefined;
    }
    const buyback = requireChild("MerchantBuyBackItem", root, "Frame");
    const buybackButton = buyback
      ? requireChild("MerchantBuyBackItemItemButton", buyback, "Button") : undefined;
    if (!buybackButton || !boot.bridge.hasScript(buybackButton, "OnLoad")
      || !boot.bridge.hasScript(buybackButton, "OnClick")) return undefined;
    return { frame: root, element };
  } catch {
    return undefined;
  }
}

/**
 * Publish MerchantFrame and own the native handoff as one boundary.
 *
 * Stock MerchantFrame_OnHide calls CloseMerchant, so the active list is captured before the
 * owner is released and restored only when this is the same world. This small helper is also the
 * seam for lifecycle tests; the full mount uses this exact path rather than duplicating it.
 */
export function publishFrameXmlMerchantMount(
  next: FrameXmlMerchantOwner,
  nativeWindow: HTMLElement = vendorWindow,
  nativeWasHidden = nativeWindow.hidden,
  showNative: () => void = showVendor,
): () => void {
  nativeWindow.hidden = true;
  const releaseOwner = publishFrameXmlMerchant(next);
  if (game.world?.vendor) next.show();
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const activeWorld = game.world;
    const activeVendor = activeWorld?.vendor;
    releaseOwner();
    if (game.world?.vendor) {
      nativeWindow.hidden = false;
      showNative();
    } else if (activeWorld && activeVendor && game.world === activeWorld) {
      // Releasing the stock owner may have closed the merchant as part of OnHide. Keep the same
      // server snapshot for the native fallback instead of silently dropping an open vendor.
      activeWorld.vendor = activeVendor;
      nativeWindow.hidden = false;
      showNative();
    } else {
      nativeWindow.hidden = nativeWasHidden;
    }
  };
}

interface TalentGate {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
}

export interface FrameXmlTrainerGate {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
}

/** Structural proof for the stock Blizzard_TrainerUI root and its complete actionable surface. */
export function frameXmlTrainerGate(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): FrameXmlTrainerGate | undefined {
  try {
    const root = boot.bridge.getFrame("ClassTrainerFrame");
    const uiParent = boot.bridge.getFrame("UIParent");
    const element = root ? renderer.elementFor(root) : undefined;
    if (!root || root.type !== "Frame" || !uiParent || root.parent !== uiParent || !element
      || !renderedFrameElement(element, "ClassTrainerFrame", "Frame")
      || !["OnLoad", "OnShow", "OnHide", "OnEvent"].every((name) => boot.bridge.hasScript(root, name))
      || !root.registeredEvents.has("TRAINER_UPDATE")
      || !root.registeredEvents.has("TRAINER_DESCRIPTION_UPDATE")) return undefined;
    const requiredApis = [
      "trainerServiceCount", "trainerServiceInfo", "trainerServiceCost", "trainerServiceLevelReq",
      "trainerServiceSkillReq", "trainerServiceNumAbilityReq", "trainerServiceAbilityReq",
      "trainerServiceStepReq", "trainerServiceIcon", "trainerServiceDescription", "trainerServiceSkillLine",
      "trainerServiceItemLink", "trainerGreeting", "trainerSelectionIndex", "selectTrainerService",
      "trainerType",
      "isTradeskillTrainer", "buyTrainerService", "closeTrainer", "trainerTypeFilter",
      "setTrainerTypeFilter", "collapseTrainerSkillLine", "expandTrainerSkillLine", "characterPoints",
      "trainerContextSignature",
      "trainerChanged",
    ] as const;
    if (!requiredApis.every((name) => typeof seam[name] === "function")) return undefined;
    const child = (name: string, type: string): FrameXmlFrame | undefined => {
      const frame = boot.bridge.getFrame(name);
      const childElement = frame ? renderer.elementFor(frame) : undefined;
      return frame && frame.type === type && frameDescendsFrom(frame, root) && childElement
        && renderedFrameElement(childElement, name, type)
        && elementDescendsFrom(childElement, element) ? frame : undefined;
    };
    for (let index = 1; index <= 11; index += 1) {
      const skill = child(`ClassTrainerSkill${index}`, "Button");
      if (!skill || !boot.bridge.hasScript(skill, "OnClick")) return undefined;
    }
    for (const [name, type] of [
      ["ClassTrainerListScrollFrame", "ScrollFrame"],
      ["ClassTrainerDetailScrollFrame", "ScrollFrame"],
      ["ClassTrainerDetailScrollChildFrame", "Frame"],
      ["ClassTrainerSkillIcon", "Button"],
      ["ClassTrainerTrainButton", "Button"],
      ["ClassTrainerCancelButton", "Button"],
      ["ClassTrainerFrameCloseButton", "Button"],
    ] as const) if (!child(name, type)) return undefined;
    const train = boot.bridge.getFrame("ClassTrainerTrainButton");
    const close = boot.bridge.getFrame("ClassTrainerFrameCloseButton");
    if (!train || !close || !boot.bridge.hasScript(train, "OnClick")
      || !boot.bridge.hasScript(close, "OnClick")) return undefined;
    boot.bridge.Hide(root);
    return boot.bridge.isVisible(root) ? undefined : { frame: root, element };
  } catch {
    return undefined;
  }
}

/** Lazy, identity-bound owner for Blizzard_TrainerUI. Native trainer UI stays visible until this gate passes. */
export function createLazyFrameXmlTrainerOwner(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  onFailure?: () => void,
  contextToken: () => unknown = () => seam,
  nativeFallback: () => void = showTrainer,
): FrameXmlTrainerOwner {
  let desiredOpen = false;
  let disposed = false;
  let failed = false;
  let generation = 0;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let ownerToken: unknown;
  let ownerSignature = "";
  let stockOwned = false;
  let nativeShown = false;
  const supported = (): boolean => {
    const type = typeof seam.trainerType === "function"
      ? seam.trainerType()
      : seam.isTradeskillTrainer() ? 2 : 0;
    return type === 0 || type === 1 || type === 3;
  };
  const signature = (): string => {
    if (typeof seam.trainerContextSignature === "function") return seam.trainerContextSignature();
    const rows: string[] = [];
    for (let index = 1; index <= seam.trainerServiceCount(); index += 1) {
      const info = seam.trainerServiceInfo(index);
      rows.push(info ? `${info[0]}:${info[2]}:${seam.trainerServiceCost(index).join(",")}` : "?");
    }
    return rows.join("|");
  };
  const current = (): boolean => !disposed && contextToken() === ownerToken && signature() === ownerSignature;
  const isCurrent = (): boolean => {
    try { return current(); } catch { return false; }
  };
  const showNative = (): void => {
    if (nativeShown) return;
    try {
      nativeFallback();
      nativeShown = true;
    } catch { /* native fallback must not prevent a LoD attempt */ }
  };
  const refreshNative = (): void => {
    try {
      nativeFallback();
      nativeShown = true;
    } catch { /* a stale native paint must not block the stock owner */ }
  };
  const trainerErrorCount = (): number => {
    const total = (boot as FrameXmlBoot & { readonly errorCount?: unknown }).errorCount;
    if (typeof total === "number") return total;
    const errors = (boot.vm as typeof boot.vm & { readonly errors?: readonly unknown[] }).errors;
    return Array.isArray(errors) ? errors.length : 0;
  };
  const trainerDiagnosticCount = (): number => {
    const diagnostics = (boot.bridge as typeof boot.bridge & { readonly diagnostics?: readonly unknown[] }).diagnostics;
    return Array.isArray(diagnostics) ? diagnostics.length : 0;
  };
  const callStockGlobal = (name: string): void => {
    const ref = boot.vm.globalFunction(name);
    if (!ref) throw new Error(`Blizzard_TrainerUI ${name} is unavailable`);
    const before = trainerErrorCount();
    try { boot.vm.call(ref, [], 0); } finally { boot.vm.release(ref); }
    if (trainerErrorCount() > before) throw new Error(`Blizzard_TrainerUI ${name} raised a Lua error`);
  };
  const showStock = (target: FrameXmlFrame): void => {
    if (boot.bridge.isVisible(target)) return;
    const errorsBefore = trainerErrorCount();
    const diagnosticsBefore = trainerDiagnosticCount();
    // ShowUIPanel is intentionally neutral in the browser bridge. Seed the exact root visibility
    // first so the stock Show helper does not take its native "failed to show" CloseTrainer path.
    boot.bridge.Show(target);
    if (trainerErrorCount() > errorsBefore || trainerDiagnosticCount() > diagnosticsBefore) {
      throw new Error("Blizzard_TrainerUI ClassTrainerFrame OnShow reported an error");
    }
    callStockGlobal("ClassTrainerFrame_Show");
    if (trainerErrorCount() > errorsBefore || trainerDiagnosticCount() > diagnosticsBefore) {
      throw new Error("Blizzard_TrainerUI ClassTrainerFrame_Show reported an error");
    }
    if (!boot.bridge.isVisible(target)) throw new Error("Blizzard_TrainerUI did not show ClassTrainerFrame");
    // Handoff is the first point at which the complete stock tree is proven. Until this line the
    // native panel remains the visible fallback while the asynchronous LoD request is pending.
    trainerWindow.hidden = true;
    stockOwned = true;
    nativeShown = false;
  };
  const fail = (): void => {
    if (disposed || failed) return;
    failed = true;
    generation += 1;
    stockOwned = false;
    // Production demotion snapshots the live trainer before cleanup hides a partially shown
    // stock root. Let it do that first: ClassTrainerFrame's OnHide closes the interaction, so
    // hiding here before the snapshot would destroy the native fallback we are trying to restore.
    if (onFailure) {
      try { onFailure(); } catch { /* fall through to the local fallback below */ }
      if (disposed) return;
    }
    if (frame) {
      try { boot.bridge.Hide(frame); } catch { /* demotion continues through native fallback */ }
      frame = undefined;
    }
    showNative();
  };
  const load = async (ticket: number): Promise<void> => {
    try {
      const result = await boot.loadAddon("Blizzard_TrainerUI");
      if (ticket !== generation || disposed || !isCurrent()) return;
      if (!result.ok) { fail(); return; }
      renderer.addRoots(result.roots);
      // addRoots() currently reconciles the concrete renderer, but the load-on-demand result may
      // have no roots of its own: the addon can have parented ClassTrainerFrame into UIParent.
      // Reconcile explicitly before looking up the gate so both renderer implementations agree.
      renderer.sync();
      const gate = frameXmlTrainerGate(seam, boot, renderer);
      if (!gate || !isCurrent()) { if (isCurrent()) fail(); return; }
      frame = gate.frame;
      if (desiredOpen && isCurrent()) showStock(frame);
    } catch {
      // This covers renderer, gate and stock-global failures as well as a rejected addon load.
      // It is deliberately inside load so an unobserved promise cannot swallow the demotion.
      if (ticket === generation && !disposed && isCurrent()) fail();
    }
  };
  const begin = (): void => {
    if (disposed || failed || pending || frame || !supported()) return;
    ownerToken = contextToken();
    ownerSignature = signature();
    // Native remains the presentation owner while the async LoD request is pending.
    showNative();
    const ticket = generation;
    pending = load(ticket).finally(() => {
      pending = undefined;
      // A packet/world transition can invalidate this request while it is in flight. Keep the
      // user's open intent, but retarget the next attempt to the current context.
      if (desiredOpen && !disposed && !failed && supported()) begin();
    });
  };
  const retargetPending = (): void => {
    if (!pending) return;
    try {
      if (contextToken() !== ownerToken) {
        generation += 1;
        ownerToken = undefined;
        ownerSignature = "";
      }
    } catch {
      generation += 1;
      ownerToken = undefined;
      ownerSignature = "";
    }
  };
  return {
    isOpen: () => !disposed && (pending !== undefined ? desiredOpen : frame !== undefined && boot.bridge.isVisible(frame)),
    show: () => {
      if (disposed || failed || !supported()) return;
      desiredOpen = true;
      if (frame && current()) showStock(frame); else begin();
    },
    hide: () => {
      desiredOpen = false;
      if (frame) {
        boot.bridge.Hide(frame);
        stockOwned = false;
      }
    },
    close: () => {
      if (disposed || !supported()) return false;
      desiredOpen = false;
      if (pending) {
        generation += 1;
        ownerToken = undefined;
        ownerSignature = "";
        seam.closeTrainer();
        nativeShown = false;
        return true;
      }
      if (frame && boot.bridge.isVisible(frame)) {
        stockOwned = false;
        boot.bridge.Hide(frame);
        return true;
      }
      return false;
    },
    refresh: (event) => {
      if (event === "closed") {
        desiredOpen = false;
        generation += 1;
        nativeShown = false;
        if (frame) {
          boot.bridge.Hide(frame);
          stockOwned = false;
        }
        return;
      }
      if (!supported()) {
        desiredOpen = false;
        const restoreNative = stockOwned || (frame !== undefined && boot.bridge.isVisible(frame));
        if (frame) {
          boot.bridge.Hide(frame);
          stockOwned = false;
        }
        if (restoreNative) refreshNative();
        retargetPending();
        return;
      }
      if (event === "show") {
        desiredOpen = true;
        retargetPending();
        if (pending) refreshNative();
        if (frame && contextToken() === ownerToken) ownerSignature = signature();
        if (frame && current()) showStock(frame); else begin();
        return;
      }
      // A new trainer packet in the same world is a current owner update, not a stale async load.
      // Advance the list signature before dispatching so metadata/list repaint remains live while
      // a completion from the old packet is still prohibited by the world token.
      try {
        if (contextToken() === ownerToken) ownerSignature = signature();
        else retargetPending();
      } catch {
        retargetPending();
      }
      if (pending) refreshNative();
      if (frame && current()) boot.bridge.dispatchEvent("TRAINER_UPDATE");
    },
    demote: fail,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      desiredOpen = false;
      generation += 1;
      if (frame) { try { boot.bridge.Hide(frame); } catch { /* teardown */ } }
      stockOwned = false;
      frame = undefined;
    },
  };
}

/** Structural proof for the load-on-demand player-only Blizzard_TalentUI root. */
function frameXmlTalentGate(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): TalentGate | undefined {
  try {
    const root = boot.bridge.getFrame("PlayerTalentFrame");
    const element = root ? renderer.elementFor(root) : undefined;
    if (!root || root.type !== "Frame" || !element
      || !renderedFrameElement(element, "PlayerTalentFrame", "Frame")) return undefined;
    if (!boot.bridge.hasScript(root, "OnLoad") || !boot.bridge.hasScript(root, "OnShow")
      || !boot.bridge.hasScript(root, "OnHide")) return undefined;
    // The FrameXML binding table is compile-time fixed; this public gate only needs to prove that
    // the supplied seam can answer the projection and the learn boundary that those ten globals
    // delegate to. The real MPQ bridge test exercises every Lua-facing name individually.
    if (typeof seam.talentSnapshot !== "function" || typeof seam.learnTalent !== "function") {
      return undefined;
    }
    boot.bridge.Hide(root);
    if (boot.bridge.isVisible(root)) return undefined;
    return { frame: root, element };
  } catch {
    return undefined;
  }
}

const TSWOW_TALENT_MODULE = "retail-talents";
const TSWOW_TALENT_ROOT = "UniversalTalentFrame";

/** Structural proof for the eager TSWoW module that replaces the stock talent toggle. */
function frameXmlPatchedTalentGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): TalentGate | undefined {
  try {
    const root = boot.bridge.getFrame(TSWOW_TALENT_ROOT);
    const element = root ? renderer.elementFor(root) : undefined;
    if (!root || root.type !== "Frame"
      || !renderedFrameElement(element, TSWOW_TALENT_ROOT, "Frame")) return undefined;
    if (!boot.bridge.hasScript(root, "OnShow") || !boot.bridge.hasScript(root, "OnHide")) {
      return undefined;
    }
    return { frame: root, element };
  } catch {
    return undefined;
  }
}

/**
 * Capture the standard talent toggle after the winning TOC's eager TSAddon blocks have run.
 *
 * `retail-talents` deliberately assigns both ToggleTalentFrame and PlayerTalentFrame_Toggle to its
 * own programmatic `UniversalTalentFrame`.  Calling the captured standard hook respects that patch
 * without loading Blizzard_TalentUI, while the exact root gate prevents a neutral/stale global from
 * taking the native fallback away.  The first failed invocation throws through the controller,
 * which hides any partial custom frame, demotes this owner, and lets the same N press fall back.
 */
export function createPatchedFrameXmlTalentOwner(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  onAcquire?: () => void,
  onFailure?: () => void,
): FrameXmlTalentOwner | undefined {
  if (!boot.isAddonLoaded(TSWOW_TALENT_MODULE)) return undefined;
  const toggle = boot.vm.globalFunction("ToggleTalentFrame");
  if (!toggle) return undefined;
  let frame: FrameXmlFrame | undefined;
  let disposed = false;
  let released = false;

  const locate = (): TalentGate | undefined => frameXmlPatchedTalentGate(boot, renderer);
  const callToggle = (): void => {
    // Native N/micro-button entry bypasses Lua script dispatch, unlike the slash command.
    // Publish the completed window once, rather than repainting it after every Lua setter.
    boot.bridge.runInMutationBatch(() => { boot.vm.call(toggle, [], 0); });
  };
  const release = (): void => {
    if (released) return;
    released = true;
    boot.vm.release(toggle);
  };

  return {
    isOpen: () => {
      if (disposed) return false;
      const gate = locate();
      if (gate) frame = gate.frame;
      return !!gate && boot.bridge.isVisible(gate.frame);
    },
    show: () => {
      if (disposed) throw new Error("patched talent owner is disposed");
      // Close the native fallback before the patched Show path; a failed gate is demoted
      // synchronously and the caller then opens native again from the same key/button press.
      onAcquire?.();
      const existing = locate();
      if (existing && boot.bridge.isVisible(existing.frame)) {
        frame = existing.frame;
        return;
      }
      callToggle();
      const gate = locate();
      if (!gate || !boot.bridge.isVisible(gate.frame)) {
        const partial = boot.bridge.getFrame(TSWOW_TALENT_ROOT);
        if (partial) {
          try { boot.bridge.Hide(partial); } catch { /* controller demotion continues */ }
        }
        throw new Error("patched ToggleTalentFrame did not publish UniversalTalentFrame");
      }
      frame = gate.frame;
    },
    hide: () => {
      const gate = locate();
      if (gate) frame = gate.frame;
      if (frame) boot.bridge.Hide(frame);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (frame) {
        try { boot.bridge.Hide(frame); } catch { /* VM teardown continues */ }
      }
      frame = undefined;
      release();
    },
    ...(onFailure ? { onFailure } : {}),
  };
}

/**
 * Own the load-on-demand talent window without disturbing the already-rendered world HUD.
 *
 * Blizzard_TalentUI is intentionally absent from the base TOC. The first key/button press starts
 * one shared asynchronous load; repeated presses only update the desired-open bit while that load
 * is pending. Once the add-on has completed, its roots are appended incrementally so existing
 * borrowed canvases and texture leases remain intact. A mount teardown invalidates the generation
 * through dispose(), making a late add-on result harmless.
 *
 * `extension` is a dependent LoD add-on hosted inside PlayerTalentFrame — the glyph tab
 * (FrameXmlGlyphOwner.ts): its preloads run before Blizzard_TalentUI, its own load after the talent
 * gate and before the first show, and it hears every show. It never fails the talent owner.
 */
export function createLazyFrameXmlTalentOwner(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  onFailure?: () => void,
  extension?: FrameXmlTalentLodExtension,
): FrameXmlTalentOwner {
  let desiredOpen = false;
  let disposed = false;
  let failed = false;
  let generation = 0;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;

  // `Show(frame)` is sufficient for a static XML root but not for Blizzard_TalentUI. The stock
  // toggle establishes inspect=false, selects the active group and initializes the selected tab
  // before PlayerTalentFrameTalent_OnClick can pass its tab/index to LearnTalent. Keep this call
  // on the same VM and release the retained Lua reference even when a script raises.
  const callStockGlobal = (name: string, args: readonly unknown[]): void => {
    const ref = boot.vm.globalFunction(name);
    if (!ref) throw new Error(`Blizzard_TalentUI ${name} is unavailable`);
    try {
      boot.vm.call(ref, args, 0);
    } finally {
      boot.vm.release(ref);
    }
  };
  const showThroughStockToggle = (target: FrameXmlFrame): void => {
    if (boot.bridge.isVisible(target)) return;
    const activeGroup = seam.talentSnapshot()?.activeTalentGroup;
    callStockGlobal("PlayerTalentFrame_Toggle", [false, activeGroup]);
    // The browser bridge intentionally keeps ShowUIPanel neutral: its ownership lives in the
    // controller, not in the generic Lua compatibility floor. The stock function has nevertheless
    // initialized selectedSpec/talentGroup; finish the visible transition through the bridge when
    // that neutral host helper did not do it itself.
    if (!boot.bridge.isVisible(target)) {
      boot.bridge.Show(target);
    }
    if (!boot.bridge.isVisible(target)) {
      throw new Error("Blizzard_TalentUI did not show PlayerTalentFrame");
    }
    // In the native client ShowUIPanel synchronously runs OnShow while the stock toggle is still
    // on the stack. The compatibility bridge keeps that generic helper neutral, so the first open
    // can arrive with no PanelTemplates selection. Re-enter the stock tab handler once in that
    // narrow case; it performs the same refresh and makes the Lua LearnTalent tab one-based.
    const selectedTab = boot.vm.globalFunction("PanelTemplates_GetSelectedTab");
    let selected: unknown;
    if (selectedTab) {
      try { [selected] = boot.vm.call(selectedTab, [target], 1); }
      finally { boot.vm.release(selectedTab); }
    }
    if (!(Number.isInteger(Number(selected)) && Number(selected) > 0)) {
      const firstTab = boot.bridge.getFrame("PlayerTalentFrameTab1");
      if (!firstTab) throw new Error("Blizzard_TalentUI has no first talent tab");
      callStockGlobal("PlayerTalentTab_OnClick", [firstTab]);
    }
    extension?.afterShow?.();
  };

  const fail = (): void => {
    if (disposed || failed) return;
    failed = true;
    onFailure?.();
  };
  const load = async (ticket: number): Promise<void> => {
    let result;
    try {
      if (extension?.beforeLoad) {
        await extension.beforeLoad();
        if (ticket !== generation || disposed) return;
      }
      result = await boot.loadAddon("Blizzard_TalentUI");
    } catch {
      if (ticket === generation && !disposed) fail();
      return;
    }
    if (ticket !== generation || disposed) return;
    if (!result.ok) {
      fail();
      return;
    }
    // `result.roots` is the exact delta produced by this LoD load. Keep the existing base roots
    // and append only that delta; FrameXmlDomRenderer.mount() would invalidate live adoptions.
    renderer.addRoots(result.roots);
    const gate = frameXmlTalentGate(seam, boot, renderer);
    if (!gate) {
      fail();
      return;
    }
    // The hosted glyph tab loads before the frame is published, so no first show can reach its
    // tab while Blizzard_GlyphUI is still on the way.
    if (extension?.afterLoad) {
      await extension.afterLoad().catch(() => undefined);
      if (ticket !== generation || disposed) return;
    }
    frame = gate.frame;
    if (desiredOpen && !disposed) showThroughStockToggle(frame);
  };
  const begin = (): void => {
    if (disposed || pending || frame) return;
    const ticket = generation;
    pending = load(ticket).catch(() => undefined).finally(() => {
      pending = undefined;
    });
  };

  return {
    // While the add-on is loading there is no frame to query yet, but the controller still needs
    // to observe the user's open intent: a second N or Escape must cancel that intent rather than
    // start a duplicate load or fall through to the game menu.
    isOpen: () => !disposed && (pending !== undefined ? desiredOpen : frame !== undefined && boot.bridge.isVisible(frame)),
    show: () => {
      if (disposed) return;
      desiredOpen = true;
      if (frame) showThroughStockToggle(frame);
      else begin();
    },
    hide: () => {
      desiredOpen = false;
      if (frame) boot.bridge.Hide(frame);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      desiredOpen = false;
      generation += 1;
      if (frame) {
        try { boot.bridge.Hide(frame); } catch { /* VM teardown continues */ }
      }
      frame = undefined;
      try { extension?.dispose?.(); } catch { /* VM teardown continues */ }
    },
    onFailure: fail,
  };
}

/**
 * The stock book is optional at runtime even though its XML is in the bounded vertical.  A loaded
 * Lua file is not ownership: require the exact root, its navigation/close controls, all twelve
 * static spell buttons and the event/script structure that makes those controls live.  This keeps
 * the native `#spellbook-window` as a real fallback when a client patch or renderer loses one part.
 */
function spellBookGate(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): SpellBookGate | undefined {
  try {
    const root = boot.bridge.getFrame("SpellBookFrame");
    const element = root ? renderer.elementFor(root) : undefined;
    if (!root || root.type !== "Frame" || !element
      || !renderedFrameElement(element, "SpellBookFrame", "Frame")) return undefined;

    // The stock frame starts hidden.  Keep that invariant even if a future XML patch changes its
    // declaration: the controller publishes only a closed owner, and Show/Hide then drive Lua.
    boot.bridge.Hide(root);
    if (boot.bridge.isVisible(root)) return undefined;
    if (!boot.bridge.hasScript(root, "OnLoad") || !boot.bridge.hasScript(root, "OnShow")
      || !boot.bridge.hasScript(root, "OnHide")) return undefined;
    if (!root.registeredEvents.has("SPELLS_CHANGED")
      || !root.registeredEvents.has("LEARNED_SPELL_IN_TAB")) return undefined;

    const controls = [
      ["SpellBookFrameTabButton1", "Button"],
      ["SpellBookFrameTabButton2", "Button"],
      ["SpellBookFrameTabButton3", "Button"],
      ["SpellBookPrevPageButton", "Button"],
      ["SpellBookNextPageButton", "Button"],
      ["SpellBookCloseButton", "Button"],
      ...Array.from({ length: 12 }, (_unused, index) => [`SpellButton${index + 1}`, "Button"]),
    ] as const;
    for (const [name, type] of controls) {
      const child = boot.bridge.getFrame(name);
      const childElement = child ? renderer.elementFor(child) : undefined;
      if (!child || (child.type !== type && !(type === "Button" && child.type === "CheckButton"))
        || !frameDescendsFrom(child, root) || !childElement
        || !elementDescendsFrom(childElement, element)
        || !renderedFrameElement(childElement, name, child.type)
        || !boot.bridge.hasScript(child, "OnClick")) return undefined;
    }
    const requiredApis = [
      "spellTabCount", "spellTabInfo", "spellName", "spellTexture", "spellCooldown",
      "spellAutocast", "spellIsPassive", "knownSlotFromHighestRankSlot", "spellIsSelected",
      "hasPetSpells", "castSpell", "updateSpells", "getCVarBool", "setCVar",
    ] as const;
    if (!requiredApis.every((name) => typeof seam[name] === "function")) return undefined;
    return { frame: root, element };
  } catch {
    return undefined;
  }
}

interface PvpGate {
  readonly frame: FrameXmlFrame;
  readonly honorTab: FrameXmlFrame;
  readonly disabledTabs: readonly FrameXmlFrame[];
  readonly battleground?: FrameXmlFrame;
  readonly arena?: FrameXmlFrame;
}

/**
 * Structural gate for the stock PVPParentFrame and its bounded battleground page.  The second tab
 * is enabled only after the complete stock tree, seam and seven-row catalog are present. A
 * missing catalog therefore remains an honor-only owner rather than a partially populated queue.
 */
export function frameXmlPvpGate(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): PvpGate | undefined {
  try {
    const frame = boot.bridge.getFrame("PVPParentFrame");
    const honor = boot.bridge.getFrame("PVPFrame");
    const honorTab = boot.bridge.getFrame("PVPParentFrameTab1");
    const battlegroundTab = boot.bridge.getFrame("PVPParentFrameTab2");
    if (!frame || frame.type !== "Frame" || !honor || honor.type !== "Frame"
      || honor.parent !== frame || !honorTab
      || (honorTab.type !== "Button" && honorTab.type !== "CheckButton")
      || honorTab.parent !== frame || !battlegroundTab
      || (battlegroundTab.type !== "Button" && battlegroundTab.type !== "CheckButton")
      || battlegroundTab.parent !== frame) return undefined;
    const frameElement = renderer.elementFor(frame);
    const honorElement = renderer.elementFor(honor);
    const honorTabElement = renderer.elementFor(honorTab);
    const battlegroundTabElement = renderer.elementFor(battlegroundTab);
    if (!renderedFrameElement(frameElement, frame.name, frame.type)
      || !renderedFrameElement(honorElement, honor.name, honor.type)
      || !renderedFrameElement(honorTabElement, honorTab.name, honorTab.type)
      || !renderedFrameElement(battlegroundTabElement, battlegroundTab.name, battlegroundTab.type)
      || !frameDescendsFrom(honor, frame) || !elementDescendsFrom(honorElement, frameElement)
      || !elementDescendsFrom(honorTabElement, frameElement)
      || !elementDescendsFrom(battlegroundTabElement, frameElement)) return undefined;
    if (!boot.bridge.hasScript(frame, "OnLoad") || !boot.bridge.hasScript(frame, "OnShow")
      || !boot.bridge.hasScript(frame, "OnHide") || !boot.bridge.hasScript(honor, "OnLoad")
      || !boot.bridge.hasScript(honor, "OnEvent")) return undefined;
    const requiredApis = [
      "pvpSessionStats", "pvpYesterdayStats", "pvpLifetimeStats", "pvpRankInfo",
      "pvpRank", "pvpRankProgress", "pvpHonorCurrency", "pvpArenaCurrency",
    ] as const;
    if (!requiredApis.every((name) => typeof seam[name] === "function")) return undefined;
    const battlefieldFrame = boot.bridge.getFrame("BattlefieldFrame");
    // BattlefieldFrame is included for its stock closure (not as an owner). It registers the
    // outdoor/Wintergrasp manager events and BATTLEFIELDS_SHOW on load; those are unregistered
    // while it remains hidden so they cannot drive an unsupported dialog path. UPDATE_BATTLEFIELD_STATUS
    // comes back only with the complete battleground page below: it is the only route to stock
    // CONFIRM_BATTLEFIELD_ENTRY (BattlefieldFrame.lua:56-59, 252-289), which the popup owner takes
    // over once it sees the event registered, and BattlefieldFrame_UpdateStatus needs the catalog's
    // queue names and the queue clocks (GetBattlefieldTimeWaited…) for every status, not just «confirm».
    let battlefieldStatus = false;
    if (battlefieldFrame) {
      const bridge = boot.bridge as typeof boot.bridge & {
        UnregisterAllEvents?: (frame: FrameXmlFrame) => boolean;
      };
      battlefieldStatus = battlefieldFrame.registeredEvents.has("UPDATE_BATTLEFIELD_STATUS");
      bridge.UnregisterAllEvents?.(battlefieldFrame);
      boot.bridge.Hide(battlefieldFrame);
    }
    // ArenaFrame is a sibling of PVPParentFrame, not a child of the tabbed owner. Keep it on the
    // same publication/controller when its complete stock tree and authoritative arena seam are
    // present; otherwise leave the native ArenaWindow lane untouched.
    const arenaFrame = boot.bridge.getFrame("ArenaFrame");
    const arenaElement = arenaFrame ? renderer.elementFor(arenaFrame) : undefined;
    const arenaChild = (name: string, script?: string): boolean => {
      const child = boot.bridge.getFrame(name);
      const childElement = child ? renderer.elementFor(child) : undefined;
      return !!child && child.type === "Button" && !!childElement
        && frameDescendsFrom(child, arenaFrame!)
        && elementDescendsFrom(childElement, arenaElement!)
        && renderedFrameElement(childElement, name, child.type)
        && (script === undefined || boot.bridge.hasScript(child, script));
    };
    const arenaReady = !!arenaFrame
      && arenaFrame.type === "Frame"
      && !!arenaElement
      && renderedFrameElement(arenaElement, arenaFrame.name, arenaFrame.type)
      && boot.bridge.hasScript(arenaFrame, "OnLoad")
      && boot.bridge.hasScript(arenaFrame, "OnEvent")
      && boot.bridge.hasScript(arenaFrame, "OnShow")
      && boot.bridge.hasScript(arenaFrame, "OnHide")
      && ["ArenaZone1", "ArenaZone2", "ArenaZone3", "ArenaZone4", "ArenaZone5", "ArenaZone6"]
        .every((name) => arenaChild(name, "OnClick"))
      && arenaChild("ArenaFrameJoinButton", "OnClick")
      && arenaChild("ArenaFrameGroupJoinButton", "OnClick")
      && arenaChild("ArenaFrameCancelButton")
      && arenaChild("ArenaFrameCloseButton")
      && [
        "isBattlefieldArena", "currentArenaSeason", "canJoinBattlefieldAsGroup",
        "isPartyLeader", "joinArena",
      ].every((name) => typeof seam[name as keyof FrameXmlWorldSeam] === "function");
    const arena = arenaReady ? arenaFrame : undefined;
    const battleground = boot.bridge.getFrame("PVPBattlegroundFrame");
    const bgElement = battleground ? renderer.elementFor(battleground) : undefined;
    const frameXmlUi = boot.bridge as typeof boot.bridge & {
      HookScript?: (frame: FrameXmlFrame, script: string, handler: (...args: unknown[]) => void) => boolean;
    };
    const bgChild = (name: string, type: string, script?: string): boolean => {
      const child = boot.bridge.getFrame(name);
      const childElement = child ? renderer.elementFor(child) : undefined;
      return !!child && child.type === type && !!childElement
        && frameDescendsFrom(child, battleground!)
        && elementDescendsFrom(childElement, bgElement!)
        && renderedFrameElement(childElement, name, type)
        && (script === undefined || boot.bridge.hasScript(child, script));
    };
    const bgChildrenReady = !!battleground && !!bgElement
      && [
        ["PVPBattlegroundFrameTypeScrollFrame", "ScrollFrame"],
        ["PVPBattlegroundFrameInfoScrollFrame", "ScrollFrame"],
        ["PVPBattlegroundFrameInfoScrollFrameChildFrameDescription", "FontString"],
        ["PVPBattlegroundFrameInfoScrollFrameChildFrameRewardsInfo", "Frame"],
        ["PVPBattlegroundFrameJoinButton", "Button", "OnClick"],
        ["PVPBattlegroundFrameGroupJoinButton", "Button", "OnClick"],
        ["BattlegroundType1", "Button", "OnClick"],
        ["BattlegroundType2", "Button", "OnClick"],
        ["BattlegroundType3", "Button", "OnClick"],
        ["BattlegroundType4", "Button", "OnClick"],
        ["BattlegroundType5", "Button", "OnClick"],
      ].every(([name, type, script]) => bgChild(name!, type!, script));
    const fullBattleground = !!battleground
      && battleground.type === "Frame"
      && battleground.parent === frame
      && !!bgElement
      && renderedFrameElement(bgElement, battleground.name, battleground.type)
      && boot.bridge.hasScript(battleground, "OnLoad")
      && boot.bridge.hasScript(battleground, "OnShow")
      && boot.bridge.hasScript(battleground, "OnHide")
      && boot.bridge.hasScript(battleground, "OnEvent")
      && bgChildrenReady
      && seam.battlegroundCatalogReady()
      && seam.battlegroundTypeCount() === FRAMEXML_BATTLEGROUND_TYPE_IDS.length
      && [
        "battlegroundTypeCount", "battlegroundInfo", "battlefieldInfo", "battlefieldStatus",
        "requestBattlegroundInstanceInfo", "joinBattleground", "sortBattlegroundList",
        "closeBattleground", "randomBattlegroundHonorBonuses", "holidayBattlegroundHonorBonuses",
      ].every((name) => typeof seam[name as keyof FrameXmlWorldSeam] === "function");
    if (fullBattleground) {
      // Wintergrasp has a different protocol and no authoritative timer in this vertical. Remove
      // its update script and keep it hidden even when PVPBattlegroundFrame_OnShow calls Show().
      const timer = boot.bridge.getFrame("WintergraspTimer");
      if (timer) {
        boot.bridge.SetScript(timer, "OnUpdate", null);
        frameXmlUi.HookScript?.(timer, "OnShow", () => { boot.bridge.Hide(timer); });
        boot.bridge.Hide(timer);
      }
      boot.bridge.Hide(frame);
      // The stock OnLoad can have hidden the tabs before the catalog became available in a
      // future loader; restore only the supported second tab at this publication boundary.
      (battlegroundTab as FrameXmlFrame & { enabled: boolean }).enabled = true;
      boot.bridge.Show(battlegroundTab);
      if (battlefieldFrame && battlefieldStatus) boot.bridge.RegisterEvent(battlefieldFrame, "UPDATE_BATTLEFIELD_STATUS");
      return arena
        ? { frame, honorTab, disabledTabs: [], battleground, arena }
        : { frame, honorTab, disabledTabs: [], battleground };
    }
    // Hide before publication. Hiding alone is not enough: a queued click must not reach the
    // stock handler and dereference an unsupported page, so leave the mutable disabled state too.
    (battlegroundTab as FrameXmlFrame & { enabled: boolean }).enabled = false;
    boot.bridge.Hide(frame);
    boot.bridge.Hide(battlegroundTab);
    if (boot.bridge.isVisible(frame) || boot.bridge.isVisible(battlegroundTab)
      || (battlegroundTab as FrameXmlFrame & { enabled: boolean }).enabled) return undefined;
    return arena
      ? { frame, honorTab, disabledTabs: [battlegroundTab], arena }
      : { frame, honorTab, disabledTabs: [battlegroundTab] };
  } catch {
    return undefined;
  }
}

/**
 * The pet replacement is contextual and must not claim the native lane merely because a pet
 * happens to exist.  Require the static PetFrame bridge tree, its rendered DOM, the four stock
 * debuff Icon/Border pairs, and SecureUnitButton's structural pet-target binding.  No current
 * visibility, aura or cast state is sampled here, so the gate remains valid before a pet spawns.
 */
function petGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): HTMLElement | undefined {
  try {
    const petFrame = boot.bridge.getFrame("PetFrame");
    const petFrameElement = petFrame ? renderer.elementFor(petFrame) : undefined;
    if (!petFrame || petFrame.type !== "Button"
      || !renderedFrameElement(petFrameElement, "PetFrame", "Button")
      || petFrame.secureAttributes.get("unit") !== "pet"
      || petFrame.secureAttributes.get("*type1") !== "target") return undefined;

    const requiredChildren = [
      ["PetPortrait", "Texture"],
      ["PetFrameHealthBar", "StatusBar"],
      ["PetFrameManaBar", "StatusBar"],
    ] as const;
    for (const [name, type] of requiredChildren) {
      const frame = boot.bridge.getFrame(name);
      const element = frame ? renderer.elementFor(frame) : undefined;
      if (!frame || frame.parent !== petFrame || !element
        || element.parentElement !== petFrameElement
        || !renderedFrameElement(element, name, type)) return undefined;
    }

    for (let index = 1; index <= 4; index += 1) {
      const debuffName = `PetFrameDebuff${index}`;
      const debuff = boot.bridge.getFrame(debuffName);
      const debuffElement = debuff ? renderer.elementFor(debuff) : undefined;
      if (!debuff || debuff.type !== "Button" || debuff.parent !== petFrame || !debuffElement
        || debuffElement.parentElement !== petFrameElement
        || !renderedFrameElement(debuffElement, debuffName, "Button")) return undefined;
      for (const suffix of ["Icon", "Border"] as const) {
        const name = `${debuffName}${suffix}`;
        const child = boot.bridge.getFrame(name);
        const childElement = child ? renderer.elementFor(child) : undefined;
        if (!child || child.type !== "Texture" || child.parent !== debuff || !childElement
          || childElement.parentElement !== debuffElement
          || !renderedFrameElement(childElement, name, "Texture")) return undefined;
      }
    }

    const portrait = boot.bridge.getFrame("PetPortrait");
    const portraitElement = portrait ? renderer.elementFor(portrait) : undefined;
    return portraitElement && portraitElement.parentElement === petFrameElement
      ? portraitElement : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stock pet bar is all-or-nothing too: PetActionBarFrame under MainMenuBar and its ten
 * PetActionButtons, each with the four children PetActionBar_Update and the cooldown sweep write
 * (`Icon`, `Cooldown`, `AutoCastable`, `Shine`), all rendered, and a seam that answers the pet-bar
 * C API. Nothing about the current pet is sampled: the gate holds before any pet is summoned.
 */
function petActionBarGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  seam: FrameXmlWorldSeam,
): boolean {
  try {
    if (!seam.petActions) return false;
    const bar = boot.bridge.getFrame("PetActionBarFrame");
    const barElement = bar ? renderer.elementFor(bar) : undefined;
    if (!bar || bar.type !== "Frame" || bar.parent?.name !== "MainMenuBar"
      || !renderedFrameElement(barElement, "PetActionBarFrame", "Frame")) return false;
    for (let index = 1; index <= FRAMEXML_PET_ACTION_SLOTS; index += 1) {
      const name = `PetActionButton${index}`;
      const button = boot.bridge.getFrame(name);
      const buttonElement = button ? renderer.elementFor(button) : undefined;
      if (!button || button.type !== "CheckButton" || button.parent !== bar || button.id !== index
        || !renderedFrameElement(buttonElement, name, "CheckButton")) return false;
      for (const [suffix, type] of [["Icon", "Texture"], ["Cooldown", "Cooldown"], ["AutoCastable", "Texture"], ["Shine", "Frame"]] as const) {
        const child = boot.bridge.getFrame(`${name}${suffix}`);
        const childElement = child ? renderer.elementFor(child) : undefined;
        if (!child || child.type !== type || !frameDescendsFrom(child, button)
          || !renderedFrameElement(childElement, `${name}${suffix}`, type)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current = frame.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function elementDescendsFrom(element: HTMLElement, ancestor: HTMLElement): boolean {
  let current = element.parentElement;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * PartyFrame is optional and all-or-nothing: every static stock row and every existing native
 * party canvas must be available before #party-frames can be hidden. The FrameXML template nests
 * portraits/bars/debuffs below anonymous layout Frames, hence the ancestor checks rather than a
 * direct-child assumption. No current party membership or widget visibility is sampled.
 */
function partyGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): readonly HTMLElement[] | undefined {
  try {
    const portraits: HTMLElement[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const rootName = `PartyMemberFrame${index}`;
      const root = boot.bridge.getFrame(rootName);
      const rootElement = root ? renderer.elementFor(root) : undefined;
      if (!root || root.type !== "Button"
        || !renderedFrameElement(rootElement, rootName, "Button")
        || root.secureAttributes.get("unit") !== `party${index}`
        || root.secureAttributes.get("*type1") !== "target") return undefined;

      const requiredChildren = [
        [`${rootName}Portrait`, "Texture"],
        [`${rootName}Name`, "FontString"],
        [`${rootName}HealthBar`, "StatusBar"],
        [`${rootName}ManaBar`, "StatusBar"],
      ] as const;
      for (const [name, type] of requiredChildren) {
        const child = boot.bridge.getFrame(name);
        const childElement = child ? renderer.elementFor(child) : undefined;
        if (!child || !frameDescendsFrom(child, root) || !childElement || !rootElement
          || !elementDescendsFrom(childElement, rootElement)
          || !renderedFrameElement(childElement, name, type)) return undefined;
        if (name.endsWith("Portrait")) portraits.push(childElement);
      }

      for (let debuffIndex = 1; debuffIndex <= 4; debuffIndex += 1) {
        const debuffName = `${rootName}Debuff${debuffIndex}`;
        const debuff = boot.bridge.getFrame(debuffName);
        const debuffElement = debuff ? renderer.elementFor(debuff) : undefined;
        if (!debuff || debuff.type !== "Button" || !frameDescendsFrom(debuff, root)
          || !debuffElement || !rootElement || !elementDescendsFrom(debuffElement, rootElement)
          || !renderedFrameElement(debuffElement, debuffName, "Button")) return undefined;
        for (const suffix of ["Icon", "Border"] as const) {
          const name = `${debuffName}${suffix}`;
          const child = boot.bridge.getFrame(name);
          const childElement = child ? renderer.elementFor(child) : undefined;
          if (!child || child.type !== "Texture" || !frameDescendsFrom(child, debuff)
            || !childElement || !elementDescendsFrom(childElement, debuffElement)
            || !renderedFrameElement(childElement, name, "Texture")) return undefined;
        }
      }
    }
    return portraits.length === 4 ? portraits : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Route the stock minimap world-map button through the host's gated map toggle.
 *
 * Minimap.xml's own OnClick is `ToggleFrame(WorldMapFrame)`, which bypasses frameXmlWorldMapGate:
 * clicked before the map data is ready (or with an unresolved corpse position) it showed the stock
 * map and WorldMapButton_OnUpdate failed every frame at worldmapframe.lua:900 — 702 errors in about
 * 12 s offline. toggleWorldMap() uses the published stock owner only after that gate and the
 * native panel otherwise, so this button can never show WorldMapFrame unready.
 */
export function installFrameXmlMinimapWorldMapButton(
  boot: Pick<FrameXmlBoot, "vm">,
  toggle: () => void = toggleWorldMap,
): boolean {
  boot.vm.registerGlobal("__fxToggleWorldMap", () => { toggle(); return []; });
  const result = boot.vm.execute(`
    if MiniMapWorldMapButton then
      MiniMapWorldMapButton:SetScript("OnClick", function() __fxToggleWorldMap() end)
    end
  `, "@webclient/minimap-world-map");
  return result.ok;
}

/**
 * Load Blizzard_TimeManager, the stock owner of the minimap clock, and show the clock as the
 * client's «Show clock» option would.
 *
 * Stock loads it only from the Interface Options display panel (InterfaceOptionsPanels.lua:570-580:
 * `TimeManager_LoadUI(); TimeManagerClockButton_Show()` for showClock "1"), which this vertical
 * leaves out, so without this the corner had no clock at all once the native one was retired. The
 * add-on goes through the host LoD path like the trainer recipe; loading it before the renderer
 * mounts lets its UIParent/Minimap children render with the rest of the tree. A corpus without
 * UIParent.lua's `TimeManager_LoadUI` (a unit fixture, a trimmed TOC) has no clock owner and is
 * left alone, as is a failed load: the rest of the HUD does not depend on the clock. An unset
 * showClock follows the 3.3.5 default, which is on.
 */
export async function loadFrameXmlStockClock(
  boot: Pick<FrameXmlBoot, "vm" | "loadAddon">,
): Promise<boolean> {
  const loader = boot.vm.globalFunction("TimeManager_LoadUI");
  if (!loader) return false;
  boot.vm.release(loader);
  const result = await boot.loadAddon("Blizzard_TimeManager");
  if (!result.ok) {
    console.warn(`[framexml] Blizzard_TimeManager: ${result.message ?? result.status}`);
    return false;
  }
  return boot.vm.executeReported(`
    local show = GetCVar("showClock")
    if (show == nil or show == "1") and TimeManagerClockButton_Show then
      TimeManagerClockButton_Show()
    end
  `, "@webclient/stock-clock");
}

/** Distinct step failures reported per mount; after that the HUD keeps ticking silently. */
const FRAMEXML_STEP_ERROR_REPORT_LIMIT = 32;

/**
 * One thrown HUD frame must not freeze the HUD. The per-frame step catches, reports each distinct
 * failure once (the same throw recurs every frame at 60 Hz), and always re-arms its next frame.
 */
export function createFrameXmlStepErrorReporter(
  report: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): (error: unknown) => void {
  const seen = new Set<string>();
  return (error: unknown): void => {
    const key = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (seen.has(key) || seen.size >= FRAMEXML_STEP_ERROR_REPORT_LIMIT) return;
    seen.add(key);
    report(`[framexml] HUD frame step failed; the HUD keeps ticking: ${key}`, error);
  };
}

/** Client add-ons (lower-case) turned off by DisableAllAddOns() for the rest of this page session. */
const sessionDisabledClientAddons = new Set<string>();

export function frameXmlClientAddonEnabled(name: string): boolean {
  return !sessionDisabledClientAddons.has(name.toLowerCase());
}

/** The session's DisableAllAddOns() result, for diagnostics and tests. */
export function frameXmlSessionDisabledClientAddons(): readonly string[] {
  return [...sessionDisabledClientAddons];
}

/**
 * DisableAllAddOns() and ReloadUI(), which the stock TOO_MANY_LUA_ERRORS popup runs from its accept
 * button (StaticPopup.lua) and /reload runs by itself. Both were unbound here, so the popup that
 * appears at the 1000th handled error (BasicControls.xml `_ERROR_LIMIT`) could fix nothing.
 *
 * DisableAllAddOns turns off, for this page session only, the eager and load-on-demand *client*
 * add-ons from the gateway's /client/addons list (AnyIDTooltip, MikScrollingBattleText, ...) — the
 * measured source of the canned error storm (4007 of 4237 errors from msbtparser.lua:769). TSWoW
 * modules are the server's own interface and Blizzard_* add-ons are the client, so neither is
 * touched. ReloadUI remounts the HUD through the same unmount/mount lifecycle a UI-mode switch uses:
 * PLAYER_LOGOUT and the saved-variable flush run on close, then a fresh VM loads without the
 * disabled add-ons and with `_ERROR_COUNT` back at zero.
 */
export function installFrameXmlReloadUi(
  vm: Pick<FrameXmlBoot["vm"], "registerGlobal">,
  clientAddons: readonly string[],
  reload: () => void,
): void {
  vm.registerGlobal("DisableAllAddOns", () => {
    for (const name of clientAddons) sessionDisabledClientAddons.add(name.toLowerCase());
    return [];
  });
  vm.registerGlobal("ReloadUI", () => { reload(); return []; });
}

/**
 * The renderer's browser facts, scoped to this host.
 *
 * A verbatim port of the `#glue-stage` block in `glue/glue.css`: absolute positioning for every
 * widget, the texcoord crop with its `object-view-box` upgrade, a non-interactive Texture and
 * FontString, and the blank-texture rule that stops an `<img>` with no `src` from drawing the
 * browser's own broken-image glyph. Nothing here styles a widget's appearance — every box, colour
 * and picture comes out of the client's own XML.
 */
const HOST_CSS = `
${NATIVE_LANES_HIDE_SELECTOR} { display: none !important; }
${NATIVE_TARGET_CORE_HIDE_SELECTOR} { display: none !important; }
${NATIVE_MINIMAP_HIDE_SELECTOR} { display: none !important; }
${NATIVE_RAIL_BELOW_STOCK_MINIMAP_CSS}
${FRAMEXML_NATIVE_OWNED_DEPENDENCY_SELECTOR} { display: none !important; }
${NATIVE_PET_BAR_HIDE_SELECTOR} { display: none !important; }
${NATIVE_CHAT_HIDE_SELECTOR} { display: none !important; }
${FRAMEXML_EDIT_BOX_INPUT_CSS}
${NATIVE_FOCUS_HIDE_SELECTOR} { display: none !important; }
${NATIVE_TOT_HIDE_SELECTOR} { display: none !important; }
${NATIVE_BAGS_HIDE_SELECTOR} { display: none !important; }
${NATIVE_CHARACTER_HIDE_SELECTOR} { display: none !important; }
${NATIVE_MICROBUTTONS_HIDE_SELECTOR} { display: none !important; }
${NATIVE_TARGET_PANEL_SELECTOR} {
  width: 0 !important;
  height: 0 !important;
  min-width: 0 !important;
  min-height: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  overflow: visible !important;
}
#${HOST_ID} {
  position: absolute;
  inset: 0;
  z-index: 3;
  /* Screen clipping must not create a scroll container: focusing a bottom-row button can scroll
     overflow:hidden hosts to off-screen texture bounds and displace every authored anchor. */
  overflow: clip;
  /* The mounted vertical is a transparent overlay except for authored controls; a host that ate
     clicks would take click-to-target away from the world canvas underneath. */
  pointer-events: none;
  color: #ffd100;
  font-family: "Segoe UI", system-ui, sans-serif;
}
#${HOST_ID}, #${HOST_ID} * { box-sizing: border-box; }
/* No CSS transitions inside the HUD: Lua animates it. The page's reduced-motion rule (style.css)
   gives every element a 0.001 ms transition of every property, so with the system's animation
   effects off each alpha, colour or position the HUD writes started a CSS transition, and an
   element's style recalc grew slower with every one it had started since the last major GC —
   measured on the rich route, BuffButton1's recalc 20 µs after a GC and 645 µs a minute later, the
   idle frame 2.5 ms -> 11 ms over 100 s after a mount. Without them the recalc stays flat. */
#${HOST_ID}, #${HOST_ID} * { transition-property: none !important; }
#${STAGE_ID} { position: absolute; top: 0; left: 0; transform-origin: top left; }
#${STAGE_ID} [data-framexml-type] {
  position: absolute;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  line-height: 1;
  white-space: pre;
}
#${STAGE_ID} [data-framexml-type="Texture"] { display: block; image-rendering: auto; pointer-events: none; }
#${STAGE_ID} [data-framexml-texcoords] { clip-path: inset(var(--framexml-texcoord-inset, 0)); }
@supports (object-view-box: inset(0)) {
  #${STAGE_ID} [data-framexml-texcoords] {
    clip-path: none;
    object-view-box: inset(var(--framexml-texcoord-inset, 0));
    object-fit: fill;
  }
}
#${STAGE_ID} [data-framexml-type="FontString"] { display: block; pointer-events: none; }
#${STAGE_ID} [data-framexml-type="Button"],
#${STAGE_ID} [data-framexml-type="CheckButton"] {
  cursor: pointer;
  appearance: none;
  /* The one thing that *does* take clicks: an action button. */
  pointer-events: auto;
}
/* Match the login renderer's state-texture contract: opaque highlight plates must not
   cover idle/disabled button labels. LockHighlight remains an inline override. */
#${STAGE_ID} [data-framexml-state-texture="HIGHLIGHT"] { visibility: hidden; }
#${STAGE_ID} [data-framexml-type="Button"]:not([disabled]):hover > [data-framexml-state-texture="HIGHLIGHT"],
#${STAGE_ID} [data-framexml-type="CheckButton"]:not([disabled]):hover > [data-framexml-state-texture="HIGHLIGHT"] {
  visibility: visible;
}
#${STAGE_ID} [data-framexml-type="EditBox"],
#${STAGE_ID} [data-framexml-type="EditBox"] [data-framexml-input="true"] {
  pointer-events: auto;
}
#${STAGE_ID} [data-framexml-blank] { visibility: hidden; }
`;

const TARGET_CONTEXT_CSS = `${NATIVE_TARGET_CONTEXT_HIDE_SELECTOR} { display: none !important; }`;
const PET_CSS = `${NATIVE_PET_HIDE_SELECTOR} { display: none !important; }`;
const PARTY_CSS = `${NATIVE_PARTY_HIDE_SELECTOR} { display: none !important; }`;

/** The 768-unit logical screen the client lays its interface out in; `GlueRuntime.ts`'s number. */

export interface FrameXmlWorldMountResult {
  readonly ok: boolean;
  readonly message: string;
  /** Files, widgets and milliseconds, for the console line and the acceptance check. */
  readonly numbers?: {
    readonly files: number;
    readonly bytes: number;
    readonly widgets: number;
    readonly errorsRaised: number;
    readonly distinctErrors: number;
    readonly scanMs: number;
    readonly planMs: number;
    readonly loadMs: number;
    readonly totalMs: number;
  };
}

interface FrameXmlMountResources {
  settingsCleanup?: () => void;
  mirrorTimersCleanup?: () => void;
  readonly addonsOnly?: boolean;
  diagnosticCleanup?: () => void;
  /** Removes `window.frameXmlWorldPerf` (FrameXmlWorldPerf.ts). */
  perfCleanup?: () => void;
  nativeTooltipCleanup?: () => void;
  addonLayerCleanup?: () => void;
  models?: FrameXmlModelPreview;
  addonEntrypointsCleanup?: () => void;
  readonly host: HTMLElement;
  readonly style: HTMLStyleElement;
  readonly boot: FrameXmlBoot;
  readonly seam: FrameXmlWorldSeam;
  readonly resize: () => void;
  renderer?: FrameXmlDomRenderer;
  minimapCleanup?: () => void;
  portraitCleanup?: () => void;
  targetPortraitCleanup?: () => void;
  questGiverPortraitCleanup?: () => void;
  /** Releases every stock SetPortraitTexture canvas and renderer target (FrameXmlPortraits.ts). */
  stockPortraitsCleanup?: () => void;
  /** The cursor picture and its let-go input (FrameXmlCursorDom.ts). */
  cursorDomCleanup?: () => void;
  focusPortraitCleanup?: () => void;
  targetOfTargetPortraitCleanup?: () => void;
  /** The canvas created over FocusFrameToTPortrait (no native row stands behind it). */
  focusTargetPortraitCleanup?: () => void;
  spellbookOwnerCleanup?: () => void;
  nativeSpellbookWasHidden?: boolean;
  spellbookFrame?: FrameXmlFrame;
  talentOwner?: FrameXmlTalentOwner;
  talentOwnerCleanup?: () => void;
  talentOwnerDemoted?: boolean;
  bagOwner?: FrameXmlBagOwner;
  bagOwnerCleanup?: () => void;
  nativeInventoryWasHidden?: boolean;
  bagOwnerDemoted?: boolean;
  characterOwner?: FrameXmlCharacterOwner;
  characterOwnerCleanup?: () => void;
  characterPortraitCleanup?: () => void;
  nativeCharacterWasHidden?: boolean;
  characterOwnerDemoted?: boolean;
  /** Set only if the all-or-nothing micro-button owner gate ever succeeds. */
  microButtonNativeReplacementActive?: boolean;
  pvpOwner?: FrameXmlPvpOwner;
  pvpOwnerCleanup?: () => void;
  gameMenuOwner?: FrameXmlGameMenuOwner;
  gameMenuOwnerCleanup?: () => void;
  lfdOwner?: FrameXmlLfdOwner;
  lfdOwnerCleanup?: () => void;
  friendsOwner?: FrameXmlFriendsOwner;
  friendsOwnerCleanup?: () => void;
  lootOwner?: FrameXmlLootOwner;
  lootOwnerCleanup?: () => void;
  popupsOwner?: FrameXmlPopupsOwner;
  popupsOwnerCleanup?: () => void;
  mailOwner?: FrameXmlMailOwner;
  mailOwnerCleanup?: () => void;
  tradeOwner?: FrameXmlTradeOwner;
  tradeOwnerCleanup?: () => void;
  npcWindows?: ReturnType<typeof mountFrameXmlNpcWindows>;
  npcWindowsCleanup?: () => void;
  /** The lazy stock MacroFrame and KeyBindingFrame owners (FrameXmlMacroBindingMount.ts). */
  macroBindingWindowsCleanup?: () => void;
  /** The lazy stock CalendarFrame owner (FrameXmlCalendarOwner.ts). */
  calendarCleanup?: () => void;
  /** The lazy stock Video/Audio/Interface options and the extra bars' uvars (FrameXmlOptionsOwner.ts). */
  optionsCleanup?: () => void;
  pvpFrame?: FrameXmlFrame;
  merchantOwner?: FrameXmlMerchantOwner;
  merchantOwnerCleanup?: () => void;
  merchantFrame?: FrameXmlFrame;
  nativeVendorWasHidden?: boolean;
  trainerOwner?: FrameXmlTrainerOwner;
  trainerOwnerCleanup?: () => void;
  trainerFrame?: FrameXmlFrame;
  nativeTrainerWasHidden?: boolean;
  trainerOwnerDemoted?: boolean;
  /** The lazy stock TradeSkillFrame (FrameXmlTradeSkillLive.ts) and its publication's cleanup. */
  tradeSkillMount?: FrameXmlTradeSkillMount;
  tradeSkillCleanup?: () => void;
  /** The lazy stock AuctionFrame (FrameXmlAuctionMount.ts); hands an open house back to the native window. */
  auctionCleanup?: () => void;
  /** The stock DressUpFrame's model methods and model stage (FrameXmlDressUpMount.ts). */
  dressUpCleanup?: (() => void) | undefined;
  /** The lazy stock InspectFrame, ItemSocketingFrame and BarberShopFrame (FrameXmlInspectMount.ts). */
  inspectSocketBarberCleanup?: () => void;
  achievementCleanup?: () => void;
  /** The lazy stock GuildBankFrame (FrameXmlGuildBankMount.ts); hands an open bank back to the native window. */
  guildBankCleanup?: () => void;
  /** The lazy Blizzard_RaidUI grid of the stock Raid tab (FrameXmlRaidLod.ts). */
  raidGridCleanup?: () => void;
  /** The lazy Blizzard_ArenaUI enemy frames (FrameXmlArenaLod.ts). */
  arenaEnemyCleanup?: (() => void) | undefined;
  /** The lazy Blizzard_TokenUI of the stock character tab 5 and the backpack strip (FrameXmlTokenOwner.ts). */
  tokenCleanup?: (() => void) | undefined;
  questOwner?: FrameXmlQuestOwner;
  questOwnerCleanup?: () => void;
  nativeQuestLogState?: QuestLogNativeState;
  questOwnerDemoted?: boolean;
  questGiverOwner?: FrameXmlQuestGiverOwner;
  questGiverOwnerCleanup?: () => void;
  questGiverEscapeCleanup?: () => void;
  petPortraitCleanup?: () => void;
  partyPortraitCleanups?: readonly (() => void)[];
  worldMapOwnerCleanup?: () => void;
  nativeChatLogState?: NativeChatLogState;
  chatInputCleanup?: () => void;
  frame?: number;
}

function restoreNativeInventory(record: FrameXmlMountResources): void {
  const wasHidden = record.nativeInventoryWasHidden;
  if (wasHidden === undefined) return;
  try {
    inventoryWindow.hidden = wasHidden;
    // Keep the marker until the DOM assignment succeeds, so an unusual host setter can be retried
    // by the remaining teardown path rather than silently losing the native state.
    delete record.nativeInventoryWasHidden;
  } catch {
    // The caller's best-effort cleanup continues; the marker remains available for a retry.
  }
}

function demotePublishedBags(record: FrameXmlMountResources): void {
  if (record.bagOwnerDemoted) return;
  record.bagOwnerDemoted = true;
  // The controller has already removed this owner before invoking onFailure. Reveal the native
  // route only now, after the stock bridge close/dispose has completed. Close any native dynamic
  // panels that may have been opened by a concurrent fallback caller while the replacement class
  // was active; otherwise removing the CSS would resurrect a stale `.bag-window`.
  bestEffortCleanup(() => closeBagWindows());
  bestEffortCleanup(() => setNativeBagsReplacementActive(false));
  restoreNativeInventory(record);
}

function demotePublishedCharacter(record: FrameXmlMountResources): void {
  if (record.characterOwnerDemoted) return;
  record.characterOwnerDemoted = true;
  bestEffortCleanup(() => setNativeCharacterReplacementActive(false));
  if (record.nativeCharacterWasHidden !== undefined) {
    bestEffortCleanup(() => { characterWindow.hidden = record.nativeCharacterWasHidden!; });
    delete record.nativeCharacterWasHidden;
  }
  bestEffortCleanup(() => record.characterPortraitCleanup?.());
}

function demotePublishedQuest(record: FrameXmlMountResources): void {
  if (record.questOwnerDemoted) return;
  record.questOwnerDemoted = true;
  // Controller demotion has already removed and closed this owner.  Restore the browser panel only
  // after that close so a failed stock mutation can never leave two quest-log owners visible.
  bestEffortCleanup(() => record.questOwnerCleanup?.());
  if (!record.questOwnerCleanup) bestEffortCleanup(() => record.questOwner?.hide());
  bestEffortCleanup(() => record.questOwner?.dispose?.());
  bestEffortCleanup(() => restoreQuestLogNativeReplacement(record.nativeQuestLogState));
}

function demotePublishedTalent(record: FrameXmlMountResources): void {
  if (record.talentOwnerDemoted) return;
  record.talentOwnerDemoted = true;
  // No native talent element is hidden until the stock add-on has passed its gate. If the lazy
  // load fails, simply remove the owner so the next key/button press reaches the native panel.
  bestEffortCleanup(() => record.talentOwnerCleanup?.());
  if (!record.talentOwnerCleanup) bestEffortCleanup(() => record.talentOwner?.hide());
  bestEffortCleanup(() => record.talentOwner?.dispose?.());
}

function demotePublishedTrainer(record: FrameXmlMountResources): void {
  if (record.trainerOwnerDemoted) return;
  record.trainerOwnerDemoted = true;
  const activeTrainerWorld = game.world;
  const activeTrainer = activeTrainerWorld?.trainer;
  bestEffortCleanup(() => record.trainerOwnerCleanup?.());
  if (!record.trainerOwnerCleanup) bestEffortCleanup(() => record.trainerOwner?.hide());
  bestEffortCleanup(() => record.trainerOwner?.dispose?.());
  if (game.world?.trainer) {
    // The owner itself invokes the injected native fallback before demotion. Do not repaint the
    // same native panel a second time when an error arrives after a successful fallback.
    if (trainerWindow.hidden) bestEffortCleanup(() => showTrainer());
  } else if (activeTrainerWorld && activeTrainer && game.world === activeTrainerWorld) {
    bestEffortCleanup(() => {
      activeTrainerWorld.trainer = activeTrainer;
      trainerWindow.hidden = false;
      showTrainer();
    });
  } else if (record.nativeTrainerWasHidden !== undefined) {
    bestEffortCleanup(() => { trainerWindow.hidden = record.nativeTrainerWasHidden!; });
    delete record.nativeTrainerWasHidden;
  }
}

let mounted: (FrameXmlMountResources & {
  renderer: FrameXmlDomRenderer;
  frame: number;
}) | undefined;
/** Invalidates a mount that is still waiting for its async FrameXML load. */
let mountEpoch = 0;
let pendingMount: FrameXmlMountResources & {
  cleaned: boolean;
} | undefined;

function bestEffortCleanup(action: () => void): void {
  try {
    action();
  } catch {
    // Preserve the original mount error while still completing the remaining teardown steps.
  }
}

function cleanupPendingMount(record: NonNullable<typeof pendingMount>): void {
  if (record.cleaned) return;
  record.cleaned = true;
  bestEffortCleanup(() => record.settingsCleanup?.());
  if (pendingMount === record) pendingMount = undefined;
  bestEffortCleanup(() => window.removeEventListener("resize", record.resize));
  bestEffortCleanup(() => record.boot.close());
  bestEffortCleanup(() => record.host.remove());
  bestEffortCleanup(() => record.style.remove());
}

function cleanupPublishedMount(record: FrameXmlMountResources): void {
  bestEffortCleanup(() => record.settingsCleanup?.());
  bestEffortCleanup(() => record.mirrorTimersCleanup?.());
  bestEffortCleanup(() => record.models?.dispose());
  bestEffortCleanup(() => record.addonLayerCleanup?.());
  bestEffortCleanup(() => record.nativeTooltipCleanup?.());
  bestEffortCleanup(() => record.diagnosticCleanup?.());
  bestEffortCleanup(() => record.perfCleanup?.());
  bestEffortCleanup(() => record.addonEntrypointsCleanup?.());
  const published = mounted === record;
  if (mounted === record) mounted = undefined;
  if (record.frame !== undefined) {
    bestEffortCleanup(() => window.cancelAnimationFrame(record.frame!));
  }
  if (record.addonsOnly) {
    bestEffortCleanup(() => record.talentOwnerCleanup?.());
    bestEffortCleanup(() => window.removeEventListener("resize", record.resize));
    // An add-on's own SetPortraitTexture claims a stock portrait here as in the full UI.
    bestEffortCleanup(() => record.stockPortraitsCleanup?.());
    bestEffortCleanup(() => record.renderer?.destroy());
    bestEffortCleanup(() => record.seam.detach());
    bestEffortCleanup(() => record.boot.close());
    bestEffortCleanup(() => record.host.remove());
    bestEffortCleanup(() => record.style.remove());
    return;
  }
  // Release the optional chat display lane before any renderer/VM teardown: hand the chat keys
  // back to the native input first, then show its form/log again and restore the log's scroll.
  bestEffortCleanup(() => record.chatInputCleanup?.());
  bestEffortCleanup(() => setNativeChatReplacementActive(false));
  if (record.nativeChatLogState) {
    // Rebuild the native dock only after its lane is visible again, then restore the state that was
    // present before adoption.  This keeps both exact scroll offsets and the at-bottom behaviour.
    bestEffortCleanup(() => redrawChatLog());
    bestEffortCleanup(() => restoreNativeChatLogState(record.nativeChatLogState!));
  }
  bestEffortCleanup(() => setNativeLanesReplacementActive(false));
  bestEffortCleanup(() => record.worldMapOwnerCleanup?.());
  bestEffortCleanup(() => document.body.classList.remove("framexml-world-map-fullscreen"));
  bestEffortCleanup(() => record.questGiverEscapeCleanup?.());
  bestEffortCleanup(() => record.questGiverOwnerCleanup?.());
  if (published && game.world && (game.world.questList || game.world.questDialog || game.world.questMessage)) {
    bestEffortCleanup(() => showQuestState());
  }
  // Unpublish the stock quest owner before restoring the native browser panel. The published owner
  // includes both QuestLogFrame and WatchFrame, so neither native panel can remain visible here.
  bestEffortCleanup(() => record.questOwnerCleanup?.());
  if (!record.questOwnerCleanup) bestEffortCleanup(() => record.questOwner?.hide());
  bestEffortCleanup(() => record.questOwner?.dispose?.());
  bestEffortCleanup(() => restoreQuestLogNativeReplacement(record.nativeQuestLogState));
  // Unpublish before revealing native bags: a close from an in-flight click must never land on
  // both owners during teardown.
  bestEffortCleanup(() => record.bagOwnerCleanup?.());
  // A gate can succeed before a later optional lane throws, so dispose an unpublished owner too.
  // Published cleanup already makes this idempotent through the controller's disposal hook.
  if (!record.bagOwnerCleanup) bestEffortCleanup(() => record.bagOwner?.close());
  bestEffortCleanup(() => record.bagOwner?.dispose?.());
  bestEffortCleanup(() => closeBagWindows());
  bestEffortCleanup(() => setNativeBagsReplacementActive(false));
  bestEffortCleanup(() => restoreNativeInventory(record));
  // Unpublish the stock character owner before revealing the native character sheet. The model
  // canvas is returned before its FrameXML host/VM is destroyed, and all operations are idempotent
  // so a late diagnostic demotion cannot resurrect two owners.
  bestEffortCleanup(() => record.characterOwnerCleanup?.());
  if (!record.characterOwnerCleanup) bestEffortCleanup(() => record.characterOwner?.hide());
  bestEffortCleanup(() => record.characterOwner?.dispose?.());
  bestEffortCleanup(() => setNativeCharacterReplacementActive(false));
  bestEffortCleanup(() => setNativeMicroButtonsReplacementActive(false));
  if (record.nativeCharacterWasHidden !== undefined) {
    bestEffortCleanup(() => { characterWindow.hidden = record.nativeCharacterWasHidden!; });
  }
  bestEffortCleanup(() => record.characterPortraitCleanup?.());
  if (record.characterPortraitCleanup) bestEffortCleanup(() => mountNativeCharacterPortrait(characterModel));
  // Unpublish the stock PvP summary before destroying its VM.  ArenaWindow is a separate native
  // owner and is intentionally not touched here.
  bestEffortCleanup(() => record.pvpOwnerCleanup?.());
  if (!record.pvpOwnerCleanup) bestEffortCleanup(() => record.pvpOwner?.hide());
  // Unpublish the stock game menu and dungeon finder before their VM goes; the native Panel and
  // #lfg-window become the routes again, and the native prompts take the LFG popups back.
  bestEffortCleanup(() => record.gameMenuOwnerCleanup?.());
  if (!record.gameMenuOwnerCleanup) bestEffortCleanup(() => record.gameMenuOwner?.hide());
  bestEffortCleanup(() => record.lfdOwnerCleanup?.());
  if (!record.lfdOwnerCleanup) bestEffortCleanup(() => record.lfdOwner?.hide());
  bestEffortCleanup(() => { if (record.seam.lfd) record.seam.lfd.popupsOwned = false; });
  // The stock FriendsFrame likewise: the native social panel and guild window become the routes.
  bestEffortCleanup(() => record.friendsOwnerCleanup?.());
  if (!record.friendsOwnerCleanup) bestEffortCleanup(() => record.friendsOwner?.hide());
  bestEffortCleanup(() => { if (record.seam.friends) record.seam.friends.owned = false; });
  // The NPC windows unpublish with their models muted (CloseGossip/CloseTaxiMap do not end the
  // interaction), and the native gossip, flight list and bank repaint whatever is still open.
  bestEffortCleanup(() => record.npcWindowsCleanup?.());
  // The macro and binding windows unpublish (their native windows become the routes again), the
  // KeyBindingFrame keyboard is released and the CLICK bindings stop pressing this VM's buttons.
  bestEffortCleanup(() => record.macroBindingWindowsCleanup?.());
  // The stock calendar unpublishes: the native calendar window is the route again.
  bestEffortCleanup(() => record.calendarCleanup?.());
  // The options frames unpublish (the native settings window is the route again); a load still in
  // flight settles into a disposed owner.
  bestEffortCleanup(() => record.optionsCleanup?.());
  // The loot owner disowns its model before hiding LootFrame (CloseLoot is then inert), and the
  // native window takes back a corpse that is still open.
  bestEffortCleanup(() => record.lootOwnerCleanup?.());
  if (!record.lootOwnerCleanup) bestEffortCleanup(() => record.lootOwner?.release());
  // The stock dialogs stop answering first (a Lua OnHide during teardown is then inert), then the
  // owner is unpublished and every question still pending gets its native prompt back.
  bestEffortCleanup(() => { if (record.seam.popups) record.seam.popups.popupsOwned = false; });
  bestEffortCleanup(() => record.popupsOwnerCleanup?.());
  if (record.popupsOwnerCleanup) bestEffortCleanup(() => refreshFrameXmlPopupsNative());
  // Stock mail and trade are unpublished with their models muted, so MailFrame's OnHide (CloseMail)
  // and TradeFrame's (CloseTrade) neither close the mailbox nor cancel the trade; the native windows
  // then take back whatever is still open.
  const mailModel = record.seam.mail;
  const tradeModel = record.seam.trade;
  bestEffortCleanup(() => mailModel ? mailModel.muted(() => record.mailOwnerCleanup?.()) : record.mailOwnerCleanup?.());
  bestEffortCleanup(() => { if (mailModel) mailModel.owned = false; });
  if (record.mailOwnerCleanup) bestEffortCleanup(() => showNativeMail());
  bestEffortCleanup(() => tradeModel ? tradeModel.muted(() => record.tradeOwnerCleanup?.()) : record.tradeOwnerCleanup?.());
  bestEffortCleanup(() => { if (tradeModel) tradeModel.owned = false; });
  if (record.tradeOwnerCleanup) bestEffortCleanup(() => showNativeTrade());
  // The stock auction house hides muted (the house stays open) and the native window takes it back.
  bestEffortCleanup(() => record.auctionCleanup?.());
  // The dressing room's model stage and its WebGL renderer go with the mount.
  bestEffortCleanup(() => record.dressUpCleanup?.());
  // InspectUnit goes back to stock, an open socketing session ends, an occupied chair goes to the native window.
  bestEffortCleanup(() => record.inspectSocketBarberCleanup?.());
  bestEffortCleanup(() => record.achievementCleanup?.());
  // So does the stock guild bank: hidden muted (the bank stays open), the native window takes it back.
  bestEffortCleanup(() => record.guildBankCleanup?.());
  // A Blizzard_RaidUI load still on its way settles into a disposed owner.
  bestEffortCleanup(() => record.raidGridCleanup?.());
  bestEffortCleanup(() => record.arenaEnemyCleanup?.());
  // Likewise a Blizzard_TokenUI load on its way; the model's events stay with the disposed seam.
  bestEffortCleanup(() => record.tokenCleanup?.());
  // The stock trade skill window ends its line (CloseTradeSkill, as a /reload does) and is unpublished,
  // so the next profession open reaches the native craft window; an unpublished owner is disposed too.
  bestEffortCleanup(() => record.tradeSkillCleanup?.());
  bestEffortCleanup(() => record.tradeSkillMount?.owner.dispose?.());
  // Unpublish the lazy stock trainer before restoring its native fallback. A pending add-on load
  // is generation-bound and therefore cannot resurrect a root after this cleanup.
  const activeTrainerWorld = game.world;
  const activeTrainer = activeTrainerWorld?.trainer;
  bestEffortCleanup(() => record.trainerOwnerCleanup?.());
  if (!record.trainerOwnerCleanup) bestEffortCleanup(() => record.trainerOwner?.hide());
  bestEffortCleanup(() => record.trainerOwner?.dispose?.());
  if (record.nativeTrainerWasHidden !== undefined) {
    if (game.world?.trainer) {
      if (trainerWindow.hidden) bestEffortCleanup(() => showTrainer());
    } else if (activeTrainerWorld && activeTrainer && game.world === activeTrainerWorld) {
      bestEffortCleanup(() => {
        activeTrainerWorld.trainer = activeTrainer;
        trainerWindow.hidden = false;
        showTrainer();
      });
    } else {
      bestEffortCleanup(() => { trainerWindow.hidden = record.nativeTrainerWasHidden!; });
    }
  }
  // Unpublish the stock merchant before restoring the native vendor panel; a late vendor callback
  // must not repaint a FrameXML root whose VM is already being destroyed. The published helper
  // owns the active-vendor snapshot; the fallback branch handles a gate that never published.
  if (record.merchantOwnerCleanup) {
    bestEffortCleanup(() => record.merchantOwnerCleanup?.());
  } else {
    const activeVendorWorld = game.world;
    const activeVendor = activeVendorWorld?.vendor;
    bestEffortCleanup(() => record.merchantOwner?.hide());
    if (game.world?.vendor) {
      bestEffortCleanup(() => { vendorWindow.hidden = false; showVendor(); });
    } else if (activeVendorWorld && activeVendor && game.world === activeVendorWorld) {
      bestEffortCleanup(() => {
        activeVendorWorld.vendor = activeVendor;
        vendorWindow.hidden = false;
        showVendor();
      });
    } else if (record.nativeVendorWasHidden !== undefined) {
      bestEffortCleanup(() => { vendorWindow.hidden = record.nativeVendorWasHidden!; });
    }
  }
  bestEffortCleanup(() => setNativeTargetContextReplacementActive(false));
  bestEffortCleanup(() => setNativeFocusReplacementActive(false));
  bestEffortCleanup(() => setNativeTargetOfTargetReplacementActive(false));
  bestEffortCleanup(() => setNativePetReplacementActive(false));
  bestEffortCleanup(() => setNativePetBarReplacementActive(false));
  bestEffortCleanup(() => setNativePartyReplacementActive(false));
  if (published) bestEffortCleanup(() => showAuras());
  // The native player frame skipped every change while it was hidden (`bindPlayerHud`).
  if (published) bestEffortCleanup(() => repaintPlayerHud());
  bestEffortCleanup(() => window.removeEventListener("resize", record.resize));
  // Return the shared minimap canvas before destroying the authored Minimap slot or its host.
  const minimapCleanup = record.minimapCleanup;
  bestEffortCleanup(() => minimapCleanup?.());
  // Clear cached zone and ping state only after the shared canvas has returned to the native rail.
  // A pre-adoption failure has no borrowed state to clear, so it leaves the native fallback intact.
  if (minimapCleanup) bestEffortCleanup(() => forgetMinimap());
  // Return the shared 3D portrait canvas before destroying the FrameXML slot or its host.
  bestEffortCleanup(() => record.portraitCleanup?.());
  bestEffortCleanup(() => record.targetPortraitCleanup?.());
  bestEffortCleanup(() => record.questGiverPortraitCleanup?.());
  bestEffortCleanup(() => setQuestGiverPortrait(undefined));
  bestEffortCleanup(() => record.stockPortraitsCleanup?.());
  bestEffortCleanup(() => record.cursorDomCleanup?.());
  bestEffortCleanup(() => record.focusPortraitCleanup?.());
  bestEffortCleanup(() => record.targetOfTargetPortraitCleanup?.());
  bestEffortCleanup(() => record.focusTargetPortraitCleanup?.());
  // Hide and unpublish the stock owner before destroying its bridge. Restore the native panel's
  // previous state only after the owner is gone, so the two books can never overlap.
  bestEffortCleanup(() => record.spellbookOwnerCleanup?.());
  if (record.nativeSpellbookWasHidden !== undefined) {
    bestEffortCleanup(() => { spellbookWindow.hidden = record.nativeSpellbookWasHidden!; });
  }
  // A talent owner is lazy and may still be waiting for Blizzard_TalentUI. Unpublish it before
  // destroying the shared VM so a late load cannot show a root belonging to the old world.
  bestEffortCleanup(() => record.talentOwnerCleanup?.());
  if (!record.talentOwnerCleanup) bestEffortCleanup(() => record.talentOwner?.hide());
  bestEffortCleanup(() => record.talentOwner?.dispose?.());
  bestEffortCleanup(() => record.petPortraitCleanup?.());
  for (const cleanup of record.partyPortraitCleanups ?? []) bestEffortCleanup(cleanup);
  bestEffortCleanup(() => record.renderer?.destroy());
  bestEffortCleanup(() => record.seam.detach());
  bestEffortCleanup(() => record.boot.close());
  bestEffortCleanup(() => record.host.remove());
  bestEffortCleanup(() => record.style.remove());
}

/**
 * A boot can finish its corpus work after close and attach the seam at the very end of load.
 * Cleanup before that attach cannot see it, so the stale completion gets one final idempotent
 * detach after `load()` has crossed that boundary.
 */
function cancelPendingMount(record: NonNullable<typeof pendingMount>): void {
  cleanupPendingMount(record);
  bestEffortCleanup(() => record.seam.detach());
}

export interface FrameXmlWorldMountOptions {
  readonly savedVariablesScope?: import("./FrameXmlSavedVariables.js").FrameXmlSavedVariablesScope;
  /** Ordinary world: run our TSWoW modules over the native UI. */
  readonly addonsOnly?: boolean;
  /** False keeps diagnostic stock FrameXML free of generated TSWoW library/module blocks. */
  readonly includeActiveTsAddons?: boolean;
  /** Defaults to `#world-viewport`, so the overlay is clipped and moved by the world's own box. */
  readonly viewport?: HTMLElement | null;
  /**
   * A seam other than the live one — the only way to exercise this path without a server.
   *
   * The owner's realms are down, so «mounts without errors in a world» could otherwise only be
   * asserted and not shown. With a `CannedWorldSeam` here, the whole in-world path (the overlay
   * host, its stylesheet, its z-index against the world canvases, the subset load and the sweep)
   * runs against a page that has a `#world-viewport` and no connection.
   */
  readonly seam?: FrameXmlWorldSeam;
  /** Optional already-owned `/dbc/battlegrounds` client; default live mounts load one before boot. */
  readonly battlegrounds?: FrameXmlBattlegroundClient;
}

/**
 * Bring the action-bar vertical up over the world.
 *
 * Idempotent: a second call while one is mounted answers without building a second VM.
 */
export async function mountFrameXmlVertical(
  options: FrameXmlWorldMountOptions = {},
): Promise<FrameXmlWorldMountResult> {
  const viewport = options.viewport ?? document.getElementById("world-viewport");
  if (mounted) return { ok: true, message: "FrameXML уже смонтирован" };
  const epoch = ++mountEpoch;
  const initialWorld = game.world;
  if (pendingMount) cleanupPendingMount(pendingMount);
  if (!viewport) return { ok: false, message: "нет #world-viewport" };
  const origin = game.gatewayOrigin ?? defaultGatewayOrigin(window.location);
  // PVPBattlegroundFrame_OnLoad reads GetNumBattlegroundTypes immediately. Load the complete
  // catalog before boot so a temporary empty callback cannot hide tab 2 and strand the owner.
  const battlegrounds = options.battlegrounds ?? (options.seam ? undefined : new FrameXmlBattlegroundClient(origin));
  if (battlegrounds) await battlegrounds.load();
  // LFGDungeonList_Setup (LFGFrame.lua:375-386) reads the dungeon catalog once per session, on the
  // first LFDQueueFrame_Update — possibly during the session exercise. Load it before boot like the
  // battleground list; a failed or version-1 answer keeps the stock finder unpublished (native LFG).
  const lfgDungeons = options.seam || options.addonsOnly ? undefined : new LfgDungeonClient(origin);
  if (lfgDungeons) await lfgDungeons.load();
  const worldStateUi = options.seam ? undefined : await fetchFrameXmlWorldStates(origin).catch((error) => {
    console.warn(`WorldStateUI catalog is unavailable: ${String(error)}`);
    return undefined;
  });
  // Like the two catalogs above: without it only the rating-conversion tooltips lose their
  // numbers, which is no reason to take the whole original interface down with it.
  const characterStatCatalog = options.seam ? undefined : await loadFrameXmlCharacterStats(origin).catch((error) => {
    console.warn(`Character stat catalog is unavailable: ${String(error)}`);
    return undefined;
  });
  // A missing list is still no reason to take the interface down; the patch latch is — every file
  // the boot would read next answers the same 409, and "no add-ons" would hide why.
  let patchChainChanged: PatchChainChangedError | undefined;
  const clientAddons = (options.seam || options.addonsOnly
    ? []
    : await fetchFrameXmlClientAddons(origin).catch((error) => {
      if (isPatchChainChangedError(error)) patchChainChanged = error;
      else console.warn(`Client add-on list is unavailable: ${String(error)}`);
      return [];
    })).filter((addon) => frameXmlClientAddonEnabled(addon.name));
  if (patchChainChanged) return { ok: false, message: patchChainChanged.message };
  if (epoch !== mountEpoch) return { ok: false, message: "FrameXML монтаж отменён" };

  // VERIFY_WORLD may precede the realm clock packet. GameTime.lua performs hour arithmetic
  // in OnLoad, so keep the native UI until this session's authoritative clock is available.
  if (!options.seam) {
    if (!initialWorld) return { ok: false, message: "нет активной игровой сессии" };
    const clock = await waitForFrameXmlLoginClock({
      read: () => initialWorld.currentGameTime(performance.now()),
      stillCurrent: () => epoch === mountEpoch && game.world === initialWorld,
    });
    if (clock.status !== "ready") return { ok: false, message: clock.status === "cancelled"
      ? "FrameXML монтаж отменён" : "сервер ещё не передал игровое время" };
    // The stock VARIABLES_LOADED/PLAYER_LOGIN handlers and every paper-doll stat setter read
    // UnitClass("player") and the rest of the player's own object. The server sends it just
    // after the clock (the player joins the map after the initial packets), so this is normally
    // one poll. A slow one does not hold the interface back: the stat panels fill when it lands.
    const self = await waitForFrameXmlLoginClock({
      read: () => {
        const state = initialWorld.state;
        const own = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
        return own?.typeId === TYPEID_PLAYER && unit.classId(own) !== undefined ? own : undefined;
      },
      stillCurrent: () => epoch === mountEpoch && game.world === initialWorld,
    });
    if (self.status === "cancelled") return { ok: false, message: "FrameXML монтаж отменён" };
  }

  const style = document.createElement("style");
  style.setAttribute("data-framexml-world", "true");
  style.textContent = HOST_CSS;
  document.head.append(style);
  const host = document.createElement("div");
  host.id = HOST_ID;
  if (options.addonsOnly) {
    host.dataset["tswowAddons"] = "true";
    host.style.zIndex = "23";
  }
  const stage = document.createElement("div");
  stage.id = STAGE_ID;
  host.append(stage);
  // Keep the stage measurable for gates/anchors while the long corpus load and ownership checks
  // run.  `display:none` would collapse those rectangles and make a valid root look unrenderable;
  // visibility/inert keeps layout alive and prevents a partially mounted overlay from flashing or
  // taking focus/clicks before native replacement is published atomically below.
  host.style.visibility = "hidden";
  (host as HTMLElement & { inert?: boolean }).inert = true;
  host.setAttribute("aria-hidden", "true");
  viewport.append(host);

  const fit = (): void => {
    const width = host.clientWidth || window.innerWidth;
    const height = host.clientHeight || window.innerHeight;
    // The same uniform scale `Bootstrap.ts` applies to the glue stage: the client's interface is
    // 768 units tall and as wide as the viewport's aspect makes it.
    const logical = frameXmlViewport(width, height, settingNumber(settings(), "uiScale"));
    stage.style.width = `${logical.width}px`;
    stage.style.height = `${logical.height}px`;
    stage.style.transform = `scale(${logical.scale})`;
  };
  fit();
  window.addEventListener("resize", fit);

  // Keep the FrameXML metadata object stable between reads. The resolver is intentionally cached,
  // so recreating this adapter for every C-API getter would turn one talent repaint into a full
  // tree rebuild. Its revision advances when TalentClient or spell-name metadata changes.
  let cachedTalentClient: typeof game.talentData;
  let cachedTalentPacket: WorldClient["talents"];
  let cachedPetTalentPacket: WorldClient["petTalents"];
  let cachedTalentSpells = -1;
  let cachedTalentMetadata: FrameXmlTalentMetadata | undefined;
  let requestedTalentClient: typeof game.talentData;
  let requestedTalentPacket: WorldClient["talents"];
  let requestedPetTalentPacket: WorldClient["petTalents"];
  let requestedPetMask = -1;
  const readTalentMetadata = (): FrameXmlTalentMetadata | undefined => {
    const client = game.talentData;
    const packet = game.world?.talents;
    const petPacket = game.world?.petTalents;
    const spellCount = game.spells.size;
    if (!client) return undefined;
    if (client === cachedTalentClient && packet === cachedTalentPacket
      && petPacket === cachedPetTalentPacket
      && spellCount === cachedTalentSpells && cachedTalentMetadata !== undefined) {
      return cachedTalentMetadata;
    }
    cachedTalentClient = client;
    cachedTalentPacket = packet;
    cachedPetTalentPacket = petPacket;
    cachedTalentSpells = spellCount;
    const learned = new Map<number, number>();
    const active = packet?.specs[packet.activeSpec];
    for (const rank of active?.talents ?? []) learned.set(rank.talentId, rank.rank);
    for (const rank of petPacket?.specs[0]?.talents ?? []) learned.set(rank.talentId, rank.rank);
    cachedTalentMetadata = {
      ready: client.ready,
      revision: client.revision * 1_000_000 + spellCount,
      tabsForClass: (classId) => client.tabsForClass(classId),
      petTabs: (familyMask) => client.petTabs(familyMask),
      petTalentMask: (family) => client.petTalentMask(family),
      talentsIn: (tabId) => client.talentsIn(tabId).map((entry) => {
        const rank = learned.get(entry.id) ?? 0;
        const spellId = entry.ranks[Math.max(0, Math.min(entry.ranks.length - 1, rank - 1))]
          ?? entry.ranks[0];
        const spell = spellId === undefined ? undefined : game.spells.get(spellId);
        return {
          ...entry,
          name: spell?.name ?? `Талант ${entry.id}`,
          ...(spell?.iconPath === undefined ? {} : { iconTexture: spell.iconPath }),
        };
      }),
    };
    return cachedTalentMetadata;
  };
  const ensureTalentSpellNames = (): void => {
    const packet = game.world?.talents;
    const petPacket = game.world?.petTalents;
    const client = game.talentData;
    if (!client?.ready) return;
    const world = game.world;
    const petGuid = world?.petSpells?.guid;
    const petMask = petGuid !== undefined && petGuid !== 0n
      ? client.petTalentMask(world?.petSpells?.creatureFamily ?? 0) : 0;
    if (client === requestedTalentClient && packet === requestedTalentPacket
      && petPacket === requestedPetTalentPacket && petMask === requestedPetMask) return;
    const ids = new Set<number>();
    const active = packet?.specs[packet.activeSpec];
    const self = world?.state.selfGuid === undefined ? undefined
      : world.state.objects.get(world.state.selfGuid);
    const classId = self === undefined ? undefined : unit.classId(self);
    if (classId === undefined) return;
    // Do not mark this packet as requested until the player identity is available. EnterWorld can
    // expose TalentClient before the first object update; a later tick must retry the same packet.
    requestedTalentClient = client;
    requestedTalentPacket = packet;
    requestedPetTalentPacket = petPacket;
    requestedPetMask = petMask;
    for (const entry of client.tabsForClass(classId).flatMap((tab) => client.talentsIn(tab.id))) {
      ids.add(entry.ranks[0] ?? 0);
      const rank = active?.talents.find((value) => value.talentId === entry.id)?.rank ?? 0;
      if (rank > 0) ids.add(entry.ranks[rank - 1] ?? 0);
    }
    const petActive = petPacket?.specs[0];
    for (const entry of client.petTabs(petMask).flatMap((tab) => client.talentsIn(tab.id))) {
      ids.add(entry.ranks[0] ?? 0);
      const rank = petActive?.talents.find((value) => value.talentId === entry.id)?.rank ?? 0;
      if (rank > 0) ids.add(entry.ranks[rank - 1] ?? 0);
    }
    ensureSpellNames([...ids].filter((id) => id > 0));
  };

  const seam = options.seam ?? new LiveWorldSeam({
    worldStateUi: () => worldStateUi,
    mailDraftAttachments,
    stableSlotPrice: (owned) => game.slotPrices?.stableSlotPrice(owned),
    mapSource: {
      metadata: () => game.areas?.snapshot(),
      location: () => {
        const world = game.world;
        const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
        return world && world.mapId !== undefined && self?.position
          ? { mapId: world.mapId, areaId: currentAreaId(), x: self.position.x, y: self.position.y,
            orientation: self.position.orientation }
          : undefined;
      },
      areaAt: (continent, u, v) => game.areas?.worldMapAreaAt(continent, u, v) ?? { status: "unavailable" },
      corpseLocation: () => {
        const world = game.world;
        const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
        if (self && !isWorldObjectDead(self) && !isPlayerGhost(self)) return null;
        const corpse = world?.corpse;
        return corpse?.found ? { mapId: corpse.mapId, areaId: 0, x: corpse.x, y: corpse.y }
          : corpse ? null : undefined;
      },
      deathReleaseLocation: () => {
        const world = game.world;
        const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
        if (self && !isWorldObjectDead(self) && !isPlayerGhost(self)) return null;
        const release = world?.deathReleaseLocation;
        return release ? { mapId: release.mapId, areaId: 0, x: release.x, y: release.y } : undefined;
      },
      isExploredArea: (areaId) => {
        const world = game.world;
        const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
        const bit = game.areas?.area(areaId)?.areaBit;
        const explored = self ? exploredZones(self) : undefined;
        return explored && bit !== undefined && bit > 0 ? isAreaExplored(explored, bit) : undefined;
      },
    },
    world: () => game.world,
    store: () => game.store,
    spell: (id) => game.spells.get(id),
    spells: () => game.spells.values(),
    spellAbilities: (id) => game.talentData?.spellAbilitiesOf(id),
    focusGuid: () => game.focusGuid,
    setFocus: setFocusGuid,
    reaction: (self, target) => reactionBetween(self, target, game.factions),
    reputation: frameXmlLiveReputationRows,
    reputationCatalog: () => game.factions?.reputationCatalog,
    skillMetadata: () => game.talentData,
    characterStats: () => characterStatCatalog,
    bankSlotPrice: (bought) => game.slotPrices?.bankSlotPrice(bought),
    talentMetadata: readTalentMetadata,
    talentMetadataRevision: () => {
      ensureTalentSpellNames();
      return (game.talentData?.revision ?? 0) * 1_000_000 + game.spells.size;
    },
    battlegroundCatalog: () => battlegrounds?.catalog,
    lfgCatalog: () => lfgDungeons?.stock,
    // GetFramerate: the render loop's own RAF cadence, the number the diagnostics line shows.
    framerate: () => game.renderer?.fps ?? 0,
    monotonic: () => performance.now(),
    globalCooldownUntil: () => game.globalCooldownUntil,
    castSpell,
    // Blizzard_TradeSkillUI's professions: /dbc/talents, ItemSubClass words, the native craft queue.
    tradeSkill: frameXmlLiveTradeSkillHost(),
    // Blizzard_MacroUI and the binding C API: the account-data macro stores, the icon list (fetched
    // on the macro window's first open) and the keyboard's own verbs (FrameXmlMacroBindingMount.ts).
    macroStore: frameXmlMacroStore,
    macroIcons: new FrameXmlMacroIconClient(origin),
    runBinding: runAction,
    actionBarPage: getActionBarPage,
    changeActionBarPage: (page) => turnActionPage(page - 1),
    useAction: (slot, button) => useSlot((slot - 1) % 12, Math.floor((slot - 1) / 12), button),
    playSound: playNamedUiSound,
    ...(() => {
      const resolvers = createFrameXmlSpellBookTabResolvers(() => ({
        world: game.world,
        talent: game.talentData,
        spells: game.spells,
      }));
      return {
        spellTabs: resolvers.spellTabs,
        spellTabFor: resolvers.spellTabFor,
        spellIsLowerRank: resolvers.spellIsLowerRank,
      };
    })(),
    settingsCVar: createFrameXmlSettingsCVar({
      getSettings: settings,
      setSetting,
    }),
    // The language stock's menu chose, already resolved from its name by the seam; the world
    // falls back to the racial default when there is none (`WorldClient.sendChat`).
    sendChatMessage: (text, type, language, target) => game.world?.sendChat(type, text, target, language),
    // Languages.dbc names and the combat tab's title follow the client locale the boot gets.
    locale: clientLocale(),
    worldMapAreaId: () => {
      const world = game.world;
      const areas = game.areas;
      const areaId = currentAreaId();
      if (!world || !areas || areaId <= 0) return undefined;
      const area = areas.area(areaId);
      if (!area || area.mapId !== world.mapId) return undefined;
      return areas.mapAreaOfArea(areaId)?.id;
    },
    // ContainerFrame asks for a texture name synchronously while it redraws.  The metadata client
    // is already cached by the native inventory path; consult only that cache here so a stock Lua
    // read never starts a fetch or otherwise changes the mount's lifecycle.
    itemTexture: (entry) => {
      const metadata = game.itemMetadata;
      const item = metadata?.get(entry);
      return item && metadata ? metadata.iconUrl(item) : undefined;
    },
    lootHost: createFrameXmlLiveLootHost(),
    itemInfo: (entry): FrameXmlQuestItemMetadata | undefined => {
      const metadata = game.itemMetadata?.get(entry);
      const template = game.world?.itemTemplates.get(entry);
      const name = metadata?.name ?? template?.name;
      if (typeof name !== "string" || name.length === 0) return undefined;
      const texture = metadata && game.itemMetadata ? game.itemMetadata.iconUrl(metadata) : undefined;
      const quality = metadata?.quality ?? template?.quality;
      return {
        name,
        ...(texture === undefined ? {} : { texture }),
        ...(quality === undefined ? {} : { quality }),
      };
    },
    vendorCost: (id) => game.vendorCosts?.get(id),
    // Quest leaderboards are synchronous C-API reads. Reuse only the already-filled creature
    // metadata cache here; the seam owns any missing-target prefetch outside that read boundary.
    creatureInfo: (entry) => game.creatureMetadata?.get(entry),
    prefetchQuestMetadata: (itemIds, spellIds, onChanged) => {
      const world = game.world;
      const itemClient = game.itemMetadata;
      if (itemClient && itemIds.length > 0) {
        void itemClient.load(itemIds).then((changed) => {
          if (changed && game.world === world) onChanged();
        }).catch(() => undefined);
      }
      if (spellIds.length > 0) {
        ensureSpellNames(spellIds, () => {
          if (game.world === world) onChanged();
        });
      }
    },
    minimapZone: (mapId, zoneId, areaId) => {
      const areas = game.areas;
      const resolvedMapId = mapId ?? game.world?.mapId;
      if (!areas || resolvedMapId === undefined) return undefined;
      // The native minimap caches terrain's precise area; prefer it over the coarser server area
      // when available, then retain the server value as a truthful fallback. This callback is
      // sampled by the seam's existing tick, not by a new per-rAF terrain scan.
      const cachedAreaId = currentAreaId();
      const resolvedAreaId = cachedAreaId > 0
        ? cachedAreaId
        : areaId !== undefined && areaId > 0 ? areaId : 0;
      const area = resolvedAreaId > 0 ? areas.area(resolvedAreaId) : undefined;
      // Keep the server's zone ID as the explicit parent lookup even when terrain supplied the
      // child area; only fall back to the metadata-derived parent when it was not supplied.
      const zone = (zoneId !== undefined ? areas.area(zoneId) : undefined)
        ?? (area ? areas.zoneOf(area.id) : undefined);
      const map = areas.map(resolvedMapId);
      const zoneText = zone?.name ?? map?.name;
      const result = {} as {
        minimapZoneText?: string;
        zoneText?: string;
        subZoneText?: string;
      };
      if (zoneText !== undefined) {
        result.minimapZoneText = zoneText;
        result.zoneText = zoneText;
      }
      if (area && zone && area.id !== zone.id) result.subZoneText = area.name;
      return Object.keys(result).length > 0 ? result : undefined;
    },
  });
  // Before the boot attaches the seam: an achievement chat line waits for the gateway catalog's names.
  provideFrameXmlAchievementCatalog(seam, origin);
  let microButtonAdaptersInstalled = false;
  // Bind this FrameXML generation to the WorldClient that owns the mount. A later world replaces
  // the whole mount; keeping the registry object here prevents a half-old Lua VM from sending on a
  // newly assigned `game.world`, and FrameXmlBoot.close removes every raw subscription it creates.
  const clientNetwork = game.world?.customPackets;
  const logicalScreen = (): { width: number; height: number } => frameXmlViewport(
    host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight,
    settingNumber(settings(), "uiScale"),
  );
  let questPortraitRequested = false;
  const boot = new FrameXmlBoot({
    loadScheduler: new GlueLoadScheduler(),
    ...(options.savedVariablesScope ? { savedVariables: {
      scope: options.savedVariablesScope,
      storage: {
        getItem: (key: string) => window.localStorage.getItem(key),
        setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
      },
    } } : {}),
    provider: createHttpFileProvider({ gatewayOrigin: origin }),
    locale: clientLocale(),
    installedAddons: clientAddons.map((addon) => addon.name),
    eagerAddons: clientAddons.filter((addon) => !addon.loadOnDemand).map((addon) => addon.name),
    subset: FRAMEXML_VERTICAL_TOC,
    // Ordinary entry passes its explicit addon preference; direct addon-runtime callers retain
    // the existing opt-in mount API. A stock-only diagnostic never reads the generated TS blocks.
    includeActiveTsAddons: options.includeActiveTsAddons ?? true,
    ...(clientNetwork === undefined ? {} : { clientNetwork }),
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS,
    seam,
    onQuestPortrait: (guid) => {
      questPortraitRequested = true;
      setQuestGiverPortrait(guid);
    },
    onUnitPortrait: (texture, unit) => stockPortraits.setPortraitTexture(texture, unit),
    minimapAdapter: minimapWidgetAdapter,
    // The stock row's OnEvent code assumes every optional Blizzard panel exists. Hide it and
    // replace its click/event handlers in the boot's after-corpus/before-exercise seam, before
    // PLAYER_ENTERING_WORLD can dispatch UpdateMicroButtons and before the stage is published.
    beforeExercise: (loadedBoot) => {
      hideFrameXmlMicroButtons(loadedBoot);
      if (options.addonsOnly) return;
      // The browser HUD shows all objectives supplied for the current map/area/phase. The
      // stock options panel (which normally seeds this presentation global) is not in this TOC.
      loadedBoot.vm.setGlobal("WORLD_PVP_OBJECTIVES_DISPLAY", "1");
      microButtonAdaptersInstalled = installFrameXmlMicroButtonAdapters(loadedBoot, {
        // The C route: the stock owner while it is published, the native sheet after a demotion
        // (a token-less class demotes on its first open) — never a dead button.
        character: () => openCharacterWindow("sheet"),
        spellbook: toggleFrameXmlSpellBook,
        talent: toggleFrameXmlTalent,
        quest: toggleFrameXmlQuest,
        socials: toggleSocialPanel,
        pvp: toggleFrameXmlPvp,
        lfd: toggleLfgWindow,
        gameMenu: toggleGameMenu,
        // Stock HelpFrame is not in this vertical; the native GM ticket window is the help owner.
        // Printing the native /help list here put big-font command lines into the stock chat.
        help: toggleGmTickets,
        // Blizzard_AchievementUI (LoD) through its lazy owner once published; disabled until then.
        achievement: () => toggleFrameXmlAchievement(),
      }) !== undefined;
    },
    screen: logicalScreen,
    lua: {
      // An add-on's `print` is its author's markup: the real client passes it to
      // DEFAULT_CHAT_FRAME:AddMessage unescaped. The error line below is this client's prose.
      onPrint: (message) => systemLine(message, { markup: true }),
      onError: (message) => { console.error("[framexml lua]", message); systemLine(`TSWoW Lua: ${message}`); },
    },
  });
  // Our modules over the native HUD: tell them the stock minimap cluster is not the one on screen
  // (minimap-hub picks a default angle clear of the native minimap buttons). Before the corpus runs.
  if (options.addonsOnly) markFrameXmlNativeHud(boot);
  // Addons size themselves during Lua loading, before any DOM frame exists. UIParent must
  // already report the logical viewport; later widgets can use actual unscaled layout sizes.
  let geometryRenderer: FrameXmlDomRenderer | undefined;
  boot.bridge.setMeasure((frame) => frame.name === "UIParent"
    ? logicalScreen() : geometryRenderer?.measure(frame));
  // Stock SetPortraitTexture outside the dedicated HUD/quest slots: the NPC, trade and PvP window
  // heads. Claims made while the corpus loads wait for the DOM renderer's element.
  const stockPortraits = createFrameXmlStockPortraits({
    bridge: boot.bridge,
    elementFor: (frame) => geometryRenderer?.elementFor(frame),
    resolve: (unit) => frameXmlPortraitUnitGuid(game.world, seam, unit),
    // The two routes to `fit` (registered before these, so the stage is rescaled first); held
    // only while a claimed portrait is shown.
    watchScale: (listener) => {
      window.addEventListener("resize", listener);
      const stopSettings = watchSettingsApplied(listener);
      return () => {
        window.removeEventListener("resize", listener);
        stopSettings();
      };
    },
  });
  const pending: NonNullable<typeof pendingMount> = {
    host, style, boot, seam, resize: fit, cleaned: false,
  };
  pendingMount = pending;

  let inventory;
  try {
    inventory = await boot.load();
    // The stock clock's calendar button, /calendar and Calendar_Show reach ui/Calendar.ts, which asks the
    // stock CalendarFrame first (published below; FrameXmlCalendarOwner.ts) and opens the native otherwise.
    if (!options.addonsOnly) {
      installFrameXmlCalendarRoutes(boot, { toggle: toggleCalendar, open: openCalendar });
      installFrameXmlMinimapWorldMapButton(boot);
      // The stock game menu's host C APIs. Logout stays FrameXmlChatApi's single binding
      // (→ requestLogout, shared with /logout and /camp); CancelLogout and Quit are bound once, here.
      boot.vm.registerGlobal("CancelLogout", () => { cancelLogoutRequest(); return []; });
      let leaveWorldForQuit: ((exit: "relogin") => void) | undefined;
      boot.vm.registerGlobal("Quit", () => {
        // The app layer is already loaded (it imported this module), so the import resolves in a
        // microtask — long before the server completes the logout a network round trip later. If
        // it somehow has not, the ordinary Logout route (character list) is the fallback.
        void import("../app/Login.js").then((login) => { leaveWorldForQuit = login.leaveWorld; }, () => {});
        requestQuitToLogin(() => { leaveWorldForQuit?.("relogin"); });
        return [];
      });
      installFrameXmlGameMenuButtons(boot, {
        video: () => openSettingsSection("Графика"),
        sound: () => openSettingsSection("Звук"),
        interface: () => openSettingsSection("Интерфейс"),
        keybindings: () => { if (!keyBindingsOpen()) toggleKeyBindingsWindow(); },
        macros: () => { if (!macroWindowOpen()) toggleMacroWindow(); },
        diagnostics: openDiagnosticsWindow,
        resetLayout: resetWindowLayout,
        toggle: toggleGameMenu,
      });
      // MiniMapLFGFrame's click (queued/rolecheck) and add-ons call stock ToggleLFDParentFrame; it
      // reaches the same route as the micro button: the stock owner once published, else native.
      // ToggleLFRParentFrame (/raidbrowser) is closed: the raid browser has no 3.3.5 protocol.
      installFrameXmlLfdToggle(boot, toggleLfgWindow);
      // Stock ToggleFriendsFrame/ToggleFriendsPanel/ToggleIgnorePanel/ShowWhoPanel and /groster reach
      // the same routes as the Socials micro button: the stock FriendsFrame once published, else native.
      installFrameXmlFriendsRoutes(boot, { toggle: toggleSocialTab, open: openSocialTab });
      // Before the renderer mounts: GroupLootFrame1-4 must already sit under UIParent (their template
      // parent is not inherited by the bridge), and the roll icon's tooltip setter must exist.
      installFrameXmlLootAdapters(boot);
      if (epoch === mountEpoch) await loadFrameXmlStockClock(boot);
    }
    if (epoch !== mountEpoch) {
      cancelPendingMount(pending);
      return { ok: false, message: "FrameXML монтаж отменён" };
    }
  } catch (error) {
    const cancelled = epoch !== mountEpoch;
    if (cancelled) {
      cancelPendingMount(pending);
      return { ok: false, message: "FrameXML монтаж отменён" };
    }
    cleanupPendingMount(pending);
    bestEffortCleanup(() => pending.seam.detach());
    return { ok: false, message: `FrameXML не загрузился: ${String(error)}` };
  }
  pendingMount = undefined;
  // Settings may change while the corpus yields; publish with the latest scale.
  fit();
  boot.startSavedVariablesPersistence(window, document);

  const resources: FrameXmlMountResources = {
    host, style, boot, seam, resize: fit, addonsOnly: options.addonsOnly ?? false,
  };
  // Live frame-time counters for this mount: `window.frameXmlWorldPerf()` (FrameXmlWorldPerf.ts).
  const perf = new FrameXmlWorldPerf();
  const touchAll = (): void => { perf.touch(); boot.bridge.touch(); };
  // What a settings change can move here is the stage's logical box (`uiScale`), and the renderer
  // follows its container's box itself (`FrameXmlDomRenderer.watchContainer`: the strata layers,
  // measured anchors and clamps it moved). Every other option reaches the interface through Lua
  // (CVars, events), whose mutations the renderer already hears. A structural pass on top cost
  // 18-23 ms per change on the rich route and drew the same boxes (lane RZ, rz7-settings.mjs).
  resources.settingsCleanup = watchSettingsApplied(fit);
  try {
    const clientFileUrl = (path: string): string => {
      const url = new URL("/client/file", origin);
      url.searchParams.set("path", path.replaceAll("/", "\\"));
      return url.href;
    };
    const textureUrl = (path: string): string => {
      // Live item metadata can return an already trusted gateway URL. Keep that route intact so
      // item/spell icons do not get wrapped as `/texture?path=https://...`; reject every other
      // absolute URL (including cross-origin values) and continue through the normal texture path.
      try {
        const absolute = new URL(path);
        if (absolute.origin === origin && absolute.username === "" && absolute.password === ""
          && absolute.search === "" && absolute.hash === ""
          && /^(?:\/item-icon\/|\/spell-icon\/)\d+$/.test(absolute.pathname)) {
          return absolute.href;
        }
      } catch {
        // FrameXML texture names are not URLs; they use the `/texture?path=` route below.
      }
      const url = new URL("/texture", origin);
      url.searchParams.set("path", path.replaceAll("/", "\\"));
      return url.href;
    };
    // A picture that arrives is drawn on the frames holding it (`pictureArrived`), not by a
    // structural re-apply of the whole HUD; the renderer is built just below.
    let pictures: FrameXmlDomRenderer | undefined;
    const textures = new FrameXmlTextureCache({
      resolve: textureUrl,
      onChange: (path, kind) => { if (pictures) pictures.pictureArrived(path, kind); else touchAll(); },
    });
    const fonts = new FrameXmlFontLoader({ resolve: clientFileUrl });
    let nativeTooltipActive = false;
    const addonPresentation = options.addonsOnly
      ? new FrameXmlTsAddonPresentation(boot, () => nativeTooltipActive) : undefined;
    // The native owners' rectangles are layout reads, and a layout read in the frame step forces
    // whatever the game frame has already dirtied to lay out before it paints. Whether each owner
    // is shown is only a property read: measure when that changes, and otherwise four times a
    // second, which still follows a resize or a moved window.
    let anchorsMeasuredAt = Number.NEGATIVE_INFINITY;
    let anchorVisibility = "";
    const syncNativeAnchors = (): void => {
      if (!addonPresentation) return;
      const minimap = document.getElementById("minimap-canvas");
      const visibility = `${characterWindow?.hidden}|${minimap?.hidden}|${characterSheetPane?.hidden}`;
      const now = performance.now();
      if (visibility === anchorVisibility && now - anchorsMeasuredAt < NATIVE_ANCHOR_INTERVAL_MS) return;
      anchorVisibility = visibility;
      anchorsMeasuredAt = now;
      boot.bridge.runInMutationBatch(() => addonPresentation.syncNativeAnchors(
        stage, characterWindow, minimap, characterSheetPane,
      ));
    };
    syncNativeAnchors();
    const renderer = new FrameXmlDomRenderer(stage, {
      bridge: boot.bridge,
      textures,
      textureResolver: textureUrl,
      fontResolver: clientFileUrl,
      clock: boot.pump.now,
      perf,
      createdRootParent: "UIParent",
      // Parentless Lua-created frames are not world owners by default.  World controllers promote
      // an explicitly-owned load-on-demand root with renderer.addRoots() after its gate; keeping the
      // renderer's glue default enabled preserves GlueXML's historical dynamic roots elsewhere.
      includeCreatedRoots: options.addonsOnly ?? false,
      ...(addonPresentation ? {
        frameFilter: addonPresentation.includes,
        layoutOnly: addonPresentation.layoutOnly,
      } : {}),
      // A StaticPopup over a live game freezes nothing: #world-canvas, the native HUD and the other
      // windows keep their input and the chat box its focus (the login screens keep modal dialogs).
      dialogs: "modeless",
      fontLoader: (file, family) => {
        void fonts.load(file, family).then(() => { if (pictures) pictures.fontArrived(); else touchAll(); });
      },
    });
    resources.renderer = renderer;
    pictures = renderer;
    geometryRenderer = renderer;
    renderer.registerFonts(boot.bridge.fontStyles);
    if (!options.addonsOnly) hideIdleQuestRequiredMoneyFrame(boot);
    renderer.mount(options.addonsOnly ? boot.roots.filter((frame) => !frame.parent)
      : selectFrameXmlWorldRoots(boot.roots, boot.addonRootNames));
    // The ruRU declension dictionary (`|3-6(Огонь)` → «урона от огня»), once per page and after the
    // HUD is up; until it lands, or from a gateway without /dbc/declined-words, rules alone decline.
    if (!options.seam) {
      void loadFrameXmlDeclensionDictionary(origin).then((installed) => {
        if (installed && epoch === mountEpoch && resources.renderer === renderer) renderer.refreshDeclinedText();
      });
    }
    let worldMapGateTried = false;
    const publishMapWhenReady = (): void => {
      if (options.addonsOnly || worldMapGateTried || !seam.map?.ready) return;
      worldMapGateTried = true;
      const owner = frameXmlWorldMapGate(boot, renderer, seam.map,
        (reason) => console.warn(`[FrameXML map] ${reason}`));
      if (!owner) return;
      closeWorldMap();
      resources.worldMapOwnerCleanup = publishFrameXmlWorldMap(owner);
    };
    publishMapWhenReady();
    if (!options.addonsOnly) style.textContent += `
      body.framexml-world-map-fullscreen #minimap,
      body.framexml-world-map-fullscreen #chat-input { display: none !important; }
    `;

    // Borrow the selected client's portrait output before proving command/event ownership.
    if (!options.addonsOnly && frameXmlQuestGiverStructureGate(boot, renderer)) {
      const portrait = boot.bridge.getFrame("QuestFramePortrait");
      const element = portrait ? renderer.elementFor(portrait) : undefined;
      const cleanup = element ? adoptQuestGiverPortraitCanvas(element) : undefined;
      if (cleanup) resources.questGiverPortraitCleanup = cleanup;
    }
    resources.stockPortraitsCleanup = () => stockPortraits.dispose();
    // What the stock cursor holds is drawn at the pointer; a press on the world or Escape lets go.
    if (!options.addonsOnly && seam.cursor) {
      resources.cursorDomCleanup = installFrameXmlCursorDom(document, seam.cursor, renderer);
    }

    const questGiverWorld = !options.addonsOnly && !options.seam ? game.world : undefined;
    if (questGiverWorld) {
      const giverOwner = createFrameXmlQuestGiverMountOwner(boot, renderer, seam, {
        world: questGiverWorld,
        currentWorld: () => game.world,
        hideNative: () => {
          questWindow.hidden = true;
          gossipWindow.hidden = true;
        },
        prefetch: (page) => {
          if (!("kind" in page)) return;
          const dialog: QuestDialog = page;
          const rewards = dialog.kind === "request-items" ? undefined : dialog.rewards;
          const itemIds = [
            ...(dialog.kind === "request-items" ? dialog.items : []),
            ...(rewards?.items ?? []), ...(rewards?.choices ?? []),
          ].map((item) => item.id).filter((id) => id > 0);
          const metadata = game.itemMetadata;
          if (metadata && itemIds.length > 0) {
            void metadata.load(itemIds).then((changed) => {
              if (changed && game.world === questGiverWorld
                && questGiverWorld.questDialog === dialog) {
                notifyFrameXmlQuestGiverItemUpdate(questGiverWorld, metadata.revision);
              }
            }).catch(() => undefined);
          }
          const spellId = rewards?.displaySpell ?? 0;
          if (spellId > 0) ensureSpellNames([spellId], () => {
            if (game.world === questGiverWorld && questGiverWorld.questDialog === dialog) {
              notifyFrameXmlQuestGiverItemUpdate(questGiverWorld);
            }
          });
        },
        onFailure: () => {
          resources.questGiverEscapeCleanup?.();
          resources.questGiverOwnerCleanup?.();
          if (game.world === questGiverWorld) showQuestState();
        },
      });
      if (giverOwner) resources.questGiverOwner = giverOwner;
    }

    const entrypoints = discoverFrameXmlAddonEntrypoints(boot);
    const raiseAddonLayer = (): void => { if (options.addonsOnly) gameWindows.raiseLayer(host); };
    if (options.addonsOnly) {
      host.addEventListener("pointerdown", raiseAddonLayer);
      characterWindow.addEventListener("pointerdown", raiseAddonLayer);
      resources.addonLayerCleanup = () => {
        host.removeEventListener("pointerdown", raiseAddonLayer);
        characterWindow.removeEventListener("pointerdown", raiseAddonLayer);
      };
    }
    const addonWindows = createFrameXmlTsAddonWindows(boot);
    const unregisterWindows = registerEscapable(addonWindows);
    const commandOwners = new Set<string>();
    const menuCleanups: (() => void)[] = [];
    resources.addonEntrypointsCleanup = () => {
      unregisterWindows();
      addonWindows.dispose();
      for (const owner of commandOwners) removeModuleCommands(owner);
      for (const cleanup of menuCleanups) cleanup();
      entrypoints.close();
    };
    for (const command of entrypoints.commands) {
      const owner = `TSWoW:${command.module}`;
      const error = addModuleCommand({ ...command, module: owner, help: command.module,
        run: (rest) => { raiseAddonLayer(); command.run(rest); },
      });
      if (error) console.warn(`TSWoW /${command.name}: ${error}`);
      else commandOwners.add(owner);
    }
    for (const button of entrypoints.menuButtons) {
      menuCleanups.push(registerGameMenuAddonButton(button.label, () => { raiseAddonLayer(); button.run(); }));
    }

    if (options.addonsOnly) {
      // The dialogs and error lines the modules raise themselves: popup adapters, UIErrorsFrame off the
      // world's messages and Escape, before the host is shown; the server's questions stay native
      // (FrameXmlAddonsOnlyMessages.ts). Released with the add-on entry points.
      const surfaces = mountFrameXmlAddonsOnlySurfaces(boot, seam, { raise: raiseAddonLayer });
      const closeEntrypoints = resources.addonEntrypointsCleanup;
      resources.addonEntrypointsCleanup = () => { surfaces.dispose(); closeEntrypoints?.(); };
      resources.nativeTooltipCleanup = installFrameXmlNativeItemTooltip(boot, (active) => {
        nativeTooltipActive = active;
      });
      const world = game.world;
      resources.models = new FrameXmlModelPreview({
        gatewayOrigin: origin,
        bridge: boot.bridge,
        elementFor: (frame) => renderer.elementFor(frame),
        isVisible: (frame) => addonPresentation!.includes(frame) && boot.bridge.isVisible(frame),
        creatureTemplate: (entry) => world?.creatureTemplate(entry),
        creatureModels: game.creatureModels,
        onDiagnostic: (message) => console.warn("[TSWoW model]", message),
      });
      const failed = boot.tsAddonResults.filter((addon) => !addon.ok);
      for (const addon of failed) console.error(`[TSWoW ${addon.module}]`, addon.errors);
      const talent = createPatchedFrameXmlTalentOwner(boot, renderer, hideTalentsWindow);
      if (talent) resources.talentOwnerCleanup = publishFrameXmlTalent(talent);
      const current = Object.assign(resources, { renderer, frame: 0 });
      mounted = current;
      let previous = boot.pump.now();
      const reportStepError = createFrameXmlStepErrorReporter();
      const step = (): void => {
        if (mounted !== current) return;
        const now = boot.pump.now();
        const elapsed = Math.min(0.25, Math.max(0, now - previous));
        previous = now;
        perf.stepBegin();
        try {
          boot.bridge.runInMutationBatch(() => {
            syncNativeAnchors();
            const seamAt = performance.now();
            seam.tick(now);
            const tickAt = performance.now();
            const handlers = boot.bridge.tick(elapsed);
            perf.stepPieces(tickAt - seamAt, performance.now() - tickAt, handlers);
          });
          // What packets and the store flush changed since the last frame (`setPaintDeferral`,
          // `setLayoutDeferral`) joins this frame's one pass.
          boot.bridge.flushDeferredPaint();
          renderer.tickCooldowns(now);
          resources.models?.frame(elapsed, performance.now());
        } catch (error) {
          reportStepError(error);
        } finally {
          perf.stepEnd();
        }
        if (mounted === current) current.frame = window.requestAnimationFrame(step);
      };
      host.style.visibility = "visible";
      (host as HTMLElement & { inert?: boolean }).inert = false;
      host.setAttribute("aria-hidden", "false");
      boot.bridge.setPaintDeferral(true);
      boot.bridge.setLayoutDeferral(true);
      current.frame = window.requestAnimationFrame(step);
      // `boot` is the live VM/bridge for DevTools probes (`frameXmlWorld().boot.vm`); it is not copied by
      // `copy(frameXmlWorld().errors)`, the census the owner pastes.
      const diagnostic = (): unknown => ({ ...inventory, tsAddons: boot.tsAddonResults, errors: boot.errors,
        widgetStubs: boot.binder.stubDiagnostics, savedVariables: boot.savedVariableDiagnostics, addonsOnly: true,
        surfaces: surfaces.counts(), boot });
      Object.defineProperty(window, "frameXmlWorld", {
        configurable: true,
        value: diagnostic,
      });
      resources.perfCleanup = publishFrameXmlWorldPerf(perf);
      resources.diagnosticCleanup = () => {
        if (Object.getOwnPropertyDescriptor(window, "frameXmlWorld")?.value === diagnostic) {
          Reflect.deleteProperty(window, "frameXmlWorld");
        }
      };
      return {
        ok: failed.length === 0 && inventory.errors.length === 0,
        message: `TSWoW: загружено ${boot.tsAddonResults.length - failed.length}/${boot.tsAddonResults.length} аддонов`,
      };
    }

    // QuestLogFrame and WatchFrame are promoted together after the stock QuestLog/Watch structural
    // proof. Their native browser owners are hidden at the publication boundary.
    const quest = frameXmlQuestGate(seam, boot, renderer);
    if (quest) {
      const questFrame = quest.frame;
      const owner: FrameXmlQuestOwner = {
        isOpen: () => boot.bridge.isVisible(questFrame),
        show: () => { boot.bridge.Show(questFrame); },
        hide: () => { boot.bridge.Hide(questFrame); },
        onFailure: () => demotePublishedQuest(resources),
      };
      resources.questOwner = owner;
    }

    // ContainerFrame is optional until the parallel corpus and inventory seam land.  Its gate
    // performs one real backpack click and leaves the native owner untouched when any stock
    // dependency is absent, so the action routes keep their fallback automatically.
    const bags = frameXmlBagGate(boot, renderer, () => demotePublishedBags(resources));
    if (bags) resources.bagOwner = bags;

    // Only the original mode reaches this branch. Publish the actual authored windows after
    // their structural/data gates; an unavailable owner retains the working WebClient fallback.
    const spellbook = spellBookGate(seam, boot, renderer);
    if (spellbook) resources.spellbookFrame = spellbook.frame;
    // The owner checks UnitClass("player") each time it opens, not here: the player's own object
    // may land after publication, and a token-less class demotes to the native sheet on that press.
    const character = frameXmlCharacterModelGate(boot, renderer,
      (reason) => console.warn(`[framexml] CharacterFrame: ${reason}`));
    if (character) {
      resources.characterPortraitCleanup = character.portraitCleanup;
      resources.characterOwner = createFrameXmlCharacterOwner(
        boot, character.character, () => demotePublishedCharacter(resources),
      );
    }
    // Respect a TSWoW replacement when enabled; otherwise load the original Blizzard talent UI.
    const patchedTalentOwner = createPatchedFrameXmlTalentOwner(
      boot, renderer, hideTalentsWindow, () => demotePublishedTalent(resources),
    );
    resources.talentOwner = patchedTalentOwner ?? createLazyFrameXmlTalentOwner(
      seam, boot, renderer, () => demotePublishedTalent(resources),
      // The stock talent frame hosts the stock glyph tab (Blizzard_GlyphUI, FrameXmlGlyphOwner.ts).
      createFrameXmlGlyphExtension({
        seam, boot, renderer,
        onFailure: (reason) => console.warn(`[FrameXML glyphs] ${reason}; the talent frame keeps no glyph tab`),
      }),
    );

    // Blizzard_TrainerUI is LoD. Keep its native browser panel as the fallback while the
    // asynchronous add-on load and exact tree gate are in flight.
    resources.trainerOwner = createLazyFrameXmlTrainerOwner(
      seam, boot, renderer, () => demotePublishedTrainer(resources), () => game.world ?? seam,
    );
    resources.nativeTrainerWasHidden = trainerWindow.hidden;
    // Blizzard_TradeSkillUI is LoD as well: the first profession opens natively while it loads and
    // gates (FrameXmlTradeSkillOwner.ts); a failure leaves the native craft window as the route.
    const tradeSkillMount = mountFrameXmlTradeSkill(seam, boot, renderer, textureUrl);
    if (tradeSkillMount) resources.tradeSkillMount = tradeSkillMount;

    // PVPFrame is a separate stock owner from CharacterFrame. Its honor page and the bounded
    // battleground queue page are published only when their complete stock trees and seam data
    // pass the gate. ArenaFrame is a sibling stock page and joins this owner only when its
    // battlemaster context/C APIs also pass, leaving ArenaWindow as fallback otherwise.
    const pvp = frameXmlPvpGate(seam, boot, renderer);
    if (pvp) {
      resources.pvpFrame = pvp.frame;
      const pvpOwner: FrameXmlPvpOwner = {
        isOpen: () => boot.bridge.isVisible(pvp.frame),
        show: () => { boot.bridge.Show(pvp.frame); },
        hide: () => {
          boot.bridge.Hide(pvp.frame);
          if (pvp.arena) boot.bridge.Hide(pvp.arena);
        },
      };
      if (pvp.arena) {
        pvpOwner.isArenaOpen = () => boot.bridge.isVisible(pvp.arena!);
        pvpOwner.showArena = () => { boot.bridge.Show(pvp.arena!); };
        pvpOwner.hideArena = () => { boot.bridge.Hide(pvp.arena!); };
      }
      resources.pvpOwner = pvpOwner;
    }

    // GameMenuFrame becomes the game menu once its stock buttons, the adapters and extras
    // (installed after load) and one silent Show/Hide pass; the native Panel stays the fallback.
    const stockGameMenu = frameXmlGameMenuGate(boot, renderer);
    if (stockGameMenu) {
      resources.gameMenuOwner = createFrameXmlGameMenuOwner(boot, stockGameMenu.frame, logoutPending);
    }
    // LFDParentFrame becomes the dungeon finder only over a version-2 catalog (the gate refuses
    // otherwise); a gateway still serving version 1 keeps the native #lfg-window.
    const stockLfd = frameXmlLfdGate(seam, boot, renderer);
    if (stockLfd) resources.lfdOwner = createFrameXmlLfdOwner(boot, stockLfd.frame);
    else if (!options.seam) console.warn("[FrameXML LFD] stock dungeon finder not published; the native window stays");
    // FriendsFrame (Friends, Who, Guild, Chat, Raid tabs) becomes the social window once its tree and
    // one silent muted visit of every tab pass; the native social panel and guild window stay otherwise.
    const stockFriends = frameXmlFriendsGate(seam, boot, renderer);
    if (stockFriends) resources.friendsOwner = createFrameXmlFriendsOwner(boot, stockFriends.frame);
    else if (!options.seam) console.warn("[FrameXML friends] stock FriendsFrame not published; the native social windows stay");
    // GossipFrame, BankFrame, TaxiFrame and ItemTextFrame, each behind its own gate (NPC lane).
    if (!options.addonsOnly) resources.npcWindows = mountFrameXmlNpcWindows(seam, boot, renderer, HOST_ID);
    // StaticPopup1-4 and ReadyCheckFrame become the server's confirmations once their stock tree,
    // UIParent's event branches and one silent muted probe pass; the native panels stay otherwise.
    installFrameXmlPopupsAdapters(boot);
    // While one of them is up the overlay stands over the native windows, whose clicks would take a
    // popup's buttons; it falls back when the last hides (FrameXmlAddonsOnlyMessages.ts).
    watchFrameXmlDialogLayer(boot, { raise: () => gameWindows.raiseLayer(host), lower: () => { host.style.zIndex = ""; } });
    const stockPopups = frameXmlPopupsGate(seam, boot, renderer);
    if (stockPopups) resources.popupsOwner = createFrameXmlPopupsOwner(boot, seam.popups);
    else if (!options.seam) console.warn("[FrameXML popups] stock dialogs not published; the native prompts stay");
    // LootFrame and GroupLootFrame1-4 own loot once their stock tree and one silent, muted synthetic
    // opening and roll pass (FrameXmlLootOwner.ts); the native #loot-window and roll cards stay otherwise.
    const stockLoot = seam.loot ? frameXmlLootGate(seam, boot, renderer) : undefined;
    if (stockLoot && seam.loot) resources.lootOwner = createFrameXmlLootOwner(boot, seam.loot, stockLoot.frame);
    else if (!options.seam) console.warn("[FrameXML loot] stock loot window not published; the native window stays");
    // MailFrame/OpenMailFrame and TradeFrame own the mailbox and an open trade once their stock trees
    // and one silent, muted Show/Hide pass hold (FrameXmlMailOwner.ts, FrameXmlTradeOwner.ts).
    const stockMail = frameXmlMailGate(seam, boot, renderer);
    if (stockMail) resources.mailOwner = createFrameXmlMailOwner(boot, stockMail);
    else if (!options.seam) console.warn("[FrameXML mail] stock mailbox not published; the native window stays");
    const stockTrade = frameXmlTradeGate(seam, boot, renderer);
    if (stockTrade) resources.tradeOwner = createFrameXmlTradeOwner(boot, stockTrade.frame);
    else if (!options.seam) console.warn("[FrameXML trade] stock trade window not published; the native window stays");

    const merchant = frameXmlMerchantGate(seam, boot, renderer);
    if (merchant) {
      resources.merchantFrame = merchant.frame;
      resources.nativeVendorWasHidden = vendorWindow.hidden;
      resources.merchantOwner = {
        isOpen: () => boot.bridge.isVisible(merchant.frame),
        show: () => { boot.bridge.Show(merchant.frame); },
        hide: () => { boot.bridge.Hide(merchant.frame); },
        refresh: (event, force) => {
          seam.merchantChanged(event, force);
        },
      };
    }

    const buffFrame = boot.bridge.getFrame("BuffFrame");
    const buffFrameElement = buffFrame ? renderer.elementFor(buffFrame) : undefined;
    if (!buffFrame || !buffFrameElement) {
      throw new Error("FrameXML BuffFrame gate missing BuffFrame");
    }

    const minimapCluster = boot.bridge.getFrame("MinimapCluster");
    const minimap = boot.bridge.getFrame("Minimap");
    const minimapClusterElement = minimapCluster ? renderer.elementFor(minimapCluster) : undefined;
    const minimapElement = minimap ? renderer.elementFor(minimap) : undefined;
    if (!minimapCluster || !minimap || !minimapClusterElement || !minimapElement) {
      throw new Error("FrameXML Minimap gate missing MinimapCluster/Minimap");
    }
    const minimapCleanup = adoptMinimapCanvas(minimapElement);
    if (!minimapCleanup) {
      throw new Error("FrameXML Minimap canvas adoption failed");
    }
    resources.minimapCleanup = minimapCleanup;

    const targetFrame = boot.bridge.getFrame("TargetFrame");
    const targetPortrait = boot.bridge.getFrame("TargetFramePortrait");
    const targetFrameElement = targetFrame ? renderer.elementFor(targetFrame) : undefined;
    const targetPortraitElement = targetPortrait ? renderer.elementFor(targetPortrait) : undefined;
    if (!targetFrame || !targetPortrait || !targetFrameElement || !targetPortraitElement) {
      throw new Error("FrameXML TargetFrame gate missing TargetFrame/TargetFramePortrait");
    }
    const targetPortraitCleanup = adoptTargetPortraitCanvas(targetPortraitElement);
    if (!targetPortraitCleanup) {
      throw new Error("FrameXML TargetFrame portrait adoption failed");
    }
    resources.targetPortraitCleanup = targetPortraitCleanup;

    const playerPortrait = boot.bridge.getFrame("PlayerPortrait");
    const portraitCleanup = adoptPlayerPortraitCanvas(
      playerPortrait ? renderer.elementFor(playerPortrait) : undefined,
    );
    if (portraitCleanup) resources.portraitCleanup = portraitCleanup;

    // Focus and target-of-target are independent contextual lanes. Their existing UnitFrame
    // canvases are borrowed only after each exact stock gate succeeds; a broken one must leave
    // that native lane available without weakening the other lane's takeover.
    const focus = focusGate(boot, renderer);
    if (focus) {
      try {
        const cleanup = adoptFocusPortraitCanvas(focus.portraitElement);
        if (cleanup) resources.focusPortraitCleanup = cleanup;
      } catch {
        // Keep native #focus-frame visible when the borrowed canvas cannot be adopted.
      }
    }
    const targetOfTarget = targetOfTargetGate(boot, renderer);
    if (targetOfTarget) {
      try {
        const cleanup = adoptTargetOfTargetPortraitCanvas(targetOfTarget.portraitElement);
        if (cleanup) resources.targetOfTargetPortraitCleanup = cleanup;
      } catch {
        // Keep native #tot-frame visible when the borrowed canvas cannot be adopted.
      }
    }
    // The focus's own ToT row has no native lane to fall back to: a failed gate simply leaves the
    // stock Texture blank, as the other frames' gates leave theirs.
    const focusTargetOfTarget = focusTargetOfTargetGate(boot, renderer);
    if (focusTargetOfTarget) {
      try {
        const cleanup = adoptFocusTargetPortraitCanvas(focusTargetOfTarget.portraitElement);
        if (cleanup) resources.focusTargetPortraitCleanup = cleanup;
      } catch {
        // Nothing native to restore; the stock row keeps its authored Texture.
      }
    }

    // PetFrame is an optional contextual owner.  Its native PetPortrait Texture is intentionally
    // empty in stock XML, so never hide #pet-frame until the existing UnitFrame pet canvas has
    // successfully been adopted into the fully gated static frame tree.  A missing dependency or
    // a failed adoption leaves the complete HUD mounted and the native pet lane untouched.
    const petPortraitElement = petGate(boot, renderer);
    if (petPortraitElement) {
      try {
        const petPortraitCleanup = adoptPetPortraitCanvas(petPortraitElement);
        if (petPortraitCleanup) resources.petPortraitCleanup = petPortraitCleanup;
      } catch {
        // Pet ownership is optional; keep the native lane when adoption is not safe.
      }
    }

    const partyPortraitElements = partyGate(boot, renderer);
    if (partyPortraitElements) {
      const cleanups: Array<() => void> = [];
      try {
        for (const [index, portraitElement] of partyPortraitElements.entries()) {
          const cleanup = adoptPartyPortraitCanvas(index, portraitElement);
          if (!cleanup) throw new Error(`PartyFrame${index + 1} portrait adoption failed`);
          cleanups.push(cleanup);
        }
        resources.partyPortraitCleanups = cleanups;
      } catch {
        // A single missing native canvas must not hide the complete native party lane. Return any
        // earlier borrowed rows before continuing with the core HUD mount.
        for (const cleanup of cleanups) bestEffortCleanup(cleanup);
      }
    }

    if (chatGate(seam, boot, renderer)) {
      resources.nativeChatLogState = captureNativeChatLogState();
      setNativeChatReplacementActive(true);
      // The stock edit box takes Enter, `/`, reply and links; only then is the native form hidden.
      const chatInputCleanup = installStockChatInput(seam, boot, renderer,
        () => document.body.classList.remove(NATIVE_CHAT_INPUT_REPLACEMENT_CLASS));
      if (chatInputCleanup) {
        resources.chatInputCleanup = chatInputCleanup;
        document.body.classList.add(NATIVE_CHAT_INPUT_REPLACEMENT_CLASS);
      }
    }

    // The engine half of the stock world-unit tooltip: the real client anchors GameTooltip at the
    // default position and calls SetUnit("mouseover") when the hovered world unit changes, and
    // fades it when the pointer leaves that unit.
    const worldMouseover = createFrameXmlWorldMouseover({
      hovered: () => hoveredUnitGuid(game.world),
      ...compileFrameXmlWorldMouseoverScripts(boot.vm),
    });
    const reportStepError = createFrameXmlStepErrorReporter();
    let previous = boot.pump.now();
    const step = (): void => {
      if (mounted !== current) return;
      const now = boot.pump.now();
      const elapsed = Math.min(0.25, Math.max(0, now - previous));
      previous = now;
      // One thrown frame (a seam getter, a renderer sync, a fengari stack overflow out of
      // bridge.tick) used to skip the requestAnimationFrame below and freeze the whole HUD.
      perf.stepBegin();
      try {
        if (questPortraitRequested) {
          setQuestGiverPortrait(seam.questNpcPortraitGuid());
          // A temporarily streamed-out unit may return while its quest page is still open. Retain
          // the request until that page closes, then release the renderer's target GUID promptly.
          if (!game.world?.questDialog && !game.world?.questList) questPortraitRequested = false;
        }
        boot.bridge.runInMutationBatch(() => {
          const seamAt = performance.now();
          seam.tick(now);
          const tickAt = performance.now();
          const handlers = boot.bridge.tick(elapsed);
          perf.stepPieces(tickAt - seamAt, performance.now() - tickAt, handlers);
          worldMouseover.tick(performance.now());
        });
        // What packets and the store flush changed since the last frame (`setPaintDeferral`,
        // `setLayoutDeferral`) joins this frame's one pass.
        boot.bridge.flushDeferredPaint();
        renderer.tickCooldowns(now);
        publishMapWhenReady();
        document.body.classList.toggle("framexml-world-map-fullscreen",
          boot.bridge.getFrame("WorldMapFrame")?.visible === true
          && boot.bridge.getFrame("UIParent")?.visible === false);
      } catch (error) {
        reportStepError(error);
      } finally {
        perf.stepEnd();
      }
      if (mounted === current) current.frame = window.requestAnimationFrame(step);
    };
    const current = resources as FrameXmlMountResources & {
      renderer: FrameXmlDomRenderer;
      frame: number;
    };
    current.renderer = renderer;
    current.frame = 0;
    // Own the resources before enabling the class or asking the browser for the first frame. If
    // either publication step throws, the exception path can use the same complete owner record.
    mounted = current;
    setNativeLanesReplacementActive(true);
    // Bound only now, after load and exercise, so no add-on can loop ReloadUI from its OnLoad.
    let reloadRequested = false;
    installFrameXmlReloadUi(boot.vm, clientAddons.map((addon) => addon.name), () => {
      if (reloadRequested || mounted !== current) return;
      reloadRequested = true;
      // The request arrives from inside a Lua handler (the popup's OnAccept, /reload); that VM has
      // to unwind before the unmount below closes it.
      setTimeout(() => {
        if (mounted !== current) return;
        const disabled = frameXmlSessionDisabledClientAddons();
        console.warn("[framexml] ReloadUI: remounting the stock HUD"
          + (disabled.length > 0 ? `; client add-ons off for this session: ${disabled.join(", ")}` : ""));
        // Bracketed like EnterWorld's UI-mode mount: the unmount drops every TSWoW module slash
        // command, and until the fresh VM registers them again (5-18 s measured offline) a typed
        // one must read «Аддоны ещё загружаются…», not «Неизвестная команда».
        const finishModuleCommandLoad = game.world ? beginModuleCommandLoad(game.world) : undefined;
        let remount: Promise<FrameXmlWorldMountResult>;
        try {
          unmountFrameXmlVertical();
          remount = mountFrameXmlVertical(options);
        } catch (error) {
          remount = Promise.reject(error);
        }
        void remount.then((result) => {
          bestEffortCleanup(() => systemLine(result.ok
            ? "Интерфейс перезагружен." : `Интерфейс не перезагрузился: ${result.message}`));
        }, (error: unknown) => console.error("[framexml] ReloadUI remount failed", error))
          .finally(() => finishModuleCommandLoad?.());
      }, 0);
    });
    const mirrorTimersReady = [1, 2, 3].every((index) => {
      const timer = boot.bridge.getFrame(`MirrorTimer${index}`);
      return timer && renderer.elementFor(timer) && boot.bridge.hasScript(timer, "OnEvent")
        && boot.bridge.hasScript(timer, "OnUpdate")
        && boot.bridge.getFrame(`MirrorTimer${index}StatusBar`)
        && boot.bridge.getFrame(`MirrorTimer${index}Text`);
    });
    if (mirrorTimersReady) {
      document.body.classList.add(NATIVE_MIRROR_TIMERS_REPLACED);
      style.textContent += `\nbody.${NATIVE_MIRROR_TIMERS_REPLACED} #mirror-timers { display: none !important; }`;
      resources.mirrorTimersCleanup = () => document.body.classList.remove(NATIVE_MIRROR_TIMERS_REPLACED);
    }
    if (resources.spellbookFrame) {
      const frame = resources.spellbookFrame;
      resources.nativeSpellbookWasHidden = spellbookWindow.hidden;
      spellbookWindow.hidden = true;
      resources.spellbookOwnerCleanup = publishFrameXmlSpellBook({
        isOpen: () => boot.bridge.isVisible(frame),
        show: () => { boot.bridge.Show(frame); },
        hide: () => { boot.bridge.Hide(frame); },
      });
    }
    if (resources.characterOwner) {
      resources.nativeCharacterWasHidden = characterWindow.hidden;
      characterWindow.hidden = true;
      resources.characterOwnerCleanup = publishFrameXmlCharacter(resources.characterOwner);
      setNativeCharacterReplacementActive(true);
      // Blizzard_TokenUI is LoD: tab 5 «Валюта» and the backpack strip load once the player knows a
      // currency, over /dbc/currencies (FrameXmlTokenOwner.ts).
      resources.tokenCleanup = mountFrameXmlToken(seam, boot, renderer, { gatewayOrigin: origin })?.cleanup;
    }
    if (resources.trainerOwner) {
      resources.trainerOwnerCleanup = publishFrameXmlTrainer(resources.trainerOwner);
      if (game.world?.trainer && !resources.trainerOwner.isOpen()) resources.trainerOwner.show();
    }
    // From here every profession open asks the stock owner first (Professions.openProfession).
    if (resources.tradeSkillMount) resources.tradeSkillCleanup = resources.tradeSkillMount.publish();
    // Blizzard_AuctionUI is LoD too: the first auctioneer loads it; the native window stays until its gate.
    resources.auctionCleanup = mountFrameXmlAuction(seam, boot, renderer);
    // Stock DressUpFrame: Ctrl+click's DressUpItemLink, and the auction add-on's side frame once it loads.
    if (!options.addonsOnly) resources.dressUpCleanup = mountFrameXmlDressUp(boot, renderer, { gatewayOrigin: origin });
    // Blizzard_InspectUI, Blizzard_ItemSocketingUI and Blizzard_BarbershopUI are LoD: nothing loads until first use.
    resources.inspectSocketBarberCleanup = mountFrameXmlInspectSocketBarber(seam, boot, renderer);
    // Blizzard_GuildBankUI likewise: the first banker visit loads it; the native window stays until its gate.
    resources.guildBankCleanup = mountFrameXmlGuildBank(seam, boot, renderer);
    if (resources.pvpOwner) {
      resources.pvpOwnerCleanup = publishFrameXmlPvp(resources.pvpOwner);
    }
    if (resources.gameMenuOwner) {
      // A native menu opened while the corpus loaded closes first: one menu owner at a time.
      closeGameMenu();
      resources.gameMenuOwnerCleanup = publishFrameXmlGameMenu(resources.gameMenuOwner);
    }
    // Each gated NPC window takes its route (an open page/map/bank is handed over, the native steps aside).
    if (resources.npcWindows) resources.npcWindowsCleanup = resources.npcWindows.publish();
    // Blizzard_MacroUI and Blizzard_BindingUI are LoD: nothing loads until the first open, and the
    // native macro and binding windows stay the fallback until each stock gate passes.
    if (!options.addonsOnly) {
      resources.macroBindingWindowsCleanup = mountFrameXmlMacroBindingWindows(seam, boot, renderer, {
        openMacros: openMacroWindow,
        openNativeMacros: openNativeMacroWindow,
        openNativeKeyBindings: openNativeKeyBindingsWindow,
      }).publish();
      // Blizzard_Calendar is LoD too: the first open loads it beside /dbc/calendar; the native calendar
      // stays the fallback until its gate passes.
      resources.calendarCleanup = mountFrameXmlCalendar(seam, boot, renderer, {
        openNative: openNativeCalendar,
        catalog: new FrameXmlCalendarCatalogClient(origin),
      }).publish();
    }
    // The options chain loads on the first «Изображение»/«Звук»/«Интерфейс» or /settings, not at boot
    // (FRAMEXML_OPTIONS_TOC); the native settings window stays the fallback until its gate passes.
    if (!options.addonsOnly) {
      resources.optionsCleanup = mountFrameXmlOptions(boot, renderer,
        frameXmlLiveOptionsHost(() => !document.body.classList.contains(NATIVE_CHAT_REPLACEMENT_CLASS)));
    }
    if (resources.lfdOwner) {
      closeLfgWindow();
      resources.lfdOwnerCleanup = publishFrameXmlLfd(resources.lfdOwner);
      // From here the stock ready/role-check/boot/continue popups answer the server; the native
      // InteractionPrompts sections step aside (frameXmlLfdPublished).
      if (seam.lfd) seam.lfd.popupsOwned = true;
    }
    if (resources.friendsOwner) {
      // A native social panel or guild window opened while the corpus loaded closes first.
      closeSocialPanel();
      if (guildWindowOpen()) closeGuildWindow();
      resources.friendsOwnerCleanup = publishFrameXmlFriends(resources.friendsOwner);
      // From here `/who` answers reach the stock Who tab (or chat), not the native panel.
      if (seam.friends) seam.friends.owned = true;
    }
    // Blizzard_RaidUI is LoD: the stock Raid tab's group grid loads at the first RAID_ROSTER_UPDATE
    // (or now, already in a raid), through the host instead of stock's load-error dialog.
    if (resources.friendsOwner) {
      resources.raidGridCleanup = mountFrameXmlRaidGrid(seam, boot, renderer)?.cleanup ?? (() => {});
    }
    // Blizzard_ArenaUI is LoD: the enemy arena frames load at the arena's PLAYER_ENTERING_WORLD (or the
    // match's battlefield status), through the host instead of stock's load-error dialog.
    resources.arenaEnemyCleanup = mountFrameXmlArenaEnemy(seam, boot, renderer)?.cleanup;
    if (resources.popupsOwner) {
      resources.popupsOwnerCleanup = publishFrameXmlPopups(resources.popupsOwner, () => boot.isAddonLoaded("Blizzard_TalentUI"));
      // From here the stock dialogs answer the server; the native prompts step aside at once and
      // whatever is still pending is shown by stock (FrameXmlPopups.ts popupsOwned edge).
      refreshFrameXmlPopupsNative();
      if (seam.popups) seam.popups.popupsOwned = true;
    }
    if (resources.lootOwner && seam.loot) {
      // From here the stock frames answer loot: the native window and roll cards step aside
      // (frameXmlLootPublished), and an opening or roll already in flight reaches stock next tick.
      resources.lootOwnerCleanup = publishFrameXmlLootMount(resources.lootOwner, seam.loot,
        (name) => boot.vm.globalString(name), () => { showLoot(); showLootRolls(); });
    }
    if (resources.mailOwner) {
      // The native window steps aside (Mail.showMail asks frameXmlMailPublished) without closing the
      // mailbox; `owned` then hands a mailbox that is already open to stock with MAIL_SHOW.
      resources.mailOwnerCleanup = publishFrameXmlMail(resources.mailOwner);
      showNativeMail();
      if (seam.mail) seam.mail.owned = true;
    }
    if (resources.tradeOwner) {
      // Likewise for an open trade: #trade-window's offer view steps aside (Social.showTrade) and
      // `owned` shows stock TradeFrame for a trade that is already open.
      resources.tradeOwnerCleanup = publishFrameXmlTrade(resources.tradeOwner);
      showNativeTrade();
      if (seam.trade) seam.trade.owned = true;
    }
    if (resources.merchantOwner) {
      // Hide the native fallback only once the complete stock tree is ready and publish exactly
      // one owner. EnterWorld routes future vendor callbacks through this controller.
      vendorWindow.hidden = true;
      resources.merchantOwnerCleanup = publishFrameXmlMerchantMount(
        resources.merchantOwner, vendorWindow, resources.nativeVendorWasHidden,
      );
    }
    if (resources.bagOwner) {
      resources.nativeInventoryWasHidden = closeNativeBagsBeforeReplacement();
      resources.bagOwnerCleanup = publishFrameXmlBags(resources.bagOwner);
      setNativeBagsReplacementActive(true);
    }
    if (resources.talentOwner) {
      // Close a native panel that may have opened while the asynchronous world mount was in flight,
      // then publish exactly one owner for N, the HUD button, FrameXML microbutton, and Escape.
      hideTalentsWindow();
      resources.talentOwnerCleanup = publishFrameXmlTalent(resources.talentOwner);
    }
    if (resources.questOwner) {
      // The native browser panel is borrowed only after the stock tree has mounted and passed its
      // exact gate. The stock QuestLog owner includes WatchFrame and its native tracker is hidden
      // by the same replacement state before publication.
      resources.nativeQuestLogState = beginQuestLogNativeReplacement();
      resources.questOwnerCleanup = publishFrameXmlQuest(resources.questOwner);
    }
    if (resources.questGiverOwner) {
      resources.questGiverOwnerCleanup = publishFrameXmlQuestGiver(resources.questGiverOwner);
      resources.questGiverEscapeCleanup = registerEscapable({
        isOpen: frameXmlQuestGiverOpen,
        close: () => { closeFrameXmlQuestGiver(); },
      });
    }
    if (targetContextGate(boot, renderer)) {
      style.textContent += `\n${TARGET_CONTEXT_CSS}`;
      setNativeTargetContextReplacementActive(true);
    }
    if (resources.focusPortraitCleanup) setNativeFocusReplacementActive(true);
    if (resources.targetOfTargetPortraitCleanup) setNativeTargetOfTargetReplacementActive(true);
    if (resources.petPortraitCleanup) {
      style.textContent += `\n${PET_CSS}`;
      setNativePetReplacementActive(true);
    }
    // The pet bar is its own owner: the stock PetActionBarFrame draws (and the native #pet-bar
    // steps aside for a pet's bar) only once the ten stock buttons and the seam's model are there.
    if (petActionBarGate(boot, renderer, seam)) setNativePetBarReplacementActive(true);
    if (resources.partyPortraitCleanups?.length === 4) {
      style.textContent += `\n${PARTY_CSS}`;
      setNativePartyReplacementActive(true);
    }
    // The row is loaded in the production TOC, but its ten buttons were hidden before the
    // session exercise. Reveal them only after every enabled destination and every C/B/P/N/J/gear
    // replacement owner has passed one structural gate. Achievement is deliberately disabled: a
    // missing Blizzard_AchievementUI owner is not silently replaced with a fake panel.
    const microButtonProof: FrameXmlMicroButtonOwnerProof = {
      owners: {
        character: !!resources.characterOwner,
        spellbook: !!resources.spellbookFrame,
        talent: !!resources.talentOwner,
        achievement: "disabled",
        quest: !!resources.questOwner,
        socials: true,
        pvp: !!resources.pvpOwner,
        lfd: true,
        gameMenu: true,
        help: true,
      },
      nativeReplacement: {
        character: !!resources.characterOwner,
        bags: !!resources.bagOwner,
        spellbook: !!resources.spellbookFrame,
        talents: !!resources.talentOwner,
        // The native J action opens stock SkillFrame (CharacterFrame tab 4) through the character
        // owner, or else the stock SpellBookFrame's skill-line tabs; no handcrafted panel is added.
        professions: !!resources.characterOwner || !!resources.spellbookFrame,
        // Diagnostics is an entry of whichever menu MainMenuMicroButton opens: the stock
        // GameMenuFrame's «Диагностика» extra when published, the native menu's otherwise.
        diagnostics: true,
      },
      adaptersInstalled: microButtonAdaptersInstalled,
    };
    const microButtons = microButtonAdaptersInstalled
      ? frameXmlMicroButtonOwnerGate(boot, renderer, microButtonProof)
      : undefined;
    if (microButtons) {
      for (const button of microButtons) boot.bridge.Show(button);
      const achievement = boot.bridge.getFrame("AchievementMicroButton");
      const achievementElement = achievement ? renderer.elementFor(achievement) : undefined;
      achievementElement?.setAttribute("title", "Достижения недоступны в этой сборке");
      achievementElement?.setAttribute("aria-label", "Достижения недоступны в этой сборке");
      resources.microButtonNativeReplacementActive = true;
      setNativeMicroButtonsReplacementActive(true);
    } else hideFrameXmlMicroButtons(boot);
    // Blizzard_AchievementUI is LoD and published only now, after the row gate saw the button
    // disabled; the button then follows HasCompletedAnyAchievement (FrameXmlAchievementMount.ts).
    resources.achievementCleanup = mountFrameXmlAchievement(seam, boot, renderer, {
      gatewayOrigin: origin,
      microButtons: microButtons !== undefined,
      uiError: (text) => { boot.pump.fire("UI_ERROR_MESSAGE", text); },
    });
    // All gates and owner/class publications above are complete.  Reveal the already-laid-out
    // stage as one final commit so native fallback and FrameXML never flash as a mixed owner.
    host.style.visibility = "visible";
    (host as HTMLElement & { inert?: boolean }).inert = false;
    host.setAttribute("aria-hidden", "false");
    // From here the frame step reconciles what packets and the store flush change between frames:
    // paint from any source, and everything a world event changes (`setLayoutDeferral`).
    boot.bridge.setPaintDeferral(true);
    boot.bridge.setLayoutDeferral(true);
    current.frame = window.requestAnimationFrame(step);

    const numbers = {
      files: inventory.files.total,
      bytes: inventory.files.bytes,
      widgets: inventory.widgets.total,
      errorsRaised: inventory.lua.errorsRaised,
      distinctErrors: inventory.errors.length,
      scanMs: Math.round(inventory.timings.scanMs),
      planMs: Math.round(inventory.timings.planMs),
      loadMs: Math.round(inventory.timings.loadMs),
      totalMs: Math.round(inventory.timings.totalMs),
    };
    // `boot`/`renderer` are the live VM, bridge and DOM renderer for DevTools probes
    // (`frameXmlWorld().boot.vm.call(...)`); `copy(frameXmlWorld().errors)` never touches them.
    const diagnostic = (): unknown => ({ ...inventory, errors: boot.errors, numbers, cooldownWidgets: renderer.cooldownCount,
      widgetStubs: boot.binder.stubDiagnostics, savedVariables: boot.savedVariableDiagnostics, boot, renderer });
    Object.defineProperty(window, "frameXmlWorld", {
      configurable: true,
      value: diagnostic,
    });
    resources.perfCleanup = publishFrameXmlWorldPerf(perf);
    resources.diagnosticCleanup = () => {
      if (Object.getOwnPropertyDescriptor(window, "frameXmlWorld")?.value === diagnostic) {
        Reflect.deleteProperty(window, "frameXmlWorld");
      }
    };
    return {
      ok: true,
      message: `FrameXML: ${numbers.files} файлов, ${(numbers.bytes / 1024).toFixed(0)} КиБ, `
        + `${numbers.widgets} виджетов, ошибок ${numbers.errorsRaised}; `
        + `скан ${numbers.scanMs} мс, план ${numbers.planMs} мс, загрузка ${numbers.loadMs} мс, `
        + `всего ${numbers.totalMs} мс`,
      numbers,
    };
  } catch (error) {
    cleanupPublishedMount(resources);
    return { ok: false, message: `FrameXML не смонтировался: ${String(error)}` };
  }
}

/** Take it down again: the VM, the DOM, the listener and the frame callback. */
export function unmountFrameXmlVertical(): void {
  mountEpoch += 1;
  if (pendingMount) cleanupPendingMount(pendingMount);
  const current = mounted;
  if (current) {
    cleanupPublishedMount(current);
  } else {
    setNativeLanesReplacementActive(false);
    setNativeTargetContextReplacementActive(false);
    setNativeFocusReplacementActive(false);
    setNativeTargetOfTargetReplacementActive(false);
    setNativePetReplacementActive(false);
    setNativePetBarReplacementActive(false);
    setNativePartyReplacementActive(false);
    setNativeBagsReplacementActive(false);
    setNativeCharacterReplacementActive(false);
    setNativeMicroButtonsReplacementActive(false);
  }
  // Stock tooltips still waiting on a late item or spell row close over the Lua state just shut;
  // drop them now rather than at the next HUD's adapter or the next answer.
  resetFrameXmlTooltipRedraws();
}

// Context owns the world lifetime while this optional module owns the actual overlay resources.
// Registration keeps cleanup synchronous once the module has been loaded, without making the
// default front door import FrameXML eagerly.
registerWorldContextCleanup(unmountFrameXmlVertical);
