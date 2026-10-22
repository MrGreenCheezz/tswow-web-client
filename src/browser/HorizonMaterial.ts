import * as THREE from "three";
import { horizonColourWanted } from "./Horizon.js";
import { installHorizonDetail, type HorizonDetail } from "./HorizonDetail.js"; // 22.10 (7.44)
import { applyWorldLight, type WorldLightUniforms } from "./WorldLighting.js";

/**
 * 05.10-A7b-7 (7.08 slice A): how bright the minimap colour is taken. The bake already holds the
 * light of its own day, so the product with the world's light can read darker than the near ground;
 * the spec's first guess was 0.6, the measured relation is not known. 1 leaves the picture as the
 * client baked it — calibrated against the original's far ground in 14.25.
 */
export const HORIZON_COLOUR_GAIN = 1;

/**
 * 05.10-A7b-7 (7.08 slice A): the material the far horizon draws with. On the classic path, once
 * the map's colour picture is in, a Lambert material lit by the same world light as the near
 * terrain (`terrain` kind: `min(1, ambient + diffuse·clamp(N·L, 0, 1))`, aerial fog included) with
 * the picture as its albedo; otherwise the flat fogged green the horizon always had. One lit
 * material for every map: changing maps swaps its `map`, never its program.
 */
export class HorizonMaterialSelector {
  readonly #basic: THREE.Material;
  readonly #worldLight: WorldLightUniforms;
  #lit: THREE.MeshLambertMaterial | undefined;
  /** 22.10 (7.44): the enhanced path's lit horizon with the minimap detail (HorizonDetail.ts). */
  #detailed: THREE.MeshLambertMaterial | undefined;
  #detailedFor: HorizonDetail | undefined;

  constructor(basic: THREE.Material, worldLight: WorldLightUniforms) {
    this.#basic = basic;
    this.#worldLight = worldLight;
  }

  /** The lit material, once it has been needed (tests and disposal). */
  get lit(): THREE.MeshLambertMaterial | undefined {
    return this.#lit;
  }

  /**
   * The material for this frame: the lit, coloured horizon once the map's picture is in, at every
   * lighting level since 7.39; the flat fogged green until then.
   */
  select(lightingQuality: number, colour: () => THREE.Texture | undefined, detail?: HorizonDetail): THREE.Material {
    // 22.10 (7.39): every level takes the coloured horizon; the enhanced fog now shows it.
    const texture = colour();
    if (!horizonColourWanted(lightingQuality, texture !== undefined) || !texture) return this.#basic;
    // 22.10 (7.44): the caller passes the detail on the enhanced path only.
    if (detail) return this.#detailMaterial(texture, detail);
    if (!this.#lit) {
      this.#lit = new THREE.MeshLambertMaterial({ map: texture, fog: true });
      this.#lit.color.setScalar(HORIZON_COLOUR_GAIN);
      this.#lit.name = "horizon-lit";
      applyWorldLight(this.#lit, this.#worldLight, "terrain");
    } else if (this.#lit.map !== texture) {
      // Same program (a map either way); only the sampler's texture changes.
      this.#lit.map = texture;
    }
    return this.#lit;
  }

  /** 22.10 (7.44): the detailed material, once it has been needed (tests and disposal). */
  get detailed(): THREE.MeshLambertMaterial | undefined {
    return this.#detailed;
  }

  #detailMaterial(texture: THREE.Texture, detail: HorizonDetail): THREE.MeshLambertMaterial {
    if (this.#detailed && this.#detailedFor !== detail) {
      this.#detailed.dispose();
      this.#detailed = undefined;
    }
    if (!this.#detailed) {
      const material = new THREE.MeshLambertMaterial({ map: texture, fog: true });
      material.color.setScalar(HORIZON_COLOUR_GAIN);
      material.name = "horizon-detail";
      installHorizonDetail(material, detail);
      applyWorldLight(material, this.#worldLight, "terrain");
      this.#detailed = material;
      this.#detailedFor = detail;
    } else if (this.#detailed.map !== texture) {
      this.#detailed.map = texture;
    }
    return this.#detailed;
  }

  dispose(): void {
    this.#detailed?.dispose();
    this.#detailed = undefined;
    this.#detailedFor = undefined;
    this.#lit?.dispose();
    this.#lit = undefined;
  }
}
