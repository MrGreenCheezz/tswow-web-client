import type * as THREE from "three";

/**
 * Three uploads a uniform only when it differs from the last value it sent, remembered per
 * uniform in a plain array (`cache`), and it compares and copies those arrays through two helpers
 * that every vector, matrix, integer vector and texture-array setter shares. In the world those
 * helpers see matrix elements, Int32Array texture units, Float32Array values and caches of several
 * element kinds, so V8 compiles them for any array and hands every double they read or write out
 * as a new heap number. A camera move changes every model-view and normal matrix, which made
 * three's setValueM4/M3 the renderer's largest source of garbage (a fifth of it in the city).
 *
 * The float vector and matrix uniforms of our programs get setters of their own below: one per
 * type, each seeing only its own kind of value, with the cache in a Float64Array (NaN at first,
 * which equals nothing, so the first set always uploads). They pick the value's form by three's
 * `isVector3`-style flags rather than by probing `x`: a probe that finds a double on one class and
 * nothing on another boxes the double too. Any other form (a flat array, a plain `{ x, y, z }`)
 * goes to three's own setter, which works on the same Float64Array cache.
 *
 * Arrays of Vector4 and Matrix4 (the cascade shadow matrices, the local light positions) go the
 * same way. Three flattens them on every draw, first asking whether element 0 is a number by
 * comparing the object with 0, which runs its valueOf and toString, and uploads them unconditionally;
 * here they are compared with the last upload like any other uniform.
 */

type Setter = (this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown) => void;

/** The parts of three's SingleUniform, PureArrayUniform and StructuredUniform used here. */
export interface UniformNode {
  readonly type?: number;
  /** Only PureArrayUniform has it: the length of the GLSL array. */
  readonly size?: number;
  cache?: unknown;
  setValue?: unknown;
  readonly seq?: readonly UniformNode[];
}

interface FloatUniform {
  readonly type: number;
  readonly size?: number;
  readonly addr: WebGLUniformLocation;
  readonly cache: Float64Array;
}

interface ProgramWithUniforms {
  getUniforms(): { readonly seq: readonly UniformNode[] };
}

const FLOAT_VEC2 = 0x8b50;
const FLOAT_VEC3 = 0x8b51;
const FLOAT_VEC4 = 0x8b52;
const FLOAT_MAT3 = 0x8b5b;
const FLOAT_MAT4 = 0x8b5c;

const VEC2 = new Float32Array(2);
const VEC3 = new Float32Array(3);
const VEC4 = new Float32Array(4);
const MAT3 = new Float32Array(9);
const MAT4 = new Float32Array(16);
/** Upload buffers for the array uniforms, by length. */
const ARRAY_UPLOADS = new Map<number, Float32Array>();

/** Three's own setters, for the value forms handled there: single uniforms, then arrays, by type. */
const threeSetters = new Map<number, Setter>();
const threeArraySetters = new Map<number, Setter>();

function threeSet(uniform: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  const setters = uniform.size === undefined ? threeSetters : threeArraySetters;
  setters.get(uniform.type)!.call(uniform, gl, value, textures);
}

/** Three's array setters upload without touching the cache, so what the program holds is unknown after. */
function forgetAndThreeSet(uniform: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  uniform.cache.fill(Number.NaN);
  threeSet(uniform, gl, value, textures);
}

function arrayUpload(cache: Float64Array): Float32Array {
  let upload = ARRAY_UPLOADS.get(cache.length);
  if (!upload) {
    upload = new Float32Array(cache.length);
    ARRAY_UPLOADS.set(cache.length, upload);
  }
  upload.set(cache);
  return upload;
}

function setVec2(this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  const vector = value as THREE.Vector2;
  if (vector.isVector2 !== true) {
    threeSet(this, gl, value, textures);
    return;
  }
  const x = vector.x, y = vector.y, cache = this.cache;
  if (cache[0] === x && cache[1] === y) return;
  cache[0] = x; cache[1] = y;
  VEC2[0] = x; VEC2[1] = y;
  gl.uniform2fv(this.addr, VEC2);
}

