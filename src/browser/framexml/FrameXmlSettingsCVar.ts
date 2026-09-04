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
 */

import {
  coerceSetting,
  defaultSettings,
  settingDefinition,
  type SettingDefinition,
  type SettingValues,
} from "../ui/SettingsModel.js";

export type FrameXmlSettingsCVarKind = "boolean" | "volume";

export interface FrameXmlSettingsCVarDefinition {
  /** Canonical spelling used by the stock 3.3.5 Lua source. */
  readonly cvar: string;
  /** Existing browser setting id, not a second CVar state slot. */
  readonly setting: string;
  readonly kind: FrameXmlSettingsCVarKind;
  /** Stock `ShowAllSpellRanks` is the inverse of the browser's hide switch. */
  readonly inverted?: boolean;
}

/**
 * CVar names and the settings they drive.
 *
 * `Sound_AmbienceVolume` is deliberately absent: the browser currently uses
 * its music setting for the ambience output as well, so accepting the stock
 * CVar would make a supposedly ambience-only write change music too.  The
 * interface-volume control has no stock 3.3.5 CVar at all.  `showTimestamps`
 * is also absent because the stock value is one of several format strings,
 * while the browser only has a boolean.  `cameraDistanceMaxFactor` is a
 * multiplier and the browser's camera setting is a yard ceiling with no
 * measured affine conversion.  The granular combat-text/nameplate CVars and
 * video, multisample, resolution and voice CVars have no corresponding
 * browser consumer, so they are not silently persisted as inert options.
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
  { cvar: "Sound_MasterVolume", setting: "volumeMaster", kind: "volume" },
  { cvar: "Sound_SFXVolume", setting: "volumeEffects", kind: "volume" },
  { cvar: "Sound_MusicVolume", setting: "volumeMusic", kind: "volume" },
];

export const FRAME_XML_SETTINGS_CVARS: readonly FrameXmlSettingsCVarDefinition[] = Object.freeze(
  FRAME_XML_SETTINGS_CVAR_ROWS.map((definition) => Object.freeze(definition)),
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
}

const BY_CVAR = new Map<string, FrameXmlSettingsCVarDefinition>(
  FRAME_XML_SETTINGS_CVARS.map((definition) => [definition.cvar.toLowerCase(), definition]),
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

/** The model stores percentages as whole numbers; stock sound CVars are [0, 1]. */
function settingFromCVar(binding: FrameXmlSettingsCVarDefinition, value: unknown): boolean | number {
  const definition = modelDefinition(binding);
  if (!definition) return false;
  if (binding.kind === "boolean") {
    const boolean = stockBoolean(value);
    return coerceSetting(definition, binding.inverted ? !boolean : boolean);
  }
  const fraction = typeof value === "number" ? value : Number(value);
  return coerceSetting(definition, Number.isFinite(fraction) ? fraction * 100 : fraction);
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
  const fraction = (typeof value === "number" ? value : definition.fallback as number) / 100;
  // Values are bounded to [0, 1], so String gives the stock compact decimal form (0.5, not
  // 0.500000) and does not enter exponential notation.
  return Object.is(fraction, -0) ? "0" : String(fraction);
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
      if (!binding) return undefined;
      return cvarFromSetting(binding, defaultSettings());
    },

    set(name: string, value: unknown): boolean {
      const binding = definitionFor(name);
      if (!binding || !modelDefinition(binding)) return false;
      host.setSetting(binding.setting, settingFromCVar(binding, value));
      return true;
    },
  });
}
