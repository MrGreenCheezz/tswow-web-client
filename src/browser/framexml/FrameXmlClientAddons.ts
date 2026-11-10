import { throwIfPatchChainChanged } from "../PatchChainChanged.js";
import { glueWorldAddonStates } from "../glue/GlueAddons.js"; // 3.46 (11.11)

export interface FrameXmlClientAddon {
  readonly name: string;
  readonly loadOnDemand: boolean;
}

/**
 * 3.46 (13.10): the client's whole Interface/AddOns list — the profile's switched-off add-ons too — and its
 * `checkAddonVersion` CVar, for GetNumAddOns/GetAddOnInfo (FrameXmlAddonStates.ts). `addons` stays the enabled list
 * the mount loads from.
 */
export interface FrameXmlClientAddonList {
  readonly addons: readonly FrameXmlClientAddon[];
  /** Every installed add-on in the list's order, with whether the profile enables it. */
  readonly installed: readonly FrameXmlInstalledClientAddon[];
  /** The `checkAddonVersion` CVar of the client's Config.wtf (Wow.exe default on). */
  readonly checkAddonVersion: boolean;
}

/** One installed add-on of the list. */
export interface FrameXmlInstalledClientAddon extends FrameXmlClientAddon {
  /** Whether the gateway's profile leaves it on (an unlisted add-on is on). */
  readonly enabled: boolean;
  /** 3.46 (11.11): the profile's explicit line, when it has one (an older gateway: never). */
  readonly profileState?: boolean;
  /** 3.46 (11.11): the TOC's `## DefaultState`, when it decides one. */
  readonly defaultState?: boolean;
}

const ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]*$/;

/** One list's valid, distinct entries; `enabled` read where the entry has it. */
function entries(list: unknown): FrameXmlInstalledClientAddon[] {
  const seen = new Set<string>();
  const addons: FrameXmlInstalledClientAddon[] = [];
  for (const candidate of Array.isArray(list) ? list : []) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const value = candidate as { name?: unknown; loadOnDemand?: unknown; enabled?: unknown; profileState?: unknown; defaultState?: unknown };
    if (typeof value.name !== "string" || !ADDON_NAME.test(value.name)
      || typeof value.loadOnDemand !== "boolean") continue;
    const key = value.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addons.push(Object.freeze({
      name: value.name, loadOnDemand: value.loadOnDemand, enabled: value.enabled !== false,
      ...(typeof value.profileState === "boolean" ? { profileState: value.profileState } : {}),
      ...(typeof value.defaultState === "boolean" ? { defaultState: value.defaultState } : {}),
    }));
  }
  return addons;
}

/**
 * Reads the immutable root-level add-on list selected when the gateway started.
 *
 * The list is latched with the other client-media routes: after a TSWoW build it answers 409
 * `client_patch_chain_changed`, which throws `PatchChainChangedError` (and raises the banner) so the
 * mount can fail with the reason rather than boot with no add-ons as if none were installed.
 *
 * 3.46 (13.10): a gateway older than `installed` lists the enabled add-ons alone; they stand for the whole list then,
 * and the switch keeps Wow.exe's default.
 */
export async function fetchFrameXmlClientAddonList(
  gatewayOrigin: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<FrameXmlClientAddonList> {
  const url = new URL("/client/addons", gatewayOrigin);
  const response = await fetcher(url.href, { headers: { accept: "application/json" } });
  await throwIfPatchChainChanged(response, url.pathname);
  if (!response.ok) throw new Error(`${url.pathname} returned ${response.status}`);
  const body = await response.json() as { addons?: unknown; installed?: unknown; checkAddonVersion?: unknown };
  if (!Array.isArray(body.addons)) throw new Error(`${url.pathname} returned an invalid add-on list`);
  const addons = Object.freeze(entries(body.addons).map(({ name, loadOnDemand }) => Object.freeze({ name, loadOnDemand })));
  const installed = Array.isArray(body.installed) ? entries(body.installed) : entries(body.addons);
  return Object.freeze({
    addons,
    installed: Object.freeze(installed),
    checkAddonVersion: body.checkAddonVersion !== false,
  });
}

/**
 * 3.46 (11.11): whether an installed add-on is on for the character in the world — the glue's per-character state
 * handed over at entry (glue/GlueAddons.ts `glueWorldAddonStates`, Wow.exe 0x5f7d70 for the current character), else
 * the gateway profile's.
 */
export function frameXmlCharacterAddonEnabled(addon: FrameXmlInstalledClientAddon): boolean {
  return glueWorldAddonStates()?.enabled.get(addon.name.toLowerCase()) ?? addon.enabled;
}

/** 3.46 (11.11): the mount's load list for the character: the installed add-ons on for it, else the profile's list. */
export function frameXmlCharacterAddons(list: FrameXmlClientAddonList | undefined): readonly FrameXmlClientAddon[] {
  if (!list) return [];
  if (!glueWorldAddonStates()) return list.addons;
  return list.installed.filter(frameXmlCharacterAddonEnabled).map(({ name, loadOnDemand }) => ({ name, loadOnDemand }));
}

/** 3.46 (11.11): `checkAddonVersion` as the glue left it (SetAddonVersionCheck), else Config.wtf's, else on. */
export function frameXmlCharacterAddonVersionCheck(list: FrameXmlClientAddonList | undefined): boolean {
  return glueWorldAddonStates()?.checkAddonVersion ?? list?.checkAddonVersion ?? true;
}

/** The enabled add-ons alone (the mount's load list), as before 3.46's listing. */
export async function fetchFrameXmlClientAddons(
  gatewayOrigin: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<readonly FrameXmlClientAddon[]> {
  return (await fetchFrameXmlClientAddonList(gatewayOrigin, fetcher)).addons;
}
