/** The add-on calling through a shared library owns the operation, rather than the library. */
export function glueCallingAddon(sources: readonly string[]): string | undefined {
  for (const source of sources) {
    const path = source.replaceAll("\\", "/").replace(/^@/, "");
    const name = path.match(/(?:^|\/)tsaddons\/([^/]+)\//i)?.[1]
      ?? path.match(/(?:^|\/)interface\/addons\/([^/]+)\//i)?.[1];
    if (name && name.toLowerCase() !== "lib") return name.toLowerCase();
  }
  return undefined;
}
