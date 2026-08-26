// Which of the character pipeline's texture files the client archives actually hold.
//
// Two subtrees, and the gateway has a question about each of them that only the archives can
// answer. `Item\TextureComponents\` is where an item's eight component textures live, spelt
// `<name>_M.blp`, `<name>_F.blp` or `<name>_U.blp` depending on whether the artist drew one
// picture or two — and `ItemDisplayInfo` names the stem alone, so until now the gateway offered
// the gendered spelling first and `_U` as a fallback and was wrong 76.1% of the time (13,648 of
// the 17,937 layers a real outfit paints). `Textures\BakedNpcTextures\` is where a creature's
// pre-baked body lives, and a bake replaces every other layer of the atlas, so a display naming
// one the archives do not have used to compose to nothing at all.
//
// A script rather than a few lines inside the gateway, for the reason `check-shadowed-tables.mjs`
// states at length: reading an archive means StormLib's WebAssembly build, whose heap only grows,
// and the gateway would carry ~62 MB of it for the life of the process. Here it dies with the
// child. Measured on this machine: 762 ms from the gateway's spawn to this process's exit, 215 ms
// of it opening the chain and 424 ms enumerating; 20,361 component paths and 15,666 bakes,
// 2,507,555 bytes of answer.
//
// The answer goes to **stderr**, not stdout, for the same reason and by the same rule as its
// sibling: StormLib prints "Initialized StormLib in debug mode" and a line per heap resize on
// stdout, so stdout cannot carry a payload. Exit 0 means stderr is the answer; a non-zero exit
// means stderr is the reason it is not.
//
//   node tools/character-textures.mjs [<client directory>]
//
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openClientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

/**
 * The subtrees the character pipeline resolves a name against.
 *
 * Deliberately not the whole archive: enumerating everything is 244,000 paths and 15 MB of pipe
 * for two questions about 37,000 of them.
 */
export const CHARACTER_TEXTURE_PREFIXES = [
  "Item\\TextureComponents\\",
  "Textures\\BakedNpcTextures\\",
];

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const directory = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? clientDirectory();
    const chain = await openClientArchives(directory);
    try {
      const lines = [];
      for (const prefix of CHARACTER_TEXTURE_PREFIXES) {
        for (const path of await chain.list(prefix)) lines.push(path);
      }
      // One write, not one per path: 37,000 separate writes to a pipe is the whole cost of the run.
      process.stderr.write(`${lines.join("\n")}\n`);
    } finally {
      chain.close();
    }
  } catch (error) {
    // The reason only, with no stack: the gateway prints it behind a sentence of its own, and
    // StormLib's rethrow would otherwise put a WebAssembly stack trace in a log about a missing
    // directory.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
