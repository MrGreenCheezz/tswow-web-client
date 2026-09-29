/**
 * The stock threat C API over this client's threat tables (ThreatProtocol.ts).
 *
 * What stock reads, measured in the 3.3.5 corpus:
 *
 * * `UnitFrame_UpdateThreatIndicator` (UnitFrame.lua:424-478) is the only consumer. TargetFrame and
 *   FocusFrame hand it `feedbackUnit = "player"` and `unit = "target"`/`"focus"`, so the calls are
 *   `UnitThreatSituation("player", "target")`, `IsThreatWarningEnabled()` and — only when the
 *   `threatShowNumeric` CVar is "1" — `UnitDetailedThreatSituation("player", "target")`. It runs
 *   from TargetFrame_OnUpdate every half second (TargetFrame.lua:335) and on
 *   `UNIT_THREAT_SITUATION_UPDATE`, whose argument it compares with the feedback unit (:428).
 * * The one-argument form `UnitThreatSituation(unit)` is the unit's standing against whichever
 *   creature it stands worst with; a unit on nobody's list answers nil, which is the corpus' own
 *   hidden branch (`status and status > 0`).
 * * The status numbers are the client's: 0 not tanking and below the tank, 1 not tanking but at or
 *   above the tank's threat, 2 tanking while someone else holds more threat, 3 tanking with the most.
 *   The tank is the creature's victim (`SMSG_HIGHEST_THREAT_UPDATE`), else its top raw entry.
 * * `UnitDetailedThreatSituation` returns isTanking, status, scaledPercent, rawPercent, threatValue.
 *   rawPercent is the unit's threat as a share of the tank's; scaledPercent divides it by the pull
 *   threshold the core applies before switching victims — 110% in melee reach, 130% beyond it
 *   (ThreatManager's melee/ranged rule; reach as `Unit::IsWithinMeleeRange`: both combat reaches
 *   plus 4/3 yard). threatValue is the wire number, hundredths of the server's threat, exactly as
 *   `ThreatManager::SendThreatListToClients` writes it.
 * * `IsThreatWarningEnabled()` is the `threatWarning` CVar (InterfaceOptionsPanels.lua:690, four
 *   OPTION_TOOLTIP_AGGRO_WARNING_DISPLAY rows): 0 never, 1 only in a dungeon or raid instance, 2 only
 *   in a group, 3 always. The client default is 3. The CVar lives in the neutral API's Lua map, so
 *   FRAMEXML_THREAT_PRELUDE reads it there and passes the mode to the host binding.
 *
 * Events: `UNIT_THREAT_LIST_UPDATE(mobUnit)` for every unit token that resolves to the creature
 * whose list moved, and `UNIT_THREAT_SITUATION_UPDATE(unit)` for every unit token on that list —
 * before or after the change, so a removal reaches the frame that was showing the glow.
 */
import type { ThreatUpdate } from "../../world/ThreatProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { unit as unitField } from "../../world/Fields.js";

export const FRAMEXML_THREAT_EVENTS = Object.freeze({
  situation: "UNIT_THREAT_SITUATION_UPDATE",
  list: "UNIT_THREAT_LIST_UPDATE",
});

/** The world facts the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlThreatWorld {
  readonly events?: {
    on(name: "THREAT_CHANGED", listener: (change: { readonly guid: bigint }) => void): () => void;
  } | undefined;
  /**
   * The world's threat tables. Optional: a seam double that models no combat (the arena and
   * pet-frame fixtures) has none, and stock `UnitFrame_Update` still asks `UnitThreatSituation`
   * for every unit frame it draws — an answer of «not on any list» there, never a throw that
   * aborts the frame's OnLoad.
   */
  readonly threat?: {
    get(guid: bigint): ThreatUpdate | undefined;
    tables(): Iterable<ThreatUpdate>;
  } | undefined;
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects?: { get(guid: bigint): WorldObjectState | undefined } | undefined;
  };
}

export interface FrameXmlThreatContext {
  world(): FrameXmlThreatWorld | undefined;
  /** The seam's unit token resolution (`"player"`, `"target"`, `"party2"`, …). */
  unitGuid(unit: string): bigint | undefined;
  /** `threatWarning` mode 1: the player stands in a dungeon or raid instance. */
  inInstance(): boolean;
  /** Mode 2: the player is in a party or a raid. */
  inGroup(): boolean;
}

interface FrameXmlThreatPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export type FrameXmlThreatStatus = 0 | 1 | 2 | 3;

export interface FrameXmlDetailedThreat {
  readonly isTanking: boolean;
  readonly status: FrameXmlThreatStatus;
  readonly scaledPercent: number;
  readonly rawPercent: number;
  readonly threatValue: number;
}

