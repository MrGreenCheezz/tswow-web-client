// Why a unit is still a capsule, counted rather than guessed at.
//
// A unit that never becomes its model is the single most reported render fault in this client, and
// every report of it so far has named the symptom — "there is a green pill where the innkeeper
// should be". The reason decides whether the next step is a retry, a fallback, a gateway fix
// or waiting for the next frame's construction budget.
//
// Three of the five used to be permanent after a single failure, and that is what made the ledger's
// first reading so useful — it said which. Т6 made all three recoverable: the appearance fetch and
// each layer's picture are asked for again on a backoff, and a look that paints nothing is
// remembered rather than rebuilt sixty times a second. So a count that falls between two frames is
// now a retry landing, and a count that will not fall is a fact about the client's own files.
//
// The reasons answer "why", and {@link StandInWearing} answers "instead of what": a pill, or
// the model this unit wore before the display id moved. The second column was added by П1 because
// the ledger was silent on the one fault it had been built to name — see the type's own comment.
//
// It is deliberately free of three.js and of the DOM: the renderer fills it, the diagnostics
// window prints it, and a test drives it directly.

/**
 * Why a unit stays a stand-in, in the order they are reached.
 *
 * * `display` — `UNIT_FIELD_DISPLAYID` has no answer yet from `/dbc/creature-models`, or is zero.
 * * `appearance` — the display answered, but `/dbc/character-appearance` has not, so the look of
 *   this particular player is unknown. Asked for again 2 s, 8 s and 30 s later, then left alone.
 * * `artifact` — the WVM the display names has not downloaded, or the client does not ship it.
 * * `atlas` — the body texture is still being painted, or painted to nothing; a layer whose picture
 *   failed transiently is asked for again on the same backoff, and a look whose every layer is
 *   settled is remembered as unpaintable rather than rebuilt.
 * * `queued` — resources are ready; construction waits for a later frame's build slice.
 * * `template` — the rig produced no skinned template, which is cached as `null`. Permanent, and
 *   correctly so: the two ways to get one are a rig with no bones and a rig whose sequences all
 *   fail to build, and neither changes when anything else arrives — a rig whose whole animation set
 *   was merely held back has counted as a rig since `buildSkinnedTemplateFrom` was taught to say so.
 */
export type StandInReason = "display" | "appearance" | "artifact" | "atlas" | "template" | "queued";

/**
 * What the unit is standing in while the reason lasts.
 *
 * `capsule` is the green pill this file is named for. `model` is the same reasons met by a
 * unit that already has a model on: the display id moved, the new record has not come back, and
 * the player is looking at the shape their character was a moment ago. That case never reached
 * this ledger — the renderer only wrote a reason down when the capsule mesh was still there, and
 * `#clearUnitNode` drops that mesh the first time a real model goes in — so the single most
 * reported shapeshift fault produced a report reading «капсул: ни одной».
 *
 * Counted apart rather than folded in, because «капсул: 4» has to keep meaning four pills.
 */
export type StandInWearing = "capsule" | "model";

/** In report order, which is the order a unit meets them. */
export const STAND_IN_REASONS: readonly StandInReason[] = ["display", "appearance", "artifact", "atlas", "template", "queued"];

/** What each reason is called in the diagnostics window. */
export const STAND_IN_REASON_LABELS: Readonly<Record<StandInReason, string>> = {
  display: "display id без ответа",
  appearance: "внешность не вернулась",
  artifact: "модель не пришла",
  atlas: "атлас тела не собран",
  template: "скелет не собрался",
  queued: "ожидает сборки",
};

export interface StandInSample {
  guid: bigint;
  displayId: number;
  reason: StandInReason;
  /** The model the display named, when the display got that far. */
  model?: string;
  /** A pill, or the look this unit has already left. */
  wearing: StandInWearing;
}