function setVec3(this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  let x: number, y: number, z: number;
  if ((value as THREE.Vector3).isVector3 === true) {
    const vector = value as THREE.Vector3;
    x = vector.x; y = vector.y; z = vector.z;
  } else if ((value as THREE.Color).isColor === true) {
    const color = value as THREE.Color;
    x = color.r; y = color.g; z = color.b;
  } else {
    threeSet(this, gl, value, textures);
    return;
  }
  const cache = this.cache;
  if (cache[0] === x && cache[1] === y && cache[2] === z) return;
  cache[0] = x; cache[1] = y; cache[2] = z;
  VEC3[0] = x; VEC3[1] = y; VEC3[2] = z;
  gl.uniform3fv(this.addr, VEC3);
}

function setVec4(this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  const vector = value as THREE.Vector4;
  if (vector.isVector4 !== true) {
    threeSet(this, gl, value, textures);
    return;
  }
  const x = vector.x, y = vector.y, z = vector.z, w = vector.w, cache = this.cache;
  if (cache[0] === x && cache[1] === y && cache[2] === z && cache[3] === w) return;
  cache[0] = x; cache[1] = y; cache[2] = z; cache[3] = w;
  VEC4[0] = x; VEC4[1] = y; VEC4[2] = z; VEC4[3] = w;
  gl.uniform4fv(this.addr, VEC4);
}

function setMat3(this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  const elements = (value as THREE.Matrix3).elements as readonly number[] | undefined;
  if (elements === undefined) {
    threeSet(this, gl, value, textures);
    return;
  }
  const cache = this.cache;
  let i = 0;
  while (i < 9 && cache[i] === elements[i]) i++;
  if (i === 9) return;
  // All of it: -0 and 0 compare equal, and the upload should carry the new value's zeros.
  for (let k = 0; k < 9; k++) cache[k] = elements[k]!;
  MAT3.set(cache);
  gl.uniformMatrix3fv(this.addr, false, MAT3);
}

function setMat4(this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  const elements = (value as THREE.Matrix4).elements as readonly number[] | undefined;
  if (elements === undefined) {
    threeSet(this, gl, value, textures);
    return;
  }
  const cache = this.cache;
  let i = 0;
  while (i < 16 && cache[i] === elements[i]) i++;
  if (i === 16) return;
  // All of it: -0 and 0 compare equal, and the upload should carry the new value's zeros.
  for (let k = 0; k < 16; k++) cache[k] = elements[k]!;
  MAT4.set(cache);
  gl.uniformMatrix4fv(this.addr, false, MAT4);
}

function setVec4Array(this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  const vectors = value as readonly THREE.Vector4[];
  const count = this.size!;
  for (let i = 0; i < count; i++) {
    if (vectors[i]?.isVector4 !== true) {
      forgetAndThreeSet(this, gl, value, textures);
      return;
    }
  }
  const cache = this.cache;
  let changed = false;
  for (let i = 0, at = 0; i < count; i++, at += 4) {
    const vector = vectors[i]!;
    const x = vector.x, y = vector.y, z = vector.z, w = vector.w;
    if (cache[at] !== x || cache[at + 1] !== y || cache[at + 2] !== z || cache[at + 3] !== w) changed = true;
    // Always: -0 and 0 compare equal, and the upload should carry the new value's zeros.
    cache[at] = x; cache[at + 1] = y; cache[at + 2] = z; cache[at + 3] = w;
  }
  if (changed) gl.uniform4fv(this.addr, arrayUpload(cache));
}

