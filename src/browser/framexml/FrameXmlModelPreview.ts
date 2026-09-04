import type { CreatureTemplate } from "../../world/QueryCacheProtocol.js";
import { CreatureModelClient } from "../CreatureModelClient.js";
import { GlueModelStage, type GlueModelSource } from "../glue/GlueModelStage.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

export interface FrameXmlModelPreviewOptions {
  readonly gatewayOrigin: string;
  readonly bridge: FrameXmlUiBridge;
  readonly elementFor: (frame: FrameXmlFrame) => HTMLElement | undefined;
  readonly isVisible: (frame: FrameXmlFrame) => boolean;
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
  if (state.file) return { key: state.file, file: state.file };
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

/** One shared model stage for file models and the TSWoW companions' SetCreature previews. */
export class FrameXmlModelPreview {
  readonly #stage: GlueModelStage;
  #disposed = false;

  constructor(options: FrameXmlModelPreviewOptions) {
    const models = options.creatureModels ?? new CreatureModelClient(options.gatewayOrigin);
    this.#stage = new GlueModelStage({
      gatewayOrigin: options.gatewayOrigin,
      models: () => options.bridge.modelFrames,
      elementFor: options.elementFor,
      isVisible: options.isVisible,
      resolveModel: frame => frameXmlPreviewSource(frame, options.creatureTemplate, models),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  }

  get stats(): GlueModelStage["stats"] { return this.#stage.stats; }

  frame(elapsedSeconds: number, nowMs: number): void {
    if (this.#disposed) return;
    this.#stage.reconcile();
    this.#stage.frame(elapsedSeconds, nowMs);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stage.dispose();
  }
}