/** `threatWarning` as the client ships it: «Всегда показывать». */
export const FRAMEXML_THREAT_WARNING_DEFAULT = 3;

/** Tokens a creature with a threat list can be addressed by, for UNIT_THREAT_LIST_UPDATE. */
const CREATURE_TOKENS: readonly string[] = Object.freeze([
  "target", "focus", "targettarget", "mouseover", "pet", "vehicle",
  "party1", "party2", "party3", "party4", "partypet1", "partypet2", "partypet3", "partypet4",
  "arena1", "arena2", "arena3", "arena4", "arena5",
]);

/** Tokens a unit on a threat list can be addressed by, for UNIT_THREAT_SITUATION_UPDATE. */
const UNIT_TOKENS: readonly string[] = Object.freeze([
  "player", "pet", "target", "focus", "mouseover",
  "party1", "party2", "party3", "party4", "partypet1", "partypet2", "partypet3", "partypet4",
]);

/** ThreatManager's victim-switch thresholds, in percent of the current victim's threat. */
const MELEE_PULL_PERCENT = 110;
const RANGED_PULL_PERCENT = 130;
/** `Unit::IsWithinMeleeRange`: the two combat reaches plus this many yards. */
const MELEE_RANGE_BONUS = 4 / 3;

interface Standing {
  readonly tanking: boolean;
  readonly status: FrameXmlThreatStatus;
  readonly mine: number;
  readonly tankThreat: number;
}

/** The unit's standing on one creature's list, or undefined when it is not on it. */
function standing(table: ThreatUpdate, unitGuid: bigint): Standing | undefined {
  const entries = table.entries;
  if (entries.length === 0) return undefined;
  const own = entries.find((entry) => entry.guid === unitGuid);
  if (own === undefined) return undefined;
  let top = entries[0]!;
  for (const entry of entries) if (entry.threat > top.threat) top = entry;
  const victim = table.highestGuid === undefined ? undefined : entries.find((entry) => entry.guid === table.highestGuid);
  const tank = victim ?? top;
  const tanking = tank.guid === unitGuid;
  const status: FrameXmlThreatStatus = tanking
    ? (own.threat >= top.threat ? 3 : 2)
    : (own.threat > 0 && own.threat >= tank.threat ? 1 : 0);
  return { tanking, status, mine: own.threat, tankThreat: tank.threat };
}

function withinMeleeRange(unit: WorldObjectState | undefined, creature: WorldObjectState | undefined): boolean {
  const from = unit?.position;
  const to = creature?.position;
  // Without both positions the tighter threshold is the answer, as for a unit standing next to it.
  if (!from || !to) return true;
  const reach = (unitField.combatReach(unit) ?? 0) + (unitField.combatReach(creature) ?? 0) + MELEE_RANGE_BONUS;
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const dz = from.z - to.z;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}

export class FrameXmlThreatModel {
  readonly #context: FrameXmlThreatContext;
  #pump: FrameXmlThreatPump | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Who was on each creature's list when it was last announced, so a removal still reaches its frame. */
  readonly #members = new Map<bigint, ReadonlySet<bigint>>();

  constructor(context: FrameXmlThreatContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlThreatPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("THREAT_CHANGED", ({ guid }) => this.#changed(guid));
    }
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#members.clear();
  }

  /** `UnitThreatSituation(unit[, mobUnit])`. */
  situation(unit: string, mobUnit?: string): FrameXmlThreatStatus | undefined {
    const world = this.#context.world();
    const unitGuid = this.#context.unitGuid(unit);
    if (!world || unitGuid === undefined || unitGuid === 0n) return undefined;
    if (mobUnit !== undefined && mobUnit !== "") {
      const mobGuid = this.#context.unitGuid(mobUnit);
      const table = mobGuid === undefined ? undefined : world.threat?.get(mobGuid);
      return table ? standing(table, unitGuid)?.status : undefined;
    }
    let worst: FrameXmlThreatStatus | undefined;
    for (const table of world.threat?.tables() ?? []) {
      const status = standing(table, unitGuid)?.status;
      if (status !== undefined && (worst === undefined || status > worst)) worst = status;
    }
    return worst;
  }

