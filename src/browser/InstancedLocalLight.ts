// 06.10-doodad-light — owner, 06.10, the Goldshire inn: warm walls, blue/teal furniture,
// «мебель любит менять цвет».
//
// The instanced bucket of room-lit WMO doodads keeps each copy's MODD light in a normalized
// `Uint8Array` attribute. three's `BufferAttribute.setXYZ` on a normalized attribute expects 0…1
// and multiplies by 255 before storing, so handing it the file's 0…255 bytes stored `v * 255`
// truncated to a byte — `256 - v` for every non-zero channel. The inn's dark-brown MODD light
// 106,76,51 arrived in the shader as 150,180,205: blue. A model with one copy in range is drawn
// plain (uniform path, correct), two or more go instanced (`INSTANCE_MINIMUM = 2`), so the same
// barrel changed colour as the camera brought a second barrel into range.
import type * as THREE from "three";
import type { ModelPlacementTint } from "./ModelPlacementTint.js";

/** Writes one copy's display-order RGB light bytes into the instanced local-light attribute as bytes. */
export function writeInstancedLocalLight(
  attribute: THREE.BufferAttribute,
  index: number,
  light: ModelPlacementTint,
): void {
  const array = attribute.array;
  const at = index * 3;
  array[at] = light[0];
  array[at + 1] = light[1];
  array[at + 2] = light[2];
}
