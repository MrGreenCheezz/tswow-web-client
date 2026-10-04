/**
 * The stock Video/Audio/Interface options over this client's settings: what the stock panels may
 * change, what they may not, and the «WebClient» category for the settings they have no control for.
 *
 * Three kinds of stock control, classified against the MPQ corpus (every control's CVar and uvar
 * searched in the vertical's Lua and XML handlers and in the LoD add-ons this host loads):
 *
 * - a **browser setting** — FrameXmlSettingsCVar.ts maps its CVar (volumes and their switches,
 *   glow, grass radius, interface size, loot, bubbles, plates, floating text, minimap rotation) or
 *   GetActionBarToggles/SetActionBarToggles below carries it (the four extra bars). Reads and writes
 *   go through the one settings model, persisted with the character like the native window's;
 * - a **stock-consumed session value** — no browser setting, but stock Lua this VM runs reads it
 *   (target of target, status texts, buff durations, quest tracking, the talent preview…). The
 *   neutral CVar map keeps it, FrameXmlCVarPersistence.ts stores it in this browser (3.19), and the
 *   control says so in its tooltip;
 * - **unavailable** — nothing here reads it (display modes, driver and effect detail, voice, camera
 *   and mouse tuning, name/nameplate granularity, combat-text details, server-side toggles with no
 *   packet). The control is disabled the way the client greys out unsupported hardware, with the
 *   reason in its tooltip, and never writes a value nothing would read.
 *
 * Every browser setting without a stock control is a control of the stock-style «WebClient»
 * category (InterfaceOptions_AddCategory), bound to its `webclient_` CVar, so nothing the native
 * settings window offered is lost.
 */

import { SETTING_GROUPS, settingDefinition, type SettingGroup } from "../ui/SettingsModel.js";
import { sectionSettings } from "../ui/SettingsSections.js";
import {
  FRAME_XML_SETTINGS_CVARS, FRAME_XML_WEBCLIENT_CVARS, type FrameXmlSettingsCVarAdapter,
} from "./FrameXmlSettingsCVar.js";
import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";
import { FRAMEXML_HOST_HOOK_GLOBAL } from "./FrameXmlHostHooks.js"; // L5b 3.27

/** The options C API the settings model answers (the CVar family itself is the seam's). */
export interface FrameXmlOptionsModel {
  /** `GetCVarMin`/`GetCVarMax`: a mapped numeric CVar's clamp, in CVar units. */
  cvarRange(name: string): readonly [min: number, max: number] | undefined;
  /** `GetActionBarToggles()`: bottom left, bottom right, right, right two. */
  actionBarToggles(): readonly [boolean, boolean, boolean, boolean];
  /**
   * `SetActionBarToggles(b1, b2, b3, b4, alwaysShow)`: the four bars. The settings write only what
   * changed; the server gets the byte on every call, as Wow.exe 0x5a8290 sends it.
   */
  setActionBarToggles(bars: readonly [boolean, boolean, boolean, boolean]): void;
  /** `RestoreVideoEffectsDefaults()`: every mapped name back to its default; writes only what differs. */
  restoreDefaults(names: readonly string[]): void;
}

const ACTION_BAR_CVARS = ["bottomLeftActionBar", "bottomRightActionBar", "rightActionBar", "rightTwoActionBar"] as const;

/**
 * The server copy of the extra bars (plan item 3.32): the core keeps them in `PLAYER_FIELD_BYTES`
 * byte 2 and takes them from `CMSG_SET_ACTIONBAR_TOGGLES`, so they follow the character to any
 * browser. Wow.exe's `GetActionBarToggles` (0x5a8790) reads only that byte.
 */
export interface FrameXmlActionBarServer {
  /** The byte's four bits (bit 0 bottom left … bit 3 right two); undefined before the player's fields arrive. */
  toggles(): number | undefined;
  /** Sends `CMSG_SET_ACTIONBAR_TOGGLES` with those four bits. */
  send(bars: number): void;
}

/** The four booleans as the packet's bits: bottom left 0x01, bottom right 0x02, right 0x04, right two 0x08. */
export function actionBarToggleBits(bars: readonly [boolean, boolean, boolean, boolean]): number {
  return (bars[0] ? 0x01 : 0) | (bars[1] ? 0x02 : 0) | (bars[2] ? 0x04 : 0) | (bars[3] ? 0x08 : 0);
}

/**
 * `server` absent (the canned seam, a test): the browser settings alone, as before. Present: the
 * server's byte answers once it is known — at world entry the stock Action Bars panel copies it into
 * its uvars and calls SetActionBarToggles, which writes the settings the native bars follow — and
 * the settings stand in until then.
 */
export function createFrameXmlOptionsModel(
  cvars: FrameXmlSettingsCVarAdapter, server?: FrameXmlActionBarServer,
): FrameXmlOptionsModel {
  const settingsBars = (): [boolean, boolean, boolean, boolean] => [
    cvars.get(ACTION_BAR_CVARS[0]) === "1", cvars.get(ACTION_BAR_CVARS[1]) === "1",
    cvars.get(ACTION_BAR_CVARS[2]) === "1", cvars.get(ACTION_BAR_CVARS[3]) === "1",
  ];
  const bars = (): [boolean, boolean, boolean, boolean] => {
    const bits = server?.toggles();
    if (bits === undefined) return settingsBars();
    return [(bits & 0x01) !== 0, (bits & 0x02) !== 0, (bits & 0x04) !== 0, (bits & 0x08) !== 0];
  };
  return {
    cvarRange: (name) => cvars.range(name),
    actionBarToggles: bars,
    setActionBarToggles: (next) => {
      const current = settingsBars();
      ACTION_BAR_CVARS.forEach((cvar, index) => {
        if (current[index] !== next[index]) cvars.set(cvar, next[index] ? "1" : "0");
      });
      // Only once the server's byte is known: before it, a send would put this browser's settings
      // over the character's own bars (in the client the field always precedes the Lua call).
      if (server && server.toggles() !== undefined) server.send(actionBarToggleBits(next));
    },
    restoreDefaults: (names) => {
      for (const name of names) {
        const value = cvars.getDefault(name);
        if (value !== undefined && cvars.get(name) !== value) cvars.set(name, value);
      }
    },
  };
}