  /** `UnitDetailedThreatSituation(unit, mobUnit)`. */
  detailed(unit: string, mobUnit: string): FrameXmlDetailedThreat | undefined {
    const world = this.#context.world();
    const unitGuid = this.#context.unitGuid(unit);
    const mobGuid = this.#context.unitGuid(mobUnit);
    if (!world || unitGuid === undefined || unitGuid === 0n || mobGuid === undefined) return undefined;
    const table = world.threat?.get(mobGuid);
    const own = table ? standing(table, unitGuid) : undefined;
    if (!own) return undefined;
    const rawPercent = own.tanking ? 100
      : own.tankThreat > 0 ? own.mine / own.tankThreat * 100 : (own.mine > 0 ? 100 : 0);
    const objects = world.state.objects;
    const melee = withinMeleeRange(objects?.get(unitGuid), objects?.get(mobGuid));
    const scaledPercent = own.tanking ? 100 : rawPercent * 100 / (melee ? MELEE_PULL_PERCENT : RANGED_PULL_PERCENT);
    return { isTanking: own.tanking, status: own.status, scaledPercent, rawPercent, threatValue: own.mine };
  }

  /** `IsThreatWarningEnabled()` for the `threatWarning` mode the Lua CVar map holds. */
  warningEnabled(mode: number | undefined): boolean {
    const resolved = mode === undefined || !Number.isFinite(mode) ? FRAMEXML_THREAT_WARNING_DEFAULT : Math.trunc(mode);
    if (resolved <= 0) return false;
    if (resolved === 1) return this.#context.inInstance();
    if (resolved === 2) return this.#context.inGroup();
    return true;
  }

  #changed(guid: bigint): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    const table = world.threat?.get(guid);
    const now = new Set<bigint>(table?.entries.map((entry) => entry.guid) ?? []);
    const before = this.#members.get(guid);
    if (table) this.#members.set(guid, now);
    else this.#members.delete(guid);
    for (const token of CREATURE_TOKENS) {
      if (this.#context.unitGuid(token) === guid) pump.fire(FRAMEXML_THREAT_EVENTS.list, token);
    }
    for (const token of UNIT_TOKENS) {
      const unitGuid = this.#context.unitGuid(token);
      if (unitGuid === undefined) continue;
      if (now.has(unitGuid) || before?.has(unitGuid)) pump.fire(FRAMEXML_THREAT_EVENTS.situation, token);
    }
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlThreatHost {
  readonly threat?: FrameXmlThreatModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function unitOf(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** The CVar string the prelude passes, or nil when the map has no `threatWarning`. */
function modeOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const mode = Number(value);
  return Number.isFinite(mode) ? mode : undefined;
}

export const FRAMEXML_THREAT_BINDINGS: Readonly<Record<string,
  (host: FrameXmlThreatHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  UnitThreatSituation: (host, args) => {
    const mob = args[1] === undefined || args[1] === null ? undefined : unitOf(args[1]);
    const status = host.threat?.situation(unitOf(args[0]), mob);
    return status === undefined ? NOTHING : [status];
  },
  UnitDetailedThreatSituation: (host, args) => {
    const detailed = host.threat?.detailed(unitOf(args[0]), unitOf(args[1]));
    return detailed === undefined ? NOTHING
      : [detailed.isTanking, detailed.status, detailed.scaledPercent, detailed.rawPercent, detailed.threatValue];
  },
  IsThreatWarningEnabled: (host, args) => [host.threat?.warningEnabled(modeOf(args[0])) ?? false],
  // UnitFrame.lua:439/:450 tint the glow and the numeric badge with it; unanswered, SetVertexColor
  // raised on nil the first time a status showed. The client's own four colours (grey, yellow,
  // orange, red), which is also what every threat add-on reads back from it.
  GetThreatStatusColor: (_host, args) => {
    const status = Number(args[0]);
    return FRAMEXML_THREAT_STATUS_COLORS[Number.isFinite(status) ? Math.trunc(status) : -1] ?? NOTHING;
  },
});

/** `GetThreatStatusColor(status)`: the 3.3.5 client's r, g, b per status, 0 to 3. */
export const FRAMEXML_THREAT_STATUS_COLORS: Readonly<Record<number, readonly [number, number, number]>> = Object.freeze({
  0: [0.69, 0.69, 0.69],
  1: [1, 1, 0.47],
  2: [1, 0.6, 0],
  3: [1, 0, 0],
});

/**
 * Stock calls `IsThreatWarningEnabled()` with no argument; the mode is the `threatWarning` CVar,
 * which lives in the neutral API's Lua map (FrameXmlNeutralApi.ts) behind the composed `GetCVar`.
 * Looked up at call time, so the options dropdown's SetCVar is honoured on the next half-second poll.
 */
export const FRAMEXML_THREAT_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local enabled = rawget(_G, "__fxSeam_IsThreatWarningEnabled")
  if impl ~= nil and enabled ~= nil then
    impl.IsThreatWarningEnabled = function()
      local getCVar = impl.GetCVar
      local mode = nil
      if getCVar ~= nil then mode = getCVar("threatWarning") end
      return enabled(mode)
    end
  end
end
`;
