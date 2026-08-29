import type { FrameXmlFrame, FrameXmlPoint } from "./FrameXmlTypes.js";
import type { FrameXmlUiBridge } from "./FrameXmlRuntime.js";

export interface FrameXmlDomRendererOptions {
  /**
   * Trusted host mapping from a WoW texture name to an application asset URL.
   * Without this capability the renderer never sets an image `src`, so an
   * addon-controlled value cannot create a browser network request.
   */
  readonly textureResolver?: (texture: string) => string;
  /** Prefix for the stable classes/data attributes used by the renderer. */
  readonly classPrefix?: string;
  /** Subscribe to bridge mutations so sync() is automatic after UI API calls. */
  readonly bridge?: FrameXmlUiBridge;
}

interface RenderedFrame {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
  readonly label?: HTMLElement;
  readonly children: Map<FrameXmlFrame, RenderedFrame>;
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function px(value: number): string {
  return `${value}px`;
}

function mouseButtonName(event: Event): string {
  const button = (event as Event & { readonly button?: unknown }).button;
  if (button === 1) return "MiddleButton";
  if (button === 2) return "RightButton";
  if (button === 3) return "Button4";
  if (button === 4) return "Button5";
  return "LeftButton";
}

/**
 * Render the small, stateful FrameXML subset into a caller-owned DOM host.
 *
 * This is intentionally a binding, not a second WoW UI implementation: it
 * only mirrors the in-memory frame tree and never gives an addon `document`,
 * `window`, network access, or an arbitrary element.  A caller chooses the
 * exact host and the roots to mount, which keeps the native HUD untouched.
 */
export class FrameXmlDomRenderer {
  readonly #container: HTMLElement;
  readonly #textureResolver: ((texture: string) => string) | undefined;
  readonly #classPrefix: string;
  readonly #bridge: FrameXmlUiBridge | undefined;
  readonly #rendered = new Map<FrameXmlFrame, RenderedFrame>();
  readonly #roots: FrameXmlFrame[] = [];
  readonly #unsubscribe: (() => void) | undefined;

  constructor(container: HTMLElement, options: FrameXmlDomRendererOptions = {}) {
    this.#container = container;
    this.#textureResolver = options.textureResolver;
    this.#classPrefix = options.classPrefix?.trim() || "framexml";
    this.#bridge = options.bridge;
    this.#unsubscribe = options.bridge?.subscribe(() => this.sync());
  }

