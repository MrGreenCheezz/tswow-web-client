/**
 * The world mount's one call for this lane's three load-on-demand windows: stock inspection
 * (Blizzard_InspectUI), socketing (Blizzard_ItemSocketingUI, FrameXmlSocketMount.ts) and the barber
 * shop (Blizzard_BarbershopUI, FrameXmlBarberMount.ts). Nothing loads at boot; each add-on loads on
 * its first use and its native counterpart (where there is one) stays the fallback until its gate.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlInspectModel } from "./FrameXmlInspect.js";
import type { FrameXmlSocketModel } from "./FrameXmlSocketModel.js";
import type { FrameXmlBarberModel } from "./FrameXmlBarber.js";
import { createLazyFrameXmlInspectOwner, type FrameXmlLazyInspectOwner } from "./FrameXmlInspectOwner.js";
import { mountFrameXmlSocket } from "./FrameXmlSocketMount.js";
import { mountFrameXmlBarber } from "./FrameXmlBarberMount.js";

const INSPECT_UNIT = "__fxWebClientInspectUnit";

/**
 * Point the stock `InspectUnit` (UnitPopup's «Осмотреть», ChatFrame's `/inspect`) at the lazy owner.
 * The stock function is kept: a request the owner cannot take goes to it, and its UIParentLoadAddOn
 * then shows the client's own load-failure message. The cleanup puts the stock function back.
 */
export function routeFrameXmlInspectUnit(
  boot: Pick<FrameXmlBoot, "vm">,
  owner: Pick<FrameXmlLazyInspectOwner, "inspect">,
): () => void {
  boot.vm.registerGlobal(INSPECT_UNIT, (args) => [owner.inspect(typeof args[0] === "string" ? args[0] : "")]);
  boot.vm.executeReported(`
    if type(InspectUnit) == "function" and rawget(_G, "__fxStockInspectUnit") == nil then
      __fxStockInspectUnit = InspectUnit
      InspectUnit = function(unit)
        if not ${INSPECT_UNIT}(unit) then return __fxStockInspectUnit(unit) end
      end
    end
  `, "@webclient/inspect-route");
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      boot.vm.executeReported(`
        if rawget(_G, "__fxStockInspectUnit") ~= nil then
          InspectUnit = __fxStockInspectUnit
          __fxStockInspectUnit = nil
        end
      `, "@webclient/inspect-unroute");
    } catch { /* the VM may already be closed */ }
  };
}

/** Publish the lazy stock inspection owner and route InspectUnit to it. */
export function mountFrameXmlInspect(
  seam: { readonly inspect?: FrameXmlInspectModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  if (!seam.inspect) return () => {};
  const owner = createLazyFrameXmlInspectOwner(seam, boot, renderer, (unit) => {
    boot.vm.executeReported("if __fxStockInspectUnit then __fxStockInspectUnit(...) end", "@webclient/inspect-fallback", [unit]);
  }, (reason) => console.warn(`[FrameXML inspect] ${reason}; InspectUnit stays stock`));
  const unroute = routeFrameXmlInspectUnit(boot, owner);
  return () => {
    unroute();
    owner.dispose();
  };
}

/** The three windows at once; the cleanup unpublishes all three. */
export function mountFrameXmlInspectSocketBarber(
  seam: {
    readonly inspect?: FrameXmlInspectModel | undefined;
    readonly socket?: FrameXmlSocketModel | undefined;
    readonly barber?: FrameXmlBarberModel | undefined;
    readonly barberPrepare?: (() => Promise<void>) | undefined;
  },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  const cleanups = [
    mountFrameXmlInspect(seam, boot, renderer),
    mountFrameXmlSocket(seam, boot, renderer),
    mountFrameXmlBarber(seam, boot, renderer),
  ];
  return () => {
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch { /* the other windows still unpublish */ }
    }
  };
}
