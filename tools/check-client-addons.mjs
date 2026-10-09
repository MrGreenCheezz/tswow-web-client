/**
 * Executes every root-level client AddOn against the production FrameXML host.
 *
 * The owner's `AddOns.txt` decides which ones the browser loads; the ones it disables are named and
 * skipped. `CLIENT_ADDONS_INCLUDE_DISABLED=1` runs them too, marked "disabled": their failures are
 * reported in a separate total and do not fail the check while the profile keeps them off (9.07).
 */

import { clientDirectory } from "./paths.mjs";
import { clientArchives } from "./mpq.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { FRAMEXML_VERTICAL_TOC } from "../dist/code/browser/framexml/FrameXmlCorpus.js";
import { CannedWorldSeam } from "../dist/code/browser/framexml/CannedWorldSeam.js";
import { disabledByProfile, discoverClientAddons } from "../dist/code/gateway/ClientAddons.js";

const root = clientDirectory();
const profile = process.env.CLIENT_ADDONS_FILE ? { addonsFile: process.env.CLIENT_ADDONS_FILE } : {};
const includeDisabled = process.env.CLIENT_ADDONS_INCLUDE_DISABLED === "1";
const disabledNames = await disabledByProfile(root, profile);
const disabled = new Set(disabledNames.map((name) => name.toLowerCase()));
const addons = await discoverClientAddons(root, { ...profile, includeDisabled });
if (disabled.size > 0) {
  const names = disabledNames.join(", ");
  console.log(includeDisabled
    ? `Disabled by the AddOns.txt profile, checked anyway (CLIENT_ADDONS_INCLUDE_DISABLED=1): ${names}`
    : `Disabled by the AddOns.txt profile, not checked: ${names} (CLIENT_ADDONS_INCLUDE_DISABLED=1 runs them)`);
}
if (addons.length === 0) {
  console.log(`No root-level client AddOns found under ${root}.`);
  process.exit(0);
}

const chain = await clientArchives(root);
const decoder = new TextDecoder("utf-8");
const provider = {
  async read(path) {
    const data = await chain.read(path);
    return data ? decoder.decode(data) : undefined;
  },
};
const eager = addons.filter((addon) => !addon.loadOnDemand).map((addon) => addon.name);
const boot = new FrameXmlBoot({
  provider,
  locale: process.env.CLIENT_LOCALE ?? "ruRU",
  subset: FRAMEXML_VERTICAL_TOC,
  includeActiveTsAddons: true,
  exercise: false,
  seam: new CannedWorldSeam(),
  installedAddons: addons.map((addon) => addon.name),
  eagerAddons: eager,
});

try {
  await boot.load();
  const results = [...boot.addonResults];
  for (const addon of addons) {
    if (addon.loadOnDemand) results.push(await boot.loadAddon(addon.name));
  }
  const isDisabled = (result) => disabled.has(String(result.addon).toLowerCase());
  const enabledResults = results.filter((result) => !isDisabled(result));
  const disabledResults = results.filter(isDisabled);
  const failures = enabledResults.filter((result) => !result.ok);
  for (const result of results) {
    const mark = isDisabled(result) ? " [disabled]" : "";
    console.log(`${result.ok ? "OK" : "FAIL"} ${result.addon}${mark} (${result.status}, ${result.loaded.length} files)`);
    if (!result.ok && result.message) console.error(`  ${result.message.replaceAll("\n", "\n  ")}`);
  }
  // Lua errors the loads raised (a load can return ok while a file inside it raised).
  for (const failure of boot.errors.slice(0, 20)) {
    console.log(`  Lua error ${failure.file}:${failure.line} ${failure.message.split("\n")[0]}${failure.count > 1 ? ` (x${failure.count})` : ""}`);
  }
  if (boot.errorCount > 0) console.log(`Lua errors after the loads: ${boot.errorCount}`);
  if (disabledResults.length > 0) {
    const failed = disabledResults.filter((result) => !result.ok).length;
    console.log(`disabled: ${disabledResults.length - failed} ok / ${failed} failed (not counted while the profile disables them)`);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${enabledResults.length} client AddOn loads failed`);
  }
  console.log(`Client AddOn runtime check passed: ${enabledResults.length} load paths (${eager.length} eager, ${addons.length - eager.length} on demand).`);
} finally {
  boot.close();
}