/**
 * The Effects panel's CVars (EffectsPanelOptions, VideoOptionsPanels.lua), all of which the client's
 * RestoreVideoEffectsDefaults resets. The adapter answers a default for the mapped three — the
 * environment detail, the grass radius and the glow; the rest are unavailable controls whose
 * values nothing here reads.
 */
const VIDEO_EFFECTS_CVARS: readonly string[] = Object.freeze([
  "farclip", "TerrainMip", "particleDensity", "environmentDetail", "groundEffectDensity", "groundEffectDist",
  "BaseMip", "extShadowQuality", "textureFilteringMode", "weatherDensity", "componentTextureLevel",
  "specular", "ffxGlow", "ffxDeath", "projectedTextures",
]);

const NOTHING: readonly unknown[] = Object.freeze([]);

function nameOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A C truthiness test: InterfaceOptions_UpdateMultiActionBars turns every "0" into nil first. */
function shownOf(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "0";
}

/**
 * Unbound, all of these answered nil from the stub floor: GetCVarMin/Max left every slider on its
 * panel table's range, and GetActionBarToggles made the Action Bars panel read four unchecked
 * boxes whatever the bars showed. Without a model (a seam with no settings) they still answer nil.
 */
export const FRAMEXML_OPTIONS_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  GetCVarMin: (seam, args) => {
    const range = seam.options?.cvarRange(nameOf(args[0]));
    return range ? [range[0]] : NOTHING;
  },
  GetCVarMax: (seam, args) => {
    const range = seam.options?.cvarRange(nameOf(args[0]));
    return range ? [range[1]] : NOTHING;
  },
  GetActionBarToggles: (seam) => seam.options ? [...seam.options.actionBarToggles()] : NOTHING,
  SetActionBarToggles: (seam, args) => {
    seam.options?.setActionBarToggles([shownOf(args[0]), shownOf(args[1]), shownOf(args[2]), shownOf(args[3])]);
    return NOTHING;
  },
  // VideoOptionsEffectsPanel_Default resets the panel through this call alone and then only clears
  // newValue: from the stub floor, «По умолчанию» left the grass radius and the glow where they were.
  // (RestoreVideoResolutionDefaults stays a stub: its panel's one mapped control, the interface size,
  // is reset by VideoOptionsResolutionPanel_Default itself.)
  RestoreVideoEffectsDefaults: (seam) => {
    seam.options?.restoreDefaults(VIDEO_EFFECTS_CVARS);
    return NOTHING;
  },
});

// ---- what the stock panels may not change --------------------------------------------------------

const BROWSER_DISPLAY = "Экраном, разрешением и частотой кадров управляет браузер.";
const NO_EFFECT = "Такой настройки у графики браузерного клиента нет; его графика — в разделе «WebClient».";
const BROWSER_SOUND = "Звуковым устройством и его обработкой управляет браузер.";
const NOT_SUPPORTED = "Браузерный клиент этого не поддерживает.";
const NO_NAMES = "Имена и таблички браузерного клиента включаются только целиком: «Таблички над врагами» и «над союзниками».";
const NO_COMBAT_TEXT = "Всплывающий текст боя браузерного клиента включается только целиком.";
// 5.14: the camera's style, speed and distance and the mouse's speeds and inversion are stock CVars now
// (FrameXmlSettingsCVar.ts); terrain tilt, head bob, water collision and smart pivot have no consumer.
const CAMERA = "Камера браузерного клиента этого не поддерживает.";

function rows(reason: string, names: readonly string[]): (readonly [string, string])[] {
  return names.map((name) => [name, reason] as const);
}

/**
 * Stock controls with no consumer in this client, by frame name, and the reason the tooltip gives.
 * Dropdowns are named by their frame; the rest are CheckButtons and Sliders.
 */
