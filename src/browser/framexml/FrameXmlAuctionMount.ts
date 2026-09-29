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
import { createLazyFrameXmlAuctionOwner } from "./FrameXmlAuctionOwner.js";

/**
 * Publish the lazy stock auction owner. Nothing loads at boot: the first MSG_AUCTION_HELLO (or a
 * house already open now) starts the add-on, the native window keeps the visit until the stock
 * tree passes its gate, and the returned cleanup hands a house that is still open back to it.
 */
export function mountFrameXmlAuction(
  seam: { readonly auction?: FrameXmlAuctionModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  const model = seam.auction;
  if (!model) return () => {};
  const owner = createLazyFrameXmlAuctionOwner(seam, boot, renderer, {
    hide: () => { auctionWindow.hidden = true; },
    show: () => showAuctions(),
  }, (reason) => console.warn(`[FrameXML auction] ${reason}; the native window stays`));
  const release = publishFrameXmlAuction(owner);
  if (model.houseOpen()) owner.begin();
  return () => {
    release();
    try { showAuctions(); } catch { /* the page may already be tearing down */ }
  };
}
