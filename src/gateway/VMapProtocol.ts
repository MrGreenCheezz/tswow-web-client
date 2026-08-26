import { PacketReader } from "../protocol/PacketReader.js";

const MAGIC = "VMAP_4.8";
const HAS_BOUND = 1 << 2;
const IS_M2 = 1;
const WORLD_MID = 0.5 * 64 * 533.33333333;
const decoder = new TextDecoder();

export interface EnvironmentBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface EnvironmentObject {
  id: number;
  kind: "m2" | "wmo";
  name: string;
  x: number;
  y: number;
  z: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scale: number;
  /** Set on a WMO's own doodads — a building's furniture rather than something on the ground. */
  interior?: boolean;
  doodadSet?: number;
  quaternionX?: number;
  quaternionY?: number;
  quaternionZ?: number;
  quaternionW?: number;
  bounds?: EnvironmentBounds;
}

export function parseVMapTile(payload: Uint8Array): EnvironmentObject[] {
  const reader = new PacketReader(payload);
  if (decoder.decode(reader.bytes(8)) !== MAGIC) throw new Error("Unsupported VMAP tile");
  const count = reader.u32();
  if (count > 10_000) throw new RangeError(`VMAP tile contains too many objects: ${count}`);

  const objects: EnvironmentObject[] = [];
  for (let index = 0; index < count; index++) {
    const flags = reader.u32();
    reader.u16();
    const id = reader.u32();
    const internalX = reader.f32();
    const internalY = reader.f32();
    const z = reader.f32();
    const rotationX = reader.f32();
    const rotationY = reader.f32();
    const rotationZ = reader.f32();
    const scale = reader.f32();
    let bounds: EnvironmentBounds | undefined;
    if (flags & HAS_BOUND) {
      const lowX = reader.f32();
      const lowY = reader.f32();
      const minZ = reader.f32();
      const highX = reader.f32();
      const highY = reader.f32();
      const maxZ = reader.f32();
      bounds = {
        minX: WORLD_MID - highX,
        minY: WORLD_MID - highY,
        minZ,
        maxX: WORLD_MID - lowX,
        maxY: WORLD_MID - lowY,
        maxZ,
      };
    }
    const nameLength = reader.u32();
    if (nameLength > 500) throw new RangeError(`VMAP model name is too long: ${nameLength}`);
    // The stored length counts the terminator on 1,005 of the 3,482 names in this dataset, so
    // decoding it whole left a NUL on the end of every one of those. Nothing downstream survives
    // that: it is not in any path character class, so the model route answered 400 and the
    // fallback route did not match its own regex and answered 404.
    const name = decoder.decode(reader.bytes(nameLength)).replace(/\0+$/, "");
    reader.u32();
    objects.push({
      id,
      kind: flags & IS_M2 ? "m2" : "wmo",
      name,
      x: WORLD_MID - internalX,
      y: WORLD_MID - internalY,
      z,
      rotationX,
      rotationY,
      rotationZ,
      scale,
      ...(bounds ? { bounds } : {}),
    });
  }
  reader.assertFinished();
  return objects;
}
