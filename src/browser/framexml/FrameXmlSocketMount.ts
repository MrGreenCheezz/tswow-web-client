/**
 * The world mount's one call for stock socketing: the lazy Blizzard_ItemSocketingUI owner
 * (FrameXmlSocketOwner.ts) with the native picker as its fallback, published through
 * FrameXmlSocketController.ts. Kept apart from the owner so the owner and its tests stay free of the
 * page's DOM modules.
 */
import { openSocketingFromLua } from "../ui/Socketing.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlSocketModel } from "./FrameXmlSocketModel.js";
import { publishFrameXmlSocket } from "./FrameXmlSocketController.js";
import { createLazyFrameXmlSocketOwner } from "./FrameXmlSocketOwner.js";

/**
 * Publish the lazy stock socketing owner. Nothing loads at boot: the first SocketInventoryItem or
 * SocketContainerItem (the stock bags' and paper doll's modified click, gem-abilities' /socket, the
 * native «Вставить камни») starts the add-on. The returned cleanup ends an open stock session.
 */
export function mountFrameXmlSocket(
  seam: { readonly socket?: FrameXmlSocketModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  const model = seam.socket;
  if (!model) return () => {};
  const owner = createLazyFrameXmlSocketOwner(seam, boot, renderer, {
    open: (target) => { openSocketingFromLua(target.location, target.bag, target.slot); },
  }, (reason) => console.warn(`[FrameXML socketing] ${reason}; the native picker stays`));
  const release = publishFrameXmlSocket({
    open: (target) => {
      if (owner.failed) return false;
      // The stock entry point, so gem-abilities' hooksecurefunc on it records the location too.
      if (target.location === 0) boot.vm.executeReported("SocketInventoryItem(...)", "@webclient/socket-native", [target.slot]);
      else boot.vm.executeReported("SocketContainerItem(...)", "@webclient/socket-native", [target.bag, target.slot]);
      return !owner.failed && model.active;
    },
    isOpen: () => owner.isOpen(),
    close: () => owner.close(),
  });
  return () => {
    release();
    owner.dispose();
  };
}