  /** Replace the mounted roots. The container itself is never cleared. */
  mount(roots: readonly FrameXmlFrame[]): void {
    for (const rendered of this.#rendered.values()) rendered.element.remove();
    this.#rendered.clear();
    this.#roots.splice(0, this.#roots.length, ...roots);
    this.sync();
  }

  /** Apply current frame state and reconcile child widgets. */
  sync(): void {
    const active = new Set<FrameXmlFrame>();
    for (const root of this.#roots) this.syncFrame(root, this.#container, active);
    for (const [frame, rendered] of this.#rendered) {
      if (!active.has(frame)) {
        rendered.element.remove();
        this.#rendered.delete(frame);
      }
    }
    // A sibling may be declared after the frame that points to it. Re-apply
    // anchors once the whole mounted tree exists so relative geometry can be
    // resolved when the host DOM provides layout rectangles.
    for (const rendered of this.#rendered.values()) {
      this.applyPoint(rendered.element, rendered.frame.points[0]);
    }
  }

  /** Remove the renderer's nodes and stop observing bridge mutations. */
  destroy(): void {
    this.#unsubscribe?.();
    for (const rendered of this.#rendered.values()) rendered.element.remove();
    this.#rendered.clear();
    this.#roots.splice(0, this.#roots.length);
  }

  get container(): HTMLElement {
    return this.#container;
  }

  private syncFrame(
    frame: FrameXmlFrame,
    parent: HTMLElement,
    active: Set<FrameXmlFrame>,
  ): RenderedFrame {
    active.add(frame);
    let rendered = this.#rendered.get(frame);
    if (!rendered) {
      rendered = this.createFrame(frame);
      this.#rendered.set(frame, rendered);
    }
    if (rendered.element.parentElement !== parent) parent.append(rendered.element);
    this.applyFrame(rendered);

    const wanted = new Set(frame.children);
    for (const child of frame.children) {
      const childRendered = this.syncFrame(child, rendered.element, active);
      rendered.children.set(child, childRendered);
    }
    for (const [child, childRendered] of rendered.children) {
      if (!wanted.has(child)) {
        childRendered.element.remove();
        rendered.children.delete(child);
        this.#rendered.delete(child);
      }
    }
    return rendered;
  }

  private createFrame(frame: FrameXmlFrame): RenderedFrame {
    const tag = frame.type === "Button" || frame.type === "CheckButton" ? "button"
      : frame.type === "Texture" ? "img"
        : frame.type === "FontString" ? "span" : "div";
    const element = this.#container.ownerDocument?.createElement(tag)
      ?? document.createElement(tag);
    element.classList.add(`${this.#classPrefix}-${frame.type.toLowerCase()}`);
    element.setAttribute("data-framexml-name", frame.name);
    element.setAttribute("data-framexml-type", frame.type);
    if (frame.type === "Button" || frame.type === "CheckButton") {
      element.setAttribute("type", "button");
      element.addEventListener("click", (event) => {
        // Never forward the browser event itself to an addon.  The bridge gets
        // only FrameXML's stable button name and key-state scalar.
        this.#bridge?.Click(frame, mouseButtonName(event), false);
      });
    }

    // Pointer and mouse enter/leave are equivalent hover transitions for the
    // bounded bridge. Browsers may emit both for a mouse, so coalesce them
    // before dispatching the Lua callback. The browser event itself never
    // crosses the FrameXML capability boundary.
    let hovering = false;
    const enter = () => {
      if (hovering) return;
      hovering = true;
      this.#bridge?.Enter(frame);
    };
    const leave = () => {
      if (!hovering) return;
      hovering = false;
      this.#bridge?.Leave(frame);
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("mouseenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("mouseleave", leave);

    let label: HTMLElement | undefined;
    if (frame.type === "Frame" || frame.type === "Button" || frame.type === "CheckButton") {
      const labelElement = this.#container.ownerDocument?.createElement("span")
        ?? document.createElement("span");
      labelElement.classList.add(`${this.#classPrefix}-label`);
      labelElement.setAttribute("data-framexml-label", "true");
      element.append(labelElement);
      label = labelElement;
    }
    return {
      frame,
      element,
      ...(label ? { label } : {}),
      children: new Map(),
    };
  }


  private applyFrame(rendered: RenderedFrame): void {
    const { frame, element } = rendered;
    const hidden = !frame.visible;
    if (element.hidden !== hidden) element.hidden = hidden;
    const ariaHidden = String(hidden);
    if (element.getAttribute("aria-hidden") !== ariaHidden) {
      element.setAttribute("aria-hidden", ariaHidden);
    }

    if (rendered.label) {
      if (rendered.label.textContent !== frame.text) rendered.label.textContent = frame.text;
    } else if (frame.type === "FontString" && element.textContent !== frame.text) {
      element.textContent = frame.text;
    }

    const width = numberValue(frame.attributes["width"]);
    const height = numberValue(frame.attributes["height"]);
    const widthCss = width === undefined ? "" : px(width);
    const heightCss = height === undefined ? "" : px(height);
    if (element.style.width !== widthCss) {
      if (width === undefined) element.style.removeProperty("width");
      else element.style.width = widthCss;
    }
    if (element.style.height !== heightCss) {
      if (height === undefined) element.style.removeProperty("height");
      else element.style.height = heightCss;
    }

    if (element.style.position !== "absolute") element.style.position = "absolute";
    this.applyPoint(element, frame.points[0]);

    if (frame.type === "Texture") {
      const source = frame.texture.trim();
      if (element.getAttribute("data-framexml-texture") !== source) {
        element.setAttribute("data-framexml-texture", source);
      }
      if (element.getAttribute("alt") !== "") element.setAttribute("alt", "");
      if (this.#textureResolver && source) {
        const resolved = this.#textureResolver(source);
        if (element.getAttribute("src") !== resolved) {
          if (resolved) element.setAttribute("src", resolved);
          else element.removeAttribute("src");
        }
      } else if (element.getAttribute("src") !== null) {
        // No resolver is a deliberate safe default. In particular, values
        // such as https://..., //host/... and /path/... remain inert metadata.
        element.removeAttribute("src");
      }
    }
  }

  private applyPoint(element: HTMLElement, point: FrameXmlPoint | undefined): void {
    if (!point) {
      element.removeAttribute("data-framexml-point");
      element.removeAttribute("data-framexml-relative");
      element.style.removeProperty("left");
      element.style.removeProperty("right");
      element.style.removeProperty("top");
      element.style.removeProperty("bottom");
      element.style.removeProperty("transform");
      return;
    }
    const x = point.x ?? 0;
    // FrameXML's positive Y points upward; CSS's positive Y points downward.
    const y = -(point.y ?? 0);
    const anchor = point.point.toUpperCase();
    const relativePoint = (point.relativePoint ?? point.point).toUpperCase();
    element.setAttribute("data-framexml-point", `${anchor}:${relativePoint}:${x}:${point.y ?? 0}`);
    if (point.relativeTo) element.setAttribute("data-framexml-relative", point.relativeTo.name);
    else element.removeAttribute("data-framexml-relative");

    element.style.removeProperty("left");
    element.style.removeProperty("right");
    element.style.removeProperty("top");
    element.style.removeProperty("bottom");
    element.style.removeProperty("transform");

    if (point.relativeTo && this.applyRelativePoint(element, point)) return;

    if (anchor.includes("LEFT")) element.style.left = px(x);
    else if (anchor.includes("RIGHT")) element.style.right = px(-x);
    else {
      element.style.left = `calc(50% + ${x}px)`;
      element.style.transform = "translateX(-50%)";
    }
    if (anchor.includes("TOP")) element.style.top = px(y);
    else if (anchor.includes("BOTTOM")) element.style.bottom = px(-y);
    else {
      element.style.top = `calc(50% + ${y}px)`;
      element.style.transform = element.style.transform
        ? `${element.style.transform} translateY(-50%)`
        : "translateY(-50%)";
    }
    // relativePoint is preserved as data above. The nested DOM hierarchy gives
    // $parent anchors their natural containing block; sibling anchors remain
    // inspectable when a host has no layout API (for example a test seam).
  }

  /** Resolve a relative anchor against actual host geometry when available. */
  private applyRelativePoint(element: HTMLElement, point: FrameXmlPoint): boolean {
    const target = point.relativeTo ? this.#rendered.get(point.relativeTo)?.element : undefined;
    const parent = element.parentElement ?? this.#container;
    if (!target || typeof target.getBoundingClientRect !== "function"
      || typeof parent.getBoundingClientRect !== "function") return false;
    const targetRect = target.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const ownRect = typeof element.getBoundingClientRect === "function"
      ? element.getBoundingClientRect() : undefined;
    const ownWidth = ownRect?.width || numberValue(element.style.width) || 0;
    const ownHeight = ownRect?.height || numberValue(element.style.height) || 0;
    const targetX = point.relativePoint?.toUpperCase() ?? point.point.toUpperCase();
    const anchorX = point.point.toUpperCase();
    const targetY = targetX;
    const targetLeft = targetRect.left - parentRect.left;
    const targetRight = targetRect.right - parentRect.left;
    const targetTop = targetRect.top - parentRect.top;
    const targetBottom = targetRect.bottom - parentRect.top;
    const targetCenterX = (targetLeft + targetRight) / 2;
    const targetCenterY = (targetTop + targetBottom) / 2;
    const ownLeft = anchorX.includes("LEFT") ? 0 : anchorX.includes("RIGHT") ? ownWidth : ownWidth / 2;
    const ownTop = anchorX.includes("TOP") ? 0 : anchorX.includes("BOTTOM") ? ownHeight : ownHeight / 2;
    const refX = targetX.includes("LEFT") ? targetLeft : targetX.includes("RIGHT") ? targetRight : targetCenterX;
    const refY = targetY.includes("TOP") ? targetTop : targetY.includes("BOTTOM") ? targetBottom : targetCenterY;
    const x = point.x ?? 0;
    const y = -(point.y ?? 0);
    element.style.left = px(refX + x - ownLeft);
    element.style.top = px(refY + y - ownTop);
    element.style.transform = "";
    return true;
  }
}
