/**
 * The page side of the stock options frames (FrameXmlOptionsOwner.ts): the settings window's
 * presets and storage note for the «WebClient» category, the native section to open when the stock
 * frames fail, and the settings watch the extra action bars follow.
 */

import {
  applySettingsPreset, openSettingsSection, settingsStorageNote, watchSettingsApplied,
} from "../ui/Settings.js";
import type { FrameXmlOptionsWindow } from "./FrameXmlOptionsController.js";
import type { FrameXmlOptionsHost } from "./FrameXmlOptionsOwner.js";

/** The native settings section each stock frame stands for. */
const NATIVE_SECTION = {
  video: "Графика", audio: "Звук", interface: "Интерфейс", webclient: "Игра",
} as const satisfies Record<FrameXmlOptionsWindow, string>;

/** `nativeChat`: the world mount's answer to whether its stock chat has hidden the native dock. */
export function frameXmlLiveOptionsHost(nativeChat?: () => boolean): FrameXmlOptionsHost & {
  openNative(window: FrameXmlOptionsWindow): void;
  watchSettings(listener: () => void): () => void;
} {
  return {
    preset: applySettingsPreset,
    storageNote: settingsStorageNote,
    ...(nativeChat ? { nativeChat } : {}),
    openNative: (window) => { openSettingsSection(NATIVE_SECTION[window]); },
    watchSettings: watchSettingsApplied,
  };
}
