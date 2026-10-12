/**
 * Owners' load-on-demand add-ons loaded in the mount's loading window (plan item 3.24, L5c 04.10).
 *
 * The trainer's add-on is preloaded bare (FrameXmlLodPreload.ts); the auction house and the guild
 * vault need their owner's host preparation before their Lua runs — the same two calls their owners
 * make in `load` (installFrameXmlAuctionPreload: DressUpTexturePath; installFrameXmlGuildBankPreload:
 * the tab info bindings) — so this is the one load the preloader calls for every name. The owners'
 * later `load` finds the add-on in (`boot.loadAddon` is idempotent) and only adds roots, reconciles
 * and runs its gate, all within the task of the first open.
 *
 * L5c-review 3.24 (owner pending): the auction and guild-bank names are out of the preload list
 * (FrameXmlLodPreload.ts) until the owner decides; their branches here stay ready for that, and every
 * other name is the plain `boot.loadAddon` it was before L5c.
 *
 * DEC-A 3.24: the owner decided 04.10 — preload both: the auction and guild-bank names are in the
 * list again, so both branches here run in every mount's loading window.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlAddonRuntimeResult } from "./FrameXmlAddonRuntime.js";
import { FRAMEXML_AUCTION_ADDON, installFrameXmlAuctionPreload } from "./FrameXmlAuctionOwner.js";
import { FRAMEXML_GUILDBANK_ADDON, installFrameXmlGuildBankPreload } from "./FrameXmlGuildBankOwner.js";

/**
 * 3.18 (owner, 12.10): the mount preloader's step for one name. A third-party add-on (one of
 * `prefetchNames`, FrameXmlLodPreload.ts frameXmlLodPrefetchNames) is only read — its LoadAddOn runs it
 * inside the call later, as Wow.exe does; every other name is an owner's add-on, loaded as before.
 */
export function frameXmlLodPreloadStep(
  boot: Pick<FrameXmlBoot, "vm" | "loadAddon" | "prefetchAddon">,
  prefetchNames: readonly string[],
): (name: string) => Promise<Pick<FrameXmlAddonRuntimeResult, "ok" | "message">> {
  const prefetched = new Set(prefetchNames.map((name) => name.toLowerCase()));
  return (name) => prefetched.has(name.toLowerCase())
    ? boot.prefetchAddon(name)
    : frameXmlPreloadOwnerAddon(boot, name);
}

export async function frameXmlPreloadOwnerAddon(
  boot: Pick<FrameXmlBoot, "vm" | "loadAddon">,
  name: string,
): Promise<Pick<FrameXmlAddonRuntimeResult, "ok" | "message">> {
  const lower = name.toLowerCase();
  if (lower === FRAMEXML_AUCTION_ADDON.toLowerCase() && !installFrameXmlAuctionPreload(boot)) {
    return { ok: false, message: "the auction preload did not install" };
  }
  if (lower === FRAMEXML_GUILDBANK_ADDON.toLowerCase() && !installFrameXmlGuildBankPreload(boot)) {
    return { ok: false, message: "the vault's tab info is not bound" };
  }
  return await boot.loadAddon(name);
}