export interface StandInReport {
  total: number;
  byReason: Record<StandInReason, number>;
  /**
   * Units wearing a model they should have changed out of, for the same reasons.
   *
   * Not part of `total`: they are not capsules, nothing about them looks broken, and that is
   * exactly why they need a counter. A druid whose bear record never arrived stands there as a
   * night elf and the frame is otherwise perfect.
   */
  stale: number;
  samples: StandInSample[];
  /**
   * Whether the frame this report describes walked the units at all.
   *
   * `draw()` returns before the walk on every frame with no self object or no position yet — world
   * enter, a teleport, a loading screen — and those are exactly the moments somebody opens the
   * window to ask why everything is a pill. Without this the window would print the last drawn
   * frame's totals as if they were now.
   */
  walked: boolean;
}

/** How many samples a report carries. Enough to name a wave, short enough to read. */
export const STAND_IN_SAMPLE_LIMIT = 8;

/**
 * How many of those places each column keeps for itself.
 *
 * The limit is shared and the fill order is the unit walk's, so a frame that meets its stale
 * models first used to fill all eight with them and leave the pills nameless. Reproduced against
 * the built `dist`: eight `note(…, "display", undefined, "model")` on eight display ids, then one
 * `note(99n, 21935, "artifact", …, "capsule")`, printed «Капсул: 1 · модель не пришла 1 · в
 * прежней модели: 8» over eight sample rows of which **none** was the capsule — 21935 being the
 * one display id the reader opened the window for. Half the places are now held for each column,
 * and either takes the other's unused ones, so a frame of nothing but pills still names eight.
 */
export const STAND_IN_SAMPLE_RESERVE = STAND_IN_SAMPLE_LIMIT / 2;

/**
 * One frame's worth of stand-ins.
 *
 * Filled by the renderer as it walks the units it is drawing, and cleared at the start of every
 * such walk — the question is always "what is a capsule *now*", never "what has ever been one".
 */
export class StandInLedger {
  readonly #counts = new Map<StandInReason, number>();
  /**
   * Samples keyed on reason and display id rather than on guid, one map per column.
   *
   * Forty murlocs whose model did not download are one fact about one display id, not forty facts;
   * keyed on the guid the list would fill up with the same line and hide the one other display
   * that is also broken. Two maps rather than one because the columns answer different questions
   * and must not crowd each other out — see {@link STAND_IN_SAMPLE_RESERVE}.
   */
  readonly #capsuleSamples = new Map<string, StandInSample>();
  readonly #staleSamples = new Map<string, StandInSample>();
  #total = 0;
  #stale = 0;
  #walked = false;

  /** Starts a frame that walks the units. */
  begin(): void {
    this.#clear();
    this.#walked = true;
  }

  /**
   * Starts a frame that will not reach the units.
   *
   * A frame that returns early leaves no capsules behind it; leaving the previous frame's numbers
   * in place made the window answer a question about a frame nobody was looking at.
   */
  idle(): void {
    this.#clear();
    this.#walked = false;
  }

  #clear(): void {
    this.#counts.clear();
    this.#capsuleSamples.clear();
    this.#staleSamples.clear();
    this.#total = 0;
    this.#stale = 0;
  }

  note(guid: bigint, displayId: number, reason: StandInReason, model?: string,
    wearing: StandInWearing = "capsule"): void {
    if (wearing === "capsule") {
      this.#total++;
      this.#counts.set(reason, (this.#counts.get(reason) ?? 0) + 1);
    } else {
      this.#stale++;
    }
    // What the unit is wearing decides which list it lands in, and it is part of the key inside
    // that list too: the same display failing the same way is one fact for the pills and a
    // different one for the units still dressed as somebody else.
    const mine = wearing === "capsule" ? this.#capsuleSamples : this.#staleSamples;
    const other = wearing === "capsule" ? this.#staleSamples : this.#capsuleSamples;
    const key = `${wearing}/${reason}/${displayId}`;
    if (mine.has(key)) return;
    if (mine.size + other.size >= STAND_IN_SAMPLE_LIMIT) {
      // The window is full. This column may still take a place back, but only up to its own half
      // and only from a column that is over its own — the last one that column took, because the
      // first samples of a wave are the ones worth keeping.
      if (mine.size >= STAND_IN_SAMPLE_RESERVE || other.size <= STAND_IN_SAMPLE_RESERVE) return;
      const keys = [...other.keys()];
      other.delete(keys[keys.length - 1]!);
    }
    mine.set(key, { guid, displayId, reason, ...(model ? { model } : {}), wearing });
  }

  report(): StandInReport {
    const byReason = {} as Record<StandInReason, number>;
    for (const reason of STAND_IN_REASONS) byReason[reason] = this.#counts.get(reason) ?? 0;
    return {
      total: this.#total, byReason, stale: this.#stale,
      // Pills first: a unit nobody can identify is worse than a unit identified as the wrong thing.
      samples: [...this.#capsuleSamples.values(), ...this.#staleSamples.values()],
      walked: this.#walked,
    };
  }
}