export const FRAMEXML_OPTIONS_UNAVAILABLE: ReadonlyMap<string, string> = new Map([
  ...rows(BROWSER_DISPLAY, [
    "VideoOptionsResolutionPanelResolutionDropDown", "VideoOptionsResolutionPanelRefreshDropDown",
    "VideoOptionsResolutionPanelMultiSampleDropDown", "VideoOptionsResolutionPanelVSync",
    "VideoOptionsResolutionPanelTripleBuffer", "VideoOptionsResolutionPanelHardwareCursor",
    "VideoOptionsResolutionPanelFixInputLag", "VideoOptionsResolutionPanelWindowed",
    "VideoOptionsResolutionPanelMaximized", "VideoOptionsResolutionPanelDisableResize",
    "VideoOptionsResolutionPanelDesktopGamma", "VideoOptionsResolutionPanelGammaSlider",
  ]),
  ...rows(NO_EFFECT, [
    "VideoOptionsEffectsPanelQualitySlider", "VideoOptionsEffectsPanelViewDistance",
    "VideoOptionsEffectsPanelTerrainDetail", "VideoOptionsEffectsPanelParticleDensity",
    "VideoOptionsEffectsPanelShadowQuality",
    "VideoOptionsEffectsPanelClutterDensity", "VideoOptionsEffectsPanelTextureResolution",
    "VideoOptionsEffectsPanelTextureFiltering", "VideoOptionsEffectsPanelWeatherIntensity",
    "VideoOptionsEffectsPanelPlayerTexture", "VideoOptionsEffectsPanelSpecularLighting",
    "VideoOptionsEffectsPanelDeathEffect", "VideoOptionsEffectsPanelProjectedTextures",
  ]),
  ...rows(BROWSER_SOUND, [
    "AudioOptionsSoundPanelReverb", "AudioOptionsSoundPanelHRTF", "AudioOptionsSoundPanelEnableDSPs",
    "AudioOptionsSoundPanelSoundQuality", "AudioOptionsSoundPanelHardwareDropDown",
    "AudioOptionsSoundPanelSoundChannels", "AudioOptionsSoundPanelUseHardware",
  ]),
  ...rows(NOT_SUPPORTED, [
    "AudioOptionsSoundPanelErrorSpeech", "AudioOptionsSoundPanelEmoteSounds", "AudioOptionsSoundPanelPetSounds",
    "AudioOptionsSoundPanelLoopMusic", "AudioOptionsSoundPanelSoundInBG",
    "InterfaceOptionsControlsPanelAutoDismount",
    "InterfaceOptionsControlsPanelAutoClearAFK",
    // The loot window's own modifier is Shift (FrameXmlLootHost.ts), not the stock modified click.
    "InterfaceOptionsControlsPanelAutoLootKeyDropDown",
    // L18 5.05: AutoRange (autoRangedCombat) and StopAutoAttack (stopAutoAttackOnTargetChange) have settings
    // behind them (FrameXmlSettingsCVar.ts) and are usable; AttackOnAssist (assistAttack) has none.
    // DEC-A 3.11: AttackOnAssist has one now (the assistAttack setting, owner decision of 04.10) and is usable.
    "InterfaceOptionsCombatPanelAutoSelfCast", // L18 5.05: was also StopAutoAttack
    // UseAction's unit is not honoured by the host (LiveWorldSeam.useAction casts the slot's spell).
    "InterfaceOptionsCombatPanelSelfCastKeyDropDown", "InterfaceOptionsCombatPanelFocusCastKeyDropDown",
    "InterfaceOptionsDisplayPanelShowCloak", "InterfaceOptionsDisplayPanelShowHelm",
    "InterfaceOptionsDisplayPanelDetailedLootInfo", "InterfaceOptionsDisplayPanelAggroWarningDisplay",
    "InterfaceOptionsDisplayPanelPlayAggroSounds", "InterfaceOptionsDisplayPanelShowItemLevel",
    "InterfaceOptionsDisplayPanelCinematicSubtitles",
    "InterfaceOptionsSocialPanelProfanityFilter", "InterfaceOptionsSocialPanelPartyChat",
    "InterfaceOptionsSocialPanelSpamFilter", "InterfaceOptionsSocialPanelChatHoverDelay",
    "InterfaceOptionsSocialPanelGuildMemberAlert", "InterfaceOptionsSocialPanelGuildRecruitment",
    "InterfaceOptionsSocialPanelChatStyle",
    "InterfaceOptionsActionBarsPanelSecureAbilityToggle",
    "InterfaceOptionsUnitFramePanelRaidRange", "InterfaceOptionsUnitFramePanelArenaEnemyFrames",
    "InterfaceOptionsUnitFramePanelArenaEnemyCastBar", "InterfaceOptionsUnitFramePanelArenaEnemyPets",
    "InterfaceOptionsFeaturesPanelEquipmentManager",
    "InterfaceOptionsHelpPanelShowTutorials", "InterfaceOptionsHelpPanelLoadingScreenTips",
    "InterfaceOptionsHelpPanelShowLuaErrors", "InterfaceOptionsLanguagesPanelLocaleDropDown",
  ]),
  ...rows(NO_NAMES, [
    "InterfaceOptionsCombatPanelNameplateClassColors", "InterfaceOptionsCombatPanelEnemyCastBarsOnNameplates",
    "InterfaceOptionsNamesPanelMyName", "InterfaceOptionsNamesPanelNPCNames",
    "InterfaceOptionsNamesPanelNonCombatCreature", "InterfaceOptionsNamesPanelGuilds",
    "InterfaceOptionsNamesPanelTitles", "InterfaceOptionsNamesPanelFriendlyPlayerNames",
    "InterfaceOptionsNamesPanelFriendlyPets", "InterfaceOptionsNamesPanelFriendlyGuardians",
    "InterfaceOptionsNamesPanelFriendlyTotems", "InterfaceOptionsNamesPanelEnemyPlayerNames",
    "InterfaceOptionsNamesPanelEnemyPets", "InterfaceOptionsNamesPanelEnemyGuardians",
    "InterfaceOptionsNamesPanelEnemyTotems", "InterfaceOptionsNamesPanelUnitNameplatesAllowOverlap",
    "InterfaceOptionsNamesPanelUnitNameplatesFriendlyPets", "InterfaceOptionsNamesPanelUnitNameplatesFriendlyGuardians",
    "InterfaceOptionsNamesPanelUnitNameplatesFriendlyTotems", "InterfaceOptionsNamesPanelUnitNameplatesEnemyPets",
    "InterfaceOptionsNamesPanelUnitNameplatesEnemyGuardians", "InterfaceOptionsNamesPanelUnitNameplatesEnemyTotems",
  ]),
  ...rows(NO_COMBAT_TEXT, [
    "InterfaceOptionsCombatTextPanelTargetDamage", "InterfaceOptionsCombatTextPanelPeriodicDamage",
    "InterfaceOptionsCombatTextPanelPetDamage", "InterfaceOptionsCombatTextPanelHealing",
    "InterfaceOptionsCombatTextPanelTargetEffects", "InterfaceOptionsCombatTextPanelOtherTargetEffects",
    "InterfaceOptionsCombatTextPanelFCTDropDown", "InterfaceOptionsCombatTextPanelDodgeParryMiss",
    "InterfaceOptionsCombatTextPanelDamageReduction", "InterfaceOptionsCombatTextPanelRepChanges",
    "InterfaceOptionsCombatTextPanelReactiveAbilities", "InterfaceOptionsCombatTextPanelFriendlyHealerNames",
    "InterfaceOptionsCombatTextPanelCombatState", "InterfaceOptionsCombatTextPanelComboPoints",
    "InterfaceOptionsCombatTextPanelLowManaHealth", "InterfaceOptionsCombatTextPanelEnergyGains",
    "InterfaceOptionsCombatTextPanelPeriodicEnergyGains", "InterfaceOptionsCombatTextPanelHonorGains",
    "InterfaceOptionsCombatTextPanelAuras",
  ]),
  ...rows(CAMERA, [
    "InterfaceOptionsCameraPanelFollowTerrain",
    "InterfaceOptionsCameraPanelHeadBob", // L8 5.14: InterfaceOptionsCameraPanelWaterCollision drives cameraWaterCollision
    "InterfaceOptionsCameraPanelSmartPivot",
  ]),
  ...rows(NOT_SUPPORTED, [
    "InterfaceOptionsMousePanelClickToMove", "InterfaceOptionsMousePanelWoWMouse",
    "InterfaceOptionsMousePanelClickMoveStyleDropDown",
  ]),
]);

