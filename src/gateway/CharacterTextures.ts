// Which of the character pipeline's texture files the client archives actually hold.
//
// The DBCs name a file; only the archives know whether it is there. Two places in
// `CharacterAppearance` used to guess and be wrong:
//
// * An item's component textures are spelt `<name>_M.blp`, `<name>_F.blp` or `<name>_U.blp`
//   depending on whether the artist drew one picture or two, and `ItemDisplayInfo` names only the
//   stem. `#paint` offered the gendered spelling first and `_U` as a fallback: measured over the
//   38,609 items of `data/items.json`, **27,364 of 35,904** component layers (76.2%) asked first
//   for a file that is not in the client, against 75 with this index to hand. The atlas cannot
//   finish until every 404 has come back, and the unit holds its capsule until it does.
// * A creature's baked body replaces every other layer of the atlas, so a display naming a bake
//   the archives do not have composed to **nothing** — and the browser then rebuilt that nothing
//   sixty times a second for ever. Eight of the 15,453 extended displays that name a bake do; with
//   this index all eight get the body `CharSections` describes, and all eight of those resolve.
//
// The gateway does not open archives itself: StormLib's WebAssembly heap only grows, and the
// measurement is written down in `tools/check-shadowed-tables.mjs` — 34.5 MB of RSS before the
// import, 94.2 after opening the chain, and 0.1 of that given back by `close()`. So the listing
// comes from a child process (`tools/character-textures.mjs`) that dies with its heap, and what
// stays here is the answer: 36,027 paths, 2,347 KiB of Set.

/** One `\`-spelt, lower-cased path per line, which is what the child writes. */
export function parseCharacterTextures(text: string): Set<string> {
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    const path = line.trim().replaceAll("/", "\\").toLowerCase();
    if (path) paths.add(path);
  }
  return paths;
}

/**
 * What the archives hold under the subtrees a character's textures come from.
 *
 * The union across the whole chain rather than the copy that wins it: the question is "does a
 * request for this path get a picture or a 404", and priority does not enter into it.
 */
export class CharacterTextureIndex {
  readonly #paths: ReadonlySet<string>;
  /**
   * The directories the listing actually reached, so the index can tell "no file of that name"
   * apart from "I was never shown this shelf".
   *
   * An archive answers an enumeration out of its `(listfile)`, and an archive built by hand need
   * not carry one. Without this, a module shipping its component textures inside such an archive
   * would have every one of them declared missing.
   */
  readonly #directories: ReadonlySet<string>;

  private constructor(paths: ReadonlySet<string>, directories: ReadonlySet<string>) {
    this.#paths = paths;
    this.#directories = directories;
  }

  static from(paths: Iterable<string>): CharacterTextureIndex {
    const held = new Set<string>();
    const directories = new Set<string>();
    for (const raw of paths) {
      const path = raw.replaceAll("/", "\\").toLowerCase();
      if (!path) continue;
      held.add(path);
      const cut = path.lastIndexOf("\\");
      if (cut > 0) directories.add(path.slice(0, cut + 1));
    }
    return new CharacterTextureIndex(held, directories);
  }

  /** Whether the chain holds this path, case- and slash-insensitively. */
  has(path: string): boolean {
    return this.#paths.has(path.replaceAll("/", "\\").toLowerCase());
  }

  /**
   * Whether the listing reached the directory this path is in.
   *
   * `has` returning false means "not there" only when this is true; otherwise it means "unknown",
   * and the caller must fall back to offering every spelling rather than dropping the file.
   */
  knows(path: string): boolean {
    const lower = path.replaceAll("/", "\\").toLowerCase();
    const cut = lower.lastIndexOf("\\");
    return cut > 0 && this.#directories.has(lower.slice(0, cut + 1));
  }

  /** How many paths are held. Zero means the listing failed and the index is worthless. */
  get size(): number {
    return this.#paths.size;
  }
}

/**
 * Runs the listing and turns it into an index, or answers undefined when there is none.
 *
 * Undefined and not an empty index on purpose: an empty one would say every file is missing, and
 * every caller reads "missing" as "do not offer this". A machine with no client, or a child that
 * failed, must leave the gateway exactly as it was before this existed.
 */
export async function loadCharacterTextures(
  list: (() => Promise<readonly string[]>) | undefined,
): Promise<CharacterTextureIndex | undefined> {
  if (!list) return undefined;
  try {
    const paths = await list();
    if (paths.length === 0) return undefined;
    return CharacterTextureIndex.from(paths);
  } catch {
    return undefined;
  }
}
