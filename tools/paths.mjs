// Where the 3.3.5a client and the tswow dataset live.
//
// Every generator and the gateway resolve through here, so a machine is described in one place.
// Each location is an environment variable first, then a short list of known locations, and the
// first one that actually holds the expected contents wins. Before this the paths were repeated
// as literals in seven generators, `DBC_DIR` was honoured by the gateway and ignored by all of
// them, and the whole set pointed at an installation that is no longer the one in use.

import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.mjs";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function firstExisting(label, override, candidates, marker) {
  if (override) {
    const chosen = resolve(override);
    if (!existsSync(join(chosen, marker))) {
      throw new Error(`${label} was set to ${chosen}, which has no ${marker}`);
    }
    return chosen;
  }
  for (const candidate of candidates) {
    const chosen = resolve(candidate);
    if (existsSync(join(chosen, marker))) return chosen;
  }
  throw new Error(
    `Could not find ${label}. Looked for a directory containing ${marker} in:\n  ${candidates.join("\n  ")}\n` +
    `Set the environment variable to point at it.`);
}

/** The retail 3.3.5a client, i.e. the directory holding `Data` with the MPQ archives. */
export function clientDirectory() {
  return firstExisting("CLIENT_DIR", process.env.CLIENT_DIR, [
    join(repositoryRoot, "../Circle"),
  ], "Data");
}

/** The tswow installation, i.e. the directory holding `modules` and `bin`. */
export function tswowInstall() {
  return firstExisting("TSWOW_INSTALL", process.env.TSWOW_INSTALL, [
    join(repositoryRoot, "../tswow-install"),
  ], "modules/default/datasets/dataset");
}

/** The built dataset: DBCs, maps, vmaps and the interface sources tswow ships. */
export function datasetDirectory() {
  if (process.env.TSWOW_DATASET) return resolve(process.env.TSWOW_DATASET);
  return join(tswowInstall(), "modules/default/datasets/dataset");
}

export function dbcDirectory() {
  return process.env.DBC_DIR ? resolve(process.env.DBC_DIR) : join(datasetDirectory(), "dbc");
}

export function mapsDirectory() {
  return process.env.MAPS_DIR ? resolve(process.env.MAPS_DIR) : join(datasetDirectory(), "maps");
}

export function vmapsDirectory() {
  return process.env.VMAPS_DIR ? resolve(process.env.VMAPS_DIR) : join(datasetDirectory(), "vmaps");
}

/** FrameXML, GlueXML and the Blizzard_* addons, in plain text, as tswow patched them. */
export function interfaceDirectory() {
  return join(datasetDirectory(), "luaxml/Interface");
}

/**
 * Where a module's own definitions live: the local drafts directory first, then every tswow module.
 *
 * There are two roots because drafts and installed modules use different layouts. A tswow module
 * keeps the content studio output under `content/` — `modules/<mod>/content/messages/*.json`
 * — and that directory belongs to the studio rather than to tswow: `Modules.ts:60-66` initialises
 * only `datascripts`, `livescripts`, `addon`, `shared` and `lua`, so reading `content/` costs a
 * tswow build nothing. A draft under `data/ui/<mod>/messages/*.json` is nobody's build output and
 * carries no `content/` level; it is where a definition goes before it belongs to a module.
 *
 * **The drafts root is first, and the order is the whole of what «draft» means.** Both the index
 * and the file route take the first root that has a given file, so with the module root first a
 * draft of a file the module already ships could never be read — the directory would be a place to
 * put files that nothing loads. Its purpose is to try a change before writing it into the module,
 * which requires that it win. Shadowing is per file: the module's other files still load, and the
 * index says `"source": "draft"` beside the one that was shadowed, so a forgotten draft is visible
 * in the diagnostics window rather than mysterious.
 *
 * `MODULE_DIRS` replaces **both** roots, which is what М9's `modules:check` needs to be checkable
 * at all: the acceptance is «the build fails when a shipped module window would half-work», and
 * proving that means pointing the walk at a directory holding a file that half-works rather than at
 * this machine's real modules. The entries are separated the way every other path list on this
 * platform is (`;` on Windows, `:` elsewhere), and one of them may name the level between the module
 * and its definition directories after a `>` — `/somewhere>content` for a tswow-shaped tree,
 * plain for a drafts-shaped one. `>` is not a character a path may hold on Windows and is
 * vanishingly rare elsewhere, which is why it is the separator rather than a second variable.
 */
export function moduleDirectories() {
  const override = process.env.MODULE_DIRS;
  if (override) {
    return override
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const cut = entry.indexOf(">");
        const root = cut < 0 ? entry : entry.slice(0, cut);
        return {
          root: resolve(root),
          inner: cut < 0 ? "" : entry.slice(cut + 1).trim(),
          // Not «draft» and not «module»: this is neither, and the word is printed in the
          // diagnostics window beside every file it lists.
          source: "override",
        };
      });
  }
  // Merely listing module roots must remain useful on a clean checkout. The consumers already
  // treat absent roots as empty; validating the complete tswow dataset here would make unrelated
  // gateway/module tests depend on a local installation.
  const installRoot = resolve(process.env.TSWOW_INSTALL ?? join(repositoryRoot, "../tswow-install"));
  return [
    { root: join(repositoryRoot, "data/ui"), inner: "", source: "draft" },
    { root: join(installRoot, "modules"), inner: "content", source: "module" },
  ];
}

/** The realm config the item and creature dumps read their database credentials from. */
export function worldserverConf() {
  return process.env.WORLDSERVER_CONF
    ? resolve(process.env.WORLDSERVER_CONF)
    : join(tswowInstall(), "modules/default/realms/realm/worldserver.conf");
}

/** tswow bundles a mysql client; the dumps shell out to it rather than adding a driver. */
export function mysqlBinary() {
  return process.env.MYSQL_BIN ? resolve(process.env.MYSQL_BIN) : join(tswowInstall(), "bin/mysql/mysql.exe");
}
