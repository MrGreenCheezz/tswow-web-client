import type * as THREE from "three";
import type { ModelBox } from "../world/GameObjectModelFrame.js";
import type { WmoModel } from "./WmoModel.js";
import type { WvmModel } from "./Wvm.js";

/**
 * 06.10-7.24: the model-space box a click on a game object lands in, in the model's own axes.
 *
 * The click box used to be a 10–34 px square around a 1.2-yard column over the object's origin
 * (SimpleScene `#drawGameObject`), whatever the object was: a chair is a yard and a half across and
 * a forge or a door a good deal more, so most of the drawn object could not be clicked. The box is
 * now the model's own: an M2's header bounding box (MD20 0xA0, carried as the WVM's `bounds` —
 * `GameObjectDisplayInfo.GeoBox` holds the same box for the display), a WMO's union of its group
 * boxes, and for the legacy artifact the box of its geometry, which was baked through
 * `VMAP_TO_THREE` and is turned back here.
 */
export interface PickBoxSource {
  readonly wvm?: WvmModel | undefined;
  readonly wmo?: { readonly model: WmoModel } | undefined;
  readonly legacyGeometry?: { readonly geometry: THREE.BufferGeometry } | undefined;
}

export function modelPickBox(source: PickBoxSource): ModelBox | undefined {
  const bounds = source.wvm?.bounds;
  if (bounds) {
    return checked({
      minX: bounds.min[0], minY: bounds.min[1], minZ: bounds.min[2],
      maxX: bounds.max[0], maxY: bounds.max[1], maxZ: bounds.max[2],
    });
  }
  const wmo = source.wmo?.model;
  if (wmo) {
    let box: ModelBox | undefined;
    for (const group of wmo.groups) {
      if (group.boundsValid === false) continue;
      const b = group.bounds;
      if (!box) box = { minX: b.minX, minY: b.minY, minZ: b.minZ, maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ };
      else {
        box.minX = Math.min(box.minX, b.minX); box.minY = Math.min(box.minY, b.minY); box.minZ = Math.min(box.minZ, b.minZ);
        box.maxX = Math.max(box.maxX, b.maxX); box.maxY = Math.max(box.maxY, b.maxY); box.maxZ = Math.max(box.maxZ, b.maxZ);
      }
    }
    return box && checked(box);
  }
  const geometry = source.legacyGeometry?.geometry;
  if (geometry) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const b = geometry.boundingBox;
    if (!b) return undefined;
    // VMAP_TO_THREE is (x, y, z) → (−x, z, y) and its own inverse.
    return checked({ minX: -b.max.x, minY: b.min.z, minZ: b.min.y, maxX: -b.min.x, maxY: b.max.z, maxZ: b.max.y });
  }
  return undefined;
}

function checked(box: ModelBox): ModelBox | undefined {
  const values = [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ];
  if (!values.every(Number.isFinite)) return undefined;
  if (box.minX > box.maxX || box.minY > box.maxY || box.minZ > box.maxZ) return undefined;
  // A model whose header box is a point (an emitter-only display) has nothing to click on.
  if (box.maxX - box.minX + box.maxY - box.minY + box.maxZ - box.minZ < 1e-3) return undefined;
  return box;
}
