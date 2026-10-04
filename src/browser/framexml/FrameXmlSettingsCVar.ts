/**
 * The small CVar surface that can be backed by the browser settings model.
 *
 * FrameXML's CVar API is string-valued and case-insensitive in the 3.3.5
 * client.  The browser settings are the source of truth here: this adapter
 * has no CVar map of its own.  A caller supplies the current model and the
 * same setter used by the native settings window, so a FrameXML checkbox or
 * slider is persisted and applied exactly like its browser counterpart.
 *
 * The list is intentionally narrower than InterfaceOptionsPanels.lua.  A
 * CVar is exposed only when this client has a setting that actually consumes
 * it and the conversion is reversible after the model's normal clamping.
 *
 * Two name spaces share the adapter.  The stock rows are the client's own
 * CVar names, read and written by the stock Video/Audio/Interface panels.  The
 * `webclient_` rows name every browser setting that has no stock control, so
 * the stock-style «WebClient» category (FrameXmlOptions.ts) drives them with
 * ordinary options controls; no stock Lua reads those names.
 */

import {
  SETTING_DEFINITIONS,
  coerceSetting,
  defaultSettings,
  settingDefinition,
  type SettingDefinition,
  type SettingValues,
} from "../ui/SettingsModel.js";

/**
 * `volume` and `percent` are the model's whole percentages as the client's fractions (0.7 for 70);
 * `number` is the model's own unit, where the stock CVar measures the same thing in it.
 */
export type FrameXmlSettingsCVarKind = "boolean" | "volume" | "percent" | "number";

export interface FrameXmlSettingsCVarDefinition {
  /** Canonical spelling used by the stock 3.3.5 Lua source. */
  readonly cvar: string;
  /** Existing browser setting id, not a second CVar state slot. */
  readonly setting: string;
  readonly kind: FrameXmlSettingsCVarKind;
  /** Stock `ShowAllSpellRanks` is the inverse of the browser's hide switch. */
  readonly inverted?: boolean;
  /**
   * A mode switch rather than a preference: `GetCVarDefault` answers nothing, so the options
   * frames' «По умолчанию» (BlizzardOptionsPanel_DefaultControl skips a control without a
   * defaultValue) cannot switch the interface or the add-ons off together with the checkboxes.
   */
  readonly noDefault?: boolean;
  /**
   * Written once the current Lua call has returned. Switching the original interface off unmounts
   * the VM whose «Окей» handler is still running the write.
   */
  readonly deferred?: boolean;
}

/**
 * CVar names and the settings they drive.
 *
 * The interface-volume control has no stock 3.3.5 CVar at all.  `showTimestamps` is absent because
 * the stock value is one of several format strings, while the browser only has a boolean, and the
 * stock chat consumes it itself.  `cameraDistanceMaxFactor` is the camera ceiling's factor over the
 * client's 15 yards, carried in percent (5.14).  `groundEffectDist` is the
 * browser's grass radius because both are the «Ground Clutter Radius» in yards
 * (VideoOptionsPanels.lua:389); `groundEffectDensity` is doodads per chunk against the browser's
 * multiplier over the authored density, so it is not.  `uiscale` is UIParent's scale and the
 * browser's interface size is the same factor in percent; the stock `useUiScale` switch has no
 * browser counterpart (the size always applies) and is answered by FrameXmlOptions.ts.  The
 * granular combat-text/nameplate CVars and the display, multisample, resolution and voice CVars
 * have no corresponding browser consumer, so they are not silently persisted as inert options.
 */
