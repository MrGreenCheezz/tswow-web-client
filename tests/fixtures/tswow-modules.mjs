// Which TSWoW modules this machine's install carries, for the tests of one module.
//
// Owner decision 08.10: the reference dataset is the base one without modules, so a test of a
// module (retail-talents, gem-abilities, minimap-hub…) skips with the module's name when it is not
// installed, and runs as before when it is. "Installed" is both halves of what tswow itself uses:
// the module directory under `<install>/modules/` and the module in the dataset's `modules.txt`
// (the runtime list `Dataset.Modules` resolves to; a submodule is `<module>.<child>`).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let install;
try {
  install = (await import("../../tools/paths.mjs")).tswowInstall();
} catch {
  install = undefined;
}

let listed;
function listedModules() {
  if (listed) return listed;
  listed = new Set();
  if (!install) return listed;
  const file = join(install, "modules/default/datasets/dataset/modules.txt");
  if (!existsSync(file)) return listed;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const id = line.trim();
    if (id) listed.add(id.split(".")[0].toLowerCase());
  }
  return listed;
}

/** True when `<install>/modules/<name>` exists and the dataset's modules.txt lists it. */
export function tswowModuleInstalled(name) {
  return Boolean(install) && existsSync(join(install, "modules", name))
    && listedModules().has(name.toLowerCase());
}

/** A `skip` value for node:test: false when every named module is installed, else the reason. */
export function tswowModuleSkip(...names) {
  const missing = names.filter((name) => !tswowModuleInstalled(name));
  if (missing.length === 0) return false;
  return `TSWoW module ${missing.join(", ")} is not installed in ${install ?? "any TSWoW install"} `
    + "(base dataset without modules, owner decision 08.10)";
}
