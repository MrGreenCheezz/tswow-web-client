/**
 * 05.10-L17t 3.14: the TOGGLEBATTLEFIELDMINIMAP key (Shift+M, DefaultBindings.wtf; BINDING_NAME «Карта
 * зоны»). Its Bindings.xml body (FrameXML/Bindings.xml:703-705) is stock UIParent's
 * `ToggleBattlefieldMinimap()` (UIParent.lua:392-397), and that is all the key runs: the mounted stock UI
 * hooks it to the load-on-demand owner (FrameXmlBattlefieldMinimapLod.ts), which loads
 * Blizzard_BattlefieldMinimap through the host and replays stock BattlefieldMinimap_Toggle. Every decision
 * stays stock's — in a battleground «pvp» it shows with CVar showBattlefieldMinimap "1", in an arena it
 * does not show, elsewhere it shows the zone map with "2", and a shown one hides with "0" — as the same
 * Lua does in Wow.exe.
 *
 * Without the stock UI (or in the add-ons-only mount, which paints no stock HUD) nothing is published and
 * the key answers false: the native HUD has no zone minimap to toggle.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";

let toggle: (() => void) | undefined;

/** The mounted stock UI takes the key; the cleanup unpublishes only its own boot. */
export function publishFrameXmlBattlefieldMinimapKey(boot: Pick<FrameXmlBoot, "vm">): () => void {
  const next = (): void => {
    boot.vm.executeReported("ToggleBattlefieldMinimap()", "@webclient/toggle-battlefield-minimap");
  };
  toggle = next;
  return () => {
    if (toggle === next) toggle = undefined;
  };
}

/** The key's verb: false when no stock UI is mounted. */
export function toggleFrameXmlBattlefieldMinimap(): boolean {
  const current = toggle;
  if (!current) return false;
  try {
    current();
  } catch {
    // A closed VM during teardown; the stock route stays authoritative until its cleanup runs.
  }
  return true;
}
