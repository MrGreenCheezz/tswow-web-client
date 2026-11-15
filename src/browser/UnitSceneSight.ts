/**
 * 5.16 / 6.37 (15.11): which units the camera saw this frame, as Wow.exe 3.3.5a 12340 keeps it for Tab and the name
 * plates. Read from the client (`.runtime/re-2026-11-15/go8/c.c`, `d.c`; `.runtime/re-2026-11-15/combat5/d3.c`;
 * `.runtime/re-2026-10-01/a9-combat/e3.c`), Ghidra read-only:
 *
 * - Every unit's map entity (CMapEntity, object+0xB8) has a byte at +0x25. The base constructor 0x007A0B50 and
 *   0x00792E60 set it to 2. The per-frame entity passes 0x00793060, 0x007987A0, 0x00799980 set it to 1, then to 0 when
 *   the entity's sphere passes: the six planes of the view frustum (0x00983D20: out when a plane's distance to the
 *   centre is below minus the radius; no slack), the map occluders' shadow volumes (0x007CCE00: wholly inside one
 *   volume is hidden) and the terrain horizon (0x0078FC40: 2 is hidden). 0x00793270 and 0x00799B70 do the same for the
 *   entities linked to WMO groups, against the frusta of the portals the walk reached that group through (0x00983FB0).
 * - The sphere (0x007B5740): the centre +0x38 is the entity's position, the unit's feet; the radius +0x44 is the length
 *   of the model box's diagonal, max − min (not half of it).
 * - 0x0077F0B0 answers "+0x25 == 0". Tab's candidate net 0x00524440 takes a unit only when it says yes (after the 41/10
 *   yards and the creature type, before the stealth test); the name plate's eligibility 0x0072B060 asks it twice, and
 *   the unit update 0x00734390 drops a shown plate (0x00725840) once it says no. So both take only units the camera
 *   currently sees — not units in line of sight: a unit behind a wall but inside the view, with no occluder in front,
 *   is seen.
 *
 * This client: the renderer runs the frustum and occluder half of that per frame over the units it holds in range
 * (`UnitSightPass.publish`, called from the unit pass) and publishes the guids that passed in `RenderResults.unitsSeen`,
 * which crosses from the render worker with the rest of the record. Not repeated here: the terrain horizon (the
 * renderer does not run `TerrainHorizon.ts` yet) and the portal frusta of units inside a WMO (this client does not link
 * units to WMO groups): such a unit counts as seen while it is in the view. A unit whose model box is not known yet is
 * tested as a point at its feet. The occluder volumes are the map's own (`MapOccluders.ts`), applied only with the
 * camera over no WMO, as `0x795d40` leaves them unclipped then; this client builds none from a room.
 */

import { mapOccludersForModel, mapOccludersHideSphere, createMapOccluderFrame, type MapOccluderRecord } from "./MapOccluders.js";

/** A frustum plane as three.js keeps it: inside where normal · p + constant >= 0, normal unit length. */
export interface UnitSightPlane {
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly constant: number;
}

/** A model's box as the renderer holds it (WVM header, any axis order: only the diagonal is read). */
export interface UnitSightModel {
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
}

/** What a held unit offers: its body's model and scale, and the mount standing under it. */
export interface UnitSightBody {
  readonly wvm: UnitSightModel | undefined;
  readonly scale: number;
  readonly mount?: { readonly wvm: UnitSightModel | undefined; readonly scale: number } | undefined;
}

/** The camera as the occluder volumes need it (this client's world: x, z, −y of WoW's). */
export interface UnitSightCamera {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly projectionMatrix: { readonly elements: ArrayLike<number> };
  readonly matrixWorldInverse: { readonly elements: ArrayLike<number> };
}

/**
 * 0x007B5740's radius: the diagonal of the model box. Mounted, the unit's model is the mount's (the rider hangs on it),
 * so the mount's box. Undefined while no box is known.
 */
