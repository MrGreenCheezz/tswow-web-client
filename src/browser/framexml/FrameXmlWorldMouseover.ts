import type { GlueLuaRef, GlueLuaVm } from "../glue/GlueLua.js";

/**
 * The engine half of the stock world-unit tooltip.
 *
 * In the 3.3.5 client the C++ side, not FrameXML, reacts to the pointer resting on a unit in the
 * 3D world: it runs `GameTooltip_SetDefaultAnchor(GameTooltip, UIParent)` and
 * `GameTooltip:SetUnit("mouseover")` when the hovered unit changes, and `GameTooltip:FadeOut()`
 * once the pointer has left it while the tooltip is still that world tooltip. Stock GameTooltip.xml
 * then colours the name through its own OnTooltipSetUnit (`if self:IsUnit("mouseover")`). Nothing
 * here builds tooltip rows: every line comes from the stock SetUnit path and its add-on hooks.
 *
 * The hover source is Controls.ts' committed pick (HoverTarget). That pick is deliberately cleared
 * for the ~16 ms between a throttled pointermove and its trailing re-pick, so a pointer sweeping
 * across one unit reads «unit, nothing, same unit». Entering is immediate; leaving waits until the
 * clear has lasted `leaveDelayMs`, so the tooltip neither flickers nor re-runs SetUnit for the
 * same unit. A tooltip that is still the world tooltip `expireDelayMs` after its FadeOut is hidden,
 * so a runtime whose FadeOut is only a compatibility stub cannot leave it on screen.
 */
export interface FrameXmlWorldMouseoverOptions {
  /** The committed world hover, sampled once per HUD frame. */
  readonly hovered: () => bigint | undefined;
  /** Show the stock tooltip for the (new) mouseover unit. */
  readonly enter: () => void;
  /** Fade the stock tooltip if it is still the world-unit tooltip. */
  readonly leave: () => void;
  /** Hide the stock tooltip if it is still the world-unit tooltip after its fade. */
  readonly expire?: () => void;
  readonly leaveDelayMs?: number;
  readonly expireDelayMs?: number;
}

export interface FrameXmlWorldMouseover {
  /** `now` is a millisecond clock (performance.now()). */
  tick(now: number): void;
}

/** Longer than Controls.ts' 16 ms hover throttle plus one 60 Hz frame, far below a human «leave». */
export const FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS = 80;
/** Past any GameTooltip fade; only a FadeOut that did nothing reaches this. */
export const FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS = 1000;

export function createFrameXmlWorldMouseover(options: FrameXmlWorldMouseoverOptions): FrameXmlWorldMouseover {
  const leaveDelay = options.leaveDelayMs ?? FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS;
  const expireDelay = options.expireDelayMs ?? FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS;
  let shown: bigint | undefined;
  let clearedAt: number | undefined;
  let fadedAt: number | undefined;
  return {
    tick(now: number): void {
      const guid = options.hovered();
      if (guid !== undefined) {
        clearedAt = undefined;
        if (guid === shown) return;
        shown = guid;
        fadedAt = undefined;
        options.enter();
        return;
      }
      if (shown === undefined) {
        if (fadedAt !== undefined && now - fadedAt >= expireDelay) {
          fadedAt = undefined;
          options.expire?.();
        }
        return;
      }
      clearedAt ??= now;
      if (now - clearedAt < leaveDelay) return;
      shown = undefined;
      clearedAt = undefined;
      fadedAt = now;
      options.leave();
    },
  };
}

/** The world tooltip is the one GameTooltip_SetDefaultAnchor gave to UIParent, or the mouseover. */
const WORLD_TOOLTIP_TEST = `
  if not (GameTooltip and UIParent and GameTooltip:IsShown()) then return end
  local owned = GameTooltip.IsOwned and GameTooltip:IsOwned(UIParent)
  local unit = GameTooltip.IsUnit and GameTooltip:IsUnit("mouseover")
  if not (owned or unit) then return end
`;

/**
 * The Lua bodies, compiled once per VM. Each checks the globals it needs, so a vertical that lacks
 * GameTooltip, or a seam that cannot resolve the "mouseover" token yet, degrades to «no world
 * tooltip» rather than an error. The leave test accepts either the stock `IsUnit("mouseover")`
 * answer or the UIParent owner that GameTooltip_SetDefaultAnchor gave it: by the time the hover is
 * known to be gone the seam can no longer resolve "mouseover", while a frame's own OnEnter would
 * have re-owned the tooltip and so is never faded here.
 */
export function compileFrameXmlWorldMouseoverScripts(
  vm: Pick<GlueLuaVm, "compileFunction" | "call">,
): Pick<FrameXmlWorldMouseoverOptions, "enter" | "leave" | "expire"> {
  const enter = vm.compileFunction(`
    if not (GameTooltip and UIParent and GameTooltip_SetDefaultAnchor and UnitExists) then return end
    if not UnitExists("mouseover") then return end
    GameTooltip_SetDefaultAnchor(GameTooltip, UIParent)
    GameTooltip:SetUnit("mouseover")
  `, "webclient/world-mouseover-enter", []);
  const leave = vm.compileFunction(`${WORLD_TOOLTIP_TEST}
    if GameTooltip.FadeOut then GameTooltip:FadeOut() else GameTooltip:Hide() end
  `, "webclient/world-mouseover-leave", []);
  const expire = vm.compileFunction(`${WORLD_TOOLTIP_TEST}
    GameTooltip:Hide()
  `, "webclient/world-mouseover-expire", []);
  const run = (ref: GlueLuaRef | undefined): (() => void) => () => {
    if (ref) vm.call(ref, [], 0);
  };
  return { enter: run(enter), leave: run(leave), expire: run(expire) };
}
