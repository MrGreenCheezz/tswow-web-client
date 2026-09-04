/** Executes every root-level client AddOn against the production FrameXML host. */

import { clientDirectory } from "./paths.mjs";
import { clientArchives } from "./mpq.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { FRAMEXML_VERTICAL_TOC } from "../dist/code/browser/framexml/FrameXmlCorpus.js";
import { CannedWorldSeam } from "../dist/code/browser/framexml/CannedWorldSeam.js";
import { discoverClientAddons } from "../dist/code/gateway/ClientAddons.js";

const root = clientDirectory();
const addons = await discoverClientAddons(root);
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
  const failures = results.filter((result) => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? "OK" : "FAIL"} ${result.addon} (${result.status}, ${result.loaded.length} files)`);
    if (!result.ok && result.message) console.error(`  ${result.message.replaceAll("\n", "\n  ")}`);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${results.length} client AddOn loads failed`);
  }
  console.log(`Client AddOn runtime check passed: ${results.length} load paths (${eager.length} eager, ${addons.length - eager.length} on demand).`);
} finally {
  boot.close();
}
