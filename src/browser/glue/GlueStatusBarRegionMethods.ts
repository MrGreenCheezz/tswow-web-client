/**
 * plates12 (15.11, plan items 6.37 and 3.21): the StatusBar methods a name-plate add-on reads, over the bar's texture
 * region (FrameXmlStatusBarRegion.ts).
 *
 * - `GetStatusBarTexture()` answers the bar's Texture region where it has one (the name plates' bars: the stand's
 *   recording `F:\WowOracle\runs\plates-probe3.txt` reads `tex:GetTexture()` off it); other bars keep answering their
 *   texture path, as before.
 * - `GetStatusBarColor()` answers the bar's colour, (r, g, b, a) — the recording's `col=` of every plate bar (add-ons
 *   tell a hostile plate from a friendly one by it). It was missing: a call raised «attempt to call a nil value».
 * - The setters that change what the fill shows (value, range, colour, picture, orientation) lay the region on the bar
 *   again after the shared method has run.
 */
import { frameXmlStatusBarRegion, syncFrameXmlStatusBarRegion } from "../ui/framexml_compat/FrameXmlStatusBarRegion.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { WidgetMethod } from "./GlueWidgets.js";

const SYNCED = ["SetValue", "SetMinMaxValues", "SetStatusBarColor", "SetStatusBarTexture", "SetOrientation"] as const;

/** The overrides, built over the StatusBar's own `methods` (the value and status-bar tables already merged). */
export function statusBarRegionMethods(
  bridge: FrameXmlUiBridge,
  methods: Readonly<Record<string, WidgetMethod>>,
): Record<string, WidgetMethod> {
  const overrides: Record<string, WidgetMethod> = {
    GetStatusBarTexture: (context) => {
      const region = frameXmlStatusBarRegion(context.frame);
      if (region) return [region];
      return methods["GetStatusBarTexture"]?.(context);
    },
    GetStatusBarColor: ({ self }) => {
      const colour = self.statusBar.color;
      return [colour.r, colour.g, colour.b, colour.a];
    },
  };
  for (const name of SYNCED) {
    const base = methods[name];
    if (!base) continue;
    overrides[name] = (context) => {
      const result = base(context);
      if (frameXmlStatusBarRegion(context.frame)) syncFrameXmlStatusBarRegion(bridge, context.frame);
      return result;
    };
  }
  return overrides;
}
