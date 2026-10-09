// The convex volume of WMO roots (their MCVP chunk), for the gateway's `/vmap/gobject-volumes`.
//
// 05.10-11.01: Wow.exe lets a falling passenger off a ship or a zeppelin only once its offset is
// outside the transport model's convex volume (0x007618b0 → 0x006ec7b0 refuses while 0x0077ffb0
// answers «inside»; for a WMO that is 0x007aea10: outside as soon as one plane a·x + b·y + c·z + d is
// positive). The planes are the root's MCVP chunk, which the root loader (0x007d7470) takes only as
// the chunk right behind MFOG, at 16 bytes a plane (size >> 4). Neither the vmaps nor any other
// route carries it, so it is read here, out of the same archive chain the game reads.
//
// A child process for the reason `character-textures.mjs` gives: StormLib's heap only grows, and
// the gateway would carry it for its whole life. The answer goes to **stderr** — StormLib prints on
// stdout — as one JSON object `{ "<path as asked>": [a, b, c, d, …] | null }`, null for a root the
// chain does not hold or that is not a root. Exit 0 means stderr is the answer.
//
//   node tools/convex-volumes.mjs <wmo path> [<wmo path> …]
//
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openClientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

export const WMO_CONVEX_VOLUME_EXTENSION = ".wmo";

function tagAt(view, offset) {
  // Tags are stored reversed ("REVM" for MVER).
  return String.fromCharCode(view.getUint8(offset + 3), view.getUint8(offset + 2), view.getUint8(offset + 1), view.getUint8(offset));
}

/**
 * The MCVP planes of a WMO root, flat (a, b, c, d per plane): `[]` when the root has none where
 * 0x007d7470 looks for it, null when the bytes are not a root (no MVER + MOHD). A plane with a
 * non-finite value is dropped: 0x007aea10 compares `0 < dot`, which a NaN never passes.
 */
export function wmoConvexVolume(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = [];
  let offset = 0;
  let previous;
  while (offset + 8 <= bytes.byteLength) {
    const tag = tagAt(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) break;
    tags.push(tag);
    if (tags.length === 2 && (tags[0] !== "MVER" || tag !== "MOHD")) return null;
    if (tag === "MCVP") {
      if (previous !== "MFOG") return [];
      const planes = [];
      const count = size >>> 4;
      for (let index = 0; index < count; index++) {
        const at = body + index * 16;
        const plane = [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true), view.getFloat32(at + 12, true)];
        if (plane.every(Number.isFinite)) planes.push(...plane);
      }
      return planes;
    }
    previous = tag;
    offset = body + size;
  }
  return tags.length >= 2 ? [] : null;
}

/** A path the child accepts: a `.wmo` in the archives, nothing that climbs out of them. */
export function validConvexVolumePath(path) {
  return typeof path === "string" && path.length > 4 && path.length < 260
    && path.toLowerCase().endsWith(WMO_CONVEX_VOLUME_EXTENSION) && !/(^|[\\/])\.\.([\\/]|$)/.test(path) && !/[:\0]/.test(path);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const paths = process.argv.slice(2);
    for (const path of paths) if (!validConvexVolumePath(path)) throw new Error(`not a WMO path: ${path}`);
    const chain = await openClientArchives(clientDirectory());
    try {
      const answer = {};
      for (const path of paths) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        answer[path] = data ? wmoConvexVolume(data) : null;
      }
      process.stderr.write(JSON.stringify(answer));
    } finally {
      chain.close();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
