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
  /**
   * Also list the add-ons the profile disables (offline checks only, `CLIENT_ADDONS_INCLUDE_DISABLED`;
   * the gateway never sets it — the owner's `AddOns.txt` decides what the browser loads).
   */
  readonly includeDisabled?: boolean;
}

/**
 * 3.46 (11.11): the profile's explicit states by lower-case name \u2014 true for `enabled`, false for `disabled`; a
 * name listed both ways is left out (the profile does not decide it).
 */
export function clientAddonProfileStates(source: string): ReadonlyMap<string, boolean> {
  const states = new Map<string, boolean>();
  const conflicts = new Set<string>();
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^([^:]+):\s*(enabled|disabled)\s*$/i.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.trim();
    if (!CLIENT_ADDON_NAME.test(name)) continue;
    const key = name.toLowerCase();
    const enabled = match[2]!.toLowerCase() === "enabled";
    if (states.has(key) && states.get(key) !== enabled) conflicts.add(key);
    states.set(key, enabled);
  }
  for (const name of conflicts) states.delete(name);
  return states;
}

/** Only explicit disabled entries matter; an unlisted installed add-on keeps its existing state. */
export function disabledClientAddons(source: string): ReadonlySet<string> {
  return new Set([...clientAddonProfileStates(source)].filter(([, enabled]) => !enabled).map(([name]) => name));
}

/**
 * 3.46 (11.11): a TOC's `## DefaultState`, as Wow.exe's TOC reader 0x005f86a0 takes it (.runtime/re-2026-11-07/318
 * toc.c): the key `DefaultState:` (any case) after "##" and spaces, the value past the ':'s and spaces compared whole,
 * any case, with "enabled" and "disabled" (0x0076e780 over 0x7fffffff); the reader's tokenizer 0x0076f1e0 splits at
 * '\r' and '\n' alike (its delimiters at 0x009f15f0 are "\r\n"). Undefined when no line decides it; the last deciding
 * line wins.
 */
export function clientAddonDefaultState(toc: string): boolean | undefined {
  let state: boolean | undefined;
  for (const line of toc.replace(/^\uFEFF/, "").split(/[\r\n]/)) {
    if (!line.startsWith("##")) continue;
    const rest = line.slice(2).replace(/^ +/, "");
    if (rest.slice(0, "DefaultState:".length).toLowerCase() !== "defaultstate:") continue;
    const value = rest.slice("DefaultState".length).replace(/^[: ]+/, "").toLowerCase();
    if (value === "enabled") state = true;
    else if (value === "disabled") state = false;
  }
  return state;
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

/**
 * 3.46 (13.10): every installed add-on with whether the profile enables it — what Wow.exe's GetNumAddOns/GetAddOnInfo
 * list (0x00511200/0x00511240), the switched-off ones as DISABLED — in the same order as `discoverClientAddons`.
 */
export async function listClientAddons(
  clientRoot: string,
  options: Pick<ClientAddonDiscoveryOptions, "addonsFile"> = {},
): Promise<readonly ClientAddonListing[]> {
  const states = clientAddonProfileStates(await profileText(clientRoot, options.addonsFile) ?? "");
  return (await installedClientAddons(clientRoot)).map(({ defaultState, ...addon }) => {
    const profileState = states.get(addon.name.toLowerCase());
    return {
      ...addon,
      enabled: profileState !== false,
      // 3.46 (11.11): what the glue's per-character states start from — the profile's own line (Wow.exe falls back
      // to the account's AddOns.txt for a character without one, 0x005f91e0) and the TOC's DefaultState.
      ...(profileState === undefined ? {} : { profileState }),
      ...(defaultState === undefined ? {} : { defaultState }),
    };
  });
}

/** One `/client/addons` `installed` entry. */
export interface ClientAddonListing extends ClientAddonDescriptor {
  /** Whether the profile leaves it on (an unlisted add-on is on). */
  readonly enabled: boolean;
  /** The profile's explicit line, when it has one. */
  readonly profileState?: boolean;
  /** The TOC's `## DefaultState`, when it decides one. */
  readonly defaultState?: boolean;
}

/**
 * 3.46 (13.10): the client's `checkAddonVersion` CVar from WTF/Config.wtf (`SET checkAddonVersion "0"` is the
 * glue's «Load out of date AddOns»); Wow.exe registers it on («1»), so a missing file or line keeps it on.
 */
export async function clientAddonVersionCheck(clientRoot: string): Promise<boolean> {
  let text: string;
  try { text = await readFile(join(clientRoot, "WTF", "Config.wtf"), "utf8"); } catch { return true; }
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*SET\s+checkAddonVersion\s+"([^"]*)"\s*$/i.exec(line);
    if (match) value = match[1];
  }
  if (value === undefined) return true;
  // An integer CVar: atoi, so anything without leading digits is 0.
  const number = Number.parseInt(value.trim(), 10);
  return Number.isFinite(number) && number !== 0;
}

/** Discover native root-level AddOns, honoring only an unambiguous selected profile. */
export async function discoverClientAddons(
  clientRoot: string,
  options: ClientAddonDiscoveryOptions = {},
): Promise<readonly ClientAddonDescriptor[]> {
  // The load list keeps its two fields; DefaultState is the listing's (3.46, 11.11).
  const installed = (await installedClientAddons(clientRoot)).map(({ name, loadOnDemand }) => ({ name, loadOnDemand }));
  if (options.includeDisabled === true) return installed;
  const disabled = disabledClientAddons(await profileText(clientRoot, options.addonsFile) ?? "");
  return installed.filter((addon) => !disabled.has(addon.name.toLowerCase()));
}

/**
 * The installed add-ons (a root directory with its own `.toc`) that the profile disables, sorted —
 * so the offline checks can say what they skipped instead of a bare count (9.07). Divergent
 * profiles disable nothing (see `profileText`), and then nothing is named.
 */
export async function disabledByProfile(
  clientRoot: string,
  options: Pick<ClientAddonDiscoveryOptions, "addonsFile"> = {},
): Promise<readonly string[]> {
  const disabled = disabledClientAddons(await profileText(clientRoot, options.addonsFile) ?? "");
  return (await installedClientAddons(clientRoot))
    .filter((addon) => disabled.has(addon.name.toLowerCase())).map((addon) => addon.name);
}

async function installedClientAddons(
  clientRoot: string,
): Promise<readonly (ClientAddonDescriptor & { readonly defaultState?: boolean })[]> {
  const root = join(clientRoot, "Interface", "AddOns");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const addons: (ClientAddonDescriptor & { defaultState?: boolean })[] = [];
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
    const defaultState = clientAddonDefaultState(source); // 3.46 (11.11)
    addons.push({
      name: entry.name,
      loadOnDemand: /^\s*##\s*LoadOnDemand\s*:\s*(?:1|true|yes)\s*$/im.test(source),
      ...(defaultState === undefined ? {} : { defaultState }),
    });
  }
  return addons.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
}
