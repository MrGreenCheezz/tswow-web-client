/**
 * P2-03b (UNT-8): one set of vertex attributes per decoded model, shared by all its unit builds.
 *
 * Every appearance of a model is its own build — its geosets choose its index range, its slots its
 * textures — but the vertices are the file's, the same typed arrays for every appearance. Each build
 * still wrapped them in six new `BufferAttribute`s, and three keys a GL buffer on the attribute
 * object, so each appearance uploaded its model's vertices again: HumanMale is 953 KiB of them, a
 * city crowd carries it three times. Built through this store, the appearances of one model share
 * the attribute objects and so the GL buffers; a build owns only its index (and slot attribute).
 *
 * Disposal is the cache's: `disposeEvictedBuiltModels` strips every identity a retained build still
 * holds from a dying wrapper before disposing it, so a shared buffer goes with its last wrapper.
 * That is why only `#builtUnits` builds through a store — its eviction always passes every live
 * build as retained — and why the renderer starts a new store whenever it drops its caches.
 */

import * as THREE from "three";
import type { WvmModel } from "./Wvm.js";

export interface ModelVertexAttributes {
  readonly position: THREE.BufferAttribute;
  readonly normal: THREE.BufferAttribute;
  readonly uv: THREE.BufferAttribute;
  readonly uv1: THREE.BufferAttribute;
  /** Created on the first skinned build of the model. */
  skinIndex?: THREE.BufferAttribute;
  skinWeight?: THREE.BufferAttribute;
}

export class SharedModelBuffers {
  readonly #byModel = new WeakMap<WvmModel, ModelVertexAttributes>();
  #models = 0;
  #reused = 0;

  /** The model's attributes, created once; `skinned` adds the skin pair when the model has one. */
  attributesFor(model: WvmModel, skinned: boolean): ModelVertexAttributes {
    let attributes = this.#byModel.get(model);
    if (attributes) this.#reused++;
    else {
      attributes = {
        position: new THREE.BufferAttribute(model.positions, 3),
        normal: new THREE.BufferAttribute(model.normals, 3),
        uv: new THREE.BufferAttribute(model.uv0, 2),
        uv1: new THREE.BufferAttribute(model.uv1, 2),
      };
      this.#byModel.set(model, attributes);
      this.#models++;
    }
    if (skinned && model.boneIndices && model.boneWeights && !attributes.skinIndex) {
      attributes.skinIndex = new THREE.BufferAttribute(model.boneIndices, 4);
      attributes.skinWeight = new THREE.BufferAttribute(model.boneWeights, 4);
    }
    return attributes;
  }

  /** Models given attributes, and builds that found theirs already made. */
  get stats(): { models: number; reused: number } {
    return { models: this.#models, reused: this.#reused };
  }
}
