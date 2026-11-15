import type { VehicleEntry } from "../world/VehicleDbc.js";

/**
 * 11.02: the aim arc's data, shared by the page (game/VehicleAimArc.ts, which works it out each frame) and the renderer
 * (VehicleAimArcMesh.ts, VehicleImpactModelMesh.ts, also inside the render worker). Pure: no page state, no renderer state.
 *
 * 15.11 (vehicle8, vehicle9): MsslTrgtImpactModel. 0x006fe9b0 loads, for a Vehicle row with any of the arc Flags 0xf800000,
 * the two models of MsslTrgtImpactModel[0..1] (columns 31, 32); 0x006fda20 stands each at the impact, turned to the mover's
 * facing, scaled so that its bounding radius (0x004f5e80: the M2 header's, +0xb8) becomes MsslTrgtImpactRadius[i] (columns
 * 27, 28; the radius itself for a model with none), with the arc's strength as its alpha.
 */

/** Vehicle Flags that ask for the arc (0x006fda20). */
export const ARC_ALWAYS = 0x0080_0000;
export const ARC_TURN = 0x0100_0000;
export const ARC_PITCH = 0x0200_0000;
export const ARC_MOUSE = 0x0400_0000;
export const ARC_SPELL = 0x0800_0000;
export const ARC_ANY = ARC_ALWAYS | ARC_TURN | ARC_PITCH | ARC_MOUSE | ARC_SPELL;

/** What the renderer draws: the flight's points from the fire point on, world coordinates, and the look of the row. */
export interface VehicleAimArcShape {
  /** x, y, z of each point, the first being the fire point and the last the impact. */
  readonly points: Float32Array;
  readonly facing: number;
  readonly opacity: number;
  readonly width: number;
  readonly endOpacity: number;
  readonly arcSpeed: number;
  readonly arcRepeat: number;
  readonly arcTexture: string;
  readonly impactTexture: string;
  readonly impactRadius: number;
  /** 15.11 (vehicle8): MsslTrgtImpactModel[i] (as .m2) with MsslTrgtImpactRadius[i], at the impact (`vehicleImpactModels`). */
  readonly impactModels?: readonly VehicleImpactModel[];
}

/** 15.11 (vehicle8): one volume mark of the arc (0x006fe9b0, 0x006fda20). */
export interface VehicleImpactModel {
  readonly path: string;
  readonly radius: number;
}

/** 15.11 (vehicle8): the row's impact models in slot order, the empty slots left out (0x006fe9b0 loads a named one only). */
export function vehicleImpactModels(vehicle: Pick<VehicleEntry, "flags" | "msslTrgtImpactModel" | "msslTrgtImpactRadius">): VehicleImpactModel[] {
  if ((vehicle.flags & ARC_ANY) === 0) return [];
  const models: VehicleImpactModel[] = [];
  for (let slot = 0; slot < 2; slot++) {
    const path = vehicle.msslTrgtImpactModel[slot]?.trim() ?? "";
    if (path === "") continue;
    const radius = vehicle.msslTrgtImpactRadius[slot] ?? 0;
    models.push({ path: path.replace(/\.(mdx|mdl)$/i, ".m2"), radius: Number.isFinite(radius) ? radius : 0 });
  }
  return models;
}

/** 15.11 (vehicle8): 0x006fda20's scale: the radius over the model's bounding radius, or the radius for a model without one. */
export function impactModelScale(radius: number, boundsRadius: number): number {
  return boundsRadius > 0 ? radius / boundsRadius : radius;
}
