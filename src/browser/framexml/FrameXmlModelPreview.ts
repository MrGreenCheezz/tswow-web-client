/**
 * WORK_PLAN 3.61: the picture of a model frame told what to show by id. `SetCreature` is how the stock
 * windows ask for one: CompanionModelFrame for the selected mount or companion
 * (PetPaperDollFrame.lua, FrameXmlCompanions.ts), PetStableModel for the stabled pet
 * (FrameXmlStableOwner.ts). `SetDisplayInfo` names the display itself.
 *
 * A model frame showing a unit belongs to the dress-up stage (FrameXmlDressUpStage.ts), and a call
 * here ends that view, so one frame never has two pictures. A frame with only a file (`SetModel`, an
 * XML `file`: the bag animations, the map's ping) is not drawn here.
 *
 * Nothing runs while no such frame is visible: the stage's WebGL renderer is created on its first
 * view, and a closed window's view is dropped on the next step.
 */

import type { CreatureTemplate } from "../../world/QueryCacheProtocol.js";
import { CreatureModelClient } from "../CreatureModelClient.js";
import { GlueModelStage, type GlueModelSource } from "../glue/GlueModelStage.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

export interface FrameXmlModelPreviewOptions {
  readonly gatewayOrigin: string;
  readonly bridge: Pick<FrameXmlUiBridge, "modelFrames" | "isVisible">;
  readonly elementFor: (frame: FrameXmlFrame) => HTMLElement | undefined;
  readonly creatureTemplate: (entry: number) => Pick<CreatureTemplate, "found" | "displayIds"> | undefined;
  readonly creatureModels?: Pick<CreatureModelClient, "get" | "request"> | undefined;
  readonly onDiagnostic?: (message: string) => void;
}

/** Resolve the template entry, then the selected display; never interpret one id as the other. */
export function frameXmlPreviewSource(
  frame: FrameXmlFrame,
  template: FrameXmlModelPreviewOptions["creatureTemplate"],
  models: Pick<CreatureModelClient, "get" | "request">,
): GlueModelSource | undefined {
  const state = frame.model;
  let displayId = state.displayId;
  if (state.creatureEntry) {
    const row = template(state.creatureEntry);
    if (!row?.found) return undefined;
    displayId = row.displayIds.find(value => Number.isInteger(value) && value > 0);
  }
  if (!displayId) return undefined;
  const metadata = models.get(displayId);
  if (!metadata) { models.request(displayId); return undefined; }
  return {
    key: `display:${displayId}:${metadata.model}:${metadata.textures}`,
    file: metadata.model,
    textures: metadata.textures,
    appearance: metadata.appearance,
    displayScale: metadata.scale,
    fitBody: true,
  };
}

export class FrameXmlModelPreview {
  readonly #options: FrameXmlModelPreviewOptions;
  readonly #models: Pick<CreatureModelClient, "get" | "request">;
  #stage: GlueModelStage | undefined;
  /** Whether the last step drew: the first step with nothing visible still runs, to drop the views. */
  #drawing = false;
  #disposed = false;

  constructor(options: FrameXmlModelPreviewOptions) {
    this.#options = options;
    this.#models = options.creatureModels ?? new CreatureModelClient(options.gatewayOrigin);
  }

  #visible(): boolean {
    for (const frame of this.#options.bridge.modelFrames) {
      if ((frame.model.creatureEntry || frame.model.displayId) && this.#options.bridge.isVisible(frame)) return true;
    }
    return false;
  }

  /** One page frame. Reads only the model frames' own state until one of them is shown by id. */
  frame(elapsedSeconds: number, nowMs: number): void {
    if (this.#disposed) return;
    const visible = this.#visible();
    if (!visible && !this.#drawing) return;
    this.#drawing = visible;
    const stage = this.#stage ??= new GlueModelStage({
      gatewayOrigin: this.#options.gatewayOrigin,
      models: () => this.#options.bridge.modelFrames,
      elementFor: this.#options.elementFor,
      isVisible: (frame) => this.#options.bridge.isVisible(frame),
      resolveModel: (frame) => frameXmlPreviewSource(frame, this.#options.creatureTemplate, this.#models),
      ...(this.#options.onDiagnostic ? { onDiagnostic: this.#options.onDiagnostic } : {}),
    });
    stage.reconcile();
    if (visible) stage.frame(elapsedSeconds, nowMs);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stage?.dispose();
    this.#stage = undefined;
  }
}