export function unitSightRadius(body: UnitSightBody | undefined): number | undefined {
  if (body === undefined) return undefined;
  const model = body.mount?.wvm !== undefined ? body.mount.wvm : body.wvm;
  const scale = body.mount?.wvm !== undefined ? body.mount.scale : body.scale;
  if (model === undefined) return undefined;
  const { min, max } = model.bounds;
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  // Not Math.hypot: with three arguments it allocates, and this runs per unit per frame.
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * scale;
  return Number.isFinite(radius) && radius >= 0 ? radius : undefined;
}

/** 0x00983D20: a sphere is out when its centre lies farther than its radius behind any of the planes. */
export function unitSphereInView(x: number, y: number, z: number, radius: number, planes: readonly UnitSightPlane[]): boolean {
  for (let index = 0; index < planes.length; index++) {
    const plane = planes[index]!;
    const normal = plane.normal;
    if (normal.x * x + normal.y * y + normal.z * z + plane.constant < -radius) return false;
  }
  return true;
}

/** Column-major identity: the occluder volumes stay in this client's world. */
const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The per-frame pass and its published set. The set is kept and edited in place: a still scene allocates nothing. */
export class UnitSightPass {
  readonly #stamps = new Map<bigint, number>();
  readonly #occluders = createMapOccluderFrame();
  #frame = 0;
  /** Units tested, and spheres tested against the occluders, in the last pass (tests and diagnostics). */
  tested = 0;
  occluderTests = 0;

  /**
   * Tests every unit of `candidates` (players and creatures in the renderer's range; the rest skipped) and leaves in
   * `seen` exactly those that passed. `occluderRecords` are the camera map's occluders when they apply this frame.
   */
  publish(
    seen: Set<bigint>,
    candidates: readonly { readonly value: { readonly guid: bigint; readonly typeId: number | undefined;
      readonly position?: { readonly x: number; readonly y: number; readonly z: number } | undefined } }[],
    bodies: ReadonlyMap<bigint, UnitSightBody>,
    planes: readonly UnitSightPlane[],
    camera: UnitSightCamera | undefined,
    occluderRecords: readonly MapOccluderRecord[] | undefined,
  ): void {
    const frame = ++this.#frame;
    const stamps = this.#stamps;
    const volumes = camera !== undefined && occluderRecords !== undefined && occluderRecords.length > 0
      ? mapOccludersForModel(this.#occluders, occluderRecords, camera.position, camera.projectionMatrix.elements,
        camera.matrixWorldInverse.elements, IDENTITY)
      : undefined;
    let passed = 0;
    let tested = 0;
    let occluderTests = 0;
    for (let index = 0; index < candidates.length; index++) {
      const object = candidates[index]!.value;
      if (object.typeId !== 3 && object.typeId !== 4) continue;
      const position = object.position;
      if (position === undefined) continue;
      tested++;
      const radius = unitSightRadius(bodies.get(object.guid)) ?? 0;
      // This client's world: WoW's x, z, −y.
      const x = position.x;
      const y = position.z;
      const z = -position.y;
      if (!unitSphereInView(x, y, z, radius, planes)) continue;
      if (volumes !== undefined) {
        occluderTests++;
        if (mapOccludersHideSphere(volumes, x, y, z, radius)) continue;
      }
      // Neither allocates for a guid already held: a still crowd edits nothing.
      seen.add(object.guid);
      stamps.set(object.guid, frame);
      passed++;
    }
    if (seen.size !== passed) {
      for (const guid of seen) {
        if (stamps.get(guid) !== frame) {
          seen.delete(guid);
          stamps.delete(guid);
        }
      }
    }
    this.tested = tested;
    this.occluderTests = occluderTests;
  }
}

/** The page's question (0x0077F0B0): did the camera see this unit in the last drawn frame? */
export function unitSeenByCamera(seen: ReadonlySet<bigint> | undefined, guid: bigint): boolean {
  // No renderer record (tests, a page without a world view): nothing to cull by.
  return seen === undefined || seen.has(guid);
}
