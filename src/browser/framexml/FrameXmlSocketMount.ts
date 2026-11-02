/**
 * The world mount's one call for stock socketing: the lazy Blizzard_ItemSocketingUI owner
 * (FrameXmlSocketOwner.ts), published through FrameXmlSocketController.ts. A failed load or gate has
 * nothing to fall back to (WORK_PLAN 4.17): the window does not open.
 */
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
  const owner = createLazyFrameXmlSocketOwner(seam, boot, renderer, { open() {} },
    (reason) => console.warn(`[FrameXML socketing] ${reason}; the window will not open`));
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
