/**
 * Plan item 3.13c: paints the stock WorldMapBlobFrame's quest blobs (GlueQuestPoiFrame.ts) into its own
 * element, the way Wow.exe 3.3.5a 12340 draws a QuestPOIFrame (0x5901c0, read 2026-10-02): nothing until
 * both textures are set; per drawn quest and blob the inside filled with the fill texture at the fill
 * alpha, then a band of the border texture at the border alpha, `BorderScalar × 0.01` of the screen
 * height wide, outside the outline (0x58f1a0 pushes each edge outward, away from the centroid). With
 * smoothing on (the default) the outline is a closed spline through the blob's points (0x58ed80).
 * 3.13e (L6): the frame hands its own build of each quest (GlueQuestPoiFrame.ts) — the spline already
 * sampled into the polygon the client fills (FrameXmlQuestPoiOutline.ts), merged blobs left out.
 *
 * The canvas sits in the frame's box, under nothing else of the frame, and takes no pointer input; it is
 * sized to the box at each paint, so the windowed and full-size maps both draw at their own scale.
 * A texture still loading is painted when it arrives.
 */

import {
  setQuestPoiFrameAdapter, type QuestPoiFrameDrawn, type QuestPoiFramePoint, type QuestPoiFrameStyle,
} from "../glue/GlueQuestPoiFrame.js"; // 3.13e (L6): QuestPoiFrameDrawn
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlQuestPoiModel } from "./FrameXmlQuestPoi.js";

const CANVAS_CLASS = "framexml-quest-blobs";
/** The UI's reference height: 0x58f1a0's 0.01 of the screen. */
const UI_HEIGHT = 768;
const BORDER_FRACTION = 0.01;

export interface FrameXmlQuestBlobRenderer {
  elementFor(frame: FrameXmlFrame): HTMLElement | undefined;
}

/** The outline as a canvas path: straight edges, or a closed Catmull-Rom spline when smoothing. */
function outline(context: CanvasRenderingContext2D, points: readonly { x: number; y: number }[], smooth: boolean): void {
  context.beginPath();
  const count = points.length;
  context.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 0; index < count; index++) {
    const p1 = points[index]!;
    const p2 = points[(index + 1) % count]!;
    if (!smooth) { context.lineTo(p2.x, p2.y); continue; }
    const p0 = points[(index - 1 + count) % count]!;
    const p3 = points[(index + 2) % count]!;
    context.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
  }
  context.closePath();
}

export function installFrameXmlQuestPoiFrame(
  seam: { readonly questPoi?: FrameXmlQuestPoiModel | undefined },
  renderer: FrameXmlQuestBlobRenderer,
  textureUrl: (path: string) => string,
): () => void {
  const images = new Map<string, HTMLImageElement>();
  /** The last paint of each frame, repeated when a texture arrives. */
  const last = new Map<FrameXmlFrame, {
    quests: readonly number[]; style: Readonly<QuestPoiFrameStyle>;
    drawn: readonly (QuestPoiFrameDrawn | undefined)[] | undefined; // 3.13e (L6)
  }>();
  let disposed = false;

  const image = (path: string, document: Document): HTMLImageElement | undefined => {
    let picture = images.get(path);
    if (!picture) {
      picture = document.createElement("img");
      picture.addEventListener("load", () => {
        if (disposed) return;
        for (const [frame, paint] of last) draw(frame, paint.quests, paint.style, paint.drawn);
      });
      picture.src = textureUrl(path);
      images.set(path, picture);
    }
    return picture.complete && picture.naturalWidth > 0 ? picture : undefined;
  };

  const draw = (frame: FrameXmlFrame, quests: readonly number[], style: Readonly<QuestPoiFrameStyle>,
    drawn?: readonly (QuestPoiFrameDrawn | undefined)[]): void => {
    last.set(frame, { quests, style, drawn });
    const element = renderer.elementFor(frame);
    const document = element?.ownerDocument;
    if (!element || !document) return;
    let canvas = [...element.children].find((child) => child.classList.contains(CANVAS_CLASS)) as HTMLCanvasElement | undefined;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = CANVAS_CLASS;
      canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;";
      element.prepend(canvas);
    }
    const width = element.offsetWidth || 0;
    const height = element.offsetHeight || 0;
    const scale = Math.max(1, document.defaultView?.devicePixelRatio ?? 1);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!style.fillTexture || !style.borderTexture || width <= 0 || height <= 0) return;
    const fill = image(style.fillTexture, document);
    const border = image(style.borderTexture, document);
    const band = style.borderScalar * BORDER_FRACTION * UI_HEIGHT * scale;
    const toCanvas = (point: QuestPoiFramePoint): { x: number; y: number } => ({ x: point.u * canvas!.width, y: point.v * canvas!.height });
    for (const [index, questId] of quests.entries()) {
      // 3.13e (L6): the frame's own build (smoothed outline, merged blobs), else the seam's shapes.
      const shapes = drawn ? drawn[index]?.shapes ?? [] : seam.questPoi?.shapes(questId)?.shapes ?? [];
      for (const shape of shapes) {
        if (shape.points.length < 3) continue;
        const points = shape.points.map(toCanvas);
        // The border band outside the outline: a doubled stroke with the inside clipped away.
        if (band > 0 && style.borderAlpha > 0) {
          context.save();
          context.beginPath();
          context.rect(0, 0, canvas.width, canvas.height);
          // 3.13e (L6): a frame's build is already the sampled outline, drawn as the polygon it is.
          outline(context, points, !drawn && style.smoothing);
          context.clip("evenodd");
          outline(context, points, !drawn && style.smoothing);
          context.globalAlpha = style.borderAlpha / 255;
          context.lineWidth = band * 2;
          context.lineJoin = "round";
          context.strokeStyle = (border && context.createPattern(border, "repeat")) || "rgba(64, 32, 0, 1)";
          context.stroke();
          context.restore();
        }
        if (style.fillAlpha > 0) {
          context.save();
          outline(context, points, !drawn && style.smoothing);
          context.globalAlpha = style.fillAlpha / 255;
          context.fillStyle = (fill && context.createPattern(fill, "repeat")) || "rgba(255, 210, 120, 1)";
          context.fill();
          context.restore();
        }
      }
    }
  };

  const release = setQuestPoiFrameAdapter({
    shapes: (questId, style) => seam.questPoi?.shapes(questId, style), // 3.13e (L6): in the frame's style
    logIndex: (questId) => seam.questPoi?.logIndex(questId) ?? 0,
    paint: draw,
  });
  return () => {
    disposed = true;
    release();
    for (const frame of last.keys()) {
      const element = renderer.elementFor(frame);
      for (const child of [...(element?.children ?? [])]) if (child.classList.contains(CANVAS_CLASS)) child.remove();
    }
    last.clear();
    images.clear();
  };
}