const FRAME_XML_SETTINGS_CVAR_ROWS: FrameXmlSettingsCVarDefinition[] = [
  { cvar: "bottomLeftActionBar", setting: "actionBarBottomLeft", kind: "boolean" },
  { cvar: "bottomRightActionBar", setting: "actionBarBottomRight", kind: "boolean" },
  { cvar: "rightActionBar", setting: "actionBarRight", kind: "boolean" },
  { cvar: "rightTwoActionBar", setting: "actionBarRight2", kind: "boolean" },
  { cvar: "rotateMinimap", setting: "minimapRotate", kind: "boolean" },
  { cvar: "ShowAllSpellRanks", setting: "spellbookHideLowerRanks", kind: "boolean", inverted: true },
  { cvar: "chatBubbles", setting: "chatBubbles", kind: "boolean" },
  { cvar: "enableCombatText", setting: "floatingCombatText", kind: "boolean" },
  { cvar: "nameplateShowEnemies", setting: "plateEnemies", kind: "boolean" },
  { cvar: "nameplateShowFriends", setting: "plateFriends", kind: "boolean" },
  { cvar: "ffxGlow", setting: "fullscreenGlow", kind: "boolean" },
  // The loot model's own switch (FrameXmlLootHost.ts) and stock LootFrame_Show's placement.
  { cvar: "autoLootDefault", setting: "autoLoot", kind: "boolean" },
  { cvar: "lootUnderMouse", setting: "lootUnderMouse", kind: "boolean" },
  // The stock Combat panel's STOP_AUTO_ATTACK; WorldClient.selectTarget reads it (5.05).
  { cvar: "stopAutoAttackOnTargetChange", setting: "stopAutoAttackOnTargetChange", kind: "boolean" },
  // L18 5.05: the stock Combat panel's «Ближний/дальний бой» (default "1", 0x0051dbd3); the world client's
  // autoRangedCombat hook reads the setting (EnterWorld.ts, world/AutoRangedCombat.ts).
  { cvar: "autoRangedCombat", setting: "autoRangedCombat", kind: "boolean" },
  // DEC-A 3.11: the stock Combat panel's «Автоматическая помощь» (ASSIST_ATTACK, default "0" at 0x009e14a0);
  // native ASSISTTARGET (input/Actions.ts settingOn) and the stock AssistUnit (FrameXmlTargetingApi.ts) read it.
  { cvar: "assistAttack", setting: "assistAttack", kind: "boolean" },
  // The stock Controls panel's BLOCK_TRADES; WorldClient answers a trade offer with it (5.25).
  { cvar: "blockTrades", setting: "blockTrades", kind: "boolean" },
  // The stock Features panel's «Использовать менеджер экипировки»; PaperDollFrame reads it on VARIABLES_LOADED.
  { cvar: "equipmentManager", setting: "equipmentManager", kind: "boolean" },
  { cvar: "Sound_MasterVolume", setting: "volumeMaster", kind: "volume" },
  { cvar: "Sound_SFXVolume", setting: "volumeEffects", kind: "volume" },
  { cvar: "Sound_MusicVolume", setting: "volumeMusic", kind: "volume" },
  { cvar: "Sound_AmbienceVolume", setting: "volumeAmbience", kind: "volume" },
  // The audio panel's four switches (AudioOptionsPanels.xml) and Sound.lua's /togglemusic, /togglesound.
  { cvar: "Sound_EnableAllSound", setting: "soundEnabled", kind: "boolean" },
  { cvar: "Sound_EnableSFX", setting: "soundEffectsEnabled", kind: "boolean" },
  { cvar: "Sound_EnableMusic", setting: "musicEnabled", kind: "boolean" },
  { cvar: "Sound_EnableAmbience", setting: "ambienceEnabled", kind: "boolean" },
  { cvar: "groundEffectDist", setting: "grassRadius", kind: "number" },
  // «Детализация ландшафта», 0.5–1.5: the same multiplier as the browser's object distance, in percent.
  { cvar: "environmentDetail", setting: "objectDistance", kind: "percent" },
  { cvar: "uiscale", setting: "uiScale", kind: "percent" },
  // 5.14: the stock Camera, Mouse and Controls panels. The slider-derived cameraPitchSmoothSpeed
  // (yaw/4) and cameraPitchMoveSpeed (yaw/2) stay the stock Lua's own writes; the camera derives the
  // same ratios from the yaw settings (CameraRig.ts).
  { cvar: "cameraDistanceMaxFactor", setting: "cameraDistancePercent", kind: "percent" },
  { cvar: "cameraSmoothStyle", setting: "cameraSmoothStyle", kind: "number" },
  { cvar: "cameraYawSmoothSpeed", setting: "cameraYawSmoothSpeed", kind: "number" },
  { cvar: "mouseSpeed", setting: "mouseSpeedPercent", kind: "percent" },
  { cvar: "cameraYawMoveSpeed", setting: "mouseLookSpeed", kind: "number" },
  { cvar: "mouseInvertPitch", setting: "mouseInvertPitch", kind: "boolean" },
  // The stock StickyTargeting check box inverts it itself (InterfaceOptionsPanels.xml); not here.
  { cvar: "deselectOnClick", setting: "deselectOnClick", kind: "boolean" },
  // L8 5.14: the Camera panel's WATER_COLLISION; the boom stops at the water (game/CameraWater.ts).
  { cvar: "cameraWaterCollision", setting: "cameraWaterCollision", kind: "boolean" },
];

