/**
 * Load-on-demand add-ons made ready before their first use (plan items 3.18 and 3.24).
 *
 * The client's `LoadAddOn` is synchronous: it reads the add-on's files and runs them inside the call.
 * Here files arrive over the network, so an add-on that a slash command or a window's first open loads
 * «and uses on the next line» — MSBT's `/msbt` over MSBTOptions (MSBTProfiles.lua:1554-1566), the
 * trainer's first open — would miss its first use. The world mount readies them one after another in
 * its own loading window, before the HUD is shown (FrameXmlWorldMount.ts, next to the stock clock's
 * add-on), in one of two ways:
 *
 * * the owners' add-ons (`FRAMEXML_PRELOADED_OWNER_ADDONS`) are loaded and run there, as decided below;
 * * 3.18 (owner, 12.10): third-party add-ons — the client's LoD add-ons outside FRAMEXML_LOD_POLICY,
 *   `frameXmlLodPrefetchNames` — are only read (FrameXmlBoot.prefetchAddon): their TOC and every file
 *   it and its XML pull in, kept in memory with nothing run, so `IsAddOnLoaded` stays nil as in
 *   Wow.exe until the add-on's own `LoadAddOn`, which then runs it inside the call and answers 1
 *   (FrameXmlAddonRuntime.loadStatus). Before this they were loaded and run here too — MSBTOptions
 *   126-139 ms and +8.2 MB in every session (measured for 3.24), loaded long before Wow.exe would load
 *   it. Measured 12.10 in Node off the client's files (tests/framexml-msbt-lod.test.mjs, three runs):
 *   the prefetch 15.5-25.9 ms here (12 files, 752 249 bytes of text, nothing run), and the LoadAddOn
 *   inside the first `/msbt` 14.0-15.3 ms, where Wow.exe pays its own load too; the same boot's
 *   asynchronous load of it took 26.7-28.2 ms. One whose read did not finish or failed is loaded by
 *   its LoadAddOn the asynchronous way (`NOT_READY`, then 1).
 *
 * Not in idle time after the reveal: a load yields between its steps, but a Lua file runs as one
 * block — measured in Node on the real corpus, Blizzard_TrainerUI.lua 11-18 ms and
 * MSBTOptionsPopups.lua 24 ms — and no idle slice of a 144 Hz frame (13.9 ms) fits that. A failed
 * load or read does not stop the rest; `cancel()` stops before the next one.
 */

import { FRAMEXML_LOD_POLICY } from "./FrameXmlAddonRuntime.js";
import type { FrameXmlClientAddon } from "./FrameXmlClientAddons.js";

/**
 * The owners' add-ons worth having before their first use: an owner here shows the native window
 * only while its add-on is not in yet (FrameXmlWorldMount.ts createLazyFrameXmlTrainerOwner). The
 * other owners (profession, auction, guild bank) still open natively first; they join this list when
 * they learn the same check. Blizzard_TrainerUI loads with no trainer open and raises nothing
 * (tests/framexml-trainer-first-open.test.mjs).
 *
 * L5c 3.24: the profession, auction and guild-bank owners learned it (FrameXmlTradeSkillOwner.ts
 * `open`, FrameXmlAuctionMount.ts and FrameXmlGuildBankMount.ts begin at publish), and their add-ons
 * load through their owners' host preparation (FrameXmlOwnerPreload.ts). Measured in Node on the
 * real corpus with the files already read, no window open, 0 Lua errors each: Blizzard_TradeSkillUI
 * 37 ms, Blizzard_AuctionUI 148 ms, Blizzard_GuildBankUI 75 ms — about +260 ms to the loading window
 * (tests/framexml-owner-preload.test.mjs pins the outcome, not the time).
 *
 * L5c-review 3.24 (owner pending): Blizzard_AuctionUI and Blizzard_GuildBankUI are back to loading at
 * the first visit, as before L5c, until the owner decides. Measured (Node, cached files): Auction
 * 131-147 ms with one uninterrupted 109-114 ms block and +13.0 MB retained heap, GuildBank 71-88 ms
 * with a 49-51 ms block and +8.5 MB, and at publish +1 801 / +1 157 frames reconciled into the renderer
 * (browser cost unmeasured), every session, on a loading window the world may already be drawn under.
 * The options: preload both again (add the names here and restore the publish-time `begin` in
 * FrameXmlAuctionMount.ts / FrameXmlGuildBankMount.ts), preload GuildBank only for guild members, or
 * keep the first visit. FrameXmlOwnerPreload.ts keeps their host preparation for that day.
 *
 * DEC-A 3.24: the owner decided 04.10 — preload both. Blizzard_AuctionUI and Blizzard_GuildBankUI are
 * back in this list and FrameXmlAuctionMount.ts / FrameXmlGuildBankMount.ts begin their owners at
 * publish again, exactly as L5c had it; the cost above (≈+250 ms and ≈+22.6 MB per session on the
 * loading window, the 109-114 ms Auction block) is accepted. The stop at a gateway that is down
 * (`frameXmlPreloadServerDown`) and the profession owner's «already loaded» check stay.
 */
