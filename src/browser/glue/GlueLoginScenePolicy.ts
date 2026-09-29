import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";

/**
 * The two figures the server's anonymous login scene owns.
 *
 * The scene is assembled by `lgzg.lua` without a stable frame name.  Its shape is stable, though:
 * one anonymous parent has both custom figure models as direct children.  That structural marker
 * lets the renderer keep the scene's characters while leaving every other screen's model policy
 * alone.
 */
const LOGIN_CHARACTER_PATHS = new Set([
  "creature/customcharacters/archibald/archibald.mdx",
  "creature/customcharacters/morethan/morethan.mdx",
]);

/**
 * Optional stock controls intentionally omitted from the browser login surface.
 *
 * These are names from `AccountLogin.xml`, not text or CSS selectors: the latter would either hide
 * controls on another glue screen or make localization part of the policy.  Keeping the names here
 * also leaves the account fields and the Login button untouched.
 */
export const GLUE_LOGIN_HIDDEN_CONTROL_NAMES: readonly string[] = Object.freeze([
  "AccountLoginCommunityButton", // Website
  "OptionsButton", // Options / Settings
  "AccountLoginExitButton", // Quit Game
]);

const LOGIN_HIDDEN_CONTROL_SET = new Set(GLUE_LOGIN_HIDDEN_CONTROL_NAMES);

/** Model paths that are deliberately not drawn in the anonymous login scene branch. */
function normalizedModelPath(frame: FrameXmlFrame): string {
  return frame.model.file.trim().replaceAll("\\", "/").toLowerCase();
}

function isLoginCharacter(frame: FrameXmlFrame): boolean {
  return LOGIN_CHARACTER_PATHS.has(normalizedModelPath(frame));
}

function hasLoginCharactersAsDirectChildren(frame: FrameXmlFrame): boolean {
  let hasArchibald = false;
  let hasMorethan = false;
  for (const child of frame.children) {
    const path = normalizedModelPath(child);
    if (path === "creature/customcharacters/archibald/archibald.mdx") hasArchibald = true;
    if (path === "creature/customcharacters/morethan/morethan.mdx") hasMorethan = true;
    if (hasArchibald && hasMorethan) return true;
  }
  return false;
}

function belongsToLoginScreen(frame: FrameXmlFrame): boolean {
  for (let parent = frame.parent; parent; parent = parent.parent) {
    if (parent.name === "AccountLogin") return true;
  }
  return false;
}

/**
 * Hide only the three optional controls declared under `AccountLogin`.
 *
 * The XML remains authoritative and all frames are still loaded, so Lua globals and account
 * controls retain their normal names.  Applying this after the TOC walk, before a screen is shown,
 * is enough to keep the policy stable when `SetGlueScreen("login")` dispatches `OnShow`.
 */
export function hideGlueLoginControls(bridge: FrameXmlUiBridge): readonly string[] {
  const hidden: string[] = [];
  for (const name of GLUE_LOGIN_HIDDEN_CONTROL_NAMES) {
    const frame = bridge.getFrame(name);
    if (!frame || !LOGIN_HIDDEN_CONTROL_SET.has(frame.name) || !belongsToLoginScreen(frame)) continue;
    if (!frame.visible) continue;
    bridge.Hide(frame);
    hidden.push(name);
  }
  return hidden;
}

/**
 * Whether a visible model frame should receive a stage view.
 *
 * `baseVisible` is the bridge's normal ancestor-aware visibility result.  The extra rule is only
 * active for a branch whose *direct* children contain both login figures.  It therefore cannot
 * blacklist `AccountLogin` globally and cannot affect the character-select/create scenes or their
 * UI model effects, all of which have a different tree shape.
 */
export function glueLoginSceneModelIsVisible(
  frame: FrameXmlFrame,
  baseVisible = true,
): boolean {
  if (!baseVisible) return false;
  const branch = frame.parent;
  if (!branch || !hasLoginCharactersAsDirectChildren(branch)) return true;
  return isLoginCharacter(frame);
}
