// Publishes a whole world-map picture at once, rather than one tile per process.
//
// A zone map is twelve 256×256 tiles, and the exploration overlays painted over it are one to four
// tiles each — about forty pictures for one zone. Asked for through `/texture` that is forty node
// processes each opening twenty-two archive sources, which is minutes for the first look at a map.
// Here the chain is opened once and every tile of the requested picture is published together, so
// the first miss fills the cache and the other thirty-nine are hits.
//
// The naming rule is measured rather than assumed. Every one of the 107 `WorldMapArea.AreaName`
// values in this dataset resolves, 89 as `Interface\WorldMap\<Name>\<Name><1..12>.blp` and the 18
// WotLK multi-floor dungeons as `<Name><floor>_<1..12>.blp`. Overlays do **not** live in a
// directory of their own: they sit in the parent zone's, as `<Zone>\<TextureName><i>.blp`. Both
// shapes are the same to this tool, because it works from the path it is handed: strip the
// trailing number off the file name and publish that stem's whole run.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { publishTexture, SOURCE_MISSING_EXIT, SourceMissing } from "./generate-texture.mjs";

/** `…\Elwynn\Elwynn3.blp` -> `…\Elwynn\Elwynn`, and `…\STORMWIND2.blp` -> `…\STORMWIND`. */
export function textureStem(mpqPath) {
  const match = /^(.*?)(\d+)\.blp$/i.exec(mpqPath.replaceAll("/", "\\"));
  return match ? match[1] : undefined;
}

/**
 * Publishes `<stem>1.blp` upward until the archives stop having them.
 *
 * The run length is probed rather than computed: `WorldMapOverlay` declares a width and a height
 * that would say how many tiles there should be, and two of the 886 rows in this dataset ship more
 * art than they declare. What is in the archive wins.
 */
export async function publishTextureRun(stem, archives, limit = 16) {
  let published = 0;
  let found = 0;
  for (let index = 1; index <= limit; index++) {
    const path = `${stem}${index}.blp`;
    // The tiles are numbered from one with no holes, so the first gap is the end of the run.
    if (!await archives.has(path)) break;
    found++;
    const result = await publishTexture(path, archives);
    if (!result.cached) published++;
  }
  return { found, published };
}

// Run directly: node tools/generate-worldmap-art.mjs "Interface\WorldMap\Elwynn\Elwynn3.blp"
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const requested = process.argv[2];
  if (!requested) throw new Error("Usage: node tools/generate-worldmap-art.mjs <mpq-path>");
  const stem = textureStem(requested);
  const archives = await clientArchives(clientDirectory());
  try {
    // A path with no trailing number is not part of a run; publish just it, so this tool can stand
    // in for `generate-texture.mjs` on every `Interface\WorldMap\` path without a special case.
    if (!stem) {
      await publishTexture(requested.replaceAll("/", "\\"), archives);
      console.log(`Published ${requested}`);
    } else {
      const result = await publishTextureRun(stem, archives);
      if (result.found === 0) throw new SourceMissing(`${requested} is not in the client`);
      console.log(`Published ${result.published} of ${result.found} tiles for ${stem}*.blp`);
    }
  } catch (error) {
    // `/texture` sends every `Interface\WorldMap\` path here rather than to the plain generator, so
    // this tool has to speak the same one word back: a run with no tiles at all is a missing
    // source, and the browser may stop asking for it. Anything else is this minute's problem.
    if (!(error instanceof SourceMissing)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
}

