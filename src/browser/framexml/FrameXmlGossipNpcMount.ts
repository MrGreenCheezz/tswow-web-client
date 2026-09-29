/**
 * The world mount's one entry into the NPC windows (FrameXmlGossipNpcWindows.ts), with the native
 * side filled in: the Npc.ts/Bank.ts repaint each fallback does through its own step-aside hook,
 * Windows.ts Escape, and the gateway's `/dbc/taxi` client — one per mount, fetched on the first
 * flight map, the catalog the native window plans with.
 */
import { gatewayOrigin } from "../Environment.js";
import { game } from "../game/Context.js";
import { TaxiMetadataClient } from "../TaxiMetadata.js";
import { showBank } from "../ui/Bank.js";
import { showGossip, showTabardVendor, showTaxiMenu } from "../ui/Npc.js";
import { showPetition } from "../ui/Petition.js";
import { registerEscapable } from "../ui/Windows.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { createFrameXmlNpcWindows, type FrameXmlNpcWindows, type FrameXmlNpcWindowsSeam } from "./FrameXmlGossipNpcWindows.js";

/**
 * Repaint only what the world holds open: the native gossip and taxi share `#gossip-window` with
 * the quest greeting and the battlemaster/tabard dialogs, and an unconditional `showGossip()` would
 * hide one of those.
 */
function refreshNativeNpcWindows(): void {
  const world = game.world;
  if (world?.gossip) showGossip();
  if (world?.taxiMenu) showTaxiMenu();
  showBank();
  // The charter fallbacks: the emblem designer shares `#gossip-window`, and `#petition-window` is
  // repainted only for a charter or a vendor list still held (its query cache alone opens nothing).
  if (world && world.tabardVendorGuid !== 0n) showTabardVendor();
  if (world?.petitionSignatures || world?.petitionVendor) showPetition();
}

export function mountFrameXmlNpcWindows(
  seam: FrameXmlNpcWindowsSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  hostId: string,
): FrameXmlNpcWindows {
  const windows = createFrameXmlNpcWindows(seam, boot, renderer, {
    refresh: refreshNativeNpcWindows,
    registerEscapable,
    taxiCatalog: new TaxiMetadataClient(game.gatewayOrigin ?? gatewayOrigin(window.location)),
    document,
    hostId,
  });
  const failed = Object.entries(windows.gates).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length > 0) console.warn(`[FrameXML NPC] stock ${failed.join(", ")} not published; the native windows stay`);
  return windows;
}
