/**
 * Small, deliberately DOM-free types for the FrameXML compatibility seam.
 *
 * This is not an implementation of Blizzard's Lua VM. XML is data that can be
 * loaded safely, while executable Lua is handed to an explicitly supplied
 * adapter (see LuaAddonRuntime below). Keeping that boundary explicit prevents
 * an addon from receiving the browser document, fetch, or other host globals.
 */

export type FrameXmlWidgetType =
  | "Frame"
  | "Button"
  | "Texture"
  | "FontString"
  | "CheckButton"
  | "EditBox"
  | "ScrollFrame"
  | "Slider"
  | "StatusBar"
  | "Model"
  | "Cooldown"
  | "MessageFrame";

export const FRAME_XML_WIDGET_TYPES: ReadonlySet<string> = new Set([
  "Frame",
  "Button",
  "Texture",
  "FontString",
  "CheckButton",
  "EditBox",
  "ScrollFrame",
  "Slider",
  "StatusBar",
  "Model",
  "Cooldown",
  "MessageFrame",
]);

export interface FrameXmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly FrameXmlElement[];
  readonly text: string;
}

export interface FrameXmlParseResult {
  readonly ok: boolean;
  readonly root?: FrameXmlElement;
  readonly diagnostics: readonly string[];
}

export interface FrameXmlTemplate {
  readonly name: string;
  readonly element: FrameXmlElement;
  readonly source?: string;
}

export interface FrameXmlResolvedTemplate {
  readonly ok: boolean;
  readonly element?: FrameXmlElement;
  readonly diagnostics: readonly string[];
}

export interface FrameXmlPoint {
  readonly point: string;
  readonly relativeTo?: FrameXmlFrame;
  readonly relativePoint?: string;
  readonly x?: number;
  readonly y?: number;
}

export type FrameXmlScriptHandler = (
  self: FrameXmlFrame,
  ...args: readonly unknown[]
) => void;

export interface LuaScriptContext {
  readonly frame: FrameXmlFrame;
  readonly event?: string;
  readonly args: readonly unknown[];
  readonly ui: FrameXmlUiApi;
}

/**
 * Adapter seam for a real sandboxed Lua 5.1-compatible runtime.
 *
 * The web client intentionally ships no Lua interpreter here. An adapter may
 * execute a chunk only against the capability-limited `LuaScriptContext`; it
 * must not expose `window`, `document`, fetch, WebSocket, or arbitrary host
 * objects. The default bridge records the limitation and keeps the native HUD
 * alive instead of attempting to parse or partially execute Lua.
 */
export interface LuaAddonRuntime {
  readonly name: string;
  readonly luaVersion: string;
  execute(source: string, context: LuaScriptContext): void;
}

export interface FrameXmlDiagnostic {
  readonly scope: "xml" | "template" | "addon" | "script";
  readonly message: string;
}

export interface FrameXmlFrame {
  readonly type: FrameXmlWidgetType;
  readonly name: string;
  readonly parent?: FrameXmlFrame;
  readonly children: readonly FrameXmlFrame[];
  readonly attributes: Readonly<Record<string, string>>;
  readonly points: readonly FrameXmlPoint[];
  readonly scriptSources: ReadonlyMap<string, string>;
  readonly registeredEvents: ReadonlySet<string>;
  readonly scripts: ReadonlyMap<string, FrameXmlScriptHandler>;
  readonly visible: boolean;
  readonly text: string;
  readonly texture: string;
  readonly loaded: boolean;
}

/** The capability surface intentionally contains no DOM or network methods. */
export interface FrameXmlUiApi {
  CreateFrame(
    type: string,
    name?: string,
    parent?: FrameXmlFrame,
    inherits?: string,
  ): FrameXmlFrame | undefined;
  SetScript(
    frame: FrameXmlFrame,
    script: string,
    handler: FrameXmlScriptHandler | null,
  ): boolean;
  Click(frame: FrameXmlFrame, button?: string, down?: boolean): boolean;
  /** Dispatch the scalar-only FrameXML hover callbacks; never forwards a DOM event. */
  Enter(frame: FrameXmlFrame): boolean;
  Leave(frame: FrameXmlFrame): boolean;
  RegisterEvent(frame: FrameXmlFrame, event: string): boolean;
  Show(frame: FrameXmlFrame): boolean;
  Hide(frame: FrameXmlFrame): boolean;
  SetPoint(
    frame: FrameXmlFrame,
    point: string,
    relativeTo?: FrameXmlFrame,
    relativePoint?: string,
    x?: number,
    y?: number,
  ): boolean;
  SetText(frame: FrameXmlFrame, text: string): boolean;
  SetTexture(frame: FrameXmlFrame, texture: string): boolean;
}

export interface FrameXmlUiBridgeOptions {
  readonly runtime?: LuaAddonRuntime;
  readonly onDiagnostic?: (diagnostic: FrameXmlDiagnostic) => void;
}

export interface FrameXmlAddonLoadResult {
  readonly ok: boolean;
  readonly roots: readonly FrameXmlFrame[];
  readonly diagnostics: readonly FrameXmlDiagnostic[];
  /** Always true: this loader has no mutation path into the native HUD. */
  readonly nativeHudUnaffected: true;
}