/** A disabled dropdown's text, as FrameXmlBoot.disableUnavailableOptions writes it for ruRU. */
const UNAVAILABLE_TEXT = "Недоступно";

/**
 * What the stock-consumed controls say: the neutral CVar map is kept in this browser
 * (FrameXmlCVarPersistence.ts, 3.19), not with the character on the server.
 */
export const FRAMEXML_OPTIONS_SESSION_NOTE = "Сохраняется в этом браузере.";

/** Controls whose CVar or uvar stock Lua in this VM reads, with no browser setting behind them. */
export const FRAMEXML_OPTIONS_SESSION_ONLY: readonly string[] = Object.freeze([
  "InterfaceOptionsCombatPanelEnemyCastBarsOnPortrait", "InterfaceOptionsCombatPanelTargetOfTarget",
  "InterfaceOptionsCombatPanelTOTDropDown",
  "InterfaceOptionsDisplayPanelScreenEdgeFlash", "InterfaceOptionsDisplayPanelShowFreeBagSpace",
  "InterfaceOptionsDisplayPanelShowClock", "InterfaceOptionsDisplayPanelShowAggroPercentage",
  "InterfaceOptionsDisplayPanelColorblindMode", "InterfaceOptionsDisplayPanelWorldPVPObjectiveDisplay",
  "InterfaceOptionsObjectivesPanelInstantQuestText", "InterfaceOptionsObjectivesPanelAutoQuestTracking",
  "InterfaceOptionsObjectivesPanelAutoQuestProgress", "InterfaceOptionsObjectivesPanelMapQuestDifficulty",
  "InterfaceOptionsObjectivesPanelAdvancedWorldMap", "InterfaceOptionsObjectivesPanelWatchFrameWidth",
  "InterfaceOptionsSocialPanelChatMouseScroll", "InterfaceOptionsSocialPanelTimestamps",
  "InterfaceOptionsActionBarsPanelLockActionBars", "InterfaceOptionsActionBarsPanelAlwaysShowActionBars",
  "InterfaceOptionsStatusTextPanelPlayer", "InterfaceOptionsStatusTextPanelPet",
  "InterfaceOptionsStatusTextPanelParty", "InterfaceOptionsStatusTextPanelTarget",
  "InterfaceOptionsStatusTextPanelPercentages", "InterfaceOptionsStatusTextPanelXP",
  "InterfaceOptionsUnitFramePanelPartyBackground", "InterfaceOptionsUnitFramePanelPartyInRaid",
  "InterfaceOptionsUnitFramePanelPartyPets", "InterfaceOptionsUnitFramePanelFullSizeFocusFrame",
  "InterfaceOptionsBuffsPanelBuffDurations", "InterfaceOptionsBuffsPanelDispellableDebuffs",
  "InterfaceOptionsBuffsPanelCastableBuffs", "InterfaceOptionsBuffsPanelConsolidateBuffs",
  "InterfaceOptionsBuffsPanelShowCastableDebuffs",
  "InterfaceOptionsHelpPanelEnhancedTooltips", "InterfaceOptionsHelpPanelBeginnerTooltips",
  // previewTalents: Blizzard_TalentUI's preview (FrameXmlTalentPreview.ts, 3.33).
  "InterfaceOptionsFeaturesPanelPreviewTalentChanges",
]);

