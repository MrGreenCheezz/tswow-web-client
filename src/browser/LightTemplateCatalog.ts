/**
 * 24.10 (7.50): which models light, and how (`LightTemplates.ts`), known before their placements
 * are built.
 *
 * A model can light in two ways: the cinematic heuristic, which only ever looks at a model whose
 * file name reads as a lamp, torch or fire (`fixtureNameCandidate`), and the model's own M2 lights,
 * which only the model itself declares. So a placement list names its lamps by name alone: every
 * name past the gate is asked for as soon as a tile lists it (`want`, then `pump` polls the
 * environment client, nearest first, at `normal` priority within `LIGHT_MODEL_NEAR` yards), and its
 * templates are derived from the model data — no build, no draw. A model past no gate that turns
 * out to declare lights is learned when its first placement is built (`noteLit`).
 *
 * What is learned is kept between sessions (`PersistentAssetStore.ts`, one row filed under the
 * gateway's visual generation), so on a later visit every lamp of a tile lights as the tile lands.
 * So are a city's own lamp posts (`WmoOpenAirLamps.ts`), group by group as their meshes were read:
 * on a later visit a street's lanterns light with the building, before its groups arrive.
 *
 * 24.10 (7.50): and, from a gateway that has the route, every building's lamp table
 * (`/visual/wmo-lamps`, `WmoLampTableClient.ts`): asked as soon as a tile lists the building
 * (`wantLampTable`), it names the lanterns of all of its open-air groups, so its lamp posts light with
 * its root even on a first visit. Without it (an older gateway) the groups are read as they arrive.
 *
 * 25.10 (7.50): and, from a gateway that has the route, the index of models that declare their own M2 lights
 * (`/visual/lit-models`, `LitModelIndexClient.ts`): a model past no name gate that the index names is a
 * candidate like a lamp, asked for as soon as a tile lists it, and lights before it is built — the wagon
 * lantern of `StormwindGypsyWagon01.m2` used to switch on at 112 yards when the wagon was first built.
 * Without it (an older gateway) such a model is learned at its first build (`noteLit`), as before.
 */
import { fixtureNameCandidate } from "./LocalLighting.js";
import { deriveLightTemplates, validLightTemplates, type LightTemplate } from "./LightTemplates.js";
import { gatewayGenerationOrigin, gatewayVisualGeneration } from "./GatewayGeneration.js";
import { lightCatalogGenerationOverride } from "./LightCatalogGeneration.js";
import { persistentAssetStore, type PersistentAssetStore } from "./PersistentAssetStore.js";
import { renderSwitches } from "./RenderSwitches.js";
import { seedWmoLanterns, wmoLanternGroups } from "./WmoOpenAirLamps.js";
import type { WmoModel } from "./WmoModel.js";
import { LAMP_TABLE_PENDING, type WmoLampTable, type WmoLampTableSource } from "./WmoLampTableClient.js"; // 24.10 (7.50)
import type { WvmModel } from "./Wvm.js";
import { LIT_INDEX_PENDING, type LitModelIndexSource } from "./LitModelIndexClient.js"; // 25.10 (7.50)

/** Yards within which a lamp model is asked for at `normal` priority rather than `background`. */
export const LIGHT_MODEL_NEAR = 200;
/** Models a frame's `pump` asks the client about. */
export const LIGHT_MODEL_POLL = 16;
/** The persistent record's kind; bumped when a template's shape or derivation changes. */
export const LIGHT_TEMPLATE_KIND = "light-templates-v1";
/** Entries kept in the persistent record. */
export const LIGHT_TEMPLATE_STORED_LIMIT = 4096;
/** Lantern coordinates kept in the persistent record (three per lantern). */
export const LIGHT_LANTERN_STORED_LIMIT = 30_000;
/** Milliseconds between writes of the persistent record. */
const SAVE_DELAY_MS = 5000;

