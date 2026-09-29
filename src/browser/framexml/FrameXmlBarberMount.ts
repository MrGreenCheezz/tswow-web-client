/**
 * The world mount's one call for the stock barber shop: the lazy Blizzard_BarbershopUI owner
 * (FrameXmlBarberOwner.ts) with the native `#barber-window` as its fallback, published through
 * FrameXmlBarberController.ts. Kept apart from the owner so the owner and its tests stay free of the
 * page's DOM modules.
 */
import { closeBarberShop, showBarberShop } from "../ui/BarberShop.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlBarberModel } from "./FrameXmlBarber.js";
import { publishFrameXmlBarber } from "./FrameXmlBarberController.js";
import { createLazyFrameXmlBarberOwner } from "./FrameXmlBarberOwner.js";

/** What the seam carries for the barber: the model and the tables' fetch (FrameXmlBarberLive.ts). */
export interface FrameXmlBarberMountSeam {
  readonly barber?: FrameXmlBarberModel | undefined;
  readonly barberPrepare?: (() => Promise<void>) | undefined;
}

/**
 * Publish the lazy stock barber owner. Nothing loads at boot: the first chair (or one occupied now)
 * starts the add-on, and the native window keeps the chair until the stock frame passed its gate.
 * The returned cleanup hands a chair still occupied back to the native window.
 */
export function mountFrameXmlBarber(
  seam: FrameXmlBarberMountSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "loadAddon" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  const model = seam.barber;
  if (!model) return () => {};
  const owner = createLazyFrameXmlBarberOwner(seam, boot, renderer, {
    hide: () => closeBarberShop(),
    show: () => showBarberShop(),
  }, seam.barberPrepare ?? (() => Promise.resolve()),
  (reason) => console.warn(`[FrameXML barber] ${reason}; the native window stays`));
  const release = publishFrameXmlBarber({ ownsShop: () => owner.ownsShop(), isOpen: () => owner.isOpen() });
  // A chair already occupied when the mount publishes (a /reload in the chair); not a chair left earlier.
  model.resume();
  return () => {
    // Only a chair the stock frame still held goes back: WorldClient's barberShopOpen outlives a
    // stand-up without a haircut, so it alone would reopen the native window for an empty chair.
    const held = owner.ownsShop() && model.open;
    release();
    owner.dispose();
    if (held) {
      try { showBarberShop(); } catch { /* the page may already be tearing down */ }
    }
  };
}
