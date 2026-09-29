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
    for (const name of ["ItemSocketingFrame", "GameTooltip"]) {
      const frame = boot.bridge.getFrame(name);
      if (frame) visit(frame);
    }
    for (const frame of this.#painted) {
      for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
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
