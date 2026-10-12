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

/**
 * Every way a numbered file name splits into a stem and a tile number (1–99, no leading zero),
 * shortest number first: `…\Elwynn\Elwynn3.blp` -> `…\Elwynn\Elwynn`; `…\Elwynn\Elwynn11.blp` ->
 * `…\Elwynn\Elwynn1` or `…\Elwynn\Elwynn`.
 *
 * 3.54: the name alone does not say where the stem ends when the stem itself ends in digits, and
 * taking every trailing digit as the number — the former rule — sent Outland's continent map
 * (`Expansion01\Expansion011.blp` … `Expansion0112.blp`, stem `Expansion01`) to a run of
 * `Expansion1.blp…` that does not exist: all twelve tiles answered 404 and the browser never asked
 * again, so the Outland map stayed blank. Netherstorm's `Area52` overlay (`Area521.blp`) the same.
 * `bestTextureStem` decides between the splits by what the archives hold.
 */
export function textureStems(mpqPath) {
  const match = /^(.*?)(\d+)\.blp$/i.exec(mpqPath.replaceAll("/", "\\"));
  if (!match) return [];
  const [, head, digits] = match;
  const stems = [];
  for (let length = 1; length <= Math.min(2, digits.length); length++) {
    if (digits[digits.length - length] === "0") continue;
    stems.push(head + digits.slice(0, digits.length - length));
  }
  return stems;
}

/** How many tiles `<stem>1.blp`, `<stem>2.blp`… the archives hold, from one with no holes. */
async function runLength(stem, archives, limit) {
  let length = 0;
  while (length < limit && await archives.has(`${stem}${length + 1}.blp`)) length++;
  return length;
}

/**
 * The stem whose run holds the requested tile, the longest such run winning: `Elwynn11.blp` is
 * tile 11 of `Elwynn` (twelve tiles) rather than tile 1 of `Elwynn1` (two), and `Expansion011.blp`
 * is tile 1 of `Expansion01` because `Expansion01.blp` — tile 11 of `Expansion0` — is not there.
 */
export async function bestTextureStem(mpqPath, archives, limit = 16) {
  const path = mpqPath.replaceAll("/", "\\");
  let best;
  let bestLength = 0;
  for (const stem of textureStems(path)) {
    const index = Number(path.slice(stem.length, -".blp".length));
    const length = await runLength(stem, archives, limit);
    if (index <= length && length > bestLength) {
      best = stem;
      bestLength = length;
    }
  }
  return best;
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
  const archives = await clientArchives(clientDirectory());
  try {
    const stem = await bestTextureStem(requested, archives);
    // A path no run holds — no trailing number, or not in the client at all — is published alone,
    // so this tool can stand in for `generate-texture.mjs` on every `Interface\WorldMap\` path
    // without a special case; an absent one is the SourceMissing below.
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

