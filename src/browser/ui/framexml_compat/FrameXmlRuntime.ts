import {
  FRAME_XML_WIDGET_TYPES,
  type FrameXmlAddonLoadResult,
  type FrameXmlDiagnostic,
  type FrameXmlElement,
  type FrameXmlFrame,
  type FrameXmlPoint,
  type FrameXmlScriptHandler,
  type FrameXmlUiApi,
  type FrameXmlUiBridgeOptions,
  type LuaAddonRuntime,
  type LuaScriptContext,
} from "./FrameXmlTypes.js";
import {
  FrameXmlTemplateRegistry,
  mergeFrameXmlElements,
  parseFrameXml,
} from "./FrameXmlParser.js";

// Keep the runtime's public type spelling local until FrameXmlTypes can be
// consumed by generated declaration users. The cast is constrained by the
// allow-list above and never exposes a DOM node.
type RuntimeWidgetType = Extract<FrameXmlFrame["type"], string>;

function truthyAttribute(value: string | undefined): boolean {
  return value !== undefined && /^(?:1|true|yes)$/i.test(value.trim());
}

function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * FrameXML normally declares dimensions as `<Size><AbsDimension x="..."
 * y="..."/></Size>`, rather than as HTML-like attributes.  Templates are
 * merged in source order, so applying every declared component in order gives
 * derived templates a safe partial override while retaining an inherited axis
 * that they did not specify.
 */
function effectiveSizeAttributes(element: FrameXmlElement): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = { ...element.attributes };
  const explicitWidth = attributes["width"] !== undefined;
  const explicitHeight = attributes["height"] !== undefined;
  for (const size of element.children) {
    if (size.name !== "Size") continue;
    const dimensions = size.children.find((child) => child.name === "AbsDimension");
    const x = size.attributes["x"] ?? dimensions?.attributes["x"];
    const y = size.attributes["y"] ?? dimensions?.attributes["y"];
    if (!explicitWidth && x !== undefined) attributes["width"] = x;
    if (!explicitHeight && y !== undefined) attributes["height"] = y;
  }
  return Object.freeze(attributes);
}

function isWidget(element: FrameXmlElement): boolean {
  return FRAME_XML_WIDGET_TYPES.has(element.name);
}

function isVirtual(element: FrameXmlElement): boolean {
  return truthyAttribute(element.attributes["virtual"]);
}

const DECLARATION_CONTAINERS = new Set(["Scripts", "Events", "Frames", "Layers", "Layer"]);

interface Declarations {
  readonly scriptSources: Map<string, string>;
  readonly events: Set<string>;
}

interface PendingRelativePoint {
  readonly frame: MutableFrameXmlFrame;
  readonly index: number;
  readonly relativeName: string;
}

function collectDeclarations(element: FrameXmlElement): Declarations {
  const scriptSources = new Map<string, string>();
  const events = new Set<string>();
  const visit = (current: FrameXmlElement, declarationScope: boolean): void => {
    const name = current.name;
    if (/^On[A-Z][A-Za-z0-9_]*$/.test(name)) {
      const body = current.text.trim();
      if (body) scriptSources.set(name, body);
      return;
    }
    if (name === "Event") {
      const eventName = current.attributes["name"]?.trim() ?? current.text.trim();
      if (eventName) events.add(eventName);
      return;
    }
    // Wrapper containers (Frames/Layers/etc.) may be nested inside the
    // current frame, but a nested widget starts a new declaration scope.  Do
    // not let a child's OnLoad/OnEvent overwrite the parent's handlers while
    // walking through a wrapper.
    if (current !== element && isWidget(current)) return;
    const nextScope = declarationScope || DECLARATION_CONTAINERS.has(name);
    for (const child of current.children) visit(child, nextScope);
  };
  visit(element, false);
  return { scriptSources, events };
}

class MutableFrameXmlFrame implements FrameXmlFrame {
  readonly type: RuntimeWidgetType;
  readonly name: string;
  readonly parent?: FrameXmlFrame;
  readonly children: FrameXmlFrame[] = [];
  readonly attributes: Readonly<Record<string, string>>;
  readonly points: FrameXmlPoint[] = [];
  readonly scriptSources: ReadonlyMap<string, string>;
  readonly registeredEvents: Set<string>;
  readonly scripts = new Map<string, FrameXmlScriptHandler>();
  /** SetScript replaces an XML handler, including when the replacement is nil. */
  readonly scriptOverrides = new Set<string>();
  visible: boolean;
  text = "";
  texture = "";
  loaded = false;

