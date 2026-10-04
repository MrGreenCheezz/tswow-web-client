/**
 * Draw parsed SimpleHTML blocks (FrameXmlSimpleHtml.ts) into a renderer's private layer.
 *
 * Every string becomes text nodes through `textContent`, never markup: the page's text comes from a
 * server (glue refusals, item pages) or an add-on, and none of it may become live HTML. Links are
 * spans the renderer wires to `OnHyperlinkClick`; pictures are `<img>` elements whose only
 * attribute from the page is the URL the renderer resolved for `src`.
 *
 * 3.35 (03.10, L5): the blocks stand where GetBoundsRect measures them (FrameXmlSimpleHtmlBounds.ts).
 * A text block's lines are its font's height plus its spacing apart, the spacing below each line (so
 * the block is lifted by half of it, which CSS puts above), and the next block starts one spacing
 * below its last line; a `<BR/>` is one such line in the page's font; a picture in the flow takes its
 * height and no line box below it; a picture pinned left or right, or one before the first text
 * block — which the client lays at the top, under that block — takes no room.
 */
import type { FrameXmlSimpleHtmlBlock } from "./FrameXmlSimpleHtml.js";
import { hasFrameXmlEscapes, parseFrameXmlText } from "./FrameXmlText.js";

export interface FrameXmlSimpleHtmlDomHooks {
  /** Dress an `<H1>`–`<H3>` block in that header's font object (a block without one keeps the page font). */
  headerFont(block: HTMLElement, level: 1 | 2 | 3): void;
  /** Make `span` the link `link`; `text` is the link as the client hands it to `OnHyperlinkClick`. */
  hyperlink(span: HTMLElement, link: string, text: string): void;
  /** The URL for picture `index` of the page, or undefined while there is none (yet). */
  picture(index: number, src: string): string | undefined;
  /** 3.35 (L5): the height and line spacing of a level's font, in UI units; undefined when unknown. */
  metrics?(level: 0 | 1 | 2 | 3): { readonly height: number; readonly spacing: number } | undefined;
}

const ALIGN: Readonly<Record<string, string>> = { LEFT: "left", CENTER: "center", RIGHT: "right" };

const px = (value: number): string => `${value}px`;

/** Replace the layer's blocks with `blocks`. */
export function buildFrameXmlSimpleHtml(
  layer: HTMLElement,
  blocks: readonly FrameXmlSimpleHtmlBlock[],
  hooks: FrameXmlSimpleHtmlDomHooks,
): void {
  if (typeof layer.replaceChildren === "function") layer.replaceChildren();
  else while (layer.children.length > 0) layer.children[layer.children.length - 1]?.remove();
  const document = layer.ownerDocument;
  let pictures = 0;
  let textSeen = false;
  for (const block of blocks) {
    const node = document.createElement("div");
    node.style.textAlign = ALIGN[block.align] ?? "left";
    if (block.kind === "image") {
      node.setAttribute("data-framexml-html-block", "img");
      const index = pictures++;
      const image = document.createElement("img");
      const url = block.src ? hooks.picture(index, block.src) : undefined;
      if (url) image.setAttribute("src", url);
      image.setAttribute("alt", "");
      image.setAttribute("draggable", "false");
      if (block.width > 0) image.style.width = `${block.width}px`;
      if (block.height > 0) image.style.height = `${block.height}px`;
      image.style.display = "inline-block";
      if (block.floating || !textSeen) {
        // Pinned to its side at this point of the page; the next block starts where this one did.
        node.style.height = "0";
        node.style.overflow = "visible";
      } else if (hooks.metrics) {
        // In the flow: exactly its height, without the line box's room for descenders below it.
        node.style.height = px(block.height);
      }
      node.append(image);
      layer.append(node);
      continue;
    }
    textSeen = true;
    node.setAttribute("data-framexml-html-block", block.empty ? "br" : block.level === 0 ? "p" : `h${block.level}`);
    if (block.level > 0) {
      hooks.headerFont(node, block.level as 1 | 2 | 3);
      // The block's `align`, not the font object's justification, places its lines (0x0096cc90).
      node.style.textAlign = ALIGN[block.align] ?? "left";
    }
    const metrics = hooks.metrics?.(block.empty ? 0 : block.level);
    if (metrics) {
      node.style.lineHeight = px(metrics.height + metrics.spacing);
      if (metrics.spacing !== 0) {
        node.style.position = "relative";
        node.style.top = px(-metrics.spacing / 2);
      }
    }
    if (block.empty) {
      if (metrics) node.style.height = px(metrics.height + metrics.spacing);
      else node.style.minHeight = "1em";
    } else if (!hasFrameXmlEscapes(block.text)) {
      node.textContent = block.text;
    } else {
      for (const run of parseFrameXmlText(block.text, true)) {
        const span = document.createElement("span");
        span.textContent = run.text;
        if (run.color !== undefined) span.style.color = run.color;
        if (run.hyperlink !== undefined) hooks.hyperlink(span, run.hyperlink, `|H${run.hyperlink}|h${run.text}|h`);
        node.append(span);
      }
    }
    layer.append(node);
  }
}
