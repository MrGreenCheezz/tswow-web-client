/**
 * 3.35 (03.10, L5): SimpleHTML's font methods with an element first — `SetTextColor("h1", r, g, b)`,
 * `SetFont("h2", file, height)`, `SetSpacing("h3", 4)`, `SetJustifyH("p", "RIGHT")` — as Wow.exe 3.3.5a
 * (12340) routes them (0x009748f0; FrameXmlSimpleHtmlFonts.ts): "P" or no element is the page's own
 * FontString method, "H1"–"H3" set and read that header's settings. Set/GetFontObject keep their
 * own entries (GlueWidgets `simpleHtmlMethods`); Set/GetIndentedWordWrap the widget layer has for no
 * widget, so neither here.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlColor } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlSimpleHtmlLevel } from "../ui/framexml_compat/FrameXmlSimpleHtmlBounds.js";
import {
  frameXmlSimpleHtmlColor,
  frameXmlSimpleHtmlElement,
  frameXmlSimpleHtmlKey,
} from "../ui/framexml_compat/FrameXmlSimpleHtmlFonts.js";
import type { MethodContext, WidgetMethod } from "./GlueWidgets.js";

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** One header's setters and getters; `args` are the call's arguments after the element. */
type HeaderMethod = (context: MethodContext, level: 1 | 2 | 3, args: readonly unknown[]) => readonly unknown[] | void;

function headerMethods(bridge: FrameXmlUiBridge): Readonly<Record<string, HeaderMethod>> {
  const set = (context: MethodContext, values: Readonly<Record<string, string>>): void => {
    if (Object.entries(values).every(([key, value]) => context.self.attributes[key] === value)) return;
    bridge.update(context.frame, (mutable) => {
      for (const [key, value] of Object.entries(values)) mutable.setAttribute(key, value);
    });
  };
  const style = (context: MethodContext, level: FrameXmlSimpleHtmlLevel) => {
    const name = context.self.stateFonts.get(`FONTSTRINGHEADER${level}`) ?? "";
    return name ? bridge.fontObjectStyle(name) : undefined;
  };
  const key = frameXmlSimpleHtmlKey;
  const colour = (color: FrameXmlColor): readonly number[] => [color.r, color.g, color.b, color.a];
  return {
    SetFont: (context, level, args) => {
      const file = str(args[0]);
      const height = num(args[1]);
      if (!file || !Number.isFinite(height) || height <= 0) return [false];
      set(context, {
        [key("fontFile", level)]: file,
        [key("fontHeight", level)]: String(height),
        [key("fontFlags", level)]: str(args[2]).toUpperCase(),
      });
      return [true];
    },
    GetFont: (context, level) => {
      const own = context.self.attributes[key("fontFile", level)];
      const font = style(context, level);
      if (own === undefined && font === undefined) return [];
      return [own ?? font?.file, num(context.self.attributes[key("fontHeight", level)], font?.height ?? 12),
        context.self.attributes[key("fontFlags", level)] ?? ""];
    },
    SetTextColor: (context, level, args) => {
      const color = { r: num(args[0], 1), g: num(args[1], 1), b: num(args[2], 1), a: args[3] === undefined ? 1 : num(args[3], 1) };
      set(context, { [key("textColor", level)]: colour(color).join(" ") });
    },
    GetTextColor: (context, level) => {
      const own = frameXmlSimpleHtmlColor(context.self.attributes[key("textColor", level)]);
      return colour(own ?? style(context, level)?.color ?? { r: 1, g: 1, b: 1, a: 1 });
    },
    SetShadowColor: (context, level, args) => {
      set(context, { [key("shadowColor", level)]: [num(args[0]), num(args[1]), num(args[2]), args[3] === undefined ? 1 : num(args[3], 1)].join(" ") });
    },
    GetShadowColor: (context, level) => {
      const own = frameXmlSimpleHtmlColor(context.self.attributes[key("shadowColor", level)]);
      const color = own ?? style(context, level)?.shadowColor;
      return color ? colour(color) : [0, 0, 0, 0];
    },
    SetShadowOffset: (context, level, args) => {
      set(context, { [key("shadowOffsetX", level)]: String(num(args[0])), [key("shadowOffsetY", level)]: String(num(args[1])) });
    },
    GetShadowOffset: (context, level) => {
      const font = style(context, level);
      return [num(context.self.attributes[key("shadowOffsetX", level)], font?.shadowOffsetX ?? 0),
        num(context.self.attributes[key("shadowOffsetY", level)], font?.shadowOffsetY ?? 0)];
    },
    SetSpacing: (context, level, args) => {
      const spacing = num(args[0], Number.NaN);
      if (Number.isFinite(spacing)) set(context, { [key("spacing", level)]: String(spacing) });
    },
    GetSpacing: (context, level) => [num(context.self.attributes[key("spacing", level)], style(context, level)?.spacing ?? 0)],
    SetJustifyH: (context, level, args) => {
      const justify = str(args[0]).toUpperCase();
      if (justify) set(context, { [key("justifyH", level)]: justify });
    },
    GetJustifyH: (context, level) => [context.self.attributes[key("justifyH", level)] ?? style(context, level)?.justifyH ?? ""],
    SetJustifyV: (context, level, args) => {
      const justify = str(args[0]).toUpperCase();
      if (justify) set(context, { [key("justifyV", level)]: justify });
    },
    GetJustifyV: (context, level) => [context.self.attributes[key("justifyV", level)] ?? style(context, level)?.justifyV ?? ""],
  };
}

/** The element-aware entries over the page's FontString methods `text`. */
export function simpleHtmlElementFontMethods(
  bridge: FrameXmlUiBridge,
  text: Readonly<Record<string, WidgetMethod>>,
): Record<string, WidgetMethod> {
  const headers = headerMethods(bridge);
  const methods: Record<string, WidgetMethod> = {};
  for (const [name, header] of Object.entries(headers)) {
    const page = text[name];
    if (!page) continue;
    methods[name] = (context) => {
      const level = frameXmlSimpleHtmlElement(context.args[0]);
      if (level === undefined) return page(context);
      const args = context.args.slice(1);
      return level === 0 ? page({ ...context, args }) : header(context, level, args);
    };
  }
  return methods;
}
