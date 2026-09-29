/**
 * framexml.html's `?options=` preview: the world mount's lazy options owner over the canned world,
 * with a settings model kept in this page (never the account's), so the mapped controls read and
 * write something and the page can show what they wrote.
 *
 *   `?options=video|audio|interface|webclient` opens that frame (webclient: InterfaceOptionsFrame on
 *   the «WebClient» category); `?options=interface:InterfaceOptionsActionBarsPanel` or
 *   `?options=video:VideoOptionsEffectsPanel` also selects a panel by its frame name.
 */

import { CannedWorldSeam } from "./CannedWorldSeam.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { defaultSettings, type SettingValues } from "../ui/SettingsModel.js";
import { comparisonGraphicsSettings } from "../ui/ComparisonProfile.js";
import { enhancedGraphicsSettings } from "../ui/EnhancedGraphics.js";
import { createFrameXmlSettingsCVar } from "./FrameXmlSettingsCVar.js";
import { createLazyFrameXmlOptionsOwner, installFrameXmlOptionsActionBars } from "./FrameXmlOptionsOwner.js";
import type { FrameXmlOptionsWindow } from "./FrameXmlOptionsController.js";

export interface FrameXmlOptionsPreview {
  readonly window: FrameXmlOptionsWindow;
  /** A panel's frame name to select after opening, if any. */
  readonly panel: string | undefined;
  /** The canned world with this page's settings behind its CVars. */
  seam(): CannedWorldSeam;
  /** The page's settings and every write the stock controls made, in order. */
  readonly values: () => SettingValues;
  readonly writes: readonly (readonly [string, boolean | number])[];
  /** The «WebClient» category's preset buttons, over the page's settings as Settings.applySettingsPreset. */
  preset(kind: "enhanced" | "comparison"): void;
}

const WINDOWS: ReadonlySet<string> = new Set(["video", "audio", "interface", "webclient"]);

/** The requested preview, or undefined without a valid `?options=`. */
export function frameXmlOptionsPreview(parameters: URLSearchParams): FrameXmlOptionsPreview | undefined {
  const [window = "", panel] = (parameters.get("options") ?? "").trim().split(":");
  const name = window.toLowerCase();
  if (!WINDOWS.has(name)) return undefined;
  let values = defaultSettings();
  const writes: (readonly [string, boolean | number])[] = [];
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => {
      writes.push([id, value]);
      values = { ...values, [id]: value };
    },
  });
  return {
    window: name as FrameXmlOptionsWindow,
    panel: panel && /^[A-Za-z0-9_]+$/.test(panel) ? panel : undefined,
    seam: () => new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cvars),
    values: () => values,
    writes,
    preset: (kind) => {
      writes.push([`preset:${kind}`, true]);
      values = kind === "enhanced" ? enhancedGraphicsSettings(values) : comparisonGraphicsSettings(values);
    },
  };
}

/** Load the chain through the lazy owner, open the frame, and report what happened. */
export async function openFrameXmlOptionsPreview(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  preview: FrameXmlOptionsPreview,
): Promise<"open" | "native" | "closed"> {
  let native = false;
  // The world mount's stock clock (loadFrameXmlStockClock): the Display panel's «Часы» switch calls
  // TimeManager_LoadUI on its first PLAYER_ENTERING_WORLD, which reports a missing add-on otherwise.
  const clock = await boot.loadAddon("Blizzard_TimeManager");
  if (clock.ok && clock.roots.length > 0) renderer.addRoots(clock.roots);
  installFrameXmlOptionsActionBars(boot);
  const owner = createLazyFrameXmlOptionsOwner(boot, renderer, {
    host: { preset: (kind) => { preview.preset(kind); }, storageNote: () => "Предпросмотр: настройки только в этой странице." },
    onFailure: () => { native = true; },
  });
  owner.open(preview.window, false);
  await owner.settled;
  if (preview.panel && !native) {
    // OptionsFrame_OpenToCategory takes the category's name only (OptionsFrameTemplates.lua:349).
    const opener = preview.window === "video" || preview.window === "audio"
      ? `OptionsFrame_OpenToCategory(${preview.window === "video" ? "VideoOptionsFrame" : "AudioOptionsFrame"}, ${preview.panel}.name)`
      : `InterfaceOptionsFrame_OpenToCategory(${preview.panel})`;
    boot.vm.executeReported(`if ${preview.panel} then ${opener} end`, "@framexml-preview/options");
  }
  renderer.sync();
  return native ? "native" : owner.isOpen() ? "open" : "closed";
}
