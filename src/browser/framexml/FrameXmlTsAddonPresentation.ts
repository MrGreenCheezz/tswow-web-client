import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";

/**
 * The Lua global that tells a TSWoW module it runs over the native HUD (the ordinary world,
 * `addonsOnly`), not over the stock minimap cluster.
 *
 * The native minimap keeps its own zoom/rotate/tracking/world-map buttons on the ring where the
 * stock cluster has none (style.css `.minimap-button`), so a module that places itself around
 * `Minimap` by the stock art — minimap-hub's 193° — lands on one of them. It is a plain boolean read
 * as `_G.__fxNativeHud`: the stub planner stubs only names the corpus *calls*, so a module reading
 * it in the stock client (or the full FrameXML mount) sees nil and keeps its stock default.
 */
export const FRAMEXML_NATIVE_HUD_GLOBAL = "__fxNativeHud";

/** Set before `boot.load()`, so a module reading it at file load or VARIABLES_LOADED sees it. */
export function markFrameXmlNativeHud(boot: Pick<FrameXmlBoot, "vm">): void {
  boot.vm.setGlobal(FRAMEXML_NATIVE_HUD_GLOBAL, true);
}

/**
 * The stock surfaces painted over the native HUD beside the modules' own frames: explicit
 * dependencies of our modules, whose own UI is required — unlike the empty layout ancestors of a
 * module attached to the native character/minimap UI.
 *
 * - ItemSocketingFrame and GameTooltip, which modules open and fill.
 * - StaticPopup1-4 (`STATICPOPUP_NUMDIALOGS`, FrameXmlPopupsOwner.ts FRAMEXML_STATIC_POPUP_COUNT):
 *   the dialogs a module raises itself — tswow-store's purchase confirmation, retail-talents' resets.
 *   The server's questions never reach them in this mode (FrameXmlAddonsOnlyMessages.ts).
 * - UIErrorsFrame: a module's own warnings (survival's hunger and thirst); the world's messages are
 *   unregistered from it there, since the native notice line says them.
 */
export const FRAMEXML_ADDONS_ONLY_SURFACES: readonly string[] = Object.freeze([
  "ItemSocketingFrame", "GameTooltip",
  "StaticPopup1", "StaticPopup2", "StaticPopup3", "StaticPopup4",
  "UIErrorsFrame",
]);

let addonDialogsEscape: (() => boolean) | undefined;

/**
 * Escape for the stock dialogs a module raised over the native HUD, published by the `addonsOnly`
 * mount while it lives (FrameXmlAddonsOnlyMessages.ts); answers the identity-safe withdrawal. Kept in
 * this import-light module because the native Escape chain (Controls.ts) asks it first.
 */
export function publishFrameXmlAddonDialogsEscape(escape: () => boolean): () => void {
  addonDialogsEscape = escape;
  return () => { if (addonDialogsEscape === escape) addonDialogsEscape = undefined; };
}

/** Whether an overlay's Escape step is published: a withdrawn one holds no closure over its VM. */
export function frameXmlAddonDialogsEscapePublished(): boolean {
  return addonDialogsEscape !== undefined;
}

/**
 * The native Escape chain's first question in `addonsOnly`: closes the dialogs Escape may dismiss
 * through stock StaticPopup_EscapePressed and answers true when it did — then the press is spent,
 * as stock ToggleGameMenu stops right there (UIParent.lua:2872): not the module window under the
 * dialog, not the target. False when no such dialog is up or nothing is published.
 */
export function escapeFrameXmlAddonDialogs(): boolean {
  const escape = addonDialogsEscape;
  if (!escape) return false;
  try { return escape(); } catch { return false; }
}

/** Paint module-created widgets and only the layout ancestors needed to position them. */
export class FrameXmlTsAddonPresentation {
  readonly #boot: FrameXmlBoot;
  readonly #nativeTooltipActive: () => boolean;
  readonly #included = new Set<FrameXmlFrame>();
  readonly #painted = new Set<FrameXmlFrame>();
  #version = -1;