/** The one stock switch whose browser answer is fixed: the interface size always applies. */
export const FRAMEXML_OPTIONS_FIXED_ON: ReadonlyMap<string, string> = new Map([
  ["VideoOptionsResolutionPanelUseUIScale", "В браузерном клиенте масштаб интерфейса действует всегда."],
]);

// ---- the «WebClient» category --------------------------------------------------------------------

export const FRAMEXML_OPTIONS_WEBCLIENT_PANEL = "InterfaceOptionsWebClientPanel";
export const FRAMEXML_OPTIONS_WEBCLIENT_NAME = "WebClient";

export interface FrameXmlOptionsWebClientControl {
  readonly cvar: string;
  readonly setting: string;
  readonly kind: "check" | "slider";
  readonly text: string;
  readonly tooltip: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** The subsection heading it is drawn under (SettingsSections.ts); absent in a group without them. */
  readonly section?: string;
}

export interface FrameXmlOptionsWebClientGroup {
  /** The panel's frame name: `InterfaceOptionsWebClient<key>Panel`. */
  readonly key: string;
  readonly name: SettingGroup;
  /** Settings of the native chat dock alone, which the stock chat hides when it takes the route. */
  readonly nativeChatOnly: boolean;
  readonly controls: readonly FrameXmlOptionsWebClientControl[];
}

const GROUP_KEYS: Readonly<Record<SettingGroup, string>> = {
  "Игра": "Game", "Графика": "Graphics", "Эффекты": "Effects", "Интерфейс": "Interface", "Звук": "Sound", "Чат": "Chat",
};

/**
 * «Чат»: the dock's height, its timestamps and its combat-log filters, read by ChatDock.ts and the
 * `#chat-log` style only. The stock ChatFrame, once it replaces that dock, reads none of them.
 */
const NATIVE_CHAT_GROUP: SettingGroup = "Чат";

/** What those controls say, greyed, while the stock chat is the one on screen. */
export const FRAMEXML_OPTIONS_NATIVE_CHAT_NOTE =
  "Только для запасного чата браузерного клиента, а на экране оригинальный чат; время у его строк — в разделе «Общение».";

/** The browser settings with no stock control, one subcategory per settings-window group. */
export function frameXmlOptionsWebClientGroups(): readonly FrameXmlOptionsWebClientGroup[] {
  const groups: FrameXmlOptionsWebClientGroup[] = [];
  for (const group of SETTING_GROUPS) {
    const controls: FrameXmlOptionsWebClientControl[] = [];
    for (const row of FRAME_XML_WEBCLIENT_CVARS) {
      const definition = settingDefinition(row.setting);
      if (!definition || definition.group !== group) continue;
      controls.push(Object.freeze({
        cvar: row.cvar,
        setting: row.setting,
        kind: definition.kind === "boolean" ? "check" as const : "slider" as const,
        text: definition.label,
        tooltip: definition.hint ?? definition.label,
        ...(definition.kind === "number" ? {
          min: definition.min ?? 0, max: definition.max ?? 100, step: definition.step ?? 1,
        } : {}),
      }));
    }
    // A long group (SettingsSections.ts) is ordered and headed by the settings window's subsections.
    const ordered = sectionSettings(group, controls, (control) => control.setting).flatMap(({ title, items }) =>
      title === undefined ? items : items.map((control) => Object.freeze({ ...control, section: title })));
    if (ordered.length > 0) {
      groups.push(Object.freeze({
        key: GROUP_KEYS[group], name: group, nativeChatOnly: group === NATIVE_CHAT_GROUP, controls: Object.freeze(ordered),
      }));
    }
  }
  return Object.freeze(groups);
}

