import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ClientAddonDescriptor {
  readonly name: string;
  readonly loadOnDemand: boolean;
}

const CLIENT_ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]*$/;

/** Discover native root-level AddOns without interpreting or rewriting their files. */
export async function discoverClientAddons(clientRoot: string): Promise<readonly ClientAddonDescriptor[]> {
  const root = join(clientRoot, "Interface", "AddOns");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const addons: ClientAddonDescriptor[] = [];
  for (const entry of entries) {
    if (!CLIENT_ADDON_NAME.test(entry.name)) {
      console.warn(`Client add-on ignored: ${entry.name} is not a safe single-directory name`);
      continue;
    }
    const directory = join(root, entry.name);
    let directoryEntry = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { directoryEntry = (await stat(directory)).isDirectory(); } catch { directoryEntry = false; }
    }
    if (!directoryEntry) continue;
    let files;
    try { files = await readdir(directory); } catch { continue; }
    const toc = files.find((file) => file.toLowerCase() === `${entry.name.toLowerCase()}.toc`);
    if (!toc) continue;
    let source: string;
    try { source = await readFile(join(directory, toc), "utf8"); } catch { continue; }
    addons.push({
      name: entry.name,
      loadOnDemand: /^\s*##\s*LoadOnDemand\s*:\s*(?:1|true|yes)\s*$/im.test(source),
    });
  }
  return addons.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
}
