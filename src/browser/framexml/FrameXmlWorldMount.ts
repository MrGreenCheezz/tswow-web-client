import { gatewayOrigin as defaultGatewayOrigin, clientLocale } from "../Environment.js";
import { createHttpFileProvider } from "../glue/GlueLoader.js";
import { game, registerWorldContextCleanup } from "../game/Context.js";
import { reactionBetween } from "../game/Targeting.js";
import { castSpell } from "../ui/Spellbook.js";
import { ensureSpellNames } from "../ui/SpellNames.js";
import { setSetting, settings } from "../ui/Settings.js";
import { characterWindow, characterSheetPane, gameWindows, inventoryWindow, spellbookWindow, trainerWindow, vendorWindow } from "../ui/Dom.js";
import { closeBagWindows } from "../ui/Bags.js";
import { hideTalentsWindow } from "../ui/Talents.js";
import { showTrainer, showVendor } from "../ui/Npc.js";
import {
  beginQuestLogNativeReplacement,
  restoreQuestLogNativeReplacement,
  type QuestLogNativeState,
} from "../ui/QuestLog.js";
import { GlueLuaRef } from "../glue/GlueLua.js";
import {
  toggleFrameXmlSpellBook,
} from "./FrameXmlSpellBookController.js";
import {
  publishFrameXmlTalent,
  toggleFrameXmlTalent,
  type FrameXmlTalentOwner,
} from "./FrameXmlTalentController.js";
import { showAuras } from "../ui/Auras.js";
import { chatLog } from "../ui/Dom.js";
import { redrawChatLog } from "../ui/ChatDock.js";
import {
  adoptPartyPortraitCanvas,
  adoptFocusPortraitCanvas,
  adoptPetPortraitCanvas,
  adoptPlayerPortraitCanvas,
  adoptTargetPortraitCanvas,
  adoptTargetOfTargetPortraitCanvas,
} from "../ui/Portraits.js";
import {
  adoptMinimapCanvas,
  currentAreaId,
  forgetMinimap,
  minimapWidgetAdapter,
} from "../ui/Minimap.js";
import { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { FrameXmlFontLoader } from "../ui/framexml_compat/FrameXmlFonts.js";
import { FrameXmlTextureCache } from "../ui/framexml_compat/FrameXmlTextures.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { unit } from "../../world/Fields.js";
import type { FrameXmlFactionRow, FrameXmlQuestItemMetadata } from "./FrameXmlWorldSeam.js";
import type { FrameXmlTalentMetadata } from "./FrameXmlTalentResolver.js";
import { resolveFrameXmlReputationRows } from "./FrameXmlReputationResolver.js";
import { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } from "./FrameXmlBoot.js";
import { fetchFrameXmlClientAddons } from "./FrameXmlClientAddons.js";
import {
  publishFrameXmlBags,
  type FrameXmlBagOwner,
} from "./FrameXmlBagController.js";
import {
  toggleFrameXmlCharacter,
  type FrameXmlCharacterOwner,
} from "./FrameXmlCharacterController.js";
import {
  frameXmlQuestGate,
  publishFrameXmlQuest,
  toggleFrameXmlQuest,
  type FrameXmlQuestOwner,
} from "./FrameXmlQuestController.js";
import { FRAMEXML_VERTICAL_TOC } from "./FrameXmlCorpus.js";
import { LiveWorldSeam } from "./LiveWorldSeam.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { createFrameXmlSpellBookTabResolvers } from "./FrameXmlSpellBookTabs.js";
import { createFrameXmlSettingsCVar } from "./FrameXmlSettingsCVar.js";
import { toggleSocialPanel } from "../ui/SocialPanel.js";
import { toggleLfgWindow } from "../ui/Social.js";
import { registerGameMenuAddonButton, toggleGameMenu } from "../ui/GameMenu.js";
import { addModuleCommand, removeModuleCommands, helpLines, systemLine } from "../ui/Chat.js";
import { discoverFrameXmlAddonEntrypoints } from "./FrameXmlAddonEntrypoints.js";
import { FrameXmlTsAddonPresentation } from "./FrameXmlTsAddonPresentation.js";
import { createFrameXmlTsAddonWindows } from "./FrameXmlTsAddonWindows.js";
import { registerEscapable } from "../ui/Windows.js";
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
export { frameXmlFlagEnabled } from "./FrameXmlWorldPolicy.js";

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
 * Shared world VM: ordinary login paints TSWoW modules; `?framexml=1` also paints the stock HUD.
 *
 * Three rules the slice set for it, and each is a line of code below rather than an intention.
 *
 * **It never blocks the world.** The whole module is loaded by a dynamic `import()` from
 * `EnterWorld.ts`. Both modes boot asynchronously after the world is already up. The addon-only
 * path below returns before the stock HUD gates and publishes no native replacement classes.
 * The subset keeps the stock dependencies needed by the loaded modules. The active TSWoW blocks
 * are appended from the client's TOC, so their file count and byte cost belong in each boot report.
 *
 * **Only the DOM lanes replaced by this vertical are hidden.** Once the renderer has mounted,
 * one owner class on `<body>` activates exact-ID CSS for the player HUD/cast, player-aura strip and
 * action-bar containers, plus the duplicate target shell. Optional classes are published only after
 * their own concrete stock gates pass: one owns exactly the target cast/aura lanes, and one owns
 * exactly the native pet frame after borrowing the existing pet portrait canvas. The minimap is
 * deliberately hybrid: FrameXML owns
 * the stock cluster/map shell and borrows the native canvas, while the native rail keeps its live
 * clock, tracking and world-map actions as the explicit fallback. Exact minimap selectors remove
 * only duplicate native map/labels/zoom/rotate controls and dead FrameXML tracking/map controls;
 * the fallback is laid out below the 192-unit stock cluster. The target rail itself stays present:
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
const NATIVE_LANES_REPLACEMENT_CLASS = "framexml-world-replaces-native";
const NATIVE_TARGET_CONTEXT_REPLACEMENT_CLASS = "framexml-world-replaces-target-context";
const NATIVE_PET_REPLACEMENT_CLASS = "framexml-world-replaces-pet";
const NATIVE_PARTY_REPLACEMENT_CLASS = "framexml-world-replaces-party";
const NATIVE_CHAT_REPLACEMENT_CLASS = "framexml-world-replaces-chat";
const NATIVE_FOCUS_REPLACEMENT_CLASS = "framexml-world-replaces-focus";
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
  "PlayerFrame",
  "CastingBarFrame",
  "BuffFrame",
  "MinimapCluster",
  "Minimap",
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
    [achievement, "OnClick", () => {}],
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
  // PLAYER_ENTERING_WORLD/UNIT_PORTRAIT_UPDATE path is the authored portrait-update hook. The
  // bridge does not fabricate a texture when SetPortraitTexture is unavailable.
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
 * The live minimap remains the fallback owner for the clock, tracking and world-map actions. Once
 * its canvas is borrowed by the authored Minimap frame, only the native map/labels and duplicate
 * zoom/rotate buttons are suppressed. The child selector is intentional: a global #minimap-canvas
 * rule would hide the same canvas after adoption, when it is a child of FrameXML's Minimap slot.
 */
const NATIVE_MINIMAP_DUPLICATE_HIDE_SELECTOR = [
  "#right-rail > #minimap > #minimap-canvas",
  "#right-rail > #minimap > .minimap-zone",
  "#right-rail > #minimap > .minimap-subzone",
  '#right-rail > #minimap > .minimap-controls > .minimap-button[aria-label="Отдалить"]',
  '#right-rail > #minimap > .minimap-controls > .minimap-button[aria-label="Приблизить"]',
  '#right-rail > #minimap > .minimap-controls > .minimap-button[aria-label="Вращать карту по направлению взгляда"]',
].map((selector) => `body.${NATIVE_LANES_REPLACEMENT_CLASS} ${selector}`).join(",\n");

/** Stock FrameXML has no live tracking/world-map bridge in this vertical; retain the native actions. */
const DEAD_FRAMEXML_MINIMAP_CONTROL_HIDE_SELECTOR = [
  "MiniMapTracking",
  "MiniMapWorldMapButton",
].map((name) => `#${HOST_ID} [data-framexml-name="${name}"]`).join(",\n");

/** The chat form/input stays native; only the mounted log and tab strip are display-owned. */
const NATIVE_CHAT_HIDE_SELECTOR = ["chat-tabs", "chat-log"]
  .map((id) => `body.${NATIVE_CHAT_REPLACEMENT_CLASS} #${id}`)
  .join(",\n");
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

function setNativePartyReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_PARTY_REPLACEMENT_CLASS, active);
}

