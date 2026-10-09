/**
 * Stock hover tooltips over the native windows (plan item 3.24, L5c 04.10).
 *
 * The stock overlay sits under the native windows (HOST_CSS `z-index: 3`; GameWindows raises each
 * native window it shows) and is lifted over them only by a pointerdown on a stock control or a shown
 * stock dialog (FrameXmlWorldMount.ts, watchFrameXmlDialogLayer). A hover takes no click, so a stock
 * GameTooltip — an action button's, a buff's, a bag slot's — was drawn under any native window it
 * overlapped. In the client there is one UI and the tooltip strata is above every window.
 *
 * While GameTooltip is shown the overlay is lifted the way a click lifts it (`raise`, GameWindows'
 * own counter), and when it hides the overlay goes back to the order it had — unless a click on a
 * stock control during the hover asked for the lift to stay, or something else changed the order
 * meanwhile. The hooks are the host's (`bridge.HookScript`), so an add-on's SetScript on GameTooltip
 * keeps them, as watchFrameXmlDialogLayer's do.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";

/** The lift itself, DOM-free: what `show`/`hide`/`pointerDown` do to the overlay's z-index. */
export interface FrameXmlTooltipLift {
  show(): void;
  hide(): void;
  /** A pointerdown on a stock control: the lift a hover made stays, as a click would have made it. */
  pointerDown(): void;
  readonly lifted: boolean;
}

/**
 * `top` is GameWindows' highest z-index so far: when it is still the level this lift took last time
 * (no native window rose since), the overlay goes back to that level instead of raising again — so
 * hovers do not push the shared counter up one by one past the native menus' fixed layer.
 */
export function createFrameXmlTooltipLift(
  host: { readonly style: { zIndex: string } }, raise: () => void, top?: () => number,
): FrameXmlTooltipLift {
  let previous: string | undefined;
  let liftedTo: string | undefined;
  let lastLevel: number | undefined;
  let kept = false;
  return {
    get lifted() { return previous !== undefined; },
    show() {
      if (previous !== undefined) return;
      previous = host.style.zIndex;
      kept = false;
      if (lastLevel !== undefined && top?.() === lastLevel) host.style.zIndex = String(lastLevel);
      else raise();
      liftedTo = host.style.zIndex;
      const level = Number.parseInt(liftedTo, 10);
      lastLevel = Number.isFinite(level) ? level : undefined;
    },
    hide() {
      if (previous === undefined) return;
      // Only our own lift is taken back: a later raise (a click, a dialog) keeps its order.
      if (!kept && host.style.zIndex === liftedTo) host.style.zIndex = previous;
      previous = undefined;
      liftedTo = undefined;
      kept = false;
    },
    pointerDown() {
      // Outside a lift this is forgotten: the next `show` starts unkept.
      kept = true;
    },
  };
}

/**
 * Hook GameTooltip's show and hide to the lift; returns the cleanup (the hooks then do nothing).
 * `ignore` answers true while GameTooltip only feeds a native window's own tooltip
 * (FrameXmlNativeItemTooltip.ts): hovering a native bag slot must not lift the overlay over it.
 */
export function watchFrameXmlTooltipLayer(
  boot: Pick<FrameXmlBoot, "bridge">, lift: FrameXmlTooltipLift, ignore: () => boolean = () => false,
): () => void {
  const tooltip = boot.bridge.getFrame("GameTooltip");
  if (!tooltip) return () => {};
  let active = true;
  boot.bridge.HookScript(tooltip, "OnShow", () => { if (active && !ignore()) lift.show(); });
  boot.bridge.HookScript(tooltip, "OnHide", () => { if (active) lift.hide(); });
  if (boot.bridge.isVisible(tooltip) && !ignore()) lift.show();
  return () => {
    if (!active) return;
    active = false;
    lift.hide();
  };
}
