/**
 * Plan item 3.01, slice E: the owner of Blizzard_CombatLog.
 *
 * The original loads it from UIParent's PLAYER_LOGIN (`CombatLog_LoadUI`, UIParent.lua:480-483)
 * through its synchronous LoadAddOn. This client's LoadAddOn is not synchronous, so UIParent's call
 * stays refused (FrameXmlLoginEdge.ts) and the world mount loads the add-on itself in its loading
 * window, after the session events and before the reveal — as it loads the stock clock — never during
 * play (FrameXmlLodPreload.ts leaves policy add-ons alone). Its ADDON_LOADED handler then applies the
 * saved filters and refills ChatFrame2 from the buffer (`Blizzard_CombatLog_Refilter`).
 *
 * Once it is in, the native combat lines must stop being mirrored into ChatFrame2
 * (FrameXmlChatApi.ts `combatWindowEnabled`), or every line would print twice.
 */

/** The add-on, as FRAMEXML_LOD_POLICY names it. */
export const FRAMEXML_COMBAT_LOG_ADDON = "Blizzard_CombatLog";

export interface FrameXmlCombatLogOwnerBoot {
  loadAddon(name: string): Promise<{ readonly ok: boolean; readonly message?: string; readonly status?: string }>;
  isAddonLoaded(name: unknown): boolean;
}

/** Load Blizzard_CombatLog once; false when it is missing or failed (the native mirror stays). */
export async function loadFrameXmlCombatLog(boot: FrameXmlCombatLogOwnerBoot): Promise<boolean> {
  if (boot.isAddonLoaded(FRAMEXML_COMBAT_LOG_ADDON)) return true;
  const result = await boot.loadAddon(FRAMEXML_COMBAT_LOG_ADDON);
  if (!result.ok) {
    console.warn(`[framexml] ${FRAMEXML_COMBAT_LOG_ADDON}: ${result.message ?? result.status ?? "failed"}`);
    return false;
  }
  return true;
}

/** Whether the stock combat log owns ChatFrame2 (the native mirror must be off). */
export function frameXmlCombatLogOwned(boot: Pick<FrameXmlCombatLogOwnerBoot, "isAddonLoaded">): boolean {
  return boot.isAddonLoaded(FRAMEXML_COMBAT_LOG_ADDON);
}
