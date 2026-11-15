// 3.46 (follow-up, 15.11): the one `.url` file `/client/file` serves — an add-on's own `Interface\AddOns\<n>\<n>.url`,
// which Wow.exe 3.3.5a 12340 reads for an add-on whose TOC says `## Secure` (0x5f86a0 → 0x5f4fb0 → 0x5f4b00, the text
// after the first `=`; .runtime/re-2026-11-15/misc8) and answers as GetAddOnInfo's url (0x5f74b0).
//
// Not «url» added to the interface extensions: those are served from any folder the chain resolves, and a `.url`
// elsewhere is no interface file. Here the path must be exactly an add-on folder's file named after the folder, so
// the route serves nothing outside the add-on folders that lua/xml/toc/ttf could not already reach there; the shared
// `validAssetPath` checks (no `..`, no drive or UNC root, no NUL, the length) still apply first.

import { validAssetPath } from "./AssetPath.js";

const ADDON_URL = /^interface\\addons\\([^\\]+)\\([^\\]+)\.url$/i;

/** Whether `value` is `Interface\AddOns\<n>\<n>.url` (any case, `/` or `\`), and a valid asset path. */
export function validAddonUrlPath(value: string): boolean {
  const path = value.replaceAll("/", "\\");
  if (!validAssetPath(path, { extensions: ["url"], allowBang: true })) return false;
  const match = ADDON_URL.exec(path);
  return match !== null && match[1]!.toLowerCase() === match[2]!.toLowerCase();
}
