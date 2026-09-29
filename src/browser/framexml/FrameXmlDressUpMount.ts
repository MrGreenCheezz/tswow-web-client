/**
 * The world mount's one call for the stock dressing room: the DressUpFrame gate
 * (FrameXmlDressUp.ts), the DressUpModel methods and IsDressableItem bound to the live host
 * (FrameXmlDressUpLive.ts), and the model stage (FrameXmlDressUpStage.ts). Kept apart so the owner
 * and its tests stay free of the page's world modules.
 *
 * There is no native dressing room to step aside for: when the gate fails nothing is installed and
 * DressUpItemLink stays the corpus' own, whose IsDressableItem is the stub plan's nil — a Ctrl+click
 * then does nothing, as before this owner.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { game } from "../game/Context.js";
import { FrameXmlDressUpModels, frameXmlDressUpGate, installFrameXmlDressUp } from "./FrameXmlDressUp.js";
import { createLiveFrameXmlDressUpHost } from "./FrameXmlDressUpLive.js";
import { FrameXmlDressUpStage } from "./FrameXmlDressUpStage.js";

export function mountFrameXmlDressUp(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  options: { readonly gatewayOrigin: string },
): (() => void) | undefined {
  if (!frameXmlDressUpGate(boot, renderer)) {
    console.warn("[FrameXML dress-up] the stock DressUpFrame tree did not pass its gate; Ctrl+click stays inert");
    return undefined;
  }
  const models = new FrameXmlDressUpModels(createLiveFrameXmlDressUpHost());
  const stage = new FrameXmlDressUpStage({
    gatewayOrigin: options.gatewayOrigin,
    models,
    elementFor: (frame) => renderer.elementFor(frame),
    isVisible: (frame) => boot.bridge.isVisible(frame),
    creatureModels: game.creatureModels,
    onDiagnostic: (message) => console.warn("[FrameXML dress-up]", message),
  });
  if (!installFrameXmlDressUp(boot, models, () => stage.wake())) {
    stage.dispose();
    console.warn("[FrameXML dress-up] the DressUpModel methods could not be installed");
    return undefined;
  }
  return () => {
    stage.dispose();
    models.dispose();
  };
}
