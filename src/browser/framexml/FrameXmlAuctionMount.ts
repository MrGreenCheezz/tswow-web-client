/**
 * The world mount's one call for the stock auction house: the lazy Blizzard_AuctionUI owner
 * (FrameXmlAuctionOwner.ts) wired to the native `#auction-window` and published through
 * FrameXmlAuctionController.ts. Kept apart from the owner so the owner and its tests stay free of
 * the page's DOM modules.
 */
import { auctionWindow } from "../ui/Dom.js";
import { showAuctions } from "../ui/Social.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlAuctionModel } from "./FrameXmlAuction.js";
import { publishFrameXmlAuction } from "./FrameXmlAuctionController.js";
import { createLazyFrameXmlAuctionOwner, FRAMEXML_AUCTION_ADDON } from "./FrameXmlAuctionOwner.js"; // DEC-A 3.24: the name again (L5c 3.24)

/**
 * Publish the lazy stock auction owner. Nothing loads at boot: the first MSG_AUCTION_HELLO (or a
 * house already open now) starts the add-on, the native window keeps the visit until the stock
 * tree passes its gate, and the returned cleanup hands a house that is still open back to it.
 * DEC-A 3.24: an add-on the mount's loading window preloaded starts the owner here, at publish.
 */
export function mountFrameXmlAuction(
  seam: { readonly auction?: FrameXmlAuctionModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon"> & Partial<Pick<FrameXmlBoot, "isAddonLoaded">>, // DEC-A 3.24: as L5c 3.24
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  const model = seam.auction;
  if (!model) return () => {};
  const owner = createLazyFrameXmlAuctionOwner(seam, boot, renderer, {
    hide: () => { auctionWindow.hidden = true; },
    show: () => showAuctions(),
  }, (reason) => console.warn(`[FrameXML auction] ${reason}; the native window stays`));
  const release = publishFrameXmlAuction(owner);
  // L5c-review 3.24 (owner pending) withdrew L5c's publish-time `begin` with the preload.
  // DEC-A 3.24: the owner decided 04.10 — preload both — so it is back as L5c had it: an add-on the
  // loading window already has in passes its gate now, and the first auctioneer opens straight into
  // the stock AuctionFrame (FrameXmlOwnerPreload.ts, FrameXmlLodPreload.ts).
  if (model.houseOpen() || boot.isAddonLoaded?.(FRAMEXML_AUCTION_ADDON) === true) owner.begin(); // DEC-A 3.24
  return () => {
    release();
    try { showAuctions(); } catch { /* the page may already be tearing down */ }
  };
}
