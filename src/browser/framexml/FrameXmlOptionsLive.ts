/**
 * The page side of the stock options frames (FrameXmlOptionsOwner.ts): the settings window's
 * presets and storage note for the «WebClient» category, and the settings watch the extra action
 * bars follow.
 */

import { applySettingsPreset, settingsStorageNote, watchSettingsApplied } from "../ui/Settings.js";
import type { FrameXmlOptionsHost } from "./FrameXmlOptionsOwner.js";

/** `nativeChat`: the world mount's answer to whether its stock chat has hidden the native dock. */
export function frameXmlLiveOptionsHost(nativeChat?: () => boolean): FrameXmlOptionsHost & {
  watchSettings(listener: () => void): () => void;
} {
  return {
    preset: applySettingsPreset,
    storageNote: settingsStorageNote,
    ...(nativeChat ? { nativeChat } : {}),
    watchSettings: watchSettingsApplied,
  };
}