/** What the catalog asks of the environment client (`EnvironmentClient`). */
export interface LightModelSource {
  model(name: string, priority: "background" | "normal"): { readonly wvm?: WvmModel | undefined } | undefined;
  modelState(name: string): string;
}

const EMPTY: readonly LightTemplate[] = Object.freeze([]);


/**
 * The catalog's key: the path as the client keys models, and the M2-light switch it was derived under.
 * Kept per name as the tiles spell it, so the per-frame asks (`noteLit`, `syncWmo`) build no string.
 */
const KEYS: readonly [Map<string, string>, Map<string, string>] = [new Map(), new Map()];
function catalogKey(name: string): string {
  const flag = renderSwitches.m2Lights ? 1 : 0;
  let key = KEYS[flag].get(name);
  if (key === undefined) {
    key = `${flag}|${pathKey(name)}`;
    KEYS[flag].set(name, key);
  }
  return key;
}
const PATHS = new Map<string, string>();
function pathKey(name: string): string {
  let key = PATHS.get(name);
  if (key === undefined) {
    key = name.replaceAll("/", "\\").toLowerCase();
    PATHS.set(name, key);
  }
  return key;
}

export class LightTemplateCatalog {
  readonly #known = new Map<string, readonly LightTemplate[]>();
  /** Per name as the tiles spell it: whether a placement of it may light. */
  readonly #candidate = new Map<string, boolean>();
  /** Names wanted and not known yet, nearest first; with the priority each is asked at. */
  #pending: { name: string; distance: number }[] = [];
  readonly #pendingNames = new Set<string>();
  #cursor = 0;
  #generation = 0;
  #candidateGeneration = 0;
  /** 24.10 (7.50): per WMO path, the open-air groups read and their lanterns (model space). */
  readonly #lanterns = new Map<string, Map<number, readonly number[]>>();
  #lanternRevision = 0;
  readonly #wmoSync = new WeakMap<WmoModel, { seeded: number; learned: number }>();
  /** 24.10 (7.50): the gateway's lamp tables that arrived, per WMO path; and the paths still asked for. */
  readonly #tables = new Map<string, WmoLampTable>();
  #tableWanted: { key: string; name: string }[] = [];
  readonly #tableWantedKeys = new Set<string>();
  #tableCursor = 0;
  #tableSource: WmoLampTableSource | undefined;
  /** 25.10 (7.50): the gateway's lit-model index once it arrived (`LitModelIndexClient`), and its source. */
  #litIndex: ReadonlySet<string> | undefined;
  #litSource: LitModelIndexSource | undefined;
  readonly #store: PersistentAssetStore | null | undefined;
  #persisted: { origin: string; generation: string } | undefined;
  #loading: Promise<void> | undefined;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Templates derived from model data this session, and how many came from the persistent record. */
  readonly stats = { derived: 0, loaded: 0, asked: 0, lampTables: 0, litModels: 0 };

  /** `store`: undefined uses the realm's (`persistentAssetStore`), null keeps nothing. */
  constructor(store?: PersistentAssetStore | null) {
    this.#store = store;
  }

  /** Grows whenever a model with lights becomes known: a list built before may miss its placements. */
  get generation(): number {
    return this.#generation;
  }

  /** Grows when a name past no gate turns out to light: candidate lists built before missed it. */
  get candidateGeneration(): number {
    return this.#candidateGeneration;
  }

  /** The model's templates (empty: it gives no light), or undefined while unknown. */
  templates(name: string): readonly LightTemplate[] | undefined {
    return this.#known.get(catalogKey(name));
  }

  /**
   * Whether a placement of `name` may light: past the name gate, known to light, or (25.10, 7.50) named by
   * the gateway's lit-model index.
   */
  candidate(name: string): boolean {
    let answer = this.#candidate.get(name);
    if (answer === undefined) {
      answer = fixtureNameCandidate(name) || (this.templates(name)?.length ?? 0) > 0
        || this.#litIndex?.has(pathKey(name)) === true;
      this.#candidate.set(name, answer);
    }
    return answer;
  }