/**
 * The diagnostics line: how many capsules there are and, if any, why — and, when the report carries
 * it (05.10-A7b-9, 7.18), the environment's line under it.
 */
export function standInSummary(report: StandInReport & { environment?: EnvironmentStandInReport }): string {
  const units = unitStandInSummary(report);
  return report.environment ? `${units}\n${environmentStandInSummary(report.environment)}` : units;
}

/** The capsule line alone. */
export function unitStandInSummary(report: StandInReport): string {
  // Said apart from «none» on purpose: "no capsules" is an answer about the units and this is the
  // absence of the question, which is what the window shows while the world is still loading.
  if (!report.walked) return "Капсулы: кадр до юнитов не дошёл — мир ещё грузится.";
  // A unit in the wrong model is invisible to a count of pills, so it gets said out loud rather
  // than appended: a frame with no capsules and four wrong models is not a healthy frame.
  const stale = report.stale > 0 ? ` · в прежней модели: ${report.stale}` : "";
  if (report.total === 0) {
    return report.stale === 0
      ? "Капсул: ни одной — все юниты в своих моделях."
      : `Капсул: ни одной, но в прежней модели: ${report.stale}.`;
  }
  const parts = STAND_IN_REASONS
    .filter((reason) => report.byReason[reason] > 0)
    .map((reason) => `${STAND_IN_REASON_LABELS[reason]} ${report.byReason[reason]}`);
  return `Капсул: ${report.total} · ${parts.join(" · ")}${stale}`;
}

// ── 05.10-A7b-9 (7.18): the environment's stand-ins ─────────────────────────────────────────────
//
// The unit ledger above counts pills; the world around them was never counted at all, so «no
// stand-ins in a warmed scene» could not be measured for the buildings, trees and props. Before
// this the renderer's `#environmentNode` folded three facts into one look — a model on its way
// (a tree's trunk and canopy, or nothing), a model that came back as the server's collision hull
// (nothing: the building is simply absent) and a model the client does not ship (the same
// nothing). The ledger keeps them apart, per frame, with fixed counters and a short sample list.

/** What `EnvironmentClient.modelState` knows about one model path. */
export type EnvironmentModelState = "resident" | "pending" | "hull" | "missing" | "failed";

/**
 * Why a placement is drawn as a stand-in on this frame.
 *
 * * `pending` — the model is on its way, or has arrived and waits for a later frame's build budget.
 * * `hull` — the gateway had no visual model and served the collision hull; drawn as nothing.
 * * `missing` — the archives do not hold the model (404 on both routes). Permanent for the session.
 * * `failed` — the request failed four times or the payload cannot be decoded. Permanent.
 */
export type EnvironmentStandInReason = "pending" | "hull" | "missing" | "failed";

export const ENVIRONMENT_STAND_IN_REASONS: readonly EnvironmentStandInReason[] = ["pending", "hull", "missing", "failed"];

export const ENVIRONMENT_STAND_IN_REASON_LABELS: Readonly<Record<EnvironmentStandInReason, string>> = {
  pending: "модель в пути",
  hull: "только корпус столкновений",
  missing: "нет в клиенте",
  failed: "не загрузилась",
};

