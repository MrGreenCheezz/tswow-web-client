import type { FrameXmlBoot } from "./FrameXmlBoot.js";

/**
 * 11.02-F2-review: the stock micro-button row kept hidden for good once the world mount's owner gate
 * refused it (FrameXmlWorldMount.ts `frameXmlMicroButtonOwnerGate`; the native C/B/P/N/J/gear row stays).
 *
 * A plain Hide no longer holds since VehicleMenuBar.xml (TOC 142) and AnimationSystem.lua (144) are in the
 * vertical: `VehicleMenuBar_MoveMicroButtons` (VehicleMenuBar.lua:713-753) re-parents and Shows all ten
 * on every call — from `MainMenuBar_ToPlayerArt` (MainMenuBar.lua:136) on each PLAYER_ENTERING_WORLD after
 * the first, a loading screen's, and from `VehicleMenuBar_SetSkin` on entering a vehicle. Before 11.02-F2
 * the name was the stub floor's no-op. In Wow.exe the row is always shown, so those Shows change nothing
 * there; here they would put a second, unproven row beside the native one. The hook hides the row again
 * right after each move, inside the same call.
 */
export function holdFrameXmlMicroButtonsHidden(boot: Pick<FrameXmlBoot, "bridge" | "vm">, names: readonly string[]): void {
  for (const name of names) {
    const frame = boot.bridge.getFrame(name);
    if (frame) boot.bridge.Hide(frame);
  }
  boot.vm.executeReported(`local names = ...
    if type(rawget(_G, "VehicleMenuBar_MoveMicroButtons")) ~= "function" then return end
    hooksecurefunc("VehicleMenuBar_MoveMicroButtons", function()
      for index = 1, #names do
        local button = rawget(_G, names[index])
        if button then button:Hide() end
      end
    end)`, "@webclient/microbuttons-hold", [[...names]]);
}
