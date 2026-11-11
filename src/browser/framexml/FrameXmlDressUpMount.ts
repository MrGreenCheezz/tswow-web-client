/**
 * The world mount's one call for the models that show a unit: the stock dressing room — the
 * DressUpFrame gate (FrameXmlDressUp.ts), the DressUpModel methods and IsDressableItem bound to the
 * live host (FrameXmlDressUpLive.ts) — and, since 11.11 (6.18, 3.21), every PlayerModel's
 * SetUnit/RefreshUnit (FrameXmlUnitModel.ts, FrameXmlUnitModelLive.ts): the character, pet and
 * inspect windows. One model stage (FrameXmlDressUpStage.ts) draws them all. Kept apart so the owners
 * and their tests stay free of the page's world modules.
 *
 * There is no native dressing room to step aside for: when the gate fails the DressUpModel methods
 * are not installed and DressUpItemLink stays the corpus' own, whose IsDressableItem is the stub
 * plan's nil — a Ctrl+click then does nothing, as before this owner. The PlayerModel methods do not
 * depend on that gate.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { game } from "../game/Context.js";
import { FrameXmlDressUpModels, frameXmlDressUpGate, installFrameXmlDressUp } from "./FrameXmlDressUp.js";
import { createLiveFrameXmlDressUpHost } from "./FrameXmlDressUpLive.js";
import { FrameXmlDressUpStage } from "./FrameXmlDressUpStage.js";
import { FrameXmlModelTurns, FrameXmlUnitModels, installFrameXmlUnitModels } from "./FrameXmlUnitModel.js";
import { createLiveFrameXmlUnitModelHost } from "./FrameXmlUnitModelLive.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export function mountFrameXmlDressUp(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  options: { readonly gatewayOrigin: string },
): (() => void) | undefined {
  const dressable = frameXmlDressUpGate(boot, renderer) !== undefined;
  if (!dressable) {
    console.warn("[FrameXML dress-up] the stock DressUpFrame tree did not pass its gate; Ctrl+click stays inert");
  }
  const models = new FrameXmlDressUpModels(createLiveFrameXmlDressUpHost());
  const units = new FrameXmlUnitModels(createLiveFrameXmlUnitModelHost());
  // The stage is made below; the turn rule asks it which clips a shown model holds.
  let stage: FrameXmlDressUpStage | undefined;
  const turns = new FrameXmlModelTurns({
    hasAnimation: (frame, animation) => stage?.hasAnimation(frame, animation) ?? false,
    playing: (frame) => frame.model.sequence ?? 0,
    play: (frame, animation) => { boot.bridge.update(frame, (m) => { m.model.sequence = animation; }); },
    now: () => performance.now(),
  });
  stage = new FrameXmlDressUpStage({
    gatewayOrigin: options.gatewayOrigin,
    models,
    units,
    turns,
    elementFor: (frame) => renderer.elementFor(frame),
    isVisible: (frame) => boot.bridge.isVisible(frame),
    creatureModels: game.creatureModels,
    onDiagnostic: (message) => console.warn("[FrameXML dress-up]", message),
  });
  const shown = stage;
  const wake = (): void => shown.wake();
  const dressUp = dressable && installFrameXmlDressUp(boot, models, wake, turns);
  if (dressable && !dressUp) console.warn("[FrameXML dress-up] the DressUpModel methods could not be installed");
  const playerModels = installFrameXmlUnitModels(boot, units, turns, wake);
  if (!playerModels) console.warn("[FrameXML unit models] no stock PlayerModel to install SetUnit/RefreshUnit through");
  // PaperDollFrame_OnEvent's PLAYER_ENTERING_WORLD branch (PaperDollFrame.lua:157-159) may have run
  // with the widget layer's stub before this install; its one effect is repeated here.
  else frameXmlSilentProbe(boot, "@webclient/player-model-pew",
    "if CharacterModelFrame and UnitGUID('player') then CharacterModelFrame:SetUnit('player') end return 1", 1);
  if (!dressUp && !playerModels) {
    shown.dispose();
    return undefined;
  }
  return () => {
    shown.dispose();
    models.dispose();
    units.dispose();
    turns.dispose();
  };
}
