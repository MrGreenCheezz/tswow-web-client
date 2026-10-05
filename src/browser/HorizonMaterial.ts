import * as THREE from "three";
import { horizonColourWanted } from "./Horizon.js";
import { lightingClassicLook } from "./LightingQuality.js"; // 05.10-7.20
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

  constructor(basic: THREE.Material, worldLight: WorldLightUniforms) {
    this.#basic = basic;
    this.#worldLight = worldLight;
  }

  /** The lit material, once it has been needed (tests and disposal). */
  get lit(): THREE.MeshLambertMaterial | undefined {
    return this.#lit;
  }

  /**
   * The material for this frame. `colour` is asked only on the classic path, so the enhanced and
   * cinematic presets never download the picture or hold its texture.
   */
  select(lightingQuality: number, colour: () => THREE.Texture | undefined): THREE.Material {
    if (!lightingClassicLook(lightingQuality)) return this.#basic; // 05.10-7.20
    const texture = colour();
    if (!horizonColourWanted(lightingQuality, texture !== undefined) || !texture) return this.#basic;
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

  dispose(): void {
    this.#lit?.dispose();
    this.#lit = undefined;
  }
}