export const FRAMEXML_PRELOADED_OWNER_ADDONS: readonly string[] = Object.freeze([
  "Blizzard_TrainerUI", "Blizzard_TradeSkillUI", // L5c 3.24: the second; L5c-review 3.24 (owner pending): Auction/GuildBank out
  "Blizzard_AuctionUI", "Blizzard_GuildBankUI", // DEC-A 3.24: owner decided 04.10: preload both
]);

/**
 * 3.18 (owner, 12.10): the third-party load-on-demand add-ons — the client's LoD add-ons outside
 * FRAMEXML_LOD_POLICY (MSBTOptions) — which the mount prefetches (reads, runs nothing).
 */
export function frameXmlLodPrefetchNames(clientAddons: readonly FrameXmlClientAddon[]): readonly string[] {
  const policy = new Set(Object.keys(FRAMEXML_LOD_POLICY).map((name) => name.toLowerCase()));
  return clientAddons.filter((addon) => addon.loadOnDemand && !policy.has(addon.name.toLowerCase())).map((addon) => addon.name);
}

/**
 * What the world mount readies, in order: the owners' list (loaded), then the third-party add-ons
 * (`frameXmlLodPrefetchNames`, prefetched only — the mount tells them apart by that list).
 */
export function frameXmlLodPreloadNames(clientAddons: readonly FrameXmlClientAddon[]): readonly string[] {
  return [...FRAMEXML_PRELOADED_OWNER_ADDONS, ...frameXmlLodPrefetchNames(clientAddons)];
}

export interface FrameXmlLodPreloadResult {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
}

export interface FrameXmlLodPreloadOptions {
  /** The names, in order. */
  readonly names: readonly string[];
  /**
   * One load; resolves with its outcome (FrameXmlBoot.loadAddon, an owner's own preload, or for a
   * third-party add-on FrameXmlBoot.prefetchAddon, 3.18).
   */
  readonly load: (name: string) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Awaited before each load (the mount checks there whether it was cancelled). */
  readonly idle?: () => Promise<void>;
  /** Told after each load. */
  readonly onResult?: (result: FrameXmlLodPreloadResult) => void;
  /**
   * L5c 3.24: true ends the preload after this result — the mount stops at a gateway that is down
   * (`frameXmlPreloadServerDown`): every later read would only wait out the same retries.
   */
  readonly stopAfter?: (result: FrameXmlLodPreloadResult) => boolean;
}

/**
 * L5c 3.24: a failure that was the gateway being unreachable (GlueRetry.ts's GlueServerUnavailableError,
 * after its 0.5 + 1.5 + 4 s of retries), as FrameXmlAddonRuntime words a failed read.
 */
export function frameXmlPreloadServerDown(result: FrameXmlLodPreloadResult): boolean {
  return !result.ok && /\bGlueServerUnavailableError\b/.test(result.message ?? "");
}

export interface FrameXmlLodPreload {
  /** Resolves when every name was tried or the preload was cancelled. */
  readonly done: Promise<readonly FrameXmlLodPreloadResult[]>;
  cancel(): void;
  readonly cancelled: boolean;
}

export function startFrameXmlLodPreload(options: FrameXmlLodPreloadOptions): FrameXmlLodPreload {
  let cancelled = false;
  const seen = new Set<string>();
  const names = options.names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const idle = options.idle ?? (() => Promise.resolve());
  const run = async (): Promise<readonly FrameXmlLodPreloadResult[]> => {
    const results: FrameXmlLodPreloadResult[] = [];
    for (const name of names) {
      await idle();
      if (cancelled) break;
      let result: FrameXmlLodPreloadResult;
      try {
        const outcome = await options.load(name);
        result = outcome.message === undefined
          ? { name, ok: outcome.ok } : { name, ok: outcome.ok, message: outcome.message };
      } catch (error) {
        result = { name, ok: false, message: String(error) };
      }
      if (cancelled) break;
      results.push(result);
      options.onResult?.(result);
      if (options.stopAfter?.(result) === true) break; // L5c 3.24
    }
    return results;
  };
  return {
    done: run(),
    cancel() {
      cancelled = true;
    },
    get cancelled() {
      return cancelled;
    },
  };
}