export const FRAME_XML_SETTINGS_CVARS: readonly FrameXmlSettingsCVarDefinition[] = Object.freeze(
  FRAME_XML_SETTINGS_CVAR_ROWS.map((definition) => Object.freeze(definition)),
);

/** The CVar name the «WebClient» category gives a browser setting with no stock control. */
export function frameXmlWebClientCVar(setting: string): string {
  return `webclient_${setting}`;
}

/** Switches whose write rebuilds the interface; see `noDefault` and `deferred`. */
const WEBCLIENT_MODE_SWITCHES: Readonly<Record<string, Pick<FrameXmlSettingsCVarDefinition, "noDefault" | "deferred">>> = {
  originalFrameXml: { noDefault: true, deferred: true },
  tswowAddons: { noDefault: true },
};

/**
 * Every browser setting the stock rows above do not carry, in the settings window's own order.
 * A setting drawn by its own window (`ownWindow`, the spellbook's rank switch) keeps that window.
 */
export const FRAME_XML_WEBCLIENT_CVARS: readonly FrameXmlSettingsCVarDefinition[] = Object.freeze(
  SETTING_DEFINITIONS
    .filter((definition) => !definition.ownWindow
      && !FRAME_XML_SETTINGS_CVAR_ROWS.some((row) => row.setting === definition.id))
    .map((definition) => Object.freeze({
      cvar: frameXmlWebClientCVar(definition.id),
      setting: definition.id,
      kind: definition.kind === "boolean" ? "boolean" as const : "number" as const,
      ...WEBCLIENT_MODE_SWITCHES[definition.id],
    })),
);

export interface FrameXmlSettingsCVarHost {
  /** Reads the one persisted settings model used by the browser UI. */
  readonly getSettings: () => SettingValues;
  /** `Settings.ts`'s setter; it persists and calls `applySettings`. */
  readonly setSetting: (id: string, value: boolean | number) => boolean | void;
}

export interface FrameXmlSettingsCVarAdapter {
  /** Returns a stock CVar string, or undefined for an unsupported name. */
  readonly get: (name: string) => string | undefined;
  /** Returns the stock CVar default string, or undefined for an unsupported name. */
  readonly getDefault: (name: string) => string | undefined;
  /** Writes through the supplied settings setter; true means the name is supported. */
  readonly set: (name: string, value: unknown) => boolean;
  /**
   * `GetCVarMin`/`GetCVarMax` for a numeric name, in CVar units: the setting's own clamp. A stock
   * slider asks these before its panel's table (BlizzardOptionsPanel_OnEvent), so it cannot offer a
   * value the model would clamp away. Undefined for a switch or an unsupported name.
   */
  readonly range: (name: string) => readonly [min: number, max: number] | undefined;
}

