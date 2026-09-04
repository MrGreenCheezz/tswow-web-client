import type { WvmCamera, WvmModel } from "./Wvm.js";

/** The small, serialisable camera description consumed by the portrait pass. */
export interface PortraitCameraSpec {
  fov: number;
  near: number;
  far: number;
  position: [number, number, number];
  target: [number, number, number];
}

/** Bounds of the geometry that is actually visible in the built appearance. */
export interface PortraitBounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** The model data needed to resolve a portrait camera without touching WebGL or the DOM. */
export interface PortraitCameraInput {
  camera?: WvmCamera | undefined;
  bounds: WvmModel["bounds"];
  /** Preferred only for the no-authored-camera fallback; header bounds can include hidden data. */
  visibleBounds?: PortraitBounds | undefined;
  attachments?: WvmModel["attachments"] | undefined;
  scale?: number;
}

/** M2 is Z-up; the scene is Y-up. This is the same transform used by model instances. */
export function m2ToScene(point: readonly [number, number, number], scale = 1): [number, number, number] {
  return [point[0] * scale, point[2] * scale, -point[1] * scale];
}

/**
 * Resolves the WVM9 type-0 camera, or a stable camera for old/malformed models.
 *
 * Keeping this as a pure function is intentional: the values can be golden-tested from the WVM9
 * fixture without constructing a renderer. The fallback frames visible built geometry (and, when
 * present, uses the helm/shoulder attachment pair to aim at the face); the WVM header bounds are
 * only the last resort.
 */
export function portraitCameraSpec(input: PortraitCameraInput): PortraitCameraSpec {
  const scale = Number.isFinite(input.scale) && (input.scale ?? 0) > 0 ? input.scale! : 1;
  if (input.camera) {
    const camera = input.camera;
    return {
      fov: camera.fov * 180 / Math.PI,
      near: Math.max(0.001, camera.near * scale),
      far: Math.max(camera.near * scale + 0.01, camera.far * scale),
      position: m2ToScene(camera.position, scale),
      target: m2ToScene(camera.target, scale),
    };
  }

  const { min, max } = input.visibleBounds ?? input.bounds;
  const height = Math.max(0.4, max[2] - min[2]);
  const centreX = (min[0] + max[0]) / 2;
  const centreY = (min[1] + max[1]) / 2;
  let targetZ = min[2] + height * 0.58;
  const attachments = input.attachments ?? [];
  const facePoints = attachments.filter((attachment) => attachment.id === 5 || attachment.id === 11);
  if (facePoints.length >= 2) targetZ = facePoints.reduce((sum, point) => sum + point.position[2], 0) / facePoints.length;
  const radius = Math.max(0.35, Math.hypot(max[0] - min[0], max[1] - min[1], height) / 2);
  const distance = Math.max(1.2, radius * 3.2);
  const rawPosition: [number, number, number] = [centreX + distance, centreY, targetZ];
  const rawTarget: [number, number, number] = [centreX, centreY, targetZ];
  return {
    fov: 35,
    near: Math.max(0.01, distance * 0.02 * scale),
    far: Math.max(20, distance * 8 * scale),
    position: m2ToScene(rawPosition, scale),
    target: m2ToScene(rawTarget, scale),
  };
}

/**
 * Resolve a camera for a paperdoll/full-body view.
 *
 * Character model frames do not use the authored bust camera from a creature WVM.  Keeping this
 * as a separate entry point makes that contract explicit and lets the full-body slot continue to
 * use the same bounds/attachment fallback without duplicating camera math.
 */
export function fullBodyCameraSpec(
  input: Omit<PortraitCameraInput, "camera">,
): PortraitCameraSpec {
  // Face attachments are a bust-camera hint. A paperdoll should center the visible mesh bounds,
  // so deliberately leave that hint out while retaining the same deterministic distance math.
  const base = portraitCameraSpec({ ...input, camera: undefined, attachments: undefined });
  const { min, max } = input.visibleBounds ?? input.bounds;
  const scale = Number.isFinite(input.scale) && (input.scale ?? 0) > 0 ? input.scale! : 1;
  const centre = m2ToScene([
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ], scale);

  // portraitCameraSpec positions along +X and keeps the target's Y/Z fixed. Moving both
  // endpoints to the exact bounds centre therefore preserves the computed distance while
  // making the visible top and bottom enter symmetrically in the full-body frame.
  return {
    ...base,
    position: [base.position[0], centre[1], base.position[2]],
    target: centre,
  };
}
