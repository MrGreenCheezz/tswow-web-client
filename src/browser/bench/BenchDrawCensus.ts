import type * as THREE from "three";

/**
 * 25.10 (12.10): what the draws of one frame could merge into («объединяй одинаковые объекты в один вызов»).
 *
 * Every draw three submits for the frame is noted (object, geometry, material, the group's range) and
 * grouped by what it is: a building's room, a doodad and why it is not instanced, a bucket, a unit. For
 * each kind the census counts how many draws would remain if draws were merged
 *   - within one mesh by material (runs of a room that share a material),
 *   - within one placement by material (all rooms of a building that share a material),
 *   - across meshes with the same geometry, range and material (identical copies: instancing),
 *   - by material alone (an upper bound: everything sharing a material in one draw).
 * Diagnostic only (`--trace --diagnostic`): it allocates freely and runs on one frame.
 */
export interface DrawCensusTagLike { kind: string; placement: number | undefined; model: string | undefined }

interface Draw {
  object: THREE.Object3D;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  start: number;
  pass: "main" | "shadow";
}

export interface DrawCensusKindRow {
  draws: number;
  objects: number;
  materials: number;
  /** Draws left if each mesh drew all its ranges of one material at once. */
  perMeshMaterial: number;
  /** Draws left if each placement drew all its ranges of one material at once. */
  perPlacementMaterial: number;
  /** Draws left if identical copies (geometry, range, material) were one instanced draw. */
  perCopy: number;
  /** Draws left if every draw of one material were one. */
  perMaterial: number;
  /** Draws whose material is transparent (sorted back to front; a bucket would lose that order). */
  transparent: number;
  triangles: number;
}

export interface DrawCensusSummary {
  main: Record<string, DrawCensusKindRow>;
  shadow: Record<string, DrawCensusKindRow>;
  mainMaterialSwitches: number;
  /** Doodad models drawn more than once as separate meshes, by draws, with why they are not in a bucket. */
  repeatedModels: Array<{ model: string; kind: string; draws: number; copies: number; perCopy: number }>;
  /** Buildings with the most draws in the main pass: draws against per-placement-material draws. */
  buildings: Array<{ model: string; draws: number; perMeshMaterial: number; perPlacementMaterial: number; rooms: number }>;
}

export class BenchDrawCensus {
  readonly #draws: Draw[] = [];

  note(object: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material,
    group: { start: number } | null, pass: "main" | "shadow"): void {
    this.#draws.push({ object, geometry, material, start: group?.start ?? -1, pass });
  }

  summarize(classify: (object: THREE.Object3D) => DrawCensusTagLike | undefined,
    branchOf: (object: THREE.Object3D) => string): DrawCensusSummary {
    const tags = new Map<THREE.Object3D, DrawCensusTagLike>();
    const tagOf = (object: THREE.Object3D): DrawCensusTagLike => {
      let tag = tags.get(object);
      if (!tag) {
        tag = classify(object) ?? { kind: branchOf(object), placement: undefined, model: undefined };
        tags.set(object, tag);
      }
      return tag;
    };
    const ids = new Map<object, number>();
    const id = (value: object): number => {
      let at = ids.get(value);
      if (at === undefined) { at = ids.size; ids.set(value, at); }
      return at;
    };
    const rows = { main: {} as Record<string, DrawCensusKindRow>, shadow: {} as Record<string, DrawCensusKindRow> };
    const sets = new Map<string, { objects: Set<number>; materials: Set<number>; mesh: Set<string>;
      placement: Set<string>; copy: Set<string> }>();
    let switches = 0;
    let lastMaterial: THREE.Material | undefined;
    const models = new Map<string, { kind: string; draws: number; objects: Set<number>; copies: Set<string> }>();
    const buildings = new Map<number, { model: string; draws: number; mesh: Set<string>; placement: Set<string>; rooms: Set<number> }>();
    for (const draw of this.#draws) {
      const tag = tagOf(draw.object);
      const key = `${draw.pass}|${tag.kind}`;
      const row = rows[draw.pass][tag.kind] ??= { draws: 0, objects: 0, materials: 0, perMeshMaterial: 0,
        perPlacementMaterial: 0, perCopy: 0, perMaterial: 0, transparent: 0, triangles: 0 };
      let set = sets.get(key);
      if (!set) {
        set = { objects: new Set(), materials: new Set(), mesh: new Set(), placement: new Set(), copy: new Set() };
        sets.set(key, set);
      }
      const object = id(draw.object), material = id(draw.material), geometry = id(draw.geometry);
      row.draws++;
      set.objects.add(object);
      set.materials.add(material);
      set.mesh.add(`${object}|${material}`);
      set.placement.add(`${tag.placement ?? `o${object}`}|${material}`);
      // A doodad's copies differ in material only by their placement's tint or light, which a bucket carries per copy.
      const copyKey = tag.kind.startsWith("doodad") ? `${geometry}|${draw.start}` : `${geometry}|${draw.start}|${material}`;
      set.copy.add(copyKey);
      if (draw.material.transparent) row.transparent++;
      const index = draw.geometry.index;
      row.triangles += Math.round((index ? index.count : draw.geometry.getAttribute("position")?.count ?? 0) / 3);
      if (draw.pass === "main") {
        if (draw.material !== lastMaterial) switches++;
        lastMaterial = draw.material;
        if (tag.model !== undefined && tag.kind.startsWith("doodad")) {
          const entry = models.get(tag.model) ?? { kind: tag.kind, draws: 0, objects: new Set(), copies: new Set() };
          models.set(tag.model, entry);
          entry.draws++;
          entry.objects.add(object);
          entry.copies.add(copyKey);
        }
        if (tag.kind === "wmo-room" && tag.placement !== undefined) {
          const entry = buildings.get(tag.placement) ?? { model: tag.model ?? "", draws: 0, mesh: new Set(), placement: new Set(), rooms: new Set() };
          buildings.set(tag.placement, entry);
          entry.draws++;
          entry.mesh.add(`${object}|${material}`);
          entry.placement.add(String(material));
          entry.rooms.add(object);
        }
      }
    }
    for (const [key, set] of sets) {
      const [pass, kind] = key.split("|") as ["main" | "shadow", string];
      const row = rows[pass][kind]!;
      row.objects = set.objects.size;
      row.materials = set.materials.size;
      row.perMeshMaterial = set.mesh.size;
      row.perPlacementMaterial = set.placement.size;
      row.perCopy = set.copy.size;
      row.perMaterial = set.materials.size;
    }
    const repeatedModels = [...models.entries()]
      .filter(([, entry]) => entry.objects.size > 1)
      .map(([model, entry]) => ({ model, kind: entry.kind, draws: entry.draws, copies: entry.objects.size, perCopy: entry.copies.size }))
      .sort((left, right) => (right.draws - right.perCopy) - (left.draws - left.perCopy))
      .slice(0, 40);
    const buildingRows = [...buildings.values()]
      .map((entry) => ({ model: entry.model, draws: entry.draws, perMeshMaterial: entry.mesh.size,
        perPlacementMaterial: entry.placement.size, rooms: entry.rooms.size }))
      .sort((left, right) => right.draws - left.draws)
      .slice(0, 25);
    return { main: rows.main, shadow: rows.shadow, mainMaterialSwitches: switches, repeatedModels, buildings: buildingRows };
  }
}
