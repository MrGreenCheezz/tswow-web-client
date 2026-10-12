// 12.10 6.25: «есть проблемы рендера парусов» — the doodads of a WMO drawn as a game object.
//
// Every transport's sails, propellers and paddle wheel are M2 doodads of its WMO's set 0, not WMO
// geometry: TransportShip_Sails.m2 on Transport_Ship.wmo (display 3015 — the Bravery, the Lady Mehley,
// the Maiden's Fancy), TransportShip_NE_DoodadsMoving.m2 on Transportship_NE.wmo (7087 — the Moonspray,
// Elune's Blessing, the Feathermoon Ferry), ZepAnimation.m2 / HordeZepAnimation.m2 on the zeppelins
// (3031, 7546), Icebreaker_Paddlewheel.m2 with 27 barrels and lanterns on the icebreakers (7446).
// A WMO an ADT places gets its doodads from the tile; a game object's WMO had none at all, so every
// ship crossed the sea bare-masted, where the original client shows its sails, paddle wheel and
// cargo. The list comes from `/visual/doodads` (`WmoDoodadClient.ts`); each doodad hangs under
// the object's node — which moves with the ship — at its MODD transform, in the frame the WMO's own
// group meshes are built in (`VMAP_TO_THREE`, WMO point v at C·v), exactly as the tile generator
// places a WMO's doodads (`tools/generate-visual-tile.mjs` `worldDoodad`). An animated doodad plays
// Stand, as a placed animated doodad does (`#poseDoodads`).
//
// Not here yet: the doodads' particle emitters (a lantern's flame) and the ShipStart/ShipMoving/
// ShipStop sequences the sail models also carry.

import * as THREE from "three";
import type { SkinnedInstance, SkinnedTemplate } from "./AnimatedModel.js";
import type { BuiltModel } from "./ModelBuild.js";
import type { WmoDoodadPlacement } from "./WmoDoodadClient.js";
import type { WvmModel } from "./Wvm.js";

/** `VMAP_TO_THREE` (WorldRenderer3D.ts) as a quaternion: (x, y, z) → (−x, z, y). */
const CONVERSION = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
));
const CONVERSION_INVERSE = CONVERSION.clone().invert();
const _rotation = new THREE.Quaternion();

/**
 * Puts `target` where a WMO doodad stands inside the node its WMO is drawn under: position C·p,
 * rotation C·q·C⁻¹, the doodad's scale. The doodad's own mesh then carries `ADT_MODEL_TO_SCENE` (= C),
 * like every placed M2 doodad, so an M2 vertex m lands at C·(p + q·(s·m)) in the node.
 */
export function placeWmoDoodad(doodad: Pick<WmoDoodadPlacement, "position" | "rotation" | "scale">, target: THREE.Object3D): THREE.Object3D {
  const [x, y, z] = doodad.position;
  target.position.set(-x, z, y);
  _rotation.set(doodad.rotation[0], doodad.rotation[1], doodad.rotation[2], doodad.rotation[3]).normalize();
  target.quaternion.copy(CONVERSION).multiply(_rotation).multiply(CONVERSION_INVERSE);
  target.scale.setScalar(doodad.scale);
  return target;
}

/** One doodad of a game object's WMO, built once its model has arrived. */
export interface GameObjectDoodad {
  readonly placement: WmoDoodadPlacement;
  /** The placed wrapper hung under the object's node; undefined until built. */
  node: THREE.Object3D | undefined;
  /** The build it borrows (pinned against the built-model cache's eviction while retained). */
  built: BuiltModel | undefined;
  instance: SkinnedInstance | undefined;
  template: SkinnedTemplate | undefined;
  /** Placement-owned tinted material copies, released with the doodad. */
  tintMaterials: readonly THREE.Material[] | undefined;
  /** The model it was built from, for its global sequences (the client's cache may let it go). */
  wvm: WvmModel | undefined;
}

/** A game object's doodads: the list, or an empty one once the list said there are none. */
export interface GameObjectDoodads {
  readonly entries: GameObjectDoodad[];
  /** How many are still waiting for their model. */
  pending: number;
}

export function gameObjectDoodadsFor(list: readonly WmoDoodadPlacement[] | null): GameObjectDoodads {
  const entries = (list ?? []).map((placement): GameObjectDoodad => ({
    placement, node: undefined, built: undefined, instance: undefined, template: undefined, tintMaterials: undefined,
    wvm: undefined,
  }));
  return { entries, pending: entries.length };
}