  constructor(boot: FrameXmlBoot, nativeTooltipActive: () => boolean = () => false) {
    this.#boot = boot;
    this.#nativeTooltipActive = nativeTooltipActive;
  }

  #refresh(): void {
    const boot = this.#boot;
    if (this.#version === boot.bridge.mutationVersion) return;
    this.#version = boot.bridge.mutationVersion;
    this.#included.clear();
    this.#painted.clear();
    const visit = (frame: FrameXmlFrame): void => {
      if (this.#painted.has(frame)) return;
      this.#painted.add(frame);
      for (const child of frame.children) visit(child);
    };
    for (const [frame, owner] of boot.tsAddonFrames) {
      if (!boot.isAddonLoaded(owner)) continue;
      // Game-menu entries are published through the native menu adapter.
      let inMenu = false;
      for (let parent = frame.parent; parent; parent = parent.parent) {
        if (parent.name === "GameMenuFrame") inMenu = true;
      }
      if (!inMenu) visit(frame);
    }
    // These stock surfaces are explicit dependencies of our modules. Their own UI is required,
    // unlike the empty layout ancestors of a module attached to the native character/minimap UI.
    for (const name of FRAMEXML_ADDONS_ONLY_SURFACES) {
      const frame = boot.bridge.getFrame(name);
      if (frame) visit(frame);
    }
    // A frame already included brought its ancestors with it: each walk stops there, so a painted
    // subtree costs its size, not its size times its depth.
    for (const frame of this.#painted) {
      for (let current: FrameXmlFrame | undefined = frame; current && !this.#included.has(current); current = current.parent) {
        this.#included.add(current);
      }
    }
  }

  readonly includes = (frame: FrameXmlFrame): boolean => {
    if (this.#nativeTooltipActive()) {
      for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
        if (current.name === "GameTooltip") return false;
      }
    }
    this.#refresh();
    return this.#included.has(frame);
  };

  readonly layoutOnly = (frame: FrameXmlFrame): boolean => {
    this.#refresh();
    return !this.#painted.has(frame);
  };

  /** Match stock attachment points to their live native owners; keep Lua parenting intact. */
  syncNativeAnchors(
    stage: HTMLElement, character: HTMLElement | null, minimap: HTMLElement | null,
    characterSheet?: HTMLElement | null,
  ): void {
    const boot = this.#boot;
    const ui = boot.bridge.getFrame("UIParent");
    if (!ui) return;
    const stageRect = stage.getBoundingClientRect();
    const scale = stageRect.height / 768 || 1;
    for (const [name, element] of [["CharacterFrame", character], ["Minimap", minimap]] as const) {
      const frame = boot.bridge.getFrame(name);
      if (!frame) continue;
      const rect = element?.getBoundingClientRect();
      const visible = !!element && !element.hidden && !!rect && rect.width > 0 && rect.height > 0;
      if (visible && rect) {
        const x = (rect.left - stageRect.left) / scale;
        const y = -(rect.top - stageRect.top) / scale;
        const width = rect.width / scale;
        const height = rect.height / scale;
        const point = frame.points[0];
        if (frame.attributes["width"] !== String(width) || frame.attributes["height"] !== String(height)
          || frame.points.length !== 1 || point?.relativeTo !== ui || point.point !== "TOPLEFT"
          || point.relativePoint !== "TOPLEFT" || point.x !== x || point.y !== y) {
          boot.bridge.update(frame, (value) => {
            value.setAttribute("width", String(width));
            value.setAttribute("height", String(height));
          });
          boot.bridge.ClearAllPoints(frame);
          boot.bridge.SetPoint(frame, "TOPLEFT", ui, "TOPLEFT", x, y);
        }
      }
      if (frame.visible !== visible) {
        if (visible) boot.bridge.Show(frame);
        else boot.bridge.Hide(frame);
      }
    }
    const paperDoll = boot.bridge.getFrame("PaperDollFrame");
    if (paperDoll && characterSheet) {
      const visible = !characterSheet.hidden;
      if (paperDoll.visible !== visible) {
        if (visible) boot.bridge.Show(paperDoll);
        else boot.bridge.Hide(paperDoll);
      }
    }
  }
}
