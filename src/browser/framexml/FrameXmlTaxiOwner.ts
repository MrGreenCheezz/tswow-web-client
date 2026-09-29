/**
 * Stock TaxiFrame as the flight map: the gate, the published owner and `SetTaxiMap`. The C API is
 * FrameXmlTaxi.ts.
 *
 * TaxiFrame.xml loads at its retail slot after ItemTextFrame.xml (stock TOC line 99); the frame is
 * `parent="UIParent" hidden="true"`. Its node buttons are created by TaxiFrame_OnEvent itself
 * (`CreateFrame("Button", "TaxiButton"..i, TaxiRouteMap, "TaxiButtonTemplate")`) and its route
 * lines by TaxiNodeOnButtonEnter/DrawOneHopLines, so the tree grows on the first map.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlTaxiModel } from "./FrameXmlTaxi.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";
import {
  FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_CONTINENT, FRAMEXML_CANNED_TAXI_MENU,
} from "./FrameXmlTaxiCanned.js";

const TAXI_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["TaxiFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["TaxiMap", "Texture", []],
  ["TaxiRouteMap", "Frame", []],
  ["TaxiMerchant", "FontString", []],
  ["TaxiPortrait", "Texture", []],
  ["TaxiCloseButton", "Button", ["OnClick"]],
];

/**
 * `SetTaxiMap(texture)` points the Texture stock hands it at the continent's own flight-map picture
 * (`WebClientTaxiMapTexture`, FrameXmlTaxi.ts). A C API that takes a widget needs the bridge, so it
 * is installed here after load, replacing the stub-plan answer.
 */
export function installFrameXmlTaxiMap(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  taxi: FrameXmlTaxiModel,
): void {
  boot.vm.registerGlobal("SetTaxiMap", (args) => {
    const texture = args[0] && typeof args[0] === "object"
      ? boot.bridge.resolve(args[0] as FrameXmlFrame) : undefined;
    const path = taxi.mapTexture();
    if (texture?.type === "Texture" && path) boot.bridge.SetTexture(texture, path);
    return [];
  });
}

export interface FrameXmlTaxiGateResult {
  readonly frame: FrameXmlFrame;
  /** Measured by the probe: node buttons shown for the probe map and route lines drawn on hover. */
  readonly nodes: number;
  readonly lines: number;
}

/**
 * Structural, rendered and transactional proof that stock TaxiFrame can own flight maps.
 *
 * The probe opens the canned Stormwind map (FrameXmlTaxiCanned.ts) through TaxiFrame_OnEvent's
 * TAXIMAP_OPENED — muted, so neither TakeTaxiNode nor CloseTaxiMap reaches the world — counts the
 * node buttons (the seven discovered nodes), hovers the two-hop Thelsamar node to draw its route
 * with DrawRouteLine, and closes; zero new Lua errors or bridge diagnostics, frame ends hidden.
 */
export function frameXmlTaxiGate(
  seam: { readonly taxi?: FrameXmlTaxiModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlTaxiGateResult | undefined {
  try {
    const taxi = seam.taxi;
    if (!taxi) return undefined;
    const frames = frameXmlNpcFrames(boot, TAXI_FRAMES);
    const frame = frames?.get("TaxiFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)
      || !frameXmlNpcRegistered(frame, ["TAXIMAP_OPENED", "TAXIMAP_CLOSED"])) return undefined;
    const probe = frameXmlNpcClean(boot, () => taxi.probe({
      menu: FRAMEXML_CANNED_TAXI_MENU, catalog: FRAMEXML_CANNED_TAXI_CATALOG, continent: FRAMEXML_CANNED_TAXI_CONTINENT,
    }, () => frameXmlSilentProbe(boot, "webclient/taxi-gate", `
      TaxiFrame_OnEvent(TaxiFrame, "TAXIMAP_OPENED")
      local shown = TaxiFrame:IsShown() and 1 or 0
      local nodes, thelsamar = 0, nil
      for index = 1, NumTaxiNodes() do
        local button = _G["TaxiButton" .. index]
        if button and button:IsShown() then nodes = nodes + 1 end
        if GetNumRoutes(index) == 2 and TaxiNodeGetType(index) == "REACHABLE" then thelsamar = button end
      end
      local lines = 0
      if thelsamar then
        TaxiNodeOnButtonEnter(thelsamar)
        for index = 1, NUM_TAXI_ROUTES do
          if _G["TaxiRoute" .. index]:IsShown() then lines = lines + 1 end
        end
        GameTooltip:Hide()
      end
      HideUIPanel(TaxiFrame)
      return shown, nodes, lines, TaxiMap:GetTexture() and 1 or 0, TaxiFrame:IsShown() and 1 or 0
    `, 5)));
    if (!probe) return undefined;
    const [shown, nodes, lines, texture, still] = probe.map((value) => Number(value));
    if (shown !== 1 || nodes !== 7 || lines !== 2 || texture !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame, nodes: nodes ?? 0, lines: lines ?? 0 };
  } catch {
    return undefined;
  }
}

export interface FrameXmlTaxiOwner {
  isOpen(): boolean;
  close(): void;
}

export function createFrameXmlTaxiOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlTaxiOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    close: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(TaxiFrame)", "@webclient/taxi-close");
    },
  };
}