/** One model path standing in on this frame; `count` is how many placements share it. */
export interface EnvironmentStandInSample {
  model: string;
  reason: EnvironmentStandInReason;
  count: number;
}

/** Placements the tiles under the player could not carry (7.19). */
export interface EnvironmentTileLossCounts {
  /** Objects whose fields this client could not read, left out of their tile. */
  rejected: number;
  /** Objects past the tile's object cap, cut on the client. */
  truncated: number;
  /** WMO doodads the generator cut (`X-Tile-Truncated`). */
  generator: number;
}

/** Requests waiting on the retry ladder (1.24): flat ground, noon light or a bare horizon until then. */
export interface EnvironmentRetryCounts {
  splat: number;
  light: number;
  horizon: number;
}

export interface EnvironmentStandInReport {
  total: number;
  byReason: Record<EnvironmentStandInReason, number>;
  /** Stand-ins drawn as a trunk and canopy (1.23 decides which names get one). Part of `total`. */
  canopy: number;
  samples: EnvironmentStandInSample[];
  /** Whether the frame this report describes walked the placements at all. */
  walked: boolean;
  /** Filled at report time from the environment client, not by the renderer. */
  tiles?: EnvironmentTileLossCounts;
  /** Filled at report time from the splat, light and horizon clients. */
  retrying?: EnvironmentRetryCounts;
}

/**
 * One frame's environment stand-ins.
 *
 * Written from the admission loop for every admitted placement that is not its model, so it must
 * cost nothing on a warm frame and nearly nothing on a cold one: four counters, and a fixed pool of
 * sample records reused from frame to frame, keyed on the model path the placement already holds.
 */
export class EnvironmentStandInLedger {
  #pending = 0;
  #hull = 0;
  #missing = 0;
  #failed = 0;
  #canopy = 0;
  #walked = false;
  readonly #pool: EnvironmentStandInSample[] = [];
  #used = 0;
  readonly #index = new Map<string, number>();

  /** Starts a frame that walks the placements. */
  begin(): void {
    this.#clear();
    this.#walked = true;
  }

  /** Starts a frame that will not reach the placements. */
  idle(): void {
    this.#clear();
    this.#walked = false;
  }

  #clear(): void {
    this.#pending = 0;
    this.#hull = 0;
    this.#missing = 0;
    this.#failed = 0;
    this.#canopy = 0;
    this.#used = 0;
    if (this.#index.size > 0) this.#index.clear();
  }

  note(model: string, reason: EnvironmentStandInReason, canopy = false): void {
    if (reason === "pending") this.#pending++;
    else if (reason === "hull") this.#hull++;
    else if (reason === "missing") this.#missing++;
    else this.#failed++;
    if (canopy) this.#canopy++;
    const at = this.#index.get(model);
    if (at !== undefined) {
      const sample = this.#pool[at]!;
      sample.count++;
      // A path both waiting and written off in one frame is reported by the worse fact.
      if (sample.reason === "pending" && reason !== "pending") sample.reason = reason;
      return;
    }
    let slot = this.#used;
    if (slot >= STAND_IN_SAMPLE_LIMIT) {
      // Full. A cold frame's hundred models on their way must not hide the one that never comes:
      // a permanent reason takes the place of the last waiting one, and nothing else is dropped.
      if (reason === "pending") return;
      slot = -1;
      for (let index = this.#used - 1; index >= 0; index--) {
        if (this.#pool[index]!.reason === "pending") {
          slot = index;
          break;
        }
      }
      if (slot < 0) return;
      this.#index.delete(this.#pool[slot]!.model);
    } else {
      this.#used++;
    }
    const sample = this.#pool[slot];
    if (sample) {
      sample.model = model;
      sample.reason = reason;
      sample.count = 1;
    } else {
      this.#pool[slot] = { model, reason, count: 1 };
    }
    this.#index.set(model, slot);
  }