function lua(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the «WebClient» category: a root panel with the graphics presets and one panel per group,
 * each an ordinary stock options panel (InterfaceOptionsPanel_OnLoad) of InterfaceOptionsCheckButton
 * and OptionsSlider controls bound to their `webclient_` CVars. Run while `issecure()` answers true,
 * so InterfaceOptions_AddCategory files it with the client's own categories («Игра» tab) rather than
 * with add-ons. The blizzard branch inserts a child directly after its parent, so the groups are
 * added last to first. `host` is `__fxWebClientOptions`.
 *
 * A preset is an edit like any other, which «Отмена» takes back. It lands as one settings write
 * (Settings.applySettingsPreset: one apply, not one per setting); then every control it moved reads
 * its new value but keeps the Cancel baseline the frame opened with — InterfaceOptionsPanel_Refresh
 * would record the preset as that baseline — and a setting no control of this frame carries (the
 * Video frame's glow) is put back by the category's own `cancel`, as InterfaceOptionsFrame.lua's
 * example panel does.
 */
export function frameXmlOptionsCategorySource(groups: readonly FrameXmlOptionsWebClientGroup[]): string {
  const table = groups.map((group) => `{ key = ${lua(group.key)}, name = ${lua(group.name)}, nativeChatOnly = ${group.nativeChatOnly}, controls = { ${
    group.controls.map((control) => `{ cvar = ${lua(control.cvar)}, kind = ${lua(control.kind)}, text = ${lua(control.text)}, tooltip = ${lua(control.tooltip)}${
      control.kind === "slider" ? `, min = ${control.min}, max = ${control.max}, step = ${control.step}` : ""}${
      control.section !== undefined ? `, section = ${lua(control.section)}` : ""} }`).join(", ")
  } } }`).join(",\n  ");
  const watched = [...FRAME_XML_SETTINGS_CVARS, ...FRAME_XML_WEBCLIENT_CVARS].map((row) => lua(row.cvar)).join(", ");
  return `
local host = __fxWebClientOptions
local container = InterfaceOptionsFramePanelContainer
local groups = {
  ${table}
}
-- Every CVar a browser setting stands behind: what a preset can move.
local watched = { ${watched} }
local function header(panel, title, text)
  local name = panel:GetName()
  local heading = panel:CreateFontString(name .. "Title", "ARTWORK", "GameFontNormalLarge")
  heading:SetJustifyH("LEFT")
  heading:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -16)
  heading:SetText(title)
  local sub = panel:CreateFontString(name .. "SubText", "ARTWORK", "GameFontHighlightSmall")
  sub:SetJustifyH("LEFT")
  sub:SetJustifyV("TOP")
  sub:SetWidth(360)
  sub:SetHeight(32)
  sub:SetPoint("TOPLEFT", heading, "BOTTOMLEFT", 0, -8)
  sub:SetText(text)
  return sub
end
local function whole(value)
  return string.format("%d", math.floor((tonumber(value) or 0) + 0.5))
end

local root = CreateFrame("Frame", ${lua(FRAMEXML_OPTIONS_WEBCLIENT_PANEL)}, container)
root:Hide()
root.name = ${lua(FRAMEXML_OPTIONS_WEBCLIENT_NAME)}
header(root, "WebClient", "Настройки браузерного клиента, которых нет в оригинальном интерфейсе. Меняются сразу; «Отмена» возвращает прежние значения.")
-- What a preset moved that no control of this frame carries, as it was before: [cvar] = value.
local presetOld = {}
local function applyPreset(kind)
  local before = {}
  for _, cvar in ipairs(watched) do before[cvar] = GetCVar(cvar) end
  host("preset", kind)
  local controls = {}
  for _, panel in ipairs({ container:GetChildren() }) do
    for _, control in ipairs(panel.controls or {}) do
      if control.cvar then
        local key = string.lower(control.cvar)
        controls[key] = controls[key] or {}
        table.insert(controls[key], control)
      end
    end
  end
  for _, cvar in ipairs(watched) do
    if GetCVar(cvar) ~= before[cvar] then
      local moved = controls[string.lower(cvar)]
      if moved then
        for _, control in ipairs(moved) do
          local old = control.oldValue
          BlizzardOptionsPanel_RefreshControl(control)
          control.oldValue = old
        end
      elseif presetOld[cvar] == nil then
        presetOld[cvar] = before[cvar]
      end
    end
  end
end
local previous
for index, preset in ipairs({
  { "Enhanced", "enhanced", "Улучшенная графика", "Мягкие тени, атмосферная дымка, солнечные лучи и эффекты воды. Масштаб отрисовки сохранится." },
  { "Comparison", "comparison", "Контрольный профиль графики", "Масштаб 100%, без автокачества и дополнительных эффектов; остальные настройки сохранены." },
}) do
  local button = CreateFrame("Button", root:GetName() .. preset[1], root, "UIPanelButtonTemplate")
  button:SetWidth(220)
  button:SetHeight(22)
  if previous then button:SetPoint("TOPLEFT", previous, "BOTTOMLEFT", 0, -8)
  else button:SetPoint("TOPLEFT", root, "TOPLEFT", 16, -90) end
  button:SetText(preset[3])
  button.tooltipText = preset[4]
  button:SetScript("OnClick", function(self)
    PlaySound("igMainMenuOptionCheckBoxOn")
    applyPreset(preset[2])
  end)
  button:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:SetText(self.tooltipText, nil, nil, nil, nil, 1)
  end)
  button:SetScript("OnLeave", function() GameTooltip:Hide() end)
  previous = button
end
local note = root:CreateFontString(root:GetName() .. "Storage", "ARTWORK", "GameFontNormalSmall")
note:SetJustifyH("LEFT")
note:SetWidth(360)
note:SetPoint("TOPLEFT", previous, "BOTTOMLEFT", 0, -16)
-- The frame's OnShow, and its «По умолчанию», refresh every category: a new Cancel baseline.
root.refresh = function()
  note:SetText(host("note") or "")
  presetOld = {}
end
root.okay = function() presetOld = {} end
root.cancel = function()
  for cvar, value in pairs(presetOld) do SetCVar(cvar, value) end
  presetOld = {}
end
root.refresh()
root.webclientPanels = {}
InterfaceOptions_AddCategory(root)

for group = #groups, 1, -1 do
  local spec = groups[group]
  local panel = CreateFrame("Frame", "InterfaceOptionsWebClient" .. spec.key .. "Panel", container)
  table.insert(root.webclientPanels, 1, panel)
  panel:Hide()
  panel.name = spec.name
  panel.parent = root.name
  panel.options = {}
  local about = "Настройки WebClient. Подсказка у каждой — что именно она меняет."
  local sub = header(panel, spec.name, about)
  -- One column, so a long label never runs under its neighbour's box. What does not fit the
  -- container (InterfaceOptionsFramePanelContainer, 413 x 428) scrolls in the stock
  -- UIPanelScrollFrameTemplate: «Эффекты» has grown past two columns, and the second one ran on
  -- below the frame's bottom edge, under «Окей» and off the frame, where nothing could be picked.
  local top, bottom = -72, -410
  local function extent(control) return control.kind == "slider" and 60 or 30 end
  local needed, last = 0, nil
  for _, control in ipairs(spec.controls) do
    if control.section and control.section ~= last then
      needed = needed + (last and 28 or 20)
      last = control.section
    end
    needed = needed + extent(control)
  end
  local holder, x, y = panel, 16, top
  if needed > top - bottom then
    local scroll = CreateFrame("ScrollFrame", panel:GetName() .. "Scroll", panel, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", panel, "TOPLEFT", 0, top + 4)
    scroll:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -30, 6)
    holder = CreateFrame("Frame", panel:GetName() .. "ScrollChild", scroll)
    holder:SetWidth(383)
    holder:SetHeight(needed + 8)
    scroll:SetScrollChild(holder)
    y = -4
  end
  -- A long group's subsections (SettingsSections.ts), headed the way the stock panels head theirs.
  local section, headings = nil, 0
  for index, control in ipairs(spec.controls) do
    if control.section and control.section ~= section then
      if section then y = y - 8 end
      section = control.section
      headings = headings + 1
      local heading = holder:CreateFontString(panel:GetName() .. "Heading" .. headings, "ARTWORK", "GameFontNormal")
      heading:SetJustifyH("LEFT")
      heading:SetPoint("TOPLEFT", holder, "TOPLEFT", x, y - 2)
      heading:SetText(section)
      y = y - 20
    end
    local height = extent(control)
    local name = panel:GetName() .. index
    if control.kind == "check" then
      local check = CreateFrame("CheckButton", name, holder, "InterfaceOptionsCheckButtonTemplate")
      check:SetPoint("TOPLEFT", holder, "TOPLEFT", x, y)
      check.type = CONTROLTYPE_CHECKBOX
      check.cvar = control.cvar
      BlizzardOptionsPanel_RegisterControl(check, panel)
      panel.options[control.cvar] = { text = control.text, tooltip = control.tooltip }
    else
      local slider = CreateFrame("Slider", name, holder, "OptionsSliderTemplate")
      slider:SetWidth(240)
      slider:SetPoint("TOPLEFT", holder, "TOPLEFT", x + 6, y - 20)
      slider.type = CONTROLTYPE_SLIDER
      slider.cvar = control.cvar
      slider.label = control.text
      _G[name .. "Low"]:SetText(whole(control.min))
      _G[name .. "High"]:SetText(whole(control.max))
      -- BlizzardOptionsPanel_Slider_OnValueChanged's live write, after the panel's own setup:
      -- SetMinMaxValues clamps the fresh slider and fires this before the value has been read.
      slider:SetScript("OnValueChanged", function(self, value)
        self.value = value
        if self.webclientReady then BlizzardOptionsPanel_SetCVarSafe(self.cvar, value) end
        _G[self:GetName() .. "Text"]:SetText(self.label .. ": " .. whole(value))
      end)
      BlizzardOptionsPanel_RegisterControl(slider, panel)
      panel.options[control.cvar] = {
        text = control.text, tooltip = control.tooltip,
        minValue = control.min, maxValue = control.max, valueStep = control.step,
      }
    end
    y = y - height
  end
  InterfaceOptionsPanel_OnLoad(panel)
  if spec.nativeChatOnly then
    -- Live while the native chat dock is on screen; greyed with the reason, the way the unavailable
    -- stock controls are, while the stock chat has replaced it. Asked again on every open.
    local refresh = panel.refresh
    panel.refresh = function(self)
      refresh(self)
      local live = host("nativeChat")
      sub:SetText(live and about or ${lua(FRAMEXML_OPTIONS_NATIVE_CHAT_NOTE)})
      for _, control in ipairs(self.controls) do
        control.tooltipRequirement = (not live) and ${lua(FRAMEXML_OPTIONS_NATIVE_CHAT_NOTE)} or nil
        if control.type == CONTROLTYPE_SLIDER then
          if live then BlizzardOptionsPanel_Slider_Enable(control) else BlizzardOptionsPanel_Slider_Disable(control) end
        elseif live then
          control:Enable()
        else
          control:Disable()
        end
      end
    end
  end
end

-- The sections are the category's children, collapsed under it as the client lists them; the root
-- page names them too, one button each, so the first open is not a page of two buttons.
local sections = root:CreateFontString(root:GetName() .. "Sections", "ARTWORK", "GameFontNormal")
sections:SetPoint("TOPLEFT", note, "BOTTOMLEFT", 0, -24)
sections:SetText("Разделы")
previous = nil
for index, panel in ipairs(root.webclientPanels) do
  local button = CreateFrame("Button", root:GetName() .. "Section" .. index, root, "UIPanelButtonTemplate")
  button:SetWidth(160)
  button:SetHeight(22)
  if previous then button:SetPoint("TOPLEFT", previous, "BOTTOMLEFT", 0, -4)
  else button:SetPoint("TOPLEFT", sections, "BOTTOMLEFT", 0, -8) end
  button:SetText(panel.name)
  button:SetScript("OnClick", function()
    PlaySound("igMainMenuOptionCheckBoxOn")
    InterfaceOptionsFrame_OpenToCategory(panel)
  end)
  previous = button
end
`;
}

/**
 * Before the panels' first PLAYER_ENTERING_WORLD. «Включить текст боя» (enableCombatText) is the
 * browser's own floating combat text switch; its stock setFunc would also load Blizzard_CombatText,
 * a second floating text over the first — through Lua's LoadAddOn, which is only a status view here,
 * so the PEW setup raised the client's «Ошибка загрузки (Blizzard_CombatText)» message instead.
 */
export const FRAMEXML_OPTIONS_BEFORE_EVENTS_SOURCE = `
local fct = InterfaceOptionsCombatTextPanelEnableFCT
if fct then fct.setFunc = function() end end
`;

/**
 * After the options frames' own PLAYER_ENTERING_WORLD setup: grey out the unavailable controls with
 * their reason, note the session-only ones, pin the fixed switch and arm the «WebClient» sliders.
 *
 * A disabled control's `Enable` becomes a no-op, as the stock hardware-cursor switch does when the
 * card lacks one (VideoOptionsPanels.lua): a dependency (InterfaceOptionsPanel_CheckButton_Update,
 * BlizzardOptionsPanel_CheckButton_Refresh) cannot switch it back on. The quality level slider is
 * one of them: stock computes «Вручную» (6) here — the unavailable sliders rest at their minimums
 * but TextureResolution shows 1 (BaseMip 0), which no GraphicsQualityLevels row pairs with those —
 * and, disabled, it can never apply a preset.
 */
export function frameXmlOptionsAdoptSource(): string {
  const unavailable = [...FRAMEXML_OPTIONS_UNAVAILABLE]
    .map(([name, reason]) => `[${lua(name)}] = ${lua(reason)}`).join(",\n  ");
  const session = FRAMEXML_OPTIONS_SESSION_ONLY.map(lua).join(", ");
  const fixed = [...FRAMEXML_OPTIONS_FIXED_ON].map(([name, reason]) => `[${lua(name)}] = ${lua(reason)}`).join(", ");
  return `
local unavailable = {
  ${unavailable}
}
local session = { ${session} }
local fixed = { ${fixed} }
local function noop() end
-- L5b 3.27: the host's hook when run by withFrameXmlHostHooks (FrameXmlHostHooks.ts), else Lua's.
local hook = rawget(_G, "${FRAMEXML_HOST_HOOK_GLOBAL}") or function(frame, script, fn) frame:HookScript(script, fn) end
local function reasonTooltip(self)
  local control = self.webclientControl or self
  if not control.webclientReason then return end
  GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
  GameTooltip:SetText(control.tooltipText or control.tooltip or "", nil, nil, nil, nil, 1)
  GameTooltip:AddLine(control.webclientReason, 1.0, 1.0, 1.0, 1.0)
  GameTooltip:Show()
end
local disabled = 0
for name, reason in pairs(unavailable) do
  local control = _G[name]
  if type(control) == "table" and control.GetObjectType then
    control.tooltipRequirement = reason
    control.webclientReason = reason
    local kind = control:GetObjectType()
    if kind == "CheckButton" then
      BlizzardOptionsPanel_CheckButton_Disable(control)
    elseif kind == "Slider" then
      BlizzardOptionsPanel_Slider_Disable(control)
    else
      UIDropDownMenu_DisableDropDown(control)
      local button = _G[name .. "Button"]
      if button then
        button.webclientControl = control
        hook(button, "OnEnter", reasonTooltip) -- L5b 3.27 (was button:HookScript)
        hook(button, "OnLeave", function() GameTooltip:Hide() end) -- L5b 3.27
      end
      hook(control, "OnEnter", reasonTooltip) -- L5b 3.27 (was control:HookScript)
      hook(control, "OnLeave", function() GameTooltip:Hide() end) -- L5b 3.27
    end
    control.Enable = noop
    disabled = disabled + 1
  end
end
for _, name in ipairs(session) do
  local control = _G[name]
  if type(control) == "table" and not control.tooltipRequirement then
    control.tooltipRequirement = ${lua(FRAMEXML_OPTIONS_SESSION_NOTE)}
  end
end
for name, reason in pairs(fixed) do
  local control = _G[name]
  if type(control) == "table" then
    control:SetChecked(true)
    BlizzardOptionsPanel_CheckButton_Disable(control)
    control.Enable = noop
    control.dependentControls = nil
    control.tooltipRequirement = reason
  end
end
local root = _G[${lua(FRAMEXML_OPTIONS_WEBCLIENT_PANEL)}]
for _, panel in ipairs(root and root.webclientPanels or {}) do
  for _, control in ipairs(panel.controls or {}) do
    if control.type == CONTROLTYPE_SLIDER then
      control.webclientReady = true
      _G[control:GetName() .. "Text"]:SetText(control.label .. ": " .. string.format("%d", math.floor((tonumber(control:GetValue()) or 0) + 0.5)))
    end
  end
end
-- What FrameXmlBoot.disableUnavailableOptions writes for a corpus that loads these at boot.
for _, name in ipairs({ "VideoOptionsResolutionPanelRefreshDropDownText", "VideoOptionsResolutionPanelMultiSampleDropDownText" }) do
  local text = _G[name]
  if type(text) == "table" and text.SetText then text:SetText(GetLocale() == "ruRU" and ${lua(UNAVAILABLE_TEXT)} or "Unavailable") end
end
-- OptionsList_DisplayButton adds a LEFT point to the list label beside its template's CENTER one;
-- the client resolves the pair into a left-justified label, the DOM renderer into a zero width.
-- Clearing the CENTER once leaves the LEFT point every later update sets, drawn the same way.
for _, list in ipairs({ VideoOptionsFrameCategoryFrame, AudioOptionsFrameCategoryFrame,
  InterfaceOptionsFrameCategories, InterfaceOptionsFrameAddOns }) do
  for _, button in ipairs(list and list.buttons or {}) do
    local label = button.text
    if label then
      label:ClearAllPoints()
      label:SetPoint("LEFT", 8, 2)
    end
  end
end
return disabled
`;
}
