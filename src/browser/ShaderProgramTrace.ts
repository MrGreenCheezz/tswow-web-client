/** JavaScript-only shader attribution, enabled exclusively during an explicit performance capture. */
interface ProgramIdentity { readonly id: number; }
interface ProgramDetails extends ProgramIdentity { readonly type?: string; readonly cacheKey?: string; }

export type ShaderProgramPhase = "existing" | "prepare" | "warm" | "sky" | "world" | "overlay" | "postprocess" | "portraits" | "overflow";
export interface ShaderProgramEvent {
  readonly at: number;
  readonly phase: ShaderProgramPhase;
  readonly added: number;
  readonly omitted: number;
  readonly diagnosticMs: number;
  readonly programs: readonly {
    readonly id: number;
    readonly type: string;
    readonly keyHash: string;
    readonly keyFields: readonly string[];
  }[];
}

const PROGRAM_LIMIT = 32;
const EVENT_LIMIT = 8;
const EMPTY_EVENTS: readonly ShaderProgramEvent[] = [];
const SAFE_TYPES = new Set(["MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial",
  "MeshStandardMaterial", "MeshPhysicalMaterial", "MeshDepthMaterial", "MeshDistanceMaterial",
  "MeshNormalMaterial", "MeshMatcapMaterial", "ShaderMaterial", "RawShaderMaterial",
  "PointsMaterial", "LineBasicMaterial", "LineDashedMaterial", "SpriteMaterial", "ShadowMaterial"]);
const SAFE_FIELDS = new Set(["basic", "lambert", "phong", "standard", "physical", "matcap",
  "points", "linedashed", "depth", "normal", "sprite", "background", "cube", "equirect",
  "distanceRGBA", "shadow", "highp", "mediump", "lowp", "srgb", "srgb-linear",
  "true", "false", "undefined", "null"]);

/** Diagnostic identity, not a security hash; no source code, material names or resource URLs leave it. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class ShaderProgramTrace {
  #lastId = -1;
  #pending: ShaderProgramEvent[] = [];
  #overflow = 0;
  #overflowAt = 0;

  constructor(programs: readonly ProgramIdentity[] | null | undefined, at: number) {
    this.mark("existing", programs, at);
  }

  mark(phase: ShaderProgramPhase, programs: readonly ProgramIdentity[] | null | undefined, at: number): void {
    if (!programs) return;
    const started = performance.now();
    const previousId = this.#lastId;
    const described: ShaderProgramEvent["programs"][number][] = [];
    let added = 0;
    for (const identity of programs) {
      // Three r185 program ids are monotonic; array indices change when old programs are freed.
      if (identity.id <= previousId) continue;
      this.#lastId = Math.max(this.#lastId, identity.id);
      added++;
      if (described.length >= PROGRAM_LIMIT || this.#pending.length >= EVENT_LIMIT) continue;
      const program = identity as ProgramDetails;
      const key = program.cacheKey ?? "";
      described.push({ id: program.id, type: SAFE_TYPES.has(program.type ?? "") ? program.type! : "other",
        keyHash: fingerprint(key),
        // Built-in switches remain readable; custom keys/defines and shader text are fingerprinted.
        keyFields: key.split(",", 64).map(field => SAFE_FIELDS.has(field) || /^-?\d{1,10}(?:\.\d{1,6})?$/.test(field)
          ? field : "#" + fingerprint(field)),
      });
    }
    if (added > 0 && this.#pending.length < EVENT_LIMIT) this.#pending.push({
      at, phase, added, omitted: added - described.length, programs: described,
      diagnosticMs: performance.now() - started,
    });
    else if (added > 0) {
      this.#overflow += added;
      this.#overflowAt = at;
    }
  }

  drain(): readonly ShaderProgramEvent[] {
    if (this.#pending.length === 0) return EMPTY_EVENTS;
    const events = this.#pending;
    this.#pending = [];
    if (this.#overflow > 0) {
      events.push({ at: this.#overflowAt, phase: "overflow", added: this.#overflow,
        omitted: this.#overflow, diagnosticMs: 0, programs: [] });
      this.#overflow = 0;
    }
    return events;
  }
}