  report(): EnvironmentStandInReport {
    const samples: EnvironmentStandInSample[] = [];
    for (let index = 0; index < this.#used; index++) {
      const { model, reason, count } = this.#pool[index]!;
      samples.push({ model, reason, count });
    }
    // Permanent facts first: a model that will never come is the line worth reading.
    samples.sort((a, b) => Number(a.reason === "pending") - Number(b.reason === "pending"));
    return {
      total: this.#pending + this.#hull + this.#missing + this.#failed,
      byReason: { pending: this.#pending, hull: this.#hull, missing: this.#missing, failed: this.#failed },
      canopy: this.#canopy,
      samples,
      walked: this.#walked,
    };
  }
}

/** The sources the report adds at read time; structural, so this file stays free of the clients. */
export interface EnvironmentStandInSources {
  environment?: { tileLosses(): EnvironmentTileLossCounts } | undefined;
  splat?: { readonly retrying: number } | undefined;
  light?: { readonly retrying: number } | undefined;
  horizon?: { readonly retrying: number } | undefined;
}

/** The ledger's frame plus the tile losses (7.19) and retry waits (1.24) the clients hold now. */
export function environmentStandInsWith(
  report: EnvironmentStandInReport,
  sources: EnvironmentStandInSources,
): EnvironmentStandInReport {
  return {
    ...report,
    ...(sources.environment ? { tiles: sources.environment.tileLosses() } : {}),
    retrying: {
      splat: sources.splat?.retrying ?? 0,
      light: sources.light?.retrying ?? 0,
      horizon: sources.horizon?.retrying ?? 0,
    },
  };
}

/** Whether anything in the environment report is worth the error colour. */
export function environmentStandInsFault(report: EnvironmentStandInReport): boolean {
  const tiles = report.tiles;
  const retrying = report.retrying;
  return report.total > 0
    || (tiles !== undefined && tiles.rejected + tiles.truncated + tiles.generator > 0)
    || (retrying !== undefined && retrying.splat + retrying.light + retrying.horizon > 0);
}

/** The diagnostics line for the environment. */
export function environmentStandInSummary(report: EnvironmentStandInReport): string {
  const extras: string[] = [];
  const tiles = report.tiles;
  if (tiles) {
    const lost: string[] = [];
    if (tiles.rejected > 0) lost.push(`нечитаемых ${tiles.rejected}`);
    if (tiles.truncated > 0) lost.push(`сверх предела ${tiles.truncated}`);
    if (tiles.generator > 0) lost.push(`доодадов срезано генератором ${tiles.generator}`);
    if (lost.length > 0) extras.push(`плитки потеряли: ${lost.join(", ")}`);
  }
  const retrying = report.retrying;
  if (retrying) {
    const waits: string[] = [];
    if (retrying.splat > 0) waits.push(`земля ${retrying.splat}`);
    if (retrying.light > 0) waits.push(`свет ${retrying.light}`);
    if (retrying.horizon > 0) waits.push(`горизонт ${retrying.horizon}`);
    if (waits.length > 0) extras.push(`ждут повтора: ${waits.join(", ")}`);
  }
  const tail = extras.length > 0 ? ` · ${extras.join(" · ")}` : "";
  if (!report.walked) return `Окружение: кадр до размещений не дошёл${tail}.`;
  if (report.total === 0) return `Окружение: заглушек нет${tail}.`;
  const parts = ENVIRONMENT_STAND_IN_REASONS
    .filter((reason) => report.byReason[reason] > 0)
    .map((reason) => `${ENVIRONMENT_STAND_IN_REASON_LABELS[reason]} ${report.byReason[reason]}`);
  const canopy = report.canopy > 0 ? ` · из них кроной ${report.canopy}` : "";
  return `Окружение: заглушек ${report.total} · ${parts.join(" · ")}${canopy}${tail}`;
}

/** The unit report with the environment beside it, as `WorldRenderer3D.standInReport` returns it. */
export interface WorldStandInReport extends StandInReport {
  environment: EnvironmentStandInReport;
}
