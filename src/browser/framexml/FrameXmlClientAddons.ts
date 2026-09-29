import { throwIfPatchChainChanged } from "../PatchChainChanged.js";

export interface FrameXmlClientAddon {
  readonly name: string;
  readonly loadOnDemand: boolean;
}

const ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]*$/;

/**
 * Reads the immutable root-level add-on list selected when the gateway started.
 *
 * The list is latched with the other client-media routes: after a TSWoW build it answers 409
 * `client_patch_chain_changed`, which throws `PatchChainChangedError` (and raises the banner) so the
 * mount can fail with the reason rather than boot with no add-ons as if none were installed.
 */
export async function fetchFrameXmlClientAddons(
  gatewayOrigin: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<readonly FrameXmlClientAddon[]> {
  const url = new URL("/client/addons", gatewayOrigin);
  const response = await fetcher(url.href, { headers: { accept: "application/json" } });
  await throwIfPatchChainChanged(response, url.pathname);
  if (!response.ok) throw new Error(`${url.pathname} returned ${response.status}`);
  const body = await response.json() as { addons?: unknown };
  if (!Array.isArray(body.addons)) throw new Error(`${url.pathname} returned an invalid add-on list`);
  const seen = new Set<string>();
  const addons: FrameXmlClientAddon[] = [];
  for (const candidate of body.addons) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const value = candidate as { name?: unknown; loadOnDemand?: unknown };
    if (typeof value.name !== "string" || !ADDON_NAME.test(value.name)
      || typeof value.loadOnDemand !== "boolean") continue;
    const key = value.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addons.push(Object.freeze({ name: value.name, loadOnDemand: value.loadOnDemand }));
  }
  return Object.freeze(addons);
}
