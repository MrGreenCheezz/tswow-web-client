/**
 * The dressing room's picture: every DressUpModel that shows a unit, drawn by the glue model stage
 * (GlueModelStage.ts) from the same composition route the world and the character screens use —
 * `/dbc/creature-models` for the body's display record, `/dbc/character-appearance` with the outfit
 * (`slot:inventoryType:displayId`) for the skin, face, hair, armour layers and geosets,
 * CharacterAtlasClient for the body sheet (CreatureModelClient.playerAppearance, the same call
 * ui/Frames.ts unitModelFor makes for the player in the world).
 *
 * What the stage does not draw is `appearance.attached`: helmets, shoulders, weapons and shields are
 * models hung off bones, and GlueModelStage has no attachment path (GlueCharacterScene.ts
 * hangAttachments needs a backdrop view to stand in). A tried-on helmet therefore shows only what it
 * does to the geosets (hair and ears hidden per HelmetGeosetVisData), a weapon or shoulder nothing.
 *
 * Nothing runs while no dress-up model is visible: the loop wakes on a model call or DressUpFrame's
 * OnShow and stops on the first frame after the last one hides. The stage's WebGL renderer is
 * created on its first drawn view, not at boot.
 */
import { CreatureModelClient } from "../CreatureModelClient.js";
import { GlueModelStage, type GlueModelSource } from "../glue/GlueModelStage.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlDressUpModels, FrameXmlDressUpOutfit } from "./FrameXmlDressUp.js";

export type FrameXmlDressUpModelSource = Pick<CreatureModelClient, "get" | "request" | "playerAppearance">;

/** The outfit's identity, in CreatureModelClient.playerAppearance's own spelling of the equipment. */
export function frameXmlDressUpKey(outfit: FrameXmlDressUpOutfit): string {
  const { look } = outfit;
  const worn = outfit.equipment.map((item) => `${item.slot}:${item.inventoryType}:${item.displayId}`
    + (item.subClass === undefined ? "" : `:${item.subClass}`)).join(",");
  return `dressup:${look.displayId}/${look.race}/${look.sex}/${look.skin}/${look.face}/${look.hairStyle}`
    + `/${look.hairColor}/${look.facialHair}/${worn}`;
}

/**
 * The stage source for one outfit: the native display's model and textures with the composed
 * appearance, fitted to the widget. Undefined until both the display record and the appearance
 * have arrived (both are asked for here).
 */
export function frameXmlDressUpSource(
  outfit: FrameXmlDressUpOutfit,
  models: FrameXmlDressUpModelSource,
): GlueModelSource | undefined {
  const { look } = outfit;
  const metadata = models.get(look.displayId);
  if (!metadata) { models.request(look.displayId); return undefined; }
  const appearance = models.playerAppearance(look.race, look.sex, look.skin, look.face, look.hairStyle,
    look.hairColor, look.facialHair, outfit.equipment);
  if (!appearance) return undefined;
  return {
    key: `${frameXmlDressUpKey(outfit)}:${metadata.model}:${metadata.textures}`,
    file: metadata.model,
    textures: metadata.textures,
    appearance,
    displayScale: metadata.scale,
    fitBody: true,
  };
}

export interface FrameXmlDressUpStageOptions {
  readonly gatewayOrigin: string;
  readonly models: FrameXmlDressUpModels;
  readonly elementFor: (frame: FrameXmlFrame) => HTMLElement | undefined;
  readonly isVisible: (frame: FrameXmlFrame) => boolean;
  readonly creatureModels?: FrameXmlDressUpModelSource | undefined;
  readonly onDiagnostic?: (message: string) => void;
  /** The page's frame scheduler; injectable for tests. */
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export class FrameXmlDressUpStage {
  readonly #options: FrameXmlDressUpStageOptions;
  readonly #models: FrameXmlDressUpModelSource;
  #stage: GlueModelStage | undefined;
  /** The last source each model resolved: kept on screen while a new outfit's answer is in flight. */
  readonly #shown = new Map<FrameXmlFrame, { readonly displayId: number; readonly source: GlueModelSource }>();
  #handle: number | undefined;
  #previous = 0;
  #disposed = false;

  constructor(options: FrameXmlDressUpStageOptions) {
    this.#options = options;
    this.#models = options.creatureModels ?? new CreatureModelClient(options.gatewayOrigin);
  }

  /** Whether the loop is scheduled (tests, the preview). */
  get running(): boolean { return this.#handle !== undefined; }

  /** The source a model draws now: the current outfit's, or the last one while it resolves. */
  resolve(frame: FrameXmlFrame): GlueModelSource | undefined {
    const outfit = this.#options.models.outfit(frame);
    if (!outfit) { this.#shown.delete(frame); return undefined; }
    const source = frameXmlDressUpSource(outfit, this.#models);
    if (source) {
      this.#shown.set(frame, { displayId: outfit.look.displayId, source });
      return source;
    }
    const last = this.#shown.get(frame);
    return last && last.displayId === outfit.look.displayId ? last.source : undefined;
  }

  /** A model call or an OnShow: draw until no dress-up model is visible. */
  wake(): void {
    if (this.#disposed || this.#handle !== undefined) return;
    this.#previous = performance.now();
    this.#schedule();
  }

  #visible(): boolean {
    for (const frame of this.#options.models.frames()) {
      if (this.#options.isVisible(frame)) return true;
    }
    return false;
  }

  #schedule(): void {
    const request = this.#options.requestFrame ?? ((callback: () => void) => window.requestAnimationFrame(callback));
    this.#handle = request(() => this.#step());
  }

  #step(): void {
    this.#handle = undefined;
    if (this.#disposed) return;
    const now = performance.now();
    const elapsed = Math.min(0.25, Math.max(0, (now - this.#previous) / 1000));
    this.#previous = now;
    const visible = this.#visible();
    try {
      if (visible || this.#stage) {
        const stage = this.#stage ??= new GlueModelStage({
          gatewayOrigin: this.#options.gatewayOrigin,
          models: () => this.#options.models.frames(),
          elementFor: this.#options.elementFor,
          isVisible: this.#options.isVisible,
          resolveModel: (frame) => this.resolve(frame),
          ...(this.#options.onDiagnostic ? { onDiagnostic: this.#options.onDiagnostic } : {}),
        });
        // A hidden model's view is dropped here, so the last pass after a close frees it.
        stage.reconcile();
        if (visible) stage.frame(elapsed, now);
      }
    } catch (error) {
      this.#options.onDiagnostic?.(`примерочная: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const frame of this.#shown.keys()) if (!this.#options.models.has(frame)) this.#shown.delete(frame);
    if (visible) this.#schedule();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#handle !== undefined) {
      const cancel = this.#options.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle));
      cancel(this.#handle);
      this.#handle = undefined;
    }
    this.#shown.clear();
    this.#stage?.dispose();
    this.#stage = undefined;
  }
}
