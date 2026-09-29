/**
 * The world mount's one call for the stock achievement window: the lazy Blizzard_AchievementUI owner
 * (FrameXmlAchievementOwner.ts) published through FrameXmlAchievementController.ts, with the
 * gateway catalog, stock's own LoD entry points, Escape and the AchievementMicroButton. Kept apart
 * from the owner so the owner and its tests stay free of the page's DOM modules.
 */
import { registerEscapable } from "../ui/Windows.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlAchievementModel } from "./FrameXmlAchievement.js";
import { FrameXmlAchievementCatalogClient } from "./FrameXmlAchievementCatalog.js";
import { publishFrameXmlAchievement } from "./FrameXmlAchievementController.js";
import {
  createLazyFrameXmlAchievementOwner,
  installFrameXmlAchievementHostGlobals,
  installFrameXmlAchievementLinkTooltip,
  type FrameXmlLazyAchievementOwner,
} from "./FrameXmlAchievementOwner.js";

/** The micro button's accessible name while no stock owner can open (the mount's own wording). */
const UNAVAILABLE = "Достижения недоступны в этой сборке";

export interface FrameXmlAchievementMountOptions {
  /** Where `/dbc/achievements` is served (the page's gateway). */
  readonly gatewayOrigin: string;
  /** The stock micro-button row passed its gate and is on screen: the Achievement button is ours. */
  readonly microButtons: boolean;
  /** A player's open that cannot happen, in the error frame. */
  readonly uiError?: (text: string) => void;
}

/**
 * AchievementMicroButton follows stock's UpdateMicroButtons rule (MainMenuBarMicroButtons.lua:100-109):
 * enabled once any achievement is earned, and its stock tooltip — the MainMenuBarMicroButton template's
 * OnEnter/OnLeave, the same handlers every button of the row carries — back in place of the no-ops the
 * row adapter put there while the window had no owner. Unavailable, it is the adapter's disabled,
 * silent button again.
 */
export function setFrameXmlAchievementMicroButton(
  boot: Pick<FrameXmlBoot, "bridge">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  state: { readonly available: boolean; readonly enabled: boolean },
): boolean {
  const button = boot.bridge.getFrame("AchievementMicroButton");
  const template = boot.bridge.getFrame("TalentMicroButton");
  if (!button || !template) return false;
  const enter = state.available ? boot.bridge.GetScript(template, "OnEnter") : undefined;
  const leave = state.available ? boot.bridge.GetScript(template, "OnLeave") : undefined;
  boot.bridge.SetScript(button, "OnEnter", enter ?? (() => {}));
  boot.bridge.SetScript(button, "OnLeave", leave ?? (() => {}));
  const enabled = state.available && state.enabled;
  if (button.enabled !== enabled) boot.bridge.update(button, (frame) => { frame.enabled = enabled; });
  const element = renderer.elementFor(button);
  if (state.available) {
    element?.removeAttribute("title");
    element?.setAttribute("aria-label", "Достижения");
  } else {
    element?.setAttribute("title", UNAVAILABLE);
    element?.setAttribute("aria-label", UNAVAILABLE);
  }
  return true;
}

/**
 * Hand the seam's model the gateway's catalog before the boot attaches the seam: an achievement chat
 * line replayed from the backlog at attach, or arriving while the corpus loads, then waits for the
 * catalog's name instead of printing the id. The canned seam keeps its own catalog. Nothing is fetched
 * here; the first line, toast or open does that.
 */
export function provideFrameXmlAchievementCatalog(
  seam: { readonly achievement?: FrameXmlAchievementModel | undefined },
  gatewayOrigin: string,
): void {
  const model = seam.achievement;
  if (model && !model.catalogSource) model.catalogSource = new FrameXmlAchievementCatalogClient(gatewayOrigin);
}

/**
 * Publish the lazy stock achievement owner. Nothing loads at boot: the first open, the first toast
 * or a comparison loads the catalog, AlertFrames.xml and Blizzard_AchievementUI. The returned cleanup
 * unpublishes it; the VM's teardown takes the frames with it.
 */
export function mountFrameXmlAchievement(
  seam: { readonly achievement?: FrameXmlAchievementModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "loadAddon" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
  options: FrameXmlAchievementMountOptions,
): () => void {
  const model = seam.achievement;
  if (!model) return () => {};
  provideFrameXmlAchievementCatalog(seam, options.gatewayOrigin);
  let owner: FrameXmlLazyAchievementOwner | undefined;
  const syncButton = (): void => {
    if (!options.microButtons) return;
    const available = owner !== undefined && !owner.failed;
    setFrameXmlAchievementMicroButton(boot, renderer, { available, enabled: available && model.hasCompletedAny() });
  };
  owner = createLazyFrameXmlAchievementOwner(seam, boot, renderer, {
    onFailure: (reason, requested) => {
      console.warn(`[FrameXML achievements] ${reason}; the achievement window stays closed`);
      if (requested) options.uiError?.("Достижения сейчас недоступны.");
      syncButton();
    },
    // No catalog yet (the running gateway predates the route): this press is refused and the button
    // stays as it is, so the next press, once the gateway serves it, opens the window.
    onRefused: (reason, requested) => {
      console.warn(`[FrameXML achievements] ${reason}; the achievement window stays closed for now`);
      if (requested) options.uiError?.("Достижения сейчас недоступны.");
    },
  });
  const current = owner;
  installFrameXmlAchievementHostGlobals(boot, {
    toggle: (stats) => { current.toggle(stats); },
    load: () => { current.begin(); },
    compare: (unit) => { current.compare(unit); },
  });
  installFrameXmlAchievementLinkTooltip(boot, (guid) => model.linkPlayer(guid));
  const release = publishFrameXmlAchievement(current);
  const releaseEscape = registerEscapable({ isOpen: () => current.isOpen(), close: () => { current.close(); } });
  model.onAvailabilityChanged = syncButton;
  syncButton();
  return () => {
    if (model.onAvailabilityChanged === syncButton) model.onAvailabilityChanged = undefined;
    releaseEscape();
    release();
  };
}