  constructor(
    type: RuntimeWidgetType,
    name: string,
    attributes: Readonly<Record<string, string>>,
    parent: FrameXmlFrame | undefined,
    declarations: Declarations,
  ) {
    this.type = type;
    this.name = name;
    if (parent !== undefined) this.parent = parent;
    this.attributes = Object.freeze({ ...attributes });
    this.scriptSources = new Map(declarations.scriptSources);
    this.registeredEvents = new Set(declarations.events);
    this.visible = !truthyAttribute(attributes["hidden"]);
    this.text = attributes["text"] ?? "";
    this.texture = attributes["file"] ?? attributes["texture"] ?? "";
  }
}

/**
 * In-memory WoW UI API surface. It deliberately stores state rather than
 * creating HTML; the native HUD has no shared mutation path and a Lua adapter
 * receives only this capability object.
 */
export class FrameXmlUiBridge implements FrameXmlUiApi {
  readonly #registry: FrameXmlTemplateRegistry;
  readonly #runtime: LuaAddonRuntime | undefined;
  readonly #diagnostics: FrameXmlDiagnostic[] = [];
  readonly #diagnosticSink: ((diagnostic: FrameXmlDiagnostic) => void) | undefined;
  readonly #frames = new Set<MutableFrameXmlFrame>();
  readonly #byName = new Map<string, MutableFrameXmlFrame>();
  readonly #pendingRelativePoints: PendingRelativePoint[] = [];
  readonly #unavailableScriptNotices = new Set<string>();
  readonly #mutationListeners = new Set<() => void>();
  #anonymousId = 0;

  constructor(registry = new FrameXmlTemplateRegistry(), options: FrameXmlUiBridgeOptions = {}) {
    this.#registry = registry;
    this.#runtime = options.runtime;
    this.#diagnosticSink = options.onDiagnostic;
  }

  get registry(): FrameXmlTemplateRegistry {
    return this.#registry;
  }

