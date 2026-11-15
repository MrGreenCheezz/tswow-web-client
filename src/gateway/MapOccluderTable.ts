// 15.11 (7.54, portal8): Wow.exe's map occluders, read from the user's own Wow.exe.
//
// Wow.exe 12340 keeps hand-placed occluder polygons in its own data, not in any client data file: a table of 62
// records of 40 bytes at 0x00af0040 (read by 0x7ccd20, 0x7cd850, 0x7cd930):
//   +0x00 map id, +0x04 flags (bit 0: never clipped at the doors' depth; bit 1: also used by 0x7bd200),
//   +0x08..+0x1f a box 0x7ccd20 grows over the points at run time, +0x20 a pointer to the points (x, y, z floats),
//   +0x24 their count.
// The browser builds the shadow volumes from them (`src/browser/MapOccluders.ts`). This file only reads the table and
// serves one map's records; nothing of it is stored in the project.
//
// Nothing is guessed when the file is not this build: a missing file, another image base, a grid centre that is not
// 17066.67 (0x009e2acc), or any record that is not a map id, small flags and a polygon of finite points in the image
// leaves the occluders out, and the walk draws as it did without them.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One occluder polygon: `points` is x0, y0, z0, x1, … in WoW's world coordinates (yards). */
export interface MapOccluderRecordJson {
  flags: number;
  points: number[];
}

const IMAGE_BASE = 0x00400000;
const TABLE = 0x00af0040;
const STRIDE = 40;
const COUNT = 62;
const ZERO_POINT = 0x009e2acc;
/** A polygon with more points than this is not one of these (the largest has 8). */
const MAX_POINTS = 64;
/** Past any world coordinate: the world is within 32 tiles of 533.33 yards of its centre, with room for tall walls. */
const MAX_COORDINATE = 20_000;

interface Section {
  virtualAddress: number;
  size: number;
  rawOffset: number;
  rawSize: number;
}

/** Every record of the table by map, or undefined when the image is not build 12340's layout. */
export function parseMapOccluders(exe: Uint8Array): Map<number, MapOccluderRecordJson[]> | undefined {
  const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const u16 = (offset: number) => (offset >= 0 && offset + 2 <= exe.length ? view.getUint16(offset, true) : -1);
  const u32 = (offset: number) => (offset >= 0 && offset + 4 <= exe.length ? view.getUint32(offset, true) : -1);
  if (u16(0) !== 0x5a4d) return undefined;
  const pe = u32(0x3c);
  if (pe < 0 || u32(pe) !== 0x00004550) return undefined;
  const sectionCount = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  if (u32(pe + 24 + 28) !== IMAGE_BASE) return undefined;
  const sections: Section[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = pe + 24 + optionalSize + index * 40;
    sections.push({ virtualAddress: u32(at + 12), size: u32(at + 8), rawOffset: u32(at + 20), rawSize: u32(at + 16) });
  }
  const fileOffset = (va: number, bytes: number): number | undefined => {
    const rva = va - IMAGE_BASE;
    for (const section of sections) {
      const inside = rva - section.virtualAddress;
      if (inside >= 0 && inside + bytes <= Math.min(section.size || section.rawSize, section.rawSize)) {
        const offset = section.rawOffset + inside;
        return offset + bytes <= exe.length ? offset : undefined;
      }
    }
    return undefined;
  };
  const zero = fileOffset(ZERO_POINT, 4);
  if (zero === undefined || Math.abs(view.getFloat32(zero, true) - 17066.666) > 0.01) return undefined;
  const byMap = new Map<number, MapOccluderRecordJson[]>();
  for (let index = 0; index < COUNT; index++) {
    const record = fileOffset(TABLE + index * STRIDE, STRIDE);
    if (record === undefined) return undefined;
    const map = view.getInt32(record, true);
    const flags = view.getUint32(record + 4, true);
    const pointer = view.getUint32(record + 0x20, true);
    const count = view.getInt32(record + 0x24, true);
    if (map < 0 || map > 10_000 || flags > 3 || count < 3 || count > MAX_POINTS) return undefined;
    const start = fileOffset(pointer, count * 12);
    if (start === undefined) return undefined;
    const points: number[] = [];
    for (let at = 0; at < count * 3; at++) {
      const value = view.getFloat32(start + at * 4, true);
      if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) return undefined;
      points.push(value);
    }
    const list = byMap.get(map) ?? [];
    list.push({ flags, points });
    byMap.set(map, list);
  }
  return byMap;
}

/** The occluders of `<clientDirectory>/Wow.exe` by map, or undefined when there is no such file or it is another build. */
export async function readMapOccluders(clientDirectory: string): Promise<Map<number, MapOccluderRecordJson[]> | undefined> {
  let exe: Uint8Array;
  try {
    exe = await readFile(join(clientDirectory, "Wow.exe"));
  } catch {
    return undefined;
  }
  return parseMapOccluders(exe);
}

/** The route's version: `/dbc/occluders/<map>?v=` (`src/browser/MapOccluderClient.ts` asks this one). */
export const MAP_OCCLUDERS_VERSION = 1;

const READ = new Map<string, Promise<Map<number, MapOccluderRecordJson[]> | undefined>>();

/** One read per client directory for the gateway's life; the answer for `map` (an empty list when it has none). */
export async function mapOccludersOf(clientDirectory: string, map: number): Promise<MapOccluderRecordJson[] | undefined> {
  let read = READ.get(clientDirectory);
  if (!read) READ.set(clientDirectory, read = readMapOccluders(clientDirectory));
  const table = await read;
  return table ? table.get(map) ?? [] : undefined;
}