const BY_CVAR = new Map<string, FrameXmlSettingsCVarDefinition>(
  [...FRAME_XML_SETTINGS_CVARS, ...FRAME_XML_WEBCLIENT_CVARS]
    .map((definition) => [definition.cvar.toLowerCase(), definition]),
);

function definitionFor(name: string): FrameXmlSettingsCVarDefinition | undefined {
  return typeof name === "string" ? BY_CVAR.get(name.toLowerCase()) : undefined;
}

function modelDefinition(binding: FrameXmlSettingsCVarDefinition): SettingDefinition | undefined {
  return settingDefinition(binding.setting);
}

/** WoW's boolean CVar convention: empty and exactly "0" are false. */
function stockBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  return false;
}

function cvarBoolean(value: boolean, inverted: boolean | undefined): string {
  return (inverted ? !value : value) ? "1" : "0";
}

/** How many model units one CVar unit is: the model stores percentages as whole numbers. */
function scale(binding: FrameXmlSettingsCVarDefinition): number {
  return binding.kind === "number" ? 1 : 100;
}

function settingFromCVar(binding: FrameXmlSettingsCVarDefinition, value: unknown): boolean | number {
  const definition = modelDefinition(binding);
  if (!definition) return false;
  if (binding.kind === "boolean") {
    const boolean = stockBoolean(value);
    return coerceSetting(definition, binding.inverted ? !boolean : boolean);
  }
  const number = typeof value === "number" ? value : Number(value);
  return coerceSetting(definition, Number.isFinite(number) ? number * scale(binding) : number);
}

/** A bounded number in the stock compact decimal form (0.5, not 0.500000; never exponential). */
function cvarNumber(value: number): string {
  // Two decimals are what the stock sliders step in (.01 for uiscale); rounding drops float noise.
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function cvarFromSetting(
  binding: FrameXmlSettingsCVarDefinition,
  values: SettingValues,
): string {
  const definition = modelDefinition(binding);
  if (!definition) return "";
  const raw = values[binding.setting] === undefined ? definition.fallback : values[binding.setting];
  const value = coerceSetting(definition, raw);
  if (binding.kind === "boolean") return cvarBoolean(value === true, binding.inverted);
  return cvarNumber((typeof value === "number" ? value : definition.fallback as number) / scale(binding));
}

/** After the calling Lua returns; synchronously where no microtask queue exists. */
function afterCurrentCall(write: () => void): void {
  if (typeof queueMicrotask === "function") queueMicrotask(write);
  else write();
}

export function createFrameXmlSettingsCVar(host: FrameXmlSettingsCVarHost): FrameXmlSettingsCVarAdapter {
  return Object.freeze({
    get(name: string): string | undefined {
      const binding = definitionFor(name);
      if (!binding) return undefined;
      return cvarFromSetting(binding, host.getSettings());
    },

    getDefault(name: string): string | undefined {
      const binding = definitionFor(name);
      if (!binding || binding.noDefault) return undefined;
      return cvarFromSetting(binding, defaultSettings());
    },

    set(name: string, value: unknown): boolean {
      const binding = definitionFor(name);
      if (!binding || !modelDefinition(binding)) return false;
      const setting = settingFromCVar(binding, value);
      if (binding.deferred) afterCurrentCall(() => { host.setSetting(binding.setting, setting); });
      else host.setSetting(binding.setting, setting);
      return true;
    },

    range(name: string): readonly [min: number, max: number] | undefined {
      const binding = definitionFor(name);
      const definition = binding ? modelDefinition(binding) : undefined;
      if (!binding || !definition || binding.kind === "boolean"
        || definition.min === undefined || definition.max === undefined) return undefined;
      return [Number(cvarNumber(definition.min / scale(binding))), Number(cvarNumber(definition.max / scale(binding)))];
    },
  });
}