  get diagnostics(): readonly FrameXmlDiagnostic[] {
    return [...this.#diagnostics];
  }

  getFrame(name: string): FrameXmlFrame | undefined {
    return this.#byName.get(name);
  }

  /**
   * Subscribe to state changes made through the bounded UI API.  This is a
   * host-side observation seam for renderers; it is deliberately not exposed
   * through LuaScriptContext, so an addon cannot observe or mutate the DOM.
   */
  subscribe(listener: () => void): () => void {
    this.#mutationListeners.add(listener);
    return () => this.#mutationListeners.delete(listener);
  }

  private notifyMutation(): void {
    for (const listener of [...this.#mutationListeners]) {
      try {
        listener();
      } catch (error) {
        this.diagnostic("addon", `FrameXML host observer failed: ${String(error)}`);
      }
    }
  }

  private diagnostic(scope: FrameXmlDiagnostic["scope"], message: string): void {
    const diagnostic = { scope, message } satisfies FrameXmlDiagnostic;
    this.#diagnostics.push(diagnostic);
    this.#diagnosticSink?.(diagnostic);
  }

  private own(frame: FrameXmlFrame): MutableFrameXmlFrame | undefined {
    return frame instanceof MutableFrameXmlFrame && this.#frames.has(frame) ? frame : undefined;
  }

  private buildElement(
    source: FrameXmlElement,
    parent: FrameXmlFrame | undefined = undefined,
    forcedName?: string,
  ): FrameXmlFrame | undefined {
    if (!isWidget(source)) {
      this.diagnostic("addon", `unsupported FrameXML element <${source.name}> was skipped`);
      return undefined;
    }
    let element = source;
    const inherits = source.attributes["inherits"]?.trim() ?? "";
    if (inherits) {
      const resolved = this.#registry.resolve(inherits);
      if (!resolved.ok || !resolved.element) {
        for (const message of resolved.diagnostics) this.diagnostic("template", message);
        return undefined;
      }
      const own = {
        ...source,
        attributes: Object.fromEntries(
          Object.entries(source.attributes).filter(([key]) => key !== "inherits"),
        ),
      } as FrameXmlElement;
      element = mergeFrameXmlElements(resolved.element, own);
      // `name` and `virtual` belong to the template declaration, not to an
      // unnamed instance.  In particular CreateFrame(..., nil, ...,
      // "Template") must receive a fresh anonymous identity instead of
      // accidentally reusing the virtual template's global name.
      const attributes = { ...element.attributes };
      if (!Object.prototype.hasOwnProperty.call(source.attributes, "name")) delete attributes["name"];
      delete attributes["virtual"];
      element = { ...element, attributes: Object.freeze(attributes) };
    }

    const name = (forcedName ?? element.attributes["name"] ?? "").trim() || `__framexml_${++this.#anonymousId}`;
    if (this.#byName.has(name)) {
      this.diagnostic("addon", `duplicate FrameXML frame name "${name}" was skipped`);
      return undefined;
    }
    const declarations = collectDeclarations(element);
    const frame = new MutableFrameXmlFrame(
      element.name as RuntimeWidgetType,
      name,
      effectiveSizeAttributes(element),
      parent,
      declarations,
    );
    const textElement = element.children.find((child) => child.name === "Text");
    if (textElement && !frame.text) frame.text = textElement.text.trim();
    this.#frames.add(frame);
    this.#byName.set(name, frame);

    for (const child of element.children) {
      if (child.name === "Scripts" || child.name === "Events" || child.name === "Attributes") continue;
      if (isWidget(child)) {
        if (!isVirtual(child)) {
          const built = this.buildElement(child, frame);
          if (built) frame.children.push(built);
        }
      } else {
        this.buildWrappedChildren(child, frame);
      }
    }
    for (const anchor of element.children) this.collectPointDeclarations(anchor, frame);
    return frame;
  }

  private buildWrappedChildren(element: FrameXmlElement, parent: FrameXmlFrame | undefined): FrameXmlFrame[] {
    const roots: FrameXmlFrame[] = [];
    if (element.name === "Scripts" || element.name === "Events" || element.name === "Attributes") return roots;
    for (const child of element.children) {
      if (isWidget(child)) {
        if (!isVirtual(child)) {
          const built = this.buildElement(child, parent);
          if (built && parent instanceof MutableFrameXmlFrame) parent.children.push(built);
          else if (built) roots.push(built);
        }
      } else {
        roots.push(...this.buildWrappedChildren(child, parent));
      }
    }
    return roots;
  }

  private collectPointDeclarations(element: FrameXmlElement, frame: MutableFrameXmlFrame): void {
    if (element.name === "Anchor") {
      const point = element.attributes["point"];
      if (point) {
        const offset = element.children.find((child) => child.name === "Offset");
        const relativeName = element.attributes["relativeTo"]?.trim();
        const relativeTo = relativeName === "$parent"
          ? frame.parent
          : relativeName
            ? this.#byName.get(relativeName)
            : frame.parent;
        const relativePoint = element.attributes["relativePoint"];
        const x = numberAttribute(offset?.attributes["x"]);
        const y = numberAttribute(offset?.attributes["y"]);
        const pointIndex = frame.points.push({
          point,
          ...(relativeTo ? { relativeTo } : {}),
          ...(relativePoint ? { relativePoint } : {}),
          ...(x === undefined ? {} : { x }),
          ...(y === undefined ? {} : { y }),
        }) - 1;
        if (relativeName && relativeName !== "$parent" && !relativeTo) {
          this.#pendingRelativePoints.push({ frame, index: pointIndex, relativeName });
        }
      }
      return;
    }
    if (element.name === "Scripts" || element.name === "Events" || isWidget(element)) return;
    for (const child of element.children) this.collectPointDeclarations(child, frame);
  }

  private resolvePendingRelativePoints(): void {
    for (let index = this.#pendingRelativePoints.length - 1; index >= 0; index -= 1) {
      const pending = this.#pendingRelativePoints[index];
      if (!pending) continue;
      const relativeTo = this.#byName.get(pending.relativeName);
      if (!relativeTo) continue;
      const point = pending.frame.points[pending.index];
      if (point) pending.frame.points[pending.index] = { ...point, relativeTo };
      this.#pendingRelativePoints.splice(index, 1);
    }
  }

  /** Load one addon in isolation; malformed input never reaches native HUD code. */
  loadAddon(
    source: string,
    options: { readonly registerTemplates?: boolean } = {},
  ): FrameXmlAddonLoadResult {
    const before = this.#diagnostics.length;
    const parsed = parseFrameXml(source);
    // A parser result with diagnostics is not a usable document even when it
    // contains a recoverable root.  Building that root would let malformed
    // addon input partially mutate the compatibility bridge.
    if (!parsed.ok || !parsed.root) {
      for (const message of parsed.diagnostics) this.diagnostic("xml", message);
      this.diagnostic("addon", "FrameXML addon has no usable root; native HUD was left untouched");
      return {
        ok: false,
        roots: [],
        diagnostics: this.#diagnostics.slice(before),
        nativeHudUnaffected: true,
      };
    }
    // Do not register templates from an unsupported root.  Otherwise a
    // rejected document such as <Bad><Frame virtual="true" .../></Bad> could
    // still poison the shared template registry for a later addon.
    if (!isWidget(parsed.root) && parsed.root.name !== "Ui") {
      this.diagnostic("addon", `FrameXML root <${parsed.root.name}> is not <Ui> or a supported widget`);
      return {
        ok: false,
        roots: [],
        diagnostics: this.#diagnostics.slice(before),
        nativeHudUnaffected: true,
      };
    }
    const registration = options.registerTemplates === false
      ? { ok: true, diagnostics: [] as readonly string[] }
      : this.#registry.registerDocument(source);
    for (const message of registration.diagnostics) this.diagnostic("xml", message);
    const roots: FrameXmlFrame[] = [];
    if (isWidget(parsed.root) && !isVirtual(parsed.root)) {
      const root = this.buildElement(parsed.root);
      if (root) roots.push(root);
    } else if (parsed.root.name === "Ui") {
      for (const child of parsed.root.children) {
        if (isWidget(child) && !isVirtual(child)) {
          const root = this.buildElement(child);
          if (root) roots.push(root);
        } else if (child.name !== "Script" && child.name !== "Include" && !isVirtual(child)) {
          roots.push(...this.buildWrappedChildren(child, undefined));
        }
      }
    } else {
      this.diagnostic("addon", `FrameXML root <${parsed.root.name}> is not <Ui> or a supported widget`);
    }
    this.resolvePendingRelativePoints();
    this.dispatchOnLoad(roots);
    return {
      // A template-only XML file is a valid load even though it creates no
      // roots. Diagnostics (including an unsupported Lua chunk) make this
      // result non-clean, but never roll back the native HUD.
      ok: registration.ok && this.#diagnostics.length === before,
      roots,
      diagnostics: this.#diagnostics.slice(before),
      nativeHudUnaffected: true,
    };
  }

  dispatchOnLoad(roots: readonly FrameXmlFrame[]): void {
    for (const root of roots) {
      this.dispatchScript(root, "OnLoad", []);
      for (const child of root.children) this.dispatchOnLoad([child]);
    }
  }

  dispatchEvent(event: string, ...args: readonly unknown[]): number {
    const name = event.trim();
    if (!name) return 0;
    let delivered = 0;
    for (const frame of this.#frames) {
      if (!frame.registeredEvents.has(name)) continue;
      this.dispatchScript(frame, "OnEvent", [name, ...args]);
      delivered += 1;
    }
    return delivered;
  }

  private dispatchScript(frame: FrameXmlFrame, script: string, args: readonly unknown[]): void {
    const mutable = this.own(frame);
    if (!mutable) return;
    if (script === "OnLoad" && mutable.loaded) return;
    if (script === "OnLoad") mutable.loaded = true;
    const handler = mutable.scripts.get(script);
    if (handler) {
      try {
        handler(mutable, ...args);
      } catch (error) {
        this.diagnostic("script", `${frame.name}.${script} handler failed: ${String(error)}`);
      }
    }
    const source = mutable.scriptOverrides.has(script) ? undefined : mutable.scriptSources.get(script);
    if (!source) return;
    if (!this.#runtime) {
      if (!this.#unavailableScriptNotices.has(source)) {
        this.#unavailableScriptNotices.add(source);
        this.diagnostic("script", `${frame.name}.${script} retained Lua source but no LuaAddonRuntime adapter is installed`);
      }
      return;
    }
    const context: LuaScriptContext = {
      frame: mutable,
      args,
      ui: this,
      ...(script === "OnEvent" && args[0] && typeof args[0] === "string" ? { event: args[0] } : {}),
    };
    try {
      this.#runtime.execute(source, context);
    } catch (error) {
      this.diagnostic("script", `${frame.name}.${script} Lua adapter failed: ${String(error)}`);
    }
  }

  CreateFrame(type: string, name?: string, parent?: FrameXmlFrame, inherits?: string): FrameXmlFrame | undefined {
    if (!FRAME_XML_WIDGET_TYPES.has(type)) {
      this.diagnostic("addon", `CreateFrame("${type}") is not supported by the bounded bridge`);
      return undefined;
    }
    const resolvedParent = parent === undefined ? undefined : this.own(parent);
    if (parent !== undefined && !resolvedParent) return undefined;
    const attributes: Record<string, string> = {};
    if (name) attributes["name"] = name;
    if (inherits) attributes["inherits"] = inherits;
    const element: FrameXmlElement = {
      name: type,
      attributes,
      children: [],
      text: "",
    };
    const frame = this.buildElement(element, resolvedParent, name);
    if (frame && resolvedParent) resolvedParent.children.push(frame);
    this.resolvePendingRelativePoints();
    if (frame) {
      this.dispatchOnLoad([frame]);
      this.notifyMutation();
    }
    return frame;
  }

  SetScript(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler | null): boolean {
    const mutable = this.own(frame);
    const name = script.trim();
    if (!mutable || !name) return false;
    mutable.scriptOverrides.add(name);
    if (handler) mutable.scripts.set(name, handler);
    else mutable.scripts.delete(name);
    return true;
  }

  /** Dispatch a button activation with only the scalar arguments FrameXML exposes to Lua. */
  Click(frame: FrameXmlFrame, button = "LeftButton", down = false): boolean {
    const mutable = this.own(frame);
    const name = button.trim();
    if (!mutable || (mutable.type !== "Button" && mutable.type !== "CheckButton") || !name) return false;
    this.dispatchScript(mutable, "OnClick", [name, down === true]);
    return true;
  }

  /** Dispatch the FrameXML hover callback without exposing the browser event. */
  Enter(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    this.dispatchScript(mutable, "OnEnter", []);
    return true;
  }

  /** Dispatch the FrameXML hover callback without exposing the browser event. */
  Leave(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    this.dispatchScript(mutable, "OnLeave", []);
    return true;
  }

  RegisterEvent(frame: FrameXmlFrame, event: string): boolean {
    const mutable = this.own(frame);
    const name = event.trim();
    if (!mutable || !name) return false;
    mutable.registeredEvents.add(name);
    return true;
  }

  Show(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutable.visible = true;
    this.notifyMutation();
    return true;
  }

  Hide(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutable.visible = false;
    this.notifyMutation();
    return true;
  }

  SetPoint(
    frame: FrameXmlFrame,
    point: string,
    relativeTo?: FrameXmlFrame,
    relativePoint?: string,
    x?: number,
    y?: number,
  ): boolean {
    const mutable = this.own(frame);
    const relative = relativeTo === undefined ? undefined : this.own(relativeTo);
    if (!mutable || !point.trim() || (relativeTo !== undefined && !relative)) return false;
    mutable.points.push({
      point: point.trim(),
      ...(relative ? { relativeTo: relative } : {}),
      ...(relativePoint ? { relativePoint } : {}),
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
    });
    this.notifyMutation();
    return true;
  }

  SetText(frame: FrameXmlFrame, text: string): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutable.text = String(text);
    this.notifyMutation();
    return true;
  }

  SetTexture(frame: FrameXmlFrame, texture: string): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutable.texture = String(texture);
    this.notifyMutation();
    return true;
  }
}
