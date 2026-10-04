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
import { createLazyFrameXmlGuildBankOwner, FRAMEXML_GUILDBANK_ADDON, type FrameXmlGuildBankSeam } from "./FrameXmlGuildBankOwner.js"; // DEC-A 3.24: the name again (L5c 3.24)

/**
 * Publish the lazy stock guild bank owner. Nothing loads at boot: the first banker visit (or a bank
 * already open now) starts the add-on, the native window keeps the visit until the stock tree passes
 * its gate, and the returned cleanup hands a bank that is still open back to it.
 * DEC-A 3.24: an add-on the mount's loading window preloaded starts the owner here, at publish.
 */
export function mountFrameXmlGuildBank(
  seam: FrameXmlGuildBankSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon"> & Partial<Pick<FrameXmlBoot, "isAddonLoaded">>, // DEC-A 3.24: as L5c 3.24
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
): () => void {
  const model = seam.guildBank;
  if (!model) return () => {};
  const owner = createLazyFrameXmlGuildBankOwner(seam, boot, renderer, {
    hide: () => stepAsideGuildBank(),
    show: () => showGuildBank(),
  }, (reason) => console.warn(`[FrameXML guild bank] ${reason}; the native window stays`));
  const release = publishFrameXmlGuildBank(owner);
  // L5c-review 3.24 (owner pending) withdrew L5c's publish-time `begin` with the preload.
  // DEC-A 3.24: the owner decided 04.10 — preload both — so it is back as L5c had it: an add-on the
  // loading window already has in passes its gate now, and the first banker visit opens straight
  // into the stock GuildBankFrame (FrameXmlOwnerPreload.ts, FrameXmlLodPreload.ts).
  if (model.bankOpen() || boot.isAddonLoaded?.(FRAMEXML_GUILDBANK_ADDON) === true) owner.begin(); // DEC-A 3.24
  return () => {
    release();
    try { showGuildBank(); } catch { /* the page may already be tearing down */ }
  };
}