function setMat4Array(this: FloatUniform, gl: WebGL2RenderingContext, value: unknown, textures: unknown): void {
  const matrices = value as readonly THREE.Matrix4[];
  const count = this.size!;
  for (let i = 0; i < count; i++) {
    if ((matrices[i] as { readonly isMatrix4?: unknown } | undefined)?.isMatrix4 !== true) {
      forgetAndThreeSet(this, gl, value, textures);
      return;
    }
  }
  const cache = this.cache;
  let changed = false;
  for (let i = 0, at = 0; i < count; i++, at += 16) {
    const elements = matrices[i]!.elements;
    for (let k = 0; k < 16; k++) {
      const element = elements[k]!;
      if (cache[at + k] !== element) changed = true;
      // Always: -0 and 0 compare equal, and the upload should carry the new value's zeros.
      cache[at + k] = element;
    }
  }
  if (changed) gl.uniformMatrix4fv(this.addr, false, arrayUpload(cache));
}

const SINGLE: ReadonlyMap<number, { readonly components: number; readonly setter: Setter }> = new Map([
  [FLOAT_VEC2, { components: 2, setter: setVec2 }],
  [FLOAT_VEC3, { components: 3, setter: setVec3 }],
  [FLOAT_VEC4, { components: 4, setter: setVec4 }],
  [FLOAT_MAT3, { components: 9, setter: setMat3 }],
  [FLOAT_MAT4, { components: 16, setter: setMat4 }],
]);

const ARRAY: ReadonlyMap<number, { readonly components: number; readonly setter: Setter }> = new Map([
  [FLOAT_VEC4, { components: 4, setter: setVec4Array }],
  [FLOAT_MAT4, { components: 16, setter: setMat4Array }],
]);

/**
 * Gives every float vector and matrix uniform in `seq` (struct members included), and every
 * vec4/mat4 array, its own setter and a Float64Array cache. Uniforms already converted are left
 * alone. Returns how many changed.
 */
export function specialiseFloatUniforms(seq: readonly UniformNode[]): number {
  let changed = 0;
  for (const uniform of seq) {
    if (uniform.seq) {
      changed += specialiseFloatUniforms(uniform.seq);
      continue;
    }
    if (uniform.type === undefined || !Array.isArray(uniform.cache) || typeof uniform.setValue !== "function") continue;
    const array = uniform.size !== undefined;
    const specialised = (array ? ARRAY : SINGLE).get(uniform.type);
    if (!specialised) continue;
    const setters = array ? threeArraySetters : threeSetters;
    if (!setters.has(uniform.type)) setters.set(uniform.type, uniform.setValue as Setter);
    uniform.cache = new Float64Array(specialised.components * (array ? uniform.size! : 1)).fill(Number.NaN);
    uniform.setValue = specialised.setter;
    changed++;
  }
  return changed;
}

const hookedLists = new WeakSet<object>();
const watchedPrograms = new WeakSet<object>();

/**
 * Converts each program of `renderer` on its first use. Three builds a program's uniforms on its
 * first `getUniforms()`, which also waits for the link to finish, so nothing here calls it: the
 * program's own first call is wrapped once and then put back.
 */
export function useFloatUniformSetters(renderer: THREE.WebGLRenderer): void {
  // `info.programs` is the program cache's own list (WebGLPrograms.programs); acquireProgram
  // pushes every program it creates onto it.
  const programs = renderer.info.programs as unknown as ProgramWithUniforms[] | null;
  if (!programs || hookedLists.has(programs)) return;
  hookedLists.add(programs);
  for (const program of programs) specialiseOnFirstUse(program);
  const push = programs.push;
  Object.defineProperty(programs, "push", {
    configurable: true,
    writable: true,
    value(this: ProgramWithUniforms[], ...added: ProgramWithUniforms[]): number {
      for (const program of added) specialiseOnFirstUse(program);
      return push.apply(this, added);
    },
  });
}

function specialiseOnFirstUse(program: ProgramWithUniforms): void {
  if (watchedPrograms.has(program)) return;
  watchedPrograms.add(program);
  const getUniforms = program.getUniforms;
  program.getUniforms = function (this: ProgramWithUniforms) {
    const uniforms = getUniforms.call(this);
    program.getUniforms = getUniforms;
    specialiseFloatUniforms(uniforms.seq);
    return uniforms;
  };
}
