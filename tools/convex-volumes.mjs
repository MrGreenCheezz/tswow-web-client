// The convex volume of transport models, for the gateway's `/vmap/gobject-volumes`: WMO roots (their
// MCVP chunk) and M2 models (their collision box, as six planes).
//
// 05.10-11.01: Wow.exe lets a falling passenger off a ship or a zeppelin only once its offset is
// outside the transport model's convex volume (0x007618b0 → 0x006ec7b0 refuses while 0x0077ffb0
// answers «inside»; for a WMO that is 0x007aea10: outside as soon as one plane a·x + b·y + c·z + d is
// positive). The planes are the root's MCVP chunk, which the root loader (0x007d7470) takes only as
// the chunk right behind MFOG, at 16 bytes a plane (size >> 4). Neither the vmaps nor any other
// route carries it, so it is read here, out of the same archive chain the game reads.
//
// 11.01: for an M2 (model flag 0x40) 0x0077ffb0 builds six planes itself, from the six floats at
// +0xbc of the loaded model's file data (`*(*(model+0x34)+0x2c)+0x150`) — the M2 header's collision
// box, min then max — with the top raised by 1.6404114 + 1/72 yd (the floats at 0x00a3e6f0 and
// 0x00a3e6ec, subtracted in that order from −max z) and the same «outside when positive» test. An M2
// not loaded is «outside». Pinned against the client's own files (Ghidra notes
// .runtime/re-2026-10-11/glue-1110/t1101-*.txt).
//
// A child process for the reason `character-textures.mjs` gives: StormLib's heap only grows, and
// the gateway would carry it for its whole life. The answer goes to **stderr** — StormLib prints on
// stdout — as one JSON object `{ "<path as asked>": [a, b, c, d, …] | null }`, null for a model the
// chain does not hold or that is not a root (an M2 not of the 3.3.5 layout). Exit 0 means stderr is
// the answer.
//
//   node tools/convex-volumes.mjs <wmo or m2 path> [<path> …]
//
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openClientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

export const WMO_CONVEX_VOLUME_EXTENSION = ".wmo";
/** 11.01: an M2's volume is its collision box (0x0077ffb0, flag 0x40). */
export const M2_CONVEX_VOLUME_EXTENSION = ".m2";
/** The M2 header of the 3.3.5 client (`MD20`, version 264): the collision box is at +0xbc, six floats. */
const M2_VERSION = 264;
const M2_COLLISION_BOX = 0xbc;
/** The f32 with these bits. */
function f32Bits(bits) {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}
/** 0x00a3e6f0 (0x3fd1f908, 1.6404123) then 0x00a3e6ec (0x3c638e39, 1/72), as 0x0077ffb0 subtracts them from −max z. */
export const M2_TOP_MARGIN = [f32Bits(0x3fd1f908), f32Bits(0x3c638e39)];

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

/**
 * 11.01: the six planes 0x0077ffb0 builds for an M2 out of its header's collision box (min x, y, z,
 * max x, y, z at +0xbc): x, y and z beyond the max — the top raised by `M2_TOP_MARGIN` — and below
 * the min, each `a·x + b·y + c·z + d > 0` outside. Null when the bytes are not a 3.3.5 M2 (`MD20`,
 * version 264) or a box value is not finite (0x0077ffb0 would compare against garbage; no row is
 * the older rule).
 */
export function m2ConvexVolume(bytes) {
  if (bytes.byteLength < M2_COLLISION_BOX + 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "MD20" || view.getUint32(4, true) !== M2_VERSION) return null;
  const box = Array.from({ length: 6 }, (_, index) => view.getFloat32(M2_COLLISION_BOX + index * 4, true));
  if (!box.every(Number.isFinite)) return null;
  const [minX, minY, minZ, maxX, maxY, maxZ] = box;
  const top = Math.fround(Math.fround(-maxZ - M2_TOP_MARGIN[0]) - M2_TOP_MARGIN[1]);
  return [
    1, 0, 0, -maxX,
    0, 1, 0, -maxY,
    0, 0, 1, top,
    -1, 0, 0, minX,
    0, -1, 0, minY,
    0, 0, -1, minZ,
  ];
}

/** The volume of a model by its extension (`.wmo` root or `.m2`). */
export function convexVolume(path, bytes) {
  return path.toLowerCase().endsWith(M2_CONVEX_VOLUME_EXTENSION) ? m2ConvexVolume(bytes) : wmoConvexVolume(bytes);
}

/** A path the child accepts: a `.wmo` or an `.m2` in the archives, nothing that climbs out of them. */
export function validConvexVolumePath(path) {
  if (typeof path !== "string" || path.length <= 4 || path.length >= 260) return false;
  const lower = path.toLowerCase();
  return (lower.endsWith(WMO_CONVEX_VOLUME_EXTENSION) || lower.endsWith(M2_CONVEX_VOLUME_EXTENSION))
    && !/(^|[\\/])\.\.([\\/]|$)/.test(path) && !/[:\0]/.test(path);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const paths = process.argv.slice(2);
    for (const path of paths) if (!validConvexVolumePath(path)) throw new Error(`not a WMO or M2 path: ${path}`);
    const chain = await openClientArchives(clientDirectory());
    try {
      const answer = {};
      for (const path of paths) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        answer[path] = data ? convexVolume(path, data) : null;
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
