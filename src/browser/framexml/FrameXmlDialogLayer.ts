import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import { FRAMEXML_STATIC_POPUP_COUNT } from "./FrameXmlPopupsOwner.js";
import { FRAMEXML_HOST_HOOK_GLOBAL, withFrameXmlHostHooks } from "./FrameXmlHostHooks.js"; // L5b 3.27

/** The dialogs the popups owner shows, the ones `watchFrameXmlDialogLayer` keeps over the native windows. */
const DIALOG_LAYER_FRAMES: readonly string[] = Object.freeze([
  ...Array.from({ length: FRAMEXML_STATIC_POPUP_COUNT }, (_unused, index) => `StaticPopup${index + 1}`),
  "ReadyCheckFrame",
]);

/** The one-shot host binding the layer hooks capture; nil again in the same chunk. */
const LAYER_GLOBAL = "__fxDialogLayerChanged";

/**
 * The stock dialogs over the native windows. The overlay host sits at z-index 3, under every native
 * window (GameWindows.ts: 31 and up, opened near the top of the viewport). While dialogs were modal
 * such a window went inert and a click on the popup under it fell through to the popup; now the window
 * takes the click, and a PARTY_INVITE or DELETE_ITEM popup under an open GM-ticket or barber window
 * could not be answered until the window moved. So while any of StaticPopup1-4 or ReadyCheckFrame is
 * shown the host is raised over the native windows — again at every show, over whatever opened since —
 * and when the last one hides it falls back. Answers the release; the hooks live and die with the VM.
 */
export function watchFrameXmlDialogLayer(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  layer: { raise(): void; lower(): void },
): () => void {
  let active = true;
  let raised = false;
  const shown = (): boolean => DIALOG_LAYER_FRAMES.some((name) => {
    const frame = boot.bridge.getFrame(name);
    return frame !== undefined && boot.bridge.isVisible(frame);
  });
  const settle = (showing: boolean): void => {
    if (!active) return;
    try {
      if (showing) {
        layer.raise();
        raised = true;
      } else if (raised && !shown()) {
        layer.lower();
        raised = false;
      }
    } catch {
      // The layer order is cosmetic; the dialog itself is already shown or gone.
    }
  };
  boot.vm.registerGlobal(LAYER_GLOBAL, (args) => {
    settle(args[0] === true);
    return [];
  });
  try {
    // L5b 3.27: host hooks (FrameXmlHostHooks.ts): an add-on's SetScript on these scripts keeps them.
    withFrameXmlHostHooks(boot, () => frameXmlSilentProbe(boot, "webclient/dialog-layer", `
      local changed = ${LAYER_GLOBAL}
      ${LAYER_GLOBAL} = nil
      if type(changed) ~= "function" then return 0 end
      local hooked = 0
      for _, name in ipairs({ ${DIALOG_LAYER_FRAMES.map((name) => `"${name}"`).join(", ")} }) do
        local frame = _G[name]
        if type(frame) == "table" and type(frame.HookScript) == "function" then
          ${FRAMEXML_HOST_HOOK_GLOBAL}(frame, "OnShow", function() changed(true) end) -- L5b 3.27 (was frame:HookScript)
          ${FRAMEXML_HOST_HOOK_GLOBAL}(frame, "OnHide", function() changed(false) end) -- L5b 3.27 (was frame:HookScript)
          hooked = hooked + 1
        end
      end
      return hooked
    `, 1)); // L5b 3.27: withFrameXmlHostHooks
  } finally {
    boot.vm.setGlobal(LAYER_GLOBAL, undefined);
  }
  // A dialog already up when the watch starts (shown while the corpus loaded) is lifted at once.
  if (shown()) settle(true);
  return () => { active = false; };
}
