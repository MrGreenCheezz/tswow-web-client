import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export interface ClientAddonDescriptor {
  readonly name: string;
  readonly loadOnDemand: boolean;
}

const CLIENT_ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]*$/;

export interface ClientAddonDiscoveryOptions {
  /** Optional profile inside CLIENT_DIR/WTF. An explicit choice wins over automatic consensus. */
  readonly addonsFile?: string;
}

/** Only explicit disabled entries matter; an unlisted installed add-on keeps its existing state. */
export function disabledClientAddons(source: string): ReadonlySet<string> {
  const states = new Map<string, boolean>();
  const conflicts = new Set<string>();
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^([^:]+):\s*(enabled|disabled)\s*$/i.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.trim();
    if (!CLIENT_ADDON_NAME.test(name)) continue;
    const key = name.toLowerCase();
    const disabled = match[2]!.toLowerCase() === "disabled";
    if (states.has(key) && states.get(key) !== disabled) conflicts.add(key);
    states.set(key, disabled);
  }
  return new Set([...states].filter(([name, disabled]) => disabled && !conflicts.has(name))
    .map(([name]) => name));
}

async function profileText(clientRoot: string, selectedFile: string | undefined): Promise<string | undefined> {
  const wtf = join(clientRoot, "WTF");
  if (selectedFile !== undefined && selectedFile.trim() !== "") {
    try {
      const boundary = await realpath(wtf);
      const chosen = await realpath(isAbsolute(selectedFile) ? selectedFile : resolve(wtf, selectedFile));
      const within = relative(boundary, chosen);
      if (basename(chosen).toLowerCase() !== "addons.txt"
        || within === "" || within === ".." || within.startsWith(`..\\`) || within.startsWith("../")
        || isAbsolute(within)) throw new Error("outside selected client profile");
      return await readFile(chosen, "utf8");
    } catch {
      // The option is local configuration, not a reason to stop the unrelated gateway routes.
      console.warn("Selected client AddOns.txt is unavailable; installed add-on defaults remain in use.");
      return undefined;
    }
  }

  // The current original client has seven byte-identical character profiles. Apply their shared
  // explicit states without guessing which account/realm/character the browser session represents.
  // If profiles diverge, keep installed defaults until one is selected explicitly.
  const paths: string[] = [];
  const queue: { directory: string; depth: number }[] = [{ directory: join(wtf, "Account"), depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try { entries = await readdir(current.directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === "addons.txt") {
        paths.push(join(current.directory, entry.name));
      } else if (entry.isDirectory() && current.depth < 3) {
        queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
  }
  if (paths.length === 0) return undefined;
  let first: Buffer | undefined;
  try {
    for (const path of paths) {
      const bytes = await readFile(path);
      if (first && !first.equals(bytes)) return undefined;
      first = bytes;
    }
  } catch {
    console.warn("Client AddOns.txt profiles could not be compared; installed add-on defaults remain in use.");
    return undefined;
  }
  return first?.toString("utf8");
}

/** Discover native root-level AddOns, honoring only an unambiguous selected profile. */
export async function discoverClientAddons(
  clientRoot: string,
  options: ClientAddonDiscoveryOptions = {},
): Promise<readonly ClientAddonDescriptor[]> {
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
  const disabled = disabledClientAddons(await profileText(clientRoot, options.addonsFile) ?? "");
  return addons.filter((addon) => !disabled.has(addon.name.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
}
