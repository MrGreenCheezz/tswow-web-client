import * as THREE from "three";

/**
 * 15.11 (7.16, terrain7): the ground's environment reflection — Wow.exe's `_env` terrain permutations.
 *
 * What the original does (read from Wow.exe 12340 and its shaders; notes in `.runtime/re-2026-11-15/terrain7/`):
 *   * A chunk reflects when any of its `MCLY` layers has flag 0x400 and the card has pixel shaders and
 *     cube maps (0x007b9250 sets the chunk's flag 4). The data carries the flag on layer 0 only.
 *   * Its layer 0 texture is then a cube: a BLP six squares wide (0x004b95b0), faces copied from strip
 *     columns 0, 2, 4, 5, 3, 1 (0x004b7aa0) — `tools/generate-terrain-splat.mjs` publishes them in face
 *     order, so here a face is a plain column.
 *   * The vertex program (`Shaders\Vertex\*\terrain.bls`, permutation bit 2) reflects the eye-to-vertex
 *     vector about the vertex normal in view space, turns it back to world space by the inverse view
 *     rotation (c8–c10) and writes it swizzled (x, z, y) as texcoord 0; the pixel program samples layer 0
 *     there with a cube sampler (`terrain*_pcf.bls`, every odd permutation) and uses the sample exactly
 *     as it uses a flat layer 0 — colour into the blend, alpha as the specular mask. Nothing else changes.
 *   * Recorded on the stand (`F:\WowOracle\runs\fog6-n-stormpeaks.tsv`, draw 619): the cube bound on
 *     stage 0 of a `terrain3_pcf` draw, c8–c10 the camera's right/up/forward rows of the recorded `K` line.
 */

/** How many distinct cube maps one tile's program samples; the client's tiles use one, at most two. */
export const TERRAIN_CUBE_LIMIT = 2;

/** One tile's reflection: its cube maps, the layer each stands in for, and which chunks reflect. */
export interface TerrainSplatEnvironment {
  readonly cubes: readonly THREE.CubeTexture[];
  /** The layer (index into `splat.json.layers`) whose slot the cube of the same position replaces. */
  readonly cubeLayers: readonly number[];
  /** 16 rows (MCNK `IndexY`, index.png's rows), bit `column` set where that chunk reflects. */
  readonly chunkRows: Int32Array;
}

/** What `splat.json` asks for: the cube ids to load and the chunk rows. */
export interface TerrainEnvironmentPlan {
  readonly cubes: readonly { readonly layer: number; readonly id: string }[];
  readonly chunkRows: Int32Array;
}

/**
 * Reads a v3 `splat.json`'s `cubes` (one 40-hex id or null per layer) and `env` (chunk indices,
 * row · 16 + column). Undefined when either is missing or malformed, or nothing would reflect: an older
 * gateway, an ordinary tile. Cubes past {@link TERRAIN_CUBE_LIMIT} are left out (their chunks then draw
 * the flat layer, as before).
 */
export function terrainEnvironmentPlan(value: unknown, layerCount: number): TerrainEnvironmentPlan | undefined {
  const record = value as { cubes?: unknown; env?: unknown } | null;
  const ids = record?.cubes;
  const env = record?.env;
  if (!Array.isArray(ids) || ids.length !== layerCount || !Array.isArray(env) || env.length === 0) return undefined;
  if (!ids.every((id) => id === null || (typeof id === "string" && /^[0-9a-f]{40}$/.test(id)))) return undefined;
  if (!env.every((chunk) => Number.isInteger(chunk) && chunk >= 0 && chunk < 256)) return undefined;
  const cubes: { layer: number; id: string }[] = [];
  for (let layer = 0; layer < ids.length && cubes.length < TERRAIN_CUBE_LIMIT; layer++) {
    const id = ids[layer] as string | null;
    if (id !== null) cubes.push({ layer, id });
  }
  if (cubes.length === 0) return undefined;
  const chunkRows = new Int32Array(16);
  for (const chunk of env as number[]) chunkRows[chunk >> 4]! |= 1 << (chunk & 15);
  return { cubes, chunkRows };
}

/**
 * The cube lookup direction of one vertex, in this renderer's world space (three x = WoW x, y = WoW z,
 * z = −WoW y): the eye-to-vertex vector reflected about the normal, then as the client writes it —
 * WoW (x, z, y), i.e. (x, y, −z) here. The GLSL below is the same arithmetic; this twin is for tests.
 */
export function terrainEnvironmentDirection(
  vertex: THREE.Vector3, camera: THREE.Vector3, normal: THREE.Vector3, target = new THREE.Vector3(),
): THREE.Vector3 {
  const n = normal.clone().normalize();
  const incident = vertex.clone().sub(camera);
  const reflected = incident.sub(n.multiplyScalar(2 * incident.dot(n))); // GLSL reflect(I, N)
  return target.set(reflected.x, reflected.y, -reflected.z);
}

