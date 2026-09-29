/**
 * The world mount's one call for the stock guild bank: the lazy Blizzard_GuildBankUI owner
 * (FrameXmlGuildBankOwner.ts) wired to the native `#guild-bank-window` (ui/GuildBank.ts) and published
 * through FrameXmlGuildBankController.ts. Kept apart from the owner so the owner and its tests stay
 * free of the page's DOM modules.
 */
import { showGuildBank, stepAsideGuildBank } from "../ui/GuildBank.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { publishFrameXmlGuildBank } from "./FrameXmlGuildBankController.js";
import { createLazyFrameXmlGuildBankOwner, type FrameXmlGuildBankSeam } from "./FrameXmlGuildBankOwner.js";

/**
 * Publish the lazy stock guild bank owner. Nothing loads at boot: the first banker visit (or a bank
 * already open now) starts the add-on, the native window keeps the visit until the stock tree passes
 * its gate, and the returned cleanup hands a bank that is still open back to it.
 */
export function mountFrameXmlGuildBank(
  seam: FrameXmlGuildBankSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  const model = seam.guildBank;
  if (!model) return () => {};
  const owner = createLazyFrameXmlGuildBankOwner(seam, boot, renderer, {
    hide: () => stepAsideGuildBank(),
    show: () => showGuildBank(),
  }, (reason) => console.warn(`[FrameXML guild bank] ${reason}; the native window stays`));
  const release = publishFrameXmlGuildBank(owner);
  if (model.bankOpen()) owner.begin();
  return () => {
    release();
    try { showGuildBank(); } catch { /* the page may already be tearing down */ }
  };
}
