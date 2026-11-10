import { isFullscreen, setFullscreen } from "../app/Fullscreen.js";

/**
 * 10.28 (11.11): the login screen's «Оконный режим» (GlueXML VideoOptionsPanels.xml: `VideoOptionsResolutionPanelWindowed`,
 * `cvar = "gxWindow"`) is the page's full screen, as the world's check box is (FrameXmlSettingsCVar.ts): the glue
 * keeps its own CVar table, so the same live mapping is answered here — "1" in a window, "0" filling the screen. The
 * stock panel writes the value through `SetCVar` from its «Окей» (VideoOptionsPanel_Okay → the control's SetValue),
 * a click, which is the user gesture full screen needs; a write of the value it already has changes nothing.
 */

export function isGlueWindowCVar(name: string): boolean {
  return name.toLowerCase() === "gxwindow";
}

export function glueWindowCVar(): string {
  return isFullscreen() ? "0" : "1";
}

/** A CVar's number as the client reads it: "0", "" and 0 are off. */
function cvarOn(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  return false;
}

export function setGlueWindowCVar(value: unknown): void {
  setFullscreen(!cvarOn(value));
}