/** The vertex hook: declarations and the per-vertex direction, placed before `project_vertex`. */
export function injectTerrainEnvironmentVertex(vertexShader: string): string {
  return `varying vec3 vSplatEnvDir;\n${vertexShader}`.replace("#include <project_vertex>", `
      // 15.11 (7.16): Wow.exe's terrain.bls env permutation — reflect(eye → vertex, N), written (x, z, y) in WoW axes.
      vec4 splatEnvWorld = modelMatrix * vec4( transformed, 1.0 );
      vec3 splatEnvNormal = normalize( mat3( modelMatrix ) * objectNormal );
      vec3 splatEnvReflected = reflect( splatEnvWorld.xyz - cameraPosition, splatEnvNormal );
      vSplatEnvDir = vec3( splatEnvReflected.x, splatEnvReflected.y, -splatEnvReflected.z );
      #include <project_vertex>`);
}

/** The fragment declarations for `cubeCount` cubes. */
export function terrainEnvironmentFragmentHead(cubeCount: number): string {
  const lines = ["varying vec3 vSplatEnvDir;", "uniform int splatEnvRows[ 16 ];"];
  for (let cube = 0; cube < cubeCount; cube++) lines.push(`uniform samplerCube splatCube${cube};`, `uniform float splatCubeLayer${cube};`);
  return lines.join("\n      ");
}

/**
 * The fragment body, after slot r's colour is in `splatColour`: in a reflecting chunk whose layer 0 is a
 * cube, that colour is the cube's (and `splatEnvTexel.a` its specular mask). The cubes are sampled
 * outside the branch so their derivatives stay defined across chunk borders.
 */
export function terrainEnvironmentFragmentBody(cubeCount: number): string {
  const lines = [
    "ivec2 splatEnvCell = ivec2( splatCell );",
    "bool splatEnvChunk = ( ( splatEnvRows[ 15 - splatEnvCell.y ] >> splatEnvCell.x ) & 1 ) != 0;",
    "vec4 splatEnvTexel = vec4( 1.0 );",
    "bool splatEnvOn = false;",
  ];
  for (let cube = 0; cube < cubeCount; cube++) {
    lines.push(
      `vec4 splatEnvSample${cube} = texture( splatCube${cube}, vSplatEnvDir );`,
      `if ( splatEnvChunk && !splatEnvOn && abs( splatSlots.r - splatCubeLayer${cube} ) < 0.5 ) { splatEnvTexel = splatEnvSample${cube}; splatEnvOn = true; }`,
    );
  }
  lines.push("if ( splatEnvOn ) splatColour = splatEnvTexel.rgb;");
  return lines.join("\n      ");
}

/** The uniforms of one tile's reflection, added in every compile of its material. */
export function terrainEnvironmentUniforms(environment: TerrainSplatEnvironment): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = { splatEnvRows: { value: environment.chunkRows } };
  environment.cubes.forEach((cube, index) => {
    uniforms[`splatCube${index}`] = { value: cube };
    uniforms[`splatCubeLayer${index}`] = { value: environment.cubeLayers[index] };
  });
  return uniforms;
}

/**
 * One cube map out of a published face strip (`/terrain-layer/<id>.png`, six squares in face order). The
 * faces are cut by the decoder, unflipped and unpremultiplied: row 0 of a face is its t = 0 row, as in
 * the client's upload. Rejects when the picture is not six squares wide.
 */
export async function loadTerrainCube(url: string): Promise<THREE.CubeTexture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Terrain cube gateway returned ${response.status}`);
  const blob = await response.blob();
  const options: ImageBitmapOptions = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
  const whole = await createImageBitmap(blob, options);
  const side = whole.height;
  const width = whole.width;
  whole.close();
  if (side <= 0 || width !== side * 6) throw new Error(`Terrain cube ${url} is ${width}x${side}, not six squares`);
  const faces = await Promise.all([0, 1, 2, 3, 4, 5].map((face) => createImageBitmap(blob, face * side, 0, side, side, options)));
  const cube = new THREE.CubeTexture(faces);
  cube.flipY = false;
  cube.colorSpace = THREE.SRGBColorSpace; // as the layer array: a colour, decoded to linear by the sampler
  cube.generateMipmaps = true;
  cube.minFilter = THREE.LinearMipmapLinearFilter;
  cube.magFilter = THREE.LinearFilter;
  cube.needsUpdate = true;
  cube.addEventListener("dispose", () => { for (const face of faces) face.close(); });
  return cube;
}
