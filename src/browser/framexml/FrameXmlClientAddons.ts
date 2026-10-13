import { throwIfPatchChainChanged } from "../PatchChainChanged.js";

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
  readonly installed: readonly (FrameXmlClientAddon & { readonly enabled: boolean })[];
  /** The `checkAddonVersion` CVar of the client's Config.wtf (Wow.exe default on). */
  readonly checkAddonVersion: boolean;
}

const ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]*$/;

/** One list's valid, distinct entries; `enabled` read where the entry has it. */
function entries(list: unknown): (FrameXmlClientAddon & { readonly enabled: boolean })[] {
  const seen = new Set<string>();
  const addons: (FrameXmlClientAddon & { readonly enabled: boolean })[] = [];
  for (const candidate of Array.isArray(list) ? list : []) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const value = candidate as { name?: unknown; loadOnDemand?: unknown; enabled?: unknown };
    if (typeof value.name !== "string" || !ADDON_NAME.test(value.name)
      || typeof value.loadOnDemand !== "boolean") continue;
    const key = value.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addons.push(Object.freeze({ name: value.name, loadOnDemand: value.loadOnDemand, enabled: value.enabled !== false }));
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

/** The enabled add-ons alone (the mount's load list), as before 3.46's listing. */
export async function fetchFrameXmlClientAddons(
  gatewayOrigin: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<readonly FrameXmlClientAddon[]> {
  return (await fetchFrameXmlClientAddonList(gatewayOrigin, fetcher)).addons;
}
