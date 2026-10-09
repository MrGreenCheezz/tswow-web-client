/**
 * Blizzard_BattlefieldMinimap is a load-on-demand add-on this client does not load yet (plan M6:
 * `DEFAULT_LOAD_ON_DEMAND`, FrameXmlAddonRuntime.ts, carries only the talent and trainer add-ons).
 * Three stock paths reach it, each as «if it may be shown: load it unless loaded, then
 * `BattlefieldMinimap:Show()`»: WorldStateFrame_ToggleBattlefieldMinimap on every
 * PLAYER_ENTERING_WORLD (WorldStateFrame.lua:359-373), UIParent's VARIABLES_LOADED
 * (UIParent.lua:458-462) and the world map's zone-map dropdown (WorldMapFrame.lua:691-695). The
 * permission is `WorldStateFrame_CanShowBattlefieldMinimap` (:376-386): `IsInInstance()` "pvp" with
 * the CVar showBattlefieldMinimap "1" (its default), or "none" with "2". Unloadable, the add-on is
 * `UIParentLoadAddOn`'s `message()` once a session (UIParent.lua:234-241) and then
 * «attempt to index global 'BattlefieldMinimap'» on the `:Show()` — on every battleground entry once
 * `IsInInstance` answers "pvp" (plan item 1.08).
 *
 * Until the add-on is supported the refusal is made honest and silent, right after the corpus loaded
 * and before the session events: `BattlefieldMinimap_LoadUI` does nothing, and the permission is
 * stock's answer only while a `BattlefieldMinimap` frame exists — without one it is false, so none
 * of the three paths reaches `:Show()`. The CVar is the player's setting and is left alone; the
 * keybinding's ToggleBattlefieldMinimap (UIParent.lua:392-397) already guards on
 * `BattlefieldMinimap_Toggle`.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";

export const FRAMEXML_BATTLEFIELD_MINIMAP_REFUSAL = `
if type(BattlefieldMinimap_LoadUI) == "function" and type(WorldStateFrame_CanShowBattlefieldMinimap) == "function" then
  local canShow = WorldStateFrame_CanShowBattlefieldMinimap
  BattlefieldMinimap_LoadUI = function() end
  WorldStateFrame_CanShowBattlefieldMinimap = function(...)
    if rawget(_G, "BattlefieldMinimap") == nil then return false end
    return canShow(...)
  end
end
`;

/** Installs the refusal; a boot without UIParent's or WorldStateFrame's functions is left as it is. */
export function installFrameXmlBattlefieldMinimapRefusal(boot: Pick<FrameXmlBoot, "vm">): boolean {
  return boot.vm.executeReported(FRAMEXML_BATTLEFIELD_MINIMAP_REFUSAL, "@webclient/battlefield-minimap");
}
