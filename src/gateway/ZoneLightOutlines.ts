// 15.11 (light7): the Northrend zone lights, which Light.dbc alone does not describe.
//
// In Northrend the lights of Borean Tundra, Dragonblight, Storm Peaks, Icecrown and seven more zones are Light.dbc rows
// with radii of 5 to 23 yards. Wow.exe 12340 does not reach them by their radius: it keeps eleven zone outlines of its
// own and gives each outline's light to everything inside it. The outlines are not in any client data file; they are
// strings in Wow.exe itself, so this reads them from the user's own Wow.exe and sends them with the map's light.
//
// What Wow.exe does (addresses in Wow.exe 12340):
//  - 0x009cdbc0 (a static initializer) fills a table of eleven 48-byte records at 0x00adef58:
//      +0x00 map id (571 on all eleven), +0x04 -1, +0x08 the Light.dbc row id, +0x0c the parsed points, +0x10 their
//      count, +0x14 / +0x18 an offset (the floats at 0x00a3e8ac and 0x00a3e8a8), +0x1c the outline as an SVG path
//      ("L x,y L x,y ... z"; the pointers at 0x00adee48..0x00adee70), +0x20..+0x2c its bounds.
//  - 0x0077ed40 parses each path: every 'M' or 'L' starts a point, x from two characters on to the ',', y from after
//    the ',' to the next ' ' (atof); then x' = (x + offX) * 33.333 (0x00a3e554) and y' = (y + offY) / 1024 * 34133.33
//    (0x00a1c8a0, 0x009e2ac8). The bounds are widened by 50 yards (0x009f22ec).
//  - 0x0077eed0 asks with the point (17066.67 - y, 17066.67 - x) (0x009e2acc), so x' runs along -y of the world and y'
//    along -x. The browser takes it from there (`src/browser/ZoneLightOutlines.ts`).
//
// Nothing is guessed when the file is not this build: a missing file, another image base, a table entry that is not
// a map/light pair or a string that is not such a path leaves the outlines out, and the map's light is what
// Light.dbc alone gives, as before.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One zone outline in world coordinates (yards): `points` is x0, y0, x1, y1, … in Wow.exe's order. */
export interface ZoneLightOutline {
  map: number;
  /** The `Light.dbc` row whose slots light the zone. */
  lightId: number;
  points: number[];
}

const IMAGE_BASE = 0x00400000;
const TABLE = 0x00adef58;
const TABLE_STRIDE = 48;
const STRINGS = 0x00adee48;
const COUNT = 11;
const OFFSET_X = 0x00a3e8ac;
const OFFSET_Y = 0x00a3e8a8;
const SCALE_X = 0x00a3e554;
const SCALE_Y = 0x00a1c8a0;
const SCALE_Y_YARDS = 0x009e2ac8;
const ZERO_POINT = 0x009e2acc;
/** A path longer than this is not one of these outlines (the longest is about 1.3 KB). */
const MAX_PATH_BYTES = 64 * 1024;

interface Section {
  virtualAddress: number;
  size: number;
  rawOffset: number;
  rawSize: number;
}

/** The outlines in a Wow.exe image, or undefined when the image is not build 12340's layout. */
export function parseZoneLightOutlines(exe: Uint8Array): ZoneLightOutline[] | undefined {
  const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const u16 = (offset: number) => (offset + 2 <= exe.length ? view.getUint16(offset, true) : -1);
  const u32 = (offset: number) => (offset + 4 <= exe.length ? view.getUint32(offset, true) : -1);
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
  const fileOffset = (va: number): number | undefined => {
    const rva = va - IMAGE_BASE;
    for (const section of sections) {
      const inside = rva - section.virtualAddress;
      if (inside >= 0 && inside < Math.min(section.size || section.rawSize, section.rawSize)) return section.rawOffset + inside;
    }
    return undefined;
  };
  const word = (va: number): number | undefined => {
    const offset = fileOffset(va);
    return offset === undefined || offset + 4 > exe.length ? undefined : view.getUint32(offset, true);
  };
  const float = (va: number): number | undefined => {
    const offset = fileOffset(va);
    return offset === undefined || offset + 4 > exe.length ? undefined : view.getFloat32(offset, true);
  };
  const offsetX = float(OFFSET_X);
  const offsetY = float(OFFSET_Y);
  const scaleX = float(SCALE_X);
  const scaleYa = float(SCALE_Y);
  const scaleYb = float(SCALE_Y_YARDS);
  const zeroPoint = float(ZERO_POINT);
  if ([offsetX, offsetY, scaleX, scaleYa, scaleYb, zeroPoint].some((value) => value === undefined || !Number.isFinite(value))) {
    return undefined;
  }
  // The grid's centre is 32 tiles of 533.33 yards; anything else is another build.
  if (Math.abs(zeroPoint! - 17066.666) > 0.01) return undefined;
  const scaleY = scaleYa! * scaleYb!;
  const outlines: ZoneLightOutline[] = [];
  for (let index = 0; index < COUNT; index++) {
    const map = word(TABLE + index * TABLE_STRIDE);
    const lightId = word(TABLE + index * TABLE_STRIDE + 8);
    const pointer = word(STRINGS + index * 4);
    if (map === undefined || lightId === undefined || pointer === undefined) return undefined;
    if (map <= 0 || map > 10000 || lightId <= 0 || lightId > 100000) return undefined;
    const start = fileOffset(pointer);
    if (start === undefined) return undefined;
    let end = start;
    while (end < exe.length && end - start < MAX_PATH_BYTES && exe[end] !== 0) end++;
    const path = new TextDecoder("latin1").decode(exe.subarray(start, end));
    const parsed = parseOutlinePath(path);
    if (!parsed || parsed.length < 6) return undefined;
    const points: number[] = [];
    for (let at = 0; at < parsed.length; at += 2) {
      // 0x0077ed40's x' and y', then back from 0x0077eed0's (zp - y, zp - x) to the world's (x, y).
      const along = (parsed[at]! + offsetX!) * scaleX!;
      const across = (parsed[at + 1]! + offsetY!) * scaleY;
      points.push(zeroPoint! - across, zeroPoint! - along);
    }
    outlines.push({ map, lightId, points });
  }
  return outlines;
}

/**
 * One outline path as Wow.exe 0x0077ed40 reads it: x0, y0, x1, y1, … in the path's own units, or undefined when the
 * text is not a path of "M"/"L" points ending in 'z'.
 */
export function parseOutlinePath(path: string): number[] | undefined {
  const end = path.indexOf("z");
  if (end < 0) return undefined;
  const values: number[] = [];
  for (let at = 0; at < end; at++) {
    const letter = path[at];
    if (letter !== "M" && letter !== "L") continue;
    const comma = path.indexOf(",", at);
    if (comma < 0 || comma > end) return undefined;
    let space = path.indexOf(" ", comma + 1);
    if (space < 0 || space > end) space = end;
    const x = Number.parseFloat(path.slice(at + 2, comma));
    const y = Number.parseFloat(path.slice(comma + 1, space));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    values.push(x, y);
    at = space - 1;
  }
  return values;
}

/** The outlines of `<clientDirectory>/Wow.exe`, or undefined when there is no such file or it is another build. */
export async function readZoneLightOutlines(clientDirectory: string): Promise<ZoneLightOutline[] | undefined> {
  let exe: Uint8Array;
  try {
    exe = await readFile(join(clientDirectory, "Wow.exe"));
  } catch {
    return undefined;
  }
  return parseZoneLightOutlines(exe);
}