function setNativeChatReplacementActive(active: boolean): void {
  document.body.classList.toggle(NATIVE_CHAT_REPLACEMENT_CLASS, active);
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
    // The bounded vertical can carry the stock GameMenuFrame without pulling in the entire
    // options-panel chain. IsOptionFrameOpen() nevertheless dereferences InterfaceOptionsFrame
    // unconditionally, so provide the real hidden GameMenuFrame as a temporary, VM-local alias
    // when that optional frame is absent. The wrapper below installs it only around each stock
    // click/hide and restores nil immediately, keeping the optional global out of the VM lifecycle.
    // The menu is also the compatibility proxy for MerchantFrame/StackSplitFrame below, so it
    // must remain hidden: a visible proxy would make the stock right-click handler take its
    // merchant branch instead of the ordinary UseContainerItem path.
    if (gameMenu.visible) return undefined;
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
    if ((!interfaceOptions && interfaceOptionsGlobal !== undefined)
      || (!bank && bankGlobal !== undefined)
      || (!merchant && merchantGlobal !== undefined)
      || (!stackSplit && stackSplitGlobal !== undefined)) return undefined;

    const aliases: readonly (readonly [string, FrameXmlFrame])[] = [
      ...(!interfaceOptions && interfaceOptionsGlobal === undefined
        ? [["InterfaceOptionsFrame", gameMenu] as const] : []),
      // ContainerFrame_GenerateFrame always asks BankFrame:IsShown() while placing a bag. The
      // optional bank vertical is not owned here, so the hidden GameMenuFrame is the exact same
      // no-bank answer until BankFrame.xml is loaded; no synthetic visible panel is introduced.
      ...(!bank && bankGlobal === undefined
        ? [["BankFrame", gameMenu] as const] : []),
    ];
    // ContainerFrameItemButton_OnClick unconditionally calls MerchantFrame:IsShown() on a
    // right-click and StackSplitFrame:Hide() after UseContainerItem. The bag closure intentionally
    // does not load merchant/stack-split UI, so keep the real frames when available and otherwise
    // expose the already-created hidden GameMenuFrame for the entire owner lifetime. This is not a
    // fake test alias: it is installed in the production VM before owner publication and removed
    // by owner.dispose() on controller unpublish or any later mount failure.
    const lifetimeAliases: readonly (readonly [string, FrameXmlFrame])[] = [
      ...(merchantGlobal === undefined
        ? [["MerchantFrame", merchant ?? gameMenu] as const] : []),
      ...(stackSplitGlobal === undefined
        ? [["StackSplitFrame", stackSplit ?? gameMenu] as const] : []),
    ];
    const clearGlobals = (installed: readonly (readonly [string, FrameXmlFrame])[]): void => {
      for (const [name] of [...installed].reverse()) {
        try { boot.vm.setGlobal(name, undefined); } catch { /* best-effort lifecycle cleanup */ }
      }
    };
    const withBagGlobals = <T>(operation: () => T): T => {
      if (aliases.length === 0) return operation();
      const installed: Array<readonly [string, FrameXmlFrame]> = [];
      try {
        for (const alias of aliases) {
          boot.vm.setGlobal(alias[0], alias[1]);
          installed.push(alias);
        }
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
      for (const alias of lifetimeAliases) {
        boot.vm.setGlobal(alias[0], alias[1]);
        installed.push(alias);
      }
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
        () => withBagGlobals(() => boot.bridge.Click(frame, "LeftButton", false)),
        `click ${frame.name}`,
      )) {
        throw new Error(`cannot click ${frame.name}`);
      }
    };
    const close = (): void => {
      const closed = checkedMutation(() => withBagGlobals(() => {
        let ok = true;
        for (const frame of containers) {
          if (frame.visible && !boot.bridge.Hide(frame)) ok = false;
        }
        return ok;
      }), "hide");
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
      "merchantItemCostInfo", "merchantItemCostItem", "buybackNumItems", "buybackItemInfo",
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
 */
export function createLazyFrameXmlTalentOwner(
  seam: FrameXmlWorldSeam,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  onFailure?: () => void,
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
  };

  const fail = (): void => {
    if (disposed || failed) return;
    failed = true;
    onFailure?.();
  };
  const load = async (ticket: number): Promise<void> => {
    let result;
    try {
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
      ["SpellBookFrameTabButton1", "CheckButton"],
      ["SpellBookFrameTabButton2", "CheckButton"],
      ["SpellBookFrameTabButton3", "CheckButton"],
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
    // outdoor/Wintergrasp manager events on load; unregister all of them while it remains hidden
    // so queue status cannot accidentally drive an unsupported dialog path.
    if (battlefieldFrame) {
      const bridge = boot.bridge as typeof boot.bridge & {
        UnregisterAllEvents?: (frame: FrameXmlFrame) => boolean;
      };
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
${NATIVE_MINIMAP_DUPLICATE_HIDE_SELECTOR} { display: none !important; }
${DEAD_FRAMEXML_MINIMAP_CONTROL_HIDE_SELECTOR} { display: none !important; }
${NATIVE_CHAT_HIDE_SELECTOR} { display: none !important; }
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
  overflow: hidden;
  /* The mounted vertical is a transparent overlay except for authored controls; a host that ate
     clicks would take click-to-target away from the world canvas underneath. */
  pointer-events: none;
  color: #ffd100;
  font-family: "Segoe UI", system-ui, sans-serif;
}
#${HOST_ID}, #${HOST_ID} * { box-sizing: border-box; }
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
/* The fallback clock/tracking/world-map controls stay in the native rail, below the 192-unit
   FrameXML cluster, so the two owners never stack on top of one another. The 25vh term follows the
   stage's 192/768 scale and the 10px term leaves a small physical gap at every viewport height. */
body.${NATIVE_LANES_REPLACEMENT_CLASS} #right-rail > #minimap { margin-top: calc(25vh + 10px); }
`;

const TARGET_CONTEXT_CSS = `${NATIVE_TARGET_CONTEXT_HIDE_SELECTOR} { display: none !important; }`;
const PET_CSS = `${NATIVE_PET_HIDE_SELECTOR} { display: none !important; }`;
const PARTY_CSS = `${NATIVE_PARTY_HIDE_SELECTOR} { display: none !important; }`;

/** The 768-unit logical screen the client lays its interface out in; `GlueRuntime.ts`'s number. */
const LOGICAL_HEIGHT = 768;

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
  readonly addonsOnly?: boolean;
  diagnosticCleanup?: () => void;
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
  focusPortraitCleanup?: () => void;
  targetOfTargetPortraitCleanup?: () => void;
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
  questOwner?: FrameXmlQuestOwner;
  questOwnerCleanup?: () => void;
  nativeQuestLogState?: QuestLogNativeState;
  questOwnerDemoted?: boolean;
  petPortraitCleanup?: () => void;
  partyPortraitCleanups?: readonly (() => void)[];
  nativeChatLogState?: NativeChatLogState;
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
  if (pendingMount === record) pendingMount = undefined;
  bestEffortCleanup(() => window.removeEventListener("resize", record.resize));
  bestEffortCleanup(() => record.boot.close());
  bestEffortCleanup(() => record.host.remove());
  bestEffortCleanup(() => record.style.remove());
}

function cleanupPublishedMount(record: FrameXmlMountResources): void {
  bestEffortCleanup(() => record.models?.dispose());
  bestEffortCleanup(() => record.addonLayerCleanup?.());
  bestEffortCleanup(() => record.nativeTooltipCleanup?.());
  bestEffortCleanup(() => record.diagnosticCleanup?.());
  bestEffortCleanup(() => record.addonEntrypointsCleanup?.());
  const published = mounted === record;
  if (mounted === record) mounted = undefined;
  if (record.frame !== undefined) {
    bestEffortCleanup(() => window.cancelAnimationFrame(record.frame!));
  }
  if (record.addonsOnly) {
    bestEffortCleanup(() => record.talentOwnerCleanup?.());
    bestEffortCleanup(() => window.removeEventListener("resize", record.resize));
    bestEffortCleanup(() => record.renderer?.destroy());
    bestEffortCleanup(() => record.seam.detach());
    bestEffortCleanup(() => record.boot.close());
    bestEffortCleanup(() => record.host.remove());
    bestEffortCleanup(() => record.style.remove());
    return;
  }
  // Release the optional chat display lane before any renderer/VM teardown.  Native form/input
  // ownership never moved, so only the log's scroll semantics need restoration.
  bestEffortCleanup(() => setNativeChatReplacementActive(false));
  if (record.nativeChatLogState) {
    // Rebuild the native dock only after its lane is visible again, then restore the state that was
    // present before adoption.  This keeps both exact scroll offsets and the at-bottom behaviour.
    bestEffortCleanup(() => redrawChatLog());
    bestEffortCleanup(() => restoreNativeChatLogState(record.nativeChatLogState!));
  }
  bestEffortCleanup(() => setNativeLanesReplacementActive(false));
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
  // Unpublish the stock PvP summary before destroying its VM.  ArenaWindow is a separate native
  // owner and is intentionally not touched here.
  bestEffortCleanup(() => record.pvpOwnerCleanup?.());
  if (!record.pvpOwnerCleanup) bestEffortCleanup(() => record.pvpOwner?.hide());
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
  bestEffortCleanup(() => setNativePartyReplacementActive(false));
  if (published) bestEffortCleanup(() => showAuras());
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
  bestEffortCleanup(() => record.focusPortraitCleanup?.());
  bestEffortCleanup(() => record.targetOfTargetPortraitCleanup?.());
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
  /** Ordinary world: run our TSWoW modules over the native UI. */
  readonly addonsOnly?: boolean;
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
  if (pendingMount) cleanupPendingMount(pendingMount);
  if (!viewport) return { ok: false, message: "нет #world-viewport" };
  const origin = game.gatewayOrigin ?? defaultGatewayOrigin(window.location);
  // PVPBattlegroundFrame_OnLoad reads GetNumBattlegroundTypes immediately. Load the complete
  // catalog before boot so a temporary empty callback cannot hide tab 2 and strand the owner.
  const battlegrounds = options.battlegrounds ?? (options.seam ? undefined : new FrameXmlBattlegroundClient(origin));
  if (battlegrounds) await battlegrounds.load();
  const clientAddons = options.seam || options.addonsOnly
    ? []
    : await fetchFrameXmlClientAddons(origin).catch((error) => {
      console.warn(`Client add-on list is unavailable: ${String(error)}`);
      return [];
    });
  if (epoch !== mountEpoch) return { ok: false, message: "FrameXML монтаж отменён" };

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
    const scale = height / LOGICAL_HEIGHT;
    stage.style.width = `${Math.round(width / (scale || 1))}px`;
    stage.style.height = `${LOGICAL_HEIGHT}px`;
    stage.style.transform = `scale(${scale})`;
  };
  fit();
  window.addEventListener("resize", fit);

  // Keep the FrameXML metadata object stable between reads. The resolver is intentionally cached,
  // so recreating this adapter for every C-API getter would turn one talent repaint into a full
  // tree rebuild. Its revision advances when TalentClient or spell-name metadata changes.
  let cachedTalentClient: typeof game.talentData;
  let cachedTalentPacket: WorldClient["talents"];
  let cachedTalentSpells = -1;
  let cachedTalentMetadata: FrameXmlTalentMetadata | undefined;
  let requestedTalentClient: typeof game.talentData;
  let requestedTalentPacket: WorldClient["talents"];
  const readTalentMetadata = (): FrameXmlTalentMetadata | undefined => {
    const client = game.talentData;
    const packet = game.world?.talents;
    const spellCount = game.spells.size;
    if (!client) return undefined;
    if (client === cachedTalentClient && packet === cachedTalentPacket
      && spellCount === cachedTalentSpells && cachedTalentMetadata !== undefined) {
      return cachedTalentMetadata;
    }
    cachedTalentClient = client;
    cachedTalentPacket = packet;
    cachedTalentSpells = spellCount;
    const learned = new Map<number, number>();
    const active = packet?.specs[packet.activeSpec];
    for (const rank of active?.talents ?? []) learned.set(rank.talentId, rank.rank);
    cachedTalentMetadata = {
      ready: client.ready,
      revision: client.revision * 1_000_000 + spellCount,
      tabsForClass: (classId) => client.tabsForClass(classId),
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
    const client = game.talentData;
    if (!client?.ready) return;
    if (client === requestedTalentClient && packet === requestedTalentPacket) return;
    const ids = new Set<number>();
    const active = packet?.specs[packet.activeSpec];
    const world = game.world;
    const self = world?.state.selfGuid === undefined ? undefined
      : world.state.objects.get(world.state.selfGuid);
    const classId = self === undefined ? undefined : unit.classId(self);
    if (classId === undefined) return;
    // Do not mark this packet as requested until the player identity is available. EnterWorld can
    // expose TalentClient before the first object update; a later tick must retry the same packet.
    requestedTalentClient = client;
    requestedTalentPacket = packet;
    for (const entry of client.tabsForClass(classId).flatMap((tab) => client.talentsIn(tab.id))) {
      ids.add(entry.ranks[0] ?? 0);
      const rank = active?.talents.find((value) => value.talentId === entry.id)?.rank ?? 0;
      if (rank > 0) ids.add(entry.ranks[rank - 1] ?? 0);
    }
    ensureSpellNames([...ids].filter((id) => id > 0));
  };

  const seam = options.seam ?? new LiveWorldSeam({
    world: () => game.world,
    store: () => game.store,
    spell: (id) => game.spells.get(id),
    focusGuid: () => game.focusGuid,
    reaction: (self, target) => reactionBetween(self, target, game.factions),
    reputation: frameXmlLiveReputationRows,
    skillMetadata: () => game.talentData,
    talentMetadata: readTalentMetadata,
    talentMetadataRevision: () => {
      ensureTalentSpellNames();
      return (game.talentData?.revision ?? 0) * 1_000_000 + game.spells.size;
    },
    battlegroundCatalog: () => battlegrounds?.catalog,
    monotonic: () => performance.now(),
    globalCooldownUntil: () => game.globalCooldownUntil,
    castSpell,
    ...(() => {
      const resolvers = createFrameXmlSpellBookTabResolvers(() => ({
        world: game.world,
        talent: game.talentData,
        spells: game.spells,
      }));
      return {
        spellTabs: resolvers.spellTabs,
        spellTabFor: resolvers.spellTabFor,
      };
    })(),
    settingsCVar: createFrameXmlSettingsCVar({
      getSettings: settings,
      setSetting,
    }),
    sendChatMessage: (text, type, _language, target) => game.world?.sendChat(type, text, target),
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
  let microButtonAdaptersInstalled = false;
  // Bind this FrameXML generation to the WorldClient that owns the mount. A later world replaces
  // the whole mount; keeping the registry object here prevents a half-old Lua VM from sending on a
  // newly assigned `game.world`, and FrameXmlBoot.close removes every raw subscription it creates.
  const clientNetwork = game.world?.customPackets;
  const logicalScreen = (): { width: number; height: number } => ({
    width: Math.round((host.clientWidth || window.innerWidth)
      / ((host.clientHeight || window.innerHeight) / LOGICAL_HEIGHT || 1)),
    height: LOGICAL_HEIGHT,
  });
  const boot = new FrameXmlBoot({
    provider: createHttpFileProvider({ gatewayOrigin: origin }),
    locale: clientLocale(),
    installedAddons: clientAddons.map((addon) => addon.name),
    eagerAddons: clientAddons.filter((addon) => !addon.loadOnDemand).map((addon) => addon.name),
    subset: FRAMEXML_VERTICAL_TOC,
    // Keep the bounded stock HUD, but append the generated lib/module blocks exactly as authored
    // by the winning FrameXML.toc so TSWoW interface patches execute in the production VM.
    includeActiveTsAddons: true,
    ...(clientNetwork === undefined ? {} : { clientNetwork }),
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS,
    seam,
    minimapAdapter: minimapWidgetAdapter,
    // The stock row's OnEvent code assumes every optional Blizzard panel exists. Hide it and
    // replace its click/event handlers in the boot's after-corpus/before-exercise seam, before
    // PLAYER_ENTERING_WORLD can dispatch UpdateMicroButtons and before the stage is published.
    beforeExercise: (loadedBoot) => {
      hideFrameXmlMicroButtons(loadedBoot);
      if (options.addonsOnly) return;
      microButtonAdaptersInstalled = installFrameXmlMicroButtonAdapters(loadedBoot, {
        character: toggleFrameXmlCharacter,
        spellbook: toggleFrameXmlSpellBook,
        talent: toggleFrameXmlTalent,
        quest: toggleFrameXmlQuest,
        socials: toggleSocialPanel,
        pvp: toggleFrameXmlPvp,
        lfd: toggleLfgWindow,
        gameMenu: toggleGameMenu,
        help: () => { for (const line of helpLines()) systemLine(line); },
      }) !== undefined;
    },
    screen: logicalScreen,
    lua: {
      onPrint: systemLine,
      onError: (message) => { console.error("[framexml lua]", message); systemLine(`TSWoW Lua: ${message}`); },
    },
  });
  // Addons size themselves during Lua loading, before any DOM frame exists. UIParent must
  // already report the logical viewport; later widgets can use actual unscaled layout sizes.
  let geometryRenderer: FrameXmlDomRenderer | undefined;
  boot.bridge.setMeasure((frame) => frame.name === "UIParent"
    ? logicalScreen() : geometryRenderer?.measure(frame));
  const pending: NonNullable<typeof pendingMount> = {
    host, style, boot, seam, resize: fit, cleaned: false,
  };
  pendingMount = pending;

  let inventory;
  try {
    inventory = await boot.load();
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

  const resources: FrameXmlMountResources = {
    host, style, boot, seam, resize: fit, addonsOnly: options.addonsOnly ?? false,
  };
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
    const textures = new FrameXmlTextureCache({
      resolve: textureUrl, onChange: () => boot.bridge.touch(),
    });
    const fonts = new FrameXmlFontLoader({ resolve: clientFileUrl });
    let nativeTooltipActive = false;
    const addonPresentation = options.addonsOnly
      ? new FrameXmlTsAddonPresentation(boot, () => nativeTooltipActive) : undefined;
    const syncNativeAnchors = (): void => {
      if (!addonPresentation) return;
      boot.bridge.runInMutationBatch(() => addonPresentation.syncNativeAnchors(
        stage, characterWindow, document.getElementById("minimap-canvas"), characterSheetPane,
      ));
    };
    syncNativeAnchors();
    const renderer = new FrameXmlDomRenderer(stage, {
      bridge: boot.bridge,
      textures,
      textureResolver: textureUrl,
      fontResolver: clientFileUrl,
      clock: boot.pump.now,
      createdRootParent: "UIParent",
      // Parentless Lua-created frames are not world owners by default.  World controllers promote
      // an explicitly-owned load-on-demand root with renderer.addRoots() after its gate; keeping the
      // renderer's glue default enabled preserves GlueXML's historical dynamic roots elsewhere.
      includeCreatedRoots: options.addonsOnly ?? false,
      ...(addonPresentation ? {
        frameFilter: addonPresentation.includes,
        layoutOnly: addonPresentation.layoutOnly,
      } : {}),
      fontLoader: (file, family) => {
        void fonts.load(file, family).then(() => boot.bridge.touch());
      },
    });
    resources.renderer = renderer;
    geometryRenderer = renderer;
    renderer.registerFonts(boot.bridge.fontStyles);
    renderer.mount(options.addonsOnly ? boot.roots.filter((frame) => !frame.parent)
      : selectFrameXmlWorldRoots(boot.roots, boot.addonRootNames));

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
      const step = (): void => {
        if (mounted !== current) return;
        const now = boot.pump.now();
        const elapsed = Math.min(0.25, Math.max(0, now - previous));
        boot.bridge.runInMutationBatch(() => {
          syncNativeAnchors();
          seam.tick(now);
          boot.bridge.tick(elapsed);
        });
        previous = now;
        renderer.tickCooldowns(now);
        resources.models?.frame(elapsed, performance.now());
        current.frame = window.requestAnimationFrame(step);
      };
      host.style.visibility = "visible";
      (host as HTMLElement & { inert?: boolean }).inert = false;
      host.setAttribute("aria-hidden", "false");
      current.frame = window.requestAnimationFrame(step);
      const diagnostic = (): unknown => ({ ...inventory, tsAddons: boot.tsAddonResults, errors: boot.errors, addonsOnly: true });
      Object.defineProperty(window, "frameXmlWorld", {
        configurable: true,
        value: diagnostic,
      });
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

    // Character and spellbook deliberately stay native production owners.  Talents are different:
    // a winning TSWoW TOC may have eagerly replaced the standard ToggleTalentFrame hook. Capture
    // that already-patched function and require its exact UniversalTalentFrame root; never load the
    // competing stock Blizzard_TalentUI owner on this path.
    const patchedTalentOwner = createPatchedFrameXmlTalentOwner(
      boot, renderer, hideTalentsWindow, () => demotePublishedTalent(resources),
    );
    if (patchedTalentOwner) resources.talentOwner = patchedTalentOwner;

    // Blizzard_TrainerUI is LoD. Keep its native browser panel as the fallback while the
    // asynchronous add-on load and exact tree gate are in flight.
    resources.trainerOwner = createLazyFrameXmlTrainerOwner(
      seam, boot, renderer, () => demotePublishedTrainer(resources), () => game.world ?? seam,
    );
    resources.nativeTrainerWasHidden = trainerWindow.hidden;

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
    }

    let previous = boot.pump.now();
    const step = (): void => {
      if (!mounted) return;
      const now = boot.pump.now();
      const elapsed = Math.min(0.25, Math.max(0, now - previous));
      previous = now;
      seam.tick(now);
      boot.bridge.tick(elapsed);
      renderer.tickCooldowns(now);
      mounted.frame = window.requestAnimationFrame(step);
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
    if (resources.trainerOwner) {
      resources.trainerOwnerCleanup = publishFrameXmlTrainer(resources.trainerOwner);
      if (game.world?.trainer && !resources.trainerOwner.isOpen()) resources.trainerOwner.show();
    }
    if (resources.pvpOwner) {
      resources.pvpOwnerCleanup = publishFrameXmlPvp(resources.pvpOwner);
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
        // The stock SpellBookFrame's live skill-line tabs are the honest owner for the native J
        // action; no second handcrafted professions panel is introduced here.
        professions: !!resources.spellbookFrame,
        // MainMenuMicroButton opens the real native GameMenu, which already owns diagnostics.
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
    // All gates and owner/class publications above are complete.  Reveal the already-laid-out
    // stage as one final commit so native fallback and FrameXML never flash as a mixed owner.
    host.style.visibility = "visible";
    (host as HTMLElement & { inert?: boolean }).inert = false;
    host.setAttribute("aria-hidden", "false");
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
    const diagnostic = (): unknown => ({ ...inventory, numbers, cooldownWidgets: renderer.cooldownCount });
    Object.defineProperty(window, "frameXmlWorld", {
      configurable: true,
      value: diagnostic,
    });
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
    setNativePartyReplacementActive(false);
    setNativeBagsReplacementActive(false);
    setNativeCharacterReplacementActive(false);
    setNativeMicroButtonsReplacementActive(false);
  }
}

// Context owns the world lifetime while this optional module owns the actual overlay resources.
// Registration keeps cleanup synchronous once the module has been loaded, without making the
// default front door import FrameXML eagerly.
registerWorldContextCleanup(unmountFrameXmlVertical);