  /** Asks for an unknown candidate's model; `distance` (yards to the nearest placement) orders the asks. */
  want(name: string, distance: number): void {
    if (this.#pendingNames.has(name) || this.#known.has(catalogKey(name))) return;
    this.#pendingNames.add(name);
    let at = this.#pending.length;
    while (at > 0 && this.#pending[at - 1]!.distance > distance) at--;
    this.#pending.splice(at, 0, { name, distance });
  }

  /** Names still waited for. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /**
   * Polls up to `LIGHT_MODEL_POLL` wanted models, nearest first; derives the templates of those that
   * arrived. A model the client cannot give (absent, a hull, a building) lights nothing.
   */
  pump(models: LightModelSource | undefined, tables?: WmoLampTableSource, lit?: LitModelIndexSource): void {
    this.#attach();
    if (tables) this.#pumpTables(tables); // 24.10 (7.50)
    if (lit) this.#pumpLit(lit); // 25.10 (7.50)
    if (!models || this.#pending.length === 0) return;
    let polled = 0;
    if (this.#cursor >= this.#pending.length) this.#cursor = 0;
    while (polled < LIGHT_MODEL_POLL && this.#cursor < this.#pending.length) {
      const entry = this.#pending[this.#cursor]!;
      let done = this.#known.has(catalogKey(entry.name));
      const model = done ? undefined
        : models.model(entry.name, entry.distance <= LIGHT_MODEL_NEAR ? "normal" : "background");
      if (!done) {
        polled++;
        this.stats.asked++;
      }
      if (done) {
        // Learned meanwhile (`noteLit`, the persistent record).
      } else if (model?.wvm) {
        this.#learn(entry.name, model.wvm);
        done = true;
      } else if (model) {
        this.#set(entry.name, EMPTY);
        done = true;
      } else {
        const state = models.modelState(entry.name);
        if (state !== "pending") {
          this.#set(entry.name, EMPTY, false);
          done = true;
        }
      }
      if (done) {
        this.#pending.splice(this.#cursor, 1);
        this.#pendingNames.delete(entry.name);
      } else this.#cursor++;
    }
  }

  /**
   * 24.10 (7.50): asks for a building's lamp table (the next `pump` with a table source sends the request).
   * Called for every building of a new placement snapshot; a path asked or answered already costs two lookups.
   */
  wantLampTable(name: string): void {
    const key = pathKey(name);
    if (this.#tables.has(key) || this.#tableWantedKeys.has(key) || this.#tableSource?.settled(key) === true) return;
    this.#tableWantedKeys.add(key);
    this.#tableWanted.push({ key, name });
  }

  /** 24.10 (7.50): whether a building's lamp table is still on its first way here (the loading curtain waits). */
  lampTablePending(name: string): boolean {
    const source = this.#tableSource;
    if (!source) return false;
    const key = pathKey(name);
    return !this.#tables.has(key) && source.lookup(key, name) === LAMP_TABLE_PENDING;
  }

  /**
   * 25.10 (7.50): takes the lit-model index once it arrives: every name is read again as a candidate, so a
   * snapshot's placements of those models are wanted (`PrelitLights.update`). One lookup a frame until then.
   */
  #pumpLit(source: LitModelIndexSource): void {
    this.#litSource = source;
    if (this.#litIndex) return;
    const answer = source.lookup();
    if (typeof answer !== "object") return;
    this.#litIndex = answer;
    this.stats.litModels = answer.size;
    this.#candidate.clear();
    this.#candidateGeneration++;
  }

  /** 25.10 (7.50): whether the lit-model index is still on its first way here (the loading curtain waits). */
  get litIndexPending(): boolean {
    const source = this.#litSource;
    return source !== undefined && this.#litIndex === undefined && source.lookup() === LIT_INDEX_PENDING;
  }

  /** 24.10 (7.50): the lamp table that arrived for a WMO path (tests, the bench). */
  lampTable(name: string): WmoLampTable | undefined {
    return this.#tables.get(pathKey(name));
  }

  /** Polls up to `LIGHT_MODEL_POLL` wanted lamp tables; a table that arrived is seeded by `syncWmo`. */
  #pumpTables(source: WmoLampTableSource): void {
    this.#tableSource = source;
    const wanted = this.#tableWanted;
    if (wanted.length === 0) return;
    let polled = 0;
    if (this.#tableCursor >= wanted.length) this.#tableCursor = 0;
    while (polled < LIGHT_MODEL_POLL && this.#tableCursor < wanted.length) {
      const entry = wanted[this.#tableCursor]!;
      polled++;
      const answer = source.lookup(entry.key, entry.name);
      let done = source.settled(entry.key);
      if (typeof answer === "object") {
        this.#tables.set(entry.key, answer);
        this.#lanternRevision++;
        this.stats.lampTables++;
        done = true;
      }
      if (done) {
        wanted.splice(this.#tableCursor, 1);
        this.#tableWantedKeys.delete(entry.key);
      } else this.#tableCursor++;
    }
  }

  /** A built placement's model gave fixture lights: learns it if it was not known (a name past no gate). */
  noteLit(name: string, model: WvmModel): void {
    if (this.#known.has(catalogKey(name))) return;
    this.#learn(name, model);
  }

  /** Derives a model's templates now (tests; `pump` and `noteLit` call it). */
  learn(name: string, model: WvmModel): readonly LightTemplate[] {
    return this.#learn(name, model);
  }

  #learn(name: string, model: WvmModel): readonly LightTemplate[] {
    const known = this.#known.get(catalogKey(name));
    if (known) return known;
    const templates = deriveLightTemplates(model, name);
    this.stats.derived++;
    this.#set(name, templates.length > 0 ? Object.freeze(templates) : EMPTY);
    return this.#known.get(catalogKey(name))!;
  }

  #set(name: string, templates: readonly LightTemplate[], persist = true): void {
    const key = catalogKey(name);
    if (this.#known.has(key)) return;
    this.#known.set(key, templates);
    if (templates.length > 0) {
      this.#generation++;
      if (this.#candidate.get(name) === false) {
        this.#candidate.set(name, true);
        this.#candidateGeneration++;
      }
    }
    if (persist) this.#scheduleSave();
  }

  /**
   * 24.10 (7.50): a resident building's lamp posts: seeds the groups an earlier session read
   * (`seedWmoLanterns`) and keeps the groups this one reads. Cheap when nothing changed.
   */
  syncWmo(name: string, model: WmoModel): void {
    let state = this.#wmoSync.get(model);
    if (!state) {
      state = { seeded: -1, learned: -1 };
      this.#wmoSync.set(model, state);
    }
    const key = pathKey(name);
    if (state.seeded !== this.#lanternRevision) {
      state.seeded = this.#lanternRevision;
      // 24.10 (7.50): the gateway's table first — every open-air group — when it is this model's.
      const table = this.#tables.get(key);
      if (table && table.groupCount === model.groups.length) seedWmoLanterns(model, table.groups);
      const known = this.#lanterns.get(key);
      if (known) seedWmoLanterns(model, known);
    }
    const read = wmoLanternGroups(model);
    if (!read || read.readRevision === state.learned) return;
    state.learned = read.readRevision;
    let groups = this.#lanterns.get(key);
    let added = false;
    for (const [index, positions] of read.read) {
      if (groups?.has(index)) continue;
      (groups ??= new Map()).set(index, Array.from(positions));
      added = true;
    }
    if (groups && added) {
      this.#lanterns.set(key, groups);
      this.#scheduleSave();
    }
  }

  /** 24.10 (7.50): the groups of a WMO path known to hold lanterns or none (tests). */
  lanternGroups(name: string): ReadonlyMap<number, readonly number[]> | undefined {
    return this.#lanterns.get(pathKey(name));
  }

  /** Reads the persistent record once the gateway's visual generation is known. */
  #attach(): void {
    if (this.#loading || this.#persisted) return;
    const store = this.#store === undefined ? persistentAssetStore() : this.#store;
    const override = lightCatalogGenerationOverride();
    const origin = override?.origin ?? gatewayGenerationOrigin();
    const generation = override?.generation ?? gatewayVisualGeneration();
    if (!store || origin === undefined || generation === undefined) return;
    this.#loading = store.get<unknown>("rows", origin, LIGHT_TEMPLATE_KIND, generation, "all")
      .then((value) => {
        this.#persisted = { origin, generation };
        const record = value as { models?: unknown; lanterns?: unknown } | undefined;
        if (!record || typeof record !== "object") return;
        this.#loadLanterns(record.lanterns);
        if (!Array.isArray(record.models)) return;
        for (const entry of record.models) {
          if (!Array.isArray(entry) || typeof entry[0] !== "string" || !validLightTemplates(entry[1])) continue;
          const [key, templates] = entry as [string, LightTemplate[]];
          if (this.#known.has(key)) continue;
          this.#known.set(key, templates.length > 0 ? Object.freeze(templates) : EMPTY);
          this.stats.loaded++;
          if (templates.length > 0) this.#generation++;
        }
        // Names asked before the record came in may be answered by it now; candidates are re-read.
        this.#candidate.clear();
        this.#candidateGeneration++;
        this.#pending = this.#pending.filter((entry) => !this.#known.has(catalogKey(entry.name)));
        this.#pendingNames.clear();
        for (const entry of this.#pending) this.#pendingNames.add(entry.name);
      })
      .catch(() => { this.#persisted = { origin, generation }; });
  }

  #loadLanterns(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
      const groups = this.#lanterns.get(entry[0]) ?? new Map<number, readonly number[]>();
      for (const group of entry[1] as unknown[]) {
        if (!Array.isArray(group) || !Number.isInteger(group[0]) || !Array.isArray(group[1])) continue;
        const positions = group[1] as unknown[];
        if (positions.length % 3 !== 0 || !positions.every((number) => typeof number === "number" && Number.isFinite(number))) continue;
        if (!groups.has(group[0] as number)) groups.set(group[0] as number, positions as number[]);
      }
      if (groups.size > 0) this.#lanterns.set(entry[0], groups);
    }
    this.#lanternRevision++;
  }

  /** Resolves when the persistent record has been read (tests). */
  async loaded(): Promise<void> {
    this.#attach();
    await this.#loading;
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
  }

  /** Writes every known model now (tests, page hide); a no-op before the record was read. */
  save(): void {
    const persisted = this.#persisted;
    const store = this.#store === undefined ? persistentAssetStore() : this.#store;
    if (!persisted || !store) return;
    const models: [string, readonly LightTemplate[]][] = [];
    for (const [key, templates] of this.#known) {
      // Models that light, and lamp-named ones that do not (so they are not asked for again).
      if (templates.length > 0 || fixtureNameCandidate(key.slice(key.indexOf("|") + 1))) models.push([key, templates]);
      if (models.length >= LIGHT_TEMPLATE_STORED_LIMIT) break;
    }
    const lanterns: [string, [number, readonly number[]][]][] = [];
    let numbers = 0;
    for (const [key, groups] of this.#lanterns) {
      const kept: [number, readonly number[]][] = [];
      for (const [index, positions] of groups) {
        if (numbers + positions.length > LIGHT_LANTERN_STORED_LIMIT) break;
        numbers += positions.length;
        kept.push([index, positions.map((value) => Math.round(value * 100) / 100)]);
      }
      lanterns.push([key, kept]);
    }
    store.put("rows", persisted.origin, LIGHT_TEMPLATE_KIND, persisted.generation, [["all", { models, lanterns }]]);
  }
}
